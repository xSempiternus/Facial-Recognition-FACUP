"""Capa de persistencia SQLite de UNA sede: jugadores, sus fotos (embeddings), asistencia, categorías y respaldos.

Cada sede tiene su propia base (ver src/sedes.py); `Base(ruta)` opera solo sobre esa base y su carpeta de respaldos.
"""

import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path

from src.db_flujos import FlujosDB, crear_esquema as _crear_esquema_flujos

# Columnas agregadas después de la primera versión: se crean si faltan en una BD existente.
# jugadores.estado: 'activo' | 'invitado' (sin biometría). asistencia.estado: 'valida' | 'disputada' | 'anulada'.
_MIGRACIONES = {
    "jugadores": {"categoria": "TEXT", "creado_en": "DATETIME", "modelo": "TEXT",
                  "consentimiento_tutor": "TEXT", "consentimiento_fecha": "DATETIME",
                  "estado": "TEXT NOT NULL DEFAULT 'activo'"},
    "asistencia": {"origen": "TEXT DEFAULT 'facial'", "estado": "TEXT NOT NULL DEFAULT 'valida'",
                   "motivo": "TEXT", "anulada_en": "DATETIME",
                   "similitud": "REAL"},  # similitud del reconocimiento automático (NULL en las demás)
}
# Solo las asistencias válidas cuentan en reportes, conteos y "ya registrado".
VALIDA = "a.estado = 'valida'"
# Modelo con el que se generaron los embeddings anteriores a la columna "modelo".
MODELO_LEGADO = "Facenet512"
# Máximo de fotos por jugador y modelo; al superarlo se descarta la más antigua que no sea de inscripción.
MAX_FOTOS = 10
MAX_RESPALDOS = 14
TIPOS_JORNADA = ("entrenamiento", "partido")
CATEGORIA_INICIAL = "Sub-10"
_NOMBRE_CATEGORIA = re.compile(r"^[\wÁÉÍÓÚÜÑáéíóúüñ][\wÁÉÍÓÚÜÑáéíóúüñ .+'-]{0,39}$")


class CategoriaInvalida(ValueError):
    pass


def _now() -> str:
    return datetime.now().isoformat(sep=" ", timespec="seconds")


def normalizar_categoria(nombre: str) -> str:
    nombre = " ".join((nombre or "").split())
    if not _NOMBRE_CATEGORIA.match(nombre):
        raise CategoriaInvalida("Nombre de categoría inválido (1-40 caracteres: letras, números, espacio, . + ' -).")
    return nombre


class Base(FlujosDB):
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.respaldos_dir = self.db_path.parent / "respaldos"  # junto a la base de la sede

    @contextmanager
    def conexion(self):
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db_path, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA secure_delete = ON")  # lo borrado (embeddings, miniaturas) se sobrescribe
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def limpiar_wal(self) -> None:
        """Vuelca y trunca el WAL para que no conserve copias de datos biométricos recién borrados."""
        try:
            with self.conexion() as conn:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.Error:
            pass

    # ------------------------------------------------------------ esquema

    def init_db(self) -> None:
        with self.conexion() as conn:
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
            # Categorías de la sede. jugadores.categoria guarda el nombre de una de ellas.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS categorias (
                    id INTEGER PRIMARY KEY,
                    nombre TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    orden INTEGER NOT NULL DEFAULT 0,
                    activa INTEGER NOT NULL DEFAULT 1
                )
                """
            )
            for tabla, columnas in _MIGRACIONES.items():
                existentes = {r["name"] for r in conn.execute(f"PRAGMA table_info({tabla})")}
                for col, tipo in columnas.items():
                    if col not in existentes:
                        conn.execute(f"ALTER TABLE {tabla} ADD COLUMN {col} {tipo}")
            conn.execute("UPDATE jugadores SET modelo = ? WHERE modelo IS NULL AND estado != 'invitado'", (MODELO_LEGADO,))
            # Jugadores inscritos antes de la tabla "fotos": su embedding pasa a ser su primera foto.
            # (Los invitados no tienen biometría: embedding '[]'.)
            conn.execute(
                """
                INSERT INTO fotos (jugador_id, embedding, modelo, origen, creado_en)
                SELECT id, embedding, modelo, 'inscripcion', creado_en FROM jugadores
                WHERE id NOT IN (SELECT DISTINCT jugador_id FROM fotos)
                  AND estado != 'invitado' AND embedding != '[]'
                """
            )
            _crear_esquema_flujos(conn)
            # Siembra y migración de categorías: Sub-10 + toda categoría de texto libre ya usada por un jugador.
            conn.execute("UPDATE jugadores SET categoria = NULL WHERE trim(coalesce(categoria, '')) = ''")
            if conn.execute("SELECT COUNT(*) FROM categorias").fetchone()[0] == 0:
                conn.execute("INSERT INTO categorias (nombre, orden) VALUES (?, 1)", (CATEGORIA_INICIAL,))
            for (nombre,) in conn.execute("SELECT DISTINCT categoria FROM jugadores WHERE categoria IS NOT NULL").fetchall():
                fila = conn.execute("SELECT nombre FROM categorias WHERE nombre = ?", (nombre,)).fetchone()
                if fila is None:
                    orden = conn.execute("SELECT coalesce(MAX(orden), 0) + 1 FROM categorias").fetchone()[0]
                    conn.execute("INSERT INTO categorias (nombre, orden) VALUES (?, ?)", (nombre, orden))
                elif fila["nombre"] != nombre:  # misma categoría con otra capitalización: se unifica
                    conn.execute("UPDATE jugadores SET categoria = ? WHERE categoria = ?", (fila["nombre"], nombre))

    # ------------------------------------------------------------ categorías

    def listar_categorias(self, incluir_inactivas: bool = True) -> list[dict]:
        with self.conexion() as conn:
            rows = conn.execute(
                "SELECT c.id, c.nombre, c.orden, c.activa, "
                "(SELECT COUNT(*) FROM jugadores j WHERE j.categoria = c.nombre) AS jugadores "
                "FROM categorias c ORDER BY c.orden, c.nombre COLLATE NOCASE"
            ).fetchall()
        return [{**dict(r), "activa": bool(r["activa"])} for r in rows if r["activa"] or incluir_inactivas]

    def crear_categoria(self, nombre: str, orden: int | None = None) -> dict:
        nombre = normalizar_categoria(nombre)
        with self.conexion() as conn:
            if conn.execute("SELECT 1 FROM categorias WHERE nombre = ?", (nombre,)).fetchone():
                raise CategoriaInvalida(f"La categoría «{nombre}» ya existe.")
            if orden is None:
                orden = conn.execute("SELECT coalesce(MAX(orden), 0) + 1 FROM categorias").fetchone()[0]
            cur = conn.execute("INSERT INTO categorias (nombre, orden) VALUES (?, ?)", (nombre, orden))
            return {"id": cur.lastrowid, "nombre": nombre, "orden": orden, "activa": True, "jugadores": 0}

    def actualizar_categoria(self, cat_id: int, nombre: str | None = None, orden: int | None = None,
                             activa: bool | None = None) -> dict | None:
        """Renombra (y actualiza a sus jugadores), reordena o activa/desactiva. None si no existe."""
        with self.conexion() as conn:
            fila = conn.execute("SELECT * FROM categorias WHERE id = ?", (cat_id,)).fetchone()
            if fila is None:
                return None
            if nombre is not None:
                nombre = normalizar_categoria(nombre)
                otra = conn.execute("SELECT 1 FROM categorias WHERE nombre = ? AND id != ?", (nombre, cat_id)).fetchone()
                if otra:
                    raise CategoriaInvalida(f"La categoría «{nombre}» ya existe.")
                conn.execute("UPDATE categorias SET nombre = ? WHERE id = ?", (nombre, cat_id))
                conn.execute("UPDATE jugadores SET categoria = ? WHERE categoria = ?", (nombre, fila["nombre"]))
            if orden is not None:
                conn.execute("UPDATE categorias SET orden = ? WHERE id = ?", (int(orden), cat_id))
            if activa is not None:
                conn.execute("UPDATE categorias SET activa = ? WHERE id = ?", (1 if activa else 0, cat_id))
        return next((c for c in self.listar_categorias() if c["id"] == cat_id), None)

    def resolver_categoria(self, nombre: str, crear_si_falta: bool = True) -> str | None:
        """Nombre canónico de la categoría para una inscripción. Vacío -> None. Si no existe se crea
        (compatibilidad con el frontend, que ofrece una lista fija); si existe pero está desactivada, error."""
        if not (nombre or "").strip():
            return None
        nombre = normalizar_categoria(nombre)
        with self.conexion() as conn:
            fila = conn.execute("SELECT nombre, activa FROM categorias WHERE nombre = ?", (nombre,)).fetchone()
        if fila is not None:
            if not fila["activa"]:
                raise CategoriaInvalida(f"La categoría «{fila['nombre']}» está desactivada en esta sede.")
            return fila["nombre"]
        if not crear_si_falta:
            raise CategoriaInvalida(f"La categoría «{nombre}» no existe en esta sede.")
        return self.crear_categoria(nombre)["nombre"]

    # ------------------------------------------------------------ jugadores

    def insert_jugador(self, nombre: str, embedding: list[float], categoria: str | None = None,
                       modelo: str = MODELO_LEGADO, fotos_extra: list[list[float]] | None = None,
                       consentimiento_tutor: str | None = None) -> int:
        """Inscribe un jugador. `embedding` es la foto principal; `fotos_extra` son fotos adicionales."""
        ahora = _now()
        with self.conexion() as conn:
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

    def add_foto(self, jugador_id: int, embedding: list[float], modelo: str, origen: str) -> None:
        """Agrega una foto a un jugador (p. ej. una corrección del staff), respetando MAX_FOTOS."""
        with self.conexion() as conn:
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

    def get_all_jugadores(self) -> list[dict]:
        """Retorna [{'id', 'nombre', 'categoria', 'estado', 'embedding', 'plantillas': [(modelo, embedding)]}, ...]."""
        with self.conexion() as conn:
            jugadores = conn.execute("SELECT id, nombre, categoria, modelo, estado, embedding FROM jugadores").fetchall()
            fotos = conn.execute("SELECT jugador_id, modelo, embedding FROM fotos ORDER BY id").fetchall()
        plantillas: dict[int, list] = {}
        for f in fotos:
            plantillas.setdefault(f["jugador_id"], []).append((f["modelo"], json.loads(f["embedding"])))
        return [
            {**dict(j), "embedding": json.loads(j["embedding"]), "plantillas": plantillas.get(j["id"], [])}
            for j in jugadores
        ]

    def plantillas_de(self, jugador_id: int) -> list:
        with self.conexion() as conn:
            fotos = conn.execute("SELECT modelo, embedding FROM fotos WHERE jugador_id = ? ORDER BY id",
                                 (jugador_id,)).fetchall()
        return [(f["modelo"], json.loads(f["embedding"])) for f in fotos]

    def list_jugadores(self, modelo: str | None = None) -> list[dict]:
        """Listado para el staff (sin embeddings), con total de asistencias y fotos del modelo dado."""
        with self.conexion() as conn:
            rows = conn.execute(
                """
                SELECT j.id, j.nombre, j.categoria, j.creado_en, coalesce(j.estado, 'activo') AS estado,
                       j.consentimiento_tutor, j.consentimiento_fecha,
                       (j.consentimiento_tutor IS NOT NULL OR EXISTS (
                            SELECT 1 FROM consentimientos c WHERE c.jugador_id = j.id AND c.retirado_en IS NULL
                       )) AS tiene_consentimiento,
                       (SELECT COUNT(*) FROM asistencia a WHERE a.jugador_id = j.id AND a.estado = 'valida') AS asistencias,
                       (SELECT MAX(timestamp) FROM asistencia a WHERE a.jugador_id = j.id AND a.estado = 'valida')
                           AS ultima_asistencia,
                       (SELECT COUNT(*) FROM fotos f WHERE f.jugador_id = j.id AND f.modelo = ?) AS fotos
                FROM jugadores j
                ORDER BY j.nombre COLLATE NOCASE
                """,
                (modelo or MODELO_LEGADO,),
            ).fetchall()
        return [{**dict(r), "tiene_consentimiento": bool(r["tiene_consentimiento"])} for r in rows]

    def set_consentimiento(self, jugador_id: int, tutor: str) -> bool:
        """Registra la autorización firmada del padre/madre/tutor para usar la cara del niño."""
        with self.conexion() as conn:
            cur = conn.execute(
                "UPDATE jugadores SET consentimiento_tutor = ?, consentimiento_fecha = ? WHERE id = ?",
                (tutor, _now(), jugador_id),
            )
            return cur.rowcount > 0

    def delete_jugador(self, jugador_id: int) -> bool:
        """Borra al jugador (y por cascada sus fotos y asistencias), sobrescribiendo las páginas liberadas."""
        with self.conexion() as conn:
            cur = conn.execute("DELETE FROM jugadores WHERE id = ?", (jugador_id,))
            borrado = cur.rowcount > 0
            if borrado:
                # Pendientes que apuntaban a él: se conservan, pero sin la referencia.
                conn.execute("UPDATE pendientes SET sugerido_id = NULL WHERE sugerido_id = ?", (jugador_id,))
                # El registro de puntajes se conserva (calibración) sin la referencia al jugador borrado.
                conn.execute("UPDATE verificaciones_log SET mejor_id = NULL WHERE mejor_id = ?", (jugador_id,))
                conn.execute("UPDATE verificaciones_log SET segundo_id = NULL WHERE segundo_id = ?", (jugador_id,))
        if borrado:
            self.retirar_consentimientos(jugador_id)
            self.limpiar_wal()  # que el WAL no conserve los datos borrados
        return borrado

    # ------------------------------------------------------------ asistencia

    def asistio_hoy(self, jugador_id: int, fecha: str | None = None) -> str | None:
        """Timestamp de la asistencia VÁLIDA del día (hoy por defecto, o `fecha` YYYY-MM-DD) si ya existe."""
        with self.conexion() as conn:
            row = conn.execute(
                "SELECT timestamp FROM asistencia a WHERE jugador_id = ? AND date(timestamp) = ? AND "
                f"{VALIDA} ORDER BY timestamp LIMIT 1",
                (jugador_id, fecha or date.today().isoformat()),
            ).fetchone()
        return row["timestamp"] if row else None

    def registrar_asistencia(self, jugador_id: int, origen: str = "facial", timestamp: str | None = None,
                             similitud: float | None = None) -> int:
        with self.conexion() as conn:
            cur = conn.execute(
                "INSERT INTO asistencia (jugador_id, timestamp, origen, similitud) VALUES (?, ?, ?, ?)",
                (jugador_id, timestamp or _now(), origen, None if similitud is None else round(float(similitud), 4)),
            )
            return cur.lastrowid

    def get_asistencias(self, limit: int = 50, solo_hoy: bool = False, fecha: str | None = None,
                        incluir_anuladas: bool = False) -> list[dict]:
        """fecha en formato YYYY-MM-DD; solo_hoy equivale a fecha=hoy. Incluye las disputadas (marcadas por
        `estado`); las anuladas solo con incluir_anuladas."""
        if solo_hoy and not fecha:
            fecha = date.today().isoformat()
        conds, params = [], []
        if fecha:
            conds.append("date(a.timestamp) = ?")
            params.append(fecha)
        if not incluir_anuladas:
            conds.append("a.estado != 'anulada'")
        where = f"WHERE {' AND '.join(conds)}" if conds else ""
        with self.conexion() as conn:
            rows = conn.execute(
                f"""
                SELECT a.id, a.jugador_id, j.nombre, j.categoria, coalesce(j.estado, 'activo') AS jugador_estado,
                       a.timestamp, a.origen, a.estado, a.motivo
                FROM asistencia a JOIN jugadores j ON j.id = a.jugador_id
                {where}
                ORDER BY a.timestamp DESC
                LIMIT ?
                """,
                (*params, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    def llegadas_hoy(self) -> int:
        """Niños distintos con asistencia válida hoy."""
        with self.conexion() as conn:
            return conn.execute(f"SELECT COUNT(DISTINCT jugador_id) FROM asistencia a WHERE date(timestamp) = ? "
                                f"AND {VALIDA}", (date.today().isoformat(),)).fetchone()[0]

    # ------------------------------------------------------------ respaldos

    def crear_respaldo(self, etiqueta: str = "auto") -> Path:
        """Copia consistente de la BD (API de backup de SQLite, segura aunque la BD esté en uso)."""
        self.respaldos_dir.mkdir(parents=True, exist_ok=True)
        # Milisegundos en el nombre: dos respaldos en el mismo segundo no se pisan.
        sello = f"{datetime.now():%Y-%m-%d_%H%M%S%f}"[:-3]
        destino = self.respaldos_dir / f"asistencia_{sello}_{etiqueta}.db"
        with self.conexion() as origen:
            copia = sqlite3.connect(destino)
            try:
                origen.backup(copia)
            finally:
                copia.close()
        # Rotación: se conservan los MAX_RESPALDOS más recientes.
        for viejo in self.listar_respaldos()[MAX_RESPALDOS:]:
            (self.respaldos_dir / viejo["nombre"]).unlink(missing_ok=True)
        return destino

    def listar_respaldos(self) -> list[dict]:
        """Respaldos del más reciente al más antiguo."""
        if not self.respaldos_dir.exists():
            return []
        archivos = sorted(self.respaldos_dir.glob("asistencia_*.db"), key=lambda p: p.name, reverse=True)
        return [{"nombre": p.name, "bytes": p.stat().st_size,
                 "creado": datetime.fromtimestamp(p.stat().st_mtime).isoformat(sep=" ", timespec="seconds")}
                for p in archivos]

    def respaldo_de_hoy_existe(self) -> bool:
        return any(r["nombre"].startswith(f"asistencia_{date.today():%Y-%m-%d}") for r in self.listar_respaldos())

    def purgar_de_respaldos(self, jugador_id: int) -> dict:
        """Borra al jugador (fila, fotos/embeddings y asistencias) de cada respaldo de la sede y compacta el
        archivo (VACUUM) para que los datos no queden en páginas libres. Conserva la fecha del archivo.
        Retorna {"purgados": n, "errores": [nombres]}. Un respaldo que falle se informa, no se borra."""
        def borrar(conn, tablas) -> bool:
            if "jugadores" not in tablas:
                return False
            if not conn.execute("SELECT COUNT(*) FROM jugadores WHERE id = ?", (jugador_id,)).fetchone()[0]:
                return False
            for t in ("fotos", "asistencia"):
                if t in tablas:
                    conn.execute(f"DELETE FROM {t} WHERE jugador_id = ?", (jugador_id,))
            conn.execute("DELETE FROM jugadores WHERE id = ?", (jugador_id,))
            return True
        return self._purgar_respaldos(borrar)

    def purgar_solicitud_de_respaldos(self, solicitud_id: int) -> dict:
        """Borra una solicitud rechazada (embeddings, miniatura, datos del tutor) de los respaldos de la sede."""
        def borrar(conn, tablas) -> bool:
            if "solicitudes" not in tablas:
                return False
            n = conn.execute("DELETE FROM solicitudes WHERE id = ?", (solicitud_id,)).rowcount
            if "consentimientos" in tablas:
                n += conn.execute("DELETE FROM consentimientos WHERE solicitud_id = ? AND jugador_id IS NULL",
                                  (solicitud_id,)).rowcount
            return n > 0
        return self._purgar_respaldos(borrar)

    def _purgar_respaldos(self, borrar) -> dict:
        purgados, errores = 0, []
        if not self.respaldos_dir.exists():
            return {"purgados": 0, "errores": []}
        for archivo in self.respaldos_dir.glob("asistencia_*.db"):
            st = archivo.stat()
            try:
                conn = sqlite3.connect(archivo, timeout=5)
                try:
                    tablas = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                    if not borrar(conn, tablas):
                        conn.rollback()
                        continue
                    conn.commit()
                    conn.execute("VACUUM")
                finally:
                    conn.close()
                os.utime(archivo, (st.st_atime, st.st_mtime))
                purgados += 1
            except sqlite3.Error:
                errores.append(archivo.name)
        return {"purgados": purgados, "errores": errores}

    # ------------------------------------------------------------ jornadas y reportes

    def set_tipo_jornada(self, fecha: str, tipo: str) -> None:
        if tipo not in TIPOS_JORNADA:
            raise ValueError(f"Tipo de jornada inválido: {tipo}")
        with self.conexion() as conn:
            conn.execute(
                "INSERT INTO sesiones (fecha, tipo) VALUES (?, ?) ON CONFLICT(fecha) DO UPDATE SET tipo = excluded.tipo",
                (fecha, tipo),
            )

    def get_tipos_jornada(self, desde: str, hasta: str) -> dict[str, str]:
        """{fecha: tipo} de los días marcados en el rango (los no marcados son entrenamiento)."""
        with self.conexion() as conn:
            rows = conn.execute("SELECT fecha, tipo FROM sesiones WHERE fecha BETWEEN ? AND ?",
                                (desde, hasta)).fetchall()
        return {r["fecha"]: r["tipo"] for r in rows}

    def asistencias_por_dia(self, desde: str, hasta: str) -> list[tuple[int, str]]:
        """Pares únicos (jugador_id, fecha YYYY-MM-DD) con asistencia en el rango."""
        with self.conexion() as conn:
            rows = conn.execute(
                "SELECT DISTINCT jugador_id, date(timestamp) AS fecha FROM asistencia a "
                f"WHERE date(timestamp) BETWEEN ? AND ? AND {VALIDA}",
                (desde, hasta),
            ).fetchall()
        return [(r["jugador_id"], r["fecha"]) for r in rows]
