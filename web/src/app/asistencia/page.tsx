import type { Metadata } from "next";
import Asistencia from "@/components/inicio/Asistencia";

export const metadata: Metadata = {
  title: "Llegada · FA CUP Chile",
};

export default function Page() {
  return <Asistencia />;
}
