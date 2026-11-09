"""Exportes de asistencia (Excel y PDF) de una sede. Solo lectura; reutiliza src/metricas.resumen.

A diferencia del panel, los exportes SÍ incluyen la jornada de hoy (si ya tiene asistencias): `resumen` recibe una
"fecha de hoy" fuera de rango para que no excluya ninguna jornada.
"""

import io
from datetime import datetime

from openpyxl import Workbook
from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from src import metricas
from src.reportes import UMBRAL_AUSENCIAS

VERDE = "008D36"
VERDE_SUAVE = "DDF1E3"
ROJO_SUAVE = "FBE0E0"
GRIS = "6B7280"
OK, FALTA = "✓", "✗"
_SIN_HOY = "9999-12-31"  # "hoy" inalcanzable: ninguna jornada se excluye por estar en curso


def datos(db, desde: str, hasta: str, categoria: str | None) -> dict:
    return metricas.resumen(db, desde, hasta, categoria, hoy_fecha=_SIN_HOY)


def seguro(valor):
    """Evita inyección de fórmulas: texto que empieza con = + - @ (o tab/CR) se antepone con una comilla simple."""
    if isinstance(valor, str) and valor[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + valor
    return valor


def _fecha_corta(iso: str) -> str:
    return f"{iso[8:10]}/{iso[5:7]}"


def _fecha_larga(iso: str) -> str:
    return f"{iso[8:10]}/{iso[5:7]}/{iso[:4]}"


def _titulo(sede: str, d: dict) -> tuple[str, str]:
    r = d["rango"]
    cat = r["categoria"] or "todas las categorías"
    return (f"Asistencia · {sede}",
            f"Del {_fecha_larga(r['desde'])} al {_fecha_larga(r['hasta'])} · {cat} · "
            f"Emitido {datetime.now():%d/%m/%Y %H:%M}")


# ------------------------------------------------------------------ contactos (columnas opcionales de jugadores)

def contactos(db, ids: set[int]) -> list[dict] | None:
    """Correo/teléfono del apoderado y si acepta comunicaciones. Devuelve None si jugadores no tiene esas columnas
    (otro módulo las agrega): nunca falla por columnas ausentes."""
    with db.conexion() as conn:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(jugadores)")]
        low = {c.lower(): c for c in cols}

        def buscar(*claves: str, excluir: tuple[str, ...] = ()) -> str | None:
            for c_low, c in low.items():
                if any(k in c_low for k in claves) and not any(x in c_low for x in excluir):
                    return c
            return None

        correo = buscar("correo", "email", "mail")
        tel = buscar("telefono", "teléfono", "fono", "celular")
        acepta = buscar("comunic", "acepta", "contacto_ok")
        if not (correo or tel):
            return None
        tutor = buscar("tutor_nombre", "apoderado_nombre", "nombre_apoderado", "nombre_tutor")
        sel = ["id", "nombre", "categoria"] + [c for c in (tutor, correo, tel, acepta) if c]
        filas = conn.execute(f"SELECT {', '.join(sel)} FROM jugadores "
                             "WHERE coalesce(estado, 'activo') = 'activo' ORDER BY nombre COLLATE NOCASE").fetchall()
    out = []
    for f in filas:
        if f["id"] not in ids:
            continue
        v = f[acepta] if acepta else None
        out.append({"nombre": f["nombre"], "categoria": f["categoria"],
                    "apoderado": f[tutor] if tutor else None,
                    "correo": f[correo] if correo else None, "telefono": f[tel] if tel else None,
                    "acepta": None if v is None else ("Sí" if str(v).strip().lower() in ("1", "true", "si", "sí", "s") else "No")})
    return out


# ------------------------------------------------------------------ Excel

def _estilo_encabezado(c) -> None:
    c.font = Font(bold=True, color="FFFFFF")
    c.fill = PatternFill("solid", fgColor=VERDE)
    c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)


def xlsx(d: dict, sede: str, contacto: list[dict] | None = None) -> bytes:
    titulo, sub = _titulo(sede, d)
    fechas = [j["fecha"] for j in d["jornadas"]]
    wb = Workbook()

    # --- Asistencia
    ws = wb.active
    ws.title = "Asistencia"
    ws["A1"] = seguro(titulo)
    ws["A1"].font = Font(bold=True, size=14, color=VERDE)
    ws["A2"] = seguro(sub)
    ws["A2"].font = Font(color=GRIS, size=10)
    enc = ["Nombre", "Categoría", "Asistió", "Jornadas", "% asistencia", "Faltas seguidas"] + [_fecha_corta(f) for f in fechas]
    fila_h = 4
    for i, t in enumerate(enc, 1):
        _estilo_encabezado(ws.cell(fila_h, i, t))
    for r, n in enumerate(d["ninos"], fila_h + 1):
        ws.cell(r, 1, seguro(n["nombre"]))
        ws.cell(r, 2, seguro(n["categoria"] or metricas.SIN_CATEGORIA))
        ws.cell(r, 3, n["presentes"])
        ws.cell(r, 4, n["jornadas_total"])
        ws.cell(r, 5, n["porcentaje"] / 100).number_format = "0%"
        ws.cell(r, 6, n["faltas_seguidas"])
        for k, f in enumerate(fechas, 7):
            est = n["dias"].get(f)
            c = ws.cell(r, k, OK if est == "presente" else FALTA if est == "ausente" else None)
            c.alignment = Alignment(horizontal="center")
        for k in (3, 4, 5, 6):
            ws.cell(r, k).alignment = Alignment(horizontal="center")
    ultima = fila_h + max(len(d["ninos"]), 1)
    if fechas:
        rango = f"G{fila_h + 1}:{get_column_letter(6 + len(fechas))}{ultima}"
        ws.conditional_formatting.add(rango, CellIsRule(operator="equal", formula=[f'"{OK}"'],
                                      fill=PatternFill("solid", bgColor=VERDE_SUAVE), font=Font(color="146B34")))
        ws.conditional_formatting.add(rango, CellIsRule(operator="equal", formula=[f'"{FALTA}"'],
                                      fill=PatternFill("solid", bgColor=ROJO_SUAVE), font=Font(color="B42318")))
    ws.conditional_formatting.add(f"F{fila_h + 1}:F{ultima}", CellIsRule(
        operator="greaterThanOrEqual", formula=[str(UMBRAL_AUSENCIAS)],
        fill=PatternFill("solid", bgColor=ROJO_SUAVE), font=Font(bold=True, color="B42318")))
    ws.freeze_panes = ws.cell(fila_h + 1, 2)
    ws.auto_filter.ref = f"A{fila_h}:{get_column_letter(len(enc))}{ultima}"
    ws.row_dimensions[fila_h].height = 32
    ws.column_dimensions["A"].width = 30
    ws.column_dimensions["B"].width = 14
    for k in range(3, 7):
        ws.column_dimensions[get_column_letter(k)].width = 11
    for k in range(7, len(enc) + 1):
        ws.column_dimensions[get_column_letter(k)].width = 6.5
    ws.page_setup.orientation = "landscape"
    ws.print_title_rows = f"{fila_h}:{fila_h}"

    # --- Resumen
    rs = wb.create_sheet("Resumen")
    rs["A1"] = seguro(titulo)
    rs["A1"].font = Font(bold=True, size=14, color=VERDE)
    rs["A2"] = seguro(sub)
    rs["A2"].font = Font(color=GRIS, size=10)
    t = d["totales"]
    kp = [("Niños inscritos", t["ninos_activos"]), ("Jornadas", t["jornadas"]),
          ("Asistencia media (%)", t["promedio_asistencia"] / 100), ("En riesgo (3+ faltas seguidas)", len(d["en_riesgo"]))]
    for i, (k, v) in enumerate(kp, 4):
        rs.cell(i, 1, k).font = Font(bold=True)
        c = rs.cell(i, 2, v)
        c.alignment = Alignment(horizontal="left")
        if isinstance(v, float):
            c.number_format = "0%"
    r0 = 9
    for i, h in enumerate(["Categoría", "Niños", "Asistencias", "Posibles", "% asistencia"], 1):
        _estilo_encabezado(rs.cell(r0, i, h))
    for r, c in enumerate(d["categorias"], r0 + 1):
        rs.cell(r, 1, seguro(c["categoria"]))
        rs.cell(r, 2, c["ninos"])
        rs.cell(r, 3, c["presentes"])
        rs.cell(r, 4, c["esperados"])
        rs.cell(r, 5, c["porcentaje"] / 100).number_format = "0%"
    r1 = r0 + len(d["categorias"]) + 3
    rs.cell(r1 - 1, 1, "En riesgo").font = Font(bold=True, color=VERDE, size=12)
    for i, h in enumerate(["Nombre", "Categoría", "Faltas seguidas"], 1):
        _estilo_encabezado(rs.cell(r1, i, h))
    for r, x in enumerate(d["en_riesgo"], r1 + 1):
        rs.cell(r, 1, seguro(x["nombre"]))
        rs.cell(r, 2, seguro(x["categoria"] or metricas.SIN_CATEGORIA))
        rs.cell(r, 3, x["faltas_seguidas"])
    if not d["en_riesgo"]:
        rs.cell(r1 + 1, 1, "Nadie está faltando seguido.")
    rs.column_dimensions["A"].width = 32
    for col in "BCDE":
        rs.column_dimensions[col].width = 16

    # --- Contactos (solo si la base tiene las columnas)
    if contacto is not None:
        cs = wb.create_sheet("Contactos")
        cs["A1"] = seguro(f"Contactos de apoderados · {sede}")
        cs["A1"].font = Font(bold=True, size=14, color=VERDE)
        cs["A2"] = "Usar solo con quienes aceptan comunicaciones. Dato personal: no compartir fuera del club."
        cs["A2"].font = Font(color=GRIS, size=10)
        hs = ["Niño", "Categoría", "Apoderado", "Correo", "Teléfono", "Acepta comunicaciones"]
        for i, h in enumerate(hs, 1):
            _estilo_encabezado(cs.cell(4, i, h))
        for r, x in enumerate(contacto, 5):
            for i, k in enumerate(("nombre", "categoria", "apoderado", "correo", "telefono"), 1):
                cs.cell(r, i, seguro(x[k]) if x[k] else None)
            a = cs.cell(r, 6, x["acepta"] or "Sin dato")
            a.alignment = Alignment(horizontal="center")
        fin = 4 + max(len(contacto), 1)
        cs.conditional_formatting.add(f"F5:F{fin}", CellIsRule(operator="equal", formula=['"Sí"'],
                                      fill=PatternFill("solid", bgColor=VERDE_SUAVE)))
        cs.conditional_formatting.add(f"F5:F{fin}", CellIsRule(operator="equal", formula=['"No"'],
                                      fill=PatternFill("solid", bgColor=ROJO_SUAVE)))
        cs.freeze_panes = "A5"
        cs.auto_filter.ref = f"A4:F{fin}"
        for col, w in zip("ABCDEF", (30, 14, 26, 32, 18, 22)):
            cs.column_dimensions[col].width = w

    wb.properties.title = titulo
    wb.properties.creator = "FA CUP"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ------------------------------------------------------------------ PDF

def pdf(d: dict, sede: str) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    from xml.sax.saxutils import escape

    verde = colors.HexColor("#" + VERDE)
    gris = colors.HexColor("#" + GRIS)
    titulo, sub = _titulo(sede, d)
    r = d["rango"]
    h1 = ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=20, leading=24, textColor=verde)
    h2 = ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=12.5, leading=16, textColor=verde, spaceBefore=10, spaceAfter=5)
    txt = ParagraphStyle("t", fontName="Helvetica", fontSize=10, leading=13.5, textColor=colors.HexColor("#1F2937"))
    peq = ParagraphStyle("p", parent=txt, fontSize=8.5, leading=11, textColor=gris)

    def pie(c, doc):
        c.saveState()
        c.setFont("Helvetica", 8)
        c.setFillColor(gris)
        c.drawString(doc.leftMargin, 8 * mm, f"{sede} · {_fecha_larga(r['desde'])} - {_fecha_larga(r['hasta'])}")
        c.drawRightString(doc.pagesize[0] - doc.rightMargin, 8 * mm, f"Página {doc.page}")
        c.setStrokeColor(verde)
        c.setLineWidth(1.5)
        c.line(doc.leftMargin, doc.pagesize[1] - 9 * mm, doc.pagesize[0] - doc.rightMargin, doc.pagesize[1] - 9 * mm)
        c.restoreState()

    t = d["totales"]
    cat = r["categoria"] or "Todas las categorías"
    hist = []
    hist.append(Paragraph(escape(titulo), h1))
    hist.append(Spacer(1, 3 * mm))
    for k, v in (("Sede", sede), ("Rango", f"{_fecha_larga(r['desde'])} al {_fecha_larga(r['hasta'])}"),
                 ("Categoría", cat), ("Emitido", f"{datetime.now():%d/%m/%Y %H:%M}")):
        hist.append(Paragraph(f"<b>{k}:</b> {escape(v)}", txt))
    hist.append(Spacer(1, 4 * mm))
    kp = [[str(t["ninos_activos"]), str(t["jornadas"]), f"{t['promedio_asistencia']} %", str(len(d["en_riesgo"]))],
          ["Niños inscritos", "Jornadas", "Asistencia media", "En riesgo"]]
    tk = Table(kp, colWidths=[40 * mm] * 4)
    tk.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("FONTSIZE", (0, 0), (-1, 0), 18),
        ("TEXTCOLOR", (0, 0), (-1, 0), verde), ("FONTNAME", (0, 1), (-1, 1), "Helvetica"),
        ("FONTSIZE", (0, 1), (-1, 1), 8.5), ("TEXTCOLOR", (0, 1), (-1, 1), gris),
        ("ALIGN", (0, 0), (-1, -1), "LEFT"), ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#D1D5DB")),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#E5E7EB")),
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F6FBF7")),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5), ("LEFTPADDING", (0, 0), (-1, -1), 8)]))
    hist.append(tk)

    hist.append(Paragraph("Resumen por categoría", h2))
    filas = [["Categoría", "Niños", "Asistencias", "Posibles", "% asistencia"]] + [
        [c["categoria"], c["ninos"], c["presentes"], c["esperados"], f"{c['porcentaje']} %"] for c in d["categorias"]]
    if len(filas) == 1:
        filas.append(["Sin datos", "", "", "", ""])
    tc = Table(filas, colWidths=[70 * mm, 22 * mm, 28 * mm, 24 * mm, 28 * mm], repeatRows=1)
    tc.setStyle(_estilo_tabla(colors, verde, [(1, 0, 4, -1)]))
    hist.append(tc)

    # En riesgo
    hist.append(Paragraph(f"En riesgo ({UMBRAL_AUSENCIAS}+ faltas seguidas)", h2))
    if d["en_riesgo"]:
        fr = [["Nombre", "Categoría", "Faltas seguidas"]] + [
            [x["nombre"], x["categoria"] or metricas.SIN_CATEGORIA, x["faltas_seguidas"]] for x in d["en_riesgo"]]
        tr = Table(fr, colWidths=[80 * mm, 45 * mm, 32 * mm], repeatRows=1)
        tr.setStyle(_estilo_tabla(colors, verde, [(2, 0, 2, -1)]))
        hist.append(tr)
    else:
        hist.append(Paragraph("Nadie está faltando seguido.", txt))

    # Matriz paginada por jornada (landscape)
    hist.append(PageBreak())
    hist.append(Paragraph("Asistencia por jornada", h2))
    hist.append(Paragraph("Marca verde: asistió · – (fondo rojo): faltó · vacío: aún no inscrito en esa jornada", peq))
    hist.append(Spacer(1, 2 * mm))
    fechas = [j["fecha"] for j in d["jornadas"]]
    por_pag = 22
    bloques = [fechas[i:i + por_pag] for i in range(0, len(fechas), por_pag)] or [[]]
    w_nom, w_fix = 62 * mm, 14 * mm
    for bi, bloque in enumerate(bloques):
        if bi:
            hist.append(PageBreak())
            hist.append(Paragraph(f"Asistencia por jornada (continuación {bi + 1}/{len(bloques)})", h2))
        enc = ["Nombre", "Cat."] + [_fecha_corta(f) for f in bloque] + ["Asist.", "%"]
        filas = [enc]
        est = [("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold")]
        for ri, n in enumerate(d["ninos"], 1):
            fila = [n["nombre"][:34], (n["categoria"] or "")[:9]]
            for ci, f in enumerate(bloque, 2):
                v = n["dias"].get(f)
                fila.append(_check(verde) if v == "presente" else "–" if v == "ausente" else "")
                if v == "ausente":
                    est += [("BACKGROUND", (ci, ri), (ci, ri), colors.HexColor("#" + ROJO_SUAVE)),
                            ("TEXTCOLOR", (ci, ri), (ci, ri), colors.HexColor("#B42318"))]
            fila += [f"{n['presentes']}/{n['jornadas_total']}", f"{n['porcentaje']}"]
            filas.append(fila)
        if len(filas) == 1:
            filas.append(["Sin niños en este filtro"] + [""] * (len(enc) - 1))
        ancho_dia = 9.2 * mm
        tm = Table(filas, colWidths=[w_nom, 18 * mm] + [ancho_dia] * len(bloque) + [w_fix, 10 * mm], repeatRows=1)
        base = _estilo_tabla(colors, verde, [(2, 0, 1 + len(bloque) + 2, -1)], fuente=7.5, pad=2)
        base.add("ALIGN", (0, 0), (1, -1), "LEFT")
        for e in est:
            base.add(*e)
        tm.setStyle(base)
        hist.append(tm)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=landscape(A4), leftMargin=14 * mm, rightMargin=14 * mm, topMargin=14 * mm,
                            bottomMargin=14 * mm, title=titulo, author="FA CUP")
    doc.build(hist, onFirstPage=pie, onLaterPages=pie)
    return buf.getvalue()


def _check(color):
    """Marca de asistencia dibujada (no depende de que la fuente tenga el glifo ✓)."""
    from reportlab.graphics.shapes import Drawing, PolyLine
    dr = Drawing(9, 8)
    dr.add(PolyLine([1.5, 4, 3.8, 1.5, 7.8, 6.8], strokeColor=color, strokeWidth=1.4, strokeLineCap=1, strokeLineJoin=1))
    dr.hAlign = "CENTER"
    return dr


def _estilo_tabla(colors, verde, centrados, fuente: float = 9.5, pad: int = 4):
    from reportlab.platypus import TableStyle
    s = TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"), ("FONTSIZE", (0, 0), (-1, -1), fuente),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("BACKGROUND", (0, 0), (-1, 0), verde),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F6FBF7")]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#E5E7EB")), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), pad), ("BOTTOMPADDING", (0, 0), (-1, -1), pad),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4)])
    for c0, r0, c1, r1 in centrados:
        s.add("ALIGN", (c0, r0), (c1, r1), "CENTER")
    return s


def nombre_archivo(sede: str, desde: str, hasta: str, ext: str) -> str:
    return f"asistencia-{sede}-{desde}_{hasta}.{ext}"
