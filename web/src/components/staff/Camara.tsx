"use client";

import { Camera as CamIcon, CameraOff, ImageUp } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "./ui";

const sinSuscripcion = () => () => {};
/** Solo en desarrollo: ?demo=camara simula el visor (sin cámara real) para revisar el layout. */
function useDemo() {
  return useSyncExternalStore(
    sinSuscripcion,
    () => process.env.NODE_ENV !== "production" && new URLSearchParams(window.location.search).get("demo") === "camara",
    () => false,
  );
}

/** Cámara del navegador (frontal). `onCaptura` recibe un JPEG; si no hay cámara, deja elegir un archivo. */
export function Camara({
  onCaptura,
  etiqueta = "Tomar foto",
  deshabilitado,
  fija,
}: {
  onCaptura: (b: Blob) => void;
  etiqueta?: string;
  deshabilitado?: boolean;
  /** En pantallas chicas, deja la barra del botón de captura fija abajo (con safe-area). */
  fija?: boolean;
}) {
  const demo = useDemo();
  const video = useRef<HTMLVideoElement>(null);
  const archivo = useRef<HTMLInputElement>(null);
  const [estadoReal, setEstado] = useState<"iniciando" | "lista" | "error">("iniciando");
  const estado = demo ? "lista" : estadoReal;

  useEffect(() => {
    if (demo) return;
    let flujo: MediaStream | null = null;
    let vivo = true;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("sin_api");
        flujo = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 1280 } },
          audio: false,
        });
        if (!vivo) {
          flujo.getTracks().forEach((t) => t.stop());
          return;
        }
        if (video.current) {
          video.current.srcObject = flujo;
          await video.current.play().catch(() => {});
        }
        setEstado("lista");
      } catch {
        if (vivo) setEstado("error");
      }
    })();
    return () => {
      vivo = false;
      flujo?.getTracks().forEach((t) => t.stop());
    };
  }, [demo]);

  function capturar() {
    if (demo) {
      const c = document.createElement("canvas");
      c.width = 480;
      c.height = 640;
      const g = c.getContext("2d");
      if (g) {
        g.fillStyle = `hsl(${Math.round(Math.random() * 360)} 35% 35%)`;
        g.fillRect(0, 0, 480, 640);
        g.fillStyle = "rgb(255 255 255 / 0.4)";
        g.beginPath();
        g.ellipse(240, 300, 130, 170, 0, 0, Math.PI * 2);
        g.fill();
      }
      c.toBlob((b) => b && onCaptura(b), "image/jpeg", 0.8);
      return;
    }
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")?.drawImage(v, 0, 0);
    c.toBlob((b) => b && onCaptura(b), "image/jpeg", 0.92);
  }

  return (
    <div className={fija ? "s-camwrap fija" : "s-camwrap"}>
      <div className="s-cam">
        <video ref={video} playsInline muted aria-label="Vista de la cámara" style={{ display: estado === "lista" ? "block" : "none" }} />
        {estado === "lista" && <div className="guide" aria-hidden />}
        {demo && <div className="msg demo" aria-hidden>Vista simulada (demo)</div>}
        {estado === "iniciando" && <div className="msg">Encendiendo la cámara…</div>}
        {estado === "error" && (
          <div className="msg">
            <CameraOff size={22} aria-hidden style={{ margin: "0 auto 8px" }} />
            No se pudo usar la cámara. Revisa el permiso del navegador o sube una foto desde el equipo.
          </div>
        )}
      </div>
      <div className="s-actions s-camactions">
        <Button variante="brand" className="s-capture" onClick={capturar} disabled={estado !== "lista" || deshabilitado} style={{ flex: 1 }}>
          <CamIcon size={16} aria-hidden /> {etiqueta}
        </Button>
        <Button className="s-upload" onClick={() => archivo.current?.click()} disabled={deshabilitado}>
          <ImageUp size={16} aria-hidden /> Subir foto
        </Button>
        <input
          ref={archivo}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onCaptura(f);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
