"""Autenticación del staff: PIN de la sede -> token firmado (HMAC) con vencimiento y claim `sede`. Sin dependencias extra.

Cada sede tiene su PIN (hash PBKDF2 en data/control.db). STAFF_PIN solo se usa como PIN inicial de la sede
migrada/por defecto al crearla; después manda el hash guardado (cámbialo con scripts/crear_sede.py)."""

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from collections import defaultdict, deque

from fastapi import Header, HTTPException, Request

from src import sedes

STAFF_PIN = os.getenv("STAFF_PIN", "1234")
PIN_POR_DEFECTO = "STAFF_PIN" not in os.environ
TOKEN_TTL_S = int(os.getenv("AUTH_TTL_HORAS", "12")) * 3600
# Sin AUTH_SECRET los tokens duran lo que el proceso (al reiniciar la API hay que volver a entrar).
_SECRET = os.getenv("AUTH_SECRET", "").encode() or secrets.token_bytes(32)

VENTANA_S = 300
MAX_FALLOS_POR_CLIENTE = 5
# Límite global alto a propósito: el límite real es por cliente. Uno bajo dejaría que un atacante
# (con IPs distintas) bloquee al staff legítimo; este solo frena ataques distribuidos masivos.
MAX_FALLOS_GLOBAL = 300
TRUST_PROXY = os.getenv("TRUST_PROXY") == "1"
_fallos: dict[str, deque] = defaultdict(deque)
_fallos_global: deque = deque()


def _error(status: int, codigo: str, mensaje: str):
    raise HTTPException(status, detail={"codigo": codigo, "mensaje": mensaje})


def _b64(datos: bytes) -> str:
    return base64.urlsafe_b64encode(datos).rstrip(b"=").decode()


def _firma(carga: str) -> str:
    return _b64(hmac.new(_SECRET, carga.encode(), hashlib.sha256).digest())


def emitir_token(sede: str) -> str:
    carga = _b64(json.dumps({"exp": int(time.time()) + TOKEN_TTL_S, "sede": sede}).encode())
    return f"{carga}.{_firma(carga)}"


def sede_del_token(token: str) -> str | None:
    """Slug de la sede si el token es auténtico, no venció y trae un claim `sede` válido; si no, None."""
    carga, _, firma = token.partition(".")
    if not carga or not hmac.compare_digest(firma, _firma(carga)):
        return None
    try:
        relleno = "=" * (-len(carga) % 4)
        datos = json.loads(base64.urlsafe_b64decode(carga + relleno))
        exp, sede = datos["exp"], datos["sede"]
    except (ValueError, KeyError, TypeError):
        return None
    if not (isinstance(exp, int) and exp > time.time() and isinstance(sede, str) and sedes.slug_valido(sede)):
        return None
    return sede


def token_valido(token: str) -> bool:
    return sede_del_token(token) is not None


def requerir_staff(authorization: str | None = Header(None)) -> str:
    """Dependencia de FastAPI: exige `Authorization: Bearer <token>` y retorna el slug de la sede del token.
    La sede debe seguir existiendo y activa (si se desactiva, sus tokens dejan de servir)."""
    esquema, _, token = (authorization or "").partition(" ")
    sede = sede_del_token(token.strip()) if esquema.lower() == "bearer" else None
    if sede is None or not sedes.existe(sede):
        _error(401, "no_autorizado", "Sesión no válida o vencida. Ingresa de nuevo con el PIN.")
    return sede


def _cliente(request: Request) -> str:
    # Detrás de Next.js + cloudflared el socket siempre es 127.0.0.1: con TRUST_PROXY=1 se usa el
    # primer valor de X-Forwarded-For (el cliente original). Sin TRUST_PROXY se ignora (es falsificable).
    if TRUST_PROXY:
        reenviado = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        if reenviado:
            return reenviado
    return request.client.host if request.client else "?"


def _podar(cola: deque, ahora: float) -> None:
    while cola and cola[0] < ahora - VENTANA_S:
        cola.popleft()


def verificar_pin(pin: str, request: Request, sede: str) -> str:
    """Valida el PIN de la sede con límite de intentos fallidos (por sede + cliente) y retorna un token nuevo."""
    ahora = time.time()
    if not sedes.existe(sede):
        _error(404, "sede_no_existe", "La sede no existe.")
    cliente = f"{sede}|{_cliente(request)}"
    cola = _fallos[cliente]
    _podar(cola, ahora)
    _podar(_fallos_global, ahora)
    if len(cola) >= MAX_FALLOS_POR_CLIENTE or len(_fallos_global) >= MAX_FALLOS_GLOBAL:
        _error(429, "demasiados_intentos", "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.")
    if not sedes.verificar_pin(sede, pin):
        cola.append(ahora)
        _fallos_global.append(ahora)
        _error(401, "pin_incorrecto", "Clave incorrecta. Inténtalo de nuevo.")
    cola.clear()
    return emitir_token(sede)
