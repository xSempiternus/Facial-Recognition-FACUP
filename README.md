# Asistencia con Reconocimiento Facial — Liga de Fútbol Infantil (MVP)

MVP local: FastAPI + DeepFace + SQLite. Kiosko de llegada en Next.js (`web/`); panel del staff en `/staff` (el panel Streamlit de `ui/` queda como opcional).

## Estructura

```
data/                    BD SQLite (asistencia.db) y config.json; se crean solos
src/cv_engine.py         detección facial, embeddings, similitud del coseno, configuración
src/db_manager.py        SQLite de UNA sede: jugadores / fotos / asistencia / categorías, respaldos
src/sedes.py             registro de sedes (data/control.db), PIN por sede, migración automática
scripts/crear_sede.py    crea sedes nuevas o cambia su PIN
api/main.py              API FastAPI
web/                     Kiosko de llegada: Next.js + Motion + MediaPipe (ver web/README.md)
ui/app.py                Panel del staff en Streamlit (navegación)
ui/core.py               cliente de la API, estilos y componentes compartidos
ui/vistas/               páginas del panel Streamlit: acceso, inscribir, jugadores, asistencia, reportes, evaluacion, ajustes
scripts/evaluar_modelos.py  benchmark de modelos/detectores con fotos propias
eval/fotos/              fotos de prueba (una carpeta por persona)
eval/resultados/         resultados de la evaluación
.streamlit/config.toml   tema visual
iniciar.bat              lanza API + app web (kiosko y /staff) en Windows (doble clic)
iniciar-demo.bat         demo desde el celular: API + app web + túnel público de Cloudflare
```

## Instalación

Requiere Python 3.10–3.12 (TensorFlow no siempre soporta la última versión de Python).

```bash
py -3.10 -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
```

> Si pip falla con `getaddrinfo failed` hacia `pypi.ngc.nvidia.com`, es la configuración global de pip.
> El venv incluye un `.venv/pip.ini` que la anula para este proyecto.

Los pesos de cada modelo se descargan la primera vez que se usan en `%USERPROFILE%\.deepface`.

El kiosko web necesita **Node.js LTS**. `iniciar.bat` hace `npm install` la primera vez (con internet:
descarga también el modelo de MediaPipe) y luego funciona sin conexión.

## Ejecución

Doble clic en `iniciar.bat` (abre dos ventanas: API y app web, y Edge en http://localhost:3000), o en terminales separadas (con el venv activado, desde la raíz):

```bash
set PYTHONUTF8=1
uvicorn api.main:app
streamlit run ui/app.py
cd web && npm install && npm run build && npm start
```

**Seguridad:** el staff entra con el PIN (`POST /auth/login`) y recibe un token firmado con vencimiento; todos los endpoints salvo `/health`, `/verify`, `/kiosko/resumen` y `/voz` lo exigen; la documentación `/docs` está apagada (`ENABLE_DOCS=1` para desarrollo). Tras 5 PIN incorrectos seguidos se bloquea el acceso 5 minutos.  
**PIN del staff:** copia `config.local.example.bat` como `config.local.bat` y define `STAFF_PIN` (recomendado: mínimo 8 caracteres).
`iniciar.bat` e `iniciar-demo.bat` lo cargan solos y el archivo no se sube a git.

**Demo desde el celular:** doble clic en `iniciar-demo.bat`. Levanta la API, la app web compilada (`0.0.0.0:3000`) y un túnel
`cloudflared` (necesita `cloudflared` en el PATH); espera a que el túnel esté listo, imprime la URL `https://*.trycloudflare.com`
y la copia al portapapeles. Define `TRUST_PROXY=1` solo. Si el 3000 o el 8000 ya están ocupados, avisa y no duplica nada.
El script evita la suspensión del PC mientras corre (sin cambiar la configuración de energía); Enter en su ventana apaga todo.
La URL cambia en cada ejecución.

- **App web:** http://localhost:3000 (pantalla completa con F11). Abre en un **menú** con dos accesos:
  *Registrar asistencia* (`/asistencia`, el kiosko de llegada) y *Soy admin* (`/staff`, panel del staff con PIN).
  Salir de `/asistencia` pide el PIN del staff. `/asistencia` también abre directo para una tablet dedicada.
- **Panel Streamlit (opcional, ya no lo lanza `iniciar.bat`):** `streamlit run ui/app.py` en http://localhost:8501
- API (documentación interactiva): http://127.0.0.1:8000/docs

## Uso

**⚽ Kiosko de llegada (http://localhost:3000)** — sin botones: el niño se para frente a la pantalla y pone
la cara en el círculo central de la cancha. El kiosko lo guía («Acércate un poco», «Al centro de la cancha»),
llena el anillo mientras se queda quieto y saca la foto solo. Registrado: el círculo se expande en verde con
su nombre. Ya registrado: lo mismo en verde oscuro. Error: tarjeta amarilla (vuelve a intentar) o roja
(llama al staff). Saluda en voz alta con la voz del navegador (`?voz=0` la apaga; `?prueba=1` deja el
resultado en pantalla hasta tocarla). Para una voz latinoamericana, instálala en Windows:
Configuración → Hora e idioma → Voz → Agregar voces → Español (México). Detalles en `web/README.md`.

**🔐 Staff** (http://localhost:3000/staff; PIN en `config.local.bat`, por defecto `1234`):
- **📝 Inscribir** — 3 pasos: datos → 3 fotos guiadas (frente, izquierda, derecha) → listo. Comprueba que
  las 3 fotos sean de la misma persona y avisa si el niño parece ya inscrito.
- **👥 Jugadores** — búsqueda, filtro por categoría, cantidad de fotos, marcar asistencia a mano,
  📸 agregar foto, eliminar.
- **📋 Asistencia** — **🔔 Por revisar** (llegadas que la cámara no reconoció: el staff indica quién era),
  tipo de jornada (entrenamiento / partido), presentes, faltantes (con marcado manual), exportar CSV.
- **📊 Reportes** — por período y tipo de jornada: % de asistencia por niño (solo desde su inscripción),
  alerta «para llamar» si faltó 3+ veces seguidas, asistencia por día y exportación CSV.
- **🧪 Evaluación** — ejecuta el benchmark, explica resultados y aplica la configuración recomendada.
- **🛠️ Ajustes** — modelo/detector/umbral, detección de fotos falsas (experimental), respaldos y privacidad.
- **🎨 Guía de estilo** — colores, botones, etiquetas, avisos y reglas de diseño (Polaris + NHS + fútbol).

**⚙️ (arriba a la derecha)**: encender/apagar la cámara y el *modo prueba* (muestra el puntaje de
parecido y desactiva el reinicio automático del kiosko).

## Diseño

Sistema visual basado en las reglas de **Shopify Polaris** (jerarquía de botones, etiquetas de estado,
avisos, estados vacíos) y del **NHS** (botón principal verde "táctil", foco de teclado amarillo, formularios
paso a paso y textos claros), con identidad de fútbol: verde cancha con contraste AA, balón animado
como indicador de carga, celebración de gol y fondo de cancha en el kiosko. Estilos en `ui/core.py`;
referencia visual en la página **Guía de estilo**.

## Seguridad y datos

- **Autorización del tutor:** para inscribir se exige su nombre y confirmar la autorización firmada
  (`REQUIRE_CONSENT=0` lo desactiva). Los jugadores sin ella quedan marcados en Jugadores.
- **Respaldos:** copia automática diaria de la BD de cada sede en `data/sedes/<slug>/respaldos/` (se guardan
  las últimas 14), más respaldos manuales y descarga desde 🛠️ Ajustes. Al borrar un jugador también se borra
  (fila, embeddings y asistencias, con VACUUM) de todos los respaldos de su sede.
- **Fotos falsas (experimental):** con FasNet, el kiosko rechaza caras mostradas en un celular o papel.
  Viene **desactivado**: en pruebas rechazó por error 4 de 16 fotos reales y hace la verificación ~2,5×
  más lenta. Pruébalo con la cámara real antes de activarlo.

## Cómo mejora con el uso

Cada niño puede tener hasta 10 fotos; al reconocer se compara contra todas y gana la más parecida.
Cuando la cámara no reconoce a un niño, la llegada queda en **🔔 Por revisar** con una miniatura de la
cara (solo en memoria, se borra a las 2 horas). Al indicar quién era, se registra su asistencia y esa foto
se suma a las suyas, así la próxima vez lo reconoce. Si la foto se parece muy poco a las que ya tiene
(¿mala luz o se eligió al niño equivocado?), se registra la asistencia pero **no** se usa para aprender.

## Evaluar qué modelo usar

1. Pon 3–5 fotos distintas por persona en `eval/fotos/<nombre>/` (luz, ángulo y expresión variados;
   pueden ser generadas con IA manteniendo la identidad). Incluye personas parecidas (p. ej. hermanos).
2. Staff → 🧪 Evaluación → **Ejecutar evaluación**, o por consola:
   ```bash
   python scripts/evaluar_modelos.py --aumentar
   ```
3. Revisa la recomendación y pulsa **Aplicar esta configuración**.

El script compara modelos (Facenet512, ArcFace, SFace, GhostFaceNet) y detectores (opencv, yunet,
retinaface), con 1 y 3 fotos de inscripción. Con `--aumentar` agrega versiones oscuras, borrosas,
inclinadas, de baja resolución y con la boca tapada. El umbral recomendado es el mínimo que no acepta
a nadie como otra persona (+0.03 de margen).

> Cambiar de **modelo** invalida las huellas faciales ya guardadas: esos jugadores quedan marcados como
> «Reinscribir» y basta con tomarles una foto nueva (el historial se conserva).

## Configuración

La UI guarda modelo, detector y umbral en `data/sedes/<slug>/config.json` (uno por sede). Prioridad:
valores por defecto < variables de entorno < config.json de la sede.

| Variable          | Default                 | Descripción                                        |
|-------------------|-------------------------|----------------------------------------------------|
| `MATCH_THRESHOLD` | según modelo (Facenet512: `0.70`) | Similitud del coseno mínima para aceptar un match |
| `FACE_MODEL`      | `Facenet512`            | Modelo DeepFace                                    |
| `FACE_DETECTOR`   | `opencv`                | Detector de caras                                  |
| `API_URL`         | `http://127.0.0.1:8000` | URL de la API usada por Streamlit                  |
| `STAFF_PIN`       | `1234`                  | PIN **inicial** de la sede migrada/por defecto (solo al crearla; luego manda el hash en `data/control.db`, cámbialo con `crear_sede.py --cambiar-pin`) |
| `TRUST_PROXY`     | `0`                     | `1` si la API va detrás de un proxy/túnel (usa la IP real del cliente); lo activa `iniciar-demo.bat` |
| `AUTH_SECRET`     | aleatoria por arranque  | Clave que firma las sesiones del staff             |
| `AUTH_TTL_HORAS`  | `12`                    | Duración de la sesión del staff                    |
| `CORS_ORIGINS`    | `http://localhost:3000` | Orígenes web permitidos (separados por coma)       |
| `REQUIRE_CONSENT` | `1`                     | Exigir autorización del tutor para inscribir       |
| `DATA_DIR`        | `data/`                 | Carpeta de datos (control.db, sedes/, voz/). Útil para pruebas con una copia |
| `DEFAULT_SEDE`    | `las-condes`            | Sede usada cuando el login o un endpoint público no indican sede |

## Multi-sede

Una base SQLite por sede, aisladas entre sí:

```
data/control.db                    registro: slug, nombre, hash del PIN (PBKDF2), creada_en, activa
data/sedes/<slug>/asistencia.db    jugadores, fotos, asistencia, categorías, jornadas
data/sedes/<slug>/config.json      modelo, detector, umbral, antispoofing
data/sedes/<slug>/respaldos/
data/voz/                          caché de audio compartida (solo nombres de pila)
```

- **Migración automática** (idempotente, al arrancar): si existe `data/asistencia.db` y la sede `las-condes`
  no está registrada, se crea copiando BD, config y respaldos; el original queda como
  `data/asistencia.db.migrado` (no se borra). Su PIN inicial es `STAFF_PIN`. Instalación nueva sin datos: se
  crea `DEFAULT_SEDE` vacía.
- **Crear una sede** (no hace falta reiniciar la API):
  `.venv\Scripts\python scripts\crear_sede.py providencia "Sede Providencia" --pin 12345678`
  (`--cambiar-pin <pin>` para cambiar el PIN, `--listar` para ver las sedes).
- **Staff:** la sede sale solo del token (claim `sede` firmado); un token nunca opera sobre otra sede.
- **Públicos** (`/verify`, `/kiosko/resumen`): header `X-Sede: <slug>` (o `?sede=`); sin él, `DEFAULT_SEDE`.
  Sede inexistente o inválida → 404 `sede_no_existe`.
- **Categorías:** tabla por sede, sembrada con `Sub-10` (y las que ya usaban los jugadores al migrar).
  En `/enroll`, una categoría que no existe se crea (compatibilidad con la lista fija del frontend); una
  desactivada → 400 `categoria_invalida`.

## API

- `POST /auth/login` — form-data `pin`, `sede?` (default `DEFAULT_SEDE`) → `{"token", "expira_en", "sede": {"slug", "nombre"}}`; 401 PIN incorrecto, 404 sede inexistente, 429 tras 5 fallos (por sede + cliente).
- `GET /sedes/{slug}` (público) → `{"slug", "nombre", "categorias": ["Sub-10", ...]}` (solo activas).
- `GET /categorias`, `POST /categorias` (form `nombre`, `orden?`), `PATCH /categorias/{id}` (form `nombre?`, `orden?`, `activa?`; renombrar actualiza a sus jugadores), `DELETE /categorias/{id}` (desactiva).

- `POST /enroll` — form-data `nombre`, `file` o `files` (hasta 5), `categoria?`, `forzar?` → 409 si parece duplicado, 422 si las fotos no son de la misma persona.
- `POST /verify` — form-data `file` → `{"status": "success", "nombre", "similitud", "ya_registrado", ...}`; 404 si no hay match, 422 si no hay cara.
- `POST /asistencia/manual` — form-data `jugador_id`.
- `GET /pendientes`, `POST /pendientes/{id}/asignar` (form-data `jugador_id`), `DELETE /pendientes/{id}`
- `GET /jugadores`, `POST /jugadores/{id}/foto`, `DELETE /jugadores/{id}` (→ además `respaldos_purgados`, `respaldos_con_error`)
- `GET /asistencias?fecha=YYYY-MM-DD` (o `?hoy=true`)
- `POST /jugadores/{id}/consentimiento` — form-data `tutor`.
- `GET /respaldos`, `POST /respaldos`, `GET /respaldos/{nombre}` (descarga)
- `GET /jornadas?desde&hasta`, `PUT /jornadas/{fecha}` (form-data `tipo`: entrenamiento | partido)
- `GET /reportes?desde&hasta&tipo` (por defecto, últimos 30 días)
- `GET /config`, `PUT /config` — `{"modelo", "detector", "umbral", "antispoofing"?}`
- `GET /health` (público, solo `{"status":"ok"}`) y `GET /health/detalle` (staff)

## Privacidad

Se almacenan datos biométricos de menores: obtén consentimiento de padres/tutores y mantén la BD local
y protegida. Las fotos no se guardan; solo se persisten los embeddings.
