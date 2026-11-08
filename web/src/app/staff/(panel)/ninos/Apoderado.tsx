"use client";

// «Que se inscriba el apoderado»: QR y enlace del formulario de padres. 7 días, sin pedir configuración.

import { SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { PanelQr } from "@/components/staff/Qr";
import { useCategoriasActivas } from "@/components/staff/NinoNuevo";
import { Alerta, Button, Campo, Segmentado, useToast } from "@/components/staff/ui";
import { api, textoError } from "@/lib/staff-api";
import { enlaceApoderado, type EnlaceApoderado } from "@/lib/staff-api-ninos";

export function ContenidoApoderado({ nombre }: { nombre?: string }) {
  const notificar = useToast();
  const categorias = useCategoriasActivas();
  const [categoria, setCategoria] = useState("");
  const [dias, setDias] = useState<"1" | "7" | "30">("7");
  const [opciones, setOpciones] = useState(false);
  const [enlace, setEnlace] = useState<EnlaceApoderado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [intento, setIntento] = useState(0);
  const [anulando, setAnulando] = useState(false);
  const [confirmaAnular, setConfirmaAnular] = useState(false);

  useEffect(() => {
    let cancelado = false;
    enlaceApoderado(categoria, Number(dias))
      .then((e) => {
        if (cancelado) return;
        setEnlace(e);
        setError(null);
      })
      .catch((e) => !cancelado && setError(textoError(e, "No se pudo crear el enlace.")))
      .finally(() => !cancelado && setCargando(false));
    return () => {
      cancelado = true;
    };
  }, [categoria, dias, intento]);

  function reintentar() {
    setEnlace(null);
    setError(null);
    setCargando(true);
    setIntento((n) => n + 1);
  }

  async function anular() {
    if (!enlace) return;
    setAnulando(true);
    try {
      await api.revocarEnlace(enlace.id);
      notificar("Enlace anulado: ya no se puede usar");
      setConfirmaAnular(false);
      reintentar(); // crea uno nuevo
    } catch (e) {
      notificar(textoError(e, "No se pudo anular."), "err");
    } finally {
      setAnulando(false);
    }
  }

  return (
    <>
      {nombre && (
        <Alerta>
          Cuando el apoderado de <b>{nombre}</b> complete el formulario, lo apruebas en «Por aprobar» y vinculas a {nombre} para conservar su asistencia.
        </Alerta>
      )}
      <p className="muted">
        El apoderado escanea el código (o abre el enlace) y completa los datos, la autorización y las fotos desde su celular. Tú solo apruebas.
      </p>

      {error && (
        <Alerta tono="err">
          {error}{" "}
          <Button sm cargando={cargando} onClick={reintentar}>
            Reintentar
          </Button>
        </Alerta>
      )}
      {enlace ? <PanelQr url={enlace.url} expira={enlace.expira} /> : !error && <p className="muted">Preparando el código…</p>}

      <button type="button" className="s-btn ghost sm" style={{ alignSelf: "flex-start" }} aria-expanded={opciones} onClick={() => setOpciones((v) => !v)}>
        <SlidersHorizontal size={14} aria-hidden /> {opciones ? "Ocultar opciones" : "Opciones del enlace"}
      </button>
      {opciones && (
        <div className="nn-colapsable">
          <Campo etiqueta="Categoría" ayuda="Si la eliges, la familia no tendrá que elegirla.">
            {(id) => (
              <select id={id} className="s-select" value={categoria} onChange={(e) => setCategoria(e.target.value)}>
                <option value="">Que la elija la familia</option>
                {categorias.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </Campo>
          <div className="s-field">
            <span style={{ fontSize: 13, fontWeight: 500 }}>¿Cuánto tiempo vale?</span>
            <Segmentado
              etiqueta="Vigencia del enlace"
              valor={dias}
              onChange={setDias}
              opciones={[
                { valor: "1", texto: "1 día" },
                { valor: "7", texto: "7 días" },
                { valor: "30", texto: "30 días" },
              ]}
            />
          </div>
          {enlace &&
            (confirmaAnular ? (
              <Alerta>
                Nadie podrá usar este enlace ni su código. Las inscripciones que ya llegaron no se pierden.
                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <Button sm onClick={() => setConfirmaAnular(false)}>
                    Cancelar
                  </Button>
                  <Button sm variante="danger" cargando={anulando} onClick={anular}>
                    Sí, anular enlace
                  </Button>
                </div>
              </Alerta>
            ) : (
              <Button sm variante="ghost" style={{ alignSelf: "flex-start" }} onClick={() => setConfirmaAnular(true)}>
                Anular este enlace
              </Button>
            ))}
        </div>
      )}
      <small className="muted">Lo puede usar cualquiera que lo reciba hasta que venza: compártelo solo con las familias.</small>
    </>
  );
}
