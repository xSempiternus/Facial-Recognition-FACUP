"""Crea una sede nueva (BD propia con categoría Sub-10, config y carpeta de respaldos) o cambia el PIN de una existente.

Uso (desde la raíz del repo, con el venv):
    python scripts/crear_sede.py providencia "Sede Providencia" --pin 12345678
    python scripts/crear_sede.py providencia --cambiar-pin 87654321
    python scripts/crear_sede.py --listar

Respeta DATA_DIR (por defecto <repo>/data). No hace falta reiniciar la API: la sede se carga al primer uso.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src import sedes  # noqa: E402

MIN_PIN = 4


def main() -> int:
    ap = argparse.ArgumentParser(description="Crear o administrar sedes.")
    ap.add_argument("slug", nargs="?", help="identificador: minúsculas, números y guiones (2-40)")
    ap.add_argument("nombre", nargs="?", help='nombre visible, p. ej. "Sede Providencia"')
    ap.add_argument("--pin", help="PIN del staff de la sede (recomendado: 8+ dígitos)")
    ap.add_argument("--cambiar-pin", metavar="PIN", help="cambia el PIN de una sede existente")
    ap.add_argument("--listar", action="store_true", help="lista las sedes registradas")
    a = ap.parse_args()

    sedes.init_control()
    if a.listar:
        for s in sedes.listar(solo_activas=False):
            print(f"{s['slug']:<20} {s['nombre']:<30} {'activa' if s['activa'] else 'inactiva'}  {s['creada_en']}")
        return 0
    if not a.slug:
        ap.error("falta el slug")
    if a.cambiar_pin:
        if len(a.cambiar_pin) < MIN_PIN:
            ap.error(f"el PIN debe tener al menos {MIN_PIN} caracteres")
        if not sedes.cambiar_pin(a.slug, a.cambiar_pin):
            print(f"La sede '{a.slug}' no existe.", file=sys.stderr)
            return 1
        print(f"PIN de '{a.slug}' actualizado.")
        return 0
    if not a.nombre or not a.pin:
        ap.error('para crear: crear_sede.py <slug> "<Nombre>" --pin <pin>')
    if len(a.pin) < MIN_PIN:
        ap.error(f"el PIN debe tener al menos {MIN_PIN} caracteres")
    try:
        info = sedes.crear(a.slug, a.nombre, a.pin)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    print(f"Sede creada: {info['slug']} ({info['nombre']}) en {sedes.carpeta(info['slug'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
