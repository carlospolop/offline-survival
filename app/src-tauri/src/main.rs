use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let resource_dir = app
                .path()
                .resource_dir()
                .expect("failed to resolve bundled resource directory");
            let backend = resource_dir.join("_up_").join("backend").join("server.mjs");
            let catalog_root = resource_dir.join("_up_").join("_up_");
            let (mut rx, child) = app
                .shell()
                .sidecar("sca-node")?
                .args([backend.to_string_lossy().to_string()])
                .current_dir(catalog_root)
                .env("PORT", "8787")
                .env("SCA_PACKAGED", "1")
                .env("SCA_SIDECAR_DIR", resource_dir.join("..").join("bin").to_string_lossy().to_string())
                .spawn()?;
            std::mem::forget(child);
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let tauri_plugin_shell::process::CommandEvent::Stderr(line) = event {
                        eprintln!("{}", String::from_utf8_lossy(&line));
                    }
                }
            });
            if let Some(window) = app.get_webview_window("main") {
                tauri::async_runtime::spawn(async move {
                    wait_for_backend();
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
        .run(tauri::generate_context!())
        .expect("error while running Offline Survival");
}

fn main() {
    run();
}

fn wait_for_backend() {
    for _ in 0..80 {
        if backend_is_ready() {
            return;
        }
        std::thread::sleep(Duration::from_millis(125));
    }
}

fn backend_is_ready() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &"127.0.0.1:8787".parse().expect("valid backend address"),
        Duration::from_millis(200),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let request = b"GET /api/catalog HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nConnection: close\r\n\r\n";
    if stream.write_all(request).is_err() {
        return false;
    }
    let mut response = [0_u8; 64];
    match stream.read(&mut response) {
        Ok(count) => String::from_utf8_lossy(&response[..count]).contains("200 OK"),
        Err(_) => false,
    }
}
