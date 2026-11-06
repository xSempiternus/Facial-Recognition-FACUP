"""Registro de sedes (multi-tenant): una base SQLite por sede + un registro de control.

Estructura en disco (DATA_DIR, por defecto <repo>/data):
    control.db                         registro de sedes: slug, nombre, hash del PIN, creada_en, activa
    sedes/<slug>/asistencia.db         jugadores, fotos, asistencia, categorías... (esquema de db_manager)
    sedes/<slug>/config.json           modelo, detector, umbral, antispoofing de esa sede
    sedes/<slug>/respaldos/            respaldos de esa sede
    voz/                               caché de audio compartida (solo nombres de pila)
"""

import hashlib
import hmac
import os
import re
import secrets
import shutil
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

DATA_DIR = Path(os.getenv("DATA_DIR", str(Path(__file__).resolve().parent.parent / "data"))).resolve()
SEDES_DIR = DATA_DIR / "sedes"
CONTROL_DB = DATA_DIR / "control.db"
DEFAULT_SEDE = os.getenv("DEFAULT_SEDE", "las-condes")
SLUG_RE = re.compile(r"^[a-z0-9-]{2,40}$")
# Sede a la que se migra la instalación anterior (una sola base en data/asistencia.db).
SEDE_LEGADO = ("las-condes", "Sede Las Condes")
_PBKDF2_ITER = 200_000


class SedeNoExiste(LookupError):
    """El slug no es válido, no existe o la sede está desactivada."""


def slug_valido(slug: str | None) -> bool:
    return bool(slug) and bool(SLUG_RE.match(slug))


def carpeta(slug: str) -> Path:
    """Carpeta de la sede. Solo acepta slugs válidos (evita path traversal)."""
    if not slug_valido(slug):
        raise SedeNoExiste(slug)
    ruta = (SEDES_DIR / slug).resolve()
    if ruta.parent != SEDES_DIR.resolve():
        raise SedeNoExiste(slug)
    return ruta


def ruta_db(slug: str) -> Path:
    return carpeta(slug) / "asistencia.db"


def ruta_config(slug: str) -> Path:
    return carpeta(slug) / "config.json"


# ---------------------------------------------------------------- PIN

def hash_pin(pin: str) -> str:
    sal = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pin.encode(), sal, _PBKDF2_ITER)
    return f"pbkdf2_sha256${_PBKDF2_ITER}${sal.hex()}${dk.hex()}"


def pin_correcto(pin: str, guardado: str) -> bool:
    try:
        _, iters, sal, dk = guardado.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(sal), int(iters))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(calc.hex(), dk)


# ---------------------------------------------------------------- registro de control

@contextmanager
def _control():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(CONTROL_DB, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_control() -> None:
    with _control() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sedes (
                slug TEXT PRIMARY KEY,
                nombre TEXT NOT NULL,
                pin_hash TEXT NOT NULL,
                creada_en DATETIME NOT NULL,
                activa INTEGER NOT NULL DEFAULT 1
            )
            """
        )


def obtener(slug: str | None) -> dict:
    """{slug, nombre, creada_en, activa} de una sede activa; SedeNoExiste si no."""
    if not slug_valido(slug):
        raise SedeNoExiste(slug)
    with _control() as conn:
        row = conn.execute("SELECT slug, nombre, creada_en, activa FROM sedes WHERE slug = ?", (slug,)).fetchone()
    if row is None or not row["activa"] or not ruta_db(slug).exists():
        raise SedeNoExiste(slug)
    return dict(row)


def existe(slug: str | None) -> bool:
    try:
        obtener(slug)
        return True
    except SedeNoExiste:
        return False


def listar(solo_activas: bool = True) -> list[dict]:
    with _control() as conn:
        rows = conn.execute("SELECT slug, nombre, creada_en, activa FROM sedes ORDER BY slug").fetchall()
    return [dict(r) for r in rows if r["activa"] or not solo_activas]


def verificar_pin(slug: str, pin: str) -> bool:
    if not slug_valido(slug):
        return False
    with _control() as conn:
        row = conn.execute("SELECT pin_hash, activa FROM sedes WHERE slug = ?", (slug,)).fetchone()
    return bool(row and row["activa"]) and pin_correcto(pin, row["pin_hash"])


def cambiar_pin(slug: str, pin: str) -> bool:
    with _control() as conn:
        return conn.execute("UPDATE sedes SET pin_hash = ? WHERE slug = ?", (hash_pin(pin), slug)).rowcount > 0


def crear(slug: str, nombre: str, pin: str, origen_db: Path | None = None) -> dict:
    """Crea la sede (carpeta, BD con su esquema y categoría Sub-10, registro). Si `origen_db` se da,
    la BD de la sede es una copia consistente de esa base (migración)."""
    from src.db_manager import Base  # import tardío: db_manager no depende de este módulo

    if not slug_valido(slug):
        raise ValueError("El slug debe tener 2-40 caracteres: minúsculas, números y guiones.")
    nombre = (nombre or "").strip()
    if not nombre:
        raise ValueError("El nombre de la sede es obligatorio.")
    if not pin:
        raise ValueError("El PIN es obligatorio.")
    init_control()
    with _control() as conn:
        if conn.execute("SELECT 1 FROM sedes WHERE slug = ?", (slug,)).fetchone():
            raise ValueError(f"La sede '{slug}' ya existe.")
    dir_sede = carpeta(slug)
    (dir_sede / "respaldos").mkdir(parents=True, exist_ok=True)
    destino = dir_sede / "asistencia.db"
    if origen_db is not None and not destino.exists():
        tmp = destino.with_suffix(".db.tmp")
        tmp.unlink(missing_ok=True)
        src = sqlite3.connect(f"file:{origen_db.as_posix()}?mode=ro", uri=True)
        dst = sqlite3.connect(tmp)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        tmp.replace(destino)
    Base(destino).init_db()  # crea/migra el esquema y siembra categorías
    with _control() as conn:
        conn.execute(
            "INSERT INTO sedes (slug, nombre, pin_hash, creada_en, activa) VALUES (?, ?, ?, ?, 1)",
            (slug, nombre, hash_pin(pin), datetime.now().isoformat(sep=" ", timespec="seconds")),
        )
    return obtener(slug)


def migrar_legado(pin: str) -> str | None:
    """Idempotente. Si existe data/asistencia.db (instalación de una sola sede) y la sede de legado no está
    registrada, la crea copiando BD, config y respaldos. El original queda como asistencia.db.migrado (nunca
    se borra). Si no hay ninguna sede, crea la sede por defecto vacía. Retorna un mensaje si hizo algo."""
    init_control()
    slug, nombre = SEDE_LEGADO
    legado = DATA_DIR / "asistencia.db"
    with _control() as conn:
        registrada = conn.execute("SELECT 1 FROM sedes WHERE slug = ?", (slug,)).fetchone() is not None
        hay_sedes = conn.execute("SELECT 1 FROM sedes LIMIT 1").fetchone() is not None
    if legado.exists() and not registrada:
        dir_sede = carpeta(slug)
        dir_sede.mkdir(parents=True, exist_ok=True)
        cfg = DATA_DIR / "config.json"
        if cfg.exists() and not (dir_sede / "config.json").exists():
            shutil.copy2(cfg, dir_sede / "config.json")
        resp = DATA_DIR / "respaldos"
        (dir_sede / "respaldos").mkdir(exist_ok=True)
        if resp.is_dir():
            for f in resp.glob("asistencia_*.db"):
                if not (dir_sede / "respaldos" / f.name).exists():
                    shutil.copy2(f, dir_sede / "respaldos" / f.name)
        crear(slug, nombre, pin, origen_db=legado)
        marcado = legado.with_name("asistencia.db.migrado")
        try:
            # Vuelca el WAL al archivo principal para que el .migrado quede completo por sí solo.
            c = sqlite3.connect(legado, timeout=5)
            try:
                c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            finally:
                c.close()
            if not marcado.exists():
                legado.replace(marcado)
        except (OSError, sqlite3.Error) as exc:  # p. ej. otro proceso la tiene abierta: se deja tal cual (la sede ya existe)
            return f"Sede '{slug}' creada desde data/asistencia.db (no se pudo renombrar el original: {exc})."
        return f"Sede '{slug}' creada desde data/asistencia.db (original conservado como asistencia.db.migrado)."
    if not hay_sedes and not registrada:
        nombre_def = nombre if DEFAULT_SEDE == slug else DEFAULT_SEDE
        crear(DEFAULT_SEDE, nombre_def, pin)
        return f"Sede por defecto '{DEFAULT_SEDE}' creada (vacía)."
    return None
