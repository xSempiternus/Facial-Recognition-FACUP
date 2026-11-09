"""Invitados que podrían ser el mismo niño de una solicitud ("¿Vino a probarse antes?").

Puro y sin I/O: recibe los invitados ya listados. Solo propone a quien se parece en el NOMBRE (tildes y
mayúsculas no cuentan; tolera una letra de diferencia y apellidos abreviados). Si ambos tienen categoría y es
distinta, no se propone. Pesa más la misma categoría y que el invitado sea reciente (<= 30 días).
"""

import unicodedata
from datetime import datetime

MAX_CANDIDATOS = 3
DIAS_RECIENTE = 30


def _tokens(nombre: str) -> list[str]:
    s = unicodedata.normalize("NFD", nombre or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return ["".join(c for c in t if c.isalnum()) for t in s.split() if any(c.isalnum() for c in t)]


def _distancia(a: str, b: str, tope: int) -> int:
    """Levenshtein con corte: devuelve tope+1 si supera `tope`."""
    if abs(len(a) - len(b)) > tope:
        return tope + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > tope:
            return tope + 1
        prev = cur
    return prev[-1]


def _peso_token(a: str, b: str) -> float:
    if a == b:
        return 1.0
    corto, largo = (a, b) if len(a) <= len(b) else (b, a)
    if len(corto) == 1:  # inicial: "P." ~ "Pérez"
        return 0.6 if largo.startswith(corto) else 0.0
    if len(corto) >= 3 and largo.startswith(corto):
        return 0.9
    if len(corto) >= 4 and _distancia(a, b, 1) <= 1:
        return 0.8
    if len(corto) >= 7 and _distancia(a, b, 2) <= 2:
        return 0.7
    return 0.0


def parecido_nombre(a: str, b: str) -> float:
    """0..1: cuánto del nombre más corto aparece en el otro (cada palabra se usa una sola vez)."""
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    if len(ta) > len(tb):
        ta, tb = tb, ta
    libres, total = list(tb), 0.0
    for t in ta:
        mejor, k = 0.0, -1
        for i, u in enumerate(libres):
            p = _peso_token(t, u)
            if p > mejor:
                mejor, k = p, i
        if k >= 0:
            total += mejor
            libres.pop(k)
    return total / len(ta)


def _dias(creado_en: str | None, ahora: datetime) -> int | None:
    try:
        return (ahora - datetime.fromisoformat((creado_en or "")[:19])).days
    except ValueError:
        return None


def candidatos_invitado(nombre: str, categoria: str | None, invitados: list[dict], ahora: datetime | None = None) -> list[dict]:
    """`invitados`: filas de list_jugadores con estado 'invitado'. Devuelve hasta 3 candidatos, el mejor primero."""
    ahora = ahora or datetime.now()
    puntuados = []
    for j in invitados:
        cat_j = j.get("categoria")
        if categoria and cat_j and categoria != cat_j:
            continue
        base = parecido_nombre(nombre, j["nombre"])
        misma = bool(categoria and cat_j and categoria == cat_j)
        if base < 0.75 and not (base >= 0.5 and misma):
            continue
        dias = _dias(j.get("creado_en"), ahora)
        reciente = dias is not None and dias <= DIAS_RECIENTE
        puntuados.append((base + (0.15 if misma else 0) + (0.1 if reciente else 0), j))
    puntuados.sort(key=lambda x: (-x[0], x[1]["nombre"]))
    return [{"id": j["id"], "nombre": j["nombre"], "categoria": j.get("categoria"), "creado_en": j.get("creado_en"),
             "asistencias": j.get("asistencias", 0), "ultima_asistencia": j.get("ultima_asistencia")}
            for _, j in puntuados[:MAX_CANDIDATOS]]
