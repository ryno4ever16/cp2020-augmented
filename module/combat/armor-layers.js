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
 *   combined via utils.combineArmorSP(armorSP, coverSP). Cover has no slot in this module.
 *
 * DATA MODEL:
 *   system.armorLayers per location: ["itemId1", "itemId2", ...]
 *   Empty array = auto-ordering for that location.
 *   Cyberware armor is never put in these slots.
 *
 * BOOK LEGALITY (see `selectLegalLayers`):
 *   The ordering above decides what sits where; the LAW decides how much of it counts. A stack is
 *   capped at three counted layers with at most one hard one, and a skinweave is free of both — so
 *   `getArmorContributors` hands its consumers only the legal subset, and everything downstream
 *   (the proportional fold, the ablation sweep, the layer readout) inherits the limit for free.
 *   The actor-level consequences — the EV surcharge, the panel refresh, the equip-time notices —
 *   live in `combat/book-legality.js`.
 */

// The law itself is DATA, defined once in `npcgen/armor.js` (a pure, Foundry-free file the generator
// reads to compose legal stacks by construction) and imported here rather than restated, so the
// number that shapes a generated goon is literally the number that shapes a hand-built one.
import { LAYER_LAW } from "../npcgen/armor.js";
import { cwIsSkinweave } from "../utils.js";
import { correctedArmorType } from "../data-corrections.js";
// The one function that says what a layer is WORTH against a given damage type. Imported rather than
// re-derived so the legality walk values an entry with the same arithmetic the fold uses; that file
// imports nothing, so there is no cycle.
import { typedLayerSP } from "../data/mech-item-data.js";

export { LAYER_LAW };

/**
 * Determine whether an armor item is "hard" (rigid) or "soft" (flexible).
 * Resolution order: the item's own `armorType` → the book's printed table (read-time corrections,
 * data-corrections.js) → name heuristics → encumbrance.
 *
 * Soft: cloth, leather, Kevlar, t-shirt, jackets, body suit
 * Hard: metal gear, body armor, full body armor, plate — plus the printed table's flak vest/pants,
 *       steel and ballistic-nylon helmets and Door Gunner's vest, which the name test alone misses.
 */
export function getArmorHardness(armorItem) {
  // Case-insensitive: the module's own supplement pack stores "Hard"/"Soft" capitalised, and a strict
  // compare silently discarded the field and fell through to the guesswork below.
  const explicit = String(armorItem?.system?.armorType ?? "").toLowerCase();
  if (explicit === "hard" || explicit === "soft") return explicit;

  const corrected = correctedArmorType(armorItem);
  if (corrected) return corrected;

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
 * Is this layer one the law lets a wearer have for free — no slot spent, no EV surcharge?
 *
 * Skinweave only, and detected by the base system's own stable `cyberwareSubtype` field rather than
 * by name (names get edited; the subtype is what the packs and the sheet already key on).
 */
export function isFreeLayer(item) {
  return cwIsSkinweave(item);
}

/**
 * ⭐ THE LEGAL SUBSET. Walk an inside-out layer list and decide which pieces actually protect.
 *
 * THE RULE, stated once so it can be argued with: layers are admitted in the SAME inside-out order
 * the fold already uses, and the first legal ones win — a piece is admitted while the wearer is
 * under the three-counted-layer cap and while it is not a second hard layer; anything left over is
 * SURPLUS and contributes nothing at all. First-N-wins is chosen because it is deterministic and
 * because it is what the ordering already means (a piece worn under another is the one in contact),
 * rather than searching for whichever subset happens to score highest — a wearer does not get a
 * better answer by owning more coats than the law allows.
 *
 * Two entries never spend a slot:
 *   • a SKINWEAVE — the book's own exemption ("a layer, but takes no penalty");
 *   • an entry with no conventional SP here — a fully-typed garment (a fire coat against a bullet)
 *     or a borg's zero-coverage typed shielding. Both are already outside every normal-hit fold, so
 *     spending one of three slots on them would cost the wearer real protection for nothing.
 *
 * PURE. `entries` are `{ item, sp }` inside-out; the return keeps that order.
 * @returns {{legal: object[], surplus: object[], counted: number}}  surplus entries carry `reason`.
 */
export function selectLegalLayers(entries) {
  const legal = [], surplus = [];
  let counted = 0, hardCount = 0;
  for (const entry of entries ?? []) {
    if ((Number(entry?.sp) || 0) <= 0 || isFreeLayer(entry.item)) { legal.push(entry); continue; }
    if (counted >= LAYER_LAW.maxLayers) { surplus.push({ ...entry, reason: "maxLayers" }); continue; }
    const hard = getArmorHardness(entry.item) === "hard";
    if (hard && hardCount >= LAYER_LAW.maxHardLayers) { surplus.push({ ...entry, reason: "maxHard" }); continue; }
    legal.push(entry);
    counted += 1;
    if (hard) hardCount += 1;
  }
  return { legal, surplus, counted };
}

/**
 * Return armor items contributing SP at a location, in layer order.
 * If manual layers are assigned for this location, uses that order.
 * Otherwise uses auto-ordering.
 *
 * Only the BOOK-LEGAL subset comes back (see `selectLegalLayers`); the pieces the law excludes are
 * reported separately in `illegalLayers` so a readout or a notice can name them, and are absent from
 * `orderedLayers`/`cwItems` so no consumer has to remember the rule.
 *
 * @param {Actor}  actor
 * @param {string} locationKey   e.g. "Head", "Torso", "lArm"
 * @returns {{
 *   orderedLayers:  Item[],   inside-out, assigned or auto-ordered — LEGAL contributors only
 *   cwItems:        Item[],   innermost contributors: cyberware armor + zero-coverage typed cyberware (typedCw)
 *   illegalLayers:  Item[],   pieces the layer law excludes here (they protect nothing)
 *   surplusLayers:  object[], the same pieces as `{ item, sp, reason }` for the warning edge
 *   countedLayers:  number,   how many layers this location spends against the cap
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

  // Typed-SP cyberware (a borg's printed radiation shielding): the printed rating guards the
  // wearer on MATCHING damage-type hits only. Such items carry no conventional Locations SP, so
  // the cwCovers gate would drop them before typedLayerSP (module/data/mech-item-data.js) ever
  // saw them — admit them here; their conventional 0 keeps them out of every normal-hit fold.
  // The mount zone is where the device occupies space; the printed "body shielding" covers the body.
  const typedCw = allItems.filter(i =>
    i.type === "cyberware" && i.system?.equipped &&
    String(i.system?.mechTypedSP?.type ?? "").trim() !== "" &&
    !(cwArmorItems.includes(i) && cwCovers(i)));

  // (A zero-coverage typed ARMOR admission once lived here for the Radsuit/Battlesuit — commit 78bdcae —
  // so a rad-suit contributed its typed rating against a per-hit "radiation" damage type. Radiation has
  // since left the per-hit SP model for the Deep Space DOSE subsystem (module/radiation/), where a
  // rad-suit's mechTypedSP{radiation}.sp is read as its RSP; the admission was therefore reverted.)
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

  // cwItems = the innermost non-layered contributors: conventional cyberware armor + zero-coverage typed
  // CYBERWARE (typedCw — a borg's printed radiation/typed shielding). Consumers dispatch on item.type.
  const cwItems = [...cwArmorItems.filter(cwCovers), ...typedCw];

  // The legality walk sees exactly the sequence the fold sees: chrome against the skin, then the worn
  // pieces inside-out. Its verdict is type-blind (one conventional SP per piece), so a wearer's legal
  // set is the same set for every damage type — a hit's type changes what a layer is WORTH, never
  // whether it is being worn.
  //
  // Each entry is valued CONVENTIONALLY — `typedLayerSP(item, raw, "")`, the value a normal hit meets —
  // and not by the raw coverage number, because that is the value `selectLegalLayers` tests against
  // when it hands out the free-layer branch its comment promises. A fully-typed garment (a fire coat:
  // coverage 20, mechTypedSP { fire, 0 }) values at 0, so it spends no slot, ejects nothing, and adds
  // no layer surcharge. A dual-value layer (sp > 0) still reports its conventional SP and still spends
  // a slot, which is correct — it does stop ordinary hits.
  const conventionalSP = (item, raw) => Number(typedLayerSP(item, raw, "")) || 0;
  const { surplus, counted } = selectLegalLayers([
    ...cwItems.map(i => ({ item: i, sp: conventionalSP(i, Number(i.system?.CyberWorkType?.Locations?.[locationKey]) || 0) })),
    ...orderedLayers.map(i => ({ item: i, sp: conventionalSP(i, Number(i.system?.coverage?.[locationKey]?.stoppingPower) || 0) })),
  ]);
  const excluded = new Set(surplus.map(e => e.item.id));

  return {
    orderedLayers: excluded.size ? orderedLayers.filter(i => !excluded.has(i.id)) : orderedLayers,
    cwItems: excluded.size ? cwItems.filter(i => !excluded.has(i.id)) : cwItems,
    illegalLayers: surplus.map(e => e.item),
    surplusLayers: surplus,
    countedLayers: counted,
    // keep for backward compat with any callers using .unassigned
    get unassigned() { return []; },
  };
}
