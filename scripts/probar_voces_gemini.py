"""Genera muestras de varias voces de Gemini TTS y una página para compararlas.
Uso (con GEMINI_API_KEY ya definida): .venv\Scripts\python.exe scripts\probar_voces_gemini.py"""
import html
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from api import voz  # noqa: E402

if not voz.GEMINI_KEY:
    sys.exit("Falta GEMINI_API_KEY (ponla en config.local.bat y vuelve a abrir la terminal).")

VOCES = [("Kore", "firme"), ("Leda", "juvenil"), ("Aoede", "ligera"), ("Zephyr", "brillante"), ("Sulafat", "cálida"),
         ("Achird", "amistosa"), ("Puck", "animada"), ("Orus", "firme (hombre)"), ("Charon", "informativa (hombre)"),
         ("Fenrir", "entusiasta (hombre)"), ("Achernar", "suave"), ("Gacrux", "madura")]
TEXTO = "¡Hola, Agustín! ¡A jugar!"
salida = Path(__file__).resolve().parent.parent / "Claude outputs" / "voces-gemini"
salida.mkdir(parents=True, exist_ok=True)

filas = []
for nombre, rasgo in VOCES:
    voz.GEMINI_VOZ = nombre
    destino = salida / f"{nombre}.wav"
    if not destino.exists():
        for intento in range(3):  # el plan gratuito limita las llamadas por minuto: se espacian y se reintenta
            try:
                destino.write_bytes(voz._gemini(TEXTO))
                time.sleep(13)
                break
            except Exception as e:
                print("reintento", nombre, e)
                time.sleep(25)
        else:
            continue
    filas.append(f'<div class="v"><div><b>{nombre}</b> <span>{rasgo}</span></div><audio controls preload="none" src="{nombre}.wav"></audio></div>')
    print("ok", nombre)

(salida / "index.html").write_text(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Voces Gemini</title>'
    "<style>body{font-family:system-ui;background:#07281f;color:#fff;max-width:640px;margin:2rem auto;padding:0 1rem}"
    ".v{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.8rem 1rem;margin:.5rem 0;border-radius:14px;background:#ffffff14;flex-wrap:wrap}"
    "span{color:#ffffffaa;font-size:.9rem}</style>"
    f"<h1>Voces Gemini</h1><p>Frase: «{html.escape(TEXTO)}»</p>" + "".join(filas),
    encoding="utf-8",
)
os.startfile(salida / "index.html")
