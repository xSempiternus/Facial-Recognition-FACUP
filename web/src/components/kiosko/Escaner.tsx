"use client";

// Anillo del escáner (estilo Face ID): marcas finas grabadas en el bisel de cristal del lente. Se encienden en verde
// con brillo (bloom) a medida que el niño se queda quieto; al reconocerlo, una onda de luz recorre el anillo y lo deja
// encendido. El color es el único mensaje: verde = bien, ámbar = vuelve a intentar, rojo = avisa al staff.

import { motion, type MotionValue } from "motion/react";
import { useId } from "react";
import { useCalidad } from "./calidad";
import { k } from "./tiempo";
import type { Objetivo } from "./useRastreoCara";

export type EstadoEscaner = "espera" | "ajustando" | "quieto" | "verificando" | "exito" | "aviso" | "error";

const MARCAS = 96;

const COLOR_LLENO: Partial<Record<EstadoEscaner, string>> = {
  exito: "#3ddc84",
  aviso: "#f5b04a",
  error: "#f4645f",
};
const COLOR_SOBRIO = "#6fb894";
const COLOR_AVANCE = "#34d27c";

type Props = { objetivo: Objetivo; banda: number; progreso: MotionValue<number>; estado: EstadoEscaner; sobrio?: boolean };

export default function Escaner({ objetivo, banda, progreso, estado, sobrio = false }: Props) {
  const calidad = useCalidad();
  const id = useId().replace(/:/g, "");
  const { cx, cy, r } = objetivo;
  const R = r + banda / 2; // las marcas van al centro del bisel
  const LARGO = banda * 0.4; // largo radial de cada marca
  const ANCHO = Math.max(1.8, r * 0.012); // grosor de cada marca
  const C = 2 * Math.PI * R;
  const paso = C / MARCAS;
  const marcas = { strokeDasharray: `${ANCHO} ${paso - ANCHO}`, strokeWidth: LARGO, fill: "none" } as const;
  const lleno = estado === "exito" && sobrio ? COLOR_SOBRIO : COLOR_LLENO[estado];
  const base =
    estado === "espera" ? "rgba(255,255,255,0.2)" : estado === "ajustando" ? "rgba(255,255,255,0.42)" : "rgba(255,255,255,0.3)";
  const T = k();

  // Brillo (bloom): dos capas de sombra de color; en calidad media una sola y en baja ninguna.
  const bloom = (c: string, fuerte: number) =>
    calidad === "alto" ? `drop-shadow(0 0 3px ${c}) drop-shadow(0 0 ${fuerte}px ${c}aa)` : calidad === "medio" ? `drop-shadow(0 0 5px ${c}99)` : undefined;
  const respira = estado === "espera" || estado === "ajustando";

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
      <defs>
        {/* Arco que crece con el progreso: deja ver solo esa parte del anillo verde */}
        <mask id={`avance${id}`}>
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
        {/* Cabeza de luz que recorre el anillo una vez al reconocer (cascada de marcas encendidas) */}
        <mask id={`cascada${id}`}>
          <motion.circle
            key={estado}
            cx={cx}
            cy={cy}
            r={R}
            fill="none"
            stroke="#fff"
            strokeWidth={LARGO + 10}
            strokeDasharray={`${C * 0.3} ${C}`}
            initial={{ strokeDashoffset: C * 0.3 }}
            animate={{ strokeDashoffset: -C }}
            transition={{ duration: 0.95 * T, delay: 0.1 * T, ease: [0.4, 0.1, 0.3, 1] }}
            style={{ rotate: -90, transformOrigin: `${cx}px ${cy}px` }}
          />
        </mask>
      </defs>

      {/* Canto interior del bisel: una línea de luz donde el cristal toca la cámara */}
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={1} />

      {/* Marcas base (respiran suave en reposo) */}
      <g className={respira ? "respira" : undefined} style={{ transformOrigin: `${cx}px ${cy}px` }}>
        <motion.circle cx={cx} cy={cy} r={R} stroke={base} {...marcas} animate={{ stroke: base }} transition={{ duration: 0.4 }} />
      </g>

      {lleno ? (
        <>
          {/* Resultado: todas las marcas encendidas, con brillo que se asienta */}
          <motion.circle
            cx={cx}
            cy={cy}
            r={R}
            stroke={lleno}
            {...marcas}
            initial={{ opacity: 0.55 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 * T }}
            style={{ filter: bloom(lleno, sobrio ? 6 : 14) }}
          />
          {/* Cascada: la onda de luz clara recorre el anillo */}
          {estado === "exito" && !sobrio && (
            <circle cx={cx} cy={cy} r={R} stroke="#eaffc4" {...marcas} mask={`url(#cascada${id})`} style={{ filter: bloom("#c8f77a", 18) }} />
          )}
        </>
      ) : (
        <motion.g
          mask={`url(#avance${id})`}
          animate={{ opacity: estado === "verificando" ? [1, 0.55, 1] : 1 }}
          transition={estado === "verificando" ? { duration: 1.1, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }}
        >
          <circle cx={cx} cy={cy} r={R} stroke={COLOR_AVANCE} {...marcas} style={{ filter: bloom(COLOR_AVANCE, 10) }} />
        </motion.g>
      )}
    </svg>
  );
}
