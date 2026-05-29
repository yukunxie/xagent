use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use uuid::Uuid;

// Safety: portable-pty's MasterPty on Windows wraps a ConPTY HANDLE,
// which is a kernel object safe to reference from any thread.
struct PtyMaster(Box<dyn MasterPty>);
unsafe impl Send for PtyMaster {}
unsafe impl Sync for PtyMaster {}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub status: String,
    pub created_at: u64,
}

pub(crate) struct SessionData {
    pub(crate) info: SessionInfo,
    pub(crate) writer: Box<dyn Write + Send>,
    pub(crate) master: Arc<Mutex<PtyMaster>>, // keep-alive + resize
}

pub struct AppState {
    pub(crate) sessions: Mutex<HashMap<String, SessionData>>,
}

#[derive(Serialize, Clone)]
struct PtyDataEvent {
    session_id: String,
    data: String, // base64-encoded bytes
}

#[derive(Serialize, Clone)]
struct PtyExitEvent {
    session_id: String,
    exit_code: Option<i32>,
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn list_sessions(state: State<AppState>) -> Vec<SessionInfo> {
    state
        .sessions
        .lock()
        .unwrap()
        .values()
        .map(|s| s.info.clone())
        .collect()
}

#[tauri::command]
fn start_session(
    app: AppHandle,
    state: State<AppState>,
    command: String,
    args: Vec<String>,
    cwd: String,
    rows: u16,
    cols: u16,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&command);
    for arg in &args {
        cmd.arg(arg);
    }
    if !cwd.is_empty() {
        cmd.cwd(&cwd);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Wrap master in Arc so both SessionData and reader thread share it
    let master_arc = Arc::new(Mutex::new(PtyMaster(pair.master)));
    let master_keep = Arc::clone(&master_arc);

    let sid = session_id.clone();
    let app_reader = app.clone();

    std::thread::spawn(move || {
        let _master_keep = master_keep; // keep ConPTY alive for the session lifetime
        let mut reader = reader;
        let mut child = child;
        let mut buf = [0u8; 4096];

        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    app_reader
                        .emit("pty_data", PtyDataEvent {
                            session_id: sid.clone(),
                            data,
                        })
                        .ok();
                }
            }
        }

        let exit_code = child.wait().ok().map(|s| s.exit_code() as i32);

        if let Ok(mut sessions) = app_reader.state::<AppState>().sessions.lock() {
            if let Some(session) = sessions.get_mut(&sid) {
                session.info.status = "exited".to_string();
            }
        }

        app_reader
            .emit("pty_exit", PtyExitEvent { session_id: sid, exit_code })
            .ok();
    });

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        SessionData {
            info: SessionInfo {
                id: session_id.clone(),
                command,
                cwd,
                status: "running".to_string(),
                created_at: now,
            },
            writer,
            master: master_arc,
        },
    );

    Ok(session_id)
}

#[tauri::command]
fn resize_session(
    state: State<AppState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let master_arc = {
        let sessions = state.sessions.lock().unwrap();
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session {} not found", session_id))?;
        Arc::clone(&session.master)
    };
    // Guard must be in a named variable so it's dropped before master_arc
    let guard = master_arc.lock().unwrap();
    guard
        .0
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn write_to_session(
    state: State<AppState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    match sessions.get_mut(&session_id) {
        Some(s) => {
            s.writer.write_all(&data).map_err(|e| e.to_string())?;
            s.writer.flush().map_err(|e| e.to_string())?;
            Ok(())
        }
        None => Err(format!("Session {} not found", session_id)),
    }
}

#[tauri::command]
fn kill_session(state: State<AppState>, session_id: String) {
    state.sessions.lock().unwrap().remove(&session_id);
}

// ─── WebSocket server (remote access) ────────────────────────────────────────

async fn handle_ws_client(stream: tokio::net::TcpStream) {
    let ws = match accept_async(stream).await {
        Ok(w) => w,
        Err(_) => return,
    };
    let (mut sink, mut source) = ws.split();

    // Wait for the init message
    let init: serde_json::Value = loop {
        match source.next().await {
            Some(Ok(Message::Text(text))) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    if v["type"] == "init" { break v; }
                }
            }
            _ => return,
        }
    };

    let command = init["command"].as_str().unwrap_or("pwsh").to_string();
    let cwd     = init["cwd"].as_str().unwrap_or("").to_string();
    let rows    = init["rows"].as_u64().unwrap_or(24) as u16;
    let cols    = init["cols"].as_u64().unwrap_or(80) as u16;
    let args: Vec<String> = init["args"].as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }) {
        Ok(p) => p,
        Err(e) => {
            let _ = sink.send(Message::Text(
                serde_json::json!({"type":"error","message":e.to_string()}).to_string()
            )).await;
            return;
        }
    };

    let mut cmd = CommandBuilder::new(&command);
    for arg in &args { cmd.arg(arg); }
    if !cwd.is_empty() { cmd.cwd(&cwd); }

    let _child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            let _ = sink.send(Message::Text(
                serde_json::json!({"type":"error","message":e.to_string()}).to_string()
            )).await;
            return;
        }
    };
    drop(pair.slave);

    let master_arc = Arc::new(Mutex::new(PtyMaster(pair.master)));
    let master_resize = Arc::clone(&master_arc);
    let mut writer = master_arc.lock().unwrap().0.take_writer().unwrap();
    let mut reader = master_arc.lock().unwrap().0.try_clone_reader().unwrap();

    // PTY reader thread → async channel → WS sink
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(256);
    std::thread::spawn(move || {
        let _keep = master_arc; // keep ConPTY alive
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = tx.blocking_send(serde_json::json!({"type":"exit"}).to_string());
                    break;
                }
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = tx.blocking_send(
                        serde_json::json!({"type":"output","data":data}).to_string()
                    );
                }
            }
        }
    });

    // Forward PTY output to WS client
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(Message::Text(msg)).await.is_err() { break; }
        }
    });

    // Handle incoming WS messages → PTY
    while let Some(Ok(Message::Text(text))) = source.next().await {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        match msg["type"].as_str() {
            Some("input") => {
                if let Some(data) = msg["data"].as_str() {
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
                        let _ = writer.write_all(&bytes);
                        let _ = writer.flush();
                    }
                }
            }
            Some("resize") => {
                let r = msg["rows"].as_u64().unwrap_or(24) as u16;
                let c = msg["cols"].as_u64().unwrap_or(80) as u16;
                let _ = master_resize.lock().unwrap().0.resize(
                    PtySize { rows: r, cols: c, pixel_width: 0, pixel_height: 0 }
                );
            }
            _ => {}
        }
    }
    // WS connection closed — PTY resources drop automatically
}

fn start_ws_server(port: u16) {
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await {
            Ok(l) => l,
            Err(e) => { eprintln!("[xagent ws] bind error on port {port}: {e}"); return; }
        };
        println!("[xagent ws] server listening on port {port}");
        loop {
            match listener.accept().await {
                Ok((stream, addr)) => {
                    println!("[xagent ws] connection from {addr}");
                    tauri::async_runtime::spawn(handle_ws_client(stream));
                }
                Err(e) => eprintln!("[xagent ws] accept error: {e}"),
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            start_ws_server(9999);
            Ok(())
        })
        .manage(AppState {
            sessions: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            start_session,
            resize_session,
            write_to_session,
            kill_session,
            exit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
