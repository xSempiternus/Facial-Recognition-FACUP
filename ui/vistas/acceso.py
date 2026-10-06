"""Ingreso al panel del staff con PIN."""

import streamlit as st

import core

if core.login_form():
    st.session_state.ir_a_staff = True
    st.rerun()
