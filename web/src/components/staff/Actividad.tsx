"use client";

// "Actividad reciente": últimas acciones registradas en la sede (auditoría, sin datos biométricos).

import { History } from "lucide-react";
import { api, fechaHora } from "@/lib/staff-api";
import { Alerta, Button, SkeletonRows, Vacio, useQuery } from "./ui";

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "2026-11-09 18:00:00" -> "9 nov" (sin hora ni ceros). */
function diaCorto(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MESES[Number(m[2]) - 1] ?? ""}`.trim() : null;
}

/** Traduce acción + detalle internos (con ids) a una frase para el staff. Sin ids visibles. */
function frase(accion: string, detalle: string): string {
  const d = detalle ?? "";
  switch (accion) {
    case "crear_invitado":
      if (d.includes("desde pendiente")) return "Un niño no reconocido se anotó como invitado";
      if (d.includes("manual")) return "Se marcó asistencia a mano a un niño nuevo (invitado)";
      return "Niño nuevo anotado como invitado";
    case "crear_enlace": {
      const dia = diaCorto(/vence=(\S+)/.exec(d)?.[1] ?? "");
      return `Se creó un enlace para padres${dia ? ` (vence el ${dia})` : ""}`;
    }
    case "revocar_enlace":
      return "Se desactivó un enlace para padres";
    case "solicitud_recibida":
      return "Una familia envió una inscripción";
    case "aprobar_solicitud":
      return d.includes("invitado convertido") ? "Se aprobó una inscripción (era invitado: conserva su asistencia)" : "Se aprobó una inscripción";
    case "rechazar_solicitud": {
      const motivo = d.includes(":") ? d.slice(d.indexOf(":") + 1).trim() : "";
      return `Se rechazó una inscripción${motivo ? ` (${motivo})` : ""}`;
    }
    case "anular_asistencia": {
      const motivo = d.includes(":") ? d.slice(d.indexOf(":") + 1).trim() : "";
      return `Se anuló una asistencia${motivo ? ` (${motivo})` : ""}`;
    }
    case "editar_jugador": {
      const campos = (d.split(":")[1] ?? "").split(",").map((c) => c.trim());
      const que = [campos.includes("nombre") && "el nombre", campos.includes("categoria") && "la categoría"].filter(Boolean).join(" y ");
      return que ? `Se cambió ${que} de un niño` : "Se editaron los datos de un niño";
    }
    case "resolver_disputa":
      if (d.endsWith("confirmada")) return "Se revisó una duda de reconocimiento: asistencia confirmada";
      if (d.endsWith("anulada")) return "Se revisó una duda de reconocimiento: asistencia anulada";
      return "Se revisó una duda de reconocimiento";
    case "no_soy_yo":
      return "Un niño marcó «no soy yo» en el kiosko";
    case "borrar_jugador":
      return "Se eliminó a un niño de la sede";
    case "aviso_kiosko":
      return d === "entrenador" ? "El kiosko pidió ayuda al entrenador" : d === "nuevo" ? "Un niño nuevo avisó en el kiosko" : d === "abandono" ? "Un aviso del kiosko venció sin respuesta" : "Aviso desde el kiosko";
    default:
      return accion.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  }
}

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
                <b>{frase(a.accion, a.detalle ?? "")}</b>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
