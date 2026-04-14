//! Vault passphrase persistence via the OS keychain.
//!
//! macOS Keychain, Windows Credential Manager, Linux Secret Service. One
//! slot per install. All calls soft-fail: if the keychain is locked or
//! unavailable we log and return None so the UI can fall back to the
//! prompt. Passphrase never crosses the JS ↔ Rust boundary after the
//! initial submit — the supervisor reads it directly from here.

use keyring::Entry;
use log::{info, warn};

const SERVICE: &str = "com.daemora.app";
const ACCOUNT: &str = "vault-passphrase";

fn entry() -> Option<Entry> {
    match Entry::new(SERVICE, ACCOUNT) {
        Ok(e) => Some(e),
        Err(e) => {
            warn!("keychain: entry open failed: {e}");
            None
        }
    }
}

pub fn save(passphrase: &str) -> Result<(), String> {
    let e = entry().ok_or("keychain unavailable")?;
    e.set_password(passphrase)
        .map_err(|e| format!("keychain write failed: {e}"))?;
    info!("keychain: passphrase saved");
    Ok(())
}

pub fn load() -> Option<String> {
    let e = entry()?;
    match e.get_password() {
        Ok(p) => {
            info!("keychain: passphrase loaded");
            Some(p)
        }
        Err(keyring::Error::NoEntry) => None,
        Err(err) => {
            warn!("keychain: read failed: {err}");
            None
        }
    }
}

pub fn clear() -> Result<(), String> {
    let e = entry().ok_or("keychain unavailable")?;
    match e.delete_credential() {
        Ok(_) => {
            info!("keychain: passphrase cleared");
            Ok(())
        }
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("keychain delete failed: {err}")),
    }
}
