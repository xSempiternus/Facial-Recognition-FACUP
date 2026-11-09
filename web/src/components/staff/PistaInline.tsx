"use client";

// Instructivo mínimo: una línea dentro del flujo (nunca modal ni overlay), con «¿Qué elijo?» que la expande a 2-3
// líneas. Se descarta con la X y la sede no la vuelve a ver (mismo registro que las guías; «Volver a ver las guías»
// la devuelve).

import { ChevronDown, Lightbulb, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { usePistaVista } from "./Tour";

export function PistaInline({ id, resumen, children }: { id: string; resumen: string; children?: ReactNode }) {
  const [visto, descartar] = usePistaVista(`pista-${id}`);
  const [abierta, setAbierta] = useState(false);
  const detalle = useId();
  if (visto) return null;
  return (
    <aside className="s-pista" aria-label="Consejo">
      <div className="s-pista-fila">
        <Lightbulb size={15} aria-hidden className="s-pista-ic" />
        <span className="s-pista-t">{resumen}</span>
        {children && (
          <button type="button" className="s-pista-mas" aria-expanded={abierta} aria-controls={detalle} onClick={() => setAbierta(!abierta)}>
            ¿Qué elijo? <ChevronDown size={14} aria-hidden />
          </button>
        )}
        <button type="button" className="s-pista-x" aria-label="Entendido, no mostrar más este consejo" title="Entendido" onClick={descartar}>
          <X size={15} aria-hidden />
        </button>
      </div>
      {children && abierta && (
        <div id={detalle} className="s-pista-det">
          {children}
        </div>
      )}
    </aside>
  );
}

/** Una opción del detalle: «Nombre» en negrita + una frase. */
export function PistaOpcion({ nombre, children }: { nombre: string; children: ReactNode }) {
  return (
    <p>
      <b>{nombre}</b> {children}
    </p>
  );
}
