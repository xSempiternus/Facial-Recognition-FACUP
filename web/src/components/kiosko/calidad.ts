"use client";

// Nivel de calidad visual del kiosko según el dispositivo: "alto" (escritorio/tablet potentes), "medio" y "bajo"
// (celulares de gama baja, "reducir movimiento"). Se estima al cargar (núcleos, memoria, pantalla, preferencias)
// y se corrige midiendo los FPS reales los primeros segundos. Se publica en <html data-calidad> para que el CSS
// reduzca blur y sombras, y en un store para que los componentes bajen el shader WebGL.

import { useSyncExternalStore } from "react";

export type Calidad = "alto" | "medio" | "bajo";
const ORDEN: Calidad[] = ["alto", "medio", "bajo"];

let actual: Calidad = "alto";
const oyentes = new Set<() => void>();
let iniciado = false;

function publicar(c: Calidad) {
  document.documentElement.dataset.calidad = c;
  if (c === actual) return;
  actual = c;
  oyentes.forEach((f) => f());
}

function estimar(): Calidad {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mq = (q: string) => window.matchMedia(q).matches;
  if (mq("(prefers-reduced-motion: reduce)")) return "bajo";
  const nucleos = nav.hardwareConcurrency ?? 8;
  const memoria = nav.deviceMemory ?? 8; // solo Chrome/Android; en iOS no existe
  const lado = Math.min(window.screen.width, window.screen.height);
  const tactil = mq("(pointer: coarse)");
  let puntos = 0; // más puntos = más débil
  if (nucleos <= 4) puntos += 2;
  else if (nucleos <= 6) puntos += 1;
  if (memoria <= 2) puntos += 2;
  else if (memoria <= 4) puntos += 1;
  if (lado < 600 && tactil) puntos += 1; // teléfono: pantalla densa y GPU compartida
  return puntos >= 4 ? "bajo" : puntos >= 2 ? "medio" : "alto";
}

/** Mide los FPS de ~2,5 s de animación real y baja un nivel si el dispositivo no da la talla. */
function medirFps() {
  let n = 0;
  let t0 = 0;
  const cuadro = (t: number) => {
    if (!t0) t0 = t;
    n++;
    if (t - t0 < 2500) return void requestAnimationFrame(cuadro);
    const fps = (n * 1000) / (t - t0);
    const i = ORDEN.indexOf(actual);
    if (fps < 20 && i < 2) publicar(ORDEN[Math.min(2, i + 2)]);
    else if (fps < 40 && i < 1) publicar(ORDEN[i + 1]);
  };
  // Espera a que pase la carga inicial (fuentes, modelo) para no culpar al arranque.
  setTimeout(() => document.visibilityState === "visible" && requestAnimationFrame(cuadro), 3500);
}

/** Se llama una vez en el cliente (idempotente). ?calidad=alto|medio|bajo lo fuerza (para QA). */
export function iniciarCalidad() {
  if (iniciado || typeof window === "undefined") return;
  iniciado = true;
  const forzada = new URLSearchParams(window.location.search).get("calidad");
  if (forzada === "alto" || forzada === "medio" || forzada === "bajo") return publicar(forzada);
  publicar(estimar());
  medirFps();
}

const suscribir = (f: () => void) => {
  oyentes.add(f);
  return () => void oyentes.delete(f);
};

export const calidadActual = () => actual;

export function useCalidad(): Calidad {
  return useSyncExternalStore(suscribir, () => actual, () => "alto" as Calidad);
}

/** Cámara: resolución ideal según el nivel (sin forzar: el navegador elige lo más cercano). */
export function restriccionesCamara(c: Calidad): MediaStreamConstraints {
  const ideal = c === "alto" ? { width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 640 }, height: { ideal: 480 } };
  return { video: { facingMode: "user", ...ideal, frameRate: { ideal: 30, max: 30 } }, audio: false };
}
