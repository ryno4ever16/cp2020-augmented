/**
 * BOOK-LEGALITY ENFORCEMENT — the armor layer law and the boost family limit, with teeth in the math.
 *
 * THE GAP THIS CLOSES. The book's limits were already implemented as ARITHMETIC and nowhere as LAW:
 * the proportional fold (base `actor.js` maxLayeredSP, our `utils.foldArmorSP`) combines however many
 * layers a wearer owns, the inside-out ordering (`combat/armor-layers.js`) decides which sits where —
 * but nothing capped the stack at three, nothing stopped a second rigid layer, nothing charged the
 * layer surcharge, and two boosterware silently stacked their initiative. The generator composes legal
 * stacks by construction (`npcgen/armor.js`); a hand-built character had no such guarantee. This file
 * is the general enforcement, and it applies to every actor — a player's gear included.
 *
 * ⛔ IT SIMULATES, IT NEVER BLOCKS. An illegal piece can always be worn; it simply protects nothing,
 * and the wearer is told which rule made it useless. No equip is ever refused.
 *
 * THE THREE PIECES, and where each one lands:
 *   1. THE FOLD — `combat/armor-layers.js` `getArmorContributors` already hands back only the legal
 *      subset, so the damage math, the ablation sweep and the layer readout inherit the law with no
 *      further work. What is left for this file is the SHEET: the base's prepared per-location SP was
 *      folded type-blind and law-blind, so it is re-derived here from the damage system's own
 *      `_deriveLiveSP` (one source of truth — the panel cannot disagree with the hit).
 *   2. THE EV — the 2nd counted layer costs −1 EV and the 3rd −2 more (`LAYER_LAW.extraEvPerLayer`),
 *      folded into the derived encumbrance figure the base already subtracts from REF, so every
 *      effective-REF and skill path inherits it through the path that already exists.
 *   3. THE BOOST — one boosterware per character (Core p.81, "you may only select ONE type of
 *      boosterware"); a later one contributes nothing to the initiative implant figure. The slot is
 *      claimed by INSTALLATION ORDER and an ACTIVATED boost claims it switched off as well as on (see
 *      isBoosterware) — activation decides only whether the slot-holder's payload is live, which is
 *      the base system's own gate and not this file's. Composed with mech/speedware.js's clock.
 *
 * ORDERING NOTE (deliberate, mirrors the sibling wraps). The base subtracts encumbrance BEFORE its
 * wound divisor, and this post-step necessarily runs after the whole base pass — so on a wounded
 * character the layer surcharge lands undivided, exactly as the moddy and drug wraps' contributions
 * do. Reconstructing the pre-wound total to divide it would mean re-deriving a base computation this
 * file does not own; the surcharge is at most 3 and the consistency with the neighbouring wraps is
 * worth more than the rounding.
 *
 * Pure helpers are exported for the keeper; the wrap and the hook are wired by registerBookLegality().
 */

import { getArmorContributors, LAYER_LAW } from "./armor-layers.js";
import { _deriveLiveSP } from "./DamageApplicator.js";
import { cwHasType, cwIsEnabled, localize, localizeParam } from "../utils.js";

const SCOPE = "cp2020-augmented";

/** The armor-bearing hit locations — the keys the base folds coverage into and `_deriveLiveSP` resolves. */
const ARMOR_LOCATIONS = ["Head", "Torso", "rArm", "lArm", "rLeg", "lLeg"];

/** Location key → the i18n key its label already lives under (reused, not duplicated). */
const LOCATION_LABEL_KEYS = {
  Head: "Head", Torso: "Torso",
  lArm: "ArmorLayers.LocLArm", rArm: "ArmorLayers.LocRArm",
  lLeg: "ArmorLayers.LocLLeg", rLeg: "ArmorLayers.LocRLeg",
};

// =================================================================================================
// THE LAYER SURCHARGE
// =================================================================================================

/**
 * The cumulative EV the law charges for wearing `counted` layers: the 1st is free, the 2nd costs 1,
 * the 3rd costs 2 more — so 0 / 0 / 1 / 3. Counts past the table's length keep charging its last
 * step, which never happens under the three-layer cap but keeps the function total. Pure.
 */
export function layerEvPenalty(counted) {
  const n = Math.max(0, Math.trunc(Number(counted) || 0));
  const table = LAYER_LAW.extraEvPerLayer;
  let ev = 0;
  for (let i = 0; i < n; i++) ev += table[i] ?? table[table.length - 1] ?? 0;
  return ev;
}

/**
 * The actor's layer surcharge and the per-location counts behind it.
 *
 * EV is one whole-body figure while layering is per-location, so the charge is the WORST-stacked
 * location's — three layers on the torso encumbers the wearer whether or not the shins match. Pure
 * given the actor's prepared items.
 */
export function actorLayerEv(actor) {
  const byLocation = {};
  let worst = 0;
  for (const loc of ARMOR_LOCATIONS) {
    const counted = Number(getArmorContributors(actor, loc)?.countedLayers) || 0;
    byLocation[loc] = counted;
    if (counted > worst) worst = counted;
  }
  return { ev: layerEvPenalty(worst), counted: worst, byLocation };
}

// =================================================================================================
// THE BOOST FAMILY LIMIT (Core p.81)
// =================================================================================================

/**
 * Is this an INSTALLED boosterware — the thing the book lets you have one of?
 *
 * Identified by MECHANISM, not by name: boosterware is the cyberware that buys initiative through the
 * base system's Characteristic check payload (`CyberWorkType.Checks.Initiative`), which is exactly
 * what `_getCharacteristicChecksMods` sums into `system.initiativeImplantMod`. Across every shipped
 * pack that payload is carried by the three boosterware entries and nothing else, and a homebrew
 * entry that buys initiative the same way is the same kind of thing.
 *
 * ⭐ SWITCHED OFF STILL COUNTS AS INSTALLED (2026-08-14, with the activated-boost clock). The book's
 * limit is on SELECTION — "you may only select ONE type of boosterware" — which is a fact about what
 * is in the character's body, not about what is running this second. An activated boost (the
 * Sandevistan; see mech/speedware.js) is therefore holding the one slot whether or not it is
 * currently on, and this predicate deliberately does NOT ask `cwIsEnabled`.
 *
 * WHY THAT READING AND NOT "WHICHEVER IS ON WINS": the slot would otherwise change hands on a button
 * press, and a character carrying a Kerenzikov AND a Sandevistan would collect the Kerenzikov's
 * passive +1 whenever the Sandevistan was off and +3 whenever it was on — strictly better than either
 * implant alone, which is the exact stacking the rule exists to forbid. Holding the slot by
 * installation order keeps `boosterwareLayers` deterministic (document order, the same answer on
 * every client, stable across a click) and leaves no order in which owning two beats owning one.
 *
 * The CONTRIBUTION gate stays where it always was — the base system drops an inactive Activatable
 * implant's payload itself, and applyBoostExclusivity below only ever subtracts what actually landed.
 * Pure.
 */
export function isBoosterware(item) {
  if (item?.type !== "cyberware") return false;
  if (!item.system?.equipped) return false;
  if (!cwHasType(item, "Characteristic")) return false;
  return (Number(item.system?.CyberWorkType?.Checks?.Initiative) || 0) > 0;
}

/**
 * Split the actor's boosterware into the one that works and the ones that do not.
 *
 * WHICH ONE KEEPS WORKING: the first in the actor's own item collection — the earliest installed, and
 * the one at the top of the sheet's list. Deterministic, stable for a given character, and the same
 * answer on every client because it reads document order rather than anything client-local. Pure.
 */
export function boosterwareLayers(actor) {
  const all = (actor?.items?.contents ?? []).filter(isBoosterware);
  return { active: all[0] ?? null, surplus: all.slice(1) };
}

// =================================================================================================
// THE prepareData POST-STEP
// =================================================================================================

/**
 * Re-derive the armor panel wherever the law excluded a layer, and charge the layer surcharge.
 * Mutates prepared data only — never persists.
 */
export function applyLayerLegality(actor) {
  const system = actor.system;
  if (!system?.hitLocations) return;

  // Only locations that actually carry a surplus need re-deriving; everywhere else the base's fold is
  // already the legal answer, so an ordinary wearer's prepared data is left byte-for-byte alone.
  for (const loc of ARMOR_LOCATIONS) {
    const hitLoc = system.hitLocations[loc];
    if (!hitLoc) continue;
    if (!getArmorContributors(actor, loc)?.illegalLayers?.length) continue;
    // `_deriveLiveSP` is the damage pipeline's own fold over the legal set (and folds a borg chassis
    // in itself), so the number on the panel is the number a hit will meet.
    hitLoc.stoppingPower = Number(_deriveLiveSP(actor, loc, "")) || 0;
  }

  const { ev } = actorLayerEv(actor);
  if (!ev) return;
  const ref = system.stats?.ref;
  if (!ref) return;
  // Ride the base's OWN encumbrance figure — `stats.ref.armorMod` is what the character sheet already
  // labels "Encumbrance" and what the base already subtracted from the REF total, so the surcharge is
  // visible where a player looks for it and reaches every roll through the path that already exists.
  ref.armorMod = (Number(ref.armorMod) || 0) - ev;
  ref.total = (Number(ref.total) || 0) - ev;
}

/**
 * Drop the contribution of every boosterware after the first. Mutates prepared data only.
 *
 * ⚠ ONLY WHAT ACTUALLY LANDED IS SUBTRACTED. Since a switched-off activated boost still holds the slot
 * (isBoosterware above), the surplus list can contain an implant whose payload the BASE never summed —
 * `_getCharacteristicChecksMods` skips anything `cwIsEnabled` rejects, which is exactly an Activatable
 * implant that is off. Subtracting its +3 anyway would push `initiativeImplantMod` NEGATIVE and quietly
 * tax the legal boost for the presence of a dormant one. So the filter is the same gate the base used.
 */
export function applyBoostExclusivity(actor) {
  const { surplus } = boosterwareLayers(actor);
  if (!surplus.length) return;
  const dropped = surplus
    .filter(i => cwIsEnabled(i))
    .reduce((s, i) => s + (Number(i.system?.CyberWorkType?.Checks?.Initiative) || 0), 0);
  if (!dropped) return;
  actor.system.initiativeImplantMod = (Number(actor.system.initiativeImplantMod) || 0) - dropped;
}

/** The whole post-step for a character/NPC (borgs are characters). */
export function applyBookLegality(actor) {
  if (!actor || (actor.type !== "character" && actor.type !== "npc")) return;
  applyLayerLegality(actor);
  applyBoostExclusivity(actor);
}

// =================================================================================================
// EQUIP-TIME NOTICES
// =================================================================================================

/**
 * Is this a limb covering?
 *
 * ⚠ NAME-BASED, and deliberately so: the packs give a covering no field of its own — the four shipped
 * ones (Armor, RealSkinn, Superchrome, Plastic) share only the "Covering" in their names and the
 * cyberarm they mount into. Recorded here as the single place that guess lives, so a data field can
 * replace it in one edit if one ever appears.
 */
function isCovering(item) {
  return item?.type === "cyberware" && /covering/i.test(item.name ?? "");
}

/** The other coverings already installed in the same host limb as `item`. Pure. */
function siblingCoverings(actor, item) {
  const parentId = String(item?.system?.Module?.ParentId ?? "");
  if (!parentId || !isCovering(item)) return [];
  return (actor?.items?.contents ?? []).filter(other =>
    other.id !== item.id && isCovering(other) && !!other.system?.equipped &&
    String(other.system?.Module?.ParentId ?? "") === parentId);
}

/**
 * Which book rules this item's presence violates, as stable KEYS — no i18n in here, so the pure
 * verdict can be asserted directly and the render edge owns the wording.
 *
 * At most one entry per rule: a coat that is surplus on four locations is one notice, not four.
 * @returns {{key: string, params: object}[]}
 */
export function equipViolations(actor, item) {
  const found = new Map();
  const add = (key, params) => { if (!found.has(key)) found.set(key, { key, params }); };

  const { active, surplus } = boosterwareLayers(actor);
  if (surplus.some(i => i.id === item?.id) && active) {
    add("SecondBoost", { name: item.name, other: active.name });
  }

  const covers = siblingCoverings(actor, item);
  if (covers.length) add("OneCovering", { name: item.name, other: covers[0].name });

  for (const loc of ARMOR_LOCATIONS) {
    const entry = (getArmorContributors(actor, loc)?.surplusLayers ?? []).find(e => e.item.id === item?.id);
    if (!entry) continue;
    const location = localize(LOCATION_LABEL_KEYS[loc] ?? loc);
    if (entry.reason === "maxLayers") { add("MaxLayers", { name: item.name, location }); continue; }
    // A second rigid piece on the HEAD is the chrome audit's own named rule (a helmet or a
    // cowl/faceplate, not both), so it says that instead of the general one-hard-layer line.
    if (loc === "Head") {
      const other = getArmorContributors(actor, loc).orderedLayers.concat(getArmorContributors(actor, loc).cwItems)
        .find(i => i.id !== item?.id);
      add("HeadArmor", { name: item.name, other: other?.name ?? "" });
    } else {
      add("MaxHard", { name: item.name, location });
    }
  }
  return [...found.values()];
}

// =================================================================================================
// REGISTRATION
// =================================================================================================

/** Did this update switch the item on? Pure. */
function equippedOn(changes) {
  return foundry.utils.getProperty(changes ?? {}, "system.equipped") === true;
}

/** Did this update ACTIVATE the item's payload (an Activatable implant's switch)? Pure. */
function activatedOn(changes) {
  return foundry.utils.getProperty(changes ?? {}, "system.EffectActive") === true;
}

let _wrapped = false;
/**
 * Wrap prepareData so the legality post-step runs after the base's full pass, and wire the equip-time
 * notices.
 *
 * ⚠ Register AFTER registerBorg(): `_deriveLiveSP` folds a borg's chassis SP in itself, and the borg
 * seed combines chassis SP into the same field, so running before it would double-count. Registering
 * before registerTypedArmorDisplay() is equally deliberate — that wrap re-derives the panel from the
 * SAME `_deriveLiveSP`, so for a typed wearer it simply restates this step's answer.
 */
export function registerBookLegality() {
  const proto = CONFIG?.Actor?.documentClass?.prototype;
  if (proto && !_wrapped) {
    const orig = proto.prepareData;
    proto.prepareData = function () {
      orig.call(this);
      try { applyBookLegality(this); } catch (e) { console.warn(`${SCOPE} | book legality failed`, e); }
    };
    _wrapped = true;
  }

  // The notice fires on the equip that CREATES the violation — never on a re-prepare, so a character
  // sheet does not nag on every render. Shown to the person who did it and to any GM watching; a
  // player switching gear on their own sheet still gets told why it did nothing.
  //
  // ACTIVATION counts as such a moment too (2026-08-14). A surplus activated boost is the one case
  // where a deliberate, visible action produces no effect at all: the player clicks the Sandevistan,
  // gets its card and its clock, and gains nothing because an earlier-installed boost holds the one
  // slot. Firing the same violation pass on the switch-on is what turns that silence into the rule's
  // own sentence, at the moment the table is looking at it.
  Hooks.on("updateItem", (item, changes, options, userId) => {
    if (!equippedOn(changes) && !activatedOn(changes)) return;
    const actor = item?.actor;
    if (!actor || (actor.type !== "character" && actor.type !== "npc")) return;
    if (userId !== game.user?.id && game.user?.isGM !== true) return;
    try {
      for (const v of equipViolations(actor, item)) {
        ui.notifications?.warn(localizeParam(`BookLegality.${v.key}`, v.params));
      }
    } catch (e) { console.warn(`${SCOPE} | book legality notice failed`, e); }
  });
}
