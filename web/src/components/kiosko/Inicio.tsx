"use client";

// Pantalla de inicio (cuando no hay nadie cerca): sobre el fondo vivo, un saludo grande abajo a la izquierda,
// como un protector de pantalla. Al acercarse alguien se desvanece y el lente de la cámara toma su lugar.

import { AnimatePresence, motion } from "motion/react";

const EASE = [0.22, 1, 0.36, 1] as const;

export default function Inicio({ titulo, sub }: { titulo: string; sub: string }) {
  return (
    <motion.section
      className="pointer-events-none absolute inset-0 z-10"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.5, ease: EASE } }}
      transition={{ duration: 1, ease: EASE }}
    >
      {/* Viñeta y degradado inferior para que el texto se lea sobre cualquier foto */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 90% 80% at 50% 40%, rgba(5,7,6,0) 40%, rgba(5,7,6,.6) 100%)," +
            "linear-gradient(180deg, rgba(5,7,6,.5) 0%, rgba(5,7,6,0) 22%, rgba(5,7,6,0) 50%, rgba(5,7,6,.9) 100%)",
        }}
      />

      <div className="absolute inset-x-0 bottom-0 px-[max(1.5rem,5vw)] pb-[max(2.5rem,8vh)]">
        <AnimatePresence mode="wait">
          <motion.div
            key={titulo}
            initial={{ opacity: 0, y: 16, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -10, filter: "blur(6px)" }}
            transition={{ duration: 0.6, ease: EASE }}
          >
            <h1 className="max-w-[14ch] text-[clamp(2.8rem,8vw,6rem)] font-semibold leading-[0.95] tracking-[-0.035em] text-texto">
              {titulo}
            </h1>
            <p className="mt-4 max-w-[34ch] [text-wrap:balance] text-[clamp(1.1rem,2.2vw,1.5rem)] leading-snug text-texto/70">{sub}</p>
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.section>
  );
}
