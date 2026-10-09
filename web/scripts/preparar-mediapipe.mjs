// Deja en public/ lo que MediaPipe necesita para correr sin internet en el kiosko:
// - el motor wasm (copiado desde node_modules)
// - el modelo de malla facial (descargado una vez desde Google).
// Corre solo con `npm install` (postinstall). No se versiona: son ~40 MB.

import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const raiz = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const origenWasm = join(raiz, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const destinoWasm = join(raiz, "public", "mediapipe");
const modelo = join(raiz, "public", "models", "face_landmarker.task");
const URL_MODELO =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

await mkdir(destinoWasm, { recursive: true });
for (const archivo of await readdir(origenWasm)) {
  await copyFile(join(origenWasm, archivo), join(destinoWasm, archivo));
}
console.log("MediaPipe: wasm listo en public/mediapipe");

const existe = await stat(modelo).then((s) => s.size > 1_000_000, () => false);
if (existe) {
  console.log("MediaPipe: modelo ya descargado");
} else {
  await mkdir(join(raiz, "public", "models"), { recursive: true });
  try {
    const resp = await fetch(URL_MODELO);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await writeFile(modelo, Buffer.from(await resp.arrayBuffer()));
    console.log("MediaPipe: modelo descargado en public/models");
  } catch (e) {
    // No rompe la instalación: el kiosko avisa "Cámara no disponible" hasta que el modelo exista.
    console.warn(`MediaPipe: no se pudo descargar el modelo (${e.message}). Vuelve a correr "npm run preparar".`);
  }
}
