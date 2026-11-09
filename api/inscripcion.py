"""Inscripción por los padres con enlace público -> solicitud pendiente que el staff aprueba o rechaza.

Nunca crea un jugador directamente. De las fotos solo se guardan los embeddings (una plantilla por foto) y una
miniatura de ~160 px para que el staff valide; las fotos originales no se escriben en disco.

STAFF (sede del token):   POST/GET /inscripcion/enlaces, DELETE /inscripcion/enlaces/{id},
                          GET /solicitudes, POST /solicitudes/{id}/aprobar, POST /solicitudes/{id}/rechazar
PÚBLICO (X-Sede o ?sede=): GET /inscripcion/info?t=..., POST /inscripcion
"""

import base64
import hashlib
import re
import secrets
from datetime import date

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.concurrency import run_in_threadpool

from api import consentimiento, limites
from api.auth import _cliente
from api.nucleo import (Sede, analizar, error, log, plantillas_sombra as _plantillas_sombra, precalentar_nombre,
                        sede_publica, sede_staff)
from src import cv_engine, db_manager
from src.db_flujos import PARENTESCOS, contacto_legado, normalizar_correo, normalizar_telefono_cl

router = APIRouter()

MAX_SOLICITUDES_PENDIENTES = 200
# Un mismo enlace sirve para toda una categoría o sede (multiuso hasta que vence o se revoca). Tope de solicitudes
# PENDIENTES por enlace, además de los límites por hora de api/limites.py (por IP y por token).
MAX_PENDIENTES_POR_ENLACE = 120
DIAS_ENLACE_MAX = 30
# Fotos de celular de los padres: más grandes que las del kiosko (el frontend debería reducirlas antes de subir).
MAX_BYTES_FOTO_PADRES = 8 * 1024 * 1024
MAX_LADO_FOTO_PADRES = 6000
FORMATOS_FOTO = {"JPEG", "MPO", "PNG", "WEBP"}
MIN_FOTOS, MAX_FOTOS = 2, 3
TOLERANCIA_INSCRIPCION = 0.10  # igual que /enroll: las fotos de una misma solicitud deben ser de la misma persona

_NOMBRE_RE = re.compile(r"^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]{1,59}$")
_TELEFONO_RE = re.compile(r"^\+?[0-9]{8,15}$")
_SI = ("true", "1", "on", "si", "sí")

_ENLACE_INVALIDO = "El enlace no es válido o ya venció. Pide uno nuevo al club."


def _hash_token(t: str) -> str:
    return hashlib.sha256(t.encode()).hexdigest()


def _enlace_vigente(s: Sede, t: str) -> dict:
    """404 si el token no existe en ESTA sede; 410 si venció o fue revocado. Mismo mensaje genérico."""
    t = (t or "").strip()
    e = s.db.enlace_por_hash(_hash_token(t)) if 20 <= len(t) <= 128 else None
    if e is None:
        error(404, "enlace_invalido", _ENLACE_INVALIDO)
    if e["estado"] != "activo":
        error(410, "enlace_invalido", _ENLACE_INVALIDO)
    return e


def _nombre(valor: str, campo: str) -> str:
    valor = " ".join((valor or "").split())
    if not _NOMBRE_RE.match(valor):
        error(400, "datos_invalidos", "Revisa el nombre: solo letras, espacios, apóstrofo, punto o guion (2-60).",
              campo=campo)
    return valor


def _contacto(valor: str) -> str:
    """Campo libre antiguo (clientes viejos): correo o teléfono cualquiera."""
    valor = (valor or "").strip()
    if "@" in valor:
        correo = normalizar_correo(valor)
        if correo:
            return correo
    else:
        tel = re.sub(r"[\s().-]", "", valor)
        if _TELEFONO_RE.match(tel):
            return tel
    error(400, "datos_invalidos", "Ingresa un correo o un teléfono válido.", campo="tutor_contacto")


def _apoderado(correo: str, telefono: str, parentesco: str, contacto: str) -> dict:
    """Correo (obligatorio, validado) + celular chileno (obligatorio, +569XXXXXXXX) + parentesco opcional.
    Compatibilidad: un cliente viejo que solo manda `tutor_contacto` (sin correo ni teléfono) se acepta y se
    reparte en correo o teléfono si calza."""
    correo, telefono, parentesco = (correo or "").strip(), (telefono or "").strip(), (parentesco or "").strip().lower()
    if not correo and not telefono and (contacto or "").strip():
        libre = _contacto(contacto)
        c, t = contacto_legado(libre)
        return {"tutor_contacto": libre, "tutor_correo": c, "tutor_telefono": t, "tutor_parentesco": None}
    c = normalizar_correo(correo)
    if not c:
        error(400, "datos_invalidos", "Revisa el correo: debe ser como nombre@dominio.cl.", campo="tutor_correo")
    t = normalizar_telefono_cl(telefono)
    if not t:
        error(400, "datos_invalidos", "Revisa el celular: 9 dígitos que empiezan con 9 (ej: 9 1234 5678).",
              campo="tutor_telefono")
    if parentesco and parentesco not in PARENTESCOS:
        error(400, "datos_invalidos", "Elige madre, padre u otro.", campo="tutor_parentesco")
    return {"tutor_contacto": f"{c} / {t}", "tutor_correo": c, "tutor_telefono": t,
            "tutor_parentesco": parentesco or None}


def _anio(valor: str) -> int:
    hoy = date.today().year
    try:
        anio = int((valor or "").strip())
    except ValueError:
        anio = 0
    if not hoy - 18 <= anio <= hoy - 2:
        error(400, "datos_invalidos", "Revisa el año de nacimiento.", campo="anio_nacimiento")
    return anio


# ---------------------------------------------------------------- STAFF: enlaces

@router.post("/inscripcion/enlaces")
def crear_enlace(categoria: str = Form(""), dias: int = Form(7), s: Sede = Depends(sede_staff)):
    if not 1 <= dias <= DIAS_ENLACE_MAX:
        error(400, "dias_invalidos", f"La vigencia debe ser de 1 a {DIAS_ENLACE_MAX} días.")
    cat = None
    if categoria.strip():
        try:
            cat = s.db.resolver_categoria(categoria, crear_si_falta=False)
        except db_manager.CategoriaInvalida as exc:
            error(400, "categoria_invalida", str(exc))
    token = secrets.token_urlsafe(32)  # 256 bits; en la BD solo queda su hash
    e = s.db.crear_enlace(_hash_token(token), cat, dias)
    s.db.auditar("crear_enlace", f"enlace #{e['id']} categoria={cat or '-'} vence={e['expira']}")
    return {"id": e["id"], "token": token, "ruta": f"/s/{s.slug}/inscripcion?t={token}",
            "expira": e["expira"], "categoria": cat}


@router.get("/inscripcion/enlaces")
def listar_enlaces(s: Sede = Depends(sede_staff)):
    return s.db.listar_enlaces()


@router.delete("/inscripcion/enlaces/{enlace_id}")
def revocar_enlace(enlace_id: int, s: Sede = Depends(sede_staff)):
    if not s.db.revocar_enlace(enlace_id):
        error(404, "no_existe", "El enlace no existe.")
    s.db.auditar("revocar_enlace", f"enlace #{enlace_id}")
    return {"status": "success"}


# ---------------------------------------------------------------- PÚBLICO: info y solicitud

@router.get("/inscripcion/info")
def info_inscripcion(request: Request, t: str = "", s: Sede = Depends(sede_publica)):
    limites.INFO_IP.exigir(_cliente(request))
    e = _enlace_vigente(s, t)
    categorias = ([e["categoria"]] if e["categoria"]
                  else [c["nombre"] for c in s.db.listar_categorias(incluir_inactivas=False)])
    com = consentimiento.VIGENTE_COMUNICACIONES
    return {"sede": {"slug": s.slug, "nombre": s.nombre}, "categorias": categorias,
            "categoria_fija": e["categoria"], "expira": e["expira"],
            "consentimiento": {"version": consentimiento.VIGENTE["version"],
                               "texto": consentimiento.VIGENTE["texto"]},
            "comunicaciones": {"version": com["version"], "texto": com["texto"]},
            "parentescos": list(PARENTESCOS),
            "fotos": {"minimo": MIN_FOTOS, "maximo": MAX_FOTOS, "max_mb": MAX_BYTES_FOTO_PADRES // (1024 * 1024)}}


@router.post("/inscripcion")
async def inscribir(
    request: Request,
    t: str = Form(""),
    nombre_nino: str = Form(""),
    anio_nacimiento: str = Form(""),
    categoria: str = Form(""),
    tutor_nombre: str = Form(""),
    tutor_contacto: str = Form(""),  # campo libre antiguo (solo clientes viejos)
    tutor_correo: str = Form(""),
    tutor_telefono: str = Form(""),
    tutor_parentesco: str = Form(""),
    consentimiento_ok: str = Form("", alias="consentimiento"),
    acepta_comunicaciones: str = Form(""),
    foto1: UploadFile | None = File(None),
    foto2: UploadFile | None = File(None),
    foto3: UploadFile | None = File(None),
    s: Sede = Depends(sede_publica),
):
    """Crea una solicitud pendiente. Las respuestas nunca dicen si el niño ya está inscrito."""
    ip = _cliente(request)
    limites.INSCRIPCION_IP.exigir(f"{s.slug}|{ip}")
    e = _enlace_vigente(s, t)
    limites.INSCRIPCION_TOKEN.exigir(f"{s.slug}|{e['id']}")
    await run_in_threadpool(s.db.purgar_solicitudes)
    if await run_in_threadpool(s.db.contar_solicitudes) >= MAX_SOLICITUDES_PENDIENTES:
        error(429, "no_disponible", "Por ahora no podemos recibir más solicitudes. Inténtalo más tarde.")
    if await run_in_threadpool(s.db.contar_solicitudes, e["id"]) >= MAX_PENDIENTES_POR_ENLACE:
        error(429, "no_disponible", "Por ahora no podemos recibir más solicitudes. Inténtalo más tarde.")

    nombre = _nombre(nombre_nino, "nombre_nino")
    anio = _anio(anio_nacimiento)
    tutor = _nombre(tutor_nombre, "tutor_nombre")
    apoderado = _apoderado(tutor_correo, tutor_telefono, tutor_parentesco, tutor_contacto)
    if consentimiento_ok.strip().lower() not in _SI:
        error(400, "sin_consentimiento", "Debes aceptar la autorización para continuar.", campo="consentimiento")
    # Comunicaciones: opcional y separada. Solo cuenta un "sí" explícito (ausente o cualquier otra cosa = no).
    acepta_com = acepta_comunicaciones.strip().lower() in _SI
    if e["categoria"]:
        cat = e["categoria"]
    elif categoria.strip():
        try:
            cat = s.db.resolver_categoria(categoria, crear_si_falta=False)
        except db_manager.CategoriaInvalida:
            error(400, "datos_invalidos", "La categoría no es válida.", campo="categoria")
    else:
        cat = None

    fotos = [(i + 1, f) for i, f in enumerate((foto1, foto2, foto3)) if f is not None and f.filename != ""]
    if len(fotos) < MIN_FOTOS:
        error(400, "faltan_fotos", f"Se necesitan al menos {MIN_FOTOS} fotos del rostro.")
    caras = []
    for n, f in fotos:
        if not (f.content_type or "").startswith("image/"):
            error(415, "formato_no_soportado", f"La foto {n} debe ser una imagen JPG, PNG o WEBP.", foto=n)
        cara = await analizar(s, f, miniatura=not caras, n_foto=n, max_bytes=MAX_BYTES_FOTO_PADRES,
                              max_lado=MAX_LADO_FOTO_PADRES, formatos=FORMATOS_FOTO, sombra=True)
        if cara["num_rostros"] != 1:
            error(422, "varias_caras", f"En la foto {n} aparece más de una cara. Debe salir solo el niño o niña.",
                  foto=n)
        caras.append(cara)
    embeddings = [c["embedding"] for c in caras]
    limite = s.umbral() - TOLERANCIA_INSCRIPCION
    for i, emb in enumerate(embeddings):
        if max(cv_engine.cosine_similarity(emb, o) for j, o in enumerate(embeddings) if j != i) < limite:
            error(422, "fotos_inconsistentes",
                  f"La foto {fotos[i][0]} no parece de la misma persona que las demás. Cámbiala.", foto=fotos[i][0])

    # Posibles duplicados (solo los ve el staff): contra jugadores activos y contra otras solicitudes pendientes.
    modelo = s.config["modelo"]
    dup_id, dup_sim = None, None
    plantillas = s.plantillas_actuales()
    if plantillas:
        jid, sim = max((cv_engine.best_candidate(emb, plantillas) for emb in embeddings), key=lambda m: m[1])
        if jid is not None and sim > s.umbral():
            dup_id, dup_sim = jid, round(sim, 4)
    dup_sol, dup_sol_sim = None, None
    otras = await run_in_threadpool(s.db.embeddings_solicitudes, modelo)
    if otras:
        sid, sim = max((cv_engine.best_candidate(emb, otras) for emb in embeddings), key=lambda m: m[1])
        if sid is not None and sim > s.umbral():
            dup_sol, dup_sol_sim = sid, round(sim, 4)

    datos = {"enlace_id": e["id"], "nombre_nino": nombre, "anio_nacimiento": anio, "categoria": cat,
             "tutor_nombre": tutor, **apoderado, "acepta_comunicaciones": acepta_com,
             "embeddings": embeddings, "modelo": modelo,
             "miniatura": caras[0].get("miniatura") or b"", "duplicado_de_id": dup_id, "duplicado_similitud": dup_sim,
             "duplicado_solicitud_id": dup_sol, "duplicado_solicitud_similitud": dup_sol_sim,
             # Modo sombra: plantillas SFace de los mismos recortes (las fotos no se guardan; al aprobar ya no existen).
             "embeddings_extra": _plantillas_sombra(caras)}
    evidencia = {"version": consentimiento.VIGENTE["version"], "texto_hash": consentimiento.VIGENTE["texto_hash"],
                 "ip_hash": s.ip_hash(ip),
                 "comunicaciones": ({"version": consentimiento.VIGENTE_COMUNICACIONES["version"],
                                     "texto_hash": consentimiento.VIGENTE_COMUNICACIONES["texto_hash"]}
                                    if acepta_com else None)}
    sid, codigo = await run_in_threadpool(s.db.crear_solicitud, datos, evidencia)
    s.db.auditar("solicitud_recibida", f"solicitud #{sid} enlace #{e['id']}")
    return {"status": "pendiente", "codigo": codigo}


# ---------------------------------------------------------------- STAFF: revisión de solicitudes

@router.get("/solicitudes")
def listar_solicitudes(s: Sede = Depends(sede_staff)):
    s.db.purgar_solicitudes()
    modelo = s.config["modelo"]
    salida = []
    for d in s.db.listar_solicitudes():
        jug = s.jugadores.get(d["duplicado_de_id"]) if d["duplicado_de_id"] else None
        salida.append({
            "id": d["id"], "codigo": d["codigo"], "creado_en": d["creado_en"],
            "nombre_nino": d["nombre_nino"], "anio_nacimiento": d["anio_nacimiento"], "categoria": d["categoria"],
            "tutor_nombre": d["tutor_nombre"], "tutor_contacto": d["tutor_contacto"],
            "tutor_correo": d["tutor_correo"], "tutor_telefono": d["tutor_telefono"],
            "tutor_parentesco": d["tutor_parentesco"], "acepta_comunicaciones": bool(d["acepta_comunicaciones"]),
            "fotos": d["fotos"], "compatible": d["modelo"] == modelo,
            "miniatura": base64.b64encode(d["miniatura"] or b"").decode(),
            "duplicado": ({"jugador_id": d["duplicado_de_id"], "nombre": jug["nombre"],
                           "estado": jug["estado"], "similitud": d["duplicado_similitud"]} if jug else None),
            "duplicado_solicitud": ({"solicitud_id": d["duplicado_solicitud_id"],
                                     "similitud": d["duplicado_solicitud_similitud"]}
                                    if d["duplicado_solicitud_id"] else None),
        })
    return salida


@router.post("/solicitudes/{solicitud_id}/aprobar")
def aprobar_solicitud(solicitud_id: int, nombre: str = Form(""), categoria: str | None = Form(None),
                      invitado_id: int | None = Form(None), s: Sede = Depends(sede_staff)):
    """Crea el jugador activo con las plantillas de la solicitud (o activa al invitado `invitado_id`, conservando
    sus asistencias). Luego se borran la miniatura y la solicitud."""
    sol = s.db.obtener_solicitud(solicitud_id)
    if sol is None:
        error(404, "no_existe", "La solicitud ya fue revisada o expiró.")
    if sol["modelo"] != s.config["modelo"]:
        error(409, "modelo_distinto", "La solicitud se procesó con otro modelo de reconocimiento. "
                                      "Recházala y envía un enlace nuevo a la familia.")
    nombre = " ".join(nombre.split()) or sol["nombre_nino"]
    if len(nombre) > 60:
        error(400, "nombre_invalido", "El nombre es demasiado largo (máximo 60).")
    try:
        cat = s.db.resolver_categoria(categoria if categoria is not None else (sol["categoria"] or ""))
    except db_manager.CategoriaInvalida as exc:
        error(400, "categoria_invalida", str(exc))
    if invitado_id is not None:
        j = s.jugadores.get(invitado_id)
        if j is None:
            error(404, "no_existe", "El invitado no existe.")
        if j["estado"] != "invitado":
            error(409, "no_es_invitado", "Ese jugador ya está activo; no se puede convertir.")
    try:
        jid = s.db.aprobar_solicitud(sol, nombre, cat, invitado_id)
    except LookupError as exc:
        if str(exc) == "invitado":
            error(409, "no_es_invitado", "Ese jugador ya no es invitado.")
        error(404, "no_existe", "La solicitud ya fue revisada o expiró.")
    with s.lock:
        s.jugadores[jid] = {"nombre": nombre, "categoria": cat, "estado": "activo",
                            "plantillas": [(sol["modelo"], e) for e in sol["embeddings"]]
                            + [(m, e) for m, es in (sol.get("embeddings_extra") or {}).items()
                               if m != sol["modelo"] for e in es]}
    s.db.auditar("aprobar_solicitud", f"solicitud #{solicitud_id} -> jugador #{jid}"
                 + (" (invitado convertido)" if invitado_id is not None else ""))
    precalentar_nombre(nombre)
    return {"status": "success", "id": jid, "nombre": nombre, "categoria": cat, "fotos": len(sol["embeddings"]),
            "invitado_convertido": invitado_id is not None}


@router.post("/solicitudes/{solicitud_id}/rechazar")
def rechazar_solicitud(solicitud_id: int, motivo: str = Form(""), s: Sede = Depends(sede_staff)):
    """Elimina la solicitud con sus datos biométricos (también de los respaldos) y deja registro en auditoría."""
    if not s.db.borrar_solicitud(solicitud_id):
        error(404, "no_existe", "La solicitud ya fue revisada o expiró.")
    purga = s.db.purgar_solicitud_de_respaldos(solicitud_id)
    if purga["errores"]:
        log.warning("[%s] no se pudo purgar la solicitud %s de: %s", s.slug, solicitud_id, purga["errores"])
    motivo = " ".join(motivo.split())[:150]
    s.db.auditar("rechazar_solicitud", f"solicitud #{solicitud_id}" + (f": {motivo}" if motivo else ""))
    return {"status": "success"}
