"use client";

import { Camera as CamIcon, CircleCheck, Pencil, QrCode, Search, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Camara } from "@/components/staff/Camara";
import { CamposInvitado, useCategoriasActivas } from "@/components/staff/NinoNuevo";
import { BotonAyuda, Tour, type PasoTour } from "@/components/staff/Tour";
import {
  Alerta,
  Avatar,
  Badge,
  BadgeInvitado,
  Button,
  Dialogo,
  ErrorCarga,
  FiltroCategorias,
  PageHeader,
  SkeletonRows,
  Vacio,
  useQuery,
  useRefrescoAlVolver,
  useToast,
} from "@/components/staff/ui";
import { ApiError, api, fechaHora, ordenarCategorias, textoError, type Jugador } from "@/lib/staff-api";

type Accion = { tipo: "foto" | "autorizar" | "eliminar" | "editar"; j: Jugador } | null;

const PASOS: PasoTour[] = [
  { selector: "[data-tour='buscar']", titulo: "Encuentra a un jugador", texto: "Busca por nombre o filtra por categoría.", lado: "abajo" },
  { selector: "[data-tour='estado']", titulo: "Estado de cada niño", texto: "«Listo» significa que la cámara ya lo reconoce. «Invitado» vino a probarse y aún no tiene autorización de imagen; «Sin autorización» falta la firma del apoderado.", lado: "abajo" },
  { selector: "[data-tour='acciones']", titulo: "Acciones", texto: "Marca asistencia, edita nombre o categoría, agrega una foto o registra la autorización. A un invitado puedes enviarle el QR de inscripción a su familia.", lado: "izq" },
];

export default function Jugadores() {
  const notificar = useToast();
  const { data, error, cargando, reload } = useQuery(api.jugadores);
  useRefrescoAlVolver(reload);
  const categoriasSede = useCategoriasActivas();
  const [nombreEd, setNombreEd] = useState("");
  const [catEd, setCatEd] = useState("");
  const [q, setQ] = useState("");
  const [cats, setCats] = useState<string[]>([]);
  const [accion, setAccion] = useState<Accion>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [tutor, setTutor] = useState("");
  const [confirma, setConfirma] = useState(false);
  const [errorFoto, setErrorFoto] = useState<string | null>(null);

  const categorias = useMemo(() => ordenarCategorias(new Set((data ?? []).map((j) => j.categoria).filter((c): c is string => !!c))), [data]);
  const filtrados = useMemo(
    () => (data ?? []).filter((j) => j.nombre.toLowerCase().includes(q.trim().toLowerCase()) && (!cats.length || (j.categoria && cats.includes(j.categoria)))),
    [data, q, cats],
  );

  function abrirEditar(j: Jugador) {
    setNombreEd(j.nombre);
    setCatEd(j.categoria ?? "");
    setAccion({ tipo: "editar", j });
  }

  async function guardarEdicion() {
    if (!accion) return;
    setTrabajando(true);
    try {
      const cambios: { nombre?: string; categoria?: string | null } = {};
      if (nombreEd.trim() !== accion.j.nombre) cambios.nombre = nombreEd.trim();
      if (catEd !== (accion.j.categoria ?? "")) cambios.categoria = catEd || null;
      if (Object.keys(cambios).length) await api.editarJugador(accion.j.id, cambios);
      notificar("Jugador actualizado");
      cerrar();
      reload();
    } catch (e) {
      fallo(e);
    } finally {
      setTrabajando(false);
    }
  }

  function cerrar() {
    setAccion(null);
    setTutor("");
    setConfirma(false);
    setErrorFoto(null);
  }
  const fallo = (e: unknown) => notificar(textoError(e), "err");

  async function marcar(j: Jugador) {
    try {
      const r = await api.marcarAsistencia(j.id);
      notificar(r.ya_registrado ? `${j.nombre} ya estaba anotado hoy` : `Asistencia de ${j.nombre} registrada`, r.ya_registrado ? "info" : "ok");
    } catch (e) {
      fallo(e);
    }
  }

  async function guardarFoto(blob: Blob) {
    if (!accion) return;
    setTrabajando(true);
    setErrorFoto(null);
    try {
      await api.agregarFoto(accion.j.id, blob);
      notificar(`Foto agregada a ${accion.j.nombre}`);
      cerrar();
      reload();
    } catch (e) {
      setErrorFoto(e instanceof ApiError && e.codigo === "sin_rostro" ? "No se detectó una cara. Revisa la luz y que mire de frente." : textoError(e, "No se pudo guardar."));
    } finally {
      setTrabajando(false);
    }
  }

  async function autorizar() {
    if (!accion) return;
    setTrabajando(true);
    try {
      await api.consentimiento(accion.j.id, tutor.trim());
      notificar("Autorización registrada");
      cerrar();
      reload();
    } catch (e) {
      fallo(e);
    } finally {
      setTrabajando(false);
    }
  }

  async function eliminar() {
    if (!accion) return;
    setTrabajando(true);
    try {
      await api.eliminarJugador(accion.j.id);
      notificar(`${accion.j.nombre} eliminado`);
      cerrar();
      reload();
    } catch (e) {
      fallo(e);
    } finally {
      setTrabajando(false);
    }
  }

  if (error && !data) return <ErrorCarga error={error} reintentar={reload} />;

  const sinAut = (data ?? []).filter((j) => j.estado !== "invitado" && !j.tiene_consentimiento).length;
  const sinFoto = (data ?? []).filter((j) => j.estado !== "invitado" && !j.compatible).length;
  const nInvitados = (data ?? []).filter((j) => j.estado === "invitado").length;

  return (
    <>
      <PageHeader titulo="Jugadores" descripcion="Todos los niños inscritos en la liga.">
        <BotonAyuda id="jugadores" />
        <Link className="s-btn primary" href="/staff/inscribir">
          <UserPlus size={15} aria-hidden /> Inscribir
        </Link>
      </PageHeader>
      <Tour id="jugadores" pasos={PASOS} />

      {nInvitados > 0 && (
        <Alerta>
          {nInvitados} invitado(s) vinieron a probarse y aún no tienen autorización de imagen. Envíales el enlace de inscripción desde el botón del código QR en su fila.
        </Alerta>
      )}

      {sinAut > 0 && (
        <Alerta>
          {sinAut} jugador(es) no tienen la autorización del tutor registrada. Usa el botón de escudo en su fila (o elimínalos si no la tienes).
        </Alerta>
      )}
      {sinFoto > 0 && (
        <Alerta>
          {sinFoto} jugador(es) no tienen fotos para el modelo actual y no serán reconocidos. Agrégales una foto (marcados como «Falta foto»).
        </Alerta>
      )}

      <section className="s-card" aria-label="Lista de jugadores">
        <div className="s-card-h">
          <div className="s-input-wrap" data-tour="buscar" style={{ flex: "1 1 240px", maxWidth: 340 }}>
            <Search size={15} aria-hidden />
            <input className="s-input" type="search" placeholder="Buscar por nombre" aria-label="Buscar por nombre" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <FiltroCategorias categorias={categorias} valor={cats} onChange={setCats} />
        </div>

        {cargando && !data ? (
          <SkeletonRows n={7} />
        ) : !data || data.length === 0 ? (
          <Vacio icono={<Users size={18} />} titulo="Todavía no hay jugadores" texto="Inscribe al primero para empezar.">
            <Link className="s-btn primary" href="/staff/inscribir">
              Inscribir jugador
            </Link>
          </Vacio>
        ) : filtrados.length === 0 ? (
          <Vacio icono={<Search size={18} />} titulo="Sin coincidencias" texto="Ningún jugador coincide con la búsqueda." />
        ) : (
          <div className="s-table-wrap">
            <table className="s-table cards">
              <caption className="sr-only">{filtrados.length} de {data.length} jugadores</caption>
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th className="hide-sm">Categoría</th>
                  <th className="num">Asist.</th>
                  <th className="hide-sm">Última vez</th>
                  <th className="hide-sm num">Fotos</th>
                  <th>Estado</th>
                  <th className="act">
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtrados.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <div className="s-person">
                        <Avatar nombre={j.nombre} />
                        <div>
                          <b>{j.nombre}</b>
                          <small className="show-sm">{j.categoria ?? "Sin categoría"}</small>
                        </div>
                      </div>
                    </td>
                    <td className="hide-sm muted">{j.categoria ?? "—"}</td>
                    <td className="num">{j.asistencias}</td>
                    <td className="hide-sm muted tnum">{j.ultima_asistencia ? fechaHora(j.ultima_asistencia) : "—"}</td>
                    <td className="hide-sm num">{j.fotos}</td>
                    <td>
                      <div data-tour={j.id === filtrados[0]?.id ? "estado" : undefined} style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {j.estado === "invitado" ? (
                          <BadgeInvitado />
                        ) : (
                          <>
                            {j.compatible ? <Badge tono="ok">Listo</Badge> : <Badge tono="warn">Falta foto</Badge>}
                            {!j.tiene_consentimiento && <Badge tono="warn">Sin autorización</Badge>}
                          </>
                        )}
                      </div>
                    </td>
                    <td className="act" data-tour={j.id === filtrados[0]?.id ? "acciones" : undefined}>
                      <Button icono sm variante="ghost" aria-label={`Marcar asistencia de hoy: ${j.nombre}`} title="Marcar hoy" onClick={() => marcar(j)}>
                        <CircleCheck size={16} />
                      </Button>
                      <Button icono sm variante="ghost" aria-label={`Editar a ${j.nombre}`} title="Editar nombre o categoría" onClick={() => abrirEditar(j)}>
                        <Pencil size={16} />
                      </Button>
                      {j.estado === "invitado" ? (
                        <Link className="s-btn icon sm ghost" href="/staff/solicitudes?qr=1" aria-label={`Enviar enlace de inscripción para ${j.nombre}`} title="Enviar enlace de inscripción">
                          <QrCode size={16} />
                        </Link>
                      ) : (
                        <Button icono sm variante="ghost" aria-label={`Agregar foto a ${j.nombre}`} title="Agregar foto" onClick={() => setAccion({ tipo: "foto", j })}>
                          <CamIcon size={16} />
                        </Button>
                      )}
                      {j.estado !== "invitado" && !j.tiene_consentimiento && (
                        <Button icono sm variante="ghost" aria-label={`Registrar autorización de ${j.nombre}`} title="Registrar autorización" onClick={() => setAccion({ tipo: "autorizar", j })}>
                          <ShieldCheck size={16} />
                        </Button>
                      )}
                      <Button icono sm variante="ghost" aria-label={`Eliminar a ${j.nombre}`} title="Eliminar" onClick={() => setAccion({ tipo: "eliminar", j })}>
                        <Trash2 size={16} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialogo
        abierto={accion?.tipo === "editar"}
        onCerrar={cerrar}
        titulo="Editar jugador"
        pie={
          <>
            <Button onClick={cerrar}>Cancelar</Button>
            <Button variante="primary" cargando={trabajando} disabled={nombreEd.trim().length < 2} onClick={guardarEdicion}>
              Guardar
            </Button>
          </>
        }
      >
        <CamposInvitado
          nombre={nombreEd}
          categoria={catEd}
          categorias={accion?.j.categoria && !categoriasSede.includes(accion.j.categoria) ? [accion.j.categoria, ...categoriasSede] : categoriasSede}
          onNombre={setNombreEd}
          onCategoria={setCatEd}
        />
      </Dialogo>

      <Dialogo abierto={accion?.tipo === "foto"} onCerrar={cerrar} titulo="Agregar foto" ancho pie={<Button onClick={cerrar}>Cancelar</Button>}>
        <p className="muted">
          Toma una foto más de <b style={{ color: "var(--fg)" }}>{accion?.j.nombre}</b>. Se suma a las que ya tiene (útil si a veces no lo reconoce, o si cambió mucho). Su historial se conserva.
        </p>
        {errorFoto && <Alerta tono="err">{errorFoto}</Alerta>}
        {accion?.tipo === "foto" && <Camara onCaptura={guardarFoto} deshabilitado={trabajando} etiqueta={trabajando ? "Analizando…" : "Tomar y guardar foto"} />}
      </Dialogo>

      <Dialogo
        abierto={accion?.tipo === "autorizar"}
        onCerrar={cerrar}
        titulo="Autorización del tutor"
        pie={
          <>
            <Button onClick={cerrar}>Cancelar</Button>
            <Button variante="primary" cargando={trabajando} disabled={!tutor.trim() || !confirma} onClick={autorizar}>
              Guardar
            </Button>
          </>
        }
      >
        <p className="muted">
          Registra la autorización firmada para <b style={{ color: "var(--fg)" }}>{accion?.j.nombre}</b>.
        </p>
        <div className="s-field">
          <label htmlFor="tutor">Nombre del padre, madre o tutor que firmó</label>
          <input id="tutor" className="s-input" value={tutor} onChange={(e) => setTutor(e.target.value)} autoComplete="off" />
        </div>
        <label className="s-check">
          <input type="checkbox" checked={confirma} onChange={(e) => setConfirma(e.target.checked)} />
          <span>Confirmo que tengo la autorización firmada</span>
        </label>
      </Dialogo>

      <Dialogo
        abierto={accion?.tipo === "eliminar"}
        onCerrar={cerrar}
        titulo="¿Eliminar jugador?"
        pie={
          <>
            <Button onClick={cerrar}>Cancelar</Button>
            <Button variante="danger" cargando={trabajando} onClick={eliminar}>
              Sí, eliminar
            </Button>
          </>
        }
      >
        <p className="muted">
          Se eliminará a <b style={{ color: "var(--fg)" }}>{accion?.j.nombre}</b> y todo su historial de asistencia. Esta acción no se puede deshacer.
        </p>
      </Dialogo>
    </>
  );
}
