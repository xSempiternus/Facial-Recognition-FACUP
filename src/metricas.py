"""Métricas de asistencia para el panel del staff (solo lectura, consultas agregadas).

Reglas comunes:
  - Solo cuentan asistencias VÁLIDAS (se excluyen anuladas y disputadas).
  - Inscritos (jugadores.estado = 'activo') e invitados ('invitado') se separan: los porcentajes son solo de inscritos.
  - Jornada = fecha con >=1 asistencia válida (de cualquiera) o marcada en `sesiones` (/jornadas).
    (Hoy /jornadas solo distingue entrenamiento/partido: no existe "día sin entrenamiento".)
  - Esperados de una fecha = inscritos activos con creado_en <= esa fecha (y de la categoría, si se pide).
  - Fechas locales: las mismas que usa el resto del sistema (hora local del servidor, que corre en Chile).
"""

import bisect
from collections import defaultdict
from datetime import date, timedelta

from src.db_manager import VALIDA
from src.reportes import UMBRAL_AUSENCIAS

MAX_DIAS = 366
DIAS_DEFECTO = 60
SIN_CATEGORIA = "Sin categoría"
ORIGEN = {"facial": "reconocimiento", "manual": "manual", "correccion": "correccion", "invitado": "invitado"}


def _pct(parte: int, total: int) -> int:
    return int(100 * parte / total + 0.5) if total else 0


def _jugadores(conn, categoria: str | None) -> list[dict]:
    sql = ("SELECT id, nombre, categoria, coalesce(estado, 'activo') AS estado, "
           "substr(coalesce(creado_en, ''), 1, 10) AS alta FROM jugadores")
    params: tuple = ()
    if categoria:
        sql += " WHERE categoria = ? COLLATE NOCASE"
        params = (categoria,)
    return [dict(r) for r in conn.execute(sql + " ORDER BY nombre COLLATE NOCASE, id", params)]


def _primeras(conn, desde: str, hasta: str) -> list:
    """Una fila por (jugador, fecha) con asistencia válida: la primera llegada del día y su origen."""
    return conn.execute(
        "SELECT a.jugador_id AS jid, date(a.timestamp) AS fecha, MIN(a.timestamp) AS ts, a.origen AS origen "
        f"FROM asistencia a WHERE date(a.timestamp) BETWEEN ? AND ? AND {VALIDA} "
        "GROUP BY a.jugador_id, date(a.timestamp)", (desde, hasta)).fetchall()


def _hm(ts: str) -> str:
    return ts[11:16]


def hoy(db, categoria: str | None = None, fecha: str | None = None) -> dict:
    fecha = fecha or date.today().isoformat()
    with db.conexion() as conn:
        jug = {j["id"]: j for j in _jugadores(conn, categoria)}
        filas = _primeras(conn, fecha, fecha)
        pendientes = conn.execute("SELECT COUNT(*) FROM pendientes").fetchone()[0]
        solicitudes = conn.execute("SELECT COUNT(*) FROM solicitudes").fetchone()[0]
    llegaron, invitados, vistos = [], [], set()
    for r in sorted(filas, key=lambda r: (r["ts"], r["jid"])):
        j = jug.get(r["jid"])
        if j is None:
            continue
        if j["estado"] == "activo":
            vistos.add(j["id"])
            llegaron.append({"id": j["id"], "nombre": j["nombre"], "categoria": j["categoria"], "hora": _hm(r["ts"]),
                             "origen": ORIGEN.get(r["origen"] or "facial", r["origen"])})
        elif j["estado"] == "invitado":
            invitados.append({"id": j["id"], "nombre": j["nombre"], "categoria": j["categoria"], "hora": _hm(r["ts"])})
    esperados = [j for j in jug.values() if j["estado"] == "activo" and j["alta"] <= fecha]
    faltan = [{"id": j["id"], "nombre": j["nombre"], "categoria": j["categoria"]}
              for j in esperados if j["id"] not in vistos]
    # Curva acumulada por cuartos de hora, desde la primera hasta la última llegada (con tramos planos).
    acumulado = []
    if llegaron:
        por_cuarto: dict[int, int] = defaultdict(int)
        for l in llegaron:
            por_cuarto[int(l["hora"][:2]) * 60 + int(l["hora"][3:]) // 15 * 15] += 1
        total = 0
        for t in range(min(por_cuarto), max(por_cuarto) + 1, 15):
            total += por_cuarto.get(t, 0)
            acumulado.append({"hora": f"{t // 60:02d}:{t % 60:02d}", "total": total})
    return {
        "fecha": fecha, "esperados": len(esperados), "llegaron": llegaron, "faltan": faltan, "invitados": invitados,
        "por_revisar": {"pendientes": pendientes, "solicitudes": solicitudes},
        "porcentaje": _pct(len(llegaron), len(esperados)),
        "ultima_llegada": llegaron[-1]["hora"] if llegaron else None,
        "acumulado": acumulado,
    }


def resumen(db, desde: str, hasta: str, categoria: str | None = None, hoy_fecha: str | None = None) -> dict:
    """La jornada de hoy se excluye de `jornadas` y de los conteos (está en curso: quien aún no llega no es una
    ausencia); se ve en /metricas/hoy.

    Regla de rachas (coherente con `ultima_asistencia`, que sí incluye hoy), cuando hoy cae dentro del rango:
      - Si el niño ya llegó hoy: `faltas_seguidas` = 0 y `racha_actual` = jornadas cerradas seguidas + 1 (hoy).
      - Si aún no llegó hoy: hoy NO cuenta como falta; ambas se calculan solo con jornadas cerradas.
    `en_riesgo` usa las mismas `faltas_seguidas`, así que quien llegó hoy sale del riesgo."""
    hoy_fecha = hoy_fecha or date.today().isoformat()
    with db.conexion() as conn:
        jug = _jugadores(conn, categoria)
        filas = _primeras(conn, desde, hasta)
        marcadas = {r[0] for r in conn.execute("SELECT fecha FROM sesiones WHERE fecha BETWEEN ? AND ?", (desde, hasta))}
        # Jornadas: cualquier asistencia válida de la sede (sin filtrar por categoría) o día marcado.
        fechas_sede = {r[0] for r in conn.execute(
            f"SELECT DISTINCT date(a.timestamp) FROM asistencia a WHERE date(a.timestamp) BETWEEN ? AND ? AND {VALIDA}",
            (desde, hasta))}
        ultimas = {r[0]: r[1] for r in conn.execute(
            f"SELECT a.jugador_id, MAX(date(a.timestamp)) FROM asistencia a WHERE {VALIDA} GROUP BY a.jugador_id")}
    por_id = {j["id"]: j for j in jug}
    llego_hoy = {r["jid"] for r in filas if r["fecha"] == hoy_fecha}  # asistencia válida de hoy (si hoy está en el rango)
    fechas = sorted((fechas_sede | marcadas) - {hoy_fecha})
    en_jornada = set(fechas)

    presentes_de: dict[int, set[str]] = defaultdict(set)
    invitados_dia: dict[str, set[int]] = defaultdict(set)
    metodos = {"reconocimiento": 0, "manual": 0, "correccion": 0, "invitado": 0}
    horas_min: list[int] = []
    histo: dict[int, int] = defaultdict(int)
    for r in filas:
        j = por_id.get(r["jid"])
        if j is None or r["fecha"] not in en_jornada:
            continue
        m = ORIGEN.get(r["origen"] or "facial")
        if m:
            metodos[m] += 1
        if j["estado"] == "activo":
            if r["fecha"] < j["alta"]:
                continue
            presentes_de[j["id"]].add(r["fecha"])
            hh, mm = int(r["ts"][11:13]), int(r["ts"][14:16])
            horas_min.append(hh * 60 + mm)
            histo[hh] += 1
        elif j["estado"] == "invitado":
            invitados_dia[r["fecha"]].add(j["id"])

    activos = [j for j in jug if j["estado"] == "activo"]
    altas = sorted(j["alta"] for j in activos)
    pres_dia: dict[str, int] = defaultdict(int)
    for fs in presentes_de.values():
        for f in fs:
            pres_dia[f] += 1
    jornadas = []
    for f in fechas:
        esp = bisect.bisect_right(altas, f)
        p = pres_dia.get(f, 0)
        jornadas.append({"fecha": f, "presentes": p, "esperados": esp, "porcentaje": _pct(p, esp),
                         "invitados": len(invitados_dia.get(f, ()))})

    ninos, en_riesgo, por_cat = [], [], {}
    for j in activos:
        posibles = [f for f in fechas if f >= j["alta"]]
        pres = presentes_de[j["id"]]
        dias = {f: ("presente" if f in pres else "ausente") for f in posibles}
        asist = len(pres)
        racha = faltas = 0
        ya_llego = j["id"] in llego_hoy and hoy_fecha >= j["alta"]
        if not ya_llego:
            for f in reversed(posibles):
                if f in pres:
                    break
                faltas += 1
        for f in reversed(posibles):
            if f not in pres:
                break
            racha += 1
        if ya_llego:
            racha += 1
        cat = j["categoria"] or SIN_CATEGORIA
        c = por_cat.setdefault(cat, {"categoria": cat, "presentes": 0, "esperados": 0, "ninos": 0})
        c["presentes"] += asist
        c["esperados"] += len(posibles)
        c["ninos"] += 1
        ninos.append({"id": j["id"], "nombre": j["nombre"], "categoria": j["categoria"], "estado": j["estado"],
                      "presentes": asist, "jornadas_total": len(posibles), "porcentaje": _pct(asist, len(posibles)),
                      "racha_actual": racha, "faltas_seguidas": faltas, "ultima_asistencia": ultimas.get(j["id"]),
                      "dias": dias})
        if faltas >= UMBRAL_AUSENCIAS:
            en_riesgo.append({"id": j["id"], "nombre": j["nombre"], "categoria": j["categoria"],
                              "faltas_seguidas": faltas})
    en_riesgo.sort(key=lambda x: (-x["faltas_seguidas"], x["nombre"].lower()))
    categorias = [{**c, "porcentaje": _pct(c["presentes"], c["esperados"])} for c in por_cat.values()]
    categorias.sort(key=lambda c: (c["categoria"] == SIN_CATEGORIA, c["categoria"].lower()))

    con_esp = [x for x in jornadas if x["esperados"] > 0]
    mejor = max(con_esp, key=lambda x: (x["porcentaje"], x["fecha"]), default=None)
    peor = min(con_esp, key=lambda x: (x["porcentaje"], x["fecha"]), default=None)
    mediana = None
    if horas_min:
        o = sorted(horas_min)
        k = len(o) // 2
        med = o[k] if len(o) % 2 else (o[k - 1] + o[k]) // 2
        mediana = f"{med // 60:02d}:{med % 60:02d}"
    prom = int(sum(x["porcentaje"] for x in con_esp) / len(con_esp) + 0.5) if con_esp else 0
    return {
        "rango": {"desde": desde, "hasta": hasta, "categoria": categoria},
        "totales": {
            "ninos_activos": len(activos), "jornadas": len(jornadas), "promedio_asistencia": prom,
            "mejor_jornada": {"fecha": mejor["fecha"], "porcentaje": mejor["porcentaje"]} if mejor else None,
            "peor_jornada": {"fecha": peor["fecha"], "porcentaje": peor["porcentaje"]} if peor else None,
        },
        "jornadas": jornadas, "ninos": ninos, "categorias": categorias,
        "llegada": {"histograma": [{"hora": f"{h:02d}:00", "cantidad": histo[h]} for h in sorted(histo)],
                    "mediana": mediana},
        "metodos": metodos, "en_riesgo": en_riesgo,
    }


def rango_defecto(hasta: date | None = None) -> tuple[str, str]:
    hasta = hasta or date.today()
    return (hasta - timedelta(days=DIAS_DEFECTO - 1)).isoformat(), hasta.isoformat()


# ---------------------------------------------------------------- reconocimiento (calibración de umbrales)

MIN_VERIFICACIONES_SUGERENCIA = 30
TRAMO = 0.05
N_TRAMOS = 20  # puntajes de 0.00 a 1.00 en tramos de 0.05 (los negativos van al primero, 1.0 al último)
DIAS_RECONOCIMIENTO_MAX = 90  # retención del registro de puntajes


def _tramo(score: float) -> int:
    return max(0, min(N_TRAMOS - 1, int(score / TRAMO + 1e-9)))


def _mediana(valores: list[float]) -> float | None:
    if not valores:
        return None
    v = sorted(valores)
    n = len(v)
    return round(v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2, 4)


def reconocimiento(db, dias: int, umbral_auto: float, umbral_duda: float, margen_min: float) -> dict:
    """Resumen del registro de puntajes de /verify de los últimos `dias` días (sin biometría).
    total = aceptados + dudosos + rechazados (las capturas sin cara o con error van aparte)."""
    filas = db.verificaciones_desde(dias)
    claves = ("aceptados", "dudosos", "rechazados")
    nombre = {"aceptado": "aceptados", "dudoso": "dudosos", "rechazado": "rechazados"}
    hist = {k: [0] * N_TRAMOS for k in claves}
    conteo = dict.fromkeys(claves, 0)
    margenes, sin_cara, errores = [], 0, 0
    for f in filas:
        r = f["resultado"]
        if r == "sin_cara":
            sin_cara += 1
            continue
        if r not in nombre:
            errores += 1
            continue
        k = nombre[r]
        conteo[k] += 1
        if f["mejor_score"] is not None:
            hist[k][_tramo(f["mejor_score"])] += 1
        if r == "aceptado" and f["mejor_score"] is not None and f["segundo_score"] is not None:
            margenes.append(f["mejor_score"] - f["segundo_score"])
    total = sum(conteo.values())
    margen_med = _mediana(margenes)
    if total < MIN_VERIFICACIONES_SUGERENCIA:
        sugerencia = f"aún pocos datos (<{MIN_VERIFICACIONES_SUGERENCIA} verificaciones)"
    else:
        p_dud = conteo["dudosos"] / total
        if p_dud > 0.30:
            sugerencia = (f"Muchos casos dudosos ({round(100 * p_dud)} %). Si el staff confirma casi siempre la "
                          f"sugerencia, puedes bajar el umbral automático 0.02 (a {umbral_auto - 0.02:.2f}).")
        elif margen_med is not None and margen_med < 2 * margen_min:
            sugerencia = (f"El margen mediano de los aceptados es bajo ({margen_med:.3f}): hay niños muy parecidos. "
                          "No bajes los umbrales; considera subir el automático 0.02.")
        elif p_dud < 0.05 and conteo["rechazados"] / total < 0.10:
            sugerencia = "Los umbrales funcionan bien: pocos dudosos y pocos rechazos. No hace falta moverlos."
        else:
            sugerencia = "Los umbrales parecen razonables. Vuelve a revisar con más datos."
    return {
        "dias": dias,
        "total": total,
        **conteo,
        "sin_cara": sin_cara,
        "errores": errores,
        "tasa_auto": round(conteo["aceptados"] / total, 4) if total else 0.0,
        "tramos": [round(i * TRAMO, 2) for i in range(N_TRAMOS)],
        "histograma": hist,
        "margen_mediano_aceptados": margen_med,
        "umbrales": {"auto": umbral_auto, "duda": umbral_duda, "margen_min": margen_min},
        "sugerencia": sugerencia,
        **_sombra(filas),
    }


def _sombra(filas: list[dict]) -> dict:
    """Modo sombra (no decide nada): ensemble SFace en zona gris y cara recortada en el celular."""
    ens = [f for f in filas if f.get("score_sface") is not None]
    coinciden = sum(1 for f in ens if f.get("sface_coincide") == 1)
    con_staff = [f for f in ens if f.get("staff_id") is not None]
    corregidas = [f for f in con_staff if f.get("mejor_id") is not None and f["staff_id"] != f["mejor_id"]]
    cli = [f for f in filas if f.get("score_cliente") is not None]
    difs = [f["score_cliente"] - f["mejor_score"] for f in cli if f.get("mejor_score") is not None]
    return {
        "ensemble": {
            "modelo": "SFace",
            "n": len(ens),  # verificaciones en zona gris con dato SFace (jugadores con plantilla SFace)
            "coincide_pct": round(100 * coinciden / len(ens), 1) if ens else None,
            "fusion_mediana": _mediana([f["fusion_score"] for f in ens if f.get("fusion_score") is not None]),
            "con_decision_staff": len(con_staff),
            "staff_confirmo_primario": sum(1 for f in con_staff if f["staff_id"] == f.get("mejor_id")),
            "staff_corrigio_primario": len(corregidas),
            "sface_habria_acertado": sum(1 for f in corregidas if f.get("candidato_sface") == f["staff_id"]),
        },
        "recorte_celular": {
            "n": len(cli),
            "score_mediano": _mediana([f["score_cliente"] for f in cli]),
            "diferencia_mediana": _mediana(difs),  # score_cliente - score del servidor (mismo candidato)
            "ms_mediano": _mediana([f["ms_cliente"] for f in cli if f.get("ms_cliente") is not None]),
        },
    }
