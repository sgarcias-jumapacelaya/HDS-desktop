import { useEffect, useMemo, useState } from "react";
import { api, Ticket } from "./api";
import { friendlyMessage, logError } from "./errors";

interface AssignableUser {
  id: number;
  full_name?: string;
  username?: string;
  role?: string;
}

interface TicketTypeOption {
  value: string;
  label: string;
}

const PRIORITY_LABELS: Record<string, string> = {
  low: "Baja",
  medium: "Media",
  high: "Alta",
  critical: "Crítica",
};

const ASSIGNABLE_ROLES = new Set([
  "admin",
  "team_admin",
  "project_manager",
  "analyst",
  "developer",
]);

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

interface Props {
  open: boolean;
  meId: number | undefined;
  onClose: () => void;
  onChanged?: () => void; // notifica al padre para refrescar contador
}

export default function TriageModal({ open, meId, onClose, onChanged }: Props) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [types, setTypes] = useState<TicketTypeOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [t, u, ty] = await Promise.all([
        api.triageList(),
        api.assignableUsers(),
        api.ticketTypes(),
      ]);
      setTickets(t);
      setUsers(u.filter((x) => x.role && ASSIGNABLE_ROLES.has(x.role)));
      setTypes(ty);
    } catch (e: any) {
      logError(e, "triage/load");
      setError(friendlyMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    load();
    const id = setInterval(() => {
      api.triageList().then(setTickets).catch(() => {});
    }, 30000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function userName(uid?: number | null): string {
    if (!uid) return "—";
    const u = users.find((x) => x.id === uid);
    return u ? (u.full_name || u.username || `Usuario #${uid}`) : `Usuario #${uid}`;
  }

  async function patchAndUpdate(
    ticketId: number,
    payload: Record<string, any>,
    removeOnSuccess = false,
  ) {
    setBusyId(ticketId);
    try {
      const updated = await api.patchTicket(ticketId, payload);
      if (removeOnSuccess) {
        setTickets((curr) => curr.filter((t) => t.id !== ticketId));
      } else {
        setTickets((curr) => curr.map((t) => (t.id === ticketId ? { ...t, ...updated } : t)));
      }
      onChanged?.();
    } catch (e: any) {
      setError(friendlyMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  const filtered = useMemo(() => {
    if (!filter.trim()) return tickets;
    const f = filter.toLowerCase();
    return tickets.filter(
      (t) =>
        String(t.id).includes(f) ||
        (t.title || "").toLowerCase().includes(f) ||
        (t.description || "").toLowerCase().includes(f),
    );
  }, [tickets, filter]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal triage-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(960px, 95vw)", maxHeight: "90vh", display: "flex", flexDirection: "column" }}
      >
        <div className="modal-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>
            🔍 Triage de tickets <span style={{ color: "#888", fontSize: 13, fontWeight: "normal" }}>({tickets.length})</span>
          </h3>
          <button onClick={onClose}>✕</button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            type="text"
            placeholder="Buscar por # o texto…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ flex: 1 }}
          />
          <button onClick={load} disabled={loading} title="Refrescar">
            {loading ? "…" : "↻"}
          </button>
        </div>

        {error && (
          <div className="error-banner" style={{ marginBottom: 8 }}>
            {error}
            <button onClick={() => setError(null)} style={{ marginLeft: 8 }}>×</button>
          </div>
        )}

        <div style={{ overflow: "auto", flex: 1 }}>
          {loading && tickets.length === 0 ? (
            <div style={{ padding: 16, textAlign: "center", color: "#888" }}>Cargando…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 16, textAlign: "center", color: "#888" }}>
              🎉 No hay tickets pendientes de triage.
            </div>
          ) : (
            <table className="triage-table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ position: "sticky", top: 0, background: "var(--bg, #1a1a1a)" }}>
                  <th style={{ textAlign: "left", padding: 6 }}>#</th>
                  <th style={{ textAlign: "left", padding: 6 }}>Título</th>
                  <th style={{ textAlign: "left", padding: 6 }}>Prioridad</th>
                  <th style={{ textAlign: "left", padding: 6 }}>Tipo</th>
                  <th style={{ textAlign: "left", padding: 6 }}>IA</th>
                  <th style={{ textAlign: "left", padding: 6 }}>Hace</th>
                  <th style={{ textAlign: "left", padding: 6 }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => {
                  const busy = busyId === t.id;
                  const prio = (t.priority || "medium").toLowerCase();
                  const aiAssignee = t.ai_assignee_id ?? null;
                  return (
                    <tr key={t.id} style={{ borderTop: "1px solid #333" }}>
                      <td style={{ padding: 6, fontWeight: 600 }}>#{t.id}</td>
                      <td style={{ padding: 6 }}>
                        <div>{t.title}</div>
                        {t.description && (
                          <div style={{ color: "#888", fontSize: 11 }}>
                            {t.description.slice(0, 100)}{t.description.length > 100 ? "…" : ""}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: 6 }}>
                        <select
                          value={prio}
                          disabled={busy}
                          onChange={(e) => patchAndUpdate(t.id, { priority: e.target.value })}
                        >
                          {Object.entries(PRIORITY_LABELS).map(([v, l]) => (
                            <option key={v} value={v}>{l}</option>
                          ))}
                        </select>
                      </td>
                      <td style={{ padding: 6 }}>
                        <select
                          value={t.ticket_type || ""}
                          disabled={busy || types.length === 0}
                          onChange={(e) => patchAndUpdate(t.id, { ticket_type: e.target.value || null })}
                        >
                          <option value="">— Sin tipo —</option>
                          {types.map((tt) => (
                            <option key={tt.value} value={tt.value}>{tt.label}</option>
                          ))}
                        </select>
                      </td>
                      <td style={{ padding: 6, fontSize: 11, color: "#aaa" }}>
                        {t.ai_priority && <div>{PRIORITY_LABELS[t.ai_priority] || t.ai_priority}</div>}
                        {aiAssignee && <div>{userName(aiAssignee)}</div>}
                        {!t.ai_priority && !aiAssignee && "—"}
                      </td>
                      <td style={{ padding: 6, fontSize: 11, color: "#aaa", whiteSpace: "nowrap" }}>
                        {timeAgo(t.created_at)}
                      </td>
                      <td style={{ padding: 6, whiteSpace: "nowrap" }}>
                        <button
                          disabled={busy || !meId}
                          onClick={() => patchAndUpdate(t.id, { assignee_id: meId }, true)}
                          title="Asignármelo"
                        >
                          Tomarlo
                        </button>
                        {aiAssignee && aiAssignee !== meId && (
                          <button
                            disabled={busy}
                            onClick={() => patchAndUpdate(t.id, { assignee_id: aiAssignee }, true)}
                            title={`Asignar a ${userName(aiAssignee)} (sugerido por IA)`}
                            style={{ marginLeft: 4 }}
                          >
                            IA →
                          </button>
                        )}
                        <select
                          value=""
                          disabled={busy}
                          onChange={(e) => {
                            const uid = parseInt(e.target.value, 10);
                            if (!Number.isNaN(uid)) patchAndUpdate(t.id, { assignee_id: uid }, true);
                          }}
                          style={{ marginLeft: 4 }}
                        >
                          <option value="">Asignar a…</option>
                          {users.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.full_name || u.username}
                            </option>
                          ))}
                        </select>
                        <button
                          disabled={busy}
                          onClick={() => {
                            const target = aiAssignee || meId;
                            if (target) patchAndUpdate(t.id, { assignee_id: target }, true);
                          }}
                          title={aiAssignee ? `Finalizar y asignar a ${userName(aiAssignee)}` : "Finalizar (asignármelo)"}
                          style={{ marginLeft: 4, background: "#10b981", color: "#fff" }}
                        >
                          ✓ Listo
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
