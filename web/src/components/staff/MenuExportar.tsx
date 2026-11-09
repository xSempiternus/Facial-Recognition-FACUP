"use client";

import { ChevronDown, Download, FileSpreadsheet, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, useToast } from "@/components/staff/ui";
import { textoError } from "@/lib/staff-api";
import { exportarAsistencia, type FormatoExporte } from "@/lib/staff-exportes";

const OPCIONES: { formato: FormatoExporte; texto: string; detalle: string; icono: typeof FileText }[] = [
  { formato: "xlsx", texto: "Excel (.xlsx)", detalle: "Planilla con jornadas, resumen y contactos", icono: FileSpreadsheet },
  { formato: "pdf", texto: "PDF", detalle: "Informe listo para imprimir o compartir", icono: FileText },
];

/** Botón "Exportar" con menú Excel / PDF. Respeta el rango y la categoría que recibe. */
export function MenuExportar({ desde, hasta, categoria, deshabilitado }: { desde: string; hasta: string; categoria: string; deshabilitado?: boolean }) {
  const [abierto, setAbierto] = useState(false);
  const [bajando, setBajando] = useState<FormatoExporte | null>(null);
  const raiz = useRef<HTMLDivElement>(null);
  const toast = useToast();

  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: PointerEvent) => {
      if (!raiz.current?.contains(e.target as Node)) setAbierto(false);
    };
    document.addEventListener("pointerdown", fuera);
    return () => document.removeEventListener("pointerdown", fuera);
  }, [abierto]);

  useEffect(() => {
    if (abierto) raiz.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [abierto]);

  function teclas(e: React.KeyboardEvent) {
    const items = Array.from(raiz.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      setAbierto(false);
      raiz.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
    } else if (e.key === "ArrowDown" && items.length) {
      e.preventDefault();
      items[(i + 1) % items.length].focus();
    } else if (e.key === "ArrowUp" && items.length) {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length].focus();
    }
  }

  async function elegir(formato: FormatoExporte) {
    setAbierto(false);
    setBajando(formato);
    try {
      await exportarAsistencia(formato, desde, hasta, categoria);
      toast(`Listo: se descargó el ${formato === "xlsx" ? "Excel" : "PDF"}.`, "ok");
    } catch (e) {
      toast(textoError(e, "No se pudo generar el archivo. Inténtalo de nuevo."), "err");
    } finally {
      setBajando(null);
    }
  }

  return (
    <div className="sg-exp" ref={raiz} onKeyDown={teclas}>
      <Button
        aria-haspopup="menu"
        aria-expanded={abierto}
        aria-controls="sg-exp-menu"
        cargando={bajando !== null}
        disabled={deshabilitado}
        onClick={() => setAbierto((a) => !a)}
      >
        <Download size={15} aria-hidden /> {bajando ? "Generando…" : "Exportar"} <ChevronDown size={14} aria-hidden />
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {bajando ? "Generando el archivo, un momento." : ""}
      </span>
      {abierto && (
        <div className="sg-exp-menu" id="sg-exp-menu" role="menu" aria-label="Formato de exportación">
          {OPCIONES.map(({ formato, texto, detalle, icono: Icono }) => (
            <button key={formato} type="button" role="menuitem" className="sg-exp-item" onClick={() => elegir(formato)}>
              <Icono size={16} aria-hidden />
              <span>
                <b>{texto}</b>
                <small>{detalle}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
