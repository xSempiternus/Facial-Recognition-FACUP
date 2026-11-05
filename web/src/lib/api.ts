// Cliente de la API de reconocimiento (FastAPI). Next la expone en /api/* (ver next.config.ts).

export type Verificacion =
  | { ok: true; nombre: string; categoria: string | null; yaRegistrado: boolean; registradoALas: string | null; similitud?: number }
  | { ok: false; codigo: string; mensaje: string; similitud?: number };

const TIEMPO_MAX_MS = 18_000; // por intento (datos móviles lentos)
const INTENTOS = 2; // un reintento ante corte de red / timeout / 502-504
const ESPERA_REINTENTO_MS = 900;

/** Calienta la conexión (DNS/TLS/HTTP2) con el servidor antes de la primera foto. */
export function precalentar() {
  fetch("/api/kiosko/resumen", { cache: "no-store" }).catch(() => {});
}

const pausa = (ms: number, señal?: AbortSignal) =>
  new Promise<void>((res) => {
    const id = setTimeout(res, ms);
    señal?.addEventListener("abort", () => { clearTimeout(id); res(); }, { once: true });
  });

/** Un intento de POST con tope de espera propio (AbortSignal.timeout no existe en Safari antiguo) + cancelación externa. */
async function enviarUnaVez(form: FormData, señal?: AbortSignal): Promise<Response | null> {
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort(), TIEMPO_MAX_MS);
  const cancelar = () => ctl.abort();
  señal?.addEventListener("abort", cancelar, { once: true });
  try {
    return await fetch("/api/verify", { method: "POST", body: form, signal: ctl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(id);
    señal?.removeEventListener("abort", cancelar);
  }
}

/** Envía la foto. Reintenta una vez si la red falla; `alReintentar` permite mostrar "Sin conexión, reintentando…". */
export async function verificar(foto: Blob, señal?: AbortSignal, alReintentar?: () => void): Promise<Verificacion> {
  const form = new FormData();
  form.append("file", foto, "llegada.jpg");
  let resp: Response | null = null;
  for (let i = 0; i < INTENTOS; i++) {
    resp = await enviarUnaVez(form, señal);
    if (señal?.aborted) return { ok: false, codigo: "cancelado", mensaje: "Cancelado." };
    const reintentable = !resp || resp.status === 502 || resp.status === 503 || resp.status === 504;
    if (!reintentable || i === INTENTOS - 1) break;
    alReintentar?.();
    await pausa(ESPERA_REINTENTO_MS, señal);
  }
  if (!resp) return { ok: false, codigo: "sin_conexion", mensaje: "No se pudo conectar con el servidor." };
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
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort(), 8_000);
  try {
    const resp = await fetch("/api/kiosko/resumen", { cache: "no-store", signal: ctl.signal });
    if (!resp.ok) return null;
    const data = await resp.json();
    return typeof data?.llegadas_hoy === "number" ? data.llegadas_hoy : null;
  } catch {
    return null;
  } finally {
    clearTimeout(id);
  }
}
