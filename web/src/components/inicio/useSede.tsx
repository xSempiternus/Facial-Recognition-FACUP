"use client";

// Estado de la sede de la ruta pública (/s/<slug>): existe, no existe o no se pudo consultar.

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { infoSede, type InfoSede } from "@/lib/api";
import { fijarSede } from "@/lib/sede";

export type EstadoSede =
  | { estado: "sin_sede" } // ruta raíz: sede por defecto del servidor
  | { estado: "cargando" }
  | { estado: "ok"; info: InfoSede }
  | { estado: "no_existe" }
  | { estado: "error" }; // servidor sin respuesta: se sigue sin mostrar el nombre

export function useSede(slug?: string): EstadoSede {
  const [res, setRes] = useState<{ slug: string; r: EstadoSede } | null>(null);

  useEffect(() => {
    if (!slug) return;
    let vivo = true;
    infoSede(slug)
      .then((info) => {
        if (!vivo) return;
        if (info) fijarSede(info.slug, info.nombre);
        setRes({ slug, r: info ? { estado: "ok", info } : { estado: "no_existe" } });
      })
      .catch(() => vivo && setRes({ slug, r: { estado: "error" } }));
    return () => {
      vivo = false;
    };
  }, [slug]);

  if (!slug) return { estado: "sin_sede" };
  return res && res.slug === slug ? res.r : { estado: "cargando" };
}

/** Pantalla sobria para una sede inexistente, con el estilo del menú. */
export function SedeNoExiste({ slug }: { slug: string }) {
  return (
    <main className="menu-raiz">
      <div className="menu-velo" />
      <div className="menu-escena">
        <div className="menu-logo">
          <Image src="/logo-blanco.png" alt="FA CUP Chile" width={469} height={100} priority className="h-full w-auto" />
        </div>
        <section className="menu-panel" aria-labelledby="sede-error">
          <div className="menu-textos">
            <h1 id="sede-error" className="menu-titulo">
              Sede no
              <br />
              encontrada
            </h1>
            <p className="menu-sub">No existe la sede «{slug}». Revisa el enlace o pide el correcto al staff.</p>
          </div>
          <div className="menu-acciones">
            <Link href="/" className="menu-boton menu-boton-primario">
              Ir al inicio
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
