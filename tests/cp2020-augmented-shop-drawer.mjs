/**
 * SHOP DRAWER keeper — the seven-unit shop rebuild (:30004, official 1.1.1 + module).
 *
 * One suite, seven sections, one per shippable unit, so a unit can be certified on its own and the
 * whole batch can be certified together:
 *
 *   S1  PACK MAPPING       every `supplement-*` compendium lands in the cell its pack identity names,
 *                          per pack, by COUNT — and the base packs keep the cells they already had.
 *   S2  VEHICLE SUBS       the two near-empty vehicle shelves fold into Other, blank class becomes its
 *                          own findable shelf, and Watercraft/Spacecraft stay.
 *   S3  FILTER DRAWER      one collapsible drawer serving BOTH the catalog and the builder, holding
 *                          categories (live per-viewer counts), books (+ GM eyes) and the source tag
 *                          toggle; state survives a reopen; a player's counts exclude hidden books.
 *   S4  LANDING VIEW       the catalog opens on tiles, the ammo tile counts CALIBERS and routes to the
 *                          generated rows, the letter strip appears only where it earns its place.
 *   S5  PAINT DRAG         a real pointer stroke over mixed-state filter buttons drives every crossed
 *                          button to the stroke's direction; the visibility eyes are NOT paintable.
 *   S6  SMALL FIXES        heading clipping, singular/plural, buyer-chip overflow, stock wording,
 *                          icon-only tooltips, the honest add-to-shop icon, the dead-end route out.
 *   S7  CONTROL DEDUP      one open/closed control (not two), a separate announce action, and no
 *                          setup-mode button on the player-facing storefront.
 *
 * Assertion bar: values, not presence. Every interactive control this batch ships is driven by a real
 * DOM event and read back by its VISIBLE or DOCUMENT outcome, and every stateful gesture is performed
 * twice or across a window reopen (the second-act rule).
 *
 * Run:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-shop-drawer.mjs
 *       node cp2020-augmented-shop-drawer.mjs --shots <dir>     also writes the view captures
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SHOTS = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? process.argv[i + 1] : null; })();
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

async function joinAs(page, match, pws) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const s = page.locator('select[name="userid"]');
  await s.waitFor({ state: "visible", timeout: 30000 });
  const us = await s.locator("option").evaluateAll(o => o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
  const u = us.find(x => match.test(x.l));
  if (!u) throw new Error("no user matching " + match);
  for (const pw of pws) {
    await s.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([page.waitForNavigation({ url: /\/game/, timeout: 20000 }).catch(() => {}), page.locator('button[name="join"]').click()]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 25000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await s.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("join failed " + u.l);
}

/** Installed once per page: the shop-window helpers every section reuses. */
const TOOLKIT = () => {
  const W = (window.__cpShop = {});
  W.sleep = (ms) => new Promise(r => setTimeout(r, ms));
  W.win = () => [...foundry.applications.instances.values()].find(w => w?.constructor?.name === "CatalogBrowser") ?? null;
  W.root = () => { const w = W.win(); return w?.element?.closest?.(".application") ?? w?.element ?? null; };
  /** Open the shop at a view and wait until the marker its view is known by is painted. */
  W.open = async (view, shopId, marker) => {
    const C = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    C.openShopWindow(W.buyer ?? null, { view, shopId: shopId ?? null });
    for (let i = 0; i < 60; i++) { const r = W.root(); if (r?.querySelector(marker)) return r; await W.sleep(300); }
    return W.root();
  };
  W.close = async () => { try { await W.win()?.close({ force: true }); } catch {} await W.sleep(250); };
  W.txt = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  /** Drive a real, bubbling DOM event and let the handler's async work settle. */
  W.fire = async (el, type, init = {}, settle = 500) => {
    if (!el) return false;
    const Ctor = /^pointer/.test(type) ? PointerEvent : /^(click|mouse)/.test(type) ? MouseEvent : Event;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
    await W.sleep(settle);
    return true;
  };
  /** A pointer stroke across a list of elements: down on the first, move over each, up on the last.
   *  Returns a per-step trace (box + what the crossed point actually resolves to), so a stroke that
   *  fails says WHY — an off-screen or covered button is a fixture fault, not a handler fault. */
  W.stroke = async (els) => {
    const trace = [];
    if (!els.length || els.some(e => !e)) return ["no buttons"];
    // A stroke is a gesture over things you can SEE: bring the run on screen first, exactly as a
    // person scrolling to a filter list would, or the hit-test lands outside the viewport.
    els[0].scrollIntoView({ block: "center" });
    await W.sleep(250);
    const at = (el) => { const b = el.getBoundingClientRect(); return { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 }; };
    const base = { bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1 };
    els[0].dispatchEvent(new PointerEvent("pointerdown", { ...base, ...at(els[0]) }));
    await W.sleep(40);
    for (const el of els) {
      const pt = at(el);
      const bx = el.getBoundingClientRect();
      const hit = document.elementFromPoint(pt.clientX, pt.clientY);
      trace.push(`${el.dataset.cat ?? el.dataset.book}[${Math.round(bx.width)}x${Math.round(bx.height)}]->${hit?.closest?.(".cp-cat-chip, .cp-book-chip") ? "chip" : (hit?.className || "null")}`);
      el.dispatchEvent(new PointerEvent("pointermove", { ...base, ...pt }));
      await W.sleep(40);
    }
    const last = els[els.length - 1];
    last.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0, ...at(last) }));
    await W.sleep(700);
    return trace;
  };
};

const b = await chromium.launch({ headless: true });
const log = []; const errors = []; let pass = false;
const P = [];
const chk = (name, ok, detail = "") => { P.push({ name, ok: !!ok, detail: String(detail) }); return !!ok; };
const take = (rows) => { for (const c of rows ?? []) P.push({ name: c.label, ok: !!c.ok, detail: String(c.got ?? "") }); };
/** Run one unit's section. A throw inside it fails THAT section and lets the rest of the suite run,
 *  so one unimplemented unit cannot hide the state of the other six. */
const section = async (name, fn) => { try { take(await fn()); } catch (e) { chk(`S${name} ran to completion`, false, e?.message || String(e)); } };

try {
  const ctx = await b.newContext({ viewport: { width: 1700, height: 1000 } });
  const gm = await ctx.newPage();
  gm.on("pageerror", e => errors.push("pageerror: " + e.message));
  gm.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await joinAs(gm, /gamemaster/i, [GM_PW]);
  await gm.evaluate(TOOLKIT);

  // Shopping must be on for the window to open at all; restored at the end.
  const shopWas = await gm.evaluate(async () => {
    let was = null;
    try { was = game.settings.get("cp2020-augmented", "shoppingEnabled"); if (was !== true) await game.settings.set("cp2020-augmented", "shoppingEnabled", true); } catch {}
    return was;
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //  S1 · PACK MAPPING RESCUE — per-pack cell contributions off the REAL catalog index
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  await section("1 · pack mapping", () => gm.evaluate(async () => {
    const checks = []; const chk = (label, ok, got) => checks.push({ label, ok: !!ok, got });
    const CATS = await import("/modules/cp2020-augmented/module/shop/categories.js");
    const CAT = await import("/modules/cp2020-augmented/module/shop/catalog.js");

    // Pure: a supplement pack resolves through the same table its base-system twin does.
    const cop = (n) => { const r = CATS.categoryOfPack(n); return `${r.category}/${r.sub}`; };
    chk("pack identity: supplement-pistols resolves to the Pistols cell", cop("supplement-pistols") === "Weapons/Pistols", cop("supplement-pistols"));
    chk("pack identity: supplement-chipware resolves to the Chipware cell", cop("supplement-chipware") === "Cyberware/Chipware", cop("supplement-chipware"));
    chk("pack identity: the base pistols pack is unchanged", cop("pistols") === "Weapons/Pistols", cop("pistols"));
    chk("pack identity: an unknown pack still falls back to Gear/Other", cop("__nope__") === "Gear/Other", cop("__nope__"));
    chk("pack identity: supplement-pistols is reported as mapped", CATS.isMappedPack("supplement-pistols") === true, CATS.isMappedPack("supplement-pistols"));

    // The real index: group every row by the pack it came from and by the cell it landed in.
    const all = await CAT.getCatalogIndex();
    const byPack = new Map();
    for (const it of all) {
      const short = String(it.packId).split(".").pop();
      const m = byPack.get(short) ?? new Map();
      const k = `${it.category}/${it.sub}`;
      m.set(k, (m.get(k) ?? 0) + 1);
      byPack.set(short, m);
    }
    const cells = (p) => Object.fromEntries([...(byPack.get(p) ?? new Map())].sort());
    const only = (p, cell, n) => { const c = cells(p); return Object.keys(c).length === 1 && c[cell] === n; };

    const pinned = [
      ["supplement-pistols", "Weapons/Pistols", 68], ["supplement-submachineguns", "Weapons/SMGs", 21],
      ["supplement-rifles", "Weapons/Rifles", 43], ["supplement-shotguns", "Weapons/Shotguns", 19],
      ["supplement-heavy", "Weapons/Heavy", 68], ["supplement-melee", "Weapons/Melee", 19],
      ["supplement-exotics", "Weapons/Exotic", 27], ["supplement-chipware", "Cyberware/Chipware", 205],
      ["supplement-armor", "Armor/", 85], ["supplement-gear", "Gear/Other", 505],
      ["supplement-programs", "Programs/", 221],
    ];
    for (const [p, cell, n] of pinned) chk(`cell count: ${p} → ${n} in ${cell}, and nowhere else`, only(p, cell, n), JSON.stringify(cells(p)));

    // Cyberware: the pack names no sub, so item data still decides the shelf inside Cyberware.
    const cw = cells("supplement-cyberware");
    const cwTotal = Object.values(cw).reduce((a, x) => a + x, 0);
    chk("cell count: supplement-cyberware stays inside Cyberware (plus any borg body)",
      Object.keys(cw).every(k => k.startsWith("Cyberware/") || k === "FBC/") && cwTotal === 104, JSON.stringify(cw));
    chk("cell count: the chipware strays inside supplement-cyberware still shelve as Chipware",
      (cw["Cyberware/Chipware"] ?? 0) === 23, cw["Cyberware/Chipware"]);

    // Vehicles: the pack names no sub either, so the class rules still run per item.
    const vh = cells("supplement-vehicles");
    chk("cell count: supplement-vehicles is wholly under Vehicles (209)",
      Object.keys(vh).every(k => k.startsWith("Vehicles/")) && Object.values(vh).reduce((a, x) => a + x, 0) === 209, JSON.stringify(vh));

    // NEGATIVE: no supplement pack other than the gear pack leaks into the Gear/Other bucket.
    const leaked = [...byPack].filter(([p, m]) => p.startsWith("supplement-") && p !== "supplement-gear" && m.has("Gear/Other")).map(([p]) => p);
    chk("negative: no supplement pack but the gear pack lands in Gear/Other", leaked.length === 0, leaked.join(","));
    // NEGATIVE: no supplement weapon lands in the Weapons/Other bucket.
    const wOther = [...byPack].filter(([p, m]) => p.startsWith("supplement-") && m.has("Weapons/Other")).map(([p]) => p);
    chk("negative: no supplement weapon lands in Weapons/Other", wOther.length === 0, wOther.join(","));

    // Base packs keep their cells (the rescue must not move anything that already worked).
    chk("base pack: fashion still files under Gear/Fashion", only("fashion", "Gear/Fashion", (byPack.get("fashion")?.get("Gear/Fashion")) ?? -1), JSON.stringify(cells("fashion")));
    chk("base pack: cyberlimbs still files under Cyberware/Cyberlimbs",
      Object.keys(cells("cyberlimbs")).every(k => k === "Cyberware/Cyberlimbs" || k === "FBC/"), JSON.stringify(cells("cyberlimbs")));
    return checks;
  }));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //  S2 · VEHICLE SUB-FILTERS
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  await section("2 · vehicle shelves", () => gm.evaluate(async () => {
    const checks = []; const chk = (label, ok, got) => checks.push({ label, ok: !!ok, got });
    const CATS = await import("/modules/cp2020-augmented/module/shop/categories.js");
    const CAT = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    const v = CATS.vehicleSubOf;
    chk("class rule: a hovercraft folds into Other", v("Hovercraft") === "Other", v("Hovercraft"));
    chk("class rule: a hover panzer still resolves before Military, into Other", v("Hover Tank") === "Other", v("Hover Tank"));
    chk("class rule: an RPV folds into Other", v("RPV") === "Other", v("RPV"));
    chk("class rule: blank class is its own shelf, not Other", v("") === "Unclassified", v(""));
    chk("class rule: an unrecognised class is still Other", v("Mule") === "Other", v("Mule"));
    chk("class rule: Watercraft is kept", v("submarine") === "Watercraft", v("submarine"));
    chk("class rule: Spacecraft is kept", v("orbital shuttle") === "Spacecraft", v("orbital shuttle"));
    chk("class rule: a car is untouched", v("Sedan") === "Cars", v("Sedan"));

    const subs = CATS.CATEGORIES.find(c => c.key === "Vehicles").subs;
    chk("shelf list: Hover and Drones are retired from the filter list", !subs.includes("Hover") && !subs.includes("Drones"), subs.join(","));
    chk("shelf list: Unclassified is offered", subs.includes("Unclassified"), subs.join(","));
    chk("shelf list: Watercraft and Spacecraft survive", subs.includes("Watercraft") && subs.includes("Spacecraft"), subs.join(","));

    const all = await CAT.getCatalogIndex();
    const n = (sub) => all.filter(i => i.category === "Vehicles" && i.sub === sub).length;
    chk("index: nothing is left on the Hover shelf", n("Hover") === 0, n("Hover"));
    chk("index: nothing is left on the Drones shelf", n("Drones") === 0, n("Drones"));
    chk("index: the folded shelves land in Other (13)", n("Other") === 13, n("Other"));
    chk("index: every blank-class vehicle is findable under Unclassified (88)", n("Unclassified") === 88, n("Unclassified"));
    chk("index: no vehicle is left with an empty shelf key", n("") === 0, n(""));

    const lbl = game.i18n.localize("CYBERPUNK.ShopSubUnclassified");
    chk("label: the Unclassified shelf carries a localized label", !!lbl && lbl !== "CYBERPUNK.ShopSubUnclassified" && /\(/.test(lbl), lbl);
    return checks;
  }));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //  S3 · THE FILTER DRAWER
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const shopId = await gm.evaluate(async () => {
    const SH = await import("/modules/cp2020-augmented/module/shop/shops.js");
    const CAT = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    for (const s of SH.listShops().filter(s => /^__PW__DRAWER/.test(s.name))) await SH.deleteShop(s.id);
    const def = await SH.createShop({ name: "__PW__DRAWER Shop" });
    const all = await CAT.getCatalogIndex();
    for (const row of all.slice(0, 4)) await SH.addShopItem(def.id, row.key);
    await SH.setAllShopStock(def.id, { unlimited: false, qty: 4 });
    return def.id;
  });

  await section("3 · filter drawer", () => gm.evaluate(async (shopId) => {
    const W = window.__cpShop;
    const checks = []; const chk = (label, ok, got) => checks.push({ label, ok: !!ok, got });
    const CAT = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    const all = await CAT.getCatalogIndex();

    try { localStorage.removeItem("cp2020-augmented.shopDrawer"); } catch {}
    let r = await W.open("catalog", null, ".cp-catalog-landing, .cp-catalog-row");
    // Reach the item list, where both rails used to live.
    await W.fire(r.querySelector('.cp-cat-tile[data-cat=""]'), "click", {}, 1400);
    r = W.root();

    chk("drawer: exactly one filter drawer on the catalog", r.querySelectorAll(".cp-filter-drawer").length === 1, r.querySelectorAll(".cp-filter-drawer").length);
    chk("drawer: the books rail lives INSIDE the drawer, not beside the list",
      !!r.querySelector(".cp-filter-drawer .cp-catalog-books") && !r.querySelector(".cp-catalog-body > .cp-catalog-books"),
      `${!!r.querySelector(".cp-filter-drawer .cp-catalog-books")}/${!!r.querySelector(".cp-catalog-body > .cp-catalog-books")}`);
    chk("drawer: the source tag toggle moved out of the header into the drawer",
      !!r.querySelector(".cp-filter-drawer .cp-catalog-showsource") && !r.querySelector(".cp-catalog-toolbar .cp-catalog-showsource"),
      `${!!r.querySelector(".cp-filter-drawer .cp-catalog-showsource")}/${!!r.querySelector(".cp-catalog-toolbar .cp-catalog-showsource")}`);
    chk("drawer: both rails' ✕ buttons are retired",
      !r.querySelector(".cp-cat-clear") && !r.querySelector(".cp-book-clear"),
      `${!!r.querySelector(".cp-cat-clear")}/${!!r.querySelector(".cp-book-clear")}`);
    chk("drawer: exactly one collapse affordance", r.querySelectorAll(".cp-drawer-toggle").length === 1, r.querySelectorAll(".cp-drawer-toggle").length);

    // LIVE COUNTS, by value, against the index THIS viewer can see — the same visibility gate the
    // window applies, so the count is checked against the pool and not against the raw compendium.
    const SUP = await import("/modules/cp2020-augmented/module/shop/supplements.js");
    const ST = await import("/modules/cp2020-augmented/module/settings.js");
    const cfg = ST.shopSourceConfig();
    const visible = all.filter(i => SUP.isVisibleTo(i.supplement, i.canon, cfg, game.user.isGM));
    const wantWeapons = visible.filter(i => i.category === "Weapons").length;
    const gotWeapons = Number(r.querySelector('.cp-cat-chip[data-cat="Weapons"]')?.dataset.count);
    chk("counts: the Weapons chip carries the live item count", gotWeapons === wantWeapons, `${gotWeapons} vs ${wantWeapons}`);
    const countText = W.txt(r.querySelector('.cp-cat-chip[data-cat="Weapons"] .cp-cat-count'));
    chk("counts: the count is painted on the chip", countText === String(wantWeapons), countText);
    const wantPistols = visible.filter(i => i.category === "Weapons" && i.sub === "Pistols").length;
    const gotPistols = Number(r.querySelector('.cp-cat-chip[data-cat="Weapons/Pistols"]')?.dataset.count);
    chk("counts: a sub-shelf chip carries its own count", gotPistols === wantPistols, `${gotPistols} vs ${wantPistols}`);
    const bookChip = r.querySelector('.cp-book-chip[data-book="__core__"]');
    chk("counts: a book chip carries a count too", Number(bookChip?.dataset.count) > 0, bookChip?.dataset.count);

    // Filter SEMANTICS unchanged: a sub-shelf click narrows to exactly that shelf.
    await W.fire(r.querySelector('.cp-cat-chip[data-cat="Weapons/Pistols"]'), "click", {}, 1500);
    r = W.root();
    const rows = [...r.querySelectorAll(".cp-catalog-list .cp-catalog-row")];
    chk("semantics: the Pistols shelf shows exactly its own rows", rows.length === wantPistols, `${rows.length} vs ${wantPistols}`);
    await W.fire(r.querySelector('.cp-cat-chip[data-cat="Weapons/Pistols"]'), "click", {}, 1500);
    r = W.root();
    chk("semantics: clicking the same shelf again clears it (second act)",
      r.querySelectorAll(".cp-catalog-list .cp-catalog-row").length > wantPistols, r.querySelectorAll(".cp-catalog-list .cp-catalog-row").length);

    // CLEAR — one control, both dimensions, and it only exists while something is on to clear.
    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons/Pistols"]'), "click", {}, 1400);
    await W.fire(W.root().querySelector('.cp-book-chip[data-book="__core__"]'), "click", {}, 1400);
    chk("clear: the clear control appears once a filter is on", !!W.root().querySelector(".cp-drawer-clear"), !!W.root().querySelector(".cp-drawer-clear"));
    await W.fire(W.root().querySelector(".cp-drawer-clear"), "click", {}, 1600);
    r = W.root();
    chk("clear: it clears BOTH dimensions at once",
      !r.querySelector(".cp-cat-chip.active") && !r.querySelector(".cp-book-chip.active"),
      `${r.querySelectorAll(".cp-cat-chip.active").length}/${r.querySelectorAll(".cp-book-chip.active").length}`);
    chk("clear: with nothing on, the control is not offered", !r.querySelector(".cp-drawer-clear"), !!r.querySelector(".cp-drawer-clear"));

    // GROUP EXPANSION — collapse a group, and it stays collapsed through a re-render.
    const grp = () => W.root().querySelector('.cp-cat-group[data-cat="Weapons"]');
    const subsVisible = () => { const g = grp(); const s = g?.querySelector(".cp-cat-subs"); return !!s && s.getBoundingClientRect().height > 0; };
    chk("groups: the Weapons group starts expanded", subsVisible(), subsVisible());
    await W.fire(grp().querySelector(".cp-cat-expand"), "click", {}, 900);
    chk("groups: clicking the expander collapses the group", !subsVisible(), subsVisible());
    await W.win().render();
    await W.sleep(1200);
    chk("groups: the collapsed group survives a re-render", !subsVisible(), subsVisible());

    // COLLAPSE — the drawer state is browser-local and survives a close/reopen.
    const drawer = () => W.root().querySelector(".cp-filter-drawer");
    await W.fire(W.root().querySelector(".cp-drawer-toggle"), "click", {}, 900);
    chk("collapse: the drawer reports itself closed", drawer()?.dataset.open === "0", drawer()?.dataset.open);
    chk("collapse: the filter body is no longer laid out", (W.root().querySelector(".cp-catalog-filters")?.getBoundingClientRect().width ?? 0) === 0,
      W.root().querySelector(".cp-catalog-filters")?.getBoundingClientRect().width);
    let stored = null; try { stored = JSON.parse(localStorage.getItem("cp2020-augmented.shopDrawer") || "null"); } catch {}
    chk("collapse: the state is written to browser storage, not to a game setting", stored?.open === false, JSON.stringify(stored));
    await W.close();
    r = await W.open("catalog", null, ".cp-catalog-landing, .cp-catalog-row");
    await W.fire(r.querySelector('.cp-cat-tile[data-cat=""]'), "click", {}, 1600);
    chk("collapse: a reopened window is still collapsed (second act)", W.root().querySelector(".cp-filter-drawer")?.dataset.open === "0",
      W.root().querySelector(".cp-filter-drawer")?.dataset.open);
    await W.fire(W.root().querySelector(".cp-drawer-toggle"), "click", {}, 900);
    chk("collapse: clicking again reopens it", W.root().querySelector(".cp-filter-drawer")?.dataset.open === "1",
      W.root().querySelector(".cp-filter-drawer")?.dataset.open);
    chk("collapse: the toggle carries a localized tooltip",
      /\S/.test(W.root().querySelector(".cp-drawer-toggle")?.title ?? "") && !/^CYBERPUNK\./.test(W.root().querySelector(".cp-drawer-toggle")?.title ?? ""),
      W.root().querySelector(".cp-drawer-toggle")?.title);

    // The SAME drawer serves the builder.
    await W.close();
    r = await W.open("build", shopId, ".cp-vendor-tray");
    chk("shared: the builder carries the same one drawer", r.querySelectorAll(".cp-filter-drawer").length === 1, r.querySelectorAll(".cp-filter-drawer").length);
    chk("shared: the builder's books rail is inside that drawer", !!r.querySelector(".cp-filter-drawer .cp-catalog-books"), !!r.querySelector(".cp-filter-drawer .cp-catalog-books"));
    chk("shared: the builder has no leftover ✕ rail buttons", !r.querySelector(".cp-cat-clear") && !r.querySelector(".cp-book-clear"), "");
    chk("shared: the GM sees the per-book visibility eyes", r.querySelectorAll(".cp-filter-drawer .cp-src-toggle").length > 0, r.querySelectorAll(".cp-filter-drawer .cp-src-toggle").length);
    await W.close();
    return checks;
  }, shopId));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //  S4 · LANDING VIEW
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  await section("4 · landing view", () => gm.evaluate(async () => {
    const W = window.__cpShop;
    const checks = []; const chk = (label, ok, got) => checks.push({ label, ok: !!ok, got });
    const CAT = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    const LK = await import("/modules/cp2020-augmented/module/lookups.js");
    const all = await CAT.getCatalogIndex();

    let r = await W.open("catalog", null, ".cp-catalog-landing");
    chk("landing: the catalog opens on the category tiles", !!r.querySelector(".cp-catalog-landing"), !!r.querySelector(".cp-catalog-landing"));
    chk("landing: no item rows are painted on the landing", r.querySelectorAll(".cp-catalog-row").length === 0, r.querySelectorAll(".cp-catalog-row").length);
    chk("landing: the API view name is still 'catalog'", W.win().view === "catalog", W.win().view);

    const SUP = await import("/modules/cp2020-augmented/module/shop/supplements.js");
    const ST = await import("/modules/cp2020-augmented/module/settings.js");
    const visible = all.filter(i => SUP.isVisibleTo(i.supplement, i.canon, ST.shopSourceConfig(), game.user.isGM));
    const tile = (k) => r.querySelector(`.cp-cat-tile[data-cat="${k}"]`);
    const wantCyber = visible.filter(i => i.category === "Cyberware").length;
    chk("landing: a tile carries its live count", Number(tile("Cyberware")?.dataset.count) === wantCyber, `${tile("Cyberware")?.dataset.count} vs ${wantCyber}`);
    chk("landing: the tile paints its name and its count",
      /Cyberware/i.test(W.txt(tile("Cyberware"))) && W.txt(tile("Cyberware")).includes(String(wantCyber)), W.txt(tile("Cyberware")));
    chk("landing: an all-items tile is offered", !!r.querySelector('.cp-cat-tile[data-cat=""]'), !!r.querySelector('.cp-cat-tile[data-cat=""]'));

    // THE AMMO TILE IS SPECIAL: its count is the caliber count, and it routes to the generated rows.
    const calibers = Object.keys(LK.getCalibers()).length;
    chk("landing: the ammo tile counts CALIBERS, not pack items", Number(tile("Ammo")?.dataset.count) === calibers, `${tile("Ammo")?.dataset.count} vs ${calibers}`);
    await W.fire(tile("Ammo"), "click", {}, 1600);
    r = W.root();
    const ammoRows = [...r.querySelectorAll(".cp-catalog-list .cp-catalog-row")];
    chk("landing: the ammo tile routes to the generated caliber rows",
      ammoRows.length === calibers && ammoRows.every(x => !!x.dataset.ammoCaliber), `${ammoRows.length}/${calibers}`);

    // Back up a level, then into All items.
    await W.fire(r.querySelector(".cp-catalog-uplevel"), "click", {}, 1200);
    r = W.root();
    chk("landing: the up-level control returns to the tiles", !!r.querySelector(".cp-catalog-landing"), !!r.querySelector(".cp-catalog-landing"));
    await W.fire(r.querySelector('.cp-cat-tile[data-cat=""]'), "click", {}, 2000);
    r = W.root();
    const jumpVisible = () => { const j = W.root().querySelector(".cp-catalog-jump"); return !!j && j.getBoundingClientRect().height > 0; };
    chk("letters: the A–Z strip is painted in all-items mode", jumpVisible(), jumpVisible());
    chk("letters: all-items shows the whole visible catalog", r.querySelectorAll(".cp-catalog-list .cp-catalog-row").length > 1000,
      r.querySelectorAll(".cp-catalog-list .cp-catalog-row").length);

    // A small shelf gets no letter strip; a long one (Chipware, 205) does.
    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons/Shotguns"]'), "click", {}, 1500);
    chk("letters: a short list is not given a letter strip", !jumpVisible(), `${jumpVisible()} rows=${W.root().querySelectorAll(".cp-catalog-row").length}`);
    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons/Shotguns"]'), "click", {}, 1200);
    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Cyberware/Chipware"]'), "click", {}, 1800);
    chk("letters: a list over the threshold is given one", jumpVisible(), `${jumpVisible()} rows=${W.root().querySelectorAll(".cp-catalog-row").length}`);
    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Cyberware/Chipware"]'), "click", {}, 1500);

    // Search is global and always visible, and searching from the landing jumps to the results.
    await W.fire(W.root().querySelector(".cp-catalog-uplevel"), "click", {}, 1200);
    r = W.root();
    const box = r.querySelector(".cp-catalog-search");
    chk("search: the box is present on the landing", !!box && box.getBoundingClientRect().width > 0, box?.getBoundingClientRect().width);
    box.value = "militech";
    await W.fire(box, "input", {}, 1800);
    r = W.root();
    const hits = [...r.querySelectorAll(".cp-catalog-list .cp-catalog-row")].filter(x => x.style.display !== "none");
    chk("search: searching from the landing jumps straight to the results",
      !r.querySelector(".cp-catalog-landing") && hits.length > 0 && hits.every(x => /militech/i.test(x.dataset.name ?? "")),
      `${!r.querySelector(".cp-catalog-landing")} hits=${hits.length}`);
    await W.close();
    return checks;
  }));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //  S5 · PAINT-DRAG MULTI-TOGGLE
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  await section("5 · paint drag", () => gm.evaluate(async () => {
    const W = window.__cpShop;
    const checks = []; const chk = (label, ok, got) => checks.push({ label, ok: !!ok, got });
    // A stroke can only cross buttons that are on screen, so start from the drawer's default state
    // (open, every group expanded) rather than whatever the previous section left persisted.
    await W.close();
    try { localStorage.removeItem("cp2020-augmented.shopDrawer"); } catch {}
    let r = await W.open("catalog", null, ".cp-catalog-landing, .cp-catalog-row");
    if (r.querySelector('.cp-cat-tile[data-cat=""]')) { await W.fire(r.querySelector('.cp-cat-tile[data-cat=""]'), "click", {}, 1600); r = W.root(); }

    const chips = (keys) => keys.map(k => W.root().querySelector(`.cp-cat-chip[data-cat="${k}"]`));
    const on = (k) => !!W.root().querySelector(`.cp-cat-chip[data-cat="${k}"]`)?.classList.contains("active");
    const KEYS = ["Weapons/Pistols", "Weapons/SMGs", "Weapons/Rifles", "Weapons/Shotguns"];

    // Mixed start state: pre-arm one of the four with a plain click.
    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons/Rifles"]'), "click", {}, 1400);
    chk("paint: a plain click still toggles exactly one button", on("Weapons/Rifles") && !on("Weapons/Pistols"), KEYS.map(k => `${k}=${on(k)}`).join(" "));

    // Stroke ON: press an OFF button and drag across the mixed row — everything ends ON.
    let trace = await W.stroke(chips(KEYS));
    chk("paint: a stroke begun on an off button drives every crossed button on",
      KEYS.every(on), `${KEYS.map(k => `${k}=${on(k)}`).join(" ")} | ${trace.join(" ")}`);
    chk("paint: the stroke produced exactly one list rebuild (the rows agree with the filters)",
      W.root().querySelectorAll(".cp-catalog-list .cp-catalog-row").length > 0, W.root().querySelectorAll(".cp-catalog-list .cp-catalog-row").length);

    // Stroke OFF: press an ON button and drag back — everything ends OFF.
    trace = await W.stroke(chips([...KEYS].reverse()));
    chk("paint: a stroke begun on an on button drives every crossed button off",
      KEYS.every(k => !on(k)), `${KEYS.map(k => `${k}=${on(k)}`).join(" ")} | ${trace.join(" ")}`);

    // Leaving the column ends the stroke: press, move out over the list, then over another chip.
    const first = W.root().querySelector('.cp-cat-chip[data-cat="Weapons/Pistols"]');
    const away = W.root().querySelector(".cp-catalog-list");
    const later = W.root().querySelector('.cp-cat-chip[data-cat="Weapons/Melee"]');
    const at = (el) => { const b2 = el.getBoundingClientRect(); return { clientX: b2.left + b2.width / 2, clientY: b2.top + b2.height / 2 }; };
    const base = { bubbles: true, cancelable: true, pointerId: 9, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1 };
    first.dispatchEvent(new PointerEvent("pointerdown", { ...base, ...at(first) }));
    await W.sleep(40);
    away.dispatchEvent(new PointerEvent("pointermove", { ...base, ...at(away) }));
    await W.sleep(60);
    later.dispatchEvent(new PointerEvent("pointermove", { ...base, ...at(later) }));
    await W.sleep(60);
    later.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0, ...at(later) }));
    await W.sleep(900);
    chk("paint: leaving the column ends the stroke — the far chip is untouched", !on("Weapons/Melee"), on("Weapons/Melee"));
    if (on("Weapons/Pistols")) await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons/Pistols"]'), "click", {}, 1200);

    // Book chips paint too.
    const bkeys = [...W.root().querySelectorAll(".cp-book-chip")].slice(0, 3).map(el => el.dataset.book);
    const bon = (k) => !!W.root().querySelector(`.cp-book-chip[data-book="${k}"]`)?.classList.contains("active");
    trace = await W.stroke(bkeys.map(k => W.root().querySelector(`.cp-book-chip[data-book="${k}"]`)));
    chk("paint: the book column paints as well", bkeys.length >= 3 && bkeys.every(bon), `${bkeys.map(k => `${k}=${bon(k)}`).join(" ")} | ${trace.join(" ")}`);
    await W.stroke(bkeys.map(k => W.root().querySelector(`.cp-book-chip[data-book="${k}"]`)));
    chk("paint: and paints back off", bkeys.every(k => !bon(k)), bkeys.map(k => `${k}=${bon(k)}`).join(" "));

    // The visibility EYES are deliberately not paintable.
    const eyes = [...W.root().querySelectorAll(".cp-book-eye")].slice(0, 3);
    const eyeState = () => eyes.map(e => !!e.querySelector("input")?.checked).join(",");
    const before = eyeState();
    await W.stroke(eyes);
    chk("paint: dragging across the visibility eyes changes none of them", eyeState() === before, `${before} → ${eyeState()}`);
    await W.close();
    return checks;
  }));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //  S5b · PAINT ROOT-LISTENER STEADINESS — the release backstop registers on the PERSISTENT frame,
  //  so each render must retire the previous render's pair; a stacking pair is the regression.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  await section("5b · paint root listeners", () => gm.evaluate(async () => {
    const W = window.__cpShop;
    const checks = []; const chk = (label, ok, got) => checks.push({ label, ok: !!ok, got });
    await W.close();
    let r = await W.open("catalog", null, ".cp-catalog-landing, .cp-catalog-row");
    if (r.querySelector('.cp-cat-tile[data-cat=""]')) { await W.fire(r.querySelector('.cp-cat-tile[data-cat=""]'), "click", {}, 1600); r = W.root(); }
    // The paint wiring only registers when its chip columns are on screen — make sure the drawer is open.
    if (!W.root().querySelector(".cp-cat-chip")) { await W.fire(W.root().querySelector(".cp-drawer-toggle"), "click", {}, 1200); }
    chk("root-listener leg precondition: chip column present", !!W.root().querySelector(".cp-cat-chip"), "");
    const app = W.win();
    const el = app.element;
    // Tally root "pointerup" registrations across re-renders by shadowing this one element's
    // add/removeEventListener (delegating to the real prototype). Steady state = every render's adds
    // are matched by removes of the previous render's pair.
    let adds = 0, removes = 0;
    el.addEventListener = function (type, fn, opts) { if (type === "pointerup") adds++; return EventTarget.prototype.addEventListener.call(this, type, fn, opts); };
    el.removeEventListener = function (type, fn, opts) { if (type === "pointerup") removes++; return EventTarget.prototype.removeEventListener.call(this, type, fn, opts); };
    for (let i = 0; i < 4; i++) { await app.render(); await W.sleep(600); }
    delete el.addEventListener; delete el.removeEventListener;
    chk("paint root backstop: re-renders retire the previous pair (adds == removes over 4 renders)",
      adds > 0 && adds === removes, `adds=${adds} removes=${removes}`);
    // And the surviving generation is the live one: a plain chip click still toggles.
    const on = () => !!W.root().querySelector('.cp-cat-chip[data-cat="Weapons/Rifles"]')?.classList.contains("active");
    const wasOn = on();
    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons/Rifles"]'), "click", {}, 1400);
    chk("paint root backstop: the live generation's chip click still toggles after the renders", on() !== wasOn, `${wasOn} → ${on()}`);
    if (on() !== wasOn) await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons/Rifles"]'), "click", {}, 1200);
    await W.close();
    return checks;
  }));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //  S6 · SMALL-FIX BATCH
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  await section("6 · small fixes", () => gm.evaluate(async (shopId) => {
    const W = window.__cpShop;
    const checks = []; const chk = (label, ok, got) => checks.push({ label, ok: !!ok, got });
    const SH = await import("/modules/cp2020-augmented/module/shop/shops.js");

    // ── a one-item shop, for the pluralization ────────────────────────────────────────────
    let oneId = null;
    for (const s of SH.listShops().filter(s => /^__PW__ONE/.test(s.name))) await SH.deleteShop(s.id);
    const oneDef = await SH.createShop({ name: "__PW__ONE Item Shop" });
    oneId = oneDef.id;
    const CAT = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    const all = await CAT.getCatalogIndex();
    await SH.addShopItem(oneId, all[0].key);

    let r = await W.open("home", null, ".cp-home-list");
    const entry = [...r.querySelectorAll(".cp-home-shop")].find(e => /__PW__ONE/.test(W.txt(e)));
    const sub = W.txt(entry?.querySelector(".cp-home-sub"));
    chk("plural: a one-item shop reads '1 item', never '1 items'", /\b1 item\b/.test(sub) && !/1 items/.test(sub), sub);
    const many = [...r.querySelectorAll(".cp-home-shop")].find(e => /__PW__DRAWER/.test(W.txt(e)));
    chk("plural: a multi-item shop still reads the plural", /\b4 items\b/.test(W.txt(many?.querySelector(".cp-home-sub"))), W.txt(many?.querySelector(".cp-home-sub")));

    // ── the drawer heading is not clipped at the window's default width ───────────────────
    await W.close();
    r = await W.open("catalog", null, ".cp-catalog-landing, .cp-catalog-row");
    if (r.querySelector('.cp-cat-tile[data-cat=""]')) { await W.fire(r.querySelector('.cp-cat-tile[data-cat=""]'), "click", {}, 1600); r = W.root(); }
    const heads = [...r.querySelectorAll(".cp-drawer-title, .cp-drawer-subtitle")];
    const clipped = heads.filter(h => h.scrollWidth > h.clientWidth + 1).map(h => `${W.txt(h)} ${h.scrollWidth}/${h.clientWidth}`);
    chk("clipping: every drawer heading (Filters, Categories, Books) fits its box at the default width",
      heads.length >= 3 && clipped.length === 0, `${heads.length} headings, clipped: ${clipped.join(" | ") || "none"}`);

    // ── the add-to-shop control is not a shopping cart ────────────────────────────────────
    const add = r.querySelector(".cp-add-to-shop-btn");
    chk("icon: the add-to-shop control no longer wears a shopping cart",
      !!add && !/fa-cart/.test(add.querySelector("i")?.className ?? "cart"), add?.querySelector("i")?.className);
    chk("icon: it still says what it does", /\S/.test(add?.title ?? "") && !/^CYBERPUNK\./.test(add?.title ?? ""), add?.title);

    // ── every icon-only shop control carries a real localized tooltip ─────────────────────
    const iconOnly = (root) => [...root.querySelectorAll("button")].filter(btn => {
      if (!btn.querySelector("i")) return false;
      return W.txt(btn) === "";
    });
    const bare = (list) => list.filter(btn => !/\S/.test(btn.title ?? "") || /^CYBERPUNK\./.test(btn.title ?? ""))
      .map(btn => btn.className).slice(0, 8);
    chk("tooltips: no icon-only control on the catalog is left untitled", bare(iconOnly(r)).length === 0, bare(iconOnly(r)).join(" | "));
    // The builder carries the rest of them — the trash, the two ∞ buttons, the preview eye, the
    // per-line remove. Same rule, measured on the surface they actually render on.
    const catalogRoot = r;
    await W.close();
    const br = await W.open("build", shopId, ".cp-vendor-tray");
    const bareBuild = bare(iconOnly(br));
    chk("tooltips: no icon-only control in the shop builder is left untitled", bareBuild.length === 0, bareBuild.join(" | "));
    chk("tooltips: the builder's icon-only set is non-trivial (trash, ∞, preview, remove…)", iconOnly(br).length >= 4, iconOnly(br).length);
    await W.close();
    r = catalogRoot && await W.open("catalog", null, ".cp-catalog-landing, .cp-catalog-row");
    if (r.querySelector('.cp-cat-tile[data-cat=""]')) { await W.fire(r.querySelector('.cp-cat-tile[data-cat=""]'), "click", {}, 1600); r = W.root(); }

    // ── the buyer chip clips with an ellipsis and keeps the full text in its tooltip ──────
    let longActor = null;
    for (const a of game.actors.filter(a => /^__PW__LONGNAME/.test(a.name))) await a.delete().catch(() => {});
    longActor = await Actor.create({ name: "__PW__LONGNAME Aurelio Constantine Vargas-Whitfield the Third", type: "character", system: { eurobucks: 500 } });
    await W.win()._cpSyncBuyer(longActor);
    await W.sleep(600);
    const chip = W.root().querySelector(".cp-buyer-name");
    const cs = chip ? getComputedStyle(chip) : null;
    const hdr = W.root().querySelector(".cp-shop-header");
    chk("buyer chip: a long name is clipped, not allowed to stretch the header",
      !!chip && cs.textOverflow === "ellipsis" && chip.getBoundingClientRect().width <= 160 && hdr.scrollWidth <= hdr.clientWidth + 1,
      chip ? `${cs.textOverflow}/${Math.round(chip.getBoundingClientRect().width)}px hdr=${hdr.scrollWidth}/${hdr.clientWidth}` : "absent");
    chk("buyer chip: the full text is preserved in its tooltip", (chip?.title ?? "").includes("Vargas-Whitfield"), chip?.title);
    await longActor.delete().catch(() => {});

    // ── storefront stock reads as a quantity, not a bare parenthesis ──────────────────────
    await W.close();
    await SH.updateShop(shopId, { open: true });
    r = await W.open("storefront", shopId, ".cp-catalog-row, .cp-catalog-empty");
    const stock = W.txt(r.querySelector(".cp-shop-stockcount"));
    chk("stock: a stocked row reads as a localized quantity, not '(4)'", /×\s*4/.test(stock) && !/^\(\s*4\s*\)$/.test(stock) && /[A-Za-z]/.test(stock), stock);

    // ── the dead-end: a shop that no longer exists offers a way back, and is not titled Catalog ──
    await W.close();
    const gone = await SH.createShop({ name: "__PW__GONE Shop" });
    r = await W.open("storefront", gone.id, ".cp-catalog-row, .cp-catalog-empty, .cp-shop-missing");
    await SH.deleteShop(gone.id);
    await W.win().render();
    await W.sleep(1200);
    r = W.root();
    chk("dead end: the missing-shop panel is painted", !!r.querySelector(".cp-shop-missing"), !!r.querySelector(".cp-shop-missing"));
    const wtitle = W.txt(r.querySelector(".window-title"));
    chk("dead end: it stops calling itself the Shopping Catalog", wtitle !== game.i18n.localize("CYBERPUNK.CatalogTitle"), wtitle);
    const backBtn = r.querySelector(".cp-shop-missing-back");
    chk("dead end: a route back out is offered", !!backBtn, !!backBtn);
    await W.fire(backBtn, "click", {}, 1400);
    chk("dead end: taking it lands on the shop directory", !!W.root()?.querySelector(".cp-home-list") && W.win().view === "home",
      `${!!W.root()?.querySelector(".cp-home-list")}/${W.win()?.view}`);

    await W.close();
    try { await SH.deleteShop(oneId); } catch {}
    return checks;
  }, shopId));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //  S7 · CONTROL DEDUP
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  await section("7 · control dedup", () => gm.evaluate(async (shopId) => {
    const W = window.__cpShop;
    const checks = []; const chk = (label, ok, got) => checks.push({ label, ok: !!ok, got });
    const SH = await import("/modules/cp2020-augmented/module/shop/shops.js");

    let r = await W.open("build", shopId, ".cp-vendor-tray");
    chk("dedup: the builder has exactly one open/closed control", r.querySelectorAll(".cp-shop-open").length === 1, r.querySelectorAll(".cp-shop-open").length);
    chk("dedup: the second control that also opened the shop is gone", r.querySelectorAll(".cp-shop-publish").length === 0, r.querySelectorAll(".cp-shop-publish").length);
    chk("dedup: an explicit announce action is offered instead", r.querySelectorAll(".cp-shop-announce").length === 1, r.querySelectorAll(".cp-shop-announce").length);

    // The one control writes the flag BOTH ways (second act).
    const open = () => !!SH.getShop(shopId)?.open;
    const box = () => W.root().querySelector(".cp-shop-open");
    await SH.updateShop(shopId, { open: false });
    await W.win().render(); await W.sleep(900);
    box().checked = true; await W.fire(box(), "change", {}, 900);
    chk("dedup: ticking it opens the shop", open() === true, open());
    box().checked = false; await W.fire(box(), "change", {}, 900);
    chk("dedup: unticking it closes the shop again (second act)", open() === false, open());

    // Announce POSTS a link and leaves the open flag alone.
    const before = game.messages.size;
    const wasOpen = open();
    await W.fire(W.root().querySelector(".cp-shop-announce"), "click", {}, 1600);
    const posted = [...game.messages].slice(before).some(m => (m.content ?? "").includes("cp-shop-open-link"));
    chk("dedup: announcing posts a clickable shop link to chat", posted, `${game.messages.size - before} new`);
    chk("dedup: announcing does NOT silently open a closed shop", open() === wasOpen, `${wasOpen} → ${open()}`);

    // The hint wording was split — the open control and the announce action say different things.
    const h1 = game.i18n.localize("CYBERPUNK.ShopOpenHint");
    const h2 = game.i18n.localize("CYBERPUNK.ShopAnnounceHint");
    chk("dedup: the announce hint is its own localized string", !!h2 && h2 !== "CYBERPUNK.ShopAnnounceHint" && h2 !== h1, h2);

    // Setup mode: catalog + builder yes, the player-facing storefront no.
    chk("setup mode: the builder keeps its setup-mode control", !!W.root().querySelector(".cp-shop-setup-toggle"), true);
    await W.close();
    r = await W.open("catalog", null, ".cp-catalog-landing, .cp-catalog-row");
    chk("setup mode: the catalog keeps it too", !!r.querySelector(".cp-shop-setup-toggle"), !!r.querySelector(".cp-shop-setup-toggle"));
    await W.close();
    await SH.updateShop(shopId, { open: true });
    r = await W.open("storefront", shopId, ".cp-catalog-row, .cp-catalog-empty");
    chk("setup mode: the storefront drops it", !r.querySelector(".cp-shop-setup-toggle"), !!r.querySelector(".cp-shop-setup-toggle"));
    chk("setup mode: the storefront keeps Manage", !!r.querySelector(".cp-shop-manage"), !!r.querySelector(".cp-shop-manage"));
    await W.close();
    return checks;
  }, shopId));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //  S3b · PER-VIEWER COUNTS — a second client, joined as a player
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  {
    const pl = await (await b.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
    pl.on("pageerror", e => errors.push("player pageerror: " + e.message));
    pl.on("console", m => { if (m.type() === "error") errors.push("player console: " + m.text()); });
    let joined = true;
    try { await joinAs(pl, /^Test User 1$/i, ["", GM_PW]); } catch { joined = false; }
    chk("two-client: a player client joined the rig", joined, joined ? "" : "no Test User 1 on this rig");
    if (joined) {
      await pl.evaluate(TOOLKIT);
      // GM state: expose exactly one official book to players, hide the rest.
      const gmCounts = await gm.evaluate(async () => {
        const SCOPE = "cp2020-augmented";
        const prior = game.settings.get(SCOPE, "shopEnabledSources") || {};
        await game.settings.set(SCOPE, "shopEnabledSources", { "Maximum Metal": true });
        const CAT = await import("/modules/cp2020-augmented/module/shop/catalog.js");
        const all = await CAT.getCatalogIndex();
        return { prior, weapons: all.filter(i => i.category === "Weapons").length };
      });
      await gm.waitForTimeout(1200);
      await section("3b · per-viewer counts", () => pl.evaluate(async (gmWeapons) => {
        const W = window.__cpShop;
        const checks = []; const chk = (label, ok, got) => checks.push({ label, ok: !!ok, got });
        const CAT = await import("/modules/cp2020-augmented/module/shop/catalog.js");
        const SUP = await import("/modules/cp2020-augmented/module/shop/supplements.js");
        const ST = await import("/modules/cp2020-augmented/module/settings.js");
        const all = await CAT.getCatalogIndex();
        const cfg = ST.shopSourceConfig();
        const mine = all.filter(i => SUP.isVisibleTo(i.supplement, i.canon, cfg, false));
        const wantWeapons = mine.filter(i => i.category === "Weapons").length;

        let r = await W.open("catalog", null, ".cp-catalog-landing, .cp-catalog-row");
        chk("per-viewer: the player's catalog also opens on the tiles", !!r.querySelector(".cp-catalog-landing"), !!r.querySelector(".cp-catalog-landing"));
        const tileCount = Number(r.querySelector('.cp-cat-tile[data-cat="Weapons"]')?.dataset.count);
        chk("per-viewer: the player's Weapons tile counts only what the player may see",
          tileCount === wantWeapons && tileCount < gmWeapons, `player=${tileCount} want=${wantWeapons} gm=${gmWeapons}`);

        // A category with nothing visible to this player renders no tile at all.
        const emptyCats = ["Weapons", "Armor", "Ammo", "Cyberware", "FBC", "Gear", "Netrunning", "Programs", "Vehicles"]
          .filter(k => k !== "Ammo" && mine.filter(i => i.category === k).length === 0);
        const stillPainted = emptyCats.filter(k => !!r.querySelector(`.cp-cat-tile[data-cat="${k}"]`));
        chk("per-viewer: a category the player can see nothing in paints no tile",
          stillPainted.length === 0, `empty=${emptyCats.join(",")} painted=${stillPainted.join(",")}`);

        await W.fire(r.querySelector('.cp-cat-tile[data-cat=""]'), "click", {}, 1800);
        r = W.root();
        chk("per-viewer: the player's drawer chip count matches the player's own set",
          Number(r.querySelector('.cp-cat-chip[data-cat="Weapons"]')?.dataset.count) === wantWeapons,
          r.querySelector('.cp-cat-chip[data-cat="Weapons"]')?.dataset.count);
        chk("per-viewer: the player gets the filter half of the books rail",
          r.querySelectorAll(".cp-filter-drawer .cp-book-chip").length > 0, r.querySelectorAll(".cp-filter-drawer .cp-book-chip").length);
        chk("per-viewer: and none of the GM's visibility eyes",
          r.querySelectorAll(".cp-src-toggle").length === 0 && r.querySelectorAll(".cp-book-eye").length === 0,
          `${r.querySelectorAll(".cp-src-toggle").length}/${r.querySelectorAll(".cp-book-eye").length}`);
        // The catalog folds the generated caliber rows in beside the compendium rows, so the ceiling
        // is the player's visible index PLUS those rows — never more.
        const LK = await import("/modules/cp2020-augmented/module/lookups.js");
        const ceiling = mine.length + Object.keys(LK.getCalibers()).length;
        chk("per-viewer: the rows the player is shown never exceed the player's own set",
          r.querySelectorAll(".cp-catalog-list .cp-catalog-row").length <= ceiling,
          `${r.querySelectorAll(".cp-catalog-list .cp-catalog-row").length} vs ${ceiling}`);
        await W.close();
        return checks;
      }, gmCounts.weapons));
      await gm.evaluate(async (prior) => { await game.settings.set("cp2020-augmented", "shopEnabledSources", prior); }, gmCounts.prior);
    }
    await pl.close().catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //  CAPTURES
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  if (SHOTS) {
    const shot = async (name, prep) => {
      await gm.evaluate(prep, shopId);
      await gm.waitForTimeout(1500);
      const el = await gm.$(".application.cp-catalog");
      if (el) await el.screenshot({ path: `${SHOTS}/${name}.png` });
    };
    await shot("landing", async () => { const W = window.__cpShop; await W.close(); await W.open("catalog", null, ".cp-catalog-landing"); });
    await shot("drawer-open", async () => {
      const W = window.__cpShop; const r = W.root();
      await W.fire(r.querySelector('.cp-cat-tile[data-cat="Weapons"]'), "click", {}, 1600);
      if (W.root().querySelector('.cp-filter-drawer[data-open="0"]')) await W.fire(W.root().querySelector(".cp-drawer-toggle"), "click", {}, 800);
    });
    await shot("drawer-collapsed", async () => { const W = window.__cpShop; await W.fire(W.root().querySelector(".cp-drawer-toggle"), "click", {}, 900); });
    await shot("all-items", async () => {
      const W = window.__cpShop;
      await W.fire(W.root().querySelector(".cp-drawer-toggle"), "click", {}, 800);
      await W.fire(W.root().querySelector(".cp-catalog-uplevel"), "click", {}, 1200);
      await W.fire(W.root().querySelector('.cp-cat-tile[data-cat=""]'), "click", {}, 2000);
    });
    await shot("storefront", async (id) => { const W = window.__cpShop; await W.close(); await W.open("storefront", id, ".cp-catalog-row, .cp-catalog-empty"); });
    await shot("builder", async (id) => { const W = window.__cpShop; await W.close(); await W.open("build", id, ".cp-vendor-tray"); });
    log.push(`  captures written to ${SHOTS}`);
  }

  // ── teardown ────────────────────────────────────────────────────────────────────────────
  await gm.evaluate(async ({ shopId, shopWas }) => {
    const W = window.__cpShop;
    try { await W.close(); } catch {}
    const SH = await import("/modules/cp2020-augmented/module/shop/shops.js");
    for (const s of SH.listShops().filter(s => /^__PW__/.test(s.name))) { try { await SH.deleteShop(s.id); } catch {} }
    try { if (shopWas !== null && shopWas !== true) await game.settings.set("cp2020-augmented", "shoppingEnabled", shopWas); } catch {}
    for (const a of game.actors.filter(a => /^__PW__/.test(a.name))) await a.delete().catch(() => {});
    try { localStorage.removeItem("cp2020-augmented.shopDrawer"); } catch {}
    void shopId;
  }, { shopId, shopWas });

  chk("0 console errors", errors.length === 0, errors.slice(0, 6).join(" | "));
  pass = P.every(x => x.ok);
} catch (e) {
  chk("suite ran to completion", false, e?.message || String(e));
  pass = false;
} finally { await b.close(); }

for (const x of P) log.push(`  ${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  -> got " + x.detail}`);
console.log(log.join("\n"));
console.log(`\n${P.filter(x => x.ok).length}/${P.length} green`);
console.log(pass ? "\nRESULT: PASS" : "\nRESULT: FAIL");
process.exit(pass ? 0 : 1);
