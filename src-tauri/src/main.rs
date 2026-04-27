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

// Estado global del listener OIDC: servidor + puerto + state esperado.
struct OidcSession {
    server: std::sync::Arc<tiny_http::Server>,
    redirect_uri: String,
    expected_state: String,
}
static OIDC_SERVER: std::sync::Mutex<Option<OidcSession>> = std::sync::Mutex::new(None);

// Puertos candidatos para el loopback del callback OIDC.
// Windows reserva rangos enteros (Hyper-V / WinNAT / Docker / WSL2) y devuelve
// WSAEACCES (os error 10013) al intentar bind, sin que haya proceso escuchando.
// Probamos varios; TODOS deben estar registrados como Valid Redirect URI en Keycloak
// (o usar wildcard `http://127.0.0.1/*` en realms permisivos).
const OIDC_CANDIDATE_PORTS: &[u16] = &[53682, 47823, 38421, 28394, 18475, 8765];

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
async fn oidc_start_listener(state: String) -> Result<String, String> {
    // Bind síncrono: devolvemos el redirect_uri elegido para que JS construya
    // la URL de autorización con el puerto correcto antes de abrir el navegador.
    let expected_state = state;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        // Cerrar listener anterior si quedó vivo (intento previo cancelado).
        {
            let mut guard = OIDC_SERVER.lock().unwrap();
            if let Some(prev) = guard.take() {
                prev.server.unblock();
                drop(prev);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(150));

        // Probar puertos candidatos. En Windows muchos puertos están reservados
        // por Hyper-V/WinNAT/Docker (WSAEACCES = os error 10013) sin proceso
        // escuchando, así que recorremos una lista hasta encontrar uno libre.
        let mut last_err = String::new();
        let mut bound_port: u16 = 0;
        let server = OIDC_CANDIDATE_PORTS
            .iter()
            .find_map(|&port| {
                let listener = match bind_reuse(port) {
                    Ok(l) => l,
                    Err(e) => {
                        last_err = format!("puerto {port}: {e}");
                        log_line(&format!("oidc: bind {port} falló — {e}"));
                        return None;
                    }
                };
                match tiny_http::Server::from_listener(listener, None) {
                    Ok(s) => {
                        bound_port = port;
                        Some(s)
                    }
                    Err(e) => {
                        last_err = format!("puerto {port}: {e}");
                        None
                    }
                }
            })
            .ok_or_else(|| {
                let ports = OIDC_CANDIDATE_PORTS
                    .iter()
                    .map(|p| p.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "No se pudo abrir ningún puerto loopback de la lista [{ports}] — \
                     último error: {last_err}. En Windows esto suele deberse a rangos \
                     reservados por Hyper-V/WinNAT/Docker/WSL2 (no a un proceso ocupándolos). \
                     Diagnóstico: ejecuta en PowerShell como admin \
                     'netsh interface ipv4 show excludedportrange protocol=tcp' \
                     y registra en Keycloak un puerto fuera de esos rangos como Valid Redirect URI."
                )
            })?;

        let redirect_uri = format!("http://127.0.0.1:{bound_port}/callback");
        log_line(&format!("oidc: escuchando en {redirect_uri}"));

        let session = OidcSession {
            server: std::sync::Arc::new(server),
            redirect_uri: redirect_uri.clone(),
            expected_state,
        };
        *OIDC_SERVER.lock().unwrap() = Some(session);
        Ok(redirect_uri)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn oidc_await_callback() -> Result<OidcResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<OidcResult, String> {
        // Tomamos handles del estado global; el server queda referenciado por Arc.
        let (server, redirect_uri, expected_state) = {
            let guard = OIDC_SERVER.lock().unwrap();
            let s = guard
                .as_ref()
                .ok_or_else(|| "Listener OIDC no inicializado".to_string())?;
            (s.server.clone(), s.redirect_uri.clone(), s.expected_state.clone())
        };

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

            let url_str = format!("{}{}", redirect_uri.trim_end_matches("/callback"), req.url());
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
                    redirect_uri: redirect_uri.clone(),
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

#[tauri::command]
async fn oidc_refresh_token(
    token_url: String,
    client_id: String,
    refresh_token: String,
) -> Result<OidcTokens, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("reqwest build: {e}"))?;

    let form = [
        ("grant_type", "refresh_token"),
        ("client_id", client_id.as_str()),
        ("refresh_token", refresh_token.as_str()),
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
        log_line(&format!("Token refresh fallo status={status} body={body}"));
        return Err(format!("Keycloak rechazo el refresh (status {status}): {body}"));
    }

    serde_json::from_str::<OidcTokens>(&body)
        .map_err(|e| format!("Respuesta invalida de Keycloak (refresh): {e} — body: {body}"))
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
        .invoke_handler(tauri::generate_handler![oidc_start_listener, oidc_await_callback, oidc_exchange_code, oidc_refresh_token])
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

    // Garantizamos liberar el puerto del callback al salir, aunque el SO
    // normalmente lo libera, esto evita TIME_WAIT prolongado tras un quit explicito.
    app.run(|_app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            if let Ok(mut guard) = OIDC_SERVER.lock() {
                if let Some(prev) = guard.take() {
                    prev.server.unblock();
                    drop(prev);
                    log_line("Listener OIDC liberado en shutdown");
                }
            }
        }
    });
}
