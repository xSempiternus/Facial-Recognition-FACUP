@echo off
REM Copia este archivo como config.local.bat (no se sube a git) y cambia los valores.
REM iniciar.bat lo carga antes de levantar la API y la UI.

REM PIN del panel del staff (por defecto 1234: cambialo antes de usar la app con niños reales).
set STAFF_PIN=1234

REM Clave para firmar las sesiones del staff (opcional). Si no la defines, al reiniciar la API hay que volver a ingresar el PIN.
REM set AUTH_SECRET=pon-aqui-una-cadena-larga-y-aleatoria
REM Horas que dura una sesion del staff (por defecto 12).
REM set AUTH_TTL_HORAS=12
REM Activalo (=1) cuando la app se exponga por tunel/proxy (cloudflared): el limite de intentos de PIN usa la IP de X-Forwarded-For.
REM Sin tunel dejalo desactivado: ese encabezado se puede falsificar.
REM set TRUST_PROXY=1
REM Origenes permitidos por CORS, separados por coma (por defecto solo localhost:3000).
REM set CORS_ORIGINS=http://localhost:3000

REM TRUST_PROXY=1 lo define iniciar-demo.bat solo (la API esta detras del tunel de Cloudflare). No hace falta ponerlo aqui.
