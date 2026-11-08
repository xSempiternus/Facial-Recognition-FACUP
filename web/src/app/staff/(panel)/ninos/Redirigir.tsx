"use client";

// Las pantallas antiguas (Jugadores, Inscribir, Inscripciones) ahora son «Niños»: se conservan los enlaces y atajos.

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function Redirigir({ params }: { params: Record<string, string> }) {
  const router = useRouter();
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(params)) q.set(k, v);
    const s = q.toString();
    router.replace(`/staff/ninos${s ? `?${s}` : ""}`);
  }, [params, router]);
  return null;
}
