"use client";

// QR generado en el navegador (librería local `qrcode`, sin servicios externos) + panel para compartir un enlace.

import { Check, Copy, Expand, Link2, Mail, MessageCircle, Share2 } from "lucide-react";
import Link from "next/link";
import { create } from "qrcode";
import { useMemo, useState, useSyncExternalStore } from "react";
import { nombreSedeGuardado } from "@/lib/sede";
import { esUrlLocal, fechaHora } from "@/lib/staff-api";
import { Alerta, Button, Dialogo, useToast } from "./ui";

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

const sinSuscripcion = () => () => {};
const sinNombre = () => undefined;

function fechaLarga(iso: string): string {
  const d = new Date(iso.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" });
}

/** Mensaje prellenado para las familias (WhatsApp, correo, copiar). Un mismo enlace sirve para todas. */
export function mensajeInvitacion(url: string, expira: string, sede?: string, categoria?: string | null) {
  const nombreSede = sede ? (/^sede\s/i.test(sede) ? sede : `Sede ${sede}`) : "";
  const club = nombreSede ? `FA CUP Chile ${nombreSede}` : "FA CUP Chile";
  const asunto = `Inscripción de tu hijo/a en ${club}`;
  const texto =
    `Hola, te escribimos de ${club}.\n\n` +
    `Para registrar la asistencia de tu hijo/a${categoria ? ` (${categoria})` : ""} con reconocimiento facial, ` +
    `necesitamos que completes su inscripción: unos datos y 2 o 3 fotos de su cara. Son 2 minutos desde el celular:\n\n` +
    `${url}\n\n` +
    `El enlace vale hasta el ${fechaLarga(expira)}. Si tienes más de un hijo/a en el club, puedes inscribirlos a todos con este mismo enlace.\n\n` +
    `¡Gracias!`;
  return { asunto, texto };
}

/** QR grande + enlace + WhatsApp / Correo / Copiar / Compartir / Pantalla completa. */
export function PanelQr({ url, expira, titulo = "Formulario de inscripción", categoria }: { url: string; expira: string; titulo?: string; categoria?: string | null }) {
  const notificar = useToast();
  const [copiado, setCopiado] = useState<"mensaje" | "enlace" | null>(null);
  const [completa, setCompleta] = useState(false);
  const puedeCompartir = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const sede = useSyncExternalStore(sinSuscripcion, nombreSedeGuardado, sinNombre);
  const local = esUrlLocal(url);
  const motivoLocal = "Este enlace solo funciona en este equipo: configura una dirección pública.";
  const { asunto, texto } = mensajeInvitacion(url, expira, sede, categoria);
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(texto)}`;
  const correo = `mailto:?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(texto)}`;

  async function alCopiar(que: "mensaje" | "enlace") {
    if (await copiar(que === "mensaje" ? texto : url)) {
      setCopiado(que);
      notificar(que === "mensaje" ? "Mensaje con el enlace copiado" : "Enlace copiado");
      setTimeout(() => setCopiado(null), 2500);
    } else {
      notificar("No se pudo copiar. Selecciona el enlace y cópialo a mano.", "err");
    }
  }
  async function alCompartir() {
    try {
      await navigator.share({ title: asunto, text: texto.replace(`${url}\n\n`, ""), url });
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
        {local && (
          <Alerta>
            Este enlace solo funciona en este equipo. Para compartirlo con apoderados necesitas una dirección pública (https).{" "}
            <Link className="s-btn sm" style={{ textDecoration: "none" }} href="/staff/ajustes">Configurar</Link>
          </Alerta>
        )}
        <small className="muted">Vale hasta el {fechaHora(expira)}. Solo sirve para esta sede y lo pueden usar todas las familias que lo reciban.</small>
        <div className="s-row" role="group" aria-label="Enviar el enlace" style={{ flexWrap: "wrap" }}>
          {local ? (
            <>
              <Button disabled title={motivoLocal}>
                <MessageCircle size={15} aria-hidden /> WhatsApp
              </Button>
              <Button disabled title={motivoLocal}>
                <Mail size={15} aria-hidden /> Correo
              </Button>
            </>
          ) : (
            <>
              <a className="s-btn primary" style={{ textDecoration: "none" }} href={whatsapp} target="_blank" rel="noopener noreferrer">
                <MessageCircle size={15} aria-hidden /> WhatsApp
              </a>
              <a className="s-btn" style={{ textDecoration: "none" }} href={correo}>
                <Mail size={15} aria-hidden /> Correo
              </a>
            </>
          )}
          <Button onClick={() => alCopiar("mensaje")} title="Copia el mensaje con el enlace para pegarlo donde quieras">
            {copiado === "mensaje" ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />} {copiado === "mensaje" ? "Copiado" : "Copiar"}
          </Button>
          {puedeCompartir && !local && (
            <Button onClick={alCompartir}>
              <Share2 size={15} aria-hidden /> Compartir
            </Button>
          )}
        </div>
        <div className="s-row" style={{ flexWrap: "wrap" }}>
          <Button sm variante="ghost" onClick={() => alCopiar("enlace")}>
            {copiado === "enlace" ? <Check size={14} aria-hidden /> : <Link2 size={14} aria-hidden />} {copiado === "enlace" ? "Enlace copiado" : "Copiar solo el enlace"}
          </Button>
          <Button sm variante="ghost" onClick={() => setCompleta(true)}>
            <Expand size={14} aria-hidden /> Mostrar el QR al apoderado
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
