// Errores estructurados + log persistente para HDS Desktop.
//
// Objetivo: mostrar mensajes amigables al usuario sin perder los detalles
// técnicos, que quedan disponibles en un log accesible desde la UI.

export interface ErrorLogEntry {
  id: string;
  timestamp: number;       // epoch ms
  friendly: string;        // mensaje mostrado al usuario
  technical: string;       // detalle crudo (URL, body, stack)
  status?: number;
  url?: string;
  context?: string;        // p.ej. "myTickets", "login"
}

export interface ApiErrorOptions {
  status: number;
  url: string;
  body: string;
  detail?: string;
  context?: string;
}

const STATUS_FRIENDLY: Record<number, string> = {
  400: "La solicitud no es válida. Revisa los datos e intenta de nuevo.",
  401: "Tu sesión expiró. Vuelve a iniciar sesión.",
  403: "No tienes permisos para realizar esta acción.",
  404: "No se encontró el recurso solicitado.",
  408: "La solicitud tardó demasiado. Intenta de nuevo.",
  409: "Hay un conflicto con el estado actual. Recarga e intenta de nuevo.",
  413: "El archivo o contenido es demasiado grande.",
  422: "Algunos datos no son válidos. Revísalos e intenta de nuevo.",
  429: "Demasiadas solicitudes. Espera un momento.",
  500: "Ocurrió un error en el servidor. Intenta más tarde.",
  502: "El servidor no está respondiendo. Intenta más tarde.",
  503: "El servicio no está disponible. Intenta más tarde.",
  504: "El servidor tardó demasiado en responder. Intenta más tarde.",
};

export class ApiError extends Error {
  status: number;
  url: string;
  body: string;
  detail?: string;
  friendly: string;
  context?: string;

  constructor(opts: ApiErrorOptions) {
    const friendly = ApiError.friendlyFor(opts.status, opts.detail);
    super(friendly);
    this.name = "ApiError";
    this.status = opts.status;
    this.url = opts.url;
    this.body = opts.body;
    this.detail = opts.detail;
    this.friendly = friendly;
    this.context = opts.context;
  }

  static friendlyFor(status: number, detail?: string): string {
    if (status === 0) return "Sin conexión con el servidor. Verifica tu red.";
    const base = STATUS_FRIENDLY[status]
      ?? (status >= 500 ? "Ocurrió un error en el servidor. Intenta más tarde."
        : status >= 400 ? "No se pudo completar la solicitud."
        : "Ocurrió un error inesperado.");
    return base;
  }

  technicalDetails(): string {
    const parts = [
      `HTTP ${this.status} ${this.url}`,
      this.detail ? `detail: ${this.detail}` : null,
      this.body ? `body: ${this.body.slice(0, 500)}` : null,
    ].filter(Boolean);
    return parts.join("\n");
  }
}

export class NetworkError extends Error {
  url: string;
  cause?: unknown;
  friendly = "Sin conexión con el servidor. Verifica tu red.";
  constructor(url: string, cause?: unknown) {
    super("Sin conexión con el servidor. Verifica tu red.");
    this.name = "NetworkError";
    this.url = url;
    this.cause = cause;
  }
  technicalDetails(): string {
    const msg = (this.cause as any)?.message ?? String(this.cause ?? "");
    return `Network error → ${this.url}\n${msg}`;
  }
}

// ---- Log buffer -----------------------------------------------------------

const STORAGE_KEY = "hds:error-log";
const MAX_ENTRIES = 100;
let buffer: ErrorLogEntry[] = loadFromStorage();
const listeners = new Set<(entries: ErrorLogEntry[]) => void>();

function loadFromStorage(): ErrorLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(-MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(buffer));
  } catch {
    // ignorar (cuota llena, modo privado, etc.)
  }
}

function emit() {
  for (const fn of listeners) {
    try { fn(buffer); } catch { /* noop */ }
  }
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function logError(err: unknown, context?: string): ErrorLogEntry {
  const entry = toLogEntry(err, context);
  buffer = [...buffer, entry].slice(-MAX_ENTRIES);
  persist();
  emit();
  // También a la consola, útil con devtools abiertos.
  // eslint-disable-next-line no-console
  console.error(`[HDS] ${entry.context ?? ""} ${entry.friendly}\n${entry.technical}`);
  return entry;
}

export function getErrorLog(): ErrorLogEntry[] {
  return [...buffer].reverse(); // más recientes primero
}

export function clearErrorLog() {
  buffer = [];
  persist();
  emit();
}

export function subscribeErrorLog(fn: (entries: ErrorLogEntry[]) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function friendlyMessage(err: unknown): string {
  if (err instanceof ApiError) return err.friendly;
  if (err instanceof NetworkError) return err.friendly;
  if (err && typeof err === "object" && "friendly" in err) {
    const f = (err as any).friendly;
    if (typeof f === "string") return f;
  }
  return "Ocurrió un error inesperado. Revisa los detalles.";
}

function toLogEntry(err: unknown, context?: string): ErrorLogEntry {
  if (err instanceof ApiError) {
    return {
      id: makeId(),
      timestamp: Date.now(),
      friendly: err.friendly,
      technical: err.technicalDetails(),
      status: err.status,
      url: err.url,
      context: context ?? err.context,
    };
  }
  if (err instanceof NetworkError) {
    return {
      id: makeId(),
      timestamp: Date.now(),
      friendly: err.friendly,
      technical: err.technicalDetails(),
      url: err.url,
      context,
    };
  }
  const e = err as any;
  return {
    id: makeId(),
    timestamp: Date.now(),
    friendly: e?.friendly ?? e?.message ?? "Error inesperado",
    technical: e?.stack ?? String(err),
    context,
  };
}
