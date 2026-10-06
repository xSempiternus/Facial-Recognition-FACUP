"""Utilidades compartidas por las páginas: cliente de la API, estado, estilos y componentes."""

import datetime as dt
import hashlib
import html
import json
import os
import random
from contextlib import contextmanager
from pathlib import Path

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

# Paleta FA CUP: morado de la marca + dorado de acento. Tonos de estado del kiosko (sobre fondo oscuro).
MORADO, MORADO_2, LAVANDA, DORADO = "#33173C", "#4B1F5C", "#705f7c", "#F5B400"
EXITO, AZUL, NARANJA, ROJO, GRIS = DORADO, "#7C6CFF", "#F08A24", "#E5484D", "#8B7F94"
_TEXTO_SOBRE = {DORADO: "#2a1030", NARANJA: "#2a1030"}  # tonos claros: texto oscuro en la etiqueta
_AVATAR_COLORES = ["#4B1F5C", "#7C3AED", "#B45309", "#BE185D", "#0E7490", "#6D28D9", "#9A3412"]


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


_DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
_MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]


def fecha_larga(fecha: dt.date | None = None) -> str:
    """'martes 6 oct' (sin depender del locale de Windows)."""
    fecha = fecha or dt.date.today()
    return f"{_DIAS[fecha.weekday()]} {fecha.day} {_MESES[fecha.month - 1]}"


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

# Sistema visual FA CUP Chile: morado de la marca (facupchile.cl) + dorado como acento, títulos en PlutoSans
# mayúscula. Staff en modo claro (cabecera morada, tarjetas blancas, botones planos); kiosko en modo noche
# con estética de app de reconocimiento facial. Referencia visual en la página "Guía de estilo".
CSS = """
<style>
:root {
  --fc-morado: #33173C;        /* marca: logo y títulos */
  --fc-morado-2: #4B1F5C;      /* botones principales (texto blanco 11:1) */
  --fc-morado-3: #705f7c;      /* lavanda: secundario, viñeta */
  --fc-morado-suave: #f1eaf4;  /* fondos de etiquetas y selección */
  --fc-morado-noche: #160818;
  --fc-dorado: #F5B400;        /* acento: brillo, celebración, foco */
  --fc-dorado-claro: #FFD66B;
  --fc-dorado-texto: #2a1030;  /* texto sobre dorado */
  --fc-degradado: linear-gradient(135deg, #FFD66B 0%, #F5B400 55%, #E89B00 100%);
  --fc-display: PlutoSansCond, 'Arial Narrow', sans-serif;
  --fc-texto: #1D1D1B;
  --fc-texto-2: #5f5568;
  --fc-borde: #ece6f0;
  --fc-borde-fuerte: #d9cfe0;
  --fc-superficie: #ffffff;
  --fc-fondo: #f6f3f8;
  --fc-peligro: #c62f3b; --fc-peligro-suave: #fde8ea;
  --fc-atencion: #b45309; --fc-atencion-suave: #fef3c7;
  --fc-info: #4f46e5; --fc-info-suave: #e8e7fd;
  --fc-radio: 12px; --fc-radio-card: 20px;
  --fc-sombra: 0 1px 2px rgba(51,23,60,.04), 0 8px 24px -8px rgba(51,23,60,.12);
  --fc-sombra-alta: 0 24px 48px -18px rgba(51,23,60,.30);
}

footer {display: none !important;}
[data-testid="stMainMenu"], [data-testid="stAppDeployButton"], [data-testid="stStatusWidget"] {display: none !important;}
[data-testid="stApp"] {background:
  radial-gradient(900px 300px at 85% -80px, rgba(245,180,0,.10), transparent 70%),
  radial-gradient(800px 320px at 0% -120px, rgba(75,31,92,.10), transparent 70%), var(--fc-fondo);}
.block-container {padding-top: 5.2rem; padding-bottom: 4rem; max-width: 1180px;}
h1, h2, h3, h4 {color: var(--fc-morado); letter-spacing: .005em;}
h1, h2 {text-transform: uppercase;}

/* ---------- Cabecera morada con logo y navegación ---------- */
[data-testid="stHeader"] {background: linear-gradient(90deg, var(--fc-morado-noche), var(--fc-morado) 45%, var(--fc-morado-2)) !important;
  box-shadow: 0 8px 30px -12px rgba(22,8,24,.6); height: 4rem;}
[data-testid="stHeader"]::after {content:""; position:absolute; left:0; right:0; bottom:0; height:3px; background: var(--fc-degradado);}
[data-testid="stHeader"] a, [data-testid="stHeader"] span, [data-testid="stHeader"] p,
[data-testid="stHeader"] button {color: rgba(255,255,255,.82) !important;}
[data-testid="stHeader"] [data-testid="stLogo"] {height: 2.3rem; max-width: 14rem;}
[data-testid="stHeader"] a[aria-current="page"], [data-testid="stHeader"] a:hover {background: rgba(255,255,255,.12) !important;
  color: #fff !important;}

/* ---------- Botones: planos, con jerarquía clara ---------- */
[data-testid="stBaseButton-primary"], [data-testid="stBaseButton-primaryFormSubmit"] {
  background: var(--fc-morado-2) !important; border: 0 !important; color: #fff !important; font-weight: 800 !important;
  border-radius: 12px !important; box-shadow: 0 8px 18px -8px rgba(75,31,92,.7) !important;
  transition: transform .12s ease, box-shadow .12s ease, background .15s ease;}
[data-testid="stBaseButton-primary"]:hover, [data-testid="stBaseButton-primaryFormSubmit"]:hover {
  background: var(--fc-morado) !important; transform: translateY(-1px); box-shadow: 0 12px 22px -10px rgba(51,23,60,.8) !important;}
[data-testid="stBaseButton-primary"]:active, [data-testid="stBaseButton-primaryFormSubmit"]:active {transform: translateY(1px);}
[data-testid="stBaseButton-secondary"], [data-testid="stBaseButton-secondaryFormSubmit"] {
  background: var(--fc-superficie) !important; border: 1px solid var(--fc-borde-fuerte) !important;
  color: var(--fc-morado) !important; font-weight: 700 !important; border-radius: 12px !important;
  box-shadow: 0 1px 2px rgba(51,23,60,.06) !important; transition: border-color .15s ease, background .15s ease;}
[data-testid="stBaseButton-secondary"]:hover {border-color: var(--fc-morado-3) !important; background: #fcfafd !important;}
[data-testid="stBaseButton-tertiary"] {color: var(--fc-morado-2) !important; font-weight: 800 !important;}
button:disabled, button[disabled] {opacity: .45 !important; box-shadow: none !important; transform: none !important;}

/* Variante peligro: envolver el botón en st.container(key="peligro_...") */
[class*="st-key-peligro"] [data-testid^="stBaseButton"] {
  background: var(--fc-peligro) !important; color: #fff !important; border: 0 !important;
  box-shadow: 0 8px 18px -8px rgba(198,47,59,.7) !important;}
[class*="st-key-peligro"] [data-testid^="stBaseButton"]:hover {background: #a52632 !important;}

/* Foco de teclado: anillo dorado de la marca, bien visible */
button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible, [role="tab"]:focus-visible {
  outline: 3px solid var(--fc-dorado) !important; outline-offset: 2px !important;}

/* ---------- Formularios ---------- */
[data-baseweb="input"], [data-baseweb="select"] > div, [data-baseweb="textarea"] {border-radius: 12px !important;
  background: #fff !important;}
[data-baseweb="input"]:focus-within, [data-baseweb="select"] > div:focus-within, [data-baseweb="textarea"]:focus-within {
  border-color: var(--fc-morado-2) !important; box-shadow: 0 0 0 4px rgba(75,31,92,.12) !important;}

/* ---------- Tarjetas (st.container(border=True)) ---------- */
[data-testid="stVerticalBlockBorderWrapper"]:has(> div > [data-testid="stVerticalBlock"]) {
  background: var(--fc-superficie); border: 1px solid var(--fc-borde) !important;
  border-radius: var(--fc-radio-card) !important; box-shadow: var(--fc-sombra);}
.fc-card {background: var(--fc-superficie); border: 1px solid var(--fc-borde); border-radius: var(--fc-radio-card);
          padding: 22px 24px; box-shadow: var(--fc-sombra);}
.fc-muted {color: var(--fc-texto-2);}

/* ---------- Avisos: barra lateral de color ---------- */
[data-testid="stAlertContainer"] {border-radius: var(--fc-radio) !important; border-left: 5px solid !important;}
[data-testid="stAlertContainer"]:has([data-testid="stAlertContentWarning"]) {border-left-color: var(--fc-atencion) !important;}
[data-testid="stAlertContainer"]:has([data-testid="stAlertContentError"]) {border-left-color: var(--fc-peligro) !important;}
[data-testid="stAlertContainer"]:has([data-testid="stAlertContentSuccess"]) {border-left-color: var(--fc-morado-2) !important;}
[data-testid="stAlertContainer"]:has([data-testid="stAlertContentInfo"]) {border-left-color: var(--fc-info) !important;}

/* Etiquetas de estado: tono = significado, nunca decoración */
.fc-pill {display:inline-flex; align-items:center; gap:6px; padding: 4px 12px; border-radius: 999px;
          font-size: .82rem; font-weight: 800; background:#f2eff4; color:#4a4152; white-space:nowrap;}
.fc-pill.ok {background: var(--fc-morado-suave); color: var(--fc-morado-2);}
.fc-pill.warn {background: var(--fc-atencion-suave); color:#78350f;}
.fc-pill.err {background: var(--fc-peligro-suave); color:#8a1c26;}
.fc-pill.info {background: var(--fc-info-suave); color:#3730a3;}

/* ---------- Encabezado de página ---------- */
.fc-hero .ojo {font-family: var(--fc-display); font-weight:700; letter-spacing:.22em; text-transform:uppercase;
               font-size:.8rem; color: var(--fc-morado-3);}
.fc-hero h1 {font-family: var(--fc-display); font-size: 2.6rem; margin: 2px 0 0; line-height: 1;}
/* Viñeta degradada bajo el título (como en facupchile.cl) */
.fc-hero h1::after {content: ""; display: block; width: 72px; height: 4px; margin-top: 10px; border-radius: 4px;
                    background: var(--fc-degradado);}
.fc-hero p {margin: 10px 0 0; color: var(--fc-texto-2); font-size: 1.05rem;}

/* ---------- Balón de carga ---------- */
.fc-cargando {display:flex; flex-direction:column; align-items:center; gap:10px; padding: 18px 0;}
.fc-cargando .txt {font-weight:800; color: var(--fc-texto-2);}
.fc-balon-wrap {position:relative; display:flex; flex-direction:column; align-items:center;}
.fc-balon {animation: fc-bote .55s cubic-bezier(.5,0,.5,1) infinite alternate;}
.fc-balon svg {display:block; animation: fc-giro 1.1s linear infinite;}
.fc-sombra {height: 8px; border-radius: 50%; background: rgba(51,23,60,.18); margin-top: 6px;
            animation: fc-sombra .55s cubic-bezier(.5,0,.5,1) infinite alternate;}
@keyframes fc-bote {from {transform: translateY(-26px);} to {transform: translateY(0);}}
@keyframes fc-giro {to {transform: rotate(360deg);}}
@keyframes fc-sombra {from {transform: scaleX(.55); opacity:.5;} to {transform: scaleX(1); opacity:1;}}
@keyframes fc-pop {from {transform: scale(.9); opacity: 0;} to {transform: scale(1); opacity: 1;}}

/* ---------- Celebración de gol ---------- */
.fc-gol {position: fixed; inset: 0; pointer-events: none; z-index: 9999; overflow: hidden;}
.fc-gol span {position: absolute; top: -60px; animation: fc-cae linear forwards;}
@keyframes fc-cae {0% {transform: translateY(0) rotate(0);} 100% {transform: translateY(115vh) rotate(720deg);}}
.fc-gol .grito {position:absolute; top: 18%; left: 50%; transform: translateX(-50%); font-size: 6rem;
                font-family: var(--fc-display); font-weight: 700; color: var(--fc-dorado-claro);
                -webkit-text-stroke: 3px var(--fc-morado); text-shadow: 0 6px 0 var(--fc-morado), 0 0 40px rgba(245,180,0,.6);
                animation: fc-grito 1.6s ease-out forwards;}
@keyframes fc-grito {0% {transform: translateX(-50%) scale(.3); opacity:0;} 25% {transform: translateX(-50%) scale(1.15); opacity:1;}
                     70% {opacity:1;} 100% {transform: translateX(-50%) scale(1); opacity:0;}}

/* ---------- Stepper (un paso por pantalla) ---------- */
.fc-stepper {display:flex; align-items:center; gap:10px; margin: 8px 0 24px;}
.fc-stepper .s {display:flex; align-items:center; gap:8px; font-weight:800; color:#a397ab;}
.fc-stepper .n {display:grid; place-items:center; width:34px; height:34px; border-radius:50%;
                background: var(--fc-borde); color:#8a7d93; font-weight:900;}
.fc-stepper .s.activo {color: var(--fc-morado);}
.fc-stepper .s.activo .n {background: var(--fc-morado-2); color:#fff; box-shadow: 0 0 0 5px var(--fc-morado-suave);}
.fc-stepper .s.hecho .n {background: var(--fc-dorado); color: var(--fc-dorado-texto);}
.fc-stepper .linea {flex:1; height:3px; border-radius:3px; background: var(--fc-borde);}
.fc-stepper .linea.hecho {background: var(--fc-degradado);}

.fc-avatar {display:inline-grid; place-items:center; border-radius:50%; color:#fff; font-weight:900;
            box-shadow: 0 0 0 3px #fff, 0 4px 10px -2px rgba(51,23,60,.35);}
.fc-tip {display:flex; gap:12px; align-items:flex-start; padding: 8px 0;}
.fc-tip .i {font-size: 1.5rem; line-height: 1.2;}
.fc-tip b {display:block;} .fc-tip span {color: var(--fc-texto-2); font-size:.93rem;}
.fc-empty {text-align:center; padding: 40px 20px;}
.fc-empty .e {font-size: 64px;}

/* ---------- Mascota y tarjeta de resultado del kiosko (también en la Guía de estilo) ---------- */
.fc-mascota {display:flex; justify-content:flex-start; align-items:flex-end; min-height: 96px; margin-bottom: 6px;}
.fc-mascota img {max-height: 200px; width:auto; animation: fc-flota 3.2s ease-in-out infinite;
                 filter: drop-shadow(0 18px 30px rgba(0,0,0,.45));}
.fc-mascota.centro {justify-content:center;}
.fc-mascota .emoji {font-size: 96px; line-height:1; animation: fc-flota 3.2s ease-in-out infinite;
                    filter: drop-shadow(0 12px 22px rgba(0,0,0,.35));}
@keyframes fc-flota {50% {transform: translateY(-10px);}}

.fc-kres {position:relative; isolation:isolate; overflow:hidden; border-radius: 28px; padding: 26px 28px 30px; color:#fff;
  background: linear-gradient(160deg, rgba(255,255,255,.11), rgba(255,255,255,.03));
  border: 1.5px solid var(--tono);
  box-shadow: 0 0 70px -10px var(--tono), 0 30px 80px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.15);
  animation: fc-pop .35s cubic-bezier(.2,1.4,.4,1); backdrop-filter: blur(12px);}
.fc-kres::before {content:""; position:absolute; inset:0; z-index:-1; opacity:.45;
  background: radial-gradient(circle at 15% 0%, var(--tono), transparent 62%);}
.fc-kres .etiqueta {display:inline-flex; align-items:center; gap:8px; padding: 5px 12px; border-radius:999px;
  background: var(--tono); color: var(--tono-texto, #fff); font-weight:900; font-size:.8rem; letter-spacing:.14em;
  text-transform:uppercase;}
.fc-kres .titulo {font-family: var(--fc-display); font-weight:700; text-transform:uppercase;
  font-size: clamp(2.4rem, 4.6vw, 4rem); line-height:.95; margin-top: 12px;}
.fc-kres .sub {font-size: 1.3rem; margin-top: 10px; color: rgba(255,255,255,.85); font-weight:700;}

/* Vista previa del kiosko dentro del panel claro (Guía de estilo) */
.fc-kdemo {background: linear-gradient(160deg, var(--fc-morado), var(--fc-morado-noche)); padding: 14px;
           border-radius: 24px; height: 100%;}
.fc-kdemo .fc-kres {padding: 14px 16px 18px; border-radius: 20px;}
.fc-kdemo .fc-mascota {min-height: 0;} .fc-kdemo .fc-mascota .emoji {font-size: 46px;}
.fc-kdemo .fc-kres .etiqueta {font-size: .68rem;}
.fc-kdemo .fc-kres .titulo {font-size: 1.5rem;} .fc-kdemo .fc-kres .sub {font-size: .95rem;}
</style>
"""

# Kiosko: estética de app de reconocimiento facial (fondo nocturno, marco de escaneo con esquinas
# doradas, guía ovalada para la cara y línea que recorre la imagen) con la marca FA CUP.
CSS_KIOSKO = """
<style>
[data-testid="stApp"] {
  background:
    radial-gradient(700px 500px at 80% 30%, rgba(245,180,0,.13), transparent 60%),
    radial-gradient(700px 520px at 5% 100%, rgba(124,108,255,.16), transparent 60%),
    radial-gradient(circle at 50% 54%, transparent 259px, rgba(255,255,255,.045) 260px 262px, transparent 263px),
    linear-gradient(to right, transparent calc(50% - 1px), rgba(255,255,255,.045) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)),
    radial-gradient(rgba(255,255,255,.08) 1.1px, transparent 1.6px) 0 0 / 24px 24px,
    linear-gradient(155deg, #3a1a45 0%, var(--fc-morado) 35%, var(--fc-morado-noche) 85%) !important;
  color: #fff;}
[data-testid="stHeader"] {background: transparent !important; box-shadow: none !important;}
[data-testid="stHeader"]::after {display: none;}
.block-container {max-width: 1320px; padding-top: 4rem; padding-bottom: 1rem;}
.st-key-kiosko p, .st-key-kiosko label, .st-key-kiosko [data-testid="stMarkdownContainer"] {color: #fff;}

/* ---------- Barra de estado: en vivo · llegadas de hoy · fecha ---------- */
.fc-k-top {display:flex; align-items:center; justify-content:flex-end; gap:10px; flex-wrap:wrap;}
.fc-k-chip {display:inline-flex; align-items:center; gap:8px; padding: 7px 14px; border-radius:999px;
            background: rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.13); font-weight:800;
            font-size:.82rem; letter-spacing:.1em; text-transform:uppercase; color:#fff; backdrop-filter: blur(8px);}
.fc-k-chip b {color: var(--fc-dorado-claro); font-size: 1rem; letter-spacing: 0;}
.fc-k-chip i {width:9px; height:9px; border-radius:50%; background: #3ddc84;
              box-shadow: 0 0 0 0 rgba(61,220,132,.7); animation: fc-pulso 1.8s infinite;}
@keyframes fc-pulso {70% {box-shadow: 0 0 0 10px rgba(61,220,132,0);} 100% {box-shadow: 0 0 0 0 rgba(61,220,132,0);}}
.st-key-kiosko [data-testid="stPopover"] button {background: rgba(255,255,255,.07) !important;
            border:1px solid rgba(255,255,255,.16) !important; color:#fff !important; box-shadow:none !important;}

/* ---------- Saludo ---------- */
.fc-k-saludo {padding: 6px 4px;}
.fc-eyebrow {display:inline-flex; align-items:center; gap:10px; font-family: var(--fc-display); font-weight:700;
             letter-spacing:.3em; text-transform:uppercase; font-size: .95rem; color: var(--fc-dorado);}
.fc-eyebrow::before {content:""; width: 28px; height: 3px; border-radius: 3px; background: var(--fc-degradado);}
.fc-k-titulo {font-family: var(--fc-display); font-weight:700; text-transform:uppercase; color:#fff;
              font-size: clamp(3rem, 5.8vw, 5.2rem); line-height:.9; margin: 8px 0 12px; letter-spacing:.005em;}
.fc-k-titulo em {font-style:normal; background: var(--fc-degradado); -webkit-background-clip:text; background-clip:text;
                 color: transparent; filter: drop-shadow(0 0 26px rgba(245,180,0,.35));}
.fc-k-pasos {display:flex; flex-direction:column; gap:8px; margin-top: 4px; max-width: 520px;}
.fc-k-paso {display:flex; align-items:center; gap:14px; padding: 10px 14px; border-radius: 16px;
            background: linear-gradient(90deg, rgba(255,255,255,.08), rgba(255,255,255,.03));
            border:1px solid rgba(255,255,255,.09); font-size: 1.18rem; font-weight:800; color:#fff;}
.fc-k-paso b {display:grid; place-items:center; flex: 0 0 36px; height:36px; border-radius: 11px;
              background: var(--fc-degradado); color: var(--fc-dorado-texto); font-family: var(--fc-display);
              font-size:1.35rem; box-shadow: 0 6px 18px -4px rgba(245,180,0,.55);}
.fc-k-lema {margin-top: 12px; font-family: var(--fc-display); text-transform:uppercase; letter-spacing:.24em;
            color: rgba(255,255,255,.38); font-size:.9rem;}

/* ---------- Marco de escaneo sobre la cámara ---------- */
.st-key-k_cam {position: relative; padding: 14px; border-radius: 30px;
  background: linear-gradient(180deg, rgba(255,255,255,.09), rgba(255,255,255,.025));
  border: 1px solid rgba(255,214,107,.28);
  box-shadow: 0 40px 90px -20px rgba(0,0,0,.6), 0 0 80px -20px rgba(245,180,0,.35), inset 0 1px 0 rgba(255,255,255,.14);
  backdrop-filter: blur(12px);}
.st-key-k_cam [data-testid="stCameraInput"] {position: relative; background: transparent !important; box-shadow:none !important;}
.st-key-k_cam video, .st-key-k_cam img {border-radius: 20px !important;}
.st-key-k_cam [data-testid="stCameraInputWebcamComponent"] > div:not([data-testid]),
.st-key-k_cam [data-testid="stCameraInputWebcamStyledBox"] {background: rgba(8,2,10,.6) !important;
  border-radius: 20px; color: rgba(255,255,255,.7);}
.st-key-k_cam [data-testid="stCameraInputWebcamComponent"] a {color: var(--fc-dorado-claro) !important;}
/* Esquinas doradas (4 escuadras dibujadas con degradados) */
.st-key-k_cam::before {content:""; position:absolute; z-index:5; pointer-events:none;
  inset: 28px 28px 104px 28px;
  --c: var(--fc-dorado); --l: 56px; --w: 5px;
  background:
    linear-gradient(var(--c),var(--c)) top left / var(--l) var(--w),
    linear-gradient(var(--c),var(--c)) top left / var(--w) var(--l),
    linear-gradient(var(--c),var(--c)) top right / var(--l) var(--w),
    linear-gradient(var(--c),var(--c)) top right / var(--w) var(--l),
    linear-gradient(var(--c),var(--c)) bottom left / var(--l) var(--w),
    linear-gradient(var(--c),var(--c)) bottom left / var(--w) var(--l),
    linear-gradient(var(--c),var(--c)) bottom right / var(--l) var(--w),
    linear-gradient(var(--c),var(--c)) bottom right / var(--w) var(--l);
  background-repeat: no-repeat; filter: drop-shadow(0 0 8px rgba(245,180,0,.85));}
/* Guía ovalada: dónde poner la cara */
.st-key-k_cam [data-testid="stCameraInput"]::before {content:""; position:absolute; z-index:4; pointer-events:none;
  left: 50%; top: calc((100% - 90px) / 2); width: 38%; aspect-ratio: 3 / 4; transform: translate(-50%, -50%);
  border: 2px dashed rgba(255,255,255,.38); border-radius: 50%;
  box-shadow: 0 0 0 9999px rgba(8,2,10,.18);}
/* Línea de escaneo que sube y baja */
.st-key-k_cam::after {content:""; position:absolute; z-index:6; pointer-events:none; left: 10%; right: 10%; height: 2px;
  top: 40px; border-radius: 2px;
  background: linear-gradient(90deg, transparent, var(--fc-dorado), #fff, var(--fc-dorado), transparent);
  box-shadow: 0 0 20px 5px rgba(245,180,0,.45); animation: fc-escaneo 3s ease-in-out infinite alternate;}
@keyframes fc-escaneo {to {top: calc(100% - 120px);}}
.st-key-k_cam:has(img)::after {animation-duration: .7s;}
/* Botón de la cámara: grande, dorado y en español */
.st-key-k_cam [data-testid="stCameraInput"] button {
  background: var(--fc-degradado) !important; border: 0 !important; border-radius: 18px !important;
  min-height: 66px; margin-top: 14px; font-size: 0 !important; position: relative; overflow: hidden;
  box-shadow: 0 14px 30px -10px rgba(245,180,0,.7), inset 0 1px 0 rgba(255,255,255,.5) !important;}
.st-key-k_cam [data-testid="stCameraInput"] button:hover {filter: brightness(1.05);}
.st-key-k_cam [data-testid="stCameraInput"] button * {display:none;}
.st-key-k_cam [data-testid="stCameraInput"] button::after {content: "¡Escanéame!"; font-size: 1.75rem;
  font-family: var(--fc-display); font-weight:700; letter-spacing:.1em; text-transform:uppercase;
  color: var(--fc-dorado-texto);}
.st-key-k_cam [data-testid="stCameraInput"]:has(img) button::after {content: "Escaneando…";}
.st-key-k_cam [data-testid="stCameraInput"]:has(img)::before {display: none;}

.st-key-kiosko .fc-cargando .txt {color:#fff; font-family: var(--fc-display); text-transform:uppercase;
  letter-spacing:.24em; font-size: 1.3rem;}
.st-key-kiosko [data-testid="stProgress"] p {color: rgba(255,255,255,.75) !important; font-weight:800;}
.st-key-kiosko [data-testid="stProgress"] > div > div > div {background: rgba(255,255,255,.12) !important;}
.st-key-kiosko [data-testid="stProgress"] > div > div > div > div {background: var(--fc-degradado) !important;}
</style>
"""

STATIC_DIR = Path(__file__).resolve().parent / "static"
MASCOTA_DIR = STATIC_DIR / "mascota"
_MASCOTA_EXT = ("webp", "png", "gif", "svg")


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


def estilo_kiosko() -> None:
    st.markdown(CSS_KIOSKO, unsafe_allow_html=True)


def mascota(estado: str, respaldo: str, centro: bool = False) -> str:
    """
    Imagen de la mascota FA CUP para un estado del kiosko (bienvenida, celebra, de_nuevo, no_veo,
    foto_falsa, no_reconoce, error). Usa ui/static/mascota/<estado>.(webp|png|gif|svg) si existe;
    si no, muestra `respaldo` (HTML: emoji o balón) para que el kiosko funcione sin la mascota.
    """
    clase = "fc-mascota centro" if centro else "fc-mascota"
    for ext in _MASCOTA_EXT:
        if (MASCOTA_DIR / f"{estado}.{ext}").is_file():
            return f'<div class="{clase}"><img src="app/static/mascota/{estado}.{ext}" alt=""></div>'
    return f'<div class="{clase}">{respaldo}</div>'


def resultado_kiosko(estado: str, emoji: str, etiqueta: str, titulo: str, subtitulo: str, color: str) -> str:
    """Tarjeta de resultado del kiosko: mascota (o emoji) + etiqueta + título grande."""
    texto = _TEXTO_SOBRE.get(color, "#fff")
    return (f'<div class="fc-kres" style="--tono:{color};--tono-texto:{texto}">'
            f'{mascota(estado, f"<div class=emoji>{emoji}</div>")}'
            f'<span class="etiqueta">{esc(etiqueta)}</span>'
            f'<div class="titulo">{esc(titulo)}</div><div class="sub">{esc(subtitulo)}</div></div>')


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
        st.markdown(f'<div class="fc-hero"><div class="ojo">Panel staff · FA CUP Chile</div><h1>{esc(titulo)}</h1>'
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
