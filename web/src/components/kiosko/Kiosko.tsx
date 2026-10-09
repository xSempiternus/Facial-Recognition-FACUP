"use client";

// Kiosko de llegada FA CUP Chile: la pantalla es el marcador del estadio. La cámara ocupa todo, encima van las
// líneas de cal y el círculo central es donde va la cara. Sin botones: al quedarse quieto en el círculo, la
// foto se saca sola, la API reconoce al niño y su nombre aparece en grande.

import { AnimatePresence, motion, MotionConfig, useMotionValue } from "motion/react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { hablar } from "@/lib/voz";
import { llegadasDeHoy, verificar, type Verificacion } from "@/lib/api";
import Cancha from "./Cancha";
import Mascota from "./Mascota";
import Resultado, { type Llegada } from "./Resultado";
import { useRastreoCara, type Objetivo, type Postura } from "./useRastreoCara";

const MOSTRAR_RESULTADO_MS = 4200;
const ESPERA_MISMO_NIÑO_MS = 6000; // tras un resultado, no vuelve a escanear a quien sigue frente a la cámara

const GUIA: Record<Postura, { titulo: string; sub: string }> = {
  "sin-cara": { titulo: "Entra a la cancha", sub: "Ponte frente a la pantalla para marcar tu llegada" },
  lejos: { titulo: "Acércate un poco", sub: "Tu cara tiene que llenar el círculo" },
  cerca: { titulo: "Un pasito atrás", sub: "Estás muy cerca de la cámara" },
  descentrado: { titulo: "Al centro de la cancha", sub: "Pon tu cara dentro del círculo" },
  quieto: { titulo: "¡Quieto ahí!", sub: "Te estamos reconociendo" },
};

// Círculo central: ahí va la cara (un poco sobre la mitad, para dejar espacio a la guía de abajo).
function calcularObjetivo(ancho: number, alto: number): Objetivo {
  return { cx: ancho / 2, cy: alto * 0.47, r: Math.min(ancho, alto) * 0.24 };
}

// Tamaño de la ventana como estado externo (se actualiza al redimensionar).
const suscribirResize = (avisar: () => void) => {
  window.addEventListener("resize", avisar);
  return () => window.removeEventListener("resize", avisar);
};
const tamañoActual = () => `${window.innerWidth}x${window.innerHeight}`;
const tamañoServidor = () => "1366x768";

function useTamañoPantalla() {
  const [ancho, alto] = useSyncExternalStore(suscribirResize, tamañoActual, tamañoServidor).split("x").map(Number);
  return { ancho, alto };
}

function aLlegada(v: Verificacion): { llegada: Llegada; frase: string | null } {
  if (v.ok) {
    const nombre = v.nombre.split(" ")[0];
    if (v.yaRegistrado) {
      const hora = v.registradoALas?.slice(11, 16);
      return {
        llegada: { tipo: "de-nuevo", nombre, categoria: v.categoria, sub: hora ? `Ya estabas anotado a las ${hora}.` : "Ya estabas anotado hoy.", mascota: "de_nuevo" },
        frase: `¡Hola de nuevo, ${nombre}! Ya estabas anotado.`,
      };
    }
    return {
      llegada: { tipo: "gol", nombre, categoria: v.categoria, sub: "Tu llegada quedó registrada. ¡A jugar!", mascota: "celebra" },
      frase: `¡Hola, ${nombre}! ¡A jugar!`,
    };
  }
  switch (v.codigo) {
    case "sin_rostro":
      return { llegada: { tipo: "amarilla", titulo: "No vimos tu cara", sub: "Mira la cámara y prueba otra vez.", mascota: "no_veo" }, frase: "No vimos tu cara. Prueba otra vez." };
    case "foto_falsa":
      return { llegada: { tipo: "amarilla", titulo: "Usa tu cara, no una foto", sub: "Ponte tú frente a la cámara.", mascota: "foto_falsa" }, frase: "Usa tu cara, no una foto." };
    case "no_reconocido":
      return { llegada: { tipo: "amarilla", titulo: "No te reconocimos", sub: "Prueba otra vez o busca a tu entrenador.", mascota: "no_reconoce" }, frase: "No te reconocimos. Prueba otra vez o busca a tu entrenador." };
    case "sin_jugadores":
      return { llegada: { tipo: "roja", titulo: "Aún no hay jugadores", sub: "El staff tiene que inscribirlos primero.", mascota: "error" }, frase: null };
    default:
      return { llegada: { tipo: "roja", titulo: "Sistema sin conexión", sub: "Avísale a tu entrenador.", mascota: "error" }, frase: null };
  }
}

export default function Kiosko() {
  const video = useRef<HTMLVideoElement>(null);
  const lienzo = useRef<HTMLCanvasElement>(null);
  const progreso = useMotionValue(0);

  const { ancho, alto } = useTamañoPantalla();
  const circulo = useMemo(() => calcularObjetivo(ancho, alto), [ancho, alto]);
  const objetivo = useRef<Objetivo>(circulo); // el bucle de rastreo lo lee cada cuadro
  useEffect(() => {
    objetivo.current = circulo;
  }, [circulo]);
  const [errorCamara, setErrorCamara] = useState<string | null>(null);
  const [fase, setFase] = useState<"escaneando" | "enviando" | "resultado">("escaneando");
  const [llegada, setLlegada] = useState<Llegada | null>(null);
  const [hoy, setHoy] = useState<number | null>(null);
  const [esperarSalida, setEsperarSalida] = useState(false);
  const voz = useRef(true);
  const prueba = useRef(false);

  // ?voz=0 apaga el saludo hablado. ?prueba=1 deja el resultado en pantalla hasta tocarla (para el staff).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    voz.current = q.get("voz") !== "0";
    prueba.current = q.get("prueba") === "1";
  }, []);

  // Cámara.
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelado = false;
    (async () => {
      if (!navigator.mediaDevices) throw new Error("Este navegador no tiene acceso a la cámara.");
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (cancelado) return s.getTracks().forEach((t) => t.stop());
      stream = s;
      if (video.current) {
        video.current.srcObject = s;
        video.current.play().catch(() => {});
      }
    })().catch((e) =>
      setErrorCamara(e instanceof DOMException ? "Permite el acceso a la cámara para marcar asistencia." : String(e.message ?? e)),
    );
    return () => {
      cancelado = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Contador de llegadas de hoy.
  useEffect(() => {
    const cargar = () => llegadasDeHoy().then(setHoy);
    cargar();
    const id = setInterval(cargar, 30_000);
    return () => clearInterval(id);
  }, []);

  const alCapturar = useCallback(async (foto: Blob) => {
    setFase("enviando");
    const v = await verificar(foto);
    const { llegada, frase } = aLlegada(v);
    if (v.ok && !v.yaRegistrado) setHoy((n) => (n === null ? n : n + 1));
    setLlegada(llegada);
    setFase("resultado");
    if (frase && voz.current) hablar(frase);
  }, []);

  const { listo, error: errorModelo, postura } = useRastreoCara({
    video,
    lienzo,
    objetivo,
    progreso,
    activo: fase === "escaneando" && !esperarSalida,
    onCaptura: alCapturar,
  });

  // Fin del resultado: vuelve a la cancha, pero espera a que el niño se vaya (o pasen unos segundos).
  const terminarResultado = useCallback(() => {
    setLlegada(null);
    setFase("escaneando");
    setEsperarSalida(true);
  }, []);
  useEffect(() => {
    if (fase !== "resultado" || prueba.current) return;
    const id = setTimeout(terminarResultado, MOSTRAR_RESULTADO_MS);
    return () => clearTimeout(id);
  }, [fase, terminarResultado]);
  useEffect(() => {
    if (!esperarSalida) return;
    const id = setTimeout(() => setEsperarSalida(false), postura === "sin-cara" ? 0 : ESPERA_MISMO_NIÑO_MS);
    return () => clearTimeout(id);
  }, [esperarSalida, postura]);

  const guia =
    errorCamara || errorModelo
      ? { titulo: "Cámara no disponible", sub: errorCamara ?? "No se pudo iniciar el reconocimiento. Avísale a tu entrenador." }
      : !listo
        ? { titulo: "Preparando la cancha", sub: "Un segundo…" }
        : fase === "enviando"
          ? { titulo: "Revisando la jugada…", sub: "Buscándote en el plantel" }
          : esperarSalida && postura !== "sin-cara"
            ? { titulo: "¡Listo!", sub: "Deja pasar al siguiente" }
            : GUIA[postura];

  return (
    <MotionConfig reducedMotion="user">
      <main className="relative h-dvh w-screen overflow-hidden bg-noche">
        {/* Cámara a pantalla completa, en espejo, con tono de cancha nocturna */}
        <video
          ref={video}
          muted
          playsInline
          className="absolute inset-0 h-full w-full -scale-x-100 object-cover saturate-[.85] contrast-[1.05]"
        />
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 60% 70% at 50% 47%, rgba(3,20,10,0) 0%, rgba(3,20,10,.55) 60%, rgba(3,20,10,.92) 100%)," +
              "linear-gradient(180deg, rgba(3,20,10,.75) 0%, rgba(3,20,10,0) 22%, rgba(3,20,10,0) 70%, rgba(3,20,10,.9) 100%)",
          }}
        />
        {/* Luz de estadio que barre lento la parte alta (único movimiento ambiental) */}
        <motion.div
          className="pointer-events-none absolute -top-1/3 h-[70%] w-[45%] rounded-full bg-lima/10 blur-3xl"
          animate={{ left: ["-10%", "65%", "-10%"] }}
          transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
        />

        <canvas ref={lienzo} className="pointer-events-none absolute inset-0 h-full w-full" />
        <Cancha ancho={ancho} alto={alto} objetivo={circulo} progreso={progreso} postura={postura} />

        {/* Marcador superior */}
        <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-[5vw] pt-[3.2vh]">
          <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.2 }}>
            <Image src="/logo-blanco.png" alt="FA CUP Chile" width={235} height={50} priority className="h-[clamp(34px,5vh,50px)] w-auto" />
          </motion.div>
          <motion.div
            className="flex items-center gap-4 rounded-full border border-cal/15 bg-noche/50 py-2 pl-4 pr-5 backdrop-blur-md"
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}
          >
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-lima/70" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-lima" />
            </span>
            <span className="text-lg text-cal/70">En vivo</span>
            {hoy !== null && (
              <span className="flex items-baseline gap-2">
                <motion.b
                  key={hoy}
                  className="tabular font-display text-2xl text-white"
                  initial={{ y: -14, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 300, damping: 20 }}
                >
                  {hoy}
                </motion.b>
                <span className="text-lg text-cal/70">{hoy === 1 ? "llegada hoy" : "llegadas hoy"}</span>
              </span>
            )}
          </motion.div>
        </header>

        {/* Guía: cambia con un fundido desenfocado, sin saltos */}
        <div className="absolute inset-x-0 bottom-[6vh] z-20 flex flex-col items-center px-6 text-center">
          <AnimatePresence mode="wait">
            <motion.div
              key={guia.titulo}
              initial={{ opacity: 0, y: 18, filter: "blur(10px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -12, filter: "blur(10px)" }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            >
              <h1 className="font-display text-[clamp(2.6rem,5.2vw,4.6rem)] font-bold leading-none text-white drop-shadow-[0_6px_24px_rgba(0,0,0,.5)]">
                {guia.titulo}
              </h1>
              <p className="mt-3 text-[clamp(1.1rem,1.8vw,1.6rem)] text-cal/70">{guia.sub}</p>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Mascota de bienvenida (aparece cuando existan sus imágenes) */}
        <div className="absolute bottom-[4vh] left-[5vw] z-20">
          <Mascota estado={fase === "enviando" ? "buscando" : "bienvenida"} tamaño={Math.round(alto * 0.26)} />
        </div>

        <AnimatePresence>
          {llegada && (
            <div key="resultado" onClick={() => fase === "resultado" && terminarResultado()}>
              <Resultado llegada={llegada} objetivo={circulo} />
            </div>
          )}
        </AnimatePresence>
      </main>
    </MotionConfig>
  );
}
