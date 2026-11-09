"use client";

// «Niños»: una sola pantalla para ver, agregar, aprobar y arreglar. Enlaces antiguos: /staff/jugadores, /inscribir y
// /solicitudes redirigen aquí con ?pestana=aprobar, ?agregar=camara o ?qr=1.

import { Camera as CamIcon, ChevronRight, QrCode, Search, UserPlus, Users } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { BotonAyuda, Tour, type PasoTour } from "@/components/staff/Tour";
import { Avatar, Badge, BadgeInvitado, Button, ErrorCarga, PageHeader, SkeletonRows, Vacio, useQuery, useRefrescoAlVolver } from "@/components/staff/ui";
import { api, ordenarCategorias, publicarPendientes, sinTildes, type Jugador } from "@/lib/staff-api";
import { estadoNino } from "@/lib/staff-api-ninos";
import { ParaContactar } from "@/components/staff/ParaContactar";
import "../../ninos.css";
import "../../revisar.css";
import { ContenidoApoderado } from "./Apoderado";
import { FichaNino } from "./FichaNino";
import { Hoja } from "./Hoja";
import { InscribirCamara } from "./InscribirCamara";
import { Opcion } from "./Opcion";
import { ListaPorAprobar } from "./PorAprobar";

const PASOS: PasoTour[] = [
  { selector: "[data-tour='nn-buscar']", titulo: "Encuentra a un niño", texto: "Escribe su nombre o toca una categoría. La lista se filtra mientras escribes.", lado: "abajo" },
  { selector: "[data-tour='nn-agregar']", titulo: "Agrega un niño", texto: "Lo más fácil: que el apoderado se inscriba con un código QR desde su celular. O inscríbelo tú mismo con la cámara.", lado: "abajo" },
  { selector: "[data-tour='nn-pestanas']", titulo: "Inscritos y Por aprobar", texto: "En «Por aprobar» llegan las inscripciones de las familias: revisa la foto y aprueba o rechaza. El número te avisa cuántas hay.", lado: "abajo" },
  { titulo: "Toca un niño", texto: "Al tocar a un niño ves sus opciones: anotar asistencia, cambiar su nombre o categoría, mejorar su huella facial o eliminarlo." },
];

const TAMANO = 60;

async function cargar() {
  const [jugadores, solicitudes] = await Promise.all([api.jugadores(), api.solicitudes()]);
  return { jugadores, solicitudes, invitados: jugadores.filter((j) => j.estado === "invitado") };
}

type Pestana = "inscritos" | "aprobar";
type Hoja0 = null | "agregar" | "camara" | "apoderado";

const sinSuscripcion = () => () => {};
const leerBusqueda = () => window.location.search;

export default function Ninos() {
  const q = useQuery(cargar);
  useRefrescoAlVolver(q.reload);
  const url = useSyncExternalStore(sinSuscripcion, leerBusqueda, () => "");
  const params = useMemo(() => new URLSearchParams(url), [url]);

  const [pestanaElegida, setPestana] = useState<Pestana | null>(null);
  const [hojaElegida, setHoja] = useState<Hoja0 | undefined>(undefined);
  const [ninoId, setNinoId] = useState<number | null>(null);
  const [texto, setTexto] = useState("");
  const [cat, setCat] = useState("");
  const [limite, setLimite] = useState(TAMANO);

  const pestanaUrl: Pestana = ["aprobar", "por-aprobar", "solicitudes"].includes(params.get("pestana") ?? "") ? "aprobar" : "inscritos";
  const pestana = pestanaElegida ?? pestanaUrl;
  const hojaUrl: Hoja0 = params.has("qr") ? "apoderado" : params.get("agregar") === "camara" ? "camara" : params.has("agregar") ? "agregar" : null;
  const hoja = hojaElegida === undefined ? hojaUrl : hojaElegida;

  const data = q.data;
  const nPorAprobar = data?.solicitudes.length;
  useEffect(() => {
    if (nPorAprobar !== undefined) publicarPendientes(nPorAprobar);
  }, [nPorAprobar]);

  const categorias = useMemo(() => ordenarCategorias(new Set((data?.jugadores ?? []).map((j) => j.categoria).filter((c): c is string => !!c))), [data]);
  const filtrados = useMemo(() => {
    const t = sinTildes(texto);
    return (data?.jugadores ?? []).filter((j) => (!t || sinTildes(j.nombre).includes(t)) && (!cat || j.categoria === cat)).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  }, [data, texto, cat]);
  const nino = data?.jugadores.find((j) => j.id === ninoId) ?? null;

  if (q.error && !data) return <ErrorCarga error={q.error} reintentar={q.reload} />;

  const cerrarHoja = () => setHoja(null);
  const total = data?.jugadores.length ?? 0;
  const visibles = filtrados.slice(0, limite);

  return (
    <>
      <PageHeader titulo="Niños">
        <BotonAyuda id="ninos" />
        <Button variante="primary" data-tour="nn-agregar" onClick={() => setHoja("agregar")}>
          <UserPlus size={16} aria-hidden /> Agregar niño
        </Button>
      </PageHeader>
      <Tour id="ninos" pasos={PASOS} />

      <div className="nn-top">
        <div className="nn-tabs" role="tablist" aria-label="Niños" data-tour="nn-pestanas">
          <button type="button" role="tab" className="nn-tab" aria-selected={pestana === "inscritos"} onClick={() => setPestana("inscritos")}>
            Inscritos
          </button>
          <button type="button" role="tab" className="nn-tab" aria-selected={pestana === "aprobar"} onClick={() => setPestana("aprobar")}>
            Por aprobar
            {!!nPorAprobar && <span className="nn-n" aria-label={`${nPorAprobar} por aprobar`}>{nPorAprobar}</span>}
          </button>
        </div>

        {pestana === "inscritos" && (
          <>
            <div className="nn-buscar" data-tour="nn-buscar">
              <Search size={18} aria-hidden />
              <input
                className="s-input"
                type="search"
                inputMode="search"
                enterKeyHint="search"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Buscar un niño por nombre"
                aria-label="Buscar un niño por nombre"
                value={texto}
                onChange={(e) => {
                  setTexto(e.target.value);
                  setLimite(TAMANO);
                }}
              />
            </div>
            {categorias.length > 0 && (
              <div className="nn-chips" role="group" aria-label="Filtrar por categoría">
                {["", ...categorias].map((c) => (
                  <button
                    key={c || "todos"}
                    type="button"
                    className="s-chip"
                    aria-pressed={cat === c}
                    onClick={() => {
                      setCat(c);
                      setLimite(TAMANO);
                    }}
                  >
                    {c || "Todos"}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {pestana === "inscritos" && <ParaContactar id="nn-contactar" />}

      {pestana === "inscritos" ? (
        <section className="s-card" aria-label="Niños inscritos">
          {q.cargando && !data ? (
            <SkeletonRows n={7} />
          ) : total === 0 ? (
            <Vacio icono={<Users size={18} />} titulo="Aún no hay niños" texto="Agrega al primero para empezar.">
              <Button variante="primary" onClick={() => setHoja("agregar")}>
                <UserPlus size={16} aria-hidden /> Agregar niño
              </Button>
            </Vacio>
          ) : filtrados.length === 0 ? (
            <Vacio icono={<Search size={18} />} titulo="Nadie coincide" texto="Prueba con solo el apellido o cambia la categoría.">
              {(texto || cat) && (
                <Button
                  onClick={() => {
                    setTexto("");
                    setCat("");
                  }}
                >
                  Ver a todos
                </Button>
              )}
            </Vacio>
          ) : (
            <>
              <ul className="nn-lista" aria-label={`${filtrados.length} de ${total} niños`}>
                {visibles.map((j) => (
                  <Fila key={j.id} j={j} onAbrir={() => setNinoId(j.id)} />
                ))}
              </ul>
              {filtrados.length > visibles.length && (
                <div className="nn-mas">
                  <Button onClick={() => setLimite((l) => l + TAMANO)}>Mostrar más ({filtrados.length - visibles.length})</Button>
                </div>
              )}
            </>
          )}
        </section>
      ) : (
        <ListaPorAprobar datos={data} cargando={q.cargando} onCambio={q.reload} onInvitar={() => setHoja("apoderado")} />
      )}

      <FichaNino nino={nino} onCerrar={() => setNinoId(null)} onCambio={q.reload} />

      {hoja === "agregar" && (
        <Hoja abierto onCerrar={cerrarHoja} titulo="Agregar niño">
          <div className="nn-opciones">
            <Opcion
              recomendada
              icono={<QrCode size={20} />}
              titulo="Que se inscriba el apoderado"
              texto="Muestra un código QR: la familia completa todo desde su celular y tú solo apruebas."
              onClick={() => setHoja("apoderado")}
            />
            <Opcion icono={<CamIcon size={20} />} titulo="Lo inscribo yo con la cámara" texto="Para cuando el apoderado está contigo y tienes su autorización firmada." onClick={() => setHoja("camara")} />
          </div>
        </Hoja>
      )}

      {hoja === "apoderado" && (
        <Hoja abierto onCerrar={cerrarHoja} titulo="Que se inscriba el apoderado" onAtras={() => setHoja("agregar")}>
          <ContenidoApoderado />
        </Hoja>
      )}

      <InscribirCamara abierto={hoja === "camara"} onCerrar={cerrarHoja} onListo={q.reload} onApoderado={() => setHoja("apoderado")} />
    </>
  );
}

function Fila({ j, onAbrir }: { j: Jugador; onAbrir: () => void }) {
  const e = estadoNino(j);
  return (
    <li>
      <button type="button" className="nn-fila" onClick={onAbrir} aria-label={`${j.nombre}, ${j.categoria ?? "sin categoría"}, ${e.texto}. Ver opciones`}>
        <Avatar nombre={j.nombre} />
        <span className="nn-fila-n">
          <b>{j.nombre}</b>
          <small>{j.categoria ?? <span className="nn-completar">Sin categoría · completar</span>}</small>
        </span>
        {e.tono === "inv" ? <BadgeInvitado /> : <Badge tono={e.tono}>{e.texto}</Badge>}
        <ChevronRight size={18} aria-hidden />
      </button>
    </li>
  );
}
