"use client";

// Rastreo de la cara en el navegador (MediaPipe Face Landmarker, 100 % local: el video no sale del equipo).
// Cada cuadro: dibuja la malla sobre la cara, decide la "postura" (lejos, cerca, descentrado, quieto) y llena
// el anillo del círculo central mientras el niño se queda quieto. Al completarse, saca la foto sola.

import { FaceLandmarker, FilesetResolver, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { MotionValue } from "motion/react";
import { useEffect, useRef, useState, type RefObject } from "react";

export type Postura = "sin-cara" | "lejos" | "cerca" | "descentrado" | "quieto";
export type Objetivo = { cx: number; cy: number; r: number }; // círculo central, en px de pantalla

const MANTENER_MS = 900; // tiempo quieto en el círculo para sacar la foto
const PERDER_MS = 350; // si se mueve, el anillo se vacía en este tiempo

// Malla: un punto de cada tantos (la malla completa tiene 478) + contorno de la cara.
const PASO_MALLA = 3;

type Opciones = {
  video: RefObject<HTMLVideoElement | null>;
  lienzo: RefObject<HTMLCanvasElement | null>;
  objetivo: RefObject<Objetivo>;
  progreso: MotionValue<number>;
  activo: boolean;
  onCaptura: (foto: Blob) => void;
};

export function useRastreoCara({ video, lienzo, objetivo, progreso, activo, onCaptura }: Opciones) {
  const [listo, setListo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [postura, setPostura] = useState<Postura>("sin-cara");

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
        const crear = (delegate: "GPU" | "CPU") =>
          FaceLandmarker.createFromOptions(archivos, {
            baseOptions: { modelAssetPath: "/models/face_landmarker.task", delegate },
            runningMode: "VIDEO",
            numFaces: 1,
          });
        const fl = await crear("GPU").catch(() => crear("CPU"));
        if (cancelado) return fl.close();
        detector.current = fl;
        setListo(true);
      } catch (e) {
        if (!cancelado) setError(e instanceof Error ? e.message : "No se pudo cargar el detector de caras.");
      }
    })();
    return () => {
      cancelado = true;
      detector.current?.close();
      detector.current = null;
    };
  }, []);

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
      const c = lienzo.current;
      const fl = detector.current;
      if (!v || !c || !fl || v.readyState < 2 || !v.videoWidth) return;

      const ahora = performance.now();
      const dt = Math.min(ahora - ultimoMs, 100);
      ultimoMs = ahora;
      if (v.currentTime === ultimoTiempoVideo) return;
      ultimoTiempoVideo = v.currentTime;

      // Lienzo del tamaño de la pantalla (nítido en pantallas de alta densidad).
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth;
      const H = c.clientHeight;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

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

        dibujarMalla(ctx, pts, nueva === "quieto");
      } else {
        centroPrevio = null;
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
  }, [listo, video, lienzo, objetivo, progreso]);

  return { listo, error, postura };
}

function dibujarMalla(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], enfocado: boolean) {
  // Puntos de la malla: lima cuando está centrado, cal tenue mientras se acomoda.
  ctx.fillStyle = enfocado ? "rgba(149, 193, 31, 0.85)" : "rgba(234, 245, 228, 0.45)";
  for (let i = 0; i < pts.length; i += PASO_MALLA) {
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, enfocado ? 1.6 : 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
  // Contorno de la cara.
  ctx.strokeStyle = enfocado ? "rgba(149, 193, 31, 0.9)" : "rgba(234, 245, 228, 0.35)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const { start, end } of FaceLandmarker.FACE_LANDMARKS_FACE_OVAL) {
    ctx.moveTo(pts[start].x, pts[start].y);
    ctx.lineTo(pts[end].x, pts[end].y);
  }
  ctx.stroke();
}

/** Cuadro actual de la cámara como JPEG, sin espejo (como lo vería cualquier otra cámara). */
function capturar(v: HTMLVideoElement): Promise<Blob | null> {
  const c = document.createElement("canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d")?.drawImage(v, 0, 0);
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.92));
}
