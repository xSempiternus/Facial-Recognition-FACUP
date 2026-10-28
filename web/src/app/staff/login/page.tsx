"use client";

import { Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alerta, Button } from "@/components/staff/ui";
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
      <form className="s-card" onSubmit={enviar}>
        <div className="s-card-b" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span className="s-logo" aria-hidden style={{ width: 28, height: 28, borderRadius: 7 }} />
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}>Panel del staff</h1>
              <p className="muted">FA CUP Chile · Ingresa tu PIN para continuar.</p>
            </div>
          </div>
          <div className="s-field">
            <label htmlFor="pin">PIN</label>
            <input
              id="pin"
              ref={input}
              className="s-input s-pin"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "pin-error" : undefined}
            />
          </div>
          {error && (
            <div id="pin-error">
              <Alerta tono="err">{error}</Alerta>
            </div>
          )}
          <Button type="submit" variante="primary" block cargando={cargando} disabled={!pin}>
            {!cargando && <Lock size={15} aria-hidden />} Entrar
          </Button>
        </div>
      </form>
    </main>
  );
}
