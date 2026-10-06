"""Asistencia por día: presentes, ausentes, marcado manual y exportación."""

import base64
from datetime import date

import pandas as pd
import streamlit as st

import core

core.requerir_staff()

core.header("Asistencia", "Quién vino y quién falta, día por día.")

f1, f2, f3 = st.columns([1.2, 3, 1], vertical_alignment="bottom")
dia = f1.date_input("Día", value=date.today(), max_value=date.today(), format="DD/MM/YYYY")
es_hoy = dia == date.today()

ok_j, jugadores = core.call_api("GET", "/jugadores")
ok_a, asistencias = core.call_api("GET", "/asistencias",
                                  params={"fecha": dia.isoformat(), "limit": 1000})
if not (ok_j and ok_a):
    core.empty_state("🔌", "Sin conexión", "No se pudo conectar con el servidor.")
    st.stop()

# ------------------------------------------------------------------ por revisar
@st.fragment
def por_revisar(todos: list[dict]):
    """Llegadas que la cámara no reconoció: el staff indica quién era y el sistema aprende."""
    ok, pendientes = core.call_api("GET", "/pendientes")
    if not ok or not pendientes:
        return
    nombres = {j["id"]: j["nombre"] for j in sorted(todos, key=lambda j: j["nombre"])}
    with st.container(border=True):
        st.markdown(f"#### :material/notifications_active: Por revisar ({len(pendientes)})")
        st.caption("La cámara no reconoció a estos niños. Indica quién era: se registra su asistencia "
                   "y el sistema aprende su cara para la próxima. Se borran solas después de 2 horas.")
        for fila in range(0, len(pendientes), 3):
            cols = st.columns(3)
            for col, p in zip(cols, pendientes[fila:fila + 3]):
                with col, st.container(border=True):
                    a, b = st.columns([1, 1.6], vertical_alignment="center")
                    a.image(base64.b64decode(p["miniatura"]), width="stretch")
                    sug = p.get("sugerido")
                    b.markdown(f"**Llegó a las {p['timestamp'][11:16]}**")
                    if sug:
                        b.caption(f"¿Es {sug['nombre']}?" + (f" (parecido {sug['similitud']:.2f})"
                                                             if core.modo_prueba() else ""))
                    ids = list(nombres)
                    elegido = st.selectbox("¿Quién es?", ids, format_func=nombres.get, key=f"pend_{p['id']}_{p['timestamp']}",
                                           index=ids.index(sug["id"]) if sug and sug["id"] in ids else None,
                                           placeholder="Elige al jugador…", label_visibility="collapsed")
                    c1, c2 = st.columns([2, 1])
                    if c1.button("Confirmar", key=f"ok_{p['id']}_{p['timestamp']}", type="primary", width="stretch",
                                 icon=":material/check:",
                                 disabled=elegido is None):
                        ok, res = core.call_api("POST", f"/pendientes/{p['id']}/asignar",
                                                data={"jugador_id": elegido})
                        if ok:
                            st.toast(f"{res['nombre']}: asistencia registrada"
                                     + (" y cara aprendida 🧠" if res["foto_guardada"] else ""), icon="✅")
                            if res.get("motivo"):
                                st.toast(res["motivo"], icon="ℹ️")
                        else:
                            st.toast(res.get("mensaje"), icon="⚠️")
                        st.rerun()  # recarga toda la página: cambian presentes y faltantes
                    if c2.button("", key=f"del_{p['id']}_{p['timestamp']}", width="stretch", icon=":material/delete:",
                                 type="tertiary", help="Descartar (no era un jugador)"):
                        core.call_api("DELETE", f"/pendientes/{p['id']}")
                        st.rerun(scope="fragment")


por_revisar(jugadores)

# ------------------------------------------------------------------ tipo de jornada
ok_t, tipos = core.call_api("GET", "/jornadas", params={"desde": dia.isoformat(), "hasta": dia.isoformat()})
tipo_actual = (tipos or {}).get(dia.isoformat(), "entrenamiento") if ok_t else "entrenamiento"
etiquetas_tipo = {"entrenamiento": "Entrenamiento", "partido": "Partido"}
tipo = st.segmented_control(
    "Tipo de jornada", list(etiquetas_tipo), format_func=etiquetas_tipo.get, default=tipo_actual,
    key=f"tipo_{dia.isoformat()}", help="Se usa en Reportes para separar entrenamientos de partidos.")
if tipo and tipo != tipo_actual:
    ok, res = core.call_api("PUT", f"/jornadas/{dia.isoformat()}", data={"tipo": tipo})
    st.toast(f"Jornada marcada como {etiquetas_tipo[tipo].lower()}" if ok else res.get("mensaje"),
             icon=":material/sports:" if ok else ":material/error:")

categorias = core.ordenar_categorias({j["categoria"] for j in jugadores if j["categoria"]})
filtro_cat = f2.segmented_control("Filtrar por categoría", categorias,
                                  selection_mode="multi") if categorias else []
if f3.button("Actualizar", width="stretch", icon=":material/refresh:"):
    st.rerun()

en_cat = lambda cat: not filtro_cat or cat in filtro_cat  # noqa: E731
jugadores = [j for j in jugadores if en_cat(j["categoria"])]
asistencias = [a for a in asistencias if en_cat(a["categoria"])]

presentes_ids = {a["jugador_id"] for a in asistencias}
ausentes = sorted((j for j in jugadores if j["id"] not in presentes_ids), key=lambda j: j["nombre"])
total = len(jugadores)
pct = len(presentes_ids) / total if total else 0
manuales = sum(1 for a in asistencias if a.get("origen") in ("manual", "correccion"))

m1, m2, m3, m4 = st.columns(4)
m1.metric("Presentes", len(presentes_ids), border=True)
m2.metric("Ausentes", len(ausentes), border=True)
m3.metric("Asistencia", f"{pct:.0%}", border=True)
m4.metric("Marcados por el staff", manuales, border=True,
          help="Si este número es alto, el reconocimiento está fallando: revisa luz y fotos.")

izq, der = st.columns([1.3, 1], gap="large")

with izq:
    st.markdown(f"#### :material/check_circle: Presentes ({len(presentes_ids)})")
    if asistencias:
        df = pd.DataFrame(asistencias)
        df["hora"] = df["timestamp"].str[11:16]
        df["origen"] = df["origen"].fillna("facial").map({"facial": "📷 Cámara", "manual": "✋ Manual",
                                                         "correccion": "🔔 Revisado"})
        df["categoria"] = df["categoria"].fillna("—")
        st.dataframe(
            df[["hora", "nombre", "categoria", "origen"]].sort_values("hora"),
            hide_index=True, width="stretch",
            column_config={"hora": "Hora", "nombre": "Nombre",
                           "categoria": "Categoría", "origen": "Cómo"},
        )
        export = df[["timestamp", "nombre", "categoria", "origen"]].rename(
            columns={"timestamp": "fecha_hora", "origen": "registro"})
        st.download_button("Descargar CSV", icon=":material/download:",
                           data=export.to_csv(index=False).encode("utf-8-sig"),
                           file_name=f"asistencia_{dia.isoformat()}.csv", mime="text/csv")
    else:
        core.empty_state("🕐", "Nadie ha llegado todavía" if es_hoy else "Sin registros",
                         "Los niños aparecerán aquí al marcar en el kiosko.")

with der:
    st.markdown(f"#### :material/schedule: Faltan ({len(ausentes)})")
    if not ausentes:
        st.success("¡Vinieron todos! 🎉" if total else "No hay jugadores inscritos.")
    else:
        if es_hoy:
            st.caption("¿Llegó pero la cámara no lo reconoció? Márcalo a mano.")
        with st.container(height=420, border=False):
            for j in ausentes:
                a, b = st.columns([4, 1.3], vertical_alignment="center")
                a.markdown(f'<div style="display:flex;gap:10px;align-items:center">'
                           f'{core.avatar(j["nombre"], 34)}<div><b>{core.esc(j["nombre"])}</b>'
                           f'<div class="fc-muted" style="font-size:.85rem">'
                           f'{core.esc(j["categoria"] or "Sin categoría")}</div></div></div>',
                           unsafe_allow_html=True)
                if es_hoy and b.button("Marcar", key=f"m_{j['id']}", width="stretch"):
                    ok, res = core.call_api("POST", "/asistencia/manual", data={"jugador_id": j["id"]})
                    if ok:
                        st.toast(f"{j['nombre']} marcado", icon="✅")
                        st.rerun()
                    else:
                        st.error(res.get("mensaje"))
