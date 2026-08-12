/**
 * KEEPER (two-session, cross-client): cover — the whole attribution chain from a player's window.
 *
 * Contract: a PLAYER opens the real Apply Damage window for a shot whose line crosses a cover
 * object → no cover-object selector exists, the Cover SP field is seeded from the crossed object,
 * and Apply routes the damage over the applyDamage relay AND ONE structure debit over the coverChew
 * relay (both GM-side writes). The debit is taken ROUND BY ROUND: the burst's third round empties
 * the object, so the fourth faces no cover and lands its full roll, and the single summary card
 * reports the per-round wear plus the round the object gave out on. A window opened with no
 * attacker (the hand-opened case) seeds nothing and debits nothing.
 *
 * The spec builds and activates its OWN scene — a shared scene carrying standing cover fixtures
 * would put unrelated objects on the shot line — and hands the previous one back at the end.
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const SHOT_DIR = process.env.SHOT_DIR ?? null;

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function join(browser, userRe, passwords) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`${URL}/join`);
  await page.waitForSelector('select[name="userid"]');
  const userName = await page.evaluate(re => {
    const sel = document.querySelector('select[name="userid"]');
    const opt = [...sel.options].find(o => new RegExp(re, "i").test(o.textContent));
    if (!opt) return null;
    sel.value = opt.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return opt.textContent.trim();
  }, userRe);
  if (!userName) throw new Error(`no user matching ${userRe}`);
  for (const pw of passwords) {
    await page.fill('input[name="password"]', pw);
    await page.click('button[name="join"]');
    try {
      await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 20000 });
      return { ctx, page, userName };
    } catch { await page.goto(`${URL}/join`); await page.waitForSelector('select[name="userid"]'); }
  }
  throw new Error(`could not join as ${userRe}`);
}

const browser = await chromium.launch();
const gm = await join(browser, "^gamemaster$", [GM_PW]);
const gmErrors = [];
gm.page.on("console", m => { if (m.type() === "error" && !/compatibility|deprecat|screen resolution/i.test(m.text())) gmErrors.push(m.text()); });

/* ── GM setup: a scene of this spec's own, a shooter, a GM-owned target, one object between them ── */
const setup = await gm.page.evaluate(async () => {
  const SCOPE = "cp2020-augmented";
  const prevActiveId = game.scenes.active?.id ?? null;
  for (const s of [...game.scenes]) if (s.name?.startsWith("__PWX__")) await s.delete();
  for (const a of [...game.actors]) if (a.name?.startsWith("__PWX__")) await a.delete();

  const [scene] = await Scene.create([{
    name: "__PWX__CoverBurst", width: 4000, height: 3000, padding: 0,
    grid: { size: 100, type: CONST.GRID_TYPES.SQUARE },
  }]);
  await scene.activate();
  for (let i = 0; i < 150 && !(canvas?.ready && canvas.scene?.id === scene.id); i++) await new Promise(r => setTimeout(r, 200));

  const cov = await import(`/modules/${SCOPE}/module/combat/cover.js`);
  const G = scene.grid.size;
  // Shooter at 5G,10G and target at 15G,10G put the shot line on y = 10.5G; the object straddles it.
  const region = await cov.placeCoverZone({ scene, label: "__PWX__CarBody", sp: 10 });   // structure 30
  await region.update({ shapes: [{ type: "rectangle", x: 10 * G, y: 10 * G, width: G, height: G, rotation: 0 }] });
  const behavior = region.behaviors.find(b => b.type === `${SCOPE}.coverZone`);

  const shooter = await Actor.create({ name: "__PWX__Shooter", type: "character" });
  const npc = await Actor.create({ name: "__PWX__Victim", type: "npc" });
  const [aTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PWX__ShooterTok", actorId: shooter.id, actorLink: true, x: 5 * G, y: 10 * G, width: 1, height: 1 }]);
  const [tTok] = await scene.createEmbeddedDocuments("Token", [{ name: npc.name, actorId: npc.id, actorLink: true, x: 15 * G, y: 10 * G, width: 1, height: 1 }]);

  return {
    sceneId: scene.id, prevActiveId, regionId: region.id, behaviorUuid: behavior.uuid,
    shooterId: shooter.id, npcId: npc.id, aTokId: aTok.id, tTokId: tTok.id,
    hp0: Number(npc.system.damage) || 0,
    btm: Number(npc.system.stats?.bt?.modifier) || 0,
    pool0: Number(behavior.system.pool) || 0,
  };
});
check("the object starts at its 3xSP structure (30)", setup.pool0 === 30, String(setup.pool0));

/* ── Player session: the real window, opened the way a shot opens it ── */
const pl = await join(browser, "test user 1", ["", GM_PW]);
await pl.page.waitForFunction(id => canvas?.ready && canvas.scene?.id === id, setup.sceneId, { timeout: 30000 });

const msgIdsBefore = await gm.page.evaluate(() => game.messages.map(m => m.id));

await pl.page.evaluate(async ({ npcId, tTokId, aTokId }) => {
  const { DamageDialog } = await import("/modules/cp2020-augmented/module/combat/DamageDialog.js");
  const target = game.actors.get(npcId);
  // Four rounds of 14 against structure 30: 14 -> 16 left, 14 -> 2 left, 2 empties it (that round
  // was still shot through the object), and the fourth faces nothing.
  const payload = {
    areaDamages: { Torso: [{ damage: 14 }, { damage: 14 }, { damage: 14 }, { damage: 14 }] },
    targetTokenId: tTokId, attackerTokenId: aTokId, weaponName: "Keeper Burst",
  };
  window.__pwDlg = new DamageDialog(payload, target);
  await window.__pwDlg.render(true);
}, setup);
await pl.page.waitForSelector('form.damage-dialog input[name="coverSP"]', { timeout: 15000 });

const dlg = await pl.page.evaluate(() => {
  const root = document.querySelector("form.damage-dialog");
  const rows = [...root.querySelectorAll(".damage-hit")].map(r => r.querySelector("input.after-sp-override")?.value ?? null);
  const drains = [...root.querySelectorAll(".cp-damage-breakdown-drain")].map(r => ({
    label: r.querySelector(".cp-bd-label")?.textContent?.trim() ?? "",
    value: r.querySelector(".cp-bd-value")?.textContent?.trim() ?? "",
  }));
  return {
    sp: root.querySelector('input[name="coverSP"]')?.value ?? null,
    selectors: root.querySelectorAll('select[name="coverZone"]').length,
    afterSp: rows, drains,
  };
});
check("no cover-object selector in the player's window", dlg.selectors === 0, `selects ${dlg.selectors}`);
check("Cover SP seeded from the crossed object (10)", dlg.sp === "10", String(dlg.sp));
check("preview: rounds 1-3 resolve through the object (after-SP 4 each)",
  dlg.afterSp.slice(0, 3).every(v => v === "4"), dlg.afterSp.join(","));
check("preview: round 4 faces no cover and lands its full 14", dlg.afterSp[3] === "14", dlg.afterSp.join(","));
check("preview: the math line drains the object round by round (30 -> 16 -> 2 -> destroyed)",
  dlg.drains.length === 3
  && dlg.drains[0].value.includes("16 / 30") && dlg.drains[1].value.includes("2 / 30")
  && /destroyed/i.test(dlg.drains[2].value),
  dlg.drains.map(d => `${d.label}:${d.value}`).join(" | "));
check("preview: every drain line names the object", dlg.drains.every(d => d.label === "__PWX__CarBody"), dlg.drains.map(d => d.label).join(","));
// Only on request — an unasked-for screenshot lands in whatever directory the run started from.
if (SHOT_DIR) await pl.page.screenshot({ path: `${SHOT_DIR}/cover-breakdown-dialog.png` });

/* ── Apply: both relay writes land GM-side ── */
await pl.page.click('.damage-dialog button[data-action="applyDamage"]');

// The relay writes the rounds one at a time, so "something changed" is not "the burst finished" —
// wait for the value to STOP moving before reading it, or a poll lands mid-burst and reports a
// partial total as the answer.
const after = await gm.page.evaluate(async ({ npcId, behaviorUuid, hp0 }) => {
  const read = async () => {
    const behavior = await fromUuid(behaviorUuid);
    return {
      hp: Number(game.actors.get(npcId)?.system?.damage) || 0,
      pool: Number(behavior?.system?.pool),
      destroyed: behavior?.system?.destroyed,
      sp: behavior?.system?.sp,
    };
  };
  let prev = null, stable = 0;
  for (let i = 0; i < 80; i++) {
    const now = await read();
    const moved = now.hp !== hp0 && now.pool !== 30;
    stable = (prev && now.hp === prev.hp && now.pool === prev.pool) ? stable + 1 : 0;
    if (moved && stable >= 3) return now;
    prev = now;
    await new Promise(r => setTimeout(r, 250));
  }
  return { timeout: true, ...(await read()) };
}, setup);
check("both relay writes landed (no timeout)", !after.timeout, JSON.stringify(after));

const expectedHp = [4, 4, 4, 14].reduce((s, a) => s + Math.max(1, a - setup.btm), 0);
check("the damage written is the four rounds' own values", after.hp - setup.hp0 === expectedHp, `delta ${after.hp - setup.hp0}, expected ${expectedHp} (btm ${setup.btm})`);
check("the whole structure was debited in one write: 30 -> 0", after.pool === 0, `pool ${after.pool}`);
check("the object reads destroyed", after.destroyed === true, String(after.destroyed));
check("its SP never moved while it stood (book rule)", after.sp === 10, String(after.sp));

/* ── The summary card: ONE card for the burst, carrying the round-by-round wear ── */
const card = await gm.page.evaluate(async (before) => {
  const seen = new Set(before);
  for (let i = 0; i < 24; i++) {
    const cards = game.messages.filter(m => !seen.has(m.id) && m.content.includes("cp-cover-chew"));
    if (cards.length) return { count: cards.length, content: cards[cards.length - 1].content };
    await new Promise(r => setTimeout(r, 250));
  }
  return { count: 0, content: "" };
}, msgIdsBefore);
check("exactly ONE chew card for the whole burst", card.count === 1, String(card.count));
check("the card totals the burst (30)", /absorbed 30/.test(card.content), card.content.replace(/<[^>]+>/g, " ").slice(0, 200));
check("the card lists one line per debiting round", (card.content.match(/<li>/g) ?? []).length === 3, String((card.content.match(/<li>/g) ?? []).length));
check("the card's round lines carry the falling structure", /16 \/ 30/.test(card.content) && /2 \/ 30/.test(card.content), card.content.replace(/<[^>]+>/g, " ").slice(0, 300));
check("the card names the round the object gave out on (3)", /gave out on round 3/.test(card.content), card.content.replace(/<[^>]+>/g, " ").slice(0, 300));
check("the card names the object", /__PWX__CarBody/.test(card.content));

/* ── Negative: a window with no attacker seeds nothing and debits nothing ── */
const poolBefore = await gm.page.evaluate(async ({ behaviorUuid }) => {
  const b = await fromUuid(behaviorUuid);
  await b.update({ system: { pool: 20, destroyed: false } });   // stand it back up for the negative
  return Number(b.system.pool);
}, setup);
check("object stood back up for the negative case (20)", poolBefore === 20, String(poolBefore));

await pl.page.evaluate(async ({ npcId, tTokId }) => {
  const { DamageDialog } = await import("/modules/cp2020-augmented/module/combat/DamageDialog.js");
  window.__pwDlg2 = new DamageDialog({ areaDamages: { Torso: [{ damage: 6 }] }, targetTokenId: tTokId }, game.actors.get(npcId));
  await window.__pwDlg2.render(true);
}, setup);
await pl.page.waitForSelector('.damage-dialog button[data-action="applyDamage"]', { timeout: 10000 });
const noSeed = await pl.page.evaluate(() => document.querySelector('form.damage-dialog input[name="coverSP"]')?.value ?? null);
check("no attacker token: Cover SP stays 0", noSeed === "0", String(noSeed));
await pl.page.click('.damage-dialog button[data-action="applyDamage"]');
await new Promise(r => setTimeout(r, 3000));
const untouched = await gm.page.evaluate(async ({ behaviorUuid }) => Number((await fromUuid(behaviorUuid)).system.pool), setup);
check("no attacker token: nothing is debited (structure still 20)", untouched === 20, String(untouched));

/* ── cleanup + rig hygiene ── */
await gm.page.evaluate(async ({ sceneId, prevActiveId }) => {
  for (const app of [...foundry.applications.instances.values()]) {
    if (app.constructor?.name === "DamageDialog") await app.close().catch(() => {});
  }
  for (const a of [...game.actors]) if (a.name?.startsWith("__PWX__")) await a.delete().catch(() => {});
  for (const m of [...game.messages].filter(x => x.content.includes("__PWX__") || x.content.includes("cp-cover-chew"))) await m.delete().catch(() => {});
  const prev = prevActiveId ? game.scenes.get(prevActiveId) : null;
  if (prev) { await prev.activate().catch(() => {}); for (let i = 0; i < 150 && canvas?.scene?.id !== prev.id; i++) await new Promise(r => setTimeout(r, 200)); }
  await game.scenes.get(sceneId)?.delete().catch(() => {});
}, setup).catch(e => console.log(`  (cleanup warning: ${e.message})`));

const leftovers = await gm.page.evaluate(({ prevActiveId }) => ({
  probeScenes: game.scenes.filter(s => s.name?.startsWith("__PWX__")).length,
  actors: game.actors.filter(a => a.name?.startsWith("__PWX__")).length,
  activeRestored: (game.scenes.active?.id ?? null) === prevActiveId ? 0 : 1,
}), setup);
check("fixtures swept and the previously active scene handed back", Object.values(leftovers).every(v => v === 0), JSON.stringify(leftovers));

check("0 GM console errors", gmErrors.length === 0, gmErrors.slice(0, 3).join(" | "));
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
