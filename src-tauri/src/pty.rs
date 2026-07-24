use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
        Arc, Condvar, Mutex, Weak,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
#[cfg(not(test))]
use tauri::{
    ipc::{Channel, Response},
    State,
};

const READ_CHUNK_BYTES: usize = 4 * 1024;
const READ_QUEUE_CHUNKS: usize = 8;
const BATCH_BYTES: usize = 16 * 1024;
const BATCH_DELAY: Duration = Duration::from_millis(4);
const MAX_IN_FLIGHT_MESSAGES: usize = 8;
const MAX_IN_FLIGHT_BYTES: usize = MAX_IN_FLIGHT_MESSAGES * BATCH_BYTES;
#[cfg_attr(test, allow(dead_code))]
const MAX_WRITE_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
pub struct PtyState {
    registry: Arc<PtyRegistry>,
    #[cfg_attr(test, allow(dead_code))]
    app_data_dir: Arc<PathBuf>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self::new(env::temp_dir().join("cupertino-terminal-test"))
    }
}

#[derive(Default)]
struct PtyRegistry {
    ptys: Mutex<HashMap<String, Arc<PtyHandle>>>,
}

struct PtyHandle {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    reader_thread: Mutex<Option<JoinHandle<()>>>,
    delivery_thread: Mutex<Option<JoinHandle<()>>>,
    waiter_thread: Mutex<Option<JoinHandle<()>>>,
    flow: Arc<FlowControl>,
    shutdown: AtomicBool,
    io_stopped: AtomicBool,
    exited: AtomicBool,
    #[cfg(unix)]
    process_group: Option<libc::pid_t>,
}

pub(crate) trait OutputSink: Send + Sync {
    fn send(&self, bytes: Vec<u8>) -> Result<(), ()>;

    fn auto_acknowledge(&self) -> bool {
        false
    }
}

pub(crate) trait ExitSink: Send + Sync {
    fn send(&self, code: i32);
}

#[cfg(not(test))]
impl OutputSink for Channel<Response> {
    fn send(&self, bytes: Vec<u8>) -> Result<(), ()> {
        Channel::send(self, Response::new(bytes)).map_err(|_| ())
    }
}

#[cfg(not(test))]
impl ExitSink for Channel<i32> {
    fn send(&self, code: i32) {
        let _ = Channel::send(self, code);
    }
}

#[derive(Default)]
struct FlowState {
    pending: VecDeque<usize>,
    bytes: usize,
    stopped: bool,
    #[cfg(test)]
    max_messages: usize,
    #[cfg(test)]
    max_bytes: usize,
}

#[derive(Default)]
struct FlowControl {
    state: Mutex<FlowState>,
    changed: Condvar,
}

#[derive(Clone)]
struct ShellLaunch {
    command: &'static str,
    args: Vec<String>,
    name: &'static str,
    cwd: PathBuf,
    env: Vec<(String, String)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pub(crate) pid: Option<u32>,
    shell_name: &'static str,
    cwd: String,
}

impl FlowControl {
    fn reserve(&self, bytes: usize) -> bool {
        let mut state = lock(&self.state);
        while !state.stopped
            && (state.pending.len() >= MAX_IN_FLIGHT_MESSAGES
                || state.bytes.saturating_add(bytes) > MAX_IN_FLIGHT_BYTES)
        {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
        if state.stopped {
            return false;
        }
        state.pending.push_back(bytes);
        state.bytes += bytes;
        #[cfg(test)]
        {
            state.max_messages = state.max_messages.max(state.pending.len());
            state.max_bytes = state.max_bytes.max(state.bytes);
        }
        true
    }

    fn acknowledge(&self) {
        let mut state = lock(&self.state);
        if let Some(bytes) = state.pending.pop_front() {
            state.bytes = state.bytes.saturating_sub(bytes);
            self.changed.notify_all();
        }
    }

    fn stop(&self) {
        let mut state = lock(&self.state);
        state.stopped = true;
        state.pending.clear();
        state.bytes = 0;
        self.changed.notify_all();
    }

    #[cfg(test)]
    fn high_water(&self) -> (usize, usize) {
        let state = lock(&self.state);
        (state.max_messages, state.max_bytes)
    }
}

impl PtyHandle {
    fn kill_child(&self) -> Result<(), String> {
        let mut killer = lock(&self.killer);
        if let Some(killer) = killer.as_mut() {
            match killer.kill() {
                Ok(()) => Ok(()),
                Err(error) if kill_error_is_gone(&error) => Ok(()),
                Err(error) => Err(format!("failed to kill PTY child: {error}")),
            }
        } else {
            Ok(())
        }
    }

    fn stop_io(&self) {
        if self.io_stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        self.stop_io_claimed();
    }

    fn stop_io_claimed(&self) {
        self.shutdown.store(true, Ordering::Release);
        self.flow.stop();
        lock(&self.writer).take();
        lock(&self.master).take();
        join_named(&self.delivery_thread);
        join_named(&self.reader_thread);
    }

    fn finish_io(&self) {
        if self.io_stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        lock(&self.writer).take();
        lock(&self.master).take();
        join_named(&self.reader_thread);
        join_named(&self.delivery_thread);
        self.shutdown.store(true, Ordering::Release);
        self.flow.stop();
    }

    fn terminate_and_join(&self) -> Result<(), String> {
        let claimed_io = !self.io_stopped.swap(true, Ordering::AcqRel);
        let result = self.kill_child();
        #[cfg(unix)]
        {
            for _ in 0..10 {
                if self.exited.load(Ordering::Acquire) {
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
            if !self.exited.load(Ordering::Acquire) {
                if let Some(process_group) = self.process_group {
                    // portable-pty's cloned Unix killer sends SIGHUP. Escalate the
                    // whole PTY process group so a shell that traps HUP cannot leak.
                    unsafe {
                        libc::kill(-process_group, libc::SIGKILL);
                    }
                }
            }
        }
        if claimed_io {
            self.stop_io_claimed();
        } else {
            self.shutdown.store(true, Ordering::Release);
            self.flow.stop();
            lock(&self.writer).take();
            lock(&self.master).take();
        }
        join_named(&self.waiter_thread);
        result
    }
}

impl Drop for PtyRegistry {
    fn drop(&mut self) {
        let handles: Vec<_> = lock(&self.ptys).drain().map(|(_, handle)| handle).collect();
        for handle in handles {
            let _ = handle.terminate_and_join();
        }
    }
}

impl PtyState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            registry: Arc::default(),
            app_data_dir: Arc::new(app_data_dir),
        }
    }

    #[cfg_attr(test, allow(dead_code))]
    pub fn shutdown_all(&self) {
        let handles: Vec<_> = lock(&self.registry.ptys)
            .drain()
            .map(|(_, handle)| handle)
            .collect();
        for handle in handles {
            let _ = handle.terminate_and_join();
        }
    }

    fn acknowledge(&self, tab_id: &str) {
        if let Some(handle) = lock(&self.registry.ptys).get(tab_id).cloned() {
            handle.flow.acknowledge();
        }
    }

    fn remove(&self, tab_id: &str) -> Option<Arc<PtyHandle>> {
        lock(&self.registry.ptys).remove(tab_id)
    }

    fn spawn(
        &self,
        tab_id: String,
        launch: ShellLaunch,
        cols: u16,
        rows: u16,
        on_data: Arc<dyn OutputSink>,
        on_exit: Arc<dyn ExitSink>,
    ) -> Result<PtyInfo, String> {
        let previous = lock(&self.registry.ptys).get(&tab_id).cloned();
        if let Some(previous) = previous {
            let _ = previous.terminate_and_join();
            remove_if_current(&Arc::downgrade(&self.registry), &tab_id, &previous);
        }

        let mut command = CommandBuilder::new(launch.command);
        command.args(&launch.args);
        command.cwd(&launch.cwd);
        configure_environment(&mut command);
        for (key, value) in launch.env {
            command.env(key, value);
        }

        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("failed to open PTY: {error}"))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("failed to clone PTY reader: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("failed to take PTY writer: {error}"))?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("failed to spawn {}: {error}", launch.command))?;
        let pid = child.process_id();
        let killer = child.clone_killer();
        #[cfg(unix)]
        let process_group = pair.master.process_group_leader();
        drop(pair.slave);

        let handle = Arc::new(PtyHandle {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(Some(killer)),
            reader_thread: Mutex::new(None),
            delivery_thread: Mutex::new(None),
            waiter_thread: Mutex::new(None),
            flow: Arc::new(FlowControl::default()),
            shutdown: AtomicBool::new(false),
            io_stopped: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            #[cfg(unix)]
            process_group,
        });

        let (output_tx, output_rx) = mpsc::sync_channel(READ_QUEUE_CHUNKS);
        let reader_handle = Arc::clone(&handle);
        let reader_thread = thread::Builder::new()
            .name(format!("pty-reader-{tab_id}"))
            .spawn(move || read_worker(&mut reader, output_tx, &reader_handle))
            .map_err(|error| format!("failed to start PTY reader: {error}"))?;
        *lock(&handle.reader_thread) = Some(reader_thread);

        let delivery_handle = Arc::clone(&handle);
        let delivery_thread = thread::Builder::new()
            .name(format!("pty-delivery-{tab_id}"))
            .spawn(move || delivery_worker(output_rx, on_data, &delivery_handle))
            .map_err(|error| {
                let _ = handle.kill_child();
                handle.stop_io();
                format!("failed to start PTY delivery worker: {error}")
            })?;
        *lock(&handle.delivery_thread) = Some(delivery_thread);

        lock(&self.registry.ptys).insert(tab_id.clone(), Arc::clone(&handle));
        let weak_registry = Arc::downgrade(&self.registry);
        let waiter_handle = Arc::clone(&handle);
        let waiter_tab_id = tab_id.clone();
        let waiter_thread = thread::Builder::new()
            .name(format!("pty-waiter-{tab_id}"))
            .spawn(move || {
                let code = child
                    .wait()
                    .map(|status| status.exit_code().min(i32::MAX as u32) as i32)
                    .unwrap_or(1);
                waiter_handle.exited.store(true, Ordering::Release);
                waiter_handle.finish_io();
                remove_if_current(&weak_registry, &waiter_tab_id, &waiter_handle);
                on_exit.send(code);
            })
            .map_err(|error| {
                if let Some(handle) = self.remove(&tab_id) {
                    let _ = handle.terminate_and_join();
                }
                format!("failed to start PTY exit waiter: {error}")
            })?;
        *lock(&handle.waiter_thread) = Some(waiter_thread);

        Ok(PtyInfo {
            pid,
            shell_name: launch.name,
            cwd: launch.cwd.to_string_lossy().into_owned(),
        })
    }

    pub(crate) fn spawn_zerolink(
        &self,
        session_id: String,
        cols: u16,
        rows: u16,
        on_data: Arc<dyn OutputSink>,
        on_exit: Arc<dyn ExitSink>,
    ) -> Result<PtyInfo, String> {
        validate_tab_id(&session_id)?;
        self.spawn(
            session_id,
            profile("auto", home_dir())?,
            cols.clamp(1, 1000),
            rows.clamp(1, 500),
            on_data,
            on_exit,
        )
    }

    pub(crate) fn write_zerolink(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        if data.len() > MAX_WRITE_BYTES {
            return Err(format!("PTY write exceeds {MAX_WRITE_BYTES} bytes"));
        }
        let handle = lock(&self.registry.ptys)
            .get(session_id)
            .cloned()
            .ok_or_else(|| "PTY not found".to_string())?;
        let mut writer = lock(&handle.writer);
        let writer = writer
            .as_mut()
            .ok_or_else(|| "PTY writer is closed".to_string())?;
        writer
            .write_all(data)
            .and_then(|()| writer.flush())
            .map_err(|error| format!("PTY write failed: {error}"))
    }

    pub(crate) fn resize_zerolink(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let handle = lock(&self.registry.ptys)
            .get(session_id)
            .cloned()
            .ok_or_else(|| "PTY not found".to_string())?;
        let master = lock(&handle.master);
        let master = master.as_ref().ok_or_else(|| "PTY is closed".to_string())?;
        master
            .resize(PtySize {
                cols: cols.clamp(1, 1000),
                rows: rows.clamp(1, 500),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("PTY resize failed: {error}"))
    }

    pub(crate) fn kill_zerolink(&self, session_id: &str) {
        if let Some(handle) = self.remove(session_id) {
            let _ = handle.terminate_and_join();
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

fn kill_error_is_gone(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::InvalidInput || error.raw_os_error() == Some(0) {
        return true;
    }
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::ESRCH) {
        return true;
    }
    // Windows: killing a child that already exited returns ERROR_INVALID_HANDLE (6) or
    // ERROR_ACCESS_DENIED (5) — for a child we own both mean "already gone", so teardown is a no-op.
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(5) | Some(6)) {
        return true;
    }
    false
}

fn join_named(slot: &Mutex<Option<JoinHandle<()>>>) {
    if let Some(thread) = lock(slot).take() {
        if thread.thread().id() != thread::current().id() {
            let _ = thread.join();
        }
    }
}

fn remove_if_current(registry: &Weak<PtyRegistry>, tab_id: &str, handle: &Arc<PtyHandle>) {
    let Some(registry) = registry.upgrade() else {
        return;
    };
    let mut ptys = lock(&registry.ptys);
    if ptys
        .get(tab_id)
        .is_some_and(|current| Arc::ptr_eq(current, handle))
    {
        ptys.remove(tab_id);
    }
}

fn read_worker(reader: &mut Box<dyn Read + Send>, output: SyncSender<Vec<u8>>, handle: &PtyHandle) {
    let mut buffer = vec![0_u8; READ_CHUNK_BYTES];
    while !handle.shutdown.load(Ordering::Acquire) {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                if output.send(buffer[..count].to_vec()).is_err() {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

fn delivery_worker(output: Receiver<Vec<u8>>, on_data: Arc<dyn OutputSink>, handle: &PtyHandle) {
    let mut batch = Vec::with_capacity(BATCH_BYTES);
    loop {
        if handle.shutdown.load(Ordering::Acquire) {
            break;
        }
        match output.recv_timeout(BATCH_DELAY) {
            Ok(chunk) => {
                batch.extend_from_slice(&chunk);
                while batch.len() >= BATCH_BYTES {
                    let remainder = batch.split_off(BATCH_BYTES);
                    if !send_batch(
                        std::mem::replace(&mut batch, remainder),
                        on_data.as_ref(),
                        handle,
                    ) {
                        return;
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if !batch.is_empty()
                    && !send_batch(std::mem::take(&mut batch), on_data.as_ref(), handle)
                {
                    return;
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                if !batch.is_empty() {
                    let _ = send_batch(std::mem::take(&mut batch), on_data.as_ref(), handle);
                }
                return;
            }
        }
    }
}

fn send_batch(batch: Vec<u8>, on_data: &dyn OutputSink, handle: &PtyHandle) -> bool {
    if batch.is_empty() || !handle.flow.reserve(batch.len()) {
        return false;
    }
    if on_data.send(batch).is_err() {
        handle.flow.acknowledge();
        handle.shutdown.store(true, Ordering::Release);
        return false;
    }
    if on_data.auto_acknowledge() {
        handle.flow.acknowledge();
    }
    true
}

fn valid_tab_id(tab_id: &str) -> bool {
    !tab_id.is_empty()
        && tab_id.len() <= 80
        && tab_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn validate_tab_id(tab_id: &str) -> Result<(), String> {
    if valid_tab_id(tab_id) {
        Ok(())
    } else {
        Err("invalid terminal tab id".into())
    }
}

fn normalize_dimension(value: f64, fallback: u16, max: u16) -> u16 {
    if value.is_finite() {
        value.trunc().clamp(1.0, f64::from(max)) as u16
    } else {
        fallback
    }
}

fn home_dir() -> PathBuf {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg_attr(test, allow(dead_code))]
fn usable_cwd(requested: Option<String>) -> PathBuf {
    requested
        .filter(|value| value.len() <= 32 * 1024)
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .unwrap_or_else(home_dir)
}

fn profile(profile_key: &str, cwd: PathBuf) -> Result<ShellLaunch, String> {
    let requested = if profile_key == "auto" || profile_key.is_empty() {
        default_profile_key()
    } else {
        profile_key
    };
    let key = if (cfg!(windows) && matches!(requested, "powershell" | "pwsh" | "cmd" | "wsl"))
        || (!cfg!(windows) && matches!(requested, "zsh" | "bash" | "fish"))
    {
        requested
    } else {
        default_profile_key()
    };
    let (command, args, name) = match key {
        "zsh" if !cfg!(windows) => ("zsh", vec!["-l".into()], "zsh"),
        "bash" if !cfg!(windows) => ("bash", vec!["-l".into()], "bash"),
        "fish" if !cfg!(windows) => ("fish", vec!["-l".into()], "fish"),
        "powershell" if cfg!(windows) => ("powershell.exe", vec![], "PowerShell"),
        "pwsh" if cfg!(windows) => ("pwsh.exe", vec![], "PowerShell 7"),
        "cmd" if cfg!(windows) => ("cmd.exe", vec![], "Command Prompt"),
        "wsl" if cfg!(windows) => (
            "wsl.exe",
            vec!["--cd".into(), cwd.to_string_lossy().into_owned()],
            "WSL",
        ),
        _ => return Err(format!("unsupported shell profile: {profile_key}")),
    };
    Ok(ShellLaunch {
        command,
        args,
        name,
        cwd,
        env: Vec::new(),
    })
}

#[cfg(windows)]
fn default_profile_key() -> &'static str {
    let output = std::process::Command::new("wsl.exe")
        .args(["-l", "-q"])
        .output();
    match output {
        Ok(output) => {
            let words: Vec<u16> = output
                .stdout
                .chunks_exact(2)
                .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                .filter(|word| *word != 0)
                .collect();
            if String::from_utf16_lossy(&words).trim().is_empty() {
                "powershell"
            } else {
                "wsl"
            }
        }
        Err(_) => "powershell",
    }
}

#[cfg(not(windows))]
fn default_profile_key() -> &'static str {
    match env::var("SHELL")
        .ok()
        .as_deref()
        .and_then(|shell| std::path::Path::new(shell).file_name())
        .and_then(|name| name.to_str())
    {
        Some("bash") => "bash",
        Some("fish") => "fish",
        _ => "zsh",
    }
}

const ZSH_HOOK: &str = r#"autoload -Uz add-zsh-hook
_cupertino_precmd() {
  local exit_code=$?
  printf '\e]133;D;%d\a\e]133;A\a\e]7;file://%s%s\a' "$exit_code" "$HOST" "$PWD"
}
add-zsh-hook precmd _cupertino_precmd
_cupertino_esc=$'\e'
_cupertino_bel=$'\a'
PROMPT="${PROMPT}%{${_cupertino_esc}]133;B${_cupertino_bel}%}"
unset _cupertino_esc _cupertino_bel
"#;

const BASH_INTEGRATION: &str = r#"if [[ -r "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -r "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -r "$HOME/.profile" ]]; then
  source "$HOME/.profile"
elif [[ -r "$HOME/.bashrc" ]]; then
  source "$HOME/.bashrc"
fi

if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare -a'; then
  __cupertino_previous_prompt_commands=("${PROMPT_COMMAND[@]}")
else
  __cupertino_previous_prompt_commands=("$PROMPT_COMMAND")
fi
__cupertino_prompt_command() {
  local exit_code=$?
  printf '\e]133;D;%d\a\e]133;A\a\e]7;file://%s%s\a' "$exit_code" "$HOSTNAME" "$PWD"
  local previous
  for previous in "${__cupertino_previous_prompt_commands[@]}"; do
    [[ -n "$previous" && "$previous" != "__cupertino_prompt_command" ]] && eval "$previous"
  done
}
PROMPT_COMMAND=__cupertino_prompt_command
PS1="${PS1}"$'\e]133;B\a'
"#;

const FISH_INTEGRATION: &str = r#"function __cupertino_prompt_event --on-event fish_prompt
    set -l exit_code $status
    printf '\e]133;D;%d\a\e]133;A\a\e]7;file://%s%s\a' $exit_code (hostname) $PWD
end

function __cupertino_preexec --on-event fish_preexec
    printf '\e]133;C\a'
end
"#;

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn write_private(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, contents).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn zsh_source_original(original: &Path, name: &str) -> String {
    format!(
        "# Generated by Cupertino Terminal. Do not edit.\n\
         _cupertino_runtime_zdotdir=\"$ZDOTDIR\"\n\
         _cupertino_original_zdotdir={}\n\
         ZDOTDIR=\"$_cupertino_original_zdotdir\"\n\
         if [[ -r \"$_cupertino_original_zdotdir/{name}\" ]]; then\n\
         \x20 source \"$_cupertino_original_zdotdir/{name}\"\n\
         fi\n\
         ZDOTDIR=\"$_cupertino_runtime_zdotdir\"\n\
         unset _cupertino_original_zdotdir _cupertino_runtime_zdotdir\n",
        shell_quote(&original.to_string_lossy())
    )
}

fn prepare_shell_launch(
    mut launch: ShellLaunch,
    app_data_dir: &Path,
    inherited: &HashMap<String, String>,
) -> Result<ShellLaunch, String> {
    let integration_dir = app_data_dir.join("shell-integration");
    match launch.command {
        "zsh" => {
            let original = inherited
                .get("ZDOTDIR")
                .or_else(|| inherited.get("HOME"))
                .map(PathBuf::from)
                .unwrap_or_else(home_dir);
            let runtime_dir = integration_dir.join("zsh");
            let hook = integration_dir.join("cupertino.zsh");
            write_private(&hook, ZSH_HOOK)?;
            for name in [".zshenv", ".zprofile", ".zlogin", ".zlogout"] {
                write_private(
                    &runtime_dir.join(name),
                    &zsh_source_original(&original, name),
                )?;
            }
            let mut zshrc = zsh_source_original(&original, ".zshrc");
            zshrc.push_str(&format!(
                "# Keep history outside the generated runtime and read-only app bundles.\n\
                 if [[ -z \"$HISTFILE\" || \"$HISTFILE\" == \"$ZDOTDIR/\"* ]]; then\n\
                 \x20 HISTFILE={}\n\
                 fi\n\
                 source {}\n",
                shell_quote(&original.join(".zsh_history").to_string_lossy()),
                shell_quote(&hook.to_string_lossy())
            ));
            write_private(&runtime_dir.join(".zshrc"), &zshrc)?;
            launch.env.push((
                "CUPERTINO_ORIGINAL_ZDOTDIR".into(),
                original.to_string_lossy().into_owned(),
            ));
            launch
                .env
                .push(("ZDOTDIR".into(), runtime_dir.to_string_lossy().into_owned()));
        }
        "bash" => {
            let hook = integration_dir.join("bash.bash");
            write_private(&hook, BASH_INTEGRATION)?;
            launch.args = vec![
                "--rcfile".into(),
                hook.to_string_lossy().into_owned(),
                "-i".into(),
            ];
        }
        "fish" => {
            let hook = integration_dir.join("fish.fish");
            write_private(&hook, FISH_INTEGRATION)?;
            launch.args = vec![
                "-l".into(),
                "-C".into(),
                format!("source {}", shell_quote(&hook.to_string_lossy())),
            ];
        }
        _ => {}
    }
    Ok(launch)
}

fn configure_environment(command: &mut CommandBuilder) {
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Cupertino_Terminal");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    if env::var_os("LANG").is_none() {
        command.env("LANG", "en_US.UTF-8");
    }
    #[cfg(target_os = "macos")]
    {
        let defaults = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ];
        let existing = env::var("PATH").unwrap_or_default();
        let mut entries: Vec<&str> = defaults.to_vec();
        for entry in existing.split(':').filter(|entry| !entry.is_empty()) {
            if !entries.contains(&entry) {
                entries.push(entry);
            }
        }
        command.env("PATH", entries.join(":"));
    }
}

#[tauri::command]
#[cfg(not(test))]
#[allow(clippy::too_many_arguments)]
pub fn create_pty(
    tab_id: String,
    profile_key: String,
    cols: f64,
    rows: f64,
    cwd: Option<String>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
    state: State<'_, PtyState>,
) -> Result<PtyInfo, String> {
    validate_tab_id(&tab_id)?;
    let cols = normalize_dimension(cols, 80, 1000);
    let rows = normalize_dimension(rows, 30, 500);
    let launch = profile(&profile_key, usable_cwd(cwd))?;
    let inherited = env::vars().collect();
    let launch = prepare_shell_launch(launch, &state.app_data_dir, &inherited)?;
    state.spawn(
        tab_id,
        launch,
        cols,
        rows,
        Arc::new(on_data),
        Arc::new(on_exit),
    )
}

#[tauri::command]
#[cfg(not(test))]
pub fn pty_write(tab_id: String, data: String, state: State<'_, PtyState>) -> Result<(), String> {
    validate_tab_id(&tab_id)?;
    if data.len() > MAX_WRITE_BYTES {
        return Err(format!("PTY write exceeds {MAX_WRITE_BYTES} bytes"));
    }
    let handle = lock(&state.registry.ptys)
        .get(&tab_id)
        .cloned()
        .ok_or_else(|| "PTY not found".to_string())?;
    let mut writer = lock(&handle.writer);
    let writer = writer
        .as_mut()
        .ok_or_else(|| "PTY writer is closed".to_string())?;
    writer
        .write_all(data.as_bytes())
        .and_then(|()| writer.flush())
        .map_err(|error| format!("PTY write failed: {error}"))
}

#[tauri::command]
#[cfg(not(test))]
pub fn pty_resize(
    tab_id: String,
    cols: f64,
    rows: f64,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    validate_tab_id(&tab_id)?;
    let handle = lock(&state.registry.ptys)
        .get(&tab_id)
        .cloned()
        .ok_or_else(|| "PTY not found".to_string())?;
    let master = lock(&handle.master);
    let master = master.as_ref().ok_or_else(|| "PTY is closed".to_string())?;
    master
        .resize(PtySize {
            cols: normalize_dimension(cols, 80, 1000),
            rows: normalize_dimension(rows, 30, 500),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("PTY resize failed: {error}"))
}

#[tauri::command]
#[cfg(not(test))]
pub fn pty_kill(tab_id: String, state: State<'_, PtyState>) -> Result<(), String> {
    validate_tab_id(&tab_id)?;
    let handle = lock(&state.registry.ptys).get(&tab_id).cloned();
    if let Some(handle) = handle {
        let result = handle.terminate_and_join();
        remove_if_current(&Arc::downgrade(&state.registry), &tab_id, &handle);
        result
    } else {
        Ok(())
    }
}

#[tauri::command]
#[cfg(not(test))]
pub fn pty_ack(tab_id: String, state: State<'_, PtyState>) -> Result<(), String> {
    validate_tab_id(&tab_id)?;
    state.acknowledge(&tab_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{Condvar, Mutex},
        time::{Duration, Instant},
    };
    struct CallbackOutput(Box<dyn Fn(Vec<u8>) + Send + Sync>);

    impl OutputSink for CallbackOutput {
        fn send(&self, bytes: Vec<u8>) -> Result<(), ()> {
            (self.0)(bytes);
            Ok(())
        }
    }

    struct IgnoreExit;

    impl ExitSink for IgnoreExit {
        fn send(&self, _code: i32) {}
    }

    #[derive(Default)]
    struct ExitCapture {
        code: Mutex<Option<i32>>,
        changed: Condvar,
    }

    impl ExitCapture {
        fn wait(&self, timeout: Duration) -> Option<i32> {
            let (code, _) = self
                .changed
                .wait_timeout_while(lock(&self.code), timeout, |code| code.is_none())
                .unwrap_or_else(|error| error.into_inner());
            *code
        }
    }

    impl ExitSink for ExitCapture {
        fn send(&self, code: i32) {
            *lock(&self.code) = Some(code);
            self.changed.notify_all();
        }
    }

    #[derive(Default)]
    struct Capture {
        bytes: Mutex<Vec<u8>>,
        changed: Condvar,
    }

    impl Capture {
        fn append(&self, bytes: &[u8]) {
            lock(&self.bytes).extend_from_slice(bytes);
            self.changed.notify_all();
        }

        fn wait_for(&self, needle: &[u8], timeout: Duration) -> Vec<u8> {
            self.wait_for_count(needle, 1, timeout)
        }

        fn wait_for_count(&self, needle: &[u8], count: usize, timeout: Duration) -> Vec<u8> {
            let deadline = Instant::now() + timeout;
            let mut bytes = lock(&self.bytes);
            while bytes
                .windows(needle.len())
                .filter(|window| *window == needle)
                .count()
                < count
            {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                let (next, _) = self
                    .changed
                    .wait_timeout(bytes, remaining)
                    .unwrap_or_else(|error| error.into_inner());
                bytes = next;
            }
            bytes.clone()
        }
    }

    fn test_profile(cwd: PathBuf) -> ShellLaunch {
        #[cfg(windows)]
        {
            profile("cmd", cwd).expect("Command Prompt profile")
        }
        #[cfg(not(windows))]
        {
            profile("bash", cwd).expect("bash profile")
        }
    }

    fn test_channels(
        state: PtyState,
        tab_id: &'static str,
        capture: Arc<Capture>,
    ) -> (Arc<dyn OutputSink>, Arc<dyn ExitSink>, Arc<ExitCapture>) {
        let output = CallbackOutput(Box::new(move |bytes| {
            capture.append(&bytes);
            state.acknowledge(tab_id);
        }));
        let exit = Arc::new(ExitCapture::default());
        (Arc::new(output), exit.clone(), exit)
    }

    fn write_and_wait(
        state: &PtyState,
        tab_id: &str,
        command: &str,
        marker: &[u8],
        capture: &Capture,
    ) -> Vec<u8> {
        let handle = lock(&state.registry.ptys)
            .get(tab_id)
            .cloned()
            .expect("live PTY");
        {
            let mut writer = lock(&handle.writer);
            let writer = writer.as_mut().expect("PTY writer");
            writer.write_all(command.as_bytes()).expect("write command");
            writer.flush().expect("flush command");
        }
        capture.wait_for(marker, Duration::from_secs(20))
    }

    fn terminate_test(state: &PtyState, tab_id: &str) -> Arc<PtyHandle> {
        let handle = lock(&state.registry.ptys)
            .get(tab_id)
            .cloned()
            .expect("PTY handle");
        handle.terminate_and_join().expect("clean teardown");
        remove_if_current(&Arc::downgrade(&state.registry), tab_id, &handle);
        handle
    }

    #[test]
    fn shell_round_trip() {
        let state = PtyState::default();
        let capture = Arc::new(Capture::default());
        let (output, exit, exit_capture) =
            test_channels(state.clone(), "roundtrip", Arc::clone(&capture));
        state
            .spawn(
                "roundtrip".into(),
                test_profile(home_dir()),
                80,
                30,
                output,
                exit,
            )
            .expect("spawn shell");
        #[cfg(windows)]
        let command = "\x1b[1;1Recho CUPERTINO_PTY_OK\r\nexit\r\n";
        #[cfg(not(windows))]
        let command = "echo CUPERTINO_PTY_OK\nexit\n";
        write_and_wait(&state, "roundtrip", command, b"CUPERTINO_PTY_OK", &capture);
        let bytes = capture.wait_for_count(b"CUPERTINO_PTY_OK", 2, Duration::from_secs(20));
        assert!(
            bytes
                .windows(b"CUPERTINO_PTY_OK".len())
                .filter(|window| *window == b"CUPERTINO_PTY_OK")
                .count()
                >= 2,
            "PTY output was: {:?}",
            String::from_utf8_lossy(&bytes)
        );
        assert_eq!(exit_capture.wait(Duration::from_secs(20)), Some(0));
        assert!(!lock(&state.registry.ptys).contains_key("roundtrip"));
    }

    #[test]
    fn sustained_output_is_complete_and_bounded() {
        let state = PtyState::default();
        let capture = Arc::new(Capture::default());
        let (ack_tx, ack_rx) = mpsc::channel();
        let output_capture = Arc::clone(&capture);
        let output = Arc::new(CallbackOutput(Box::new(move |bytes| {
            output_capture.append(&bytes);
            let _ = ack_tx.send(());
        }))) as Arc<dyn OutputSink>;
        let ack_state = state.clone();
        let ack_worker = thread::spawn(move || {
            while ack_rx.recv().is_ok() {
                thread::sleep(Duration::from_millis(50));
                ack_state.acknowledge("sustained");
            }
        });
        let exit = Arc::new(IgnoreExit) as Arc<dyn ExitSink>;
        state
            .spawn(
                "sustained".into(),
                test_profile(home_dir()),
                120,
                40,
                output,
                exit,
            )
            .expect("spawn shell");
        #[cfg(windows)]
        let command = "\x1b[1;1Rfor /L %i in (1,1,12000) do @echo BOUND%i\r\n";
        #[cfg(not(windows))]
        let command =
            "i=1; while [ $i -le 12000 ]; do printf 'BOUND%05d\\n' \"$i\"; i=$((i+1)); done\r\n";
        let bytes = write_and_wait(&state, "sustained", command, b"BOUND12000", &capture);
        #[cfg(windows)]
        assert!(bytes
            .windows(b"BOUND1".len())
            .any(|window| window == b"BOUND1"));
        #[cfg(not(windows))]
        assert!(bytes
            .windows(b"BOUND00001".len())
            .any(|window| window == b"BOUND00001"));
        assert!(bytes
            .windows(b"BOUND12000".len())
            .any(|window| window == b"BOUND12000"));
        assert!(
            bytes
                .windows(b"BOUND".len())
                .filter(|window| *window == b"BOUND")
                .count()
                >= 12_000
        );
        let handle = terminate_test(&state, "sustained");
        let (messages, bytes) = handle.flow.high_water();
        assert!(messages <= MAX_IN_FLIGHT_MESSAGES);
        assert!(bytes <= MAX_IN_FLIGHT_BYTES);
        drop(handle);
        ack_worker.join().expect("acknowledgement worker");
    }

    #[test]
    fn utf8_split_boundaries_remain_raw_and_intact() {
        struct OneByteReader {
            bytes: std::io::Cursor<Vec<u8>>,
        }
        impl Read for OneByteReader {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                let count = output.len().min(1);
                self.bytes.read(&mut output[..count])
            }
        }

        let expected = "A界🙂B".as_bytes().to_vec();
        let reader: Box<dyn Read + Send> = Box::new(OneByteReader {
            bytes: std::io::Cursor::new(expected.clone()),
        });
        let (tx, rx) = mpsc::sync_channel(READ_QUEUE_CHUNKS);
        let handle = Arc::new(PtyHandle {
            master: Mutex::new(None),
            writer: Mutex::new(None),
            killer: Mutex::new(None),
            reader_thread: Mutex::new(None),
            delivery_thread: Mutex::new(None),
            waiter_thread: Mutex::new(None),
            flow: Arc::new(FlowControl::default()),
            shutdown: AtomicBool::new(false),
            io_stopped: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            #[cfg(unix)]
            process_group: None,
        });
        let reader_handle = Arc::clone(&handle);
        let worker = thread::spawn(move || {
            let mut reader = reader;
            read_worker(&mut reader, tx, &reader_handle);
        });
        let actual: Vec<u8> = rx.into_iter().flatten().collect();
        worker.join().expect("reader worker");
        assert_eq!(actual, expected);
        assert_eq!(String::from_utf8(actual).expect("valid UTF-8"), "A界🙂B");
    }

    #[test]
    fn frontend_parameters_are_validated_and_clamped() {
        assert!(validate_tab_id("tab_1-ok").is_ok());
        assert!(validate_tab_id("../bad").is_err());
        assert!(validate_tab_id(&"a".repeat(81)).is_err());
        assert_eq!(normalize_dimension(f64::NAN, 80, 1000), 80);
        assert_eq!(normalize_dimension(-5.0, 80, 1000), 1);
        assert_eq!(normalize_dimension(9000.0, 30, 500), 500);
    }

    #[test]
    fn shell_integration_is_generated_in_writable_app_data() {
        let data = tempfile::tempdir().expect("temporary app data");
        let cwd = data.path().to_path_buf();
        let inherited = HashMap::from([("HOME".into(), "/Users/test".into())]);

        let zsh = prepare_shell_launch(
            ShellLaunch {
                command: "zsh",
                args: vec!["-l".into()],
                name: "zsh",
                cwd: cwd.clone(),
                env: Vec::new(),
            },
            data.path(),
            &inherited,
        )
        .expect("zsh integration");
        let zdotdir = zsh
            .env
            .iter()
            .find(|(key, _)| key == "ZDOTDIR")
            .map(|(_, value)| PathBuf::from(value))
            .expect("generated ZDOTDIR");
        assert!(zdotdir.starts_with(data.path()));
        let zshrc = fs::read_to_string(zdotdir.join(".zshrc")).expect("generated zshrc");
        assert!(zshrc.contains("OSC") || zshrc.contains("cupertino.zsh"));
        assert!(zshrc.contains("/Users/test") && zshrc.contains(".zsh_history"));

        let bash = prepare_shell_launch(
            ShellLaunch {
                command: "bash",
                args: vec!["-l".into()],
                name: "bash",
                cwd,
                env: Vec::new(),
            },
            data.path(),
            &inherited,
        )
        .expect("bash integration");
        assert_eq!(bash.args.first().map(String::as_str), Some("--rcfile"));
        assert!(Path::new(&bash.args[1]).starts_with(data.path()));
        assert!(fs::read_to_string(&bash.args[1])
            .expect("generated bash rcfile")
            .contains("133;A"));
    }
}
