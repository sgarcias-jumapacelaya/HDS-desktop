import { useEffect, useRef, useState } from "react";
import { api, TicketComment } from "./api";
import { friendlyMessage, logError } from "./errors";

interface Props {
  ticketId: number;
  currentUserId: number | null;
  canInternal: boolean;
  onClose: () => void;
  onAdded?: (c: TicketComment) => void;
}

function fmtDate(s?: string): string {
  if (!s) return "";
  try {
    return new Date(s).toLocaleString("es-MX", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return s; }
}

export default function CommentsPanel({ ticketId, currentUserId, canInternal, onClose, onAdded }: Props) {
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.ticketComments(ticketId)
      .then((rows) => { if (alive) setComments(rows ?? []); })
      .catch((e) => { if (alive) setError(friendlyMessage(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [ticketId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [comments.length]);

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  async function send() {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      const internal = canInternal && isInternal;
      const c = await api.addTicketComment(ticketId, content, internal);
      setComments((curr) => [...curr, c]);
      setText("");
      onAdded?.(c);
    } catch (e: any) {
      logError(e, "addTicketComment");
      setError(friendlyMessage(e));
    } finally {
      setSending(false);
    }
  }

  function authorName(c: TicketComment): string {
    return c.author?.full_name ?? c.author?.username ?? "?";
  }

  function isMine(c: TicketComment): boolean {
    const id = c.user_id ?? c.author?.id;
    return currentUserId != null && id === currentUserId;
  }

  return (
    <div className="chat-overlay">
      <div className="chat-panel">
        <div className="chat-header">
          <span>Comentarios · #{ticketId}</span>
          <button onClick={onClose}>✕</button>
        </div>

        {error && <div style={{ color: "#f55", padding: 6, fontSize: 11 }}>{error}</div>}

        <div className="chat-list" ref={listRef}>
          {loading && <div style={{ color: "#888", padding: 8, fontSize: 12 }}>Cargando…</div>}
          {!loading && comments.length === 0 && (
            <div style={{ color: "#888", padding: 8, fontSize: 12 }}>Aún no hay comentarios.</div>
          )}
          {comments.map((c) => (
            <div
              key={c.id}
              className={`chat-msg ${isMine(c) ? "mine" : ""}`}
              style={{ maxWidth: "92%" }}
            >
              <div className="chat-meta">
                {authorName(c)}
                {c.created_at && <span style={{ marginLeft: 6, color: "#666" }}>· {fmtDate(c.created_at)}</span>}
                {c.is_internal && (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 9,
                      padding: "1px 5px",
                      borderRadius: 3,
                      background: "#7c2d12",
                      color: "#fed7aa",
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    🔒 Nota interna
                  </span>
                )}
              </div>
              <div
                className="chat-bubble"
                style={c.is_internal ? {
                  background: "#3a2a1a",
                  border: "1px solid #7c2d12",
                  color: "#fde68a",
                } : undefined}
              >
                {c.content}
              </div>
            </div>
          ))}
        </div>

        <div className="chat-input" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              isInternal
                ? "Escribe una nota interna (no visible al solicitante)…"
                : "Escribe un comentario / respuesta…"
            }
            rows={3}
            style={{
              flex: 1,
              background: "#1e1f22",
              color: "white",
              border: `1px solid ${isInternal ? "#7c2d12" : "#1a1b1e"}`,
              borderRadius: 4,
              padding: "6px 8px",
              fontSize: 12,
              resize: "vertical",
              minHeight: 60,
              fontFamily: "inherit",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {canInternal && (
              <label style={{ fontSize: 11, color: "#ccc", display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={isInternal}
                  onChange={(e) => setIsInternal(e.target.checked)}
                />
                🔒 Nota interna
              </label>
            )}
            <span style={{ fontSize: 10, color: "#666", marginLeft: "auto" }}>Ctrl+Enter para enviar</span>
            <button className="primary" onClick={send} disabled={sending || !text.trim()}>
              {sending ? "Enviando…" : isInternal ? "Guardar nota" : "Agregar comentario"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
