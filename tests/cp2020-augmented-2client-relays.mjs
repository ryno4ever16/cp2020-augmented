/**
 * 2-CLIENT player→GM socket-relay verification for cp2020-augmented on :30004 (official 1.1.1 + module).
 *
 * Covers the whole "non-GM can't use automation" group — each is masked by single-GM play because the GM
 * applies locally and never emits; only a PLAYER acting on a GM-owned target/scene hits the relay:
 *   A2  player fires a normal weapon at a GM-owned NPC        → GM opens the confirmation window,
 *                                                               and ITS apply writes the damage
 *   A4a player fires an Explosive round                       → GM places the blast area (isExplosion)
 *   A4b player fires a Gas round                              → GM places the cloud (a Region carrying
 *                                                               the Gas Cloud behavior on v14)
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

// In-page: count GAS CLOUDS, in the two shapes the production code actually spawns.
//
// ⭐ THE CONTRACT THIS TRACKS. On a core with Regions (`usesRegions()` — true on v14) a cloud is a
// native Region carrying the module's Gas Cloud BEHAVIOR, attached inline so the spawn stays atomic,
// and damage-hooks.js:1704-1725 DELIBERATELY writes no `isGasCloud` flag: the behavior owns the
// countdown, the penalty and the weapon name, and the GM manages the cloud with core's own region
// tools. The flag set is the v13 MeasuredTemplate branch only. Counting the flag alone therefore
// measured a v13-only path and read 0 forever on the v14 ship target. The same two-shape split the
// production code makes is made here — v14 behavior first, v13 flag as back-compat — and a legacy
// flagged REGION that also carries the behavior is counted once, not twice.
const COUNT_GAS_CLOUDS = () => {
  const scene = game.scenes.active ?? canvas.scene;
  const T = "cp2020-augmented.gasCloud";
  let n = 0;
  for (const r of scene.regions ?? []) {
    const native = !!r.behaviors?.some((b) => b.type === T);
    if (native || r.flags?.["cp2020-augmented"]?.isGasCloud) n++;
  }
  for (const d of scene.templates ?? []) if (d.flags?.["cp2020-augmented"]?.isGasCloud) n++;
  return n;
};

// The transient combat areas this suite creates, in BOTH shapes, so the pre-sweep and the teardown
// remove a behavior-carrying region as readily as a flagged one. (Cover and radiation zones are
// GM-placed and persistent — deliberately not swept here.)
const SWEEP_AREAS = async () => {
  const scene = game.scenes.active ?? canvas.scene;
  const TYPES = ["cp2020-augmented.gasCloud", "cp2020-augmented.suppressiveFire"];
  const F = (d) => d.flags?.["cp2020-augmented"] ?? {};
  const transient = (d) =>
    F(d).isExplosion || F(d).isGasCloud || F(d).isSpreadZone || F(d).isSuppressiveZone ||
    !!d.behaviors?.some((b) => TYPES.includes(b.type));
  for (const coll of [scene.templates, scene.regions]) {
    if (!coll) continue;
    for (const d of [...coll]) if (transient(d)) await d.delete().catch(() => {});
  }
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

  const S = await gm.evaluate(async ({ COUNT_AREAS_STR, COUNT_GAS_STR, SWEEP_STR }) => {
    const COUNT_AREAS = eval("(" + COUNT_AREAS_STR + ")");
    const COUNT_GAS_CLOUDS = eval("(" + COUNT_GAS_STR + ")");
    const SWEEP_AREAS = eval("(" + SWEEP_STR + ")");
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__") || a.name === "Missile")) await a.delete().catch(()=>{});
    const scene = game.scenes.active ?? canvas.scene;
    for (const t of scene.tokens.filter(t => t.name?.startsWith("__PW__") || t.flags?.["cp2020-augmented"]?.missile)) await t.delete().catch(()=>{});
    await SWEEP_AREAS();
    let mmPrev; try { mmPrev = game.settings.get("cp2020-augmented", "mmEnabled"); await game.settings.set("cp2020-augmented", "mmEnabled", true); } catch(e){}

    const player = game.users.find(u => u.role === 1);
    const npc = await Actor.create({ name: "__PW__NPC", type: "character" });
    const pc  = await Actor.create({ name: "__PW__PC",  type: "character" });
    await pc.update({ [`ownership.${player.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
    // ⚠ actorLink: TRUE, and it is load-bearing here. `TokenDocument.create` defaults it FALSE (the
    // documented harness gotcha), which gives the token its own synthetic delta actor. The relayed
    // apply is deliberately TOKEN-FIRST since the unlinked-token fix (damage-hooks.js:3335-3339: "a
    // hit on an unlinked token must write that token's synthetic actor"), so on an unlinked fixture
    // the damage lands on the delta and the world actor this leg reads never moves — the write was
    // happening correctly and the leg was looking at the wrong document. Unlinked deltas have their
    // own dedicated suite (cp2020-augmented-unlinked-token-damage); what THIS suite is about is the
    // player→GM relay, so its figures are linked and the world actor is the honest readback.
    const mk = (a, x) => ({ name: a.name, actorId: a.id, actorLink: true, x, y: 1000, width: 1, height: 1, disposition: 0 });
    const [pcTok]  = await scene.createEmbeddedDocuments("Token", [mk(pc, 1000)]);
    const [npcTok] = await scene.createEmbeddedDocuments("Token", [mk(npc, 1400)]);
    return {
      playerName: player.name, pcId: pc.id, npcId: npc.id, pcTokenId: pcTok.id, npcTokenId: npcTok.id,
      mmPrev,
      npcBtm: Number(npc.system.stats?.bt?.modifier) || 0,   // exact-delta derivation (Torso net = max(1, dmg−BTM))
      baseline: {
        npcDamage: Number(npc.system.damage) || 0,
        isExplosion: COUNT_AREAS("isExplosion"), isGasCloud: COUNT_GAS_CLOUDS(),
        isSpreadZone: COUNT_AREAS("isSpreadZone"),
        missileTokens: scene.tokens.filter(t => t.flags?.["cp2020-augmented"]?.missile).length,
      },
    };
  }, { COUNT_AREAS_STR: COUNT_AREAS.toString(), COUNT_GAS_STR: COUNT_GAS_CLOUDS.toString(), SWEEP_STR: SWEEP_AREAS.toString() });
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
  // ⭐ REALIGNED TWICE. First to the retirement of the world-wide auto-apply route (user ruling 2026-08-14;
  // certified in its own right by cp2020-augmented-autoapply-retired): what crosses the socket is never
  // "apply this damage" unattended. Then to THE SEAT RULE (user ruling 2026-10-22, c774a07,
  // combat/damage-receipt.js openDamageWindowAtSeat): the apply window opens at the TARGET's seat — the
  // figure's own connected player, else the referee's primary session — not on the client that fired.
  //
  //   the player fires at a GM-owned NPC → the firing client hands the window over the socket
  //   (`openDamageWindow`, no player seat on an NPC) → the REFEREE's window opens, writes nothing by
  //   itself → the referee presses Apply → the referee's client writes the target and posts the receipt.
  //
  // So the window is on the GM page, not the player's, and both halves are driven and asserted: the
  // window appears at the seat (and NOT on the firing client), nothing is written before it is answered,
  // and the GM ends up holding the exact value.
  await fireWeapon({ attackerId: S.pcId, targetActorId: S.npcId, targetTokenId: S.npcTokenId,
                     areaDamages: { Torso: [{ damage: 20 }] }, weaponName: "PW Rifle" });
  {
    const damageOnGM = () => gm.evaluate((id) => Number(game.actors.get(id)?.system?.damage) || 0, S.npcId);
    // Diagnostics that make a red here name its own cause instead of reading as "the relay is broken":
    // the hand-over is performed by the firing client's socket emit and answered by the PRIMARY GM session,
    // so what the player emitted, and which client holds that role, are the two facts needed.
    await pl.evaluate(() => {
      const g = globalThis.__relaySpy = { emits: [] };
      const orig = game.socket.emit.bind(game.socket);
      game.socket.emit = (ch, data, ...rest) => { try { g.emits.push({ ch, type: data?.type, mode: data?.mode, forUserId: data?.forUserId ?? null }); } catch (e) { /* opaque */ } return orig(ch, data, ...rest); };
    });
    const windowsOn = (page) => page.evaluate(() => [...foundry.applications.instances.values()]
      .filter(a => /DamageDialog/.test(a?.constructor?.name ?? "")).length);
    // The firing client waits out the FX rail's settle signal before handing the window over, so give it
    // real room (the rail's own cap is 8 s).
    const w = await gm.evaluate(async () => {
      const sleep = (ms) => new Promise(res => setTimeout(res, ms));
      const wins = () => [...foundry.applications.instances.values()]
        .filter(a => /DamageDialog/.test(a?.constructor?.name ?? ""));
      let ms = 0;
      for (let i = 0; i < 200 && wins().length === 0; i++) { await sleep(100); ms += 100; }
      return { opened: wins().length > 0, ms };
    });
    const onPlayer = await windowsOn(pl);   // the negative: the firing client holds no window for a figure it does not control
    const atWindow = await damageOnGM();    // the negative: nothing is written before the window is answered
    const applied = await gm.evaluate(async () => {
      const sleep = (ms) => new Promise(res => setTimeout(res, ms));
      const wins = () => [...foundry.applications.instances.values()]
        .filter(a => /DamageDialog/.test(a?.constructor?.name ?? ""));
      const win = wins()[0] ?? null;
      const ctl = win?.element?.querySelector('[data-action="applyDamage"]') ?? null;
      if (!ctl) { for (const x of wins()) { try { await x.close(); } catch (e) { /* closed */ } } return false; }
      ctl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 80 && wins().length > 0; i++) await sleep(100);
      return true;
    });
    let v = await damageOnGM();
    for (let i = 0; i < 40 && v === S.baseline.npcDamage; i++) { await new Promise(r => setTimeout(r, 250)); v = await damageOnGM(); }
    const spy = await pl.evaluate(() => (globalThis.__relaySpy?.emits ?? []).filter(e => e.type === "openDamageWindow" || e.type === "applyDamage"));
    const gmRole = await gm.evaluate(() => ({
      activeGM: game.users.activeGM?.name ?? null, me: game.user.name,
      iAmActive: game.users.activeGM?.id === game.user.id,
      activeUsers: game.users.filter(u => u.active).map(u => u.name),
    }));
    log.push(`A2 hand-over: player emitted ${JSON.stringify(spy)}`);
    log.push(`A2 seat role: ${JSON.stringify(gmRole)}`);
    // Exact delta (a double-apply must fail): Torso hit 20, bare NPC (SP 0) → net = max(1, 20 − BTM).
    const expected = S.baseline.npcDamage + Math.max(1, 20 - S.npcBtm);
    results.A2_window     = { pass: w.opened === true && onPlayer === 0 && applied === true,
      detail: `the window opened at the target's seat — the referee's client — in ${w.ms}ms, none on the firing client (${onPlayer}), and its Apply control was driven (opened=${w.opened}, applied=${applied})` };
    results.A2_noPreWrite = { pass: atWindow === S.baseline.npcDamage,
      detail: `nothing written before the window was answered — GM-side damage still ${atWindow} (baseline ${S.baseline.npcDamage})` };
    results.A2_damage     = { pass: v === expected,
      detail: `the referee's apply wrote npc damage ${S.baseline.npcDamage}→${v} (expected ${expected}, BTM ${S.npcBtm})` };
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
    const r = await pollGM(COUNT_GAS_CLOUDS.toString(), null, S.baseline.isGasCloud);
    results.A4b_gas = { pass: r.v === S.baseline.isGasCloud + 1, detail: `gas clouds (v14 behavior-carrying regions + v13 flagged templates) ${S.baseline.isGasCloud}→${r.v} (expected +1) in ${r.ms}ms` };
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
  await gm.evaluate(async ({ mmPrev, SWEEP_STR }) => {
    const SWEEP_AREAS = eval("(" + SWEEP_STR + ")");
    const scene = game.scenes.active ?? canvas.scene;
    for (const t of scene.tokens.filter(t => t.name?.startsWith("__PW__") || t.flags?.["cp2020-augmented"]?.missile)) await t.delete().catch(()=>{});
    await SWEEP_AREAS();   // behavior-carrying regions included — a flag-only sweep leaves the v14 cloud behind
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__") || a.name === "Missile")) await a.delete().catch(()=>{});
    // Restore the captured mmEnabled setting (don't leave the world flag flipped for the next keeper).
    try { if (mmPrev !== undefined) await game.settings.set("cp2020-augmented", "mmEnabled", mmPrev); } catch (e) {}
  }, { mmPrev: S.mmPrev, SWEEP_STR: SWEEP_AREAS.toString() }).catch(() => {});
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
