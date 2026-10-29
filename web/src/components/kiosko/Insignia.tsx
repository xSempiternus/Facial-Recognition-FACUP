"use client";

// Insignia de vidrio en la esquina inferior derecha del círculo (como la de una notificación): el check se dibuja
// trazo a trazo y NO tapa la cara. Verde = llegada nueva; gris verdoso sobrio = ya registrado; ámbar/rojo = aviso.

import { motion } from "motion/react";
import { k } from "./tiempo";
import type { Objetivo } from "./useRastreoCara";

export type TipoInsignia = "exito" | "ya" | "aviso" | "error";

const FONDO: Record<TipoInsignia, string> = {
  exito: "linear-gradient(145deg, rgba(86,224,140,.95), rgba(0,141,54,.92))",
  ya: "linear-gradient(145deg, rgba(110,150,130,.9), rgba(38,74,58,.92))",
  aviso: "linear-gradient(145deg, rgba(250,196,100,.95), rgba(214,140,30,.92))",
  error: "linear-gradient(145deg, rgba(248,128,122,.95), rgba(200,60,56,.92))",
};
const SOMBRA: Record<TipoInsignia, string> = {
  exito: "rgba(0,141,54,.55)",
  ya: "rgba(0,0,0,.35)",
  aviso: "rgba(214,140,30,.45)",
  error: "rgba(200,60,56,.45)",
};

export default function Insignia({ objetivo, tipo }: { objetivo: Objetivo; tipo: TipoInsignia }) {
  const { cx, cy, r } = objetivo;
  const lado = Math.round(Math.min(72, Math.max(44, r * 0.36)));
  const d = r * Math.SQRT1_2; // esquina inferior derecha, sobre el borde del círculo
  const T = k();
  const trazo = { duration: 0.42 * T, delay: 0.62 * T, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <motion.div
      className="pointer-events-none absolute z-10 grid place-items-center rounded-full"
      style={{
        left: cx + d - lado / 2,
        top: cy + d - lado / 2,
        width: lado,
        height: lado,
        background: FONDO[tipo],
        boxShadow: `inset 0 1.5px 0 rgba(255,255,255,.55), inset 0 -6px 12px -6px rgba(0,0,0,.25), 0 0 0 1px rgba(255,255,255,.3), 0 0 0 5px rgba(3,20,18,.28), 0 8px 22px -4px ${SOMBRA[tipo]}`,
      }}
      initial={{ opacity: 0, scale: 0.4 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 280, damping: 22, delay: 0.38 * T }}
    >
      <svg viewBox="0 0 24 24" width={lado * 0.58} height={lado * 0.58} fill="none" stroke="#fff" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {tipo === "exito" && <motion.path d="M5.5 12.6 L10 17 L18.5 7.6" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={trazo} />}
        {tipo === "ya" && (
          <>
            <motion.path d="M3.5 12.8 L7.6 17 L15.4 8.6" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={trazo} />
            <motion.path d="M11.4 15.6 L12.6 17 L20.6 8.6" strokeOpacity={0.75} initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ ...trazo, delay: trazo.delay + 0.12 * T }} />
          </>
        )}
        {(tipo === "aviso" || tipo === "error") && (
          <>
            <motion.path d="M12 6.5 L12 13.2" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={trazo} />
            <motion.path d="M12 17.4 L12 17.5" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ ...trazo, delay: trazo.delay + 0.2 * T }} />
          </>
        )}
      </svg>
    </motion.div>
  );
}
