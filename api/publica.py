"""Dirección pública de la app (la que usan los apoderados desde su celular), una por instalación.

Prioridad: (1) ajuste guardado por el staff (data/control.db), (2) variable de entorno PUBLIC_URL,
(3) archivo data/url_publica.txt (lo escribe el lanzador cuando abre el túnel). Sin ninguna -> null.
"""

import os
import re
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from api.nucleo import Sede, error, sede_staff
from src import sedes

router = APIRouter(prefix="/config")

_LOCAL = re.compile(r"^(localhost|127\.\d+\.\d+\.\d+)$")


def normalizar(valor: str) -> str:
    """Devuelve el origen normalizado (sin barra final) o lanza ValueError con el motivo."""
    v = (valor or "").strip()
    if not v:
        raise ValueError("Escribe la dirección.")
    try:
        p = urlsplit(v)
        host = p.hostname or ""
        p.port  # noqa: B018 - valida el puerto
    except ValueError:
        raise ValueError("La dirección no es válida.") from None
    if p.scheme not in ("http", "https") or not host:
        raise ValueError("Debe empezar con https:// (ej. https://mi-club.example.com).")
    if p.username or p.password:
        raise ValueError("La dirección no debe llevar usuario ni contraseña.")
    if p.path not in ("", "/") or p.query or p.fragment:
        raise ValueError("Pon solo el dominio, sin ruta (ej. https://mi-club.example.com).")
    if p.scheme == "http" and not _LOCAL.match(host):
        raise ValueError("Debe ser https:// (http solo se acepta en localhost).")
    return f"{p.scheme}://{host}" + (f":{p.port}" if p.port else "")


def _guardado() -> str | None:
    with sedes._control() as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)")
        r = conn.execute("SELECT valor FROM ajustes WHERE clave = 'url_publica'").fetchone()
    return r["valor"] if r else None


def _guardar(valor: str | None) -> None:
    with sedes._control() as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)")
        if valor:
            conn.execute("INSERT INTO ajustes (clave, valor) VALUES ('url_publica', ?) "
                         "ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", (valor,))
        else:
            conn.execute("DELETE FROM ajustes WHERE clave = 'url_publica'")


def resolver() -> dict:
    """{url, origen}: toma la primera fuente válida; las inválidas se ignoran."""
    fuentes = (("ajuste", _guardado),
               ("env", lambda: os.getenv("PUBLIC_URL")),
               ("archivo", lambda: _leer_archivo()))
    for origen, leer in fuentes:
        try:
            v = leer()
            if v:
                return {"url": normalizar(v), "origen": origen}
        except (ValueError, OSError):
            continue
    return {"url": None, "origen": None}


def _leer_archivo() -> str | None:
    f = sedes.DATA_DIR / "url_publica.txt"
    if not f.is_file():
        return None
    lineas = f.read_text(encoding="utf-8-sig", errors="replace").strip().splitlines()
    return lineas[0].strip() if lineas else None


class PublicaIn(BaseModel):
    url: str = ""


@router.get("/publica")
def get_publica(s: Sede = Depends(sede_staff)):
    return resolver()


@router.put("/publica")
def put_publica(d: PublicaIn, s: Sede = Depends(sede_staff)):
    if d.url.strip():
        try:
            _guardar(normalizar(d.url))
        except ValueError as exc:
            error(400, "url_invalida", str(exc))
    else:
        _guardar(None)
    return resolver()
