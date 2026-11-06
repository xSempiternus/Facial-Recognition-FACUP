"use client";

// Pre-menú de la app: foto cinematográfica con movimiento 3D de fondo, sin tarjeta, y dos accesos.
//  - REGISTRAR ASISTENCIA -> /asistencia (reconocimiento facial). El toque desbloquea la voz y calienta la API.
//  - SOY ADMIN -> si hay sesión válida entra a /staff; si no, sube una hoja con la clave sobre la misma
//    pantalla (misma foto, mismo logo): sin cambio de ruta, así la entrada es continua.

import {
  AnimatePresence,
  MotionConfig,
  motion,
  useMotionValue,
  type Variants,
} from "motion/react";
import { ArrowLeft, Loader2, Lock, ScanFace, ShieldCheck } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { precalentar } from "@/lib/api";
import { ApiError, iniciarSesion, leerToken } from "@/lib/staff-api";
import { useAreaVisible } from "@/lib/teclado";
import { iniciarSonidos, sonar } from "@/lib/sonidos";
import { desbloquearVoz } from "@/lib/voz";
import { rutaSede } from "@/lib/sede";
import { SedeNoExiste, useSede } from "./useSede";
import { iniciarCalidad } from "@/components/kiosko/calidad";
import FondoVivo from "@/components/kiosko/FondoVivo";

const EASE = [0.22, 1, 0.36, 1] as const;
const SPRING = { type: "spring", stiffness: 210, damping: 30, mass: 0.9 } as const;

type Fase = "menu" | "clave" | "saliendo";

export default function Menu({ sede }: { sede?: string }) {
  const s = useSede(sede);
  if (s.estado === "no_existe" && sede) return <SedeNoExiste slug={sede} />;
  return <MenuPantalla sede={sede} nombreSede={s.estado === "ok" ? s.info.nombre : undefined} />;
}

function MenuPantalla({ sede, nombreSede }: { sede?: string; nombreSede?: string }) {
  const router = useRouter();
  const [fase, setFase] = useState<Fase>("menu");

  // Seguimiento del puntero (solo ratón): la foto se comporta como una ventana. En táctil se queda su órbita propia.
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const presente = useMotionValue(0);
  const seguimiento = useMemo(() => ({ x, y, presente }), [x, y, presente]);

  useEffect(() => {
    iniciarCalidad();
    router.prefetch(rutaSede(sede, "/asistencia"));
    router.prefetch("/staff");
  }, [router, sede]);

  // Esc cierra la hoja de la clave.
  useEffect(() => {
    if (fase !== "clave") return;
    const alTeclear = (e: KeyboardEvent) => e.key === "Escape" && setFase("menu");
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [fase]);

  function alMover(e: React.PointerEvent) {
    if (e.pointerType !== "mouse") return;
    x.set((e.clientX / window.innerWidth) * 2 - 1);
    y.set((e.clientY / window.innerHeight) * 2 - 1);
    presente.set(1);
  }

  function registrar() {
    // Gesto del usuario: único momento en que iOS/Safari dejan desbloquear la voz.
    desbloquearVoz();
    iniciarSonidos();
    sonar("tap");
    precalentar();
    // Se conservan ?voz, ?prueba, ?demo, ?calidad al entrar al reconocimiento.
    router.push(`${rutaSede(sede, "/asistencia")}${window.location.search}`);
  }

  function admin() {
    iniciarSonidos();
    sonar("abrir");
    if (leerToken()) entrarAlPanel();
    else setFase("clave");
  }

  // Salida suave: la pantalla se funde a negro antes de cambiar de ruta.
  function entrarAlPanel() {
    sonar("exito");
    setFase("saliendo");
    window.setTimeout(() => router.push("/staff"), 380);
  }

  // Variantes fijas (idénticas en servidor y cliente: sin desajuste de hidratación). Con "reducir movimiento",
  // MotionConfig quita los desplazamientos y la entrada queda en un simple fundido.
  const bloque: Variants = {
    oculto: { opacity: 0, y: 28 },
    visto: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.8, ease: EASE, staggerChildren: 0.09, delayChildren: 0.2 },
    },
    fuera: { opacity: 0, y: 24, filter: "blur(8px)", transition: { duration: 0.35, ease: EASE } },
  };
  const item: Variants = {
    oculto: { opacity: 0, y: 14, filter: "blur(6px)" },
    visto: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.65, ease: EASE } },
  };

  return (
    <MotionConfig reducedMotion="user">
      <motion.main
        className="menu-raiz"
        onPointerMove={alMover}
        onPointerLeave={() => presente.set(0)}
        animate={{ opacity: fase === "saliendo" ? 0 : 1 }}
        transition={{ duration: 0.38, ease: EASE }}
      >
        <div className="absolute inset-0" aria-hidden>
          <FondoVivo seguimiento={seguimiento} modo="inicio" />
          <div className="menu-velo" />
          {/* Al abrir la clave la foto se atenúa un poco: el foco pasa a la hoja. */}
          <motion.div
            className="menu-sombra"
            initial={false}
            animate={{ opacity: fase === "clave" ? 1 : 0 }}
            transition={{ duration: 0.6, ease: EASE }}
          />
        </div>

        <div className="menu-escena">
          {/* El logo no se mueve nunca: es el ancla que da continuidad entre el menú y la clave. */}
          <div className="menu-logo">
            <motion.div
              className="h-full"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: EASE, delay: 0.1 }}
            >
              <Image
                src="/logo-blanco.png"
                alt="FA CUP Chile"
                width={469}
                height={100}
                priority
                className="h-full w-auto"
              />
            </motion.div>
          </div>

          <AnimatePresence initial>
            {fase === "menu" && (
              <motion.section
                key="menu"
                className="menu-panel"
                aria-labelledby="menu-titulo"
                variants={bloque}
                initial="oculto"
                animate="visto"
                exit="fuera"
              >
                <motion.div variants={item} className="menu-textos">
                  <h1 id="menu-titulo" className="menu-titulo">
                    Fútbol
                    <br />y Amistad
                  </h1>
                  {nombreSede && <p className="menu-sede">{/^sede\s/i.test(nombreSede) ? nombreSede : `Sede ${nombreSede}`}</p>}
                  <p className="menu-sub">
                    Qué bueno tenerlos hoy en la cancha. Registra la llegada de los jugadores.
                  </p>
                </motion.div>

                <motion.div variants={item} className="menu-acciones">
                  <button type="button" className="menu-boton menu-boton-primario" onClick={registrar}>
                    <ScanFace className="menu-icono" strokeWidth={1.75} aria-hidden />
                    Registrar asistencia
                  </button>
                  <button type="button" className="menu-enlace" onClick={admin}>
                    <ShieldCheck size={16} strokeWidth={2} aria-hidden />
                    Acceso admin
                  </button>
                </motion.div>
              </motion.section>
            )}

            {fase !== "menu" && (
              <HojaClave
                key="clave"
                visible={fase === "clave"}
                onVolver={() => {
                  sonar("volver");
                  setFase("menu");
                }}
                onCorrecto={entrarAlPanel}
                sede={sede}
              />
            )}
          </AnimatePresence>
        </div>
      </motion.main>
    </MotionConfig>
  );
}

// Hoja blanca que sube desde abajo sobre la foto (como un sheet de iOS) con el campo de la clave.
function HojaClave({
  visible,
  onVolver,
  onCorrecto,
  sede,
}: {
  visible: boolean;
  onVolver: () => void;
  onCorrecto: () => void;
  sede?: string;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Con el teclado abierto la hoja sube sobre él (visualViewport) y, si no cabe, se desplaza.
  const area = useAreaVisible();
  const tapado = area ? Math.max(0, window.innerHeight - (area.top + area.height)) : 0;

  useEffect(() => {
    // El foco espera a que la hoja termine de subir: así el teclado del móvil no corta la animación.
    const t = window.setTimeout(() => input.current?.focus({ preventScroll: true }), 520);
    return () => window.clearTimeout(t);
  }, []);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (!pin || cargando) return;
    setCargando(true);
    setError(null);
    try {
      await iniciarSesion(pin, sede);
      onCorrecto();
    } catch (err) {
      sonar("error");
      setError(err instanceof ApiError ? err.message : "No se pudo iniciar sesión.");
      setPin("");
      setCargando(false);
      input.current?.focus();
    }
  }

  return (
    <motion.form
      className="menu-hoja"
      style={area ? { bottom: tapado, maxHeight: area.height, overflowY: "auto" } : undefined}
      onSubmit={enviar}
      initial={{ y: "100%" }}
      animate={{ y: visible ? 0 : "100%" }}
      exit={{ y: "100%", transition: { duration: 0.4, ease: EASE } }}
      transition={SPRING}
    >
      <button type="button" className="menu-hoja-volver" onClick={onVolver} aria-label="Volver">
        <ArrowLeft size={20} aria-hidden />
      </button>
      <div className="menu-hoja-cabecera">
        <h2>Panel del staff</h2>
        <p>Ingresa tu clave para administrar jugadores, asistencia y reportes.</p>
      </div>
      <div className="menu-hoja-campo">
        <label htmlFor="clave">Clave</label>
        <input
          id="clave"
          ref={input}
          type="password"
          inputMode="text"
          autoComplete="current-password"
          autoCapitalize="none"
          autoCorrect="off"
          enterKeyHint="go"
          placeholder="Ingresa la clave"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "clave-error" : undefined}
        />
      </div>
      {error && (
        <p id="clave-error" role="alert" className="menu-hoja-error">
          {error}
        </p>
      )}
      <button type="submit" className="menu-hoja-boton" disabled={!pin || cargando}>
        {cargando ? <Loader2 size={18} className="s-spin" aria-hidden /> : <Lock size={18} aria-hidden />}
        Entrar
      </button>
    </motion.form>
  );
}
