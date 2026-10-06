"""Reportes: asistencia por jugador en un período, alertas de ausencias y asistencia por día."""

from datetime import date, timedelta

import altair as alt
import pandas as pd
import streamlit as st

import core

core.requerir_staff()
core.header("Reportes", "¿Quién viene seguido y quién está faltando?")

# ------------------------------------------------------------------ filtros
hoy = date.today()
periodos = {
    "7d": ("Últimos 7 días", hoy - timedelta(days=6), hoy),
    "30d": ("Últimos 30 días", hoy - timedelta(days=29), hoy),
    "mes": ("Este mes", hoy.replace(day=1), hoy),
    "otro": ("Personalizado", None, None),
}
f1, f2 = st.columns([3, 2], vertical_alignment="bottom")
clave = f1.segmented_control("Período", list(periodos), format_func=lambda k: periodos[k][0], default="30d")
tipo = f2.segmented_control("Jornadas", ["todos", "entrenamiento", "partido"], default="todos",
                            format_func={"todos": "Todas", "entrenamiento": "Entrenamientos",
                                         "partido": "Partidos"}.get)
clave, tipo = clave or "30d", tipo or "todos"
if clave == "otro":
    rango = st.date_input("Desde – hasta", value=(hoy - timedelta(days=29), hoy), max_value=hoy,
                          format="DD/MM/YYYY")
    if len(rango) != 2:
        st.info("Elige la fecha final del período.", icon=":material/date_range:")
        st.stop()
    desde, hasta = rango
else:
    _, desde, hasta = periodos[clave]

ok, rep = core.call_api("GET", "/reportes", params={"desde": desde.isoformat(), "hasta": hasta.isoformat(),
                                                    "tipo": tipo})
if not ok:
    core.empty_state("🔌", "Sin conexión", rep.get("mensaje", ""))
    st.stop()

jugadores = rep["jugadores"]
categorias = core.ordenar_categorias({j["categoria"] for j in jugadores if j["categoria"]})
filtro_cat = st.segmented_control("Categoría", categorias, selection_mode="multi") if categorias else []
if filtro_cat:
    jugadores = [j for j in jugadores if j["categoria"] in filtro_cat]

dias = rep["dias"]
if not dias:
    core.empty_state("📅", "Sin actividad en este período",
                     "Cuando los niños marquen su llegada, aquí verás quién viene seguido y quién falta.")
    st.stop()

con_dato = [j for j in jugadores if j["porcentaje"] is not None]
promedio = sum(j["porcentaje"] for j in con_dato) / len(con_dato) if con_dato else 0
alertas = [j for j in jugadores if j["alerta"]]
fmt = lambda f: f"{f[8:10]}/{f[5:7]}"  # noqa: E731

m1, m2, m3, m4 = st.columns(4)
m1.metric("Días de actividad", len(dias), border=True,
          help="Días en que marcó al menos un jugador.")
m2.metric("Asistencia promedio", f"{promedio:.0%}", border=True)
m3.metric("Jugadores", len(jugadores), border=True)
m4.metric(f"Faltaron {rep['umbral_ausencias']}+ seguidas", len(alertas), border=True,
          help="Contando hacia atrás desde el último día de actividad.")

# ------------------------------------------------------------------ alertas
if alertas:
    with st.container(border=True):
        st.markdown(f"#### :material/notification_important: Para llamar ({len(alertas)})")
        st.caption("Faltaron a los últimos entrenamientos o partidos seguidos. Quizás valga la pena "
                   "hablar con la familia.")
        for fila in range(0, len(alertas), 3):
            for col, j in zip(st.columns(3), alertas[fila:fila + 3]):
                ultima = f"última vez {fmt(j['ultima'])}" if j["ultima"] else "no ha venido en el período"
                faltas = core.pill(f"{j['ausencias_seguidas']} faltas seguidas", "err")
                col.markdown(
                    f'<div class="fc-card" style="display:flex;gap:12px;align-items:center;padding:14px 16px">'
                    f'{core.avatar(j["nombre"], 40)}<div><b>{core.esc(j["nombre"])}</b>'
                    f'<div class="fc-muted" style="font-size:.9rem">{faltas} · {ultima}</div></div></div>',
                    unsafe_allow_html=True)

# ------------------------------------------------------------------ por día
with st.container(border=True):
    st.markdown("#### :material/bar_chart: Asistencia por día")
    df_dias = pd.DataFrame(dias)
    df_dias["dia"] = df_dias["fecha"].map(fmt)  # eje por día (no tiempo continuo): barras anchas
    df_dias["jornada"] = df_dias["tipo"].map({"entrenamiento": "Entrenamiento", "partido": "Partido"})
    barras = alt.Chart(df_dias).mark_bar(cornerRadiusTopLeft=6, cornerRadiusTopRight=6).encode(
        x=alt.X("dia:O", title=None, sort=None, axis=alt.Axis(labelAngle=0)),
        y=alt.Y("presentes:Q", title="Niños presentes"),
        color=alt.Color("jornada:N", title=None,
                        scale=alt.Scale(domain=["Entrenamiento", "Partido"], range=["#15803d", "#1d4ed8"])),
        tooltip=[alt.Tooltip("dia:O", title="Día"), alt.Tooltip("jornada:N", title="Jornada"),
                 alt.Tooltip("presentes:Q", title="Presentes")],
    )
    st.altair_chart(barras.properties(height=260), width="stretch")

# ------------------------------------------------------------------ por jugador
with st.container(border=True):
    st.markdown("#### :material/groups: Por jugador")
    st.caption("Solo se cuentan los días desde que cada niño se inscribió. Ordenado de menor a mayor asistencia.")
    df = pd.DataFrame(jugadores)
    df["categoria"] = df["categoria"].fillna("—")
    df["asistio"] = df.apply(lambda r: f"{r['presentes']} de {r['posibles']}", axis=1)
    df["ultima"] = pd.to_datetime(df["ultima"])
    df["pct"] = (df["porcentaje"] * 100).round()
    df["estado"] = df.apply(lambda r: "⚠️ Faltando" if r["alerta"]
                            else ("✅ Constante" if (r["porcentaje"] or 0) >= 0.75 else "—"), axis=1)
    st.dataframe(
        df[["nombre", "categoria", "pct", "asistio", "ausencias_seguidas", "ultima", "estado"]],
        hide_index=True, width="stretch",
        column_config={
            "nombre": st.column_config.TextColumn("Nombre", width="medium"),
            "categoria": "Categoría",
            "pct": st.column_config.ProgressColumn("Asistencia", format="%d%%", min_value=0, max_value=100),
            "asistio": "Vino",
            "ausencias_seguidas": st.column_config.NumberColumn("Faltas seguidas", format="%d"),
            "ultima": st.column_config.DateColumn("Última vez", format="DD/MM"),
            "estado": "Estado",
        },
    )
    export = df[["nombre", "categoria", "presentes", "posibles", "porcentaje", "ausencias_seguidas", "ultima"]]
    st.download_button("Descargar reporte (CSV)", icon=":material/download:",
                       data=export.to_csv(index=False).encode("utf-8-sig"),
                       file_name=f"reporte_{rep['desde']}_{rep['hasta']}_{tipo}.csv", mime="text/csv")
