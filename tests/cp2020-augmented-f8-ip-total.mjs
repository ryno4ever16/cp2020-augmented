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
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-f8-ip-total.mjs
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
  console.log("F8 IP queue roll total\n" + R.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(52)} got=${c.got}`).join("\n"));
  failures += R.checks.filter(c => !c.pass).length;
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
