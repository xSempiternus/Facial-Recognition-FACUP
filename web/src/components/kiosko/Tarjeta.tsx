"use client";

// Tarjeta de cristal bajo (o junto al) lente: guía mientras se escanea y, al reconocer, el nombre revelado palabra
// por palabra (de desenfoque a nítido) con la categoría y la hora en una sola fila que no se parte mal.

import { AnimatePresence, motion } from "motion/react";
import { useCalidad } from "./calidad";
import { k } from "./tiempo";

export type TextoTarjeta = {
  titulo: string;
  sub?: string;
  detalle?: string | null; // categoría (chip)
  hora?: string | null; // "Llegada 09:41"
  saludo?: string | null; // línea corta sobre el nombre
  grande?: boolean; // el nombre se muestra grande
};

const EASE = [0.22, 1, 0.36, 1] as const;

type Props = {
  texto: TextoTarjeta;
  tono?: "exito" | "aviso" | "error";
  sobrio?: boolean;
  izquierda?: boolean; // alineación a la izquierda (composición horizontal)
  resultado: boolean; // hay un resultado en pantalla (la revelación espera a la foto y la onda de luz)
  insignia?: boolean; // una insignia flota sobre el borde superior: deja espacio arriba
};

function Nombre({ texto, resultado, izquierda }: { texto: string; resultado: boolean; izquierda: boolean }) {
  const alta = useCalidad() !== "bajo";
  const T = k();
  const palabras = texto.split(" ");
  const largo = Math.max(5, Math.max(...palabras.map((p) => p.length)));
  // Tamaño fluido según el ancho de la tarjeta (cqw) y el largo del nombre: "Maximiliano" cabe igual que "Ana".
  const tam = `clamp(2.1rem, min(17cqw, ${(86 / (largo * 0.56)).toFixed(1)}cqw), 5.2rem)`;
  return (
    <h2
      className={`font-bold leading-[1] tracking-[-0.04em] text-texto [text-wrap:balance] ${izquierda ? "text-left" : "text-center"}`}
      style={{ fontSize: tam }}
    >
      {palabras.map((p, i) => (
        <motion.span
          key={p + i}
          className="inline-block pb-[0.06em]"
          initial={{ opacity: 0, y: 14, filter: alta ? "blur(10px)" : "blur(0px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.5 * T, delay: ((resultado ? 0.62 : 0.05) + i * 0.07) * T, ease: EASE }}
        >
          {p}
          {i < palabras.length - 1 ? " " : ""}
        </motion.span>
      ))}
    </h2>
  );
}

export default function Tarjeta({ texto, tono, sobrio = false, izquierda = false, resultado, insignia = false }: Props) {
  const alta = useCalidad() === "alto";
  const T = k();
  const clave = texto.titulo + (texto.sub ?? "") + (texto.hora ?? "");
  const alinea = izquierda ? "items-start text-left" : "items-center text-center";

  return (
    <motion.div
      layout={alta}
      className="cristal w-full [container-type:inline-size]"
      style={{ borderRadius: "var(--vidrio-radio)" }}
      data-tono={tono}
      data-sobrio={sobrio ? "" : undefined}
      transition={{ layout: { type: "spring", stiffness: 260, damping: 30 } }}
    >
      <span key={resultado ? clave : "guia"} className="destello" aria-hidden />
      <div className={`px-[clamp(1.25rem,6cqw,2.5rem)] pb-[clamp(1.1rem,4.5cqw,1.9rem)] ${insignia ? "pt-[clamp(2.1rem,9cqw,2.8rem)]" : "pt-[clamp(1.1rem,4.5cqw,1.9rem)]"}`}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={clave}
            className={`flex flex-col gap-[clamp(0.5rem,2.4cqw,0.8rem)] ${alinea}`}
            initial={alta ? { opacity: 0, y: 8, filter: "blur(4px)" } : { opacity: 0, y: 6 }}
            animate={alta ? { opacity: 1, y: 0, filter: "blur(0px)" } : { opacity: 1, y: 0 }}
            exit={alta ? { opacity: 0, y: -6, filter: "blur(4px)" } : { opacity: 0, y: -4 }}
            transition={{ duration: 0.2 * T, ease: EASE }}
          >
            {texto.grande ? (
              <>
                {texto.saludo && (
                  <motion.p
                    className={`text-[clamp(1rem,4.4cqw,1.3rem)] font-medium leading-none ${sobrio ? "text-texto-2" : "text-[#9be7b4]"}`}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4 * T, delay: 0.5 * T, ease: EASE }}
                  >
                    {texto.saludo}
                  </motion.p>
                )}
                <Nombre texto={texto.titulo} resultado={resultado} izquierda={izquierda} />
                <motion.div
                  className={`flex flex-nowrap gap-x-3 gap-y-2 ${izquierda ? "justify-start" : "justify-center"} items-center`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.45 * T, delay: 0.82 * T, ease: EASE }}
                >
                  {texto.detalle && (
                    <span className="inline-flex min-h-9 items-center whitespace-nowrap rounded-full bg-white/[0.14] px-3.5 text-[clamp(0.95rem,4.2cqw,1.15rem)] font-semibold text-texto shadow-[inset_0_1px_0_rgb(255_255_255/0.28),inset_0_0_0_1px_rgb(255_255_255/0.08)]">
                      {texto.detalle}
                    </span>
                  )}
                  {texto.hora && (
                    <span className="whitespace-nowrap text-[clamp(0.95rem,4.2cqw,1.15rem)] font-medium text-texto-2">{texto.hora}</span>
                  )}
                </motion.div>
              </>
            ) : (
              <>
                <h2 className={`font-semibold leading-tight tracking-[-0.025em] text-texto [text-wrap:balance] text-[clamp(1.4rem,7cqw,2.6rem)]`}>{texto.titulo}</h2>
                {texto.sub && (
                  <p className="max-w-[34ch] [text-wrap:balance] text-[clamp(1rem,4.2cqw,1.35rem)] leading-snug text-texto-2">{texto.sub}</p>
                )}
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
