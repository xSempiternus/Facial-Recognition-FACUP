"use client";

// Paso de fotos: hasta 3 capturas guiadas con la cámara (o subir archivo). Cada imagen se reduce en canvas antes de subir.

import { Camera, Loader2, RotateCcw, SwitchCamera, Upload } from "lucide-react";
import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { abrirCamara, contarCamaras, facingInicial, guardarFacing, type Facing } from "@/lib/camara";
import { reducirImagen } from "@/lib/inscripcion-api";

export type Foto = { blob: Blob; url: string; espejo: boolean };

const CONSEJOS = [
  "Foto 1: de frente, mirando a la cámara",
  "Foto 2: con la cara ligeramente a la izquierda",
  "Foto 3 (opcional): sonriendo y con buena luz",
];

function mensajeCamara(e: unknown) {
  const n = e instanceof DOMException ? e.name : "";
  if (n === "NotAllowedError" || n === "SecurityError") return "No tenemos permiso para usar la cámara. Puedes activarlo en el navegador o subir una foto.";
  if (n === "NotFoundError" || n === "DevicesNotFoundError") return "No encontramos una cámara. Puedes subir una foto.";
  if (n === "NotReadableError" || n === "TrackStartError") return "La cámara está en uso por otra app. Ciérrala o sube una foto.";
  return "No se pudo abrir la cámara. Puedes subir una foto.";
}

export function FotosPaso({
  titulo,
  fotos,
  setFotos,
  malas,
  setMalas,
  maxMb,
  alerta,
}: {
  titulo: RefObject<HTMLHeadingElement | null>;
  fotos: (Foto | null)[];
  setFotos: Dispatch<SetStateAction<(Foto | null)[]>>;
  malas: number[];
  setMalas: Dispatch<SetStateAction<number[]>>;
  maxMb: number;
  alerta: string | null;
}) {
  const [activa, setActiva] = useState(() => {
    const i = fotos.findIndex((f) => !f);
    return i < 0 ? 0 : i;
  });
  const [camOn, setCamOn] = useState(false);
  const [listo, setListo] = useState(false);
  const [facing, setFacing] = useState<Facing>(facingInicial);
  const [espejo, setEspejo] = useState(true);
  const [varias, setVarias] = useState(false);
  const [errCam, setErrCam] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [procesando, setProcesando] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const archivo = useRef<HTMLInputElement>(null);
  const urls = useRef<string[]>([]);

  // Libera las vistas previas al salir de la pantalla.
  useEffect(() => {
    const u = urls.current;
    return () => u.forEach((x) => URL.revokeObjectURL(x));
  }, []);

  // Cámara: se abre al pedirla y sigue viva entre fotos; se cierra al volver atrás o al voltear.
  useEffect(() => {
    if (!camOn) return;
    let vivo = true;
    let stream: MediaStream | undefined;
    const v = video.current;
    abrirCamara(facing, { width: { ideal: 1280 }, height: { ideal: 960 } })
      .then(({ stream: s, facing: f }) => {
        if (!vivo) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        setEspejo(f === "user");
        if (v) {
          v.srcObject = s;
          v.play().catch(() => {});
        }
        setListo(true);
        contarCamaras().then((n) => vivo && setVarias(n > 1));
      })
      .catch((e) => {
        if (!vivo) return;
        setErrCam(mensajeCamara(e));
        setCamOn(false);
      });
    return () => {
      vivo = false;
      stream?.getTracks().forEach((t) => t.stop());
      if (v) v.srcObject = null;
    };
  }, [camOn, facing]);

  function poner(i: number, blob: Blob, esp: boolean) {
    const url = URL.createObjectURL(blob);
    urls.current.push(url);
    setFotos((fs) => {
      const n = [...fs];
      if (n[i]) URL.revokeObjectURL(n[i]!.url);
      n[i] = { blob, url, espejo: esp };
      return n;
    });
    setMalas((m) => m.filter((x) => x !== i));
  }

  async function capturar() {
    const v = video.current;
    if (!v || !listo || v.videoWidth === 0 || procesando) return;
    setProcesando(true);
    setAviso(null);
    try {
      poner(activa, await reducirImagen(v, maxMb), espejo);
    } catch {
      setAviso("No se pudo tomar la foto. Intenta de nuevo.");
    } finally {
      setProcesando(false);
    }
  }

  async function subir(f: File | undefined) {
    if (!f) return;
    setProcesando(true);
    setAviso(null);
    try {
      poner(activa, await reducirImagen(f, maxMb), false);
    } catch {
      setAviso("No pudimos leer esa imagen. Usa una foto en JPG, PNG o WEBP.");
    } finally {
      setProcesando(false);
      if (archivo.current) archivo.current.value = "";
    }
  }

  function repetir() {
    setFotos((fs) => {
      const n = [...fs];
      if (n[activa]) URL.revokeObjectURL(n[activa]!.url);
      n[activa] = null;
      return n;
    });
    setMalas((m) => m.filter((x) => x !== activa));
  }

  function voltear() {
    const f: Facing = facing === "user" ? "environment" : "user";
    guardarFacing(f);
    setListo(false);
    setFacing(f);
  }

  const actual = fotos[activa];
  const siguiente = fotos.findIndex((f, i) => !f && i !== activa);

  return (
    <>
      <h1 className="ins-h" ref={titulo} tabIndex={-1}>
        Fotos del rostro
      </h1>
      <p className="ins-p">2 o 3 fotos de la cara, para que la cámara de la cancha lo reconozca al llegar. De frente, con buena luz y solo el niño o niña en la foto, sin gorro ni lentes oscuros.</p>

      <div className="ins-slots" role="group" aria-label="Fotos">
        {fotos.map((f, i) => (
          <button key={i} type="button" className="ins-slot" data-act={i === activa ? "" : undefined} data-mal={malas.includes(i) ? "" : undefined} aria-label={`Foto ${i + 1}${f ? ", tomada" : ", vacía"}${malas.includes(i) ? ", con problema" : ""}`} aria-pressed={i === activa} onClick={() => setActiva(i)}>
            {/* eslint-disable-next-line @next/next/no-img-element -- vista previa local (blob:) */}
            {f ? <img src={f.url} alt="" style={f.espejo ? { transform: "scaleX(-1)" } : undefined} /> : i + 1}
          </button>
        ))}
      </div>

      <div className="ins-visor">
        <video ref={video} autoPlay muted playsInline disablePictureInPicture style={{ display: camOn && !actual ? "block" : "none", transform: espejo ? "scaleX(-1)" : undefined }} />
        {actual && (
          // eslint-disable-next-line @next/next/no-img-element -- vista previa local (blob:)
          <img src={actual.url} alt={`Vista previa de la foto ${activa + 1}`} style={actual.espejo ? { transform: "scaleX(-1)" } : undefined} />
        )}
        {!actual && camOn && <div className="ins-guia" aria-hidden />}
        {!actual && !camOn && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <button type="button" className="ins-btn" style={{ flex: "none" }} onClick={() => {
                setErrCam(null);
                setListo(false);
                setCamOn(true);
              }}>
              <Camera size={20} aria-hidden /> Abrir cámara
            </button>
          </div>
        )}
        {!actual && camOn && (
          <div className="ins-visor-acc">
            {varias && (
              <button type="button" className="ins-mini" onClick={voltear} aria-label="Voltear cámara">
                <SwitchCamera size={22} aria-hidden />
              </button>
            )}
            <button type="button" className="ins-obturador" onClick={capturar} disabled={!listo || procesando} aria-label="Tomar foto" />
            {varias && <span className="ins-mini" style={{ visibility: "hidden" }} aria-hidden />}
          </div>
        )}
        {camOn && !listo && !actual && (
          <div className="absolute inset-0 grid place-items-center" role="status" aria-label="Abriendo cámara">
            <Loader2 className="s-spin" size={28} aria-hidden />
          </div>
        )}
      </div>

      <p className="ins-consejo" aria-live="polite">
        {actual ? "¿Se ve bien? Si no, repítela." : CONSEJOS[activa]}
      </p>

      <div className="flex flex-wrap items-center justify-center gap-1">
        {actual ? (
          <>
            <button type="button" className="ins-enlace" onClick={repetir}>
              <RotateCcw size={15} className="mr-1 inline" aria-hidden /> Repetir
            </button>
            {siguiente >= 0 && (
              <button type="button" className="ins-enlace" onClick={() => setActiva(siguiente)}>
                Siguiente foto
              </button>
            )}
          </>
        ) : (
          <button type="button" className="ins-enlace" onClick={() => archivo.current?.click()} disabled={procesando}>
            <Upload size={15} className="mr-1 inline" aria-hidden /> Subir foto
          </button>
        )}
        <input ref={archivo} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void subir(e.target.files?.[0])} />
      </div>

      <div aria-live="assertive">
        {(errCam || aviso || alerta) && (
          <p className="ins-alerta" role="alert">
            {aviso ?? alerta ?? errCam}
          </p>
        )}
      </div>
    </>
  );
}
