"use client";

import { ArrowRight, BellRing, CalendarCheck, Users } from "lucide-react";
import Link from "next/link";
import { NinoNuevo } from "@/components/staff/NinoNuevo";
import { BotonAyuda, Tour, type PasoTour } from "@/components/staff/Tour";
import { usePendientes } from "@/components/staff/Pendientes";
import { Avatar, Badge, BadgeInvitado, ErrorCarga, PageHeader, Skeleton, SkeletonRows, Vacio, useQuery, useRefrescoAlVolver } from "@/components/staff/ui";
import { aISO, api, hora } from "@/lib/staff-api";

const ORIGEN = { facial: "Cámara", manual: "Manual", correccion: "Revisado", invitado: "Invitado" } as const;

const BIENVENIDA: PasoTour[] = [
  { selector: "[data-tour='menu']", titulo: "Bienvenido al panel", texto: "Desde este menú vas a cualquier parte: asistencia, jugadores, inscripciones, reportes y ajustes.", lado: "der" },
  { selector: "[data-tour='nino-nuevo']", titulo: "¿Llegó un niño nuevo?", texto: "Toca «Niño nuevo», anota su nombre y muestra el QR al apoderado: se inscribe desde su celular y el niño ya queda con asistencia hoy.", lado: "abajo" },
  { selector: "[data-tour='nav-asistencia']", titulo: "Pendientes de revisar", texto: "Si el kiosko no reconoce a alguien, o un niño dice «no soy yo», aparece en Asistencia, arriba. Indica quién era y listo.", lado: "der" },
  { selector: "[data-tour='nav-solicitudes']", titulo: "Inscripciones", texto: "Aquí llegan las solicitudes de los apoderados. Las revisas, avisamos si hay duplicados y las apruebas o rechazas.", lado: "der" },
  { selector: "[data-tour='nav-ajustes']", titulo: "Ajustes", texto: "Categorías, respaldos, reconocimiento y la actividad reciente del panel. Puedes ver esta guía de nuevo con el botón «?» de cada pantalla.", lado: "der" },
];

async function cargar() {
  const [jugadores, hoy, solicitudes] = await Promise.all([
    api.jugadores(),
    api.asistencias(aISO(new Date())),
    api.solicitudes().then((l) => l.length).catch(() => 0),
  ]);
  return { jugadores, hoy: hoy.filter((a) => a.estado !== "disputada"), solicitudes };
}

export default function Resumen() {
  const { total: nPend } = usePendientes();
  const { data, error, cargando, reload } = useQuery(cargar);
  useRefrescoAlVolver(reload);

  if (error && !data) return <ErrorCarga error={error} reintentar={reload} />;

  const total = data?.jugadores.length ?? 0;
  const llegadas = data?.hoy.length ?? 0;

  return (
    <>
      <PageHeader titulo="Resumen" descripcion="Cómo va la jornada de hoy.">
        <BotonAyuda id="bienvenida" />
        <NinoNuevo onCreado={reload} />
      </PageHeader>
      <Tour id="bienvenida" pasos={BIENVENIDA} auto />
      <div className="s-grid c4 kpi">
        <Link href="/staff/asistencia" className="s-card s-stat">
          <div className="k">Llegadas hoy</div>
          <div className="v">{data ? llegadas : <Skeleton w={50} h={30} />}</div>
          <div className="h">{data ? `de ${total} jugadores` : " "}</div>
        </Link>
        <Link href="/staff/asistencia" className="s-card s-stat">
          <div className="k">Por revisar</div>
          <div className="v">{data ? nPend : <Skeleton w={50} h={30} />}</div>
          <div className="h">{nPend ? "Llegadas que la cámara no reconoció" : "Todo al día"}</div>
        </Link>
        <Link href="/staff/solicitudes" className="s-card s-stat">
          <div className="k">Inscripciones</div>
          <div className="v">{data ? data.solicitudes : <Skeleton w={50} h={30} />}</div>
          <div className="h">{data ? (data.solicitudes ? "Solicitudes por aprobar" : "Sin solicitudes pendientes") : " "}</div>
        </Link>
        <Link href="/staff/jugadores" className="s-card s-stat">
          <div className="k">Jugadores</div>
          <div className="v">{data ? total : <Skeleton w={50} h={30} />}</div>
          <div className="h">{data ? `${data.jugadores.filter((j) => j.estado !== "invitado" && !j.compatible).length} sin fotos para el modelo actual` : " "}</div>
        </Link>
      </div>

      {data && nPend > 0 && (
        <div className="s-alert warn">
          <BellRing size={16} aria-hidden />
          <div>
            Hay {nPend} llegada(s) por revisar.{" "}
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
                        {a.jugador_estado === "invitado" && <BadgeInvitado />}
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
