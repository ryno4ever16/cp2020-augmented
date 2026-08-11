/** Full-conversion borg (FBC) whole-body SDP (Chromebook 2 p.63-65). A full borg's whole body is
 *  machinery: EVERY zone (incl. Head+Torso) absorbs into its own SDP instead of the wound track — no
 *  BTM/stun/death-save/flesh-limb-loss. Destroying the Head (brain) or Torso (biosystem) KILLS the
 *  borg; a limb just goes useless. SDP is seeded from the body item's `borgBody` flag in prepareData.
 *  Builds on the cyberlimb pass. Runs on :30004 (official 1.1.1 + module). */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = {};
  const BG = await import("/modules/cp2020-augmented/module/mech/borg.js");
  const CL = await import("/modules/cp2020-augmented/module/mech/cyberlimb.js");
  const DA = await import("/modules/cp2020-augmented/module/combat/DamageApplicator.js");
  const U  = await import("/modules/cp2020-augmented/module/utils.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const ZONES = ["Head","Torso","lArm","rArm","lLeg","rLeg"];

  // ── (0) PURE detection/routing (no actor) ──────────────────────────────────
  const flagged = (v) => ({ getFlag: () => v, flags: {} });
  out.pure = {
    flagOn: BG.isFullBorg(flagged(true)),           // explicit true
    flagOff: BG.isFullBorg(flagged(false)),         // explicit false override
    coreZones: [...BG.BORG_CORE_ZONES].sort().join(","),   // "Head,Torso"
  };

  // ── (1) build a standard borg (Alpha-class profile: SP25, Head/limbs 30, Torso 40) ──────────
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Borg"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__BorgPunk", type: "character" });
  await actor.update({ "system.damage": 0, "system.stats.bt.value": 5 });
  await actor.createEmbeddedDocuments("Item", [{
    name: "__PW__AlphaBody", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent" },
    flags: { "cp2020-augmented": { borgBody: {
      sp:  { Head:25, Torso:25, lArm:25, rArm:25, lLeg:25, rLeg:25 },
      sdp: { Head:30, Torso:40, lArm:30, rArm:30, lLeg:30, rLeg:30 }
    } } }
  }]);
  // poll for prepareData to seed the borg SDP into system.sdp.sum
  for (let i = 0; i < 25 && (Number(actor.system?.sdp?.sum?.Torso) || 0) !== 40; i++) await sleep(200);

  const sum = (z) => Number(actor.system?.sdp?.sum?.[z]) || 0;
  const cur = (z) => Number(actor.system?.sdp?.current?.[z]);
  const dmg = () => Number(actor.system?.damage) || 0;
  const dead = () => actor.statuses?.has?.("dead") === true;
  const limbStatus = () => actor.getFlag("cp2020-augmented", "limbStatus") ?? {};

  out.detect = { isFullBorg: BG.isFullBorg(actor), hasBody: !!BG.borgBodyOf(actor) };
  out.seed = {
    sums: ZONES.map(sum).join(","),                       // 30,40,30,30,30,30
    currentsFull: ZONES.every(z => cur(z) === sum(z)),    // fresh borg = full
    routesAllZones: ZONES.every(z => CL.routesToSdp(actor, z) === true),   // incl. Head+Torso
  };

  const hit = (location, amount) => DA.applyAreaDamages({
    target: actor, areaDamages: { [location]: [{ damage: amount }] },
    ap: false, armorMode: DA.ARMOR_MODES.NONE, ablate: false, dryRun: false
  });

  // (2) Torso hit → Torso SDP down, wound track untouched, not dead.
  await hit("Torso", 10); await sleep(500);
  out.torsoHit = { cur: cur("Torso"), wound: dmg(), dead: dead() };   // cur 30, wound 0, alive

  // (3) Head hit > 8 (would be a flesh AUTO-DEATH) but Head SDP 30 → SDP down, NOT dead.
  await hit("Head", 15); await sleep(500);
  out.headHit = { cur: cur("Head"), wound: dmg(), dead: dead() };     // cur 15, wound 0, alive

  // (4) Destroy an ARM → useless/destroyed but the borg is NOT dead (a limb ≠ core).
  await hit("rArm", 40); await sleep(600);
  out.limbDestroyed = { status: limbStatus().rArm, dead: dead(), wound: dmg() };  // destroyed, alive, wound 0

  // (5) Destroy the TORSO (biosystem) → borg DEAD, no wound-track overflow.
  const msgBefore = game.messages.size;
  const woundBefore = dmg();
  await hit("Torso", 40); await sleep(700);                          // 30 remaining - 40 → 0
  // Scope the death-save scan to THIS fixture's speaker so a stray card (e.g. a leftover combat's) can't
  // masquerade as a flesh death save on the borg.
  const newMsgs = game.messages.contents.slice(msgBefore).filter(m => m.speaker?.actor === actor.id).map(m => m.content || "");
  out.coreDeath = {
    status: limbStatus().Torso,                                     // "destroyed"
    dead: dead(),                                                   // true
    noOverflow: dmg() === woundBefore,                             // wound track NOT advanced
    noFleshDeathSave: !newMsgs.some(c => /cp-death-save-roll|Death Save/.test(c)),
  };

  // (6) Repair a core zone (Torso) → SDP restored, flag cleared, still routes to SDP.
  await CL.repairCyberlimb(actor, "Torso"); await sleep(500);
  out.repair = { cur: cur("Torso"), flag: limbStatus().Torso ?? null, routes: CL.routesToSdp(actor, "Torso") };

  // (7) Sheet: a borg's Head/Torso rows carry the SDP row + repair badge/button (six-zone status).
  const sheet = CL.cyberlimbSheetStatus(actor);
  out.sheetStatus = { hasHead: !!sheet.Head, hasTorso: !!sheet.Torso, headDamaged: sheet.Head?.status === "damaged", armDestroyed: sheet.rArm?.status };
  await actor.sheet.render(true); await sleep(900);
  const root = actor.sheet.element;
  out.sheetUI = {
    // Head is still damaged (15/30 from step 3) — proves a CORE zone shows the repair UI. (The Torso
    // was just repaired in step 6, so it correctly has no button.)
    headRepairBtn: !!root?.querySelector('.cp-cyberlimb-repair[data-zone="Head"]'),
    armBadge: !!root?.querySelector('.segment-limb-status.cp-limb-destroyed'),
  };
  await actor.sheet.close().catch(() => {});

  // (8) FLESH CONTROL: a non-borg character's torso hit still advances the wound track (regression).
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__BorgFlesh"))) await a.delete().catch(() => {});
  const flesh = await Actor.create({ name: "__PW__BorgFleshPunk", type: "character" });
  await flesh.update({ "system.damage": 0, "system.stats.bt.value": 5 });
  const fw0 = Number(flesh.system?.damage) || 0;
  await DA.applyAreaDamages({ target: flesh, areaDamages: { Torso: [{ damage: 8 }] }, ap: false, armorMode: DA.ARMOR_MODES.NONE, ablate: false, dryRun: false });
  await sleep(500);
  out.fleshControl = { woundAdvanced: (Number(flesh.system?.damage) || 0) > fw0, notBorg: BG.isFullBorg(flesh) };

  // ── (9) INTRINSIC CHASSIS SP: the borg's built-in SP reduces incoming damage BEFORE the SDP soak ──
  // (Chr2 p.64 — a full borg is whole-body armour SP 25.) The steps above used ARMOR_MODES.NONE to
  // isolate SDP routing; here we use FULL so the folded chassis SP actually applies.
  out.combinePure = { c2925: U.combineArmorSP(20, 25), c025: U.combineArmorSP(0, 25), c2525: U.combineArmorSP(25, 25) };  // 29, 25, 30
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__BorgSP"))) await a.delete().catch(() => {});
  const bsp = await Actor.create({ name: "__PW__BorgSPPunk", type: "character" });
  await bsp.update({ "system.damage": 0, "system.stats.bt.value": 5 });
  await bsp.createEmbeddedDocuments("Item", [{
    name: "__PW__SPBody", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent" },
    flags: { "cp2020-augmented": { borgBody: {
      sp:  { Head:25, Torso:25, lArm:25, rArm:25, lLeg:25, rLeg:25 },
      sdp: { Head:30, Torso:40, lArm:30, rArm:30, lLeg:30, rLeg:30 }
    } } }
  }]);
  for (let i = 0; i < 25 && (Number(bsp.system?.sdp?.sum?.Torso) || 0) !== 40; i++) await sleep(200);
  const spCur = (z) => Number(bsp.system?.sdp?.current?.[z]);
  const spHit = (loc, amt, ap = false) => DA.applyAreaDamages({
    target: bsp, areaDamages: { [loc]: [{ damage: amt }] },
    ap, armorMode: DA.ARMOR_MODES.FULL, ablate: false, dryRun: false
  });

  // (9a) chassis SP surfaces on the derived per-zone armour SP (no worn armour → just the chassis 25).
  out.spDerived = {
    hitLoc: Number(bsp.system?.hitLocations?.Torso?.stoppingPower) || 0,   // 25
    effective: DA.effectiveArmorSP(bsp, "Torso"),                          // 25
  };
  // (9b) a hit at/under the chassis SP is shrugged off — no SDP loss (borg toughness). 20 ≤ 25.
  await spHit("Torso", 20); await sleep(500);
  out.spStopped = { cur: spCur("Torso") };   // still 40
  // (9c) a hit OVER the chassis SP: only the penetrating remainder reaches SDP. 30 − 25 = 5 → 40→35.
  await spHit("Torso", 30); await sleep(500);
  out.spPenetrate = { cur: spCur("Torso") };  // 35
  // (9d) AP halves the chassis SP (floor(25/2)=12): raw 30 → 18 through → 35 − 18 = 17.
  await spHit("Torso", 30, true); await sleep(500);
  out.spAP = { cur: spCur("Torso") };  // 17
  // (9e) chassis SP COMBINES proportionally with worn armour (not a flat max): SP20 head layer + 25.
  await bsp.createEmbeddedDocuments("Item", [{
    name: "__PW__Helmet", type: "armor",
    system: { equipped: true, coverage: { Head: { stoppingPower: 20 } } }
  }]);
  for (let i = 0; i < 20 && (Number(bsp.system?.hitLocations?.Head?.stoppingPower) || 0) === 25; i++) await sleep(200);
  out.spCombine = { head: Number(bsp.system?.hitLocations?.Head?.stoppingPower) || 0 };  // combineArmorSP(20,25)=29
  await bsp.delete().catch(() => {});

  // ── (10) FBC STATS: chassis REF/MA/BODY are SET onto the totals; movement/body dependents re-derived ──
  const fakeStats = { system: { stats: { ref: { total: 5 }, ma: { total: 8 }, bt: { total: 6 } } } };
  BG.applyBorgStats(fakeStats, { ref: 15, ma: 25, body: 20 });
  out.statsPure = {
    ref: fakeStats.system.stats.ref.total, ma: fakeStats.system.stats.ma.total, bt: fakeStats.system.stats.bt.total,
    run: fakeStats.system.stats.ma.run, leap: fakeStats.system.stats.ma.leap,
    carry: fakeStats.system.stats.bt.carry, lift: fakeStats.system.stats.bt.lift, btm: fakeStats.system.stats.bt.modifier,
  };
  const fake2 = { system: { stats: { ref: { total: 7 } } } };
  BG.applyBorgStats(fake2, undefined);          // no stats block ⇒ untouched
  out.statsNoop = { ref: fake2.system.stats.ref.total };

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__BorgStat"))) await a.delete().catch(() => {});
  const bst = await Actor.create({ name: "__PW__BorgStatPunk", type: "character" });
  await bst.createEmbeddedDocuments("Item", [{
    name: "__PW__StatBody", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent" },
    flags: { "cp2020-augmented": { borgBody: {
      sp:  { Head:40, Torso:40, lArm:40, rArm:40, lLeg:40, rLeg:40 },
      sdp: { Head:50, Torso:60, lArm:50, rArm:50, lLeg:50, rLeg:50 },
      stats: { ref: 15, ma: 25, body: 20 }
    } } }
  }]);
  for (let i = 0; i < 25 && (Number(bst.system?.stats?.ref?.total) || 0) !== 15; i++) await sleep(200);
  out.statsE2E = {
    ref: Number(bst.system?.stats?.ref?.total), ma: Number(bst.system?.stats?.ma?.total), bt: Number(bst.system?.stats?.bt?.total),
    run: Number(bst.system?.stats?.ma?.run), carry: Number(bst.system?.stats?.bt?.carry), btm: Number(bst.system?.stats?.bt?.modifier),
  };
  await bst.delete().catch(() => {});

  await actor.delete().catch(() => {});
  await flesh.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["pure: isFullBorg honours explicit flag (on true / off false)", r.pure.flagOn === true && r.pure.flagOff === false],
  ["pure: core zones = Head,Torso", r.pure.coreZones === "Head,Torso"],
  ["detect: borg-body item ⇒ isFullBorg + borgBodyOf", r.detect.isFullBorg === true && r.detect.hasBody === true],
  ["seed: all six zones seeded (30,40,30,30,30,30), current full", r.seed.sums === "30,40,30,30,30,30" && r.seed.currentsFull === true],
  ["route: ALL six zones (incl. Head+Torso) route to SDP", r.seed.routesAllZones === true],
  ["torso hit reduces Torso SDP (40→30), wound track 0, alive", r.torsoHit.cur === 30 && r.torsoHit.wound === 0 && r.torsoHit.dead === false],
  ["head hit > 8 hits SDP not flesh auto-death (30→15), alive", r.headHit.cur === 15 && r.headHit.wound === 0 && r.headHit.dead === false],
  ["destroyed LIMB ⇒ useless/destroyed but borg NOT dead, no overflow", r.limbDestroyed.status === "destroyed" && r.limbDestroyed.dead === false && r.limbDestroyed.wound === 0],
  ["destroyed TORSO (biosystem) ⇒ borg DEAD", r.coreDeath.status === "destroyed" && r.coreDeath.dead === true],
  ["core destruction: no wound-track overflow + no flesh death save", r.coreDeath.noOverflow === true && r.coreDeath.noFleshDeathSave === true],
  ["repair a core zone (Torso) restores SDP, clears flag, still routes", r.repair.cur === 40 && r.repair.flag === null && r.repair.routes === true],
  ["sheet status covers Head+Torso (head damaged persists); arm destroyed", r.sheetStatus.hasHead === true && r.sheetStatus.hasTorso === true && r.sheetStatus.headDamaged === true && r.sheetStatus.armDestroyed === "destroyed"],
  ["sheet UI: a core-zone (Head) repair button + a destroyed-zone badge render", r.sheetUI.headRepairBtn === true && r.sheetUI.armBadge === true],
  ["flesh control: a non-borg torso hit still advances the wound track", r.fleshControl.woundAdvanced === true && r.fleshControl.notBorg === false],
  ["combineArmorSP p.99 proportional table (20+25=29, 0+25=25, 25+25=30)", r.combinePure.c2925 === 29 && r.combinePure.c025 === 25 && r.combinePure.c2525 === 30],
  ["intrinsic SP surfaces on the derived per-zone armour SP (chassis 25)", r.spDerived.hitLoc === 25 && r.spDerived.effective === 25],
  ["a hit at/under chassis SP (20 ≤ 25) is shrugged off — no SDP loss", r.spStopped.cur === 40],
  ["a hit over chassis SP: only the remainder reaches SDP (30−25=5 → 35)", r.spPenetrate.cur === 35],
  ["AP halves the chassis SP (12): 30→18 through → 17", r.spAP.cur === 17],
  ["chassis SP combines proportionally with worn armour (20+25 → 29)", r.spCombine.head === 29],
  ["stats pure: SET ref/ma/bt to the chassis values (15/25/20)", r.statsPure.ref === 15 && r.statsPure.ma === 25 && r.statsPure.bt === 20],
  ["stats pure: MA/BODY dependents re-derived (run 75, leap 18, carry 200, lift 800, BTM 5)", r.statsPure.run === 75 && r.statsPure.leap === 18 && r.statsPure.carry === 200 && r.statsPure.lift === 800 && r.statsPure.btm === 5],
  ["stats pure: no stats block ⇒ totals untouched", r.statsNoop.ref === 7],
  ["stats e2e: a body's stats block SETs the actor totals + dependents", r.statsE2E.ref === 15 && r.statsE2E.ma === 25 && r.statsE2E.bt === 20 && r.statsE2E.run === 75 && r.statsE2E.carry === 200 && r.statsE2E.btm === 5],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
