"""Capa de persistencia SQLite para jugadores, sus fotos (embeddings) y asistencia."""

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
# DB_PATH permite apuntar a otra base (p. ej. una copia para pruebas).
DB_PATH = Path(os.getenv("DB_PATH", str(DATA_DIR / "asistencia.db")))

# Columnas agregadas después de la primera versión: se crean si faltan en una BD existente.
_MIGRACIONES = {
    "jugadores": {"categoria": "TEXT", "creado_en": "DATETIME", "modelo": "TEXT",
                  "consentimiento_tutor": "TEXT", "consentimiento_fecha": "DATETIME"},
    "asistencia": {"origen": "TEXT DEFAULT 'facial'"},
}
# Modelo con el que se generaron los embeddings anteriores a la columna "modelo".
MODELO_LEGADO = "Facenet512"
# Máximo de fotos por jugador y modelo; al superarlo se descarta la más antigua que no sea de inscripción.
MAX_FOTOS = 10


@contextmanager
def get_connection():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_connection() as conn:
        # jugadores.embedding conserva la primera foto de inscripción (compatibilidad);
        # el reconocimiento usa todas las fotos de la tabla "fotos".
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jugadores (
                id INTEGER PRIMARY KEY,
                nombre TEXT NOT NULL,
                embedding TEXT NOT NULL,
                categoria TEXT,
                creado_en DATETIME,
                modelo TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS asistencia (
                id INTEGER PRIMARY KEY,
                jugador_id INTEGER NOT NULL,
                timestamp DATETIME NOT NULL,
                origen TEXT DEFAULT 'facial',
                FOREIGN KEY (jugador_id) REFERENCES jugadores(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS fotos (
                id INTEGER PRIMARY KEY,
                jugador_id INTEGER NOT NULL,
                embedding TEXT NOT NULL,
                modelo TEXT NOT NULL,
                origen TEXT NOT NULL DEFAULT 'inscripcion',
                creado_en DATETIME,
                FOREIGN KEY (jugador_id) REFERENCES jugadores(id) ON DELETE CASCADE
            )
            """
        )
        # Tipo de jornada por día (sin fila = entrenamiento).
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sesiones (
                fecha TEXT PRIMARY KEY,
                tipo TEXT NOT NULL DEFAULT 'entrenamiento'
            )
            """
        )
        for tabla, columnas in _MIGRACIONES.items():
            existentes = {r["name"] for r in conn.execute(f"PRAGMA table_info({tabla})")}
            for col, tipo in columnas.items():
                if col not in existentes:
                    conn.execute(f"ALTER TABLE {tabla} ADD COLUMN {col} {tipo}")
        conn.execute("UPDATE jugadores SET modelo = ? WHERE modelo IS NULL", (MODELO_LEGADO,))
        # Jugadores inscritos antes de la tabla "fotos": su embedding pasa a ser su primera foto.
        conn.execute(
            """
            INSERT INTO fotos (jugador_id, embedding, modelo, origen, creado_en)
            SELECT id, embedding, modelo, 'inscripcion', creado_en FROM jugadores
            WHERE id NOT IN (SELECT DISTINCT jugador_id FROM fotos)
            """
        )


def _now() -> str:
    return datetime.now().isoformat(sep=" ", timespec="seconds")


def insert_jugador(nombre: str, embedding: list[float], categoria: str | None = None,
                   modelo: str = MODELO_LEGADO, fotos_extra: list[list[float]] | None = None,
                   consentimiento_tutor: str | None = None) -> int:
    """Inscribe un jugador. `embedding` es la foto principal; `fotos_extra` son fotos adicionales."""
    ahora = _now()
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO jugadores (nombre, embedding, categoria, creado_en, modelo, "
            "consentimiento_tutor, consentimiento_fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (nombre, json.dumps(embedding), categoria, ahora, modelo,
             consentimiento_tutor, ahora if consentimiento_tutor else None),
        )
        jugador_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO fotos (jugador_id, embedding, modelo, origen, creado_en) "
            "VALUES (?, ?, ?, 'inscripcion', ?)",
            [(jugador_id, json.dumps(e), modelo, ahora) for e in [embedding, *(fotos_extra or [])]],
        )
        return jugador_id


def add_foto(jugador_id: int, embedding: list[float], modelo: str, origen: str) -> None:
    """Agrega una foto a un jugador (p. ej. una corrección del staff), respetando MAX_FOTOS."""
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO fotos (jugador_id, embedding, modelo, origen, creado_en) VALUES (?, ?, ?, ?, ?)",
            (jugador_id, json.dumps(embedding), modelo, origen, _now()),
        )
        exceso = conn.execute(
            "SELECT COUNT(*) FROM fotos WHERE jugador_id = ? AND modelo = ?", (jugador_id, modelo)
        ).fetchone()[0] - MAX_FOTOS
        if exceso > 0:
            # Primero se descartan las más antiguas que no son de inscripción.
            conn.execute(
                """
                DELETE FROM fotos WHERE id IN (
                    SELECT id FROM fotos WHERE jugador_id = ? AND modelo = ?
                    ORDER BY (origen = 'inscripcion'), creado_en, id LIMIT ?
                )
                """,
                (jugador_id, modelo, exceso),
            )


def get_all_jugadores() -> list[dict]:
    """Retorna [{'id', 'nombre', 'categoria', 'embedding', 'plantillas': [(modelo, embedding)]}, ...]."""
    with get_connection() as conn:
        jugadores = conn.execute(
            "SELECT id, nombre, categoria, modelo, embedding FROM jugadores"
        ).fetchall()
        fotos = conn.execute("SELECT jugador_id, modelo, embedding FROM fotos ORDER BY id").fetchall()
    plantillas: dict[int, list] = {}
    for f in fotos:
        plantillas.setdefault(f["jugador_id"], []).append((f["modelo"], json.loads(f["embedding"])))
    return [
        {**dict(j), "embedding": json.loads(j["embedding"]), "plantillas": plantillas.get(j["id"], [])}
        for j in jugadores
    ]


def list_jugadores(modelo: str | None = None) -> list[dict]:
    """Listado para el staff (sin embeddings), con total de asistencias y fotos del modelo dado."""
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT j.id, j.nombre, j.categoria, j.creado_en,
                   j.consentimiento_tutor, j.consentimiento_fecha,
                   (SELECT COUNT(*) FROM asistencia a WHERE a.jugador_id = j.id) AS asistencias,
                   (SELECT MAX(timestamp) FROM asistencia a WHERE a.jugador_id = j.id) AS ultima_asistencia,
                   (SELECT COUNT(*) FROM fotos f WHERE f.jugador_id = j.id AND f.modelo = ?) AS fotos
            FROM jugadores j
            ORDER BY j.nombre COLLATE NOCASE
            """,
            (modelo or MODELO_LEGADO,),
        ).fetchall()
    return [dict(r) for r in rows]


def set_consentimiento(jugador_id: int, tutor: str) -> bool:
    """Registra la autorización firmada del padre/madre/tutor para usar la cara del niño."""
    with get_connection() as conn:
        cur = conn.execute(
            "UPDATE jugadores SET consentimiento_tutor = ?, consentimiento_fecha = ? WHERE id = ?",
            (tutor, _now(), jugador_id),
        )
        return cur.rowcount > 0


def delete_jugador(jugador_id: int) -> bool:
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM jugadores WHERE id = ?", (jugador_id,))
        return cur.rowcount > 0


def asistio_hoy(jugador_id: int) -> str | None:
    """Retorna el timestamp de la asistencia de hoy si ya existe."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT timestamp FROM asistencia WHERE jugador_id = ? AND date(timestamp) = ? "
            "ORDER BY timestamp LIMIT 1",
            (jugador_id, date.today().isoformat()),
        ).fetchone()
    return row["timestamp"] if row else None


def registrar_asistencia(jugador_id: int, origen: str = "facial", timestamp: str | None = None) -> int:
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO asistencia (jugador_id, timestamp, origen) VALUES (?, ?, ?)",
            (jugador_id, timestamp or _now(), origen),
        )
        return cur.lastrowid


def get_asistencias(limit: int = 50, solo_hoy: bool = False, fecha: str | None = None) -> list[dict]:
    """fecha en formato YYYY-MM-DD; solo_hoy equivale a fecha=hoy."""
    if solo_hoy and not fecha:
        fecha = date.today().isoformat()
    where = "WHERE date(a.timestamp) = ?" if fecha else ""
    params = (fecha, limit) if fecha else (limit,)
    with get_connection() as conn:
        rows = conn.execute(
            f"""
            SELECT a.id, a.jugador_id, j.nombre, j.categoria, a.timestamp, a.origen
            FROM asistencia a JOIN jugadores j ON j.id = a.jugador_id
            {where}
            ORDER BY a.timestamp DESC
            LIMIT ?
            """,
            params,
        ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- respaldos

RESPALDOS_DIR = DB_PATH.parent / "respaldos"  # junto a la base en uso (una copia de prueba no toca los reales)
MAX_RESPALDOS = 14


def crear_respaldo(etiqueta: str = "auto") -> Path:
    """Copia consistente de la BD (API de backup de SQLite, segura aunque la BD esté en uso)."""
    RESPALDOS_DIR.mkdir(parents=True, exist_ok=True)
    # Milisegundos en el nombre: dos respaldos en el mismo segundo no se pisan.
    sello = f"{datetime.now():%Y-%m-%d_%H%M%S%f}"[:-3]
    destino = RESPALDOS_DIR / f"asistencia_{sello}_{etiqueta}.db"
    with get_connection() as origen:
        copia = sqlite3.connect(destino)
        try:
            origen.backup(copia)
        finally:
            copia.close()
    # Rotación: se conservan los MAX_RESPALDOS más recientes.
    for viejo in listar_respaldos()[MAX_RESPALDOS:]:
        (RESPALDOS_DIR / viejo["nombre"]).unlink(missing_ok=True)
    return destino


def listar_respaldos() -> list[dict]:
    """Respaldos del más reciente al más antiguo."""
    if not RESPALDOS_DIR.exists():
        return []
    archivos = sorted(RESPALDOS_DIR.glob("asistencia_*.db"), key=lambda p: p.name, reverse=True)
    return [{"nombre": p.name, "bytes": p.stat().st_size,
             "creado": datetime.fromtimestamp(p.stat().st_mtime).isoformat(sep=" ", timespec="seconds")}
            for p in archivos]


def respaldo_de_hoy_existe() -> bool:
    return any(r["nombre"].startswith(f"asistencia_{date.today():%Y-%m-%d}") for r in listar_respaldos())


# ---------------------------------------------------------------- jornadas y reportes

TIPOS_JORNADA = ("entrenamiento", "partido")


def set_tipo_jornada(fecha: str, tipo: str) -> None:
    if tipo not in TIPOS_JORNADA:
        raise ValueError(f"Tipo de jornada inválido: {tipo}")
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO sesiones (fecha, tipo) VALUES (?, ?) ON CONFLICT(fecha) DO UPDATE SET tipo = excluded.tipo",
            (fecha, tipo),
        )


def get_tipos_jornada(desde: str, hasta: str) -> dict[str, str]:
    """{fecha: tipo} de los días marcados en el rango (los no marcados son entrenamiento)."""
    with get_connection() as conn:
        rows = conn.execute("SELECT fecha, tipo FROM sesiones WHERE fecha BETWEEN ? AND ?",
                            (desde, hasta)).fetchall()
    return {r["fecha"]: r["tipo"] for r in rows}


def asistencias_por_dia(desde: str, hasta: str) -> list[tuple[int, str]]:
    """Pares únicos (jugador_id, fecha YYYY-MM-DD) con asistencia en el rango."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT DISTINCT jugador_id, date(timestamp) AS fecha FROM asistencia "
            "WHERE date(timestamp) BETWEEN ? AND ?",
            (desde, hasta),
        ).fetchall()
    return [(r["jugador_id"], r["fecha"]) for r in rows]
