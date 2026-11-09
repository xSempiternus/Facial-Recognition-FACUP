// Seguimiento del staff: alertas «Para contactar» (GET/PATCH /alertas) y revisión de la tanda (GET/POST /revision/*).

import { apiFetch } from "@/lib/staff-api";

export type EstadoAlerta = "nueva" | "vista" | "contactada" | "cerrada";

export type Alerta = {
  id: number;
  jugador_id: number;
  nombre: string;
  categoria: string | null;
  tipo: "faltas_seguidas";
  valor: number | null;
  estado: EstadoAlerta;
  nota: string | null;
  creada_en: string;
  actualizada_por: string | null;
  actualizada_en: string | null;
  ultima_asistencia: string | null;
  contacto: { tutor: string | null; correo: string | null; telefono: string | null; otro: string | null } | null;
};

export type ConteoAlertas = { abiertas: number; por_contactar: number };

export type ItemRevision = {
  asistencia_id: number;
  jugador_id: number;
  nombre: string;
  categoria: string | null;
  timestamp: string;
  similitud: number | null;
};

export type RevisionHoy = {
  fecha: string;
  limite: number;
  total: number;
  revisados: number;
  seguros_sin_revisar: number;
  por_revisar: ItemRevision[];
};

async function json<T>(ruta: string, init?: RequestInit): Promise<T> {
  return (await apiFetch(ruta, init)).json() as Promise<T>;
}

function form(campos: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(campos)) f.append(k, v);
  return f;
}

export const apiSeguimiento = {
  alertas: () => json<{ umbral: number; alertas: Alerta[] }>("/alertas"),
  conteoAlertas: () => json<ConteoAlertas>("/alertas/resumen"),
  actualizarAlerta: (id: number, d: { estado?: EstadoAlerta; nota?: string }) => {
    const c: Record<string, string> = {};
    if (d.estado) c.estado = d.estado;
    // Un campo vacío llega como "no enviado" (400 sin_cambios): para borrar la nota se manda un espacio (el servidor lo normaliza a vacío).
    if (d.nota !== undefined) c.nota = d.nota.trim() === "" ? " " : d.nota;
    return json<Alerta>(`/alertas/${id}`, { method: "PATCH", body: form(c) });
  },
  revisionHoy: () => json<RevisionHoy>("/revision/hoy"),
  confirmarSeguros: () => json<{ confirmadas: number }>("/revision/confirmar-seguros", { method: "POST" }),
  revisar: (asistenciaId: number, accion: "confirmar" | "no_es") =>
    json<unknown>(`/revision/${asistenciaId}`, { method: "POST", body: form({ accion }) }),
};

// Globo de la navegación: las pantallas avisan cuando cambian las alertas (sin esperar al sondeo).
const EVENTO = "facup-alertas";

export function publicarAlertas(c: ConteoAlertas) {
  window.dispatchEvent(new CustomEvent<ConteoAlertas>(EVENTO, { detail: c }));
}

export function escucharAlertas(cb: (c: ConteoAlertas) => void) {
  const f = (e: Event) => cb((e as CustomEvent<ConteoAlertas>).detail);
  window.addEventListener(EVENTO, f);
  return () => window.removeEventListener(EVENTO, f);
}
