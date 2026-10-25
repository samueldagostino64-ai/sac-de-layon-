// Tests de bout en bout : l'appli est servie en local et pilotée dans Chromium (téléphone simulé).
// Lancer : npm install && npx playwright install chromium && npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".webmanifest": "application/manifest+json", ".png": "image/png", ".woff2": "font/woff2", ".jpg": "image/jpeg", ".txt": "text/plain" };
const KEY = "sacdelayon.v1";
const iso = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const item = o => ({ id: "i" + Math.random().toString(36).slice(2, 8), name: "Hamac", cat: "Bivouac", qty: 1, mode: "fixe", unit: "pièce", w: 0, L: 0, l: 0, H: 0, v: 0, note: "", done: false, ...o });
const exp = o => ({ id: "e" + Math.random().toString(36).slice(2, 8), name: "Test", type: "", days: 4, nights: 3, people: 3, reserve: 1, items: [], updatedAt: Date.now(), ...o });

let server, url, browser, slowMs = 0;
before(async () => {
  server = http.createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "") || "index.html";
    if (slowMs) await new Promise(t => setTimeout(t, slowMs));
    try { const body = await readFile(join(ROOT, path)); res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}/index.html`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

// ouvre l'appli, avec des données déjà enregistrées si on en donne ; échoue sur toute erreur JavaScript
async function open(seed, opts = {}) {
  const ctx = await browser.newContext({ ...devices["iPhone 13"], timezoneId: "America/Cayenne", ...opts });
  if (seed !== undefined) await ctx.addInitScript(([k, v]) => { if (!sessionStorage.s) { localStorage.setItem(k, v); sessionStorage.s = 1; } }, [KEY, typeof seed === "string" ? seed : JSON.stringify(seed)]);
  const page = await ctx.newPage(); page.errors = [];
  page.on("pageerror", e => page.errors.push(e.message));
  await page.goto(url); await page.waitForTimeout(300);
  page.stored = () => page.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
  return page;
}
const close = async p => { assert.deepEqual(p.errors, [], "erreur JavaScript"); await p.context().close(); };

test("démarre sans erreur sur l'accueil", async () => {
  const p = await open();
  assert.match(await p.textContent("#homeList"), /Ta première expédition/);
  await close(p);
});

test("démarrage guidé : le pack calcule les quantités par personne et par jour, réserve comprise", async () => {
  const p = await open();
  await p.click("#homeList .primary"); await p.fill("#wName", "Saut Takari");
  await p.click("#wizard .wnav .primary");
  await p.click('#wizard [aria-label="Personnes plus un"]'); // 3 personnes, 3 jours, 1 de réserve
  await p.click("#wizard .wnav .primary");
  await p.click("#wizard .choice.primary"); await p.waitForTimeout(200);
  await p.locator("#packBox label", { hasText: "Ration lyophilisée" }).first().click();
  await p.locator("#packOv .primary", { hasText: /Ajouter|Coche/ }).last().click(); await p.waitForTimeout(200);
  const ration = (await p.stored()).exps[0].items.find(i => i.name === "Ration lyophilisée");
  assert.ok(ration, "article ajouté"); assert.equal(ration.mode, "pj");
  // 2 sachets × 3 personnes × (3 jours + 1 de réserve)
  assert.match(await p.textContent("#list"), /24 sachets/);
  await close(p);
});

test("la virgule française est comprise : « 1,5 » reste 1,5", async () => {
  const p = await open({ v: 2, current: "A", gear: {}, hidden: [], exps: [exp({ id: "A", items: [item()] })] });
  await p.click("#homeList .card.big .actions .primary");
  await p.locator("#list .item .nm").first().click(); await p.waitForTimeout(150);
  const edit = p.locator("#list button", { hasText: "Modifier" }).first(); if (await edit.count()) await edit.click();
  await p.fill("#fQty", "1,5"); await p.click("#fSubmit"); await p.waitForTimeout(150);
  assert.equal((await p.stored()).exps[0].items[0].qty, 1.5);
  await close(p);
});

test("des données abîmées ne bloquent pas l'appli", async () => {
  const p = await open({ exps: [{ id: "a", name: "Nulls", items: [null, { name: "ok", qty: 1, mode: "fixe" }, { id: "x" }] }, null, "x"], current: "a" });
  assert.match(await p.textContent("#homeList"), /Nulls/);
  await p.click("#homeList .card.big .actions .primary");
  assert.equal(await p.locator("#list .item").count(), 1);
  await close(p);
});

test("mémoire illisible : copiée de côté, jamais écrasée sans copie", async () => {
  const p = await open('{"exps":[{"id":"a","name":"Precieux"');
  const copies = await p.evaluate(() => Object.keys(localStorage).filter(k => k.includes("corrupt")).map(k => localStorage.getItem(k)));
  assert.equal(copies.length, 1); assert.match(copies[0], /Precieux/);
  await close(p);
});

test("fiche sécurité : « envoyée » seulement après confirmation, « à renvoyer » si l'heure change", async () => {
  const p = await open({ v: 2, current: "S", gear: {}, hidden: [], exps: [exp({ id: "S", start: iso(3), end: iso(6), items: [item()] })] });
  await p.evaluate(() => { HTMLAnchorElement.prototype.click = function () {}; });
  await p.locator("#homeList .card.big .actions button", { hasText: "Fiche sécurité" }).click();
  const field = lab => p.locator("#safeForm label.field", { hasText: lab }).locator("input,select,textarea").first();
  await field("Téléphone").fill("abc");
  await p.locator("#safeActions button", { hasText: "WhatsApp" }).click();
  assert.equal(await p.isVisible("#safeAsk"), false, "numéro invalide refusé");
  await field("Téléphone").fill("0694 12 34 56");
  await p.locator("#safeActions button", { hasText: "WhatsApp" }).click();
  assert.equal((await p.stored()).exps[0].safety.sentAt, undefined);
  await p.locator("#safeAsk button", { hasText: "Oui" }).click();
  assert.ok((await p.stored()).exps[0].safety.sentAt);
  assert.match(await p.textContent("#safeForm .msgprev"), /heure de Guyane/);
  await field("vers").fill("20:00"); await p.click("#safeClose");
  assert.match(await p.textContent("#homeList .card.big"), /à renvoyer/);
  await close(p);
});

test("hors ligne : l'appli se rouvre sans réseau après une première visite", async () => {
  const p = await open();
  await p.evaluate(() => navigator.serviceWorker.ready); await p.reload(); await p.waitForTimeout(500);
  await p.context().setOffline(true);
  await p.reload(); await p.waitForTimeout(500);
  assert.match(await p.textContent("#homeList"), /Ta première expédition/);
  const font = await p.evaluate(async () => (await document.fonts.load('700 16px "Barlow Condensed"')).length > 0);
  assert.ok(font, "polices disponibles hors ligne");
  await close(p);
});

test("réseau très lent : l'appli s'ouvre depuis le téléphone sans attendre", async () => {
  const p = await open();
  await p.evaluate(() => navigator.serviceWorker.ready); await p.reload(); await p.waitForTimeout(500);
  // une barre de réseau : le serveur met 20 s à répondre
  slowMs = 20000;
  try {
    const t0 = Date.now(); await p.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
    assert.ok(Date.now() - t0 < 8000, `ouverture en ${Date.now() - t0} ms`);
    assert.match(await p.textContent("#homeList"), /Ta première expédition/);
  } finally { slowMs = 0; }
  await close(p);
});

test("le numéro de version affiché correspond au cache du service worker", async () => {
  const html = await readFile(join(ROOT, "index.html"), "utf8"), sw = await readFile(join(ROOT, "sw.js"), "utf8");
  const v = html.match(/Sac de Layon · version (\d+)/)[1];
  assert.match(sw, new RegExp(`const CACHE = "sac-de-layon-v${v}"`), "monter CACHE dans sw.js avec la version");
  for (const f of sw.match(/CORE = \[([^\]]+)\]/)[1].match(/"([^"]+)"/g).map(s => s.slice(1, -1)).filter(f => f !== "./"))
    await readFile(join(ROOT, f)); // chaque fichier mis en cache existe
});

test("sécurité : le bilan signale ce qui manque, la trousse s'ajoute avec ses consignes, les gestes d'urgence s'ouvrent", async () => {
  const p = await open({ v: 2, current: "A", gear: {}, hidden: [], exps: [exp({ id: "A", people: 3, items: [item()] })] });
  await p.click("#homeList .card.big .actions .primary");
  await p.locator("#secTiles button", { hasText: "Sécurité" }).click(); await p.waitForTimeout(150);
  assert.match(await p.textContent("#secBilan"), /5 points à régler/);
  await p.locator("#secBilan button", { hasText: "Ajouter la trousse" }).click(); await p.waitForTimeout(200);
  for (const c of ["Trousse journée", "Trousse camp"]) await p.locator("#packBox .cat", { hasText: c }).locator("h3 .iconbtn").click();
  await p.locator("#packBox label", { hasText: "Balise satellite" }).first().click();
  await p.locator("#packOv .primary", { hasText: /Ajouter/ }).last().click(); await p.waitForTimeout(200);
  const items = (await p.stored()).exps[0].items;
  const garrot = items.find(i => i.name === "Garrot tourniquet");
  assert.ok(garrot && garrot.cat === "Trousse journée" && garrot.mode === "p", "garrot par personne");
  assert.match(garrot.note, /JAMAIS pour une morsure de serpent/);
  assert.match(items.find(i => i.name === "Ibuprofène").note, /dengue/);
  assert.match(await p.textContent("#list"), /30 pièces/); // 10 compresses × 3 personnes
  assert.match(await p.textContent("#secBilan"), /1 point à régler/);
  await p.locator("#secBilan button", { hasText: "Gestes d'urgence" }).click(); await p.waitForTimeout(150);
  assert.equal(await p.isVisible("#urgOv"), true);
  assert.match(await p.textContent("#urgOv"), /paracétamol uniquement/);
  await p.keyboard.press("Escape"); assert.equal(await p.isVisible("#urgOv"), false);
  await close(p);
});
