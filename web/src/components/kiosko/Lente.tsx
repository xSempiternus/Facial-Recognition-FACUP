"use client";

// Lente de la cámara: un bisel de cristal alrededor del círculo (desenfoca el fondo vivo que pasa por detrás),
// con las marcas del escáner encima. Detrás, un halo verde de marca que crece mientras el niño se queda quieto
// y se enciende entero al reconocerlo, como un foco de estadio.

import { motion, useTransform, type MotionValue } from "motion/react";
import Escaner, { type EstadoEscaner } from "./Escaner";
import type { Objetivo } from "./useRastreoCara";

const LUZ: Partial<Record<EstadoEscaner, string>> = {
  exito: "rgba(149,193,31,.55), rgba(0,141,54,.32) 38%",
  aviso: "rgba(242,169,59,.35), rgba(242,169,59,.12) 38%",
  error: "rgba(240,82,77,.35), rgba(240,82,77,.12) 38%",
};

type Props = { objetivo: Objetivo; banda: number; progreso: MotionValue<number>; estado: EstadoEscaner };

export default function Lente({ objetivo, banda, progreso, estado }: Props) {
  const { cx, cy, r } = objetivo;
  const exterior = r + banda;
  const halo = useTransform(progreso, [0, 1], [0.15, 0.85]);
  const luz = LUZ[estado];

  return (
    <>
      {/* Halo que acompaña el progreso */}
      <motion.div
        className="pointer-events-none absolute rounded-full"
        style={{
          left: cx - exterior * 1.9,
          top: cy - exterior * 1.9,
          width: exterior * 3.8,
          height: exterior * 3.8,
          background: "radial-gradient(circle, rgba(31,179,90,.32), rgba(0,141,54,.12) 35%, transparent 62%)",
          opacity: halo,
        }}
      />

      {/* Luz de resultado: se enciende de golpe y se apaga lento */}
      <motion.div
        className="pointer-events-none absolute inset-0"
        style={{ background: luz ? `radial-gradient(circle at ${cx}px ${cy}px, ${luz}, transparent 70%)` : undefined }}
        initial={false}
        animate={{ opacity: luz ? 1 : 0 }}
        transition={{ duration: luz ? 0.35 : 1.2, ease: "easeOut" }}
      />

      {/* Onda de gol: un anillo fino que se expande desde el lente al reconocer */}
      {estado === "exito" && (
        <motion.div
          key="onda"
          className="pointer-events-none absolute rounded-full border-2 border-verde-pantalla"
          style={{ left: cx - exterior, top: cy - exterior, width: exterior * 2, height: exterior * 2 }}
          initial={{ opacity: 0.7, scale: 1 }}
          animate={{ opacity: 0, scale: 2.6 }}
          transition={{ duration: 1.3, ease: [0.22, 1, 0.36, 1] }}
        />
      )}

      {/* Bisel de cristal: un anillo (el centro es la cámara) */}
      <div
        className="cristal pointer-events-none absolute rounded-full"
        style={{
          left: cx - exterior,
          top: cy - exterior,
          width: exterior * 2,
          height: exterior * 2,
          WebkitMaskImage: `radial-gradient(circle, transparent ${r - 0.5}px, #000 ${r + 0.5}px)`,
          maskImage: `radial-gradient(circle, transparent ${r - 0.5}px, #000 ${r + 0.5}px)`,
        }}
      />

      <Escaner objetivo={objetivo} banda={banda} progreso={progreso} estado={estado} />
    </>
  );
}
