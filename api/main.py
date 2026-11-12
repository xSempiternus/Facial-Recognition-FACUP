"""API FastAPI: enrolamiento y verificación facial de jugadores, multi-sede.

Cada sede tiene su propia base, configuración, respaldos, caché de jugadores y pendientes (ver src/sedes.py).
- Endpoints STAFF: la sede sale SOLO del claim `sede` del token firmado (un token jamás abre otra sede).
- Endpoints públicos (/verify, /verify/no-soy-yo, /verify/aviso, /verify/descartar, /kiosko/resumen, /sedes/{slug},
  /inscripcion*): header `X-Sede` (o `?sede=`); sin él, DEFAULT_SEDE. Ninguno registra asistencia sin un
  reconocimiento válido: el veredicto final siempre es del staff.
Módulos: api/nucleo.py (estado por sede), api/inscripcion.py (enlaces + solicitudes de los padres),
api/revision.py (pendientes, "No soy yo", invitados, anulaciones, auditoría), api/consentimiento.py (texto).
"""

import asyncio
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import date, timedelta

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from api import auth, limites, nucleo, sombra
from api.exportes import router as exportes_router
from api.inscripcion import router as inscripcion_router
from api.metricas import router as metricas_router
from api.publica import router as publica_router
from api.nucleo import (Sede, analizar as _analyze, error as _error, log, obtener_sede as _obtener_sede,
                        plantillas_sombra as _plantillas_sombra, precalentar_nombre, sede_publica, sede_staff)
from api.revision import router as revision_router
from api import seguimiento
from api.seguimiento import router as seguimiento_router
from api.voz import precalentar as precalentar_voz, router as voz_router
from src import cv_engine, db_manager, reportes, sedes

# Por debajo de esta fracción del ancho de la imagen, la cara se considera muy lejana.
MIN_FACE_SIZE = 0.15
MAX_FOTOS_INSCRIPCION = 5
# Tolerancia al comparar entre sí las fotos de una misma inscripción (los ángulos laterales se parecen menos).
TOLERANCIA_INSCRIPCION = 0.10
# El resultado del camino rápido de retinaface solo se acepta si es ACEPTADO y supera el umbral AUTOMÁTICO por al
# menos este margen; dudosos, rechazados y aceptados justos se re-verifican con el camino de referencia.
# Reglas del veredicto (umbral automático, umbral de duda, MARGEN_MIN): ver src/cv_engine.py.
MARGEN_VERIFICACION_RAPIDA = 0.05
# Exigir la autorización firmada del tutor para inscribir (datos biométricos de menores).
REQUIERE_CONSENTIMIENTO = os.getenv("REQUIRE_CONSENT", "1") != "0"
# Cada cuánto se revisa si ya existe el respaldo automático del día (de cada sede) y se purgan retenciones.
INTERVALO_RESPALDO_S = 3600
# Cada cuánto se convierten en pendiente las capturas no reconocidas vencidas (ver nucleo.AVISO_TTL_S).
INTERVALO_AVISOS_S = max(1, min(15, nucleo.AVISO_TTL_S // 2))


async def _vencer_avisos():
    """Capturas no reconocidas sin respuesta del kiosko: al vencer (3 min) pasan a pendiente 'abandono' aunque
    nadie consulte (además de la purga perezosa en /pendientes*, /verify y /verify/aviso)."""
    while True:
        await asyncio.sleep(INTERVALO_AVISOS_S)
        for s in list(nucleo._sedes.values()):
            try:
                await run_in_threadpool(s.vencer_avisos)
            except Exception as exc:
                print(f"[avisos:{s.slug}] error: {exc}")


async def _respaldo_diario():
    """Un respaldo automático al día por sede y purga de retenciones (al arrancar y luego cada hora)."""
    while True:
        for info in sedes.listar():
            try:
                base = db_manager.Base(sedes.ruta_db(info["slug"]))
                if base.db_path.exists():
                    # Retenciones (solicitudes 30 días, pendientes 7 días) aunque nadie abra la app.
                    await run_in_threadpool(base.purgar_solicitudes)
                    await run_in_threadpool(base.purgar_pendientes)
                    await run_in_threadpool(base.purgar_verificaciones)  # registro de puntajes: 90 días
                    cargada = nucleo._sedes.get(info["slug"])
                    if cargada is not None:  # alertas de faltas aunque nadie abra el panel (cierre de jornada)
                        await run_in_threadpool(seguimiento.evaluar_alertas, cargada, True)
                    if not base.respaldo_de_hoy_existe():
                        await run_in_threadpool(base.crear_respaldo, "auto")
            except Exception as exc:  # un fallo de respaldo no debe tumbar la API
                print(f"[respaldo:{info['slug']}] error: {exc}")
        await asyncio.sleep(INTERVALO_RESPALDO_S)


def _arrancar_sedes() -> list[Sede]:
    aviso = sedes.migrar_legado(auth.STAFF_PIN)
    if aviso:
        print(f"[sedes] {aviso}")
    if not sedes.existe(sedes.DEFAULT_SEDE):
        print(f"[sedes] AVISO: DEFAULT_SEDE='{sedes.DEFAULT_SEDE}' no existe; los endpoints públicos sin X-Sede darán 404.")
    cargadas = []
    for info in sedes.listar():
        try:
            cargadas.append(_obtener_sede(info["slug"]))
        except Exception:
            log.exception("No se pudo cargar la sede %s", info["slug"])
    return cargadas


def _warmup(cargadas: list[Sede]) -> None:
    vistos = set()
    for s in cargadas or [None]:
        cfg = s.config if s else cv_engine.config
        clave = (cfg["modelo"], cfg["detector"], bool(cfg.get("antispoofing")))
        if clave not in vistos:
            vistos.add(clave)
            cv_engine.warmup(cfg)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if auth.PIN_POR_DEFECTO:
        print("[auth] AVISO: STAFF_PIN no está definido; una sede nueva creada al arrancar usaría el PIN 1234.")
    cargadas = await run_in_threadpool(_arrancar_sedes)
    await run_in_threadpool(_warmup, cargadas)
    nucleo.loop = asyncio.get_running_loop()
    tarea = asyncio.create_task(_respaldo_diario())
    avisos = asyncio.create_task(_vencer_avisos())
    nombres = sorted({n for s in cargadas for n in s.primeros_nombres()})
    voces = asyncio.create_task(precalentar_voz(nombres))  # caché de audio compartida: solo nombres de pila
    yield
    tarea.cancel()
    avisos.cancel()
    voces.cancel()
    for s in list(nucleo._sedes.values()):  # al apagar: lo que quede en memoria pasa a pendiente (no se pierde)
        try:
            s.vencer_avisos(todos=True)
        except Exception:
            log.exception("[%s] avisos al apagar", s.slug)


# La documentación interactiva (/docs, /redoc, /openapi.json) queda apagada: no hay motivo para publicar el mapa de la API.
# Para desarrollo local: ENABLE_DOCS=1.
_DOCS = os.getenv("ENABLE_DOCS") == "1"
app = FastAPI(
    title="Asistencia Liga Infantil - Reconocimiento Facial",
    lifespan=lifespan,
    docs_url="/docs" if _DOCS else None,
    redoc_url="/redoc" if _DOCS else None,
    openapi_url="/openapi.json" if _DOCS else None,
)
app.include_router(voz_router)
app.include_router(inscripcion_router)
app.include_router(revision_router)
app.include_router(metricas_router)
app.include_router(publica_router)
app.include_router(seguimiento_router)
app.include_router(exportes_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if o.strip()],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    """Público (túneles, monitores): solo dice que la API vive, sin datos del sistema."""
    return {"status": "ok"}


@app.get("/health/detalle")
def health_detalle(s: Sede = Depends(sede_staff)):
    compatibles = len(s.plantillas_actuales())
    s.vencer_avisos()
    s.db.purgar_pendientes()
    return {
        "status": "ok",
        "sede": s.slug,
        "jugadores": compatibles,
        "requieren_reinscripcion": len(s.jugadores) - compatibles,
        "pendientes": s.db.contar_pendientes(),
        "solicitudes": s.db.contar_solicitudes(),
        "threshold": s.umbral_auto(),
        "threshold_duda": s.umbral_duda(),
        "margen_min": cv_engine.MARGEN_MIN,
        "modelo": s.config["modelo"],
        "detector": s.config["detector"],
        "antispoofing": s.config.get("antispoofing", False),
    }


class ConfigIn(BaseModel):
    modelo: str
    detector: str
    umbral: float  # aceptación automática
    umbral_duda: float | None = None  # opcional: si falta se conserva el actual (o umbral - UMBRAL_AUTO_OFFSET)
    antispoofing: bool | None = None


@app.post("/auth/login")
def login(request: Request, pin: str = Form(...), sede: str = Form("")):
    """PIN de la sede indicada (form-data `sede`, opcional; por defecto DEFAULT_SEDE). El token lleva la sede."""
    slug = sede.strip() or sedes.DEFAULT_SEDE
    token = auth.verificar_pin(pin, request, slug)
    info = sedes.obtener(slug)
    return {"token": token, "expira_en": auth.TOKEN_TTL_S, "sede": {"slug": info["slug"], "nombre": info["nombre"]}}


@app.get("/sedes")
def listar_sedes_publicas(request: Request):
    """Público y mínimo: sedes activas (solo slug y nombre; sin PIN, conteos ni fechas). Alimenta el selector del staff."""
    limites.SEDES_IP.exigir(auth._cliente(request))
    return [{"slug": i["slug"], "nombre": i["nombre"]} for i in sedes.listar() if sedes.existe(i["slug"])]


@app.get("/sedes/{slug}")
def sede_publica_info(slug: str):
    """Público y mínimo: nombre de la sede y sus categorías activas (sin datos de jugadores)."""
    try:
        s = _obtener_sede(slug)
    except sedes.SedeNoExiste:
        _error(404, "sede_no_existe", "La sede no existe.")
    return {"slug": s.slug, "nombre": s.nombre,
            "categorias": [c["nombre"] for c in s.db.listar_categorias(incluir_inactivas=False)]}


@app.get("/kiosko/resumen")
def kiosko_resumen(s: Sede = Depends(sede_publica)):
    """Dato público mínimo para la pantalla del kiosko (sin nombres de niños)."""
    return {"llegadas_hoy": s.db.llegadas_hoy()}


@app.get("/config")
def get_config(s: Sede = Depends(sede_staff)):
    """`umbral` = aceptación automática; `umbral_duda` = desde ahí la captura es dudosa (pasa al staff);
    `margen_min` = margen mínimo contra el segundo jugador distinto (solo lectura, por entorno)."""
    return {**s.config, "margen_min": cv_engine.MARGEN_MIN, "modelos": cv_engine.MODELOS,
            "detectores": cv_engine.DETECTORES}


@app.put("/config")
async def put_config(cfg: ConfigIn, s: Sede = Depends(sede_staff)):
    try:
        nuevo = await run_in_threadpool(cv_engine.set_config, cfg.modelo, cfg.detector, cfg.umbral,
                                        cfg.antispoofing, s.config, s.ruta_config, cfg.umbral_duda)
    except ValueError as exc:
        _error(400, "config_invalida", str(exc))
    # Los pendientes persisten: al asignarlos, una foto de otro modelo solo registra la asistencia (no se aprende).
    return {**nuevo, "margen_min": cv_engine.MARGEN_MIN,
            "requieren_reinscripcion": len(s.jugadores) - len(s.plantillas_actuales())}


# ---------------------------------------------------------------- categorías (staff, por sede)

def _categoria_o_error(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except db_manager.CategoriaInvalida as exc:
        _error(400, "categoria_invalida", str(exc))


@app.get("/categorias")
def listar_categorias(s: Sede = Depends(sede_staff)):
    return s.db.listar_categorias()


@app.post("/categorias")
def crear_categoria(nombre: str = Form(...), orden: int | None = Form(None), s: Sede = Depends(sede_staff)):
    return _categoria_o_error(s.db.crear_categoria, nombre, orden)


@app.patch("/categorias/{categoria_id}")
def editar_categoria(categoria_id: int, nombre: str | None = Form(None), orden: int | None = Form(None),
                     activa: bool | None = Form(None), s: Sede = Depends(sede_staff)):
    """Renombra (los jugadores de esa categoría quedan con el nombre nuevo), reordena o (des)activa."""
    cat = _categoria_o_error(s.db.actualizar_categoria, categoria_id, nombre, orden, activa)
    if cat is None:
        _error(404, "no_existe", "La categoría no existe.")
    if nombre is not None:
        s.recargar()
    return cat


@app.delete("/categorias/{categoria_id}")
def desactivar_categoria(categoria_id: int, s: Sede = Depends(sede_staff)):
    """Desactiva (no borra: los jugadores la conservan). Reactívala con PATCH activa=true."""
    cat = s.db.actualizar_categoria(categoria_id, activa=False)
    if cat is None:
        _error(404, "no_existe", "La categoría no existe.")
    return cat


# ---------------------------------------------------------------- inscripción y verificación

@app.post("/enroll")
async def enroll(
    nombre: str = Form(...),
    file: UploadFile | None = File(None),
    files: list[UploadFile] | None = File(None),
    categoria: str = Form(""),
    forzar: bool = Form(False),
    consentimiento: bool = Form(False),
    tutor: str = Form(""),
    s: Sede = Depends(sede_staff),
):
    """
    Inscribe con una foto (`file`) o varias (`files`, recomendado 3: frente y ambos perfiles).
    Requiere `consentimiento=true` y el nombre del `tutor` que firmó la autorización.
    `categoria`: nombre de una categoría de la sede; si no existe se crea, si está desactivada -> 400.
    """
    nombre, tutor = nombre.strip(), tutor.strip()
    if not nombre:
        _error(400, "sin_nombre", "El nombre es obligatorio.")
    if REQUIERE_CONSENTIMIENTO and not (consentimiento and tutor):
        _error(400, "sin_consentimiento",
               "Falta la autorización firmada del padre, madre o tutor (y su nombre).")
    if categoria.strip():
        _categoria_o_error(db_manager.normalizar_categoria, categoria)  # falla rápido, antes de la inferencia
    subidas = ([file] if file else []) + list(files or [])
    if not subidas:
        _error(400, "sin_foto", "Se necesita al menos una foto.")
    if len(subidas) > MAX_FOTOS_INSCRIPCION:
        _error(400, "demasiadas_fotos", f"Máximo {MAX_FOTOS_INSCRIPCION} fotos por inscripción.")

    multiples = len(subidas) > 1
    caras = [await _analyze(s, f, n_foto=i + 1 if multiples else None, sombra=True) for i, f in enumerate(subidas)]
    embeddings = [c["embedding"] for c in caras]
    extras = _plantillas_sombra(caras)

    # Las fotos deben ser de la misma persona: se marca la que menos se parece al resto.
    if multiples:
        limite = s.umbral() - TOLERANCIA_INSCRIPCION
        for i, e in enumerate(embeddings):
            otras = [cv_engine.cosine_similarity(e, o) for j, o in enumerate(embeddings) if j != i]
            if max(otras) < limite:
                _error(422, "fotos_inconsistentes",
                       f"La foto {i + 1} no parece de la misma persona que las demás. Repítela.",
                       foto=i + 1, similitud=round(max(otras), 4))

    # Evita inscribir dos veces al mismo niño en esta sede (salvo que el staff lo confirme).
    if not forzar and s.plantillas_actuales():
        mejores = [s.best_match(e) for e in embeddings]
        match_id, score = max(mejores, key=lambda m: m[1])
        if match_id is not None:
            _error(
                409,
                "posible_duplicado",
                f"Este rostro se parece a {s.jugadores[match_id]['nombre']}, que ya está inscrito.",
                nombre_existente=s.jugadores[match_id]["nombre"],
                similitud=round(score, 4),
            )

    avisos = []
    for i, c in enumerate(caras):
        cual = f"En la foto {i + 1}" if multiples else "En la foto"
        if c["num_rostros"] > 1:
            avisos.append(f"{cual} se detectaron {c['num_rostros']} caras; se usó la más grande.")
        if c["tamano_rostro"] < MIN_FACE_SIZE:
            avisos.append(f"{cual} la cara sale pequeña; para mejores resultados acércate más.")

    categoria = _categoria_o_error(s.db.resolver_categoria, categoria)
    modelo = s.config["modelo"]
    jugador_id = s.db.insert_jugador(nombre, embeddings[0], categoria, modelo,
                                     fotos_extra=embeddings[1:],
                                     consentimiento_tutor=tutor if consentimiento and tutor else None,
                                     plantillas_extra=extras)
    with s.lock:
        s.jugadores[jugador_id] = {"nombre": nombre, "categoria": categoria, "estado": "activo",
                                   "plantillas": [(modelo, e) for e in embeddings]
                                   + [(m, e) for m, es in extras.items() if m != modelo for e in es]}
    parecido = s.revisar_parecidos(jugador_id)  # par cercano (>= 0.30): aviso + el kiosko pedirá confirmación
    if parecido:
        avisos.append(parecido["mensaje"])
    precalentar_nombre(nombre)  # voz lista antes de que llegue a la cancha
    return {
        "status": "success",
        "id": jugador_id,
        "nombre": nombre,
        "categoria": categoria,
        "fotos": len(embeddings),
        "avisos": avisos,
        "parecido": parecido,  # {jugador_id, nombre, similitud, mensaje} o None
        "calidad": [{k: c[k] for k in ("num_rostros", "confianza", "tamano_rostro")} for c in caras],
    }


def _log_verificacion(s: Sede, resultado: str, t0: float, mejor_id: int | None = None,
                      mejor_score: float | None = None, segundo_id: int | None = None,
                      segundo_score: float | None = None, ms_deteccion: int | None = None) -> int | None:
    """Registro de puntajes para calibrar (sin biometría). Un fallo del registro nunca rompe /verify.
    Retorna el id de la fila (None si falló)."""
    try:
        return s.db.registrar_verificacion(resultado, mejor_id, mejor_score, segundo_id, segundo_score,
                                           s.umbral_auto(), s.umbral_duda(), s.config["modelo"], s.config["detector"],
                                           round((time.perf_counter() - t0) * 1000), ms_deteccion)
    except Exception:
        log.exception("[%s] no se pudo registrar la verificación", s.slug)
        return None


# Otra cara con al menos este % del área de la principal: se rechaza (no se adivina a quién se quiso registrar).
OTRA_CARA_MAX = 0.35


def _exigir_una_persona(face: dict) -> None:
    if face.get("otra_cara", 0.0) >= OTRA_CARA_MAX:
        _error(422, "varias_caras", "Hay más de una persona frente a la cámara.")


@app.post("/verify")
async def verify(request: Request, file: UploadFile = File(...), s: Sede = Depends(sede_publica)):
    """Público. Compara SOLO contra los jugadores de la sede del header X-Sede (o ?sede=, o la por defecto).

    Contrato multipart:
      - `file` (obligatorio): foto del kiosko (JPG/PNG/WEBP, <= 2 MB, <= 2000 px de lado). Es lo ÚNICO que decide.
      - `cara` (opcional, MODO SOMBRA): la cara ya recortada y alineada en el celular, JPEG de ~160x160
        (lados entre 64 y 320 px, <= 64 KB). Solo se usa si llega JUNTO con `file`: se calcula el embedding del
        modelo principal con detector skip (sin retinaface) y se registra en verificaciones_log su puntaje contra el
        MISMO candidato que eligió el servidor (`score_cliente`) y el tiempo de ese embedding (`ms_cliente`).
        Nunca cambia el veredicto ni la respuesta; si no cumple el contrato se ignora en silencio. Se procesa
        después de responder (sin latencia extra para el kiosko).
    Ensemble sombra: en zona gris (ver api/sombra.py) se registra además SFace sobre el mismo recorte."""
    if s.matriz_plantillas()[1] is None:
        _error(404, "sin_jugadores", "No hay jugadores inscritos todavía.")

    umbral_auto, umbral_duda = s.umbral_auto(), s.umbral_duda()
    modelo = s.config["modelo"]
    antispoofing = s.config.get("antispoofing", False)
    t0 = time.perf_counter()
    cara_cliente = None
    if sombra.ACTIVA:
        try:  # el form ya lo parseó FastAPI (queda en caché): leer `cara` así no falla si llega como texto
            cara_cliente = await sombra.leer_cara_cliente((await request.form()).get("cara"))
        except Exception:
            cara_cliente = None

    def clasificar(face):
        mejor_id, score, segundo_id, segundo = s.dos_mejores(face["embedding"])
        res = cv_engine.decidir(score if mejor_id is not None else None, segundo, umbral_auto, umbral_duda,
                                cv_engine.MARGEN_MIN, par_cercano=s.es_par_cercano(mejor_id, segundo_id))
        return res, mejor_id, score, segundo_id, segundo

    try:
        # Camino rápido: solo vale si es ACEPTADO con holgura (score >= umbral_auto + MARGEN_VERIFICACION_RAPIDA y
        # margen suficiente); cualquier otro caso (dudoso, rechazado o aceptado justo) se confirma con el de
        # referencia, que es el que decide. (Si el rápido ya cayó solo al de referencia, `face["rapido"]` es False y
        # no se repite el mismo análisis.)
        face = await _analyze(s, file, miniatura=True, antispoofing=antispoofing, rapido=True, publico=True)
        _exigir_una_persona(face)
        res, jugador_id, score, segundo_id, segundo = clasificar(face)
        if face.get("rapido") and (res != "aceptado" or score < umbral_auto + MARGEN_VERIFICACION_RAPIDA):
            face = await _analyze(s, file, miniatura=True, antispoofing=antispoofing, publico=True)
            _exigir_una_persona(face)
            res, jugador_id, score, segundo_id, segundo = clasificar(face)
    except HTTPException as exc:
        cod = exc.detail.get("codigo") if isinstance(exc.detail, dict) else None
        _log_verificacion(s, "sin_cara" if cod == "sin_rostro" else "error", t0)
        raise

    jugador = s.jugadores.get(jugador_id) if jugador_id is not None else None
    if jugador is None and res == "aceptado":
        res = "rechazado"  # borrado entre medio (carrera): nunca se acepta a alguien que ya no está
    vid = _log_verificacion(s, res, t0, jugador_id, score if jugador_id is not None else None, segundo_id, segundo,
                            face.get("ms_deteccion"))
    # MODO SOMBRA (después de responder; no toca `res`): SFace en zona gris y/o la cara recortada en el celular.
    gris = jugador_id is not None and sombra.zona_gris(res, score, segundo, umbral_auto, umbral_duda)
    sombra.programar(s, vid, modelo, umbral_duda, jugador_id, score if jugador_id is not None else None,
                     face.get("_recorte"), gris, cara_cliente)
    if res != "aceptado":
        # NO crea pendiente ni asistencia: la captura queda en memoria (3 min, un solo uso) bajo `aviso`. El kiosko
        # decide con /verify/aviso (entrenador | nuevo | abandono) o /verify/descartar (reintento); si no dice nada,
        # al vencer pasa sola a pendiente. Así un niño que reintenta no llena la cola del staff.
        # DUDOSO: misma respuesta pública (sin nombre ni puntaje) + `dudoso: true`; la captura conserva al candidato
        # como sugerencia para el staff, que da el veredicto final.
        parecido = None
        if res == "dudoso":
            parecido = "alto" if score >= umbral_auto else "medio"
        aviso = await run_in_threadpool(s.crear_aviso, face, (jugador_id, score), parecido, vid)
        extra = {"dudoso": True} if res == "dudoso" else {}
        _error(404, "no_reconocido", "Jugador no reconocido.", aviso=aviso, **extra)

    registrado_a_las = s.db.asistio_hoy(jugador_id)
    asistencia_id = s.db.registrar_asistencia(jugador_id, similitud=score) if registrado_a_las is None else None
    # Id de un solo uso (2 min) para "No soy yo": solo disputa la asistencia que creó ESTE verify.
    reporte = s.crear_reporte(face, jugador_id, asistencia_id, vid)

    # Endpoint público (sin auth): solo lo que muestra el kiosko. Nombre de pila, sin id ni similitud.
    return {
        "status": "success",
        "nombre": (jugador["nombre"].split() or [""])[0],
        "categoria": jugador["categoria"],
        "ya_registrado": registrado_a_las is not None,
        "registrado_a_las": registrado_a_las,
        "reporte": reporte,
        # Booleano grueso (sin puntaje): aceptado cerca del umbral -> el staff lo verá en "Revisar" (franja del kiosko).
        "revisar": bool(float(score) < seguimiento.limite_revision(s)),
    }


@app.post("/asistencia/manual")
def asistencia_manual(jugador_id: int = Form(...), s: Sede = Depends(sede_staff)):
    """STAFF. Respaldo para cuando el reconocimiento falla: el staff marca al niño a mano (origen 'manual').
    Es el veredicto del staff: el kiosko público nunca llega aquí."""
    if jugador_id not in s.jugadores:
        _error(404, "no_existe", "El jugador no existe.")
    registrado_a_las = s.db.asistio_hoy(jugador_id)
    if registrado_a_las is None:
        s.db.registrar_asistencia(jugador_id, origen="manual")
    return {"status": "success", "nombre": s.jugadores[jugador_id]["nombre"],
            "ya_registrado": registrado_a_las is not None}


@app.get("/jugadores/sin-asistencia-hoy")
def sin_asistencia_hoy(s: Sede = Depends(sede_staff)):
    """Para marcar a mano rápido: activos (no invitados) sin asistencia válida hoy, por categoría y nombre.
    [{id, nombre, categoria}] (sin miniaturas ni biometría)."""
    return s.db.sin_asistencia_hoy()


@app.get("/staff/preferencias")
def staff_preferencias(s: Sede = Depends(sede_staff)):
    """Preferencias de la UI del staff, compartidas por la sede (no dependen del origen/túnel del navegador)."""
    return {"tours_vistos": s.db.tours_vistos()}


_TOUR_ID = re.compile(r"^[a-z0-9-]{1,40}$")
MAX_TOURS = 200


@app.post("/staff/tours/{tour_id}")
def staff_marcar_tour(tour_id: str, s: Sede = Depends(sede_staff)):
    """Marca un tour como visto (idempotente)."""
    if not _TOUR_ID.match(tour_id):
        _error(400, "tour_invalido", "Id de tour inválido (1-40 caracteres: a-z, 0-9, -).")
    vistos = s.db.tours_vistos()
    if tour_id not in vistos:
        if len(vistos) >= MAX_TOURS:
            _error(400, "demasiados_tours", "Demasiados tours registrados; reinícialos.")
        s.db.marcar_tour(tour_id)
        vistos.append(tour_id)
    return {"tours_vistos": vistos}


@app.delete("/staff/tours")
def staff_reiniciar_tours(s: Sede = Depends(sede_staff)):
    s.db.reiniciar_tours()
    return {"tours_vistos": []}


@app.get("/jugadores")
def jugadores(s: Sede = Depends(sede_staff)):
    """Incluye `estado` ('activo' | 'invitado') y `tiene_consentimiento`."""
    return [{**j, "compatible": j["fotos"] > 0} for j in s.db.list_jugadores(s.config["modelo"])]


@app.post("/jugadores/{jugador_id}/foto")
async def agregar_foto(jugador_id: int, file: UploadFile = File(...), s: Sede = Depends(sede_staff)):
    """Agrega una foto nueva a un jugador (si no lo reconoce, o tras cambiar de modelo). Conserva el historial."""
    if jugador_id not in s.jugadores:
        _error(404, "no_existe", "El jugador no existe.")
    if not s.es_activo(jugador_id):
        _error(409, "es_invitado", "Es un invitado sin autorización de imagen: apruébalo con una solicitud "
                                   "de inscripción de su familia.")
    face = await _analyze(s, file)
    await run_in_threadpool(s.agregar_plantilla, jugador_id, face["embedding"], "nueva_foto")
    return {"status": "success", "nombre": s.jugadores[jugador_id]["nombre"]}


@app.post("/jugadores/{jugador_id}/consentimiento")
def registrar_consentimiento(jugador_id: int, tutor: str = Form(...), s: Sede = Depends(sede_staff)):
    """Registra la autorización firmada para un jugador inscrito sin ella."""
    tutor = tutor.strip()
    if not tutor:
        _error(400, "sin_tutor", "Indica el nombre del padre, madre o tutor que firmó.")
    if not s.db.set_consentimiento(jugador_id, tutor):
        _error(404, "no_existe", "El jugador no existe.")
    return {"status": "success"}


@app.delete("/jugadores/{jugador_id}")
def borrar_jugador(jugador_id: int, s: Sede = Depends(sede_staff)):
    """Borra al jugador de la sede y también de los respaldos de la sede (fila, embeddings y asistencias)."""
    if not s.db.delete_jugador(jugador_id):
        _error(404, "no_existe", "El jugador no existe.")
    with s.lock:
        s.jugadores.pop(jugador_id, None)
    s.db.auditar("borrar_jugador", f"jugador #{jugador_id}")
    purga = s.db.purgar_de_respaldos(jugador_id)
    if purga["errores"]:
        log.warning("[%s] no se pudo purgar al jugador %s de: %s", s.slug, jugador_id, purga["errores"])
    return {"status": "success", "respaldos_purgados": purga["purgados"], "respaldos_con_error": purga["errores"]}


def _fecha(valor: str, campo: str) -> str:
    try:
        return date.fromisoformat(valor).isoformat()
    except ValueError:
        _error(400, "fecha_invalida", f"{campo} debe tener formato AAAA-MM-DD.")


@app.get("/jornadas")
def jornadas(desde: str, hasta: str, s: Sede = Depends(sede_staff)):
    """Tipo de jornada de cada día marcado en el rango (los demás son entrenamiento)."""
    return s.db.get_tipos_jornada(_fecha(desde, "desde"), _fecha(hasta, "hasta"))


@app.put("/jornadas/{fecha}")
def marcar_jornada(fecha: str, tipo: str = Form(...), s: Sede = Depends(sede_staff)):
    try:
        s.db.set_tipo_jornada(_fecha(fecha, "fecha"), tipo)
    except ValueError as exc:
        _error(400, "tipo_invalido", str(exc))
    seguimiento.evaluar_alertas(s, forzar=True)  # una jornada marcada cuenta para las faltas seguidas
    return {"status": "success", "fecha": fecha, "tipo": tipo}


@app.get("/reportes")
def reporte(desde: str | None = None, hasta: str | None = None, tipo: str = "todos", s: Sede = Depends(sede_staff)):
    """Asistencia por jugador en el período (por defecto, los últimos 30 días)."""
    hasta = _fecha(hasta, "hasta") if hasta else date.today().isoformat()
    desde = _fecha(desde, "desde") if desde else (date.fromisoformat(hasta) - timedelta(days=29)).isoformat()
    if desde > hasta:
        _error(400, "rango_invalido", "La fecha inicial es posterior a la final.")
    if tipo not in ("todos", *db_manager.TIPOS_JORNADA):
        _error(400, "tipo_invalido", "tipo debe ser todos, entrenamiento o partido.")
    datos = reportes.calcular_reporte(
        s.db.list_jugadores(s.config["modelo"]),
        s.db.asistencias_por_dia(desde, hasta),
        s.db.get_tipos_jornada(desde, hasta),
        tipo,
    )
    return {"desde": desde, "hasta": hasta, "tipo": tipo, **datos}


@app.get("/asistencias")
def asistencias(limit: int = 50, hoy: bool = False, fecha: str | None = None, todas: bool = False,
                s: Sede = Depends(sede_staff)):
    """Cada fila: id, jugador_id, nombre, categoria, jugador_estado, timestamp, origen, estado, motivo.
    Incluye las 'disputadas' (marcadas); las 'anuladas' solo con todas=true."""
    if fecha:
        fecha = _fecha(fecha, "fecha")
    return s.db.get_asistencias(max(1, min(limit, 1000)), solo_hoy=hoy, fecha=fecha, incluir_anuladas=todas)


# ---------------------------------------------------------------- respaldos (de la sede del token)

_NOMBRE_RESPALDO = re.compile(r"^asistencia_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6,9}_[a-z]+\.db$")


@app.get("/respaldos")
def respaldos(s: Sede = Depends(sede_staff)):
    return s.db.listar_respaldos()


@app.post("/respaldos")
async def crear_respaldo(s: Sede = Depends(sede_staff)):
    ruta = await run_in_threadpool(s.db.crear_respaldo, "manual")
    return {"status": "success", "nombre": ruta.name}


@app.get("/respaldos/{nombre}")
def descargar_respaldo(nombre: str, s: Sede = Depends(sede_staff)):
    # Solo nombres generados por el sistema: evita leer archivos fuera de la carpeta de respaldos de la sede.
    ruta = s.db.respaldos_dir / nombre
    if not _NOMBRE_RESPALDO.match(nombre) or not ruta.is_file():
        _error(404, "no_existe", "El respaldo no existe.")
    return FileResponse(ruta, filename=nombre, media_type="application/octet-stream")
