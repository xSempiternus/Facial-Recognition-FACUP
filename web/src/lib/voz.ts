// Saludo en voz alta con la síntesis de voz del navegador (sin instalar nada).
// Prefiere voces latinoamericanas; en Windows se agregan en Configuración → Hora e idioma → Voz.
const PREFERIDAS = ["es-CL", "es-419", "es-MX", "es-US", "es-AR", "es-CO", "es-ES"];

export function hablar(texto: string) {
  const s = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!s) return;
  const decir = () => {
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
    u.rate = 1;
    u.pitch = 1.15;
    s.cancel();
    s.speak(u);
  };
  if (s.getVoices().length) decir();
  else s.addEventListener("voiceschanged", decir, { once: true });
}

/** iOS/Safari solo permite hablar tras un gesto del usuario: el primer toque desbloquea la síntesis con un enunciado vacío. */
export function desbloquearVoz() {
  const s = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!s) return;
  try {
    const u = new SpeechSynthesisUtterance("");
    u.volume = 0;
    s.speak(u);
  } catch {}
}
