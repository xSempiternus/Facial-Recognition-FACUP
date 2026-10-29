"use client";

// Fondo aurora: luces suaves en verdes de marca y teal profundo que derivan muy despacio detrás de todo. Es lo que
// el cristal refracta. Solo gradientes radiales y transform (sin blur ni video): barato incluso en teléfonos.

export type ModoAurora = "inicio" | "escaneo" | "exito" | "aviso" | "error";

// Cada mancha: tamaño (vmax), posición (%), color, intensidad, deriva (% de su tamaño) y duración (s).
const MANCHAS = [
  { t: 78, x: -28, y: -12, c: "52 210 124", a: 0.7, dx: "16%", dy: "12%", d: 46 }, // verde luminoso, arriba izquierda
  { t: 60, x: 52, y: 4, c: "149 193 31", a: 0.4, dx: "-14%", dy: "18%", d: 58 }, // lima de marca, arriba derecha
  { t: 80, x: 36, y: 40, c: "0 141 54", a: 0.62, dx: "-18%", dy: "-12%", d: 52 }, // verde de marca, centro derecha
  { t: 74, x: -34, y: 52, c: "16 160 150", a: 0.6, dx: "14%", dy: "-14%", d: 64 }, // teal, abajo izquierda
  { t: 64, x: 14, y: 74, c: "60 215 130", a: 0.55, dx: "12%", dy: "-10%", d: 70 }, // verde claro, abajo
] as const;

export default function Aurora({ modo }: { modo: ModoAurora }) {
  return (
    <div className="aurora" data-modo={modo} aria-hidden>
      {MANCHAS.map((m, i) => (
        <i
          key={i}
          style={
            {
              width: `${m.t}vmax`,
              height: `${m.t}vmax`,
              left: `${m.x}%`,
              top: `${m.y}%`,
              background: `radial-gradient(circle, rgb(${m.c} / 0.95), rgb(${m.c} / 0) 66%)`,
              "--a": m.a,
              "--dx": m.dx,
              "--dy": m.dy,
              "--d": `${m.d}s`,
            } as React.CSSProperties
          }
        />
      ))}
      {/* Manchas de aviso: solo se encienden en ámbar o rojo */}
      <i className="aviso" style={{ width: "90vmax", height: "90vmax", left: "-10%", top: "20%", "--dx": "8%", "--dy": "-8%", "--d": "40s" } as React.CSSProperties} />
      <i className="error" style={{ width: "90vmax", height: "90vmax", left: "-10%", top: "20%", "--dx": "8%", "--dy": "-8%", "--d": "40s" } as React.CSSProperties} />
    </div>
  );
}
