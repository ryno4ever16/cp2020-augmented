/**
 * KEEPER: the vehicle damage arithmetic — value legs over the pure number-producers in
 * module/vehicle/vehicle-damage.js and module/vehicle/vehicle-indirect.js, plus the two
 * derived-field readers those functions are compared against.
 *
 *   §1  Armor Value / Body Value derivation (the DataModel's derived fields)
 *   §2  Penetration ladder — Good Shot steps · extra rounds · range falloff · range immunity
 *   §3  Flank armor fractions
 *   §4  Damage-table bands + the surface-item roll
 *   §5  Hit-location table + both sub-tables
 *   §6  Severity effect table + the damage-control ignore band
 *   §7  Reactive-tile deflection band + wear
 *   §8  Core subtraction damage + the crash dice plan + the whole Weight-Modifier table
 *   §9  Bomb multiplier · dive aim bonus · fall schedule
 *   §10 The live resolver, driven with a forced die queue (the pure tables wired to real dice)
 *   §13 Where a missed shell and a missed bomb LAND, in pixels, on both axes
 *   §14 The defaulted arguments, pinned as a contract
 *
 * ── §13/§14 were added 2026-08-18 to close mutation-survivor blind spots. The mutation run
 *    (import-staging/assurance/merged-results.jsonl) left the whole landing-geometry family with no
 *    oracle at all: sign flips (aim.x + v.dx*ppm → −) and scale inversions (*ppm → /ppm) in
 *    indirectLanding/bombLanding were invisible, as were the miss-amount subtraction, the ≤0 hit
 *    boundary, and a row of defaulted initializers. This suite is FIRST in the mutant subsets for
 *    both vehicle-damage.js and vehicle-indirect.js (import-staging/assurance/suites-*.txt), so it
 *    owns the indirect legs even where pure-damage-math also touches the function.
 *
 * ── ACCEPTED EQUIVALENTS (surviving mutants that no assertion can kill, because they produce
 *    IDENTICAL output on every input). Each was proved by sweeping the mutated variant against the
 *    original over the full argument domain, not by inspection:
 *      m165 shellTravelTurns `Number(rangeM) || 0` → `|| 1` — the result is wrapped in Math.max(1, …),
 *           so a fallback of 0 and a fallback of 1 both come out as 1 turn.
 *      m208 diveBombAimBonus `Number(diveTurns) || 0` → `|| 1` — the fallback feeds `x − 1`, giving
 *           −1 or 0, and Math.max(0, …) flattens both to 0.
 *      m210 bombFallSchedule `diveSpeed = 0` → `= 1` — both are below the 175 m/turn floor, so the
 *           gate picks FLOOR either way.
 *      m213 bombFallSchedule `diveSpeed > FLOOR` → `>= FLOOR` — the two branches differ only AT 175,
 *           where the true branch yields Number(175) and the false branch yields FLOOR = 175.
 *      m011 coreCrashDamage `speed = 0` → `= 1` — floor(1/20) is 0, the same dice count.
 *      m047 mmSurfaceDamage `basePen = 0` → `= 1` — the destroy test is `>= 3`; 0 and 1 both fail it.
 *      m061 mmSubLocation `Number(d10) || 0` → `|| 1` — the facing shift is +1/0/−1, so the fallback
 *           lands on 0, 1 or 2 and every one of those reads "Cargo/Ammo" in both sub-tables.
 *      m078 damageControlIgnores `Number(d10) || 0` → `|| 1` — the test is `>= 6`; 0 and 1 both fail.
 *    The legs in §14 pin those defaults anyway: they cost nothing and a later edit that MOVES the
 *    guard (say 3+ → 1+) turns the equivalent into a killable one.
 *
 * ⛔ SOURCE DISCIPLINE. Every pinned number comes from the eye-verified Maximum Metal extract
 * (memory `maximum-metal-reference.md`, errata folded in) or the CP2020 core, NEVER from reading
 * the implementation. Citations ride in each leg's detail string:
 *   [MM p.4] [MM p.6] [MM p.9] [MM p.11] [MM p.23] [MM errata]  — Maximum Metal
 *   [Core p.112]                                                — CP2020 core vehicle damage
 * Where the extract is SILENT the leg says so and asserts nothing (see the fuel-fire note in §6).
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const info = (t) => console.log(`  INFORMATIONAL: ${t}`);
const J = (v) => JSON.stringify(v);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("console", m => { if (m.type() === "error" && !/compatibility|deprecat|screen resolution/i.test(m.text())) errors.push(m.text()); });
page.on("pageerror", e => errors.push(e.message));

await page.goto(`${URL}/join`);
await page.waitForSelector('select[name="userid"]');
await page.evaluate(() => {
  const sel = document.querySelector('select[name="userid"]');
  sel.value = [...sel.options].find(o => /gamemaster/i.test(o.textContent)).value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.fill('input[name="password"]', PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 60000 });

/* ══════════════════ phase 1 — the pure transforms, no dice needed ══════════════════ */

const r = await page.evaluate(async ({ SCOPE }) => {
  const VD = await import("/modules/cp2020-augmented/module/vehicle/vehicle-damage.js");
  const VI = await import("/modules/cp2020-augmented/module/vehicle/vehicle-indirect.js");
  const VW = await import("/modules/cp2020-augmented/module/vehicle/vehicle-weapons.js");
  const o = { exported: {}, err: null };

  // What the judgment doc names, and whether it is actually reachable from here.
  for (const n of ["coreVehicleDamage", "coreCrashDamage", "WEIGHT_MOD", "mmEffectivePenetration",
                   "mmEffectiveArmor", "mmDamageSeverity", "mmSurfaceDamage", "mmHitLocation",
                   "mmSubLocation", "MM_CRIT", "damageControlIgnores", "reactiveDeflection",
                   "acpaHitLocation", "applyVehicleDamageMM", "applyVehicleDamageCore",
                   // names a Maximum-Metal collision resolver would plausibly carry
                   "mmCrashDamage", "mmSideswipeDamage", "mmCollisionDamage", "crashPenetration"])
    o.exported[n] = typeof VD[n];
  for (const n of ["bombDirectPen", "diveBombAimBonus", "bombFallSchedule", "bombFallTurns"])
    o.exported[n] = typeof VI[n];
  for (const n of ["roundsPerHit", "goodShotSteps"]) o.exported[n] = typeof VW[n];

  try {
    /* ---------------- §1 AV / BV derivation, read off real derived data ---------------- */
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__VDM"))) await a.delete().catch(() => {});
    const mk = async (name, system) => Actor.create({ name, type: `${SCOPE}.vehicle`, system });

    const avVeh = await mk("__PW__VDM AV", {
      sp: { front: 100, side: 30, rear: 10, top: 9, bottom: 0 },
      sdp: { value: 200, max: 200 },
    });
    o.avPerFacing = { ...game.actors.get(avVeh.id).system.armorValue };
    o.bvPlain = game.actors.get(avVeh.id).system.bodyValue;

    const bvHalf = await mk("__PW__VDM BVhalf", { sdp: { value: 50, max: 50 } });
    o.bvHalfStep = game.actors.get(bvHalf.id).system.bodyValue;
    const bvSmall = await mk("__PW__VDM BVsmall", { sdp: { value: 9, max: 9 } });
    o.bvBelowStep = game.actors.get(bvSmall.id).system.bodyValue;

    // ACPA reads Chassis STR as its SDP source — sdp.max is present and must be IGNORED.
    const acpa = await mk("__PW__VDM ACPA", { isACPA: true, str: 40, sdp: { value: 200, max: 200 } });
    o.bvAcpaFromStr = game.actors.get(acpa.id).system.bodyValue;
    // …and the same numbers on a non-ACPA read sdp.max, ignoring str.
    const plainWithStr = await mk("__PW__VDM PlainStr", { isACPA: false, str: 40, sdp: { value: 200, max: 200 } });
    o.bvPlainIgnoresStr = game.actors.get(plainWithStr.id).system.bodyValue;

    /* ---------------- §2 penetration ladder ---------------- */
    const P = (args) => VD.mmEffectivePenetration(args);
    o.pen = {
      flat:        P({ basePen: 20 }),
      goodShot1:   P({ basePen: 20, goodShotSteps: 1 }),
      goodShot2:   P({ basePen: 20, goodShotSteps: 2 }),
      goodShot3:   P({ basePen: 20, goodShotSteps: 3 }),
      goodShotNeg: P({ basePen: 20, goodShotSteps: -4 }),
      rof30:       P({ basePen: 20, extraRounds: VW.roundsPerHit(30) - 1 }),
      rof100:      P({ basePen: 20, extraRounds: VW.roundsPerHit(100) - 1 }),
      rof10:       P({ basePen: 20, extraRounds: VW.roundsPerHit(10) - 1 }),
      long:        P({ basePen: 20, range: "long" }),
      extreme:     P({ basePen: 20, range: "extreme" }),
      normal:      P({ basePen: 20, range: "normal" }),
      heLong:      P({ basePen: 20, range: "long", hefPenetrator: true }),
      heExtreme:   P({ basePen: 20, range: "extreme", hefPenetrator: true }),
      hdapExtreme: P({ basePen: 20, range: "extreme", highDensityAP: true }),
      stacked:     P({ basePen: 16, goodShotSteps: 1, extraRounds: 4, range: "long" }),
      zero:        P({ basePen: 0, goodShotSteps: 3, extraRounds: 9 }),
      defaults:    P(),
    };
    o.steps = {
      cleared10: VW.goodShotSteps(35, 25), cleared20: VW.goodShotSteps(45, 25),
      cleared9: VW.goodShotSteps(34, 25), exact: VW.goodShotSteps(25, 25), missed: VW.goodShotSteps(24, 25),
    };
    o.rounds = { rof30: VW.roundsPerHit(30), rof100: VW.roundsPerHit(100), rof10: VW.roundsPerHit(10), rof1: VW.roundsPerHit(1) };

    /* ---------------- §3 flank armor ---------------- */
    const A = (av, f) => VD.mmEffectiveArmor(av, f);
    o.flank = {
      even: { front: A(10, "front"), side: A(10, "side"), top: A(10, "top"), rear: A(10, "rear"), back: A(10, "back"), bottom: A(10, "bottom") },
      odd:  { front: A(7, "front"),  side: A(7, "side"),  top: A(7, "top"),  rear: A(7, "rear"),  bottom: A(7, "bottom") },
      one:  { side: A(1, "side"), rear: A(1, "rear") },
      zero: { side: A(0, "side"), rear: A(0, "rear"), front: A(0, "front") },
      unknownFacing: A(10, "not-a-facing"),
      defaultFacing: A(10),
    };

    /* ---------------- §4 damage table + surface ---------------- */
    const S = (pen, eav, bv, d10) => VD.mmDamageSeverity({ pen, effectiveArmorValue: eav, bodyValue: bv, d10 });
    o.sev = {
      under:    S(5, 10, 0, 10),
      atZero:   S(10, 10, 0, 1),
      band1:    S(10, 10, 0, 1).severity,
      band5:    S(10, 10, 0, 5).severity,
      band6:    S(10, 10, 0, 6).severity,
      band9:    S(10, 10, 0, 9).severity,
      band10:   S(10, 10, 0, 10).severity,
      surface0: S(10, 10, 5, 5),
      surfaceNeg: S(10, 10, 5, 4),
      justMinor:  S(10, 10, 5, 6),
      bigDiff:  S(30, 10, 5, 1),
    };
    o.surf = {
      d6: VD.mmSurfaceDamage(6, 5), d7: VD.mmSurfaceDamage(7, 5), d10: VD.mmSurfaceDamage(10, 5),
      pen3: VD.mmSurfaceDamage(9, 3), pen2: VD.mmSurfaceDamage(9, 2), pen0: VD.mmSurfaceDamage(9, 0),
    };

    /* ---------------- §5 hit location ---------------- */
    const L = (d, f) => VD.mmHitLocation(d, f);
    o.loc = {
      front:  [1, 2, 3, 4, 7, 8, 10].map(d => L(d, "front")),
      top:    [1, 2, 6, 8].map(d => L(d, "top")),
      side:   [1, 2, 5, 8, 9].map(d => L(d, "side")),
      rear:   [1, 2, 3, 6, 10].map(d => L(d, "rear")),
      bottom: [1, 2, 3, 6, 10].map(d => L(d, "bottom")),
      back:   [1, 2, 3].map(d => L(d, "back")),
    };
    const SL = (d, t, f) => VD.mmSubLocation(d, t, f);
    o.sub = {
      hullFront:  [1, 2, 3, 4, 6, 7, 8, 9, 10].map(d => SL(d, "Hull", "front")),
      hullRear:   [1, 3, 4, 5, 6, 9, 10].map(d => SL(d, "Hull", "rear")),
      hullSide:   [2, 3, 5, 8, 9, 10].map(d => SL(d, "Hull", "side")),
      turretFront:[1, 2, 6, 7, 8, 10].map(d => SL(d, "Turret", "front")),
      turretRear: [3, 4, 9, 10].map(d => SL(d, "Turret", "rear")),
    };

    /* ---------------- §6 crit table + damage control ---------------- */
    o.crit = JSON.parse(JSON.stringify(VD.MM_CRIT));
    o.dc = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(d => VD.damageControlIgnores(d));

    /* ---------------- §7 reactive tiles ---------------- */
    const R = (args) => VD.reactiveDeflection(args);
    o.reactive = {
      fresh1:  R({ installed: true, heat: true, priorHits: 0, d10: 1 }),
      fresh2:  R({ installed: true, heat: true, priorHits: 0, d10: 2 }),
      fresh10: R({ installed: true, heat: true, priorHits: 0, d10: 10 }),
      worn1_d2: R({ installed: true, heat: true, priorHits: 1, d10: 2 }),
      worn2_d2: R({ installed: true, heat: true, priorHits: 2, d10: 2 }),
      worn2_d3: R({ installed: true, heat: true, priorHits: 2, d10: 3 }),
      worn4_d3: R({ installed: true, heat: true, priorHits: 4, d10: 3 }),
      worn4_d4: R({ installed: true, heat: true, priorHits: 4, d10: 4 }),
      hiExOnly: R({ installed: true, hiEx: true, priorHits: 3, d10: 10 }),
      notInstalled: R({ installed: false, heat: true, priorHits: 0, d10: 10 }),
      plainRound:  R({ installed: true, priorHits: 3, d10: 10 }),
    };

    /* ---------------- §8 core damage + crash ---------------- */
    o.core = {
      partial:   VD.coreVehicleDamage({ rawDamage: 30, sp: 10, currentSDP: 50 }),
      apHalves:  VD.coreVehicleDamage({ rawDamage: 30, sp: 11, currentSDP: 50, ap: true }),
      stopped:   VD.coreVehicleDamage({ rawDamage: 5, sp: 10, currentSDP: 50 }),
      exact:     VD.coreVehicleDamage({ rawDamage: 60, sp: 10, currentSDP: 50 }),
      over:      VD.coreVehicleDamage({ rawDamage: 100, sp: 10, currentSDP: 50 }),
    };
    o.weightMod = { ...VD.WEIGHT_MOD };
    o.crash = {
      dice60:  VD.coreCrashDamage({ speed: 60, weightClass: "heavy" }),
      dice19:  VD.coreCrashDamage({ speed: 19, weightClass: "light" }),
      dice100: VD.coreCrashDamage({ speed: 100, weightClass: "vheavy" }),
      heavyRolled:  VD.coreCrashDamage({ speed: 60, weightClass: "heavy", rolled: 10 }),
      vlightRolled: VD.coreCrashDamage({ speed: 60, weightClass: "vlight", rolled: 7 }),
      unknownClass: VD.coreCrashDamage({ speed: 60, weightClass: "not-a-class", rolled: 10 }),
    };

    /* ---------------- §9 bombs ---------------- */
    o.bomb = {
      x5: [0, 4, 7].map(p => VI.bombDirectPen(p)),
      immunePenThenX5: VI.bombDirectPen(P({ basePen: 4, range: "extreme", hefPenetrator: true })),
      fallsOffThenX5:  VI.bombDirectPen(P({ basePen: 4, range: "extreme" })),
      aim: [0, 1, 2, 3, 4, 5, 10].map(t => VI.diveBombAimBonus(t)),
      fall700: VI.bombFallSchedule(700),
      fall175: VI.bombFallSchedule(175),
      fall100: VI.bombFallSchedule(100),
      fall350: VI.bombFallSchedule(350),
      turns700: VI.bombFallTurns(700),
      dive1000at600: VI.bombFallSchedule(1000, { diveSpeed: 600 }),
      diveBelowFloor: VI.bombFallSchedule(1000, { diveSpeed: 100 }),
    };

    /* ------ §11 the burst multiplier applies ONCE, and only where its own table grants it ------ */
    // Read each family's SHIPPED catalog rows and push them through the same resolver the fire path
    // uses, so the leg measures the burst a player actually gets rather than the number in the row.
    const { SEED_VEHICLE_WEAPONS } = await import("/modules/cp2020-augmented/module/vehicle/vehicle-weapon-catalog.js");
    const wpn = (n) => SEED_VEHICLE_WEAPONS.find(w => w.name === n)?.system ?? {};
    const shell = (n, v) => (wpn(n).shellVariants ?? []).find(s => s.name === v) ?? {};
    const finalBurst = (weapon, variant, opts = {}) => {
      const s = shell(weapon, variant);
      return VI.warheadProfile(s.warhead, { pen: s.pen, burstM: s.burst, ...opts }).burstM;
    };
    o.burstOnce = {
      // Artillery: the row carries the BASE burst and warheadProfile applies p.21's x3 exactly once.
      m60wp:      finalBurst("60mm Mortar", "60mm WP"),
      m60chem:    finalBurst("60mm Mortar", "60mm Chemical"),
      m80wp:      finalBurst("80mm Mortar", "80mm WP"),
      m80cluster: finalBurst("80mm Mortar", "80mm Cluster"),
      m120clust:  finalBurst("120mm Mortar", "120mm Cluster"),
      h105clust:  finalBurst("105mm Howitzer", "105mm Cluster"),
      h150wp:     finalBurst("150mm Howitzer", "150mm WP"),
      h150clust:  finalBurst("150mm Howitzer", "150mm Cluster"),
      h200chem:   finalBurst("200mm Howitzer", "200mm Chemical"),
      // Bombs: the row carries the p.22 OPTIONS values and the p.21 arithmetic must NOT run over them.
      b250clust:  finalBurst("250-lb Bomb", "250-lb Cluster", { applyFillerRules: false }),
      b250inc:    finalBurst("250-lb Bomb", "250-lb Incendiary", { applyFillerRules: false }),
      b1000fae:   finalBurst("1000-lb Bomb", "1000-lb FAE", { applyFillerRules: false }),
      b250clustPen: VI.warheadProfile("cluster",
        { pen: shell("250-lb Bomb", "250-lb Cluster").pen, burstM: 32, applyFillerRules: false }).pen,
      // The base bursts the multipliers are measured against, so a drifted base cannot hide a drifted product.
      base: { m60: wpn("60mm Mortar").burst, m80: wpn("80mm Mortar").burst, m120: wpn("120mm Mortar").burst,
              h105: wpn("105mm Howitzer").burst, h150: wpn("150mm Howitzer").burst, h200: wpn("200mm Howitzer").burst,
              b250: wpn("250-lb Bomb").burst },
      wpBurnTurns: VI.warheadProfile("wp", { pen: 0, burstM: 5 }).dot?.turns,
    };

    /* ------ §12 the p.4 ACPA firer exemptions ------ */
    const TH = (args) => VW.vehicleToHitModifier({ targetLarge: false, ...args });
    o.acpaToHit = {
      plainTurning:   TH({ turningToFace: true }),
      acpaTurning:    TH({ turningToFace: true, isACPAFirer: true }),
      plainNoLink:    TH({}),
      acpaInherent:   TH({ isACPAFirer: true }),
      plainWithLink:  TH({ vehicleLink: true }),
      acpaNoDoubleUp: TH({ vehicleLink: true, isACPAFirer: true }),
      acpaTargetSize: TH({ targetLarge: true, isACPATarget: true }),
    };

    /* ------ §13 where the shell and the bomb actually LAND, in pixels, on both axes ------ */
    // The aim point, the scene scale and the roll are all fixed, so the landing point is a single
    // number pair that can be worked out on paper: distance from the printed miss formula, heading
    // from the module's own ten-point rose, then aim + (offset in metres × pixels-per-metre).
    // AIM (1000, 500) px · ppm 10 · the two rolled headings 36° (d10 2) and 108° (d10 4).
    const AIM = { x: 1000, y: 500 };
    o.landing = {
      // MM p.9 worked shape: a 500 m shot missed by 12 scatters 12 × (500/100) = 60 m.
      indMissA:  VI.indirectLanding({ aim: AIM, rangeM: 500, toHitTotal: 13, toHitNumber: 25, d10dir: 2, ppm: 10 }),
      indMissB:  VI.indirectLanding({ aim: AIM, rangeM: 500, toHitTotal: 13, toHitNumber: 25, d10dir: 4, ppm: 10 }),
      // the same shot at one pixel per metre — the offset must scale with ppm, not divide by it
      indMissA1: VI.indirectLanding({ aim: AIM, rangeM: 500, toHitTotal: 13, toHitNumber: 25, d10dir: 2, ppm: 1 }),
      // the aim point defaults to the scene origin when the caller omits it
      indDefaultAim: VI.indirectLanding({ rangeM: 500, toHitTotal: 13, toHitNumber: 25, d10dir: 2, ppm: 10 }),
      // hit boundary: total EQUAL to the number is a hit, and so is a total over it
      indExact:  VI.indirectLanding({ aim: AIM, rangeM: 500, toHitTotal: 25, toHitNumber: 25, d10dir: 4, ppm: 10 }),
      indOver:   VI.indirectLanding({ aim: AIM, rangeM: 500, toHitTotal: 40, toHitNumber: 25, d10dir: 4, ppm: 10 }),
      indOneShort: VI.indirectLanding({ aim: AIM, rangeM: 500, toHitTotal: 24, toHitNumber: 25, d10dir: 1, ppm: 10 }),
      // MM p.9 bomb shape: missed by 3 from 500 m up scatters 3 × 10 × (500/100) = 150 m.
      bombMissA: VI.bombLanding({ aim: AIM, heightM: 500, toHitTotal: 22, toHitNumber: 25, d10dir: 2, ppm: 10 }),
      bombMissC: VI.bombLanding({ aim: AIM, heightM: 500, toHitTotal: 22, toHitNumber: 25, d10dir: 7, ppm: 10 }),
      bombDefaultAim: VI.bombLanding({ heightM: 500, toHitTotal: 22, toHitNumber: 25, d10dir: 2, ppm: 10 }),
      bombExact: VI.bombLanding({ aim: AIM, heightM: 500, toHitTotal: 25, toHitNumber: 25, d10dir: 4, ppm: 10 }),
      bombBookOne: VI.bombLanding({ aim: AIM, heightM: 500, toHitTotal: 24, toHitNumber: 25, d10dir: 1, ppm: 10 }),
      // the two scatter distances read straight off their own formulas, for the same figures
      devInd: VI.indirectDeviationM(500, 12),
      devBomb: VI.bombDeviationM(500, 1),
    };

    /* ------ §14 the defaulted arguments: what a caller gets when it names nothing ------ */
    o.defaults = {
      coreNoRaw:      VD.coreVehicleDamage({ sp: 0, currentSDP: 10 }),
      coreNoSp:       VD.coreVehicleDamage({ rawDamage: 10, currentSDP: 50 }),
      crashNoSpeed:   VD.coreCrashDamage({ weightClass: "heavy" }),
      reactiveNoWear: VD.reactiveDeflection({ installed: true, heat: true, d10: 2 }),
      sevNoPen:       VD.mmDamageSeverity({ effectiveArmorValue: 1, d10: 5 }),
      surfNoBasePen:  VD.mmSurfaceDamage(9),
      locNoDie:       [VD.mmHitLocation(undefined), VD.mmHitLocation(NaN), VD.mmHitLocation("x")],
      locNoDieSide:   VD.mmHitLocation(undefined, "side"),
      subNoDie:       [VD.mmSubLocation(undefined), VD.mmSubLocation(undefined, "Turret", "rear")],
      dcNoDie:        [VD.damageControlIgnores(undefined), VD.damageControlIgnores(NaN)],
      vecNoArgs:      VI.deviationVector(),
      vecNoDie:       VI.deviationVector({ distanceM: 100 }),
      warheadNoPen:   VI.warheadProfile("heat", { burstM: 4 }),
      bonusNoSpotterHW:  VI.indirectToHitBonus({ spotterINT: 1 }),
      bonusNoSpotterINT: VI.indirectToHitBonus({ spotterHW: 1 }),
      bonusNoFirerHW:    VI.indirectToHitBonus({ spotterHW: 2, spotterINT: 2 }),
      // the fall loop's own runaway guard: 10 000 turns and not one more
      fallGuardAt:   VI.bombFallSchedule(175 * 10000 + 1).length,
      fallGuardUnder: VI.bombFallSchedule(175 * 9999).length,
    };

    o.cleanupIds = [avVeh.id, bvHalf.id, bvSmall.id, acpa.id, plainWithStr.id];
  } catch (e) { o.err = String(e?.stack ?? e); }
  return o;
}, { SCOPE });

if (r.err) { console.log("PHASE 1 THREW:", r.err); }

console.log("\n§0 — the surface this suite pins");
check("every pure producer the judgment names is exported and callable",
  ["coreVehicleDamage", "coreCrashDamage", "mmEffectivePenetration", "mmEffectiveArmor", "mmDamageSeverity",
   "mmSurfaceDamage", "mmHitLocation", "mmSubLocation", "damageControlIgnores", "reactiveDeflection",
   "bombDirectPen", "diveBombAimBonus", "bombFallSchedule", "bombFallTurns", "roundsPerHit", "goodShotSteps"]
    .every(n => r.exported?.[n] === "function")
  && r.exported?.WEIGHT_MOD === "object" && r.exported?.MM_CRIT === "object",
  J(r.exported));
check("NO Maximum Metal collision resolver is exported — the only crash math on offer is the Core one",
  r.exported?.coreCrashDamage === "function"
  && ["mmCrashDamage", "mmSideswipeDamage", "mmCollisionDamage", "crashPenetration"].every(n => r.exported?.[n] === "undefined"),
  `coreCrashDamage=${r.exported?.coreCrashDamage}; MM candidates all undefined — FINDING: [MM p.11 + errata] sideswipe speed/75 x WeightMod at 75% side armor, crash speed/60 x WeightMod at facing armor, head-on ADDS both speeds / rear-end SUBTRACTS, 15.5 points per d10 and 10 points per Pen, is NOT IMPLEMENTED anywhere in module/`);

console.log("\n§1 — Armor Value and Body Value derivation");
check("Armor Value is SP divided by twenty, per facing and independently",
  r.avPerFacing?.front === 5 && r.avPerFacing?.side === 2 && r.avPerFacing?.rear === 1
  && r.avPerFacing?.top === 0 && r.avPerFacing?.bottom === 0,
  `SP 100/30/10/9/0 -> AV ${r.avPerFacing?.front}/${r.avPerFacing?.side}/${r.avPerFacing?.rear}/${r.avPerFacing?.top}/${r.avPerFacing?.bottom} [MM p.4: "Armor Value (AV) = SP / 20 (round)"]`);
check("Body Value is SDP divided by twenty",
  r.bvPlain === 10 && r.bvHalfStep === 3 && r.bvBelowStep === 0,
  `SDP 200/50/9 -> BV ${r.bvPlain}/${r.bvHalfStep}/${r.bvBelowStep} [MM p.4: "Body Value = SDP / 20"]`);
check("a powered-armor chassis takes its Body Value from Chassis STR, not from the SDP field beside it",
  r.bvAcpaFromStr === 2,
  `STR 40 with sdp.max 200 present -> BV ${r.bvAcpaFromStr} (STR/20 = 2, not SDP/20 = 10) [MM p.4: "ACPA uses Chassis STR as SDP source"]`);
check("NEGATIVE: a plain vehicle with the same STR field ignores it and reads SDP",
  r.bvPlainIgnoresStr === 10,
  `str 40 + sdp.max 200 on a non-ACPA -> BV ${r.bvPlainIgnoresStr}`);

console.log("\n§2 — the penetration ladder");
check("with no additions the effective penetration is the base",
  r.pen?.flat === 20 && r.pen?.normal === 20 && r.pen?.zero === 0 && r.pen?.defaults === 0,
  `base 20 -> ${r.pen?.flat}; base 0 with every addition -> ${r.pen?.zero}`);
check("each clearing step adds half the BASE penetration, not half the running total",
  r.pen?.goodShot1 === 30 && r.pen?.goodShot2 === 40 && r.pen?.goodShot3 === 50,
  `base 20, 1/2/3 steps -> ${r.pen?.goodShot1}/${r.pen?.goodShot2}/${r.pen?.goodShot3} (half-of-total would give 30/45/67) [MM p.4: "+1/2 base Pen per full 10 the to-hit clears the target"]`);
check("a step is one full ten cleared — nine over is no step, exactly ten is one",
  r.steps?.cleared10 === 1 && r.steps?.cleared20 === 2 && r.steps?.cleared9 === 0
  && r.steps?.exact === 0 && r.steps?.missed === 0,
  `roll-vs-25 at 35/45/34/25/24 -> ${r.steps?.cleared10}/${r.steps?.cleared20}/${r.steps?.cleared9}/${r.steps?.exact}/${r.steps?.missed} [MM p.4]`);
check("a negative clearing count adds nothing",
  r.pen?.goodShotNeg === 20, `base 20 with -4 steps -> ${r.pen?.goodShotNeg}`);
check("the two printed high-ROF rates put five and ten rounds on the hit",
  r.rounds?.rof30 === 5 && r.rounds?.rof100 === 10 && r.rounds?.rof10 === 1 && r.rounds?.rof1 === 1,
  `ROF 30/100/10/1 -> ${r.rounds?.rof30}/${r.rounds?.rof100}/${r.rounds?.rof10}/${r.rounds?.rof1} rounds per hit [MM p.4: "ROF 30 = 5 rounds/hit, ROF 100 = 10/hit"]`);
check("each EXTRA round adds a quarter of the base penetration",
  r.pen?.rof30 === 40 && r.pen?.rof100 === 65 && r.pen?.rof10 === 20,
  `base 20 at ROF 30 (5 rounds = 4 extra) -> ${r.pen?.rof30}; at ROF 100 (10 rounds = 9 extra) -> ${r.pen?.rof100}; at ROF 10 -> ${r.pen?.rof10} [MM p.4: "+1/4 base Pen per extra round"]`);
check("the long band costs a quarter of the penetration and the extreme band half",
  r.pen?.long === 15 && r.pen?.extreme === 10,
  `base 20 -> long ${r.pen?.long}, extreme ${r.pen?.extreme} [MM p.4: "Pen -25% Long, -50% Extreme"]`);
check("NEGATIVE: an ordinary kinetic penetrator DOES fall off at the far bands",
  r.pen?.extreme === 10 && r.pen?.extreme !== r.pen?.normal && r.pen?.long !== r.pen?.normal,
  `unflagged base 20: normal ${r.pen?.normal}, long ${r.pen?.long}, extreme ${r.pen?.extreme}`);
check("a shaped-charge or high-explosive penetrator carries full penetration to every band",
  r.pen?.heLong === 20 && r.pen?.heExtreme === 20,
  `HE/HEAT base 20 -> long ${r.pen?.heLong}, extreme ${r.pen?.heExtreme} [MM p.4: "unless HE/HEAT penetrators"]`);
check("a high-density kinetic penetrator is likewise band-immune",
  r.pen?.hdapExtreme === 20,
  `high-density AP base 20 at extreme -> ${r.pen?.hdapExtreme} [MM errata: "do full damage through armor like HEAT"]`);
check("the additions accumulate before the band multiplier is applied",
  r.pen?.stacked === 30,
  `base 16 + 1 step (8) + 4 extra rounds (16) = 40, long band x0.75 -> ${r.pen?.stacked} [MM p.4: range is applied last]`);

console.log("\n§3 — flank armor fractions");
check("the front facing is the armor unchanged",
  r.flank?.even?.front === 10 && r.flank?.zero?.front === 0 && r.flank?.defaultFacing === 10
  && r.flank?.unknownFacing === 10,
  `AV 10 front -> ${r.flank?.even?.front}; no facing given -> ${r.flank?.defaultFacing}`);
check("a side hit meets three quarters of the armor",
  r.flank?.even?.side === 8,
  `AV 10 side -> ${r.flank?.even?.side} (0.75 x 10 = 7.5, up) [MM p.4: "side = 75% armor (round up)"]`);
check("top, rear, back and bottom hits meet half the armor",
  r.flank?.even?.top === 5 && r.flank?.even?.rear === 5 && r.flank?.even?.back === 5 && r.flank?.even?.bottom === 5,
  `AV 10 -> top ${r.flank?.even?.top} / rear ${r.flank?.even?.rear} / back ${r.flank?.even?.back} / bottom ${r.flank?.even?.bottom} [MM p.4: "top/bottom/back = 50% (round up)"]`);
check("NEGATIVE: an odd armor value rounds the fraction UP, never down",
  r.flank?.odd?.side === 6 && r.flank?.odd?.rear === 4 && r.flank?.odd?.top === 4 && r.flank?.odd?.bottom === 4,
  `AV 7 -> side ${r.flank?.odd?.side} (5.25 up, not 5) / rear ${r.flank?.odd?.rear} (3.5 up, not 3)`);
check("a single point of armor survives both fractions",
  r.flank?.one?.side === 1 && r.flank?.one?.rear === 1,
  `AV 1 -> side ${r.flank?.one?.side}, rear ${r.flank?.one?.rear}`);
check("no armor stays no armor on every facing",
  r.flank?.zero?.side === 0 && r.flank?.zero?.rear === 0,
  `AV 0 -> side ${r.flank?.zero?.side}, rear ${r.flank?.zero?.rear}`);

console.log("\n§4 — the damage table and the surface roll");
check("penetration below the armor value stops the shot before the table",
  r.sev?.under?.penetrated === false && r.sev?.under?.severity === "noPenetration" && r.sev?.under?.diff === -5,
  `Pen 5 vs AV 10 -> ${J(r.sev?.under)} [MM p.4: "Pen - AV: < 0 -> no penetration (surface chance only)"]`);
check("penetration exactly equal to the armor value still reaches the table",
  r.sev?.atZero?.penetrated === true && r.sev?.atZero?.diff === 0 && r.sev?.atZero?.score === 1,
  `Pen 10 vs AV 10, Body 0, die 1 -> ${J(r.sev?.atZero)} [MM p.4: ">= 0 -> step 4"]`);
check("the four table bands sit at zero-and-below, one to five, six to nine, and ten up",
  r.sev?.band1 === "minor" && r.sev?.band5 === "minor" && r.sev?.band6 === "major"
  && r.sev?.band9 === "major" && r.sev?.band10 === "catastrophic"
  && r.sev?.surface0?.severity === "surface" && r.sev?.surfaceNeg?.severity === "surface"
  && r.sev?.justMinor?.severity === "minor",
  `scores 1/5/6/9/10 -> ${r.sev?.band1}/${r.sev?.band5}/${r.sev?.band6}/${r.sev?.band9}/${r.sev?.band10}; scores 0 and -1 -> ${r.sev?.surface0?.severity}/${r.sev?.surfaceNeg?.severity} [MM p.4: "<=0 Surface / 1-5 Minor / 6-9 Major / 10+ Catastrophic"]`);
check("the score is the die plus the penetration margin minus the Body Value",
  r.sev?.surface0?.score === 0 && r.sev?.justMinor?.score === 1 && r.sev?.bigDiff?.score === 16
  && r.sev?.bigDiff?.severity === "catastrophic",
  `die 5 + (10-10) - Body 5 -> ${r.sev?.surface0?.score}; die 1 + (30-10) - Body 5 -> ${r.sev?.bigDiff?.score} [MM p.4: "1d10 + (Pen - AV) - Body Value"]`);
check("only a seven or better on the surface roll finds an exposed item",
  r.surf?.d6?.itemDamaged === false && r.surf?.d7?.itemDamaged === true && r.surf?.d10?.itemDamaged === true,
  `die 6/7/10 -> ${r.surf?.d6?.itemDamaged}/${r.surf?.d7?.itemDamaged}/${r.surf?.d10?.itemDamaged} [MM p.4: "1d10; 7-10 -> one exposed item damaged"]`);
check("a base penetration of three destroys the exposed item; two or less only damages it",
  r.surf?.pen3?.destroyed === true && r.surf?.pen2?.destroyed === false && r.surf?.pen0?.destroyed === false,
  `base Pen 3/2/0 -> destroyed ${r.surf?.pen3?.destroyed}/${r.surf?.pen2?.destroyed}/${r.surf?.pen0?.destroyed} [MM p.4: "base Pen 3+ destroys; <=2 = 50% repairable"]`);

console.log("\n§5 — hit location and the sub-tables");
check("with no facing shift the table reads motive gear, hull, then turret",
  J(r.loc?.front) === J(["Motive Gear", "Motive Gear", "Motive Gear", "Hull", "Hull", "Turret", "Turret"]),
  `front, dice 1/2/3/4/7/8/10 -> ${J(r.loc?.front)} [MM p.6: "1-3 Motive Gear / 4-7 Hull / 8-12 Turret"]`);
check("a hit from above shifts the table two rows toward the turret",
  J(r.loc?.top) === J(["Motive Gear", "Hull", "Turret", "Turret"]),
  `top (+2), dice 1/2/6/8 -> ${J(r.loc?.top)} [MM p.6: "+2 top"]`);
check("a side hit shifts one row down and puts the fuel within reach",
  J(r.loc?.side) === J(["Fuel", "Motive Gear", "Hull", "Hull", "Turret"]),
  `side (-1), dice 1/2/5/8/9 -> ${J(r.loc?.side)} [MM p.6: "-1 side"; "-1,0 Fuel"]`);
check("a hit from behind or below shifts two rows down",
  J(r.loc?.rear) === J(["Fuel", "Fuel", "Motive Gear", "Hull", "Turret"])
  && J(r.loc?.bottom) === J(r.loc?.rear) && J(r.loc?.back) === J(["Fuel", "Fuel", "Motive Gear"]),
  `rear/bottom/back (-2), dice 1/2/3/6/10 -> ${J(r.loc?.rear)} [MM p.6: "-2 back-bottom"]`);
check("the hull sub-table runs cargo, engine, crew, equipment, weapon, empty",
  J(r.sub?.hullFront) === J(["Cargo/Ammo", "Engine", "Engine", "Crew", "Crew", "Equipment", "Weapon", "Empty Space", "Empty Space"]),
  `Hull front (+1), dice 1-4,6-10 -> ${J(r.sub?.hullFront)} [MM p.6: "0-2 Cargo/Ammo / 3-4 Engine/Crew / 5-7 Crew / 8 Equipment / 9 Weapon / 10-11 Empty/Weapon", read Engine and Empty in a hull]`);
check("a shot from behind shifts the sub-table one row down",
  J(r.sub?.hullRear) === J(["Cargo/Ammo", "Cargo/Ammo", "Engine", "Engine", "Crew", "Equipment", "Weapon"]),
  `Hull rear (-1), dice 1/3/4/5/6/9/10 -> ${J(r.sub?.hullRear)} [MM p.6: "-1 back"]`);
check("a side shot shifts the sub-table not at all",
  J(r.sub?.hullSide) === J(["Cargo/Ammo", "Engine", "Crew", "Equipment", "Weapon", "Empty Space"]),
  `Hull side, dice 2/3/5/8/9/10 -> ${J(r.sub?.hullSide)} [MM p.6: the shift is +1 front / -1 back only]`);
check("in a turret the engine row reads crew and the empty row reads weapon",
  J(r.sub?.turretFront) === J(["Cargo/Ammo", "Crew", "Crew", "Equipment", "Weapon", "Weapon"])
  && J(r.sub?.turretRear) === J(["Cargo/Ammo", "Crew", "Equipment", "Weapon"]),
  `Turret front (+1), dice 1/2/6/7/8/10 -> ${J(r.sub?.turretFront)}; Turret rear (-1), dice 3/4/9/10 -> ${J(r.sub?.turretRear)} [MM p.6: the printed rows are "Engine/Crew" and "Empty/Weapon" — a turret has no engine and no empty space]`);

console.log("\n§6 — severity effects and the damage-control band");
check("a minor result destroys the struck system one time in five and ignites fuel one in four",
  r.crit?.minor?.destroyPct === 20 && r.crit?.minor?.fuelFirePct === 25 && r.crit?.minor?.crewDice === "4d6"
  && r.crit?.minor?.enginePct === 0,
  `minor -> ${J(r.crit?.minor)} [MM p.6: "Minor 20% destroyed, fuel 25% fire, crew 4d6"]`);
check("a major result destroys the system nine times in ten and cooks off engine or ammo half the time",
  r.crit?.major?.destroyPct === 90 && r.crit?.major?.enginePct === 50 && r.crit?.major?.crewDice === "6d6",
  `major -> ${J(r.crit?.major)} [MM p.6: "Major 90% destroyed, engine/ammo 50% explode, crew 6d6"]`);
check("a catastrophic result destroys the system outright and cooks off nine times in ten",
  r.crit?.catastrophic?.destroyPct === 100 && r.crit?.catastrophic?.enginePct === 90
  && r.crit?.catastrophic?.crewDice === "10d6",
  `catastrophic -> ${J(r.crit?.catastrophic)} [MM p.6: "Catastrophic destroyed, 90% explode, crew 10d6"]`);
// ⏪ UPGRADED from an informational 2026-08-19: the p.6 TEXT LAYER settles what the eye-read digest
// omitted — Major: "If fuel is hit, it has a 50% chance of catching fire"; Catastrophic: "If fuel
// is hit, it has a 50% chance of catching fire" (import-staging/mm-acpa/MM_fulltext.txt, PDFIDX 6).
check("major and catastrophic results ignite struck fuel half the time",
  r.crit?.major?.fuelFirePct === 50 && r.crit?.catastrophic?.fuelFirePct === 50,
  `major ${r.crit?.major?.fuelFirePct} / catastrophic ${r.crit?.catastrophic?.fuelFirePct} [MM p.6 text layer: "a 50% chance of catching fire" in both rows]`);
check("a damage-control system swallows the hit on a six or better and never below",
  J(r.dc) === J([false, false, false, false, false, true, true, true, true, true]),
  `dice 1..10 -> ${J(r.dc)} [MM p.4: "a hit is IGNORED on 1d10 of 6-10"]`);

console.log("\n§7 — reactive tiles");
check("a fresh tile array fires on everything but a one",
  r.reactive?.fresh1?.deflected === false && r.reactive?.fresh2?.deflected === true
  && r.reactive?.fresh10?.deflected === true && r.reactive?.fresh2?.fired === true,
  `dice 1/2/10 at no wear -> ${r.reactive?.fresh1?.deflected}/${r.reactive?.fresh2?.deflected}/${r.reactive?.fresh10?.deflected} [MM p.23: "roll 1d10, on a 2-10 the tile halves the Penetration"]`);
check("the roll drops one point for every TWO tiles already spent, not for every one",
  r.reactive?.worn1_d2?.subtract === 0 && r.reactive?.worn1_d2?.deflected === true
  && r.reactive?.worn2_d2?.subtract === 1 && r.reactive?.worn2_d2?.deflected === false
  && r.reactive?.worn2_d3?.deflected === true
  && r.reactive?.worn4_d3?.subtract === 2 && r.reactive?.worn4_d3?.deflected === false
  && r.reactive?.worn4_d4?.deflected === true,
  `1 prior hit -> -${r.reactive?.worn1_d2?.subtract}; 2 prior -> -${r.reactive?.worn2_d2?.subtract}; 4 prior -> -${r.reactive?.worn4_d3?.subtract} [MM p.23: "-1 for every two prior shaped/HE hits"]`);
check("every shaped or high-explosive hit spends a tile",
  r.reactive?.fresh2?.newHits === 1 && r.reactive?.hiExOnly?.newHits === 4,
  `fresh shaped hit -> ${r.reactive?.fresh2?.newHits}; 3 prior + a high-explosive hit -> ${r.reactive?.hiExOnly?.newHits}`);
check("NEGATIVE: a high-explosive hit spends a tile without firing one",
  r.reactive?.hiExOnly?.fired === false && r.reactive?.hiExOnly?.deflected === false
  && r.reactive?.hiExOnly?.newHits === 4,
  `high-explosive only -> ${J(r.reactive?.hiExOnly)} [MM p.23: only a shaped charge triggers the deflection roll]`);
check("NEGATIVE: with no array fitted nothing fires and nothing is spent",
  r.reactive?.notInstalled?.fired === false && r.reactive?.notInstalled?.newHits === 0,
  `not installed, shaped hit, die 10 -> ${J(r.reactive?.notInstalled)}`);
check("NEGATIVE: a plain kinetic round neither fires a tile nor wears the array",
  r.reactive?.plainRound?.fired === false && r.reactive?.plainRound?.newHits === 3,
  `installed, 3 prior, neither shaped nor high-explosive -> ${J(r.reactive?.plainRound)}`);

console.log("\n§8 — core subtraction damage, the crash dice plan, and the weight table");
check("armor is subtracted and only the remainder comes off structure",
  r.core?.partial?.spUsed === 10 && r.core?.partial?.through === 20 && r.core?.partial?.newSDP === 30
  && r.core?.partial?.destroyed === false,
  `30 damage vs SP 10 on SDP 50 -> ${J(r.core?.partial)} [Core p.112]`);
check("an armor-piercing round meets half the armor, rounded down",
  r.core?.apHalves?.spUsed === 5 && r.core?.apHalves?.through === 25 && r.core?.apHalves?.newSDP === 25,
  `30 damage vs SP 11 armor-piercing -> ${J(r.core?.apHalves)} [Core p.112: AP halves SP]`);
check("armor that exceeds the damage lets nothing through",
  r.core?.stopped?.through === 0 && r.core?.stopped?.newSDP === 50 && r.core?.stopped?.destroyed === false,
  `5 damage vs SP 10 -> ${J(r.core?.stopped)}`);
check("structure reduced to exactly zero counts as destroyed, and it floors at zero",
  r.core?.exact?.newSDP === 0 && r.core?.exact?.destroyed === true
  && r.core?.over?.newSDP === 0 && r.core?.over?.destroyed === true && r.core?.over?.through === 90,
  `60 damage -> ${J(r.core?.exact)}; 100 damage -> ${J(r.core?.over)} [Core p.112: "at 0 SDP the vehicle is destroyed"]`);
check("the whole Weight Modifier table is on the five printed rows",
  r.weightMod?.vlight === 0.5 && r.weightMod?.light === 1 && r.weightMod?.medium === 2
  && r.weightMod?.heavy === 3 && r.weightMod?.vheavy === 4 && Object.keys(r.weightMod ?? {}).length === 5,
  `${J(r.weightMod)} [MM p.11: "x1/2 V.Light(<25kg) / x1 Light(25-100) / x2 Medium(101-500) / x3 Heavy(501-5000) / x4 V.Heavy(5000+)"]`);
check("the core crash rolls one die per full twenty of speed",
  r.crash?.dice60?.numD6 === 3 && r.crash?.dice19?.numD6 === 0 && r.crash?.dice100?.numD6 === 5,
  `speed 60/19/100 -> ${r.crash?.dice60?.numD6}/${r.crash?.dice19?.numD6}/${r.crash?.dice100?.numD6} dice [Core p.112: "(speed/20, round down) d6"]`);
check("the weight class multiplies the rolled dice and the occupants take half",
  r.crash?.heavyRolled?.weightMult === 3 && r.crash?.heavyRolled?.vehicleDamage === 30
  && r.crash?.heavyRolled?.occupantDamage === 15,
  `rolled 10 on a heavy vehicle -> ${J(r.crash?.heavyRolled)} [Core p.112: "x weight modifier; occupants take half"]`);
check("a very light vehicle halves the dice and the occupant share halves again",
  r.crash?.vlightRolled?.weightMult === 0.5 && r.crash?.vlightRolled?.vehicleDamage === 3
  && r.crash?.vlightRolled?.occupantDamage === 1,
  `rolled 7 on a very light vehicle -> ${J(r.crash?.vlightRolled)}`);
check("an unrecognised weight class falls back to the light row rather than to zero",
  r.crash?.unknownClass?.weightMult === 1 && r.crash?.unknownClass?.vehicleDamage === 10,
  `${J(r.crash?.unknownClass)}`);

console.log("\n§9 — bombs");
check("a direct bomb hit multiplies the penetration by five",
  J(r.bomb?.x5) === J([0, 20, 35]),
  `Pen 0/4/7 -> ${J(r.bomb?.x5)} [MM p.9: "direct hit x5 Pen"]`);
check("the bomb's penetration is band-immune before the multiplier is applied",
  r.bomb?.immunePenThenX5 === 20,
  `Pen 4 flagged band-immune at extreme, then x5 -> ${r.bomb?.immunePenThenX5} [MM p.9: "Pen range-immune"]`);
check("NEGATIVE: the same penetration WITHOUT the immunity flag halves first and lands at half the total",
  r.bomb?.fallsOffThenX5 === 10,
  `Pen 4 unflagged at extreme (2), then x5 -> ${r.bomb?.fallsOffThenX5}`);
check("diving counts as aiming — one per turn, capped at three",
  J(r.bomb?.aim) === J([0, 0, 1, 2, 3, 3, 3]),
  `dive turns 0/1/2/3/4/5/10 -> ${J(r.bomb?.aim)} [MM p.9: "counts as aim (+1/turn max +3)"; the first turn is not yet a turn OF aim]`);
check("a bomb falls one hundred and seventy-five metres a turn",
  J(r.bomb?.fall700) === J([175, 175, 175, 175]) && r.bomb?.turns700 === 4
  && J(r.bomb?.fall175) === J([175]) && J(r.bomb?.fall100) === J([175])
  && J(r.bomb?.fall350) === J([175, 175]),
  `700 m -> ${J(r.bomb?.fall700)}; 350 m -> ${J(r.bomb?.fall350)}; 100 m -> ${J(r.bomb?.fall100)} [MM p.9: "bombs fall 175 m/turn"]`);
check("a dive-drop starts at the aircraft's speed, halves each turn, and settles on the floor",
  J(r.bomb?.dive1000at600) === J([600, 300, 175]),
  `1000 m at dive speed 600 -> ${J(r.bomb?.dive1000at600)} [MM p.9: "dive faster, decays" to the 175 floor]`);
check("NEGATIVE: a dive slower than the floor does not slow the bomb below it",
  J(r.bomb?.diveBelowFloor) === J([175, 175, 175, 175, 175, 175]),
  `1000 m at dive speed 100 -> ${J(r.bomb?.diveBelowFloor)}`);

console.log("\n§11 — the burst multiplier lands exactly once, from the table that grants it");
const b = r.burstOnce ?? {};
check("every artillery family carries its BASE burst in the catalog, not a pre-multiplied one",
  b.base?.m60 === 5 && b.base?.m80 === 6 && b.base?.m120 === 6
  && b.base?.h105 === 6 && b.base?.h150 === 6 && b.base?.h200 === 8,
  `${J(b.base)} [MM p.21 shell rows; the x3 belongs to the filler, not the tube]`);
check("cluster and chemical shells open exactly three times the shell's own burst",
  b.m60chem === 15 && b.m80cluster === 18 && b.m120clust === 18
  && b.h105clust === 18 && b.h150clust === 18 && b.h200chem === 24,
  `60chem ${b.m60chem} / 80cl ${b.m80cluster} / 120cl ${b.m120clust} / 105cl ${b.h105clust} / 150cl ${b.h150clust} / 200chem ${b.h200chem}`
  + ` [MM p.21: Cluster + Chemical "Triple the Burst"; 200mm base 8 x3 = 24, NOT the 72 a doubled application gave]`);
check("white phosphorus gets NO burst multiplier — p.21 grants one to cluster and chemical only",
  b.m60wp === 5 && b.h150wp === 6,
  `60mm WP ${b.m60wp} (base 5) / 150mm WP ${b.h150wp} (base 6) [MM p.21 prints no burst change for WP]`);
check("the 105mm family and the rest of the artillery now agree — one rule, one application",
  b.h105clust === b.m120clust && b.m80cluster === b.h150clust,
  `105mm ${b.h105clust} vs 120mm ${b.m120clust}; 80mm ${b.m80cluster} vs 150mm ${b.h150clust}`
  + ` [the 105mm family was the only unbaked one, so it alone was correct before]`);
check("a bomb's options are the p.22 table and the artillery arithmetic does not run over them",
  b.b250clust === 32 && b.b250inc === 32 && b.b1000fae === 216,
  `250 cluster ${b.b250clust} (base 16 x2) / 250 incendiary ${b.b250inc} / 1000 FAE ${b.b1000fae} (base 72 x3)`
  + ` [MM p.22 BOMB OPTIONS: Cluster BURST x2, Incendiary BURST x2, FAE BURST x3 — not p.21's x3-and-cap]`);
check("a bomb cluster keeps its p.22 penetration instead of being capped at the artillery's 4",
  b.b250clustPen === 3,
  `250-lb Cluster Pen ${b.b250clustPen} [MM p.22: "subtract 3 from the bomb's normal Penetration" (6-3=3);`
  + ` p.21's "reduce Penetration to 4" is the ARTILLERY rule and must not reach a bomb]`);
check("white phosphorus burns for the printed half-hour, not ten turns",
  b.wpBurnTurns === 600,
  `WP dot turns -> ${b.wpBurnTurns} [MM p.21: "3D6 burn damage to that location per turn for at least a half-hour";`
  + ` a half-hour of 3-second turns is 600]`);

console.log("\n§12 — the p.4 note's ACPA exemptions, all three of them");
const a = r.acpaToHit ?? {};
check("a plain vehicle pays two for turning its weapon to face the target",
  a.plainTurning === -2, `${a.plainTurning} [MM p.4: "Firer Turning Weapon to Face Target in same action -2"]`);
check("an ACPA firer pays nothing for the same turn",
  a.acpaTurning === 2,
  `${a.acpaTurning} [MM p.4: ACPA "take no penalty for turning to face the target in the same action";`
  + ` the +2 that remains is the inherent Vehicle Link below]`);
check("an ACPA firer counts as Vehicle Link-equipped without carrying the flag",
  a.acpaInherent === 2 && a.plainNoLink === 0,
  `ACPA ${a.acpaInherent} vs unlinked vehicle ${a.plainNoLink} [MM p.4: "They are considered to have Vehicle Link/Cyber-controls"]`);
check("NEGATIVE: the inherent link does not stack with a flagged one",
  a.acpaNoDoubleUp === 2 && a.plainWithLink === 2,
  `ACPA+flag ${a.acpaNoDoubleUp} vs vehicle+flag ${a.plainWithLink} [one link, one +2]`);
check("the size exemption still belongs to the ACPA being SHOT AT, not the one shooting",
  a.acpaTargetSize === 0,
  `${a.acpaTargetSize} [MM p.4: "ACPA have no target size modifier" — the +4 Large is withheld from the target]`);

console.log("\n§13 — where the shell and the bomb land, both axes, in pixels");
const L = r.landing ?? {};
// The expected coordinates are worked out here, from the printed miss distance and the module's
// own documented ten-point rose, and written as literals — nothing below re-runs the module's
// arithmetic to decide what to expect.
//   indirect: 500 m missed by 12 -> 60 m · d10 2 -> 36° · ppm 10
//     dx = 60 cos36 = 48.5410196624968 m -> 485.410196624968 px  -> x 1000 + 485.410... = 1485.410...
//     dy = 60 sin36 = 35.2671151375484 m -> 352.671151375484 px  -> y  500 + 352.671... =  852.671...
//   indirect: the same miss on d10 4 -> 108° · cos is NEGATIVE, sin positive — the mirror check
//     dx = 60 cos108 = -18.5410196624968 -> x 1000 - 185.410... = 814.589...
//     dy = 60 sin108 =  57.0633909777092 -> y  500 + 570.633... = 1070.633...
const nearPx = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-6;
check("a missed shell lands one scatter distance east-south-east of the aim point, on BOTH axes",
  L.indMissA?.hit === false && nearPx(L.indMissA?.point?.x, 1485.4101966249686)
  && nearPx(L.indMissA?.point?.y, 852.6711513754839),
  `aim (1000,500) px at 10 px/m, 500 m missed by 12 on heading 36° -> (${L.indMissA?.point?.x}, ${L.indMissA?.point?.y}),`
  + ` expected (1485.4101966249686, 852.6711513754839) [MM p.9: "it does so by (range/100 meters) x the number of points missed by"; 12 x 5 = 60 m]`);
check("the SAME miss on a west-of-north heading lands west and further south — the x offset changes sign, the y offset does not",
  L.indMissB?.hit === false && nearPx(L.indMissB?.point?.x, 814.5898033750316)
  && nearPx(L.indMissB?.point?.y, 1070.6339097770922),
  `heading 108° -> (${L.indMissB?.point?.x}, ${L.indMissB?.point?.y}), expected (814.5898033750316, 1070.6339097770922)`
  + ` [the two headings put the landing on opposite sides of the aim point in x and the same side in y, so a mirrored or swapped axis cannot satisfy both legs]`);
check("the metre offset is MULTIPLIED by the scene scale, not divided by it",
  nearPx(L.indMissA1?.point?.x, 1048.5410196624969) && nearPx(L.indMissA1?.point?.y, 535.2671151375484)
  && nearPx((L.indMissA?.point?.x ?? 0) - 1000, 10 * ((L.indMissA1?.point?.x ?? 0) - 1000))
  && nearPx((L.indMissA?.point?.y ?? 0) - 500, 10 * ((L.indMissA1?.point?.y ?? 0) - 500)),
  `the same miss at 1 px/m -> (${L.indMissA1?.point?.x}, ${L.indMissA1?.point?.y}); ten times the scale is ten times the offset on both axes`);
check("with no aim point named the landing is measured from the scene origin",
  nearPx(L.indDefaultAim?.point?.x, 485.41019662496853) && nearPx(L.indDefaultAim?.point?.y, 352.6711513754839),
  `aim omitted -> (${L.indDefaultAim?.point?.x}, ${L.indDefaultAim?.point?.y}), expected the bare offset (485.41019662496853, 352.6711513754839)`);
check("a to-hit total EQUAL to the number is a hit: the shell lands ON the aim point with no heading at all",
  L.indExact?.hit === true && L.indExact?.point?.x === 1000 && L.indExact?.point?.y === 500
  && L.indExact?.deviationM === 0 && L.indExact?.missedBy === 0 && L.indExact?.dirDeg === 0,
  `total 25 vs number 25 (a rolled scatter heading of 4 standing by) -> ${J(L.indExact)} [MM p.8: "The difficulty is 25+" — meeting the number is making it]`);
check("a to-hit total OVER the number is the same hit, not a negative miss",
  L.indOver?.hit === true && L.indOver?.missedBy === 0 && L.indOver?.point?.x === 1000 && L.indOver?.point?.y === 500,
  `total 40 vs number 25 -> ${J(L.indOver)}`);
check("NEGATIVE: one point short is a miss, and the miss is by exactly one",
  L.indOneShort?.hit === false && L.indOneShort?.missedBy === 1 && L.indOneShort?.deviationM === 5
  && nearPx(L.indOneShort?.point?.x, 1050) && nearPx(L.indOneShort?.point?.y, 500),
  `total 24 vs number 25 -> missed by ${L.indOneShort?.missedBy}, ${L.indOneShort?.deviationM} m due east -> (${L.indOneShort?.point?.x}, ${L.indOneShort?.point?.y})`);
check("the miss amount is the number MINUS the total, and the scatter distance follows the printed formula",
  L.indMissA?.missedBy === 12 && L.indMissA?.deviationM === 60 && L.indMissA?.dirDeg === 36
  && r.landing?.devInd === 60,
  `number 25 - total 13 -> missed by ${L.indMissA?.missedBy}; 500 m -> ${L.indMissA?.deviationM} m [MM p.9; the same figure straight off indirectDeviationM: ${r.landing?.devInd}]`);
check("a missed bomb scatters by ten times the height fraction, and lands where that puts it",
  L.bombMissA?.hit === false && L.bombMissA?.missedBy === 3 && L.bombMissA?.deviationM === 150
  && nearPx(L.bombMissA?.point?.x, 2213.525491562421) && nearPx(L.bombMissA?.point?.y, 1381.6778784387097),
  `500 m up, missed by 3, heading 36° at 10 px/m -> (${L.bombMissA?.point?.x}, ${L.bombMissA?.point?.y}), expected (2213.525491562421, 1381.6778784387097)`
  + ` [MM p.9: "They deviate 10m on the Grenade Table per point that the To-Hit roll is missed by, times height/100m" — 3 x 10 x 5 = 150 m]`);
check("a south-west heading carries the bomb NEGATIVE on both axes at once",
  nearPx(L.bombMissC?.point?.x, -213.52549156242117) && nearPx(L.bombMissC?.point?.y, -381.6778784387095),
  `heading 216° -> (${L.bombMissC?.point?.x}, ${L.bombMissC?.point?.y}), expected (-213.52549156242117, -381.6778784387095)`
  + ` [both offsets negative here and both positive above: no single sign convention fits both unless the addition is a real addition]`);
check("the bomb's aim point defaults to the origin too",
  nearPx(L.bombDefaultAim?.point?.x, 1213.5254915624212) && nearPx(L.bombDefaultAim?.point?.y, 881.6778784387097),
  `aim omitted -> (${L.bombDefaultAim?.point?.x}, ${L.bombDefaultAim?.point?.y})`);
check("a bomb that makes its number lands on the aim point",
  L.bombExact?.hit === true && L.bombExact?.point?.x === 1000 && L.bombExact?.point?.y === 500
  && L.bombExact?.deviationM === 0 && L.bombExact?.dirDeg === 0 && L.bombExact?.missedBy === 0,
  `total 25 vs number 25 -> ${J(L.bombExact)} [MM p.9: "Bombs have a standard To-Hit of 25+"]`);
check("the book's own single-point bomb miss from five hundred metres is fifty metres",
  L.bombBookOne?.missedBy === 1 && L.bombBookOne?.deviationM === 50 && r.landing?.devBomb === 50
  && nearPx(L.bombBookOne?.point?.x, 1500) && nearPx(L.bombBookOne?.point?.y, 500),
  `missed by 1 from 500 m -> ${L.bombBookOne?.deviationM} m due east -> (${L.bombBookOne?.point?.x}, ${L.bombBookOne?.point?.y})`
  + ` [MM p.9: 1 x 10 x (500/100) = 50 m; the same figure straight off bombDeviationM: ${r.landing?.devBomb}]`);

console.log("\n§14 — the defaulted arguments, pinned as a contract");
// ⚠ SCOPE NOTE. Several of these defaults are not reachable from any shipped call site — they pin
// the FUNCTION'S CONTRACT, not a live path, and are here because a silently drifting default is
// exactly what a later caller inherits. Each leg says which kind it is.
const D = r.defaults ?? {};
check("a damage call that names no raw damage does no damage",
  D.coreNoRaw?.through === 0 && D.coreNoRaw?.newSDP === 10 && D.coreNoRaw?.destroyed === false,
  `{sp 0, SDP 10} with no rawDamage -> ${J(D.coreNoRaw)} (contract pin)`);
check("a damage call that names no armor meets no armor",
  D.coreNoSp?.spUsed === 0 && D.coreNoSp?.through === 10 && D.coreNoSp?.newSDP === 40,
  `{rawDamage 10, SDP 50} with no sp -> ${J(D.coreNoSp)} (contract pin)`);
check("a crash at no stated speed rolls no dice, and still reports its weight multiplier",
  D.crashNoSpeed?.numD6 === 0 && D.crashNoSpeed?.weightMult === 3,
  `{weightClass heavy} with no speed -> ${J(D.crashNoSpeed)} [Core p.112: "(speed/20, round down) d6" — floor(0/20) = 0] (contract pin)`);
check("a reactive array with no wear on file starts at no wear and comes away one tile down",
  D.reactiveNoWear?.subtract === 0 && D.reactiveNoWear?.deflected === true && D.reactiveNoWear?.newHits === 1,
  `{installed, heat, die 2} with no priorHits -> ${J(D.reactiveNoWear)} [MM p.23: a fresh array]`);
check("a severity call that names no penetration does not penetrate one point of armor",
  D.sevNoPen?.penetrated === false && D.sevNoPen?.severity === "noPenetration" && D.sevNoPen?.diff === -1,
  `{AV 1, die 5} with no pen -> ${J(D.sevNoPen)} [MM p.4: "Pen - AV: < 0 -> no penetration"] (contract pin)`);
check("a surface roll that names no base penetration damages the item without destroying it",
  D.surfNoBasePen?.itemDamaged === true && D.surfNoBasePen?.destroyed === false,
  `die 9 with no basePen -> ${J(D.surfNoBasePen)} [MM p.4: "base Pen 3+ destroys"] (contract pin)`);
check("a hit-location roll with no usable die reads the LOW end of the table, not the second row",
  J(D.locNoDie) === J(["Fuel", "Fuel", "Fuel"]) && D.locNoDieSide === "Fuel",
  `undefined / NaN / "x" -> ${J(D.locNoDie)}; the same on a side hit -> ${D.locNoDieSide} [MM p.7: "-1,0 Fuel"]`);
check("a sub-location roll with no usable die reads the first row of either sub-table",
  J(D.subNoDie) === J(["Cargo/Ammo", "Cargo/Ammo"]),
  `Hull front and Turret rear with no die -> ${J(D.subNoDie)} [MM p.7: "0-2 Cargo/Ammo"] (contract pin)`);
check("a damage-control roll with no usable die does NOT swallow the hit",
  J(D.dcNoDie) === J([false, false]),
  `undefined / NaN -> ${J(D.dcNoDie)} [MM p.4: "ignored on 1d10 of 6-10" — nothing is not a six] (contract pin)`);
check("a deviation vector with nothing named is the zero vector on the first heading",
  D.vecNoArgs?.dx === 0 && D.vecNoArgs?.dy === 0 && D.vecNoArgs?.distanceM === 0 && D.vecNoArgs?.dirDeg === 0,
  `no arguments -> ${J(D.vecNoArgs)}`);
check("a deviation vector with a distance but no rolled face uses the FIRST heading, due east",
  D.vecNoDie?.dirDeg === 0 && nearPx(D.vecNoDie?.dx, 100) && nearPx(D.vecNoDie?.dy, 0),
  `{distanceM 100} with no d10 -> ${J(D.vecNoDie)} (the rose's face 1 is 0°, so the whole distance is on x)`);
check("a warhead profile with no penetration named carries no penetration",
  D.warheadNoPen?.pen === 0 && D.warheadNoPen?.burstM === 4 && D.warheadNoPen?.heat === true,
  `heat with burst 4 and no pen -> ${J(D.warheadNoPen)} [MM p.21: "HEAT: reduce the Burst to 4m" — the filler changes burst, it does not grant penetration] (contract pin)`);
check("each unnamed term of the spotter bonus contributes ZERO, so a single odd point never rounds up to one",
  D.bonusNoSpotterHW === 0 && D.bonusNoSpotterINT === 0 && D.bonusNoFirerHW === 2,
  `INT 1 alone -> ${D.bonusNoSpotterHW}; HW 1 alone -> ${D.bonusNoSpotterINT}; HW 2 + INT 2 with no firer -> ${D.bonusNoFirerHW}`
  + ` [MM p.8: "Spotter's (Heavy Weapons + INT)/2" + "Firer's Heavy Weapons/2"; the module floors both halves]`);
check("the fall loop stops at ten thousand turns and takes not one more step",
  D.fallGuardAt === 10000 && D.fallGuardUnder === 9999,
  `a drop of 1 750 001 m -> ${D.fallGuardAt} turns (the runaway guard bites with 1 m still to fall);`
  + ` a drop of 1 749 825 m -> ${D.fallGuardUnder} turns (it lands on its own) [code-only guard, no book counterpart]`);

/* ══════════════ phase 2 — the live resolver, driven by a forced die queue ══════════════ */

const live = await page.evaluate(async ({ SCOPE }) => {
  const out = { selfCheck: null, err: null, msgIds: [], cleanupIds: [] };
  const origRU = CONFIG.Dice.randomUniform;
  const settingsWas = {};
  const remember = async (k, v) => { try { settingsWas[k] = game.settings.get(SCOPE, k); await game.settings.set(SCOPE, k, v); } catch {} };
  const Q = [];
  // v14 maps the uniform INVERTED onto the faces: to force face k on an N-sided die, queue
  // u = 1 - (k - 0.5)/N. The self-check below proves the mapping before anything trusts the queue.
  const force = (k, N = 10) => Q.push(1 - (k - 0.5) / N);

  try {
    CONFIG.Dice.randomUniform = () => (Q.length ? Q.shift() : 0.05);

    // --- self-check: the queue really lands the faces it names, on both die sizes used below.
    force(7); const s1 = (await new Roll("1d10").evaluate()).total;
    force(3); const s2 = (await new Roll("1d10").evaluate()).total;
    force(1); const s3 = (await new Roll("1d10").evaluate()).total;
    force(10); const s4 = (await new Roll("1d10").evaluate()).total;
    force(42, 100); const s5 = (await new Roll("1d100").evaluate()).total;
    out.selfCheck = { d10a: s1, d10b: s2, d10c: s3, d10d: s4, d100: s5 };
    Q.length = 0;
    if (!(s1 === 7 && s2 === 3 && s3 === 1 && s4 === 10 && s5 === 42)) return out;

    // ⏪ the vehicle-damage gate retired 2026-08-29 (settings-trim): the lane is unconditional.
    await remember("vehicleMoraleEnabled", false);
    await remember("vehicleArmorDamageEnabled", false);

    const VD = await import("/modules/cp2020-augmented/module/vehicle/vehicle-damage.js");
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__VDMLive"))) await a.delete().catch(() => {});
    const mk = async (name, system) => Actor.create({ name, type: `${SCOPE}.vehicle`, system });
    const before = new Set(game.messages.map(m => m.id));

    // A. penetrating major -> hull -> crew. SP 200 front = AV 10; SDP 100 = Body 5.
    //    base Pen 20 at normal range, front facing: margin 10; die 1 -> score 1+10-5 = 6 = major.
    const vA = await mk("__PW__VDMLive A", { sp: { front: 200, side: 200, rear: 200, top: 200, bottom: 200 }, sdp: { value: 100, max: 100 } });
    Q.length = 0; force(1); force(5); force(5);          // severity, hit location, sub-location
    out.A = await VD.applyVehicleDamageMM(vA, { basePen: 20, facing: "front" });
    out.Adamaged = [...(game.actors.get(vA.id).system.damagedSystems ?? [])];
    out.Aqueue = Q.length;

    // B. rear flank + fuel fire. SP 100 rear = AV 5, halved by the rear flank = 3.
    //    base Pen 10: margin 7; die 1 -> score 1+7-5 = 3 = minor; location die 1 shifted -2 = fuel;
    //    the fuel percentile lands on 20, inside the minor row's 25%.
    const vB = await mk("__PW__VDMLive B", { sp: { front: 100, side: 100, rear: 100, top: 100, bottom: 100 }, sdp: { value: 100, max: 100 } });
    Q.length = 0; force(1); force(1); force(20, 100);
    out.B = await VD.applyVehicleDamageMM(vB, { basePen: 10, facing: "rear" });
    out.BonFire = game.actors.get(vB.id).system.onFire === true;
    out.Bqueue = Q.length;

    // C. damage control swallows the hit on a six; the same hit lands on a five.
    const vC = await mk("__PW__VDMLive C", { sp: { front: 200, side: 200, rear: 200, top: 200, bottom: 200 }, sdp: { value: 100, max: 100 }, damageControl: true });
    Q.length = 0; force(1); force(2); force(6);          // severity, motive-gear location, damage control
    out.C6 = await VD.applyVehicleDamageMM(vC, { basePen: 20, facing: "front" });
    out.C6immobilized = game.actors.get(vC.id).system.immobilized === true;
    out.C6damaged = [...(game.actors.get(vC.id).system.damagedSystems ?? [])];
    Q.length = 0; force(1); force(2); force(5);
    out.C5 = await VD.applyVehicleDamageMM(vC, { basePen: 20, facing: "front" });
    out.C5immobilized = game.actors.get(vC.id).system.immobilized === true;
    out.C5damaged = [...(game.actors.get(vC.id).system.damagedSystems ?? [])];

    // D. powered armor carries the same armor on every side; a plain vehicle does not.
    //    Front SP 200 = AV 10, rear SP 20 = AV 1. Struck from the rear, base Pen 1 (stopped either way).
    const vD = await mk("__PW__VDMLive D", { isACPA: true, str: 40, sp: { front: 200, side: 200, rear: 20, top: 20, bottom: 20 } });
    Q.length = 0; force(1); force(1);                    // severity, surface roll
    out.D = await VD.applyVehicleDamageMM(vD, { basePen: 1, facing: "rear" });
    const vE = await mk("__PW__VDMLive E", { sp: { front: 200, side: 200, rear: 20, top: 20, bottom: 20 }, sdp: { value: 100, max: 100 } });
    Q.length = 0; force(1); force(1);
    out.E = await VD.applyVehicleDamageMM(vE, { basePen: 1, facing: "rear" });

    // INFORMATIONAL probe: which armor source a bottom hit reads (front SP 200 vs bottom SP 40).
    const vF = await mk("__PW__VDMLive F", { sp: { front: 200, side: 200, rear: 200, top: 200, bottom: 40 }, sdp: { value: 100, max: 100 } });
    Q.length = 0; force(1); force(1);
    out.F = await VD.applyVehicleDamageMM(vF, { basePen: 1, facing: "bottom" });

    out.msgIds = game.messages.filter(m => !before.has(m.id)).map(m => m.id);
    out.cleanupIds = [vA.id, vB.id, vC.id, vD.id, vE.id, vF.id];
  } catch (e) { out.err = String(e?.stack ?? e); }
  finally {
    CONFIG.Dice.randomUniform = origRU;
    for (const [k, v] of Object.entries(settingsWas)) { try { await game.settings.set(SCOPE, k, v); } catch {} }
    out.settingsWas = settingsWas;
    out.randomUniformRestored = CONFIG.Dice.randomUniform === origRU;
  }
  return out;
}, { SCOPE });

console.log("\n§10 — the pure tables wired to real dice");
if (live.err) console.log("  PHASE 2 THREW:", live.err);
check("the forced die queue lands the faces it names before anything relies on it",
  live.selfCheck?.d10a === 7 && live.selfCheck?.d10b === 3 && live.selfCheck?.d10c === 1
  && live.selfCheck?.d10d === 10 && live.selfCheck?.d100 === 42,
  `queued 7/3/1/10 on a d10 and 42 on a d100 -> ${J(live.selfCheck)}`);
check("a penetrating hit reports the same margin, severity and score the table computes by hand",
  live.A?.pen === 20 && live.A?.effAV === 10 && live.A?.severity === "major" && live.A?.score === 6,
  `base Pen 20 vs SP 200 front (AV 10), Body 5, die 1 -> pen ${live.A?.pen} / AV ${live.A?.effAV} / ${live.A?.severity} score ${live.A?.score}`);
check("the sub-location the resolver records is the one the sub-table names for that die",
  J(live.Adamaged) === J(["Crew"]) && live.Aqueue === 0,
  `hull die 5, sub die 5 shifted +1 front -> recorded ${J(live.Adamaged)}; ${live.Aqueue} unused dice left in the queue`);
check("a rear hit halves the rear armor value before the comparison",
  live.B?.effAV === 3 && live.B?.severity === "minor" && live.B?.score === 3,
  `SP 100 rear = AV 5, rear flank -> ${live.B?.effAV}; score ${live.B?.score} -> ${live.B?.severity}`);
check("a fuel hit on a minor result ignites on a percentile inside the printed one-in-four",
  live.BonFire === true,
  `location die 1 shifted -2 = Fuel; percentile 20 vs the minor row's 25% -> on fire ${live.BonFire}`);
check("damage control swallows the hit on a six and the vehicle keeps moving",
  live.C6immobilized === false && J(live.C6damaged) === J([]),
  `motive-gear hit, damage-control die 6 -> immobilized ${live.C6immobilized}, systems ${J(live.C6damaged)}`);
check("NEGATIVE: the same hit with a five is not swallowed and the vehicle is immobilised",
  live.C5immobilized === true && J(live.C5damaged) === J(["Motive Gear"]),
  `motive-gear hit, damage-control die 5 -> immobilized ${live.C5immobilized}, systems ${J(live.C5damaged)}`);
check("powered armor meets the same armor value from every direction",
  live.D?.isACPA === true && live.D?.effAV === 10,
  `front SP 200 / rear SP 20, struck from the rear -> AV ${live.D?.effAV} (the front value, unreduced) [MM p.4: "ACPA equal all sides"]`);
check("NEGATIVE: a plain vehicle struck in the same place reads its own rear plate, halved",
  live.E?.isACPA === false && live.E?.effAV === 1,
  `rear SP 20 = AV 1, rear flank halves to ${live.E?.effAV}`);
// ⏪ RESOLVED 2026-08-19 by the p.6 TEXT LAYER, read in context: "Note that AVs have bottom armor
// equal to front armor, and ACPA suits have equal armor in all directions" is a CLASS note (Aerodyne
// Vehicles / ACPA), parallel-constructed — NOT a general Armor Value rule. The general rule is the
// sentence before it: bottom/top/back = 50% (round up) of the target's armor, i.e. the plate that was
// hit. The module's read of the BOTTOM plate is therefore book-correct and asserted here. The
// unimplemented aerodyne-class substitution is queued post-release (earmark-mm-collision-rules).
check("a bottom hit resolves against the bottom plate at half armor (the class note governs AVs/ACPA, not the rule)",
  live.F?.effAV === 1,
  `front SP 200 / bottom SP 40 -> effective AV ${live.F?.effAV} (bottom plate AV 2, halved, round up) [MM p.6 text layer §2C]`);

console.log("\n§11 — teardown");
const cleanup = await page.evaluate(async ({ ids, msgIds }) => {
  const out = {};
  for (const id of msgIds ?? []) await game.messages.get(id)?.delete().catch(() => {});
  for (const id of ids ?? []) await game.actors.get(id)?.delete().catch(() => {});
  for (const a of game.actors.filter(a => a.name?.startsWith("__PW__VDM"))) await a.delete().catch(() => {});
  out.strays = game.actors.filter(a => a.name?.startsWith("__PW__VDM")).map(a => a.name);
  const get = (k) => { try { return game.settings.get("cp2020-augmented", k); } catch { return "unregistered"; } };
  out.settings = { morale: get("vehicleMoraleEnabled"), armorErosion: get("vehicleArmorDamageEnabled") };
  return out;
}, { ids: [...(r.cleanupIds ?? []), ...(live.cleanupIds ?? [])], msgIds: live.msgIds ?? [] });
check("every fixture this suite created is gone", (cleanup.strays?.length ?? 1) === 0, J(cleanup.strays));
check("the world settings this suite moved are back on the values it found, not on its own",
  // ⏪ 3 → 2 (2026-08-29, settings-trim): the vehicle-damage gate is retired, so this suite moves
  //    two world values instead of three.
  Object.keys(live.settingsWas ?? {}).length === 2
  && cleanup.settings?.morale === live.settingsWas?.vehicleMoraleEnabled
  && cleanup.settings?.armorErosion === live.settingsWas?.vehicleArmorDamageEnabled,
  `found ${J(live.settingsWas)} -> left ${J(cleanup.settings)}`);
check("the die source the suite overrode is back on the engine's own generator",
  live.randomUniformRestored === true, String(live.randomUniformRestored));

check("0 console errors", errors.length === 0, errors.slice(0, 5).join(" | "));

// Vacuity guard: a harness that silently skipped a phase must not read as a clean run.
const EXPECTED_LEGS = 76;
const ran = pass + fail;
console.log(`\n${ran >= EXPECTED_LEGS ? "PASS" : "FAIL"}: the suite ran its full leg count — ${ran} of at least ${EXPECTED_LEGS}`);
const vacuous = ran < EXPECTED_LEGS;

console.log(`\n${fail === 0 && !vacuous ? "PASS" : "FAIL"} — ${pass}/${ran} checks`);
await browser.close();
process.exit(fail === 0 && !vacuous ? 0 : 1);
