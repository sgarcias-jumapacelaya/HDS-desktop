import { config } from "./config";
import { getToken, forceRefresh } from "./auth";
import { ApiError, NetworkError, logError } from "./errors";

function extractDetail(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const j = JSON.parse(body);
    if (typeof j?.detail === "string") return j.detail;
    if (Array.isArray(j?.detail)) {
      // FastAPI validation: lista de objetos con msg
      const msgs = j.detail.map((d: any) => d?.msg).filter(Boolean);
      if (msgs.length) return msgs.join("; ");
    }
    if (typeof j?.message === "string") return j.message;
  } catch {
    // body no-JSON
  }
  return undefined;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${config.apiBase}${path}`;
  const context = path.split("?")[0];

  async function doFetch(token: string | null): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  }

  let token = await getToken();
  let res: Response;
  try {
    res = await doFetch(token);
  } catch (e: any) {
    const err = new NetworkError(url, e);
    logError(err, context);
    throw err;
  }

  // Si el access token expiro, intentar refresh y reintentar UNA vez.
  if (res.status === 401) {
    const fresh = await forceRefresh();
    if (fresh) {
      try {
        res = await doFetch(fresh);
      } catch (e: any) {
        const err = new NetworkError(url, e);
        logError(err, context);
        throw err;
      }
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new ApiError({
      status: res.status,
      url,
      body,
      detail: extractDetail(body),
      context,
    });
    logError(err, context);
    throw err;
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    const body = await res.text().catch(() => "");
    const err = new ApiError({
      status: res.status,
      url,
      body,
      detail: `Respuesta no-JSON (content-type=${ct})`,
      context,
    });
    logError(err, context);
    throw err;
  }
  return res.json() as Promise<T>;
}

export interface Ticket {
  id: number;
  title: string;
  status: string;
  priority?: string;
  assignee_id?: number | null;
  creator_id?: number | null;
  project_id?: number | null;
  description?: string;
}

export interface Project {
  id: number;
  name: string;
  key?: string;
}

export type Phase = "espera" | "proceso" | "cierre";

export const api = {
  myTickets: () => request<Ticket[]>("/tickets/mine"),
  myCreatedTickets: () => request<Ticket[]>("/tickets/mine?scope=created"),
  setStatus: (id: number, status: string) =>
    request<Ticket>(`/tickets/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  cancelTicket: (id: number) =>
    request<Ticket>(`/tickets/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "closed" }),
    }),
  createTicket: (payload: { title: string; description: string; priority?: string; project_id?: number }) =>
    request<Ticket>("/tickets/", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  projects: () => request<Project[]>("/projects/"),
  unreadCount: () => request<{ count: number }>("/notifications/unread-count"),
  notifications: () => request<any[]>("/notifications/"),
  markAllNotificationsRead: () =>
    request<{ updated: number }>("/notifications/read-all", { method: "PATCH" }),
  logTime: (ticketId: number, seconds: number, phase: Phase, note?: string) =>
    request(`/tickets/${ticketId}/time`, {
      method: "POST",
      body: JSON.stringify({ seconds, phase, note, source: "desktop" }),
    }),
  me: () => request<any>("/auth/me"),
  chatHistory: (ticketId: number) =>
    request<any[]>(`/tickets/${ticketId}/chat`),
  chatSend: (ticketId: number, content: string) =>
    request<any>(`/tickets/${ticketId}/chat`, {
      method: "POST",
      body: JSON.stringify({ content, is_internal: true }),
    }),

  // ---- DM (chat usuario-a-usuario) ----
  dmUsers: () => request<DmUserSummary[]>("/dm/users"),
  dmHistory: (userId: number, before?: number) =>
    request<DmMessage[]>(`/dm/conversations/${userId}/messages${before ? `?before=${before}` : ""}`),
  dmSend: (userId: number, content: string) =>
    request<DmMessage>(`/dm/conversations/${userId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  dmMarkRead: (userId: number) =>
    request<{ updated: number }>(`/dm/conversations/${userId}/read`, { method: "POST" }),
  dmBuzz: (userId: number) =>
    request<{ ok: boolean }>(`/dm/buzz/${userId}`, { method: "POST" }),
  dmUpload: async (file: File): Promise<{ url: string; filename: string; mimetype?: string; size: number }> => {
    const url = `${config.apiBase}/dm/upload`;
    const token = await getToken();
    const fd = new FormData();
    fd.append("file", file);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        body: fd,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch (e: any) {
      const err = new NetworkError(url, e);
      logError(err, "/dm/upload");
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new ApiError({
        status: res.status,
        url,
        body,
        detail: extractDetail(body),
        context: "/dm/upload",
      });
      logError(err, "/dm/upload");
      throw err;
    }
    return res.json();
  },
};

/** Convierte una URL relativa del backend (`/uploads/...`) en absoluta. */
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = config.apiBase.replace(/\/api\/?$/, "");
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

export interface DmUserSummary {
  id: number;
  username: string;
  full_name?: string | null;
  role?: string | null;
  online: boolean;
  unread: number;
  last_message_at?: string | null;
}

export interface DmMessage {
  id: number;
  sender_id: number;
  recipient_id: number;
  content: string;
  created_at?: string | null;
  read_at?: string | null;
}
