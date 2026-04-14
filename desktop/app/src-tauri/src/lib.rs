use std::path::PathBuf;
use std::sync::Arc;

use tauri::Manager;
use tokio::sync::Mutex;

mod commands;
mod keychain;
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

            // Services are started by the frontend now — index.html picks
            // the right unlock path (saved passphrase / prompt / skip)
            // and invokes the matching command. This lets us pass
            // VAULT_PASSPHRASE to Daemora's first spawn instead of
            // starting without secrets and then restarting.
            let _ = handle;

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
            commands::has_saved_passphrase,
            commands::unlock_with_saved,
            commands::clear_saved_passphrase,
        ])
        .run(tauri::generate_context!())
        .expect("error running daemora desktop");
}
