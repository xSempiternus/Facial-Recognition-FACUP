"use client";

// Captura automática de las fotos del formulario de padres (MediaPipe Face Landmarker, 100 % local).
// Mismo enfoque que el kiosko (useRastreoCara) pero con lo que este paso necesita y el kiosko no: detecta hasta
// 2 caras (para avisar "solo una cara"), mide el giro de la cabeza (frente / izquierda / derecha) y usa un óvalo
// guía. Reusa sin modificar luz.ts, calidad.ts y rastro.ts del kiosko. El modelo y el wasm son los mismos de /public.

import type { FaceLandmarker, NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { MotionValue } from "motion/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { calidadActual, type Calidad } from "@/components/kiosko/calidad";
import { useLuz, type Luz } from "@/components/kiosko/luz";
import { crearRastro } from "@/components/kiosko/rastro";

export type Pose = "frente" | "izq" | "der";
export type Guia = "sin-cara" | "varias" | "lejos" | "cerca" | "descentrado" | "girar-mas" | "girar-menos" | "mirar-frente" | "luz" | "ok";
export type Ovalo = { cx: number; cy: number; w: number; h: number }; // en px del escenario
export type EstadoModelo = "cargando" | "listo" | "error";

/** Umbrales (tamaños y distancias relativos al alto del óvalo guía, en px de pantalla). */
export const UMBRAL = {
  mantenerMs: 600, // quieto y bien puesto este tiempo -> foto
  perderMs: 350, // si se pierde la postura, el anillo se vacía en este tiempo
  altoMin: 0.5, // alto de la cara (frente a mentón) / alto del óvalo: menos = "más cerca"
  altoMax: 0.98, // más = "más lejos"
  centro: 0.15, // distancia del centro de la cara al del óvalo (de frente)
  centroLado: 0.2, // ídem con la cabeza girada (el centro de los puntos se corre)
  movimiento: 0.025, // desplazamiento máximo por cuadro de ~33 ms para contar como "quieto"
  yawFrente: 0.16, // |giro| máximo para "de frente" (0 = de frente, ~0,5 = unos 30°)
  yawLadoMin: 0.2, // giro mínimo para las fotos de lado ("ligeramente")
  yawLadoMax: 0.62, // giro máximo (más: la otra mitad de la cara deja de verse)
  segundaCara: 0.4, // una 2.ª cara cuenta si mide al menos esto del alto de la principal
} as const;

const INTERVALO_MS: Record<Calidad, number> = { alto: 40, medio: 60, bajo: 90 };
const TIEMPO_MODELO_MS = 25_000; // red móvil lenta: pasado esto, modo manual
const URL_MODELO_REMOTO = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const RUTAS_MODELO = ["/models/face_landmarker.task", "/modelos/face-landmarker.task", URL_MODELO_REMOTO];

type Opciones = {
  video: RefObject<HTMLVideoElement | null>;
  escenario: RefObject<HTMLElement | null>;
  ovalo: RefObject<Ovalo>;
  progreso: MotionValue<number>;
  pose: Pose;
  /** Analiza y llena el anillo solo si es verdadero (cámara lista, sin pausa entre fotos). */
  activo: boolean;
  /** La cámara funciona: se carga el modelo y se mide la luz. */
  camara: boolean;
  espejo: boolean;
  /** Se llama al completar el anillo. Devuelve true si la foto quedó; false = seguir intentando. */
  onDisparo: () => Promise<boolean>;
};

/** Giro horizontal de la cabeza en la imagen sin espejo: >0 = el sujeto mira hacia SU izquierda. */
function giro(p: NormalizedLandmark[]): number {
  const nariz = p[1], a = p[234], b = p[454];
  if (!nariz || !a || !b) return 0;
  const medio = (a.x + b.x) / 2;
  const semi = Math.abs(b.x - a.x) / 2;
  return semi > 1e-4 ? (nariz.x - medio) / semi : 0;
}

export function useCapturaAuto({ video, escenario, ovalo, progreso, pose, activo, camara, espejo, onDisparo }: Opciones) {
  const [modelo, setModelo] = useState<EstadoModelo>("cargando");
  const [guia, setGuia] = useState<Guia>("sin-cara");
  const detector = useRef<FaceLandmarker | null>(null);
  const rastro = useRef(crearRastro());
  const luz = useLuz(video, rastro, camara && modelo === "listo");
  const vivo = useRef({ activo, pose, espejo, luz: luz as Luz, onDisparo });
  useEffect(() => {
    vivo.current = { activo, pose, espejo, luz, onDisparo };
  }, [activo, pose, espejo, luz, onDisparo]);
  // Nueva pose (o vuelta del descanso entre fotos): el anillo parte vacío.
  useEffect(() => {
    if (activo) progreso.set(0);
  }, [activo, pose, progreso]);

  // Modelo: carga perezosa al tener cámara; GPU con respaldo en CPU.
  useEffect(() => {
    if (!camara) return;
    let cancelado = false;
    let expiro = false;
    const reloj = setTimeout(() => {
      expiro = true;
      if (!cancelado) setModelo("error");
    }, TIEMPO_MODELO_MS);
    (async () => {
      const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
      const archivos = await FilesetResolver.forVisionTasks("/mediapipe");
      const crear = (modelAssetPath: string, delegate: "GPU" | "CPU") =>
        FaceLandmarker.createFromOptions(archivos, { baseOptions: { modelAssetPath, delegate }, runningMode: "VIDEO", numFaces: 2 });
      let fl: FaceLandmarker | null = null;
      for (const ruta of RUTAS_MODELO) {
        try {
          fl = await crear(ruta, "GPU").catch(() => crear(ruta, "CPU"));
          break;
        } catch {}
      }
      if (!fl) throw new Error("modelo");
      clearTimeout(reloj);
      if (cancelado || expiro) return fl.close();
      detector.current = fl;
      setModelo("listo");
    })().catch(() => {
      clearTimeout(reloj);
      if (!cancelado && !expiro) setModelo("error");
    });
    return () => {
      cancelado = true;
      clearTimeout(reloj);
      detector.current?.close();
      detector.current = null;
    };
  }, [camara]);

  // Bucle de análisis enganchado a los cuadros del video. Solo toca React al cambiar la guía.
  useEffect(() => {
    if (modelo !== "listo") return;
    const v0 = video.current;
    if (!v0) return;
    const conRVFC = "requestVideoFrameCallback" in v0;
    let id = 0;
    let parado = false;
    let ultimoTiempo = -1;
    let ultimo = 0;
    let previo: { x: number; y: number } | null = null;
    let guiaActual: Guia = "sin-cara";
    let disparando = false;

    const programar = () => {
      if (!parado) id = conRVFC ? v0.requestVideoFrameCallback(cuadro) : requestAnimationFrame(cuadro);
    };

    function cuadro() {
      programar();
      const v = video.current;
      const fl = detector.current;
      const vv = vivo.current;
      if (!v || !fl || v.readyState < 2 || !v.videoWidth || document.hidden || !vv.activo || disparando) return;
      const ahora = performance.now();
      if (ahora - ultimo < INTERVALO_MS[calidadActual()] - 2 || v.currentTime === ultimoTiempo) return;
      ultimoTiempo = v.currentTime;
      const dt = ultimo ? Math.min(ahora - ultimo, 150) : 33;
      ultimo = ahora;

      let caras: NormalizedLandmark[][];
      try {
        caras = fl.detectForVideo(v, ahora).faceLandmarks;
      } catch {
        return;
      }
      const esc = escenario.current;
      const W = esc?.offsetWidth || window.innerWidth;
      const H = esc?.offsetHeight || window.innerHeight;
      const k = Math.max(W / v.videoWidth, H / v.videoHeight); // object-fit: cover
      const dx = (W - v.videoWidth * k) / 2;
      const dy = (H - v.videoHeight * k) / 2;
      const cajas = caras.map((pts) => {
        let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
        for (const p of pts) {
          if (p.x < x0) x0 = p.x;
          if (p.x > x1) x1 = p.x;
          if (p.y < y0) y0 = p.y;
          if (p.y > y1) y1 = p.y;
        }
        return { x0, y0, x1, y1, alto: (y1 - y0) * v.videoHeight * k };
      });
      let iP = 0;
      cajas.forEach((c, i) => c.alto > cajas[iP].alto && (iP = i));

      const R = rastro.current; // para la medición de luz (cara vs fondo)
      R.t = ahora;
      R.hay = caras.length > 0;
      if (R.hay) Object.assign(R.caja, { x0: cajas[iP].x0, y0: cajas[iP].y0, x1: cajas[iP].x1, y1: cajas[iP].y1 });

      let g: Guia = "sin-cara";
      let quieto = false;
      if (caras.length) {
        const c = cajas[iP];
        const o = ovalo.current;
        const x0 = c.x0 * v.videoWidth * k + dx, x1 = c.x1 * v.videoWidth * k + dx;
        const cx = vv.espejo ? W - (x0 + x1) / 2 : (x0 + x1) / 2;
        const cy = ((c.y0 + c.y1) / 2) * v.videoHeight * k + dy;
        const dist = Math.hypot(cx - o.cx, cy - o.cy);
        const yaw = giro(caras[iP]);
        const dir = vv.pose === "izq" ? 1 : vv.pose === "der" ? -1 : 0;
        const varias = cajas.some((x, i) => i !== iP && x.alto >= c.alto * UMBRAL.segundaCara);
        if (varias) g = "varias";
        else if (c.alto < o.h * UMBRAL.altoMin) g = "lejos";
        else if (c.alto > o.h * UMBRAL.altoMax) g = "cerca";
        else if (dist > o.h * (dir ? UMBRAL.centroLado : UMBRAL.centro)) g = "descentrado";
        else if (!dir && Math.abs(yaw) > UMBRAL.yawFrente) g = "mirar-frente";
        else if (dir && yaw * dir < UMBRAL.yawLadoMin) g = "girar-mas";
        else if (dir && yaw * dir > UMBRAL.yawLadoMax) g = "girar-menos";
        else if (vv.luz === "poca") g = "luz";
        else g = "ok";
        const mov = previo ? Math.hypot(cx - previo.x, cy - previo.y) : 0;
        quieto = mov < o.h * UMBRAL.movimiento * Math.max(1, dt / 33);
        previo = { x: cx, y: cy };
      } else previo = null;

      if (g !== guiaActual) {
        guiaActual = g;
        setGuia(g);
      }
      const p = progreso.get();
      const sig = Math.max(0, Math.min(1, g === "ok" && quieto ? p + dt / UMBRAL.mantenerMs : p - dt / UMBRAL.perderMs));
      progreso.set(sig);
      if (sig < 1) return;
      disparando = true;
      vv.onDisparo().then(
        (ok) => {
          disparando = false;
          // Foto tomada: pausa en el acto hasta que el paso vuelva a activar el rastreo (evita una 2.ª foto
          // en los cuadros previos al re-render, con el anillo aún lleno).
          if (ok) vivo.current.activo = false;
          else progreso.set(0);
        },
        () => {
          disparando = false;
          progreso.set(0);
        },
      );
    }
    programar();
    return () => {
      parado = true;
      if (conRVFC) v0.cancelVideoFrameCallback(id);
      else cancelAnimationFrame(id);
    };
  }, [modelo, video, escenario, ovalo, progreso]);

  return { modelo, guia: modelo === "listo" ? guia : null, luz };
}
