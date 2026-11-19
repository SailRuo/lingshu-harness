//! Owns the bundled Node backend process.
//!
//! The desktop bundle ships:
//!   Resources/backend/dist/index.js
//!   Resources/backend/node_modules/
//!   Resources/backend/runtime/node
//!   Resources/backend/models/
//!
//! At startup we reuse an already running backend when `/health` reports the
//! LingShu service (the normal `tsx watch` development flow), otherwise we
//! spawn the bundled runtime with an explicit port and data directory. The
//! child is killed on application exit; an externally managed backend is left
//! untouched.

use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager};

const DEFAULT_PORT: u16 = 8600;
const BACKEND_SERVICE: &str = "lingshu-backend-node";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
/// Backoff between restart attempts after the backend dies.
const RESTART_BACKOFF: Duration = Duration::from_secs(2);
/// Give up restarting after this many consecutive failures, so a backend that
/// cannot start does not spin forever burning CPU.
const MAX_RESTART_ATTEMPTS: u32 = 5;

#[derive(Default)]
pub struct BackendState {
    child: Mutex<Option<Child>>,
    /// Set once the application is shutting down, so the supervisor thread
    /// does not resurrect the backend while the app is exiting.
    shutting_down: AtomicBool,
}

/// Probes the configured port and starts the bundled backend when needed.
/// Failures are logged instead of aborting application startup so the settings
/// window can still be used to diagnose a broken backend.
pub fn ensure_started(app: AppHandle) {
    let port = resolve_port();
    let data_dir = match resolve_data_dir(&app) {
        Ok(dir) => dir,
        Err(error) => {
            eprintln!("[backend] {error}");
            return;
        }
    };

    if health_ok(port) {
        append_log(&data_dir, "reusing already running backend");
        return;
    }

    match start(&app, port, &data_dir) {
        Ok(()) => {
            // Watch the child so an unexpected exit is recovered from instead of
            // leaving the app permanently disconnected.
            let handle = app.clone();
            let log_dir = data_dir.to_path_buf();
            std::thread::spawn(move || supervise(handle, port, log_dir));
        }
        Err(error) => append_log(
            &data_dir,
            &format!("failed to start bundled backend: {error}"),
        ),
    }
}

/// Stops the backend only when this process owns it.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<BackendState>();
    // Tell the supervisor thread to stop before killing the child, otherwise it
    // would immediately restart the backend we are about to terminate.
    state.shutting_down.store(true, Ordering::SeqCst);
    let child = {
        let mut guard = state
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.take()
    };
    let Some(mut child) = child else {
        return;
    };

    let pid = child.id();

    #[cfg(unix)]
    {
        // Child::kill is SIGKILL on Unix; ask Node to exit cleanly first so
        // SQLite WAL checkpoints and scheduler shutdown hooks can run.
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        for _ in 0..30 {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => break,
            }
        }
    }

    let _ = child.kill();
    let _ = child.wait();
}

fn start(app: &AppHandle, port: u16, data_dir: &Path) -> Result<(), String> {
    let child = spawn_backend(app, port, data_dir)?;
    let pid = child.id();

    let state = app.state::<BackendState>();
    {
        let mut guard = state
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = Some(child);
    }

    append_log(data_dir, &format!("backend spawned, pid {pid}"));
    Ok(())
}

/// Spawns the Node backend process. Kept separate from `start` so the
/// supervisor can re-launch it after an unexpected exit.
fn spawn_backend(app: &AppHandle, port: u16, data_dir: &Path) -> Result<Child, String> {
    let root = resolve_backend_root(app)?;
    let entry = resolve_entry(&root)?;
    let node = resolve_node(&root)?;

    let db_path = data_dir.join("data").join("lingshu.db");
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建数据目录 {}: {error}", parent.display()))?;
    }

    let (stdout, stderr) = open_log_streams(data_dir);
    let mut command = Command::new(&node);
    command
        .arg(&entry)
        .current_dir(data_dir)
        .env("PORT", port.to_string())
        .env("HOST", resolve_host())
        .env("NODE_ENV", "production")
        .env("DB_PATH", &db_path)
        .env("LINGSHU_DATA_DIR", data_dir)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);

    let model_env = configure_models(&mut command, &root);
    for (key, value) in &model_env {
        append_log(data_dir, &format!("{key}={}", value.display()));
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    append_log(
        data_dir,
        &format!(
            "starting backend: {} {} (port {port}, data {})",
            node.display(),
            entry.display(),
            data_dir.display()
        ),
    );

    command
        .spawn()
        .map_err(|error| format!("无法启动 Node 后端 {}: {error}", node.display()))
}

fn wait_until_healthy(app: AppHandle, port: u16, data_dir: PathBuf) {
    let deadline = std::time::Instant::now() + HEALTH_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if health_ok(port) {
            append_log(&data_dir, &format!("backend healthy on port {port}"));
            return;
        }

        let exited = {
            let state = app.state::<BackendState>();
            let mut guard = state
                .child
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match guard.as_mut() {
                Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                None => true,
            }
        };
        if exited {
            append_log(
                &data_dir,
                &format!(
                    "backend exited before becoming healthy; inspect {}",
                    backend_log_path(&data_dir).display()
                ),
            );
            return;
        }

        std::thread::sleep(Duration::from_millis(250));
    }

    append_log(
        &data_dir,
        &format!(
            "backend did not become healthy within {}s; inspect {}",
            HEALTH_TIMEOUT.as_secs(),
            backend_log_path(&data_dir).display()
        ),
    );
}

/// Watches the backend process and restarts it when it dies unexpectedly.
///
/// Without this, a single unhandled exception in the Node process left the
/// desktop app permanently broken: the GUI kept retrying its WebSocket
/// connection against a port nobody was listening on, and the user had to
/// quit and relaunch the application. The Python backend had the same
/// guarantee through `uvicorn --reload`.
fn supervise(app: AppHandle, port: u16, data_dir: PathBuf) {
    let mut failures: u32 = 0;

    // Report the initial health state before entering the watch loop.
    wait_until_healthy(app.clone(), port, data_dir.clone());

    loop {
        if app.state::<BackendState>().shutting_down.load(Ordering::SeqCst) {
            return;
        }

        // Wait for the child to exit. `try_wait` keeps the wait non-blocking so
        // the shutdown flag is observed promptly.
        let exit_status = loop {
            if app.state::<BackendState>().shutting_down.load(Ordering::SeqCst) {
                return;
            }
            // `None` means "still running"; `Some(status)` means it exited.
            // A missing child or an unusable handle also counts as an exit.
            let status = {
                let state = app.state::<BackendState>();
                let mut guard = state
                    .child
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                match guard.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(status) => status,
                        Err(_) => Some(ExitStatus::default()),
                    },
                    None => Some(ExitStatus::default()),
                }
            };
            if let Some(status) = status {
                break status;
            }
            std::thread::sleep(Duration::from_millis(500));
        };

        if app.state::<BackendState>().shutting_down.load(Ordering::SeqCst) {
            return;
        }

        failures += 1;
        append_log(
            &data_dir,
            &format!(
                "backend exited unexpectedly (status {exit_status:?}); \
                 restarting (attempt {failures}/{MAX_RESTART_ATTEMPTS})"
            ),
        );

        if failures > MAX_RESTART_ATTEMPTS {
            append_log(
                &data_dir,
                &format!(
                    "backend failed {MAX_RESTART_ATTEMPTS} times in a row; giving up. \
                     inspect {}",
                    backend_log_path(&data_dir).display()
                ),
            );
            return;
        }

        std::thread::sleep(RESTART_BACKOFF);

        match spawn_backend(&app, port, &data_dir) {
            Ok(child) => {
                let pid = child.id();
                {
                    let state = app.state::<BackendState>();
                    let mut guard = state
                        .child
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    *guard = Some(child);
                }
                append_log(&data_dir, &format!("backend restarted, pid {pid}"));
                wait_until_healthy(app.clone(), port, data_dir.clone());
                if app.state::<BackendState>().shutting_down.load(Ordering::SeqCst) {
                    return;
                }                // The failure counter is only reset once the restarted backend
                // has proven it can stay up. Resetting it here instead would
                // let a backend that crashes every few seconds restart
                // forever, never reaching the give-up limit.
                if health_ok(port) {
                    failures = 0;
                }
            }
            Err(error) => {
                append_log(&data_dir, &format!("failed to restart backend: {error}"));
            }
        }
    }
}

fn resolve_port() -> u16 {
    if let Some(value) = env_value("LINGSHU_BACKEND_PORT") {
        match value.parse::<u16>() {
            Ok(port) if port > 0 => return port,
            _ => eprintln!("[backend] LINGSHU_BACKEND_PORT 无效: {value}"),
        }
    }
    DEFAULT_PORT
}

fn resolve_host() -> String {
    // The desktop GUI talks to the backend over loopback only (see
    // apiConfig.ts, which pins the Tauri runtime to http://127.0.0.1:8600).
    // Binding every interface would expose an unauthenticated HTTP API to the
    // whole LAN, so the default stays on loopback. Users who deliberately want
    // LAN access can opt in with LINGSHU_BACKEND_HOST.
    env_value("LINGSHU_BACKEND_HOST").unwrap_or_else(|| "127.0.0.1".to_string())
}

fn resolve_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = if let Some(value) = env_value("LINGSHU_DATA_DIR") {
        PathBuf::from(value)
    } else if let Ok(dir) = app.path().app_data_dir() {
        dir
    } else {
        std::env::temp_dir().join("lingshu-desktop")
    };

    fs::create_dir_all(&dir)
        .map_err(|error| format!("无法创建数据目录 {}: {error}", dir.display()))?;
    Ok(dir)
}

fn resolve_backend_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(value) = env_value("LINGSHU_BACKEND_ROOT") {
        return Ok(PathBuf::from(value));
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法解析资源目录: {error}"))?;
    Ok(resource_dir.join("backend"))
}

fn resolve_entry(root: &Path) -> Result<PathBuf, String> {
    if let Some(value) = env_value("LINGSHU_BACKEND_ENTRY") {
        let entry = PathBuf::from(value);
        if entry.is_file() {
            return Ok(entry);
        }
        return Err(format!(
            "LINGSHU_BACKEND_ENTRY 指向的文件不存在: {}",
            entry.display()
        ));
    }

    let entry = root.join("dist").join("index.js");
    if entry.is_file() {
        return Ok(entry);
    }

    if cfg!(debug_assertions) {
        Err(format!(
            "未找到内置 Node 后端: {}。开发模式请先启动 backend-node（npm run dev），或先执行 staging 脚本；也可用 LINGSHU_BACKEND_ROOT 指向已 staging 的目录",
            entry.display()
        ))
    } else {
        Err(format!("安装包缺少 Node 后端: {}", entry.display()))
    }
}

fn resolve_node(root: &Path) -> Result<PathBuf, String> {
    if let Some(value) = env_value("LINGSHU_NODE_BINARY") {
        let node = PathBuf::from(value);
        if node.is_file() {
            return Ok(node);
        }
        return Err(format!(
            "LINGSHU_NODE_BINARY 指向的文件不存在: {}",
            node.display()
        ));
    }

    let bundled_name = if cfg!(windows) { "node.exe" } else { "node" };
    let bundled = root.join("runtime").join(bundled_name);
    if bundled.is_file() {
        return Ok(bundled);
    }

    if cfg!(debug_assertions) {
        // Development convenience only: release bundles must ship runtime/node.
        return Ok(PathBuf::from(bundled_name));
    }

    Err(format!(
        "安装包缺少 Node 运行时: {}（重新执行 staging 脚本）",
        bundled.display()
    ))
}

fn configure_models(command: &mut Command, root: &Path) -> Vec<(String, PathBuf)> {
    let models = root.join("models");
    let mut configured = Vec::new();

    if let Some(asr) = find_asr_model(&models.join("asr")) {
        command.env("LINGSHU_ASR_MODEL_DIR", &asr);
        configured.push(("LINGSHU_ASR_MODEL_DIR".to_string(), asr));
    }
    let embeddings = models.join("embeddings");
    if embeddings.is_dir() {
        command.env("LINGSHU_EMBEDDING_MODEL_DIR", &embeddings);
        configured.push(("LINGSHU_EMBEDDING_MODEL_DIR".to_string(), embeddings));
    }
    let voiceprint = models.join("voiceprint");
    if voiceprint.is_dir() {
        command.env("LINGSHU_VOICEPRINT_MODEL_DIR", &voiceprint);
        configured.push(("LINGSHU_VOICEPRINT_MODEL_DIR".to_string(), voiceprint));
    }

    configured
}

fn find_asr_model(root: &Path) -> Option<PathBuf> {
    if is_asr_model_dir(root) {
        return Some(root.to_path_buf());
    }
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && is_asr_model_dir(&path) {
            return Some(path);
        }
    }
    None
}

fn is_asr_model_dir(dir: &Path) -> bool {
    if !dir.join("tokens.txt").is_file() {
        return false;
    }
    let has_encoder = ["encoder.int8.onnx", "encoder.onnx"]
        .iter()
        .any(|name| dir.join(name).is_file());
    let has_decoder = ["decoder.int8.onnx", "decoder.onnx"]
        .iter()
        .any(|name| dir.join(name).is_file());
    has_encoder && has_decoder
}

fn health_ok(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1_500)));
    let request =
        format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response.starts_with("HTTP/1.1 200") && response.contains(BACKEND_SERVICE)
}

fn open_log_streams(data_dir: &Path) -> (Stdio, Stdio) {
    let path = backend_log_path(data_dir);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(file) => match file.try_clone() {
            Ok(stderr) => (Stdio::from(file), Stdio::from(stderr)),
            Err(_) => (Stdio::from(file), Stdio::null()),
        },
        Err(error) => {
            append_log(
                data_dir,
                &format!("无法创建后端日志 {}: {error}", path.display()),
            );
            (Stdio::null(), Stdio::null())
        }
    }
}

fn backend_log_path(data_dir: &Path) -> PathBuf {
    data_dir.join("logs").join("backend.log")
}

fn append_log(data_dir: &Path, message: &str) {
    let path = data_dir.join("logs").join("backend-launcher.log");
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(
            file,
            "[{}] {message}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or(0)
        );
    }
    eprintln!("[backend] {message}");
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
