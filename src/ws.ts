// WebSocket clients para notifications y chat por ticket.
// Auth: token Keycloak por query string (?token=...).
import { config } from "./config";
import { getToken } from "./auth";

function wsBase(): string {
  const url = new URL(config.apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

export interface Reconnectable {
  close(): void;
}

interface OpenOpts {
  onMessage: (data: any) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

function openSocket(path: string, opts: OpenOpts): Reconnectable {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  async function connect() {
    if (closed) return;
    const token = await getToken();
    if (!token) {
      // sin token, reintentar tarde
      setTimeout(connect, 5000);
      return;
    }
    const url = `${wsBase()}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    ws = new WebSocket(url);

    ws.onopen = () => {
      retry = 0;
      opts.onOpen?.();
      pingTimer = setInterval(() => {
        try { ws?.send("ping"); } catch { /* ignore */ }
      }, 25000);
    };
    ws.onmessage = (ev) => {
      if (ev.data === "pong") return;
      try { opts.onMessage(JSON.parse(ev.data)); } catch { /* ignore non-JSON */ }
    };
    ws.onclose = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      opts.onClose?.();
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 1000 * 2 ** retry); // backoff: 2s, 4s, 8s ... 64s
    };
    ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
  }

  connect();

  return {
    close() {
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      try { ws?.close(); } catch { /* ignore */ }
    },
  };
}

export function connectNotifications(onMessage: (data: any) => void): Reconnectable {
  return openSocket("/notifications/ws", { onMessage });
}

export function connectTicketChat(ticketId: number, onMessage: (data: any) => void): Reconnectable {
  return openSocket(`/tickets/${ticketId}/chat/ws`, { onMessage });
}
