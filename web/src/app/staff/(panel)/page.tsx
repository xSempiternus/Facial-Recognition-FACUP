"use client";

import { ArrowRight, BellRing, CalendarCheck, Users } from "lucide-react";
import Link from "next/link";
import { Avatar, Badge, ErrorCarga, PageHeader, Skeleton, SkeletonRows, Vacio, useQuery } from "@/components/staff/ui";
import { aISO, api, hora } from "@/lib/staff-api";

const ORIGEN = { facial: "Cámara", manual: "Manual", correccion: "Revisado" } as const;

async function cargar() {
  const [jugadores, hoy, pendientes] = await Promise.all([
    api.jugadores(),
    api.asistencias(aISO(new Date())),
    api.pendientes(),
  ]);
  return { jugadores, hoy, pendientes };
}

export default function Resumen() {
  const { data, error, cargando, reload } = useQuery(cargar);

  if (error && !data) return <ErrorCarga error={error} reintentar={reload} />;

  const total = data?.jugadores.length ?? 0;
  const llegadas = data?.hoy.length ?? 0;

  return (
    <>
      <PageHeader titulo="Resumen" descripcion="Cómo va la jornada de hoy." />
      <div className="s-grid c3 kpi">
        <Link href="/staff/asistencia" className="s-card s-stat">
          <div className="k">Llegadas hoy</div>
          <div className="v">{data ? llegadas : <Skeleton w={50} h={30} />}</div>
          <div className="h">{data ? `de ${total} jugadores` : " "}</div>
        </Link>
        <Link href="/staff/asistencia" className="s-card s-stat">
          <div className="k">Por revisar</div>
          <div className="v">{data ? data.pendientes.length : <Skeleton w={50} h={30} />}</div>
          <div className="h">{data?.pendientes.length ? "Llegadas que la cámara no reconoció" : "Todo al día"}</div>
        </Link>
        <Link href="/staff/jugadores" className="s-card s-stat">
          <div className="k">Jugadores</div>
          <div className="v">{data ? total : <Skeleton w={50} h={30} />}</div>
          <div className="h">{data ? `${data.jugadores.filter((j) => !j.compatible).length} sin fotos para el modelo actual` : " "}</div>
        </Link>
      </div>

      {data && data.pendientes.length > 0 && (
        <div className="s-alert warn">
          <BellRing size={16} aria-hidden />
          <div>
            Hay {data.pendientes.length} llegada(s) por revisar.{" "}
            <Link href="/staff/asistencia" style={{ color: "inherit", fontWeight: 600 }}>
              Revisar ahora
            </Link>
          </div>
        </div>
      )}

      <section className="s-card" aria-labelledby="ult">
        <div className="s-card-h">
          <h2 id="ult">Últimas llegadas de hoy</h2>
          <Link className="s-btn ghost sm" href="/staff/asistencia">
            Ver asistencia <ArrowRight size={14} aria-hidden />
          </Link>
        </div>
        {cargando && !data ? (
          <SkeletonRows />
        ) : !data || data.hoy.length === 0 ? (
          <Vacio icono={<CalendarCheck size={18} />} titulo="Nadie ha llegado todavía" texto="Los niños aparecerán aquí al marcar su llegada en el kiosko." />
        ) : (
          <div className="s-table-wrap">
            <table className="s-table">
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Jugador</th>
                  <th className="hide-sm">Categoría</th>
                  <th>Registro</th>
                </tr>
              </thead>
              <tbody>
                {data.hoy.slice(0, 8).map((a) => (
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

      {data && total === 0 && (
        <div className="s-card">
          <Vacio icono={<Users size={18} />} titulo="Todavía no hay jugadores" texto="Inscribe al primero para empezar a tomar asistencia.">
            <Link className="s-btn primary" href="/staff/inscribir">
              Inscribir jugador
            </Link>
          </Vacio>
        </div>
      )}
    </>
  );
}
