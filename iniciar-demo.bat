@echo off
REM Demo desde el celular: levanta API + app web compilada + tunel publico de Cloudflare.
REM Imprime la URL https://*.trycloudflare.com y la copia al portapapeles. Deja esta ventana abierta.
cd /d "%~dp0"
set PYTHONUTF8=1
set TF_CPP_MIN_LOG_LEVEL=2
if exist "config.local.bat" call "config.local.bat"
REM La API esta detras del tunel: confiar en la IP real que manda el proxy (lo lee api/auth.py).
set TRUST_PROXY=1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0iniciar-demo.ps1"
echo.
pause
