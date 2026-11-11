"""Motor de visión: detección facial, embeddings y comparación por similitud del coseno."""

import json
import os
import time
from pathlib import Path

import cv2
import numpy as np
from deepface import DeepFace
from deepface.models.Detector import FacialAreaRegion
from deepface.modules import detection as _deteccion
from deepface.modules import modeling as _modeling
from deepface.modules.exceptions import SpoofDetected

from src.plantillas import MARGEN_PAR_CERCANO

CONFIG_PATH = Path(__file__).resolve().parent.parent / "data" / "config.json"

# Cada sede tiene su propia configuración (data/sedes/<slug>/config.json); las funciones de análisis reciben
# esa configuración como `cfg`. El módulo conserva `config` (la global) como valor por defecto.
# Prioridad: valores por defecto < variables de entorno < config.json (lo que guarda la UI).
# Facenet512 es un buen equilibrio precisión/velocidad en CPU.
# Detectores: "opencv" (rápido), "yunet" (rápido y más robusto), "retinaface" (más preciso, más lento).
# antispoofing: detecta fotos mostradas en un celular/papel (FasNet). Solo se aplica en el kiosko.
#
# Veredicto de /verify (el sistema prefiere dudar a equivocarse; cuando duda, decide el staff):
#   ACEPTADO  (asistencia automática): similitud >= umbral (automático) Y margen contra el segundo JUGADOR distinto
#             >= MARGEN_MIN;
#   DUDOSO    : similitud >= umbral_duda pero no se cumple lo anterior (pasa al staff con sugerencia, sin nombre);
#   RECHAZADO : similitud < umbral_duda.
#   Par cercano: si el mejor y el segundo son un par parecido registrado al inscribir (pares_cercanos), solo se
#   acepta con similitud >= umbral + MARGEN_PAR_CERCANO (0.10); si no, DUDOSO.
# "similitud" de un jugador = puntaje robusto (src/plantillas.py): máximo sobre sus fotos de inscripción, con las
# aprendidas por corrección del staff ponderadas x0.9 (mitiga el efecto "hub").
# `umbral` = umbral de aceptación automática; `umbral_duda` = umbral de duda (<= umbral).
# Compatibilidad: una config SIN `umbral_duda` (formato antiguo, p. ej. {"umbral": 0.37}) se interpreta así: el
# `umbral` antiguo pasa a ser el de duda y el automático es antiguo + UMBRAL_AUTO_OFFSET (0.37 -> duda 0.37,
# automático 0.42). Los umbrales por defecto de cada modelo (UMBRAL_POR_MODELO) siguen la misma regla.
DEFAULTS = {"modelo": "Facenet512", "detector": "opencv", "umbral": None, "umbral_duda": None, "antispoofing": False}
MODELOS = ["Facenet512", "ArcFace", "SFace", "GhostFaceNet", "Facenet", "VGG-Face"]
# Umbral por defecto de cada modelo (cada uno tiene su propia escala de similitud). Algo más estrictos
# que los de DeepFace para verificación 1:1, porque aquí se compara contra toda la liga (1:N).
# Son umbrales de DUDA (el automático es +UMBRAL_AUTO_OFFSET).
# Se sobrescriben con MATCH_THRESHOLD (formato antiguo = duda), data/config.json o la página de Evaluación.
UMBRAL_POR_MODELO = {"Facenet512": 0.70, "ArcFace": 0.45, "SFace": 0.47, "GhostFaceNet": 0.42,
                     "Facenet": 0.62, "VGG-Face": 0.40}
DETECTORES = ["opencv", "yunet", "retinaface", "mtcnn", "ssd"]


def _float_env(nombre: str, defecto: float) -> float:
    try:
        return float(os.getenv(nombre, defecto))
    except ValueError:
        return defecto


# Distancia entre el umbral de duda y el automático cuando la config no trae `umbral_duda` (env UMBRAL_AUTO_OFFSET).
UMBRAL_AUTO_OFFSET = _float_env("UMBRAL_AUTO_OFFSET", 0.05)
# Margen mínimo entre el mejor jugador y el segundo mejor jugador DISTINTO para aceptar solo (env MARGEN_MIN).
# Con GhostFaceNet+retinaface el impostor más parecido llegó a 0.336 y el genuino p5 a 0.435 (margen ~0.03-0.1).
MARGEN_MIN = _float_env("MARGEN_MIN", 0.04)
RESULTADOS = ("aceptado", "dudoso", "rechazado")

# ---- Modo SOMBRA (solo mide y registra; NUNCA cambia el veredicto de /verify, que sigue siendo `decidir`).
# Ensemble: SFace (~9 ms en CPU) como segundo modelo sobre el MISMO recorte alineado que usó el modelo principal.
# Al inscribir se guarda además su plantilla (tabla fotos, modelo "SFace"); al verificar solo se calcula en zona gris.
MODELO_SOMBRA = "SFace"
# Holgura sobre el umbral automático bajo la cual un ACEPTADO se considera "justo" (zona gris de la sombra).
HOLGURA_SOMBRA = 0.05
# fusion_score = promedio ponderado de los puntajes normalizados por su umbral de duda (>= 1.0: sobre el umbral).
PESO_FUSION_PRIMARIO = _float_env("PESO_FUSION_PRIMARIO", 0.6)


def fusion(score_primario: float | None, umbral_primario: float, score_sombra: float | None,
           umbral_sombra: float | None = None, peso_primario: float | None = None) -> float | None:
    """Promedio ponderado de score/umbral de cada modelo. None si falta alguno de los dos puntajes."""
    if score_primario is None or score_sombra is None or not umbral_primario:
        return None
    umbral_sombra = umbral_sombra or UMBRAL_POR_MODELO[MODELO_SOMBRA]
    w = PESO_FUSION_PRIMARIO if peso_primario is None else peso_primario
    return w * (score_primario / umbral_primario) + (1 - w) * (score_sombra / umbral_sombra)


def load_config(ruta: Path | None = None) -> dict:
    ruta = Path(ruta) if ruta else CONFIG_PATH
    cfg = dict(DEFAULTS)
    env = {"modelo": os.getenv("FACE_MODEL"), "detector": os.getenv("FACE_DETECTOR"),
           "umbral": os.getenv("MATCH_THRESHOLD"), "umbral_duda": os.getenv("MATCH_THRESHOLD_DUDA")}
    cfg.update({k: v for k, v in env.items() if v})
    if ruta.exists():
        try:
            archivo = json.loads(ruta.read_text(encoding="utf-8"))
            if isinstance(archivo, dict):
                if "umbral" in archivo and "umbral_duda" not in archivo:
                    cfg["umbral_duda"] = None  # formato antiguo: su `umbral` es el de duda
                cfg.update(archivo)
        except (ValueError, OSError):
            pass
    return normalizar_umbrales(cfg)


def normalizar_umbrales(cfg: dict) -> dict:
    """Completa `umbral` (automático) y `umbral_duda` según la regla de compatibilidad. Modifica y retorna cfg."""
    if cfg.get("umbral_duda") is None:
        base = cfg.get("umbral")
        base = UMBRAL_POR_MODELO.get(cfg["modelo"], 0.6) if base is None else float(base)
        cfg["umbral_duda"], cfg["umbral"] = base, base + UMBRAL_AUTO_OFFSET
    elif cfg.get("umbral") is None:
        cfg["umbral"] = float(cfg["umbral_duda"]) + UMBRAL_AUTO_OFFSET
    cfg["umbral"] = round(float(cfg["umbral"]), 3)
    cfg["umbral_duda"] = round(min(float(cfg["umbral_duda"]), cfg["umbral"]), 3)
    return cfg


def decidir(mejor: float | None, segundo: float | None, umbral_auto: float, umbral_duda: float,
            margen_min: float = MARGEN_MIN, par_cercano: bool = False) -> str:
    """'aceptado' | 'dudoso' | 'rechazado'. `segundo`: puntaje del segundo mejor JUGADOR distinto (None si no hay).
    `par_cercano`: el mejor y el segundo candidato son un par de jugadores parecidos entre sí (tabla
    pares_cercanos): solo se acepta solo con holgura (>= umbral_auto + MARGEN_PAR_CERCANO); si no, DUDOSO."""
    if mejor is None or mejor < umbral_duda:
        return "rechazado"
    margen = mejor - segundo if segundo is not None else float("inf")
    if par_cercano and mejor < umbral_auto + MARGEN_PAR_CERCANO - 1e-9:
        return "dudoso"
    if mejor >= umbral_auto and margen >= margen_min - 1e-9:  # tolerancia de redondeo float
        return "aceptado"
    return "dudoso"


config = load_config()


def set_config(modelo: str, detector: str, umbral: float, antispoofing: bool | None = None,
               cfg: dict | None = None, ruta: Path | None = None, umbral_duda: float | None = None) -> dict:
    """Cambia la configuración `cfg` (por defecto la global) en caliente, la persiste en `ruta` y precarga el modelo.
    `umbral` = automático. `umbral_duda` None: conserva el actual si sigue siendo <= umbral; si no, umbral - offset."""
    cfg = config if cfg is None else cfg
    ruta = Path(ruta) if ruta else CONFIG_PATH
    if modelo not in MODELOS:
        raise ValueError(f"Modelo no soportado: {modelo}")
    if detector not in DETECTORES:
        raise ValueError(f"Detector no soportado: {detector}")
    if not 0 < umbral < 1:
        raise ValueError("El umbral debe estar entre 0 y 1.")
    if umbral_duda is None:
        actual = cfg.get("umbral_duda")
        umbral_duda = actual if actual is not None and actual <= umbral else max(0.001, umbral - UMBRAL_AUTO_OFFSET)
    if not 0 < umbral_duda < 1:
        raise ValueError("El umbral de duda debe estar entre 0 y 1.")
    if round(float(umbral_duda), 3) > round(float(umbral), 3):
        raise ValueError("El umbral de duda no puede ser mayor que el umbral automático.")
    if antispoofing is None:
        antispoofing = cfg.get("antispoofing", False)
    nuevo = {"modelo": modelo, "detector": detector, "umbral": round(float(umbral), 3),
             "umbral_duda": round(float(umbral_duda), 3), "antispoofing": bool(antispoofing)}
    DeepFace.build_model(modelo)  # falla antes de guardar si el modelo no carga
    DeepFace.build_model(detector, task="face_detector")
    if nuevo["antispoofing"]:
        DeepFace.build_model("Fasnet", task="spoofing")
    ruta.parent.mkdir(parents=True, exist_ok=True)
    tmp = ruta.with_suffix(".json.tmp")
    try:  # claves que no son del reconocimiento (p. ej. `umbral_faltas` de las alertas) se conservan
        previo = json.loads(ruta.read_text(encoding="utf-8")) if ruta.exists() else {}
        previo = previo if isinstance(previo, dict) else {}
    except (ValueError, OSError):
        previo = {}
    tmp.write_text(json.dumps({**previo, **nuevo}, indent=2), encoding="utf-8")
    tmp.replace(ruta)
    cfg.update(nuevo)  # sin clear(): otra petición concurrente nunca ve la config vacía
    return dict(cfg)


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


# RetinaFace en DeepFace agranda toda foto a ~1024 px y le agrega un borde negro del 50 %: ~2 s por detección en CPU.
# El camino rápido detecta sobre una copia reducida y sin borde, y recorta/alinea sobre la foto original.
LADO_DETECCION_RAPIDA = 640


def _analizar_rapido(img: np.ndarray, miniatura: bool, cfg: dict) -> dict:
    alto, ancho = img.shape[:2]
    k = min(1.0, LADO_DETECCION_RAPIDA / max(alto, ancho))
    chica = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA) if k < 1 else img
    import retinaface.RetinaFace as rf
    modelo_rf = _modeling.build_model(task="face_detector", model_name="retinaface").model
    t0 = time.perf_counter()
    caras = rf.detect_faces(chica, model=modelo_rf, threshold=0.9, allow_upscaling=False)
    ms_deteccion = round((time.perf_counter() - t0) * 1000)
    if not isinstance(caras, dict) or not caras:
        raise FaceNotFoundError("No se detectó ningún rostro en la imagen.")
    c = max(caras.values(), key=lambda o: (o["facial_area"][2] - o["facial_area"][0])
            * (o["facial_area"][3] - o["facial_area"][1]))
    x1, y1, x2, y2 = (v / k for v in c["facial_area"])
    hb, wb = alto // 2, ancho // 2  # mismo borde que usa DeepFace, para la alineación
    pad = cv2.copyMakeBorder(img, hb, hb, wb, wb, cv2.BORDER_CONSTANT, value=[0, 0, 0])

    def punto(p):
        return int(p[0] / k + wb), int(p[1] / k + hb)

    area = FacialAreaRegion(x=int(x1) + wb, y=int(y1) + hb, w=int(x2 - x1), h=int(y2 - y1),
                            left_eye=punto(c["landmarks"]["left_eye"]),
                            right_eye=punto(c["landmarks"]["right_eye"]), confidence=c["score"])
    cara = _deteccion.extract_face(facial_area=area, img=pad, align=True, expand_percentage=0,
                                   width_border=wb, height_border=hb, detector_backend="retinaface")
    if cara.img.shape[0] == 0 or cara.img.shape[1] == 0:
        raise FaceNotFoundError("No se detectó ningún rostro en la imagen.")
    recorte = np.ascontiguousarray(cara.img)
    emb = embedding_recorte(recorte, cfg["modelo"])
    a = cara.facial_area
    resultado = {"embedding": emb, "num_rostros": len(caras),
                 "confianza": float(c["score"]), "tamano_rostro": a.w / ancho, "rapido": True,
                 "ms_deteccion": ms_deteccion, "_recorte": recorte}
    if miniatura:
        resultado["miniatura"] = _miniatura(img, {"x": a.x, "y": a.y, "w": a.w, "h": a.h})
    return resultado


def analyze_face(image_bytes: bytes, miniatura: bool = False, antispoofing: bool = False,
                 rapido: bool = False, cfg: dict | None = None, modelos_extra: tuple[str, ...] = ()) -> dict:
    """
    Detecta el rostro principal (el más grande) y retorna:
    {'embedding', 'num_rostros', 'confianza', 'tamano_rostro'} (+ 'miniatura' JPEG si se pide)
    donde tamano_rostro es la fracción del ancho de la imagen que ocupa la cara.
    Con antispoofing=True lanza SpoofError si la cara parece una foto/pantalla.
    Con rapido=True (solo retinaface, sin antispoofing) usa el camino rápido; ante cualquier problema
    cae al camino de referencia. Úsalo solo para verificar: la inscripción siempre usa el de referencia.
    El resultado lleva 'rapido': True solo si salió del camino rápido (si cayó al de referencia, no hace falta
    repetir el análisis de referencia).
    Siempre lleva '_recorte' (cara alineada, uso interno: nunca se serializa ni se guarda) para que la sombra
    calcule otros modelos sobre el MISMO recorte. `modelos_extra`: modelos adicionales calculados sobre ese
    recorte -> 'embeddings_extra' {modelo: embedding}; un fallo de un modelo extra solo lo omite (nunca rompe).
    """
    cfg = config if cfg is None else cfg
    img = _decode_image(image_bytes)
    resultado = None
    if rapido and cfg["detector"] == "retinaface" and not antispoofing:
        try:
            resultado = _analizar_rapido(img, miniatura, cfg)
        except Exception:  # cualquier fallo: se repite con el camino de referencia
            resultado = None
    if resultado is None:
        resultado = _analizar_referencia(img, miniatura, antispoofing, cfg)
    if modelos_extra:
        resultado["embeddings_extra"] = embeddings_extra(resultado["_recorte"], modelos_extra, cfg["modelo"])
    return resultado


def _analizar_referencia(img: np.ndarray, miniatura: bool, antispoofing: bool, cfg: dict) -> dict:
    """Equivale exactamente a DeepFace.represent(detector, align=True) (mismo extract_faces, misma conversión
    RGB->BGR, mismo resize), pero en dos pasos para conservar el recorte alineado de la cara principal."""
    try:
        faces = _deteccion.extract_faces(img_path=img, detector_backend=cfg["detector"], enforce_detection=True,
                                         align=True, expand_percentage=0, anti_spoofing=antispoofing)
    except SpoofDetected as exc:
        raise SpoofError("La cara parece una foto o una pantalla.") from exc
    except ValueError as exc:
        # DeepFace usa ValueError tanto para "sin rostro" como para errores de configuración;
        # solo el primero debe llegar al usuario como FaceNotFoundError.
        if "could not be detected" in str(exc):
            raise FaceNotFoundError("No se detectó ningún rostro en la imagen.") from exc
        raise RuntimeError(f"Error del motor de reconocimiento: {exc}") from exc
    if antispoofing and any(f.get("is_real", True) is False for f in faces):
        raise SpoofError("La cara parece una foto o una pantalla.")  # igual que represent: basta una cara falsa
    if not faces:
        raise FaceNotFoundError("No se detectó ningún rostro en la imagen.")

    main_face = max(faces, key=lambda f: f["facial_area"]["w"] * f["facial_area"]["h"])
    # extract_faces entrega RGB en [0, 1]; represent lo pasa a BGR antes del modelo: aquí igual.
    recorte = np.ascontiguousarray(main_face["face"][:, :, ::-1])
    try:
        emb = embedding_recorte(recorte, cfg["modelo"])
    except ValueError as exc:
        raise RuntimeError(f"Error del motor de reconocimiento: {exc}") from exc
    resultado = {
        "embedding": emb,
        "num_rostros": len(faces),
        "confianza": float(main_face.get("confidence") or 0.0),
        "tamano_rostro": main_face["facial_area"]["w"] / img.shape[1],
        "_recorte": recorte,
    }
    if miniatura:
        resultado["miniatura"] = _miniatura(img, main_face["facial_area"])
    return resultado


def embedding_recorte(recorte: np.ndarray, modelo: str) -> list[float]:
    """Embedding de una cara YA recortada y alineada (BGR, uint8 o float en [0, 1]), sin detector."""
    emb = DeepFace.represent(img_path=recorte, model_name=modelo, detector_backend="skip",
                             enforce_detection=False, align=False)[0]["embedding"]
    return [float(x) for x in emb]


def embeddings_extra(recorte: np.ndarray | None, modelos: tuple[str, ...], modelo_principal: str) -> dict:
    """{modelo: embedding} de otros modelos sobre el mismo recorte. Omite el principal y los que fallen."""
    salida = {}
    if recorte is None:
        return salida
    for m in modelos:
        if m == modelo_principal or m in salida:
            continue
        try:
            salida[m] = embedding_recorte(recorte, m)
        except Exception:  # la sombra nunca rompe la inscripción ni la verificación
            continue
    return salida


# Cara recortada en el celular (modo sombra de /verify, campo `cara`): JPEG chico ya recortado/alineado.
CARA_CLIENTE_MAX_BYTES = 64 * 1024
CARA_CLIENTE_LADO_MIN = 64
CARA_CLIENTE_LADO_MAX = 320


def embedding_cara_cliente(jpeg: bytes, modelo: str) -> list[float]:
    """Embedding (detector skip, sin retinaface) de la cara que recortó el celular. ValueError si no decodifica."""
    return embedding_recorte(_decode_image(jpeg), modelo)


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
    claves, filas = [], []
    for key, embs in stored_embeddings_dict.items():
        if embs and not isinstance(embs[0], (list, tuple, np.ndarray)):
            embs = [embs]  # un solo embedding
        for emb in embs:
            claves.append(key)
            filas.append(emb)
    if not filas:
        return None, -1.0
    m = np.asarray(filas, dtype=np.float32)
    t = np.asarray(target_embedding, dtype=np.float32)
    normas = np.linalg.norm(m, axis=1) * np.linalg.norm(t)
    puntajes = np.divide(m @ t, normas, out=np.zeros(len(filas), np.float32), where=normas != 0)
    i = int(puntajes.argmax())
    return claves[i], float(puntajes[i])


def warmup(cfg: dict | None = None) -> None:
    """Carga el modelo en memoria para que la primera petición no sea lenta."""
    config = globals()["config"] if cfg is None else cfg
    DeepFace.build_model(config["modelo"])
    DeepFace.build_model(config["detector"], task="face_detector")
    # Una pasada en vacío traza los grafos de TensorFlow: sin esto la primera verificación tarda ~9 s.
    vacia = np.zeros((480, 640, 3), np.uint8)
    DeepFace.represent(img_path=vacia, model_name=config["modelo"], detector_backend="skip",
                       enforce_detection=False)
    try:
        DeepFace.extract_faces(img_path=vacia, detector_backend=config["detector"], enforce_detection=False)
    except Exception:
        pass
    if config["detector"] == "retinaface":
        # El camino rápido de /verify (retinaface sobre <=640 px, sin upscaling) también se precalienta.
        for forma in ((480, 640, 3), (640, 480, 3)):
            try:
                _analizar_rapido(np.zeros(forma, np.uint8), False, config)
            except Exception:
                pass
    if config.get("antispoofing"):
        DeepFace.build_model("Fasnet", task="spoofing")
    if config["modelo"] != MODELO_SOMBRA:
        try:  # modelo sombra (SFace, OpenCV, ~9 ms): que su primera llamada no sume la carga
            embedding_recorte(np.zeros((112, 112, 3), np.uint8), MODELO_SOMBRA)
        except Exception:
            pass
