"use client";

// "Actividad reciente": últimas acciones registradas en la sede (auditoría, sin datos biométricos).

import { History } from "lucide-react";
import { api, fechaHora } from "@/lib/staff-api";
import { Alerta, Button, SkeletonRows, Vacio, useQuery } from "./ui";

const ACCIONES: Record<string, string> = {
  crear_invitado: "Niño nuevo anotado como invitado",
  anular_asistencia: "Asistencia anulada",
  editar_jugador: "Jugador editado",
  aprobar_solicitud: "Solicitud aprobada",
  rechazar_solicitud: "Solicitud rechazada",
  solicitud_recibida: "Solicitud recibida de una familia",
  resolver_disputa: "Disputa resuelta",
  no_soy_yo: "Un niño marcó «no soy yo»",
  borrar_jugador: "Jugador eliminado",
};

const legible = (a: string) => ACCIONES[a] ?? a.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function Actividad() {
  const q = useQuery(api.auditoria);
  return (
    <section className="s-card" aria-labelledby="act">
      <div className="s-card-h">
        <div>
          <h2 id="act" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <History size={15} aria-hidden /> Actividad reciente
          </h2>
          <p>Lo último que se hizo en el panel de esta sede.</p>
        </div>
        <Button sm onClick={q.reload}>
          Actualizar
        </Button>
      </div>
      {q.error && !q.data ? (
        <div className="s-card-b">
          <Alerta tono="err">
            {q.error.message} <Button sm onClick={q.reload}>Reintentar</Button>
          </Alerta>
        </div>
      ) : q.cargando && !q.data ? (
        <SkeletonRows n={4} />
      ) : !q.data?.length ? (
        <Vacio icono={<History size={18} />} titulo="Sin actividad todavía" />
      ) : (
        <ul className="s-act-list" style={{ maxHeight: 360, overflowY: "auto" }}>
          {q.data.slice(0, 50).map((a) => (
            <li key={a.id}>
              <time dateTime={a.fecha}>{fechaHora(a.fecha)}</time>
              <span>
                <b>{legible(a.accion)}</b>
                {a.detalle && <span className="muted"> · {a.detalle}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
