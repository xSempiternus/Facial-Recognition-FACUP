import type { Metadata } from "next";
import { preload } from "react-dom";
import Asistencia from "@/components/inicio/Asistencia";

export const metadata: Metadata = {
  title: "Llegada · FA CUP Chile",
};

export default function Page() {
  // Precarga del modelo facial y su wasm solo en el kiosko: el menú, login y /staff no los descargan.
  preload("/models/face_landmarker.task", { as: "fetch", crossOrigin: "anonymous" });
  preload("/mediapipe/vision_wasm_internal.wasm", { as: "fetch", crossOrigin: "anonymous" });
  return <Asistencia />;
}
