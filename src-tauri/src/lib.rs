#[cfg_attr(test, allow(dead_code))]
mod account;
mod pty;
#[cfg_attr(test, allow(dead_code))]
mod zerolink;

#[cfg(not(test))]
pub use zerolink::{headless_connect, start_headless_host, HeadlessHost};

#[cfg(not(test))]
mod app {
    use super::{
        account::{AccountEmail, AccountError, AccountService, AccountStatus},
        pty::{self, PtyState},
        zerolink::{self, ZeroLinkState},
    };
    use percent_encoding::percent_decode_str;
    use serde_json::{json, Map, Value};
    use std::{
        env, fs,
        io::{self, Write},
        path::{Path, PathBuf},
        sync::Mutex,
        time::Duration,
    };
    use tauri::{Emitter, Manager, State};
    use tauri_plugin_deep_link::DeepLinkExt;
    use url::Url;

    struct StoreState {
        path: PathBuf,
        lock: Mutex<()>,
    }

    struct BootState {
        cwd: Mutex<Option<PathBuf>>,
        smoke_test: bool,
        performance_test: bool,
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
            "runtime": "tauri",
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
    fn get_boot_context(state: State<'_, BootState>) -> Value {
        let cwd = state
            .cwd
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned());
        json!({
            "cwd": cwd,
            "smokeTest": state.smoke_test,
            "performanceTest": state.performance_test
        })
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

    #[tauri::command]
    async fn nc_account_status(
        account: State<'_, AccountService>,
    ) -> Result<AccountStatus, AccountError> {
        Ok(account.status().await)
    }

    #[tauri::command]
    async fn nc_account_send_otp(
        email: String,
        account: State<'_, AccountService>,
    ) -> Result<Value, AccountError> {
        account.send_otp(email).await?;
        Ok(json!({ "ok": true }))
    }

    #[tauri::command]
    async fn nc_account_verify(
        email: String,
        value: String,
        account: State<'_, AccountService>,
    ) -> Result<AccountEmail, AccountError> {
        account.verify(email, value).await
    }

    #[tauri::command]
    async fn nc_account_password(
        email: String,
        password: String,
        account: State<'_, AccountService>,
    ) -> Result<AccountEmail, AccountError> {
        account.login_with_password(email, password).await
    }

    #[tauri::command]
    fn nc_account_logout(account: State<'_, AccountService>) -> Result<(), AccountError> {
        account.logout()
    }

    #[tauri::command]
    fn complete_smoke_test(result: Value, app: tauri::AppHandle) -> Result<(), String> {
        let xterm = result
            .get("xterm")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let tab_count = result
            .get("tabCount")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let terminal_count = result
            .get("terminalCount")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let live_count = result
            .get("liveCount")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let theme = result
            .get("theme")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let settings_loaded = result
            .get("settingsLoaded")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let palette_loaded = result
            .get("paletteLoaded")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !xterm
            || tab_count == 0
            || terminal_count == 0
            || live_count == 0
            || theme.is_empty()
            || !settings_loaded
            || !palette_loaded
        {
            let message = format!(
                "Tauri smoke test failed: xterm={xterm}, tabs={tab_count}, terminals={terminal_count}, live={live_count}, theme={theme:?}, settings={settings_loaded}, palette={palette_loaded}"
            );
            eprintln!("{message}");
            app.exit(1);
            return Err(message);
        }
        println!(
            "Tauri smoke test passed (xterm present, {tab_count} tab, {terminal_count} terminal, live PTY, theme {theme}, lazy settings + palette)"
        );
        app.exit(0);
        Ok(())
    }

    #[tauri::command]
    fn report_performance(
        kind: String,
        result: Value,
        state: State<'_, BootState>,
    ) -> Result<(), String> {
        if !state.performance_test {
            return Err("performance reporting is only available in benchmark mode".into());
        }
        let message = json!({ "kind": kind, "result": result });
        println!("TAURI_PERF {}", message);
        io::stdout().flush().map_err(|error| error.to_string())
    }

    fn canonical_directory(path: impl AsRef<Path>) -> Option<PathBuf> {
        fs::canonicalize(path).ok().filter(|path| path.is_dir())
    }

    fn directory_from_deep_link(value: &str) -> Option<PathBuf> {
        let url = Url::parse(value).ok()?;
        if !matches!(url.scheme(), "terminal" | "shell") {
            return None;
        }
        let decoded = percent_decode_str(url.path()).decode_utf8().ok()?;
        // `mut` is only needed on Windows, where a leading-slash drive path (/C:/...) is trimmed;
        // gate it per-platform so non-Windows targets don't warn about an unused `mut`.
        #[cfg(windows)]
        let mut path = decoded.into_owned();
        #[cfg(not(windows))]
        let path = decoded.into_owned();
        #[cfg(windows)]
        if path.starts_with('/') && path.as_bytes().get(2).is_some_and(|byte| *byte == b':') {
            path.remove(0);
        }
        canonical_directory(path)
    }

    fn directory_from_args(args: &[String], cwd: Option<&Path>) -> Option<PathBuf> {
        args.iter().skip(1).find_map(|argument| {
            if argument.starts_with('-') || argument.contains("://") {
                return None;
            }
            let path = PathBuf::from(argument);
            let path = if path.is_relative() {
                cwd.map_or(path.clone(), |cwd| cwd.join(path))
            } else {
                path
            };
            canonical_directory(path)
        })
    }

    fn directory_from_launch(args: &[String], cwd: Option<&Path>) -> Option<PathBuf> {
        args.iter()
            .find_map(|argument| directory_from_deep_link(argument))
            .or_else(|| directory_from_args(args, cwd))
    }

    fn deliver_directory(app: &tauri::AppHandle, directory: PathBuf) {
        if let Some(state) = app.try_state::<BootState>() {
            *state.cwd.lock().unwrap_or_else(|error| error.into_inner()) = Some(directory.clone());
        }
        let _ = app.emit_to(
            "main",
            "app:open-directory",
            directory.to_string_lossy().into_owned(),
        );
    }

    fn focus_main_window(app: &tauri::AppHandle) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    #[cfg(target_os = "macos")]
    fn application_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
        use tauri::menu::{
            Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
        };

        let settings = MenuItem::with_id(app, "show-settings", "Settings…", true, Some("Cmd+,"))?;
        let app_menu = Submenu::with_items(
            app,
            "Cupertino Terminal",
            true,
            &[
                &PredefinedMenuItem::about(app, None, None)?,
                &PredefinedMenuItem::separator(app)?,
                &settings,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        let new_tab = MenuItem::with_id(app, "new-tab", "New Tab", true, Some("Cmd+T"))?;
        let close_tab = MenuItem::with_id(app, "close-tab", "Close Tab", true, Some("Cmd+W"))?;
        let file_menu = Submenu::with_items(app, "File", true, &[&new_tab, &close_tab])?;
        let edit_menu = Submenu::with_items(
            app,
            "Edit",
            true,
            &[
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ],
        )?;
        let view_menu = Submenu::with_items(
            app,
            "View",
            true,
            &[&PredefinedMenuItem::fullscreen(app, None)?],
        )?;
        let window_menu = Submenu::with_id_and_items(
            app,
            WINDOW_SUBMENU_ID,
            "Window",
            true,
            &[
                &PredefinedMenuItem::minimize(app, None)?,
                &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
                &PredefinedMenuItem::close_window(app, Some("Close Window"))?,
            ],
        )?;
        let help_menu = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?;
        Menu::with_items(
            app,
            &[
                &app_menu,
                &file_menu,
                &edit_menu,
                &view_menu,
                &window_menu,
                &help_menu,
            ],
        )
    }

    pub fn run() {
        let smoke_test = env::args().any(|argument| argument == "--smoke-test");
        let performance_test = env::args().any(|argument| argument == "--performance-test");
        let initial_args: Vec<String> = env::args().collect();
        let initial_cwd = env::current_dir().ok();
        let launch_directory = directory_from_launch(&initial_args, initial_cwd.as_deref());

        #[allow(unused_mut)]
        let mut builder = tauri::Builder::default()
            .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
                if !args.iter().any(|argument| {
                    argument.starts_with("terminal://") || argument.starts_with("shell://")
                }) {
                    if let Some(directory) = directory_from_args(&args, Some(Path::new(&cwd))) {
                        deliver_directory(app, directory);
                    }
                }
                focus_main_window(app);
            }))
            .plugin(tauri_plugin_clipboard_manager::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_deep_link::init())
            .plugin(tauri_plugin_updater::Builder::new().build());
        #[cfg(target_os = "macos")]
        {
            builder = builder.menu(application_menu);
        }
        builder
            .on_menu_event(|app, event| {
                let name = match event.id().as_ref() {
                    "new-tab" => Some("app:new-tab"),
                    "close-tab" => Some("app:close-tab"),
                    "show-settings" => Some("app:show-settings"),
                    _ => None,
                };
                if let Some(name) = name {
                    let _ = app.emit_to("main", name, ());
                }
            })
            .setup(move |app| {
                let data_dir = app.path().app_data_dir()?;
                fs::create_dir_all(&data_dir)?;
                app.manage(StoreState {
                    path: data_dir.join("store.json"),
                    lock: Mutex::new(()),
                });
                app.manage(BootState {
                    cwd: Mutex::new(launch_directory),
                    smoke_test,
                    performance_test,
                });
                app.manage(AccountService::from_environment());
                app.manage(ZeroLinkState::default());
                let pty_state = PtyState::new(data_dir);
                if let Some(window) = app.get_webview_window("main") {
                    if smoke_test || performance_test {
                        let _ = window.hide();
                    }
                    let close_state = pty_state.clone();
                    window.on_window_event(move |event| {
                        if matches!(event, tauri::WindowEvent::Destroyed) {
                            close_state.shutdown_all();
                        }
                    });
                }
                app.manage(pty_state);

                let deep_link_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if let Some(directory) = directory_from_deep_link(url.as_str()) {
                            deliver_directory(&deep_link_handle, directory);
                            break;
                        }
                    }
                    focus_main_window(&deep_link_handle);
                });
                if let Some(urls) = app.deep_link().get_current()? {
                    for url in urls {
                        if let Some(directory) = directory_from_deep_link(url.as_str()) {
                            deliver_directory(app.handle(), directory);
                            break;
                        }
                    }
                }
                #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
                app.deep_link().register_all()?;

                if smoke_test || performance_test {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(20));
                        eprintln!(
                            "Tauri smoke test failed: renderer did not report within 20 seconds"
                        );
                        handle.exit(1);
                    });
                }
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
                pty::create_pty,
                pty::pty_write,
                pty::pty_resize,
                pty::pty_kill,
                pty::pty_ack,
                relaunch_app,
                open_external,
                nc_account_status,
                nc_account_send_otp,
                nc_account_verify,
                nc_account_password,
                nc_account_logout,
                complete_smoke_test,
                report_performance,
                zerolink::zl_host_start,
                zerolink::zl_host_stop,
                zerolink::zl_client_connect,
                zerolink::zl_client_send,
                zerolink::zl_client_resize,
                zerolink::zl_client_push_file,
                zerolink::zl_client_pull_file,
                zerolink::zl_client_forward_add,
                zerolink::zl_client_forward_remove,
                zerolink::zl_client_disconnect,
            ])
            .run(tauri::generate_context!())
            .expect("error while running Cupertino Terminal");
    }
}

#[cfg(not(test))]
pub use app::run;
