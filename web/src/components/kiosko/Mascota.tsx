"use client";

// Mascota FA CUP. Pon las imágenes en public/mascota/<estado>.png (fondo transparente) y aparecen solas.
// Mientras no existan, no se muestra nada: el kiosko funciona igual.
// Más adelante se puede reemplazar por una animación Rive con estos mismos estados.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

export type EstadoMascota =
  | "bienvenida"
  | "buscando"
  | "celebra"
  | "de_nuevo"
  | "no_veo"
  | "foto_falsa"
  | "no_reconoce"
  | "error";

// Recuerda qué estados tienen imagen, para no volver a pedirlas en cada llegada.
const existe = new Map<EstadoMascota, boolean>();

export default function Mascota({ estado, tamaño = 180 }: { estado: EstadoMascota; tamaño?: number }) {
  const [disponibles, setDisponibles] = useState<Partial<Record<EstadoMascota, boolean>>>({});

  useEffect(() => {
    if (existe.has(estado)) return;
    const img = new Image();
    const anotar = (ok: boolean) => {
      existe.set(estado, ok);
      setDisponibles((d) => ({ ...d, [estado]: ok }));
    };
    img.onload = () => anotar(true);
    img.onerror = () => anotar(false);
    img.src = `/mascota/${estado}.png`;
  }, [estado]);

  const visible = disponibles[estado] ?? existe.get(estado) ?? false;

  return (
    <AnimatePresence mode="wait">
      {visible && (
        <motion.img
          key={estado}
          src={`/mascota/${estado}.png`}
          alt=""
          className="pointer-events-none select-none object-contain drop-shadow-[0_18px_30px_rgba(0,0,0,.45)]"
          style={{ height: tamaño, width: "auto" }}
          initial={{ opacity: 0, y: 24, scale: 0.9 }}
          animate={{ opacity: 1, y: [0, -8, 0], scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.95 }}
          transition={{ opacity: { duration: 0.3 }, scale: { duration: 0.4 }, y: { duration: 3.2, repeat: Infinity, ease: "easeInOut" } }}
        />
      )}
    </AnimatePresence>
  );
}
