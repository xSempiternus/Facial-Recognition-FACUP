 """API FastAPI: enrolamiento y verificación facial de jugadores."""

import asyncio
import base64
import itertools
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from src import cv_engine, db_manager, reportes

# Por debajo de esta fracción del ancho de la imagen, la cara se considera muy lejana.
MIN_FACE_SIZE = 0.15
MAX_FOTOS_INSCRIPCION = 5
# Tolerancia al comparar entre sí las fotos de una misma inscripción (los ángulos laterales se parecen menos).
TOLERANCIA_INSCRIPCION = 0.10
# Una corrección del staff solo se guarda como foto del jugador si se parece al menos
# (umbral - MARGEN_CORRECCION) a sus fotos actuales: protege contra asignaciones equivocadas.
MARGEN_CORRECCION = 0.25
# Llegadas no reconocidas que esperan revisión del staff: solo en memoria, se borran solas.
PENDIENTES_TTL_S = 2 * 3600
MAX_PENDIENTES = 50
# Exigir la autorización firmada del tutor para inscribir (datos biométricos de menores).
REQUIERE_CONSENTIMIENTO = os.getenv("REQUIRE_CONSENT", "1") != "0"
# Cada cuánto se revisa si ya existe el respaldo automático del día.
INTERVALO_RESPALDO_S = 3600

# Cache en memoria: {jugador_id: {"nombre", "categoria", "plantillas": [(modelo, embedding), ...]}}
_jugadores_cache: dict[int, dict] = {}
# {pendiente_id: {"t", "timestamp", "embedding", "modelo", "miniatura", "sugerido_id", "similitud"}}
_pendientes: dict[int, dict] = {}
_pendiente_ids = itertools.count(1)


def _threshold() -> float:
    return cv_engine.config["umbral"]


def _reload_cache() -> None:
    _jugadores_cache.clear()
    for j in db_manager.get_all_jugadores():
        _jugadores_cache[j["id"]] = {"nombre": j["nombre"], "categoria": j["categoria"],
                                     "plantillas": j["plantillas"]}


def _plantillas_actuales() -> dict[int, list]:
    """{jugador_id: [embeddings del modelo actual]}; solo jugadores con al menos una foto comparable."""
    modelo = cv_engine.config["modelo"]
    salida = {}
    for jid, d in _jugadores_cache.items():
        embs = [e for m, e in d["plantillas"] if m == modelo]
        if embs:
            salida[jid] = embs
    return salida


def _agregar_plantilla(jugador_id: int, embedding: list[float], origen: str) -> None:
    modelo = cv_engine.config["modelo"]
    db_manager.add_foto(jugador_id, embedding, modelo, origen)
    plantillas = _jugadores_cache[jugador_id]["plantillas"]
    plantillas.append((modelo, embedding))
    # Si se superó el límite, la BD descartó alguna foto: se relee para que la cache coincida.
    if sum(1 for m, _ in plantillas if m == modelo) > db_manager.MAX_FOTOS:
        _jugadores_cache[jugador_id]["plantillas"] = next(
            j["plantillas"] for j in db_manager.get_all_jugadores() if j["id"] == jugador_id)


def _error(status: int, codigo: str, mensaje: str, **extra):
    """Errores con código legible por la UI: {"detail": {"codigo", "mensaje", ...}}."""
    raise HTTPException(status_code=status, detail={"codigo": codigo, "mensaje": mensaje, **extra})


def _best_match(embedding: list[float]):
    return cv_engine.find_match(embedding, _plantillas_actuales(), threshold=_threshold())


def _purgar_pendientes() -> None:
    limite = time.time() - PENDIENTES_TTL_S
    for pid in [p for p, d in _pendientes.items() if d["t"] < limite]:
        del _pendientes[pid]
    while len(_pendientes) > MAX_PENDIENTES:
        del _pendientes[min(_pendientes)]


async def _respaldo_diario():
    """Un respaldo automático al día (al arrancar y luego revisando cada hora)."""
    while True:
        try:
            if not db_manager.respaldo_de_hoy_existe():
                await run_in_threadpool(db_manager.crear_respaldo, "auto")
        except Exception as exc:  # un fallo de respaldo no debe tumbar la API
            print(f"[respaldo] error: {exc}")
        await asyncio.sleep(INTERVALO_RESPALDO_S)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db_manager.init_db()
    _reload_cache()
    await run_in_threadpool(cv_engine.warmup)
    tarea = asyncio.create_task(_respaldo_diario())
    yield
    tarea.cancel()


app = FastAPI(title="Asistencia Liga Infantil - Reconocimiento Facial", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def _analyze(file: UploadFile, miniatura: bool = False, n_foto: int | None = None,
                   antispoofing: bool = False) -> dict:
    image_bytes = await file.read()
    cual = f" en la foto {n_foto}" if n_foto else ""
    extra = {"foto": n_foto} if n_foto else {}
    if not image_bytes:
        _error(400, "imagen_vacia", f"La imagen está vacía{cual}.", **extra)
    try:
        # DeepFace es bloqueante (CPU); se ejecuta fuera del event loop.
        return await run_in_threadpool(cv_engine.analyze_face, image_bytes, miniatura, antispoofing)
    except cv_engine.SpoofError:
        _error(422, "foto_falsa", "La cara parece una foto o una pantalla, no una persona.")
    except cv_engine.FaceNotFoundError:
        _error(422, "sin_rostro", f"No se detectó ningún rostro{cual}.", **extra)
    except ValueError as exc:
        _error(400, "imagen_invalida", f"{str(exc).rstrip('.')}{cual}.", **extra)
    except RuntimeError as exc:
        _error(500, "error_motor", str(exc))


@app.get("/health")
def health():
    compatibles = len(_plantillas_actuales())
    _purgar_pendientes()
    return {
        "status": "ok",
        "jugadores": compatibles,
        "requieren_reinscripcion": len(_jugadores_cache) - compatibles,
        "pendientes": len(_pendientes),
        "threshold": _threshold(),
        "modelo": cv_engine.config["modelo"],
        "detector": cv_engine.config["detector"],
        "antispoofing": cv_engine.config.get("antispoofing", False),
    }


class ConfigIn(BaseModel):
    modelo: str
    detector: str
    umbral: float
    antispoofing: bool | None = None


@app.get("/config")
def get_config():
    return {**cv_engine.config, "modelos": cv_engine.MODELOS, "detectores": cv_engine.DETECTORES}


@app.put("/config")
async def put_config(cfg: ConfigIn):
    try:
        nuevo = await run_in_threadpool(cv_engine.set_config, cfg.modelo, cfg.detector, cfg.umbral,
                                        cfg.antispoofing)
    except ValueError as exc:
        _error(400, "config_invalida", str(exc))
    # Los pendientes se calcularon con el modelo anterior: ya no sirven.
    _pendientes.clear()
    return {**nuevo, "requieren_reinscripcion": len(_jugadores_cache) - len(_plantillas_actuales())}


@app.post("/enroll")
async def enroll(
    nombre: str = Form(...),
    file: UploadFile | None = File(None),
    files: list[UploadFile] | None = File(None),
    categoria: str = Form(""),
    forzar: bool = Form(False),
    consentimiento: bool = Form(False),
    tutor: str = Form(""),
):
    """
    Inscribe con una foto (`file`) o varias (`files`, recomendado 3: frente y ambos perfiles).
    Requiere `consentimiento=true` y el nombre del `tutor` que firmó la autorización.
    """
    nombre, tutor = nombre.strip(), tutor.strip()
    if not nombre:
        _error(400, "sin_nombre", "El nombre es obligatorio.")
    if REQUIERE_CONSENTIMIENTO and not (consentimiento and tutor):
        _error(400, "sin_consentimiento",
               "Falta la autorización firmada del padre, madre o tutor (y su nombre).")
    subidas = ([file] if file else []) + list(files or [])
    if not subidas:
        _error(400, "sin_foto", "Se necesita al menos una foto.")
    if len(subidas) > MAX_FOTOS_INSCRIPCION:
        _error(400, "demasiadas_fotos", f"Máximo {MAX_FOTOS_INSCRIPCION} fotos por inscripción.")

    multiples = len(subidas) > 1
    caras = [await _analyze(f, n_foto=i + 1 if multiples else None) for i, f in enumerate(subidas)]
    embeddings = [c["embedding"] for c in caras]

    # Las fotos deben ser de la misma persona: se marca la que menos se parece al resto.
    if multiples:
        limite = _threshold() - TOLERANCIA_INSCRIPCION
        for i, e in enumerate(embeddings):
            otras = [cv_engine.cosine_similarity(e, o) for j, o in enumerate(embeddings) if j != i]
            if max(otras) < limite:
                _error(422, "fotos_inconsistentes",
                       f"La foto {i + 1} no parece de la misma persona que las demás. Repítela.",
                       foto=i + 1, similitud=round(max(otras), 4))

    # Evita inscribir dos veces al mismo niño (salvo que el staff lo confirme).
    if not forzar and _plantillas_actuales():
        mejores = [_best_match(e) for e in embeddings]
        match_id, score = max(mejores, key=lambda m: m[1])
        if match_id is not None:
            _error(
                409,
                "posible_duplicado",
                f"Este rostro se parece a {_jugadores_cache[match_id]['nombre']}, que ya está inscrito.",
                nombre_existente=_jugadores_cache[match_id]["nombre"],
                similitud=round(score, 4),
            )

    avisos = []
    for i, c in enumerate(caras):
        cual = f"En la foto {i + 1}" if multiples else "En la foto"
        if c["num_rostros"] > 1:
            avisos.append(f"{cual} se detectaron {c['num_rostros']} caras; se usó la más grande.")
        if c["tamano_rostro"] < MIN_FACE_SIZE:
            avisos.append(f"{cual} la cara sale pequeña; para mejores resultados acércate más.")

    categoria = categoria.strip() or None
    modelo = cv_engine.config["modelo"]
    jugador_id = db_manager.insert_jugador(nombre, embeddings[0], categoria, modelo,
                                           fotos_extra=embeddings[1:],
                                           consentimiento_tutor=tutor if consentimiento and tutor else None)
    _jugadores_cache[jugador_id] = {"nombre": nombre, "categoria": categoria,
                                    "plantillas": [(modelo, e) for e in embeddings]}
    return {
        "status": "success",
        "id": jugador_id,
        "nombre": nombre,
        "categoria": categoria,
        "fotos": len(embeddings),
        "avisos": avisos,
        "calidad": [{k: c[k] for k in ("num_rostros", "confianza", "tamano_rostro")} for c in caras],
    }


@app.post("/verify")
async def verify(file: UploadFile = File(...)):
    plantillas = _plantillas_actuales()
    if not plantillas:
        _error(404, "sin_jugadores", "No hay jugadores inscritos todavía.")

    face = await _analyze(file, miniatura=True, antispoofing=cv_engine.config.get("antispoofing", False))
    jugador_id, score = cv_engine.find_match(face["embedding"], plantillas, threshold=_threshold())

    if jugador_id is None:
        # Queda para que el staff indique quién era (y esa foto mejore el reconocimiento).
        _purgar_pendientes()
        sugerido, sim = cv_engine.best_candidate(face["embedding"], plantillas)
        if sim < _threshold() - MARGEN_CORRECCION:
            sugerido = None  # demasiado distinto: mejor no sugerir a nadie
        pid = next(_pendiente_ids)
        _pendientes[pid] = {
            "t": time.time(), "timestamp": datetime.now().isoformat(sep=" ", timespec="seconds"),
            "embedding": face["embedding"], "modelo": cv_engine.config["modelo"],
            "miniatura": face["miniatura"], "sugerido_id": sugerido, "similitud": sim,
        }
        _error(404, "no_reconocido", "Jugador no reconocido.", similitud=round(score, 4), pendiente_id=pid)

    jugador = _jugadores_cache[jugador_id]
    registrado_a_las = db_manager.asistio_hoy(jugador_id)
    if registrado_a_las is None:
        db_manager.registrar_asistencia(jugador_id)

    return {
        "status": "success",
        "nombre": jugador["nombre"],
        "categoria": jugador["categoria"],
        "jugador_id": jugador_id,
        "similitud": round(score, 4),
        "ya_registrado": registrado_a_las is not None,
        "registrado_a_las": registrado_a_las,
    }


@app.get("/pendientes")
def pendientes():
    """Llegadas no reconocidas, de la más reciente a la más antigua, con miniatura y sugerencia."""
    _purgar_pendientes()
    salida = []
    for pid, d in sorted(_pendientes.items(), reverse=True):
        sug = _jugadores_cache.get(d["sugerido_id"])
        salida.append({
            "id": pid,
            "timestamp": d["timestamp"],
            "miniatura": base64.b64encode(d["miniatura"]).decode(),
            "sugerido": ({"id": d["sugerido_id"], "nombre": sug["nombre"], "similitud": round(d["similitud"], 4)}
                         if sug else None),
        })
    return salida


@app.post("/pendientes/{pendiente_id}/asignar")
def asignar_pendiente(pendiente_id: int, jugador_id: int = Form(...)):
    """El staff indica quién era: se registra su asistencia y la foto se suma a sus plantillas."""
    d = _pendientes.pop(pendiente_id, None)
    if d is None:
        _error(404, "no_existe", "Esta llegada ya fue revisada o expiró.")
    if jugador_id not in _jugadores_cache:
        _pendientes[pendiente_id] = d
        _error(404, "no_existe", "El jugador no existe.")
    foto_guardada, motivo = False, None
    if d["modelo"] != cv_engine.config["modelo"]:
        motivo = "La foto se tomó con otro modelo."
    else:
        propias = _plantillas_actuales().get(jugador_id, [])
        parecido = max((cv_engine.cosine_similarity(d["embedding"], e) for e in propias), default=None)
        if parecido is None or parecido >= _threshold() - MARGEN_CORRECCION:
            _agregar_plantilla(jugador_id, d["embedding"], "correccion")
            foto_guardada = True
        else:
            motivo = ("La foto se parece poco a las que ya tiene (¿mala luz, o era otro niño?), "
                      "así que no se usó para aprender.")
    ya = db_manager.asistio_hoy(jugador_id) is not None
    if not ya:
        db_manager.registrar_asistencia(jugador_id, origen="correccion", timestamp=d["timestamp"])
    return {"status": "success", "nombre": _jugadores_cache[jugador_id]["nombre"], "ya_registrado": ya,
            "foto_guardada": foto_guardada, "motivo": motivo}


@app.delete("/pendientes/{pendiente_id}")
def descartar_pendiente(pendiente_id: int):
    if _pendientes.pop(pendiente_id, None) is None:
        _error(404, "no_existe", "Esta llegada ya fue revisada o expiró.")
    return {"status": "success"}


@app.post("/asistencia/manual")
def asistencia_manual(jugador_id: int = Form(...)):
    """Respaldo para cuando el reconocimiento falla: el staff marca al niño a mano."""
    if jugador_id not in _jugadores_cache:
        _error(404, "no_existe", "El jugador no existe.")
    registrado_a_las = db_manager.asistio_hoy(jugador_id)
    if registrado_a_las is None:
        db_manager.registrar_asistencia(jugador_id, origen="manual")
    return {"status": "success", "nombre": _jugadores_cache[jugador_id]["nombre"],
            "ya_registrado": registrado_a_las is not None}


@app.get("/jugadores")
def jugadores():
    return [{**j, "compatible": j["fotos"] > 0}
            for j in db_manager.list_jugadores(cv_engine.config["modelo"])]


@app.post("/jugadores/{jugador_id}/foto")
async def agregar_foto(jugador_id: int, file: UploadFile = File(...)):
    """Agrega una foto nueva a un jugador (si no lo reconoce, o tras cambiar de modelo). Conserva el historial."""
    if jugador_id not in _jugadores_cache:
        _error(404, "no_existe", "El jugador no existe.")
    face = await _analyze(file)
    _agregar_plantilla(jugador_id, face["embedding"], "nueva_foto")
    return {"status": "success", "nombre": _jugadores_cache[jugador_id]["nombre"]}


@app.post("/jugadores/{jugador_id}/consentimiento")
def registrar_consentimiento(jugador_id: int, tutor: str = Form(...)):
    """Registra la autorización firmada para un jugador inscrito sin ella."""
    tutor = tutor.strip()
    if not tutor:
        _error(400, "sin_tutor", "Indica el nombre del padre, madre o tutor que firmó.")
    if not db_manager.set_consentimiento(jugador_id, tutor):
        _error(404, "no_existe", "El jugador no existe.")
    return {"status": "success"}


@app.delete("/jugadores/{jugador_id}")
def borrar_jugador(jugador_id: int):
    if not db_manager.delete_jugador(jugador_id):
        _error(404, "no_existe", "El jugador no existe.")
    _jugadores_cache.pop(jugador_id, None)
    return {"status": "success"}


def _fecha(valor: str, campo: str) -> str:
    try:
        return date.fromisoformat(valor).isoformat()
    except ValueError:
        _error(400, "fecha_invalida", f"{campo} debe tener formato AAAA-MM-DD.")


@app.get("/jornadas")
def jornadas(desde: str, hasta: str):
    """Tipo de jornada de cada día marcado en el rango (los demás son entrenamiento)."""
    return db_manager.get_tipos_jornada(_fecha(desde, "desde"), _fecha(hasta, "hasta"))


@app.put("/jornadas/{fecha}")
def marcar_jornada(fecha: str, tipo: str = Form(...)):
    try:
        db_manager.set_tipo_jornada(_fecha(fecha, "fecha"), tipo)
    except ValueError as exc:
        _error(400, "tipo_invalido", str(exc))
    return {"status": "success", "fecha": fecha, "tipo": tipo}


@app.get("/reportes")
def reporte(desde: str | None = None, hasta: str | None = None, tipo: str = "todos"):
    """Asistencia por jugador en el período (por defecto, los últimos 30 días)."""
    hasta = _fecha(hasta, "hasta") if hasta else date.today().isoformat()
    desde = _fecha(desde, "desde") if desde else (date.fromisoformat(hasta) - timedelta(days=29)).isoformat()
    if desde > hasta:
        _error(400, "rango_invalido", "La fecha inicial es posterior a la final.")
    if tipo not in ("todos", *db_manager.TIPOS_JORNADA):
        _error(400, "tipo_invalido", "tipo debe ser todos, entrenamiento o partido.")
    datos = reportes.calcular_reporte(
        db_manager.list_jugadores(cv_engine.config["modelo"]),
        db_manager.asistencias_por_dia(desde, hasta),
        db_manager.get_tipos_jornada(desde, hasta),
        tipo,
    )
    return {"desde": desde, "hasta": hasta, "tipo": tipo, **datos}


@app.get("/asistencias")
def asistencias(limit: int = 50, hoy: bool = False, fecha: str | None = None):
    return db_manager.get_asistencias(limit, solo_hoy=hoy, fecha=fecha)


# ---------------------------------------------------------------- respaldos

_NOMBRE_RESPALDO = re.compile(r"^asistencia_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6,9}_[a-z]+\.db$")


@app.get("/respaldos")
def respaldos():
    return db_manager.listar_respaldos()


@app.post("/respaldos")
async def crear_respaldo():
    ruta = await run_in_threadpool(db_manager.crear_respaldo, "manual")
    return {"status": "success", "nombre": ruta.name}


@app.get("/respaldos/{nombre}")
def descargar_respaldo(nombre: str):
    # Solo nombres generados por el sistema: evita leer archivos fuera de la carpeta de respaldos.
    ruta = db_manager.RESPALDOS_DIR / nombre
    if not _NOMBRE_RESPALDO.match(nombre) or not ruta.is_file():
        _error(404, "no_existe", "El respaldo no existe.")
    return FileResponse(ruta, filename=nombre, media_type="application/octet-stream")
