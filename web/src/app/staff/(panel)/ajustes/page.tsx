"use client";

import { CircleHelp, Download, FlaskConical, Save, Share, ShieldCheck, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { Actividad } from "@/components/staff/Actividad";
import { Categorias } from "@/components/staff/Categorias";
import { reiniciarTours } from "@/components/staff/Tour";
import { Alerta, Badge, Button, Campo, Dialogo, ErrorCarga, PageHeader, SkeletonRows, Vacio, useQuery, useToast } from "@/components/staff/ui";
import { estaInstalada, esIOS, type EventoInstalar } from "@/lib/pwa";
import { ApiError, api, descargarRespaldo, textoError, type Config } from "@/lib/staff-api";

function VerGuias() {
  const notificar = useToast();
  const [trabajando, setTrabajando] = useState(false);
  async function reiniciar() {
    setTrabajando(true);
    try {
      await reiniciarTours();
      notificar("Listo: las guías vuelven a estar nuevas. Ábrelas con el botón «?» de cada pantalla.");
    } catch (e) {
      notificar(textoError(e, "No se pudo reiniciar las guías."), "err");
    } finally {
      setTrabajando(false);
    }
  }
  return (
    <Button sm variante="ghost" cargando={trabajando} onClick={reiniciar}>
      {!trabajando && <CircleHelp size={14} aria-hidden />} Volver a ver las guías
    </Button>
  );
}

function InstalarApp() {
  const [evento, setEvento] = useState<EventoInstalar | null>(null);
  const [estado, setEstado] = useState<"cargando" | "instalada" | "ios" | "otro">("cargando");
  useEffect(() => {
    const t = setTimeout(() => setEstado(estaInstalada() ? "instalada" : esIOS() ? "ios" : "otro"), 0);
    const antes = (e: Event) => {
      e.preventDefault();
      setEvento(e as EventoInstalar);
    };
    const listo = () => setEstado("instalada");
    window.addEventListener("beforeinstallprompt", antes);
    window.addEventListener("appinstalled", listo);
    return () => {
      clearTimeout(t);
      window.removeEventListener("beforeinstallprompt", antes);
      window.removeEventListener("appinstalled", listo);
    };
  }, []);
  async function instalar() {
    if (!evento) return;
    try {
      await evento.prompt();
      await evento.userChoice;
    } catch {
      /* el usuario cerró el aviso */
    }
    setEvento(null);
  }
  return (
    <section className="s-card" aria-labelledby="inst">
      <div className="s-card-h">
        <h2 id="inst" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Smartphone size={15} aria-hidden /> Instalar en este dispositivo
        </h2>
      </div>
      <div className="s-card-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {estado === "instalada" ? (
          <p style={{ margin: 0 }}>Listo: la app ya está instalada en este dispositivo.</p>
        ) : evento ? (
          <>
            <p className="muted" style={{ margin: 0 }}>Instálala para abrirla como una app, a pantalla completa y más rápido.</p>
            <div>
              <Button sm onClick={instalar}>
                <Download size={14} aria-hidden /> Instalar
              </Button>
            </div>
          </>
        ) : estado === "ios" ? (
          <p style={{ margin: 0 }}>
            En el iPhone o iPad abre esta página en Safari, toca <Share size={14} aria-hidden style={{ verticalAlign: "-2px" }} /> <strong>Compartir</strong> y
            luego <strong>Agregar a pantalla de inicio</strong>.
          </p>
        ) : estado === "otro" ? (
          <p className="muted" style={{ margin: 0 }}>
            En Android abre el menú del navegador (⋮) y elige <strong>Instalar app</strong> o <strong>Agregar a pantalla de inicio</strong>. Si no aparece, revisa que estés en Chrome y con
            la dirección segura (https).
          </p>
        ) : null}
      </div>
    </section>
  );
}

export default function Ajustes() {
  const cfg = useQuery(api.config);
  const resp = useQuery(api.respaldos);
  const jug = useQuery(api.jugadores);

  if (cfg.error && !cfg.data) return <ErrorCarga error={cfg.error} reintentar={cfg.reload} />;

  const con = (jug.data ?? []).filter((j) => j.estado !== "invitado" && j.tiene_consentimiento).length;
  return (
    <>
      <PageHeader titulo="Ajustes" descripcion="Configuración del reconocimiento, respaldos y privacidad.">
        <VerGuias />
      </PageHeader>
      {cfg.data ? <Reconocimiento key={JSON.stringify(cfg.data)} cfg={cfg.data} total={jug.data?.length ?? 0} onGuardado={cfg.reload} /> : <div className="s-card"><SkeletonRows n={5} /></div>}
      <Categorias />
      <Respaldos query={resp} />
      <Actividad />
      <InstalarApp />

      <section className="s-card" aria-labelledby="priv">
        <div className="s-card-h">
          <h2 id="priv" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <ShieldCheck size={15} aria-hidden /> Privacidad
          </h2>
        </div>
        <div className="s-card-b" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {jug.data && (
            <div className="s-grid c2 kpi" style={{ maxWidth: 440 }}>
              <div className="s-card s-stat">
                <div className="k">Con autorización firmada</div>
                <div className="v">{con}</div>
              </div>
              <div className="s-card s-stat">
                <div className="k">Sin autorización</div>
                <div className="v">{jug.data.length - con}</div>
              </div>
            </div>
          )}
          <ul className="muted" style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
            <li>No se guarda la foto: solo un código numérico (vector) por foto, del que no se puede reconstruir la imagen.</li>
            <li>Mientras una solicitud está por revisar se guarda una miniatura del rostro; se borra al aprobar o rechazar (o a los 30 días).</li>
            <li>Para inscribir se exige el nombre del tutor y confirmar la autorización firmada.</li>
            <li>Si una familia retira su autorización, elimina al jugador: se borran sus huellas y su historial.</li>
          </ul>
        </div>
      </section>

      <section className="s-card" aria-labelledby="ev">
        <div className="s-card-h">
          <div>
            <h2 id="ev" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <FlaskConical size={15} aria-hidden /> Evaluación de modelos <Badge>Próximamente</Badge>
            </h2>
            <p>Elegir modelo, detector y umbral con tus propias fotos. Por ahora sigue disponible en la app anterior.</p>
          </div>
        </div>
      </section>
    </>
  );
}

function Reconocimiento({ cfg, total, onGuardado }: { cfg: Config; total: number; onGuardado: () => void }) {
  const notificar = useToast();
  const [modelo, setModelo] = useState(cfg.modelo);
  const [detector, setDetector] = useState(cfg.detector);
  const [umbral, setUmbral] = useState(cfg.umbral);
  const [anti, setAnti] = useState(Boolean(cfg.antispoofing));
  const [confirmar, setConfirmar] = useState(false);
  const [guardando, setGuardando] = useState(false);

  const nuevo = { modelo, detector, umbral: Math.round(umbral * 100) / 100, antispoofing: anti };
  const cambios: string[] = [];
  if (modelo !== cfg.modelo) cambios.push(`Modelo: ${cfg.modelo} → ${modelo}`);
  if (detector !== cfg.detector) cambios.push(`Detector: ${cfg.detector} → ${detector}`);
  if (nuevo.umbral !== cfg.umbral) cambios.push(`Umbral: ${cfg.umbral} → ${nuevo.umbral}`);
  if (anti !== Boolean(cfg.antispoofing)) cambios.push(`Anti-fotos: ${anti ? "activado" : "desactivado"}`);

  async function aplicar() {
    setGuardando(true);
    try {
      await api.guardarConfig(nuevo);
      notificar("Ajustes aplicados");
      setConfirmar(false);
      onGuardado();
    } catch (e) {
      notificar(e instanceof ApiError ? e.message : "No se pudo guardar.", "err");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <section className="s-card" aria-labelledby="rec">
      <div className="s-card-h">
        <div>
          <h2 id="rec">Reconocimiento</h2>
          <p>Cambiar el modelo exige fotos nuevas de los jugadores.</p>
        </div>
      </div>
      <div className="s-card-b" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div className="s-grid c3">
          <Campo etiqueta="Modelo" ayuda="La red que convierte la cara en su «huella».">
            {(id) => (
              <select id={id} className="s-select" value={modelo} onChange={(e) => setModelo(e.target.value)}>
                {cfg.modelos.map((m) => <option key={m}>{m}</option>)}
              </select>
            )}
          </Campo>
          <Campo etiqueta="Detector de caras" ayuda="opencv: rápido · yunet: rápido y robusto · retinaface: el más preciso (~1 s/foto).">
            {(id) => (
              <select id={id} className="s-select" value={detector} onChange={(e) => setDetector(e.target.value)}>
                {cfg.detectores.map((m) => <option key={m}>{m}</option>)}
              </select>
            )}
          </Campo>
          <Campo etiqueta={`Umbral de parecido: ${umbral.toFixed(2)}`} ayuda="Más alto = más estricto: menos confusiones, pero más niños repiten la foto.">
            {(id) => <input id={id} className="s-range" type="range" min={0.2} max={0.95} step={0.01} value={umbral} onChange={(e) => setUmbral(Number(e.target.value))} />}
          </Campo>
        </div>

        <div className="s-row" style={{ alignItems: "flex-start" }}>
          <input id="anti" type="checkbox" role="switch" className="s-switch" checked={anti} onChange={(e) => setAnti(e.target.checked)} />
          <label htmlFor="anti" style={{ cursor: "pointer" }}>
            <b>Rechazar fotos mostradas en un celular o papel</b> <Badge tono="warn">Experimental</Badge>
            <span className="muted" style={{ display: "block", fontSize: 13 }}>
              En pruebas rechazó por error 4 de 16 fotos reales y hace cada verificación ~2,5× más lenta. Actívalo solo tras probarlo con la cámara real del kiosko.
            </span>
          </label>
        </div>

        <div>
          <Button variante="primary" disabled={!cambios.length} onClick={() => setConfirmar(true)}>
            <Save size={15} aria-hidden /> Guardar cambios
          </Button>
        </div>
      </div>

      <Dialogo
        abierto={confirmar}
        onCerrar={() => setConfirmar(false)}
        titulo="¿Aplicar cambios?"
        pie={
          <>
            <Button onClick={() => setConfirmar(false)}>Cancelar</Button>
            <Button variante="primary" cargando={guardando} onClick={aplicar}>
              Aplicar
            </Button>
          </>
        }
      >
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {cambios.map((c) => <li key={c}>{c}</li>)}
        </ul>
        {modelo !== cfg.modelo && total > 0 && (
          <Alerta>
            Cambia el modelo: los {total} jugador(es) necesitarán fotos nuevas (Jugadores → Agregar foto) para ser reconocidos. Su historial se conserva.
          </Alerta>
        )}
      </Dialogo>
    </section>
  );
}

function Respaldos({ query }: { query: ReturnType<typeof useQuery<{ nombre: string; bytes: number; creado: string }[]>> }) {
  const notificar = useToast();
  const [creando, setCreando] = useState(false);
  const [bajando, setBajando] = useState<string | null>(null);

  async function crear() {
    setCreando(true);
    try {
      await api.crearRespaldo();
      notificar("Respaldo creado");
      query.reload();
    } catch (e) {
      notificar(e instanceof ApiError ? e.message : "No se pudo crear el respaldo.", "err");
    } finally {
      setCreando(false);
    }
  }
  async function bajar(nombre: string) {
    setBajando(nombre);
    try {
      await descargarRespaldo(nombre);
    } catch (e) {
      notificar(e instanceof ApiError ? e.message : "No se pudo descargar.", "err");
    } finally {
      setBajando(null);
    }
  }

  return (
    <section className="s-card" aria-labelledby="resp">
      <div className="s-card-h">
        <div>
          <h2 id="resp">Respaldos</h2>
          <p>Copia automática diaria (se guardan las últimas 14). Descarga una de vez en cuando y guárdala fuera de este computador.</p>
        </div>
        <Button sm cargando={creando} onClick={crear}>
          Crear respaldo ahora
        </Button>
      </div>
      {query.cargando && !query.data ? (
        <SkeletonRows n={3} />
      ) : !query.data || query.data.length === 0 ? (
        <Vacio icono={<Save size={18} />} titulo="Todavía no hay respaldos" />
      ) : (
        <div className="s-table-wrap">
          <table className="s-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th className="num">Tamaño</th>
                <th className="act"><span className="sr-only">Descargar</span></th>
              </tr>
            </thead>
            <tbody>
              {query.data.map((r) => (
                <tr key={r.nombre}>
                  <td className="tnum">{r.creado.slice(0, 16)}</td>
                  <td>
                    <Badge>{r.nombre.endsWith("_auto.db") ? "Automático" : "Manual"}</Badge>
                  </td>
                  <td className="num muted">{Math.round(r.bytes / 1024)} KB</td>
                  <td className="act">
                    <Button sm cargando={bajando === r.nombre} onClick={() => bajar(r.nombre)} aria-label={`Descargar respaldo del ${r.creado.slice(0, 16)}`}>
                      <Download size={14} aria-hidden /> Descargar
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
