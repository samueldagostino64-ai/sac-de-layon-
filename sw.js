// Sac de Layon : l'appli marche hors ligne une fois ouverte une première fois avec du réseau.
const CACHE = "sac-de-layon-v20";
const CORE = ["./", "index.html", "jspdf.min.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png",
  "fonts/barlow-400.woff2", "fonts/barlow-500.woff2", "fonts/barlow-600.woff2", "fonts/barlow-700.woff2", "fonts/barlow-condensed-600.woff2", "fonts/barlow-condensed-700.woff2"];
// au-delà, on ouvre la version gardée sur le téléphone : une barre de réseau en lisière ne doit pas bloquer l'appli
const NET_WAIT = 2500;
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// seules les vraies réponses (200) remplacent ce qui est en cache : jamais une page d'erreur
const keep = (req, r) => { if (r && r.ok && r.type === "basic") { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; };
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url); if (url.origin !== location.origin) return;
  const net = fetch(req).then(r => keep(req, r));
  e.waitUntil(net.catch(() => {}));
  e.respondWith(new Promise(resolve => {
    let done = false; const give = r => { if (!done && r) { done = true; resolve(r); } };
    const fromCache = () => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === "navigate" ? caches.match("index.html") : null));
    const t = setTimeout(() => fromCache().then(give), NET_WAIT);
    net.then(r => { if (r.ok || !done) { clearTimeout(t); if (r.ok) give(r); else fromCache().then(c => give(c || r)); } })
      .catch(() => { clearTimeout(t); fromCache().then(c => give(c || Response.error())); });
  }));
});
