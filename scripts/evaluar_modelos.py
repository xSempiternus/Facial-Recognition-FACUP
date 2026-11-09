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

Modo --fusion (ensemble, mismo protocolo y mismos sorteos): evalúa cada modelo solo y su fusión
GhostFaceNet+SFace (y +ArcFace con --con-arcface) sobre el MISMO recorte alineado. Puntaje fusionado por persona =
promedio ponderado de (similitud / umbral de duda del modelo) -> escala ~1.0 = en el umbral. Escribe
fusion.json y fusion.csv en --salida (no toca resultados.json ni el estado de la UI).
    python scripts/evaluar_modelos.py --fusion
    python scripts/evaluar_modelos.py --fusion --con-arcface --detectores retinaface --pesos 0.6 0.4
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
# --fusion: modelos del ensemble (el primero es el principal) y rejilla de umbrales en escala "score / umbral".
FUSION_MODELOS = ("GhostFaceNet", "SFace")
UMBRALES_FUSION = np.round(np.arange(0.50, 2.01, 0.01), 2)


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


def resumir_config(eventos, eventos_por_alteracion, umbrales=UMBRALES, tope=0.95, margen=MARGEN_UMBRAL):
    con_cara = [e for e in eventos if e[2]]
    genuinos = np.array([e[0] for e in con_cara]) if con_cara else np.array([0.0])
    impostores = np.array([e[1] for e in con_cara]) if con_cara else np.array([1.0])

    imp_max = float(impostores.max())
    umbral = float(min(round(imp_max + margen, 2), tope))
    m = evaluar_eventos(eventos, umbral)
    curva = [{"umbral": float(t), **evaluar_eventos(eventos, t)} for t in umbrales]

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
    ap.add_argument("--detectores", nargs="+", default=None,
                    help="Por defecto: opencv yunet retinaface (con --fusion: retinaface, el de producción).")
    ap.add_argument("--inscripcion", nargs="+", type=int, default=[1, 3],
                    help="Cantidad de fotos de inscripción por persona a probar.")
    ap.add_argument("--sorteos", type=int, default=5, help="Repeticiones con distinto reparto de fotos.")
    ap.add_argument("--aumentar", action="store_true",
                    help="Agrega versiones alteradas (oscura, borrosa, inclinada...) de las fotos de verificación.")
    ap.add_argument("--fusion", action="store_true",
                    help="Evalúa el ensemble GhostFaceNet+SFace (ver arriba) en vez del barrido de modelos.")
    ap.add_argument("--fusion-modelos", nargs="+", default=list(FUSION_MODELOS),
                    help="Modelos del ensemble; el primero es el principal (por defecto GhostFaceNet SFace).")
    ap.add_argument("--con-arcface", action="store_true", help="Con --fusion: agrega ArcFace como tercer modelo.")
    ap.add_argument("--pesos", nargs="+", type=float, default=None,
                    help="Con --fusion: pesos de cada modelo (por defecto 0.6 el principal y el resto a partes iguales).")
    args = ap.parse_args()
    if args.detectores is None:
        args.detectores = ["retinaface"] if args.fusion else ["opencv", "yunet", "retinaface"]

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
    if not imagenes:
        sys.exit("No se pudo leer ninguna foto.")
    if args.fusion:
        return evaluar_fusion(args, personas, imagenes, carpeta, total_fotos)

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


def evaluar_fusion(args, personas, imagenes, carpeta, total_fotos):
    """Mismo protocolo (k fotos inscritas, resto verifica, varios sorteos) para cada modelo solo y para las fusiones.
    Todas las configuraciones usan los mismos recortes y los mismos sorteos: las diferencias son solo del modelo."""
    sys.path.insert(0, str(ROOT))
    from src.cv_engine import PESO_FUSION_PRIMARIO, UMBRAL_POR_MODELO

    modelos = list(dict.fromkeys(args.fusion_modelos + (["ArcFace"] if args.con_arcface else [])))
    if len(modelos) < 2:
        sys.exit("--fusion necesita al menos 2 modelos.")
    faltan = [m for m in modelos if m not in UMBRAL_POR_MODELO]
    if faltan:
        sys.exit(f"Modelos sin umbral conocido: {', '.join(faltan)}")
    principal = modelos[0]
    combos = [[m] for m in modelos] + [[principal, m] for m in modelos[1:]]
    if len(modelos) > 2:
        combos.append(modelos)

    def pesos_de(combo):
        if args.pesos:
            if len(args.pesos) != len(modelos):
                sys.exit(f"--pesos necesita {len(modelos)} valores (uno por modelo: {' '.join(modelos)}).")
            w = [args.pesos[modelos.index(m)] for m in combo]
        elif len(combo) == 1:
            w = [1.0]
        else:
            resto = (1 - PESO_FUSION_PRIMARIO) / (len(combo) - 1)
            w = [PESO_FUSION_PRIMARIO if m == principal else resto for m in combo]
        tot = sum(w) or 1.0
        return [x / tot for x in w]

    alteraciones = ["original"] + (list(ALTERACIONES) if args.aumentar else [])
    configs = []
    for detector in args.detectores:
        print(f"\n▶ Detector: {detector}")
        try:
            caras = {clave: detectar(img, detector) for clave, img in imagenes.items()}
        except Exception as exc:
            print(f"  ✗ El detector '{detector}' falló: {exc}")
            liberar_modelos()
            continue
        print(f"  sin cara detectada: {sum(1 for c in caras.values() if c is None)}/{len(caras)}")
        embs, ms_emb = {}, {}
        for m in modelos:
            t0 = time.perf_counter()
            try:
                embs[m] = {clave: None if cara is None else embedding(cara, m) for clave, cara in caras.items()}
            except Exception as exc:
                sys.exit(f"  ✗ Modelo {m} falló: {exc}")
            ms_emb[m] = (time.perf_counter() - t0) * 1000 / max(1, sum(1 for c in caras.values() if c is not None))

        for k in args.inscripcion:
            elegibles = [p for p, f in personas.items() if len(f) > k]
            if len(elegibles) < 2:
                print(f"  (se omite inscripción con {k} fotos: pocas personas con {k + 1}+ fotos)")
                continue
            eventos = {tuple(c): [] for c in combos}
            por_alt = {tuple(c): {} for c in combos}
            acuerdo = {"acuerdan": 0, "acierto_si_acuerdan": 0, "discrepan": 0, "acierto_si_discrepan": 0}
            for s in range(args.sorteos):
                rng = random.Random(s)
                galeria, pruebas = {}, []
                for p in elegibles:
                    idx = list(range(len(personas[p])))
                    rng.shuffle(idx)
                    galeria[p] = idx[:k]
                    pruebas += [(p, i) for i in idx[k:]]
                for p, i in pruebas:
                    for alt in alteraciones:
                        sims = {}  # modelo -> {persona: mejor similitud}
                        for m in modelos:
                            e = embs[m].get((p, i, alt))
                            if e is None:
                                sims = None
                                break
                            sims[m] = {q: max((float(e @ t) for t in (embs[m].get((q, j, "original")) for j in idxs)
                                               if t is not None), default=-1.0)
                                       for q, idxs in galeria.items()}
                        if sims is not None and len(modelos) > 1:
                            top = [max(sims[m], key=sims[m].get) for m in (principal, modelos[1])]
                            clave = "acuerdan" if top[0] == top[1] else "discrepan"
                            acuerdo[clave] += 1
                            acuerdo[f"acierto_si_{clave}"] += int(top[0] == p)
                        for c in combos:
                            if sims is None:
                                ev = (0.0, 0.0, False)
                            else:
                                w = pesos_de(c)
                                if len(c) == 1:  # modelo solo: similitud cruda (comparable con el barrido normal)
                                    fus = dict(sims[c[0]])
                                else:
                                    fus = {q: sum(wi * sims[m][q] / UMBRAL_POR_MODELO[m] for wi, m in zip(w, c))
                                           for q in galeria}
                                propio = fus.pop(p)
                                ev = (propio, max(fus.values()), True)
                            eventos[tuple(c)].append(ev)
                            por_alt[tuple(c)].setdefault(alt, []).append(ev)
            for c in combos:
                fusion = len(c) > 1
                r = resumir_config(eventos[tuple(c)], por_alt[tuple(c)],
                                   umbrales=UMBRALES_FUSION if fusion else UMBRALES, tope=2.0 if fusion else 0.95,
                                   margen=MARGEN_UMBRAL / min(UMBRAL_POR_MODELO[m] for m in c) if fusion else MARGEN_UMBRAL)
                r.update({"modelo": "+".join(c), "detector": detector, "fotos_inscripcion": k,
                          "pesos": [round(x, 3) for x in pesos_de(c)], "escala": "score/umbral" if fusion else "coseno",
                          "ms_embedding": round(sum(ms_emb[m] for m in c), 1)})
                configs.append(r)
                print(f"  {r['modelo']:<28} k={k}  umbral={r['umbral_recomendado']:.2f}  acierto={r['acierto']:.0%}  "
                      f"confusión={r['confusion']:.0%}  desc.aceptado={r['desconocido_aceptado']:.0%}  "
                      f"margen={r['margen']:+.2f}")
            n_ac = acuerdo["acuerdan"]
            n_di = acuerdo["discrepan"]
            print(f"  top-1 {principal} vs {modelos[1]}: acuerdan {n_ac}, discrepan {n_di}; acierto del principal "
                  f"cuando acuerdan {acuerdo['acierto_si_acuerdan'] / n_ac if n_ac else 0:.0%}, "
                  f"cuando discrepan {acuerdo['acierto_si_discrepan'] / n_di if n_di else 0:.0%}")
            configs[len(configs) - len(combos) + len(modelos)]["acuerdo_top1"] = acuerdo  # la config principal+2.º
        liberar_modelos()

    if not configs:
        sys.exit("No se pudo evaluar ninguna configuración.")
    salida = Path(args.salida)
    salida.mkdir(parents=True, exist_ok=True)
    resultado = {
        "generado": datetime.now().isoformat(timespec="seconds"),
        "dataset": {"carpeta": str(carpeta), "personas": len(personas), "fotos": total_fotos, "aumentado": args.aumentar},
        "modelos": modelos, "umbrales_duda": {m: UMBRAL_POR_MODELO[m] for m in modelos},
        "nota": "fusión = sum(peso * similitud / umbral_duda); el umbral recomendado de la fusión está en esa escala",
        "configs": configs,
    }
    (salida / "fusion.json").write_text(json.dumps(resultado, ensure_ascii=False, indent=1), encoding="utf-8")
    campos = ["modelo", "detector", "fotos_inscripcion", "pesos", "escala", "umbral_recomendado", "acierto",
              "confusion", "rechazo", "sin_rostro", "desconocido_aceptado", "margen", "genuino_p5", "impostor_max",
              "ms_embedding", "verificaciones"]
    with open(salida / "fusion.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=campos, extrasaction="ignore")
        w.writeheader()
        w.writerows(configs)
    print(f"\nResultados del ensemble en {salida / 'fusion.json'} y fusion.csv")


def _escribir_estado(salida: Path, **datos):
    """Estado para la UI (Staff → Evaluación): en_curso | listo | error."""
    salida.mkdir(parents=True, exist_ok=True)
    datos["actualizado"] = datetime.now().isoformat(timespec="seconds")
    (salida / "estado.json").write_text(json.dumps(datos, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    _salida = Path(next((sys.argv[i + 1] for i, a in enumerate(sys.argv[:-1]) if a == "--salida"),
                        ROOT / "eval" / "resultados"))
    if any(a in ("-h", "--help", "--fusion") for a in sys.argv):
        raise SystemExit(main())  # --fusion no toca el estado de la UI (Staff -> Evaluación)
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
