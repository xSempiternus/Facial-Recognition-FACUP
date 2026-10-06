"""Evaluación de modelos: ejecutar el benchmark, entender resultados y aplicar la mejor configuración."""

import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import altair as alt
import pandas as pd
import streamlit as st

import core

core.requerir_staff()

ROOT = Path(__file__).resolve().parents[2]
FOTOS = ROOT / "eval" / "fotos"
RESULTADOS = ROOT / "eval" / "resultados"
SCRIPT = ROOT / "scripts" / "evaluar_modelos.py"
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

core.header("Evaluación de modelos", "Prueba qué modelo reconoce mejor a tus jugadores, con tus propias fotos.")


def leer_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def etiqueta(c: dict) -> str:
    return f"{c['modelo']} + {c['detector']} · {c['fotos_inscripcion']} foto(s)"


# ------------------------------------------------------------------ dataset + ejecución
personas = {}
if FOTOS.is_dir():
    for d in sorted(p for p in FOTOS.iterdir() if p.is_dir()):
        n = sum(1 for f in d.iterdir() if f.suffix.lower() in EXTS)
        if n:
            personas[d.name] = n

estado = leer_json(RESULTADOS / "estado.json") or {}
en_curso = estado.get("estado") == "en_curso"
if en_curso:
    # Si no se actualiza hace más de 1 hora, se asume que el proceso murió.
    try:
        en_curso = (datetime.now() - datetime.fromisoformat(estado["actualizado"])).total_seconds() < 3600
    except (KeyError, ValueError):
        en_curso = False

with st.container(border=True):
    izq, der = st.columns([2, 1], gap="large", vertical_alignment="center")
    with izq:
        st.markdown("#### :material/folder_open: Tus fotos de prueba")
        if personas:
            total = sum(personas.values())
            chips = " ".join(core.pill(f"{p} · {n}", "ok" if n >= 3 else "warn") for p, n in personas.items())
            st.markdown(f"**{len(personas)} personas, {total} fotos** en `eval/fotos/`<br>{chips}",
                        unsafe_allow_html=True)
            if any(n < 3 for n in personas.values()):
                st.caption("🟠 Las personas con menos de 3 fotos aportan poco: idealmente 4–5 por persona.")
        else:
            st.markdown(
                "Aún no hay fotos. Crea una carpeta por persona dentro de "
                f"`{FOTOS.relative_to(ROOT)}` con 3–5 fotos distintas cada una:"
            )
            st.code("eval/fotos/sofia/1.jpg\neval/fotos/sofia/2.jpg\neval/fotos/mateo/1.jpg\n...",
                    language=None)
            FOTOS.mkdir(parents=True, exist_ok=True)
    with der:
        aumentar = st.toggle("Incluir condiciones difíciles", value=True,
                             help="Agrega versiones oscuras, borrosas, inclinadas, etc. Más lento pero más realista.")
        lanzar = st.button("Ejecutar evaluación", type="primary", width="stretch", icon=":material/play_arrow:",
                           disabled=en_curso or len(personas) < 2)
        st.caption("Tarda de 2 a 15 minutos según la cantidad de fotos.")

if lanzar:
    RESULTADOS.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-u", str(SCRIPT), "--fotos", str(FOTOS)] + (["--aumentar"] if aumentar else [])
    env = {**os.environ, "PYTHONUTF8": "1", "TF_CPP_MIN_LOG_LEVEL": "3"}
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    with open(RESULTADOS / "log.txt", "w", encoding="utf-8") as log:
        subprocess.Popen(cmd, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, env=env, creationflags=flags)
    (RESULTADOS / "estado.json").write_text(
        json.dumps({"estado": "en_curso", "actualizado": datetime.now().isoformat(timespec="seconds")}),
        encoding="utf-8")
    st.rerun()


@st.fragment(run_every=3)
def progreso():
    est = leer_json(RESULTADOS / "estado.json") or {}
    if est.get("estado") != "en_curso":
        st.rerun()  # terminó: recarga toda la página para mostrar resultados
    try:
        lineas = (RESULTADOS / "log.txt").read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        lineas = []
    utiles = [l for l in lineas if l.strip().startswith(("▶", "Dataset", "Facenet", "ArcFace", "SFace",
                                                          "GhostFaceNet", "VGG", "✗", "("))
              or " ms/foto" in l]
    with st.status("Evaluando modelos… puedes seguir usando la app", expanded=True, state="running"):
        st.code("\n".join(utiles[-12:]) or "Preparando…", language=None)


if en_curso:
    progreso()
    st.stop()

if estado.get("estado") == "error":
    st.error(f"La última evaluación falló: {estado.get('mensaje', 'error desconocido')}")

# ------------------------------------------------------------------ resultados
res = leer_json(RESULTADOS / "resultados.json")
if not res:
    core.empty_state("🧪", "Sin resultados todavía",
                     "Agrega fotos y ejecuta la evaluación para ver qué modelo conviene.")
    st.stop()

configs = res["configs"]
ds = res["dataset"]
es_demo = Path(ds["carpeta"]).resolve() != FOTOS.resolve()
st.caption(f"Resultados del {res['generado'][:16].replace('T', ' ')} · {ds['personas']} personas · "
           f"{ds['fotos']} fotos" + (" · con condiciones difíciles" if ds.get("aumentado") else "")
           + (" · ⚠️ set de demostración (adultos), no son tus fotos" if es_demo else ""))

# La app inscribe con 3 fotos por niño: se recomienda la mejor configuración evaluada con 3 fotos.
k3 = [c for c in configs if c["fotos_inscripcion"] == 3] or configs
mejor = k3[0]
ok_cfg, actual = core.call_api("GET", "/config")

@st.dialog("¿Aplicar configuración?")
def confirmar(cfg: dict):
    st.write(f"Se usará **{cfg['modelo']}** + detector **{cfg['detector']}**, umbral **{cfg['umbral']:.2f}**.")
    if ok_cfg and cfg["modelo"] != actual["modelo"]:
        ok_j, js = core.call_api("GET", "/jugadores")
        if ok_j and js:
            st.warning(f"⚠️ Cambia el modelo: los **{len(js)} jugador(es)** inscritos necesitarán fotos "
                       "nuevas (Jugadores → 📸 Agregar foto) para ser reconocidos. Su historial se conserva.")
    c1, c2 = st.columns(2)
    if c1.button("Aplicar", type="primary", width="stretch"):
        with core.cargando("Cargando el modelo…"):
            ok, r = core.call_api("PUT", "/config", json=cfg)
        if ok:
            st.toast("Configuración aplicada", icon="✅")
            st.rerun()
        else:
            st.error(r.get("mensaje"))
    if c2.button("Cancelar", width="stretch"):
        st.rerun()


with st.container(border=True):
    st.markdown(
        f"### 🏆 Recomendado: {mejor['modelo']} + detector {mejor['detector']}"
        f"<br><span class='fc-muted' style='font-size:1rem'>con umbral {mejor['umbral_recomendado']:.2f}</span>",
        unsafe_allow_html=True,
    )
    m1, m2, m3, m4 = st.columns(4)
    m1.metric("Reconocidos al 1er intento", f"{mejor['acierto']:.0%}", border=True)
    m2.metric("Confusiones", f"{mejor['confusion']:.0%}", border=True,
              help="Niños registrados como si fueran otro. Debe ser 0%.")
    m3.metric("Deben repetir la foto", f"{mejor['rechazo']:.0%}", border=True)
    m4.metric("Tiempo por foto", f"{mejor['ms_deteccion'] + mejor['ms_embedding']:.0f} ms", border=True)

    n100 = lambda x: round(x * 100)  # noqa: E731
    st.markdown(
        f"**En palabras simples:** de cada 100 llegadas, **{n100(mejor['acierto'])}** se reconocerían a la "
        f"primera, **{n100(mejor['rechazo'])}** tendrían que repetir la foto y "
        f"**{n100(mejor['confusion'])}** quedarían anotadas como otro niño."
    )
    uno = next((c for c in configs if c["fotos_inscripcion"] == 1 and c["modelo"] == mejor["modelo"]
                and c["detector"] == mejor["detector"]), None)
    if uno and mejor["fotos_inscripcion"] == 3 and mejor["acierto"] > uno["acierto"]:
        st.caption(f"📸 Con estas cifras se asume la inscripción con 3 fotos (la de la app). "
                   f"Con 1 sola foto serían {uno['acierto']:.0%} reconocidos.")

    if ok_cfg:
        misma = (actual["modelo"], actual["detector"]) == (mejor["modelo"], mejor["detector"]) \
            and abs(actual["umbral"] - mejor["umbral_recomendado"]) < 0.005
        st.caption(f"Configuración actual: {actual['modelo']} + {actual['detector']}, umbral {actual['umbral']:.2f}")
        if misma:
            st.success("✅ Ya estás usando esta configuración.")
        elif st.button("Aplicar esta configuración", type="primary", icon=":material/check:"):
            confirmar({"modelo": mejor["modelo"], "detector": mejor["detector"],
                       "umbral": mejor["umbral_recomendado"]})


# ------------------------------------------------------------------ detalle
opciones = {etiqueta(c): c for c in configs}
elegida = opciones[st.selectbox("Configuración a analizar", list(opciones), index=list(opciones).index(etiqueta(mejor)))] \
    if len(opciones) > 1 else mejor

t1, t2, t3, t4 = st.tabs(["📊 Ranking", "🎯 ¿Distingue las caras?", "🎚️ Umbral", "🌗 Condiciones difíciles"])

with t1:
    df = pd.DataFrame(configs)
    df["velocidad"] = df["ms_deteccion"] + df["ms_embedding"]
    st.dataframe(
        df[["modelo", "detector", "fotos_inscripcion", "acierto", "confusion", "rechazo",
            "umbral_recomendado", "margen", "velocidad"]],
        hide_index=True, width="stretch",
        column_config={
            "modelo": "Modelo", "detector": "Detector", "fotos_inscripcion": "Fotos inscripción",
            "acierto": st.column_config.ProgressColumn("Reconocidos", format="percent", min_value=0, max_value=1),
            "confusion": st.column_config.NumberColumn("Confusiones", format="percent"),
            "rechazo": st.column_config.NumberColumn("Repetir foto", format="percent"),
            "umbral_recomendado": st.column_config.NumberColumn("Umbral", format="%.2f"),
            "margen": st.column_config.NumberColumn("Margen", format="%+.2f",
                                                    help="Separación entre misma persona y personas distintas. "
                                                         "Positivo = se distinguen bien."),
            "velocidad": st.column_config.NumberColumn("ms/foto", format="%.0f"),
        },
    )
    st.caption("Ordenado de mejor a peor. «Margen» positivo significa que el modelo separa bien a las personas.")

with t2:
    st.markdown(
        "Cada foto se compara con las inscritas. 🟢 **Verde** = parecido con la **misma persona**; "
        "🔴 **Rojo** = parecido con la **persona distinta más parecida**. "
        "Cuanto más separados estén los dos grupos, mejor distingue el modelo. La línea negra es el umbral."
    )
    datos = pd.concat([
        pd.DataFrame({"parecido": elegida["scores_genuinos"], "tipo": "Misma persona"}),
        pd.DataFrame({"parecido": elegida["scores_impostores"], "tipo": "Persona distinta"}),
    ])
    hist = alt.Chart(datos).mark_bar(opacity=0.65, binSpacing=0).encode(
        x=alt.X("parecido:Q", bin=alt.Bin(step=0.025), title="Parecido (similitud del coseno)"),
        y=alt.Y("count():Q", stack=None, title="Cantidad de fotos"),
        color=alt.Color("tipo:N", scale=alt.Scale(domain=["Misma persona", "Persona distinta"],
                                                  range=["#16a34a", "#ef4444"]), title=None),
    )
    regla = alt.Chart(pd.DataFrame({"u": [elegida["umbral_recomendado"]]})).mark_rule(
        color="#0f172a", strokeWidth=2, strokeDash=[6, 4]).encode(x="u:Q")
    st.altair_chart((hist + regla).properties(height=320), width="stretch")

with t3:
    st.markdown("Cómo cambian los resultados al mover el umbral. **Más alto** = más estricto: menos "
                "confusiones, pero más niños deben repetir la foto.")
    curva = pd.DataFrame(elegida["curva"]).melt("umbral", ["acierto", "confusion", "rechazo"],
                                               var_name="resultado", value_name="tasa")
    curva["resultado"] = curva["resultado"].map({"acierto": "Reconocidos", "confusion": "Confusiones",
                                                 "rechazo": "Repetir foto"})
    lineas = alt.Chart(curva).mark_line(strokeWidth=3).encode(
        x=alt.X("umbral:Q", title="Umbral"),
        y=alt.Y("tasa:Q", axis=alt.Axis(format="%"), title=None),
        color=alt.Color("resultado:N", scale=alt.Scale(domain=["Reconocidos", "Confusiones", "Repetir foto"],
                                                       range=["#16a34a", "#ef4444", "#f59e0b"]), title=None),
        tooltip=["umbral", "resultado", alt.Tooltip("tasa:Q", format=".0%")],
    )
    regla = alt.Chart(pd.DataFrame({"u": [elegida["umbral_recomendado"]]})).mark_rule(
        color="#0f172a", strokeDash=[6, 4]).encode(x="u:Q")
    st.altair_chart((lineas + regla).properties(height=320), width="stretch")

with t4:
    alts = elegida.get("por_alteracion", {})
    if len(alts) <= 1:
        st.info("Ejecuta la evaluación con «Incluir condiciones difíciles» para ver esta sección.")
    else:
        nombres = {"original": "Foto normal", "oscura": "Poca luz", "sobreexpuesta": "Mucha luz",
                   "desenfocada": "Borrosa", "inclinada": "Cabeza inclinada",
                   "baja_resolucion": "Baja resolución", "boca_tapada": "Boca tapada"}
        dfa = pd.DataFrame([{"condicion": nombres.get(k, k), "acierto": v} for k, v in alts.items()])
        barras = alt.Chart(dfa).mark_bar(cornerRadiusEnd=6).encode(
            x=alt.X("acierto:Q", axis=alt.Axis(format="%"), scale=alt.Scale(domain=[0, 1]), title="Reconocidos"),
            y=alt.Y("condicion:N", sort="-x", title=None),
            color=alt.condition(alt.datum.acierto >= 0.8, alt.value("#16a34a"), alt.value("#f59e0b")),
            tooltip=["condicion", alt.Tooltip("acierto:Q", format=".0%")],
        )
        st.altair_chart(barras.properties(height=300), width="stretch")
        st.caption("En naranja, las condiciones donde falla más: conviene cuidarlas en la cancha "
                   "(por ejemplo, buena luz en el kiosko).")

# ------------------------------------------------------------------ manual
st.caption("¿Quieres ajustar el modelo, el detector o el umbral a mano? Ve a **🛠️ Ajustes**.")
