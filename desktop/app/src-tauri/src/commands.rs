use crate::supervisor::Supervisor;
use crate::read_auth_token;
use crate::inject_config_and_reload;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

#[derive(Serialize)]
pub struct AppStatus {
    running: bool,
    daemora_port: Option<u16>,
    livekit_port: Option<u16>,
}

#[tauri::command]
pub async fn get_status(
    supervisor: State<'_, Arc<Mutex<Supervisor>>>,
) -> Result<AppStatus, String> {
    let sup = supervisor.lock().await;
    match sup.state() {
        Some(s) => Ok(AppStatus {
            running: true,
            daemora_port: Some(s.daemora_port),
            livekit_port: Some(s.livekit_port),
        }),
        None => Ok(AppStatus {
            running: false,
            daemora_port: None,
            livekit_port: None,
        }),
    }
}

#[tauri::command]
pub async fn check_vault(
    supervisor: State<'_, Arc<Mutex<Supervisor>>>,
) -> Result<bool, String> {
    let sup = supervisor.lock().await;
    Ok(sup.vault_exists())
}

#[tauri::command]
pub async fn submit_passphrase(
    passphrase: String,
    app: AppHandle,
    supervisor: State<'_, Arc<Mutex<Supervisor>>>,
) -> Result<AppStatus, String> {
    let mut sup = supervisor.lock().await;
    sup.set_vault_passphrase(passphrase);
    sup.stop_all().await;
    let state = sup.start_all().await?;
    let token = read_auth_token(sup.project_root()).await;

    if let Some(w) = app.get_webview_window("main") {
        inject_config_and_reload(&w, &state, &token);
    }

    Ok(AppStatus {
        running: true,
        daemora_port: Some(state.daemora_port),
        livekit_port: Some(state.livekit_port),
    })
}

#[tauri::command]
pub async fn start_without_vault(
    app: AppHandle,
    supervisor: State<'_, Arc<Mutex<Supervisor>>>,
) -> Result<AppStatus, String> {
    let mut sup = supervisor.lock().await;
    sup.stop_all().await;
    let state = sup.start_all().await?;
    let token = read_auth_token(sup.project_root()).await;

    if let Some(w) = app.get_webview_window("main") {
        inject_config_and_reload(&w, &state, &token);
    }

    Ok(AppStatus {
        running: true,
        daemora_port: Some(state.daemora_port),
        livekit_port: Some(state.livekit_port),
    })
}

#[tauri::command]
pub async fn restart_services(
    supervisor: State<'_, Arc<Mutex<Supervisor>>>,
) -> Result<AppStatus, String> {
    let mut sup = supervisor.lock().await;
    sup.stop_all().await;
    let state = sup.start_all().await?;
    Ok(AppStatus {
        running: true,
        daemora_port: Some(state.daemora_port),
        livekit_port: Some(state.livekit_port),
    })
}

#[tauri::command]
pub async fn stop_services(
    supervisor: State<'_, Arc<Mutex<Supervisor>>>,
) -> Result<(), String> {
    let mut sup = supervisor.lock().await;
    sup.stop_all().await;
    Ok(())
}

#[tauri::command]
pub async fn get_daemora_url(
    supervisor: State<'_, Arc<Mutex<Supervisor>>>,
) -> Result<String, String> {
    let sup = supervisor.lock().await;
    match sup.state() {
        Some(s) => Ok(format!("http://127.0.0.1:{}", s.daemora_port)),
        None => Err("daemora not running".into()),
    }
}
