/**
 * IP TRACKER — the redesigned pipeline (queue → pending → banked).
 *
 * One spec for the whole tracker rework, in the order a GM meets it:
 *   1. Apply ONLY applies. It banks pending and starts a new throttle cycle; it never touches the
 *      queue, so a row nobody ruled on is still there afterwards (and a roll that lands mid-Apply
 *      cannot be eaten). Discarding rows is its own control, with a count in the confirmation.
 *   2. Repeat rolls of the same skill by the same character COALESCE into one row with a count; the
 *      row opens to the individual rolls, each of which can be pruned; the award stays at group level.
 *   3. Layout: the pipeline strip's live counts, the queue's pre-filled amount + Enter-to-award, the
 *      balances accordion and its filter box, and the Simple-mode shape (no queue section).
 *   4. The footer states the connected-GM condition for queueing.
 *
 * Run from the module's tests/:
 *   FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-ip-tracker.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";

async function joinAs(page, match, passwords) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 60_000 });
  const users = await sel.locator("option").evaluateAll((o) => o.map((x) => ({ v: x.value, l: (x.textContent || "").trim() })).filter((x) => x.v));
  const u = users.find((x) => match.test(x.l));
  if (!u) throw new Error("no matching user");
  for (const pw of passwords) {
    await sel.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([
      page.waitForNavigation({ url: /\/game/, timeout: 20_000 }).catch(() => {}),
      page.locator('button[name="join"]').click(),
    ]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 60_000 }); return; } catch {}
  }
  throw new Error("could not join");
}

function report(title, checks) {
  console.log(`\n${title}\n` + checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${String(c.name).padEnd(62)} got=${c.got}`).join("\n"));
  return checks.filter(c => !c.pass).length;
}

const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e?.message || e)));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
  await joinAs(page, /^gamemaster$/i, [GM_PW]);

  /* ------------------------------------------------------------------ */
  /*  Section 1 — Apply banks pending and leaves the queue alone         */
  /* ------------------------------------------------------------------ */
  const S1 = await page.evaluate(async () => {
    const M = "/modules/cp2020-augmented/module";
    const SCOPE = "cp2020-augmented";
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch {} await sleep(40); } return null; };
    const queue = () => game.settings.get(SCOPE, "ipQueue") || [];
    const seededRow = (actor, skill, total, ip) => ({
      id: foundry.utils.randomID(), actorId: actor.id, skillId: skill.id, actorName: actor.name,
      skillName: skill.name, total, ip, success: false, ts: Date.now(),
    });

    let actor = null, app = null, prev = {};
    try {
      const IP = await import(`${M}/ip/ip.js`);
      const T = await import(`${M}/ip/tracker.js`);
      for (const k of ["ipQueue", "ipRawTracking", "ipAwardModel", "ipThrottle", "ipHideUI", "ipThrottleCounts"]) prev[k] = game.settings.get(SCOPE, k);
      await game.settings.set(SCOPE, "ipHideUI", false);
      await game.settings.set(SCOPE, "ipRawTracking", true);
      await game.settings.set(SCOPE, "ipAwardModel", "manual");
      await game.settings.set(SCOPE, "ipThrottle", "off");
      await IP.resetThrottle();
      await game.settings.set(SCOPE, "ipQueue", []);

      for (const x of game.actors.filter(x => x.name === "__PW__ IP Pipeline")) await x.delete().catch(() => {});
      actor = await Actor.create({ name: "__PW__ IP Pipeline", type: "character" });
      const skills = actor.items.filter(i => i.type === "skill");
      const [sA, sB, sC] = skills;
      ok("fixture carries three distinct skills", !!(sA && sB && sC), skills.length);

      // Three un-ruled rows + one skill already holding pending IP.
      await game.settings.set(SCOPE, "ipQueue", [seededRow(actor, sA, 11, 0), seededRow(actor, sB, 12, 0), seededRow(actor, sC, 13, 0)]);
      await sA.setFlag(SCOPE, "ipPending", 7);
      await sA.setFlag(SCOPE, "ip", 3);

      app = new T.IpTracker();
      await app.render(true);
      await sleep(600);
      const before = queue().length;
      ok("tracker opens with the three seeded rows", before === 3, before);

      const applyBtn = app.element?.querySelector('[data-action="ipApply"]');
      ok("tracker paints an Apply control", !!applyBtn, !!applyBtn);
      applyBtn?.click();
      await sleep(900);

      const after = queue();
      ok("Apply leaves every queued row in place", after.length === 3, `${before}→${after.length}`);
      const skillA = actor.items.get(sA.id);
      ok("Apply moves pending into banked", IP.bankForSkill(skillA) === 10, IP.bankForSkill(skillA));
      ok("Apply zeroes the pending bucket", IP.pendingForSkill(skillA) === 0, IP.pendingForSkill(skillA));

      // Throttle cycle: the counter resets on Apply even though the queue is untouched.
      await game.settings.set(SCOPE, "ipThrottle", "hardcap");
      await IP.resetThrottle();
      const g1 = await IP.awardPending(actor, actor.items.get(sB.id), 5);
      const g2 = await IP.awardPending(actor, actor.items.get(sB.id), 5);
      ok("first award of a cycle is granted", g1 === true, g1);
      ok("second award of the same cycle is refused", g2 === false, g2);
      app.element?.querySelector('[data-action="ipApply"]')?.click();
      await sleep(900);
      const g3 = await IP.awardPending(actor, actor.items.get(sB.id), 5);
      ok("Apply starts a fresh throttle cycle (award granted again)", g3 === true, g3);
      ok("queue still intact after the second Apply", queue().length === 3, queue().length);
      await game.settings.set(SCOPE, "ipThrottle", "off");
      await IP.resetThrottle();

      // A roll that lands between the award pass and Apply must survive.
      const rows = queue();
      await IP.resolveQueueRow(rows[0].id);
      await sleep(400);
      await IP.recordSkillRoll({ actorId: actor.id, skillId: sC.id, actorName: actor.name, skillName: sC.name, total: 19 });
      const fresh = await waitFor(() => queue().find(r => r.total === 19 || (r.rolls || []).some(x => x.total === 19)));
      ok("a roll recorded after the award pass is queued", !!fresh, fresh?.id);
      app.element?.querySelector('[data-action="ipApply"]')?.click();
      await sleep(900);
      const survivor = queue().find(r => r.id === fresh?.id);
      ok("the late roll survives Apply (no silent discard)", !!survivor, !!survivor);

      // The Clear control: names the count, and only then empties.
      const q = queue();
      const clearBtn = app.element?.querySelector('[data-action="ipClear"]');
      ok("tracker paints a Clear-queue control", !!clearBtn, !!clearBtn);
      clearBtn?.click();
      const dlg1 = await waitFor(() => [...document.querySelectorAll(".application")].find(el => el.querySelector('button[data-action="no"], button[data-action="yes"]')));
      const text1 = dlg1?.textContent || "";
      ok("the confirmation states the exact row count", new RegExp(`\\b${q.length}\\b`).test(text1), `${q.length} in "${text1.replace(/\s+/g, " ").trim().slice(0, 90)}"`);
      ok("the confirmation resolves (no raw key leakage)", !text1.includes("CYBERPUNK."), !text1.includes("CYBERPUNK."));
      dlg1?.querySelector('button[data-action="no"]')?.click();
      await sleep(600);
      ok("declining the confirmation keeps every row", queue().length === q.length, queue().length);

      app.element?.querySelector('[data-action="ipClear"]')?.click();
      const dlg2 = await waitFor(() => [...document.querySelectorAll(".application")].find(el => el.querySelector('button[data-action="yes"]')));
      dlg2?.querySelector('button[data-action="yes"]')?.click();
      await sleep(900);
      ok("confirming Clear empties the queue", queue().length === 0, queue().length);
    } catch (e) { out.error = e?.stack || e?.message || String(e); }
    finally {
      try { if (app) await app.close(); } catch {}
      try { if (actor) await actor.delete(); } catch {}
      try { const IP = await import("/modules/cp2020-augmented/module/ip/ip.js"); await IP.resetThrottle(); } catch {}
      for (const [k, v] of Object.entries(prev)) { try { if (v !== undefined) await game.settings.set("cp2020-augmented", k, v); } catch {} }
    }
    return out;
  });
  if (S1.error) { console.error("IN-PAGE ERROR (section 1):", S1.error); failures++; }
  failures += report("1 — Apply banks pending, the queue is left alone, Clear is its own control", S1.checks);

  /* ------------------------------------------------------------------ */
  /*  Section 2 — repeat rolls coalesce; the row opens; rolls prune       */
  /* ------------------------------------------------------------------ */
  const S2 = await page.evaluate(async () => {
    const M = "/modules/cp2020-augmented/module";
    const SCOPE = "cp2020-augmented";
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const queue = () => game.settings.get(SCOPE, "ipQueue") || [];

    let actor = null, app = null, prev = {};
    try {
      const IP = await import(`${M}/ip/ip.js`);
      const T = await import(`${M}/ip/tracker.js`);
      for (const k of ["ipQueue", "ipRawTracking", "ipAwardModel", "ipThrottle", "ipHideUI", "ipThrottleCounts", "ipNeglectMuted"]) prev[k] = game.settings.get(SCOPE, k);
      await game.settings.set(SCOPE, "ipHideUI", false);
      await game.settings.set(SCOPE, "ipRawTracking", true);
      await game.settings.set(SCOPE, "ipAwardModel", "manual");
      await game.settings.set(SCOPE, "ipThrottle", "diminishing");
      await game.settings.set(SCOPE, "ipNeglectMuted", true);      // the pile-up prompt is not under test here
      await IP.resetThrottle();
      await game.settings.set(SCOPE, "ipQueue", []);

      for (const x of game.actors.filter(x => x.name === "__PW__ IP Coalesce")) await x.delete().catch(() => {});
      actor = await Actor.create({ name: "__PW__ IP Coalesce", type: "character" });
      const [sA, sB] = actor.items.filter(i => i.type === "skill");

      const record = async (skill, total) => {
        await IP.recordSkillRoll({ actorId: actor.id, skillId: skill.id, actorName: actor.name, skillName: skill.name, total });
        await sleep(30);
      };

      // Three rolls of ONE skill, one roll of another.
      await record(sA, 14); await record(sA, 21); await record(sA, 9);
      await record(sB, 17);

      const q = queue();
      ok("three repeats of one skill make ONE row", q.filter(r => r.skillId === sA.id).length === 1, q.filter(r => r.skillId === sA.id).length);
      ok("a different skill keeps its own row", q.length === 2, q.length);
      const grouped = q.find(r => r.skillId === sA.id);
      ok("the row carries all three rolls", (grouped?.rolls || []).length === 3, (grouped?.rolls || []).length);
      ok("each stored roll carries its own total", (grouped?.rolls || []).map(r => r.total).sort((a, b) => a - b).join(",") === "9,14,21", (grouped?.rolls || []).map(r => r.total).join(","));

      app = new T.IpTracker();
      await app.render(true);
      await sleep(600);
      const root = app.element;
      const rowEl = root?.querySelector(`.cp-ip-row[data-row-id="${grouped.id}"]`);
      const label = rowEl?.querySelector(".cp-ip-row-label")?.textContent?.replace(/\s+/g, " ").trim();
      ok("the collapsed row shows a count", /×\s*3/.test(label || ""), label);
      ok("the collapsed row shows no aggregate figure", !/\(\d+\)/.test(label || ""), label);

      const single = root?.querySelector(`.cp-ip-row[data-row-id="${q.find(r => r.skillId === sB.id).id}"] .cp-ip-row-label`)?.textContent?.replace(/\s+/g, " ").trim();
      ok("a one-roll row still shows its total inline", /\(17\)/.test(single || ""), single);
      ok("a one-roll row shows no count", !/×/.test(single || ""), single);

      // Newest activity first: the single roll of skill B landed last, so it heads the list.
      const order = [...(root?.querySelectorAll(".cp-ip-row") || [])].map(el => el.dataset.rowId);
      ok("rows are ordered newest activity first", order[0] === q.find(r => r.skillId === sB.id).id, order.join(","));

      // The row opens to its individual rolls, newest first.
      const rollsBox = rowEl?.querySelector(".cp-ip-row-rolls");
      ok("the rolls list starts collapsed", rollsBox?.classList.contains("cp-hidden") === true, rollsBox?.className);
      rowEl?.querySelector(".cp-ip-row-label")?.click();
      await sleep(400);
      const openBox = app.element?.querySelector(`.cp-ip-row[data-row-id="${grouped.id}"] .cp-ip-row-rolls`);
      ok("clicking the row opens the rolls list", openBox?.classList.contains("cp-hidden") === false, openBox?.className);
      const totals = [...(openBox?.querySelectorAll(".cp-ip-roll-total") || [])].map(el => el.textContent.trim());
      ok("the open row lists every individual roll", totals.length === 3, totals.join(","));
      ok("the rolls are listed newest first", totals.join(",") === "9,21,14", totals.join(","));
      const ages = [...(openBox?.querySelectorAll(".cp-ip-roll-age") || [])].map(el => el.textContent.trim());
      ok("each roll carries a time reading", ages.length === 3 && ages.every(a => a.length > 0), ages.join(" | "));

      // Pruning one roll out of the group.
      const pruneTarget = [...(openBox?.querySelectorAll(".cp-ip-roll") || [])].find(el => el.querySelector(".cp-ip-roll-total")?.textContent.trim() === "21");
      pruneTarget?.querySelector(".cp-ip-roll-prune")?.click();
      await sleep(700);
      const after = queue().find(r => r.id === grouped.id);
      ok("pruning drops that one roll", (after?.rolls || []).length === 2, (after?.rolls || []).length);
      ok("the pruned total is the one that left", !(after?.rolls || []).some(r => r.total === 21), (after?.rolls || []).map(r => r.total).join(","));
      const label2 = app.element?.querySelector(`.cp-ip-row[data-row-id="${grouped.id}"] .cp-ip-row-label`)?.textContent?.replace(/\s+/g, " ").trim();
      ok("the count follows the prune", /×\s*2/.test(label2 || ""), label2);

      // One award for the whole group: one typed amount, one throttle count.
      await IP.resetThrottle();
      const amountField = app.element?.querySelector(`.cp-ip-row[data-row-id="${grouped.id}"] .cp-ip-amount`);
      ok("the group carries exactly one amount field", app.element?.querySelectorAll(`.cp-ip-row[data-row-id="${grouped.id}"] .cp-ip-amount`).length === 1, app.element?.querySelectorAll(`.cp-ip-row[data-row-id="${grouped.id}"] .cp-ip-amount`).length);
      ok("no per-roll award control exists", !app.element?.querySelector(`.cp-ip-row[data-row-id="${grouped.id}"] .cp-ip-roll [data-action="ipAward"]`), !!app.element?.querySelector(`.cp-ip-row[data-row-id="${grouped.id}"] .cp-ip-roll [data-action="ipAward"]`));
      if (amountField) { amountField.value = "6"; amountField.dispatchEvent(new Event("change", { bubbles: true })); }
      await sleep(300);
      app.element?.querySelector(`.cp-ip-row[data-row-id="${grouped.id}"] [data-action="ipAward"]`)?.click();
      await sleep(900);
      const skillA = actor.items.get(sA.id);
      ok("the group awards the typed amount once", IP.pendingForSkill(skillA) === 6, IP.pendingForSkill(skillA));
      const counts = game.settings.get(SCOPE, "ipThrottleCounts") || {};
      ok("the group consumes exactly one throttle count", Number(counts[sA.id]) === 1, counts[sA.id]);
      ok("awarding removes the whole group row", !queue().some(r => r.id === grouped.id), queue().length);

      // Pruning the last roll of a group removes the row entirely.
      await record(sA, 5); await record(sA, 8);
      await sleep(200);
      await app.render(false);
      await sleep(400);
      const g2 = queue().find(r => r.skillId === sA.id);
      for (const roll of [...(g2?.rolls || [])]) await IP.pruneQueueRoll(g2.id, roll.id);
      await sleep(600);
      ok("pruning the last roll removes the row", !queue().some(r => r.id === g2?.id), queue().length);

      // The cap counts ROWS, so repeat rolls of one skill can no longer evict anybody.
      await game.settings.set(SCOPE, "ipQueue", []);
      const others = actor.items.filter(i => i.type === "skill").slice(2, 5);
      for (const s of others) await record(s, 11);
      const before = queue().length;
      for (let i = 0; i < 105; i++) await IP.recordSkillRoll({ actorId: actor.id, skillId: sA.id, actorName: actor.name, skillName: sA.name, total: 10 + (i % 7) });
      await sleep(500);
      const spam = queue();
      ok("105 repeats of one skill occupy a single row", spam.filter(r => r.skillId === sA.id).length === 1, spam.filter(r => r.skillId === sA.id).length);
      ok("that row holds all 105 rolls", (spam.find(r => r.skillId === sA.id)?.rolls || []).length === 105, (spam.find(r => r.skillId === sA.id)?.rolls || []).length);
      ok("no other row was evicted by the repeats", spam.length === before + 1, `${before}→${spam.length}`);
    } catch (e) { out.error = e?.stack || e?.message || String(e); }
    finally {
      try { if (app) await app.close(); } catch {}
      try { if (actor) await actor.delete(); } catch {}
      try { const IP = await import("/modules/cp2020-augmented/module/ip/ip.js"); await IP.resetThrottle(); } catch {}
      for (const [k, v] of Object.entries(prev)) { try { if (v !== undefined) await game.settings.set("cp2020-augmented", k, v); } catch {} }
    }
    return out;
  });
  if (S2.error) { console.error("IN-PAGE ERROR (section 2):", S2.error); failures++; }
  failures += report("2 — Repeat rolls coalesce, the row opens to them, rolls prune", S2.checks);

  /* ------------------------------------------------------------------ */
  /*  Section 3 — the window: pipeline strip, queue first, balances       */
  /* ------------------------------------------------------------------ */
  const S3 = await page.evaluate(async () => {
    const M = "/modules/cp2020-augmented/module";
    const SCOPE = "cp2020-augmented";
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const queue = () => game.settings.get(SCOPE, "ipQueue") || [];
    const num = (el) => Number(el?.textContent?.replace(/[^\d-]/g, ""));

    let actor = null, other = null, app = null, prev = {};
    try {
      const IP = await import(`${M}/ip/ip.js`);
      const T = await import(`${M}/ip/tracker.js`);
      for (const k of ["ipQueue", "ipRawTracking", "ipAwardModel", "ipThrottle", "ipHideUI", "ipThrottleCounts", "ipAutoBaselineAmount", "ipNeglectMuted"]) prev[k] = game.settings.get(SCOPE, k);
      await game.settings.set(SCOPE, "ipHideUI", false);
      await game.settings.set(SCOPE, "ipRawTracking", true);
      await game.settings.set(SCOPE, "ipAwardModel", "manual");
      await game.settings.set(SCOPE, "ipThrottle", "off");
      await game.settings.set(SCOPE, "ipNeglectMuted", true);
      await IP.resetThrottle();
      await game.settings.set(SCOPE, "ipQueue", []);

      for (const nm of ["__PW__ IP Layout", "__PW__ IP Layout Two"]) for (const x of game.actors.filter(x => x.name === nm)) await x.delete().catch(() => {});
      actor = await Actor.create({ name: "__PW__ IP Layout", type: "character" });
      other = await Actor.create({ name: "__PW__ IP Layout Two", type: "character" });
      const skills = actor.items.filter(i => i.type === "skill");
      const [sA, sB, sC] = skills;
      const oSkill = other.items.filter(i => i.type === "skill")[0];

      // Balances state: banked + pending on one character, a pool on the other.
      await sA.setFlag(SCOPE, "ip", 25);
      await sB.setFlag(SCOPE, "ip", 5);
      await sB.setFlag(SCOPE, "ipPending", 3);
      await oSkill.setFlag(SCOPE, "ip", 8);
      await other.setFlag(SCOPE, "ipPool", 4);

      for (const s of [sA, sB, sC]) await IP.recordSkillRoll({ actorId: actor.id, skillId: s.id, actorName: actor.name, skillName: s.name, total: 15 });
      await sleep(300);

      app = new T.IpTracker();
      await app.render(true);
      await sleep(700);
      const root = () => app.element;

      // (c) the pipeline strip.
      const strip = root()?.querySelector(".cp-ip-pipeline");
      ok("the window carries a pipeline strip", !!strip, !!strip);
      ok("the strip counts the queued rows", num(strip?.querySelector(".cp-ip-pipe-queued")) === queue().length, `${num(strip?.querySelector(".cp-ip-pipe-queued"))} vs ${queue().length}`);
      ok("the strip counts pending IP", num(strip?.querySelector(".cp-ip-pipe-pending")) === 3, num(strip?.querySelector(".cp-ip-pipe-pending")));
      ok("the strip counts banked IP", num(strip?.querySelector(".cp-ip-pipe-banked")) === 38, num(strip?.querySelector(".cp-ip-pipe-banked")));
      ok("the strip reads left to right through the pipeline", strip?.querySelectorAll(".cp-ip-pipe-arrow").length === 2, strip?.querySelectorAll(".cp-ip-pipe-arrow").length);

      // (a) the queue is the section that grows, and it scrolls rather than pushing the footer out.
      const queueBox = root()?.querySelector(".cp-ip-queue");
      const balBox = root()?.querySelector(".cp-ip-balances");
      const footer = root()?.querySelector(".cp-ip-footer");
      ok("the queue section is present in RAW mode", !!queueBox, !!queueBox);
      const contentRect = root()?.querySelector(".window-content")?.getBoundingClientRect();
      const footRect = footer?.getBoundingClientRect();
      ok("the footer sits inside the window", !!footRect && !!contentRect && footRect.bottom <= contentRect.bottom + 1, `${Math.round(footRect?.bottom)} vs ${Math.round(contentRect?.bottom)}`);
      ok("the queue is the taller of the two lists", queueBox?.clientHeight > balBox?.clientHeight, `${queueBox?.clientHeight} vs ${balBox?.clientHeight}`);

      // Pre-filled amount + Enter awards the row (manual model).
      const firstRow = root()?.querySelector(".cp-ip-row");
      const firstAmt = firstRow?.querySelector(".cp-ip-amount");
      firstAmt.value = "4";
      firstAmt.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(200);
      firstAmt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await sleep(900);
      const rowSkillId = firstRow.dataset.rowId;
      ok("Enter awards the row it was typed into", !queue().some(r => r.id === rowSkillId), queue().length);
      const awarded = [sA, sB, sC].map(s => IP.pendingForSkill(actor.items.get(s.id))).reduce((a, b) => a + b, 0);
      ok("the awarded figure reached pending", awarded === 4 + 3, awarded);          // +3 was already pending on sB
      await sleep(200);
      const nextRow = root()?.querySelector(".cp-ip-row");
      const nextAmt = nextRow?.querySelector(".cp-ip-amount");
      ok("the next row arrives pre-filled with the last figure typed",
        nextAmt?.value === "4" && nextRow?.dataset?.rowId !== rowSkillId, `${nextAmt?.value} on ${nextRow?.dataset?.rowId === rowSkillId ? "the SAME row" : "a fresh row"}`);

      // (b) the balances accordion: collapsed, then opened, with the header carrying the totals.
      const block = root()?.querySelector(`.cp-ip-bal-block[data-actor-id="${actor.id}"]`);
      const skillsBox = block?.querySelector(".cp-ip-bal-skills");
      ok("each character is one collapsed line", skillsBox?.classList.contains("cp-hidden") === true, skillsBox?.className);
      ok("the header names the character", block?.querySelector(".cp-ip-bal-toggle")?.textContent?.includes(actor.name), block?.querySelector(".cp-ip-bal-toggle")?.textContent?.trim());
      ok("the header totals what the character has banked", num(block?.querySelector(".cp-ip-bal-sum")) === 30, num(block?.querySelector(".cp-ip-bal-sum")));
      ok("the header carries the pool field", !!block?.querySelector(".cp-ip-pool"), block?.querySelector(".cp-ip-pool")?.value);
      block?.querySelector(".cp-ip-bal-toggle")?.click();
      await sleep(300);
      ok("clicking the header opens the skill rows", skillsBox?.classList.contains("cp-hidden") === false, skillsBox?.className);
      const carrying = actor.items.filter(i => i.type === "skill" && (IP.bankForSkill(i) > 0 || IP.pendingForSkill(i) > 0)).length;
      ok("the opened character lists exactly its skills carrying IP", block?.querySelectorAll(".cp-ip-bal-skill").length === carrying, `${block?.querySelectorAll(".cp-ip-bal-skill").length} vs ${carrying}`);

      // The filter box, over characters and over skills.
      const filter = root()?.querySelector(".cp-ip-filter");
      ok("the balances carry a filter box", !!filter, !!filter);
      filter.value = "Layout Two";
      filter.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(200);
      const otherBlock = root()?.querySelector(`.cp-ip-bal-block[data-actor-id="${other.id}"]`);
      ok("filtering by character hides the others", block?.classList.contains("cp-hidden") === true, block?.className);
      ok("filtering by character keeps the match", otherBlock?.classList.contains("cp-hidden") === false, otherBlock?.className);

      const skillName = actor.items.get(sA.id).name;
      filter.value = skillName;
      filter.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(200);
      ok("filtering by skill keeps the character holding it", root()?.querySelector(`.cp-ip-bal-block[data-actor-id="${actor.id}"]`)?.classList.contains("cp-hidden") === false, "shown");
      const shownSkills = [...(root()?.querySelectorAll(`.cp-ip-bal-block[data-actor-id="${actor.id}"] .cp-ip-bal-skill`) || [])].filter(el => !el.classList.contains("cp-hidden"));
      ok("filtering by skill shows only that skill", shownSkills.length === 1 && shownSkills[0].dataset.skillName === skillName, shownSkills.map(el => el.dataset.skillName).join(","));
      ok("a skill match opens the character it belongs to", root()?.querySelector(`.cp-ip-bal-block[data-actor-id="${actor.id}"] .cp-ip-bal-skills`)?.classList.contains("cp-hidden") === false, "open");
      filter.value = "";
      filter.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(200);
      ok("clearing the filter restores every character", ![...root().querySelectorAll(".cp-ip-bal-block")].some(el => el.classList.contains("cp-hidden")), "all shown");

      // The window survives a width change with its strip on one line and its footer in view.
      // Re-query: several re-renders have replaced the nodes captured at the top of this section.
      const stripH = root()?.querySelector(".cp-ip-pipeline")?.getBoundingClientRect().height;
      await app.setPosition({ width: 900 });
      await sleep(400);
      const wide = app.element?.querySelector(".cp-ip-pipeline")?.getBoundingClientRect().height;
      const wideFoot = app.element?.querySelector(".cp-ip-footer")?.getBoundingClientRect();
      const wideContent = app.element?.querySelector(".window-content")?.getBoundingClientRect();
      ok("the pipeline strip stays one line when the window widens", Math.abs(wide - stripH) < 4, `${Math.round(stripH)}→${Math.round(wide)}`);
      ok("the footer stays in view when the window widens", wideFoot.bottom <= wideContent.bottom + 1, `${Math.round(wideFoot.bottom)} vs ${Math.round(wideContent.bottom)}`);
      await app.setPosition({ width: 560 });
      await sleep(300);

      // The auto-baseline model: a row arrives already worth the baseline.
      await game.settings.set(SCOPE, "ipAwardModel", "autoBaseline");
      await game.settings.set(SCOPE, "ipAutoBaselineAmount", 2);
      await game.settings.set(SCOPE, "ipQueue", []);
      await IP.recordSkillRoll({ actorId: actor.id, skillId: sC.id, actorName: actor.name, skillName: sC.name, total: 16 });
      await sleep(400);
      await app.render(false);
      await sleep(500);
      const autoRow = app.element?.querySelector(".cp-ip-row");
      ok("an auto-baseline row arrives ticked as a success", autoRow?.querySelector(".cp-ip-success")?.checked === true, autoRow?.querySelector(".cp-ip-success")?.checked);
      ok("its bonus field stays a bonus, at zero", autoRow?.querySelector(".cp-ip-amount")?.value === "0", autoRow?.querySelector(".cp-ip-amount")?.value);
      const beforeC = IP.pendingForSkill(actor.items.get(sC.id));
      autoRow?.querySelector('[data-action="ipAward"]')?.click();
      await sleep(900);
      ok("awarding it grants exactly the baseline", IP.pendingForSkill(actor.items.get(sC.id)) - beforeC === 2, IP.pendingForSkill(actor.items.get(sC.id)) - beforeC);

      // (d) Simple mode: no queue section at all.
      await game.settings.set(SCOPE, "ipRawTracking", false);
      await app.render(false);
      await sleep(600);
      ok("Simple mode drops the whole queue section", !app.element?.querySelector(".cp-ip-queue"), !!app.element?.querySelector(".cp-ip-queue"));
      ok("Simple mode paints no queue rows", !app.element?.querySelector(".cp-ip-row"), !!app.element?.querySelector(".cp-ip-row"));
      ok("Simple mode drops the queued step from the strip", !app.element?.querySelector(".cp-ip-pipe-queued"), !!app.element?.querySelector(".cp-ip-pipe-queued"));
      ok("Simple mode keeps the balances ledger", !!app.element?.querySelector(".cp-ip-balances"), !!app.element?.querySelector(".cp-ip-balances"));

      // (4) The connected-GM condition is stated permanently, in both modes.
      const offlineSimple = app.element?.querySelector(".cp-ip-footer-offline")?.textContent?.trim();
      ok("Simple mode still states the connected-GM condition", /\bGM\b/.test(offlineSimple || "") && /connect/i.test(offlineSimple || ""), offlineSimple);
      await game.settings.set(SCOPE, "ipRawTracking", true);
      await app.render(false);
      await sleep(500);
      const offlineRaw = app.element?.querySelector(".cp-ip-footer-offline")?.textContent?.trim();
      ok("RAW mode states the connected-GM condition in the footer", offlineRaw === offlineSimple && !!offlineRaw, offlineRaw);
      ok("the footer line resolves (no raw key leakage)", !(offlineRaw || "CYBERPUNK.").includes("CYBERPUNK."), offlineRaw);
      const foot = app.element?.querySelector(".cp-ip-footer")?.textContent || "";
      ok("the footer describes Apply as releasing pending IP", /Apply/.test(foot) && /pending/i.test(foot), foot.slice(0, 80));
    } catch (e) { out.error = e?.stack || e?.message || String(e); }
    finally {
      try { if (app) await app.close(); } catch {}
      try { if (actor) await actor.delete(); } catch {}
      try { if (other) await other.delete(); } catch {}
      try { const IP = await import("/modules/cp2020-augmented/module/ip/ip.js"); await IP.resetThrottle(); } catch {}
      for (const [k, v] of Object.entries(prev)) { try { if (v !== undefined) await game.settings.set("cp2020-augmented", k, v); } catch {} }
    }
    return out;
  });
  if (S3.error) { console.error("IN-PAGE ERROR (section 3):", S3.error); failures++; }
  failures += report("3 — Pipeline strip, queue-first layout, balances accordion and filter", S3.checks);

  /* ------------------------------------------------------------------ */
  /*  Section 4 — a second GM's window drives coalesced rows by relay     */
  /* ------------------------------------------------------------------ */
  // Every queue write funnels through the ACTIVE GM so two clients can't clobber the world setting.
  // The rework added two mutations to that path (prune a roll, clear the queue) and changed the shape
  // of the rows the old ones act on, so the relay is re-proven from a second GM's window.
  const S4 = { checks: [] };
  let pageB = null;
  try {
    await page.evaluate(async () => {
      for (const u of game.users.filter(u => u.name === "__PW__GM2")) await u.delete().catch(() => {});
      await User.create({ name: "__PW__GM2", role: 4 });
    });
    pageB = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    pageB.on("pageerror", (e) => pageErrors.push("B: " + String(e?.message || e)));
    pageB.on("console", (m) => { if (m.type() === "error") pageErrors.push("B: " + m.text()); });
    await joinAs(pageB, /^__PW__GM2$/, [""]);

    const roles = {
      a: await page.evaluate(() => ({ id: game.user.id, active: game.users.activeGM?.id === game.user.id })),
      b: await pageB.evaluate(() => ({ id: game.user.id, active: game.users.activeGM?.id === game.user.id })),
    };
    S4.checks.push({ name: "exactly one of the two GM clients is the active GM", pass: roles.a.active !== roles.b.active, got: `A=${roles.a.active} B=${roles.b.active}` });
    const host = roles.a.active ? page : pageB;      // owns the world-setting writes
    const guest = roles.a.active ? pageB : page;     // must reach them by relay

    // Fixture + three coalesced rolls, built on the active GM's client.
    const ids = await host.evaluate(async () => {
      const SCOPE = "cp2020-augmented";
      const IP = await import("/modules/cp2020-augmented/module/ip/ip.js");
      for (const x of game.actors.filter(x => x.name === "__PW__ IP Relay")) await x.delete().catch(() => {});
      await game.settings.set(SCOPE, "ipRawTracking", true);
      await game.settings.set(SCOPE, "ipAwardModel", "manual");
      await game.settings.set(SCOPE, "ipThrottle", "off");
      await game.settings.set(SCOPE, "ipNeglectMuted", true);
      await game.settings.set(SCOPE, "ipQueue", []);
      const actor = await Actor.create({ name: "__PW__ IP Relay", type: "character" });
      const [sA, sB] = actor.items.filter(i => i.type === "skill");
      for (const t of [12, 18, 7]) await IP.recordSkillRoll({ actorId: actor.id, skillId: sA.id, actorName: actor.name, skillName: sA.name, total: t });
      await IP.recordSkillRoll({ actorId: actor.id, skillId: sB.id, actorName: actor.name, skillName: sB.name, total: 20 });
      await new Promise(r => setTimeout(r, 400));
      return { actorId: actor.id, skillA: sA.id, skillB: sB.id };
    });

    // The guest's window drives: prune a roll, award the group, dismiss the other row.
    const guestOut = await guest.evaluate(async ({ actorId, skillA }) => {
      const SCOPE = "cp2020-augmented";
      const out = {};
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const waitFor = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch {} await sleep(60); } return null; };
      const T = await import("/modules/cp2020-augmented/module/ip/tracker.js");
      const app = new T.IpTracker();
      await app.render(true);
      await sleep(700);
      const q = () => game.settings.get(SCOPE, "ipQueue") || [];
      const group = q().find(r => r.skillId === skillA);
      out.groupSeen = (group?.rolls || []).length;
      const rowEl = app.element?.querySelector(`.cp-ip-row[data-row-id="${group.id}"]`);
      out.countPainted = rowEl?.querySelector(".cp-ip-row-count")?.textContent?.trim();

      rowEl?.querySelector(".cp-ip-row-label")?.click();
      await sleep(200);
      rowEl?.querySelector(".cp-ip-roll .cp-ip-roll-prune")?.click();
      out.afterPrune = (await waitFor(() => { const g = q().find(r => r.id === group.id); return (g?.rolls || []).length === 2 ? g : null; })) ? 2 : (q().find(r => r.id === group.id)?.rolls || []).length;

      const live = app.element?.querySelector(`.cp-ip-row[data-row-id="${group.id}"]`);
      const amt = live?.querySelector(".cp-ip-amount");
      if (amt) { amt.value = "9"; amt.dispatchEvent(new Event("change", { bubbles: true })); }
      await sleep(300);
      app.element?.querySelector(`.cp-ip-row[data-row-id="${group.id}"] [data-action="ipAward"]`)?.click();
      out.groupGone = !!(await waitFor(() => !q().some(r => r.id === group.id)));

      const otherId = q()[0]?.id;
      app.element?.querySelector(`.cp-ip-row[data-row-id="${otherId}"] [data-action="ipSkip"]`)?.click();
      out.dismissed = !!(await waitFor(() => !q().some(r => r.id === otherId)));
      out.remaining = q().length;
      await app.close();
      return out;
    }, ids);

    const hostOut = await host.evaluate(async ({ actorId, skillA }) => {
      const IP = await import("/modules/cp2020-augmented/module/ip/ip.js");
      const actor = game.actors.get(actorId);
      return { pending: IP.pendingForSkill(actor.items.get(skillA)), queue: (game.settings.get("cp2020-augmented", "ipQueue") || []).length };
    }, ids);

    const push = (name, pass, got) => S4.checks.push({ name, pass, got });
    push("the second window sees the coalesced group", guestOut.groupSeen === 3, guestOut.groupSeen);
    push("the second window paints the count", guestOut.countPainted === "×3", guestOut.countPainted);
    push("pruning a roll from the second window lands", guestOut.afterPrune === 2, guestOut.afterPrune);
    push("awarding the group from the second window lands", guestOut.groupGone === true, guestOut.groupGone);
    push("the award reached pending on the active GM's client", hostOut.pending === 9, hostOut.pending);
    push("dismissing a row from the second window lands", guestOut.dismissed === true, guestOut.dismissed);
    push("both clients agree the queue is empty", guestOut.remaining === 0 && hostOut.queue === 0, `guest=${guestOut.remaining} host=${hostOut.queue}`);
  } catch (e) {
    console.error("IN-PAGE ERROR (section 4):", e?.stack || e?.message || e);
    failures++;
  } finally {
    try {
      await page.evaluate(async () => {
        for (const x of game.actors.filter(x => x.name === "__PW__ IP Relay")) await x.delete().catch(() => {});
        for (const u of game.users.filter(u => u.name === "__PW__GM2")) await u.delete().catch(() => {});
      });
    } catch {}
    try { if (pageB) await pageB.context().close(); } catch {}
  }
  failures += report("4 — A second GM's window drives coalesced rows through the relay", S4.checks);

  const clean = pageErrors.length === 0;
  console.log(`\n  [${clean ? "PASS" : "FAIL"}] ${"0 console errors".padEnd(62)} got=${pageErrors.length}`);
  if (!clean) { console.log("    " + pageErrors.slice(0, 8).join("\n    ")); failures++; }

  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
