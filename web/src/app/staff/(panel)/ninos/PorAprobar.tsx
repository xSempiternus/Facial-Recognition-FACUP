"use client";

// Pestaña «Por aprobar»: inscripciones que mandan las familias. Nada entra hasta que el staff lo aprueba.

import { Check, ClipboardCheck, Mail, Phone, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { useCategoriasActivas } from "@/components/staff/NinoNuevo";
import { Alerta, Button, Campo, SkeletonRows, Vacio, useToast } from "@/components/staff/ui";
import { telefonoLegible } from "@/lib/inscripcion-api";
import { api, sinTildes, textoError, type Jugador, type Solicitud } from "@/lib/staff-api";
import { primerNombre } from "@/lib/staff-api-ninos";
import { Hoja } from "./Hoja";

export type DatosAprobar = { solicitudes: Solicitud[]; invitados: Jugador[] };

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

export function ListaPorAprobar({
  datos,
  cargando,
  onCambio,
  onInvitar,
}: {
  datos: DatosAprobar | undefined;
  cargando: boolean;
  onCambio: () => void;
  onInvitar: () => void;
}) {
  const notificar = useToast();
  const [aprobar, setAprobar] = useState<Solicitud | null>(null);
  const [rechazar, setRechazar] = useState<Solicitud | null>(null);
  const [ocupada, setOcupada] = useState<number | null>(null);

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

  // Con un posible duplicado, invitados por vincular o sin categoría se abre la hoja; si no, un toque basta.
  const alAprobar = (s: Solicitud) => (s.duplicado || !s.categoria || (datos?.invitados.length ?? 0) > 0 ? setAprobar(s) : void aprobarDirecto(s));

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
      <section className="nn-listaaprob" aria-label="Inscripciones por aprobar">
        {datos.solicitudes.map((s, i) => (
          <article key={s.id} className="s-card nn-sol" data-tour={i === 0 ? "nn-solicitud" : undefined} aria-label={`Inscripción de ${s.nombre_nino}`}>
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
            <div className="nn-sol-acc">
              <Button variante="brand" disabled={!s.compatible} cargando={ocupada === s.id} onClick={() => alAprobar(s)}>
                {ocupada !== s.id && <Check size={16} aria-hidden />} Aprobar
              </Button>
              <Button disabled={ocupada === s.id} onClick={() => setRechazar(s)}>
                <X size={16} aria-hidden /> Rechazar
              </Button>
            </div>
          </article>
        ))}
      </section>

      {aprobar && (
        <HojaAprobar
          key={aprobar.id}
          s={aprobar}
          invitados={datos.invitados}
          onCerrar={() => setAprobar(null)}
          onListo={() => {
            setAprobar(null);
            onCambio();
          }}
        />
      )}
      {rechazar && (
        <HojaRechazar
          key={rechazar.id}
          s={rechazar}
          onCerrar={() => setRechazar(null)}
          onListo={() => {
            setRechazar(null);
            onCambio();
          }}
        />
      )}
    </>
  );
}

function HojaAprobar({ s, invitados, onCerrar, onListo }: { s: Solicitud; invitados: Jugador[]; onCerrar: () => void; onListo: () => void }) {
  const notificar = useToast();
  const categorias = useCategoriasActivas();
  const [nombre, setNombre] = useState(s.nombre_nino);
  const [categoria, setCategoria] = useState(s.categoria ?? "");
  const [invitadoId, setInvitadoId] = useState<number>(() => invitados.find((i) => sinTildes(i.nombre) === sinTildes(s.nombre_nino) && (!s.categoria || i.categoria === s.categoria))?.id ?? 0);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opciones = s.categoria && !categorias.includes(s.categoria) ? [s.categoria, ...categorias] : categorias;
  const elegido = invitados.find((i) => i.id === invitadoId);
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
    <Hoja
      abierto
      onCerrar={onCerrar}
      titulo={`Aprobar a ${primerNombre(s.nombre_nino)}`}
      pie={
        <>
          <Button onClick={onCerrar}>Cancelar</Button>
          <Button variante="primary" cargando={trabajando} disabled={nombre.trim().length < 2} onClick={enviar}>
            Aprobar
          </Button>
        </>
      }
    >
      {s.duplicado && (
        <Alerta>
          Se parece a <b>{s.duplicado.nombre}</b>, que {s.duplicado.estado === "invitado" ? "está como invitado" : "ya está inscrito"}. Si es el mismo niño, mejor rechaza esta inscripción.
        </Alerta>
      )}
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
      {invitados.length > 0 && (
        <Campo etiqueta="¿Vino a probarse antes?" ayuda="Elígelo para que conserve las asistencias que ya tenía.">
          {(id) => (
            <select id={id} className="s-select" value={invitadoId} onChange={(e) => setInvitadoId(Number(e.target.value))}>
              <option value={0}>No, es nuevo</option>
              {invitados.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.nombre}
                  {i.categoria ? ` · ${i.categoria}` : ""}
                </option>
              ))}
            </select>
          )}
        </Campo>
      )}
      {elegido && <p className="muted">Se activa a «{elegido.nombre}» con los datos de arriba.</p>}
    </Hoja>
  );
}

function HojaRechazar({ s, onCerrar, onListo }: { s: Solicitud; onCerrar: () => void; onListo: () => void }) {
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
    <Hoja
      abierto
      onCerrar={onCerrar}
      titulo="¿Rechazar inscripción?"
      pie={
        <>
          <Button onClick={onCerrar}>No, volver</Button>
          <Button variante="danger" cargando={trabajando} onClick={enviar}>
            Sí, rechazar
          </Button>
        </>
      }
    >
      <Alerta>
        Se borran para siempre los datos y la foto de <b>{s.nombre_nino}</b>. La familia tendrá que enviar otra inscripción.
      </Alerta>
      {error && <Alerta tono="err">{error}</Alerta>}
      <Campo etiqueta="Motivo (opcional)" ayuda="Solo queda en el registro interno.">
        {(id) => <input id={id} className="s-input" value={motivo} maxLength={150} placeholder="Ej: estaba repetida" autoComplete="off" onChange={(e) => setMotivo(e.target.value)} />}
      </Campo>
    </Hoja>
  );
}
