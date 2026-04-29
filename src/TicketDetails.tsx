import { useEffect, useState } from "react";
import { api, absoluteUrl, attachmentUrl, Ticket, TicketAttachment } from "./api";
import { open as openUrl } from "@tauri-apps/plugin-shell";

interface Props {
  ticket: Ticket;
}

// Extrae las URLs de imagenes embebidas en markdown ![alt](url) y
// tambien rutas /uploads/...png|jpg|jpeg|gif|webp|svg sueltas.
function extractInlineImages(desc: string | undefined): string[] {
  if (!desc) return [];
  const urls = new Set<string>();
  const mdRe = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(desc)) !== null) {
    if (/\.(png|jpe?g|gif|webp|svg|bmp)(\?|$)/i.test(m[1]) || m[1].startsWith("data:image/")) {
      urls.add(m[1]);
    }
  }
  const plainRe = /(\/uploads\/[^\s"')<>]+\.(?:png|jpe?g|gif|webp|svg|bmp))/gi;
  while ((m = plainRe.exec(desc)) !== null) {
    urls.add(m[1]);
  }
  return Array.from(urls);
}

// Limpia el markdown de imagenes para mostrar solo el texto plano legible.
function cleanDescription(desc: string | undefined): string {
  if (!desc) return "";
  return desc
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Resuelve una URL de imagen embebida en la descripción a una URL pública.
// Acepta data URIs, http(s), `/uploads/file/...`, `/uploads/...`, rutas
// absolutas del contenedor `/app/uploads/...` y nombres sueltos.
function resolveImageUrl(src: string): string {
  if (!src) return src;
  if (src.startsWith("data:") || /^https?:\/\//i.test(src)) return src;
  // Rutas absolutas del contenedor: extraer nombre y servir vía /uploads/file/
  const m = src.match(/(?:^|\/)uploads\/(?:[^/]+\/)*([^/?#]+)$/);
  if (m) return attachmentUrl(m[1]);
  return absoluteUrl(src);
}

function isImage(att: TicketAttachment): boolean {
  if (att.mimetype && att.mimetype.startsWith("image/")) return true;
  const name = (att.original_name || att.filename || "").toLowerCase();
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/.test(name);
}

function fmtSize(bytes?: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function TicketDetails({ ticket }: Props) {
  const [open, setOpen] = useState(false);
  const [attachments, setAttachments] = useState<TicketAttachment[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || attachments !== null) return;
    setLoading(true);
    api.ticketAttachments(ticket.id)
      .then((list) => setAttachments(list))
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, [open, ticket.id, attachments]);

  const inlineImages = extractInlineImages(ticket.description);
  const cleanText = cleanDescription(ticket.description);
  const hasContent = !!ticket.description || inlineImages.length > 0;

  if (!hasContent && !open) {
    // No hay descripcion ni imagenes; aun asi mostramos un botoncito
    // por si el usuario quiere ver adjuntos sueltos.
    return (
      <div style={{ marginTop: 4 }}>
        <button
          onClick={() => setOpen(true)}
          style={{ fontSize: 11, padding: "2px 6px" }}
        >
          📎 Ver adjuntos
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 6 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          fontSize: 11,
          padding: "2px 6px",
          background: "transparent",
          border: "1px solid #444",
          borderRadius: 4,
          color: "#ccc",
          cursor: "pointer",
        }}
      >
        {open ? "▲ Ocultar detalle" : "▼ Ver descripción / adjuntos"}
      </button>

      {open && (
        <div
          style={{
            marginTop: 6,
            padding: 8,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid #333",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          {cleanText && (
            <div style={{ whiteSpace: "pre-wrap", marginBottom: 8, color: "#ddd" }}>
              {cleanText}
            </div>
          )}

          {inlineImages.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: "#888", marginBottom: 4 }}>
                Imágenes en la descripción ({inlineImages.length})
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {inlineImages.map((src, i) => {
                  const url = resolveImageUrl(src);
                  return (
                    <a
                      key={i}
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        openUrl(url).catch(() => {});
                      }}
                      title="Abrir en navegador"
                    >
                      <img
                        src={url}
                        alt=""
                        style={{
                          maxWidth: 120,
                          maxHeight: 120,
                          objectFit: "cover",
                          border: "1px solid #444",
                          borderRadius: 4,
                          background: "#222",
                        }}
                        onError={(e) => { (e.currentTarget.style.display = "none"); }}
                      />
                    </a>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <div style={{ fontSize: 10, color: "#888", marginBottom: 4 }}>
              Adjuntos {loading ? "(cargando…)" : attachments ? `(${attachments.length})` : ""}
            </div>
            {error && <div style={{ color: "#f87171", fontSize: 11 }}>{error}</div>}
            {attachments && attachments.length === 0 && !error && (
              <div style={{ color: "#888", fontSize: 11 }}>Sin archivos adjuntos.</div>
            )}
            {attachments && attachments.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {attachments.map((a) => {
                  const url = attachmentUrl(a.filename);
                  const name = a.original_name || a.filename;
                  if (isImage(a)) {
                    return (
                      <div key={a.id} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <a
                          href="#"
                          onClick={(e) => { e.preventDefault(); openUrl(url).catch(() => {}); }}
                          title={name}
                        >
                          <img
                            src={url}
                            alt={name}
                            style={{
                              maxWidth: 80,
                              maxHeight: 60,
                              objectFit: "cover",
                              border: "1px solid #444",
                              borderRadius: 4,
                              background: "#222",
                            }}
                            onError={(e) => { (e.currentTarget.style.display = "none"); }}
                          />
                        </a>
                        <div style={{ fontSize: 11 }}>
                          <div>{name}</div>
                          <div style={{ color: "#888", fontSize: 10 }}>{fmtSize(a.size)}</div>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <a
                      key={a.id}
                      href="#"
                      onClick={(e) => { e.preventDefault(); openUrl(url).catch(() => {}); }}
                      style={{ fontSize: 11, color: "#93c5fd" }}
                      title={a.mimetype || ""}
                    >
                      📎 {name} <span style={{ color: "#888" }}>{fmtSize(a.size)}</span>
                    </a>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
