use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use uuid::Uuid;

// ─── PTY wrapper ──────────────────────────────────────────────────────────────

// Safety: portable-pty's MasterPty on Windows wraps a ConPTY HANDLE,
// which is a kernel object safe to reference from any thread.
struct PtyMaster(Box<dyn MasterPty>);
unsafe impl Send for PtyMaster {}
unsafe impl Sync for PtyMaster {}

// ─── Append-only output history buffer (max 50 MB) ───────────────────────────

pub(crate) struct OutputBuffer {
    data:        Vec<u8>,
    base_offset: u64,  // absolute byte offset of data[0]
}

impl OutputBuffer {
    fn new() -> Self { Self { data: Vec::new(), base_offset: 0 } }

    fn total_written(&self) -> u64 { self.base_offset + self.data.len() as u64 }

    fn push(&mut self, bytes: &[u8]) {
        self.data.extend_from_slice(bytes);
        const MAX: usize = 50 * 1024 * 1024;
        if self.data.len() > MAX {
            let trim = self.data.len() - MAX;
            self.data.drain(..trim);
            self.base_offset += trim as u64;
        }
    }

    /// Bytes starting from an absolute byte offset (delta / reconnect).
    fn slice_from(&self, abs_offset: u64) -> &[u8] {
        let start = abs_offset.saturating_sub(self.base_offset) as usize;
        if start >= self.data.len() { &[] } else { &self.data[start..] }
    }

    /// Last `n` bytes (for history-size preference).
    fn last_n_bytes(&self, n: usize) -> &[u8] {
        if n >= self.data.len() { &self.data } else { &self.data[self.data.len() - n..] }
    }
}

// ─── Unified Session (local PTY + WS-attached) ───────────────────────────────

pub(crate) struct Session {
    pub id:           String,
    pub command:      String,
    pub cwd:          String,
    pub created_at:   u64,
    pub is_local:     bool,
    pub running:      Arc<AtomicBool>,
    pub client_count: Arc<AtomicU32>,                  // number of remote WS clients attached
    pub pty_size:     Arc<Mutex<(u16, u16)>>,          // current PTY (rows, cols) — authoritative for local sessions
    pub output_tx:    broadcast::Sender<String>,       // PTY output → all WS subscribers
    pub input_tx:     mpsc::UnboundedSender<Vec<u8>>,  // input → PTY writer task
    pub master:       Arc<Mutex<Option<PtyMaster>>>,   // for resize + kill
    pub output_buf:   Arc<Mutex<OutputBuffer>>,        // rolling PTY history (50 MB cap)
}

pub(crate) type Registry = Arc<Mutex<HashMap<String, Session>>>;

pub struct AppState {
    pub(crate) registry: Registry,
}

// ─── Serialisable session info (Tauri commands + WS welcome) ─────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id:           String,
    pub command:      String,
    pub cwd:          String,
    pub status:       String,
    pub created_at:   u64,
    pub is_local:     bool,
    pub buffer_bytes: u64,   // total PTY bytes written (for client history-size prompt)
    pub client_count: u32,   // number of remote clients currently attached
}

#[derive(Serialize, Clone)]
struct PtyDataEvent { session_id: String, data: String }

#[derive(Serialize, Clone)]
struct PtyExitEvent { session_id: String, exit_code: Option<i32> }

#[derive(Serialize, Clone)]
struct RemoteClientEvent { session_id: String, count: u32 }

// ─── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn exit_app(app: AppHandle) { app.exit(0); }

#[tauri::command]
fn list_sessions(state: State<AppState>) -> Vec<SessionInfo> {
    state.registry.lock().unwrap()
        .values()
        .filter(|s| s.is_local)
        .map(session_to_info)
        .collect()
}

#[tauri::command]
fn start_session(
    app:     AppHandle,
    state:   State<AppState>,
    command: String,
    args:    Vec<String>,
    cwd:     String,
    rows:    u16,
    cols:    u16,
) -> Result<String, String> {
    create_session(app, state.registry.clone(), command, args, cwd, rows, cols, true)
}

#[tauri::command]
fn resize_session(
    state:      State<AppState>,
    session_id: String,
    rows:       u16,
    cols:       u16,
) -> Result<(), String> {
    let (master_arc, size_arc, output_tx) = {
        let reg = state.registry.lock().unwrap();
        let s = reg.get(&session_id)
            .ok_or_else(|| format!("Session {} not found", session_id))?;
        (Arc::clone(&s.master), Arc::clone(&s.pty_size), s.output_tx.clone())
    };
    let lock = master_arc.lock().unwrap();
    if let Some(m) = lock.as_ref() {
        m.0.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    // Keep stored size in sync so remote clients can be told the correct dimensions
    *size_arc.lock().unwrap() = (rows, cols);
    // Notify all connected remote WS clients so they resize their own xterm to match.
    // Without this, clients retain the old size and new PTY output garbles their display.
    let _ = output_tx.send(
        serde_json::json!({"type":"terminal_size","rows":rows,"cols":cols}).to_string()
    );
    Ok(())
}

#[tauri::command]
fn write_to_session(
    state:      State<AppState>,
    session_id: String,
    data:       Vec<u8>,
) -> Result<(), String> {
    let reg = state.registry.lock().unwrap();
    let s = reg.get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;
    s.input_tx.send(data).map_err(|e| e.to_string())
}

#[tauri::command]
fn kill_session(state: State<AppState>, session_id: String) {
    if let Some(session) = state.registry.lock().unwrap().remove(&session_id) {
        // Drop the PtyMaster → ConPTY closes → child process exits → reader thread ends
        if let Ok(mut m) = session.master.lock() { *m = None; }
    }
}

// Stubs — TODO: implement remote lock overlay (low priority)
#[tauri::command]
fn disconnect_remote(_state: State<AppState>, _session_id: String) {}

#[tauri::command]
fn pause_remote_input(_state: State<AppState>, _session_id: String) {}

#[tauri::command]
fn resume_remote_input(_state: State<AppState>, _session_id: String) {}

// ─── Session creation helper ──────────────────────────────────────────────────

fn session_to_info(s: &Session) -> SessionInfo {
    SessionInfo {
        id:           s.id.clone(),
        command:      s.command.clone(),
        cwd:          s.cwd.clone(),
        status:       if s.running.load(Ordering::Relaxed) { "running" } else { "exited" }.to_string(),
        created_at:   s.created_at,
        is_local:     s.is_local,
        buffer_bytes: s.output_buf.lock().unwrap().total_written(),
        client_count: s.client_count.load(Ordering::Relaxed),
    }
}

fn create_session(
    app:      AppHandle,
    registry: Registry,
    command:  String,
    args:     Vec<String>,
    cwd:      String,
    rows:     u16,
    cols:     u16,
    is_local: bool,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&command);
    for arg in &args { cmd.arg(arg); }
    if !cwd.is_empty() { cmd.cwd(&cwd); }

    let child  = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let master = Arc::new(Mutex::new(Some(PtyMaster(pair.master))));

    let (output_tx, _) = broadcast::channel::<String>(512);
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let running       = Arc::new(AtomicBool::new(true));
    let client_count  = Arc::new(AtomicU32::new(0));
    let pty_size      = Arc::new(Mutex::new((rows, cols)));
    let output_buf    = Arc::new(Mutex::new(OutputBuffer::new()));

    // — Reader thread: PTY bytes → output_buf + broadcast + Tauri events —
    let sid          = session_id.clone();
    let out_tx       = output_tx.clone();
    let running_upd  = Arc::clone(&running);
    let master_keep  = Arc::clone(&master);
    let app_reader   = app.clone();
    let buf_writer   = Arc::clone(&output_buf);

    std::thread::spawn(move || {
        let _keep = master_keep; // keeps ConPTY alive until thread exits
        let mut reader = reader;
        let mut child  = child;
        let mut buf    = [0u8; 4096];

        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // Append to history buffer first
                    buf_writer.lock().unwrap().push(&buf[..n]);
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = out_tx.send(serde_json::json!({"type":"output","data":data}).to_string());
                    if is_local {
                        app_reader.emit("pty_data", PtyDataEvent {
                            session_id: sid.clone(), data,
                        }).ok();
                    }
                }
            }
        }

        let exit_code = child.wait().ok().map(|s| s.exit_code() as i32);
        let _ = out_tx.send(serde_json::json!({"type":"exit"}).to_string());
        running_upd.store(false, Ordering::Relaxed);
        app_reader.emit("pty_exit", PtyExitEvent { session_id: sid, exit_code }).ok();
    });

    // — Writer task: input channel → PTY writer —
    let mut writer = writer;
    tauri::async_runtime::spawn(async move {
        while let Some(bytes) = input_rx.recv().await {
            if writer.write_all(&bytes).is_err() { break; }
            let _ = writer.flush();
        }
    });

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();

    registry.lock().unwrap().insert(session_id.clone(), Session {
        id: session_id.clone(), command, cwd,
        created_at: now, is_local, running, client_count, pty_size,
        output_tx, input_tx, master, output_buf,
    });

    Ok(session_id)
}

// ─── WebSocket server ─────────────────────────────────────────────────────────

async fn handle_ws_client(
    stream:   tokio::net::TcpStream,
    registry: Registry,
    app:      AppHandle,
) {
    let ws = match accept_async(stream).await {
        Ok(w) => w,
        Err(_) => return,
    };
    let (mut sink, mut source) = ws.split();

    // Send welcome with all registered sessions (includes buffer_bytes for history-size prompting)
    let sessions_json: Vec<serde_json::Value> = registry.lock().unwrap().values()
        .map(|s| serde_json::json!({
            "id":           s.id,
            "command":      s.command,
            "cwd":          s.cwd,
            "created_at":   s.created_at,
            "is_local":     s.is_local,
            "status":       if s.running.load(Ordering::Relaxed) { "running" } else { "exited" },
            "buffer_bytes": s.output_buf.lock().unwrap().total_written(),
        }))
        .collect();

    if sink.send(Message::Text(
        serde_json::json!({"type":"welcome","sessions":sessions_json}).to_string()
    )).await.is_err() { return; }

    // Wait for "init" (new PTY) or "attach" (existing session)
    let first_msg: serde_json::Value = loop {
        match source.next().await {
            Some(Ok(Message::Text(text))) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    match v["type"].as_str() {
                        Some("init") | Some("attach") => break v,
                        _ => {}
                    }
                }
            }
            _ => return,
        }
    };

    let rows = first_msg["rows"].as_u64().unwrap_or(24) as u16;
    let cols = first_msg["cols"].as_u64().unwrap_or(80) as u16;

    // Resolve output channel, input channel, master handle, and history bytes to replay
    let (output_rx, input_tx, master_arc, history_bytes, attached_session_id, client_count_arc,
         pty_size_arc, session_is_local): (
        broadcast::Receiver<String>,
        mpsc::UnboundedSender<Vec<u8>>,
        Arc<Mutex<Option<PtyMaster>>>,
        Vec<u8>,
        String,
        Arc<AtomicU32>,
        Arc<Mutex<(u16, u16)>>,
        bool,
    ) = match first_msg["type"].as_str() {
        Some("init") => {
            let command = first_msg["command"].as_str().unwrap_or("pwsh").to_string();
            let cwd     = first_msg["cwd"].as_str().unwrap_or("").to_string();
            let args: Vec<String> = first_msg["args"].as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let sid = match create_session(
                app.clone(), registry.clone(), command, args, cwd, rows, cols, false
            ) {
                Ok(id) => id,
                Err(e) => {
                    let _ = sink.send(Message::Text(
                        serde_json::json!({"type":"error","message":e}).to_string()
                    )).await;
                    return;
                }
            };
            let reg = registry.lock().unwrap();
            let s   = reg.get(&sid).unwrap();
            (s.output_tx.subscribe(), s.input_tx.clone(), Arc::clone(&s.master), Vec::new(),
             sid, Arc::clone(&s.client_count), Arc::clone(&s.pty_size), false)
        }
        Some("attach") => {
            let sid     = first_msg["session_id"].as_str().unwrap_or("").to_string();
            // offset > 0 → delta sync (client reconnected); 0 → use history preference
            let offset  = first_msg["offset"].as_u64().unwrap_or(0);
            let history = first_msg["history"].as_str().unwrap_or("1M").to_string();

            let quad = {
                let reg = registry.lock().unwrap();
                reg.get(&sid).map(|s| (
                    s.output_tx.subscribe(), // subscribe FIRST — no gap with buffer snapshot
                    s.input_tx.clone(),
                    Arc::clone(&s.master),
                    Arc::clone(&s.output_buf),
                    Arc::clone(&s.client_count),
                    Arc::clone(&s.pty_size),
                    s.is_local,
                ))
            };
            match quad {
                Some((output_rx, input_tx, master_arc, buf_arc, client_count_arc,
                      pty_size_arc, is_local)) => {
                    // ── DO NOT resize PTY here ──────────────────────────────────────
                    // For local sessions the local xterm is the authoritative size owner.
                    // Resizing to the remote client's dimensions would garble the local
                    // display. We'll instead tell the client the current PTY size after
                    // history replay so it can adapt its own xterm.

                    // Snapshot the history slice outside the registry lock
                    let history_bytes: Vec<u8> = {
                        let buf = buf_arc.lock().unwrap();
                        if offset > 0 {
                            // Delta: send only bytes client hasn't seen yet
                            buf.slice_from(offset).to_vec()
                        } else {
                            match history.as_str() {
                                "all"  => buf.slice_from(0).to_vec(),
                                "10M"  => buf.last_n_bytes(10 * 1024 * 1024).to_vec(),
                                "5M"   => buf.last_n_bytes(5  * 1024 * 1024).to_vec(),
                                "none" => Vec::new(),
                                _      => buf.last_n_bytes(1  * 1024 * 1024).to_vec(), // "1M" default
                            }
                        }
                    };
                    (output_rx, input_tx, master_arc, history_bytes, sid, client_count_arc,
                     pty_size_arc, is_local)
                }
                None => {
                    let _ = sink.send(Message::Text(
                        serde_json::json!({"type":"error","message":"session not found"}).to_string()
                    )).await;
                    return;
                }
            }
        }
        _ => return,
    };

    // ── Step 1: Tell the client the ACTUAL PTY size BEFORE sending history ───
    // The client's xterm must be resized to the server's PTY dimensions first.
    // If we send history first, xterm renders the content at the wrong width
    // (client's own size) and TUI apps like opencode get garbled layouts.
    {
        let (pty_rows, pty_cols) = *pty_size_arc.lock().unwrap();
        if sink.send(Message::Text(
            serde_json::json!({"type":"terminal_size","rows":pty_rows,"cols":pty_cols}).to_string()
        )).await.is_err() { return; }
    }
    // Small yield so the client has a chance to process the resize before the
    // first history chunk arrives over the same TCP stream.
    tokio::task::yield_now().await;

    // ── Step 2: Stream history in 32 KB chunks ────────────────────────────────
    let total_history = history_bytes.len() as u64;
    for chunk in history_bytes.chunks(32 * 1024) {
        let data = base64::engine::general_purpose::STANDARD.encode(chunk);
        if sink.send(Message::Text(
            serde_json::json!({"type":"output","data":data}).to_string()
        )).await.is_err() { return; }
        tokio::task::yield_now().await;
    }
    // Notify client that history replay is complete
    if sink.send(Message::Text(
        serde_json::json!({"type":"history_done","total_bytes":total_history}).to_string()
    )).await.is_err() { return; }

    // Notify local UI that a remote client connected
    let count = client_count_arc.fetch_add(1, Ordering::Relaxed) + 1;
    app.emit("remote_client_change", RemoteClientEvent {
        session_id: attached_session_id.clone(), count,
    }).ok();

    // Forward real-time PTY output → WS client (forward task owns sink)
    let forward = tauri::async_runtime::spawn(async move {
        let mut rx   = output_rx;
        let mut sink = sink;
        loop {
            match rx.recv().await {
                Ok(msg)                                      => { if sink.send(Message::Text(msg)).await.is_err() { break; } }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed)    => break,
            }
        }
    });

    // Handle incoming WS messages: input + resize
    while let Some(Ok(Message::Text(text))) = source.next().await {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        match v["type"].as_str() {
            Some("input") => {
                if let Some(data) = v["data"].as_str() {
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
                        let _ = input_tx.send(bytes);
                    }
                }
            }
            Some("resize") => {
                // For local sessions, the local xterm owns the PTY size — ignore remote resize
                // requests so the web/mobile client can never garble the local display.
                // For web-initiated sessions (is_local=false) the client is the only viewer,
                // so remote resize is fine.
                if !session_is_local {
                    let r = v["rows"].as_u64().unwrap_or(24) as u16;
                    let c = v["cols"].as_u64().unwrap_or(80) as u16;
                    if let Ok(lock) = master_arc.lock() {
                        if let Some(m) = lock.as_ref() {
                            let _ = m.0.resize(PtySize { rows: r, cols: c, pixel_width: 0, pixel_height: 0 });
                        }
                    }
                    *pty_size_arc.lock().unwrap() = (r, c);
                }
            }
            _ => {}
        }
    }

    forward.abort();

    // Notify local UI that the remote client disconnected
    let prev = client_count_arc.fetch_sub(1, Ordering::Relaxed);
    let count = if prev == 0 { 0 } else { prev - 1 };
    app.emit("remote_client_change", RemoteClientEvent {
        session_id: attached_session_id, count,
    }).ok();
}

fn start_ws_server(registry: Registry, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Try ports 10337–10436 and bind the first available one
        let mut listener: Option<tokio::net::TcpListener> = None;
        for port in 10337u16..10437 {
            match tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await {
                Ok(l) => {
                    println!("[xagent ws] listening on port {port}");
                    listener = Some(l);
                    break;
                }
                Err(_) => continue,
            }
        }
        let listener = match listener {
            Some(l) => l,
            None => { eprintln!("[xagent ws] no available port in range 10337–10436"); return; }
        };
        loop {
            match listener.accept().await {
                Ok((stream, addr)) => {
                    println!("[xagent ws] connection from {addr}");
                    let reg = registry.clone();
                    let app = app.clone();
                    tauri::async_runtime::spawn(handle_ws_client(stream, reg, app));
                }
                Err(e) => eprintln!("[xagent ws] accept error: {e}"),
            }
        }
    });
}

// ─── opencode-bridge auto-start ───────────────────────────────────────────────

fn start_bridge(app_dir: &std::path::Path) {
    // Walk up from app_dir looking for opencode-bridge/src/index.ts
    let mut dir = Some(app_dir.to_path_buf());
    let mut bridge_script: Option<std::path::PathBuf> = None;
    for _ in 0..4 {
        if let Some(ref d) = dir {
            let candidate = d.join("opencode-bridge").join("src").join("index.ts");
            if candidate.exists() {
                bridge_script = Some(candidate);
                break;
            }
            dir = d.parent().map(|p| p.to_path_buf());
        }
    }

    let Some(bridge_path) = bridge_script else {
        eprintln!("[bridge] opencode-bridge/src/index.ts not found — skipping auto-start");
        return;
    };

    // bridge_dir = the opencode-bridge directory (parent of src/)
    let bridge_dir = bridge_path
        .parent().and_then(|p: &std::path::Path| p.parent())
        .map(|p: &std::path::Path| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    println!("[bridge] starting bridge from {}", bridge_dir.display());

    let result = std::process::Command::new("node")
        .args([
            "--experimental-strip-types",
            bridge_path.to_str().unwrap_or(""),
            "--port", "9001",
            "--dir", bridge_dir.to_str().unwrap_or("."),
        ])
        .current_dir(&bridge_dir)
        .spawn();

    match result {
        Ok(child) => println!("[bridge] started with PID {}", child.id()),
        Err(e)    => eprintln!("[bridge] failed to start: {e}"),
    }
}

// ─────────────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let registry: Registry = Arc::new(Mutex::new(HashMap::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { registry: Arc::clone(&registry) })
        .setup(move |app| {
            // Auto-start opencode-bridge on port 9001
            if let Ok(res_dir) = app.path().resource_dir() {
                start_bridge(&res_dir);
            } else {
                // Fallback: use exe directory
                if let Ok(exe) = std::env::current_exe() {
                    if let Some(exe_dir) = exe.parent() {
                        start_bridge(exe_dir);
                    }
                }
            }
            start_ws_server(registry, app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            start_session,
            resize_session,
            write_to_session,
            kill_session,
            exit_app,
            disconnect_remote,
            pause_remote_input,
            resume_remote_input,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
