"use client";

import { ArrowLeft, Loader2, Lock } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ViewTransition, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, iniciarSesion, leerToken } from "@/lib/staff-api";

export default function Login() {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (leerToken()) router.replace("/staff");
    else input.current?.focus();
  }, [router]);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (!pin || cargando) return;
    setCargando(true);
    setError(null);
    try {
      await iniciarSesion(pin);
      router.replace("/staff");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo iniciar sesión.");
      setPin("");
      setCargando(false);
      input.current?.focus();
    }
  }

  return (
    <main className="s-login">
      <div className="s-login-foto" aria-hidden>
        <Image src="/inicio/campeones.jpg" alt="" fill priority sizes="(min-width: 900px) 50vw, 100vw" />
        <Link href="/" className="s-login-volver" aria-label="Volver al inicio">
          <ArrowLeft size={20} />
        </Link>
        <ViewTransition name="logo-facup" share="vt-logo" default="none">
          <Image
            src="/logo-blanco.png"
            alt=""
            width={469}
            height={100}
            priority
            className="s-login-logo"
          />
        </ViewTransition>
      </div>

      <form className="s-login-hoja" onSubmit={enviar}>
        <div className="s-login-cabecera">
          <h1>Panel del staff</h1>
          <p>Ingresa tu clave para administrar jugadores, asistencia y reportes.</p>
        </div>
        <div className="s-login-campo">
          <label htmlFor="pin">Clave</label>
          <input
            id="pin"
            ref={input}
            type="password"
            inputMode="text"
            autoComplete="current-password"
            placeholder="Ingresa la clave"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "pin-error" : undefined}
          />
        </div>
        {error && (
          <p id="pin-error" role="alert" className="s-login-error">
            {error}
          </p>
        )}
        <button type="submit" className="s-login-boton" disabled={!pin || cargando}>
          {cargando ? <Loader2 size={18} className="s-spin" aria-hidden /> : <Lock size={18} aria-hidden />}
          Entrar
        </button>
      </form>
    </main>
  );
}
