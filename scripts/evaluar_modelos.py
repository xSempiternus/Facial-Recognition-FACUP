"""
Evalúa combinaciones de modelo + detector con fotos propias y recomienda la mejor.

Estructura esperada (una carpeta por persona, 3+ fotos cada una):
    eval/fotos/sofia/1.jpg
    eval/fotos/sofia/2.jpg
    eval/fotos/mateo/...

Uso (desde la raíz del proyecto, con el venv activado):
    python scripts/evaluar_modelos.py
    python scripts/evaluar_modelos.py --fotos eval/fotos --aumentar
    python scripts/evaluar_modelos.py --modelos Facenet512 ArcFace --detectores opencv retinaface

Protocolo: por cada persona se "inscriben" k fotos y el resto se usa para verificar,
repitiendo con varios sorteos. Para cada foto de verificación se mide:
  - acierto:     el más parecido es la persona correcta y supera el umbral
  - confusión:   el más parecido es OTRA persona y supera el umbral (el error grave)
  - rechazo:     nadie supera el umbral (o no se detectó la cara)
  - desconocido aceptado: si esta persona NO estuviera inscrita, ¿se la aceptaría como otra?
El umbral recomendado es el mínimo que deja en 0 los "desconocidos aceptados" (+ margen).
"""

import argparse
import csv
import gc
import json
import os
import random
import sys
import time
from datetime import datetime
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
UMBRALES = np.round(np.arange(0.20, 0.96, 0.01), 2)
MARGEN_UMBRAL = 0.03
MAX_SCORES_GUARDADOS = 3000


# ---------------------------------------------------------------- alteraciones

def _rotar(img, grados):
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), grados, 1.0)
    return cv2.warpAffine(img, m, (w, h), borderMode=cv2.BORDER_REPLICATE)


def _baja_res(img):
    h, w = img.shape[:2]
    small = cv2.resize(img, (max(w // 5, 1), max(h // 5, 1)), interpolation=cv2.INTER_AREA)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)


def _tapar_boca(img):
    out = img.copy()
    h = out.shape[0]
    out[int(h * 0.62):, :] = (40, 40, 40)
    return out


ALTERACIONES = {
    "oscura": lambda im: cv2.convertScaleAbs(im, alpha=0.45, beta=0),
    "sobreexpuesta": lambda im: cv2.convertScaleAbs(im, alpha=1.3, beta=60),
    "desenfocada": lambda im: cv2.GaussianBlur(im, (11, 11), 0),
    "inclinada": lambda im: _rotar(im, 18),
    "baja_resolucion": _baja_res,
    "boca_tapada": _tapar_boca,
}


# ---------------------------------------------------------------- dataset

def cargar_dataset(carpeta: Path) -> dict[str, list[Path]]:
    personas = {}
    for sub in sorted(p for p in carpeta.iterdir() if p.is_dir()):
        fotos = sorted(f for f in sub.iterdir() if f.suffix.lower() in EXTS)
        if len(fotos) >= 2:
            personas[sub.name] = fotos
        else:
            print(f"  (se omite '{sub.name}': necesita al menos 2 fotos)")
    return personas


def leer_imagen(path: Path):
    # imdecode soporta rutas con tildes/ñ en Windows (cv2.imread no).
    data = np.fromfile(str(path), dtype=np.uint8)
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


# ---------------------------------------------------------------- deepface

def liberar_modelos():
    from deepface.modules import modeling
    cache = getattr(modeling, "cached_models", None)
    if cache:
        for tarea in cache.values():
            tarea.clear()
    try:
        import tensorflow as tf
        tf.keras.backend.clear_session()
    except Exception:
        pass
    gc.collect()


def detectar(img, detector):
    """Retorna la cara principal alineada (BGR uint8) o None si no hay cara."""
    from deepface import DeepFace
    try:
        caras = DeepFace.extract_faces(
            img, detector_backend=detector, enforce_detection=True, align=True,
            color_face="bgr", normalize_face=False,
        )
    except ValueError as exc:
        if "could not be detected" in str(exc):
            return None
        raise
    if not caras:
        return None
    cara = max(caras, key=lambda c: c["facial_area"]["w"] * c["facial_area"]["h"])
    return np.ascontiguousarray(cara["face"]).astype(np.uint8)


def embedding(cara, modelo):
    from deepface import DeepFace
    rep = DeepFace.represent(cara, model_name=modelo, detector_backend="skip")
    v = np.asarray(rep[0]["embedding"], dtype=np.float32)
    n = np.linalg.norm(v)
    return v / n if n else v


# ---------------------------------------------------------------- métricas

def evaluar_eventos(eventos, umbral):
    """eventos: lista de (score_propio, mejor_score_otro, tiene_cara). Retorna tasas."""
    n = len(eventos)
    acierto = confusion = rechazo = desconocido = 0
    for propio, otro, ok in eventos:
        if not ok:
            rechazo += 1
            continue
        top = max(propio, otro)
        if top <= umbral:
            rechazo += 1
        elif propio >= otro:
            acierto += 1
        else:
            confusion += 1
        if otro > umbral:
            desconocido += 1
    return {
        "acierto": acierto / n, "confusion": confusion / n,
        "rechazo": rechazo / n, "desconocido_aceptado": desconocido / n,
    }


def resumir_config(eventos, eventos_por_alteracion):
    con_cara = [e for e in eventos if e[2]]
    genuinos = np.array([e[0] for e in con_cara]) if con_cara else np.array([0.0])
    impostores = np.array([e[1] for e in con_cara]) if con_cara else np.array([1.0])

    imp_max = float(impostores.max())
    umbral = float(min(round(imp_max + MARGEN_UMBRAL, 2), 0.95))
    m = evaluar_eventos(eventos, umbral)
    curva = [{"umbral": float(t), **evaluar_eventos(eventos, t)} for t in UMBRALES]

    def muestra(arr):
        arr = arr.tolist()
        if len(arr) > MAX_SCORES_GUARDADOS:
            arr = random.Random(0).sample(arr, MAX_SCORES_GUARDADOS)
        return [round(float(x), 4) for x in arr]

    return {
        "umbral_recomendado": umbral,
        **{k: round(v, 4) for k, v in m.items()},
        "sin_rostro": round(1 - len(con_cara) / len(eventos), 4),
        "margen": round(float(np.percentile(genuinos, 5)) - imp_max, 4),
        "genuino_p5": round(float(np.percentile(genuinos, 5)), 4),
        "genuino_mediana": round(float(np.median(genuinos)), 4),
        "impostor_max": round(imp_max, 4),
        "impostor_mediana": round(float(np.median(impostores)), 4),
        "verificaciones": len(eventos),
        "curva": curva,
        "scores_genuinos": muestra(genuinos),
        "scores_impostores": muestra(impostores),
        "por_alteracion": {
            alt: round(evaluar_eventos(evs, umbral)["acierto"], 4)
            for alt, evs in eventos_por_alteracion.items()
        },
    }


# ---------------------------------------------------------------- principal

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fotos", default=str(ROOT / "eval" / "fotos"))
    ap.add_argument("--salida", default=str(ROOT / "eval" / "resultados"))
    ap.add_argument("--modelos", nargs="+", default=["Facenet512", "ArcFace", "SFace", "GhostFaceNet"])
    ap.add_argument("--detectores", nargs="+", default=["opencv", "yunet", "retinaface"])
    ap.add_argument("--inscripcion", nargs="+", type=int, default=[1, 3],
                    help="Cantidad de fotos de inscripción por persona a probar.")
    ap.add_argument("--sorteos", type=int, default=5, help="Repeticiones con distinto reparto de fotos.")
    ap.add_argument("--aumentar", action="store_true",
                    help="Agrega versiones alteradas (oscura, borrosa, inclinada...) de las fotos de verificación.")
    args = ap.parse_args()

    carpeta = Path(args.fotos)
    if not carpeta.is_dir():
        sys.exit(f"No existe la carpeta {carpeta}. Crea una subcarpeta por persona con sus fotos.")
    personas = cargar_dataset(carpeta)
    if len(personas) < 2:
        sys.exit("Se necesitan al menos 2 personas con 2+ fotos cada una.")
    total_fotos = sum(len(v) for v in personas.values())
    print(f"\nDataset: {len(personas)} personas, {total_fotos} fotos"
          + (f" (+{len(ALTERACIONES)} alteraciones por foto)" if args.aumentar else ""))

    # Imágenes: (persona, índice, alteración) -> imagen BGR
    imagenes = {}
    for nombre, fotos in personas.items():
        for i, f in enumerate(fotos):
            img = leer_imagen(f)
            if img is None:
                print(f"  (no se pudo leer {f})")
                continue
            imagenes[(nombre, i, "original")] = img
            if args.aumentar:
                for alt, fn in ALTERACIONES.items():
                    imagenes[(nombre, i, alt)] = fn(img)

    configs = []
    for detector in args.detectores:
        print(f"\n▶ Detector: {detector}")
        caras, t0 = {}, time.perf_counter()
        try:
            for clave, img in imagenes.items():
                caras[clave] = detectar(img, detector)
        except Exception as exc:
            print(f"  ✗ El detector '{detector}' falló: {exc}")
            liberar_modelos()
            continue
        ms_det = (time.perf_counter() - t0) * 1000 / len(imagenes)
        sin_cara = sum(1 for c in caras.values() if c is None)
        print(f"  {ms_det:.0f} ms/foto · sin cara detectada: {sin_cara}/{len(caras)}")

        for modelo in args.modelos:
            embs, t0 = {}, time.perf_counter()
            try:
                for clave, cara in caras.items():
                    embs[clave] = None if cara is None else embedding(cara, modelo)
            except Exception as exc:
                print(f"  ✗ Modelo {modelo} falló: {exc}")
                liberar_modelos()
                continue
            n_ok = sum(1 for e in embs.values() if e is not None) or 1
            ms_emb = (time.perf_counter() - t0) * 1000 / n_ok

            for k in args.inscripcion:
                elegibles = [p for p, f in personas.items() if len(f) > k]
                if len(elegibles) < 2:
                    print(f"  (se omite inscripción con {k} fotos: pocas personas con {k + 1}+ fotos)")
                    continue
                eventos, por_alt = [], {}
                for s in range(args.sorteos):
                    rng = random.Random(s)
                    galeria, pruebas = {}, []
                    for p in elegibles:
                        idx = list(range(len(personas[p])))
                        rng.shuffle(idx)
                        plantillas = [embs.get((p, i, "original")) for i in idx[:k]]
                        galeria[p] = [e for e in plantillas if e is not None]
                        pruebas += [(p, i) for i in idx[k:]]

                    for p, i in pruebas:
                        for alt in ["original"] + (list(ALTERACIONES) if args.aumentar else []):
                            e = embs.get((p, i, alt))
                            if e is None:
                                ev = (0.0, 0.0, False)
                            else:
                                sims = {q: max((float(e @ t) for t in ts), default=-1.0)
                                        for q, ts in galeria.items()}
                                propio = sims.pop(p)
                                ev = (propio, max(sims.values()), True)
                            eventos.append(ev)
                            por_alt.setdefault(alt, []).append(ev)

                r = resumir_config(eventos, por_alt)
                r.update({"modelo": modelo, "detector": detector, "fotos_inscripcion": k,
                          "ms_deteccion": round(ms_det, 1), "ms_embedding": round(ms_emb, 1)})
                configs.append(r)
                print(f"  {modelo:<13} k={k}  umbral={r['umbral_recomendado']:.2f}  "
                      f"acierto={r['acierto']:.0%}  confusión={r['confusion']:.0%}  "
                      f"rechazo={r['rechazo']:.0%}  margen={r['margen']:+.2f}")
            liberar_modelos()

    if not configs:
        sys.exit("No se pudo evaluar ninguna configuración.")

    # Ranking: más aciertos, luego menos confusiones, más margen y más rápido.
    configs.sort(key=lambda c: (-c["acierto"], c["confusion"], -c["margen"],
                                c["ms_deteccion"] + c["ms_embedding"]))
    mejor = configs[0]

    salida = Path(args.salida)
    salida.mkdir(parents=True, exist_ok=True)
    resultado = {
        "generado": datetime.now().isoformat(timespec="seconds"),
        "dataset": {"carpeta": str(carpeta), "personas": len(personas), "fotos": total_fotos,
                    "aumentado": args.aumentar},
        "recomendacion": {k: mejor[k] for k in ("modelo", "detector", "fotos_inscripcion",
                                                 "umbral_recomendado", "acierto", "confusion",
                                                 "rechazo", "margen")},
        "configs": configs,
    }
    (salida / "resultados.json").write_text(json.dumps(resultado, ensure_ascii=False, indent=1),
                                           encoding="utf-8")
    campos = ["modelo", "detector", "fotos_inscripcion", "umbral_recomendado", "acierto",
              "confusion", "rechazo", "sin_rostro", "desconocido_aceptado", "margen",
              "genuino_p5", "impostor_max", "ms_deteccion", "ms_embedding", "verificaciones"]
    with open(salida / "resumen.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=campos, extrasaction="ignore")
        w.writeheader()
        w.writerows(configs)

    print("\n" + "=" * 72)
    print("RANKING (top 5)")
    for i, c in enumerate(configs[:5], 1):
        print(f" {i}. {c['modelo']} + {c['detector']} (k={c['fotos_inscripcion']}): "
              f"acierto {c['acierto']:.0%}, confusión {c['confusion']:.0%}, "
              f"umbral {c['umbral_recomendado']:.2f}, "
              f"{c['ms_deteccion'] + c['ms_embedding']:.0f} ms/foto")
    print(f"\n✅ Recomendado: {mejor['modelo']} + {mejor['detector']}, umbral {mejor['umbral_recomendado']:.2f}")
    print(f"Resultados en {salida}  (ábrelos en la UI → Staff → Evaluación)")
    print("=" * 72)


def _escribir_estado(salida: Path, **datos):
    """Estado para la UI (Staff → Evaluación): en_curso | listo | error."""
    salida.mkdir(parents=True, exist_ok=True)
    datos["actualizado"] = datetime.now().isoformat(timespec="seconds")
    (salida / "estado.json").write_text(json.dumps(datos, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    _salida = Path(next((sys.argv[i + 1] for i, a in enumerate(sys.argv[:-1]) if a == "--salida"),
                        ROOT / "eval" / "resultados"))
    if any(a in ("-h", "--help") for a in sys.argv):
        main()
    _escribir_estado(_salida, estado="en_curso")
    try:
        main()
        _escribir_estado(_salida, estado="listo")
    except SystemExit as exc:
        if exc.code not in (None, 0):
            _escribir_estado(_salida, estado="error", mensaje=str(exc.code))
        else:
            _escribir_estado(_salida, estado="listo")
        raise
    except BaseException as exc:
        _escribir_estado(_salida, estado="error", mensaje=f"{type(exc).__name__}: {exc}")
        raise
