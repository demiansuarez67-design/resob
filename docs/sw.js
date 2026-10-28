/* RESO - service worker: permite instalar la aplicación y abrirla sin conexión.
   Al publicar cambios, aumentar VERSION para que todos reciban el aviso de actualización. */
const VERSION = "reso-1.0.3";
const NUCLEO = [
  "./", "index.html", "css/reso.css", "js/reso.js", "manifest.webmanifest",
  "vendor/pdfjs/pdf.min.js", "vendor/pdfjs/pdf.worker.min.js", "vendor/tesseract/tesseract.min.js",
  "icons/icono-192.png", "icons/icono-512.png", "icons/favicon.png", "icons/logo-encabezado.png",
];
// Los archivos del OCR (unos 6 MB) se guardan recién la primera vez que se usan.

self.addEventListener("install", ev => {
  ev.waitUntil(caches.open(VERSION).then(c => c.addAll(NUCLEO)));
});

self.addEventListener("message", ev => { if (ev.data === "activar") self.skipWaiting(); });

self.addEventListener("activate", ev => {
  ev.waitUntil((async () => {
    for (const nombre of await caches.keys()) if (nombre.startsWith("reso-") && nombre !== VERSION) await caches.delete(nombre);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", ev => {
  const req = ev.request, url = new URL(req.url);
  // Huarpe y el sitio de la facultad no pasan por acá: siempre se consultan en vivo.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  ev.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const guardado = await cache.match(req, {ignoreSearch: true}) || (req.mode === "navigate" ? await cache.match("index.html") : null);
    if (guardado && url.pathname.includes("/vendor/")) return guardado;      // bibliotecas: no cambian
    const deRed = fetch(req).then(r => { if (r.ok) cache.put(req, r.clone()); return r; });
    if (guardado){ ev.waitUntil(deRed.catch(() => {})); return guardado; }   // rápido y sin conexión; se actualiza por detrás
    return deRed;
  })());
});
