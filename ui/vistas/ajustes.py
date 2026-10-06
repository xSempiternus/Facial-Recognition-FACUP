"""Ajustes del sistema: reconocimiento, anti-fotos, respaldos y privacidad."""

import requests
import streamlit as st

import core

core.requerir_staff()
core.header("Ajustes", "Configuración del reconocimiento, respaldos y privacidad.")

ok_cfg, cfg = core.call_api("GET", "/config")
if not ok_cfg:
    core.empty_state("🔌", "Sin conexión", "No se pudo conectar con el servidor.")
    st.stop()


@st.dialog("¿Aplicar cambios?")
def confirmar(nuevo: dict):
    cambios = [f"**{k}**: {cfg.get(k)} → {v}" for k, v in nuevo.items() if cfg.get(k) != v]
    st.markdown("\n".join(f"- {c}" for c in cambios) or "Sin cambios.")
    if nuevo["modelo"] != cfg["modelo"]:
        ok_j, js = core.call_api("GET", "/jugadores")
        if ok_j and js:
            st.warning(f"⚠️ Cambia el modelo: los **{len(js)} jugador(es)** necesitarán fotos nuevas "
                       "(Jugadores → 📸 Agregar foto) para ser reconocidos. Su historial se conserva.")
    c1, c2 = st.columns(2)
    if c1.button("Aplicar", type="primary", width="stretch", disabled=not cambios):
        with core.cargando("Aplicando…"):
            ok, r = core.call_api("PUT", "/config", json=nuevo)
        if ok:
            st.toast("Ajustes aplicados", icon="✅")
            st.rerun()
        st.error(r.get("mensaje"))
    if c2.button("Cancelar", width="stretch"):
        st.rerun()


# ------------------------------------------------------------------ reconocimiento
with st.container(border=True):
    st.markdown("#### :material/face: Reconocimiento")
    st.caption("Lo ideal es elegir con datos: 🧪 Evaluación recomienda modelo, detector y umbral según tus fotos.")
    c1, c2, c3 = st.columns(3)
    modelo = c1.selectbox("Modelo", cfg["modelos"], index=cfg["modelos"].index(cfg["modelo"]),
                          help="La red que convierte la cara en su «huella». Cambiarlo exige fotos nuevas.")
    detector = c2.selectbox("Detector de caras", cfg["detectores"],
                            index=cfg["detectores"].index(cfg["detector"]),
                            help="opencv: rápido · yunet: rápido y más robusto · retinaface: el más preciso, ~1 s/foto.")
    umbral = c3.slider("Umbral de parecido", 0.20, 0.95, float(cfg["umbral"]), 0.01,
                       help="Más alto = más estricto: menos confusiones, pero más niños deben repetir la foto.")

    st.markdown("#### :material/no_photography: Detección de fotos falsas  " + core.pill("Experimental", "warn"),
                unsafe_allow_html=True)
    anti = st.toggle(
        "Rechazar fotos mostradas en un celular o en papel (solo en el kiosko)",
        value=bool(cfg.get("antispoofing")),
        help="Evita que un niño marque por un amigo mostrando su foto.",
    )
    st.caption("En pruebas con fotos de ejemplo rechazó por error 4 de 16 fotos reales (25 %) y hace cada "
               "verificación ~2,5× más lenta. Actívalo solo después de probarlo con la cámara real del kiosko.")

    nuevo = {"modelo": modelo, "detector": detector, "umbral": round(umbral, 2), "antispoofing": anti}
    hay_cambios = any(cfg.get(k) != v for k, v in nuevo.items())
    if st.button("Guardar cambios", type="primary", disabled=not hay_cambios, icon=":material/save:"):
        confirmar(nuevo)

# ------------------------------------------------------------------ respaldos
with st.container(border=True):
    st.markdown("#### :material/backup: Respaldos")
    st.caption("Se hace una copia automática de la base de datos cada día (se guardan las últimas 14) en "
               "`data/respaldos/`. Descarga una de vez en cuando y guárdala fuera de este computador.")
    ok_r, respaldos = core.call_api("GET", "/respaldos")
    izq, der = st.columns([2, 1], vertical_alignment="bottom")
    if ok_r and respaldos:
        etiquetas = {r["nombre"]: f"{r['creado'][:16]} · {'automático' if r['nombre'].endswith('_auto.db') else 'manual'}"
                     f" · {r['bytes'] / 1024:.0f} KB" for r in respaldos}
        elegido = izq.selectbox("Respaldo", list(etiquetas), format_func=etiquetas.get)
        try:
            datos = requests.get(f"{core.API_URL}/respaldos/{elegido}", timeout=30).content
            der.download_button("Descargar", datos, file_name=elegido, icon=":material/download:",
                                mime="application/octet-stream", width="stretch")
        except requests.RequestException:
            der.error("No se pudo descargar.")
        st.caption(f"Último respaldo: {respaldos[0]['creado'][:16]} · {len(respaldos)} guardados")
    else:
        izq.info("Todavía no hay respaldos.")
    if st.button("Crear respaldo ahora", icon=":material/save:"):
        ok, res = core.call_api("POST", "/respaldos")
        if ok:
            st.toast("Respaldo creado", icon="💾")
            st.rerun()
        st.error(res.get("mensaje"))

# ------------------------------------------------------------------ privacidad
with st.container(border=True):
    st.markdown("#### :material/verified_user: Privacidad")
    ok_j, jugadores = core.call_api("GET", "/jugadores")
    if ok_j:
        con = sum(1 for j in jugadores if j["consentimiento_tutor"])
        a, b = st.columns(2)
        a.metric("Con autorización firmada", con, border=True)
        b.metric("Sin autorización", len(jugadores) - con, border=True,
                 help="Regístrala en Jugadores → 🛡️ Autorización, o elimina al jugador.")
    st.markdown(
        "- **No se guardan fotos**, solo la «huella» numérica de cada cara (no se puede reconstruir la foto).\n"
        "- Las miniaturas de **Por revisar** viven solo en memoria y se borran a las 2 horas.\n"
        "- Para inscribir se exige el nombre del tutor y confirmar la autorización firmada.\n"
        "- Si una familia retira su autorización, **elimina al jugador**: se borran sus huellas y su historial."
    )
