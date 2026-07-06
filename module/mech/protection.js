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

/** The item's protection entry for `hazard` when tagged, else null. Pure. */
export function protectionEntryOf(item, hazard) {
  const mp = item?.system?.mechProtection;
  if (!mp?.enabled) return null;
  const h = mp[hazard];
  if (!h) return null;
  const immune = !!h.immune;
  const mod = Number(h.mod) || 0;
  if (!immune && mod === 0) return null;
  return { immune, mod };
}

/** Aggregate protection vs `hazard` across EQUIPPED items: { immune, mod }. Pure. */
export function hazardProtectionFor(items, hazard) {
  let immune = false;
  let mod = 0;
  for (const it of items ?? []) {
    if (!it?.system?.equipped) continue;
    const e = protectionEntryOf(it, hazard);
    if (!e) continue;
    if (e.immune) immune = true;
    if (e.mod > mod) mod = e.mod;
  }
  return { immune, mod };
}

/**
 * The gas-save decision for one actor standing in a cloud whose penalty is `stunSaveMod` (≤ 0):
 *   { skip: true }                      — sealed breathing, no save at all
 *   { skip: false, effMod }             — save with the penalty offset by the gear's mod, never
 *                                         flipping into a bonus (effMod capped at 0).
 * Pure over the actor's items array.
 */
export function gasSaveDecisionFor(items, stunSaveMod) {
  const prot = hazardProtectionFor(items, "gas");
  if (prot.immune) return { skip: true, effMod: 0 };
  return { skip: false, effMod: Math.min(0, (Number(stunSaveMod) || 0) + prot.mod) };
}
