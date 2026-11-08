"use client";

import { useId, useState, type PointerEvent } from "react";

const W = 600;
const H = 120;
const PX = 8;
const PY = 12;

/** Llegadas acumuladas del día: línea discreta; al tocar o pasar el dedo muestra la hora y el total. */
export function Curva({ puntos }: { puntos: { hora: string; total: number }[] }) {
  const id = useId();
  const [sel, setSel] = useState<number | null>(null);
  if (puntos.length < 2) return null;

  const max = Math.max(...puntos.map((p) => p.total), 1);
  const x = (i: number) => PX + (i / (puntos.length - 1)) * (W - PX * 2);
  const y = (t: number) => H - PY - (t / max) * (H - PY * 2);
  const linea = puntos.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.total).toFixed(1)}`).join(" ");
  const area = `${linea} L${x(puntos.length - 1).toFixed(1)} ${H} L${x(0).toFixed(1)} ${H} Z`;

  const alMover = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    const i = Math.round(((f * W - PX) / (W - PX * 2)) * (puntos.length - 1));
    setSel(Math.max(0, Math.min(puntos.length - 1, i)));
  };

  const p = sel === null ? puntos[puntos.length - 1] : puntos[sel];
  const i = sel === null ? puntos.length - 1 : sel;
  const izq = `${(x(i) / W) * 100}%`;

  return (
    <div className="hy-curva">
      <div className="hy-curva-top">
        <span>Llegadas durante el día</span>
        <span className="hy-curva-val tnum" aria-live="off">
          <b>{p.total}</b> a las {p.hora}
        </span>
      </div>
      <div
        className="hy-curva-lienzo"
        onPointerDown={alMover}
        onPointerMove={(e) => e.buttons || e.pointerType === "mouse" ? alMover(e) : undefined}
        onPointerLeave={() => setSel(null)}
        onPointerUp={(e) => e.pointerType !== "mouse" && setSel(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Llegadas acumuladas: de ${puntos[0].total} a las ${puntos[0].hora} hasta ${puntos[puntos.length - 1].total} a las ${puntos[puntos.length - 1].hora}`}>
          <defs>
            <linearGradient id={`a${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3dd16f" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#3dd16f" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#a${id})`} />
          <path d={linea} className="hy-linea" fill="none" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="hy-punto" style={{ left: izq, top: `${(y(p.total) / H) * 100}%` }} data-activo={sel !== null ? "" : undefined} aria-hidden />
      </div>
      <div className="hy-curva-ejes tnum" aria-hidden>
        <span>{puntos[0].hora}</span>
        <span>{puntos[puntos.length - 1].hora}</span>
      </div>
    </div>
  );
}
