"use client";

// Administración de las categorías de la sede (Ajustes): listar, crear, renombrar y desactivar.

import { Pencil, Plus, Tag } from "lucide-react";
import { useState } from "react";
import { api, ordenarCategorias, textoError, type Categoria } from "@/lib/staff-api";
import { Alerta, Badge, Button, Campo, Dialogo, SkeletonRows, Vacio, useQuery, useToast } from "./ui";

export function Categorias() {
  const notificar = useToast();
  const q = useQuery(api.categorias);
  const [nueva, setNueva] = useState("");
  const [editando, setEditando] = useState<{ c: Categoria; nombre: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  async function ejecutar(fn: () => Promise<unknown>, ok: string) {
    setOcupado(true);
    try {
      await fn();
      notificar(ok);
      q.reload();
      return true;
    } catch (e) {
      notificar(textoError(e, "No se pudo completar."), "err");
      return false;
    } finally {
      setOcupado(false);
    }
  }

  const orden = ordenarCategorias((q.data ?? []).map((c) => c.nombre));
  const lista = [...(q.data ?? [])].sort((a, b) => orden.indexOf(a.nombre) - orden.indexOf(b.nombre));

  return (
    <section className="s-card" aria-labelledby="cat">
      <div className="s-card-h">
        <div>
          <h2 id="cat" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Tag size={15} aria-hidden /> Categorías
          </h2>
          <p>Las que aparecen al inscribir jugadores en esta sede. Desactivar una no borra a sus jugadores.</p>
        </div>
      </div>
      <div className="s-card-b" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <form
          className="s-row"
          style={{ alignItems: "flex-end", flexWrap: "wrap" }}
          onSubmit={async (e) => {
            e.preventDefault();
            const nombre = nueva.trim();
            if (nombre && (await ejecutar(() => api.crearCategoria(nombre), "Categoría creada"))) setNueva("");
          }}
        >
          <Campo etiqueta="Nueva categoría">
            {(id) => <input id={id} className="s-input" value={nueva} maxLength={30} placeholder="Ej: Sub-18" onChange={(e) => setNueva(e.target.value)} autoComplete="off" />}
          </Campo>
          <Button type="submit" variante="primary" disabled={!nueva.trim()} cargando={ocupado}>
            <Plus size={15} aria-hidden /> Crear
          </Button>
        </form>

        {q.error && !q.data ? (
          <Alerta>{q.error.message}</Alerta>
        ) : q.cargando && !q.data ? (
          <SkeletonRows n={3} />
        ) : lista.length === 0 ? (
          <Vacio icono={<Tag size={18} />} titulo="Todavía no hay categorías" />
        ) : (
          <div className="s-table-wrap">
            <table className="s-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Estado</th>
                  <th className="act"><span className="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                {lista.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.nombre} <small className="muted">· {c.jugadores} jugador(es)</small>
                    </td>
                    <td>{c.activa ? <Badge tono="ok">Activa</Badge> : <Badge>Desactivada</Badge>}</td>
                    <td className="act">
                      <Button sm disabled={ocupado} onClick={() => setEditando({ c, nombre: c.nombre })} aria-label={`Renombrar ${c.nombre}`}>
                        <Pencil size={14} aria-hidden /> Renombrar
                      </Button>{" "}
                      {c.activa ? (
                        <Button sm disabled={ocupado} onClick={() => ejecutar(() => api.desactivarCategoria(c), "Categoría desactivada")} aria-label={`Desactivar ${c.nombre}`}>
                          Desactivar
                        </Button>
                      ) : (
                        <Button sm disabled={ocupado} onClick={() => ejecutar(() => api.reactivarCategoria(c), "Categoría reactivada")} aria-label={`Reactivar ${c.nombre}`}>
                          Reactivar
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialogo
        abierto={!!editando}
        onCerrar={() => setEditando(null)}
        titulo="Renombrar categoría"
        pie={
          <>
            <Button onClick={() => setEditando(null)}>Cancelar</Button>
            <Button
              variante="primary"
              type="submit"
              form="form-renombrar"
              cargando={ocupado}
              disabled={!editando?.nombre.trim() || editando.nombre.trim() === editando.c.nombre}
            >
              Guardar
            </Button>
          </>
        }
      >
        <form
          id="form-renombrar"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!editando || !editando.nombre.trim() || editando.nombre.trim() === editando.c.nombre || ocupado) return;
            if (await ejecutar(() => api.renombrarCategoria(editando.c, editando.nombre.trim()), "Categoría renombrada")) setEditando(null);
          }}
        >
          <Campo etiqueta="Nombre">
            {(id) => <input id={id} className="s-input" value={editando?.nombre ?? ""} maxLength={30} onChange={(e) => setEditando((s) => (s ? { ...s, nombre: e.target.value } : s))} autoComplete="off" />}
          </Campo>
        </form>
      </Dialogo>
    </section>
  );
}
