"use client";

// /asistencia: el reconocimiento facial. El botón de volver regresa directo al menú (sin clave).

import { useRouter } from "next/navigation";
import Kiosko from "@/components/kiosko/Kiosko";

export default function Asistencia() {
  const router = useRouter();
  return <Kiosko onSalir={() => router.replace("/")} />;
}
