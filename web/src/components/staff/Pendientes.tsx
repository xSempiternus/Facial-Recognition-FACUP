"use client";

// Llegadas por revisar en vivo. Un solo provider para todo el panel:
//  - consulta /pendientes/novedades cada ~4 s SOLO con la pestaña visible (pausa en segundo plano, consulta al volver,
//    backoff si falla, un único timer);
//  - muestra avisos emergentes con acciones de un toque;
//  - comparte la lista y las acciones con la pantalla de Asistencia y el menú.
// El veredicto siempre es del staff: nada se resuelve solo.

import { Check, ChevronRight, CircleHelp, Search, Trash2, UserPlus, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ApiError,
  api,
  hora,
  leerToken,
  sinTildes,
  suscribirSesion,
  textoError,
  type Disputa,
  type MotivoPendiente,
  type Novedades,
  type Pendiente,
} from "@/lib/staff-api";
import { CamposInvitado, DialogoQrApoderado, useCategoriasActivas } from "./NinoNuevo";
import { cargarTours } from "./Tour";
import { Alerta, Avatar, BadgeInvitado, Button, Dialogo, Vacio, useQuery, useToast } from "./ui";

const CADA_MS = 4000;
const MAX_ESPERA_MS = 60_000;
const VISIBLES = 2;

export function mensajeDisputa(d: Disputa, nombre?: string): string | null {
  if (d === "confirmada") return `Era ${nombre ?? "él"} de verdad: se confirmó su asistencia original.`;
  if (d === "anulada") return "Se anuló la asistencia que el kiosko había registrado por error.";
  if (d === "sin_asistencia") return "Quedó resuelto: no había asistencia que corregir.";
  return null;
}

/** Motivo en lenguaje claro para el staff. */
export function textoMotivo(p: Pendiente): string {
  const m: MotivoPendiente = p.motivo ?? "no_reconocido";
  if (m === "nino_nuevo") return "Dice ser nuevo";
  if (m === "no_soy_yo") return "Dijo que no era él";
  return "No lo reconoció";
}

const primerNombre = (n: string) => n.trim().split(/\s+/)[0] ?? n;
const ordenar = (l: Pendiente[]) => [...l].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id - b.id);

// ------------------------------------------------------------------ contexto

type Ctx = {
  lista: Pendiente[];
  total: number;
  cargado: boolean;
  /** Sube cada vez que una acción cambia la asistencia: las pantallas lo usan para recargar. */
  cambios: number;
  ocupados: readonly number[];
  refrescar: () => void;
  esSugerido: (p: Pendiente) => void;
  elegirOtro: (p: Pendiente) => void;
  ninoNuevo: (p: Pendiente) => void;
  descartar: (p: Pendiente) => void;
};

const vacio: Ctx = {
  lista: [],
  total: 0,
  cargado: false,
  cambios: 0,
  ocupados: [],
  refrescar: () => {},
  esSugerido: () => {},
  elegirOtro: () => {},
  ninoNuevo: () => {},
  descartar: () => {},
};
const PendientesCtx = createContext<Ctx>(vacio);
export const usePendientes = () => useContext(PendientesCtx);

export function PendientesProvider({ children }: { children: ReactNode }) {
  const token = useSyncExternalStore(
    suscribirSesion,
    () => leerToken(),
    () => undefined,
  );
  const ruta = usePathname();
  const notificar = useToast();

  const [lista, setLista] = useState<Pendiente[]>([]);
  const [total, setTotal] = useState(0);
  const [cargado, setCargado] = useState(false);
  const [cambios, setCambios] = useState(0);
  const [avisos, setAvisos] = useState<number[]>([]);
  const [ocupados, setOcupados] = useState<number[]>([]);
  const [otro, setOtro] = useState<Pendiente | null>(null);
  const [nuevo, setNuevo] = useState<Pendiente | null>(null);
  const [qr, setQr] = useState<{ nombre: string; categoria: string } | null>(null);

  const listaRef = useRef<Pendiente[]>([]);
  const ultimo = useRef(0);
  const primera = useRef(true);
  const enAsistencia = useRef(false);
  const resync = useRef<() => Promise<void>>(async () => {});

  const fijarLista = useCallback((l: Pendiente[]) => {
    listaRef.current = l;
    setLista(l);
    setTotal(l.length);
  }, []);

  const quitar = useCallback(
    (id: number) => {
      fijarLista(listaRef.current.filter((p) => p.id !== id));
      setAvisos((a) => a.filter((x) => x !== id));
      setCambios((c) => c + 1);
    },
    [fijarLista],
  );

  // en Asistencia ya se ve la lista completa: no se duplica con avisos
  useEffect(() => {
    enAsistencia.current = ruta === "/staff" || ruta.startsWith("/staff/asistencia");
    if (enAsistencia.current) setAvisos([]);
  }, [ruta]);

  // qué guías ya vio la sede: se pide una vez, apenas hay sesión
  useEffect(() => {
    if (token) void cargarTours();
  }, [token]);

  // sondeo
  useEffect(() => {
    if (!token) return;
    let vivo = true;
    let timer = 0;
    let enVuelo = false;
    let fallos = 0;

    const programar = (ms: number) => {
      window.clearTimeout(timer);
      if (vivo && document.visibilityState === "visible") timer = window.setTimeout(tick, ms);
    };

    const resincronizar = async () => {
      const l = ordenar(await api.pendientes());
      if (!vivo) return;
      ultimo.current = Math.max(ultimo.current, ...l.map((p) => p.id), 0);
      fijarLista(l);
      setAvisos((a) => a.filter((id) => l.some((p) => p.id === id)));
    };
    resync.current = resincronizar;

    const aplicar = async (r: Novedades) => {
      const prev = listaRef.current;
      const conocidos = new Set(prev.map((p) => p.id));
      const nuevos = r.nuevos.filter((p) => !conocidos.has(p.id));
      ultimo.current = Math.max(ultimo.current, r.ultimo_id);
      let l = prev;
      if (nuevos.length) {
        l = ordenar([...prev, ...nuevos]);
        fijarLista(l);
        if (!primera.current && !enAsistencia.current) setAvisos((a) => [...a, ...nuevos.map((p) => p.id)]);
      }
      primera.current = false;
      setCargado(true);
      // si el total del servidor no coincide, algo se resolvió en otro lado (u otro aparato): se sincroniza
      if (l.length !== r.total) await resincronizar();
      else setTotal(r.total);
    };

    async function tick() {
      if (enVuelo || !vivo || document.visibilityState !== "visible") return;
      enVuelo = true;
      try {
        await aplicar(await api.novedades(ultimo.current));
        fallos = 0;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return; // apiFetch ya expulsó al login
        fallos++;
      } finally {
        enVuelo = false;
        programar(fallos ? Math.min(CADA_MS * 2 ** fallos, MAX_ESPERA_MS) : CADA_MS);
      }
    }

    const alVolver = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") void tick(); // consulta al volver
    };
    document.addEventListener("visibilitychange", alVolver);
    void tick();
    return () => {
      vivo = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [token, fijarLista]);

  const refrescar = useCallback(() => {
    void resync.current().catch(() => {});
  }, []);

  // ---- acciones (todas dejan la decisión en el staff)
  const conOcupado = useCallback(async (id: number, fn: () => Promise<void>) => {
    setOcupados((o) => [...o, id]);
    try {
      await fn();
    } catch (e) {
      notificar(textoError(e, "No se pudo completar la acción."), "err");
      if (e instanceof ApiError && (e.status === 404 || e.status === 409)) refrescar(); // ya lo resolvieron en otro lado
    } finally {
      setOcupados((o) => o.filter((x) => x !== id));
    }
  }, [notificar, refrescar]);

  const asignar = useCallback(
    (p: Pendiente, jugadorId: number) =>
      conOcupado(p.id, async () => {
        const r = await api.asignarPendiente(p.id, jugadorId);
        notificar(`${r.nombre}: asistencia registrada${r.foto_guardada ? " y cara aprendida" : ""}`);
        const d = mensajeDisputa(r.disputa, r.nombre);
        if (d) notificar(d, "info");
        if (r.motivo) notificar(r.motivo, "info");
        quitar(p.id);
      }),
    [conOcupado, notificar, quitar],
  );

  const esSugerido = useCallback((p: Pendiente) => p.sugerido && void asignar(p, p.sugerido.id), [asignar]);

  const descartar = useCallback(
    (p: Pendiente) =>
      void conOcupado(p.id, async () => {
        const r = await api.descartarPendiente(p.id);
        notificar("Llegada descartada");
        if (r.disputa === "anulada") notificar("Se anuló la asistencia disputada. Si sí era el niño, márcalo a mano.", "info");
        quitar(p.id);
      }),
    [conOcupado, notificar, quitar],
  );

  const valor = useMemo<Ctx>(
    () => ({ lista, total, cargado, cambios, ocupados, refrescar, esSugerido, elegirOtro: setOtro, ninoNuevo: setNuevo, descartar }),
    [lista, total, cargado, cambios, ocupados, refrescar, esSugerido, descartar],
  );

  return (
    <PendientesCtx.Provider value={valor}>
      {children}
      {token && ruta !== "/staff" && !ruta.startsWith("/staff/asistencia") && <Avisos avisos={avisos} onDespues={(id) => setAvisos((a) => a.filter((x) => x !== id))} />}

      <Dialogo abierto={!!otro} onCerrar={() => setOtro(null)} titulo="¿Quién es?">
        {otro && (
          <BuscarJugador
            key={otro.id}
            p={otro}
            onElegir={(j) => {
              setOtro(null);
              void asignar(otro, j);
            }}
          />
        )}
      </Dialogo>

      <Dialogo abierto={!!nuevo} onCerrar={() => setNuevo(null)} titulo="Es un niño nuevo">
        {nuevo && (
          <FormNuevo
            key={nuevo.id}
            p={nuevo}
            onCerrar={() => setNuevo(null)}
            onListo={(msg, nombre, categoria) => {
              const p = nuevo;
              setNuevo(null);
              notificar(msg);
              setQr({ nombre, categoria });
              quitar(p.id);
            }}
          />
        )}
      </Dialogo>
      {qr && <DialogoQrApoderado nombre={qr.nombre} categoria={qr.categoria} onCerrar={() => setQr(null)} />}
    </PendientesCtx.Provider>
  );
}

// ------------------------------------------------------------------ acciones de un pendiente (aviso y tarjeta)

export function AccionesPendiente({ p, compacto }: { p: Pendiente; compacto?: boolean }) {
  const { esSugerido, elegirOtro, ninoNuevo, descartar, ocupados } = usePendientes();
  const ocupado = ocupados.includes(p.id);
  const nuevoMotivo = p.motivo === "nino_nuevo";
  type A = { k: string; texto: string; icono: ReactNode; run: () => void };
  const es: A | null = p.sugerido
    ? { k: "es", texto: `Es ${primerNombre(p.sugerido.nombre)}`, icono: <Check size={15} aria-hidden />, run: () => esSugerido(p) }
    : null;
  const otro: A = { k: "otro", texto: "Otro jugador", icono: <Users size={15} aria-hidden />, run: () => elegirOtro(p) };
  const nino: A = { k: "nino", texto: "Niño nuevo", icono: <UserPlus size={15} aria-hidden />, run: () => ninoNuevo(p) };
  const lista = (nuevoMotivo ? [nino, es, otro] : [es, otro, nino]).filter((a): a is A => !!a);
  const [principal, ...resto] = lista;
  return (
    <div className={compacto ? "s-acc compacto" : "s-acc"}>
      <Button variante="brand" className="s-acc-main" cargando={ocupado} onClick={principal.run} aria-label={p.sugerido && principal.k === "es" ? `Es ${p.sugerido.nombre}` : undefined}>
        {!ocupado && principal.icono}
        <span>{principal.texto}</span>
      </Button>
      <div className="s-acc-sec">
        {resto.map((a) => (
          <Button key={a.k} disabled={ocupado} onClick={a.run}>
            {a.icono}
            <span>{a.texto}</span>
          </Button>
        ))}
        <Button variante="ghost" disabled={ocupado} onClick={() => descartar(p)} aria-label="Descartar: no era un jugador" title="Descartar">
          <Trash2 size={15} aria-hidden />
          <span>Descartar</span>
        </Button>
      </div>
    </div>
  );
}

export function MiniaturaPendiente({ p }: { p: Pendiente }) {
  // eslint-disable-next-line @next/next/no-img-element -- miniatura en base64
  return <img className="s-aviso-img" src={`data:image/jpeg;base64,${p.miniatura}`} alt="Foto de la llegada" />;
}

// ------------------------------------------------------------------ avisos emergentes

function Avisos({ avisos, onDespues }: { avisos: number[]; onDespues: (id: number) => void }) {
  const { lista } = usePendientes();
  const vigentes = lista.filter((p) => avisos.includes(p.id)); // la lista ya está del más antiguo al más nuevo
  if (vigentes.length === 0) return null;
  const visibles = vigentes.slice(0, VISIBLES);
  const mas = vigentes.length - visibles.length;
  return (
    <div className="s-avisos" role="region" aria-label="Llegadas por revisar">
      {visibles.map((p) => (
        <div key={p.id} className="s-aviso" role="status" aria-live="polite" data-motivo={p.motivo ?? "no_reconocido"}>
          <div className="s-aviso-top">
            <MiniaturaPendiente p={p} />
            <div className="s-aviso-txt">
              <b>{textoMotivo(p)}</b>
              <span>
                Llegó a las {hora(p.timestamp)}
                {p.disputa_de?.nombre ? ` · lo tomó por ${p.disputa_de.nombre}` : ""}
              </span>
              {p.sugerido && p.motivo !== "nino_nuevo" && <span className="s-aviso-sug">¿Será {p.sugerido.nombre}?</span>}
            </div>
            <Button icono sm variante="ghost" aria-label="Revisar después" title="Revisar después" onClick={() => onDespues(p.id)}>
              <X size={16} aria-hidden />
            </Button>
          </div>
          <AccionesPendiente p={p} compacto />
        </div>
      ))}
      {mas > 0 && (
        <Link href="/staff#por-revisar" className="s-aviso-mas">
          {mas} más por revisar <ChevronRight size={14} aria-hidden />
        </Link>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ "Otro jugador": buscador

function BuscarJugador({ p, onElegir }: { p: Pendiente; onElegir: (jugadorId: number) => void }) {
  const q = useQuery(api.jugadores);
  const [texto, setTexto] = useState("");
  const orden = useMemo(
    () => [...(q.data ?? [])].sort((a, b) => a.nombre.localeCompare(b.nombre)),
    [q.data],
  );
  const t = sinTildes(texto);
  const filtrados = t ? orden.filter((j) => sinTildes(j.nombre).includes(t)) : orden;
  return (
    <>
      <div className="s-row">
        <MiniaturaPendiente p={p} />
        <div>
          <b>{textoMotivo(p)}</b>
          <div className="muted">Llegó a las {hora(p.timestamp)}. Elige quién es: se registra su asistencia.</div>
        </div>
      </div>
      <div className="s-buscar">
        <Search size={16} aria-hidden />
        <input
          className="s-input"
          type="search"
          inputMode="search"
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Buscar por nombre…"
          aria-label="Buscar jugador"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && filtrados.length === 1 && onElegir(filtrados[0].id)}
        />
      </div>
      {q.error && <Alerta tono="err">{q.error.message}</Alerta>}
      <ul className="s-pick" aria-label="Jugadores">
        {filtrados.map((j) => (
          <li key={j.id}>
            <button type="button" className="s-pick-fila" onClick={() => onElegir(j.id)}>
              <Avatar nombre={j.nombre} />
              <span className="s-pick-n">
                <b>{j.nombre}</b>
                <small>{j.categoria ?? "Sin categoría"}</small>
              </span>
              {j.estado === "invitado" && <BadgeInvitado />}
            </button>
          </li>
        ))}
      </ul>
      {!q.cargando && filtrados.length === 0 && (
        <Vacio icono={<CircleHelp size={18} />} titulo="Nadie coincide" texto="Prueba con solo el apellido. Si es un niño que no está inscrito, cierra y usa «Niño nuevo»." />
      )}
    </>
  );
}

// ------------------------------------------------------------------ "Niño nuevo" desde un pendiente

function FormNuevo({
  p,
  onCerrar,
  onListo,
}: {
  p: Pendiente;
  onCerrar: () => void;
  onListo: (msg: string, nombre: string, categoria: string) => void;
}) {
  const categorias = useCategoriasActivas();
  const [nombre, setNombre] = useState("");
  const [categoria, setCategoria] = useState("");
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enviar() {
    setTrabajando(true);
    setError(null);
    try {
      const r = await api.pendienteAInvitado(p.id, nombre.trim(), categoria);
      onListo(`${r.nombre} quedó como invitado con asistencia a las ${hora(p.timestamp)}. ${mensajeDisputa(r.disputa) ?? ""}`.replace(/\s+/g, " ").trim(), r.nombre, categoria);
    } catch (e) {
      setError(textoError(e, "No se pudo registrar."));
      setTrabajando(false);
    }
  }

  return (
    <>
      <p className="muted">Se anota como invitado con la asistencia de la hora en que llegó (sin guardar su cara). Luego su apoderado se inscribe con un QR.</p>
      {error && <Alerta tono="err">{error}</Alerta>}
      <CamposInvitado nombre={nombre} categoria={categoria} categorias={categorias} onNombre={setNombre} onCategoria={setCategoria} />
      <div className="s-dialog-f s-dialog-f-in">
        <Button onClick={onCerrar}>Cancelar</Button>
        <Button variante="primary" cargando={trabajando} disabled={nombre.trim().length < 2} onClick={enviar}>
          Registrar invitado
        </Button>
      </div>
    </>
  );
}
