"""Listado de jugadores: búsqueda, filtro por categoría, marcar asistencia y eliminar."""

import pandas as pd
import streamlit as st

import core

core.requerir_staff()

core.header("Jugadores", "Todos los niños inscritos en la liga.")

ok, jugadores = core.call_api("GET", "/jugadores")
if not ok:
    core.empty_state("🔌", "Sin conexión", jugadores.get("mensaje", ""))
    st.stop()
if not jugadores:
    core.empty_state("👥", "Todavía no hay jugadores", "Inscribe al primero para empezar.")
    _, c, _ = st.columns([2, 1, 2])
    if c.button("Inscribir jugador", type="primary", width="stretch", icon=":material/person_add:"):
        st.switch_page("vistas/inscribir.py")
    st.stop()

# ------------------------------------------------------------------ filtros
f1, f2 = st.columns([2, 3], vertical_alignment="bottom")
busqueda = f1.text_input("Buscar", placeholder="🔍  Buscar por nombre", label_visibility="collapsed")
categorias = core.ordenar_categorias({j["categoria"] for j in jugadores if j["categoria"]})
filtro_cat = f2.segmented_control("Categoría", categorias, selection_mode="multi",
                                  label_visibility="collapsed") if categorias else []

filtrados = [
    j for j in jugadores
    if busqueda.lower() in j["nombre"].lower()
    and (not filtro_cat or j["categoria"] in filtro_cat)
]

sin_autorizacion = sum(1 for j in jugadores if not j["consentimiento_tutor"])
if sin_autorizacion:
    st.warning(f"{sin_autorizacion} jugador(es) no tienen la autorización del tutor registrada. "
               "Selecciónalos y usa «Autorización» (o elimínalos si no la tienes).", icon=":material/verified_user:")
pendientes = sum(1 for j in jugadores if not j["compatible"])
if pendientes:
    st.warning(f"{pendientes} jugador(es) no tienen fotos para el modelo actual y no serán reconocidos. "
               "Selecciónalos y usa «Agregar foto» (marcados como «Falta foto»).", icon=":material/add_a_photo:")

# ------------------------------------------------------------------ tabla
df = pd.DataFrame(filtrados)
if df.empty:
    st.info("Ningún jugador coincide con la búsqueda.")
    st.stop()

df["estado"] = df["compatible"].map({True: "✅ Listo", False: "⚠️ Falta foto"})
df["categoria"] = df["categoria"].fillna("—")
df["autorizacion"] = df["consentimiento_tutor"].notna().map({True: "✅ Firmada", False: "⚠️ Falta"})
df["ultima_asistencia"] = pd.to_datetime(df["ultima_asistencia"])
df["creado_en"] = pd.to_datetime(df["creado_en"])
max_asist = max(int(df["asistencias"].max()), 1)

st.caption(f"{len(filtrados)} de {len(jugadores)} jugadores · selecciona una fila para ver acciones")
sel = st.dataframe(
    df[["nombre", "categoria", "asistencias", "ultima_asistencia", "fotos", "autorizacion", "estado"]],
    hide_index=True,
    width="stretch",
    on_select="rerun",
    selection_mode="single-row",
    column_config={
        "nombre": st.column_config.TextColumn("Nombre", width="medium"),
        "categoria": st.column_config.TextColumn("Categoría"),
        "asistencias": st.column_config.ProgressColumn("Asistencias", format="%d",
                                                       min_value=0, max_value=max_asist),
        "ultima_asistencia": st.column_config.DatetimeColumn("Última vez", format="DD/MM HH:mm"),
        "fotos": st.column_config.NumberColumn(
            "Fotos", format="%d 📷",
            help="Fotos con las que se lo reconoce. Más fotos (y las correcciones del staff) = mejor reconocimiento."),
        "autorizacion": st.column_config.TextColumn("Autorización"),
        "estado": st.column_config.TextColumn("Estado"),
    },
)


@st.dialog("¿Eliminar jugador?")
def confirmar_borrado(jugador: dict):
    st.write(f"Se eliminará a **{jugador['nombre']}** y todo su historial de asistencia. "
             "Esta acción no se puede deshacer.")
    c1, c2 = st.columns(2)
    with c1, core.peligro("confirmar_borrado"):
        eliminar = st.button("Sí, eliminar", width="stretch", icon=":material/delete:")
    if eliminar:
        ok, res = core.call_api("DELETE", f"/jugadores/{jugador['id']}")
        if ok:
            st.toast(f"{jugador['nombre']} eliminado", icon="🗑️")
            st.rerun()
        else:
            st.error(res.get("mensaje"))
    if c2.button("Cancelar", width="stretch"):
        st.rerun()


@st.dialog("Agregar foto")
def agregar_foto(jugador: dict):
    st.write(f"Toma una foto más de **{jugador['nombre']}**. Se suma a las que ya tiene "
             "(útil si a veces no lo reconoce, o si cambió mucho). Su historial se conserva.")
    if not core.camara_on():
        st.info("📷 La cámara está apagada. Enciéndela en ⚙️.")
        return
    foto = st.camera_input("Foto", label_visibility="collapsed", key=f"reinsc_{jugador['id']}")
    if st.button("Guardar foto", type="primary", width="stretch", disabled=foto is None):
        with core.cargando("Analizando…"):
            ok, res = core.call_api("POST", f"/jugadores/{jugador['id']}/foto", files=core.image_file(foto))
        if ok:
            st.toast(f"Foto agregada a {jugador['nombre']}", icon="📸")
            st.rerun()
        elif res.get("codigo") == "sin_rostro":
            st.error("😕 No se detectó una cara. Revisa la luz y que mire de frente.")
        else:
            st.error(res.get("mensaje"))


@st.dialog("Autorización del tutor")
def autorizar(jugador: dict):
    st.write(f"Registra la autorización firmada para **{jugador['nombre']}**.")
    tutor = st.text_input("Nombre del padre, madre o tutor que firmó")
    ok_check = st.checkbox("Confirmo que tengo la autorización firmada")
    if st.button("Guardar", type="primary", width="stretch"):
        if not (tutor.strip() and ok_check):
            st.error("Escribe el nombre y marca la casilla.")
        else:
            ok, res = core.call_api("POST", f"/jugadores/{jugador['id']}/consentimiento", data={"tutor": tutor})
            if ok:
                st.toast("Autorización registrada", icon="🛡️")
                st.rerun()
            st.error(res.get("mensaje"))


filas = sel.selection.rows
if filas:
    j = filtrados[filas[0]]
    with st.container(border=True):
        if j["consentimiento_tutor"]:
            a, b, c, d = st.columns([3, 1.4, 1.4, 1.2], vertical_alignment="center")
        else:
            a, e, b, c, d = st.columns([2.4, 1.4, 1.3, 1.4, 1.2], vertical_alignment="center")
            if e.button("Autorización", width="stretch", type="primary", icon=":material/verified_user:"):
                autorizar(j)
        a.markdown(f'<div style="display:flex;gap:12px;align-items:center">{core.avatar(j["nombre"])}'
                   f'<div><b>{core.esc(j["nombre"])}</b><div class="fc-muted">'
                   f'{core.esc(j["categoria"] or "Sin categoría")} · {j["asistencias"]} asistencias · {j["fotos"]} fotos'
                   f"</div></div></div>", unsafe_allow_html=True)
        if b.button("Marcar hoy", width="stretch", icon=":material/check_circle:",
                    help="Registrar asistencia manualmente"):
            ok, res = core.call_api("POST", "/asistencia/manual", data={"jugador_id": j["id"]})
            if ok:
                st.toast(f"{j['nombre']}: " + ("ya estaba anotado hoy" if res["ya_registrado"]
                                               else "asistencia registrada"), icon="✅")
            else:
                st.error(res.get("mensaje"))
        if c.button("Agregar foto", width="stretch", icon=":material/add_a_photo:",
                    help="Suma una foto nueva (útil si no lo reconoce o tras cambiar de modelo)"):
            agregar_foto(j)
        if d.button("Eliminar", width="stretch", type="tertiary", icon=":material/delete:"):
            confirmar_borrado(j)
