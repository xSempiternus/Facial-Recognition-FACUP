"""Persistencia de los flujos de revisión de UNA sede (mixin de db_manager.Base, usa self.conexion()):

- enlaces de inscripción para los padres (solo se guarda el hash del token),
- solicitudes de inscripción pendientes (embeddings + una miniatura; nunca las fotos originales),
- consentimientos (evidencia: versión y hash del texto, tutor, contacto, fecha, hash de la IP),
- pendientes del kiosko (llegadas no reconocidas, niños nuevos y reportes "No soy yo"),
- estados de asistencia (valida | disputada | anulada) e invitados,
- auditoría mínima (sin datos biométricos; solo ids y acciones),
- tours/tutoriales ya vistos por el staff de la sede (preferencias de la UI, sin datos personales).

Retenciones: solicitudes 30 días, pendientes 7 días (purga automática).
"""

import json
import re
import secrets
from datetime import datetime, timedelta

RETENCION_SOLICITUDES_DIAS = 30
RETENCION_PENDIENTES_DIAS = 7
MAX_PENDIENTES = 100
MAX_AUDITORIA = 200
ESTADOS_ASISTENCIA = ("valida", "disputada", "anulada")
# no_reconocido: el kiosko no reconoció (avisó "soy entrenador" o abandonó); nino_nuevo: avisó "soy nuevo";
# no_soy_yo: el kiosko reconoció a otro niño.
MOTIVOS_PENDIENTE = ("no_reconocido", "no_soy_yo", "nino_nuevo")
MAX_NOVEDADES = 20
# Registro de puntajes de /verify (calibración): retención 90 días.
RETENCION_VERIFICACIONES_DIAS = 90
RESULTADOS_VERIFICACION = ("aceptado", "dudoso", "rechazado", "sin_cara", "error")
# Parecido de la sugerencia de un pendiente que viene de un fallo del kiosko: alto (dudoso por margen),
# medio (zona gris entre umbral_duda y el automático), bajo (rechazado, pero con un candidato sugerible).
PARECIDOS = ("alto", "medio", "bajo")
# Columnas agregadas a tablas de este módulo después de su primera versión.
# Todas aditivas (ADD COLUMN nullable): una BD vieja sigue funcionando y las filas viejas quedan en NULL.
_MIGRACIONES_FLUJOS = {
    # verificacion_id: fila de verificaciones_log de la captura (para saber qué decidió el staff sobre ella).
    "pendientes": {"parecido": "TEXT", "verificacion_id": "INTEGER"},
    # {modelo: [embeddings]} de modelos sombra calculados sobre los mismos recortes (p. ej. SFace).
    # tutor_correo / tutor_telefono (+569XXXXXXXX) / tutor_parentesco reemplazan al campo libre tutor_contacto
    # (que se conserva por compatibilidad); acepta_comunicaciones: 1/0 (copia para el staff; la evidencia está
    # en consentimientos).
    "solicitudes": {"embeddings_extra": "TEXT", "tutor_correo": "TEXT", "tutor_telefono": "TEXT",
                    "tutor_parentesco": "TEXT", "acepta_comunicaciones": "INTEGER"},
    # Autorización de comunicaciones (separada y opcional): flag + versión/hash del texto y fecha de aceptación.
    "consentimientos": {"acepta_comunicaciones": "INTEGER", "comunicaciones_version": "TEXT",
                        "comunicaciones_texto_hash": "TEXT", "comunicaciones_fecha": "DATETIME"},
    # Modo sombra (no cambian el veredicto): ensemble SFace en zona gris, cara recortada en el celular y la
    # decisión del staff sobre esa captura (staff_id: jugador al que el staff asignó el pendiente).
    "verificaciones_log": {"score_sface": "REAL", "candidato_sface": "INTEGER", "fusion_score": "REAL",
                           "sface_coincide": "INTEGER", "score_cliente": "REAL", "ms_cliente": "INTEGER",
                           "staff_id": "INTEGER"},
}
COLUMNAS_SOMBRA = ("score_sface", "candidato_sface", "fusion_score", "sface_coincide", "score_cliente", "ms_cliente")
_SIN_CAMBIO = object()
_ALFABETO_CODIGO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

_ESQUEMA = [
    "CREATE TABLE IF NOT EXISTS meta (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)",
    """
    CREATE TABLE IF NOT EXISTS enlaces_inscripcion (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        categoria TEXT,
        creado_en DATETIME NOT NULL,
        expira DATETIME NOT NULL,
        revocado_en DATETIME
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS solicitudes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT NOT NULL UNIQUE,
        enlace_id INTEGER,
        nombre_nino TEXT NOT NULL,
        anio_nacimiento INTEGER,
        categoria TEXT,
        tutor_nombre TEXT NOT NULL,
        tutor_contacto TEXT NOT NULL,
        embeddings TEXT NOT NULL,
        modelo TEXT NOT NULL,
        miniatura BLOB,
        duplicado_de_id INTEGER,
        duplicado_similitud REAL,
        duplicado_solicitud_id INTEGER,
        duplicado_solicitud_similitud REAL,
        creado_en DATETIME NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS consentimientos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jugador_id INTEGER,
        solicitud_id INTEGER,
        version_texto TEXT NOT NULL,
        texto_hash TEXT NOT NULL,
        tutor TEXT NOT NULL,
        contacto TEXT,
        fecha DATETIME NOT NULL,
        ip_hash TEXT,
        retirado_en DATETIME
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS auditoria (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha DATETIME NOT NULL,
        accion TEXT NOT NULL,
        detalle TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS pendientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME NOT NULL,
        embedding TEXT NOT NULL,
        modelo TEXT NOT NULL,
        miniatura BLOB,
        sugerido_id INTEGER,
        similitud REAL,
        motivo TEXT NOT NULL DEFAULT 'no_reconocido',
        disputa_de_jugador_id INTEGER,
        asistencia_id INTEGER
    )
    """,
    # Registro de puntajes de /verify para calibrar umbrales: sin biometría ni fotos (solo ids y números).
    """
    CREATE TABLE IF NOT EXISTS verificaciones_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts DATETIME NOT NULL,
        resultado TEXT NOT NULL,
        mejor_id INTEGER,
        mejor_score REAL,
        segundo_id INTEGER,
        segundo_score REAL,
        umbral_auto REAL,
        umbral_duda REAL,
        modelo TEXT,
        detector TEXT,
        ms_total INTEGER,
        ms_deteccion INTEGER
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_verificaciones_ts ON verificaciones_log (ts)",
    """
    CREATE TABLE IF NOT EXISTS staff_tours (
        tour_id TEXT PRIMARY KEY,
        visto_en DATETIME NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_asistencia_jugador_ts ON asistencia (jugador_id, timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_consentimientos_jugador ON consentimientos (jugador_id)",
]


PARENTESCOS = ("madre", "padre", "otro")
_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$")


def normalizar_correo(valor: str | None) -> str | None:
    """Correo en minúsculas, o None si no es válido."""
    v = (valor or "").strip()
    return v.lower() if len(v) <= 254 and _EMAIL_RE.match(v) else None


def normalizar_telefono_cl(valor: str | None) -> str | None:
    """Celular chileno en formato +569XXXXXXXX. Acepta 9XXXXXXXX, 569XXXXXXXX, +56 9 XXXX XXXX, 0056...
    None si no es un celular chileno."""
    t = re.sub(r"[\s().-]", "", valor or "")
    if t.startswith("00"):
        t = t[2:]
    t = t.lstrip("+")
    if len(t) == 11 and t.startswith("56"):
        t = t[2:]
    return "+56" + t if re.fullmatch(r"9\d{8}", t) else None


def contacto_legado(contacto: str | None) -> tuple[str | None, str | None]:
    """(correo, telefono) a partir del campo libre antiguo tutor_contacto, si calza con alguno."""
    c = (contacto or "").strip()
    return (normalizar_correo(c), None) if "@" in c else (None, normalizar_telefono_cl(c))


def _migrar_contactos_legado(conn) -> None:
    """Una vez por BD: solicitudes (y jugadores aprobados) con el campo libre tutor_contacto -> correo/teléfono."""
    if conn.execute("SELECT 1 FROM meta WHERE clave = 'migracion_contacto_v1'").fetchone():
        return
    for sid, contacto in conn.execute("SELECT id, tutor_contacto FROM solicitudes "
                                      "WHERE tutor_correo IS NULL AND tutor_telefono IS NULL").fetchall():
        correo, tel = contacto_legado(contacto)
        if correo or tel:
            conn.execute("UPDATE solicitudes SET tutor_correo = ?, tutor_telefono = ? WHERE id = ?", (correo, tel, sid))
    cols_j = {r[1] for r in conn.execute("PRAGMA table_info(jugadores)")}
    if {"tutor_correo", "tutor_telefono"} <= cols_j:
        filas = conn.execute(
            "SELECT j.id, (SELECT c.contacto FROM consentimientos c WHERE c.jugador_id = j.id ORDER BY c.id DESC "
            "LIMIT 1) FROM jugadores j WHERE j.tutor_correo IS NULL AND j.tutor_telefono IS NULL").fetchall()
        for jid, contacto in filas:
            correo, tel = contacto_legado(contacto)
            if correo or tel:
                conn.execute("UPDATE jugadores SET tutor_correo = ?, tutor_telefono = ? WHERE id = ?", (correo, tel, jid))
    conn.execute("INSERT INTO meta (clave, valor) VALUES ('migracion_contacto_v1', ?)", (_now(),))


def _now() -> str:
    return datetime.now().isoformat(sep=" ", timespec="seconds")


def _hace(dias: float) -> str:
    return (datetime.now() - timedelta(days=dias)).isoformat(sep=" ", timespec="seconds")


def crear_esquema(conn) -> None:
    """Idempotente: tablas nuevas sobre BDs existentes."""
    for sql in _ESQUEMA:
        conn.execute(sql)
    for tabla, columnas in _MIGRACIONES_FLUJOS.items():
        existentes = {r[1] for r in conn.execute(f"PRAGMA table_info({tabla})")}
        for col, tipo in columnas.items():
            if col not in existentes:
                conn.execute(f"ALTER TABLE {tabla} ADD COLUMN {col} {tipo}")
    if conn.execute("SELECT 1 FROM meta WHERE clave = 'ip_sal'").fetchone() is None:
        conn.execute("INSERT INTO meta (clave, valor) VALUES ('ip_sal', ?)", (secrets.token_hex(16),))
    _migrar_contactos_legado(conn)


def _codigo() -> str:
    c = "".join(secrets.choice(_ALFABETO_CODIGO) for _ in range(8))
    return f"{c[:4]}-{c[4:]}"


class FlujosDB:
    """Métodos de los flujos de revisión. Requiere self.conexion() y self.limpiar_wal() (db_manager.Base)."""

    # ------------------------------------------------------------ meta / auditoría

    def ip_sal(self) -> str:
        with self.conexion() as conn:
            return conn.execute("SELECT valor FROM meta WHERE clave = 'ip_sal'").fetchone()[0]

    def auditar(self, accion: str, detalle: str = "") -> None:
        """Registro mínimo de acciones del staff (y reportes públicos). Nunca datos biométricos."""
        with self.conexion() as conn:
            conn.execute("INSERT INTO auditoria (fecha, accion, detalle) VALUES (?, ?, ?)",
                         (_now(), accion, (detalle or "")[:300]))

    def listar_auditoria(self, limit: int = MAX_AUDITORIA) -> list[dict]:
        with self.conexion() as conn:
            rows = conn.execute("SELECT id, fecha, accion, detalle FROM auditoria ORDER BY id DESC LIMIT ?",
                                (max(1, min(int(limit), MAX_AUDITORIA)),)).fetchall()
        return [dict(r) for r in rows]

    # ------------------------------------------------------------ enlaces de inscripción

    def crear_enlace(self, token_hash: str, categoria: str | None, dias: int) -> dict:
        creado = datetime.now()
        expira = (creado + timedelta(days=dias)).isoformat(sep=" ", timespec="seconds")
        with self.conexion() as conn:
            cur = conn.execute(
                "INSERT INTO enlaces_inscripcion (token_hash, categoria, creado_en, expira) VALUES (?, ?, ?, ?)",
                (token_hash, categoria, creado.isoformat(sep=" ", timespec="seconds"), expira))
            return {"id": cur.lastrowid, "categoria": categoria,
                    "creado_en": creado.isoformat(sep=" ", timespec="seconds"), "expira": expira}

    def listar_enlaces(self, limit: int = 100) -> list[dict]:
        ahora = _now()
        with self.conexion() as conn:
            rows = conn.execute(
                "SELECT e.id, e.categoria, e.creado_en, e.expira, e.revocado_en, "
                "(SELECT COUNT(*) FROM solicitudes s WHERE s.enlace_id = e.id) AS solicitudes_pendientes "
                "FROM enlaces_inscripcion e ORDER BY e.id DESC LIMIT ?", (limit,)).fetchall()
        salida = []
        for r in rows:
            d = dict(r)
            d["estado"] = "revocado" if d["revocado_en"] else ("vencido" if d["expira"] <= ahora else "activo")
            salida.append(d)
        return salida

    def revocar_enlace(self, enlace_id: int) -> bool:
        with self.conexion() as conn:
            if conn.execute("SELECT 1 FROM enlaces_inscripcion WHERE id = ?", (enlace_id,)).fetchone() is None:
                return False
            conn.execute("UPDATE enlaces_inscripcion SET revocado_en = coalesce(revocado_en, ?) WHERE id = ?",
                         (_now(), enlace_id))
            return True

    def enlace_por_hash(self, token_hash: str) -> dict | None:
        """{id, categoria, expira, revocado_en, estado} o None."""
        with self.conexion() as conn:
            r = conn.execute("SELECT id, categoria, expira, revocado_en FROM enlaces_inscripcion "
                             "WHERE token_hash = ?", (token_hash,)).fetchone()
        if r is None:
            return None
        d = dict(r)
        d["estado"] = "revocado" if d["revocado_en"] else ("vencido" if d["expira"] <= _now() else "activo")
        return d

    # ------------------------------------------------------------ solicitudes

    def contar_solicitudes(self, enlace_id: int | None = None) -> int:
        """Solicitudes pendientes (todas, o solo las llegadas por un enlace)."""
        with self.conexion() as conn:
            if enlace_id is not None:
                return conn.execute("SELECT COUNT(*) FROM solicitudes WHERE enlace_id = ?", (enlace_id,)).fetchone()[0]
            return conn.execute("SELECT COUNT(*) FROM solicitudes").fetchone()[0]

    def embeddings_solicitudes(self, modelo: str) -> dict[int, list]:
        """{solicitud_id: [embeddings]} de las solicitudes pendientes del modelo dado."""
        with self.conexion() as conn:
            rows = conn.execute("SELECT id, embeddings FROM solicitudes WHERE modelo = ?", (modelo,)).fetchall()
        return {r["id"]: json.loads(r["embeddings"]) for r in rows}

    def crear_solicitud(self, d: dict, consentimiento: dict) -> tuple[int, str]:
        """Inserta la solicitud y la evidencia de consentimiento en la misma transacción. Retorna (id, codigo)."""
        with self.conexion() as conn:
            for _ in range(5):
                codigo = _codigo()
                if conn.execute("SELECT 1 FROM solicitudes WHERE codigo = ?", (codigo,)).fetchone() is None:
                    break
            cur = conn.execute(
                """
                INSERT INTO solicitudes (codigo, enlace_id, nombre_nino, anio_nacimiento, categoria, tutor_nombre,
                    tutor_contacto, embeddings, modelo, miniatura, duplicado_de_id, duplicado_similitud,
                    duplicado_solicitud_id, duplicado_solicitud_similitud, creado_en, embeddings_extra,
                    tutor_correo, tutor_telefono, tutor_parentesco, acepta_comunicaciones)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (codigo, d["enlace_id"], d["nombre_nino"], d["anio_nacimiento"], d["categoria"], d["tutor_nombre"],
                 d["tutor_contacto"], json.dumps(d["embeddings"]), d["modelo"], d["miniatura"],
                 d.get("duplicado_de_id"), d.get("duplicado_similitud"),
                 d.get("duplicado_solicitud_id"), d.get("duplicado_solicitud_similitud"), _now(),
                 json.dumps(d["embeddings_extra"]) if d.get("embeddings_extra") else None,
                 d.get("tutor_correo"), d.get("tutor_telefono"), d.get("tutor_parentesco"),
                 1 if d.get("acepta_comunicaciones") else 0))
            sid = cur.lastrowid
            com = consentimiento.get("comunicaciones")  # {version, texto_hash} solo si aceptó
            conn.execute(
                "INSERT INTO consentimientos (solicitud_id, version_texto, texto_hash, tutor, contacto, fecha, ip_hash, "
                "acepta_comunicaciones, comunicaciones_version, comunicaciones_texto_hash, comunicaciones_fecha) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (sid, consentimiento["version"], consentimiento["texto_hash"], d["tutor_nombre"],
                 d["tutor_contacto"], _now(), consentimiento.get("ip_hash"), 1 if com else 0,
                 com["version"] if com else None, com["texto_hash"] if com else None, _now() if com else None))
            return sid, codigo

    def listar_solicitudes(self) -> list[dict]:
        """Sin embeddings (solo cuántas fotos), con miniatura en bytes. Más antiguas primero (orden de revisión)."""
        with self.conexion() as conn:
            rows = conn.execute(
                "SELECT id, codigo, enlace_id, nombre_nino, anio_nacimiento, categoria, tutor_nombre, tutor_contacto, "
                "embeddings, modelo, miniatura, duplicado_de_id, duplicado_similitud, duplicado_solicitud_id, "
                "duplicado_solicitud_similitud, creado_en, tutor_correo, tutor_telefono, tutor_parentesco, "
                "acepta_comunicaciones FROM solicitudes ORDER BY id").fetchall()
        salida = []
        for r in rows:
            d = dict(r)
            d["fotos"] = len(json.loads(d.pop("embeddings")))
            salida.append(d)
        return salida

    def obtener_solicitud(self, sid: int) -> dict | None:
        with self.conexion() as conn:
            r = conn.execute("SELECT * FROM solicitudes WHERE id = ?", (sid,)).fetchone()
        if r is None:
            return None
        d = dict(r)
        d["embeddings"] = json.loads(d["embeddings"])
        try:
            extra = json.loads(d.get("embeddings_extra") or "{}")
        except ValueError:
            extra = {}
        d["embeddings_extra"] = extra if isinstance(extra, dict) else {}
        return d

    def borrar_solicitud(self, sid: int) -> bool:
        """Borra la solicitud (embeddings y miniatura) y su evidencia de consentimiento (minimización)."""
        with self.conexion() as conn:
            borrada = conn.execute("DELETE FROM solicitudes WHERE id = ?", (sid,)).rowcount > 0
            conn.execute("DELETE FROM consentimientos WHERE solicitud_id = ? AND jugador_id IS NULL", (sid,))
        if borrada:
            self.limpiar_wal()
        return borrada

    def purgar_solicitudes(self) -> int:
        limite = _hace(RETENCION_SOLICITUDES_DIAS)
        with self.conexion() as conn:
            ids = [r[0] for r in conn.execute("SELECT id FROM solicitudes WHERE creado_en < ?", (limite,))]
            for sid in ids:
                conn.execute("DELETE FROM solicitudes WHERE id = ?", (sid,))
                conn.execute("DELETE FROM consentimientos WHERE solicitud_id = ? AND jugador_id IS NULL", (sid,))
        if ids:
            self.limpiar_wal()
        return len(ids)

    def aprobar_solicitud(self, sol: dict, nombre: str, categoria: str | None, invitado_id: int | None) -> int:
        """Crea el jugador activo (o activa al invitado `invitado_id`, conservando sus asistencias) con las plantillas
        de la solicitud, enlaza el consentimiento y borra la solicitud. Todo en una transacción.
        LookupError si la solicitud ya no existe o el invitado no existe / no es invitado."""
        embs, modelo, ahora = sol["embeddings"], sol["modelo"], _now()
        # Solicitudes viejas (solo tutor_contacto) que la migración no alcanzó: se intenta de nuevo aquí.
        correo, tel = sol.get("tutor_correo"), sol.get("tutor_telefono")
        if not correo and not tel:
            correo, tel = contacto_legado(sol.get("tutor_contacto"))
        apoderado = (correo, tel, sol.get("tutor_parentesco"), sol.get("anio_nacimiento"))
        with self.conexion() as conn:
            if conn.execute("SELECT 1 FROM solicitudes WHERE id = ?", (sol["id"],)).fetchone() is None:
                raise LookupError("solicitud")
            if invitado_id is not None:
                cur = conn.execute(
                    "UPDATE jugadores SET nombre = ?, categoria = ?, estado = 'activo', embedding = ?, modelo = ?, "
                    "consentimiento_tutor = ?, consentimiento_fecha = ?, tutor_correo = ?, tutor_telefono = ?, "
                    "tutor_parentesco = ?, anio_nacimiento = ? WHERE id = ? AND estado = 'invitado'",
                    (nombre, categoria, json.dumps(embs[0]), modelo, sol["tutor_nombre"], ahora, *apoderado,
                     invitado_id))
                if cur.rowcount == 0:
                    raise LookupError("invitado")
                jid = invitado_id
            else:
                cur = conn.execute(
                    "INSERT INTO jugadores (nombre, embedding, categoria, creado_en, modelo, consentimiento_tutor, "
                    "consentimiento_fecha, estado, tutor_correo, tutor_telefono, tutor_parentesco, anio_nacimiento) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, 'activo', ?, ?, ?, ?)",
                    (nombre, json.dumps(embs[0]), categoria, ahora, modelo, sol["tutor_nombre"], ahora, *apoderado))
                jid = cur.lastrowid
            conn.executemany(
                "INSERT INTO fotos (jugador_id, embedding, modelo, origen, creado_en) VALUES (?, ?, ?, 'inscripcion', ?)",
                [(jid, json.dumps(e), modelo, ahora) for e in embs]
                + [(jid, json.dumps(e), m, ahora) for m, es in (sol.get("embeddings_extra") or {}).items()
                   if m != modelo for e in es])
            conn.execute("UPDATE consentimientos SET jugador_id = ? WHERE solicitud_id = ?", (jid, sol["id"]))
            conn.execute("DELETE FROM solicitudes WHERE id = ?", (sol["id"],))
        self.limpiar_wal()
        return jid

    # ------------------------------------------------------------ pendientes del kiosko

    def crear_pendiente(self, timestamp: str, embedding: list[float], modelo: str, miniatura: bytes,
                        sugerido_id: int | None, similitud: float | None, motivo: str = "no_reconocido",
                        disputa_de: int | None = None, asistencia_id: int | None = None,
                        parecido: str | None = None, verificacion_id: int | None = None) -> int:
        if motivo not in MOTIVOS_PENDIENTE:
            raise ValueError(f"motivo de pendiente inválido: {motivo}")
        if parecido is not None and parecido not in PARECIDOS:
            raise ValueError(f"parecido inválido: {parecido}")
        with self.conexion() as conn:
            cur = conn.execute(
                "INSERT INTO pendientes (timestamp, embedding, modelo, miniatura, sugerido_id, similitud, motivo, "
                "disputa_de_jugador_id, asistencia_id, parecido, verificacion_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (timestamp, json.dumps(embedding), modelo, miniatura, sugerido_id, similitud, motivo,
                 disputa_de, asistencia_id, parecido, verificacion_id))
            pid = cur.lastrowid
        self.purgar_pendientes()
        return pid

    def contar_pendientes(self) -> int:
        with self.conexion() as conn:
            return conn.execute("SELECT COUNT(*) FROM pendientes").fetchone()[0]

    def listar_pendientes(self) -> list[dict]:
        with self.conexion() as conn:
            rows = conn.execute(
                "SELECT id, timestamp, modelo, miniatura, sugerido_id, similitud, motivo, disputa_de_jugador_id, "
                "asistencia_id, parecido FROM pendientes ORDER BY id DESC").fetchall()
        return [dict(r) for r in rows]

    def novedades_pendientes(self, desde: int, limite: int = MAX_NOVEDADES) -> dict:
        """Lo que consulta el staff cada pocos segundos: {ultimo_id, total, nuevos (los más recientes con id > desde,
        del más nuevo al más antiguo, máx. `limite`)}. Sin embeddings."""
        with self.conexion() as conn:
            total, max_id = conn.execute("SELECT COUNT(*), coalesce(MAX(id), 0) FROM pendientes").fetchone()
            rows = conn.execute(
                "SELECT id, timestamp, motivo, miniatura, sugerido_id, similitud, disputa_de_jugador_id, parecido "
                "FROM pendientes WHERE id > ? ORDER BY id DESC LIMIT ?", (desde, limite)).fetchall() if max_id > desde else []
        return {"ultimo_id": max(desde, max_id), "total": total, "nuevos": [dict(r) for r in rows]}

    def obtener_pendiente(self, pid: int) -> dict | None:
        with self.conexion() as conn:
            r = conn.execute("SELECT * FROM pendientes WHERE id = ?", (pid,)).fetchone()
        if r is None:
            return None
        d = dict(r)
        d["embedding"] = json.loads(d["embedding"])
        return d

    def tomar_pendiente(self, pid: int) -> dict | None:
        """Lo saca de la cola de forma atómica (dos staff a la vez: solo uno lo obtiene)."""
        d = self.obtener_pendiente(pid)
        if d is None:
            return None
        with self.conexion() as conn:
            if conn.execute("DELETE FROM pendientes WHERE id = ?", (pid,)).rowcount == 0:
                return None
        self.limpiar_wal()
        return d

    def purgar_pendientes(self) -> int:
        """Retención 7 días y tope MAX_PENDIENTES. Una disputa que se purga sin resolver anula la asistencia
        disputada (misma regla que descartarla)."""
        limite = _hace(RETENCION_PENDIENTES_DIAS)
        with self.conexion() as conn:
            viejos = conn.execute("SELECT id, asistencia_id FROM pendientes WHERE timestamp < ?", (limite,)).fetchall()
            exceso = conn.execute("SELECT COUNT(*) FROM pendientes").fetchone()[0] - len(viejos) - MAX_PENDIENTES
            if exceso > 0:
                viejos += conn.execute(
                    "SELECT id, asistencia_id FROM pendientes WHERE timestamp >= ? ORDER BY id LIMIT ?",
                    (limite, exceso)).fetchall()
            for r in viejos:
                conn.execute("DELETE FROM pendientes WHERE id = ?", (r["id"],))
                if r["asistencia_id"]:
                    conn.execute("UPDATE asistencia SET estado = 'anulada', motivo = 'disputa_expirada', "
                                 "anulada_en = ? WHERE id = ? AND estado = 'disputada'", (_now(), r["asistencia_id"]))
        if viejos:
            self.limpiar_wal()
        return len(viejos)

    # ------------------------------------------------------------ registro de puntajes de /verify (calibración)

    def registrar_verificacion(self, resultado: str, mejor_id: int | None = None, mejor_score: float | None = None,
                               segundo_id: int | None = None, segundo_score: float | None = None,
                               umbral_auto: float | None = None, umbral_duda: float | None = None,
                               modelo: str | None = None, detector: str | None = None,
                               ms_total: int | None = None, ms_deteccion: int | None = None) -> int:
        """Una fila por /verify (sin biometría ni fotos). Retención RETENCION_VERIFICACIONES_DIAS (purga perezosa).
        Retorna el id de la fila (la sombra la completa después con actualizar_sombra)."""
        if resultado not in RESULTADOS_VERIFICACION:
            raise ValueError(f"resultado inválido: {resultado}")

        def r4(x):
            return None if x is None else round(float(x), 4)
        with self.conexion() as conn:
            return conn.execute(
                "INSERT INTO verificaciones_log (ts, resultado, mejor_id, mejor_score, segundo_id, segundo_score, "
                "umbral_auto, umbral_duda, modelo, detector, ms_total, ms_deteccion) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (_now(), resultado, mejor_id, r4(mejor_score), segundo_id, r4(segundo_score), r4(umbral_auto),
                 r4(umbral_duda), modelo, detector, ms_total, ms_deteccion)).lastrowid

    def actualizar_sombra(self, verificacion_id: int, **campos) -> None:
        """Completa las columnas de modo sombra (COLUMNAS_SOMBRA) de una fila del registro. Solo números e ids."""
        campos = {k: v for k, v in campos.items() if k in COLUMNAS_SOMBRA}
        if not campos or not verificacion_id:
            return
        valores = [round(float(v), 4) if isinstance(v, float) else v for v in campos.values()]
        with self.conexion() as conn:
            conn.execute(f"UPDATE verificaciones_log SET {', '.join(f'{k} = ?' for k in campos)} WHERE id = ?",
                         (*valores, verificacion_id))

    def marcar_staff_verificacion(self, verificacion_id: int | None, jugador_id: int | None) -> None:
        """El staff asignó la captura de esa verificación a `jugador_id` (dato de corrección para la sombra)."""
        if verificacion_id:
            with self.conexion() as conn:
                conn.execute("UPDATE verificaciones_log SET staff_id = ? WHERE id = ?", (jugador_id, verificacion_id))

    def verificaciones_desde(self, dias: int) -> list[dict]:
        """Filas de los últimos `dias` días (resultado, puntajes, columnas sombra), para /metricas/reconocimiento."""
        with self.conexion() as conn:
            rows = conn.execute(
                "SELECT ts, resultado, mejor_id, mejor_score, segundo_score, ms_total, score_sface, candidato_sface, "
                "fusion_score, sface_coincide, score_cliente, ms_cliente, staff_id FROM verificaciones_log "
                "WHERE ts >= ? ORDER BY id", (_hace(dias),)).fetchall()
        return [dict(r) for r in rows]

    def purgar_verificaciones(self) -> int:
        with self.conexion() as conn:
            return conn.execute("DELETE FROM verificaciones_log WHERE ts < ?",
                                (_hace(RETENCION_VERIFICACIONES_DIAS),)).rowcount

    # ------------------------------------------------------------ preferencias del staff (tours vistos)

    def tours_vistos(self) -> list[str]:
        with self.conexion() as conn:
            return [r[0] for r in conn.execute("SELECT tour_id FROM staff_tours ORDER BY visto_en, tour_id")]

    def marcar_tour(self, tour_id: str) -> None:
        with self.conexion() as conn:
            conn.execute("INSERT OR IGNORE INTO staff_tours (tour_id, visto_en) VALUES (?, ?)", (tour_id, _now()))

    def reiniciar_tours(self) -> int:
        with self.conexion() as conn:
            return conn.execute("DELETE FROM staff_tours").rowcount

    # ------------------------------------------------------------ estados de asistencia

    def obtener_asistencia(self, aid: int) -> dict | None:
        with self.conexion() as conn:
            r = conn.execute("SELECT id, jugador_id, timestamp, origen, estado FROM asistencia WHERE id = ?",
                             (aid,)).fetchone()
        return dict(r) if r else None

    def anular_asistencia(self, aid: int, motivo: str) -> str:
        """'ok' | 'no_existe' | 'ya_anulada'. Soft-delete: la fila queda con estado 'anulada' y su motivo."""
        with self.conexion() as conn:
            r = conn.execute("SELECT estado FROM asistencia WHERE id = ?", (aid,)).fetchone()
            if r is None:
                return "no_existe"
            if r["estado"] == "anulada":
                return "ya_anulada"
            conn.execute("UPDATE asistencia SET estado = 'anulada', motivo = ?, anulada_en = ? WHERE id = ?",
                         ((motivo or "")[:200], _now(), aid))
            return "ok"

    def marcar_disputada(self, aid: int) -> bool:
        with self.conexion() as conn:
            return conn.execute("UPDATE asistencia SET estado = 'disputada' WHERE id = ? AND estado = 'valida'",
                                (aid,)).rowcount > 0

    def restaurar_asistencia(self, aid: int) -> bool:
        """Disputada -> válida. Si ese día el jugador ya tiene otra válida, la disputada se anula (no se duplica)."""
        with self.conexion() as conn:
            r = conn.execute("SELECT jugador_id, timestamp FROM asistencia WHERE id = ? AND estado = 'disputada'",
                             (aid,)).fetchone()
            if r is None:
                return False
            otra = conn.execute("SELECT 1 FROM asistencia WHERE jugador_id = ? AND date(timestamp) = date(?) "
                                "AND estado = 'valida' AND id != ?", (r["jugador_id"], r["timestamp"], aid)).fetchone()
            if otra:
                conn.execute("UPDATE asistencia SET estado = 'anulada', motivo = 'duplicada', anulada_en = ? "
                             "WHERE id = ?", (_now(), aid))
                return False
            conn.execute("UPDATE asistencia SET estado = 'valida' WHERE id = ?", (aid,))
            return True

    # ------------------------------------------------------------ invitados y edición de jugadores

    def sin_asistencia_hoy(self) -> list[dict]:
        """Jugadores ACTIVOS sin asistencia válida hoy, por categoría (orden de la sede) y nombre. Sin biometría."""
        hoy = datetime.now().date().isoformat()
        with self.conexion() as conn:
            rows = conn.execute(
                "SELECT j.id, j.nombre, j.categoria FROM jugadores j "
                "LEFT JOIN categorias c ON c.nombre = j.categoria "
                "WHERE coalesce(j.estado, 'activo') = 'activo' AND NOT EXISTS ("
                "  SELECT 1 FROM asistencia a WHERE a.jugador_id = j.id AND date(a.timestamp) = ? "
                "  AND a.estado = 'valida') "
                "ORDER BY j.categoria IS NULL, coalesce(c.orden, 999999), j.categoria COLLATE NOCASE, "
                "j.nombre COLLATE NOCASE, j.id", (hoy,)).fetchall()
        return [dict(r) for r in rows]

    def insert_invitado(self, nombre: str, categoria: str | None) -> int:
        """Jugador 'invitado': sin biometría (embedding vacío, sin fotos), excluido del reconocimiento."""
        with self.conexion() as conn:
            cur = conn.execute(
                "INSERT INTO jugadores (nombre, embedding, categoria, creado_en, modelo, estado) "
                "VALUES (?, '[]', ?, ?, NULL, 'invitado')", (nombre, categoria, _now()))
            return cur.lastrowid

    def estado_jugador(self, jid: int) -> str | None:
        with self.conexion() as conn:
            r = conn.execute("SELECT estado FROM jugadores WHERE id = ?", (jid,)).fetchone()
        return (r["estado"] or "activo") if r else None

    def actualizar_jugador(self, jid: int, nombre=_SIN_CAMBIO, categoria=_SIN_CAMBIO) -> bool:
        sets, params = [], []
        if nombre is not _SIN_CAMBIO:
            sets.append("nombre = ?")
            params.append(nombre)
        if categoria is not _SIN_CAMBIO:
            sets.append("categoria = ?")
            params.append(categoria)
        with self.conexion() as conn:
            if conn.execute("SELECT 1 FROM jugadores WHERE id = ?", (jid,)).fetchone() is None:
                return False
            if sets:
                conn.execute(f"UPDATE jugadores SET {', '.join(sets)} WHERE id = ?", (*params, jid))
            return True

    def retirar_consentimientos(self, jid: int) -> None:
        """Al borrar un jugador: la evidencia queda (prueba de que hubo consentimiento) marcada como retirada."""
        with self.conexion() as conn:
            conn.execute("UPDATE consentimientos SET retirado_en = ? WHERE jugador_id = ? AND retirado_en IS NULL",
                         (_now(), jid))
