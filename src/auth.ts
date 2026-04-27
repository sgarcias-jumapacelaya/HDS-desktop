// Auth: gestiona access_token, refresh_token y expiración.
// Refresca automáticamente el access_token usando el refresh_token (Rust → Keycloak),
// para evitar errores 401 "Signature has expired" en sesiones largas.
import { Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { config } from "./config";

interface Session {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
}

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load("auth.json");
  }
  return storePromise;
}

async function readSession(): Promise<Session | null> {
  try {
    const s = await getStore();
    const sess = (await s.get<Session>("session")) ?? null;
    if (sess && sess.access_token) return sess;
    // Compatibilidad con sesiones viejas que solo guardaban "token"
    const legacy = (await s.get<string>("token")) ?? null;
    if (legacy) return { access_token: legacy };
    return null;
  } catch {
    return null;
  }
}

async function writeSession(sess: Session | null): Promise<void> {
  const s = await getStore();
  if (sess) {
    await s.set("session", sess);
    await s.set("token", sess.access_token); // compat
  } else {
    await s.delete("session");
    await s.delete("token");
  }
  await s.save();
}

let refreshing: Promise<string | null> | null = null;

async function tryRefresh(sess: Session): Promise<string | null> {
  if (!sess.refresh_token) return null;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const tokenUrl = `${config.keycloakUrl}/realms/${config.keycloakRealm}/protocol/openid-connect/token`;
      const resp = await invoke<{ access_token: string; refresh_token?: string; expires_in: number }>(
        "oidc_refresh_token",
        {
          tokenUrl,
          clientId: config.keycloakClientId,
          refreshToken: sess.refresh_token,
        },
      );
      const next: Session = {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token ?? sess.refresh_token,
        expires_at: Date.now() + Math.max(0, (resp.expires_in - 30)) * 1000,
      };
      await writeSession(next);
      return next.access_token;
    } catch {
      await writeSession(null);
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function getToken(): Promise<string | null> {
  const sess = await readSession();
  if (!sess) return null;
  if (sess.expires_at && Date.now() >= sess.expires_at - 5_000 && sess.refresh_token) {
    const fresh = await tryRefresh(sess);
    return fresh ?? sess.access_token;
  }
  return sess.access_token;
}

/** Forzar refresh ahora (api.ts lo llama cuando recibe un 401). */
export async function forceRefresh(): Promise<string | null> {
  const sess = await readSession();
  if (!sess || !sess.refresh_token) {
    await writeSession(null);
    return null;
  }
  return tryRefresh(sess);
}

/** Guarda una sesion completa (lo usa el flujo OIDC tras intercambiar el code). */
export async function setSession(tokens: { access_token: string; refresh_token?: string; expires_in?: number }): Promise<void> {
  await writeSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_in ? Date.now() + Math.max(0, (tokens.expires_in - 30)) * 1000 : undefined,
  });
}

/** Compat: setToken(string) para flujo de "login manual con token". */
export async function setToken(token: string): Promise<void> {
  await writeSession({ access_token: token });
}

export async function clearToken(): Promise<void> {
  await writeSession(null);
}
