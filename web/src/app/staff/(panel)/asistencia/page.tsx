import { redirect } from "next/navigation";

// La asistencia del día ahora vive en «Hoy».
export default function Asistencia() {
  redirect("/staff");
}
