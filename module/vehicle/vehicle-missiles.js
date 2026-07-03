/**
 * vehicle-missiles.js — Phase 5f: guided missiles & countermeasures (Maximum Metal p.9-10, p.24).
 *
 * This file holds the PURE, unit-testable rules core. The stateful flight (missile tokens, per-round
 * advance, the "Missiles in Flight" panel, the Incoming-Missile reaction card, detection, and
 * countermeasure/intercept UI) is built on top of these in later commits.
 *
 * Guidance (p.9): SEMI-ACTIVE uses the operator's skill; ACTIVE uses the missile's own Skill rating
 * (+15/+20), ignoring the operator (AAMRAM has a set To-Hit of 10); PAINT (Hellfire) fires, then if
 * the painting laser hits, each missile hits on a d10 of 2-10. vs aerial → ignore target-movement
 * penalties; vs non-aerial → +10/+20 Difficulty. Missiles have a minimum range = 1/10 Long range.
 */

/** Missile cruising speed in metres per 3-second combat turn, by guidance (MM p.9). PURE. */
export function missileSpeed(guidance = "semiActive", override = 0) {
  const o = Number(override) || 0;
  if (o > 0) return o;
  switch (guidance) {
    case "active": return 1500;     // active radar/IR (AAMRAM Mach 2, AAM ~1400mph)
    case "paint":  return 3000;     // laser-guided, resolves quickly once painted
    default:       return 750;      // semi-active
  }
}

/** Combat turns for a missile to reach its target. PURE. At least 1. */
export function turnsToImpact(distanceM, speedMPerTurn) {
  const d = Math.max(0, Number(distanceM) || 0);
  const s = Math.max(1, Number(speedMPerTurn) || 1);
  return Math.max(1, Math.ceil(d / s));
}

/** Minimum arming range (MM p.9: 1/10 of Long range). PURE. */
export function minRange(longRangeM) {
  return Math.max(0, Math.floor((Number(longRangeM) || 0) / 10));
}

/**
 * Resolve a guided missile's to-hit (MM p.9). PURE — pass the rolled d10.
 *   active     → d10 + the missile's own Skill + rollMods   (operator ignored)
 *   semiActive → d10 + the operator's bonus (REF+skill) + rollMods
 * Countermeasures raise the target number (`difficultyMods`); rollMods carry size/ECM-to-hit.
 */
export function resolveMissileToHit({ guidance = "semiActive", d10 = 0, operatorBonus = 0, missileSkill = 0, targetNumber = 0, rollMods = 0, difficultyMods = 0 } = {}) {
  const bonus = guidance === "active" ? (Number(missileSkill) || 0) : (Number(operatorBonus) || 0);
  const total = (Number(d10) || 0) + bonus + (Number(rollMods) || 0);
  const dv = (Number(targetNumber) || 0) + (Number(difficultyMods) || 0);
  return { total, dv, hit: total >= dv };
}

/** Paint missile (Hellfire): once the painting laser hits, each missile hits on a d10 of 2-10. PURE. */
export function resolvePaintHit(d10) {
  return (Number(d10) || 0) >= 2;
}

/**
 * Anti-missile intercept (AGAMS/AEAMS, MM p.24). PURE — pass the rolled d10 and how many missiles
 * the system is splitting fire across (−1 per missile beyond the first). After detection (90%):
 *   ≥4 → destroyed · 1-3 → detonated within burst range (½ damage & Pen) · ≤0 → fails (hits normally).
 */
export function interceptResult(d10, extraMissiles = 0) {
  const r = (Number(d10) || 0) - Math.max(0, Number(extraMissiles) || 0);
  if (r >= 4) return { outcome: "destroyed" };
  if (r >= 1) return { outcome: "burst" };     // detonates near the target: half damage & Pen
  return { outcome: "fail" };
}

/** +Difficulty a countermeasure imposes on a missile by its homing method (MM p.9-10). */
const CM_EFFECT = {
  chaff:            { radar: 10 },               // anti-radar only (chaff does not defeat laser homing)
  flares:           { thermal: 10 },
  irBaffling:       { thermal: 5 },
  irSmoke:          { thermal: 15, optical: 15 },
  jamming:          { radar: 15 },
  ecm:              { radar: 15 },
  smoke:            { optical: 15 },
  stealth:          { radar: 15 },
  antiLaserAerosol: { laser: 15 },               // MM: anti-laser aerosol blocks laser homing (~90%)
};

/**
 * The countermeasures a vehicle/ACPA can carry, in display order — the single source of truth shared by
 * the incoming-missile reader (countermeasureModifier) and the sheet loadout UI. `defeats` lists the
 * homing methods each one raises Difficulty against (MM p.9-10), used for the sheet tooltips.
 */
export const COUNTERMEASURES = Object.entries(CM_EFFECT).map(([key, eff]) => ({ key, defeats: Object.keys(eff) }));

/** Total +Difficulty the active countermeasures impose on a missile of the given homing method. PURE. */
export function countermeasureModifier(activeCMs = [], homingMethod = "radar") {
  let mod = 0;
  for (const cm of (activeCMs ?? [])) mod += (CM_EFFECT[cm]?.[homingMethod] ?? 0);
  return mod;
}

/** Electronic detection succeeds on a d10 of 2-10 (the 90% sensor chance, MM p.24-26). PURE. */
export function electronicDetect(d10) {
  return (Number(d10) || 0) >= 2;
}

/** Visual spotting Difficulty (Notice/Awareness, MM p.10): missile in flight 20, missile firing 10. PURE. */
export function visualDetectDV(situation = "inFlight") {
  return situation === "firing" ? 10 : 20;
}
