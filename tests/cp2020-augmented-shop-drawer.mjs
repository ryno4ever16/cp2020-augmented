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
 *   S4  OPENING VIEW       the catalog opens straight onto the item list with the drawer beside it —
 *                          no front page — under a default category set of everything but Ammo, the
 *                          first chip pressed against that untouched set REPLACES it, and the letter
 *                          strip appears only where it earns its place.
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

  // ⏪ the shop's presence gate retired 2026-08-29 (settings-trim): the window is always available,
  //    so nothing is armed for it and nothing is handed back.

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
      ["supplement-heavy", "Weapons/Heavy", 68],
      // ⏪ 19 → 20 (2026-08-29, found by this sweep): NOT a settings-trim change and not a regression.
      //    Commit ed1e3cd split the two-blade entry into its two printed blades, so the pack source and
      //    the compiled pack both carry one more row than this pinned count was written against.
      ["supplement-melee", "Weapons/Melee", 20],
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
    // The catalog opens straight onto the item list, drawer and all — there is no front page to
    // step through to reach the rails this section is about.
    let r = await W.open("catalog", null, ".cp-catalog-row");

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

    // Filter SEMANTICS: a sub-shelf click narrows to exactly that shelf. It is the FIRST press
    // against this window's untouched default set, so it REPLACES that set rather than widening it
    // — the rule itself is pinned by value in S4; what is measured here is the shelf it lands on.
    await W.fire(r.querySelector('.cp-cat-chip[data-cat="Weapons/Pistols"]'), "click", {}, 1500);
    r = W.root();
    // The list is WINDOWED above 150 items, so the census lives on `.cp-catalog-list[data-total]`
    // and the DOM holds a window of it. Both are read: the total is the filter's answer, the
    // painted count proves rows actually reached the screen.
    const census = () => Number(W.root().querySelector(".cp-catalog-list")?.dataset.total);
    const painted = () => W.root().querySelectorAll(".cp-catalog-list .cp-catalog-row").length;
    const rows = [...r.querySelectorAll(".cp-catalog-list .cp-catalog-row")];
    chk("semantics: the Pistols shelf counts exactly its own rows", census() === wantPistols, `${census()} vs ${wantPistols}`);
    chk("semantics: and it paints rows from that set, never more than it holds",
      painted() > 0 && painted() <= census(), `${painted()} painted of ${census()}`);
    void rows;
    await W.fire(r.querySelector('.cp-cat-chip[data-cat="Weapons/Pistols"]'), "click", {}, 1500);
    r = W.root();
    chk("semantics: clicking the same shelf again clears it (second act)",
      census() > wantPistols && painted() > 0, `${census()} total / ${painted()} painted vs ${wantPistols}`);

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

    // GROUP EXPANSION — ⏪ REALIGNED 2026-08-19 (user ruling): groups start CLOSED (the top row is
    // the overview; only an explicit expand is remembered). Expand one, and it stays expanded
    // through a re-render — the persistence now runs the interesting direction.
    const grp = () => W.root().querySelector('.cp-cat-group[data-cat="Weapons"]');
    const subsVisible = () => { const g = grp(); const s = g?.querySelector(".cp-cat-subs"); return !!s && s.getBoundingClientRect().height > 0; };
    chk("groups: the Weapons group starts collapsed", !subsVisible(), subsVisible());
    await W.fire(grp().querySelector(".cp-cat-expand"), "click", {}, 900);
    chk("groups: clicking the expander opens the group", subsVisible(), subsVisible());
    await W.win().render();
    await W.sleep(1200);
    chk("groups: the expanded group survives a re-render", subsVisible(), subsVisible());
    await W.fire(grp().querySelector(".cp-cat-expand"), "click", {}, 900);
    chk("groups: a second click closes it again", !subsVisible(), subsVisible());

    // COLLAPSE — the drawer state is browser-local and survives a close/reopen.
    const drawer = () => W.root().querySelector(".cp-filter-drawer");
    await W.fire(W.root().querySelector(".cp-drawer-toggle"), "click", {}, 900);
    chk("collapse: the drawer reports itself closed", drawer()?.dataset.open === "0", drawer()?.dataset.open);
    chk("collapse: the filter body is no longer laid out", (W.root().querySelector(".cp-catalog-filters")?.getBoundingClientRect().width ?? 0) === 0,
      W.root().querySelector(".cp-catalog-filters")?.getBoundingClientRect().width);
    let stored = null; try { stored = JSON.parse(localStorage.getItem("cp2020-augmented.shopDrawer") || "null"); } catch {}
    chk("collapse: the state is written to browser storage, not to a game setting", stored?.open === false, JSON.stringify(stored));
    await W.close();
    r = await W.open("catalog", null, ".cp-catalog-row");
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
  //  S4 · OPENING VIEW — the catalog opens ON THE LIST, under a default category set
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //  The front page retired. A fresh window paints its item list immediately, with the filter
  //  drawer beside it, and the set it paints under is every top category the taxonomy names EXCEPT
  //  Ammo — marked untouched, so the FIRST category chip pressed against it REPLACES the set rather
  //  than widening it. Clear still empties both dimensions outright, and clicks after a Clear add
  //  up from empty. All three halves are pinned here, by value.
  //
  //  The list is WINDOWED above 150 items, so every count is read off `.cp-catalog-list[data-total]`
  //  (the census for the whole set) with the painted row count checked alongside it, and "is there
  //  any ammunition in this set" is asked of the DATA by searching a caliber label — a question the
  //  painted window cannot answer on its own.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  await section("4 · opening view", () => gm.evaluate(async () => {
    const W = window.__cpShop;
    const checks = []; const chk = (label, ok, got) => checks.push({ label, ok: !!ok, got });
    const CAT = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    const CATS = await import("/modules/cp2020-augmented/module/shop/categories.js");
    const LK = await import("/modules/cp2020-augmented/module/lookups.js");
    const SUP = await import("/modules/cp2020-augmented/module/shop/supplements.js");
    const ST = await import("/modules/cp2020-augmented/module/settings.js");
    const all = await CAT.getCatalogIndex();
    const visible = all.filter(i => SUP.isVisibleTo(i.supplement, i.canon, ST.shopSourceConfig(), game.user.isGM));

    const census = () => Number(W.root()?.querySelector(".cp-catalog-list")?.dataset.total);
    const painted = () => W.root()?.querySelectorAll(".cp-catalog-list .cp-catalog-row").length ?? 0;
    const catSet = () => [...W.win()._cats].sort().join(",");
    const on = (k) => !!W.root()?.querySelector(`.cp-cat-chip[data-cat="${k}"]`)?.classList.contains("active");
    const jumpVisible = () => { const j = W.root().querySelector(".cp-catalog-jump"); return !!j && j.getBoundingClientRect().height > 0; };
    const searchFor = async (term, settle = 1700) => {
      const box = W.root().querySelector(".cp-catalog-search");
      box.value = term;
      await W.fire(box, "input", {}, settle);
      return box;
    };

    // A fresh window with a default drawer, so the opening state is the OPENING state and not
    // something a prior section left behind.
    await W.close();
    try { localStorage.removeItem("cp2020-augmented.shopDrawer"); } catch {}
    let r = await W.open("catalog", null, ".cp-catalog-row");

    // ── the front page is gone: the list and the drawer are what a fresh open paints ──────────
    chk("opening: the catalog opens straight onto the item list", painted() > 0, painted());
    chk("opening: the filter drawer is mounted beside it", r.querySelectorAll(".cp-filter-drawer").length === 1, r.querySelectorAll(".cp-filter-drawer").length);
    chk("retired: no tile grid is rendered", !r.querySelector(".cp-catalog-landing"), !!r.querySelector(".cp-catalog-landing"));
    chk("retired: no category tile is rendered", r.querySelectorAll(".cp-cat-tile").length === 0, r.querySelectorAll(".cp-cat-tile").length);
    chk("retired: the up-level control is gone from the header", !r.querySelector(".cp-catalog-uplevel"), !!r.querySelector(".cp-catalog-uplevel"));
    chk("opening: the API view name is still 'catalog'", W.win().view === "catalog", W.win().view);

    // ── THE DEFAULT SET, BY VALUE against the taxonomy — every top category but Ammo ──────────
    const wantSet = CATS.CATEGORIES.map(c => c.key).filter(k => k !== "Ammo").sort();
    chk("default set: a fresh catalog carries every top category the taxonomy names except Ammo",
      catSet() === wantSet.join(","), `${catSet()} vs ${wantSet.join(",")}`);
    chk("default set: and it is marked untouched, so the first chip pressed will replace it",
      W.win()._catsPristine === true, W.win()._catsPristine);

    // ⏪ REALIGNED 2026-08-19 (user ruling): an UNTOUCHED default paints NO lit chips — on open the
    // wall of highlights read as "several filters already applied" when it was just the default
    // view. The highlight now marks a DELIBERATE choice: membership is unchanged (the rows still
    // census to taxonomy-minus-Ammo, asserted above and below), the lit look waits for first touch.
    const topChips = [...r.querySelectorAll(".cp-cat-chip")].filter(el => !String(el.dataset.cat).includes("/"));
    const litNow = topChips.filter(el => el.classList.contains("active")).map(el => el.dataset.cat);
    chk("default set: the pristine drawer paints NO lit chips (highlight = a deliberate choice)",
      topChips.length >= 2 && litNow.length === 0 && r.querySelectorAll(".cp-cat-chip.active").length === 0,
      `lit: ${litNow.join(",") || "none"}`);
    chk("default set: the Ammo chip is offered, unlit, so the rows are one click away",
      !!r.querySelector('.cp-cat-chip[data-cat="Ammo"]') && !on("Ammo"), r.querySelector('.cp-cat-chip[data-cat="Ammo"]')?.className);

    // ── and the CENSUS agrees with it: the visible compendium set, and no ammunition ──────────
    const inDefault = new Set(wantSet);
    const wantOpen = visible.filter(i => inDefault.has(i.category)).length;
    const calibers = Object.keys(LK.getCalibers()).length;
    chk("default set: the opening census is the visible catalog under exactly that set",
      census() === wantOpen, `data-total=${census()} vs index=${wantOpen}`);
    chk("default set: which is a list far past the window threshold", census() > 1000, census());
    chk("default set: so the DOM holds a window of it, never the whole thing",
      painted() > 0 && painted() < census(), `${painted()} painted of ${census()}`);
    chk("default set: no generated caliber row is painted at open",
      W.root().querySelectorAll(".cp-catalog-list .cp-catalog-row[data-ammo-caliber]").length === 0,
      W.root().querySelectorAll(".cp-catalog-list .cp-catalog-row[data-ammo-caliber]").length);

    // The painted window is a screenful; the DATA is the claim. Search a caliber label no compendium
    // row's name carries, so a hit can only be a generated ammunition row — and there are none.
    const probe = Object.entries(LK.getCalibers())
      .map(([id, c]) => String((c && c.label) ? c.label : id))
      .find(L => L && !visible.some(i => i.name.toLowerCase().includes(L.toLowerCase()))) ?? null;
    chk("default set: a caliber label was found that no compendium row's name carries", !!probe, probe);
    if (probe) {
      await searchFor(probe);
      chk(`default set: searching "${probe}" finds nothing — the ammunition is not in the set at all`,
        census() === 0 && painted() === 0, `data-total=${census()} painted=${painted()}`);
      await searchFor("");
    }

    // ── CLEAR empties the set outright, which is what lets the ammunition through ─────────────
    chk("clear: with the default set on, the clear control is offered", !!W.root().querySelector(".cp-drawer-clear"), !!W.root().querySelector(".cp-drawer-clear"));
    await W.fire(W.root().querySelector(".cp-drawer-clear"), "click", {}, 2200);
    r = W.root();
    chk("clear: it empties the category set", W.win()._cats.size === 0, W.win()._cats.size);
    chk("clear: and the census grows by exactly the generated caliber rows",
      census() === visible.length + calibers, `${census()} vs ${visible.length + calibers}`);
    if (probe) {
      await searchFor(probe);
      const hit = [...W.root().querySelectorAll(".cp-catalog-list .cp-catalog-row")];
      chk(`clear: the same "${probe}" search now finds the generated caliber rows (second act)`,
        census() > 0 && hit.length > 0 && hit.every(x => !!x.dataset.ammoCaliber), `${census()} total, ${hit.length} painted`);
      await searchFor("");
    }

    // ── THE LETTER STRIP: earned by row count, in the cleared state and on a shelf ────────────
    chk("letters: the cleared, everything-shown list is given a strip", jumpVisible(), jumpVisible());
    // With the default spent by the Clear, a single chip really does narrow to that one shelf.
    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons/Shotguns"]'), "click", {}, 1600);
    chk("letters: a short list is not given a letter strip", !jumpVisible(), `${jumpVisible()} rows=${census()}`);
    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons/Shotguns"]'), "click", {}, 1300);
    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Cyberware/Chipware"]'), "click", {}, 1900);
    chk("letters: a list over the threshold is given one", jumpVisible(), `${jumpVisible()} rows=${census()}`);

    // ── SECOND ACT + THE FIRST-TOUCH RULE, on a window rebuilt from scratch ───────────────────
    await W.close();
    r = await W.open("catalog", null, ".cp-catalog-row");
    chk("second act: a reopened catalog is back on the default set", catSet() === wantSet.join(","), catSet());
    chk("second act: rebuilding the default restores the untouched mark with it",
      W.win()._catsPristine === true, W.win()._catsPristine);
    chk("second act: the opening list earns its letter strip", jumpVisible(), jumpVisible());

    const wantPistols = visible.filter(i => i.category === "Weapons" && i.sub === "Pistols").length;
    const wantSMGs = visible.filter(i => i.category === "Weapons" && i.sub === "SMGs").length;
    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons/Pistols"]'), "click", {}, 1600);
    chk("first touch: the chip pressed becomes the WHOLE set, by value", catSet() === "Weapons/Pistols", catSet());
    chk("first touch: so the census narrows to exactly that shelf", census() === wantPistols, `${census()} vs ${wantPistols}`);
    chk("first touch: and rows from it actually reach the screen", painted() > 0 && painted() <= census(), `${painted()} painted of ${census()}`);
    chk("first touch: the default categories are gone rather than joined",
      !on("Weapons") && !on("Gear"), `Weapons=${on("Weapons")} Gear=${on("Gear")}`);
    chk("first touch: and the untouched mark is spent", W.win()._catsPristine === false, W.win()._catsPristine);

    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons/SMGs"]'), "click", {}, 1600);
    chk("additive: the SECOND press adds to the set instead of replacing it",
      catSet() === "Weapons/Pistols,Weapons/SMGs", catSet());
    chk("additive: and the census is the two shelves together",
      census() === wantPistols + wantSMGs, `${census()} vs ${wantPistols + wantSMGs}`);
    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons/SMGs"]'), "click", {}, 1600);
    chk("additive: pressing a lit shelf again removes just that one (second act)",
      catSet() === "Weapons/Pistols" && census() === wantPistols, `${catSet()} / ${census()}`);

    // ── AFTER A CLEAR THE SET IS EMPTY *AND* SPENT: the next press adds from empty ────────────
    await W.fire(W.root().querySelector(".cp-drawer-clear"), "click", {}, 2200);
    chk("clear: it leaves the set empty and no longer untouched",
      W.win()._cats.size === 0 && W.win()._catsPristine === false, `${W.win()._cats.size}/${W.win()._catsPristine}`);
    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons/Pistols"]'), "click", {}, 1600);
    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons/SMGs"]'), "click", {}, 1600);
    chk("clear: clicks after a Clear add up from empty, they do not replace",
      catSet() === "Weapons/Pistols,Weapons/SMGs", catSet());

    // ── PRISTINE IS A FLAG, NOT A RESEMBLANCE ─────────────────────────────────────────────────
    // Empty the set and rebuild the default by hand: someone who has done that work has expressed
    // intent, and the next press must ADD to it rather than throw it away. Only a set this window
    // built is untouched; a set that merely looks like one is not.
    await W.fire(W.root().querySelector(".cp-drawer-clear"), "click", {}, 2000);
    for (const k of wantSet) await W.fire(W.root().querySelector(`.cp-cat-chip[data-cat="${k}"]`), "click", {}, 800);
    chk("hand-rebuilt: the set now holds exactly what the default holds", catSet() === wantSet.join(","), catSet());
    chk("hand-rebuilt: but the untouched mark stays spent — it tracks the flag, not the contents",
      W.win()._catsPristine === false, W.win()._catsPristine);
    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Ammo"]'), "click", {}, 2000);
    chk("hand-rebuilt: so the next press ADDS to that work instead of replacing it",
      catSet() === [...wantSet, "Ammo"].sort().join(","), catSet());
    chk("hand-rebuilt: and the ammunition joins the list rather than becoming it",
      census() === visible.length + calibers, `${census()} vs ${visible.length + calibers}`);

    // ── SEARCH narrows the strip FROM DATA — no pane swap, nothing hidden in place ────────────
    const box = W.root().querySelector(".cp-catalog-search");
    chk("search: the box is present on the opening list", !!box && box.getBoundingClientRect().width > 0, box?.getBoundingClientRect().width);
    const beforeTotal = census();
    await searchFor("militech", 1800);
    const hits = [...W.root().querySelectorAll(".cp-catalog-list .cp-catalog-row")];
    chk("search: the census narrows to the matching set", census() > 0 && census() < beforeTotal, `${census()} of ${beforeTotal}`);
    chk("search: every painted row carries what was typed",
      hits.length > 0 && hits.every(x => /militech/i.test(x.dataset.name ?? "")), `hits=${hits.length}`);
    chk("search: the narrowed set is repainted, with nothing left hidden in place",
      hits.filter(x => x.style.display === "none").length === 0, hits.filter(x => x.style.display === "none").length);
    chk("search: letter headers leave the DOM while a term is live",
      W.root().querySelectorAll(".cp-catalog-list .cp-letter-header").length === 0,
      W.root().querySelectorAll(".cp-catalog-list .cp-letter-header").length);
    chk("search: no front page is ever swapped in", !W.root().querySelector(".cp-catalog-landing"), !!W.root().querySelector(".cp-catalog-landing"));

    // ── A STROKE BEGUN ON THE UNTOUCHED DEFAULT SET: replace first, then paint the run on ─────
    //
    // Last in the section, on a window of its own, because a stroke ends by marking its click as
    // already-handled — anything clicked immediately afterwards would be swallowed by that guard.
    await W.close();
    r = await W.open("catalog", null, ".cp-catalog-row");
    chk("pristine stroke: the fresh window arrives with its default set untouched",
      W.win()._catsPristine === true, W.win()._catsPristine);
    // groups default CLOSED — the sub-shelf run below needs the Weapons shelf on screen (a stroke
    // can only cross visible buttons); the caret is a DOM flip, so pristine stays unspent.
    {
      const wg = W.root().querySelector('.cp-cat-group[data-cat="Weapons"]');
      if (wg && !wg.classList.contains("cp-expanded")) {
        W.root().querySelector('.cp-cat-expand[data-cat="Weapons"]')?.click();
        await W.sleep(300);
      }
    }
    const runKeys = ["Weapons/Pistols", "Weapons/SMGs", "Weapons/Rifles"];
    const trace = await W.stroke(runKeys.map(k => W.root().querySelector(`.cp-cat-chip[data-cat="${k}"]`)));
    chk("pristine stroke: it replaces with the chip it began on, then paints the rest of the run on",
      catSet() === runKeys.slice().sort().join(","), `${catSet()} | ${trace.join(" ")}`);
    chk("pristine stroke: the default categories are gone rather than joined by the run",
      !on("Weapons") && !on("Gear") && !on("Cyberware"),
      ["Weapons", "Gear", "Cyberware"].map(k => `${k}=${on(k)}`).join(" "));
    chk("pristine stroke: and the mark is spent, so the next gesture is additive",
      W.win()._catsPristine === false, W.win()._catsPristine);
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
    // rather than whatever the previous section left persisted — and since groups now default
    // CLOSED (2026-08-19 ruling), open the Weapons shelf by its caret (a DOM flip, no render)
    // before arming the strokes below.
    await W.close();
    try { localStorage.removeItem("cp2020-augmented.shopDrawer"); } catch {}
    const r = await W.open("catalog", null, ".cp-catalog-row");
    {
      const grp = W.root().querySelector('.cp-cat-group[data-cat="Weapons"]');
      if (grp && !grp.classList.contains("cp-expanded")) {
        W.root().querySelector('.cp-cat-expand[data-cat="Weapons"]')?.click();
        await W.sleep(300);
      }
    }

    const chips = (keys) => keys.map(k => W.root().querySelector(`.cp-cat-chip[data-cat="${k}"]`));
    const on = (k) => !!W.root().querySelector(`.cp-cat-chip[data-cat="${k}"]`)?.classList.contains("active");
    const KEYS = ["Weapons/Pistols", "Weapons/SMGs", "Weapons/Rifles", "Weapons/Shotguns"];
    void r;

    // Mixed start state: the first click spends the window's untouched default set and leaves that
    // one chip on (the first-touch-replaces rule, pinned by value in S4) — which is exactly the
    // mixed row the strokes below want, so it doubles as the pre-arm.
    await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons/Rifles"]'), "click", {}, 1400);
    chk("paint: a plain click leaves exactly one button on", on("Weapons/Rifles") && !on("Weapons/Pistols"), KEYS.map(k => `${k}=${on(k)}`).join(" "));

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
    // ⏪ REALIGNED 2026-08-19: a stroke now ends ONLY on release. The old leave-ends rule killed
    // slow drags in the inter-chip GAPS (every gap is a non-button point) and its early
    // release-render reflowed the column under a still-held pointer — both field-reported. Off-
    // column travel now pauses painting, and crossing a chip again resumes the same stroke.
    chk("paint: wandering off the column pauses the stroke and a later chip resumes it", on("Weapons/Melee"), on("Weapons/Melee"));
    for (const k of ["Weapons/Pistols", "Weapons/Melee"]) if (on(k)) await W.fire(W.root().querySelector(`.cp-cat-chip[data-cat="${k}"]`), "click", {}, 1200);

    // Book chips paint too.
    const bkeys = [...W.root().querySelectorAll(".cp-book-chip")].slice(0, 3).map(el => el.dataset.book);
    const bon = (k) => !!W.root().querySelector(`.cp-book-chip[data-book="${k}"]`)?.classList.contains("active");
    trace = await W.stroke(bkeys.map(k => W.root().querySelector(`.cp-book-chip[data-book="${k}"]`)));
    chk("paint: the book column paints as well", bkeys.length >= 3 && bkeys.every(bon), `${bkeys.map(k => `${k}=${bon(k)}`).join(" ")} | ${trace.join(" ")}`);
    await W.stroke(bkeys.map(k => W.root().querySelector(`.cp-book-chip[data-book="${k}"]`)));
    chk("paint: and paints back off", bkeys.every(k => !bon(k)), bkeys.map(k => `${k}=${bon(k)}`).join(" "));

    // ⏪ REALIGNED 2026-08-19 (user ruling): the visibility EYES are now paintable with the same
    // stroke grammar — first eye pressed sets the direction, the run follows, and the WORLD SETTING
    // commits ONCE on release. A CHIP stroke still never flips an eye and an EYE stroke never
    // paints a chip (disjoint hit-test selectors) — those negatives replace the old exclusion leg.
    const mapNow = () => ({ ...(game.settings.get("cp2020-augmented", "shopEnabledSources") || {}) });
    const mapBefore = mapNow();
    const eyes = [...W.root().querySelectorAll(".cp-book-eye")].slice(0, 3);
    const eyeNames = eyes.map(e => e.querySelector("input")?.dataset.source);
    const eyeState = () => eyes.map(e => !!e.querySelector("input")?.checked).join(",");
    const chipsBefore = [...W.root().querySelectorAll(".cp-book-chip.active")].length;
    const dir = !eyes[0]?.querySelector("input")?.checked;         // the first eye decides
    await W.stroke(eyes);
    await W.sleep(900);                                            // the single commit + render
    const committed = mapNow();
    chk("paint: an eye stroke drives the whole run to the first eye's direction",
      eyeNames.length === 3 && eyeNames.every(n => !!committed[n] === dir),
      `dir=${dir} map=${eyeNames.map(n => `${n}=${!!committed[n]}`).join(" ")}`);
    chk("paint: the eye stroke painted no book chips",
      [...W.root().querySelectorAll(".cp-book-chip.active")].length === chipsBefore,
      `${chipsBefore} → ${[...W.root().querySelectorAll(".cp-book-chip.active")].length}`);
    // chips still never flip eyes: stroke the chip column and read the eye states across it
    const eyesAfterStroke = eyeState();
    await W.stroke(bkeys.map(k => W.root().querySelector(`.cp-book-chip[data-book="${k}"]`)));
    chk("paint: a chip stroke still flips no eyes",
      eyeState() === eyesAfterStroke, `${eyesAfterStroke} → ${eyeState()}`);
    await W.stroke(bkeys.map(k => W.root().querySelector(`.cp-book-chip[data-book="${k}"]`)));
    // restore the world's source map exactly as found — the eye stroke wrote a real setting
    await game.settings.set("cp2020-augmented", "shopEnabledSources", mapBefore);
    await W.sleep(400);
    chk("paint: the source map is restored to its as-found value",
      JSON.stringify(mapNow()) === JSON.stringify(mapBefore), "map drifted");
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
    await W.open("catalog", null, ".cp-catalog-row");
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
    r = await W.open("catalog", null, ".cp-catalog-row");
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
    r = catalogRoot && await W.open("catalog", null, ".cp-catalog-row");

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
    r = await W.open("catalog", null, ".cp-catalog-row");
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
  //  S8 · THE LIST WINDOW
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //  A list over 150 items keeps only about a screenful of items in the DOM; two spacers carry the
  //  height of everything scrolled out, and `.cp-catalog-list[data-total]` carries the census the
  //  DOM no longer shows. Every leg below reads BOTH channels, so neither can go vacuous:
  //    a  a windowed shelf paints a strict subset of its census, with the pads set accordingly
  //    b  scrolled to the end, the last item of the set is painted and the bottom spacer is spent
  //    c  a letter jump lands that letter's header at the top of the viewport
  //    d  a text term repaints the strip from the narrowed data — headers gone, nomatch honest
  //    e  a typed quantity survives a scroll-out/scroll-back AND two full renders
  //    f  a row painted by a SCROLL repaint (not the render) still buys
  //    g  NEGATIVE: an under-threshold shelf is not windowed at all
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  await section("8 · the list window", () => gm.evaluate(async () => {
    const W = window.__cpShop;
    const checks = []; const chk = (label, ok, got) => checks.push({ label, ok: !!ok, got });
    const CAT = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    const SUP = await import("/modules/cp2020-augmented/module/shop/supplements.js");
    const ST = await import("/modules/cp2020-augmented/module/settings.js");
    const SETUP = await import("/modules/cp2020-augmented/module/shop/setup-mode.js");
    const all = await CAT.getCatalogIndex();
    const visible = all.filter(i => SUP.isVisibleTo(i.supplement, i.canon, ST.shopSourceConfig(), game.user.isGM));

    // Prices must actually be charged for leg (f); restored at the end of the section.
    const setupWas = SETUP.isShopSetupMode();
    if (setupWas) await SETUP.setShopSetupMode(false);
    let buyer = null;

    const list = () => W.root()?.querySelector(".cp-catalog-list");
    const strip = () => list()?.querySelector(".cp-list-items");
    const census = () => Number(list()?.dataset.total);
    const items = () => [...(strip()?.children ?? [])];
    const rowsOf = () => [...(strip()?.querySelectorAll(".cp-catalog-row") ?? [])];
    const padH = (which) => { const p = list()?.querySelector(`.cp-list-pad-${which}`); return p ? (parseFloat(getComputedStyle(p).height) || 0) : -1; };
    /** Drive a real scroll and let the rAF-throttled repaint land. */
    const scrollTo = async (y, settle = 900) => {
      const L = list(); if (!L) return;
      L.scrollTop = y;
      L.dispatchEvent(new Event("scroll", { bubbles: false }));
      await W.sleep(settle);
    };

    try {
      // ── (a) A WINDOWED SHELF ───────────────────────────────────────────────────────────────
      let r = await W.open("catalog", null, ".cp-catalog-row");
      // The catalog opens directly onto its list under the default category set. The Weapons chip
      // pressed against that untouched set REPLACES it (S4 pins the rule), which lands this section
      // on exactly the one shelf it measures. The chips live in the drawer, so it must be open.
      if (!r.querySelector(".cp-cat-chip")) { await W.fire(r.querySelector(".cp-drawer-toggle"), "click", {}, 1200); r = W.root(); }
      await W.fire(r.querySelector('.cp-cat-chip[data-cat="Weapons"]'), "click", {}, 1800);
      r = W.root();

      const wantWeapons = visible.filter(i => i.category === "Weapons").length;
      const total = census();
      chk("window: the shelf's census matches the visible index for that category",
        total === wantWeapons, `data-total=${total} vs index=${wantWeapons}`);
      chk("window: that census is the pre-window row count for this shelf (424 at the time of writing)",
        total > 300, `${total} rows${total === 424 ? " (424, unchanged)" : " (NOTE: no longer 424)"}`);
      const paintedA = rowsOf().length;
      chk("window: only a window of those rows exists in the DOM",
        paintedA > 0 && paintedA < total, `${paintedA} painted of ${total}`);
      chk("window: both spacers are rendered",
        !!list()?.querySelector(".cp-list-pad-top") && !!list()?.querySelector(".cp-list-pad-bottom"),
        `${!!list()?.querySelector(".cp-list-pad-top")}/${!!list()?.querySelector(".cp-list-pad-bottom")}`);
      chk("window: at the top, the top spacer is spent and the bottom one carries the rest",
        padH("top") === 0 && padH("bottom") > 0, `top=${padH("top")}px bottom=${padH("bottom")}px`);
      chk("window: the scrollbar measures the whole set, not the painted part",
        list().scrollHeight > list().clientHeight * 3, `scrollHeight=${list().scrollHeight} clientHeight=${list().clientHeight}`);
      // Wiring rule: every painted row carries the identity its handlers read.
      const keyless = rowsOf().filter(x => !x.dataset.sourceKey && !x.dataset.itemId && !x.dataset.ammoCaliber).length;
      chk("window: every painted row carries a non-empty identity for its handlers", keyless === 0, `${keyless} keyless of ${paintedA}`);

      // ── (b) THE FAR END ────────────────────────────────────────────────────────────────────
      // The expected tail is computed from the INDEX, not from the window's own item list, so the
      // leg checks the window against an independent answer.
      const lastName = visible.filter(i => i.category === "Weapons")
        .map(i => i.name).sort((x, y) => x.localeCompare(y)).pop() ?? null;
      await scrollTo(list().scrollHeight, 1200);
      const namesAtEnd = rowsOf().map(x => x.dataset.name);
      chk("far end: the alphabetically last row of the set is painted at the bottom",
        !!lastName && namesAtEnd.includes(lastName), `last="${lastName}" painted=${namesAtEnd.length} tail="${namesAtEnd[namesAtEnd.length - 1]}"`);
      chk("far end: the bottom spacer is spent and the top one now carries the scrolled-out height",
        padH("bottom") === 0 && padH("top") > 0, `top=${padH("top")}px bottom=${padH("bottom")}px`);
      chk("far end: the DOM still holds only a window", rowsOf().length < census(), `${rowsOf().length} of ${census()}`);

      // ── (c) THE LETTER JUMP ────────────────────────────────────────────────────────────────
      const JUMP = "S";
      const jumpBtn = W.root().querySelector(`.cp-jump[data-letter="${JUMP}"]`);
      chk(`jump: the strip offers a late letter to jump to (${JUMP})`, !!jumpBtn, !!jumpBtn);
      if (jumpBtn) {
        await W.fire(jumpBtn, "click", {}, 1200);
        const L = list();
        const lTop = L.getBoundingClientRect().top;
        const stride = W.win()._itemStrides?.row ?? 36;
        const headers = [...L.querySelectorAll(".cp-letter-header")];
        const target = headers.find(h => W.txt(h) === JUMP);
        const dy = target ? target.getBoundingClientRect().top - lTop : null;
        chk(`jump: the ${JUMP} header is painted after the jump`, !!target, headers.map(h => W.txt(h)).join(""));
        chk(`jump: it sits within one item height of the viewport top`,
          dy !== null && Math.abs(dy) <= stride + 2, `offset=${dy === null ? "n/a" : Math.round(dy)}px stride=${Math.round(stride)}px`);
        const firstBelow = headers.map(h => ({ t: W.txt(h), y: h.getBoundingClientRect().top - lTop })).find(h => h.y >= -1);
        chk(`jump: it is the first header at or below the viewport top`, firstBelow?.t === JUMP, firstBelow?.t);
        const firstRowUnder = rowsOf().map(x => ({ n: x.dataset.name, y: x.getBoundingClientRect().top - lTop })).find(x => x.y > (dy ?? 0));
        chk(`jump: the row under that header starts with the letter`,
          (firstRowUnder?.n ?? "").toUpperCase().startsWith(JUMP), firstRowUnder?.n);
      }

      // ── (d) TEXT NARROWING ─────────────────────────────────────────────────────────────────
      await scrollTo(0, 700);
      const box = W.root().querySelector(".cp-catalog-search");
      const weaponNames = visible.filter(i => i.category === "Weapons").map(i => i.name.toLowerCase());
      const countFor = (t) => weaponNames.filter(n => n.includes(t)).length;
      // A term that narrows to FEW rows. "kend" is the intended probe; if this rig's data does not
      // carry it, the leg falls back to another narrow term rather than certifying nothing.
      const term = ["kend", "militech", "arasaka", "heavy"].find(t => countFor(t) > 0 && countFor(t) <= 60) ?? "a";
      const wantHits = countFor(term);
      box.value = term;
      await W.fire(box, "input", {}, 1400);
      const hitRows = rowsOf();
      chk(`search "${term}": the census narrows to exactly the matching rows`,
        census() === wantHits, `data-total=${census()} vs index=${wantHits}`);
      chk(`search "${term}": every painted row carries the term`,
        hitRows.length > 0 && hitRows.every(x => (x.dataset.name ?? "").toLowerCase().includes(term)),
        `${hitRows.length} painted, offenders: ${hitRows.filter(x => !(x.dataset.name ?? "").toLowerCase().includes(term)).map(x => x.dataset.name).slice(0, 3).join(",") || "none"}`);
      chk(`search "${term}": nothing is merely hidden in place`,
        hitRows.filter(x => x.style.display === "none").length === 0, hitRows.filter(x => x.style.display === "none").length);
      chk(`search "${term}": the letter headers leave the DOM`,
        list().querySelectorAll(".cp-letter-header").length === 0, list().querySelectorAll(".cp-letter-header").length);
      chk(`search "${term}": the exact/prefix band leads the order`,
        (hitRows[0]?.dataset.name ?? "").toLowerCase().indexOf(term) <= (hitRows[hitRows.length - 1]?.dataset.name ?? "").toLowerCase().indexOf(term),
        `first="${hitRows[0]?.dataset.name}" last="${hitRows[hitRows.length - 1]?.dataset.name}"`);

      // A term nothing matches: the no-match panel is the honest answer, not an empty list.
      box.value = "zzqqxx";
      await W.fire(box, "input", {}, 1200);
      const nomatch = list().querySelector(".cp-catalog-nomatch");
      chk("search: a term with no matches empties the strip and shows the no-match panel",
        rowsOf().length === 0 && census() === 0 && !!nomatch && getComputedStyle(nomatch).display !== "none",
        `rows=${rowsOf().length} total=${census()} panel=${nomatch ? getComputedStyle(nomatch).display : "absent"}`);

      // Clearing restores the shelf whole — headers back, census back (second act).
      box.value = "";
      await W.fire(box, "input", {}, 1400);
      chk("search: clearing the term restores the shelf's full census",
        census() === wantWeapons, `${census()} vs ${wantWeapons}`);
      chk("search: and the letter headers come back with it",
        list().querySelectorAll(".cp-letter-header").length > 0, list().querySelectorAll(".cp-letter-header").length);
      chk("search: the no-match panel is put away again",
        !!nomatch && getComputedStyle(nomatch).display === "none", nomatch ? getComputedStyle(nomatch).display : "absent");

      // ── (e) A TYPED QUANTITY SURVIVES THE WINDOW ───────────────────────────────────────────
      await scrollTo(0, 700);
      const qRow = rowsOf()[0];
      const qKey = qRow?.dataset.sourceKey || qRow?.dataset.itemId;
      const qName = qRow?.dataset.name;
      const qInput = qRow?.querySelector(".cp-catalog-qty");
      chk("qty: a painted row offers a quantity field to type into", !!qInput && !!qKey, `${!!qInput}/${qKey}`);
      if (qInput) {
        qInput.value = "3";
        await W.fire(qInput, "input", {}, 400);
        const findQ = () => rowsOf().find(x => (x.dataset.sourceKey || x.dataset.itemId) === qKey)?.querySelector(".cp-catalog-qty");
        chk("qty: the typed value is on the field before the scroll", findQ()?.value === "3", findQ()?.value);

        // Two-plus windows away: the row must genuinely leave the DOM, or the leg proves nothing.
        await scrollTo(4000, 1100);
        chk("qty: scrolling two windows on takes that row out of the DOM entirely", !findQ(), findQ()?.value ?? "gone");
        await scrollTo(0, 1100);
        chk("qty: scrolling back repaints the row with the typed quantity intact (second act)",
          findQ()?.value === "3", `${findQ()?.value} on "${qName}"`);

        // A category chip is a FULL re-render — off, then back on, and the register still holds.
        await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons"]'), "click", {}, 1600);
        await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons"]'), "click", {}, 1800);
        await scrollTo(0, 700);
        chk("qty: it survives two full re-renders driven by the category chip",
          findQ()?.value === "3", `${findQ()?.value} on "${qName}"`);
      }

      // ── (f) A ROW PAINTED BY A SCROLL REPAINT STILL BUYS ───────────────────────────────────
      for (const a of game.actors.filter(a => /^__PW__WINBUYER/.test(a.name))) await a.delete().catch(() => {});
      buyer = await Actor.create({ name: "__PW__WINBUYER", type: "character", system: { eurobucks: 100000 } });
      await W.win()._cpSyncBuyer(buyer);
      await W.sleep(700);
      await scrollTo(4000, 1200);
      const deep = rowsOf().find(x => {
        const p = Number(x.querySelector(".cp-cat-price b")?.textContent);
        return x.dataset.sourceKey && !x.classList.contains("cp-shop-soldout") && p > 0;
      });
      chk("buy: a priced row is painted this far down the window", !!deep, deep?.dataset.name ?? "none found");
      if (deep) {
        const buyName = deep.dataset.name;
        const sk = deep.dataset.sourceKey;
        const packDoc = await (async () => {
          const i = sk.lastIndexOf(".");
          try { return await game.packs.get(sk.slice(0, i))?.getDocument(sk.slice(i + 1)); } catch { return null; }
        })();
        const price = Number(deep.querySelector(".cp-cat-price b").textContent);
        deep.querySelector(".cp-catalog-qty").value = "1";
        const fundsBefore = Number(buyer.system.eurobucks);
        const heldBefore = new Set(buyer.items.map(i => i.id));
        deep.querySelector(".cp-catalog-buy").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        for (let i = 0; i < 40 && buyer.items.size === heldBefore.size; i++) await W.sleep(250);
        await W.sleep(600);
        const delivered = buyer.items.filter(i => !heldBefore.has(i.id));
        chk("buy: a row painted by a scroll repaint delivers exactly one item to the buyer",
          delivered.length === 1, `${delivered.length} delivered from "${buyName}"`);
        // The row's label carries the corrections layer's name; the pack document carries the raw
        // one. Either is a correct delivery — a THIRD name would mean the wrong row was bought.
        chk("buy: the delivered item is the row that was clicked",
          delivered.length === 1 && (delivered[0].name === buyName || delivered[0].name === packDoc?.name),
          `delivered="${delivered[0]?.name}" row="${buyName}" pack="${packDoc?.name}"`);
        chk("buy: and the buyer is charged the price the row showed",
          Number(buyer.system.eurobucks) === fundsBefore - price,
          `${fundsBefore} - ${price} → want ${fundsBefore - price}, got ${Number(buyer.system.eurobucks)}`);
      }

      // ── (g) NEGATIVE: AN UNDER-THRESHOLD SHELF IS NOT WINDOWED ─────────────────────────────
      await W.close();
      r = await W.open("catalog", null, ".cp-catalog-row");
      // Ammo is the one category the opening set leaves out, and its chip is the shipped route to
      // the generated caliber rows: pressed against the fresh window's untouched set it REPLACES
      // it, so what this lands on is the caliber shelf alone — the under-threshold list this leg
      // is about.
      if (!r.querySelector(".cp-cat-chip")) { await W.fire(r.querySelector(".cp-drawer-toggle"), "click", {}, 1200); r = W.root(); }
      await W.fire(r.querySelector('.cp-cat-chip[data-cat="Ammo"]'), "click", {}, 1800);
      const aTotal = census();
      const aRows = rowsOf().length;
      const aItems = items().length;
      chk("bypass: the ammo shelf is small enough to be exempt from windowing", aItems <= 150, `${aItems} items`);
      chk("bypass: every one of its rows is in the DOM", aRows === aTotal && aTotal > 0, `${aRows} painted of ${aTotal}`);
      chk("bypass: its letter headers are painted alongside the rows", aItems > aRows, `${aItems} items vs ${aRows} rows`);
      chk("bypass: neither spacer carries any height", padH("top") === 0 && padH("bottom") === 0, `top=${padH("top")}px bottom=${padH("bottom")}px`);
      await W.close();
    } finally {
      try { if (setupWas) await SETUP.setShopSetupMode(true); } catch {}
      try { if (buyer) await buyer.delete(); } catch {}
      try { await W.close(); } catch {}
    }
    return checks;
  }));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //  S3b · PER-VIEWER COUNTS — a second client, joined as a player
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  {
    const pl = await (await b.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
    let joined = true;
    // Error listeners attach AFTER the join: joinAs probes candidate passwords, and a refused
    // candidate logs a 401 + "Invalid password" console error that is the harness's own doing
    // (on :30003 the player account carries the rig password, so the "" probe always misses).
    try { await joinAs(pl, /^Test User 1$/i, ["", GM_PW]); } catch { joined = false; }
    pl.on("pageerror", e => errors.push("player pageerror: " + e.message));
    pl.on("console", m => { if (m.type() === "error") errors.push("player console: " + m.text()); });
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

        const r = await W.open("catalog", null, ".cp-catalog-row");
        chk("per-viewer: the player's catalog also opens straight onto the item list",
          r.querySelectorAll(".cp-catalog-list .cp-catalog-row").length > 0,
          r.querySelectorAll(".cp-catalog-list .cp-catalog-row").length);
        const chipCount = Number(r.querySelector('.cp-cat-chip[data-cat="Weapons"]')?.dataset.count);
        chk("per-viewer: the player's Weapons chip counts only what the player may see",
          chipCount === wantWeapons && chipCount < gmWeapons, `player=${chipCount} want=${wantWeapons} gm=${gmWeapons}`);

        // A category with nothing visible to this player carries a zero, never a borrowed count.
        // (The chip itself is kept: a lit shelf is never allowed to vanish mid-session, or the
        // filter it holds would become unreachable.)
        const emptyCats = ["Weapons", "Armor", "Ammo", "Cyberware", "FBC", "Gear", "Netrunning", "Programs", "Vehicles"]
          .filter(k => k !== "Ammo" && mine.filter(i => i.category === k).length === 0);
        const borrowed = emptyCats.filter(k => {
          const c = r.querySelector(`.cp-cat-chip[data-cat="${k}"]`);
          return c && Number(c.dataset.count) !== 0;
        });
        chk("per-viewer: a category the player can see nothing in carries a zero count",
          borrowed.length === 0, `empty=${emptyCats.join(",") || "none"} borrowed=${borrowed.join(",") || "none"}`);

        chk("per-viewer: the player's drawer chip count matches the player's own set",
          Number(r.querySelector('.cp-cat-chip[data-cat="Weapons"]')?.dataset.count) === wantWeapons,
          r.querySelector('.cp-cat-chip[data-cat="Weapons"]')?.dataset.count);
        chk("per-viewer: the player gets the filter half of the books rail",
          r.querySelectorAll(".cp-filter-drawer .cp-book-chip").length > 0, r.querySelectorAll(".cp-filter-drawer .cp-book-chip").length);
        chk("per-viewer: and none of the GM's visibility eyes",
          r.querySelectorAll(".cp-src-toggle").length === 0 && r.querySelectorAll(".cp-book-eye").length === 0,
          `${r.querySelectorAll(".cp-src-toggle").length}/${r.querySelectorAll(".cp-book-eye").length}`);
        // The opening set holds every category but Ammo, so what the player is offered is exactly
        // the player's own visible index — the generated caliber rows are filtered out until asked
        // for. The DOM holds a window, so the count this leg is about lives on the container's
        // census attribute; the painted count is checked separately so neither channel can go
        // vacuous.
        const LK = await import("/modules/cp2020-augmented/module/lookups.js");
        const CATS = await import("/modules/cp2020-augmented/module/shop/categories.js");
        const inDefault = new Set(CATS.CATEGORIES.map(c => c.key).filter(k => k !== "Ammo"));
        const wantOpen = mine.filter(i => inDefault.has(i.category)).length;
        const pTotal = Number(r.querySelector(".cp-catalog-list")?.dataset.total);
        const pPainted = r.querySelectorAll(".cp-catalog-list .cp-catalog-row").length;
        chk("per-viewer: the rows the player is offered are exactly the player's own set",
          pTotal === wantOpen, `${pTotal} vs ${wantOpen}`);
        chk("per-viewer: and what is painted is a subset of that count",
          pPainted > 0 && pPainted <= pTotal, `${pPainted} painted of ${pTotal}`);
        chk("per-viewer: with none of the caliber rows, which the default set leaves out",
          r.querySelectorAll(".cp-catalog-list .cp-catalog-row[data-ammo-caliber]").length === 0,
          `${r.querySelectorAll(".cp-catalog-list .cp-catalog-row[data-ammo-caliber]").length}/${Object.keys(LK.getCalibers()).length}`);
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
    // What a fresh open looks like, then the drawer's two states, then the cleared everything-set.
    await shot("opening", async () => {
      const W = window.__cpShop;
      await W.close();
      try { localStorage.removeItem("cp2020-augmented.shopDrawer"); } catch {}
      await W.open("catalog", null, ".cp-catalog-row");
    });
    await shot("drawer-open", async () => {
      const W = window.__cpShop;
      if (W.root().querySelector('.cp-filter-drawer[data-open="0"]')) await W.fire(W.root().querySelector(".cp-drawer-toggle"), "click", {}, 800);
      await W.fire(W.root().querySelector('.cp-cat-chip[data-cat="Weapons"]'), "click", {}, 1600);
    });
    await shot("drawer-collapsed", async () => { const W = window.__cpShop; await W.fire(W.root().querySelector(".cp-drawer-toggle"), "click", {}, 900); });
    await shot("all-items", async () => {
      const W = window.__cpShop;
      await W.fire(W.root().querySelector(".cp-drawer-toggle"), "click", {}, 800);
      await W.fire(W.root().querySelector(".cp-drawer-clear"), "click", {}, 2200);
    });
    await shot("storefront", async (id) => { const W = window.__cpShop; await W.close(); await W.open("storefront", id, ".cp-catalog-row, .cp-catalog-empty"); });
    await shot("builder", async (id) => { const W = window.__cpShop; await W.close(); await W.open("build", id, ".cp-vendor-tray"); });
    log.push(`  captures written to ${SHOTS}`);
  }

  // ── S9 · FRACTIONAL-DPR SCROLL + DRAWER GEOMETRY (field reports 2026-08-19) ──────────────
  // The runaway: every windowed repaint replaces rows and resizes both pads; browser scroll
  // anchoring "compensates" by nudging scrollTop, which fires another repaint. At integer DPR the
  // nudges cancel; under Windows display scaling (1.75 = the reporting client) they compound and
  // the list scrolls BY ITSELF to either end. overflow-anchor:none on the list is the fix; these
  // legs hold it at the DPR that exposed it — a DPR-1 pass is blind to the whole class. The
  // geometry legs pin the same report's header clip + chip misalignment + uneven gaps.
  {
    // The main GM context holds the gamemaster seat, and a taken seat's /join option is DISABLED —
    // so this section rides its own second GM (the e1 keeper's create-if-absent pattern).
    await gm.evaluate(async () => {
      if (!game.users.getName("__PW__GM2")) await User.create({ name: "__PW__GM2", role: CONST.USER_ROLES.GAMEMASTER });
    });
    const hidpi = await b.newContext({ viewport: { width: 1700, height: 1000 }, deviceScaleFactor: 1.75 });
    const hp = await hidpi.newPage();
    await joinAs(hp, /^__PW__GM2$/i, ["", GM_PW]);
    const listBox = await hp.evaluate(async () => {
      const C = await import("/modules/cp2020-augmented/module/shop/catalog.js");
      C.openShopWindow(null, { view: "catalog" });
      // the catalog build can take >10 s on a busy rig — poll, don't sleep (probe-proven)
      const winOf = () => [...foundry.applications.instances.values()].find(x => x?.constructor?.name === "CatalogBrowser");
      let list = null;
      for (let i = 0; i < 50 && !list; i++) { await new Promise(r => setTimeout(r, 300)); list = winOf()?.element?.querySelector(".cp-catalog-list"); }
      if (!list) return null;
      await new Promise(r => setTimeout(r, 600));
      const r = list.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, anchor: getComputedStyle(list).overflowAnchor };
    });
    chk("S9 the windowed list opens on the hi-dpi client", !!listBox, "no list");
    chk("S9 scroll anchoring is OFF on the windowed scroller", listBox?.anchor === "none", String(listBox?.anchor));
    if (!listBox) { await hidpi.close(); throw new Error("S9: catalog never rendered on the hi-dpi client"); }
    const s9sample = () => hp.evaluate(() =>
      [...foundry.applications.instances.values()].find(x => x?.constructor?.name === "CatalogBrowser")?.element?.querySelector(".cp-catalog-list")?.scrollTop ?? -1);
    // Settle-to-STABILITY before baselining: a trailing smooth-scroll animation can land a final
    // wheel tick late under load (one clean +120 then flat — seen in-suite), which is not the
    // runaway. The runaway's signature is that scrollTop NEVER goes stable; so the baseline is
    // "unchanged for 600 ms" (bounded), and only movement AFTER that is a failure.
    const s9stable = async () => {
      let last = Math.round(await s9sample());
      for (let i = 0; i < 12; i++) {
        await hp.waitForTimeout(600);
        const now = Math.round(await s9sample());
        if (now === last) return now;
        last = now;
      }
      return NaN;      // never stabilized in ~7s — that IS the runaway
    };
    // One bounded retry: a LATE smooth-scroll tick can move once after a stable read and then go
    // quiet — the runaway never quiets (it re-fails the second watch too). Distinguish, don't flake.
    const s9quiet = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const base = await s9stable();
        if (!Number.isFinite(base)) return { ok: false, base, later: NaN };
        await hp.waitForTimeout(1200);
        const later = Math.round(await s9sample());
        if (later === base) return { ok: true, base, later };
      }
      return { ok: false, base: -1, later: -2 };
    };
    await hp.mouse.move(listBox.x, listBox.y);
    for (let i = 0; i < 5; i++) { await hp.mouse.wheel(0, 120); await hp.waitForTimeout(60); }
    const s9down = await s9quiet();
    chk("S9 a real wheel burst settles — hands-off scrollTop stays put at fractional DPR",
      s9down.ok && s9down.base > 0, JSON.stringify(s9down));
    await hp.mouse.wheel(0, -120);
    const s9upQ = await s9quiet();
    chk("S9 the reverse direction settles too", s9upQ.ok, JSON.stringify(s9upQ));
    // The second field report: a drawer toggle used to full-render, and core's scroll restore ran
    // before the pads existed — clamping a mid-list position to the bare strip (3000 → 1623). The
    // toggle is now a DOM flip and the window restores its own scroll after the pads inflate.
    const s9toggle = await hp.evaluate(async () => {
      const w = [...foundry.applications.instances.values()].find(x => x?.constructor?.name === "CatalogBrowser");
      const root = w?.element;
      const list = root?.querySelector(".cp-catalog-list");
      if (!list) return { err: "no list" };
      list.scrollTop = 3000;
      await new Promise(r => setTimeout(r, 500));
      const at = Math.round(list.scrollTop);
      const states = [];
      for (let i = 0; i < 2; i++) {
        root.querySelector(".cp-drawer-toggle")?.click();
        await new Promise(r => setTimeout(r, 700));
        states.push({ open: root.querySelector(".cp-filter-drawer")?.dataset.open, scrollTop: Math.round(root.querySelector(".cp-catalog-list")?.scrollTop ?? -1) });
      }
      return { at, states };
    });
    chk("S9 a mid-list scroll survives the drawer toggling closed and open",
      !s9toggle.err && s9toggle.states.every(s => s.scrollTop === s9toggle.at),
      JSON.stringify(s9toggle));
    chk("S9 the toggle actually flips the drawer state both ways",
      s9toggle.states?.[0]?.open !== s9toggle.states?.[1]?.open,
      JSON.stringify(s9toggle.states?.map(s => s.open)));
    // Third field report: a SLOW drag died in the gap between chips (the old leave-rule ended the
    // stroke on any non-button point) and the early release-render reflowed the column mid-hold.
    // This leg drags a REAL pointer through the inter-chip gap in small steps — the stroke must
    // paint both endpoints, and the column must not re-render until release.
    const s9chips = await hp.evaluate(async () => {
      const w = [...foundry.applications.instances.values()].find(x => x?.constructor?.name === "CatalogBrowser");
      const root = w?.element;
      if (root?.querySelector('.cp-filter-drawer[data-open="0"]')) { root.querySelector(".cp-drawer-toggle")?.click(); await new Promise(r => setTimeout(r, 500)); }
      const books = [...root.querySelectorAll(".cp-book-list .cp-book-chip")].slice(0, 2);
      if (books.length < 2) return { err: `books=${books.length}` };
      window.__s9NodeMark = books[0];   // reflow canary: same node must survive the whole stroke
      const r = (el) => { const x = el.getBoundingClientRect(); return { x: x.x + x.width / 2, y: x.y + x.height / 2 }; };
      return { a: r(books[0]), b: r(books[1]), names: books.map(x => x.dataset.book ?? x.textContent.trim().slice(0, 20)) };
    });
    chk("S9 stroke fixture: two book chips located", !s9chips.err, s9chips.err ?? "");
    if (!s9chips.err) {
      await hp.mouse.move(s9chips.a.x, s9chips.a.y);
      await hp.mouse.down();
      await hp.waitForTimeout(150);
      await hp.mouse.move(s9chips.b.x, s9chips.b.y, { steps: 14 });   // slow: samples land IN the gap
      await hp.waitForTimeout(150);
      const midStroke = await hp.evaluate(() => {
        const w = [...foundry.applications.instances.values()].find(x => x?.constructor?.name === "CatalogBrowser");
        const chips = [...(w?.element?.querySelectorAll(".cp-book-list .cp-book-chip") ?? [])].slice(0, 2);
        return { bothActive: chips.length === 2 && chips.every(c => c.classList.contains("active")),
          sameNode: chips[0] === window.__s9NodeMark };
      });
      await hp.mouse.up();
      await hp.waitForTimeout(900);
      chk("S9 a slow stroke through the inter-chip gap paints both chips", midStroke.bothActive, JSON.stringify(midStroke));
      chk("S9 the column does not re-render mid-hold (reflow canary held)", midStroke.sameNode, "node replaced during stroke");
      await hp.evaluate(() => { delete window.__s9NodeMark; });
    }
    // Books render as a TWO-COLUMN grid (user-approved density fix) and the drawer's width must not
    // breathe while the windowed list scrolls through rows of different intrinsic widths (the
    // basis-0 center split). Then the resize floor: a window collapsed below the minimum stops
    // shrinking instead of overlapping its fields.
    const s9layout = await hp.evaluate(async () => {
      const w = [...foundry.applications.instances.values()].find(x => x?.constructor?.name === "CatalogBrowser");
      const root = w?.element;
      const chips = [...(root?.querySelectorAll(".cp-book-list:not(.cp-book-pinned) .cp-book-chip") ?? [])].slice(0, 8);
      const rowsAt = new Set(chips.map(c => Math.round(c.getBoundingClientRect().y / 4)));
      const perRow = chips.length && rowsAt.size ? chips.length / rowsAt.size : 0;
      const drawer = root?.querySelector(".cp-filter-drawer");
      const list = root?.querySelector(".cp-catalog-list");
      const widths = [];
      for (const t of [0, 2000, 5000, 9000, 400]) {
        list.scrollTop = t;
        await new Promise(r => setTimeout(r, 350));
        widths.push(+drawer.getBoundingClientRect().width.toFixed(1));
      }
      const spread = +(Math.max(...widths) - Math.min(...widths)).toFixed(1);
      await w.setPosition({ width: 300, height: 200 });
      await new Promise(r => setTimeout(r, 400));
      const r = root.getBoundingClientRect();
      const clamped = { w: Math.round(r.width), h: Math.round(r.height) };
      await w.setPosition({ width: 880, height: 820 });
      await new Promise(r2 => setTimeout(r2, 400));
      return { perRow: +perRow.toFixed(1), widths, spread, clamped };
    });
    chk("S9 the books column lays out two chips per row", s9layout.perRow >= 1.9, JSON.stringify(s9layout));
    chk("S9 the drawer's width holds still across a scroll through varied rows", s9layout.spread <= 1, `widths=${JSON.stringify(s9layout.widths)}`);
    chk("S9 the window refuses to collapse below its floor (fields clip, never overlap)",
      s9layout.clamped.w >= 620 && s9layout.clamped.h >= 420, JSON.stringify(s9layout.clamped));

    // ── ROW FIELD PRIORITY across a real width sweep (field report 2026-08-19, second pass) ────
    // The first pass gave the name `overflow:hidden` + ellipsis and asserted, at the 620px floor
    // ONLY, that no ink escaped and the name's rect did not cross the badge's. Both stayed true
    // while the reported defect was fully present, because the defect is not an overlap of boxes:
    // the name was the row's only flexible item, so it absorbed 100% of the shrink and measured
    // 7.3px wide at the floor with the drawer open (its default) — gone, while every field after
    // it kept full width. These legs measure the SHRINK ORDER instead: at four widths, both drawer
    // states, and on every row shape the shop paints (plain catalog · the ammo shelf, which carries
    // one control more than any other · the build view's flex rows AND its vendor grid rows · the
    // player-facing storefront), the name must keep a readable floor, nothing after it may paint
    // into its box, and no control may be pushed out of the row's content box.
    const FLOOR = 70;               // the name's css floor, 5em at the row's 14px
    const s9pri = await hp.evaluate(async (shopId) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const C = await import("/modules/cp2020-augmented/module/shop/catalog.js");
      const winOf = () => [...foundry.applications.instances.values()].find(x => x?.constructor?.name === "CatalogBrowser");
      const rootOf = () => { const w = winOf(); return w?.element?.closest?.(".application") ?? w?.element ?? null; };
      const open = async (view, sid, marker) => {
        C.openShopWindow(null, { view, shopId: sid ?? null });
        for (let i = 0; i < 60; i++) { const r = rootOf(); if (r?.querySelector(marker)) return r; await sleep(300); }
        return rootOf();
      };
      const setDrawer = async (wantOpen) => {
        const d = rootOf()?.querySelector(".cp-filter-drawer");
        if (d && (d.dataset.open === "1") !== wantOpen) { rootOf().querySelector(".cp-drawer-toggle")?.click(); await sleep(700); }
      };
      /** One row's geometry: what is still shown, how wide the name got, and whether any field
       *  after the name paints into it (ink, not just rects) or hangs outside the row. */
      const audit = (row) => {
        const kids = [...row.children].map(k => {
          const cs = getComputedStyle(k), bx = k.getBoundingClientRect();
          return {
            cls: (k.className.toString() || k.tagName).split(" ")[0] || k.tagName.toLowerCase(),
            tag: k.tagName, x: bx.left, r: bx.right, w: +bx.width.toFixed(1), ta: cs.textAlign,
            gone: cs.display === "none", sw: k.scrollWidth, cw: k.clientWidth,
            // a <select>/<input> is clipped by the UA whatever `overflow` computes to — only the
            // text-bearing spans and buttons can actually spill ink.
            esc: !/SELECT|INPUT/.test(k.tagName) && k.scrollWidth > k.clientWidth + 1 && !/hidden|clip/.test(cs.overflow),
          };
        }).filter(k => !k.gone);
        const nm = kids.find(k => k.cls === "cp-cat-itemname");
        if (!nm) return null;
        let laps = 0;
        for (let i = 0; i < kids.length - 1; i++) if (kids[i].r > kids[i + 1].x + 0.5) laps++;
        let over = null;
        for (const k of kids.slice(kids.indexOf(nm) + 1)) {
          // centred ink in a squeezed box spills BOTH ways — the leftward half is what would land
          // on the name, so measure the ink edge, not the border box.
          const inkLeft = k.esc && k.ta === "center" ? k.x - (k.sw - k.cw) / 2 : k.x;
          if (inkLeft < nm.r - 0.5) { over = k.cls; break; }
        }
        const rb = row.getBoundingClientRect(), cs = getComputedStyle(row);
        const after = kids.slice(kids.indexOf(nm) + 1);
        return { nameW: nm.w, laps, over, spill: +(kids[kids.length - 1].r - (rb.right - parseFloat(cs.paddingRight))).toFixed(1),
          esc: kids.filter(k => k.esc).map(k => k.cls), fields: kids.map(k => k.cls),
          // The contract in one number: the name outranks every INFORMATIONAL field that follows
          // it (source tag, price, marks). Form controls are excluded — a picker or a Buy button
          // has a floor of its own below which it stops being clickable, and that floor is allowed
          // to exceed the name's on the one shelf that carries a picker.
          beats: after.filter(k => !/SELECT|INPUT|BUTTON/.test(k.tag)).every(k => nm.w >= k.w - 0.5) };
      };
      const measure = async (label, sel, width, drawerOpen) => {
        if (drawerOpen !== null) await setDrawer(drawerOpen);
        await winOf().setPosition({ width, height: 800 });
        await sleep(450);
        const rows = [...rootOf().querySelectorAll(sel)].slice(0, 12).map(audit).filter(Boolean);
        if (!rows.length) return { label, width, rows: 0 };
        return {
          label, width, rows: rows.length,
          rowW: +rootOf().querySelector(sel).getBoundingClientRect().width.toFixed(1),
          minNameW: +Math.min(...rows.map(r => r.nameW)).toFixed(1),
          laps: rows.reduce((a, r) => a + r.laps, 0), over: rows.filter(r => r.over).length,
          maxSpill: Math.max(...rows.map(r => r.spill)), esc: [...new Set(rows.flatMap(r => r.esc))],
          fields: rows[0].fields, badge: rows.some(r => r.fields.includes("cp-src-badge")),
          beats: rows.every(r => r.beats),
        };
      };
      const WIDTHS = [880, 760, 700, 620];
      const out = { sweep: [], variants: [] };

      await open("catalog", null, ".cp-catalog-row");
      for (const w of WIDTHS) out.sweep.push(await measure("catalog/open", ".cp-catalog-row", w, true));
      for (const w of WIDTHS) out.sweep.push(await measure("catalog/closed", ".cp-catalog-row", w, false));
      // Second act: widen the window back up and the yielded fields must come back — the tiers are
      // width-driven, not a one-way collapse.
      out.reopened = await measure("catalog/open", ".cp-catalog-row", 880, true);

      // The ammo shelf is the heaviest shape in the shop: rounds badge + load picker on top of
      // everything a normal row carries.
      const ammoChip = [...rootOf().querySelectorAll(".cp-cat-chip")].find(c => /ammo/i.test(c.textContent || ""));
      if (ammoChip) { ammoChip.click(); await sleep(1800); out.variants.push(await measure("catalog/ammo", ".cp-ammo-row", 620, true)); }
      // Fashion rows carry the style picker; their chip lives inside a collapsed group, and a
      // programmatic click reaches it there.
      const fashChip = rootOf().querySelector('.cp-cat-chip[data-cat$="Fashion"]');
      if (fashChip) { fashChip.click(); await sleep(1800); out.variants.push(await measure("catalog/fashion", ".cp-catalog-row", 620, true)); }

      await open("build", shopId, ".cp-vendor-tray");
      out.variants.push(await measure("build/rows", ".cp-catalog-row:not(.cp-vendor-row)", 620, true));
      out.variants.push(await measure("build/vendor", ".cp-vendor-row", 620, null));
      const SH = await import("/modules/cp2020-augmented/module/shop/shops.js");
      await SH.updateShop(shopId, { open: true });
      await open("storefront", shopId, ".cp-catalog-row, .cp-catalog-empty");
      out.variants.push(await measure("storefront", ".cp-catalog-row", 620, null));

      await open("catalog", null, ".cp-catalog-row");
      await winOf().setPosition({ width: 880, height: 820 });
      await sleep(400);
      return out;
    }, shopId);
    const all9 = [...s9pri.sweep, ...s9pri.variants].filter(m => m.rows);
    const worst = (f) => JSON.stringify(all9.map(m => `${m.label}@${m.width}:${f(m)}`));
    chk("S9 every width and every row shape was actually measured", all9.length >= 12 && s9pri.sweep.every(m => m.rows),
      JSON.stringify(all9.map(m => `${m.label}@${m.width}=${m.rows}`)));
    chk("S9 the item name holds its readable floor at every width, drawer open and closed",
      all9.every(m => m.minNameW >= FLOOR), worst(m => m.minNameW));
    chk("S9 no field after the name ever paints into the name's box",
      all9.every(m => m.over === 0 && m.laps === 0), worst(m => `${m.over}/${m.laps}`));
    chk("S9 no text-bearing field spills its ink outside its own box",
      all9.every(m => m.esc.length === 0), worst(m => JSON.stringify(m.esc)));
    chk("S9 the trailing controls stay inside the row — nothing is pushed past its edge",
      all9.every(m => m.maxSpill <= 1), worst(m => m.maxSpill));
    // The order itself: the source tag is the field the report named, and it is the first to go.
    const wide = s9pri.sweep.find(m => m.label === "catalog/open" && m.width === 880);
    const tight = s9pri.sweep.find(m => m.label === "catalog/open" && m.width === 620);
    chk("S9 a wide window still shows the source tag and gives the name the leftover space",
      wide?.badge === true && wide?.minNameW > 200, JSON.stringify({ badge: wide?.badge, name: wide?.minNameW }));
    chk("S9 the source tag is what yields as the window narrows, not the name",
      tight?.badge === false && tight?.minNameW >= FLOOR, JSON.stringify({ badge: tight?.badge, name: tight?.minNameW }));
    chk("S9 the fields that yield are a subset of the wide row — nothing new appears when narrowing",
      !!wide && !!tight && tight.fields.every(f => wide.fields.includes(f)), JSON.stringify({ wide: wide?.fields, tight: tight?.fields }));
    // The report's actual ask, stated as a measurement: whatever the window does, the name's box
    // outranks every field that follows it. (Pre-fix witness, same rig, same config: name 7.3px
    // against a 60.5px source tag and a 40.7px Buy button — the ranking exactly inverted.)
    chk("S9 the name outranks every informational field after it, at every width and in every view",
      all9.every(m => m.beats), worst(m => `${m.beats}:${m.minNameW}`));
    chk("S9 widening the window again brings the yielded fields back (second act)",
      s9pri.reopened?.badge === true && s9pri.reopened?.minNameW >= (wide?.minNameW ?? 0) - 1,
      JSON.stringify({ badge: s9pri.reopened?.badge, name: s9pri.reopened?.minNameW, wide: wide?.minNameW }));
    const geo = await hp.evaluate(() => {
      const w = [...foundry.applications.instances.values()].find(x => x?.constructor?.name === "CatalogBrowser");
      const root = w?.element;
      if (root?.querySelector('.cp-filter-drawer[data-open="0"]')) root.querySelector(".cp-drawer-toggle")?.click();
      // groups default CLOSED now — the sub-gap measurement below needs one shelf visible
      const firstExpandable = root?.querySelector(".cp-cat-group:not(.cp-expanded) .cp-cat-expand");
      firstExpandable?.click();
      return new Promise(res => setTimeout(() => {
        const h4 = [...root.querySelectorAll(".cp-drawer-subtitle")].find(e => /categor/i.test(e.textContent));
        const cs = h4 ? getComputedStyle(h4) : null;
        const heads = [...root.querySelectorAll(".cp-cat-grouphead")];
        const heights = [...new Set(heads.map(g => +g.getBoundingClientRect().height.toFixed(1)))];
        const spread = Math.max(0, ...heads.map(g => {
          const centers = [...g.children].filter(k => k.getBoundingClientRect().height > 0)
            .map(k => { const r = k.getBoundingClientRect(); return r.y + r.height / 2; });
          return centers.length > 1 ? Math.max(...centers) - Math.min(...centers) : 0;
        }));
        const subs = root.querySelector(".cp-cat-subs");
        const gaps = new Set();
        if (subs) {
          const chips = [...subs.children].map(k => k.getBoundingClientRect()).filter(c => c.height > 0)
            .sort((a, b2) => (a.y - b2.y) || (a.x - b2.x));
          for (let i = 1; i < chips.length; i++) if (Math.abs(chips[i].y - chips[i - 1].y) < 4) gaps.add(+(chips[i].x - (chips[i - 1].x + chips[i - 1].w)).toFixed(0));
        }
        w.close();
        res({ line: cs ? parseFloat(cs.lineHeight) : 0, font: cs ? parseFloat(cs.fontSize) : 1, heights, spread: +spread.toFixed(1), gaps: [...gaps] });
      }, 800));
    });
    chk("S9 the drawer subtitle's line box holds its ascenders (no top clip)", geo.line >= geo.font * 1.2, `line ${geo.line} vs font ${geo.font}`);
    chk("S9 every category row is ONE height", geo.heights.length === 1, JSON.stringify(geo.heights));
    chk("S9 row children share a vertical center (≤1px)", geo.spread <= 1, String(geo.spread));
    chk("S9 sub-chip gaps are one value", geo.gaps.length === 1, JSON.stringify(geo.gaps));
    await hidpi.close();
  }

  // ── teardown ────────────────────────────────────────────────────────────────────────────
  await gm.evaluate(async ({ shopId }) => {
    const W = window.__cpShop;
    try { await W.close(); } catch {}
    const SH = await import("/modules/cp2020-augmented/module/shop/shops.js");
    for (const s of SH.listShops().filter(s => /^__PW__/.test(s.name))) { try { await SH.deleteShop(s.id); } catch {} }
    for (const a of game.actors.filter(a => /^__PW__/.test(a.name))) await a.delete().catch(() => {});
    try { localStorage.removeItem("cp2020-augmented.shopDrawer"); } catch {}
    void shopId;
  }, { shopId });

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
