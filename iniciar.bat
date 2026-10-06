@echo off
REM Inicia la API y la UI en dos ventanas. Doble clic para ejecutar.
cd /d "%~dp0"
REM DeepFace imprime emojis en sus logs; sin UTF-8 Python falla en consolas cp1252.
set PYTHONUTF8=1
set TF_CPP_MIN_LOG_LEVEL=2
REM Ajustes privados de este equipo (PIN del staff, etc.): copia config.local.example.bat a config.local.bat.
if exist "config.local.bat" call "config.local.bat"
if not exist ".venv\Scripts\python.exe" (
    echo No se encontro el entorno virtual .venv. Revisa el README.
    pause
    exit /b 1
)
start "API - Reconocimiento facial" cmd /k ".venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000"
start "UI - Asistencia" cmd /k ".venv\Scripts\python.exe -m streamlit run ui/app.py"
