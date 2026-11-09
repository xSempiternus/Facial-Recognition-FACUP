import { cabeceraSede } from "@/lib/sede";

// Cliente del formulario público de inscripción (padres). Rutas bajo /api/inscripcion*.

export type InfoInscripcion = {
  sede: { slug: string; nombre: string };
  categorias: string[];
  categoria_fija: string | null;
  expira: string;
  consentimiento: { version: string; texto: string };
  /** Autorización de comunicaciones (separada y opcional). Ausente en un backend anterior. */
  comunicaciones?: { version: string; texto: string };
  parentescos?: string[];
  fotos: { minimo: number; maximo: number; max_mb: number };
};

export type Parentesco = "" | "madre" | "padre" | "otro";

const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$/;

/** Correo en minúsculas o null (misma regla que el backend). */
export function normalizarCorreo(v: string): string | null {
  const c = v.trim();
  return c.length <= 254 && EMAIL_RE.test(c) ? c.toLowerCase() : null;
}

/** Celular chileno -> "+569XXXXXXXX" o null. Acepta 9XXXXXXXX, 569XXXXXXXX, +56 9 XXXX XXXX (igual que el backend). */
export function normalizarTelefono(v: string): string | null {
  let t = v.replace(/[\s().-]/g, "");
  if (t.startsWith("00")) t = t.slice(2);
  t = t.replace(/^\++/, "");
  if (t.length === 11 && t.startsWith("56")) t = t.slice(2);
  return /^9\d{8}$/.test(t) ? `+56${t}` : null;
}

/** "+56912345678" -> "+56 9 1234 5678" (solo para mostrar). */
export function telefonoLegible(t: string): string {
  const m = /^\+56(9)(\d{4})(\d{4})$/.exec(t);
  return m ? `+56 ${m[1]} ${m[2]} ${m[3]}` : t;
}

export class ErrorInscripcion extends Error {
  constructor(
    public codigo: string,
    mensaje: string,
    public campo?: string,
    public foto?: number,
  ) {
    super(mensaje);
  }
}

/** Mensajes claros por código (mandan sobre el texto del servidor cuando existen). */
const MENSAJES: Record<string, string> = {
  sin_consentimiento: "Debes aceptar la autorización para continuar.",
  faltan_fotos: "Necesitamos al menos 2 fotos del rostro.",
  formato_no_soportado: "Esa foto no es una imagen válida. Usa JPG, PNG o WEBP.",
  imagen_pesada: "Una de las fotos pesa demasiado. Vuelve a tomarla.",
  sin_rostro: "No detectamos una cara en una de las fotos. Repítela de frente y con buena luz.",
  varias_caras: "En una de las fotos sale más de una cara. Debe aparecer solo el niño o niña.",
  fotos_inconsistentes: "Una foto no parece de la misma persona que las demás. Cámbiala.",
  demasiados_intentos: "Demasiados intentos. Espera unos minutos y vuelve a intentar.",
  no_disponible: "Por ahora no podemos recibir más solicitudes. Inténtalo más tarde.",
  enlace_invalido: "Este enlace no es válido o venció. Pide uno nuevo al staff.",
};

async function leerError(resp: Response): Promise<ErrorInscripcion> {
  const data = await resp.json().catch(() => ({}));
  const d = typeof data?.detail === "object" && data.detail ? data.detail : {};
  let codigo: string = d.codigo ?? "";
  if (!codigo) codigo = resp.status === 413 ? "imagen_pesada" : resp.status === 429 ? "demasiados_intentos" : resp.status >= 500 ? "error_servidor" : "error";
  if (resp.status === 413) codigo = "imagen_pesada";
  const mensaje = codigo === "datos_invalidos" && d.mensaje ? d.mensaje : MENSAJES[codigo] ?? d.mensaje ?? `Error del servidor (${resp.status}).`;
  return new ErrorInscripcion(codigo, mensaje, d.campo, typeof d.foto === "number" ? d.foto : undefined);
}

/** Datos del enlace. Lanza ErrorInscripcion("enlace_invalido") en 404/410 y ErrorInscripcion("red") si no hay conexión. */
export async function infoInscripcion(token: string): Promise<InfoInscripcion> {
  let resp: Response;
  try {
    resp = await fetch(`/api/inscripcion/info?t=${encodeURIComponent(token)}`, { cache: "no-store", headers: cabeceraSede() });
  } catch {
    throw new ErrorInscripcion("red", "No se pudo conectar. Revisa tu internet e intenta de nuevo.");
  }
  if (resp.status === 404 || resp.status === 410) throw new ErrorInscripcion("enlace_invalido", MENSAJES.enlace_invalido);
  if (!resp.ok) throw await leerError(resp);
  return (await resp.json()) as InfoInscripcion;
}

export type DatosInscripcion = {
  token: string;
  nombreNino: string;
  anioNacimiento: string;
  categoria: string;
  tutorNombre: string;
  tutorCorreo: string;
  tutorTelefono: string;
  tutorParentesco: Parentesco;
  aceptaComunicaciones: boolean;
  fotos: Blob[];
};

/** Envía la solicitud. Devuelve el código de seguimiento. */
export async function enviarInscripcion(d: DatosInscripcion): Promise<string> {
  const form = new FormData();
  form.append("t", d.token);
  form.append("nombre_nino", d.nombreNino);
  form.append("anio_nacimiento", d.anioNacimiento);
  if (d.categoria) form.append("categoria", d.categoria);
  form.append("tutor_nombre", d.tutorNombre);
  form.append("tutor_correo", d.tutorCorreo);
  form.append("tutor_telefono", d.tutorTelefono);
  if (d.tutorParentesco) form.append("tutor_parentesco", d.tutorParentesco);
  form.append("consentimiento", "true");
  if (d.aceptaComunicaciones) form.append("acepta_comunicaciones", "true");
  d.fotos.forEach((f, i) => form.append(`foto${i + 1}`, f, `foto${i + 1}.jpg`));
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort(), 60_000);
  let resp: Response;
  try {
    resp = await fetch("/api/inscripcion", { method: "POST", body: form, signal: ctl.signal, headers: cabeceraSede() });
  } catch {
    throw new ErrorInscripcion("red", "No se pudo enviar. Revisa tu internet y toca Reintentar; no perdiste nada.");
  } finally {
    clearTimeout(id);
  }
  if (!resp.ok) throw await leerError(resp);
  const data = await resp.json().catch(() => ({}));
  return String(data?.codigo ?? "");
}

/** Reduce una imagen (lado mayor ≤ 1280 px, JPEG 0.85; baja la calidad hasta quedar bajo `maxMb`). Sin espejar. */
export async function reducirImagen(origen: Blob | HTMLVideoElement, maxMb: number): Promise<Blob> {
  let ancho: number, alto: number;
  let fuente: CanvasImageSource;
  let liberar = () => {};
  if (origen instanceof HTMLVideoElement) {
    ancho = origen.videoWidth;
    alto = origen.videoHeight;
    fuente = origen;
  } else {
    const bmp = await createImageBitmap(origen, { imageOrientation: "from-image" }).catch(() => null);
    if (bmp) {
      ancho = bmp.width;
      alto = bmp.height;
      fuente = bmp;
      liberar = () => bmp.close();
    } else {
      const url = URL.createObjectURL(origen);
      const img = new Image();
      await new Promise<void>((ok, mal) => {
        img.onload = () => ok();
        img.onerror = () => mal(new Error("imagen"));
        img.src = url;
      }).finally(() => URL.revokeObjectURL(url));
      ancho = img.naturalWidth;
      alto = img.naturalHeight;
      fuente = img;
    }
  }
  if (!ancho || !alto) throw new Error("imagen vacía");
  const esc = Math.min(1, 1280 / Math.max(ancho, alto));
  const cv = document.createElement("canvas");
  cv.width = Math.round(ancho * esc);
  cv.height = Math.round(alto * esc);
  const c = cv.getContext("2d");
  if (!c) throw new Error("canvas");
  c.drawImage(fuente, 0, 0, cv.width, cv.height);
  liberar();
  const limite = maxMb * 1024 * 1024;
  let calidad = 0.85;
  for (;;) {
    const blob = await new Promise<Blob | null>((ok) => cv.toBlob(ok, "image/jpeg", calidad));
    if (!blob) throw new Error("jpeg");
    if (blob.size < limite || calidad <= 0.4) return blob;
    calidad -= 0.15;
  }
}
