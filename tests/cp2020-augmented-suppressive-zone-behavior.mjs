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
 *   (h) PLACEMENT GESTURE: arm the preview, dispatch real pointermove/wheel/pointerdown/keydown, and read
 *       the geometry that was actually PLANTED — the zone is a WIDTH × WIDTH square (every side = the
 *       declared width in pixels, depth = width), anchored at the cursor by the middle of its near edge,
 *       floored at 2 m, RE-SIZED ±1 m per plain wheel notch inside [2 m, rounds fired] with the readout
 *       and the planted saveDC moving with it, TURNED 15° per SHIFT+wheel notch about that same anchor
 *       with no change of size, deaf to notches aimed at open UI, and removed by ESC. The save quotient
 *       ROUNDS DOWN (p.106: 64 rounds over 5 m = a save of 12), pinned on non-divisible cases and with
 *       the deliberate one-higher divergence from the base system's own card pinned as a value. The
 *       whole battery runs on BOTH placement paths — core's native region placement (what v14 runs) and
 *       the legacy PIXI preview (what v13 runs), the latter reached via the module's capability seam.
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
  // The metre→pixel conversion the placement itself uses, so the expected side length is derived from
  // the same helper the code under test reads the grid with (not a constant re-derived here).
  const PXGRID = await import("/modules/cp2020-augmented/module/vehicle/vehicle-grid.js");

  // The presentation rail, imported for the SILENCE legs in (e2): its capture seam is the only honest
  // reading of "did anything sound", because a headless page's own audio context is locked and every
  // real play would be swallowed by the host rather than by the product.
  const FX = await import("/modules/cp2020-augmented/module/fx/effects.js");

  const madeRegions = [], madeActors = [];
  let combat = null, prevSetting = null, settingTouched = false, otherScene = null;
  let fxPrevSetting = null, fxSettingTouched = false;

  const trackReg = (reg) => { if (reg?.id) madeRegions.push(reg.id); return reg; };
  const newMessagesSince = (before) => game.messages.contents.filter(m => !before.has(m.id)).map(m => m.content).join("\n");

  try {
    // Active, drawn canvas (enter events + region.tokens need the layer; the preview needs a real stage).
    let scene = canvas?.scene ?? game.scenes.viewed ?? game.scenes.active ?? game.scenes.contents[0];
    if (scene && game.scenes.active?.id !== scene.id) { try { await scene.activate(); } catch { /* client-only */ } }
    for (let i = 0; i < 30 && !canvas?.ready; i++) await sleep(200);
    scene = canvas?.scene ?? scene;
    if (!scene) { check("active scene present", false, null); return out; }

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

    // ⭐ A SAVE OF ZERO IS NOT A BROKEN SAVE (2026-08-27, the width-ceiling retirement's other half).
    // `_dcFor` lost its `max(1, …)` floor, so an over-wide zone now plants `saveDC: 0` — and the claim
    // that this is HONEST rather than degenerate is exactly this behaviour: the evasion roll is
    // `1d10 + REF + Athletics`, whose minimum is 1, so `total > dc` passes for everybody. A zone
    // nobody has to save against, which is the bad choice the shooter made and can see. Driven at the
    // real resolver rather than reasoned about, and read off the card it posts.
    const msgBeforeZero = new Set(game.messages.map(m => m.id));
    const dmgBeforeZero = Number(evader.system?.damage) || 0;
    await DH._executeSuppressionEvasion({ actorId: evader.id, tokenId: evTok.id, sceneId: scene.id, saveDC: 0, dmgFormula: "3d6", attackerId: shooter.id });
    let zeroMsgs = ""; for (let i = 0; i < 20; i++) { zeroMsgs = newMessagesSince(msgBeforeZero); if (/EVADED/i.test(zeroMsgs)) break; await sleep(150); }
    check("ZERO DC: a save of 0 is passed by every crossing — the over-wide zone prices nothing",
      /EVADED/i.test(zeroMsgs), zeroMsgs.slice(0, 160));
    check("ZERO DC: and nobody took damage from it (negative)",
      (Number(evader.system?.damage) || 0) === dmgBeforeZero,
      { before: dmgBeforeZero, after: Number(evader.system?.damage) || 0 });

    // ⭐ THE RAIL IS ARMED BEFORE THE FAILING SAVE, not after it (2026-08-27, ledger #23bi). The crossing
    // below is the whole subject of the (e2) legs: the master FX switch is turned ON so a silence reading
    // means the PRODUCT stayed quiet rather than the switch having been off, and the element's capture
    // seam stands in for the speaker because this page's audio context is locked and would swallow a real
    // play. Both are handed back in the finally.
    fxPrevSetting = game.settings.get(SCOPE, "combatFxEnabled"); fxSettingTouched = true;
    await game.settings.set(SCOPE, "combatFxEnabled", true);
    const heard = [];
    FX._setHitSoundSink((e) => heard.push({ ...e }));

    const dmgBeforeCrossing = Number(evader.system?.damage) || 0;
    let fired = null; const firedHook = Hooks.on("cyberpunk2020.weaponFired", (pl) => { if (!fired) fired = pl; });
    await DH._executeSuppressionEvasion({ actorId: evader.id, tokenId: evTok.id, sceneId: scene.id, saveDC: 999, dmgFormula: "3d6", attackerId: shooter.id });
    for (let i = 0; i < 25 && !fired; i++) await sleep(150);
    Hooks.off("cyberpunk2020.weaponFired", firedHook);
    const hitEntries = fired ? Object.values(fired.areaDamages ?? {}).flat() : [];
    const hitCount = hitEntries.length;
    check("EVASION failure: re-emits weaponFired with 1..6 random hits, all positive damage", !!fired && hitCount >= 1 && hitCount <= 6 && hitEntries.every(h => Number(h.damage) > 0), { hitCount, sample: hitEntries[0] });

    // ── (e2) A ZONE CROSSING IS SILENT (user ruling 2026-08-27, field report #23bi) ─────────────────
    // The failed save's damage re-enters the shot hook as a SYNTHETIC payload whose only errand is the
    // damage pipeline — no round is arriving on screen — so the crossing plays no audio cue at any point
    // of the flow. The emitter declares that with `fxMute` and the presentation rail honours it at the
    // door; these legs read the declaration, the rail's own verdict, and then the SPEAKER, which is the
    // only reading the user's report was ever about.
    check("SILENT CROSSING: the re-emitted payload declares itself no shot (fxMute)", fired?.fxMute === true, { fxMute: fired?.fxMute ?? null, keys: fired ? Object.keys(fired) : null });
    const railVerdict = fired ? await FX.fxWeaponFired({ ...fired }) : null;
    check("SILENT CROSSING: the presentation rail refuses the re-emission as muted, fanning out nothing",
      railVerdict?.skipped === "muted" && railVerdict?.shots === 0 && railVerdict?.hitAudio === null,
      { skipped: railVerdict?.skipped, shots: railVerdict?.shots, hitAudio: railVerdict?.hitAudio });
    await sleep(1200);
    check("SILENT CROSSING: nothing sounded while the crossing resolved (negative)", heard.length === 0, { sounds: heard.length, srcs: heard.map(h => h.src) });

    // …AND THE DAMAGE STILL LANDS, SILENTLY. The re-emission carries a target token, so the pipeline
    // routes it to the apply window; the crossing is only resolved once a reader clicks Apply, which is
    // where the reported cue was heard. Driven as the real DOM gesture (the outcome rule), then the
    // written HP and the speaker are read together — silence with no damage would certify nothing.
    let applyDlg = null;
    for (let i = 0; i < 40 && !applyDlg; i++) {
      applyDlg = [...foundry.applications.instances.values()].find(w => w.constructor?.name === "DamageDialog")
        ?? Object.values(ui.windows ?? {}).find(w => w.constructor?.name === "DamageDialog") ?? null;
      if (!applyDlg) await sleep(200);
    }
    check("SILENT CROSSING: the crossing reached the damage pipeline — an apply window opened for it", !!applyDlg, null);
    heard.length = 0;
    const applyBtn = applyDlg?.element?.querySelector('[data-action="applyDamage"]') ?? null;
    check("SILENT CROSSING: the apply window offers the real Apply control", !!applyBtn, null);
    if (applyBtn) applyBtn.click();
    for (let i = 0; i < 30 && (Number(evader.system?.damage) || 0) === dmgBeforeCrossing; i++) await sleep(200);
    await sleep(800);
    const dmgApplied = (Number(evader.system?.damage) || 0) - dmgBeforeCrossing;
    check("SILENT CROSSING: applying the crossing's damage writes HP on the figure that crossed", dmgApplied > 0, { before: dmgBeforeCrossing, applied: dmgApplied });
    check("SILENT CROSSING: and that apply sounded NOTHING through the capture seam (negative — the reported cue)",
      heard.length === 0, { sounds: heard.length, srcs: heard.map(h => h.src), damageApplied: dmgApplied });
    FX._setHitSoundSink(null);
    for (const w of [...foundry.applications.instances.values()]) { if (w.constructor?.name === "DamageDialog") await w.close().catch(() => {}); }
    for (const w of Object.values(ui.windows ?? {})) { if (w.constructor?.name === "DamageDialog") await w.close?.().catch(() => {}); }

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
    // The unlock re-arms our own preview (userId = this GM); dismiss it. ⚠ The native path opens core's
    // placement asynchronously, so the dismiss is given time to have something to dismiss and repeated.
    await sleep(400);
    PV.cancelSuppressivePreview();
    await sleep(200);
    PV.cancelSuppressivePreview();
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

    // ── (h) PLACEMENT GESTURE (real DOM+PIXI), ON BOTH PLACEMENT PATHS: the zone is a WIDTH × WIDTH
    //        SQUARE carried on the cursor, RE-SIZED by the plain wheel and TURNED by SHIFT+wheel.
    //        Every leg reads the geometry that was actually PLANTED — the Region the confirm produced —
    //        rather than a redrawn preview, so what is asserted is the polygon a token will be asked to
    //        save against. The whole battery runs TWICE: once on core's native region placement API
    //        (what a v14 client really runs) and once on the legacy PIXI preview (what a v13 client
    //        runs), the second forced by the module's own capability seam rather than by version
    //        sniffing, because one rig can only ever exercise one core.
    const gunActor = await mkActor("__PW__SuppGunner");
    const board = canvas.app.view;
    const toWorld = (cx, cy) => { const t = canvas.stage.worldTransform; const p = t.applyInverse(new PIXI.Point(cx, cy)); return { x: p.x, y: p.y }; };
    const mPx = (m) => PXGRID.metersToPixels(scene, m);
    /** The four corners of a planted zone, as [near-left, far-left, far-right, near-right] points. */
    const cornersOf = (region) => {
      const pts = region?.shapes?.[0]?.points ?? [];
      const c = [];
      for (let i = 0; i + 1 < pts.length; i += 2) c.push({ x: pts[i], y: pts[i + 1] });
      return c;
    };
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
    /** The four side lengths of a planted zone, in the corner order cornersOf hands back. */
    const sidesOf = (c) => (c.length === 4 ? [dist(c[0], c[1]), dist(c[1], c[2]), dist(c[2], c[3]), dist(c[3], c[0])] : []);
    /** Every side equals the given metre width, converted by the same helper the placement reads. */
    const squareOf = (c, m) => { const s = sidesOf(c); return s.length === 4 && s.every(x => near(x, mPx(m), 2)); };
    /** The geometry payload the confirm relayed, as it was frozen onto the planted region's flags. */
    const geoFlagOf = (reg) => reg?.flags?.[SCOPE]?.suppressiveGeometry ?? null;
    /** The saveDC the planted behavior is actually asking tokens to beat. */
    const saveDCOf = (reg) => Number(behaviorOf(reg)?.system?.saveDC);

    /** The live shape of core's own placement preview, mid-placement — null off the native path. */
    const livePreviewShape = () => canvas.regions?._placementContext?.shape?.toObject?.() ?? null;

    /** A point over the sidebar, for the notches that must be REFUSED: both gates read a position (ours
     *  reads the event target, core's reads `document.elementFromPoint`), so an honest refusal test has
     *  to aim the notch at real UI rather than at coordinate 0,0. */
    const uiPoint = () => {
      const r = (document.querySelector("#sidebar") ?? document.body).getBoundingClientRect();
      return { x: Math.round(r.left + (r.width / 2)) || 5, y: Math.round(r.top + (r.height / 2)) || 5 };
    };

    /** Run one full placement on the chosen path: arm with a declared width, carry the cursor to a point,
     *  optionally take N plain notches (`wheel`, the re-size gesture) and/or N SHIFT-modified notches
     *  (`shiftWheel`, the turn gesture), confirm on the board, and hand back the Region that was planted
     *  plus the live preview shape as it stood at the instant before the confirming click. */
    const placeZone = async ({ native, zoneWidth, roundsFired = 12, clientX = 900, clientY = 500, wheel = 0, shiftWheel = 0, wheelOnUI = 0 }) => {
      const before = new Set(scene.regions.map(rg => rg.id));
      PV._setNativePlacement(native);
      // ⚠ NOT awaited: the native path's own promise does not settle until the placement is confirmed or
      // dismissed, so awaiting the arm here would deadlock against the gestures that end it.
      const armed = PV.armSuppressivePreview({ actorId: gunActor.id, attackerTokenId: gunTok.id, weaponRange: 45,
        roundsFired, zoneWidth, dmgFormula: "3d6", weaponName: "__PW__SuppGun", userId: game.user.id });
      await sleep(250);
      // ⚠⚠ HARNESS, NOT PRODUCT (cost two full two-path runs, 2026-08-27). CORE's own wheel router gates
      // on `document.elementFromPoint(clientX, clientY).id === "board"` — NOT on the event target — so a
      // notch whose client point lands on ANY overlaying UI is dropped in silence, and the rotation legs
      // then read 0° as though the product had stopped turning. Two things overlay it here: our own
      // armed-notice toasts (five stack at a time, one per arm), and — only on the native path — the
      // canvas UI core itself raises when `placeRegion` ACTIVATES the region layer. So: clear the toasts,
      // then resolve the aim to a point that actually hit-tests to the board, and assert that resolution
      // rather than assume it.
      try { ui.notifications.clear(); } catch { /* nothing queued */ }
      await sleep(150);
      const describe = (el) => (el ? `${el.tagName.toLowerCase()}#${el.id}.${String(el.className || "").split(/\s+/).filter(Boolean).join(".")}` : "none");
      const boardAt = (x, y) => document.elementFromPoint(x, y)?.id === "board";
      const inScene = (x, y) => { const w = toWorld(x, y); return canvas.dimensions.sceneRect.contains(w.x, w.y); };
      let ax = clientX, ay = clientY;
      const blockedBy = boardAt(ax, ay) ? null : describe(document.elementFromPoint(ax, ay));
      if (blockedBy) {
        // Spiral outward for exposed canvas that still lands inside the scene — the gesture is the same
        // gesture wherever on the map it is made, so moving the aim costs the legs nothing.
        outer: for (let r = 40; r <= 520; r += 40) {
          for (const [dx, dy] of [[-r, 0], [r, 0], [0, -r], [0, r], [-r, -r], [r, -r], [-r, r], [r, r]]) {
            const x = clientX + dx, y = clientY + dy;
            if (x < 20 || y < 20 || x > window.innerWidth - 20 || y > window.innerHeight - 20) continue;
            if (boardAt(x, y) && inScene(x, y)) { ax = x; ay = y; break outer; }
          }
        }
      }
      board.dispatchEvent(new PointerEvent("pointermove", { clientX: ax, clientY: ay, bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      await sleep(150);
      const hitAtAim = describe(document.elementFromPoint(ax, ay));
      for (let i = 0; i < Math.abs(wheel); i++) {
        board.dispatchEvent(new WheelEvent("wheel", { deltaY: wheel < 0 ? -100 : 100, clientX: ax, clientY: ay, bubbles: true, cancelable: true }));
        await sleep(80);
      }
      for (let i = 0; i < Math.abs(shiftWheel); i++) {
        board.dispatchEvent(new WheelEvent("wheel", { deltaY: shiftWheel < 0 ? -100 : 100, shiftKey: true, clientX: ax, clientY: ay, bubbles: true, cancelable: true }));
        await sleep(80);
      }
      // The canvas-event gate: notches aimed at open UI must reach the zone at all (the 2026-08-12
      // note below). Dispatched in the SAME run as the accepted notches so one placement proves both.
      const offBoard = document.querySelector("#sidebar") ?? document.body;
      const up = uiPoint();
      for (let i = 0; i < wheelOnUI; i++) {
        offBoard.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, clientX: up.x, clientY: up.y, bubbles: true, cancelable: true }));
        await sleep(80);
      }
      // ⚠ HARNESS, NOT PRODUCT: dispatching a wheel at the SIDEBAR scrolls it, and the browser then
      // emits its own `pointermove` from wherever the real (never-moved) cursor is — which the preview
      // honours, because free placement follows the pointer everywhere and is deliberately not gated to
      // the board (only the wheel and the confirming click are). Rig-measured: three sidebar notches
      // walked the planted origin 37px off the point this run asked for. So the position is fixed LAST,
      // after every notch, and the expected world point is read at that same instant — the rotation
      // legs then measure turning alone, which is what they are for.
      board.dispatchEvent(new PointerEvent("pointermove", { clientX: ax, clientY: ay, bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      await sleep(150);
      const readoutTxt = document.querySelector(".cp-supp-preview-readout")?.textContent ?? "";
      const previewShape = livePreviewShape();
      const worldAtMove = toWorld(ax, ay);
      board.dispatchEvent(new PointerEvent("pointerdown", { button: 0, buttons: 1, clientX: ax, clientY: ay, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      let region = null;
      for (let i = 0; i < 40; i++) { await sleep(150); const fresh = scene.regions.find(rg => !before.has(rg.id)); if (fresh) { trackReg(fresh); region = fresh; break; } }
      // ⚠ HARNESS SAFETY, learned the hard way: on the native path a confirm the module REFUSES (the
      // off-map guard) leaves core's placement live and its promise pending forever, so a bare
      // `await armed` turns one red leg into a hung suite. Dismiss anything still live, then await with
      // a ceiling — the legs above still red honestly on the missing Region.
      PV.cancelSuppressivePreview();
      await Promise.race([armed.catch(() => {}), sleep(3000)]);
      return { region, readoutTxt, worldAtMove, previewShape, hitAtAim, blockedBy, aim: { x: ax, y: ay } };
    };

    // ⭐ THE GESTURE MUST TARGET THE BOARD. Both paths gate on where the gesture landed — ours on the
    // event target (`ev.target === canvas?.app?.view || ev.target?.id === "board"`, added 2026-08-12,
    // `ab84e14`), core's on `document.elementFromPoint(clientX, clientY).id === "board"` — so a scroll
    // or a click on open UI must reach the zone at all. Every dispatch below therefore names BOTH the
    // board element and a board-side client point.
    const headingOf = (c) => { const a = mid(c[0], c[3]), f = mid(c[1], c[2]); return Math.atan2(f.y - a.y, f.x - a.x) * 180 / Math.PI; };
    const side6 = mPx(6);
    const gs2 = scene.grid?.size ?? 100;

    // ⛔ HARNESS PRECONDITION, not a product assertion. The native path refuses a confirm whose anchor is
    // OFF THE MAP (`preConfirm`), and a refused confirm is indistinguishable from a broken one at this
    // distance — it simply plants nothing. So the view is centred on the scene first and every client
    // point this section aims at is checked to land inside the scene rectangle BEFORE the legs run. A
    // guard leg here turns an environment fault into its own named diagnosis instead of ~30 fake reds.
    const aimPoints = [[900, 500], [950, 560], [880, 520], [880, 560], [920, 600], [960, 620], [940, 480], [1000, 470]];
    // ⚠ AND CLEAR THE SCREEN FIRST. Sections (a)–(g) drive chat cards and evasion prompts, and a framed
    // window one of them opened sits over the canvas for the rest of the run — where it both eats the
    // Escape (core's dismiss ladder closes windows before it reaches the layer) and makes core's wheel
    // router refuse every notch aimed under it. Rig-measured on the first two-path run: the aim point
    // hit-tested to `span.inactive` — sheet markup — and four native legs read as product failures.
    for (const app of [...foundry.applications.instances.values()]) { if (app.hasFrame) await app.close().catch(() => {}); }
    for (const app of Object.values(ui.windows ?? {})) await app.close?.().catch(() => {});
    try { ui.notifications.clear(); } catch { /* nothing queued */ }
    await sleep(300);
    try {
      const sr0 = canvas.dimensions.sceneRect;
      await canvas.pan({ x: sr0.x + (sr0.width / 2), y: sr0.y + (sr0.height / 2), scale: 0.35 });
    } catch { /* pan is best-effort; the guard leg below is what decides */ }
    await sleep(500);
    const sceneRect = canvas.dimensions.sceneRect;
    const offMapAims = aimPoints.filter(([cx, cy]) => { const w = toWorld(cx, cy); return !sceneRect.contains(w.x, w.y); });
    check("HARNESS GUARD: every client point this section aims at maps inside the scene rectangle (the off-map refusal must not fire)",
      offMapAims.length === 0, { offMapAims, sceneRect: { x: sceneRect.x, y: sceneRect.y, w: sceneRect.width, h: sceneRect.height } });

    // The shooter's figure is planted in a scene CORNER, deliberately far from every aim point above, so
    // the "the zone no longer starts at the muzzle" leg measures free placement and not a coincidence.
    const gunnerAt = { x: sceneRect.x + (gs2 * 1.5), y: sceneRect.y + (gs2 * 1.5) };
    const gunTok = await mkTokenAt("__PW__SuppGunner", gunActor, gunnerAt.x, gunnerAt.y);
    check("HARNESS GUARD: the shooter's figure is on the canvas and clear of every aim point",
      !!canvas.tokens.get(gunTok.id) && aimPoints.every(([cx, cy]) => dist(toWorld(cx, cy), gunnerAt) > mPx(8)),
      { gunnerAt, onCanvas: !!canvas.tokens.get(gunTok.id) });

    // ── THE PLACEMENT-PATH PROBE: a CAPABILITY answer, not a version test ──
    check("PATH PROBE: the module reads core's native region placement API as present on this client",
      PV.nativePlacementAvailable() === true && typeof canvas.regions?.placeRegion === "function",
      { probe: PV.nativePlacementAvailable(), api: typeof canvas.regions?.placeRegion });
    check("PATH PROBE: the seam forces either answer and null hands the probe back to the real API",
      PV._setNativePlacement(false) === false && PV.nativePlacementAvailable() === false
        && PV._setNativePlacement(true) === true && PV.nativePlacementAvailable() === true
        && PV._setNativePlacement(null) === null && PV.nativePlacementAvailable() === true, null);

    // ⭐ THE WHOLE GESTURE BATTERY, RUN ONCE PER PATH. `native: true` is what a v14 client really runs
    // (core owns the preview, the carry, the snap and the confirm); `native: false` is the legacy PIXI
    // preview a v13 client runs, reached here through the module's capability seam because one rig can
    // only ever be one core. The asserted VALUES are identical on both — that identity is the point:
    // a shooter's burst is priced the same whichever core they are sitting at.
    for (const path of [{ native: true, tag: "NATIVE" }, { native: false, tag: "LEGACY" }]) {
      const T2 = path.tag;

      const p6 = await placeZone({ native: path.native, zoneWidth: 6, roundsFired: 12, clientX: 900, clientY: 500 });
      check(`${T2} PLACE readout: the DECLARED width is what is shown (6m, save floor(12/6)=2); localized, no raw key`,
        !!p6.readoutTxt && !/CYBERPUNK\.|SuppPreviewReadout/.test(p6.readoutTxt) && /6m/i.test(p6.readoutTxt) && /save 2\b/i.test(p6.readoutTxt), p6.readoutTxt);
      check(`${T2} PLACE: the confirm planted a Region`, !!p6.region, null);
      const c6 = cornersOf(p6.region);
      check(`${T2} SQUARE: the planted shape is a 4-corner polygon`, c6.length === 4, c6.length);
      // [near-left, far-left, far-right, near-right] — all four sides equal the DECLARED width in pixels.
      // This is the whole ruling in one number: the old geometry ran the zone the weapon's Range stat
      // (45 m ⇒ ~9× this side) down one axis and priced none of it.
      const sides6 = sidesOf(c6);
      check(`${T2} SQUARE: every side = the declared width in pixels (6m = ${Math.round(side6)}px)`,
        sides6.length === 4 && sides6.every(s => near(s, side6, 2)), sides6.map(s => Math.round(s)));
      check(`${T2} SQUARE: depth equals width (the second axis is not the weapon's Range stat)`,
        sides6.length === 4 && near(dist(c6[0], c6[1]), dist(c6[0], c6[3]), 2), { depth: Math.round(sides6[0] ?? 0), width: Math.round(sides6[3] ?? 0) });
      // The anchor: the middle of the NEAR edge is the point the cursor held (anchorX:0 / anchorY:0.5).
      // ⚠ The native path SNAPS the carry to the grid, so its anchor is the nearest snap point to the
      // cursor rather than the cursor itself — one grid square is the honest tolerance there, and the
      // legacy preview's free carry still has to land within pixels.
      const anchor6 = c6.length === 4 ? mid(c6[0], c6[3]) : { x: NaN, y: NaN };
      const anchorTol = path.native ? gs2 : 3;
      check(`${T2} ANCHOR: the middle of the near edge sits at the cursor's world point (${path.native ? "within one grid square, core snaps the carry" : "free placement, unsnapped"})`,
        dist(anchor6, p6.worldAtMove) <= anchorTol, { anchor: anchor6, cursor: p6.worldAtMove, tol: anchorTol });
      check(`${T2} ANCHOR: the shooter's own token is NOT the origin (the zone no longer starts at the muzzle)`,
        dist(anchor6, gunnerAt) > side6, { anchor: anchor6, gunner: gunnerAt });

      // ⭐ THE BOOK'S OWN WORKED EXAMPLE, as the rounding oracle: p.106 puts 64 rounds into a 5-metre area
      // and calls for "a save of 12 or greater". 64 ÷ 5 = 12.8, so the quotient ROUNDS DOWN — 13 would be
      // the ceil answer and is not what is printed. This one leg is why `_dcFor` floors.
      const pBook = await placeZone({ native: path.native, zoneWidth: 5, roundsFired: 64, clientX: 940, clientY: 480 });
      check(`${T2} SAVE ROUNDING: the p.106 worked example — 64 rounds over 5 m asks for 12, not 13 (quotient rounds down)`,
        /save 12\b/i.test(pBook.readoutTxt) && !/save 13\b/i.test(pBook.readoutTxt) && saveDCOf(pBook.region) === 12,
        { readout: pBook.readoutTxt, dc: saveDCOf(pBook.region) });

      // FLOOR: a declaration under the book's 2 m minimum opens at 2 m, not at what was asked for.
      const p1 = await placeZone({ native: path.native, zoneWidth: 1, roundsFired: 12, clientX: 950, clientY: 560 });
      const c1 = cornersOf(p1.region);
      check(`${T2} FLOOR: a 1 m declaration plants the 2 m minimum (side = ${Math.round(mPx(2))}px)`,
        c1.length === 4 && near(dist(c1[0], c1[1]), mPx(2), 2), c1.length === 4 ? Math.round(dist(c1[0], c1[1])) : null);
      check(`${T2} FLOOR: the readout states the floored width, not the declaration`, /2m/i.test(p1.readoutTxt), p1.readoutTxt);

      // ── PLAIN WHEEL = RE-SIZE (ruled 2026-08-27, ledger #23aw) ────────────────────────────────
      // The shooter places the zone, but only a GM holds region controls afterwards, so placement is the
      // shooter's ONE chance to size it. A plain notch steps the width ±1 m inside the same bounds the
      // fire dialog enforces (2 m floor, no wider than the rounds this burst fires), and the readout must
      // price the change AS IT HAPPENS — the save number moving with the width is the point of the readout.

      // WIDER: one notch away from the user on a 3 m declaration with 11 rounds → 4 m, and the save the
      // burst asks for falls from floor(11/3)=3 to floor(11/4)=2. Deliberately NON-DIVISIBLE in both
      // states, so the leg reads the rounding rule and not just the division.
      const pUp = await placeZone({ native: path.native, zoneWidth: 3, roundsFired: 11, clientX: 880, clientY: 520, wheel: -1 });
      const cUp = cornersOf(pUp.region);
      check(`${T2} WHEEL WIDTH UP: the readout carries the stepped width AND its recomputed save (3m/save 3 → 4m/save 2, both quotients rounded down)`,
        /4m/i.test(pUp.readoutTxt) && /save 2\b/i.test(pUp.readoutTxt) && !/3m/i.test(pUp.readoutTxt), pUp.readoutTxt);
      check(`${T2} WHEEL WIDTH UP: the planted square grew to the stepped width (4m = ${Math.round(mPx(4))}px on every side)`,
        squareOf(cUp, 4), sidesOf(cUp).map(s => Math.round(s)));
      check(`${T2} WHEEL WIDTH UP: the planted behavior asks for the stepped save (2), not the declared one (3)`,
        saveDCOf(pUp.region) === 2, saveDCOf(pUp.region));
      // ⭐ NATIVE ONLY: the shape core is actually holding must have grown, not just our own readout —
      // a re-size that never reached the placement preview would leave the shooter aiming a stale square
      // and only discover it on the plant.
      if (path.native) {
        check("NATIVE PREVIEW: core's live placement shape itself carries the stepped side (square, both axes)",
          !!pUp.previewShape && near(Number(pUp.previewShape.width), mPx(4), 2) && near(Number(pUp.previewShape.height), mPx(4), 2),
          pUp.previewShape && { w: pUp.previewShape.width, h: pUp.previewShape.height, expect: Math.round(mPx(4)) });
      }

      // NARROWER: one notch toward the user on a 4 m declaration with 11 rounds → 3 m, save floor(11/3)=3
      // (was floor(11/4)=2). Non-divisible in both states, and the save moves the OTHER way from the
      // widening leg, so the two together pin the direction of the gesture as well as the rounding.
      const pDn = await placeZone({ native: path.native, zoneWidth: 4, roundsFired: 11, clientX: 880, clientY: 560, wheel: +1 });
      const cDn = cornersOf(pDn.region);
      check(`${T2} WHEEL WIDTH DOWN: the readout carries the stepped width AND its recomputed save (4m/save 2 → 3m/save 3, both quotients rounded down)`,
        /3m/i.test(pDn.readoutTxt) && /save 3\b/i.test(pDn.readoutTxt) && !/4m/i.test(pDn.readoutTxt), pDn.readoutTxt);
      check(`${T2} WHEEL WIDTH DOWN: the planted square shrank to the stepped width (3m = ${Math.round(mPx(3))}px on every side)`,
        squareOf(cDn, 3), sidesOf(cDn).map(s => Math.round(s)));
      check(`${T2} WHEEL WIDTH DOWN: the planted behavior asks for the stepped save (3), not the declared one (2)`,
        saveDCOf(pDn.region) === 3, saveDCOf(pDn.region));

      // FLOOR CLAMP: five narrowing notches from a 4 m declaration walk down two steps and then stop — the
      // 2 m minimum holds against the three notches that would take it below (and below zero).
      const pFloor = await placeZone({ native: path.native, zoneWidth: 4, roundsFired: 13, clientX: 920, clientY: 600, wheel: +5 });
      const cFloor = cornersOf(pFloor.region);
      check(`${T2} WHEEL CLAMP FLOOR: five narrowing notches from 4m stop at the 2 m minimum, in the readout and its save (floor(13/2)=6)`,
        /2m/i.test(pFloor.readoutTxt) && /save 6\b/i.test(pFloor.readoutTxt), pFloor.readoutTxt);
      check(`${T2} WHEEL CLAMP FLOOR: the planted square is the 2 m minimum (${Math.round(mPx(2))}px on every side)`,
        squareOf(cFloor, 2) && saveDCOf(pFloor.region) === 6, { sides: sidesOf(cFloor).map(s => Math.round(s)), dc: saveDCOf(pFloor.region) });

      // ⏪⭐ THE CAP IS GONE, AND THESE LEGS ARE ITS INVERSE (2026-08-27, conforming to the upstream
      // landing — the author's own reason is quoted at lookups.js `FireZoneWidth`: *"this system prefers
      // showing a bad choice over refusing it."*). The wheel used to stop at the rounds fired, because
      // past that the save quotient falls under 1 and every further metre is free ground. It no longer
      // stops: five widening notches from 6 m reach 11 m on a burst of 8 — and the price is SHOWN rather
      // than propped up, because `_dcFor` lost its `max(1, …)` in the same pass. floor(8/11) = 0.
      const pCap = await placeZone({ native: path.native, zoneWidth: 6, roundsFired: 8, clientX: 960, clientY: 620, wheel: -5 });
      const cCap = cornersOf(pCap.region);
      check(`${T2} WHEEL NO CAP: five widening notches climb PAST the rounds fired unimpeded (6m + 5 ⇒ 11m on a burst of 8)`,
        /11m/i.test(pCap.readoutTxt), pCap.readoutTxt);
      check(`${T2} WHEEL NO CAP: the planted square is the un-capped width (11m = ${Math.round(mPx(11))}px on every side)`,
        squareOf(cCap, 11), { sides: sidesOf(cCap).map(s => Math.round(s)) });
      check(`${T2} SAVE SHOWN NOT FLOORED: a zone wider than its burst reads save 0, on the live readout and in the planted behavior`,
        /save 0\b/i.test(pCap.readoutTxt) && saveDCOf(pCap.region) === 0,
        { readout: pCap.readoutTxt, dc: saveDCOf(pCap.region) });

      // PAYLOAD COHERENCE: the confirm freezes ONE width into three places — the metre value, the pixel
      // side (metersToPixels of that same value, carried in BOTH lengthPx and widthPx because the square is
      // the rectangle helper with equal sides), and the save. A wheel-adjusted width must move all three
      // together or the card, the drawing and the region disagree about the same burst. Identical on both
      // paths is what lets the GM-side plant and the socket relay stay ignorant of which one ran.
      const gCap = geoFlagOf(pCap.region);
      check(`${T2} CONFIRM PAYLOAD: the wheel-adjusted width rides as widthM, as metersToPixels(widthM) in both pixel axes, and as its own saveDC`,
        !!gCap && Number(gCap.widthM) === 11 && near(Number(gCap.widthPx), mPx(11), 2) && near(Number(gCap.lengthPx), mPx(11), 2)
          && Number(gCap.roundsFired) === 8 && saveDCOf(pCap.region) === 0,
        { widthM: gCap?.widthM, widthPx: gCap?.widthPx, lengthPx: gCap?.lengthPx, expectPx: Math.round(mPx(11)), dc: saveDCOf(pCap.region) });

      // ⭐ THE WHEEL HINT (2026-08-27, adopted from the upstream landing). The gesture is invisible —
      // a plain notch over the board is the canvas ZOOM everywhere else in Foundry — so the armed cue
      // has to say it. Asserted as a RESOLVED string rather than as a key: a missing key renders as
      // the bare key and would sail past a presence check.
      const hint = game.i18n.localize("CYBERPUNK.SuppZoneWidthHint");
      const armed = game.i18n.format("CYBERPUNK.SuppPreviewArmed", { hint });
      check(`${T2} WHEEL HINT: the armed cue tells the shooter the wheel resizes and Shift+wheel turns`,
        !/^CYBERPUNK\./.test(hint) && /wheel/i.test(hint) && /shift/i.test(hint)
        && armed.includes(hint) && !armed.includes("{hint}"),
        { hint, armed });

      // ⛔ THE DOCUMENTED CARD-PARITY DIVERGENCE, pinned as a VALUE so it cannot drift unnoticed.
      // 33 rounds over 2 m: our zone asks floor(33/2) = 16. The installed base system's own suppressive
      // card computes ceil on the same two numbers and would print 17 — we deliberately do not recompute
      // or rewrite his card, so on a 1.1.x host the two numbers differ by one whenever the quotient is
      // fractional. The ZONE is the resolving number. The leg asserts both halves of the shape: the save
      // rounds down, and the numerator the base card mirrors is carried through untouched at 33.
      const pDiv = await placeZone({ native: path.native, zoneWidth: 2, roundsFired: 33, clientX: 1000, clientY: 470 });
      const gDiv = geoFlagOf(pDiv.region);
      check(`${T2} SAVE QUOTIENT ROUNDS DOWN; CARD-PARITY DIVERGENCE PINNED: 33 rounds over 2 m asks 16 (not the base card's 17), rounds-fired carried through unchanged`,
        saveDCOf(pDiv.region) === 16 && Number(gDiv?.roundsFired) === 33 && Number(gDiv?.widthM) === 2
          && /save 16\b/i.test(pDiv.readoutTxt) && !/save 17\b/i.test(pDiv.readoutTxt),
        { dc: saveDCOf(pDiv.region), rounds: gDiv?.roundsFired, widthM: gDiv?.widthM, readout: pDiv.readoutTxt });

      // ── SHIFT+WHEEL = TURN ────────────────────────────────────────────────────────────────────
      // Rotation stays reachable under the modifier at 15° a notch — core's own COARSE step on the native
      // path (it reads `precise = !event.shiftKey`), matched by the legacy preview so the two agree. The
      // anchor and every side length are unchanged, which is the leg that catches a modified notch that
      // re-sized instead.
      const pRot = await placeZone({ native: path.native, zoneWidth: 6, roundsFired: 12, clientX: 900, clientY: 500, shiftWheel: +2, wheelOnUI: 3 });
      const cR = cornersOf(pRot.region);
      const sidesR = sidesOf(cR);
      // Delivery, asserted before the gesture it carries: core's wheel router drops any notch whose
      // client point does not hit-test to the board, so a turn leg reading 0° is ambiguous without this.
      check(`${T2} SHIFT+WHEEL delivery: the aim point hit-tests to the board when the notches were taken`,
        /#board\b/.test(String(pRot.hitAtAim)), { hit: pRot.hitAtAim, blockedBy: pRot.blockedBy, aim: pRot.aim });
      check(`${T2} SHIFT+WHEEL: the modified notch does NOT re-size — every side is still the declared width`,
        sidesR.length === 4 && sidesR.every(s => near(s, side6, 2)), sidesR.map(s => Math.round(s)));
      check(`${T2} SHIFT+WHEEL: the readout still states the declared width and save (turning cannot change the price)`,
        /6m/i.test(pRot.readoutTxt) && /save 2\b/i.test(pRot.readoutTxt), pRot.readoutTxt);
      const anchorR = cR.length === 4 ? mid(cR[0], cR[3]) : { x: NaN, y: NaN };
      check(`${T2} SHIFT+WHEEL: the pivot is the middle of the near edge — the anchor sits on the cursor, unmoved by the notches`,
        dist(anchorR, pRot.worldAtMove) <= anchorTol, { anchor: anchorR, cursor: pRot.worldAtMove, tol: anchorTol });
      // The far edge swung by exactly the notches taken. Two modified notches toward the user = +30°.
      const turned = cR.length === 4 && c6.length === 4 ? ((headingOf(cR) - headingOf(c6) + 540) % 360) - 180 : NaN;
      check(`${T2} SHIFT+WHEEL: two modified notches turned the square 30° (15° per notch)`, near(turned, 30, 1.5), turned);
      // The same run took three PLAIN notches at open UI. The gate must have eaten all three — now doubly
      // load-bearing, because an ungated plain notch would silently re-price the burst.
      check(`${T2} CANVAS GATE: three plain notches aimed at open UI changed neither the width nor the angle`,
        squareOf(cR, 6) && near(turned, 30, 1.5), { sides: sidesR.map(s => Math.round(s)), turned });

      // The plain wheel does not turn the square, and the modified wheel does not resize it: read the two
      // headings against each other so the split is asserted as a split, not as two unrelated placements.
      const turnedByPlain = cUp.length === 4 && c6.length === 4 ? ((headingOf(cUp) - headingOf(c6) + 540) % 360) - 180 : NaN;
      check(`${T2} GESTURE SPLIT: the plain re-size notch left the heading alone (0°), while the modified notch turned it`,
        near(turnedByPlain, 0, 1.5) && near(turned, 30, 1.5), { plain: turnedByPlain, shifted: turned });

      // ESC tears everything down — core's own dismiss on the native path, our key listener on the legacy one.
      // ⚠⚠ HARNESS, NOT PRODUCT: core's Escape binding is a LADDER, and the layer's own dismiss is the
      // LAST rung. `ClientKeybindings.#onDismiss` first cancels a drag, then closes the main menu, a
      // context menu, a Tour, and then EVERY open framed Application — returning as soon as any of those
      // consumed the key. A framed window left open by an earlier section therefore eats the Escape and
      // the placement is never told, which reads exactly like a placement that refuses to dismiss. Close
      // them first, then press, so the leg measures the dismiss and not the ladder above it.
      PV._setNativePlacement(path.native);
      for (const app of [...foundry.applications.instances.values()]) { if (app.hasFrame) await app.close().catch(() => {}); }
      for (const app of Object.values(ui.windows ?? {})) await app.close?.().catch(() => {});
      try { ui.notifications.clear(); } catch { /* nothing queued */ }
      await sleep(200);
      const escArm = PV.armSuppressivePreview({ actorId: gunActor.id, attackerTokenId: gunTok.id, weaponRange: 45, roundsFired: 12, zoneWidth: 4, dmgFormula: "3d6", weaponName: "__PW__SuppGun", userId: game.user.id });
      await sleep(250);
      check(`${T2} PREVIEW: arming puts the readout on screen`, !!document.querySelector(".cp-supp-preview-readout"), null);
      if (path.native) check("NATIVE PREVIEW: arming opened core's own placement context", !!canvas.regions._placementContext, null);
      const msgsBeforeEsc = new Set(game.messages.contents.map(m => m.id));
      const regionsBeforeEsc = new Set(scene.regions.map(rg => rg.id));
      // ⚠ `code` AS WELL AS `key`: our own legacy listener reads `ev.key`, but core's KeyboardManager —
      // which is what dismisses a native placement — builds its binding context from `ev.code`. A
      // synthetic event carrying only `key` dismisses the legacy preview and is invisible to core.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      await sleep(700);
      await Promise.race([escArm.catch(() => {}), sleep(4000)]);
      check(`${T2} PREVIEW: ESC removes the readout div`, !document.querySelector(".cp-supp-preview-readout"), null);
      if (path.native) check("NATIVE PREVIEW: ESC also closed core's placement context (no orphaned preview on the layer)",
        !canvas.regions._placementContext, null);
      check(`${T2} PREVIEW: a dismissed placement plants nothing and posts nothing`,
        scene.regions.filter(rg => !regionsBeforeEsc.has(rg.id)).length === 0
          && game.messages.contents.filter(m => !msgsBeforeEsc.has(m.id)).length === 0,
        { regions: scene.regions.filter(rg => !regionsBeforeEsc.has(rg.id)).length, msgs: game.messages.contents.filter(m => !msgsBeforeEsc.has(m.id)).length });
    }
    PV._setNativePlacement(null);
  } catch (e) {
    check("no exception during the run", false, String(e?.stack ?? e?.message ?? e));
  } finally {
    try { PV.cancelSuppressivePreview(); } catch { /* ignore */ }
    // Hand the placement-path probe back to the real API — a seam left armed would make every later
    // suite on this client run a path no user is on.
    try { PV._setNativePlacement(null); } catch { /* ignore */ }
    try { FX._setHitSoundSink(null); } catch { /* ignore */ }
    try { if (settingTouched) await game.settings.set(SCOPE, "suppressiveFireSaves", prevSetting); } catch { /* ignore */ }
    try { if (fxSettingTouched) await game.settings.set(SCOPE, "combatFxEnabled", fxPrevSetting); } catch { /* ignore */ }
    if (combat) await combat.delete().catch(() => {});
    const sc = canvas?.scene;
    if (sc) { for (const id of [...new Set(madeRegions)]) await sc.deleteEmbeddedDocuments("Region", [id]).catch(() => {}); }
    if (otherScene) await otherScene.delete().catch(() => {});
    // ⚠ THE FIGURES GO BEFORE THEIR ACTORS, and that ordering is the fix for real debris: deleting the
    // actor alone leaves its TOKENS on the scene with nothing behind them, and an actor-less figure is
    // the shape that makes a later suite read `Cannot read properties of undefined (reading 'center')`.
    // Fifty-three of them were swept off this rig on 2026-08-27, laid down by earlier runs of this file.
    if (sc) { const ids = sc.tokens.filter(t => t.name?.startsWith("__PW__Supp")).map(t => t.id); if (ids.length) await sc.deleteEmbeddedDocuments("Token", ids).catch(() => {}); }
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
