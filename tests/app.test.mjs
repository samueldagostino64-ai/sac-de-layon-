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

let server, url, browser, slowMs = 0, trickle = false;
before(async () => {
  server = http.createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "") || "index.html";
    if (slowMs) await new Promise(t => setTimeout(t, slowMs));
    try { const body = await readFile(join(ROOT, path)); res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
      // réseau en lisière : la réponse commence vite puis arrive au compte-gouttes (1 Ko toutes les 200 ms)
      if (trickle) { for (let i = 0; i < body.length && trickle; i += 1024) { res.write(body.subarray(i, i + 1024)); await new Promise(t => setTimeout(t, 200)); } return res.end(); }
      res.end(body); }
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
  // l'appli regroupe ses écritures (250 ms) : on laisse passer ce délai avant de lire ce qui est enregistré
  page.stored = async () => { await page.waitForTimeout(350); return page.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY); };
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

test("sécurité : la rubalise n'est pas prise pour une balise satellite", async () => {
  const p = await open({ v: 2, current: "A", gear: {}, hidden: [], exps: [exp({ id: "A", items: [item({ name: "Rubalise", cat: "Navigation & topo" }), item({ name: "GPS Garmin", cat: "Navigation & topo" })] })] });
  await p.click("#homeList .card.big .actions .primary");
  await p.locator("#secTiles button", { hasText: "Sécurité" }).click(); await p.waitForTimeout(150);
  assert.match(await p.textContent("#secBilan"), /✗ Moyen d'alerte satellite/);
  await close(p);
});

test("réseau qui livre au compte-gouttes : l'appli s'ouvre quand même tout de suite", async () => {
  const p = await open();
  await p.evaluate(() => navigator.serviceWorker.ready); await p.reload(); await p.waitForTimeout(500);
  trickle = true;
  try {
    const t0 = Date.now(); await p.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
    assert.ok(Date.now() - t0 < 3000, `ouverture en ${Date.now() - t0} ms`);
    assert.match(await p.textContent("#homeList"), /Ta première expédition/);
  } finally { trickle = false; }
  await close(p);
});

test("bouton retour du téléphone : ferme la fiche, puis revient à l'accueil", async () => {
  const p = await open({ v: 2, current: "A", gear: {}, hidden: [], exps: [exp({ id: "A", items: [item()] })] });
  await p.click("#homeList .card.big .actions .primary");
  await p.locator("#secTiles button", { hasText: "Bivouac" }).click();
  await p.click("#qMore"); assert.equal(await p.isVisible("#sheetOv"), true);
  await p.goBack(); await p.waitForTimeout(200);
  assert.equal(await p.isVisible("#sheetOv"), false, "la fiche se ferme");
  assert.equal(await p.isVisible("#listPanel"), true, "on reste dans la liste");
  await p.goBack(); await p.waitForTimeout(200);
  assert.equal(await p.isVisible("#secHead"), false, "la section se ferme");
  await p.goBack(); await p.waitForTimeout(200);
  assert.equal(await p.isVisible("#homeList"), true, "retour à l'accueil, l'appli reste ouverte");
  await close(p);
});

test("supprimer depuis le menu : confirmation sur place, et « Annuler » rend l'expédition", async () => {
  const p = await open({ v: 2, current: "A", gear: {}, hidden: [], exps: [exp({ id: "A", name: "Garde", items: [item()] }), exp({ id: "B", name: "Jetable", updatedAt: Date.now() + 5, items: [item()] })] });
  await p.locator("#homeList .card", { hasText: "Jetable" }).locator(".cardopen").click();
  await p.click("#btnMore"); await p.click("#btnManage");
  assert.match(await p.textContent("#askOv"), /Supprimer « Jetable »/);
  assert.equal((await p.stored()).exps.length, 2, "rien n'est supprimé avant le oui");
  await p.click("#askYes"); await p.waitForTimeout(200);
  assert.deepEqual((await p.stored()).exps.map(e => e.name), ["Garde"]);
  await p.locator("#toast button", { hasText: "Annuler" }).click();
  assert.equal((await p.stored()).exps.length, 2, "annulation");
  await close(p);
});

test("fiche sécurité sur un téléphone à l'heure de Paris : heures en heure de Guyane", async () => {
  const p = await open({ v: 2, current: "S", gear: {}, hidden: [], exps: [exp({ id: "S", start: iso(3), end: iso(6), items: [item()], safety: { retTime: "18:00", margin: 6 } })] }, { timezoneId: "Europe/Paris" });
  await p.locator("#homeList .card.big .actions button", { hasText: "Fiche sécurité" }).click();
  const msg = await p.textContent("#safeForm .msgprev");
  // retour 18 h + 6 h de marge = minuit, heure de Guyane, quel que soit le fuseau du téléphone
  assert.match(msg, /à 00:00 \(heure de Guyane, soit le .* 0[45]:00 heure de Paris\)/);
  assert.match(msg, /vers 18:00 \(heure de Guyane\)/);
  await close(p);
});

test("noms piégés (« constructor », « __proto__ ») : aucun plantage, l'article est bien enregistré", async () => {
  const p = await open({ v: 2, current: "A", gear: {}, hidden: [], exps: [exp({ id: "A", items: [item()] })] });
  await p.click("#homeList .card.big .actions .primary");
  await p.locator("#secTiles button", { hasText: "Bivouac" }).click();
  for (const n of ["constructor", "__proto__"]) { await p.fill("#qName", n); await p.click("#qAdd"); await p.waitForTimeout(100); }
  const st = await p.stored();
  assert.ok(st.exps[0].items.some(i => i.name === "constructor") && st.exps[0].items.some(i => i.name === "__proto__"));
  assert.equal(st.gear.constructor.name, "constructor");
  await p.click('.tabbar [data-go="mat"]'); assert.match(await p.textContent("#gearList"), /constructor/);
  await close(p);
});

test("restauration : le matériel plus récent du téléphone n'est pas écrasé par une vieille sauvegarde", async () => {
  const p = await open({ v: 2, current: "A", hidden: [], exps: [exp({ id: "A" })], gear: { hamac: { name: "Hamac", cat: "Bivouac", w: 450, updatedAt: Date.now() } } });
  await p.click('.tabbar [data-go="reglages"]'); await p.click("#hSave ~ details summary");
  await p.fill("#importTxt", JSON.stringify({ v: 1, gear: { hamac: { name: "Hamac", cat: "Bivouac", w: 900, updatedAt: 1 }, gourde: { name: "Gourde", cat: "Eau", w: 200, updatedAt: 1 } } }));
  await p.click("#btnImport");
  const g = (await p.stored()).gear;
  assert.equal(g.hamac.w, 450, "le plus récent gagne"); assert.equal(g.gourde.w, 200, "le nouveau arrive");
  await close(p);
});

test("mémoire pleine : bandeau rouge, et une restauration refusée ne laisse pas de fausse alerte", async () => {
  const p = await open({ v: 2, current: "A", gear: {}, hidden: [], exps: [exp({ id: "A", items: [item()] })] });
  await p.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException("plein", "QuotaExceededError"); }; });
  await p.click('.tabbar [data-go="reglages"]'); await p.click("#hSave ~ details summary");
  await p.fill("#importTxt", JSON.stringify({ exps: [{ id: "Z", name: "Nouvelle", items: [] }] })); await p.click("#btnImport"); await p.waitForTimeout(200);
  assert.equal(await p.isVisible("#saveWarn"), false, "rien n'a changé : pas d'alerte");
  await p.click("#homeList .card.big .actions .primary").catch(() => {});
  await p.click('.tabbar [data-go="sac"]'); await p.locator("#sacView .srow").first().click(); await p.waitForTimeout(700);
  assert.equal(await p.isVisible("#saveWarn"), true, "une vraie modification non enregistrée est signalée");
  await close(p);
});

test("version Claude : un envoi refusé par le serveur ne supprime jamais l'expédition", async () => {
  const ctx = await browser.newContext({ ...devices["iPhone 13"], timezoneId: "America/Cayenne" });
  await ctx.addInitScript(([k, v]) => {
    if (!sessionStorage.s) { localStorage.setItem(k, v); sessionStorage.s = 1; }
    const subs = []; window.__snap = () => subs.forEach(f => f({ docs: [] }));
    window.claude = { use: async n => n === "user" ? { id: async () => "moi" } : { collection: () => ({
      onSnapshot: f => { subs.push(f); setTimeout(() => f({ docs: [] }), 50); },
      doc: () => ({ set: async () => { throw new Error("refusé"); }, delete: async () => {} }) }) } };
  }, [KEY, JSON.stringify({ v: 2, current: "L", gear: {}, hidden: [], exps: [exp({ id: "L", name: "Locale", items: [item()] })] })]);
  const p = await ctx.newPage(); p.errors = []; p.on("pageerror", e => p.errors.push(e.message));
  await p.goto(url); await p.waitForTimeout(1500); // premier envoi raté
  await p.evaluate(() => window.__snap()); await p.waitForTimeout(300); // le serveur ne l'a toujours pas
  const st = await p.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
  assert.deepEqual(st.exps.map(e => e.name), ["Locale"]);
  assert.match(await p.textContent("#homeList"), /Locale/);
  assert.doesNotMatch(await p.textContent("#sync"), /^Synchronisé/);
  await close(p);
});

test("Liste pour préparer, Sac pour cocher : la coche du sac est enregistrée", async () => {
  const p = await open({ v: 2, current: "A", gear: {}, hidden: [], exps: [exp({ id: "A", items: [item(), item({ name: "Bâche", id: "b2" })] })] });
  await p.click("#homeList .card.big .actions .primary");
  assert.equal(await p.locator("#list input[type=checkbox]").count(), 0, "pas de case dans la liste");
  assert.ok(await p.isVisible("#list .item"), "les articles se voient tout de suite");
  await p.click('.tabbar [data-go="sac"]'); await p.locator("#sacView .srow", { hasText: "Bâche" }).click(); await p.waitForTimeout(500);
  assert.equal((await p.stored()).exps[0].items.find(i => i.name === "Bâche").done, true);
  await p.click('.tabbar [data-go="liste"]'); assert.match(await p.textContent("#list"), /✓/);
  await close(p);
});

test("pirogue : le calcul du carburant met l'essence et l'huile dans la liste", async () => {
  const p = await open({ v: 2, current: "A", gear: {}, hidden: [], exps: [exp({ id: "A", type: "Remontée de fleuve en pirogue", items: [item({ name: "Essence moteur", cat: "Pirogue", qty: 10, mode: "j", unit: "L" })] })] });
  await p.click("#homeList .card.big .actions .primary");
  await p.locator("#secTiles button", { hasText: "Pirogue" }).first().click();
  const f = lab => p.locator("#fuelBox label", { hasText: lab }).locator("input");
  await f("Montée").fill("5"); await f("Descente").fill("4"); await f("Sur place").fill("1"); await f("Conso").fill("6");
  assert.match(await p.textContent("#fuelBox .res"), /10 h de moteur → 78 L d'essence dont 1,6 L d'huile/);
  await p.click("#fuelBox button"); await p.waitForTimeout(100);
  const its = (await p.stored()).exps[0].items;
  const ess = its.find(i => i.name === "Essence moteur");
  assert.equal(ess.qty, 78); assert.equal(ess.mode, "fixe"); assert.equal(its.find(i => i.name === "Huile 2 temps").qty, 1.6);
  await close(p);
});

test("bilan du retour : ce qui n'a pas servi sort de la liste, ce qui a manqué y entre", async () => {
  const p = await open({ v: 2, current: "A", gear: {}, hidden: [], exps: [exp({ id: "A", start: iso(-10), end: iso(-7), items: [item(), item({ name: "Jeu de cartes", id: "jc", cat: "Jeux de société" })] })] });
  await p.locator("#homeList .card.big .actions button", { hasText: "Bilan du retour" }).click();
  await p.locator("#debBox .debrief-row", { hasText: "Jeu de cartes" }).locator("button", { hasText: "Pas servi" }).click();
  await p.fill("#debBox textarea", "Seconde bâche");
  await p.locator("#debBox .pfoot button").click();
  const e = (await p.stored()).exps[0];
  assert.deepEqual(e.items.map(i => i.name).sort(), ["Hamac", "Seconde bâche"]); assert.ok(e.debriefAt);
  await close(p);
});

test("aucune donnée n'est insérée comme du HTML (protection contre l'injection)", async () => {
  const html = await readFile(join(ROOT, "index.html"), "utf8");
  const bad = [...html.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map(m => m[1].trim())
    .filter(v => !/^(""|ico\("[a-z]+"\)|ico\([a-z.]+\)|label|typeSvg\([^)]*\)|"<b><\/b>(<small><\/small>)?"|UNITS\.map\(u => `<option value="\$\{u\}"><\/option>`\)\.join\(""\))$/.test(v));
  assert.deepEqual(bad, []);
});

test("boussole : cap lu sur le capteur, déclinaison de Guyane ajoutée au cap de la carte, consigne gauche/droite", async () => {
  const p = await open();
  await p.click('.tabbar [data-go="boussole"]');
  const turn = alpha => p.evaluate(a => { for (let i = 0; i < 20; i++) window.dispatchEvent(new DeviceOrientationEvent("deviceorientationabsolute", { alpha: a, beta: 0, gamma: 0, absolute: true })); }, alpha);
  await turn(360 - 75);
  assert.equal(await p.textContent("#cmpDeg"), "75°");
  assert.match(await p.textContent("#cmpSub"), /sur la carte : 57°/); // 75 − 18,5
  await p.fill("#cmpTgt", "90"); await p.check("#cmpMap");
  assert.match(await p.textContent("#cmpInfo"), /108,5° \(E\).*Azimut retour : 288,5°/);
  assert.equal(await p.textContent("#cmpTurn"), "Tourne de 34° à droite");
  await turn(360 - 120);
  assert.match(await p.textContent("#cmpTurn"), /à gauche/);
  await turn(360 - 108);
  assert.equal(await p.textContent("#cmpTurn"), "Dans l'axe");
  assert.deepEqual(await p.evaluate(() => JSON.parse(localStorage.getItem("sacdelayon.boussole"))), { decl: 18.5, tgt: 90, map: true });
  await close(p);
});

test("boussole : sans capteur magnétique, l'appli le dit et renvoie à la boussole à plaque", async () => {
  const p = await open();
  await p.click('.tabbar [data-go="boussole"]'); await p.waitForTimeout(3300);
  assert.match(await p.textContent("#cmpMsg"), /Pas de capteur magnétique/);
  assert.ok(await p.isVisible("#cmpStart"));
  await close(p);
});

test("urgences : « perdu » ouvre la boussole sur la conduite à tenir", async () => {
  const p = await open();
  await p.click("#btnUrg"); await p.locator("#urgBox details", { hasText: "Perdu" }).click(); await p.click("#urgLost");
  assert.ok(await p.isVisible("#cmpPanel"));
  assert.equal(await p.evaluate(() => document.getElementById("cmpLost").open), true);
  await close(p);
});

test("don : proposé quand le sac est bouclé, une seule fois par expédition, et toujours dans Réglages", async () => {
  const its = [item({ name: "Bâche", done: true }), item({ name: "Hamac" })];
  const p = await open({ v: 2, current: "A", gear: {}, hidden: [], exps: [exp({ id: "A", items: its })] });
  await p.click("#homeList .card.big .actions .primary"); await p.click('.tabbar [data-go="sac"]');
  await p.locator("#sacView .srow", { hasText: "Hamac" }).click(); await p.waitForTimeout(1200);
  assert.ok(await p.isVisible("#doneDon .don-go"), "encart de don sous « sac bouclé »");
  assert.equal(await p.getAttribute("#doneDon .don-go", "href"), "https://ko-fi.com/sacdelayon");
  // l'expé est notée : on ne redemandera pas pour elle
  assert.deepEqual(await p.evaluate(() => JSON.parse(localStorage.getItem("sacdelayon.don")).seen), ["A"]);
  await p.click("#doneClose"); await p.click('.tabbar [data-go="reglages"]');
  assert.ok(await p.isVisible("#setDon .don-go"));
  assert.equal(await p.isVisible("#urgOv .don"), false);
  await close(p);
});
