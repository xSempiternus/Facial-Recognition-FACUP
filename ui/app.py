"""Panel del staff (Streamlit). El kiosko de llegada de los niños es la app web en web/ (http://localhost:3000)."""

import streamlit as st

import core

st.set_page_config(page_title="Staff · FA CUP Chile", page_icon="⚽", layout="wide")
core.init_state()
core.inject_css()
st.logo(str(core.STATIC_DIR / "logo-blanco.png"), size="large")

staff_ok = st.session_state.staff_ok
# Sin sesión, las páginas del staff siguen registradas pero ocultas: un enlace directo o un F5
# muestran el PIN (core.requerir_staff) en vez de "Page not found".
vis = "visible" if staff_ok else "hidden"

acceso = st.Page("vistas/acceso.py", title="Ingresar", icon=":material/lock:", url_path="staff", default=True,
                 visibility="hidden" if staff_ok else "visible")
inscribir = st.Page("vistas/inscribir.py", title="Inscribir", icon=":material/person_add:", url_path="inscribir", visibility=vis)
staff = [
    inscribir,
    st.Page("vistas/jugadores.py", title="Jugadores", icon=":material/groups:", url_path="jugadores", visibility=vis),
    st.Page("vistas/asistencia.py", title="Asistencia", icon=":material/fact_check:", url_path="asistencia", visibility=vis),
    st.Page("vistas/reportes.py", title="Reportes", icon=":material/insights:", url_path="reportes", visibility=vis),
    st.Page("vistas/evaluacion.py", title="Evaluación", icon=":material/science:", url_path="evaluacion", visibility=vis),
    st.Page("vistas/ajustes.py", title="Ajustes", icon=":material/settings:", url_path="ajustes", visibility=vis),
    st.Page("vistas/estilo.py", title="Guía de estilo", icon=":material/palette:", url_path="estilo", visibility=vis),
]

pagina = st.navigation({"": [acceso], "Staff": staff}, position="top")
# Con sesión iniciada, la página de ingreso lleva directo al panel.
if st.session_state.pop("ir_a_staff", False) or (staff_ok and pagina is acceso):
    st.switch_page(inscribir)
pagina.run()
