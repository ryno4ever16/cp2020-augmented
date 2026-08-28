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
 * PART 3 (2026-08-15, the level-control unit) covers the control itself:
 *   • it rendered its row id EMPTY (a {{#with}} context-scope slip), so the delegated handler resolved
 *     no document and the click was silently eaten — never caught, because the old check only asked
 *     whether the element existed;
 *   • the row printed the per-skill bank alone while the enable predicate reads bank + fungible pool,
 *     so a pool-funded raise offered a control on a row still reading "0/10";
 *   • the skill-item sheet offered an editable system.ip box that no code anywhere spends.
 *
 * PART 4 (2026-08-19, the row-reachability unit) covers the row a user could not get to:
 *   • an untrained discipline the sheet withholds from the unsearched list stayed withheld once the
 *     GM attributed points to it — the predicate read the banked store only, and an award lands in
 *     the pending store until Apply runs;
 *   • neither row checkbox said what it does, and the chip one carried its hint on an input the base
 *     stylesheet sets display:none, so the hint could never be hovered;
 *   • the cost helper's multiplier term, pinned by value (the part-2 leg named `ipMultiplier`, which
 *     is not a schema field, so the term was stuck at 1);
 *   • which gesture actually opens a skill's own editor (right-click does not).
 *
 * PART 5 (2026-08-20, the cost-rule unit) pins the two rules the helper was not following:
 *   • the first level charged the multiplier with everything else, where the rules text sets a flat
 *     floor for it and scopes the multiplier to the raises after it;
 *   • every built-in martial-style document ships the multiplier field unset, so a style raise was
 *     priced exactly like a plain skill — the module's own style table is now consulted while that
 *     field is still the neutral value, a hand-entered value still wins, and the style sheet says
 *     which of the two the price came from.
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
      for (const k of ["ipThrottle", "ipQueue", "ipRawTracking", "ipAwardModel"]) prev[k] = game.settings.get(SCOPE, k);
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
      // ⏪ 2026-08-16 (vacuous-leg audit): `cost > 0` cannot fail — the helper is max(1,level)×10×mult,
      // so it is ≥10 by construction. Asserted by VALUE against the same arithmetic the ladder states.
      // ⏪ 2026-08-19: the multiplier term named a field that does not exist on the skill schema
      // (`ipMultiplier`), so `Number(undefined)||1` pinned the term at 1 and the leg could never see a
      // multiplied cost. The schema field is `system.diffMod` — the one the helper actually reads.
      ok("cost helper returns the ladder figure for this skill by value",
        cost === Math.max(1, Number(skill.system?.level) || 0) * 10 * Math.max(1, Number(skill.system?.diffMod) || 1),
        { cost, level: skill.system?.level, mult: skill.system?.diffMod });

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
      const banked = root?.querySelector(`.field.skill[data-item-id="${skill.id}"] .cp2020ae-ip-banked`);
      ok("skill row paints the banked/cost pair", banked?.textContent?.trim() === `37/${cost}`, banked?.textContent?.trim());
      const poolNode = root?.querySelector(".cp2020ae-ip-skills-header b");
      ok("skills header paints the pool figure", poolNode?.textContent?.trim() === "12", poolNode?.textContent?.trim());
      const arrow = root?.querySelector(`.field.skill[data-item-id="${skill.id}"] .cp2020ae-ip-level-up`);
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
      // RAW mode from here: the queue section only exists where per-skill attribution does, so a
      // Simple-mode tracker paints no rows at all to read a field off (tracker redesign, 2026-08-13).
      await game.settings.set(SCOPE, "ipRawTracking", true);
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

  // --- Part 3: the level-up control's row identity, its real click chain, and the pool-contribution
  // display. Covers the two defects the 2026-08-15 diagnosis proved on this rig:
  //   • the control rendered data-skill-id="" (a Handlebars {{#with}} context-scope slip), so the
  //     delegated handler resolved no document and the control was inert;
  //   • the row printed the per-skill bank alone while the enable predicate reads bank + fungible
  //     pool, so a pool-funded row lit up a control while still reading "0/10".
  // The click is driven as a real pointer gesture on the rendered sheet, not a handler call. -------
  const A = { checks: [] };
  const okA = (name, cond, got) => A.checks.push({ name, pass: !!cond, got });
  const ARROW = (appId, skillId) =>
    `[id="${appId}"] .field.skill[data-item-id="${skillId}"] .cp2020ae-ip-level-up`;
  const clickArrow = async (appId, skillId) => {
    const res = { clicked: false, confirmed: false };
    try { await page.locator(ARROW(appId, skillId)).first().click({ timeout: 4000 }); res.clicked = true; }
    catch { return res; }
    try { await page.locator('button[data-action="yes"]').first().click({ timeout: 4000 }); res.confirmed = true; }
    catch { /* no confirmation surfaced — the inert-control red */ }
    await page.waitForTimeout(900);
    return res;
  };
  try {
    const S = await page.evaluate(async () => {
      const SCOPE = "cp2020-augmented";
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const { isMartialArtSkillItem } = await import("/modules/cp2020-augmented/module/lookups.js");
      const IP = await import("/modules/cp2020-augmented/module/ip/ip.js");
      const prev = {};
      for (const k of ["ipRawTracking"]) prev[k] = game.settings.get(SCOPE, k);
      await game.settings.set(SCOPE, "ipRawTracking", false);

      for (const x of game.actors.filter(x => x.name === "__PW__ IP Level Chain")) await x.delete().catch(() => {});
      const actor = await Actor.create({ name: "__PW__ IP Level Chain", type: "character" });
      // Martial disciplines with an empty bank are hidden by the "hide; search reveals" filter, so the
      // fixture rows must be ordinary skills or the pointer gesture would land on a hidden element.
      const pick = actor.items.filter(i => i.type === "skill" && !isMartialArtSkillItem(i)).slice(0, 3);
      const [sA, sB, sC] = pick;
      // Bank-covered row (bank alone pays), pool-covered row (bank 0, the fungible pool pays), and a
      // row beyond bank + pool. The first raise is a flat 10 whatever the multiplier says, so the
      // out-of-reach row is put ABOVE the floor — level 2 on a tripled term = 2 × 10 × 3.
      await sA.update({ "system.level": 0, "system.diffMod": 1, [`flags.${SCOPE}.ip`]: 10 });
      await sB.update({ "system.level": 0, "system.diffMod": 1, [`flags.${SCOPE}.ip`]: 0 });
      await sC.update({ "system.level": 2, "system.diffMod": 3, [`flags.${SCOPE}.ip`]: 0 });
      await actor.setFlag(SCOPE, "ipPool", 10);

      const sheet = actor.sheet;
      await sheet.render(true);
      await sleep(900);
      const root = sheet.element;
      const readRow = (id) => {
        const row = root?.querySelector(`.field.skill[data-item-id="${id}"]`);
        const arrow = row?.querySelector(".cp2020ae-ip-level-up");
        const fromPool = row?.querySelector(".cp2020ae-ip-from-pool");
        return {
          rowFound: !!row,
          hidden: !!row?.classList?.contains("cp-hidden"),
          arrowPresent: !!arrow,
          arrowSkillId: arrow?.dataset?.skillId ?? null,
          arrowDisabled: arrow?.hasAttribute?.("disabled") === true || arrow?.classList?.contains("disabled") === true,
          pooledMark: !!arrow?.classList?.contains("cp2020ae-ip-level-up--pooled"),
          poolText: fromPool ? (fromPool.textContent || "").trim() : null,
          bankedText: (row?.querySelector(".cp2020ae-ip-banked")?.textContent || "").trim(),
        };
      };
      return {
        prev, actorId: actor.id, appId: root?.id ?? null,
        ids: { a: sA.id, b: sB.id, c: sC.id },
        costs: { a: IP.ipCost(sA), b: IP.ipCost(sB), c: IP.ipCost(sC) },
        rows: { a: readRow(sA.id), b: readRow(sB.id), c: readRow(sC.id) },
        before: { levelA: Number(sA.system.level) || 0, levelB: Number(sB.system.level) || 0, pool: IP.poolForActor(actor), bankA: IP.bankForSkill(sA), bankB: IP.bankForSkill(sB) },
      };
    });

    okA("fixture pins a bank-covered, a pool-covered and an out-of-reach row", S.costs.a === 10 && S.costs.b === 10 && S.costs.c === 60, `${S.costs.a}/${S.costs.b}/${S.costs.c}`);
    okA("all three fixture rows paint and none are filtered out", S.rows.a.rowFound && S.rows.b.rowFound && S.rows.c.rowFound && !S.rows.a.hidden && !S.rows.b.hidden && !S.rows.c.hidden, JSON.stringify([S.rows.a.hidden, S.rows.b.hidden, S.rows.c.hidden]));

    // (a) row identity — the control must carry the row's own item id, not an empty string.
    okA("bank-covered row's level control carries the row's item id", S.rows.a.arrowSkillId === S.ids.a, `"${S.rows.a.arrowSkillId}"`);
    okA("pool-covered row's level control carries the row's item id", S.rows.b.arrowSkillId === S.ids.b, `"${S.rows.b.arrowSkillId}"`);
    okA("no level control renders an empty row id", S.rows.a.arrowSkillId !== "" && S.rows.b.arrowSkillId !== "", `"${S.rows.a.arrowSkillId}"/"${S.rows.b.arrowSkillId}"`);

    // (c) affordability display — the printed figures must account for what the predicate spends.
    okA("bank-covered row prints no pool contribution", S.rows.a.poolText === null, S.rows.a.poolText);
    okA("bank-covered row's control carries no pool marker", S.rows.a.pooledMark === false, S.rows.a.pooledMark);
    okA("pool-covered row prints the pool contribution", typeof S.rows.b.poolText === "string" && /10/.test(S.rows.b.poolText), S.rows.b.poolText);
    okA("pool-covered row's contribution reads as text, not a raw key", !String(S.rows.b.poolText ?? "").includes("CYBERPUNK."), S.rows.b.poolText);
    okA("pool-covered row's control carries the pool marker", S.rows.b.pooledMark === true, S.rows.b.pooledMark);
    okA("row beyond bank plus pool paints no enabled level control", !S.rows.c.arrowPresent || S.rows.c.arrowDisabled, `present=${S.rows.c.arrowPresent} disabled=${S.rows.c.arrowDisabled}`);

    // (b) the real click chain — pointer gesture on the rendered control, then the confirmation.
    const clickA = await clickArrow(S.appId, S.ids.a);
    const afterA = await page.evaluate(async ({ actorId, idA }) => {
      const IP = await import("/modules/cp2020-augmented/module/ip/ip.js");
      const actor = game.actors.get(actorId); const s = actor.items.get(idA);
      return { level: Number(s.system.level) || 0, bank: IP.bankForSkill(s), pool: IP.poolForActor(actor) };
    }, { actorId: S.actorId, idA: S.ids.a });
    okA("pointer gesture reaches the bank-covered control", clickA.clicked === true, clickA.clicked);
    okA("bank-covered gesture raises the confirmation", clickA.confirmed === true, clickA.confirmed);
    okA("bank-covered gesture advances the level by one", afterA.level === S.before.levelA + 1, `${S.before.levelA}→${afterA.level}`);
    okA("bank-covered gesture debits the per-skill bank by the cost", afterA.bank === S.before.bankA - S.costs.a, `${S.before.bankA}→${afterA.bank}`);
    okA("bank-covered gesture leaves the fungible pool untouched", afterA.pool === S.before.pool, `${S.before.pool}→${afterA.pool}`);

    const clickB = await clickArrow(S.appId, S.ids.b);
    const afterB = await page.evaluate(async ({ actorId, idB }) => {
      const IP = await import("/modules/cp2020-augmented/module/ip/ip.js");
      const actor = game.actors.get(actorId); const s = actor.items.get(idB);
      return { level: Number(s.system.level) || 0, bank: IP.bankForSkill(s), pool: IP.poolForActor(actor) };
    }, { actorId: S.actorId, idB: S.ids.b });
    okA("pointer gesture reaches the pool-covered control", clickB.clicked === true, clickB.clicked);
    okA("pool-covered gesture advances the level by one", afterB.level === S.before.levelB + 1, `${S.before.levelB}→${afterB.level}`);
    okA("pool-covered gesture debits the fungible pool by the cost", afterB.pool === afterA.pool - S.costs.b, `${afterA.pool}→${afterB.pool}`);
    okA("pool-covered gesture leaves the empty bank at zero", afterB.bank === 0, afterB.bank);

    // Handler hardening: blank the control's own row id in the DOM — the exact shape of the shipped
    // regression — and the click must still resolve the document through the row's [data-item-id].
    const G = await page.evaluate(async ({ actorId, idC, costC }) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const actor = game.actors.get(actorId); const s = actor.items.get(idC);
      await s.setFlag("cp2020-augmented", "ip", costC);   // fund the out-of-reach row so a control paints
      await sleep(900);                                    // let the flag write's re-render settle first
      const arrow = actor.sheet.element?.querySelector(`.field.skill[data-item-id="${idC}"] .cp2020ae-ip-level-up`);
      if (arrow) arrow.dataset.skillId = "";
      return { arrowFound: !!arrow, blanked: arrow?.dataset?.skillId === "", level: Number(s.system.level) || 0 };
    }, { actorId: S.actorId, idC: S.ids.c, costC: S.costs.c });
    okA("funding the out-of-reach row paints a level control", G.arrowFound === true && G.blanked === true, `${G.arrowFound}/${G.blanked}`);
    const clickC = await clickArrow(S.appId, S.ids.c);
    const afterC = await page.evaluate(async ({ actorId, idC }) => {
      const IP = await import("/modules/cp2020-augmented/module/ip/ip.js");
      const actor = game.actors.get(actorId); const s = actor.items.get(idC);
      return { level: Number(s.system.level) || 0, bank: IP.bankForSkill(s) };
    }, { actorId: S.actorId, idC: S.ids.c });
    okA("a control whose row id is blank still resolves through its row", clickC.clicked && afterC.level === G.level + 1, `${G.level}→${afterC.level}`);
    okA("the fallback resolution debits the same bank the control names", afterC.bank === 0, afterC.bank);

    // (d) the inert third store is no longer surfaced on the module's skill-item sheet.
    const F = await page.evaluate(async ({ actorId, idA }) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const s = game.actors.get(actorId).items.get(idA);
      await s.sheet.render(true);
      await sleep(900);
      const el = s.sheet.element;
      const out = {
        ipField: !!el?.querySelector('input[name="system.ip"]'),
        diffField: !!el?.querySelector('input[name="system.diffMod"]'),
        levelField: !!el?.querySelector('input[name="system.level"]'),
      };
      await s.sheet.close();
      return out;
    }, { actorId: S.actorId, idA: S.ids.a });
    okA("skill-item sheet no longer exposes the unspent improvement-point field", F.ipField === false, F.ipField);
    okA("skill-item sheet still exposes the difficulty multiplier", F.diffField === true, F.diffField);
    okA("skill-item sheet still exposes the level field", F.levelField === true, F.levelField);

    await page.evaluate(async ({ actorId, prev }) => {
      try { await game.actors.get(actorId)?.sheet?.close(); } catch {}
      try { await game.actors.get(actorId)?.delete(); } catch {}
      for (const [k, v] of Object.entries(prev)) { try { if (v !== undefined) await game.settings.set("cp2020-augmented", k, v); } catch {} }
    }, { actorId: S.actorId, prev: S.prev });
  } catch (e) {
    console.error("IN-PAGE ERROR (part 3):", e?.stack || e?.message || e);
    failures++;
    await page.evaluate(async () => {
      for (const x of game.actors.filter(x => x.name === "__PW__ IP Level Chain")) { try { await x.sheet?.close(); } catch {} await x.delete().catch(() => {}); }
    }).catch(() => {});
  }
  console.log("\nIP level control: row identity, click chain, pool-contribution display\n" + A.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(58)} got=${c.got}`).join("\n"));
  failures += A.checks.filter(c => !c.pass).length;

  // --- Part 4: the row's REACHABILITY and its two signposts. Three user reports, one row. ----------
  //   • a discipline the sheet hides at level 0 stayed hidden once the GM attributed points to it —
  //     the visibility predicate read the BANKED store only, and an award lands in the PENDING store
  //     first, so the whole cycle between the award and Apply was invisible to the GM who made it;
  //   • neither row checkbox said what it does — and the chip one carried its hint on an input the
  //     base stylesheet sets `display:none`, so the hint could never be hovered;
  //   • the cost helper multiplies by `system.diffMod`; this pins that term by value (the earlier leg
  //     named a field the schema does not have, so the term was stuck at 1 and proved nothing).
  const P = { checks: [] };
  const okP = (name, cond, got) => P.checks.push({ name, pass: !!cond, got });
  try {
    const V = await page.evaluate(async () => {
      const SCOPE = "cp2020-augmented";
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const { isMartialArtSkillItem, FNFF2_ONLY_MARTIAL_ART_KEYS } =
        await import("/modules/cp2020-augmented/module/lookups.js");
      const IP = await import("/modules/cp2020-augmented/module/ip/ip.js");
      const prev = {};
      for (const k of ["ipRawTracking"]) prev[k] = game.settings.get(SCOPE, k);
      await game.settings.set(SCOPE, "ipRawTracking", true);

      for (const x of game.actors.filter(x => x.name === "__PW__ IP Row Reach")) await x.delete().catch(() => {});
      const actor = await Actor.create({ name: "__PW__ IP Row Reach", type: "character" });
      // Disciplines gated behind the supplement toggle are dropped from the render list outright, so
      // the fixture uses base-list ones — the visibility filter, not the content gate, is under test.
      const martials = actor.items.filter(i => i.type === "skill" && isMartialArtSkillItem(i)
        && !FNFF2_ONLY_MARTIAL_ART_KEYS.has(i.name)).slice(0, 3);
      const plain = actor.items.find(i => i.type === "skill" && !isMartialArtSkillItem(i));
      const [mNone, mBank, mPend] = martials;

      // Three points states on three otherwise identical untrained disciplines, plus a plain skill.
      await mNone.update({ "system.level": 0, "system.ip": 0 });
      await mBank.update({ "system.level": 0, "system.ip": 0, [`flags.${SCOPE}.ip`]: 5, [`flags.${SCOPE}.ipPending`]: 0 });
      await mPend.update({ "system.level": 0, "system.ip": 0, [`flags.${SCOPE}.ip`]: 0, [`flags.${SCOPE}.ipPending`]: 5 });
      await plain.update({ "system.level": 0, "system.ip": 0 });

      const sheet = actor.sheet;
      await sheet.render(true);
      await sleep(900);
      const root = sheet.element;
      const row = (id) => root?.querySelector(`.field.skill[data-item-id="${id}"]`);
      const state = (id) => {
        const r = row(id);
        return { present: !!r, hidden: !!r?.classList?.contains("cp-hidden") };
      };

      // Signposts: read from the elements the cursor can actually reach.
      const r0 = row(mNone.id) || row(plain.id);
      const chipTip = r0?.querySelector("label.chip-toggle")?.getAttribute("title") ?? null;
      const modTip = r0?.querySelector(".skill-mod-toggle")?.getAttribute("title") ?? null;
      const chipBoxHidden = (() => {
        const box = r0?.querySelector("input.chip-toggle-checkbox");
        return box ? getComputedStyle(box).display === "none" : null;
      })();

      // Cost term: the helper's multiplier leg, by value, at the figures the ladder prints.
      const probe = plain;
      const costAt = (level, diffMod, item = probe) =>
        item.update({ "system.level": level, "system.diffMod": diffMod })
          .then(() => IP.ipCost(actor.items.get(item.id)));

      const flat = await costAt(4, 1);
      const tripled = await costAt(4, 3);
      const first = await costAt(0, 1);
      // The first raise is the flat floor whatever the multiplier says; the multiplier starts at the
      // SECOND raise, where the figure is the current level's ten times the term.
      const firstTripled = await costAt(0, 3);
      const secondTripled = await costAt(1, 3);
      const secondFlat = await costAt(1, 1);
      await costAt(0, 1);

      // What the shipped base-list data actually carries for a discipline: the neutral term. The
      // module's style table is the read side that fills that hole; these legs price a real style
      // document off it, and prove a hand-entered term still overrides it.
      const shippedMult = Number(mNone.system?.diffMod);

      const { martialArtKeyForItem, MARTIAL_ART_IP_MULTIPLIER } =
        await import("/modules/cp2020-augmented/module/lookups.js");
      const STYLE_KEY = "Martial Arts: Karate";                 // base-list, table term 2
      const style = actor.items.find(i => i.type === "skill" && martialArtKeyForItem(i) === STYLE_KEY);
      const styleTableMult = MARTIAL_ART_IP_MULTIPLIER[STYLE_KEY];
      const styleShippedMult = Number(style?.system?.diffMod);
      const styleAtFour = style ? await costAt(4, 1, style) : null;
      const styleFirst = style ? await costAt(0, 1, style) : null;
      const styleOverridden = style ? await costAt(4, 5, style) : null;
      if (style) await costAt(0, 1, style);

      // The item sheet's Difficulty Mod box reads the stored 1; the note is what says which term the
      // cost actually used. Read it off the rendered sheet, and off it again once a term is typed in.
      let styleNote = null, styleNoteAfterOverride = null;
      if (style) {
        await style.sheet.render(true);
        await sleep(700);
        styleNote = style.sheet.element?.querySelector(".cp-field-note")?.textContent?.trim() ?? null;
        await style.update({ "system.diffMod": 5 });
        await style.sheet.render(true);
        await sleep(700);
        styleNoteAfterOverride = style.sheet.element?.querySelector(".cp-field-note")?.textContent?.trim() ?? null;
        await style.update({ "system.diffMod": 1 });
        await style.sheet.close().catch(() => {});
      }

      return {
        prev, actorId: actor.id, appId: root?.id ?? null,
        ids: { none: mNone.id, bank: mBank.id, pend: mPend.id, plain: plain.id },
        names: { none: actor.getSkillDisplayName?.(mNone) ?? mNone.name },
        rows: { none: state(mNone.id), bank: state(mBank.id), pend: state(mPend.id), plain: state(plain.id) },
        tips: { chip: chipTip, mod: modTip, chipBoxHidden },
        cost: { flat, tripled, first, firstTripled, secondTripled, secondFlat, shippedMult },
        style: {
          found: !!style, tableMult: styleTableMult, shippedMult: styleShippedMult,
          atFour: styleAtFour, atFirst: styleFirst, overridden: styleOverridden,
          note: styleNote, noteAfterOverride: styleNoteAfterOverride,
        },
      };
    });

    okP("fixture pins three untrained disciplines and a plain skill",
      V.rows.none.present && V.rows.bank.present && V.rows.pend.present && V.rows.plain.present,
      JSON.stringify([V.rows.none.present, V.rows.bank.present, V.rows.pend.present, V.rows.plain.present]));

    // (a) reachability with an empty search box.
    okP("untrained discipline with no points stays out of the unsearched list", V.rows.none.hidden === true, V.rows.none.hidden);
    okP("untrained discipline holding banked points is listed unsearched", V.rows.bank.hidden === false, V.rows.bank.hidden);
    okP("untrained discipline holding pending points is listed unsearched", V.rows.pend.hidden === false, V.rows.pend.hidden);
    okP("untrained plain skill is never withheld from the list", V.rows.plain.hidden === false, V.rows.plain.hidden);

    // (b) the search still reveals the withheld row, and withdraws it again on clear.
    const SEARCH = `[id="${V.appId}"] input.skill-search`;
    const term = String(V.names.none || "").replace(/^.*:\s*/, "").slice(0, 5);
    await page.locator(SEARCH).fill(term);
    await page.waitForTimeout(700);
    const shown = await page.evaluate(({ appId, id }) =>
      !document.querySelector(`[id="${appId}"] .field.skill[data-item-id="${id}"]`)?.classList?.contains("cp-hidden"),
    { appId: V.appId, id: V.ids.none });
    okP("a query reveals the withheld discipline row", shown === true, `term="${term}" shown=${shown}`);
    await page.locator(SEARCH).fill("");
    await page.waitForTimeout(700);
    const rehidden = await page.evaluate(({ appId, id }) =>
      !!document.querySelector(`[id="${appId}"] .field.skill[data-item-id="${id}"]`)?.classList?.contains("cp-hidden"),
    { appId: V.appId, id: V.ids.none });
    okP("clearing the query withdraws it again", rehidden === true, rehidden);

    // (c) signposts — text present, plain, distinct, and on an element that can be hovered.
    okP("chip cell carries a hint on the visible label", typeof V.tips.chip === "string" && V.tips.chip.length > 20, V.tips.chip?.slice(0, 40));
    okP("modifier box carries a hint on its visible wrapper", typeof V.tips.mod === "string" && V.tips.mod.length > 20, V.tips.mod?.slice(0, 40));
    okP("neither hint leaks a raw key", !String(V.tips.chip).includes("CYBERPUNK.") && !String(V.tips.mod).includes("CYBERPUNK."), `${String(V.tips.chip).slice(0, 12)}|${String(V.tips.mod).slice(0, 12)}`);
    okP("the two hints describe different controls", V.tips.chip !== V.tips.mod, V.tips.chip === V.tips.mod);
    okP("the chip input itself is display:none, which is why its hint moved", V.tips.chipBoxHidden === true, V.tips.chipBoxHidden);

    // (d) cost term by value — the ladder figures the rules text prints (Core p.53/54).
    okP("flat-term raise at level 4 costs the level figure", V.cost.flat === 40, V.cost.flat);
    okP("tripled-term raise at level 4 costs three times the level figure", V.cost.tripled === 120, V.cost.tripled);
    okP("first level costs the floor figure", V.cost.first === 10, V.cost.first);
    // The floor is flat: the text scopes the multiplier to the raises after the first one, so a
    // tripled-term entry costs the same 10 to open as any other and only diverges from the second.
    okP("first level ignores the multiplier entirely", V.cost.firstTripled === 10, V.cost.firstTripled);
    okP("second level is the current level's ten, times the term", V.cost.secondTripled === 30, V.cost.secondTripled);
    okP("second level on a neutral term is the bare ten", V.cost.secondFlat === 10, V.cost.secondFlat);
    okP("base-list discipline items ship the neutral term in the document",
      V.cost.shippedMult === 1, V.cost.shippedMult);

    // (d2) the style table fills the hole that neutral term leaves — id-resolved, override-respecting.
    okP("the fixture resolves a base-list style document by its stable identity", V.style.found === true, V.style.found);
    okP("that style's document still carries the neutral term", V.style.shippedMult === 1, V.style.shippedMult);
    okP("its raise is priced off the table term, not the neutral one",
      V.style.atFour === 10 * 4 * V.style.tableMult, `${V.style.atFour} vs ${10 * 4 * V.style.tableMult}`);
    okP("that style is priced above an identically-levelled plain skill",
      V.style.atFour > V.cost.flat, `${V.style.atFour} > ${V.cost.flat}`);
    okP("the table term does not reach the first level either", V.style.atFirst === 10, V.style.atFirst);
    okP("a hand-entered term overrides the table", V.style.overridden === 200, V.style.overridden);
    // (d3) the sheet says which term is in force, and stops saying it once one is typed in.
    okP("the style sheet prints the table term next to the difficulty box",
      typeof V.style.note === "string" && V.style.note.includes(`×${V.style.tableMult}`), V.style.note?.slice(0, 60));
    okP("that note leaks no raw key",
      typeof V.style.note === "string" && !V.style.note.includes("CYBERPUNK."), V.style.note?.slice(0, 20));
    okP("the note is withdrawn once a term is entered by hand",
      V.style.noteAfterOverride === null, V.style.noteAfterOverride);

    // (e) the gesture that opens a skill's own editor. Right-click is bound to a delete control the
    // skill row does not carry, so it opens nothing; the row's pencil control is what opens the sheet.
    const ROW = `[id="${V.appId}"] .field.skill[data-item-id="${V.ids.plain}"]`;
    await page.locator(`${ROW} label.skill-roll`).click({ button: "right" });
    await page.waitForTimeout(500);
    const afterRight = await page.evaluate(({ actorId, id }) =>
      game.actors.get(actorId).items.get(id).sheet?.rendered === true, { actorId: V.actorId, id: V.ids.plain });
    okP("right-clicking a skill row opens no item editor", afterRight === false, afterRight);
    await page.locator(`${ROW} .item-edit`).click();
    await page.waitForTimeout(700);
    const afterEdit = await page.evaluate(({ actorId, id }) =>
      game.actors.get(actorId).items.get(id).sheet?.rendered === true, { actorId: V.actorId, id: V.ids.plain });
    okP("the row's edit control opens the item editor", afterEdit === true, afterEdit);

    await page.evaluate(async ({ actorId, prev }) => {
      const a = game.actors.get(actorId);
      for (const i of (a?.items ?? [])) { try { await i.sheet?.close(); } catch {} }
      try { await a?.sheet?.close(); } catch {}
      try { await a?.delete(); } catch {}
      for (const [k, v] of Object.entries(prev)) { try { if (v !== undefined) await game.settings.set("cp2020-augmented", k, v); } catch {} }
    }, { actorId: V.actorId, prev: V.prev });
  } catch (e) {
    console.error("IN-PAGE ERROR (part 4):", e?.stack || e?.message || e);
    failures++;
    await page.evaluate(async () => {
      for (const x of game.actors.filter(x => x.name === "__PW__ IP Row Reach")) { try { await x.sheet?.close(); } catch {} await x.delete().catch(() => {}); }
    }).catch(() => {});
  }
  console.log("\nSkill-row reachability, signposts, cost term and editor gesture\n" + P.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${String(c.name).padEnd(62)} got=${c.got}`).join("\n"));
  failures += P.checks.filter(c => !c.pass).length;

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
