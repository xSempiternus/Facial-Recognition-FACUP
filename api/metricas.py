"""Métricas del panel del staff (solo lectura). La lógica de consulta vive en src/metricas.py."""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from fastapi.concurrency import run_in_threadpool

from api.nucleo import Sede, error, sede_staff
from src import cv_engine, metricas

router = APIRouter(prefix="/metricas")


def _fecha(valor: str, campo: str) -> date:
    try:
        return date.fromisoformat(valor)
    except ValueError:
        error(400, "fecha_invalida", f"{campo} debe tener formato AAAA-MM-DD.")


def _categoria(s: Sede, categoria: str | None) -> str | None:
    if not (categoria or "").strip():
        return None
    nombre = " ".join(categoria.split())
    for c in s.db.listar_categorias():
        if c["nombre"].lower() == nombre.lower():
            return c["nombre"]
    error(404, "categoria_no_existe", f"La categoría «{nombre}» no existe en esta sede.")


@router.get("/hoy")
async def metricas_hoy(categoria: str | None = None, s: Sede = Depends(sede_staff)):
    cat = _categoria(s, categoria)
    return await run_in_threadpool(metricas.hoy, s.db, cat)


@router.get("/reconocimiento")
async def metricas_reconocimiento(dias: int = Query(30, ge=1, le=metricas.DIAS_RECONOCIMIENTO_MAX),
                                  s: Sede = Depends(sede_staff)):
    """Calibración: puntajes de /verify de los últimos `dias` días (aceptados / dudosos / rechazados, histograma por
    tramos de 0.05, margen mediano y una sugerencia simple). Sin biometría ni nombres."""
    await run_in_threadpool(s.db.purgar_verificaciones)
    return await run_in_threadpool(metricas.reconocimiento, s.db, dias, s.umbral_auto(), s.umbral_duda(),
                                   cv_engine.MARGEN_MIN)


@router.get("/resumen")
async def metricas_resumen(desde: str | None = None, hasta: str | None = None, categoria: str | None = None,
                           s: Sede = Depends(sede_staff)):
    h = _fecha(hasta, "hasta") if hasta else date.today()
    d = _fecha(desde, "desde") if desde else h - timedelta(days=metricas.DIAS_DEFECTO - 1)
    if d > h:
        error(400, "rango_invalido", "La fecha inicial es posterior a la final.")
    if (h - d).days + 1 > metricas.MAX_DIAS:
        error(400, "rango_largo", f"El rango máximo es de {metricas.MAX_DIAS} días.")
    cat = _categoria(s, categoria)
    return await run_in_threadpool(metricas.resumen, s.db, d.isoformat(), h.isoformat(), cat)
