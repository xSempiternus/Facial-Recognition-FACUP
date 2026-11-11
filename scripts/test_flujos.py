"""Prueba de punta a punta de los flujos de inscripción por los padres, invitados, pendientes persistentes,
"No soy yo", fallo de reconocimiento controlado por el kiosko (aviso / descartar / abandono por vencimiento con
AVISO_TTL_S corto), novedades del staff, tours del staff, sin-asistencia-hoy, marcado manual, anulaciones,
auditoría, límites y aislamiento entre sedes.

Levanta la API real (uvicorn) en un puerto libre con un DATA_DIR temporal (dos sedes nuevas, nunca la data real),
la reinicia una vez para comprobar persistencia y borra todo al terminar.

Fotos de prueba (adultos, públicas): si eval/fotos/ tiene carpetas por persona se podrían usar, pero el
script necesita identidades concretas, así que descarga el set público de pruebas de DeepFace
(github.com/serengil/deepface, tests/unit/dataset) a la carpeta temporal. Con --fotos DIR usa esa carpeta
(debe contener los mismos nombres de archivo: img1.jpg, img3.jpg, ...).

Uso (desde la raíz del repo, con el venv):
    python scripts/test_flujos.py
    python scripts/test_flujos.py --fotos C:\\ruta\\fotos --conservar   (no borra el DATA_DIR temporal)
"""

import argparse
import base64
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

import cv2
import requests

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
URL_FOTOS = "https://raw.githubusercontent.com/serengil/deepface/master/tests/unit/dataset/"
# Identidades del set de DeepFace (según su face-recognition-pivot.csv).
PERSONA_A = ["img1.jpg", "img2.jpg", "img4.jpg", "img5.jpg", "img6.jpg", "img7.jpg", "img10.jpg", "img11.jpg"]
PERSONA_B = ["img3.jpg", "img12.jpg", "img53.jpg", "img55.jpg", "img56.jpg"]  # img54 tiene 3 caras
PERSONA_C = ["img8.jpg", "img9.jpg", "img49.jpg", "img50.jpg"]
GRUPO = "couple.jpg"
PIN_A, PIN_B, PIN_M, PIN_U = "11112222", "33334444", "55556666", "77778888"
PIN_I = "24681357"  # sede-i: pruebas del formulario de inscripción (límites por IP propios)
# Config de reconocimiento en formato antiguo (sin umbral_duda) si no existe data/config.json.
CONFIG_LEGADO = {"modelo": "GhostFaceNet", "detector": "retinaface", "umbral": 0.37, "antispoofing": False}
LIMITES = {"RL_INSCRIPCION_IP": "16/3600", "RL_INSCRIPCION_TOKEN": "12/3600", "RL_INFO_IP": "200/600",
           "RL_NO_SOY_YO_IP": "4/600", "RL_NO_SOY_YO_SEDE": "50/600",
           "RL_AVISO_IP": "14/600", "RL_AVISO_SEDE": "100/600", "RL_DESCARTAR_IP": "10/600",
           "RL_DESCARTAR_SEDE": "100/600"}
# TTL corto de las capturas no reconocidas (en producción 180 s) para probar el abandono por vencimiento.
AVISO_TTL_S = 8

resultados: list[tuple[bool, str]] = []


def check(cond, nombre: str, extra=None) -> bool:
    resultados.append((bool(cond), nombre))
    print(f"  [{'OK' if cond else 'FALLA'}] {nombre}" + ("" if cond or extra is None else f"  -> {extra}"))
    return bool(cond)


# ---------------------------------------------------------------- preparación

def puerto_libre() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def preparar_fotos(origen: Path | None, destino: Path) -> dict[str, bytes]:
    """{nombre: jpeg reducido a <=1000 px}. Descarga si no hay carpeta de origen."""
    destino.mkdir(parents=True, exist_ok=True)
    fotos = {}
    for nombre in PERSONA_A + PERSONA_B + PERSONA_C + [GRUPO]:
        ruta = (origen / nombre) if origen else destino / nombre
        if not ruta.exists():
            r = requests.get(URL_FOTOS + nombre, timeout=60)
            r.raise_for_status()
            ruta.write_bytes(r.content)
        img = cv2.imread(str(ruta))
        if img is None:
            raise RuntimeError(f"No se pudo leer {ruta}")
        k = min(1.0, 1000 / max(img.shape[:2]))
        if k < 1:
            img = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])
        fotos[nombre] = buf.tobytes()
    return fotos


class Servidor:
    def __init__(self, data_dir: Path, puerto: int, log: Path):
        self.data_dir, self.puerto, self.log = data_dir, puerto, log
        self.proc = None
        self.env = {**os.environ, "DATA_DIR": str(data_dir), "DEFAULT_SEDE": "sede-a", "STAFF_PIN": PIN_A,
                    "AUTH_SECRET": "secreto-de-prueba-flujos", "TRUST_PROXY": "0", "PYTHONIOENCODING": "utf-8",
                    "TF_CPP_MIN_LOG_LEVEL": "3", "GEMINI_API_KEY": "", "AVISO_TTL_S": str(AVISO_TTL_S), "PUBLIC_URL": "", **LIMITES}

    def iniciar(self, timeout=420):
        self.fh = open(self.log, "ab")
        self.proc = subprocess.Popen(
            [PY, "-m", "uvicorn", "api.main:app", "--host", "127.0.0.1", "--port", str(self.puerto)],
            cwd=ROOT, env=self.env, stdout=self.fh, stderr=subprocess.STDOUT)
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.proc.poll() is not None:
                raise RuntimeError("El servidor terminó al arrancar (ver log).")
            try:
                if requests.get(f"http://127.0.0.1:{self.puerto}/health", timeout=2).ok:
                    return
            except requests.RequestException:
                pass
            time.sleep(1)
        raise RuntimeError("El servidor no respondió a tiempo.")

    def detener(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(10)
        if getattr(self, "fh", None):
            self.fh.close()


class Cliente:
    def __init__(self, base: str):
        self.base = base

    def req(self, metodo, ruta, token=None, sede=None, **kw):
        h = kw.pop("headers", {})
        if token:
            h["Authorization"] = f"Bearer {token}"
        if sede:
            h["X-Sede"] = sede
        r = requests.request(metodo, self.base + ruta, headers=h, timeout=180, **kw)
        try:
            cuerpo = r.json()
        except ValueError:
            cuerpo = r.text
        return r.status_code, cuerpo


def recorte_cara(jpeg: bytes, lado: int = 160) -> bytes:
    """Simula el recorte que haría el celular: cara más grande (Haar de OpenCV), cuadrada, lado x lado, JPEG."""
    import numpy as np
    img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    cascada = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    caras = cascada.detectMultiScale(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), 1.1, 5)
    if len(caras):
        x, y, w, h = max(caras, key=lambda r: r[2] * r[3])
    else:
        h0, w0 = img.shape[:2]
        w = h = min(h0, w0) // 2
        x, y = (w0 - w) // 2, (h0 - h) // 2
    cx, cy, r = x + w / 2, y + h / 2, max(w, h) * 0.55
    x0, y0 = max(int(cx - r), 0), max(int(cy - r), 0)
    recorte = cv2.resize(img[y0:int(cy + r), x0:int(cx + r)], (lado, lado), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", recorte, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return buf.tobytes()


def codigo(cuerpo) -> str | None:
    return cuerpo.get("detail", {}).get("codigo") if isinstance(cuerpo, dict) and isinstance(cuerpo.get("detail"), dict) else None


# ---------------------------------------------------------------- flujo

def ejecutar(c: Cliente, srv: Servidor, F: dict[str, bytes]):
    def fotos(*nombres):
        return {f"foto{i + 1}": (n, F[n], "image/jpeg") for i, n in enumerate(nombres)}

    def solicitud(sede, token, nombre, nombres_fotos, **extra):
        datos = {"t": token, "nombre_nino": nombre, "anio_nacimiento": str(datetime.now().year - 9),
                 "categoria": "", "tutor_nombre": "María Pérez", "tutor_contacto": "maria@example.com",
                 "consentimiento": "true", **extra}
        return c.req("POST", "/inscripcion", sede=sede, data=datos, files=fotos(*nombres_fotos))

    def verify(sede, nombre_foto):
        return c.req("POST", "/verify", sede=sede, files={"file": ("k.jpg", F[nombre_foto], "image/jpeg")})

    def aviso(sede, ref, tipo):
        return c.req("POST", "/verify/aviso", sede=sede, data={"aviso": ref, "tipo": tipo})

    def descartar(sede, ref):
        return c.req("POST", "/verify/descartar", sede=sede, data={"aviso": ref})

    def novedades(token, desde=0):
        return c.req("GET", "/pendientes/novedades", token=token, params={"desde": str(desde)})

    def login(sede, pin):
        st, b = c.req("POST", "/auth/login", data={"pin": pin, "sede": sede})
        assert st == 200, (st, b)
        return b["token"]

    print("\n== Sesiones")
    ta, tb = login("sede-a", PIN_A), login("sede-b", PIN_B)
    check(ta and tb, "login en ambas sedes")

    print("\n== Lista pública de sedes")
    con = sqlite3.connect(srv.data_dir / "control.db")
    con.execute("INSERT INTO sedes (slug, nombre, pin_hash, creada_en, activa) VALUES ('sede-off', 'Sede Off', 'x', '2026-01-01', 0)")
    con.commit()
    con.close()
    st, ls = c.req("GET", "/sedes")
    slugs = [x["slug"] for x in ls] if isinstance(ls, list) else []
    check(st == 200 and {"sede-a", "sede-b"} <= set(slugs) and "sede-off" not in slugs, "GET /sedes lista solo activas", ls)
    check(all(set(x) == {"slug", "nombre"} for x in ls) and "pin" not in json.dumps(ls).lower(),
          "GET /sedes sin campos extra (ni PIN ni conteos)", ls)
    st, nom = c.req("GET", "/sedes/sede-off")
    check(st == 404, "sede desactivada no sale en /sedes/<slug>", (st, nom))

    print("\n== Enlaces de inscripción")
    st, en = c.req("POST", "/inscripcion/enlaces", token=ta, data={"categoria": "Sub-10", "dias": "7"})
    check(st == 200 and en["ruta"] == f"/s/sede-a/inscripcion?t={en['token']}" and en["expira"], "crear enlace", en)
    tok = en["token"]
    st, lista = c.req("GET", "/inscripcion/enlaces", token=ta)
    check(st == 200 and lista[0]["estado"] == "activo" and "token" not in lista[0] and "token_hash" not in lista[0],
          "listar enlaces sin exponer token ni hash", lista)
    st, info = c.req("GET", "/inscripcion/info", sede="sede-a", params={"t": tok})
    check(st == 200 and info["sede"]["slug"] == "sede-a" and info["categorias"] == ["Sub-10"]
          and info["consentimiento"]["version"] and "vector" in info["consentimiento"]["texto"], "info pública", info)
    st, b = c.req("GET", "/inscripcion/info", sede="sede-b", params={"t": tok})
    check(st == 404 and codigo(b) == "enlace_invalido", "token de otra sede -> 404 genérico", (st, b))
    st, b = c.req("GET", "/inscripcion/info", sede="sede-a", params={"t": "x" * 43})
    check(st == 404 and codigo(b) == "enlace_invalido", "token inválido -> 404", (st, b))
    st, b = c.req("GET", "/inscripcion/info", sede="sede-a", params={"t": tok}, headers={})
    st_nos, _ = c.req("POST", "/inscripcion/enlaces", data={"dias": "7"})
    check(st_nos == 401, "crear enlace sin token staff -> 401")

    print("\n== Validaciones de la solicitud pública (sin filtrar datos)")
    st, b = solicitud("sede-a", tok, "Ana Uno", PERSONA_A[:3], consentimiento="")
    check(st == 400 and codigo(b) == "sin_consentimiento", "sin consentimiento -> 400", (st, b))
    st, b = solicitud("sede-a", tok, "Ana Uno", PERSONA_A[:1])
    check(st == 400 and codigo(b) == "faltan_fotos", "una sola foto -> 400", (st, b))
    st, b = solicitud("sede-a", tok, "Ana Uno", PERSONA_A[:2], tutor_contacto="no-es-contacto")
    check(st == 400 and codigo(b) == "datos_invalidos", "contacto inválido -> 400", (st, b))
    st, b = solicitud("sede-a", tok, "<script>", PERSONA_A[:2])
    check(st == 400 and codigo(b) == "datos_invalidos", "nombre con caracteres no permitidos -> 400", (st, b))
    st, b = solicitud("sede-a", tok, "Ana Uno", [PERSONA_A[0], GRUPO])
    check(st == 422 and codigo(b) == "varias_caras", "foto con dos caras -> 422", (st, b))
    st, b = solicitud("sede-a", tok, "Ana Uno", [PERSONA_A[0], PERSONA_B[0]])
    check(st == 422 and codigo(b) == "fotos_inconsistentes", "fotos de personas distintas -> 422", (st, b))
    st, b = c.req("POST", "/inscripcion", sede="sede-a",
                  data={"t": tok, "nombre_nino": "Ana Uno", "anio_nacimiento": "2016", "tutor_nombre": "María Pérez",
                        "tutor_contacto": "+56 9 1234 5678", "consentimiento": "true"},
                  files={"foto1": ("a.txt", b"hola", "text/plain"), "foto2": ("b.txt", b"hola", "text/plain")})
    check(st == 415, "archivo que no es imagen -> 415", (st, b))

    print("\n== Solicitud válida -> pendiente (sin crear jugador)")
    st, s1 = solicitud("sede-a", tok, "Ana Uno", PERSONA_A[:3])
    check(st == 200 and s1["status"] == "pendiente" and len(s1["codigo"]) == 9, "solicitud persona A", (st, s1))
    st, jug = c.req("GET", "/jugadores", token=ta)
    check(st == 200 and jug == [], "la solicitud NO crea jugador", jug)
    st, sols = c.req("GET", "/solicitudes", token=ta)
    ok = st == 200 and len(sols) == 1
    check(ok and sols[0]["fotos"] == 3 and sols[0]["duplicado"] is None and sols[0]["categoria"] == "Sub-10"
          and sols[0]["tutor_contacto"] == "maria@example.com", "aparece en /solicitudes", sols)
    if ok:
        mini = base64.b64decode(sols[0]["miniatura"])
        im = cv2.imdecode(__import__("numpy").frombuffer(mini, "uint8"), cv2.IMREAD_COLOR)
        check(im is not None and max(im.shape[:2]) <= 200 and len(mini) < 30_000, "miniatura JPEG pequeña", len(mini))
    db_a = srv.data_dir / "sedes" / "sede-a" / "asistencia.db"
    with sqlite3.connect(db_a) as conn:
        cons = conn.execute("SELECT solicitud_id, version_texto, texto_hash, tutor, contacto, ip_hash "
                            "FROM consentimientos").fetchall()
        cols = [r[1] for r in conn.execute("PRAGMA table_info(solicitudes)")]
    check(len(cons) == 1 and cons[0][2] and cons[0][5] and cons[0][5] != "127.0.0.1", "evidencia de consentimiento", cons)
    check(not any("foto" in col and col != "miniatura" for col in cols) and "embeddings" in cols,
          "la tabla solicitudes no guarda fotos originales", cols)

    print("\n== Aprobar")
    sid_a = sols[0]["id"]
    st, ap = c.req("POST", f"/solicitudes/{sid_a}/aprobar", token=ta, data={})
    check(st == 200 and ap["nombre"] == "Ana Uno" and ap["fotos"] == 3, "aprobar crea jugador activo", (st, ap))
    id_a = ap["id"]
    st, jug = c.req("GET", "/jugadores", token=ta)
    ja = next((j for j in jug if j["id"] == id_a), {})
    check(ja.get("estado") == "activo" and ja.get("tiene_consentimiento") is True and ja.get("fotos") == 3,
          "jugador con estado y consentimiento", ja)
    st, sols = c.req("GET", "/solicitudes", token=ta)
    check(sols == [], "la solicitud aprobada desaparece (miniatura borrada)", sols)
    st, b = c.req("POST", f"/solicitudes/{sid_a}/aprobar", token=ta)
    check(st == 404, "aprobar dos veces -> 404", (st, b))
    with sqlite3.connect(db_a) as conn:
        n_sface = conn.execute("SELECT COUNT(*) FROM fotos WHERE jugador_id = ? AND modelo = 'SFace'", (id_a,)).fetchone()[0]
        n_sol_extra = conn.execute("SELECT COUNT(*) FROM solicitudes WHERE embeddings_extra IS NOT NULL").fetchone()[0]
    check(n_sface == 3 and n_sol_extra == 0, "sombra: aprobar guarda las plantillas SFace calculadas al recibir la "
                                            "solicitud (y la solicitud se borra)", (n_sface, n_sol_extra))

    print("\n== Duplicados")
    st, s2 = solicitud("sede-a", tok, "Ana Repetida", PERSONA_A[3:6])
    check(st == 200 and s2["status"] == "pendiente", "solicitud repetida: respuesta idéntica (no filtra)", (st, s2))
    st, b1 = solicitud("sede-a", tok, "Beto Dos", PERSONA_B[:3])
    st2, b2 = solicitud("sede-a", tok, "Beto Doble", PERSONA_B[3:5])
    check(st == 200 and st2 == 200, "dos solicitudes de la persona B", (st, b1, st2, b2))
    st, sols = c.req("GET", "/solicitudes", token=ta)
    rep = next((x for x in sols if x["nombre_nino"] == "Ana Repetida"), {})
    check((rep.get("duplicado") or {}).get("jugador_id") == id_a and rep["duplicado"]["nombre"] == "Ana Uno"
          and rep["duplicado"]["similitud"] > 0, "duplicado contra jugador activo detectado", rep.get("duplicado"))
    beto1 = next((x for x in sols if x["nombre_nino"] == "Beto Dos"), {})
    beto2 = next((x for x in sols if x["nombre_nino"] == "Beto Doble"), {})
    check((beto2.get("duplicado_solicitud") or {}).get("solicitud_id") == beto1.get("id"),
          "duplicado contra otra solicitud pendiente", beto2.get("duplicado_solicitud"))
    check(beto1.get("duplicado") is None, "persona distinta no se marca como duplicado", beto1.get("duplicado"))

    print("\n== Rechazar")
    st, b = c.req("POST", f"/solicitudes/{rep['id']}/rechazar", token=ta, data={"motivo": "ya inscrita"})
    st2, _ = c.req("POST", f"/solicitudes/{beto2['id']}/rechazar", token=ta, data={})
    with sqlite3.connect(db_a) as conn:
        quedan = conn.execute("SELECT COUNT(*) FROM solicitudes WHERE id IN (?, ?)", (rep["id"], beto2["id"])).fetchone()[0]
        cons_rech = conn.execute("SELECT COUNT(*) FROM consentimientos WHERE solicitud_id IN (?, ?)",
                                 (rep["id"], beto2["id"])).fetchone()[0]
    check(st == 200 and st2 == 200 and quedan == 0 and cons_rech == 0, "rechazar borra solicitud, biometría y contacto")
    st, ap_b = c.req("POST", f"/solicitudes/{beto1['id']}/aprobar", token=ta, data={"nombre": "Beto Dos Tres"})
    check(st == 200 and ap_b["nombre"] == "Beto Dos Tres", "aprobar con nombre corregido", (st, ap_b))
    id_b = ap_b["id"]

    print("\n== Sin asistencia hoy (ayuda para marcar a mano)")
    st, sa = c.req("GET", "/jugadores/sin-asistencia-hoy", token=ta)
    check(st == 200 and [j["id"] for j in sa] == [id_a, id_b] and all(set(j) == {"id", "nombre", "categoria"} for j in sa),
          "activos sin asistencia, por categoría y nombre, sin miniaturas", sa)
    st, b = c.req("GET", "/jugadores/sin-asistencia-hoy")
    check(st == 401, "sin-asistencia-hoy exige staff", (st, b))

    print("\n== Preferencias / tours del staff (por sede, persistentes)")
    st, pr = c.req("GET", "/staff/preferencias", token=ta)
    check(st == 200 and pr == {"tours_vistos": []}, "sin tours vistos al inicio", pr)
    c.req("POST", "/staff/tours/kiosko-intro", token=ta)
    st, pr = c.req("POST", "/staff/tours/kiosko-intro", token=ta)
    c.req("POST", "/staff/tours/panel-2", token=ta)
    st2, pr2 = c.req("GET", "/staff/preferencias", token=ta)
    check(st == 200 and pr2["tours_vistos"] == ["kiosko-intro", "panel-2"], "marcar tour idempotente", (pr, pr2))
    malos = [c.req("POST", f"/staff/tours/{t}", token=ta)[0] for t in ("Mayus", "con_guion_bajo", "x" * 41)]
    check(malos == [400, 400, 400], "id de tour inválido -> 400", malos)
    st, b = c.req("POST", "/staff/tours/kiosko-intro")
    check(st == 401, "tours exigen staff", st)
    st, prb = c.req("GET", "/staff/preferencias", token=tb)
    check(prb == {"tours_vistos": []}, "tours aislados por sede", prb)

    print("\n== Kiosko: reconoce, 'No soy yo', disputa")
    st, v = verify("sede-a", "img10.jpg")
    check(st == 200 and v["nombre"] == "Ana" and v["ya_registrado"] is False and v.get("reporte"),
          "/verify reconoce a la niña aprobada y entrega reporte", (st, v))
    check(isinstance(v.get("revisar"), bool) and "similitud" not in v,
          "/verify entrega `revisar` booleano (sin puntaje)", v)
    st, res = c.req("GET", "/kiosko/resumen", sede="sede-a")
    check(res["llegadas_hoy"] == 1, "kiosko cuenta 1 llegada", res)
    st, nsy = c.req("POST", "/verify/no-soy-yo", sede="sede-a", data={"reporte": v["reporte"]})
    check(st == 200 and nsy == {"status": "ok"}, "'No soy yo' -> 200 genérico", (st, nsy))
    st, nsy2 = c.req("POST", "/verify/no-soy-yo", sede="sede-a", data={"reporte": v["reporte"]})
    check(st == 200 and nsy2 == {"status": "ok"}, "reporte reutilizado -> mismo 200 genérico", (st, nsy2))
    st, asis = c.req("GET", "/asistencias", token=ta, params={"hoy": "true"})
    disp = [a for a in asis if a["jugador_id"] == id_a]
    check(len(disp) == 1 and disp[0]["estado"] == "disputada" and {"id", "origen", "estado"} <= set(disp[0]),
          "asistencia queda 'disputada'", asis)
    st, res = c.req("GET", "/kiosko/resumen", sede="sede-a")
    check(res["llegadas_hoy"] == 0, "disputada excluida del conteo del kiosko", res)
    st, rp = c.req("GET", "/reportes", token=ta)
    fila = next((f for f in rp["jugadores"] if f["id"] == id_a), {})
    check(fila.get("presentes") == 0, "disputada excluida de reportes", fila)
    st, pend = c.req("GET", "/pendientes", token=ta)
    check(len(pend) == 1 and pend[0]["motivo"] == "no_soy_yo" and pend[0]["disputa_de"]["nombre"] == "Ana Uno"
          and pend[0]["miniatura"], "pendiente con disputa_de (un solo pendiente pese al reuso)", pend)
    st, sa = c.req("GET", "/jugadores/sin-asistencia-hoy", token=ta)
    check(id_a in [j["id"] for j in sa], "la asistencia disputada no cuenta como válida en sin-asistencia-hoy", sa)

    print("\n== Persistencia: reinicio del servidor")
    srv.detener()
    srv.iniciar()
    st, pend2 = c.req("GET", "/pendientes", token=ta)
    check(st == 200 and [p["id"] for p in pend2] == [p["id"] for p in pend] and pend2[0]["disputa_de"]["id"] == id_a,
          "pendientes persisten tras reiniciar (token sigue válido con AUTH_SECRET)", (st, pend2))
    st, pr = c.req("GET", "/staff/preferencias", token=ta)
    check(pr == {"tours_vistos": ["kiosko-intro", "panel-2"]}, "tours persisten tras reiniciar", pr)
    st, pr = c.req("DELETE", "/staff/tours", token=ta)
    st2, pr2 = c.req("GET", "/staff/preferencias", token=ta)
    check(st == 200 and pr2 == {"tours_vistos": []}, "DELETE /staff/tours los reinicia", pr2)

    # Orden: primero las disputas de A (confirmada / 'ya registrado') y al final la asignación de la captura de A a B.
    # Esa asignación mete la cara de A en las plantillas de B: desde ahí A y B empatan y la regla de margen deja a A
    # en DUDOSO (correcto: el sistema prefiere dudar), así que los flujos que necesitan reconocer a A van antes.
    print("\n== Disputa confirmada (era el mismo) y disputa con 'ya registrado'")
    st, v2 = verify("sede-a", "img11.jpg")
    check(st == 200 and v2["ya_registrado"] is False, "A vuelve a marcar (su anterior está disputada)", (st, v2))
    c.req("POST", "/verify/no-soy-yo", sede="sede-a", data={"reporte": v2["reporte"]})
    st, pend = c.req("GET", "/pendientes", token=ta)
    st, asg = c.req("POST", f"/pendientes/{pend[0]['id']}/asignar", token=ta, data={"jugador_id": id_a})
    check(st == 200 and asg["disputa"] == "confirmada" and asg["ya_registrado"] is True,
          "asignar al mismo -> asistencia restaurada", (st, asg))
    st, res = c.req("GET", "/kiosko/resumen", sede="sede-a")
    check(res["llegadas_hoy"] == 1, "conteo 1 (A restaurada)", res)
    st, v3 = verify("sede-a", "img10.jpg")
    check(st == 200 and v3["ya_registrado"] is True, "tercer verify: ya registrado", (st, v3))
    c.req("POST", "/verify/no-soy-yo", sede="sede-a", data={"reporte": v3["reporte"]})
    st, pend = c.req("GET", "/pendientes", token=ta)
    st, dl = c.req("DELETE", f"/pendientes/{pend[0]['id']}", token=ta)
    st2, asis = c.req("GET", "/asistencias", token=ta, params={"hoy": "true"})
    check(st == 200 and dl["disputa"] == "sin_asistencia"
          and [a["estado"] for a in asis if a["jugador_id"] == id_a].count("valida") == 1,
          "'ya registrado' no toca la asistencia", (dl, asis))

    print("\n== Resolver disputa asignando a otro niño")
    aid_1 = next((a["id"] for a in asis if a["jugador_id"] == id_a and a["estado"] == "disputada"), None)
    st, asg = c.req("POST", f"/pendientes/{pend2[0]['id']}/asignar", token=ta, data={"jugador_id": id_b})
    check(st == 200 and asg["disputa"] == "anulada" and asg["ya_registrado"] is False, "asignar disputa a B", (st, asg))
    st, asis = c.req("GET", "/asistencias", token=ta, params={"hoy": "true", "todas": "true"})
    est = {a["id"]: a["estado"] for a in asis}
    check(aid_1 is not None and est.get(aid_1) == "anulada"
          and [a["estado"] for a in asis if a["jugador_id"] == id_b] == ["valida"], "A (disputada) anulada, B válida", asis)
    st, res = c.req("GET", "/kiosko/resumen", sede="sede-a")
    check(res["llegadas_hoy"] == 2, "conteo 2 (A restaurada + B)", res)
    # Tras el reinicio van 2 reportes (v2, v3); el límite de prueba es 4 por IP.
    cods = [c.req("POST", "/verify/no-soy-yo", sede="sede-a", data={"reporte": "inventado"})[0] for _ in range(3)]
    check(cods == [200, 200, 429], "reporte inválido -> 200 genérico; rate limit de 'No soy yo' por IP", cods)

    print("\n== Fallo de reconocimiento controlado por el kiosko (aviso / descartar)")
    st, n0 = novedades(ta)
    st, v = verify("sede-a", "img8.jpg")
    a1 = (v.get("detail") or {}).get("aviso") if isinstance(v, dict) else None
    check(st == 404 and codigo(v) == "no_reconocido" and isinstance(a1, str) and len(a1) >= 20
          and set(v["detail"]) == {"codigo", "mensaje", "aviso"}, "desconocido -> no_reconocido con aviso", (st, v))
    st, pend = c.req("GET", "/pendientes", token=ta)
    st2, n1 = novedades(ta, n0["ultimo_id"])
    check(pend == [] and n1["nuevos"] == [] and n1["total"] == 0, "/verify no reconocido NO crea pendiente", (pend, n1))
    st, b = descartar("sede-a", a1)
    st2, b2 = aviso("sede-a", a1, "nuevo")
    st3, pend = c.req("GET", "/pendientes", token=ta)
    check(st == 200 and b == {"status": "ok"} and st2 == 404 and codigo(b2) == "aviso_invalido" and pend == [],
          "descartar: sin pendiente y el aviso ya no sirve", (st, b, st2, b2, pend))
    st, b = descartar("sede-a", a1)
    check(st == 200 and b == {"status": "ok"}, "descartar repetido -> 200 genérico", (st, b))
    st, v = verify("sede-a", "img8.jpg")
    a2 = v["detail"]["aviso"]
    check(a2 != a1, "cada intento entrega un aviso nuevo")
    st, b = aviso("sede-b", a2, "nuevo")
    check(st == 404, "aviso de la sede A no sirve en la sede B", (st, b))
    st, b = aviso("sede-a", a2, "otro")
    check(st == 400, "tipo de aviso inválido -> 400", (st, b))
    st, b = aviso("sede-a", "inventado-" * 3, "nuevo")
    check(st == 404 and codigo(b) == "aviso_invalido", "aviso inventado -> 404 genérico", (st, b))
    st, b = aviso("sede-a", a2, "nuevo")
    st2, b2 = aviso("sede-a", a2, "nuevo")
    st3, b3 = aviso("sede-a", a2, "entrenador")
    st4, pend = c.req("GET", "/pendientes", token=ta)
    check(st == 200 and b == {"status": "ok"} and st2 == 200 and b2 == {"status": "ok"} and st3 == 200,
          "aviso 'nuevo' -> ok, idempotente", (st, b, st2, b2, st3, b3))
    check(len(pend) == 1 and pend[0]["motivo"] == "nino_nuevo" and pend[0]["disputa_de"] is None and pend[0]["miniatura"],
          "un solo pendiente 'nino_nuevo' pese a repetir el aviso", pend)
    st, asis = c.req("GET", "/asistencias", token=ta, params={"hoy": "true", "todas": "true"})
    check(st == 200 and len(asis) == 3, "los avisos no crean asistencia", asis)
    st, n2 = novedades(ta, n0["ultimo_id"])
    check(st == 200 and n2["total"] == 1 and [x["id"] for x in n2["nuevos"]] == [pend[0]["id"]]
          and n2["ultimo_id"] == pend[0]["id"] and n2["nuevos"][0]["motivo"] == "nino_nuevo"
          and n2["nuevos"][0]["miniatura"] and set(n2["nuevos"][0]) == {"id", "timestamp", "motivo", "miniatura",
                                                                        "sugerido", "disputa_de", "parecido"},
          "novedades con desde trae solo lo nuevo", n2)
    st, n3 = novedades(ta, n2["ultimo_id"])
    check(n3 == {"ultimo_id": n2["ultimo_id"], "total": 1, "nuevos": []}, "novedades desde el último id -> vacío", n3)
    st, b = c.req("GET", "/pendientes/novedades")
    st2, nb = novedades(tb)
    check(st == 401 and nb["total"] == 0 and nb["nuevos"] == [], "novedades exige staff y está aislada por sede", (st, nb))
    st, b = c.req("GET", "/pendientes/novedades", token=ta, params={"desde": "-1"})
    check(st == 422, "desde negativo -> 422", st)

    print("\n== Captura sin aviso -> pendiente 'abandono' al vencer")
    st, v = verify("sede-a", "img49.jpg")  # persona C, aún no inscrita
    a3 = v["detail"]["aviso"]
    st, pend = c.req("GET", "/pendientes", token=ta)
    check(len(pend) == 1, "recién capturada: todavía no es pendiente", pend)
    t0, nuevo = time.time(), []
    while time.time() - t0 < AVISO_TTL_S + 25 and not nuevo:
        time.sleep(2)
        st, n4 = novedades(ta, n2["ultimo_id"])
        nuevo = n4["nuevos"]
    check(len(nuevo) == 1 and nuevo[0]["motivo"] == "no_reconocido" and n4["total"] == 2,
          f"tras {AVISO_TTL_S} s sin respuesta pasa sola a pendiente (no_reconocido)", n4)
    st, b = aviso("sede-a", a3, "entrenador")
    st2, n5 = novedades(ta, n2["ultimo_id"])
    check(st == 200 and n5["total"] == 2, "aviso tardío sobre una captura ya convertida: ok sin duplicar", (st, b, n5))
    p_abandono = nuevo[0]["id"] if nuevo else None  # queda para la prueba de retención

    print("\n== Llegada no reconocida -> invitado -> aprobación de su familia")
    st, pend = c.req("GET", "/pendientes", token=ta)
    p_nuevo = next((p for p in pend if p["motivo"] == "nino_nuevo"), None)
    check(p_nuevo is not None and p_nuevo["disputa_de"] is None, "pendiente 'nino_nuevo' persistido", pend)
    st, inv = c.req("POST", f"/pendientes/{p_nuevo['id']}/invitado", token=ta,
                    data={"nombre": "Carlos Nuevo", "categoria": "Sub-10"})
    check(st == 200 and inv["estado"] == "invitado", "pendiente -> invitado", (st, inv))
    id_c = inv["id"]
    st, asis = c.req("GET", "/asistencias", token=ta, params={"hoy": "true"})
    ac = [a for a in asis if a["jugador_id"] == id_c]
    check(len(ac) == 1 and ac[0]["origen"] == "invitado" and ac[0]["timestamp"] == p_nuevo["timestamp"]
          and ac[0]["jugador_estado"] == "invitado", "asistencia del invitado a la hora de la llegada", ac)
    st, b = c.req("POST", f"/jugadores/{id_c}/foto", token=ta, files={"file": ("x.jpg", F["img9.jpg"], "image/jpeg")})
    check(st == 409 and codigo(b) == "es_invitado", "no se agrega biometría a un invitado sin consentimiento", (st, b))
    st, v = verify("sede-a", "img8.jpg")
    check(st == 404, "invitado excluido del reconocimiento", (st, v))
    descartar("sede-a", v["detail"]["aviso"])
    st, sc = solicitud("sede-a", tok, "Carlos Nuevo", PERSONA_C[1:4])
    st2, sols = c.req("GET", "/solicitudes", token=ta)
    sc_id = next((x["id"] for x in sols if x["nombre_nino"] == "Carlos Nuevo"), None)
    st, ap = c.req("POST", f"/solicitudes/{sc_id}/aprobar", token=ta, data={"invitado_id": str(id_c)})
    check(st == 200 and ap["id"] == id_c and ap["invitado_convertido"], "aprobar convierte al invitado", (st, ap))
    st, jug = c.req("GET", "/jugadores", token=ta)
    jc = next((j for j in jug if j["id"] == id_c), {})
    check(jc.get("estado") == "activo" and jc.get("asistencias") == 1 and jc.get("fotos") == 3
          and jc.get("tiene_consentimiento"), "conserva asistencias y queda activo", jc)
    st, v = verify("sede-a", "img8.jpg")
    check(st == 200 and v["nombre"] == "Carlos" and v["ya_registrado"] is True, "ahora el kiosko lo reconoce", (st, v))

    print("\n== Invitado manual y reportes")
    st, inv2 = c.req("POST", "/invitados", token=ta, data={"nombre": "Diego Prueba", "categoria": "Sub-10"})
    check(st == 200 and inv2["estado"] == "invitado", "POST /invitados", (st, inv2))
    st, jug = c.req("GET", "/jugadores", token=ta)
    jd = next((j for j in jug if j["id"] == inv2["id"]), {})
    check(jd.get("estado") == "invitado" and jd.get("tiene_consentimiento") is False and jd.get("fotos") == 0,
          "invitado sin biometría ni consentimiento", jd)
    st, rp = c.req("GET", "/reportes", token=ta)
    fd = next((f for f in rp["jugadores"] if f["id"] == inv2["id"]), {})
    check(fd.get("estado") == "invitado" and fd.get("presentes") == 1, "invitado marcado en reportes", fd)
    st, b = c.req("POST", "/solicitudes/999/aprobar", token=ta, data={"invitado_id": str(id_a)})
    check(st == 404, "aprobar solicitud inexistente -> 404", (st, b))

    print("\n== Candidatos a invitado (¿vino a probarse antes?)")
    sys.path.insert(0, str(ROOT))
    from datetime import datetime as _dt
    from src.candidatos import candidatos_invitado as _cand
    hoy_ = _dt(2026, 6, 15)
    inv_ = [
        {"id": 1, "nombre": "Amaro Vidal", "categoria": "Sub-8", "creado_en": "2026-06-10T10:00:00", "asistencias": 1},
        {"id": 2, "nombre": "Bastián Ossa", "categoria": "Sub-10", "creado_en": "2026-06-12T10:00:00", "asistencias": 2},
        {"id": 3, "nombre": "Emilio Pérez", "categoria": "Sub-10", "creado_en": "2026-06-12T10:00:00", "asistencias": 2},
        {"id": 4, "nombre": "emilio perez soto", "categoria": "Sub-10", "creado_en": "2026-01-01T10:00:00", "asistencias": 1},
        {"id": 5, "nombre": "Emilio Pérez", "categoria": "Sub-12", "creado_en": "2026-06-12T10:00:00", "asistencias": 1},
        {"id": 6, "nombre": "Emilo Perez", "categoria": None, "creado_en": "2026-06-14T10:00:00", "asistencias": 1},
    ]
    r_ = _cand("Emilio Pérez Soto", "Sub-10", inv_, hoy_)
    check([c["id"] for c in r_][:2] == [4, 3] or [c["id"] for c in r_][0] in (3, 4), "candidatos: parecidos y misma categoría primero", r_)
    check(all(c["id"] not in (1, 2, 5) for c in r_), "candidatos: sin parecido o de otra categoría no aparecen", r_)
    check(len(r_) <= 3, "candidatos: máximo 3", r_)
    check(_cand("Emilio P.", None, inv_, hoy_) != [], "candidatos: apellido abreviado y sin categoría")
    check(_cand("Zacarías Nuevo", "Sub-10", inv_, hoy_) == [], "candidatos: nombre sin parecido -> ninguno")
    st, sols_ = c.req("GET", "/solicitudes", token=ta)
    check(st == 200 and all(isinstance(x.get("candidatos_invitado"), list) for x in sols_), "GET /solicitudes trae candidatos_invitado", (st, sols_))

    print("\n== Anular asistencia y PATCH jugador")
    st, asis = c.req("GET", "/asistencias", token=ta, params={"hoy": "true"})
    aid_d = next(a["id"] for a in asis if a["jugador_id"] == inv2["id"])
    st, b = c.req("DELETE", f"/asistencias/{aid_d}", token=ta, data={"motivo": "marcado por error"})
    check(st == 200 and b["estado"] == "anulada", "anular asistencia", (st, b))
    st, b = c.req("DELETE", f"/asistencias/{aid_d}", token=ta)
    check(st == 409, "anular dos veces -> 409", (st, b))
    st, asis = c.req("GET", "/asistencias", token=ta, params={"hoy": "true"})
    check(all(a["id"] != aid_d for a in asis), "anulada fuera del listado por defecto")
    st, asis_t = c.req("GET", "/asistencias", token=ta, params={"hoy": "true", "todas": "true"})
    an = next((a for a in asis_t if a["id"] == aid_d), {})
    check(an.get("estado") == "anulada" and an.get("motivo") == "marcado por error", "visible con todas=true", an)
    st, rp = c.req("GET", "/reportes", token=ta)
    check(next(f for f in rp["jugadores"] if f["id"] == inv2["id"])["presentes"] == 0, "anulada fuera de reportes")
    st, b = c.req("PATCH", f"/jugadores/{id_b}", token=ta, data={"nombre": "Alberto Dos", "sin_categoria": "true"})
    st2, jug = c.req("GET", "/jugadores", token=ta)
    jb = next(j for j in jug if j["id"] == id_b)
    check(st == 200 and jb["nombre"] == "Alberto Dos" and jb["categoria"] is None, "PATCH nombre y categoría", (b, jb))
    st, b = c.req("PATCH", f"/jugadores/{id_b}", token=ta, data={"categoria": "No Existe Zzz"})
    check(st == 200 and b["categoria"] == "No Existe Zzz", "PATCH con categoría nueva (se crea, como /enroll)", b)
    st, b = c.req("PATCH", "/jugadores/9999", token=ta, data={"nombre": "X"})
    check(st == 404, "PATCH inexistente -> 404")

    print("\n== Enlaces vencidos / revocados")
    st, en2 = c.req("POST", "/inscripcion/enlaces", token=ta, data={"dias": "1"})
    with sqlite3.connect(db_a) as conn:
        conn.execute("UPDATE enlaces_inscripcion SET expira = ? WHERE id = ?",
                     ((datetime.now() - timedelta(minutes=1)).isoformat(sep=" ", timespec="seconds"), en2["id"]))
    st, b = c.req("GET", "/inscripcion/info", sede="sede-a", params={"t": en2["token"]})
    check(st == 410 and codigo(b) == "enlace_invalido", "enlace vencido -> 410", (st, b))
    st, b = c.req("DELETE", f"/inscripcion/enlaces/{en['id']}", token=ta)
    st2, b2 = c.req("GET", "/inscripcion/info", sede="sede-a", params={"t": tok})
    st3, b3 = solicitud("sede-a", tok, "Tarde Uno", PERSONA_B[:2])
    check(st == 200 and st2 == 410 and st3 == 410, "enlace revocado -> 410 en info y en POST", (st2, st3))
    st, lista = c.req("GET", "/inscripcion/enlaces", token=ta)
    estados = {e["id"]: e["estado"] for e in lista}
    check(estados.get(en["id"]) == "revocado" and estados.get(en2["id"]) == "vencido", "estados de enlaces", estados)
    st, b = c.req("POST", "/inscripcion/enlaces", token=ta, data={"dias": "90"})
    check(st == 400, "vigencia fuera de rango -> 400")

    print("\n== Retención (purga automática)")
    st, en3 = c.req("POST", "/inscripcion/enlaces", token=ta, data={"dias": "3"})
    st, s_old = solicitud("sede-a", en3["token"], "Vieja Uno", PERSONA_B[3:5])
    st2, pend = c.req("GET", "/pendientes", token=ta)
    check([p["id"] for p in pend] == [p_abandono], "queda el pendiente del abandono antes de la purga", pend)
    with sqlite3.connect(db_a) as conn:
        viejo = (datetime.now() - timedelta(days=31)).isoformat(sep=" ", timespec="seconds")
        conn.execute("UPDATE solicitudes SET creado_en = ?", (viejo,))
        conn.execute("UPDATE pendientes SET timestamp = ?",
                     ((datetime.now() - timedelta(days=8)).isoformat(sep=" ", timespec="seconds"),))
    st, sols = c.req("GET", "/solicitudes", token=ta)
    st2, pend = c.req("GET", "/pendientes", token=ta)
    with sqlite3.connect(db_a) as conn:
        n_cons = conn.execute("SELECT COUNT(*) FROM consentimientos WHERE jugador_id IS NULL").fetchone()[0]
    check(sols == [] and pend == [] and n_cons == 0, "solicitudes >30 días y pendientes >7 días purgados",
          (sols, pend, n_cons))

    print("\n== Auditoría")
    st, aud = c.req("GET", "/auditoria", token=ta)
    acciones = {a["accion"] for a in aud}
    esperadas = {"crear_enlace", "revocar_enlace", "aprobar_solicitud", "rechazar_solicitud", "anular_asistencia",
                 "crear_invitado", "editar_jugador", "no_soy_yo", "resolver_disputa", "solicitud_recibida"}
    check(esperadas <= acciones, "acciones auditadas", esperadas - acciones)
    texto = json.dumps(aud, ensure_ascii=False)
    check("embedding" not in texto and "maria@example.com" not in texto and len(aud) <= 200,
          "auditoría sin biometría ni contacto")

    print("\n== Aislamiento entre sedes y rate limits")
    st, jb_ = c.req("GET", "/jugadores", token=tb)
    st2, pb = c.req("GET", "/pendientes", token=tb)
    st3, sb = c.req("GET", "/solicitudes", token=tb)
    st4, ab = c.req("GET", "/auditoria", token=tb)
    check(jb_ == [] and pb == [] and sb == [] and ab == [], "sede B no ve nada de la sede A", (jb_, pb, sb, ab))
    st, b = c.req("PATCH", f"/jugadores/{id_a}", token=tb, data={"nombre": "Hack"})
    check(st == 404, "token de B no edita jugador de A", (st, b))
    st, b = c.req("DELETE", f"/asistencias/{aid_d}", token=tb)
    check(st == 404, "token de B no anula asistencia de A", (st, b))
    st, v = verify("sede-b", "img10.jpg")
    check(st == 404 and codigo(v) == "sin_jugadores", "verify en B no reconoce jugadores de A", (st, v))
    st, enb = c.req("POST", "/inscripcion/enlaces", token=tb, data={})
    st, b = c.req("GET", "/inscripcion/info", sede="sede-a", params={"t": enb["token"]})
    check(st == 404, "token de enlace de B no sirve en A", (st, b))
    codigos = [solicitud("sede-b", enb["token"], "Limite Uno", [], consentimiento="")[0] for _ in range(13)]
    check(codigos[:12] == [400] * 12 and codigos[12] == 429, "rate limit por token", codigos)
    codigos = [solicitud("sede-a", "y" * 43, "Limite Dos", [])[0] for _ in range(18)]
    check(429 in codigos and codigos[-1] == 429, "rate limit por IP", codigos)
    # Hasta aquí van 8 avisos y 3 descartes desde esta IP (límites de prueba: 14 y 10 por IP).
    cods = [aviso("sede-a", "inventado-" * 3, "nuevo")[0] for _ in range(8)]
    check(cods == [404] * 6 + [429] * 2, "rate limit de /verify/aviso por IP (respuestas genéricas)", cods)
    cods = [descartar("sede-b", "inventado-" * 3)[0] for _ in range(10)]
    check(cods == [200] * 7 + [429] * 3, "rate limit de /verify/descartar por IP (respuesta genérica)", cods)

    print("\n== Marcar a mano (staff) en la sede B")
    st, b = c.req("POST", "/enroll", token=tb, data={"nombre": "Bruno Be", "consentimiento": "true",
                                                      "tutor": "Tutor B", "categoria": "Sub-10"},
                  files=[("files", (n, F[n], "image/jpeg")) for n in PERSONA_B[:2]])
    check(st == 200, "inscribir jugador en B", (st, b))
    id_bb = b.get("id")
    st, sa = c.req("GET", "/jugadores/sin-asistencia-hoy", token=tb)
    check([j["id"] for j in sa] == [id_bb], "sin-asistencia-hoy de B solo ve a B", sa)
    st, b = c.req("POST", "/asistencia/manual", data={"jugador_id": str(id_bb)}, sede="sede-b")
    check(st == 401, "/asistencia/manual sin token staff -> 401", (st, b))
    st, b = c.req("POST", "/asistencia/manual", token=tb, data={"jugador_id": str(id_bb)})
    st2, asis = c.req("GET", "/asistencias", token=tb, params={"hoy": "true"})
    st3, sa = c.req("GET", "/jugadores/sin-asistencia-hoy", token=tb)
    check(st == 200 and b["ya_registrado"] is False and [a["origen"] for a in asis] == ["manual"] and sa == [],
          "marcar a mano registra origen 'manual' y sale de sin-asistencia-hoy", (b, asis, sa))

    pruebas_metricas(c, srv, tb)
    pruebas_umbrales(c, srv, F, ta, tb)
    pruebas_publica(c, srv, ta)
    pruebas_inscripcion(c, srv, F)


def pruebas_umbrales(c: Cliente, srv: Servidor, F: dict[str, bytes], ta: str, tb: str):
    """Zona gris + margen (aceptado / dudoso / rechazado), pendientes con sugerencia y `parecido`, registro de
    puntajes y /metricas/reconocimiento, compatibilidad con config antigua y aislamiento. Sede-u nueva; los puntajes
    reales se leen del registro y los umbrales se fijan por PUT /config alrededor de ellos."""
    print("\n== Zona gris + margen (sede-u)")
    # Los límites por IP de /verify/aviso y /verify/descartar ya se agotaron arriba: se reinicia (memoria limpia).
    srv.detener()
    srv.iniciar()
    db_u = srv.data_dir / "sedes" / "sede-u" / "asistencia.db"
    ruta_cfg = srv.data_dir / "sedes" / "sede-u" / "config.json"
    tu = c.req("POST", "/auth/login", data={"pin": PIN_U, "sede": "sede-u"})[1]["token"]

    def verify(nombre_foto=None, contenido=None):
        datos = contenido if contenido is not None else F[nombre_foto]
        return c.req("POST", "/verify", sede="sede-u", files={"file": ("k.jpg", datos, "image/jpeg")})

    def ultimo_log():
        with sqlite3.connect(db_u) as conn:
            conn.row_factory = sqlite3.Row
            return dict(conn.execute("SELECT * FROM verificaciones_log ORDER BY id DESC LIMIT 1").fetchone())

    def poner(umbral, duda):
        st, b = c.req("PUT", "/config", token=tu, json={"modelo": cfg0["modelo"], "detector": cfg0["detector"],
                                                       "umbral": round(umbral, 3), "umbral_duda": round(duda, 3)})
        assert st == 200, (st, b)
        return b

    def asistencias_u():
        return c.req("GET", "/asistencias", token=tu, params={"hoy": "true", "todas": "true"})[1]

    def esperar_log(campo, timeout=20):
        """La sombra completa la fila DESPUÉS de responder: espera a que aparezca `campo` en la última fila."""
        t0 = time.time()
        lg = ultimo_log()
        while lg.get(campo) is None and time.time() - t0 < timeout:
            time.sleep(0.3)
            lg = ultimo_log()
        return lg

    # -- compatibilidad: config antigua (solo `umbral`) = umbral de duda; automático = antiguo + 0.05
    legado = json.loads(ruta_cfg.read_text(encoding="utf-8"))
    st, cfg0 = c.req("GET", "/config", token=tu)
    check(st == 200 and "umbral_duda" not in legado and cfg0["umbral_duda"] == round(legado["umbral"], 3)
          and cfg0["umbral"] == round(legado["umbral"] + 0.05, 3) and cfg0["margen_min"] == 0.04,
          "config antigua sin umbral_duda: duda = antiguo, automático = antiguo + 0.05", (legado, cfg0))
    check("umbral_duda" not in json.loads(ruta_cfg.read_text(encoding="utf-8")), "leer la config no reescribe el archivo")
    st, ca = c.req("GET", "/config", token=ta)
    check(st == 200 and ca["umbral_duda"] <= ca["umbral"] and "margen_min" in ca, "GET /config refleja ambos umbrales", ca)

    st, b = c.req("PUT", "/config", token=tu, json={"modelo": cfg0["modelo"], "detector": cfg0["detector"],
                                                    "umbral": 0.40, "umbral_duda": 0.45})
    check(st == 400 and codigo(b) == "config_invalida", "PUT /config con umbral_duda > umbral -> 400", (st, b))

    # -- inscripción: A, B y una "gemela" de A (mismas fotos: dos jugadores distintos casi idénticos)
    def inscribir(nombre, nombres_fotos, forzar=False):
        st, b = c.req("POST", "/enroll", token=tu,
                      data={"nombre": nombre, "consentimiento": "true", "tutor": "Tutor U", "categoria": "Sub-10",
                            "forzar": "true" if forzar else "false"},
                      files=[("files", (n, F[n], "image/jpeg")) for n in nombres_fotos])
        assert st == 200, (st, b)
        return b["id"]
    id_a = inscribir("Ana Umbral", PERSONA_A[:3])
    id_b = inscribir("Beto Umbral", PERSONA_B[:2])

    # -- modo sombra: plantillas SFace del mismo recorte al inscribir; un jugador "antiguo" sin SFace sigue igual
    with sqlite3.connect(db_u) as conn:
        n_sf = dict(conn.execute("SELECT jugador_id, COUNT(*) FROM fotos WHERE modelo = 'SFace' "
                                 "GROUP BY jugador_id").fetchall())
    check(n_sf == {id_a: 3, id_b: 2}, "sombra: /enroll guarda una plantilla SFace por foto", n_sf)
    st, jl = c.req("GET", "/jugadores", token=tu)
    check(st == 200 and {j["id"]: j["fotos"] for j in jl} == {id_a: 3, id_b: 2},
          "sombra: las plantillas SFace no cuentan como fotos del modelo principal", jl)
    with sqlite3.connect(db_u) as conn:  # B pasa a ser un jugador inscrito antes del modo sombra
        conn.execute("DELETE FROM fotos WHERE jugador_id = ? AND modelo = 'SFace'", (id_b,))
    cat = next(x for x in c.req("GET", "/categorias", token=tu)[1] if x["nombre"] == "Sub-10")
    st, _ = c.req("PATCH", f"/categorias/{cat['id']}", token=tu, data={"nombre": "Sub-10"})  # recarga la caché
    check(st == 200, "recarga de la sede con un jugador sin plantilla SFace")

    # -- rechazado (umbrales altísimos): se lee el puntaje real de img10 contra A
    poner(0.99, 0.98)
    st, v = verify("img10.jpg")
    lg = ultimo_log()
    s1, s2 = lg["mejor_score"], lg["segundo_score"]
    check(st == 404 and codigo(v) == "no_reconocido" and set(v["detail"]) == {"codigo", "mensaje", "aviso"},
          "rechazado: 404 no_reconocido sin 'dudoso'", (st, v))
    check(lg["resultado"] == "rechazado" and lg["mejor_id"] == id_a and lg["segundo_id"] == id_b
          and s2 is not None and s1 > s2 and lg["umbral_auto"] == 0.99 and lg["umbral_duda"] == 0.98
          and lg["ms_total"] is not None and lg["modelo"] == cfg0["modelo"], "registro: mejor y segundo jugador distinto", lg)
    c.req("POST", "/verify/descartar", sede="sede-u", data={"aviso": v["detail"]["aviso"]})
    time.sleep(1.0)
    lg = ultimo_log()
    check(lg["score_sface"] is None and lg["score_cliente"] is None,
          "sombra: rechazado claro (fuera de zona gris) no calcula SFace", lg)

    # -- dudoso por zona gris: duda <= score < automático
    poner(min(s1 + 0.03, 0.99), s1 - 0.03)
    st, v = verify("img10.jpg")
    texto = json.dumps(v, ensure_ascii=False)
    check(st == 404 and codigo(v) == "no_reconocido" and v["detail"].get("dudoso") is True
          and set(v["detail"]) == {"codigo", "mensaje", "aviso", "dudoso"} and "Ana" not in texto
          and "similitud" not in texto, "zona gris: 404 no_reconocido con dudoso=true, sin nombre ni puntaje", (st, v))
    check(ultimo_log()["resultado"] == "dudoso", "registro: dudoso")
    lg = esperar_log("score_sface")
    fus = 0.6 * lg["mejor_score"] / lg["umbral_duda"] + 0.4 * (lg["score_sface"] or 0) / 0.47
    check(lg["resultado"] == "dudoso" and lg["candidato_sface"] == id_a and lg["sface_coincide"] == 1
          and lg["fusion_score"] is not None and abs(lg["fusion_score"] - fus) < 2e-3 and lg["score_cliente"] is None,
          "sombra: zona gris -> SFace del mismo recorte (coincide con el candidato y fusión ponderada)", lg)
    st, pend = c.req("GET", "/pendientes", token=tu)
    check(pend == [] and asistencias_u() == [], "dudoso NO crea pendiente ni asistencia (antes del aviso)", pend)
    st, n0 = c.req("GET", "/pendientes/novedades", token=tu)
    st, b = c.req("POST", "/verify/aviso", sede="sede-a", data={"aviso": v["detail"]["aviso"], "tipo": "entrenador"})
    check(st == 404, "aislamiento: el aviso dudoso de sede-u no sirve en sede-a", (st, b))
    st, b = c.req("POST", "/verify/aviso", sede="sede-u", data={"aviso": v["detail"]["aviso"], "tipo": "entrenador"})
    st2, pend = c.req("GET", "/pendientes", token=tu)
    p = pend[0] if pend else {}
    check(st == 200 and len(pend) == 1 and p["motivo"] == "no_reconocido" and (p["sugerido"] or {}).get("id") == id_a
          and p["parecido"] == "medio", "aviso -> pendiente con sugerido y parecido 'medio'", pend)
    st, n1 = c.req("GET", "/pendientes/novedades", token=tu, params={"desde": str(n0["ultimo_id"])})
    check(st == 200 and n1["nuevos"] and n1["nuevos"][0]["parecido"] == "medio"
          and n1["nuevos"][0]["sugerido"]["id"] == id_a, "novedades trae parecido (aditivo)", n1)
    check(asistencias_u() == [], "el aviso del dudoso tampoco crea asistencia")
    st, pb = c.req("GET", "/pendientes", token=tb)
    check(st == 200 and pb == [], "aislamiento: sede-b no ve el pendiente dudoso de sede-u", pb)
    c.req("DELETE", f"/pendientes/{p.get('id')}", token=tu)

    # -- rechazado con candidato sugerible -> parecido 'bajo'
    poner(min(s1 + 0.06, 0.99), s1 + 0.03)
    st, v = verify("img10.jpg")
    check(st == 404 and "dudoso" not in v["detail"] and ultimo_log()["resultado"] == "rechazado",
          "score < umbral_duda: rechazado", (st, v))
    c.req("POST", "/verify/aviso", sede="sede-u", data={"aviso": v["detail"]["aviso"], "tipo": "entrenador"})
    st, pend = c.req("GET", "/pendientes", token=tu)
    check(len(pend) == 1 and (pend[0]["sugerido"] or {}).get("id") == id_a and pend[0]["parecido"] == "bajo",
          "rechazado con sugerido -> parecido 'bajo'", pend)
    c.req("DELETE", f"/pendientes/{pend[0]['id']}", token=tu) if pend else None

    # -- dudoso por margen: score >= automático pero la "gemela" (otro jugador) está igual de cerca
    poner(cfg0["umbral"], cfg0["umbral_duda"])  # la coherencia de fotos al inscribir usa el umbral de duda
    id_g = inscribir("Ana Gemela", PERSONA_A[:3], forzar=True)
    poner(s1 - 0.05, s1 - 0.10)
    st, v = verify("img10.jpg")
    lg = ultimo_log()
    check(st == 404 and v["detail"].get("dudoso") is True and lg["resultado"] == "dudoso"
          and {lg["mejor_id"], lg["segundo_id"]} == {id_a, id_g} and lg["mejor_score"] - lg["segundo_score"] < 0.04
          and lg["mejor_score"] >= lg["umbral_auto"], "margen insuficiente entre dos jugadores parecidos -> dudoso", (v, lg))
    st, pend = c.req("GET", "/pendientes", token=tu)
    check(pend == [] and asistencias_u() == [], "dudoso por margen: nada hasta el aviso o el abandono", pend)
    t0, pend = time.time(), []
    while time.time() - t0 < AVISO_TTL_S + 25 and not pend:
        time.sleep(2)
        pend = c.req("GET", "/pendientes", token=tu)[1]
    check(len(pend) == 1 and pend[0]["motivo"] == "no_reconocido" and pend[0]["parecido"] == "alto"
          and (pend[0]["sugerido"] or {}).get("id") in (id_a, id_g), "abandono -> pendiente con parecido 'alto'", pend)
    check(asistencias_u() == [], "el abandono del dudoso no registra asistencia")

    # -- aceptado: sin la gemela, score >= automático y margen amplio contra B
    st, _ = c.req("DELETE", f"/jugadores/{id_g}", token=tu)
    st, v = verify("img10.jpg")
    lg = ultimo_log()
    check(st == 200 and v["nombre"] == "Ana" and v["ya_registrado"] is False and lg["resultado"] == "aceptado"
          and lg["mejor_id"] == id_a and lg["segundo_id"] == id_b, "aceptado con score alto y margen", (st, v, lg))
    with sqlite3.connect(db_u) as conn:
        filas = conn.execute("SELECT origen, similitud FROM asistencia WHERE jugador_id = ?", (id_a,)).fetchall()
    check(len(filas) == 1 and filas[0][0] == "facial" and filas[0][1] is not None
          and abs(filas[0][1] - lg["mejor_score"]) < 1e-3, "asistencia automática guarda la similitud", filas)
    st, v = verify("img10.jpg")
    check(st == 200 and v["ya_registrado"] is True, "segundo aceptado: ya registrado", (st, v))

    # -- sin cara
    import numpy as np
    ok, gris = cv2.imencode(".jpg", np.full((480, 640, 3), 128, np.uint8))
    st, v = verify(contenido=gris.tobytes())
    check(st == 422 and codigo(v) == "sin_rostro" and ultimo_log()["resultado"] == "sin_cara", "sin cara -> log sin_cara", (st, v))

    # -- registro sin biometría y PUT sin umbral_duda conserva el actual
    with sqlite3.connect(db_u) as conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(verificaciones_log)")}
    check(cols == {"id", "ts", "resultado", "mejor_id", "mejor_score", "segundo_id", "segundo_score", "umbral_auto",
                   "umbral_duda", "modelo", "detector", "ms_total", "ms_deteccion", "score_sface", "candidato_sface",
                   "fusion_score", "sface_coincide", "score_cliente", "ms_cliente", "staff_id"},
          "verificaciones_log sin biometría (solo números e ids, también las columnas sombra)", cols)
    st, cfg1 = c.req("GET", "/config", token=tu)
    st, b = c.req("PUT", "/config", token=tu, json={"modelo": cfg0["modelo"], "detector": cfg0["detector"],
                                                    "umbral": cfg1["umbral"]})
    check(st == 200 and b["umbral_duda"] == cfg1["umbral_duda"] and b["umbral"] == cfg1["umbral"],
          "PUT /config sin umbral_duda conserva el actual", (cfg1, b))
    archivo = json.loads(ruta_cfg.read_text(encoding="utf-8"))
    check(archivo.get("umbral_duda") == cfg1["umbral_duda"], "tras un PUT la config guarda ambos umbrales", archivo)

    # -- /metricas/reconocimiento
    print("\n== /metricas/reconocimiento")
    st, m = c.req("GET", "/metricas/reconocimiento", token=tu, params={"dias": "30"})
    check(st == 200 and (m["total"], m["aceptados"], m["dudosos"], m["rechazados"], m["sin_cara"]) == (6, 2, 2, 2, 1)
          and m["tasa_auto"] == round(2 / 6, 4), "conteos por resultado (sin_cara aparte)", m)
    check(all(sum(m["histograma"][k]) == m[k] for k in ("aceptados", "dudosos", "rechazados"))
          and len(m["histograma"]["aceptados"]) == 20 and m["tramos"][1] == 0.05, "histograma por tramos de 0.05", m["histograma"])
    check(m["margen_mediano_aceptados"] is not None and m["margen_mediano_aceptados"] >= 0.04
          and m["umbrales"] == {"auto": cfg1["umbral"], "duda": cfg1["umbral_duda"], "margen_min": 0.04}
          and m["sugerencia"] == "aún pocos datos (<30 verificaciones)", "margen mediano, umbrales y sugerencia", m)
    with sqlite3.connect(db_u) as conn:
        ahora = datetime.now().isoformat(sep=" ", timespec="seconds")
        conn.executemany("INSERT INTO verificaciones_log (ts, resultado, mejor_score, segundo_score) VALUES (?, ?, ?, ?)",
                         [(ahora, "dudoso", 0.40, 0.38)] * 40)
        conn.execute("INSERT INTO verificaciones_log (ts, resultado, mejor_score) VALUES (?, 'aceptado', 0.9)",
                     ((datetime.now() - timedelta(days=100)).isoformat(sep=" ", timespec="seconds"),))
    st, m = c.req("GET", "/metricas/reconocimiento", token=tu)
    with sqlite3.connect(db_u) as conn:
        viejas = conn.execute("SELECT COUNT(*) FROM verificaciones_log WHERE ts < ?",
                              ((datetime.now() - timedelta(days=90)).isoformat(sep=" ", timespec="seconds"),)).fetchone()[0]
    check(st == 200 and m["total"] == 46 and m["dudosos"] == 42 and "dudosos" in m["sugerencia"] and viejas == 0,
          "con datos: sugerencia por muchos dudosos; retención 90 días", (m.get("sugerencia"), viejas))
    st, b = c.req("GET", "/metricas/reconocimiento", token=tu, params={"dias": "0"})
    check(st == 422 and c.req("GET", "/metricas/reconocimiento")[0] == 401, "dias inválido -> 422; sin staff -> 401", st)
    st, mb = c.req("GET", "/metricas/reconocimiento", token=tb)
    st2, ma = c.req("GET", "/metricas/reconocimiento", token=ta)
    db_a = srv.data_dir / "sedes" / "sede-a" / "asistencia.db"
    with sqlite3.connect(db_a) as conn:
        n_a = conn.execute("SELECT COUNT(*) FROM verificaciones_log WHERE resultado IN "
                           "('aceptado', 'dudoso', 'rechazado')").fetchone()[0]
    check(st == 200 and mb["total"] == 0 and st2 == 200 and ma["total"] == n_a > 0,
          "aislamiento: cada sede ve solo su registro", (mb.get("total"), ma.get("total"), n_a))

    # -- modo sombra: cara recortada en el celular (campo `cara` de /verify). Va al final: suma filas al registro.
    print("\n== Modo sombra: `cara` recortada en el celular (sede-u)")
    cara = recorte_cara(F["img10.jpg"])
    st0, v0 = verify("img10.jpg")
    st, v = c.req("POST", "/verify", sede="sede-u", files={"file": ("k.jpg", F["img10.jpg"], "image/jpeg"),
                                                         "cara": ("c.jpg", cara, "image/jpeg")})
    lg = esperar_log("score_cliente")
    check(st == st0 == 200 and v["nombre"] == "Ana" and set(v) == set(v0) and v["ya_registrado"] is True,
          "con `cara`: la respuesta y el veredicto no cambian", (st, v))
    check(lg["resultado"] == "aceptado" and lg["mejor_id"] == id_a and lg["score_cliente"] is not None
          and -1 <= lg["score_cliente"] <= 1 and lg["ms_cliente"] is not None and lg["ms_cliente"] >= 0,
          "con `cara`: score_cliente (mismo candidato) y ms_cliente registrados", lg)
    import numpy as np
    ok, png = cv2.imencode(".png", cv2.imdecode(np.frombuffer(cara, np.uint8), cv2.IMREAD_COLOR))
    ok, grande = cv2.imencode(".jpg", np.full((900, 900, 3), 90, np.uint8))
    ok, chica = cv2.imencode(".jpg", np.full((32, 32, 3), 90, np.uint8))
    malas = {"png": (png.tobytes(), "image/png"), "lado > 320": (grande.tobytes(), "image/jpeg"),
             "lado < 64": (chica.tobytes(), "image/jpeg"), "no es imagen": (b"hola", "image/jpeg"),
             "> 64 KB": (b"\xff\xd8" + os.urandom(70 * 1024), "image/jpeg")}
    estados = {}
    for nombre_mala, (datos, tipo) in malas.items():
        st, v = c.req("POST", "/verify", sede="sede-u", files={"file": ("k.jpg", F["img10.jpg"], "image/jpeg"),
                                                             "cara": ("c", datos, tipo)})
        time.sleep(0.8)
        estados[nombre_mala] = (st, v.get("nombre") if isinstance(v, dict) else v, ultimo_log()["score_cliente"])
    check(all(e == (200, "Ana", None) for e in estados.values()),
          "`cara` inválida (png, tamaño, lados, basura): se ignora sin afectar /verify", estados)
    st, v = c.req("POST", "/verify", sede="sede-u", files={"file": ("k.jpg", F["img10.jpg"], "image/jpeg")},
                  data={"cara": "texto"})
    check(st == 200 and v["nombre"] == "Ana", "`cara` como campo de texto: se ignora", (st, v))

    # -- modo sombra: corrección del staff enlazada a la verificación y sección "ensemble" de las métricas
    print("\n== Modo sombra: corrección del staff y métricas del ensemble")
    poner(min(s1 + 0.03, 0.99), s1 - 0.03)
    st, v = verify("img10.jpg")
    lg = esperar_log("score_sface")
    check(st == 404 and v["detail"].get("dudoso") is True and lg["score_sface"] is not None, "dudoso con dato SFace", lg)
    c.req("POST", "/verify/aviso", sede="sede-u", data={"aviso": v["detail"]["aviso"], "tipo": "entrenador"})
    pend = c.req("GET", "/pendientes", token=tu)[1]
    with sqlite3.connect(db_u) as conn:
        vid_p = conn.execute("SELECT verificacion_id FROM pendientes WHERE id = ?", (pend[0]["id"],)).fetchone()[0]
    st, asg = c.req("POST", f"/pendientes/{pend[0]['id']}/asignar", token=tu, data={"jugador_id": id_b})
    with sqlite3.connect(db_u) as conn:
        staff = conn.execute("SELECT staff_id FROM verificaciones_log WHERE id = ?", (lg["id"],)).fetchone()[0]
    check(vid_p == lg["id"] and st == 200 and staff == id_b,
          "el pendiente recuerda su verificación y la asignación del staff queda en staff_id", (vid_p, lg["id"], staff))
    with sqlite3.connect(db_u) as conn:
        cands = {r[0] for r in conn.execute("SELECT candidato_sface FROM verificaciones_log "
                                            "WHERE candidato_sface IS NOT NULL")}
        conn.execute("INSERT INTO verificaciones_log (ts, resultado, mejor_id, mejor_score, score_sface, candidato_sface, "
                     "sface_coincide, fusion_score, staff_id) VALUES (?, 'dudoso', ?, 0.40, 0.50, ?, 0, 0.9, ?)",
                     (datetime.now().isoformat(sep=" ", timespec="seconds"), id_a, id_b, id_b))
        filas = conn.execute("SELECT mejor_id, candidato_sface, sface_coincide, staff_id FROM verificaciones_log "
                             "WHERE score_sface IS NOT NULL").fetchall()
        n_cli = conn.execute("SELECT COUNT(*) FROM verificaciones_log WHERE score_cliente IS NOT NULL").fetchone()[0]
    check(id_b not in cands, "SFace nunca propone a un jugador sin plantilla SFace (inscrito antes)", cands)
    corr = [f for f in filas if f[3] is not None and f[0] is not None and f[3] != f[0]]
    esperado = {"modelo": "SFace", "n": len(filas),
                "coincide_pct": round(100 * sum(1 for f in filas if f[2] == 1) / len(filas), 1),
                "con_decision_staff": sum(1 for f in filas if f[3] is not None),
                "staff_confirmo_primario": sum(1 for f in filas if f[3] is not None and f[3] == f[0]),
                "staff_corrigio_primario": len(corr), "sface_habria_acertado": sum(1 for f in corr if f[1] == f[3])}
    st, m = c.req("GET", "/metricas/reconocimiento", token=tu)
    ens = {k: v for k, v in (m.get("ensemble") or {}).items() if k != "fusion_mediana"}
    check(st == 200 and ens == esperado and esperado["n"] >= 3 and esperado["staff_corrigio_primario"] >= 2
          and esperado["sface_habria_acertado"] >= 1 and m["ensemble"]["fusion_mediana"] is not None,
          "/metricas/reconocimiento: sección ensemble (n, % coincide, correcciones del staff, SFace habría acertado)",
          (m.get("ensemble"), esperado))
    rc = m.get("recorte_celular") or {}
    check(rc.get("n") == n_cli >= 1 and rc.get("ms_mediano") is not None and rc.get("diferencia_mediana") is not None,
          "/metricas/reconocimiento: sección recorte_celular", rc)
    st, mb = c.req("GET", "/metricas/reconocimiento", token=tb)
    check(mb["ensemble"]["n"] == 0 and mb["ensemble"]["coincide_pct"] is None and mb["recorte_celular"]["n"] == 0,
          "aislamiento: el ensemble de sede-u no aparece en sede-b", mb.get("ensemble"))


def pruebas_metricas(c: Cliente, srv: Servidor, tb: str):
    """/metricas/hoy y /metricas/resumen con datos conocidos sembrados por SQL en la sede-m (sin biometría)."""
    print("\n== Métricas (sede-m, datos conocidos)")
    hoy = datetime.now().date()
    d1, d2, d3, d0 = (hoy - timedelta(days=n) for n in (9, 6, 4, 2))  # d0: marcada sin asistencias
    f = lambda d: d.isoformat()  # noqa: E731
    ts = lambda d, hm: f"{d.isoformat()} {hm}:{7:02d}"  # noqa: E731
    db_m = srv.data_dir / "sedes" / "sede-m" / "asistencia.db"
    with sqlite3.connect(db_m) as conn:
        conn.execute("INSERT INTO categorias (nombre, orden) VALUES ('Sub-12', 2)")
        ids = {}
        for clave, nombre, cat, estado, alta in (
                ("A", "Ana A", "Sub-10", "activo", f"{f(d1 - timedelta(days=30))} 10:00:00"),
                ("B", "Beto B", "Sub-10", "activo", f"{f(d1 - timedelta(days=30))} 10:00:00"),
                ("C", "Cami C", "Sub-12", "activo", f"{f(d1 - timedelta(days=30))} 10:00:00"),
                ("D", "Dani D", "Sub-12", "activo", f"{f(d1 - timedelta(days=30))} 10:00:00"),
                ("N", "Nico N", "Sub-10", "activo", f"{f(d2)} 14:00:00"),
                ("G", "Gus G", "Sub-10", "invitado", f"{f(d1)} 15:00:00")):
            ids[clave] = conn.execute("INSERT INTO jugadores (nombre, embedding, categoria, creado_en, modelo, estado) "
                                      "VALUES (?, '[]', ?, ?, NULL, ?)", (nombre, cat, alta, estado)).lastrowid
        filas = [  # (jugador, fecha, hora, origen, estado)
            ("A", d1, "16:05", "facial", "valida"), ("B", d1, "16:20", "manual", "valida"),
            ("C", d1, "16:10", "facial", "valida"), ("G", d1, "16:15", "invitado", "valida"),
            ("A", d2, "16:00", "facial", "valida"), ("C", d2, "16:30", "correccion", "valida"),
            ("D", d2, "16:10", "facial", "valida"), ("N", d2, "16:40", "facial", "valida"),
            ("B", d2, "16:05", "manual", "anulada"),
            ("A", d3, "17:05", "facial", "valida"), ("G", d3, "16:10", "invitado", "valida"),
            ("C", d3, "16:10", "facial", "anulada"), ("D", d3, "16:12", "facial", "disputada"),
            # hoy
            ("A", hoy, "16:05", "facial", "valida"), ("N", hoy, "16:20", "manual", "valida"),
            ("G", hoy, "16:10", "invitado", "valida"), ("C", hoy, "16:00", "facial", "anulada"),
            ("D", hoy, "16:01", "facial", "disputada")]
        for k, d, hm, org, est in filas:
            conn.execute("INSERT INTO asistencia (jugador_id, timestamp, origen, estado) VALUES (?, ?, ?, ?)",
                         (ids[k], ts(d, hm), org, est))
        conn.execute("INSERT INTO sesiones (fecha, tipo) VALUES (?, 'partido')", (f(d0),))
    tm = c.req("POST", "/auth/login", data={"pin": PIN_M, "sede": "sede-m"})[1]["token"]

    st, h = c.req("GET", "/metricas/hoy", token=tm)
    check(st == 200 and h["fecha"] == f(hoy) and h["esperados"] == 5 and h["porcentaje"] == 40
          and h["llegaron"] == [{"id": ids["A"], "nombre": "Ana A", "categoria": "Sub-10", "hora": "16:05",
                                 "origen": "reconocimiento"},
                                {"id": ids["N"], "nombre": "Nico N", "categoria": "Sub-10", "hora": "16:20",
                                 "origen": "manual"}], "hoy: llegaron e inscritos (anulada/disputada no cuentan)", h)
    check([x["nombre"] for x in h["faltan"]] == ["Beto B", "Cami C", "Dani D"], "hoy: faltan (anulada y disputada = falta)", h["faltan"])
    check(h["invitados"] == [{"id": ids["G"], "nombre": "Gus G", "categoria": "Sub-10", "hora": "16:10"}]
          and h["ultima_llegada"] == "16:20", "hoy: invitado separado y última llegada", h)
    check(h["acumulado"] == [{"hora": "16:00", "total": 1}, {"hora": "16:15", "total": 2}]
          and h["por_revisar"] == {"pendientes": 0, "solicitudes": 0}, "hoy: curva acumulada y por revisar", h)
    st, h12 = c.req("GET", "/metricas/hoy", token=tm, params={"categoria": "sub-12"})
    check(st == 200 and h12["esperados"] == 2 and h12["llegaron"] == [] and h12["porcentaje"] == 0
          and [x["nombre"] for x in h12["faltan"]] == ["Cami C", "Dani D"] and h12["acumulado"] == []
          and h12["ultima_llegada"] is None, "hoy: filtro por categoría", h12)

    st, r = c.req("GET", "/metricas/resumen", token=tm, params={"desde": f(d1), "hasta": f(hoy)})
    jr = r["jornadas"]
    check(st == 200 and r["rango"] == {"desde": f(d1), "hasta": f(hoy), "categoria": None}
          and jr == [{"fecha": f(d1), "presentes": 3, "esperados": 4, "porcentaje": 75, "invitados": 1},
                     {"fecha": f(d2), "presentes": 4, "esperados": 5, "porcentaje": 80, "invitados": 0},
                     {"fecha": f(d3), "presentes": 1, "esperados": 5, "porcentaje": 20, "invitados": 1},
                     {"fecha": f(d0), "presentes": 0, "esperados": 5, "porcentaje": 0, "invitados": 0}],
          "resumen: jornadas (marcada sin asistencias cuenta; hoy y anuladas/disputadas no; invitados aparte)", jr)
    check(r["totales"] == {"ninos_activos": 5, "jornadas": 4, "promedio_asistencia": 44,
                           "mejor_jornada": {"fecha": f(d2), "porcentaje": 80},
                           "peor_jornada": {"fecha": f(d0), "porcentaje": 0}}, "resumen: totales", r["totales"])
    n = {x["nombre"]: x for x in r["ninos"]}
    check([x["nombre"] for x in r["ninos"]] == ["Ana A", "Beto B", "Cami C", "Dani D", "Nico N"], "resumen: ninos sin invitados, por nombre")
    a, b, nn = n["Ana A"], n["Beto B"], n["Nico N"]
    check((a["presentes"], a["jornadas_total"], a["porcentaje"], a["racha_actual"], a["faltas_seguidas"]) == (3, 4, 75, 1, 0)
          and a["ultima_asistencia"] == f(hoy) and a["dias"] == {f(d1): "presente", f(d2): "presente", f(d3): "presente", f(d0): "ausente"},
          "resumen: niño A (llegó hoy tras 1 falta: faltas 0, racha incluye hoy)", a)
    check((b["presentes"], b["porcentaje"], b["faltas_seguidas"], b["ultima_asistencia"]) == (1, 25, 3, f(d1)),
          "resumen: niño B (anulada no cuenta)", b)
    check((nn["jornadas_total"], nn["presentes"], nn["porcentaje"], nn["faltas_seguidas"]) == (3, 1, 33, 0)
          and f(d1) not in nn["dias"], "resumen: inscrito después no figura ausente antes", nn)
    check(n["Dani D"]["presentes"] == 1 and n["Dani D"]["dias"][f(d3)] == "ausente", "resumen: disputada = ausente", n["Dani D"])
    check(r["en_riesgo"] == [{"id": ids["B"], "nombre": "Beto B", "categoria": "Sub-10", "faltas_seguidas": 3}],
          "resumen: en_riesgo (>=3 faltas seguidas)", r["en_riesgo"])
    check(r["categorias"] == [{"categoria": "Sub-10", "presentes": 5, "esperados": 11, "ninos": 3, "porcentaje": 45},
                              {"categoria": "Sub-12", "presentes": 3, "esperados": 8, "ninos": 2, "porcentaje": 38}],
          "resumen: por categoría", r["categorias"])
    check(r["metodos"] == {"reconocimiento": 6, "manual": 1, "correccion": 1, "invitado": 2}, "resumen: métodos", r["metodos"])
    check(r["llegada"] == {"histograma": [{"hora": "16:00", "cantidad": 7}, {"hora": "17:00", "cantidad": 1}],
                           "mediana": "16:15"}, "resumen: llegada (histograma y mediana, solo inscritos)", r["llegada"])

    st, r10 = c.req("GET", "/metricas/resumen", token=tm, params={"desde": f(d1), "hasta": f(hoy), "categoria": "Sub-10"})
    check(st == 200 and r10["rango"]["categoria"] == "Sub-10" and r10["totales"]["ninos_activos"] == 3
          and [(j["presentes"], j["esperados"], j["porcentaje"]) for j in r10["jornadas"]] == [(2, 2, 100), (2, 3, 67), (1, 3, 33), (0, 3, 0)]
          and r10["metodos"] == {"reconocimiento": 4, "manual": 1, "correccion": 0, "invitado": 2}
          and [x["categoria"] for x in r10["categorias"]] == ["Sub-10"], "resumen: filtro por categoría", r10)
    st, rr = c.req("GET", "/metricas/resumen", token=tm, params={"desde": f(d2), "hasta": f(d3)})
    check(st == 200 and [j["fecha"] for j in rr["jornadas"]] == [f(d2), f(d3)] and rr["totales"]["jornadas"] == 2,
          "resumen: rango con extremos inclusivos", rr["jornadas"])
    st, r1 = c.req("GET", "/metricas/resumen", token=tm, params={"desde": f(d3), "hasta": f(d3)})
    check(st == 200 and [j["fecha"] for j in r1["jornadas"]] == [f(d3)], "resumen: rango de un solo día", r1["jornadas"])
    st, rv = c.req("GET", "/metricas/resumen", token=tm, params={"desde": f(hoy + timedelta(days=5)), "hasta": f(hoy + timedelta(days=9))})
    check(st == 200 and rv["jornadas"] == [] and rv["totales"]["mejor_jornada"] is None
          and rv["llegada"]["mediana"] is None, "resumen: rango sin jornadas", rv["totales"])
    st, rd = c.req("GET", "/metricas/resumen", token=tm)
    check(st == 200 and rd["rango"]["hasta"] == f(hoy) and rd["rango"]["desde"] == f(hoy - timedelta(days=59))
          and rd["totales"]["jornadas"] == 4, "resumen: rango por defecto (60 días)", rd["rango"])
    st, b1 = c.req("GET", "/metricas/resumen", token=tm, params={"desde": f(hoy - timedelta(days=365)), "hasta": f(hoy)})
    st2, b2 = c.req("GET", "/metricas/resumen", token=tm, params={"desde": f(hoy - timedelta(days=366)), "hasta": f(hoy)})
    st3, b3 = c.req("GET", "/metricas/resumen", token=tm, params={"desde": f(hoy), "hasta": f(d1)})
    st4, b4 = c.req("GET", "/metricas/resumen", token=tm, params={"desde": "ayer"})
    st5, b5 = c.req("GET", "/metricas/resumen", token=tm, params={"categoria": "Nope"})
    check(st == 200 and st2 == 400 and codigo(b2) == "rango_largo" and st3 == 400 and codigo(b3) == "rango_invalido"
          and st4 == 400 and codigo(b4) == "fecha_invalida" and st5 == 404 and codigo(b5) == "categoria_no_existe",
          "resumen: límites (366 días ok, 367 no, orden, fecha, categoría)", (st, st2, st3, st4, st5))
    check(c.req("GET", "/metricas/hoy")[0] == 401 and c.req("GET", "/metricas/resumen")[0] == 401,
          "métricas exigen sesión de staff")

    st, hb = c.req("GET", "/metricas/hoy", token=tb)
    st2, rb = c.req("GET", "/metricas/resumen", token=tb, params={"desde": f(d1), "hasta": f(hoy)})
    nombres_m = {"Ana A", "Beto B", "Cami C", "Dani D", "Nico N", "Gus G"}
    vistos_b = {x["nombre"] for k in ("llegaron", "faltan", "invitados") for x in hb[k]} | {x["nombre"] for x in rb["ninos"]}
    check(st == 200 and st2 == 200 and not (vistos_b & nombres_m),
          "aislamiento: la sede B no ve datos de la sede M", vistos_b)

    # Regla de hoy: quien llegó hoy tras 3 faltas no está en riesgo; quien aún no llega, sí (hoy no cuenta como falta).
    sys.path.insert(0, str(ROOT))
    from src import metricas as _mh
    from src.db_manager import Base as _Base
    import tempfile as _tfh
    with _tfh.TemporaryDirectory() as td:
        bh = _Base(Path(td) / "asistencia.db")
        bh.init_db()
        with bh.conexion() as conn:
            alta = f"{f(hoy - timedelta(days=60))} 09:00:00"
            idh = {k: conn.execute("INSERT INTO jugadores (nombre, embedding, categoria, creado_en, modelo, estado) "
                                   "VALUES (?, '[]', 'Sub-10', ?, NULL, 'activo')", (k, alta)).lastrowid
                   for k in ("Llegó hoy", "Sin llegar", "Constante")}
            for k in (5, 4, 3):  # jornadas cerradas: solo "Constante" asiste
                conn.execute("INSERT INTO asistencia (jugador_id, timestamp, origen) VALUES (?, ?, 'facial')",
                             (idh["Constante"], f"{f(hoy - timedelta(days=k))} 16:00:00"))
            for k in ("Llegó hoy", "Constante"):
                conn.execute("INSERT INTO asistencia (jugador_id, timestamp, origen) VALUES (?, ?, 'facial')",
                             (idh[k], f"{f(hoy)} 16:00:00"))
        rh = _mh.resumen(bh, f(hoy - timedelta(days=10)), f(hoy))
        nh = {x["nombre"]: x for x in rh["ninos"]}
        check((nh["Llegó hoy"]["faltas_seguidas"], nh["Llegó hoy"]["racha_actual"], nh["Llegó hoy"]["ultima_asistencia"])
              == (0, 1, f(hoy)), "hoy: niño que llegó hoy tras 3 faltas -> faltas 0, racha incluye hoy", nh["Llegó hoy"])
        check((nh["Sin llegar"]["faltas_seguidas"], nh["Sin llegar"]["racha_actual"]) == (3, 0),
              "hoy: niño que aún no llega -> 3 faltas (hoy no cuenta)", nh["Sin llegar"])
        check((nh["Constante"]["faltas_seguidas"], nh["Constante"]["racha_actual"]) == (0, 4),
              "hoy: racha de quien llegó = cerradas + hoy", nh["Constante"])
        check([x["nombre"] for x in rh["en_riesgo"]] == ["Sin llegar"] and len(rh["jornadas"]) == 3,
              "hoy: en_riesgo excluye a quien llegó hoy; jornadas sin hoy", rh["en_riesgo"])

    # Rendimiento: 300 niños x 60 jornadas directo sobre una base temporal (sin API).
    sys.path.insert(0, str(ROOT))
    from src import metricas as _m
    from src.db_manager import Base
    import random
    import tempfile as _tf
    with _tf.TemporaryDirectory() as td:
        base = Base(Path(td) / "asistencia.db")
        base.init_db()
        rng = random.Random(1)
        with base.conexion() as conn:
            for i in range(300):
                conn.execute("INSERT INTO jugadores (nombre, embedding, categoria, creado_en, modelo, estado) "
                             "VALUES (?, '[]', ?, ?, NULL, 'activo')",
                             (f"Niño {i:03d}", ("Sub-10", "Sub-12", "Sub-8")[i % 3], f"{f(hoy - timedelta(days=120))} 09:00:00"))
            for j in range(1, 301):
                for k in range(1, 61):
                    if rng.random() < 0.8:
                        conn.execute("INSERT INTO asistencia (jugador_id, timestamp, origen) VALUES (?, ?, 'facial')",
                                     (j, f"{f(hoy - timedelta(days=k))} 16:{rng.randint(0, 40):02d}:00"))
        t0 = time.perf_counter()
        rp = _m.resumen(base, f(hoy - timedelta(days=59)), f(hoy))
        dt = (time.perf_counter() - t0) * 1000
        check(len(rp["ninos"]) == 300 and len(rp["jornadas"]) == 59,
              "rendimiento: 300 niños x 60 jornadas devuelve todo", (len(rp["ninos"]), len(rp["jornadas"])))
        check(dt < 300, f"rendimiento: resumen en {dt:.0f} ms (< 300 ms)", dt)

    pruebas_alertas_revision(c, srv, tm, ids, f, hoy)
    pruebas_exportes(c, srv, tm, f, hoy)


def pruebas_alertas_revision(c: Cliente, srv: Servidor, tm: str, ids: dict, f, hoy):
    """Alertas de faltas seguidas (tabla `alertas`) y revisión de asistencias faciales, sobre la sede-m sembrada en
    pruebas_metricas (solo agrega asistencias de HOY para no cambiar las columnas de los exportes)."""
    print("\n== Alertas: 3 faltas seguidas (sede-m)")
    db_m = srv.data_dir / "sedes" / "sede-m" / "asistencia.db"
    st, al = c.req("GET", "/alertas", token=tm)
    lista = al.get("alertas", []) if isinstance(al, dict) else []
    # Sub-10: jornadas d1, d2, d3 + d0 marcada -> Beto (última válida d1) = 3. Sub-12: d3 no fue jornada de su
    # categoría (C anulada, D disputada) -> Cami/Dani = 1 (solo d0). Ana y Nico llegaron hoy.
    check(st == 200 and al["umbral"] == 3 and [(a["nombre"], a["valor"], a["estado"]) for a in lista]
          == [("Beto B", 3, "nueva")], "alerta creada solo para Beto (faltas por jornadas de su categoría)", al)
    check(st == 200 and lista and set(lista[0]) >= {"id", "jugador_id", "nombre", "categoria", "tipo", "valor",
                                                    "estado", "nota", "creada_en", "ultima_asistencia", "contacto"}
          and lista[0]["tipo"] == "faltas_seguidas" and lista[0]["ultima_asistencia"] == f(hoy - timedelta(days=9)),
          "alerta con nombre, categoría, faltas, última asistencia y contacto", lista[:1])
    c.req("GET", "/alertas", token=tm)
    c.req("GET", "/metricas/hoy", token=tm)
    with sqlite3.connect(db_m) as conn:
        n = conn.execute("SELECT COUNT(*) FROM alertas WHERE jugador_id = ?", (ids["B"],)).fetchone()[0]
    check(n == 1, "evaluar varias veces es idempotente (una sola alerta)", n)
    st, h = c.req("GET", "/metricas/hoy", token=tm)
    check(st == 200 and h.get("alertas") == {"abiertas": 1, "por_contactar": 1}, "/metricas/hoy trae el conteo de alertas",
          h.get("alertas"))
    st, rs = c.req("GET", "/alertas/resumen", token=tm)
    check(st == 200 and rs == {"abiertas": 1, "por_contactar": 1}, "/alertas/resumen", rs)

    aid = lista[0]["id"] if lista else 0
    st, p = c.req("PATCH", f"/alertas/{aid}", token=tm, data={"estado": "contactada", "nota": "  Llamé a la mamá  "})
    check(st == 200 and p["estado"] == "contactada" and p["nota"] == "Llamé a la mamá" and p["actualizada_por"] == "staff"
          and p["actualizada_en"], "PATCH estado y nota", (st, p))
    st, rs = c.req("GET", "/alertas/resumen", token=tm)
    check(rs == {"abiertas": 1, "por_contactar": 0}, "contactada sigue abierta pero ya no 'por contactar'", rs)
    st1, b1 = c.req("PATCH", f"/alertas/{aid}", token=tm, data={"estado": "borrada"})
    st2, _ = c.req("PATCH", "/alertas/999999", token=tm, data={"estado": "vista"})
    st3, _ = c.req("PATCH", f"/alertas/{aid}", token=tm)
    st4, _ = c.req("PATCH", f"/alertas/{aid}", data={"estado": "vista"})
    check((st1, codigo(b1), st2, st3, st4) == (400, "estado_invalido", 404, 400, 401),
          "PATCH: estado inválido 400, inexistente 404, sin cambios 400, sin sesión 401", (st1, b1, st2, st3, st4))
    with sqlite3.connect(db_m) as conn:  # (Beto se sembró por SQL: la API no lo tiene en caché para /asistencia/manual)
        conn.execute("INSERT INTO asistencia (jugador_id, timestamp, origen) VALUES (?, ?, 'manual')",
                     (ids["B"], datetime.now().isoformat(sep=" ", timespec="seconds")))
    st, al2 = c.req("GET", "/alertas", token=tm)  # evalúa: asistió después de crearse -> se cierra
    with sqlite3.connect(db_m) as conn:
        cerr = conn.execute("SELECT estado, motivo_cierre, nota FROM alertas WHERE id = ?", (aid,)).fetchone()
    check(cerr == ("cerrada", "asistio", "Llamé a la mamá") and al2["alertas"] == [],
          "al asistir la alerta se cierra sola (conserva la nota)", (cerr, al2))
    st, alc = c.req("GET", "/alertas", token=tm, params={"cerradas": "true"})
    check(st == 200 and [a["id"] for a in alc["alertas"]] == [aid], "cerradas=true lista también las cerradas", alc)

    print("\n== Alertas: lógica directa (umbral, cierre del staff, anulación, idempotencia)")
    sys.path.insert(0, str(ROOT))
    from src.db_manager import Base as _B
    import tempfile as _t
    with _t.TemporaryDirectory() as td:
        b = _B(Path(td) / "asistencia.db")
        b.init_db()
        alta = f"{f(hoy - timedelta(days=60))} 09:00:00"
        with b.conexion() as conn:
            j = {k: conn.execute("INSERT INTO jugadores (nombre, embedding, categoria, creado_en, estado) "
                                 "VALUES (?, '[]', ?, ?, ?)", (k, cat, alta, est)).lastrowid
                 for k, cat, est in (("Falta", "Sub-8", "activo"), ("Va", "Sub-8", "activo"),
                                     ("Otra cat", "Sub-14", "activo"), ("Inv", "Sub-8", "invitado"))}
            for d in (6, 5, 4, 3, 2):  # Sub-8 entrena 5 días; "Falta" solo fue el primero
                conn.execute("INSERT INTO asistencia (jugador_id, timestamp, origen) VALUES (?, ?, 'facial')",
                             (j["Va"], f"{f(hoy - timedelta(days=d))} 16:00:00"))
            conn.execute("INSERT INTO asistencia (jugador_id, timestamp, origen) VALUES (?, ?, 'facial')",
                         (j["Falta"], f"{f(hoy - timedelta(days=6))} 16:00:00"))
            conn.execute("INSERT INTO asistencia (jugador_id, timestamp, origen) VALUES (?, ?, 'facial')",
                         (j["Otra cat"], f"{f(hoy - timedelta(days=20))} 16:00:00"))
        r1 = b.evaluar_alertas(5)
        r2 = b.evaluar_alertas(4)
        nombres = lambda: [(a["nombre"], a["valor"]) for a in b.listar_alertas()]  # noqa: E731
        check(r1["creadas"] == 0 and r2["creadas"] == 1 and nombres() == [("Falta", 4)],
              "umbral configurable: 4 faltas no alertan con umbral 5 y sí con 4; otra categoría sin jornadas = 0 faltas",
              (r1, r2, nombres()))
        check(b.evaluar_alertas(4)["creadas"] == 0 and len(b.listar_alertas()) == 1, "re-evaluar no duplica")
        a = b.listar_alertas()[0]
        b.actualizar_alerta(a["id"], "cerrada", "no contesta")
        check(b.evaluar_alertas(4)["creadas"] == 0 and b.listar_alertas() == [],
              "cerrada por el staff: no se recrea en la misma racha")
        aid2 = b.registrar_asistencia(j["Falta"], origen="manual")
        b.anular_asistencia(aid2, "error")
        b.evaluar_alertas(4)
        check(b.listar_alertas() == [], "cerrada por el staff sigue cerrada aunque se anule una asistencia posterior")
        with b.conexion() as conn:  # racha nueva tras asistir: otra alerta
            conn.execute("UPDATE alertas SET creada_en = '2000-01-01 00:00:00'")
        b.evaluar_alertas(4)
        check(nombres() == [("Falta", 4)], "racha nueva (alerta anterior a su última asistencia) -> alerta nueva", nombres())
        aid3 = b.registrar_asistencia(j["Falta"], origen="facial", similitud=0.9)
        check(b.listar_alertas() == [], "registrar asistencia cierra la alerta al instante")
        b.anular_asistencia(aid3, "no era")
        b.evaluar_alertas(4)
        check(nombres() == [("Falta", 4)], "si se anula la asistencia que la cerró, la alerta se reabre", nombres())

    print("\n== Revisión de la tanda (sede-m)")
    st, cfg = c.req("GET", "/config", token=tm)
    lim = round(cfg["umbral"] + 0.05, 4)
    with sqlite3.connect(db_m) as conn:
        rid = {}
        for k, nombre, sim in (("R", "Rita R", cfg["umbral"] + 0.01), ("S", "Sol S", cfg["umbral"] + 0.2),
                               ("T", "Teo T", cfg["umbral"] + 0.02)):
            jid = conn.execute("INSERT INTO jugadores (nombre, embedding, categoria, creado_en, modelo, estado) "
                               "VALUES (?, '[]', 'Sub-10', ?, NULL, 'activo')",  # Sub-12 exacto en exportes
                               (nombre, f"{f(hoy - timedelta(days=40))} 10:00:00")).lastrowid
            rid[k] = conn.execute("INSERT INTO asistencia (jugador_id, timestamp, origen, similitud) VALUES "
                                  "(?, ?, 'facial', ?)", (jid, f"{f(hoy)} 16:3{len(rid)}:00", round(sim, 4))).lastrowid
    st, rv = c.req("GET", "/revision/hoy", token=tm)
    # Faciales válidas de hoy: Ana (sin similitud: legado = seguro), Rita y Teo (bajas), Sol (alta).
    check(st == 200 and rv["limite"] == lim and rv["total"] == 4 and rv["revisados"] == 0
          and rv["seguros_sin_revisar"] == 2 and [x["nombre"] for x in rv["por_revisar"]] == ["Rita R", "Teo T"],
          "revision/hoy: total, seguros y por revisar (similitud < automático + 0.05)", rv)
    st, cs = c.req("POST", "/revision/confirmar-seguros", token=tm)
    st2, rv2 = c.req("GET", "/revision/hoy", token=tm)
    check(st == 200 and cs["confirmadas"] == 2 and rv2["revisados"] == 2 and rv2["seguros_sin_revisar"] == 0
          and len(rv2["por_revisar"]) == 2, "confirmar todos los seguros (no toca los dudosos)", (cs, rv2))
    st, ok = c.req("POST", f"/revision/{rid['R']}", token=tm, data={"accion": "confirmar"})
    st2, no = c.req("POST", f"/revision/{rid['T']}", token=tm, data={"accion": "no_es"})
    with sqlite3.connect(db_m) as conn:
        fil = {r[0]: r[1:] for r in conn.execute(
            "SELECT id, estado, revisado_por_staff, revisado_en IS NOT NULL FROM asistencia WHERE id IN (?, ?, ?)",
            (rid["R"], rid["T"], rid["S"]))}
    check(st == st2 == 200 and fil[rid["R"]] == ("valida", "confirmado", 1) and fil[rid["T"]] == ("anulada", "no_es", 1)
          and fil[rid["S"]] == ("valida", "confirmado_lote", 1), "confirmar / no es él (anula) guardan la revisión", fil)
    st, h = c.req("GET", "/metricas/hoy", token=tm)
    check(st == 200 and h["revision"] == {"total": 4, "revisados": 4, "seguros_sin_revisar": 0, "por_revisar": 0},
          "métrica 'X de Y revisados' en /metricas/hoy", h.get("revision"))
    st1, b1 = c.req("POST", f"/revision/{rid['T']}", token=tm, data={"accion": "confirmar"})
    st2, b2 = c.req("POST", f"/revision/{rid['R']}", token=tm, data={"accion": "otra"})
    st3, _ = c.req("POST", "/revision/999999", token=tm, data={"accion": "confirmar"})
    st4, _ = c.req("GET", "/revision/hoy")
    check((st1, codigo(b1), st2, st3, st4) == (409, "no_valida", 400, 404, 401),
          "revisión: anulada 409, acción inválida 400, inexistente 404, sin sesión 401", (st1, b1, st2, st3, st4))


def pruebas_exportes(c: Cliente, srv: Servidor, tm: str, f, hoy):
    """/exportes/asistencia.xlsx|pdf sobre los datos sembrados en la sede-m (corre al final: añade un niño con nombre-fórmula)."""
    import io
    from openpyxl import load_workbook
    print("\n== Exportes (Excel y PDF)")
    d1 = hoy - timedelta(days=9)
    evil = '=HYPERLINK("http://x.test","clic")'
    with sqlite3.connect(srv.data_dir / "sedes" / "sede-m" / "asistencia.db") as conn:
        jid = conn.execute("INSERT INTO jugadores (nombre, embedding, categoria, creado_en, modelo, estado) "
                           "VALUES (?, '[]', 'Sub-10', ?, NULL, 'activo')", (evil, f"{f(d1 - timedelta(days=30))} 10:00:00")).lastrowid
        conn.execute("INSERT INTO asistencia (jugador_id, timestamp, origen, estado) VALUES (?, ?, 'facial', 'valida')",
                     (jid, f"{f(d1)} 16:30:00"))
    q = {"desde": f(d1), "hasta": f(hoy)}
    url = lambda ext: f"{c.base}/exportes/asistencia.{ext}"  # noqa: E731
    hdr = {"Authorization": f"Bearer {tm}"}
    check(requests.get(url("xlsx"), params=q, timeout=60).status_code == 401
          and requests.get(url("pdf"), params=q, timeout=60).status_code == 401, "exportes: sin token -> 401")
    rx = requests.get(url("xlsx"), params=q, headers=hdr, timeout=60)
    nombre = f"asistencia-sede-m-{f(d1)}_{f(hoy)}.xlsx"
    check(rx.status_code == 200 and nombre in rx.headers.get("Content-Disposition", ""),
          "exportes: xlsx 200 con Content-Disposition", rx.headers.get("Content-Disposition"))
    wb = load_workbook(io.BytesIO(rx.content))
    check(wb.sheetnames[:2] == ["Asistencia", "Resumen"], "exportes: xlsx tiene hojas Asistencia y Resumen", wb.sheetnames)
    ws = wb["Asistencia"]
    filas = {r[0]: r for r in ws.iter_rows(min_row=5, values_only=True) if r[0]}
    check({"Ana A", "Beto B", "Cami C", "Dani D", "Nico N"} <= set(filas) and "Gus G" not in filas,
          "exportes: xlsx una fila por niño inscrito (sin invitados)", list(filas))
    ana = filas["Ana A"]
    check(ana[1] == "Sub-10" and ana[2] == 4 and ana[3] == 5 and ana[4] == 0.8 and ana[5] == 0 and ana[6:] == ("✓", "✓", "✓", "✗", "✓"),
          "exportes: xlsx incluye hoy y marca asistencias", ana)
    check(ws.freeze_panes == "B5" and ws.auto_filter.ref and ws.conditional_formatting, "exportes: xlsx encabezado fijo, filtros y formato condicional")
    check(f"'{evil}" in filas and not any(isinstance(x[0], str) and x[0].startswith("=") for x in filas.values()),
          "exportes: nombre con fórmula escapado", [k for k in filas if "HYPER" in k])
    check(not any(isinstance(cel.value, str) and cel.value.startswith("=") for hoja in wb for fila in hoja.iter_rows() for cel in fila),
          "exportes: ninguna celda del libro es fórmula")
    rc = requests.get(url("xlsx"), params={**q, "categoria": "sub-12"}, headers=hdr, timeout=60)
    ws12 = load_workbook(io.BytesIO(rc.content))["Asistencia"]
    check({r[0] for r in ws12.iter_rows(min_row=5, values_only=True) if r[0]} == {"Cami C", "Dani D"},
          "exportes: filtro por categoría")
    rp = requests.get(url("pdf"), params=q, headers=hdr, timeout=60)
    paginas = rp.content.count(b"/Type /Page") - rp.content.count(b"/Type /Pages")
    check(rp.status_code == 200 and rp.content[:4] == b"%PDF" and paginas > 0
          and f"asistencia-sede-m-{f(d1)}_{f(hoy)}.pdf" in rp.headers.get("Content-Disposition", ""),
          "exportes: pdf válido con páginas y nombre de archivo", (rp.status_code, paginas))
    check(requests.get(url("pdf"), params={"desde": "ayer"}, headers=hdr, timeout=60).status_code == 400
          and requests.get(url("xlsx"), params={"categoria": "Nope"}, headers=hdr, timeout=60).status_code == 404,
          "exportes: fecha o categoría inválidas -> 400/404")
    st, aud = c.req("GET", "/auditoria", token=tm)
    check(st == 200 and any(a["accion"] == "exportar_asistencia" for a in aud), "exportes: queda en auditoría")


def pruebas_publica(c: Cliente, srv: Servidor, ta: str):
    print("\n== Dirección pública (ajuste > env > archivo)")
    st, b = c.req("GET", "/config/publica")
    check(st == 401, "GET /config/publica sin token -> 401", (st, b))
    st, b = c.req("GET", "/config/publica", token=ta)
    check(st == 200 and b == {"url": None, "origen": None}, "sin fuentes -> null", (st, b))
    archivo = srv.data_dir / "url_publica.txt"
    archivo.write_text("https://demo-uno.trycloudflare.com\n", encoding="utf-8")
    st, b = c.req("GET", "/config/publica", token=ta)
    check(b == {"url": "https://demo-uno.trycloudflare.com", "origen": "archivo"}, "archivo url_publica.txt", b)
    st, b = c.req("PUT", "/config/publica", token=ta, json={"url": " https://Club.Example.cl/ "})
    check(st == 200 and b == {"url": "https://club.example.cl", "origen": "ajuste"}, "ajuste gana y se normaliza", (st, b))
    for malo in ("club.example.cl", "http://club.example.cl", "https://u:p@club.example.cl", "https://club.example.cl/ruta",
                 "ftp://club.example.cl", "https://club.example.cl?x=1"):
        st, b = c.req("PUT", "/config/publica", token=ta, json={"url": malo})
        check(st == 400 and codigo(b) == "url_invalida", f"rechaza {malo}", (st, b))
    st, b = c.req("PUT", "/config/publica", token=ta, json={"url": "http://localhost:3000"})
    check(st == 200 and b["url"] == "http://localhost:3000", "acepta http://localhost:3000", (st, b))
    st, b = c.req("PUT", "/config/publica", token=ta, json={"url": ""})
    check(b == {"url": "https://demo-uno.trycloudflare.com", "origen": "archivo"}, "vacío quita el ajuste", b)
    archivo.unlink()
    st, b = c.req("GET", "/config/publica", token=ta)
    check(b == {"url": None, "origen": None}, "de nuevo sin fuentes", b)


def pruebas_inscripcion(c: Cliente, srv: Servidor, F: dict[str, bytes]):
    """Datos del apoderado (correo + celular chileno + parentesco), autorización de comunicaciones separada,
    enlace sin categoría (pendiente hasta aprobar), enlace multiuso con tope y compatibilidad con tutor_contacto.
    Usa su propia sede (sede-i) para no compartir los límites por IP/token con el resto del script."""
    print("\n== Inscripción: apoderado, comunicaciones, categoría pendiente, enlace multiuso (sede-i)")
    st, b = c.req("POST", "/auth/login", data={"pin": PIN_I, "sede": "sede-i"})
    if not check(st == 200, "login sede-i", (st, b)):
        return
    ti = b["token"]
    db_i = srv.data_dir / "sedes" / "sede-i" / "asistencia.db"
    anio = str(datetime.now().year - 9)

    def fotos(*nombres):
        return {f"foto{i + 1}": (n, F[n], "image/jpeg") for i, n in enumerate(nombres)}

    def post(token, nombre, nombres_fotos=(), **extra):
        datos = {"t": token, "nombre_nino": nombre, "anio_nacimiento": anio, "categoria": "",
                 "tutor_nombre": "Carla Rojas", "tutor_correo": "carla@example.cl", "tutor_telefono": "9 8765 4321",
                 "tutor_parentesco": "madre", "consentimiento": "true", **extra}
        return c.req("POST", "/inscripcion", sede="sede-i", data=datos, files=fotos(*nombres_fotos) or None)

    st, en = c.req("POST", "/inscripcion/enlaces", token=ti, data={"categoria": "", "dias": "7"})
    check(st == 200 and en["categoria"] is None, "enlace SIN categoría (la elige el apoderado)", (st, en))
    tok = en["token"]
    st, info = c.req("GET", "/inscripcion/info", sede="sede-i", params={"t": tok})
    check(st == 200 and info["categoria_fija"] is None and "Sub-10" in info["categorias"]
          and "borrador" in info["comunicaciones"]["version"] and "WhatsApp" in info["comunicaciones"]["texto"]
          and info["comunicaciones"]["texto"] != info["consentimiento"]["texto"]
          and info["parentescos"] == ["madre", "padre", "otro"],
          "info: selector de categorías + texto de comunicaciones separado (borrador)", info)

    # Validaciones (fallan antes de mirar las fotos).
    casos = [({"tutor_correo": "carla@"}, "tutor_correo", "correo inválido"),
             ({"tutor_correo": ""}, "tutor_correo", "correo obligatorio"),
             ({"tutor_telefono": "12345678"}, "tutor_telefono", "teléfono sin el 9 inicial"),
             ({"tutor_telefono": "+54 9 11 1234 5678"}, "tutor_telefono", "teléfono no chileno"),
             ({"tutor_telefono": ""}, "tutor_telefono", "teléfono obligatorio"),
             ({"tutor_parentesco": "vecino"}, "tutor_parentesco", "parentesco fuera de la lista"),
             ({"categoria": "Sub-99"}, "categoria", "categoría que no existe en la sede")]
    for extra, campo, nombre in casos:
        st, b = post(tok, "Nico Uno", **extra)
        det = b.get("detail", {}) if isinstance(b, dict) else {}
        check(st == 400 and codigo(b) == "datos_invalidos" and det.get("campo") == campo, f"{nombre} -> 400 ({campo})",
              (st, b))

    # Un apoderado, dos hijos, mismo enlace (multiuso): el primero sin categoría y aceptando comunicaciones.
    st, s1 = post(tok, "Nico Uno", PERSONA_A[:2], tutor_correo=" Carla@Example.CL ", tutor_telefono="+56 9 8765 4321",
                  acepta_comunicaciones="true")
    st2, s2 = post(tok, "Sofi Uno", PERSONA_C[:2], tutor_telefono="56987654321", categoria="sub-10")
    check(st == 200 and st2 == 200, "mismo enlace, dos hijos del mismo apoderado", (st, s1, st2, s2))
    st, sols = c.req("GET", "/solicitudes", token=ti)
    n1 = next((x for x in sols if x["nombre_nino"] == "Nico Uno"), {})
    n2 = next((x for x in sols if x["nombre_nino"] == "Sofi Uno"), {})
    check(n1.get("tutor_correo") == "carla@example.cl" and n1.get("tutor_telefono") == "+56987654321"
          and n2.get("tutor_telefono") == "+56987654321" and n1.get("tutor_parentesco") == "madre",
          "correo en minúsculas y celular normalizado a +569XXXXXXXX", (n1, n2))
    check(n1.get("categoria") is None and n2.get("categoria") == "Sub-10",
          "categoría pendiente ('No estoy seguro/a') y categoría canónica", (n1.get("categoria"), n2.get("categoria")))
    check(n1.get("acepta_comunicaciones") is True and n2.get("acepta_comunicaciones") is False,
          "comunicaciones: solo un sí explícito cuenta (sin premarcar)", (n1, n2))
    st, lista = c.req("GET", "/inscripcion/enlaces", token=ti)
    check(next((e["solicitudes_pendientes"] for e in lista if e["id"] == en["id"]), 0) == 2,
          "el enlace multiuso cuenta sus 2 solicitudes", lista)
    with sqlite3.connect(db_i) as conn:
        cons = {r[0]: r[1:] for r in conn.execute(
            "SELECT solicitud_id, acepta_comunicaciones, comunicaciones_version, comunicaciones_texto_hash, "
            "comunicaciones_fecha, texto_hash FROM consentimientos")}
    c1, c2 = cons.get(n1.get("id")), cons.get(n2.get("id"))
    check(c1 and c1[0] == 1 and c1[1] and c1[2] and c1[3] and c1[2] != c1[4],
          "evidencia: acepta_comunicaciones + versión, hash y fecha propios", c1)
    check(c2 and c2[0] == 0 and c2[1] is None and c2[3] is None, "evidencia: quien no aceptó queda en 0 y sin fecha", c2)

    # Aprobar sin categoría no falla: queda sin categoría y con los datos del apoderado en jugadores.
    st, ap1 = c.req("POST", f"/solicitudes/{n1.get('id')}/aprobar", token=ti, data={})
    st2, ap2 = c.req("POST", f"/solicitudes/{n2.get('id')}/aprobar", token=ti, data={})
    check(st == 200 and ap1["categoria"] is None and st2 == 200 and ap2["categoria"] == "Sub-10",
          "aprobar sin categoría -> jugador 'Sin categoría'", (st, ap1, st2, ap2))
    with sqlite3.connect(db_i) as conn:
        j1 = conn.execute("SELECT tutor_correo, tutor_telefono, tutor_parentesco, anio_nacimiento, categoria "
                          "FROM jugadores WHERE id = ?", (ap1.get("id"),)).fetchone()
        com = conn.execute("SELECT acepta_comunicaciones FROM consentimientos WHERE jugador_id = ?",
                           (ap1.get("id"),)).fetchone()
    check(j1 == ("carla@example.cl", "+56987654321", "madre", int(anio), None) and com == (1,),
          "jugador aprobado guarda correo, celular, parentesco, año y su flag de comunicaciones", (j1, com))

    # Compatibilidad: un cliente viejo que solo manda tutor_contacto pasa la validación de datos (falla en fotos).
    st, b = post(tok, "Viejo Uno", tutor_correo="", tutor_telefono="", tutor_parentesco="",
                 tutor_contacto="+56 9 1111 2222")
    check(st == 400 and codigo(b) == "faltan_fotos", "cliente viejo con tutor_contacto sigue funcionando", (st, b))

    # Tope de solicitudes pendientes por enlace.
    st, en2 = c.req("POST", "/inscripcion/enlaces", token=ti, data={"dias": "1"})
    with sqlite3.connect(db_i) as conn:
        conn.executemany(
            "INSERT INTO solicitudes (codigo, enlace_id, nombre_nino, tutor_nombre, tutor_contacto, embeddings, modelo, "
            "creado_en) VALUES (?, ?, 'Relleno', 'Tutor', 'x@example.cl', '[]', 'relleno', ?)",
            [(f"RELL-{i:04d}", en2["id"], datetime.now().isoformat(sep=" ", timespec="seconds")) for i in range(120)])
    st, b = post(en2["token"], "Tope Uno")
    check(st == 429 and codigo(b) == "no_disponible", "enlace con 120 pendientes -> 429", (st, b))
    with sqlite3.connect(db_i) as conn:
        conn.execute("DELETE FROM solicitudes WHERE modelo = 'relleno'")

    # Migración de solicitudes viejas (sin servidor, sobre una BD temporal).
    sys.path.insert(0, str(ROOT))
    from src.db_manager import Base
    import tempfile as _tf
    with _tf.TemporaryDirectory() as td:
        base = Base(Path(td) / "asistencia.db")
        base.init_db()
        with base.conexion() as conn:
            for i, contacto in enumerate(("Vieja@Example.cl", "+56 9 2222 3333", "12345")):
                conn.execute("INSERT INTO solicitudes (codigo, nombre_nino, tutor_nombre, tutor_contacto, embeddings, "
                             "modelo, creado_en) VALUES (?, 'N', 'T', ?, '[]', 'm', '2026-01-01')", (f"OLD-{i}", contacto))
            conn.execute("DELETE FROM meta WHERE clave = 'migracion_contacto_v1'")
        base.init_db()
        with base.conexion() as conn:
            filas = [tuple(r) for r in conn.execute(
                "SELECT tutor_correo, tutor_telefono FROM solicitudes ORDER BY codigo").fetchall()]
    check(filas == [("vieja@example.cl", None), (None, "+56922223333"), (None, None)],
          "migración: tutor_contacto viejo -> correo o teléfono si calza", filas)


def pruebas_plantillas(tmp: Path):
    """Plantillas (sin servidor ni fotos de personas): embeddings sintéticos con cosenos EXACTOS (base ortonormal),
    Sede real sobre un DATA_DIR temporal propio. Regla estricta del aprendizaje por corrección, tope de aprendidas,
    efecto hub mitigado, par cercano -> DUDOSO, y scripts/reparar_plantillas.py en dry-run y --aplicar."""
    import numpy as np
    print("\n== Plantillas: aprendizaje estricto, tope, hub, pares cercanos, reparar_plantillas")
    data = tmp / "data_plantillas"
    os.environ["DATA_DIR"] = str(data)  # antes de importar src.sedes (este proceso no lo había importado)
    sys.path.insert(0, str(ROOT))
    from src import sedes as _sedes
    if Path(_sedes.DATA_DIR) != data.resolve():
        check(False, "plantillas: DATA_DIR temporal (src.sedes ya estaba importado)", _sedes.DATA_DIR)
        return
    from src import cv_engine, plantillas as pl
    from api import nucleo, revision

    D, MOD = 512, "GhostFaceNet"
    Q = np.linalg.qr(np.random.default_rng(7).standard_normal((D, 200)))[0]
    cols = iter(range(200))

    def u():
        return Q[:, next(cols)].copy()

    def mezcla(*pares):
        """Vector unitario con coseno EXACTO c contra cada vector unitario v (los v ortogonales entre sí)."""
        v = sum(c * x for c, x in pares) if pares else np.zeros(D)
        return list(map(float, v + np.sqrt(max(0.0, 1 - sum(c * c for c, _ in pares))) * u()))

    def sede(slug):
        carpeta = data / "sedes" / slug
        carpeta.mkdir(parents=True, exist_ok=True)
        (carpeta / "config.json").write_text(json.dumps({"modelo": MOD, "detector": "retinaface", "umbral": 0.42,
                                                        "umbral_duda": 0.37}), encoding="utf-8")
        return nucleo.Sede(slug, slug)

    def inscribir(s, nombre, vec, n=3):
        jid = s.db.insert_jugador(nombre, list(vec), None, MOD, fotos_extra=[list(vec)] * (n - 1))
        s.recargar()
        return jid

    # -- hub mitigado / bien inscritos sin cambios
    s = sede("sede-hub")
    uh, un = u(), u()
    h = inscribir(s, "Hub", uh, n=1)
    n = inscribir(s, "Nicolas", un)
    ajenas = [u() for _ in range(4)]  # caras de OTRAS personas mal asignadas al hub (regla antigua)
    for e in ajenas:
        s.db.add_foto(h, list(map(float, e)), MOD, "correccion")
    s.recargar()
    sonda = mezcla((0.43, ajenas[0]))  # desconocido que se parece a una plantilla aprendida del hub
    mid, sc, sid, s2 = s.dos_mejores(sonda)
    viejo = max(cv_engine.cosine_similarity(sonda, e) for _, e in s.jugadores[h]["plantillas"])
    check(abs(viejo - 0.43) < 1e-4 and cv_engine.decidir(viejo, s2, 0.42, 0.37) == "aceptado"
          and mid == h and abs(sc - 0.9 * 0.43) < 1e-4 and cv_engine.decidir(sc, s2, 0.42, 0.37) == "dudoso",
          "hub: aprendida x0.9 -> 0.43 pasa a 0.387 (antes ACEPTADO, ahora DUDOSO)", (viejo, mid, sc, s2))
    sonda = mezcla((0.709, un))
    mid, sc, _, s2 = s.dos_mejores(sonda)
    check(mid == n and abs(sc - 0.709) < 1e-4 and cv_engine.decidir(sc, s2, 0.42, 0.37) == "aceptado",
          "bien inscrito (solo inscripción): puntaje idéntico al de siempre (0.709) y ACEPTADO", (mid, sc))
    sonda = mezcla((0.60, uh))
    mid, sc, _, _ = s.dos_mejores(sonda)
    check(mid == h and abs(sc - 0.60) < 1e-4, "hub contra su foto base: sin castigo (0.60)", (mid, sc))
    check(abs(s.puntajes_por_jugador(mezcla((0.5, ajenas[1]))).get(h, 0) - 0.45) < 1e-4,
          "puntajes_por_jugador usa el mismo puntaje robusto")

    # -- regla estricta del aprendizaje (por la ruta real de asignación)
    s = sede("sede-apr")
    ua, ub = u(), u()
    a = inscribir(s, "Ana", ua)
    b = inscribir(s, "Bea", ub)

    def asignar(emb, jid, parecido="medio"):
        pid = s.db.crear_pendiente(nucleo.ahora_ts(), emb, MOD, b"", jid, 0.5, "no_reconocido", None, None,
                                   parecido, None)
        return revision.asignar_pendiente(pid, jugador_id=jid, s=s)

    def n_corr(jid):
        return sum(1 for p in s.jugadores[jid]["plantillas"] if pl.es_aprendida(p))

    casos = [("poco_parecido", mezcla((0.30, ua)), "medio", "< umbral_duda contra sus fotos de inscripción"),
             ("no_es_el_mejor", mezcla((0.50, ua), (0.60, ub)), "medio", "se parece más a otro jugador"),
             ("sin_margen", mezcla((0.55, ua), (0.53, ub)), "medio", "margen < MARGEN_MIN sobre el segundo"),
             ("casi_duplicado", mezcla((0.95, ua)), "medio", "casi duplicado (cos > 0.92)"),
             ("rechazado_bajo", mezcla((0.60, ua)), "bajo", "pendiente RECHAZADO de baja calidad")]
    for cod, emb, par, txt in casos:
        ok, motivo, _ = s.evaluar_correccion(a, emb, par)
        r = asignar(emb, a, par)
        check(not ok and motivo == cod and r["foto_guardada"] is False and r["motivo"] == pl.MOTIVOS_APRENDIZAJE[cod]
              and n_corr(a) == 0, f"aprendizaje: NO aprende si {txt}", (motivo, r))
    r = asignar(mezcla((0.60, ua)), a)
    check(r["foto_guardada"] is True and n_corr(a) == 1, "aprendizaje: aprende si pasa la regla (0.60, mejor, margen)", r)

    # -- tope de aprendidas: se reemplaza la más antigua, nunca la inscripción
    primera = max(f["id"] for f in s.db.fotos_detalle(MOD) if f["origen"] == "correccion")
    for _ in range(5):
        assert asignar(mezcla((0.60, ua)), a)["foto_guardada"]
    filas = [f for f in s.db.fotos_detalle(MOD) if f["jugador_id"] == a]
    corr = [f["id"] for f in filas if f["origen"] == "correccion"]
    check(len(corr) == pl.MAX_APRENDIDAS == 4 and sum(f["origen"] == "inscripcion" for f in filas) == 3
          and n_corr(a) == 4 and primera not in corr and corr == list(range(primera + 2, primera + 6)),
          "tope: 6 aprendidas -> quedan las 4 más nuevas; las 3 de inscripción intactas (BD y memoria)", filas)

    # -- par cercano: aviso al inscribir, persistente, fuerza DUDOSO sin holgura
    s = sede("sede-par")
    ux = u()
    x = inscribir(s, "Xime", ux)
    y = inscribir(s, "Yael", mezcla((0.35, ux)))
    z = inscribir(s, "Zoe", u())
    av = s.revisar_parecidos(y)
    check(av is not None and av["jugador_id"] == x and abs(av["similitud"] - 0.35) < 1e-3
          and av["mensaje"].startswith("Se parece a Xime (0.35)") and "confirmación siempre" in av["mensaje"],
          "inscripción: similitud >= 0.30 con otro jugador -> aviso 'se parece a X (0.35)'", av)
    check(s.revisar_parecidos(z) is None, "inscripción: sin parecidos (< 0.30) -> sin aviso")
    s2_ = nucleo.Sede("sede-par", "sede-par")
    check(s2_.es_par_cercano(x, y) and s2_.es_par_cercano(y, x) and not s2_.es_par_cercano(x, z),
          "par cercano persistente (tabla pares_cercanos) tras recargar la sede", s2_.pares)
    sonda = mezcla((0.47, ux))
    mid, sc, sid, sg = s.dos_mejores(sonda)
    res = cv_engine.decidir(sc, sg, 0.42, 0.37, cv_engine.MARGEN_MIN, par_cercano=s.es_par_cercano(mid, sid))
    check(mid == x and sid == y and res == "dudoso" and cv_engine.decidir(sc, sg, 0.42, 0.37) == "aceptado",
          "par cercano: mejor y segundo forman el par y 0.47 < 0.42+0.10 -> DUDOSO (sin par sería ACEPTADO)",
          (mid, sc, sid, sg, res))
    check(cv_engine.decidir(0.53, 0.20, 0.42, 0.37, 0.04, par_cercano=True) == "aceptado"
          and cv_engine.decidir(0.30, 0.10, 0.42, 0.37, 0.04, par_cercano=True) == "rechazado",
          "par cercano: con holgura (0.53) acepta; bajo duda sigue RECHAZADO")

    # -- reparar_plantillas: dry-run no toca nada; --aplicar respalda y borra solo 'correccion' dudosas
    s = sede("sede-rp")
    up, uq = u(), u()
    p_ = inscribir(s, "Pepa", up)
    q_ = inscribir(s, "Quena", uq)
    s.db.add_foto(p_, mezcla((0.80, up)), MOD, "nueva_foto")
    s.db.add_foto(p_, mezcla((0.10, up)), MOD, "correccion")                 # poco parecida a su jugador
    s.db.add_foto(p_, mezcla((0.40, up), (0.50, uq)), MOD, "correccion")     # más parecida a otro jugador
    s.db.add_foto(p_, mezcla((0.60, up)), MOD, "correccion")                 # buena: se conserva
    ruta_db = data / "sedes" / "sede-rp" / "asistencia.db"

    def fotos_rp():
        with sqlite3.connect(ruta_db) as conn:
            return sorted(conn.execute("SELECT id, origen FROM fotos WHERE jugador_id = ?", (p_,)).fetchall())

    antes = fotos_rp()
    env = {**os.environ, "DATA_DIR": str(data), "PYTHONIOENCODING": "utf-8"}
    r = subprocess.run([PY, "scripts/reparar_plantillas.py", "--sede", "sede-rp"], cwd=ROOT, env=env,
                       capture_output=True, text=True, encoding="utf-8")
    corr_ids = [i for i, o in antes if o == "correccion"]
    check(r.returncode == 0 and "DRY-RUN" in r.stdout and f"dudosas: 2 {corr_ids[:2]}" in r.stdout
          and fotos_rp() == antes and not list((ruta_db.parent / "respaldos").glob("*reparar_plantillas*")),
          "reparar dry-run: detecta las 2 'correccion' dudosas y no cambia nada", r.stdout[-1500:] + r.stderr[-800:])
    r = subprocess.run([PY, "scripts/reparar_plantillas.py", "--sede", "sede-rp", "--aplicar"], cwd=ROOT, env=env,
                       capture_output=True, text=True, encoding="utf-8")
    despues = fotos_rp()
    respaldos = list((ruta_db.parent / "respaldos").glob("asistencia_*_reparar_plantillas.db"))
    ok_resp = False
    if respaldos:
        with sqlite3.connect(respaldos[0]) as conn:
            ok_resp = conn.execute("SELECT COUNT(*) FROM fotos WHERE jugador_id = ?", (p_,)).fetchone()[0] == len(antes)
    check(r.returncode == 0 and ok_resp and despues == [f for f in antes if f[0] not in corr_ids[:2]]
          and sum(o == "inscripcion" for _, o in despues) == 3 and any(o == "nueva_foto" for _, o in despues)
          and "reinicia la API" in r.stdout,
          "reparar --aplicar: respaldo con sello en respaldos/, borra solo las 2 dudosas (inscripción, nueva_foto y "
          "la buena intactas)", (antes, despues, r.stdout[-800:], r.stderr[-800:]))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fotos", type=Path, help="carpeta con img1.jpg, img3.jpg, ... (si no, se descargan)")
    ap.add_argument("--conservar", action="store_true", help="no borrar el directorio temporal")
    a = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="facup_flujos_"))
    data_dir, log = tmp / "data", tmp / "uvicorn.log"
    srv = None
    try:
        print(f"Directorio temporal: {tmp}")
        F = preparar_fotos(a.fotos, tmp / "fotos")
        env = {**os.environ, "DATA_DIR": str(data_dir)}
        for slug, nombre, pin in (("sede-a", "Sede A", PIN_A), ("sede-b", "Sede B", PIN_B), ("sede-m", "Sede M", PIN_M),
                                  ("sede-u", "Sede U", PIN_U), ("sede-i", "Sede I", PIN_I)):
            subprocess.run([PY, "scripts/crear_sede.py", slug, nombre, "--pin", pin], cwd=ROOT, env=env, check=True,
                           stdout=subprocess.DEVNULL)
            cfg = ROOT / "data" / "config.json"  # misma configuración de reconocimiento que la instalación real
            destino = data_dir / "sedes" / slug / "config.json"
            if cfg.exists():
                shutil.copy2(cfg, destino)
            else:
                destino.write_text(json.dumps(CONFIG_LEGADO), encoding="utf-8")
            if slug == "sede-u":  # formato antiguo garantizado (sin umbral_duda) para probar la compatibilidad
                legado = json.loads(destino.read_text(encoding="utf-8"))
                legado.pop("umbral_duda", None)
                legado.setdefault("umbral", CONFIG_LEGADO["umbral"])
                destino.write_text(json.dumps(legado), encoding="utf-8")
        srv = Servidor(data_dir, puerto_libre(), log)
        print(f"Iniciando API en el puerto {srv.puerto} (warmup del modelo)...")
        srv.iniciar()
        ejecutar(Cliente(f"http://127.0.0.1:{srv.puerto}"), srv, F)
        srv.detener()  # libera memoria: las pruebas de plantillas cargan el motor en este proceso
        pruebas_plantillas(tmp)
    except Exception as exc:
        import traceback
        traceback.print_exc()
        check(False, f"excepción: {exc}")
    finally:
        if srv:
            srv.detener()
        fallas = [n for ok, n in resultados if not ok]
        if fallas and log.exists():
            print("\n--- últimas líneas del log del servidor ---")
            print("\n".join(log.read_text(encoding="utf-8", errors="replace").splitlines()[-40:]))
        if a.conservar:
            print(f"(conservado: {tmp})")
        else:
            for _ in range(10):  # en Windows el proceso recién cerrado puede retener archivos unos segundos
                shutil.rmtree(tmp, ignore_errors=True)
                if not tmp.exists():
                    break
                time.sleep(1)
            if tmp.exists():
                print(f"AVISO: no se pudo borrar {tmp}; bórralo a mano.")
    total = len(resultados)
    print(f"\n{total - len(fallas)}/{total} verificaciones OK")
    return 1 if fallas else 0


if __name__ == "__main__":
    raise SystemExit(main())
