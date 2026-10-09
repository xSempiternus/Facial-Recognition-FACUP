"use client";

// Resultado de la llegada.
// - Gol (registrado) y "de nuevo": el círculo central se expande hasta llenar la pantalla y el nombre entra
//   letra por letra, como en el marcador del estadio. Es el momento memorable del kiosko.
// - Tarjeta amarilla (vuelve a intentar) o roja (llama al staff): el árbitro la saca girando.

import { motion } from "motion/react";
import Mascota, { type EstadoMascota } from "./Mascota";
import type { Objetivo } from "./useRastreoCara";

export type Llegada =
  | { tipo: "gol" | "de-nuevo"; nombre: string; categoria: string | null; sub: string; mascota: EstadoMascota }
  | { tipo: "amarilla" | "roja"; titulo: string; sub: string; mascota: EstadoMascota };

const EASE = [0.22, 1, 0.36, 1] as const;

const esGol = (l: Llegada): l is Extract<Llegada, { nombre: string }> => l.tipo === "gol" || l.tipo === "de-nuevo";

export default function Resultado({ llegada, objetivo }: { llegada: Llegada; objetivo: Objetivo }) {
  return esGol(llegada) ? <Gol llegada={llegada} objetivo={objetivo} /> : <Tarjeta llegada={llegada} />;
}

function Gol({ llegada, objetivo }: { llegada: Extract<Llegada, { nombre: string }>; objetivo: Objetivo }) {
  const { cx, cy, r } = objetivo;
  const gol = llegada.tipo === "gol";
  const fondo = gol
    ? "radial-gradient(120% 120% at 50% 45%, #0aa845 0%, #008d36 38%, #00511f 100%)"
    : "radial-gradient(120% 120% at 50% 45%, #124526 0%, #0a2e18 50%, #03140a 100%)";
  const saludo = gol ? "¡Hola," : "¡Hola de nuevo,";

  return (
    <motion.div
      className="fixed inset-0 z-30 flex flex-col items-center justify-center overflow-hidden text-center"
      style={{ background: fondo }}
      initial={{ clipPath: `circle(${r}px at ${cx}px ${cy}px)` }}
      animate={{ clipPath: `circle(150% at ${cx}px ${cy}px)` }}
      exit={{ clipPath: `circle(0px at ${cx}px ${cy}px)`, transition: { duration: 0.5, ease: EASE } }}
      transition={{ duration: 0.9, ease: EASE }}
    >
      {/* Ondas de cal que salen del círculo central */}
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="absolute rounded-full border-2"
          style={{
            width: r * 2,
            height: r * 2,
            left: cx - r,
            top: cy - r,
            borderColor: gol ? "rgba(234,245,228,.5)" : "rgba(149,193,31,.6)",
          }}
          initial={{ scale: 1, opacity: 0.7 }}
          animate={{ scale: 4 + i * 1.5, opacity: 0 }}
          transition={{ duration: 1.8, delay: 0.25 + i * 0.22, ease: "easeOut" }}
        />
      ))}

      {/* La cancha sigue ahí: línea de mitad y círculo central gigante detrás del nombre */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
        <motion.line
          x1="50%" y1="0" x2="50%" y2="100%"
          stroke="rgba(234,245,228,.14)" strokeWidth={2}
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 0.3, duration: 0.9, ease: EASE }}
        />
        <motion.circle
          cx="50%" cy="50%" r="30%"
          fill="none" stroke="rgba(234,245,228,.16)" strokeWidth={2}
          initial={{ pathLength: 0, rotate: -90 }} animate={{ pathLength: 1 }} transition={{ delay: 0.35, duration: 1.1, ease: EASE }}
          style={{ transformOrigin: "50% 50%" }}
        />
      </svg>

      <div className="relative z-10 flex items-end gap-10 px-10">
        <Mascota estado={llegada.mascota} tamaño={220} />
        <div>
          {llegada.categoria && (
            <motion.span
              className="mb-4 inline-block rounded-full bg-lima px-4 py-1 font-display text-xl font-bold text-noche"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.4, type: "spring", stiffness: 300, damping: 18 }}
            >
              {llegada.categoria}
            </motion.span>
          )}
          <motion.p
            className="font-display text-[clamp(2rem,4vw,3.4rem)] font-bold leading-none text-cal/85"
            initial={{ opacity: 0, y: 20, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ delay: 0.45, duration: 0.6, ease: EASE }}
          >
            {saludo}
          </motion.p>
          <h1 className="relative font-display text-[clamp(4.5rem,12vw,11rem)] font-bold leading-[0.88] tracking-tight text-white">
            {/* Destello que barre el nombre una vez, como un reflector */}
            <motion.span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 -left-1/4 w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/45 to-transparent mix-blend-overlay"
              initial={{ x: "-60%", opacity: 0 }}
              animate={{ x: "420%", opacity: [0, 1, 1, 0] }}
              transition={{ delay: 1.15, duration: 1.1, ease: "easeInOut" }}
            />
            {[...llegada.nombre, "!"].map((letra, i) => (
              <motion.span
                key={i}
                className="inline-block"
                initial={{ opacity: 0, y: 60, rotateX: -70, filter: "blur(10px)" }}
                animate={{ opacity: 1, y: 0, rotateX: 0, filter: "blur(0px)" }}
                transition={{ delay: 0.6 + i * 0.045, type: "spring", stiffness: 260, damping: 20 }}
              >
                {letra === " " ? " " : letra}
              </motion.span>
            ))}
          </h1>
          <motion.p
            className="mt-5 text-[clamp(1.2rem,2vw,1.8rem)] text-cal/80"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.1, duration: 0.5 }}
          >
            {llegada.sub}
          </motion.p>
        </div>
      </div>
    </motion.div>
  );
}

function Tarjeta({ llegada }: { llegada: Extract<Llegada, { titulo: string }> }) {
  const amarilla = llegada.tipo === "amarilla";
  return (
    <motion.div
      className="fixed inset-0 z-30 flex items-center justify-center bg-noche/70 backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.35 } }}
    >
      <div className="flex items-center gap-14 px-10" style={{ perspective: 1200 }}>
        {/* La tarjeta del árbitro */}
        <motion.div
          className={`h-[clamp(200px,34vh,320px)] aspect-[3/4] rounded-2xl shadow-2xl ${amarilla ? "bg-amarilla" : "bg-roja"}`}
          style={{ boxShadow: `0 30px 80px -20px ${amarilla ? "rgba(245,197,24,.55)" : "rgba(229,72,77,.55)"}` }}
          initial={{ rotateY: 100, rotateZ: -25, y: 120, opacity: 0 }}
          animate={{ rotateY: 0, rotateZ: -8, y: 0, opacity: 1 }}
          transition={{ type: "spring", stiffness: 140, damping: 14 }}
        />
        <div className="max-w-[min(56vw,760px)]">
          <Mascota estado={llegada.mascota} tamaño={140} />
          <motion.h1
            className="font-display text-[clamp(2.8rem,5.5vw,5rem)] font-bold leading-[0.95] text-white"
            initial={{ opacity: 0, x: 40, filter: "blur(8px)" }}
            animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
            transition={{ delay: 0.2, duration: 0.6, ease: EASE }}
          >
            {llegada.titulo}
          </motion.h1>
          <motion.p
            className="mt-4 text-[clamp(1.2rem,2vw,1.7rem)] text-cal/75"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.45 }}
          >
            {llegada.sub}
          </motion.p>
        </div>
      </div>
    </motion.div>
  );
}
