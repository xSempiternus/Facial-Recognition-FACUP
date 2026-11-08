"use client";

// Línea de tiempo por niño: filas = niños, columnas = jornadas (la más reciente a la derecha).
// Punto lleno = vino · aro hueco = faltó · vacío = aún no inscrito.
import { useEffect, useMemo, useRef, useState } from "react";
import { Segmentado } from "@/components/staff/ui";
import { fechaCorta, partesFecha, pct0, type NinoResumen } from "@/lib/staff-api-seguimiento";

type Orden = "nombre" | "asistencia" | "racha";
const LIMITE = 25;

export function Matriz({ fechas, ninos, onNino }: { fechas: string[]; ninos: NinoResumen[]; onNino: (n: NinoResumen) => void }) {
  const [orden, setOrden] = useState<Orden>("nombre");
  const [todos, setTodos] = useState(false);
  const [nota, setNota] = useState("");
  const scroll = useRef<HTMLDivElement>(null);

  const lista = useMemo(() => {
    const l = [...ninos];
    if (orden === "nombre") l.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    if (orden === "asistencia") l.sort((a, b) => (a.porcentaje ?? 101) - (b.porcentaje ?? 101) || a.nombre.localeCompare(b.nombre, "es"));
    if (orden === "racha") l.sort((a, b) => b.racha_actual - a.racha_actual || a.nombre.localeCompare(b.nombre, "es"));
    return l;
  }, [ninos, orden]);
  const visibles = todos ? lista : lista.slice(0, LIMITE);

  // al abrir, mostrar lo más reciente (derecha)
  useEffect(() => {
    const el = scroll.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [fechas.length]);

  return (
    <>
      <div className="sg-fila-ctl">
        <Segmentado<Orden>
          etiqueta="Ordenar niños por"
          valor={orden}
          onChange={setOrden}
          opciones={[
            { valor: "nombre", texto: "Nombre" },
            { valor: "asistencia", texto: "Menos asistencia" },
            { valor: "racha", texto: "Racha" },
          ]}
        />
        <ul className="sg-leyenda" aria-label="Cómo leer la tabla">
          <li>
            <span className="sg-dot vino" aria-hidden /> Vino
          </li>
          <li>
            <span className="sg-dot falto" aria-hidden /> Faltó
          </li>
          <li>
            <span className="sg-dot nada" aria-hidden /> Aún no inscrito
          </li>
        </ul>
      </div>
      <div className="sg-scroll" ref={scroll} tabIndex={0} role="region" aria-label="Línea de tiempo de asistencia por niño. Desliza hacia los lados para ver más jornadas.">
        <table className="sg-matriz">
          <thead>
            <tr>
              <th scope="col" className="sg-n">
                Niño o niña
              </th>
              {fechas.map((f) => {
                const p = partesFecha(f);
                return (
                  <th scope="col" key={f} className="sg-f" title={fechaCorta(f)}>
                    <small>{p.dia}</small>
                    <b className="tnum">{p.num}</b>
                    <small>{p.mes}</small>
                  </th>
                );
              })}
              <th scope="col" className="sg-p">
                %
              </th>
            </tr>
          </thead>
          <tbody>
            {visibles.map((n) => (
              <tr key={n.id}>
                <th scope="row" className="sg-n">
                  <button type="button" onClick={() => onNino(n)} aria-label={`${n.nombre}: ver detalle`}>
                    {n.nombre}
                  </button>
                </th>
                {fechas.map((f) => {
                  const e = n.dias[f];
                  if (!e)
                    return (
                      <td key={f} className="sg-c">
                        <span className="sr-only">Aún no inscrito</span>
                      </td>
                    );
                  const txt = `${n.nombre} · ${fechaCorta(f)} · ${e === "presente" ? "vino" : "faltó"}`;
                  return (
                    <td key={f} className="sg-c">
                      <button type="button" className="sg-cel" aria-label={txt} title={txt} onClick={() => setNota(txt)}>
                        <span className={`sg-dot ${e === "presente" ? "vino" : "falto"}`} aria-hidden />
                      </button>
                    </td>
                  );
                })}
                <td className="sg-p tnum">{pct0(n.porcentaje)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sg-nota muted" aria-live="polite">
        {nota || "Toca un punto para ver la fecha y si vino. Toca un nombre para ver su detalle."}
      </p>
      {lista.length > LIMITE && (
        <button type="button" className="s-btn sg-vertodos" onClick={() => setTodos((t) => !t)}>
          {todos ? "Ver menos" : `Ver todos (${lista.length})`}
        </button>
      )}
    </>
  );
}
