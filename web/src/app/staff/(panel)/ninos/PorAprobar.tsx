"use client";

// Pestaña «Por aprobar»: inscripciones que mandan las familias. Nada entra hasta que el staff lo aprueba.
// Aprobar y rechazar se resuelven DENTRO de la tarjeta (nada de ventanas encima, sobre todo en el teléfono).

import { Check, ClipboardCheck, Mail, Phone, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { PistaInline, PistaOpcion } from "@/components/staff/PistaInline";
import { useCategoriasActivas } from "@/components/staff/NinoNuevo";
import { Alerta, Button, Campo, SkeletonRows, Vacio, useToast } from "@/components/staff/ui";
import { telefonoLegible } from "@/lib/inscripcion-api";
import { api, diaMes, textoError, type CandidatoInvitado, type Jugador, type Solicitud } from "@/lib/staff-api";
import { primerNombre } from "@/lib/staff-api-ninos";

export type DatosAprobar = { solicitudes: Solicitud[]; invitados?: Jugador[] };

const PARENTESCO: Record<string, string> = { madre: "madre", padre: "padre", otro: "apoderado/a" };

/** Categoría sugerida por año de nacimiento: primero una categoría cuyo nombre incluya el año (o un rango
 * "2015-2016"); si no, la "Sub-N" más chica en la que entra (edad cumplida en el año ≤ N). Solo una sugerencia. */
export function sugerirCategoria(anio: number | null | undefined, categorias: string[], hoy = new Date().getFullYear()): string | null {
  if (!anio) return null;
  const porAnio = categorias.find((c) => {
    const ys = (c.match(/\b(?:19|20)\d{2}\b/g) ?? []).map(Number);
    return ys.length > 0 && anio >= Math.min(...ys) && anio <= Math.max(...ys);
  });
  if (porAnio) return porAnio;
  const edad = hoy - anio;
  const subs = categorias
    .map((c) => ({ c, n: Number(/(?:sub|u)\s*-?\s*(\d{1,2})\b/i.exec(c)?.[1] ?? 0) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => a.n - b.n);
  return subs.find((x) => edad <= x.n)?.c ?? null;
}

type Modo = { id: number; modo: "aprobar" | "rechazar" };

export function ListaPorAprobar({
  datos,
  cargando,
  onCambio,
  onInvitar,
  abrirId,
}: {
  datos: DatosAprobar | undefined;
  cargando: boolean;
  onCambio: () => void;
  onInvitar: () => void;
  /** Solicitud que se abre sola (viene de la campana). */
  abrirId?: number;
}) {
  const notificar = useToast();
  const [abierto, setAbierto] = useState<Modo | null>(null);
  const [ocupada, setOcupada] = useState<number | null>(null);
  const yaAbierta = useRef<number | undefined>(undefined);

  // una solicitud pedida desde la campana se abre sola, una vez, cuando ya cargó la lista
  const existe = abrirId !== undefined && !!datos?.solicitudes.some((s) => s.id === abrirId);
  useEffect(() => {
    if (!existe || yaAbierta.current === abrirId) return;
    yaAbierta.current = abrirId;
    setAbierto({ id: abrirId as number, modo: "aprobar" });
    window.setTimeout(() => document.getElementById(`sol-${abrirId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
  }, [existe, abrirId]);

  async function aprobarDirecto(s: Solicitud) {
    setOcupada(s.id);
    try {
      const r = await api.aprobarSolicitud(s.id, { nombre: s.nombre_nino, categoria: s.categoria ?? "" });
      notificar(`Se inscribió a ${primerNombre(r.nombre)}`);
      onCambio();
    } catch (e) {
      notificar(textoError(e, "No se pudo aprobar."), "err");
    } finally {
      setOcupada(null);
    }
  }

  // Con posible duplicado, sin categoría o con invitados parecidos se abre el panel de la tarjeta; si no, un toque basta.
  const alAprobar = (s: Solicitud) => (s.duplicado || !s.categoria || (s.candidatos_invitado?.length ?? 0) > 0 ? setAbierto({ id: s.id, modo: "aprobar" }) : void aprobarDirecto(s));

  if (cargando && !datos) {
    return (
      <div className="s-card">
        <SkeletonRows n={3} />
      </div>
    );
  }
  if (!datos || datos.solicitudes.length === 0) {
    return (
      <div className="s-card">
        <Vacio icono={<ClipboardCheck size={18} />} titulo="No hay nada por aprobar" texto="Cuando una familia complete la inscripción, aparecerá aquí.">
          <Button variante="primary" onClick={onInvitar}>
            Invitar a una familia
          </Button>
        </Vacio>
      </div>
    );
  }

  return (
    <>
      <PistaInline id="aprobar" resumen="Mira la foto y los datos, y aprueba. Nada entra hasta que tú lo apruebas.">
        <PistaOpcion nombre="Aprobar:">si es un niño real y los datos se ven bien. Si falta la categoría, te la pedimos.</PistaOpcion>
        <PistaOpcion nombre="Rechazar:">si está repetida, la foto no sirve o no es un niño. Se borran sus datos.</PistaOpcion>
        <PistaOpcion nombre="«¿Ya vino a probarse?»:">solo sale si ya hay un invitado con nombre parecido. Elígelo para que conserve sus asistencias; si no, deja «No, es nuevo/a».</PistaOpcion>
      </PistaInline>
      <section className="nn-listaaprob" aria-label="Inscripciones por aprobar">
        {datos.solicitudes.map((s, i) => {
          const modo = abierto?.id === s.id ? abierto.modo : null;
          return (
            <article key={s.id} id={`sol-${s.id}`} className="s-card nn-sol" data-tour={i === 0 ? "nn-solicitud" : undefined} aria-label={`Inscripción de ${s.nombre_nino}`}>
              <div className="nn-sol-top">
                {s.miniatura ? (
                  // eslint-disable-next-line @next/next/no-img-element -- miniatura en base64
                  <img className="nn-foto" src={`data:image/jpeg;base64,${s.miniatura}`} alt={`Foto de ${s.nombre_nino}`} />
                ) : (
                  <div className="nn-foto" aria-hidden />
                )}
                <div style={{ minWidth: 0 }}>
                  <h3>{s.nombre_nino}</h3>
                  <p>
                    {s.categoria ?? <span className="nn-completar">Sin categoría · completar</span>}
                    {s.anio_nacimiento ? ` · ${s.anio_nacimiento}` : ""} · lo inscribe <b style={{ color: "var(--fg)", fontWeight: 550 }}>{s.tutor_nombre}</b>
                    {s.tutor_parentesco ? ` (${PARENTESCO[s.tutor_parentesco] ?? s.tutor_parentesco})` : ""}
                  </p>
                  {s.tutor_correo || s.tutor_telefono ? (
                    <p className="nn-contacto">
                      {s.tutor_correo && (
                        <span>
                          <Mail size={13} aria-hidden /> {s.tutor_correo}
                        </span>
                      )}
                      {s.tutor_telefono && (
                        <span>
                          <Phone size={13} aria-hidden /> {telefonoLegible(s.tutor_telefono)}
                        </span>
                      )}
                    </p>
                  ) : (
                    s.tutor_contacto && <p>{s.tutor_contacto}</p>
                  )}
                  {s.acepta_comunicaciones !== undefined && <p className="nn-com">{s.acepta_comunicaciones ? "Acepta recibir comunicaciones" : "No autorizó comunicaciones: no contactar por campañas"}</p>}
                </div>
              </div>
              {s.duplicado && (
                <div className="s-alert warn">
                  <TriangleAlert size={16} aria-hidden />
                  <div>
                    <b>Se parece a {s.duplicado.nombre}</b>, que {s.duplicado.estado === "invitado" ? "está como invitado" : "ya está inscrito"}. Revisa que no sea el mismo niño.
                  </div>
                </div>
              )}
              {s.duplicado_solicitud && datos.solicitudes.some((o) => o.id === s.duplicado_solicitud?.solicitud_id) && (
                <div className="s-alert warn">
                  <TriangleAlert size={16} aria-hidden />
                  <div>Se parece a otra inscripción por aprobar: puede que la familia la enviara dos veces.</div>
                </div>
              )}
              {!s.compatible && <Alerta>No se puede aprobar: se tomó con una versión anterior del reconocimiento. Recházala y envía un enlace nuevo a la familia.</Alerta>}

              {modo === "aprobar" && (
                <FormAprobar
                  s={s}
                  onCerrar={() => setAbierto(null)}
                  onListo={() => {
                    setAbierto(null);
                    onCambio();
                  }}
                />
              )}
              {modo === "rechazar" && (
                <FormRechazar
                  s={s}
                  onCerrar={() => setAbierto(null)}
                  onListo={() => {
                    setAbierto(null);
                    onCambio();
                  }}
                />
              )}
              {modo === null && (
                <div className="nn-sol-acc">
                  <Button variante="brand" disabled={!s.compatible} cargando={ocupada === s.id} onClick={() => alAprobar(s)}>
                    {ocupada !== s.id && <Check size={16} aria-hidden />} Aprobar
                  </Button>
                  <Button disabled={ocupada === s.id} onClick={() => setAbierto({ id: s.id, modo: "rechazar" })}>
                    <X size={16} aria-hidden /> Rechazar
                  </Button>
                </div>
              )}
            </article>
          );
        })}
      </section>
    </>
  );
}

const asistenciasTxt = (n: number) => (n === 1 ? "conservará 1 asistencia" : `conservará ${n} asistencias`);

/** Panel de aprobar dentro de la tarjeta: niño -> categoría -> «¿Ya vino a probarse?» (solo con coincidencias). */
function FormAprobar({ s, onCerrar, onListo }: { s: Solicitud; onCerrar: () => void; onListo: () => void }) {
  const notificar = useToast();
  const categorias = useCategoriasActivas();
  const [nombre, setNombre] = useState(s.nombre_nino);
  const [categoria, setCategoria] = useState(s.categoria ?? "");
  const [invitadoId, setInvitadoId] = useState(0);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grupo = useId();
  const candidatos: CandidatoInvitado[] = s.candidatos_invitado ?? [];
  const opciones = s.categoria && !categorias.includes(s.categoria) ? [s.categoria, ...categorias] : categorias;
  const elegido = candidatos.find((i) => i.id === invitadoId);
  const falta = !s.categoria;
  const sugerida = falta ? sugerirCategoria(s.anio_nacimiento, categorias) : null;

  async function enviar() {
    setTrabajando(true);
    setError(null);
    try {
      const r = await api.aprobarSolicitud(s.id, { nombre: nombre.trim(), categoria, invitadoId: invitadoId || undefined });
      notificar(r.invitado_convertido ? `Se inscribió a ${primerNombre(r.nombre)} y conserva su asistencia` : `Se inscribió a ${primerNombre(r.nombre)}`);
      onListo();
    } catch (e) {
      setError(textoError(e, "No se pudo aprobar."));
      setTrabajando(false);
    }
  }

  return (
    <div className="nn-inline" role="group" aria-label={`Aprobar a ${primerNombre(s.nombre_nino)}`}>
      {error && <Alerta tono="err">{error}</Alerta>}
      <Campo etiqueta="Nombre y apellido del niño">
        {(id) => <input id={id} className="s-input" value={nombre} maxLength={60} autoComplete="off" onChange={(e) => setNombre(e.target.value)} />}
      </Campo>
      <div className={falta && !categoria ? "nn-falta" : undefined}>
        <Campo
          etiqueta={falta ? "Categoría (la familia no la eligió)" : "Categoría"}
          ayuda={falta ? (s.anio_nacimiento ? `Nació en ${s.anio_nacimiento}. Si la dejas vacía, queda «Sin categoría» y la completas después en Niños.` : "Si la dejas vacía, queda «Sin categoría» y la completas después en Niños.") : undefined}
        >
          {(id) => (
            <select id={id} className="s-select" value={categoria} onChange={(e) => setCategoria(e.target.value)}>
              <option value="">Sin categoría</option>
              {opciones.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </Campo>
        {sugerida && categoria !== sugerida && (
          <Button sm variante="ghost" style={{ marginTop: 6 }} onClick={() => setCategoria(sugerida)}>
            Usar {sugerida} (sugerida por el año)
          </Button>
        )}
      </div>
      {candidatos.length > 0 && (
        <fieldset className="nn-prueba">
          <legend>¿Ya vino a probarse?</legend>
          <p className="muted">Hay un invitado con un nombre parecido. Si es el mismo, elígelo para que no pierda sus asistencias.</p>
          <label className="nn-op">
            <input type="radio" name={grupo} checked={invitadoId === 0} onChange={() => setInvitadoId(0)} />
            <span>
              <b>No, es nuevo/a</b>
            </span>
          </label>
          {candidatos.map((c) => {
            const dia = (c.ultima_asistencia ?? c.creado_en ?? "").slice(0, 10);
            return (
              <label key={c.id} className="nn-op">
                <input type="radio" name={grupo} checked={invitadoId === c.id} onChange={() => setInvitadoId(c.id)} />
                <span>
                  <b>{c.nombre}</b>
                  <small>
                    {c.categoria ?? "Sin categoría"}
                    {dia ? ` · vino el ${diaMes(dia)}` : ""} · {asistenciasTxt(c.asistencias)}
                  </small>
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
      {elegido && <p className="muted">Se activa a «{elegido.nombre}» con los datos de arriba.</p>}
      <div className="nn-sol-acc">
        <Button variante="primary" cargando={trabajando} disabled={nombre.trim().length < 2} onClick={enviar}>
          <Check size={16} aria-hidden /> Aprobar a {primerNombre(nombre.trim() || s.nombre_nino)}
        </Button>
        <Button disabled={trabajando} onClick={onCerrar}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

function FormRechazar({ s, onCerrar, onListo }: { s: Solicitud; onCerrar: () => void; onListo: () => void }) {
  const notificar = useToast();
  const [motivo, setMotivo] = useState("");
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enviar() {
    setTrabajando(true);
    setError(null);
    try {
      await api.rechazarSolicitud(s.id, motivo.trim());
      notificar("Inscripción rechazada y datos borrados");
      onListo();
    } catch (e) {
      setError(textoError(e, "No se pudo rechazar."));
      setTrabajando(false);
    }
  }

  return (
    <div className="nn-inline" role="group" aria-label={`Rechazar la inscripción de ${s.nombre_nino}`}>
      <Alerta>
        Se borran para siempre los datos y la foto de <b>{s.nombre_nino}</b>. La familia tendrá que enviar otra inscripción.
      </Alerta>
      {error && <Alerta tono="err">{error}</Alerta>}
      <Campo etiqueta="Motivo (opcional)" ayuda="Solo queda en el registro interno.">
        {(id) => <input id={id} className="s-input" value={motivo} maxLength={150} placeholder="Ej: estaba repetida" autoComplete="off" onChange={(e) => setMotivo(e.target.value)} />}
      </Campo>
      <div className="nn-sol-acc">
        <Button variante="danger" cargando={trabajando} onClick={enviar}>
          Sí, rechazar
        </Button>
        <Button disabled={trabajando} onClick={onCerrar}>
          No, volver
        </Button>
      </div>
    </div>
  );
}
