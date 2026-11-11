"""Reglas sobre las plantillas (embeddings) de cada jugador: puntuación robusta frente a "hubs", aprendizaje por
corrección del staff y pares de jugadores parecidos. Solo numpy (sin DeepFace): lo usan la API, el script
scripts/reparar_plantillas.py y las pruebas.

Orígenes de una plantilla (tabla fotos.origen):
  - 'inscripcion' / 'nueva_foto': fotos que el staff o la familia tomaron a propósito (BASE, confiables);
  - 'correccion': captura del kiosko que el staff asignó a mano a un jugador (APRENDIDA, puede venir de un error).

Por qué hace falta (caso real, sede las-condes, nov-2026): un jugador con 1 foto base + 8 'correccion' (varias de
otras personas, aprendidas en cadena con la regla antigua "umbral - 0.25 contra cualquier plantilla propia")
atraía a cualquier desconocido: sondas ajenas puntuaban 0.32-0.43 contra él y una se aceptó con 0.4295.
"""

import os

import numpy as np


def _float_env(nombre: str, defecto: float) -> float:
    try:
        return float(os.getenv(nombre, defecto))
    except ValueError:
        return defecto


def _int_env(nombre: str, defecto: int) -> int:
    try:
        return int(os.getenv(nombre, defecto))
    except ValueError:
        return defecto


ORIGEN_BASE = "inscripcion"
ORIGENES_APRENDIDOS = frozenset({"correccion"})

# ---- Puntuación robusta (efecto hub).
# puntaje(jugador) = max( max_coseno(plantillas BASE), PESO_APRENDIDA * max_coseno(plantillas APRENDIDAS) ).
# Justificación: con la regla "máximo sobre N plantillas", cada plantilla extra es un "boleto" más para un impostor;
# el máximo de N similitudes de impostor crece ~ sigma*sqrt(2 ln N). Con sigma ~0.07 (GhostFaceNet, impostores),
# pasar de 3 a 9 plantillas sube el máximo esperado ~0.07*(sqrt(2 ln 9) - sqrt(2 ln 3)) ~ 0.043, que es justo lo que
# quita x0.9 a una similitud de ~0.43. Para jugadores con solo fotos BASE (el caso normal: 3 de inscripción) el
# puntaje es EXACTAMENTE el de siempre (Nicolas 0.709, Marcia 0.6003, Maia 0.6863 no cambian), así que los umbrales
# actuales siguen siendo comparables. Un genuino contra su plantilla aprendida (0.65) sigue muy por encima del
# umbral (0.585). Se descartó "0.7*max + 0.3*media top-2": baja TODOS los puntajes (rompe la comparabilidad) y casi
# no castiga a un hub con muchas plantillas parecidas entre sí.
PESO_APRENDIDA = _float_env("PESO_PLANTILLA_APRENDIDA", 0.9)

# ---- Aprendizaje por corrección del staff (al asignar un pendiente a un jugador).
# Se aprende (se agrega la captura como plantilla 'correccion') SOLO si:
#   1. el pendiente no fue un RECHAZADO de baja calidad (parecido 'bajo');
#   2. la sonda puntúa contra las fotos BASE del jugador >= umbral_duda (antes: umbral - 0.25 contra cualquier
#      plantilla propia, lo que permitía aprender en cadena caras de otros);
#   3. el jugador es el MEJOR candidato de la sonda con margen >= MARGEN_MIN sobre el segundo jugador distinto;
#   4. la sonda no es casi un duplicado de una plantilla que ya tiene (coseno > UMBRAL_CASI_DUPLICADO: no aporta).
# Tope: MAX_APRENDIDAS plantillas 'correccion' por jugador y modelo; al excederlo se reemplaza la MÁS ANTIGUA
# (los niños cambian durante la temporada y todas pasaron ya la regla estricta). Nunca se tocan las BASE.
UMBRAL_CASI_DUPLICADO = _float_env("UMBRAL_CASI_DUPLICADO", 0.92)
MAX_APRENDIDAS = max(0, _int_env("MAX_PLANTILLAS_APRENDIDAS", 4))

# ---- Pares cercanos (dos jugadores que se parecen entre sí).
# Al inscribir: si la mejor similitud (máximo entre fotos BASE) con otro jugador es >= umbral_duda - OFFSET_PAR_CERCANO
# (0.37 - 0.07 = 0.30 con la config actual de GhostFaceNet) se avisa al staff y se guarda el par. En /verify, si el
# mejor y el segundo candidato forman un par cercano y el puntaje no supera umbral_auto + MARGEN_PAR_CERCANO
# (0.42 + 0.10 = 0.52), el veredicto es DUDOSO (decide el staff) aunque haya margen.
OFFSET_PAR_CERCANO = _float_env("OFFSET_PAR_CERCANO", 0.07)
MARGEN_PAR_CERCANO = _float_env("MARGEN_PAR_CERCANO", 0.10)


class Plantilla(tuple):
    """(modelo, embedding) con el atributo `origen`. Se desempaqueta como una tupla de 2 (`for m, e in ...`), así
    que el resto del código no cambia; una tupla común se trata como BASE."""

    def __new__(cls, modelo: str, embedding, origen: str = ORIGEN_BASE):
        obj = super().__new__(cls, (modelo, embedding))
        obj.origen = origen
        return obj


def origen_de(p) -> str:
    return getattr(p, "origen", ORIGEN_BASE)


def es_aprendida(p) -> bool:
    return origen_de(p) in ORIGENES_APRENDIDOS


def peso(p) -> float:
    return PESO_APRENDIDA if es_aprendida(p) else 1.0


def umbral_par_cercano(umbral_duda: float) -> float:
    return round(umbral_duda - OFFSET_PAR_CERCANO, 4)


def _unit(e) -> np.ndarray:
    v = np.asarray(e, dtype=np.float32)
    n = float(np.linalg.norm(v))
    return v / n if n else v


def coseno_max(sonda, embeddings) -> float | None:
    """Máxima similitud del coseno entre `sonda` y una lista de embeddings (None si la lista está vacía)."""
    if not embeddings:
        return None
    m = np.asarray([_unit(e) for e in embeddings], dtype=np.float32)
    return float((m @ _unit(sonda)).max())


def puntaje_jugador(sonda, plantillas: list) -> float | None:
    """Puntaje robusto de una sonda contra las plantillas (Plantilla o tuplas) de UN jugador y UN modelo."""
    base = [e for p in plantillas for e in [p[1]] if not es_aprendida(p)]
    apr = [e for p in plantillas for e in [p[1]] if es_aprendida(p)]
    sb, sa = coseno_max(sonda, base), coseno_max(sonda, apr)
    candidatos = [x for x in (sb, None if sa is None else PESO_APRENDIDA * sa) if x is not None]
    return max(candidatos) if candidatos else None


def puntajes(sonda, por_jugador: dict[int, list]) -> dict[int, float]:
    """{jugador_id: puntaje robusto}. `por_jugador` {id: [Plantilla del modelo vigente]}."""
    salida = {}
    for jid, ps in por_jugador.items():
        s = puntaje_jugador(sonda, ps)
        if s is not None:
            salida[jid] = s
    return salida


def evaluar_aprendizaje(sonda, objetivo: int, por_jugador: dict[int, list], umbral_duda: float, margen_min: float,
                        parecido: str | None = None) -> tuple[bool, str, dict]:
    """Regla estricta del aprendizaje por corrección. Retorna (aprender, motivo, detalle).
    `por_jugador`: {id: [Plantilla]} del modelo vigente (solo activos). motivo: 'ok' | 'rechazado_bajo' |
    'sin_base' | 'poco_parecido' | 'no_es_el_mejor' | 'sin_margen' | 'casi_duplicado'."""
    propias = por_jugador.get(objetivo) or []
    base = [p[1] for p in propias if not es_aprendida(p)]
    det: dict = {}
    if parecido == "bajo":
        return False, "rechazado_bajo", det
    if not base:
        return False, "sin_base", det
    det["vs_base"] = round(coseno_max(sonda, base), 4)
    if det["vs_base"] < umbral_duda:
        return False, "poco_parecido", det
    pts = puntajes(sonda, por_jugador)
    orden = sorted(pts.items(), key=lambda kv: kv[1], reverse=True)
    mejor_id = orden[0][0] if orden else None
    otros = [s for jid, s in orden if jid != objetivo]
    det["mejor_id"], det["segundo"] = mejor_id, (round(otros[0], 4) if otros else None)
    if mejor_id != objetivo:
        return False, "no_es_el_mejor", det
    if otros and pts[objetivo] - otros[0] < margen_min - 1e-9:
        return False, "sin_margen", det
    det["max_propia"] = round(coseno_max(sonda, [p[1] for p in propias]), 4)
    if det["max_propia"] > UMBRAL_CASI_DUPLICADO:
        return False, "casi_duplicado", det
    return True, "ok", det


MOTIVOS_APRENDIZAJE = {
    "rechazado_bajo": "La captura fue rechazada por baja calidad, así que no se usó para aprender.",
    "sin_base": "El jugador no tiene fotos de inscripción con el modelo actual, así que no se usó para aprender.",
    "poco_parecido": "La foto se parece poco a sus fotos de inscripción (¿mala luz, o era otro niño?), "
                     "así que no se usó para aprender.",
    "no_es_el_mejor": "La foto se parece más a otro niño que a este, así que no se usó para aprender.",
    "sin_margen": "La foto se parece casi igual a otro niño, así que no se usó para aprender.",
    "casi_duplicado": "Ya tiene una foto casi igual: no hacía falta guardarla.",
}


def similitud_entre(a: list, b: list, solo_base: bool = True) -> float | None:
    """Máxima similitud entre plantillas de dos jugadores (por defecto solo las BASE)."""
    ea = [p[1] for p in a if not (solo_base and es_aprendida(p))]
    eb = [p[1] for p in b if not (solo_base and es_aprendida(p))]
    if not ea or not eb:
        return None
    ma = np.asarray([_unit(e) for e in ea], dtype=np.float32)
    mb = np.asarray([_unit(e) for e in eb], dtype=np.float32)
    return float((ma @ mb.T).max())


def parecidos_a(jugador: int, por_jugador: dict[int, list], umbral: float) -> list[tuple[int, float]]:
    """[(otro_id, similitud)] con similitud BASE >= umbral, de mayor a menor."""
    propias = por_jugador.get(jugador) or []
    salida = []
    for jid, ps in por_jugador.items():
        if jid == jugador:
            continue
        s = similitud_entre(propias, ps)
        if s is not None and s >= umbral:
            salida.append((jid, s))
    return sorted(salida, key=lambda x: x[1], reverse=True)


def correccion_dudosa(p, jugador: int, por_jugador: dict[int, list], umbral_duda: float) -> tuple[bool, dict]:
    """Para reparar: una plantilla 'correccion' de `jugador` es dudosa si puntúa < umbral_duda contra las fotos BASE
    de su jugador, o si se parece más a otro jugador (BASE) que a las BASE propias. Retorna (dudosa, detalle)."""
    base = [q[1] for q in por_jugador.get(jugador, []) if not es_aprendida(q)]
    propia = coseno_max(p[1], base)
    otros = {jid: coseno_max(p[1], [q[1] for q in ps if not es_aprendida(q)])
             for jid, ps in por_jugador.items() if jid != jugador}
    otros = {k: v for k, v in otros.items() if v is not None}
    otro_id = max(otros, key=otros.get) if otros else None
    det = {"vs_propia": None if propia is None else round(propia, 4), "otro_id": otro_id,
           "vs_otro": None if otro_id is None else round(otros[otro_id], 4)}
    dudosa = propia is None or propia < umbral_duda or (otro_id is not None and otros[otro_id] >= propia)
    return dudosa, det
