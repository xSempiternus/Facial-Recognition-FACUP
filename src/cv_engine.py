"""Motor de visión: detección facial, embeddings y comparación por similitud del coseno."""

import json
import os
from pathlib import Path

import cv2
import numpy as np
from deepface import DeepFace
from deepface.modules.exceptions import SpoofDetected

CONFIG_PATH = Path(__file__).resolve().parent.parent / "data" / "config.json"

# Prioridad: valores por defecto < variables de entorno < data/config.json (lo que guarda la UI).
# Facenet512 es un buen equilibrio precisión/velocidad en CPU.
# Detectores: "opencv" (rápido), "yunet" (rápido y más robusto), "retinaface" (más preciso, más lento).
# antispoofing: detecta fotos mostradas en un celular/papel (FasNet). Solo se aplica en el kiosko.
DEFAULTS = {"modelo": "Facenet512", "detector": "opencv", "umbral": None, "antispoofing": False}
MODELOS = ["Facenet512", "ArcFace", "SFace", "GhostFaceNet", "Facenet", "VGG-Face"]
# Umbral por defecto de cada modelo (cada uno tiene su propia escala de similitud). Algo más estrictos
# que los de DeepFace para verificación 1:1, porque aquí se compara contra toda la liga (1:N).
# Se sobrescriben con MATCH_THRESHOLD, data/config.json o la página de Evaluación.
UMBRAL_POR_MODELO = {"Facenet512": 0.70, "ArcFace": 0.45, "SFace": 0.47, "GhostFaceNet": 0.42,
                     "Facenet": 0.62, "VGG-Face": 0.40}
DETECTORES = ["opencv", "yunet", "retinaface", "mtcnn", "ssd"]


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    env = {"modelo": os.getenv("FACE_MODEL"), "detector": os.getenv("FACE_DETECTOR"),
           "umbral": os.getenv("MATCH_THRESHOLD")}
    cfg.update({k: v for k, v in env.items() if v})
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except (ValueError, OSError):
            pass
    if cfg["umbral"] is None:
        cfg["umbral"] = UMBRAL_POR_MODELO.get(cfg["modelo"], 0.6)
    cfg["umbral"] = float(cfg["umbral"])
    return cfg


config = load_config()


def set_config(modelo: str, detector: str, umbral: float, antispoofing: bool | None = None) -> dict:
    """Cambia la configuración en caliente, la persiste y precarga el modelo."""
    if modelo not in MODELOS:
        raise ValueError(f"Modelo no soportado: {modelo}")
    if detector not in DETECTORES:
        raise ValueError(f"Detector no soportado: {detector}")
    if not 0 < umbral < 1:
        raise ValueError("El umbral debe estar entre 0 y 1.")
    if antispoofing is None:
        antispoofing = config.get("antispoofing", False)
    nuevo = {"modelo": modelo, "detector": detector, "umbral": round(float(umbral), 3),
             "antispoofing": bool(antispoofing)}
    DeepFace.build_model(modelo)  # falla antes de guardar si el modelo no carga
    if nuevo["antispoofing"]:
        DeepFace.build_model("Fasnet", task="spoofing")
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(nuevo, indent=2), encoding="utf-8")
    config.clear()
    config.update(nuevo)
    return dict(config)


class FaceNotFoundError(ValueError):
    """No se detectó ningún rostro en la imagen."""


class SpoofError(ValueError):
    """La cara parece una foto o pantalla, no una persona real."""


def _decode_image(image_bytes: bytes) -> np.ndarray:
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)  # BGR, lo que espera DeepFace
    if img is None:
        raise ValueError("No se pudo decodificar la imagen.")
    return img


def _miniatura(img: np.ndarray, area: dict, lado: int = 160) -> bytes:
    """Recorte cuadrado de la cara con margen, en JPEG pequeño (para revisión del staff)."""
    x, y, w, h = area["x"], area["y"], area["w"], area["h"]
    cx, cy, r = x + w / 2, y + h / 2, max(w, h) * 0.8
    x0, y0 = max(int(cx - r), 0), max(int(cy - r), 0)
    x1, y1 = min(int(cx + r), img.shape[1]), min(int(cy + r), img.shape[0])
    recorte = cv2.resize(img[y0:y1, x0:x1], (lado, lado), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", recorte, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return buf.tobytes() if ok else b""


def analyze_face(image_bytes: bytes, miniatura: bool = False, antispoofing: bool = False) -> dict:
    """
    Detecta el rostro principal (el más grande) y retorna:
    {'embedding', 'num_rostros', 'confianza', 'tamano_rostro'} (+ 'miniatura' JPEG si se pide)
    donde tamano_rostro es la fracción del ancho de la imagen que ocupa la cara.
    Con antispoofing=True lanza SpoofError si la cara parece una foto/pantalla.
    """
    img = _decode_image(image_bytes)
    try:
        faces = DeepFace.represent(
            img_path=img,
            model_name=config["modelo"],
            detector_backend=config["detector"],
            enforce_detection=True,
            align=True,
            anti_spoofing=antispoofing,
        )
    except SpoofDetected as exc:
        raise SpoofError("La cara parece una foto o una pantalla.") from exc
    except ValueError as exc:
        # DeepFace usa ValueError tanto para "sin rostro" como para errores de configuración;
        # solo el primero debe llegar al usuario como FaceNotFoundError.
        if "could not be detected" in str(exc):
            raise FaceNotFoundError("No se detectó ningún rostro en la imagen.") from exc
        raise RuntimeError(f"Error del motor de reconocimiento: {exc}") from exc

    if not faces:
        raise FaceNotFoundError("No se detectó ningún rostro en la imagen.")

    main_face = max(
        faces, key=lambda f: f["facial_area"]["w"] * f["facial_area"]["h"]
    )
    resultado = {
        "embedding": [float(x) for x in main_face["embedding"]],
        "num_rostros": len(faces),
        "confianza": float(main_face.get("face_confidence") or 0.0),
        "tamano_rostro": main_face["facial_area"]["w"] / img.shape[1],
    }
    if miniatura:
        resultado["miniatura"] = _miniatura(img, main_face["facial_area"])
    return resultado


def get_embedding(image_bytes: bytes) -> list[float]:
    """Detecta el rostro principal (el más grande) y retorna su embedding."""
    return analyze_face(image_bytes)["embedding"]


def cosine_similarity(a, b) -> float:
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def find_match(target_embedding, stored_embeddings_dict: dict, threshold: float = 0.6):
    """
    Busca la mejor coincidencia por similitud del coseno.

    stored_embeddings_dict: {clave: embedding} o {clave: [embedding, ...]} (varias fotos por jugador;
    se usa la más parecida). La clave puede ser el id del jugador.
    Retorna (clave, similitud) si la mejor similitud supera el umbral, si no (None, mejor_similitud).
    """
    best_key, best_score = best_candidate(target_embedding, stored_embeddings_dict)
    if best_key is not None and best_score > threshold:
        return best_key, best_score
    return None, best_score


def best_candidate(target_embedding, stored_embeddings_dict: dict):
    """Como find_match pero sin umbral: retorna siempre (clave_más_parecida, similitud)."""
    best_key, best_score = None, -1.0
    for key, embs in stored_embeddings_dict.items():
        if embs and not isinstance(embs[0], (list, tuple, np.ndarray)):
            embs = [embs]  # un solo embedding
        for emb in embs:
            score = cosine_similarity(target_embedding, emb)
            if score > best_score:
                best_key, best_score = key, score
    return best_key, best_score


def warmup() -> None:
    """Carga el modelo en memoria para que la primera petición no sea lenta."""
    DeepFace.build_model(config["modelo"])
    if config.get("antispoofing"):
        DeepFace.build_model("Fasnet", task="spoofing")
