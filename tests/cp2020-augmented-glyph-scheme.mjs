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
check("A1 every glyph file carries one fill, and it is white", files.length === 35 && notWhite.length === 0,
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
