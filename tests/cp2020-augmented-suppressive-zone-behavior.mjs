/** Suppressive Fire as a native, EVENT-driven Region Behavior (module/combat/suppressive-zone-behavior.js +
 *  the placement-forward pipeline in module/combat/damage-hooks.js + the preview in
 *  module/combat/suppressive-placement.js). The third zone type on the native-region rail, and the FIRST
 *  that fires on native token-enter events rather than the round tick. On :30004 (v14) and :30003 (v13) —
 *  regions on BOTH cores for this feature:
 *   (a) the behavior TYPE registers (two-part: module.json documentTypes + init CONFIG) and the const matches;
 *   (b) PLANT: placeSuppressiveZoneFromGeometry(geo) creates a Region carrying the behavior (values match),
 *       ALWAYS visibility, and a suppressiveLocked flag;
 *   (c) ENTER-AT-CREATE: a token standing in the footprint BEFORE the plant is prompted to evade (the
 *       behavior-inline-creation-fires-enter path); the shooter's own token is NOT prompted;
 *   (d) ENTER-BY-CREATE: a token created inside a planted lane is prompted;
 *   (e) EVASION: _executeSuppressionEvasion posts an EVADED result on a beatable DC and re-emits weaponFired
 *       with 1d6 random hits on an unbeatable DC;
 *   (f) EXPIRY: a round advance deletes a shooter-owned lane laid on an earlier round; a blank-shooter lane
 *       (permanent kill lane) SURVIVES;
 *   (g) UNLOCK: _unlockSuppressiveZone clears the lock flag; a re-confirm UPDATE writes new shape + saveDC and
 *       re-locks;
 *   (h) PREVIEW GESTURE: arm the preview, dispatch real pointermove/wheel/keydown, assert the DOM readout is
 *       localized (no raw key) with correct DC math after a wheel step, and ESC removes it.
 *  Needs the module SYNCED to the rig AND the rig Foundry server RESTARTED (module.json changed → the
 *  RegionBehavior type is only valid after a server reload). All fixtures self-clean; the toggled setting is
 *  restored. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l))||us[0];await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
// Known Foundry CORE bug (v13/v14), NOT ours: CombatTracker._onRender does `data = renderData.find(...)`
// with no `?? {}` guard, so `"turn" in data` throws when a keeper drives combat.update({round}) on a combat
// that momentarily isn't the tracker's viewed one. Grep-proven absent from the module; filtered here so it
// doesn't phantom-fail the 0-console-errors gate on the (f) EXPIRY round advance (see test-harness.md).
const CORE_TURN_BUG = /Cannot use 'in' operator to search for 'turn' in undefined/;
p.on("pageerror", e => { if (!CORE_TURN_BUG.test(e.message)) errors.push("pageerror: " + e.message); });
p.on("console", m => { if (m.type() === "error" && !CORE_TURN_BUG.test(m.text())) errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = { checks: [], fails: [] };
  const check = (n, ok, got) => { out.checks.push(`${ok?"  PASS":"  FAIL"}  ${n}${ok?"":"  got="+JSON.stringify(got)}`); if(!ok) out.fails.push(n); };
  const SCOPE = "cp2020-augmented";
  const T = "cp2020-augmented.suppressiveFire";
  const ALWAYS = CONST?.REGION_VISIBILITY?.ALWAYS ?? 2;
  const BE = await import("/modules/cp2020-augmented/module/combat/suppressive-zone-behavior.js");
  const DH = await import("/modules/cp2020-augmented/module/combat/damage-hooks.js");
  const PV = await import("/modules/cp2020-augmented/module/combat/suppressive-placement.js");

  const madeRegions = [], madeActors = [];
  let combat = null, prevSetting = null, settingTouched = false, otherScene = null;

  const trackReg = (reg) => { if (reg?.id) madeRegions.push(reg.id); return reg; };
  const newMessagesSince = (before) => game.messages.contents.filter(m => !before.has(m.id)).map(m => m.content).join("\n");

  try {
    // Active, drawn canvas (enter events + region.tokens need the layer; the preview needs a real stage).
    let scene = canvas?.scene ?? game.scenes.viewed ?? game.scenes.active ?? game.scenes.contents[0];
    if (scene && game.scenes.active?.id !== scene.id) { try { await scene.activate(); } catch { /* client-only */ } }
    for (let i = 0; i < 30 && !canvas?.ready; i++) await sleep(200);
    scene = canvas?.scene ?? scene;
    if (!scene) { check("active scene present", false, null); return out; }
    check("active scene present", !!scene, null);

    // Pre-clean stray suppressive fixtures from any crashed prior run.
    for (const d of (scene.regions ?? []).filter(d => d.behaviors?.some(bb => bb.type === T))) await scene.deleteEmbeddedDocuments("Region", [d.id]).catch(() => {});
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__Supp"))) await a.delete().catch(() => {});
    for (const c of [...game.combats].filter(c => c.combatants?.some(cb => cb.actor?.name?.startsWith("__PW__Supp")))) await c.delete().catch(() => {});

    // Feature gate ON for the whole run.
    prevSetting = game.settings.get(SCOPE, "suppressiveFireSaves"); settingTouched = true;
    await game.settings.set(SCOPE, "suppressiveFireSaves", true);

    const gs = scene.grid?.size ?? 100;
    const behaviorOf = (reg) => reg?.behaviors?.find(bb => bb.type === T);
    const mkActor = async (name) => { const a = await Actor.create({ name, type: "character" }); madeActors.push(a.id); return a; };
    const mkTokenAt = async (name, actor, cx, cy) => {
      const [tok] = await scene.createEmbeddedDocuments("Token", [{ name, actorId: actor.id, actorLink: true, x: cx - gs / 2, y: cy - gs / 2, width: 1, height: 1 }]);
      for (let i = 0; i < 25 && !canvas?.tokens?.get(tok.id); i++) await sleep(120);
      return tok;
    };

    // A lane geometry payload as the shooter's confirmed preview would relay it. lengthPx/widthPx are
    // pixels; the lane runs EAST from origin over x∈[ox, ox+len], y∈[oy-halfW, oy+halfW].
    const laneGeo = (over = {}) => ({
      origin: { x: 500, y: 500 }, angleDeg: 0, widthM: 5,
      lengthPx: 900, widthPx: 400, weaponRange: 45, roundsFired: 10,
      saveDC: 2, dmgFormula: "3d6", weaponName: "__PW__SuppGun",
      actorId: "", attackerTokenId: "", userId: game.user.id, regionId: null, ...over,
    });

    // ── (a) Registration ──
    check("behavior TYPE registered in CONFIG.RegionBehavior.dataModels", typeof CONFIG.RegionBehavior?.dataModels?.[T] === "function", typeof CONFIG.RegionBehavior?.dataModels?.[T]);
    check("suppressiveZoneBehaviorClass() resolves", typeof BE.suppressiveZoneBehaviorClass() === "function", null);
    check("SUPPRESSIVE_ZONE_BEHAVIOR const matches", BE.SUPPRESSIVE_ZONE_BEHAVIOR === T, BE.SUPPRESSIVE_ZONE_BEHAVIOR);

    // ── shooter (attacker) + victim tokens placed INSIDE the future lane BEFORE the plant (enter-at-create) ──
    const shooter = await mkActor("__PW__SuppShooter");
    const victim1 = await mkActor("__PW__SuppVictim1");
    const atkTok = await mkTokenAt("__PW__SuppShooter", shooter, 800, 500);   // inside, but is the attacker
    const v1Tok  = await mkTokenAt("__PW__SuppVictim1", victim1, 700, 500);   // inside, a bystander
    await sleep(300);

    const msgBeforePlant = new Set(game.messages.contents.map(m => m.id));

    // ── (b) PLANT (region carries the behavior; attackerId = the shooter) ──
    const region = trackReg(await DH.placeSuppressiveZoneFromGeometry(laneGeo({ actorId: shooter.id, attackerTokenId: atkTok.id })));
    check("PLANT: a Region carrying the suppressiveFire behavior appeared", !!region && !!behaviorOf(region), region?.id);
    const sb = region ? behaviorOf(region) : null;
    check("PLANT: behavior carries the payload values", !!sb && Number(sb.system.saveDC) === 2 && sb.system.dmgFormula === "3d6" && sb.system.attackerId === shooter.id && sb.system.weaponName === "__PW__SuppGun", sb?.system);
    check("PLANT: region visibility is ALWAYS", region?.visibility === ALWAYS, region?.visibility);
    check("PLANT: suppressiveLocked flag set", region?.flags?.[SCOPE]?.suppressiveLocked === true, region?.flags?.[SCOPE]);

    // ── (c) ENTER-AT-CREATE: the bystander who was already standing in the footprint is prompted; the shooter is NOT ──
    let entered = "";
    for (let i = 0; i < 40; i++) { entered = newMessagesSince(msgBeforePlant); if (/__PW__SuppVictim1/.test(entered) && /Evasion/i.test(entered)) break; await sleep(200); }
    check("ENTER-AT-CREATE: bystander already in the lane got an evasion prompt", /__PW__SuppVictim1/.test(entered) && /Evasion/i.test(entered), entered.slice(0, 200));
    check("ENTER-AT-CREATE: the shooter's own token was NOT prompted", !/__PW__SuppShooter.*Evasion|Evasion.*__PW__SuppShooter/.test(entered), entered.slice(0, 200));

    // ── (d) ENTER-BY-CREATE: a token created inside the planted lane is prompted ──
    const victim2 = await mkActor("__PW__SuppVictim2");
    const msgBeforeV2 = new Set(game.messages.contents.map(m => m.id));
    await mkTokenAt("__PW__SuppVictim2", victim2, 900, 500);   // inside the planted lane
    let enteredV2 = "";
    for (let i = 0; i < 40; i++) { enteredV2 = newMessagesSince(msgBeforeV2); if (/__PW__SuppVictim2/.test(enteredV2) && /Evasion/i.test(enteredV2)) break; await sleep(200); }
    check("ENTER-BY-CREATE: token created inside the lane got an evasion prompt", /__PW__SuppVictim2/.test(enteredV2) && /Evasion/i.test(enteredV2), enteredV2.slice(0, 200));

    // ── (e) EVASION: beatable DC → EVADED card, no weaponFired; unbeatable DC → weaponFired with 1d6 hits ──
    const evader = await mkActor("__PW__SuppEvader");
    const evTok = await mkTokenAt("__PW__SuppEvader", evader, 3000, 3000);   // off the lane
    const msgBeforeEvade = new Set(game.messages.contents.map(m => m.id));
    await DH._executeSuppressionEvasion({ actorId: evader.id, tokenId: evTok.id, sceneId: scene.id, saveDC: 0, dmgFormula: "3d6", attackerId: shooter.id });
    let evadeMsgs = ""; for (let i = 0; i < 20; i++) { evadeMsgs = newMessagesSince(msgBeforeEvade); if (/EVADED/i.test(evadeMsgs)) break; await sleep(150); }
    check("EVASION success: beatable DC posts an EVADED result card", /EVADED/i.test(evadeMsgs), evadeMsgs.slice(0, 160));

    let fired = null; const firedHook = Hooks.on("cyberpunk2020.weaponFired", (pl) => { if (!fired) fired = pl; });
    await DH._executeSuppressionEvasion({ actorId: evader.id, tokenId: evTok.id, sceneId: scene.id, saveDC: 999, dmgFormula: "3d6", attackerId: shooter.id });
    for (let i = 0; i < 25 && !fired; i++) await sleep(150);
    Hooks.off("cyberpunk2020.weaponFired", firedHook);
    const hitEntries = fired ? Object.values(fired.areaDamages ?? {}).flat() : [];
    const hitCount = hitEntries.length;
    check("EVASION failure: re-emits weaponFired with 1..6 random hits, all positive damage", !!fired && hitCount >= 1 && hitCount <= 6 && hitEntries.every(h => Number(h.damage) > 0), { hitCount, sample: hitEntries[0] });

    // ── (f) EXPIRY: round advance deletes a shooter-owned lane; a blank-shooter lane survives ──
    combat = await Combat.create({ scene: scene.id, active: true });
    await combat.createEmbeddedDocuments("Combatant", [{ tokenId: evTok.id, actorId: evader.id }]);
    await combat.startCombat();   // round 1
    const shooterLane = trackReg(await DH.placeSuppressiveZoneFromGeometry(laneGeo({ origin: { x: 4000, y: 4000 }, actorId: shooter.id, attackerTokenId: atkTok.id })));
    const permaLane   = trackReg(await DH.placeSuppressiveZoneFromGeometry(laneGeo({ origin: { x: 5200, y: 4000 }, actorId: "" })));   // blank shooter = permanent
    check("EXPIRY setup: both lanes planted at round 1", !!scene.regions.get(shooterLane.id) && !!scene.regions.get(permaLane.id), null);
    await combat.update({ round: 2, turn: 0 });
    for (let i = 0; i < 40 && scene.regions.get(shooterLane.id); i++) await sleep(200);
    check("EXPIRY: shooter-owned lane deleted when the round advanced past it", !scene.regions.get(shooterLane.id), null);
    check("EXPIRY: blank-shooter (permanent) lane SURVIVED the round advance", !!scene.regions.get(permaLane.id), null);

    // ── (g) UNLOCK: clears the lock flag; a re-confirm UPDATE rewrites shape + saveDC and re-locks ──
    const unlockLane = trackReg(await DH.placeSuppressiveZoneFromGeometry(laneGeo({ origin: { x: 6400, y: 4000 }, actorId: shooter.id, attackerTokenId: atkTok.id })));
    const shapeBefore = JSON.stringify(unlockLane.shapes?.[0]?.points ?? []);
    await DH._unlockSuppressiveZone(unlockLane.id);
    PV.cancelSuppressivePreview();   // the unlock re-arms our own preview (userId = this GM); dismiss it
    check("UNLOCK: suppressiveLocked flag cleared", scene.regions.get(unlockLane.id)?.flags?.[SCOPE]?.suppressiveLocked === false, scene.regions.get(unlockLane.id)?.flags?.[SCOPE]);
    // Re-confirm with a wider lane + different angle → UPDATE the same region.
    await DH.placeSuppressiveZoneFromGeometry(laneGeo({ origin: { x: 6400, y: 4000 }, actorId: shooter.id, attackerTokenId: atkTok.id, regionId: unlockLane.id, angleDeg: 45, widthPx: 600, widthM: 8, saveDC: 2 }));
    const updated = scene.regions.get(unlockLane.id);
    const shapeAfter = JSON.stringify(updated?.shapes?.[0]?.points ?? []);
    check("UNLOCK re-confirm: same region UPDATED with a new shape", shapeBefore !== shapeAfter && !!shapeAfter, null);
    check("UNLOCK re-confirm: lane re-locked", updated?.flags?.[SCOPE]?.suppressiveLocked === true, updated?.flags?.[SCOPE]);

    // ── (i) CROSS-SCENE PLANT (F1): geo.sceneId lands the lane on the NAMED scene, not the GM's viewed one ──
    otherScene = await Scene.create({ name: "__PW__SuppOtherScene", grid: { size: gs } });
    const csRegion = await DH.placeSuppressiveZoneFromGeometry(laneGeo({ origin: { x: 700, y: 700 }, actorId: shooter.id, sceneId: otherScene.id }));
    const landedOnOther = !!(csRegion && otherScene.regions?.get(csRegion.id) && csRegion.parent?.id === otherScene.id);
    const notOnViewed = !!csRegion && !scene.regions?.get(csRegion.id);
    check("CROSS-SCENE: geo.sceneId plants on the named scene, not the viewed scene", landedOnOther && notOnViewed, { landedOnOther, notOnViewed, parent: csRegion?.parent?.id, other: otherScene.id, viewed: scene.id });
    if (csRegion) await otherScene.deleteEmbeddedDocuments("Region", [csRegion.id]).catch(() => {});

    // ── (h) PREVIEW GESTURE (real DOM+PIXI): SEEDED width, localized readout, DC math tracks the wheel, ESC ──
    const gunActor = await mkActor("__PW__SuppGunner");
    const gunTok = await mkTokenAt("__PW__SuppGunner", gunActor, 2000, 2000);
    // Fire with a NON-default declared width (zoneWidth 6, roundsFired 12): the preview must OPEN at 6m,
    // DC ceil(12/6)=2, BEFORE any wheel — proving the seed from the dialog field.
    await PV.armSuppressivePreview({ actorId: gunActor.id, attackerTokenId: gunTok.id, weaponRange: 45, roundsFired: 12, zoneWidth: 6, dmgFormula: "3d6", weaponName: "__PW__SuppGun", userId: game.user.id });
    await sleep(150);
    let readout = document.querySelector(".cp-supp-preview-readout");
    const seedTxt = readout?.textContent ?? "";
    check("PREVIEW seed: opening width = declared zoneWidth (6m, DC 2) before any wheel; localized (no raw key)", !!readout && !/CYBERPUNK\.|SuppPreviewReadout/.test(seedTxt) && /6m/i.test(seedTxt) && /save 2\b/i.test(seedTxt), seedTxt);
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 900, clientY: 500, bubbles: true }));
    await sleep(120);
    // Wheel down narrows 6m→5m → DC ceil(12/5)=3 (proves the wheel still re-sizes after the seed).
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
    await sleep(120);
    readout = document.querySelector(".cp-supp-preview-readout");
    const wheelTxt = readout?.textContent ?? "";
    check("PREVIEW: a wheel step re-sizes the lane and recomputes the DC (5m → save 3)", /5m/i.test(wheelTxt) && /save 3\b/i.test(wheelTxt), wheelTxt);
    // ESC tears everything down.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(150);
    check("PREVIEW: ESC removes the readout div", !document.querySelector(".cp-supp-preview-readout"), null);
  } catch (e) {
    check("no exception during the run", false, String(e?.stack ?? e?.message ?? e));
  } finally {
    try { PV.cancelSuppressivePreview(); } catch { /* ignore */ }
    try { if (settingTouched) await game.settings.set(SCOPE, "suppressiveFireSaves", prevSetting); } catch { /* ignore */ }
    if (combat) await combat.delete().catch(() => {});
    const sc = canvas?.scene;
    if (sc) { for (const id of [...new Set(madeRegions)]) await sc.deleteEmbeddedDocuments("Region", [id]).catch(() => {}); }
    if (otherScene) await otherScene.delete().catch(() => {});
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__Supp"))) await a.delete().catch(() => {});
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
