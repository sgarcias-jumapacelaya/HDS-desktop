import { config } from "./config";
import { getToken } from "./auth";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const url = `${config.apiBase}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (e: any) {
    throw new Error(`Network error → ${url} :: ${e?.message ?? e}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${url} :: ${body.slice(0, 200)}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    const body = await res.text().catch(() => "");
    throw new Error(`Respuesta no-JSON de ${url} (content-type=${ct}) :: ${body.slice(0, 200)}`);
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
};

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
