use std::path::PathBuf;
use std::time::Duration;

use log::{info, warn};
use tokio::process::{Child, Command};
use tokio::time::sleep;

fn resolve_bin(name: &str) -> PathBuf {
    let extra_paths = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/opt/homebrew/sbin",
        "/usr/local/sbin",
    ];
    if let Ok(p) = which::which(name) {
        return p;
    }
    for dir in &extra_paths {
        let p = PathBuf::from(dir).join(name);
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(name)
}

fn full_path_env() -> String {
    let extra = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/sbin:/usr/local/sbin";
    match std::env::var("PATH") {
        Ok(existing) => format!("{extra}:{existing}"),
        Err(_) => extra.to_string(),
    }
}

#[derive(Clone)]
pub struct ProcessState {
    pub daemora_port: u16,
    pub livekit_port: u16,
}

pub struct Supervisor {
    daemora: Option<Child>,
    livekit: Option<Child>,
    state: Option<ProcessState>,
    project_root: PathBuf,
    vault_passphrase: Option<String>,
}

impl Supervisor {
    pub fn new(project_root: PathBuf) -> Self {
        // Preload saved passphrase from OS keychain so services can spawn
        // without re-prompting on app restart or sleep-wake.
        let vault_passphrase = crate::keychain::load();
        if vault_passphrase.is_some() {
            info!("supervisor: vault passphrase loaded from keychain");
        }
        Self {
            daemora: None,
            livekit: None,
            state: None,
            project_root,
            vault_passphrase,
        }
    }

    pub fn has_passphrase(&self) -> bool {
        self.vault_passphrase.is_some()
    }

    pub fn state(&self) -> Option<&ProcessState> {
        self.state.as_ref()
    }

    pub fn project_root(&self) -> &PathBuf {
        &self.project_root
    }

    pub fn vault_exists(&self) -> bool {
        let db_path = self.project_root.join("data").join("daemora.db");
        db_path.exists()
    }

    pub fn set_vault_passphrase(&mut self, passphrase: String) {
        self.vault_passphrase = Some(passphrase);
    }

    pub async fn start_all(&mut self) -> Result<ProcessState, String> {
        let daemora_port = portpicker::pick_unused_port().ok_or("no free port for daemora")?;
        let livekit_port = 7880u16;

        // Kill stale sidecar from previous runs (Daemora manages its own sidecar)
        kill_stale_process_on_port(8765).await;
        // Also pkill by process name in case it's on a different port
        let _ = tokio::process::Command::new("pkill")
            .args(["-9", "-f", "daemora_sidecar"])
            .output()
            .await;

        self.start_livekit(livekit_port).await?;
        self.start_daemora(daemora_port, livekit_port).await?;

        let state = ProcessState {
            daemora_port,
            livekit_port,
        };
        self.state = Some(state.clone());

        info!(
            "supervisor: all processes started (daemora:{}, livekit:{})",
            daemora_port, livekit_port
        );

        Ok(state)
    }

    async fn start_livekit(&mut self, port: u16) -> Result<(), String> {
        if is_port_open(port).await {
            info!("supervisor: livekit already running on {}", port);
            return Ok(());
        }

        let livekit_bin = find_livekit_binary();
        if livekit_bin.is_none() {
            warn!("supervisor: livekit-server not found, voice may not work");
            return Ok(());
        }

        let child = Command::new(livekit_bin.unwrap())
            .arg("--dev")
            .arg("--bind")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to spawn livekit: {e}"))?;

        self.livekit = Some(child);
        wait_for_port(port, Duration::from_secs(10)).await?;
        info!("supervisor: livekit started on {}", port);
        Ok(())
    }

    async fn start_daemora(&mut self, port: u16, livekit_port: u16) -> Result<(), String> {
        let index_path = self.project_root.join("src").join("index.js");
        if !index_path.exists() {
            return Err(format!("daemora not found at {}", index_path.display()));
        }

        let node_bin = resolve_bin("node");
        info!("supervisor: node={}, entry={}", node_bin.display(), index_path.display());

        let mut cmd = Command::new(&node_bin);
        cmd.arg(&index_path)
            .env("PORT", port.to_string())
            .env("DAEMON_MODE", "true")
            .env("PATH", full_path_env())
            // LiveKit env so Daemora's sidecar supervisor uses the right server
            .env("LIVEKIT_URL", format!("ws://127.0.0.1:{livekit_port}"))
            .env("LIVEKIT_API_KEY", "devkey")
            .env("LIVEKIT_API_SECRET", "secret")
            // WKWebView plays WebRTC audio natively once startAudio() has
            // been called from a user gesture (handled in VoicePanel.tsx).
            // The sidecar's local-speaker fallback is kept off by default —
            // flip DAEMORA_LOCAL_SPEAKER=1 only if a future WKWebView
            // regression breaks native playback again.
            .current_dir(&self.project_root)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        if let Some(ref passphrase) = self.vault_passphrase {
            cmd.env("VAULT_PASSPHRASE", passphrase);
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn daemora (node={}): {e}", node_bin.display()))?;

        self.daemora = Some(child);
        wait_for_port(port, Duration::from_secs(30)).await?;
        info!("supervisor: daemora started on {}", port);
        Ok(())
    }

    pub async fn stop_all(&mut self) {
        if let Some(mut child) = self.daemora.take() {
            info!("supervisor: stopping daemora");
            let _ = child.kill().await;
        }
        if let Some(mut child) = self.livekit.take() {
            info!("supervisor: stopping livekit");
            let _ = child.kill().await;
        }
        // Kill any orphaned sidecar processes (daemora_sidecar module)
        let _ = tokio::process::Command::new("pkill")
            .args(["-9", "-f", "daemora_sidecar"])
            .output()
            .await;
        self.state = None;
    }
}

fn find_livekit_binary() -> Option<PathBuf> {
    let candidates = [
        "livekit-server",
        "/opt/homebrew/bin/livekit-server",
        "/usr/local/bin/livekit-server",
    ];
    for c in &candidates {
        let p = PathBuf::from(c);
        if p.exists() || which::which(c).is_ok() {
            return Some(p);
        }
    }
    None
}

async fn kill_stale_process_on_port(port: u16) {
    if !is_port_open(port).await {
        return;
    }
    info!("supervisor: killing stale process on port {}", port);
    let _ = tokio::process::Command::new("lsof")
        .args(["-ti", &format!(":{port}")])
        .output()
        .await
        .map(|o| {
            let pids = String::from_utf8_lossy(&o.stdout);
            for pid in pids.split_whitespace() {
                if let Ok(p) = pid.parse::<i32>() {
                    unsafe { libc::kill(p, 9); }
                }
            }
        });
    sleep(Duration::from_millis(500)).await;
}

async fn is_port_open(port: u16) -> bool {
    tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .is_ok()
}

async fn wait_for_port(port: u16, timeout: Duration) -> Result<(), String> {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if is_port_open(port).await {
            return Ok(());
        }
        sleep(Duration::from_millis(250)).await;
    }
    Err(format!("port {} not ready after {:?}", port, timeout))
}
