"use client";

// Cambiar de sede sin cerrar sesión a mano: lista de sedes activas -> clave de la elegida -> login contra esa sede.
// Al entrar se recarga la página completa en /staff: así ninguna caché, estado ni timer (pendientes, tours, preferencias,
// consultas) conserva datos de la sede anterior y todo vuelve a pedirse con el token nuevo.

import { ArrowLeftRight, Check, ChevronLeft, Lock } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, iniciarSesion, type SedeLista } from "@/lib/staff-api";
import { Alerta, Button, Campo, Dialogo } from "./ui";

const CLAVE_ENLACE_RAPIDO = "facup-enlace-rapido"; // Enlaces.tsx: enlaces recordados por categoría (no son por sede)

export function BotonCambiarSede({ sedes, actual, nombre }: { sedes: SedeLista[]; actual: string | undefined; nombre?: string }) {
  const [abierto, setAbierto] = useState(false);
  if (sedes.length < 2) return null;
  const etiqueta = nombre ?? sedes.find((s) => s.slug === actual)?.nombre ?? "Sede";
  return (
    <>
      <button
        type="button"
        className="s-btn ghost s-sede-btn"
        onClick={() => setAbierto(true)}
        aria-label={`Cambiar de sede. Sede actual: ${etiqueta}`}
        aria-haspopup="dialog"
        title="Cambiar de sede"
      >
        <ArrowLeftRight size={15} aria-hidden />
        <span>{etiqueta}</span>
      </button>
      <Dialogo abierto={abierto} onCerrar={() => setAbierto(false)} titulo="Cambiar de sede">
        {abierto && <Contenido sedes={sedes} actual={actual} onCerrar={() => setAbierto(false)} />}
      </Dialogo>
    </>
  );
}

function Contenido({ sedes, actual, onCerrar }: { sedes: SedeLista[]; actual: string | undefined; onCerrar: () => void }) {
  const [destino, setDestino] = useState<SedeLista | null>(null);
  if (!destino) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <p className="hint" id="sedes-ayuda" style={{ margin: 0 }}>
          Elige la sede. Te pediremos su clave.
        </p>
        <ul role="list" aria-describedby="sedes-ayuda" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {sedes.map((s) => {
            const esActual = s.slug === actual;
            return (
              <li key={s.slug}>
                <button
                  type="button"
                  className="s-btn block"
                  style={{ justifyContent: "space-between" }}
                  aria-current={esActual ? "true" : undefined}
                  onClick={() => (esActual ? onCerrar() : setDestino(s))}
                >
                  <span>{s.nombre}</span>
                  {esActual && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <Check size={15} aria-hidden /> Actual
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
  return <PedirClave sede={destino} onVolver={() => setDestino(null)} />;
}

function PedirClave({ sede, onVolver }: { sede: SedeLista; onVolver: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (!pin || cargando) return;
    setCargando(true);
    setError(null);
    try {
      await iniciarSesion(pin, sede.slug);
      try {
        window.sessionStorage.removeItem(CLAVE_ENLACE_RAPIDO);
      } catch {
        /* solo es una comodidad */
      }
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- recarga completa a propósito: panel limpio de la nueva sede
      window.location.href = "/staff";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo iniciar sesión.");
      setPin("");
      setCargando(false);
      input.current?.focus();
    }
  }

  return (
    <form onSubmit={enviar} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Campo etiqueta={`Clave de ${sede.nombre}`}>
        {(id) => (
          <input
            id={id}
            ref={input}
            type="password"
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint="go"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "cambiar-sede-error" : undefined}
          />
        )}
      </Campo>
      {error && (
        <div id="cambiar-sede-error">
          <Alerta tono="err">{error}</Alerta>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
        <Button type="button" variante="ghost" onClick={onVolver} disabled={cargando}>
          <ChevronLeft size={15} aria-hidden /> Volver
        </Button>
        <Button type="submit" variante="primary" cargando={cargando} disabled={!pin}>
          <Lock size={15} aria-hidden /> Entrar
        </Button>
      </div>
    </form>
  );
}
