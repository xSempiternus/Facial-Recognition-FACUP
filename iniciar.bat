@echo off
REM Inicia la API, el panel del staff y el kiosko de llegada. Doble clic para ejecutar.
REM   API (FastAPI + DeepFace)      http://127.0.0.1:8000
REM   Panel del staff (Streamlit)   http://localhost:8501
REM   Kiosko de llegada (Next.js)   http://localhost:3000
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
start "Staff - Asistencia" cmd /k ".venv\Scripts\python.exe -m streamlit run ui/app.py"

REM Kiosko web: instala dependencias la primera vez y compila (asi siempre corre la version al dia).
where npm >nul 2>nul
if errorlevel 1 (
    echo No se encontro Node.js: el kiosko web no se inicio. Instala Node.js LTS desde nodejs.org.
    pause
    exit /b 0
)
start "Kiosko - FA CUP" cmd /k "cd /d web && (if not exist node_modules call npm install) && call npm run build && call npm start -- -p 3000"
