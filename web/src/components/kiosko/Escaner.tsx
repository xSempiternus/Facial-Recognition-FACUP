"use client";

// Anillo del escáner (estilo Face ID): marcas finas grabadas en el bisel de cristal del lente. Se encienden en verde
// a medida que el niño se queda quieto; al reconocerlo se completan y se dibuja un check. El color es el único
// mensaje: verde = bien, ámbar = vuelve a intentar, rojo = avisa al staff.

import { motion, type MotionValue } from "motion/react";
import type { Objetivo } from "./useRastreoCara";

export type EstadoEscaner = "espera" | "ajustando" | "quieto" | "verificando" | "exito" | "aviso" | "error";

const MARCAS = 90;

const COLOR_LLENO: Partial<Record<EstadoEscaner, string>> = {
  exito: "#1fb35a",
  aviso: "#f2a93b",
  error: "#f0524d",
};

type Props = { objetivo: Objetivo; banda: number; progreso: MotionValue<number>; estado: EstadoEscaner };

export default function Escaner({ objetivo, banda, progreso, estado }: Props) {
  const { cx, cy, r } = objetivo;
  const R = r + banda / 2; // las marcas van al centro del bisel
  const LARGO = banda * 0.36; // largo radial de cada marca
  const ANCHO = Math.max(1.6, r * 0.011); // grosor de cada marca
  const paso = (2 * Math.PI * R) / MARCAS;
  const marcas = { strokeDasharray: `${ANCHO} ${paso - ANCHO}`, strokeWidth: LARGO, fill: "none" } as const;
  const lleno = COLOR_LLENO[estado];
  const base =
    estado === "espera" ? "rgba(255,255,255,0.14)" : estado === "ajustando" ? "rgba(255,255,255,0.32)" : "rgba(255,255,255,0.22)";

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
      <defs>
        {/* Arco que crece con el progreso: deja ver solo esa parte del anillo verde */}
        <mask id="avance">
          <motion.circle
            cx={cx}
            cy={cy}
            r={R}
            fill="none"
            stroke="#fff"
            strokeWidth={LARGO + 10}
            style={{ pathLength: progreso, rotate: -90, transformOrigin: `${cx}px ${cy}px` }}
          />
        </mask>
      </defs>

      {/* Canto interior del bisel: una línea de luz donde el cristal toca la cámara */}
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth={1} />

      {/* Marcas base */}
      <motion.circle cx={cx} cy={cy} r={R} stroke={base} {...marcas} animate={{ stroke: base }} transition={{ duration: 0.4 }} />

      {/* Marcas que se encienden con el progreso (quieto) o todas a la vez (resultado) */}
      {lleno ? (
        <motion.circle
          cx={cx}
          cy={cy}
          r={R}
          stroke={lleno}
          {...marcas}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.35 }}
          style={{ filter: `drop-shadow(0 0 6px ${lleno}66)` }}
        />
      ) : (
        <motion.g
          mask="url(#avance)"
          animate={{ opacity: estado === "verificando" ? [1, 0.45, 1] : 1 }}
          transition={estado === "verificando" ? { duration: 1.1, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }}
        >
          <circle cx={cx} cy={cy} r={R} stroke="#1fb35a" {...marcas} style={{ filter: "drop-shadow(0 0 5px #1fb35a55)" }} />
        </motion.g>
      )}

      {/* Check de éxito, trazado de una vez */}
      {estado === "exito" && (
        <motion.path
          d={`M ${cx - r * 0.3} ${cy + r * 0.02} L ${cx - r * 0.07} ${cy + r * 0.25} L ${cx + r * 0.33} ${cy - r * 0.2}`}
          fill="none"
          stroke="#1fb35a"
          strokeWidth={Math.max(8, r * 0.055)}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.45, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
        />
      )}
    </svg>
  );
}
