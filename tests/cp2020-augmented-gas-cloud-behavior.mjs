/** Gas Cloud as a native Region Behavior (module/combat/gas-cloud-behavior.js + the region-aware tick in
 *  module/combat/damage-hooks.js). The second zone type on the native-region rail (mirrors the radiation
 *  unit). On :30004 (v14) and :30003 (v13):
 *   - the custom behavior TYPE registers (two-part: module.json documentTypes + init CONFIG) and a
 *     RegionBehavior of that type can be created on a Region;
 *   - SPAWN: a Gas weaponFired, fired as the active GM against a target token, drops a cloud — on v14 a
 *     Region carrying the behavior with the payload's values and GAMEMASTER visibility (and NO legacy
 *     isGasCloud flag, the behavior owns the data); on v13 a MeasuredTemplate with the legacy flags;
 *   - TICK: a token inside a behavior region is adjudicated by the per-round tick (its save-penalty state is
 *     written and the cloud card names it) and the behavior's turnsLeft decrements; a token OUTSIDE, or in a
 *     region WITHOUT the behavior, is untouched;
 *   - EXPIRY: a behavior cloud reaching turnsLeft 0 deletes the region and posts the dispersal card;
 *   - LEGACY: a flag-only cloud still ticks, and a region carrying BOTH the flag and the behavior is
 *     adjudicated exactly ONCE (the skip guard);
 *   - DRIFT: with gasCloudAutoMove on, a behavior region's shape moves on tick.
 *  The tick is driven for real by advancing a combat round (the updateCombat per-turn hook runs
 *  _runGasCloudTick on the active GM), the mech-protection gas e2e idiom. Needs the module SYNCED to the rig
 *  AND the rig Foundry server RESTARTED (module.json changed → the RegionBehavior type is only valid after a
 *  server reload). All fixtures self-clean; the toggled setting is restored. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l))||us[0];await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = { checks: [], fails: [] };
  const check = (n, ok, got) => { out.checks.push(`${ok?"  PASS":"  FAIL"}  ${n}${ok?"":"  got="+JSON.stringify(got)}`); if(!ok) out.fails.push(n); };
  const SCOPE = "cp2020-augmented";
  const T = "cp2020-augmented.gasCloud";
  const GM_VIS = CONST?.REGION_VISIBILITY?.GAMEMASTER ?? 1;
  const BE = await import("/modules/cp2020-augmented/module/combat/gas-cloud-behavior.js");
  const AS = await import("/modules/cp2020-augmented/module/combat/area-shapes.js");
  const useRegions = AS.usesRegions();

  const madeRegions = [], madeTemplates = [], madeActors = [];
  let combat = null, prevAutoMove = null, autoMoveTouched = false;

  try {
    // Ensure an active, drawn canvas (spawn needs a real token placeable; region.tokens needs the layer).
    let scene = canvas?.scene ?? game.scenes.viewed ?? game.scenes.active ?? game.scenes.contents[0];
    if (scene && game.scenes.active?.id !== scene.id) { try { await scene.activate(); } catch { /* client-only */ } }
    for (let i = 0; i < 30 && !canvas?.ready; i++) await sleep(200);
    scene = canvas?.scene ?? scene;
    if (!scene) { check("active scene present", false, null); return out; }
    check("active scene present", !!scene, null);

    // Pre-clean leftover gas fixtures from any crashed prior run so the tick only ever sees THIS run's
    // clouds (a stray isGasCloud region would be double-counted and inflate the tick, racing the poll).
    for (const c of [...game.combats].filter(c => c.combatants?.some(cb => cb.actor?.name?.startsWith("__PW__")))) await c.delete().catch(() => {});
    const staleRegs = (scene.regions ?? []).filter(d => d.flags?.[SCOPE]?.isGasCloud || d.behaviors?.some(bb => bb.type === T));
    for (const d of staleRegs) await scene.deleteEmbeddedDocuments("Region", [d.id]).catch(() => {});
    const staleTmpl = (scene.templates ?? []).filter(d => d.flags?.[SCOPE]?.isGasCloud);
    for (const d of staleTmpl) await scene.deleteEmbeddedDocuments("MeasuredTemplate", [d.id]).catch(() => {});
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__Gas"))) await a.delete().catch(() => {});

    const gs = scene.grid?.size ?? 100;
    const rect = (box) => ({ type: "rectangle", x: box.x, y: box.y, width: box.w, height: box.h, hole: false, rotation: 0 });
    const centerTok = (box) => ({ x: box.x + box.w / 2 - gs / 2, y: box.y + box.h / 2 - gs / 2 });
    const taser = (a) => foundry.utils.deepClone(a.getFlag(SCOPE, "taserState") ?? null);

    // A behavior region built the REAL GM way: draw the region, THEN add the behavior (so the
    // createRegionBehavior hook fires and the visibility auto-bump is exercised). Optionally also stamp the
    // legacy isGasCloud flag (the skip-guard case).
    const makeBehaviorRegion = async ({ box, turnsLeft = 3, stunSaveMod = -2, weaponName = "__PW__Gas", alsoFlag = false }) => {
      const data = { name: "__PW__GasRegion", shapes: [rect(box)], behaviors: [] };
      if (alsoFlag) data.flags = { [SCOPE]: { isGasCloud: true, turnsLeft, stunSaveMod, weaponName } };
      const [reg] = await scene.createEmbeddedDocuments("Region", [data]);
      madeRegions.push(reg.id);
      await reg.createEmbeddedDocuments("RegionBehavior", [{ name: "Gas Cloud", type: T, system: { turnsLeft, stunSaveMod, weaponName } }]);
      return reg;
    };
    const behaviorOf = (reg) => reg.behaviors?.find(b => b.type === T);
    const mkActorTokenInside = async (name, box) => {
      const a = await Actor.create({ name, type: "character" }); madeActors.push(a.id);
      const c = centerTok(box);
      const [tok] = await scene.createEmbeddedDocuments("Token", [{ name, actorId: a.id, actorLink: true, x: c.x, y: c.y, width: 1, height: 1 }]);
      return { a, tok };
    };

    // ── (a) Registration (two-part manifest+CONFIG + server restart) ──
    check("behavior TYPE registered in CONFIG.RegionBehavior.dataModels", typeof CONFIG.RegionBehavior?.dataModels?.[T] === "function", typeof CONFIG.RegionBehavior?.dataModels?.[T]);
    check("gasCloudBehaviorClass() resolves", typeof BE.gasCloudBehaviorClass() === "function", null);
    check("GAS_CLOUD_BEHAVIOR const", BE.GAS_CLOUD_BEHAVIOR === T, BE.GAS_CLOUD_BEHAVIOR);

    // ── (b) SPAWN via the real weaponFired pipeline (active GM places directly) ──
    const spawnActor = await Actor.create({ name: "__PW__GasFirer", type: "character" }); madeActors.push(spawnActor.id);
    const [spawnTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__GasFirer", actorId: spawnActor.id, actorLink: true, x: 8000, y: 8000, width: 1, height: 1 }]);
    for (let i = 0; i < 25 && !canvas?.tokens?.get(spawnTok.id); i++) await sleep(150);
    const regBefore = new Set((scene.regions ?? []).map(x => x.id));
    const tmplBefore = new Set((scene.templates ?? []).map(x => x.id));
    const SPAWN_WEAPON = "__PW__SpawnGas";
    Hooks.callAll("cyberpunk2020.weaponFired", {
      attackerId: spawnActor.id, targetTokenId: spawnTok.id, effectTypes: ["Gas"],
      blastRadius: 4, dotTurns: 3, stunSaveMod: -2, weaponName: SPAWN_WEAPON,
    });

    if (useRegions) {
      let spawnReg = null;
      for (let i = 0; i < 40 && !spawnReg; i++) { spawnReg = (scene.regions ?? []).find(x => !regBefore.has(x.id) && x.behaviors?.some(bb => bb.type === T)); if (!spawnReg) await sleep(200); }
      if (spawnReg) madeRegions.push(spawnReg.id);
      check("SPAWN (v14): a Region carrying the gasCloud behavior appeared", !!spawnReg, null);
      const sb = spawnReg ? behaviorOf(spawnReg) : null;
      check("SPAWN (v14): behavior carries the payload values", !!sb && Number(sb.system.turnsLeft) === 3 && Number(sb.system.stunSaveMod) === -2 && sb.system.weaponName === SPAWN_WEAPON, sb?.system);
      check("SPAWN (v14): region visibility is GAMEMASTER", spawnReg?.visibility === GM_VIS, spawnReg?.visibility);
      check("SPAWN (v14): NO legacy isGasCloud flag (behavior owns the data)", !spawnReg?.flags?.[SCOPE]?.isGasCloud, spawnReg?.flags?.[SCOPE]);
      // clean the spawn cloud before the tick fixtures so it isn't adjudicated with them
      if (spawnReg) { await scene.deleteEmbeddedDocuments("Region", [spawnReg.id]).catch(() => {}); }
    } else {
      let spawnTmpl = null;
      for (let i = 0; i < 40 && !spawnTmpl; i++) { spawnTmpl = (scene.templates ?? []).find(x => !tmplBefore.has(x.id) && x.flags?.[SCOPE]?.isGasCloud); if (!spawnTmpl) await sleep(200); }
      if (spawnTmpl) madeTemplates.push(spawnTmpl.id);
      check("SPAWN (v13): a MeasuredTemplate with the legacy gas flags appeared", !!spawnTmpl, null);
      const f = spawnTmpl?.flags?.[SCOPE];
      check("SPAWN (v13): flags carry the payload values", !!f && Number(f.turnsLeft) === 3 && Number(f.stunSaveMod) === -2 && f.weaponName === SPAWN_WEAPON, f);
      if (spawnTmpl) { await scene.deleteEmbeddedDocuments("MeasuredTemplate", [spawnTmpl.id]).catch(() => {}); }
    }

    // ── Tick fixtures (boxes spaced apart so no token sits in two clouds; ALL fully on-scene) ──
    const BX_BEH  = { x: 200,  y: 200,  w: 6 * gs, h: 6 * gs };  // behavior cloud + inside token (200-800)
    const BX_EXP  = { x: 1000, y: 200,  w: 4 * gs, h: 4 * gs };  // behavior cloud, turnsLeft 1 → expiry
    const BX_BOTH = { x: 200,  y: 1000, w: 6 * gs, h: 6 * gs };  // behavior + flag → skip-guard (once)
    const BX_DRIFT= { x: 1000, y: 1000, w: 4 * gs, h: 4 * gs };  // behavior cloud, drift
    const BX_PLAIN= { x: 2600, y: 200,  w: 4 * gs, h: 4 * gs };  // NO behavior, own box (negative)
    const legacyCenter = { x: 2000, y: 900 };   // legacy flag circle (r 3m → 1700-2300 x, 600-1200 y)
    const outsidePt = { x: 3400, y: 1600 };      // token in NO cloud (negative)

    // Behavior cloud with an inside token.
    const regBeh = await makeBehaviorRegion({ box: BX_BEH, turnsLeft: 3, stunSaveMod: -2, weaponName: "__PW__BehGas" });
    // Visibility auto-bump on the hand-authored (region-then-behavior) gesture.
    for (let i = 0; i < 20 && regBeh.visibility !== GM_VIS; i++) await sleep(150);
    check("hand-authored behavior region auto-set to GAMEMASTER visibility", regBeh.visibility === GM_VIS, regBeh.visibility);
    const { a: aBeh } = await mkActorTokenInside("__PW__GasBeh", BX_BEH);
    for (let i = 0; i < 25 && !(regBeh.tokens?.size); i++) await sleep(150);
    check("region.tokens reports the inside token", (regBeh.tokens?.size ?? 0) >= 1, regBeh.tokens?.size);

    // Behavior cloud about to expire (turnsLeft 1), no token needed.
    const regExp = await makeBehaviorRegion({ box: BX_EXP, turnsLeft: 1, stunSaveMod: -2, weaponName: "__PW__ExpireGas" });

    // Behavior + legacy flag on the same region (skip-guard): its token must be adjudicated exactly once.
    const regBoth = await makeBehaviorRegion({ box: BX_BOTH, turnsLeft: 3, stunSaveMod: -2, weaponName: "__PW__BothGas", alsoFlag: true });
    const { a: aBoth } = await mkActorTokenInside("__PW__GasBoth", BX_BOTH);
    for (let i = 0; i < 25 && !(regBoth.tokens?.size); i++) await sleep(150);

    // Drift cloud (long-lived), no token.
    const regDrift = await makeBehaviorRegion({ box: BX_DRIFT, turnsLeft: 9, stunSaveMod: 0, weaponName: "__PW__DriftGas" });

    // Plain region WITHOUT the behavior, own far box, inside token (negative).
    const [plainReg] = await scene.createEmbeddedDocuments("Region", [{ name: "__PW__PlainRegion", shapes: [rect(BX_PLAIN)] }]);
    madeRegions.push(plainReg.id);
    const { a: aPlain } = await mkActorTokenInside("__PW__GasPlain", BX_PLAIN);
    for (let i = 0; i < 20 && !(plainReg.tokens?.size); i++) await sleep(150);

    // Legacy flag-only cloud via the module's own createArea (backend-correct per core), inside token.
    const legacyHandle = await AS.createArea(scene, {
      kind: "circle", x: legacyCenter.x, y: legacyCenter.y, radiusM: 3,
      color: "#88ff44", borderColor: "#44aa22",
      flags: { isGasCloud: true, turnsLeft: 3, stunSaveMod: -2, weaponName: "__PW__LegacyGas" },
    });
    if (legacyHandle?.doc) { (legacyHandle.isRegion ? madeRegions : madeTemplates).push(legacyHandle.doc.id); }
    const aLegacy = await Actor.create({ name: "__PW__GasLegacy", type: "character" }); madeActors.push(aLegacy.id);
    await scene.createEmbeddedDocuments("Token", [{ name: "__PW__GasLegacy", actorId: aLegacy.id, actorLink: true, x: legacyCenter.x - gs / 2, y: legacyCenter.y - gs / 2, width: 1, height: 1 }]);

    // Token in NO cloud (negative).
    const aOut = await Actor.create({ name: "__PW__GasOutside", type: "character" }); madeActors.push(aOut.id);
    const [tokOut] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__GasOutside", actorId: aOut.id, actorLink: true, x: outsidePt.x, y: outsidePt.y, width: 1, height: 1 }]);

    await sleep(400);

    // ── Drive TICK #1 (autoMove OFF): a real round advance runs _runGasCloudTick on the active GM ──
    combat = await Combat.create({ scene: scene.id, active: true });
    await combat.createEmbeddedDocuments("Combatant", [{ tokenId: tokOut.id, actorId: aOut.id }]);
    await combat.startCombat();
    const msgBefore = new Set(game.messages.contents.map(m => m.id));
    await combat.update({ round: 2, turn: 0 });
    // Terminal signal: wait for BOTH the behavior cloud (path 1) AND the legacy cloud (path 2, which runs
    // after all of path 1) to land 3→2 — the legacy decrement is the last major event of the tick.
    const legId = legacyHandle?.doc?.id;
    const legTurns = () => Number((useRegions ? scene.regions.get(legId) : scene.templates.get(legId))?.flags?.[SCOPE]?.turnsLeft);
    for (let i = 0; i < 60 && !(Number(behaviorOf(regBeh)?.system?.turnsLeft) === 2 && legTurns() === 2); i++) await sleep(200);
    await sleep(600);
    const newMsgs = game.messages.contents.filter(m => !msgBefore.has(m.id)).map(m => m.content).join("\n");

    // (c) TICK positive: behavior cloud adjudicated + decremented.
    check("TICK: behavior cloud turnsLeft decremented 3→2", Number(behaviorOf(regBeh)?.system?.turnsLeft) === 2, behaviorOf(regBeh)?.system?.turnsLeft);
    check("TICK: inside token got the −2 save-penalty state", taser(aBeh)?.mod === -2, taser(aBeh));
    check("TICK: cloud card names the weapon + the affected token", /__PW__BehGas/.test(newMsgs) && /__PW__GasBeh/.test(newMsgs), null);

    // (d) TICK negatives.
    check("NEGATIVE: token in NO cloud is untouched (no penalty state)", taser(aOut) === null, taser(aOut));
    check("NEGATIVE: token in a region WITHOUT the behavior is untouched", taser(aPlain) === null, taser(aPlain));

    // (e) EXPIRY: the turnsLeft-1 cloud deleted + dispersal card.
    check("EXPIRY: behavior cloud at turnsLeft 0 deleted its region", !scene.regions.get(regExp.id), null);
    check("EXPIRY: dispersal card posted for the expired cloud", /dispersed/i.test(newMsgs) && /__PW__ExpireGas/.test(newMsgs), null);

    // (f) LEGACY: flag-only cloud still ticks; both-flag-and-behavior region adjudicated ONCE.
    const legacyDoc = legacyHandle?.doc ? (useRegions ? scene.regions.get(legacyHandle.doc.id) : scene.templates.get(legacyHandle.doc.id)) : null;
    check("LEGACY: flag-only cloud ticked (turnsLeft 3→2) + dosed its token", Number(legacyDoc?.flags?.[SCOPE]?.turnsLeft) === 2 && taser(aLegacy)?.mod === -2, { turnsLeft: legacyDoc?.flags?.[SCOPE]?.turnsLeft, taser: taser(aLegacy) });
    check("SKIP-GUARD: flag+behavior region adjudicated exactly ONCE (taser count 1)", taser(aBoth)?.mod === -2 && taser(aBoth)?.count === 1, taser(aBoth));

    // ── (g) DRIFT: toggle autoMove ON, advance another round, assert the region shape moved ──
    prevAutoMove = game.settings.get(SCOPE, "gasCloudAutoMove"); autoMoveTouched = true;
    await game.settings.set(SCOPE, "gasCloudAutoMove", true);
    const driftBefore = (() => { const s = scene.regions.get(regDrift.id)?.shapes?.[0]; return s ? { x: s.x, y: s.y } : null; })();
    const driftTurnsBefore = Number(behaviorOf(scene.regions.get(regDrift.id))?.system?.turnsLeft);
    await combat.update({ round: 3, turn: 0 });
    for (let i = 0; i < 45 && Number(behaviorOf(scene.regions.get(regDrift.id))?.system?.turnsLeft) === driftTurnsBefore; i++) await sleep(200);
    await sleep(400);
    const driftAfter = (() => { const s = scene.regions.get(regDrift.id)?.shapes?.[0]; return s ? { x: s.x, y: s.y } : null; })();
    check("DRIFT: behavior region shape moved on tick with gasCloudAutoMove on", !!driftBefore && !!driftAfter && (driftBefore.x !== driftAfter.x || driftBefore.y !== driftAfter.y), { driftBefore, driftAfter });
  } catch (e) {
    check("no exception during the run", false, String(e?.stack ?? e?.message ?? e));
  } finally {
    try { if (autoMoveTouched) await game.settings.set(SCOPE, "gasCloudAutoMove", prevAutoMove); } catch { /* ignore */ }
    if (combat) await combat.delete().catch(() => {});
    const sc = canvas?.scene;
    if (sc) {
      // Delete PER-ID (not batched): a batch containing an already-deleted id — the expiry region, the
      // spawn region removed inline — makes Foundry reject the whole delete, leaking every other region.
      for (const id of [...new Set(madeRegions)]) await sc.deleteEmbeddedDocuments("Region", [id]).catch(() => {});
      for (const id of [...new Set(madeTemplates)]) await sc.deleteEmbeddedDocuments("MeasuredTemplate", [id]).catch(() => {});
    }
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__Gas"))) await a.delete().catch(() => {});
  }
  return out;
});

for (const line of r.checks) console.log(line);
const errOk = errors.length === 0;
console.log(`${errOk?"  PASS":"  FAIL"}  0 console errors${errOk?"":"  got="+JSON.stringify(errors.slice(0,6))}`);
const failed = r.fails.length + (errOk ? 0 : 1);
console.log(`\n${r.checks.length + 1} checks, ${failed} failed`);
await b.close();
process.exit(failed ? 1 : 0);
