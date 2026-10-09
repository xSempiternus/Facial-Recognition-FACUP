# Kiosko web FA CUP Chile

Frontend del kiosko de llegada: Next.js + React + TypeScript + Tailwind v4 + Motion + MediaPipe.
Reemplaza al kiosko de Streamlit; el panel del staff sigue en Streamlit por ahora.

## Cómo funciona

- La cámara ocupa la pantalla y encima van las líneas de la cancha. El **círculo central** es donde va la cara.
- **MediaPipe Face Landmarker** sigue la cara en el navegador (el video no sale del equipo): dibuja la malla,
  guía al niño («Acércate un poco», «Al centro de la cancha») y llena el anillo mientras se queda quieto.
- Al llenarse el anillo la foto **se saca sola** y se manda a la API (`POST /verify`, FastAPI + DeepFace).
- Registrado: el círculo central se expande en verde y aparece su nombre. Ya registrado: lo mismo en verde oscuro.
  Error: tarjeta amarilla (vuelve a intentar) o roja (llama al staff).
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
src/components/kiosko/Kiosko.tsx         pantalla y estados (escaneando → enviando → resultado)
src/components/kiosko/useRastreoCara.ts  MediaPipe: malla, postura, anillo y captura automática
src/components/kiosko/Cancha.tsx         líneas de cal y anillo del círculo central (SVG + Motion)
src/components/kiosko/Resultado.tsx      momento gol y tarjetas del árbitro
src/components/kiosko/Mascota.tsx        mascota por estado (public/mascota/<estado>.png)
src/lib/api.ts, src/lib/voz.ts           cliente de la API y saludo hablado
scripts/preparar-mediapipe.mjs           copia el wasm y descarga el modelo (postinstall)
```

## Mascota

Pon las imágenes en `public/mascota/` con los nombres del README de esa carpeta. Mientras falten, no se muestra
nada y el kiosko funciona igual. Los mismos 8 estados sirven para una animación Rive más adelante.
