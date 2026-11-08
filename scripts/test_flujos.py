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
                    "TF_CPP_MIN_LOG_LEVEL": "3", "GEMINI_API_KEY": "", "AVISO_TTL_S": str(AVISO_TTL_S), **LIMITES}

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

    # -- dudoso por zona gris: duda <= score < automático
    poner(min(s1 + 0.03, 0.99), s1 - 0.03)
    st, v = verify("img10.jpg")
    texto = json.dumps(v, ensure_ascii=False)
    check(st == 404 and codigo(v) == "no_reconocido" and v["detail"].get("dudoso") is True
          and set(v["detail"]) == {"codigo", "mensaje", "aviso", "dudoso"} and "Ana" not in texto
          and "similitud" not in texto, "zona gris: 404 no_reconocido con dudoso=true, sin nombre ni puntaje", (st, v))
    check(ultimo_log()["resultado"] == "dudoso", "registro: dudoso")
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
                   "umbral_duda", "modelo", "detector", "ms_total", "ms_deteccion"}, "verificaciones_log sin biometría", cols)
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
                                  ("sede-u", "Sede U", PIN_U)):
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
