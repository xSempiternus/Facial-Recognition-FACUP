"""Guía de estilo: los componentes y reglas del sistema visual, en un solo lugar."""

import streamlit as st

import core

core.requerir_staff()
core.header("Guía de estilo", "Identidad FA CUP Chile + reglas de Shopify Polaris y NHS.",
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
        ("Morado FA CUP", core.MORADO, "Marca: logo, títulos, cabecera y fondo del kiosko (facupchile.cl)."),
        ("Morado acción", core.MORADO_2, "Botón principal. Texto blanco con contraste AAA."),
        ("Dorado", core.DORADO, "Acento: brillo del escaneo, celebración y foco de teclado. Texto oscuro encima."),
        ("Lavanda", core.LAVANDA, "Secundario: textos de apoyo y viñetas."),
        ("Atención", "#b45309", "Advertencias: algo requiere revisión."),
        ("Peligro", "#c62f3b", "Errores y acciones destructivas."),
        ("Información", "#4f46e5", "Avisos neutros, estados informativos."),
        ("Fondo", "#f6f3f8", "Fondo de las páginas del staff."),
    ]
    cols = st.columns(4)
    for i, (nombre, hexa, uso) in enumerate(colores):
        borde = "border:1px solid #e8e3ea;" if hexa == "#f6f3f8" else ""
        cols[i % 4].markdown(
            f'<div style="margin-bottom:14px"><div style="height:56px;border-radius:12px;background:{hexa};{borde}"></div>'
            f'<b>{nombre}</b> <code>{hexa}</code><div class="fc-muted" style="font-size:.85rem">{uso}</div></div>',
            unsafe_allow_html=True)

# ------------------------------------------------------------------ botones
with st.container(border=True):
    st.markdown("#### :material/smart_button: Botones")
    st.caption("Botones planos con jerarquía clara: el principal en morado, el resto discreto. "
               "El foco de teclado se marca con un anillo dorado.")
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
    st.caption("Modo oscuro con el morado FA CUP, marco de escaneo dorado y títulos en PlutoSans "
               "mayúscula. Un mensaje enorme por pantalla y color con significado; se reinicia solo y saluda "
               "en voz alta. La mascota reemplaza al emoji cuando está en ui/static/mascota/.")
    if st.button("Probar voz", icon=":material/record_voice_over:",
                 help="Útil para revisar que los parlantes del kiosko funcionen."):
        core.hablar("¡Hola, Sofía! ¡A jugar!")
    a, b, c, d = st.columns(4)
    for col, args in zip([a, b, c, d], [
        ("celebra", "🎉", "Registrada", "¡Hola, Sofía!", "¡A jugar!", core.EXITO),
        ("de_nuevo", "👍", "Ya anotada", "¡Hola de nuevo!", "Ya estabas anotada", core.AZUL),
        ("no_veo", "🙈", "Ups", "No veo tu cara", "Acércate", core.NARANJA),
        ("no_reconoce", "🤔", "No te encontré", "No te reconozco", "Busca a tu entrenador", core.ROJO),
    ]):
        col.markdown(f'<div class="fc-kdemo">{core.resultado_kiosko(*args)}</div>', unsafe_allow_html=True)

# ------------------------------------------------------------------ íconos y tono
with st.container(border=True):
    st.markdown("#### :material/interests: Íconos y tono")
    st.markdown(
        "- **Staff:** íconos monocromáticos Material (`:material/nombre:`), uno por concepto y siempre el mismo: "
        ":material/person_add: inscribir · :material/groups: jugadores · :material/fact_check: asistencia · "
        ":material/verified_user: autorización · :material/delete: eliminar · :material/download: descargar.\n"
        "- **Kiosko:** la mascota FA CUP (o emojis grandes mientras no esté): los niños la entienden sin leer.\n"
        "- **Tono:** cercano y directo, en segunda persona («Toma la foto», «Escribe el nombre»). "
        "Con los niños, festivo («¡A jugar!»); con el staff, claro y breve."
    )
