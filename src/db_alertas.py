"""Seguimiento del staff sobre UNA sede (mixin de db_manager.Base, usa self.conexion()):

1) Alertas persistentes (tabla `alertas`), pensadas para que el staff contacte al apoderado y para que un futuro
   módulo de campañas por correo las lea directo de la BD. Hoy solo existe el tipo 'faltas_seguidas':
     - se crea (idempotente: UNA abierta por jugador y tipo, índice único parcial) cuando un inscrito activo llega a
       >= umbral faltas seguidas (config `umbral_faltas` de la sede, por defecto reportes.UMBRAL_AUSENCIAS = 3);
     - "faltas" = jornadas YA REALIZADAS de SU categoría (fechas pasadas con >=1 asistencia válida de un niño de esa
       categoría, más los días marcados en `sesiones`) desde su última asistencia válida y desde su alta. Hoy nunca
       cuenta como falta (la jornada está en curso). Sin categoría: jornadas de toda la sede;
     - se cierra sola (motivo_cierre 'asistio') cuando el niño vuelve a asistir; si el staff la cierra, no se vuelve
       a crear hasta que el niño asista y acumule una racha nueva;
     - estados: nueva -> vista -> contactada -> cerrada (el staff puede anotar una `nota`).
   Ciclo de vida de una racha: una alerta "pertenece" a la racha actual si se creó después de la última asistencia
   válida del niño. Si la asistencia que la cerró se anula, la alerta se reabre.

2) Revisión del staff de las asistencias del reconocimiento facial (`asistencia.revisado_por_staff` /
   `asistencia.revisado_en`, NULL = sin revisar): 'confirmado' (una por una), 'confirmado_lote' ("Confirmar todos
   los seguros"), 'no_es' (el staff dijo que no era él: la asistencia queda anulada).
"""

import sqlite3
from datetime import date, datetime, timedelta

TIPOS_ALERTA = ("faltas_seguidas",)
ESTADOS_ALERTA = ("nueva", "vista", "contactada", "cerrada")
ABIERTA = "estado != 'cerrada'"
MAX_NOTA = 500
# Hasta cuántos días atrás se miran las jornadas para contar faltas seguidas (más que suficiente para avisar).
VENTANA_DIAS = 180
REVISIONES = ("confirmado", "confirmado_lote", "no_es")
# Columnas de contacto del apoderado que PUEDEN existir en `jugadores` (otro módulo las agrega): se leen si están.
COLUMNAS_CONTACTO = ("tutor_nombre", "tutor_correo", "tutor_telefono")

_ESQUEMA = [
    """
    CREATE TABLE IF NOT EXISTS alertas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jugador_id INTEGER NOT NULL,
        tipo TEXT NOT NULL,
        valor INTEGER,
        creada_en DATETIME NOT NULL,
        estado TEXT NOT NULL DEFAULT 'nueva',
        nota TEXT,
        actualizada_por TEXT,
        actualizada_en DATETIME,
        cerrada_en DATETIME,
        motivo_cierre TEXT,
        FOREIGN KEY (jugador_id) REFERENCES jugadores(id) ON DELETE CASCADE
    )
    """,
    # Idempotencia: a lo más UNA alerta abierta por jugador y tipo (aunque dos evaluaciones corran a la vez).
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_alertas_abierta ON alertas (jugador_id, tipo) WHERE estado != 'cerrada'",
    "CREATE INDEX IF NOT EXISTS idx_alertas_estado ON alertas (estado, tipo)",
]


def _now() -> str:
    return datetime.now().isoformat(sep=" ", timespec="seconds")


def crear_esquema(conn) -> None:
    """Idempotente: tabla nueva sobre BDs existentes (las columnas de revisión viven en db_manager._MIGRACIONES)."""
    for sql in _ESQUEMA:
        conn.execute(sql)


def _jornadas(conn, hoy: str, desde: str) -> tuple[dict[str, set[str]], set[str], set[str]]:
    """({categoria en minúsculas: fechas realizadas}, fechas de toda la sede, días marcados), solo fechas < hoy."""
    por_cat: dict[str, set[str]] = {}
    sede: set[str] = set()
    for cat, f in conn.execute(
            "SELECT DISTINCT coalesce(j.categoria, ''), date(a.timestamp) FROM asistencia a "
            "JOIN jugadores j ON j.id = a.jugador_id "
            "WHERE a.estado = 'valida' AND date(a.timestamp) >= ? AND date(a.timestamp) < ?", (desde, hoy)):
        por_cat.setdefault(cat.lower(), set()).add(f)
        sede.add(f)
    marcadas = {r[0] for r in conn.execute("SELECT fecha FROM sesiones WHERE fecha >= ? AND fecha < ?", (desde, hoy))}
    for fechas in por_cat.values():
        fechas |= marcadas
    return por_cat, sede | marcadas, marcadas


def faltas_seguidas(conn, hoy: str | None = None) -> dict[int, tuple[int, str | None]]:
    """{jugador_id: (faltas seguidas, timestamp de su última asistencia válida)} de los inscritos activos."""
    hoy = hoy or date.today().isoformat()
    desde = (date.fromisoformat(hoy) - timedelta(days=VENTANA_DIAS)).isoformat()
    por_cat, sede, marcadas = _jornadas(conn, hoy, desde)
    ultimas = {r[0]: r[1] for r in conn.execute(
        "SELECT a.jugador_id, MAX(a.timestamp) FROM asistencia a WHERE a.estado = 'valida' GROUP BY a.jugador_id")}
    res = {}
    for jid, cat, alta in conn.execute(
            "SELECT id, categoria, substr(coalesce(creado_en, ''), 1, 10) FROM jugadores "
            "WHERE coalesce(estado, 'activo') = 'activo'"):
        ultima = ultimas.get(jid)
        u = (ultima or "")[:10]
        if u >= hoy:
            res[jid] = (0, ultima)
            continue
        fechas = por_cat.get(cat.lower(), marcadas) if cat else sede
        res[jid] = (sum(1 for f in fechas if f >= alta and f > u), ultima)
    return res


class AlertasDB:
    # ------------------------------------------------------------ alertas

    def evaluar_alertas(self, umbral: int, hoy: str | None = None) -> dict:
        """Crea / actualiza / cierra alertas 'faltas_seguidas'. Idempotente y barato (unas pocas consultas)."""
        umbral = max(1, int(umbral))
        creadas = actualizadas = cerradas = reabiertas = 0
        ahora = _now()
        with self.conexion() as conn:
            faltas = faltas_seguidas(conn, hoy)
            alertas: dict[int, list] = {}
            for r in conn.execute("SELECT id, jugador_id, estado, creada_en, valor, motivo_cierre FROM alertas "
                                  "WHERE tipo = 'faltas_seguidas' ORDER BY id"):
                alertas.setdefault(r["jugador_id"], []).append(r)
            for jid, lista in alertas.items():  # cierre automático: asistió después de crearse (o ya no es activo)
                n, ultima = faltas.get(jid, (None, None))
                for a in lista:
                    if a["estado"] == "cerrada":
                        continue
                    motivo = "inactivo" if n is None else "asistio" if ultima and ultima >= a["creada_en"] else None
                    if motivo:
                        conn.execute("UPDATE alertas SET estado = 'cerrada', cerrada_en = ?, motivo_cierre = ?, "
                                     "actualizada_por = 'sistema', actualizada_en = ? WHERE id = ?",
                                     (ahora, motivo, ahora, a["id"]))
                        cerradas += 1
            for jid, (n, ultima) in faltas.items():
                if n < umbral:
                    continue
                racha = [a for a in alertas.get(jid, []) if not ultima or a["creada_en"] > ultima]
                if not racha:
                    cur = conn.execute("INSERT OR IGNORE INTO alertas (jugador_id, tipo, valor, creada_en, estado) "
                                       "VALUES (?, 'faltas_seguidas', ?, ?, 'nueva')", (jid, n, ahora))
                    creadas += cur.rowcount
                    continue
                a = racha[-1]
                if a["estado"] != "cerrada":
                    if a["valor"] != n:
                        conn.execute("UPDATE alertas SET valor = ? WHERE id = ?", (n, a["id"]))
                        actualizadas += 1
                elif a["motivo_cierre"] == "asistio":  # la asistencia que la cerró se anuló: vuelve a abrirse
                    try:
                        conn.execute("UPDATE alertas SET estado = 'nueva', valor = ?, cerrada_en = NULL, "
                                     "motivo_cierre = NULL, actualizada_por = 'sistema', actualizada_en = ? "
                                     "WHERE id = ?", (n, ahora, a["id"]))
                        reabiertas += 1
                    except sqlite3.IntegrityError:
                        pass
        return {"creadas": creadas, "actualizadas": actualizadas, "cerradas": cerradas, "reabiertas": reabiertas}

    def cerrar_alertas_por_asistencia(self, jugador_id: int) -> int:
        """Al registrar una asistencia: cierra al instante las alertas abiertas del niño."""
        ahora = _now()
        with self.conexion() as conn:
            return conn.execute(
                "UPDATE alertas SET estado = 'cerrada', cerrada_en = ?, motivo_cierre = 'asistio', "
                f"actualizada_por = 'sistema', actualizada_en = ? WHERE jugador_id = ? AND {ABIERTA}",
                (ahora, ahora, jugador_id)).rowcount

    def contar_alertas(self) -> dict:
        """{'abiertas': n, 'por_contactar': n (nueva + vista)}."""
        with self.conexion() as conn:
            r = conn.execute(f"SELECT COUNT(*), coalesce(SUM(estado IN ('nueva', 'vista')), 0) FROM alertas "
                             f"WHERE {ABIERTA}").fetchone()
        return {"abiertas": r[0], "por_contactar": r[1]}

    def listar_alertas(self, incluir_cerradas: bool = False, limite: int = 500) -> list[dict]:
        """Alertas (abiertas por defecto) con nombre, categoría, última asistencia y contacto del apoderado si lo hay."""
        with self.conexion() as conn:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(jugadores)")}
            extra = "".join(f", j.{c} AS {c}" for c in COLUMNAS_CONTACTO if c in cols)
            filtro = "" if incluir_cerradas else f"WHERE a.{ABIERTA}"
            filas = [dict(r) for r in conn.execute(
                "SELECT a.id, a.jugador_id, a.tipo, a.valor, a.creada_en, a.estado, a.nota, a.actualizada_por, "
                "a.actualizada_en, a.cerrada_en, a.motivo_cierre, j.nombre, j.categoria, "
                f"j.consentimiento_tutor AS tutor{extra}, "
                "(SELECT MAX(date(s.timestamp)) FROM asistencia s WHERE s.jugador_id = a.jugador_id "
                "  AND s.estado = 'valida') AS ultima_asistencia, "
                "(SELECT c.contacto FROM consentimientos c WHERE c.jugador_id = a.jugador_id AND c.retirado_en IS NULL "
                "  ORDER BY c.id DESC LIMIT 1) AS contacto_consentimiento "
                f"FROM alertas a JOIN jugadores j ON j.id = a.jugador_id {filtro} "
                "ORDER BY CASE a.estado WHEN 'nueva' THEN 0 WHEN 'vista' THEN 1 WHEN 'contactada' THEN 2 ELSE 3 END, "
                "a.valor DESC, j.nombre COLLATE NOCASE LIMIT ?", (limite,))]
        for f in filas:
            correo, telefono = f.pop("tutor_correo", None), f.pop("tutor_telefono", None)
            nombre_tutor = f.pop("tutor_nombre", None) or f.pop("tutor", None)
            f.pop("tutor", None)
            otro = f.pop("contacto_consentimiento", None)
            f["contacto"] = ({"tutor": nombre_tutor, "correo": correo, "telefono": telefono, "otro": otro}
                             if any((nombre_tutor, correo, telefono, otro)) else None)
        return filas

    def actualizar_alerta(self, alerta_id: int, estado: str | None = None, nota: str | None = None) -> dict | None:
        """Cambio del staff. None si no existe. ValueError si el estado es inválido; sqlite3.IntegrityError si se
        intenta reabrir una alerta cuando el niño ya tiene otra abierta del mismo tipo."""
        if estado is not None and estado not in ESTADOS_ALERTA:
            raise ValueError("estado inválido")
        ahora = _now()
        with self.conexion() as conn:
            a = conn.execute("SELECT id, estado FROM alertas WHERE id = ?", (alerta_id,)).fetchone()
            if a is None:
                return None
            sets, params = ["actualizada_por = 'staff'", "actualizada_en = ?"], [ahora]
            if nota is not None:
                sets.append("nota = ?")
                params.append(" ".join(nota.split())[:MAX_NOTA] or None)
            if estado is not None and estado != a["estado"]:
                sets.append("estado = ?")
                params.append(estado)
                if estado == "cerrada":
                    sets += ["cerrada_en = ?", "motivo_cierre = 'staff'"]
                    params.append(ahora)
                else:
                    sets += ["cerrada_en = NULL", "motivo_cierre = NULL"]
            conn.execute(f"UPDATE alertas SET {', '.join(sets)} WHERE id = ?", (*params, alerta_id))
            return dict(conn.execute("SELECT id, jugador_id, tipo, valor, creada_en, estado, nota, actualizada_por, "
                                     "actualizada_en, cerrada_en, motivo_cierre FROM alertas WHERE id = ?",
                                     (alerta_id,)).fetchone())

    # ------------------------------------------------------------ revisión de asistencias faciales

    def revision_hoy(self, limite: float, fecha: str | None = None) -> dict:
        """Asistencias del reconocimiento facial de `fecha` (hoy): totales de revisión y las de similitud baja
        (< limite) que el staff aún no revisó. Las anuladas por el staff desde aquí ('no_es') cuentan como revisadas."""
        fecha = fecha or date.today().isoformat()
        with self.conexion() as conn:
            filas = [dict(r) for r in conn.execute(
                "SELECT a.id, a.jugador_id, j.nombre, j.categoria, a.timestamp, a.similitud, a.estado, "
                "a.revisado_por_staff, a.revisado_en FROM asistencia a JOIN jugadores j ON j.id = a.jugador_id "
                "WHERE date(a.timestamp) = ? AND coalesce(a.origen, 'facial') = 'facial' "
                "AND (a.estado = 'valida' OR (a.estado = 'anulada' AND a.revisado_por_staff = 'no_es')) "
                "ORDER BY a.timestamp, a.id", (fecha,))]
        baja = lambda f: f["similitud"] is not None and f["similitud"] < limite  # noqa: E731
        sin_revisar = [f for f in filas if f["revisado_en"] is None and f["estado"] == "valida"]
        return {
            "fecha": fecha,
            "limite": round(limite, 4),
            "total": len(filas),
            "revisados": sum(1 for f in filas if f["revisado_en"] is not None),
            "seguros_sin_revisar": sum(1 for f in sin_revisar if not baja(f)),
            "por_revisar": [{"asistencia_id": f["id"], "jugador_id": f["jugador_id"], "nombre": f["nombre"],
                             "categoria": f["categoria"], "timestamp": f["timestamp"],
                             "similitud": f["similitud"]} for f in sin_revisar if baja(f)],
        }

    def revisar_asistencia(self, aid: int, accion: str) -> str:
        """accion 'confirmado' | 'no_es'. Retorna 'ok' | 'no_existe' | 'no_valida'."""
        if accion not in ("confirmado", "no_es"):
            raise ValueError("acción inválida")
        ahora = _now()
        with self.conexion() as conn:
            r = conn.execute("SELECT estado FROM asistencia WHERE id = ?", (aid,)).fetchone()
            if r is None:
                return "no_existe"
            if r["estado"] != "valida":
                return "no_valida"
            if accion == "no_es":
                conn.execute("UPDATE asistencia SET estado = 'anulada', motivo = 'no_es_el: corregido por el staff', "
                             "anulada_en = ?, revisado_por_staff = 'no_es', revisado_en = ? WHERE id = ?",
                             (ahora, ahora, aid))
            else:
                conn.execute("UPDATE asistencia SET revisado_por_staff = 'confirmado', revisado_en = ? WHERE id = ?",
                             (ahora, aid))
        return "ok"

    def confirmar_seguros(self, limite: float, fecha: str | None = None) -> int:
        """Marca como revisadas ('confirmado_lote') las asistencias faciales válidas de `fecha` (hoy) sin revisar y con
        similitud >= limite (o sin similitud registrada: anteriores a la columna). Retorna cuántas."""
        with self.conexion() as conn:
            return conn.execute(
                "UPDATE asistencia SET revisado_por_staff = 'confirmado_lote', revisado_en = ? "
                "WHERE date(timestamp) = ? AND coalesce(origen, 'facial') = 'facial' AND estado = 'valida' "
                "AND revisado_en IS NULL AND (similitud IS NULL OR similitud >= ?)",
                (_now(), fecha or date.today().isoformat(), limite)).rowcount
