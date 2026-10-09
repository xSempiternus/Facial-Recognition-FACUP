"use client";

// Líneas de cal de la cancha sobre el video. El círculo central es el objetivo: ahí va la cara.
// Al arrancar, las líneas se "pintan" una tras otra (único movimiento de entrada de la pantalla).

import { motion, useTransform, type MotionValue } from "motion/react";
import type { Objetivo, Postura } from "./useRastreoCara";

const CAL = "rgba(234, 245, 228, 0.22)";

const COLOR_ANILLO: Record<Postura, string> = {
  "sin-cara": "rgba(234, 245, 228, 0.55)",
  lejos: "#f5c518",
  cerca: "#f5c518",
  descentrado: "#f5c518",
  quieto: "#95c11f",
};

type Props = { ancho: number; alto: number; objetivo: Objetivo; progreso: MotionValue<number>; postura: Postura };

export default function Cancha({ ancho: W, alto: H, objetivo, progreso, postura }: Props) {
  const { cx, cy, r } = objetivo;
  const m = Math.round(Math.min(W, H) * 0.05); // margen de la línea de banda
  const areaAlto = H * 0.56;
  const areaAncho = W * 0.13;
  const chicaAlto = H * 0.26;
  const chicaAncho = W * 0.05;
  const arco = r * 0.55;

  const trazos = [
    // banda
    `M ${m} ${m} H ${W - m} V ${H - m} H ${m} Z`,
    // mitad de cancha, cortada por el círculo (no cruza la cara)
    `M ${cx} ${m} V ${cy - r - 14} M ${cx} ${cy + r + 14} V ${H - m}`,
    // áreas grandes y chicas
    `M ${m} ${cy - areaAlto / 2} H ${m + areaAncho} V ${cy + areaAlto / 2} H ${m}`,
    `M ${W - m} ${cy - areaAlto / 2} H ${W - m - areaAncho} V ${cy + areaAlto / 2} H ${W - m}`,
    `M ${m} ${cy - chicaAlto / 2} H ${m + chicaAncho} V ${cy + chicaAlto / 2} H ${m}`,
    `M ${W - m} ${cy - chicaAlto / 2} H ${W - m - chicaAncho} V ${cy + chicaAlto / 2} H ${W - m}`,
    // medialunas del área
    `M ${m + areaAncho} ${cy - arco * 0.8} A ${arco} ${arco} 0 0 1 ${m + areaAncho} ${cy + arco * 0.8}`,
    `M ${W - m - areaAncho} ${cy - arco * 0.8} A ${arco} ${arco} 0 0 0 ${W - m - areaAncho} ${cy + arco * 0.8}`,
    // córners
    `M ${m + 22} ${m} A 22 22 0 0 1 ${m} ${m + 22}`,
    `M ${W - m - 22} ${m} A 22 22 0 0 0 ${W - m} ${m + 22}`,
    `M ${m} ${H - m - 22} A 22 22 0 0 1 ${m + 22} ${H - m}`,
    `M ${W - m} ${H - m - 22} A 22 22 0 0 0 ${W - m - 22} ${H - m}`,
  ];

  const color = COLOR_ANILLO[postura];
  const brillo = useTransform(progreso, [0, 1], [0, 1]);

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <defs>
        <filter id="resplandor" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {trazos.map((d, i) => (
        <motion.path
          key={i}
          d={d}
          fill="none"
          stroke={CAL}
          strokeWidth={2}
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 1.1, delay: 0.15 + i * 0.07, ease: [0.22, 1, 0.36, 1] }}
        />
      ))}

      {/* Círculo central: marcas finas fijas + anillo de progreso que se llena quieto */}
      <motion.circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke="rgba(234, 245, 228, 0.35)"
        strokeWidth={2}
        strokeDasharray="2 9"
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 120, damping: 18, delay: 0.5 }}
        style={{ transformOrigin: `${cx}px ${cy}px` }}
      />
      <motion.circle
        cx={cx}
        cy={cy}
        r={r + 10}
        fill="none"
        stroke={color}
        strokeWidth={6}
        strokeLinecap="round"
        filter="url(#resplandor)"
        style={{ pathLength: progreso, rotate: -90, transformOrigin: `${cx}px ${cy}px`, opacity: brillo }}
        animate={{ stroke: color }}
        transition={{ duration: 0.3 }}
      />
      {/* Guía tenue mientras no hay cara, para invitar a acercarse */}
      <motion.circle
        cx={cx}
        cy={cy}
        r={r + 10}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        animate={{ opacity: postura === "quieto" ? 0 : [0.15, 0.5, 0.15] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
      />
    </svg>
  );
}
