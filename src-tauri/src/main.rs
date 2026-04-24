// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_autostart::MacosLauncher;

#[derive(Serialize, Clone)]
struct OidcResult {
    code: String,
    state: String,
    redirect_uri: String,
}

/// Levanta un servidor HTTP loopback en 127.0.0.1:53682, espera UNA petición a /callback
/// y devuelve `code` y `state`. Bloquea hasta máximo 5 minutos.
#[tauri::command]
async fn oidc_start_listener(state: String) -> Result<OidcResult, String> {
    let expected_state = state;
    tauri::async_runtime::spawn_blocking(move || -> Result<OidcResult, String> {
        let server = tiny_http::Server::http("127.0.0.1:53682")
            .map_err(|e| format!("No se pudo abrir loopback :53682 — {e}"))?;

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        loop {
            if std::time::Instant::now() > deadline {
                return Err("Timeout esperando callback OIDC".into());
            }
            let timeout = std::time::Duration::from_secs(2);
            let req = match server.recv_timeout(timeout) {
                Ok(Some(r)) => r,
                Ok(None) => continue,
                Err(e) => return Err(format!("loopback err: {e}")),
            };

            let url = format!("http://127.0.0.1:53682{}", req.url());
            let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
            if parsed.path() != "/callback" {
                let _ = req.respond(tiny_http::Response::from_string("not found").with_status_code(404));
                continue;
            }

            let mut code = None;
            let mut got_state = None;
            for (k, v) in parsed.query_pairs() {
                match k.as_ref() {
                    "code" => code = Some(v.to_string()),
                    "state" => got_state = Some(v.to_string()),
                    _ => {}
                }
            }

            let body = "<html><body style=\"font-family:sans-serif;text-align:center;padding:40px\"><h2>HDS Desktop</h2><p>Sesión iniciada. Ya puedes cerrar esta ventana.</p></body></html>";
            let resp = tiny_http::Response::from_string(body)
                .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap());
            let _ = req.respond(resp);

            match (code, got_state) {
                (Some(c), Some(s)) if s == expected_state => {
                    return Ok(OidcResult {
                        code: c,
                        state: s,
                        redirect_uri: "http://127.0.0.1:53682/callback".into(),
                    });
                }
                _ => return Err("Callback inválido (state mismatch o code ausente)".into()),
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .invoke_handler(tauri::generate_handler![oidc_start_listener])
        .setup(|app| {
            // Menú del tray
            let show = MenuItem::with_id(app, "show", "Abrir HDS", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Ocultar", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("HDS Desktop")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.hide();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            let visible = win.is_visible().unwrap_or(false);
                            if visible {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // Si NO viene con --minimized, mostrar ventana al iniciar
            let args: Vec<String> = std::env::args().collect();
            if !args.iter().any(|a| a == "--minimized") {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Cerrar = ocultar a la bandeja, no salir
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
