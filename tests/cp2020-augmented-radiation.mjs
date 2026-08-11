/** Deep Space radiation DOSE subsystem (user chose Option B, 2026-07-11): a cumulative rad dose reduced
 *  by an RSP suit, feeding the confirmed Radiation Effects Table. Asserts the deterministic core: the pure
 *  table/band helpers, RSP subtraction, the BOOK-LOOKUP band model (only the band the dose LANDS in applies
 *  — never a cumulative stack — while separate incidents accumulate), the prepareData stat overlay, the
 *  round tick, death-check-never-auto-kills, and a radiation-zone tick dosing a token standing inside a
 *  native Region that carries the module's Radiation Zone behavior. Runs on :30004 (1.1.1 + module).
 *  Mirrors the drug/gas keepers. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [], warns = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); else if (m.type() === "warning") warns.push(m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = {};
  const RAD = await import("/modules/cp2020-augmented/module/radiation/radiation.js");
  const ZONE = await import("/modules/cp2020-augmented/module/radiation/radiation-zones.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const LOCS = ["Head", "Torso", "lArm", "rArm", "lLeg", "rLeg"];
  const covAllFalse = Object.fromEntries(LOCS.map(k => [k, false]));
  const radsuit = (sp) => ({ name: "__PW__Radsuit", type: "armor",
    system: { equipped: true, armorType: "", coverage: covAllFalse, mechTypedSP: { type: "radiation", sp } } });

  // Marker helpers (radState markers: { statBoosts:[{stat,mod}], turnsLeft, seq })
  const markers = (a) => RAD.radMarkersFor(a);
  const permSum = (a, stat) => markers(a).filter(m => (Number(m.turnsLeft)||0) <= 0)
    .flatMap(m => m.statBoosts||[]).filter(sb => sb.stat === stat).reduce((s, sb) => s + (Number(sb.mod)||0), 0);
  const timedFor = (a, stat) => markers(a).filter(m => (Number(m.turnsLeft)||0) > 0)
    .flatMap(m => m.statBoosts||[]).filter(sb => sb.stat === stat).reduce((s, sb) => s + (Number(sb.mod)||0), 0);

  // No radiationEnabled world setting: the dose engine runs whenever a dose is applied. Nothing to toggle.
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Rad"))) await a.delete().catch(() => {});

  try {
    // ── (0) PURE: table + band helpers ────────────────────────────────────────
    const E = RAD.RAD_EFFECTS;
    const band = (min) => E.find(x => x.min === min);
    out.pure = {
      len: E.length,                                   // 10
      band401Att: band(401)?.perm?.att,                // +1 (the book quirk)
      band301Att: band(301)?.perm?.att,                // -2
      band101DeathBtm: band(101)?.deathBtm,            // true
      band751DeathBtm: band(751)?.deathBtm,            // false
      bandFor0: RAD.bandForDose(0).min,                // 0
      bandFor150: RAD.bandForDose(150).min,            // 101
      bandFor600: RAD.bandForDose(600).min,            // 501
      bandFor9000: RAD.bandForDose(9000).min,          // 5001
      // tick: 2→1 survives, 1→0 expires, 0 (untimed) survives
      tick: (() => { const t = RAD.tickRadMarkers([{ turnsLeft: 2 }, { turnsLeft: 1 }, { turnsLeft: 0 }]);
        return { surviving: t.surviving.length, expired: t.expired.length }; })(),
    };

    // ── (1) actorRSP: MAX of equipped radiation-typed suits ───────────────────
    const suited = await Actor.create({ name: "__PW__RadSuited", type: "character" });
    await suited.createEmbeddedDocuments("Item", [radsuit(6)]);
    out.rspOne = RAD.actorRSP(suited);                 // 6
    await suited.createEmbeddedDocuments("Item", [radsuit(8)]);
    out.rspMax = RAD.actorRSP(suited);                 // 8 (max, not sum)

    // ── (2) RSP subtraction on a per-turn dose (suit RSP 6) ───────────────────
    // reset to a single RSP-6 suit for a clean 10−6 = 4
    await suited.deleteEmbeddedDocuments("Item", suited.items.map(i => i.id));
    await suited.createEmbeddedDocuments("Item", [radsuit(6)]);
    await RAD.applyRadiationDose(suited, 10, { perTurn: true, announce: false });
    out.rspNet4 = RAD.actorExposure(suited);           // 4 (10 − RSP 6)
    await RAD.applyRadiationDose(suited, 4, { perTurn: true, announce: false });
    out.rspAbsorbed = RAD.actorExposure(suited);       // still 4 (4 − 6 → net 0)

    // ── (3) BOOK-LOOKUP single band: a 450-rad dose applies ONLY band 401's row ─
    const a = await Actor.create({ name: "__PW__RadBookLookup", type: "character" });
    a.prepareData();
    const baseBt = Number(a.system.stats.bt.total) || 0;
    const baseAttr = Number(a.system.stats.attr.total) || 0;
    const baseRef = Number(a.system.stats.ref.total) || 0;
    await RAD.applyRadiationDose(a, 450, { perTurn: false, announce: false });   // 100% gate at 401 → stats always apply
    a.prepareData();
    out.single = {
      exposure: RAD.actorExposure(a),                  // 450
      bandCrossed: RAD.actorBandCrossed(a),            // 401
      permBt: permSum(a, "bt"),                         // -1 (band 401 perm BODY -1)
      permAttr: permSum(a, "attr"),                     // +1 (the ATT +1 quirk)
      permRef: permSum(a, "ref"),                       // 0 (band 401 has no REF; band 301's -1 must NOT appear)
      timedBt: timedFor(a, "bt"),                       // -1 (temp BODY -1, still timed)
      overlayBt: (Number(a.system.stats.bt.total) || 0) - baseBt,     // -2 (temp -1 + perm -1)
      overlayAttr: (Number(a.system.stats.attr.total) || 0) - baseAttr, // +1
      overlayRef: (Number(a.system.stats.ref.total) || 0) - baseRef,  // 0 (no REF at band 401)
      damageApplied: (Number(a.system.damage) || 0) > 0,               // band 401 damage 1D6 → HP
    };

    // ── (4) Cross-incident accumulation: clear, then a NEW incident to band 501 ─
    await RAD.clearExposure(a);
    await RAD.applyRadiationDose(a, 600, { perTurn: false, announce: false });   // band 501: BODY-1, REF-1
    out.cross = {
      exposure: RAD.actorExposure(a),                  // 600
      permBt: permSum(a, "bt"),                         // -2 (incident1 -1 + incident2 -1 — ACCUMULATE)
      permAttr: permSum(a, "attr"),                     // +1 (kept from incident1)
      permRef: permSum(a, "ref"),                       // -1 (new from incident2)
    };

    // ── (5) round tick counts a timed marker down ─────────────────────────────
    const before = markers(a).filter(m => (Number(m.turnsLeft) || 0) > 0).map(m => m.turnsLeft);
    await RAD.runRadiationTickOnce({ combatant: { actor: a } });
    const after = markers(a).filter(m => (Number(m.turnsLeft) || 0) > 0).map(m => m.turnsLeft);
    out.tick = { beforeMax: Math.max(0, ...before), afterMax: Math.max(0, ...after), decremented: Math.max(0, ...after) < Math.max(0, ...before) };

    // ── (6) cure removes permanent markers ────────────────────────────────────
    await RAD.cureRadiation(a, { perm: true });
    out.cured = { permBtAfter: permSum(a, "bt") };     // 0 (untimed markers removed)

    // ── (7) death check NEVER auto-kills (even at 100%) ───────────────────────
    const dcActor = await Actor.create({ name: "__PW__RadDeath", type: "character" });
    const dmgBefore = Number(dcActor.system.damage) || 0;
    await RAD.executeRadiationDeathCheck({ actorId: dcActor.id, tokenId: "", sceneId: "",
      check: { deathPct: 100, deathBtm: false, deathOver: "x" } });
    await sleep(150);
    out.death = {
      notDead: !dcActor.statuses?.has?.("dead"),        // no auto-kill
      hpUnchanged: (Number(dcActor.system.damage) || 0) === dmgBefore,  // the check applies no HP
    };

    // ── (8) ZONE tick doses a token inside a native Region carrying the behavior ───
    // A zone IS a native Foundry Region carrying the module's "Radiation Zone" RegionBehavior
    // (radiation-zone-behavior.js) — the GM draws it with Foundry's own region tools, so the module has
    // no placement call and no `isRadZone` flag on a current zone. This leg therefore drives the shipped
    // mechanism: create the region, add the behavior, tick, and read the dose back as a VALUE. The
    // formula is the flat "8" (no dice) and the victim wears no suit, so the round's dose is exactly 8.
    const prevActiveSceneId = game.scenes.active?.id ?? null;
    let zoneScene = null, zoneActor = null;
    try {
      const T = "cp2020-augmented.radiationZone";
      out.behaviorTypeRegistered = typeof CONFIG.RegionBehavior?.dataModels?.[T] === "function";
      zoneScene = game.scenes.find(s => s.name === "__PW__RadScene")
        ?? await Scene.create({ name: "__PW__RadScene", width: 2000, height: 2000, grid: { size: 100 } });
      // The tick reads `canvas.scene`, and `region.tokens` is canvas-maintained, so the probe scene has
      // to be the drawn one for the round to see anything.
      await zoneScene.activate();
      for (let i = 0; i < 40 && !(canvas?.ready && canvas.scene?.id === zoneScene.id); i++) await sleep(150);
      zoneActor = await Actor.create({ name: "__PW__RadZoneVictim", type: "character" });
      await zoneScene.createEmbeddedDocuments("Token", [{ name: "__PW__RZ", x: 500, y: 500, actorId: zoneActor.id, actorLink: true, width: 1, height: 1 }]);
      // Region first, behavior second — the real GM gesture (draw a region, then add a behavior to it).
      const [region] = await zoneScene.createEmbeddedDocuments("Region", [{
        name: "__PW__RadRegion",
        shapes: [{ type: "rectangle", x: 300, y: 300, width: 600, height: 600, hole: false, rotation: 0 }],
      }]);
      await region.createEmbeddedDocuments("RegionBehavior", [{
        name: "Radiation Zone", type: T, system: { radsFormula: "8", sourceLabel: "Reactor" },
      }]);
      out.zoneBehaviorAttached = !!region.behaviors?.some(x => x.type === T && !x.disabled);
      for (let i = 0; i < 25 && !(region.tokens?.size); i++) await sleep(150);
      out.zoneTokensInside = region.tokens?.size ?? 0;
      const expBefore = RAD.actorExposure(zoneActor);
      await ZONE.runRadZoneTick({ round: 1 });
      await sleep(400);
      out.zoneDoseDelta = RAD.actorExposure(zoneActor) - expBefore;   // exactly 8
    } catch (e) { out.zoneErr = String(e?.message || e); }
    finally {
      // Restore the rig's own active scene BEFORE removing the probe scene. A leg that throws part-way
      // used to leave the probe scene ACTIVE and its victim actor behind — an unset/foreign active scene
      // is the documented cause of ~10 sibling keepers failing for no code reason.
      await zoneActor?.delete().catch(() => {});
      const prev = prevActiveSceneId ? game.scenes.get(prevActiveSceneId) : null;
      if (prev && prev.id !== zoneScene?.id) await prev.activate().catch(() => {});
      await zoneScene?.delete().catch(() => {});
      out.activeSceneRestored = game.scenes.active?.id === prevActiveSceneId;
    }

    // cleanup
    for (const act of [suited, a, dcActor]) await act.delete().catch(() => {});
  } catch (e) {
    out.THROWN = String(e?.stack || e);
  }
  return out;
});

const checks = {
  no_throw: !r.THROWN,
  // pure
  pure_tableLen10: r.pure?.len === 10,
  pure_att401plus1: r.pure?.band401Att === 1,
  pure_att301minus2: r.pure?.band301Att === -2,
  pure_deathBtmFlags: r.pure?.band101DeathBtm === true && r.pure?.band751DeathBtm === false,
  pure_bandForDose: r.pure?.bandFor0 === 0 && r.pure?.bandFor150 === 101 && r.pure?.bandFor600 === 501 && r.pure?.bandFor9000 === 5001,
  pure_tick: r.pure?.tick?.surviving === 2 && r.pure?.tick?.expired === 1,
  // RSP
  rsp_one6: r.rspOne === 6,
  rsp_max8: r.rspMax === 8,
  rsp_net4: r.rspNet4 === 4,
  rsp_absorbed: r.rspAbsorbed === 4,
  // book-lookup single band
  single_exposure450: r.single?.exposure === 450,
  single_band401: r.single?.bandCrossed === 401,
  single_permBt: r.single?.permBt === -1,
  single_permAttrPlus1: r.single?.permAttr === 1,
  single_noRefLeak: r.single?.permRef === 0,          // band 301's REF-1 must NOT leak in (proves single-band)
  single_overlayBt: r.single?.overlayBt === -2,
  single_overlayAttr: r.single?.overlayAttr === 1,
  single_overlayNoRef: r.single?.overlayRef === 0,
  single_damageApplied: r.single?.damageApplied === true,
  // cross-incident accumulation
  cross_exposure600: r.cross?.exposure === 600,
  cross_btAccumulates: r.cross?.permBt === -2,        // BODY -1 from BOTH incidents
  cross_attrKept: r.cross?.permAttr === 1,
  cross_refNew: r.cross?.permRef === -1,
  // tick + cure + death
  tick_decremented: r.tick?.decremented === true,
  cure_removedPerm: r.cured?.permBtAfter === 0,
  death_notDead: r.death?.notDead === true && r.death?.hpUnchanged === true,
  // zone (native Region + Radiation Zone behavior)
  zone_noError: !r.zoneErr,
  zone_behaviorTypeRegistered: r.behaviorTypeRegistered === true,
  zone_behaviorAttached: r.zoneBehaviorAttached === true,
  zone_regionReportsToken: r.zoneTokensInside >= 1,
  zone_dosedExactly8: r.zoneDoseDelta === 8,
  zone_activeSceneRestored: r.activeSceneRestored === true,
  // hygiene
  wrapNeverThrew: !warns.some(w => /radiation stat loss failed/.test(w)),
  noConsoleErrors: errors.length === 0,
};
console.log(JSON.stringify({ r, checks, errors, warns: warns.slice(0, 4) }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? "RADIATION KEEPER PASS" : "RADIATION KEEPER FAIL");
await b.close();
process.exit(pass ? 0 : 1);
