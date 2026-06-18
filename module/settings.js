/**
 * Settings for Cyberpunk 2020: Augmented Edition.
 *
 * Mirrors the base system's settings shape: a SCOPE const, registration via
 * SETTINGS.* i18n keys (text lives in lang/*.json), and try/catch accessor
 * helpers that return a safe default. Augmented features are opt-in (default off).
 */
const SCOPE = "cp2020-augmented";

export function registerAugmentedSettings() {
  // Master toggle for the Augmented combat-automation layer (damage application,
  // saves, area effects, combat-tracker controls). On by default once the module is
  // enabled; each individual behaviour is further gated by its own setting below.
  game.settings.register(SCOPE, "combatAutomationEnabled", {
    name: "SETTINGS.AugmentedCombatAutomation",
    hint: "SETTINGS.AugmentedCombatAutomationHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true
  });

  // --- automationNoticeHide ---
  game.settings.register(SCOPE, "automationNoticeHide", {
    name: "SETTINGS.AutomationNoticeHide",
    hint: "SETTINGS.AutomationNoticeHideHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  // --- damageArmorMode ---
  game.settings.register(SCOPE, "damageArmorMode", {
    name: "Damage: Armor Mode",
    hint: "How armor SP is applied when calculating damage. Full = SP + ablation per RAW. Simple = SP subtracted, no ablation. None = armor ignored (BTM still applies).",
    scope:   "world",
    config:  true,
    type:    String,
    choices: {
      "full":   "Full (SP + Ablation)",
      "simple": "Simple (SP only)",
      "none":   "None (no armor)",
    },
    default: "full",
  });

  // --- damageAblation ---
  game.settings.register(SCOPE, "damageAblation", {
    name: "Damage: Ablate Armor on Hit",
    hint: "When enabled, armor SP at the hit location is reduced by 1 for each penetrating hit (RAW).",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- damageAutoApply ---
  game.settings.register(SCOPE, "damageAutoApply", {
    name: "Damage: Auto-Apply Without Dialog",
    hint: "When enabled, damage is applied to the target immediately when a targeted weapon fires, without showing the confirmation dialog.",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- headHitDoubling ---
  game.settings.register(SCOPE, "headHitDoubling", {
    name: "Combat: Head Hit Doubles Damage",
    hint: "When enabled, a hit to the Head doubles the FINAL damage — after armor (SP) and BTM are applied. RAW: 'A head hit always doubles damage' (CP2020 p.103, the optional 'He Shrugs Off Head Hits' rule); the book gives no timing, so the wound that actually gets through is what doubles. Disable for groups that skip this rule.",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
  });

  // --- limbLossEnabled ---
  game.settings.register(SCOPE, "limbLossEnabled", {
    name: "Combat: Limb Loss & Head Wound Checks",
    hint: "When enabled, a single hit dealing more than 8 net damage to a limb triggers an immediate Death Save at Mortal 0 (severed/crushed). A head wound of the same severity kills automatically (CP2020 p.103 RAW).",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- suppressiveFireSaves ---
  game.settings.register(SCOPE, "suppressiveFireSaves", {
    name: "Combat: Suppressive Fire Zone & Evasion",
    hint: "When enabled, suppressive fire automatically places a ray template (fire zone) on the canvas and prompts all tokens within it to roll an Evasion check: Athletics + REF + 1d10 vs DC = rounds / zone width (CP2020 p.101 RAW). Failures take 1d6 random hits.",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- autoDeathSavePerTurn ---
  game.settings.register(SCOPE, "autoDeathSavePerTurn", {
    name: "Combat: Death Save Each Turn (Mortal)",
    hint: "When enabled, unstabilized Mortal characters are automatically prompted to make a Death Save at the start of each of their turns in the combat tracker (CP2020 p.105 RAW).",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- autoSaveRePrompt ---
  game.settings.register(SCOPE, "autoSaveRePrompt", {
    name: "Combat: Stun Save Recovery Each Turn",
    hint: "When enabled, unconscious/stunned characters are automatically prompted to roll a Stun Save recovery check at the start of each of their turns in the combat tracker (CP2020 p.104 RAW).",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- activeDodgeParryEnabled ---
  game.settings.register(SCOPE, "activeDodgeParryEnabled", {
    name: "Combat: Active Dodge & Parry Declarations",
    hint: "When enabled, 🛡 Dodge and ⛨ Parry buttons appear in the combat tracker. Dodge (active combatant): −2 to attacker's melee roll this round; clears on next turn. Parry (any combatant, reactive): blocks the next incoming melee attack; consumed on use. (CP2020 p.102 RAW.)",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- aimTrackingEnabled ---
  game.settings.register(SCOPE, "aimTrackingEnabled", {
    name: "Combat: Aim Accumulation Tracking",
    hint: "When enabled, a Take Aim (🎯) button appears in the combat tracker for the active combatant. Each click accumulates +1 aim round (max 3) stored on the actor. The attack modifier dialog is automatically pre-filled with the saved aim count. Aim resets when the actor fires. (CP2020 p.99 RAW: +1 per consecutive aim round, max +3.)",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- waitForTurnEnabled ---
  game.settings.register(SCOPE, "waitForTurnEnabled", {
    name: "Combat: Wait for Turn Button",
    hint: "When enabled, a Wait (⏸) button appears in the combat tracker for the active combatant. Clicking it sets their initiative just below the current minimum and advances to the next combatant, so they act last this round. Since CP2020 re-rolls initiative each round, this is a temporary deferral. (CP2020 p.98 RAW.)",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- specialMeleeEffectsEnabled ---
  game.settings.register(SCOPE, "specialMeleeEffectsEnabled", {
    name: "Combat: Martial Arts Special Hit Effects",
    hint: "When enabled, successful Hold/Grapple attacks set a status flag on the target with turn-start reminders; Choke deals 1d6 HP damage per turn + forces a Stun Save; Throw/Sweep post knockdown announcements; Escape removes all hold/grapple/choke flags. (CP2020 p.100–102 RAW.)",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- gasGrenadeCloudEnabled ---
  game.settings.register(SCOPE, "gasGrenadeCloudEnabled", {
    name: "Combat: Gas Grenade Cloud & Per-Turn Saves",
    hint: "When enabled, weapons loaded with gas ammo (effectTypes: ['Gas'] on ammo item) place a green circle MeasuredTemplate on the canvas. All tokens within the cloud are prompted to make Stun Saves each turn. Cloud persists for dotTurns turns then auto-deletes. (CP2020 p.107 area weapon rules.)",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- gasCloudAutoMove ---
  game.settings.register(SCOPE, "gasCloudAutoMove", {
    name: "Combat: Gas Cloud Auto-Drift (Wind)",
    hint: "When enabled, the gas cloud template drifts 2m in a random direction each turn to simulate wind movement (CP2020 p.107). When disabled, the GM may reposition the template manually.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- taserCumPenaltyEnabled ---
  game.settings.register(SCOPE, "taserCumPenaltyEnabled", {
    name: "Combat: Taser Cumulative Save Penalty",
    hint: "When enabled, each successive taser hit within a 3-turn window reduces the target's Stun Save threshold by the ammo item's stunSaveMod value (default −2 per hit). The penalty accumulates: 2nd hit −2, 3rd hit −4, etc. (CP2020 p.101 RAW.)",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- acidArmorDotEnabled ---
  game.settings.register(SCOPE, "acidArmorDotEnabled", {
    name: "Combat: Acid Weapon Armor Degradation",
    hint: "When enabled, weapons loaded with acid ammo (dotEnabled on ammo item) degrade the target's armor SP at the hit location by the dotDamageFormula roll (default 1d6) per turn for dotTurns turns. SP is reduced from the outermost layer inward. (CP2020 acid weapon rules.)",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- acidDotStackMode ---
  game.settings.register(SCOPE, "acidDotStackMode", {
    name: "Combat: Acid DOT Multiple-Hit Behavior",
    hint: "Controls what happens when a target is hit by acid while an acid effect is already active. Stack: extends the remaining turns at the same location. Reset: overwrites the previous effect (timer restarts). Separate: both effects run concurrently with independent timers.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "stack":    "Stack (extend duration at same location)",
      "reset":    "Reset (overwrite previous effect)",
      "separate": "Separate (concurrent independent timers)",
    },
    default: "stack",
  });

  // --- fireDotEnabled ---
  game.settings.register(SCOPE, "fireDotEnabled", {
    name: "Combat: Incendiary Burn Damage",
    hint: "When enabled, weapons loaded with incendiary/API ammo set the target on fire: the dotDamageFormula roll (default 1d6) is applied as HP damage at the hit location each turn for dotTurns turns, with a Stun Save each turn. Unlike acid, fire burns the target, not their armor.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- fireDotStackMode ---
  game.settings.register(SCOPE, "fireDotStackMode", {
    name: "Combat: Fire DOT Multiple-Hit Behavior",
    hint: "Controls what happens when a target is set on fire while already burning. Stack: extends the remaining turns at the same location. Reset: overwrites the previous fire (timer restarts). Separate: both fires run concurrently with independent timers.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "stack":    "Stack (extend duration at same location)",
      "reset":    "Reset (overwrite previous fire)",
      "separate": "Separate (concurrent independent timers)",
    },
    default: "stack",
  });

  // --- multiActionPenaltyEnabled ---
  game.settings.register(SCOPE, "multiActionPenaltyEnabled", {
    name: "Combat: Multi-Action Penalty",
    hint: "When enabled, each action taken beyond the first in a round applies a cumulative −3 penalty to all rolls that round. A badge in the combat tracker shows the current action count and live penalty. (CP2020 p.105 RAW.)",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  // --- multiActionAutoTrack ---
  game.settings.register(SCOPE, "multiActionAutoTrack", {
    name: "Combat: Multi-Action Auto-Tracking",
    hint: "When enabled, weapon fire and tracker button clicks (Aim, Dodge, Parry) automatically increment the action counter. When disabled, only the manual ➕ button in the tracker changes the count — useful for tables that prefer full manual control.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  // --- restrictMovementOncePerTurn ---
  game.settings.register(SCOPE, "restrictMovementOncePerTurn", {
    name: "SETTINGS.RestrictMovementOncePerTurn",
    hint: "SETTINGS.RestrictMovementOncePerTurnHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  // --- shotgunSpreadEnabled ---
  game.settings.register(SCOPE, "shotgunSpreadEnabled", {
    name: "Combat: Shotgun & Flechette Spread",
    hint: "When enabled, ammo whose Spread Mode is not 'single' (buckshot, flechette) fires a widening pattern (Close 1m/Med 2m/Long 3m by default) with range-banded damage. Everyone in the straight path takes the hit. Only affects ammo explicitly configured for spread, so normal weapons are unchanged. (CP2020 p.108.)",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
  });

  // --- explosivesEnabled ---
  game.settings.register(SCOPE, "explosivesEnabled", {
    name: "Combat: Explosions & Grenades",
    hint: "When enabled, ammo whose Effect Types include 'Explosive' detonates as an area-effect blast: a circular zone of radius blastRadius, with range-banded damage falloff (blastMultipliers) outward from the center. Every token in the blast takes damage through the normal pipeline. Only affects ammo configured as Explosive. (CP2020 p.108.)",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
  });

  // --- areaEffectOcclusion ---
  game.settings.register(SCOPE, "areaEffectOcclusion", {
    name: "Combat: Area-Effect Cover Blocks (walls)",
    hint: "When enabled, a token shielded by a wall between it and the blast center (or the shooter, for spread) is exempt from area-effect damage — intervening cover blocks the pattern/blast (CP2020 p.108). Requires walls placed on the scene; disable if your tables don't map cover with walls.",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
  });

  // --- explosivesDetailed ---
  game.settings.register(SCOPE, "explosivesDetailed", {
    name: "Combat: Detailed Explosives — HEP Concussion (Listen Up)",
    hint: "Optional grittier blast model from Listen Up You Primitive Screwheads (p.105). Explosion concussion is treated as HEP: armor SP does NOT protect (BTM still applies), half the damage that gets through is permanent and half is stun (a Stun Save is always prompted), and soft armor at the hit location loses 2 SP. If the ammo also has blastShrapnel, each target additionally takes a normal-armor 1d10 shrapnel hit. Default OFF (Core blast = damage through normal armor).",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- limbCripplingDetailed ---
  game.settings.register(SCOPE, "limbCripplingDetailed", {
    name: "Combat: Detailed Crippling Injuries (Listen Up)",
    hint: "Optional grittier limb rule from Listen Up You Primitive Screwheads. Limb damage is DOUBLED (post-armor, before BTM); 6–12 net to a limb cripples it (unusable), 13+ destroys it (needs replacement). Replaces the Core flat '>8 = severed' limb branch when on. Requires 'Limb Loss & Head Wound Checks' to be enabled. Default OFF (Core rules).",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });
}

/** Whether the Augmented combat-automation layer is enabled. Off by default (opt-in). */
export function combatAutomationEnabled() {
  try { return game.settings.get(SCOPE, "combatAutomationEnabled") === true; }
  catch { return false; }
}
