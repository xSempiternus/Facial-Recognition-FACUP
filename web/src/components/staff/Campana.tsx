"use client";

// Campana de avisos: cuenta lo que espera al staff (solicitudes por aprobar + niños por contactar + llegadas por
// revisar del kiosko). Los números vienen de los sondeos que ya hay en el Shell: aquí no se consulta nada más, salvo
// la lista de solicitudes (una vez, al abrir el panel) para poner nombres. El panel es INLINE bajo la cabecera, sin
// modal. Sin sonidos ni vibración. «Nuevo» = el total subió desde la última vez que se abrió (por sede, localStorage).

import { Bell, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { sedeActual } from "@/lib/sede";
import { api, type Solicitud } from "@/lib/staff-api";

const MAX_NOMBRADAS = 4;
export const EVENTO_NINOS = "facup-ninos-ir";
export type DestinoNinos = { pestana: "inscritos" | "aprobar"; solicitud?: number; contactar?: boolean };

const clave = () => `facup:campana:${sedeActual() ?? "_"}`;
function leerVisto(): number {
  try {
    return Number(localStorage.getItem(clave())) || 0;
  } catch {
    return 0;
  }
}
function guardarVisto(n: number) {
  try {
    localStorage.setItem(clave(), String(n));
  } catch {
    /* solo es una comodidad */
  }
}

/** «Emilio Pérez Soto» -> «Emilio P.» */
export function nombreCorto(n: string): string {
  const [a, b] = n.trim().split(/\s+/);
  return b ? `${a} ${b[0].toUpperCase()}.` : (a ?? n);
}

export function Campana({ solicitudes, porContactar, porRevisar }: { solicitudes: number; porContactar: number; porRevisar: number }) {
  const router = useRouter();
  const total = solicitudes + porContactar + porRevisar;
  const [abierta, setAbierta] = useState(false);
  const [visto, setVisto] = useState(0);
  const [lista, setLista] = useState<Solicitud[]>([]);
  const raiz = useRef<HTMLDivElement>(null);
  const boton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- lectura única tras hidratar
    setVisto(leerVisto());
  }, []);

  // si el total baja (se resolvió algo), el «visto» baja con él: así lo siguiente que llegue vuelve a marcarse nuevo
  useEffect(() => {
    if (total < visto) {
      guardarVisto(total);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sincroniza con lo guardado
      setVisto(total);
    }
  }, [total, visto]);

  const nuevo = total > visto;

  useEffect(() => {
    if (!abierta) return;
    let vivo = true;
    api
      .solicitudes()
      .then((l) => vivo && setLista(l))
      .catch(() => {
        /* sin nombres: quedan las filas por cantidad */
      });
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    const fuera = (e: PointerEvent) => {
      if (raiz.current && !raiz.current.contains(e.target as Node)) setAbierta(false);
    };
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAbierta(false);
        boton.current?.focus();
      }
    };
    document.addEventListener("pointerdown", fuera);
    document.addEventListener("keydown", tecla);
    return () => {
      vivo = false;
      document.removeEventListener("pointerdown", fuera);
      document.removeEventListener("keydown", tecla);
    };
  }, [abierta]);

  function alternar() {
    const x = !abierta;
    setAbierta(x);
    if (x) {
      guardarVisto(total);
      setVisto(total);
    }
  }

  function irNinos(d: DestinoNinos) {
    setAbierta(false);
    const q = new URLSearchParams({ pestana: d.pestana });
    if (d.solicitud) q.set("sol", String(d.solicitud));
    const href = `/staff/ninos?${q}`;
    if (window.location.pathname.replace(/\/$/, "").endsWith("/staff/ninos")) {
      window.history.replaceState(null, "", href);
      window.dispatchEvent(new CustomEvent<DestinoNinos>(EVENTO_NINOS, { detail: d }));
    } else router.push(href);
    if (d.contactar) window.setTimeout(() => document.getElementById("nn-contactar")?.scrollIntoView({ behavior: "smooth", block: "start" }), 400);
  }

  const nombradas = lista.slice(0, MAX_NOMBRADAS);
  const resto = solicitudes - nombradas.length;
  const etiqueta = total === 0 ? "Avisos: nada pendiente" : `Avisos: ${total} pendiente${total === 1 ? "" : "s"}${nuevo ? ", hay novedades" : ""}`;

  return (
    <div ref={raiz} className="s-campana">
      <button ref={boton} type="button" className="s-btn ghost icon s-bell" aria-label={etiqueta} aria-expanded={abierta} aria-controls="campana-panel" onClick={alternar}>
        <Bell size={18} aria-hidden />
        {total > 0 && (
          <span className={nuevo ? "s-bell-n nuevo" : "s-bell-n"} aria-hidden>
            {total > 99 ? "99+" : total}
          </span>
        )}
      </button>
      {abierta && (
        <div ref={panel} id="campana-panel" className="s-bell-panel" role="region" aria-label="Avisos">
          {total === 0 ? (
            <p className="s-bell-vacio">Todo al día. No hay nada esperando.</p>
          ) : (
            <>
              <div className="s-bell-h">Esperan por ti</div>
              {solicitudes > 0 &&
                (nombradas.length > 0 ? (
                  <>
                    {nombradas.map((s) => (
                      <Fila key={s.id} titulo={`${nombreCorto(s.nombre_nino)} quiere inscribirse`} detalle={s.categoria ?? "Sin categoría"} accion="Revisar" onClick={() => irNinos({ pestana: "aprobar", solicitud: s.id })} />
                    ))}
                    {resto > 0 && <Fila titulo={`${resto} inscripci${resto === 1 ? "ón más" : "ones más"} por aprobar`} accion="Ver" onClick={() => irNinos({ pestana: "aprobar" })} />}
                  </>
                ) : (
                  <Fila titulo={solicitudes === 1 ? "1 inscripción por aprobar" : `${solicitudes} inscripciones por aprobar`} accion="Revisar" onClick={() => irNinos({ pestana: "aprobar" })} />
                ))}
              {porContactar > 0 && (
                <Fila titulo={porContactar === 1 ? "1 niño para contactar" : `${porContactar} niños para contactar`} detalle="Faltaron varias veces seguidas" accion="Ver" onClick={() => irNinos({ pestana: "inscritos", contactar: true })} />
              )}
              {porRevisar > 0 && (
                <Fila
                  titulo={porRevisar === 1 ? "1 llegada por revisar" : `${porRevisar} llegadas por revisar`}
                  detalle="La cámara no estuvo segura"
                  accion="Revisar"
                  onClick={() => {
                    setAbierta(false);
                    router.push("/staff#por-revisar");
                  }}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Fila({ titulo, detalle, accion, onClick }: { titulo: string; detalle?: string; accion: string; onClick: () => void }) {
  return (
    <button type="button" className="s-bell-fila" onClick={onClick}>
      <span className="t">
        {titulo}
        {detalle && <small>{detalle}</small>}
      </span>
      <span className="ir">
        {accion} <ChevronRight size={14} aria-hidden />
      </span>
    </button>
  );
}
