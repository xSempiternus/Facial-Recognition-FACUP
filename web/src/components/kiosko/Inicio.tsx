"use client";

// Pantalla de inicio (cuando no hay nadie cerca): fotos de FA CUP Chile en 3D que se mueven solas y siguen la
// cabeza de quien pasa. Al acercarse alguien, la foto se cierra hacia el círculo central y deja ver la cámara
// (el mismo gesto que el "gol", al revés).

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import Foto3D, { type Seguimiento } from "./Foto3D";
import type { Objetivo } from "./useRastreoCara";

const FOTOS = [
  { src: "/inicio/manos-al-centro.jpg", profundidad: "/inicio/manos-al-centro-profundidad.png" },
  { src: "/inicio/campeones.jpg", profundidad: "/inicio/campeones-profundidad.png" },
];
const CAMBIO_MS = 14_000;
const EASE = [0.22, 1, 0.36, 1] as const;

type Props = { objetivo: Objetivo; seguimiento: Seguimiento; titulo: string; sub: string };

export default function Inicio({ objetivo, seguimiento, titulo, sub }: Props) {
  const { cx, cy, r } = objetivo;
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % FOTOS.length), CAMBIO_MS);
    return () => clearInterval(id);
  }, []);
  const foto = FOTOS[i];

  return (
    <motion.section
      className="absolute inset-0 z-10 overflow-hidden bg-noche"
      initial={{ clipPath: `circle(${r}px at ${cx}px ${cy}px)`, opacity: 0 }}
      animate={{ clipPath: `circle(150% at ${cx}px ${cy}px)`, opacity: 1 }}
      exit={{ clipPath: `circle(${r}px at ${cx}px ${cy}px)`, opacity: 0, transition: { duration: 0.75, ease: EASE } }}
      transition={{ duration: 1, ease: EASE }}
    >
      {/* Fotos con cruce suave entre una y otra */}
      <AnimatePresence>
        <motion.div
          key={foto.src}
          className="absolute inset-0"
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 1.6, ease: "easeInOut" }}
        >
          <Foto3D src={foto.src} profundidad={foto.profundidad} seguimiento={seguimiento} />
        </motion.div>
      </AnimatePresence>

      {/* Tono de cancha nocturna para que el texto se lea y todo hable el mismo idioma que la cámara */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(3,20,10,.78) 0%, rgba(3,20,10,.05) 24%, rgba(3,20,10,.1) 52%, rgba(3,20,10,.94) 100%)," +
            "radial-gradient(ellipse 90% 80% at 50% 45%, rgba(0,141,54,0) 40%, rgba(3,20,10,.55) 100%)",
        }}
      />

      {/* Círculo central: anticipa dónde irá la cara */}
      <motion.div
        className="pointer-events-none absolute rounded-full border-2 border-cal/40"
        style={{ width: r * 2, height: r * 2, left: cx - r, top: cy - r }}
        animate={{ scale: [1, 1.05, 1], opacity: [0.35, 0.7, 0.35] }}
        transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
      />

      <div className="absolute inset-x-0 bottom-[7vh] flex flex-col items-center px-6 text-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={titulo}
            initial={{ opacity: 0, y: 24, filter: "blur(10px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -14, filter: "blur(10px)" }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <h1 className="font-display text-[clamp(3.4rem,7.5vw,7rem)] font-bold leading-[0.9] text-white drop-shadow-[0_10px_40px_rgba(0,0,0,.6)]">
              {titulo}
            </h1>
            <p className="mt-4 text-[clamp(1.2rem,2vw,1.8rem)] text-cal/80">{sub}</p>
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.section>
  );
}
