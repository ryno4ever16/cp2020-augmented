/**
 * KEEPER (two-session, cross-client): cover Unit 2 — the damage-dialog picker + chew relay.
 *
 * Contract: a PLAYER opens the real Apply Damage dialog against a GM-owned target standing near
 * a cover zone → the picker lists the zone (nearest first) → selecting it sets Cover SP from the
 * zone (preview follows) → Apply routes damage over the applyDamage relay AND debits the zone's
 * structure over the coverChew relay (both GM-side writes). Manual mode chews nothing.
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const SHOT_DIR = process.env.SHOT_DIR ?? ".";

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

// GM setup: active scene, a GM-owned NPC token near a cover zone
const setup = await gm.page.evaluate(async () => {
  const SCOPE = "cp2020-augmented";
  if (!game.scenes.active) await (game.scenes.getName("Foundry Virtual Tabletop") ?? game.scenes.contents[0])?.activate();
  const scene = game.scenes.active;
  for (const r of [...scene.regions]) if (r.name?.startsWith("__PWX__")) await r.delete();
  for (const a of [...game.actors]) if (a.name?.startsWith("__PWX__")) await a.delete();

  const cov = await import(`/modules/${SCOPE}/module/combat/cover.js`);
  const region = await cov.placeCoverZone({ scene, label: "__PWX__CarBody", sp: 10 });   // pool 30
  await region.update({ shapes: [{ type: "rectangle", x: 900, y: 900, width: 200, height: 100, rotation: 0 }] });
  const behavior = region.behaviors.find(b => b.type === `${SCOPE}.coverZone`);

  const npc = await Actor.create({ name: "__PWX__Victim", type: "npc" });
  const [tok] = await scene.createEmbeddedDocuments("Token", [{
    name: npc.name, actorId: npc.id, actorLink: true, x: 1000, y: 1100, width: 1, height: 1,
  }]);
  const hp0 = Number(npc.system.damage) || 0;
  return { regionId: region.id, behaviorUuid: behavior.uuid, npcId: npc.id, tokenId: tok.id, hp0, sceneId: scene.id };
});

// Player session: open the REAL dialog, pick the zone, apply
const pl = await join(browser, "test user 1", ["", GM_PW]);
await pl.page.evaluate(async ({ npcId, tokenId }) => {
  const { DamageDialog } = await import("/modules/cp2020-augmented/module/combat/DamageDialog.js");
  const target = game.actors.get(npcId);
  const payload = { areaDamages: { Torso: [{ damage: 14 }] }, targetTokenId: tokenId, weaponName: "Keeper SMG" };
  window.__pwDlg = new DamageDialog(payload, target);
  await window.__pwDlg.render(true);
}, setup);

await pl.page.waitForSelector('select[name="coverZone"]', { timeout: 10000 });
const optText = await pl.page.evaluate(() =>
  [...document.querySelectorAll('select[name="coverZone"] option')].map(o => o.textContent.trim()));
check("picker lists the zone with SP + pool", optText.some(t => t.includes("__PWX__CarBody") && t.includes("SP 10") && t.includes("30/30")), optText.join(" | "));

// select the zone via a REAL change event; the coverSP input must follow
await pl.page.evaluate(uuid => {
  const sel = document.querySelector('select[name="coverZone"]');
  sel.value = uuid;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}, setup.behaviorUuid);
await pl.page.waitForFunction(() => document.querySelector('input[name="coverSP"]')?.value === "10", null, { timeout: 5000 });
check("selecting the zone sets Cover SP 10", true);
await pl.page.screenshot({ path: `${SHOT_DIR}/cover-picker-dialog.png` });

// zone survives re-render selected
const stillSelected = await pl.page.evaluate(() => document.querySelector('select[name="coverZone"]')?.value !== "");
check("selection survives the re-render", stillSelected);

// Apply — player path: damage relay + chew relay, both land GM-side
await pl.page.click('.damage-dialog button[data-action="applyDamage"]');

const after = await gm.page.evaluate(async ({ npcId, behaviorUuid, hp0 }) => {
  for (let i = 0; i < 60; i++) {
    const npc = game.actors.get(npcId);
    const behavior = await fromUuid(behaviorUuid);
    const hp = Number(npc?.system?.damage) || 0;
    const pool = Number(behavior?.system?.pool);
    if (hp !== hp0 && pool !== 30) return { hp, pool, destroyed: behavior.system.destroyed };
    await new Promise(r => setTimeout(r, 300));
  }
  const behavior = await fromUuid(behaviorUuid);
  return { timeout: true, hp: Number(game.actors.get(npcId)?.system?.damage) || 0, pool: Number(behavior?.system?.pool), destroyed: behavior?.system?.destroyed };
}, setup);
check("both relay writes landed (no timeout)", !after.timeout, JSON.stringify(after));

// cover SP 10 vs 14 raw: proportional fold vs bare torso armor — damage went DOWN but through;
// exact HP delta depends on the NPC's armor (0) => afterSP = 14 - 10 = 4 net before BTM.
check("damage landed on the NPC (through cover)", after.hp > setup.hp0, `hp ${setup.hp0} -> ${after.hp}`);
check("chew debited RAW damage: pool 30 -> 16", after.pool === 16, `pool ${after.pool}`);
check("zone not destroyed", after.destroyed === false);

const chewCard = await gm.page.evaluate(async () => {
  for (let i = 0; i < 20; i++) {
    const m = [...game.messages].reverse().find(x => x.content.includes("cp-cover-chew"));
    if (m) return m.content.includes("__PWX__CarBody") && m.content.includes("14");
    await new Promise(r => setTimeout(r, 250));
  }
  return "no card";
});
check("chew card posted with zone + damage", chewCard === true, String(chewCard));

// Manual mode: re-open, DON'T pick a zone, apply — pool must not move
await pl.page.evaluate(async ({ npcId, tokenId }) => {
  const { DamageDialog } = await import("/modules/cp2020-augmented/module/combat/DamageDialog.js");
  const target = game.actors.get(npcId);
  window.__pwDlg2 = new DamageDialog({ areaDamages: { Torso: [{ damage: 6 }] }, targetTokenId: tokenId }, target);
  await window.__pwDlg2.render(true);
}, setup);
await pl.page.waitForSelector('.damage-dialog button[data-action="applyDamage"]', { timeout: 10000 });
await pl.page.click('.damage-dialog button[data-action="applyDamage"]');
await new Promise(r => setTimeout(r, 3000));
const manual = await gm.page.evaluate(async ({ behaviorUuid }) => {
  const b = await fromUuid(behaviorUuid);
  return Number(b.system.pool);
}, setup);
check("manual mode chews nothing (pool still 16)", manual === 16, String(manual));

// cleanup
await gm.page.evaluate(async ({ regionId, npcId, tokenId, sceneId }) => {
  const scene = game.scenes.get(sceneId);
  if (scene.tokens.get(tokenId)) await scene.deleteEmbeddedDocuments("Token", [tokenId]);
  await scene.regions.get(regionId)?.delete();
  await game.actors.get(npcId)?.delete();
  for (const m of [...game.messages].filter(x => x.content.includes("__PWX__") || x.content.includes("cp-cover-chew"))) await m.delete();
}, setup);

check("0 GM console errors", gmErrors.length === 0, gmErrors.slice(0, 3).join(" | "));
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
