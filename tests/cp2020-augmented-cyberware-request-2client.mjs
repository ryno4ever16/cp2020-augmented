/**
 * KEEPER: a cyberware purchase that needs GM approval, driven across TWO real sessions
 * (:30004, official 1.1.1 + module).
 *
 * The contract (2026-10-04 rework): the BUYER answers the install question on their OWN client,
 * BEFORE any request is sent; the request carries those answers; the GM's Approve then carries them
 * out with no further prompt on either client. The two-card relay (a choice card to the player, a
 * surgery card to the GM) is retired. A surgery fee the buyer cannot cover is not a refusal: a
 * yes/no confirm offers to go ahead with the fee unpaid.
 *
 *   §1  request path, install + pay: dialog on the PLAYER, nothing on the GM until answered, request
 *       flags carry the answers, total = part + fee; Approve = item equipped, funds − (part + fee),
 *       summary posted, no retired cards, no dialog on either client
 *   §2  request path, buy only: total = part; Approve = item NOT equipped, funds − part
 *   §3  request path, Cancel: no request card, funds unchanged
 *   §4  fee left unpaid: (a) paySurgery unticked on the request; (b) shortfall confirm on the
 *       player's client before the request — "no" cancels, "yes" sends it with the fee unpaid;
 *       (c) the character-sheet install (installCyberware) on a shortfall — "no" / "yes", plus the
 *       funded negative (fee charged, no confirm)
 *   §5  direct path (shopBuySource "catalog"): same dialog on the player, completes there, no
 *       request card; paySurgery unticked charges the part only
 *   §6  0 console errors on both sessions
 *
 * Dialog buttons and the request card's Approve are pressed as real DOM clicks on the client that
 * owns them. Starting a buy calls purchaseCatalogItem in the player's page (the catalog row's Buy
 * button calls the same function).
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";
const START_FUNDS = 100000;

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

/** In-page helpers, installed once per client after join. `__pwDialogs(kind)` lists the rendered
 *  DialogV2 instances of one kind: "install" = the install dialog (it carries the rollHumanity box),
 *  "unpaid" = the fee-shortfall confirm (yes/no buttons around the div.cp-cyber-install content),
 *  "any" = either.
 *  ⚠ The install template's root is `<form class="cp-cyber-install">`, but DialogV2 renders content
 *  inside its own form and the HTML parser drops a nested <form> tag, so that class never reaches the
 *  DOM (measured on :30004). The checkbox names survive, so the install dialog is found by those. */
async function installHelpers(page) {
  await page.evaluate(() => {
    window.__pwDialogs = (kind = "any") => [...foundry.applications.instances.values()]
      .filter(a => a instanceof foundry.applications.api.DialogV2 && a.rendered && a.element)
      .filter(a => {
        const install = !!a.element.querySelector('[name="rollHumanity"]');
        const unpaid = !install && !!a.element.querySelector(".cp-cyber-install") && !!a.element.querySelector('button[data-action="yes"]');
        return kind === "install" ? install : kind === "unpaid" ? unpaid : (install || unpaid);
      });
  });
}

/** Poll this client for a dialog of `kind`; returns what it shows, or null if none appeared. */
async function waitDialog(page, kind, ms = 8000) {
  return page.evaluate(async ({ kind, ms }) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const d = window.__pwDialogs(kind).pop();
      if (d) {
        const el = d.element;
        return {
          // Footer buttons only: the window header's own controls (toggleControls, close) also carry data-action.
          buttons: [...el.querySelectorAll(".window-content button[data-action]")].map(b => b.dataset.action),
          boxes: Object.fromEntries([...el.querySelectorAll('input[type="checkbox"]')].map(i => [i.name, i.checked])),
          text: (el.querySelector(".dialog-content")?.textContent ?? "").replace(/\s+/g, " ").trim(),
          formTag: !!el.querySelector("form.cp-cyber-install"),
        };
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  }, { kind, ms });
}

/** Untick the named boxes (a real click each) and press the dialog button `action`. */
async function answerDialog(page, kind, { untick = [], action }) {
  return page.evaluate(({ kind, untick, action }) => {
    const d = window.__pwDialogs(kind).pop();
    if (!d) return false;
    for (const name of untick) {
      const cb = d.element.querySelector(`[name="${name}"]`);
      if (cb?.checked) cb.click();
    }
    const btn = d.element.querySelector(`button[data-action="${action}"]`);
    if (!btn) return false;
    btn.click();
    return true;
  }, { kind, untick, action });
}

/** Start a catalog buy on the player's client without awaiting it (it waits on the dialog). */
async function startBuy(pc, buyerId, picked) {
  await pc.evaluate(({ SCOPE, buyerId, picked }) => {
    window.__pwBuy = { done: false, r: null };
    import(`/modules/${SCOPE}/module/shop/catalog.js`)
      .then(C => C.purchaseCatalogItem(game.actors.get(buyerId), picked.packId, picked.itemId, { qty: 1 }))
      .then(r => { window.__pwBuy = { done: true, r }; }, e => { window.__pwBuy = { done: true, r: { error: String(e) } }; });
  }, { SCOPE, buyerId, picked });
}

/** Start the character-sheet install on the player's client without awaiting it. */
async function startInstall(pc, buyerId, itemId) {
  await pc.evaluate(({ SCOPE, buyerId, itemId }) => {
    window.__pwInst = { done: false, r: null };
    import(`/modules/${SCOPE}/module/cyberware/install.js`)
      .then(I => { const a = game.actors.get(buyerId); return I.installCyberware(a, a.items.get(itemId), { confirm: true }); })
      .then(r => { window.__pwInst = { done: true, r }; }, e => { window.__pwInst = { done: true, r: { error: String(e) } }; });
  }, { SCOPE, buyerId, itemId });
}

async function waitDone(page, key, ms = 10000) {
  return page.evaluate(async ({ key, ms }) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (window[key]?.done) return window[key].r; await new Promise(r => setTimeout(r, 100)); }
    return { timeout: true };
  }, { key, ms });
}

/** GM: the purchase-request messages created since the snapshot, read from the GM's own client. */
async function gmRequests(gm, waitForOne = false, ms = 10000) {
  return gm.evaluate(async ({ SCOPE, waitForOne, ms }) => {
    const read = () => [...game.messages].filter(m => !window.__pwBefore.has(m.id) && m.getFlag(SCOPE, "purchaseRequest"));
    const t0 = Date.now();
    while (waitForOne && read().length === 0 && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 120));
    const gmIds = new Set(game.users.filter(u => u.isGM).map(u => u.id));
    return read().map(m => {
      const req = m.getFlag(SCOPE, "purchaseRequest");
      const dom = [...document.querySelectorAll(`[data-message-id="${m.id}"] .cp-shop-request`)].pop();
      return {
        id: m.id, total: req.total, status: req.status, needsPrice: !!req.needsPrice, cyber: req.cyber ?? null,
        whisperGMOnly: (m.whisper ?? []).length > 0 && m.whisper.every(id => gmIds.has(id)),
        cyberLine: dom?.querySelector(".cp-shop-request-cyber")?.textContent?.trim() ?? null,
        approveAction: dom?.querySelector(".cp-shop-request-btn.cp-approve")?.dataset?.action ?? null,
      };
    });
  }, { SCOPE, waitForOne, ms });
}

/** GM: press Approve on one request card (real click on the rendered button), then wait for it to settle. */
async function gmApprove(gm, msgId) {
  return gm.evaluate(async ({ SCOPE, msgId }) => {
    const sel = `[data-message-id="${msgId}"] .cp-shop-request-btn[data-action="approve"]`;
    const t0 = Date.now();
    while (!document.querySelector(sel) && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 120));
    const els = [...document.querySelectorAll(sel)];
    const el = els[els.length - 1];
    if (!el) return { found: false };
    el.click();
    const t1 = Date.now();
    while (Date.now() - t1 < 10000) {
      const st = game.messages.get(msgId)?.getFlag(SCOPE, "purchaseRequest")?.status;
      const content = game.messages.get(msgId)?.content ?? "";
      if (st && st !== "pending" && /cp-shop-request-status/.test(content)) break;
      await new Promise(r => setTimeout(r, 120));
    }
    await new Promise(r => setTimeout(r, 1500));   // trailing Humanity / summary messages
    return { found: true, status: game.messages.get(msgId)?.getFlag(SCOPE, "purchaseRequest")?.status ?? null };
  }, { SCOPE, msgId });
}

/** GM: what the buyer and the chat now hold. */
async function gmState(gm, buyerId, name) {
  return gm.evaluate(({ SCOPE, buyerId, name }) => {
    const buyer = game.actors.get(buyerId);
    const items = buyer.items.filter(i => i.type === "cyberware" && i.name === name);
    const fresh = [...game.messages].filter(m => !window.__pwBefore.has(m.id));
    const summaries = fresh.filter(m => (m.content ?? "").includes(`installed “${name}”`));
    const chargedMatch = /,\s*(\d+)eb\)/.exec(summaries[summaries.length - 1]?.content ?? "");
    return {
      funds: Number(buyer.system.eurobucks),
      items: items.length,
      equipped: items[0]?.system?.equipped ?? null,
      humanityLoss: Number(items[0]?.system?.humanityLoss ?? 0),
      damage: Number(buyer.system?.damage ?? 0),
      summaries: summaries.length,
      summaryCharged: chargedMatch ? Number(chargedMatch[1]) : null,
      boughtOnlyCards: fresh.filter(m => (m.content ?? "").includes(`bought “${name}”`)).length,
      retiredCards: fresh.filter(m => m.getFlag(SCOPE, "cyberChoice") || m.getFlag(SCOPE, "cyberSurgery")).length,
      requests: fresh.filter(m => m.getFlag(SCOPE, "purchaseRequest")).length,
      gmDialogs: window.__pwDialogs("any").length,
    };
  }, { SCOPE, buyerId, name });
}

/** GM: reset the buyer between sections and sweep this run's messages. */
async function reset(gm, buyerId, funds = START_FUNDS) {
  await gm.evaluate(async ({ buyerId, funds }) => {
    const buyer = game.actors.get(buyerId);
    const ids = buyer.items.filter(i => i.type === "cyberware").map(i => i.id);
    if (ids.length) await buyer.deleteEmbeddedDocuments("Item", ids);
    await buyer.update({ "system.eurobucks": funds, "system.damage": 0 });
    const stray = [...game.messages].filter(m => !window.__pwBefore.has(m.id)).map(m => m.id);
    if (stray.length) await ChatMessage.deleteDocuments(stray).catch(() => {});
    for (const d of window.__pwDialogs("any")) await d.close().catch(() => {});
  }, { buyerId, funds });
  await new Promise(r => setTimeout(r, 700));
}

const pcDialogCount = (pc) => pc.evaluate(() => window.__pwDialogs("any").length);
const pcCloseDialogs = (pc) => pc.evaluate(async () => { for (const d of window.__pwDialogs("any")) await d.close().catch(() => {}); });

let gm = null, S = null;
try {
  gm = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  collect(gm, gmErrors);
  await joinAs(gm, /^gamemaster$/i, [GM_PW]);
  await installHelpers(gm);

  // ── setup, GM side ────────────────────────────────────────────────────────────────────────────
  S = await gm.evaluate(async ({ SCOPE, START_FUNDS }) => {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__CYBER"))) await a.delete().catch(() => {});
    window.__pwBefore = new Set(game.messages.map(m => m.id));

    const player = game.users.find(u => !u.isGM && /test user 1/i.test(u.name)) ?? game.users.find(u => u.role === 1 && u.name);
    const buyer = await Actor.create({
      name: "__PW__CYBER Buyer", type: "character", system: { eurobucks: START_FUNDS },
      ownership: { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
    });

    // A real catalog piece with a real surgery code — the fee has to be non-zero or the arithmetic
    // below proves nothing — and a dice Humanity cost.
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    const all = await C.getCatalogIndex();
    const I = await import(`/modules/${SCOPE}/module/cyberware/install.js`);
    let picked = null;
    for (const row of all.filter(r => r.category === "Cyberware" && r.cost > 0 && !r.unpriced && !r.priceRange)) {
      const doc = await game.packs.get(row.packId)?.getDocument(row.id);
      if (!doc || doc.type !== "cyberware") continue;
      // Terms as the product computes them (corrections applied), so name / fee match what gets created.
      const t = I.cyberwareTerms(doc, row.cost);
      const code = String(t.data.system?.surgCode ?? "").trim().toUpperCase();
      if (!["M", "MA", "CR"].includes(code) || !(t.surgeryCost > 0) || t.data.name !== row.name) continue;
      const hc = String(t.data.system?.humanityCost ?? "");
      if (!/\d+d\d+/i.test(hc)) continue;
      picked = { packId: row.packId, itemId: row.id, name: t.data.name, cost: row.cost, surgCode: code, fee: t.surgeryCost, humanityCost: hc };
      break;
    }
    const prevSource = game.settings.get(SCOPE, "shopBuySource");
    await game.settings.set(SCOPE, "shopBuySource", "shops");   // published-shops-only → a player's catalog buy asks
    return { playerName: player.name, playerId: player.id, buyerId: buyer.id, picked, prevSource };
  }, { SCOPE, START_FUNDS });

  check("fixture: a priced cyberware piece with a fee-bearing surgery code was found", !!S.picked,
    S.picked ? `${S.picked.name} ${S.picked.cost}eb code ${S.picked.surgCode} HC ${S.picked.humanityCost}` : "none");
  if (!S.picked) throw new Error("no suitable cyberware in the catalog");
  const PART = S.picked.cost;
  const FEE = S.picked.fee;
  check("fixture: fee matches the Core surgery table for the code", FEE === { M: 500, MA: 1500, CR: 2500 }[S.picked.surgCode], `${FEE} ${S.picked.surgCode}`);

  const pc = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  collect(pc, pcErrors);
  await joinAs(pc, new RegExp(`^${S.playerName}$`, "i"), ["", GM_PW]);
  await installHelpers(pc);
  await pc.waitForTimeout(2000);
  check("fixture: the second client is a non-GM that owns the buyer",
    await pc.evaluate((id) => !game.user.isGM && game.actors.get(id)?.isOwner === true, S.buyerId), "");

  /* ─────────────────── §1 request path: install + pay ─────────────────── */
  console.log("\n§1 request path, install and pay the fee");
  await startBuy(pc, S.buyerId, S.picked);
  const d1 = await waitDialog(pc, "install");
  check("install dialog shown on the player's client", !!d1, String(!!d1));
  check("dialog buttons = ok, buyOnly, cancel", d1?.buttons.join(",") === "ok,buyOnly,cancel", d1?.buttons.join(","));
  check("dialog checkboxes paySurgery, rollHumanity, applyDamage all pre-ticked",
    d1?.boxes?.paySurgery === true && d1?.boxes?.rollHumanity === true && d1?.boxes?.applyDamage === true, JSON.stringify(d1?.boxes ?? null));
  console.log(`  (info) dialog content element is a <form>: ${d1?.formTag}`);
  const gmWhileOpen = await gmState(gm, S.buyerId, S.picked.name);
  check("while the player's dialog is open: no dialog on the GM client", gmWhileOpen.gmDialogs === 0, String(gmWhileOpen.gmDialogs));
  check("while the player's dialog is open: no request card yet", gmWhileOpen.requests === 0, String(gmWhileOpen.requests));
  check("while the player's dialog is open: no retired relay card", gmWhileOpen.retiredCards === 0, String(gmWhileOpen.retiredCards));
  await answerDialog(pc, "install", { action: "ok" });
  const r1 = await waitDone(pc, "__pwBuy");
  check("buy call returns {ok:false, reason:'requested'}", r1?.ok === false && r1?.reason === "requested", JSON.stringify(r1));
  const q1 = (await gmRequests(gm, true)).pop();
  check("exactly one request card reached the GM", !!q1, String(!!q1));
  check("request flag cyber = {install:true, paySurgery:true, rollHumanity:true, applyDamage:true}",
    q1?.cyber?.install === true && q1?.cyber?.paySurgery === true && q1?.cyber?.rollHumanity === true && q1?.cyber?.applyDamage === true,
    JSON.stringify(q1?.cyber ?? null));
  check("request flag cyber.surgeryCost = fee for the surgery code", q1?.cyber?.surgeryCost === FEE, `${q1?.cyber?.surgeryCost} vs ${FEE}`);
  check("request flag cyber.surgeryLabel non-empty", !!q1?.cyber?.surgeryLabel, String(q1?.cyber?.surgeryLabel));
  check("request total = part + fee", q1?.total === PART + FEE, `${q1?.total} vs ${PART + FEE}`);
  check("request is whispered to GMs only", q1?.whisperGMOnly === true, String(q1?.whisperGMOnly));
  const expLine1 = await gm.evaluate(({ label, fee }) => game.i18n.format("CYBERPUNK.CyberRequestInstall",
    { surgery: game.i18n.has(`CYBERPUNK.${label}`) ? game.i18n.localize(`CYBERPUNK.${label}`) : label, cost: fee }), { label: q1?.cyber?.surgeryLabel ?? "", fee: FEE });
  check("rendered .cp-shop-request-cyber line = CyberRequestInstall text", q1?.cyberLine === expLine1, `${q1?.cyberLine} | want ${expLine1}`);
  check("approve button wiring: data-action non-empty on the rendered card", q1?.approveAction === "approve", String(q1?.approveAction));
  const pre1 = await gmState(gm, S.buyerId, S.picked.name);
  check("before approval: funds unchanged", pre1.funds === START_FUNDS, String(pre1.funds));
  check("before approval: no item on the buyer", pre1.items === 0, String(pre1.items));
  const a1 = q1 ? await gmApprove(gm, q1.id) : { found: false };
  check("GM Approve control found and clicked", a1.found === true, JSON.stringify(a1));
  check("request status after Approve = approved", a1.status === "approved", String(a1.status));
  const s1 = await gmState(gm, S.buyerId, S.picked.name);
  check("item created on the buyer (1)", s1.items === 1, String(s1.items));
  check("item equipped flag = true", s1.equipped === true, String(s1.equipped));
  check("funds delta = part + fee", s1.funds === START_FUNDS - PART - FEE, `${s1.funds} (want ${START_FUNDS - PART - FEE})`);
  check("humanityLoss written to the item (> 0)", s1.humanityLoss > 0, String(s1.humanityLoss));
  check("wound track damage applied (> 0)", s1.damage > 0, String(s1.damage));
  check("one install summary message, charged = part + fee", s1.summaries === 1 && s1.summaryCharged === PART + FEE, `${s1.summaries} / ${s1.summaryCharged}`);
  check("no message carries a cyberChoice/cyberSurgery flag", s1.retiredCards === 0, String(s1.retiredCards));
  check("no dialog on the GM client after Approve", s1.gmDialogs === 0, String(s1.gmDialogs));
  await pc.waitForTimeout(800);
  const pcd1 = await pcDialogCount(pc);
  check("no dialog on the player client after Approve", pcd1 === 0, String(pcd1));

  /* ─────────────────── §2 request path: buy only ─────────────────── */
  console.log("\n§2 request path, buy only");
  await reset(gm, S.buyerId);
  await startBuy(pc, S.buyerId, S.picked);
  const d2 = await waitDialog(pc, "install");
  check("install dialog shown on the player's client (second buy)", !!d2, String(!!d2));
  await answerDialog(pc, "install", { action: "buyOnly" });
  await waitDone(pc, "__pwBuy");
  const q2 = (await gmRequests(gm, true)).pop();
  check("request flag cyber.install = false", q2?.cyber?.install === false, JSON.stringify(q2?.cyber ?? null));
  check("request records buy-only and totals the part alone", q2?.cyber?.install === false && q2?.total === PART, `install=${q2?.cyber?.install} total=${q2?.total} vs ${PART}`);
  const expLine2 = await gm.evaluate(() => game.i18n.localize("CYBERPUNK.CyberRequestBuyOnly"));
  check("rendered .cp-shop-request-cyber line = CyberRequestBuyOnly text", q2?.cyberLine === expLine2, `${q2?.cyberLine}`);
  const a2 = q2 ? await gmApprove(gm, q2.id) : { found: false };
  check("GM Approve clicked; status = approved", a2.status === "approved", JSON.stringify(a2));
  const s2 = await gmState(gm, S.buyerId, S.picked.name);
  check("buy-only: item created (1)", s2.items === 1, String(s2.items));
  check("buy-only: item equipped flag = false", s2.equipped === false, String(s2.equipped));
  check("buy-only: funds delta = part only", s2.funds === START_FUNDS - PART, `${s2.funds} (want ${START_FUNDS - PART})`);
  check("buy-only: wound track untouched (0)", s2.damage === 0, String(s2.damage));
  check("buy-only: no install summary, one bought-only message", s2.summaries === 0 && s2.boughtOnlyCards === 1, `${s2.summaries} / ${s2.boughtOnlyCards}`);
  check("buy-only: no retired relay card", s2.retiredCards === 0, String(s2.retiredCards));
  check("buy-only: no dialog on the GM client", s2.gmDialogs === 0, String(s2.gmDialogs));

  /* ─────────────────── §3 request path: Cancel ─────────────────── */
  console.log("\n§3 request path, Cancel");
  await reset(gm, S.buyerId);
  await startBuy(pc, S.buyerId, S.picked);
  const d3 = await waitDialog(pc, "install");
  check("install dialog shown on the player's client (third buy)", !!d3, String(!!d3));
  await answerDialog(pc, "install", { action: "cancel" });
  const r3 = await waitDone(pc, "__pwBuy");
  check("buy call returns {ok:false, reason:'cancelled'}", r3?.ok === false && r3?.reason === "cancelled", JSON.stringify(r3));
  await gm.waitForTimeout(1500);
  const s3 = await gmState(gm, S.buyerId, S.picked.name);
  check("Cancel: no request card", s3.requests === 0, String(s3.requests));
  check("Cancel: funds unchanged", s3.funds === START_FUNDS, String(s3.funds));
  check("Cancel: no item", s3.items === 0, String(s3.items));

  /* ─────────────────── §4a fee unticked on the request ─────────────────── */
  console.log("\n§4a request path, paySurgery unticked");
  await reset(gm, S.buyerId);
  await startBuy(pc, S.buyerId, S.picked);
  const d4 = await waitDialog(pc, "install");
  check("install dialog shown (paySurgery leg)", !!d4, String(!!d4));
  await answerDialog(pc, "install", { untick: ["paySurgery"], action: "ok" });
  await waitDone(pc, "__pwBuy");
  const q4 = (await gmRequests(gm, true)).pop();
  check("request flag cyber.install = true, paySurgery = false",
    q4?.cyber?.install === true && q4?.cyber?.paySurgery === false, JSON.stringify(q4?.cyber ?? null));
  check("request records the unpaid fee and totals the part alone", q4?.cyber?.paySurgery === false && q4?.total === PART, `paySurgery=${q4?.cyber?.paySurgery} total=${q4?.total} vs ${PART}`);
  const expLine4 = await gm.evaluate(({ label, fee }) => game.i18n.format("CYBERPUNK.CyberRequestInstallUnpaid",
    { surgery: game.i18n.has(`CYBERPUNK.${label}`) ? game.i18n.localize(`CYBERPUNK.${label}`) : label, cost: fee }), { label: q4?.cyber?.surgeryLabel ?? "", fee: FEE });
  check("rendered .cp-shop-request-cyber line = CyberRequestInstallUnpaid text", q4?.cyberLine === expLine4, `${q4?.cyberLine}`);
  const a4 = q4 ? await gmApprove(gm, q4.id) : { found: false };
  check("GM Approve clicked; status = approved", a4.status === "approved", JSON.stringify(a4));
  const s4 = await gmState(gm, S.buyerId, S.picked.name);
  check("fee unpaid: item equipped flag = true", s4.equipped === true, String(s4.equipped));
  check("fee unpaid: funds delta = part only", s4.funds === START_FUNDS - PART, `${s4.funds} (want ${START_FUNDS - PART})`);
  check("fee unpaid: summary charged = part", s4.summaryCharged === PART, String(s4.summaryCharged));
  check("fee unpaid: no dialog on the GM client", s4.gmDialogs === 0, String(s4.gmDialogs));

  /* ─────────────────── §4b shortfall confirm before the request ─────────────────── */
  console.log("\n§4b request path, surgery-fee shortfall");
  const SHORT = PART + Math.floor(FEE / 2);   // covers the part, not part + fee
  for (const answer of ["no", "yes"]) {
    await reset(gm, S.buyerId, SHORT);
    await startBuy(pc, S.buyerId, S.picked);
    const di = await waitDialog(pc, "install");
    check(`[${answer}] install dialog shown`, !!di, String(!!di));
    await answerDialog(pc, "install", { action: "ok" });
    const du = await waitDialog(pc, "unpaid", 6000);
    check(`[${answer}] shortfall confirm shown on the player's client`, !!du, String(!!du));
    check(`[${answer}] shortfall confirm buttons = yes, no`, du?.buttons.join(",") === "yes,no", du?.buttons.join(","));
    check(`[${answer}] shortfall text states fee ${FEE}eb and ${SHORT - PART}eb available`,
      !!du?.text?.includes(`${FEE}eb`) && !!du?.text?.includes(`${SHORT - PART}eb`), du?.text ?? "");
    const gmDuring = await gmState(gm, S.buyerId, S.picked.name);
    check(`[${answer}] while confirming: no request card, no GM dialog`, gmDuring.requests === 0 && gmDuring.gmDialogs === 0, `${gmDuring.requests}/${gmDuring.gmDialogs}`);
    await answerDialog(pc, "unpaid", { action: answer });
    const rb = await waitDone(pc, "__pwBuy");
    if (answer === "no") {
      check("[no] buy call returns reason 'cancelled'", rb?.reason === "cancelled", JSON.stringify(rb));
      await gm.waitForTimeout(1500);
      const sn = await gmState(gm, S.buyerId, S.picked.name);
      check("[no] no request card", sn.requests === 0, String(sn.requests));
      check("[no] funds unchanged", sn.funds === SHORT, `${sn.funds} vs ${SHORT}`);
      check("[no] no item", sn.items === 0, String(sn.items));
    } else {
      const qy = (await gmRequests(gm, true)).pop();
      check("[yes] request sent with cyber.paySurgery = false", qy?.cyber?.install === true && qy?.cyber?.paySurgery === false, JSON.stringify(qy?.cyber ?? null));
      check("[yes] request records the unpaid fee and totals the part alone", qy?.cyber?.paySurgery === false && qy?.total === PART, `paySurgery=${qy?.cyber?.paySurgery} total=${qy?.total} vs ${PART}`);
      const ay = qy ? await gmApprove(gm, qy.id) : { found: false };
      check("[yes] GM Approve clicked; status = approved", ay.status === "approved", JSON.stringify(ay));
      const sy = await gmState(gm, S.buyerId, S.picked.name);
      check("[yes] item equipped flag = true", sy.equipped === true, String(sy.equipped));
      check("[yes] funds delta = part only", sy.funds === SHORT - PART, `${sy.funds} (want ${SHORT - PART})`);
      check("[yes] no dialog on the GM client during approval", sy.gmDialogs === 0, String(sy.gmDialogs));
    }
    await pcCloseDialogs(pc);
  }

  /* ─────────────────── §4c character-sheet install on a shortfall ─────────────────── */
  console.log("\n§4c sheet install (installCyberware), surgery-fee shortfall");
  const plant = async (funds) => {
    await reset(gm, S.buyerId, funds);
    return gm.evaluate(async ({ SCOPE, buyerId, picked }) => {
      const I = await import(`/modules/${SCOPE}/module/cyberware/install.js`);
      const doc = await game.packs.get(picked.packId).getDocument(picked.itemId);
      const data = I.cyberwareTerms(doc, picked.cost).data;   // corrected copy, as a purchase would create it
      delete data._id; delete data.folder; delete data.ownership; data.system.equipped = false;
      const [it] = await game.actors.get(buyerId).createEmbeddedDocuments("Item", [data]);
      return it.id;
    }, { SCOPE, buyerId: S.buyerId, picked: S.picked });
  };
  const itemState = (itemId) => gm.evaluate(({ buyerId, itemId }) => {
    const a = game.actors.get(buyerId); const it = a.items.get(itemId);
    return { funds: Number(a.system.eurobucks), equipped: it?.system?.equipped ?? null };
  }, { buyerId: S.buyerId, itemId });
  for (const answer of ["no", "yes"]) {
    const LOW = FEE - 1;
    const itemId = await plant(LOW);
    await pc.waitForTimeout(600);
    await startInstall(pc, S.buyerId, itemId);
    const di = await waitDialog(pc, "install");
    check(`[sheet ${answer}] install dialog shown`, !!di, String(!!di));
    check(`[sheet ${answer}] sheet dialog buttons = ok, cancel (no buyOnly)`, di?.buttons.join(",") === "ok,cancel", di?.buttons.join(","));
    check(`[sheet ${answer}] paySurgery checkbox offered, ticked`, di?.boxes?.paySurgery === true, JSON.stringify(di?.boxes ?? null));
    await answerDialog(pc, "install", { action: "ok" });
    const du = await waitDialog(pc, "unpaid", 6000);
    check(`[sheet ${answer}] shortfall confirm shown (not a refusal)`, !!du, String(!!du));
    check(`[sheet ${answer}] shortfall text states fee ${FEE}eb and ${LOW}eb available`,
      !!du?.text?.includes(`${FEE}eb`) && !!du?.text?.includes(`${LOW}eb`), du?.text ?? "");
    await answerDialog(pc, "unpaid", { action: answer });
    const ri = await waitDone(pc, "__pwInst");
    await gm.waitForTimeout(1200);
    const st = await itemState(itemId);
    if (answer === "no") {
      check("[sheet no] installCyberware returns false", ri === false, JSON.stringify(ri));
      check("[sheet no] item equipped flag stays false", st.equipped === false, String(st.equipped));
      check("[sheet no] funds unchanged", st.funds === LOW, `${st.funds} vs ${LOW}`);
    } else {
      check("[sheet yes] installCyberware returns true", ri === true, JSON.stringify(ri));
      check("[sheet yes] item equipped flag = true", st.equipped === true, String(st.equipped));
      check("[sheet yes] installed with funds unchanged (fee left unpaid)", st.equipped === true && st.funds === LOW, `equipped=${st.equipped} funds=${st.funds} vs ${LOW}`);
      const sm = await gmState(gm, S.buyerId, S.picked.name);
      check("[sheet yes] install summary charged = 0", sm.summaryCharged === 0, String(sm.summaryCharged));
    }
    await pcCloseDialogs(pc);
  }
  {
    // Negative: funds cover the fee → no shortfall confirm, fee charged.
    const itemId = await plant(START_FUNDS);
    await pc.waitForTimeout(600);
    await startInstall(pc, S.buyerId, itemId);
    const di = await waitDialog(pc, "install");
    check("[sheet funded] install dialog shown", !!di, String(!!di));
    await answerDialog(pc, "install", { action: "ok" });
    const du = await waitDialog(pc, "unpaid", 2000);
    check("[sheet funded] NO shortfall confirm when funds cover the fee", du === null, JSON.stringify(du));
    const ri = await waitDone(pc, "__pwInst");
    await gm.waitForTimeout(1200);
    const st = await itemState(itemId);
    check("[sheet funded] installCyberware returns true", ri === true, JSON.stringify(ri));
    check("[sheet funded] item equipped flag = true", st.equipped === true, String(st.equipped));
    check("[sheet funded] funds delta = fee", st.funds === START_FUNDS - FEE, `${st.funds} (want ${START_FUNDS - FEE})`);
    await pcCloseDialogs(pc);
  }

  /* ─────────────────── §5 direct path (approvals off) ─────────────────── */
  console.log("\n§5 direct path, shopBuySource = catalog");
  await gm.evaluate((SCOPE) => game.settings.set(SCOPE, "shopBuySource", "catalog"), SCOPE);
  await pc.waitForTimeout(1000);
  for (const untick of [[], ["paySurgery"]]) {
    const tag = untick.length ? "direct, fee unticked" : "direct, fee paid";
    await reset(gm, S.buyerId);
    await startBuy(pc, S.buyerId, S.picked);
    const dd = await waitDialog(pc, "install");
    check(`[${tag}] install dialog shown on the player's client`, !!dd, String(!!dd));
    const gmd = await gmState(gm, S.buyerId, S.picked.name);
    check(`[${tag}] no dialog on the GM client`, gmd.gmDialogs === 0, String(gmd.gmDialogs));
    await answerDialog(pc, "install", { untick, action: "ok" });
    const rd = await waitDone(pc, "__pwBuy");
    check(`[${tag}] buy call returns {ok:true}`, rd?.ok === true, JSON.stringify(rd));
    await gm.waitForTimeout(1500);
    const sd = await gmState(gm, S.buyerId, S.picked.name);
    const want = START_FUNDS - PART - (untick.length ? 0 : FEE);
    check(`[${tag}] no request card`, sd.requests === 0, String(sd.requests));
    check(`[${tag}] item equipped flag = true`, sd.equipped === true, String(sd.equipped));
    check(`[${tag}] funds = ${want}`, sd.funds === want, String(sd.funds));
    check(`[${tag}] no retired relay card`, sd.retiredCards === 0, String(sd.retiredCards));
  }

  console.log("\n§6 console");
  check("0 console errors on the GM session", gmErrors.length === 0, gmErrors.slice(0, 3).join(" | "));
  check("0 console errors on the player session", pcErrors.length === 0, pcErrors.slice(0, 3).join(" | "));
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  fail++; failed.push("harness threw");
} finally {
  if (gm && S) {
    await gm.evaluate(async ({ SCOPE, buyerId, prevSource }) => {
      try { await game.settings.set(SCOPE, "shopBuySource", prevSource); } catch {}
      try {
        const stray = [...game.messages].filter(m => !window.__pwBefore?.has(m.id)).map(m => m.id);
        if (window.__pwBefore && stray.length) await ChatMessage.deleteDocuments(stray);
      } catch {}
      try { await game.actors.get(buyerId)?.delete(); } catch {}
      for (const a of game.actors.filter(a => a.name?.startsWith("__PW__CYBER"))) await a.delete().catch(() => {});
    }, { SCOPE, buyerId: S.buyerId, prevSource: S.prevSource }).catch(e => console.error("cleanup failed:", e?.message));
  }
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (failed.length) console.log("FAILED: " + failed.join(" || "));
process.exit(fail ? 1 : 0);
