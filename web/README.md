# Kiosko web FA CUP Chile

Frontend del kiosko de llegada: Next.js + React + TypeScript + Tailwind v4 + Motion + MediaPipe.
Reemplaza al kiosko de Streamlit; el panel del staff sigue en Streamlit por ahora.

## Cómo funciona

Dirección visual minimal, tipo Face ID: fondo negro, la cámara solo dentro de un círculo, un anillo de marcas
finas y texto limpio (Geist). El único color es el verde FA CUP; ámbar y rojo solo para avisos.

- **Inicio** (sin nadie cerca): fotos de facupchile.cl en 3D, oscurecidas con tono de cine. Un mapa de
  profundidad (MiDaS) mueve cada píxel según qué tan cerca está; la foto se mueve sola, lento, y si alguien pasa
  sigue su cabeza como una ventana. Al acercarse, se desvanece y aparece la cámara. Para sumar fotos:
  `python scripts/foto_inicio.py foto.jpg nombre` (desde la raíz) y agrégala a `FOTOS` en `Inicio.tsx`.
- **MediaPipe Face Landmarker** sigue la cara en el navegador (el video no sale del equipo) y guía al niño
  («Acércate un poco», «Centra tu cara»). Las marcas del anillo se encienden en verde mientras se queda quieto.
- Al completarse el anillo la foto **se saca sola** y se manda a la API (`POST /verify`, FastAPI + DeepFace).
- Registrado: el anillo queda verde, se dibuja un check y aparece su nombre con la hora. Si no lo reconoce, el
  anillo se pone ámbar con el motivo; si el sistema falla, rojo.
- Tras un resultado no vuelve a escanear a quien sigue frente a la cámara (hasta que salga o pasen 6 s).

## Uso

```bash
npm install        # también deja listo MediaPipe en public/ (wasm + modelo, ~40 MB, no se versionan)
npm run dev        # desarrollo en http://localhost:3000
npm run build && npm start   # producción (lo hace iniciar.bat)
```

La API debe estar corriendo (por defecto en `http://127.0.0.1:8000`; cambia con la variable `API_URL`).
El navegador la llama en `/api/*` en el mismo origen (ver `next.config.ts`), así que no hace falta CORS.

Parámetros de la URL:
- `?voz=0` apaga el saludo hablado.
- `?prueba=1` deja el resultado en pantalla hasta tocarla (para revisar con el staff).

## Archivos

```
src/components/kiosko/Inicio.tsx         pantalla de inicio con fotos 3D (Foto3D.tsx: shader WebGL)
src/components/kiosko/Escaner.tsx        anillo de marcas, progreso y check (SVG + Motion)
src/components/kiosko/Kiosko.tsx         pantalla y estados (escaneando → enviando → resultado)
src/components/kiosko/useRastreoCara.ts  MediaPipe: postura, progreso del anillo y captura automática
src/components/kiosko/Mascota.tsx        mascota por estado (public/mascota/<estado>.png)
src/lib/api.ts, src/lib/voz.ts           cliente de la API y saludo hablado
scripts/preparar-mediapipe.mjs           copia el wasm y descarga el modelo (postinstall)
```

## Mascota

Pon las imágenes en `public/mascota/` con los nombres del README de esa carpeta. Mientras falten, no se muestra
nada y el kiosko funciona igual. Los mismos 8 estados sirven para una animación Rive más adelante.
