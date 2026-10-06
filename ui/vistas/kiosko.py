"""Kiosko de llegada: el niño se toma una foto y queda registrada su asistencia."""

import time

import streamlit as st

import core

RESET_SECONDS = 4  # tiempo que se muestra el resultado antes de volver a la cámara

ss = st.session_state
ss.setdefault("kiosk_key", 0)


def siguiente():
    ss.kiosk_key += 1
    st.rerun()


# Ajustes discretos arriba a la derecha (el kiosko no muestra título de página).
core.fondo_cancha()

_, der = st.columns([6, 1])
with der.popover("⚙️", help="Ajustes rápidos"):
    st.toggle("📷 Cámara encendida", value=ss.cfg_camara, key="w_camara",
              on_change=core._sync, args=("w_camara", "cfg_camara"))
    st.toggle("🔊 Voz", value=ss.cfg_voz, key="w_voz",
              on_change=core._sync, args=("w_voz", "cfg_voz"))
    st.toggle("🧪 Modo prueba", value=ss.cfg_prueba, key="w_prueba",
              on_change=core._sync, args=("w_prueba", "cfg_prueba"))

_, centro, _ = st.columns([0.6, 3, 0.6])
with centro:
    if not core.camara_on():
        core.resultado("📷", "Cámara apagada", "Enciéndela en ⚙️ para marcar asistencia", core.GRIS)
        st.stop()

    st.markdown(
        '<div class="fc-kiosk-title">¡Hola, crack! 👋</div>'
        '<div class="fc-steps">'
        '<div class="fc-step"><b>1</b>Mira la pantalla</div>'
        '<div class="fc-step"><b>2</b>Aprieta el botón 📸</div>'
        '<div class="fc-step"><b>3</b>¡A jugar! ⚽</div>'
        "</div>",
        unsafe_allow_html=True,
    )

    foto = st.camera_input("Foto", key=f"kiosk_{ss.kiosk_key}", label_visibility="collapsed")
    if foto is None:
        st.stop()

    with core.cargando("Buscándote…", size=72):
        ok, data = core.call_api("POST", "/verify", files=core.image_file(foto))

    frase = None  # lo que dirá la voz del kiosko
    if ok:
        nombre = data["nombre"].split()[0]
        if data["ya_registrado"]:
            hora = data["registrado_a_las"][11:16]
            core.resultado("👍", f"¡Hola de nuevo, {nombre}!", f"Ya estabas anotado hoy a las {hora}", core.AZUL)
            frase = f"¡Hola de nuevo, {nombre}! Ya estabas anotado."
        else:
            core.resultado("🎉", f"¡Hola, {nombre}!", "Asistencia registrada. ¡A jugar! ⚽", core.VERDE)
            core.celebrar()
            frase = f"¡Hola, {nombre}! ¡A jugar!"
    else:
        codigo = data.get("codigo")
        if codigo == "sin_rostro":
            core.resultado("🙈", "No veo tu cara", "Acércate, mira la pantalla y prueba otra vez", core.NARANJA)
            frase = "No veo tu cara. Acércate un poquito y prueba otra vez."
        elif codigo == "foto_falsa":
            core.resultado("📵", "Usa tu cara, no una foto", "Ponte tú frente a la cámara", core.NARANJA)
            frase = "Usa tu cara, no una foto."
        elif codigo == "no_reconocido":
            core.resultado("🤔", "No te reconozco", "Prueba otra vez o busca a tu entrenador", core.ROJO)
            frase = "No te reconozco. Prueba otra vez o busca a tu entrenador."
        elif codigo == "sin_jugadores":
            core.resultado("📋", "Aún no hay jugadores", "El staff debe inscribirlos primero", core.ROJO)
        else:
            core.resultado("⚠️", "Sistema no disponible", "Avísale a tu entrenador", core.ROJO)

    if frase and core.voz_on():
        core.hablar(frase)

    if core.modo_prueba():
        if "similitud" in data:
            ok_h, h = core.estado_servidor()
            umbral = h["threshold"] if ok_h else 0
            st.markdown(
                f"**Parecido:** `{data['similitud']:.3f}` · **umbral:** `{umbral:.2f}` "
                + ("✅ supera el umbral" if data["similitud"] > umbral else "❌ no supera el umbral")
            )
            st.progress(min(max(data["similitud"], 0.0), 1.0))
        with st.expander("Respuesta completa de la API"):
            st.json(data)
        if st.button("Siguiente niño ➡️", type="primary", width="stretch"):
            siguiente()
    else:
        # Cuenta regresiva visible y reinicio automático para el siguiente niño.
        barra = st.progress(1.0, text=f"Siguiente en {RESET_SECONDS} s…")
        pasos = RESET_SECONDS * 10
        for i in range(pasos, 0, -1):
            time.sleep(0.1)
            barra.progress((i - 1) / pasos, text=f"Siguiente en {max(1, -(-(i - 1) // 10))} s…")
        siguiente()
