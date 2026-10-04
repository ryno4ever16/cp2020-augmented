/**
 * KEEPER: unrecognised book tags get their own book chip, and the GM's "view as player" switch
 * (:30004, official 1.1.1 + module; two real sessions, GM + "Test User 1").
 *
 * Fixture: a temporary WORLD compendium of Items holding six `__PW__BC` items —
 *   Alpha / Bravo / Charlie  source "Zeta Codex" with three different page references
 *   Delta                    source "Omega Folio p. 3"
 *   Echo                     source ""                     (no tag: stays Untagged, Core)
 *   Foxtrot                  source "Maximum Metal p.40"   (a recognised book: unchanged)
 *
 *   §1  classifier values: page references stripped, whitespace collapsed, empty/"undefined"/"null"
 *       and punctuation-only tags stay Untagged/core, recognised tags unchanged
 *   §2  catalog index rows: each fixture item's supplement + canon
 *   §3  GM books panel: one chip per unknown book (name + count), each with an eye; real chip click
 *       lists exactly that book's items; the Core chip lists the untagged item; the hint names the rule
 *   §4  player: the unknown books are absent by default (rows and chips); the GM enables one through
 *       its eye (real DOM event) → the player lists it; the GM disables it → gone again; the GM sees
 *       every fixture row throughout
 *   §5  view as player (GM catalog): real click → banner on, eyes + hint gone, the full row-key list
 *       and the chip list equal the player's; second act across a storefront (fullSearch shop) and
 *       back; off restores the GM's set; a GM buy while it is on is still a GM buy
 *   §6  the switch is absent on the player's client, and a console call cannot turn it on there
 *   §7  0 console errors on both sessions
 *
 * Screenshots (optional):  node <this> --shots <dir>
 * Run: FVTT_URL=http://localhost:30004 node <this file>
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";
const PACK_NAME = "pw-book-chips";
const PACK_ID = `world.${PACK_NAME}`;
const SHOTS = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? process.argv[i + 1] : null; })();
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const FIXTURES = [
  { name: "__PW__BC Alpha", source: "Zeta Codex p.12" },
  { name: "__PW__BC Bravo", source: "Zeta  Codex pg.84" },
  { name: "__PW__BC Charlie", source: "Zeta Codex (PDF idx 65)" },
  { name: "__PW__BC Delta", source: "Omega Folio p. 3" },
  { name: "__PW__BC Echo", source: "" },
  { name: "__PW__BC Foxtrot", source: "Maximum Metal p.40" },
];
const ZETA = ["__PW__BC Alpha", "__PW__BC Bravo", "__PW__BC Charlie"];

let pass = 0, fail = 0;
const failed = [];
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d !== "" ? ` — ${d}` : ""}`);
  if (ok) pass++; else { fail++; failed.push(n); }
};
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function joinAs(page, match, passwords) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 30_000 });
  const users = await sel.locator("option").evaluateAll(o =>
    o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
  const u = users.find(x => match.test(x.l));
  if (!u) throw new Error("no user matching " + match);
  for (const pw of passwords) {
    await sel.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([
      page.waitForNavigation({ url: /\/game/, timeout: 20_000 }).catch(() => {}),
      page.locator('button[name="join"]').click(),
    ]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 20_000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await sel.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join as " + u.l);
}

const browser = await chromium.launch({ headless: true });
const gmErrors = [], pcErrors = [];
const collect = (page, bag) => {
  page.on("pageerror", e => bag.push(String(e?.message || e)));
  page.on("console", m => { if (m.type() === "error" && !/compatibility|deprecat|screen resolution/i.test(m.text())) bag.push(m.text()); });
};

/** In-page toolkit: open a shop window at a view, narrow it with the search box, and read it back. */
async function installKit(page) {
  await page.evaluate((SCOPE) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const C = () => import(`/modules/${SCOPE}/module/shop/catalog.js`);
    const K = (window.__bc = {});
    K.closeAll = async () => {
      const { CatalogBrowser } = await C();
      for (const w of [...foundry.applications.instances.values()].filter(w => w instanceof CatalogBrowser)) await w.close().catch(() => {});
      await sleep(250);
    };
    K.win = async () => { const { CatalogBrowser } = await C(); return [...foundry.applications.instances.values()].find(w => w instanceof CatalogBrowser) ?? null; };
    /** Wait until the window's list has been built (loading panel gone, base rows present). */
    K.settle = async (win, ms = 15000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const el = win?.element;
        if (el && !el.querySelector(".cp-catalog-loading") && Array.isArray(win._baseRows)) { await sleep(250); return true; }
        await sleep(120);
      }
      return false;
    };
    K.search = async (win, term) => {
      const box = win.element.querySelector(".cp-catalog-search");
      if (!box) return false;
      box.value = term;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(500);
      return true;
    };
    K.open = async ({ view, shopId = null, buyerId = null, term = "__PW__BC" }) => {
      await K.closeAll();
      const { openShopWindow, clearCatalogIndexCache } = await C();
      const win = openShopWindow(buyerId ? game.actors.get(buyerId) : null, { view, shopId });
      const ok = await K.settle(win);
      if (term) await K.search(win, term);
      return ok;
    };
    /** Re-render the open window (after a world change) and re-apply its search. */
    K.rerender = async () => { const w = await K.win(); await w.render(); await sleep(400); await K.settle(w); await sleep(300); };
    K.read = async () => {
      const win = await K.win();
      const el = win?.element;
      if (!el) return { open: false };
      const rowKey = (r) => r.ammo ? `ammo:${r.caliber}` : (r.key || r.sourceKey || "");
      const chips = [...el.querySelectorAll(".cp-book-chip")].map(b => {
        const row = b.closest(".cp-book-row");
        const eye = row?.querySelector(".cp-src-toggle");
        return { book: b.dataset.book, count: Number(b.dataset.count), label: b.querySelector(".cp-book-name")?.textContent?.trim() ?? "",
          title: b.title, eye: !!eye, enabled: eye ? eye.checked : null, active: b.classList.contains("active") };
      });
      return {
        open: true,
        view: win.view,
        baseKeys: (win._baseRows ?? []).map(rowKey),
        fixtureRows: [...el.querySelectorAll(".cp-list-items .cp-catalog-row")].map(r => r.dataset.name).filter(n => n?.startsWith("__PW__BC")),
        chips,
        eyes: el.querySelectorAll(".cp-src-toggle").length,
        hint: el.querySelector(".cp-books-hint")?.textContent?.trim() ?? null,
        toggle: !!el.querySelector(".cp-shop-viewas-toggle"),
        toggleActive: !!el.querySelector(".cp-shop-viewas-toggle.cp-active"),
        banner: el.querySelector(".cp-shop-viewas-banner")?.textContent?.trim() ?? null,
        setupToggle: !!el.querySelector(".cp-shop-setup-toggle"),
      };
    };
    K.clickChip = async (book) => {
      const win = await K.win();
      const chip = win.element.querySelector(`.cp-book-chip[data-book="${CSS.escape(book)}"]`);
      if (!chip) return false;
      chip.click();
      await sleep(700); await K.settle(win); await sleep(200);
      return true;
    };
    K.clickEye = async (book) => {
      const win = await K.win();
      const box = win.element.querySelector(`.cp-src-toggle[data-source="${CSS.escape(book)}"]`);
      if (!box) return false;
      box.click();   // a click with no pointer stroke behind it commits through the change handler
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        const on = (game.settings.get(SCOPE, "shopEnabledSources") ?? {})[book] === true;
        if (on === box.checked) break;
        await sleep(100);
      }
      await sleep(600); await K.settle(await K.win());
      return true;
    };
    K.clickViewAs = async () => {
      const win = await K.win();
      const btn = win.element.querySelector(".cp-shop-viewas-toggle");
      if (!btn) return false;
      btn.click();
      await sleep(700); await K.settle(await K.win()); await sleep(200);
      return true;
    };
  }, SCOPE);
}

let gm = null, pc = null, S = null;
try {
  gm = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  collect(gm, gmErrors);
  await joinAs(gm, /^gamemaster$/i, [GM_PW]);
  await installKit(gm);

  // ── setup, GM side: the world compendium, its items, a buyer, a fullSearch shop ──────────────────
  S = await gm.evaluate(async ({ SCOPE, PACK_NAME, PACK_ID, FIXTURES }) => {
    const SH = await import(`/modules/${SCOPE}/module/shop/shops.js`);
    for (const p of [...game.packs].filter(p => p.metadata?.packageType === "world" && (p.metadata?.name === PACK_NAME || String(p.metadata?.label ?? "").startsWith("__PW__")))) await p.deleteCompendium().catch(() => {});
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__BC"))) await a.delete().catch(() => {});
    for (const s of SH.listShops().filter(s => s.name?.startsWith("__PW__BC"))) await SH.deleteShop(s.id);
    window.__pwBefore = new Set(game.messages.map(m => m.id));
    const prevEnabled = foundry.utils.deepClone(game.settings.get(SCOPE, "shopEnabledSources") ?? {});
    // Deterministic start: the two unknown books and the recognised one all hidden from players.
    const start = { ...prevEnabled };
    for (const k of ["Zeta Codex", "Omega Folio", "Maximum Metal"]) delete start[k];
    await game.settings.set(SCOPE, "shopEnabledSources", start);

    const pack = await foundry.documents.collections.CompendiumCollection.createCompendium({
      type: "Item", label: "__PW__ Book Chips", name: PACK_NAME,
      ownership: { PLAYER: "OBSERVER", TRUSTED: "OBSERVER", ASSISTANT: "OWNER" },
    });
    const created = [];
    for (const f of FIXTURES) {
      const [doc] = await Item.createDocuments([{ name: f.name, type: "misc", system: { cost: 100, source: f.source } }], { pack: pack.collection });
      created.push({ name: f.name, id: doc?.id ?? null });
    }
    const player = game.users.find(u => !u.isGM && /test user 1/i.test(u.name)) ?? game.users.find(u => u.role === 1 && u.name);
    const buyer = await Actor.create({ name: "__PW__BC Buyer", type: "character", system: { eurobucks: 1000 }, ownership: { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER } });
    const echoKey = `${pack.collection}.${created.find(c => c.name === "__PW__BC Echo").id}`;
    const shop = await SH.createShop({ name: "__PW__BC Shop" });
    await SH.addShopItem(shop.id, echoKey);
    await SH.updateShop(shop.id, { open: true, fullSearch: true, publishedTo: "all" });
    (await import(`/modules/${SCOPE}/module/shop/catalog.js`)).clearCatalogIndexCache();
    return { packId: pack.collection, created, prevEnabled, playerName: player.name, buyerId: buyer.id, shopId: shop.id, echoKey };
  }, { SCOPE, PACK_NAME, PACK_ID, FIXTURES });
  check("fixture: world compendium created with six items", S.packId === PACK_ID && S.created.every(c => c.id), JSON.stringify(S.created.map(c => !!c.id)));

  /* ─────────────────── §1 classifier values ─────────────────── */
  console.log("\n§1 classifier values");
  const c1 = await gm.evaluate(async (SCOPE) => {
    const SUP = await import(`/modules/${SCOPE}/module/shop/supplements.js`);
    const cases = ["Zeta Codex p.12", "Zeta  Codex pg.84", "Zeta Codex (PDF idx 65)", "Zeta Codex p. 12", "Zeta Codex, pp. 3-4", "  Omega   Folio  ",
      "", "undefined", "null", "   ", "?? pg.22", "Maximum Metal p.40", "Chromebook 2 pg.12", "cyberpunk 2020 p.1", "https://example.org/x"];
    return Object.fromEntries(cases.map(c => [c, SUP.classifySupplement(c)]));
  }, SCOPE);
  const cls = (s) => `${c1[s]?.supplement}|${c1[s]?.canon}`;
  check("page ref ' p.12' stripped: book 'Zeta Codex', gated as official", cls("Zeta Codex p.12") === "Zeta Codex|official", cls("Zeta Codex p.12"));
  check("page ref ' pg.84' stripped and doubled space collapsed", cls("Zeta  Codex pg.84") === "Zeta Codex|official", cls("Zeta  Codex pg.84"));
  check("page ref '(PDF idx 65)' stripped", cls("Zeta Codex (PDF idx 65)") === "Zeta Codex|official", cls("Zeta Codex (PDF idx 65)"));
  check("page ref ' p. 12' stripped", cls("Zeta Codex p. 12") === "Zeta Codex|official", cls("Zeta Codex p. 12"));
  check("page ref ', pp. 3-4' stripped", cls("Zeta Codex, pp. 3-4") === "Zeta Codex|official", cls("Zeta Codex, pp. 3-4"));
  check("surrounding + inner whitespace collapsed", cls("  Omega   Folio  ") === "Omega Folio|official", cls("  Omega   Folio  "));
  check("NEGATIVE: empty / 'undefined' / 'null' / blank stay Untagged core",
    ["", "undefined", "null", "   "].every(s => cls(s) === "Untagged|core"), ["", "undefined", "null", "   "].map(cls).join(","));
  check("NEGATIVE: a punctuation-only tag ('?? pg.22') stays Untagged core", cls("?? pg.22") === "Untagged|core", cls("?? pg.22"));
  check("NEGATIVE: recognised tags unchanged (Maximum Metal / Chromebook 2 / core / online)",
    cls("Maximum Metal p.40") === "Maximum Metal|official" && cls("Chromebook 2 pg.12") === "Chromebook 2|official"
    && cls("cyberpunk 2020 p.1") === "Cyberpunk 2020 (Core)|core" && cls("https://example.org/x") === "Other online|noncanon",
    ["Maximum Metal p.40", "Chromebook 2 pg.12", "cyberpunk 2020 p.1", "https://example.org/x"].map(cls).join(","));

  /* ─────────────────── §2 index rows ─────────────────── */
  console.log("\n§2 catalog index rows for the fixture pack");
  const idx2 = await gm.evaluate(async ({ SCOPE, PACK_ID }) => {
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    const all = await C.getCatalogIndex();
    return Object.fromEntries(all.filter(r => r.packId === PACK_ID).map(r => [r.name, `${r.supplement}|${r.canon}`]));
  }, { SCOPE, PACK_ID });
  check("index carries all six fixture rows", Object.keys(idx2).length === 6, JSON.stringify(idx2));
  check("Alpha / Bravo / Charlie → Zeta Codex|official", ZETA.every(n => idx2[n] === "Zeta Codex|official"), ZETA.map(n => idx2[n]).join(","));
  check("Delta → Omega Folio|official", idx2["__PW__BC Delta"] === "Omega Folio|official", idx2["__PW__BC Delta"]);
  check("Echo (empty source) → Untagged|core", idx2["__PW__BC Echo"] === "Untagged|core", idx2["__PW__BC Echo"]);
  check("Foxtrot (recognised) → Maximum Metal|official", idx2["__PW__BC Foxtrot"] === "Maximum Metal|official", idx2["__PW__BC Foxtrot"]);

  /* ─────────────────── §3 GM books panel ─────────────────── */
  console.log("\n§3 GM books panel");
  await gm.evaluate(() => window.__bc.open({ view: "catalog" }));
  const g3 = await gm.evaluate(() => window.__bc.read());
  const chip = (r, b) => r.chips?.find(c => c.book === b) ?? null;
  check("GM: 'Zeta Codex' chip with label 'Zeta Codex', count 3, an eye, eye off",
    chip(g3, "Zeta Codex")?.label === "Zeta Codex" && chip(g3, "Zeta Codex")?.count === 3 && chip(g3, "Zeta Codex")?.eye === true && chip(g3, "Zeta Codex")?.enabled === false,
    JSON.stringify(chip(g3, "Zeta Codex")));
  check("GM: 'Omega Folio' chip count 1 with an eye", chip(g3, "Omega Folio")?.count === 1 && chip(g3, "Omega Folio")?.eye === true, JSON.stringify(chip(g3, "Omega Folio")));
  check("NEGATIVE: no chip named after a raw tag with its page reference", !g3.chips.some(c => /p\.|pg\.|PDF/.test(c.book)), g3.chips.map(c => c.book).filter(b => /Zeta|Omega/.test(b)).join(","));
  check("GM sees all six fixture rows", same(g3.fixtureRows, FIXTURES.map(f => f.name)), g3.fixtureRows.join(","));
  check("GM hint says unrecognised book tags appear as their own book, hidden until enabled",
    /does not recognise appears as its own book/.test(g3.hint ?? "") && /hidden from players/.test(g3.hint ?? ""), g3.hint);
  if (SHOTS) {
    await gm.evaluate(() => window.__bc.win().then(w => w.element.querySelector('.cp-book-chip[data-book="Zeta Codex"]')?.scrollIntoView({ block: "center" })));
    await gm.waitForTimeout(300);
    await gm.locator(".cp-catalog .cp-filter-drawer").first().screenshot({ path: path.join(SHOTS, "book-chip-panel.png") }).catch(e => console.log("  (info) shot failed", e.message));
  }
  await gm.evaluate(() => window.__bc.clickChip("Zeta Codex"));
  const g3z = await gm.evaluate(() => window.__bc.read());
  check("real click on the 'Zeta Codex' chip lists exactly Alpha, Bravo, Charlie", same(g3z.fixtureRows, ZETA), g3z.fixtureRows.join(","));
  await gm.evaluate(() => window.__bc.clickChip("Zeta Codex"));
  await gm.evaluate(() => window.__bc.clickChip("__core__"));
  const g3c = await gm.evaluate(() => window.__bc.read());
  check("Core chip lists Echo and none of the unknown-book items", g3c.fixtureRows.includes("__PW__BC Echo") && !g3c.fixtureRows.some(n => ZETA.includes(n) || n === "__PW__BC Delta"), g3c.fixtureRows.join(","));
  await gm.evaluate(() => window.__bc.clickChip("__core__"));
  await gm.evaluate(() => window.__bc.clickChip("Maximum Metal"));
  const g3m = await gm.evaluate(() => window.__bc.read());
  check("Maximum Metal chip lists Foxtrot (recognised tag unchanged)", same(g3m.fixtureRows, ["__PW__BC Foxtrot"]), g3m.fixtureRows.join(","));
  await gm.evaluate(() => window.__bc.clickChip("Maximum Metal"));

  // ── second client ──
  pc = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  collect(pc, pcErrors);
  await joinAs(pc, new RegExp(`^${S.playerName}$`, "i"), ["", GM_PW]);
  await pc.waitForTimeout(1500);
  await installKit(pc);
  check("fixture: the second client is a non-GM that can read the fixture pack",
    await pc.evaluate((id) => !game.user.isGM && !!game.packs.get(id), PACK_ID), "");

  /* ─────────────────── §4 player visibility follows the eye ─────────────────── */
  console.log("\n§4 player visibility follows the GM's eye");
  await pc.evaluate(() => window.__bc.open({ view: "catalog" }));
  const p4a = await pc.evaluate(() => window.__bc.read());
  check("player default: lists Echo only of the fixtures (unknown books + hidden Maximum Metal absent)", same(p4a.fixtureRows, ["__PW__BC Echo"]), p4a.fixtureRows.join(","));
  check("player default: no 'Zeta Codex' / 'Omega Folio' chip", !chip(p4a, "Zeta Codex") && !chip(p4a, "Omega Folio"), p4a.chips.map(c => c.book).join(","));
  check("player default: no eye controls", p4a.eyes === 0, String(p4a.eyes));

  await gm.evaluate(() => window.__bc.clickEye("Zeta Codex"));
  const g4on = await gm.evaluate(() => window.__bc.read());
  check("GM eye click wrote 'Zeta Codex': true to the setting", await gm.evaluate((SCOPE) => game.settings.get(SCOPE, "shopEnabledSources")?.["Zeta Codex"] === true, SCOPE), "");
  check("GM eye for 'Zeta Codex' reads on after the render", chip(g4on, "Zeta Codex")?.enabled === true, JSON.stringify(chip(g4on, "Zeta Codex")));
  check("GM still sees all six fixture rows (eye on)", same(g4on.fixtureRows, FIXTURES.map(f => f.name)), g4on.fixtureRows.join(","));
  await pc.waitForTimeout(800);
  await pc.evaluate(() => window.__bc.rerender());
  const p4b = await pc.evaluate(() => window.__bc.read());
  check("player after enable: lists Echo + Alpha/Bravo/Charlie, Delta still absent", same(p4b.fixtureRows, ["__PW__BC Echo", ...ZETA]), p4b.fixtureRows.join(","));
  check("player after enable: 'Zeta Codex' chip count 3, no eye; no 'Omega Folio' chip",
    chip(p4b, "Zeta Codex")?.count === 3 && chip(p4b, "Zeta Codex")?.eye === false && !chip(p4b, "Omega Folio"), JSON.stringify(p4b.chips.filter(c => /Zeta|Omega/.test(c.book))));

  await gm.evaluate(() => window.__bc.clickEye("Zeta Codex"));
  const g4off = await gm.evaluate(() => window.__bc.read());
  check("GM eye click again removed 'Zeta Codex' from the setting", await gm.evaluate((SCOPE) => !("Zeta Codex" in (game.settings.get(SCOPE, "shopEnabledSources") ?? {})), SCOPE), "");
  check("GM still sees all six fixture rows (eye off)", same(g4off.fixtureRows, FIXTURES.map(f => f.name)), g4off.fixtureRows.join(","));
  await pc.waitForTimeout(800);
  await pc.evaluate(() => window.__bc.rerender());
  const p4c = await pc.evaluate(() => window.__bc.read());
  check("player after disable: back to Echo only, no 'Zeta Codex' chip", same(p4c.fixtureRows, ["__PW__BC Echo"]) && !chip(p4c, "Zeta Codex"), p4c.fixtureRows.join(","));

  /* ─────────────────── §5 view as player ─────────────────── */
  console.log("\n§5 GM view as player");
  // Unnarrowed lists on both sides, so the WHOLE row-key list is compared, not just the fixtures.
  await gm.evaluate(() => window.__bc.open({ view: "catalog", term: "" }));
  await pc.evaluate(() => window.__bc.open({ view: "catalog", term: "" }));
  const gFull = await gm.evaluate(() => window.__bc.read());
  const pFull = await pc.evaluate(() => window.__bc.read());
  check("GM catalog carries the switch, off", gFull.toggle === true && gFull.toggleActive === false && gFull.banner === null, JSON.stringify({ t: gFull.toggle, a: gFull.toggleActive, b: gFull.banner }));
  check("fixture guard: the GM's own list is larger than the player's", gFull.baseKeys.length > pFull.baseKeys.length, `${gFull.baseKeys.length} vs ${pFull.baseKeys.length}`);
  await gm.evaluate(() => window.__bc.clickViewAs());
  const gAs = await gm.evaluate(() => window.__bc.read());
  check("real click: switch lit and banner shown", gAs.toggleActive === true && /Viewing as a player/.test(gAs.banner ?? ""), JSON.stringify({ a: gAs.toggleActive, b: gAs.banner }));
  check("view as player: the GM's full row-key list equals the player's", same(gAs.baseKeys, pFull.baseKeys) && gAs.baseKeys.length === pFull.baseKeys.length,
    `gm=${gAs.baseKeys.length} pc=${pFull.baseKeys.length} onlyGM=${gAs.baseKeys.filter(k => !pFull.baseKeys.includes(k)).slice(0, 3)} onlyPC=${pFull.baseKeys.filter(k => !gAs.baseKeys.includes(k)).slice(0, 3)}`);
  const chipSig = (r) => r.chips.map(c => `${c.book}=${c.count}`);
  check("view as player: book chips and counts equal the player's", same(chipSig(gAs), chipSig(pFull)), `gm=[${chipSig(gAs).filter(s => !chipSig(pFull).includes(s))}] pc=[${chipSig(pFull).filter(s => !chipSig(gAs).includes(s))}]`);
  check("view as player: no eyes and no eye hint in the books panel", gAs.eyes === 0 && gAs.hint === null, `eyes=${gAs.eyes} hint=${gAs.hint}`);
  if (SHOTS) {
    await gm.locator(".cp-catalog").first().screenshot({ path: path.join(SHOTS, "view-as-player-banner.png") }).catch(e => console.log("  (info) shot failed", e.message));
  }

  // Second act: the mode is client state, so it holds across a view change on the same window.
  await gm.evaluate(({ shopId, buyerId }) => window.__bc.open({ view: "storefront", shopId, buyerId, term: "" }), { shopId: S.shopId, buyerId: S.buyerId });
  await pc.evaluate(({ shopId, buyerId }) => window.__bc.open({ view: "storefront", shopId, buyerId, term: "" }), { shopId: S.shopId, buyerId: S.buyerId });
  const gSf = await gm.evaluate(() => window.__bc.read());
  const pSf = await pc.evaluate(() => window.__bc.read());
  check("storefront (fullSearch shop): switch still lit, banner shown", gSf.toggleActive === true && !!gSf.banner, JSON.stringify({ a: gSf.toggleActive, b: gSf.banner }));
  check("storefront: GM row-key list equals the player's", same(gSf.baseKeys, pSf.baseKeys) && gSf.baseKeys.length === pSf.baseKeys.length, `gm=${gSf.baseKeys.length} pc=${pSf.baseKeys.length}`);
  check("storefront: book chips and counts equal the player's", same(chipSig(gSf), chipSig(pSf)), "");

  // A buy while viewing as a player is still the GM's buy: direct, charged, no request card.
  const buy5 = await gm.evaluate(async ({ SCOPE, buyerId, echoKey }) => {
    const K = window.__bc;
    const win = await K.win();
    await K.search(win, "__PW__BC Echo");
    const row = win.element.querySelector(`.cp-catalog-row[data-source-key="${echoKey}"]`);
    const btn = row?.querySelector(".cp-catalog-buy");
    if (!btn) return { clicked: false };
    btn.click();
    await new Promise(r => setTimeout(r, 2500));
    const buyer = game.actors.get(buyerId);
    return {
      clicked: true,
      funds: Number(buyer.system.eurobucks),
      copies: buyer.items.filter(i => i.name === "__PW__BC Echo").length,
      requests: [...game.messages].filter(m => !window.__pwBefore.has(m.id) && m.getFlag(SCOPE, "purchaseRequest")).length,
    };
  }, { SCOPE, buyerId: S.buyerId, echoKey: S.echoKey });
  check("GM buy while viewing as player: delivered directly, charged 100, no request card",
    buy5.clicked && buy5.copies === 1 && buy5.funds === 900 && buy5.requests === 0, JSON.stringify(buy5));

  await gm.evaluate(() => window.__bc.open({ view: "catalog", term: "" }));
  const gBack = await gm.evaluate(() => window.__bc.read());
  check("back on the catalog the switch is still lit", gBack.toggleActive === true, "");
  await gm.evaluate(() => window.__bc.clickViewAs());
  const gOff = await gm.evaluate(() => window.__bc.read());
  check("switch off: banner gone, eyes back", gOff.toggleActive === false && gOff.banner === null && gOff.eyes > 0, JSON.stringify({ a: gOff.toggleActive, b: gOff.banner, eyes: gOff.eyes }));
  check("switch off: the GM's own full row-key list is restored", same(gOff.baseKeys, gFull.baseKeys) && gOff.baseKeys.length === gFull.baseKeys.length, `${gOff.baseKeys.length} vs ${gFull.baseKeys.length}`);

  /* ─────────────────── §6 the switch is GM-only ─────────────────── */
  console.log("\n§6 player client");
  await pc.evaluate(() => window.__bc.open({ view: "catalog", term: "" }));
  const p6 = await pc.evaluate(() => window.__bc.read());
  check("player catalog: no view-as-player switch, no banner", p6.toggle === false && p6.banner === null, JSON.stringify({ t: p6.toggle, b: p6.banner }));
  check("player storefront: no view-as-player switch", pSf.toggle === false, String(pSf.toggle));
  const p6c = await pc.evaluate(async (SCOPE) => { const V = await import(`/modules/${SCOPE}/module/shop/view-as-player.js`); return { set: V.setShopViewAsPlayer(true), now: V.isShopViewAsPlayer() }; }, SCOPE);
  check("player console call cannot turn it on", p6c.set === false && p6c.now === false, JSON.stringify(p6c));

  console.log("\n§7 console");
  check("0 console errors on the GM session", gmErrors.length === 0, gmErrors.slice(0, 3).join(" | "));
  check("0 console errors on the player session", pcErrors.length === 0, pcErrors.slice(0, 3).join(" | "));
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  fail++; failed.push("harness threw");
} finally {
  if (pc) await pc.evaluate(() => window.__bc?.closeAll()).catch(() => {});
  if (gm && S) {
    await gm.evaluate(async ({ SCOPE, PACK_NAME, S }) => {
      try { (await import(`/modules/${SCOPE}/module/shop/view-as-player.js`)).setShopViewAsPlayer(false); } catch {}
      try { await window.__bc?.closeAll(); } catch {}
      try { await game.settings.set(SCOPE, "shopEnabledSources", S.prevEnabled); } catch {}
      try { const SH = await import(`/modules/${SCOPE}/module/shop/shops.js`); await SH.deleteShop(S.shopId); } catch {}
      try { await game.actors.get(S.buyerId)?.delete(); } catch {}
      for (const a of game.actors.filter(a => a.name?.startsWith("__PW__BC"))) await a.delete().catch(() => {});
      try {
        const stray = [...game.messages].filter(m => !window.__pwBefore?.has(m.id)).map(m => m.id);
        if (window.__pwBefore && stray.length) await ChatMessage.deleteDocuments(stray);
      } catch {}
      for (const p of [...game.packs].filter(p => p.metadata?.packageType === "world" && p.metadata?.name === PACK_NAME)) await p.deleteCompendium().catch(() => {});
      try { (await import(`/modules/${SCOPE}/module/shop/catalog.js`)).clearCatalogIndexCache(); } catch {}
    }, { SCOPE, PACK_NAME, S }).catch(e => console.error("cleanup failed:", e?.message));
  }
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (failed.length) console.log("FAILED: " + failed.join(" || "));
process.exit(fail ? 1 : 0);
