import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

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
    // El diálogo nativo (dialog:true) ya pregunta al usuario; aquí solo
    // procedemos si confirma. downloadAndInstall() respeta esa interacción.
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    // No molestar al usuario si la verificación falla (offline, etc.)
    console.warn("[updater] check failed:", e);
  }
}
