// Puntos de referencia de la cara (MediaPipe Face Landmarker, 478 puntos) que el kiosko dibuja como puntitos, y el
// "rastro" que el rastreo publica en cada análisis. Es un objeto mutable dentro de un ref: el dibujo del lienzo lo
// lee en su propio requestAnimationFrame, así no hay setState por cuadro.

// 20 puntos: contorno de los dos ojos (esquinas, párpado alto y bajo), nariz, boca, mentón, laterales y frente.
export const PUNTOS_REF = [
  33, 133, 159, 145, // ojo derecho del sujeto (a la izquierda en la imagen sin espejo)
  362, 263, 386, 374, // ojo izquierdo
  1, 168, 98, 327, // punta y puente de la nariz, aletas
  61, 291, 13, 14, // comisuras y labios
  152, // mentón
  234, 454, // laterales del rostro
  10, // frente
] as const;

export type Rastro = {
  hay: boolean; // hubo cara en el último análisis
  t: number; // performance.now() de ese análisis
  fija: boolean; // simulado (demo): nunca caduca
  ancho: number; // tamaño de la fuente (video) en px
  alto: number;
  espejo: boolean; // la cámara frontal se muestra en espejo
  pts: Float32Array; // PUNTOS_REF.length * 2, normalizados 0..1 respecto de la fuente
  caja: { x0: number; y0: number; x1: number; y1: number }; // bounding box de TODOS los landmarks, normalizado
};

export const crearRastro = (): Rastro => ({
  hay: false,
  t: 0,
  fija: false,
  ancho: 1,
  alto: 1,
  espejo: true,
  pts: new Float32Array(PUNTOS_REF.length * 2),
  caja: { x0: 0, y0: 0, x1: 1, y1: 1 },
});

/** Copia un rastro en otro (para congelar la cara al sacar la foto). */
export function copiarRastro(a: Rastro, b: Rastro) {
  b.hay = a.hay;
  b.t = a.t;
  b.fija = a.fija;
  b.ancho = a.ancho;
  b.alto = a.alto;
  b.espejo = a.espejo;
  b.pts.set(a.pts);
  b.caja.x0 = a.caja.x0;
  b.caja.y0 = a.caja.y0;
  b.caja.x1 = a.caja.x1;
  b.caja.y1 = a.caja.y1;
}

/** Del video (object-fit: cover, quizá en espejo) al escenario de W x H px: escala y recorte. */
export function cubrir(r: Rastro, W: number, H: number) {
  const s = Math.max(W / r.ancho, H / r.alto);
  return { s, dx: (W - r.ancho * s) / 2, dy: (H - r.alto * s) / 2 };
}
