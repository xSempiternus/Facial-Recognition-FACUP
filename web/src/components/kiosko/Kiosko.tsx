"use client";

// Pantalla de reconocimiento FA CUP Chile, a pantalla completa (estilo Face ID): la cámara ocupa todo el teléfono y
// encima van el título (guía de postura en texto vivo), cuatro esquinas que encuadran la cara y la siguen, puntitos de
// referencia, un arco fino que se completa al quedarse quieto, un aviso de luz y las llegadas de hoy. Al capturar, el
// fotograma se congela con un destello suave y el marco respira ("Reconociendo…"). Al reconocer, la foto se congela
// nítida, las esquinas se cierran en verde y una tarjeta de vidrio muestra el nombre. Sin botones para registrar:
// al quedarse quieto, la foto se saca sola. En escritorio / horizontal la cámara vive en un escenario vertical (~3:4).

import { AnimatePresence, motion, MotionConfig, useMotionValue } from "motion/react";
import { ChevronLeft, Sun, SwitchCamera } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { abrirCamara, contarCamaras, facingInicial, guardarFacing, type Facing } from "@/lib/camara";
import { iniciarSonidos, sonar } from "@/lib/sonidos";
import { usePantallaActiva } from "@/lib/pantalla-activa";
import { desbloquearVoz, hablar, type Frase } from "@/lib/voz";
import { avisarEntrenador, descartarAviso, llegadasDeHoy, noSoyYo, precalentar, verificar, type TipoAviso, type Verificacion } from "@/lib/api";
import { calidadActual, iniciarCalidad, restriccionesCamara, useCalidad } from "./calidad";
import Aurora, { type ModoAurora } from "./Aurora";
import BotonSonido from "./BotonSonido";
import Insignia from "./Insignia";
import { useLuz } from "./luz";
import Marco, { type Guia, type ModoMarco } from "./Marco";
import { crearRastro, PUNTOS_REF, type Rastro } from "./rastro";
import Rodillo from "./Rodillo";
import Tarjeta, { type TextoTarjeta } from "./Tarjeta";
import { k } from "./tiempo";
import { capturarFoto, useRastreoCara, type Desvio, type Objetivo, type Postura } from "./useRastreoCara";

const MOSTRAR_RESULTADO_MS = 2500; // éxito sin botón "¿No eres tú?" (p. ej. backend viejo)
const YA_REGISTRADO_MS = 1800; // "ya registrado": sobrio y corto
const VENTANA_NO_ERES_TU_MS = 4000; // éxito nuevo con "¿No eres tú?" visible: el resultado dura al menos esto, para que el botón no desaparezca antes
const AVISO_MS = 4200; // avisos leves (sin cara, foto, sin conexión) y errores: hay que poder leerlos
const GRACIAS_MS = 2800; // tras "¿No eres tú?", el mensaje de gracias queda visible este tiempo
const AYUDA_CONFIRMADA_MS = 3500; // "Listo, un entrenador te ayudará": queda visible este tiempo y se vuelve a escanear
const ABANDONO_MS = 20_000; // "No te reconocimos" sin tocar nada: se envía aviso "abandono" y se vuelve al flujo normal
const ESPERA_MISMO_NIÑO_MS = 4000; // tras un resultado, no vuelve a escanear a quien sigue frente a la cámara: 4 s o hasta que salga del encuadre
const EASE = [0.22, 1, 0.36, 1] as const;
const ESCRITORIO_DESDE = 900; // ancho (px) desde el que la cámara va en un escenario centrado

type Resultado = TextoTarjeta & {
  tono: "exito" | "aviso" | "error";
  sobrio?: boolean; // "ya registrado"
  noReconocido?: boolean; // pantalla "No te reconocimos" (con acciones)
  aviso?: string; // referencia del backend para avisar/descartar; sin ella (backend viejo) solo hay "Reintentar"
};

// Saludos de jugador: uno por llegada, para que no suene siempre igual.
const ANIMOS = ["¡A la cancha!", "¡Hoy se juega!", "¡A jugar!", "¡Con todo hoy!", "¡Vamos equipo!"];
const animo = () => ANIMOS[Math.floor(Math.random() * ANIMOS.length)];

const GUIA: Record<Postura, { titulo: string; sub: string }> = {
  "sin-cara": { titulo: "Párate frente a la pantalla", sub: "Mira a la cámara, sin prisa" },
  lejos: { titulo: "Acércate un poco", sub: "Llena el marco con tu cara" },
  cerca: { titulo: "Aléjate un poco", sub: "Estás muy cerca de la cámara" },
  descentrado: { titulo: "Centra tu cara", sub: "Ponla dentro del marco" },
  quieto: { titulo: "Quédate quieto", sub: "Ya casi" },
};
// Cuando la cara está descentrada, el texto dice hacia dónde moverse (la imagen está en espejo con la cámara frontal).
const GUIA_DESVIO: Record<Desvio, { titulo: string; sub: string }> = {
  arriba: { titulo: "Baja un poco la mirada", sub: "Tu cara está muy arriba" },
  abajo: { titulo: "Sube un poco la mirada", sub: "Tu cara está muy abajo" },
  izq: { titulo: "Centra tu cara", sub: "Muévete un poco a la derecha" },
  der: { titulo: "Centra tu cara", sub: "Muévete un poco a la izquierda" },
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
      // Dudoso: se parece a alguien pero no con certeza. Nunca "No te reconocimos" ni nombre; sin voz (no hay frase propia).
      if (v.dudoso) return { resultado: { tono: "aviso", noReconocido: true, aviso: v.aviso, titulo: "Un entrenador lo confirmará", sub: "Avisa a tu entrenador o intenta de nuevo" }, frase: null };
      return { resultado: { tono: "aviso", noReconocido: true, aviso: v.aviso, titulo: "No te reconocimos", sub: v.aviso ? "Puedes intentarlo otra vez o pedir ayuda" : "Intenta de nuevo o avisa a tu entrenador" }, frase: { texto: "No te reconocimos. Intenta de nuevo o avisa a tu entrenador.", tipo: "no_reconocido" } };
    case "sin_conexion":
      return { resultado: { tono: "aviso", titulo: "Sin conexión", sub: "Revisa tu internet e intenta de nuevo" }, frase: null };
    case "sin_jugadores":
      return { resultado: { tono: "error", titulo: "Aún no hay jugadores inscritos", sub: "El staff debe inscribirlos primero" }, frase: null };
    default:
      return { resultado: { tono: "error", titulo: "Sistema no disponible", sub: "Avisa al staff" }, frase: null };
  }
}

// Vista previa de estados para diseño/QA: ?demo=buscando|alinear|lejos|escaneando|verificando|pocaluz|contraluz|reconocido|ya|fallo|noreconoce|sinrostro|error|camara|denegada.
// Solo existe fuera de producción; en producción el parámetro se ignora.
const suscribirNada = () => () => {};
const demoActual = () => (process.env.NODE_ENV === "production" ? "" : new URLSearchParams(window.location.search).get("demo") ?? "");
function useDemo() {
  return useSyncExternalStore(suscribirNada, demoActual, () => "");
}
const DEMO_VERIFICACION: Record<string, Verificacion> = {
  reconocido: { ok: true, nombre: "Matías Soto", categoria: "Sub-10", yaRegistrado: false, registradoALas: null, similitud: 0.9 },
  ya: { ok: true, nombre: "Matías Soto", categoria: "Sub-10", yaRegistrado: true, registradoALas: "2026-10-28T09:12:00", similitud: 0.9 },
  fallo: { ok: false, codigo: "no_reconocido", mensaje: "", aviso: "demo" }, // con acciones de ayuda
  noreconoce: { ok: false, codigo: "no_reconocido", mensaje: "" }, // backend viejo: solo Reintentar
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
const DEMO_SIN_CARA = new Set(["buscando", "error", "camara", "denegada"]);

export default function Kiosko({ onSalir }: { onSalir?: () => void }) {
  usePantallaActiva(true); // la pantalla no se apaga mientras el kiosko esté abierto
  const demo = useDemo();
  const enDemo = demo !== "";
  const video = useRef<HTMLVideoElement>(null);
  const escenario = useRef<HTMLDivElement>(null);
  const progreso = useMotionValue(0);
  const alineacion = useMotionValue(0);
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
  const [ayuda, setAyuda] = useState<"libre" | "enviando" | "entrenador" | "nuevo" | "limite" | "red">("libre"); // "No te reconocimos"
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
  const alCapturando = useCallback(() => {
    setFotoUrl(null); // la del intento anterior ya no sirve: se congela el fotograma nuevo apenas esté listo
    setFase("enviando");
  }, []);
  const alFallarCaptura = useCallback(() => setFase("escaneando"), []);
  const [reintentandoRed, setReintentandoRed] = useState(false);
  const alCapturar = useCallback(async (foto: Blob) => {
    pendiente.current?.abort();
    const ctl = (pendiente.current = new AbortController());
    setReintentandoRed(false);
    setFotoUrl(URL.createObjectURL(foto)); // el fotograma queda congelado mientras se verifica
    const v = await verificar(foto, ctl.signal, () => {
      if (pendiente.current === ctl) setReintentandoRed(true);
    });
    if (pendiente.current !== ctl) return; // cancelada o reemplazada
    setReintentandoRed(false);
    const { resultado, frase } = aResultado(v);
    // El contador sube cuando la secuencia de éxito avanza: el rodillo se ve, no pasa de golpe.
    if (v.ok && !v.yaRegistrado) {
      clearTimeout(subeContador.current);
      subeContador.current = setTimeout(() => setHoy((n) => (n === null ? n : n + 1)), 900 * k());
    }
    setReporte(v.ok && !v.yaRegistrado ? (v.reporte ?? null) : null);
    setEstadoReporte("libre");
    setAyuda("libre");
    setResultado(resultado);
    setFase("resultado");
    if (frase && voz.current) hablar(frase);
  }, []);

  const { listo: listoReal, error: errorModeloReal, postura: posturaReal, desvio: desvioReal } = useRastreoCara({
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
    alineacion,
  });

  // Vista previa (solo desarrollo): fuerza fase/resultado/postura sin cámara.
  const demoResultado = useMemo(() => (demo && DEMO_VERIFICACION[demo] ? aResultado(DEMO_VERIFICACION[demo]).resultado : null), [demo]);
  const fase = demoResultado ? "resultado" : demo === "verificando" ? "enviando" : faseReal;
  const resultado = demoResultado ?? resultadoReal;
  const listo = enDemo || listoReal;
  const errorModelo = enDemo ? null : errorModeloReal;
  const postura: Postura = demo === "escaneando" ? "quieto" : demo === "buscando" ? "sin-cara" : demo === "alinear" || demo === "pocaluz" || demo === "contraluz" ? "descentrado" : demo === "lejos" ? "lejos" : enDemo ? "quieto" : posturaReal;
  const desvio: Desvio | null = enDemo ? (demo === "alinear" ? "der" : null) : desvioReal;
  useEffect(() => {
    if (!enDemo) return;
    progreso.set(demo === "escaneando" ? 0.62 : demo === "verificando" ? 1 : 0);
    alineacion.set(demo === "buscando" ? 0 : demo === "alinear" || demo === "lejos" || demo === "pocaluz" || demo === "contraluz" ? 0.35 : 1);
  }, [enDemo, demo, progreso, alineacion]);

  // El texto de postura espera ~250 ms de estabilidad antes de cambiar: sin parpadeo cuando la detección oscila.
  const [guiaVista, setGuiaVista] = useState<{ postura: Postura; desvio: Desvio | null }>({ postura: "sin-cara", desvio: null });
  useEffect(() => {
    const d = postura === "descentrado" ? desvio : null;
    const id = setTimeout(() => setGuiaVista({ postura, desvio: d }), 250);
    return () => clearTimeout(id);
  }, [postura, desvio]);

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
  // `ahora`: reintento manual, escanea al instante (sin esperar a que el niño salga del encuadre).
  const terminarResultado = useCallback((ahora = false) => {
    setResultado(null);
    setReporte(null);
    setEstadoReporte("libre");
    setAyuda("libre");
    setFase("escaneando");
    setEsperarSalida(!ahora);
  }, []);
  const avisoActual = resultado?.aviso;
  useEffect(() => {
    // Mientras se envía un aviso el resultado se queda; luego el mensaje de gracias / ayuda dura un rato y se sigue.
    if (enDemo || fase !== "resultado" || prueba.current || estadoReporte === "enviando" || ayuda === "enviando") return;
    const r = resultadoReal;
    const confirmada = ayuda === "entrenador" || ayuda === "nuevo" || ayuda === "limite";
    let ms: number;
    if (confirmada) ms = AYUDA_CONFIRMADA_MS;
    else if (r?.noReconocido) ms = ABANDONO_MS;
    else if (r?.tono === "exito") {
      if (estadoReporte === "enviado" || estadoReporte === "limite") ms = GRACIAS_MS;
      else if (r.sobrio) ms = YA_REGISTRADO_MS;
      else ms = reporte ? VENTANA_NO_ERES_TU_MS : MOSTRAR_RESULTADO_MS;
    } else ms = AVISO_MS;
    const id = setTimeout(() => {
      // Sin tocar nada en "No te reconocimos": el staff recibe un aviso "abandono" (sin nombre) y el kiosko sigue.
      if (!confirmada && r?.noReconocido && avisoActual && !enDemo) void avisarEntrenador(avisoActual, "abandono");
      terminarResultado();
    }, ms);
    return () => clearTimeout(id);
  }, [fase, terminarResultado, estadoReporte, ayuda, resultadoReal, reporte, avisoActual, enDemo]);

  // "Reintentar": reinicia el escaneo al instante y descarta el aviso pendiente.
  const reintentarAhora = useCallback(() => {
    if (avisoActual && !enDemo) descartarAviso(avisoActual);
    terminarResultado(true);
  }, [avisoActual, enDemo, terminarResultado]);
  // "Avisar a mi entrenador" / "Soy nuevo": crea el pendiente para el staff (nunca registra asistencia).
  const pedirAyuda = useCallback(
    async (tipo: Exclude<TipoAviso, "abandono">) => {
      if (!avisoActual || ayuda === "enviando") return;
      setAyuda("enviando");
      const r = enDemo ? "ok" : await avisarEntrenador(avisoActual, tipo);
      if (r === "ok") {
        setAyuda(tipo);
        sonar("aviso");
      } else setAyuda(r === "limite" ? "limite" : "red");
    },
    [avisoActual, ayuda, enDemo],
  );

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
  // Espera tras un resultado: termina al salir del encuadre o a los ESPERA_MISMO_NIÑO_MS, lo que ocurra primero
  // (el plazo corre una sola vez: los cambios de postura ya no lo reinician).
  const salioDelEncuadre = postura === "sin-cara";
  const inicioEspera = useRef(0);
  useEffect(() => {
    if (!esperarSalida) return;
    if (!inicioEspera.current) inicioEspera.current = performance.now();
    const resta = salioDelEncuadre ? 0 : Math.max(0, ESPERA_MISMO_NIÑO_MS - (performance.now() - inicioEspera.current));
    const id = setTimeout(() => setEsperarSalida(false), resta);
    return () => clearTimeout(id);
  }, [esperarSalida, salioDelEncuadre]);
  useEffect(() => {
    if (!esperarSalida) inicioEspera.current = 0;
  }, [esperarSalida]);

  const sinCamara = enDemo ? demo === "camara" || demo === "denegada" : Boolean(errorCamara);
  const camaraDenegada = enDemo ? demo === "denegada" : Boolean(errorCamara?.startsWith("Permiso de cámara denegado"));
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
    setFotoUrl(null);
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

  // Sonidos de la secuencia: cara detectada -> resultado (sin sonido de escaneo ni de captura).
  const anterior = useRef<{ postura: Postura; fase: string }>({ postura: "sin-cara", fase: "escaneando" });
  useEffect(() => {
    const a = anterior.current;
    if (fase === "escaneando" && a.postura === "sin-cara" && postura !== "sin-cara") sonar("rostro");

    anterior.current = { postura, fase };
  }, [postura, fase]);
  useEffect(() => {
    if (!resultadoVisible) return;
    sonar(exito ? (sobrio ? "ya" : "exito") : tono === "aviso" ? "aviso" : "error");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- suena una vez por resultado nuevo
  }, [resultado, resultadoVisible]);

  // Texto de arriba (guía) y tarjeta de abajo (resultado).
  const ayudaConfirmada = ayuda === "entrenador" || ayuda === "nuevo";
  const ayudaTexto: TextoTarjeta | null =
    ayuda === "entrenador"
      ? { titulo: "Listo, un entrenador te ayudará", sub: "Puedes esperar aquí cerca" }
      : ayuda === "nuevo"
        ? { titulo: "Un entrenador te ayudará a inscribirte", sub: "Puedes esperar aquí cerca" }
        : ayuda === "limite"
          ? { titulo: "Hay muchos avisos ahora", sub: "Avisa a tu entrenador" }
          : ayuda === "red"
            ? { titulo: "No pudimos avisar", sub: "Toca otra vez o avisa a tu entrenador" }
            : null;
  const cartaTexto: TextoTarjeta | null = sinCamara
    ? camaraDenegada
      ? { titulo: "Cámara bloqueada", sub: "Permite el acceso a la cámara en los ajustes del navegador y toca Reintentar." }
      : { titulo: "Cámara no disponible", sub: errorCamara ?? "Revisa la cámara y toca Reintentar." }
    : resultadoVisible
      ? (ayudaTexto ?? resultado)
      : null;
  let arriba: { titulo: string; sub: string };
  if (sinCamara) arriba = camaraDenegada ? { titulo: "Activa la cámara", sub: "Necesitamos verte para registrar tu llegada" } : { titulo: "Hay un problema", sub: "Avisa al staff" };
  else if (resultadoVisible && tono === "error") arriba = { titulo: "Hay un problema", sub: "Avisa al staff" };
  else if (resultadoVisible && ayudaConfirmada) arriba = { titulo: "Aviso enviado", sub: "Ya lo sabe el staff" };
  else if (resultadoVisible && tono === "aviso") arriba = { titulo: "Intenta de nuevo", sub: "Mira de frente, con buena luz" };
  else if (exito) arriba = sobrio ? { titulo: "Ya estabas registrado", sub: "Tu llegada de hoy ya estaba lista" } : { titulo: "¡Llegada registrada!", sub: "Bienvenido a FA CUP" };
  else if (reintentandoRed && fase === "enviando") arriba = { titulo: "Sin conexión, reintentando…", sub: "No te muevas" };
  else if (fase === "enviando") arriba = { titulo: "Reconociendo…", sub: "Un momento" };
  else if (modoManual) arriba = { titulo: "Toma tu foto", sub: "Pon tu cara en el marco y toca el botón" };
  else if (!enDemo && !camaraLista) arriba = { titulo: "Permite la cámara para continuar", sub: "Acepta el aviso del navegador" };
  else if (!listo) arriba = { titulo: "Preparando la cámara", sub: cargaLenta ? "Conexión lenta, cargando…" : "Un momento" };
  else if (esperarSalida && postura !== "sin-cara") arriba = { titulo: "Listo", sub: "Puede pasar el siguiente" };
  else arriba = guiaVista.desvio ? GUIA_DESVIO[guiaVista.desvio] : GUIA[guiaVista.postura];

  // Luz: con el rastreo activo se mide cada 500 ms; en demo se simula con ?demo=pocaluz|contraluz.
  const luzReal = useLuz(video, rastro, faseReal === "escaneando" && !esperarSalida && listoReal && !enDemo);
  const luz = enDemo ? (demo === "pocaluz" ? "poca" : demo === "contraluz" ? "contraluz" : "ok") : luzReal;
  const avisoLuz = !sinCamara && !resultadoVisible && fase !== "enviando" && luz !== "ok" ? luz : null;
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
  const congelando = fase === "enviando" && (enDemo || Boolean(fotoUrl)); // fotograma congelado mientras se verifica
  const mostrarFoto = congelando || (resultadoVisible && tono !== "error" && (enDemo ? demo !== "error" : Boolean(fotoUrl)));
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
          else if (enDemo) {
            setAyuda("libre");
            setRepetir((n) => n + 1);
          }
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
                  initial={{ scale: 1.02 }}
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

          {/* Destello blanco muy sutil (~200 ms) al capturar: el fotograma queda congelado debajo */}
          {fase === "enviando" && (
            <motion.div
              key={`captura${repetir}`}
              className="pointer-events-none absolute inset-0 z-[2] bg-white"
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 0.2, 0] }}
              transition={{ duration: 0.2 * T, times: [0, 0.3, 1], ease: "easeOut" }}
            />
          )}

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
          <Marco key={`marco${repetir}`} rastro={rastro} modo={modoMarco} guia={guia} ancho={sw} alto={sh} progreso={progreso} alineacion={alineacion} />

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
          <BotonSonido />
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
          <header className="absolute inset-x-0 top-0 z-[4] flex flex-col items-center px-16 pt-[max(0.9rem,env(safe-area-inset-top))] text-center">
            {/* Misma altura (44 px) y línea que los botones de volver / voltear: el logo queda centrado con ellos */}
            <div className="mb-2 flex h-11 items-center">
              <Image src="/logo-blanco.png" alt="FA CUP Chile" width={235} height={50} priority className="h-6 w-auto opacity-90 drop-shadow-[0_2px_8px_rgba(0,0,0,.45)]" />
            </div>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={arriba.titulo + arriba.sub}
                className="flex flex-col items-center gap-1.5"
                initial={{ opacity: 0, y: 6, filter: blur ? "blur(4px)" : "blur(0px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -4, filter: blur ? "blur(4px)" : "blur(0px)" }}
                transition={{ duration: 0.2 * T, ease: EASE }}
              >
                <h1 className="reco-texto max-w-[24ch] text-[clamp(1.35rem,6.4cqw,2rem)] font-semibold leading-[1.08] tracking-[-0.03em] text-white [text-wrap:balance]">
                  {arriba.titulo}
                </h1>
                <p className="reco-texto max-w-[30ch] text-[clamp(0.9rem,3.8cqw,1.05rem)] leading-snug text-white/80 [text-wrap:balance]">{arriba.sub}</p>
              </motion.div>
            </AnimatePresence>
          </header>

          {/* Abajo: tarjeta de vidrio con el resultado y el contador de llegadas */}
          <div className="absolute inset-x-0 bottom-0 z-[4] flex flex-col items-center gap-3 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <AnimatePresence mode="popLayout" initial={false}>
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
                    <Insignia tipo={ayudaConfirmada ? "ya" : hayError && tono !== "aviso" ? "error" : tono === "aviso" ? "aviso" : sobrio ? "ya" : "exito"} lado={56} />
                  </div>
                  <Tarjeta texto={cartaTexto} tono={hayError ? "error" : ayudaConfirmada ? "exito" : tono} sobrio={sobrio || ayudaConfirmada} resultado={resultadoVisible} insignia />
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
            {/* "No te reconocimos" y avisos leves: acciones grandes. Alto fijo: la confirmación no mueve nada. */}
            {resultadoVisible && resultado?.tono === "aviso" && !sinCamara && (
              <div
                className="reco-fallo"
                data-solo={resultado.noReconocido && resultado.aviso ? undefined : ""}
                inert={ayudaConfirmada || ayuda === "limite" ? true : undefined}
                aria-hidden={ayudaConfirmada || ayuda === "limite" ? true : undefined}
                onClick={(e) => e.stopPropagation()}
              >
                <button type="button" className="reco-fallo-principal" onClick={reintentarAhora}>
                  Reintentar
                </button>
                {resultado.noReconocido && resultado.aviso && (
                  <div className="reco-fallo-sec">
                    <button type="button" className="reco-fallo-btn" disabled={ayuda === "enviando"} onClick={() => void pedirAyuda("entrenador")}>
                      {ayuda === "enviando" ? "Avisando…" : "Avisar a mi entrenador"}
                    </button>
                    <button type="button" className="reco-fallo-btn" disabled={ayuda === "enviando"} onClick={() => void pedirAyuda("nuevo")}>
                      Soy nuevo
                    </button>
                  </div>
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

            {/* Llegadas de hoy: una línea discreta de alto fijo (no se mueve al cargar ni al subir el número) */}
            <motion.p
              className="reco-texto flex h-8 items-center gap-1.5 whitespace-nowrap text-[0.95rem] font-medium text-white/80"
              initial={{ opacity: 0 }}
              animate={{ opacity: hoyMostrado !== null ? 1 : 0 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              aria-live="polite"
            >
              <span>{hoyMostrado === 1 ? "Ya va" : "Ya van"}</span>
              <Rodillo valor={hoyMostrado ?? 0} className="text-[1.4rem] font-semibold leading-none tracking-[-0.03em] text-white" />
              <span>hoy</span>
            </motion.p>

            {/* Aviso de luz: discreto, fuera del flujo (no empuja nada), con fundido suave */}
            <div className="pointer-events-none absolute inset-x-0 bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+3.2rem)] flex justify-center px-6">
              <AnimatePresence mode="wait">
                {avisoLuz && (
                  <motion.p
                    key={avisoLuz}
                    role="status"
                    className="reco-aviso-luz"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4, transition: { duration: 0.2 } }}
                    transition={{ duration: 0.3 * T, ease: EASE }}
                  >
                    <Sun size={16} strokeWidth={2} aria-hidden />
                    {avisoLuz === "poca" ? "Hay poca luz, busca un lugar más claro" : "Evita la luz de frente a la cámara"}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </main>
    </MotionConfig>
  );
}
