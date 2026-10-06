"""Guía de estilo: los componentes y reglas del sistema visual, en un solo lugar."""

import streamlit as st

import core

core.requerir_staff()
core.header("Guía de estilo", "Reglas de Shopify Polaris + NHS, con identidad de fútbol infantil.",
            mostrar_estado=False)

st.info("Esta página es la referencia para mantener la app coherente. Antes de agregar una pantalla nueva, "
        "usa estos componentes y reglas en vez de inventar otros.", icon=":material/palette:")

# ------------------------------------------------------------------ principios
with st.container(border=True):
    st.markdown("#### :material/flag: Principios")
    c1, c2, c3 = st.columns(3)
    c1.markdown("**1. Una acción principal por pantalla.** Si todo resalta, nada resalta. (Polaris)")
    c2.markdown("**2. El color significa algo.** Verde = bien, amarillo = atención, rojo = peligro o error. "
                "Nunca solo decoración.")
    c3.markdown("**3. Claro antes que ingenioso.** Frases cortas, verbos concretos, una idea por pantalla. (NHS)")

# ------------------------------------------------------------------ colores
with st.container(border=True):
    st.markdown("#### :material/format_color_fill: Colores")
    colores = [
        ("Verde cancha", "#15803d", "Acción principal, éxito. Texto blanco con contraste AA."),
        ("Verde oscuro", "#14532d", "Borde táctil de botones, títulos del kiosko."),
        ("Texto", "#0f172a", "Texto principal."),
        ("Texto secundario", "#475569", "Descripciones y ayudas."),
        ("Atención", "#b45309", "Advertencias: algo requiere revisión."),
        ("Peligro", "#b91c1c", "Errores y acciones destructivas."),
        ("Información", "#1d4ed8", "Avisos neutros, estados informativos."),
        ("Fondo", "#f5f7fb", "Fondo de las páginas del staff."),
    ]
    cols = st.columns(4)
    for i, (nombre, hexa, uso) in enumerate(colores):
        borde = "border:1px solid #e2e8f0;" if hexa == "#f5f7fb" else ""
        cols[i % 4].markdown(
            f'<div style="margin-bottom:14px"><div style="height:56px;border-radius:12px;background:{hexa};{borde}"></div>'
            f'<b>{nombre}</b> <code>{hexa}</code><div class="fc-muted" style="font-size:.85rem">{uso}</div></div>',
            unsafe_allow_html=True)

# ------------------------------------------------------------------ botones
with st.container(border=True):
    st.markdown("#### :material/smart_button: Botones")
    st.caption("Todos los botones son «táctiles»: se hunden al apretarlos (estilo NHS), ideal para pantallas táctiles.")
    a, b, c, d, e = st.columns(5)
    a.button("Inscribir", type="primary", icon=":material/person_add:", key="ej_pri", width="stretch")
    b.button("Ver jugadores", icon=":material/groups:", key="ej_sec", width="stretch")
    c.button("Repetir", type="tertiary", icon=":material/replay:", key="ej_ter", width="stretch")
    with d, core.peligro("ejemplo"):
        st.button("Sí, eliminar", icon=":material/delete:", key="ej_pel", width="stretch")
    e.button("Deshabilitado", disabled=True, key="ej_dis", width="stretch")
    a.caption("**Principal** · la acción que el usuario vino a hacer. Máximo una por pantalla.")
    b.caption("**Secundario** · alternativas o navegación.")
    c.caption("**Terciario** · acciones menores dentro de una tarjeta.")
    d.caption("**Peligro** · solo para confirmar algo irreversible, dentro de un diálogo.")
    e.caption("**Deshabilitado** · cuando falta algo; explica qué con un texto cercano.")
    st.markdown("**Textos de botón:** verbo + objeto (*Inscribir jugador*, *Descargar CSV*). "
                "Nunca «OK», «Aceptar» o «Procesar». Ícono a la izquierda solo si ayuda a reconocerlo.")

# ------------------------------------------------------------------ badges y avisos
with st.container(border=True):
    st.markdown("#### :material/label: Etiquetas de estado")
    st.markdown(" ".join([core.pill("✓ Firmada", "ok"), core.pill("Falta foto", "warn"),
                          core.pill("Servidor apagado", "err"), core.pill("Experimental", "warn"),
                          core.pill("3 fotos", "info"), core.pill("Sin categoría")]), unsafe_allow_html=True)
    st.caption("Describen el estado de algo (no son botones). Texto corto, tono según el significado.")

    st.markdown("#### :material/campaign: Avisos")
    st.success("Asistencia registrada. Hoy vinieron 18 de 20 jugadores.", icon=":material/check_circle:")
    st.info("La evaluación tarda de 2 a 15 minutos según la cantidad de fotos.", icon=":material/info:")
    st.warning("2 jugadores no tienen la autorización del tutor registrada.", icon=":material/verified_user:")
    st.error("No encontramos una cara en la foto 2. Repítela con buena luz.", icon=":material/error:")
    st.caption("Regla NHS para errores: dice **qué pasó** y **qué hacer**. Nunca culpa al usuario ni usa jerga.")

# ------------------------------------------------------------------ tarjetas / vacíos / carga
with st.container(border=True):
    st.markdown("#### :material/dashboard: Tarjetas, estados vacíos y carga")
    a, b, c = st.columns(3)
    with a:
        st.markdown(f'<div class="fc-card" style="display:flex;gap:12px;align-items:center">'
                    f'{core.avatar("Sofía Pérez", 48)}<div><b>Sofía Pérez</b>'
                    f'<div class="fc-muted">Sub-10 · 12 asistencias</div></div></div>', unsafe_allow_html=True)
        st.caption("**Tarjeta** · agrupa información de una misma cosa.")
    with b:
        core.empty_state("🕐", "Nadie ha llegado todavía", "Los niños aparecerán aquí al marcar en el kiosko.")
        st.caption("**Estado vacío** · explica por qué está vacío y qué hacer.")
    with c:
        st.markdown(core.balon_html("Buscándote…"), unsafe_allow_html=True)
        st.caption("**Carga** · el balón reemplaza al spinner genérico en toda la app.")
    if st.button("Probar celebración de gol", icon=":material/sports_soccer:"):
        core.celebrar()

# ------------------------------------------------------------------ kiosko
with st.container(border=True):
    st.markdown("#### :material/touch_app: Kiosko (niños)")
    st.caption("Un mensaje enorme por pantalla, emoji grande y color con significado. Se reinicia solo. "
               "Además, el kiosko saluda en voz alta (se puede apagar en los ajustes rápidos).")
    if st.button("Probar voz", icon=":material/record_voice_over:",
                 help="Útil para revisar que los parlantes del kiosko funcionen."):
        core.hablar("¡Hola, Sofía! ¡A jugar!")
    a, b, c, d = st.columns(4)
    for col, (emoji, titulo, sub, color) in zip([a, b, c, d], [
        ("🎉", "¡Hola, Sofía!", "¡A jugar!", core.VERDE),
        ("👍", "¡Hola de nuevo!", "Ya estabas anotada", core.AZUL),
        ("🙈", "No veo tu cara", "Acércate", core.NARANJA),
        ("🤔", "No te reconozco", "Busca a tu entrenador", core.ROJO),
    ]):
        with col:
            st.markdown(
                f'<div class="fc-result" style="background:{color};padding:18px 10px;border-radius:18px">'
                f'<div class="emoji" style="font-size:44px">{emoji}</div>'
                f'<div class="titulo" style="font-size:1.25rem">{titulo}</div>'
                f'<div class="sub" style="font-size:.95rem">{sub}</div></div>', unsafe_allow_html=True)

# ------------------------------------------------------------------ íconos y tono
with st.container(border=True):
    st.markdown("#### :material/interests: Íconos y tono")
    st.markdown(
        "- **Staff:** íconos monocromáticos Material (`:material/nombre:`), uno por concepto y siempre el mismo: "
        ":material/person_add: inscribir · :material/groups: jugadores · :material/fact_check: asistencia · "
        ":material/verified_user: autorización · :material/delete: eliminar · :material/download: descargar.\n"
        "- **Kiosko:** emojis grandes y alegres: los niños los entienden sin leer.\n"
        "- **Tono:** cercano y directo, en segunda persona («Toma la foto», «Escribe el nombre»). "
        "Con los niños, festivo («¡A jugar!»); con el staff, claro y breve."
    )
