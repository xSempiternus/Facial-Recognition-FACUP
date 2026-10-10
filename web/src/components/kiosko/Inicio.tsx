"use client";

// Pantalla de inicio (cuando no hay nadie cerca): fotos de FA CUP Chile en 3D, oscurecidas y con tono de cine,
// que se mueven lento y siguen la cabeza de quien pasa. Al acercarse alguien, se desvanecen hacia la cámara.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import Foto3D, { type Seguimiento } from "./Foto3D";

const FOTOS = [
  { src: "/inicio/manos-al-centro.jpg", profundidad: "/inicio/manos-al-centro-profundidad.png" },
  { src: "/inicio/campeones.jpg", profundidad: "/inicio/campeones-profundidad.png" },
];
const CAMBIO_MS = 14_000;
const EASE = [0.22, 1, 0.36, 1] as const;

type Props = { seguimiento: Seguimiento; titulo: string; sub: string };

export default function Inicio({ seguimiento, titulo, sub }: Props) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % FOTOS.length), CAMBIO_MS);
    return () => clearInterval(id);
  }, []);
  const foto = FOTOS[i];

  return (
    <motion.section
      className="absolute inset-0 z-10 overflow-hidden bg-fondo"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.03, filter: "blur(8px)", transition: { duration: 0.7, ease: EASE } }}
      transition={{ duration: 1.2, ease: EASE }}
    >
      <AnimatePresence>
        <motion.div
          key={foto.src}
          className="absolute inset-0"
          style={{ filter: "brightness(0.62) saturate(0.72) contrast(1.06)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 2, ease: "easeInOut" }}
        >
          <Foto3D src={foto.src} profundidad={foto.profundidad} seguimiento={seguimiento} fuerza={0.04} />
        </motion.div>
      </AnimatePresence>

      {/* Viñeta y degradado inferior para el texto */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 85% 75% at 50% 42%, rgba(5,7,6,0) 35%, rgba(5,7,6,.7) 100%)," +
            "linear-gradient(180deg, rgba(5,7,6,.55) 0%, rgba(5,7,6,0) 22%, rgba(5,7,6,0) 55%, rgba(5,7,6,.92) 100%)",
        }}
      />

      <div className="absolute inset-x-0 bottom-[9vh] flex flex-col items-center px-6 text-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={titulo}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <h1 className="text-[clamp(2.6rem,5vw,4.4rem)] font-semibold leading-none tracking-[-0.025em] text-texto">{titulo}</h1>
            <p className="mt-3 text-[clamp(1.1rem,1.6vw,1.45rem)] text-texto/70">{sub}</p>
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.section>
  );
}
