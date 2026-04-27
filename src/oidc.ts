// OIDC Authorization Code + PKCE contra Keycloak.
// Flujo: abre el navegador del sistema → Keycloak → redirect a http://127.0.0.1:<port>/callback
// Tauri intercepta vía plugin-shell (open) y un mini servidor HTTP en Rust no es necesario:
// usamos un listener temporal con `fetch` desde el lado JS sería imposible; en su lugar,
// abrimos un loopback server en Rust mediante un comando expuesto. Para mantener el MVP simple,
// hacemos el PKCE con device flow opcional o con el flujo "polling" del callback escuchado por Rust.
//
// Aquí implementamos el flujo PKCE estándar y delegamos el listener al backend Rust del propio
// Tauri vía un comando `oidc_listen` (definido en src-tauri). Si aún no está disponible, se cae
// al login por token manual.

import { invoke } from "@tauri-apps/api/core";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { config } from "./config";
import { setToken } from "./auth";

function base64UrlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash);
}

function randomString(len = 64): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

interface OidcResult {
  code: string;
  state: string;
  redirect_uri: string;
}

export async function loginWithKeycloak(): Promise<void> {
  const realmUrl = `${config.keycloakUrl}/realms/${config.keycloakRealm}`;
  const authUrl = `${realmUrl}/protocol/openid-connect/auth`;
  const tokenUrl = `${realmUrl}/protocol/openid-connect/token`;

  const codeVerifier = randomString(64);
  const codeChallenge = base64UrlEncode(await sha256(codeVerifier));
  const state = randomString(24);

  // Pedimos a Rust que escuche un puerto loopback y devuelva (code, state, redirect_uri)
  const listener = invoke<OidcResult>("oidc_start_listener", { state });

  // Construimos URL de autorización; redirect_uri lo decide Rust (puerto efímero).
  // Pasamos un placeholder y Rust nos confirma el real al iniciar; para evitar esa
  // complejidad, fijamos un puerto: 53682 (igual al usado por rclone, libre habitualmente).
  const redirectUri = "http://127.0.0.1:53682/callback";

  const params = new URLSearchParams({
    client_id: config.keycloakClientId,
    response_type: "code",
    scope: "openid profile email",
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  await openUrl(`${authUrl}?${params.toString()}`);

  const result = await listener;
  if (result.state !== state) throw new Error("OIDC state mismatch");

  // Intercambio code -> token DENTRO de Rust (evita CORS contra Keycloak,
  // ya que el WebView no tiene Web Origins permitidos por defecto).
  const tokens = await invoke<{ access_token: string; refresh_token?: string; expires_in: number }>(
    "oidc_exchange_code",
    {
      tokenUrl,
      clientId: config.keycloakClientId,
      code: result.code,
      redirectUri,
      codeVerifier,
    },
  );

  await setToken(tokens.access_token);
}
