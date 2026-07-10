/**
 * P6 — Protection tags (SPECIAL-MECHANICS-PROPOSAL.md; gas masks, Anti-Dazzle, ear protection).
 *
 * Passive: no hooks, no token writes. The save engines CONSULT these helpers at save time — today
 * the gas-cloud per-turn save (damage-hooks.js), later the flash/sonic effects when those land.
 * All functions are pure over plain item shapes, so the rig spec asserts the truth table directly.
 *
 * Aggregation rule: any equipped immune item ⇒ immune; otherwise the BEST (max) positive save mod
 * among equipped items — protective gear doesn't stack (a mask over nose filters isn't double).
 */

import { cwIsEnabled } from "../utils.js";

/** The item's protection entry for `hazard` when tagged, else null. Pure. */
export function protectionEntryOf(item, hazard) {
  const mp = item?.system?.mechProtection;
  if (!mp?.enabled) return null;
  const h = mp[hazard];
  if (!h) return null;
  const immune = !!h.immune;
  const mod = Number(h.mod) || 0;
  const percent = Math.max(0, Number(h.percent) || 0);
  const dmRaw = Number(h.damageMult) || 0;
  const damageMult = (dmRaw > 0 && dmRaw !== 1) ? dmRaw : 0;
  if (!immune && mod === 0 && percent === 0 && damageMult === 0) return null;
  return { immune, mod, percent, damageMult };
}

/** Aggregate protection vs `hazard` across EQUIPPED, enabled items:
 *  { immune, mod, percent, damageMult }. No stacking anywhere: best mod, best percent, best
 *  (lowest) damage multiplier. A switched-off Activatable implant protects nothing (the same
 *  gate the roll-mod/stat-mod/chip providers use). A percent-gated item protects through its
 *  per-exposure gate — the caller SKIPS the save entirely when the gate holds — so only UNGATED
 *  items feed the always-on save-mod aggregate (a failed gate must not soften the save). Pure. */
export function hazardProtectionFor(items, hazard) {
  let immune = false;
  let mod = 0;
  let percent = 0;
  let damageMult = 0;
  for (const it of items ?? []) {
    if (!it?.system?.equipped) continue;
    if (it.type === "cyberware" && !cwIsEnabled(it)) continue;
    const e = protectionEntryOf(it, hazard);
    if (!e) continue;
    if (e.immune) immune = true;
    if (e.percent > 0) {
      if (e.percent > percent) percent = e.percent;
    } else if (e.mod > mod) {
      mod = e.mod;
    }
    if (e.damageMult && (!damageMult || e.damageMult < damageMult)) damageMult = e.damageMult;
  }
  return { immune, mod, percent, damageMult };
}

/**
 * Q8 percent gate, keeping the book's own number: "70% effective" → threshold 7 on a d10; a roll
 * at or under the threshold means the gear protected THIS exposure. The caller rolls the die
 * (impure) and shows it on the card; this is only the decision math. Pure.
 */
export function percentGateOutcome(percent, d10) {
  const threshold = Math.max(0, Number(percent) || 0) / 10;
  return { threshold, gated: (Number(d10) || 0) <= threshold && threshold > 0 };
}

/**
 * The gas-save decision for one actor standing in a cloud whose penalty is `stunSaveMod` (≤ 0):
 *   { skip: true, borgSealed: true }    — a full-conversion borg: intrinsically immune, no save
 *   { skip: true }                      — sealed breathing gear, no save at all
 *   { skip: false, effMod, percent }    — save with the penalty offset by the gear's mod, never
 *                                         flipping into a bonus (effMod capped at 0). A nonzero
 *                                         `percent` asks the caller to roll the Q8 per-exposure
 *                                         gate (percentGateOutcome) before prompting the save.
 * Pure over the actor's items array (+ the caller-supplied `isFullBorg` boolean).
 */
export function gasSaveDecisionFor(items, stunSaveMod, { isFullBorg = false } = {}) {
  // A full borg's lungs are a sealed filtration/oxygenation system, so it is immune to ANY gas
  // (Chromebook 2 p.64) — intrinsic, not gear. `borgSealed` lets the caller name it as an immunity
  // rather than "sealed breathing gear". Kept pure: borg-ness arrives as a boolean, no actor/import.
  if (isFullBorg) return { skip: true, effMod: 0, percent: 0, borgSealed: true };
  const prot = hazardProtectionFor(items, "gas");
  if (prot.immune) return { skip: true, effMod: 0, percent: 0 };
  return { skip: false, effMod: Math.min(0, (Number(stunSaveMod) || 0) + prot.mod), percent: prot.percent };
}
