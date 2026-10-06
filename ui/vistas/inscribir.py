"""Inscripción guiada en 3 pasos: Datos → Fotos (3 poses) → Listo."""

import streamlit as st

import core

core.requerir_staff()

ss = st.session_state
ss.setdefault("insc_paso", 1)
ss.setdefault("insc_nombre", "")
ss.setdefault("insc_categoria", None)
ss.setdefault("insc_tutor", "")
ss.setdefault("insc_resultado", None)
ss.setdefault("insc_duplicado", None)
ss.setdefault("insc_error", None)
ss.setdefault("insc_cam_key", 0)
ss.setdefault("insc_fotos", [])  # [(bytes, mime)] capturadas en el paso 2

# Tres fotos con poses distintas: el reconocimiento compara contra todas y usa la más parecida.
POSES = [
    ("🙂", "De frente", "Mirando directo a la cámara."),
    ("↩️", "Un poquito a su izquierda", "Gira apenas la cabeza, sin dejar de mirar la cámara."),
    ("↪️", "Un poquito a su derecha", "Igual, pero hacia el otro lado."),
]


def ir_a(paso: int):
    ss.insc_paso = paso
    st.rerun()


def reiniciar():
    ss.insc_nombre, ss.insc_categoria, ss.insc_tutor = "", None, ""
    ss.insc_resultado = ss.insc_duplicado = ss.insc_error = None
    ss.insc_fotos = []
    ss.insc_cam_key += 1
    ir_a(1)


def enviar(forzar: bool):
    files = [("files", (f"foto{i + 1}.jpg", b, mime)) for i, (b, mime) in enumerate(ss.insc_fotos)]
    data = {"nombre": ss.insc_nombre, "categoria": ss.insc_categoria or "",
            "forzar": str(forzar).lower(), "consentimiento": "true", "tutor": ss.insc_tutor}
    ok, res = core.call_api("POST", "/enroll", files=files, data=data)
    ss.insc_error = ss.insc_duplicado = None
    if ok:
        ss.insc_resultado = res
        ss.insc_fotos = []
        ss.insc_cam_key += 1
        ir_a(3)
    elif res.get("codigo") == "posible_duplicado":
        ss.insc_duplicado = res
    else:
        ss.insc_error = res
        # Si el problema es una foto concreta, se descarta para repetirla y se conservan las demás.
        if res.get("foto") and 0 < res["foto"] <= len(ss.insc_fotos):
            ss.insc_fotos.pop(res["foto"] - 1)
            ss.insc_cam_key += 1
    st.rerun()


core.header("Inscribir jugador", "Registra a un niño nuevo en 3 pasos simples.")
core.stepper(["Datos", "Fotos", "¡Listo!"], ss.insc_paso)

# ------------------------------------------------------------------ paso 1
if ss.insc_paso == 1:
    _, centro, _ = st.columns([1, 2, 1])
    with centro, st.container(border=True):
        st.markdown("#### ¿Quién es el jugador?")
        nombre = st.text_input("Nombre y apellido", value=ss.insc_nombre,
                               placeholder="Ej: Sofía Pérez", max_chars=60)
        categoria = st.segmented_control("Categoría (opcional)", core.CATEGORIAS,
                                         default=ss.insc_categoria, key="insc_cat_widget")
        st.divider()
        st.markdown("#### :material/verified_user: Autorización")
        tutor = st.text_input("Nombre del padre, madre o tutor", value=ss.insc_tutor,
                              placeholder="Quien firmó la autorización", max_chars=80)
        autoriza = st.checkbox(
            "Tengo la **autorización firmada** para usar la cara del niño en el control de asistencia",
            value=bool(ss.insc_tutor),
            help="Son datos biométricos de un menor: sin autorización no se puede inscribir.")
        # Sin "disabled": st.text_input solo envía su valor al perder el foco o con Enter.
        if st.button("Continuar", type="primary", width="stretch", icon=":material/arrow_forward:"):
            if not nombre.strip():
                st.error("Escribe el nombre del jugador para continuar.")
            elif not (tutor.strip() and autoriza):
                st.error("Falta la autorización: escribe el nombre del tutor y marca la casilla.")
            else:
                ss.insc_nombre, ss.insc_categoria, ss.insc_tutor = nombre.strip(), categoria, tutor.strip()
                ir_a(2)

# ------------------------------------------------------------------ paso 2
elif ss.insc_paso == 2:
    izq, der = st.columns([1, 1.4], gap="large")
    with izq:
        cat = f" · {ss.insc_categoria}" if ss.insc_categoria else ""
        st.markdown(
            f'<div class="fc-card" style="display:flex;gap:14px;align-items:center">'
            f'{core.avatar(ss.insc_nombre, 52)}<div><b style="font-size:1.2rem">{core.esc(ss.insc_nombre)}</b>'
            f'<div class="fc-muted">{core.esc(cat.strip(" ·") or "Sin categoría")}</div></div></div>',
            unsafe_allow_html=True,
        )
        st.markdown(
            '<div class="fc-card" style="margin-top:14px"><b>Para una buena foto</b>'
            + core.tip("📏", "A unos 50 cm", "La cara debe verse grande y centrada.")
            + core.tip("💡", "Buena luz", "Luz sobre la cara, nunca a contraluz.")
            + core.tip("🧢", "Sin accesorios", "Sin gorra, lentes de sol ni mascarilla.")
            + core.tip("👤", "Solo uno", "Que no aparezca nadie más en la foto.")
            + "</div>",
            unsafe_allow_html=True,
        )
        if st.button("Cambiar datos", width="stretch", icon=":material/arrow_back:"):
            ir_a(1)

    with der:
        if ss.insc_duplicado:
            d = ss.insc_duplicado
            extra = f" (parecido {d['similitud']:.2f})" if core.modo_prueba() else ""
            with st.container(border=True):
                st.markdown("### ⚠️ ¿Ya está inscrito?")
                st.write(f"Esta cara se parece mucho a **{d['nombre_existente']}**{extra}. "
                         "¿Es otro niño o el mismo?")
                c1, c2 = st.columns(2)
                if c1.button("Es otro niño: inscribir", type="primary", width="stretch"):
                    enviar(forzar=True)
                if c2.button("Es el mismo: cancelar", width="stretch"):
                    reiniciar()
            st.stop()

        if ss.insc_error:
            codigo = ss.insc_error.get("codigo")
            n = ss.insc_error.get("foto")
            if codigo == "sin_rostro":
                cual = f"la foto {n}" if n else "la foto"
                st.error(f"😕 No encontramos una cara en {cual}. Repítela con buena luz y mirando de frente.")
            elif codigo == "fotos_inconsistentes":
                st.error(f"😕 La foto {n} no parece de la misma persona que las otras. Repítela.")
            else:
                st.error(f"😕 {ss.insc_error.get('mensaje')}")

        fotos = ss.insc_fotos
        n_fotos = len(fotos)

        # Fotos ya tomadas, con opción de repetir cada una.
        if fotos:
            for i, col in enumerate(st.columns(len(POSES))):
                with col:
                    if i < n_fotos:
                        st.image(fotos[i][0], caption=f"{i + 1}. {POSES[i][1]}", width="stretch")
                        if st.button("Repetir", key=f"rep_{i}_{ss.insc_cam_key}", width="stretch", type="tertiary",
                                     icon=":material/replay:"):
                            fotos.pop(i)
                            ss.insc_error = None
                            ss.insc_cam_key += 1
                            st.rerun()
                    else:
                        st.markdown(f'<div class="fc-card fc-muted" style="text-align:center;padding:28px 8px">'
                                    f'<div style="font-size:30px">{POSES[i][0]}</div>{i + 1}. {POSES[i][1]}</div>',
                                    unsafe_allow_html=True)

        if n_fotos < len(POSES):
            icono, titulo, texto = POSES[n_fotos]
            st.markdown(f"#### Foto {n_fotos + 1} de {len(POSES)}: {icono} {titulo}")
            st.caption(texto)
            if not core.camara_on():
                core.empty_state("📷", "Cámara apagada", "Enciéndela en ⚙️ (arriba a la derecha).")
                st.stop()
            foto = st.camera_input(f"Foto {n_fotos + 1}", key=f"insc_cam_{ss.insc_cam_key}",
                                   label_visibility="collapsed")
            if foto is not None:
                fotos.append((foto.getvalue(), foto.type or "image/jpeg"))
                ss.insc_error = None
                ss.insc_cam_key += 1  # reinicia la cámara para la siguiente pose
                st.rerun()
            if n_fotos > 0 and st.button(f"Inscribir solo con {n_fotos} foto{'s' if n_fotos > 1 else ''}",
                                         width="stretch", help="Funciona, pero con 3 fotos lo reconoce mejor."):
                with core.cargando("Analizando las caras e inscribiendo…"):
                    enviar(forzar=False)
        else:
            st.success("📸 ¡Listo! Las 3 fotos están tomadas.")
            if st.button(f"Inscribir a {ss.insc_nombre.split()[0]}", type="primary", width="stretch",
                         icon=":material/how_to_reg:"):
                with core.cargando("Analizando las 3 caras e inscribiendo…"):
                    enviar(forzar=False)

# ------------------------------------------------------------------ paso 3
else:
    res = ss.insc_resultado or {}
    _, centro, _ = st.columns([1, 2, 1])
    with centro:
        cat = res.get("categoria") or "Sin categoría"
        st.markdown(
            f'<div class="fc-card" style="text-align:center;padding:34px">'
            f'{core.avatar(res.get("nombre", "?"), 84)}'
            f'<h2 style="margin:.6rem 0 .2rem">¡{core.esc(res.get("nombre", ""))} ya está en el equipo! ⚽</h2>'
            f'{core.pill(cat, "ok")}'
            f'<p class="fc-muted" style="margin-top:12px">Inscrito con {res.get("fotos", 1)} foto(s). '
            f'Desde ahora puede marcar su llegada en el kiosko.</p>'
            f"</div>",
            unsafe_allow_html=True,
        )
        for aviso in res.get("avisos", []):
            st.warning(f"⚠️ {aviso}")
        if core.modo_prueba() and res.get("calidad"):
            for i, q in enumerate(res["calidad"], 1):
                st.caption(f"Foto {i}: {q['num_rostros']} cara(s) · confianza {q['confianza']:.2f} · "
                           f"tamaño de la cara {q['tamano_rostro']:.0%} del ancho")
        c1, c2 = st.columns(2)
        if c1.button("Inscribir otro", type="primary", width="stretch", icon=":material/person_add:"):
            reiniciar()
        if c2.button("Ver jugadores", width="stretch", icon=":material/groups:"):
            st.switch_page("vistas/jugadores.py")
