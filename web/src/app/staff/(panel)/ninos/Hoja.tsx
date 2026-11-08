"use client";

// Hoja inferior en móvil, ventana centrada en escritorio. Es un <dialog> nativo: foco atrapado y Esc gratis.

import { ArrowLeft, X } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/staff/ui";

const subVacio = () => () => {};

export function Hoja({
  abierto,
  onCerrar,
  titulo,
  onAtras,
  children,
  pie,
  alta,
}: {
  abierto: boolean;
  onCerrar: () => void;
  titulo: string;
  onAtras?: () => void;
  children: ReactNode;
  pie?: ReactNode;
  /** Ocupa casi toda la pantalla en móvil (cámara). */
  alta?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const montado = useSyncExternalStore(subVacio, () => true, () => false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (abierto && !d.open) d.showModal();
    if (!abierto && d.open) d.close();
  }, [abierto, montado]);
  const destino = montado ? (document.querySelector(".staff") ?? document.body) : null;
  if (!destino) return null;
  return createPortal(
    <dialog
      ref={ref}
      className={`s-dialog nn-sheet${alta ? " alta" : ""}`}
      aria-label={titulo}
      onClose={onCerrar}
      onClick={(e) => {
        if (e.target === ref.current) onCerrar();
      }}
    >
      {abierto && (
        <>
          <div className="s-dialog-h nn-sheet-h">
            {onAtras && (
              <Button icono sm variante="ghost" aria-label="Volver" onClick={onAtras}>
                <ArrowLeft size={18} aria-hidden />
              </Button>
            )}
            <h2>{titulo}</h2>
            <Button icono sm variante="ghost" aria-label="Cerrar" onClick={onCerrar}>
              <X size={18} aria-hidden />
            </Button>
          </div>
          <div className="s-dialog-b">{children}</div>
          {pie && <div className="s-dialog-f nn-sheet-f">{pie}</div>}
        </>
      )}
    </dialog>,
    destino,
  );
}
