"use client";

import { ArrowRight, BellRing } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { hora } from "@/lib/staff-api";
import { AccionesPendiente, MiniaturaPendiente, textoMotivo, usePendientes } from "../Pendientes";

const PRIMERAS = 3;

/** Solo aparece si hay algo: llegadas que la cámara no reconoció (se resuelven aquí mismo) y solicitudes por aprobar. */
export function PorRevisarHoy({ solicitudes }: { solicitudes: number }) {
  const { lista } = usePendientes();
  const [todas, setTodas] = useState(false);
  if (lista.length === 0 && solicitudes === 0) return null;
  const visibles = todas ? lista : lista.slice(0, PRIMERAS);

  return (
    <section className="s-card hy-revisar" aria-labelledby="hy-rev" data-tour="hy-revisar" id="por-revisar">
      <div className="s-card-h">
        <h2 id="hy-rev">
          <BellRing size={15} aria-hidden /> Por revisar
        </h2>
      </div>

      {lista.length > 0 && (
        <div className="hy-rev-b">
          <p className="muted">
            {lista.length === 1 ? "Una llegada que la cámara no reconoció." : `${lista.length} llegadas que la cámara no reconoció.`} Tú decides quién es.
          </p>
          <div className="hy-rev-grid">
            {visibles.map((p) => (
              <div key={p.id} className="s-pend" data-motivo={p.motivo ?? "no_reconocido"}>
                <div className="s-row">
                  <MiniaturaPendiente p={p} />
                  <div>
                    <b>{textoMotivo(p)}</b>
                    <div className="muted" style={{ fontSize: 13 }}>
                      Llegó a las <span className="tnum">{hora(p.timestamp)}</span>
                    </div>
                    {p.sugerido && p.motivo !== "nino_nuevo" && (
                      <div className="muted" style={{ fontSize: 13 }}>
                        ¿Será {p.sugerido.nombre}?
                      </div>
                    )}
                  </div>
                </div>
                <AccionesPendiente p={p} />
              </div>
            ))}
          </div>
          {lista.length > PRIMERAS && (
            <button type="button" className="s-btn ghost sm hy-mas" onClick={() => setTodas(!todas)}>
              {todas ? "Ver menos" : `Ver las ${lista.length}`}
            </button>
          )}
        </div>
      )}

      {solicitudes > 0 && (
        <Link href="/staff/ninos?pestana=aprobar" className="hy-sol">
          <span>
            <b className="tnum">{solicitudes}</b> {solicitudes === 1 ? "solicitud de inscripción por aprobar" : "solicitudes de inscripción por aprobar"}
          </span>
          <span className="hy-sol-go">
            Revisar <ArrowRight size={14} aria-hidden />
          </span>
        </Link>
      )}
    </section>
  );
}
