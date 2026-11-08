"use client";

// Gráficos simples de «Más detalle»: barras por categoría, histograma de hora de llegada y barra apilada de métodos.
import { plural, type Resumen } from "@/lib/staff-api-seguimiento";

export function BarrasCategoria({ categorias }: { categorias: Resumen["categorias"] }) {
  return (
    <ul className="sg-hbar" aria-label="Asistencia por categoría">
      {categorias.map((c, i) => (
        <li key={c.categoria} style={{ ["--i" as string]: i }}>
          <span className="sg-hb-n">{c.categoria}</span>
          <span className="sg-hb-t" aria-hidden>
            <i style={{ width: `${Math.max(2, c.porcentaje)}%` }} />
          </span>
          <b className="tnum">{Math.round(c.porcentaje)}%</b>
          <small className="faint tnum">{plural(c.ninos, "niño", "niños")}</small>
        </li>
      ))}
    </ul>
  );
}

export function Histograma({ datos, mediana }: { datos: Resumen["llegada"]["histograma"]; mediana: string | null }) {
  if (!datos.length) return <p className="muted">Aún no hay horas de llegada registradas.</p>;
  if (datos.length === 1)
    return (
      <p className="muted">
        Todas las llegadas fueron entre las <b className="tnum">{datos[0].hora}</b> y las <b className="tnum">{String(Number(datos[0].hora.slice(0, 2)) + 1).padStart(2, "0")}:00</b> ({datos[0].cantidad}{" "}
        {datos[0].cantidad === 1 ? "llegada" : "llegadas"}). Cuando haya más variedad de horarios verás la distribución aquí.
      </p>
    );
  const horas = datos.map((d) => Number(d.hora.slice(0, 2)));
  const min = Math.min(...horas) - 1;
  const max = Math.max(...horas) + 1;
  const cols = Array.from({ length: max - min + 1 }, (_, i) => {
    const hh = `${String(min + i).padStart(2, "0")}:00`;
    return { hora: hh, cantidad: datos.find((d) => d.hora === hh)?.cantidad ?? 0 };
  });
  const tope = Math.max(1, ...cols.map((c) => c.cantidad));
  const resumen = `Llegadas por hora: ${cols
    .filter((c) => c.cantidad)
    .map((c) => `${c.hora}, ${c.cantidad}`)
    .join("; ")}.${mediana ? ` La mitad llega antes de las ${mediana}.` : ""}`;
  return (
    <figure className="sg-histo">
      <div className="sg-hi-bars" role="img" aria-label={resumen}>
        {cols.map((c, i) => (
          <div key={c.hora} className="sg-hi-col" style={{ ["--i" as string]: i }}>
            <b className="tnum">{c.cantidad || ""}</b>
            <i style={{ height: `${(c.cantidad / tope) * 100}%` }} />
            <small className="tnum">{c.hora.slice(0, 2)} h</small>
          </div>
        ))}
      </div>
      {mediana && (
        <figcaption>
          La mitad llega antes de las <b className="tnum">{mediana}</b>.
        </figcaption>
      )}
    </figure>
  );
}

const METODOS = [
  { k: "reconocimiento", t: "Reconocimiento facial", c: "a" },
  { k: "manual", t: "A mano", c: "b" },
  { k: "correccion", t: "Corrección", c: "c" },
  { k: "invitado", t: "Invitado", c: "d" },
] as const;

export function Metodos({ metodos }: { metodos: Resumen["metodos"] }) {
  const total = METODOS.reduce((s, m) => s + metodos[m.k], 0);
  if (!total) return <p className="muted">Aún no hay registros.</p>;
  const pc = (v: number) => Math.round((v / total) * 100);
  return (
    <div className="sg-met">
      <div className="sg-met-bar" role="img" aria-label={`Cómo se registraron ${total} llegadas: ${METODOS.map((m) => `${m.t} ${pc(metodos[m.k])}%`).join(", ")}`}>
        {METODOS.map((m) => (
          <i key={m.k} className={`sg-m-${m.c}`} style={{ flexGrow: metodos[m.k], display: metodos[m.k] ? undefined : "none" }} />
        ))}
      </div>
      <ul className="sg-met-l">
        {METODOS.map((m) => (
          <li key={m.k}>
            <span className={`sg-sw sg-m-${m.c}`} aria-hidden />
            <span>{m.t}</span>
            <b className="tnum">{pc(metodos[m.k])}%</b>
            <small className="faint tnum">{metodos[m.k]}</small>
          </li>
        ))}
      </ul>
      <p className="muted">
        El reconocimiento facial registró a <b className="tnum">{pc(metodos.reconocimiento)}%</b> de las llegadas.
      </p>
    </div>
  );
}
