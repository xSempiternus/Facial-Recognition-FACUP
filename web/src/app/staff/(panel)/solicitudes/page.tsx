"use client";

import { Check, ClipboardList, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Enlaces } from "@/components/staff/Enlaces";
import { CamposInvitado, useCategoriasActivas } from "@/components/staff/NinoNuevo";
import { BotonAyuda, Tour, type PasoTour } from "@/components/staff/Tour";
import {
  Alerta,
  Button,
  Campo,
  Dialogo,
  ErrorCarga,
  PageHeader,
  SkeletonRows,
  Vacio,
  useQuery,
  useRefrescoAlVolver,
  useToast,
} from "@/components/staff/ui";
import { api, fechaHora, publicarPendientes, textoError, type Jugador, type Solicitud } from "@/lib/staff-api";

const PASOS: PasoTour[] = [
  { titulo: "Inscripciones", texto: "Aquí llegan las inscripciones que completan los apoderados desde su celular. Nada entra al sistema hasta que tú lo apruebas." },
  { selector: "[data-tour='enlace']", titulo: "Invita con un enlace o QR", texto: "Toca «Crear enlace», elige la vigencia y muestra el QR al apoderado o envíale el link por WhatsApp.", lado: "abajo" },
  { selector: "[data-tour='solicitud']", titulo: "Revisa y aprueba", texto: "Mira la foto y los datos. Al aprobar puedes corregir el nombre o la categoría. Si el niño vino a probarse, vincúlalo con su invitado para conservar su asistencia.", lado: "abajo" },
  { selector: "[data-tour='duplicado']", titulo: "Ojo con los duplicados", texto: "Si la foto se parece a un niño ya inscrito (o a otra solicitud), te lo avisamos aquí. Rechaza la repetida y se borran sus datos.", lado: "abajo" },
];

const soloQr = () => (typeof window !== "undefined" ? new URLSearchParams(window.location.search).has("qr") : false);

async function cargar() {
  const [solicitudes, jugadores] = await Promise.all([api.solicitudes(), api.jugadores()]);
  return { solicitudes, invitados: jugadores.filter((j) => j.estado === "invitado") };
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const pct = (n: number | null) => (n == null ? "" : ` (${Math.round(n * 100)}% de parecido)`);

export default function Solicitudes() {
  const q = useQuery(cargar);
  const categorias = useCategoriasActivas();
  const abrirQr = useSyncExternalStore(
    () => () => {},
    soloQr,
    () => false,
  );
  const [aprobar, setAprobar] = useState<Solicitud | null>(null);
  const [rechazar, setRechazar] = useState<Solicitud | null>(null);
  useRefrescoAlVolver(q.reload);

  const data = q.data;
  const n = data?.solicitudes.length;
  useEffect(() => {
    if (n !== undefined) publicarPendientes(n);
  }, [n]);

  if (q.error && !data) return <ErrorCarga error={q.error} reintentar={q.reload} />;

  return (
    <>
      <PageHeader titulo="Inscripciones" descripcion="Solicitudes de las familias, por aprobar.">
        <BotonAyuda id="solicitudes" />
        <Button onClick={q.reload} aria-label="Actualizar" cargando={q.cargando && !!data}>
          {!(q.cargando && !!data) && <RefreshCw size={15} aria-hidden />} Actualizar
        </Button>
      </PageHeader>
      <Tour id="solicitudes" pasos={PASOS} />

      {q.error && data && <Alerta tono="err">{q.error.message}</Alerta>}

      <section aria-label="Solicitudes pendientes" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {q.cargando && !data ? (
          <div className="s-card">
            <SkeletonRows n={3} />
          </div>
        ) : !data || data.solicitudes.length === 0 ? (
          <div className="s-card">
            <Vacio icono={<ClipboardList size={18} />} titulo="No hay solicitudes pendientes" texto="Cuando un apoderado complete el formulario, aparecerá aquí. Crea un enlace o QR más abajo para invitarlos.">
              <small className="muted">Las solicitudes sin revisar se borran solas pasado un tiempo.</small>
            </Vacio>
          </div>
        ) : (
          data.solicitudes.map((s, i) => <Tarjeta key={s.id} s={s} primera={i === 0} onAprobar={() => setAprobar(s)} onRechazar={() => setRechazar(s)} />)
        )}
      </section>

      <Enlaces categorias={categorias} abiertoDeInicio={abrirQr} />

      <DialogoAprobar
        s={aprobar}
        invitados={data?.invitados ?? []}
        categorias={categorias}
        onCerrar={() => setAprobar(null)}
        onListo={() => {
          setAprobar(null);
          q.reload();
        }}
      />
      <DialogoRechazar
        s={rechazar}
        onCerrar={() => setRechazar(null)}
        onListo={() => {
          setRechazar(null);
          q.reload();
        }}
      />
    </>
  );
}

function Tarjeta({ s, primera, onAprobar, onRechazar }: { s: Solicitud; primera: boolean; onAprobar: () => void; onRechazar: () => void }) {
  return (
    <article className="s-card s-sol" data-tour={primera ? "solicitud" : undefined} aria-label={`Solicitud de ${s.nombre_nino}`}>
      <div className="s-sol-main">
        {s.miniatura ? (
          // eslint-disable-next-line @next/next/no-img-element -- miniatura en base64
          <img className="s-sol-img" src={`data:image/jpeg;base64,${s.miniatura}`} alt={`Foto de ${s.nombre_nino}`} />
        ) : (
          <div className="s-sol-img" aria-hidden />
        )}
        <div className="s-sol-datos">
          <h3>{s.nombre_nino}</h3>
          <div className="s-sol-meta">
            {s.anio_nacimiento && <span>Nació en {s.anio_nacimiento}</span>}
            <span>{s.categoria ?? "Sin categoría"}</span>
            <span>{s.fotos} foto(s)</span>
            <span>{fechaHora(s.creado_en)}</span>
          </div>
          <div className="s-sol-tutor">
            <b>{s.tutor_nombre}</b>
            <span className="muted"> · {s.tutor_contacto}</span>
          </div>
        </div>
      </div>

      {(s.duplicado || s.duplicado_solicitud) && (
        <div data-tour={primera ? "duplicado" : undefined} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {s.duplicado && (
            <div className="s-alert warn">
              <TriangleAlert size={16} aria-hidden />
              <div>
                <b>Se parece a {s.duplicado.nombre}</b>, que {s.duplicado.estado === "invitado" ? "está como invitado" : "ya está inscrito"}
                {pct(s.duplicado.similitud)}. Antes de aprobar, confirma que no sea el mismo niño.
              </div>
            </div>
          )}
          {s.duplicado_solicitud && (
            <div className="s-alert warn">
              <TriangleAlert size={16} aria-hidden />
              <div>
                <b>Se parece a otra solicitud pendiente</b>
                {pct(s.duplicado_solicitud.similitud)}. Puede que la familia la haya enviado dos veces.
              </div>
            </div>
          )}
        </div>
      )}
      {!s.compatible && (
        <Alerta>No se puede aprobar: se procesó con otro modelo de reconocimiento. Recházala y envía un enlace nuevo a la familia.</Alerta>
      )}

      <div className="s-sol-acc">
        <Button variante="brand" disabled={!s.compatible} onClick={onAprobar}>
          <Check size={15} aria-hidden /> Aprobar
        </Button>
        <Button onClick={onRechazar}>
          <X size={15} aria-hidden /> Rechazar
        </Button>
      </div>
    </article>
  );
}

function DialogoAprobar({
  s,
  invitados,
  categorias,
  onCerrar,
  onListo,
}: {
  s: Solicitud | null;
  invitados: Jugador[];
  categorias: string[];
  onCerrar: () => void;
  onListo: () => void;
}) {
  return (
    <Dialogo abierto={!!s} onCerrar={onCerrar} titulo="Aprobar inscripción" ancho>
      {s && <FormAprobar key={s.id} s={s} invitados={invitados} categorias={categorias} onCerrar={onCerrar} onListo={onListo} />}
    </Dialogo>
  );
}

function FormAprobar({ s, invitados, categorias, onCerrar, onListo }: { s: Solicitud; invitados: Jugador[]; categorias: string[]; onCerrar: () => void; onListo: () => void }) {
  const notificar = useToast();
  const [nombre, setNombre] = useState(s.nombre_nino);
  const [categoria, setCategoria] = useState(s.categoria ?? "");
  const [invitadoId, setInvitadoId] = useState<number>(() => {
    const coincide = invitados.find((i) => norm(i.nombre) === norm(s.nombre_nino) && (!s.categoria || i.categoria === s.categoria));
    return coincide?.id ?? 0;
  });
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opciones = s.categoria && !categorias.includes(s.categoria) ? [s.categoria, ...categorias] : categorias;
  const elegido = invitados.find((i) => i.id === invitadoId);

  async function enviar() {
    setTrabajando(true);
    setError(null);
    try {
      const r = await api.aprobarSolicitud(s.id, { nombre: nombre.trim(), categoria, invitadoId: invitadoId || undefined });
      notificar(r.invitado_convertido ? `${r.nombre} aprobado: conserva su asistencia como invitado` : `${r.nombre} quedó inscrito`);
      onListo();
    } catch (e) {
      setError(textoError(e, "No se pudo aprobar."));
      setTrabajando(false);
    }
  }

  return (
    <>
      <p className="muted">
        Al aprobar, <b style={{ color: "var(--fg)" }}>{s.nombre_nino}</b> queda inscrito con la autorización de {s.tutor_nombre} y se guarda un código numérico (vector) por foto para reconocerlo. La miniatura se borra.
      </p>
      {s.duplicado && (
        <Alerta>
          Se parece a <b>{s.duplicado.nombre}</b>{pct(s.duplicado.similitud)}. Si es el mismo niño, rechaza esta solicitud.
        </Alerta>
      )}
      {error && <Alerta tono="err">{error}</Alerta>}
      <CamposInvitado nombre={nombre} categoria={categoria} categorias={opciones} onNombre={setNombre} onCategoria={setCategoria} />

      {invitados.length > 0 && (
        <Campo etiqueta="¿Vino a probarse antes? Vincúlalo con su invitado" ayuda="Así conserva las asistencias que ya tenía.">
          {(id) => (
            <select id={id} className="s-select" value={invitadoId} onChange={(e) => setInvitadoId(Number(e.target.value))}>
              <option value={0}>No, es un jugador nuevo</option>
              {invitados.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.nombre}
                  {i.categoria ? ` · ${i.categoria}` : ""}
                </option>
              ))}
            </select>
          )}
        </Campo>
      )}
      {elegido && <p className="muted">Se activará a «{elegido.nombre}» con el nombre de arriba.</p>}

      <div className="s-dialog-f s-dialog-f-in">
        <Button onClick={onCerrar}>Cancelar</Button>
        <Button variante="primary" cargando={trabajando} disabled={nombre.trim().length < 2} onClick={enviar}>
          Aprobar inscripción
        </Button>
      </div>
    </>
  );
}

function DialogoRechazar({ s, onCerrar, onListo }: { s: Solicitud | null; onCerrar: () => void; onListo: () => void }) {
  return (
    <Dialogo abierto={!!s} onCerrar={onCerrar} titulo="¿Rechazar solicitud?">
      {s && <FormRechazar key={s.id} s={s} onCerrar={onCerrar} onListo={onListo} />}
    </Dialogo>
  );
}

function FormRechazar({ s, onCerrar, onListo }: { s: Solicitud; onCerrar: () => void; onListo: () => void }) {
  const notificar = useToast();
  const [motivo, setMotivo] = useState("");
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enviar() {
    setTrabajando(true);
    setError(null);
    try {
      await api.rechazarSolicitud(s.id, motivo.trim());
      notificar("Solicitud rechazada y datos borrados");
      onListo();
    } catch (e) {
      setError(textoError(e, "No se pudo rechazar."));
      setTrabajando(false);
    }
  }

  return (
    <>
      <Alerta>
        Se borran para siempre los datos, los vectores y la miniatura de <b>{s.nombre_nino}</b>. La familia tendrá que enviar una solicitud nueva.
      </Alerta>
      {error && <Alerta tono="err">{error}</Alerta>}
      <Campo etiqueta="Motivo (opcional)" ayuda="Queda solo en la actividad interna.">
        {(id) => <input id={id} className="s-input" value={motivo} maxLength={150} placeholder="Ej: solicitud repetida" autoComplete="off" onChange={(e) => setMotivo(e.target.value)} />}
      </Campo>
      <div className="s-dialog-f s-dialog-f-in">
        <Button onClick={onCerrar}>Cancelar</Button>
        <Button variante="danger" cargando={trabajando} onClick={enviar}>
          Sí, rechazar y borrar
        </Button>
      </div>
    </>
  );
}
