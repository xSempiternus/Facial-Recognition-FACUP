// Descarga de exportes de asistencia (Excel / PDF). Necesita el token: fetch autenticado + blob.

import { apiFetch, descargar } from "@/lib/staff-api";

export type FormatoExporte = "xlsx" | "pdf";

function nombreDe(resp: Response, respaldo: string) {
  const m = /filename="?([^";]+)"?/i.exec(resp.headers.get("Content-Disposition") ?? "");
  return m?.[1] ?? respaldo;
}

/** Descarga la asistencia del rango/categoría indicados. Lanza ApiError (mensaje ya en español) si falla. */
export async function exportarAsistencia(formato: FormatoExporte, desde: string, hasta: string, categoria: string) {
  const q = new URLSearchParams({ desde, hasta });
  if (categoria) q.set("categoria", categoria);
  const resp = await apiFetch(`/exportes/asistencia.${formato}?${q}`);
  const blob = await resp.blob();
  descargar(blob, nombreDe(resp, `asistencia_${desde}_${hasta}.${formato}`));
}
