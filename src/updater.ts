import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";

/**
 * Verifica si hay una nueva versión publicada en GitHub Releases al iniciar.
 * Si la hay, muestra un diálogo nativo preguntando al usuario si desea
 * actualizar ahora; si acepta, descarga el bundle, lo aplica y reinicia.
 *
 * Silencioso ante fallos de red — solo loguea en consola.
 */
export async function checkForUpdatesOnStartup(): Promise<void> {
  try {
    const update = await check();
    if (!update?.available) return;

    const current = await getVersion();
    const newVer = update.version ?? "?";
    const notes = (update as any).body ? `\n\nNotas:\n${(update as any).body}` : "";

    const yes = await ask(
      `Hay una nueva versión disponible: v${newVer}\nVersión actual: v${current}${notes}\n\n¿Deseas actualizar ahora? La app se reiniciará al terminar.`,
      { title: "HDS Desktop · Actualización disponible", kind: "info", okLabel: "Actualizar", cancelLabel: "Más tarde" }
    );
    if (!yes) return;

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
    const notes = (update as any).body ? `\n\nNotas:\n${(update as any).body}` : "";
    const yes = await ask(
      `Hay una nueva versión disponible: v${newVer}\nVersión actual: v${current}${notes}\n\n¿Actualizar ahora?`,
      { title: "HDS Desktop · Actualización disponible", kind: "info", okLabel: "Actualizar", cancelLabel: "Cancelar" }
    );
    if (!yes) return `Actualización pospuesta (v${newVer} disponible).`;
    await update.downloadAndInstall();
    await relaunch();
    return `Actualizado a v${newVer}, reiniciando…`;
  } catch (e: any) {
    try { await message(`No se pudo verificar actualizaciones:\n${e?.message ?? String(e)}`, { title: "HDS Desktop", kind: "error" }); } catch {}
    return `No se pudo verificar actualizaciones: ${e?.message ?? String(e)}`;
  }
}

export async function getAppVersion(): Promise<string> {
  try { return await getVersion(); } catch { return "?"; }
}
