"""Seguimiento del staff: alertas persistentes (3 faltas seguidas -> contactar al apoderado) y revisión de las
asistencias del reconocimiento facial ("Revisar" en Hoy). La lógica y el esquema viven en src/db_alertas.py.

Alertas: se evalúan (idempotente) al pedir GET /alertas, de forma perezosa al pedir /metricas/hoy (máx. 1 vez por
minuto), al marcar una jornada (PUT /jornadas/{fecha}) y en la tarea horaria. Umbral por sede: `umbral_faltas` en el
config.json de la sede (por defecto 3). Revisión: "seguro" = similitud >= umbral automático + MARGEN_REVISION.
"""

import sqlite3
import time

from fastapi import APIRouter, Depends, Form, Query

from api.nucleo import Sede, error, sede_staff
from src.reportes import UMBRAL_AUSENCIAS

router = APIRouter()

# Por debajo de umbral automático + este margen, una asistencia aceptada se muestra en "Revisar".
MARGEN_REVISION = 0.05
EVALUAR_CADA_S = 60
UMBRAL_FALTAS_MAX = 30


def umbral_faltas(s: Sede) -> int:
    try:
        n = int(s.config.get("umbral_faltas", UMBRAL_AUSENCIAS))
    except (TypeError, ValueError):
        n = UMBRAL_AUSENCIAS
    return min(max(n, 1), UMBRAL_FALTAS_MAX)


def limite_revision(s: Sede) -> float:
    return round(s.umbral_auto() + MARGEN_REVISION, 4)


def evaluar_alertas(s: Sede, forzar: bool = False) -> None:
    """Evaluación perezosa (con tope de frecuencia salvo `forzar`). Un fallo nunca rompe la petición que la llama."""
    ahora = time.monotonic()
    if not forzar and ahora - getattr(s, "_alertas_evaluadas", -EVALUAR_CADA_S) < EVALUAR_CADA_S:
        return
    s._alertas_evaluadas = ahora
    try:
        s.db.evaluar_alertas(umbral_faltas(s))
    except sqlite3.Error as exc:
        print(f"[alertas:{s.slug}] error al evaluar: {exc}")


# ---------------------------------------------------------------- alertas

@router.get("/alertas")
def listar_alertas(cerradas: bool = Query(False), s: Sede = Depends(sede_staff)):
    """Alertas abiertas (nueva | vista | contactada; con `cerradas=true` también las cerradas, las últimas 500):
    [{id, jugador_id, nombre, categoria, tipo, valor (n faltas), estado, nota, creada_en, actualizada_por/en,
    ultima_asistencia, contacto: {tutor, correo, telefono, otro} | null}] + umbral. `contacto.correo/telefono` solo
    existen si la sede ya guarda el contacto del apoderado en `jugadores`; `otro` = contacto del consentimiento."""
    evaluar_alertas(s, forzar=True)
    return {"umbral": umbral_faltas(s), "alertas": s.db.listar_alertas(incluir_cerradas=cerradas)}


@router.get("/alertas/resumen")
def resumen_alertas(s: Sede = Depends(sede_staff)):
    """Conteo barato para el globo de la navegación: {abiertas, por_contactar (nueva + vista)}."""
    evaluar_alertas(s)
    return s.db.contar_alertas()


@router.patch("/alertas/{alerta_id}")
def actualizar_alerta(alerta_id: int, estado: str | None = Form(None), nota: str | None = Form(None),
                      s: Sede = Depends(sede_staff)):
    """El staff cambia el estado (nueva | vista | contactada | cerrada) y/o la nota. Cerrarla a mano no la vuelve a
    crear hasta que el niño asista y acumule una racha nueva."""
    if estado is None and nota is None:
        error(400, "sin_cambios", "Indica estado o nota.")
    try:
        a = s.db.actualizar_alerta(alerta_id, estado, nota)
    except ValueError:
        error(400, "estado_invalido", "Estado inválido (nueva, vista, contactada o cerrada).")
    except sqlite3.IntegrityError:
        error(409, "ya_abierta", "Este niño ya tiene otra alerta abierta.")
    if a is None:
        error(404, "no_existe", "La alerta no existe.")
    s.db.auditar("alerta", f"alerta #{alerta_id} -> {a['estado']}{' (nota)' if nota is not None else ''}")
    return a


# ---------------------------------------------------------------- revisión de asistencias faciales

@router.get("/revision/hoy")
def revision_hoy(s: Sede = Depends(sede_staff)):
    """{fecha, limite, total, revisados, seguros_sin_revisar, por_revisar: [{asistencia_id, jugador_id, nombre,
    categoria, timestamp, similitud}]}: asistencias faciales de hoy; `por_revisar` = similitud < limite sin revisar."""
    return s.db.revision_hoy(limite_revision(s))


@router.post("/revision/confirmar-seguros")
def confirmar_seguros(s: Sede = Depends(sede_staff)):
    """Confirma de un toque las asistencias faciales de hoy sin revisar con similitud >= limite."""
    n = s.db.confirmar_seguros(limite_revision(s))
    if n:
        s.db.auditar("revision_lote", f"{n} asistencias confirmadas")
    return {"status": "success", "confirmadas": n}


@router.post("/revision/{asistencia_id}")
def revisar_asistencia(asistencia_id: int, accion: str = Form(...), s: Sede = Depends(sede_staff)):
    """accion=confirmar: el staff confirma que era él. accion=no_es: no era él -> la asistencia se anula (luego el
    staff marca al niño correcto con /asistencia/manual)."""
    mapa = {"confirmar": "confirmado", "no_es": "no_es"}
    if accion not in mapa:
        error(400, "accion_invalida", "Acción inválida (confirmar o no_es).")
    r = s.db.revisar_asistencia(asistencia_id, mapa[accion])
    if r == "no_existe":
        error(404, "no_existe", "La asistencia no existe.")
    if r == "no_valida":
        error(409, "no_valida", "La asistencia ya fue anulada o está en disputa.")
    s.db.auditar("revision", f"asistencia #{asistencia_id} -> {mapa[accion]}")
    if accion == "no_es":
        evaluar_alertas(s, forzar=True)
    return {"status": "success", "id": asistencia_id, "accion": accion}
