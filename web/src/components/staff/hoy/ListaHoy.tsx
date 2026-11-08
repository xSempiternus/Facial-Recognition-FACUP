"use client";

import { Ban, Check, CircleCheck, PenLine, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { asistenciaDeHoy, type MetricasHoy } from "@/lib/staff-api-hoy";
import { api, ordenarCategorias, sinTildes, textoError } from "@/lib/staff-api";
import { Alerta, Avatar, Button, Campo, Dialogo, Vacio, useToast } from "../ui";

type Pestana = "llegaron" | "faltan" | "invitados";

type Fila = { id: number; nombre: string; categoria: string | null; hora?: string; origen?: string | null };
type Elegido = { fila: Fila; tipo: Pestana };

const SIN_CAT = "Sin categoría";

function indicador(origen?: string | null) {
  if (origen === "manual") return "A mano";
  if (origen === "correccion") return "Revisado";
  return null;
}

function PrimerNino() {
  return (
    <Vacio icono={<Check size={18} />} titulo="Aún no hay niños inscritos" texto="Agrega al primero para empezar a marcar asistencia.">
      <Link href="/staff/ninos" className="s-btn brand">
        Agregar el primer niño
      </Link>
    </Vacio>
  );
}

/** Lista simple del día: Llegaron / Faltan / Invitados, con buscador. Cada fila abre una hoja con la acción útil. */
export function ListaHoy({ data, onCambio }: { data: MetricasHoy; onCambio: () => void }) {
  const [pestana, setPestana] = useState<Pestana>("llegaron");
  const [texto, setTexto] = useState("");
  const [elegido, setElegido] = useState<Elegido | null>(null);

  const hayInvitados = data.invitados.length > 0;
  const activa: Pestana = pestana === "invitados" && !hayInvitados ? "llegaron" : pestana;
  const t = sinTildes(texto);
  const coincide = (f: Fila) => !t || sinTildes(f.nombre).includes(t);

  const llegaron = useMemo(() => [...data.llegaron].sort((a, b) => b.hora.localeCompare(a.hora)).filter(coincide), [data.llegaron, t]); // eslint-disable-line react-hooks/exhaustive-deps
  const invitados = useMemo(() => [...data.invitados].sort((a, b) => b.hora.localeCompare(a.hora)).filter(coincide), [data.invitados, t]); // eslint-disable-line react-hooks/exhaustive-deps
  const grupos = useMemo(() => {
    const filtrados = data.faltan.filter(coincide);
    const por = new Map<string, Fila[]>();
    for (const f of filtrados) por.set(f.categoria ?? SIN_CAT, [...(por.get(f.categoria ?? SIN_CAT) ?? []), f]);
    const claves = ordenarCategorias([...por.keys()].filter((k) => k !== SIN_CAT));
    if (por.has(SIN_CAT)) claves.push(SIN_CAT);
    return claves.map((c) => ({ categoria: c, filas: (por.get(c) ?? []).sort((a, b) => a.nombre.localeCompare(b.nombre)) }));
  }, [data.faltan, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const pestanas: { k: Pestana; texto: string; n: number }[] = [
    { k: "llegaron", texto: "Llegaron", n: data.llegaron.length },
    { k: "faltan", texto: "Faltan", n: data.faltan.length },
    ...(hayInvitados ? [{ k: "invitados" as const, texto: "Invitados", n: data.invitados.length }] : []),
  ];

  const abrir = (fila: Fila, tipo: Pestana) => setElegido({ fila, tipo });

  const fila = (f: Fila, tipo: Pestana) => {
    const ind = indicador(f.origen);
    return (
      <li key={f.id}>
        <button type="button" className="hy-fila" onClick={() => abrir(f, tipo)} aria-label={`${f.nombre}${f.hora ? `, llegó a las ${f.hora}` : ""}`}>
          <Avatar nombre={f.nombre} />
          <span className="hy-fila-n">
            <b>{f.nombre}</b>
            {tipo !== "faltan" && f.categoria && <small>{f.categoria}</small>}
          </span>
          {f.hora && (
            <span className="hy-fila-h tnum">
              {ind && (
                <span className="hy-ind" title={ind}>
                  <PenLine size={12} aria-hidden />
                  <span>{ind}</span>
                </span>
              )}
              {f.hora}
            </span>
          )}
        </button>
      </li>
    );
  };

  const vacioLista = (titulo: string, textoV?: string) => (
    <Vacio icono={<Check size={18} />} titulo={titulo} texto={textoV} />
  );
  const sinNinos = <PrimerNino />;
  const sinResultados = t && ((activa === "llegaron" && !llegaron.length) || (activa === "faltan" && !grupos.length) || (activa === "invitados" && !invitados.length));

  return (
    <section className="s-card hy-lista" aria-label="Niños de hoy" data-tour="hy-lista">
      <div className="hy-lista-h">
        <div className="hy-tabs" role="tablist" aria-label="Lista de hoy">
          {pestanas.map((p) => (
            <button key={p.k} type="button" role="tab" className="hy-tab" aria-selected={activa === p.k} onClick={() => setPestana(p.k)}>
              {p.texto}
              <span className="tnum">{p.n}</span>
            </button>
          ))}
        </div>
        <label className="hy-buscar">
          <Search size={16} aria-hidden />
          <input
            className="s-input"
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="Buscar por nombre…"
            aria-label="Buscar por nombre"
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
          />
        </label>
      </div>

      <div className="hy-lista-b" role="tabpanel">
        {sinResultados ? (
          <Vacio icono={<Search size={18} />} titulo="Nadie coincide" texto="Prueba con solo el apellido." />
        ) : activa === "llegaron" ? (
          llegaron.length === 0 && data.esperados === 0 && data.invitados.length === 0 ? (
            sinNinos
          ) : llegaron.length === 0 ? (
            <Vacio icono={<CircleCheck size={18} />} titulo="Aún no llega nadie" texto="Cuando un niño se escanee en el kiosko aparecerá aquí." />
          ) : (
            <ul className="hy-ul">{llegaron.map((f) => fila(f, "llegaron"))}</ul>
          )
        ) : activa === "faltan" ? (
          grupos.length === 0 ? (
            data.esperados ? vacioLista("Llegaron todos") : sinNinos
          ) : (
            grupos.map((g) => (
              <div key={g.categoria} className="hy-grupo">
                <h3>
                  {g.categoria} <span className="tnum">{g.filas.length}</span>
                </h3>
                <ul className="hy-ul">{g.filas.map((f) => fila(f, "faltan"))}</ul>
              </div>
            ))
          )
        ) : (
          <ul className="hy-ul">{invitados.map((f) => fila(f, "invitados"))}</ul>
        )}
      </div>

      <Dialogo abierto={!!elegido} onCerrar={() => setElegido(null)} titulo={elegido?.fila.nombre ?? ""}>
        {elegido && (
          <Hoja
            key={`${elegido.tipo}${elegido.fila.id}`}
            e={elegido}
            onCerrar={() => setElegido(null)}
            onListo={() => {
              setElegido(null);
              onCambio();
            }}
          />
        )}
      </Dialogo>
    </section>
  );
}

function Hoja({ e, onCerrar, onListo }: { e: Elegido; onCerrar: () => void; onListo: () => void }) {
  const notificar = useToast();
  const { fila, tipo } = e;
  const [motivo, setMotivo] = useState("");
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function marcar() {
    setTrabajando(true);
    setError(null);
    try {
      const r = await api.marcarAsistencia(fila.id);
      notificar(r.ya_registrado ? `${r.nombre} ya estaba marcado` : `${r.nombre} marcado`);
      onListo();
    } catch (x) {
      setError(textoError(x, "No se pudo marcar."));
      setTrabajando(false);
    }
  }

  async function anular() {
    setTrabajando(true);
    setError(null);
    try {
      const a = await asistenciaDeHoy(fila.id);
      if (!a) {
        notificar(`${fila.nombre} ya no tiene asistencia hoy`, "info");
        onListo();
        return;
      }
      await api.anularAsistencia(a.id, motivo.trim());
      notificar(`Asistencia de ${fila.nombre} anulada`);
      onListo();
    } catch (x) {
      setError(textoError(x, "No se pudo anular."));
      setTrabajando(false);
    }
  }

  const sub = [fila.categoria ?? "Sin categoría", fila.hora ? `llegó a las ${fila.hora}` : null].filter(Boolean).join(" · ");
  const ind = indicador(fila.origen);

  return (
    <>
      <p className="muted">
        {sub}
        {ind === "A mano" ? " · marcado a mano" : ind ? " · revisado por el staff" : ""}
      </p>
      {error && <Alerta tono="err">{error}</Alerta>}
      {tipo === "faltan" ? (
        <div className="s-dialog-f s-dialog-f-in">
          <Button onClick={onCerrar}>Cancelar</Button>
          <Button variante="brand" cargando={trabajando} onClick={marcar}>
            <CircleCheck size={16} aria-hidden /> Marcar presente
          </Button>
        </div>
      ) : (
        <>
          <Campo etiqueta="Motivo para anular (opcional)" ayuda="No se borra: queda registrada como anulada.">
            {(id) => <input id={id} className="s-input" value={motivo} maxLength={150} placeholder="Ej: la marcaron por error" autoComplete="off" onChange={(x) => setMotivo(x.target.value)} />}
          </Campo>
          <div className="s-dialog-f s-dialog-f-in">
            <Button onClick={onCerrar}>Cerrar</Button>
            <Button variante="danger" cargando={trabajando} onClick={anular}>
              <Ban size={15} aria-hidden /> Anular asistencia
            </Button>
          </div>
        </>
      )}
    </>
  );
}
