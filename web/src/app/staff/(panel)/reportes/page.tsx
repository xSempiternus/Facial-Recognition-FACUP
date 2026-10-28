"use client";

import { CalendarX, Download, PhoneCall } from "lucide-react";
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
} from "@/components/staff/ui";
import { aISO, api, descargarCsv, diaMes, ordenarCategorias, sumarDias } from "@/lib/staff-api";

type Periodo = "7d" | "30d" | "mes" | "otro";
type Tipo = "todos" | "entrenamiento" | "partido";

export default function Reportes() {
  const hoy = aISO(new Date());
  const [periodo, setPeriodo] = useState<Periodo>("30d");
  const [tipo, setTipo] = useState<Tipo>("todos");
  const [cats, setCats] = useState<string[]>([]);
  const [d1, setD1] = useState(sumarDias(hoy, -29));
  const [d2, setD2] = useState(hoy);

  const [desde, hasta] =
    periodo === "7d" ? [sumarDias(hoy, -6), hoy] : periodo === "30d" ? [sumarDias(hoy, -29), hoy] : periodo === "mes" ? [`${hoy.slice(0, 8)}01`, hoy] : [d1, d2];
  const rangoValido = desde <= hasta;

  const { data, error, cargando, reload } = useQuery(() => (rangoValido ? api.reporte(desde, hasta, tipo) : Promise.reject(new Error("rango"))), `${desde}|${hasta}|${tipo}`);

  const categorias = useMemo(() => ordenarCategorias(new Set((data?.jugadores ?? []).map((j) => j.categoria).filter((c): c is string => !!c))), [data]);
  const jugadores = (data?.jugadores ?? []).filter((j) => !cats.length || (j.categoria && cats.includes(j.categoria)));
  const conDato = jugadores.filter((j) => j.porcentaje !== null);
  const promedio = conDato.length ? conDato.reduce((s, j) => s + (j.porcentaje ?? 0), 0) / conDato.length : 0;
  const alertas = jugadores.filter((j) => j.alerta);
  const maxDia = Math.max(1, ...(data?.dias ?? []).map((d) => d.presentes));

  function exportar() {
    if (!data) return;
    descargarCsv(`reporte_${data.desde}_${data.hasta}_${tipo}.csv`, [
      ["nombre", "categoria", "presentes", "posibles", "porcentaje", "ausencias_seguidas", "ultima"],
      ...jugadores.map((j) => [j.nombre, j.categoria, j.presentes, j.posibles, j.porcentaje, j.ausencias_seguidas, j.ultima]),
    ]);
  }

  if (error && !data && rangoValido) return <ErrorCarga error={error} reintentar={reload} />;

  return (
    <>
      <PageHeader titulo="Reportes" descripcion="¿Quién viene seguido y quién está faltando?">
        <Button onClick={exportar} disabled={!data || !jugadores.length}>
          <Download size={15} aria-hidden /> Descargar CSV
        </Button>
      </PageHeader>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <Segmentado<Periodo>
          etiqueta="Período"
          valor={periodo}
          onChange={setPeriodo}
          opciones={[
            { valor: "7d", texto: "7 días" },
            { valor: "30d", texto: "30 días" },
            { valor: "mes", texto: "Este mes" },
            { valor: "otro", texto: "Personalizado" },
          ]}
        />
        <Segmentado<Tipo>
          etiqueta="Tipo de jornada"
          valor={tipo}
          onChange={setTipo}
          opciones={[
            { valor: "todos", texto: "Todas" },
            { valor: "entrenamiento", texto: "Entrenamientos" },
            { valor: "partido", texto: "Partidos" },
          ]}
        />
        {periodo === "otro" && (
          <div className="s-row">
            <input type="date" className="s-input" style={{ width: 150 }} aria-label="Desde" value={d1} max={d2} onChange={(e) => e.target.value && setD1(e.target.value)} />
            <span className="muted">–</span>
            <input type="date" className="s-input" style={{ width: 150 }} aria-label="Hasta" value={d2} min={d1} max={hoy} onChange={(e) => e.target.value && setD2(e.target.value)} />
          </div>
        )}
      </div>
      <FiltroCategorias categorias={categorias} valor={cats} onChange={setCats} />

      {cargando && !data ? (
        <div className="s-card">
          <SkeletonRows n={8} />
        </div>
      ) : !data || data.dias.length === 0 ? (
        <div className="s-card">
          <Vacio icono={<CalendarX size={18} />} titulo="Sin actividad en este período" texto="Cuando los niños marquen su llegada, aquí verás quién viene seguido y quién falta." />
        </div>
      ) : (
        <>
          <div className="s-grid c4">
            {[
              ["Días de actividad", data.dias.length, "Con al menos una llegada"],
              ["Asistencia promedio", `${Math.round(promedio * 100)}%`, ""],
              ["Jugadores", jugadores.length, ""],
              [`Faltaron ${data.umbral_ausencias}+ seguidas`, alertas.length, "Desde el último día de actividad"],
            ].map(([k, v, h]) => (
              <div key={k as string} className="s-card s-stat">
                <div className="k">{k}</div>
                <div className="v">{v}</div>
                <div className="h">{h || " "}</div>
              </div>
            ))}
          </div>

          {alertas.length > 0 && (
            <section className="s-card" aria-labelledby="llamar">
              <div className="s-card-h">
                <div>
                  <h2 id="llamar" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <PhoneCall size={15} aria-hidden /> Para llamar ({alertas.length})
                  </h2>
                  <p>Faltaron a los últimos entrenamientos o partidos seguidos. Quizás valga la pena hablar con la familia.</p>
                </div>
              </div>
              <div className="s-card-b s-grid c3">
                {alertas.map((j) => (
                  <div key={j.id} className="s-pend">
                    <div className="s-person">
                      <Avatar nombre={j.nombre} />
                      <div>
                        <b>{j.nombre}</b>
                        <small>{j.ultima ? `Última vez ${diaMes(j.ultima)}` : "No ha venido en el período"}</small>
                      </div>
                    </div>
                    <div>
                      <Badge tono="err">{j.ausencias_seguidas} faltas seguidas</Badge>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="s-card" aria-labelledby="pordia">
            <div className="s-card-h">
              <h2 id="pordia">Asistencia por día</h2>
              <span className="muted" style={{ fontSize: 12 }}>
                Verde: entrenamiento · Gris: partido
              </span>
            </div>
            <div className="s-card-b">
              <div className="s-chart" role="img" aria-label={`Presentes por día: ${data.dias.map((d) => `${diaMes(d.fecha)} ${d.presentes}`).join(", ")}`}>
                {data.dias.map((d) => (
                  <div key={d.fecha} className={`col ${d.tipo}`} title={`${diaMes(d.fecha)}: ${d.presentes} presentes (${d.tipo})`}>
                    <b className="tnum">{d.presentes}</b>
                    <i style={{ height: `${(d.presentes / maxDia) * 100}px` }} />
                    <small>{diaMes(d.fecha)}</small>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="s-card" aria-labelledby="porjug">
            <div className="s-card-h">
              <div>
                <h2 id="porjug">Por jugador</h2>
                <p>Solo se cuentan los días desde que cada niño se inscribió. De menor a mayor asistencia.</p>
              </div>
            </div>
            <div className="s-table-wrap">
              <table className="s-table">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th className="hide-sm">Categoría</th>
                    <th>Asistencia</th>
                    <th className="hide-sm">Vino</th>
                    <th className="num">Faltas seg.</th>
                    <th className="hide-sm">Última vez</th>
                  </tr>
                </thead>
                <tbody>
                  {jugadores.map((j) => {
                    const p = j.porcentaje === null ? null : Math.round(j.porcentaje * 100);
                    return (
                      <tr key={j.id}>
                        <td>
                          <div className="s-person">
                            <Avatar nombre={j.nombre} />
                            <b>{j.nombre}</b>
                          </div>
                        </td>
                        <td className="hide-sm muted">{j.categoria ?? "—"}</td>
                        <td>
                          {p === null ? (
                            <span className="faint">—</span>
                          ) : (
                            <div className="s-row" style={{ gap: 8 }}>
                              <div className={`s-bar ${p < 50 ? "low" : ""}`} style={{ flex: 1 }} aria-hidden>
                                <i style={{ width: `${p}%` }} />
                              </div>
                              <span className="tnum" style={{ width: 38, textAlign: "right" }}>
                                {p}%
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="hide-sm muted tnum">
                          {j.presentes} de {j.posibles}
                        </td>
                        <td className="num">{j.alerta ? <Badge tono="err">{j.ausencias_seguidas}</Badge> : j.ausencias_seguidas}</td>
                        <td className="hide-sm muted tnum">{j.ultima ? diaMes(j.ultima) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
