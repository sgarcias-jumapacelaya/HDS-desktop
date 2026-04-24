// Configuración leída desde variables Vite (.env / .env.local)
function parseQuietHours(s: string | undefined): [number, number] | null {
  if (!s) return null;
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(s);
  if (!m) return null;
  const a = Math.max(0, Math.min(23, Number(m[1])));
  const b = Math.max(0, Math.min(23, Number(m[2])));
  return [a, b];
}

export const config = {
  apiBase: import.meta.env.VITE_API_BASE ?? "https://hds.jumapa.in",
  keycloakUrl: import.meta.env.VITE_KEYCLOAK_URL ?? "",
  keycloakRealm: import.meta.env.VITE_KEYCLOAK_REALM ?? "hds",
  keycloakClientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? "hds-desktop",
  pollIntervalMs: Number(import.meta.env.VITE_POLL_INTERVAL_MS ?? 30000),
  focusWindowMs: Number(import.meta.env.VITE_FOCUS_WINDOW_MS ?? 8000),
  focusGroupThreshold: Number(import.meta.env.VITE_FOCUS_GROUP_THRESHOLD ?? 2),
  quietHours: parseQuietHours(import.meta.env.VITE_QUIET_HOURS as string | undefined),
  idleAutoPauseMs: Number(import.meta.env.VITE_IDLE_AUTO_PAUSE_MS ?? 300000),
};
