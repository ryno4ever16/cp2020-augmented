/**
 * KEEPER: the four uncovered deterministic number-producers behind the money/damage paths.
 *
 *   §1 vehicle-indirect.js  — shellTravelTurns · indirectToHitNumber · indirectToHitBonus
 *                             · indirectDeviationM · bombDeviationM · deviationVector
 *   §2 vehicle-control.js   — resolveControlRoll · coreControlLoss · coreSpeedPenalty · mmSpeedDV
 *                             · isAircraft (BOTH rule systems) + composeControlOutcome's dice wiring
 *   §2b                     — defaultControlMod: BOTH prefill tables row by row, and the SELECTION
 *                             between them (which table a rule system reads)
 *   §2c                     — the speed guards read AT their boundaries (zero speed, a safe/top
 *                             speed of one, exactly half top speed)
 *   §2d                     — the loss tables' defaulted dice + the Core crash gate's four quadrants
 *   §3 vehicle-targeting.js — computeFacing · detectFacingFromTokens (real tokens on the live
 *                             scene) · rangeBand
 *   §4 save-rolls.js        — getDeathThreshold, against real actors across the whole wound ladder,
 *                             cross-checked against the BASE system's independent deathThreshold()
 *                             and against the number the live save card actually prints.
 *
 * ⛔ SOURCE DISCIPLINE. Every pinned expectation is derived from a source independent of the
 * implementation and carries its citation in the leg's detail string:
 *   [MM p.N]    Maximum Metal, via memory reference-file `maximum-metal-reference.md`
 *   [Core p.N]  CP2020 core, via `core-rules-reference.md` / `core-read-fulldetail.md`
 *   [design]    `vehicle-combat-design.md` (the recorded user-confirmed decision)
 *   [base]      the base cyberpunk2020 system's own independent implementation
 *   [geometry]  a mathematical property of the transform, not a value read off the code
 * Where a number exists ONLY in the implementation (rounding direction, band cutoffs, the
 * d10→heading mapping, defaults) the leg asserts a PROPERTY instead of pinning the value, and
 * says so in its name. Those gaps are listed in import-staging/COVERAGE-ROUND-BUILD.md.
 *
 * ── §2b/§2c/§2d were added 2026-08-18 to close mutation-survivor blind spots in
 *    module/vehicle/vehicle-control.js (import-staging/assurance/merged-results.jsonl). This suite
 *    is the oracle the mutant subset runs for that file (import-staging/assurance/suites-control.txt).
 *
 * ── ACCEPTED EQUIVALENTS in vehicle-control.js — surviving mutants that NO assertion can kill,
 *    because the mutated code produces identical output on every input. Each was proved by sweeping
 *    the mutated variant against the original across the whole argument domain, not by inspection:
 *      m090 coreSpeedPenalty `s <= 0` → `s < 0` — the only input the two guards disagree on is
 *           s === 0, and a speed of zero falls through the ladder to a ratio of 0, which returns 0
 *           anyway. The guard is a short-circuit, not a decision.
 *      m103 mmSpeedDV `s <= 0` → `s < 0` — same shape: s === 0 falls through to `s <= halfTop`,
 *           which is true for every positive top speed, so it returns 0 either way.
 *      m105 mmSpeedDV `s <= halfTop` → `s < halfTop` — at s === halfTop exactly the else-branch
 *           computes floor((halfTop - halfTop) / (top x 0.10)) = floor(0) = 0, the same answer.
 *           §2c asserts the boundary anyway: it pins the ANSWER, which a later change to the step
 *           formula could move even though this operator cannot.
 *      m132 coreControlLoss `Number(d6) || 0` → `|| 1` — the fallback picks 0 or 1 and the first
 *           band is `r <= 2`, so both land on the identical "1-2" row object.
 *      m141 mmFailureTable `Number(tableRoll) || 0` → `|| 1` — same, against the `r <= 4` band.
 *      m159 composeControlOutcome `tableD6 >= 5 && !aircraft` → `>= 5 || !aircraft` — a real
 *           FINDING, not just an equivalence: the crash total this gate computes is passed to
 *           coreControlLoss as `crashDamage`, and coreControlLoss reads that field ONLY on the
 *           ground 5-6 branch — exactly the case the gate admits. The gate is therefore a redundant
 *           pre-filter over a condition the callee already enforces, and widening it to `||`
 *           changes nothing a caller can see. §2d asserts all four quadrants regardless, so the
 *           day either side of that duplication moves, one of them goes red.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const near = (a, b, eps = 1e-9) => Number.isFinite(a) && Math.abs(a - b) <= eps;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
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

/* ══════════════════════════ phase 1 — the pure transforms, computed TWICE ══════════════════════════ */

const pure = await page.evaluate(async () => {
  const IND = await import("/modules/cp2020-augmented/module/vehicle/vehicle-indirect.js");
  const CTL = await import("/modules/cp2020-augmented/module/vehicle/vehicle-control.js");
  const TGT = await import("/modules/cp2020-augmented/module/vehicle/vehicle-targeting.js");

  const compute = () => {
    const o = {};

    /* ---------------- §1 indirect ---------------- */
    o.travel = {
      artilleryRate: [600, 601, 1200, 1201, 1800].map(r => IND.shellTravelTurns(r, "artillery")),
      mortarRate:    [400, 401, 800, 801].map(r => IND.shellTravelTurns(r, "mortar")),
      grenadeRate:   IND.shellTravelTurns(800, "grenade"),
      defaultKind:   IND.shellTravelTurns(1200),
      artilleryVsMortar: [300, 700, 1500, 2400].map(r =>
        IND.shellTravelTurns(r, "artillery") <= IND.shellTravelTurns(r, "mortar")),
      monotone: (() => {
        let okAll = true, prev = -Infinity;
        for (let r = 0; r <= 3000; r += 25) { const t = IND.shellTravelTurns(r, "artillery"); if (t < prev) okAll = false; prev = t; }
        return okAll;
      })(),
      zero: IND.shellTravelTurns(0, "artillery"),
      negative: IND.shellTravelTurns(-500, "artillery"),
      nonNumeric: IND.shellTravelTurns("not-a-number", "artillery"),
      missingArgs: IND.shellTravelTurns(),
    };

    o.toHitNumber = {
      firstShot: IND.indirectToHitNumber(),
      explicitNotRangedIn: IND.indirectToHitNumber({ alreadyRangedIn: false }),
      rangedIn: IND.indirectToHitNumber({ alreadyRangedIn: true }),
    };

    o.spotterBonus = {
      evenTerms: IND.indirectToHitBonus({ spotterHW: 6, spotterINT: 8, firerHW: 4, mods: 0 }),
      spotterBusyErrata: IND.indirectToHitBonus({ spotterHW: 6, spotterINT: 8, firerHW: 4, mods: -10 }),
      zeros: IND.indirectToHitBonus(),
      allZeroExplicit: IND.indirectToHitBonus({ spotterHW: 0, spotterINT: 0, firerHW: 0, mods: 0 }),
      oddTerms: IND.indirectToHitBonus({ spotterHW: 7, spotterINT: 8, firerHW: 5, mods: 0 }),
      oddTermsExact: (7 + 8) / 2 + 5 / 2,
      nonNumeric: IND.indirectToHitBonus({ spotterHW: "x", spotterINT: null, firerHW: undefined, mods: "y" }),
      monotoneInSpotter: (() => {
        let okAll = true, prev = -Infinity;
        for (let hw = 0; hw <= 20; hw += 2) { const v = IND.indirectToHitBonus({ spotterHW: hw, spotterINT: 4 }); if (v < prev) okAll = false; prev = v; }
        return okAll;
      })(),
    };

    o.scatterDistance = {
      r500m4: IND.indirectDeviationM(500, 4),
      r100m1: IND.indirectDeviationM(100, 1),
      r250m2: IND.indirectDeviationM(250, 2),
      onTarget: IND.indirectDeviationM(500, 0),
      negativeMiss: IND.indirectDeviationM(500, -3),
      zeroRange: IND.indirectDeviationM(0, 5),
      bomb1000m3: IND.bombDeviationM(1000, 3),
      bomb100m1: IND.bombDeviationM(100, 1),
      bombOnTarget: IND.bombDeviationM(1000, 0),
      bombNegativeMiss: IND.bombDeviationM(1000, -2),
      bombZeroHeight: IND.bombDeviationM(0, 4),
      // the two printed formulas differ by exactly the factor 10 at equal figures
      tenFoldRatio: [[100, 1], [500, 4], [750, 3]].map(([x, m]) =>
        IND.bombDeviationM(x, m) === 10 * IND.indirectDeviationM(x, m)),
    };

    const vecs = [1,2,3,4,5,6,7,8,9,10].map(d => IND.deviationVector({ distanceM: 100, d10: d }));
    o.scatterHeading = {
      headings: vecs.map(v => v.dirDeg),
      distinct: new Set(vecs.map(v => v.dirDeg)).size,
      inRange: vecs.every(v => v.dirDeg >= 0 && v.dirDeg < 360),
      evenlySpaced: (() => {
        const s = [...vecs.map(v => v.dirDeg)].sort((a, b) => a - b);
        const gaps = s.slice(1).map((v, i) => v - s[i]);
        return gaps.every(g => Math.abs(g - gaps[0]) < 1e-9);
      })(),
      magnitudePreserved: vecs.every(v => Math.abs(Math.hypot(v.dx, v.dy) - 100) < 1e-9),
      distanceEchoed: vecs.every(v => v.distanceM === 100),
      antipodal: [0,1,2,3,4].every(i => {
        const a = vecs[i], b = vecs[i + 5];
        return Math.abs(a.dx + b.dx) < 1e-9 && Math.abs(a.dy + b.dy) < 1e-9;
      }),
      clampLow: IND.deviationVector({ distanceM: 100, d10: 0 }).dirDeg === vecs[0].dirDeg,
      clampHigh: IND.deviationVector({ distanceM: 100, d10: 11 }).dirDeg === vecs[9].dirDeg,
      zeroDistance: (() => { const v = IND.deviationVector({ distanceM: 0, d10: 3 }); return v.dx === 0 && v.dy === 0 && v.distanceM === 0; })(),
      negativeDistance: (() => { const v = IND.deviationVector({ distanceM: -50, d10: 3 }); return v.dx === 0 && v.dy === 0 && v.distanceM === 0; })(),
      noArgs: (() => { const v = IND.deviationVector(); return Number.isFinite(v.dx) && Number.isFinite(v.dy) && v.distanceM === 0; })(),
    };

    /* ---------------- §2 control ---------------- */
    o.coreSpeedPenalty = {
      atSafe: CTL.coreSpeedPenalty(50, 50),
      justUnderDouble: CTL.coreSpeedPenalty(99, 50),
      double: CTL.coreSpeedPenalty(100, 50),
      betweenDoubleTriple: CTL.coreSpeedPenalty(125, 50),
      triple: CTL.coreSpeedPenalty(150, 50),
      quadruple: CTL.coreSpeedPenalty(200, 50),
      beyondTable: CTL.coreSpeedPenalty(500, 50),
      unknownSafe: CTL.coreSpeedPenalty(100, 0),
      stationary: CTL.coreSpeedPenalty(0, 50),
      monotone: (() => {
        let okAll = true, prev = Infinity;
        for (let s = 0; s <= 400; s += 5) { const v = CTL.coreSpeedPenalty(s, 50); if (v > prev) okAll = false; prev = v; }
        return okAll;
      })(),
      neverPositive: (() => { for (let s = 0; s <= 400; s += 5) if (CTL.coreSpeedPenalty(s, 50) > 0) return false; return true; })(),
    };

    o.mmSpeedDV = {
      atHalf: CTL.mmSpeedDV(50, 100),
      justUnderOneStep: CTL.mmSpeedDV(59, 100),
      oneStep: CTL.mmSpeedDV(60, 100),
      twoSteps: CTL.mmSpeedDV(70, 100),
      atTop: CTL.mmSpeedDV(100, 100),
      overTop: CTL.mmSpeedDV(120, 100),
      belowHalf: CTL.mmSpeedDV(10, 100),
      unknownTop: CTL.mmSpeedDV(50, 0),
      stationary: CTL.mmSpeedDV(0, 100),
      scaleFree: CTL.mmSpeedDV(140, 200) === CTL.mmSpeedDV(70, 100),
      monotone: (() => {
        let okAll = true, prev = -Infinity;
        for (let s = 0; s <= 200; s += 2) { const v = CTL.mmSpeedDV(s, 100); if (v < prev) okAll = false; prev = v; }
        return okAll;
      })(),
      neverNegative: (() => { for (let s = 0; s <= 200; s += 2) if (CTL.mmSpeedDV(s, 100) < 0) return false; return true; })(),
    };

    const AIR = ["av-4", "av-6", "av-7", "av", "rotor", "heli", "osprey", "plane", "jet", "airship"];
    const GROUND = ["car", "sportscar", "limo", "pickup", "truck", "cycle", "motorcycle", "apc", "ifv", "mbt", "tank", "hover", "boat"];
    o.isAircraft = {
      airAll: AIR.map(t => [t, CTL.isAircraft(t)]),
      groundAll: GROUND.map(t => [t, CTL.isAircraft(t)]),
      caseInsensitive: CTL.isAircraft("AV-4") === CTL.isAircraft("av-4") && CTL.isAircraft("AV-4") === true,
      empty: CTL.isAircraft(""),
      nullish: CTL.isAircraft(null),
      undef: CTL.isAircraft(undefined),
      numeric: CTL.isAircraft(4),
      catalogueTypes: ["Light Helicopter", "Heavy Plane", "Small Jet", "Large Jet", "Osprey"].map(t => CTL.isAircraft(t)),
    };

    o.controlDV = { ...CTL.CONTROL_DV };

    // Core: a clear pass at Simple, with the sportscar handling modifier folded into the ROLL.
    o.coreRoll = {
      clearPass: CTL.resolveControlRoll({ ruleSystem: "Core", difficulty: "simple", d10: 5, ref: 8, skill: 4, handlingMod: 2 }),
      // the same roll at 4x safe speed: the over-speed modifier lands on the roll, not the DV
      overSpeed: CTL.resolveControlRoll({ ruleSystem: "Core", difficulty: "simple", d10: 5, ref: 8, skill: 4, handlingMod: 2, currentSpeed: 200, safeSpeed: 50 }),
      hardFail: CTL.resolveControlRoll({ ruleSystem: "Core", difficulty: "veryDifficult", d10: 1, ref: 3, skill: 0 }),
      exactlyOnDV: CTL.resolveControlRoll({ ruleSystem: "Core", difficulty: "simple", d10: 5, ref: 6, skill: 4 }),
      oneUnderDV: CTL.resolveControlRoll({ ruleSystem: "Core", difficulty: "simple", d10: 4, ref: 6, skill: 4 }),
      difficultDV: CTL.resolveControlRoll({ ruleSystem: "Core", difficulty: "difficult", d10: 1, ref: 0, skill: 0 }).dv,
      veryDifficultDV: CTL.resolveControlRoll({ ruleSystem: "Core", difficulty: "veryDifficult", d10: 1, ref: 0, skill: 0 }).dv,
      unknownDifficultyDV: CTL.resolveControlRoll({ ruleSystem: "Core", difficulty: "not-a-band", d10: 1, ref: 0, skill: 0 }).dv,
      // the Maximum Metal condition switches are inert under Core
      mmSwitchesInert: CTL.resolveControlRoll({ ruleSystem: "Core", difficulty: "simple", d10: 5, ref: 6, skill: 4,
        cantSee: true, multitask: true, slippery: true, icy: true, cyberlink: true, currentSpeed: 100, topSpeed: 100 }),
      noArgs: CTL.resolveControlRoll(),
    };

    // Maximum Metal: conditions raise the DV; the cyberlink bonus raises the ROLL.
    o.mmRoll = {
      base: CTL.resolveControlRoll({ ruleSystem: "MaximumMetal", difficulty: "simple", d10: 6, ref: 8, skill: 5 }),
      speedOnDV: CTL.resolveControlRoll({ ruleSystem: "MaximumMetal", difficulty: "simple", d10: 6, ref: 8, skill: 5, currentSpeed: 100, topSpeed: 100 }),
      allConditions: CTL.resolveControlRoll({ ruleSystem: "MaximumMetal", difficulty: "simple", d10: 6, ref: 8, skill: 5,
        cantSee: true, multitask: true, slippery: true, icy: true, cyberlink: true }),
      cyberlinkOnly: CTL.resolveControlRoll({ ruleSystem: "MaximumMetal", difficulty: "simple", d10: 6, ref: 8, skill: 5, cyberlink: true }),
      // safeSpeed is a Core-only reference figure — Maximum Metal reads topSpeed
      safeSpeedInert: CTL.resolveControlRoll({ ruleSystem: "MaximumMetal", difficulty: "simple", d10: 6, ref: 8, skill: 5, currentSpeed: 200, safeSpeed: 50 }),
    };

    o.coreLoss = {
      one:   CTL.coreControlLoss(1, { slideDie: 7 }),
      two:   CTL.coreControlLoss(2, { slideDie: 7 }),
      three: CTL.coreControlLoss(3, { slideDie: 7 }),
      four:  CTL.coreControlLoss(4, { slideDie: 7 }),
      five:  CTL.coreControlLoss(5, { slideDie: 7, crashDamage: 18 }),
      six:   CTL.coreControlLoss(6, { slideDie: 7, crashDamage: 18 }),
      airThree: CTL.coreControlLoss(3, { aircraft: true, slideDie: 7 }),
      airFive:  CTL.coreControlLoss(5, { aircraft: true, slideDie: 7, crashDamage: 18 }),
      bands: [0,1,2,3,4,5,6,7].map(d => CTL.coreControlLoss(d, { slideDie: 1 }).band),
      noArgs: CTL.coreControlLoss(),
    };

    o.mmLoss = {
      one:  CTL.mmFailureTable(1, { skidDie: 4 }),
      four: CTL.mmFailureTable(4, { skidDie: 4 }),
      five: CTL.mmFailureTable(5, { skidDie: 4 }),
      six:  CTL.mmFailureTable(6, { skidDie: 4 }),
      seven: CTL.mmFailureTable(7, { skidDie: 4 }),
      twelve: CTL.mmFailureTable(12, { skidDie: 4 }),
      airFive: CTL.mmFailureTable(5, { aircraft: true, skidDie: 4 }),
      airSeven: CTL.mmFailureTable(7, { aircraft: true, skidDie: 4 }),
      bands: [1,2,3,4,5,6,7,8,20].map(r => CTL.mmFailureTable(r, { skidDie: 1 }).band),
    };

    // NOTE: the rolled d10 belongs in the DICE argument — composeControlOutcome overrides any d10
    // passed among the params with `dice.d10 ?? 0`.
    o.compose = {
      success: CTL.composeControlOutcome({ ruleSystem: "Core", difficulty: "simple", ref: 8, skill: 4 }, { d10: 9, tableD6: 6, slideD10: 9, crashD6Total: 20 }),
      coreGroundRoll: CTL.composeControlOutcome({ ruleSystem: "Core", difficulty: "veryDifficult", vehicleType: "car", ref: 2, skill: 0 }, { d10: 1, tableD6: 5, slideD10: 3, crashD6Total: 18 }),
      coreAirSpin: CTL.composeControlOutcome({ ruleSystem: "Core", difficulty: "veryDifficult", vehicleType: "av-4", ref: 2, skill: 0 }, { d10: 1, tableD6: 5, slideD10: 3, crashD6Total: 18 }),
      // MM escalation: table roll = 1d6 + one step per full 3 points missed by
      mmEscalation: CTL.composeControlOutcome({ ruleSystem: "MaximumMetal", difficulty: "simple", vehicleType: "car", ref: 0, skill: 0 }, { d10: 1, tableD6: 2, slideD10: 5 }),
      mmSmallMiss: CTL.composeControlOutcome({ ruleSystem: "MaximumMetal", difficulty: "simple", vehicleType: "car", ref: 5, skill: 4 }, { d10: 4, tableD6: 2, slideD10: 5 }),
      // the params' own d10 is inert: the dice argument is the single source of the rolled face
      paramD10Ignored: CTL.composeControlOutcome({ ruleSystem: "Core", difficulty: "simple", ref: 8, skill: 4, d10: 9 }, { tableD6: 1, slideD10: 1 }).result.total,
    };

    /* --- §2b the per-type handling prefill, both tables, and the SELECTION between them --- */
    const DCM = (t, sys) => CTL.defaultControlMod(t, sys);
    const mapOf = (keys, sys) => Object.fromEntries(keys.map(k => [k, DCM(k, sys)]));
    o.controlMod = {
      // Core-mode prefill: the module's own list, kept for sheets left on the Core rule system.
      core: mapOf(["car", "sportscar", "limo", "av-4", "av-6", "av-7", "cycle", "motorcycle",
                   "truck", "rotor", "osprey", "boat"], "Core"),
      // Maximum Metal mode: the p.11 REVISED CONTROL MODIFIERS table, every printed row plus the
      // footnote row plus the aliases and the two house rows.
      mm: mapOf(["car", "limo", "pickup", "cycle", "motorcycle", "truck",
                 "apc", "ifv", "mbt", "tank", "hover",
                 "av", "av-4", "av-6", "av-7", "osprey", "airship",
                 "light helicopter", "lt heli", "lheli",
                 "medium helicopter", "heavy helicopter", "med heli", "hvy heli", "rotor",
                 "light plane", "lightplane",
                 "medium plane", "heavy plane", "med plane", "hvy plane", "plane",
                 "small jet", "large jet", "jet",
                 "wheeled apc", "wheeled ifv",
                 "boat", "sportscar"], "MaximumMetal"),
      // the SELECTION itself: types whose two tables disagree, read under each system in turn
      selection: {
        sportscar: [DCM("sportscar", "Core"), DCM("sportscar", "MaximumMetal")],
        av4:       [DCM("av-4", "Core"), DCM("av-4", "MaximumMetal")],
        av6:       [DCM("av-6", "Core"), DCM("av-6", "MaximumMetal")],
        av7:       [DCM("av-7", "Core"), DCM("av-7", "MaximumMetal")],
        rotor:     [DCM("rotor", "Core"), DCM("rotor", "MaximumMetal")],
        airship:   [DCM("airship", "Core"), DCM("airship", "MaximumMetal")],
        pickup:    [DCM("pickup", "Core"), DCM("pickup", "MaximumMetal")],
        largeJet:  [DCM("large jet", "Core"), DCM("large jet", "MaximumMetal")],
        omittedSystem: DCM("sportscar"),
        unknownSystem: DCM("sportscar", "not-a-rule-system"),
        emptySystem:   DCM("sportscar", ""),
      },
      lookup: {
        upperCase:  DCM("TRUCK", "MaximumMetal"),
        mixedCase:  DCM("Large Jet", "MaximumMetal"),
        unlisted:   DCM("hovercycle", "MaximumMetal"),
        empty:      DCM("", "MaximumMetal"),
        nullish:    DCM(null, "MaximumMetal"),
        undef:      DCM(undefined, "MaximumMetal"),
        numeric:    DCM(4, "MaximumMetal"),
      },
    };

    /* --- §2c the speed-ladder guards, read AT their boundaries --- */
    o.speedEdges = {
      coreStopped:      CTL.coreSpeedPenalty(0, 0.5),
      coreOneUnit:      CTL.coreSpeedPenalty(1, 0.5),
      coreSafeOne:      CTL.coreSpeedPenalty(4, 1),
      coreExactlySafe:  CTL.coreSpeedPenalty(50, 50),
      coreNegative:     CTL.coreSpeedPenalty(-10, 50),
      mmStopped:        CTL.mmSpeedDV(0, 1),
      mmTopOne:         CTL.mmSpeedDV(1, 1),
      mmExactlyHalf:    CTL.mmSpeedDV(50, 100),
      mmExactlyHalfOdd: CTL.mmSpeedDV(35, 70),
      mmOnePastHalf:    CTL.mmSpeedDV(51, 100),
      mmFirstFullStep:  CTL.mmSpeedDV(60, 100),
      mmNegative:       CTL.mmSpeedDV(-10, 100),
    };

    /* --- §2d the loss tables' own defaulted dice, and the Core crash gate's four quadrants --- */
    o.lossDefaults = {
      coreSkidNoSlide:  CTL.coreControlLoss(3),
      coreAirNoSlide:   CTL.coreControlLoss(3, { aircraft: true }),
      coreRollNoCrash:  CTL.coreControlLoss(5, { slideDie: 2 }),
      mmLoseNoSkid:     CTL.mmFailureTable(5),
      mmCatNoSkid:      CTL.mmFailureTable(7),
    };
    const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj ?? {}, k);
    const compose = (type, dice) => {
      const c = CTL.composeControlOutcome(
        { ruleSystem: "Core", difficulty: "veryDifficult", vehicleType: type, ref: 0, skill: 0 }, dice);
      return { aircraft: c.aircraft, success: c.result.success, band: c.outcome?.band,
               severity: c.outcome?.severity, tableTotal: c.outcome?.tableTotal,
               damage: c.outcome?.damage, hasDamage: has(c.outcome, "damage"), text: c.outcome?.text };
    };
    o.crashGate = {
      groundFive: compose("car",  { d10: 1, tableD6: 5, slideD10: 3, crashD6Total: 18 }),
      groundFour: compose("car",  { d10: 1, tableD6: 4, slideD10: 3, crashD6Total: 18 }),
      airFive:    compose("av-4", { d10: 1, tableD6: 5, slideD10: 3, crashD6Total: 18 }),
      airFour:    compose("av-4", { d10: 1, tableD6: 4, slideD10: 3, crashD6Total: 18 }),
      noTableDie: compose("car",  { d10: 1 }),
      noSlideDie: compose("car",  { d10: 1, tableD6: 3 }),
      slideSeven: compose("car",  { d10: 1, tableD6: 3, slideD10: 7 }),
      groundFiveNoCrashDie: compose("car", { d10: 1, tableD6: 5, slideD10: 3 }),
    };

    /* ---------------- §3 facing + range band (pure half) ---------------- */
    const F = (dx, dy, dz = 0, rotationDeg = 0) => TGT.computeFacing({ dx, dy, dz, rotationDeg });
    o.facing = {
      // dx,dy point from TARGET to ATTACKER. Rotation 0 = the target faces SOUTH — the core's own
      // token convention, which the module reads through vehicle-layout's headingVector — so "dead
      // ahead of an unrotated target" is due south of it and astern is due north.
      aheadOfTarget:  F(0, 100),
      asternOfTarget: F(0, -100),
      eastOfTarget:  F(100, 0),
      westOfTarget:  F(-100, 0),
      frontCorner:   F(100, 100),       // exactly 45 degrees off the nose
      rearCorner:    F(100, -100),      // exactly 135 degrees off the nose
      justInsideSide: F(100, 99),
      // rotation -90 = facing east (what the core writes for a token driven east)
      rotatedEast:   [F(100, 0, 0, -90), F(0, 100, 0, -90), F(-100, 0, 0, -90), F(0, -100, 0, -90)],
      rotatedAbout:  [F(0, -100, 0, 180), F(0, 100, 0, 180)],
      steepAbove:    F(0, -100, 200),
      steepBelow:    F(0, -100, -200),
      shallowAbove:  F(0, -100, 50),
      equalElevation: F(0, -100, 100),  // |dz| == horizontal — the strict-greater boundary
      overhead:      F(0, 0, 25),
      degenerate:    F(0, 0, 0),
      closedSet: (() => {
        const seen = new Set();
        for (let a = 0; a < 360; a++) for (const dz of [-300, -100, -20, 0, 20, 100, 300]) {
          const r = a * Math.PI / 180;
          seen.add(F(100 * Math.sin(r), -100 * Math.cos(r), dz));
        }
        return [...seen].sort();
      })(),
      arcWidths: (() => {
        const counts = { front: 0, side: 0, rear: 0, top: 0, bottom: 0 };
        for (let a = 0; a < 360; a++) {
          const r = a * Math.PI / 180;
          counts[F(100 * Math.sin(r), -100 * Math.cos(r))]++;
        }
        return counts;
      })(),
      rotationInvariance: (() => {
        // turning the target and the shot together must not change which side is struck
        for (let a = 0; a < 360; a += 7) for (const rot of [0, 37, 90, 213, 300]) {
          const r = (a) * Math.PI / 180, r2 = (a + rot) * Math.PI / 180;
          if (F(100 * Math.sin(r), -100 * Math.cos(r), 0, 0) !== F(100 * Math.sin(r2), -100 * Math.cos(r2), 0, rot)) return false;
        }
        return true;
      })(),
    };

    o.rangeBand = {
      pointBlank: TGT.rangeBand(0, 400),
      halfRange: TGT.rangeBand(200, 400),
      justOverHalf: TGT.rangeBand(200.1, 400),
      atRange: TGT.rangeBand(400, 400),
      justOverRange: TGT.rangeBand(400.1, 400),
      farBeyond: TGT.rangeBand(4000, 400),
      unknownRange: TGT.rangeBand(500, 0),
      negativeRange: TGT.rangeBand(500, -400),
      ordered: (() => {
        const rank = { normal: 0, long: 1, extreme: 2 };
        let prev = -1;
        for (let d = 0; d <= 1000; d += 5) { const v = rank[TGT.rangeBand(d, 400)]; if (v < prev) return false; prev = v; }
        return true;
      })(),
      closedSet: (() => { const s = new Set(); for (let d = 0; d <= 1000; d += 5) s.add(TGT.rangeBand(d, 400)); return [...s].sort(); })(),
      scaleFree: [100, 400, 1000].every(r => TGT.rangeBand(r * 0.4, r) === "normal" && TGT.rangeBand(r * 0.8, r) === "long" && TGT.rangeBand(r * 1.2, r) === "extreme"),
    };

    return o;
  };

  const first = compute();
  const second = compute();
  return { first, deterministic: JSON.stringify(first) === JSON.stringify(second) };
});

const P = pure.first;

console.log("\n§1 — indirect scoring (vehicle-indirect.js)");
check("travel turns at the artillery rate: 600 m per turn",
  JSON.stringify(P.travel.artilleryRate) === JSON.stringify([1, 2, 2, 3, 3]),
  `600/601/1200/1201/1800 m -> ${P.travel.artilleryRate.join("/")} turns [MM p.8: artillery 600 m/turn]`);
check("travel turns at the mortar/grenade rate: 400 m per turn",
  JSON.stringify(P.travel.mortarRate) === JSON.stringify([1, 2, 2, 3]) && P.travel.grenadeRate === 2,
  `400/401/800/801 m -> ${P.travel.mortarRate.join("/")}; grenade 800 m -> ${P.travel.grenadeRate} [MM p.8: mortars/grenades 400 m/turn]`);
check("the two printed rates are ordered: the faster rate never takes more turns",
  P.travel.artilleryVsMortar.every(Boolean), `[MM p.8: 600 vs 400 m/turn]`);
check("travel turns never decrease as the distance grows", P.travel.monotone, "[geometry: ceil of a rising ratio]");
check("PROPERTY (code-only default): the unspecified kind resolves to the 600 m rate",
  P.travel.defaultKind === 2 && P.travel.missingArgs >= 1,
  `default at 1200 m -> ${P.travel.defaultKind} turns; no-args -> ${P.travel.missingArgs} [the book names no default; the value is the module's]`);
check("degenerate inputs still cost at least one turn (no zero/negative flight time)",
  P.travel.zero === 1 && P.travel.negative === 1 && P.travel.nonNumeric === 1,
  `0 -> ${P.travel.zero}; -500 -> ${P.travel.negative}; "not-a-number" -> ${P.travel.nonNumeric}`);

check("the first-shot target number is 25", P.toHitNumber.firstShot === 25 && P.toHitNumber.explicitNotRangedIn === 25,
  `got ${P.toHitNumber.firstShot} [MM p.8: "To-Hit 25+"]`);
check("a spot already ranged in drops the target number to 10", P.toHitNumber.rangedIn === 10,
  `got ${P.toHitNumber.rangedIn} [MM p.8: "once a shot hits, To-Hit drops to 10 for that spot"]`);

check("spotter bonus = (spotter HW + spotter INT)/2 + firer HW/2",
  P.spotterBonus.evenTerms === 9,
  `HW6+INT8 -> 7, firer HW4 -> 2, total ${P.spotterBonus.evenTerms} [MM p.8: (SpotterHW+INT)/2 + FirerHW/2 + visibility]`);
check("the errata's spotter-occupied modifier subtracts ten",
  P.spotterBonus.spotterBusyErrata === P.spotterBonus.evenTerms - 10,
  `9 with mods 0 -> ${P.spotterBonus.spotterBusyErrata} with mods -10 [MM errata p.10 fix: "doing something besides spotting" = -10, not +10]`);
check("NEGATIVE: with no spotter and no firer skill the bonus is zero",
  P.spotterBonus.zeros === 0 && P.spotterBonus.allZeroExplicit === 0 && P.spotterBonus.nonNumeric === 0,
  `no-args ${P.spotterBonus.zeros}; explicit zeros ${P.spotterBonus.allZeroExplicit}; non-numeric ${P.spotterBonus.nonNumeric}`);
check("PROPERTY (code-only rounding): halving never rounds the bonus UP, and loses under a point per halved term",
  P.spotterBonus.oddTerms <= P.spotterBonus.oddTermsExact && (P.spotterBonus.oddTermsExact - P.spotterBonus.oddTerms) < 2,
  `odd terms exact ${P.spotterBonus.oddTermsExact} -> ${P.spotterBonus.oddTerms} [the book prints no rounding direction]`);
check("the bonus never falls as the spotter's skill rises", P.spotterBonus.monotoneInSpotter, "[geometry]");

check("indirect scatter distance = missed-by x (range / 100) metres",
  P.scatterDistance.r500m4 === 20 && P.scatterDistance.r100m1 === 1 && P.scatterDistance.r250m2 === 5,
  `500 m by 4 -> ${P.scatterDistance.r500m4} m; 100 m by 1 -> ${P.scatterDistance.r100m1} m; 250 m by 2 -> ${P.scatterDistance.r250m2} m [MM p.8]`);
check("NEGATIVE: a shot that did not miss scatters zero metres",
  P.scatterDistance.onTarget === 0 && P.scatterDistance.negativeMiss === 0 && P.scatterDistance.zeroRange === 0,
  `missed-by 0 -> ${P.scatterDistance.onTarget}; missed-by -3 -> ${P.scatterDistance.negativeMiss}; range 0 -> ${P.scatterDistance.zeroRange}`);
check("bomb scatter distance = missed-by x 10 x (height / 100) metres",
  P.scatterDistance.bomb1000m3 === 300 && P.scatterDistance.bomb100m1 === 10,
  `1000 m by 3 -> ${P.scatterDistance.bomb1000m3} m; 100 m by 1 -> ${P.scatterDistance.bomb100m1} m [MM p.9: 10 m per point per 100 m of height]`);
check("NEGATIVE: a bomb that did not miss, and a zero release height, scatter zero metres",
  P.scatterDistance.bombOnTarget === 0 && P.scatterDistance.bombNegativeMiss === 0 && P.scatterDistance.bombZeroHeight === 0);
check("the two printed scatter formulas stand in a ten-fold ratio at equal figures",
  P.scatterDistance.tenFoldRatio.every(Boolean), "[MM p.8 vs p.9: (x/100) vs 10 x (x/100)]");

check("the scatter heading resolves a d10 to ten distinct headings",
  P.scatterHeading.distinct === 10 && P.scatterHeading.inRange,
  `headings ${P.scatterHeading.headings.join(",")} [MM p.8: deviation direction on the ten-face Grenade Table]`);
check("PROPERTY (code-only mapping): the ten headings are evenly spaced around the circle",
  P.scatterHeading.evenlySpaced, "[the book's table is a diagram; the 36-degree/east-origin mapping is the module's]");
check("PROPERTY: opposite faces of the die produce opposite displacement vectors", P.scatterHeading.antipodal, "[geometry]");
check("the displacement vector preserves the scatter distance exactly",
  P.scatterHeading.magnitudePreserved && P.scatterHeading.distanceEchoed, "[geometry: |v| = distance]");
check("out-of-range die faces clamp onto the table instead of leaving it",
  P.scatterHeading.clampLow && P.scatterHeading.clampHigh, "face 0 reads as 1, face 11 as 10");
check("NEGATIVE: zero, negative and missing scatter distances produce no displacement",
  P.scatterHeading.zeroDistance && P.scatterHeading.negativeDistance && P.scatterHeading.noArgs);

console.log("\n§2 — the control-loss ladder (vehicle-control.js), both rule systems");
check("the three difficulty values are 15 / 20 / 25",
  P.controlDV.simple === 15 && P.controlDV.difficult === 20 && P.controlDV.veryDifficult === 25,
  `${P.controlDV.simple}/${P.controlDV.difficult}/${P.controlDV.veryDifficult} [Core p.112 and MM p.11: Simple 15, Difficult 20, Very Difficult 25]`);
check("the difficulty values reach the resolver unchanged",
  P.coreRoll.clearPass.dv === 15 && P.coreRoll.difficultDV === 20 && P.coreRoll.veryDifficultDV === 25,
  `simple ${P.coreRoll.clearPass.dv}, difficult ${P.coreRoll.difficultDV}, very difficult ${P.coreRoll.veryDifficultDV}`);
check("PROPERTY (code-only default): an unrecognised difficulty key falls back to one of the three printed values",
  [15, 20, 25].includes(P.coreRoll.unknownDifficultyDV) && P.coreRoll.unknownDifficultyDV === 15,
  `unknown key -> ${P.coreRoll.unknownDifficultyDV} [the book names no fallback]`);

check("Core: over-safe-speed penalties are -2 / -4 / -6 at two, three and four times safe speed",
  P.coreSpeedPenalty.double === -2 && P.coreSpeedPenalty.triple === -4 && P.coreSpeedPenalty.quadruple === -6,
  `2x ${P.coreSpeedPenalty.double}, 3x ${P.coreSpeedPenalty.triple}, 4x ${P.coreSpeedPenalty.quadruple} [Core p.112]`);
check("Core: the penalty steps only on FULL multiples of safe speed",
  P.coreSpeedPenalty.justUnderDouble === 0 && P.coreSpeedPenalty.betweenDoubleTriple === -2,
  `1.98x -> ${P.coreSpeedPenalty.justUnderDouble}; 2.5x -> ${P.coreSpeedPenalty.betweenDoubleTriple}`);
check("NEGATIVE: at or below safe speed, stationary, or with no safe speed on file there is no penalty",
  P.coreSpeedPenalty.atSafe === 0 && P.coreSpeedPenalty.stationary === 0 && P.coreSpeedPenalty.unknownSafe === 0);
check("PROPERTY: the penalty never rises, never turns positive, and never passes the last printed step",
  P.coreSpeedPenalty.monotone && P.coreSpeedPenalty.neverPositive && P.coreSpeedPenalty.beyondTable === -6,
  `10x safe -> ${P.coreSpeedPenalty.beyondTable} [Core p.112's ladder ends at 4x; holding the last step is the module's reading]`);

check("Maximum Metal: +1 difficulty per full 10% of top speed above half top speed",
  P.mmSpeedDV.oneStep === 1 && P.mmSpeedDV.twoSteps === 2 && P.mmSpeedDV.atTop === 5,
  `60% -> ${P.mmSpeedDV.oneStep}, 70% -> ${P.mmSpeedDV.twoSteps}, 100% -> ${P.mmSpeedDV.atTop} [MM p.11]`);
check("Maximum Metal: a part-step over half top speed does not count",
  P.mmSpeedDV.atHalf === 0 && P.mmSpeedDV.justUnderOneStep === 0,
  `50% -> ${P.mmSpeedDV.atHalf}, 59% -> ${P.mmSpeedDV.justUnderOneStep} [MM p.11: "per full 10%"]`);
check("NEGATIVE: below half top speed, stationary, or with no top speed on file the difficulty is unraised",
  P.mmSpeedDV.belowHalf === 0 && P.mmSpeedDV.stationary === 0 && P.mmSpeedDV.unknownTop === 0);
check("PROPERTY: the speed difficulty is proportional, never falls, and never turns negative",
  P.mmSpeedDV.scaleFree && P.mmSpeedDV.monotone && P.mmSpeedDV.neverNegative,
  `70/100 and 140/200 agree at ${P.mmSpeedDV.twoSteps} [MM p.11 states the rule in percentages]`);
check("Maximum Metal: speed beyond top speed keeps counting up",
  P.mmSpeedDV.overTop === 7, `120% of top -> ${P.mmSpeedDV.overTop} [MM p.11: +1 per full 10% over the half mark]`);

const airBad = P.isAircraft.airAll.filter(([, v]) => v !== true).map(([t]) => t);
const groundBad = P.isAircraft.groundAll.filter(([, v]) => v !== false).map(([t]) => t);
check("CLOSED ENUMERATION: every airborne type in the printed vehicle-type list takes the stall/spin branch",
  airBad.length === 0, `${P.isAircraft.airAll.length} types checked; misses: ${airBad.join(",") || "none"} [MM p.12 type list: AV, Osprey, Helicopter, Plane, Jet, Airship]`);
check("CLOSED ENUMERATION: every surface type in the printed vehicle-type list takes the skid/roll branch",
  groundBad.length === 0, `${P.isAircraft.groundAll.length} types checked; misses: ${groundBad.join(",") || "none"} [MM p.12: Cycle, Car, Pickup, Truck, APC, IFV, MBT, Hover; Core p.112: boat]`);
check("the branch selector is case-insensitive and reads the catalogue's own type wording",
  P.isAircraft.caseInsensitive && P.isAircraft.catalogueTypes.every(Boolean),
  `"Light Helicopter"/"Heavy Plane"/"Small Jet"/"Large Jet"/"Osprey" all read as airborne [MM p.12 catalogue wording]`);
check("NEGATIVE: a blank, missing or non-string type does not take the stall/spin branch",
  P.isAircraft.empty === false && P.isAircraft.nullish === false && P.isAircraft.undef === false && P.isAircraft.numeric === false);

check("Core: the roll is 1d10 + REF + skill + handling and clears a Simple difficulty",
  P.coreRoll.clearPass.total === 19 && P.coreRoll.clearPass.success === true && P.coreRoll.clearPass.missedBy === 0,
  `d10 5 + REF 8 + skill 4 + handling 2 = ${P.coreRoll.clearPass.total} vs DV ${P.coreRoll.clearPass.dv} [Core p.112]`);
check("Core: over-safe-speed lands on the ROLL, leaving the difficulty alone",
  P.coreRoll.overSpeed.total === 13 && P.coreRoll.overSpeed.dv === 15 && P.coreRoll.overSpeed.success === false
  && P.coreRoll.overSpeed.rollParts.some(p => p.label === "Speed" && p.value === -6),
  `4x safe speed: total ${P.coreRoll.overSpeed.total} (was ${P.coreRoll.clearPass.total}), DV ${P.coreRoll.overSpeed.dv} [Core p.112: modifiers are added to the roll]`);
check("Core: the shortfall is reported as the gap between the total and the difficulty",
  P.coreRoll.hardFail.total === 4 && P.coreRoll.hardFail.dv === 25 && P.coreRoll.hardFail.missedBy === 21,
  `total ${P.coreRoll.hardFail.total} vs DV ${P.coreRoll.hardFail.dv} -> missed by ${P.coreRoll.hardFail.missedBy}`);
check("a total EQUAL to the difficulty succeeds; one point under fails",
  P.coreRoll.exactlyOnDV.total === 15 && P.coreRoll.exactlyOnDV.success === true && P.coreRoll.exactlyOnDV.missedBy === 0
  && P.coreRoll.oneUnderDV.total === 14 && P.coreRoll.oneUnderDV.success === false && P.coreRoll.oneUnderDV.missedBy === 1,
  `15 vs 15 -> ${P.coreRoll.exactlyOnDV.success}; 14 vs 15 -> ${P.coreRoll.oneUnderDV.success} [Core p.41 difficulty ladder is stated as "15+"]`);
check("NEGATIVE: the Maximum Metal condition switches change nothing under the Core system",
  P.coreRoll.mmSwitchesInert.dv === 15 && P.coreRoll.mmSwitchesInert.total === 15 && P.coreRoll.mmSwitchesInert.isMM === false,
  `all four conditions + cyberlink + full speed: total ${P.coreRoll.mmSwitchesInert.total}, DV ${P.coreRoll.mmSwitchesInert.dv} [Core p.112 has no such table]`);
check("NEGATIVE: an empty call produces a finite zero roll against the Simple difficulty",
  P.coreRoll.noArgs.total === 0 && P.coreRoll.noArgs.dv === 15 && P.coreRoll.noArgs.success === false && P.coreRoll.noArgs.missedBy === 15);

check("Maximum Metal: speed raises the DIFFICULTY and leaves the roll alone",
  P.mmRoll.base.total === 19 && P.mmRoll.speedOnDV.total === 19 && P.mmRoll.speedOnDV.dv === 20 && P.mmRoll.base.dv === 15,
  `at top speed: total ${P.mmRoll.speedOnDV.total} unchanged, DV 15 -> ${P.mmRoll.speedOnDV.dv} [MM p.11]`);
check("Maximum Metal: the four condition modifiers are +10 can't-see, +5 occupied, +3 slippery, +5 icy",
  P.mmRoll.allConditions.dv === 38
  && P.mmRoll.allConditions.dvParts.find(p => p.label === "Can't see")?.value === 10
  && P.mmRoll.allConditions.dvParts.find(p => p.label === "Multitasking")?.value === 5
  && P.mmRoll.allConditions.dvParts.find(p => p.label === "Slippery")?.value === 3
  && P.mmRoll.allConditions.dvParts.find(p => p.label === "Icy")?.value === 5,
  `15 + 10 + 5 + 3 + 5 = ${P.mmRoll.allConditions.dv} [MM p.11]`);
check("Maximum Metal: cyberlinked controls add +2 to the ROLL, not to the difficulty",
  P.mmRoll.cyberlinkOnly.total === 21 && P.mmRoll.cyberlinkOnly.dv === 15
  && P.mmRoll.cyberlinkOnly.rollParts.some(p => p.label === "Cyberlink" && p.value === 2),
  `total ${P.mmRoll.base.total} -> ${P.mmRoll.cyberlinkOnly.total}, DV ${P.mmRoll.cyberlinkOnly.dv} [MM p.51 / p.11]`);
check("NEGATIVE: the Core safe-speed figure is inert under Maximum Metal",
  P.mmRoll.safeSpeedInert.total === 19 && P.mmRoll.safeSpeedInert.dv === 15,
  `speed 200 against safe 50 with no top speed on file: total ${P.mmRoll.safeSpeedInert.total}, DV ${P.mmRoll.safeSpeedInert.dv} [MM p.11 reads top speed]`);

check("Core loss table 1-2: a skid with no further effect",
  P.coreLoss.one.band === "1-2" && P.coreLoss.two.band === "1-2" && P.coreLoss.one.severity === "minor" && P.coreLoss.one.damage === undefined,
  `[Core p.112: "1-2 skid, no other effect"]`);
check("Core loss table 3-4 on the ground: a sideways slide of ten feet per die face",
  P.coreLoss.three.band === "3-4" && P.coreLoss.four.band === "3-4" && /70 ft/.test(P.coreLoss.three.text),
  `die face 7 -> "${P.coreLoss.three.text.match(/slide [^ ]+ ft/)?.[0]}" [Core p.112: slide 1d10 x 10 ft]`);
check("Core loss table 3-4 in the air: a stall of fifty feet per die face",
  P.coreLoss.airThree.band === "3-4" && /350 ft/.test(P.coreLoss.airThree.text),
  `die face 7 -> ${P.coreLoss.airThree.text.match(/\d+ ft/)?.[0]} [Core p.112: aircraft stalls, 1d10 x 50 ft]`);
check("Core loss table 5-6 on the ground: the slide plus the 5d6 figure carried into the outcome",
  P.coreLoss.five.band === "5-6" && P.coreLoss.six.band === "5-6" && P.coreLoss.five.damage === 18 && /70 ft/.test(P.coreLoss.five.text),
  `[Core p.112: roll, slide 1d10 x 10 ft, then 5d6]`);
check("Core loss table 5-6 in the air: a spin of a hundred feet per die face and NO ground crash figure",
  P.coreLoss.airFive.band === "5-6" && /700 ft/.test(P.coreLoss.airFive.text) && P.coreLoss.airFive.damage === undefined,
  `die face 7 -> ${P.coreLoss.airFive.text.match(/\d+ ft/)?.[0]}, crash figure ${P.coreLoss.airFive.damage} [Core p.112: aircraft spins instead]`);
check("CLOSED ENUMERATION: every 1d6 face lands in exactly one of the three printed bands",
  JSON.stringify(P.coreLoss.bands) === JSON.stringify(["1-2","1-2","1-2","3-4","3-4","5-6","5-6","5-6"])
  && P.coreLoss.noArgs.band === "1-2",
  `faces 0-7 -> ${P.coreLoss.bands.join(" ")} [Core p.112 prints three rows]`);

check("Maximum Metal failure table 1-4: weapon fire at -5 and a difficulty-15 sideswipe check",
  P.mmLoss.one.band === "1-4" && P.mmLoss.four.band === "1-4" && /−5|-5/.test(P.mmLoss.one.text) && /15/.test(P.mmLoss.one.text),
  `[MM p.10: skid/slew, -5 fire, Difficulty 15 or sideswipe]`);
check("Maximum Metal failure table 5-6 on the ground: -10 fire, a three-metre-per-face skid, difficulty 20 to recover",
  P.mmLoss.five.band === "5-6" && P.mmLoss.six.band === "5-6" && /12 m/.test(P.mmLoss.five.text) && /−10|-10/.test(P.mmLoss.five.text) && /20/.test(P.mmLoss.five.text),
  `die face 4 -> ${P.mmLoss.five.text.match(/skids \d+ m/)?.[0]} [MM p.10]`);
check("Maximum Metal failure table 5-6 in the air: a stall of fifty feet per die face",
  /200 ft/.test(P.mmLoss.airFive.text), `die face 4 -> ${P.mmLoss.airFive.text.match(/\d+ ft/)?.[0]} [MM p.10: aircraft stalls 1d10 x 50 ft]`);
check("Maximum Metal failure table 7+: no weapon fire, a roll of three metres per face, penetration 1d6 to the thinnest armour",
  P.mmLoss.seven.band === "7+" && P.mmLoss.twelve.band === "7+" && /12 m/.test(P.mmLoss.seven.text) && /1d6/.test(P.mmLoss.seven.text),
  `[MM p.10: catastrophic, roll 1d10 x 3 m, Pen 1d6 to thinnest armour]`);
check("Maximum Metal failure table 7+ in the air: a tailspin of a hundred feet per face at difficulty 25",
  /400 ft/.test(P.mmLoss.airSeven.text) && /25/.test(P.mmLoss.airSeven.text),
  `die face 4 -> ${P.mmLoss.airSeven.text.match(/\d+ ft/)?.[0]} [MM p.10]`);
check("CLOSED ENUMERATION: every failure-table total lands in exactly one of the three printed bands",
  JSON.stringify(P.mmLoss.bands) === JSON.stringify(["1-4","1-4","1-4","1-4","5-6","5-6","7+","7+","7+"]),
  `totals 1..8,20 -> ${P.mmLoss.bands.join(" ")}`);

check("NEGATIVE: a successful control roll produces no loss-table outcome at all",
  P.compose.success.result.success === true && P.compose.success.outcome === null,
  `total ${P.compose.success.result.total} vs DV ${P.compose.success.result.dv}`);
check("Core composition: the 5d6 crash figure is spent only on a ground 5-6",
  P.compose.coreGroundRoll.outcome.damage === 18 && P.compose.coreAirSpin.outcome.damage === undefined
  && P.compose.coreAirSpin.aircraft === true && P.compose.coreGroundRoll.aircraft === false,
  `car -> ${P.compose.coreGroundRoll.outcome.damage}; AV-4 -> ${P.compose.coreAirSpin.outcome.damage} [Core p.112]`);
check("Core composition: the table total is the bare 1d6, with no shortfall escalation",
  P.compose.coreGroundRoll.outcome.tableTotal === 5,
  `d6 5, missed by ${P.compose.coreGroundRoll.result.missedBy} -> total ${P.compose.coreGroundRoll.outcome.tableTotal} [Core p.112 escalates nothing]`);
check("Maximum Metal composition: the table total gains one step per full three points missed by",
  P.compose.mmEscalation.result.missedBy === 14 && P.compose.mmEscalation.outcome.tableTotal === 6,
  `d6 2 + floor(14/3)=4 -> ${P.compose.mmEscalation.outcome.tableTotal} [MM p.10: 1d6 + 1 per full 3 missed by]`);
check("Maximum Metal composition: a near miss escalates by nothing",
  P.compose.mmSmallMiss.result.missedBy === 2 && P.compose.mmSmallMiss.outcome.tableTotal === 2,
  `missed by 2 -> total ${P.compose.mmSmallMiss.outcome.tableTotal}`);
check("the dice argument is the single source of the rolled face; a d10 among the params is inert",
  P.compose.paramD10Ignored === 12,
  `REF 8 + skill 4 + dice-less d10 -> ${P.compose.paramD10Ignored} (the params' 9 is not read)`);

console.log("\n§2b — the per-type handling prefill, row by row, and the table SELECTION");
const CM = P.controlMod ?? {};
const mm = CM.mm ?? {}, cr = CM.core ?? {};
// MM p.11 REVISED CONTROL MODIFIERS, verbatim (reprinted p.104), fifteen rows plus one footnote:
//   Standard Car -0 · AV -0 · Limousine, Pickup -3 · Osprey -0 · Cycle +1 · Light Plane -0 ·
//   Truck -4 · Med/Hvy Plane -3 · APC/IFV/MBT* +2 · Small Jet +1 · Hover -2 · Large Jet -4 ·
//   Lt. Heli -0 · Airship +5 · Med/Hvy Heli -2
//   *Wheeled APCs and IFVs handle at -2; treads are a great benefit to handling.
check("MM: the four ground rows the book prints as zero, minus three, minus four and plus one",
  mm.car === 0 && mm.limo === -3 && mm.pickup === -3 && mm.truck === -4 && mm.cycle === 1,
  `car ${mm.car} / limo ${mm.limo} / pickup ${mm.pickup} / truck ${mm.truck} / cycle ${mm.cycle}`
  + ` [MM p.11: "Standard Car -0 · Limousine, Pickup -3 · Truck -4 · Cycle +1"]`);
check("MM: tracked armour handles at plus two",
  mm.apc === 2 && mm.ifv === 2 && mm.mbt === 2 && mm.tank === 2,
  `apc ${mm.apc} / ifv ${mm.ifv} / mbt ${mm.mbt} / tank ${mm.tank} [MM p.11: "APC/IFV/MBT* +2"; "tank" is the module's alias for the MBT row]`);
check("MM: the printed footnote is its own row — a WHEELED APC or IFV handles at minus two, not plus two",
  mm["wheeled apc"] === -2 && mm["wheeled ifv"] === -2,
  `wheeled apc ${mm["wheeled apc"]} / wheeled ifv ${mm["wheeled ifv"]}`
  + ` [MM p.11 footnote: "*Wheeled APCs and IFVs handle at -2; treads are a great benefit to handling." — a four-point swing from the tracked row above]`);
check("MM: hovercraft minus two and airship plus five",
  mm.hover === -2 && mm.airship === 5,
  `hover ${mm.hover} / airship ${mm.airship} [MM p.11: "Hover -2 · Airship +5"]`);
check("MM: every aerodyne row and the Osprey are flat zero",
  mm.av === 0 && mm["av-4"] === 0 && mm["av-6"] === 0 && mm["av-7"] === 0 && mm.osprey === 0,
  `av ${mm.av} / av-4 ${mm["av-4"]} / av-6 ${mm["av-6"]} / av-7 ${mm["av-7"]} / osprey ${mm.osprey} [MM p.11: "AV -0 · Osprey -0"]`);
check("MM: the LIGHT helicopter row is zero and the medium/heavy row is minus two — two printed rows, not one",
  mm["light helicopter"] === 0 && mm["lt heli"] === 0 && mm.lheli === 0
  && mm["medium helicopter"] === -2 && mm["heavy helicopter"] === -2
  && mm["med heli"] === -2 && mm["hvy heli"] === -2,
  `lt heli ${mm["lt heli"]} vs med/hvy heli ${mm["med heli"]}/${mm["hvy heli"]}`
  + ` [MM p.11: "Lt. Heli -0" and "Med/Hvy Heli -2" — a two-point difference on every control roll a light helicopter makes]`);
check("MM: the generic rotor key takes the HEAVIER of the two helicopter readings",
  mm.rotor === -2,
  `rotor ${mm.rotor} [module reading: a sheet that says only "rotor" cannot be told apart, so it is read as the medium/heavy row]`);
check("MM: the light plane row is zero and the medium/heavy plane row is minus three",
  mm["light plane"] === 0 && mm.lightplane === 0
  && mm["medium plane"] === -3 && mm["heavy plane"] === -3 && mm["med plane"] === -3
  && mm["hvy plane"] === -3 && mm.plane === -3,
  `light plane ${mm["light plane"]} / med plane ${mm["med plane"]} / hvy plane ${mm["hvy plane"]} / bare "plane" ${mm.plane}`
  + ` [MM p.11: "Light Plane -0 · Med/Hvy Plane -3"; the bare key takes the heavier reading]`);
check("MM: a small jet is plus one and a large jet minus four — five points apart",
  mm["small jet"] === 1 && mm["large jet"] === -4 && mm.jet === 1,
  `small jet ${mm["small jet"]} / large jet ${mm["large jet"]} / bare "jet" ${mm.jet}`
  + ` [MM p.11: "Small Jet +1 · Large Jet -4"; the bare key takes the small-jet reading]`);
check("MM: the two rows with NO printed counterpart are the boat and the sportscar, and they hold the module's declared house values",
  mm.boat === -1 && mm.sportscar === 0,
  `boat ${mm.boat} / sportscar ${mm.sportscar}`
  + ` [⚠ NOT IN THE BOOK: p.11's table prints no boat row and no sportscar row. Both are inherited from the module's Core list`
  + ` (boat -1 carried over, sportscar +2 flattened to 0) so an MM-mode sheet still prefills something. Retire or re-source if a printed counterpart turns up]`);
check("Core mode keeps its OWN list, including the sportscar and aerodyne values Maximum Metal does not share",
  cr.car === 0 && cr.sportscar === 2 && cr.limo === -3 && cr["av-4"] === -2 && cr["av-6"] === 2
  && cr["av-7"] === 1 && cr.cycle === 1 && cr.motorcycle === 1 && cr.truck === -4
  && cr.rotor === 0 && cr.osprey === 0 && cr.boat === -1,
  `${JSON.stringify(cr)}`
  + ` [module contract: no printed CP2020 p.112 counterpart table is in the citation set (import-staging/mm-citation), so this leg pins the SHIPPED Core-mode prefill, not a book row]`);
check("the rule system chooses the TABLE: four types read a different modifier under each system",
  JSON.stringify(CM.selection?.sportscar) === JSON.stringify([2, 0])
  && JSON.stringify(CM.selection?.av4) === JSON.stringify([-2, 0])
  && JSON.stringify(CM.selection?.av6) === JSON.stringify([2, 0])
  && JSON.stringify(CM.selection?.av7) === JSON.stringify([1, 0]),
  `[Core, MaximumMetal] — sportscar ${JSON.stringify(CM.selection?.sportscar)}, av-4 ${JSON.stringify(CM.selection?.av4)},`
  + ` av-6 ${JSON.stringify(CM.selection?.av6)}, av-7 ${JSON.stringify(CM.selection?.av7)}`
  + ` [the two tables genuinely disagree on these rows, so reading the wrong one is visible in the prefilled number]`);
check("NEGATIVE: rows that exist under only ONE system read zero under the other",
  JSON.stringify(CM.selection?.pickup) === JSON.stringify([0, -3])
  && JSON.stringify(CM.selection?.airship) === JSON.stringify([0, 5])
  && JSON.stringify(CM.selection?.largeJet) === JSON.stringify([0, -4])
  && JSON.stringify(CM.selection?.rotor) === JSON.stringify([0, -2]),
  `pickup ${JSON.stringify(CM.selection?.pickup)}, airship ${JSON.stringify(CM.selection?.airship)},`
  + ` large jet ${JSON.stringify(CM.selection?.largeJet)}, rotor ${JSON.stringify(CM.selection?.rotor)} — Core carries none of these four`);
check("only the exact string MaximumMetal selects the MM table; anything else, including nothing, is Core",
  CM.selection?.omittedSystem === 2 && CM.selection?.unknownSystem === 2 && CM.selection?.emptySystem === 2,
  `sportscar with no system named -> ${CM.selection?.omittedSystem}, with a junk system -> ${CM.selection?.unknownSystem},`
  + ` with an empty system -> ${CM.selection?.emptySystem} (all three are the CORE value 2, not the MM value 0)`);
check("the type lookup is case-insensitive and an unlisted or absent type prefills zero",
  CM.lookup?.upperCase === -4 && CM.lookup?.mixedCase === -4 && CM.lookup?.unlisted === 0
  && CM.lookup?.empty === 0 && CM.lookup?.nullish === 0 && CM.lookup?.undef === 0 && CM.lookup?.numeric === 0,
  `"TRUCK" -> ${CM.lookup?.upperCase}, "Large Jet" -> ${CM.lookup?.mixedCase}, unlisted -> ${CM.lookup?.unlisted},`
  + ` empty/null/undefined/number -> ${CM.lookup?.empty}/${CM.lookup?.nullish}/${CM.lookup?.undef}/${CM.lookup?.numeric}`);

console.log("\n§2c — the speed guards, read AT their boundaries");
const SE = P.speedEdges ?? {};
check("Core: a stopped vehicle is never over its safe speed, however low that safe speed is",
  SE.coreStopped === 0 && SE.coreNegative === 0,
  `speed 0 against a safe speed of 0.5 -> ${SE.coreStopped}; a negative speed -> ${SE.coreNegative}`
  + ` (the safe speed is deliberately small enough that a single unit of speed would already be the 2x row, so a zero that leaked in as a one would show)`);
check("Core: one unit of speed IS a speed — at twice a safe speed of a half it is the two-times row",
  SE.coreOneUnit === -2,
  `speed 1 against safe 0.5 -> ${SE.coreOneUnit} [Core p.112: -2 at 2x safe speed; the guard is at zero, not at one]`);
check("Core: a safe speed of one is a KNOWN safe speed, not an unknown one",
  SE.coreSafeOne === -6,
  `speed 4 against safe 1 -> ${SE.coreSafeOne} [Core p.112: -6 at 4x safe speed; the "no safe speed on file" guard is at zero]`);
check("Core: exactly at safe speed there is no penalty",
  SE.coreExactlySafe === 0, `speed 50 against safe 50 -> ${SE.coreExactlySafe} [Core p.112: the ladder starts at 2x]`);
check("MM: a stopped vehicle adds no difficulty even against a top speed of one",
  SE.mmStopped === 0 && SE.mmNegative === 0,
  `speed 0 against top 1 -> ${SE.mmStopped}; a negative speed -> ${SE.mmNegative}`
  + ` (top speed 1 puts the half mark at 0.5, so a zero that leaked in as a one would score five)`);
check("MM: a top speed of one is a KNOWN top speed — running at it is a hundred percent, five full steps over the half mark",
  SE.mmTopOne === 5,
  `speed 1 against top 1 -> ${SE.mmTopOne} [MM p.11: "+1 Every 10% of a vehicle's speed over 50% of top speed"; the unknown-top guard is at zero, not at one]`);
check("MM: exactly at half top speed the difficulty is unraised, on an even and an odd top speed alike",
  SE.mmExactlyHalf === 0 && SE.mmExactlyHalfOdd === 0 && SE.mmOnePastHalf === 0,
  `50 of 100 -> ${SE.mmExactlyHalf}; 35 of 70 -> ${SE.mmExactlyHalfOdd}; 51 of 100 (one past the mark, not a full step) -> ${SE.mmOnePastHalf}`
  + ` [MM p.11: the rule counts speed OVER 50%, in FULL tenths]`);
check("MM: the first full step over the half mark scores one",
  SE.mmFirstFullStep === 1, `60 of 100 -> ${SE.mmFirstFullStep} [MM p.11]`);

console.log("\n§2d — the loss tables' defaulted dice, and the Core crash gate's four quadrants");
const LD = P.lossDefaults ?? {}, CG = P.crashGate ?? {};
check("a Core skid with no slide die rolled slides nothing, and says so",
  LD.coreSkidNoSlide?.band === "3-4" && LD.coreSkidNoSlide?.text.includes("slide 0 ft (0")
  && LD.coreAirNoSlide?.text.includes("loses 0 ft"),
  `d6 3, no slideDie -> "${LD.coreSkidNoSlide?.text}"; the aircraft branch -> "${LD.coreAirNoSlide?.text}" (contract pin)`);
check("a Core roll with no crash total rolled does no crash damage",
  LD.coreRollNoCrash?.band === "5-6" && LD.coreRollNoCrash?.damage === 0,
  `d6 5, slideDie 2, no crashDamage -> damage ${LD.coreRollNoCrash?.damage} (contract pin)`);
check("a Maximum Metal loss with no skid die rolled skids nothing",
  LD.mmLoseNoSkid?.band === "5-6" && LD.mmLoseNoSkid?.text.includes("skids 0 m (0")
  && LD.mmCatNoSkid?.band === "7+" && LD.mmCatNoSkid?.text.includes("rolls 0 m (0"),
  `table 5, no skidDie -> "${LD.mmLoseNoSkid?.text}"; table 7 -> "${LD.mmCatNoSkid?.text}" (contract pin)`);
// The crash gate reads `tableD6 >= 5 && !aircraft`. All four quadrants are asserted so the gate's
// INTENT is pinned; see the accepted-equivalents note in this file's header for why the `&&` cannot
// be caught by an output assertion.
check("GROUND, table five: the crash total is spent and the vehicle takes it",
  CG.groundFive?.aircraft === false && CG.groundFive?.band === "5-6" && CG.groundFive?.hasDamage === true
  && CG.groundFive?.damage === 18,
  `car, d6 5, 5d6 total 18 -> damage ${CG.groundFive?.damage} [Core p.112: the 5-6 ground row is the only one that takes 5d6]`);
check("GROUND, table four: one row lower there is no crash damage at all, not a zero one",
  CG.groundFour?.band === "3-4" && CG.groundFour?.hasDamage === false && CG.groundFour?.severity === "major",
  `car, d6 4 -> band ${CG.groundFour?.band}, a damage field present: ${CG.groundFour?.hasDamage} [Core p.112: 3-4 is a skid, no damage]`);
check("AIRCRAFT, table five: the same roll spins the aircraft and takes no crash damage",
  CG.airFive?.aircraft === true && CG.airFive?.band === "5-6" && CG.airFive?.hasDamage === false
  && CG.airFive?.text.includes("300 ft"),
  `AV-4, d6 5, slide 3 -> "${CG.airFive?.text}" [Core p.112: the aircraft 5-6 row is a spin of 1d10x100 ft, not a 5d6 impact]`);
check("AIRCRAFT, table four: a stall, and again no crash damage",
  CG.airFour?.aircraft === true && CG.airFour?.band === "3-4" && CG.airFour?.hasDamage === false
  && CG.airFour?.text.includes("150 ft"),
  `AV-4, d6 4, slide 3 -> "${CG.airFour?.text}" [Core p.112: 3-4 aircraft = stall, 1d10x50 ft]`);
check("with no table die rolled the composed outcome reports a table total of ZERO, not of one",
  CG.noTableDie?.success === false && CG.noTableDie?.tableTotal === 0 && CG.noTableDie?.band === "1-2",
  `a failed Core roll with dice {d10 1} only -> tableTotal ${CG.noTableDie?.tableTotal}, band ${CG.noTableDie?.band}`);
check("with no slide die rolled the composed skid slides nothing; with a seven it slides seventy feet",
  CG.noSlideDie?.text.includes("slide 0 ft (0") && CG.slideSeven?.text.includes("slide 70 ft (7"),
  `no slideD10 -> "${CG.noSlideDie?.text}"; slideD10 7 -> "${CG.slideSeven?.text}" [Core p.112: 1d10 x 10 ft]`);
check("with no crash total rolled the ground 5-6 row still reports a damage field, worth zero",
  CG.groundFiveNoCrashDie?.hasDamage === true && CG.groundFiveNoCrashDie?.damage === 0,
  `car, d6 5, no crashD6Total -> damage ${CG.groundFiveNoCrashDie?.damage}`);

console.log("\n§3 — which armour side a shot strikes (vehicle-targeting.js)");
check("a shot from dead ahead of the target's facing strikes the front",
  P.facing.aheadOfTarget === "front", `[MM p.6 flank rules; design decision 3: front cone +/-45 degrees]`);
check("a shot from dead astern strikes the rear",
  P.facing.asternOfTarget === "rear", `[MM p.6: back = 50% armour]`);
check("shots from either beam strike the side",
  P.facing.eastOfTarget === "side" && P.facing.westOfTarget === "side", `[MM p.6: side = 75% armour]`);
check("the front and rear cones are boundary-inclusive at exactly 45 and 135 degrees",
  P.facing.frontCorner === "front" && P.facing.rearCorner === "rear" && P.facing.justInsideSide === "side",
  `45 deg -> ${P.facing.frontCorner}; 135 deg -> ${P.facing.rearCorner}; 45.3 deg -> ${P.facing.justInsideSide} [design decision 3; the book does not settle the boundary]`);
check("the target's own rotation selects the arcs, not the screen axes",
  JSON.stringify(P.facing.rotatedEast) === JSON.stringify(["front","side","rear","side"])
  && JSON.stringify(P.facing.rotatedAbout) === JSON.stringify(["front","rear"]),
  `target turned to face east: E/S/W/N -> ${P.facing.rotatedEast.join("/")}`);
check("PROPERTY: turning the target and the shot together never changes the struck side", P.facing.rotationInvariance, "[geometry]");
check("the front arc spans 90 degrees, the rear 90, leaving 180 of side",
  P.facing.arcWidths.front === 91 && P.facing.arcWidths.rear === 91 && P.facing.arcWidths.side === 178,
  `front ${P.facing.arcWidths.front} / side ${P.facing.arcWidths.side} / rear ${P.facing.arcWidths.rear} bearings of 360 (boundary bearings counted in both cones) [design decision 3]`);
check("a shot arriving from steeply above or below strikes the top or the bottom instead",
  P.facing.steepAbove === "top" && P.facing.steepBelow === "bottom" && P.facing.overhead === "top",
  `[design decision 3: elevation is checked first]`);
check("a shallow elevation difference leaves the horizontal arcs in charge",
  P.facing.shallowAbove === "rear" && P.facing.equalElevation === "rear",
  `50 px up over 100 px out -> ${P.facing.shallowAbove}; equal -> ${P.facing.equalElevation} [design decision 3: STEEPER than the horizontal distance]`);
check("CLOSED ENUMERATION: a full sweep of bearings and elevations yields exactly the five armour sides",
  JSON.stringify(P.facing.closedSet) === JSON.stringify(["bottom","front","rear","side","top"]),
  `${P.facing.closedSet.join(",")} over 2520 sampled geometries`);
check("NEGATIVE: a degenerate geometry still names a side rather than throwing",
  P.facing.degenerate === "front", `co-located, level -> ${P.facing.degenerate} [code-only default]`);

check("PROPERTY (code-only cutoffs): the three penetration-falloff bands come in order and never go back",
  P.rangeBand.ordered && JSON.stringify(P.rangeBand.closedSet) === JSON.stringify(["extreme","long","normal"]),
  `[MM p.6 prints the -25% / -50% penalties but not the band cutoffs; the half-range cutoff is the module's]`);
check("PROPERTY: the band boundaries sit at half the weapon's range and at its range, inclusive below",
  P.rangeBand.halfRange === "normal" && P.rangeBand.justOverHalf === "long"
  && P.rangeBand.atRange === "long" && P.rangeBand.justOverRange === "extreme" && P.rangeBand.farBeyond === "extreme",
  `200/200.1/400/400.1/4000 of a 400 m weapon -> ${[P.rangeBand.halfRange,P.rangeBand.justOverHalf,P.rangeBand.atRange,P.rangeBand.justOverRange,P.rangeBand.farBeyond].join("/")}`);
check("PROPERTY: the bands are proportional to the weapon's range", P.rangeBand.scaleFree, "[MM p.6 states falloff relative to the weapon's range]");
check("NEGATIVE: with no range on file nothing falls off",
  P.rangeBand.pointBlank === "normal" && P.rangeBand.unknownRange === "normal" && P.rangeBand.negativeRange === "normal",
  `distance 0 -> ${P.rangeBand.pointBlank}; range 0 -> ${P.rangeBand.unknownRange}; range -400 -> ${P.rangeBand.negativeRange}`);

check("DETERMINISM: the whole pure block recomputes identically", pure.deterministic);

/* ══════════════ phase 2 — the facing read from REAL tokens on the live scene ══════════════ */

const tok = await page.evaluate(async () => {
  const out = { err: null };
  const TGT = await import("/modules/cp2020-augmented/module/vehicle/vehicle-targeting.js");
  const GRID = await import("/modules/cp2020-augmented/module/vehicle/vehicle-grid.js");
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    const scene = game.scenes.active ?? canvas?.scene;
    out.sceneName = scene?.name ?? null;
    out.sceneIsCanvas = !!scene && canvas?.scene?.id === scene.id;
    if (!out.sceneIsCanvas) { out.err = "no active scene drawn on the canvas"; return out; }

    const gridSize = Number(scene.grid.size) || 100;
    const gridDist = Number(scene.grid.distance) || 1;
    out.grid = { size: gridSize, distance: gridDist, units: scene.grid.units ?? "" };
    out.pxPerUnit = GRID.metersPerUnit(scene) * GRID.pxPerMeter(scene);
    out.pxPerUnitExpected = gridSize / gridDist;

    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__Facing"))) await a.delete().catch(() => {});
    for (const t of [...scene.tokens].filter(t => t.name?.startsWith("__PW__Facing"))) await t.delete().catch(() => {});

    const shooter = await Actor.create({ name: "__PW__FacingShooter", type: "character" });
    const mark    = await Actor.create({ name: "__PW__FacingMark", type: "character" });
    out.ids = { shooter: shooter.id, mark: mark.id };

    // Far from the scene's own furniture: facing is a two-token statement, unaffected by the rest.
    const X0 = 800, Y0 = 800;
    const [mDoc] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__FacingMark", actorId: mark.id,
      actorLink: true, x: X0, y: Y0, width: 1, height: 1, rotation: 0, elevation: 0 }]);
    const [sDoc] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__FacingShooter", actorId: shooter.id,
      actorLink: true, x: X0, y: Y0 + 4 * gridSize, width: 1, height: 1, rotation: 0, elevation: 0 }]);
    out.tokenIds = { mark: mDoc.id, shooter: sDoc.id };
    await sleep(400);

    const markTok = canvas.tokens.get(mDoc.id);
    const shootTok = canvas.tokens.get(sDoc.id);
    out.placeablesFound = !!markTok && !!shootTok;
    if (!out.placeablesFound) { out.err = "tokens did not reach the canvas"; return out; }
    out.centresRead = !!markTok.center && !!shootTok.center;

    const read = () => TGT.detectFacingFromTokens(shootTok, markTok);
    // A placeable's `center` follows its ANIMATED display position, not the document, so every
    // move here is applied un-animated and then confirmed against the document before it is read.
    const move = async (doc, data) => {
      // v13+ routes an un-flagged x/y/elevation update through the movement system, which
      // CONSTRAINS the destination (and silently drops elevation). `teleport` asks for the
      // literal placement a fixture needs.
      await doc.update(data, { animate: false, teleport: true });
      for (let i = 0; i < 40; i++) {
        const t = canvas.tokens.get(doc.id);
        const settled = Object.entries(data).every(([k, v]) => (k === "x" ? t.center.x === v + t.w / 2 : k === "y" ? t.center.y === v + t.h / 2 : true));
        if (settled) break;
        await sleep(50);
      }
      await sleep(50);
    };
    out.moveSettles = [];

    // The shooter sits due SOUTH of the mark, which is dead ahead of it: a token at rotation 0
    // faces south by the core's own convention.
    out.aheadOfMark = read();
    await move(mDoc, { rotation: 180 });
    out.markTurnedAbout = read();
    await move(mDoc, { rotation: 90 });
    out.markTurnedEast = read();
    await move(mDoc, { rotation: 0 });
    await move(sDoc, { x: X0 + 4 * gridSize, y: Y0 });
    out.moveSettles.push({ want: [X0 + 4 * gridSize, Y0], got: [shootTok.center.x - shootTok.w / 2, shootTok.center.y - shootTok.h / 2] });
    out.shooterOnTheBeam = read();

    // Elevation: back to dead ahead at four grid squares out, then climb.
    await move(sDoc, { x: X0, y: Y0 + 4 * gridSize });
    out.moveSettles.push({ want: [X0, Y0 + 4 * gridSize], got: [shootTok.center.x - shootTok.w / 2, shootTok.center.y - shootTok.h / 2] });
    const horizUnits = 4 * gridDist;                              // four squares, in grid-distance units
    await move(sDoc, { elevation: horizUnits * 2 });
    out.elevReadBack = Number(shootTok.document.elevation);
    out.steepAbove = read();
    await move(sDoc, { elevation: -horizUnits * 2 });
    out.steepBelow = read();
    await move(sDoc, { elevation: Math.round(horizUnits / 2) });
    out.shallowAbove = read();
    // the 45-degree line: an elevation delta equal to the horizontal distance is NOT yet steep
    await move(sDoc, { elevation: horizUnits });
    out.onTheDiagonal = read();
    await move(sDoc, { elevation: horizUnits + gridDist });
    out.justOverTheDiagonal = read();

    // NEGATIVE: a missing token gives the documented fallback rather than a throw.
    out.missingAttacker = TGT.detectFacingFromTokens(null, markTok);
    out.missingTarget = TGT.detectFacingFromTokens(shootTok, null);
  } catch (e) { out.err = String(e?.message ?? e); }
  return out;
});

console.log("\n§3b — the same selection read from real tokens through the grid conversion");
check("the fixture reached the canvas: two linked tokens on the drawn scene",
  tok.placeablesFound === true && tok.centresRead === true && !tok.err,
  `scene "${tok.sceneName}" grid ${tok.grid?.size}px/${tok.grid?.distance}${tok.grid?.units || ""}${tok.err ? ` — ERR ${tok.err}` : ""}`);
check("the fixture MOVED: every repositioning settled onto the canvas before it was read",
  (tok.moveSettles ?? []).length === 2 && tok.moveSettles.every(m => m.want[0] === m.got[0] && m.want[1] === m.got[1])
  && tok.elevReadBack === 8 * (tok.grid?.distance ?? 0),
  `${(tok.moveSettles ?? []).map(m => `${m.want.join(",")}->${m.got.join(",")}`).join(" | ")}; elevation read back ${tok.elevReadBack}`);
check("one unit of elevation converts to the same pixels as one unit of ground distance",
  near(tok.pxPerUnit, tok.pxPerUnitExpected, 1e-9),
  `${tok.pxPerUnit} px/unit vs grid size/distance ${tok.pxPerUnitExpected} [geometry: the two axes must share a scale for the 45-degree rule to mean anything]`);
check("a real shooter due ahead of a real mark reads as the front side",
  tok.aheadOfMark === "front", `got ${tok.aheadOfMark}`);
check("turning the mark about turns the struck side to the rear",
  tok.markTurnedAbout === "rear", `got ${tok.markTurnedAbout}`);
check("turning the mark across the shot puts the hit on its side",
  tok.markTurnedEast === "side", `got ${tok.markTurnedEast}`);
check("moving the shooter onto the beam puts the hit on the side",
  tok.shooterOnTheBeam === "side", `got ${tok.shooterOnTheBeam}`);
check("a real elevation delta twice the ground distance selects the top and the bottom",
  tok.steepAbove === "top" && tok.steepBelow === "bottom", `above ${tok.steepAbove} / below ${tok.steepBelow}`);
check("a shallow real elevation leaves the horizontal arcs in charge",
  tok.shallowAbove === "front", `got ${tok.shallowAbove}`);
check("the flip happens exactly at the 45-degree line, elevation-inclusive-below",
  tok.onTheDiagonal === "front" && tok.justOverTheDiagonal === "top",
  `equal to the ground distance -> ${tok.onTheDiagonal}; one unit further up -> ${tok.justOverTheDiagonal} [design decision 3]`);
check("NEGATIVE: a missing token on either end falls back to the front side rather than throwing",
  tok.missingAttacker === "front" && tok.missingTarget === "front",
  `no attacker -> ${tok.missingAttacker}; no target -> ${tok.missingTarget}`);

/* ═══════════ phase 3 — the survival threshold, on real actors and against the live card ═══════════ */

const dt = await page.evaluate(async () => {
  const out = { err: null, ladder: [], lowBt: [], created: [] };
  const SR = await import("/modules/cp2020-augmented/module/combat/save-rolls.js");
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__Threshold"))) await a.delete().catch(() => {});
    const actor = await Actor.create({ name: "__PW__ThresholdA", type: "character" });
    out.created.push(actor.id);
    await actor.update({ "system.stats.bt.base": 8, "system.damage": 0 });
    out.btTotal = Number(actor.system?.stats?.bt?.total);

    // The whole wound ladder, driven by REAL damage on a real actor.
    for (const damage of [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 60]) {
      await actor.update({ "system.damage": damage });
      out.ladder.push({
        damage,
        woundState: actor.woundState?.(),
        threshold: SR.getDeathThreshold(actor),
        baseSystem: typeof actor.deathThreshold === "function" ? actor.deathThreshold() : null,
        twice: SR.getDeathThreshold(actor) === SR.getDeathThreshold(actor),
      });
    }

    // A frailer body: the same ladder must bottom out at zero rather than go negative.
    const frail = await Actor.create({ name: "__PW__ThresholdB", type: "character" });
    out.created.push(frail.id);
    await frail.update({ "system.stats.bt.base": 5, "system.damage": 0 });
    out.frailBt = Number(frail.system?.stats?.bt?.total);
    for (const damage of [16, 28, 36, 40, 44]) {
      await frail.update({ "system.damage": damage });
      out.lowBt.push({ damage, woundState: frail.woundState?.(), threshold: SR.getDeathThreshold(frail) });
    }

    // A body with NO wound-state reader at all (the documented fallback arm).
    out.noWoundState = SR.getDeathThreshold({ system: { stats: { bt: { total: 8 } } } });
    out.noStats = SR.getDeathThreshold({});
    // The track's own end: the base system may clamp stored damage before the wound state can run
    // past Mortal 6, so the cap is asked of the contract the function actually reads — woundState().
    out.pastTheTrack = [10, 11, 14, 20].map(ws =>
      SR.getDeathThreshold({ system: { stats: { bt: { total: 8 } } }, woundState: () => ws }));
    out.maxRealDamage = (() => { const a = actor; return Number(a.system?.damage) || 0; })();

    /* --- the number the LIVE save card prints, against the pure function's answer --- */
    const scene = game.scenes.active ?? canvas?.scene;
    const [aTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__ThresholdTok",
      actorId: actor.id, actorLink: true, x: 400, y: 600, width: 1, height: 1 }]);
    out.tokenId = aTok.id;
    await actor.update({ "system.damage": 24 });                    // Mortal 2 on a BT-8 body
    out.cardWound = actor.woundState?.();
    out.cardExpected = SR.getDeathThreshold(actor);
    const before = new Set(game.messages.contents.map(m => m.id));
    await SR.executeDeathSave({ actorId: actor.id, tokenId: aTok.id, sceneId: scene.id });
    await sleep(900);
    const posted = game.messages.contents.filter(m => !before.has(m.id));
    out.cardCount = posted.length;
    out.cardFlavor = posted[0]?.flavor ?? "";
    out.cardHasThreshold = posted.some(m => /need\s*≤\s*(\d+)/.test(m.flavor ?? ""));
    out.cardThreshold = Number((posted.map(m => (m.flavor ?? "").match(/need\s*≤\s*(\d+)/)).find(Boolean) ?? [])[1]);
    out.postedIds = posted.map(m => m.id);
  } catch (e) { out.err = String(e?.message ?? e); }
  return out;
});

console.log("\n§4 — the survival threshold that decides the outcome (save-rolls.js)");
check("the fixture body carries the intended BT", dt.btTotal === 8 && !dt.err,
  `BT total ${dt.btTotal}${dt.err ? ` — ERR ${dt.err}` : ""}`);
const L = Object.fromEntries((dt.ladder ?? []).map(r => [r.damage, r]));
check("the save number is the body's BT while the wound track is below the mortal band",
  [0, 4, 8, 12].every(d => L[d]?.threshold === 8),
  `damage 0/4/8/12 (states ${[0,4,8,12].map(d => L[d]?.woundState).join("/")}) -> ${[0,4,8,12].map(d => L[d]?.threshold).join("/")} [Core p.28: "Save Number = BT stat; roll 1D10 <= Save Number"]`);
check("at the first mortal step the save number is still the full BT",
  L[16]?.woundState === 4 && L[16]?.threshold === 8,
  `damage 16 -> wound state ${L[16]?.woundState} -> ${L[16]?.threshold} [Core p.28 save number; the wound track's mortal band starts at Mortal 0]`);
check("each further mortal step costs exactly one point of the save number",
  L[20]?.threshold === 7 && L[24]?.threshold === 6 && L[28]?.threshold === 5 && L[32]?.threshold === 4 && L[36]?.threshold === 3 && L[40]?.threshold === 2,
  `Mortal 1..6 -> ${[20,24,28,32,36,40].map(d => L[d]?.threshold).join("/")} [wound track Mortal 0-6, one step per level]`);
check("the ladder stops at the last printed mortal level rather than running on",
  L[44]?.threshold === 2 && L[60]?.threshold === 2
  && JSON.stringify(dt.pastTheTrack) === JSON.stringify([2, 2, 2, 2]),
  `real bodies at damage 44/60 (wound states ${L[44]?.woundState}/${L[60]?.woundState}) read ${L[44]?.threshold}/${L[60]?.threshold}; wound states 10/11/14/20 read ${dt.pastTheTrack?.join("/")} [core-read-fulldetail: "Use the 0-6 wound track (authoritative)"]`);
check("CROSS-IMPLEMENTATION: through the whole mortal band the number matches the base system's own reading",
  [16, 20, 24, 28, 32, 36, 40].every(d => L[d]?.threshold === L[d]?.baseSystem),
  `module ${[16,20,24,28,32,36,40].map(d => L[d]?.threshold).join("/")} vs base ${[16,20,24,28,32,36,40].map(d => L[d]?.baseSystem).join("/")} [base cyberpunk2020 actor.deathThreshold(), an independent implementation]`);
console.log(`  INFORMATIONAL: past the last mortal level the two implementations part company — at wound state ${L[44]?.woundState} the module reads ${L[44]?.threshold} (capped to the 0-6 track) and the base system reads ${L[44]?.baseSystem} (uncapped). Stored damage stops at ${dt.maxRealDamage} on this rig.`);
const frail = Object.fromEntries((dt.lowBt ?? []).map(r => [r.damage, r]));
check("a frailer body's number floors at zero instead of going negative",
  frail[40]?.threshold === 0 && frail[44]?.threshold === 0 && frail[36]?.threshold === 0,
  `BT ${dt.frailBt} at Mortal 4/6/7+ -> ${[36,40,44].map(d => frail[d]?.threshold).join("/")}`);
check("a zero number cannot be met by any face of the die",
  frail[40]?.threshold === 0 && ![1,2,3,4,5,6,7,8,9,10].some(face => face <= (frail[40]?.threshold ?? 0)),
  `no d10 face satisfies "<= 0" [Core p.28: roll 1D10 <= the save number]`);
check("the frail body still has a survivable number in the early mortal band",
  frail[16]?.threshold === 5 && frail[28]?.threshold === 2,
  `BT 5 at Mortal 0 -> ${frail[16]?.threshold}; at Mortal 3 -> ${frail[28]?.threshold}`);
check("PROPERTY (code-only fallback): a body with no wound-state reader still yields a number within [0, BT]",
  dt.noWoundState >= 0 && dt.noWoundState <= 8 && dt.noStats === 0,
  `no reader -> ${dt.noWoundState}; empty object -> ${dt.noStats} [the fallback wound state is the module's]`);
check("DETERMINISM: the number does not move between two consecutive reads",
  (dt.ladder ?? []).every(r => r.twice));
check("LIVE PATH: the number the posted save card prints is the number this function computes",
  dt.cardCount >= 1 && dt.cardHasThreshold && dt.cardThreshold === dt.cardExpected && dt.cardExpected === 6,
  `wound state ${dt.cardWound}: function ${dt.cardExpected}, card "${dt.cardFlavor}" [the live path recomputes the same arithmetic inline at save-rolls.js:441 — this leg is what keeps the two copies in step]`);

/* ═════════════════════════════ teardown ═════════════════════════════ */

const cleanup = await page.evaluate(async (ids) => {
  const out = { strays: [], err: null };
  try {
    const scene = game.scenes.active ?? canvas?.scene;
    for (const id of ids.messageIds ?? []) await game.messages.get(id)?.delete().catch(() => {});
    for (const t of [...(scene?.tokens ?? [])].filter(t => t.name?.startsWith("__PW__Facing") || t.name?.startsWith("__PW__Threshold"))) await t.delete().catch(() => {});
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__Facing") || a.name?.startsWith("__PW__Threshold"))) await a.delete().catch(() => {});
    out.strays = game.actors.filter(a => a.name?.startsWith("__PW__Facing") || a.name?.startsWith("__PW__Threshold")).map(a => a.name);
    out.tokenStrays = [...(scene?.tokens ?? [])].filter(t => t.name?.startsWith("__PW__")).map(t => t.name);
  } catch (e) { out.err = String(e?.message ?? e); }
  return out;
}, { messageIds: dt.postedIds ?? [] });

console.log("\n§5 — teardown");
check("every fixture this suite created is gone", (cleanup.strays?.length ?? 1) === 0 && !cleanup.err,
  `actor strays: ${cleanup.strays?.join(",") || "none"}; token strays: ${cleanup.tokenStrays?.join(",") || "none"}${cleanup.err ? ` — ERR ${cleanup.err}` : ""}`);

check("0 console errors", errors.length === 0, errors.slice(0, 5).join(" | "));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass}/${pass + fail} checks`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
