// Cliente de la API para el panel del staff. Todas las llamadas (salvo el login) llevan el token de sesión.
// Nada de lo que pasa por aquí se registra en consola: son datos de menores.

import { fijarSede, rutaSede, sedeActual, sedeGuardada } from "@/lib/sede";

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

/** Mensajes en lenguaje simple para los códigos del backend que el staff puede ver. */
const MENSAJES: Record<string, string> = {
  sin_conexion: "No hay conexión con el servidor. Revisa la red e inténtalo de nuevo.",
  demasiados_intentos: "Demasiados intentos seguidos. Espera un par de minutos y vuelve a intentar.",
  modelo_distinto:
    "Esta solicitud se procesó con otro modelo de reconocimiento y ya no se puede aprobar. Recházala y envía un enlace nuevo a la familia.",
  es_invitado:
    "Es un invitado y todavía no tiene autorización de imagen. Primero aprueba la solicitud de inscripción de su familia.",
  ya_anulada: "Esa asistencia ya estaba anulada.",
  no_es_invitado: "Ese jugador ya está inscrito; no se puede vincular como invitado.",
  error_servidor: "El servidor tuvo un problema. Inténtalo de nuevo en un momento.",
  no_autorizado: "Sesión vencida. Ingresa de nuevo con el PIN.",
};

export function mensajeDe(codigo: string, status: number, original?: string): string {
  if (MENSAJES[codigo]) return MENSAJES[codigo];
  if (status === 429) return MENSAJES.demasiados_intentos;
  if (status >= 500) return MENSAJES.error_servidor;
  return original || `Error del servidor (${status}).`;
}

/** Texto listo para mostrar al staff a partir de cualquier error. */
export function textoError(e: unknown, porDefecto = "No se pudo completar la acción."): string {
  return e instanceof ApiError ? e.message : porDefecto;
}

async function comoError(resp: Response): Promise<ApiError> {
  const data = await resp.json().catch(() => ({}));
  const d = data && typeof data.detail === "object" && data.detail ? data.detail : {};
  const { codigo, mensaje, ...extra } = d as Record<string, unknown>;
  const cod = typeof codigo === "string" ? codigo : resp.status >= 500 ? "error_servidor" : "error";
  return new ApiError(resp.status, cod, mensajeDe(cod, resp.status, typeof mensaje === "string" ? mensaje : undefined), extra);
}

function expulsar() {
  cerrarSesion();
  const destino = rutaSede(sedeGuardada(), "/");
  if (window.location.pathname !== destino) window.location.assign(destino);
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
    throw new ApiError(0, "sin_conexion", MENSAJES.sin_conexion);
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
  estado: "activo" | "invitado";
  tiene_consentimiento: boolean;
};

export type Asistencia = {
  id: number;
  jugador_id: number;
  nombre: string;
  categoria: string | null;
  timestamp: string;
  origen: "facial" | "manual" | "correccion" | "invitado" | null;
  jugador_estado?: "activo" | "invitado";
  estado?: "valida" | "disputada" | "anulada";
  motivo?: string | null;
};

export type MotivoPendiente = "no_reconocido" | "no_soy_yo" | "nino_nuevo";

export type Pendiente = {
  id: number;
  timestamp: string;
  miniatura: string;
  motivo?: MotivoPendiente;
  sugerido: { id: number; nombre: string; similitud: number } | null;
  disputa_de?: { id: number; nombre: string | null } | null;
};

export type Novedades = { ultimo_id: number; total: number; nuevos: Pendiente[] };

export type JugadorSinAsistencia = { id: number; nombre: string; categoria: string | null };

export type Solicitud = {
  id: number;
  codigo: string;
  creado_en: string;
  nombre_nino: string;
  anio_nacimiento: number | null;
  categoria: string | null;
  tutor_nombre: string;
  tutor_contacto: string;
  fotos: number;
  compatible: boolean;
  miniatura: string;
  duplicado: { jugador_id: number; nombre: string; estado: string; similitud: number | null } | null;
  duplicado_solicitud: { solicitud_id: number; similitud: number | null } | null;
};

export type Enlace = {
  id: number;
  categoria: string | null;
  creado_en: string;
  expira: string;
  revocado_en: string | null;
  estado: "activo" | "vencido" | "revocado";
  solicitudes_pendientes: number;
};

export type EnlaceNuevo = { id: number; token: string; ruta: string; expira: string; categoria: string | null };

export type Auditoria = { id: number; fecha: string; accion: string; detalle: string | null };

export type Disputa = "confirmada" | "anulada" | "sin_asistencia" | null;

export type TipoJornada = "entrenamiento" | "partido";

export type FilaReporte = {
  id: number;
  nombre: string;
  categoria: string | null;
  estado?: "activo" | "invitado";
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

export type Categoria = { id: number; nombre: string; orden: number; activa: boolean; jugadores: number };

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

export type SedeLista = { slug: string; nombre: string };

/** Sedes activas (público: solo slug y nombre). Sirve para el selector de sede del panel. */
export async function listarSedes(): Promise<SedeLista[]> {
  const resp = await fetch("/api/sedes", { cache: "no-store" });
  if (!resp.ok) throw await comoError(resp);
  return (await resp.json()) as SedeLista[];
}

export async function iniciarSesion(pin: string, sede?: string) {
  let resp: Response;
  const slug = sede ?? sedeActual();
  try {
    resp = await fetch("/api/auth/login", {
      method: "POST",
      body: form(slug ? { pin, sede: slug } : { pin }),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "sin_conexion", "No se pudo conectar con el servidor.");
  }
  if (!resp.ok) throw await comoError(resp);
  const data = (await resp.json()) as { token: string; expira_en: number; sede?: { slug: string; nombre: string } };
  if (data.sede?.slug) fijarSede(data.sede.slug, data.sede.nombre);
  guardarSesion(data.token, data.expira_en);
}

export const api = {
  salud: () => json<Salud>("/health/detalle"),
  jugadores: () => json<Jugador[]>("/jugadores"),
  asistencias: (fecha: string, todas = false) =>
    json<Asistencia[]>(`/asistencias?fecha=${fecha}&limit=1000${todas ? "&todas=true" : ""}`),
  anularAsistencia: (id: number, motivo: string) =>
    json<unknown>(`/asistencias/${id}`, { method: "DELETE", body: form({ motivo }) }),
  editarJugador: (id: number, d: { nombre?: string; categoria?: string | null }) => {
    const c: Record<string, string | boolean> = {};
    if (d.nombre !== undefined) c.nombre = d.nombre;
    if (d.categoria === null) c.sin_categoria = true;
    else if (d.categoria !== undefined) c.categoria = d.categoria;
    return json<unknown>(`/jugadores/${id}`, { method: "PATCH", body: form(c) });
  },
  crearInvitado: (nombre: string, categoria: string) =>
    json<{ id: number; nombre: string; categoria: string | null }>("/invitados", {
      method: "POST",
      body: form({ nombre, categoria }),
    }),
  pendienteAInvitado: (id: number, nombre: string, categoria: string) =>
    json<{ id: number; nombre: string; disputa: Disputa }>(`/pendientes/${id}/invitado`, {
      method: "POST",
      body: form({ nombre, categoria }),
    }),
  auditoria: () => json<Auditoria[]>("/auditoria"),
  solicitudes: () => json<Solicitud[]>("/solicitudes"),
  aprobarSolicitud: (id: number, d: { nombre: string; categoria: string; invitadoId?: number }) =>
    json<{ id: number; nombre: string; fotos: number; invitado_convertido: boolean }>(`/solicitudes/${id}/aprobar`, {
      method: "POST",
      body: form({ nombre: d.nombre, categoria: d.categoria, ...(d.invitadoId ? { invitado_id: d.invitadoId } : {}) }),
    }),
  rechazarSolicitud: (id: number, motivo: string) =>
    json<unknown>(`/solicitudes/${id}/rechazar`, { method: "POST", body: form({ motivo }) }),
  enlaces: () => json<Enlace[]>("/inscripcion/enlaces"),
  crearEnlace: (categoria: string, dias: number) =>
    json<EnlaceNuevo>("/inscripcion/enlaces", { method: "POST", body: form({ categoria, dias }) }),
  revocarEnlace: (id: number) => json<unknown>(`/inscripcion/enlaces/${id}`, { method: "DELETE" }),
  pendientes: () => json<Pendiente[]>("/pendientes"),
  /** Novedades de pendientes desde un id. Si el backend aún no tiene el endpoint, se simula con /pendientes. */
  novedades: async (desde: number): Promise<Novedades> => {
    try {
      return await json<Novedades>(`/pendientes/novedades?desde=${desde}`);
    } catch (e) {
      if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405 && e.status !== 422)) throw e;
      const l = await json<Pendiente[]>("/pendientes");
      return { ultimo_id: l.reduce((m, p) => Math.max(m, p.id), desde), total: l.length, nuevos: l.filter((p) => p.id > desde) };
    }
  },
  preferencias: () => json<{ tours_vistos: string[] }>("/staff/preferencias"),
  marcarTour: (id: string) => json<unknown>(`/staff/tours/${encodeURIComponent(id)}`, { method: "POST" }),
  reiniciarTours: () => json<unknown>("/staff/tours", { method: "DELETE" }),
  /** Inscritos sin asistencia hoy. Si el endpoint no existe aún, se calcula con jugadores + asistencias de hoy. */
  sinAsistenciaHoy: async (): Promise<JugadorSinAsistencia[]> => {
    try {
      return await json<JugadorSinAsistencia[]>("/jugadores/sin-asistencia-hoy");
    } catch (e) {
      if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405 && e.status !== 422)) throw e;
      const [js, as] = await Promise.all([json<Jugador[]>("/jugadores"), json<Asistencia[]>(`/asistencias?fecha=${aISO(new Date())}&limit=1000`)]);
      const hoy = new Set(as.filter((a) => !a.estado || a.estado === "valida").map((a) => a.jugador_id));
      return js.filter((j) => j.estado !== "invitado" && !hoy.has(j.id)).map((j) => ({ id: j.id, nombre: j.nombre, categoria: j.categoria }));
    }
  },
  asignarPendiente: (id: number, jugadorId: number) =>
    json<{ nombre: string; ya_registrado: boolean; foto_guardada: boolean; motivo: string | null; disputa: Disputa }>(
      `/pendientes/${id}/asignar`,
      { method: "POST", body: form({ jugador_id: jugadorId }) },
    ),
  descartarPendiente: (id: number) => json<{ disputa: Disputa }>(`/pendientes/${id}`, { method: "DELETE" }),
  marcarAsistencia: (jugadorId: number) =>
    json<{ nombre: string; ya_registrado: boolean; id?: number; asistencia_id?: number }>("/asistencia/manual", {
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
  categorias: () => json<Categoria[]>("/categorias"),
  crearCategoria: (nombre: string) => json<Categoria>("/categorias", { method: "POST", body: form({ nombre }) }),
  renombrarCategoria: (c: Categoria, nombre: string) =>
    json<Categoria>(`/categorias/${c.id}`, { method: "PATCH", body: form({ nombre }) }),
  desactivarCategoria: (c: Categoria) => json<Categoria>(`/categorias/${c.id}`, { method: "DELETE" }),
  reactivarCategoria: (c: Categoria) => json<Categoria>(`/categorias/${c.id}`, { method: "PATCH", body: form({ activa: true }) }),
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

/** URL absoluta de un enlace de inscripción (la ruta viene del backend, el origen del navegador). */
export const urlEnlace = (ruta: string) => `${window.location.origin}${ruta}`;

// Aviso entre páginas y el menú: cantidad de solicitudes pendientes (para el globo del menú).
const EVENTO_SOL = "facup-solicitudes";
export function publicarPendientes(n: number) {
  window.dispatchEvent(new CustomEvent(EVENTO_SOL, { detail: n }));
}
export function escucharPendientes(cb: (n: number) => void) {
  const f = (e: Event) => cb((e as CustomEvent<number>).detail);
  window.addEventListener(EVENTO_SOL, f);
  return () => window.removeEventListener(EVENTO_SOL, f);
}

/** Para buscar sin importar tildes ni mayúsculas: "Matías" coincide con "matias". */
export const sinTildes = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
