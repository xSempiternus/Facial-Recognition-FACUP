"use client";

// /asistencia: el reconocimiento facial. Salir de aquí exige el PIN del staff (un niño no puede volver al menú).
// El gesto "atrás" del navegador tampoco sale: se intercepta y abre el mismo diálogo.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Kiosko from "@/components/kiosko/Kiosko";
import SalidaPin from "./SalidaPin";

export default function Asistencia() {
  const router = useRouter();
  const [pidiendoPin, setPidiendoPin] = useState(false);
  const saliendo = useRef(false);

  // Bloqueo del "atrás": se añade una entrada de historial propia; al retroceder se repone y se pide el PIN.
  useEffect(() => {
    const url = window.location.href;
    window.history.pushState(window.history.state, "", url);
    const alRetroceder = () => {
      if (saliendo.current) return;
      window.history.pushState(window.history.state, "", url);
      setPidiendoPin(true);
    };
    window.addEventListener("popstate", alRetroceder);
    return () => window.removeEventListener("popstate", alRetroceder);
  }, []);

  const abrir = useCallback(() => setPidiendoPin(true), []);
  const cerrar = useCallback(() => setPidiendoPin(false), []);
  const salir = useCallback(() => {
    saliendo.current = true;
    router.replace("/");
  }, [router]);

  return (
    <>
      <Kiosko onSalir={abrir} />
      {pidiendoPin && <SalidaPin onCancelar={cerrar} onCorrecto={salir} />}
    </>
  );
}
