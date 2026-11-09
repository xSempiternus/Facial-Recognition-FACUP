"use client";

import { CircleHelp } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/staff-api";
import { sedeActual } from "@/lib/sede";

export type LadoTour = "arriba" | "abajo" | "izq" | "der" | "auto";

export interface PasoTour {
  /** Selector CSS del elemento a destacar. Sin selector (o si no existe) el paso es un modal centrado. */
  selector?: string;
  titulo: string;
  texto: string;
  lado?: LadoTour;
}

const PREFIJO = "facup:tour:";
const RETRASO_MS = 900;
const REINTENTO_MS = 1500;
const PAD = 8; // aire alrededor del objetivo
const GAP = 14; // distancia objetivo-popover
const MARGEN = 12; // margen al borde del viewport

// ------------------------------------------------------------------ estado compartido (Tour <-> useTour <-> BotonAyuda)
//
// Qué guías ya vio la sede vive en el SERVIDOR (/staff/preferencias): la URL del túnel cambia en cada arranque, y
// localStorage es por origen, así que solo con él todo reaparecía. localStorage queda como acelerador y como red de
// seguridad: lo que ya marcó ahí no se vuelve a mostrar aunque el servidor falle.

const abiertos = new Set<string>();
const vistos = new Set<string>(); // lo que sabemos visto (servidor + local)
let cargadas = false; // ya intentamos leer del servidor (con o sin éxito)
let cargando: Promise<void> | null = null;
let mostradoEnSesion = false; // nunca dos tours automáticos en la misma sesión
const oyentes = new Set<() => void>();
const emitir = () => {
  oyentes.forEach((f) => f());
};
const suscribir = (f: () => void) => {
  oyentes.add(f);
  return () => {
    oyentes.delete(f);
  };
};

const sede = () => sedeActual() ?? "_";
const claveLocal = (id: string) => `${PREFIJO}${sede()}:${id}`;

function vistoLocal(id: string): boolean {
  try {
    return localStorage.getItem(claveLocal(id)) === "1" || localStorage.getItem(PREFIJO + id) === "1";
  } catch {
    return false;
  }
}
function guardarLocal(id: string) {
  try {
    localStorage.setItem(claveLocal(id), "1");
  } catch {
    /* sin storage: la app sigue funcionando */
  }
}
function limpiarLocal() {
  try {
    const borrar: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIJO)) borrar.push(k);
    }
    borrar.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* nada que limpiar */
  }
}

function esVisto(id: string): boolean {
  return vistos.has(id) || vistoLocal(id);
}

/** Lee del servidor lo que la sede ya vio (una sola vez por carga de página). Si falla, vale lo local. */
export function cargarTours(): Promise<void> {
  if (cargadas) return Promise.resolve();
  cargando ??= api
    .preferencias()
    .then((r) => {
      r.tours_vistos.forEach((id) => {
        vistos.add(id);
        guardarLocal(id);
      });
    })
    .catch(() => {
      /* sin servidor: nos quedamos con lo que marcó localStorage */
    })
    .finally(() => {
      cargadas = true;
      cargando = null;
      emitir();
    });
  return cargando;
}

function marcarVisto(id: string) {
  if (esVisto(id) && vistos.has(id)) return;
  vistos.add(id);
  guardarLocal(id);
  emitir();
  api.marcarTour(id).catch(() => {
    /* el local ya lo recuerda; no molestamos al staff */
  });
}

/** "Volver a ver las guías": borra lo visto en el servidor y en este navegador. */
export async function reiniciarTours() {
  await api.reiniciarTours();
  vistos.clear();
  limpiarLocal();
  mostradoEnSesion = false;
  emitir();
}

/** ¿Hay un diálogo abierto o el usuario está escribiendo? Entonces no es momento de interrumpir. */
function ocupado(): boolean {
  if (document.querySelector("dialog[open]")) return true;
  const a = document.activeElement;
  if (!a || a === document.body) return false;
  return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement || (a as HTMLElement).isContentEditable;
}

/** Controla el tour de una pantalla: `abrir()` lo (re)inicia, `cerrar()` lo cierra y lo marca como visto. */
export function useTour(id: string) {
  const abierto = useSyncExternalStore(
    suscribir,
    () => abiertos.has(id),
    () => false,
  );
  // hasta saber qué vio la sede se considera visto: así no parpadea el punto de "nuevo"
  const visto = useSyncExternalStore(
    suscribir,
    () => !cargadas || esVisto(id),
    () => true,
  );
  const abrir = useCallback(() => {
    if (abiertos.size > 0) return; // un tour a la vez
    abiertos.add(id);
    mostradoEnSesion = true;
    emitir();
  }, [id]);
  const cerrar = useCallback(() => {
    marcarVisto(id);
    abiertos.delete(id);
    emitir();
  }, [id]);
  return { abrir, cerrar, abierto, visto };
}

/** Pistas inline descartables (PistaInline): comparten el registro de «visto» de los tours (por sede, servidor + local). */
export function usePistaVista(id: string) {
  const visto = useSyncExternalStore(
    suscribir,
    () => !cargadas || esVisto(id), // hasta saber qué vio la sede no se muestra: sin parpadeos
    () => true,
  );
  const descartar = useCallback(() => marcarVisto(id), [id]);
  return [visto, descartar] as const;
}

// ------------------------------------------------------------------ botón de ayuda

/** Abre la guía de la pantalla. Lleva un punto sutil de «nuevo» hasta que se abre por primera vez. */
export function BotonAyuda({ id, className }: { id: string; className?: string }) {
  const { abrir, visto } = useTour(id);
  return (
    <button
      type="button"
      className={className ? `s-tour-help ${className}` : "s-tour-help"}
      aria-label={visto ? "Ver guía de esta pantalla" : "Ver guía de esta pantalla (nueva)"}
      title="Ver guía de esta pantalla"
      onClick={() => {
        marcarVisto(id);
        abrir();
      }}
    >
      <CircleHelp size={18} aria-hidden />
      {!visto && <span className="s-tour-nuevo" aria-hidden />}
    </button>
  );
}

// ------------------------------------------------------------------ geometría

interface Caja {
  top: number;
  left: number;
  width: number;
  height: number;
}
interface Layout {
  foco: Caja | null;
  pop: { top: number; left: number } | null;
  lado: "arriba" | "abajo" | "izq" | "der" | "centro";
  movil: boolean;
  /** hueco inferior ocupado por el teclado en móvil */
  tecladoPx: number;
}

const esMovil = () => window.matchMedia("(max-width: 640px)").matches;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, Math.max(min, max)));

function buscar(sel: string | undefined): Element | null {
  if (!sel) return null;
  try {
    return document.querySelector(sel);
  } catch {
    return null;
  }
}

function calcular(sel: string | undefined, lado: LadoTour, pop: HTMLElement | null): Layout {
  const vv = window.visualViewport;
  const vw = window.innerWidth;
  const vh = vv ? vv.height : window.innerHeight;
  const tecladoPx = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  const movil = esMovil();
  const r = buscar(sel)?.getBoundingClientRect();
  if (!r || (r.width === 0 && r.height === 0)) {
    return { foco: null, pop: null, lado: "centro", movil, tecladoPx };
  }
  const foco: Caja = {
    top: r.top - PAD,
    left: r.left - PAD,
    width: r.width + PAD * 2,
    height: r.height + PAD * 2,
  };
  if (movil) return { foco, pop: null, lado: "abajo", movil, tecladoPx };

  const pw = pop?.offsetWidth ?? 340;
  const ph = pop?.offsetHeight ?? 180;
  const espacio = {
    abajo: vh - (foco.top + foco.height) - GAP - MARGEN,
    arriba: foco.top - GAP - MARGEN,
    der: vw - (foco.left + foco.width) - GAP - MARGEN,
    izq: foco.left - GAP - MARGEN,
  };
  type L = keyof typeof espacio;
  const cabe = (l: L) => (l === "arriba" || l === "abajo" ? espacio[l] >= ph : espacio[l] >= pw);
  let elegido: L;
  if (lado !== "auto" && cabe(lado)) elegido = lado;
  else {
    const orden: L[] = ["abajo", "arriba", "der", "izq"];
    elegido = orden.find(cabe) ?? [...orden].sort((a, b) => espacio[b] - espacio[a])[0];
  }
  let top: number;
  let left: number;
  if (elegido === "abajo" || elegido === "arriba") {
    top = elegido === "abajo" ? foco.top + foco.height + GAP : foco.top - GAP - ph;
    left = foco.left + foco.width / 2 - pw / 2;
  } else {
    left = elegido === "der" ? foco.left + foco.width + GAP : foco.left - GAP - pw;
    top = foco.top + foco.height / 2 - ph / 2;
  }
  return {
    foco,
    pop: { top: clamp(top, MARGEN, vh - ph - MARGEN), left: clamp(left, MARGEN, vw - pw - MARGEN) },
    lado: elegido,
    movil,
    tecladoPx,
  };
}

// ------------------------------------------------------------------ componente

const FOCUSABLES = "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

/**
 * `auto`: se abre solo UNA vez por sede (el tour de bienvenida). Las demás guías no arrancan solas: se abren con el «?».
 * Espera a saber qué vio la sede, no interrumpe si hay un diálogo abierto o se está escribiendo, y no se muestra
 * si ya hubo otro tour en esta sesión.
 */
export function Tour({ id, pasos, auto = false }: { id: string; pasos: PasoTour[]; auto?: boolean }) {
  const { abrir, cerrar, abierto } = useTour(id);
  const hayPasos = pasos.length > 0;

  useEffect(() => {
    if (!auto || !hayPasos) return;
    let vivo = true;
    let t = 0;
    const intentar = () => {
      if (!vivo) return;
      if (mostradoEnSesion || esVisto(id)) return;
      if (ocupado() || abiertos.size > 0 || document.visibilityState !== "visible") {
        t = window.setTimeout(intentar, REINTENTO_MS);
        return;
      }
      marcarVisto(id); // se marca al abrir: aunque recarguen a mitad, no vuelve
      abrir();
    };
    cargarTours().then(() => {
      if (vivo) t = window.setTimeout(intentar, RETRASO_MS);
    });
    return () => {
      vivo = false;
      window.clearTimeout(t);
    };
  }, [id, auto, hayPasos, abrir]);

  if (!abierto || !hayPasos) return null;
  return <TourAbierto id={id} pasos={pasos} cerrar={cerrar} />;
}

function TourAbierto({ id, pasos, cerrar }: { id: string; pasos: PasoTour[]; cerrar: () => void }) {
  const [i, setI] = useState(0);
  const [layout, setLayout] = useState<Layout>({ foco: null, pop: null, lado: "centro", movil: false, tecladoPx: 0 });
  const [host, setHost] = useState<Element | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const primarioRef = useRef<HTMLButtonElement>(null);
  const previo = useRef<HTMLElement | null>(null);
  const uid = useId();
  const tituloId = `${uid}-t`;
  const textoId = `${uid}-d`;
  const paso = pasos[Math.min(i, pasos.length - 1)];
  const ultimo = i >= pasos.length - 1;

  // montar dentro de .staff para heredar tokens claro/oscuro; devolver el foco al cerrar
  useLayoutEffect(() => {
    previo.current = document.activeElement as HTMLElement | null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHost(document.querySelector(".staff") ?? document.body);
    return () => {
      const p = previo.current;
      if (p && document.contains(p)) p.focus({ preventScroll: true });
    };
  }, []);

  const medir = useCallback(() => {
    setLayout(calcular(paso.selector, paso.lado ?? "auto", popRef.current));
  }, [paso]);

  // scroll suave al objetivo y primera medición; el foco va al botón primario
  useLayoutEffect(() => {
    if (!host) return;
    const reducido = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    buscar(paso.selector)?.scrollIntoView({
      block: esMovil() ? "start" : "center",
      inline: "nearest",
      behavior: reducido ? "auto" : "smooth",
    });
    medir();
    primarioRef.current?.focus({ preventScroll: true });
  }, [host, paso, medir]);

  // recalcular en resize / scroll / cambios de layout
  useEffect(() => {
    if (!host) return;
    let raf = 0;
    const pedir = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(medir);
    };
    window.addEventListener("resize", pedir);
    window.addEventListener("scroll", pedir, true);
    window.visualViewport?.addEventListener("resize", pedir);
    window.visualViewport?.addEventListener("scroll", pedir);
    const ro = new ResizeObserver(pedir);
    ro.observe(document.body);
    if (popRef.current) ro.observe(popRef.current);
    const el = buscar(paso.selector);
    if (el) ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", pedir);
      window.removeEventListener("scroll", pedir, true);
      window.visualViewport?.removeEventListener("resize", pedir);
      window.visualViewport?.removeEventListener("scroll", pedir);
      ro.disconnect();
    };
  }, [host, paso, medir]);

  const siguiente = useCallback(() => {
    if (ultimo) cerrar();
    else setI((n) => n + 1);
  }, [ultimo, cerrar]);
  const anterior = useCallback(() => setI((n) => Math.max(0, n - 1)), []);

  // teclado: Esc cierra, flechas navegan, Enter avanza (si no hay un botón enfocado), Tab atrapado
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cerrar();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        siguiente();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        anterior();
      } else if (e.key === "Enter" && !(document.activeElement instanceof HTMLButtonElement)) {
        e.preventDefault();
        siguiente();
      } else if (e.key === "Tab") {
        const pop = popRef.current;
        if (!pop) return;
        const lista = Array.from(pop.querySelectorAll<HTMLElement>(FOCUSABLES));
        if (lista.length === 0) return;
        const a = document.activeElement;
        if (!pop.contains(a)) {
          e.preventDefault();
          lista[0].focus();
        } else if (e.shiftKey && a === lista[0]) {
          e.preventDefault();
          lista[lista.length - 1].focus();
        } else if (!e.shiftKey && a === lista[lista.length - 1]) {
          e.preventDefault();
          lista[0].focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [cerrar, siguiente, anterior]);

  if (!host) return null;

  const { foco, pop, lado, movil, tecladoPx } = layout;
  const estiloPop: CSSProperties = movil
    ? { bottom: `calc(${tecladoPx}px + max(12px, env(safe-area-inset-bottom)))` }
    : pop
      ? { top: pop.top, left: pop.left }
      : {};

  return createPortal(
    <div className="s-tour" data-tour-id={id}>
      {/* captura clics fuera para no tocar la pantalla mientras dura la guía */}
      <div className="s-tour-capa" />
      {foco ? (
        <div
          className="s-tour-foco"
          style={{ top: foco.top, left: foco.left, width: foco.width, height: foco.height }}
          aria-hidden
        />
      ) : (
        <div className="s-tour-velo" aria-hidden />
      )}
      <div
        ref={popRef}
        className="s-tour-pop"
        data-lado={lado}
        data-centro={foco ? undefined : ""}
        style={estiloPop}
        role="dialog"
        aria-modal="true"
        aria-labelledby={tituloId}
        aria-describedby={textoId}
      >
        <div className="s-tour-top">
          <span className="s-tour-count" aria-live="polite" aria-atomic="true">
            {i + 1} de {pasos.length}
          </span>
          <div className="s-tour-dots" aria-hidden>
            {pasos.map((_, n) => (
              <span key={n} data-on={n === i ? "" : undefined} data-done={n < i ? "" : undefined} />
            ))}
          </div>
        </div>
        <div key={i} className="s-tour-body">
          <h2 id={tituloId} className="s-tour-titulo">
            {paso.titulo}
          </h2>
          <p id={textoId} className="s-tour-texto">
            {paso.texto}
          </p>
        </div>
        <div className="s-tour-acciones">
          {!ultimo && (
            <button type="button" className="s-tour-btn s-tour-btn-ghost" onClick={cerrar}>
              Omitir
            </button>
          )}
          <span className="s-tour-espacio" />
          {i > 0 && (
            <button type="button" className="s-tour-btn" onClick={anterior}>
              Anterior
            </button>
          )}
          <button ref={primarioRef} type="button" className="s-tour-btn s-tour-btn-primary" onClick={siguiente}>
            {ultimo ? "Entendido" : "Siguiente"}
          </button>
        </div>
      </div>
    </div>,
    host,
  );
}
