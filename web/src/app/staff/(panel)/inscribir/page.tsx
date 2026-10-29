"use client";

import { ArrowLeft, ArrowRight, Check, RotateCcw, ShieldCheck, UserPlus } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Camara } from "@/components/staff/Camara";
import { Alerta, Badge, Button, Campo, Dialogo, PageHeader } from "@/components/staff/ui";
import { ApiError, CATEGORIAS, api, type ResultadoInscripcion } from "@/lib/staff-api";

const POSES = [
  { titulo: "De frente", corto: "Frente", texto: "Mirando directo a la cámara." },
  { titulo: "Un poquito a su izquierda", corto: "Izquierda", texto: "Gira apenas la cabeza, sin dejar de mirar la cámara." },
  { titulo: "Un poquito a su derecha", corto: "Derecha", texto: "Igual, pero hacia el otro lado." },
];

type Foto = { blob: Blob; url: string };

export default function Inscribir() {
  const [paso, setPaso] = useState<1 | 2 | 3>(1);
  const [nombre, setNombre] = useState("");
  const [categoria, setCategoria] = useState("");
  const [tutor, setTutor] = useState("");
  const [autoriza, setAutoriza] = useState(false);
  const [errorDatos, setErrorDatos] = useState<string | null>(null);
  const [fotos, setFotos] = useState<Foto[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null);
  const [duplicado, setDuplicado] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ResultadoInscripcion | null>(null);
  const urls = useRef<string[]>([]);

  useEffect(() => {
    const lista = urls.current;
    return () => lista.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  function agregar(blob: Blob) {
    const url = URL.createObjectURL(blob);
    urls.current.push(url);
    setErrorEnvio(null);
    setFotos((f) => (f.length >= 3 ? f : [...f, { blob, url }]));
  }
  function quitar(i: number) {
    setErrorEnvio(null);
    setFotos((f) => f.filter((_, j) => j !== i));
  }

  function continuar(e: FormEvent) {
    e.preventDefault();
    if (!nombre.trim()) return setErrorDatos("Escribe el nombre del jugador para continuar.");
    if (!tutor.trim() || !autoriza) return setErrorDatos("Falta la autorización: escribe el nombre del tutor y marca la casilla.");
    setErrorDatos(null);
    setPaso(2);
  }

  async function enviar(forzar: boolean) {
    setEnviando(true);
    setErrorEnvio(null);
    setDuplicado(null);
    try {
      const r = await api.inscribir({ nombre: nombre.trim(), categoria, tutor: tutor.trim(), fotos: fotos.map((f) => f.blob), forzar });
      setResultado(r);
      setFotos([]);
      setPaso(3);
    } catch (e) {
      if (!(e instanceof ApiError)) return setErrorEnvio("No se pudo inscribir.");
      const n = typeof e.extra.foto === "number" ? e.extra.foto : null;
      if (e.codigo === "posible_duplicado") {
        setDuplicado(String(e.extra.nombre_existente ?? "otro jugador"));
      } else if (e.codigo === "sin_rostro" || e.codigo === "fotos_inconsistentes") {
        setErrorEnvio(
          e.codigo === "sin_rostro"
            ? `No encontramos una cara en ${n ? `la foto ${n}` : "la foto"}. Repítela con buena luz y mirando de frente.`
            : `La foto ${n} no parece de la misma persona que las otras. Repítela.`,
        );
        if (n && n <= fotos.length) quitar(n - 1);
      } else {
        setErrorEnvio(e.message);
      }
    } finally {
      setEnviando(false);
    }
  }

  function reiniciar() {
    setNombre("");
    setCategoria("");
    setTutor("");
    setAutoriza(false);
    setResultado(null);
    setErrorEnvio(null);
    setFotos([]);
    setPaso(1);
  }

  const pasos = ["Datos", "Fotos", "Listo"];

  return (
    <>
      <PageHeader titulo="Inscribir jugador" descripcion="Registra a un niño nuevo en 3 pasos.">
        <ol className="s-steps" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Progreso">
          {pasos.map((p, i) => (
            <li key={p} style={{ display: "contents" }} aria-current={paso === i + 1 ? "step" : undefined}>
              {i > 0 && <i aria-hidden />}
              <span className={paso === i + 1 ? "on" : paso > i + 1 ? "done" : ""}>
                {i + 1}. {p}
              </span>
            </li>
          ))}
        </ol>
      </PageHeader>

      {paso === 1 && (
        <form className="s-card s-form" onSubmit={continuar} style={{ maxWidth: 560 }} noValidate>
          <div className="s-card-b" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Campo etiqueta="Nombre y apellido">
              {(id) => <input id={id} className="s-input" value={nombre} maxLength={60} placeholder="Ej: Sofía Pérez" onChange={(e) => setNombre(e.target.value)} autoComplete="off" />}
            </Campo>
            <Campo etiqueta="Categoría (opcional)">
              {(id) => (
                <select id={id} className="s-select" value={categoria} onChange={(e) => setCategoria(e.target.value)}>
                  <option value="">Sin categoría</option>
                  {CATEGORIAS.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              )}
            </Campo>
            <hr style={{ border: 0, borderTop: "1px solid var(--line)", width: "100%", margin: 0 }} />
            <div style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 600 }}>
              <ShieldCheck size={16} aria-hidden /> Autorización
            </div>
            <Campo etiqueta="Nombre del padre, madre o tutor" ayuda="Quien firmó la autorización.">
              {(id) => <input id={id} className="s-input" value={tutor} maxLength={80} onChange={(e) => setTutor(e.target.value)} autoComplete="off" />}
            </Campo>
            <label className="s-check">
              <input type="checkbox" checked={autoriza} onChange={(e) => setAutoriza(e.target.checked)} />
              <span>
                Tengo la <b>autorización firmada</b> para usar la cara del niño en el control de asistencia.
                <span className="faint" style={{ display: "block", fontSize: 12 }}>
                  Son datos biométricos de un menor: sin autorización no se puede inscribir.
                </span>
              </span>
            </label>
            {errorDatos && <Alerta tono="err">{errorDatos}</Alerta>}
            <Button type="submit" variante="primary" className="s-cta">
              Continuar <ArrowRight size={15} aria-hidden />
            </Button>
          </div>
        </form>
      )}

      {paso === 2 && (
        <div className="s-split even s-ins">
          <div className="s-card s-ins-cam">
            <div className="s-card-h">
              <div>
                <h2>{fotos.length < 3 ? `Foto ${fotos.length + 1} de 3: ${POSES[fotos.length].titulo}` : "Las 3 fotos están listas"}</h2>
                <p>{fotos.length < 3 ? POSES[fotos.length].texto : "Revisa que se vean bien y presiona Inscribir."}</p>
              </div>
            </div>
            <div className="s-card-b" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {errorEnvio && <Alerta tono="err">{errorEnvio}</Alerta>}
              {fotos.length < 3 ? (
                <Camara key={fotos.length} fija onCaptura={agregar} deshabilitado={enviando} etiqueta={`Tomar foto ${fotos.length + 1}`} />
              ) : (
                <div className="s-fixbar">
                  <Button variante="brand" className="s-capture" block cargando={enviando} onClick={() => enviar(false)}>
                    {!enviando && <UserPlus size={16} aria-hidden />} {enviando ? "Analizando las caras…" : `Inscribir a ${nombre.trim().split(/\s+/)[0]}`}
                  </Button>
                </div>
              )}
              {fotos.length > 0 && fotos.length < 3 && (
                <Button cargando={enviando} onClick={() => enviar(false)}>
                  {enviando ? "Analizando…" : `Inscribir solo con ${fotos.length} foto${fotos.length > 1 ? "s" : ""}`}
                </Button>
              )}
              <Button variante="ghost" onClick={() => setPaso(1)} disabled={enviando}>
                <ArrowLeft size={15} aria-hidden /> Cambiar datos
              </Button>
            </div>
          </div>

          <div className="s-ins-side">
            <div className="s-card s-card-b s-ins-person">
              <div className="s-person">
                <span className="s-avatar" aria-hidden>
                  {nombre.trim()[0]?.toUpperCase()}
                </span>
                <div>
                  <b>{nombre}</b>
                  <small>{categoria || "Sin categoría"}</small>
                </div>
              </div>
            </div>
            <div className="s-card s-card-b s-ins-thumbs">
              <div className="s-thumbs">
                {POSES.map((p, i) => (
                  <div key={p.titulo} className="s-thumb" data-on={i < fotos.length} data-cur={i === fotos.length}>
                    {fotos[i] ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element -- vista previa local (blob:) */}
                        <img src={fotos[i].url} alt={`Foto ${i + 1}: ${p.titulo}`} />
                        <Button icono sm className="s-redo" aria-label={`Repetir foto ${i + 1}`} onClick={() => quitar(i)} disabled={enviando}>
                          <RotateCcw size={13} />
                        </Button>
                      </>
                    ) : (
                      <span>
                        <b>{i + 1}</b>
                        <em>{p.corto}</em>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="s-card s-card-b muted s-ins-tips" style={{ fontSize: 13 }}>
              <b style={{ color: "var(--fg)" }}>Para una buena foto</b>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                <li>A unos 50 cm: la cara grande y centrada.</li>
                <li>Buena luz sobre la cara, nunca a contraluz.</li>
                <li>Sin gorra, lentes de sol ni mascarilla.</li>
                <li>Que no aparezca nadie más en la foto.</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {paso === 3 && resultado && (
        <div className="s-card" style={{ maxWidth: 560 }}>
          <div className="s-empty">
            <div className="ico" style={{ color: "var(--brand)" }}>
              <Check size={20} aria-hidden />
            </div>
            <h3>{resultado.nombre} ya está en el equipo</h3>
            <Badge tono="ok">{resultado.categoria ?? "Sin categoría"}</Badge>
            <p>Inscrito con {resultado.fotos} foto(s). Desde ahora puede marcar su llegada en el kiosko.</p>
            {resultado.avisos.map((a) => (
              <Alerta key={a}>{a}</Alerta>
            ))}
            <div className="s-actions" style={{ marginTop: 10 }}>
              <Button variante="primary" onClick={reiniciar}>
                <UserPlus size={15} aria-hidden /> Inscribir otro
              </Button>
              <Link className="s-btn" href="/staff/jugadores">
                Ver jugadores
              </Link>
            </div>
          </div>
        </div>
      )}

      <Dialogo
        abierto={duplicado !== null}
        onCerrar={() => setDuplicado(null)}
        titulo="¿Ya está inscrito?"
        pie={
          <>
            <Button
              onClick={() => {
                setDuplicado(null);
                reiniciar();
              }}
            >
              Es el mismo: cancelar
            </Button>
            <Button variante="primary" onClick={() => enviar(true)}>
              Es otro niño: inscribir
            </Button>
          </>
        }
      >
        <p className="muted">
          Esta cara se parece mucho a <b style={{ color: "var(--fg)" }}>{duplicado}</b>, que ya está inscrito. ¿Es otro niño o el mismo?
        </p>
      </Dialogo>
    </>
  );
}
