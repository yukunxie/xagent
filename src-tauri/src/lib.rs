use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
