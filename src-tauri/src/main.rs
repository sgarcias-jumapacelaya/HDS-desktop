// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::io::Write;
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

#[derive(Serialize, Deserialize, Clone)]
struct OidcTokens {
    access_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: u64,
}

fn log_path() -> std::path::PathBuf {
    if let Some(home) = dirs_next::home_dir() {
        home.join(".hds-desktop.log")
    } else {
        std::path::PathBuf::from("hds-desktop.log")
    }
}

fn log_line(msg: &str) {
    let p = log_path();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
    {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {msg}");
    }
    eprintln!("{msg}");
}

// Listener OIDC actual; al recibir un nuevo intento de login, cerramos el anterior
// (releasando el puerto 53682) antes de abrir uno nuevo.
static OIDC_SERVER: std::sync::Mutex<Option<std::sync::Arc<tiny_http::Server>>> =
    std::sync::Mutex::new(None);

/// Bind 127.0.0.1:port con SO_REUSEADDR (y SO_REUSEPORT en Unix) para
/// poder reusar puertos en TIME_WAIT o tras un cierre sucio del proceso anterior.
fn bind_reuse(port: u16) -> std::io::Result<std::net::TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let sock = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
    sock.set_reuse_address(true)?;
    #[cfg(unix)]
    {
        let _ = sock.set_reuse_port(true);
    }
    let addr: std::net::SocketAddr = ([127, 0, 0, 1], port).into();
    sock.bind(&addr.into())?;
    sock.listen(128)?;
    Ok(sock.into())
}

#[tauri::command]
async fn oidc_start_listener(state: String) -> Result<OidcResult, String> {
    let expected_state = state;
    tauri::async_runtime::spawn_blocking(move || -> Result<OidcResult, String> {
        // Cerrar listener anterior si quedó vivo (intento previo cancelado).
        {
            let mut guard = OIDC_SERVER.lock().unwrap();
            if let Some(prev) = guard.take() {
                prev.unblock(); // tiny_http: detiene el accept loop
                drop(prev);
            }
        }
        // Pequeña espera a que el SO libere el puerto en TIME_WAIT.
        std::thread::sleep(std::time::Duration::from_millis(150));

        // Reintentos de bind por si el TIME_WAIT tarda. Usamos SO_REUSEADDR
        // para evitar el típico EADDRINUSE tras un cierre brusco previo.
        let mut last_err = String::new();
        let server = (0..10)
            .find_map(|i| {
                let listener = match bind_reuse(53682) {
                    Ok(l) => l,
                    Err(e) => {
                        last_err = format!("{e}");
                        std::thread::sleep(std::time::Duration::from_millis(150 * (i + 1)));
                        return None;
                    }
                };
                match tiny_http::Server::from_listener(listener, None) {
                    Ok(s) => Some(s),
                    Err(e) => {
                        last_err = format!("{e}");
                        std::thread::sleep(std::time::Duration::from_millis(150 * (i + 1)));
                        None
                    }
                }
            })
            .ok_or_else(|| {
                format!(
                    "No se pudo abrir loopback :53682 — {last_err}. \
                     Cierra otras instancias de HDS Desktop o ejecuta: \
                     'sudo fuser -k 53682/tcp' (Linux) / \
                     'Get-NetTCPConnection -LocalPort 53682 | %{{Stop-Process -Id $_.OwningProcess -Force}}' (Windows)."
                )
            })?;

        let server = std::sync::Arc::new(server);
        *OIDC_SERVER.lock().unwrap() = Some(server.clone());

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        let result: Result<OidcResult, String> = loop {
            if std::time::Instant::now() > deadline {
                break Err("Tiempo de espera agotado para el callback OIDC".into());
            }
            let req = match server.recv_timeout(std::time::Duration::from_secs(2)) {
                Ok(Some(r)) => r,
                Ok(None) => continue,
                Err(e) => break Err(format!("Error en loopback — {e}")),
            };

            let url_str = format!("http://127.0.0.1:53682{}", req.url());
            let parsed = match url::Url::parse(&url_str) {
                Ok(u) => u,
                Err(e) => break Err(format!("URL inválida — {e}")),
            };
            let mut code: Option<String> = None;
            let mut got_state: Option<String> = None;
            for (k, v) in parsed.query_pairs() {
                if k == "code" {
                    code = Some(v.into_owned());
                } else if k == "state" {
                    got_state = Some(v.into_owned());
                }
            }

            let body = "<html><body style='font-family:sans-serif;padding:24px'><h2>Listo ✓</h2><p>Ya puedes cerrar esta ventana y volver a HDS Desktop.</p></body></html>";
            let resp = tiny_http::Response::from_string(body)
                .with_header("Content-Type: text/html; charset=utf-8".parse::<tiny_http::Header>().unwrap());
            let _ = req.respond(resp);

            break match (code, got_state) {
                (Some(c), Some(s)) if s == expected_state => Ok(OidcResult {
                    code: c,
                    state: s,
                    redirect_uri: "http://127.0.0.1:53682/callback".into(),
                }),
                _ => Err("Callback inválido (state mismatch o code ausente)".into()),
            };
        };
        // Siempre liberar el slot global, ocupó el puerto o no.
        *OIDC_SERVER.lock().unwrap() = None;
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn oidc_exchange_code(
    token_url: String,
    client_id: String,
    code: String,
    redirect_uri: String,
    code_verifier: String,
) -> Result<OidcTokens, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("reqwest build: {e}"))?;

    let form = [
        ("grant_type", "authorization_code"),
        ("client_id", client_id.as_str()),
        ("code", code.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("code_verifier", code_verifier.as_str()),
    ];

    let res = client
        .post(&token_url)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Error de red contra Keycloak ({token_url}): {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        log_line(&format!(
            "Token exchange fallo status={status} body={body}"
        ));
        return Err(format!(
            "Keycloak rechazo el code (status {status}): {body}"
        ));
    }

    serde_json::from_str::<OidcTokens>(&body)
        .map_err(|e| format!("Respuesta invalida de Keycloak: {e} — body: {body}"))
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Abrir HDS", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Ocultar", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("HDS Desktop")
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
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        log_line(&format!("PANIC: {info}"));
    }));

    log_line(&format!(
        "HDS Desktop iniciando v{} args={:?}",
        env!("CARGO_PKG_VERSION"),
        std::env::args().collect::<Vec<_>>()
    ));

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .invoke_handler(tauri::generate_handler![oidc_start_listener, oidc_exchange_code])
        .setup(|app| {
            log_line("setup() invocado");

            let args: Vec<String> = std::env::args().collect();
            let minimized = args.iter().any(|a| a == "--minimized");
            if let Some(win) = app.get_webview_window("main") {
                if minimized {
                    let _ = win.hide();
                } else {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            } else {
                log_line("WARN: no se encontró webview 'main'");
            }

            match build_tray(app.handle()) {
                Ok(_) => log_line("Tray creado OK"),
                Err(e) => log_line(&format!("WARN: no se pudo crear tray — {e}")),
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!());

    let app = match result {
        Ok(a) => a,
        Err(e) => {
            log_line(&format!("FATAL al arrancar Tauri: {e}"));
            std::process::exit(1);
        }
    };

    // Garantizamos liberar el puerto 53682 al salir, aunque el SO normalmente
    // lo libera, esto evita TIME_WAIT prolongado tras un quit explicito.
    app.run(|_app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            if let Ok(mut guard) = OIDC_SERVER.lock() {
                if let Some(prev) = guard.take() {
                    prev.unblock();
                    drop(prev);
                    log_line("Listener OIDC liberado en shutdown");
                }
            }
        }
    });
}
