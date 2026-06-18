/**
 * armor-layers.js  —  module/combat/armor-layers.js
 *
 * Armor layer system — two modes:
 *
 * AUTO MODE (default):
 *   Armor pieces are ordered inside-out automatically by type and SP:
 *   1. Cyberware armor (Skinweave, subdermal, bodyplating) — always innermost base
 *   2. Soft armor (Kevlar, flak, light jacket) — ordered by SP ascending
 *   3. Hard armor (Metal gear, body armor, rigid plates) — ordered by SP ascending
 *
 *   Within each tier, lower-SP pieces go inside higher-SP pieces — the proportional
 *   armor formula rewards similar-SP layering (diff 0-4 = +5 bonus), so pairing
 *   pieces of similar SP maximises the combined SP result.
 *
 * MANUAL MODE (optional):
 *   When any layer slot in system.armorLayers is populated for a location,
 *   that location uses the manually assigned order instead of auto-ordering.
 *   Unassigned items are appended after the manual layers in SP order.
 *
 * ARCHITECTURE:
 *   actor.js maxLayeredSP() already implements proportional armor (CP2020 p.99)
 *   and runs on every actor render to compute displayed SP. This module adds:
 *     - getArmorContributors() — which items cover a location, in layer order
 *       (used by DamageApplicator for targeted ablation)
 *     - getAutoLayerOrder() — sorted item list for display in the UI
 *
 * COVER SP:
 *   Cover is treated as an outermost layer in DamageApplicator.resolveHitMath,
 *   combined via _combineSP(armorSP, coverSP). Cover has no slot in this module.
 *
 * DATA MODEL:
 *   system.armorLayers per location: ["itemId1", "itemId2", ...]
 *   Empty array = auto-ordering for that location.
 *   Cyberware armor is never put in these slots.
 */

/**
 * Determine whether an armor item is "hard" (rigid) or "soft" (flexible).
 * Checks armorType field first; falls back to name heuristics, then encumbrance.
 *
 * Soft: cloth, leather, Kevlar, t-shirt, flak vest, flak pants, jackets, body suit, nylon
 * Hard: metal gear, body armor, full body armor, plate
 */
export function getArmorHardness(armorItem) {
  const explicit = armorItem.system?.armorType;
  if (explicit === "hard" || explicit === "soft") return explicit;

  const name = (armorItem.name ?? "").toLowerCase();
  if (/metal gear|body armor|full body|plate|rigid|hard armor|bodyplating/.test(name)) return "hard";
  if (/shirt|vest|jacket|flak|kevlar|nylon|cloth|leather|suit|bodysuit|soft/.test(name)) return "soft";

  // Encumbrance heuristic: EV ≥ 2 = typically hard
  return (Number(armorItem.system?.encumbrance) || 0) >= 2 ? "hard" : "soft";
}

/**
 * Sub-ordering priority within a hardness tier. Lower = closer to the body.
 * Shirt/T-shirt=0  Vest/Kevlar/Nylon=1  Light jacket=2  Med/Heavy jacket=3
 * Light plate=4  Metal gear/full body=5
 */
function getLayerPriority(armorItem) {
  const name = (armorItem.name ?? "").toLowerCase();
  if (/t-shirt|tshirt|shirt/.test(name)) return 0;
  if (/kevlar|nylon|vest|flak vest|under/.test(name)) return 1;
  if (/light.*jacket|lt.*jacket/.test(name)) return 2;
  if (/medium.*jacket|heavy.*jacket|jacket/.test(name)) return 3;
  if (/flak pants|flak/.test(name)) return 1;
  if (/light.*armor|light.*plate/.test(name)) return 4;
  if (/metal gear|full body|body armor/.test(name)) return 5;
  // Fall back to SP: lower SP = thinner = more likely inner
  return Number(
    Math.max(...Object.values(armorItem.system?.coverage ?? {}).map(c => Number(c?.stoppingPower) || 0))
  ) / 100;
}

/**
 * Sort equipped armor items inside-out: soft (by priority, then SP) → hard (by priority, then SP).
 * @param {Item[]} armorItems
 * @returns {Item[]}  Sorted inside-out
 */
export function getAutoLayerOrder(armorItems) {
  const sorted = [...armorItems].sort((a, b) => {
    const hardA = getArmorHardness(a) === "hard" ? 1 : 0;
    const hardB = getArmorHardness(b) === "hard" ? 1 : 0;
    if (hardA !== hardB) return hardA - hardB; // soft before hard
    const prioA = getLayerPriority(a);
    const prioB = getLayerPriority(b);
    if (prioA !== prioB) return prioA - prioB;
    // Final tiebreaker: lower SP = inner
    const spA = Math.max(...Object.values(a.system?.coverage ?? {}).map(c => Number(c?.stoppingPower) || 0));
    const spB = Math.max(...Object.values(b.system?.coverage ?? {}).map(c => Number(c?.stoppingPower) || 0));
    return spA - spB;
  });
  return sorted;
}

/**
 * Return armor items contributing SP at a location, in layer order.
 * If manual layers are assigned for this location, uses that order.
 * Otherwise uses auto-ordering.
 *
 * @param {Actor}  actor
 * @param {string} locationKey   e.g. "Head", "Torso", "lArm"
 * @returns {{
 *   orderedLayers: Item[],   inside-out, assigned or auto-ordered
 *   cwItems:       Item[],   cyberware armor at this location (always innermost)
 * }}
 */
export function getArmorContributors(actor, locationKey) {
  const allItems = actor.items.contents;

  const equippedArmor = allItems.filter(i => i.type === "armor" && i.system.equipped);
  const cwArmorItems  = allItems.filter(i => {
    if (i.type !== "cyberware" || !i.system.equipped) return false;
    const cwt   = i.system?.CyberWorkType;
    if (!cwt) return false;
    const types = Array.isArray(cwt.Types) ? cwt.Types : (cwt.Type ? [cwt.Type] : []);
    return types.includes("Armor");
  });

  const coversSP = (item) =>
    (Number(item.system?.coverage?.[locationKey]?.stoppingPower) || 0) > 0;
  const cwCovers = (cw) =>
    (Number(cw.system?.CyberWorkType?.Locations?.[locationKey]) || 0) > 0;

  const coveringArmor = equippedArmor.filter(coversSP);

  const manualSlots = actor.system.armorLayers?.[locationKey] ?? [];
  const hasManualAssignment = manualSlots.some(id => id && id !== "");

  let orderedLayers;
  if (hasManualAssignment) {
    // Manual order: assigned items first, then unassigned in auto order
    const assignedIds = new Set(manualSlots.filter(Boolean));
    const manual = manualSlots
      .filter(Boolean)
      .map(id => coveringArmor.find(a => a.id === id) ?? null)
      .filter(Boolean);
    const unassigned = coveringArmor.filter(a => !assignedIds.has(a.id));
    orderedLayers = [...manual, ...getAutoLayerOrder(unassigned)];
  } else {
    orderedLayers = getAutoLayerOrder(coveringArmor);
  }

  return {
    orderedLayers,
    cwItems: cwArmorItems.filter(cwCovers),
    // keep for backward compat with any callers using .unassigned
    get unassigned() { return []; },
  };
}
