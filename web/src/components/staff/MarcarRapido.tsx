"use client";

// "Marcar a mano" para la cancha: hoja con buscador que filtra mientras se escribe (sin tildes ni mayúsculas).
// Tocar un nombre registra al instante y deja 5 s para deshacer; la hoja sigue abierta para marcar varios seguidos.

import { Check, Search, Undo2, UserSearch } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAreaVisible } from "@/lib/teclado";
import { aISO, api, ordenarCategorias, sinTildes, textoError, type JugadorSinAsistencia } from "@/lib/staff-api";
import { Alerta, Avatar, Button, Dialogo, FiltroCategorias, SkeletonRows, Vacio, useQuery } from "./ui";

const DESHACER_MS = 5000;

type Marca = { clave: number; jugador: JugadorSinAsistencia; asistenciaId?: number; deshaciendo?: boolean };

export function MarcarRapido({ abierto, onCerrar, onCambio }: { abierto: boolean; onCerrar: () => void; onCambio: () => void }) {
  return (
    <Dialogo abierto={abierto} onCerrar={onCerrar} titulo="Marcar a mano" ancho>
      {abierto && <Contenido onCerrar={onCerrar} onCambio={onCambio} />}
    </Dialogo>
  );
}

function Contenido({ onCerrar, onCambio }: { onCerrar: () => void; onCambio: () => void }) {
  const q = useQuery(api.sinAsistenciaHoy);
  const area = useAreaVisible();
  const [texto, setTexto] = useState("");
  const [cats, setCats] = useState<string[]>([]);
  const [ocultos, setOcultos] = useState<number[]>([]);
  const [marcas, setMarcas] = useState<Marca[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const timers = useRef(new Map<number, number>());
  const sig = useRef(0);
  const cambio = useRef(false);
  const avisarCambio = useRef(onCambio);
  useEffect(() => {
    avisarCambio.current = onCambio;
  });

  // al cerrar la hoja: limpiar timers y avisar a la pantalla una sola vez
  useEffect(() => {
    const t = timers.current;
    return () => {
      t.forEach((x) => window.clearTimeout(x));
      t.clear();
      if (cambio.current) avisarCambio.current();
    };
  }, []);

  const categorias = useMemo(
    () => ordenarCategorias(new Set((q.data ?? []).map((j) => j.categoria).filter((c): c is string => !!c))),
    [q.data],
  );

  const visibles = useMemo(() => {
    const t = sinTildes(texto);
    const orden = (c: string | null) => {
      const i = c ? categorias.indexOf(c) : categorias.length;
      return i < 0 ? categorias.length : i;
    };
    return (q.data ?? [])
      .filter((j) => !ocultos.includes(j.id) && (!cats.length || (j.categoria !== null && cats.includes(j.categoria))))
      .map((j) => {
        const n = sinTildes(j.nombre);
        // los más probables primero: quien empieza con lo escrito (nombre o apellido) antes que quien solo lo contiene
        const rango = !t ? 0 : n.startsWith(t) ? 0 : n.split(/\s+/).some((w) => w.startsWith(t)) ? 1 : n.includes(t) ? 2 : -1;
        return { j, rango };
      })
      .filter((x) => x.rango >= 0)
      .sort((a, b) => a.rango - b.rango || orden(a.j.categoria) - orden(b.j.categoria) || a.j.nombre.localeCompare(b.j.nombre))
      .map((x) => x.j);
  }, [q.data, ocultos, cats, texto, categorias]);

  const olvidar = useCallback((clave: number) => {
    const t = timers.current.get(clave);
    if (t) window.clearTimeout(t);
    timers.current.delete(clave);
    setMarcas((m) => m.filter((x) => x.clave !== clave));
  }, []);

  async function marcar(j: JugadorSinAsistencia) {
    setError(null);
    setInfo(null);
    setTexto(""); // listo para buscar al siguiente
    setOcultos((o) => [...o, j.id]); // feedback inmediato: el nombre sale de la lista
    try {
      const r = await api.marcarAsistencia(j.id);
      if (r.ya_registrado) {
        setInfo(`${j.nombre} ya estaba registrado hoy.`);
        return;
      }
      cambio.current = true;
      const clave = ++sig.current;
      setMarcas((m) => [{ clave, jugador: j, asistenciaId: r.id ?? r.asistencia_id }, ...m].slice(0, 3));
      timers.current.set(clave, window.setTimeout(() => olvidar(clave), DESHACER_MS));
    } catch (e) {
      setOcultos((o) => o.filter((x) => x !== j.id));
      setError(textoError(e, `No se pudo marcar a ${j.nombre}.`));
    }
  }

  async function deshacer(m: Marca) {
    const t = timers.current.get(m.clave);
    if (t) window.clearTimeout(t);
    timers.current.delete(m.clave);
    setMarcas((l) => l.map((x) => (x.clave === m.clave ? { ...x, deshaciendo: true } : x)));
    try {
      let id = m.asistenciaId;
      if (id === undefined) {
        // el backend no devolvió el id: se busca la asistencia de hoy de ese jugador
        const hoy = await api.asistencias(aISO(new Date()));
        id = hoy.filter((a) => a.jugador_id === m.jugador.id && (!a.estado || a.estado === "valida")).sort((a, b) => b.id - a.id)[0]?.id;
      }
      if (id === undefined) throw new Error("sin id");
      await api.anularAsistencia(id, "deshecho al instante");
      setOcultos((o) => o.filter((x) => x !== m.jugador.id));
      olvidar(m.clave);
      cambio.current = true;
    } catch (e) {
      setError(textoError(e, `No se pudo deshacer. Anula a ${m.jugador.nombre} desde la lista de presentes.`));
      olvidar(m.clave);
    }
  }

  const alto = area ? Math.max(150, area.height - 330) : undefined;
  const totalSin = (q.data ?? []).length;
  const marcadosAqui = ocultos.length;

  return (
    <>
      <div className="s-buscar">
        <Search size={16} aria-hidden />
        <input
          className="s-input"
          type="search"
          inputMode="search"
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          placeholder="Escribe un nombre o apellido…"
          aria-label="Buscar jugador por nombre"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && texto.trim() && visibles.length === 1) {
              e.preventDefault();
              void marcar(visibles[0]);
            }
          }}
        />
      </div>
      <FiltroCategorias categorias={categorias} valor={cats} onChange={setCats} />

      {marcas.length > 0 && (
        <div className="s-deshacer-lista" role="status" aria-live="polite">
          {marcas.map((m) => (
            <div key={m.clave} className="s-deshacer" style={{ ["--dur" as string]: `${DESHACER_MS}ms` }}>
              <Check size={15} aria-hidden />
              <span className="s-deshacer-t">
                <b>{m.jugador.nombre}</b> marcado
              </span>
              <Button sm variante="ghost" cargando={m.deshaciendo} onClick={() => deshacer(m)}>
                {!m.deshaciendo && <Undo2 size={14} aria-hidden />} Deshacer
              </Button>
              <span className="s-deshacer-barra" aria-hidden />
            </div>
          ))}
        </div>
      )}
      {info && <Alerta tono="warn">{info}</Alerta>}
      {(error || q.error) && <Alerta tono="err">{error ?? q.error?.message}</Alerta>}

      {q.cargando && !q.data ? (
        <SkeletonRows n={4} />
      ) : totalSin === 0 ? (
        <Vacio icono={<Check size={18} />} titulo="Todos los inscritos ya tienen asistencia hoy" texto="Si llegó alguien que no está inscrito, usa «Niño nuevo»." />
      ) : visibles.length === 0 ? (
        <Vacio
          icono={<UserSearch size={18} />}
          titulo={texto.trim() ? `Nadie coincide con «${texto.trim()}»` : "No quedan jugadores en este filtro"}
          texto={texto.trim() ? "Prueba con solo el apellido. Quizá ya está marcado, o no está inscrito: en ese caso usa «Niño nuevo»." : "Quita el filtro de categoría para ver al resto."}
        />
      ) : (
        <ul className="s-pick" aria-label="Jugadores sin asistencia hoy" style={alto ? { maxHeight: alto } : undefined}>
          {visibles.map((j, i) => {
            const nuevaCat = !texto.trim() && (i === 0 || visibles[i - 1].categoria !== j.categoria);
            return (
              <li key={j.id}>
                {nuevaCat && <div className="s-pick-cat">{j.categoria ?? "Sin categoría"}</div>}
                <button type="button" className="s-pick-fila" onClick={() => marcar(j)} aria-label={`Marcar a ${j.nombre}`}>
                  <Avatar nombre={j.nombre} />
                  <span className="s-pick-n">
                    <b>{j.nombre}</b>
                    <small>{j.categoria ?? "Sin categoría"}</small>
                  </span>
                  <span className="s-pick-marcar">Marcar</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="s-dialog-f s-dialog-f-in">
        <span className="muted s-pick-cuenta">{marcadosAqui > 0 ? `${marcadosAqui} marcado${marcadosAqui === 1 ? "" : "s"} ahora` : `${totalSin} sin marcar`}</span>
        <Button variante="primary" onClick={onCerrar}>
          Listo
        </Button>
      </div>
    </>
  );
}
