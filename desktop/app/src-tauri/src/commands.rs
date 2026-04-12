use crate::supervisor::Supervisor;
use crate::read_auth_token;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

#[derive(Serialize)]
pub struct AppStatus {
    running: bool,
    daemora_port: Option<u16>,
    livekit_port: Option<u16>,
    auth_token: Option<String>,
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
            auth_token: None,
        }),
        None => Ok(AppStatus {
            running: false,
            daemora_port: None,
            livekit_port: None,
            auth_token: None,
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
    supervisor: State<'_, Arc<Mutex<Supervisor>>>,
) -> Result<AppStatus, String> {
    let mut sup = supervisor.lock().await;
    sup.set_vault_passphrase(passphrase);
    sup.stop_all().await;
    let state = sup.start_all().await?;
    let token = read_auth_token(sup.project_root()).await;

    // Return port + auth token to JS — JS controls navigation
    Ok(AppStatus {
        running: true,
        daemora_port: Some(state.daemora_port),
        livekit_port: Some(state.livekit_port),
        auth_token: Some(token),
    })
}

#[tauri::command]
pub async fn start_without_vault(
    supervisor: State<'_, Arc<Mutex<Supervisor>>>,
) -> Result<AppStatus, String> {
    let mut sup = supervisor.lock().await;
    sup.stop_all().await;
    let state = sup.start_all().await?;
    let token = read_auth_token(sup.project_root()).await;

    Ok(AppStatus {
        running: true,
        daemora_port: Some(state.daemora_port),
        livekit_port: Some(state.livekit_port),
        auth_token: Some(token),
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
        auth_token: None,
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
