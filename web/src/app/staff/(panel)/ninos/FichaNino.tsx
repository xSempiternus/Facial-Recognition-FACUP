"use client";

// Hoja de un niño: sus opciones (asistencia, editar, huella facial, autorización, enlace a la familia, eliminar).

import { Camera as CamIcon, CircleCheck, Pencil, QrCode, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { Camara } from "@/components/staff/Camara";
import { CamposInvitado, useCategoriasActivas } from "@/components/staff/NinoNuevo";
import { Alerta, Avatar, Badge, BadgeInvitado, Button, Campo, useToast } from "@/components/staff/ui";
import { ApiError, api, textoError, type Jugador } from "@/lib/staff-api";
import { estadoNino, primerNombre } from "@/lib/staff-api-ninos";
import { ContenidoApoderado } from "./Apoderado";
import { Hoja } from "./Hoja";
import { Opcion } from "./Opcion";

type Vista = "menu" | "editar" | "foto" | "autorizar" | "eliminar" | "enlace";

export function FichaNino({ nino, onCerrar, onCambio }: { nino: Jugador | null; onCerrar: () => void; onCambio: () => void }) {
  if (!nino) return null;
  return <Ficha key={nino.id} j={nino} onCerrar={onCerrar} onCambio={onCambio} />;
}

function Ficha({ j, onCerrar, onCambio }: { j: Jugador; onCerrar: () => void; onCambio: () => void }) {
  const notificar = useToast();
  const categoriasSede = useCategoriasActivas();
  const [vista, setVista] = useState<Vista>("menu");
  const [trabajando, setTrabajando] = useState(false);
  const [nombre, setNombre] = useState(j.nombre);
  const [categoria, setCategoria] = useState(j.categoria ?? "");
  const [tutor, setTutor] = useState("");
  const [confirma, setConfirma] = useState(false);
  const [errorFoto, setErrorFoto] = useState<string | null>(null);

  const estado = estadoNino(j);
  const invitado = j.estado === "invitado";
  const volver = () => setVista("menu");
  const categorias = j.categoria && !categoriasSede.includes(j.categoria) ? [j.categoria, ...categoriasSede] : categoriasSede;

  async function hacer(fn: () => Promise<void>, error: string) {
    setTrabajando(true);
    try {
      await fn();
    } catch (e) {
      notificar(textoError(e, error), "err");
    } finally {
      setTrabajando(false);
    }
  }

  const marcar = () =>
    hacer(async () => {
      const r = await api.marcarAsistencia(j.id);
      notificar(r.ya_registrado ? `${primerNombre(j.nombre)} ya estaba anotado hoy` : `Asistencia de ${primerNombre(j.nombre)} anotada`, r.ya_registrado ? "info" : "ok");
      onCambio();
      onCerrar();
    }, "No se pudo anotar la asistencia.");

  const guardarEdicion = () =>
    hacer(async () => {
      const cambios: { nombre?: string; categoria?: string | null } = {};
      if (nombre.trim() !== j.nombre) cambios.nombre = nombre.trim();
      if (categoria !== (j.categoria ?? "")) cambios.categoria = categoria || null;
      if (Object.keys(cambios).length) await api.editarJugador(j.id, cambios);
      notificar("Cambios guardados");
      onCambio();
      onCerrar();
    }, "No se pudieron guardar los cambios.");

  const autorizar = () =>
    hacer(async () => {
      await api.consentimiento(j.id, tutor.trim());
      notificar("Autorización registrada");
      onCambio();
      onCerrar();
    }, "No se pudo registrar la autorización.");

  const eliminar = () =>
    hacer(async () => {
      await api.eliminarJugador(j.id);
      notificar(`${primerNombre(j.nombre)} fue eliminado`);
      onCambio();
      onCerrar();
    }, "No se pudo eliminar.");

  async function guardarFoto(blob: Blob) {
    setTrabajando(true);
    setErrorFoto(null);
    try {
      await api.agregarFoto(j.id, blob);
      notificar(`Huella facial de ${primerNombre(j.nombre)} actualizada`);
      onCambio();
      onCerrar();
    } catch (e) {
      setErrorFoto(e instanceof ApiError && e.codigo === "sin_rostro" ? "No detectamos una cara. Revisa la luz y que mire de frente." : textoError(e, "No se pudo guardar."));
    } finally {
      setTrabajando(false);
    }
  }

  const titulos: Record<Vista, string> = {
    menu: j.nombre,
    editar: "Cambiar nombre o categoría",
    foto: "Actualizar huella facial",
    autorizar: "Autorización del apoderado",
    eliminar: `¿Eliminar a ${primerNombre(j.nombre)}?`,
    enlace: "Enlace para su familia",
  };

  const pie =
    vista === "editar" ? (
      <>
        <Button onClick={volver}>Cancelar</Button>
        <Button variante="primary" cargando={trabajando} disabled={nombre.trim().length < 2} onClick={guardarEdicion}>
          Guardar
        </Button>
      </>
    ) : vista === "autorizar" ? (
      <>
        <Button onClick={volver}>Cancelar</Button>
        <Button variante="primary" cargando={trabajando} disabled={!tutor.trim() || !confirma} onClick={autorizar}>
          Guardar
        </Button>
      </>
    ) : vista === "eliminar" ? (
      <>
        <Button onClick={volver}>No, volver</Button>
        <Button variante="danger" cargando={trabajando} onClick={eliminar}>
          Sí, eliminar
        </Button>
      </>
    ) : undefined;

  return (
    <Hoja abierto onCerrar={onCerrar} titulo={vista === "menu" ? "Opciones" : titulos[vista]} onAtras={vista === "menu" ? undefined : volver} alta={vista === "foto"} pie={pie}>
      {vista === "menu" && (
        <>
          <div className="nn-resumen">
            <Avatar nombre={j.nombre} />
            <div style={{ minWidth: 0 }}>
              <b>{j.nombre}</b>
              <small>{j.categoria ?? "Sin categoría"}</small>
              <div style={{ marginTop: 6 }}>{invitado ? <BadgeInvitado /> : <Badge tono={estado.tono === "ok" ? "ok" : "warn"}>{estado.texto}</Badge>}</div>
            </div>
          </div>
          <div className="nn-opciones">
            <Opcion icono={<CircleCheck size={19} />} titulo="Anotar asistencia de hoy" texto={j.asistencias ? `${j.asistencias} asistencia${j.asistencias === 1 ? "" : "s"} hasta ahora` : "Aún sin asistencias"} onClick={marcar} />
            {invitado && (
              <Opcion icono={<QrCode size={19} />} titulo="Enviar enlace a su familia" texto="Para que el apoderado lo inscriba con su autorización." onClick={() => setVista("enlace")} tono="aviso" />
            )}
            {!invitado && !j.tiene_consentimiento && (
              <Opcion icono={<ShieldCheck size={19} />} titulo="Registrar autorización" texto="Falta la firma del apoderado." onClick={() => setVista("autorizar")} tono="aviso" />
            )}
            {!invitado && (
              <Opcion
                icono={<CamIcon size={19} />}
                titulo={j.compatible ? "Mejorar su huella facial" : "Agregar su huella facial"}
                texto={j.compatible ? "Toma una foto más si a veces no lo reconoce." : "Sin ella la cámara no lo reconoce."}
                onClick={() => setVista("foto")}
                tono={j.compatible ? undefined : "aviso"}
              />
            )}
            <Opcion icono={<Pencil size={19} />} titulo="Cambiar nombre o categoría" onClick={() => setVista("editar")} />
            <Opcion icono={<Trash2 size={19} />} titulo="Eliminar niño" texto="Se borra todo lo suyo, también la asistencia." onClick={() => setVista("eliminar")} tono="peligro" />
          </div>
        </>
      )}

      {vista === "editar" && (
        <CamposInvitado nombre={nombre} categoria={categoria} categorias={categorias} onNombre={setNombre} onCategoria={setCategoria} />
      )}

      {vista === "foto" && (
        <>
          <p className="muted">
            Toma una foto de <b style={{ color: "var(--fg)" }}>{primerNombre(j.nombre)}</b> de frente y con buena luz. Se suma a lo que ya hay.
          </p>
          {errorFoto && <Alerta tono="err">{errorFoto}</Alerta>}
          <Camara onCaptura={guardarFoto} deshabilitado={trabajando} etiqueta={trabajando ? "Analizando…" : "Tomar y guardar"} />
        </>
      )}

      {vista === "autorizar" && (
        <>
          <p className="muted">
            Anota quién firmó la autorización de <b style={{ color: "var(--fg)" }}>{primerNombre(j.nombre)}</b>.
          </p>
          <Campo etiqueta="Nombre del padre, madre o tutor">
            {(id) => <input id={id} className="s-input" value={tutor} maxLength={80} autoComplete="off" autoCapitalize="words" enterKeyHint="done" onChange={(e) => setTutor(e.target.value)} />}
          </Campo>
          <label className="s-check">
            <input type="checkbox" checked={confirma} onChange={(e) => setConfirma(e.target.checked)} />
            <span>Confirmo que tengo la autorización firmada.</span>
          </label>
        </>
      )}

      {vista === "eliminar" && <Alerta>Se borran su huella facial y todo su historial de asistencia. Esto no se puede deshacer.</Alerta>}

      {vista === "enlace" && <ContenidoApoderado nombre={j.nombre} />}
    </Hoja>
  );
}
