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
    """
    CREATE TABLE IF NOT EXISTS staff_tours (
        tour_id TEXT PRIMARY KEY,
        visto_en DATETIME NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_asistencia_jugador_ts ON asistencia (jugador_id, timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_consentimientos_jugador ON consentimientos (jugador_id)",
]


def _now() -> str:
    return datetime.now().isoformat(sep=" ", timespec="seconds")


def _hace(dias: float) -> str:
    return (datetime.now() - timedelta(days=dias)).isoformat(sep=" ", timespec="seconds")


def crear_esquema(conn) -> None:
    """Idempotente: tablas nuevas sobre BDs existentes."""
    for sql in _ESQUEMA:
        conn.execute(sql)
    if conn.execute("SELECT 1 FROM meta WHERE clave = 'ip_sal'").fetchone() is None:
        conn.execute("INSERT INTO meta (clave, valor) VALUES ('ip_sal', ?)", (secrets.token_hex(16),))


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

    def contar_solicitudes(self) -> int:
        with self.conexion() as conn:
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
                    duplicado_solicitud_id, duplicado_solicitud_similitud, creado_en)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (codigo, d["enlace_id"], d["nombre_nino"], d["anio_nacimiento"], d["categoria"], d["tutor_nombre"],
                 d["tutor_contacto"], json.dumps(d["embeddings"]), d["modelo"], d["miniatura"],
                 d.get("duplicado_de_id"), d.get("duplicado_similitud"),
                 d.get("duplicado_solicitud_id"), d.get("duplicado_solicitud_similitud"), _now()))
            sid = cur.lastrowid
            conn.execute(
                "INSERT INTO consentimientos (solicitud_id, version_texto, texto_hash, tutor, contacto, fecha, ip_hash) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (sid, consentimiento["version"], consentimiento["texto_hash"], d["tutor_nombre"],
                 d["tutor_contacto"], _now(), consentimiento.get("ip_hash")))
            return sid, codigo

    def listar_solicitudes(self) -> list[dict]:
        """Sin embeddings (solo cuántas fotos), con miniatura en bytes. Más antiguas primero (orden de revisión)."""
        with self.conexion() as conn:
            rows = conn.execute(
                "SELECT id, codigo, enlace_id, nombre_nino, anio_nacimiento, categoria, tutor_nombre, tutor_contacto, "
                "embeddings, modelo, miniatura, duplicado_de_id, duplicado_similitud, duplicado_solicitud_id, "
                "duplicado_solicitud_similitud, creado_en FROM solicitudes ORDER BY id").fetchall()
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
        with self.conexion() as conn:
            if conn.execute("SELECT 1 FROM solicitudes WHERE id = ?", (sol["id"],)).fetchone() is None:
                raise LookupError("solicitud")
            if invitado_id is not None:
                cur = conn.execute(
                    "UPDATE jugadores SET nombre = ?, categoria = ?, estado = 'activo', embedding = ?, modelo = ?, "
                    "consentimiento_tutor = ?, consentimiento_fecha = ? WHERE id = ? AND estado = 'invitado'",
                    (nombre, categoria, json.dumps(embs[0]), modelo, sol["tutor_nombre"], ahora, invitado_id))
                if cur.rowcount == 0:
                    raise LookupError("invitado")
                jid = invitado_id
            else:
                cur = conn.execute(
                    "INSERT INTO jugadores (nombre, embedding, categoria, creado_en, modelo, consentimiento_tutor, "
                    "consentimiento_fecha, estado) VALUES (?, ?, ?, ?, ?, ?, ?, 'activo')",
                    (nombre, json.dumps(embs[0]), categoria, ahora, modelo, sol["tutor_nombre"], ahora))
                jid = cur.lastrowid
            conn.executemany(
                "INSERT INTO fotos (jugador_id, embedding, modelo, origen, creado_en) VALUES (?, ?, ?, 'inscripcion', ?)",
                [(jid, json.dumps(e), modelo, ahora) for e in embs])
            conn.execute("UPDATE consentimientos SET jugador_id = ? WHERE solicitud_id = ?", (jid, sol["id"]))
            conn.execute("DELETE FROM solicitudes WHERE id = ?", (sol["id"],))
        self.limpiar_wal()
        return jid

    # ------------------------------------------------------------ pendientes del kiosko

    def crear_pendiente(self, timestamp: str, embedding: list[float], modelo: str, miniatura: bytes,
                        sugerido_id: int | None, similitud: float | None, motivo: str = "no_reconocido",
                        disputa_de: int | None = None, asistencia_id: int | None = None) -> int:
        if motivo not in MOTIVOS_PENDIENTE:
            raise ValueError(f"motivo de pendiente inválido: {motivo}")
        with self.conexion() as conn:
            cur = conn.execute(
                "INSERT INTO pendientes (timestamp, embedding, modelo, miniatura, sugerido_id, similitud, motivo, "
                "disputa_de_jugador_id, asistencia_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (timestamp, json.dumps(embedding), modelo, miniatura, sugerido_id, similitud, motivo,
                 disputa_de, asistencia_id))
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
                "asistencia_id FROM pendientes ORDER BY id DESC").fetchall()
        return [dict(r) for r in rows]

    def novedades_pendientes(self, desde: int, limite: int = MAX_NOVEDADES) -> dict:
        """Lo que consulta el staff cada pocos segundos: {ultimo_id, total, nuevos (los más recientes con id > desde,
        del más nuevo al más antiguo, máx. `limite`)}. Sin embeddings."""
        with self.conexion() as conn:
            total, max_id = conn.execute("SELECT COUNT(*), coalesce(MAX(id), 0) FROM pendientes").fetchone()
            rows = conn.execute(
                "SELECT id, timestamp, motivo, miniatura, sugerido_id, similitud, disputa_de_jugador_id "
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
