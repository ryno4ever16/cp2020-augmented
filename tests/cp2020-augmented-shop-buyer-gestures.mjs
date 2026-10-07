/** Shop: who is buying, and the header that says so.
 *   §1 the shared header sits on ONE line at the default window width — with nobody buying (the short
 *      notice beside the picker), with a buyer, with both GM badges lit, and at a wider width
 *   §2 a generated caliber row is a drag source like every other row: the drag payload carries the
 *      caliber + the load and box count the row shows; a REAL drag onto a character sheet opens the
 *      drop confirm at that box count and per-box price; Cancel buys nothing; Buy stocks and bills the
 *      SHEET's actor (not the strip's buyer); a second drop stacks; setup mode waives the bill and the
 *      confirm says so (for a caliber row and for an ordinary item row)
 *   §3 a click on a character sheet makes its actor the buyer (strip repainted + lit); a second sheet
 *      takes over; an item sheet and the sheet's own close button do not; the listener is armed once
 *      and taken down when the last shop window closes; token selection lights the strip too
 *   §4 a player: clicking a sheet they own switches the buyer, a sheet they only observe does not;
 *      the playersCanBuyAmmo gate refuses a caliber-row drop before any confirm, and allows it when on
 *   §5 0 console errors on both sessions
 *  Fixtures are __PW__-prefixed and deleted in the finally; every setting touched is restored. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";
async function join(p, who, pw = PW){const pws = pw === "" ? ["", PW] : [pw];for (const cand of pws) {await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>new RegExp(who,"i").test(u.l))||us[0];await s.selectOption(g.v);await p.locator('input[name="password"]').fill(cand);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);try {await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:cand===pws[pws.length-1]?60000:20000});return;} catch (e) {if (cand === pws[pws.length-1]) throw e;}}}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, got) => { if (ok) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}  got=${JSON.stringify(got)}`); } };

/** Page-side helpers, installed once per session on `window.__pw`. */
async function installHelpers(page) {
  await page.evaluate(async (SCOPE) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitFor = async (fn, ms = 40000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); } return false; };
    const CAT = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    const LOOK = await import(`/modules/${SCOPE}/module/lookups.js`);
    const SETUP = await import(`/modules/${SCOPE}/module/shop/setup-mode.js`);
    const shopWins = () => [...foundry.applications.instances.values()].filter(w => w instanceof CAT.CatalogBrowser);
    const confirmDlg = () => [...foundry.applications.instances.values()].find(a => a.element?.querySelector?.('input[name="qty"].cp-qty-input')) ?? null;
    // The header's children, clustered into visual lines by their vertical centres.
    const header = (win) => {
      const h = win.element.querySelector(".cp-shop-header");
      const hr = h.getBoundingClientRect();
      const kids = [...h.children].map(el => { const r = el.getBoundingClientRect(); return { el, mid: r.top + r.height / 2, w: r.width, right: r.right }; });
      const mids = kids.map(k => k.mid).sort((a, b) => a - b);
      let lines = mids.length ? 1 : 0;
      for (let i = 1; i < mids.length; i++) if (mids[i] - mids[i - 1] > 14) lines++;
      const h2 = h.querySelector("h2");
      const strip = h.querySelector(".cp-catalog-buyer");
      const range = document.createRange(); range.selectNodeContents(h2);
      const padR = parseFloat(getComputedStyle(h).paddingRight) || 0;
      // Neighbours on the row must not sit on top of each other, and the strip must hold its content.
      const byLeft = [...h.children].map(el => el.getBoundingClientRect()).sort((a, b) => a.left - b.left);
      let overlap = 0;
      for (let i = 1; i < byLeft.length; i++) overlap = Math.max(overlap, Math.round(byLeft[i - 1].right - byLeft[i].left));
      const picker = strip.querySelector(".cp-buyer-pick");
      return {
        overlap, stripOverflow: strip.scrollWidth > strip.clientWidth + 1,
        hasPicker: !!picker, pickW: picker ? Math.round(picker.getBoundingClientRect().width) : null,
        pickText: picker ? (picker.selectedOptions[0]?.textContent.trim() ?? null) : null,
        lines, headerW: Math.round(hr.width),
        h2W: Math.round(h2.getBoundingClientRect().width), h2TextW: Math.round(range.getBoundingClientRect().width),
        h2Clipped: h2.scrollWidth > h2.clientWidth + 1,
        stripGapRight: Math.round(hr.right - padR - strip.getBoundingClientRect().right),
        notice: strip.querySelector(".cp-buyer-warn")?.textContent.trim() ?? null,
        noticeTip: strip.querySelector(".cp-buyer-warn")?.title ?? null,
        noticeClipped: (() => { const n = strip.querySelector(".cp-buyer-warn"); return n ? n.scrollWidth > n.clientWidth + 1 : null; })(),
        funds: strip.querySelector(".cp-buyer-funds")?.textContent.trim() ?? null,
        pick: strip.querySelector(".cp-buyer-pick")?.value ?? null,
        lit: strip.classList.contains("cp-buyer-changed"),
      };
    };
    const intoRows = async (win, cat, marker) => {
      await waitFor(() => win.rendered && win.element?.querySelector(".cp-catalog-row"));
      win.element.querySelector(`.cp-cat-chip[data-cat="${cat}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await waitFor(() => win.element?.querySelector(marker), 30000);
      await sleep(250);
    };
    const place = async (app, left, top) => { await waitFor(() => app.rendered, 15000); app.setPosition({ left, top }); await sleep(120); };
    window.__pw = { sleep, waitFor, CAT, LOOK, SETUP, shopWins, confirmDlg, header, intoRows, place };
  }, SCOPE);
}

/** REAL drag: the caliber row's name cell onto a sheet's content. Resolves to the confirm it opened
 *  ({qty, text, label}) or null when none appeared. */
const dragRowToSheet = (page, caliber, sheetId, waitMs = 6000) => dragSelToSheet(page, `.cp-catalog-row[data-ammo-caliber="${caliber}"]`, sheetId, waitMs);
async function dragSelToSheet(page, rowSelector, sheetId, waitMs = 6000) {
  await page.evaluate((id) => foundry.applications.instances.get(id)?.bringToFront?.(), sheetId);
  const row = page.locator(rowSelector).first();
  const target = page.locator(`[id="${sheetId}"] .window-content`);
  await row.dragTo(target, { sourcePosition: { x: 70, y: 12 }, targetPosition: { x: 220, y: 320 } }).catch(() => {});
  return page.evaluate(async (waitMs) => {
    const { waitFor, confirmDlg } = window.__pw;
    if (!(await waitFor(() => confirmDlg(), waitMs))) return null;
    const el = confirmDlg().element;
    return { qty: el.querySelector('input[name="qty"]').value, text: el.querySelector(".window-content p")?.textContent ?? "", label: el.querySelector(".form-group label")?.textContent.trim() ?? "" };
  }, waitMs);
}
async function pressConfirm(page, action) {
  await page.evaluate(async (action) => {
    const { confirmDlg, waitFor, sleep } = window.__pw;
    confirmDlg()?.element.querySelector(`button[data-action="${action}"]`)?.click();
    await waitFor(() => !confirmDlg(), 6000);
    await sleep(900);
  }, action);
}
/** REAL click on a sheet's window title (a neutral spot: it triggers no sheet control). */
async function clickSheet(page, sheetId) {
  await page.evaluate((id) => foundry.applications.instances.get(id)?.bringToFront?.(), sheetId);
  await page.locator(`[id="${sheetId}"] .window-title`).click({ position: { x: 30, y: 8 } });
}
const stripState = (page) => page.evaluate(() => { const w = window.__pw.shopWins()[0]; return w ? { buyer: w.buyer?.id ?? null, ...window.__pw.header(w) } : null; });
/** The strip's light is a CSS animation. A page that is not in front (the second headless session here)
 *  runs it to its end at once, so the class alone cannot be read there: the legs arm a listener on the
 *  strip BEFORE the gesture and watch for the animation starting — the mechanism itself. */
const armLit = (page) => page.evaluate(() => {
  const strip = window.__pw.shopWins()[0]?.element?.querySelector(".cp-catalog-buyer");
  window.__pwLit = [];
  strip?.addEventListener("animationstart", (e) => { if (e.target === strip) window.__pwLit.push(e.animationName); });
});
const sawLit = (page, ms = 1200) => page.evaluate(async (ms) => {
  await window.__pw.waitFor(() => (window.__pwLit ?? []).includes("cp-buyer-changed"), ms);
  return (window.__pwLit ?? []).includes("cp-buyer-changed");
}, ms);

const b = await chromium.launch({ headless: true });
const VIEW = { width: 1920, height: 1100 };
const gmCtx = await b.newContext({ viewport: VIEW });
const gm = await gmCtx.newPage();
const errors = [], pcErrors = [];
gm.on("pageerror", e => errors.push("pageerror: " + e.message));
gm.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
let pcCtx = null, pc = null;
let S = {};

try {
  await join(gm, "gamemaster");
  await installHelpers(gm);

  /* ───────────── fixtures + the first open (the listener census starts before it) ───────────── */
  S = await gm.evaluate(async (SCOPE) => {
    const { CAT, SETUP, sleep, waitFor, shopWins } = window.__pw;
    for (const w of shopWins()) await w.close();
    SETUP.setShopSetupMode(false);
    canvas?.tokens?.releaseAll?.();
    await sleep(200);
    const out = { prevPlayersCanBuy: null };
    try { out.prevPlayersCanBuy = game.settings.get(SCOPE, "playersCanBuyAmmo"); } catch { /* unregistered */ }
    const player = game.users.find(u => !u.isGM && /test user 1/i.test(u.name)) ?? game.users.find(u => !u.isGM);
    out.playerName = player?.name ?? null;
    out.prevCharacter = player?.character?.id ?? null;
    out.usersWithCharacter = game.users.filter(u => u.character).length;
    const OWN = CONST.DOCUMENT_OWNERSHIP_LEVELS;
    const mk = (name, eb, ownership = {}) => Actor.create({ name, type: "npc", ownership, system: { eurobucks: eb } });
    const A = await mk("__PW__Gest A", 5000), B = await mk("__PW__Gest B", 7000);
    const P1 = await mk("__PW__Gest P1 With A Very Long Name", 3000, player ? { [player.id]: OWN.OWNER } : {});
    const P2 = await mk("__PW__Gest P2", 4000, player ? { [player.id]: OWN.OWNER } : {});
    const X  = await mk("__PW__Gest X", 9000, player ? { [player.id]: OWN.OBSERVER } : {});
    const [item] = await B.createEmbeddedDocuments("Item", [{ name: "__PW__Gest thing", type: "misc" }]);
    Object.assign(out, { A: A.id, B: B.id, P1: P1.id, P2: P2.id, X: X.id, itemId: item.id });

    // Census of the document-level capture click listeners the sheet gesture registers / removes.
    window.__pwAdds = 0; window.__pwRemoves = 0;
    const mine = (t, l, o) => t === "click" && (o === true || o?.capture) && /_cpSyncBuyer/.test(String(l));
    const add = document.addEventListener, rem = document.removeEventListener;
    document.addEventListener = function (t, l, o) { if (mine(t, l, o)) window.__pwAdds++; return add.apply(this, arguments); };
    document.removeEventListener = function (t, l, o) { if (mine(t, l, o)) window.__pwRemoves++; return rem.apply(this, arguments); };

    const win = CAT.openShopWindow(null, { view: "catalog" });
    await waitFor(() => win.rendered && win.element?.querySelector(".cp-catalog-row"));
    await win._cpSyncBuyer(null);
    win.setPosition({ left: 10, top: 40 });
    await sleep(400);
    return out;
  }, SCOPE);

  /* ─────────────────────────── §1 one header line ─────────────────────────── */
  console.log("\n§1 header on one line (default width)");
  let h = await stripState(gm);
  check("harness: the window is at its default width with nobody buying and nobody to offer", h.buyer === null && h.hasPicker === false && h.headerW > 800 && h.headerW < 880, { buyer: h.buyer, picker: h.hasPicker, headerW: h.headerW });
  check("no picker, nobody buying: every header child shares one line, none overlapping", h.lines === 1 && h.overlap <= 0 && !h.stripOverflow, { lines: h.lines, overlap: h.overlap, overflow: h.stripOverflow });
  check("no picker: the notice is the short one, whole", h.notice === "No buyer selected" && h.noticeClipped === false, { notice: h.notice, clipped: h.noticeClipped });
  check("no picker: the full instruction rides the notice as its tooltip", /sheet/i.test(h.noticeTip ?? "") && /token/i.test(h.noticeTip ?? ""), h.noticeTip);
  check("the title is as wide as its words (not the row's grower) and is not clipped", !h.h2Clipped && h.h2W - h.h2TextW <= 40, { h2W: h.h2W, textW: h.h2TextW, clipped: h.h2Clipped });
  check("the buyer strip is held against the header's right edge", Math.abs(h.stripGapRight) <= 3, h.stripGapRight);

  // A player with an assigned character gives the GM's strip its PICKER — the state a running table
  // is in. The character's name is long, so the picker is at its widest.
  await gm.evaluate(async ({ P1, playerName }) => {
    const u = game.users.find(u => u.name === playerName);
    await u.update({ character: P1 });
    const w = window.__pw.shopWins()[0]; await w._cpSyncBuyer(null); await window.__pw.sleep(250);
  }, { P1: S.P1, playerName: S.playerName });
  h = await stripState(gm);
  check("picker, nobody buying: the picker reads its prompt and keeps a usable width", h.hasPicker && h.pickText === "Buy as…" && h.pickW >= 72, { picker: h.hasPicker, text: h.pickText, w: h.pickW });
  check("picker, nobody buying: one line, none overlapping, strip holds its content", h.lines === 1 && h.overlap <= 0 && !h.stripOverflow, { lines: h.lines, overlap: h.overlap, overflow: h.stripOverflow });
  check("picker: the short notice, whole, with the picker-worded tooltip", h.notice === "No buyer selected" && h.noticeClipped === false && /pick a character here/i.test(h.noticeTip ?? ""), { notice: h.notice, clipped: h.noticeClipped, tip: h.noticeTip });

  await gm.evaluate(async (id) => { const w = window.__pw.shopWins()[0]; await w._cpSyncBuyer(game.actors.get(id)); await window.__pw.sleep(200); }, S.A);
  h = await stripState(gm);
  check("with a buyer: one line, none overlapping, the funds readout shown", h.lines === 1 && h.overlap <= 0 && !h.stripOverflow && h.funds === "5000eb", { lines: h.lines, overlap: h.overlap, overflow: h.stripOverflow, funds: h.funds });
  check("with a buyer: the strip still ends at the right edge", Math.abs(h.stripGapRight) <= 3, h.stripGapRight);

  await gm.evaluate(async () => {
    const { SETUP, sleep, shopWins, waitFor } = window.__pw; const w = shopWins()[0];
    await w._cpSyncBuyer(null);
    SETUP.setShopSetupMode(true);
    w.element.querySelector(".cp-shop-viewas-toggle")?.click();
    await sleep(300); await w.render(); await waitFor(() => w.element.querySelector(".cp-catalog-row")); await sleep(300);
  });
  h = await stripState(gm);
  const lit = await gm.evaluate(() => { const w = window.__pw.shopWins()[0]; return { setup: !!w.element.querySelector(".cp-shop-setup-toggle.cp-active"), viewas: !!w.element.querySelector(".cp-shop-viewas-toggle.cp-active") }; });
  check("both GM badges lit (bold) and nobody buying: still one line, none overlapping", lit.setup && lit.viewas && h.lines === 1 && h.overlap <= 0 && !h.stripOverflow, { ...lit, lines: h.lines, overlap: h.overlap, overflow: h.stripOverflow });
  await gm.evaluate(async () => {
    const { SETUP, sleep, shopWins, waitFor } = window.__pw; const w = shopWins()[0];
    SETUP.setShopSetupMode(false);
    w.element.querySelector(".cp-shop-viewas-toggle.cp-active")?.click();
    await sleep(300); await w.render(); await waitFor(() => w.element.querySelector(".cp-catalog-row"));
    w.setPosition({ width: 1200 }); await sleep(300);
  });
  h = await stripState(gm);
  check("at a wider window (1200): one line, strip at the right edge", h.lines === 1 && Math.abs(h.stripGapRight) <= 3, { lines: h.lines, gap: h.stripGapRight });
  await gm.evaluate(async () => { const w = window.__pw.shopWins()[0]; w.setPosition({ width: 880 }); await window.__pw.sleep(250); });

  /* ─────────────────────────── §2 caliber-row drag ─────────────────────────── */
  console.log("\n§2 a generated caliber row drags like any other row");
  const R = await gm.evaluate(async ({ A, B }) => {
    const { intoRows, shopWins, LOOK, sleep, place } = window.__pw; const w = shopWins()[0];
    await intoRows(w, "Ammo", ".cp-catalog-row[data-ammo-caliber]");
    const row = [...w.element.querySelectorAll(".cp-catalog-row[data-ammo-caliber]")].find(r => r.querySelector(".cp-catalog-ammo-load")?.options.length > 1);
    const sel = row.querySelector(".cp-catalog-ammo-load");
    const pick = [...sel.options].map(o => o.value).find(v => v !== sel.options[0].value);
    sel.value = pick; sel.dispatchEvent(new Event("change", { bubbles: true }));
    const q = row.querySelector(".cp-catalog-qty"); q.value = "3"; q.dispatchEvent(new Event("input", { bubbles: true }));
    const caliber = row.dataset.ammoCaliber;
    // The payload the row's own dragstart handler writes, read off a synthetic drag.
    const payloadOf = (el) => { const dt = new DataTransfer(); el.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt })); try { return JSON.parse(dt.getData("text/plain")); } catch { return null; } };
    const out = {
      caliber, pick, price: LOOK.getAmmoBoxPrice(caliber, pick), stdPrice: LOOK.getAmmoBoxPrice(caliber, "standard"),
      boxSize: Number(LOOK.getCaliberBox(caliber).box) || 1,
      draggable: row.getAttribute("draggable"), grab: row.classList.contains("cp-buy-draggable"),
      payload: payloadOf(row),
    };
    await w._cpSyncBuyer(game.actors.get(B));           // the strip names B; the drop below lands on A
    const sheet = game.actors.get(A).sheet; sheet.render(true); await place(sheet, 930, 40);
    out.sheetA = sheet.id;
    await sleep(300);
    return out;
  }, { A: S.A, B: S.B });
  check("the caliber row is a drag source with the grab affordance", R.draggable === "true" && R.grab, { draggable: R.draggable, grab: R.grab });
  check("drag payload: purchase type + this row's caliber, PICKED load and TYPED box count",
    R.payload?.type === "cp2020-augmentedPurchase" && R.payload?.ammo?.caliber === R.caliber && R.payload?.ammo?.modifier === R.pick && R.payload?.ammo?.boxes === 3 && R.pick !== "standard",
    R.payload);
  check("harness: the picked load is priced differently from the standard one", R.price !== R.stdPrice, { price: R.price, std: R.stdPrice });

  const actorState = (page, id) => page.evaluate((id) => { const a = game.actors.get(id); const am = a.itemTypes.ammo ?? []; return { funds: Number(a.system.eurobucks), n: am.length, qty: am.reduce((t, i) => t + Number(i.system.quantity || 0), 0), mod: am[0]?.system.modifier ?? null, cal: am[0]?.system.caliber ?? null }; }, id);

  let d = await dragRowToSheet(gm, R.caliber, R.sheetA);
  check("a real drag onto a character sheet opens the drop confirm", !!d, d);
  check("confirm: quantity starts at the row's box count and is labelled in boxes", d?.qty === "3" && d?.label === "Number of boxes", d);
  check("confirm: priced per box at the PICKED load, naming the rounds per box and the sheet's actor",
    !!d && d.text.includes(`${R.price}eb a box`) && d.text.includes(`${R.boxSize} rounds a box`) && d.text.includes("__PW__Gest A"), d?.text);
  await pressConfirm(gm, "cancel");
  let a = await actorState(gm, S.A);
  check("Cancel: nothing stocked, nothing billed", a.n === 0 && a.funds === 5000, a);

  d = await dragRowToSheet(gm, R.caliber, R.sheetA);
  await pressConfirm(gm, "buy");
  a = await actorState(gm, S.A);
  let bSt = await actorState(gm, S.B);
  check("Buy: the sheet's actor holds boxes × rounds of that caliber and load", a.n === 1 && a.qty === 3 * R.boxSize && a.mod === R.pick && a.cal === R.caliber, a);
  check("Buy: the sheet's actor paid boxes × the picked load's box price", a.funds === 5000 - 3 * R.price, { funds: a.funds, want: 5000 - 3 * R.price });
  check("the strip's buyer (a different actor) was not billed or stocked", bSt.funds === 7000 && bSt.n === 0, bSt);

  // Second act: a different box count, same row → the same stack grows.
  await gm.evaluate((cal) => { const w = window.__pw.shopWins()[0]; const q = w.element.querySelector(`.cp-catalog-row[data-ammo-caliber="${CSS.escape(cal)}"] .cp-catalog-qty`); q.value = "1"; q.dispatchEvent(new Event("input", { bubbles: true })); }, R.caliber);
  d = await dragRowToSheet(gm, R.caliber, R.sheetA);
  check("second drop: the confirm starts at the NEW box count", d?.qty === "1", d);
  await pressConfirm(gm, "buy");
  a = await actorState(gm, S.A);
  check("second drop: stacks onto the same item and bills one more box", a.n === 1 && a.qty === 4 * R.boxSize && a.funds === 5000 - 4 * R.price, a);

  await gm.evaluate(() => window.__pw.SETUP.setShopSetupMode(true));
  d = await dragRowToSheet(gm, R.caliber, R.sheetA);
  check("setup mode: the confirm says nothing is charged — no price, no charge clause",
    !!d && /at no charge/i.test(d.text) && /setup mode/i.test(d.text) && !/eb a box/.test(d.text) && !/and charge/.test(d.text) && d.text.includes(`${R.boxSize} rounds a box`) && d.text.includes("__PW__Gest A"), d?.text);
  await pressConfirm(gm, "buy");
  a = await actorState(gm, S.A);
  check("setup mode: stocked, funds untouched", a.qty === 5 * R.boxSize && a.funds === 5000 - 4 * R.price, a);
  await gm.evaluate(() => window.__pw.SETUP.setShopSetupMode(false));

  const other = await gm.evaluate(async () => {
    const { shopWins, intoRows } = window.__pw; const w = shopWins()[0];
    await intoRows(w, "Armor", '.cp-catalog-row[data-source-key]:not([data-source-key=""])');
    const row = [...w.element.querySelectorAll('.cp-catalog-row[data-source-key]:not([data-source-key=""])')]
      .find(r => Number(r.querySelector(".cp-cat-price b")?.textContent) > 0);
    const dt = new DataTransfer(); row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    let p = null; try { p = JSON.parse(dt.getData("text/plain")); } catch { /* none */ }
    return { payload: p, key: row.dataset.sourceKey, name: row.dataset.name, price: Number(row.querySelector(".cp-cat-price b").textContent) };
  });
  check("a compendium row's payload is unchanged: its source key, no caliber block", other.payload?.sourceKey === other.key && !!other.key && !("ammo" in (other.payload ?? {})), other);

  // The same confirm for an ordinary item row: worded for a charge normally, and for none in setup mode.
  const itemRow = `.cp-catalog-row[data-source-key="${other.key}"]`;
  const held = (page, id, name) => page.evaluate(({ id, name }) => { const a = game.actors.get(id); return { funds: Number(a.system.eurobucks), n: a.items.filter(i => i.name === name).length }; }, { id, name });
  d = await dragSelToSheet(gm, itemRow, R.sheetA);
  check("item row, normally: the confirm names the price each and the charge", !!d && d.text.includes(`${other.price}eb each and charge __PW__Gest A`), d?.text);
  await pressConfirm(gm, "cancel");
  const h0 = await held(gm, S.A, other.name);
  await gm.evaluate(() => window.__pw.SETUP.setShopSetupMode(true));
  d = await dragSelToSheet(gm, itemRow, R.sheetA);
  check("item row, setup mode: the confirm says nothing is charged — no price, no charge clause",
    !!d && /at no charge/i.test(d.text) && /setup mode/i.test(d.text) && !/eb each/.test(d.text) && !/and charge/.test(d.text) && d.text.includes("__PW__Gest A"), d?.text);
  await pressConfirm(gm, "buy");
  const h1 = await held(gm, S.A, other.name);
  check("item row, setup mode: delivered, funds untouched", h1.n === h0.n + 1 && h1.funds === h0.funds && h0.n === 0, { h0, h1 });
  await gm.evaluate(() => window.__pw.SETUP.setShopSetupMode(false));

  /* ─────────────────────────── §3 sheet click = buy as ─────────────────────────── */
  console.log("\n§3 a click on a character sheet picks the buyer");
  const T = await gm.evaluate(async ({ A, B, itemId }) => {
    const { shopWins, sleep, place } = window.__pw; const w = shopWins()[0];
    await w._cpSyncBuyer(null);
    const sb = game.actors.get(B).sheet; sb.render(true); await place(sb, 930, 40);
    const it = game.actors.get(B).items.get(itemId).sheet; it.render(true); await place(it, 1250, 500);
    await sleep(500);
    return { sheetB: sb.id, itemSheet: it.id, adds: window.__pwAdds, removes: window.__pwRemoves };
  }, { A: S.A, B: S.B, itemId: S.itemId });
  check("the document-level listener was armed exactly once by the first open", T.adds === 1 && T.removes === 0, { adds: T.adds, removes: T.removes });

  await armLit(gm);
  await clickSheet(gm, R.sheetA);
  const litA = await sawLit(gm);
  h = await stripState(gm);
  check("click on a sheet: that actor is the buyer; picker and funds follow", h.buyer === S.A && h.pick === S.A && h.funds === `${a.funds}eb`, { buyer: h.buyer, pick: h.pick, funds: h.funds });
  check("the strip is lit by the change", litA === true, litA);
  await sleep(1700);
  h = await stripState(gm);
  check("the lit state clears itself when its animation ends", h.lit === false, h.lit);

  await clickSheet(gm, T.sheetB);
  await sleep(250);
  h = await stripState(gm);
  check("click on a second sheet: the buyer moves to it", h.buyer === S.B && h.funds === "7000eb", { buyer: h.buyer, funds: h.funds });

  await clickSheet(gm, R.sheetA);
  await sleep(250);
  await clickSheet(gm, T.itemSheet);
  await sleep(300);
  h = await stripState(gm);
  check("click on an ITEM sheet (owned by another actor): the buyer stays", h.buyer === S.A, h.buyer);

  await gm.evaluate((id) => foundry.applications.instances.get(id)?.bringToFront?.(), T.sheetB);
  await gm.locator(`[id="${T.sheetB}"] .window-header [data-action="close"]`).click();
  await sleep(600);
  h = await stripState(gm);
  const bOpen = await gm.evaluate((id) => !!foundry.applications.instances.get(id)?.rendered, T.sheetB);
  check("the sheet's own close button closes it WITHOUT choosing it", h.buyer === S.A && bOpen === false, { buyer: h.buyer, bOpen });

  const census = await gm.evaluate(async () => {
    const { shopWins, sleep, waitFor } = window.__pw; const w = shopWins()[0];
    for (let i = 0; i < 3; i++) { await w.render(); await sleep(150); }
    await waitFor(() => w.element.querySelector(".cp-catalog-row"));
    return { adds: window.__pwAdds, removes: window.__pwRemoves };
  });
  check("three more renders bind nothing new", census.adds === 1 && census.removes === 0, census);

  const tok = await gm.evaluate(async () => {
    const { shopWins, sleep, waitFor, header } = window.__pw; const w = shopWins()[0];
    const t = canvas?.tokens?.placeables?.find(t => ["character", "npc"].includes(t.actor?.type));
    if (!t) return { skip: true };
    await w._cpSyncBuyer(null);
    const strip = w.element.querySelector(".cp-catalog-buyer"); const seen = [];
    strip.addEventListener("animationstart", (e) => { if (e.target === strip) seen.push(e.animationName); });
    t.control({ releaseOthers: true });
    await waitFor(() => w.buyer?.id === t.actor.id, 3000);
    const litT = await waitFor(() => seen.includes("cp-buyer-changed"), 1200);
    const on = { buyer: w.buyer?.id === t.actor.id, lit: litT };
    canvas.tokens.releaseAll();
    await waitFor(() => !w.buyer, 3000); await sleep(120);
    return { skip: false, on, off: { buyer: w.buyer?.id ?? null, lit: header(w).lit } };
  });
  check("harness: the rig scene has a figure to select", tok.skip === false, tok);
  if (!tok.skip) {
    check("selecting a token: buyer set and the strip lit", tok.on.buyer && tok.on.lit === true, tok.on);
    check("releasing it: nobody buying, and the empty strip is not lit", tok.off.buyer === null && tok.off.lit === false, tok.off);
  }

  const closed = await gm.evaluate(async ({ B }) => {
    const { shopWins, sleep, CAT, waitFor } = window.__pw;
    for (const w of shopWins()) await w.close();
    await sleep(300);
    const afterClose = { adds: window.__pwAdds, removes: window.__pwRemoves };
    return { afterClose };
  }, { B: S.B });
  check("closing the last shop window takes the listener down", closed.afterClose.removes === 1, closed.afterClose);
  await clickSheet(gm, R.sheetA);
  const reopened = await gm.evaluate(async ({ B }) => {
    const { CAT, waitFor, sleep, shopWins } = window.__pw;
    const w = CAT.openShopWindow(game.actors.get(B), { view: "catalog" });
    await waitFor(() => w.rendered && w.element?.querySelector(".cp-catalog-row")); await sleep(200);
    const r = { buyer: w.buyer?.id, adds: window.__pwAdds };
    for (const x of shopWins()) await x.close();
    for (const s of [...foundry.applications.instances.values()]) if (s.document?.name?.startsWith?.("__PW__Gest")) await s.close();
    return r;
  }, { B: S.B });
  check("a sheet clicked with NO shop open chose nobody; reopening arms the listener again", reopened.buyer === S.B && reopened.adds === 2, reopened);

  /* ─────────────────────────── §4 a player ─────────────────────────── */
  console.log("\n§4 player session");
  check("a non-GM user exists on this rig", !!S.playerName, S.playerName);
  if (S.playerName) {
    pcCtx = await b.newContext({ viewport: VIEW });
    pc = await pcCtx.newPage();
    pc.on("pageerror", e => pcErrors.push("pageerror: " + e.message));
    pc.on("console", m => { if (m.type() === "error") pcErrors.push("console: " + m.text()); });
    await join(pc, S.playerName, "");
    await installHelpers(pc);
    const P = await pc.evaluate(async ({ P1, P2, X }) => {
      const { CAT, waitFor, sleep, place, intoRows, header } = window.__pw;
      for (const w of window.__pw.shopWins()) await w.close();
      const w = CAT.openShopWindow(game.actors.get(P1), { view: "catalog" });
      await waitFor(() => w.rendered && w.element?.querySelector(".cp-catalog-row"));
      w.setPosition({ left: 10, top: 40 });
      const s2 = game.actors.get(P2).sheet; s2.render(true); await place(s2, 930, 40);
      const sx = game.actors.get(X).sheet; sx.render(true); await place(sx, 1100, 300);
      await sleep(500);
      return { sheetP2: s2.id, sheetX: sx.id, buyer0: w.buyer?.id, lines: header(w).lines, ownsX: game.actors.get(X).isOwner, seesX: !!sx.rendered };
    }, { P1: S.P1, P2: S.P2, X: S.X });
    check("harness: the player owns P1/P2, only observes X, and X's sheet opened", P.buyer0 === S.P1 && P.ownsX === false && P.seesX === true, P);
    check("player header (no GM badges): one line", P.lines === 1, P.lines);
    await armLit(pc);
    await clickSheet(pc, P.sheetP2);
    const litP = await sawLit(pc);
    let ph = await stripState(pc);
    check("player: clicking another sheet they OWN switches the buyer and lights the strip", ph.buyer === S.P2 && ph.funds === "4000eb" && litP === true, { buyer: ph.buyer, funds: ph.funds, lit: litP });
    await clickSheet(pc, P.sheetX);
    await sleep(300);
    ph = await stripState(pc);
    check("player: clicking a sheet they only OBSERVE leaves the buyer alone", ph.buyer === S.P2, ph.buyer);

    const PR = await pc.evaluate(async () => {
      const { shopWins, intoRows, LOOK } = window.__pw; const w = shopWins()[0];
      await intoRows(w, "Ammo", ".cp-catalog-row[data-ammo-caliber]");
      const row = w.element.querySelector(".cp-catalog-row[data-ammo-caliber]");
      const caliber = row.dataset.ammoCaliber;
      return { caliber, price: LOOK.getAmmoBoxPrice(caliber, "standard"), boxSize: Number(LOOK.getCaliberBox(caliber).box) || 1 };
    });
    await gm.evaluate((SCOPE) => game.settings.set(SCOPE, "playersCanBuyAmmo", false), SCOPE);
    await sleep(500);
    let pd = await dragRowToSheet(pc, PR.caliber, P.sheetP2, 2500);
    let p2 = await actorState(gm, S.P2);
    check("gate OFF: a player's caliber-row drop opens no confirm and buys nothing", pd === null && p2.n === 0 && p2.funds === 4000, { pd, p2 });
    await gm.evaluate((SCOPE) => game.settings.set(SCOPE, "playersCanBuyAmmo", true), SCOPE);
    await sleep(500);
    pd = await dragRowToSheet(pc, PR.caliber, P.sheetP2);
    check("gate ON: the same drop opens the confirm at one box of the standard load", !!pd && pd.qty === "1" && pd.text.includes(`${PR.price}eb a box`), pd);
    if (pd) await pressConfirm(pc, "buy");
    await sleep(600);
    p2 = await actorState(gm, S.P2);
    check("gate ON: the player's actor is stocked one box and billed its price", p2.qty === PR.boxSize && p2.funds === 4000 - PR.price, p2);
  }

  /* ─────────────────────────── §5 console ─────────────────────────── */
  console.log("\n§5 console");
  check("0 console errors (GM session)", errors.length === 0, errors.slice(0, 4));
  check("0 console errors (player session)", pcErrors.length === 0, pcErrors.slice(0, 4));
} catch (e) {
  fail++;
  console.log(`  FAIL  harness threw: ${e?.message ?? e}`);
} finally {
  if (pc) await pc.evaluate(async () => { for (const w of window.__pw?.shopWins?.() ?? []) await w.close(); }).catch(() => {});
  await gm.evaluate(async ({ SCOPE, prev, playerName, prevCharacter }) => {
    try { for (const w of window.__pw?.shopWins?.() ?? []) await w.close(); } catch { /* none */ }
    try { const u = game.users.find(u => u.name === playerName); if (u && (u.character?.id ?? null) !== prevCharacter) await u.update({ character: prevCharacter }); } catch { /* none */ }
    try { window.__pw?.SETUP?.setShopSetupMode(false); } catch { /* none */ }
    try { const V = await import(`/modules/${SCOPE}/module/shop/view-as-player.js`); if (V.isShopViewAsPlayer?.()) V.toggleShopViewAsPlayer(); } catch { /* module absent */ }
    try { if (prev !== null && game.settings.get(SCOPE, "playersCanBuyAmmo") !== prev) await game.settings.set(SCOPE, "playersCanBuyAmmo", prev); } catch { /* unregistered */ }
    try { canvas?.tokens?.releaseAll?.(); } catch { /* no canvas */ }
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__Gest"))) await a.delete().catch(() => {});
  }, { SCOPE, prev: S.prevPlayersCanBuy ?? null, playerName: S.playerName ?? null, prevCharacter: S.prevCharacter ?? null }).catch(e => console.error("cleanup failed:", e?.message));
  await b.close();
}
console.log(`\nRESULT: ${fail ? "FAIL" : "PASS"} ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
