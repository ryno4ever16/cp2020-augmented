/**
 * Settings for Cyberpunk 2020: Augmented Edition.
 *
 * Mirrors the base system's settings shape: a SCOPE const, registration via
 * SETTINGS.* i18n keys (text lives in lang/*.json), and try/catch accessor
 * helpers that return a safe default. Augmented features are opt-in (default off).
 */
import { enhanceSettingsConfig } from "./settings-sections.js";
import { reconcileTokenWrites as reconcileLightTokenWrites } from "./mech/light.js";
import { reconcileTokenWrites as reconcileVisionTokenWrites } from "./mech/vision.js";
import { isPrimaryGMSession } from "./gm-session-primary.js";

const SCOPE = "cp2020-augmented";

/** Set once the `<body>` class-list watcher below is installed, so it is only ever attached once. */
let _colorSchemeWatch = null;

/**
 * Apply (or clear) the `cp-carolingian` <body> class that gates the terminal sheet skin in
 * css/cp2020-augmented.css, following Foundry's ACTIVE APPLICATIONS COLOUR SCHEME.
 *
 * The skin IS the module's dark look, so it is on whenever the applications scheme is dark and
 * stands down entirely under the light scheme, where the sheets read as the base system's.
 *
 * How the scheme is read: core (verified identical in v13.350 and v14.364, `Game#configureUI`)
 * removes `theme-light`/`theme-dark` from `document.body` and re-adds exactly one of them, from
 * `game.settings.get("core","uiConfig").colorScheme.applications`, falling back to the browser's
 * `prefers-color-scheme` when that is unset. Reading the class rather than the setting therefore
 * covers both the explicit choice and the browser fallback, on both cores, with one expression:
 * anything that is not explicitly the light scheme keeps the module's own look.
 *
 * Live switching: core re-stamps that class whenever the scheme changes (the UI settings menu
 * writes `core.uiConfig`, whose onChange re-runs `configureUI`; an OS colour-scheme flip does the
 * same through a `matchMedia` listener). A class-list observer on `<body>` therefore tracks every
 * one of those paths without a reload and without depending on a core hook name.
 */
export function applyCarolingianSkinClass() {
  try {
    const body = document.body;
    if (!body) return;
    body.classList.toggle("cp-carolingian", !body.classList.contains("theme-light"));
    if (!_colorSchemeWatch && typeof MutationObserver === "function") {
      _colorSchemeWatch = new MutationObserver(() => applyCarolingianSkinClass());
      _colorSchemeWatch.observe(body, { attributes: true, attributeFilter: ["class"] });
    }
  } catch (e) { /* DOM not ready yet */ }
}

/**
 * The two base-system compendium packs the `hideScrapedPacks` setting covers. Both hold the 2021
 * bulk scrape (726 unreviewed weapons); the shop's source-canonicity gate never reaches the
 * Compendium sidebar, so at stock pack ownership every player can browse and drag them.
 */
const SCRAPED_PACK_IDS = ["cyberpunk2020.pistols-add", "cyberpunk2020.rifles-add"];

/**
 * Apply (or lift) the player-facing hide on the two scraped base-system packs, per the world
 * `hideScrapedPacks` setting (default on). Called once on `ready` and again whenever the setting
 * is toggled.
 *
 * MECHANISM — identical on core 13.350 and 14.365 (both build the `core.compendiumConfiguration`
 * setting from the same `CompendiumCollection.CONFIG_FIELD`, whose `ownership` is a SchemaField of
 * GAMEMASTER / ASSISTANT / TRUSTED / PLAYER → ownership-level strings): `pack.configure({ownership})`
 * writes that pack's entry, and `pack.getUserLevel(user)` takes the MAX level over every role the
 * user holds. Setting PLAYER and TRUSTED to "NONE" therefore puts a player below OBSERVER, which is
 * exactly what `pack.visible` tests — so the pack leaves the Compendium sidebar for players. The
 * GAMEMASTER / ASSISTANT entries are carried over untouched, so a GM's own access never changes.
 * Core's own `_onConfigure` handler re-renders the sidebar on every client but does NOT re-derive the
 * directory tree that filters on `pack.visible`, so an already-connected client needs the small
 * updateSetting reconcile registered in registerAugmentedSettings() to drop the stale row.
 *
 * SNAPSHOT — the pack's RAW configured ownership (`pack.config.ownership`, undefined when the world
 * has never configured that pack) is stamped into the world-scoped `hideScrapedPacksPrior` map
 * BEFORE the first change, with `null` recording "there was no entry at all". Turning the setting
 * off restores that exact value (a `null` stamp passes `undefined`, which makes `configure` DELETE
 * the key so the pack falls back to its manifest ownership) and clears the stamp, so a later re-ON
 * snapshots whatever the GM has chosen since.
 *
 * The write is made by the PRIMARY GM SESSION only: `core.compendiumConfiguration` is a world setting
 * (a player write would be rejected) and one writer avoids N GM clients racing the same map — including
 * two tabs of one referee, which the old user-id form counted as one. The re-assert is idempotent — a
 * pack already carrying PLAYER/TRUSTED "NONE" is not rewritten, so after the first application every
 * later load is a no-op. Wrapped so a config hiccup cannot break ready.
 */
export async function applyScrapedPackVisibility() {
  try {
    if (!isPrimaryGMSession()) return;
    const on = hideScrapedPacks();
    const prior = { ...(game.settings.get(SCOPE, "hideScrapedPacksPrior") ?? {}) };
    let priorChanged = false;

    for (const id of SCRAPED_PACK_IDS) {
      const pack = game.packs?.get(id);
      if (!pack) continue;                                   // pack absent on this install
      const configured = pack.config?.ownership;
      if (on) {
        if (configured?.PLAYER === "NONE" && configured?.TRUSTED === "NONE") continue;   // already hidden
        if (!(id in prior)) {
          prior[id] = configured ? foundry.utils.deepClone(configured) : null;
          priorChanged = true;
        }
        // Carry every OTHER role's level through verbatim (GM/assistant access is untouched), then
        // pin the two player-facing roles to NONE. Non-string levels are dropped rather than passed
        // to the SchemaField, which only accepts the level KEYS.
        const carry = {};
        for (const [role, level] of Object.entries(pack.ownership ?? {})) {
          if (role !== "PLAYER" && role !== "TRUSTED" && typeof level === "string") carry[role] = level;
        }
        await pack.configure({ ownership: { ...carry, TRUSTED: "NONE", PLAYER: "NONE" } });
      } else if (id in prior) {
        await pack.configure({ ownership: prior[id] ?? undefined });
        delete prior[id];
        priorChanged = true;
      }
    }
    if (priorChanged) await game.settings.set(SCOPE, "hideScrapedPacksPrior", prior);
  } catch (e) {
    console.warn(`${SCOPE} | scraped-pack visibility not applied (compendium ownership left as found)`, e);
  }
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

  // ── Mech-automation toggles (1.1.0 pre-release review §J; user-scoped to these groups) ──
  // Group 1: item-driven TOKEN writes — light emission, sight override, the heat-sense
  // detection entry. The biggest "the module touched my tokens" surface; GMs who hand-author
  // token lighting/vision switch it off and gear toggles become sheet-only.
  game.settings.register(SCOPE, "mechTokenWrites", {
    name: "SETTINGS.MechTokenWrites",
    hint: "SETTINGS.MechTokenWritesHint",
    scope: "world", config: true, type: Boolean, default: true,
    // Lifecycle reconcile: flipping OFF while an override is live must restore the token (the
    // gear-off restore is otherwise gated out); flipping ON re-applies live emitters/devices. Each
    // client runs it; only the active-GM applier actually writes (the sweeps are applier-scoped).
    onChange: (value) => {
      const enabled = value !== false;
      try { reconcileLightTokenWrites(enabled); } catch (e) { /* scenes not ready */ }
      try { reconcileVisionTokenWrites(enabled); } catch (e) { /* scenes not ready */ }
    }
  });
  // Group 2: ROUND-TICK automation — drug/consumable countdowns, expiry cards, the wear-off
  // save prompt and its crash overlay. Off = durations run narratively; the sheet controls
  // (Take / Wear-off / Use) keep working.
  game.settings.register(SCOPE, "mechRoundTickAutomation", {
    name: "SETTINGS.MechRoundTick",
    hint: "SETTINGS.MechRoundTickHint",
    scope: "world", config: true, type: Boolean, default: true
  });
  // Group 3: DOCUMENT automation — chip skill grant/prune, loadout materialize/prune, the
  // container delete-cascade detach. The most invasive class (creates/deletes embedded items).
  game.settings.register(SCOPE, "mechDocumentAutomation", {
    name: "SETTINGS.MechDocumentAutomation",
    hint: "SETTINGS.MechDocumentAutomationHint",
    scope: "world", config: true, type: Boolean, default: true
  });
  // Permission scoping: the sheet's limb-recovery controls (cyberlimb Repair + flesh-limb Clear)
  // are GM-only by default — recovery is an outcome the GM adjudicates (Tech roll, cost, clinic,
  // downtime), not a button a player presses on their own wounds. OFF = owners may use them.
  game.settings.register(SCOPE, "cyberlimbRepairGmOnly", {
    name: "SETTINGS.CyberlimbRepairGmOnly",
    hint: "SETTINGS.CyberlimbRepairGmOnlyHint",
    scope: "world", config: true, type: Boolean, default: true
  });

  // --- hideScrapedPacks ---
  // Player-facing exposure scoping for the base system's two bulk-scraped weapon packs
  // (cyberpunk2020.pistols-add / rifles-add). Those packs ship PLAYER: OBSERVER, so every player can
  // browse and drag their 726 unreviewed items straight from the Compendium sidebar — a surface the
  // shop's source-canonicity gate does not cover. ON (default) sets PLAYER/TRUSTED ownership to NONE
  // for those two packs only; OFF restores the ownership snapshotted before the first change. The GM's
  // own access is never touched. See applyScrapedPackVisibility() above for the full mechanism.
  game.settings.register(SCOPE, "hideScrapedPacks", {
    name: "SETTINGS.HideScrapedPacks",
    hint: "SETTINGS.HideScrapedPacksHint",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: () => { applyScrapedPackVisibility(); }
  });
  // config:false companion store — the pack ownership as it stood BEFORE hideScrapedPacks first
  // changed it, keyed by pack id ({} once nothing is hidden; a `null` entry means the world had no
  // ownership configured for that pack at all). Written only by the active GM; never shown in the menu.
  game.settings.register(SCOPE, "hideScrapedPacksPrior", {
    scope: "world", config: false, type: Object, default: {},
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

  // --- automationNoticeVersion ---
  // config:false — the module version at which the GM last dismissed the notice. Empty by default
  // so the first version-aware load re-shows the (now updated) notice to everyone who had already
  // dismissed an older one; thereafter the notice re-surfaces only when the module version changes.
  game.settings.register(SCOPE, "automationNoticeVersion", {
    name: "SETTINGS.AutomationNoticeVersion",
    hint: "SETTINGS.AutomationNoticeVersionHint",
    scope: "world",
    config: false,
    type: String,
    default: "",
  });

  // ⏪⏪ `presetFirstRunDone` STOOD HERE UNTIL 2026-08-28 AND IS RETIRED WITH THE THING IT GUARDED.
  // It was the "the one-time picker has been offered" flag for a ready-hook modal that no longer
  // exists (user: *"I'm down to drop the first run modal for the menu picker"*). A flag with nothing
  // to guard is not a setting, it is debris — so it went with the block, and a world that already
  // stored it keeps an unread value. ⭐ The picker itself is untouched and is still reachable
  // deliberately from System Settings → "Settings Presets".

  // --- damageArmorMode ---
  // Since the 2026-08-29 ablation merge (tombstone below) the mode is the whole armor truth:
  // "full" = SP with wear-on-penetration (RAW), "simple" = SP only, "none" = no armor. The default
  // is "simple" BECAUSE the pre-merge shipped default was full-without-wear — same effective
  // behavior, honest new name. Wear is one of the permanently-writes-to-characters rules the setup
  // notice promises start OFF.
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
    default: "simple",
  });

  // ⏪⏪ `damageAblation` STOOD HERE UNTIL 2026-08-29 AND IS RETIRED — MERGED INTO `damageArmorMode`
  // (settings-trim ruling). The two double-covered one gate: DamageApplicator only ever ablated when
  // ablate AND mode === "full", so "Full (SP + Ablation)" with the checkbox off was behaviorally
  // identical to "Simple" — three real states expressed by two redundant controls, with the choice
  // label lying about one of them. Now the MODE is the whole truth: "full" = SP with ablation (the
  // label finally true), "simple" = SP only, "none" = no armor. The damage window's per-application
  // Ablate checkbox survives as the point-of-use override, defaulting from the mode. Worlds are
  // migrated in migrateAugmentedSettings: (full + ablate-off/unset) → "simple" so nobody's effective
  // behavior changes; the orphaned boolean doc is left unread.

  // The world `damageAutoApply` toggle was RETIRED (user ruling, 2026-08-14): "auto apply should be
  // removed as a feature and the option of whether to apply it can be handled at each instance of
  // damage instead of a module-wide rule that can be mysteriously turned on or off". Every resolution
  // now opens the confirmation window (one per application batch), so the decision is taken where the
  // damage is, by whoever is looking at it. A world that had it ON simply sees windows again — nothing
  // migrates anywhere, and the orphaned world doc is dropped in migrateAugmentedSettings.

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

  // ⏪ `rerollGoneLimbLocation` RETIRED 2026-08-29 (settings-trim): the book itself rules the
  // off-state absurd ("that roll is pretty silly, ignore it and re-roll", p.100), so the re-roll now
  // runs unconditionally (utils.js answers true). Aimed/GM-chosen locations are still never re-rolled.

  // ⏪ `suppressiveFireSaves` RETIRED 2026-08-29 (settings-trim, action-as-consent): declaring the
  // burst and PLACING the lane is the opt-in, and the placement preview cancels (Esc/teardown) — the
  // world switch only gated presence. NOTE this one shipped default:false, so retirement TURNS THE
  // FLOW ON for every world that never touched it: a declaration now always offers the lane. The
  // read in damage-hooks answers true; a stored false is orphaned unread.

  // ⏪ `autoDeathSavePerTurn` and `autoSaveRePrompt` were REGISTERED HERE — retired 2026-08-28
  // (user ruling at the 1.2.0 gate): the per-turn Death Save (p.105) and unconscious Stun-recovery
  // (p.104) prompts are the book's own cadence and write nothing until answered, so they run
  // unconditionally (combat/save-rolls.js, the updateCombat hook) and need no switch. The chat-spam
  // objection is answered structurally there — one standing ask per body per kind — not by a
  // setting. A world's stored values for the old keys are orphaned harmlessly.

  // ⏪⏪ `activeDodgeParryEnabled`, `aimTrackingEnabled` and `waitForTurnEnabled` STOOD HERE UNTIL
  // 2026-08-29 AND ARE RETIRED TOGETHER (settings-trim, the ipHideUI class): each was a pure presence
  // gate on a combat-tracker control that fires NOTHING until pressed — press to opt in, ignore to
  // opt out, and the switch only added a way to lose the control. The reads in damage-hooks answer
  // true; stored values orphan unread.

  // (specialMeleeEffectsEnabled is registered below, in the dual-owned block that stands down when the
  //  fork's system already owns the key — an earlier plain registration here was dead, the second won.)

  // ⏪ `gasGrenadeCloudEnabled` RETIRED 2026-08-29 (settings-trim, load-the-round-is-consent): OFF
  // bought the dead state — a loaded gas round that lands and does nothing, untracked. The reads in
  // damage-hooks and vehicle-ordnance answer true. (`gasCloudAutoMove` below SURVIVES by user call —
  // drift vs GM-controlled wind is a genuine preference; earmarked to maybe become a per-cloud
  // control, at which point it dies too.)

  // --- gasCloudAutoMove ---
  game.settings.register(SCOPE, "gasCloudAutoMove", {
    name: "SETTINGS.GasCloudAutoMove",
    hint: "SETTINGS.GasCloudAutoMoveHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // (No radiationEnabled toggle: the Deep Space radiation subsystem has no world-setting gate. It is
  //  inert until a GM engages it — placing a rad zone or applying a dose IS the opt-in — so a redundant
  //  on/off switch was removed. Every passive path (the stat-loss overlay, the round tick, the death
  //  button, the zone tick) no-ops when the actor/scene has no radiation state.)

  // ⏪⏪ SETTINGS-TRIM RETIREMENTS 2026-08-29 (this block stood between gasCloudAutoMove and
  // explosivesDetailed; all follow the load/place/press-is-consent ruling; stored values orphan
  // unread, every read path answers the one remaining answer):
  // - `taserCumPenaltyEnabled` — p.101 cumulative save penalty; firing the round is the consent.
  // - `acidArmorDotEnabled` — the DOT arms only from `dotEnabled` on the ammo item (and no shipped
  //   item sets it — a GM must hand-author acid, double consent).
  // - `fireDotEnabled` — OFF was the dead state: incendiary that burns nothing, untracked. The
  //   per-victim confirm window is where a GM declines a specific application.
  // - `acidDotStackMode` + `fireDotStackMode` — MERGED into the single `dotStackMode` below (no book
  //   text distinguishes them; migrated in migrateAugmentedSettings, fire's stored value wins ties).
  // - `multiActionAutoTrack` — REDESIGNED AWAY: the counter always tracks (it also feeds the
  //   movement advisory), and the penalty lands as a pre-filled, LABELED, editable line in the
  //   roll dialog (the dodge-prefill idiom), so the number explains itself at the point of use.
  //   Manual ➕/reset in the tracker stays. ⚠ `multiActionPenaltyEnabled` was retired in the same
  //   pass and RESTORED the same day (user ruling, 2026-08-29): unlike the ammo/presence gates,
  //   this rule engages AUTOMATICALLY on every second action, so a table that skips it would have
  //   to zero the prefill on every roll — a per-roll tax, not an ignore-it opt-out. It is the
  //   head-hit-doubling class (a rule choice that touches every roll keeps its switch). It
  //   re-registers below, now defaulting ON since the penalty is visible and editable where it
  //   applies (the old OFF default guarded a silent fold that no longer exists).
  // - `restrictMovementOncePerTurn` — REDESIGNED AWAY: over-allowance movement after acting now
  //   WARNS instead of blocking, unconditionally (movement-gate.js) — the upstream philosophy: show
  //   the bad choice rather than refuse it.
  // - `shotgunSpreadEnabled` — OFF made buckshot behave like a slug, which loading a slug already
  //   does; the mechanic engages only for spread-configured rounds (lookups.js answers true).
  // - `explosivesEnabled` — same dead-state class as the gas retirement above: OFF meant loaded
  //   blast rounds land and do nothing (added to the cut by user word, 2026-08-29).
  // - `areaEffectOcclusion` — placing walls is the consent (a wall-less scene exempts nobody), and
  //   blocking is Core p.108 RAW. Caveat noted at the ruling: a table that walls for vision but
  //   wants blasts to ignore walls loses the option; ruled acceptable.

  // --- multiActionPenaltyEnabled (restored 2026-08-29 — see the block above) ---
  game.settings.register(SCOPE, "multiActionPenaltyEnabled", {
    name: "SETTINGS.MultiActionPenaltyEnabled",
    hint: "SETTINGS.MultiActionPenaltyEnabledHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // --- dotStackMode (one selector for every damage-over-time payload; replaces the acid/fire pair) ---
  game.settings.register(SCOPE, "dotStackMode", {
    name: "SETTINGS.DotStackMode",
    hint: "SETTINGS.DotStackModeHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "stack":    "SETTINGS.DotStackModeChoiceStack",
      "reset":    "SETTINGS.DotStackModeChoiceReset",
      "separate": "SETTINGS.DotStackModeChoiceSeparate",
    },
    default: "stack",
  });

  // (A world toggle for the cover segment auto-detect used to sit here. It was retired: PLACING a
  // cover object on the map is itself the opt-in, and the segment test returns nothing on a scene
  // that carries none — so the toggle only ever added a second switch in front of a switch.)

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

  // ⏪ `hitLocationCoreDisplay` RETIRED 2026-08-29 (settings-trim): a NO-OP by its own hint — OFF
  // handed the roll to the base system's per-actor lookup, "which in the base system today still
  // means the Core chart". A switch between identical outcomes. utils.js pins the Core-table
  // behavior (today's ON default). Re-introduce only if the base 1.2 ships per-actor tables.
  // (Closes the standing hitLocationCoreDisplay-no-op gate item.)

  // ⏪ `vehicleControlEnabled` + `vehicleDamageEnabled` RETIRED 2026-08-29 (settings-trim): both
  // gated press-driven vehicle-sheet features, and OFF only turned the press into a refusal
  // warning — don't press is the opt-out. Reads across vehicle-*.js answer true.

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

  // --- Maximum Metal optional rule: Armor Damage via Penetration (errata p.108) ---
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

  // ⏪ `vehicleArcEnforcement` RETIRED 2026-08-29 (settings-trim): the free/strict pair was the
  // movement-gate pattern again — the WARN behavior ("free", the shipped default) is now
  // unconditional and "strict" (hard-block) is deleted, per the show-don't-refuse philosophy.
  // vehicleArcEnforcement() below pins "free".

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

  // ⏪ `specialMeleeEffectsEnabled` (module shadow) RETIRED 2026-08-29 (settings-trim): the effects
  // fire only from a DECLARED action (Hold/Choke/Throw press) — action is the consent. On the fork
  // the SYSTEM still owns its own copy and the accessor below keeps honoring it; on vanilla the
  // answer is now always true.

  // ⏪ `autoRangefinding` (module shadow) RETIRED 2026-08-29 (settings-trim): it only PRE-SELECTS
  // the range band and the dialog stays fully editable — the manual override is the escape hatch,
  // so the switch bought nothing. The fork's system copy is still honored by the accessor below;
  // on vanilla the answer is always true.

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
  // ⏪⏪ `ipHideUI` STOOD HERE UNTIL 2026-08-28 AND IS RETIRED — a world switch whose entire job was to
  // make this feature invisible. User order, verbatim: *"on by default with no way to turn them off …
  // users opt out by ignoring it and opt in by using it. Hiding them behind settings just makes them
  // easy to lose."* That is the action-as-consent principle applied to a PRESENCE gate: the IP UI costs
  // a table nothing until somebody presses something in it, so the only thing the switch bought was a
  // way to lose the feature. `ipHideUI()` below survives — every call site is untouched — and answers
  // false unconditionally. A world that had this set to true keeps the stored value as unread debris;
  // nothing migrates, because there is nothing left to migrate it into.
  // ⚠ `ipRawTracking` above is NOT this and did not go with it: that one chooses a RULE (per-skill
  // auto-attribution and the roll queue), which is a real alternative a table can want either way.
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
  // ⏪ `shoppingEnabled` RETIRED 2026-08-29 (settings-trim, the ipHideUI class): a pure presence
  // gate — the vanilla base system ships no shop to stand down, so OFF only hid the buttons, and
  // press-to-open is the consent. shoppingEnabled() below answers true; every call site unchanged.
  // The PERMISSION settings (playersCanShop / playersCanBuyAmmo / shopBuySource) are a different
  // class and survive.

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

  // Per-user: the one-time "this window is being stalled from outside" notice (catalog.js
  // armShopStallSignpost — measurement-triggered, fires at most once a session). Off = never notify.
  game.settings.register(SCOPE, "shopStallNotice", {
    name: "SETTINGS.ShopStallNotice",
    hint: "SETTINGS.ShopStallNoticeHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  // GM custom shops as world DATA (shops are not Actors). Map { [id]: ShopDef }; GM-written, all clients
  // read it. See module/shop/shops.js for the ShopDef shape + CRUD.
  game.settings.register(SCOPE, "shops", { scope: "world", config: false, type: Object, default: {} });

  // --- NPC generator (module/npcgen/*) ---
  // ⏪⏪ `npcGenEnabled` STOOD HERE UNTIL 2026-08-28 AND IS RETIRED, by the same order that retired
  // `ipHideUI` above: *"on by default with no way to turn them off … users opt out by ignoring it and
  // opt in by using it. Hiding them behind settings just makes them easy to lose."* The comment this
  // replaces already argued the switch's own case away — the feature automates NOTHING, has no hook, no
  // tick and no listener, and does nothing until a referee presses a button and then presses Generate,
  // so all the switch ever controlled was whether the Actors-directory button EXISTS. Defaulting it on
  // and then keeping the switch only left a way to hide the feature from the referee who never reads
  // the settings page. `npcGenEnabled()` below survives for its callers and answers true
  // unconditionally; a stored world value is unread debris.

  // Optional wildcard token art (design §Q5C): a folder path, and every generated token rolls its own
  // face out of it. Blank — the default — falls back to the base system's own edgerunner icon, which is
  // why this ships no art of its own and adds no licensing surface.
  game.settings.register(SCOPE, "npcGenTokenArtFolder", {
    name: "SETTINGS.NpcGenTokenArtFolder",
    hint: "SETTINGS.NpcGenTokenArtFolderHint",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

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

  // The per-user `carolingianSkin` toggle was RETIRED: the terminal sheet skin is no longer
  // optional, it is the module's look under Foundry's DARK applications colour scheme, and it
  // stands down under the LIGHT scheme so the sheets read as the base system's. The choice is
  // therefore Foundry's own colour-scheme control, not a second module-level switch — see
  // applyCarolingianSkinClass() at the top of this file. Worlds that carry the old client-scoped
  // flag keep an orphan value in user data; it is never read, so it is left alone rather than
  // migrated.

  // --- Combat FX (Animation Rail A1) — muzzle flash + shot audio ---
  // One master switch for the whole presentation rail: the native muzzle-flash light, the shot
  // audio, and the optional Sequencer/JB2A sprites. On by default; a table that wants silence
  // (or a GM who hand-authors lighting) turns it off here. Read per event, so it applies live.
  game.settings.register(SCOPE, "combatFxEnabled", {
    name: "SETTINGS.CombatFx",
    hint: "SETTINGS.CombatFxHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
  });

  // The shooter turns to look at what it is shooting at before the first round goes out. A world
  // setting because it WRITES the token's rotation (the only part of the fx rail that persists
  // anything), and tables whose tokens are top-down portraits with a baked-in facing will want it
  // off. Read per shot, so it applies live.
  game.settings.register(SCOPE, "faceTargetOnFire", {
    name: "SETTINGS.FaceTargetOnFire",
    hint: "SETTINGS.FaceTargetOnFireHint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
  });

  // ⏪ RETIRED 2026-08-28 — the hit-spray switch that was registered on this spot is GONE, not
  // disabled, and so is the element it switched (module/fx/effects.js carries the tombstone; the
  // record is docs/FX-RAIL.md §6). The user withdrew the element for this release and ruled that when
  // it returns it returns as part of the arrival composition with NO option of its own — so there is
  // no setting to keep registered for it, now or later. A world that had the key set carries a stored
  // value nothing reads; core leaves such orphans alone and so do we (no migration, the read path is
  // simply gone).

  // ⏪ RETIRED 2026-08-20 — the burning-ground expiry switch that was registered on this spot on
  // 2026-08-19 is GONE, not disabled. It swapped a placement's expiry from the shipped 25 s clock to
  // 24 h, and the user withdrew it because the flames could not survive a browser reload: the only
  // mechanism that carries an effect across one is a document write issued from presentation, which
  // this module forbids. Retirement is complete at the READ PATH, which is what the migration rule
  // asks for — no code reads the key any more, so a world that stored a value simply keeps an orphan
  // row in its settings collection that nothing consults, and re-registering the key would be the only
  // way to make that value mean anything again. The key's own name, the whole removed surface and the
  // ruling are recorded in docs/FX-RAIL.md §6 under 2026-08-20.

  // --- Native System Settings page organizer (section headers + reorder + master-gating) ---
  // One data-driven pass (module/settings-sections.js) replacing the per-feature MM + IP grey-out
  // hooks: labelled section headers, contiguous reorder, and grey/disable of each master's sub-settings.
  Hooks.on("renderSettingsConfig", (app, html) => enhanceSettingsConfig(html));

  // --- Compendium sidebar reconcile after a pack-ownership change (every client, read-only) ---
  // Core's own compendiumConfiguration handler rebuilds the changed PACK's document tree and re-renders
  // the sidebar, but it re-derives the DIRECTORY's tree (game.packs.initializeTree(), the pass that
  // filters on pack.visible) only for a folder/sort change. So a client that was already connected when
  // a pack's ownership changed keeps its stale row — rig-measured: after hideScrapedPacks was switched
  // on mid-session the player's pack.visible read false while the row survived a plain re-render AND the
  // pack still opened. Re-deriving the tree here fixes both directions. Purely client-local: it re-reads
  // data the client already holds and writes nothing, so it is safe on a player client.
  Hooks.on("updateSetting", (setting) => {
    try {
      if (setting?.key !== "core.compendiumConfiguration") return;
      game.packs?.initializeTree?.();
      ui.compendium?.render();
    } catch (e) { /* sidebar or packs not ready */ }
  });

  // --- Maximum Metal: hide the MM weapon compendium from the sidebar when MM is off ---
  Hooks.on("renderCompendiumDirectory", (app, html) => {
    const root = html instanceof jQuery ? html[0] : (Array.isArray(html) ? html[0] : html);
    if (!root?.querySelector || mmEnabled()) return;          // MM on → show it normally
    const li = root.querySelector(`[data-pack="${SCOPE}.vehicle-weapons"]`);
    if (li) li.classList.add("cp-hidden");
  });
}

/** Whether the Augmented combat-automation layer is enabled. ON by default (the hint used to claim
 *  "off by default" — that was never true; text corrected 2026-08-29). */
export function combatAutomationEnabled() {
  try { return game.settings.get(SCOPE, "combatAutomationEnabled") === true; }
  catch { return false; }
}

/** Martial-arts special hit-effects. ⏪ Module shadow RETIRED 2026-08-29 (action = consent): on the
 *  fork the SYSTEM's own copy still governs; on vanilla the answer is always true. Call sites unchanged. */
export function specialMeleeEffectsEnabled() {
  try {
    if (game.settings.settings.has("cyberpunk2020.specialMeleeEffectsEnabled")) {
      return game.settings.get("cyberpunk2020", "specialMeleeEffectsEnabled") === true;
    }
  } catch { /* not the fork */ }
  return true;
}

/** Automated rangefinding. ⏪ Module shadow RETIRED 2026-08-29 (the dialog's manual override is the
 *  escape hatch): the fork's system copy still governs where it exists; on vanilla always true. */
export function autoRangefindingEnabled() {
  try {
    if (game.settings.settings.has("cyberpunk2020.autoRangefinding")) {
      return game.settings.get("cyberpunk2020", "autoRangefinding") === true;
    }
  } catch { /* not the fork */ }
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

/** Mount-arc handling. ⏪ RETIRED AS A SWITCH 2026-08-29: warn-but-allow ("free") is now the only
 *  behavior — show the bad choice, never refuse it. Kept as a function so no call site changed. */
export function vehicleArcEnforcement() { return "free"; }

// --- IP (Improvement Points) accessors ([[ip-tracker-design]]) ---
// IP is ALWAYS present as a dual-bucket store (per-skill flag `ip` bank + a fungible actor flag
// `ipPool`); it is ignorable when unused. Two world gates replace the old 3-way `ipSystem`:
// ipRawTracking (behaviour) and ipHideUI (presence).
/** Whether RAW auto-tracking (per-skill attribution + the skill-roll queue) is on. Off by default. */
export function ipRawTracking() {
  try { return game.settings.get(SCOPE, "ipRawTracking") === true; } catch { return false; }
}
/**
 * ⏪ RETIRED AS A SWITCH, KEPT AS A FUNCTION (2026-08-28). It used to read the `ipHideUI` world
 * setting; that setting no longer exists — user order: *"on by default with no way to turn them off …
 * users opt out by ignoring it and opt in by using it. Hiding them behind settings just makes them
 * easy to lose."* The function stays so that **no call site had to change**, and it answers the one
 * answer there is now. ⏪ Revert = restore the registration and this body's `game.settings.get`.
 */
export function ipHideUI() { return false; }
/** Whether the IP UI/logic is shown. The dual-bucket store always exists — and it is always shown. */
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
/** ⏪ RETIRED AS A SWITCH, KEPT AS A FUNCTION (2026-08-29, the ipHideUI idiom): the shop is always
 *  present — press to opt in, ignore to opt out. Every call site unchanged.
 *  ⏪ Revert = restore the registration and this body's `game.settings.get`. */
export function shoppingEnabled() { return true; }
/**
 * Whether the NPC generator's entry point is offered at all. Read at the directory button AND again in
 * `openNpcGenerator`, so a macro meets the same gate the button does.
 *
 * ⏪ RETIRED AS A SWITCH, KEPT AS A FUNCTION (2026-08-28), for the same reason and by the same order as
 * `ipHideUI` above — and with the extra weight that this feature has no hook, no tick and no listener,
 * so the switch never protected anybody from anything. Both readers stay, so **no call site changed**.
 * ⏪ Revert = restore the registration and this body's `game.settings.get`.
 */
export function npcGenEnabled() { return true; }
/** Wildcard token-art folder for generated NPCs; "" (the default) means the built-in icon. */
export function npcGenTokenArtFolder() {
  try { return String(game.settings.get(SCOPE, "npcGenTokenArtFolder") ?? ""); } catch { return ""; }
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

/** Group 1 — item-driven token light/vision/detection writes (default ON). */
export function mechTokenWritesEnabled() {
  try { return game.settings.get(SCOPE, "mechTokenWrites") !== false; } catch { return true; }
}
/** Group 2 — round-tick automation: drug/consumable countdowns, expiry cards, wear-off saves (default ON). */
export function mechRoundTickEnabled() {
  try { return game.settings.get(SCOPE, "mechRoundTickAutomation") !== false; } catch { return true; }
}
/** Group 3 — document automation: chip grant/prune, loadout materialize/prune, delete-cascade detach (default ON). */
export function mechDocumentAutomationEnabled() {
  try { return game.settings.get(SCOPE, "mechDocumentAutomation") !== false; } catch { return true; }
}
/** Permission scoping — limb-recovery controls restricted to the GM (default ON; fail-closed). */
export function cyberlimbRepairGmOnly() {
  try { return game.settings.get(SCOPE, "cyberlimbRepairGmOnly") !== false; } catch { return true; }
}
/** Permission scoping — hide the two bulk-scraped base packs from players (default ON; fail-closed). */
export function hideScrapedPacks() {
  try { return game.settings.get(SCOPE, "hideScrapedPacks") !== false; } catch { return true; }
}

/** DOT stacking behavior for every damage-over-time payload: "stack" (default) / "reset" /
 *  "separate". One selector — replaced the identical acid/fire pair 2026-08-29 (settings-trim). */
export function dotStackMode() {
  try { return game.settings.get(SCOPE, "dotStackMode") || "stack"; } catch { return "stack"; }
}

/** Combat FX rail — muzzle flash light, shot audio, optional Sequencer sprites (default ON). */
export function faceTargetOnFireEnabled() {
  try { return game.settings.get(SCOPE, "faceTargetOnFire") !== false; } catch { return true; }
}

export function combatFxEnabled() {
  try { return game.settings.get(SCOPE, "combatFxEnabled") !== false; } catch { return true; }
}

