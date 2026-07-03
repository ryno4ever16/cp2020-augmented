/**
 * Settings for Cyberpunk 2020: Augmented Edition.
 *
 * Mirrors the base system's settings shape: a SCOPE const, registration via
 * SETTINGS.* i18n keys (text lives in lang/*.json), and try/catch accessor
 * helpers that return a safe default. Augmented features are opt-in (default off).
 */
import { enhanceSettingsConfig } from "./settings-sections.js";

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
  // config:false — driven by the notice's own "Don't show this again" checkbox, not a menu toggle.
  game.settings.register(SCOPE, "automationNoticeHide", {
    name: "SETTINGS.AutomationNoticeHide",
    hint: "SETTINGS.AutomationNoticeHideHint",
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });

  // --- presetFirstRunDone ---
  // config:false — first-run flag for the one-time Settings Presets picker (see the ready hook in
  // cp2020-augmented.js). Flipped true the first time a GM loads, so the picker is offered once only.
  game.settings.register(SCOPE, "presetFirstRunDone", {
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });

  // --- damageArmorMode ---
  game.settings.register(SCOPE, "damageArmorMode", {
    name: "SETTINGS.DamageArmorMode",
    hint: "SETTINGS.DamageArmorModeHint",
    scope:   "world",
    config:  true,
    type:    String,
    choices: {
      "full":   "SETTINGS.DamageArmorModeChoiceFull",
      "simple": "SETTINGS.DamageArmorModeChoiceSimple",
      "none":   "SETTINGS.DamageArmorModeChoiceNone",
    },
    default: "full",
  });

  // --- damageAblation ---
  game.settings.register(SCOPE, "damageAblation", {
    name: "SETTINGS.DamageAblation",
    hint: "SETTINGS.DamageAblationHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- damageAutoApply ---
  game.settings.register(SCOPE, "damageAutoApply", {
    name: "SETTINGS.DamageAutoApply",
    hint: "SETTINGS.DamageAutoApplyHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- headHitDoubling ---
  game.settings.register(SCOPE, "headHitDoubling", {
    name: "SETTINGS.HeadHitDoubling",
    hint: "SETTINGS.HeadHitDoublingHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
  });

  // --- limbLossEnabled ---
  game.settings.register(SCOPE, "limbLossEnabled", {
    name: "SETTINGS.LimbLossEnabled",
    hint: "SETTINGS.LimbLossEnabledHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- suppressiveFireSaves ---
  game.settings.register(SCOPE, "suppressiveFireSaves", {
    name: "SETTINGS.SuppressiveFireSaves",
    hint: "SETTINGS.SuppressiveFireSavesHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- autoDeathSavePerTurn ---
  game.settings.register(SCOPE, "autoDeathSavePerTurn", {
    name: "SETTINGS.AutoDeathSavePerTurn",
    hint: "SETTINGS.AutoDeathSavePerTurnHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- autoSaveRePrompt ---
  game.settings.register(SCOPE, "autoSaveRePrompt", {
    name: "SETTINGS.AutoSaveRePrompt",
    hint: "SETTINGS.AutoSaveRePromptHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- activeDodgeParryEnabled ---
  game.settings.register(SCOPE, "activeDodgeParryEnabled", {
    name: "SETTINGS.ActiveDodgeParryEnabled",
    hint: "SETTINGS.ActiveDodgeParryEnabledHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- aimTrackingEnabled ---
  game.settings.register(SCOPE, "aimTrackingEnabled", {
    name: "SETTINGS.AimTrackingEnabled",
    hint: "SETTINGS.AimTrackingEnabledHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- waitForTurnEnabled ---
  game.settings.register(SCOPE, "waitForTurnEnabled", {
    name: "SETTINGS.WaitForTurnEnabled",
    hint: "SETTINGS.WaitForTurnEnabledHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // (specialMeleeEffectsEnabled is registered below, in the dual-owned block that stands down when the
  //  fork's system already owns the key — an earlier plain registration here was dead, the second won.)

  // --- gasGrenadeCloudEnabled ---
  game.settings.register(SCOPE, "gasGrenadeCloudEnabled", {
    name: "SETTINGS.GasGrenadeCloudEnabled",
    hint: "SETTINGS.GasGrenadeCloudEnabledHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- gasCloudAutoMove ---
  game.settings.register(SCOPE, "gasCloudAutoMove", {
    name: "SETTINGS.GasCloudAutoMove",
    hint: "SETTINGS.GasCloudAutoMoveHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- taserCumPenaltyEnabled ---
  game.settings.register(SCOPE, "taserCumPenaltyEnabled", {
    name: "SETTINGS.TaserCumPenaltyEnabled",
    hint: "SETTINGS.TaserCumPenaltyEnabledHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- acidArmorDotEnabled ---
  game.settings.register(SCOPE, "acidArmorDotEnabled", {
    name: "SETTINGS.AcidArmorDotEnabled",
    hint: "SETTINGS.AcidArmorDotEnabledHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- acidDotStackMode ---
  game.settings.register(SCOPE, "acidDotStackMode", {
    name: "SETTINGS.AcidDotStackMode",
    hint: "SETTINGS.AcidDotStackModeHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "stack":    "SETTINGS.AcidDotStackModeChoiceStack",
      "reset":    "SETTINGS.AcidDotStackModeChoiceReset",
      "separate": "SETTINGS.AcidDotStackModeChoiceSeparate",
    },
    default: "stack",
  });

  // --- fireDotEnabled ---
  game.settings.register(SCOPE, "fireDotEnabled", {
    name: "SETTINGS.FireDotEnabled",
    hint: "SETTINGS.FireDotEnabledHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- fireDotStackMode ---
  game.settings.register(SCOPE, "fireDotStackMode", {
    name: "SETTINGS.FireDotStackMode",
    hint: "SETTINGS.FireDotStackModeHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "stack":    "SETTINGS.FireDotStackModeChoiceStack",
      "reset":    "SETTINGS.FireDotStackModeChoiceReset",
      "separate": "SETTINGS.FireDotStackModeChoiceSeparate",
    },
    default: "stack",
  });

  // --- multiActionPenaltyEnabled ---
  game.settings.register(SCOPE, "multiActionPenaltyEnabled", {
    name: "SETTINGS.MultiActionPenaltyEnabled",
    hint: "SETTINGS.MultiActionPenaltyEnabledHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  // --- multiActionAutoTrack ---
  game.settings.register(SCOPE, "multiActionAutoTrack", {
    name: "SETTINGS.MultiActionAutoTrack",
    hint: "SETTINGS.MultiActionAutoTrackHint",
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
    name: "SETTINGS.ShotgunSpreadEnabled",
    hint: "SETTINGS.ShotgunSpreadEnabledHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
  });

  // --- explosivesEnabled ---
  game.settings.register(SCOPE, "explosivesEnabled", {
    name: "SETTINGS.ExplosivesEnabled",
    hint: "SETTINGS.ExplosivesEnabledHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
  });

  // --- areaEffectOcclusion ---
  game.settings.register(SCOPE, "areaEffectOcclusion", {
    name: "SETTINGS.AreaEffectOcclusion",
    hint: "SETTINGS.AreaEffectOcclusionHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
  });

  // --- explosivesDetailed ---
  game.settings.register(SCOPE, "explosivesDetailed", {
    name: "SETTINGS.ExplosivesDetailed",
    hint: "SETTINGS.ExplosivesDetailedHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- limbModel (Core / Listen Up crippling / W4RST4R) ---
  // One selector replacing the old limbCripplingDetailed + w4rst4rLimbRules booleans (w4rst4rLimbRules
  // was referenced but never registered here). Read via activeLimbModel() in combat/DamageApplicator.js;
  // existing worlds are migrated from the old toggle in cp2020-augmented.js.
  game.settings.register(SCOPE, "limbModel", {
    name: "SETTINGS.LimbModel",
    hint: "SETTINGS.LimbModelHint",
    scope:   "world",
    config:  true,
    type:    String,
    choices: {
      "core":     "SETTINGS.LimbModelChoiceCore",
      "listenup": "SETTINGS.LimbModelChoiceListenUp",
      "w4rst4r":  "SETTINGS.LimbModelChoiceW4rst4r",
    },
    default: "core",
  });

  // --- hitLocationCoreDisplay (Core human table vs each actor's own) ---
  // Orthogonal to the limb model: ON (default) forces the canonical Core human hit-location table;
  // OFF honors a per-actor custom hit-location table. (Was referenced in utils.js but never registered.)
  game.settings.register(SCOPE, "hitLocationCoreDisplay", {
    name: "SETTINGS.HitLocationCoreDisplay",
    hint: "SETTINGS.HitLocationCoreDisplayHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
  });

  // --- Vehicles (Core CP2020 "Vehicles in FNFF", p.112) — available WITHOUT Maximum Metal ---
  // These two are core vehicle automation; they default ON and work under the Core ruleset on their
  // own. They live above the Maximum Metal header so they stay configurable when MM is off.
  game.settings.register(SCOPE, "vehicleControlEnabled", {
    name: "SETTINGS.VehicleControlEnabled",
    hint: "SETTINGS.VehicleControlEnabledHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
  });

  game.settings.register(SCOPE, "vehicleDamageEnabled", {
    name: "SETTINGS.VehicleDamageEnabled",
    hint: "SETTINGS.VehicleDamageEnabledHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
  });

  // ===================== MAXIMUM METAL (master + overlay) =====================
  // Master switch. Everything registered from here down belongs to the Maximum Metal layer; the
  // renderSettingsConfig hook (below) groups them under a "Maximum Metal" header.
  game.settings.register(SCOPE, "mmEnabled", {
    name: "SETTINGS.MmEnabled",
    hint: "SETTINGS.MmEnabledHint",
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
    name: "SETTINGS.VehicleRuleSystem",
    hint: "SETTINGS.VehicleRuleSystemHint",
    scope:   "world",
    config:  true,
    type:    String,
    choices: {
      "Core":         "SETTINGS.VehicleRuleSystemChoiceCore",
      "MaximumMetal": "SETTINGS.VehicleRuleSystemChoiceMaximumMetal",
    },
    default: "Core",
  });

  // --- Maximum Metal optional rule: Armor Damage via Penetration (errata p.107) ---
  game.settings.register(SCOPE, "vehicleArmorDamageEnabled", {
    name: "SETTINGS.VehicleArmorDamageEnabled",
    hint: "SETTINGS.VehicleArmorDamageEnabledHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- Maximum Metal optional rule: Crew Morale (MM optional) ---
  game.settings.register(SCOPE, "vehicleMoraleEnabled", {
    name: "SETTINGS.VehicleMoraleEnabled",
    hint: "SETTINGS.VehicleMoraleEnabledHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // --- Vehicles: Weapon mount arc enforcement (Phase 5) ---
  game.settings.register(SCOPE, "vehicleArcEnforcement", {
    name: "SETTINGS.VehicleArcEnforcement",
    hint: "SETTINGS.VehicleArcEnforcementHint",
    scope:   "world",
    config:  true,
    type:    String,
    choices: {
      "free":   "SETTINGS.VehicleArcEnforcementChoiceFree",
      "strict": "SETTINGS.VehicleArcEnforcementChoiceStrict",
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

  // --- Automated rangefinding ---
  // Pre-selects the range band in the attack dialog from the measured token distance. Fork-owned on
  // the fork (system scope); the module registers a shadow so vanilla installs get an off-switch
  // (without it the read threw and the feature was permanently ON). Read via autoRangefindingEnabled().
  const systemOwnsRangefinding = (() => {
    try { return game.settings.settings.has("cyberpunk2020.autoRangefinding"); } catch { return false; }
  })();
  game.settings.register(SCOPE, "autoRangefinding", {
    name: "SETTINGS.AutoRangefinding",
    hint: "SETTINGS.AutoRangefindingHint",
    scope: "world",
    config: !systemOwnsRangefinding,
    type: Boolean,
    default: true,
  });

  // GM-registered custom calibers as world DATA (config:false; set via macro/API, merged in
  // lookups.js getCalibers). Fork-owned on the fork; the module registers a shadow so a vanilla GM
  // can carry custom calibers (without it the module read threw → custom calibers never appeared).
  game.settings.register(SCOPE, "customCalibers", { scope: "world", config: false, type: Object, default: {} });

  // --- IP (Improvement Points) tracker ([[ip-tracker-design]]) ---
  // Two gates over the always-present dual-bucket store (per-skill flag `ip` bank + a fungible actor
  // flag `ipPool`): ipRawTracking (behaviour — per-skill auto-attribution + the skill-roll queue) and
  // ipHideUI (presence — hide the IP UI entirely). The 4 sub-settings below only matter under RAW; the
  // renderSettingsConfig hook greys them out while ipRawTracking is off. Migrated from the old 3-way
  // `ipSystem` by migrateAugmentedSettings().
  game.settings.register(SCOPE, "ipRawTracking", {
    name: "SETTINGS.IpRawTracking",
    hint: "SETTINGS.IpRawTrackingHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
  game.settings.register(SCOPE, "ipHideUI", {
    name: "SETTINGS.IpHideUI",
    hint: "SETTINGS.IpHideUIHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
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
  // RAW-IP neglect detector state (not in the menu): muted = GM ticked "don't ask again"; nudged = a
  // nudge already fired for the current over-threshold episode (re-arms when the queue drops back below
  // the threshold). See module/ip/ip.js.
  game.settings.register(SCOPE, "ipNeglectMuted", { scope: "world", config: false, type: Boolean, default: false });
  game.settings.register(SCOPE, "ipNeglectNudged", { scope: "world", config: false, type: Boolean, default: false });

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

  // Player buy source when buying directly: "catalog" (full compendia) or "shops" (published shops only —
  // players still browse the catalog, but must request GM permission to buy from it; see the purchase
  // request flow in shop/catalog.js). Default: published shops only.
  game.settings.register(SCOPE, "shopBuySource", {
    name: "SETTINGS.ShopBuySource",
    hint: "SETTINGS.ShopBuySourceHint",
    scope: "world",
    config: true,
    type: String,
    choices: { catalog: "SETTINGS.ShopBuySourceCatalog", shops: "SETTINGS.ShopBuySourceShops" },
    default: "shops"
  });

  // Per-source enable map { supplementName: true } for PLAYERS. GM-curated via in-shop controls.
  game.settings.register(SCOPE, "shopEnabledSources", { scope: "world", config: false, type: Object, default: {} });

  // GM price overrides for items the BASE compendium leaves unpriced (blank / "varies by design"
  // cost). Map { [item._id]: price }, GM-written. Keyed by _id (stable across rename/localization —
  // see the by-id rule). This is a SELF-DISENGAGING fallback: resolveCatalogPrice (purchase.js) always
  // prefers a valid compendium cost, so an override goes dead the instant real data appears (the value
  // is fixed upstream / our data PR lands). Same mechanism the variable-price items (cybermodems/decks)
  // use. Not shown in the menu — written via the catalog's price-request flow.
  game.settings.register(SCOPE, "shopPriceOverrides", { scope: "world", config: false, type: Object, default: {} });

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

  // --- ammoBlackhandsPricing (one selector: box prices + brass ×3) ---
  // Optional Blackhand's Guide ammo pricing, read in lookups.js. The old ammoUseBlackhandsBoxes/Brass
  // booleans were referenced there but never registered, so this registers the merged selector (and the
  // lookups.js reads were also reading the wrong scope — fixed alongside).
  game.settings.register(SCOPE, "ammoBlackhandsPricing", {
    name: "SETTINGS.AmmoBlackhandsPricing",
    hint: "SETTINGS.AmmoBlackhandsPricingHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "off":   "SETTINGS.AmmoBlackhandsPricingChoiceOff",
      "boxes": "SETTINGS.AmmoBlackhandsPricingChoiceBoxes",
      "brass": "SETTINGS.AmmoBlackhandsPricingChoiceBrass",
      "both":  "SETTINGS.AmmoBlackhandsPricingChoiceBoth",
    },
    default: "off",
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

  // --- Native System Settings page organizer (section headers + reorder + master-gating) ---
  // One data-driven pass (module/settings-sections.js) replacing the per-feature MM + IP grey-out
  // hooks: labelled section headers, contiguous reorder, and grey/disable of each master's sub-settings.
  Hooks.on("renderSettingsConfig", (app, html) => enhanceSettingsConfig(html));

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

/** Automated rangefinding toggle. Fork's system copy is authoritative; falls back to the module
 *  shadow (vanilla), then the ON default. Same dual-scope shape as specialMeleeEffectsEnabled. */
export function autoRangefindingEnabled() {
  try { return game.settings.get("cyberpunk2020", "autoRangefinding") === true; } catch { /* not the fork */ }
  try { return game.settings.get(SCOPE, "autoRangefinding") === true; } catch { /* not registered */ }
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
// IP is ALWAYS present as a dual-bucket store (per-skill flag `ip` bank + a fungible actor flag
// `ipPool`); it is ignorable when unused. Two world gates replace the old 3-way `ipSystem`:
// ipRawTracking (behaviour) and ipHideUI (presence).
/** Whether RAW auto-tracking (per-skill attribution + the skill-roll queue) is on. Off by default. */
export function ipRawTracking() {
  try { return game.settings.get(SCOPE, "ipRawTracking") === true; } catch { return false; }
}
/** Whether the GM has hidden the IP UI entirely (presence gate, for pure-narrative tables). */
export function ipHideUI() {
  try { return game.settings.get(SCOPE, "ipHideUI") === true; } catch { return false; }
}
/** Whether the IP UI/logic is shown. The dual-bucket store always exists; this only hides the UI. */
export function ipEnabled() { return !ipHideUI(); }
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
/** Player buy source when buying directly: "catalog" (full compendia) or "shops" (published shops only). */
export function shopBuySource() {
  try { return game.settings.get(SCOPE, "shopBuySource") || "shops"; } catch { return "shops"; }
}
/** Per-source enable map { supplementName: true } for players (GM-curated from the shop). */
export function shopEnabledSources() {
  try { return game.settings.get(SCOPE, "shopEnabledSources") || {}; } catch { return {}; }
}
/** GM price-override map { [item._id]: price } for compendium items the base leaves unpriced. */
export function getShopPriceOverrides() {
  try { return game.settings.get(SCOPE, "shopPriceOverrides") || {}; } catch { return {}; }
}
/** The GM price override for one item _id, or undefined if none set. */
export function getShopPriceOverride(itemId) {
  if (!itemId) return undefined;
  return getShopPriceOverrides()[itemId];
}
/** Persist a GM price override for one item _id (GM only; clamped to a non-negative integer). */
export async function setShopPriceOverride(itemId, price) {
  if (!itemId || !game.user?.isGM) return;
  const map = { ...getShopPriceOverrides(), [itemId]: Math.max(0, Math.round(Number(price) || 0)) };
  await game.settings.set(SCOPE, "shopPriceOverrides", map);
}
/** Per-user toggle: show the item source/supplement badge in the shop (default on). */
export function shopShowSource() {
  try { return game.settings.get(SCOPE, "shopShowSource") !== false; } catch { return true; }
}
/** Bundled config for the supplement-visibility helpers in shop/supplements.js. */
export function shopSourceConfig() {
  return { allowHomebrew: shopAllowHomebrew(), enabledSources: shopEnabledSources() };
}
