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
export const MECH_VISION_DEFAULTS = { enabled: false, on: false, mode: "lowlight", range: 20, requiresItem: "" };
export const VISION_DEVICE_MODES = ["lowlight", "infrared", "thermograph", "uv"];

/**
 * `mechProtection` (pattern P6 — protection tags): passive gear the save engines consult.
 * Per hazard:
 *   immune     — sealed protection (breathing mask vs gas; Anti-Dazzle vs flash): no save at all.
 *   mod        — save-mod offset (positive helps; the engine never flips a penalty into a bonus).
 *   percent    — Q8 percent-effective gear ("70% effective" nasal filters), keeping the book's own
 *                number: per exposure the engine rolls a d10 — roll ≤ percent/10 → protected this
 *                exposure (the card shows the roll). 0 = not percent-gated.
 *   damageMult — Q8 damage-multiplier convention ("−25% from SW" → 0.75): applied by the hazard's
 *                damage path when one exists (sonic has none yet — data-ready). 0 = none.
 * Hazards typed now: gas (LIVE — the gas-cloud per-turn save consults immune/mod/percent),
 * flash + sonic (data-ready). Fire/corrosion armor stays with the D5 discussion.
 */
export const MECH_PROTECTION_HAZARDS = ["gas", "flash", "sonic"];
export const MECH_PROTECTION_DEFAULTS = {
  enabled: false,
  gas:   { immune: false, mod: 0, percent: 0, damageMult: 0 },
  flash: { immune: false, mod: 0, percent: 0, damageMult: 0 },
  sonic: { immune: false, mod: 0, percent: 0, damageMult: 0 }
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
  enabled: false, attackMod: 0, skillName: "", skillMod: 0, auto: true,
  // Q9 extensions:
  //   statName/statMod — a bonus to a bare STAT roll (Photo Memory "INT roll +2"); the stat-roll
  //     handler opens the Modifiers dialog when a provider matches the stat.
  //   facedownMod — an unconditional bonus to the Facedown roll (Facedown Chip +1); no dialog —
  //     rollFacedown sums active providers and adds a card line.
  //   dualWieldOnly — the attackMod row appears in the fire dialog ONLY while Dual Wield is checked
  //     (Ambidexterity's +3, which cancels the dialog's own −3 dual-wield penalty).
  statName: "", statMod: 0, facedownMod: 0, dualWieldOnly: false
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

/**
 * `mechContainer` (pattern Q6 — containers, option 1): diegetic nesting for MISC gear, unifying
 * with the base system's own cyberware-into-cyberware system (which the module already surfaces:
 * `Module.ParentId` child link + `CyberWorkType.OptionsAvailable` capacity + `Module.SlotsTaken`).
 * Cyberware keeps using those base fields; MISC (which has no base container fields) uses these:
 *   installedIn — the parent item's id (empty = loose in inventory). A cybereye option, a hold-out
 *                 pistol in a cyberarm compartment, an item in a skin pouch — all point at their
 *                 container item (which may be cyberware OR another misc container).
 *   capacity    — child slots this item provides AS a container (a limb compartment / skin pouch).
 *   slotsTaken  — slots this item occupies in its parent (default 1).
 * The engine (module/mech/container.js) reads base fields for cyberware and these for misc through
 * one set of accessors, so the telescoping display + capacity + uninstall-cascade are one code path.
 */
export const MECH_CONTAINER_DEFAULTS = { installedIn: "", capacity: 0, slotsTaken: 1 };

/**
 * `mechStatMods` (pattern Q7 — personality moddies): stat modifiers with printed CAPS and
 * combat/non-combat CONTEXT that exceed the base Characteristic-Stat engine (which is a plain add).
 * A chip carries a list of entries, each a mod (or absolute set) to one stat with an optional cap
 * (max resulting value), floor (min resulting value), and context:
 *   any        — always applies (`mod`).
 *   combat     — applies only while the actor is in the active combat (`mod`).
 *   noncombat  — applies only while NOT in combat (`mod`).
 *   split      — `mod` out of combat, `combatMod` in combat (Perfect Soldier's INT −2/+2).
 * `isSet` sets the stat to `set` absolutely (Xarghis Khan's EMP 1 / COOL 10). Applied in a
 * prepareDerivedData wrapper (module/mech/stat-mods.js) AFTER the base's stat totals so cap/floor
 * clamp the FINAL value (the RAW reading of "COOL +2 (max 11)"); movement/body derived values are
 * re-derived if a mod touches MA/BT. Personality overlays do NOT alter the humanity pool (a
 * deliberate, documented choice — humanity is permanent essence, the chip is transient).
 */
export const MECH_STAT_MOD_ENTRY_DEFAULTS = {
  stat: "cool", mod: 0, combatMod: 0, context: "any", cap: 0, floor: 0, isSet: false, set: 0
};

/**
 * `mechDrug` (D4 combat-drug engine — SPECIAL-MECHANICS-D4-PROPOSAL.md §T2a): a dose-taken item
 * (misc gear or an implanted dispenser) whose effect runs for a while, then wears off with a save.
 * Composes the P7 timer lifecycle (its own `drugState` per-actor marker + round tick, mirroring
 * mech/consumable.js) with the Q7 stat overlay and one new gate — the wear-off save + addiction
 * counter. Numbers only ever come from printed prose (the D4 capture); nothing is invented.
 *   statBoosts  — stat modifiers applied WHILE the drug is active (Char's COOL +3 / EMP −3). Applied
 *                 in a prepareData wrapper reading the drugState marker (the Q7 precedent — WRAP
 *                 prepareData, not prepareDerivedData). Each: { stat (int/ref/cool/…), mod }.
 *   rollBoosts  — skill/save bonuses the book grants that have no live modifiers dialog to fold into
 *                 (Prime's Awareness +3 / Stun Saves +2). MVP surfaces these on the "took" card and
 *                 the status strip for the GM to apply; graduate to real dialog rows later (D-drug-1).
 *                 Each: { label (display, English), mod }.
 *   duration    — the book's printed duration, verbatim, as a display string ("1d6+1 hours"): shown
 *                 on the card. Preserves the source number without a fragile hours→turns conversion.
 *   durationTurns — OPTIONAL combat-round auto-expiry ("" | n | "1d6+2"). Empty for the printed drugs
 *                 (their durations exceed a fight) → they last until worn off manually; the round tick
 *                 only counts down a drug that sets this (future short drugs + the rig keeper).
 *   expireSave  — the wear-off gate: { stat (save characteristic, blank if none), difficulty (CP2020
 *                 ladder number: Easy 10 / Average 15 / Difficult 20 / Very Diff 25; 0 = no numeric TN),
 *                 penalty (the printed failure consequence, verbatim) }. Surfaced as the module's
 *                 standard save-prompt notice on wear-off (the gas/toxin save UX); GM adjudicates the
 *                 roll + penalty (D-drug-2 MVP).
 *   addictionDifficulty — the drug's addiction TN (0 = non-addictive). Each dose bumps the per-actor
 *                 addiction counter shown in the status strip (user ask, D-drug-3); withdrawal effects
 *                 stay GM-adjudicated.
 *   psychosis   — a display-only condition note for psychosis-only drugs (Paranoia, Cyberpsychosis)
 *                 that carry no numeric payload (D-drug-4).
 *   note        — short effect label for the cards; item DATA, stays English.
 */
export const MECH_DRUG_DEFAULTS = {
  enabled: false, duration: "", durationTurns: "", addictionDifficulty: 0, psychosis: "", note: ""
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
    range:   new f.NumberField({ initial: MECH_VISION_DEFAULTS.range }),
    // Illuminator dependency (the UV-optic class: "see in darkness; using UV flash"): the device
    // only counts as active while the actor carries one of these items, equipped and lit —
    // pipe-separated exact item names, matched case-insensitively (the engine's own name-key
    // convention, same as CyberWorkType.Skill / ChipSkills name keys). Empty = self-sufficient.
    requiresItem: new f.StringField({ initial: MECH_VISION_DEFAULTS.requiresItem })
  });
}

function mechProtectionField() {
  const f = foundry.data.fields;
  const hazard = () => new f.SchemaField({
    immune:     new f.BooleanField({ initial: false }),
    mod:        new f.NumberField({ initial: 0 }),
    percent:    new f.NumberField({ initial: 0 }),
    damageMult: new f.NumberField({ initial: 0 })
  });
  return new f.SchemaField({
    enabled: new f.BooleanField({ initial: false }),
    gas: hazard(), flash: hazard(), sonic: hazard()
  });
}

function mechRollModsField() {
  const f = foundry.data.fields;
  const d = MECH_ROLL_MODS_DEFAULTS;
  return new f.SchemaField({
    enabled:   new f.BooleanField({ initial: d.enabled }),
    attackMod: new f.NumberField({ initial: d.attackMod }),
    skillName: new f.StringField({ initial: d.skillName }),
    skillMod:  new f.NumberField({ initial: d.skillMod }),
    auto:      new f.BooleanField({ initial: d.auto }),
    // Multi-skill providers (the widening the one-slot comment reserved, now demanded by two
    // printed payloads: ParaDactyl's +2 to two skills, Micromanipulator's +1 across four): one
    // dialog row per entry, all sharing the item's `auto`. Additive beside the one-slot pair —
    // existing data and the sheet fields keep working; an ArrayField replaces wholesale on
    // update, so the partial-merge hazard doesn't apply.
    skillMods: new f.ArrayField(new f.SchemaField({
      skillName: new f.StringField({ initial: "" }),
      mod:       new f.NumberField({ initial: 0 })
    })),
    statName:  new f.StringField({ initial: d.statName }),
    statMod:   new f.NumberField({ initial: d.statMod }),
    facedownMod: new f.NumberField({ initial: d.facedownMod }),
    dualWieldOnly: new f.BooleanField({ initial: d.dualWieldOnly })
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

function mechContainerField() {
  const f = foundry.data.fields;
  return new f.SchemaField({
    installedIn: new f.StringField({ initial: MECH_CONTAINER_DEFAULTS.installedIn }),
    capacity:    new f.NumberField({ initial: MECH_CONTAINER_DEFAULTS.capacity }),
    slotsTaken:  new f.NumberField({ initial: MECH_CONTAINER_DEFAULTS.slotsTaken })
  });
}

function mechStatModsField() {
  const f = foundry.data.fields;
  const d = MECH_STAT_MOD_ENTRY_DEFAULTS;
  return new f.SchemaField({
    enabled: new f.BooleanField({ initial: false }),
    mods: new f.ArrayField(new f.SchemaField({
      stat:      new f.StringField({ initial: d.stat }),
      mod:       new f.NumberField({ initial: d.mod }),
      combatMod: new f.NumberField({ initial: d.combatMod }),
      context:   new f.StringField({ initial: d.context }),
      cap:       new f.NumberField({ initial: d.cap }),
      floor:     new f.NumberField({ initial: d.floor }),
      isSet:     new f.BooleanField({ initial: d.isSet }),
      set:       new f.NumberField({ initial: d.set })
    }))
  });
}

function mechDrugField() {
  const f = foundry.data.fields;
  const d = MECH_DRUG_DEFAULTS;
  return new f.SchemaField({
    enabled: new f.BooleanField({ initial: d.enabled }),
    // Stat overlay while active (Q7-style): applied in the prepareData wrapper from the drugState marker.
    statBoosts: new f.ArrayField(new f.SchemaField({
      stat: new f.StringField({ initial: "cool" }),
      mod:  new f.NumberField({ initial: 0 })
    })),
    // Skill/save bonuses with no live dialog to fold into — surfaced for the GM (D-drug-1 MVP).
    rollBoosts: new f.ArrayField(new f.SchemaField({
      label: new f.StringField({ initial: "" }),
      mod:   new f.NumberField({ initial: 0 })
    })),
    duration:      new f.StringField({ initial: d.duration }),
    durationTurns: new f.StringField({ initial: d.durationTurns }),
    expireSave: new f.SchemaField({
      // A CP2020 stat check on wear-off: 1d10 + `stat` vs `difficulty` (meet-or-beat = resisted).
      // Blank stat / 0 difficulty = no rollable save (the card states the printed consequence only).
      stat:       new f.StringField({ initial: "" }),
      difficulty: new f.NumberField({ initial: 0 }),
      // On a FAILED save the stat portion of the penalty auto-applies as a timed "crash" overlay
      // (same overlay as the boost, negative); `penalty` text carries the parts the overlay can't
      // model (skill penalties, conditions) for the GM. penaltyTurns: "" = until cleared manually.
      penaltyBoosts: new f.ArrayField(new f.SchemaField({
        stat: new f.StringField({ initial: "cool" }),
        mod:  new f.NumberField({ initial: 0 })
      })),
      penaltyTurns: new f.StringField({ initial: "" }),
      penalty:      new f.StringField({ initial: "" })
    }),
    addictionDifficulty: new f.NumberField({ initial: d.addictionDifficulty }),
    psychosis:           new f.StringField({ initial: d.psychosis }),
    note:                new f.StringField({ initial: d.note })
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
        mechConsumable: mechConsumableField(),
        mechContainer: mechContainerField(),
        mechStatMods: mechStatModsField(),
        mechDrug: mechDrugField()
      };
    }
  };
}
