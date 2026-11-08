// Datos y textos de la pantalla «Seguimiento»: resumen de asistencia por periodo, en lenguaje simple.

import { aISO, apiFetch, sumarDias } from "@/lib/staff-api";

export type JornadaResumen = { fecha: string; presentes: number; esperados: number; porcentaje: number; invitados: number };
export type EstadoDia = "presente" | "ausente";
export type NinoResumen = {
  id: number;
  nombre: string;
  categoria: string | null;
  estado: string;
  presentes: number;
  jornadas_total: number;
  porcentaje: number | null;
  racha_actual: number;
  faltas_seguidas: number;
  ultima_asistencia: string | null;
  dias: Record<string, EstadoDia>;
};
export type Resumen = {
  rango: { desde: string; hasta: string; categoria: string | null };
  totales: {
    ninos_activos: number;
    jornadas: number;
    promedio_asistencia: number;
    mejor_jornada: { fecha: string; porcentaje: number } | null;
    peor_jornada: { fecha: string; porcentaje: number } | null;
  };
  jornadas: JornadaResumen[];
  ninos: NinoResumen[];
  categorias: { categoria: string; presentes: number; esperados: number; porcentaje: number; ninos: number }[];
  llegada: { histograma: { hora: string; cantidad: number }[]; mediana: string | null };
  metodos: { reconocimiento: number; manual: number; correccion: number; invitado: number };
  en_riesgo: { id: number; nombre: string; categoria: string | null; faltas_seguidas: number }[];
};

export type Periodo = "4s" | "8s" | "todo";
export const PERIODOS: { valor: Periodo; texto: string; dias: number; frase: string }[] = [
  { valor: "4s", texto: "Últimas 4 semanas", dias: 28, frase: "las últimas 4 semanas" },
  { valor: "8s", texto: "Últimas 8 semanas", dias: 56, frase: "las últimas 8 semanas" },
  { valor: "todo", texto: "Todo (60 días)", dias: 60, frase: "los últimos 60 días" },
];

/** Rango del periodo (hoy no entra: está en curso) y el rango anterior de igual largo. */
export function rangos(p: Periodo, hoy = new Date()) {
  const dias = PERIODOS.find((x) => x.valor === p)!.dias;
  const h = aISO(hoy);
  const hasta = sumarDias(h, -1);
  const desde = sumarDias(h, -dias);
  return { desde, hasta, previo: { desde: sumarDias(desde, -dias), hasta: sumarDias(desde, -1) } };
}

function pedir(desde: string, hasta: string, categoria: string) {
  const q = new URLSearchParams({ desde, hasta });
  if (categoria) q.set("categoria", categoria);
  return apiFetch(`/metricas/resumen?${q}`).then((r) => r.json() as Promise<Resumen>);
}

/** Resumen del periodo + el anterior (solo para comparar; si falla, se omite la comparación). */
export async function cargarSeguimiento(p: Periodo, categoria: string) {
  const r = rangos(p);
  const [actual, previo] = await Promise.all([pedir(r.desde, r.hasta, categoria), pedir(r.previo.desde, r.previo.hasta, categoria).catch(() => null)]);
  return { actual, previo };
}

// ------------------------------------------------------------------ fechas y textos

const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const fechaLocal = (iso: string) => new Date(`${iso}T12:00:00`);

/** «mar 4 nov» */
export function fechaCorta(iso: string) {
  const d = fechaLocal(iso);
  return `${DIAS[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`;
}
export const partesFecha = (iso: string) => {
  const d = fechaLocal(iso);
  return { dia: DIAS[d.getDay()], num: d.getDate(), mes: MESES[d.getMonth()] };
};

export const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** Frase resumen en lenguaje natural. */
export function fraseResumen(actual: Resumen, previo: Resumen | null, frasePeriodo: string): string {
  const js = actual.jornadas;
  if (!js.length) return "";
  const prom = (f: (j: JornadaResumen) => number) => Math.round(js.reduce((s, j) => s + f(j), 0) / js.length);
  const pres = prom((j) => j.presentes);
  const esp = prom((j) => j.esperados);
  const pct = Math.round(actual.totales.promedio_asistencia);
  let txt = `En ${frasePeriodo} vinieron en promedio ${pres} de ${esp} niños (${pct}%)`;
  if (previo && previo.totales.jornadas > 0) {
    const dif = pct - Math.round(previo.totales.promedio_asistencia);
    txt += dif === 0 ? ", igual que el periodo anterior" : `, ${plural(Math.abs(dif), "punto", "puntos")} ${dif > 0 ? "más" : "menos"} que el periodo anterior`;
  }
  return `${txt}.`;
}

/** Mensaje amable para el apoderado (solo texto; no se envía nada). */
export function mensajeApoderado(nombre: string) {
  const primero = nombre.split(/\s+/)[0] ?? nombre;
  return `Hola, notamos que ${primero} no ha podido venir a las últimas jornadas y queremos saber cómo está. Lo esperamos pronto.`;
}

export const pct0 = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n)}%`);
