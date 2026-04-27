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
  project_id?: number | null;
}

export type Phase = "espera" | "proceso" | "cierre";

export const api = {
  myTickets: () => request<Ticket[]>("/tickets/mine"),
  setStatus: (id: number, status: string) =>
    request<Ticket>(`/tickets/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
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
};
