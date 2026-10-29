"use client";

// Pre-menú de la app: foto cinematográfica con movimiento 3D de fondo y un panel de cristal con dos accesos grandes.
//  - REGISTRAR ASISTENCIA -> /asistencia (reconocimiento facial). El toque desbloquea la voz y calienta la API.
//  - SOY ADMIN -> /staff si hay sesión válida, si no /staff/login.

import {
  MotionConfig,
  motion,
  useMotionValue,
  type Variants,
} from "motion/react";
import { ScanFace, ShieldCheck } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { precalentar } from "@/lib/api";
import { leerToken } from "@/lib/staff-api";
import { desbloquearVoz } from "@/lib/voz";
import { iniciarCalidad } from "@/components/kiosko/calidad";
import FondoVivo from "@/components/kiosko/FondoVivo";

const EASE = [0.22, 1, 0.36, 1] as const;

export default function Menu() {
  const router = useRouter();

  // Seguimiento del puntero (solo ratón): la foto se comporta como una ventana. En táctil se queda su órbita propia.
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const presente = useMotionValue(0);
  const seguimiento = useMemo(() => ({ x, y, presente }), [x, y, presente]);

  useEffect(() => {
    iniciarCalidad();
    router.prefetch("/asistencia");
    router.prefetch("/staff");
    router.prefetch("/staff/login");
  }, [router]);

  function alMover(e: React.PointerEvent) {
    if (e.pointerType !== "mouse") return;
    x.set((e.clientX / window.innerWidth) * 2 - 1);
    y.set((e.clientY / window.innerHeight) * 2 - 1);
    presente.set(1);
  }

  function registrar() {
    // Gesto del usuario: único momento en que iOS/Safari dejan desbloquear la voz.
    desbloquearVoz();
    precalentar();
    // Se conservan ?voz, ?prueba, ?demo, ?calidad al entrar al reconocimiento.
    router.push(`/asistencia${window.location.search}`);
  }

  function admin() {
    router.push(leerToken() ? "/staff" : "/staff/login");
  }

  // Variantes fijas (idénticas en servidor y cliente: sin desajuste de hidratación). Con "reducir movimiento",
  // MotionConfig quita los desplazamientos y la entrada queda en un simple fundido.
  const contenedor: Variants = { oculto: {}, visto: {} };
  const panel: Variants = {
    oculto: { opacity: 0, y: 28, scale: 0.97 },
    visto: {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: {
        duration: 0.8,
        ease: EASE,
        staggerChildren: 0.09,
        delayChildren: 0.2,
      },
    },
  };
  const item: Variants = {
    oculto: { opacity: 0, y: 14, filter: "blur(6px)" },
    visto: {
      opacity: 1,
      y: 0,
      filter: "blur(0px)",
      transition: { duration: 0.65, ease: EASE },
    },
  };

  return (
    <MotionConfig reducedMotion="user">
      <main
        className="menu-raiz"
        onPointerMove={alMover}
        onPointerLeave={() => presente.set(0)}
      >
        <div className="absolute inset-0" aria-hidden>
          <FondoVivo seguimiento={seguimiento} modo="inicio" />
          <div className="menu-velo" />
        </div>

        <motion.div
          className="menu-escena"
          variants={contenedor}
          initial="oculto"
          animate="visto"
        >
          <motion.section
            className="cristal menu-panel"
            aria-labelledby="menu-titulo"
            variants={panel}
          >
            <span className="destello" aria-hidden />

            <motion.div variants={item} className="menu-logo">
              <Image
                src="/logo-blanco.png"
                alt="FA CUP Chile"
                width={469}
                height={100}
                priority
                className="h-full w-auto"
              />
            </motion.div>

            <motion.div variants={item} className="menu-textos">
              <h1 id="menu-titulo" className="menu-titulo">
                Fútbol y Amistad
              </h1>
              <p className="menu-sub">
                Qué bueno tenerlos hoy en la cancha. Registra la llegada de los
                jugadores.
              </p>
            </motion.div>

            <motion.div variants={item} className="menu-acciones">
              <button
                type="button"
                className="menu-boton menu-boton-primario"
                onClick={registrar}
              >
                <ScanFace
                  className="menu-icono"
                  strokeWidth={1.75}
                  aria-hidden
                />
                Registrar asistencia
              </button>
              <button
                type="button"
                className="menu-boton menu-boton-vidrio"
                onClick={admin}
              >
                <ShieldCheck
                  className="menu-icono"
                  strokeWidth={1.75}
                  aria-hidden
                />
                Soy admin
              </button>
            </motion.div>
          </motion.section>
        </motion.div>
      </main>
    </MotionConfig>
  );
}
