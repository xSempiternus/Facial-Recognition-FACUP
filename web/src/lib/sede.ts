// Sede activa (una BD por sede en el backend). La ruta manda: /s/<slug>/... ; si no, la última usada (localStorage).

const CLAVE = "facup:sede";
const CLAVE_NOMBRE = "facup:sede-nombre";

/** Slug de la sede según una ruta (/s/<slug>/...), o undefined. */
export function sedeDeRuta(ruta: string): string | undefined {
  const m = /^\/s\/([^/]+)/.exec(ruta);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Sede guardada por la última sesión/visita (solo navegador). */
export function sedeGuardada(): string | undefined {
  try {
    return window.localStorage.getItem(CLAVE) || undefined;
  } catch {
    return undefined;
  }
}

/** Nombre legible de la sede guardada (lo escribe el login). */
export function nombreSedeGuardado(): string | undefined {
  try {
    return window.localStorage.getItem(CLAVE_NOMBRE) || undefined;
  } catch {
    return undefined;
  }
}

/** Sede actual: la de la ruta, si no la guardada, si no undefined (el backend usa la sede por defecto). */
export function sedeActual(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return sedeDeRuta(window.location.pathname) ?? sedeGuardada();
}

export function fijarSede(slug: string, nombre?: string) {
  try {
    window.localStorage.setItem(CLAVE, slug);
    if (nombre) window.localStorage.setItem(CLAVE_NOMBRE, nombre);
    else window.localStorage.removeItem(CLAVE_NOMBRE);
  } catch {
    /* sin almacenamiento: la sede vive solo en la ruta */
  }
}

/** Ruta pública de una sede: rutaSede("las-condes", "/asistencia") -> /s/las-condes/asistencia. Sin slug, la ruta base. */
export function rutaSede(slug: string | undefined, sub = ""): string {
  const s = sub && !sub.startsWith("/") ? `/${sub}` : sub;
  return slug ? `/s/${encodeURIComponent(slug)}${s}` : s || "/";
}

/** Cabeceras de sede para las llamadas públicas. */
export function cabeceraSede(): Record<string, string> {
  const s = sedeActual();
  return s ? { "X-Sede": s } : {};
}
