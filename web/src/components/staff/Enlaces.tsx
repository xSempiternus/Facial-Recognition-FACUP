"use client";

// "Invitar a los padres": genera enlaces de inscripción (con QR), los lista y permite revocarlos.

import { Link2, QrCode, Trash2 } from "lucide-react";
import { useState } from "react";
import { ApiError, api, fechaHora, textoError, urlEnlace, type Enlace } from "@/lib/staff-api";
import { PanelQr } from "./Qr";
import { Alerta, Badge, Button, Campo, Dialogo, Segmentado, SkeletonRows, Vacio, useQuery, useToast } from "./ui";

export type EnlaceVivo = { id: number; url: string; expira: string; categoria: string | null };

const CLAVE = "facup-enlace-rapido";

/** Los tokens solo se conocen al crearlos: se recuerda el último enlace (en esta pestaña) para reutilizarlo. */
function recordado(categoria: string): EnlaceVivo | null {
  try {
    const l = JSON.parse(window.sessionStorage.getItem(CLAVE) ?? "{}") as Record<string, EnlaceVivo>;
    return l[categoria] ?? null;
  } catch {
    return null;
  }
}
function recordar(categoria: string, e: EnlaceVivo) {
  try {
    const l = JSON.parse(window.sessionStorage.getItem(CLAVE) ?? "{}") as Record<string, EnlaceVivo>;
    l[categoria] = e;
    window.sessionStorage.setItem(CLAVE, JSON.stringify(l));
  } catch {
    /* solo es una comodidad */
  }
}

/** Crea un enlace nuevo y lo recuerda. */
export async function crearEnlaceVivo(categoria: string, dias: number): Promise<EnlaceVivo> {
  const r = await api.crearEnlace(categoria, dias);
  const e = { id: r.id, url: urlEnlace(r.ruta), expira: r.expira, categoria: r.categoria };
  if (dias === 1) recordar(categoria, e);
  return e;
}

/** Enlace de 1 día para la categoría: reutiliza el recordado si sigue activo en el servidor; si no, crea uno. */
export async function enlaceRapido(categoria: string): Promise<EnlaceVivo> {
  const previo = recordado(categoria);
  if (previo) {
    const lista = await api.enlaces();
    if (lista.some((x) => x.id === previo.id && x.estado === "activo")) return previo;
  }
  return crearEnlaceVivo(categoria, 1);
}

const ESTADO = { activo: ["ok", "Activo"], vencido: [undefined, "Vencido"], revocado: ["err", "Revocado"] } as const;

export function Enlaces({ categorias, abiertoDeInicio }: { categorias: string[]; abiertoDeInicio?: boolean }) {
  const notificar = useToast();
  const lista = useQuery(api.enlaces);
  const [categoria, setCategoria] = useState("");
  const [dias, setDias] = useState<"1" | "7" | "30">("7");
  const [nuevo, setNuevo] = useState<EnlaceVivo | null>(null);
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revocar, setRevocar] = useState<Enlace | null>(null);
  const [revocando, setRevocando] = useState(false);
  const [abierto, setAbierto] = useState<boolean | null>(null);
  const visible = abierto ?? !!abiertoDeInicio;

  async function generar() {
    setCreando(true);
    setError(null);
    try {
      setNuevo(await crearEnlaceVivo(categoria, Number(dias)));
      lista.reload();
    } catch (e) {
      setError(textoError(e, "No se pudo crear el enlace."));
    } finally {
      setCreando(false);
    }
  }

  async function confirmarRevocar() {
    if (!revocar) return;
    setRevocando(true);
    try {
      await api.revocarEnlace(revocar.id);
      notificar("Enlace revocado: ya no se puede usar");
      if (nuevo?.id === revocar.id) setNuevo(null);
      setRevocar(null);
      lista.reload();
    } catch (e) {
      notificar(e instanceof ApiError ? e.message : "No se pudo revocar.", "err");
    } finally {
      setRevocando(false);
    }
  }

  return (
    <section className="s-card" aria-labelledby="inv-h" data-tour="enlace">
      <div className="s-card-h">
        <div>
          <h2 id="inv-h" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <QrCode size={15} aria-hidden /> Invitar a los padres
          </h2>
          <p>Genera un enlace o QR para que cada apoderado complete la inscripción, la autorización y las fotos desde su celular.</p>
        </div>
        <Button onClick={() => setAbierto(!visible)} aria-expanded={visible}>
          {visible ? "Ocultar" : "Crear enlace"}
        </Button>
      </div>

      {visible && (
        <div className="s-card-b" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Alerta>El enlace es solo de esta sede y lo puede usar cualquiera que lo reciba hasta que venza. Compártelo solo con las familias.</Alerta>
          <div className="s-row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
            <Campo etiqueta="Categoría (opcional)">
              {(id) => (
                <select id={id} className="s-select" value={categoria} onChange={(e) => setCategoria(e.target.value)}>
                  <option value="">Que la elija la familia</option>
                  {categorias.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
            </Campo>
            <div className="s-field">
              <span style={{ fontSize: 13, fontWeight: 500 }}>Vigencia</span>
              <Segmentado
                etiqueta="Vigencia del enlace"
                valor={dias}
                onChange={setDias}
                opciones={[
                  { valor: "1", texto: "1 día" },
                  { valor: "7", texto: "7 días" },
                  { valor: "30", texto: "30 días" },
                ]}
              />
            </div>
            <Button variante="primary" cargando={creando} onClick={generar}>
              <Link2 size={15} aria-hidden /> Generar enlace
            </Button>
          </div>
          {error && <Alerta tono="err">{error}</Alerta>}
          {nuevo && <PanelQr url={nuevo.url} expira={nuevo.expira} />}
        </div>
      )}

      <div className="s-card-b" style={{ paddingTop: visible ? 0 : undefined }}>
        <h3 style={{ fontSize: 13, margin: "0 0 8px" }} className="muted">
          Enlaces creados
        </h3>
        {lista.error && !lista.data ? (
          <Alerta tono="err">
            {lista.error.message} <Button sm onClick={lista.reload}>Reintentar</Button>
          </Alerta>
        ) : lista.cargando && !lista.data ? (
          <SkeletonRows n={2} />
        ) : !lista.data?.length ? (
          <Vacio icono={<Link2 size={18} />} titulo="Aún no hay enlaces" texto={visible ? "Usa «Generar enlace» para crear el primero." : "Toca «Crear enlace» para generar el primero."} />
        ) : (
          <div className="s-table-wrap">
            <table className="s-table">
              <thead>
                <tr>
                  <th>Categoría</th>
                  <th className="hide-sm">Vence</th>
                  <th>Estado</th>
                  <th className="num">Pendientes</th>
                  <th className="act">
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lista.data.map((e) => {
                  const [tono, texto] = ESTADO[e.estado];
                  return (
                    <tr key={e.id}>
                      <td>{e.categoria ?? "Cualquiera"}</td>
                      <td className="hide-sm muted tnum">{fechaHora(e.expira)}</td>
                      <td>
                        <Badge tono={tono}>{texto}</Badge>
                      </td>
                      <td className="num">{e.solicitudes_pendientes}</td>
                      <td className="act">
                        {e.estado === "activo" && (
                          <Button icono sm variante="ghost" aria-label="Revocar enlace" title="Revocar" onClick={() => setRevocar(e)}>
                            <Trash2 size={16} />
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialogo
        abierto={!!revocar}
        onCerrar={() => setRevocar(null)}
        titulo="¿Revocar este enlace?"
        pie={
          <>
            <Button onClick={() => setRevocar(null)}>Cancelar</Button>
            <Button variante="danger" cargando={revocando} onClick={confirmarRevocar}>
              Sí, revocar
            </Button>
          </>
        }
      >
        <p className="muted">
          Nadie podrá usar este enlace ni su QR. Las solicitudes que ya llegaron no se pierden.
        </p>
      </Dialogo>
    </section>
  );
}
