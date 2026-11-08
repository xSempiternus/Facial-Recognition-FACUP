"use client";

import { useEffect } from "react";

type Sentinela = EventTarget & { release: () => Promise<void> };
type ConWakeLock = Navigator & { wakeLock: { request: (t: "screen") => Promise<Sentinela> } };

// Mantiene la pantalla encendida (Screen Wake Lock API) mientras `activo`. Se pierde al ocultar la pestaña: se pide de nuevo al volver.
// Si el navegador no la soporta (o la deniega) no hace nada.
export function usePantallaActiva(activo: boolean) {
  useEffect(() => {
    if (!activo || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let sentinela: Sentinela | null = null;
    let cancelado = false;

    async function pedir() {
      if (cancelado || document.visibilityState !== "visible" || sentinela) return;
      try {
        const s = await (navigator as ConWakeLock).wakeLock.request("screen");
        if (cancelado) {
          s.release().catch(() => {});
          return;
        }
        sentinela = s;
        s.addEventListener("release", () => {
          if (sentinela === s) sentinela = null;
        });
      } catch {
        /* denegado (batería baja, política): se ignora */
      }
    }
    const alVolver = () => {
      if (document.visibilityState === "visible") void pedir();
    };

    void pedir();
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      cancelado = true;
      document.removeEventListener("visibilitychange", alVolver);
      sentinela?.release().catch(() => {});
      sentinela = null;
    };
  }, [activo]);
}
