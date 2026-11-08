"use client";

import { useEffect } from "react";
import { registrarSW } from "@/lib/pwa";

// Registra el service worker tras la carga, sin bloquear la primera pintura. No renderiza nada.
export default function RegistroSW() {
  useEffect(() => {
    if (document.readyState === "complete") void registrarSW();
    else {
      const f = () => void registrarSW();
      window.addEventListener("load", f, { once: true });
      return () => window.removeEventListener("load", f);
    }
  }, []);
  return null;
}
