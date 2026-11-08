// Sonidos de interfaz (Kenney "Interface Sounds", licencia CC0) con Web Audio: baja latencia y volumen controlado.
// Los archivos viven en /public/sonidos/<evento>.mp3. iOS exige crear el contexto dentro de un gesto del usuario:
// iniciarSonidos() se llama en el primer toque. ?sonido=0 los apaga; ?sonido=1 los enciende de nuevo.

export type Evento =
  | "tap" // toque de un botón
  | "abrir" // sube una hoja o panel
  | "volver" // cerrar / volver
  | "rostro" // aparece una cara en cámara (tono sintetizado, suave)
  | "exito" // llegada registrada
  | "ya" // ya estaba registrado
  | "aviso" // no se reconoció, reintentar
  | "error"; // fallo del sistema

const VOLUMEN: Record<Evento, number> = {
  tap: 0.5, abrir: 0.7, volver: 0.6, rostro: 0.55, exito: 0.9, ya: 0.7, aviso: 0.7, error: 0.7,
};
const EVENTOS = Object.keys(VOLUMEN) as Evento[];
const CLAVE = "facup-sonido";

let ctx: AudioContext | null = null;
let ganancia: GainNode | null = null;
const buffers = new Map<Evento, AudioBuffer>();
let cargando = false;
let silenciado: boolean | null = null;

function estaSilenciado(): boolean {
  if (silenciado !== null) return silenciado;
  try {
    const q = new URLSearchParams(window.location.search).get("sonido");
    if (q === "0") localStorage.setItem(CLAVE, "0");
    else if (q === "1") localStorage.removeItem(CLAVE);
    silenciado = localStorage.getItem(CLAVE) === "0";
  } catch {
    silenciado = false;
  }
  return silenciado;
}

async function cargar() {
  if (cargando || !ctx) return;
  cargando = true;
  const c = ctx;
  await Promise.all(
    EVENTOS.map(async (ev) => {
      try {
        const r = await fetch(`/sonidos/${ev}.mp3`);
        if (!r.ok) return;
        buffers.set(ev, await c.decodeAudioData(await r.arrayBuffer()));
      } catch {
        // un sonido que no carga no debe afectar nada más
      }
    }),
  );
}

/** Llamar dentro de un gesto del usuario (toque/clic). Crea el contexto de audio y precarga los sonidos. */
export function iniciarSonidos() {
  if (typeof window === "undefined" || estaSilenciado()) return;
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
      ganancia = ctx.createGain();
      ganancia.gain.value = 0.9;
      ganancia.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
    void cargar();
  } catch {
    // sin audio: el flujo sigue en silencio
  }
}

export function sonar(ev: Evento) {
  if (!ctx || !ganancia || estaSilenciado()) return;
  const buf = buffers.get(ev);
  if (!buf) return;
  try {
    if (ctx.state === "suspended") void ctx.resume();
    const fuente = ctx.createBufferSource();
    fuente.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = VOLUMEN[ev];
    fuente.connect(g).connect(ganancia);
    fuente.start();
  } catch {
    // ignorar
  }
}
