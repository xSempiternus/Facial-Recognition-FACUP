"use client";

import { PenLine } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";
import { MarcarRapido } from "@/components/staff/MarcarRapido";
import { NinoNuevo } from "@/components/staff/NinoNuevo";
import { usePendientes } from "@/components/staff/Pendientes";
import { BotonAyuda, Tour, type PasoTour } from "@/components/staff/Tour";
import { Anillo } from "@/components/staff/hoy/Anillo";
import { Curva } from "@/components/staff/hoy/Curva";
import { ListaHoy } from "@/components/staff/hoy/ListaHoy";
import { PorRevisarHoy } from "@/components/staff/hoy/PorRevisarHoy";
import { RevisarTanda } from "@/components/staff/hoy/RevisarTanda";
import { ParaContactar } from "@/components/staff/ParaContactar";
import { Button, ErrorCarga, PageHeader, Skeleton } from "@/components/staff/ui";
import { useHoy } from "@/lib/staff-api-hoy";
import "../hoy.css";
import "../revisar.css";

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** «Domingo 8 de noviembre» a partir de la fecha del servidor (YYYY-MM-DD). */
function fechaLarga(iso: string | undefined): string {
  const d = iso ? new Date(`${iso}T12:00:00`) : new Date();
  const dia = DIAS[d.getDay()];
  return `${dia[0].toUpperCase()}${dia.slice(1)} ${d.getDate()} de ${MESES[d.getMonth()]}`;
}

const subMovil = (cb: () => void) => {
  const m = window.matchMedia("(max-width: 640px)");
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const esMovil = () => window.matchMedia("(max-width: 640px)").matches;

/** En el celular el menú es la barra de abajo; en escritorio, el lateral. */
function usePasos(): PasoTour[] {
  const movil = useSyncExternalStore(subMovil, esMovil, () => false);
  return useMemo(() => {
    const nav = (n: string) => `[data-tour='${movil ? "tab" : "nav"}-${n}']`;
    return [
      { selector: "[data-tour='hy-hero']", titulo: "Bienvenido: esto es «Hoy»", texto: "El día de un vistazo: cuántos niños llegaron y quién falta. Se actualiza solo.", lado: "abajo" },
      { selector: "[data-tour='hy-acciones']", titulo: "Lo que más vas a usar", texto: "«Niño nuevo» anota a quien llega a probarse y muestra un QR para su apoderado. «Marcar a mano» sirve cuando la cámara no lo reconoció.", lado: "abajo" },
      { selector: "[data-tour='hy-lista']", titulo: "Quién llegó y quién falta", texto: "Toca a un niño para marcarlo presente o anular un error. Si la cámara no reconoce a alguien, aparece arriba en «Por revisar».", lado: "arriba" },
      { selector: nav("ninos"), titulo: "Niños", texto: "Todos los niños inscritos y las solicitudes de los apoderados por aprobar (el número te avisa cuántas hay).", lado: movil ? "arriba" : "der" },
      { selector: nav("seguimiento"), titulo: "Seguimiento y Ajustes", texto: "Seguimiento muestra cómo viene la asistencia en el tiempo. En Ajustes están las categorías, los respaldos y esta guía, que puedes ver de nuevo con el botón «?».", lado: movil ? "arriba" : "der" },
    ];
  }, [movil]);
}

export default function Hoy() {
  const { cambios } = usePendientes();
  const { data, error, reload } = useHoy(cambios);
  const [marcando, setMarcando] = useState(false);
  const pasos = usePasos();

  if (error && !data) return <ErrorCarga error={error} reintentar={reload} />;

  return (
    <>
      <PageHeader titulo="Hoy" descripcion={fechaLarga(data?.fecha)}>
        <BotonAyuda id="bienvenida" />
      </PageHeader>
      <Tour id="bienvenida" pasos={pasos} auto />

      <section className="s-card hy-hero" aria-label="Llegadas de hoy" data-tour="hy-hero">
        {data ? (
          <>
            <Anillo llegaron={data.llegaron.length} esperados={data.esperados} />
            <div className="hy-hero-t">
              <div className="hy-leyenda">llegaron hoy</div>
              <div className="hy-pct tnum">{data.esperados ? `${data.porcentaje}%` : "—"}</div>
              <div className="hy-ultima tnum">{data.ultima_llegada ? `Última llegada ${data.ultima_llegada}` : "Aún no llega nadie"}</div>
            </div>
          </>
        ) : (
          <div className="hy-hero-sk" aria-busy="true" aria-label="Cargando">
            <div className="hy-anillo">
              <Skeleton w="100%" h={200} />
            </div>
            <div className="hy-hero-t">
              <Skeleton w={110} h={16} />
              <Skeleton w={80} h={34} />
              <Skeleton w={150} h={14} />
            </div>
          </div>
        )}
      </section>

      <div className="hy-acciones" data-tour="hy-acciones">
        <NinoNuevo onCreado={reload} className="hy-accion" />
        <Button className="hy-accion" onClick={() => setMarcando(true)}>
          <PenLine size={18} aria-hidden /> Marcar a mano
        </Button>
      </div>
      <MarcarRapido abierto={marcando} onCerrar={() => setMarcando(false)} onCambio={reload} />

      <RevisarTanda clave={`${data?.revision?.total}-${data?.revision?.revisados}-${data?.llegaron.length}`} onCambio={reload} onCorregir={() => setMarcando(true)} />

      <PorRevisarHoy solicitudes={data?.por_revisar.solicitudes ?? 0} />

      <ParaContactar id="para-contactar" />

      {data ? (
        <ListaHoy data={data} onCambio={reload} />
      ) : (
        <section className="s-card hy-lista" aria-busy="true" aria-label="Cargando">
          <div className="hy-sk">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} h={44} />
            ))}
          </div>
        </section>
      )}

      {data && data.acumulado.length > 1 && (
        <section className="s-card hy-curva-card" aria-label="Llegadas durante el día">
          <Curva puntos={data.acumulado} />
        </section>
      )}
    </>
  );
}
