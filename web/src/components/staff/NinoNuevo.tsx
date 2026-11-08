"use client";

// "Niño nuevo": llegó a probarse. Paso 1: se anota como invitado (con asistencia). Paso 2: QR para que el apoderado
// complete la inscripción desde su celular.

import { ArrowRight, Check, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ordenarCategorias, textoError } from "@/lib/staff-api";
import { enlaceRapido, type EnlaceVivo } from "./Enlaces";
import { PanelQr } from "./Qr";
import { Alerta, Button, Campo, Dialogo, useQuery } from "./ui";

/** Categorías activas de la sede, ordenadas. */
export function useCategoriasActivas() {
  const q = useQuery(api.categorias);
  return ordenarCategorias((q.data ?? []).filter((c) => c.activa).map((c) => c.nombre));
}

export function CamposInvitado({
  nombre,
  categoria,
  categorias,
  onNombre,
  onCategoria,
}: {
  nombre: string;
  categoria: string;
  categorias: string[];
  onNombre: (v: string) => void;
  onCategoria: (v: string) => void;
}) {
  return (
    <>
      <Campo etiqueta="Nombre y apellido del niño">
        {(id) => <input id={id} className="s-input" value={nombre} maxLength={60} placeholder="Ej: Matías Rojas" autoComplete="off" onChange={(e) => onNombre(e.target.value)} />}
      </Campo>
      <Campo etiqueta="Categoría (opcional)">
        {(id) => (
          <select id={id} className="s-select" value={categoria} onChange={(e) => onCategoria(e.target.value)}>
            <option value="">Sin categoría</option>
            {categorias.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
      </Campo>
    </>
  );
}

/** Cuerpo del paso del QR: genera un enlace de inscripción para la categoría y lo muestra. */
function ContenidoQrApoderado({ nombre, categoria }: { nombre: string; categoria: string }) {
  const [enlace, setEnlace] = useState<EnlaceVivo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let cancelado = false;
    enlaceRapido(categoria)
      .then((e) => {
        if (cancelado) return;
        setEnlace(e);
        setError(null);
      })
      .catch((e) => !cancelado && setError(textoError(e, "No se pudo generar el QR.")))
      .finally(() => !cancelado && setCargando(false));
    return () => {
      cancelado = true;
    };
  }, [categoria, intento]);

  return (
    <>
      <Alerta tono="ok">
        <b>{nombre}</b> quedó anotado como invitado con asistencia de hoy.
      </Alerta>
      {error && (
        <Alerta tono="err">
          {error}{" "}
          <Button
            sm
            cargando={cargando}
            onClick={() => {
              setCargando(true);
              setIntento((n) => n + 1);
            }}
          >
            Reintentar
          </Button>
        </Alerta>
      )}
      {enlace ? <PanelQr url={enlace.url} expira={enlace.expira} /> : !error && <p className="muted">Generando el QR…</p>}
      <ol className="s-pasos-txt">
        <li>El apoderado escanea el QR con su celular y completa los datos, la autorización y las fotos.</li>
        <li>
          Su solicitud llega a <b>Niños &gt; Por aprobar</b>. Ahí la apruebas y eliges a <b>{nombre}</b> en «Vincular con invitado» para conservar su asistencia.
        </li>
        <li>
          <Check size={13} aria-hidden style={{ verticalAlign: "-2px" }} /> Si no la aprueban, sigue como invitado y no se reconocerá su cara.
        </li>
      </ol>
    </>
  );
}

/** Diálogo "que su apoderado se inscriba" (QR). Se monta cuando hace falta y se cierra con onCerrar. */
export function DialogoQrApoderado({ nombre, categoria, onCerrar }: { nombre: string; categoria: string; onCerrar: () => void }) {
  return (
    <Dialogo abierto onCerrar={onCerrar} titulo="Ahora, que su apoderado se inscriba" ancho pie={<Button variante="primary" onClick={onCerrar}>Listo</Button>}>
      <ContenidoQrApoderado nombre={nombre} categoria={categoria} />
    </Dialogo>
  );
}

export function NinoNuevo({ onCreado, className, sm }: { onCreado?: () => void; className?: string; sm?: boolean }) {
  const categorias = useCategoriasActivas();
  const [abierto, setAbierto] = useState(false);
  const [paso, setPaso] = useState<1 | 2>(1);
  const [nombre, setNombre] = useState("");
  const [categoria, setCategoria] = useState("");
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creado, setCreado] = useState<string | null>(null);

  function cerrar() {
    if (creado) onCreado?.();
    setAbierto(false);
    setPaso(1);
    setNombre("");
    setCategoria("");
    setCreado(null);
    setError(null);
  }

  async function registrar() {
    setTrabajando(true);
    setError(null);
    try {
      const r = await api.crearInvitado(nombre.trim(), categoria);
      setCreado(r.nombre);
      setPaso(2);
      onCreado?.();
      setTrabajando(false);
    } catch (e) {
      setError(textoError(e, "No se pudo registrar al niño."));
      setTrabajando(false);
    }
  }

  return (
    <>
      <Button variante="brand" sm={sm} className={className} data-tour="nino-nuevo" onClick={() => setAbierto(true)}>
        <UserPlus size={15} aria-hidden /> Niño nuevo
      </Button>

      <Dialogo
        abierto={abierto}
        onCerrar={cerrar}
        titulo={paso === 1 ? "Niño nuevo: ¿cómo se llama?" : "Ahora, que su apoderado se inscriba"}
        ancho={paso === 2}
        pie={
          paso === 1 ? (
            <>
              <Button onClick={cerrar}>Cancelar</Button>
              <Button variante="primary" cargando={trabajando} disabled={nombre.trim().length < 2} onClick={registrar}>
                Registrar y ver QR <ArrowRight size={15} aria-hidden />
              </Button>
            </>
          ) : (
            <Button variante="primary" onClick={cerrar}>
              Listo
            </Button>
          )
        }
      >
        {paso === 1 ? (
          <>
            <p className="muted">Se anota como invitado y se marca su asistencia de hoy. Todavía no se guarda su cara: eso lo autoriza su apoderado.</p>
            {error && <Alerta tono="err">{error}</Alerta>}
            <CamposInvitado nombre={nombre} categoria={categoria} categorias={categorias} onNombre={setNombre} onCategoria={setCategoria} />
          </>
        ) : (
          <ContenidoQrApoderado nombre={creado ?? ""} categoria={categoria} />
        )}
      </Dialogo>
    </>
  );
}
