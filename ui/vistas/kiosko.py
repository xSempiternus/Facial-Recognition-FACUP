"""Kiosko de llegada: el niño se escanea la cara y queda registrada su asistencia."""

import time

import streamlit as st

import core

RESET_SECONDS = 4  # tiempo que se muestra el resultado antes de volver a la cámara

ss = st.session_state
ss.setdefault("kiosk_key", 0)


def siguiente():
    ss.kiosk_key += 1
    st.rerun()


core.estilo_kiosko()

BIENVENIDA = (
    core.mascota("bienvenida", core.balon_html(size=76))
    + '<div class="fc-k-saludo">'
    '<div class="fc-eyebrow">Bienvenido a la cancha</div>'
    '<div class="fc-k-titulo">¡Hola,<br><em>crack!</em></div>'
    '<div class="fc-k-pasos">'
    '<div class="fc-k-paso"><b>1</b>Mira la cámara</div>'
    '<div class="fc-k-paso"><b>2</b>Aprieta «¡Escanéame!»</div>'
    '<div class="fc-k-paso"><b>3</b>¡A jugar!</div>'
    "</div>"
    '<div class="fc-k-lema">Fútbol y amistad</div>'
    "</div>"
)

with st.container(key="kiosko"):
    # Barra de estado (el logo va en la cabecera): en vivo · llegadas de hoy · fecha, y ajustes discretos.
    ok_hoy, hoy = core.call_api("GET", "/asistencias", params={"hoy": "true", "limit": 1000})
    llegadas = f"<span class='fc-k-chip'><b>{len(hoy)}</b> llegaron hoy</span>" if ok_hoy else ""
    estado, ajustes = st.columns([12, 1], vertical_alignment="center")
    estado.markdown(
        '<div class="fc-k-top"><span class="fc-k-chip"><i></i>En vivo</span>'
        f'{llegadas}<span class="fc-k-chip">{core.fecha_larga()}</span></div>',
        unsafe_allow_html=True,
    )
    with ajustes.popover("", icon=":material/tune:", help="Ajustes rápidos"):
        st.toggle(":material/photo_camera: Cámara encendida", value=ss.cfg_camara, key="w_camara",
                  on_change=core._sync, args=("w_camara", "cfg_camara"))
        st.toggle(":material/record_voice_over: Voz", value=ss.cfg_voz, key="w_voz",
                  on_change=core._sync, args=("w_voz", "cfg_voz"))
        st.toggle(":material/science: Modo prueba", value=ss.cfg_prueba, key="w_prueba",
                  on_change=core._sync, args=("w_prueba", "cfg_prueba"))

    if not core.camara_on():
        _, centro, _ = st.columns([1, 2, 1])
        centro.markdown(core.resultado_kiosko("error", "📷", "Pausa", "Cámara apagada",
                                              "Enciéndela en ajustes para marcar asistencia", core.GRIS),
                        unsafe_allow_html=True)
        st.stop()

    izq, der = st.columns([1, 1.2], gap="large", vertical_alignment="center")
    panel = izq.empty()
    panel.markdown(BIENVENIDA, unsafe_allow_html=True)

    with der, st.container(key="k_cam"):
        foto = st.camera_input("Foto", key=f"kiosk_{ss.kiosk_key}", label_visibility="collapsed")
    if foto is None:
        st.stop()

    panel.markdown(core.mascota("buscando", core.balon_html("Escaneando…", size=110), centro=True),
                   unsafe_allow_html=True)
    ok, data = core.call_api("POST", "/verify", files=core.image_file(foto))

    frase = None  # lo que dirá la voz del kiosko
    if ok:
        nombre = data["nombre"].split()[0]
        if data["ya_registrado"]:
            hora = data["registrado_a_las"][11:16]
            tarjeta = core.resultado_kiosko("de_nuevo", "👍", "Ya estabas anotado", f"¡Hola de nuevo, {nombre}!",
                                            f"Te anotaste hoy a las {hora}", core.AZUL)
            frase = f"¡Hola de nuevo, {nombre}! Ya estabas anotado."
        else:
            tarjeta = core.resultado_kiosko("celebra", "🎉", "Asistencia registrada", f"¡Hola, {nombre}!",
                                            "¡A jugar! ⚽", core.EXITO)
            core.celebrar()
            frase = f"¡Hola, {nombre}! ¡A jugar!"
    else:
        codigo = data.get("codigo")
        if codigo == "sin_rostro":
            tarjeta = core.resultado_kiosko("no_veo", "🙈", "Ups", "No veo tu cara",
                                            "Acércate, mira la cámara y prueba otra vez", core.NARANJA)
            frase = "No veo tu cara. Acércate un poquito y prueba otra vez."
        elif codigo == "foto_falsa":
            tarjeta = core.resultado_kiosko("foto_falsa", "📵", "Ups", "Usa tu cara, no una foto",
                                            "Ponte tú frente a la cámara", core.NARANJA)
            frase = "Usa tu cara, no una foto."
        elif codigo == "no_reconocido":
            tarjeta = core.resultado_kiosko("no_reconoce", "🤔", "No te encontré", "No te reconozco",
                                            "Prueba otra vez o busca a tu entrenador", core.ROJO)
            frase = "No te reconozco. Prueba otra vez o busca a tu entrenador."
        elif codigo == "sin_jugadores":
            tarjeta = core.resultado_kiosko("error", "📋", "Falta inscribir", "Aún no hay jugadores",
                                            "El staff debe inscribirlos primero", core.ROJO)
        else:
            tarjeta = core.resultado_kiosko("error", "⚠️", "Sin conexión", "Sistema no disponible",
                                            "Avísale a tu entrenador", core.ROJO)

    with panel.container():
        st.markdown(tarjeta, unsafe_allow_html=True)

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
