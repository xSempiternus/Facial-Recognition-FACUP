"""Revisión del staff y correcciones: pendientes del kiosko (persistentes), "No soy yo", invitados, anulación de
asistencias, edición de jugadores y auditoría.

Reglas de las disputas ("No soy yo"): la asistencia creada por ese /verify queda 'disputada' (excluida de reportes y
conteos) y la captura pasa a /pendientes con `disputa_de`. Al resolver:
  - asignar al MISMO jugador reconocido -> la asistencia se restaura (vuelve a 'valida');
  - asignar a OTRO niño -> la disputada se anula y se registra la asistencia del otro niño a esa hora;
  - convertir en invitado -> la disputada se anula y el invitado queda con la asistencia a esa hora;
  - descartar (DELETE) o vencer sin revisión (7 días) -> la disputada se ANULA (nadie confirmó que fuera él;
    si el staff sabe que sí era, puede marcarlo con /asistencia/manual).
Si el /verify era 'ya_registrado', no se toca ninguna asistencia: solo la captura pasa a pendientes.
"""

import base64

from fastapi import APIRouter, Depends, Form, Query, Request

from api import limites
from api.auth import _cliente
from api.nucleo import MARGEN_CORRECCION, Sede, error, precalentar_nombre, sede_publica, sede_staff
from src import cv_engine, db_manager
from src.db_flujos import _SIN_CAMBIO

router = APIRouter()

MAX_NOMBRE = 60


def _nombre_staff(nombre: str) -> str:
    nombre = " ".join((nombre or "").split())
    if not nombre:
        error(400, "sin_nombre", "El nombre es obligatorio.")
    if len(nombre) > MAX_NOMBRE:
        error(400, "nombre_invalido", f"El nombre es demasiado largo (máximo {MAX_NOMBRE}).")
    return nombre


def _categoria(s: Sede, categoria: str) -> str | None:
    try:
        return s.db.resolver_categoria(categoria)
    except db_manager.CategoriaInvalida as exc:
        error(400, "categoria_invalida", str(exc))


def _crear_invitado(s: Sede, nombre: str, cat: str | None, timestamp: str | None, origen_detalle: str) -> int:
    jid = s.db.insert_invitado(nombre, cat)
    s.db.registrar_asistencia(jid, origen="invitado", timestamp=timestamp)
    with s.lock:
        s.jugadores[jid] = {"nombre": nombre, "categoria": cat, "estado": "invitado", "plantillas": []}
    s.db.auditar("crear_invitado", f"jugador #{jid} {origen_detalle}")
    return jid


# ---------------------------------------------------------------- pendientes (persistentes)

@router.get("/pendientes")
def pendientes(s: Sede = Depends(sede_staff)):
    """Llegadas no reconocidas y reportes "No soy yo", de la más reciente a la más antigua."""
    s.db.purgar_pendientes()
    salida = []
    for d in s.db.listar_pendientes():
        sug = s.jugadores.get(d["sugerido_id"]) if d["sugerido_id"] else None
        disp = d["disputa_de_jugador_id"]
        salida.append({
            "id": d["id"],
            "timestamp": d["timestamp"],
            "miniatura": base64.b64encode(d["miniatura"] or b"").decode(),
            "motivo": d["motivo"],
            "sugerido": ({"id": d["sugerido_id"], "nombre": sug["nombre"], "similitud": round(d["similitud"], 4)}
                         if sug else None),
            "disputa_de": ({"id": disp, "nombre": s.jugadores[disp]["nombre"] if disp in s.jugadores else None}
                           if disp else None),
        })
    return salida


def _resolver_disputa(s: Sede, d: dict, jugador_id: int | None) -> str | None:
    """Aplica la regla de la disputa al asignar (jugador_id) o descartar/invitado (None). Retorna lo hecho."""
    disp, aid = d["disputa_de_jugador_id"], d["asistencia_id"]
    if disp is None:
        return None
    if aid and jugador_id == disp:
        s.db.restaurar_asistencia(aid)
        resultado = "confirmada"
    elif aid:
        s.db.anular_asistencia(aid, "no_soy_yo: era otro niño" if jugador_id else "disputa_descartada")
        resultado = "anulada"
    else:
        resultado = "sin_asistencia"
    s.db.auditar("resolver_disputa", f"pendiente #{d['id']} asistencia #{aid or '-'} -> {resultado}")
    return resultado


@router.post("/pendientes/{pendiente_id}/asignar")
def asignar_pendiente(pendiente_id: int, jugador_id: int = Form(...), s: Sede = Depends(sede_staff)):
    """El staff indica quién era: se registra su asistencia (a la hora de la llegada) y, si es un jugador activo y la
    foto se le parece, se suma a sus plantillas. Si el jugador es invitado, solo se registra la asistencia."""
    if s.db.obtener_pendiente(pendiente_id) is None:
        error(404, "no_existe", "Esta llegada ya fue revisada o expiró.")
    if jugador_id not in s.jugadores:
        error(404, "no_existe", "El jugador no existe.")
    d = s.db.tomar_pendiente(pendiente_id)
    if d is None:
        error(404, "no_existe", "Esta llegada ya fue revisada o expiró.")
    foto_guardada, motivo = False, None
    if not s.es_activo(jugador_id):
        motivo = "Es invitado (sin autorización de imagen): solo se registró la asistencia."
    elif d["modelo"] != s.config["modelo"]:
        motivo = "La foto se tomó con otro modelo."
    else:
        propias = s.plantillas_actuales().get(jugador_id, [])
        parecido = max((cv_engine.cosine_similarity(d["embedding"], e) for e in propias), default=None)
        if parecido is None or parecido >= s.umbral() - MARGEN_CORRECCION:
            s.agregar_plantilla(jugador_id, d["embedding"], "correccion")
            foto_guardada = True
        else:
            motivo = ("La foto se parece poco a las que ya tiene (¿mala luz, o era otro niño?), "
                      "así que no se usó para aprender.")
    disputa = _resolver_disputa(s, d, jugador_id)
    ya = s.db.asistio_hoy(jugador_id, d["timestamp"][:10]) is not None
    if not ya:
        s.db.registrar_asistencia(jugador_id, origen="correccion", timestamp=d["timestamp"])
    return {"status": "success", "nombre": s.jugadores[jugador_id]["nombre"], "ya_registrado": ya,
            "foto_guardada": foto_guardada, "motivo": motivo, "disputa": disputa}


@router.delete("/pendientes/{pendiente_id}")
def descartar_pendiente(pendiente_id: int, s: Sede = Depends(sede_staff)):
    d = s.db.tomar_pendiente(pendiente_id)
    if d is None:
        error(404, "no_existe", "Esta llegada ya fue revisada o expiró.")
    disputa = _resolver_disputa(s, d, None)
    return {"status": "success", "disputa": disputa}


@router.post("/pendientes/{pendiente_id}/invitado")
def pendiente_a_invitado(pendiente_id: int, nombre: str = Form(...), categoria: str = Form(""),
                         s: Sede = Depends(sede_staff)):
    """Una llegada no reconocida era un niño nuevo que vino a probarse: se crea como invitado (SIN biometría: la
    captura se descarta) con la asistencia a la hora de la llegada."""
    nombre = _nombre_staff(nombre)
    cat = _categoria(s, categoria)
    d = s.db.tomar_pendiente(pendiente_id)
    if d is None:
        error(404, "no_existe", "Esta llegada ya fue revisada o expiró.")
    disputa = _resolver_disputa(s, d, None)
    jid = _crear_invitado(s, nombre, cat, d["timestamp"], f"desde pendiente #{pendiente_id}")
    precalentar_nombre(nombre)
    return {"status": "success", "id": jid, "nombre": nombre, "categoria": cat, "estado": "invitado",
            "disputa": disputa}


# ---------------------------------------------------------------- "No soy yo" (público)

@router.post("/verify/no-soy-yo")
def no_soy_yo(request: Request, reporte: str = Form(""), s: Sede = Depends(sede_publica)):
    """El niño indica que el kiosko lo confundió. Respuesta siempre genérica (no revela si el reporte era válido)."""
    limites.NO_SOY_YO_IP.exigir(_cliente(request))
    limites.NO_SOY_YO_SEDE.exigir(s.slug)
    r = s.tomar_reporte(reporte.strip()[:64])
    if r is not None and r["modelo"] == s.config["modelo"]:
        aid = r["asistencia_id"]
        disputada = bool(aid) and s.db.marcar_disputada(aid)
        s.nuevo_pendiente(r["embedding"], r["miniatura"], r["timestamp"], motivo="no_soy_yo",
                          disputa_de=r["jugador_id"], asistencia_id=aid if disputada else None)
        s.db.auditar("no_soy_yo", f"jugador #{r['jugador_id']} asistencia #{aid if disputada else '-'}")
    return {"status": "ok"}


# ---------------------------------------------------------------- invitados

@router.post("/invitados")
def crear_invitado(nombre: str = Form(...), categoria: str = Form(""), s: Sede = Depends(sede_staff)):
    """Niño nuevo que viene a probarse: sin biometría, excluido del reconocimiento, con asistencia de hoy."""
    nombre = _nombre_staff(nombre)
    cat = _categoria(s, categoria)
    jid = _crear_invitado(s, nombre, cat, None, "manual")
    precalentar_nombre(nombre)
    return {"status": "success", "id": jid, "nombre": nombre, "categoria": cat, "estado": "invitado"}


# ---------------------------------------------------------------- correcciones

@router.delete("/asistencias/{asistencia_id}")
def anular_asistencia(asistencia_id: int, motivo: str = Form(""), motivo_q: str = Query("", alias="motivo"),
                      s: Sede = Depends(sede_staff)):
    """Soft-delete: la asistencia queda 'anulada' con su motivo y sale de reportes y conteos."""
    motivo = " ".join((motivo or motivo_q).split())[:150] or "anulada por el staff"
    r = s.db.anular_asistencia(asistencia_id, motivo)
    if r == "no_existe":
        error(404, "no_existe", "La asistencia no existe.")
    if r == "ya_anulada":
        error(409, "ya_anulada", "La asistencia ya estaba anulada.")
    s.db.auditar("anular_asistencia", f"asistencia #{asistencia_id}: {motivo}")
    return {"status": "success", "id": asistencia_id, "estado": "anulada"}


@router.patch("/jugadores/{jugador_id}")
def editar_jugador(jugador_id: int, nombre: str | None = Form(None), categoria: str | None = Form(None),
                   sin_categoria: bool = Form(False), s: Sede = Depends(sede_staff)):
    """Cambia nombre y/o categoría. sin_categoria=true deja al jugador sin categoría (un form con categoria=""
    llega como ausente)."""
    if jugador_id not in s.jugadores:
        error(404, "no_existe", "El jugador no existe.")
    cambios = {}
    if nombre is not None:
        cambios["nombre"] = _nombre_staff(nombre)
    if sin_categoria:
        cambios["categoria"] = None
    elif categoria is not None:
        cambios["categoria"] = _categoria(s, categoria)
    if not cambios:
        error(400, "sin_cambios", "Indica nombre o categoría.")
    if not s.db.actualizar_jugador(jugador_id, cambios.get("nombre", _SIN_CAMBIO),
                                   cambios.get("categoria", _SIN_CAMBIO)):
        error(404, "no_existe", "El jugador no existe.")
    with s.lock:
        s.jugadores[jugador_id].update(cambios)
    if "nombre" in cambios:
        precalentar_nombre(cambios["nombre"])
    s.db.auditar("editar_jugador", f"jugador #{jugador_id}: {', '.join(sorted(cambios))}")
    j = s.jugadores[jugador_id]
    return {"status": "success", "id": jugador_id, "nombre": j["nombre"], "categoria": j["categoria"],
            "estado": j["estado"]}


@router.get("/auditoria")
def auditoria(s: Sede = Depends(sede_staff)):
    """Últimas 200 acciones (sin datos biométricos)."""
    return s.db.listar_auditoria()
