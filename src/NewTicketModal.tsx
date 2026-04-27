import { useEffect, useState } from "react";
import { api, Project, Ticket } from "./api";

interface Props {
  onClose: () => void;
  onCreated: (t: Ticket) => void;
}

const PRIORITIES = [
  { value: "low", label: "Baja" },
  { value: "medium", label: "Media" },
  { value: "high", label: "Alta" },
  { value: "urgent", label: "Urgente" },
];

export default function NewTicketModal({ onClose, onCreated }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.projects()
      .then((rows) => { if (alive) setProjects(rows); })
      .catch(() => {/* dejar al backend asignar MDA por defecto */});
    return () => { alive = false; };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim() || !description.trim()) {
      setError("Titulo y descripcion son obligatorios");
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.createTicket({
        title: title.trim(),
        description: description.trim(),
        priority,
        ...(typeof projectId === "number" ? { project_id: projectId } : {}),
      });
      onCreated(created);
      onClose();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="chat-overlay">
      <form className="dm-panel" style={{ height: "auto", maxHeight: "90vh" }} onSubmit={submit}>
        <div className="chat-header">
          <span>Nuevo ticket</span>
          <button type="button" onClick={onClose}>✕</button>
        </div>

        <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" }}>
          <label style={{ fontSize: 12, color: "#aaa" }}>Titulo</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Resumen breve del problema"
            autoFocus
            maxLength={200}
          />

          <label style={{ fontSize: 12, color: "#aaa" }}>Descripcion</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Detalle del problema, pasos para reproducirlo, capturas si aplica..."
            rows={6}
            style={{
              background: "#15171b", color: "#e6e6e6", border: "1px solid #333",
              borderRadius: 4, padding: 8, fontFamily: "inherit", fontSize: 13, resize: "vertical",
            }}
          />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={{ fontSize: 12, color: "#aaa" }}>Prioridad</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                style={{ width: "100%", padding: 6, background: "#15171b", color: "#e6e6e6", border: "1px solid #333", borderRadius: 4 }}
              >
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            {projects.length > 0 && (
              <div>
                <label style={{ fontSize: 12, color: "#aaa" }}>Proyecto (opcional)</label>
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : "")}
                  style={{ width: "100%", padding: 6, background: "#15171b", color: "#e6e6e6", border: "1px solid #333", borderRadius: 4 }}
                >
                  <option value="">— Auto —</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {error && <div style={{ color: "#f55", fontSize: 12 }}>{error}</div>}
        </div>

        <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid #333", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} disabled={submitting}>Cancelar</button>
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? "Creando..." : "Crear ticket"}
          </button>
        </div>
      </form>
    </div>
  );
}
