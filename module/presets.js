/**
 * Settings presets — 4 additive playstyle tiers (Manual / Standard / By the Book / Maximum Crunch).
 *
 * One green-lit click sets a coherent bundle of world settings instead of asking a new GM to wade
 * through the long toggle list. Tiers stack: each is the previous one plus a clean delta. The data here
 * (the resolved per-tier value maps + the "notable feature" diff) is PURE; the apply / undo wrappers
 * read & write game.settings (impure). The picker UI lives in dialog/preset-picker.js.
 *
 * Module note: this mirrors the fork's presets.js but maps the MODULE's setting universe — it toggles
 * the module's combatAutomationEnabled MASTER (the fork has none) and OMITS settings the module doesn't
 * register (armor layers, autoRangefinding, fumble table, magazine reloading). Only registered keys are
 * touched (game.settings.set throws for an unregistered key).
 *
 * NOT touched by any preset (a GM/per-user choice): permissions (playersCanShop/playersCanBuyAmmo), the
 * Carolingian skin + other client display prefs, GM content/pricing (shopAllowHomebrew, shopShowSource,
 * ammoBlackhandsPricing, hitLocationCoreDisplay), the IP fine-tuning, and all config:false
 * stores.
 */

const SCOPE = "cp2020-augmented";

// Two settings the FORK system also registers (martial special hit-effects + FNFF2). On the fork they
// live under the SYSTEM scope and the accessors (settings.js specialMeleeEffectsEnabled, lookups.js
// isFnff2Enabled) read the system copy FIRST — the module keeps a hidden shadow only for vanilla. So a
// preset must read AND write whichever copy is authoritative: otherwise applying a tier writes the
// module shadow while behaviour (and the "already applied" diff) reads the system value, so the tier
// never registers as applied and the picker re-offers it on every reload. On vanilla the system key is
// absent, so settingScope() falls back to the module scope and it round-trips normally.
const SYSTEM_SCOPE = "cyberpunk2020";
// ⏪ specialMeleeEffectsEnabled left this set with the 2026-08-29 settings trim: the module no
// longer registers a shadow (action = consent), so there is nothing for a preset to write on
// vanilla, and the fork's system copy is the system's own business, not a module preset's.
const DUAL_OWNED = new Set(["fnff2Enabled"]);
function settingScope(key) {
  if (DUAL_OWNED.has(key)) {
    try { if (game.settings.settings.has(`${SYSTEM_SCOPE}.${key}`)) return SYSTEM_SCOPE; } catch (e) { /* not the fork */ }
  }
  return SCOPE;
}

// MANUAL = every preset-controlled setting at its "off / Core" value. Its KEYS define the full universe
// a preset touches; the deltas below only override.
// ⏪ 2026-08-29 SETTINGS TRIM: the universe shrank from ~29 keys to 12. Every retired feature switch
// (dodge/aim/wait presence gates, the ammo-consent gates, suppressive, movement, shotgun, occlusion,
// gas, acid/fire DOT, taser, special-melee, shopping master, vehicle control/damage, arc mode) left
// with its registration — those features are now always available and opt in/out BY USE, so no tier
// has anything to say about them. What remains for a preset to bundle: the automation master and the
// genuine rule/book choices.
const MANUAL = {
  // The combat-automation master OFF — Manual means the module automates nothing.
  combatAutomationEnabled: false,
  // Rule choices at their lightest: SP without wear, no severe-limb consequences, no per-action
  // penalty (multiActionPenaltyEnabled survived the trim — restored same day, the rule engages
  // automatically so it keeps a switch).
  limbLossEnabled: false, multiActionPenaltyEnabled: false,
  damageArmorMode: "simple",
  // Subsystems — Improvement-Point (RAW) tracking is ON at EVERY tier: ignorable if unused (the
  // neglect detector keeps it safe as a default). (⏪ shoppingEnabled was pinned true here until the
  // trim retired the switch — the shop is simply always present now.)
  ipRawTracking: true,
  // Supplements — off / Core
  mmEnabled: false, vehicleRuleSystem: "Core",
  vehicleArmorDamageEnabled: false, vehicleMoraleEnabled: false,
  fnff2Enabled: false, explosivesDetailed: false,
  // Universal baseline (same in every tier; Crunch overrides limbModel)
  headHitDoubling: true, limbModel: "core",
};

// STANDARD = Manual + the combat master + severe limb consequences.
const STANDARD_DELTA = {
  combatAutomationEnabled: true,
  // `damageAutoApply` was in this delta until 2026-08-14 — which is how a table got a preset that
  // silently stopped asking before it wrote damage. The setting is retired (there is no module-wide
  // rule any more; each instance of damage is decided at that instance), so no tier references it.
  limbLossEnabled: true, multiActionPenaltyEnabled: true,
};

// BY THE BOOK = Standard + the divisive-but-faithful bookkeeping: armor wears per RAW.
// (⏪ restrictMovementOncePerTurn rode here until the trim — over-movement now warns unconditionally.)
const BYBOOK_DELTA = {
  damageArmorMode: "full",
};

// MAXIMUM CRUNCH = By the Book + the supplement layer (Maximum Metal + Listen Up + FNFF2).
// (⏪ vehicleArcEnforcement:"strict" rode here until the trim — arcs now always warn, never block.)
const CRUNCH_DELTA = {
  mmEnabled: true, vehicleRuleSystem: "MaximumMetal", vehicleArmorDamageEnabled: true, vehicleMoraleEnabled: true,
  limbModel: "listenup", explosivesDetailed: true, fnff2Enabled: true,
};

const MANUAL_MAP   = { ...MANUAL };
const STANDARD_MAP = { ...MANUAL_MAP, ...STANDARD_DELTA };
const BYBOOK_MAP   = { ...STANDARD_MAP, ...BYBOOK_DELTA };
const CRUNCH_MAP   = { ...BYBOOK_MAP, ...CRUNCH_DELTA };

/** The 4 tiers, in additive order. `settings` is the fully-resolved value map for that tier. */
export const PRESETS = [
  { id: "manual",   labelKey: "PresetManual",         descKey: "PresetManualDesc",         settings: MANUAL_MAP },
  { id: "standard", labelKey: "PresetStandard",       descKey: "PresetStandardDesc",       settings: STANDARD_MAP },
  { id: "bythebook", labelKey: "PresetByTheBook",     descKey: "PresetByTheBookDesc",      settings: BYBOOK_MAP },
  { id: "crunch",   labelKey: "PresetMaximumCrunch",  descKey: "PresetMaximumCrunchDesc",  settings: CRUNCH_MAP },
];

/** Notable ACTIVE features a preset can switch on, named in the confirm dialog (esp. silent ones). */
// ⏪ 2026-08-29 trim: the ablation row now keys on the merged damageArmorMode; the restrictMove,
// shopping and vehicles rows left with their retired settings (those features are always present now).
const NOTABLE = [
  { id: "rawIp",        key: "ipRawTracking",   on: (v) => v === true,       nameKey: "PresetFeatureRawIp" },
  { id: "maximumMetal", key: "mmEnabled",       on: (v) => v === true,       nameKey: "PresetFeatureMaximumMetal" },
  { id: "limbLoss",     key: "limbLossEnabled", on: (v) => v === true,       nameKey: "PresetFeatureLimbLoss" },
  { id: "ablation",     key: "damageArmorMode", on: (v) => v === "full",     nameKey: "PresetFeatureAblation" },
  { id: "listenUp",     key: "limbModel",       on: (v) => v === "listenup", nameKey: "PresetFeatureListenUp" },
];

/** PURE: the resolved value map for a tier id, or null. */
export function resolvePreset(id) {
  return PRESETS.find((p) => p.id === id)?.settings ?? null;
}

/** Every setting key a preset controls (the snapshot/undo universe). */
export function presetKeys() {
  return Object.keys(MANUAL_MAP);
}

/**
 * PURE: diff a tier against a plain { key: value } map of CURRENT values.
 * @returns {{changed:string[], featuresOn:{id:string,nameKey:string}[]}} keys that change, and the
 *   notable active features going from off→on (for the confirm dialog).
 */
export function presetChanges(id, current = {}) {
  const target = resolvePreset(id);
  if (!target) return { changed: [], featuresOn: [] };
  const changed = Object.keys(target).filter((k) => current[k] !== target[k]);
  const featuresOn = NOTABLE
    .filter((f) => f.on(target[f.key]) && !f.on(current[f.key]))
    .map((f) => ({ id: f.id, nameKey: f.nameKey }));
  return { changed, featuresOn };
}

/** IMPURE: read every preset-controlled setting's current value into a plain map. */
export function currentSettings() {
  const cur = {};
  for (const k of presetKeys()) {
    try { cur[k] = game.settings.get(settingScope(k), k); } catch (e) { cur[k] = undefined; }
  }
  return cur;
}

/**
 * IMPURE: apply a tier. Snapshots EVERY touched key's prior value first (for exact undo), then writes
 * only the ones that differ. Safe-per-key (a failed write is logged, not fatal).
 * @returns {Promise<?{presetId:string, snapshot:Object}>} the snapshot for undoPreset(), or null.
 */
export async function applyPreset(id) {
  const target = resolvePreset(id);
  if (!target) return null;
  const snapshot = {};
  for (const [k, v] of Object.entries(target)) {
    const sc = settingScope(k);
    let cur;
    try { cur = game.settings.get(sc, k); } catch (e) { cur = undefined; }
    snapshot[k] = cur;
    if (cur !== v) {
      try { await game.settings.set(sc, k, v); }
      catch (e) { console.error(`cp2020-augmented | preset "${id}" failed to set ${k}`, e); }
    }
  }
  return { presetId: id, snapshot };
}

/** IMPURE: restore a snapshot taken by applyPreset (one-step undo). */
export async function undoPreset(snapshot) {
  if (!snapshot) return;
  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) continue;
    const sc = settingScope(k);
    let cur;
    try { cur = game.settings.get(sc, k); } catch (e) { cur = undefined; }
    if (cur !== v) {
      try { await game.settings.set(sc, k, v); }
      catch (e) { console.error(`cp2020-augmented | preset undo failed to restore ${k}`, e); }
    }
  }
}
