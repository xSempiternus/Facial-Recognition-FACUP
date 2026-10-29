// Escala de tiempo de las animaciones, solo para QA en desarrollo: ?lento=4 las hace 4 veces más lentas para poder
// capturar la coreografía cuadro a cuadro. En producción siempre es 1.

let cache: number | null = null;

export function k(): number {
  if (typeof window === "undefined") return 1;
  if (cache !== null) return cache;
  const v = process.env.NODE_ENV === "production" ? 0 : Number(new URLSearchParams(window.location.search).get("lento"));
  cache = v > 0 && v <= 20 ? v : 1;
  document.documentElement.style.setProperty("--k", String(cache));
  return cache;
}
