"""Kiosko de llegada: el niño se escanea la cara y queda registrada su asistencia.

Composición tipo "Face ID": columna central con título, cámara (esquinas finas, anillo de marcas y
arco de escaneo) y botón blanco; a los lados, la mascota y los datos del día.
"""

import time

import streamlit as st

import core

RESET_SECONDS = 4  # tiempo que se muestra el resultado antes de volver a la cámara

ss = st.session_state
ss.setdefault("kiosk_key", 0)


def siguiente():
    ss.kiosk_key += 1
    st.rerun()


def tono_escaner(color: str, boton: str) -> None:
    """Pinta el anillo del escáner con el color del resultado y cambia el texto del botón."""
    st.markdown(f"<style>.st-key-k_cam {{--anillo: {color};}} "
                f'.st-key-k_cam [data-testid="stCameraInput"] button::after {{content: "{boton}" !important;}}</style>',
                unsafe_allow_html=True)


core.estilo_kiosko()

with st.container(key="kiosko"):
    izq, centro, der = st.columns([1, 1.75, 1], gap="large", vertical_alignment="center")

    # ---- derecha: datos del día y ajustes discretos
    with der:
        ok_hoy, hoy = core.call_api("GET", "/asistencias", params={"hoy": "true", "limit": 1000})
        st.markdown(
            '<div class="fc-k-datos">'
            '<div class="fc-k-dato"><span class="vivo"><i></i>En vivo</span></div>'
            + (f'<div class="fc-k-dato"><b>{len(hoy)}</b><span>llegaron hoy</span></div>' if ok_hoy else "")
            + f'<div class="fc-k-dato"><b class="fecha">{core.fecha_larga()}</b><span>Fútbol y amistad</span></div>'
            "</div>",
            unsafe_allow_html=True,
        )
        with st.popover("Ajustes", icon=":material/tune:"):
            st.toggle(":material/photo_camera: Cámara encendida", value=ss.cfg_camara, key="w_camara",
                      on_change=core._sync, args=("w_camara", "cfg_camara"))
            st.toggle(":material/record_voice_over: Voz", value=ss.cfg_voz, key="w_voz",
                      on_change=core._sync, args=("w_voz", "cfg_voz"))
            st.toggle(":material/science: Modo prueba", value=ss.cfg_prueba, key="w_prueba",
                      on_change=core._sync, args=("w_prueba", "cfg_prueba"))

    # ---- izquierda: mascota (o balón mientras no esté)
    lado = izq.empty()
    lado.markdown(core.mascota("bienvenida", core.balon_html(size=96), centro=True), unsafe_allow_html=True)

    # ---- centro: título + escáner + botón
    with centro:
        cabecera = st.empty()
        if not core.camara_on():
            cabecera.markdown(core.cabecera_kiosko("Cámara apagada", "Enciéndela en Ajustes para marcar asistencia.",
                                                   "Pausa", core.GRIS), unsafe_allow_html=True)
            st.stop()
        cabecera.markdown(core.cabecera_kiosko("¡Hola, crack!", "Mira la cámara y aprieta el botón para marcar "
                                               "tu llegada."), unsafe_allow_html=True)
        with st.container(key="k_cam"):
            foto = st.camera_input("Foto", key=f"kiosk_{ss.kiosk_key}", label_visibility="collapsed")
        pie = st.container()

    if foto is None:
        st.stop()

    cabecera.markdown(core.cabecera_kiosko("Escaneando…", "Quédate quieto un segundo."), unsafe_allow_html=True)
    lado.markdown(core.mascota("buscando", core.balon_html(size=96), centro=True), unsafe_allow_html=True)
    ok, data = core.call_api("POST", "/verify", files=core.image_file(foto))

    frase = None  # lo que dirá la voz del kiosko
    if ok:
        nombre = data["nombre"].split()[0]
        if data["ya_registrado"]:
            hora = data["registrado_a_las"][11:16]
            estado, emoji, etiqueta, titulo, sub, color = ("de_nuevo", "👍", "Ya estabas anotado",
                                                           f"¡Hola de nuevo, {nombre}!",
                                                           f"Te anotaste hoy a las {hora}.", core.AZUL)
            frase = f"¡Hola de nuevo, {nombre}! Ya estabas anotado."
        else:
            estado, emoji, etiqueta, titulo, sub, color = ("celebra", "🎉", "Asistencia registrada",
                                                           f"¡Hola, {nombre}!", "¡A jugar! ⚽", core.EXITO)
            core.celebrar()
            frase = f"¡Hola, {nombre}! ¡A jugar!"
    else:
        codigo = data.get("codigo")
        if codigo == "sin_rostro":
            estado, emoji, etiqueta, titulo, sub, color = ("no_veo", "🙈", "Ups", "No veo tu cara",
                                                           "Acércate, mira la cámara y prueba otra vez.",
                                                           core.NARANJA)
            frase = "No veo tu cara. Acércate un poquito y prueba otra vez."
        elif codigo == "foto_falsa":
            estado, emoji, etiqueta, titulo, sub, color = ("foto_falsa", "📵", "Ups", "Usa tu cara, no una foto",
                                                           "Ponte tú frente a la cámara.", core.NARANJA)
            frase = "Usa tu cara, no una foto."
        elif codigo == "no_reconocido":
            estado, emoji, etiqueta, titulo, sub, color = ("no_reconoce", "🤔", "No te encontré",
                                                           "No te reconozco",
                                                           "Prueba otra vez o busca a tu entrenador.", core.ROJO)
            frase = "No te reconozco. Prueba otra vez o busca a tu entrenador."
        elif codigo == "sin_jugadores":
            estado, emoji, etiqueta, titulo, sub, color = ("error", "📋", "Falta inscribir", "Aún no hay jugadores",
                                                           "El staff debe inscribirlos primero.", core.ROJO)
        else:
            estado, emoji, etiqueta, titulo, sub, color = ("error", "⚠️", "Sin conexión", "Sistema no disponible",
                                                           "Avísale a tu entrenador.", core.ROJO)

    cabecera.markdown(core.cabecera_kiosko(titulo, sub, etiqueta, color), unsafe_allow_html=True)
    lado.markdown(core.mascota(estado, f"<div class=emoji>{emoji}</div>", centro=True), unsafe_allow_html=True)
    tono_escaner(color, "Volver a escanear")

    with pie:
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
            if st.button("Siguiente niño", icon=":material/arrow_forward:", type="primary", width="stretch"):
                siguiente()
        else:
            # Cuenta regresiva visible y reinicio automático para el siguiente niño.
            barra = st.progress(1.0, text=f"Siguiente en {RESET_SECONDS} s…")
            pasos = RESET_SECONDS * 10
            for i in range(pasos, 0, -1):
                time.sleep(0.1)
                barra.progress((i - 1) / pasos, text=f"Siguiente en {max(1, -(-(i - 1) // 10))} s…")
            siguiente()
