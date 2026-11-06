"use client";

// QR generado en el navegador (librería local `qrcode`, sin servicios externos) + panel para compartir un enlace.

import { Check, Copy, Expand, Share2 } from "lucide-react";
import { create } from "qrcode";
import { useMemo, useState } from "react";
import { fechaHora } from "@/lib/staff-api";
import { Button, Dialogo, useToast } from "./ui";

const MARGEN = 4; // módulos de zona de silencio (norma QR)

export function Qr({ texto, className, titulo }: { texto: string; className?: string; titulo: string }) {
  const qr = useMemo(() => {
    try {
      const q = create(texto, { errorCorrectionLevel: "M" });
      const n = q.modules.size;
      const datos = q.modules.data as ArrayLike<number>;
      let d = "";
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (datos[y * n + x]) d += `M${x + MARGEN} ${y + MARGEN}h1v1h-1z`;
        }
      }
      return { n: n + MARGEN * 2, d };
    } catch {
      return null;
    }
  }, [texto]);

  if (!qr) return <p className="muted">No se pudo generar el QR. Copia el enlace y envíalo por WhatsApp.</p>;
  return (
    <svg
      className={className ?? "s-qr"}
      viewBox={`0 0 ${qr.n} ${qr.n}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={titulo}
    >
      <rect width={qr.n} height={qr.n} fill="#fff" />
      <path d={qr.d} fill="#000" />
    </svg>
  );
}

/** Copia al portapapeles; devuelve false si el navegador no lo permite. */
async function copiar(texto: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    return false;
  }
}

/** QR grande + enlace + Copiar / Compartir / Pantalla completa. */
export function PanelQr({ url, expira, titulo = "Formulario de inscripción" }: { url: string; expira: string; titulo?: string }) {
  const notificar = useToast();
  const [copiado, setCopiado] = useState(false);
  const [completa, setCompleta] = useState(false);
  const puedeCompartir = typeof navigator !== "undefined" && typeof navigator.share === "function";

  async function alCopiar() {
    if (await copiar(url)) {
      setCopiado(true);
      notificar("Enlace copiado");
      setTimeout(() => setCopiado(false), 2500);
    } else {
      notificar("No se pudo copiar. Selecciona el enlace y cópialo a mano.", "err");
    }
  }
  async function alCompartir() {
    try {
      await navigator.share({ title: "Inscripción FA CUP Chile", text: "Inscripción de tu hijo/a en FA CUP Chile:", url });
    } catch {
      /* el usuario canceló */
    }
  }

  return (
    <div className="s-qrpanel" data-tour="qr">
      <button type="button" className="s-qrbtn" onClick={() => setCompleta(true)} aria-label="Ver el QR en pantalla completa">
        <Qr texto={url} titulo={`Código QR: ${titulo}`} />
      </button>
      <div className="s-qrinfo">
        <input
          className="s-input"
          readOnly
          value={url}
          aria-label="Enlace de inscripción"
          onFocus={(e) => e.currentTarget.select()}
        />
        <small className="muted">Vale hasta el {fechaHora(expira)}. Solo sirve para esta sede.</small>
        <div className="s-row" style={{ flexWrap: "wrap" }}>
          <Button variante="primary" onClick={alCopiar}>
            {copiado ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />} {copiado ? "Copiado" : "Copiar"}
          </Button>
          {puedeCompartir && (
            <Button onClick={alCompartir}>
              <Share2 size={15} aria-hidden /> Compartir
            </Button>
          )}
          <Button onClick={() => setCompleta(true)}>
            <Expand size={15} aria-hidden /> Mostrar al apoderado
          </Button>
        </div>
      </div>

      <Dialogo abierto={completa} onCerrar={() => setCompleta(false)} titulo="QR de inscripción" completa pie={<Button variante="primary" onClick={() => setCompleta(false)}>Listo</Button>}>
        <div className="s-qrfull">
          <Qr texto={url} className="s-qr big" titulo={`Código QR: ${titulo}`} />
          <p>Apunta la cámara del celular al código para inscribir a tu hijo/a.</p>
        </div>
      </Dialogo>
    </div>
  );
}
