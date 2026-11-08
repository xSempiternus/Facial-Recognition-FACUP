// Ayudas de la pantalla «Niños»: enlace de inscripción para apoderados (7 días por defecto) y estado simple de cada niño.

import { api, urlEnlace, type Jugador } from "@/lib/staff-api";

export type EnlaceApoderado = { id: number; url: string; expira: string; categoria: string | null };

const CLAVE = "facup-enlace-apoderado";

type Memoria = Record<string, EnlaceApoderado>;

function leerMemoria(): Memoria {
  try {
    return JSON.parse(window.sessionStorage.getItem(CLAVE) ?? "{}") as Memoria;
  } catch {
    return {};
  }
}

/** El token solo se conoce al crear el enlace: se recuerda (en esta pestaña) para reutilizarlo mientras siga activo. */
export async function enlaceApoderado(categoria = "", dias = 7): Promise<EnlaceApoderado> {
  const clave = `${categoria}|${dias}`;
  const previo = leerMemoria()[clave];
  if (previo) {
    const lista = await api.enlaces();
    if (lista.some((x) => x.id === previo.id && x.estado === "activo")) return previo;
  }
  const r = await api.crearEnlace(categoria, dias);
  const nuevo = { id: r.id, url: urlEnlace(r.ruta), expira: r.expira, categoria: r.categoria };
  try {
    window.sessionStorage.setItem(CLAVE, JSON.stringify({ ...leerMemoria(), [clave]: nuevo }));
  } catch {
    /* solo es una comodidad */
  }
  return nuevo;
}

export type EstadoNino = { tono: "ok" | "warn" | "inv"; texto: string };

/** Una sola insignia, la más importante. */
export function estadoNino(j: Jugador): EstadoNino {
  if (j.estado === "invitado") return { tono: "inv", texto: "Invitado" };
  if (!j.tiene_consentimiento) return { tono: "warn", texto: "Falta autorización" };
  if (!j.compatible) return { tono: "warn", texto: "Falta huella facial" };
  return { tono: "ok", texto: "Listo" };
}

export const primerNombre = (n: string) => n.trim().split(/\s+/)[0] ?? n;
