// Datos de la pantalla «Hoy»: el día de un vistazo (GET /metricas/hoy) y su recarga automática.

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { ApiError, aISO, api, apiFetch, type Asistencia } from "@/lib/staff-api";

export type LlegadaHoy = { id: number; nombre: string; categoria: string | null; hora: string; origen: string | null };
export type FaltaHoy = { id: number; nombre: string; categoria: string | null };
export type InvitadoHoy = { id: number; nombre: string; categoria: string | null; hora: string };

export type MetricasHoy = {
  fecha: string;
  esperados: number;
  porcentaje: number;
  llegaron: LlegadaHoy[];
  faltan: FaltaHoy[];
  invitados: InvitadoHoy[];
  por_revisar: { pendientes: number; solicitudes: number };
  ultima_llegada: string | null;
  acumulado: { hora: string; total: number }[];
  /** Alertas «Para contactar» abiertas (aditivo: backend nuevo). */
  alertas?: { abiertas: number; por_contactar: number };
  /** Revisión de la tanda: asistencias faciales de hoy revisadas por el staff (aditivo: backend nuevo). */
  revision?: { total: number; revisados: number; seguros_sin_revisar: number; por_revisar: number };
};

export async function metricasHoy(): Promise<MetricasHoy> {
  return (await (await apiFetch("/metricas/hoy")).json()) as MetricasHoy;
}

/** Id de la asistencia válida de hoy de un niño (si /metricas/hoy aún no trae `asistencia_id`). */
export async function asistenciaDeHoy(jugadorId: number): Promise<Asistencia | null> {
  const l = await api.asistencias(aISO(new Date()));
  const propias = l.filter((a) => a.jugador_id === jugadorId && (!a.estado || a.estado === "valida"));
  return propias.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] ?? null;
}

const CADA_MS = 10_000;

/** Carga las métricas de hoy y las repite cada ~10 s solo con la pestaña visible (y al volver a ella). Sin parpadeos: los datos previos se conservan. */
export function useHoy(clave: unknown) {
  const [data, setData] = useState<MetricasHoy | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const [cargando, setCargando] = useState(true);
  const pedir = useEffectEvent(metricasHoy);

  useEffect(() => {
    let vivo = true;
    let timer = 0;
    let enVuelo = false;
    const programar = () => {
      window.clearTimeout(timer);
      if (vivo && document.visibilityState === "visible") timer = window.setTimeout(cargar, CADA_MS);
    };
    async function cargar() {
      if (enVuelo || !vivo || document.visibilityState !== "visible") return;
      enVuelo = true;
      try {
        const d = await pedir();
        if (!vivo) return;
        setData(d);
        setError(undefined);
      } catch (e) {
        if (vivo) setError(e instanceof ApiError ? e : new ApiError(0, "error", "Algo salió mal."));
      } finally {
        enVuelo = false;
        if (vivo) setCargando(false);
        programar();
      }
    }
    const alVolver = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") void cargar();
    };
    document.addEventListener("visibilitychange", alVolver);
    void cargar();
    return () => {
      vivo = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", alVolver);
    };
    // `clave` y `tick` fuerzan una recarga inmediata
  }, [clave, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, cargando, reload };
}
