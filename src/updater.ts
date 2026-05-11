import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

/**
 * Verifica si hay una nueva versión publicada en GitHub Releases.
 * Si la hay, muestra el diálogo nativo (configurado en tauri.conf.json),
 * descarga el nuevo bundle, lo aplica y reinicia la app.
 *
 * Silencioso ante fallos (sin internet, etc.) — solo loguea en consola.
 */
export async function checkForUpdatesOnStartup(): Promise<void> {
  try {
    const update = await check();
    if (!update?.available) return;
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    console.warn("[updater] check failed:", e);
  }
}

/**
 * Versión interactiva: lanzada por un botón en la UI. Devuelve un mensaje
 * legible para mostrar al usuario.
 */
export async function checkForUpdatesInteractive(): Promise<string> {
  try {
    const current = await getVersion();
    const update = await check();
    if (!update?.available) {
      return `Estás en la última versión (v${current}).`;
    }
    const newVer = update.version ?? "?";
    await update.downloadAndInstall();
    await relaunch();
    return `Actualizado a v${newVer}, reiniciando…`;
  } catch (e: any) {
    return `No se pudo verificar actualizaciones: ${e?.message ?? String(e)}`;
  }
}

export async function getAppVersion(): Promise<string> {
  try { return await getVersion(); } catch { return "?"; }
}
