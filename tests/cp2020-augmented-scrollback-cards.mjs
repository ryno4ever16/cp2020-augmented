/**
 * Chat scrollback: card injectors must run on the batch-rendered log (:30004, official 1.1.1 + module).
 *
 * Defect (rig-measured 2026-08-10 on Foundry 14.364, same code path in 13.350): after a page reload
 * every card already in the log came back stripped —
 *   - a card carrying the module's damage payload flag showed NO Apply Damage control,
 *   - a card stamped resolved lost its locked appearance (buttons live again, no re-arm control),
 *   - a shop card's controls were never wired.
 * A card posted while you watch was fine, which is why this stayed hidden.
 *
 * MEASURED CAUSE — a registration-ordering defect, not a missing hook. Core repopulates the log with
 * a BATCH render (`ChatLog#renderBatch` → `#doRenderBatch`) and DOES emit `renderChatMessageHTML`
 * once per message on it. But `ChatLog#_onFirstRender` awaits that batch while the UI is being built,
 * which finishes before the `ready` hook the module wires its card passes in. Instrumented order on a
 * 100-message log:
 *     init → renderBatch enter → renderChatMessageHTML ×100 → renderBatch exit → renderChatLog → ready
 * So every message already in the log had its one and only render pass fire before any listener
 * existed. The scroll-up "load more" batch was never affected — listeners are registered by then.
 *
 * The keeper drives the honest repro: post the card shapes, prove the LIVE path decorates them, then
 * `page.reload()` and re-read the same cards off the rebuilt log.
 *
 * RED before the fix: 0 apply controls / no lock class / unwired shop controls after reload.
 * GREEN after: exactly 1 apply control, lock class + disabled buttons + re-arm control, wired shop
 * controls — and no card anywhere ends up with two, so the passes stay idempotent where the catch-up
 * and the render hook both reach one card. An unmarked card is asserted undecorated throughout.
 *
 * Run from fork tests/:
 *   FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-scrollback-cards.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";

async function joinAs(page, match, passwords) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 30_000 });
  const users = await sel.locator("option").evaluateAll((o) =>
    o.map((x) => ({ v: x.value, l: (x.textContent || "").trim() })).filter((x) => x.v));
  const u = users.find((x) => match.test(x.l));
  if (!u) throw new Error("no user matching " + match);
  for (const pw of passwords) {
    await sel.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([
      page.waitForNavigation({ url: /\/game/, timeout: 15_000 }).catch(() => {}),
      page.locator('button[name="join"]').click(),
    ]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 30_000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await sel.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join as " + u.l);
}

/** Read the decoration state of the three probe cards straight off the live DOM. */
const READ_CARDS = (ids) => {
  const pick = (id) => document.querySelector(`[data-message-id="${id}"]`);
  const payloadEl = pick(ids.payload);
  const stampedEl = pick(ids.stamped);
  const shopEl = pick(ids.shop);
  const requestEl = pick(ids.request);
  const plainEl = pick(ids.plain);
  const stampedCard = stampedEl?.querySelector(".cyberpunk-card, .cyberpunk") ?? null;
  const shopBtn = shopEl?.querySelector(".cp-shop-open-link") ?? null;
  const requestBtn = requestEl?.querySelector(".cp-shop-request-btn") ?? null;
  return {
    payloadElPresent: !!payloadEl,
    applyBtnCount: payloadEl ? payloadEl.querySelectorAll(".cp2020-apply-damage-btn").length : -1,
    stampedElPresent: !!stampedEl,
    lockClass: stampedCard ? stampedCard.classList.contains("cp-card-resolved") : null,
    stampedDisabled: stampedCard
      ? [...stampedCard.querySelectorAll("button")].filter(b => !b.classList.contains("cp-card-rearm")).every(b => b.disabled)
      : null,
    rearmCount: stampedCard ? stampedCard.querySelectorAll(".cp-card-rearm").length : -1,
    shopElPresent: !!shopEl,
    shopBound: shopBtn ? shopBtn.dataset.cpBound === "1" : null,
    requestElPresent: !!requestEl,
    requestBound: requestBtn ? requestBtn.dataset.cpBound === "1" : null,
    // Negative case: a card carrying none of the three markers must come back undecorated — no
    // apply control, no lock class, no bound shop control (the shop pass's early-out bails here).
    plainUntouched: plainEl
      ? plainEl.querySelectorAll(".cp2020-apply-damage-btn, .cp-card-resolved, [data-cp-bound]").length === 0
        && !plainEl.querySelector(".cyberpunk")?.classList.contains("cp-card-resolved")
      : null,
    // Stacking guard across the WHOLE log, not just the probe card: the catch-up pass and the
    // per-message hook can both reach a card, so no card anywhere may end up with two controls.
    // (The log legitimately holds other payload cards from earlier runs — they get their control
    // back too, which is the fix working; only a count above 1 on a single card is a defect.)
    maxApplyPerCard: Math.max(0, ...[...document.querySelectorAll("[data-message-id]")]
      .map(li => li.querySelectorAll(".cp2020-apply-damage-btn").length)),
    maxRearmPerCard: Math.max(0, ...[...document.querySelectorAll("[data-message-id]")]
      .map(li => li.querySelectorAll(".cp-card-rearm").length)),
    logApplyTotal: document.querySelectorAll(".cp2020-apply-damage-btn").length,
  };
};

const browser = await chromium.launch({ headless: true });
let failures = 0;
const rows = [];
const consoleErrors = [];
let ids = null;
let page = null;

const check = (phase, name, ok, actual) => {
  if (!ok) failures++;
  rows.push(`  [${ok ? "PASS" : "FAIL"}] ${phase.padEnd(10)} ${name.padEnd(46)} = ${actual}`);
};

try {
  page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + (e?.message || e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push("console: " + m.text()); });

  await joinAs(page, /^gamemaster$/i, [GM_PW]);
  await page.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});

  // ── Fixtures: one card per injector, in the shape each injector keys on ───────────────────────
  ids = await page.evaluate(async (scope) => {
    // A card carrying the module's damage payload flag. areaDamages must be non-empty — that is the
    // injector's own precondition. No actor ids: the GM branch decorates regardless of ownership.
    const payload = await ChatMessage.create({
      content: '<div class="cyberpunk-card"><p>__PW__ scrollback payload card</p></div>',
      flags: { [scope]: { damagePayload: { areaDamages: { torso: 12 }, attackerId: null, actorId: null } } },
    });
    // A prompt card already stamped resolved — the lock pass should re-lock it on every render.
    const stamped = await ChatMessage.create({
      content: '<div class="cyberpunk save-prompt"><p>__PW__ scrollback stamped card</p>'
             + '<div class="save-buttons"><button class="cp-stun-save-roll">Roll</button></div></div>',
      flags: { [scope]: { cardResolved: { resolved: true, at: Date.now(), by: game.user.id } } },
    });
    // A shop link card — its control is wired by a dataset flag, not by markup.
    const shop = await ChatMessage.create({
      content: '<div class="cyberpunk cp-shop-publish"><p>__PW__ scrollback shop card</p>'
             + '<button class="cp-shop-open-link" data-shop-id="__PW__none">Browse</button></div>',
    });
    // A GM purchase-request card — the shop pass's OTHER control, and the one whose wiring the
    // pass's content-marker early-out has to keep reaching.
    const request = await ChatMessage.create({
      content: '<div class="cp-shop-request"><p>__PW__ scrollback request card</p>'
             + '<div class="cp-shop-request-actions">'
             + '<button type="button" class="cp-shop-request-btn cp-approve" data-action="approve">Approve</button>'
             + '<button type="button" class="cp-shop-request-btn cp-deny" data-action="deny">Deny</button></div></div>',
      whisper: [game.user.id],
    });
    // A card carrying none of the three markers — the negative case: every pass must leave it alone.
    const plain = await ChatMessage.create({
      content: '<div class="cyberpunk"><p>__PW__ scrollback plain card</p><button>Inert</button></div>',
    });
    return { payload: payload.id, stamped: stamped.id, shop: shop.id, request: request.id, plain: plain.id };
  }, SCOPE);

  // Give the live render pass time to land before reading it.
  await page.waitForFunction(
    (i) => !!document.querySelector(`[data-message-id="${i.plain}"]`),
    ids, { timeout: 15_000 });
  await page.waitForTimeout(1500);

  // ── Phase 1: LIVE path (positive control — this path already worked) ─────────────────────────
  const live = await page.evaluate(READ_CARDS, ids);
  check("live", "payload card element present", live.payloadElPresent === true, live.payloadElPresent);
  check("live", "apply control count on payload card", live.applyBtnCount === 1, live.applyBtnCount);
  check("live", "stamped card carries the lock class", live.lockClass === true, live.lockClass);
  check("live", "stamped card action buttons disabled", live.stampedDisabled === true, live.stampedDisabled);
  check("live", "re-arm control count (GM)", live.rearmCount === 1, live.rearmCount);
  check("live", "shop link control wired", live.shopBound === true, live.shopBound);
  check("live", "shop request control wired (GM)", live.requestBound === true, live.requestBound);
  check("live", "unmarked card left undecorated", live.plainUntouched === true, live.plainUntouched);

  // ── Phase 2: BATCH path — a full reload rebuilds the log from scratch ────────────────────────
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 60_000 });
  // Wait for the rebuilt log to actually carry the probe cards, then let the ready-time wiring settle.
  await page.waitForFunction(
    (i) => !!document.querySelector(`[data-message-id="${i.plain}"]`),
    ids, { timeout: 30_000 });
  await page.waitForTimeout(3000);

  const back = await page.evaluate(READ_CARDS, ids);
  check("scrollback", "payload card element present", back.payloadElPresent === true, back.payloadElPresent);
  check("scrollback", "apply control count on payload card", back.applyBtnCount === 1, back.applyBtnCount);
  check("scrollback", "stamped card carries the lock class", back.lockClass === true, back.lockClass);
  check("scrollback", "stamped card action buttons disabled", back.stampedDisabled === true, back.stampedDisabled);
  check("scrollback", "re-arm control count (GM)", back.rearmCount === 1, back.rearmCount);
  check("scrollback", "shop link control wired", back.shopBound === true, back.shopBound);
  check("scrollback", "shop request control wired (GM)", back.requestBound === true, back.requestBound);
  check("scrollback", "unmarked card left undecorated", back.plainUntouched === true, back.plainUntouched);
  check("scrollback", "no card in the log carries two apply controls", back.maxApplyPerCard === 1, `max ${back.maxApplyPerCard} per card, ${back.logApplyTotal} in the log`);
  check("scrollback", "no card in the log carries two re-arm controls", back.maxRearmPerCard <= 1, back.maxRearmPerCard);

  // ── Phase 3: re-render the SAME cards again — both paths firing must not stack anything ──────
  const twice = await page.evaluate(async (i) => {
    for (const id of Object.values(i)) await game.messages.get(id)?.render?.(true);
    await ui.chat?.render?.({ force: true });
    await new Promise(r => setTimeout(r, 2500));
    return null;
  }, ids);
  void twice;
  const after = await page.evaluate(READ_CARDS, ids);
  check("re-render", "apply control still exactly one", after.applyBtnCount === 1, after.applyBtnCount);
  check("re-render", "re-arm control still exactly one", after.rearmCount === 1, after.rearmCount);
  check("re-render", "stamped card still locked", after.lockClass === true, after.lockClass);
  check("re-render", "shop link control still wired once", after.shopBound === true, after.shopBound);
  check("re-render", "shop request control still wired once", after.requestBound === true, after.requestBound);
  check("re-render", "unmarked card still undecorated", after.plainUntouched === true, after.plainUntouched);
  check("re-render", "no card in the log carries two apply controls", after.maxApplyPerCard === 1, `max ${after.maxApplyPerCard} per card`);
  check("re-render", "no card in the log carries two re-arm controls", after.maxRearmPerCard <= 1, after.maxRearmPerCard);

  check("session", "0 console errors", consoleErrors.length === 0, consoleErrors.length ? consoleErrors.slice(0, 4).join(" | ") : "0");

  console.log("Chat scrollback card-injector sweep\n" + rows.join("\n"));
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S) — RED"}  (${rows.length} checks)`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  // Clean up only what this run created.
  if (page && ids) {
    await page.evaluate(async (i) => {
      for (const id of Object.values(i)) { try { await game.messages.get(id)?.delete(); } catch (e) { /* already gone */ } }
    }, ids).catch(() => {});
  }
  await browser.close();
}
