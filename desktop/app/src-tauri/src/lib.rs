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
        if dir.join("src").join("index.js").exists() {
            return dir;
        }
        if let Some(parent) = dir.parent() {
            dir = parent.to_path_buf();
        } else {
            break;
        }
    }

    let mut dir = std::env::current_dir().unwrap_or_default();
    for _ in 0..10 {
        if dir.join("src").join("index.js").exists() {
            return dir;
        }
        if let Some(parent) = dir.parent() {
            dir = parent.to_path_buf();
        } else {
            break;
        }
    }

    std::env::current_dir().unwrap_or_default()
}

pub fn inject_config_and_reload(w: &tauri::WebviewWindow, state: &supervisor::ProcessState, _auth_token: &str) {
    let url = format!("http://127.0.0.1:{}", state.daemora_port);
    info!("navigating webview to {}", url);
    let _ = w.navigate(url.parse().unwrap());
    let _ = w.set_focus();
}

pub fn show_error(w: &tauri::WebviewWindow, msg: &str) {
    let escaped = msg.replace('\'', "\\'");
    let js = format!(
        "document.getElementById('status').textContent='Failed: {escaped}';\
         document.getElementById('status').style.color='#ff4444';\
         document.getElementById('dots').style.display='none';"
    );
    let _ = w.eval(&js);
}

pub async fn read_auth_token(project_root: &PathBuf) -> String {
    let path = project_root.join("data").join("auth-token");
    tokio::fs::read_to_string(&path)
        .await
        .unwrap_or_default()
        .trim()
        .to_string()
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

            // Show the splash page (simple HTML, no React)
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
            }

            tauri::async_runtime::spawn(async move {
                let sup_state = handle.state::<Arc<Mutex<supervisor::Supervisor>>>();
                let vault_exists = {
                    let sup = sup_state.lock().await;
                    sup.vault_exists()
                };

                if vault_exists {
                    info!("vault detected — showing passphrase input");
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.eval("window.__daemora_show_passphrase()");
                    }
                } else {
                    info!("no vault — starting services directly");
                    let mut sup = sup_state.lock().await;
                    match sup.start_all().await {
                        Ok(state) => {
                            info!("services started on port {}", state.daemora_port);
                            let token = read_auth_token(sup.project_root()).await;
                            if let Some(w) = handle.get_webview_window("main") {
                                inject_config_and_reload(&w, &state, &token);
                            }
                        }
                        Err(e) => {
                            error!("failed to start: {e}");
                            if let Some(w) = handle.get_webview_window("main") {
                                show_error(&w, &e);
                            }
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
