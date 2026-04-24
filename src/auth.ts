// Auth simple inicial: guarda token en Tauri Store (encriptado en disco del usuario).
// Fase 2: reemplazar por OIDC PKCE contra Keycloak (apertura de navegador del sistema).
import { Store } from "@tauri-apps/plugin-store";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load("auth.json");
  }
  return storePromise;
}

export async function getToken(): Promise<string | null> {
  try {
    const s = await getStore();
    return ((await s.get<string>("token")) ?? null) as string | null;
  } catch {
    return null;
  }
}

export async function setToken(token: string): Promise<void> {
  const s = await getStore();
  await s.set("token", token);
  await s.save();
}

export async function clearToken(): Promise<void> {
  const s = await getStore();
  await s.delete("token");
  await s.save();
}
