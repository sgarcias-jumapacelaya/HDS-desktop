// Focus mode: agrupa toasts de notificación para evitar fatiga.
// - Si llegan varias notificaciones en un ventana corta (window), se emite UN solo toast resumen.
// - Configurable: ventana de agrupamiento, umbral mínimo, y "quiet hours".

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

interface PendingNotif {
  title: string;
  message: string;
}

interface FocusOptions {
  windowMs: number;       // ventana de agrupamiento
  groupThreshold: number; // a partir de cuántas se agrupa
  quietHours?: [number, number] | null; // ej. [22, 7] => suprime entre 22:00 y 07:00
}

const defaults: FocusOptions = {
  windowMs: 8000,
  groupThreshold: 2,
  quietHours: null,
};

let opts: FocusOptions = { ...defaults };
let buffer: PendingNotif[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function configureFocus(partial: Partial<FocusOptions>): void {
  opts = { ...opts, ...partial };
}

function inQuietHours(): boolean {
  if (!opts.quietHours) return false;
  const [start, end] = opts.quietHours;
  const h = new Date().getHours();
  return start < end ? h >= start && h < end : h >= start || h < end;
}

async function ensurePermission(): Promise<boolean> {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  return granted;
}

async function flush() {
  flushTimer = null;
  const items = buffer;
  buffer = [];
  if (items.length === 0) return;
  if (inQuietHours()) return;

  if (!(await ensurePermission())) return;

  if (items.length < opts.groupThreshold) {
    for (const it of items) sendNotification({ title: it.title, body: it.message });
    return;
  }

  // Agrupado: un toast resumen
  const sample = items.slice(0, 3).map((i) => `• ${i.message}`).join("\n");
  const more = items.length > 3 ? `\n…y ${items.length - 3} más` : "";
  sendNotification({
    title: `HDS · ${items.length} notificaciones`,
    body: sample + more,
  });
}

/** Encola una notificación y deja que el grupo se emita al cierre de la ventana. */
export function notifyGrouped(title: string, message: string): void {
  buffer.push({ title, message });
  if (!flushTimer) {
    flushTimer = setTimeout(flush, opts.windowMs);
  }
}

/** Forzar flush inmediato (útil en tests o cierre). */
export function flushNow(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flush();
}
