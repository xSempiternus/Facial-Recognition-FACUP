"""Ingreso al panel del staff con PIN, y acceso al kiosko de llegada (app web)."""

import os

import streamlit as st

import core

KIOSKO_URL = os.getenv("KIOSKO_URL", "http://localhost:3000")

if core.login_form():
    st.session_state.ir_a_staff = True
    st.rerun()

_, centro, _ = st.columns([1, 1.3, 1])
with centro:
    st.link_button("Abrir el kiosko de llegada", KIOSKO_URL, icon=":material/open_in_new:", width="stretch")
    st.caption("El kiosko de los niños es la pantalla con la cámara: registra la llegada solo, sin botones.")
