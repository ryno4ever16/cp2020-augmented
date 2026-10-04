/**
 * KEEPER: an item with no price, stocked in a published shop without a shop price of its own
 * (:30004, official 1.1.1 + module; two real sessions, GM + a player).
 *
 * Before 2026-10-04 `effectivePrice` (module/shop/shops.js) read such an entry as 0eb, so the
 * storefront showed "eb" with no figure and a buy delivered the item for nothing. The contract now:
 *
 *   §1  effectivePrice values: shop price wins (with or without a catalog price); no shop price
 *       falls back to the resolved catalog price with the shop discount; no price at all = null
 *   §2  storefront row (player client) and the GM's vendor tray: "GM-priced" marker, no "eb" figure;
 *       a priced control row in the same shop still shows its figure
 *   §3  player Buy (real click, qty 2) on the unpriced row: a needsPrice request card carrying the
 *       shop id + source key reaches the GM; funds, items and stock unchanged until approval
 *   §4  GM Approve with a typed price (real click): item delivered, funds − price × 2, stock 5 → 3,
 *       override saved
 *   §5  second act: with that saved override the storefront row shows the override × discount and a
 *       buy charges it directly (no request), stock 3 → 2
 *   §6  Deny: nothing delivered, nothing charged, stock unchanged
 *   §7  unlimited entry: approval delivers, the entry stays unlimited with qty untouched
 *   §8  shop price set on the unpriced item: charged that price directly, no request
 *   §9  GM setup mode: free, no request, no stock change; setup mode OFF: request, nothing delivered
 *   §10 storefront quantity box: starts at 1 with max = stock (no max when unlimited); an unedited Buy
 *       buys ONE; a typed quantity survives a re-render; the GM's tray still shows the stock count
 *   §11 a deliberate shop price of 0 reads "0eb" (storefront + tray) and buys free without a request
 *   §12 open catalog windows on BOTH clients follow an approved price (no reopen), and go back to
 *       "GM-priced" when the override is cleared
 *   §13 0 console errors on both sessions
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";
const START_FUNDS = 5000;
const UNP_PACK = "cp2020-augmented.supplement-armor", UNP_ID = "QIwkOGgOYsByn1gA";
const UNP_KEY = `${UNP_PACK}.${UNP_ID}`;

let pass = 0, fail = 0;
const failed = [];
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d !== "" ? ` — ${d}` : ""}`);
  if (ok) pass++; else { fail++; failed.push(n); }
};

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

/** Open a shop window on `page` at `view` and wait until the row for `sourceKey` is painted (or time out).
 *  Returns what the row's price cell shows. `cell` = the selector of the price cell inside the row. */
async function readRow(page, { buyerId, shopId, view, sourceKey, cell, rowSel }) {
  return page.evaluate(async ({ SCOPE, buyerId, shopId, view, sourceKey, cell, rowSel }) => {
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    for (const w of [...foundry.applications.instances.values()].filter(w => w instanceof C.CatalogBrowser)) await w.close().catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    const win = C.openShopWindow(game.actors.get(buyerId), { view, shopId });
    const sel = `${rowSel}[data-source-key="${sourceKey}"]`;
    const t0 = Date.now();
    let row = null;
    while (Date.now() - t0 < 10000) {
      row = win?.element?.querySelector(sel);
      if (row) break;
      await new Promise(r => setTimeout(r, 150));
    }
    if (!row) return { found: false };
    const c = row.querySelector(cell);
    return {
      found: true,
      text: (c?.textContent ?? "").replace(/\s+/g, " ").trim(),
      gmMarker: !!c?.querySelector(".cp-price-gm"),
      figure: c?.querySelector("b")?.textContent?.trim() ?? null,
      curated: row.dataset.curated ?? null,
    };
  }, { SCOPE, buyerId, shopId, view, sourceKey, cell, rowSel });
}

/** Player: real click on the storefront row's Buy button with `qty` typed into its qty input. */
async function clickBuy(page, { buyerId, shopId, sourceKey, qty }) {
  return page.evaluate(async ({ SCOPE, buyerId, shopId, sourceKey, qty }) => {
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    for (const w of [...foundry.applications.instances.values()].filter(w => w instanceof C.CatalogBrowser)) await w.close().catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    const win = C.openShopWindow(game.actors.get(buyerId), { view: "storefront", shopId });
    const sel = `.cp-catalog-row[data-source-key="${sourceKey}"][data-curated="1"]`;
    const t0 = Date.now();
    let row = null;
    while (Date.now() - t0 < 10000) { row = win?.element?.querySelector(sel); if (row) break; await new Promise(r => setTimeout(r, 150)); }
    if (!row) return { found: false };
    const q = row.querySelector(".cp-catalog-qty");
    if (q && qty != null) q.value = String(qty);   // null = press Buy on the box as rendered
    const btn = row.querySelector(".cp-catalog-buy");
    if (!btn || btn.disabled) return { found: true, clicked: false };
    btn.click();
    await new Promise(r => setTimeout(r, 2000));
    return { found: true, clicked: true };
  }, { SCOPE, buyerId, shopId, sourceKey, qty });
}

/** Player: open the storefront and read a curated row's quantity box as rendered (value + max). */
async function readQtyBox(page, { buyerId, shopId, sourceKey }) {
  return page.evaluate(async ({ SCOPE, buyerId, shopId, sourceKey }) => {
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    for (const w of [...foundry.applications.instances.values()].filter(w => w instanceof C.CatalogBrowser)) await w.close().catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    const win = C.openShopWindow(game.actors.get(buyerId), { view: "storefront", shopId });
    const sel = `.cp-catalog-row[data-source-key="${sourceKey}"][data-curated="1"] .cp-catalog-qty`;
    const t0 = Date.now(); let box = null;
    while (Date.now() - t0 < 10000) { box = win?.element?.querySelector(sel); if (box) break; await new Promise(r => setTimeout(r, 150)); }
    if (!box) return { found: false };
    return { found: true, value: box.value, max: box.getAttribute("max") };
  }, { SCOPE, buyerId, shopId, sourceKey });
}

/** Open the catalog view on `page`, narrowed by the search box to `term`, and mark the window instance
 *  so a later read can prove it is the SAME window (no reopen). */
async function openCatalogOn(page, { buyerId, term }) {
  return page.evaluate(async ({ SCOPE, buyerId, term }) => {
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    for (const w of [...foundry.applications.instances.values()].filter(w => w instanceof C.CatalogBrowser)) await w.close().catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    const win = C.openShopWindow(game.actors.get(buyerId), { view: "catalog" });
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) { if (win?.element?.querySelector(".cp-catalog-search")) break; await new Promise(r => setTimeout(r, 150)); }
    const box = win?.element?.querySelector(".cp-catalog-search");
    if (!box) return false;
    box.value = term; box.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    win.__pwMark = "unpriced-stock-12";
    return true;
  }, { SCOPE, buyerId, term });
}

/** Read a row's price cell in the ALREADY-OPEN catalog window, polling until `until(row)` holds (10 s). */
async function readOpenRow(page, sourceKey, until) {
  const read = () => page.evaluate(async ({ SCOPE, sourceKey }) => {
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    const win = [...foundry.applications.instances.values()].find(w => w instanceof C.CatalogBrowser);
    const c = win?.element?.querySelector(`.cp-catalog-row[data-source-key="${sourceKey}"] .cp-cat-price`);
    return {
      found: !!c, sameWindow: win?.__pwMark === "unpriced-stock-12",
      text: (c?.textContent ?? "").replace(/\s+/g, " ").trim(),
      gmMarker: !!c?.querySelector(".cp-price-gm"),
      figure: c?.querySelector("b")?.textContent?.trim() ?? null,
    };
  }, { SCOPE, sourceKey });
  const t0 = Date.now();
  let r = await read();
  while (!(r.found && until(r)) && Date.now() - t0 < 10000) { await page.waitForTimeout(250); r = await read(); }
  return r;
}

/** GM: the purchase-request messages created since the snapshot. */
async function gmRequests(gm, waitForOne = false, ms = 10000) {
  return gm.evaluate(async ({ SCOPE, waitForOne, ms }) => {
    const read = () => [...game.messages].filter(m => !window.__pwBefore.has(m.id) && m.getFlag(SCOPE, "purchaseRequest"));
    const t0 = Date.now();
    while (waitForOne && read().length === 0 && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 120));
    return read().map(m => {
      const req = m.getFlag(SCOPE, "purchaseRequest");
      return { id: m.id, status: req.status, needsPrice: !!req.needsPrice, qty: req.qty, shopId: req.shopId ?? null, sourceKey: req.sourceKey ?? null, itemId: req.itemId };
    });
  }, { SCOPE, waitForOne, ms });
}

/** GM: type `price` into the request card's price input (if any) and press `action` (real click). */
async function gmResolve(gm, msgId, action, price = null) {
  return gm.evaluate(async ({ SCOPE, msgId, action, price }) => {
    const sel = `[data-message-id="${msgId}"] .cp-shop-request-btn[data-action="${action}"]`;
    const t0 = Date.now();
    while (!document.querySelector(sel) && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 120));
    const btn = [...document.querySelectorAll(sel)].pop();
    if (!btn) return { found: false };
    if (price != null) {
      const inp = btn.closest(".cp-shop-request")?.querySelector(".cp-shop-request-price");
      if (inp) inp.value = String(price);
    }
    btn.click();
    const t1 = Date.now();
    while (Date.now() - t1 < 10000) {
      const st = game.messages.get(msgId)?.getFlag(SCOPE, "purchaseRequest")?.status;
      if (st && st !== "pending" && /cp-shop-request-status/.test(game.messages.get(msgId)?.content ?? "")) break;
      await new Promise(r => setTimeout(r, 120));
    }
    await new Promise(r => setTimeout(r, 1200));
    return { found: true, status: game.messages.get(msgId)?.getFlag(SCOPE, "purchaseRequest")?.status ?? null };
  }, { SCOPE, msgId, action, price });
}

/** GM: the buyer's funds, the copies of the probe item it holds, and the shop entry's stock. */
async function gmState(gm, { buyerId, shopId }) {
  return gm.evaluate(({ SCOPE, buyerId, shopId, UNP_ID, UNP_KEY }) => {
    const buyer = game.actors.get(buyerId);
    const copies = buyer.items.filter(i => String(i._stats?.compendiumSource ?? "").includes(UNP_ID));
    const units = copies.reduce((s, i) => s + Math.max(1, Number(i.system?.quantity) || 1), 0);
    const e = game.settings.get(SCOPE, "shops")?.[shopId]?.items?.[UNP_KEY] ?? null;
    return {
      funds: Number(buyer.system.eurobucks), copies: copies.length, units,
      qty: e ? Number(e.qty) : null, unlimited: e ? e.unlimited !== false : null,
      override: (game.settings.get(SCOPE, "shopPriceOverrides") ?? {})[UNP_ID],
      requests: [...game.messages].filter(m => !window.__pwBefore.has(m.id) && m.getFlag(SCOPE, "purchaseRequest")).length,
    };
  }, { SCOPE, buyerId, shopId, UNP_ID, UNP_KEY });
}

/** GM: reset the buyer, the probe entry and the override between sections; sweep this run's messages. */
async function reset(gm, { buyerId, shopId }, entry) {
  await gm.evaluate(async ({ SCOPE, buyerId, shopId, entry, UNP_ID, UNP_KEY }) => {
    const SH = await import(`/modules/${SCOPE}/module/shop/shops.js`);
    const buyer = game.actors.get(buyerId);
    const ids = buyer.items.filter(i => String(i._stats?.compendiumSource ?? "").includes(UNP_ID)).map(i => i.id);
    if (ids.length) await buyer.deleteEmbeddedDocuments("Item", ids);
    await buyer.update({ "system.eurobucks": 5000 });
    const ov = { ...(game.settings.get(SCOPE, "shopPriceOverrides") ?? {}) };
    if (UNP_ID in ov) { delete ov[UNP_ID]; await game.settings.set(SCOPE, "shopPriceOverrides", ov); }
    await SH.setShopItem(shopId, UNP_KEY, entry);
    const stray = [...game.messages].filter(m => !window.__pwBefore.has(m.id)).map(m => m.id);
    if (stray.length) await ChatMessage.deleteDocuments(stray).catch(() => {});
  }, { SCOPE, buyerId, shopId, entry, UNP_ID, UNP_KEY });
  await new Promise(r => setTimeout(r, 800));
}

let gm = null, pc = null, S = null;
try {
  gm = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  collect(gm, gmErrors);
  await joinAs(gm, /^gamemaster$/i, [GM_PW]);

  // ── setup, GM side ────────────────────────────────────────────────────────────────────────────
  S = await gm.evaluate(async ({ SCOPE, START_FUNDS, UNP_PACK, UNP_ID, UNP_KEY }) => {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__UNPSHOP"))) await a.delete().catch(() => {});
    const SH = await import(`/modules/${SCOPE}/module/shop/shops.js`);
    for (const s of SH.listShops().filter(s => s.name?.startsWith("__PW__"))) await SH.deleteShop(s.id);
    window.__pwBefore = new Set(game.messages.map(m => m.id));
    const prevOverrides = foundry.utils.deepClone(game.settings.get(SCOPE, "shopPriceOverrides") ?? {});
    const hadOverride = UNP_ID in prevOverrides;
    if (hadOverride) { const ov = { ...prevOverrides }; delete ov[UNP_ID]; await game.settings.set(SCOPE, "shopPriceOverrides", ov); }

    const player = game.users.find(u => !u.isGM && /test user 1/i.test(u.name)) ?? game.users.find(u => u.role === 1 && u.name);
    const buyer = await Actor.create({
      name: "__PW__UNPSHOP Buyer", type: "character", system: { eurobucks: START_FUNDS },
      ownership: { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
    });
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    const idx = await C.getCatalogIndex();
    const unp = idx.find(r => r.packId === UNP_PACK && r.id === UNP_ID);
    // A priced control row from the same pack family: any positive-cost, non-range, non-cyberware row.
    const ctl = idx.find(r => r.cost > 0 && !r.unpriced && !r.priceRange && r.type !== "cyberware" && r.category === "Armor")
             ?? idx.find(r => r.cost > 0 && !r.unpriced && !r.priceRange && r.type !== "cyberware");
    const shop = await SH.createShop({ name: "__PW__UnpricedShop" });
    await SH.addShopItem(shop.id, UNP_KEY);
    await SH.setShopItem(shop.id, UNP_KEY, { unlimited: false, qty: 5, price: null });
    await SH.addShopItem(shop.id, ctl.key);
    await SH.updateShop(shop.id, { open: true, publishedTo: "all" });
    return {
      playerName: player.name, buyerId: buyer.id, shopId: shop.id, prevOverrides, hadOverride,
      unp: unp ? { unpriced: unp.unpriced, cost: unp.cost, name: unp.name } : null,
      ctl: { key: ctl.key, cost: ctl.cost, name: ctl.name },
    };
  }, { SCOPE, START_FUNDS, UNP_PACK, UNP_ID, UNP_KEY });

  check("fixture: the probe item is in the catalog index with unpriced = true", S.unp?.unpriced === true, JSON.stringify(S.unp));
  check("fixture: a priced control row was found", S.ctl?.cost > 0, `${S.ctl?.name} ${S.ctl?.cost}eb`);
  const IDS = { buyerId: S.buyerId, shopId: S.shopId };

  /* ─────────────────── §1 effectivePrice values ─────────────────── */
  console.log("\n§1 effectivePrice values");
  const ep = await gm.evaluate(async ({ SCOPE }) => {
    const SH = await import(`/modules/${SCOPE}/module/shop/shops.js`);
    const k = "p.x.id";
    const def = (price, discountPct = 0) => ({ discountPct, items: { [k]: { price, unlimited: true } } });
    return {
      shopPriceWithCatalog: SH.effectivePrice(def(300), k, 100, 1),
      shopPriceNoCatalog: SH.effectivePrice(def(300), k, null, 1),
      shopPriceZeroNoCatalog: SH.effectivePrice(def(0), k, null, 1),
      catalogOnly: SH.effectivePrice(def(null), k, 100, 1),
      catalogOnlyDiscount: SH.effectivePrice(def(null, 50), k, 100, 1),
      catalogOnlyStyle: SH.effectivePrice(def(null, 50), k, 100, 3),
      noPrice: SH.effectivePrice(def(null), k, null, 1),
      noPriceDiscount: SH.effectivePrice(def(null, 50), k, null, 2),
    };
  }, { SCOPE });
  check("shop price 300 over catalog 100 = 300", ep.shopPriceWithCatalog === 300, String(ep.shopPriceWithCatalog));
  check("shop price 300, no catalog price = 300", ep.shopPriceNoCatalog === 300, String(ep.shopPriceNoCatalog));
  check("shop price 0, no catalog price = 0 (a deliberate free entry stays free)", ep.shopPriceZeroNoCatalog === 0, String(ep.shopPriceZeroNoCatalog));
  check("no shop price, catalog 100 = 100", ep.catalogOnly === 100, String(ep.catalogOnly));
  check("no shop price, catalog 100, discount 50% = 50", ep.catalogOnlyDiscount === 50, String(ep.catalogOnlyDiscount));
  check("no shop price, catalog 100, discount 50%, style x3 = 150", ep.catalogOnlyStyle === 150, String(ep.catalogOnlyStyle));
  check("no shop price, no catalog price = null", ep.noPrice === null, String(ep.noPrice));
  check("no shop price, no catalog price, discount + style = null", ep.noPriceDiscount === null, String(ep.noPriceDiscount));

  // ── second client ──
  pc = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  collect(pc, pcErrors);
  await joinAs(pc, new RegExp(`^${S.playerName}$`, "i"), ["", GM_PW]);
  await pc.waitForTimeout(1500);
  check("fixture: the second client is a non-GM that owns the buyer",
    await pc.evaluate((id) => !game.user.isGM && game.actors.get(id)?.isOwner === true, S.buyerId), "");

  /* ─────────────────── §2 row markers ─────────────────── */
  console.log("\n§2 storefront row and vendor tray price cells");
  const rowP = await readRow(pc, { ...IDS, view: "storefront", sourceKey: UNP_KEY, cell: ".cp-cat-price", rowSel: ".cp-catalog-row" });
  check("storefront row for the probe is painted on the player client", rowP.found === true, JSON.stringify(rowP));
  check("storefront row price cell carries the GM-priced marker", rowP.gmMarker === true, JSON.stringify(rowP));
  check("storefront row price cell has no eb figure", rowP.figure === null && !/eb$/.test(rowP.text ?? ""), JSON.stringify(rowP));
  const rowC = await readRow(pc, { ...IDS, view: "storefront", sourceKey: S.ctl.key, cell: ".cp-cat-price", rowSel: ".cp-catalog-row" });
  check("NEGATIVE: priced control row shows its catalog figure, no marker",
    rowC.gmMarker === false && Number(rowC.figure) === S.ctl.cost, JSON.stringify(rowC));
  const tray = await readRow(gm, { ...IDS, view: "build", sourceKey: UNP_KEY, cell: ".cp-vendor-sells", rowSel: ".cp-vendor-row" });
  check("GM vendor tray sells-cell carries the GM-priced marker", tray.gmMarker === true && tray.figure === null, JSON.stringify(tray));
  const trayC = await readRow(gm, { ...IDS, view: "build", sourceKey: S.ctl.key, cell: ".cp-vendor-sells", rowSel: ".cp-vendor-row" });
  check("NEGATIVE: vendor tray control row shows its figure", trayC.gmMarker === false && Number(trayC.figure) === S.ctl.cost, JSON.stringify(trayC));
  await gm.evaluate(async (SCOPE) => { const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`); for (const w of [...foundry.applications.instances.values()].filter(w => w instanceof C.CatalogBrowser)) await w.close().catch(() => {}); }, SCOPE);

  /* ─────────────────── §3 player buy → request ─────────────────── */
  console.log("\n§3 player Buy on the unpriced shop row (qty 2)");
  const b3 = await clickBuy(pc, { ...IDS, sourceKey: UNP_KEY, qty: 2 });
  check("Buy button clicked on the player's storefront row", b3.clicked === true, JSON.stringify(b3));
  const q3 = (await gmRequests(gm, true)).pop();
  check("one request card reached the GM", !!q3, JSON.stringify(q3 ?? null));
  check("request flag needsPrice = true", q3?.needsPrice === true, String(q3?.needsPrice));
  check("request flag qty = 2", q3?.qty === 2, String(q3?.qty));
  check("request flag shopId = the shop, sourceKey = the entry", q3?.shopId === S.shopId && q3?.sourceKey === UNP_KEY, `${q3?.shopId} ${q3?.sourceKey}`);
  const s3 = await gmState(gm, IDS);
  check("before approval: funds unchanged", s3.funds === START_FUNDS, String(s3.funds));
  check("before approval: no copy delivered", s3.copies === 0, String(s3.copies));
  check("before approval: stock count unchanged (5)", s3.qty === 5, String(s3.qty));

  /* ─────────────────── §4 approve with a price ─────────────────── */
  console.log("\n§4 GM Approve with price 100");
  const a4 = await gmResolve(gm, q3?.id, "approve", 100);
  check("request status = approved", a4.status === "approved", JSON.stringify(a4));
  const s4 = await gmState(gm, IDS);
  console.log(`  (info) delivered copies=${s4.copies} units=${s4.units}`);
  check("after approval: 2 units delivered", s4.units === 2, `copies=${s4.copies} units=${s4.units}`);
  check("after approval: funds = start − 200", s4.funds === START_FUNDS - 200, String(s4.funds));
  check("after approval: stock count 5 → 3", s4.qty === 3, String(s4.qty));
  check("after approval: override saved = 100", Number(s4.override) === 100, String(s4.override));

  /* ─────────────────── §5 second act: the saved override prices the shelf ─────────────────── */
  console.log("\n§5 saved override, shop discount 20%");
  await gm.evaluate(async ({ SCOPE, shopId }) => { const SH = await import(`/modules/${SCOPE}/module/shop/shops.js`); await SH.updateShop(shopId, { discountPct: 20 }); }, { SCOPE, shopId: S.shopId });
  await pc.waitForTimeout(800);
  const row5 = await readRow(pc, { ...IDS, view: "storefront", sourceKey: UNP_KEY, cell: ".cp-cat-price", rowSel: ".cp-catalog-row" });
  check("storefront row figure = override 100 × 0.8 = 80, no marker", row5.gmMarker === false && Number(row5.figure) === 80, JSON.stringify(row5));
  const f5 = (await gmState(gm, IDS)).funds;
  const b5 = await clickBuy(pc, { ...IDS, sourceKey: UNP_KEY, qty: 1 });
  check("Buy button clicked (override-priced row)", b5.clicked === true, JSON.stringify(b5));
  await gm.waitForTimeout(1500);
  const s5 = await gmState(gm, IDS);
  check("override-priced buy: no new request card", s5.requests === 1, `${s5.requests} (1 = the §4 card)`);
  check("override-priced buy: funds − 80", s5.funds === f5 - 80, `${s5.funds} vs ${f5 - 80}`);
  check("override-priced buy: stock count 3 → 2", s5.qty === 2, String(s5.qty));
  await gm.evaluate(async ({ SCOPE, shopId }) => { const SH = await import(`/modules/${SCOPE}/module/shop/shops.js`); await SH.updateShop(shopId, { discountPct: 0 }); }, { SCOPE, shopId: S.shopId });

  /* ─────────────────── §6 deny ─────────────────── */
  console.log("\n§6 Deny");
  await reset(gm, IDS, { unlimited: false, qty: 5, price: null });
  await clickBuy(pc, { ...IDS, sourceKey: UNP_KEY, qty: 1 });
  const q6 = (await gmRequests(gm, true)).pop();
  check("deny leg: request card reached the GM", q6?.needsPrice === true, JSON.stringify(q6 ?? null));
  const d6 = await gmResolve(gm, q6?.id, "deny");
  check("request status = denied", d6.status === "denied", JSON.stringify(d6));
  const s6 = await gmState(gm, IDS);
  check("after deny: no copy delivered", s6.copies === 0, String(s6.copies));
  check("after deny: funds unchanged", s6.funds === START_FUNDS, String(s6.funds));
  check("after deny: stock count unchanged (5)", s6.qty === 5, String(s6.qty));
  check("after deny: no override saved", s6.override === undefined, String(s6.override));

  /* ─────────────────── §7 unlimited entry ─────────────────── */
  console.log("\n§7 unlimited entry, approve with price 40");
  await reset(gm, IDS, { unlimited: true, qty: 0, price: null });
  await clickBuy(pc, { ...IDS, sourceKey: UNP_KEY, qty: 1 });
  const q7 = (await gmRequests(gm, true)).pop();
  check("unlimited leg: request card reached the GM", q7?.needsPrice === true, JSON.stringify(q7 ?? null));
  const a7 = await gmResolve(gm, q7?.id, "approve", 40);
  const s7 = await gmState(gm, IDS);
  check("unlimited: request status = approved", a7.status === "approved", JSON.stringify(a7));
  check("unlimited: 1 copy delivered, funds − 40", s7.units === 1 && s7.funds === START_FUNDS - 40, `units=${s7.units} funds=${s7.funds}`);
  check("unlimited: entry still unlimited, qty 0 untouched", s7.unlimited === true && s7.qty === 0, `unlimited=${s7.unlimited} qty=${s7.qty}`);

  /* ─────────────────── §8 shop price on the unpriced item ─────────────────── */
  console.log("\n§8 shop price 250 set on the unpriced entry");
  await reset(gm, IDS, { unlimited: false, qty: 5, price: 250 });
  const row8 = await readRow(pc, { ...IDS, view: "storefront", sourceKey: UNP_KEY, cell: ".cp-cat-price", rowSel: ".cp-catalog-row" });
  check("storefront row figure = shop price 250, no marker", row8.gmMarker === false && Number(row8.figure) === 250, JSON.stringify(row8));
  await clickBuy(pc, { ...IDS, sourceKey: UNP_KEY, qty: 1 });
  await gm.waitForTimeout(1500);
  const s8 = await gmState(gm, IDS);
  check("shop-priced buy: no request card", s8.requests === 0, String(s8.requests));
  check("shop-priced buy: 1 copy delivered, funds − 250", s8.units === 1 && s8.funds === START_FUNDS - 250, `units=${s8.units} funds=${s8.funds}`);
  check("shop-priced buy: stock count 5 → 4", s8.qty === 4, String(s8.qty));

  /* ─────────────────── §9 GM setup mode ─────────────────── */
  console.log("\n§9 GM setup mode");
  await reset(gm, IDS, { unlimited: false, qty: 5, price: null });
  const r9 = await gm.evaluate(async ({ SCOPE, buyerId, shopId, UNP_KEY }) => {
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    const SETUP = await import(`/modules/${SCOPE}/module/shop/setup-mode.js`);
    SETUP.setShopSetupMode(true);
    try { return { on: SETUP.isShopSetupMode(), r: await C.purchaseShopItem(game.actors.get(buyerId), shopId, UNP_KEY, { qty: 1 }) ?? null }; }
    finally { await new Promise(r => setTimeout(r, 800)); }
  }, { SCOPE, ...IDS, UNP_KEY });
  const s9 = await gmState(gm, IDS);
  check("setup mode is ON for the leg", r9.on === true, String(r9.on));
  check("setup mode: 1 copy delivered", s9.units === 1, String(s9.units));
  check("setup mode: funds unchanged", s9.funds === START_FUNDS, String(s9.funds));
  check("setup mode: no request card", s9.requests === 0, String(s9.requests));
  check("setup mode: stock count unchanged (5)", s9.qty === 5, String(s9.qty));
  await reset(gm, IDS, { unlimited: false, qty: 5, price: null });
  const r9b = await gm.evaluate(async ({ SCOPE, buyerId, shopId, UNP_KEY }) => {
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    const SETUP = await import(`/modules/${SCOPE}/module/shop/setup-mode.js`);
    SETUP.setShopSetupMode(false);
    const r = await C.purchaseShopItem(game.actors.get(buyerId), shopId, UNP_KEY, { qty: 1 });
    await new Promise(r => setTimeout(r, 800));
    return { on: SETUP.isShopSetupMode(), r: r ?? null };
  }, { SCOPE, ...IDS, UNP_KEY });
  const s9b = await gmState(gm, IDS);
  check("NEGATIVE setup mode OFF: GM buy returns reason 'requested'", r9b.r?.reason === "requested", JSON.stringify(r9b));
  check("NEGATIVE setup mode OFF: one request card, nothing delivered, funds and stock unchanged",
    s9b.requests === 1 && s9b.units === 0 && s9b.funds === START_FUNDS && s9b.qty === 5, JSON.stringify(s9b));

  /* ─────────────────── §10 the storefront quantity box ─────────────────── */
  console.log("\n§10 storefront quantity box (stocked entry qty 5, shop price 250)");
  await reset(gm, IDS, { unlimited: false, qty: 5, price: 250 });
  const q10 = await readQtyBox(pc, { ...IDS, sourceKey: UNP_KEY });
  check("stocked row: quantity box starts at 1", q10.value === "1", JSON.stringify(q10));
  check("stocked row: quantity box max = the stock count 5", q10.max === "5", JSON.stringify(q10));
  const q10c = await readQtyBox(pc, { ...IDS, sourceKey: S.ctl.key });
  check("NEGATIVE unlimited row: box starts at 1 with no max", q10c.value === "1" && q10c.max === null, JSON.stringify(q10c));
  const b10 = await clickBuy(pc, { ...IDS, sourceKey: UNP_KEY, qty: null });
  check("Buy clicked without editing the box", b10.clicked === true, JSON.stringify(b10));
  await gm.waitForTimeout(1200);
  const s10 = await gmState(gm, IDS);
  check("unedited buy: 1 unit delivered, funds − 250, stock 5 → 4", s10.units === 1 && s10.funds === START_FUNDS - 250 && s10.qty === 4, JSON.stringify(s10));
  // Second act: a typed quantity survives a re-render of the same window, and the cap follows the stock.
  const q10t = await pc.evaluate(async ({ SCOPE, sourceKey }) => {
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    const win = [...foundry.applications.instances.values()].find(w => w instanceof C.CatalogBrowser);
    const sel = `.cp-catalog-row[data-source-key="${sourceKey}"][data-curated="1"] .cp-catalog-qty`;
    const box = win.element.querySelector(sel);
    box.value = "2"; box.dispatchEvent(new Event("input", { bubbles: true }));
    await win.render(); await new Promise(r => setTimeout(r, 900));
    const again = win.element.querySelector(sel);
    return { value: again?.value ?? null, max: again?.getAttribute("max") ?? null };
  }, { SCOPE, sourceKey: UNP_KEY });
  check("typed quantity 2 survives a re-render; max now = stock 4", q10t.value === "2" && q10t.max === "4", JSON.stringify(q10t));
  const tray10 = await gm.evaluate(async ({ SCOPE, shopId, sourceKey }) => {
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    for (const w of [...foundry.applications.instances.values()].filter(w => w instanceof C.CatalogBrowser)) await w.close().catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    const win = C.openShopWindow(null, { view: "build", shopId });
    const t0 = Date.now(); let row = null;
    while (Date.now() - t0 < 10000) { row = win?.element?.querySelector(`.cp-vendor-row[data-source-key="${sourceKey}"]`); if (row) break; await new Promise(r => setTimeout(r, 150)); }
    const v = row?.querySelector(".cp-shop-stock-qty")?.value ?? null;
    const dbg = { loading: !!win?.element?.querySelector(".cp-catalog-loading"), rows: win?.element?.querySelectorAll(".cp-vendor-row").length, view: win?.view, ready: C.catalogIndexReady(), html: (win?.element?.querySelector(".window-content")?.textContent ?? "").slice(0, 200) };
    await win.close().catch(() => {});
    return v ?? JSON.stringify(dbg);
  }, { SCOPE, shopId: S.shopId, sourceKey: UNP_KEY });
  check("NEGATIVE: the GM's vendor tray stock box still shows the stock count 4", tray10 === "4", String(tray10));

  /* ─────────────────── §11 a deliberate shop price of 0 ─────────────────── */
  console.log("\n§11 shop price 0");
  await reset(gm, IDS, { unlimited: false, qty: 5, price: 0 });
  const row11 = await readRow(pc, { ...IDS, view: "storefront", sourceKey: UNP_KEY, cell: ".cp-cat-price", rowSel: ".cp-catalog-row" });
  check("storefront row reads '0eb': figure 0, no GM-priced marker", row11.figure === "0" && row11.text === "0eb" && row11.gmMarker === false, JSON.stringify(row11));
  const tray11 = await readRow(gm, { ...IDS, view: "build", sourceKey: UNP_KEY, cell: ".cp-vendor-sells", rowSel: ".cp-vendor-row" });
  check("GM vendor tray reads figure 0", tray11.figure === "0" && tray11.gmMarker === false, JSON.stringify(tray11));
  await gm.evaluate(async (SCOPE) => { const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`); for (const w of [...foundry.applications.instances.values()].filter(w => w instanceof C.CatalogBrowser)) await w.close().catch(() => {}); }, SCOPE);
  const b11 = await clickBuy(pc, { ...IDS, sourceKey: UNP_KEY, qty: 1 });
  await gm.waitForTimeout(1200);
  const s11 = await gmState(gm, IDS);
  check("price-0 buy: delivered, funds unchanged, no request, stock 5 → 4",
    b11.clicked && s11.units === 1 && s11.funds === START_FUNDS && s11.requests === 0 && s11.qty === 4, JSON.stringify(s11));

  /* ─────────────────── §12 open catalog windows follow a saved / cleared override ─────────────────── */
  console.log("\n§12 open catalog windows on both clients follow an approved price, then its removal");
  await reset(gm, IDS, { unlimited: false, qty: 5, price: null });
  // The probe must be listed for the player: if its book is hidden from players, show it for this section.
  const vis12 = await gm.evaluate(async ({ SCOPE, UNP_KEY }) => {
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    const row = (await C.getCatalogIndex()).find(r => r.key === UNP_KEY);
    const map = { ...(game.settings.get(SCOPE, "shopEnabledSources") ?? {}) };
    const prev = map[row.supplement];
    if (row.canon !== "core" && map[row.supplement] !== true) { map[row.supplement] = true; await game.settings.set(SCOPE, "shopEnabledSources", map); }
    return { supplement: row.supplement, canon: row.canon, name: row.name, prev: prev ?? null };
  }, { SCOPE, UNP_KEY });
  S.vis12 = vis12;
  await pc.waitForTimeout(600);
  const pOpen = await openCatalogOn(pc, { buyerId: S.buyerId, term: vis12.name });
  const gOpen = await openCatalogOn(gm, { buyerId: S.buyerId, term: vis12.name });
  const p12a = await readOpenRow(pc, UNP_KEY, r => r.gmMarker);
  const g12a = await readOpenRow(gm, UNP_KEY, r => r.gmMarker);
  check("both catalogs open with the probe row reading GM-priced", pOpen && gOpen && p12a.gmMarker && g12a.gmMarker, JSON.stringify({ p12a, g12a }));
  // The player's Buy from their open catalog asks the GM for a price.
  const b12 = await pc.evaluate(async ({ SCOPE, key }) => {
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    const win = [...foundry.applications.instances.values()].find(w => w instanceof C.CatalogBrowser);
    const btn = win?.element?.querySelector(`.cp-catalog-row[data-source-key="${key}"] .cp-catalog-buy`);
    if (!btn) return false;
    btn.click(); await new Promise(r => setTimeout(r, 1500));
    return true;
  }, { SCOPE, key: UNP_KEY });
  const q12 = (await gmRequests(gm, true)).pop();
  check("player catalog Buy raised a needsPrice request", b12 && q12?.needsPrice === true, JSON.stringify(q12 ?? null));
  const a12 = await gmResolve(gm, q12?.id, "approve", 120);
  check("GM approved at 120", a12.status === "approved", JSON.stringify(a12));
  const p12b = await readOpenRow(pc, UNP_KEY, r => r.figure === "120");
  const g12b = await readOpenRow(gm, UNP_KEY, r => r.figure === "120");
  check("player's open catalog window now shows 120eb, no marker (same window, no reopen)", p12b.figure === "120" && !p12b.gmMarker && p12b.sameWindow, JSON.stringify(p12b));
  check("GM's open catalog window now shows 120eb, no marker (same window, no reopen)", g12b.figure === "120" && !g12b.gmMarker && g12b.sameWindow, JSON.stringify(g12b));
  // Second act: clearing the override puts the marker back in both open windows.
  await gm.evaluate(async ({ SCOPE, UNP_ID }) => {
    const ov = { ...(game.settings.get(SCOPE, "shopPriceOverrides") ?? {}) };
    delete ov[UNP_ID];
    await game.settings.set(SCOPE, "shopPriceOverrides", ov);
  }, { SCOPE, UNP_ID });
  const p12c = await readOpenRow(pc, UNP_KEY, r => r.gmMarker);
  const g12c = await readOpenRow(gm, UNP_KEY, r => r.gmMarker);
  check("override cleared: the player's open window reads GM-priced again", p12c.gmMarker && p12c.figure === null && p12c.sameWindow, JSON.stringify(p12c));
  check("override cleared: the GM's open window reads GM-priced again", g12c.gmMarker && g12c.figure === null && g12c.sameWindow, JSON.stringify(g12c));

  console.log("\n§13 console");
  check("0 console errors on the GM session", gmErrors.length === 0, gmErrors.slice(0, 3).join(" | "));
  check("0 console errors on the player session", pcErrors.length === 0, pcErrors.slice(0, 3).join(" | "));
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  fail++; failed.push("harness threw");
} finally {
  if (gm && S) {
    if (pc) await pc.evaluate(async (SCOPE) => {
      const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
      for (const w of [...foundry.applications.instances.values()].filter(w => w instanceof C.CatalogBrowser)) await w.close().catch(() => {});
    }, SCOPE).catch(() => {});
    await gm.evaluate(async ({ SCOPE, buyerId, shopId, prevOverrides, UNP_ID, vis12 }) => {
      try { (await import(`/modules/${SCOPE}/module/shop/setup-mode.js`)).setShopSetupMode(false); } catch {}
      try {
        // §12 may have shown the probe's book to players; put that one entry back as it stood.
        if (vis12 && vis12.canon !== "core") {
          const map = { ...(game.settings.get(SCOPE, "shopEnabledSources") ?? {}) };
          if (vis12.prev === null) delete map[vis12.supplement]; else map[vis12.supplement] = vis12.prev;
          await game.settings.set(SCOPE, "shopEnabledSources", map);
        }
      } catch {}
      try {
        const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
        for (const w of [...foundry.applications.instances.values()].filter(w => w instanceof C.CatalogBrowser)) await w.close().catch(() => {});
      } catch {}
      try {
        // Restore the probe's override to what stood before the run (normally: none).
        const ov = { ...(game.settings.get(SCOPE, "shopPriceOverrides") ?? {}) };
        if (UNP_ID in prevOverrides) ov[UNP_ID] = prevOverrides[UNP_ID]; else delete ov[UNP_ID];
        await game.settings.set(SCOPE, "shopPriceOverrides", ov);
      } catch {}
      try { const SH = await import(`/modules/${SCOPE}/module/shop/shops.js`); await SH.deleteShop(shopId); } catch {}
      try {
        const stray = [...game.messages].filter(m => !window.__pwBefore?.has(m.id)).map(m => m.id);
        if (window.__pwBefore && stray.length) await ChatMessage.deleteDocuments(stray);
      } catch {}
      try { await game.actors.get(buyerId)?.delete(); } catch {}
      for (const a of game.actors.filter(a => a.name?.startsWith("__PW__UNPSHOP"))) await a.delete().catch(() => {});
    }, { SCOPE, buyerId: S.buyerId, shopId: S.shopId, prevOverrides: S.prevOverrides, UNP_ID, vis12: S.vis12 ?? null }).catch(e => console.error("cleanup failed:", e?.message));
  }
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (failed.length) console.log("FAILED: " + failed.join(" || "));
process.exit(fail ? 1 : 0);
