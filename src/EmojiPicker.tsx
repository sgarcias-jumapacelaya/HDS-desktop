import { useEffect, useRef } from "react";

interface Props {
  onPick: (emoji: string) => void;
  onClose: () => void;
}

const EMOJIS = [
  "😀","😂","😅","😊","😍","😘","😎","🤔","😴","🤯",
  "😢","😭","😡","🤬","🥺","😱","😳","🤗","🤝","🙏",
  "👍","👎","👌","✌️","🤞","💪","👀","👋","🙌","🤲",
  "❤️","💔","💯","🔥","⭐","✨","⚡","💥","🎉","🎊",
  "✅","❌","⚠️","🚀","💡","📌","📎","📷","🔔","💤",
  "☕","🍕","🍺","🎯","🐛","🛠️","💻","📱","🤖","👻",
];

export default function EmojiPicker({ onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        bottom: 44,
        right: 8,
        background: "#1f2128",
        border: "1px solid #333",
        borderRadius: 8,
        padding: 6,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        display: "grid",
        gridTemplateColumns: "repeat(10, 1fr)",
        gap: 2,
        width: 280,
        zIndex: 100,
      }}
    >
      {EMOJIS.map((e) => (
        <button
          key={e}
          onClick={() => { onPick(e); }}
          title={e}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: 18,
            padding: 4,
            borderRadius: 4,
          }}
          onMouseEnter={(ev) => { (ev.currentTarget as HTMLElement).style.background = "#2a2d36"; }}
          onMouseLeave={(ev) => { (ev.currentTarget as HTMLElement).style.background = "transparent"; }}
        >
          {e}
        </button>
      ))}
    </div>
  );
}
