"use client";

// Tendencia: % de asistencia por jornada. SVG propio; los puntos son botones (tocar = detalle del día).
import { useEffect, useRef, useState } from "react";
import { fechaCorta, partesFecha, type JornadaResumen } from "@/lib/staff-api-seguimiento";

const M = { l: 40, r: 16, t: 26, b: 34 };

function useAncho() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.round(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function Tendencia({ jornadas, mejor, peor, onElegir }: { jornadas: JornadaResumen[]; mejor?: string; peor?: string; onElegir: (fecha: string) => void }) {
  const [ref, W] = useAncho();
  const [activo, setActivo] = useState<number | null>(null);
  const H = W && W < 520 ? 230 : 270;
  const n = jornadas.length;
  const iw = Math.max(10, W - M.l - M.r - 16);
  const ih = H - M.t - M.b;
  const x = (i: number) => M.l + 8 + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
  const y = (p: number) => M.t + ih - (Math.max(0, Math.min(100, p)) / 100) * ih;
  const pts = jornadas.map((j, i) => [x(i), y(j.porcentaje)] as const);
  const linea = pts.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)} ${b.toFixed(1)}`).join(" ");
  const area = n > 1 ? `${linea} L${pts[n - 1][0].toFixed(1)} ${y(0)} L${pts[0][0].toFixed(1)} ${y(0)} Z` : "";
  const paso = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 58))));
  const resumen = `Asistencia por jornada, de ${fechaCorta(jornadas[0].fecha)} a ${fechaCorta(jornadas[n - 1].fecha)}. ${jornadas.map((j) => `${fechaCorta(j.fecha)}: ${j.porcentaje}%`).join("; ")}.`;
  const a = activo === null ? null : jornadas[activo];

  return (
    <div className="sg-chart" ref={ref} onMouseLeave={() => setActivo(null)} style={{ height: H }}>
      {W > 0 && (
        <>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={resumen} className="sg-tend">
            <defs>
              <linearGradient id="sg-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--brand)" stopOpacity="0.32" />
                <stop offset="1" stopColor="var(--brand)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 25, 50, 75, 100].map((v) => (
              <g key={v}>
                <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} className="sg-grid" />
                <text x={M.l - 8} y={y(v) + 4} textAnchor="end" className="sg-eje tnum">
                  {v}%
                </text>
              </g>
            ))}
            {activo !== null && <line x1={pts[activo][0]} x2={pts[activo][0]} y1={M.t} y2={y(0)} className="sg-guia" />}
            {area && <path d={area} fill="url(#sg-area)" className="sg-area" />}
            {n > 1 && <path d={linea} pathLength={1} className="sg-linea" />}
            {jornadas.map((j, i) => {
              const esM = j.fecha === mejor;
              const esP = j.fecha === peor && peor !== mejor;
              return (
                <g key={j.fecha}>
                  {esM && <circle cx={pts[i][0]} cy={pts[i][1]} r={9} className="sg-halo" />}
                  <circle cx={pts[i][0]} cy={pts[i][1]} r={activo === i ? 6 : esM || esP ? 5.5 : 4} className={esP ? "sg-pt peor" : "sg-pt"} />
                  {(esM || esP) && (
                    <text x={pts[i][0] + (i === 0 ? 10 : 0)} y={esM ? pts[i][1] - 15 : pts[i][1] + 22} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="sg-marca">
                      {esM ? "Mejor" : "Más baja"}
                    </text>
                  )}
                  {i % paso === 0 && (
                    <text x={pts[i][0]} y={H - 12} textAnchor="middle" className="sg-eje">
                      {(() => {
                        const p = partesFecha(j.fecha);
                        return `${p.dia} ${p.num} ${p.mes}`;
                      })()}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {jornadas.map((j, i) => (
            <button
              key={j.fecha}
              type="button"
              className="sg-hit"
              style={{ left: pts[i][0] - 18, top: pts[i][1] - 18 }}
              aria-label={`${fechaCorta(j.fecha)}: vinieron ${j.presentes} de ${j.esperados} (${j.porcentaje}%). Ver quiénes vinieron`}
              onMouseEnter={() => setActivo(i)}
              onFocus={() => setActivo(i)}
              onBlur={() => setActivo(null)}
              onClick={() => onElegir(j.fecha)}
            />
          ))}
          {a && activo !== null && (
            <div className="sg-tip" style={{ left: Math.max(76, Math.min(W - 76, pts[activo][0])), top: Math.max(4, pts[activo][1] - 66) }} role="status">
              <b>{fechaCorta(a.fecha)}</b>
              <span className="tnum">
                {a.presentes} de {a.esperados} · {a.porcentaje}%
              </span>
            </div>
          )}
        </>
      )}
      <table className="sr-only">
        <caption>Asistencia por jornada</caption>
        <thead>
          <tr>
            <th>Jornada</th>
            <th>Vinieron</th>
            <th>Esperados</th>
            <th>Asistencia</th>
          </tr>
        </thead>
        <tbody>
          {jornadas.map((j) => (
            <tr key={j.fecha}>
              <td>{fechaCorta(j.fecha)}</td>
              <td>{j.presentes}</td>
              <td>{j.esperados}</td>
              <td>{j.porcentaje}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
