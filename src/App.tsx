import { useEffect, useRef, useState } from "react";
import { api, Ticket, Phase } from "./api";
import { config } from "./config";
import { getToken, setToken, clearToken } from "./auth";
import { loginWithKeycloak } from "./oidc";
import { connectNotifications, Reconnectable } from "./ws";
import ChatPanel from "./ChatPanel";
import DmPanel, { DmEvent } from "./DmPanel";
import { configureFocus, notifyGrouped } from "./focusMode";
import { startIdleWatcher, IdleWatcher } from "./idle";

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
  const [me, setMe] = useState<{ id: number; full_name?: string } | null>(null);
  const [chatTicket, setChatTicket] = useState<number | null>(null);
  const [wsLive, setWsLive] = useState(false);
  const [dmOpen, setDmOpen] = useState(false);
  const [dmEvents, setDmEvents] = useState<DmEvent[]>([]);
  const [dmUnread, setDmUnread] = useState(0);
  const trackerRef = useRef<TrackerState | null>(null);
  const idleRef = useRef<IdleWatcher | null>(null);

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
    api.me().then((u) => setMe({ id: u.id, full_name: u.full_name })).catch(() => {});
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
        setError(e.message ?? String(e));
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
    } catch (e: any) { setError(e.message); }
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
      setError(e.message);
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
      setError(e.message ?? String(e));
    } finally {
      setBusyLogin(false);
    }
  }

  function elapsedSecs(t: TrackerState): number {
    const seg = t.paused || !t.startedAt ? 0 : Math.round((now - t.startedAt) / 1000);
    return t.accumulatedSec + seg;
  }

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
            <div style={{ color: "#f55", fontSize: 11, marginTop: 8 }}>{error}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>
          HDS {wsLive && <span title="Realtime activo" style={{ color: "#3ba55c" }}>●</span>}
          {unread > 0 && <span className="badge">{unread}</span>}
        </h1>
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
          onClick={async () => {
            await clearToken();
            setAuthed(false);
          }}
        >
          Salir
        </button>
      </div>

      {error && (
        <div style={{ padding: 8, background: "#5a1d1d", fontSize: 12 }}>{error}</div>
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
                <button onClick={() => setChatTicket(t.id)}>💬 Chat</button>
              </div>

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
    </div>
  );
}

function fmt(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
