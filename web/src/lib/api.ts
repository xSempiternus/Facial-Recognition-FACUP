// Cliente de la API de reconocimiento (FastAPI). Next la expone en /api/* (ver next.config.ts).

export type Verificacion =
  | { ok: true; nombre: string; categoria: string | null; yaRegistrado: boolean; registradoALas: string | null; similitud?: number }
  | { ok: false; codigo: string; mensaje: string; similitud?: number };

const TIEMPO_MAX_MS = 15_000;

/** Calienta la conexión (DNS/TLS/HTTP2) con el servidor antes de la primera foto. */
export function precalentar() {
  fetch("/api/kiosko/resumen", { cache: "no-store" }).catch(() => {});
}

export async function verificar(foto: Blob, señal?: AbortSignal): Promise<Verificacion> {
  const form = new FormData();
  form.append("file", foto, "llegada.jpg");
  // Tope de espera propio (AbortSignal.timeout no existe en Safari antiguo) + cancelación externa.
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort(), TIEMPO_MAX_MS);
  const cancelar = () => ctl.abort();
  señal?.addEventListener("abort", cancelar, { once: true });
  let resp: Response;
  try {
    resp = await fetch("/api/verify", { method: "POST", body: form, signal: ctl.signal });
  } catch {
    return { ok: false, codigo: "sin_conexion", mensaje: "No se pudo conectar con el servidor." };
  } finally {
    clearTimeout(id);
    señal?.removeEventListener("abort", cancelar);
  }
  const data = await resp.json().catch(() => ({}));
  if (resp.ok) {
    return {
      ok: true,
      nombre: data.nombre,
      categoria: data.categoria ?? null,
      yaRegistrado: Boolean(data.ya_registrado),
      registradoALas: data.registrado_a_las ?? null,
      similitud: data.similitud,
    };
  }
  const detalle = typeof data?.detail === "object" && data.detail ? data.detail : {};
  return {
    ok: false,
    codigo: detalle.codigo ?? (resp.status >= 500 ? "error_servidor" : "error"),
    mensaje: detalle.mensaje ?? `Error del servidor (${resp.status}).`,
    similitud: detalle.similitud,
  };
}

/** Cantidad de llegadas registradas hoy (null si el servidor no responde). */
export async function llegadasDeHoy(): Promise<number | null> {
  try {
    const resp = await fetch("/api/kiosko/resumen", { cache: "no-store" });
    if (!resp.ok) return null;
    const data = await resp.json();
    return typeof data?.llegadas_hoy === "number" ? data.llegadas_hoy : null;
  } catch {
    return null;
  }
}
