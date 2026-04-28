import { useEffect, useState } from "react";
import {
  ErrorLogEntry,
  getErrorLog,
  clearErrorLog,
  subscribeErrorLog,
} from "./errors";

interface Props {
  onClose: () => void;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString();
}

export default function ErrorLogModal({ onClose }: Props) {
  const [entries, setEntries] = useState<ErrorLogEntry[]>(getErrorLog());

  useEffect(() => {
    return subscribeErrorLog(() => setEntries(getErrorLog()));
  }, []);

  async function copyAll() {
    const text = entries
      .map((e) => `[${fmtTime(e.timestamp)}] ${e.context ?? ""}\n${e.friendly}\n${e.technical}\n`)
      .join("\n---\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fallback silencioso
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 92vw)",
          maxHeight: "82vh",
          background: "#1f2128",
          color: "#ddd",
          borderRadius: 8,
          border: "1px solid #333",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid #333",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <strong style={{ flex: 1 }}>Registro de errores</strong>
          <button onClick={copyAll} disabled={entries.length === 0} title="Copiar al portapapeles">
            Copiar
          </button>
          <button onClick={() => clearErrorLog()} disabled={entries.length === 0}>
            Limpiar
          </button>
          <button onClick={onClose}>Cerrar</button>
        </div>
        <div style={{ padding: 12, overflowY: "auto", flex: 1 }}>
          {entries.length === 0 ? (
            <div style={{ color: "#888", fontSize: 13, textAlign: "center", padding: 24 }}>
              No hay errores registrados.
            </div>
          ) : (
            entries.map((e) => (
              <div
                key={e.id}
                style={{
                  marginBottom: 10,
                  padding: 10,
                  background: "#181a20",
                  border: "1px solid #2a2d36",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                <div style={{ display: "flex", gap: 8, color: "#888", fontSize: 11 }}>
                  <span>{fmtTime(e.timestamp)}</span>
                  {e.context && <span>· {e.context}</span>}
                  {typeof e.status === "number" && <span>· HTTP {e.status}</span>}
                </div>
                <div style={{ color: "#ffb4b4", margin: "4px 0", fontWeight: 500 }}>
                  {e.friendly}
                </div>
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    color: "#aaa",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontSize: 11,
                  }}
                >
                  {e.technical}
                </pre>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
