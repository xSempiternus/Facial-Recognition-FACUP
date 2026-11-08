"use client";

import { CalendarX, Check, ChevronDown, Copy, Download, HeartHandshake } from "lucide-react";
import { useMemo, useState } from "react";
import { BarrasCategoria, Histograma, Metodos } from "@/components/staff/graficos/Barras";
import { DetalleDia, DetalleNino } from "@/components/staff/graficos/Detalles";
import { Hoja } from "@/components/staff/graficos/Hoja";
import { Matriz } from "@/components/staff/graficos/Matriz";
import { Tendencia } from "@/components/staff/graficos/Tendencia";
import { Avatar, Badge, Button, ErrorCarga, PageHeader, Segmentado, Skeleton, Vacio, useQuery, useToast } from "@/components/staff/ui";
import { api, descargarCsv, ordenarCategorias } from "@/lib/staff-api";
import {
  PERIODOS,
  cargarSeguimiento,
  fechaCorta,
  fraseResumen,
  mensajeApoderado,
  pct0,
  plural,
  type NinoResumen,
  type Periodo,
} from "@/lib/staff-api-seguimiento";
import "../../seguimiento.css";

export default function Seguimiento() {
  const [periodo, setPeriodo] = useState<Periodo>("4s");
  const [cat, setCat] = useState("");
  const [dia, setDia] = useState<string | null>(null);
  const [nino, setNino] = useState<NinoResumen | null>(null);
  const [copiado, setCopiado] = useState<number | null>(null);
  const toast = useToast();

  const cats = useQuery(() => api.categorias(), "cats");
  const nombresCat = useMemo(() => ordenarCategorias((cats.data ?? []).filter((c) => c.activa).map((c) => c.nombre)), [cats.data]);
  const { data, error, cargando, reload } = useQuery(() => cargarSeguimiento(periodo, cat), `${periodo}|${cat}`);

  const act = data?.actual;
  const fechas = useMemo(() => (act?.jornadas ?? []).map((j) => j.fecha).sort(), [act]);
  const frasePeriodo = PERIODOS.find((p) => p.valor === periodo)!.frase;
  const jornadaDia = dia ? act?.jornadas.find((j) => j.fecha === dia) : undefined;

  async function copiar(n: { id: number; nombre: string; faltas_seguidas: number }) {
    const texto = mensajeApoderado(n.nombre);
    try {
      await navigator.clipboard.writeText(texto);
    } catch {
      const t = document.createElement("textarea");
      t.value = texto;
      t.style.position = "fixed";
      t.style.opacity = "0";
      document.body.appendChild(t);
      t.select();
      try {
        document.execCommand("copy");
      } catch {
        toast("No se pudo copiar. Inténtalo de nuevo.", "err");
        t.remove();
        return;
      }
      t.remove();
    }
    setCopiado(n.id);
    toast("Mensaje copiado. Pégalo en WhatsApp o donde prefieras.", "ok");
    setTimeout(() => setCopiado((c) => (c === n.id ? null : c)), 2500);
  }

  function exportar() {
    if (!act) return;
    descargarCsv(`seguimiento_${act.rango.desde}_${act.rango.hasta}.csv`, [
      ["nombre", "categoria", "presentes", "posibles", "porcentaje", "ausencias_seguidas", "ultima"],
      ...act.ninos.map((j) => [j.nombre, j.categoria, j.presentes, j.jornadas_total, j.porcentaje, j.faltas_seguidas, j.ultima_asistencia]),
    ]);
  }

  const filtros = (
    <div className="sg-filtros">
      <Segmentado<Periodo> etiqueta="Periodo" valor={periodo} onChange={setPeriodo} opciones={PERIODOS.map((p) => ({ valor: p.valor, texto: p.texto }))} />
      {nombresCat.length > 0 && (
        <div className="s-chips" role="group" aria-label="Categoría">
          {["", ...nombresCat].map((c) => (
            <button key={c || "todas"} type="button" className="s-chip" aria-pressed={cat === c} onClick={() => setCat(c)}>
              {c || "Todas"}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  if (error && !data) {
    return (
      <div className="sg">
        <PageHeader titulo="Seguimiento" descripcion="¿Cómo viene la asistencia y quién ha venido a cada jornada?" />
        {filtros}
        <ErrorCarga error={error} reintentar={reload} />
      </div>
    );
  }

  const vacio = act && act.totales.jornadas === 0;
  const riesgo = act?.en_riesgo ?? [];

  return (
    <div className="sg">
      <PageHeader titulo="Seguimiento" descripcion="¿Cómo viene la asistencia y quién ha venido a cada jornada?" />
      {filtros}

      {!act ? (
        <div className="sg-carga" aria-busy="true" aria-label="Cargando">
          <Skeleton h={22} w="70%" />
          <div className="sg-kpis">
            {[0, 1, 2].map((i) => (
              <div key={i} className="s-card s-stat">
                <Skeleton h={12} w="50%" />
                <div style={{ height: 8 }} />
                <Skeleton h={32} w="40%" />
              </div>
            ))}
          </div>
          <div className="s-card" style={{ padding: 20 }}>
            <Skeleton h={220} />
          </div>
        </div>
      ) : vacio ? (
        <div className="s-card">
          <Vacio icono={<CalendarX size={18} />} titulo="Aún no hay jornadas para mostrar" texto="Cuando los niños marquen su llegada, aquí verás cómo viene la asistencia. Prueba con otro periodo o categoría." />
        </div>
      ) : (
        <div className={`sg-cuerpo ${cargando ? "cargando" : ""}`} aria-busy={cargando}>
          <p className="sg-frase sg-in" style={{ ["--i" as string]: 0 }}>
            {fraseResumen(act, data?.previo ?? null, frasePeriodo)}
          </p>

          <div className="sg-kpis">
            <div className="s-card s-stat sg-in" style={{ ["--i" as string]: 1 }}>
              <div className="k">Asistencia promedio</div>
              <div className="v">{pct0(act.totales.promedio_asistencia)}</div>
              <div className="h">de {plural(act.totales.ninos_activos, "niño", "niños")} en total</div>
            </div>
            <div className="s-card s-stat sg-in" style={{ ["--i" as string]: 2 }}>
              <div className="k">Jornadas</div>
              <div className="v">{act.totales.jornadas}</div>
              <div className="h">entrenamientos en el periodo</div>
            </div>
            <div className="s-card s-stat sg-in" style={{ ["--i" as string]: 3 }}>
              <div className="k">Mejor jornada</div>
              <div className="v">{act.totales.mejor_jornada ? pct0(act.totales.mejor_jornada.porcentaje) : "—"}</div>
              <div className="h">{act.totales.mejor_jornada ? fechaCorta(act.totales.mejor_jornada.fecha) : "Sin datos"}</div>
            </div>
          </div>

          <section className="s-card sg-in" style={{ ["--i" as string]: 4 }} aria-labelledby="sg-t-tend">
            <div className="s-card-h">
              <div>
                <h2 id="sg-t-tend">Tendencia</h2>
                <p>Porcentaje de niños que vino en cada jornada. Toca un punto para ver quiénes vinieron.</p>
              </div>
            </div>
            <div className="s-card-b">
              <Tendencia jornadas={act.jornadas} mejor={act.totales.mejor_jornada?.fecha} peor={act.totales.peor_jornada?.fecha} onElegir={setDia} />
            </div>
          </section>

          <section className="s-card sg-in" style={{ ["--i" as string]: 5 }} aria-labelledby="sg-t-lin">
            <div className="s-card-h">
              <div>
                <h2 id="sg-t-lin">Quién ha venido, jornada a jornada</h2>
                <p>Cada fila es un niño. A la derecha está lo más reciente.</p>
              </div>
            </div>
            <div className="s-card-b sg-lin">
              <Matriz fechas={fechas} ninos={act.ninos} onNino={setNino} />
            </div>
          </section>

          <section className="s-card sg-in" style={{ ["--i" as string]: 6 }} aria-labelledby="sg-t-ate">
            <div className="s-card-h">
              <div>
                <h2 id="sg-t-ate" className="sg-h-ico">
                  <HeartHandshake size={16} aria-hidden /> Necesitan atención
                </h2>
                <p>Niños que faltaron 3 o más jornadas seguidas. Un mensaje amable puede ayudar.</p>
              </div>
              {riesgo.length > 0 && <Badge tono="warn">{riesgo.length}</Badge>}
            </div>
            <div className="s-card-b">
              {riesgo.length === 0 ? (
                <p className="muted">Nadie está faltando seguido. ¡Buen momento!</p>
              ) : (
                <ul className="sg-riesgo">
                  {riesgo.map((r) => {
                    const ult = act.ninos.find((n) => n.id === r.id)?.ultima_asistencia;
                    return (
                      <li key={r.id}>
                        <Avatar nombre={r.nombre} />
                        <div className="sg-r-t">
                          <b>{r.nombre}</b>
                          <small className="muted">
                            Faltó {r.faltas_seguidas === 1 ? "la última jornada" : `las últimas ${r.faltas_seguidas} jornadas`}
                            {ult ? ` · Última vez: ${fechaCorta(ult)}` : " · Sin asistencias en el periodo"}
                          </small>
                        </div>
                        <Button sm onClick={() => copiar(r)} aria-label={`Copiar mensaje para el apoderado de ${r.nombre}`}>
                          {copiado === r.id ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                          {copiado === r.id ? "Copiado" : "Copiar mensaje"}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          <details className="s-card sg-mas sg-in" style={{ ["--i" as string]: 7 }}>
            <summary>
              <span>
                <b>Más detalle</b>
                <small className="muted">Por categoría, hora de llegada, cómo se registró y exportar</small>
              </span>
              <ChevronDown size={18} aria-hidden />
            </summary>
            <div className="sg-mas-b">
              <div className="sg-bloque">
                <h3>Por categoría</h3>
                <BarrasCategoria categorias={act.categorias} />
              </div>
              <div className="sg-bloque">
                <h3>Hora de llegada</h3>
                <Histograma datos={act.llegada.histograma} mediana={act.llegada.mediana} />
              </div>
              <div className="sg-bloque">
                <h3>Cómo se registró</h3>
                <Metodos metodos={act.metodos} />
              </div>
              <div className="sg-bloque">
                <h3>Exportar</h3>
                <p className="muted">Descarga una planilla (CSV) con la asistencia de cada niño en este periodo, lista para abrir en Excel.</p>
                <Button onClick={exportar} disabled={!act.ninos.length}>
                  <Download size={15} aria-hidden /> Descargar CSV
                </Button>
              </div>
            </div>
          </details>
        </div>
      )}

      <Hoja abierta={!!jornadaDia} onCerrar={() => setDia(null)} titulo={dia ? fechaCorta(dia) : ""} subtitulo="Quiénes vinieron y quiénes faltaron">
        {jornadaDia && act && <DetalleDia key={jornadaDia.fecha} jornada={jornadaDia} ninos={act.ninos} />}
      </Hoja>
      <Hoja abierta={!!nino} onCerrar={() => setNino(null)} titulo={nino?.nombre ?? ""} subtitulo={nino?.categoria ?? undefined}>
        {nino && <DetalleNino nino={nino} fechas={fechas} />}
      </Hoja>
    </div>
  );
}
