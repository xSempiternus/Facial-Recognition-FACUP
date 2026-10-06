"""Utilidades compartidas por las páginas: cliente de la API, estado, estilos y componentes."""

import hashlib
import html
import json
import os
import random
from contextlib import contextmanager

import requests
import streamlit as st

API_URL = os.getenv("API_URL", "http://127.0.0.1:8000")
STAFF_PIN = os.getenv("STAFF_PIN", "1234")
TIMEOUT = 60  # la primera inferencia puede tardar
CATEGORIAS = ["Sub-6", "Sub-8", "Sub-10", "Sub-12", "Sub-14", "Sub-16"]


def ordenar_categorias(categorias) -> list[str]:
    """Por edad (Sub-6, Sub-8, Sub-10…), no alfabético; las desconocidas al final."""
    def clave(c):
        digitos = "".join(ch for ch in c if ch.isdigit())
        return (0, int(digitos), c) if digitos else (1, 0, c)
    return sorted(categorias, key=clave)

VERDE, AZUL, NARANJA, ROJO, GRIS = "#15803d", "#1d4ed8", "#c2410c", "#b91c1c", "#475569"
_AVATAR_COLORES = ["#16a34a", "#2563eb", "#9333ea", "#ea580c", "#0891b2", "#db2777", "#ca8a04"]


# ---------------------------------------------------------------- API

def call_api(method: str, endpoint: str, **kwargs):
    """Retorna (ok, data). En error, data es {'codigo', 'mensaje', ...}."""
    try:
        resp = requests.request(method, f"{API_URL}{endpoint}", timeout=TIMEOUT, **kwargs)
    except requests.RequestException:
        return False, {"codigo": "sin_conexion", "mensaje": "No se pudo conectar con el servidor."}
    try:
        data = resp.json()
    except ValueError:
        data = {}
    if resp.ok:
        return True, data
    detail = data.get("detail", {}) if isinstance(data, dict) else {}
    if not isinstance(detail, dict):
        detail = {"codigo": "error", "mensaje": str(detail)}
    detail.setdefault("mensaje", f"Error del servidor ({resp.status_code}).")
    return False, detail


def image_file(image):
    return {"file": ("foto.jpg", image.getvalue(), image.type or "image/jpeg")}


# ---------------------------------------------------------------- estado

def init_state() -> None:
    ss = st.session_state
    ss.setdefault("staff_ok", False)
    # Ajustes persistentes entre páginas (el estado de un widget se borra al cambiar de página).
    ss.setdefault("cfg_camara", True)
    ss.setdefault("cfg_prueba", False)
    ss.setdefault("cfg_voz", True)


def _sync(clave_widget: str, clave_cfg: str):
    st.session_state[clave_cfg] = st.session_state[clave_widget]


def camara_on() -> bool:
    return st.session_state.cfg_camara


def modo_prueba() -> bool:
    return st.session_state.cfg_prueba


def voz_on() -> bool:
    return st.session_state.cfg_voz


def hablar(texto: str) -> None:
    """
    Dice el texto en voz alta con la síntesis de voz del navegador (sin instalar nada).
    Funciona porque el niño acaba de tocar el botón de la cámara: los navegadores solo permiten
    reproducir sonido después de una interacción del usuario.
    """
    literal = json.dumps(texto).replace("</", "<\\/")  # seguro dentro de <script>
    st.html(
        f"""<script>
(function () {{
  const s = window.speechSynthesis;
  if (!s) return;
  const decir = () => {{
    const u = new SpeechSynthesisUtterance({literal});
    const voces = s.getVoices();
    const preferidas = ["es-CL", "es-419", "es-MX", "es-US", "es-AR", "es-CO", "es-ES"];
    let voz = null;
    for (const p of preferidas) {{ voz = voces.find(v => v.lang.replace("_", "-") === p); if (voz) break; }}
    if (!voz) voz = voces.find(v => v.lang.toLowerCase().startsWith("es"));
    if (voz) u.voice = voz;
    u.lang = voz ? voz.lang : "es-419";
    u.rate = 1.0; u.pitch = 1.15;
    s.cancel(); s.speak(u);
  }};
  if (s.getVoices().length) decir();
  else s.addEventListener("voiceschanged", decir, {{ once: true }});
}})();
</script>""",
        unsafe_allow_javascript=True,
    )


# ---------------------------------------------------------------- estilos

# Sistema visual: jerarquía y patrones de Shopify Polaris + botones táctiles y foco accesible del NHS,
# con identidad de fútbol (verde cancha, balón de carga, celebración de gol). Ver página "Guía de estilo".
CSS = """
<style>
:root {
  --fc-verde: #15803d;        /* principal: texto blanco con contraste AA (5:1) */
  --fc-verde-hover: #166534;
  --fc-verde-borde: #14532d;  /* borde inferior "táctil" estilo NHS */
  --fc-verde-suave: #dcfce7;
  --fc-texto: #0f172a;
  --fc-texto-2: #475569;      /* secundario: 7:1 sobre blanco */
  --fc-borde: #e2e8f0;
  --fc-borde-fuerte: #cbd5e1;
  --fc-superficie: #ffffff;
  --fc-fondo: #f5f7fb;
  --fc-peligro: #b91c1c; --fc-peligro-borde: #7f1d1d;
  --fc-atencion: #b45309; --fc-atencion-suave: #fef3c7;
  --fc-info: #1d4ed8; --fc-info-suave: #dbeafe;
  --fc-foco: #ffdd00;         /* foco de teclado NHS: amarillo + subrayado oscuro */
  --fc-radio: 12px; --fc-radio-card: 18px;
  --fc-sombra: 0 1px 2px rgba(15,23,42,.05), 0 6px 20px rgba(15,23,42,.06);
}

footer {display: none !important;}
[data-testid="stMainMenu"], [data-testid="stAppDeployButton"] {display: none !important;}
.block-container {padding-top: 2.2rem; padding-bottom: 3rem; max-width: 1100px;}
h1, h2, h3, h4 {color: var(--fc-texto); letter-spacing: -.01em;}

/* ---------- Botones: primario táctil (NHS), secundario con borde, terciario plano (Polaris) ---------- */
[data-testid="stBaseButton-primary"], [data-testid="stBaseButton-primaryFormSubmit"] {
  background: var(--fc-verde) !important; border: 0 !important; color: #fff !important;
  font-weight: 800 !important; box-shadow: 0 4px 0 var(--fc-verde-borde) !important;
  transition: transform .06s ease, box-shadow .06s ease, background .15s ease;
}
[data-testid="stBaseButton-primary"]:hover, [data-testid="stBaseButton-primaryFormSubmit"]:hover {
  background: var(--fc-verde-hover) !important;
}
[data-testid="stBaseButton-primary"]:active, [data-testid="stBaseButton-primaryFormSubmit"]:active {
  transform: translateY(3px); box-shadow: 0 1px 0 var(--fc-verde-borde) !important;
}
[data-testid="stBaseButton-secondary"], [data-testid="stBaseButton-secondaryFormSubmit"] {
  background: var(--fc-superficie) !important; border: 1px solid var(--fc-borde-fuerte) !important;
  color: var(--fc-texto) !important; font-weight: 700 !important;
  box-shadow: 0 3px 0 var(--fc-borde-fuerte) !important; transition: transform .06s ease, box-shadow .06s ease;
}
[data-testid="stBaseButton-secondary"]:hover {border-color: var(--fc-texto-2) !important;}
[data-testid="stBaseButton-secondary"]:active {transform: translateY(2px); box-shadow: 0 1px 0 var(--fc-borde-fuerte) !important;}
[data-testid="stBaseButton-tertiary"] {color: var(--fc-verde) !important; font-weight: 700 !important;}
button:disabled, button[disabled] {opacity: .45 !important; box-shadow: none !important; transform: none !important;}

/* Variante peligro (Polaris "critical"): envolver el botón en st.container(key="peligro_...") */
[class*="st-key-peligro"] [data-testid^="stBaseButton"] {
  background: var(--fc-peligro) !important; color: #fff !important; border: 0 !important;
  box-shadow: 0 4px 0 var(--fc-peligro-borde) !important;
}
[class*="st-key-peligro"] [data-testid^="stBaseButton"]:hover {background: #991b1b !important;}

/* Foco visible para teclado (NHS) */
button:focus-visible, a:focus-visible, input:focus-visible, [role="tab"]:focus-visible {
  outline: 3px solid transparent !important; background-color: var(--fc-foco) !important;
  color: #0b0c0c !important; box-shadow: 0 -2px var(--fc-foco), 0 4px #0b0c0c !important;
}

/* ---------- Avisos (Polaris Banner / NHS callout): barra lateral de color ---------- */
[data-testid="stAlertContainer"] {border-radius: var(--fc-radio) !important; border-left: 6px solid !important;}
[data-testid="stAlertContainer"]:has([data-testid="stAlertContentWarning"]) {border-left-color: var(--fc-atencion) !important;}
[data-testid="stAlertContainer"]:has([data-testid="stAlertContentError"]) {border-left-color: var(--fc-peligro) !important;}
[data-testid="stAlertContainer"]:has([data-testid="stAlertContentSuccess"]) {border-left-color: var(--fc-verde) !important;}
[data-testid="stAlertContainer"]:has([data-testid="stAlertContentInfo"]) {border-left-color: var(--fc-info) !important;}

/* ---------- Superficies ---------- */
.fc-card {background: var(--fc-superficie); border: 1px solid var(--fc-borde); border-radius: var(--fc-radio-card);
          padding: 22px 24px; box-shadow: var(--fc-sombra);}
.fc-muted {color: var(--fc-texto-2);}

/* Badges (Polaris): tono = significado, nunca decoración */
.fc-pill {display:inline-flex; align-items:center; gap:6px; padding: 3px 11px; border-radius: 999px;
          font-size: .85rem; font-weight: 700; background:#f1f5f9; color:#334155; white-space:nowrap;}
.fc-pill.ok {background: var(--fc-verde-suave); color:#14532d;}
.fc-pill.warn {background: var(--fc-atencion-suave); color:#78350f;}
.fc-pill.err {background:#fee2e2; color:#7f1d1d;}
.fc-pill.info {background: var(--fc-info-suave); color:#1e3a8a;}

.fc-hero h1 {font-size: 2.1rem; margin: 0; line-height: 1.15;}
.fc-hero p {margin: 4px 0 0; color: var(--fc-texto-2); font-size: 1.05rem;}

/* ---------- Kiosko ---------- */
.fc-kiosk-title {text-align:center; font-size: 3.4rem; font-weight: 900; margin: 0; line-height: 1.1;
                 color: var(--fc-verde-borde);}
.fc-steps {display:flex; justify-content:center; gap:8px; flex-wrap:wrap; margin: 14px 0 18px;}
.fc-step {background:#fff; border:1px solid var(--fc-borde); border-radius:999px; padding:6px 14px;
          font-size:1rem; font-weight:700; color:#334155; white-space:nowrap; box-shadow: 0 2px 0 var(--fc-borde);}
.fc-step b {display:inline-grid; place-items:center; width:26px; height:26px; border-radius:50%;
            background: var(--fc-verde); color:#fff; margin-right:8px; font-size:.95rem;}
[data-testid="stCameraInput"] {background:#fff; border-radius: var(--fc-radio-card); box-shadow: var(--fc-sombra);}
[data-testid="stCameraInput"] button {font-size: 1.3rem !important; font-weight: 800 !important; padding: 14px !important;}

.fc-result {border-radius: 28px; padding: 34px 24px; text-align:center; color:#fff;
            animation: fc-pop .35s cubic-bezier(.2,1.4,.4,1); box-shadow: 0 16px 40px rgba(15,23,42,.18);}
.fc-result .emoji {font-size: 88px; line-height:1;}
.fc-result .titulo {font-size: 2.9rem; font-weight: 900; margin-top: 10px; line-height:1.1;}
.fc-result .sub {font-size: 1.45rem; margin-top: 8px; opacity:.95;}
@keyframes fc-pop {from {transform: scale(.85); opacity: 0;} to {transform: scale(1); opacity: 1;}}

/* ---------- Balón de carga ---------- */
.fc-cargando {display:flex; flex-direction:column; align-items:center; gap:10px; padding: 18px 0;}
.fc-cargando .txt {font-weight:800; color: var(--fc-texto-2);}
.fc-balon-wrap {position:relative; display:flex; flex-direction:column; align-items:center;}
.fc-balon {animation: fc-bote .55s cubic-bezier(.5,0,.5,1) infinite alternate;}
.fc-balon svg {display:block; animation: fc-giro 1.1s linear infinite;}
.fc-sombra {height: 8px; border-radius: 50%; background: rgba(15,23,42,.18); margin-top: 6px;
            animation: fc-sombra .55s cubic-bezier(.5,0,.5,1) infinite alternate;}
@keyframes fc-bote {from {transform: translateY(-26px);} to {transform: translateY(0);}}
@keyframes fc-giro {to {transform: rotate(360deg);}}
@keyframes fc-sombra {from {transform: scaleX(.55); opacity:.5;} to {transform: scaleX(1); opacity:1;}}

/* ---------- Celebración de gol ---------- */
.fc-gol {position: fixed; inset: 0; pointer-events: none; z-index: 9999; overflow: hidden;}
.fc-gol span {position: absolute; top: -60px; animation: fc-cae linear forwards;}
@keyframes fc-cae {0% {transform: translateY(0) rotate(0);} 100% {transform: translateY(115vh) rotate(720deg);}}
.fc-gol .grito {position:absolute; top: 18%; left: 50%; transform: translateX(-50%); font-size: 5.5rem;
                font-weight: 900; color: #fff; -webkit-text-stroke: 3px var(--fc-verde-borde);
                text-shadow: 0 6px 0 var(--fc-verde-borde); animation: fc-grito 1.6s ease-out forwards;}
@keyframes fc-grito {0% {transform: translateX(-50%) scale(.3); opacity:0;} 25% {transform: translateX(-50%) scale(1.15); opacity:1;}
                     70% {opacity:1;} 100% {transform: translateX(-50%) scale(1); opacity:0;}}

/* ---------- Stepper (NHS: un paso por pantalla) ---------- */
.fc-stepper {display:flex; align-items:center; gap:10px; margin: 6px 0 22px;}
.fc-stepper .s {display:flex; align-items:center; gap:8px; font-weight:800; color:#94a3b8;}
.fc-stepper .n {display:grid; place-items:center; width:34px; height:34px; border-radius:50%;
                background: var(--fc-borde); color:#64748b; font-weight:900;}
.fc-stepper .s.activo {color: var(--fc-texto);} .fc-stepper .s.activo .n {background: var(--fc-verde); color:#fff;
                box-shadow: 0 0 0 5px var(--fc-verde-suave);}
.fc-stepper .s.hecho .n {background:#bbf7d0; color:#14532d;}
.fc-stepper .linea {flex:1; height:3px; border-radius:3px; background: var(--fc-borde);}
.fc-stepper .linea.hecho {background:#86efac;}

.fc-avatar {display:inline-grid; place-items:center; border-radius:50%; color:#fff; font-weight:900;}
.fc-tip {display:flex; gap:12px; align-items:flex-start; padding: 8px 0;}
.fc-tip .i {font-size: 1.5rem; line-height: 1.2;}
.fc-tip b {display:block;} .fc-tip span {color: var(--fc-texto-2); font-size:.93rem;}
.fc-empty {text-align:center; padding: 40px 20px;}
.fc-empty .e {font-size: 64px;}
</style>
"""

# Fondo de cancha (solo kiosko): franjas de césped cortado + línea central y círculo, muy suaves.
CSS_CANCHA = """
<style>
[data-testid="stApp"] {
  background:
    radial-gradient(circle at 50% 55%, transparent 139px, rgba(255,255,255,.95) 140px 144px, transparent 145px),
    linear-gradient(to bottom, transparent calc(55% - 2px), rgba(255,255,255,.95) calc(55% - 2px) calc(55% + 2px), transparent calc(55% + 2px)),
    repeating-linear-gradient(90deg, #e9f7ef 0 90px, #e0f3e8 90px 180px) !important;
}
</style>
"""


def inject_css() -> None:
    st.markdown(CSS, unsafe_allow_html=True)


# ---------------------------------------------------------------- componentes

def esc(texto) -> str:
    return html.escape(str(texto))


def pill(texto: str, tipo: str = "") -> str:
    return f'<span class="fc-pill {tipo}">{esc(texto)}</span>'


def avatar(nombre: str, size: int = 44) -> str:
    partes = [p for p in nombre.split() if p]
    iniciales = "".join(p[0] for p in partes[:2]).upper() or "?"
    color = _AVATAR_COLORES[int(hashlib.md5(nombre.encode()).hexdigest(), 16) % len(_AVATAR_COLORES)]
    return (f'<span class="fc-avatar" style="width:{size}px;height:{size}px;background:{color};'
            f'font-size:{size * 0.4:.0f}px">{esc(iniciales)}</span>')


def resultado(emoji: str, titulo: str, subtitulo: str, color: str) -> None:
    st.markdown(
        f'<div class="fc-result" style="background:linear-gradient(135deg,{color},{color}dd)">'
        f'<div class="emoji">{emoji}</div><div class="titulo">{esc(titulo)}</div>'
        f'<div class="sub">{esc(subtitulo)}</div></div>',
        unsafe_allow_html=True,
    )


def empty_state(emoji: str, titulo: str, texto: str) -> None:
    st.markdown(
        f'<div class="fc-card fc-empty"><div class="e">{emoji}</div>'
        f'<h3 style="margin:.3rem 0">{esc(titulo)}</h3><p class="fc-muted">{esc(texto)}</p></div>',
        unsafe_allow_html=True,
    )


def fondo_cancha() -> None:
    st.markdown(CSS_CANCHA, unsafe_allow_html=True)


def balon_svg(size: int = 56) -> str:
    """Balón de fútbol en SVG (pentágono central + parches recortados por el borde)."""
    return f"""<svg width="{size}" height="{size}" viewBox="0 0 64 64" aria-hidden="true">
<defs><clipPath id="fc-c"><circle cx="32" cy="32" r="29"/></clipPath></defs>
<circle cx="32" cy="32" r="29" fill="#fff"/>
<g clip-path="url(#fc-c)" fill="#0f172a">
<polygon points="32,21 42.5,28.6 38.5,41 25.5,41 21.5,28.6"/>
<polygon points="32,-6 44,2 40,12 24,12 20,2"/><polygon points="66,20 70,33 60,40 52,31 57,20"/>
<polygon points="52,62 44,72 32,70 36,56 48,52"/><polygon points="12,62 20,72 32,70 28,56 16,52"/>
<polygon points="-2,20 -6,33 4,40 12,31 7,20"/></g>
<g stroke="#0f172a" stroke-width="2.2" fill="none" clip-path="url(#fc-c)">
<path d="M32 21 32 12M42.5 28.6 52 31M38.5 41 44 52M25.5 41 20 52M21.5 28.6 12 31"/></g>
<circle cx="32" cy="32" r="29" fill="none" stroke="#0f172a" stroke-width="3"/></svg>"""


def balon_html(texto: str = "", size: int = 56) -> str:
    return (f'<div class="fc-cargando"><div class="fc-balon-wrap"><div class="fc-balon">{balon_svg(size)}</div>'
            f'<div class="fc-sombra" style="width:{size * 0.8:.0f}px"></div></div>'
            + (f'<div class="txt">{esc(texto)}</div>' if texto else "") + "</div>")


@contextmanager
def cargando(texto: str = "Cargando…", size: int = 56):
    """Reemplazo de st.spinner con un balón que rebota mientras se ejecuta el bloque."""
    marcador = st.empty()
    marcador.markdown(balon_html(texto, size), unsafe_allow_html=True)
    try:
        yield
    finally:
        marcador.empty()


def celebrar(grito: str = "¡GOOOL!") -> None:
    """Lluvia de balones + grito de gol (reemplaza a st.balloons)."""
    rnd = random.Random()
    # El mismo balón SVG de la carga (el emoji ⚽ cambia de aspecto según el sistema operativo).
    balones = "".join(
        f'<span style="left:{rnd.uniform(2, 95):.1f}%;'
        f'animation-duration:{rnd.uniform(1.8, 3.0):.2f}s;animation-delay:{rnd.uniform(0, .8):.2f}s">'
        f'{balon_svg(int(rnd.uniform(30, 58)))}</span>'
        for _ in range(18)
    )
    st.markdown(f'<div class="fc-gol">{balones}<div class="grito">{esc(grito)}</div></div>',
                unsafe_allow_html=True)


@contextmanager
def peligro(clave: str):
    """Contenedor cuyos botones se pintan en rojo (acciones destructivas)."""
    with st.container(key=f"peligro_{clave}"):
        yield


def estado_servidor():
    """Retorna (ok, health) y lo cachea por ejecución de la página."""
    return call_api("GET", "/health")


def header(titulo: str, subtitulo: str = "", mostrar_estado: bool = True) -> None:
    """Título de página + estado del servidor + ajustes rápidos."""
    izq, der = st.columns([3, 2], vertical_alignment="center")
    with izq:
        st.markdown(f'<div class="fc-hero"><h1>{esc(titulo)}</h1>'
                    + (f"<p>{esc(subtitulo)}</p>" if subtitulo else "") + "</div>",
                    unsafe_allow_html=True)
    with der:
        c1, c2 = st.columns([3, 1], vertical_alignment="center")
        if mostrar_estado:
            ok, h = estado_servidor()
            if ok:
                txt = f"● Conectado · {h['jugadores']} inscritos"
                aviso = ""
                if st.session_state.staff_ok and h.get("pendientes"):
                    aviso = pill(f"● {h['pendientes']} por revisar", "warn") + " "
                c1.markdown(f'<div style="text-align:right">{aviso}{pill(txt, "ok")}</div>',
                            unsafe_allow_html=True)
            else:
                c1.markdown(f'<div style="text-align:right">{pill("● Servidor apagado", "err")}</div>',
                            unsafe_allow_html=True)
        with c2.popover("", icon=":material/tune:", help="Ajustes rápidos"):
            st.toggle(":material/photo_camera: Cámara encendida", value=st.session_state.cfg_camara, key="w_camara",
                      on_change=_sync, args=("w_camara", "cfg_camara"),
                      help="Apágala para liberar la webcam sin cerrar la app.")
            st.toggle(":material/record_voice_over: Voz del kiosko", value=st.session_state.cfg_voz, key="w_voz",
                      on_change=_sync, args=("w_voz", "cfg_voz"),
                      help="El kiosko saluda en voz alta: «¡Hola, Mateo! ¡A jugar!».")
            st.toggle(":material/science: Modo prueba", value=st.session_state.cfg_prueba, key="w_prueba",
                      on_change=_sync, args=("w_prueba", "cfg_prueba"),
                      help="Muestra el puntaje de parecido y desactiva el reinicio automático del kiosko.")
            if st.session_state.staff_ok and st.button("Cerrar sesión staff", icon=":material/logout:",
                                                       width="stretch"):
                st.session_state.staff_ok = False
                st.rerun()


def login_form() -> bool:
    """Tarjeta de ingreso con PIN. Retorna True si el PIN es correcto."""
    _, centro, _ = st.columns([1, 1.3, 1])
    with centro:
        st.markdown(
            '<div class="fc-card" style="text-align:center;margin-top:40px">'
            f'<div style="display:flex;justify-content:center">{balon_svg(64)}</div>'
            '<h2 style="margin:.2rem 0">Panel del staff</h2>'
            '<p class="fc-muted">Inscribe jugadores, revisa la asistencia y ajusta el sistema.</p>'
            "</div>",
            unsafe_allow_html=True,
        )
        with st.form("login", border=False):
            pin = st.text_input("PIN", type="password", placeholder="Ingresa el PIN del staff")
            entrar = st.form_submit_button("Entrar", type="primary", width="stretch")
        if entrar:
            if pin == STAFF_PIN:
                st.session_state.staff_ok = True
                return True
            st.error("PIN incorrecto. Inténtalo de nuevo.")
    return False


def requerir_staff() -> None:
    """Protege una página del staff: si no hay sesión, pide el PIN y se queda en la misma página."""
    if st.session_state.staff_ok:
        return
    if login_form():
        st.rerun()
    st.stop()


def stepper(pasos: list[str], actual: int) -> None:
    partes = []
    for i, nombre in enumerate(pasos, 1):
        clase = "activo" if i == actual else ("hecho" if i < actual else "")
        num = "✓" if i < actual else str(i)
        if i > 1:
            partes.append(f'<div class="linea {"hecho" if i <= actual else ""}"></div>')
        partes.append(f'<div class="s {clase}"><div class="n">{num}</div>{esc(nombre)}</div>')
    st.markdown(f'<div class="fc-stepper">{"".join(partes)}</div>', unsafe_allow_html=True)


def tip(icono: str, titulo: str, texto: str) -> str:
    return (f'<div class="fc-tip"><div class="i">{icono}</div>'
            f'<div><b>{esc(titulo)}</b><span>{esc(texto)}</span></div></div>')
