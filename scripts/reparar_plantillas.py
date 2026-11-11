"""Revisa (y opcionalmente repara) las plantillas aprendidas por corrección del staff de una sede.

Por defecto es DRY-RUN (solo lee la base, en modo de solo lectura): lista las plantillas por jugador y origen,
marca las 'correccion' dudosas y muestra la similitud entre jugadores (fotos de inscripción).

Una plantilla 'correccion' es DUDOSA si (ver src/plantillas.correccion_dudosa):
  - puntúa < umbral_duda contra las fotos BASE (inscripcion / nueva_foto) de su propio jugador, o
  - se parece más (o igual) a las fotos BASE de otro jugador que a las de su jugador.
Además se informa si hoy pasaría la regla nueva de aprendizaje (src/plantillas.evaluar_aprendizaje).

Con --aplicar:
  1. copia de seguridad de la base (carpeta respaldos/ de la sede, con sello de tiempo, API de backup de SQLite);
  2. borra SOLO las plantillas 'correccion' dudosas (nunca inscripcion ni nueva_foto);
  3. registra en pares_cercanos los pares de jugadores con similitud BASE >= umbral_duda - 0.07 (0.30 hoy): para
     ellos el kiosko pedirá confirmación (DUDOSO) salvo con holgura.
La API en ejecución NO se entera: mantiene las plantillas y los pares en memoria hasta que se reinicie. Reinicia
la API después de --aplicar (los cambios no se pierden; solo se cargan al arrancar).

Uso (desde la raíz del repo, con el venv):
    .\\.venv\\Scripts\\python.exe scripts\\reparar_plantillas.py --sede las-condes
    .\\.venv\\Scripts\\python.exe scripts\\reparar_plantillas.py --sede las-condes --jugador 1
    .\\.venv\\Scripts\\python.exe scripts\\reparar_plantillas.py --sede las-condes --aplicar
Respeta DATA_DIR (por defecto <repo>/data).
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src import sedes  # noqa: E402
from src import plantillas as pl  # noqa: E402

UMBRAL_INFORME = 0.20  # pares de jugadores que se listan en el informe de similitud


def leer_config(ruta: Path) -> tuple[str, float]:
    """(modelo, umbral_duda) con la misma regla de compatibilidad que src/cv_engine (sin cargar DeepFace)."""
    cfg = {}
    if ruta.exists():
        try:
            cfg = json.loads(ruta.read_text(encoding="utf-8"))
        except ValueError:
            cfg = {}
    modelo = cfg.get("modelo") or "Facenet512"
    duda = cfg.get("umbral_duda")
    if duda is None:
        duda = cfg.get("umbral")  # formato antiguo: su `umbral` es el de duda
    if duda is None:
        from src import cv_engine  # solo si hace falta el umbral por defecto del modelo (carga DeepFace)
        duda = cv_engine.load_config(ruta)["umbral_duda"]
    return modelo, float(duda)


def leer(ruta_db: Path, modelo: str) -> tuple[dict[int, str], list[dict]]:
    """Lectura en modo SOLO LECTURA: {id: nombre} de activos y las fotos del modelo."""
    conn = sqlite3.connect(f"file:{ruta_db.as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        nombres = {r["id"]: r["nombre"] for r in conn.execute(
            "SELECT id, nombre FROM jugadores WHERE coalesce(estado, 'activo') = 'activo'")}
        fotos = [{**dict(r), "embedding": json.loads(r["embedding"])} for r in conn.execute(
            "SELECT id, jugador_id, origen, creado_en, embedding FROM fotos WHERE modelo = ? ORDER BY jugador_id, id",
            (modelo,)) if r["jugador_id"] in nombres]
    finally:
        conn.close()
    return nombres, fotos


def analizar(nombres: dict[int, str], fotos: list[dict], umbral_duda: float, jugador: int | None,
             margen_min: float = 0.04) -> dict:
    """Informe completo (sin efectos). Retorna {"por_jugador", "dudosas": [ids], "pares": [...], "lineas": [...]}."""
    por_jugador: dict[int, list] = {}
    for f in fotos:
        p = pl.Plantilla("m", f["embedding"], f["origen"])
        p.id, p.creado_en = f["id"], f["creado_en"]
        por_jugador.setdefault(f["jugador_id"], []).append(p)
    nom = lambda j: f"{nombres.get(j, '?')} (#{j})"  # noqa: E731
    L: list[str] = []
    L.append(f"umbral_duda={umbral_duda}  par cercano >= {pl.umbral_par_cercano(umbral_duda)}  "
             f"tope aprendidas={pl.MAX_APRENDIDAS}  peso aprendidas=x{pl.PESO_APRENDIDA}")
    L.append("\n== Plantillas por jugador")
    for jid in sorted(por_jugador):
        if jugador is not None and jid != jugador:
            continue
        cuenta: dict[str, int] = {}
        for p in por_jugador[jid]:
            cuenta[pl.origen_de(p)] = cuenta.get(pl.origen_de(p), 0) + 1
        apr = sum(v for k, v in cuenta.items() if k in pl.ORIGENES_APRENDIDOS)
        extra = f"  <- {apr} aprendidas (tope {pl.MAX_APRENDIDAS})" if apr > pl.MAX_APRENDIDAS else ""
        L.append(f"  {nom(jid)}: " + ", ".join(f"{k}={v}" for k, v in sorted(cuenta.items())) + extra)

    L.append("\n== Plantillas 'correccion' (dudosa = < umbral_duda contra su jugador o más parecida a otro)")
    dudosas = []
    for jid in sorted(por_jugador):
        if jugador is not None and jid != jugador:
            continue
        for p in por_jugador[jid]:
            if not pl.es_aprendida(p):
                continue
            dudosa, det = pl.correccion_dudosa(p, jid, por_jugador, umbral_duda)
            sin_ella = {k: [q for q in v if q is not p] for k, v in por_jugador.items()}
            ok, motivo, _ = pl.evaluar_aprendizaje(p[1], jid, sin_ella, umbral_duda, margen_min)
            if dudosa:
                dudosas.append(p.id)
            otro = f"{nom(det['otro_id'])} {det['vs_otro']}" if det["otro_id"] is not None else "-"
            L.append(f"  foto {p.id} de {nom(jid)} ({p.creado_en}): vs propia={det['vs_propia']}  mejor otro={otro}"
                     f"  regla nueva={'pasa' if ok else motivo}  -> {'DUDOSA (borrar)' if dudosa else 'se conserva'}")
    if not dudosas and not any(pl.es_aprendida(p) for ps in por_jugador.values() for p in ps):
        L.append("  (no hay plantillas aprendidas)")

    L.append(f"\n== Similitud entre jugadores (fotos BASE, >= {UMBRAL_INFORME})")
    umbral_par = pl.umbral_par_cercano(umbral_duda)
    pares = []
    ids = sorted(por_jugador)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            s = pl.similitud_entre(por_jugador[a], por_jugador[b])
            if s is not None and s >= UMBRAL_INFORME and (jugador is None or jugador in (a, b)):
                pares.append((a, b, s))
    for a, b, s in sorted(pares, key=lambda x: x[2], reverse=True):
        L.append(f"  {nom(a)} - {nom(b)}: {s:.3f}" + ("  <- PAR CERCANO" if s >= umbral_par else ""))
    if not pares:
        L.append("  (ninguno)")
    return {"por_jugador": por_jugador, "dudosas": dudosas,
            "pares_cercanos": [(a, b, s) for a, b, s in pares if s >= umbral_par], "lineas": L}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Revisa/repara las plantillas aprendidas por corrección de una sede.")
    ap.add_argument("--sede", required=True, help="slug de la sede, p. ej. las-condes")
    ap.add_argument("--aplicar", action="store_true", help="respalda la base y borra las 'correccion' dudosas")
    ap.add_argument("--jugador", type=int, help="limita el informe (y lo que se borra) a un jugador")
    a = ap.parse_args(argv)
    try:
        carpeta = sedes.carpeta(a.sede)
    except sedes.SedeNoExiste:
        print(f"Slug inválido: {a.sede}")
        return 2
    ruta_db = carpeta / "asistencia.db"
    if not ruta_db.exists():
        print(f"No existe la base de la sede: {ruta_db}")
        return 2
    modelo, duda = leer_config(carpeta / "config.json")
    nombres, fotos = leer(ruta_db, modelo)
    print(f"Sede {a.sede} ({ruta_db}) modelo={modelo}  {'APLICAR' if a.aplicar else 'DRY-RUN (no cambia nada)'}")
    r = analizar(nombres, fotos, duda, a.jugador)
    print("\n".join(r["lineas"]))
    print(f"\nPlantillas 'correccion' dudosas: {len(r['dudosas'])} {r['dudosas']}")
    if not a.aplicar:
        print("Dry-run: no se cambió nada. Agrega --aplicar para respaldar y borrar las dudosas.")
        return 0

    from src import db_manager  # noqa: E402  (solo al aplicar: abre la base en escritura)
    base = db_manager.Base(ruta_db)
    base.init_db()  # crea pares_cercanos si la base es anterior
    respaldo = base.crear_respaldo("reparar_plantillas")
    print(f"Respaldo: {respaldo}")
    borradas = base.borrar_fotos_aprendidas(r["dudosas"])
    for x, y, s in r["pares_cercanos"]:
        base.registrar_par_cercano(x, y, s)
    base.auditar("reparar_plantillas", f"{borradas} plantillas 'correccion' borradas; "
                                       f"{len(r['pares_cercanos'])} pares cercanos registrados")
    print(f"Borradas: {borradas}. Pares cercanos registrados: {len(r['pares_cercanos'])}.")
    print("IMPORTANTE: reinicia la API para que cargue las plantillas y los pares nuevos (la caché vive en memoria).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
