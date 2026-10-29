"use client";

// Chispas de luz verde que se dispersan desde el borde del lente al reconocer. Elementos livianos animados con CSS
// (transform y opacity, sin JS por cuadro). Posiciones deterministas (ángulo áureo): sin azar en el render.

import type { CSSProperties } from "react";
import type { Objetivo } from "./useRastreoCara";

const ANGULO_AUREO = 2.399963; // rad

export default function Chispas({ objetivo, cantidad }: { objetivo: Objetivo; cantidad: number }) {
  const { cx, cy, r } = objetivo;
  return (
    <>
      {Array.from({ length: Math.min(cantidad, 24) }, (_, i) => {
        const a = i * ANGULO_AUREO - Math.PI / 2;
        const lado = 3 + ((i * 7) % 4) * 1.4; // 3 a 7 px
        const sale = r * (1.02 + ((i * 5) % 3) * 0.05);
        const alcance = r * (0.22 + ((i * 11) % 7) * 0.06); // cuánto se aleja
        return (
          <span
            key={i}
            className="chispa"
            style={
              {
                left: cx + Math.cos(a) * sale - lado / 2,
                top: cy + Math.sin(a) * sale - lado / 2,
                width: lado,
                height: lado,
                "--dx": `${(Math.cos(a) * alcance).toFixed(1)}px`,
                "--dy": `${(Math.sin(a) * alcance).toFixed(1)}px`,
                "--retardo": `${(0.12 + (i % 8) * 0.045).toFixed(3)}s`,
              } as CSSProperties
            }
          />
        );
      })}
    </>
  );
}
