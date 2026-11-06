@echo off
REM Inicia la API y la app web, y abre la app en Edge a pantalla completa.
REM   App web (Next.js)         http://localhost:3000   <- menu: /asistencia (kiosko de llegada) y /staff (panel del staff con PIN)
REM   API (FastAPI + DeepFace)  http://127.0.0.1:8000
cd /d "%~dp0"
REM DeepFace imprime emojis en sus logs; sin UTF-8 Python falla en consolas cp1252.
set PYTHONUTF8=1
set TF_CPP_MIN_LOG_LEVEL=2
REM Ajustes privados de este equipo (PIN del staff, etc.): copia config.local.example.bat a config.local.bat.
if exist "%~dp0config.local.bat" call "%~dp0config.local.bat"
if not exist ".venv\Scripts\python.exe" (
    echo No se encontro el entorno virtual .venv. Revisa el README.
    pause
    exit /b 1
)
start "API - Reconocimiento facial" cmd /k ".venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000"

REM App web: instala dependencias la primera vez y compila (asi siempre corre la version al dia).
where npm >nul 2>nul
if errorlevel 1 (
    echo No se encontro Node.js: la app web no se inicio. Instala Node.js LTS desde nodejs.org.
    pause
    exit /b 0
)
start "Web - FA CUP" cmd /k "cd /d web && (if not exist node_modules call npm install) && call npm run build && call npm start -- -p 3000"

REM Cuando la app web responda, se abre en Edge (menu en la raiz) a pantalla completa (F11 para salir).
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 300;$i++){try{if((Invoke-WebRequest -UseBasicParsing http://localhost:3000 -TimeoutSec 3).StatusCode -eq 200){break}}catch{};Start-Sleep -Seconds 2}; try{Start-Process msedge -ArgumentList '--app=http://localhost:3000','--start-fullscreen' -ErrorAction Stop}catch{Start-Process 'http://localhost:3000'}"
