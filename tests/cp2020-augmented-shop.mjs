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
  const noConsoleErr = errors.length === 0;
  log.push(`  ${noConsoleErr ? "PASS" : "FAIL"}  0 console errors  ${noConsoleErr ? "" : "-> " + errors.join(" | ")}`);
  pass = r.ok && noConsoleErr && !log.some(l => l.startsWith("PAGEERR"));
} catch (e) { log.push("ERROR " + (e?.message || e)); }
finally { await b.close(); }

console.log(log.join("\n"));
console.log(pass ? "\nRESULT: PASS" : "\nRESULT: FAIL");
process.exit(pass ? 0 : 1);
