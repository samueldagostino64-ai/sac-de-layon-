// Sac de Layon : l'appli marche hors ligne une fois ouverte une première fois avec du réseau.
// Stratégie : on ouvre tout de suite ce qui est gardé sur le téléphone, et on met à jour en arrière-plan.
// Une barre de réseau en lisière ne retarde donc jamais l'ouverture ; la nouvelle version s'affiche à l'ouverture suivante.
const CACHE = "sac-de-layon-v36";
const CORE = ["./", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png",
  "fonts/barlow-400.woff2", "fonts/barlow-500.woff2", "fonts/barlow-600.woff2", "fonts/barlow-700.woff2", "fonts/barlow-condensed-600.woff2", "fonts/barlow-condensed-700.woff2"];
// la bibliothèque PDF (300 Ko) n'est pas nécessaire pour ouvrir l'appli : elle est mise en cache après coup
const LATER = ["jspdf.min.js"];
self.addEventListener("install", e => {
  // cache: "reload" : on prend les fichiers sur le serveur, jamais une vieille copie du navigateur (pas de mélange de versions)
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
    .then(() => caches.open(CACHE).then(c => Promise.all(LATER.map(u => c.match(u).then(r => r || c.add(new Request(u, { cache: "reload" })).catch(() => {})))))));
});
// une seule copie par adresse : les paramètres (?urg=1…) et index.html pointent sur la même page
const keyOf = req => { const u = new URL(req.url); u.search = ""; if (req.mode === "navigate" || u.pathname.endsWith("/index.html")) u.pathname = u.pathname.replace(/index\.html$/, ""); return u.href; };
// seules les vraies réponses (200) remplacent ce qui est en cache : jamais une page d'erreur
const keep = (key, r) => { if (r && r.ok && r.type === "basic") { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); } return r; };
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url); if (url.origin !== location.origin) return;
  const key = keyOf(req);
  const net = fetch(req, { cache: "no-cache" }).then(r => keep(key, r));
  e.waitUntil(net.catch(() => {}));
  e.respondWith(caches.match(key).then(hit => hit || net.catch(() => caches.match(req.mode === "navigate" ? new URL("./", location.href).href : key)).then(r => r || Response.error())));
});
