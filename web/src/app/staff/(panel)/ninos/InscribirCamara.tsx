"use client";

// «Lo inscribo yo con la cámara»: datos, autorización del tutor y 3 fotos guiadas, de a un paso.

import { Check, RotateCcw, UserPlus } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Camara } from "@/components/staff/Camara";
import { useCategoriasActivas } from "@/components/staff/NinoNuevo";
import { Alerta, Button, Campo } from "@/components/staff/ui";
import { ApiError, api, type ResultadoInscripcion } from "@/lib/staff-api";
import { primerNombre } from "@/lib/staff-api-ninos";
import { Hoja } from "./Hoja";

const POSES = [
  { titulo: "De frente", corto: "Frente", texto: "Mirando directo a la cámara." },
  { titulo: "Un poquito a su izquierda", corto: "Izquierda", texto: "Gira apenas la cabeza, sin dejar de mirar la cámara." },
  { titulo: "Un poquito a su derecha", corto: "Derecha", texto: "Igual, pero hacia el otro lado." },
];

type Foto = { blob: Blob; url: string };
type Paso = 1 | 2 | 3 | 4;

export function InscribirCamara({ abierto, onCerrar, onListo, onApoderado }: { abierto: boolean; onCerrar: () => void; onListo: () => void; onApoderado: () => void }) {
  if (!abierto) return null;
  return <Asistente onCerrar={onCerrar} onListo={onListo} onApoderado={onApoderado} />;
}

function Asistente({ onCerrar, onListo, onApoderado }: { onCerrar: () => void; onListo: () => void; onApoderado: () => void }) {
  const categoriasSede = useCategoriasActivas();
  const [paso, setPaso] = useState<Paso>(1);
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

  function datos(e: FormEvent) {
    e.preventDefault();
    if (nombre.trim().length < 2) return setErrorDatos("Escribe el nombre del niño para continuar.");
    setErrorDatos(null);
    setPaso(2);
  }
  function autorizacion(e: FormEvent) {
    e.preventDefault();
    if (!tutor.trim() || !autoriza) return setErrorDatos("Escribe quién autoriza y marca la casilla para continuar.");
    setErrorDatos(null);
    setPaso(3);
  }

  async function enviar(forzar: boolean) {
    setEnviando(true);
    setErrorEnvio(null);
    setDuplicado(null);
    try {
      const r = await api.inscribir({ nombre: nombre.trim(), categoria, tutor: tutor.trim(), fotos: fotos.map((f) => f.blob), forzar });
      setResultado(r);
      setFotos([]);
      setPaso(4);
      onListo();
    } catch (e) {
      if (!(e instanceof ApiError)) return setErrorEnvio("No se pudo inscribir. Inténtalo de nuevo.");
      const n = typeof e.extra.foto === "number" ? e.extra.foto : null;
      if (e.codigo === "posible_duplicado") {
        setDuplicado(String(e.extra.nombre_existente ?? "otro niño"));
      } else if (e.codigo === "sin_rostro" || e.codigo === "fotos_inconsistentes") {
        setErrorEnvio(
          e.codigo === "sin_rostro"
            ? `No encontramos una cara en ${n ? `la foto ${n}` : "la foto"}. Repítela con buena luz y mirando de frente.`
            : `La foto ${n} no parece del mismo niño que las otras. Repítela.`,
        );
        if (n && n <= fotos.length) quitar(n - 1);
      } else {
        setErrorEnvio(e.message);
      }
    } finally {
      setEnviando(false);
    }
  }

  function otro() {
    setNombre("");
    setCategoria("");
    setTutor("");
    setAutoriza(false);
    setResultado(null);
    setErrorEnvio(null);
    setErrorDatos(null);
    setFotos([]);
    setPaso(1);
  }

  const progreso = paso === 4 ? 100 : (paso / 3) * 100;
  const primero = primerNombre(nombre);

  // ---- ¿ya está inscrito?
  if (duplicado !== null) {
    return (
      <Hoja
        abierto
        onCerrar={onCerrar}
        titulo="¿Ya está inscrito?"
        pie={
          <>
            <Button onClick={onCerrar}>Es el mismo: cancelar</Button>
            <Button variante="primary" cargando={enviando} onClick={() => enviar(true)}>
              Es otro niño: inscribir
            </Button>
          </>
        }
      >
        <p>
          La cara se parece mucho a <b>{duplicado}</b>, que ya está inscrito. ¿Es otro niño o el mismo?
        </p>
      </Hoja>
    );
  }

  const titulos = { 1: "¿Cómo se llama?", 2: "Autorización", 3: "Fotos de la cara", 4: "Listo" } as const;
  const atras = paso === 2 ? () => setPaso(1) : paso === 3 && !enviando ? () => setPaso(2) : undefined;

  return (
    <Hoja
      abierto
      alta={paso === 3}
      onCerrar={onCerrar}
      titulo={titulos[paso]}
      onAtras={atras}
      pie={
        paso === 1 ? (
          <Button variante="primary" type="submit" form="nn-f1" block>
            Continuar
          </Button>
        ) : paso === 2 ? (
          <Button variante="primary" type="submit" form="nn-f2" block>
            Continuar
          </Button>
        ) : paso === 3 && fotos.length === 3 ? (
          <Button variante="brand" block cargando={enviando} onClick={() => enviar(false)}>
            {!enviando && <UserPlus size={16} aria-hidden />} {enviando ? "Analizando las caras…" : `Inscribir a ${primero}`}
          </Button>
        ) : paso === 4 ? (
          <>
            <Button onClick={otro}>
              <UserPlus size={15} aria-hidden /> Agregar otro niño
            </Button>
            <Button variante="primary" onClick={onCerrar}>
              Listo
            </Button>
          </>
        ) : undefined
      }
    >
      {paso < 4 && (
        <div className="nn-prog">
          <small>Paso {paso} de 3</small>
          <div role="progressbar" aria-label="Progreso" aria-valuemin={0} aria-valuemax={3} aria-valuenow={paso}>
            <i style={{ width: `${progreso}%` }} />
          </div>
        </div>
      )}

      {paso === 1 && (
        <form id="nn-f1" className="nn-paso" onSubmit={datos} noValidate>
          <Campo etiqueta="Nombre y apellido del niño">
            {(id) => (
              <input
                id={id}
                className="s-input"
                value={nombre}
                maxLength={60}
                placeholder="Ej: Sofía Pérez"
                autoComplete="off"
                autoCapitalize="words"
                autoFocus
                enterKeyHint="next"
                onChange={(e) => setNombre(e.target.value)}
              />
            )}
          </Campo>
          {categoriasSede.length > 0 && (
            <div className="s-field">
              <span style={{ fontSize: 13, fontWeight: 500 }}>Categoría (opcional)</span>
              <div className="nn-cats" role="group" aria-label="Categoría">
                {categoriasSede.map((c) => (
                  <button key={c} type="button" className="s-chip" aria-pressed={categoria === c} onClick={() => setCategoria(categoria === c ? "" : c)}>
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}
          {errorDatos && <Alerta tono="err">{errorDatos}</Alerta>}
          <button type="button" className="s-btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={onApoderado}>
            ¿Mejor que lo inscriba el apoderado?
          </button>
        </form>
      )}

      {paso === 2 && (
        <form id="nn-f2" className="nn-paso" onSubmit={autorizacion} noValidate>
          <p style={{ marginTop: 0 }}>
            Sin la autorización firmada del apoderado no se puede guardar la huella facial de <b>{primero}</b>.
          </p>
          <Campo etiqueta="¿Quién autorizó? (padre, madre o tutor)">
            {(id) => (
              <input
                id={id}
                className="s-input"
                value={tutor}
                maxLength={80}
                placeholder="Nombre y apellido"
                autoComplete="off"
                autoCapitalize="words"
                autoFocus
                enterKeyHint="done"
                onChange={(e) => setTutor(e.target.value)}
              />
            )}
          </Campo>
          <label className="s-check">
            <input type="checkbox" checked={autoriza} onChange={(e) => setAutoriza(e.target.checked)} />
            <span>Tengo la autorización firmada para reconocer la cara de {primero} al marcar asistencia.</span>
          </label>
          {errorDatos && <Alerta tono="err">{errorDatos}</Alerta>}
        </form>
      )}

      {paso === 3 && (
        <div className="nn-paso">
          <div>
            <h3>{fotos.length < 3 ? `Foto ${fotos.length + 1} de 3: ${POSES[fotos.length].titulo}` : "Las 3 fotos están listas"}</h3>
            <p className="muted">{fotos.length < 3 ? POSES[fotos.length].texto : "Revisa que se vean bien y toca Inscribir."}</p>
          </div>
          {errorEnvio && <Alerta tono="err">{errorEnvio}</Alerta>}
          {fotos.length < 3 && <Camara key={fotos.length} onCaptura={agregar} deshabilitado={enviando} etiqueta={`Tomar foto ${fotos.length + 1}`} />}
          <div className="nn-poses">
            {POSES.map((p, i) => (
              <div key={p.titulo} className="nn-pose" data-on={i < fotos.length} data-cur={i === fotos.length}>
                {fotos[i] ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element -- vista previa local (blob:) */}
                    <img src={fotos[i].url} alt={`Foto ${i + 1}: ${p.titulo}`} />
                    <Button icono sm aria-label={`Repetir foto ${i + 1}`} onClick={() => quitar(i)} disabled={enviando}>
                      <RotateCcw size={13} />
                    </Button>
                  </>
                ) : (
                  <span>
                    <b>{i + 1}</b>
                    <br />
                    {p.corto}
                  </span>
                )}
              </div>
            ))}
          </div>
          {fotos.length > 0 && fotos.length < 3 && (
            <Button variante="ghost" cargando={enviando} onClick={() => enviar(false)}>
              {enviando ? "Analizando…" : `Terminar con ${fotos.length} foto${fotos.length > 1 ? "s" : ""}`}
            </Button>
          )}
          <p className="muted" style={{ fontSize: 13 }}>
            Buena luz sobre la cara, a unos 50 cm, sin gorra ni lentes de sol, y que no salga nadie más.
          </p>
        </div>
      )}

      {paso === 4 && resultado && (
        <div className="nn-hecho">
          <div className="ico">
            <Check size={26} aria-hidden />
          </div>
          <h3>{resultado.nombre} ya está inscrito</h3>
          <p>Desde ahora puede marcar su llegada en el kiosko.</p>
          {resultado.avisos.map((a) => (
            <Alerta key={a}>{a}</Alerta>
          ))}
        </div>
      )}
    </Hoja>
  );
}
