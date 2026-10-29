"use client";

// Marco de la cara (estilo Face ID): un solo lienzo encima de la cámara que dibuja, en su propio requestAnimationFrame
// y sin tocar React por cuadro, (1) cuatro esquinas redondeadas que encuadran la cara y la siguen con suavizado
// exponencial, (2) ~20 puntitos de referencia (ojos, nariz, boca, mentón) y (3) la onda de luz y las chispas del éxito.
// Blanco mientras se alinea, verde FA CUP al quedarse quieto y reconocer, ámbar en aviso, rojo en error.
// Al sacar la foto, la cara se congela: el marco queda donde estaba la cara en la foto.

import { useEffect, useRef, type RefObject } from "react";
import { useCalidad } from "./calidad";
import { copiarRastro, crearRastro, cubrir, PUNTOS_REF, type Rastro } from "./rastro";
import { k } from "./tiempo";

export type ModoMarco = "busca" | "quieto" | "verifica" | "exito" | "ya" | "aviso" | "error";
export type Guia = { cx: number; cy: number; w: number; h: number }; // óvalo de reposo, en px del escenario

type Rgb = [number, number, number];
const BLANCO: Rgb = [255, 255, 255];
// Verde de marca (#008D36 a #95C11F), aclarado en el extremo oscuro para leerse sobre la cámara.
const VERDE_A: Rgb = [47, 196, 108];
const VERDE_B: Rgb = [149, 193, 31];
const AMBAR: Rgb = [245, 176, 74];
const ROJO: Rgb = [244, 100, 95];

const COLORES: Record<ModoMarco, [Rgb, Rgb]> = {
  busca: [BLANCO, BLANCO],
  quieto: [VERDE_A, VERDE_B],
  verifica: [VERDE_A, VERDE_B],
  exito: [VERDE_A, VERDE_B],
  ya: [[111, 184, 148], [111, 184, 148]],
  aviso: [AMBAR, AMBAR],
  error: [ROJO, ROJO],
};
const CONGELA: ModoMarco[] = ["verifica", "exito", "ya", "aviso", "error"];
const ANGULO_AUREO = 2.399963;

const rgb = (c: Rgb, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lim = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const suave = (k_: number, dt: number) => 1 - Math.exp(-k_ * dt);

type Props = { rastro: RefObject<Rastro>; modo: ModoMarco; guia: Guia; ancho: number; alto: number };

export default function Marco({ rastro, modo, guia, ancho, alto }: Props) {
  const lienzo = useRef<HTMLCanvasElement>(null);
  const calidad = useCalidad();
  const datos = useRef({ modo, guia, calidad, ancho, alto });
  useEffect(() => {
    datos.current = { modo, guia, calidad, ancho, alto };
  }, [modo, guia, calidad, ancho, alto]);

  // Tamaño del lienzo (px reales según la densidad, con tope para no cargar teléfonos).
  useEffect(() => {
    const cv = lienzo.current;
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, calidad === "alto" ? 2 : 1.5);
    cv.width = Math.round(ancho * dpr);
    cv.height = Math.round(alto * dpr);
    cv.dataset.dpr = String(dpr);
  }, [ancho, alto, calidad]);

  useEffect(() => {
    const cv = lienzo.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const T = k();
    const reducir = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const N = PUNTOS_REF.length;

    const congelado = crearRastro();
    let hayCongelado = false;
    let modoPrev: ModoMarco = datos.current.modo;
    let t0Modo = performance.now();
    let hayPrev = false;
    let t0Cara = 0;
    let verPuntos = 0;
    let cierre = 0;
    const color: [Rgb, Rgb] = [[255, 255, 255], [255, 255, 255]];
    const caja = { x: 0, y: 0, w: 0, h: 0, listo: false };
    const P = new Float32Array(N * 2);
    let ultimo = performance.now();
    let raf = 0;

    const esquina = (px: number, py: number, sx: number, sy: number, brazo: number, rad: number) => {
      ctx.moveTo(px, py + sy * brazo);
      ctx.lineTo(px, py + sy * rad);
      ctx.arcTo(px, py, px + sx * rad, py, rad);
      ctx.lineTo(px + sx * brazo, py);
    };

    function cuadro(ahora: number) {
      raf = requestAnimationFrame(cuadro);
      if (document.hidden) return;
      const dt = Math.min(0.05, (ahora - ultimo) / 1000);
      ultimo = ahora;
      const { modo: m, guia: g, calidad: cal, ancho: W, alto: H } = datos.current;
      const dpr = Number(cv!.dataset.dpr) || 1;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, W, H);

      // Cambio de modo: se congela la cara al sacar la foto y se descongela al volver a escanear.
      if (m !== modoPrev) {
        if (CONGELA.includes(m) && !CONGELA.includes(modoPrev)) {
          const R = rastro.current;
          hayCongelado = R.hay && (R.fija || ahora - R.t < 500);
          if (hayCongelado) copiarRastro(R, congelado);
        } else if (!CONGELA.includes(m)) hayCongelado = false;
        modoPrev = m;
        t0Modo = ahora;
      }
      const R = hayCongelado ? congelado : rastro.current;
      const hay = R.hay && (R.fija || hayCongelado || ahora - R.t < 500);
      const aparece = hay && !hayPrev;
      if (aparece) {
        t0Cara = ahora;
        caja.listo = false; // al aparecer una cara, el marco salta a ella sin viajar desde el óvalo
      }
      hayPrev = hay;

      // Objetivo del marco: la cara (caja de landmarks + margen) o, sin cara, el óvalo guía que respira.
      const rapido = reducir ? 80 : hay ? 15 : 6;
      let tx = g.cx, ty = g.cy, tw = g.w, th = g.h;
      const c = cubrir(R, W, H);
      const mapX = (nx: number) => {
        const x = nx * R.ancho * c.s + c.dx;
        return R.espejo ? W - x : x;
      };
      const mapY = (ny: number) => ny * R.alto * c.s + c.dy;
      if (hay) {
        const xa = mapX(R.caja.x0), xb = mapX(R.caja.x1);
        const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb);
        const y0 = mapY(R.caja.y0), y1 = mapY(R.caja.y1);
        const w = x1 - x0, h = y1 - y0;
        tw = w * 1.26;
        th = h * 1.16;
        tx = (x0 + x1) / 2;
        ty = (y0 + y1) / 2 - h * 0.02;
      } else if (!reducir) {
        const resp = 1 + 0.02 * Math.sin((ahora / 1000 / T) * 1.15);
        tw *= resp;
        th *= resp;
      }
      if (!caja.listo) {
        caja.x = tx; caja.y = ty; caja.w = tw; caja.h = th;
        caja.listo = true;
      }
      const a = suave(rapido, dt);
      caja.x = lerp(caja.x, tx, a);
      caja.y = lerp(caja.y, ty, a);
      caja.w = lerp(caja.w, tw, a);
      caja.h = lerp(caja.h, th, a);

      // "Se cierra" sobre la cara al reconocer (un resorte corto: pasa un poco y vuelve).
      const cierreObj = m === "exito" || m === "ya" ? 1 : 0;
      cierre = lerp(cierre, cierreObj, suave(reducir ? 80 : 9, dt));
      const te = (ahora - t0Modo) / 1000 / T; // segundos desde el cambio de modo (ya sin la escala de QA)
      let esc = 1 - 0.07 * cierre;
      if ((m === "exito" || m === "ya") && !reducir) esc -= 0.025 * Math.sin(Math.min(te, 0.6) * Math.PI * (1 / 0.6)) * (1 - Math.min(te / 0.6, 1));
      const bw = caja.w * esc, bh = caja.h * esc;

      // Temblor suave del aviso: 2 ciclos, 6 px como máximo.
      let temblor = 0;
      if (m === "aviso" && !reducir) {
        const u = lim((te - 0.25) / 0.9, 0, 1);
        temblor = 6 * Math.sin(u * Math.PI * 4) * (u > 0 && u < 1 ? 1 : 0);
      }

      // Color: blanco → verde (con degradado de marca) / ámbar / rojo, con transición.
      const objC = COLORES[m];
      const ac = suave(reducir ? 80 : 7, dt);
      for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) color[i][j] = lerp(color[i][j], objC[i][j], ac);
      const x = caja.x - bw / 2 + temblor;
      const y = caja.y - bh / 2;

      // Brackets: cuatro esquinas redondeadas.
      const lado = Math.min(bw, bh);
      const brazo = lado * 0.24;
      const rad = lado * 0.13;
      const grosor = lim(lado * 0.014, 3, 5);
      const gr = ctx!.createLinearGradient(x, y, x + bw, y + bh);
      gr.addColorStop(0, rgb(color[0]));
      gr.addColorStop(1, rgb(color[1]));
      const trazar = () => {
        ctx!.beginPath();
        esquina(x, y, 1, 1, brazo, rad);
        esquina(x + bw, y, -1, 1, brazo, rad);
        esquina(x, y + bh, 1, -1, brazo, rad);
        esquina(x + bw, y + bh, -1, -1, brazo, rad);
      };
      ctx!.lineCap = "round";
      ctx!.lineJoin = "round";
      // Sombra fina para que el blanco se lea sobre una cámara muy clara.
      ctx!.strokeStyle = "rgba(0,12,8,.28)";
      ctx!.lineWidth = grosor + 3;
      trazar();
      ctx!.stroke();
      const verde = m === "quieto" || m === "verifica" || m === "exito";
      if (cal === "alto" && verde) {
        ctx!.shadowColor = "rgba(52,210,124,.65)";
        ctx!.shadowBlur = 14;
      }
      ctx!.strokeStyle = gr;
      ctx!.lineWidth = grosor;
      trazar();
      ctx!.stroke();
      ctx!.shadowBlur = 0;

      // Puntitos de referencia sobre la cara (solo calidad alto/medio, solo con cara).
      verPuntos = lerp(verPuntos, hay ? 1 : 0, suave(10, dt));
      if (cal !== "bajo" && verPuntos > 0.01) {
        const kp = suave(reducir ? 80 : 26, dt);
        const radio = lim(bh * 0.0095, 2.2, 3.8);
        const claro: Rgb = [lerp(255, color[0][0], 0.22), lerp(255, color[0][1], 0.22), lerp(255, color[0][2], 0.22)];
        for (let i = 0; i < N; i++) {
          const px = mapX(R.pts[i * 2]) + temblor, py = mapY(R.pts[i * 2 + 1]);
          if (aparece) {
            P[i * 2] = px;
            P[i * 2 + 1] = py;
          }
          P[i * 2] = lerp(P[i * 2], px, kp);
          P[i * 2 + 1] = lerp(P[i * 2 + 1], py, kp);
          const ap = reducir ? 1 : lim((ahora - t0Cara) / 1000 - i * 0.028, 0, 0.22) / 0.22; // aparecen en cascada
          const al = ap * verPuntos;
          if (al <= 0.01) continue;
          const rr = radio * (0.6 + 0.4 * ap);
          ctx!.globalAlpha = al * 0.3;
          ctx!.fillStyle = "#001208"; // contorno tenue para que el punto se lea sobre piel clara
          ctx!.beginPath();
          ctx!.arc(P[i * 2], P[i * 2 + 1], rr + 1.2, 0, Math.PI * 2);
          ctx!.fill();
          ctx!.globalAlpha = al;
          ctx!.fillStyle = rgb(claro);
          ctx!.beginPath();
          ctx!.arc(P[i * 2], P[i * 2 + 1], rr, 0, Math.PI * 2);
          ctx!.fill();
        }
        ctx!.globalAlpha = 1;
        ctx!.shadowBlur = 0;
      }

      // Éxito: onda de luz desde la cara y pocas chispas (alto/medio). "Ya registrado": una sola onda tenue.
      if ((m === "exito" || m === "ya") && !reducir) {
        const grande = Math.max(W, H);
        const ondas = m === "ya" ? 1 : cal === "bajo" ? 1 : 2;
        for (let i = 0; i < ondas; i++) {
          const p = (te - 0.08 - i * 0.16) / (1.2 + i * 0.2);
          if (p <= 0 || p >= 1) continue;
          const e = 1 - Math.pow(1 - p, 3);
          ctx!.strokeStyle = m === "ya" ? `rgba(111,184,148,${0.5 * (1 - p)})` : `rgba(130,245,170,${0.7 * (1 - p) * (1 - p)})`;
          ctx!.lineWidth = i ? 1.5 : 2.2;
          if (cal === "alto" && m === "exito") {
            ctx!.shadowColor = "rgba(52,210,124,.6)";
            ctx!.shadowBlur = 18;
          }
          ctx!.beginPath();
          ctx!.ellipse(caja.x, caja.y, bw / 2 + e * grande * 0.5, bh / 2 + e * grande * 0.5, 0, 0, Math.PI * 2);
          ctx!.stroke();
          ctx!.shadowBlur = 0;
        }
        const n = m === "exito" ? (cal === "alto" ? 16 : cal === "medio" ? 9 : 0) : 0;
        for (let i = 0; i < n; i++) {
          const p = (te - 0.12 - (i % 8) * 0.045) / 1.15;
          if (p <= 0 || p >= 1) continue;
          const ang = i * ANGULO_AUREO - Math.PI / 2;
          const alc = Math.max(bw, bh) * (0.16 + ((i * 11) % 7) * 0.05);
          const e = 1 - Math.pow(1 - p, 3);
          const sx = caja.x + Math.cos(ang) * (bw / 2) * 1.02 + Math.cos(ang) * alc * e;
          const sy = caja.y + Math.sin(ang) * (bh / 2) * 1.02 + Math.sin(ang) * alc * e;
          const tam = (2.2 + ((i * 7) % 4) * 0.9) * (1 - p * 0.7);
          ctx!.globalAlpha = Math.min(1, p * 8) * (1 - p);
          ctx!.fillStyle = "#e6ffb8";
          ctx!.shadowColor = "rgba(149,235,90,.7)";
          ctx!.shadowBlur = 8;
          ctx!.beginPath();
          ctx!.arc(sx, sy, tam, 0, Math.PI * 2);
          ctx!.fill();
        }
        ctx!.globalAlpha = 1;
        ctx!.shadowBlur = 0;
      }
    }
    raf = requestAnimationFrame(cuadro);
    return () => cancelAnimationFrame(raf);
  }, [rastro]);

  return <canvas ref={lienzo} aria-hidden className="pointer-events-none absolute inset-0 z-[3] h-full w-full" />;
}
