/**
 * vehicle-indirect.js — Phase 5g: indirect artillery & bombs (PURE math core). Maximum Metal p.8-9.
 *
 * Two delivery methods that land an area warhead away from line-of-sight:
 *   INDIRECT FIRE (p.8) — a spotter corrects fire onto a point the firer can't see. To-Hit 25 to
 *     range in, dropping to 10 once a shot lands there; a miss scatters by missedBy × (range/100) m
 *     on the Grenade Table. Shells travel grenade/mortar 400 m/turn, artillery 600 m/turn.
 *   BOMBING (p.9) — a direct hit multiplies Penetration ×5 (range-immune); a miss scatters by
 *     missedBy × 10 × (height/100) m. Bombs fall 175 m/turn; dive-bombing inherits the aircraft's
 *     speed (halving each turn after the first to the 175 floor) and counts as aim (+1/turn, max +3).
 *
 * Warheads (p.20-22): HEAT (shaped charge), White Phosphorus (burn DOT), Cluster (wide, shallow),
 * Chemical/smoke (gas cloud, no Penetration). These are PURE transforms of {pen, burstM}; the
 * stateful effects (fire DOT, gas cloud) are applied by the resolver wrapper (5g-2).
 *
 * Everything here is a deterministic, unit-testable function — no canvas, no dice, no documents.
 */

const DEG = Math.PI / 180;

/* ------------------------------- Indirect fire (MM p.8) ------------------------------- */

/** Turns for a shell to reach its target. Grenades/mortars 400 m/turn, artillery 600 m/turn. PURE. */
export function shellTravelTurns(rangeM, kind = "artillery") {
  const speed = kind === "artillery" ? 600 : 400;
  return Math.max(1, Math.ceil((Number(rangeM) || 0) / speed));
}

/** The indirect To-Hit number: 25 to first range a spot in, then 10 once a shot has landed there. PURE. */
export function indirectToHitNumber({ alreadyRangedIn = false } = {}) {
  return alreadyRangedIn ? 10 : 25;
}

/**
 * Spotter-corrected indirect To-Hit bonus (MM p.8): (SpotterHW + SpotterINT)/2 + FirerHW/2 + mods.
 * `mods` folds the visibility / situation table (spotter-doing-something-else −10 per errata, etc.). PURE.
 */
export function indirectToHitBonus({ spotterHW = 0, spotterINT = 0, firerHW = 0, mods = 0 } = {}) {
  return Math.floor(((Number(spotterHW) || 0) + (Number(spotterINT) || 0)) / 2)
       + Math.floor((Number(firerHW) || 0) / 2)
       + (Number(mods) || 0);
}

/** Indirect scatter distance on a miss: missedBy × (range / 100) metres (MM p.8). PURE. */
export function indirectDeviationM(rangeM, missedBy) {
  return Math.max(0, Number(missedBy) || 0) * ((Number(rangeM) || 0) / 100);
}

/** Bomb scatter distance on a miss: missedBy × 10 × (height / 100) metres (MM p.9). PURE. */
export function bombDeviationM(heightM, missedBy) {
  return Math.max(0, Number(missedBy) || 0) * 10 * ((Number(heightM) || 0) / 100);
}

/**
 * Grenade-Table scatter heading from a d10 — 10 evenly spaced directions (36° apart). PURE.
 * Approximates the book's Grenade Table well enough for a placed template; 0° = east, clockwise.
 */
export function scatterDirectionDeg(d10) {
  const n = Math.max(1, Math.min(10, Math.round(Number(d10) || 1)));
  return ((n - 1) * 36) % 360;
}

/**
 * Full deviation vector (metres) from a miss amount + a rolled d10 direction. PURE.
 * @returns {{dx:number, dy:number, distanceM:number, dirDeg:number}} (screen axes: +x east, +y south)
 */
export function deviationVector({ distanceM = 0, d10 = 1 } = {}) {
  const dirDeg = scatterDirectionDeg(d10);
  const r = dirDeg * DEG;
  const d = Math.max(0, Number(distanceM) || 0);
  return { dx: d * Math.cos(r), dy: d * Math.sin(r), distanceM: d, dirDeg };
}

/* ----------------------------------- Bombs (MM p.9) ----------------------------------- */

/** A direct bomb hit multiplies Penetration ×5 (range-immune). PURE. */
export function bombDirectPen(pen) {
  return Math.max(0, (Number(pen) || 0) * 5);
}

/** Dive-bombing aim bonus: +1 WA per dive turn beyond the first, capped at +3 (MM p.9). PURE. */
export function diveBombAimBonus(diveTurns) {
  return Math.max(0, Math.min((Number(diveTurns) || 0) - 1, 3));
}

/**
 * Per-turn fall distances of a dropped bomb until it reaches the ground (MM p.9). PURE.
 * Normal drop falls 175 m/turn. A dive-drop starts at the aircraft's speed and halves each turn
 * after the first down to the 175 m/turn floor. The array length is the turns-to-impact.
 */
export function bombFallSchedule(heightM, { diveSpeed = 0 } = {}) {
  const FLOOR = 175;
  let remaining = Math.max(0, Number(heightM) || 0);
  let speed = (Number(diveSpeed) || 0) > FLOOR ? Number(diveSpeed) : FLOOR;
  const steps = [];
  let guard = 0;
  while (remaining > 0 && guard++ < 10000) {
    steps.push(speed);
    remaining -= speed;
    speed = Math.max(FLOOR, Math.floor(speed / 2));   // halve until the 175 floor
  }
  return steps.length ? steps : [FLOOR];
}

/** Turns for a bomb to reach the ground (MM p.9). PURE. */
export function bombFallTurns(heightM, opts) {
  return bombFallSchedule(heightM, opts).length;
}

/* ------------------------------ Landing points (PIXELS) ------------------------------ */

/**
 * Where an indirect shell lands, in pixel space, from the aim point + the roll. PURE.
 * A hit (total ≥ number) lands on the aim point; a miss deviates missedBy × (range/100) m on the d10
 * Grenade-Table heading. `ppm` = pixels per metre on the scene. `aim` = {x,y} pixels.
 */
export function indirectLanding({ aim = { x: 0, y: 0 }, rangeM = 0, toHitTotal = 0, toHitNumber = 25, d10dir = 1, ppm = 1 } = {}) {
  const missedBy = Math.max(0, (Number(toHitNumber) || 0) - (Number(toHitTotal) || 0));
  if (missedBy <= 0) return { hit: true, point: { x: aim.x, y: aim.y }, deviationM: 0, dirDeg: 0, missedBy: 0 };
  const distM = indirectDeviationM(rangeM, missedBy);
  const v = deviationVector({ distanceM: distM, d10: d10dir });
  return { hit: false, point: { x: aim.x + v.dx * ppm, y: aim.y + v.dy * ppm }, deviationM: distM, dirDeg: v.dirDeg, missedBy };
}

/** Where a bomb lands, in pixel space (deviation = missedBy × 10 × height/100 m, MM p.9). PURE. */
export function bombLanding({ aim = { x: 0, y: 0 }, heightM = 0, toHitTotal = 0, toHitNumber = 25, d10dir = 1, ppm = 1 } = {}) {
  const missedBy = Math.max(0, (Number(toHitNumber) || 0) - (Number(toHitTotal) || 0));
  if (missedBy <= 0) return { hit: true, point: { x: aim.x, y: aim.y }, deviationM: 0, dirDeg: 0, missedBy: 0 };
  const distM = bombDeviationM(heightM, missedBy);
  const v = deviationVector({ distanceM: distM, d10: d10dir });
  return { hit: false, point: { x: aim.x + v.dx * ppm, y: aim.y + v.dy * ppm }, deviationM: distM, dirDeg: v.dirDeg, missedBy };
}

/* ------------------------------ Warheads (MM p.20-22) ------------------------------ */

/**
 * Resolve a warhead's effect profile from its base {pen, burstM}. PURE.
 *   heat     — shaped charge; the resolver halves Pen vs Composite Armor (heat:true). 4 m default burst.
 *   wp       — White Phosphorus: no Penetration, a burn DOT (3D6/turn) on everything in the burst.
 *   cluster  — bomblets spread ×3 the burst radius but Penetration is capped at 4.
 *   chemical — gas/smoke: ×3 burst, no Penetration, leaves a lingering cloud (gas:true).
 *   (default) plain HE — unchanged.
 * @returns {{pen:number, burstM:number, heat?:boolean, dot?:object, gas?:boolean, cluster?:boolean}}
 */
export function warheadProfile(warhead, { pen = 0, burstM = 0 } = {}) {
  const P = Math.max(0, Number(pen) || 0);
  const B = Math.max(0, Number(burstM) || 0);
  switch (String(warhead || "").toLowerCase()) {
    case "heat":     return { pen: P, burstM: B || 4, heat: true };
    case "wp":
    case "phosphorus":
    case "whitephosphorus": return { pen: 0, burstM: B || 4, dot: { formula: "3d6", turns: 10 } };
    case "cluster":  return { pen: Math.min(P, 4), burstM: (B || 1) * 3, cluster: true };
    case "chemical":
    case "smoke":
    case "gas":      return { pen: 0, burstM: (B || 1) * 3, gas: true };
    default:         return { pen: P, burstM: B };
  }
}
