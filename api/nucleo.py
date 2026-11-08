"""Núcleo compartido por los routers: estado en memoria de cada sede, dependencias de sede (staff / pública),
errores con código y análisis de imágenes con límites. Nada se comparte entre sedes."""

import asyncio
import hashlib
import hmac
import io
import logging
import os
import secrets
import threading
import time
from datetime import datetime

from fastapi import Depends, Header, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
import numpy as np
from PIL import Image

from api import auth
from api.voz import precalentar as precalentar_voz
from src import cv_engine, db_manager, sedes

log = logging.getLogger("uvicorn.error")

# Límites de subida (se rechazan antes de la inferencia pesada). /verify es público y el kiosko solo manda
# fotos de ~720 px, así que ahí el tope es estricto; el staff (con sesión) sube fotos de galería o de cámaras HD.
MAX_BYTES_IMAGEN = 2 * 1024 * 1024
MAX_LADO_IMAGEN = 2000
MAX_BYTES_IMAGEN_STAFF = 15 * 1024 * 1024
MAX_LADO_IMAGEN_STAFF = 8000
# Una corrección del staff solo se guarda como foto del jugador si se parece al menos
# (umbral - MARGEN_CORRECCION) a sus fotos actuales: protege contra asignaciones equivocadas.
MARGEN_CORRECCION = 0.25
# Reporte "No soy yo": id de un solo uso que vive 2 minutos en memoria con la captura de ese /verify.
REPORTE_TTL_S = 120
MAX_REPORTES = 500
# Fallo de reconocimiento: la captura de un /verify no reconocido vive en memoria (un solo uso) bajo un `aviso`
# aleatorio hasta que el kiosko diga qué pasó (/verify/aviso) o que el niño reintenta (/verify/descartar).
# Si en AVISO_TTL_S no llega nada, se convierte sola en pendiente (abandono): ninguna llegada se pierde.
# AVISO_TTL_S solo se puede ACORTAR por entorno (pruebas); nunca supera 3 minutos.
AVISO_TTL_MAX_S = 180
try:
    AVISO_TTL_S = max(1, min(int(os.getenv("AVISO_TTL_S", AVISO_TTL_MAX_S)), AVISO_TTL_MAX_S))
except ValueError:
    AVISO_TTL_S = AVISO_TTL_MAX_S
# Tope por sede; al superarlo, la captura más antigua pasa a pendiente (abandono) en vez de perderse.
MAX_AVISOS = 200
# tipo del aviso del kiosko -> motivo del pendiente
MOTIVO_AVISO = {"entrenador": "no_reconocido", "abandono": "no_reconocido", "nuevo": "nino_nuevo"}


def error(status: int, codigo: str, mensaje: str, **extra):
    """Errores con código legible por la UI: {"detail": {"codigo", "mensaje", ...}}."""
    raise HTTPException(status_code=status, detail={"codigo": codigo, "mensaje": mensaje, **extra})


def ahora_ts() -> str:
    return datetime.now().isoformat(sep=" ", timespec="seconds")


class Sede:
    """Todo lo que vive en memoria para una sede. Nada se comparte entre sedes."""

    def __init__(self, slug: str, nombre: str):
        self.slug, self.nombre = slug, nombre
        self.db = db_manager.Base(sedes.ruta_db(slug))
        self.ruta_config = sedes.ruta_config(slug)
        self.config = cv_engine.load_config(self.ruta_config)
        # {jugador_id: {"nombre", "categoria", "estado", "plantillas": [(modelo, embedding), ...]}}
        self.jugadores: dict[int, dict] = {}
        # {reporte: {"t", "timestamp", "embedding", "modelo", "miniatura", "jugador_id", "asistencia_id"}}
        self.reportes: dict[str, dict] = {}
        # {aviso: {"t", "timestamp", "embedding", "modelo", "miniatura", "sugerencia": (jugador_id, similitud)}}
        self.avisos: dict[str, dict] = {}
        # avisos ya resueltos {aviso: (t, "pendiente" | "descartado")} (idempotencia), viven AVISO_TTL_S
        self.avisos_usados: dict[str, tuple[float, str]] = {}
        self._matriz: tuple | None = None  # caché de plantillas (ver matriz_plantillas)
        self.lock = threading.RLock()
        self.db.init_db()
        self._sal = self.db.ip_sal().encode()
        self.recargar()

    def recargar(self) -> None:
        nuevos = {j["id"]: {"nombre": j["nombre"], "categoria": j["categoria"],
                            "estado": j.get("estado") or "activo", "plantillas": j["plantillas"]}
                  for j in self.db.get_all_jugadores()}
        with self.lock:
            self.jugadores = nuevos

    def umbral(self) -> float:
        return self.config["umbral"]

    def es_activo(self, jugador_id: int) -> bool:
        j = self.jugadores.get(jugador_id)
        return j is not None and j["estado"] == "activo"

    def plantillas_actuales(self) -> dict[int, list]:
        """{jugador_id: [embeddings del modelo actual]}; solo jugadores ACTIVOS con al menos una foto comparable
        (los invitados no tienen biometría y quedan fuera del reconocimiento)."""
        modelo = self.config["modelo"]
        salida = {}
        for jid, d in list(self.jugadores.items()):
            if d["estado"] != "activo":
                continue
            embs = [e for m, e in d["plantillas"] if m == modelo]
            if embs:
                salida[jid] = embs
        return salida

    def matriz_plantillas(self) -> tuple[list[int], "np.ndarray | None", "np.ndarray | None"]:
        """(claves, matriz float32, normas) de las plantillas actuales, cacheada mientras no cambien.

        Huella: modelo + por jugador (id, estado, id(lista de plantillas), largo). La caché retiene esas listas, así
        que sus id() no se reutilizan mientras está viva: alta, baja, cambio de estado, foto agregada o recarga
        cambian la huella. Mismas operaciones float32 que cv_engine.best_candidate (puntajes idénticos), sin
        reconvertir miles de floats de Python en cada /verify."""
        modelo = self.config["modelo"]
        items = list(self.jugadores.items())
        huella = (modelo, tuple((jid, d["estado"], id(d["plantillas"]), len(d["plantillas"])) for jid, d in items))
        cache = self._matriz
        if cache is not None and cache[0] == huella:
            return cache[2], cache[3], cache[4]
        claves, filas = [], []
        for jid, d in items:
            if d["estado"] != "activo":
                continue
            for m, e in d["plantillas"]:
                if m == modelo:
                    claves.append(jid)
                    filas.append(e)
        if filas:
            mat = np.asarray(filas, dtype=np.float32)
            normas = np.linalg.norm(mat, axis=1)
        else:
            mat = normas = None
        self._matriz = (huella, [d["plantillas"] for _, d in items], claves, mat, normas)
        return claves, mat, normas

    def mejor_candidato(self, embedding, excluir: int | None = None) -> tuple[int | None, float]:
        """Como cv_engine.best_candidate(embedding, plantillas_actuales()) pero con la matriz cacheada.
        `excluir`: jugador que no puede ser candidato (disputas)."""
        claves, mat, normas_m = self.matriz_plantillas()
        if mat is not None and excluir is not None:
            filas = [i for i, k in enumerate(claves) if k != excluir]
            claves, mat, normas_m = [claves[i] for i in filas], mat[filas], normas_m[filas]
        if mat is None or not claves:
            return None, -1.0
        t = np.asarray(embedding, dtype=np.float32)
        normas = normas_m * np.linalg.norm(t)
        puntajes = np.divide(mat @ t, normas, out=np.zeros(len(claves), np.float32), where=normas != 0)
        i = int(puntajes.argmax())
        return claves[i], float(puntajes[i])

    def buscar(self, embedding) -> tuple[int | None, float]:
        """Como cv_engine.find_match con el umbral de la sede: (jugador_id, similitud) o (None, mejor_similitud)."""
        jid, score = self.mejor_candidato(embedding)
        return (jid, score) if jid is not None and score > self.umbral() else (None, score)

    def agregar_plantilla(self, jugador_id: int, embedding: list[float], origen: str) -> None:
        modelo = self.config["modelo"]
        self.db.add_foto(jugador_id, embedding, modelo, origen)
        with self.lock:
            plantillas = self.jugadores[jugador_id]["plantillas"]
            plantillas.append((modelo, embedding))
            # Si se superó el límite, la BD descartó alguna foto: se relee para que la cache coincida.
            if sum(1 for m, _ in plantillas if m == modelo) > db_manager.MAX_FOTOS:
                self.jugadores[jugador_id]["plantillas"] = self.db.plantillas_de(jugador_id)

    def best_match(self, embedding: list[float]):
        return self.buscar(embedding)

    def primeros_nombres(self) -> list[str]:
        return sorted({j["nombre"].split()[0] for j in self.jugadores.values() if j["nombre"].split()})

    def ip_hash(self, ip: str) -> str:
        """HMAC de la IP con una sal propia de la sede: evidencia sin guardar la IP en claro."""
        return hmac.new(self._sal, (ip or "?").encode(), hashlib.sha256).hexdigest()

    # ---------------------------------------------------------- pendientes (persistentes, en la BD)

    def nuevo_pendiente(self, embedding: list[float], miniatura: bytes, timestamp: str | None = None,
                        motivo: str = "no_reconocido", disputa_de: int | None = None,
                        asistencia_id: int | None = None, modelo: str | None = None,
                        sugerencia: tuple[int | None, float] | None = None) -> int:
        """`sugerencia` (jugador_id, similitud) ya calculada (avisos del kiosko); si no, se calcula aquí.
        Con disputa_de se sugiere a otro niño, no al que se reconoció por error."""
        sugerido, sim = sugerencia if sugerencia is not None else self.mejor_candidato(embedding, excluir=disputa_de)
        if sugerido is None or sim < self.umbral() - MARGEN_CORRECCION or sugerido not in self.jugadores:
            sugerido = None  # demasiado distinto (o ya no existe): mejor no sugerir a nadie
        return self.db.crear_pendiente(timestamp or ahora_ts(), embedding, modelo or self.config["modelo"],
                                       miniatura, sugerido, float(sim) if sugerido is not None else None,
                                       motivo, disputa_de, asistencia_id)

    # ---------------------------------------------------------- avisos de fallo del kiosko (memoria, TTL 3 min)

    def crear_aviso(self, face: dict, sugerencia: tuple[int | None, float]) -> str:
        """Guarda la captura no reconocida bajo un id aleatorio de un solo uso. No crea pendiente todavía."""
        token = secrets.token_urlsafe(18)
        with self.lock:
            self.avisos[token] = {"t": time.monotonic(), "timestamp": ahora_ts(), "embedding": face["embedding"],
                                  "modelo": self.config["modelo"], "miniatura": face.get("miniatura") or b"",
                                  "sugerencia": sugerencia}
        self.vencer_avisos()
        return token

    def resolver_aviso(self, token: str, tipo: str | None) -> str:
        """tipo None = descartar (el niño reintenta). Retorna 'ok' (resuelto ahora), 'repetido' (ya pasó a pendiente
        hace menos de AVISO_TTL_S, por aviso o por vencimiento: idempotente, no hace nada) o 'no_existe' (inválido,
        descartado o resuelto hace rato)."""
        self.vencer_avisos()
        with self.lock:
            a = self.avisos.pop(token, None) if token else None
            if a is None:
                usado = self.avisos_usados.get(token) if token else None
                return "repetido" if usado and usado[1] == "pendiente" else "no_existe"
            self.avisos_usados[token] = (time.monotonic(), "pendiente" if tipo is not None else "descartado")
        if tipo is not None:
            self._aviso_a_pendiente(a, MOTIVO_AVISO[tipo])
        return "ok"

    def _aviso_a_pendiente(self, a: dict, motivo: str) -> int:
        return self.nuevo_pendiente(a["embedding"], a["miniatura"], a["timestamp"], motivo=motivo,
                                    modelo=a["modelo"], sugerencia=a["sugerencia"])

    def vencer_avisos(self, todos: bool = False) -> int:
        """Purga perezosa (al crear/resolver avisos, en cada consulta del staff a /pendientes* y cada
        INTERVALO_AVISOS_S desde main): lo vencido o lo que excede MAX_AVISOS pasa a pendiente 'abandono'
        (motivo no_reconocido) con la hora de la llegada."""
        ahora = time.monotonic()
        with self.lock:
            if not self.avisos and not self.avisos_usados:
                return 0
            limite = ahora - AVISO_TTL_S
            vencidos = [(k, v) for k, v in self.avisos.items() if todos or v["t"] < limite]
            for k, _ in vencidos:
                del self.avisos[k]
            exceso = len(self.avisos) - MAX_AVISOS
            if exceso > 0:
                for k in sorted(self.avisos, key=lambda k: self.avisos[k]["t"])[:exceso]:
                    vencidos.append((k, self.avisos.pop(k)))
            for k in [k for k, (t, _) in self.avisos_usados.items() if t < limite]:
                del self.avisos_usados[k]
            for k, _ in vencidos:
                self.avisos_usados[k] = (ahora, "pendiente")
        for _, a in vencidos:
            try:
                self._aviso_a_pendiente(a, MOTIVO_AVISO["abandono"])
            except Exception:
                log.exception("[%s] no se pudo guardar una llegada no reconocida", self.slug)
        return len(vencidos)

    # ---------------------------------------------------------- reportes "No soy yo" (solo memoria, TTL 2 min)

    def _podar_reportes(self) -> None:
        limite = time.monotonic() - REPORTE_TTL_S
        for k in [k for k, v in self.reportes.items() if v["t"] < limite]:
            del self.reportes[k]
        while len(self.reportes) > MAX_REPORTES:
            del self.reportes[min(self.reportes, key=lambda k: self.reportes[k]["t"])]

    def crear_reporte(self, face: dict, jugador_id: int, asistencia_id: int | None) -> str:
        token = secrets.token_urlsafe(18)
        with self.lock:
            self._podar_reportes()
            self.reportes[token] = {"t": time.monotonic(), "timestamp": ahora_ts(), "embedding": face["embedding"],
                                    "modelo": self.config["modelo"], "miniatura": face.get("miniatura") or b"",
                                    "jugador_id": jugador_id, "asistencia_id": asistencia_id}
        return token

    def tomar_reporte(self, token: str) -> dict | None:
        """Un solo uso: se elimina al tomarlo. None si no existe o venció."""
        with self.lock:
            self._podar_reportes()
            return self.reportes.pop(token, None) if token else None


_sedes: dict[str, Sede] = {}
_sedes_lock = threading.Lock()
loop: asyncio.AbstractEventLoop | None = None  # lo fija main.lifespan


def obtener_sede(slug: str | None) -> Sede:
    """Estado de la sede (carga perezosa). SedeNoExiste si el slug es inválido, no existe o está inactiva."""
    info = sedes.obtener(slug)  # valida regex + registro + activa en cada petición
    s = _sedes.get(info["slug"])
    if s is not None:
        s.nombre = info["nombre"]
        return s
    with _sedes_lock:
        s = _sedes.get(info["slug"])
        if s is None:
            s = Sede(info["slug"], info["nombre"])
            _sedes[s.slug] = s
            if loop is not None and loop.is_running():  # sede creada con la API andando: su voz también
                nombres = s.primeros_nombres()
                loop.call_soon_threadsafe(lambda: asyncio.ensure_future(precalentar_voz(nombres)))
    return s


def sede_staff(slug: str = Depends(auth.requerir_staff)) -> Sede:
    """Sede del token. Solo esta sede es accesible para la petición."""
    try:
        return obtener_sede(slug)
    except sedes.SedeNoExiste:
        error(401, "no_autorizado", "Sesión no válida o vencida. Ingresa de nuevo con el PIN.")


def sede_publica(x_sede: str | None = Header(None), sede: str | None = Query(None)) -> Sede:
    """Sede de un endpoint público: header X-Sede, o ?sede=, o DEFAULT_SEDE."""
    slug = (x_sede or sede or sedes.DEFAULT_SEDE).strip()
    try:
        return obtener_sede(slug)
    except sedes.SedeNoExiste:
        error(404, "sede_no_existe", "La sede no existe.")


def precalentar_nombre(nombre: str) -> None:
    """Voz del nombre de pila lista antes de que el niño llegue a la cancha (no bloquea)."""
    if nombre.split():
        try:
            asyncio.get_running_loop().create_task(precalentar_voz([nombre.split()[0]]))
        except RuntimeError:  # llamado desde un hilo del threadpool
            if loop is not None and loop.is_running():
                n = nombre.split()[0]
                loop.call_soon_threadsafe(lambda: asyncio.ensure_future(precalentar_voz([n])))


async def analizar(s: Sede, file: UploadFile, miniatura: bool = False, n_foto: int | None = None,
                   antispoofing: bool = False, rapido: bool = False, publico: bool = False,
                   max_bytes: int | None = None, max_lado: int | None = None,
                   formatos: set[str] | None = None) -> dict:
    await file.seek(0)
    cual = f" en la foto {n_foto}" if n_foto else ""
    extra = {"foto": n_foto} if n_foto else {}
    max_bytes = max_bytes or (MAX_BYTES_IMAGEN if publico else MAX_BYTES_IMAGEN_STAFF)
    max_lado = max_lado or (MAX_LADO_IMAGEN if publico else MAX_LADO_IMAGEN_STAFF)
    # Lectura con tope (un byte de más basta para detectar el exceso sin cargar el archivo entero).
    image_bytes = await file.read(max_bytes + 1)
    if not image_bytes:
        error(400, "imagen_vacia", f"La imagen está vacía{cual}.", **extra)
    if len(image_bytes) > max_bytes:
        error(413, "imagen_pesada", f"La imagen{cual} pesa más de {max_bytes // (1024 * 1024)} MB. Usa una foto más liviana.", **extra)
    try:
        # Solo se lee la cabecera: rechazar una imagen enorme no cuesta decodificarla.
        with Image.open(io.BytesIO(image_bytes)) as im:
            ancho, alto = im.size
            formato = im.format
    except Exception:
        error(400, "imagen_invalida", f"No se pudo leer la imagen{cual}.", **extra)
    if formatos is not None and formato not in formatos:
        error(415, "formato_no_soportado", f"La imagen{cual} debe ser JPG, PNG o WEBP.", **extra)
    if max(ancho, alto) > max_lado:
        error(422, "imagen_grande", f"La imagen{cual} supera {max_lado} px de lado. Usa una foto más pequeña.", **extra)
    try:
        # DeepFace es bloqueante (CPU); se ejecuta fuera del event loop. Usa la configuración de la sede.
        return await run_in_threadpool(cv_engine.analyze_face, image_bytes, miniatura, antispoofing, rapido,
                                       dict(s.config))
    except cv_engine.SpoofError:
        error(422, "foto_falsa", "La cara parece una foto o una pantalla, no una persona.")
    except cv_engine.FaceNotFoundError:
        error(422, "sin_rostro", f"No se detectó ningún rostro{cual}.", **extra)
    except ValueError as exc:
        error(400, "imagen_invalida", f"{str(exc).rstrip('.')}{cual}.", **extra)
    except RuntimeError:
        # El detalle va al log; al cliente solo un mensaje genérico.
        log.exception("Error del motor de reconocimiento")
        error(500, "error_motor", "Error interno del reconocimiento facial. Inténtalo de nuevo.")
