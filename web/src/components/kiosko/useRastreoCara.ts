"use client";

// Rastreo de la cara en el navegador (MediaPipe Face Landmarker, 100 % local: el video no sale del equipo).
// Cada cuadro decide la "postura" (lejos, cerca, descentrado, quieto) y llena el anillo del círculo central
// mientras el niño se queda quieto. Al completarse, saca la foto sola.

import type { FaceLandmarker, NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { MotionValue } from "motion/react";
import type { Seguimiento } from "./Foto3D";
import { useEffect, useRef, useState, type RefObject } from "react";
import { calidadActual, type Calidad } from "./calidad";
import { PUNTOS_REF, type Rastro } from "./rastro";

export type Postura = "sin-cara" | "lejos" | "cerca" | "descentrado" | "quieto";
export type Objetivo = { cx: number; cy: number; r: number }; // círculo central, en px de pantalla

const MANTENER_MS = 900; // tiempo quieto en el círculo para sacar la foto
const PERDER_MS = 350; // si se mueve, el anillo se vacía en este tiempo
const LADO_MAX_FOTO = 720; // la foto que sube al servidor: lado largo máximo (px)
const CALIDAD_JPEG = 0.85;
// Intervalo mínimo entre análisis (ms). Con alguien frente a la cámara se analiza más seguido; sin nadie, la mitad.
const INTERVALO_MS: Record<Calidad, number> = { alto: 33, medio: 50, bajo: 80 };

type Opciones = {
  video: RefObject<HTMLVideoElement | null>;
  objetivo: RefObject<Objetivo>;
  progreso: MotionValue<number>;
  activo: boolean;
  intento: number;
  onCaptura: (foto: Blob) => void;
  /** Se llama en el acto de decidir la foto (antes de procesarla): permite mostrar "verificando" sin esperas. */
  onCapturando?: () => void;
  /** La foto no se pudo leer de la cámara: el rastreo sigue intentando. */
  onCapturaFallida?: () => void;
  /** Conserva el anillo lleno aunque `activo` sea falso (mientras se verifica). */
  mantenerAnillo?: boolean;
  /** Posición de la cara en pantalla (-1..1 desde el centro) para efectos que la siguen, como la foto 3D. */
  seguimiento?: Seguimiento;
  /** Elemento donde se ve el video (el escenario). Si no se da, es la ventana. `objetivo` va en px de ese elemento. */
  escenario?: RefObject<HTMLElement | null>;
  /** Recibe, en cada análisis, los puntos de referencia y la caja de la cara (normalizados), para dibujarlos. */
  rastro?: RefObject<Rastro>;
};

const URL_MODELO_REMOTO =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const RUTAS_MODELO = ["/models/face_landmarker.task", "/modelos/face-landmarker.task", URL_MODELO_REMOTO];

export function useRastreoCara({
  video, objetivo, progreso, activo, intento, onCaptura, onCapturando, onCapturaFallida, mantenerAnillo = false, seguimiento, escenario, rastro,
}: Opciones) {
  const [listo, setListo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [postura, setPostura] = useState<Postura>("sin-cara");

  // Al reintentar (cambia `intento`) se reinicia el estado durante el render, no dentro del efecto.
  const [intentoVisto, setIntentoVisto] = useState(intento);
  if (intentoVisto !== intento) {
    setIntentoVisto(intento);
    setListo(false);
    setError(null);
  }

  const detector = useRef<FaceLandmarker | null>(null);
  const activoRef = useRef(activo);
  const capturaRef = useRef({ onCaptura, onCapturando, onCapturaFallida });
  useEffect(() => {
    activoRef.current = activo;
    if (!activo && !mantenerAnillo) progreso.set(0);
  }, [activo, mantenerAnillo, progreso]);
  useEffect(() => {
    capturaRef.current = { onCaptura, onCapturando, onCapturaFallida };
  }, [onCaptura, onCapturando, onCapturaFallida]);

  // Carga del modelo (wasm y modelo servidos desde /public: funciona sin internet).
  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        // Carga perezosa: la librería (y su wasm) no pesan en el primer pintado del kiosko.
        const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
        const archivos = await FilesetResolver.forVisionTasks("/mediapipe");
        const crear = (modelAssetPath: string, delegate: "GPU" | "CPU") =>
          FaceLandmarker.createFromOptions(archivos, {
            baseOptions: { modelAssetPath, delegate },
            runningMode: "VIDEO",
            numFaces: 1,
          });
        let fl: FaceLandmarker | null = null;
        let ultimoError: unknown = null;
        for (const ruta of RUTAS_MODELO) {
          try {
            fl = await crear(ruta, "GPU").catch(() => crear(ruta, "CPU"));
            break;
          } catch (e) {
            ultimoError = e;
          }
        }
        if (!fl) throw ultimoError ?? new Error("No se pudo cargar el modelo de reconocimiento facial.");
        if (cancelado) return fl.close();
        detector.current = fl;
        setListo(true);
      } catch (e) {
        if (!cancelado) setError(e instanceof Error ? e.message : "No se pudo cargar el detector de caras. Toca la pantalla para reintentar.");
      }
    })();
    return () => {
      cancelado = true;
      detector.current?.close();
      detector.current = null;
    };
  }, [intento]);

  // Bucle de análisis: se engancha a los cuadros reales del video (requestVideoFrameCallback; rAF de respaldo),
  // limita la frecuencia según el dispositivo, se pausa con la pestaña oculta y no toca React salvo al cambiar
  // de postura. El anillo y el seguimiento van por MotionValues (sin re-render por cuadro).
  useEffect(() => {
    if (!listo) return;
    const v0 = video.current;
    if (!v0) return;
    const conRVFC = "requestVideoFrameCallback" in v0;
    let idCb = 0;
    let parado = false;
    let ultimoTiempoVideo = -1;
    let ultimoAnalisis = 0;
    let centroPrevio: { x: number; y: number } | null = null;
    let posturaActual: Postura = "sin-cara";
    let hayCara = false;
    let capturando = false;

    const programar = () => {
      if (parado) return;
      idCb = conRVFC ? v0.requestVideoFrameCallback(cuadro) : requestAnimationFrame(cuadro);
    };

    function cuadro() {
      programar();
      const v = video.current;
      const fl = detector.current;
      if (!v || !fl || v.readyState < 2 || !v.videoWidth || document.hidden) return;

      const ahora = performance.now();
      const intervalo = INTERVALO_MS[calidadActual()] * (hayCara && activoRef.current ? 1 : 2);
      if (ahora - ultimoAnalisis < intervalo - 2) return;
      if (v.currentTime === ultimoTiempoVideo) return;
      ultimoTiempoVideo = v.currentTime;
      const dt = ultimoAnalisis ? Math.min(ahora - ultimoAnalisis, 150) : 33;
      ultimoAnalisis = ahora;

      // El video cubre la pantalla (object-fit: cover), así que se mide en px de pantalla.
      const esc = escenario?.current;
      const W = esc?.offsetWidth || window.innerWidth;
      const H = esc?.offsetHeight || window.innerHeight;

      const resultado = fl.detectForVideo(v, ahora);
      const puntos = resultado.faceLandmarks[0];
      hayCara = Boolean(puntos);

      // Rastro para el lienzo de brackets y puntitos (se lee en su propio rAF, sin pasar por React).
      const R = rastro?.current;
      if (R) {
        R.t = ahora;
        R.hay = hayCara;
        R.fija = false;
        R.espejo = true;
        R.ancho = v.videoWidth;
        R.alto = v.videoHeight;
        if (puntos) {
          let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
          for (const lm of puntos) {
            if (lm.x < x0) x0 = lm.x;
            if (lm.x > x1) x1 = lm.x;
            if (lm.y < y0) y0 = lm.y;
            if (lm.y > y1) y1 = lm.y;
          }
          R.caja.x0 = x0;
          R.caja.y0 = y0;
          R.caja.x1 = x1;
          R.caja.y1 = y1;
          for (let i = 0; i < PUNTOS_REF.length; i++) {
            const lm = puntos[PUNTOS_REF[i]];
            if (!lm) continue;
            R.pts[i * 2] = lm.x;
            R.pts[i * 2 + 1] = lm.y;
          }
        }
      }

      // Del espacio del video (object-fit: cover, en espejo) al de la pantalla.
      const escala = Math.max(W / v.videoWidth, H / v.videoHeight);
      const dx = (W - v.videoWidth * escala) / 2;
      const dy = (H - v.videoHeight * escala) / 2;
      const aPantalla = (p: NormalizedLandmark) => ({
        x: W - (p.x * v.videoWidth * escala + dx),
        y: p.y * v.videoHeight * escala + dy,
      });

      let nueva: Postura = "sin-cara";
      let estable = false;
      if (puntos) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const lm of puntos) {
          const p = aPantalla(lm);
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        const centro = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
        const alto = maxY - minY;
        const { cx, cy, r } = objetivo.current;
        const distancia = Math.hypot(centro.x - cx, centro.y - cy);

        if (alto < r * 0.95) nueva = "lejos";
        else if (alto > r * 2.05) nueva = "cerca";
        else if (distancia > r * 0.38) nueva = "descentrado";
        else nueva = "quieto";

        // Umbral de movimiento por cuadro de ~33 ms: si se analiza menos seguido, se permite más desplazamiento.
        const movimiento = centroPrevio ? Math.hypot(centro.x - centroPrevio.x, centro.y - centroPrevio.y) : 0;
        estable = movimiento < r * 0.045 * Math.max(1, dt / 33);
        centroPrevio = centro;
        seguimiento?.x.set((centro.x / W - 0.5) * 2);
        seguimiento?.y.set((centro.y / H - 0.5) * 2);
        seguimiento?.presente.set(1);
      } else {
        centroPrevio = null;
        seguimiento?.presente.set(0);
      }

      if (nueva !== posturaActual) {
        posturaActual = nueva;
        setPostura(nueva);
      }

      // Anillo: se llena quieto y centrado, se vacía rápido si no.
      if (!activoRef.current || capturando) return;
      const p = progreso.get();
      const siguiente = nueva === "quieto" && estable ? p + dt / MANTENER_MS : p - dt / PERDER_MS;
      progreso.set(Math.max(0, Math.min(1, siguiente)));

      if (siguiente >= 1) {
        // Pausa en el acto: hasta que el kiosko vuelva a activar el rastreo (prop `activo`), no hay otra foto.
        // Sin esto, en los cuadros previos al re-render el anillo sigue lleno y dispara una segunda captura.
        capturando = true;
        activoRef.current = false;
        capturaRef.current.onCapturando?.(); // feedback inmediato: "Verificando…" antes de procesar la foto
        capturar(v).then((foto) => {
          capturando = false;
          if (foto) capturaRef.current.onCaptura(foto);
          else {
            activoRef.current = true; // no se pudo leer la cámara: seguir intentando
            capturaRef.current.onCapturaFallida?.();
          }
        });
      }
    }
    programar();
    return () => {
      parado = true;
      if (conRVFC) v0.cancelVideoFrameCallback(idCb);
      else cancelAnimationFrame(idCb);
    };
  }, [listo, video, objetivo, progreso, seguimiento, escenario, rastro]);

  return { listo, error, postura };
}

// Un solo canvas reutilizado entre capturas (evita reservar memoria de imagen cada vez).
let lienzo: HTMLCanvasElement | null = null;

/** Cuadro actual de la cámara como JPEG ≤720 px de lado largo, sin espejo (como lo vería cualquier otra cámara). */
function capturar(v: HTMLVideoElement): Promise<Blob | null> {
  const k = Math.min(1, LADO_MAX_FOTO / Math.max(v.videoWidth, v.videoHeight));
  const c = (lienzo ??= document.createElement("canvas"));
  c.width = Math.round(v.videoWidth * k);
  c.height = Math.round(v.videoHeight * k);
  const ctx = c.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(v, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/jpeg", CALIDAD_JPEG));
}
