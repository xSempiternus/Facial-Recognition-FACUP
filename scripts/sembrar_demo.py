"""Siembra una sede de DEMOSTRACIÓN ("Sede Demo", PIN 4321) con datos sintéticos para ver los gráficos del panel.

Uso (desde la raíz del repo, con el venv):
    python scripts/sembrar_demo.py                       # slug "demo", 10 jornadas; no hace nada si ya existe
    python scripts/sembrar_demo.py demo --jornadas 14
    python scripts/sembrar_demo.py demo --forzar         # borra y recrea la sede demo

Respeta DATA_DIR. Solo toca la sede indicada (y solo si es una "Sede Demo"): las demás sedes no se tocan.
Los niños son ficticios, sin biometría ni fotos (no los reconoce el kiosko). Determinista (semilla fija).
Jornadas: martes y jueves hacia atrás desde hoy; la de hoy queda parcialmente llena.
"""

import argparse
import random
import shutil
import sqlite3
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src import sedes  # noqa: E402
from src.db_manager import Base  # noqa: E402

NOMBRE_SEDE = "Sede Demo"
PIN = "4321"
CATEGORIAS = [("Sub-8", 0), ("Sub-10", 1), ("Sub-12", 2)]
NINOS = {
    "Sub-8": ["Matías Rojas", "Sofía Fuentes", "Benjamín Tapia", "Emilia Contreras", "Joaquín Araya",
              "Antonella Vergara", "Vicente Lagos", "Isidora Pinto"],
    "Sub-10": ["Tomás Villalobos", "Florencia Soto", "Agustín Cárdenas", "Javiera Muñoz", "Maximiliano Silva",
               "Catalina Espinoza", "Lucas Bravo", "Martina Orellana", "Felipe Carrasco", "Amanda Herrera"],
    "Sub-12": ["Diego Figueroa", "Valentina Sepúlveda", "Sebastián Maldonado", "Camila Riquelme", "Cristóbal Navarro",
               "Francisca Guzmán", "Ignacio Parra", "Antonia Salinas", "Nicolás Poblete", "Renata Ibáñez"],
}
INVITADOS = [("Gaspar Lira", "Sub-10"), ("Amaro Vidal", "Sub-8"), ("Julieta Cornejo", "Sub-12"), ("Bastián Ossa", "Sub-10")]
NUEVOS = {"Amanda Herrera": 0.45, "Nicolás Poblete": 0.65}   # se inscriben a mitad del periodo (fracción de jornadas)
EN_RIESGO = {"Lucas Bravo": 4, "Camila Riquelme": 3, "Vicente Lagos": 5}  # faltas seguidas al final


def _ts(d: date, minutos: int, seg: int = 0) -> str:
    return datetime(d.year, d.month, d.day, minutos // 60, minutos % 60, seg).isoformat(sep=" ")


def _sesiones(n: int, hoy: date) -> list[date]:
    """Las n jornadas pasadas más recientes (martes=1 y jueves=3), de la más antigua a la más reciente."""
    fechas, d = [], hoy - timedelta(days=1)
    while len(fechas) < n:
        if d.weekday() in (1, 3):
            fechas.append(d)
        d -= timedelta(days=1)
    return sorted(fechas)


def _borrar(slug: str) -> None:
    with sedes._control() as conn:
        conn.execute("DELETE FROM sedes WHERE slug = ?", (slug,))
    shutil.rmtree(sedes.carpeta(slug), ignore_errors=True)


def sembrar(slug: str, n_jornadas: int, forzar: bool) -> int:
    sedes.init_control()
    if sedes.existe(slug):
        info = sedes.obtener(slug)
        if info["nombre"] != NOMBRE_SEDE:
            print(f"Error: '{slug}' existe y no es una sede demo ('{info['nombre']}'); no se toca.", file=sys.stderr)
            return 1
        if not forzar:
            print(f"La sede '{slug}' ya existe. Usa --forzar para recrearla.")
            return 0
        _borrar(slug)
    sedes.crear(slug, NOMBRE_SEDE, PIN)
    db = Base(sedes.ruta_db(slug))
    rng = random.Random(2026)
    hoy = date.today()
    sesiones = _sesiones(n_jornadas, hoy)
    primera = sesiones[0]

    for nombre, orden in CATEGORIAS:
        if nombre == "Sub-10":
            continue  # la siembra de init_db ya la crea (orden 1)
        db.crear_categoria(nombre, orden)

    with db.conexion() as conn:
        # --- niños (sin biometría: embedding vacío, sin fotos) con ritmo de asistencia propio
        ninos = []
        for cat, nombres in NINOS.items():
            for nombre in nombres:
                if nombre in NUEVOS:
                    alta = sesiones[min(len(sesiones) - 1, int(len(sesiones) * NUEVOS[nombre]))] - timedelta(days=1)
                else:
                    alta = primera - timedelta(days=rng.randint(15, 120))
                cur = conn.execute(
                    "INSERT INTO jugadores (nombre, embedding, categoria, creado_en, modelo, estado) "
                    "VALUES (?, '[]', ?, ?, NULL, 'activo')", (nombre, cat, _ts(alta, 15 * 60 + rng.randint(0, 59))))
                ninos.append({"id": cur.lastrowid, "nombre": nombre, "cat": cat, "alta": alta,
                              "p": min(0.98, max(0.5, rng.gauss(0.82, 0.12))),   # probabilidad de venir
                              "habito": rng.gauss(0, 7)})                        # llega antes o después que el resto
        invitados = []
        for nombre, cat in INVITADOS:
            cur = conn.execute("INSERT INTO jugadores (nombre, embedding, categoria, creado_en, modelo, estado) "
                               "VALUES (?, '[]', ?, ?, NULL, 'invitado')", (nombre, cat, _ts(primera, 15 * 60)))
            invitados.append(cur.lastrowid)

        def llegada(n: dict, techo: int = 16 * 60 + 40) -> int:
            m = int(round(16 * 60 + 13 + n["habito"] + rng.gauss(0, 6)))
            return max(16 * 60, min(techo, m))

        def origen() -> str:
            x = rng.random()
            return "facial" if x < 0.86 else ("manual" if x < 0.96 else "correccion")

        def marcar(jid: int, d: date, minutos: int, org: str, estado: str = "valida") -> None:
            conn.execute("INSERT INTO asistencia (jugador_id, timestamp, origen, estado) VALUES (?, ?, ?, ?)",
                         (jid, _ts(d, minutos, rng.randint(0, 59)), org, estado))

        # --- jornadas pasadas
        for i, d in enumerate(sesiones):
            restantes = len(sesiones) - i
            for n in ninos:
                if d < n["alta"]:
                    continue
                if n["nombre"] in EN_RIESGO and restantes <= EN_RIESGO[n["nombre"]]:
                    continue  # racha de faltas al final
                if n["nombre"] == "Tomás Villalobos" and 3 <= restantes <= 5:
                    continue  # racha de faltas ya cortada
                if rng.random() < n["p"]:
                    marcar(n["id"], d, llegada(n), origen())
            for jid in rng.sample(invitados, k=1 if rng.random() < 0.3 else 0):
                marcar(jid, d, 16 * 60 + rng.randint(5, 35), "invitado")
        # una asistencia anulada (no debe contar en ninguna métrica)
        if sesiones:
            marcar(ninos[0]["id"], sesiones[-1], 16 * 60 + 50, "manual", "anulada")
            conn.execute("UPDATE asistencia SET motivo = 'marcado por error', anulada_en = ? WHERE estado = 'anulada'",
                         (_ts(sesiones[-1], 17 * 60),))

        # --- hoy, parcialmente lleno (llegadas hasta las 16:25)
        for n in ninos:
            if n["nombre"] in EN_RIESGO:
                continue
            if rng.random() < min(0.75, n["p"] - 0.1):
                marcar(n["id"], hoy, llegada(n, 16 * 60 + 25), origen())
        marcar(invitados[0], hoy, 16 * 60 + 18, "invitado")
        # una o dos jornadas de partido para ver el tipo
        for d in sesiones[3::5]:
            conn.execute("INSERT OR REPLACE INTO sesiones (fecha, tipo) VALUES (?, 'partido')", (d.isoformat(),))

    print(f"Sede demo '{slug}' lista: {len(ninos)} niños, {len(invitados)} invitados, {len(sesiones)} jornadas "
          f"({sesiones[0]} a {sesiones[-1]}) + hoy parcial. PIN {PIN}. Carpeta: {sedes.carpeta(slug)}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Sembrar la sede de demostración.")
    ap.add_argument("slug", nargs="?", default="demo")
    ap.add_argument("--jornadas", type=int, default=10, help="jornadas pasadas (martes y jueves), 1-120")
    ap.add_argument("--forzar", action="store_true", help="si la sede demo ya existe, borrarla y recrearla")
    a = ap.parse_args()
    if not 1 <= a.jornadas <= 120:
        ap.error("--jornadas debe estar entre 1 y 120")
    if not sedes.slug_valido(a.slug):
        ap.error("slug inválido (minúsculas, números y guiones, 2-40)")
    return sembrar(a.slug, a.jornadas, a.forzar)


if __name__ == "__main__":
    raise SystemExit(main())
