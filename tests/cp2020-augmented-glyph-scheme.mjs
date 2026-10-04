/** Compendium glyph colour keeper.
 *
 *  The 35 glyphs in img/icons/ shipped black-on-transparent for seven weeks and were unreadable on
 *  every dark surface; the check that passed them proved the paths resolved, never that a reader
 *  could see the picture. This suite locks down what was missing:
 *
 *   A  SOURCE — every glyph file carries exactly one fill and it is white, and the rig serves the
 *      same bytes the repo holds (a stale serve copy certifies nothing)
 *   B  SCHEME FOLLOWING — on three surfaces (shop catalog, compendium window, item sheet) and in
 *      all four applications/interface scheme pairs, a glyph's computed filter is the one its
 *      NEAREST themed ancestor asks for; an image that is not a glyph is left alone
 *   C  READABILITY — measured, not inferred: the rendered glyph is screenshotted where it sits and
 *      the luminance spread between figure and ground must clear a floor. The measure is proven
 *      able to fail first (the wrong filter forced on the same element drops below the floor).
 *
 *  Run:  node tests/cp2020-augmented-glyph-scheme.mjs            (rig :30004)
 *  Screenshots:  node <this> --shots <dir>
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICONS = path.join(HERE, "..", "img", "icons");
const SHOTS = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? process.argv[i + 1] : null; })();
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

/** Figure-to-ground luminance spread a readable glyph must clear (0-255 scale). Measured on the rig:
 *  white on the dark sheet and black on core's parchment both sit above 150; the wrong colour on
 *  either ground sits below 60. */
const SPREAD_FLOOR = 110;
const PAIRS = [["dark", "dark"], ["light", "light"], ["light", "dark"], ["dark", "light"]];

async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

let fail = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) fail++; };

// ── A. SOURCE ────────────────────────────────────────────────────────────────────────────────────
const files = fs.readdirSync(ICONS).filter(f => f.endsWith(".svg"));
const fills = files.map(f => ({ f, fills: fs.readFileSync(path.join(ICONS, f), "utf8").match(/fill="[^"]*"/g) ?? [] }));
const notWhite = fills.filter(x => x.fills.length !== 1 || x.fills[0] !== 'fill="#fff"');
// 35 → 52 (2026-10-04): seventeen glyphs for cyberware and vehicle-weapon kinds joined the set.
check("A1 every glyph file carries one fill, and it is white", files.length === 52 && notWhite.length === 0,
  `${files.length} files, ${notWhite.length} off: ${notWhite.slice(0, 4).map(x => `${x.f} ${x.fills.join("/")}`).join("; ")}`);

// One glyph per weapon category (user ruling 2026-10-03: "visual consistency helps players see what an
// item is at a glance"). The key is the item's own weaponType. Heavy keeps its four families; a
// bullet-firing automatic in Heavy is a machine gun, never a launcher.
const ONE_GLYPH = { Pistol: "pistol-gun", SMG: "mp5", Rifle: "fn-fal", Shotgun: "sawed-off-shotgun" };
const HEAVY_FAMILIES = new Set(["grenade", "machine-gun", "missile-launcher", "cannon"]);
const PACKS = path.join(HERE, "..", "src", "packs");
const weapons = [];
for (const pack of fs.readdirSync(PACKS)) {
  const dir = path.join(PACKS, pack); if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (d.type === "weapon") weapons.push({ pack, id: d._id, name: d.name, type: d.system.weaponType, attackType: d.system.attackType, ammo: d.system.ammoType ?? "", glyph: String(d.img).split("/").pop().replace(".svg", "") });
  }
}
const mixed = weapons.filter(w => ONE_GLYPH[w.type] && w.glyph !== ONE_GLYPH[w.type]);
check("A4 pistols, SMGs, rifles and shotguns each carry their one category glyph", weapons.length > 200 && mixed.length === 0,
  `${weapons.filter(w => ONE_GLYPH[w.type]).length} weapons, ${mixed.length} off: ${mixed.slice(0, 4).map(w => `${w.name} has ${w.glyph}`).join("; ")}`);
const heavy = weapons.filter(w => w.type === "Heavy");
const strayHeavy = heavy.filter(w => !HEAVY_FAMILIES.has(w.glyph));
const autoBullets = heavy.filter(w => w.attackType === "Auto" && w.glyph !== "cannon" && !/grenade|mortar|minelet|auto-?gl\b/i.test(`${w.name} ${w.ammo}`));
const wrongAuto = autoBullets.filter(w => w.glyph !== "machine-gun");
check("A5 every heavy weapon carries one of the four heavy family glyphs", heavy.length > 0 && strayHeavy.length === 0,
  `${heavy.length} heavy, ${strayHeavy.length} off: ${strayHeavy.slice(0, 4).map(w => `${w.name} has ${w.glyph}`).join("; ")}`);
check("A6 a bullet-firing automatic in the heavy pack is a machine gun, not a launcher", autoBullets.length >= 15 && wrongAuto.length === 0,
  `${autoBullets.length} automatics, ${wrongAuto.length} off: ${wrongAuto.slice(0, 4).map(w => `${w.name} has ${w.glyph}`).join("; ")}`);

const errors = [];
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1700, height: 950 } });
p.on("pageerror", e => errors.push(String(e)));
p.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await joinGM(p);

const served = await p.evaluate(async () => {
  const get = async (u) => (await fetch(u, { cache: "no-store" })).text();
  return { glyph: await get("/modules/cp2020-augmented/img/icons/mp5.svg"), css: await get("/modules/cp2020-augmented/css/cp2020-augmented.css") };
});
check("A2 the rig serves the repo's glyph bytes", served.glyph === fs.readFileSync(path.join(ICONS, "mp5.svg"), "utf8"));
check("A3 the rig serves the repo's stylesheet", served.css === fs.readFileSync(path.join(HERE, "..", "css", "cp2020-augmented.css"), "utf8"));

// The compiled packs the rig serves must carry the glyph the sources name (a stale compile shows the old picture).
const servedGlyphs = await p.evaluate(async () => {
  const out = {};
  for (const pack of game.packs.filter(x => x.metadata.packageName === "cp2020-augmented" && x.metadata.type === "Item")) {
    for (const e of await pack.getIndex()) out[e._id] = String(e.img).split("/").pop().replace(".svg", "");
  }
  return out;
});
const staleGlyph = weapons.filter(w => servedGlyphs[w.id] !== w.glyph);
check("A7 the rig's compiled packs carry the glyph each weapon source names", staleGlyph.length === 0,
  `${weapons.length} weapons, ${staleGlyph.length} differ: ${staleGlyph.slice(0, 4).map(w => `${w.name} source ${w.glyph} / served ${servedGlyphs[w.id]}`).join("; ")}`);

/** Luminance spread of a screenshot: the 97th minus the 3rd percentile, decoded in the page. */
const spreadOf = async (buf) => p.evaluate(async (b64) => {
  const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
  const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext("2d"); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data; const lum = [];
  for (let i = 0; i < d.length; i += 4) lum.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
  lum.sort((x, y) => x - y);
  return Math.round(lum[Math.floor(lum.length * 0.97)] - lum[Math.floor(lum.length * 0.03)]);
}, buf.toString("base64"));

// ── D. PLACEHOLDER PICTURES ──────────────────────────────────────────────────────────────────────
// A base-system weapon stores the generic weapon icon. It must SHOW its category glyph on every surface
// (document, shop row, compendium window list) while its stored picture stays exactly as it was.
const D = await p.evaluate(async () => {
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  const tail = s => String(s ?? "").split("/").pop();
  const out = {};
  const pack = game.packs.get("cyberpunk2020.submachineguns");
  const doc = await pack.getDocument("ZPRv9RxGpq4xZfaV");                       // H&K MP5, a core SMG
  out.doc = { shown: tail(doc.img), stored: doc._source.img, exported: doc.toObject().img };
  const melee = game.packs.get("cyberpunk2020.melee");
  const mi = await melee.getIndex({ fields: ["system.attackType", "system.isEdged", "img"] });
  const kick = mi.find(e => /kick-icon/.test(e.img));
  out.ownArt = kick ? { shown: tail((await melee.getDocument(kick._id)).img), stored: tail(kick.img) } : null;
  // a world weapon nobody gave a picture, and one somebody did
  for (const i of game.items.filter(x => /^__PW__ glyph/.test(x.name))) await i.delete();
  const plain = await Item.create({ name: "__PW__ glyph plain", type: "weapon", system: { weaponType: "Rifle" } });
  const custom = await Item.create({ name: "__PW__ glyph custom", type: "weapon", img: "icons/svg/explosion.svg", system: { weaponType: "Rifle" } });
  out.world = { plainShown: tail(plain.img), plainStored: plain._source.img, customShown: tail(custom.img) };
  await plain.update({ "system.weaponType": "Pistol" });
  out.world.afterRetype = tail(plain.img);
  await plain.delete(); await custom.delete();
  // the shop's index rows
  const cat = await import("/modules/cp2020-augmented/module/shop/catalog.js");
  const all = await cat.getCatalogIndex();
  const G = await import("/modules/cp2020-augmented/module/item-glyphs.js");
  const weapons = all.filter(r => r.type === "weapon");
  out.shop = { weapons: weapons.length, placeholders: weapons.filter(r => G.isPlaceholderIcon(r.img)).map(r => `${r.name} (${r.packId})`).slice(0, 6),
    placeholderCount: weapons.filter(r => G.isPlaceholderIcon(r.img)).length, mp5Row: tail(all.find(r => r.id === "ZPRv9RxGpq4xZfaV")?.img) };
  // the compendium window's list
  await pack.render(true); await sleep(2500);
  const app = [...foundry.applications.instances.values()].find(a => a.collection === pack);
  const pics = [...(app?.element?.querySelectorAll("[data-entry-id] img") ?? [])].map(i => tail(i.getAttribute("src")));
  out.list = { rows: pics.length, distinct: [...new Set(pics)] };
  await app?.close({ animate: false });
  return out;
});
check("D1 a base weapon document shows its category glyph", D.doc.shown === "mp5.svg", JSON.stringify(D.doc));
check("D2 its stored and exported picture are untouched", /weapon-icon\.svg$/.test(D.doc.stored) && D.doc.exported === D.doc.stored, JSON.stringify(D.doc));
check("D3 a weapon with art of its own keeps it", D.ownArt?.shown === D.ownArt?.stored && D.world.customShown === "explosion.svg", JSON.stringify({ ownArt: D.ownArt, custom: D.world.customShown }));
check("D4 a new weapon with no picture shows its type's glyph and follows a change of type", D.world.plainShown === "fn-fal.svg" && D.world.afterRetype === "pistol-gun.svg" && !/img\/icons\//.test(D.world.plainStored), JSON.stringify(D.world));
check("D5 no weapon row in the shop index carries a placeholder picture", D.shop.weapons > 300 && D.shop.placeholderCount === 0 && D.shop.mp5Row === "mp5.svg", JSON.stringify(D.shop));
check("D6 a base compendium window lists its weapons under the category glyph", D.list.rows >= 16 && D.list.distinct.length === 1 && D.list.distinct[0] === "mp5.svg", JSON.stringify(D.list));

// ── E. GLYPHS BY KIND: CYBERWARE AND VEHICLE WEAPONS ─────────────────────────────────────────────
// (user ruling 2026-10-04: "by kind".) The base system's cyberware stores one generic implant icon; it
// must SHOW the glyph for its kind, read from the type and subtype the record already carries, with
// the stored picture untouched. The module's own cyberware and vehicle weapons store their glyph.
const srcDocs = (pack) => fs.readdirSync(path.join(HERE, "..", "src", "packs", pack)).map(f => JSON.parse(fs.readFileSync(path.join(HERE, "..", "src", "packs", pack, f), "utf8")));
const glyphOf = (d) => String(d.img).split("/").pop().replace(".svg", "");
const vw = srcDocs("vehicle-weapons");
const vwWant = [[/bomb$/i, "falling-bomb"], [/mortar/i, "mortar"], [/gatling|minigun/i, "minigun"], [/flechette cloud/i, "shatter"], [/minelet/i, "land-mine"], [/obstacle/i, "barbed-wire"], [/howitzer/i, "cannon"]];
const vwOff = vw.flatMap(d => vwWant.filter(([rx, g]) => rx.test(d.name) && glyphOf(d) !== g).map(([, g]) => `${d.name}: ${glyphOf(d)} (want ${g})`));
const vwTurret = vw.filter(d => glyphOf(d) === "turret").length;
check("E1 vehicle weapons carry a glyph for their kind", vw.length > 90 && vwOff.length === 0 && vwTurret <= 6, `${vw.length} records, ${vwOff.length} off (${vwOff.slice(0, 3).join("; ")}), ${vwTurret} still on the generic turret`);
const cw = srcDocs("supplement-cyberware");
const borgOff = cw.filter(d => d.flags?.["cp2020-augmented"]?.borgBody && glyphOf(d) !== "cyborg-face").map(d => d.name);
const armOnly = cw.filter(d => glyphOf(d) === "mechanical-arm").length;
check("E2 the module's cyberware is spread over its kinds, full-body conversions under their own glyph", cw.length > 90 && borgOff.length === 0 && new Set(cw.map(glyphOf)).size >= 10 && armOnly < 20,
  `${cw.length} records, ${new Set(cw.map(glyphOf)).size} glyphs, ${armOnly} on the arm, conversions off: ${borgOff.slice(0, 3).join("; ")}`);

const E = await p.evaluate(async () => {
  const tail = s => String(s ?? "").split("/").pop();
  const G = await import("/modules/cp2020-augmented/module/item-glyphs.js");
  const out = { pure: [], docs: [] };
  const IMPLANT = "systems/cyberpunk2020/img/implant-icon-2.svg";
  for (const [type, sub, name, want, packId] of [
    ["CYBEROPTIC", "OPTION", "Low Lite", "cyber-eye.svg"], ["CyberAudio", "", "Basic Hearing Module", "human-ear.svg"],
    ["NEURALWARE", "OPTION", "Kerenzikov", "brain.svg"], ["CHIPWARE", "OPTION", "Chip", "microchip.svg"],
    ["CYBERLIMB", "BUILTIN", "Cybermodem", "mechanical-arm.svg"], ["CYBERLIMB", "OPTION", "Reinforced Leg Joints", "robot-leg.svg"],
    ["CyberLeg", "", "Cyberleg", "robot-leg.svg"], ["CYBERHAND", "", "Ripper Hand", "mechanical-arm.svg"],
    ["CYBERWEAPON", "", "Scratchers", "wolverine-claws.svg"], ["CYBERLIMB", "WEAPON", "Popup Gun", "wolverine-claws.svg"],
    ["IMPLANT", "", "Nasal Filters", "internal-organ.svg"], ["IMPLANT", "SUBDERMAL ARMOR", "Torso Plate", "muscular-torso.svg"],
    ["BIOWARE", "", "Grafted Muscle", "dna1.svg"], ["BIOWARE", "SKINWEAVE", "Skinweave", "muscular-torso.svg"],
    ["FASHIONWARE", "", "Techhair", "lipstick.svg"], ["BODY PLATING", "", "Cowl", "muscular-torso.svg"], ["LINEAR FRAMES", "", "Sigma", "cyborg-face.svg"],
    ["CYBERNETIC SYSTEM", "OPTION", "Waterproofing", "mechanical-arm.svg"],
    ["", "", "Unknown", null],
    ["", "", "Low Lite", "cyber-eye.svg", "cyberpunk2020.cyberoptic"],          // no type: the pack answers
    ["BIOWARE", "", "Grafted Muscle", "dna1.svg", "cyberpunk2020.cyberoptic"],   // a type always wins over the pack
  ]) out.pure.push({ type, sub, want, got: tail(G.cyberwareGlyph({ img: IMPLANT, cyberwareType: type, cyberwareSubtype: sub, name, packId })) || null });
  out.ownArt = G.cyberwareGlyph({ img: "icons/svg/explosion.svg", cyberwareType: "CYBEROPTIC" });
  for (const [packId, want] of [["cyberpunk2020.cyberoptic", "cyber-eye.svg"], ["cyberpunk2020.cyberaudio", "human-ear.svg"], ["cyberpunk2020.neuralware", "brain.svg"], ["cyberpunk2020.fashonware", "lipstick.svg"]]) {
    const pack = game.packs.get(packId);
    const idx = await pack.getIndex({ fields: ["system.cyberwareType", "img"] });
    const e = idx.find(x => String(x.system?.cyberwareType ?? "").trim() !== "");
    const doc = e ? await pack.getDocument(e._id) : null;
    out.docs.push({ packId, want, shown: tail(doc?.img), stored: doc?._source.img, exportedSame: doc ? doc.toObject().img === doc._source.img : null });
  }
  const cat = await import("/modules/cp2020-augmented/module/shop/catalog.js");
  const all = await cat.getCatalogIndex();
  const base = all.filter(r => r.type === "cyberware" && r.packId.startsWith("cyberpunk2020."));
  out.shop = { rows: base.length, placeholders: base.filter(r => G.isPlaceholderIcon(r.img)).map(r => `${r.name} (${r.packId})`).slice(0, 6), placeholderCount: base.filter(r => G.isPlaceholderIcon(r.img)).length };
  return out;
});
const pureOff = E.pure.filter(r => r.got !== r.want);
check("E3 each cyberware type and subtype resolves to the glyph of its kind", E.pure.length === 21 && pureOff.length === 0, pureOff.map(r => `${r.type}/${r.sub}: ${r.got} (want ${r.want})`).join("; "));
check("E4 cyberware with art of its own is left alone", E.ownArt === null, String(E.ownArt));
check("E5 a base cyberware document shows its kind glyph and its stored picture is untouched", E.docs.length === 4 && E.docs.every(d => d.shown === d.want && /implant-icon/.test(d.stored) && d.exportedSame === true), JSON.stringify(E.docs));
check("E6 base cyberware rows in the shop index carry a kind glyph", E.shop.rows > 80 && E.shop.placeholderCount <= 2, JSON.stringify(E.shop));

const prior = await p.evaluate(() => foundry.utils.deepClone(game.settings.get("core", "uiConfig").colorScheme ?? {}));
const closeAll = () => p.evaluate(async () => {
  for (const app of [...foundry.applications.instances.values()]) {
    if (/Compendium|ItemSheet|Shop|Catalog/i.test(app.constructor.name)) { try { await app.close({ animate: false }); } catch { /* already gone */ } }
  }
});

try {
  for (const [applications, iface] of PAIRS) {
    const tag = `apps=${applications} interface=${iface}`;
    await closeAll();
    // ── B. SCHEME FOLLOWING ──────────────────────────────────────────────────────────────────────
    const r = await p.evaluate(async ({ applications, iface }) => {
      const sleep = ms => new Promise(res => setTimeout(res, ms));
      const cfg = foundry.utils.deepClone(game.settings.get("core", "uiConfig"));
      cfg.colorScheme = { applications, interface: iface };
      await game.settings.set("core", "uiConfig", cfg);
      await sleep(600);
      ui.notifications?.clear?.();
      const pack = game.packs.get("cp2020-augmented.supplement-submachineguns");
      const idx = await pack.getIndex();
      const entry = idx.find(e => /mp5\.svg$/.test(e.img));
      const cat = await import("/modules/cp2020-augmented/module/shop/catalog.js");
      cat.openShopWindow(null, { view: "catalog" });
      await pack.render(true);
      const doc = await pack.getDocument(entry._id);
      await doc.sheet.render(true);
      await sleep(3500);

      const nearestScheme = (el) => {
        for (let n = el; n; n = n.parentElement) {
          if (n !== document.body && !n.classList.contains("themed")) continue;
          const c = [...n.classList].find(x => /^theme-(light|dark)$/.test(x));
          if (c) return c.slice(6);
        }
        return null;
      };
      const sheetEl = doc.sheet.element;
      const surfaceOf = (el) => {
        if (sheetEl?.contains(el)) return "item-sheet";
        const a = el.closest(".application, #sidebar");
        if (!a) return "other";
        if (/compendium/i.test(a.className)) return "compendium";
        if (a.querySelector(".cp-catalog") || /cp-catalog|shop/.test(a.className)) return "catalog";
        return "other";
      };
      const rows = [];
      for (const img of document.querySelectorAll('img[src*="modules/cp2020-augmented/img/icons/"]')) {
        if (!img.getBoundingClientRect().width) continue;
        const surface = surfaceOf(img);
        rows.push({ surface, filter: getComputedStyle(img).filter, scheme: nearestScheme(img) });
        // mark one glyph per measured surface for the readability section
        if (surface === "item-sheet" && !document.querySelector('[data-cp-glyph-probe="item-sheet"]')) img.dataset.cpGlyphProbe = "item-sheet";
        if (surface === "compendium" && /mp5\.svg$/.test(img.src) && !document.querySelector('[data-cp-glyph-probe="compendium"]')) img.dataset.cpGlyphProbe = "compendium";
      }
      const other = [...document.querySelectorAll("img")].find(i => !/cp2020-augmented\/img\/icons\//.test(i.src) && i.getBoundingClientRect().width > 0);
      doc.sheet.bringToFront?.();
      return { rows, otherFilter: other ? getComputedStyle(other).filter : null, otherSrc: other ? other.src.split("/").slice(-2).join("/") : null };
    }, { applications, iface });

    const want = (scheme) => (scheme === "light" ? "invert(1)" : "none");
    const wrong = r.rows.filter(x => !x.scheme || x.filter !== want(x.scheme));
    check(`B  ${tag}: each glyph's filter is its nearest scheme's (${r.rows.length} glyphs)`, r.rows.length > 0 && wrong.length === 0,
      wrong.slice(0, 3).map(x => `${x.surface} under ${x.scheme} has ${x.filter}`).join("; "));
    for (const [surface, scheme] of [["catalog", applications], ["item-sheet", applications], ["compendium", iface]]) {
      const mine = r.rows.filter(x => x.surface === surface);
      check(`B  ${tag}: ${surface} glyphs present and under the ${scheme} scheme`, mine.length > 0 && mine.every(x => x.scheme === scheme),
        `${mine.length} glyphs, schemes ${[...new Set(mine.map(x => x.scheme))].join(",")}`);
    }
    check(`B  ${tag}: an image that is not a glyph keeps no filter`, r.otherFilter === "none", `${r.otherSrc} has ${r.otherFilter}`);

    // ── C. READABILITY ───────────────────────────────────────────────────────────────────────────
    for (const surface of ["item-sheet", "compendium"]) {
      const loc = p.locator(`[data-cp-glyph-probe="${surface}"]`).first();
      const spread = await spreadOf(await loc.screenshot());
      check(`C  ${tag}: ${surface} glyph clears the readability floor`, spread >= SPREAD_FLOOR, `spread ${spread}, floor ${SPREAD_FLOOR}`);
    }
    if (applications === iface) {
      // The measure must be able to fail: force the OTHER scheme's filter onto the same element.
      const loc = p.locator('[data-cp-glyph-probe="item-sheet"]').first();
      await loc.evaluate((el, f) => { el.style.filter = f; }, applications === "dark" ? "invert(1)" : "none");
      const bad = await spreadOf(await loc.screenshot());
      await loc.evaluate((el) => { el.style.filter = ""; });
      check(`C  ${tag}: the wrong filter on the same glyph falls below the floor`, bad < SPREAD_FLOOR, `spread ${bad}, floor ${SPREAD_FLOOR}`);
    }
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `glyph-apps-${applications}-iface-${iface}.png`) });
  }
} finally {
  await closeAll().catch(() => {});
  await p.evaluate(async (prior) => {
    const cfg = foundry.utils.deepClone(game.settings.get("core", "uiConfig")); cfg.colorScheme = prior;
    await game.settings.set("core", "uiConfig", cfg);
  }, prior).catch(() => {});
}

const after = await p.evaluate(() => game.settings.get("core", "uiConfig").colorScheme ?? {});
check("Z  the rig's colour scheme is restored", JSON.stringify(after) === JSON.stringify(prior), JSON.stringify(after));
check("Z  0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await b.close();
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
