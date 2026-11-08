"use client";

import { motion } from "motion/react";
import { useId } from "react";

/** Progreso grande y limpio: «18 de 28». Se anima suave y se lee como imagen con texto. */
export function Anillo({ llegaron, esperados }: { llegaron: number; esperados: number }) {
  const id = useId();
  const frac = esperados > 0 ? Math.min(llegaron / esperados, 1) : 0;
  const R = 88;
  return (
    <div className="hy-anillo" role="img" aria-label={`${llegaron} de ${esperados} niños llegaron hoy`}>
      <svg viewBox="0 0 200 200" aria-hidden>
        <defs>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#008d36" />
            <stop offset="100%" stopColor="#95c11f" />
          </linearGradient>
        </defs>
        <circle className="hy-pista" cx="100" cy="100" r={R} fill="none" strokeWidth="14" />
        <motion.circle
          cx="100"
          cy="100"
          r={R}
          fill="none"
          strokeWidth="14"
          strokeLinecap="round"
          opacity={frac > 0 ? 1 : 0}
          stroke={`url(#g${id})`}
          transform="rotate(-90 100 100)"
          pathLength={1}
          strokeDasharray="1 1"
          initial={{ strokeDashoffset: 1 }}
          animate={{ strokeDashoffset: 1 - (frac > 0 ? Math.max(frac, 0.015) : 0) }}
          transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <div className="hy-anillo-t" aria-hidden>
        <b>{llegaron}</b>
        <span>de {esperados}</span>
      </div>
    </div>
  );
}
