// Cámara frontal ("user") o trasera ("environment"): preferencia por dispositivo y apertura con degradación.

export type Facing = "user" | "environment";

const CLAVE = "facup:camara";

export function leerFacing(): Facing {
  try {
    return localStorage.getItem(CLAVE) === "environment" ? "environment" : "user";
  } catch {
    return "user";
  }
}

export function guardarFacing(f: Facing) {
  try {
    localStorage.setItem(CLAVE, f);
  } catch {}
}

/** Facing inicial: `?camara=trasera|frontal` manda (y se recuerda); si no, lo guardado en este dispositivo. */
export function facingInicial(): Facing {
  if (typeof window === "undefined") return "user";
  const q = new URLSearchParams(window.location.search).get("camara");
  if (q === "trasera" || q === "frontal") {
    const f: Facing = q === "trasera" ? "environment" : "user";
    guardarFacing(f);
    return f;
  }
  return leerFacing();
}

const rechazo = (e: unknown) =>
  e instanceof DOMException && ["OverconstrainedError", "ConstraintNotSatisfiedError", "NotFoundError", "DevicesNotFoundError"].includes(e.name);

/**
 * Abre la cámara pedida. Intenta `exact` (si el navegador lo soporta), luego `ideal`, luego sin medidas y al final `true`.
 * Devuelve también el facing efectivo (el que reporta el track; si no lo reporta, el pedido solo si `exact` funcionó),
 * que decide si la vista se espeja.
 */
export async function abrirCamara(facing: Facing, base: MediaTrackConstraints): Promise<{ stream: MediaStream; facing: Facing }> {
  const md = navigator.mediaDevices;
  const soportaExact = Boolean(md.getSupportedConstraints?.().facingMode);
  const intentos: { video: MediaTrackConstraints | boolean; exact: boolean }[] = [];
  if (soportaExact) intentos.push({ video: { ...base, facingMode: { exact: facing } }, exact: true });
  intentos.push({ video: { ...base, facingMode: { ideal: facing } }, exact: false });
  intentos.push({ video: { facingMode: { ideal: facing } }, exact: false });
  intentos.push({ video: true, exact: false });
  let ultimo: unknown;
  for (let i = 0; i < intentos.length; i++) {
    try {
      const stream = await md.getUserMedia({ video: intentos[i].video, audio: false });
      const reportado = stream.getVideoTracks()[0]?.getSettings().facingMode;
      const efectivo: Facing =
        reportado === "environment" || reportado === "user" ? reportado : intentos[i].exact || facing === "user" ? facing : "user";
      return { stream, facing: efectivo };
    } catch (e) {
      ultimo = e;
      if (!rechazo(e)) throw e;
    }
  }
  throw ultimo;
}

/** Cantidad de cámaras de video (los labels pueden venir vacíos antes del permiso; basta con contar). */
export async function contarCamaras(): Promise<number> {
  try {
    const l = await navigator.mediaDevices.enumerateDevices();
    return l.filter((d) => d.kind === "videoinput").length;
  } catch {
    return 0;
  }
}
