/** A chip is SLOTTED, not implanted (user ruling 2026-10-05): it never goes through the install flow.
 *   §1 the rule itself: a pack chip is a slotted chip, the socket hardware filed beside the chips is not
 *   §2 GM, catalog Buy button on a chip: no install dialog, delivered unslotted, billed its price, the
 *      chip receipt posted; the hardware beside it still opens the install dialog (negative)
 *   §3 a chip row dropped on a sheet takes the ordinary confirm (no quantity field), then the same buy;
 *      the hardware row still goes straight to the install dialog (negative)
 *   §4 on the sheet: a chip dropped on an installed socket's row nests with no dialog and no request;
 *      a chip's own sheet offers "Slot chip" (a click slots and switches it on), the hardware's sheet
 *      still offers Install (Surgery) and opens the dialog (negative)
 *   §5 a player with approvals on: buying a chip asks them nothing, the request carries no install
 *      answers, the GM's Approve delivers it unslotted and asks the GM nothing; the hardware still asks
 *      the player first (negative)
 *   §6 0 console errors on both sessions
 *  Fixtures are __PW__-prefixed and deleted in the finally; the approvals setting is restored. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";
async function join(p, who, pw = PW){const pws = pw === "" ? ["", PW] : [pw];for (const cand of pws) {await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>new RegExp(who,"i").test(u.l))||us[0];await s.selectOption(g.v);await p.locator('input[name="password"]').fill(cand);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);try {await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:cand===pws[pws.length-1]?60000:20000});return;} catch (e) {if (cand === pws[pws.length-1]) throw e;}}}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, got) => { if (ok) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}  got=${JSON.stringify(got)}`); } };

/** Page-side helpers on `window.__pw`. `dlg(kind)`: "install" = the install dialog (it carries the
 *  rollHumanity box); "confirm" = the drop Buy/Cancel confirm (a buy button, no rollHumanity box). */
async function installHelpers(page) {
  await page.evaluate(async (SCOPE) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitFor = async (fn, ms = 40000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); } return false; };
    const CAT = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    const INST = await import(`/modules/${SCOPE}/module/cyberware/install.js`);
    const all = () => [...foundry.applications.instances.values()].filter(a => a instanceof foundry.applications.api.DialogV2 && a.rendered && a.element);
    const dlg = (kind) => all().filter(a => {
      const install = !!a.element.querySelector('[name="rollHumanity"]');
      const confirm = !install && !!a.element.querySelector('.window-content button[data-action="buy"]');
      return kind === "install" ? install : kind === "confirm" ? confirm : (install || confirm);
    });
    // Did a dialog of `kind` appear within `ms`? Reads it, then presses `press` (default: leave it).
    const sawDialog = async (kind, ms = 1800, press = null) => {
      const seen = await waitFor(() => dlg(kind).length > 0, ms);
      if (!seen) return null;
      const el = dlg(kind).pop().element;
      const out = { text: (el.querySelector(".dialog-content")?.textContent ?? "").replace(/\s+/g, " ").trim(), hasQty: !!el.querySelector('input[name="qty"]') };
      if (press) { el.querySelector(`button[data-action="${press}"]`)?.click(); await waitFor(() => dlg(kind).length === 0, 5000); await sleep(700); }
      return out;
    };
    const closeAllDialogs = async () => { for (const a of all()) { try { await a.close(); } catch { /* gone */ } } await sleep(200); };
    const shopWins = () => [...foundry.applications.instances.values()].filter(w => w instanceof CAT.CatalogBrowser);
    const chipsOn = (actor, name) => actor.items.filter(i => i.type === "cyberware" && i.name === name);
    window.__pw = { sleep, waitFor, CAT, INST, dlg, sawDialog, closeAllDialogs, shopWins, chipsOn };
  }, SCOPE);
}
/** Type a name into the catalog's search box (the real input event) and wait for that item's row. */
async function searchRow(page, name, itemId) {
  return page.evaluate(async ({ name, itemId }) => {
    const { shopWins, waitFor, sleep } = window.__pw; const w = shopWins()[0];
    const box = w.element.querySelector(".cp-catalog-search");
    box.value = name; box.dispatchEvent(new Event("input", { bubbles: true }));
    const ok = await waitFor(() => w.element.querySelector(`.cp-catalog-row[data-item-id="${itemId}"]`), 15000);
    await sleep(300);
    return ok;
  }, { name, itemId });
}

const b = await chromium.launch({ headless: true });
const VIEW = { width: 1920, height: 1100 };
const gmCtx = await b.newContext({ viewport: VIEW });
const gm = await gmCtx.newPage();
const errors = [], pcErrors = [];
gm.on("pageerror", e => errors.push("pageerror: " + e.message));
gm.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
let pc = null, S = {};

try {
  await join(gm, "gamemaster");
  await installHelpers(gm);

  S = await gm.evaluate(async (SCOPE) => {
    const { CAT, INST, sleep, waitFor, shopWins, closeAllDialogs } = window.__pw;
    const SETUP = await import(`/modules/${SCOPE}/module/shop/setup-mode.js`);
    SETUP.setShopSetupMode(false);
    await closeAllDialogs();
    for (const w of shopWins()) await w.close();
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__Chip"))) await a.delete().catch(() => {});
    window.__pwBase = new Set(game.messages.map(m => m.id));     // the run's baseline (cleanup sweeps past it)
    window.__pwBefore = new Set(window.__pwBase);                 // the current section's baseline
    const out = { prevSource: game.settings.get(SCOPE, "shopBuySource") };
    const has = (d, t) => { const c = d.system?.CyberWorkType ?? {}; return (Array.isArray(c.Types) ? c.Types : []).includes(t) || c.Type === t; };
    const docs = await game.packs.get(`${SCOPE}.supplement-chipware`).getDocuments();
    const chip = docs.filter(d => has(d, "Chip") && Number(d.system?.cost) > 0 && /cyberpunk 2020/i.test(d.system?.source ?? "")).sort((a, b) => a.name.localeCompare(b.name))[0];
    const rack = docs.find(d => !has(d, "Chip") && /moddy rack/i.test(d.name)) ?? docs.find(d => !has(d, "Chip"));
    out.chip = { packId: chip.pack, itemId: chip.id, name: chip.name, cost: Number(chip.system.cost) };
    out.rack = { packId: rack.pack, itemId: rack.id, name: rack.name, cost: Number(rack.system?.cost) || 0 };
    out.pure = typeof INST.isSlottedChip === "function" ? {
      chip: INST.isSlottedChip(chip), rack: INST.isSlottedChip(rack),
      chipNeeds: INST.needsInstallSurgery({ type: "cyberware", system: chip.toObject().system, flags: {} }),
      rackNeeds: INST.needsInstallSurgery({ type: "cyberware", system: { ...rack.toObject().system, equipped: false, humanityLoss: 0 }, flags: {} }),
    } : null;
    const player = game.users.find(u => !u.isGM && /test user 1/i.test(u.name)) ?? game.users.find(u => !u.isGM);
    out.playerName = player?.name ?? null;
    const A = await Actor.create({ name: "__PW__Chip A", type: "character", system: { eurobucks: 20000 } });
    const P = await Actor.create({ name: "__PW__Chip P", type: "character", system: { eurobucks: 20000 },
      ownership: player ? { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER } : {} });
    out.A = A.id; out.P = P.id;
    // The real base-pack chipware socket, installed, so the corrections that let it hold chips fire.
    const sockDoc = await game.packs.get("cyberpunk2020.neuralware").getDocument("vfctuWRZxDfVxzV1");
    const [sock] = await A.createEmbeddedDocuments("Item", [{ ...sockDoc.toObject(), _stats: { compendiumSource: sockDoc.uuid } }]);
    await sock.update({ "system.equipped": true });
    out.socketId = sock.id;
    out.socketAccepts = sock.system?.CyberWorkType?.AcceptsTypes ?? null;
    const win = CAT.openShopWindow(A, { view: "catalog" });
    await waitFor(() => win.rendered && win.element?.querySelector(".cp-catalog-row"));
    win.setPosition({ left: 10, top: 40 });
    await sleep(300);
    // The hardware the UI negatives buy: priced, base-pack cyberware that is ON the list and no chip.
    // (The rack above is filed beside the chips but is not offered on the list, so it only serves §1.)
    for (const r of (win._baseRows ?? []).filter(r => r.type === "cyberware" && r.sub !== "Chipware" && Number(r.cost) > 0 && String(r.packId).startsWith("cyberpunk2020.")).sort((a, b) => a.name.localeCompare(b.name))) {
      const d = await game.packs.get(r.packId)?.getDocument(r.id);
      if (d && !has(d, "Chip")) { out.hw = { packId: r.packId, itemId: r.id, name: d.name, cost: Number(r.cost) }; break; }
    }
    return out;
  }, SCOPE);

  const state = (page, id, name) => page.evaluate(({ id, name, SCOPE }) => {
    const a = game.actors.get(id); const its = window.__pw.chipsOn(a, name);
    const fresh = [...game.messages].filter(m => !window.__pwBefore?.has(m.id));
    return { funds: Number(a.system.eurobucks), n: its.length,
      equipped: its.map(i => i.system.equipped === true), active: its.map(i => !!i.system?.CyberWorkType?.ChipActive),
      parents: its.map(i => i.system?.Module?.ParentId ?? ""),
      chipCards: fresh.filter(m => /ready to slot/i.test(m.content ?? "")).length,
      installCards: fresh.filter(m => (m.content ?? "").includes(`installed “${name}”`)).length,
      installRequests: fresh.filter(m => m.getFlag(SCOPE, "installRequest")).length,
      purchaseRequests: fresh.filter(m => m.getFlag(SCOPE, "purchaseRequest")).length };
  }, { id, name, SCOPE });

  /* ─────────────────────────── §1 the rule ─────────────────────────── */
  console.log("\n§1 the rule");
  check("a pack chip is a slotted chip; the rack filed beside the chips is not", S.pure?.chip === true && S.pure?.rack === false, S.pure);
  check("an unslotted chip needs no install flow; uninstalled hardware does", S.pure?.chipNeeds === false && S.pure?.rackNeeds === true, S.pure);
  check("harness: the installed socket accepts chips (base-pack correction fired)", Array.isArray(S.socketAccepts) && S.socketAccepts.includes("Chip"), S.socketAccepts);

  /* ─────────────────────────── §2 the Buy button ─────────────────────────── */
  console.log("\n§2 catalog Buy button (GM)");
  check("harness: the chip's row is on the list", await searchRow(gm, S.chip.name, S.chip.itemId), S.chip.name);
  await gm.evaluate((id) => window.__pw.shopWins()[0].element.querySelector(`.cp-catalog-row[data-item-id="${id}"] .cp-catalog-buy`).click(), S.chip.itemId);
  let saw = await gm.evaluate(() => window.__pw.sawDialog("install", 2000, "cancel"));
  check("Buy on a chip opens NO install dialog", saw === null, saw);
  await gm.evaluate((n) => window.__pw.waitFor(() => window.__pw.chipsOn(game.actors.getName("__PW__Chip A"), n).length > 0, 6000), S.chip.name);
  await sleep(700);
  let st = await state(gm, S.A, S.chip.name);
  check("the chip is delivered unslotted (not equipped, not switched on)", st.n === 1 && st.equipped[0] === false && st.active[0] === false, st);
  check("the buyer is billed the chip's price and nothing else", st.funds === 20000 - S.chip.cost, { funds: st.funds, cost: S.chip.cost });
  check("the chip receipt is posted; no install summary", st.chipCards === 1 && st.installCards === 0, st);

  check("harness: a priced, non-chip piece of hardware is on the list", !!S.hw && await searchRow(gm, S.hw.name, S.hw.itemId), S.hw ?? null);
  await gm.evaluate((id) => window.__pw.shopWins()[0].element.querySelector(`.cp-catalog-row[data-item-id="${id}"] .cp-catalog-buy`).click(), S.hw.itemId);
  saw = await gm.evaluate(() => window.__pw.sawDialog("install", 6000, "cancel"));
  let rk = await state(gm, S.A, S.hw.name);
  check("Buy on the hardware beside it still opens the install dialog (cancelled: nothing bought)", !!saw && rk.n === 0 && rk.funds === 20000 - S.chip.cost, { saw: !!saw, rk });

  /* ─────────────────────────── §3 the row dropped on a sheet ─────────────────────────── */
  console.log("\n§3 a row dropped on a character sheet");
  const sheetA = await gm.evaluate(async (id) => { const s = game.actors.get(id).sheet; s.render(true); await window.__pw.waitFor(() => s.rendered, 15000); s.setPosition({ left: 930, top: 40 }); await window.__pw.sleep(400); return s.id; }, S.A);
  const dragToSheet = async (page, itemId, sheetId) => {
    await page.evaluate((id) => foundry.applications.instances.get(id)?.bringToFront?.(), sheetId);
    await page.locator(`.cp-catalog-row[data-item-id="${itemId}"]`).first()
      .dragTo(page.locator(`[id="${sheetId}"] .window-content`), { sourcePosition: { x: 70, y: 12 }, targetPosition: { x: 220, y: 320 } }).catch(() => {});
  };
  await searchRow(gm, S.chip.name, S.chip.itemId);
  await dragToSheet(gm, S.chip.itemId, sheetA);
  const viaInstall = await gm.evaluate(() => window.__pw.sawDialog("install", 1500, "cancel"));
  const conf = viaInstall ? null : await gm.evaluate(() => window.__pw.sawDialog("confirm", 5000, "buy"));
  check("a dropped chip row opens the ordinary confirm, not the install dialog", viaInstall === null && !!conf, { viaInstall: !!viaInstall, conf });
  check("the confirm names the chip and its price and offers no quantity field", !!conf && conf.text.includes(S.chip.name) && conf.text.includes(`${S.chip.cost}eb`) && conf.hasQty === false, conf);
  await sleep(900);
  st = await state(gm, S.A, S.chip.name);
  check("Buy: a second chip, unslotted, billed once more", st.n === 2 && st.equipped.every(e => e === false) && st.funds === 20000 - 2 * S.chip.cost, st);

  await searchRow(gm, S.hw.name, S.hw.itemId);
  await dragToSheet(gm, S.hw.itemId, sheetA);
  saw = await gm.evaluate(() => window.__pw.sawDialog("install", 6000, "cancel"));
  check("a dropped hardware row still goes straight to the install dialog", !!saw, saw);
  await gm.evaluate(async () => { await window.__pw.closeAllDialogs(); for (const w of window.__pw.shopWins()) await w.close(); });

  /* ─────────────────────────── §4 on the sheet ─────────────────────────── */
  console.log("\n§4 slotting on the sheet");
  // This section owns its chips (two fresh, unslotted copies from the pack), so it stands whatever the
  // purchase sections above delivered.
  const own = await gm.evaluate(async ({ A, chip }) => {
    const actor = game.actors.get(A);
    const doc = await game.packs.get(chip.packId).getDocument(chip.itemId);
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const [it] = await actor.createEmbeddedDocuments("Item", [{ ...doc.toObject(), _stats: { compendiumSource: doc.uuid } }]);
      await it.update({ "system.equipped": false, "system.CyberWorkType.ChipActive": false });
      ids.push(it.id);
    }
    window.__pwBefore = new Set(game.messages.map(m => m.id));
    return { ids, funds: Number(actor.system.eurobucks) };
  }, { A: S.A, chip: S.chip });
  const nest = await gm.evaluate(async ({ A, socketId, chipId, SCOPE }) => {
    const { waitFor, sleep, sawDialog } = window.__pw;
    const actor = game.actors.get(A);
    const sheet = actor.sheet; await sheet.render(true); await sleep(500);
    const row = sheet.element.querySelector(`[data-drop-target="host:${socketId}"]`);
    if (!row) return { noRow: true };
    const chip = actor.items.get(chipId);
    const dt = new DataTransfer();
    dt.setData("text/plain", JSON.stringify({ type: "Item", uuid: chip.uuid }));
    row.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    const dialog = await sawDialog("install", 1800, "cancel");
    await waitFor(() => actor.items.get(chip.id)?.system?.Module?.ParentId === socketId, 4000);
    const it = actor.items.get(chip.id);
    return { noRow: false, dialog: !!dialog, chipId: chip.id, parent: it.system?.Module?.ParentId ?? "", equipped: it.system.equipped === true,
      waiting: !!it.flags?.[SCOPE]?.installRequestId };
  }, { A: S.A, socketId: S.socketId, chipId: own.ids[0], SCOPE });
  check("harness: the installed socket renders as a drop row on the sheet", nest.noRow === false, nest);
  check("a chip dropped on the socket's row opens no install dialog", nest.dialog === false, nest);
  check("it is nested in the socket and in place, with nothing waiting on the GM", nest.parent === S.socketId && nest.equipped === true && nest.waiting === false, nest);
  st = await state(gm, S.A, S.chip.name);
  check("slotting cost nothing and posted no install card or request", st.funds === own.funds && st.installCards === 0 && st.installRequests === 0, { funds: st.funds, want: own.funds, cards: st.installCards, requests: st.installRequests });

  const btn = await gm.evaluate(async ({ A, chipId }) => {
    const { waitFor, sleep, sawDialog } = window.__pw;
    const actor = game.actors.get(A);
    const chip = actor.items.get(chipId);
    const sh = chip.sheet; await sh.render(true); await waitFor(() => sh.rendered && sh.element?.querySelector(".cyber-install"), 8000); await sleep(300);
    const b = sh.element.querySelector(".cyber-install");
    const out = { found: !!b, label: b?.textContent.trim() ?? null, tip: b?.title ?? null };
    b?.click();
    out.dialog = !!(await sawDialog("install", 1800, "cancel"));
    await waitFor(() => actor.items.get(chip.id)?.system?.equipped === true, 4000); await sleep(500);
    const it = actor.items.get(chip.id);
    out.equipped = it.system.equipped === true; out.active = !!it.system?.CyberWorkType?.ChipActive;
    await sh.render(true); await sleep(400);
    out.after = [...sh.element.querySelectorAll(".field.inactive span")].map(s => s.textContent.trim()).filter(Boolean);
    await sh.close();
    return out;
  }, { A: S.A, chipId: own.ids[1] });
  check("a chip's own sheet offers “Slot chip”, and says it is no surgery", btn.found && btn.label === "Slot chip" && /not a surgery/i.test(btn.tip ?? ""), { label: btn.label, tip: btn.tip });
  check("the click opens no install dialog and slots the chip switched on", btn.dialog === false && btn.equipped === true && btn.active === true, btn);
  check("its sheet then reads “Slotted”", (btn.after ?? []).includes("Slotted"), btn.after);

  const hw = await gm.evaluate(async ({ A, rack }) => {
    const { waitFor, sleep, sawDialog } = window.__pw;
    const actor = game.actors.get(A);
    const doc = await game.packs.get(rack.packId).getDocument(rack.itemId);
    // Created UNINSTALLED. (Creating it fitted and then taking it out would stamp it as chrome that has
    // been in this body before, which goes back in with no surgery; that is the stamp rule, not this one.)
    const obj = doc.toObject();
    const [it] = await actor.createEmbeddedDocuments("Item", [{ ...obj, system: { ...obj.system, equipped: false, humanityLoss: 0 }, _stats: { compendiumSource: doc.uuid } }]);
    const sh = it.sheet; await sh.render(true); await waitFor(() => sh.rendered && sh.element?.querySelector(".cyber-install"), 8000); await sleep(300);
    const b = sh.element.querySelector(".cyber-install");
    const out = { label: b?.textContent.trim() ?? null };
    b?.click();
    out.dialog = !!(await sawDialog("install", 6000, "cancel"));
    out.equipped = actor.items.get(it.id).system.equipped === true;
    await sh.close();
    return out;
  }, { A: S.A, rack: S.hw });
  check("the hardware's sheet still offers Install (Surgery) and opens the install dialog", /Install \(Surgery\)/.test(hw.label ?? "") && hw.dialog === true && hw.equipped === false, hw);

  /* ─────────────────────────── §5 a player, approvals on ─────────────────────────── */
  console.log("\n§5 player session, approvals on");
  check("a non-GM user exists on this rig", !!S.playerName, S.playerName);
  if (S.playerName) {
    await gm.evaluate(async (SCOPE) => { await game.settings.set(SCOPE, "shopBuySource", "shops"); window.__pwBefore = new Set(game.messages.map(m => m.id)); }, SCOPE);
    const pcCtx = await b.newContext({ viewport: VIEW });
    pc = await pcCtx.newPage();
    pc.on("pageerror", e => pcErrors.push("pageerror: " + e.message));
    pc.on("console", m => { if (m.type() === "error") pcErrors.push("console: " + m.text()); });
    await join(pc, S.playerName, "");
    await installHelpers(pc);
    const start = (page, id, picked) => page.evaluate(({ id, picked }) => {
      window.__pwBuy = { done: false, r: null };
      window.__pw.CAT.purchaseCatalogItem(game.actors.get(id), picked.packId, picked.itemId, { qty: 1 })
        .then(r => { window.__pwBuy = { done: true, r }; }, e => { window.__pwBuy = { done: true, r: { error: String(e) } }; });
    }, { id, picked });
    const done = (page, ms = 8000) => page.evaluate(async (ms) => { await window.__pw.waitFor(() => window.__pwBuy?.done, ms); return window.__pwBuy?.done ? window.__pwBuy.r : { timeout: true }; }, ms);

    await start(pc, S.P, S.chip);
    const pSaw = await pc.evaluate(() => window.__pw.sawDialog("install", 2000, "buyOnly"));
    let r = await done(pc);
    check("a player buying a chip is asked nothing; the buy becomes a request", pSaw === null && r?.ok === false && r?.reason === "requested", { pSaw, r });
    const req = await gm.evaluate(async (SCOPE) => {
      const { waitFor } = window.__pw;
      const read = () => [...game.messages].filter(m => !window.__pwBefore.has(m.id) && m.getFlag(SCOPE, "purchaseRequest"));
      await waitFor(() => read().length > 0, 8000);
      const m = read()[0]; if (!m) return null;
      await waitFor(() => document.querySelector(`[data-message-id="${m.id}"] .cp-shop-request`), 6000);
      const dom = [...document.querySelectorAll(`[data-message-id="${m.id}"] .cp-shop-request`)].pop();
      const q = m.getFlag(SCOPE, "purchaseRequest");
      return { id: m.id, n: read().length, cyber: q.cyber ?? null, total: q.total, line: dom?.querySelector(".cp-shop-request-cyber")?.textContent.trim() ?? null };
    }, SCOPE);
    check("the request carries no install answers and shows no install line; its total is the chip's price", !!req && req.n === 1 && req.cyber === null && req.line === null && req.total === S.chip.cost, req);
    const appr = req ? await gm.evaluate(async ({ SCOPE, id }) => {
      const { waitFor, sleep, sawDialog } = window.__pw;
      const els = [...document.querySelectorAll(`[data-message-id="${id}"] .cp-shop-request-btn[data-action="approve"]`)];
      els[els.length - 1]?.click();
      const dialog = !!(await sawDialog("install", 2000, "cancel"));
      await waitFor(() => { const s = game.messages.get(id)?.getFlag(SCOPE, "purchaseRequest")?.status; return s && s !== "pending"; }, 8000);
      await sleep(1200);
      return { dialog, status: game.messages.get(id)?.getFlag(SCOPE, "purchaseRequest")?.status ?? null };
    }, { SCOPE, id: req.id }) : null;
    check("the GM's Approve asks the GM nothing and settles the request", !!appr && appr.dialog === false && appr.status === "approved", appr);
    const pst = await state(gm, S.P, S.chip.name);
    check("the player's character holds the chip unslotted and paid its price", pst.n === 1 && pst.equipped[0] === false && pst.funds === 20000 - S.chip.cost, pst);

    await start(pc, S.P, S.hw);
    const pHw = await pc.evaluate(() => window.__pw.sawDialog("install", 6000, "cancel"));
    r = await done(pc);
    check("the hardware still asks the player the install question first (cancelled: no request)", !!pHw && r?.reason === "cancelled", { pHw: !!pHw, r });
  }

  /* ─────────────────────────── §6 console ─────────────────────────── */
  console.log("\n§6 console");
  check("0 console errors (GM session)", errors.length === 0, errors.slice(0, 4));
  check("0 console errors (player session)", pcErrors.length === 0, pcErrors.slice(0, 4));
} catch (e) {
  fail++;
  console.log(`  FAIL  harness threw: ${e?.message ?? e}`);
} finally {
  if (pc) await pc.evaluate(async () => { try { await window.__pw?.closeAllDialogs?.(); } catch { /* none */ } }).catch(() => {});
  await gm.evaluate(async ({ SCOPE, prev }) => {
    try { await window.__pw?.closeAllDialogs?.(); } catch { /* none */ }
    try { for (const w of window.__pw?.shopWins?.() ?? []) await w.close(); } catch { /* none */ }
    try { if (prev !== undefined && game.settings.get(SCOPE, "shopBuySource") !== prev) await game.settings.set(SCOPE, "shopBuySource", prev); } catch { /* unregistered */ }
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__Chip"))) await a.delete().catch(() => {});
    const mine = [...game.messages].filter(m => window.__pwBase && !window.__pwBase.has(m.id)).map(m => m.id);
    if (mine.length) await ChatMessage.deleteDocuments(mine).catch(() => {});
  }, { SCOPE, prev: S.prevSource }).catch(e => console.error("cleanup failed:", e?.message));
  await b.close();
}
console.log(`\nRESULT: ${fail ? "FAIL" : "PASS"} ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
