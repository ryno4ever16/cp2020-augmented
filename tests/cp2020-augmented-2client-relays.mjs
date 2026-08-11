/**
 * 2-CLIENT player→GM socket-relay verification for cp2020-augmented on :30004 (official 1.1.1 + module).
 *
 * Covers the whole "non-GM can't use automation" group — each is masked by single-GM play because the GM
 * applies locally and never emits; only a PLAYER acting on a GM-owned target/scene hits the relay:
 *   A2  player fires a normal weapon at a GM-owned NPC        → GM applies damage
 *   A4a player fires an Explosive round                       → GM places the blast area (isExplosion)
 *   A4b player fires a Gas round                              → GM places the cloud   (isGasCloud)
 *   A4c player fires a Spread (shotgun) round                 → GM places the pattern (isSpreadZone)
 *   A5  player launches a guided missile                      → GM spawns the missile token
 *
 * Run from tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node _2client-all.mjs
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

// In-page: count scene areas carrying a given module flag (v14 Region or v13 MeasuredTemplate).
// createArea/areasByFlag store area flags under the "cp2020-augmented" scope (area-shapes.js:62,171).
const COUNT_AREAS = (flag) => {
  const scene = game.scenes.active ?? canvas.scene;
  let n = 0;
  for (const coll of [scene.templates, scene.regions]) {
    if (!coll) continue;
    for (const d of coll) if (d.flags?.["cp2020-augmented"]?.[flag]) n++;
  }
  return n;
};

const browser = await chromium.launch({ headless: true });
const results = {};
const log = [];
try {
  // ---- GM: source check + world setup ----
  const gmCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const gm = await gmCtx.newPage();
  await joinAs(gm, /gamemaster/i, [GM_PW]);
  await gm.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});

  const src = await gm.evaluate(async () => {
    const r = await fetch("/modules/cp2020-augmented/module/combat/damage-hooks.js", { cache: "no-store" });
    const t = await r.text();
    return { oldEmits: (t.match(/emit\("system\.cyberpunk2020"/g) || []).length,
             newEmits: (t.match(/emit\("module\.cp2020-augmented"/g) || []).length };
  });
  log.push(`served damage-hooks.js: oldChannelEmits=${src.oldEmits} newChannelEmits=${src.newEmits}`);
  if (src.oldEmits > 0 || src.newEmits === 0) throw new Error("rig not serving edited code");

  const S = await gm.evaluate(async (COUNT_AREAS_STR) => {
    const COUNT_AREAS = eval("(" + COUNT_AREAS_STR + ")");
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__") || a.name === "Missile")) await a.delete().catch(()=>{});
    const scene = game.scenes.active ?? canvas.scene;
    for (const t of scene.tokens.filter(t => t.name?.startsWith("__PW__") || t.flags?.["cp2020-augmented"]?.missile)) await t.delete().catch(()=>{});
    const F0 = (d)=> d.flags?.["cp2020-augmented"] ?? {};
    for (const coll of [scene.templates, scene.regions]) if (coll) for (const d of [...coll]) if (F0(d).isExplosion||F0(d).isGasCloud||F0(d).isSpreadZone||F0(d).isSuppressiveZone) await d.delete().catch(()=>{});
    let mmPrev; try { mmPrev = game.settings.get("cp2020-augmented", "mmEnabled"); await game.settings.set("cp2020-augmented", "mmEnabled", true); } catch(e){}

    const player = game.users.find(u => u.role === 1);
    const npc = await Actor.create({ name: "__PW__NPC", type: "character" });
    const pc  = await Actor.create({ name: "__PW__PC",  type: "character" });
    await pc.update({ [`ownership.${player.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
    const mk = (a, x) => ({ name: a.name, actorId: a.id, x, y: 1000, width: 1, height: 1, disposition: 0 });
    const [pcTok]  = await scene.createEmbeddedDocuments("Token", [mk(pc, 1000)]);
    const [npcTok] = await scene.createEmbeddedDocuments("Token", [mk(npc, 1400)]);
    return {
      playerName: player.name, pcId: pc.id, npcId: npc.id, pcTokenId: pcTok.id, npcTokenId: npcTok.id,
      mmPrev,
      npcBtm: Number(npc.system.stats?.bt?.modifier) || 0,   // exact-delta derivation (Torso net = max(1, dmg−BTM))
      baseline: {
        npcDamage: Number(npc.system.damage) || 0,
        isExplosion: COUNT_AREAS("isExplosion"), isGasCloud: COUNT_AREAS("isGasCloud"),
        isSpreadZone: COUNT_AREAS("isSpreadZone"),
        missileTokens: scene.tokens.filter(t => t.flags?.["cp2020-augmented"]?.missile).length,
      },
    };
  }, COUNT_AREAS.toString());
  log.push(`setup: player=${S.playerName} pc=${S.pcId} npc=${S.npcId}`);
  log.push(`baseline: ${JSON.stringify(S.baseline)}`);

  // ---- Player joins ----
  const plCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const pl = await plCtx.newPage();
  await joinAs(pl, new RegExp(S.playerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), ["", GM_PW]);
  await pl.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});
  const who = await pl.evaluate((d) => ({ isGM: game.user.isGM, ownsPC: game.actors.get(d.pcId)?.isOwner }), S);
  log.push(`player: isGM=${who.isGM} ownsPC=${who.ownsPC}`);
  if (who.isGM || !who.ownsPC) throw new Error("player context is wrong (isGM or not PC owner)");

  // helper: player fires a weaponFired payload; GM polls a metric until it changes
  const fireWeapon = (payload) => pl.evaluate((p) => { Hooks.callAll("cyberpunk2020.weaponFired", p); }, payload);
  const pollGM = (fnStr, arg, target) => gm.evaluate(async ({ fnStr, arg, target }) => {
    const fn = eval("(" + fnStr + ")");
    for (let i = 0; i < 40; i++) { const v = fn(arg); if (v > target) return { v, ms: i * 200 }; await new Promise(r => setTimeout(r, 200)); }
    return { v: fn(arg), ms: 8000 };
  }, { fnStr, arg, target });

  // ===== A2: damage relay =====
  await fireWeapon({ attackerId: S.pcId, targetActorId: S.npcId, targetTokenId: S.npcTokenId,
                     areaDamages: { Torso: [{ damage: 20 }] }, weaponName: "PW Rifle" });
  {
    const r = await pollGM(`(id)=>Number(game.actors.get(id).system.damage)||0`, S.npcId, S.baseline.npcDamage);
    // Exact delta (a double-apply must fail): Torso hit 20, bare NPC (SP 0) → net = max(1, 20 − BTM), no doubling.
    const expected = S.baseline.npcDamage + Math.max(1, 20 - S.npcBtm);
    results.A2_damage = { pass: r.v === expected, detail: `npc damage ${S.baseline.npcDamage}→${r.v} (expected ${expected}, BTM ${S.npcBtm}) in ${r.ms}ms` };
  }

  // ===== A4a: explosion =====
  await fireWeapon({ attackerId: S.pcId, targetTokenId: S.npcTokenId, effectTypes: ["Explosive"],
                     areaDamages: { Torso: [{ damage: 15 }] }, blastRadius: 5, weaponName: "PW Grenade" });
  {
    const r = await pollGM(COUNT_AREAS.toString(), "isExplosion", S.baseline.isExplosion);
    results.A4a_explosion = { pass: r.v === S.baseline.isExplosion + 1, detail: `isExplosion areas ${S.baseline.isExplosion}→${r.v} (expected +1) in ${r.ms}ms` };
  }

  // ===== A4b: gas cloud (no areaDamages → only the cloud path runs) =====
  await fireWeapon({ attackerId: S.pcId, targetTokenId: S.npcTokenId, effectTypes: ["Gas"],
                     blastRadius: 4, dotTurns: 3, stunSaveMod: -2, weaponName: "PW Gas" });
  {
    const r = await pollGM(COUNT_AREAS.toString(), "isGasCloud", S.baseline.isGasCloud);
    results.A4b_gas = { pass: r.v === S.baseline.isGasCloud + 1, detail: `isGasCloud areas ${S.baseline.isGasCloud}→${r.v} (expected +1) in ${r.ms}ms` };
  }

  // ===== A4c: shotgun spread =====
  await fireWeapon({ attackerId: S.pcId, targetTokenId: S.npcTokenId, spreadMode: "wide",
                     spreadDamageMedium: "3d6", weaponName: "PW Shotgun" });
  {
    const r = await pollGM(COUNT_AREAS.toString(), "isSpreadZone", S.baseline.isSpreadZone);
    results.A4c_spread = { pass: r.v === S.baseline.isSpreadZone + 1, detail: `isSpreadZone areas ${S.baseline.isSpreadZone}→${r.v} (expected +1) in ${r.ms}ms` };
  }

  // ===== A5: guided missile launch (player imports the module fn and calls it) =====
  const launched = await pl.evaluate(async (d) => {
    const scene = game.scenes.active ?? canvas.scene;
    const shooterToken = scene.tokens.get(d.pcTokenId);
    const targetToken  = scene.tokens.get(d.npcTokenId);
    const mod = await import("/modules/cp2020-augmented/module/vehicle/vehicle-missile-flight.js");
    await mod.launchMissile({ scene, shooterToken, targetToken,
      missile: { guidance: "semiActive", homingMethod: "radar", penetration: 5, weaponName: "PW Missile" } });
    return true;
  }, S).catch(e => "ERR:" + e.message);
  log.push(`player launchMissile: ${launched}`);
  {
    const r = await pollGM(`()=>{const s=game.scenes.active??canvas.scene;return s.tokens.filter(t=>t.flags?.["cp2020-augmented"]?.missile).length;}`, null, S.baseline.missileTokens);
    results.A5_missile = { pass: r.v === S.baseline.missileTokens + 1, detail: `missile tokens ${S.baseline.missileTokens}→${r.v} (expected +1) in ${r.ms}ms` };
  }

  // ---- cleanup ----
  await gm.evaluate(async (mmPrev) => {
    const scene = game.scenes.active ?? canvas.scene;
    for (const t of scene.tokens.filter(t => t.name?.startsWith("__PW__") || t.flags?.["cp2020-augmented"]?.missile)) await t.delete().catch(()=>{});
    const F = (d)=> d.flags?.["cp2020-augmented"] ?? {};
    for (const coll of [scene.templates, scene.regions]) if (coll) for (const d of [...coll]) if (F(d).isExplosion||F(d).isGasCloud||F(d).isSpreadZone||F(d).isSuppressiveZone) await d.delete().catch(()=>{});
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__") || a.name === "Missile")) await a.delete().catch(()=>{});
    // Restore the captured mmEnabled setting (don't leave the world flag flipped for the next keeper).
    try { if (mmPrev !== undefined) await game.settings.set("cp2020-augmented", "mmEnabled", mmPrev); } catch (e) {}
  }, S.mmPrev).catch(() => {});
} catch (e) {
  log.push("ERROR: " + e.message);
} finally {
  await browser.close();
}

console.log("\n===== 2-CLIENT RELAY SUITE (:30004, official 1.1.1 + module) =====");
log.forEach(l => console.log("  • " + l));
console.log("");
let allPass = Object.keys(results).length > 0;
for (const [k, v] of Object.entries(results)) {
  console.log(`  ${v.pass ? "PASS ✅" : "FAIL ❌"}  ${k.padEnd(14)} — ${v.detail}`);
  if (!v.pass) allPass = false;
}
console.log("\n  OVERALL: " + (allPass ? "ALL PASS ✅" : "SOME FAILED ❌"));
process.exit(allPass ? 0 : 1);
