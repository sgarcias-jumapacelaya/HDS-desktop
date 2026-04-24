import { config } from "./config";
import { getToken } from "./auth";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${config.apiBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
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
