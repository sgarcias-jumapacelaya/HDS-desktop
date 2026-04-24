# HDS Desktop

Cliente de escritorio (Tauri 2 + React + TS) para HDS:

- Icono en la bandeja del sistema con badge de notificaciones
- Cambio rápido de estado de tickets (Tomar / Espera / Resolver)
- Time tracking por fase: espera, proceso, cierre
- Notificaciones nativas (polling cada 30s, WebSocket en fase 2)
- Autostart al inicio de sesión
- Cerrar = oculta a la bandeja

## Estructura

```
desktop/
  src/             # UI React (TS)
  src-tauri/       # Backend nativo (Rust)
  package.json
  vite.config.ts
```

## Requisitos

- Node 20+
- Rust toolchain (rustup) — Tauri 2 lo necesita para `tauri:dev` / `tauri:build`
- Linux: `libwebkit2gtk-4.1-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`
- Windows: WebView2 Runtime (ya viene en Win11)

## Setup

```bash
cd desktop
cp .env.example .env
npm install
npm run tauri:dev      # desarrollo con hot reload
npm run tauri:build    # genera instalador (deb/appimage/msi)
```

## Variables (.env)

| Var | Descripción |
| --- | --- |
| `VITE_API_BASE` | URL base del backend HDS (ej. `https://hds.jumapa.in`) |
| `VITE_KEYCLOAK_URL` | URL Keycloak (fase 2 OIDC) |
| `VITE_KEYCLOAK_REALM` | Realm Keycloak |
| `VITE_KEYCLOAK_CLIENT_ID` | Client ID OIDC público para desktop |
| `VITE_POLL_INTERVAL_MS` | Intervalo de polling de notificaciones (ms) |
| `VITE_FOCUS_WINDOW_MS` | Ventana de agrupamiento de toasts (ms) |
| `VITE_FOCUS_GROUP_THRESHOLD` | A partir de cuántas notifs se agrupan en un solo toast |
| `VITE_QUIET_HOURS` | Horas silenciosas, formato `HH-HH` (ej. `22-7`). Vacío = off |
| `VITE_IDLE_AUTO_PAUSE_MS` | Tiempo de inactividad antes de pausar el tracker (0 = off) |

## Roadmap MVP → Fase 2

**MVP (esta versión):**
- Login Keycloak (Authorization Code + PKCE) con loopback en `127.0.0.1:53682`
- Login manual por token (fallback)
- Lista de mis tickets (`GET /tickets/mine`) + cambio de estado respetando workflow
- Time tracker manual con fases `espera|proceso|cierre` → `POST /tickets/{id}/time`
- Notificaciones realtime por **WebSocket** (`/notifications/ws`) con polling de respaldo
- **Modo focus**: agrupa toasts cercanos en uno solo y respeta horas silenciosas
- Time tracker con **auto-pausa por inactividad** (configurable) y pausa/reanudar manual
- **Chat por ticket** entre staff (developers/admins) — REST + WebSocket
  - `GET/POST /tickets/{id}/chat`
  - `WS /tickets/{id}/chat/ws`

**Fase 2:**
- Refresh token automático (Keycloak)
- Menciones @usuario y reacciones en chat
- Reglas avanzadas de validación de transición

## Iconos

Coloca el logo cuadrado oficial en `src-tauri/icons/logo.png` y ejecuta:

```bash
bash src-tauri/icons/generate_icons.sh
```

El repo incluye iconos placeholder (J en colores Jumapa) sólo para que el build funcione mientras tanto.

## Notas backend

Endpoints añadidos en este MVP (ya implementados):
- `GET /tickets/mine` — tickets asignados al usuario actual
- `POST /tickets/{id}/time` — registrar bitácora `{seconds, phase, note?, source?}`
- `GET /tickets/{id}/time` — listado de bitácoras del ticket
- `GET /tickets/{id}/chat` — historial de chat (mensajes internos)
- `POST /tickets/{id}/chat` — publicar mensaje
- `WS /tickets/{id}/chat/ws?token=...` — chat en tiempo real
- `WS /notifications/ws?token=...` — feed de notificaciones realtime

Cliente Keycloak requerido (ya creado por el equipo): `hds-desktop`
- Tipo: público (sin client secret)
- Redirect URI válido: `http://127.0.0.1:53682/callback`
- Web Origins: `+` (o `http://127.0.0.1:53682`)
- PKCE: S256 obligatorio

Nueva tabla DB `ticket_time_logs` (migración `a9f1c2d3e4b5`). Aplicar con:

```bash
cd backend && alembic upgrade head
```

