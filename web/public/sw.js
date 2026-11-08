/* Service worker de FA CUP Chile (vanilla). Todo con rutas relativas al origen: sobrevive a que cambie la URL del túnel.
   Subir VERSION cada vez que cambie la lógica o la lista de precaché; las cachés "facup-*" de otras versiones se borran al activar. */
const VERSION = "v1";
const PRE = `facup-pre-${VERSION}`; // precaché (modelo, wasm, offline)
const RUN = `facup-run-${VERSION}`; // estáticos en tiempo de ejecución
const PAGES = `facup-pages-${VERSION}`; // HTML públicos (última copia buena)
const OFFLINE = "/offline.html";
const DEV = ["localhost", "127.0.0.1", "[::1]"].includes(self.location.hostname);

// Imprescindible: sin esto no hay página offline, así que si falla se reintenta la instalación.
const CRITICOS = [OFFLINE, "/manifest.webmanifest", "/iconos/icono-192.png", "/iconos/icono-512.png"];
// Pesados: modelo de MediaPipe y WASM que usa el kiosko (useRastreoCara). Si uno falla no bloquea la instalación.
const PESADOS = [
  "/models/face_landmarker.task",
  "/mediapipe/vision_wasm_internal.js",
  "/mediapipe/vision_wasm_internal.wasm",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const c = await caches.open(PRE);
      await c.addAll(CRITICOS);
      await Promise.allSettled(PESADOS.map((u) => c.add(u)));
      // La versión nueva toma el control sin esperar; las pestañas abiertas siguen con su HTML hasta la próxima navegación.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const vivas = new Set([PRE, RUN, PAGES]);
      for (const k of await caches.keys()) if (k.startsWith("facup-") && !vivas.has(k)) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

const esPublica = (p) => !p.startsWith("/staff") && !p.startsWith("/api/");
const cacheable = (r) => {
  if (!r || r.status !== 200 || r.type !== "basic") return false;
  const cc = (r.headers.get("cache-control") || "").toLowerCase();
  return !/no-store|private/.test(cc) && !r.headers.has("set-cookie");
};

async function cacheFirst(req, nombre) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) (await caches.open(nombre)).put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUN);
  const hit = await cache.match(req);
  const red = fetch(req)
    .then((res) => {
      if (cacheable(res)) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (hit) return hit;
  return (await red) || Response.error();
}

async function navegacion(req, url) {
  const publica = esPublica(url.pathname);
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000); // red muy lenta: mejor la última copia buena
    const res = await fetch(req, { signal: ctl.signal });
    clearTimeout(t);
    if (publica && cacheable(res)) (await caches.open(PAGES)).put(req, res.clone());
    return res;
  } catch {
    if (publica) {
      const hit = await caches.match(req, { cacheName: PAGES });
      if (hit) return hit;
    }
    return (await caches.match(OFFLINE)) || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // nunca POST ni nada que escriba
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p === "/api" || p.startsWith("/api/")) return; // API: siempre red, nunca caché
  if (req.headers.has("authorization")) return;
  if (req.headers.has("range")) return; // audio/video con Range: que responda la red
  if (url.searchParams.has("_rsc") || req.headers.has("rsc")) return; // payloads RSC de Next: red

  if (req.mode === "navigate") {
    event.respondWith(navegacion(req, url));
    return;
  }
  if (p.startsWith("/_next/static/")) {
    if (DEV) return; // en dev los chunks no llevan hash: no cachear
    event.respondWith(cacheFirst(req, RUN)); // inmutables (hash en el nombre)
    return;
  }
  if (p.startsWith("/models/") || p.startsWith("/mediapipe/")) {
    event.respondWith(cacheFirst(req, PRE)); // pesados: la versión del SW los invalida
    return;
  }
  if (/^\/(sonidos|iconos|inicio|mascota)\//.test(p) || p === "/logo-blanco.png" || p === "/manifest.webmanifest" || p === OFFLINE || /\.(?:woff2?|ttf|otf)$/.test(p)) {
    event.respondWith(staleWhileRevalidate(req));
  }
});
