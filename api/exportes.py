"""Exportes de asistencia del staff (Excel y PDF). La lógica vive en src/exportes.py."""

from datetime import date, timedelta

from fastapi import APIRouter, Depends
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from api.limites import Limitador
from api.metricas import _categoria, _fecha
from api.nucleo import Sede, error, sede_staff
from src import exportes, metricas

router = APIRouter(prefix="/exportes")

# Generar un archivo es costoso: tope por sede (ajustable con RL_EXPORTES_SEDE="N/segundos").
LIMITE_SEDE = Limitador("RL_EXPORTES_SEDE", 15, 600)

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _preparar(s: Sede, desde: str | None, hasta: str | None, categoria: str | None, formato: str):
    LIMITE_SEDE.exigir(s.slug)
    h = _fecha(hasta, "hasta") if hasta else date.today()
    d = _fecha(desde, "desde") if desde else h - timedelta(days=metricas.DIAS_DEFECTO - 1)
    if d > h:
        error(400, "rango_invalido", "La fecha inicial es posterior a la final.")
    if (h - d).days + 1 > metricas.MAX_DIAS:
        error(400, "rango_largo", f"El rango máximo es de {metricas.MAX_DIAS} días.")
    return d.isoformat(), h.isoformat(), _categoria(s, categoria)


def _generar_xlsx(s: Sede, d: str, h: str, cat: str | None) -> bytes:
    datos = exportes.datos(s.db, d, h, cat)
    cont = exportes.contactos(s.db, {n["id"] for n in datos["ninos"]})
    return exportes.xlsx(datos, s.nombre, cont)


def _generar_pdf(s: Sede, d: str, h: str, cat: str | None) -> bytes:
    return exportes.pdf(exportes.datos(s.db, d, h, cat), s.nombre)


def _respuesta(s: Sede, contenido: bytes, tipo: str, d: str, h: str, ext: str, cat: str | None) -> Response:
    s.db.auditar("exportar_asistencia", f"exportó asistencia {ext} {d}..{h} categoria={cat or '-'}")
    nombre = exportes.nombre_archivo(s.slug, d, h, ext)
    return Response(contenido, media_type=tipo, headers={
        "Content-Disposition": f'attachment; filename="{nombre}"', "Cache-Control": "no-store"})


@router.get("/asistencia.xlsx")
async def asistencia_xlsx(desde: str | None = None, hasta: str | None = None, categoria: str | None = None,
                          s: Sede = Depends(sede_staff)):
    d, h, cat = _preparar(s, desde, hasta, categoria, "xlsx")
    return _respuesta(s, await run_in_threadpool(_generar_xlsx, s, d, h, cat), XLSX, d, h, "xlsx", cat)


@router.get("/asistencia.pdf")
async def asistencia_pdf(desde: str | None = None, hasta: str | None = None, categoria: str | None = None,
                         s: Sede = Depends(sede_staff)):
    d, h, cat = _preparar(s, desde, hasta, categoria, "pdf")
    return _respuesta(s, await run_in_threadpool(_generar_pdf, s, d, h, cat), "application/pdf", d, h, "pdf", cat)
