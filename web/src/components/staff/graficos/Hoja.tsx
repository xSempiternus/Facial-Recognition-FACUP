"use client";

// Hoja de detalle: ventana nativa (foco atrapado, Esc) que en móvil sube desde abajo.
import { X } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

const sub = () => () => {};

export function Hoja({ abierta, onCerrar, titulo, subtitulo, children }: { abierta: boolean; onCerrar: () => void; titulo: string; subtitulo?: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const montado = useSyncExternalStore(sub, () => true, () => false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (abierta && !d.open) d.showModal();
    if (!abierta && d.open) d.close();
  }, [abierta, montado]);
  const destino = montado ? (document.querySelector(".staff") ?? document.body) : null;
  if (!destino) return null;
  return createPortal(
    <dialog
      ref={ref}
      className="s-dialog sg-sheet"
      aria-label={titulo}
      onClose={onCerrar}
      onClick={(e) => {
        if (e.target === ref.current) onCerrar();
      }}
    >
      {abierta && (
        <>
          <div className="s-dialog-h sg-sheet-h">
            <div>
              <h2>{titulo}</h2>
              {subtitulo && <p className="muted">{subtitulo}</p>}
            </div>
            <button type="button" className="s-btn ghost sm icon" aria-label="Cerrar" onClick={onCerrar}>
              <X size={16} aria-hidden />
            </button>
          </div>
          <div className="s-dialog-b sg-sheet-b">{children}</div>
        </>
      )}
    </dialog>,
    destino,
  );
}
