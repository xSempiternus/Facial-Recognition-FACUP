import { Redirigir } from "../ninos/Redirigir";

const PARAMS = { agregar: "camara" };

export default function Inscribir() {
  return <Redirigir params={PARAMS} />;
}
