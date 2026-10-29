"use client";

// Fondo vivo: las fotos 3D de FA CUP Chile siempre en movimiento detrás de todo. En el inicio se ven nítidas y
// siguen la cabeza de quien pasa; al acercarse alguien se desenfocan y se van atrás, como el fondo de pantalla
// del iPhone bajo el cristal. Un solo fondo para todo el kiosko: la transición entre pantallas es continua.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useCalidad } from "./calidad";
import Foto3D, { type Seguimiento } from "./Foto3D";

const FOTOS = [
  { src: "/inicio/manos-al-centro.jpg", profundidad: "/inicio/manos-al-centro-profundidad.png" },
  { src: "/inicio/campeones.jpg", profundidad: "/inicio/campeones-profundidad.png" },
];
const CAMBIO_MS = 14_000;
const EASE = [0.22, 1, 0.36, 1] as const;

export type ModoFondo = "inicio" | "escaneo" | "resultado" | "exito";

const ASPECTO: Record<ModoFondo, { filter: string; scale: number; opacity: number }> = {
  // Inicio: la foto, luminosa y viva (no turbia).
  inicio: { filter: "blur(0px) brightness(0.9) saturate(1.2) contrast(1.05)", scale: 1, opacity: 1 },
  // Escaneo: la foto casi se disuelve en la aurora, que es lo que el cristal refracta.
  escaneo: { filter: "blur(14px) brightness(1.05) saturate(1.6) contrast(1)", scale: 1.1, opacity: 0.22 },
  resultado: { filter: "blur(14px) brightness(1) saturate(1.4) contrast(1)", scale: 1.12, opacity: 0.22 },
  // Al reconocer, la cancha se enciende un poco tras el cristal.
  exito: { filter: "blur(8px) brightness(1.1) saturate(1.5) contrast(1.04)", scale: 1.05, opacity: 0.24 },
};

// Radio de desenfoque por nivel: el blur de pantalla completa cuesta caro en GPU de teléfono.
const BLUR_ESCALA = { alto: 1, medio: 0.5, bajo: 0.3 } as const;
const conBlur = (filter: string, k: number) => filter.replace(/blur\((\d+)px\)/, (_, n) => `blur(${Math.round(Number(n) * k)}px)`);

export default function FondoVivo({ seguimiento, modo }: { seguimiento: Seguimiento; modo: ModoFondo }) {
  const calidad = useCalidad();
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % FOTOS.length), CAMBIO_MS);
    return () => clearInterval(id);
  }, []);
  const foto = FOTOS[i];

  return (
    <motion.div
      className="absolute inset-0 overflow-hidden [will-change:filter,transform]"
      initial={false}
      animate={{
        ...ASPECTO[modo],
        filter: conBlur(ASPECTO[modo].filter, BLUR_ESCALA[calidad]),
        // Fuera del inicio la foto solo da un matiz: en gama baja se omite (queda la aurora) y en media se atenúa.
        opacity: modo === "inicio" ? 1 : ASPECTO[modo].opacity * (calidad === "bajo" ? 0 : calidad === "medio" ? 0.6 : 1),
      }}
      transition={{ duration: 1.1, ease: EASE }}
      aria-hidden
    >
      <AnimatePresence>
        <motion.div
          key={foto.src}
          className="absolute inset-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 2, ease: "easeInOut" }}
        >
          {/* Desenfocada no necesita resolución completa: se dibuja a la mitad y ahorra GPU en tablets */}
          <Foto3D
            src={foto.src}
            profundidad={foto.profundidad}
            seguimiento={seguimiento}
            fuerza={0.04}
            resolucion={modo === "inicio" || modo === "exito" ? 1 : 0.4}
          />
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}
