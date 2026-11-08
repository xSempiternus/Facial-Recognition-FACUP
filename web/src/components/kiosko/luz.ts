"use client";

// Luz de la escena: cada ~500 ms se reduce el cuadro de la cámara a 32x32 px (costo despreciable, fuera del bucle de
// rastreo) y se mide la luminosidad. "poca" = escena o cara muy oscura; "contraluz" = cara mucho más oscura que el
// fondo. Con histéresis (entrar cuesta varias muestras seguidas, salir más y con umbrales distintos) para no parpadear.
// calidad.ts no mide luz (solo FPS/dispositivo), por eso vive aparte.

import { useEffect, useState, type RefObject } from "react";
import type { Rastro } from "./rastro";

export type Luz = "ok" | "poca" | "contraluz";

const LADO = 32;
const CADA_MS = 500;
const POCA_ENTRA = 52; // luma media (0..255) bajo la cual hay poca luz
const POCA_SALE = 68;
const CONTRA_RATIO_ENTRA = 0.55; // cara / fondo
const CONTRA_RATIO_SALE = 0.72;
const CONTRA_FONDO_MIN = 105; // el fondo debe ser claro para hablar de contraluz
const MUESTRAS_ENTRAR = 3; // 1,5 s seguidos
const MUESTRAS_SALIR = 4; // 2 s seguidos

export function useLuz(video: RefObject<HTMLVideoElement | null>, rastro: RefObject<Rastro>, activo: boolean): Luz {
  const [luz, setLuz] = useState<Luz>("ok");

  useEffect(() => {
    if (!activo) return;
    const cv = document.createElement("canvas");
    cv.width = cv.height = LADO;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    let actual: Luz = "ok";
    let cuenta = 0;

    const medir = () => {
      const v = video.current;
      if (document.hidden || !v || v.readyState < 2 || !v.videoWidth) return;
      let datos: Uint8ClampedArray;
      try {
        ctx.drawImage(v, 0, 0, LADO, LADO); // el cuadro entero, estirado: las coordenadas normalizadas del rastro valen igual
        datos = ctx.getImageData(0, 0, LADO, LADO).data;
      } catch {
        return;
      }
      const R = rastro.current;
      const hayCara = R.hay && performance.now() - R.t < 700;
      // Caja de la cara (reducida al centro) y anillo exterior (fuera de la caja ampliada).
      const cx = (R.caja.x0 + R.caja.x1) / 2, cy = (R.caja.y0 + R.caja.y1) / 2;
      const hw = ((R.caja.x1 - R.caja.x0) / 2) || 0.1, hh = ((R.caja.y1 - R.caja.y0) / 2) || 0.1;
      let sumTodo = 0, sumCara = 0, nCara = 0, sumFondo = 0, nFondo = 0;
      for (let y = 0; y < LADO; y++) {
        for (let x = 0; x < LADO; x++) {
          const i = (y * LADO + x) * 4;
          const l = 0.2126 * datos[i] + 0.7152 * datos[i + 1] + 0.0722 * datos[i + 2];
          sumTodo += l;
          if (!hayCara) continue;
          const nx = (x + 0.5) / LADO, ny = (y + 0.5) / LADO;
          const dx = Math.abs(nx - cx) / hw, dy = Math.abs(ny - cy) / hh;
          if (dx < 0.6 && dy < 0.6) {
            sumCara += l;
            nCara++;
          } else if (dx > 1.15 || dy > 1.15) {
            sumFondo += l;
            nFondo++;
          }
        }
      }
      const media = sumTodo / (LADO * LADO);
      const cara = nCara ? sumCara / nCara : media;
      const fondo = nFondo ? sumFondo / nFondo : media;
      const ref = hayCara && nCara ? cara : media; // con cara, importa la luz sobre la cara

      // Objetivo según el estado actual (umbrales distintos para entrar y salir).
      let objetivo: Luz = "ok";
      if (ref < (actual === "poca" ? POCA_SALE : POCA_ENTRA)) objetivo = "poca";
      else if (hayCara && nCara && nFondo && fondo > CONTRA_FONDO_MIN) {
        const ratio = cara / fondo;
        if (ratio < (actual === "contraluz" ? CONTRA_RATIO_SALE : CONTRA_RATIO_ENTRA)) objetivo = "contraluz";
      }

      if (objetivo === actual) {
        cuenta = 0;
        return;
      }
      cuenta++;
      if (cuenta >= (objetivo === "ok" ? MUESTRAS_SALIR : MUESTRAS_ENTRAR)) {
        actual = objetivo;
        cuenta = 0;
        setLuz(objetivo);
      }
    };

    const id = setInterval(medir, CADA_MS);
    return () => {
      clearInterval(id);
      setLuz("ok"); // al pausar el rastreo se parte de cero
    };
  }, [video, rastro, activo]);

  return activo ? luz : "ok";
}
