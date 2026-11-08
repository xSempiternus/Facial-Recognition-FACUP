"use client";

import { Ban, BellRing, Check, CircleCheck, Clock, Download, PenLine, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { MarcarRapido } from "@/components/staff/MarcarRapido";
import { NinoNuevo } from "@/components/staff/NinoNuevo";
import { AccionesPendiente, MiniaturaPendiente, textoMotivo, usePendientes } from "@/components/staff/Pendientes";
import { BotonAyuda, Tour, type PasoTour } from "@/components/staff/Tour";
import {
  Alerta,
  Avatar,
  Badge,
  BadgeInvitado,
  Button,
  Campo,
  Dialogo,
  ErrorCarga,
  FiltroCategorias,
  PageHeader,
  Segmentado,
  SkeletonRows,
  Vacio,
  useQuery,
  useRefrescoAlVolver,
  useToast,
} from "@/components/staff/ui";
import {
  aISO,
  api,
  descargarCsv,
  hora,
  ordenarCategorias,
  textoError,
  type Asistencia,
  type Jugador,
  type Pendiente,
  type TipoJornada,
} from "@/lib/staff-api";

const ORIGEN = { facial: "Cámara", manual: "Manual", correccion: "Revisado", invitado: "Invitado" } as const;

const PASOS: PasoTour[] = [
  { selector: "[data-tour='cancha']", titulo: "Barra de la cancha", texto: "Siempre a mano: Pendientes (se actualiza solo), Niño nuevo y Marcar a mano. En Marcar a mano escribes un nombre, tocas y listo; tienes 5 segundos para deshacer.", lado: "abajo" },
  { selector: "[data-tour='nino-nuevo']", titulo: "¿Llegó un niño nuevo?", texto: "Toca «Niño nuevo», escribe su nombre y muestra el QR al apoderado. El niño queda anotado hoy y la familia completa la inscripción desde su celular.", lado: "abajo" },
  { selector: "[data-tour='pendientes']", titulo: "Llegadas por revisar", texto: "Si la cámara no reconoce a alguien, o un niño toca «no soy yo» o dice que es nuevo, aparece aquí y también como aviso en cualquier pantalla. Tú decides quién es.", lado: "abajo" },
  { selector: "[data-tour='faltan']", titulo: "Marcar a mano", texto: "¿Llegó pero la cámara no lo reconoció? Búscalo en «Faltan» y toca Marcar.", lado: "izq" },
  { selector: "[data-tour='anular']", titulo: "Corregir un error", texto: "Si marcaron a alguien por error, toca Anular y escribe el motivo. No se borra: queda registrada como anulada y puedes verla con «Ver anuladas».", lado: "izq" },
];

export default function Asistencia() {
  const notificar = useToast();
  const hoy = aISO(new Date());
  const [dia, setDia] = useState(hoy);
  const [cats, setCats] = useState<string[]>([]);
  const esHoy = dia === hoy;

  const [verAnuladas, setVerAnuladas] = useState(false);
  const [anular, setAnular] = useState<Asistencia | null>(null);

  const { lista: pendientes, total: nPend, cambios } = usePendientes();
  const [marcando, setMarcando] = useState(false);
  const base = useQuery(async () => {
    const [jugadores, asistencias, tipos] = await Promise.all([api.jugadores(), api.asistencias(dia, verAnuladas), api.tipoJornada(dia)]);
    return { jugadores, asistencias, tipo: (tipos[dia] ?? "entrenamiento") as TipoJornada };
  }, `${dia}:${verAnuladas}:${cambios}`);
  const [tipoLocal, setTipoLocal] = useState<{ dia: string; tipo: TipoJornada } | null>(null);

  const data = base.data;
  const tipo = tipoLocal?.dia === dia ? tipoLocal.tipo : data?.tipo ?? "entrenamiento";

  const categorias = useMemo(() => ordenarCategorias(new Set((data?.jugadores ?? []).map((j) => j.categoria).filter((c): c is string => !!c))), [data]);
  const enCat = (c: string | null) => !cats.length || (c !== null && cats.includes(c));
  const jugadores = (data?.jugadores ?? []).filter((j) => enCat(j.categoria));
  const todasFilas = (data?.asistencias ?? []).filter((a) => enCat(a.categoria));
  // Solo cuentan las válidas; las anuladas y las disputadas ("no soy yo") se muestran aparte.
  const asistencias = todasFilas.filter((a) => !a.estado || a.estado === "valida");
  const presentesIds = new Set(asistencias.map((a) => a.jugador_id));
  const inscritos = jugadores.filter((j) => j.estado !== "invitado");
  const ausentes = inscritos.filter((j) => !presentesIds.has(j.id));
  const nPresentesInscritos = inscritos.filter((j) => presentesIds.has(j.id)).length;
  const nInvitadosPresentes = presentesIds.size - nPresentesInscritos;
  const pct = inscritos.length ? nPresentesInscritos / inscritos.length : 0;
  const delStaff = asistencias.filter((a) => a.origen === "manual" || a.origen === "correccion").length;
  const nAnuladas = todasFilas.filter((a) => a.estado === "anulada").length;

  function recargar() {
    base.reload();
  }
  useRefrescoAlVolver(recargar);

  async function cambiarTipo(t: TipoJornada) {
    setTipoLocal({ dia, tipo: t });
    try {
      await api.fijarJornada(dia, t);
      notificar(`Jornada marcada como ${t === "partido" ? "partido" : "entrenamiento"}`);
    } catch (e) {
      setTipoLocal(null);
      notificar(textoError(e, "No se pudo cambiar el tipo de jornada."), "err");
    }
  }

  async function marcar(j: Jugador) {
    try {
      await api.marcarAsistencia(j.id);
      notificar(`${j.nombre} marcado`);
      recargar();
    } catch (e) {
      notificar(textoError(e, "No se pudo marcar."), "err");
    }
  }

  function exportar() {
    descargarCsv(`asistencia_${dia}.csv`, [
      ["fecha_hora", "nombre", "categoria", "registro"],
      ...[...asistencias].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).map((a) => [a.timestamp, a.nombre, a.categoria, ORIGEN[a.origen ?? "facial"]]),
    ]);
  }

  if (base.error && !data) return <ErrorCarga error={base.error} reintentar={base.reload} />;

  return (
    <>
      <PageHeader titulo="Asistencia" descripcion="Quién vino y quién falta, día por día.">
        <input
          type="date"
          className="s-input"
          style={{ width: 160 }}
          aria-label="Día"
          value={dia}
          max={hoy}
          onChange={(e) => e.target.value && setDia(e.target.value)}
        />
        <Button onClick={recargar} aria-label="Actualizar">
          <RefreshCw size={15} aria-hidden /> Actualizar
        </Button>
        <BotonAyuda id="asistencia" />
      </PageHeader>
      <Tour id="asistencia" pasos={PASOS} />

      {esHoy && (
        <nav className="s-cancha" aria-label="Accesos rápidos de la cancha" data-tour="cancha">
          <Button
            className="s-cancha-btn"
            data-hay={nPend > 0 ? "" : undefined}
            onClick={() => {
              const el = document.getElementById("pendientes");
              if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
              else notificar("No hay llegadas por revisar", "info");
            }}
          >
            <BellRing size={17} aria-hidden />
            <span>Pendientes</span>
            <span className="s-cancha-n" aria-label={`${nPend} por revisar`}>{nPend}</span>
          </Button>
          <NinoNuevo onCreado={recargar} className="s-cancha-btn" />
          <Button className="s-cancha-btn" onClick={() => setMarcando(true)}>
            <PenLine size={17} aria-hidden />
            <span>Marcar a mano</span>
          </Button>
        </nav>
      )}
      <MarcarRapido abierto={marcando} onCerrar={() => setMarcando(false)} onCambio={recargar} />

      {pendientes.length > 0 && <PorRevisar pendientes={pendientes} />}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
        <div data-tour="jornada" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span className="muted">Jornada</span>
          <Segmentado
            etiqueta="Tipo de jornada"
            valor={tipo}
            onChange={cambiarTipo}
            opciones={[
              { valor: "entrenamiento", texto: "Entrenamiento" },
              { valor: "partido", texto: "Partido" },
            ]}
          />
        </div>
        <FiltroCategorias categorias={categorias} valor={cats} onChange={setCats} />
      </div>

      <div className="s-grid c4">
        {[
          ["Presentes", data ? nPresentesInscritos : null, nInvitadosPresentes > 0 ? `Más ${nInvitadosPresentes} invitado${nInvitadosPresentes === 1 ? "" : "s"} (no cuentan)` : "Niños inscritos"],
          ["Ausentes", data ? ausentes.length : null, "Niños inscritos"],
          ["Asistencia", data ? `${Math.round(pct * 100)}%` : null, "Solo niños inscritos; los invitados no cuentan"],
          ["Marcados por el staff", data ? delStaff : null, "Si es alto, revisa luz y fotos."],
        ].map(([k, v, h]) => (
          <div key={k as string} className="s-card s-stat">
            <div className="k">{k}</div>
            <div className="v">{v ?? "—"}</div>
            <div className="h">{h || " "}</div>
          </div>
        ))}
      </div>

      <div className="s-split">
        <section className="s-card" aria-labelledby="pres">
          <div className="s-card-h">
            <h2 id="pres">Presentes ({presentesIds.size})</h2>
            <div className="s-row">
              <label className="s-check" style={{ minHeight: 44 }}>
                <input type="checkbox" checked={verAnuladas} onChange={(e) => setVerAnuladas(e.target.checked)} />
                <span>Ver anuladas{verAnuladas && nAnuladas ? ` (${nAnuladas})` : ""}</span>
              </label>
              <Button sm onClick={exportar} disabled={!asistencias.length}>
                <Download size={14} aria-hidden /> CSV
              </Button>
            </div>
          </div>
          {base.cargando && !data ? (
            <SkeletonRows />
          ) : todasFilas.length === 0 ? (
            <Vacio icono={<Clock size={18} />} titulo={esHoy ? "Nadie ha llegado todavía" : "Sin registros"} texto="Los niños aparecerán aquí al marcar en el kiosko. ¿Vino alguien nuevo? Usa «Niño nuevo»." />
          ) : (
            <div className="s-table-wrap">
              <table className="s-table">
                <thead>
                  <tr>
                    <th>Hora</th>
                    <th>Nombre</th>
                    <th className="hide-sm">Categoría</th>
                    <th>Cómo</th>
                    <th className="act">
                      <span className="sr-only">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...todasFilas]
                    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
                    .map((a, idx) => {
                      const anulada = a.estado === "anulada";
                      const disputada = a.estado === "disputada";
                      return (
                        <tr key={a.id} style={anulada ? { opacity: 0.55 } : undefined}>
                          <td className="tnum">{hora(a.timestamp)}</td>
                          <td>
                            <div className="s-person">
                              <Avatar nombre={a.nombre} />
                              <div>
                                <b style={anulada ? { textDecoration: "line-through" } : undefined}>{a.nombre}</b>
                                {a.motivo && anulada && <small>Motivo: {a.motivo}</small>}
                              </div>
                              {a.jugador_estado === "invitado" && <BadgeInvitado />}
                            </div>
                          </td>
                          <td className="hide-sm muted">{a.categoria ?? "—"}</td>
                          <td>
                            {anulada ? (
                              <Badge tono="err">Anulada</Badge>
                            ) : disputada ? (
                              <Badge tono="warn">En revisión</Badge>
                            ) : (
                              <Badge tono={a.origen && a.origen !== "facial" ? "warn" : undefined}>{ORIGEN[a.origen ?? "facial"]}</Badge>
                            )}
                          </td>
                          <td className="act">
                            {!anulada && (
                              <Button sm variante="ghost" data-tour={idx === 0 ? "anular" : undefined} aria-label={`Anular la asistencia de ${a.nombre}`} onClick={() => setAnular(a)}>
                                <Ban size={14} aria-hidden /> Anular
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="s-card" aria-labelledby="falt" data-tour="faltan">
          <div className="s-card-h">
            <div>
              <h2 id="falt">Faltan ({ausentes.length})</h2>
              {esHoy && ausentes.length > 0 && <p>¿Llegó pero la cámara no lo reconoció? Márcalo a mano.</p>}
            </div>
          </div>
          {base.cargando && !data ? (
            <SkeletonRows />
          ) : ausentes.length === 0 ? (
            <Vacio icono={<Check size={18} />} titulo={inscritos.length ? "Vinieron todos" : "No hay jugadores"} texto={inscritos.length ? undefined : "Inscribe jugadores para tomar asistencia."} />
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 480, overflowY: "auto" }}>
              {ausentes.map((j) => (
                <li key={j.id} className="s-row" style={{ padding: "8px 14px", borderBottom: "1px solid var(--line)", justifyContent: "space-between" }}>
                  <div className="s-person">
                    <Avatar nombre={j.nombre} />
                    <div>
                      <b>{j.nombre}</b>
                      <small>{j.categoria ?? "Sin categoría"}</small>
                    </div>
                  </div>
                  {esHoy && (
                    <Button sm onClick={() => marcar(j)} aria-label={`Marcar a ${j.nombre}`}>
                      <CircleCheck size={14} aria-hidden /> Marcar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <DialogoAnular
        a={anular}
        onCerrar={() => setAnular(null)}
        onListo={() => {
          setAnular(null);
          recargar();
        }}
      />
    </>
  );
}

function DialogoAnular({ a, onCerrar, onListo }: { a: Asistencia | null; onCerrar: () => void; onListo: () => void }) {
  return (
    <Dialogo abierto={!!a} onCerrar={onCerrar} titulo="Anular asistencia">
      {a && <FormAnular key={a.id} a={a} onCerrar={onCerrar} onListo={onListo} />}
    </Dialogo>
  );
}

function FormAnular({ a, onCerrar, onListo }: { a: Asistencia; onCerrar: () => void; onListo: () => void }) {
  const notificar = useToast();
  const [motivo, setMotivo] = useState("");
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function enviar() {
    setTrabajando(true);
    setError(null);
    try {
      await api.anularAsistencia(a.id, motivo.trim());
      notificar(`Asistencia de ${a.nombre} anulada`);
      onListo();
    } catch (e) {
      setError(textoError(e, "No se pudo anular."));
      setTrabajando(false);
    }
  }
  return (
    <>
      <p className="muted">
        La asistencia de <b style={{ color: "var(--fg)" }}>{a.nombre}</b> de las {hora(a.timestamp)} dejará de contar en los reportes. No se borra: queda registrada como anulada.
      </p>
      {error && <Alerta tono="err">{error}</Alerta>}
      <Campo etiqueta="Motivo (opcional)">
        {(id) => <input id={id} className="s-input" value={motivo} maxLength={150} placeholder="Ej: la marcaron por error" autoComplete="off" onChange={(e) => setMotivo(e.target.value)} />}
      </Campo>
      <div className="s-dialog-f s-dialog-f-in">
        <Button onClick={onCerrar}>Cancelar</Button>
        <Button variante="danger" cargando={trabajando} onClick={enviar}>
          Anular asistencia
        </Button>
      </div>
    </>
  );
}

function PorRevisar({ pendientes }: { pendientes: Pendiente[] }) {
  return (
    <section className="s-card" aria-labelledby="rev" data-tour="pendientes" id="pendientes">
      <div className="s-card-h">
        <div>
          <h2 id="rev" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <BellRing size={15} aria-hidden /> Por revisar ({pendientes.length})
          </h2>
          <p>Tú decides quién es: se registra su asistencia y el sistema aprende su cara. Los más antiguos van primero.</p>
        </div>
      </div>
      <div className="s-card-b s-grid c3">
        {pendientes.map((p) => (
          <div key={p.id} className="s-pend" data-motivo={p.motivo ?? "no_reconocido"}>
            <div className="s-row">
              <MiniaturaPendiente p={p} />
              <div>
                <b>{textoMotivo(p)}</b>
                <div className="muted" style={{ fontSize: 13 }}>Llegó a las {hora(p.timestamp)}</div>
                {p.motivo === "no_soy_yo" || p.disputa_de ? (
                  <div className="s-pend-aviso">
                    {p.disputa_de?.nombre ? `El kiosko lo reconoció como ${p.disputa_de.nombre}, pero el niño dijo que no era él.` : "El niño dijo que el kiosko se equivocó."}
                  </div>
                ) : p.motivo === "nino_nuevo" ? (
                  <div className="muted" style={{ fontSize: 13 }}>Dijo que es la primera vez que viene.</div>
                ) : null}
                {p.sugerido && p.motivo !== "nino_nuevo" && <div className="muted" style={{ fontSize: 13 }}>{p.motivo === "no_soy_yo" || p.disputa_de ? "Podría ser" : "¿Será"} {p.sugerido.nombre}?</div>}
              </div>
            </div>
            <AccionesPendiente p={p} />
          </div>
        ))}
      </div>
    </section>
  );
}
