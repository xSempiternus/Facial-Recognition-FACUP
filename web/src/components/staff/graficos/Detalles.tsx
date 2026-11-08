"use client";

// Contenido de las hojas: detalle de un día (quién vino / quién faltó) y detalle de un niño.
import { Search } from "lucide-react";
import { useState } from "react";
import { Avatar } from "@/components/staff/ui";
import { fechaCorta, partesFecha, pct0, plural, type JornadaResumen, type NinoResumen } from "@/lib/staff-api-seguimiento";
import { sinTildes } from "@/lib/staff-api";

export function DetalleDia({ jornada, ninos }: { jornada: JornadaResumen; ninos: NinoResumen[] }) {
  const [q, setQ] = useState("");
  const f = sinTildes(q);
  const coincide = (n: NinoResumen) => !f || sinTildes(n.nombre).includes(f);
  const por = (a: NinoResumen, b: NinoResumen) => a.nombre.localeCompare(b.nombre, "es");
  const vinieron = ninos.filter((n) => n.dias[jornada.fecha] === "presente").sort(por);
  const faltaron = ninos.filter((n) => n.dias[jornada.fecha] === "ausente").sort(por);
  const lista = (titulo: string, items: NinoResumen[], tipo: "vino" | "falto") => {
    const vis = items.filter(coincide);
    return (
      <section key={tipo} className="sg-dia-l" aria-label={titulo}>
        <h3>
          <span className={`sg-dot ${tipo}`} aria-hidden /> {titulo} <span className="tnum faint">({items.length})</span>
        </h3>
        {vis.length === 0 ? (
          <p className="muted">{items.length ? "Nadie coincide con la búsqueda." : tipo === "vino" ? "Nadie vino esta jornada." : "Nadie faltó. ¡Asistencia completa!"}</p>
        ) : (
          <ul>
            {vis.map((n) => (
              <li key={n.id}>
                <Avatar nombre={n.nombre} />
                <span className="sg-nm">{n.nombre}</span>
                {n.categoria && <small className="faint">{n.categoria}</small>}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  };
  return (
    <>
      <div className="sg-dia-r">
        <b className="tnum">{jornada.porcentaje}%</b>
        <span className="muted tnum">
          vinieron {jornada.presentes} de {jornada.esperados}
          {jornada.invitados > 0 && ` · ${plural(jornada.invitados, "invitado", "invitados")} aparte`}
        </span>
      </div>
      <label className="sg-buscar">
        <Search size={15} aria-hidden />
        <input className="s-input" type="search" placeholder="Buscar por nombre" aria-label="Buscar por nombre" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {lista("Vinieron", vinieron, "vino")}
      {lista("Faltaron", faltaron, "falto")}
    </>
  );
}

export function DetalleNino({ nino, fechas }: { nino: NinoResumen; fechas: string[] }) {
  const ultimas = fechas.slice(-12);
  return (
    <>
      <div className="sg-nn-kpis">
        <div>
          <b className="tnum">{pct0(nino.porcentaje)}</b>
          <span className="muted">de asistencia</span>
          <small className="faint tnum">
            {nino.presentes} de {nino.jornadas_total} jornadas
          </small>
        </div>
        <div>
          <b className="tnum">{nino.racha_actual}</b>
          <span className="muted">{nino.racha_actual === 1 ? "jornada seguida" : "jornadas seguidas"}</span>
          <small className="faint">viniendo</small>
        </div>
        <div>
          <b className="tnum">{nino.faltas_seguidas}</b>
          <span className="muted">{nino.faltas_seguidas === 1 ? "falta seguida" : "faltas seguidas"}</span>
          <small className="faint">{nino.ultima_asistencia ? `Última vez: ${fechaCorta(nino.ultima_asistencia)}` : "Sin asistencias"}</small>
        </div>
      </div>
      <h3 className="sg-sub">Últimas jornadas</h3>
      <ul className="sg-mini" aria-label="Últimas jornadas">
        {ultimas.map((f) => {
          const e = nino.dias[f];
          const p = partesFecha(f);
          return (
            <li key={f} title={`${fechaCorta(f)}: ${e ? (e === "presente" ? "vino" : "faltó") : "aún no inscrito"}`}>
              <span className={`sg-dot ${e === "presente" ? "vino" : e ? "falto" : "nada"}`} aria-hidden />
              <small className="tnum">{p.num}</small>
              <small>{p.mes}</small>
              <span className="sr-only">{`${fechaCorta(f)}: ${e ? (e === "presente" ? "vino" : "faltó") : "aún no inscrito"}`}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
