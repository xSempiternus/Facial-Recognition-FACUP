"use client";

// Rastreo de la cara en el navegador (MediaPipe Face Landmarker, 100 % local: el video no sale del equipo).
// Cada cuadro decide la "postura" (lejos, cerca, descentrado, quieto) y llena el anillo del círculo central
// mientras el niño se queda quieto. Al completarse, saca la foto sola.

import { FaceLandmarker, FilesetResolver, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { MotionValue } from "motion/react";
import type { Seguimiento } from "./Foto3D";
import { useEffect, useRef, useState, type RefObject } from "react";

export type Postura = "sin-cara" | "lejos" | "cerca" | "descentrado" | "quieto";
export type Objetivo = { cx: number; cy: number; r: number }; // círculo central, en px de pantalla

const MANTENER_MS = 900; // tiempo quieto en el círculo para sacar la foto
const PERDER_MS = 350; // si se mueve, el anillo se vacía en este tiempo

type Opciones = {
  video: RefObject<HTMLVideoElement | null>;
  objetivo: RefObject<Objetivo>;
  progreso: MotionValue<number>;
  activo: boolean;
  intento: number;
  onCaptura: (foto: Blob) => void;
  /** Posición de la cara en pantalla (-1..1 desde el centro) para efectos que la siguen, como la foto 3D. */
  seguimiento?: Seguimiento;
};

const URL_MODELO_REMOTO =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const RUTAS_MODELO = ["/models/face_landmarker.task", "/modelos/face-landmarker.task", URL_MODELO_REMOTO];

export function useRastreoCara({ video, objetivo, progreso, activo, intento, onCaptura, seguimiento }: Opciones) {
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
  const capturaRef = useRef(onCaptura);
  useEffect(() => {
    activoRef.current = activo;
    if (!activo) progreso.set(0);
  }, [activo, progreso]);
  useEffect(() => {
    capturaRef.current = onCaptura;
  }, [onCaptura]);

  // Carga del modelo (wasm y modelo servidos desde /public: funciona sin internet).
  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
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

  // Bucle por cuadro.
  useEffect(() => {
    if (!listo) return;
    let raf = 0;
    let ultimoTiempoVideo = -1;
    let ultimoMs = performance.now();
    let centroPrevio: { x: number; y: number } | null = null;
    let posturaActual: Postura = "sin-cara";
    let capturando = false;

    const cuadro = () => {
      raf = requestAnimationFrame(cuadro);
      const v = video.current;
      const fl = detector.current;
      if (!v || !fl || v.readyState < 2 || !v.videoWidth) return;

      const ahora = performance.now();
      const dt = Math.min(ahora - ultimoMs, 100);
      ultimoMs = ahora;
      if (v.currentTime === ultimoTiempoVideo) return;
      ultimoTiempoVideo = v.currentTime;

      // El video cubre la pantalla (object-fit: cover), así que se mide en px de pantalla.
      const W = window.innerWidth;
      const H = window.innerHeight;

      const resultado = fl.detectForVideo(v, ahora);
      const puntos = resultado.faceLandmarks[0];

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
        const pts = puntos.map(aPantalla);
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const p of pts) {
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

        const movimiento = centroPrevio ? Math.hypot(centro.x - centroPrevio.x, centro.y - centroPrevio.y) : 0;
        estable = movimiento < r * 0.045;
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
        capturar(v).then((foto) => {
          capturando = false;
          if (foto) capturaRef.current(foto);
          else activoRef.current = true; // no se pudo leer la cámara: seguir intentando
        });
      }
    };
    raf = requestAnimationFrame(cuadro);
    return () => cancelAnimationFrame(raf);
  }, [listo, video, objetivo, progreso, seguimiento]);

  return { listo, error, postura };
}

/** Cuadro actual de la cámara como JPEG, sin espejo (como lo vería cualquier otra cámara). */
function capturar(v: HTMLVideoElement): Promise<Blob | null> {
  const c = document.createElement("canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d")?.drawImage(v, 0, 0);
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.92));
}
