import { redirect } from "next/navigation";

// «Reportes» se integró en «Seguimiento» (incluye la descarga de CSV).
export default function Reportes() {
  redirect("/staff/seguimiento");
}
