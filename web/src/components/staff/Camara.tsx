"use client";

import { Camera as CamIcon, CameraOff, ImageUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui";

/** Cámara del navegador (frontal). `onCaptura` recibe un JPEG; si no hay cámara, deja elegir un archivo. */
export function Camara({ onCaptura, etiqueta = "Tomar foto", deshabilitado }: { onCaptura: (b: Blob) => void; etiqueta?: string; deshabilitado?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const archivo = useRef<HTMLInputElement>(null);
  const [estado, setEstado] = useState<"iniciando" | "lista" | "error">("iniciando");

  useEffect(() => {
    let flujo: MediaStream | null = null;
    let vivo = true;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("sin_api");
        flujo = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } },
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
  }, []);

  function capturar() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")?.drawImage(v, 0, 0);
    c.toBlob((b) => b && onCaptura(b), "image/jpeg", 0.92);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="s-cam">
        <video ref={video} playsInline muted aria-label="Vista de la cámara" style={{ display: estado === "lista" ? "block" : "none" }} />
        {estado === "lista" && <div className="guide" aria-hidden />}
        {estado === "iniciando" && <div className="msg">Encendiendo la cámara…</div>}
        {estado === "error" && (
          <div className="msg">
            <CameraOff size={22} aria-hidden style={{ margin: "0 auto 8px" }} />
            No se pudo usar la cámara. Revisa el permiso del navegador o sube una foto desde el equipo.
          </div>
        )}
      </div>
      <div className="s-actions">
        <Button variante="brand" onClick={capturar} disabled={estado !== "lista" || deshabilitado} style={{ flex: 1 }}>
          <CamIcon size={16} aria-hidden /> {etiqueta}
        </Button>
        <Button onClick={() => archivo.current?.click()} disabled={deshabilitado}>
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
