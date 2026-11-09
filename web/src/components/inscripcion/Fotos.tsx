"use client";

// Paso de fotos a pantalla completa: la cámara guía con un óvalo y saca sola 3 fotos (frente, un poco a la
// izquierda, un poco a la derecha) cuando hay una sola cara, bien puesta, quieta y con luz. Luego, revisión con
// "Repetir" por foto y un único "Enviar". Si la cámara o el detector fallan: captura manual o subir foto.
// Sin sonidos. Cada imagen se reduce en canvas antes de subir (reducirImagen).

import { AnimatePresence, motion, useMotionValue, useTransform } from "motion/react";
import { Camera, Check, ChevronLeft, ChevronRight, ImageUp, Loader2, RotateCcw, SwitchCamera, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { abrirCamara, contarCamaras, facingInicial, guardarFacing, type Facing } from "@/lib/camara";
import { reducirImagen } from "@/lib/inscripcion-api";
import { useCapturaAuto, type Guia, type Ovalo, type Pose } from "./useCapturaAuto";
import "./fotos.css";

export type Foto = { blob: Blob; url: string; espejo: boolean };

const POSES: Pose[] = ["frente", "izq", "der"];
const NOMBRE_POSE: Record<Pose, string> = { frente: "Frente", izq: "Izquierda", der: "Derecha" };
// Frontal: habla al niño/a que se ve en pantalla. Trasera: al adulto que sostiene el teléfono.
const INSTRUCCION: Record<Pose, [string, string]> = {
  frente: ["Mira de frente", "Que mire de frente"],
  izq: ["Gira un poco a tu izquierda", "Que gire un poco a su izquierda"],
  der: ["Ahora un poco a tu derecha", "Ahora un poco a su derecha"],
};
const GUIA: Record<Guia, string> = {
  "sin-cara": "Pon la cara dentro del óvalo",
  varias: "Solo una cara en la pantalla",
  lejos: "Más cerca",
  cerca: "Un poco más lejos",
  descentrado: "Centra la cara en el óvalo",
  "girar-mas": "Gira un poco más",
  "girar-menos": "Un poco menos",
  "mirar-frente": "Mirando directo a la cámara",
  luz: "Falta luz: busca un lugar más iluminado",
  ok: "No te muevas…",
};
const LENTO_MS = 6000; // si el detector no está listo en este tiempo, aparece el botón manual
const ATASCADO_MS = 12000; // tanto tiempo en una pose sin foto: aparece el botón manual
const PAUSA_MS = 800; // check tras cada foto
const DESCANSO_MS = 650; // y tiempo para leer la siguiente instrucción antes de rastrear

function mensajeCamara(e: unknown) {
  const n = e instanceof DOMException ? e.name : "";
  if (n === "NotAllowedError" || n === "SecurityError") return "No tenemos permiso para usar la cámara. Actívalo en los ajustes del navegador o sube las fotos.";
  if (n === "NotFoundError" || n === "DevicesNotFoundError") return "No encontramos una cámara. Puedes subir las fotos.";
  if (n === "NotReadableError" || n === "TrackStartError") return "La cámara está en uso por otra app. Ciérrala o sube las fotos.";
  return "No se pudo abrir la cámara. Puedes subir las fotos.";
}

type Props = {
  titulo: RefObject<HTMLHeadingElement | null>;
  fotos: (Foto | null)[];
  setFotos: Dispatch<SetStateAction<(Foto | null)[]>>;
  malas: number[];
  setMalas: Dispatch<SetStateAction<number[]>>;
  maxMb: number;
  minimo: number;
  alerta: string | null;
  enviando: boolean;
  reintentar: boolean;
  onEnviar: () => void;
  onCerrar: () => void;
};

export function FotosPaso(props: Props) {
  // Portal: el panel del formulario tiene transform/backdrop-filter, que romperían el position: fixed.
  return createPortal(<Inmersivo {...props} />, document.body);
}

function Inmersivo({ titulo, fotos, setFotos, malas, setMalas, maxMb, minimo, alerta, enviando, reintentar, onEnviar, onCerrar }: Props) {
  const primeraVacia = fotos.findIndex((f) => !f);
  const [modo, setModo] = useState<"camara" | "revision">(primeraVacia < 0 ? "revision" : "camara");
  const [activa, setActiva] = useState(primeraVacia < 0 ? 0 : primeraVacia);
  const [soloUna, setSoloUna] = useState(false); // "Repetir" desde la revisión: una foto y vuelve
  const [cam, setCam] = useState<"abriendo" | "lista" | "error">("abriendo");
  const [errCam, setErrCam] = useState<string | null>(null);
  const [facing, setFacing] = useState<Facing>(facingInicial);
  const [espejo, setEspejo] = useState(true);
  const [varias, setVarias] = useState(false);
  const [intento, setIntento] = useState(0);
  const [pausa, setPausa] = useState(false);
  const [hecho, setHecho] = useState(false);
  const [flash, setFlash] = useState(0);
  const [lento, setLento] = useState(false);
  const [atascadoEn, setAtascadoEn] = useState<string | null>(null);
  const [tomas, setTomas] = useState(0);
  const [aviso, setAviso] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const escenario = useRef<HTMLDivElement>(null);
  const ovaloEl = useRef<HTMLDivElement>(null);
  const ovalo = useRef<Ovalo>({ cx: 0, cy: 0, w: 1, h: 1 });
  const camaraFile = useRef<HTMLInputElement>(null);
  const galeriaFile = useRef<HTMLInputElement>(null);
  const destino = useRef(0); // a qué foto va el archivo elegido
  const timers = useRef<number[]>([]);
  const urls = useRef<string[]>([]);
  const progreso = useMotionValue(0);

  const enCamara = modo === "camara" && cam !== "error";
  const pose = POSES[activa] ?? "frente";

  // Sin scroll detrás y vistas previas liberadas al salir.
  useEffect(() => {
    const html = document.documentElement;
    const antes = html.style.overflow;
    html.style.overflow = "hidden";
    const u = urls.current;
    const t = timers.current;
    return () => {
      html.style.overflow = antes;
      t.forEach((x) => clearTimeout(x));
      u.forEach((x) => URL.revokeObjectURL(x));
    };
  }, []);

  // Cámara: viva mientras el paso esté abierto. Se reabre si el sistema la corta (iOS al ir a segundo plano).
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelado = false;
    const v = video.current;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("sin cámara");
      const r = await abrirCamara(facing, { width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: { ideal: 30, max: 30 } });
      if (cancelado) return r.stream.getTracks().forEach((t) => t.stop());
      stream = r.stream;
      setEspejo(r.facing === "user");
      contarCamaras().then((n) => !cancelado && setVarias(n > 1));
      stream.getVideoTracks().forEach((t) =>
        t.addEventListener("ended", () => !cancelado && document.visibilityState === "visible" && setIntento((n) => n + 1)),
      );
      if (v) {
        v.srcObject = stream;
        v.play().catch(() => {}); // sin esperar: en segundo plano la promesa puede tardar; el rastreo ya espera cuadros
      }
      setErrCam(null);
      setCam("lista");
    })().catch((e) => {
      if (cancelado) return;
      setErrCam(mensajeCamara(e));
      setCam("error");
    });
    const alVolver = () => {
      if (document.visibilityState !== "visible" || !stream) return;
      if (stream.getVideoTracks().some((t) => t.readyState === "ended")) setIntento((n) => n + 1);
      else v?.play().catch(() => {});
    };
    const alPausar = () => document.visibilityState === "visible" && !cancelado && v?.play().catch(() => {});
    v?.addEventListener("pause", alPausar);
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      cancelado = true;
      document.removeEventListener("visibilitychange", alVolver);
      v?.removeEventListener("pause", alPausar);
      stream?.getTracks().forEach((t) => t.stop());
      if (v) v.srcObject = null;
    };
  }, [facing, intento]);

  // Óvalo guía en px del escenario (para comparar con la cara).
  useEffect(() => {
    const esc = escenario.current, ov = ovaloEl.current;
    if (!esc || !ov) return;
    const medir = () => {
      const a = esc.getBoundingClientRect(), b = ov.getBoundingClientRect();
      ovalo.current = { cx: b.left - a.left + b.width / 2, cy: b.top - a.top + b.height / 2, w: b.width || 1, h: b.height || 1 };
    };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(esc);
    window.addEventListener("orientationchange", medir);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", medir);
    };
  }, []);

  const poner = useCallback(
    (i: number, blob: Blob, esp: boolean) => {
      const url = URL.createObjectURL(blob);
      urls.current.push(url);
      setFotos((fs) => {
        const n = [...fs];
        n[i] = { blob, url, espejo: esp };
        return n;
      });
      setMalas((m) => m.filter((x) => x !== i));
    },
    [setFotos, setMalas],
  );

  /** Foto tomada (auto o manual): check breve y a la siguiente pose, o a la revisión. */
  const avanzar = useCallback(
    (i: number) => {
      setPausa(true);
      setHecho(true);
      setTomas((n) => n + 1);
      const sig = soloUna ? -1 : fotos.findIndex((f, j) => !f && j !== i);
      timers.current.push(
        window.setTimeout(() => {
          setHecho(false);
          if (sig < 0) {
            setSoloUna(false);
            setModo("revision");
          } else setActiva(sig);
        }, PAUSA_MS),
        window.setTimeout(() => setPausa(false), PAUSA_MS + DESCANSO_MS),
      );
    },
    [fotos, soloUna],
  );

  const tomarDeVideo = useCallback(async () => {
    const v = video.current;
    if (!v || !v.videoWidth) return false;
    setFlash((n) => n + 1);
    try {
      poner(activa, await reducirImagen(v, maxMb), espejo);
      avanzar(activa);
      return true;
    } catch {
      return false;
    }
  }, [activa, avanzar, espejo, maxMb, poner]);

  const activo = enCamara && cam === "lista" && !pausa;
  const { modelo, guia, luz } = useCapturaAuto({ video, escenario, ovalo, progreso, pose, activo, camara: cam !== "error", espejo, onDisparo: tomarDeVideo });

  // Respaldo manual: detector lento o atascado mucho rato en la misma pose.
  const clave = `${activa}-${tomas}-${modo}`;
  useEffect(() => {
    if (modelo !== "cargando") return;
    const id = window.setTimeout(() => setLento(true), LENTO_MS);
    return () => clearTimeout(id);
  }, [modelo]);
  useEffect(() => {
    if (!activo || modelo !== "listo") return;
    const id = window.setTimeout(() => setAtascadoEn(clave), ATASCADO_MS);
    return () => clearTimeout(id);
  }, [activo, modelo, clave]);
  const manual = cam === "lista" && (modelo === "error" || (modelo === "cargando" && lento) || atascadoEn === clave);

  async function subir(f: File | undefined, input: HTMLInputElement | null) {
    if (input) input.value = "";
    if (!f) return;
    setAviso(null);
    try {
      poner(destino.current, await reducirImagen(f, maxMb), false);
    } catch {
      setAviso("No pudimos leer esa imagen. Usa una foto en JPG, PNG o WEBP.");
    }
  }

  function repetir(i: number) {
    setAviso(null);
    if (cam === "error") {
      destino.current = i;
      camaraFile.current?.click();
      return;
    }
    setActiva(i);
    setSoloUna(true);
    setPausa(false);
    setModo("camara");
  }

  function voltear() {
    const f: Facing = facing === "user" ? "environment" : "user";
    guardarFacing(f);
    setCam("abriendo");
    setFacing(f);
  }

  const n = fotos.filter(Boolean).length;
  const trasera = !espejo;
  const lleno = useTransform(progreso, (p) => (p > 0.02 ? 1 : 0));

  return (
    <motion.div className="fc" role="dialog" aria-modal="true" aria-labelledby="fc-titulo" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
      <h1 id="fc-titulo" ref={titulo} tabIndex={-1} className="sr-only">
        Fotos del rostro
      </h1>

      {/* Escenario de la cámara: siempre montado (el video no se corta al revisar). */}
      <div className="fc-escena" ref={escenario} data-oculta={enCamara ? undefined : ""} aria-hidden={!enCamara}>
        <video ref={video} autoPlay muted playsInline disablePictureInPicture style={espejo ? { transform: "scaleX(-1)" } : undefined} />
        <div className="fc-velo" aria-hidden />
        <div className="fc-ovalo" ref={ovaloEl} data-ok={guia === "ok" ? "" : undefined}>
          <svg viewBox="0 0 300 400" aria-hidden>
            <defs>
              <linearGradient id="fc-verde" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#008D36" />
                <stop offset="1" stopColor="#95C11F" />
              </linearGradient>
            </defs>
            <ellipse className="fc-pista" cx="150" cy="200" rx="147" ry="197" />
            {/* Parte arriba y avanza en sentido horario. */}
            <motion.path className="fc-anillo" d="M150 3A147 197 0 1 1 150 397A147 197 0 1 1 150 3" style={{ pathLength: progreso, opacity: lleno }} />
          </svg>
          <AnimatePresence>
            {hecho && (
              <motion.span key="ok" className="fc-check" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                <Check size={40} strokeWidth={2.5} aria-hidden />
              </motion.span>
            )}
          </AnimatePresence>
          {enCamara && !hecho && pose !== "frente" && modelo === "listo" && (
            <span className="fc-flecha" data-lado={(pose === "izq") === espejo ? "izq" : "der"} aria-hidden>
              {(pose === "izq") === espejo ? <ChevronLeft size={34} strokeWidth={2.5} /> : <ChevronRight size={34} strokeWidth={2.5} />}
            </span>
          )}
        </div>
        <AnimatePresence>
          {flash > 0 && (
            <motion.div key={flash} className="fc-flash" initial={{ opacity: 0.7 }} animate={{ opacity: 0 }} transition={{ duration: 0.35, ease: "easeOut" }} aria-hidden />
          )}
        </AnimatePresence>
      </div>

      {/* Barra superior: cerrar, progreso, voltear. */}
      <div className="fc-top">
        <button type="button" className="fc-icono" onClick={onCerrar} aria-label="Volver" disabled={enviando}>
          <X size={22} aria-hidden />
        </button>
        <ol className="fc-pasos" aria-label={`${n} de ${fotos.length} fotos`}>
          {fotos.map((f, i) => (
            <li key={i} data-on={f ? "" : undefined} data-act={enCamara && i === activa ? "" : undefined} />
          ))}
        </ol>
        {enCamara && varias ? (
          <button type="button" className="fc-icono" onClick={voltear} aria-label="Voltear cámara">
            <SwitchCamera size={22} aria-hidden />
          </button>
        ) : (
          <span className="fc-icono" data-vacio="" aria-hidden />
        )}
      </div>

      {enCamara && (
        <div className="fc-pie">
          <p className="fc-paso">
            Foto {activa + 1} de {fotos.length}
          </p>
          <p className="fc-instruccion" aria-live="polite">
            {hecho ? "Lista" : INSTRUCCION[pose][trasera ? 1 : 0]}
          </p>
          <p className="fc-guia" data-ok={guia === "ok" ? "" : undefined}>
            {cam === "abriendo" ? (
              <>
                <Loader2 size={16} className="s-spin" aria-hidden /> Abriendo cámara…
              </>
            ) : modelo === "cargando" ? (
              <>
                <Loader2 size={16} className="s-spin" aria-hidden /> Preparando…
              </>
            ) : modelo === "error" ? (
              "Toma la foto con el botón"
            ) : hecho || pausa ? (
              " "
            ) : guia === "ok" && luz === "contraluz" ? (
              "Hay luz detrás: mejor de frente a la luz"
            ) : guia ? (
              GUIA[guia]
            ) : (
              " "
            )}
          </p>
          {manual && (
            <button type="button" className="fc-obturador" onClick={() => !pausa && void tomarDeVideo()} disabled={pausa} aria-label="Tomar foto" />
          )}
        </div>
      )}

      {!enCamara && (
        <div className="fc-revision">
          <div className="fc-rev-cuerpo">
            <h2 className="fc-rev-h">{cam === "error" ? "Sube las fotos" : "Revisa las fotos"}</h2>
            <p className="fc-rev-p">
              {cam === "error"
                ? errCam
                : "Que se vea bien la cara, nítida y sin otras personas. Si alguna no sirve, repítela."}
            </p>
            <ul className="fc-miniaturas">
              {fotos.map((f, i) => (
                <li key={i} data-mal={malas.includes(i) ? "" : undefined}>
                  {f ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element -- vista previa local (blob:) */}
                      <img src={f.url} alt={`Foto ${i + 1}, ${NOMBRE_POSE[POSES[i]].toLowerCase()}`} style={f.espejo ? { transform: "scaleX(-1)" } : undefined} />
                      <span className="fc-etq">{NOMBRE_POSE[POSES[i]]}</span>
                      <button type="button" className="fc-repetir" onClick={() => repetir(i)} disabled={enviando}>
                        <RotateCcw size={14} aria-hidden /> Repetir
                      </button>
                    </>
                  ) : (
                    <button type="button" className="fc-vacia" onClick={() => repetir(i)} disabled={enviando} aria-label={`Tomar foto ${i + 1}${n >= minimo ? " (opcional)" : ""}`}>
                      <Camera size={22} aria-hidden />
                      <span>{n >= minimo ? "Opcional" : "Tomar"}</span>
                    </button>
                  )}
                  {!f && <span className="fc-etq">{NOMBRE_POSE[POSES[i]]}</span>}
                </li>
              ))}
            </ul>
            {cam === "error" && (
              <button
                type="button"
                className="fc-galeria"
                onClick={() => {
                  destino.current = Math.max(0, fotos.findIndex((f) => !f));
                  galeriaFile.current?.click();
                }}
                disabled={enviando || n >= fotos.length}
              >
                <ImageUp size={16} aria-hidden /> Elegir de la galería
              </button>
            )}
            <div aria-live="assertive">
              {(aviso || alerta) && (
                <p className="ins-alerta" role="alert">
                  {aviso ?? alerta}
                </p>
              )}
            </div>
          </div>
          <div className="fc-rev-pie">
            <button type="button" className="ins-btn" disabled={n < minimo || enviando} aria-busy={enviando} onClick={onEnviar}>
              {enviando ? <Loader2 size={20} className="s-spin" aria-hidden /> : null}
              {enviando ? "Enviando…" : reintentar ? "Reintentar envío" : "Enviar inscripción"}
            </button>
          </div>
        </div>
      )}

      {/* Respaldo: cámara nativa del teléfono (capture) o galería. */}
      <input ref={camaraFile} type="file" accept="image/*" capture="user" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void subir(e.target.files?.[0], e.currentTarget)} />
      <input ref={galeriaFile} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void subir(e.target.files?.[0], e.currentTarget)} />
    </motion.div>
  );
}
