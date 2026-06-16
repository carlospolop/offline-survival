use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let backend_child: BackendChild = Arc::new(Mutex::new(None));
    let setup_backend_child = backend_child.clone();
    let shutdown_backend_child = backend_child.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            let resource_dir = app
                .path()
                .resource_dir()
                .expect("failed to resolve bundled resource directory");
            let backend = resource_dir.join("_up_").join("backend").join("server.mjs");
            let catalog_root = resource_dir.join("_up_").join("_up_");
            let backend_port = reserve_backend_port().expect("failed to reserve backend port");
            let backend_token = backend_token();
            let (mut rx, child) = app
                .shell()
                .sidecar("sca-node")?
                .args([
                    "--experimental-sqlite".to_string(),
                    backend.to_string_lossy().to_string(),
                ])
                .current_dir(catalog_root)
                .env("PORT", backend_port.to_string())
                .env("SCA_BACKEND_TOKEN", backend_token.clone())
                .env("SCA_PACKAGED", "1")
                .env(
                    "SCA_RESOURCE_DIR",
                    resource_dir.to_string_lossy().to_string(),
                )
                .env(
                    "SCA_SIDECAR_DIR",
                    resource_dir
                        .join("..")
                        .join("bin")
                        .to_string_lossy()
                        .to_string(),
                )
                .spawn()?;
            *setup_backend_child
                .lock()
                .expect("backend child lock poisoned") = Some(child);
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let tauri_plugin_shell::process::CommandEvent::Stderr(line) = event {
                        eprintln!("{}", String::from_utf8_lossy(&line));
                    }
                }
            });
            if let Some(window) = app.get_webview_window("main") {
                inject_backend_config(&window, backend_port, &backend_token);
                tauri::async_runtime::spawn(async move {
                    inject_backend_config(&window, backend_port, &backend_token);
                    wait_for_backend(backend_port, &backend_token);
                    inject_backend_config(&window, backend_port, &backend_token);
                    if let Err(error) = window.show() {
                        eprintln!("failed to show main window: {error}");
                    }
                    if let Err(error) = window.set_focus() {
                        eprintln!("failed to focus main window: {error}");
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Offline Survival")
        .run(move |_app, event| match event {
            RunEvent::Exit | RunEvent::ExitRequested { .. } => {
                kill_backend_child(&shutdown_backend_child);
            }
            RunEvent::WindowEvent { label, event, .. }
                if label == "main"
                    && matches!(
                        event,
                        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                    ) =>
            {
                kill_backend_child(&shutdown_backend_child);
            }
            _ => {}
        });
}

fn main() {
    run();
}

type BackendChild = Arc<Mutex<Option<CommandChild>>>;

fn kill_backend_child(child: &BackendChild) {
    let Some(child) = child.lock().expect("backend child lock poisoned").take() else {
        return;
    };
    if let Err(error) = child.kill() {
        eprintln!("failed to stop backend sidecar: {error}");
    }
}

fn reserve_backend_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn backend_token() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{}-{millis}", process::id())
}

fn inject_backend_config(window: &tauri::WebviewWindow, port: u16, token: &str) {
    let script = format!(
        "window.__SCA_API_PORT = {port}; window.__SCA_API_TOKEN = {token:?}; window.dispatchEvent(new CustomEvent('sca-backend-configured'));"
    );
    if let Err(error) = window.eval(&script) {
        eprintln!("failed to inject backend config: {error}");
    }
}

fn wait_for_backend(port: u16, token: &str) {
    for _ in 0..80 {
        if backend_is_ready(port, token) {
            return;
        }
        std::thread::sleep(Duration::from_millis(125));
    }
}

fn backend_is_ready(port: u16, token: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .expect("valid backend address"),
        Duration::from_millis(200),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-SCA-Backend-Token: {token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = [0_u8; 512];
    match stream.read(&mut response) {
        Ok(count) => {
            let body = String::from_utf8_lossy(&response[..count]);
            body.contains("200 OK") && body.contains(token)
        }
        Err(_) => false,
    }
}
