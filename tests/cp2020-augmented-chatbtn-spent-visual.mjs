/**
 * Chat-card action buttons: spent-visual + non-selectable regression (:30004, official 1.1.1 + module).
 *
 * Defect (user-reported 2026-07-02): after a confirm/scatter chat button is clicked the handler sets
 * `disabled=true`, but the button (a) still looks fully active (no spent visual — only the cursor changes)
 * and (b) its label is drag-highlightable, because our unstyled chat buttons INHERIT `user-select:text`
 * from Foundry's `.message-content` and nothing resets it. Together that reads as "the button turned into
 * a highlightable text field and stopped being a button."
 *
 * Fix: one shared CSS rule scoped to our chat card families (.cyberpunk / .cyberpunk-card / .cp-shop-request):
 *   - user-select: none  (label no longer highlights)
 *   - button:disabled { opacity<1 + cursor:default + grayscale }  (a CLEAR spent visual)
 *   - button chrome retained (still a button, just greyed) — keep-as-button, not replaced.
 *
 * RED before the CSS rule (user-select=text, opacity=1); GREEN after. Covers every chat button family
 * (closed enumeration) so the sweep is verified, not assumed.
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-chatbtn-spent-visual.mjs
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";

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
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 15_000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await sel.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join as " + u.l);
}

// One representative per chat-card button family — the CLOSED enumeration, regenerated from a
// templates/chat scan (every `<button class="cp-…">` under templates/chat + the JS-injected apply card).
// Each wrapper carries the real card's root classes so the spent-visual/user-select CSS scope is tested
// faithfully (the rule keys on .cyberpunk / .cyberpunk-card / .cp-shop-request).
const FAMILIES = [
  // save prompts + area confirms (root .cyberpunk .save-prompt)
  { key: "explosion-confirm", wrapper: 'class="cyberpunk save-prompt"',  inner: '<div class="save-buttons"><button class="cp-confirm-explosion PROBE">Confirm blast</button></div>' },
  { key: "explosion-scatter", wrapper: 'class="cyberpunk save-prompt"',  inner: '<div class="save-buttons"><button class="cp-confirm-explosion-scatter PROBE">Scatter</button></div>' },
  { key: "spread-confirm",    wrapper: 'class="cyberpunk save-prompt"',  inner: '<div class="save-buttons"><button class="cp-confirm-spread-zone PROBE">Confirm</button></div>' },
  { key: "fire-zone",         wrapper: 'class="cyberpunk save-prompt"',  inner: '<div class="save-buttons"><button class="cp-confirm-fire-zone PROBE">Confirm Fire Zone</button></div>' },
  { key: "evasion",           wrapper: 'class="cyberpunk save-prompt"',  inner: '<div class="save-buttons"><button class="cp-suppression-evasion-roll PROBE">Evade</button></div>' },
  { key: "death-save",        wrapper: 'class="cyberpunk save-prompt death-save-prompt"',  inner: '<div class="save-buttons"><button class="cp-death-save-roll PROBE">Roll</button></div>' },
  { key: "stun-save",         wrapper: 'class="cyberpunk save-prompt stun-save-prompt"',   inner: '<div class="save-buttons"><button class="cp-stun-save-roll PROBE">Roll</button></div>' },
  { key: "drug-save",         wrapper: 'class="cyberpunk save-prompt drug-save-prompt"',   inner: '<div class="save-buttons"><button class="cp-drug-save-roll PROBE">Roll</button></div>' },
  { key: "stabilize",         wrapper: 'class="cyberpunk save-result death-save-result"',  inner: '<div class="save-buttons"><button class="cp-stabilize-roll PROBE">Stabilize</button></div>' },
  { key: "luck-save",         wrapper: 'class="cyberpunk save-prompt"',  inner: '<div class="save-buttons"><button class="cp-luck-save-roll PROBE">Luck</button></div>' },
  // martial defense offer + result cards
  { key: "martial-def-roll",   wrapper: 'class="cyberpunk save-prompt martial-defense-offer"',  inner: '<div class="save-buttons"><button class="cp-martial-defense-roll PROBE">Roll defense</button></div>' },
  { key: "martial-def-apply",  wrapper: 'class="cyberpunk save-prompt martial-defense-offer"',  inner: '<div class="save-buttons"><button class="cp-martial-defense-apply PROBE">Apply</button></div>' },
  { key: "martial-def-lands",  wrapper: 'class="cyberpunk save-prompt martial-defense-result"', inner: '<div class="save-buttons"><button class="cp-martial-defense-lands PROBE">Lands</button></div>' },
  { key: "martial-def-evaded", wrapper: 'class="cyberpunk save-prompt martial-defense-result"', inner: '<div class="save-buttons"><button class="cp-martial-defense-evaded PROBE">Evaded</button></div>' },
  // vehicle incoming-missile intercept prompt
  { key: "missile-cm",        wrapper: 'class="cyberpunk save-prompt vehicle-incoming"', inner: '<div class="save-buttons"><button class="cp-missile-cm PROBE">Countermeasure</button></div>' },
  { key: "missile-evade",     wrapper: 'class="cyberpunk save-prompt vehicle-incoming"', inner: '<div class="save-buttons"><button class="cp-missile-evade PROBE">Evade</button></div>' },
  { key: "missile-intercept", wrapper: 'class="cyberpunk save-prompt vehicle-incoming"', inner: '<div class="save-buttons"><button class="cp-missile-intercept PROBE">Intercept</button></div>' },
  // vehicle fire-result apply
  { key: "vehicle-fire",      wrapper: 'class="cyberpunk vehicle-fire-result"', inner: '<button class="cp-vfire-apply PROBE">Apply</button>' },
  // shop cards (request card scoped by .cp-shop-request; published-link card by .cyberpunk)
  { key: "shop-request",      wrapper: 'class="cp-shop-request"',        inner: '<div class="cp-shop-request-actions"><button class="cp-shop-request-btn cp-approve PROBE">Approve</button></div>' },
  { key: "shop-link",         wrapper: 'class="cyberpunk cp-shop-publish"', inner: '<button class="cp-shop-open-link PROBE">Browse</button>' },
  // JS-injected apply-damage card (root .cyberpunk-card)
  { key: "apply-damage",      wrapper: 'class="cyberpunk-card"',         inner: '<button class="cp2020-apply-damage-btn PROBE">Apply Damage</button>' },
];

const browser = await chromium.launch({ headless: true });
let failures = 0;
const rows = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await joinAs(page, /^gamemaster$/i, [GM_PW]);
  await page.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});

  const results = await page.evaluate(async (families) => {
    const out = [];
    for (const fam of families) {
      const content = `<div ${fam.wrapper}>${fam.inner}</div>`;
      const msg = await ChatMessage.create({ content, whisper: [game.user.id] });
      const sel = `#chat .chat-message[data-message-id="${msg.id}"] .PROBE`;
      let el = null;
      for (let i = 0; i < 40 && !(el = document.querySelector(sel)); i++) await new Promise(r => setTimeout(r, 100));
      if (!el) { out.push({ key: fam.key, error: "button never rendered" }); await msg.delete(); continue; }
      const csEnabled = getComputedStyle(el);
      const enabledUserSelect = csEnabled.getPropertyValue("user-select") || csEnabled.getPropertyValue("-webkit-user-select");
      const bgEnabled = csEnabled.getPropertyValue("background-color");
      el.disabled = true;
      void el.offsetHeight;
      // crlngn-ui puts `transition: all 0.5s` on buttons; opacity/filter animate in, so we must let the
      // transition settle before reading computed values (user-select is non-animatable → applies instantly).
      await new Promise(r => setTimeout(r, 750));
      const csDis = getComputedStyle(el);
      out.push({
        key: fam.key,
        enabledUserSelect,
        disabledUserSelect: csDis.getPropertyValue("user-select") || csDis.getPropertyValue("-webkit-user-select"),
        disabledOpacity: csDis.getPropertyValue("opacity"),
        disabledCursor: csDis.getPropertyValue("cursor"),
        bgEnabled,
      });
      await msg.delete();
    }
    return out;
  }, FAMILIES);

  for (const r of results) {
    const checks = [];
    if (r.error) { checks.push(["rendered", false, r.error]); }
    else {
      checks.push(["user-select:none (enabled)", r.enabledUserSelect === "none", r.enabledUserSelect]);
      checks.push(["user-select:none (disabled)", r.disabledUserSelect === "none", r.disabledUserSelect]);
      checks.push(["spent opacity <1 (disabled)", parseFloat(r.disabledOpacity) < 1, r.disabledOpacity]);
      checks.push(["cursor default (disabled)", r.disabledCursor === "default", r.disabledCursor]);
      checks.push(["button chrome kept (bg not transparent)", r.bgEnabled !== "rgba(0, 0, 0, 0)" && r.bgEnabled !== "transparent", r.bgEnabled]);
    }
    for (const [name, ok, val] of checks) {
      if (!ok) failures++;
      rows.push(`  [${ok ? "PASS" : "FAIL"}] ${r.key.padEnd(18)} ${name.padEnd(38)} = ${val}`);
    }
  }
  console.log("Chat-card button spent-visual + non-selectable regression\n" + rows.join("\n"));
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S) — RED"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
