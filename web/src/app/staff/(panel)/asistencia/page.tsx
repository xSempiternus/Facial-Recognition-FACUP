"use client";

import { BellRing, Check, CircleCheck, Clock, Download, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  ErrorCarga,
  FiltroCategorias,
  PageHeader,
  Segmentado,
  SkeletonRows,
  Vacio,
  useQuery,
  useToast,
} from "@/components/staff/ui";
import {
  ApiError,
  aISO,
  api,
  descargarCsv,
  hora,
  ordenarCategorias,
  type Jugador,
  type Pendiente,
  type TipoJornada,
} from "@/lib/staff-api";

const ORIGEN = { facial: "Cámara", manual: "Manual", correccion: "Revisado" } as const;

export default function Asistencia() {
  const notificar = useToast();
  const hoy = aISO(new Date());
  const [dia, setDia] = useState(hoy);
  const [cats, setCats] = useState<string[]>([]);
  const esHoy = dia === hoy;

  const base = useQuery(async () => {
    const [jugadores, asistencias, tipos] = await Promise.all([api.jugadores(), api.asistencias(dia), api.tipoJornada(dia)]);
    return { jugadores, asistencias, tipo: (tipos[dia] ?? "entrenamiento") as TipoJornada };
  }, dia);
  const pend = useQuery(api.pendientes);
  const [tipoLocal, setTipoLocal] = useState<{ dia: string; tipo: TipoJornada } | null>(null);

  const data = base.data;
  const tipo = tipoLocal?.dia === dia ? tipoLocal.tipo : data?.tipo ?? "entrenamiento";

  const categorias = useMemo(() => ordenarCategorias(new Set((data?.jugadores ?? []).map((j) => j.categoria).filter((c): c is string => !!c))), [data]);
  const enCat = (c: string | null) => !cats.length || (c !== null && cats.includes(c));
  const jugadores = (data?.jugadores ?? []).filter((j) => enCat(j.categoria));
  const asistencias = (data?.asistencias ?? []).filter((a) => enCat(a.categoria));
  const presentesIds = new Set(asistencias.map((a) => a.jugador_id));
  const ausentes = jugadores.filter((j) => !presentesIds.has(j.id));
  const pct = jugadores.length ? presentesIds.size / jugadores.length : 0;
  const delStaff = asistencias.filter((a) => a.origen === "manual" || a.origen === "correccion").length;

  function recargar() {
    base.reload();
    pend.reload();
  }

  async function cambiarTipo(t: TipoJornada) {
    setTipoLocal({ dia, tipo: t });
    try {
      await api.fijarJornada(dia, t);
      notificar(`Jornada marcada como ${t === "partido" ? "partido" : "entrenamiento"}`);
    } catch (e) {
      setTipoLocal(null);
      notificar(e instanceof ApiError ? e.message : "No se pudo cambiar el tipo de jornada.", "err");
    }
  }

  async function marcar(j: Jugador) {
    try {
      await api.marcarAsistencia(j.id);
      notificar(`${j.nombre} marcado`);
      recargar();
    } catch (e) {
      notificar(e instanceof ApiError ? e.message : "No se pudo marcar.", "err");
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
      </PageHeader>

      {data && pend.data && pend.data.length > 0 && <PorRevisar pendientes={pend.data} jugadores={data.jugadores} onCambio={recargar} />}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
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
          ["Presentes", data ? presentesIds.size : null, ""],
          ["Ausentes", data ? ausentes.length : null, ""],
          ["Asistencia", data ? `${Math.round(pct * 100)}%` : null, ""],
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
            <Button sm onClick={exportar} disabled={!asistencias.length}>
              <Download size={14} aria-hidden /> CSV
            </Button>
          </div>
          {base.cargando && !data ? (
            <SkeletonRows />
          ) : asistencias.length === 0 ? (
            <Vacio icono={<Clock size={18} />} titulo={esHoy ? "Nadie ha llegado todavía" : "Sin registros"} texto="Los niños aparecerán aquí al marcar en el kiosko." />
          ) : (
            <div className="s-table-wrap">
              <table className="s-table">
                <thead>
                  <tr>
                    <th>Hora</th>
                    <th>Nombre</th>
                    <th className="hide-sm">Categoría</th>
                    <th>Cómo</th>
                  </tr>
                </thead>
                <tbody>
                  {[...asistencias]
                    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
                    .map((a) => (
                      <tr key={a.id}>
                        <td className="tnum">{hora(a.timestamp)}</td>
                        <td>
                          <div className="s-person">
                            <Avatar nombre={a.nombre} />
                            <b>{a.nombre}</b>
                          </div>
                        </td>
                        <td className="hide-sm muted">{a.categoria ?? "—"}</td>
                        <td>
                          <Badge tono={a.origen && a.origen !== "facial" ? "warn" : undefined}>{ORIGEN[a.origen ?? "facial"]}</Badge>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="s-card" aria-labelledby="falt">
          <div className="s-card-h">
            <div>
              <h2 id="falt">Faltan ({ausentes.length})</h2>
              {esHoy && ausentes.length > 0 && <p>¿Llegó pero la cámara no lo reconoció? Márcalo a mano.</p>}
            </div>
          </div>
          {base.cargando && !data ? (
            <SkeletonRows />
          ) : ausentes.length === 0 ? (
            <Vacio icono={<Check size={18} />} titulo={jugadores.length ? "Vinieron todos" : "No hay jugadores"} texto={jugadores.length ? undefined : "Inscribe jugadores para tomar asistencia."} />
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
    </>
  );
}

function PorRevisar({ pendientes, jugadores, onCambio }: { pendientes: Pendiente[]; jugadores: Jugador[]; onCambio: () => void }) {
  const notificar = useToast();
  const [elegidos, setElegidos] = useState<Record<number, number>>({});
  const [ocupado, setOcupado] = useState<number | null>(null);
  const ordenados = useMemo(() => [...jugadores].sort((a, b) => a.nombre.localeCompare(b.nombre)), [jugadores]);

  async function confirmar(p: Pendiente, jugadorId: number) {
    setOcupado(p.id);
    try {
      const r = await api.asignarPendiente(p.id, jugadorId);
      notificar(`${r.nombre}: asistencia registrada${r.foto_guardada ? " y cara aprendida" : ""}`);
      if (r.motivo) notificar(r.motivo, "info");
    } catch (e) {
      notificar(e instanceof ApiError ? e.message : "No se pudo asignar.", "err");
    } finally {
      setOcupado(null);
      onCambio();
    }
  }
  async function descartar(p: Pendiente) {
    setOcupado(p.id);
    try {
      await api.descartarPendiente(p.id);
    } catch (e) {
      notificar(e instanceof ApiError ? e.message : "No se pudo descartar.", "err");
    } finally {
      setOcupado(null);
      onCambio();
    }
  }

  return (
    <section className="s-card" aria-labelledby="rev">
      <div className="s-card-h">
        <div>
          <h2 id="rev" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <BellRing size={15} aria-hidden /> Por revisar ({pendientes.length})
          </h2>
          <p>La cámara no reconoció a estos niños. Indica quién era: se registra su asistencia y el sistema aprende su cara. Se borran solas a las 2 horas.</p>
        </div>
      </div>
      <div className="s-card-b s-grid c3">
        {pendientes.map((p) => {
          const elegido = elegidos[p.id] ?? p.sugerido?.id;
          return (
            <div key={p.id} className="s-pend">
              <div className="s-row">
                {/* eslint-disable-next-line @next/next/no-img-element -- miniatura en base64 */}
                <img src={`data:image/jpeg;base64,${p.miniatura}`} alt="" />
                <div>
                  <b>Llegó a las {hora(p.timestamp)}</b>
                  {p.sugerido && <div className="muted" style={{ fontSize: 13 }}>¿Es {p.sugerido.nombre}?</div>}
                </div>
              </div>
              <select
                className="s-select"
                aria-label={`¿Quién es? Llegada de las ${hora(p.timestamp)}`}
                value={elegido ?? ""}
                onChange={(e) => setElegidos((m) => ({ ...m, [p.id]: Number(e.target.value) }))}
              >
                <option value="" disabled>
                  Elige al jugador…
                </option>
                {ordenados.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.nombre}
                  </option>
                ))}
              </select>
              <div className="s-row">
                <Button variante="brand" sm style={{ flex: 1 }} disabled={!elegido} cargando={ocupado === p.id} onClick={() => elegido && confirmar(p, elegido)}>
                  <Check size={14} aria-hidden /> Confirmar
                </Button>
                <Button sm icono variante="ghost" aria-label="Descartar (no era un jugador)" title="Descartar" disabled={ocupado === p.id} onClick={() => descartar(p)}>
                  <Trash2 size={15} />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
