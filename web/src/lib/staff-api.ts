// Cliente de la API para el panel del staff. Todas las llamadas (salvo el login) llevan el token de sesión.
// Nada de lo que pasa por aquí se registra en consola: son datos de menores.

const CLAVE = "facup-staff";
const EVENTO = "facup-staff-sesion";

// ------------------------------------------------------------------ sesión (sessionStorage)

type Sesion = { token: string; expira: number };

function leer(): Sesion | null {
  try {
    const bruto = window.sessionStorage.getItem(CLAVE);
    if (!bruto) return null;
    const s = JSON.parse(bruto) as Sesion;
    if (!s.token || s.expira <= Date.now()) {
      window.sessionStorage.removeItem(CLAVE);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function guardarSesion(token: string, expiraEnSegundos: number) {
  try {
    window.sessionStorage.setItem(CLAVE, JSON.stringify({ token, expira: Date.now() + expiraEnSegundos * 1000 }));
  } catch {
    /* sin almacenamiento: la sesión vive solo en esta pestaña hasta recargar */
  }
  window.dispatchEvent(new Event(EVENTO));
}

export function cerrarSesion() {
  try {
    window.sessionStorage.removeItem(CLAVE);
  } catch {
    /* nada que limpiar */
  }
  window.dispatchEvent(new Event(EVENTO));
}

export function leerToken(): string | null {
  return leer()?.token ?? null;
}

/** Para useSyncExternalStore. */
export function suscribirSesion(cb: () => void) {
  window.addEventListener(EVENTO, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENTO, cb);
    window.removeEventListener("storage", cb);
  };
}

// ------------------------------------------------------------------ errores y fetch

export class ApiError extends Error {
  codigo: string;
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, codigo: string, mensaje: string, extra: Record<string, unknown> = {}) {
    super(mensaje);
    this.status = status;
    this.codigo = codigo;
    this.extra = extra;
  }
}

async function comoError(resp: Response): Promise<ApiError> {
  const data = await resp.json().catch(() => ({}));
  const d = data && typeof data.detail === "object" && data.detail ? data.detail : {};
  const { codigo, mensaje, ...extra } = d as Record<string, unknown>;
  return new ApiError(
    resp.status,
    typeof codigo === "string" ? codigo : resp.status >= 500 ? "error_servidor" : "error",
    typeof mensaje === "string" ? mensaje : `Error del servidor (${resp.status}).`,
    extra,
  );
}

function expulsar() {
  cerrarSesion();
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- recarga completa: descarta todo estado en memoria
  if (!window.location.pathname.startsWith("/staff/login")) window.location.assign("/staff/login");
}

/** fetch con el token inyectado; ante 401 limpia la sesión y manda al login. */
export async function apiFetch(ruta: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = leerToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let resp: Response;
  try {
    resp = await fetch(`/api${ruta}`, { ...init, headers, cache: "no-store" });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "sin_conexion", "No se pudo conectar con el servidor.");
  }
  if (resp.status === 401) {
    expulsar();
    throw new ApiError(401, "no_autorizado", "Sesión vencida. Ingresa de nuevo con el PIN.");
  }
  if (!resp.ok) throw await comoError(resp);
  return resp;
}

async function json<T>(ruta: string, init?: RequestInit): Promise<T> {
  return (await apiFetch(ruta, init)).json() as Promise<T>;
}

function form(campos: Record<string, string | number | boolean>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(campos)) f.append(k, String(v));
  return f;
}

// ------------------------------------------------------------------ tipos

export type Jugador = {
  id: number;
  nombre: string;
  categoria: string | null;
  creado_en: string;
  consentimiento_tutor: string | null;
  consentimiento_fecha: string | null;
  asistencias: number;
  ultima_asistencia: string | null;
  fotos: number;
  compatible: boolean;
};

export type Asistencia = {
  id: number;
  jugador_id: number;
  nombre: string;
  categoria: string | null;
  timestamp: string;
  origen: "facial" | "manual" | "correccion" | null;
};

export type Pendiente = {
  id: number;
  timestamp: string;
  miniatura: string;
  sugerido: { id: number; nombre: string; similitud: number } | null;
};

export type TipoJornada = "entrenamiento" | "partido";

export type FilaReporte = {
  id: number;
  nombre: string;
  categoria: string | null;
  presentes: number;
  posibles: number;
  porcentaje: number | null;
  ausencias_seguidas: number;
  alerta: boolean;
  ultima: string | null;
};

export type Reporte = {
  desde: string;
  hasta: string;
  tipo: string;
  dias: { fecha: string; tipo: TipoJornada; presentes: number }[];
  jugadores: FilaReporte[];
  umbral_ausencias: number;
};

export type Config = {
  modelo: string;
  detector: string;
  umbral: number;
  antispoofing?: boolean;
  modelos: string[];
  detectores: string[];
};

export type Respaldo = { nombre: string; bytes: number; creado: string };

export type Salud = {
  status: string;
  jugadores: number;
  requieren_reinscripcion: number;
  pendientes: number;
  threshold: number;
  modelo: string;
  detector: string;
  antispoofing: boolean;
};

export type ResultadoInscripcion = {
  id: number;
  nombre: string;
  categoria: string | null;
  fotos: number;
  avisos: string[];
};

// ------------------------------------------------------------------ endpoints

export async function iniciarSesion(pin: string) {
  let resp: Response;
  try {
    resp = await fetch("/api/auth/login", { method: "POST", body: form({ pin }), cache: "no-store" });
  } catch {
    throw new ApiError(0, "sin_conexion", "No se pudo conectar con el servidor.");
  }
  if (!resp.ok) throw await comoError(resp);
  const data = (await resp.json()) as { token: string; expira_en: number };
  guardarSesion(data.token, data.expira_en);
}

export const api = {
  salud: () => json<Salud>("/health"),
  jugadores: () => json<Jugador[]>("/jugadores"),
  asistencias: (fecha: string) => json<Asistencia[]>(`/asistencias?fecha=${fecha}&limit=1000`),
  pendientes: () => json<Pendiente[]>("/pendientes"),
  asignarPendiente: (id: number, jugadorId: number) =>
    json<{ nombre: string; ya_registrado: boolean; foto_guardada: boolean; motivo: string | null }>(
      `/pendientes/${id}/asignar`,
      { method: "POST", body: form({ jugador_id: jugadorId }) },
    ),
  descartarPendiente: (id: number) => json<unknown>(`/pendientes/${id}`, { method: "DELETE" }),
  marcarAsistencia: (jugadorId: number) =>
    json<{ nombre: string; ya_registrado: boolean }>("/asistencia/manual", {
      method: "POST",
      body: form({ jugador_id: jugadorId }),
    }),
  tipoJornada: (fecha: string) => json<Record<string, TipoJornada>>(`/jornadas?desde=${fecha}&hasta=${fecha}`),
  fijarJornada: (fecha: string, tipo: TipoJornada) =>
    json<unknown>(`/jornadas/${fecha}`, { method: "PUT", body: form({ tipo }) }),
  reporte: (desde: string, hasta: string, tipo: string) =>
    json<Reporte>(`/reportes?desde=${desde}&hasta=${hasta}&tipo=${tipo}`),
  agregarFoto: (id: number, foto: Blob) => {
    const f = new FormData();
    f.append("file", foto, "foto.jpg");
    return json<{ nombre: string }>(`/jugadores/${id}/foto`, { method: "POST", body: f });
  },
  consentimiento: (id: number, tutor: string) =>
    json<unknown>(`/jugadores/${id}/consentimiento`, { method: "POST", body: form({ tutor }) }),
  eliminarJugador: (id: number) => json<unknown>(`/jugadores/${id}`, { method: "DELETE" }),
  inscribir: (d: { nombre: string; categoria: string; tutor: string; fotos: Blob[]; forzar: boolean }) => {
    const f = form({
      nombre: d.nombre,
      categoria: d.categoria,
      tutor: d.tutor,
      consentimiento: true,
      forzar: d.forzar,
    });
    d.fotos.forEach((b, i) => f.append("files", b, `foto${i + 1}.jpg`));
    return json<ResultadoInscripcion>("/enroll", { method: "POST", body: f });
  },
  config: () => json<Config>("/config"),
  guardarConfig: (c: { modelo: string; detector: string; umbral: number; antispoofing: boolean }) =>
    json<{ requieren_reinscripcion: number }>("/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c),
    }),
  respaldos: () => json<Respaldo[]>("/respaldos"),
  crearRespaldo: () => json<{ nombre: string }>("/respaldos", { method: "POST" }),
};

/** Descarga un respaldo (necesita el token, por eso no es un simple enlace). */
export async function descargarRespaldo(nombre: string) {
  const blob = await (await apiFetch(`/respaldos/${encodeURIComponent(nombre)}`)).blob();
  descargar(blob, nombre);
}

export function descargar(blob: Blob, nombre: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV con BOM para que Excel respete las tildes. */
export function descargarCsv(nombre: string, filas: (string | number | null)[][]) {
  const celda = (v: string | number | null) => {
    const s = v == null ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const texto = "﻿" + filas.map((f) => f.map(celda).join(",")).join("\r\n");
  descargar(new Blob([texto], { type: "text/csv;charset=utf-8" }), nombre);
}

// ------------------------------------------------------------------ utilidades de fecha/formato

export const CATEGORIAS = ["Sub-6", "Sub-8", "Sub-10", "Sub-12", "Sub-14", "Sub-16"];

export function ordenarCategorias(cats: Iterable<string>): string[] {
  const num = (c: string) => {
    const d = c.replace(/\D/g, "");
    return d ? Number(d) : null;
  };
  return [...cats].sort((a, b) => {
    const na = num(a);
    const nb = num(b);
    if (na !== null && nb !== null) return na - nb || a.localeCompare(b);
    if (na !== null) return -1;
    if (nb !== null) return 1;
    return a.localeCompare(b);
  });
}

export function aISO(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function sumarDias(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return aISO(d);
}

export const diaMes = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
export const hora = (ts: string) => ts.slice(11, 16);
export const fechaHora = (ts: string) => `${diaMes(ts.slice(0, 10))} ${hora(ts)}`;
