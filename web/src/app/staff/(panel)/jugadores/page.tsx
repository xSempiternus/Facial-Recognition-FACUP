"use client";

import { Camera as CamIcon, CircleCheck, Search, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Camara } from "@/components/staff/Camara";
import {
  Alerta,
  Avatar,
  Badge,
  Button,
  Dialogo,
  ErrorCarga,
  FiltroCategorias,
  PageHeader,
  SkeletonRows,
  Vacio,
  useQuery,
  useToast,
} from "@/components/staff/ui";
import { ApiError, api, fechaHora, ordenarCategorias, type Jugador } from "@/lib/staff-api";

type Accion = { tipo: "foto" | "autorizar" | "eliminar"; j: Jugador } | null;

export default function Jugadores() {
  const notificar = useToast();
  const { data, error, cargando, reload } = useQuery(api.jugadores);
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

  function cerrar() {
    setAccion(null);
    setTutor("");
    setConfirma(false);
    setErrorFoto(null);
  }
  const fallo = (e: unknown) => notificar(e instanceof ApiError ? e.message : "No se pudo completar la acción.", "err");

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
      setErrorFoto(e instanceof ApiError ? (e.codigo === "sin_rostro" ? "No se detectó una cara. Revisa la luz y que mire de frente." : e.message) : "No se pudo guardar.");
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

  const sinAut = (data ?? []).filter((j) => !j.consentimiento_tutor).length;
  const sinFoto = (data ?? []).filter((j) => !j.compatible).length;

  return (
    <>
      <PageHeader titulo="Jugadores" descripcion="Todos los niños inscritos en la liga.">
        <Link className="s-btn primary" href="/staff/inscribir">
          <UserPlus size={15} aria-hidden /> Inscribir
        </Link>
      </PageHeader>

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
          <div className="s-input-wrap" style={{ flex: "1 1 240px", maxWidth: 340 }}>
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
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {j.compatible ? <Badge tono="ok">Listo</Badge> : <Badge tono="warn">Falta foto</Badge>}
                        {!j.consentimiento_tutor && <Badge tono="warn">Sin autorización</Badge>}
                      </div>
                    </td>
                    <td className="act">
                      <Button icono sm variante="ghost" aria-label={`Marcar asistencia de hoy: ${j.nombre}`} title="Marcar hoy" onClick={() => marcar(j)}>
                        <CircleCheck size={16} />
                      </Button>
                      <Button icono sm variante="ghost" aria-label={`Agregar foto a ${j.nombre}`} title="Agregar foto" onClick={() => setAccion({ tipo: "foto", j })}>
                        <CamIcon size={16} />
                      </Button>
                      {!j.consentimiento_tutor && (
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
