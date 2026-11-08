"use client";

import { Volume2, VolumeOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import { fijarSilencio, sonar, sonidoSilenciado, suscribirSonido } from "@/lib/sonidos";

/** Botón de vidrio para encender o apagar los sonidos de la interfaz. Se recuerda en el dispositivo. */
export default function BotonSonido({ className = "" }: { className?: string }) {
  const silencio = useSyncExternalStore(suscribirSonido, sonidoSilenciado, () => false);
  return (
    <button
      type="button"
      className={`reco-volver reco-sonido ${className}`.trim()}
      aria-label={silencio ? "Activar sonidos" : "Silenciar sonidos"}
      aria-pressed={silencio}
      onClick={(e) => {
        e.stopPropagation();
        fijarSilencio(!silencio);
        if (silencio) sonar("tap"); // confirma al encender
      }}
    >
      {silencio ? <VolumeOff size={20} strokeWidth={2} aria-hidden /> : <Volume2 size={20} strokeWidth={2} aria-hidden />}
    </button>
  );
}
