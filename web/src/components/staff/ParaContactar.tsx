"use client";

// «Para contactar»: niños con faltas seguidas (alertas guardadas en la base de la sede). Se crean y se cierran solas
// (el niño vuelve a asistir); el staff marca el avance (vista -> contactada -> cerrada) y deja una nota.
// Aparece en Hoy y en Niños; solo se muestra si hay alguna abierta.

import { Mail, Phone, PhoneCall, StickyNote, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { diaMes, textoError } from "@/lib/staff-api";
import { apiSeguimiento, publicarAlertas, type Alerta, type EstadoAlerta } from "@/lib/staff-api-alertas";
import { Avatar, Button, useToast } from "./ui";

const CADA_MS = 60_000;
const ESTADOS: { k: Exclude<EstadoAlerta, "cerrada">; texto: string }[] = [
  { k: "nueva", texto: "Nueva" },
  { k: "vista", texto: "Vista" },
  { k: "contactada", texto: "Contactada" },
];

function conteo(l: Alerta[]) {
  return { abiertas: l.length, por_contactar: l.filter((a) => a.estado === "nueva" || a.estado === "vista").length };
}

/** Un contacto libre (del consentimiento) puede ser correo o teléfono. */
function enlaceLibre(v: string): { href: string; tipo: "correo" | "tel" } | null {
  if (/^\S+@\S+\.\S+$/.test(v)) return { href: `mailto:${v}`, tipo: "correo" };
  const d = v.replace(/[^\d+]/g, "");
  return d.length >= 8 ? { href: `tel:${d}`, tipo: "tel" } : null;
}

export function ParaContactar({ id }: { id?: string }) {
  const notificar = useToast();
  const [lista, setLista] = useState<Alerta[] | null>(null);
  const [ocupado, setOcupado] = useState<number | null>(null);
  const [notaAbierta, setNotaAbierta] = useState<number | null>(null);
  const [borrador, setBorrador] = useState("");

  const fijar = useCallback((l: Alerta[]) => {
    setLista(l);
    publicarAlertas(conteo(l));
  }, []);

  useEffect(() => {
    let vivo = true;
    const cargar = () => {
      if (document.visibilityState !== "visible") return;
      apiSeguimiento
        .alertas()
        .then((r) => vivo && fijar(r.alertas))
        .catch(() => {
          /* tarjeta informativa: si falla, se intenta en el próximo ciclo */
        });
    };
    cargar();
    const t = window.setInterval(cargar, CADA_MS);
    document.addEventListener("visibilitychange", cargar);
    return () => {
      vivo = false;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", cargar);
    };
  }, [fijar]);

  async function cambiar(a: Alerta, d: { estado?: EstadoAlerta; nota?: string }) {
    setOcupado(a.id);
    try {
      const r = await apiSeguimiento.actualizarAlerta(a.id, d);
      const l = (lista ?? []).flatMap((x) => (x.id !== a.id ? [x] : r.estado === "cerrada" ? [] : [{ ...x, ...r }]));
      fijar(l);
      if (r.estado === "cerrada") notificar(`${a.nombre}: aviso cerrado`);
      return true;
    } catch (e) {
      notificar(textoError(e, "No se pudo guardar."), "err");
      return false;
    } finally {
      setOcupado(null);
    }
  }

  async function guardarNota(a: Alerta) {
    if (borrador.trim() === (a.nota ?? "")) return setNotaAbierta(null);
    if (await cambiar(a, { nota: borrador })) setNotaAbierta(null);
  }

  if (!lista || lista.length === 0) return null;
  const pend = conteo(lista).por_contactar;

  return (
    <section className="s-card rv-contactar" aria-labelledby={`${id ?? "pc"}-t`} id={id}>
      <div className="s-card-h">
        <h2 id={`${id ?? "pc"}-t`}>
          <PhoneCall size={15} aria-hidden /> Para contactar
        </h2>
        <p className="tnum">{pend > 0 ? `${pend} por llamar · ${lista.length} abiertas` : `${lista.length} abiertas, todas contactadas`}</p>
      </div>
      <ul className="rv-lista">
        {lista.map((a) => {
          const c = a.contacto;
          const libre = c?.otro ? enlaceLibre(c.otro) : null;
          return (
            <li key={a.id} className="rv-item" data-estado={a.estado}>
              <div className="rv-fila">
                <Avatar nombre={a.nombre} />
                <div className="rv-n">
                  <b>{a.nombre}</b>
                  <small>
                    {a.categoria ?? "Sin categoría"} · <span className="tnum">{a.valor ?? "?"} faltas seguidas</span>
                    {a.ultima_asistencia ? ` · vino el ${diaMes(a.ultima_asistencia)}` : " · nunca ha venido"}
                  </small>
                  {c && (
                    <span className="rv-contacto">
                      {c.tutor && <span>{c.tutor}</span>}
                      {c.telefono && (
                        <a href={`tel:${c.telefono.replace(/[^\d+]/g, "")}`}>
                          <Phone size={13} aria-hidden /> {c.telefono}
                        </a>
                      )}
                      {c.correo && (
                        <a href={`mailto:${c.correo}`}>
                          <Mail size={13} aria-hidden /> {c.correo}
                        </a>
                      )}
                      {!c.telefono && !c.correo && c.otro && (libre ? <a href={libre.href}>{libre.tipo === "tel" ? <Phone size={13} aria-hidden /> : <Mail size={13} aria-hidden />} {c.otro}</a> : <span>{c.otro}</span>)}
                    </span>
                  )}
                  {a.nota && notaAbierta !== a.id && <span className="rv-nota">“{a.nota}”</span>}
                </div>
              </div>

              <div className="rv-acc">
                <div className="rv-seg" role="group" aria-label={`Estado del aviso de ${a.nombre}`}>
                  {ESTADOS.map((e) => (
                    <button key={e.k} type="button" className="rv-seg-b" aria-pressed={a.estado === e.k} disabled={ocupado === a.id} onClick={() => a.estado !== e.k && void cambiar(a, { estado: e.k })}>
                      {e.texto}
                    </button>
                  ))}
                </div>
                <Button
                  sm
                  variante="ghost"
                  disabled={ocupado === a.id}
                  aria-expanded={notaAbierta === a.id}
                  onClick={() => {
                    setBorrador(a.nota ?? "");
                    setNotaAbierta(notaAbierta === a.id ? null : a.id);
                  }}
                >
                  <StickyNote size={14} aria-hidden /> Nota
                </Button>
                <Button sm variante="ghost" disabled={ocupado === a.id} onClick={() => void cambiar(a, { estado: "cerrada" })} aria-label={`Cerrar el aviso de ${a.nombre}`}>
                  <X size={14} aria-hidden /> Cerrar
                </Button>
              </div>

              {notaAbierta === a.id && (
                <form
                  className="rv-nota-f"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void guardarNota(a);
                  }}
                >
                  <input
                    className="s-input"
                    autoFocus
                    maxLength={500}
                    placeholder="Ej: llamé a la mamá, vuelve el jueves"
                    aria-label={`Nota sobre ${a.nombre}`}
                    value={borrador}
                    onChange={(e) => setBorrador(e.target.value)}
                  />
                  <Button sm variante="primary" type="submit" cargando={ocupado === a.id}>
                    Guardar
                  </Button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
