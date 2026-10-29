"use client";

// Kiosko de llegada FA CUP Chile, "liquid glass": detrás, una aurora de luz verde (y las fotos 3D de FA CUP en el
// inicio); delante, la cámara dentro de un lente con bisel de cristal y el texto en una tarjeta de cristal. Sin
// botones: al quedarse quieto frente al lente, la foto se saca sola, la API reconoce al niño, su foto queda nítida
// en el círculo y su nombre aparece en la tarjeta. Móvil vertical primero; también tablet y escritorio.

import { AnimatePresence, motion, MotionConfig, useMotionValue } from "motion/react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { desbloquearVoz, hablar } from "@/lib/voz";
import { llegadasDeHoy, precalentar, verificar, type Verificacion } from "@/lib/api";
import { calidadActual, iniciarCalidad, restriccionesCamara } from "./calidad";
import type { EstadoEscaner } from "./Escaner";
import Aurora, { type ModoAurora } from "./Aurora";
import FondoVivo from "./FondoVivo";
import Inicio from "./Inicio";
import Lente from "./Lente";
import Mascota, { type EstadoMascota } from "./Mascota";
import Rodillo from "./Rodillo";
import Tarjeta, { type TextoTarjeta } from "./Tarjeta";
import { k } from "./tiempo";
import { useRastreoCara, type Objetivo, type Postura } from "./useRastreoCara";

const MOSTRAR_RESULTADO_MS = 4200;
const ESPERA_MISMO_NIÑO_MS = 6000; // tras un resultado, no vuelve a escanear a quien sigue frente a la cámara
const INICIO_TRAS_MS = 1500; // sin nadie cerca este tiempo → pantalla de inicio
const EASE = [0.22, 1, 0.36, 1] as const;

type Resultado = TextoTarjeta & {
  tono: "exito" | "aviso" | "error";
  sobrio?: boolean; // "ya registrado"
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

// Composición según la pantalla. Vertical (teléfono, tablet parada): círculo grande arriba y tarjeta debajo.
// Horizontal (tablet acostada, escritorio): círculo a la izquierda y tarjeta a su lado. `E` es el radio exterior
// del lente (cámara + bisel de cristal).
type Composicion = Objetivo & { banda: number; E: number; lado: boolean; tarjetaX: number; tarjetaY: number; tarjetaW: number };

const limitar = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function componer(ancho: number, alto: number): Composicion {
  const lado = ancho / alto > 1.25;
  if (lado) {
    const E = Math.min(alto * 0.36, ancho * 0.28);
    const banda = limitar(E * 0.14, 22, 44);
    const cx = Math.max(E + ancho * 0.05, ancho * 0.3);
    const cy = alto * 0.54;
    const tarjetaX = cx + E + ancho * 0.045;
    return { cx, cy, r: E - banda, banda, E, lado, tarjetaX, tarjetaY: 0, tarjetaW: Math.min(620, ancho - tarjetaX - ancho * 0.05) };
  }
  const E = Math.min(ancho * 0.455, alto * 0.28);
  const banda = limitar(E * 0.15, 22, 44);
  const hueco = Math.max(18, alto * 0.028);
  // El conjunto (lente + tarjeta, ~210 px) se centra bajo la barra superior, un poco por encima del centro óptico.
  const libre = alto - 76 - (2 * E + hueco + 210);
  const cy = 76 + Math.max(0, libre * 0.42) + E;
  const tarjetaW = Math.min(560, ancho - 32);
  return { cx: ancho / 2, cy, r: E - banda, banda, E, lado, tarjetaX: (ancho - tarjetaW) / 2, tarjetaY: cy + E + hueco, tarjetaW };
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
    const horaReg = v.registradoALas?.slice(11, 16);
    if (v.yaRegistrado) {
      return {
        resultado: {
          tono: "exito", sobrio: true, titulo: nombre, grande: true, detalle: v.categoria, saludo: "Ya estabas registrado",
          hora: horaReg ? `Hoy a las ${horaReg}` : "Hoy", mascota: "de_nuevo",
        },
        frase: `¡Hola de nuevo, ${nombre}!`,
      };
    }
    const ahora = new Date().toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false });
    return {
      resultado: { tono: "exito", titulo: nombre, grande: true, detalle: v.categoria, saludo: animo(), hora: `Llegada ${ahora}`, mascota: "celebra" },
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

// Vista previa de estados para diseño/QA: ?demo=reconocido|ya|noreconoce|sinrostro|error|escaneando.
// Solo existe fuera de producción; en producción el parámetro se ignora.
const suscribirNada = () => () => {};
const demoActual = () => (process.env.NODE_ENV === "production" ? "" : new URLSearchParams(window.location.search).get("demo") ?? "");
function useDemo() {
  return useSyncExternalStore(suscribirNada, demoActual, () => "");
}
const DEMO_VERIFICACION: Record<string, Verificacion> = {
  reconocido: { ok: true, nombre: "Matías Soto", categoria: "Sub-10", yaRegistrado: false, registradoALas: null, similitud: 0.9 },
  ya: { ok: true, nombre: "Matías Soto", categoria: "Sub-10", yaRegistrado: true, registradoALas: "2026-10-28T09:12:00", similitud: 0.9 },
  noreconoce: { ok: false, codigo: "no_reconocido", mensaje: "" },
  sinrostro: { ok: false, codigo: "sin_rostro", mensaje: "" },
  error: { ok: false, codigo: "error_servidor", mensaje: "" },
};

export default function Kiosko() {
  const demo = useDemo();
  const video = useRef<HTMLVideoElement>(null);
  const progreso = useMotionValue(0);

  const { ancho, alto } = useTamañoPantalla();
  const comp = useMemo(() => componer(ancho, alto), [ancho, alto]);
  const circulo = useMemo<Objetivo>(() => ({ cx: comp.cx, cy: comp.cy, r: comp.r }), [comp]);
  const objetivo = useRef<Objetivo>(circulo); // el bucle de rastreo lo lee cada cuadro
  useEffect(() => {
    objetivo.current = circulo;
  }, [circulo]);

  const [errorCamara, setErrorCamara] = useState<string | null>(null);
  const [intento, setIntento] = useState(0);
  const [faseReal, setFase] = useState<"escaneando" | "enviando" | "resultado">("escaneando");
  const [resultadoReal, setResultado] = useState<Resultado | null>(null);
  const [hoy, setHoy] = useState<number | null>(null);
  const [esperarSalida, setEsperarSalida] = useState(false);
  const [fotoUrl, setFotoUrl] = useState<string | null>(null); // foto capturada, para mostrarla nítida en el círculo
  const [repetir, setRepetir] = useState(0); // solo demo: tocar la pantalla repite la secuencia
  const voz = useRef(true);
  const prueba = useRef(false);

  // ?voz=0 apaga el saludo hablado. ?prueba=1 deja el resultado en pantalla hasta tocarla (para el staff).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    voz.current = q.get("voz") !== "0";
    prueba.current = q.get("prueba") === "1";
  }, []);

  // Nivel de calidad del dispositivo, conexión en caliente y voz desbloqueada por el primer toque (iOS lo exige).
  useEffect(() => {
    iniciarCalidad();
    precalentar();
    window.addEventListener("pointerdown", desbloquearVoz, { once: true });
    return () => window.removeEventListener("pointerdown", desbloquearVoz);
  }, []);

  // Pantalla siempre encendida (kiosko). Se pierde al ocultar la pestaña: se vuelve a pedir al volver.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let vivo = true;
    const pedir = async () => {
      try {
        if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
        const l = await navigator.wakeLock.request("screen");
        if (vivo) lock = l;
        else l.release().catch(() => {});
      } catch {}
    };
    pedir();
    const alVolver = () => document.visibilityState === "visible" && pedir();
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      vivo = false;
      document.removeEventListener("visibilitychange", alVolver);
      lock?.release().catch(() => {});
    };
  }, []);

  // Cámara: resolución ideal según el dispositivo (sin forzar), y se reabre si el sistema la corta (iOS al ocultar la app).
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelado = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Este navegador no tiene acceso a la cámara.");
      const pedir = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      let s: MediaStream;
      try {
        s = await pedir(restriccionesCamara(calidadActual()));
      } catch (e) {
        // Una cámara que no cumple lo "ideal" no debería fallar, pero algunas la rechazan: se reintenta sin medidas.
        if (e instanceof DOMException && (e.name === "OverconstrainedError" || e.name === "ConstraintNotSatisfiedError")) {
          s = await pedir({ video: { facingMode: "user" }, audio: false });
        } else throw e;
      }
      if (cancelado) return s.getTracks().forEach((t) => t.stop());
      stream = s;
      setErrorCamara(null);
      if (video.current) {
        video.current.srcObject = s;
        video.current.play().catch(() => {});
      }
    })().catch((e) => setErrorCamara(mensajeErrorCamara(e)));
    const alVolver = () => {
      if (document.visibilityState !== "visible" || !stream) return;
      if (stream.getVideoTracks().some((t) => t.readyState === "ended")) setIntento((n) => n + 1);
      else video.current?.play().catch(() => {});
    };
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      cancelado = true;
      document.removeEventListener("visibilitychange", alVolver);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [intento]);

  useEffect(() => {
    if (!errorCamara) return;
    let reintentado = false;
    const reintentar = () => {
      if (reintentado) return;
      reintentado = true;
      setErrorCamara(null);
      setIntento((n) => n + 1);
    };
    window.addEventListener("pointerdown", reintentar, { once: true });
    window.addEventListener("keydown", reintentar, { once: true });
    return () => {
      window.removeEventListener("pointerdown", reintentar);
      window.removeEventListener("keydown", reintentar);
    };
  }, [errorCamara]);

  // La foto capturada es un objectURL: se revoca al reemplazarla y al salir.
  useEffect(() => {
    return () => {
      if (fotoUrl) URL.revokeObjectURL(fotoUrl);
    };
  }, [fotoUrl]);

  // Escala de tiempo de QA (?lento=N) para las animaciones CSS.
  useEffect(() => {
    k();
  }, []);

  // Contador de llegadas de hoy.
  useEffect(() => {
    const cargar = () => llegadasDeHoy().then(setHoy);
    cargar();
    const id = setInterval(cargar, 30_000);
    return () => clearInterval(id);
  }, []);

  // Verificación: feedback inmediato (fase "enviando" apenas se decide la foto), petición cancelable.
  const pendiente = useRef<AbortController | null>(null);
  const subeContador = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      pendiente.current?.abort();
      clearTimeout(subeContador.current);
    },
    [],
  );
  const alCapturando = useCallback(() => setFase("enviando"), []);
  const alFallarCaptura = useCallback(() => setFase("escaneando"), []);
  const alCapturar = useCallback(async (foto: Blob) => {
    pendiente.current?.abort();
    const ctl = (pendiente.current = new AbortController());
    const v = await verificar(foto, ctl.signal);
    if (pendiente.current !== ctl) return; // cancelada o reemplazada
    const { resultado, frase } = aResultado(v);
    setFotoUrl(URL.createObjectURL(foto));
    // El contador sube cuando la secuencia de éxito llega a la esquina: el rodillo se ve, no pasa de golpe.
    if (v.ok && !v.yaRegistrado) {
      clearTimeout(subeContador.current);
      subeContador.current = setTimeout(() => setHoy((n) => (n === null ? n : n + 1)), 900 * k());
    }
    setResultado(resultado);
    setFase("resultado");
    if (frase && voz.current) hablar(frase);
  }, []);

  // Dónde está la cara de quien mira (la foto 3D de inicio la sigue).
  const caraX = useMotionValue(0);
  const caraY = useMotionValue(0);
  const caraPresente = useMotionValue(0);
  const seguimiento = useMemo(() => ({ x: caraX, y: caraY, presente: caraPresente }), [caraX, caraY, caraPresente]);

  const { listo: listoReal, error: errorModeloReal, postura: posturaReal } = useRastreoCara({
    video,
    objetivo,
    progreso,
    activo: faseReal === "escaneando" && !esperarSalida,
    intento,
    onCaptura: alCapturar,
    onCapturando: alCapturando,
    onCapturaFallida: alFallarCaptura,
    mantenerAnillo: faseReal === "enviando",
    seguimiento,
  });

  useEffect(() => {
    if (!errorModeloReal || errorCamara) return;
    let reintentado = false;
    const reintentar = () => {
      if (reintentado) return;
      reintentado = true;
      setIntento((n) => n + 1);
    };
    window.addEventListener("pointerdown", reintentar, { once: true });
    window.addEventListener("keydown", reintentar, { once: true });
    return () => {
      window.removeEventListener("pointerdown", reintentar);
      window.removeEventListener("keydown", reintentar);
    };
  }, [errorCamara, errorModeloReal]);

  // Vista previa (solo desarrollo): fuerza fase/resultado/postura sin cámara.
  const demoResultado = useMemo(() => (demo && DEMO_VERIFICACION[demo] ? aResultado(DEMO_VERIFICACION[demo]).resultado : null), [demo]);
  const enDemo = demo !== "";
  const fase = demoResultado ? "resultado" : faseReal;
  const resultado = demoResultado ?? resultadoReal;
  const listo = enDemo || listoReal;
  const errorModelo = enDemo ? null : errorModeloReal;
  const postura: Postura = demo === "escaneando" ? "quieto" : demo === "inicio" ? "sin-cara" : enDemo ? "cerca" : posturaReal;
  useEffect(() => {
    if (demo === "escaneando") progreso.set(0.62);
  }, [demo, progreso]);

  // Demo: contador de ejemplo (11) que sube a 12 con el rodillo al reconocer; tocar la pantalla repite la secuencia.
  const [demoHoy, setDemoHoy] = useState(11);
  useEffect(() => {
    if (demo !== "reconocido") return;
    const id = setTimeout(() => setDemoHoy(12), 900 * k());
    return () => {
      clearTimeout(id);
      setDemoHoy(11);
    };
  }, [demo, repetir]);
  const hoyMostrado = enDemo ? demoHoy : hoy;

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

  const sinCamara = enDemo ? demo === "camara" : Boolean(errorCamara || errorModelo);
  const mostrarInicio = !sinCamara && fase === "escaneando" && !esperarSalida && (!listo || (lejos && inicioArmado));

  // Qué dice la pantalla y de qué color va el anillo.
  let texto: TextoTarjeta;
  let estado: EstadoEscaner;
  if (sinCamara) {
    texto = {
      titulo: errorCamara ? "Cámara no disponible" : "Reconocimiento no disponible",
      sub: errorCamara ?? errorModelo ?? "No se pudo iniciar el reconocimiento. Avisa al staff.",
    };
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
  if (enDemo && demo === "camara") {
    texto = { titulo: "Cámara no disponible", sub: "Permite el acceso a la cámara en el navegador y toca la pantalla para reintentar." };
    estado = "error";
  }
  const textoInicio = !listo
    ? { titulo: "Preparando", sub: "Un momento" }
    : postura !== "sin-cara" // hay alguien: se mantiene mientras la foto se abre hacia la cámara
      ? { titulo: "Acércate a la pantalla", sub: "Tu llegada se registra sola" }
      : { titulo: "Bienvenido", sub: "Acércate a la pantalla para registrar tu llegada" };

  const resultadoVisible = fase === "resultado";
  const exito = resultadoVisible && resultado?.tono === "exito";
  const sobrio = exito && Boolean(resultado?.sobrio);
  const T = k();

  // Foto del niño nítida en el círculo (cuadro capturado; en demo, un recorte de campeones.jpg).
  const mostrarFoto = resultadoVisible && resultado?.tono !== "error" && (enDemo ? demo !== "error" : Boolean(fotoUrl));
  const hayError = sinCamara || (resultadoVisible && resultado?.tono === "error");
  const modoAurora: ModoAurora = hayError
    ? "error"
    : resultadoVisible
      ? resultado?.tono === "aviso"
        ? "aviso"
        : "exito"
      : mostrarInicio
        ? "inicio"
        : "escaneo";

  const { cx, cy, r, banda, lado } = comp;
  const demoCamara = enDemo && demo !== "camara" && demo !== "inicio" && demo !== "error";
  // Demo: recorte de campeones.jpg (1408 px de ancho) centrado en la cara de un niño, con la cara ocupando ~55% del círculo.
  const kk = (r * 2 * 0.55 * 1.0) / 92;
  const recorte: React.CSSProperties = {
    left: cx - r,
    top: cy - r,
    width: r * 2,
    height: r * 2,
    backgroundImage: "url(/inicio/campeones.jpg)",
    backgroundSize: `${1408 * kk}px auto`,
    backgroundPosition: `${r - 1095 * kk}px ${r - 478 * kk}px`,
  };
  const filtroFoto = resultado?.tono === "aviso" ? "saturate(0.7) brightness(0.8)" : "brightness(1.08) saturate(1.1)";

  return (
    <MotionConfig reducedMotion="user">
      <main
        className="relative h-dvh w-full overflow-hidden bg-fondo"
        onClick={() => {
          if (resultadoVisible && prueba.current) terminarResultado();
          else if (enDemo) setRepetir((n) => n + 1);
        }}
      >
        {/* Aurora: la luz que el cristal refracta. Encima, las fotos 3D de FA CUP (nítidas en el inicio). */}
        <Aurora modo={modoAurora} />
        <FondoVivo seguimiento={seguimiento} modo={mostrarInicio ? "inicio" : exito ? "exito" : resultadoVisible ? "resultado" : "escaneo"} />
        <div className="grano" aria-hidden />
        <div className="vineta" aria-hidden />

        {/* Lente: cámara + bisel de cristal + marcas. Al salir del inicio se acerca desde atrás. */}
        <motion.div
          key={`lente${repetir}`}
          className="absolute inset-0"
          style={{ transformOrigin: `${cx}px ${cy}px` }}
          initial={false}
          animate={mostrarInicio ? { opacity: 0, scale: 0.86 } : { opacity: 1, scale: 1 }}
          transition={mostrarInicio ? { duration: 0.5, ease: EASE } : { type: "spring", stiffness: 140, damping: 22 }}
        >
          {/* Temblor suave del aviso (ámbar): 2 ciclos, amplitud 6 px */}
          <motion.div
            className="absolute inset-0"
            initial={estado === "aviso" ? { x: 0 } : false}
            animate={estado === "aviso" ? { x: [0, -6, 6, -6, 6, 0] } : { x: 0 }}
            transition={estado === "aviso" ? { duration: 0.9 * T, delay: 0.25 * T, ease: "easeInOut" } : { duration: 0.2 }}
          >
            {/* Cámara: solo dentro del círculo (clip-path, más barato que una máscara sobre video en vivo), en espejo. */}
            <div className="absolute inset-0" style={{ clipPath: `circle(${r}px at ${cx}px ${cy}px)` }}>
              {/* El espejo va en el video, no en el recorte: así el círculo queda donde está aunque no esté centrado. */}
              <video ref={video} autoPlay muted playsInline disablePictureInPicture className="absolute inset-0 h-full w-full -scale-x-100 object-cover" />
            </div>
            {/* Demo: recorte de una foto de FA CUP donde iría la cámara */}
            {demoCamara && <div className="absolute rounded-full" style={recorte} />}
            {/* Foto capturada: nítida y brillante, con el mismo encuadre que la cámara. Sin capas que la oscurezcan. */}
            <AnimatePresence>
              {mostrarFoto && (
                <motion.div
                  key={`foto${repetir}`}
                  className="absolute inset-0"
                  style={{ clipPath: `circle(${r}px at ${cx}px ${cy}px)` }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.35 } }}
                  transition={{ duration: 0.28 * T, ease: "easeOut" }}
                >
                  <motion.div
                    className="absolute inset-0"
                    style={{ transformOrigin: `${cx}px ${cy}px` }}
                    initial={{ scale: 1.07 }}
                    animate={{ scale: 1 }}
                    transition={{ duration: 1.1 * T, ease: EASE }}
                  >
                    {enDemo || !fotoUrl ? (
                      <div className="absolute rounded-full" style={{ ...recorte, filter: filtroFoto }} />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element -- objectURL local del cuadro capturado
                      <img src={fotoUrl} alt="" className="absolute inset-0 h-full w-full -scale-x-100 object-cover" style={{ filter: filtroFoto }} />
                    )}
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
            {/* Sin cámara o error: el círculo se atenúa un poco */}
            <motion.div
              className="pointer-events-none absolute rounded-full bg-black"
              style={{ left: cx - r, top: cy - r, width: r * 2, height: r * 2 }}
              initial={false}
              animate={{ opacity: hayError ? 0.55 : 0 }}
              transition={{ duration: 0.4, ease: EASE }}
            />
            <Lente key={`l${repetir}`} objetivo={circulo} banda={banda} progreso={progreso} estado={estado} sobrio={sobrio} />
          </motion.div>
        </motion.div>

        {/* Inicio: saludo sobre el fondo vivo mientras no hay nadie cerca */}
        <AnimatePresence>
          {mostrarInicio && <Inicio key="inicio" titulo={textoInicio.titulo} sub={textoInicio.sub} />}
        </AnimatePresence>

        {/* Barra superior: logo y llegadas del día, discretos */}
        <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-4 pl-[max(1rem,4vw,env(safe-area-inset-left))] pr-[max(1rem,4vw,env(safe-area-inset-right))] pt-[max(1rem,3.5vh,env(safe-area-inset-top))]">
          <Image src="/logo-blanco.png" alt="FA CUP Chile" width={235} height={50} priority className="h-[clamp(28px,4.2vh,44px)] w-auto drop-shadow-[0_2px_8px_rgba(0,0,0,.45)]" />
          {hoyMostrado !== null && (
            <motion.p
              className="cristal flex min-h-11 items-center gap-2.5 rounded-full px-4 py-1.5 text-[clamp(0.85rem,1.2vw,1rem)] font-medium text-texto/90"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 200, damping: 24 }}
            >
              <Rodillo valor={hoyMostrado} className="text-[clamp(1.3rem,2.4vw,1.8rem)] font-semibold leading-none tracking-[-0.03em] text-texto" />
              <span className="whitespace-nowrap">{hoyMostrado === 1 ? "llegada hoy" : "llegadas hoy"}</span>
            </motion.p>
          )}
        </header>

        {/* Tarjeta de cristal: guía, y al reconocer, el nombre en grande. Debajo del lente en vertical, a su lado en horizontal. */}
        <AnimatePresence>
          {!mostrarInicio && (
            <motion.div
              key={`hoja${repetir}`}
              className="absolute z-20 flex"
              style={
                lado
                  ? { left: comp.tarjetaX, width: comp.tarjetaW, top: 0, bottom: 0, alignItems: "center" }
                  : { left: comp.tarjetaX, width: comp.tarjetaW, top: comp.tarjetaY }
              }
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 16, transition: { duration: 0.3 } }}
              transition={{ type: "spring", stiffness: 160, damping: 24, delay: exito ? 0.4 * T : 0 }}
            >
              <Tarjeta
                texto={texto}
                tono={resultadoVisible ? resultado?.tono : sinCamara ? "error" : undefined}
                sobrio={sobrio}
                izquierda={lado}
                resultado={resultadoVisible}
              />
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
