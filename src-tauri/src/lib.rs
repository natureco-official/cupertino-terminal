use serde_json::{json, Map, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{ipc::Channel, Manager, State};

struct StoreState {
    path: PathBuf,
    lock: Mutex<()>,
}

fn read_store(path: &Path) -> Map<String, Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn write_store(path: &Path, store: &Map<String, Value>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(store).map_err(|error| error.to_string())?;
    fs::write(&temp, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temp, path).map_err(|error| error.to_string())
}

fn get_value(state: &StoreState, key: &str, fallback: Value) -> Value {
    let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
    read_store(&state.path).remove(key).unwrap_or(fallback)
}

fn set_value(state: &StoreState, key: &str, value: Value) -> Result<(), String> {
    let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
    let mut store = read_store(&state.path);
    store.insert(key.to_owned(), value);
    write_store(&state.path, &store)
}

#[tauri::command]
fn get_settings(state: State<'_, StoreState>) -> Value {
    get_value(&state, "settings", json!({}))
}

#[tauri::command]
fn set_settings(settings: Value, state: State<'_, StoreState>) -> Result<(), String> {
    if !settings.is_object() {
        return Err("settings must be an object".into());
    }
    set_value(&state, "settings", settings)
}

#[tauri::command]
fn get_session(state: State<'_, StoreState>) -> Value {
    get_value(&state, "session", json!({}))
}

#[tauri::command]
fn set_session(session: Value, state: State<'_, StoreState>) -> Result<(), String> {
    if !session.is_object() {
        return Err("session must be an object".into());
    }
    set_value(&state, "session", session)
}

#[tauri::command]
fn list_history(state: State<'_, StoreState>) -> Value {
    get_value(&state, "commandHistory", json!([]))
}

#[tauri::command]
fn add_history(entry: Value, state: State<'_, StoreState>) -> Result<(), String> {
    let Some(command) = entry.get("command").and_then(Value::as_str) else {
        return Ok(());
    };
    let command = command.trim();
    if command.is_empty() {
        return Ok(());
    }

    let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
    let mut store = read_store(&state.path);
    let mut history = store
        .remove("commandHistory")
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let clean = json!({
        "command": command.chars().take(4096).collect::<String>(),
        "cwd": entry.get("cwd").cloned().unwrap_or(Value::Null),
        "exitCode": entry.get("exitCode").cloned().unwrap_or(Value::Null),
        "durationMs": entry.get("durationMs").cloned().unwrap_or(Value::Null),
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    });
    let duplicate = history.last().is_some_and(|last| {
        last.get("command") == clean.get("command") && last.get("cwd") == clean.get("cwd")
    });
    if duplicate {
        history.pop();
    }
    history.push(clean);
    if history.len() > 500 {
        history.drain(..history.len() - 500);
    }
    store.insert("commandHistory".into(), Value::Array(history));
    write_store(&state.path, &store)
}

#[tauri::command]
fn clear_history(state: State<'_, StoreState>) -> Result<(), String> {
    set_value(&state, "commandHistory", json!([]))
}

#[tauri::command]
fn get_caps() -> Value {
    json!({
        "acrylic": cfg!(target_os = "windows"),
        "platform": if cfg!(target_os = "windows") {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        },
        "version": env!("CARGO_PKG_VERSION"),
    })
}

#[tauri::command]
fn get_boot_context() -> Value {
    json!({ "cwd": Value::Null })
}

#[tauri::command]
fn list_shells() -> Value {
    if cfg!(target_os = "windows") {
        json!({
            "powershell": { "command": "powershell.exe", "args": [], "name": "PowerShell" },
            "pwsh": { "command": "pwsh.exe", "args": [], "name": "PowerShell 7" },
            "cmd": { "command": "cmd.exe", "args": [], "name": "Command Prompt" },
            "wsl": { "command": "wsl.exe", "args": [], "name": "WSL" }
        })
    } else {
        json!({
            "zsh": { "command": "zsh", "args": ["-l"], "name": "zsh" },
            "bash": { "command": "bash", "args": ["-l"], "name": "bash" },
            "fish": { "command": "fish", "args": ["-l"], "name": "fish" }
        })
    }
}

#[tauri::command]
fn create_pty(
    tab_id: String,
    profile_key: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_data: Channel<String>,
    on_exit: Channel<i32>,
) -> Option<Value> {
    let _ = (tab_id, profile_key, cols, rows, cwd, on_exit);
    let _ = on_data
        .send("\r\n\u{1b}[90mTauri preview: PTY support arrives in Rock 1.\u{1b}[0m\r\n".into());
    None
}

#[tauri::command]
fn relaunch_app(app: tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only HTTP(S) URLs are allowed".into());
    }
    #[cfg(target_os = "windows")]
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|error| error.to_string())?;
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&data_dir)?;
            app.manage(StoreState {
                path: data_dir.join("store.json"),
                lock: Mutex::new(()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            get_session,
            set_session,
            list_history,
            add_history,
            clear_history,
            get_caps,
            get_boot_context,
            list_shells,
            create_pty,
            relaunch_app,
            open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cupertino Terminal");
}
