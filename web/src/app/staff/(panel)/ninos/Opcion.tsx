import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/** Fila grande y táctil de una hoja: icono, título, explicación corta. */
export function Opcion({
  icono,
  titulo,
  texto,
  onClick,
  tono,
  recomendada,
}: {
  icono: ReactNode;
  titulo: string;
  texto?: string;
  onClick: () => void;
  tono?: "aviso" | "peligro";
  recomendada?: boolean;
}) {
  return (
    <button type="button" className={`nn-op${tono ? ` ${tono}` : ""}${recomendada ? " rec" : ""}`} onClick={onClick}>
      <span className="ico" aria-hidden>
        {icono}
      </span>
      <span className="nn-op-t">
        <b>
          {titulo}
          {recomendada && <span className="nn-rec">Recomendado</span>}
        </b>
        {texto && <small>{texto}</small>}
      </span>
      <ChevronRight size={18} className="chev" aria-hidden />
    </button>
  );
}
