"""Autenticación del staff: PIN -> token firmado (HMAC) con vencimiento. Sin dependencias extra."""

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from collections import defaultdict, deque

from fastapi import Header, HTTPException, Request

STAFF_PIN = os.getenv("STAFF_PIN", "1234")
PIN_POR_DEFECTO = "STAFF_PIN" not in os.environ
TOKEN_TTL_S = int(os.getenv("AUTH_TTL_HORAS", "12")) * 3600
# Sin AUTH_SECRET los tokens duran lo que el proceso (al reiniciar la API hay que volver a entrar).
_SECRET = os.getenv("AUTH_SECRET", "").encode() or secrets.token_bytes(32)

VENTANA_S = 300
MAX_FALLOS_POR_CLIENTE = 5
MAX_FALLOS_GLOBAL = 30
_fallos: dict[str, deque] = defaultdict(deque)
_fallos_global: deque = deque()


def _error(status: int, codigo: str, mensaje: str):
    raise HTTPException(status, detail={"codigo": codigo, "mensaje": mensaje})


def _b64(datos: bytes) -> str:
    return base64.urlsafe_b64encode(datos).rstrip(b"=").decode()


def _firma(carga: str) -> str:
    return _b64(hmac.new(_SECRET, carga.encode(), hashlib.sha256).digest())


def emitir_token() -> str:
    carga = _b64(json.dumps({"exp": int(time.time()) + TOKEN_TTL_S}).encode())
    return f"{carga}.{_firma(carga)}"


def token_valido(token: str) -> bool:
    carga, _, firma = token.partition(".")
    if not carga or not hmac.compare_digest(firma, _firma(carga)):
        return False
    try:
        relleno = "=" * (-len(carga) % 4)
        exp = json.loads(base64.urlsafe_b64decode(carga + relleno))["exp"]
    except (ValueError, KeyError, TypeError):
        return False
    return isinstance(exp, int) and exp > time.time()


def requerir_staff(authorization: str | None = Header(None)) -> None:
    """Dependencia de FastAPI: exige `Authorization: Bearer <token>`."""
    esquema, _, token = (authorization or "").partition(" ")
    if esquema.lower() != "bearer" or not token_valido(token.strip()):
        _error(401, "no_autorizado", "Sesión no válida o vencida. Ingresa de nuevo con el PIN.")


def _cliente(request: Request) -> str:
    reenviado = request.headers.get("x-forwarded-for", "")
    return reenviado.split(",")[0].strip() or (request.client.host if request.client else "?")


def _podar(cola: deque, ahora: float) -> None:
    while cola and cola[0] < ahora - VENTANA_S:
        cola.popleft()


def verificar_pin(pin: str, request: Request) -> str:
    """Valida el PIN con límite de intentos fallidos y retorna un token nuevo."""
    ahora = time.time()
    cliente = _cliente(request)
    cola = _fallos[cliente]
    _podar(cola, ahora)
    _podar(_fallos_global, ahora)
    if len(cola) >= MAX_FALLOS_POR_CLIENTE or len(_fallos_global) >= MAX_FALLOS_GLOBAL:
        _error(429, "demasiados_intentos", "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.")
    if not hmac.compare_digest(pin.encode(), STAFF_PIN.encode()):
        cola.append(ahora)
        _fallos_global.append(ahora)
        _error(401, "pin_incorrecto", "PIN incorrecto. Inténtalo de nuevo.")
    cola.clear()
    return emitir_token()
