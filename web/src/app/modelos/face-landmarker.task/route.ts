import { connection } from "next/server";

const FUENTES_MODELO = [
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
];

export async function GET() {
  // Dinámico: se ejecuta al pedirlo, no al compilar (así el build no depende de internet).
  await connection();
  for (const url of FUENTES_MODELO) {
    try {
      const resp = await fetch(url, { next: { revalidate: 60 * 60 * 24 } });
      if (!resp.ok) continue;
      return new Response(resp.body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        },
      });
    } catch {
      // probar siguiente fuente
    }
  }

  return new Response("No se pudo obtener el modelo de reconocimiento facial.", {
    status: 502,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
