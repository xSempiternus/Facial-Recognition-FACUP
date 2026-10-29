"use client";

// Número con "rodillo" de dígitos: al cambiar, solo giran los dígitos que cambian (el viejo sale hacia arriba y el
// nuevo entra desde abajo). Ancho estable (tabular-nums) y sin layout shift.

import { AnimatePresence, motion } from "motion/react";
import { k } from "./tiempo";

export default function Rodillo({ valor, className }: { valor: number; className?: string }) {
  const T = k();
  const digitos = String(valor).split("");
  return (
    <span className={`tabular inline-flex ${className ?? ""}`} aria-label={String(valor)}>
      {digitos.map((d, i) => (
        // Clave por posición desde la derecha: 19 a 20 gira dos dígitos, 12 a 13 solo el último.
        <span key={digitos.length - i} className="relative inline-block h-[1.08em] overflow-hidden" aria-hidden>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={d}
              className="inline-block leading-[1.08]"
              initial={{ y: "105%", opacity: 0, filter: "blur(3px)" }}
              animate={{ y: "0%", opacity: 1, filter: "blur(0px)" }}
              exit={{ y: "-105%", opacity: 0, filter: "blur(3px)" }}
              transition={{ duration: 0.5 * T, ease: [0.22, 1, 0.36, 1] }}
            >
              {d}
            </motion.span>
          </AnimatePresence>
        </span>
      ))}
    </span>
  );
}
