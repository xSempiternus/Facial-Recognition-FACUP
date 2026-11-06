"use client";

// Pantalla de reconocimiento FA CUP Chile, a pantalla completa (estilo Face ID): la cámara ocupa todo el teléfono y
// encima van el título, cuatro esquinas que encuadran la cara y la siguen, puntitos de referencia, el porcentaje de
// "mantén la posición" y una barra de vidrio con las llegadas de hoy y "Salir". Al reconocer, la foto se congela
// nítida, las esquinas se cierran en verde y una tarjeta de vidrio muestra el nombre. Sin botones para registrar:
// al quedarse quieto, la foto se saca sola. En escritorio / horizontal la cámara vive en un escenario vertical (~3:4).

import { AnimatePresence, motion, MotionConfig, useMotionValue, type MotionValue } from "motion/react";
import { ChevronLeft, SwitchCamera } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { abrirCamara, contarCamaras, facingInicial, guardarFacing, type Facing } from "@/lib/camara";
import { iniciarSonidos, sonar } from "@/lib/sonidos";
import { desbloquearVoz, hablar, type Frase } from "@/lib/voz";
import { llegadasDeHoy, noSoyYo, precalentar, verificar, type Verificacion } from "@/lib/api";
import { calidadActual, iniciarCalidad, restriccionesCamara, useCalidad } from "./calidad";
import Aurora, { type ModoAurora } from "./Aurora";
import Insignia from "./Insignia";
import Marco, { type Guia, type ModoMarco } from "./Marco";
import { crearRastro, PUNTOS_REF, type Rastro } from "./rastro";
import Rodillo from "./Rodillo";
import Tarjeta, { type TextoTarjeta } from "./Tarjeta";
import { k } from "./tiempo";
import { capturarFoto, useRastreoCara, type Objetivo, type Postura } from "./useRastreoCara";

const MOSTRAR_RESULTADO_MS = 4200;
const GRACIAS_MS = 2800; // tras "¿No eres tú?", el mensaje de gracias queda visible este tiempo
const ESPERA_MISMO_NIÑO_MS = 6000; // tras un resultado, no vuelve a escanear a quien sigue frente a la cámara
const EASE = [0.22, 1, 0.36, 1] as const;
const ESCRITORIO_DESDE = 900; // ancho (px) desde el que la cámara va en un escenario centrado

type Resultado = TextoTarjeta & {
  tono: "exito" | "aviso" | "error";
  sobrio?: boolean; // "ya registrado"
};

// Saludos de jugador: uno por llegada, para que no suene siempre igual.
const ANIMOS = ["¡A la cancha!", "¡Hoy se juega!", "¡A jugar!", "¡Con todo hoy!", "¡Vamos equipo!"];
const animo = () => ANIMOS[Math.floor(Math.random() * ANIMOS.length)];

const GUIA: Record<Postura, { titulo: string; sub: string }> = {
  "sin-cara": { titulo: "¡Registra tu llegada!", sub: "Mira a la cámara, sin prisa" },
  lejos: { titulo: "Acércate un poco", sub: "Llena el marco con tu cara" },
  cerca: { titulo: "Aléjate un poco", sub: "Estás muy cerca de la cámara" },
  descentrado: { titulo: "Centra tu cara", sub: "Ponla dentro del marco" },
  quieto: { titulo: "Mantén la posición", sub: "Ya casi" },
};

function mensajeErrorCamara(e: unknown) {
  if (e instanceof DOMException) {
    switch (e.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Permiso de cámara denegado. Actívalo en los ajustes del navegador y toca Reintentar.";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "No encontramos una cámara disponible en este equipo.";
      case "NotReadableError":
      case "TrackStartError":
        return "La cámara está en uso por otra app. Ciérrala y toca Reintentar.";
      default:
        return "No se pudo iniciar la cámara. Toca Reintentar.";
    }
  }
  return e instanceof Error ? e.message : "No se pudo iniciar la cámara. Toca Reintentar.";
}

// Composición del escenario (px del propio escenario). `guia` es el óvalo de reposo de los brackets; `objetivo` es el
// círculo equivalente que usa el rastreo para decidir lejos / cerca / descentrado (misma lógica de siempre).
function componer(w: number, h: number): { guia: Guia; objetivo: Objetivo } {
  // Entre el título (arriba) y la tarjeta + barra (abajo) queda el hueco donde vive el marco, centrado.
  const arriba = 138;
  const reserva = w >= 500 ? 335 : 305;
  const libre = Math.max(200, h - reserva - arriba);
  const gh = Math.min(h * 0.4, w * 0.8, libre / 1.12);
  const cx = w / 2;
  const cy = arriba + libre / 2;
  return { guia: { cx, cy, w: gh * 0.78, h: gh }, objetivo: { cx, cy, r: gh * 0.68 } };
}

// Tamaño de la ventana como estado externo (se actualiza al redimensionar).
const suscribirResize = (avisar: () => void) => {
  window.addEventListener("resize", avisar);
  return () => window.removeEventListener("resize", avisar);
};
const tamañoActual = () => `${window.innerWidth}x${window.innerHeight}`;
const tamañoServidor = () => "390x844";

function useTamañoPantalla() {
  const [ancho, alto] = useSyncExternalStore(suscribirResize, tamañoActual, tamañoServidor).split("x").map(Number);
  return { ancho, alto };
}

function aResultado(v: Verificacion): { resultado: Resultado; frase: Frase | null } {
  if (v.ok) {
    const nombre = v.nombre.split(" ")[0];
    const horaReg = v.registradoALas?.slice(11, 16);
    if (v.yaRegistrado) {
      return {
        resultado: { tono: "exito", sobrio: true, titulo: nombre, grande: true, detalle: v.categoria, hora: horaReg ? `Hoy a las ${horaReg}` : "Hoy" },
        frase: { texto: `¡Hola de nuevo, ${nombre}!`, tipo: "de_nuevo", nombre },
      };
    }
    const ahora = new Date().toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false });
    return {
      resultado: { tono: "exito", titulo: nombre, grande: true, detalle: v.categoria, saludo: animo(), hora: `Llegada ${ahora}` },
      frase: { texto: `¡Hola, ${nombre}! ¡A jugar!`, tipo: "hola", nombre },
    };
  }
  switch (v.codigo) {
    case "sin_rostro":
      return { resultado: { tono: "aviso", titulo: "No detectamos tu cara", sub: "Mira de frente a la cámara, con buena luz" }, frase: { texto: "No detectamos tu cara. Prueba otra vez.", tipo: "sin_cara" } };
    case "foto_falsa":
      return { resultado: { tono: "aviso", titulo: "Usa tu cara, no una foto", sub: "Ponte tú frente a la cámara" }, frase: { texto: "Usa tu cara, no una foto.", tipo: "foto" } };
    case "no_reconocido":
      return { resultado: { tono: "aviso", titulo: "No te reconocimos", sub: "Intenta de nuevo o avisa a tu entrenador" }, frase: { texto: "No te reconocimos. Intenta de nuevo o avisa a tu entrenador.", tipo: "no_reconocido" } };
    case "sin_conexion":
      return { resultado: { tono: "aviso", titulo: "Sin conexión", sub: "Revisa tu internet e intenta de nuevo" }, frase: null };
    case "sin_jugadores":
      return { resultado: { tono: "error", titulo: "Aún no hay jugadores inscritos", sub: "El staff debe inscribirlos primero" }, frase: null };
    default:
      return { resultado: { tono: "error", titulo: "Sistema no disponible", sub: "Avisa al staff" }, frase: null };
  }
}

// Vista previa de estados para diseño/QA: ?demo=buscando|alinear|escaneando|reconocido|ya|noreconoce|sinrostro|error|camara.
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

// Demo: la cara de un niño de campeones.jpg (1409 px de ancho), centrada en el óvalo guía. Los puntos están medidos
// sobre la captura de referencia (guía de 312 px de alto centrada en 195,363) y escalan con el alto de la guía.
const DEMO_FOTO = { ancho: 1409, cx: 1105.5, cy: 480, alto: 56 }; // punto de la foto que cae en el centro de la guía
const REF = { cx: 195, cy: 363, h: 312 };
// En el orden de PUNTOS_REF, en px de la captura de referencia.
const DEMO_PUNTOS: [number, number][] = [
  [100, 322], [158, 325], [130, 314], [130, 332], // ojo izquierdo de la imagen
  [205, 325], [268, 322], [235, 314], [235, 332], // ojo derecho
  [178, 368], [182, 330], [160, 376], [200, 376], // nariz
  [155, 408], [235, 408], [195, 402], [195, 422], // boca
  [192, 478], [95, 375], [290, 380], [190, 255], // mentón, laterales, frente
];
const DEMO_CAJA = { x0: 95, y0: 255, x1: 290, y1: 482 };
const DEMO_SIN_CARA = new Set(["buscando", "error", "camara"]);

// Número 0..100 que sigue al progreso escribiendo directo en el DOM (sin setState por cuadro).
function Porcentaje({ progreso }: { progreso: MotionValue<number> }) {
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const poner = (v: number) => {
      if (el.current) el.current.textContent = String(Math.round(v * 100));
    };
    poner(progreso.get());
    return progreso.on("change", poner);
  }, [progreso]);
  return <span ref={el} className="inline-block w-[2.05ch] text-right">0</span>;
}

export default function Kiosko({ onSalir }: { onSalir?: () => void }) {
  const demo = useDemo();
  const enDemo = demo !== "";
  const video = useRef<HTMLVideoElement>(null);
  const escenario = useRef<HTMLDivElement>(null);
  const progreso = useMotionValue(0);
  const calidad = useCalidad();
  const [rastroInicial] = useState(crearRastro);
  const rastro = useRef<Rastro>(rastroInicial);

  // Geometría: pantalla completa en teléfono; escenario vertical (~3:4, 92 % del alto) en escritorio u horizontal.
  const { ancho, alto } = useTamañoPantalla();
  const escritorio = ancho >= ESCRITORIO_DESDE;
  const sh = escritorio ? Math.round(alto * 0.92) : alto;
  const sw = escritorio ? Math.min(Math.round(sh * 0.75), ancho - 32) : ancho;
  const comp = useMemo(() => componer(sw, sh), [sw, sh]);
  const { guia, objetivo: circulo } = comp;
  const objetivo = useRef<Objetivo>(circulo); // el bucle de rastreo lo lee cada cuadro
  useEffect(() => {
    objetivo.current = circulo;
  }, [circulo]);

  const [errorCamara, setErrorCamara] = useState<string | null>(null);
  const [camaraLista, setCamaraLista] = useState(false); // false mientras el permiso de cámara está pendiente
  const [intento, setIntento] = useState(0);
  const [facing, setFacing] = useState<Facing>(facingInicial);
  const [espejo, setEspejo] = useState(true); // la frontal se ve en espejo; la trasera no
  const [varias, setVarias] = useState(false);
  const [faseReal, setFase] = useState<"escaneando" | "enviando" | "resultado">("escaneando");
  const [resultadoReal, setResultado] = useState<Resultado | null>(null);
  const [hoy, setHoy] = useState<number | null>(null);
  const [esperarSalida, setEsperarSalida] = useState(false);
  const [fotoUrl, setFotoUrl] = useState<string | null>(null); // foto capturada, para mostrarla nítida a pantalla completa
  const [reporte, setReporte] = useState<string | null>(null); // token de un solo uso de /verify para "¿No eres tú?"
  const [estadoReporte, setEstadoReporte] = useState<"libre" | "enviando" | "enviado" | "limite" | "red">("libre");
  const [repetir, setRepetir] = useState(0); // solo demo: tocar la pantalla repite la secuencia
  const voz = useRef(true);
  const prueba = useRef(false);

  // La voz está apagada por defecto (suenan los efectos); ?voz=1 la enciende. ?prueba=1 deja el resultado en pantalla hasta tocarla (para el staff).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    voz.current = q.get("voz") === "1";
    prueba.current = q.get("prueba") === "1";
  }, []);

  // Nivel de calidad del dispositivo, conexión en caliente y voz desbloqueada por el primer toque (iOS lo exige).
  useEffect(() => {
    iniciarCalidad();
    precalentar();
    const alToque = () => {
      desbloquearVoz();
      iniciarSonidos();
    };
    iniciarSonidos(); // si ya hubo un gesto en el menú, el contexto existe y solo se reanuda
    window.addEventListener("pointerdown", alToque, { once: true });
    return () => window.removeEventListener("pointerdown", alToque);
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

  // Reintento manual de cámara/modelo (botón "Reintentar" o toque): con guarda contra dobles toques.
  const ultimoReintento = useRef(0);
  const reintentarCamara = useCallback(() => {
    const t = Date.now();
    if (t - ultimoReintento.current < 600) return;
    ultimoReintento.current = t;
    setErrorCamara(null);
    setIntento((n) => n + 1);
  }, []);

  // Cámara: resolución ideal según el dispositivo (sin forzar). Se reabre si el sistema la corta (iOS al ocultar la app),
  // se reanuda al volver a primer plano y siempre se detienen los tracks al salir.
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelado = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Este navegador no tiene acceso a la cámara (en iPhone usa Safari con HTTPS).");
      // `exact` → `ideal` → sin medidas → `true` (ver lib/camara): una cámara que no cumple lo "ideal" no debe fallar.
      const r = await abrirCamara(facing, restriccionesCamara(calidadActual()).video as MediaTrackConstraints);
      const s = r.stream;
      if (cancelado) return s.getTracks().forEach((t) => t.stop());
      stream = s;
      setEspejo(r.facing === "user"); // antes de asignar el stream: vista y coordenadas del rastreo cambian juntas
      contarCamaras().then((n) => !cancelado && setVarias(n > 1));
      s.getVideoTracks().forEach((t) => {
        // iOS/Android cortan la cámara al ocultar la app o si otra app la toma: se vuelve a abrir.
        t.addEventListener("ended", () => !cancelado && document.visibilityState === "visible" && setIntento((n) => n + 1));
      });
      setErrorCamara(null);
      setCamaraLista(true);
      const v = video.current;
      if (v) {
        v.srcObject = s;
        v.play().catch(() => {});
      }
    })().catch((e) => {
      if (!cancelado) setErrorCamara(mensajeErrorCamara(e));
    });
    const alVolver = () => {
      if (document.visibilityState !== "visible" || !stream) return;
      if (stream.getVideoTracks().some((t) => t.readyState === "ended")) setIntento((n) => n + 1);
      else video.current?.play().catch(() => {});
    };
    // Safari puede pausar el <video> (llamada, bloqueo): si está visible, se reanuda.
    const v0 = video.current;
    const alPausar = () => document.visibilityState === "visible" && !cancelado && v0?.play().catch(() => {});
    v0?.addEventListener("pause", alPausar);
    document.addEventListener("visibilitychange", alVolver);
    const alCambiarDispositivos = () => contarCamaras().then((n) => !cancelado && setVarias(n > 1));
    navigator.mediaDevices?.addEventListener?.("devicechange", alCambiarDispositivos);
    return () => {
      cancelado = true;
      document.removeEventListener("visibilitychange", alVolver);
      navigator.mediaDevices?.removeEventListener?.("devicechange", alCambiarDispositivos);
      v0?.removeEventListener("pause", alPausar);
      stream?.getTracks().forEach((t) => t.stop());
      if (v0) v0.srcObject = null;
    };
  }, [intento, facing]);

  // Voltear: solo reabre la cámara (no recarga el modelo ni reinicia `intento`); el anillo vuelve a cero.
  const voltearCamara = useCallback(() => {
    const t = Date.now();
    if (t - ultimoReintento.current < 600) return;
    ultimoReintento.current = t;
    const nuevo: Facing = facing === "user" ? "environment" : "user";
    guardarFacing(nuevo);
    progreso.set(0);
    setErrorCamara(null);
    setFacing(nuevo);
  }, [facing, progreso]);

  useEffect(() => {
    if (!errorCamara) return;
    window.addEventListener("pointerdown", reintentarCamara, { once: true });
    window.addEventListener("keydown", reintentarCamara, { once: true });
    return () => {
      window.removeEventListener("pointerdown", reintentarCamara);
      window.removeEventListener("keydown", reintentarCamara);
    };
  }, [errorCamara, reintentarCamara]);

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
    let vivo = true;
    const cargar = () => {
      if (document.visibilityState !== "visible") return;
      llegadasDeHoy().then((n) => vivo && n !== null && setHoy(n));
    };
    cargar();
    const id = setInterval(cargar, 30_000);
    return () => {
      vivo = false;
      clearInterval(id);
    };
  }, []);

  // Verificación: feedback inmediato (fase "enviando" apenas se decide la foto), petición cancelable.
  const pendiente = useRef<AbortController | null>(null);
  const subeContador = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      pendiente.current?.abort();
      pendiente.current = null; // evita setState / objectURL tras desmontar
      clearTimeout(subeContador.current);
    },
    [],
  );
  const alCapturando = useCallback(() => setFase("enviando"), []);
  const alFallarCaptura = useCallback(() => setFase("escaneando"), []);
  const [reintentandoRed, setReintentandoRed] = useState(false);
  const alCapturar = useCallback(async (foto: Blob) => {
    pendiente.current?.abort();
    const ctl = (pendiente.current = new AbortController());
    setReintentandoRed(false);
    const v = await verificar(foto, ctl.signal, () => {
      if (pendiente.current === ctl) setReintentandoRed(true);
    });
    if (pendiente.current !== ctl) return; // cancelada o reemplazada
    setReintentandoRed(false);
    const { resultado, frase } = aResultado(v);
    setFotoUrl(URL.createObjectURL(foto));
    // El contador sube cuando la secuencia de éxito avanza: el rodillo se ve, no pasa de golpe.
    if (v.ok && !v.yaRegistrado) {
      clearTimeout(subeContador.current);
      subeContador.current = setTimeout(() => setHoy((n) => (n === null ? n : n + 1)), 900 * k());
    }
    setReporte(v.ok && !v.yaRegistrado ? (v.reporte ?? null) : null);
    setEstadoReporte("libre");
    setResultado(resultado);
    setFase("resultado");
    if (frase && voz.current) hablar(frase);
  }, []);

  const { listo: listoReal, error: errorModeloReal, postura: posturaReal } = useRastreoCara({
    video,
    objetivo,
    progreso,
    activo: faseReal === "escaneando" && !esperarSalida && !enDemo, // en demo el rastreo no pisa el progreso ni los puntos simulados
    intento,
    onCaptura: alCapturar,
    onCapturando: alCapturando,
    onCapturaFallida: alFallarCaptura,
    mantenerAnillo: faseReal === "enviando",
    escenario,
    espejo,
    rastro: enDemo ? undefined : rastro,
  });

  // Vista previa (solo desarrollo): fuerza fase/resultado/postura sin cámara.
  const demoResultado = useMemo(() => (demo && DEMO_VERIFICACION[demo] ? aResultado(DEMO_VERIFICACION[demo]).resultado : null), [demo]);
  const fase = demoResultado ? "resultado" : faseReal;
  const resultado = demoResultado ?? resultadoReal;
  const listo = enDemo || listoReal;
  const errorModelo = enDemo ? null : errorModeloReal;
  const postura: Postura = demo === "escaneando" ? "quieto" : demo === "buscando" ? "sin-cara" : demo === "alinear" ? "descentrado" : enDemo ? "quieto" : posturaReal;
  useEffect(() => {
    if (demo === "escaneando") progreso.set(0.62);
  }, [demo, progreso]);

  // Demo: la cara de ejemplo (recorte de campeones.jpg) ocupa el óvalo guía; los puntos y la caja simulados caen sobre ella.
  const demoConCara = enDemo && !DEMO_SIN_CARA.has(demo);
  const demoDesvio = demo === "alinear" ? { x: sw * 0.11, y: -sh * 0.025 } : { x: 0, y: 0 };
  const demoEscala = (guia.h * 0.86) / DEMO_FOTO.alto; // px de pantalla por px de la foto
  useEffect(() => {
    const R = rastro.current;
    if (!enDemo) return;
    R.hay = demoConCara;
    R.fija = true;
    R.espejo = false;
    R.ancho = sw;
    R.alto = sh;
    R.t = performance.now();
    if (!demoConCara) return;
    const aX = (x: number) => (guia.cx + demoDesvio.x + ((x - REF.cx) / REF.h) * guia.h) / sw;
    const aY = (y: number) => (guia.cy + demoDesvio.y + ((y - REF.cy) / REF.h) * guia.h) / sh;
    for (let i = 0; i < PUNTOS_REF.length; i++) {
      R.pts[i * 2] = aX(DEMO_PUNTOS[i][0]);
      R.pts[i * 2 + 1] = aY(DEMO_PUNTOS[i][1]);
    }
    R.caja.x0 = aX(DEMO_CAJA.x0);
    R.caja.x1 = aX(DEMO_CAJA.x1);
    R.caja.y0 = aY(DEMO_CAJA.y0);
    R.caja.y1 = aY(DEMO_CAJA.y1);
  }, [enDemo, demoConCara, demoDesvio.x, demoDesvio.y, guia.cx, guia.cy, guia.h, sw, sh]);

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
    setReporte(null);
    setEstadoReporte("libre");
    setFase("escaneando");
    setEsperarSalida(true);
  }, []);
  useEffect(() => {
    // Mientras se envía el aviso el resultado se queda; al terminar, el mensaje de gracias dura GRACIAS_MS y se sigue.
    if (fase !== "resultado" || prueba.current || estadoReporte === "enviando") return;
    const ms = estadoReporte === "enviado" || estadoReporte === "limite" ? GRACIAS_MS : MOSTRAR_RESULTADO_MS;
    const id = setTimeout(terminarResultado, ms);
    return () => clearTimeout(id);
  }, [fase, terminarResultado, estadoReporte]);

  // "¿No eres tú?": un toque avisa al staff con el reporte de un solo uso. Respuesta genérica; 429 = mensaje amable.
  const avisarNoSoyYo = useCallback(async () => {
    if (!reporte || estadoReporte === "enviando" || estadoReporte === "enviado") return;
    setEstadoReporte("enviando");
    const r = await noSoyYo(reporte);
    if (r === "ok") {
      setReporte(null); // de un solo uso
      setEstadoReporte("enviado");
      sonar("aviso");
    } else setEstadoReporte(r);
  }, [reporte, estadoReporte]);
  useEffect(() => {
    if (!esperarSalida) return;
    const id = setTimeout(() => setEsperarSalida(false), postura === "sin-cara" ? 0 : ESPERA_MISMO_NIÑO_MS);
    return () => clearTimeout(id);
  }, [esperarSalida, postura]);

  const sinCamara = enDemo ? demo === "camara" : Boolean(errorCamara);
  // El modelo de caras no cargó (red lenta, equipo modesto): se puede seguir con captura manual.
  const modoManual = !enDemo && Boolean(errorModelo) && !errorCamara;

  // Aviso si el modelo (pesado) tarda en cargar con datos móviles lentos.
  const [cargaLenta, setCargaLenta] = useState(false);
  const esperandoModelo = !listo && !errorCamara && !modoManual;
  useEffect(() => {
    if (!esperandoModelo) return;
    const id = setTimeout(() => setCargaLenta(true), 8000);
    return () => {
      clearTimeout(id);
      setCargaLenta(false);
    };
  }, [esperandoModelo, intento]);

  const tomarManual = useCallback(async () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    setFase("enviando");
    let foto: Blob | null = null;
    try {
      foto = await capturarFoto(v);
    } catch {
      foto = null;
    }
    if (foto) alCapturar(foto);
    else setFase("escaneando");
  }, [alCapturar]);
  const resultadoVisible = fase === "resultado" && Boolean(resultado);
  const tono = resultado?.tono;
  const exito = resultadoVisible && tono === "exito";
  const sobrio = exito && Boolean(resultado?.sobrio);
  const hayError = sinCamara || (resultadoVisible && tono === "error");
  const T = k();

  // Sonidos de la secuencia: cara detectada -> bloqueo (empieza el escaneo) -> captura -> resultado.
  const anterior = useRef<{ postura: Postura; fase: string }>({ postura: "sin-cara", fase: "escaneando" });
  useEffect(() => {
    const a = anterior.current;
    if (fase === "escaneando" && a.postura === "sin-cara" && postura !== "sin-cara") sonar("rostro");
    if (fase === "escaneando" && postura === "quieto" && a.postura !== "quieto") sonar("bloqueo");
    if (fase === "enviando" && a.fase !== "enviando") sonar("captura");
    anterior.current = { postura, fase };
  }, [postura, fase]);
  useEffect(() => {
    if (!resultadoVisible) return;
    sonar(exito ? (sobrio ? "ya" : "exito") : tono === "aviso" ? "aviso" : "error");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- suena una vez por resultado nuevo
  }, [resultado, resultadoVisible]);

  // Texto de arriba (guía) y tarjeta de abajo (resultado).
  const cartaTexto: TextoTarjeta | null = sinCamara
    ? {
        titulo: "Cámara no disponible",
        sub: errorCamara ?? "Permite el acceso a la cámara en el navegador y toca Reintentar.",
      }
    : resultadoVisible
      ? resultado
      : null;
  let arriba: { titulo: string; sub: string };
  if (sinCamara || (resultadoVisible && tono === "error")) arriba = { titulo: "Hay un problema", sub: "Avisa al staff" };
  else if (resultadoVisible && tono === "aviso") arriba = { titulo: "Intenta de nuevo", sub: "Mira de frente, con buena luz" };
  else if (exito) arriba = sobrio ? { titulo: "Ya estabas registrado", sub: "Tu llegada de hoy ya estaba lista" } : { titulo: "¡Llegada registrada!", sub: "Bienvenido a FA CUP" };
  else if (reintentandoRed && fase === "enviando") arriba = { titulo: "Sin conexión, reintentando…", sub: "No te muevas" };
  else if (fase === "enviando") arriba = { titulo: "Casi listo", sub: "Un momento" };
  else if (modoManual) arriba = { titulo: "Toma tu foto", sub: "Pon tu cara en el marco y toca el botón" };
  else if (!enDemo && !camaraLista) arriba = { titulo: "Permite la cámara para continuar", sub: "Acepta el aviso del navegador" };
  else if (!listo) arriba = { titulo: "Preparando la cámara", sub: cargaLenta ? "Conexión lenta, cargando…" : "Un momento" };
  else if (esperarSalida && postura !== "sin-cara") arriba = { titulo: "Listo", sub: "Puede pasar el siguiente" };
  else arriba = GUIA[postura];

  const mostrarPorcentaje = !sinCamara && !resultadoVisible && (fase === "enviando" || (postura === "quieto" && !esperarSalida && listo));
  const modoMarco: ModoMarco = hayError
    ? "error"
    : resultadoVisible
      ? tono === "aviso"
        ? "aviso"
        : sobrio
          ? "ya"
          : "exito"
      : fase === "enviando"
        ? "verifica"
        : postura === "quieto" && !esperarSalida
          ? "quieto"
          : "busca";
  const modoAurora: ModoAurora = hayError ? "error" : resultadoVisible ? (tono === "aviso" ? "aviso" : "exito") : "escaneo";

  // Foto del niño nítida a pantalla completa (cuadro capturado; en demo, el recorte de campeones.jpg).
  const mostrarFoto = resultadoVisible && tono !== "error" && (enDemo ? demo !== "error" : Boolean(fotoUrl));
  const demoFondo = enDemo && demo !== "camara" && demo !== "error";
  const fotoDemo: React.CSSProperties = demoConCara
    ? {
        backgroundImage: "url(/inicio/campeones.jpg)",
        backgroundSize: `${DEMO_FOTO.ancho * demoEscala}px auto`,
        backgroundPosition: `${guia.cx + demoDesvio.x - DEMO_FOTO.cx * demoEscala}px ${guia.cy + demoDesvio.y - DEMO_FOTO.cy * demoEscala}px`,
        backgroundRepeat: "no-repeat",
      }
    : { backgroundImage: "url(/inicio/campeones.jpg)", backgroundSize: "cover", backgroundPosition: "18% 55%" };
  const filtroFoto = tono === "aviso" ? "saturate(0.75) brightness(0.9)" : "brightness(1.06) saturate(1.08)";
  const blur = calidad !== "bajo";

  return (
    <MotionConfig reducedMotion="user">
      <main
        className="relative flex h-dvh w-full items-center justify-center overflow-hidden bg-fondo"
        onClick={() => {
          if (resultadoVisible && prueba.current) terminarResultado();
          else if (enDemo) setRepetir((n) => n + 1);
        }}
      >
        {/* Escritorio: aurora y vidrio alrededor del escenario. En teléfono la cámara lo cubre todo. */}
        {escritorio && (
          <>
            <Aurora modo={modoAurora} />
            <div className="grano" aria-hidden />
            <div className="vineta" aria-hidden />
          </>
        )}

        <div ref={escenario} className="reco-escenario" data-escritorio={escritorio ? "" : undefined} style={{ width: sw, height: sh }}>
          {sinCamara && <Aurora modo="error" />}

          {/* Cámara a sangre; en espejo solo la frontal */}
          <video
            ref={video}
            autoPlay
            muted
            playsInline
            disablePictureInPicture
            className={`absolute inset-0 h-full w-full object-cover ${espejo ? "-scale-x-100" : ""}`}
            style={{ opacity: sinCamara ? 0 : 1 }}
          />
          {/* Demo: recorte de una foto de FA CUP donde iría la cámara */}
          {demoFondo && <div className="absolute inset-0" style={{ ...fotoDemo, filter: demo === "buscando" ? "brightness(.85)" : undefined }} />}

          {/* Foto capturada: congelada, nítida y brillante, con el mismo encuadre que la cámara. Sin velo oscuro. */}
          <AnimatePresence>
            {mostrarFoto && (
              <motion.div
                key={`foto${repetir}`}
                className="absolute inset-0"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.35 } }}
                transition={{ duration: 0.3 * T, ease: "easeOut" }}
              >
                <motion.div
                  className="absolute inset-0"
                  style={{ transformOrigin: `${guia.cx}px ${guia.cy}px` }}
                  initial={{ scale: 1.045 }}
                  animate={{ scale: 1 }}
                  transition={{ duration: 1.2 * T, ease: EASE }}
                >
                  {enDemo || !fotoUrl ? (
                    <div className="absolute inset-0" style={{ ...fotoDemo, filter: filtroFoto }} />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- objectURL local del cuadro capturado
                    <img src={fotoUrl} alt="" className={`absolute inset-0 h-full w-full object-cover ${espejo ? "-scale-x-100" : ""}`} style={{ filter: filtroFoto }} />
                  )}
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Degradados de lectura (la foto no lleva velo) */}
          <div className="reco-velo-sup" aria-hidden />
          <div className="reco-velo-inf" aria-hidden />

          {/* Destello suave al reconocer */}
          {exito && (
            <motion.div
              key={`flash${repetir}`}
              className="pointer-events-none absolute inset-0 z-[2] bg-white"
              initial={{ opacity: 0 }}
              animate={{ opacity: sobrio ? [0, 0.1, 0] : [0, 0.32, 0] }}
              transition={{ duration: 0.7 * T, times: [0, 0.25, 1], ease: "easeOut" }}
            />
          )}

          {/* Brackets, puntitos, onda de luz y chispas (lienzo propio, sin re-render por cuadro) */}
          <Marco key={`marco${repetir}`} rastro={rastro} modo={modoMarco} guia={guia} ancho={sw} alto={sh} />

          {/* Título y subtítulo arriba, con transiciones cortas */}
          {onSalir && (
            <button
              type="button"
              className="reco-volver"
              aria-label="Volver al menú"
              onClick={(e) => {
                e.stopPropagation();
                sonar("volver");
                onSalir();
              }}
            >
              <ChevronLeft size={22} strokeWidth={2.25} aria-hidden />
            </button>
          )}
          {varias && !enDemo && !sinCamara && (
            <button
              type="button"
              className="reco-volver reco-voltear"
              aria-label="Voltear cámara (frontal o trasera)"
              onClick={(e) => {
                e.stopPropagation();
                voltearCamara();
              }}
            >
              <SwitchCamera size={20} strokeWidth={2} aria-hidden />
            </button>
          )}
          <header className="absolute inset-x-0 top-0 z-[4] flex flex-col items-center px-6 pt-[max(1.1rem,env(safe-area-inset-top))] text-center">
            <Image src="/logo-blanco.png" alt="FA CUP Chile" width={235} height={50} priority className="mb-3 h-6 w-auto opacity-90 drop-shadow-[0_2px_8px_rgba(0,0,0,.45)]" />
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={arriba.titulo + arriba.sub}
                className="flex flex-col items-center gap-1.5"
                initial={{ opacity: 0, y: 6, filter: blur ? "blur(4px)" : "blur(0px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -4, filter: blur ? "blur(4px)" : "blur(0px)" }}
                transition={{ duration: 0.2 * T, ease: EASE }}
              >
                <h1 className="reco-texto max-w-[18ch] text-[clamp(1.5rem,7cqw,2.1rem)] font-semibold leading-[1.08] tracking-[-0.03em] text-white [text-wrap:balance]">
                  {arriba.titulo}
                </h1>
                <p className="reco-texto max-w-[30ch] text-[clamp(0.9rem,3.8cqw,1.05rem)] leading-snug text-white/80 [text-wrap:balance]">{arriba.sub}</p>
              </motion.div>
            </AnimatePresence>
          </header>

          {/* Abajo: porcentaje mientras se mantiene la posición, tarjeta de vidrio con el resultado, y la barra de vidrio */}
          <div className="absolute inset-x-0 bottom-0 z-[4] flex flex-col items-center gap-3 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <AnimatePresence mode="popLayout" initial={false}>
              {mostrarPorcentaje && (
                <motion.div
                  key="porcentaje"
                  className="flex flex-col items-center pb-1"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}
                  transition={{ duration: 0.25 * T, ease: EASE }}
                >
                  <p className="reco-texto tabular flex items-baseline text-[clamp(3.6rem,21cqw,5.8rem)] font-semibold leading-none tracking-[-0.05em] text-white">
                    <Porcentaje progreso={progreso} />
                    <span className="ml-1 text-[0.42em] font-medium tracking-normal text-white/80">%</span>
                  </p>
                  <p className="reco-texto mt-2 text-[clamp(0.9rem,3.8cqw,1.05rem)] font-medium text-white/85">
                    {fase === "enviando" ? "Verificando…" : "Reconociendo…"}
                  </p>
                </motion.div>
              )}
              {cartaTexto && (
                <motion.div
                  key={`carta${repetir}`}
                  className="relative w-full max-w-[460px] pt-7"
                  initial={{ opacity: 0, y: 24 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 14, transition: { duration: 0.25 } }}
                  transition={{ type: "spring", stiffness: 160, damping: 24, delay: (exito ? 0.4 : 0.1) * T }}
                >
                  <div className="absolute left-1/2 top-0 z-10 -translate-x-1/2">
                    <Insignia tipo={hayError && tono !== "aviso" ? "error" : tono === "aviso" ? "aviso" : sobrio ? "ya" : "exito"} lado={56} />
                  </div>
                  <Tarjeta texto={cartaTexto} tono={hayError ? "error" : tono} sobrio={sobrio} resultado={resultadoVisible} insignia />
                </motion.div>
              )}
            </AnimatePresence>

            {exito && !sobrio && (reporte || estadoReporte === "enviado") && (
              <div className="flex min-h-[44px] items-center justify-center" onClick={(e) => e.stopPropagation()}>
                {estadoReporte === "enviado" ? (
                  <p role="status" className="reco-texto text-[0.95rem] font-medium text-white/90">
                    Gracias, el staff lo revisará
                  </p>
                ) : estadoReporte === "limite" ? (
                  <p role="status" className="reco-texto text-[0.95rem] font-medium text-white/90">
                    Hay muchos avisos ahora. Avisa a tu entrenador.
                  </p>
                ) : (
                  <button type="button" className="reco-salir !min-h-[44px] !bg-white/10 !text-[0.9rem] !font-medium" disabled={estadoReporte === "enviando"} onClick={() => void avisarNoSoyYo()}>
                    {estadoReporte === "enviando" ? "Enviando…" : estadoReporte === "red" ? "Sin conexión, toca para reintentar" : "¿No eres tú?"}
                  </button>
                )}
              </div>
            )}
            {(sinCamara && !enDemo) && (
              <button type="button" className="reco-salir !min-h-[52px] !px-7 !bg-white/20" onClick={(e) => { e.stopPropagation(); reintentarCamara(); }}>
                Reintentar
              </button>
            )}
            {modoManual && !resultadoVisible && (
              <div className="flex items-center gap-2">
                <button type="button" className="reco-salir !min-h-[52px] !px-7 !bg-white/25" disabled={fase !== "escaneando"} onClick={(e) => { e.stopPropagation(); void tomarManual(); }}>
                  Tomar foto
                </button>
                <button type="button" className="reco-salir" onClick={(e) => { e.stopPropagation(); reintentarCamara(); }}>
                  Reintentar
                </button>
              </div>
            )}

            {/* Llegadas de hoy: texto suelto sobre la foto, sin barra */}
            <motion.p
              className="reco-texto flex items-center gap-2 pb-1 text-[0.95rem] font-medium text-white/80"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 200, damping: 26 }}
            >
              {hoyMostrado !== null ? (
                <>
                  <Rodillo valor={hoyMostrado} className="text-[1.5rem] font-semibold leading-none tracking-[-0.03em] text-white" />
                  <span className="whitespace-nowrap">{hoyMostrado === 1 ? "llegada hoy" : "llegadas hoy"}</span>
                </>
              ) : (
                <span className="text-white/60">Llegadas de hoy</span>
              )}
            </motion.p>
          </div>
        </div>
      </main>
    </MotionConfig>
  );
}
