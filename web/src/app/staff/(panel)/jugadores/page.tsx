import { Redirigir } from "../ninos/Redirigir";

const PARAMS = { pestana: "inscritos" };

export default function Jugadores() {
  return <Redirigir params={PARAMS} />;
}
