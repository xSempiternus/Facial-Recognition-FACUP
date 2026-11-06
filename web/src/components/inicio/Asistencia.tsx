"use client";

// /asistencia (o /s/<sede>/asistencia): el reconocimiento facial. El botón de volver regresa directo al menú (sin clave).

import { useRouter } from "next/navigation";
import Kiosko from "@/components/kiosko/Kiosko";
import { rutaSede } from "@/lib/sede";
import { SedeNoExiste, useSede } from "./useSede";

export default function Asistencia({ sede }: { sede?: string }) {
  const router = useRouter();
  const s = useSede(sede);
  if (s.estado === "no_existe" && sede) return <SedeNoExiste slug={sede} />;
  if (s.estado === "cargando") return null;
  return <Kiosko onSalir={() => router.replace(rutaSede(sede, "/"))} />;
}
