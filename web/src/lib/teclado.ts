"use client";

// Teclado virtual del móvil: iOS y Chrome Android no encogen el viewport de layout al abrirlo, así que lo que está
// fijado abajo queda tapado. visualViewport sí refleja el área visible: se devuelve para ajustar hojas y diálogos.

import { useSyncExternalStore } from "react";

function suscribir(avisar: () => void) {
  const vv = window.visualViewport;
  window.addEventListener("resize", avisar);
  vv?.addEventListener("resize", avisar);
  vv?.addEventListener("scroll", avisar);
  return () => {
    window.removeEventListener("resize", avisar);
    vv?.removeEventListener("resize", avisar);
    vv?.removeEventListener("scroll", avisar);
  };
}
// "top|height" del área visible (px). Cadena vacía = sin visualViewport (se usa el layout normal).
const actual = () => {
  const vv = window.visualViewport;
  return vv ? `${Math.round(vv.offsetTop)}|${Math.round(vv.height)}` : "";
};

export function useAreaVisible(): { top: number; height: number } | null {
  const v = useSyncExternalStore(suscribir, actual, () => "");
  if (!v) return null;
  const [top, height] = v.split("|").map(Number);
  return { top, height };
}
