/** Shop UX pair — per-row dropdown persistence + GM setup mode.
 *  (a) The ammo LOAD and clothing STYLE selects used to reset to their default option on every buy,
 *      because a buy ends in a re-render and the template emits both at their default. This drives the
 *      REAL gestures (change on the select, click on Buy) and asserts the visible outcome survives the
 *      re-render — then that closing and reopening the window is a clean counter again.
 *  (b) GM setup mode: free, silent, shelf-preserving acquisitions on the GM's client ONLY. Asserts the
 *      money, the stock and the chat-message COUNT on both sides of the toggle, that the goods are
 *      still real (compendium provenance kept, so corrections still fire), and — with a second browser
 *      context joined as a player — that the player never sees the control and keeps paying while the
 *      GM's mode is on.
 *  All fixtures are __PW__-prefixed and deleted at the end; the standing Test-PC fixture's funds are
 *  snapshotted and restored. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
/** Join as `who`, trying each password in turn. The :30004 player fixture account has no password;
 *  on other rigs (:30003 was the proof) the same account carries the rig password — and a User.update
 *  with password:"" does NOT clear it, core ignores a blank. A wrong password is refused at the form
 *  and the page never reaches `game.ready`, so each candidate gets its own bounded wait. */
async function join(p, who, pw = PW){const pws = pw === "" ? ["", PW] : [pw];for (const cand of pws) {await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>new RegExp(who,"i").test(u.l))||us[0];await s.selectOption(g.v);await p.locator('input[name="password"]').fill(cand);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);try {await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:cand===pws[pws.length-1]?60000:20000});return;} catch (e) {if (cand === pws[pws.length-1]) throw e;}}}

const b = await chromium.launch({ headless: true });
const gmCtx = await b.newContext({ viewport: { width: 1600, height: 1100 } });
const p = await gmCtx.newPage();
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await join(p, "gamemaster");

// ── Phase 1: everything that happens on the GM's own client ───────────────────────────────────────
const r1 = await p.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(120); } return false; };
  const out = { checks: [], fails: [], probeActorId: null, shopId: null, playerActorId: null, playerUserName: null };
  const check = (n, ok, got) => { out.checks.push(`${ok?"  PASS":"  FAIL"}  ${n}${ok?"":"  got="+JSON.stringify(got)}`); if(!ok) out.fails.push(n); };
  const SCOPE = "cp2020-augmented";

  // The catalog opens straight onto its item list — no front page — so the first wait is just for
  // the rows, which still earns its keep because a first open sits behind the catalog-index build.
  // The generated caliber rows this section is about are the ONE thing the opening category set
  // leaves out, so the Ammo chip is switched on: that chip is the shipped route to them. Pressed
  // against the window's untouched default set it REPLACES that set, so what this lands on is the
  // caliber rows alone — which is exactly this section's subject. Done per window, because every
  // reopen builds the default set fresh.
  const intoAmmoRows = async (win, marker) => {
    await waitFor(() => win.rendered && win.element?.querySelector(".cp-catalog-row"), 40000);
    win.element?.querySelector('.cp-cat-chip[data-cat="Ammo"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => win.element?.querySelector(marker), 30000);
  };
  const CAT = await import("/modules/cp2020-augmented/module/shop/catalog.js");
  const SETUP = await import("/modules/cp2020-augmented/module/shop/setup-mode.js");
  const PURCH = await import("/modules/cp2020-augmented/module/shop/purchase.js");
  const SHOPS = await import("/modules/cp2020-augmented/module/shop/shops.js");

  try {
    window.__pwBefore = new Set(game.messages.map(m => m.id));   // cleanup sweeps every message this run posts
    SETUP.setShopSetupMode(false);
    for (const w of [...foundry.applications.instances.values()]) if (w instanceof CAT.CatalogBrowser) await w.close();

    const buyer = await Actor.create({ name: "__PW__ShopProbe", type: "npc", system: { eurobucks: 100000 } });
    out.probeActorId = buyer.id;

    // The player-side isolation probe needs an actor a NON-GM owns. Built here rather than borrowing a
    // standing rig fixture — the fixture set moves between sessions, and a keeper that silently skips
    // its most important leg because a fixture was renamed is worse than one that owns its own.
    // ⚠ Must be the SAME user the second browser context joins as — this rig has more than one non-GM
    // ("Bitter" and "Test User 1"), and granting ownership to whichever came first in the collection is
    // how this leg first failed: the actor existed, the player just did not own it.
    const player = game.users.find(u => !u.isGM && /test user 1/i.test(u.name)) ?? game.users.find(u => !u.isGM);
    out.playerUserName = player?.name ?? null;
    check("a non-GM user exists on this rig for the isolation probe", !!player, game.users.map(u => u.name));
    if (player) {
      const pa = await Actor.create({
        name: "__PW__PlayerBuyer", type: "npc",
        ownership: { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
        system: { eurobucks: 5000 },
      });
      out.playerActorId = pa.id;
    }

    // ── (a) Per-row dropdown persistence ──────────────────────────────────────────────────────────
    let win = CAT.openShopWindow(buyer, { view: "catalog" });
    await intoAmmoRows(win, ".cp-catalog-row[data-ammo-caliber]");
    const ammoRow = () => win.element.querySelector(".cp-catalog-row[data-ammo-caliber]");
    check("catalog rendered with generated ammo rows", !!ammoRow(), null);

    const caliber = ammoRow().dataset.ammoCaliber;
    const sel0 = ammoRow().querySelector(".cp-catalog-ammo-load");
    const defaultLoad = sel0.options[0].value;
    const pick = [...sel0.options].map(o => o.value).find(v => v !== defaultLoad);
    check("the ammo row offers a NON-default load to pick", !!pick, [...sel0.options].map(o => o.value));
    const priceAtDefault = ammoRow().querySelector(".cp-cat-price b")?.textContent;

    // The real gesture: set the value and dispatch the change the UI listens for.
    sel0.value = pick;
    sel0.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(150);
    check(`picking a non-default load re-prices the row live (${defaultLoad} → ${pick})`,
      ammoRow().querySelector(".cp-cat-price b")?.textContent !== priceAtDefault,
      { was: priceAtDefault, now: ammoRow().querySelector(".cp-cat-price b")?.textContent });

    // Buy it — this is the re-render that used to wipe the pick.
    const msgsBeforeBuy = game.messages.size;
    ammoRow().querySelector(".cp-catalog-buy").click();
    await waitFor(() => (buyer.itemTypes.ammo ?? []).length > 0, 20000);
    await sleep(700);                                    // let the post-buy render settle
    check("the ammo was actually bought", (buyer.itemTypes.ammo ?? []).length > 0, buyer.itemTypes.ammo?.length);
    const selAfter = ammoRow()?.querySelector(".cp-catalog-ammo-load");
    check("⭐ the load pick SURVIVES the post-purchase re-render", selAfter?.value === pick, { want: pick, got: selAfter?.value });
    check("the row's price still matches the surviving pick",
      ammoRow().querySelector(".cp-cat-price b")?.textContent !== priceAtDefault, ammoRow().querySelector(".cp-cat-price b")?.textContent);

    // And it survives an unrelated re-render (a category filter click), not just the buy's.
    win.render();
    await sleep(600);
    check("the load pick survives an unrelated re-render too",
      ammoRow()?.querySelector(".cp-catalog-ammo-load")?.value === pick,
      ammoRow()?.querySelector(".cp-catalog-ammo-load")?.value);
    check("the bought ammo carries the load that was picked, not the default",
      (buyer.itemTypes.ammo ?? []).some(a => (a.system?.modifier ?? "standard") === pick),
      (buyer.itemTypes.ammo ?? []).map(a => a.system?.modifier));

    // Close / reopen = a fresh counter.
    await win.close();
    await sleep(300);
    win = CAT.openShopWindow(buyer, { view: "catalog" });
    await intoAmmoRows(win, `.cp-catalog-row[data-ammo-caliber="${caliber}"]`);
    const reopened = win.element.querySelector(`.cp-catalog-row[data-ammo-caliber="${caliber}"] .cp-catalog-ammo-load`);
    check("closing and reopening the window RESETS the row to its default load",
      reopened?.value === defaultLoad, { want: defaultLoad, got: reopened?.value });

    // ── (b) GM setup mode ─────────────────────────────────────────────────────────────────────────
    check("the GM sees the setup-mode toggle in the catalog header",
      !!win.element.querySelector(".cp-shop-setup-toggle"), null);
    check("the toggle is idle (not lit) before it is pressed",
      !win.element.querySelector(".cp-shop-setup-toggle").classList.contains("cp-active"), null);
    check("no setup banner while the mode is off", !win.element.querySelector(".cp-shop-setup-banner"), null);

    // A real, priced compendium item to buy on both sides of the toggle.
    const doc = await game.packs.get("cyberpunk2020.armor")?.getDocuments()
      .then(ds => ds.find(d => Number(d.system?.cost) > 0));
    check("a priced probe item was resolved from a base pack", !!doc, doc?.name);

    // --- OFF: normal charging + a chat card ---
    const fundsBefore = Number(buyer.system.eurobucks);
    const msgsBefore = game.messages.size;
    await PURCH.buyItem(buyer, doc, { qty: 1, unitPrice: 500 });
    await sleep(400);
    check("mode OFF ⇒ eurobucks are charged (500)",
      Number(buyer.system.eurobucks) === fundsBefore - 500, { before: fundsBefore, now: buyer.system.eurobucks });
    check("mode OFF ⇒ a purchase chat card is posted (exactly 1)",
      game.messages.size === msgsBefore + 1, { before: msgsBefore, now: game.messages.size });

    // --- ON: free, silent, and the goods are still real ---
    win.element.querySelector(".cp-shop-setup-toggle").click();
    await sleep(500);
    check("clicking the toggle turns setup mode ON", SETUP.isShopSetupMode() === true, SETUP.isShopSetupMode());
    check("the lit toggle carries .cp-active (a class, not a computed colour)",
      win.element.querySelector(".cp-shop-setup-toggle")?.classList.contains("cp-active"), null);
    check("a standing banner says the mode is on", !!win.element.querySelector(".cp-shop-setup-banner"), null);

    const fundsOn = Number(buyer.system.eurobucks);
    const msgsOn = game.messages.size;
    const itemsOn = buyer.items.size;
    await PURCH.buyItem(buyer, doc, { qty: 1, unitPrice: 500 });
    await sleep(400);
    check("⭐ mode ON ⇒ eurobucks are UNTOUCHED",
      Number(buyer.system.eurobucks) === fundsOn, { before: fundsOn, now: buyer.system.eurobucks });
    check("⭐ mode ON ⇒ ZERO new chat messages", game.messages.size === msgsOn, { before: msgsOn, now: game.messages.size });
    check("mode ON ⇒ the item was still really granted", buyer.items.size === itemsOn + 1, { before: itemsOn, now: buyer.items.size });
    const granted = buyer.items.contents[buyer.items.size - 1];
    check("the free copy keeps its compendium provenance (corrections still fire)",
      !!granted?._stats?.compendiumSource, granted?._stats?.compendiumSource ?? null);

    // --- ON: a shop's shelves are not touched ---
    const shop = await SHOPS.createShop({ name: "__PW__SetupShop" });
    out.shopId = shop.id;
    const sourceKey = `cyberpunk2020.armor.${doc.id}`;
    await SHOPS.addShopItem(shop.id, sourceKey);
    await SHOPS.setShopItem(shop.id, sourceKey, { qty: 5, unlimited: false });
    const qtyBefore = SHOPS.getShop(shop.id).items[sourceKey].qty;
    check("probe shop stocked with a limited quantity (5)", qtyBefore === 5, qtyBefore);
    await CAT.purchaseShopItem(buyer, shop.id, sourceKey, { qty: 1 });
    await sleep(500);
    check("⭐ mode ON ⇒ shop stock is NOT decremented",
      SHOPS.getShop(shop.id).items[sourceKey].qty === 5, SHOPS.getShop(shop.id).items[sourceKey].qty);

    // --- back OFF: everything charges again ---
    win.element.querySelector(".cp-shop-setup-toggle").click();
    await sleep(500);
    check("clicking again turns setup mode OFF", SETUP.isShopSetupMode() === false, SETUP.isShopSetupMode());
    const fundsOff = Number(buyer.system.eurobucks);
    const msgsOff = game.messages.size;
    await CAT.purchaseShopItem(buyer, shop.id, sourceKey, { qty: 1 });
    await sleep(700);
    check("mode OFF ⇒ shop stock decrements again (5 → 4)",
      SHOPS.getShop(shop.id).items[sourceKey].qty === 4, SHOPS.getShop(shop.id).items[sourceKey].qty);
    check("mode OFF ⇒ eurobucks are charged again", Number(buyer.system.eurobucks) < fundsOff,
      { before: fundsOff, now: buyer.system.eurobucks });
    check("mode OFF ⇒ the chat card is back", game.messages.size > msgsOff, { before: msgsOff, now: game.messages.size });

    // ── (c) setup mode and an UNPRICED catalog item, bought by the GM ─────────────────────────────
    // Off: the item is routed to a price request (needsPrice) and nothing is delivered. On: the GM's
    // own furnishing call delivers it free, with no request card and no chat message.
    const UNP_PACK = "cp2020-augmented.supplement-armor", UNP_ID = "QIwkOGgOYsByn1gA";
    out.unp = { packId: UNP_PACK, id: UNP_ID };
    const idx = await CAT.getCatalogIndex();
    const unpRow = idx.find(r => r.packId === UNP_PACK && r.id === UNP_ID);
    check("fixture: the unpriced probe row is in the catalog index with unpriced = true",
      unpRow?.unpriced === true, unpRow ? { unpriced: unpRow.unpriced, cost: unpRow.cost, name: unpRow.name } : null);
    const overrides0 = game.settings.get(SCOPE, "shopPriceOverrides") ?? {};
    out.prevOverrides = foundry.utils.deepClone(overrides0);
    check("fixture: no GM price override stands for the unpriced probe", overrides0[UNP_ID] === undefined, overrides0[UNP_ID]);
    const unpCount = () => buyer.items.filter(i => String(i._stats?.compendiumSource ?? "").includes(UNP_ID)).length;
    const newMsgs = (before) => [...game.messages].filter(m => !before.has(m.id));

    SETUP.setShopSetupMode(false);
    {
      const before = new Set(game.messages.map(m => m.id));
      const f0 = Number(buyer.system.eurobucks), n0 = unpCount();
      const r = await CAT.purchaseCatalogItem(buyer, UNP_PACK, UNP_ID);
      await sleep(700);
      const reqs = newMsgs(before).filter(m => m.getFlag(SCOPE, "purchaseRequest"));
      check("setup OFF ⇒ unpriced buy returns reason 'requested'", r?.reason === "requested", r);
      check("setup OFF ⇒ exactly one request card, flag needsPrice = true",
        reqs.length === 1 && reqs[0].getFlag(SCOPE, "purchaseRequest").needsPrice === true,
        reqs.map(m => m.getFlag(SCOPE, "purchaseRequest")?.needsPrice));
      check("setup OFF ⇒ nothing delivered", unpCount() === n0, { before: n0, now: unpCount() });
      check("setup OFF ⇒ funds unchanged", Number(buyer.system.eurobucks) === f0, { before: f0, now: buyer.system.eurobucks });
      for (const m of reqs) await m.delete().catch(() => {});
    }
    SETUP.setShopSetupMode(true);
    {
      const before = new Set(game.messages.map(m => m.id));
      const f0 = Number(buyer.system.eurobucks), n0 = unpCount();
      const r = await CAT.purchaseCatalogItem(buyer, UNP_PACK, UNP_ID);
      await sleep(700);
      const fresh = newMsgs(before);
      check("⭐ setup ON ⇒ unpriced buy returns {ok:true}", r?.ok === true, r);
      check("⭐ setup ON ⇒ the unpriced item is delivered (+1) with funds unchanged",
        unpCount() === n0 + 1 && Number(buyer.system.eurobucks) === f0,
        { itemsBefore: n0, itemsNow: unpCount(), fundsBefore: f0, fundsNow: buyer.system.eurobucks });
      check("⭐ setup ON ⇒ no request card", fresh.filter(m => m.getFlag(SCOPE, "purchaseRequest")).length === 0,
        fresh.map(m => m.getFlag(SCOPE, "purchaseRequest")?.needsPrice ?? "-"));
      check("setup ON ⇒ zero new chat messages", fresh.length === 0, fresh.length);
      check("setup ON ⇒ no price override was written", (game.settings.get(SCOPE, "shopPriceOverrides") ?? {})[UNP_ID] === undefined,
        (game.settings.get(SCOPE, "shopPriceOverrides") ?? {})[UNP_ID]);
    }
    SETUP.setShopSetupMode(false);

    // Phase 2/3 inputs: a priced armor row for the player's ordinary request, and approvals switched on.
    const priced = idx.find(r => r.packId === "cyberpunk2020.armor" && !r.unpriced && !r.priceRange && r.cost > 0 && r.cost <= 1500);
    check("fixture: a priced armor row (≤ 1500eb) for the player's request", !!priced, priced?.name);
    out.priced = priced ? { packId: priced.packId, id: priced.id, cost: priced.cost } : null;
    out.prevSource = game.settings.get(SCOPE, "shopBuySource");
    await game.settings.set(SCOPE, "shopBuySource", "shops");

    // --- it does not survive a reload, by construction ---
    SETUP.setShopSetupMode(true);
    check("setup mode is in-memory only (no world/client setting was registered for it)",
      !game.settings.settings.has(`${SCOPE}.shopSetupMode`), null);
    SETUP.setShopSetupMode(true);            // leave it ON for the player-side isolation phase

    await win.close();
  } catch (e) {
    check("keeper phase 1 ran without throwing", false, String(e?.stack ?? e));
  }
  return out;
});

// ── Phase 2: a player client, while the GM's setup mode is ON ─────────────────────────────────────
const playerCtx = await b.newContext({ viewport: { width: 1400, height: 900 } });
const pp = await playerCtx.newPage();
// Join as exactly the user phase 1 gave the probe actor to. Error listeners attach AFTER the join:
// the helper probes candidate passwords, and a refused candidate logs a 401 + "Invalid password"
// console error that is the harness's own doing, not the module behavior this suite counts.
await join(pp, r1.playerUserName ?? "test user 1", "");
pp.on("pageerror", e => errors.push("player pageerror: " + e.message));
pp.on("console", m => { if (m.type() === "error") errors.push("player console: " + m.text()); });

const r2 = await pp.evaluate(async ({ playerActorId, priced, unp }) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(120); } return false; };
  const out = { checks: [], fails: [], restoreFunds: null, actorId: null };
  const check = (n, ok, got) => { out.checks.push(`${ok?"  PASS":"  FAIL"}  ${n}${ok?"":"  got="+JSON.stringify(got)}`); if(!ok) out.fails.push(n); };

  const CAT = await import("/modules/cp2020-augmented/module/shop/catalog.js");
  const SETUP = await import("/modules/cp2020-augmented/module/shop/setup-mode.js");
  const PURCH = await import("/modules/cp2020-augmented/module/shop/purchase.js");

  try {
    check("this client is NOT a GM (the isolation probe is meaningful)", game.user.isGM === false, game.user.isGM);
    check("⭐ setup mode reads FALSE on a player client while the GM's is on",
      SETUP.isShopSetupMode() === false, SETUP.isShopSetupMode());
    // Even set directly — a stale UI or a console call must not make a player's own buys free.
    SETUP.setShopSetupMode(true);
    check("⭐ a player cannot switch setup mode on for themselves",
      SETUP.isShopSetupMode() === false, SETUP.isShopSetupMode());

    const buyer = game.actors.get(playerActorId);
    check("the player owns the probe actor built for them", !!buyer && buyer.isOwner === true,
      { found: !!buyer, isOwner: buyer?.isOwner });
    out.actorId = buyer?.id ?? null;

    const win = CAT.openShopWindow(buyer, { view: "catalog" });
    await waitFor(() => win.rendered && win.element?.querySelector(".cp-catalog-row"), 40000);
    check("⭐ the player's shop shows NO setup-mode toggle",
      !win.element.querySelector(".cp-shop-setup-toggle"), null);
    check("the player's shop shows no setup banner either",
      !win.element.querySelector(".cp-shop-setup-banner"), null);

    const doc = await game.packs.get("cyberpunk2020.armor")?.getDocuments()
      .then(ds => ds.find(d => Number(d.system?.cost) > 0));
    const before = Number(buyer.system.eurobucks);
    await PURCH.buyItem(buyer, doc, { qty: 1, unitPrice: 250 });
    await sleep(600);
    check("⭐ the player is CHARGED normally while the GM's setup mode is on",
      Number(buyer.system.eurobucks) === before - 250, { before, now: buyer.system.eurobucks });

    await win.close();

    // Two catalog buys that need the GM's approval (shopBuySource = "shops"): one priced, one unpriced.
    // The GM approves both in phase 3 with setup mode still ON; neither may become free.
    const f0 = Number(buyer.system.eurobucks);
    const rq1 = priced ? await CAT.purchaseCatalogItem(buyer, priced.packId, priced.id, { qty: 1 }) : null;
    const rq2 = unp ? await CAT.purchaseCatalogItem(buyer, unp.packId, unp.id, { qty: 1 }) : null;
    await sleep(600);
    check("player's priced catalog buy became a request", rq1?.reason === "requested", rq1);
    check("player's unpriced catalog buy became a price request", rq2?.reason === "requested", rq2);
    check("requests charged nothing yet", Number(buyer.system.eurobucks) === f0, { before: f0, now: buyer.system.eurobucks });
    out.fundsBeforeApproval = Number(buyer.system.eurobucks);
    out.requesterId = game.user.id;
  } catch (e) {
    check("keeper phase 2 ran without throwing", false, String(e?.stack ?? e));
  }
  return out;
}, { playerActorId: r1.playerActorId, priced: r1.priced ?? null, unp: r1.unp ?? null });

// ── Phase 3: the GM approves the player's two requests by clicking the cards, setup mode still ON ──
const r3 = await p.evaluate(async ({ playerActorId, priced, unp, requesterId, fundsBeforeApproval }) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = { checks: [], fails: [] };
  const check = (n, ok, got) => { out.checks.push(`${ok?"  PASS":"  FAIL"}  ${n}${ok?"":"  got="+JSON.stringify(got)}`); if(!ok) out.fails.push(n); };
  const SCOPE = "cp2020-augmented";
  const SETUP = await import("/modules/cp2020-augmented/module/shop/setup-mode.js");
  try {
    check("GM setup mode reads ON while approving", SETUP.isShopSetupMode() === true, SETUP.isShopSetupMode());
    const buyer = game.actors.get(playerActorId);
    const pending = () => [...game.messages].filter(m => {
      const q = m.getFlag(SCOPE, "purchaseRequest");
      return q && q.status === "pending" && q.requesterId === requesterId && q.buyerId === playerActorId;
    });
    const t0 = Date.now();
    while (pending().length < 2 && Date.now() - t0 < 10000) await sleep(150);
    const reqs = pending();
    const pricedReq = reqs.find(m => m.getFlag(SCOPE, "purchaseRequest").itemId === priced?.id);
    const unpReq = reqs.find(m => m.getFlag(SCOPE, "purchaseRequest").itemId === unp?.id);
    check("both player requests reached the GM (priced + needsPrice)",
      !!pricedReq && unpReq?.getFlag(SCOPE, "purchaseRequest").needsPrice === true, reqs.map(m => m.getFlag(SCOPE, "purchaseRequest")));
    const has = (id) => buyer.items.filter(i => String(i._stats?.compendiumSource ?? "").includes(id)).length;
    const clickApprove = async (msg, price) => {
      const sel = `[data-message-id="${msg.id}"] .cp-shop-request-btn[data-action="approve"]`;
      const t = Date.now();
      while (!document.querySelector(sel) && Date.now() - t < 10000) await sleep(120);
      const el = [...document.querySelectorAll(sel)].pop();
      if (!el) return false;
      if (price != null) {
        const inp = el.closest(".cp-shop-request")?.querySelector(".cp-shop-request-price");
        if (inp) { inp.value = String(price); inp.dispatchEvent(new Event("input", { bubbles: true })); }
      }
      el.click();
      const t1 = Date.now();
      while (game.messages.get(msg.id)?.getFlag(SCOPE, "purchaseRequest")?.status === "pending" && Date.now() - t1 < 10000) await sleep(120);
      await sleep(1200);
      return true;
    };
    if (pricedReq) {
      const n0 = has(priced.id);
      check("approve control clicked on the priced request", await clickApprove(pricedReq), null);
      check("priced request status = approved", game.messages.get(pricedReq.id)?.getFlag(SCOPE, "purchaseRequest")?.status === "approved",
        game.messages.get(pricedReq.id)?.getFlag(SCOPE, "purchaseRequest")?.status);
      check("⭐ approved request under setup mode delivers the item", has(priced.id) === n0 + 1, { before: n0, now: has(priced.id) });
      check(`⭐ approved request under setup mode CHARGES the buyer (−${priced.cost})`,
        Number(buyer.system.eurobucks) === fundsBeforeApproval - priced.cost, { before: fundsBeforeApproval, now: buyer.system.eurobucks });
    }
    if (unpReq) {
      const PRICE = 300;
      const f0 = Number(buyer.system.eurobucks), n0 = has(unp.id);
      check("approve control clicked on the needsPrice request (price 300 entered)", await clickApprove(unpReq, PRICE), null);
      check("needsPrice request status = approved", game.messages.get(unpReq.id)?.getFlag(SCOPE, "purchaseRequest")?.status === "approved",
        game.messages.get(unpReq.id)?.getFlag(SCOPE, "purchaseRequest")?.status);
      check("⭐ approved unpriced request under setup mode delivers the item", has(unp.id) === n0 + 1, { before: n0, now: has(unp.id) });
      check(`⭐ approved unpriced request under setup mode CHARGES the GM-set price (−${PRICE})`,
        Number(buyer.system.eurobucks) === f0 - PRICE, { before: f0, now: buyer.system.eurobucks });
    }
  } catch (e) {
    check("keeper phase 3 ran without throwing", false, String(e?.stack ?? e));
  }
  return out;
}, { playerActorId: r1.playerActorId, priced: r1.priced ?? null, unp: r1.unp ?? null, requesterId: r2.requesterId ?? null, fundsBeforeApproval: r2.fundsBeforeApproval ?? 0 });

// ── Cleanup, on the GM client ─────────────────────────────────────────────────────────────────────
await p.evaluate(async ({ probeActorId, shopId, playerActorId, prevSource, prevOverrides }) => {
  const SCOPE = "cp2020-augmented";
  const SETUP = await import("/modules/cp2020-augmented/module/shop/setup-mode.js");
  const SHOPS = await import("/modules/cp2020-augmented/module/shop/shops.js");
  SETUP.setShopSetupMode(false);
  try { if (prevSource != null) await game.settings.set(SCOPE, "shopBuySource", prevSource); } catch {}
  try { if (prevOverrides != null) await game.settings.set(SCOPE, "shopPriceOverrides", prevOverrides); } catch {}
  try {
    const stray = [...game.messages].filter(m => !window.__pwBefore?.has(m.id)).map(m => m.id);
    if (window.__pwBefore && stray.length) await ChatMessage.deleteDocuments(stray);
  } catch {}
  try { await game.actors.get(probeActorId)?.delete(); } catch {}
  try { await game.actors.get(playerActorId)?.delete(); } catch {}
  try { if (shopId) await SHOPS.deleteShop(shopId); } catch {}
}, { probeActorId: r1.probeActorId, shopId: r1.shopId, playerActorId: r1.playerActorId, prevSource: r1.prevSource ?? null, prevOverrides: r1.prevOverrides ?? null });

for (const line of r1.checks) console.log(line);
console.log("  ── player client ──");
for (const line of r2.checks) console.log(line);
console.log("  ── GM approves the player's requests (setup mode ON) ──");
for (const line of r3.checks) console.log(line);
const consoleFails = errors.length;
console.log(consoleFails ? `  FAIL  0 console errors  got=${JSON.stringify(errors.slice(0, 6))}` : "  PASS  0 console errors");
const total = r1.checks.length + r2.checks.length + r3.checks.length + 1;
const failed = r1.fails.length + r2.fails.length + r3.fails.length + (consoleFails ? 1 : 0);
console.log(`\n${total - failed}/${total} passed`);
await b.close();
process.exit(failed ? 1 : 0);
