import { useEffect, useRef, useState } from "react";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { api, Ticket, Phase } from "./api";
import { config } from "./config";
import { getToken, setToken, clearToken } from "./auth";
import { loginWithKeycloak } from "./oidc";
import { connectNotifications, Reconnectable } from "./ws";
import ChatPanel from "./ChatPanel";
import DmPanel, { DmEvent } from "./DmPanel";
import NewTicketModal from "./NewTicketModal";
import ErrorLogModal from "./ErrorLogModal";
import TriageModal from "./TriageModal";
import { configureFocus, notifyGrouped } from "./focusMode";
import { startIdleWatcher, IdleWatcher } from "./idle";
import { friendlyMessage, logError, getErrorLog, subscribeErrorLog } from "./errors";

interface TrackerState {
  ticketId: number;
  phase: Phase;
  startedAt: number;        // timestamp del segmento actual (0 si pausado)
  accumulatedSec: number;   // segundos acumulados antes del segmento actual
  paused: boolean;          // true si fue auto-pausado por inactividad
}

const STATUS_LABEL: Record<string, string> = {
  open: "Abierto",
  in_progress: "En proceso",
  resolved: "Resuelto",
  closed: "Cerrado",
};

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [unread, setUnread] = useState(0);
  const [tracker, setTracker] = useState<TrackerState | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busyLogin, setBusyLogin] = useState(false);
  const [me, setMe] = useState<{ id: number; full_name?: string; role?: string } | null>(null);
  const [chatTicket, setChatTicket] = useState<number | null>(null);
  const [wsLive, setWsLive] = useState(false);
  const [dmOpen, setDmOpen] = useState(false);
  const [dmEvents, setDmEvents] = useState<DmEvent[]>([]);
  const [dmUnread, setDmUnread] = useState(0);
  const [newTicketOpen, setNewTicketOpen] = useState(false);
  const [errorLogOpen, setErrorLogOpen] = useState(false);
  const [errorLogCount, setErrorLogCount] = useState(getErrorLog().length);
  const [triageOpen, setTriageOpen] = useState(false);
  const [triageCount, setTriageCount] = useState(0);
  const trackerRef = useRef<TrackerState | null>(null);
  const idleRef = useRef<IdleWatcher | null>(null);

  // Helper para mostrar errores amigables y dejar registro tecnico.
  function showError(e: unknown, context?: string) {
    // Si vino de la capa api ya esta logueado; este logError es idempotente para otros origenes.
    if (!(e as any)?.name || ((e as any).name !== "ApiError" && (e as any).name !== "NetworkError")) {
      logError(e, context);
    }
    setError(friendlyMessage(e));
  }

  // Mantener el contador del badge sincronizado con el log.
  useEffect(() => subscribeErrorLog((entries) => setErrorLogCount(entries.length)), []);

  // Configurar focus mode una vez
  useEffect(() => {
    configureFocus({
      windowMs: config.focusWindowMs,
      groupThreshold: config.focusGroupThreshold,
      quietHours: config.quietHours,
    });
  }, []);

  useEffect(() => { trackerRef.current = tracker; }, [tracker]);

  useEffect(() => {
    getToken().then((t) => setAuthed(!!t));
  }, []);

  useEffect(() => {
    if (!authed) { setMe(null); return; }
    api.me().then((u) => setMe({ id: u.id, full_name: u.full_name, role: u.local_role })).catch(() => {});
  }, [authed]);

  // Polling de respaldo (más espaciado si WS está vivo)
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    let lastUnread = 0;

    async function tick() {
      try {
        const [t, n] = await Promise.all([api.myTickets(), api.unreadCount()]);
        if (cancelled) return;
        setTickets(t);
        setUnread(n.count);
        if (n.count > lastUnread) {
          notifyGrouped("HDS", `Tienes ${n.count} notificaciones sin leer`);
        }
        lastUnread = n.count;
        setError(null);
      } catch (e: any) {
        showError(e, "polling");
      }
    }

    tick();
    const interval = wsLive ? Math.max(60000, config.pollIntervalMs * 2) : config.pollIntervalMs;
    const id = setInterval(tick, interval);
    return () => { cancelled = true; clearInterval(id); };
  }, [authed, wsLive]);

  // WS notifications
  useEffect(() => {
    if (!authed) return;
    const conn: Reconnectable = connectNotifications((evt) => {
      if (evt.type === "notification") {
        setWsLive(true);
        setUnread((c) => c + 1);
        notifyGrouped(evt.data?.title ?? "HDS", evt.data?.message ?? "Nueva notificación");
        const t = String(evt.data?.type ?? "");
        if (t === "assigned" || t === "status_changed") {
          api.myTickets().then(setTickets).catch(() => {});
        }
      } else if (evt.type === "dm") {
        setWsLive(true);
        setDmEvents((curr) => [...curr.slice(-50), { kind: "dm", msg: evt.data }]);
        // Notificacion del SO solo si el panel esta cerrado y no soy el remitente
        if (!dmOpen && evt.data?.sender_id !== me?.id) {
          notifyGrouped("HDS Chat", String(evt.data?.content ?? "Nuevo mensaje"));
        }
      } else if (evt.type === "dm_read") {
        setDmEvents((curr) => [...curr.slice(-50), {
          kind: "dm_read",
          by_user_id: evt.data?.by_user_id,
          up_to_id: evt.data?.up_to_id,
        }]);
      } else if (evt.type === "dm_buzz") {
        setWsLive(true);
        setDmEvents((curr) => [...curr.slice(-50), {
          kind: "dm_buzz",
          from_user_id: evt.data?.from_user_id,
          from_name: evt.data?.from_name ?? "Alguien",
          to_user_id: evt.data?.to_user_id,
        }]);
        // Si el panel esta cerrado y no soy yo el remitente -> notificar/abrir
        if (evt.data?.from_user_id !== me?.id) {
          if (!dmOpen) {
            notifyGrouped("HDS - Zumbido", `${evt.data?.from_name ?? "Alguien"} te llama!`);
            setDmOpen(true);
          }
        }
      } else if (evt.type === "presence") {
        setDmEvents((curr) => [...curr.slice(-50), {
          kind: "presence",
          user_id: evt.data?.user_id,
          online: !!evt.data?.online,
        }]);
      }
    });
    return () => { conn.close(); setWsLive(false); };
  }, [authed, dmOpen, me?.id]);

  // Cronómetro tracker (UI tick)
  useEffect(() => {
    if (!tracker || tracker.paused) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [tracker]);

  // Idle auto-pause: sólo activo cuando hay tracker corriendo y feature habilitada
  useEffect(() => {
    if (!tracker || tracker.paused || config.idleAutoPauseMs <= 0) {
      idleRef.current?.stop();
      idleRef.current = null;
      return;
    }
    idleRef.current = startIdleWatcher(
      config.idleAutoPauseMs,
      () => {
        // pausar
        const cur = trackerRef.current;
        if (!cur || cur.paused) return;
        const seg = Math.max(0, Math.round((Date.now() - cur.startedAt) / 1000));
        setTracker({ ...cur, accumulatedSec: cur.accumulatedSec + seg, startedAt: 0, paused: true });
        notifyGrouped("HDS", `Tracker pausado por inactividad (${Math.round(config.idleAutoPauseMs / 60000)} min)`);
      },
      () => {
        // resume
        const cur = trackerRef.current;
        if (!cur || !cur.paused) return;
        setTracker({ ...cur, startedAt: Date.now(), paused: false });
      },
    );
    return () => { idleRef.current?.stop(); idleRef.current = null; };
  }, [tracker?.ticketId, tracker?.paused]);

  async function changeStatus(t: Ticket, status: string) {
    try {
      await api.setStatus(t.id, status);
      setTickets((curr) => curr.map((x) => (x.id === t.id ? { ...x, status } : x)));
    } catch (e: any) { showError(e, "changeStatus"); }
  }

  function startTracker(ticketId: number, phase: Phase) {
    if (tracker) stopTracker();
    setTracker({ ticketId, phase, startedAt: Date.now(), accumulatedSec: 0, paused: false });
  }

  function togglePause() {
    const cur = trackerRef.current;
    if (!cur) return;
    if (cur.paused) {
      setTracker({ ...cur, startedAt: Date.now(), paused: false });
    } else {
      const seg = Math.max(0, Math.round((Date.now() - cur.startedAt) / 1000));
      setTracker({ ...cur, accumulatedSec: cur.accumulatedSec + seg, startedAt: 0, paused: true });
    }
  }

  async function stopTracker() {
    const cur = trackerRef.current;
    if (!cur) return;
    const seg = cur.paused ? 0 : Math.max(0, Math.round((Date.now() - cur.startedAt) / 1000));
    const total = cur.accumulatedSec + seg;
    try {
      if (total > 5) await api.logTime(cur.ticketId, total, cur.phase);
    } catch (e: any) {
      showError(e, "logTime");
    } finally {
      setTracker(null);
    }
  }

  async function doKeycloakLogin() {
    setBusyLogin(true);
    setError(null);
    try {
      await loginWithKeycloak();
      setAuthed(true);
    } catch (e: any) {
      showError(e, "login");
    } finally {
      setBusyLogin(false);
    }
  }

  function elapsedSecs(t: TrackerState): number {
    const seg = t.paused || !t.startedAt ? 0 : Math.round((now - t.startedAt) / 1000);
    return t.accumulatedSec + seg;
  }

  const STAFF_ROLES = ["admin", "team_admin", "project_manager", "analyst", "support", "developer"];
  const isStaff = !!me?.role && STAFF_ROLES.includes(me.role);
  const TRIAGE_ROLES = ["admin", "team_admin", "project_manager", "analyst"];
  const isTriager = !!me?.role && TRIAGE_ROLES.includes(me.role);

  // Poll del contador de triage para los roles autorizados.
  useEffect(() => {
    if (!authed || !isTriager) { setTriageCount(0); return; }
    let cancelled = false;
    async function tick() {
      try {
        const r = await api.triageCount();
        if (!cancelled) setTriageCount(r.count || 0);
      } catch { /* silencioso */ }
    }
    tick();
    const id = setInterval(tick, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [authed, isTriager]);

  if (!authed) {
    return (
      <div className="app">
        <div className="login">
          <h2>HDS Desktop</h2>
          <button
            className="primary"
            disabled={busyLogin}
            onClick={doKeycloakLogin}
            style={{ width: "100%", padding: "8px 0", marginBottom: 12 }}
          >
            {busyLogin ? "Esperando navegador..." : "Entrar con Keycloak"}
          </button>
          <details>
            <summary style={{ fontSize: 11, cursor: "pointer", color: "#888" }}>
              Login manual (token)
            </summary>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Pega tu token"
            />
            <button
              onClick={async () => {
                await setToken(tokenInput.trim());
                setAuthed(true);
              }}
            >
              Entrar con token
            </button>
          </details>
          {error && (
            <div style={{ color: "#f55", fontSize: 11, marginTop: 8 }}>
              {error}{" "}
              <button
                onClick={() => setErrorLogOpen(true)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#fbb",
                  textDecoration: "underline",
                  cursor: "pointer",
                  padding: 0,
                  fontSize: 11,
                }}
              >
                Detalles
              </button>
            </div>
          )}
        </div>
        {errorLogOpen && (
          <ErrorLogModal onClose={() => setErrorLogOpen(false)} />
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>
          HDS {wsLive && <span title="Realtime activo" style={{ color: "#3ba55c" }}>●</span>}
          {unread > 0 && (
            <>
              <span
                className="badge"
                role="button"
                tabIndex={0}
                title={`Abrir HDS web para ver tus ${unread} notificaciones`}
                style={{ cursor: "pointer" }}
                onClick={() => {
                  // Derivar URL web desde apiBase: quitar el sufijo /api si existe.
                  const webUrl = config.apiBase.replace(/\/api\/?$/, "/") || "https://hds.jumapa.in/";
                  openUrl(webUrl).catch((e) => showError(e, "open-browser"));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") (e.target as HTMLElement).click();
                }}
              >
                {unread}
              </span>
              <button
                title="Marcar todas las notificaciones como leídas"
                onClick={async () => {
                  try {
                    await api.markAllNotificationsRead();
                    setUnread(0);
                  } catch (e: any) {
                    showError(e, "markAllRead");
                  }
                }}
                style={{
                  marginLeft: 6,
                  padding: "2px 8px",
                  fontSize: 12,
                  background: "transparent",
                  border: "1px solid #555",
                  borderRadius: 4,
                  cursor: "pointer",
                  color: "#bbb",
                }}
              >
                ✓
              </button>
            </>
          )}
        </h1>
        {!isStaff && me && (
          <button
            className="primary"
            onClick={() => setNewTicketOpen(true)}
            title="Reportar un nuevo ticket"
          >
            ＋ Nuevo
          </button>
        )}
        <button
          onClick={() => setDmOpen(true)}
          title="Chat con otros usuarios conectados"
          style={{ position: "relative" }}
        >
          💬 Chat
          {dmUnread > 0 && (
            <span className="badge" style={{ marginLeft: 6 }}>{dmUnread}</span>
          )}
        </button>
        <button
          onClick={() => setErrorLogOpen(true)}
          title="Registro de errores"
          style={{ position: "relative" }}
        >
          Log
          {errorLogCount > 0 && (
            <span className="badge" style={{ marginLeft: 6 }}>{errorLogCount}</span>
          )}
        </button>
        {isTriager && (
          <button
            onClick={() => setTriageOpen(true)}
            title="Tickets pendientes de triage"
            style={{ position: "relative" }}
          >
            🔍 Triage
            {triageCount > 0 && (
              <span className="badge" style={{ marginLeft: 6, background: "#f97316" }}>{triageCount}</span>
            )}
          </button>
        )}
        <button
          onClick={async () => {
            await clearToken();
            setAuthed(false);
          }}
        >
          Salir
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: "8px 10px",
            background: "#5a1d1d",
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ flex: 1 }}>{error}</span>
          <button
            onClick={() => setErrorLogOpen(true)}
            title="Ver detalles tecnicos"
            style={{
              background: "transparent",
              border: "1px solid #a55",
              color: "#fdd",
              borderRadius: 4,
              padding: "2px 8px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Detalles
          </button>
          <button
            onClick={() => setError(null)}
            title="Ocultar"
            style={{
              background: "transparent",
              border: "none",
              color: "#fdd",
              cursor: "pointer",
              fontSize: 14,
              lineHeight: 1,
              padding: "0 4px",
            }}
          >
            x
          </button>
        </div>
      )}

      <div className="tickets">
        {tickets.length === 0 && (
          <div style={{ padding: 12, color: "#888" }}>No tienes tickets asignados.</div>
        )}
        {tickets.map((t) => {
          const isTracking = tracker?.ticketId === t.id;
          const elapsed = isTracking ? elapsedSecs(tracker!) : 0;
          return (
            <div className="ticket" key={t.id}>
              <div className="ticket-header">
                <span>#{t.id} · {STATUS_LABEL[t.status] ?? t.status}</span>
                <span>{t.priority ?? ""}</span>
              </div>
              <div className="ticket-title">{t.title}</div>

              <div className="actions">
                {isStaff ? (
                  <>
                    {t.status === "open" && (
                      <button className="primary" onClick={() => changeStatus(t, "in_progress")}>Tomar</button>
                    )}
                    {t.status === "in_progress" && (
                      <button className="primary" onClick={() => changeStatus(t, "resolved")}>Resolver</button>
                    )}
                    {t.status === "resolved" && (
                      <button onClick={() => changeStatus(t, "in_progress")}>Reabrir</button>
                    )}
                    {t.status !== "closed" && (
                      <button className="danger" onClick={() => changeStatus(t, "closed")}>Cerrar</button>
                    )}
                  </>
                ) : (
                  <>
                    {t.status !== "closed" && t.status !== "resolved" && (
                      <button
                        className="danger"
                        onClick={() => {
                          if (confirm(`¿Cancelar el ticket #${t.id}?`)) changeStatus(t, "closed");
                        }}
                      >
                        ✖ Cancelar
                      </button>
                    )}
                  </>
                )}
                <button onClick={() => setChatTicket(t.id)}>💬 Chat</button>
              </div>

              {isStaff && (
              <div className="tracker">
                {isTracking ? (
                  <>
                    <span>
                      ⏱ {tracker!.phase} · {fmt(elapsed)}
                      {tracker!.paused && <span style={{ color: "#faa61a", marginLeft: 6 }}>⏸ pausa</span>}
                    </span>
                    <button onClick={togglePause}>
                      {tracker!.paused ? "▶ Reanudar" : "⏸ Pausa"}
                    </button>
                    <button className="danger" onClick={stopTracker}>Detener</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => startTracker(t.id, "espera")}>▶ espera</button>
                    <button onClick={() => startTracker(t.id, "proceso")}>▶ proceso</button>
                    <button onClick={() => startTracker(t.id, "cierre")}>▶ cierre</button>
                  </>
                )}
              </div>
              )}
            </div>
          );
        })}
      </div>

      {chatTicket != null && (
        <ChatPanel
          ticketId={chatTicket}
          currentUserId={me?.id ?? null}
          onClose={() => setChatTicket(null)}
        />
      )}

      {dmOpen && (
        <DmPanel
          currentUserId={me?.id ?? null}
          onClose={() => setDmOpen(false)}
          events={dmEvents}
          onUnreadChange={setDmUnread}
        />
      )}

      {errorLogOpen && (
        <ErrorLogModal onClose={() => setErrorLogOpen(false)} />
      )}

      <TriageModal
        open={triageOpen}
        meId={me?.id}
        onClose={() => setTriageOpen(false)}
        onChanged={() => {
          api.triageCount().then((r) => setTriageCount(r.count || 0)).catch(() => {});
        }}
      />

      {newTicketOpen && (
        <NewTicketModal
          onClose={() => setNewTicketOpen(false)}
          onCreated={(t) => {
            setTickets((curr) => [t, ...curr]);
            // Refrescar desde server para asegurar consistencia (assignee/project resueltos por IA)
            api.myTickets().then(setTickets).catch(() => {});
          }}
        />
      )}
    </div>
  );
}

function fmt(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
