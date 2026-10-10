"""Prepara una foto para la pantalla de inicio del kiosko web (efecto 3D).

Genera web/public/inicio/<nombre>.jpg y <nombre>-profundidad.png con MiDaS (estimación de profundidad),
usando el OpenCV que ya trae el proyecto. El modelo (~65 MB) se descarga una vez a eval/midas_small.onnx.

Uso (con el venv activado, desde la raíz):
    python scripts/foto_inicio.py ruta/a/la/foto.jpg nombre-corto

Después agrega {src, profundidad} a la lista FOTOS en web/src/components/kiosko/Inicio.tsx.
Funcionan mejor las fotos horizontales, con gente en primer plano y fondo lejano (más profundidad = más 3D).
"""

import sys
import urllib.request
from pathlib import Path

import cv2
import numpy as np

RAIZ = Path(__file__).resolve().parent.parent
MODELO = RAIZ / "eval" / "midas_small.onnx"
URL_MODELO = "https://github.com/isl-org/MiDaS/releases/download/v2_1/model-small.onnx"
SALIDA = RAIZ / "web" / "public" / "inicio"


def profundidad(img: np.ndarray, red) -> np.ndarray:
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    rgb = cv2.resize(rgb, (256, 256), interpolation=cv2.INTER_CUBIC)
    rgb = (rgb - np.array([0.485, 0.456, 0.406])) / np.array([0.229, 0.224, 0.225])
    red.setInput(rgb.transpose(2, 0, 1)[None].astype(np.float32))
    d = cv2.resize(red.forward()[0], (img.shape[1], img.shape[0]), interpolation=cv2.INTER_CUBIC)
    d = (d - d.min()) / (d.max() - d.min() + 1e-6)  # 1 = cerca, 0 = lejos
    d = cv2.GaussianBlur(d, (0, 0), sigmaX=img.shape[1] / 300)  # bordes suaves: evita desgarros al mover
    return (d * 255).astype(np.uint8)


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    foto, nombre = Path(sys.argv[1]), sys.argv[2]
    img = cv2.imread(str(foto))
    if img is None:
        sys.exit(f"No se pudo leer la imagen: {foto}")
    if not MODELO.exists():
        print("Descargando MiDaS (una sola vez)…")
        MODELO.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(URL_MODELO, MODELO)

    h, w = img.shape[:2]
    if w > 1920:
        img = cv2.resize(img, (1920, round(h * 1920 / w)), interpolation=cv2.INTER_AREA)
    SALIDA.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(SALIDA / f"{nombre}.jpg"), img,
                [cv2.IMWRITE_JPEG_QUALITY, 86, cv2.IMWRITE_JPEG_PROGRESSIVE, 1])
    prof = profundidad(img, cv2.dnn.readNet(str(MODELO)))
    cv2.imwrite(str(SALIDA / f"{nombre}-profundidad.png"), cv2.resize(prof, (img.shape[1] // 2, img.shape[0] // 2)))
    print(f"Listo: web/public/inicio/{nombre}.jpg y {nombre}-profundidad.png")


if __name__ == "__main__":
    main()
