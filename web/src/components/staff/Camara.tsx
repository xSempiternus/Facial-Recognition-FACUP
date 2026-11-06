"use client";

import { Camera as CamIcon, CameraOff, ImageUp, RotateCw, SwitchCamera } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { abrirCamara, contarCamaras, guardarFacing, leerFacing, type Facing } from "@/lib/camara";
import { Button } from "./ui";

function mensajeError(e: unknown) {
  const n = e instanceof DOMException ? e.name : e instanceof Error ? e.message : "";
  if (n === "NotAllowedError" || n === "SecurityError") return "Permiso de cámara denegado. Actívalo en los ajustes del navegador y toca Reintentar, o sube una foto.";
  if (n === "NotFoundError" || n === "DevicesNotFoundError") return "No hay una cámara disponible en este equipo. Sube una foto.";
  if (n === "NotReadableError" || n === "TrackStartError") return "La cámara está en uso por otra app. Ciérrala y toca Reintentar, o sube una foto.";
  if (n === "sin_api") return "Este navegador no permite usar la cámara (se requiere HTTPS). Sube una foto.";
  return "No se pudo usar la cámara. Toca Reintentar o sube una foto.";
}

const sinSuscripcion = () => () => {};
/** Solo en desarrollo: ?demo=camara simula el visor (sin cámara real) para revisar el layout. */
function useDemo() {
  return useSyncExternalStore(
    sinSuscripcion,
    () => process.env.NODE_ENV !== "production" && new URLSearchParams(window.location.search).get("demo") === "camara",
    () => false,
  );
}

/** Cámara del navegador (frontal o trasera). `onCaptura` recibe un JPEG; si no hay cámara, deja elegir un archivo. */
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
  const [textoError, setTextoError] = useState("");
  const [intento, setIntento] = useState(0);
  const estado = demo ? "lista" : estadoReal;
  const [facing, setFacing] = useState<Facing>(leerFacing);
  const [espejo, setEspejo] = useState(true); // solo la vista previa de la frontal se espeja; la captura nunca
  const [varias, setVarias] = useState(false);

  useEffect(() => {
    if (demo) return;
    let flujo: MediaStream | null = null;
    let vivo = true;
    const el = video.current;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("sin_api");
        const r = await abrirCamara(facing, { width: { ideal: 1280 } });
        const f = r.stream;
        if (!vivo) {
          f.getTracks().forEach((t) => t.stop());
          return;
        }
        flujo = f;
        setEspejo(r.facing === "user");
        contarCamaras().then((n) => vivo && setVarias(n > 1)); // tras el permiso (iOS: antes los labels van vacíos)
        // iOS suspende la cámara al ocultar la app: si el track termina estando visible, se vuelve a abrir.
        f.getVideoTracks().forEach((t) =>
          t.addEventListener("ended", () => vivo && document.visibilityState === "visible" && setIntento((n) => n + 1)),
        );
        if (video.current) {
          video.current.srcObject = f;
          await video.current.play().catch(() => {});
        }
        if (vivo) {
          setTextoError("");
          setEstado("lista");
        }
      } catch (e) {
        if (vivo) {
          setTextoError(mensajeError(e));
          setEstado("error");
        }
      }
    })();
    const alVolver = () => {
      if (document.visibilityState !== "visible" || !flujo) return;
      if (flujo.getVideoTracks().some((t) => t.readyState === "ended")) setIntento((n) => n + 1);
      else video.current?.play().catch(() => {});
    };
    document.addEventListener("visibilitychange", alVolver);
    const alCambiarDispositivos = () => contarCamaras().then((n) => vivo && setVarias(n > 1));
    navigator.mediaDevices?.addEventListener?.("devicechange", alCambiarDispositivos);
    return () => {
      vivo = false;
      document.removeEventListener("visibilitychange", alVolver);
      navigator.mediaDevices?.removeEventListener?.("devicechange", alCambiarDispositivos);
      flujo?.getTracks().forEach((t) => t.stop());
      if (el) el.srcObject = null;
    };
  }, [demo, intento, facing]);

  function reintentar() {
    setEstado("iniciando");
    setIntento((n) => n + 1);
  }

  function voltear() {
    const nuevo: Facing = facing === "user" ? "environment" : "user";
    guardarFacing(nuevo);
    setEstado("iniciando");
    setFacing(nuevo); // el efecto detiene el stream anterior y pide el nuevo
  }

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
        <video ref={video} autoPlay playsInline muted aria-label="Vista de la cámara" style={{ display: estado === "lista" ? "block" : "none", transform: espejo ? undefined : "none" }} />
        {estado === "lista" && <div className="guide" aria-hidden />}
        {varias && !demo && estado !== "error" && (
          <Button icono variante="ghost" className="s-flip" aria-label="Voltear cámara (frontal o trasera)" onClick={voltear} disabled={estado === "iniciando" || deshabilitado}>
            <SwitchCamera size={18} aria-hidden />
          </Button>
        )}
        {demo && <div className="msg demo" aria-hidden>Vista simulada (demo)</div>}
        {estado === "iniciando" && <div className="msg">Encendiendo la cámara…</div>}
        {estado === "error" && (
          <div className="msg">
            <CameraOff size={22} aria-hidden style={{ margin: "0 auto 8px" }} />
            {textoError || "No se pudo usar la cámara."}
            <div style={{ marginTop: 10 }}>
              <Button onClick={reintentar}>
                <RotateCw size={16} aria-hidden /> Reintentar
              </Button>
            </div>
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
