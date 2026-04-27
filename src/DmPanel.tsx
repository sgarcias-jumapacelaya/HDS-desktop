import { useEffect, useMemo, useRef, useState } from "react";
import { api, DmUserSummary, DmMessage } from "./api";

interface Props {
  currentUserId: number | null;
  onClose: () => void;
  /** Stream de eventos provenientes del WS de notificaciones. */
  events: DmEvent[];
  onUnreadChange?: (total: number) => void;
}

export type DmEvent =
  | { kind: "dm"; msg: DmMessage }
  | { kind: "dm_read"; by_user_id: number; up_to_id: number }
  | { kind: "presence"; user_id: number; online: boolean };

export default function DmPanel({ currentUserId, onClose, events, onUnreadChange }: Props) {
  const [users, setUsers] = useState<DmUserSummary[]>([]);
  const [activePeerId, setActivePeerId] = useState<number | null>(null);
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Cargar lista de usuarios al abrir
  useEffect(() => {
    let alive = true;
    api.dmUsers()
      .then((rows) => { if (alive) setUsers(rows); })
      .catch((e) => setError(e.message ?? String(e)));
    return () => { alive = false; };
  }, []);

  // Cuando cambia el peer activo: cargar historial + marcar leido
  useEffect(() => {
    if (activePeerId == null) { setMessages([]); return; }
    let alive = true;
    api.dmHistory(activePeerId)
      .then((rows) => { if (alive) setMessages(rows); })
      .catch((e) => setError(e.message ?? String(e)));
    api.dmMarkRead(activePeerId)
      .then(() => {
        if (!alive) return;
        setUsers((curr) => curr.map((u) => u.id === activePeerId ? { ...u, unread: 0 } : u));
      })
      .catch(() => { /* no critico */ });
    return () => { alive = false; };
  }, [activePeerId]);

  // Procesar eventos entrantes
  useEffect(() => {
    if (events.length === 0) return;
    const ev = events[events.length - 1];
    if (ev.kind === "presence") {
      setUsers((curr) => curr.map((u) => u.id === ev.user_id ? { ...u, online: ev.online } : u));
    } else if (ev.kind === "dm") {
      const m = ev.msg;
      const peerId = m.sender_id === currentUserId ? m.recipient_id : m.sender_id;

      // Si el mensaje pertenece a la conversacion abierta -> append y marcar leido
      if (peerId === activePeerId) {
        setMessages((curr) => curr.some((x) => x.id === m.id) ? curr : [...curr, m]);
        if (m.sender_id !== currentUserId) {
          api.dmMarkRead(peerId).catch(() => {});
        }
      } else if (m.sender_id !== currentUserId) {
        // No abierta y soy destinatario -> incrementar unread
        setUsers((curr) => curr.map((u) => u.id === peerId
          ? { ...u, unread: (u.unread ?? 0) + 1, last_message_at: m.created_at ?? new Date().toISOString() }
          : u));
      } else {
        // Lo envie yo (otra sesion/dispositivo) -> solo refrescar last_message_at
        setUsers((curr) => curr.map((u) => u.id === peerId
          ? { ...u, last_message_at: m.created_at ?? new Date().toISOString() }
          : u));
      }
    } else if (ev.kind === "dm_read") {
      // El peer marco mis mensajes como leidos -> actualizar UI (read_at)
      const peerId = ev.by_user_id;
      if (peerId === activePeerId) {
        setMessages((curr) => curr.map((x) =>
          x.sender_id === currentUserId && x.id <= ev.up_to_id && !x.read_at
            ? { ...x, read_at: new Date().toISOString() }
            : x
        ));
      }
    }
  }, [events, activePeerId, currentUserId]);

  // Recalcular total unread
  useEffect(() => {
    const total = users.reduce((acc, u) => acc + (u.unread ?? 0), 0);
    onUnreadChange?.(total);
  }, [users, onUnreadChange]);

  // Auto-scroll al final
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => {
      // unread primero
      if ((b.unread ?? 0) !== (a.unread ?? 0)) return (b.unread ?? 0) - (a.unread ?? 0);
      // luego por ultimo mensaje
      const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      if (bt !== at) return bt - at;
      // luego online
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (a.full_name ?? a.username).localeCompare(b.full_name ?? b.username);
    });
  }, [users]);

  async function send() {
    if (activePeerId == null) return;
    const content = text.trim();
    if (!content) return;
    setSending(true);
    try {
      const msg = await api.dmSend(activePeerId, content);
      setMessages((curr) => curr.some((x) => x.id === msg.id) ? curr : [...curr, msg]);
      setText("");
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setSending(false);
    }
  }

  const activePeer = users.find((u) => u.id === activePeerId) ?? null;

  return (
    <div className="chat-overlay">
      <div className="dm-panel">
        <div className="chat-header">
          <span>Chat de equipo</span>
          <button onClick={onClose}>✕</button>
        </div>
        {error && <div style={{ color: "#f55", padding: 6, fontSize: 11 }}>{error}</div>}

        <div className="dm-body">
          <div className="dm-users">
            {sortedUsers.length === 0 && (
              <div style={{ color: "#888", padding: 8, fontSize: 12 }}>Sin usuarios.</div>
            )}
            {sortedUsers.map((u) => (
              <div
                key={u.id}
                className={`dm-user ${activePeerId === u.id ? "active" : ""}`}
                onClick={() => setActivePeerId(u.id)}
              >
                <span className={`dm-dot ${u.online ? "on" : "off"}`} />
                <span className="dm-name">{u.full_name ?? u.username}</span>
                {u.unread > 0 && <span className="dm-badge">{u.unread}</span>}
              </div>
            ))}
          </div>

          <div className="dm-thread">
            {activePeer == null ? (
              <div style={{ color: "#888", padding: 12, fontSize: 12 }}>
                Selecciona un usuario para empezar a chatear.
              </div>
            ) : (
              <>
                <div className="dm-thread-head">
                  <span className={`dm-dot ${activePeer.online ? "on" : "off"}`} />
                  <strong>{activePeer.full_name ?? activePeer.username}</strong>
                  <span style={{ color: "#888", fontSize: 11, marginLeft: 6 }}>
                    {activePeer.online ? "en linea" : "desconectado"}
                  </span>
                </div>
                <div className="chat-list" ref={listRef}>
                  {messages.length === 0 && (
                    <div style={{ color: "#888", padding: 8, fontSize: 12 }}>Sin mensajes aun.</div>
                  )}
                  {messages.map((m) => {
                    const mine = m.sender_id === currentUserId;
                    return (
                      <div key={m.id} className={`chat-msg ${mine ? "mine" : ""}`}>
                        <div className="chat-bubble">{m.content}</div>
                        <div className="chat-meta" style={{ fontSize: 10 }}>
                          {m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                          {mine && (m.read_at ? " ✓✓" : " ✓")}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="chat-input">
                  <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                    placeholder={`Mensaje a ${activePeer.full_name ?? activePeer.username}...`}
                  />
                  <button className="primary" onClick={send} disabled={sending}>Enviar</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
