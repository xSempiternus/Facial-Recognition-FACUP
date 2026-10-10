"use client";

// Kiosko de llegada FA CUP Chile, dirección minimal (tipo Face ID): fondo negro, la cámara solo dentro de un
// círculo, un anillo de marcas finas que se enciende en verde y texto limpio debajo. Sin botones: al quedarse
// quieto frente al círculo, la foto se saca sola, la API reconoce al niño y su nombre aparece abajo.

import { AnimatePresence, motion, MotionConfig, useMotionValue } from "motion/react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { hablar } from "@/lib/voz";
import { llegadasDeHoy, verificar, type Verificacion } from "@/lib/api";
import Escaner, { type EstadoEscaner } from "./Escaner";
import Inicio from "./Inicio";
import Mascota, { type EstadoMascota } from "./Mascota";
import { useRastreoCara, type Objetivo, type Postura } from "./useRastreoCara";

const MOSTRAR_RESULTADO_MS = 4200;
const ESPERA_MISMO_NIÑO_MS = 6000; // tras un resultado, no vuelve a escanear a quien sigue frente a la cámara
const INICIO_TRAS_MS = 1500; // sin nadie cerca este tiempo → pantalla de inicio
const EASE = [0.22, 1, 0.36, 1] as const;

type Resultado = {
  tono: "exito" | "aviso" | "error";
  titulo: string;
  sub: string;
  detalle?: string | null; // categoría, en gris
  grande?: boolean; // el nombre se muestra más grande que un mensaje
  mascota: EstadoMascota;
};

const GUIA: Record<Postura, { titulo: string; sub: string }> = {
  "sin-cara": { titulo: "Mira a la cámara", sub: "Tu llegada se registra sola" },
  lejos: { titulo: "Acércate un poco", sub: "Tu cara debe llenar el círculo" },
  cerca: { titulo: "Aléjate un poco", sub: "Estás muy cerca de la cámara" },
  descentrado: { titulo: "Centra tu cara", sub: "Ponla dentro del círculo" },
  quieto: { titulo: "Mantén la posición", sub: "Te estamos reconociendo" },
};

// Círculo de la cámara: centrado y un poco arriba, para dejar espacio al texto.
function calcularObjetivo(ancho: number, alto: number): Objetivo {
  return { cx: ancho / 2, cy: alto * 0.42, r: Math.min(ancho, alto) * 0.25 };
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

function aResultado(v: Verificacion): { resultado: Resultado; frase: string | null } {
  if (v.ok) {
    const nombre = v.nombre.split(" ")[0];
    const hora = v.registradoALas?.slice(11, 16);
    if (v.yaRegistrado) {
      return {
        resultado: {
          tono: "exito", titulo: nombre, grande: true, detalle: v.categoria,
          sub: hora ? `Ya estabas registrado hoy a las ${hora}` : "Ya estabas registrado hoy", mascota: "de_nuevo",
        },
        frase: `¡Hola de nuevo, ${nombre}!`,
      };
    }
    const ahora = new Date().toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false });
    return {
      resultado: { tono: "exito", titulo: nombre, grande: true, detalle: v.categoria, sub: `Llegada registrada a las ${ahora}`, mascota: "celebra" },
      frase: `¡Hola, ${nombre}! ¡A jugar!`,
    };
  }
  switch (v.codigo) {
    case "sin_rostro":
      return { resultado: { tono: "aviso", titulo: "No detectamos tu cara", sub: "Mira de frente a la cámara, con buena luz", mascota: "no_veo" }, frase: "No detectamos tu cara. Prueba otra vez." };
    case "foto_falsa":
      return { resultado: { tono: "aviso", titulo: "Usa tu cara, no una foto", sub: "Ponte tú frente a la cámara", mascota: "foto_falsa" }, frase: "Usa tu cara, no una foto." };
    case "no_reconocido":
      return { resultado: { tono: "aviso", titulo: "No te reconocimos", sub: "Intenta de nuevo o avisa a tu entrenador", mascota: "no_reconoce" }, frase: "No te reconocimos. Intenta de nuevo o avisa a tu entrenador." };
    case "sin_jugadores":
      return { resultado: { tono: "error", titulo: "Aún no hay jugadores inscritos", sub: "El staff debe inscribirlos primero", mascota: "error" }, frase: null };
    default:
      return { resultado: { tono: "error", titulo: "Sistema no disponible", sub: "Avisa al staff", mascota: "error" }, frase: null };
  }
}

export default function Kiosko() {
  const video = useRef<HTMLVideoElement>(null);
  const progreso = useMotionValue(0);

  const { ancho, alto } = useTamañoPantalla();
  const circulo = useMemo(() => calcularObjetivo(ancho, alto), [ancho, alto]);
  const objetivo = useRef<Objetivo>(circulo); // el bucle de rastreo lo lee cada cuadro
  useEffect(() => {
    objetivo.current = circulo;
  }, [circulo]);

  const [errorCamara, setErrorCamara] = useState<string | null>(null);
  const [fase, setFase] = useState<"escaneando" | "enviando" | "resultado">("escaneando");
  const [resultado, setResultado] = useState<Resultado | null>(null);
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
      setErrorCamara(e instanceof DOMException ? "Permite el acceso a la cámara para registrar llegadas." : String(e.message ?? e)),
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
    const { resultado, frase } = aResultado(v);
    if (v.ok && !v.yaRegistrado) setHoy((n) => (n === null ? n : n + 1));
    setResultado(resultado);
    setFase("resultado");
    if (frase && voz.current) hablar(frase);
  }, []);

  // Dónde está la cara de quien mira (la foto 3D de inicio la sigue).
  const caraX = useMotionValue(0);
  const caraY = useMotionValue(0);
  const caraPresente = useMotionValue(0);
  const seguimiento = useMemo(() => ({ x: caraX, y: caraY, presente: caraPresente }), [caraX, caraY, caraPresente]);

  const { listo, error: errorModelo, postura } = useRastreoCara({
    video,
    objetivo,
    progreso,
    activo: fase === "escaneando" && !esperarSalida,
    onCaptura: alCapturar,
    seguimiento,
  });

  // Fin del resultado: vuelve a escanear, pero espera a que el niño se vaya (o pasen unos segundos).
  const terminarResultado = useCallback(() => {
    setResultado(null);
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

  // Pantalla de inicio: cuando no hay nadie cerca por un momento (sin parpadeos si alguien pasa rápido).
  const lejos = postura === "sin-cara" || postura === "lejos";
  const [inicioArmado, setInicioArmado] = useState(true);
  useEffect(() => {
    const id = setTimeout(() => setInicioArmado(lejos), lejos ? INICIO_TRAS_MS : 0);
    return () => clearTimeout(id);
  }, [lejos]);

  const sinCamara = Boolean(errorCamara || errorModelo);
  const mostrarInicio = !sinCamara && fase === "escaneando" && !esperarSalida && (!listo || (lejos && inicioArmado));

  // Qué dice la pantalla y de qué color va el anillo.
  let texto: { titulo: string; sub: string; detalle?: string | null; grande?: boolean };
  let estado: EstadoEscaner;
  if (sinCamara) {
    texto = { titulo: "Cámara no disponible", sub: errorCamara ?? "No se pudo iniciar el reconocimiento. Avisa al staff." };
    estado = "error";
  } else if (fase === "resultado" && resultado) {
    texto = resultado;
    estado = resultado.tono;
  } else if (fase === "enviando") {
    texto = { titulo: "Verificando…", sub: "Un momento" };
    estado = "verificando";
  } else if (esperarSalida && postura !== "sin-cara") {
    texto = { titulo: "Listo", sub: "Puede pasar el siguiente" };
    estado = "espera";
  } else {
    texto = GUIA[postura];
    estado = postura === "quieto" ? "quieto" : postura === "sin-cara" ? "espera" : "ajustando";
  }
  const textoInicio = !listo
    ? { titulo: "Preparando", sub: "Un momento" }
    : postura !== "sin-cara" // hay alguien: se mantiene mientras la foto se abre hacia la cámara
      ? { titulo: "Acércate a la pantalla", sub: "Tu llegada se registra sola" }
      : { titulo: "Bienvenido", sub: "Acércate a la pantalla para registrar tu llegada" };

  const { cx, cy, r } = circulo;
  const resultadoVisible = fase === "resultado";

  return (
    <MotionConfig reducedMotion="user">
      <main
        className="relative h-dvh w-screen overflow-hidden bg-fondo"
        onClick={() => resultadoVisible && prueba.current && terminarResultado()}
      >
        {/* Cámara: solo dentro del círculo, en espejo. Se oscurece al mostrar un resultado. */}
        <motion.video
          ref={video}
          muted
          playsInline
          className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
          style={{
            WebkitMaskImage: `radial-gradient(circle ${r}px at ${cx}px ${cy}px, #000 99.5%, transparent 100%)`,
            maskImage: `radial-gradient(circle ${r}px at ${cx}px ${cy}px, #000 99.5%, transparent 100%)`,
          }}
          animate={{ filter: resultadoVisible ? "brightness(0.32) saturate(0.6) blur(6px)" : "brightness(1) saturate(0.95) blur(0px)" }}
          transition={{ duration: 0.5, ease: EASE }}
        />

        <Escaner objetivo={circulo} progreso={progreso} estado={estado} />

        {/* Inicio: fotos 3D de FA CUP mientras no hay nadie cerca */}
        <AnimatePresence>
          {mostrarInicio && <Inicio key="inicio" seguimiento={seguimiento} titulo={textoInicio.titulo} sub={textoInicio.sub} />}
        </AnimatePresence>

        {/* Barra superior: logo y llegadas del día, discretos */}
        <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-[4vw] pt-[4vh]">
          <Image src="/logo-blanco.png" alt="FA CUP Chile" width={235} height={50} priority className="h-[clamp(26px,3.6vh,36px)] w-auto opacity-90" />
          {hoy !== null && (
            <p className="text-[clamp(0.95rem,1.25vw,1.15rem)] text-texto-2">
              <motion.span
                key={hoy}
                className="tabular mr-1.5 font-medium text-texto"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: EASE }}
              >
                {hoy}
              </motion.span>
              {hoy === 1 ? "llegada hoy" : "llegadas hoy"}
            </p>
          )}
        </header>

        {/* Texto bajo el círculo */}
        {!mostrarInicio && (
          <div
            className="absolute inset-x-0 z-20 flex flex-col items-center px-6 text-center"
            style={{ top: cy + r + 56 }}
          >
            <AnimatePresence mode="wait">
              <motion.div
                key={texto.titulo + texto.sub}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.3, ease: EASE }}
              >
                <h1
                  className={`font-semibold tracking-[-0.02em] text-texto ${
                    texto.grande ? "text-[clamp(3rem,5.4vw,4.8rem)] leading-none" : "text-[clamp(1.9rem,3vw,2.6rem)] leading-tight"
                  }`}
                >
                  {texto.titulo}
                </h1>
                <p className="mt-2.5 text-[clamp(1.05rem,1.5vw,1.35rem)] text-texto-2">
                  {texto.detalle && <span className="text-texto-3">{texto.detalle}&nbsp;&nbsp;</span>}
                  {texto.sub}
                </p>
              </motion.div>
            </AnimatePresence>
          </div>
        )}

        {/* Mascota (aparece cuando existan sus imágenes en public/mascota/) */}
        {!mostrarInicio && (
          <div className="absolute bottom-[5vh] left-[4vw] z-20">
            <Mascota
              estado={resultado?.mascota ?? (fase === "enviando" ? "buscando" : "bienvenida")}
              tamaño={Math.round(alto * 0.24)}
            />
          </div>
        )}
      </main>
    </MotionConfig>
  );
}
