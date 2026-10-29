"use client";

// Diálogo de cristal que pide el PIN del staff para salir del modo asistencia.
// Valida con POST /api/auth/login (iniciarSesion guarda la sesión, así luego "Soy admin" entra directo).

import { animate, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, iniciarSesion } from "@/lib/staff-api";

const EASE = [0.22, 1, 0.36, 1] as const;

export default function SalidaPin({ onCancelar, onCorrecto }: { onCancelar: () => void; onCorrecto: () => void }) {
  const reducir = useReducedMotion();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const campo = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const tarjeta = useRef<HTMLDivElement>(null);

  // Foco al abrir y tras cada intento fallido (el campo está deshabilitado mientras valida).
  useEffect(() => {
    if (!cargando) input.current?.focus();
  }, [cargando, error]);

  // Escape cancela; Tab queda dentro del diálogo.
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onCancelar();
      if (e.key !== "Tab" || !tarjeta.current) return;
      const f = Array.from(tarjeta.current.querySelectorAll<HTMLElement>("input:not([disabled]),button:not([disabled])"));
      if (!f.length) return;
      const primero = f[0];
      const ultimo = f[f.length - 1];
      if (e.shiftKey && document.activeElement === primero) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault();
        primero.focus();
      }
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [onCancelar]);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (!pin || cargando) return;
    setCargando(true);
    setError(null);
    try {
      await iniciarSesion(pin);
      onCorrecto();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo validar el PIN.");
      setPin("");
      if (!reducir && campo.current) animate(campo.current, { x: [0, -9, 9, -6, 6, 0] }, { duration: 0.4, ease: "easeOut" });
      setCargando(false);
    }
  }

  return (
    <motion.div
      className="menu-dialogo-fondo"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reducir ? 0.1 : 0.3, ease: EASE }}
      onPointerDown={(e) => e.target === e.currentTarget && !cargando && onCancelar()}
    >
      <motion.div
        ref={tarjeta}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pin-titulo"
        className="cristal menu-dialogo"
        initial={{ opacity: 0, y: reducir ? 0 : 20, scale: reducir ? 1 : 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: reducir ? 0.1 : 0.5, ease: EASE }}
      >
        <form onSubmit={enviar} className="menu-dialogo-form" noValidate>
          <div>
            <h2 id="pin-titulo" className="menu-dialogo-titulo">
              Salir del modo asistencia
            </h2>
            <p className="menu-dialogo-texto">Ingresa el PIN del staff para volver al menú.</p>
          </div>

          <div>
            <label htmlFor="menu-pin" className="menu-etiqueta">
              PIN
            </label>
            <div ref={campo}>
              <input
                id="menu-pin"
                ref={input}
                className="menu-campo"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                enterKeyHint="go"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                disabled={cargando}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "pin-error" : undefined}
              />
            </div>
            <p id="pin-error" role="alert" className="menu-error" hidden={!error}>
              {error}
            </p>
          </div>

          <div className="menu-dialogo-acciones">
            <button type="button" className="menu-boton menu-boton-vidrio menu-boton-compacto" onClick={onCancelar} disabled={cargando}>
              Cancelar
            </button>
            <button type="submit" className="menu-boton menu-boton-primario menu-boton-compacto" disabled={!pin || cargando}>
              {cargando ? "Validando" : "Continuar"}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}
