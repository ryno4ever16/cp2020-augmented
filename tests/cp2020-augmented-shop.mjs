/**
 * Shop purchase keeper (:30004, official 1.1.1 + module).
 *
 * The core purchase engine — resolve price (compendium → GM override → unpurchasable), CHARGE FIRST,
 * embed the item, refund on failure — had no dedicated module-rig keeper (pre-release review §H). This
 * drives the REAL functions (module/shop/purchase.js + the settings override map), not a reimplementation:
 *   • resolveCatalogPrice precedence, incl. the variable-price `preferOverride` path
 *   • buyItem: eurobucks charged + item embedded; qty; insufficient-funds refusal (no charge, no goods)
 *   • the GM price-override flow (an unpriced item → setShopPriceOverride → resolves → buy at that price)
 * Restores the world override map + deletes its test actors, so it never leaks state.
 *
 * Part 2 guards the catalog's paint cost: a changed buyer is patched into the open window instead of
 * rebuilding ~2,500 rows, so four select/deselect cycles must produce zero re-renders while the funds
 * readout still follows the token. Also pins the row paint diet (skipped off-screen rows, lazy thumbs)
 * and the once-per-session ammo row build.
 *
 * Run:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-shop.mjs
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";

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
    await Promise.all([page.waitForNavigation({ url: /\/game/, timeout: 15000 }).catch(() => {}), page.locator('button[name="join"]').click()]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 15000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await s.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("join failed " + u.l);
}

const b = await chromium.launch({ headless: true });
let pass = false; const log = []; const errors = [];
try {
  const gm = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  gm.on("pageerror", e => log.push("PAGEERR " + e.message));
  gm.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await joinAs(gm, /gamemaster/i, [GM_PW]);

  const r = await gm.evaluate(async () => {
    const P = await import("/modules/cp2020-augmented/module/shop/purchase.js");
    const S = await import("/modules/cp2020-augmented/module/settings.js");
    const checks = []; const chk = (label, cond, got) => checks.push({ label, ok: !!cond, got });

    // Restore point — never leak a test override into the world setting.
    const origOverrides = S.getShopPriceOverrides();

    // ── resolveCatalogPrice precedence (pure) ────────────────────────────────────────────────
    const rc1 = P.resolveCatalogPrice(350, "id-a", {});
    chk("price: positive cost → compendium 350", rc1.price === 350 && rc1.source === "compendium" && rc1.purchasable === true, JSON.stringify(rc1));
    const rc2 = P.resolveCatalogPrice(0, "id-b", {});
    chk("price: cost 0 + no override → unpurchasable (none)", rc2.purchasable === false && rc2.source === "none" && rc2.price === null, JSON.stringify(rc2));
    const rc3 = P.resolveCatalogPrice(0, "id-c", { "id-c": 275 });
    chk("price: cost 0 + override → override 275", rc3.price === 275 && rc3.source === "override" && rc3.purchasable === true, JSON.stringify(rc3));
    const rc4 = P.resolveCatalogPrice(500, "id-d", { "id-d": 275 }, { preferOverride: true });
    chk("price: variable-price (preferOverride) → override beats compendium", rc4.price === 275 && rc4.source === "override", JSON.stringify(rc4));
    const rc5 = P.resolveCatalogPrice(500, "id-e", { "id-e": 275 });
    chk("price: fixed item → compendium wins, override self-disengages", rc5.price === 500 && rc5.source === "compendium", JSON.stringify(rc5));

    // ── buyItem: charge first, then embed ────────────────────────────────────────────────────
    const actor = await Actor.create({ name: "__PW__ShopBuyer", type: "character",
      system: { eurobucks: 2000 }, flags: { "cp2020-augmented": { __pwtest: true } } });
    const src = (cost) => ({ name: "__PW__ShopGear", type: "misc", img: "icons/svg/item-bag.svg", system: { cost, equipped: false } });
    const bought = () => actor.items.filter(i => i.name === "__PW__ShopGear").length;

    const ok1 = await P.buyItem(actor, src(350), { qty: 1, unitPrice: 350 });
    chk("buy: single purchase returns true", ok1 === true, ok1);
    chk("buy: eurobucks charged (2000 → 1650)", Number(actor.system.eurobucks) === 1650, actor.system.eurobucks);
    chk("buy: one item embedded on the actor", bought() === 1, bought());

    const ok3 = await P.buyItem(actor, src(100), { qty: 3, unitPrice: 100 });
    chk("buy: qty 3 charges 300 (1650 → 1350)", ok3 === true && Number(actor.system.eurobucks) === 1350, actor.system.eurobucks);
    chk("buy: three copies embedded (1 + 3)", bought() === 4, bought());

    // ── insufficient funds: refuse, no charge, no goods ──────────────────────────────────────
    const poor = await Actor.create({ name: "__PW__ShopBroke", type: "character",
      system: { eurobucks: 50 }, flags: { "cp2020-augmented": { __pwtest: true } } });
    const okPoor = await P.buyItem(poor, src(350), { qty: 1, unitPrice: 350 });
    chk("buy: insufficient funds refused (false)", okPoor === false, okPoor);
    chk("buy: no charge on refusal (50 unchanged)", Number(poor.system.eurobucks) === 50, poor.system.eurobucks);
    chk("buy: no item on refusal", poor.items.filter(i => i.name === "__PW__ShopGear").length === 0, poor.items.filter(i => i.name === "__PW__ShopGear").length);

    // ── GM price-override flow: an unpriced item → GM sets a price → it resolves → buy at it ──
    const unpricedId = "__pw_shop_unpriced";
    await S.setShopPriceOverride(unpricedId, 275);
    chk("override: setShopPriceOverride persists the GM price", S.getShopPriceOverride(unpricedId) === 275, S.getShopPriceOverride(unpricedId));
    const resolved = P.resolveCatalogPrice(0, unpricedId, S.getShopPriceOverrides());
    chk("override: an unpriced item resolves to the GM price (275, override)", resolved.price === 275 && resolved.source === "override", JSON.stringify(resolved));
    const okOv = await P.buyItem(actor, src(0), { qty: 1, unitPrice: resolved.price });
    chk("override: buying at the GM price charges 275 (1350 → 1075)", okOv === true && Number(actor.system.eurobucks) === 1075, actor.system.eurobucks);

    // ── cleanup: delete test actors + restore the world override map ──────────────────────────
    await Actor.deleteDocuments([actor.id, poor.id].filter(Boolean));
    await game.settings.set("cp2020-augmented", "shopPriceOverrides", origOverrides);

    return { ok: checks.every(c => c.ok), checks };
  });

  for (const c of r.checks || []) log.push(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}  ${c.ok ? "" : "-> got " + c.got}`);

  // ── Buyer changes are patched in place; selecting a token does not rebuild the catalog ──────────
  const r2 = await gm.evaluate(async () => {
    const C = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    const checks = []; const chk = (label, cond, got) => checks.push({ label, ok: !!cond, got });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let a = null, bb = null, w = null, tokenIds = [];
    try {
      for (const x of game.actors.filter(x => /^__PW__Buyer/.test(x.name))) await x.delete().catch(() => {});
      a  = await Actor.create({ name: "__PW__BuyerA", type: "character", system: { eurobucks: 1234 } });
      bb = await Actor.create({ name: "__PW__BuyerB", type: "character", system: { eurobucks: 777 } });
      const tds = await canvas.scene.createEmbeddedDocuments("Token", [
        { name: "__PW__BuyerA", actorId: a.id, actorLink: true, x: 200, y: 200, width: 1, height: 1 },
        { name: "__PW__BuyerB", actorId: bb.id, actorLink: true, x: 400, y: 200, width: 1, height: 1 },
      ]);
      tokenIds = tds.map(t => t.id);
      const tokA = canvas.tokens.get(tds.find(t => t.name === "__PW__BuyerA").id);
      const tokB = canvas.tokens.get(tds.find(t => t.name === "__PW__BuyerB").id);
      chk("both fixture tokens are placed and controllable", !!tokA && !!tokB, `${!!tokA}/${!!tokB}`);

      canvas.tokens.releaseAll();
      w = C.openShopWindow(null, { view: "catalog" });
      // The catalog opens on its category tiles; the row list this section measures is one step in.
      for (let i = 0; i < 200 && !w.element?.querySelector('.cp-cat-tile[data-cat=""], .cp-catalog-row'); i++) await sleep(50);
      w.element?.querySelector('.cp-cat-tile[data-cat=""]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      for (let i = 0; i < 200 && !(w.element?.querySelectorAll(".cp-catalog-row").length); i++) await sleep(50);
      const rowCount = w.element.querySelectorAll(".cp-catalog-row").length;
      // The list is WINDOWED: the DOM holds about a screenful and `data-total` on the container is
      // the census truth for the whole set. (Before the window unit this leg counted the DOM itself.)
      const listEl = w.element.querySelector(".cp-catalog-list");
      const total = Number(listEl?.dataset.total);
      chk("the list container reports the full row census", total > 100, total);
      chk("catalog painted a window of that census, not all of it", rowCount > 0 && rowCount < total, `${rowCount} painted of ${total}`);

      // Row paint diet: the mechanism is the window plus its two spacers — the spacers carry the
      // height of everything scrolled out, so the scrollbar still measures the whole list.
      // (content-visibility/contain-intrinsic-size were retired with this unit — nothing to skip
      // when the off-screen rows are not in the DOM at all.)
      const firstRow = w.element.querySelector(".cp-catalog-row");
      const firstImg = w.element.querySelector(".cp-catalog-row img");
      const padTop = listEl?.querySelector(".cp-list-pad-top");
      const padBottom = listEl?.querySelector(".cp-list-pad-bottom");
      const padH = (el) => (el ? parseFloat(getComputedStyle(el).height) || 0 : -1);
      chk("both list spacers are rendered", !!padTop && !!padBottom, `${!!padTop}/${!!padBottom}`);
      chk("at the top of the list only the bottom spacer carries height",
        padH(padTop) === 0 && padH(padBottom) > 0, `top=${padH(padTop)}px bottom=${padH(padBottom)}px`);
      chk("no row is left with a paint-skipping rule on it",
        getComputedStyle(firstRow).contentVisibility === "visible", getComputedStyle(firstRow).contentVisibility);
      const nonLazy = [...w.element.querySelectorAll(".cp-catalog-row img")].filter(i => i.getAttribute("loading") !== "lazy").length;
      chk("no row thumb loads eagerly", nonLazy === 0, nonLazy);
      chk("row thumbs keep their intrinsic box", firstImg?.getAttribute("width") === "26" && firstImg?.getAttribute("height") === "26", `${firstImg?.getAttribute("width")}x${firstImg?.getAttribute("height")}`);

      // Generated ammo rows are built once per session, not per render.
      const ar1 = w._ammoCatalogRows(); const ar2 = w._ammoCatalogRows();
      chk("ammo rows are handed back from the cache", ar1 === ar2, ar1 === ar2);
      C.clearAmmoCatalogRowsCache();
      const ar3 = w._ammoCatalogRows();
      chk("clearing the cache rebuilds the same set", ar3 !== ar1 && ar3.length === ar1.length, `${ar3 !== ar1} len=${ar3.length}/${ar1.length}`);

      // Sentinels: the window element and one row node must survive the churn untouched.
      w.element.dataset.pwSentinel = "kept";
      const rowNode = w.element.querySelector(".cp-catalog-row");
      let renders = 0;
      const origRender = w.render.bind(w);
      w.render = function (...args) { renders++; return origRender(...args); };

      const fundsText = () => w.element.querySelector(".cp-buyer-funds")?.textContent?.trim() ?? "";
      const pickValue = () => w.element.querySelector(".cp-buyer-pick")?.value ?? null;
      const seen = [];
      for (let i = 0; i < 4; i++) {
        const tok = i % 2 === 0 ? tokA : tokB;
        tok.control({ releaseOthers: true });
        await sleep(300);
        seen.push({ phase: "on", funds: fundsText(), buyer: w.buyer?.name ?? null, pick: pickValue() });
        canvas.tokens.releaseAll();
        await sleep(300);
        seen.push({ phase: "off", funds: fundsText(), buyer: w.buyer?.name ?? null });
      }
      w.render = origRender;

      chk("4 select/deselect cycles trigger no re-render", renders === 0, renders);
      chk("the window element survives the churn", w.element.dataset.pwSentinel === "kept", w.element.dataset.pwSentinel);
      chk("the row nodes are never replaced", w.element.querySelector(".cp-catalog-row") === rowNode, w.element.querySelector(".cp-catalog-row") === rowNode);
      chk("row count is unchanged after the churn", w.element.querySelectorAll(".cp-catalog-row").length === rowCount, w.element.querySelectorAll(".cp-catalog-row").length);

      const on = seen.filter(s => s.phase === "on");
      chk("funds follow the selected token (A → 1234eb)", on[0].funds === "1234eb", on[0].funds);
      chk("funds follow the selected token (B → 777eb)", on[1].funds === "777eb", on[1].funds);
      chk("funds follow the selected token on the repeat pass", on[2].funds === "1234eb" && on[3].funds === "777eb", `${on[2].funds}/${on[3].funds}`);
      chk("the buyer object follows the selected token", on[0].buyer === "__PW__BuyerA" && on[1].buyer === "__PW__BuyerB", `${on[0].buyer}/${on[1].buyer}`);
      chk("the picker re-selects the new buyer", on[0].pick === a.id && on[1].pick === bb.id, `${on[0].pick === a.id}/${on[1].pick === bb.id}`);
      const off = seen.filter(s => s.phase === "off");
      chk("releasing drops back off the fixture buyers", off.every(s => s.buyer !== "__PW__BuyerA" && s.buyer !== "__PW__BuyerB"), off.map(s => s.buyer).join(","));

      // The picker is rebuilt by every repaint, so its listener has to be re-attached with it.
      tokA.control({ releaseOthers: true });
      await sleep(350);
      const sel = w.element.querySelector(".cp-buyer-pick");
      chk("a repainted strip carries a picker for the buyer", !!sel && sel.value === a.id, `${!!sel}/${sel?.value === a.id}`);
      let renders2 = 0;
      const origRender2 = w.render.bind(w);
      w.render = function (...args) { renders2++; return origRender2(...args); };
      if (sel) { sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      await sleep(350);
      w.render = origRender2;
      chk("the rebound picker clears the buyer", w.buyer === null, w.buyer?.name ?? "null");
      chk("clearing through the picker costs no re-render", renders2 === 0, renders2);
      chk("with no buyer the strip shows the notice instead", !!w.element.querySelector(".cp-buyer-warn"), !!w.element.querySelector(".cp-buyer-warn"));
      return { ok: checks.every(c => c.ok), checks };
    } catch (e) {
      checks.push({ label: "churn leg ran to completion", ok: false, got: e?.message || String(e) });
      return { ok: false, checks };
    } finally {
      try { canvas.tokens.releaseAll(); } catch {}
      try { if (w) await w.close(); } catch {}
      try { if (tokenIds.length) await canvas.scene.deleteEmbeddedDocuments("Token", tokenIds); } catch {}
      try { await Actor.deleteDocuments([a?.id, bb?.id].filter(Boolean)); } catch {}
      try { (await import("/modules/cp2020-augmented/module/shop/catalog.js")).clearAmmoCatalogRowsCache(); } catch {}
    }
  });
  for (const c of r2.checks || []) log.push(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}  ${c.ok ? "" : "-> got " + c.got}`);

  // ── The style-multiplied price a buyer is actually charged for clothing ─────────────────────────
  //   SOURCE for every multiplier below: CP2020 core Gear List, book p.66 — "Fashion = base x style:
  //   Generic Chic x1, Leisurewear x2, Urban Flash x2, Businesswear x3, High Fashion x4"
  //   (memory core-read-fulldetail.md BATCH 5 / core-rules-reference.md #1). The `cyberpunk2020.fashion`
  //   pack prints all four tiers of the same eight garments, so the ladder is cross-checked against
  //   the book's own printed prices rather than against the table under test.
  const r3 = await gm.evaluate(async () => {
    const P  = await import("/modules/cp2020-augmented/module/shop/purchase.js");
    const C  = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    const SH = await import("/modules/cp2020-augmented/module/shop/shops.js");
    const DC = await import("/modules/cp2020-augmented/module/data-corrections.js");
    const SM = await import("/modules/cp2020-augmented/module/shop/setup-mode.js");
    const checks = []; const chk = (label, cond, got) => checks.push({ label, ok: !!cond, got });
    let buyer = null, setupWas = null;
    try {
      setupWas = SM.isShopSetupMode();
      if (setupWas) await SM.setShopSetupMode(false);
      chk("fixture posture: the free-grant setup mode is off, so prices are actually charged",
        SM.isShopSetupMode() === false, SM.isShopSetupMode());

      // ── the style table, by value, against the book ───────────────────────────────────────────
      const byKey = Object.fromEntries(P.FASHION_STYLES.map(s => [s.key, s]));
      chk("style table: five tiers, keyed generic/leisure/urbanflash/business/highfashion",
        P.FASHION_STYLES.length === 5 && ["generic","leisure","urbanflash","business","highfashion"].every(k => byKey[k]),
        P.FASHION_STYLES.map(s => s.key).join(","));
      chk("style table: the multipliers are x1 / x2 / x2 / x3 / x4 (book p.66)",
        byKey.generic.mult === 1 && byKey.leisure.mult === 2 && byKey.urbanflash.mult === 2
        && byKey.business.mult === 3 && byKey.highfashion.mult === 4,
        P.FASHION_STYLES.map(s => `${s.key}x${s.mult}`).join(" "));
      chk("styleMultOf returns each tier's multiplier by key",
        P.styleMultOf("generic") === 1 && P.styleMultOf("leisure") === 2 && P.styleMultOf("urbanflash") === 2
        && P.styleMultOf("business") === 3 && P.styleMultOf("highfashion") === 4,
        ["generic","leisure","urbanflash","business","highfashion"].map(k => P.styleMultOf(k)).join("/"));
      chk("NEGATIVE: an unknown, empty or missing style key charges the plain price",
        P.styleMultOf("couture") === 1 && P.styleMultOf("") === 1 && P.styleMultOf(null) === 1 && P.styleMultOf(undefined) === 1,
        [P.styleMultOf("couture"), P.styleMultOf(""), P.styleMultOf(null), P.styleMultOf(undefined)].join("/"));
      chk("styleLabelOf returns each tier's display label by key",
        P.styleLabelOf("generic") === "Generic" && P.styleLabelOf("leisure") === "Leisure"
        && P.styleLabelOf("urbanflash") === "Urban Flash" && P.styleLabelOf("business") === "Businesswear"
        && P.styleLabelOf("highfashion") === "High Fashion",
        ["generic","leisure","urbanflash","business","highfashion"].map(k => P.styleLabelOf(k)).join("/"));
      chk("NEGATIVE: an unknown style key has no label rather than an invented one",
        P.styleLabelOf("couture") === "" && P.styleLabelOf("") === "" && P.styleLabelOf(null) === "",
        JSON.stringify([P.styleLabelOf("couture"), P.styleLabelOf(""), P.styleLabelOf(null)]));

      // ── priceFor: the multiplied unit price, by value ─────────────────────────────────────────
      const item = (cost) => ({ system: { cost } });
      chk("priceFor multiplies the catalog cost by the style multiplier",
        P.priceFor(item(35), { styleMult: 1 }) === 35 && P.priceFor(item(35), { styleMult: 2 }) === 70
        && P.priceFor(item(35), { styleMult: 3 }) === 105 && P.priceFor(item(35), { styleMult: 4 }) === 140,
        [1,2,3,4].map(m => P.priceFor(item(35), { styleMult: m })).join("/"));
      chk("priceFor rounds a fractional product to whole eurobucks",
        P.priceFor(item(12.5), { styleMult: 3 }) === 38 && P.priceFor(item(0.4), { styleMult: 1 }) === 0,
        `12.5x3 -> ${P.priceFor(item(12.5), { styleMult: 3 })}; 0.4x1 -> ${P.priceFor(item(0.4), { styleMult: 1 })}`);
      chk("NEGATIVE: no cost, no options, a zero/absent multiplier and a negative cost never charge below zero",
        P.priceFor(item(35)) === 35 && P.priceFor({}) === 0 && P.priceFor(null) === 0
        && P.priceFor(item(35), { styleMult: 0 }) === 35 && P.priceFor(item(35), { styleMult: NaN }) === 35
        && P.priceFor(item(-99), { styleMult: 4 }) === 0,
        [P.priceFor(item(35)), P.priceFor({}), P.priceFor(null), P.priceFor(item(35), { styleMult: 0 }), P.priceFor(item(-99), { styleMult: 4 })].join("/"));

      // ── the ladder against the pack's own printed tier prices (closed enumeration) ────────────
      const pack = game.packs.get("cyberpunk2020.fashion");
      const idx = await pack.getIndex({ fields: ["system.cost", "type"] });
      const TIER = { "Generic Chic": "generic", "Leisurewear/Urban Flash": "leisure", "Businesswear": "business", "High Fashion": "highfashion" };
      const garments = {};
      const unparsed = [];
      for (const e of idx) {
        const m = String(e.name).split(/\s+[–-]\s+/);
        const tier = TIER[m[1]];
        if (m.length !== 2 || !tier) { unparsed.push(e.name); continue; }
        (garments[m[0]] ??= {})[tier] = { id: e._id, cost: Number(e.system?.cost) };
      }
      const names = Object.keys(garments);
      chk("every row of the clothing pack is accounted for by the four printed tiers",
        unparsed.length === 0 && idx.size === 32 && names.length === 8 && names.every(n => Object.keys(garments[n]).length === 4),
        `${idx.size} rows, ${names.length} garments, unparsed: ${unparsed.join(",") || "none"}`);
      const ladder = [];
      for (const n of names) for (const tier of ["leisure", "business", "highfashion"]) {
        const want = garments[n].generic.cost * P.styleMultOf(tier);
        const printed = garments[n][tier].cost;
        ladder.push({ n, tier, want, printed, ok: want === printed });
      }
      chk("the multiplier ladder reproduces every printed tier price in the clothing pack",
        ladder.every(l => l.ok), `${ladder.filter(l => l.ok).length}/${ladder.length} — misses: ${ladder.filter(l => !l.ok).map(l => `${l.n}/${l.tier} want ${l.want} printed ${l.printed}`).join("; ") || "none"}`);

      // ── END TO END: a real catalog row bought at a style, through the path the catalog calls ──
      const JACKET = "BaucUWn5RJZe1GOO";                        // "Jacket – Generic Chic", printed 35eb
      const doc = await pack.getDocument(JACKET);
      const printedCost = Number(doc.system?.cost);
      chk("the fixture row is the pack's plain-tier jacket at its printed price",
        doc.name === "Jacket – Generic Chic" && printedCost === 35, `${doc.name} @ ${printedCost}`);
      chk("the corrections layer leaves this row's price alone, so the printed price IS the base",
        Number(DC.correctedCost("cyberpunk2020.fashion", JACKET, doc.system?.cost)) === printedCost,
        `corrected ${DC.correctedCost("cyberpunk2020.fashion", JACKET, doc.system?.cost)} vs printed ${printedCost}`);

      for (const x of game.actors.filter(x => /^__PW__StyleBuyer/.test(x.name))) await x.delete().catch(() => {});
      buyer = await Actor.create({ name: "__PW__StyleBuyer", type: "character", system: { eurobucks: 1000 } });
      const before = Number(buyer.system.eurobucks);
      await C.purchaseCatalogItem(buyer, "cyberpunk2020.fashion", JACKET, { qty: 1, styleMult: P.styleMultOf("business"), styleLabel: P.styleLabelOf("business") });
      const afterBuy = Number(buyer.system.eurobucks);
      const charged = before - afterBuy;
      chk("BUY PATH: a plain-tier row bought at the business tier charges the printed price x3",
        charged === printedCost * 3 && charged === 105,
        `charged ${charged}eb (${printedCost} x ${P.styleMultOf("business")}), funds ${before} -> ${afterBuy}`);
      chk("BUY PATH: the goods arrive with the charge",
        buyer.items.filter(i => i.name === doc.name).length === 1,
        buyer.items.filter(i => i.name === doc.name).length);
      chk("BUY PATH: the charged figure is the same number the unit-price helper computes",
        charged === P.priceFor(doc, { styleMult: P.styleMultOf("business") }),
        `charged ${charged} vs priceFor ${P.priceFor(doc, { styleMult: P.styleMultOf("business") })}`);
      const afterPlain = await (async () => {
        const f0 = Number(buyer.system.eurobucks);
        await C.purchaseCatalogItem(buyer, "cyberpunk2020.fashion", JACKET, { qty: 1, styleMult: P.styleMultOf("generic"), styleLabel: P.styleLabelOf("generic") });
        return f0 - Number(buyer.system.eurobucks);
      })();
      chk("NEGATIVE BUY PATH: the same row at the plain tier charges the printed price and nothing more",
        afterPlain === printedCost, `charged ${afterPlain}eb`);

      // ── a curated shop's price: catalog cost x style x the shop's discount ────────────────────
      const def = { id: "__pw_style_shop", discountPct: 0, items: { "cyberpunk2020.fashion.BaucUWn5RJZe1GOO": { style: "highfashion", qty: 1 } } };
      const key = "cyberpunk2020.fashion.BaucUWn5RJZe1GOO";
      chk("SHOP PATH: a shop row at the top tier asks the printed price x4",
        SH.effectivePrice(def, key, printedCost, P.styleMultOf("highfashion")) === printedCost * 4,
        `${SH.effectivePrice(def, key, printedCost, P.styleMultOf("highfashion"))}eb for a ${printedCost}eb garment`);
      chk("SHOP PATH: a shop discount applies on top of the style multiplier",
        SH.effectivePrice({ ...def, discountPct: 50 }, key, printedCost, P.styleMultOf("highfashion")) === printedCost * 4 / 2,
        `${SH.effectivePrice({ ...def, discountPct: 50 }, key, printedCost, P.styleMultOf("highfashion"))}eb at -50%`);
      chk("NEGATIVE SHOP PATH: a non-clothing row carries no style multiplier at all",
        SH.effectivePrice(def, key, printedCost, 1) === printedCost,
        `${SH.effectivePrice(def, key, printedCost, 1)}eb`);

      // ── Armor arrives SWITCHED OFF through the buy path (not merely in the pack data) ─────────
      const armorPack = game.packs.get("cyberpunk2020.armor");
      const armorIdx = await armorPack.getIndex({ fields: ["system.cost", "type"] });
      const armorRow = [...armorIdx].find(e => e.type === "armor" && Number(e.system?.cost) > 0 && Number(e.system?.cost) <= 500)
                    ?? [...armorIdx].find(e => e.type === "armor");
      const armorDoc = await armorPack.getDocument(armorRow._id);
      await buyer.update({ "system.eurobucks": 5000 });
      const msgsBefore = new Set(game.messages.contents.map(m => m.id));
      await C.purchaseCatalogItem(buyer, "cyberpunk2020.armor", armorRow._id, { qty: 1 });
      await new Promise(r => setTimeout(r, 600));
      const worn = buyer.items.filter(i => i.name === armorDoc.name);
      const unwornLine = game.i18n.localize("CYBERPUNK.ShopArmorUnworn");
      const receipts = game.messages.contents.filter(m => !msgsBefore.has(m.id));
      chk("BUY PATH: the armor row was actually delivered to the buyer",
        worn.length === 1 && worn[0].type === "armor", `${worn.length} copies of "${armorDoc.name}"`);
      // The buy path is a PASS-THROUGH on the worn flag: it copies the source row and never sets it.
      // (What the source rows themselves carry is a data question, reported separately — the
      // INFORMATIONAL line below counts them.)
      chk("BUY PATH: the delivered copy carries the source row's own worn flag, untouched by the purchase",
        worn[0]?.system?.equipped === armorDoc.system?.equipped,
        `pack row ${JSON.stringify(armorDoc.system?.equipped)} -> delivered ${JSON.stringify(worn[0]?.system?.equipped)}`);
      chk("BUY PATH: the receipt carries the delivered-unworn notice exactly when the delivered copy is unworn",
        receipts.length === 1 && receipts[0].content.includes(unwornLine) === (worn[0]?.system?.equipped === false),
        `${receipts.length} card(s); worn flag ${JSON.stringify(worn[0]?.system?.equipped)}; notice present: ${receipts.some(m => m.content.includes(unwornLine))}`);
      // The same purchase from a source that IS unworn: the goods stay switched off and the buyer is told.
      const msgsBefore1b = new Set(game.messages.contents.map(m => m.id));
      const unwornSrc = { ...armorDoc.toObject(), name: "__PW__UnwornVest" };
      unwornSrc.system = { ...unwornSrc.system, equipped: false };
      await P.buyItem(buyer, unwornSrc, { qty: 1, unitPrice: 10 });
      await new Promise(r => setTimeout(r, 600));
      const unwornCopy = buyer.items.find(i => i.name === "__PW__UnwornVest");
      const unwornReceipts = game.messages.contents.filter(m => !msgsBefore1b.has(m.id));
      chk("BUY PATH: an unworn armor source is delivered still switched off",
        unwornCopy?.system?.equipped === false, JSON.stringify(unwornCopy?.system?.equipped));
      chk("BUY PATH: and its receipt tells the buyer to put it on",
        unwornReceipts.length === 1 && unwornReceipts[0].content.includes(unwornLine),
        `${unwornReceipts.length} card(s); notice: ${unwornReceipts.some(m => m.content.includes(unwornLine))}`);
      const armorEquippedTrue = [...armorIdx].filter(e => e.type === "armor" && e.system?.equipped === true).length;
      console.info(`INFORMATIONAL — armor rows in cyberpunk2020.armor shipping equipped:true: ${armorEquippedTrue}/${[...armorIdx].filter(e => e.type === "armor").length}`);
      const msgsBefore2 = new Set(game.messages.contents.map(m => m.id));
      await C.purchaseCatalogItem(buyer, "cyberpunk2020.fashion", JACKET, { qty: 1 });
      await new Promise(r => setTimeout(r, 600));
      const plainReceipts = game.messages.contents.filter(m => !msgsBefore2.has(m.id));
      chk("NEGATIVE: a non-armor purchase gets no unworn notice",
        plainReceipts.length === 1 && !plainReceipts[0].content.includes(unwornLine),
        `${plainReceipts.length} card(s)`);
      for (const m of [...receipts, ...unwornReceipts, ...plainReceipts]) await m.delete().catch(() => {});

      return { ok: checks.every(c => c.ok), checks };
    } catch (e) {
      checks.push({ label: "money-path leg ran to completion", ok: false, got: e?.message || String(e) });
      return { ok: false, checks };
    } finally {
      try { if (buyer) await buyer.delete(); } catch {}
      try { if (setupWas !== null && setupWas !== SM.isShopSetupMode()) await SM.setShopSetupMode(setupWas); } catch {}
    }
  });
  for (const c of r3.checks || []) log.push(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}  ${c.ok ? "" : "-> got " + c.got}`);

  const noConsoleErr = errors.length === 0;
  log.push(`  ${noConsoleErr ? "PASS" : "FAIL"}  0 console errors  ${noConsoleErr ? "" : "-> " + errors.join(" | ")}`);
  pass = r.ok && r2.ok && r3.ok && noConsoleErr && !log.some(l => l.startsWith("PAGEERR"));
} catch (e) { log.push("ERROR " + (e?.message || e)); }
finally { await b.close(); }

console.log(log.join("\n"));
console.log(pass ? "\nRESULT: PASS" : "\nRESULT: FAIL");
process.exit(pass ? 0 : 1);
