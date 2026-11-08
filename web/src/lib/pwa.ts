// Registro del service worker (public/sw.js). Solo en producción, o en desarrollo con ?sw=1.
// Actualización silenciosa: el SW nuevo se activa solo y la página nueva lo usa en la próxima navegación (sin recargas forzadas).

export function swHabilitado(): boolean {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return false;
  if (process.env.NODE_ENV === "production") return true;
  try {
    return new URLSearchParams(window.location.search).get("sw") === "1";
  } catch {
    return false;
  }
}

export async function registrarSW(): Promise<void> {
  try {
    if (!swHabilitado()) return;
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    // Kioskos que quedan abiertos días: buscar versión nueva cada hora.
    window.setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  } catch {
    /* sin SW la web funciona igual */
  }
}

// --- Instalación (usado por Ajustes) ---
export type EventoInstalar = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

export function estaInstalada(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function esIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
