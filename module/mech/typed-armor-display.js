/**
 * Honest conditional-armor display (D5 typed-SP).
 *
 * PROBLEM: the base actor.js `prepareData` folds every worn layer's coverage SP into
 * `system.hitLocations[loc].stoppingPower` TYPE-BLINDLY (maxLayeredSP). So a fire-only Salamander
 * (coverage 20, mechTypedSP fire/0) inflates the panel to 20 though it stops 0 against a bullet, and
 * a dual-value layer's typed protection is invisible — the panel disagrees with the damage math,
 * which filters typed layers per the hit's damage type.
 *
 * FIX (display only): a `prepareData` post-step that re-derives the panel from the SAME type-aware
 * machinery the damage resolver uses — DamageApplicator `_deriveLiveSP`, the single source of truth —
 * so the number on the sheet equals the SP a hit will actually meet:
 *   • `system.hitLocations[loc].stoppingPower` is overwritten with the honest CONVENTIONAL total
 *     (`_deriveLiveSP(actor, loc, "")`, typed-only layers excluded).
 *   • `system.conditionalSP` (a read-only derived map) lists ONLY the typed damage-types that add
 *     protection somewhere → per-covered-location the typed SP, for the sub-panel to render.
 *
 * It changes NO damage/ablation behaviour and re-implements NO SP math. It is gated on
 * `_wearsTypedLayers`: a wearer of no typed layer is byte-for-byte unchanged (zero overhead) because
 * the base's type-blind fold already equals `_deriveLiveSP(loc, "")` for them (foldArmorSP mirrors the
 * base maxLayeredSP, M16). Wrapped AFTER the borg seed so the chassis SP `_deriveLiveSP` folds in is
 * this step's final word (never double-combined). Mirrors the stat-mods/borg prepareData-wrap idiom.
 */
import { _deriveLiveSP, _wearsTypedLayers } from "../combat/DamageApplicator.js";

const SCOPE = "cp2020-augmented";

// The armor-bearing hit locations — exactly the keys the base folds coverage into (template.json
// hitLocations) and the keys `_deriveLiveSP` resolves against. Any non-armor location the base leaves
// at 0 is intentionally untouched.
const ARMOR_LOCATIONS = ["Head", "Torso", "rArm", "lArm", "rLeg", "lLeg"];

// The typed damage-types a hit can carry — the SAME closed enum the damage dialog offers
// (templates/dialog/damage-dialog.hbs) and the conditional-armor partial labels. A garment typed
// against anything else can never be selected as a hit type, so it is (correctly) never surfaced.
// "radiation" is deliberately EXCLUDED: radiation left the per-hit SP model for the Deep Space dose
// subsystem (module/radiation/), where a rad-suit's mechTypedSP{radiation} value is read as its RSP
// (rads/turn) instead of a conditional SP — so a rad-suit no longer shows in this conditional panel.
const TYPED_DAMAGE_TYPES = ["fire", "heat"];

/**
 * prepareData post-step for a character/NPC (borgs are characters): make the armor panel honest.
 * Mutates prepared data only — never persists.
 */
export function applyTypedArmorDisplay(actor) {
  if (!actor || (actor.type !== "character" && actor.type !== "npc")) return;
  const system = actor.system;
  if (!system?.hitLocations) return;

  // Always drop any prior derived map first: an actor that just removed its last typed layer must not
  // keep a stale conditional section. A no-op (and thus byte-for-byte unchanged) for a non-typed actor
  // that never had one.
  if ("conditionalSP" in system) delete system.conditionalSP;

  // Non-typed wearer: the base type-blind fold is already the honest number — leave the panel exactly
  // as the base + borg passes computed it (no recompute, no overhead).
  if (!_wearsTypedLayers(actor)) return;

  const conditional = {};
  for (const loc of ARMOR_LOCATIONS) {
    const hitLoc = system.hitLocations[loc];
    if (!hitLoc) continue;

    // Honest CONVENTIONAL total (typed-only layers excluded) — OVERWRITES the base's type-blind value.
    // Includes any borg chassis SP because `_deriveLiveSP` folds it in itself.
    const conventional = Number(_deriveLiveSP(actor, loc, "")) || 0;
    hitLoc.stoppingPower = conventional;

    // A typed value that EXCEEDS the conventional total at this location is real added protection —
    // record it. (Equal or lower = the type grants nothing extra here, so it is not surfaced.)
    for (const type of TYPED_DAMAGE_TYPES) {
      const typedSP = Number(_deriveLiveSP(actor, loc, type)) || 0;
      if (typedSP > conventional) (conditional[type] ??= {})[loc] = typedSP;
    }
  }

  // Only publish the map when a type actually adds protection somewhere — so the include stays hidden
  // (`{{#if system.conditionalSP}}`) when a worn typed layer grants nothing extra.
  if (Object.keys(conditional).length) system.conditionalSP = conditional;
}

let _wrapped = false;
/**
 * Wrap the actor's prepareData once so the honest-display post-step runs AFTER the base fold (and the
 * borg chassis seed). Register this AFTER registerBorg() — running before it would let the borg seed
 * re-combine chassis SP on top of our already-chassis-inclusive value (double count).
 */
export function registerTypedArmorDisplay() {
  const proto = CONFIG?.Actor?.documentClass?.prototype;
  if (proto && !_wrapped) {
    const orig = proto.prepareData;
    proto.prepareData = function () {
      orig.call(this);
      try { applyTypedArmorDisplay(this); } catch (e) { console.warn(`${SCOPE} | typed armor display failed`, e); }
    };
    _wrapped = true;
  }
}
