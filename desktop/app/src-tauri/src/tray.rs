use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    AppHandle, Manager,
};

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItemBuilder::with_id("show", "Show Daemora").build(app)?;
    let voice = MenuItemBuilder::with_id("voice_toggle", "Toggle Voice").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings").build(app)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .item(&voice)
        .item(&sep)
        .item(&settings)
        .item(&sep)
        .item(&quit)
        .build()?;

    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_menu(Some(menu))?;

        tray.on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "voice_toggle" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval("window.__daemora_toggle_voice?.()");
                }
            }
            "settings" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval("window.__daemora_open_settings?.()");
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        });

        tray.on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    if w.is_visible().unwrap_or(false) {
                        let _ = w.hide();
                    } else {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            }
        });
    }

    Ok(())
}
