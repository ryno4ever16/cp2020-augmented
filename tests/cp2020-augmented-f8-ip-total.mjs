/**
 * F8 — IP queue rows carry the real roll total on stock (:30004, official 1.1.1 + module).
 *
 * The seam-shim's rollSkill wrapper emitted cyberpunkSkillRolled BEFORE the roll and with no `total`, so
 * every RAW-IP queue row recorded 0. Fixed: emit from the createChatMessage hook when the roll card lands
 * (Multiroll attaches rolls:[…]), so the payload carries the real total AFTER the roll.
 *
 * Behavioural: with RAW IP tracking on, roll a real skill → the queue row's total equals the roll card's
 * total (and is not 0).
 *
 * PART 2 (added with the IP truth unit) covers the three places the store and its UI disagreed:
 *   • the character sheet re-derived the numbers off system.* while the engine banks them in module
 *     flags, so every sheet showed 0 — the prepared context and the painted row must now carry the
 *     flag values;
 *   • a throttled award vanished without a word;
 *   • the tracker's amount field claimed a ceiling the award engine does not have.
 *
 * Run from the module's tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-f8-ip-total.mjs
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";

async function joinAs(page, match, passwords) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 30_000 });
  const users = await sel.locator("option").evaluateAll((o) => o.map((x) => ({ v: x.value, l: (x.textContent || "").trim() })).filter((x) => x.v));
  const u = users.find((x) => match.test(x.l));
  for (const pw of passwords) {
    await sel.selectOption(u.v); await page.locator('input[name="password"]').fill(pw);
    await Promise.all([ page.waitForNavigation({ url: /\/game/, timeout: 15_000 }).catch(() => {}), page.locator('button[name="join"]').click() ]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 15_000 }); return; } catch {}
  }
  throw new Error("could not join");
}

const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e?.message || e)));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
  await joinAs(page, /^gamemaster$/i, [GM_PW]);

  const R = await page.evaluate(async () => {
    const M = "/modules/cp2020-augmented/module";
    const SCOPE = "cp2020-augmented";
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch {} await new Promise(r => setTimeout(r, 40)); } return null; };
    let actor = null, prevRaw, prevQueue, capHook = null;
    try {
      // source-shape: the shim now emits from createChatMessage with the total (not pre-roll, no-total)
      const src = await (await fetch(`${M}/seam-shim.js`, { cache: "no-store" })).text();
      ok("shim emits skillRolled from createChatMessage w/ total", /Hooks\.on\("createChatMessage"/.test(src) && /total: msg\?\.rolls\?\.\[0\]\?\.total|const total = msg\?\.rolls\?\.\[0\]\?\.total/.test(src) && /Hooks\.callAll\(SKILL_ROLLED, \{ actorId, skillId: rolledSkillId, actorName, skillName, total \}\)/.test(src), true);

      const ActorProto = CONFIG.Actor.documentClass.prototype;
      ok("seam-shim rollSkill wrapper is engaged on stock", ActorProto.rollSkill?.__cpSeamShim === true, ActorProto.rollSkill?.__cpSeamShim);

      prevRaw = game.settings.get(SCOPE, "ipRawTracking");
      prevQueue = game.settings.get(SCOPE, "ipQueue");
      await game.settings.set(SCOPE, "ipRawTracking", true);
      await game.settings.set(SCOPE, "ipQueue", []);

      for (const x of game.actors.filter(x => x.name === "RIG F8 IP")) await x.delete().catch(() => {});   // pre-sweep prior run
      actor = await Actor.create({ name: "RIG F8 IP", type: "character" });
      const skill = actor.items.find(i => i.type === "skill");
      ok("character has a rollable skill", !!skill, skill?.name);

      // capture the roll card's total as it's posted
      let cardTotal = null;
      capHook = Hooks.on("createChatMessage", (msg) => { if (cardTotal == null) { const t = msg?.rolls?.[0]?.total; if (typeof t === "number") cardTotal = t; } });

      await actor.rollSkill(skill.id);

      // the queue row lands after: roll card → shim hook → cyberpunkSkillRolled → recordSkillRoll → _enqueue
      const row = await waitFor(() => (game.settings.get(SCOPE, "ipQueue") || []).find(r => r.skillId === skill.id));
      ok("a queue row was recorded for the rolled skill", !!row, row ? `total=${row.total}` : "none");
      ok("roll card produced a numeric total", typeof cardTotal === "number", cardTotal);
      ok("queue row total equals the roll card total (real total flowed)", !!row && row.total === cardTotal, `row=${row?.total} card=${cardTotal}`);
      ok("queue row total is NOT 0 (the F8 bug)", !!row && row.total !== 0, row?.total);
    } catch (e) { out.error = e?.stack || e?.message || String(e); }
    finally {
      try { if (capHook) Hooks.off("createChatMessage", capHook); } catch {}
      try { if (actor) await actor.delete(); } catch {}
      try { if (prevRaw !== undefined) await game.settings.set(SCOPE, "ipRawTracking", prevRaw); } catch {}
      try { if (prevQueue !== undefined) await game.settings.set(SCOPE, "ipQueue", prevQueue); } catch {}
    }
    return out;
  });

  if (R.error) { console.error("IN-PAGE ERROR:", R.error); failures++; }
  console.log("F8 IP queue roll total\n" + R.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(58)} got=${c.got}`).join("\n"));
  failures += R.checks.filter(c => !c.pass).length;

  // --- Part 2: sheet readback of the flag store, throttle notice, amount-field ceiling --------------
  const D = await page.evaluate(async () => {
    const M = "/modules/cp2020-augmented/module";
    const SCOPE = "cp2020-augmented";
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let actor = null, app = null, prev = {}, origWarn = null;
    try {
      const IP = await import(`${M}/ip/ip.js`);
      for (const k of ["ipThrottle", "ipHideUI", "ipQueue", "ipRawTracking", "ipAwardModel"]) prev[k] = game.settings.get(SCOPE, k);
      await game.settings.set(SCOPE, "ipHideUI", false);
      await game.settings.set(SCOPE, "ipRawTracking", false);   // Simple mode: the pool figure is painted
      await game.settings.set(SCOPE, "ipAwardModel", "manual");
      await game.settings.set(SCOPE, "ipThrottle", "off");
      await IP.resetThrottle();

      for (const x of game.actors.filter(x => x.name === "__PW__ IP Readback")) await x.delete().catch(() => {});
      actor = await Actor.create({ name: "__PW__ IP Readback", type: "character" });
      const skill = actor.items.find(i => i.type === "skill");
      ok("fixture carries a skill document", !!skill, skill?.name);

      // The engine's own store: banked IP on the skill flag, the fungible pool on the actor flag.
      await skill.setFlag(SCOPE, "ip", 37);
      await actor.setFlag(SCOPE, "ipPool", 12);
      const cost = IP.ipCost(skill);
      ok("cost helper returns a positive figure", cost > 0, cost);

      // 1. Prepared context — through the real sheet chain, not a hand-built payload.
      const sheet = actor.sheet;
      const ctx = await sheet._prepareContext({});
      ok("prepared context reports the banked flag", ctx?.ipBySkill?.[skill.id]?.banked === 37, ctx?.ipBySkill?.[skill.id]?.banked);
      ok("prepared context reports the pool flag", ctx?.ip?.pool === 12, ctx?.ip?.pool);
      ok("prepared context reports the cost", ctx?.ipBySkill?.[skill.id]?.cost === cost, ctx?.ipBySkill?.[skill.id]?.cost);
      ok("prepared context marks the row affordable at 37 banked", ctx?.ipBySkill?.[skill.id]?.canLevel === true, ctx?.ipBySkill?.[skill.id]?.canLevel);

      // 2. Painted row — the same numbers must reach the DOM.
      await sheet.render(true);
      await sleep(800);
      const root = sheet.element;
      const banked = root?.querySelector(`.field.skill[data-item-id="${skill.id}"] .ip-banked`);
      ok("skill row paints the banked/cost pair", banked?.textContent?.trim() === `37/${cost}`, banked?.textContent?.trim());
      const poolNode = root?.querySelector(".ip-skills-header b");
      ok("skills header paints the pool figure", poolNode?.textContent?.trim() === "12", poolNode?.textContent?.trim());
      const arrow = root?.querySelector(`.field.skill[data-item-id="${skill.id}"] .ip-level-up`);
      ok("affordable row paints the level-up control", !!arrow, !!arrow);
      await sheet.close();

      // 3. A throttle-reduced award announces itself.
      await game.settings.set(SCOPE, "ipThrottle", "hardcap");
      await IP.resetThrottle();
      const warns = [];
      origWarn = ui.notifications.warn;
      ui.notifications.warn = function (msg, ...rest) { warns.push(String(msg)); return origWarn.call(this, msg, ...rest); };
      const first = await IP.awardPending(actor, skill, 5);
      const second = await IP.awardPending(actor, skill, 5);
      ui.notifications.warn = origWarn; origWarn = null;
      ok("first award of the cycle is granted", first === true, first);
      ok("second award of the cycle is reduced to nothing", second === false, second);
      ok("the reduction raises exactly one notice", warns.length === 1, warns.length);
      const w = warns[0] || "";
      ok("notice names the skill", w.includes(skill.name), w);
      ok("notice carries the entered figure 5", /\b5\b/.test(w), w);
      ok("notice carries the granted figure 0", /\b0\b/.test(w), w);
      ok("notice resolves (no raw key leakage)", !w.includes("CYBERPUNK."), w);
      ok("pending banked once, not twice", IP.pendingForSkill(actor.items.get(skill.id)) === 5, IP.pendingForSkill(actor.items.get(skill.id)));

      // 4. The amount field's validity matches what the engine will actually accept.
      await game.settings.set(SCOPE, "ipQueue", [{
        id: "__PW__row", actorId: actor.id, skillId: skill.id, actorName: actor.name,
        skillName: skill.name, total: 12, ip: 0, success: false, ts: Date.now(),
      }]);
      const T = await import(`${M}/ip/tracker.js`);
      app = new T.IpTracker();
      await app.render(true);
      await sleep(800);
      const amount = app.element?.querySelector(".cp-ip-row .cp-ip-amount");
      ok("tracker paints an amount field for the queued row", !!amount, !!amount);
      ok("amount field declares no ceiling", amount?.getAttribute("max") === null, amount?.getAttribute("max"));
      if (amount) amount.value = "250";
      ok("amount field holds 250", amount?.value === "250", amount?.value);
      ok("amount field reports no range overflow at 250", amount?.validity?.rangeOverflow === false, amount?.validity?.rangeOverflow);
      ok("amount field still floors at zero", amount?.getAttribute("min") === "0", amount?.getAttribute("min"));
    } catch (e) { out.error = e?.stack || e?.message || String(e); }
    finally {
      try { if (origWarn) ui.notifications.warn = origWarn; } catch {}
      try { if (app) await app.close(); } catch {}
      try { if (actor) await actor.delete(); } catch {}
      try { const IP = await import("/modules/cp2020-augmented/module/ip/ip.js"); await IP.resetThrottle(); } catch {}
      for (const [k, v] of Object.entries(prev)) { try { if (v !== undefined) await game.settings.set("cp2020-augmented", k, v); } catch {} }
    }
    return out;
  });

  if (D.error) { console.error("IN-PAGE ERROR (part 2):", D.error); failures++; }
  console.log("\nIP store readback + throttle notice + amount ceiling\n" + D.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(58)} got=${c.got}`).join("\n"));
  failures += D.checks.filter(c => !c.pass).length;

  const clean = pageErrors.length === 0;
  console.log(`  [${clean ? "PASS" : "FAIL"}] ${"0 console errors".padEnd(58)} got=${pageErrors.length}`);
  if (!clean) { console.log("    " + pageErrors.slice(0, 8).join("\n    ")); failures++; }

  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
