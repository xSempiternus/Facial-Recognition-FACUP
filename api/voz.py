"""Voz para el kiosko. Principal: Gemini TTS (natural, con estilo dirigible) si hay GEMINI_API_KEY; si no existe
o falla, edge-tts (voces es-CL de Microsoft). Las frases salen de plantillas fijas: el endpoint es público y no
debe poder sintetizar texto arbitrario. Cada frase se guarda en data/voz/."""

import asyncio
import base64
import logging
import hashlib
import os
import re
import time
from collections import defaultdict, deque
from pathlib import Path

import edge_tts
import requests
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from api.auth import _cliente

VOZ = os.getenv("VOZ_TTS", "es-CL-CatalinaNeural")
RITMO = os.getenv("VOZ_RITMO", "+0%")
TONO = os.getenv("VOZ_TONO", "+0Hz")
GEMINI_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODELO = os.getenv("GEMINI_TTS_MODELO", "gemini-3.8-flash-tts")
GEMINI_VOZ = os.getenv("GEMINI_VOZ", "Fenrir")
GEMINI_ESTILO = os.getenv(
    "GEMINI_ESTILO",
    "con acento chileno, tono cálido, alegre y cercano, como un entrenador que recibe a un niño; natural y sin exagerar",
)
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
CARPETA = Path(__file__).resolve().parent.parent / "data" / "voz"

# tipo -> plantilla ({n} = primer nombre del jugador, solo letras)
FRASES = {
    "hola": "¡Hola, {n}! ¡A jugar!",
    "de_nuevo": "¡Hola de nuevo, {n}!",
    "sin_cara": "No detectamos tu cara. Prueba otra vez.",
    "foto": "Usa tu cara, no una foto.",
    "no_reconocido": "No te reconocimos. Intenta de nuevo o avisa a tu entrenador.",
}
_NOMBRE = re.compile(r"^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' -]{1,30}$")

_gemini_hasta = 0.0  # instante (monotonic) hasta el que no se vuelve a llamar a Gemini (cuota agotada)


def _gemini(texto: str) -> bytes:
    global _gemini_hasta
    cuerpo = {
        "model": GEMINI_MODELO,
        "input": [{"type": "user_input", "content": [{
            "type": "text", "text": texto,
            "annotations": [{"type": "speech_metadata", "style": GEMINI_ESTILO}],
        }]}],
        "response_format": {"type": "audio"},
        "generation_config": {"speech_config": [{"voice": GEMINI_VOZ}]},
    }
    if time.monotonic() < _gemini_hasta:
        raise RuntimeError("Gemini en enfriamiento por cuota")
    r = requests.post(GEMINI_URL, json=cuerpo, headers={"x-goog-api-key": GEMINI_KEY}, timeout=15)
    if r.status_code == 429:
        try:
            espera = int(r.headers.get("Retry-After", "300"))
        except ValueError:
            espera = 300
        _gemini_hasta = time.monotonic() + min(espera, 3600)  # no se insiste: se usa la voz de respaldo
    r.raise_for_status()
    for paso in reversed(r.json().get("steps", [])):
        if paso.get("type") == "model_output":
            for c in reversed(paso.get("content", [])):
                if c.get("type") == "audio" and c.get("data"):
                    return base64.b64decode(c["data"])
    raise RuntimeError("Gemini no devolvió audio")


log = logging.getLogger("uvicorn.error")
router = APIRouter()
_llamadas: dict[str, deque] = defaultdict(deque)
_bloqueo = asyncio.Lock()


def _limitar(cliente: str) -> None:
    ahora, cola = time.monotonic(), _llamadas[cliente]
    while cola and ahora - cola[0] > 60:
        cola.popleft()
    if len(cola) >= 40:
        raise HTTPException(429, "Demasiadas solicitudes de voz.")
    cola.append(ahora)


@router.get("/voz")
async def voz(request: Request, tipo: str, nombre: str = ""):
    plantilla = FRASES.get(tipo)
    if not plantilla:
        raise HTTPException(400, "Tipo de frase no válido.")
    nombre = nombre.strip()
    if "{n}" in plantilla:
        if not _NOMBRE.match(nombre):
            raise HTTPException(400, "Nombre no válido.")
        texto = plantilla.format(n=nombre.title())
    else:
        texto = plantilla
    usa_gemini = bool(GEMINI_KEY)
    motor = f"gemini|{GEMINI_MODELO}|{GEMINI_VOZ}|{GEMINI_ESTILO}" if usa_gemini else f"edge|{VOZ}|{RITMO}|{TONO}"
    clave = hashlib.sha1(f"{motor}|{texto}".encode()).hexdigest()[:24]
    archivo = next(iter(CARPETA.glob(f"{clave}.*")), None) if CARPETA.exists() else None
    if archivo is None and usa_gemini and time.monotonic() < _gemini_hasta and CARPETA.exists():
        archivo = next(iter(CARPETA.glob(f"{clave}_edge.*")), None)  # Gemini sin cuota: reutiliza el respaldo ya generado
    if archivo is None:
        _limitar(_cliente(request))
        CARPETA.mkdir(parents=True, exist_ok=True)
        async with _bloqueo:
            archivo = next(iter(CARPETA.glob(f"{clave}.*")), None)
            if archivo is None:
                archivo = await _generar(texto, clave, usa_gemini)
    tipo_mime = "audio/wav" if archivo.suffix == ".wav" else "audio/mpeg"
    return FileResponse(archivo, media_type=tipo_mime, headers={"Cache-Control": "public, max-age=86400"})


async def _generar(texto: str, clave: str, usa_gemini: bool) -> Path:
    if usa_gemini:
        try:
            datos = await asyncio.to_thread(_gemini, texto)
            destino = CARPETA / f"{clave}.wav"
            destino.write_bytes(datos)
            return destino
        except Exception as e:  # sin cuota, sin red, modelo cambiado: se cae a edge-tts
            log.warning("Gemini TTS falló (%s); uso edge-tts", e)
    # Sin cache propio del motor de respaldo: se guarda con otra clave para no hacerse pasar por Gemini.
    destino = CARPETA / (clave + ("_edge" if usa_gemini else "") + ".mp3")
    tmp = destino.with_suffix(".tmp")
    try:
        await asyncio.wait_for(edge_tts.Communicate(texto, VOZ, rate=RITMO, pitch=TONO).save(str(tmp)), timeout=10)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise HTTPException(503, "Voz no disponible.")
    tmp.replace(destino)
    return destino


def _ruta_cache(texto: str) -> Path | None:
    motor = f"gemini|{GEMINI_MODELO}|{GEMINI_VOZ}|{GEMINI_ESTILO}"
    clave = hashlib.sha1(f"{motor}|{texto}".encode()).hexdigest()[:24]
    return next(iter(CARPETA.glob(f"{clave}.*")), None) if CARPETA.exists() else None


async def precalentar(nombres: list[str]) -> None:
    """Genera con Gemini (y deja en cache) las frases de los jugadores, para que en la cancha no haya espera ni
    dependa de la cuota. Va en segundo plano, espaciado, y se detiene si la cuota se agota."""
    if not GEMINI_KEY:
        return
    pendientes = [FRASES["hola"].format(n=n.title()) for n in nombres if _NOMBRE.match(n)]
    pendientes += [FRASES["de_nuevo"].format(n=n.title()) for n in nombres if _NOMBRE.match(n)]
    pendientes += [t for t in FRASES.values() if "{n}" not in t]
    CARPETA.mkdir(parents=True, exist_ok=True)
    for texto in pendientes:
        if _ruta_cache(texto):
            continue
        try:
            datos = await asyncio.to_thread(_gemini, texto)
        except Exception as e:
            log.warning("Precalentado de voz detenido: %s", e)
            return
        clave = hashlib.sha1(f"gemini|{GEMINI_MODELO}|{GEMINI_VOZ}|{GEMINI_ESTILO}|{texto}".encode()).hexdigest()[:24]
        (CARPETA / f"{clave}.wav").write_bytes(datos)
        await asyncio.sleep(7)
