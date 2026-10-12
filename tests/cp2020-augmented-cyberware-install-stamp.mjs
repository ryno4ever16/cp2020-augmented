/**
 * KEEPER: the cyberware install stamp, driven across TWO real sessions (:30004, official 1.1.1 + module).
 *
 * The contract (owner ruling 2026-10-04): a cyberware item remembers the actor it was installed in
 * (`flags.cp2020-augmented.installedIn`). Its FIRST install into that body is the install flow (the
 * install dialog on the acting client; a GM request card when a player acts with approvals on); after
 * that it moves in and out with no dialog.
 *
 *   §0  pure helper truth table (wasInstalledHere)
 *   §1  approvals off: player's first zone drop → dialog on the player only; Cancel changes nothing;
 *       Install → equipped in the dropped zone, stamped, fee charged, Humanity loss rolled, no card
 *   §2  second act: uninstall (stamp kept) → drop again → no dialog, equipped, funds unchanged
 *   §2b an option's first drop onto an installed host implant asks, then nests it there
 *   §3  approvals on: player's drop → dialog on the player only → pending request card, item still
 *       uninstalled + waiting flag; a second drop posts no second card (notice instead); GM Approve
 *       (real click) completes it; §3b GM Deny leaves it uninstalled/unstamped, then a fresh drop asks again
 *   §4  GM drops for the player's actor: dialog on the GM, completes with no card
 *   §5  legacy: created installed with no stamp → uninstall writes the stamp → re-drop, no dialog
 *   §6  copy: stamped for another actor, created on this one → uninstalled, unstamped, loss 0; its first
 *       drop asks; negative: an unstamped item created installed stays installed
 *   §7  item-sheet Install button (real click): dialog on the player, request card with approvals on
 *   §8  shop Buy & Install stamps; Buy Only does not, and its first drop asks
 *   §9  0 console errors on both sessions
 *
 * Drops are real DragEvent("drop") dispatches (with a DataTransfer carrying the item's drag data) on
 * the rendered sheet's own drop-target element; dialog buttons and the request card's Approve/Deny are
 * real DOM clicks on the client that owns them.
 *
 * Run: node tests/cp2020-augmented-cyberware-install-stamp.mjs   (FVTT_URL / FVTT_RIG_PASSWORD optional)
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";
const START_FUNDS = 20000;
const FEE = 500;            // surgery code M on the fixtures

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

/** In-page helpers, installed once per client after join. */
async function installHelpers(page) {
  await page.evaluate((SCOPE) => {
    // The install dialog is the DialogV2 carrying the rollHumanity box.
    window.__pwDialogs = () => [...foundry.applications.instances.values()]
      .filter(a => a instanceof foundry.applications.api.DialogV2 && a.rendered && a.element)
      .filter(a => !!a.element.querySelector('[name="rollHumanity"]') || !!a.element.querySelector(".cp-cyber-install"));
    // Notices this client showed (value assertions on the pending notice).
    window.__pwNotes = [];
    const info = ui.notifications.info.bind(ui.notifications);
    ui.notifications.info = (m, o) => { window.__pwNotes.push(String(m)); return info(m, o); };
    // A real drop: a DragEvent with a DataTransfer carrying the item's drag data, dispatched on the
    // rendered sheet's own drop-target element (the sheet's drop listener resolves it from event.target).
    window.__pwDrop = (actorId, itemUuid, target) => {
      const root = game.actors.get(actorId)?.sheet?.element;
      const el = root?.querySelector(`[data-drop-target="${target}"]`);
      if (!el) return false;
      const dt = new DataTransfer();
      dt.setData("text/plain", JSON.stringify({ type: "Item", uuid: itemUuid }));
      el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    };
    window.__pwSCOPE = SCOPE;
  }, SCOPE);
}

/** Open the actor's sheet on this client and wait until the zone target is in the DOM. */
async function openSheet(page, actorId) {
  return page.evaluate(async (actorId) => {
    const a = game.actors.get(actorId);
    await a.sheet.render(true);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      if (a.sheet.element?.querySelector?.('[data-drop-target="zone:r-arm"]')) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  }, actorId);
}

/** Poll this client for the install dialog; returns what it shows, or null if none appeared. */
async function waitDialog(page, ms = 8000) {
  return page.evaluate(async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const d = window.__pwDialogs().pop();
      if (d) return {
        buttons: [...d.element.querySelectorAll(".window-content button[data-action]")].map(b => b.dataset.action),
        boxes: Object.fromEntries([...d.element.querySelectorAll('input[type="checkbox"]')].map(i => [i.name, i.checked])),
      };
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  }, ms);
}

/** Press a dialog button (real click). */
const answerDialog = (page, action) => page.evaluate((action) => {
  const d = window.__pwDialogs().pop();
  const btn = d?.element.querySelector(`button[data-action="${action}"]`);
  if (!btn) return false;
  btn.click();
  return true;
}, action);

const dialogCount = (page) => page.evaluate(() => window.__pwDialogs().length);
const closeDialogs = (page) => page.evaluate(async () => { for (const d of window.__pwDialogs()) await d.close().catch(() => {}); });
const drop = (page, actorId, itemUuid, target) => page.evaluate(({ actorId, itemUuid, target }) => window.__pwDrop(actorId, itemUuid, target), { actorId, itemUuid, target });

/** GM: one item's state, read from the GM's client. */
const itemState = (gm, actorId, itemId) => gm.evaluate(({ SCOPE, actorId, itemId }) => {
  const a = game.actors.get(actorId); const it = a?.items.get(itemId);
  return {
    exists: !!it, funds: Number(a?.system?.eurobucks),
    equipped: it?.system?.equipped ?? null, side: it?.system?.CyberBodyType?.Location ?? null,
    parentId: it?.system?.Module?.ParentId ?? null,
    stamp: it?.flags?.[SCOPE]?.installedIn ?? null, waiting: it?.flags?.[SCOPE]?.installRequestId ?? null,
    loss: Number(it?.system?.humanityLoss ?? 0), actorUuid: a?.uuid ?? null,
  };
}, { SCOPE, actorId, itemId });

/** GM: install-request cards created since the snapshot. */
const gmRequests = (gm, ms = 0, itemId = null) => gm.evaluate(async ({ SCOPE, ms, itemId }) => {
  const read = () => [...game.messages].filter(m => !window.__pwBefore.has(m.id) && m.getFlag(SCOPE, "installRequest")
    && (!itemId || m.getFlag(SCOPE, "installRequest").itemId === itemId));
  const t0 = Date.now();
  while (ms && read().length === 0 && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 120));
  const gmIds = new Set(game.users.filter(u => u.isGM).map(u => u.id));
  return read().map(m => {
    const req = m.getFlag(SCOPE, "installRequest");
    const dom = [...document.querySelectorAll(`[data-message-id="${m.id}"] .cp-shop-install-request`)].pop();
    return {
      id: m.id, status: req.status, itemId: req.itemId, fee: req.fee, actorUuid: req.actorUuid,
      placementSide: req.placement?.updates?.system?.CyberBodyType?.Location ?? null,
      whisperGMOnly: (m.whisper ?? []).length > 0 && m.whisper.every(id => gmIds.has(id)),
      approveAction: dom?.querySelector(".cp-shop-request-btn.cp-approve")?.dataset?.action ?? null,
      denyAction: dom?.querySelector(".cp-shop-request-btn.cp-deny")?.dataset?.action ?? null,
      surgeryLine: dom?.querySelector(".cp-shop-request-cyber")?.textContent?.trim() ?? null,
    };
  });
}, { SCOPE, ms, itemId });

/** GM: press Approve / Deny on a request card (real click), wait for it to settle. */
const gmResolve = (gm, msgId, action) => gm.evaluate(async ({ SCOPE, msgId, action }) => {
  const sel = `[data-message-id="${msgId}"] .cp-shop-request-btn[data-action="${action}"]`;
  const t0 = Date.now();
  while (!document.querySelector(sel) && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 120));
  const el = [...document.querySelectorAll(sel)].pop();
  if (!el) return { found: false };
  el.click();
  const t1 = Date.now();
  while (Date.now() - t1 < 10000) {
    const m = game.messages.get(msgId);
    if (m?.getFlag(SCOPE, "installRequest")?.status !== "pending" && /cp-shop-request-status/.test(m?.content ?? "")) break;
    await new Promise(r => setTimeout(r, 120));
  }
  await new Promise(r => setTimeout(r, 1500));   // trailing Humanity / summary / whisper messages
  const m = game.messages.get(msgId);
  return { found: true, status: m?.getFlag(SCOPE, "installRequest")?.status ?? null,
    statusText: (/cp-shop-request-status[^>]*>([^<]*)</.exec(m?.content ?? "") ?? [])[1] ?? null };
}, { SCOPE, msgId, action });

/** GM: fresh messages matching a predicate, by content. */
const gmFresh = (gm) => gm.evaluate((SCOPE) => [...game.messages].filter(m => !window.__pwBefore.has(m.id)).map(m => ({
  id: m.id, content: m.content ?? "", whisper: [...(m.whisper ?? [])], req: !!m.getFlag(SCOPE, "installRequest"),
})), SCOPE);

/** GM: create a fixture item on an actor; returns its id + uuid. */
const mkItem = (gm, actorId, name, patch = {}) => gm.evaluate(async ({ actorId, name, patch }) => {
  const data = foundry.utils.mergeObject({
    name, type: "cyberware",
    system: { equipped: false, surgCode: "M", humanityCost: "2d6", humanityLoss: 0, cost: 300,
      MountZone: "Arm", CyberBodyType: { Type: "Arm", Location: "Left" }, CyberWorkType: { Types: ["Implant"], SDP: 0 } },
  }, patch, { inplace: false });
  const [it] = await game.actors.get(actorId).createEmbeddedDocuments("Item", [data]);
  return { id: it.id, uuid: it.uuid };
}, { actorId, name, patch });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let gm = null, pc = null, S = null;
try {
  gm = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  collect(gm, gmErrors);
  await joinAs(gm, /^gamemaster$/i, [GM_PW]);
  await installHelpers(gm);

  S = await gm.evaluate(async ({ SCOPE, START_FUNDS }) => {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__STAMP"))) await a.delete().catch(() => {});
    window.__pwBefore = new Set(game.messages.map(m => m.id));
    const player = game.users.find(u => !u.isGM && /test user 1/i.test(u.name));
    const pcActor = await Actor.create({
      name: "__PW__STAMP Patient", type: "character", system: { eurobucks: START_FUNDS },
      ownership: { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
    });
    const other = await Actor.create({ name: "__PW__STAMP Other", type: "character", system: { eurobucks: 0 } });
    const prevSource = game.settings.get(SCOPE, "shopBuySource");
    await game.settings.set(SCOPE, "shopBuySource", "catalog");   // approvals off for §1-§2
    return { playerName: player?.name, actorId: pcActor.id, actorUuid: pcActor.uuid, otherId: other.id, otherUuid: other.uuid, prevSource };
  }, { SCOPE, START_FUNDS });
  check("fixture: Test User 1 exists", !!S.playerName, String(S.playerName));

  /* ─────────────────── §0 pure helper ─────────────────── */
  console.log("\n§0 wasInstalledHere truth table");
  const T = await gm.evaluate(async (SCOPE) => {
    const I = await import(`/modules/${SCOPE}/module/cyberware/install.js`);
    if (typeof I.wasInstalledHere !== "function") return { missing: true };
    const mk = (stamp, equipped, loss) => ({ parent: { uuid: "Actor.aaa" }, flags: stamp ? { [SCOPE]: { installedIn: stamp } } : {}, system: { equipped, humanityLoss: loss } });
    return {
      stampMatches: I.wasInstalledHere(mk("Actor.aaa", false, 0)),
      stampOther: I.wasInstalledHere(mk("Actor.bbb", false, 0)),
      equipped: I.wasInstalledHere(mk(null, true, 0)),
      loss: I.wasInstalledHere(mk(null, false, 3)),
      lossZeroString: I.wasInstalledHere(mk(null, false, "0")),
      none: I.wasInstalledHere(mk(null, false, 0)),
      nullItem: I.wasInstalledHere(null),
    };
  }, SCOPE);
  check("stamp names the owner → true", T.stampMatches === true, String(T.stampMatches));
  check("stamp names another actor → false", T.stampOther === false, String(T.stampOther));
  check("unstamped, equipped → true", T.equipped === true, String(T.equipped));
  check("unstamped, humanityLoss 3 → true", T.loss === true, String(T.loss));
  check("unstamped, humanityLoss \"0\" → false", T.lossZeroString === false, String(T.lossZeroString));
  check("unstamped, not equipped, no loss → false", T.none === false, String(T.none));
  check("null item → false", T.nullItem === false, String(T.nullItem));

  pc = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  collect(pc, pcErrors);
  await joinAs(pc, new RegExp(`^${S.playerName}$`, "i"), ["", GM_PW]);
  await installHelpers(pc);
  await pc.waitForTimeout(1500);
  check("fixture: second client is a non-GM owning the patient",
    await pc.evaluate((id) => !game.user.isGM && game.actors.get(id)?.isOwner === true, S.actorId), "");
  check("harness: player's sheet renders the r-arm zone target", await openSheet(pc, S.actorId) === true, "");

  /* ─────────────────── §1 approvals off ─────────────────── */
  console.log("\n§1 approvals off: first drop into a zone");
  const A = await mkItem(gm, S.actorId, "__PW__STAMP Arm A");
  await pc.waitForTimeout(700);
  const a0 = await itemState(gm, S.actorId, A.id);
  check("fixture: new item unequipped, unstamped, side Left", a0.equipped === false && a0.stamp === null && a0.side === "Left", JSON.stringify(a0));
  check("drop event dispatched on zone:r-arm", await drop(pc, S.actorId, A.uuid, "zone:r-arm") === true, "");
  const d1 = await waitDialog(pc);
  check("install dialog shown on the player's client", !!d1, String(!!d1));
  check("dialog buttons = ok, cancel", d1?.buttons.join(",") === "ok,cancel", d1?.buttons.join(","));
  check("no dialog on the GM client while the player's is open", await dialogCount(gm) === 0, "");
  await answerDialog(pc, "cancel");
  await pc.waitForTimeout(1200);
  const a1 = await itemState(gm, S.actorId, A.id);
  check("Cancel: equipped flag stays false", a1.equipped === false, String(a1.equipped));
  check("Cancel: side unchanged (Left)", a1.side === "Left", String(a1.side));
  check("Cancel: no stamp", a1.stamp === null, String(a1.stamp));
  check("Cancel: funds unchanged", a1.funds === START_FUNDS, String(a1.funds));
  check("Cancel: humanityLoss stays 0", a1.loss === 0, String(a1.loss));

  await drop(pc, S.actorId, A.uuid, "zone:r-arm");
  const d1b = await waitDialog(pc);
  check("second drop after Cancel: dialog shown again", !!d1b, String(!!d1b));
  await answerDialog(pc, "ok");
  await pc.waitForTimeout(2500);
  const a2 = await itemState(gm, S.actorId, A.id);
  check("Install: equipped flag = true", a2.equipped === true, String(a2.equipped));
  check("Install: placed in the dropped zone (side Right)", a2.side === "Right", String(a2.side));
  check("Install: stamp = patient's uuid", a2.stamp === S.actorUuid, `${a2.stamp} vs ${S.actorUuid}`);
  check("Install: funds delta = fee", a2.funds === START_FUNDS - FEE, `${a2.funds} (want ${START_FUNDS - FEE})`);
  check("Install: humanityLoss rolled (2d6 ≥ 2)", a2.loss >= 2, String(a2.loss));
  check("Install: no install-request card", (await gmRequests(gm)).length === 0, "");
  const sum1 = (await gmFresh(gm)).filter(m => m.content.includes("installed “__PW__STAMP Arm A”"));
  check("Install: one summary message posted", sum1.length === 1, String(sum1.length));

  /* ─────────────────── §2 second act ─────────────────── */
  console.log("\n§2 uninstall, then drop again");
  await pc.evaluate(async ({ actorId, itemId }) => { await game.actors.get(actorId).sheet._cpUninstallCyber(itemId); }, { actorId: S.actorId, itemId: A.id });
  await pc.waitForTimeout(900);
  const a3 = await itemState(gm, S.actorId, A.id);
  check("uninstall: equipped flag = false", a3.equipped === false, String(a3.equipped));
  check("uninstall: stamp kept", a3.stamp === S.actorUuid, String(a3.stamp));
  await drop(pc, S.actorId, A.uuid, "zone:l-arm");
  const d2 = await waitDialog(pc, 2500);
  check("re-drop: no dialog on the player's client", d2 === null, JSON.stringify(d2));
  await pc.waitForTimeout(800);
  const a4 = await itemState(gm, S.actorId, A.id);
  check("re-drop: equipped flag = true", a4.equipped === true, String(a4.equipped));
  check("re-drop: placed in the new zone (side Left)", a4.side === "Left", String(a4.side));
  check("re-drop: funds unchanged", a4.funds === a3.funds, `${a4.funds} vs ${a3.funds}`);
  check("re-drop: humanityLoss not re-rolled", a4.loss === a2.loss, `${a4.loss} vs ${a2.loss}`);

  /* ─────────────────── §2b an option dropped onto an installed host ─────────────────── */
  console.log("\n§2b option's first drop onto a host implant (approvals off)");
  const eye = await mkItem(gm, S.actorId, "__PW__STAMP Eye", { system: { equipped: true, cyberwareType: "CyberOptic", MountZone: "Head",
    CyberBodyType: { Type: "Head", Location: "" }, CyberWorkType: { Types: ["Implant"], OptionsAvailable: 3 } } });
  const opt = await mkItem(gm, S.actorId, "__PW__STAMP Scope", { system: { cyberwareType: "CyberOptic", MountZone: "Head",
    CyberBodyType: { Type: "Head", Location: "" }, CyberWorkType: { Types: [] }, Module: { IsModule: true, SlotsTaken: 1, AllowedParentCyberwareType: "CyberOptic" } } });
  await pc.waitForTimeout(900);
  const o0 = await itemState(gm, S.actorId, opt.id);
  check("harness: host target rendered on the player's sheet",
    await pc.evaluate(({ actorId, id }) => !!game.actors.get(actorId).sheet.element?.querySelector(`[data-drop-target="host:${id}"]`), { actorId: S.actorId, id: eye.id }), "");
  await drop(pc, S.actorId, opt.uuid, `host:${eye.id}`);
  check("option's first drop on the host: dialog shown on the player's client", !!(await waitDialog(pc)), "");
  const o1 = await itemState(gm, S.actorId, opt.id);
  check("while asking: option not nested, not equipped", o1.parentId === "" && o1.equipped === false, `${o1.parentId} ${o1.equipped}`);
  await answerDialog(pc, "ok");
  await pc.waitForTimeout(2500);
  const o2 = await itemState(gm, S.actorId, opt.id);
  check("option Install: nested in the host (ParentId = host id)", o2.parentId === eye.id, `${o2.parentId} vs ${eye.id}`);
  check("option Install: equipped flag = true, stamped", o2.equipped === true && o2.stamp === S.actorUuid, `${o2.equipped} ${o2.stamp}`);
  check("option Install: funds delta = fee", o2.funds === o0.funds - FEE, `${o2.funds} (want ${o0.funds - FEE})`);

  /* ─────────────────── §3 approvals on ─────────────────── */
  console.log("\n§3 approvals on: request, second drop, Approve");
  await gm.evaluate((SCOPE) => game.settings.set(SCOPE, "shopBuySource", "shops"), SCOPE);
  await pc.waitForTimeout(800);
  const B = await mkItem(gm, S.actorId, "__PW__STAMP Arm B");
  await pc.waitForTimeout(700);
  const fundsB0 = (await itemState(gm, S.actorId, B.id)).funds;
  await drop(pc, S.actorId, B.uuid, "zone:r-arm");
  const d3 = await waitDialog(pc);
  check("approvals on: install dialog shown on the player's client", !!d3, String(!!d3));
  check("approvals on: no dialog on the GM client", await dialogCount(gm) === 0, "");
  check("approvals on: no request card while the dialog is open", (await gmRequests(gm)).length === 0, "");
  await answerDialog(pc, "ok");
  const q3 = (await gmRequests(gm, 8000, B.id));
  check("one install-request card reached the GM", q3.length === 1, String(q3.length));
  const r3 = q3[0];
  check("request flag status = pending", r3?.status === "pending", String(r3?.status));
  check("request flag fee = 500", r3?.fee === FEE, String(r3?.fee));
  check("request flag actorUuid = patient", r3?.actorUuid === S.actorUuid, String(r3?.actorUuid));
  check("request flag carries the placement (side Right)", r3?.placementSide === "Right", String(r3?.placementSide));
  check("request whispered to GMs only", r3?.whisperGMOnly === true, String(r3?.whisperGMOnly));
  check("wiring: rendered Approve/Deny carry data-action", r3?.approveAction === "approve" && r3?.denyAction === "deny", `${r3?.approveAction}/${r3?.denyAction}`);
  const wantLine = await gm.evaluate(() => game.i18n.format("CYBERPUNK.CyberInstallRequestSurgery", { surgery: game.i18n.localize("CYBERPUNK.Minor") === "CYBERPUNK.Minor" ? "Minor" : game.i18n.localize("CYBERPUNK.Minor"), cost: 500 }));
  check("rendered surgery line = CyberInstallRequestSurgery text", r3?.surgeryLine === wantLine, `${r3?.surgeryLine} | want ${wantLine}`);
  await pc.waitForTimeout(500);
  const b1 = await itemState(gm, S.actorId, B.id);
  check("pending: equipped flag stays false", b1.equipped === false, String(b1.equipped));
  check("pending: side unchanged (Left)", b1.side === "Left", String(b1.side));
  check("pending: waiting flag = request card id", b1.waiting === r3?.id, `${b1.waiting} vs ${r3?.id}`);
  check("pending: funds unchanged", b1.funds === fundsB0, `${b1.funds} vs ${fundsB0}`);
  check("pending: no stamp", b1.stamp === null, String(b1.stamp));

  await pc.evaluate(() => { window.__pwNotes.length = 0; });
  await drop(pc, S.actorId, B.uuid, "zone:r-arm");
  const d3b = await waitDialog(pc, 2500);
  check("second drop while pending: no dialog", d3b === null, JSON.stringify(d3b));
  const notes = await pc.evaluate(() => window.__pwNotes.slice());
  const wantNote = await pc.evaluate(() => game.i18n.format("CYBERPUNK.CyberInstallPending", { item: "__PW__STAMP Arm B" }));
  check("second drop while pending: pending notice shown", notes.includes(wantNote), JSON.stringify(notes));
  check("second drop while pending: still one request card", (await gmRequests(gm)).filter(r => r.itemId === B.id).length === 1, "");

  const ap = await gmResolve(gm, r3?.id, "approve");
  check("GM Approve clicked; status = approved", ap.found && ap.status === "approved", JSON.stringify(ap));
  const b2 = await itemState(gm, S.actorId, B.id);
  check("Approve: equipped flag = true", b2.equipped === true, String(b2.equipped));
  check("Approve: placed in the dropped zone (side Right)", b2.side === "Right", String(b2.side));
  check("Approve: stamp = patient's uuid", b2.stamp === S.actorUuid, String(b2.stamp));
  check("Approve: funds delta = fee", b2.funds === fundsB0 - FEE, `${b2.funds} (want ${fundsB0 - FEE})`);
  check("Approve: humanityLoss rolled (≥ 2)", b2.loss >= 2, String(b2.loss));
  check("Approve: waiting flag cleared", b2.waiting === null, String(b2.waiting));
  check("Approve: no dialog on either client", await dialogCount(gm) === 0 && await dialogCount(pc) === 0, "");

  console.log("\n§3b approvals on: Deny");
  const C = await mkItem(gm, S.actorId, "__PW__STAMP Arm C");
  await pc.waitForTimeout(700);
  const fundsC0 = (await itemState(gm, S.actorId, C.id)).funds;
  await drop(pc, S.actorId, C.uuid, "zone:r-arm");
  check("deny run: dialog shown on the player's client", !!(await waitDialog(pc)), "");
  await answerDialog(pc, "ok");
  const r3c = (await gmRequests(gm, 8000, C.id))[0];
  check("deny run: request card posted", !!r3c, String(!!r3c));
  const before = new Set((await gmFresh(gm)).map(m => m.id));
  const dn = await gmResolve(gm, r3c?.id, "deny");
  check("GM Deny clicked; status = denied", dn.found && dn.status === "denied", JSON.stringify(dn));
  const c1 = await itemState(gm, S.actorId, C.id);
  check("Deny: equipped flag stays false", c1.equipped === false, String(c1.equipped));
  check("Deny: no stamp", c1.stamp === null, String(c1.stamp));
  check("Deny: funds unchanged", c1.funds === fundsC0, `${c1.funds} vs ${fundsC0}`);
  check("Deny: waiting flag cleared", c1.waiting === null, String(c1.waiting));
  check("Deny: humanityLoss stays 0", c1.loss === 0, String(c1.loss));
  const wantDeny = await gm.evaluate(() => game.i18n.format("CYBERPUNK.CyberInstallRequestDeniedWhisper", { item: "__PW__STAMP Arm C", actor: "__PW__STAMP Patient" }));
  const denyMsgs = (await gmFresh(gm)).filter(m => !before.has(m.id) && m.content === wantDeny);
  check("Deny: one whisper to the requester with the deny text", denyMsgs.length === 1 && denyMsgs[0].whisper.length === 1, JSON.stringify(denyMsgs.map(m => m.whisper)));
  await pc.waitForTimeout(500);
  await drop(pc, S.actorId, C.uuid, "zone:r-arm");
  check("after Deny, a fresh drop asks again (dialog shown)", !!(await waitDialog(pc)), "");
  await answerDialog(pc, "cancel");
  await pc.waitForTimeout(600);

  /* ─────────────────── §4 GM drop ─────────────────── */
  console.log("\n§4 GM drops for the player's actor");
  const D = await mkItem(gm, S.actorId, "__PW__STAMP Arm D");
  check("harness: GM's sheet renders the zone target", await openSheet(gm, S.actorId) === true, "");
  const fundsD0 = (await itemState(gm, S.actorId, D.id)).funds;
  const reqsD0 = (await gmRequests(gm)).length;
  await drop(gm, S.actorId, D.uuid, "zone:r-arm");
  check("GM drop: dialog shown on the GM client", !!(await waitDialog(gm)), "");
  check("GM drop: no dialog on the player client", await dialogCount(pc) === 0, "");
  await answerDialog(gm, "ok");
  await gm.waitForTimeout(2500);
  const dd = await itemState(gm, S.actorId, D.id);
  check("GM drop: equipped flag = true, side Right", dd.equipped === true && dd.side === "Right", `${dd.equipped} ${dd.side}`);
  check("GM drop: stamp = patient's uuid", dd.stamp === S.actorUuid, String(dd.stamp));
  check("GM drop: funds delta = fee", dd.funds === fundsD0 - FEE, `${dd.funds} (want ${fundsD0 - FEE})`);
  check("GM drop: no request card", (await gmRequests(gm)).length === reqsD0, "");
  await gm.evaluate((id) => game.actors.get(id).sheet.close(), S.actorId);

  /* ─────────────────── §5 legacy ─────────────────── */
  console.log("\n§5 legacy chrome: created installed, no stamp");
  const E = await mkItem(gm, S.actorId, "__PW__STAMP Arm E", { system: { equipped: true, CyberBodyType: { Location: "Right" } } });
  await pc.waitForTimeout(700);
  const e0 = await itemState(gm, S.actorId, E.id);
  check("negative: an unstamped item created installed stays installed", e0.equipped === true, String(e0.equipped));
  check("legacy fixture: no stamp, loss 0", e0.stamp === null && e0.loss === 0, JSON.stringify(e0));
  await pc.evaluate(async ({ actorId, itemId }) => { await game.actors.get(actorId).sheet._cpUninstallCyber(itemId); }, { actorId: S.actorId, itemId: E.id });
  await pc.waitForTimeout(900);
  const e1 = await itemState(gm, S.actorId, E.id);
  check("legacy uninstall: equipped flag = false", e1.equipped === false, String(e1.equipped));
  check("legacy uninstall: stamp written = patient's uuid", e1.stamp === S.actorUuid, String(e1.stamp));
  await drop(pc, S.actorId, E.uuid, "zone:r-arm");
  check("legacy re-drop: no dialog", (await waitDialog(pc, 2500)) === null, "");
  await pc.waitForTimeout(600);
  const e2 = await itemState(gm, S.actorId, E.id);
  check("legacy re-drop: equipped flag = true, funds unchanged", e2.equipped === true && e2.funds === e1.funds, `${e2.equipped} ${e2.funds}/${e1.funds}`);

  /* ─────────────────── §6 a copy from another actor ─────────────────── */
  console.log("\n§6 copy of chrome stamped for another actor");
  const cp = await gm.evaluate(async ({ SCOPE, otherId, otherUuid, actorId }) => {
    const other = game.actors.get(otherId);
    const [src] = await other.createEmbeddedDocuments("Item", [{
      name: "__PW__STAMP Arm F", type: "cyberware",
      flags: { [SCOPE]: { installedIn: otherUuid } },
      system: { equipped: true, surgCode: "M", humanityCost: "2d6", humanityLoss: 4, cost: 300,
        MountZone: "Arm", CyberBodyType: { Type: "Arm", Location: "Left" }, CyberWorkType: { Types: ["Implant"], SDP: 0 } },
    }]);
    // A sheet-to-sheet drag creates the dropped item's own source data on the receiving actor.
    const [copy] = await game.actors.get(actorId).createEmbeddedDocuments("Item", [src.toObject()]);
    return {
      src: { equipped: src.system.equipped, stamp: src.flags?.[SCOPE]?.installedIn ?? null, loss: src.system.humanityLoss },
      copyId: copy.id, copyUuid: copy.uuid,
    };
  }, { SCOPE, otherId: S.otherId, otherUuid: S.otherUuid, actorId: S.actorId });
  check("source on the other actor keeps its stamp, equipped, loss", cp.src.equipped === true && cp.src.stamp === S.otherUuid && cp.src.loss === 4, JSON.stringify(cp.src));
  const f0 = await itemState(gm, S.actorId, cp.copyId);
  check("copy arrives with equipped flag = false", f0.equipped === false, String(f0.equipped));
  check("copy arrives with no stamp", f0.stamp === null, String(f0.stamp));
  check("copy arrives with humanityLoss 0", f0.loss === 0, String(f0.loss));
  await pc.waitForTimeout(600);
  await drop(pc, S.actorId, cp.copyUuid, "zone:r-arm");
  check("copy's first drop: dialog shown", !!(await waitDialog(pc)), "");
  await answerDialog(pc, "cancel");
  await pc.waitForTimeout(600);

  /* ─────────────────── §7 item-sheet Install button ─────────────────── */
  console.log("\n§7 item sheet Install button (approvals on)");
  const G = await mkItem(gm, S.actorId, "__PW__STAMP Arm G");
  await pc.waitForTimeout(700);
  const btn = await pc.evaluate(async ({ actorId, itemId }) => {
    const it = game.actors.get(actorId).items.get(itemId);
    await it.sheet.render(true);
    const t0 = Date.now();
    let el = null;
    while (!el && Date.now() - t0 < 8000) { el = it.sheet.element?.querySelector?.(".cyber-install"); if (!el) await new Promise(r => setTimeout(r, 100)); }
    if (!el) return false;
    el.click();
    return true;
  }, { actorId: S.actorId, itemId: G.id });
  check("item sheet Install button found and clicked", btn === true, String(btn));
  check("Install button: dialog shown on the player's client", !!(await waitDialog(pc)), "");
  await answerDialog(pc, "ok");
  const q7 = (await gmRequests(gm, 8000, G.id));
  check("Install button: one pending install-request card", q7.length === 1 && q7[0].status === "pending", JSON.stringify(q7.map(r => r.status)));
  check("Install button: request carries no placement", q7[0]?.placementSide === null, String(q7[0]?.placementSide));
  await pc.waitForTimeout(500);   // the waiting flag is written just after the card is created
  const g1 = await itemState(gm, S.actorId, G.id);
  check("Install button: item still uninstalled, waiting on that card", g1.equipped === false && g1.waiting === q7[0]?.id, `${g1.equipped} ${g1.waiting}`);
  await pc.evaluate(({ actorId, itemId }) => game.actors.get(actorId).items.get(itemId)?.sheet?.close(), { actorId: S.actorId, itemId: G.id });

  /* ─────────────────── §7b the button is the PAID path, always (owner ruling 2026-10-12) ─────────────────── */
  // The drag back into a body location stays free for chrome that has been in this body (§2). The
  // sheet's button opens the install dialog every time: for chrome created already installed with no
  // Humanity rolled (a macro-made character) it charges and rolls; for chrome that was installed
  // through the flow and taken out it charges again and offers the Humanity roll UNTICKED.
  console.log("\n§7b item sheet button = the paid path (approvals off, GM client)");
  await gm.evaluate((SCOPE) => game.settings.set(SCOPE, "shopBuySource", "catalog"), SCOPE);
  const pressButton = (page, actorId, itemId) => page.evaluate(async ({ actorId, itemId }) => {
    const it = game.actors.get(actorId).items.get(itemId);
    await it.sheet.render(true);
    const t0 = Date.now(); let el = null;
    while (!el && Date.now() - t0 < 8000) { el = it.sheet.element?.querySelector?.(".cyber-install"); if (!el) await new Promise(r => setTimeout(r, 100)); }
    const label = el?.textContent?.trim() ?? null;
    if (el) el.click();
    return { found: !!el, label };
  }, { actorId, itemId });
  const dialogTicks = (page) => page.evaluate(() => {
    const d = [...foundry.applications.instances.values()].find(a => !!a.element?.querySelector?.('[name="rollHumanity"]'));
    const r = d?.element; if (!r) return null;
    return { roll: r.querySelector('[name="rollHumanity"]')?.checked ?? null, pay: r.querySelector('[name="paySurgery"]')?.checked ?? null };
  });
  // (a) created INSTALLED, unstamped, no loss - the macro-made case.
  const M = await mkItem(gm, S.actorId, "__PW__STAMP Macro Arm", { system: { equipped: true } });
  const m0 = await itemState(gm, S.actorId, M.id);
  const mb = await pressButton(gm, S.actorId, M.id);
  check("§7b macro-made chrome (installed, no stamp, no loss): the sheet offers the paid button", mb.found === true, JSON.stringify(mb));
  const md = await waitDialog(gm);
  const mt = await dialogTicks(gm);
  check("§7b its dialog opens with Humanity ticked (none rolled yet) and the fee ticked", !!md && mt?.roll === true && mt?.pay === true, JSON.stringify(mt));
  await answerDialog(gm, "ok");
  await gm.waitForTimeout(1500);
  const m1 = await itemState(gm, S.actorId, M.id);
  check("§7b OK: fee charged, Humanity rolled, stamped, still installed", m1.funds === m0.funds - FEE && m1.loss > 0 && m1.stamp === S.actorUuid && m1.equipped === true, JSON.stringify({ before: m0.funds, after: m1.funds, loss: m1.loss, stamp: m1.stamp, eq: m1.equipped }));
  await gm.evaluate(({ actorId, itemId }) => game.actors.get(actorId).items.get(itemId)?.sheet?.close(), { actorId: S.actorId, itemId: M.id });
  // (b) installed through the flow (stamped, loss rolled), taken out: the button charges again, Humanity unticked.
  await gm.evaluate(({ actorId, itemId }) => game.actors.get(actorId).items.get(itemId).update({ "system.equipped": false }), { actorId: S.actorId, itemId: M.id });
  await gm.waitForTimeout(400);
  const r0 = await itemState(gm, S.actorId, M.id);
  const rb = await pressButton(gm, S.actorId, M.id);
  const rd = await waitDialog(gm);
  const rt = await dialogTicks(gm);
  check("§7b taken out and pressed again: a dialog, not a free re-install; Humanity UNticked (already rolled), fee ticked", rb.found === true && !!rd && rt?.roll === false && rt?.pay === true, JSON.stringify({ rb, rt }));
  await answerDialog(gm, "ok");
  await gm.waitForTimeout(1500);
  const r1 = await itemState(gm, S.actorId, M.id);
  check("§7b OK: charged again, loss unchanged, installed", r1.funds === r0.funds - FEE && r1.loss === r0.loss && r1.equipped === true, JSON.stringify({ before: r0.funds, after: r1.funds, loss0: r0.loss, loss1: r1.loss, eq: r1.equipped }));
  await gm.evaluate(({ actorId, itemId }) => game.actors.get(actorId).items.get(itemId)?.sheet?.close(), { actorId: S.actorId, itemId: M.id });
  // (c) the drag back in is still free (the §2 contract, restated beside the button's).
  await gm.evaluate(({ actorId, itemId }) => game.actors.get(actorId).items.get(itemId).update({ "system.equipped": false }), { actorId: S.actorId, itemId: M.id });
  await gm.waitForTimeout(400);
  const x0 = await itemState(gm, S.actorId, M.id);
  check("§7b harness: GM's sheet renders the zone target", await openSheet(gm, S.actorId) === true, "");
  check("§7b drop event dispatched on zone:l-arm", await drop(gm, S.actorId, M.uuid, "zone:l-arm") === true, "");
  await gm.waitForTimeout(1200);
  const xd = await gm.evaluate(() => [...foundry.applications.instances.values()].some(a => !!a.element?.querySelector?.('[name="rollHumanity"]')));
  const x1 = await itemState(gm, S.actorId, M.id);
  check("§7b the drag back into a body location is still free: no dialog, installed, funds unchanged", xd === false && x1.equipped === true && x1.funds === x0.funds, JSON.stringify({ dialog: xd, eq: x1.equipped, before: x0.funds, after: x1.funds }));

  /* ─────────────────── §8 shop Buy & Install / Buy Only ─────────────────── */
  console.log("\n§8 shop Buy & Install stamps, Buy Only does not");
  const buy = async (action, name) => {
    await gm.evaluate(({ SCOPE, actorId, name }) => {
      window.__pwBuy = { done: false };
      import(`/modules/${SCOPE}/module/cyberware/install.js`).then(I => I.buyAndInstallCyberware(game.actors.get(actorId), {
        name, type: "cyberware",
        system: { equipped: false, surgCode: "M", humanityCost: "2d6", humanityLoss: 0, cost: 300,
          MountZone: "Arm", CyberBodyType: { Type: "Arm", Location: "Left" }, CyberWorkType: { Types: ["Implant"], SDP: 0 } },
      }, { partPrice: 300 })).then(r => { window.__pwBuy = { done: true, r }; }, e => { window.__pwBuy = { done: true, r: String(e) }; });
    }, { SCOPE, actorId: S.actorId, name });
    const d = await waitDialog(gm);
    await answerDialog(gm, action);
    await gm.waitForFunction(() => window.__pwBuy?.done === true, undefined, { timeout: 10000 }).catch(() => {});
    await gm.waitForTimeout(800);
    return gm.evaluate(({ SCOPE, actorId, name }) => {
      const it = game.actors.get(actorId).items.find(i => i.name === name);
      return { dialog: true, id: it?.id ?? null, uuid: it?.uuid ?? null, equipped: it?.system?.equipped ?? null, stamp: it?.flags?.[SCOPE]?.installedIn ?? null };
    }, { SCOPE, actorId: S.actorId, name }).then(r => ({ ...r, dialog: !!d }));
  };
  const h = await buy("ok", "__PW__STAMP Shop Install");
  check("Buy & Install: dialog shown on the buyer's client", h.dialog, "");
  check("Buy & Install: item equipped flag = true", h.equipped === true, String(h.equipped));
  check("Buy & Install: stamp = patient's uuid", h.stamp === S.actorUuid, String(h.stamp));
  const k = await buy("buyOnly", "__PW__STAMP Shop Only");
  check("Buy Only: item equipped flag = false", k.equipped === false, String(k.equipped));
  check("Buy Only: no stamp", k.stamp === null, String(k.stamp));
  await pc.waitForTimeout(600);
  await drop(pc, S.actorId, k.uuid, "zone:r-arm");
  check("Buy Only item's first drop: dialog shown", !!(await waitDialog(pc)), "");
  await answerDialog(pc, "cancel");
  await pc.waitForTimeout(600);

  console.log("\n§9 console");
  check("0 console errors on the GM session", gmErrors.length === 0, gmErrors.slice(0, 3).join(" | "));
  check("0 console errors on the player session", pcErrors.length === 0, pcErrors.slice(0, 3).join(" | "));
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  fail++; failed.push("harness threw");
} finally {
  if (pc) await closeDialogs(pc).catch(() => {});
  if (gm && S) {
    await closeDialogs(gm).catch(() => {});
    await gm.evaluate(async ({ SCOPE, prevSource }) => {
      try { await game.settings.set(SCOPE, "shopBuySource", prevSource); } catch {}
      try {
        const stray = [...game.messages].filter(m => !window.__pwBefore?.has(m.id)).map(m => m.id);
        if (window.__pwBefore && stray.length) await ChatMessage.deleteDocuments(stray);
      } catch {}
      for (const a of game.actors.filter(a => a.name?.startsWith("__PW__STAMP"))) await a.delete().catch(() => {});
    }, { SCOPE, prevSource: S.prevSource }).catch(e => console.error("cleanup failed:", e?.message));
  }
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (failed.length) console.log("FAILED: " + failed.join(" || "));
process.exit(fail ? 1 : 0);
