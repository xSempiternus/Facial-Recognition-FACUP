"""Límites de frecuencia en memoria (ventana deslizante) para endpoints públicos.

Cada límite se puede ajustar por variable de entorno con formato "N/segundos", p. ej. RL_INSCRIPCION_IP="6/3600".
"""

import os
import threading
import time
from collections import deque

from api.nucleo import error

MAX_CLAVES = 10_000


def _desde_env(nombre: str, maximo: int, ventana_s: int) -> tuple[int, int]:
    valor = os.getenv(nombre, "")
    try:
        n, _, s = valor.partition("/")
        return int(n), int(s)
    except ValueError:
        return maximo, ventana_s


class Limitador:
    def __init__(self, nombre_env: str, maximo: int, ventana_s: int):
        self.maximo, self.ventana_s = _desde_env(nombre_env, maximo, ventana_s)
        self._colas: dict[str, deque] = {}
        self._lock = threading.Lock()

    def permitir(self, clave: str) -> bool:
        """Cuenta el intento y dice si está dentro del límite."""
        ahora = time.monotonic()
        with self._lock:
            if len(self._colas) > MAX_CLAVES:  # poda de claves inactivas (memoria acotada)
                for k in [k for k, c in self._colas.items() if not c or c[-1] < ahora - self.ventana_s]:
                    del self._colas[k]
            cola = self._colas.setdefault(clave, deque())
            while cola and cola[0] < ahora - self.ventana_s:
                cola.popleft()
            if len(cola) >= self.maximo:
                return False
            cola.append(ahora)
            return True

    def exigir(self, clave: str) -> None:
        if not self.permitir(clave):
            error(429, "demasiados_intentos", "Demasiados intentos. Espera un rato e inténtalo de nuevo.")


# Inscripción pública por los padres (un enlace se comparte con todo un equipo: el límite por token es más alto).
INSCRIPCION_IP = Limitador("RL_INSCRIPCION_IP", 6, 3600)
INSCRIPCION_TOKEN = Limitador("RL_INSCRIPCION_TOKEN", 40, 3600)
INFO_IP = Limitador("RL_INFO_IP", 60, 600)
# "No soy yo": estricto (por IP y por sede).
NO_SOY_YO_IP = Limitador("RL_NO_SOY_YO_IP", 3, 600)
NO_SOY_YO_SEDE = Limitador("RL_NO_SOY_YO_SEDE", 30, 600)
