"""Cálculo de reportes de asistencia (función pura: recibe datos, no toca la BD)."""

# Ausencias seguidas a partir de las cuales se avisa al entrenador.
UMBRAL_AUSENCIAS = 3


def calcular_reporte(jugadores: list[dict], asistencias: list[tuple[int, str]], tipos: dict[str, str],
                     tipo: str = "todos") -> dict:
    """
    jugadores:   [{'id', 'nombre', 'categoria', 'creado_en'}, ...]
    asistencias: pares (jugador_id, 'YYYY-MM-DD') dentro del período
    tipos:       {'YYYY-MM-DD': 'entrenamiento'|'partido'} (días sin marcar = entrenamiento)
    tipo:        'todos' | 'entrenamiento' | 'partido'

    Un "día de actividad" es un día en que marcó al menos un jugador. A cada jugador solo se le cuentan
    los días de actividad desde su inscripción (no se le penaliza por días en que aún no estaba).
    """
    tipo_de = lambda f: tipos.get(f, "entrenamiento")  # noqa: E731
    presentes_por_dia: dict[str, set[int]] = {}
    for jid, fecha in asistencias:
        if tipo == "todos" or tipo_de(fecha) == tipo:
            presentes_por_dia.setdefault(fecha, set()).add(jid)
    dias = sorted(presentes_por_dia)

    filas = []
    for j in jugadores:
        inscrito = (j.get("creado_en") or "")[:10]
        posibles = [d for d in dias if d >= inscrito]
        asistidos = [d for d in posibles if j["id"] in presentes_por_dia[d]]
        # Ausencias seguidas contando hacia atrás desde el último día de actividad.
        racha = 0
        for d in reversed(posibles):
            if j["id"] in presentes_por_dia[d]:
                break
            racha += 1
        filas.append({
            "id": j["id"], "nombre": j["nombre"], "categoria": j.get("categoria"),
            "presentes": len(asistidos), "posibles": len(posibles),
            "porcentaje": round(len(asistidos) / len(posibles), 4) if posibles else None,
            "ausencias_seguidas": racha,
            "alerta": racha >= UMBRAL_AUSENCIAS,
            "ultima": asistidos[-1] if asistidos else None,
        })

    return {
        "dias": [{"fecha": d, "tipo": tipo_de(d), "presentes": len(presentes_por_dia[d])} for d in dias],
        "jugadores": sorted(filas, key=lambda f: (f["porcentaje"] is None, f["porcentaje"] or 0, f["nombre"])),
        "umbral_ausencias": UMBRAL_AUSENCIAS,
    }
