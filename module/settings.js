/**
 * Settings for Cyberpunk 2020: Augmented Edition.
 *
 * Mirrors the base system's settings shape: a SCOPE const, registration via
 * SETTINGS.* i18n keys (text lives in lang/*.json), and try/catch accessor
 * helpers that return a safe default. Augmented features are opt-in (default off).
 */
const SCOPE = "cp2020-augmented";

/**
 * Apply (or clear) the `cp-carolingian` <body> class that gates the optional Carolingian /
 * Restyler terminal sheet skin in css/cp2020-augmented.css, per the per-user `carolingianSkin`
 * setting (default on). Called once on `ready` and again whenever the setting is toggled.
 */
export function applyCarolingianSkinClass() {
  try {
    const on = game.settings.get(SCOPE, "carolingianSkin") !== false;
    document.body?.classList.toggle("cp-carolingian", on);
  } catch (e) { /* settings or DOM not ready yet */ }
}

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

  // --- Vehicles (Core CP2020 "Vehicles in FNFF", p.112) — available WITHOUT Maximum Metal ---
  // These two are core vehicle automation; they default ON and work under the Core ruleset on their
  // own. They live above the Maximum Metal header so they stay configurable when MM is off.
  game.settings.register(SCOPE, "vehicleControlEnabled", {
    name: "Vehicles: Movement & Control Rolls",
    hint: "When enabled, vehicles get a 🎲 Control Roll button (sheet header) and the game.cpAugmented.vehicles.controlRoll API. It opens a dialog to roll REF + Driving/Pilot + 1d10 vs a Difficulty Value (Simple 15 / Difficult 20 / Very Difficult 25), and on failure rolls the Control Loss (Core p.112) or Failure (Maximum Metal p.10) table — whichever the active ruleset selects. Works in Core mode without Maximum Metal. Default ON.",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
  });

  game.settings.register(SCOPE, "vehicleDamageEnabled", {
    name: "Vehicles: Damage Resolver",
    hint: "When enabled, vehicles get a 💥 Damage button (sheet header) and the game.cpAugmented.vehicles.applyDamage API. Core (p.112) subtracts SP and reduces SDP; Maximum Metal (p.4-6) compares Penetration to Armor Value, rolls the Surface/Minor/Major/Catastrophic damage table, then a hit location with fuel-fire / ammo-cookoff / crew-damage effects (and honors a Damage Control system). The active branch follows the ruleset (Core when Maximum Metal is off). Default ON.",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
  });

  // ===================== MAXIMUM METAL (master + overlay) =====================
  // Master switch. Everything registered from here down belongs to the Maximum Metal layer; the
  // renderSettingsConfig hook (below) groups them under a "Maximum Metal" header.
  game.settings.register(SCOPE, "mmEnabled", {
    name: "Maximum Metal: Enable Maximum Metal",
    hint: "Master switch for the Maximum Metal military-hardware layer. When OFF (default), vehicles use only the Core 'Vehicles in FNFF' rules (CP2020 p.112) and every MM-only feature is disabled: the Penetration/Armor-Value resolver, composite armor, personnel-vs-anti-vehicle (p.8), area weapons, missiles, the 5-facing vehicle sheet, and the Maximum Metal weapon compendium seeding. Turn ON for the detailed military system. The settings below belong to Maximum Metal.",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
    onChange: () => {
      // Live-apply the MM hide/show: refresh the compendium sidebar + any open vehicle sheets.
      try { ui.compendium?.render(); } catch (e) { /* sidebar not ready */ }
      try { for (const a of game.actors) if (a.type === "cp2020-augmented.vehicle" && a.sheet?.rendered) a.sheet.render(false); } catch (e) { /* no actors */ }
    },
  });

  // --- Vehicles: which ruleset the vehicle resolver uses ---
  game.settings.register(SCOPE, "vehicleRuleSystem", {
    name: "Vehicles: Rule System",
    hint: "Core = the simple Vehicles-in-FNFF rules (Control Roll vs DV 15/20/25, SP−SDP damage, crash = speed/20 × weight). Maximum Metal = the detailed military system (Penetration vs Armor Value, Surface/Minor/Major/Catastrophic damage, hit-location & crit tables, ACPA). The vehicle sheet shows a single SP in Core mode and all five facings under Maximum Metal.",
    scope:   "world",
    config:  true,
    type:    String,
    choices: {
      "Core":         "Core (simple — Vehicles in FNFF, p.112)",
      "MaximumMetal": "Maximum Metal (detailed — Penetration/Armor Value)",
    },
    default: "Core",
  });

  // --- Maximum Metal optional rule: Armor Damage via Penetration (errata p.107) ---
  game.settings.register(SCOPE, "vehicleArmorDamageEnabled", {
    name: "Maximum Metal: Armor Damage via Penetration (errata)",
    hint: "Optional errata rule (Maximum Metal p.107). A heavy round (>20mm) erodes the struck facing's SP whether or not it penetrates: SP removed = factor × Penetration (HE ×½, AP/DPU ×0.6, HEAT ×¾, HESH ×1.0). Because Armor Value is derived from SP (SP÷20), sustained fire grinds armor down over time — addressing 'hard to knock down' heavy armor. Applies only under the Maximum Metal resolver. Default OFF; intended for >20mm vehicle weapons (the GM enables it deliberately).",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- Maximum Metal optional rule: Crew Morale (MM optional) ---
  game.settings.register(SCOPE, "vehicleMoraleEnabled", {
    name: "Maximum Metal: Crew Morale",
    hint: "Optional rule. After a vehicle takes a Minor-or-worse penetrating hit, its crew must pass a morale check — Leadership + 1d10 vs 15 — or bail out / disengage. The damage card shows the 1d10 result and the Leadership needed to hold; the GM adjudicates the consequence. Applies only under the Maximum Metal resolver. Default OFF.",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- Vehicles: Weapon mount arc enforcement (Phase 5) ---
  game.settings.register(SCOPE, "vehicleArcEnforcement", {
    name: "Vehicles: Weapon Mount Arc Enforcement",
    hint: "How a weapon mount's firing arc (turret 360° / front / side / rear) is enforced when the target lies outside it. Token facing defines 'front' — rotate a vehicle with Ctrl+scroll (Foundry's 0° points north). Free (default): the Fire dialog only WARNS that the target is outside the mount's arc; you can still fire (GM discretion). Strict: an out-of-arc shot is blocked until the mount can bear — rotate the firing vehicle to face the target, or use a turret. Applies to all vehicle/ACPA weapon mounts, missiles included.",
    scope:   "world",
    config:  true,
    type:    String,
    choices: {
      "free":   "Free (warn only — discretionary override, default)",
      "strict": "Strict (block out-of-arc shots — keep mounts within bounds)",
    },
    default: "free",
  });

  // --- Martial arts: FNFF2 ruleset toggle ---
  // FNFF2 (Friday Night Fistfight 2) expands the martial-art styles + per-action bonuses used by
  // the Augmented martial panel. On the fork the SYSTEM owns this setting, so isFnff2Enabled()
  // (lookups.js) reads the system's value and we hide this duplicate. On vanilla the system key is
  // absent, so the module owns the toggle here. registerAugmentedSettings runs in `init` AFTER the
  // system's init, so this membership test is reliable.
  const systemOwnsFnff2 = (() => {
    try { return game.settings.settings.has("cyberpunk2020.fnff2Enabled"); } catch { return false; }
  })();
  game.settings.register(SCOPE, "fnff2Enabled", {
    name: "SETTINGS.FNFF2Enabled",
    hint: "SETTINGS.FNFF2EnabledHint",
    scope: "world",
    config: !systemOwnsFnff2,
    type: Boolean,
    default: false,
  });

  // --- Martial arts: special hit-effects toggle ---
  // Hold/Grapple set a status flag on the target; Choke sets a 1d6/turn flag; Throw/Sweep post a
  // knockdown reminder; Escape clears them. Same system-owns-it-on-the-fork pattern as fnff2Enabled,
  // but defaults ON (the effects are core CP2020 p.100–102). See applyMartialHitEffects (martial.js).
  const systemOwnsSpecialMelee = (() => {
    try { return game.settings.settings.has("cyberpunk2020.specialMeleeEffectsEnabled"); } catch { return false; }
  })();
  game.settings.register(SCOPE, "specialMeleeEffectsEnabled", {
    name: "SETTINGS.SpecialMeleeEffects",
    hint: "SETTINGS.SpecialMeleeEffectsHint",
    scope: "world",
    config: !systemOwnsSpecialMelee,
    type: Boolean,
    default: true,
  });

  // --- IP (Improvement Points) tracker ([[ip-tracker-design]]) ---
  game.settings.register(SCOPE, "ipSystem", {
    name: "SETTINGS.IpSystem",
    hint: "SETTINGS.IpSystemHint",
    scope: "world",
    config: true,
    type: String,
    choices: { disabled: "SETTINGS.IpSystemDisabled", simple: "SETTINGS.IpSystemSimple", raw: "SETTINGS.IpSystemRaw" },
    default: "disabled"
  });
  game.settings.register(SCOPE, "ipAwardModel", {
    name: "SETTINGS.IpAwardModel",
    hint: "SETTINGS.IpAwardModelHint",
    scope: "world",
    config: true,
    type: String,
    choices: { manual: "SETTINGS.IpAwardManual", autoBaseline: "SETTINGS.IpAwardAuto" },
    default: "manual"
  });
  game.settings.register(SCOPE, "ipAutoBaselineAmount", {
    name: "SETTINGS.IpAutoBaselineAmount",
    hint: "SETTINGS.IpAutoBaselineAmountHint",
    scope: "world",
    config: true,
    type: Number,
    default: 1
  });
  game.settings.register(SCOPE, "ipThrottle", {
    name: "SETTINGS.IpThrottle",
    hint: "SETTINGS.IpThrottleHint",
    scope: "world",
    config: true,
    type: String,
    choices: { off: "SETTINGS.IpThrottleOff", hardcap: "SETTINGS.IpThrottleHardcap", diminishing: "SETTINGS.IpThrottleDiminishing" },
    default: "off"
  });
  game.settings.register(SCOPE, "ipSkillLockMode", {
    name: "SETTINGS.IpSkillLockMode",
    hint: "SETTINGS.IpSkillLockModeHint",
    scope: "world",
    config: true,
    type: String,
    choices: { owner: "SETTINGS.IpSkillLockOwner", gm: "SETTINGS.IpSkillLockGm", mutual: "SETTINGS.IpSkillLockMutual" },
    default: "owner"
  });
  game.settings.register(SCOPE, "ipShowPending", {
    name: "SETTINGS.IpShowPending",
    hint: "SETTINGS.IpShowPendingHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
  // IP auto-queue of skill rolls awaiting a GM IP decision (GM working list). Not shown in the menu.
  game.settings.register(SCOPE, "ipQueue", { scope: "world", config: false, type: Array, default: [] });
  // Per-skill IP awards within the current Apply cycle, for the throttle. Not shown in the menu.
  game.settings.register(SCOPE, "ipThrottleCounts", { scope: "world", config: false, type: Object, default: {} });

  // --- Shopping / economy ([[shopping-design]]) ---
  // Master gate for the Augmented shop (the sidebar cart, the catalog window, custom shops). On by
  // default once the module is enabled; the system stands down its own shop when this module is active.
  game.settings.register(SCOPE, "shoppingEnabled", {
    name: "SETTINGS.ShoppingEnabled",
    hint: "SETTINGS.ShoppingEnabledHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(SCOPE, "playersCanShop", {
    name: "SETTINGS.PlayersCanShop",
    hint: "SETTINGS.PlayersCanShopHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Master gate for homebrew (non-canon/community) content. The deliberate System-Settings step:
  // homebrew is absent from the shop entirely until this is on (then curated per-source in the shop).
  game.settings.register(SCOPE, "shopAllowHomebrew", {
    name: "SETTINGS.ShopAllowHomebrew",
    hint: "SETTINGS.ShopAllowHomebrewHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // Per-source enable map { supplementName: true } for PLAYERS. GM-curated via in-shop controls.
  game.settings.register(SCOPE, "shopEnabledSources", { scope: "world", config: false, type: Object, default: {} });

  // Per-user: show the item source/supplement badge in the shop (default on; each player can hide).
  game.settings.register(SCOPE, "shopShowSource", {
    name: "SETTINGS.ShopShowSource",
    hint: "SETTINGS.ShopShowSourceHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  // GM custom shops as world DATA (shops are not Actors). Map { [id]: ShopDef }; GM-written, all clients
  // read it. See module/shop/shops.js for the ShopDef shape + CRUD.
  game.settings.register(SCOPE, "shops", { scope: "world", config: false, type: Object, default: {} });

  // Ammunition purchasing access (used by the catalog's generated ammo rows).
  game.settings.register(SCOPE, "playersCanBuyAmmo", {
    name: "SETTINGS.PlayersCanBuyAmmo",
    hint: "SETTINGS.PlayersCanBuyAmmoHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // --- Carolingian / Restyler terminal sheet skin (per-user UI) ---
  // Toggles the `cp-carolingian` <body> class that gates the optional terminal skin in
  // css/cp2020-augmented.css (an adaptation of DARKNEET's Cyberpunk Restyler + the Carolingian
  // UI palette, both MIT — see README). Client-scoped, on by default; applyCarolingianSkinClass()
  // re-applies on ready and on every toggle.
  game.settings.register(SCOPE, "carolingianSkin", {
    name: "SETTINGS.CarolingianSkin",
    hint: "SETTINGS.CarolingianSkinHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => applyCarolingianSkinClass()
  });

  // --- Maximum Metal: in-list section header + master gating of the MM sub-settings ---
  Hooks.on("renderSettingsConfig", (app, html) => {
    const root = html instanceof jQuery ? html[0] : (Array.isArray(html) ? html[0] : html);
    if (!root?.querySelector) return;
    const MM_KEYS = ["mmEnabled", "vehicleRuleSystem", "vehicleArmorDamageEnabled", "vehicleMoraleEnabled", "vehicleArcEnforcement"];
    const groupOf = (k) => {
      const el = root.querySelector(`[name="${SCOPE}.${k}"], [data-setting-id="${SCOPE}.${k}"]`);
      return el?.closest(".form-group") ?? el?.closest(".setting") ?? null;
    };
    const groups = MM_KEYS.map(groupOf).filter(Boolean);
    if (!groups.length) return;
    const first = groups[0];
    if (!first.previousElementSibling?.classList?.contains("cp-mm-header")) {
      const header = document.createElement("h3");
      header.className = "cp-mm-header";
      header.textContent = localize("Vehicle.SystemMM");
      first.parentNode.insertBefore(header, first);
    }
    // Keep the MM groups consecutive under the header.
    let anchor = first;
    for (const g of groups.slice(1)) { if (anchor.nextElementSibling !== g) anchor.parentNode.insertBefore(g, anchor.nextElementSibling); anchor = g; }
    // Grey out / disable the MM sub-settings when the master is off; live-update when it's toggled.
    const subGroups = groups.slice(1);
    const setEnabled = (on) => { for (const g of subGroups) { g.classList.toggle("cp-mm-disabled", !on); g.querySelectorAll("input,select,button,textarea").forEach(el => { el.disabled = !on; }); } };
    setEnabled(mmEnabled());
    const masterInput = first.querySelector(`[name="${SCOPE}.mmEnabled"]`);
    masterInput?.addEventListener("change", () => setEnabled(!!masterInput.checked));
  });

  // --- Maximum Metal: hide the MM weapon compendium from the sidebar when MM is off ---
  Hooks.on("renderCompendiumDirectory", (app, html) => {
    const root = html instanceof jQuery ? html[0] : (Array.isArray(html) ? html[0] : html);
    if (!root?.querySelector || mmEnabled()) return;          // MM on → show it normally
    const li = root.querySelector(`[data-pack="${SCOPE}.vehicle-weapons"]`);
    if (li) li.classList.add("cp-hidden");
  });
}

/** Whether the Augmented combat-automation layer is enabled. Off by default (opt-in). */
export function combatAutomationEnabled() {
  try { return game.settings.get(SCOPE, "combatAutomationEnabled") === true; }
  catch { return false; }
}

/** Martial-arts special hit-effects. System setting on the fork, module-owned on vanilla; default ON. */
export function specialMeleeEffectsEnabled() {
  try { return game.settings.get("cyberpunk2020", "specialMeleeEffectsEnabled") === true; } catch { /* not the fork */ }
  try { return game.settings.get(SCOPE, "specialMeleeEffectsEnabled") === true; } catch { /* not registered */ }
  return true;
}

/** Master Maximum Metal toggle. When OFF (default), every MM-overlay feature falls back to Core CP2020. */
export function mmEnabled() {
  try { return !!game.settings.get(SCOPE, "mmEnabled"); } catch { return false; }
}

/** The active vehicle ruleset, gated by the master MM toggle: forces "Core" whenever MM is off. */
export function effectiveVehicleRuleSystem() {
  try { return mmEnabled() ? (game.settings.get(SCOPE, "vehicleRuleSystem") || "Core") : "Core"; }
  catch { return "Core"; }
}

/** Mount-arc enforcement: "free" (warn-but-allow, default) or "strict" (block out-of-arc shots). */
export function vehicleArcEnforcement() {
  try { return game.settings.get(SCOPE, "vehicleArcEnforcement") || "free"; } catch { return "free"; }
}

// --- IP (Improvement Points) accessors ([[ip-tracker-design]]) ---
/** IP system mode: "disabled" (default) / "simple" (single pool) / "raw" (per-skill tracker). */
export function ipSystem() {
  try { return game.settings.get(SCOPE, "ipSystem") || "disabled"; } catch { return "disabled"; }
}
/** Whether the IP system is active at all. */
export function ipEnabled() { return ipSystem() !== "disabled"; }
/** IP award model: "manual" (RAW GM-per-use, default) / "autoBaseline" (GM-marked success → +N). */
export function ipAwardModel() {
  try { return game.settings.get(SCOPE, "ipAwardModel") || "manual"; } catch { return "manual"; }
}
/** IP auto-granted per GM-marked success when the award model is autoBaseline (default 1). */
export function ipAutoBaselineAmount() {
  try { const n = Number(game.settings.get(SCOPE, "ipAutoBaselineAmount")); return Number.isFinite(n) ? n : 1; } catch { return 1; }
}
/** Anti-grind throttle: "off" (default) / "hardcap" (1/skill/apply-cycle) / "diminishing" (halving). */
export function ipThrottle() {
  try { return game.settings.get(SCOPE, "ipThrottle") || "off"; } catch { return "off"; }
}
/** Skill-lock mode: "owner" (default) / "gm" / "mutual". */
export function ipSkillLockMode() {
  try { return game.settings.get(SCOPE, "ipSkillLockMode") || "owner"; } catch { return "owner"; }
}
/** Whether the GM sees the pending-IP pip in the in-sheet cluster (client setting; default on). */
export function ipShowPending() {
  try { return game.settings.get(SCOPE, "ipShowPending") !== false; } catch { return true; }
}

// --- Shopping / economy accessors ([[shopping-design]]) ---
/** Master gate: is the Augmented shop enabled at all? (Off when the setting is missing.) */
export function shoppingEnabled() {
  try { return game.settings.get(SCOPE, "shoppingEnabled") === true; } catch { return false; }
}
/** Whether the current user may purchase. GMs always may; players only when allowed by the setting. */
export function canShop() {
  if (game.user?.isGM) return true;
  try { return game.settings.get(SCOPE, "playersCanShop") !== false; } catch { return true; }
}
/** Master gate: are homebrew (non-canon/community) sources allowed in play at all? */
export function shopAllowHomebrew() {
  try { return game.settings.get(SCOPE, "shopAllowHomebrew") === true; } catch { return false; }
}
/** Per-source enable map { supplementName: true } for players (GM-curated from the shop). */
export function shopEnabledSources() {
  try { return game.settings.get(SCOPE, "shopEnabledSources") || {}; } catch { return {}; }
}
/** Per-user toggle: show the item source/supplement badge in the shop (default on). */
export function shopShowSource() {
  try { return game.settings.get(SCOPE, "shopShowSource") !== false; } catch { return true; }
}
/** Bundled config for the supplement-visibility helpers in shop/supplements.js. */
export function shopSourceConfig() {
  return { allowHomebrew: shopAllowHomebrew(), enabledSources: shopEnabledSources() };
}
