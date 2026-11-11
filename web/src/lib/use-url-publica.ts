"use client";

import { useEffect, useSyncExternalStore } from "react";
import { cargarPublica, esUrlLocal, origenEnlaces, publicaActual, suscribirPublica, type Publica } from "./staff-api";

const sinServidor = () => null;

/** Dirección pública cargada una sola vez y compartida; `null` mientras carga. */
export function useUrlPublica(): { publica: Publica | null; origen: string } {
  const publica = useSyncExternalStore(suscribirPublica, publicaActual, sinServidor);
  useEffect(() => {
    void cargarPublica();
  }, []);
  return { publica, origen: typeof window === "undefined" ? "" : origenEnlaces(publica) };
}

/** ¿Este enlace solo funciona en este equipo? */
export const enlaceEsLocal = esUrlLocal;
