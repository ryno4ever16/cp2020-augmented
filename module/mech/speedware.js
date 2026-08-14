/**
 * SPEEDWARE ACTIVATION FIDELITY — an activated initiative boost runs for its printed span and stops.
 *
 * THE BOOK (Core p.81, via the chrome-criteria audit record). Boosterware comes in two shapes and the
 * difference is the whole of this file: the Kerenzikov is ALWAYS-ON (+1 / +2 initiative, nothing to
 * switch), while the Sandevistan is ACTIVATED ONLY — "+3 initiative, 5 turns". A boost that is never
 * switched off is not the Sandevistan; it is a Kerenzikov III that costs 1600eb.
 *
 * ⭐ WHAT WAS ACTUALLY MISSING, measured before anything was built. The pack entry
 * (`cyberpunk2020.neuralware` → Sandevistan Speedware) already carries `EffectMode: "Activatable"`
 * beside its `CyberWorkType.Checks.Initiative: 3`, and the BASE system already gates that payload on
 * it: `_getCharacteristicChecksMods` (base `actor.js`) skips any implant `cwIsEnabled` rejects, and
 * base `cwIsEnabled` returns false for an Activatable implant whose `EffectActive` is off. So the
 * inactive-contributes-nothing half of this unit was ALREADY TRUE in the base system, and the survey
 * note that called the pack data "a passive +3" was reading the Checks payload without its mode. That
 * finding is asserted by this unit's keeper rather than trusted, and NOTHING here re-implements it.
 *
 * What was genuinely absent was the other half — the implant, once switched on, stayed on forever:
 *   · no duration, so the printed "5 turns" was bookkeeping the GM did in their head or not at all;
 *   · no visible control, since `EffectActive` lived only on the item sheet's Settings tab;
 *   · no announcement, so the table never saw the moment.
 *
 * HOW IT IS BUILT — by RENTING the timer that already ships, not by growing a second one. P7
 * (`mech/consumable.js`) already implements exactly this lifecycle for Activatable cyberware:
 * activation starts a per-actor timer, the active GM's round tick counts it down on the owner's turn,
 * and expiry flips `EffectActive` back off (which drops the base payload with it), posts a wear-off
 * card and clears the token icon. It reaches that lifecycle through one field — `mechConsumable` —
 * and the only reason the Sandevistan did not have it was that its pack entry carries no such block.
 *
 * So this file supplies the block AT READ TIME and changes nothing else:
 *
 *   ⛔ NOTHING IS EVER WRITTEN. The block is applied in a `prepareData` wrapper on the ITEM, which
 *   mutates PREPARED data only — the same read-time treatment `data-corrections.js` gives armour
 *   hardness (`correctedArmorType`), and for the same reason: an implant already installed on a
 *   character was created long before this rule existed and has to behave correctly NOW, which a
 *   creation-time patch could never reach. Tilt's stored pack data is not touched, and neither is the
 *   owned copy's.
 *
 *   ⏱ THE ORDERING THAT MAKES IT WORK. Foundry prepares embedded items inside the actor's own
 *   `super.prepareData()`, and the base system's stat pass (`_prepareCharacterData`) runs AFTER that
 *   call returns — so an item-level overlay is already in place by the time the actor sums initiative.
 *   Verified in base `actor/actor.js` (`prepareData` → `super.prepareData()` → `_prepareCharacterData`).
 *
 * IDENTIFIED BY MECHANISM, NEVER BY NAME (framing gate). An "activated initiative boost" is any
 * cyberware that buys initiative through the base Characteristic check payload AND declares itself
 * Activatable. Across every shipped pack that is the Sandevistan alone; a homebrew implant built the
 * same way is the same kind of thing and gets the same clock, which a name list could never do.
 *
 * Pure helpers are exported for the keeper; the wrapper is wired by registerSpeedware().
 */

import { cwHasType } from "../utils.js";

const SCOPE = "cp2020-augmented";

/**
 * The printed span of an activated boost, in the owner's combat turns.
 *
 * FIVE, from the book's own line for the Sandevistan ("+3 init, 5 turns" — Core p.81, recorded in the
 * chrome-criteria audit). It is a DEFAULT, not a law: an item that carries its own `mechConsumable`
 * block keeps it (see speedwareTimerFor), so a GM or a supplement implant with a different span is
 * never overridden by this number.
 */
export const SPEEDWARE_DURATION_TURNS = 5;

/** The initiative this implant's Characteristic payload buys. Pure. */
export function boostInitiativeOf(item) {
  return Number(item?.system?.CyberWorkType?.Checks?.Initiative) || 0;
}

/**
 * Is this an ACTIVATED initiative boost — the shape the Sandevistan is and the Kerenzikov is not?
 *
 * Deliberately NOT gated on `equipped` or on `EffectActive`: this asks what KIND of implant it is, a
 * question whose answer does not change when it is uninstalled or switched off. The equip/active gates
 * belong to the engines that consume it (the base's own payload sum, and book-legality's slot rule).
 * Pure.
 */
export function isActivatedInitiativeBoost(item) {
  if (item?.type !== "cyberware") return false;
  if (item.system?.EffectMode !== "Activatable") return false;
  if (!cwHasType(item, "Characteristic")) return false;
  return boostInitiativeOf(item) > 0;
}

/**
 * The `mechConsumable` block an activated boost should be read as carrying, or null to leave the item
 * alone.
 *
 * Null in the two cases where supplying one would be an intrusion rather than a fix: the item is not
 * an activated boost, or it ALREADY declares an enabled block of its own — a GM who configured a
 * duration (or a future pack that ships one) owns that answer, and this overlay never argues with
 * stored data that speaks for itself.
 *
 * `unlimited` because the book prints a span and no ration: the Sandevistan may be switched on again
 * whenever its user likes, unlike the Adrenal Booster's "3x per day". Pure.
 */
export function speedwareTimerFor(item) {
  if (!isActivatedInitiativeBoost(item)) return null;
  if (item.system?.mechConsumable?.enabled) return null;
  return {
    enabled: true,
    doses: 0,
    unlimited: true,
    durationTurns: String(SPEEDWARE_DURATION_TURNS),
    // Card text; item DATA in the corrections-layer sense, so it stays English like every other note.
    note: `+${boostInitiativeOf(item)} Initiative`,
  };
}

/**
 * Read the timer onto the prepared item. Mutates PREPARED data only — never persists.
 *
 * Leaf-by-leaf onto the existing prepared object rather than replacing it, so the schema's own object
 * identity survives (the field is a SchemaField; handing it a bare replacement is the kind of thing
 * that works until something else holds a reference to it).
 */
export function applySpeedwareTimer(item) {
  const timer = speedwareTimerFor(item);
  if (!timer) return;
  const block = item.system.mechConsumable;
  if (!block) { item.system.mechConsumable = { ...timer }; return; }
  for (const [k, v] of Object.entries(timer)) block[k] = v;
}

let _wrapped = false;
/**
 * Wrap the Item's `prepareData` so an activated boost reads as carrying its printed clock.
 *
 * Wrapped at INIT, before any document prepares, so the very first world load already sees it — and on
 * the ITEM rather than the actor because the consumer is the actor's own stat pass, which runs after
 * its embedded items are prepared (see the ordering note in this file's header).
 */
export function registerSpeedware() {
  const proto = CONFIG?.Item?.documentClass?.prototype;
  if (!proto || _wrapped) return;
  const orig = proto.prepareData;
  proto.prepareData = function () {
    orig.call(this);
    try { applySpeedwareTimer(this); } catch (e) { console.warn(`${SCOPE} | speedware timer failed`, e); }
  };
  _wrapped = true;
}
