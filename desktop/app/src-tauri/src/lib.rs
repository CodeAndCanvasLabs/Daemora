use std::path::PathBuf;
use std::sync::Arc;

use log::{error, info};
use tauri::Manager;
use tokio::sync::Mutex;

mod commands;
mod supervisor;
mod tray;

fn find_project_root() -> PathBuf {
    if let Ok(root) = std::env::var("DAEMORA_PROJECT_ROOT") {
        let p = PathBuf::from(&root);
        if p.join("src").join("index.js").exists() {
            return p;
        }
    }
    let exe = std::env::current_exe().unwrap_or_default();
    let mut dir = exe.parent().unwrap_or(&exe).to_path_buf();
    for _ in 0..15 {
        if dir.join("src").join("index.js").exists() { return dir; }
        if let Some(parent) = dir.parent() { dir = parent.to_path_buf(); } else { break; }
    }
    let mut dir = std::env::current_dir().unwrap_or_default();
    for _ in 0..10 {
        if dir.join("src").join("index.js").exists() { return dir; }
        if let Some(parent) = dir.parent() { dir = parent.to_path_buf(); } else { break; }
    }
    std::env::current_dir().unwrap_or_default()
}

pub async fn read_auth_token(project_root: &PathBuf) -> String {
    let path = project_root.join("data").join("auth-token");
    tokio::fs::read_to_string(&path).await.unwrap_or_default().trim().to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(Mutex::new(supervisor::Supervisor::new(
            find_project_root(),
        ))))
        .setup(|app| {
            let handle = app.handle().clone();

            // Show splash immediately
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
            }

            // Start Daemora immediately (no IPC needed)
            // Vault unlock happens later via web API
            tauri::async_runtime::spawn(async move {
                let sup_state = handle.state::<Arc<Mutex<supervisor::Supervisor>>>();
                let mut sup = sup_state.lock().await;

                info!("starting daemora + livekit...");
                match sup.start_all().await {
                    Ok(state) => {
                        let url = format!("http://127.0.0.1:{}", state.daemora_port);
                        info!("navigating to {}", url);
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.navigate(url.parse().unwrap());
                            let _ = w.set_focus();
                        }
                    }
                    Err(e) => {
                        error!("failed to start: {e}");
                        if let Some(w) = handle.get_webview_window("main") {
                            let escaped = e.replace('\'', "\\'");
                            let _ = w.eval(&format!(
                                "document.body.innerHTML='<div style=\"display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0f1a;color:#ff4444;font-family:monospace;text-align:center\"><div><h2 style=\"color:#00d9ff\">Daemora</h2><p>Failed to start: {escaped}</p></div></div>';"
                            ));
                        }
                    }
                }
            });

            tray::setup_tray(&app.handle())
                .map_err(|e| format!("tray setup failed: {e}"))?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::check_vault,
            commands::submit_passphrase,
            commands::start_without_vault,
            commands::restart_services,
            commands::stop_services,
            commands::get_daemora_url,
        ])
        .run(tauri::generate_context!())
        .expect("error running daemora desktop");
}
