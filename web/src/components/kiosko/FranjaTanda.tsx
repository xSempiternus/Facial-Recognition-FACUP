"use client";

// Franja «Registrados ahora» del kiosko en modo tanda: tras reconocer, la tarjeta se recoge aquí (nombre + hora, los
// últimos 5) y el siguiente niño se escanea de inmediato. Cada ítem muestra su estado (seguro / lo revisará el staff)
// y, mientras su reporte de un solo uso siga vigente (~2 min), se puede tocar para avisar «No es él» (mismo flujo
// "¿No eres tú?": la asistencia queda en disputa y el staff decide). Sin sonidos. Con reduced motion, MotionConfig
// del kiosko deja solo fundidos.

import { AnimatePresence, motion } from "motion/react";
import { Check, Eye } from "lucide-react";
import { useEffect, useState } from "react";

export type EstadoItemTanda = "libre" | "enviando" | "avisado" | "limite" | "red";

export type ItemTanda = {
  id: string;
  nombre: string;
  hora: string; // "16:05"
  revisar: boolean; // aceptado con parecido justo: el staff lo verá en «Revisar»
  reporte: string | null; // token de un solo uso de /verify (2 min) para "No es él"
  t: number; // Date.now() del registro
  estado: EstadoItemTanda;
};

export const FRANJA_MAX = 5;
// El reporte vive 120 s en el servidor: se deja de ofrecer un poco antes para no prometer algo que ya no sirve.
export const REPORTE_VIGENCIA_MS = 110_000;

const EASE = [0.22, 1, 0.36, 1] as const;

/** Re-render cada 10 s mientras haya reportes vigentes (para apagar el "No es él" al vencer). */
function useAhora(activo: boolean) {
  // 0 en el prerender (sin valores inestables); se fija al montar en el navegador.
  const [ahora, setAhora] = useState(0);
  useEffect(() => {
    setAhora(Date.now()); // eslint-disable-line react-hooks/set-state-in-effect
    if (!activo) return;
    const id = setInterval(() => setAhora(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [activo]);
  return ahora;
}

type Props = {
  items: ItemTanda[];
  destacado: string | null; // el mismo niño volvió a pasar: su ítem se ilumina en vez de mostrar la tarjeta
  onNoEs: (item: ItemTanda) => void;
};

export default function FranjaTanda({ items, destacado, onNoEs }: Props) {
  const [abierto, setAbierto] = useState<string | null>(null);
  const ahora = useAhora(items.some((i) => i.reporte && i.estado !== "avisado"));
  if (items.length === 0) return null;
  const elegido = items.find((i) => i.id === abierto) ?? null;
  const vigente = (i: ItemTanda) => Boolean(i.reporte) && ahora - i.t < REPORTE_VIGENCIA_MS && i.estado !== "avisado";

  return (
    <div className="w-full max-w-[460px]" onClick={(e) => e.stopPropagation()}>
      <p className="reco-texto mb-1.5 px-1 text-[0.78rem] font-medium uppercase tracking-[0.08em] text-white/70">Registrados ahora</p>
      <ul className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]" aria-label="Registrados ahora">
        <AnimatePresence initial={false}>
          {items.map((i) => {
            const puede = vigente(i);
            const brilla = destacado === i.id;
            return (
              <motion.li
                key={i.id}
                layout
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.2 } }}
                transition={{ duration: 0.35, ease: EASE }}
                className="flex-none"
              >
                <button
                  type="button"
                  className={`flex min-h-[44px] items-center gap-2 rounded-full border py-1.5 pl-2 pr-3.5 text-left text-white backdrop-blur-md transition-colors duration-300 ${
                    brilla ? "border-white/70 bg-white/30" : abierto === i.id ? "border-white/50 bg-white/20" : "border-white/15 bg-black/35"
                  } ${i.estado === "avisado" ? "opacity-70" : ""}`}
                  aria-label={`${i.nombre}, ${i.hora}. ${
                    i.estado === "avisado" ? "Avisado al staff" : i.revisar ? "Lo revisará el staff" : "Registrado"
                  }${puede ? ". Toca si no era él" : ""}`}
                  aria-expanded={puede ? abierto === i.id : undefined}
                  disabled={!puede}
                  onClick={() => setAbierto(abierto === i.id ? null : i.id)}
                >
                  <span
                    className={`grid size-6 flex-none place-items-center rounded-full ${i.revisar || i.estado === "avisado" ? "bg-amber-300/90 text-black" : "bg-emerald-400/90 text-black"}`}
                    aria-hidden
                  >
                    {i.revisar || i.estado === "avisado" ? <Eye size={13} strokeWidth={2.5} /> : <Check size={14} strokeWidth={3} />}
                  </span>
                  <span className="flex flex-col leading-tight">
                    <span className="max-w-[9rem] truncate text-[0.95rem] font-semibold">{i.nombre}</span>
                    <span className="text-[0.75rem] text-white/75 tabular-nums">
                      {i.estado === "avisado" ? "Avisado" : i.hora}
                      {i.revisar && i.estado !== "avisado" ? " · revisar" : ""}
                    </span>
                  </span>
                </button>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>

      <AnimatePresence>
        {elegido && vigente(elegido) && (
          <motion.div
            key={elegido.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4, transition: { duration: 0.15 } }}
            transition={{ duration: 0.25, ease: EASE }}
            className="mt-2 flex items-center justify-between gap-3 rounded-2xl border border-white/15 bg-black/45 px-4 py-2.5 backdrop-blur-md"
            role="group"
            aria-label={`¿No era ${elegido.nombre}?`}
          >
            <span className="reco-texto text-[0.95rem] text-white">
              {elegido.estado === "red" ? "Sin conexión. ¿Reintentar?" : elegido.estado === "limite" ? "Hay muchos avisos. Avisa a tu entrenador." : `¿No era ${elegido.nombre}?`}
            </span>
            <span className="flex flex-none gap-2">
              <button type="button" className="reco-salir !min-h-[44px] !bg-white/10 !px-4 !text-[0.9rem]" onClick={() => setAbierto(null)}>
                Cancelar
              </button>
              <button
                type="button"
                className="reco-salir !min-h-[44px] !bg-white/25 !px-4 !text-[0.9rem] !font-semibold"
                disabled={elegido.estado === "enviando" || elegido.estado === "limite"}
                onClick={() => {
                  onNoEs(elegido);
                }}
              >
                {elegido.estado === "enviando" ? "Avisando…" : "Avisar al staff"}
              </button>
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
