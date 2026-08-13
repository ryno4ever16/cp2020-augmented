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
      for (let i = 0; i < 200 && !(w.element?.querySelectorAll(".cp-catalog-row").length); i++) await sleep(50);
      const rowCount = w.element.querySelectorAll(".cp-catalog-row").length;
      chk("catalog painted its rows", rowCount > 100, rowCount);

      // Row paint diet: the two properties that keep a list this size cheap.
      const firstRow = w.element.querySelector(".cp-catalog-row");
      const firstImg = w.element.querySelector(".cp-catalog-row img");
      chk("rows are skipped while off-screen", getComputedStyle(firstRow).contentVisibility === "auto", getComputedStyle(firstRow).contentVisibility);
      chk("rows reserve a measured height", /36px/.test(getComputedStyle(firstRow).containIntrinsicSize), getComputedStyle(firstRow).containIntrinsicSize);
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

  const noConsoleErr = errors.length === 0;
  log.push(`  ${noConsoleErr ? "PASS" : "FAIL"}  0 console errors  ${noConsoleErr ? "" : "-> " + errors.join(" | ")}`);
  pass = r.ok && r2.ok && noConsoleErr && !log.some(l => l.startsWith("PAGEERR"));
} catch (e) { log.push("ERROR " + (e?.message || e)); }
finally { await b.close(); }

console.log(log.join("\n"));
console.log(pass ? "\nRESULT: PASS" : "\nRESULT: FAIL");
process.exit(pass ? 0 : 1);
