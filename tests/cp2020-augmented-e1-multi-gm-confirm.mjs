/**
 * E1/E4 multi-GM verification (:30004, official 1.1.1 + module) — TWO GM clients.
 *
 * E1: with two GMs, both clicking "Confirm" on a blast used to apply the area damage twice (the button
 *     disables only in the clicking client's DOM). The fix routes every Confirm to the active GM and
 *     guards on the template id so a double-click/relay is idempotent. Proof: a NON-active GM emits the
 *     confirm-explosion relay TWICE; the first application lands (relay works), the second is a no-op
 *     (guard) → the NPC takes exactly one blast.
 * E4: the death/stun per-turn card was isGM-gated (posts on every connected GM) — now activeGM-gated.
 *     Verified by served-source (the gate is present); it mirrors the proven activeGM pattern E1 exercises.
 *
 * Run from tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-e1-multi-gm-confirm.mjs
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

const COUNT_ISEXPLOSION = () => {
  const scene = game.scenes.active ?? canvas.scene;
  const out = [];
  for (const coll of [scene.templates, scene.regions]) if (coll) for (const d of coll) if (d.flags?.["cp2020-augmented"]?.isExplosion) out.push(d.id);
  return out;
};

const browser = await chromium.launch({ headless: true });
const results = {};
const log = [];
try {
  // ---- GM #1 (Gamemaster): ensure a 2nd GM user exists + world setup ----
  const gm1 = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await joinAs(gm1, /^gamemaster$/i, [GM_PW]);
  await gm1.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});

  const src = await gm1.evaluate(async () => {
    const dh = await (await fetch("/modules/cp2020-augmented/module/combat/damage-hooks.js", { cache: "no-store" })).text();
    const sr = await (await fetch("/modules/cp2020-augmented/module/combat/save-rolls.js", { cache: "no-store" })).text();
    return {
      e1Code: dh.includes("_claimAreaConfirm") && dh.includes("AREA_CONFIRMERS") && dh.includes("_resolvedAreaConfirms"),
      // E4: the death/stun updateCombat handler now activeGM-gated (the gate line follows the isGM guard).
      e4Gate: /Only the ACTIVE GM processes this[\s\S]{0,400}activeGM\?\.id !== game\.user\.id\) return;/.test(sr),
    };
  });
  log.push(`served: e1Code(_claimAreaConfirm+AREA_CONFIRMERS)=${src.e1Code} e4Gate(activeGM)=${src.e4Gate}`);
  results.served = { pass: src.e1Code && src.e4Gate, detail: "damage-hooks carries the confirm relay+guard; save-rolls death/stun handler is activeGM-gated" };

  const S = await gm1.evaluate(async () => {
    // Ensure a second GM user (idempotent). Empty password → join with "".
    let gm2 = game.users.find(u => u.name === "__PW__GM2");
    if (!gm2) gm2 = await User.create({ name: "__PW__GM2", role: CONST.USER_ROLES.GAMEMASTER });
    // Clean prior fixtures + explosion areas.
    for (const a of game.actors.filter(a => a.name?.startsWith("__PWE__"))) await a.delete().catch(()=>{});
    const scene = game.scenes.active ?? canvas.scene;
    for (const t of scene.tokens.filter(t => t.name?.startsWith("__PWE__"))) await t.delete().catch(()=>{});
    for (const coll of [scene.templates, scene.regions]) if (coll) for (const d of [...coll]) if (d.flags?.["cp2020-augmented"]?.isExplosion) await d.delete().catch(()=>{});

    const pc  = await Actor.create({ name: "__PWE__PC",  type: "character" });
    const npc = await Actor.create({ name: "__PWE__NPC", type: "character" });
    const mk = (a, x) => ({ name: a.name, actorId: a.id, x, y: 1000, width: 1, height: 1, disposition: 0, actorLink: true });
    const [pcTok]  = await scene.createEmbeddedDocuments("Token", [mk(pc, 500)]);    // attacker, away from blast
    const [npcTok] = await scene.createEmbeddedDocuments("Token", [mk(npc, 1400)]);  // target = blast centre
    return { gm2Name: gm2.name, pcId: pc.id, npcId: npc.id, pcTokenId: pcTok.id, npcTokenId: npcTok.id };
  });
  log.push(`setup: gm2=${S.gm2Name} pc=${S.pcId} npc=${S.npcId}`);

  // ---- GM #2 joins (empty password) ----
  const gm2 = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await joinAs(gm2, /__PW__GM2/i, ["", GM_PW]);
  await gm2.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});

  // Which client is the ACTIVE GM? The confirm must be emitted from the NON-active GM (a socket.emit does
  // not reach its own sender, and only the active GM resolves the confirm).
  const who1 = await gm1.evaluate(() => ({ me: game.user.id, active: game.users.activeGM?.id }));
  const who2 = await gm2.evaluate(() => ({ me: game.user.id, active: game.users.activeGM?.id }));
  const activePage = who1.me === who1.active ? gm1 : gm2;
  const emitterPage = activePage === gm1 ? gm2 : gm1;
  log.push(`activeGM=${who1.active}; emitting confirms from the NON-active GM`);
  if (who1.active !== who2.active) log.push(`⚠ clients disagree on activeGM (${who1.active} vs ${who2.active})`);

  // Place a 20-damage blast centred on the NPC (fire Explosive from the emitter → active GM places it).
  await emitterPage.evaluate((d) => {
    Hooks.callAll("cyberpunk2020.weaponFired", {
      attackerId: d.pcId, targetTokenId: d.npcTokenId, effectTypes: ["Explosive"],
      areaDamages: { Torso: [{ damage: 20 }] }, blastRadius: 5, weaponName: "PWE Grenade",
    });
  }, S);
  const templateId = await activePage.evaluate(async (fnStr) => {
    const COUNT = eval("(" + fnStr + ")");
    for (let i = 0; i < 40; i++) { const ids = COUNT(); if (ids.length) return ids[0]; await new Promise(r => setTimeout(r, 200)); }
    return null;
  }, COUNT_ISEXPLOSION.toString());
  log.push(`blast placed: templateId=${templateId}`);
  if (!templateId) throw new Error("blast was not placed (isExplosion area not found)");

  const dmg = async () => activePage.evaluate((id) => Number(game.actors.get(id).system.damage) || 0, S.npcId);
  const pollDmgChange = async (from) => activePage.evaluate(async ({ id, from }) => {
    for (let i = 0; i < 30; i++) { const v = Number(game.actors.get(id).system.damage) || 0; if (v !== from) return v; await new Promise(r => setTimeout(r, 200)); }
    return Number(game.actors.get(id).system.damage) || 0;
  }, { id: S.npcId, from });

  const D0 = await dmg();
  // Emit #1 (relay from the non-active GM → active GM applies).
  await emitterPage.evaluate((id) => game.socket.emit("module.cp2020-augmented", { type: "confirmExplosion", templateId: id }), templateId);
  const D1 = await pollDmgChange(D0);
  // Emit #2 (double-confirm — the guard must make this a no-op).
  await emitterPage.evaluate((id) => game.socket.emit("module.cp2020-augmented", { type: "confirmExplosion", templateId: id }), templateId);
  await activePage.waitForTimeout(1500);   // give a (wrongly) double-applied hit time to land
  const D2 = await dmg();
  log.push(`NPC damage: D0=${D0} → D1=${D1} (after 1st confirm) → D2=${D2} (after 2nd confirm)`);

  results.E1_relay_applies = { pass: D1 > D0, detail: `non-active GM's Confirm reached the active GM and applied one blast (${D0}→${D1})` };
  results.E1_no_double_apply = { pass: D2 === D1, detail: D2 === D1 ? `second Confirm was a no-op (guard held): stayed ${D1}` : `DOUBLE-APPLIED: ${D1}→${D2}` };

  // cleanup (leave the __PW__GM2 user for reuse)
  await gm1.evaluate(async () => {
    const scene = game.scenes.active ?? canvas.scene;
    for (const t of scene.tokens.filter(t => t.name?.startsWith("__PWE__"))) await t.delete().catch(()=>{});
    for (const coll of [scene.templates, scene.regions]) if (coll) for (const d of [...coll]) if (d.flags?.["cp2020-augmented"]?.isExplosion) await d.delete().catch(()=>{});
    for (const a of game.actors.filter(a => a.name?.startsWith("__PWE__"))) await a.delete().catch(()=>{});
  }).catch(() => {});
} catch (e) {
  log.push("ERROR: " + e.message);
} finally {
  await browser.close();
}

console.log("\n===== E1/E4 MULTI-GM (2 GM clients, :30004) =====");
log.forEach(l => console.log("  • " + l));
console.log("");
let allPass = Object.keys(results).length > 0;
for (const [k, v] of Object.entries(results)) {
  console.log(`  ${v.pass ? "PASS ✅" : "FAIL ❌"}  ${k.padEnd(20)} — ${v.detail}`);
  if (!v.pass) allPass = false;
}
console.log("\n  OVERALL: " + (allPass ? "ALL PASS ✅" : "SOME FAILED ❌"));
process.exit(allPass ? 0 : 1);
