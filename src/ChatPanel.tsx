import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { connectTicketChat, Reconnectable } from "./ws";
import EmojiPicker from "./EmojiPicker";
import { friendlyMessage, logError } from "./errors";

interface ChatMsg {
  id: number;
  user_id?: number;
  user_name?: string;
  content: string;
  created_at?: string;
  // schema CommentResponse fallback fields
  author?: { id: number; full_name?: string; username?: string };
}

export default function ChatPanel({ ticketId, onClose, currentUserId }: {
  ticketId: number;
  onClose: () => void;
  currentUserId: number | null;
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    api.chatHistory(ticketId)
      .then((rows) => { if (alive) setMsgs(rows ?? []); })
      .catch((e) => setError(e.message ?? String(e)));
    return () => { alive = false; };
  }, [ticketId]);

  useEffect(() => {
    let conn: Reconnectable | null = null;
    conn = connectTicketChat(ticketId, (evt) => {
      if (evt.type === "chat") {
        setConnected(true);
        setMsgs((curr) => [...curr, evt.data]);
      }
    });
    return () => { conn?.close(); };
  }, [ticketId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  async function send() {
    const content = text.trim();
    if (!content) return;
    try {
      await api.chatSend(ticketId, content);
      setText("");
    } catch (e: any) {
      logError(e, "chatSend");
      setError(friendlyMessage(e));
    }
  }

  function insertEmoji(emoji: string) {
    const inp = inputRef.current;
    if (!inp) { setText((t) => t + emoji); return; }
    const start = inp.selectionStart ?? text.length;
    const end = inp.selectionEnd ?? text.length;
    setText(text.slice(0, start) + emoji + text.slice(end));
    requestAnimationFrame(() => {
      inp.focus();
      const pos = start + emoji.length;
      inp.setSelectionRange(pos, pos);
    });
  }

  function authorName(m: ChatMsg): string {
    return m.user_name ?? m.author?.full_name ?? m.author?.username ?? "?";
  }

  function isMine(m: ChatMsg): boolean {
    const id = m.user_id ?? m.author?.id;
    return currentUserId != null && id === currentUserId;
  }

  return (
    <div className="chat-overlay">
      <div className="chat-panel">
        <div className="chat-header">
          <span>Chat #{ticketId} {connected ? "🟢" : "🟡"}</span>
          <button onClick={onClose}>✕</button>
        </div>
        {error && <div style={{ color: "#f55", padding: 6, fontSize: 11 }}>{error}</div>}
        <div className="chat-list" ref={listRef}>
          {msgs.length === 0 && <div style={{ color: "#888", padding: 8, fontSize: 12 }}>Sin mensajes aún.</div>}
          {msgs.map((m) => (
            <div key={m.id} className={`chat-msg ${isMine(m) ? "mine" : ""}`}>
              <div className="chat-meta">{authorName(m)}</div>
              <div className="chat-bubble">{m.content}</div>
            </div>
          ))}
        </div>
        <div className="chat-input" style={{ position: "relative", display: "flex", gap: 4, alignItems: "center" }}>
          <button
            onClick={() => setShowEmoji((v) => !v)}
            title="Emojis"
            style={{ padding: "4px 8px" }}
          >😊</button>
          <input
            ref={inputRef}
            style={{ flex: 1 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Escribe un mensaje..."
          />
          <button className="primary" onClick={send}>Enviar</button>
          {showEmoji && (
            <EmojiPicker
              onPick={(e) => insertEmoji(e)}
              onClose={() => setShowEmoji(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
