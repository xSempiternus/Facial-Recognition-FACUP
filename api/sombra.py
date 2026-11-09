"""Modo SOMBRA de /verify: mide y registra, NUNCA cambia el veredicto (que sigue siendo cv_engine.decidir y, ante
la duda, el staff).

1. Ensemble: si el resultado primario cae en zona gris (ver `zona_gris`), se calcula el modelo sombra (SFace, ~10 ms)
   sobre el MISMO recorte alineado de la sonda y se compara contra las plantillas SFace de la sede (guardadas al
   inscribir). Jugadores inscritos antes de esto no tienen plantilla SFace: para ellos no hay fusión.
2. Cara recortada en el celular (campo `cara` de /verify): embedding del modelo principal con detector skip y su
   puntaje contra el MISMO candidato que eligió el servidor.

Todo corre DESPUÉS de responder (tarea en el threadpool), así que no suma latencia al kiosko; el resultado completa
la fila de verificaciones_log (columnas score_sface, candidato_sface, fusion_score, sface_coincide, score_cliente,
ms_cliente). Un fallo aquí solo se anota en el log del servidor. Apagar: variable de entorno SOMBRA=0.
"""

import asyncio
import io
import logging
import os
import time

from fastapi.concurrency import run_in_threadpool
from PIL import Image
from starlette.datastructures import UploadFile

from src import cv_engine

log = logging.getLogger("uvicorn.error")

ACTIVA = os.getenv("SOMBRA", "1") != "0"
_tareas: set[asyncio.Task] = set()  # referencias fuertes: que el GC no corte una tarea a medias


def zona_gris(res: str, score: float | None, segundo: float | None, umbral_auto: float, umbral_duda: float) -> bool:
    """Dudoso, o margen insuficiente sobre el umbral de duda, o aceptado con score < automático + HOLGURA_SOMBRA."""
    if score is None:
        return False
    if res == "dudoso":
        return True
    if res == "aceptado" and score < umbral_auto + cv_engine.HOLGURA_SOMBRA:
        return True
    return score >= umbral_duda and segundo is not None and score - segundo < cv_engine.MARGEN_MIN


async def leer_cara_cliente(valor) -> bytes | None:
    """Bytes del campo `cara` si cumple el contrato (JPEG, <= CARA_CLIENTE_MAX_BYTES, lados entre
    CARA_CLIENTE_LADO_MIN y CARA_CLIENTE_LADO_MAX). Si no llega o no cumple -> None: se ignora y /verify responde
    igual (la sombra nunca rompe ni cambia la verificación)."""
    if not isinstance(valor, UploadFile):
        return None
    try:
        await valor.seek(0)
        datos = await valor.read(cv_engine.CARA_CLIENTE_MAX_BYTES + 1)
    except Exception:
        return None
    if not datos or len(datos) > cv_engine.CARA_CLIENTE_MAX_BYTES:
        return None
    try:
        with Image.open(io.BytesIO(datos)) as im:
            formato, (ancho, alto) = im.format, im.size
    except Exception:
        return None
    if (formato != "JPEG" or min(ancho, alto) < cv_engine.CARA_CLIENTE_LADO_MIN
            or max(ancho, alto) > cv_engine.CARA_CLIENTE_LADO_MAX):
        return None
    return datos


def calcular(s, verificacion_id: int, modelo: str, umbral_duda: float, mejor_id: int | None,
             score: float | None, recorte, gris: bool, cara_cliente: bytes | None) -> dict:
    """Calcula y guarda las columnas sombra de la fila `verificacion_id`. Retorna lo guardado."""
    campos: dict = {}
    if gris and recorte is not None and mejor_id is not None and modelo != cv_engine.MODELO_SOMBRA:
        try:
            emb = cv_engine.embedding_recorte(recorte, cv_engine.MODELO_SOMBRA)
            puntajes = s.puntajes_por_jugador(emb, cv_engine.MODELO_SOMBRA)
            if puntajes:
                cand, sc = max(puntajes.items(), key=lambda kv: kv[1])
                campos.update(score_sface=float(sc), candidato_sface=int(cand), sface_coincide=int(cand == mejor_id))
                if mejor_id in puntajes:  # fusión sobre el candidato primario (si tiene plantilla SFace)
                    campos["fusion_score"] = cv_engine.fusion(score, umbral_duda, float(puntajes[mejor_id]))
        except Exception:
            log.exception("[%s] sombra: ensemble falló", s.slug)
    if cara_cliente is not None and mejor_id is not None:
        try:
            t0 = time.perf_counter()
            emb = cv_engine.embedding_cara_cliente(cara_cliente, modelo)
            campos["ms_cliente"] = round((time.perf_counter() - t0) * 1000)
            sc = s.puntajes_por_jugador(emb, modelo).get(mejor_id)
            if sc is not None:
                campos["score_cliente"] = float(sc)
        except Exception:
            log.exception("[%s] sombra: cara del cliente falló", s.slug)
    if campos:
        try:
            s.db.actualizar_sombra(verificacion_id, **campos)
        except Exception:
            log.exception("[%s] sombra: no se pudo guardar", s.slug)
    return campos


def programar(s, verificacion_id: int | None, modelo: str, umbral_duda: float, mejor_id: int | None,
              score: float | None, recorte, gris: bool, cara_cliente: bytes | None) -> None:
    """Lanza `calcular` en el threadpool sin esperar (después de responder). No hace nada si no hay qué medir."""
    if not ACTIVA or not verificacion_id or mejor_id is None or not (gris or cara_cliente):
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    tarea = loop.create_task(run_in_threadpool(calcular, s, verificacion_id, modelo, umbral_duda, mejor_id,
                                               score, recorte, gris, cara_cliente))
    _tareas.add(tarea)
    tarea.add_done_callback(_tareas.discard)
