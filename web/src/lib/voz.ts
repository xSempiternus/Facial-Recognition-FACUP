// Saludo en voz alta. Voz principal: neuronal es-CL generada por la API (/api/voz, cacheada en el servidor).
// Si falla (sin red, bloqueo de audio), cae a la síntesis de voz del navegador, y si tampoco, queda en silencio.

export type Frase = {
  texto: string; // respaldo para la voz del navegador
  tipo: "hola" | "de_nuevo" | "sin_cara" | "foto" | "no_reconocido";
  nombre?: string;
};

const PREFERIDAS = ["es-CL", "es-419", "es-MX", "es-US", "es-AR", "es-CO", "es-ES"];
// Mismo elemento <audio> siempre: iOS lo desbloquea una vez con un gesto y después deja reproducir sin tocar.
const SILENCIO =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
let reproductor: HTMLAudioElement | null = null;

function audio(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  reproductor ??= new Audio();
  return reproductor;
}

export function hablar(frase: Frase) {
  const el = audio();
  if (!el) return;
  const url = `/api/voz?tipo=${frase.tipo}${frase.nombre ? `&nombre=${encodeURIComponent(frase.nombre)}` : ""}`;
  let usoRespaldo = false;
  const respaldo = () => {
    if (usoRespaldo) return;
    usoRespaldo = true;
    hablarConNavegador(frase.texto);
  };
  try {
    el.pause();
    el.src = url;
    el.onerror = respaldo;
    const p = el.play();
    if (p) p.catch(respaldo);
  } catch {
    respaldo();
  }
}

function hablarConNavegador(texto: string) {
  const s = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!s) return;
  let dicho = false;
  const decir = () => {
    if (dicho) return;
    dicho = true;
    try {
      const u = new SpeechSynthesisUtterance(texto);
      const voces = s.getVoices();
      let voz: SpeechSynthesisVoice | undefined;
      for (const p of PREFERIDAS) {
        voz = voces.find((v) => v.lang.replace("_", "-") === p);
        if (voz) break;
      }
      voz ??= voces.find((v) => v.lang.toLowerCase().startsWith("es"));
      if (voz) u.voice = voz;
      u.lang = voz?.lang ?? "es-419";
      s.cancel();
      s.speak(u);
    } catch {
      // La voz es un extra: si el navegador la bloquea, el flujo sigue en silencio.
    }
  };
  if (s.getVoices().length) decir();
  else {
    s.addEventListener("voiceschanged", decir, { once: true });
    // iOS a veces nunca emite voiceschanged: se habla igual con la voz por defecto.
    setTimeout(decir, 700);
  }
}

/** iOS/Safari solo permite reproducir audio tras un gesto: el primer toque desbloquea el reproductor (y la síntesis). */
export function desbloquearVoz() {
  const el = audio();
  if (el) {
    try {
      el.src = SILENCIO;
      void el.play().catch(() => {});
    } catch {}
  }
  const s = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!s) return;
  try {
    const u = new SpeechSynthesisUtterance("");
    u.volume = 0;
    s.speak(u);
  } catch {}
}
