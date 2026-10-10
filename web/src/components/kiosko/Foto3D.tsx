"use client";

// Foto con profundidad real (efecto "foto 3D"): un mapa de profundidad (MiDaS, calculado una vez) desplaza
// cada píxel según qué tan cerca está, así lo cercano se mueve más que el fondo y la imagen parece salir de
// la pantalla. Se mueve sola, lento; si hay alguien mirando, sigue su cabeza como una ventana.
// WebGL puro (sin librerías). Sin WebGL o con "reducir movimiento" se muestra la foto quieta.

import type { MotionValue } from "motion/react";
import { useEffect, useRef, useState } from "react";

const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT = `
precision mediump float;
uniform sampler2D uImg;
uniform sampler2D uProf;
uniform vec2 uRes;
uniform vec2 uImgSize;
uniform vec2 uOff;
uniform float uZoom;
uniform float uFuerza;
varying vec2 vUv;
void main() {
  // object-fit: cover
  float rs = uRes.x / uRes.y;
  float ri = uImgSize.x / uImgSize.y;
  vec2 s = rs > ri ? vec2(1.0, ri / rs) : vec2(rs / ri, 1.0);
  vec2 uv = (vUv - 0.5) * s / uZoom + 0.5;
  float d = texture2D(uProf, uv).r;               // 1 = cerca, 0 = lejos
  vec2 p = uv + uOff * (d - 0.4) * uFuerza;       // lo cercano se desplaza más: paralaje
  gl_FragColor = texture2D(uImg, clamp(p, 0.002, 0.998));
}`;

export type Seguimiento = { x: MotionValue<number>; y: MotionValue<number>; presente: MotionValue<number> };

type Props = { src: string; profundidad: string; seguimiento?: Seguimiento; fuerza?: number; className?: string };

export default function Foto3D({ src, profundidad, seguimiento, fuerza = 0.045, className }: Props) {
  const contenedor = useRef<HTMLDivElement>(null);
  const [sinWebGL, setSinWebGL] = useState(false);
  const seg = useRef(seguimiento);
  useEffect(() => {
    seg.current = seguimiento;
  }, [seguimiento]);

  useEffect(() => {
    // Sin WebGL se muestra la foto quieta (se avisa fuera del cuerpo del efecto).
    const fallar = () => queueMicrotask(() => setSinWebGL(true));
    // Un lienzo nuevo por montaje: al desmontar se libera su contexto WebGL, y un lienzo reutilizado
    // devolvería ese contexto ya perdido (pasa al remontar, p. ej. en desarrollo con React estricto).
    const caja = contenedor.current;
    if (!caja) return;
    const c = document.createElement("canvas");
    c.className = "block h-full w-full";
    c.setAttribute("aria-hidden", "true");
    caja.appendChild(c);
    const gl = c.getContext("webgl", { antialias: false, premultipliedAlpha: false });
    if (!gl) {
      c.remove();
      fallar();
      return;
    }
    const quieto = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const shader = (tipo: number, codigo: string) => {
      const sh = gl.createShader(tipo)!;
      gl.shaderSource(sh, codigo);
      gl.compileShader(sh);
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      fallar();
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const u = (n: string) => gl.getUniformLocation(prog, n);
    const uRes = u("uRes"), uImgSize = u("uImgSize"), uOff = u("uOff"), uZoom = u("uZoom"), uFuerza = u("uFuerza");
    gl.uniform1i(u("uImg"), 0);
    gl.uniform1i(u("uProf"), 1);
    gl.uniform1f(uFuerza, fuerza);

    const textura = (unidad: number, img: HTMLImageElement) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unidad);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      // Sin mipmaps: funciona con imágenes de cualquier tamaño (no potencia de 2) en WebGL1.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    const cargar = (url: string) =>
      new Promise<HTMLImageElement>((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = url;
      });

    let raf = 0;
    let vivo = true;
    const off = { x: 0, y: 0 };

    Promise.all([cargar(src), cargar(profundidad)])
      .then(([img, prof]) => {
        if (!vivo) return;
        textura(0, img);
        textura(1, prof);
        gl.uniform2f(uImgSize, img.naturalWidth, img.naturalHeight);
        const t0 = performance.now();

        const cuadro = () => {
          if (!vivo) return;
          raf = requestAnimationFrame(cuadro);
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const w = Math.round(c.clientWidth * dpr);
          const h = Math.round(c.clientHeight * dpr);
          if (c.width !== w || c.height !== h) {
            c.width = w;
            c.height = h;
            gl.viewport(0, 0, w, h);
          }
          const t = (performance.now() - t0) / 1000;

          // Movimiento propio, lento (órbita suave) …
          let objX = quieto ? 0 : Math.sin(t * 0.21) * 0.55;
          let objY = quieto ? 0 : Math.cos(t * 0.16) * 0.35;
          // … o la cabeza de quien mira: la foto se comporta como una ventana.
          const s = seg.current;
          if (s && !quieto && s.presente.get() > 0.5) {
            objX = -s.x.get() * 1.1;
            objY = s.y.get() * 0.8;
          }
          off.x += (objX - off.x) * 0.045;
          off.y += (objY - off.y) * 0.045;

          gl.uniform2f(uRes, w, h);
          gl.uniform2f(uOff, off.x, off.y);
          gl.uniform1f(uZoom, quieto ? 1.06 : 1.09 + Math.sin(t * 0.05) * 0.025);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        };
        cuadro();
      })
      .catch(fallar);

    return () => {
      vivo = false;
      cancelAnimationFrame(raf);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      c.remove();
    };
  }, [src, profundidad, fuerza]);

  if (sinWebGL) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className={`h-full w-full object-cover ${className ?? ""}`} />;
  }
  return <div ref={contenedor} className={`h-full w-full ${className ?? ""}`} />;
}
