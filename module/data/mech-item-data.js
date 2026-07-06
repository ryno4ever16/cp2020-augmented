/**
 * Special-mechanics item fields shared by `misc` gear and `cyberware`
 * (SPECIAL-MECHANICS-PROPOSAL.md — decision D1: extend the registered DataModels, the C4 pattern
 * proven on vehicles, instead of routing through module flags).
 *
 * `mechLight` (pattern P3 — light emitters): an item that can light the bearer's token.
 *   enabled  — this item IS an emitter (catalog data; the sheet shows the profile fields)
 *   on       — the emitter is currently lit (runtime state on the OWNED copy; sheet toggle)
 *   shape    — "cone" (flashlights) | "circle" (glowsticks, lamps)
 *   bright/dim — ranges in scene units (the books print real beam ranges: "3m range", "25m beam")
 *   angle    — cone spread in degrees (ignored for circle; applied as 360)
 *   color    — optional tint ("#66ff66" chem-glow etc.); empty = plain white light
 *
 * ⚠ mechLight is a real nested SchemaField, NOT the schema-helpers bare objectField, deliberately:
 * a bare ObjectField treats a dotted partial update (`{"system.mechLight.on": true}`) as a REPLACE,
 * after which defaults refill the dropped keys — rig-proven on v14.364: toggling `on` silently reset
 * `enabled` to false. A SchemaField merges partial updates per sub-field, which is exactly what the
 * sheet toggle and API callers need. (The same hazard exists on the base system's objectField groups
 * — tracked separately; see the special-mechanics task notes.)
 *
 * Built at INIT via this factory so the models EXTEND the system's own registered `misc`/`cyberware`
 * models (any field or migrateData the base later gains chains via `super`). Additive with defaults →
 * existing items float, no world migration; SchemaField fills missing sub-keys itself.
 */

export const MECH_LIGHT_DEFAULTS = {
  enabled: false, on: false, shape: "cone", bright: 10, dim: 20, angle: 45, color: ""
};

/**
 * `mechVision` (pattern P4 — vision devices): IR/low-light/thermograph/UV optics that change how
 * the wearer's token SEES (where mechLight changes how it is seen). `mode` is a soft enum
 * (VISION_DEVICE_MODES); the Foundry mapping lives in module/mech/vision.js and is deliberately a
 * small upgradeable table — the fidelity question (plain see-in-dark vs live-target detection for
 * thermograph) is an OPEN QUESTION in SPECIAL-MECHANICS-PROPOSAL.md, and the default is the simple
 * darkvision-class approximation. `range` is the device's effective sight range in scene units
 * (the books print absolutes like "see in total darkness", so the default is a playable 20).
 */
export const MECH_VISION_DEFAULTS = { enabled: false, on: false, mode: "lowlight", range: 20 };
export const VISION_DEVICE_MODES = ["lowlight", "infrared", "thermograph", "uv"];

/**
 * `mechProtection` (pattern P6 — protection tags): passive gear the save engines consult.
 * Per hazard: `immune` (sealed breathing mask vs gas; Anti-Dazzle vs flash) or a save `mod`
 * (positive helps). Hazards typed now: gas (LIVE — the gas-cloud per-turn save consults it),
 * flash + sonic (data-ready; their effect engines come later). Fire/corrosion armor stays with
 * the D5 discussion. Percent-effective items ("70% effective" nasal filters) have no honest
 * save-mod mapping — open question Q8 in the proposal; they stay unwired rather than invented.
 */
export const MECH_PROTECTION_HAZARDS = ["gas", "flash", "sonic"];
export const MECH_PROTECTION_DEFAULTS = {
  enabled: false,
  gas:   { immune: false, mod: 0 },
  flash: { immune: false, mod: 0 },
  sonic: { immune: false, mod: 0 }
};

/**
 * `mechRollMods` (pattern P5 — roll-modifier providers): equipped gear that advertises a bonus the
 * player may claim on a roll. The engine (module/mech/roll-mods.js) turns providers into extra
 * pre-suggested checkbox rows in the EXISTING Modifiers dialog; a checked row folds its mod into
 * the roll's `extraMod` term (the system's own always-present catch-all), so the roll math and
 * chat cards are untouched.
 *   attackMod — ± to RANGED weapon-attack rolls (the fire dialog). 0 = no attack row.
 *   skillName/skillMod — ± to rolls of the named skill (the skill-roll dialog; canonical English
 *     skill name, same convention as CyberWorkType.Skill name keys). Empty name or 0 = no row.
 *   auto — render the suggestion PRE-TICKED. Wiring sets false for narrow-condition gear (a
 *     vocalock decryptor helps only against vocalocks) so Enter-through never claims a bonus the
 *     situation doesn't earn.
 * One slot of each kind per item: every book item wired so far provides a single bonus; widen to a
 * list only when a real item demands it. Items whose printed bonus targets a roll that has no
 * modifiers dialog (Facedown, bare stat checks) stay unwired — see the proposal doc §3b.
 */
export const MECH_ROLL_MODS_DEFAULTS = {
  enabled: false, attackMod: 0, skillName: "", skillMod: 0, auto: true
};

/**
 * `mechConsumable` (pattern P7 — timed consumables): dose-tracked items whose effect runs out.
 *   doses         — uses remaining. The Use action (misc) or an Activatable cyberware's
 *                   activation consumes one; at 0 the action warns / the activation is blocked.
 *                   Refills are the GM's call (e.g. the Adrenal Booster's "3x per day" — day
 *                   tracking is theirs, the counter is ours).
 *   durationTurns — "" = instant/untimed. Otherwise a number or roll formula ("1d6+2"), rolled at
 *                   use time; the module/mech/consumable.js round tick (DOT-pattern: the current
 *                   combatant's timers tick when their turn comes up) counts it down and posts a
 *                   wear-off card. For Activatable cyberware, expiry also flips EffectActive off,
 *                   so a payload the BASE engine gates on activation (the Booster's Stat +1 REF)
 *                   starts and stops with the timer — P7 owns time + uses, never the effect math.
 *   note          — short effect label for the chat cards ("+1 REF"); item DATA, stays English.
 * Effects whose numbers the books don't print stay unwired (the supplement drug texts were never
 * captured — proposal §3b); this block only ever carries printed values.
 */
export const MECH_CONSUMABLE_DEFAULTS = {
  enabled: false, doses: 1, durationTurns: "", note: ""
};

function mechLightField() {
  const f = foundry.data.fields;
  return new f.SchemaField({
    enabled: new f.BooleanField({ initial: MECH_LIGHT_DEFAULTS.enabled }),
    on:      new f.BooleanField({ initial: MECH_LIGHT_DEFAULTS.on }),
    shape:   new f.StringField({ initial: MECH_LIGHT_DEFAULTS.shape }),
    bright:  new f.NumberField({ initial: MECH_LIGHT_DEFAULTS.bright }),
    dim:     new f.NumberField({ initial: MECH_LIGHT_DEFAULTS.dim }),
    angle:   new f.NumberField({ initial: MECH_LIGHT_DEFAULTS.angle }),
    color:   new f.StringField({ initial: MECH_LIGHT_DEFAULTS.color })
  });
}

function mechVisionField() {
  const f = foundry.data.fields;
  return new f.SchemaField({
    enabled: new f.BooleanField({ initial: MECH_VISION_DEFAULTS.enabled }),
    on:      new f.BooleanField({ initial: MECH_VISION_DEFAULTS.on }),
    mode:    new f.StringField({ initial: MECH_VISION_DEFAULTS.mode }),
    range:   new f.NumberField({ initial: MECH_VISION_DEFAULTS.range })
  });
}

function mechProtectionField() {
  const f = foundry.data.fields;
  const hazard = () => new f.SchemaField({
    immune: new f.BooleanField({ initial: false }),
    mod:    new f.NumberField({ initial: 0 })
  });
  return new f.SchemaField({
    enabled: new f.BooleanField({ initial: false }),
    gas: hazard(), flash: hazard(), sonic: hazard()
  });
}

function mechRollModsField() {
  const f = foundry.data.fields;
  return new f.SchemaField({
    enabled:   new f.BooleanField({ initial: MECH_ROLL_MODS_DEFAULTS.enabled }),
    attackMod: new f.NumberField({ initial: MECH_ROLL_MODS_DEFAULTS.attackMod }),
    skillName: new f.StringField({ initial: MECH_ROLL_MODS_DEFAULTS.skillName }),
    skillMod:  new f.NumberField({ initial: MECH_ROLL_MODS_DEFAULTS.skillMod }),
    auto:      new f.BooleanField({ initial: MECH_ROLL_MODS_DEFAULTS.auto })
  });
}

function mechConsumableField() {
  const f = foundry.data.fields;
  return new f.SchemaField({
    enabled:       new f.BooleanField({ initial: MECH_CONSUMABLE_DEFAULTS.enabled }),
    doses:         new f.NumberField({ initial: MECH_CONSUMABLE_DEFAULTS.doses }),
    durationTurns: new f.StringField({ initial: MECH_CONSUMABLE_DEFAULTS.durationTurns }),
    note:          new f.StringField({ initial: MECH_CONSUMABLE_DEFAULTS.note })
  });
}

/**
 * @param {typeof foundry.abstract.TypeDataModel} SystemModel  the system's registered model to extend
 * @returns {typeof foundry.abstract.TypeDataModel}
 */
export function makeMechAugmentedData(SystemModel) {
  return class CyberpunkMechAugmentedData extends SystemModel {
    static defineSchema() {
      return {
        ...super.defineSchema(),
        mechLight: mechLightField(),
        mechVision: mechVisionField(),
        mechProtection: mechProtectionField(),
        mechRollMods: mechRollModsField(),
        mechConsumable: mechConsumableField()
      };
    }
  };
}
