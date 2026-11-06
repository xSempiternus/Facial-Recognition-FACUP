"""Prueba de punta a punta de los flujos de inscripción por los padres, invitados, pendientes persistentes,
"No soy yo", anulaciones, auditoría y aislamiento entre sedes.

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
PIN_A, PIN_B = "11112222", "33334444"
LIMITES = {"RL_INSCRIPCION_IP": "16/3600", "RL_INSCRIPCION_TOKEN": "12/3600", "RL_INFO_IP": "200/600",
           "RL_NO_SOY_YO_IP": "4/600", "RL_NO_SOY_YO_SEDE": "50/600"}

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
                    "TF_CPP_MIN_LOG_LEVEL": "3", "GEMINI_API_KEY": "", **LIMITES}

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

    print("\n== Persistencia: reinicio del servidor")
    srv.detener()
    srv.iniciar()
    st, pend2 = c.req("GET", "/pendientes", token=ta)
    check(st == 200 and [p["id"] for p in pend2] == [p["id"] for p in pend] and pend2[0]["disputa_de"]["id"] == id_a,
          "pendientes persisten tras reiniciar (token sigue válido con AUTH_SECRET)", (st, pend2))

    print("\n== Resolver disputa asignando a otro niño")
    st, asg = c.req("POST", f"/pendientes/{pend2[0]['id']}/asignar", token=ta, data={"jugador_id": id_b})
    check(st == 200 and asg["disputa"] == "anulada" and asg["ya_registrado"] is False, "asignar disputa a B", (st, asg))
    st, asis = c.req("GET", "/asistencias", token=ta, params={"hoy": "true", "todas": "true"})
    est = {a["jugador_id"]: a["estado"] for a in asis}
    check(est.get(id_a) == "anulada" and est.get(id_b) == "valida", "A anulada, B válida", asis)
    st, res = c.req("GET", "/kiosko/resumen", sede="sede-a")
    check(res["llegadas_hoy"] == 1, "conteo 1 tras resolver", res)

    print("\n== Disputa confirmada (era el mismo) y disputa con 'ya registrado'")
    st, v2 = verify("sede-a", "img11.jpg")
    check(st == 200 and v2["ya_registrado"] is False, "A vuelve a marcar (su anterior quedó anulada)", (st, v2))
    c.req("POST", "/verify/no-soy-yo", sede="sede-a", data={"reporte": v2["reporte"]})
    st, pend = c.req("GET", "/pendientes", token=ta)
    st, asg = c.req("POST", f"/pendientes/{pend[0]['id']}/asignar", token=ta, data={"jugador_id": id_a})
    check(st == 200 and asg["disputa"] == "confirmada" and asg["ya_registrado"] is True,
          "asignar al mismo -> asistencia restaurada", (st, asg))
    st, res = c.req("GET", "/kiosko/resumen", sede="sede-a")
    check(res["llegadas_hoy"] == 2, "conteo 2 (A restaurada + B)", res)
    st, v3 = verify("sede-a", "img10.jpg")
    check(st == 200 and v3["ya_registrado"] is True, "tercer verify: ya registrado", (st, v3))
    c.req("POST", "/verify/no-soy-yo", sede="sede-a", data={"reporte": v3["reporte"]})
    st, pend = c.req("GET", "/pendientes", token=ta)
    st, dl = c.req("DELETE", f"/pendientes/{pend[0]['id']}", token=ta)
    st2, asis = c.req("GET", "/asistencias", token=ta, params={"hoy": "true"})
    check(st == 200 and dl["disputa"] == "sin_asistencia"
          and [a["estado"] for a in asis if a["jugador_id"] == id_a] == ["valida"],
          "'ya registrado' no toca la asistencia", (dl, asis))
    # Tras el reinicio van 2 reportes (v2, v3); el límite de prueba es 4 por IP.
    cods = [c.req("POST", "/verify/no-soy-yo", sede="sede-a", data={"reporte": "inventado"})[0] for _ in range(3)]
    check(cods == [200, 200, 429], "reporte inválido -> 200 genérico; rate limit de 'No soy yo' por IP", cods)

    print("\n== Llegada no reconocida -> invitado -> aprobación de su familia")
    st, v = verify("sede-a", "img8.jpg")
    check(st == 404 and codigo(v) == "no_reconocido", "desconocido -> no_reconocido", (st, v))
    st, pend = c.req("GET", "/pendientes", token=ta)
    p_nuevo = next((p for p in pend if p["motivo"] == "no_reconocido"), None)
    check(p_nuevo is not None and p_nuevo["disputa_de"] is None, "pendiente no reconocido persistido", pend)
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
    st, v = verify("sede-a", GRUPO)  # caras desconocidas -> pendiente
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
        for slug, nombre, pin in (("sede-a", "Sede A", PIN_A), ("sede-b", "Sede B", PIN_B)):
            subprocess.run([PY, "scripts/crear_sede.py", slug, nombre, "--pin", pin], cwd=ROOT, env=env, check=True,
                           stdout=subprocess.DEVNULL)
            cfg = ROOT / "data" / "config.json"  # misma configuración de reconocimiento que la instalación real
            if cfg.exists():
                shutil.copy2(cfg, data_dir / "sedes" / slug / "config.json")
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
