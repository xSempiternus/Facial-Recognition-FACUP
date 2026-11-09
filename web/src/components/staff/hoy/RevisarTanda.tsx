"use client";

// «Revisar»: lo que el staff debería mirar de la tanda que acaba de llegar. Junta (1) las llegadas que la cámara
// aceptó con un parecido justo (similitud < umbral automático + 0,05) y (2) las llegadas no reconocidas que traen un
// candidato sugerido. Un toque: «Confirmar» o «No es él/ella». «Confirmar los seguros» cierra el resto de la tanda.
// El veredicto es del staff: nada se confirma solo. (No se guarda foto de los inscritos: se compara con el nombre.)

import { CheckCheck, Check, ListChecks, UserX } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { hora, textoError } from "@/lib/staff-api";
import { apiSeguimiento, type ItemRevision, type RevisionHoy } from "@/lib/staff-api-alertas";
import { MiniaturaPendiente, usePendientes } from "../Pendientes";
import { PistaInline, PistaOpcion } from "../PistaInline";
import { Avatar, Button, useToast } from "../ui";

const primerNombre = (n: string) => n.trim().split(/\s+/)[0] ?? n;

export function RevisarTanda({ clave, onCambio, onCorregir }: { clave: unknown; onCambio: () => void; onCorregir: () => void }) {
  const notificar = useToast();
  const { lista, esSugerido, elegirOtro, ocupados } = usePendientes();
  const [rev, setRev] = useState<RevisionHoy | null>(null);
  const [ocupado, setOcupado] = useState<number | "lote" | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let vivo = true;
    apiSeguimiento
      .revisionHoy()
      .then((r) => vivo && setRev(r))
      .catch(() => {
        /* la sección es un apoyo: si falla, se reintenta con la próxima recarga de Hoy */
      });
    return () => {
      vivo = false;
    };
  }, [clave, tick]);

  const recargar = useCallback(() => {
    setTick((t) => t + 1);
    onCambio();
  }, [onCambio]);

  async function revisar(it: ItemRevision, accion: "confirmar" | "no_es") {
    setOcupado(it.asistencia_id);
    try {
      await apiSeguimiento.revisar(it.asistencia_id, accion);
      // Optimista: sale de la lista al instante; los totales llegan con la recarga.
      setRev((r) => r && { ...r, revisados: r.revisados + 1, por_revisar: r.por_revisar.filter((x) => x.asistencia_id !== it.asistencia_id) });
      if (accion === "no_es") {
        notificar(`Se anuló la llegada de ${it.nombre}. Marca al niño correcto.`, "info");
        onCorregir();
      } else notificar(`${primerNombre(it.nombre)}: confirmado`);
      recargar();
    } catch (e) {
      notificar(textoError(e, "No se pudo guardar la revisión."), "err");
      recargar();
    } finally {
      setOcupado(null);
    }
  }

  async function confirmarSeguros() {
    setOcupado("lote");
    try {
      const r = await apiSeguimiento.confirmarSeguros();
      notificar(r.confirmadas === 1 ? "1 llegada confirmada" : `${r.confirmadas} llegadas confirmadas`);
      recargar();
    } catch (e) {
      notificar(textoError(e, "No se pudo confirmar."), "err");
    } finally {
      setOcupado(null);
    }
  }

  const sugeridos = lista.filter((p) => p.sugerido && p.motivo !== "nino_nuevo" && p.motivo !== "no_soy_yo");
  const items = rev?.por_revisar ?? [];
  const total = rev?.total ?? 0;
  if (!rev || (total === 0 && sugeridos.length === 0)) return null;
  const pendientes = items.length + sugeridos.length;
  const todo = pendientes === 0 && rev.seguros_sin_revisar === 0;

  return (
    <section className="s-card rv-revisar" aria-labelledby="rv-t" id="revisar">
      <div className="s-card-h">
        <h2 id="rv-t">
          <ListChecks size={15} aria-hidden /> Revisar
        </h2>
        {total > 0 && (
          <p className="tnum" aria-live="polite">
            <b>{rev.revisados}</b> de {total} revisados
          </p>
        )}
      </div>
      {total > 0 && (
        <div className="rv-barra" aria-hidden>
          <span style={{ width: `${Math.round((100 * rev.revisados) / total)}%` }} />
        </div>
      )}

      {todo ? (
        <p className="rv-listo">
          <CheckCheck size={16} aria-hidden /> Todo revisado.
        </p>
      ) : (
        <div className="rv-b">
          {pendientes > 0 && <p className="muted">Mira la cara del niño y confirma que el nombre es el suyo.</p>}
          <PistaInline id="revisar-tanda" resumen="La cámara no quedó 100% segura. Tú decides si el nombre es el correcto.">
            <PistaOpcion nombre="Confirmar:">si la cara de la foto es del niño que dice el nombre.</PistaOpcion>
            <PistaOpcion nombre="No es él/ella:">si es otro niño. Se anula esa llegada, o eliges quién es.</PistaOpcion>
            <PistaOpcion nombre="Parecido alto, medio o bajo:">qué tan segura estaba la cámara. Con «medio» o «bajo» mira la foto con más calma antes de confirmar.</PistaOpcion>
          </PistaInline>
          <ul className="rv-lista">
            {items.map((it) => (
              <li key={`a${it.asistencia_id}`} className="rv-item" data-tono="revisar">
                <div className="rv-fila">
                  <Avatar nombre={it.nombre} />
                  <div className="rv-n">
                    <b>{it.nombre}</b>
                    <small>
                      {it.categoria ?? "Sin categoría"} · llegó a las <span className="tnum">{hora(it.timestamp)}</span> · parecido justo
                    </small>
                  </div>
                </div>
                <div className="rv-acc">
                  <Button sm variante="brand" cargando={ocupado === it.asistencia_id} disabled={ocupado !== null} onClick={() => void revisar(it, "confirmar")} aria-label={`Confirmar que es ${it.nombre}`}>
                    {ocupado !== it.asistencia_id && <Check size={14} aria-hidden />} Confirmar
                  </Button>
                  <Button sm variante="ghost" disabled={ocupado !== null} onClick={() => void revisar(it, "no_es")} aria-label={`No es ${it.nombre}: anular su llegada`}>
                    <UserX size={14} aria-hidden /> No es él/ella
                  </Button>
                </div>
              </li>
            ))}
            {sugeridos.map((p) => {
              const ocup = ocupados.includes(p.id);
              const s = p.sugerido;
              if (!s) return null;
              return (
                <li key={`p${p.id}`} className="rv-item" data-tono="pendiente">
                  <div className="rv-fila">
                    <MiniaturaPendiente p={p} />
                    <div className="rv-n">
                      <b>¿Es {s.nombre}?</b>
                      <small>
                        No lo reconoció seguro{p.parecido ? ` · parecido ${p.parecido}` : ""} · llegó a las <span className="tnum">{hora(p.timestamp)}</span>
                      </small>
                    </div>
                  </div>
                  <div className="rv-acc">
                    <Button sm variante="brand" cargando={ocup} onClick={() => esSugerido(p)} aria-label={`Confirmar: es ${s.nombre}`}>
                      {!ocup && <Check size={14} aria-hidden />} Confirmar
                    </Button>
                    <Button sm variante="ghost" disabled={ocup} onClick={() => elegirOtro(p)} aria-label={`No es ${s.nombre}: elegir quién es`}>
                      <UserX size={14} aria-hidden /> No es él/ella
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          {rev.seguros_sin_revisar > 0 && (
            <Button className="rv-lote" cargando={ocupado === "lote"} disabled={ocupado !== null} onClick={() => void confirmarSeguros()}>
              {ocupado !== "lote" && <CheckCheck size={16} aria-hidden />}
              {rev.seguros_sin_revisar === 1 ? "Confirmar la llegada segura" : `Confirmar las ${rev.seguros_sin_revisar} llegadas seguras`}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
