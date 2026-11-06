import type { Metadata } from "next";
import { Suspense } from "react";
import { preload } from "react-dom";
import Asistencia from "@/components/inicio/Asistencia";

export const metadata: Metadata = {
  title: "Llegada · FA CUP Chile",
};

async function Contenido({ params }: { params: Promise<{ sede: string }> }) {
  const { sede } = await params;
  // Precarga del modelo facial y su wasm solo en el kiosko.
  preload("/models/face_landmarker.task", { as: "fetch", crossOrigin: "anonymous" });
  preload("/mediapipe/vision_wasm_internal.wasm", { as: "fetch", crossOrigin: "anonymous" });
  return <Asistencia sede={decodeURIComponent(sede)} />;
}

export default function Page({ params }: { params: Promise<{ sede: string }> }) {
  return (
    <Suspense fallback={null}>
      <Contenido params={params} />
    </Suspense>
  );
}
