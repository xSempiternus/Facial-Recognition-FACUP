"use client";

// Kiosko de llegada FA CUP Chile, "cristal sobre la cancha": detrás, fotos 3D de FA CUP siempre en movimiento;
// delante, la cámara dentro de un lente con bisel de cristal y el texto en una hoja de cristal. Sin botones: al
// quedarse quieto frente al lente, la foto se saca sola, la API reconoce al niño y su nombre aparece abajo.
// Funciona en tablet y teléfono, en vertical u horizontal.

import { AnimatePresence, motion, MotionConfig, useMotionValue } from "motion/react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { hablar } from "@/lib/voz";
import { llegadasDeHoy, verificar, type Verificacion } from "@/lib/api";
import type { EstadoEscaner } from "./Escaner";
import FondoVivo from "./FondoVivo";
import Inicio from "./Inicio";
import Lente from "./Lente";
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

// Saludos de jugador: uno por llegada, para que no suene siempre igual.
const ANIMOS = ["¡A la cancha!", "¡Hoy se juega!", "¡A jugar!", "¡Con todo hoy!", "¡Vamos equipo!"];
const animo = () => ANIMOS[Math.floor(Math.random() * ANIMOS.length)];

const GUIA: Record<Postura, { titulo: string; sub: string }> = {
  "sin-cara": { titulo: "Mira a la cámara", sub: "Tu llegada se registra sola" },
  lejos: { titulo: "Acércate un poco", sub: "Tu cara debe llenar el círculo" },
  cerca: { titulo: "Aléjate un poco", sub: "Estás muy cerca de la cámara" },
  descentrado: { titulo: "Centra tu cara", sub: "Ponla dentro del círculo" },
  quieto: { titulo: "Mantén la posición", sub: "Te estamos reconociendo" },
};

function mensajeErrorCamara(e: unknown) {
  if (e instanceof DOMException) {
    switch (e.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Permite el acceso a la cámara en el navegador y toca la pantalla para reintentar.";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "No encontramos una cámara disponible en este equipo.";
      case "NotReadableError":
      case "TrackStartError":
        return "No pudimos abrir la cámara. Cierra otras apps que la estén usando y vuelve a intentar.";
      default:
        return "No se pudo iniciar la cámara. Toca la pantalla para reintentar.";
    }
  }
  return e instanceof Error ? e.message : "No se pudo iniciar la cámara. Toca la pantalla para reintentar.";
}

// Círculo de la cámara: centrado y arriba, para dejar espacio a la hoja de texto. En vertical (teléfono, tablet
// parada) usa el ancho; en horizontal, el alto.
function calcularObjetivo(ancho: number, alto: number): Objetivo {
  const vertical = alto > ancho;
  const r = vertical ? Math.min(ancho * 0.34, alto * 0.21) : alto * 0.23;
  return { cx: ancho / 2, cy: alto * (vertical ? 0.42 : 0.38), r };
}

// Ancho del bisel de cristal alrededor de la cámara.
const anchoBisel = (r: number) => Math.min(52, Math.max(28, r * 0.2));

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
      resultado: { tono: "exito", titulo: nombre, grande: true, detalle: v.categoria, sub: `${animo()} Llegada a las ${ahora}`, mascota: "celebra" },
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
  const [intentoCamara, setIntentoCamara] = useState(0);
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
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Este navegador no tiene acceso a la cámara.");
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (cancelado) return s.getTracks().forEach((t) => t.stop());
      stream = s;
      setErrorCamara(null);
      if (video.current) {
        video.current.srcObject = s;
        video.current.play().catch(() => {});
      }
    })().catch((e) => setErrorCamara(mensajeErrorCamara(e)));
    return () => {
      cancelado = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [intentoCamara]);

  useEffect(() => {
    if (!errorCamara) return;
    let reintentado = false;
    const reintentar = () => {
      if (reintentado) return;
      reintentado = true;
      setErrorCamara(null);
      setIntentoCamara((n) => n + 1);
    };
    window.addEventListener("pointerdown", reintentar, { once: true });
    window.addEventListener("keydown", reintentar, { once: true });
    return () => {
      window.removeEventListener("pointerdown", reintentar);
      window.removeEventListener("keydown", reintentar);
    };
  }, [errorCamara]);

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

  const resultadoVisible = fase === "resultado";
  const exito = resultadoVisible && resultado?.tono === "exito";

  const { cx, cy, r } = circulo;
  const banda = anchoBisel(r);

  return (
    <MotionConfig reducedMotion="user">
      <main
        className="relative h-dvh w-screen overflow-hidden bg-fondo"
        onClick={() => resultadoVisible && prueba.current && terminarResultado()}
      >
        {/* Fondo vivo: fotos 3D de FA CUP, nítidas en el inicio y desenfocadas tras el cristal al escanear */}
        <FondoVivo seguimiento={seguimiento} modo={mostrarInicio ? "inicio" : exito ? "exito" : resultadoVisible ? "resultado" : "escaneo"} />

        {/* Lente: cámara + bisel de cristal + marcas. Al salir del inicio se acerca desde atrás. */}
        <motion.div
          className="absolute inset-0"
          style={{ transformOrigin: `${cx}px ${cy}px` }}
          initial={false}
          animate={mostrarInicio ? { opacity: 0, scale: 0.86 } : { opacity: 1, scale: 1 }}
          transition={mostrarInicio ? { duration: 0.5, ease: EASE } : { type: "spring", stiffness: 140, damping: 22 }}
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
            animate={{
              filter: exito
                ? "brightness(0.9) saturate(1) blur(0px)"
                : resultadoVisible
                  ? "brightness(0.32) saturate(0.6) blur(6px)"
                  : "brightness(1) saturate(0.95) blur(0px)",
            }}
            transition={{ duration: 0.5, ease: EASE }}
          />
          <Lente objetivo={circulo} banda={banda} progreso={progreso} estado={estado} />
        </motion.div>

        {/* Inicio: saludo sobre el fondo vivo mientras no hay nadie cerca */}
        <AnimatePresence>
          {mostrarInicio && <Inicio key="inicio" titulo={textoInicio.titulo} sub={textoInicio.sub} />}
        </AnimatePresence>

        {/* Barra superior: logo y llegadas del día, discretos */}
        <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-[4vw] pt-[4vh]">
          <Image src="/logo-blanco.png" alt="FA CUP Chile" width={235} height={50} priority className="h-[clamp(32px,4.6vh,46px)] w-auto" />
          {hoy !== null && (
            <p className="flex items-baseline gap-2 text-[clamp(0.9rem,1.3vw,1.1rem)] text-texto/80">
              <motion.span
                key={hoy}
                className="tabular text-[clamp(1.6rem,3vw,2.4rem)] font-semibold leading-none tracking-[-0.03em] text-verde-pantalla"
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

        {/* Hoja de cristal bajo el lente: guía, y al reconocer, el nombre en grande */}
        <AnimatePresence>
          {!mostrarInicio && (
            <motion.div
              key="hoja"
              className="absolute inset-x-0 z-20 flex justify-center px-4"
              style={{ top: cy + r + banda + Math.max(20, alto * 0.035) }}
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 16, transition: { duration: 0.3 } }}
              transition={{ type: "spring", stiffness: 160, damping: 24 }}
            >
              <motion.div
                layout
                className="cristal w-full max-w-[640px] overflow-hidden rounded-[22px] px-7 py-5 text-center sm:px-10 sm:py-6"
                style={{
                  borderColor: exito ? "rgba(31,179,90,.55)" : undefined,
                  boxShadow: exito ? "inset 0 1px 0 rgb(255 255 255 / .28), 0 0 80px rgba(31,179,90,.28), 0 24px 70px rgb(0 0 0 / .4)" : undefined,
                }}
                transition={{ layout: { type: "spring", stiffness: 260, damping: 30 } }}
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={texto.titulo + texto.sub}
                    initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
                    transition={{ duration: 0.28, ease: EASE }}
                  >
                    <h1
                      className={`font-semibold tracking-[-0.025em] text-texto ${
                        texto.grande ? "text-[clamp(3rem,10vw,5.6rem)] font-bold leading-[0.98] tracking-[-0.04em]" : "text-[clamp(1.55rem,3.6vw,2.3rem)] leading-tight"
                      }`}
                    >
                      {texto.titulo}
                    </h1>
                    <p className="mt-2 text-[clamp(1rem,2vw,1.25rem)] leading-snug text-texto-2">
                      {texto.detalle && <span className="font-medium text-verde-pantalla">{texto.detalle}&nbsp;&nbsp;</span>}
                      {texto.sub}
                    </p>
                  </motion.div>
                </AnimatePresence>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Mascota (aparece cuando existan sus imágenes en public/mascota/) */}
        {!mostrarInicio && (
          <div className="absolute bottom-[5vh] left-[4vw] z-20">
            <Mascota
              estado={resultado?.mascota ?? (fase === "enviando" ? "buscando" : "bienvenida")}
              tamaño={Math.round(Math.min(alto * 0.22, ancho * 0.3))}
            />
          </div>
        )}
      </main>
    </MotionConfig>
  );
}
