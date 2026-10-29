"use client";

// Lente de la cámara: un bisel de cristal alrededor del círculo (refracta la aurora), con las marcas del escáner
// encima. Detrás, un halo verde que crece mientras el niño se queda quieto. Al reconocerlo corre la secuencia de
// éxito: destello del borde, onda de luz, cascada de marcas, chispas e insignia. Los avisos son más discretos.

import { motion, useTransform, type MotionValue } from "motion/react";
import Chispas from "./Chispas";
import Escaner, { type EstadoEscaner } from "./Escaner";
import Insignia from "./Insignia";
import { useCalidad } from "./calidad";
import { k } from "./tiempo";
import type { Objetivo } from "./useRastreoCara";

const LUZ: Partial<Record<EstadoEscaner, string>> = {
  exito: "rgba(149,193,31,.3), rgba(0,141,54,.16) 38%",
  aviso: "rgba(245,176,74,.3), rgba(245,176,74,.1) 38%",
  error: "rgba(244,100,95,.3), rgba(244,100,95,.1) 38%",
};
const LUZ_SOBRIA = "rgba(111,184,148,.22), rgba(40,110,80,.1) 38%";

type Props = { objetivo: Objetivo; banda: number; progreso: MotionValue<number>; estado: EstadoEscaner; sobrio?: boolean };

export default function Lente({ objetivo, banda, progreso, estado, sobrio = false }: Props) {
  const calidad = useCalidad();
  const { cx, cy, r } = objetivo;
  const exterior = r + banda;
  const halo = useTransform(progreso, [0, 1], [0.2, 1]);
  const luz = estado === "exito" && sobrio ? LUZ_SOBRIA : LUZ[estado];
  const T = k();
  const exito = estado === "exito";
  const escaneando = estado === "quieto" || estado === "verificando";
  const dBarrido = (exterior - banda * 0.1) * 2; // el arco recorre el bisel

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
          background: "radial-gradient(circle, rgba(52,210,124,.4), rgba(0,141,54,.14) 35%, transparent 62%)",
          opacity: halo,
        }}
      />

      {/* Luz de resultado: se enciende de golpe y se apaga lento */}
      <motion.div
        className="pointer-events-none absolute inset-0"
        style={{ background: luz ? `radial-gradient(circle at ${cx}px ${cy}px, ${luz}, transparent 70%)` : undefined }}
        initial={false}
        animate={{ opacity: luz ? 1 : 0 }}
        transition={{ duration: (luz ? 0.35 : 1.2) * T, ease: "easeOut" }}
      />

      {/* Onda de luz: un anillo fino que se expande y se desvanece desde el lente al reconocer (dos, escalonadas) */}
      {exito &&
        (sobrio ? [0] : [0, 1]).map((i) => (
          <motion.div
            key={`onda${i}`}
            className="pointer-events-none absolute rounded-full"
            style={{
              left: cx - exterior,
              top: cy - exterior,
              width: exterior * 2,
              height: exterior * 2,
              border: `${i ? 1.5 : 2}px solid ${sobrio ? "rgba(111,184,148,.7)" : "rgba(120,240,160,.85)"}`,
              boxShadow: calidad === "bajo" ? undefined : `0 0 24px rgba(52,210,124,${sobrio ? 0.2 : 0.45}), inset 0 0 24px rgba(52,210,124,${sobrio ? 0.1 : 0.25})`,
            }}
            initial={{ opacity: 0.8 - i * 0.25, scale: 1 }}
            animate={{ opacity: 0, scale: sobrio ? 1.6 : 2.1 + i * 0.5 }}
            transition={{ duration: (1.2 + i * 0.2) * T, delay: (0.08 + i * 0.16) * T, ease: [0.16, 0.8, 0.3, 1] }}
          />
        ))}

      {/* Bisel de cristal: un anillo (el centro es la cámara). Toma el tinte del resultado. */}
      <div
        className="cristal pointer-events-none absolute rounded-full"
        data-tono={estado === "exito" || estado === "aviso" || estado === "error" ? estado : undefined}
        data-sobrio={sobrio ? "" : undefined}
        style={{
          left: cx - exterior,
          top: cy - exterior,
          width: exterior * 2,
          height: exterior * 2,
          WebkitMaskImage: `radial-gradient(circle, transparent ${r - 0.5}px, #000 ${r + 0.5}px)`,
          maskImage: `radial-gradient(circle, transparent ${r - 0.5}px, #000 ${r + 0.5}px)`,
        }}
      />

      {/* Destello suave del borde al reconocer: el canto del lente se enciende y se apaga */}
      {exito && (
        <motion.div
          key="destello"
          className="pointer-events-none absolute rounded-full"
          style={{
            left: cx - exterior,
            top: cy - exterior,
            width: exterior * 2,
            height: exterior * 2,
            boxShadow: `inset 0 0 0 2px rgba(255,255,255,.9), inset 0 0 ${banda}px rgba(180,255,190,.6)`,
            WebkitMaskImage: `radial-gradient(circle, transparent ${r - 0.5}px, #000 ${r + 0.5}px)`,
            maskImage: `radial-gradient(circle, transparent ${r - 0.5}px, #000 ${r + 0.5}px)`,
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: sobrio ? [0, 0.35, 0] : [0, 0.9, 0] }}
          transition={{ duration: 0.7 * T, times: [0, 0.25, 1], ease: "easeOut" }}
        />
      )}

      {/* Barrido de luz: un arco que gira suave mientras se escanea */}
      {calidad !== "bajo" && (
        <motion.div
          className="barrido"
          style={{
            left: cx - dBarrido / 2,
            top: cy - dBarrido / 2,
            width: dBarrido,
            height: dBarrido,
            WebkitMaskImage: `radial-gradient(circle, transparent ${r + banda * 0.18}px, #000 ${r + banda * 0.3}px, #000 ${r + banda * 0.72}px, transparent ${r + banda * 0.84}px)`,
            maskImage: `radial-gradient(circle, transparent ${r + banda * 0.18}px, #000 ${r + banda * 0.3}px, #000 ${r + banda * 0.72}px, transparent ${r + banda * 0.84}px)`,
          }}
          initial={false}
          animate={{ opacity: escaneando ? 1 : 0 }}
          transition={{ duration: 0.5 }}
        />
      )}

      <Escaner objetivo={objetivo} banda={banda} progreso={progreso} estado={estado} sobrio={sobrio} />

      {exito && !sobrio && calidad !== "bajo" && <Chispas objetivo={objetivo} cantidad={calidad === "alto" ? 22 : 12} />}

      {(estado === "exito" || estado === "aviso" || estado === "error") && (
        <Insignia objetivo={objetivo} tipo={estado === "exito" ? (sobrio ? "ya" : "exito") : estado} />
      )}
    </>
  );
}
