// Recorte facial ALINEADO para el campo opcional `cara` de POST /verify (modo sombra en el backend).
// Se calcula en el celular con los landmarks que MediaPipe ya entrega: se rota para dejar los ojos horizontales y
// se recorta un cuadrado con cara completa (frente a mentón + margen), ojos a ~38 % de la altura. Sin espejo.
// Contrato backend: JPEG, ≤64 KB, lados 64..320 px. Aquí: 160x160. Nunca lanza: ante cualquier problema, null.

type Punto = { x: number; y: number };
type Fuente = HTMLVideoElement | HTMLCanvasElement;

const LADO = 160; // px del recorte (el backend acepta 64..320)
const CALIDAD = 0.9;
const CALIDAD_BAJA = 0.7;
const MAX_BYTES = 60 * 1024; // el backend tolera 64 KB; margen de seguridad
const MARGEN = 1.12; // lado del recorte = alto de la caja de landmarks * MARGEN (cara completa + algo de aire)
const OJOS_Y = 0.38; // altura relativa (desde arriba) a la que quedan los ojos
// Centros de iris de FaceLandmarker (478 puntos); sin iris se usa el promedio de las esquinas de cada ojo.
const IRIS_A = 468, IRIS_B = 473;
const ESQUINAS_A = [33, 133], ESQUINAS_B = [362, 263];

let lienzo: OffscreenCanvas | HTMLCanvasElement | null = null;

function centro(p: ArrayLike<Punto>, iris: number, esquinas: number[]): Punto | null {
  const i = p[iris];
  if (p.length > IRIS_B + 4 && i) return { x: i.x, y: i.y };
  const a = p[esquinas[0]], b = p[esquinas[1]];
  return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
}

function aBlob(c: OffscreenCanvas | HTMLCanvasElement, q: number): Promise<Blob | null> {
  if ("convertToBlob" in c) return c.convertToBlob({ type: "image/jpeg", quality: q });
  return new Promise((res) => c.toBlob(res, "image/jpeg", q));
}

/**
 * Recorte facial alineado (JPEG ~160x160) o null. El dibujo es síncrono (usa el cuadro actual de `fuente`); solo la
 * codificación es asíncrona. No lanza nunca.
 */
export async function recortarCara(fuente: Fuente, landmarks: ArrayLike<Punto> | null | undefined): Promise<Blob | null> {
  try {
    if (!landmarks || landmarks.length < 400) return null;
    const W = fuente instanceof HTMLVideoElement ? fuente.videoWidth : fuente.width;
    const H = fuente instanceof HTMLVideoElement ? fuente.videoHeight : fuente.height;
    if (!W || !H) return null;

    const o1 = centro(landmarks, IRIS_A, ESQUINAS_A);
    const o2 = centro(landmarks, IRIS_B, ESQUINAS_B);
    if (!o1 || !o2) return null;
    // izquierdo = el de menor x en la imagen sin espejo
    const [ei, ed] = o1.x <= o2.x ? [o1, o2] : [o2, o1];
    const eix = ei.x * W, eiy = ei.y * H, edx = ed.x * W, edy = ed.y * H;
    const dist = Math.hypot(edx - eix, edy - eiy);
    if (!(dist > 4)) return null;

    let y0 = 1, y1 = 0;
    for (let i = 0; i < landmarks.length; i++) {
      const y = landmarks[i].y;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const lado = (y1 - y0) * H * MARGEN;
    if (!Number.isFinite(lado) || lado < dist * 1.8 || lado > Math.max(W, H) * 2) return null;

    const ang = Math.atan2(edy - eiy, edx - eix);
    if (Math.abs(ang) > Math.PI / 3) return null; // cabeza demasiado ladeada: el recorte no sería fiable
    // Centro del recorte: punto medio de los ojos desplazado hacia abajo (eje del rostro) para dejar los ojos en OJOS_Y.
    const desp = (0.5 - OJOS_Y) * lado;
    const cx = (eix + edx) / 2 - Math.sin(ang) * desp;
    const cy = (eiy + edy) / 2 + Math.cos(ang) * desp;

    const c = (lienzo ??= typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(LADO, LADO) : Object.assign(document.createElement("canvas"), { width: LADO, height: LADO }));
    const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, LADO, LADO);
    ctx.imageSmoothingQuality = "high";
    ctx.translate(LADO / 2, LADO / 2);
    ctx.rotate(-ang); // deja los ojos horizontales
    const s = LADO / lado;
    ctx.scale(s, s);
    ctx.translate(-cx, -cy);
    ctx.drawImage(fuente, 0, 0, W, H);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    let blob = await aBlob(c, CALIDAD);
    if (blob && blob.size > MAX_BYTES) blob = await aBlob(c, CALIDAD_BAJA);
    return blob && blob.size > 0 && blob.size <= MAX_BYTES ? blob : null;
  } catch {
    return null;
  }
}
