/**
 * Cyberpunk 2020: Augmented Edition — companion module entry point.
 *
 * Loads on top of the `cyberpunk2020` system and adds the Augmented features
 * (vehicles & ACPA / Maximum Metal, combat automation, shopping, IP tracking)
 * as opt-in overlays, WITHOUT modifying the base system. Mirrors the system's
 * own init/ready wiring shape: registration functions imported here and called
 * from Hooks.once('init'/'ready').
 */
import { registerAugmentedSettings, combatAutomationEnabled, ipHideUI, applyCarolingianSkinClass, applyScrapedPackVisibility } from "./settings.js";
import { registerAugmentedHandlebarsHelpers } from "./handlebars-helpers.js";
import { registerDamageHooks } from "./combat/damage-hooks.js";
import { registerGasCloudBehavior, registerGasCloudVisibilityDefault } from "./combat/gas-cloud-behavior.js";
import { registerSuppressiveZoneBehavior, registerSuppressiveZoneVisibilityDefault } from "./combat/suppressive-zone-behavior.js";
import { registerCoverZoneBehavior, registerCoverZoneVisibilityDefault } from "./combat/cover-zone-behavior.js";
import { registerCoverSocket, registerCoverTools, registerCoverWallConfig } from "./combat/cover.js";
import { registerSpreadZoneLook } from "./combat/spread-zone-look.js";
import { registerMovementGate } from "./combat/movement-gate.js";
import { registerSaveRollHandlers } from "./combat/save-rolls.js";
import { registerPopoutCompat } from "./popout-compat.js";
import { registerCardLock } from "./card-lock.js";
import { registerCombatFx } from "./fx/effects.js";
import { registerStatusFx } from "./fx/status-fx.js";
import { landTraumaTeam, endTraumaTeam, traumaTeamActive, traumaTeamState, registerTraumaTeam } from "./fx/trauma-team.js";
import { registerTraumaTeamTool } from "./fx/trauma-team-tool.js";
import { registerGroundFireClearTool, onGroundFireClearTool } from "./fx/ground-fire-tool.js";

// Vehicle / ACPA (Maximum Metal) sub-types — module-owned Actor/Item types, data in system.*.
import { CyberpunkVehicleActorData } from "./data/vehicle-actor-data.js";
import { CyberpunkVehicleWeaponData, CyberpunkAcpaSystemData, makeVehicleItemData } from "./data/vehicle-item-data.js";
import { CyberpunkVehicleSheet } from "./actor/vehicle-sheet.js";
import { CyberpunkAugmentedItemSheet } from "./item/augmented-item-sheet.js";
import { registerVehicleCanvasHooks, deployVehicleToScene, boardVehicle, disembark } from "./vehicle/vehicle-canvas.js";
import { registerVehicleDeploySocket, requestVehicleDeploy, createVehicleActorFromItem, registerCivilianSheetMigration } from "./vehicle/vehicle-deploy-request.js";
import { registerVehicleBoardingHud } from "./vehicle/vehicle-boarding-hud.js";
import { registerVehicleOccupancyHooks } from "./vehicle/vehicle-occupancy.js";
import { registerVehicleOutlineHooks } from "./vehicle/vehicle-outline.js";
import { registerVehicleRideHooks } from "./vehicle/vehicle-ride.js";
import { registerVehicleAboardBanner } from "./vehicle/vehicle-aboard-banner.js";
import { openControlRollDialog } from "./vehicle/vehicle-control.js";
import { openVehicleDamageDialog } from "./vehicle/vehicle-damage.js";
import { weaponToPenetration, vehicleToHitModifier, openVehicleFireDialog, registerVehicleFireHandlers } from "./vehicle/vehicle-weapons.js";
import { registerVehicleTargetingHandlers } from "./vehicle/vehicle-targeting.js";
import { registerMissileFlightHooks } from "./vehicle/vehicle-missile-flight.js";
import { openAcpaMeleeDialog, registerAcpaCombatHooks, repairAcpa } from "./vehicle/vehicle-acpa-combat.js";

// IP (Improvement Points) tracker — GM engine + tracker window; IP stored in module flags.
import { registerIpHooks } from "./ip/ip.js";
import { openIpTracker } from "./ip/tracker.js";

// Settings presets — the GM "Choose Preset" menu button (one-click playstyle tiers).
import { PresetPicker } from "./dialog/preset-picker.js";
import { registerPinnedSubwindows } from "./pin-window.js";
import { registerDataCorrections } from "./data-corrections.js";
import { makeMechAugmentedData, makeArmorAugmentedData } from "./data/mech-item-data.js";
import { makeAmmoAugmentedData } from "./data/ammo-item-data.js";
import { makeWeaponAugmentedData } from "./data/weapon-item-data.js";
import { registerMechLight } from "./mech/light.js";
import { registerMechVision, registerHeatSenseDetectionMode } from "./mech/vision.js";
import { registerMechConsumable } from "./mech/consumable.js";
import { registerSpeedware } from "./mech/speedware.js";
import { registerMechChipGrant } from "./mech/chip-grant.js";
import { registerMechContainer } from "./mech/container.js";
import { registerMechStatMods } from "./mech/stat-mods.js";
import { registerMechDrug } from "./mech/drug.js";
import { registerBorg } from "./mech/borg.js";
import { registerTypedArmorDisplay } from "./mech/typed-armor-display.js";
import { registerBookLegality } from "./combat/book-legality.js";
import { registerRadiation } from "./radiation/radiation.js";
import { registerRadiationZones, migrateLegacyRadZones } from "./radiation/radiation-zones.js";
import { registerVehicleHullMigration, migrateVehicleHullFrames } from "./vehicle/vehicle-hull-migration.js";
import { registerRadiationTools } from "./radiation/radiation-tools.js";
import { registerRadiationZoneBehavior, registerRadiationZoneVisibilityDefault } from "./radiation/radiation-zone-behavior.js";
import { registerMechCyberlimb, cyberlimbSdp } from "./mech/cyberlimb.js";
import { registerPaSkillBackfill } from "./mech/pa-skills.js";
import { registerPaCombatSense } from "./mech/pa-combat-sense.js";
import { registerMartialDefense } from "./martial/martial.js";
import { registerFreeFire } from "./mech/free-fire.js";
import { registerMechLoadout } from "./mech/loadout.js";
import { registerSeamShim } from "./seam-shim.js";
import { registerMartialIdResolutionShim } from "./martial/id-resolution-shim.js";
import { registerIconNormalizationShim } from "./icon-normalization-shim.js";
import { hostProvides } from "./system-api.js";
import { deleteFieldUpdate, localize, localizeParam } from "./utils.js";

// Diagnostics (module/dev/*) — two per-user checks, both default off, both costing nothing until a
// GM switches one on: the unusable-number tripwire on prepared documents, and the fault collector
// whose journal export turns a field report into a stack.
import { registerDevFieldAssertions } from "./dev/field-assertions.js";
import { registerDevErrorJournal, exportErrorJournal } from "./dev/error-journal.js";

// Shop / economy ([[shopping-design]]) — the sidebar cart opens a standalone catalog/shop window;
// the browse/buy engine + custom-shop curation live in module/shop/.
import { registerShopHooks, openShopWindow } from "./shop/catalog.js";
import { registerNpcGenHooks } from "./npcgen/npcgen-app.js";
// Full character/NPC + item sheets (Option B): on a host that doesn't ship the augmented sheets (his
// vanilla 1.1.1), the module REGISTERS our own V2 sheets as default — replacing ALL the old in-sheet
// injectors (martial panel / services / IP / cyberware-install button / martial-skill editor), which
// either rendered poorly on his foreign DOM or wrote fields his DataModel strips.
import { CyberpunkActorSheet } from "./actor/actor-sheet.js";
import { CyberpunkItemSheet } from "./item/item-sheet.js";

// Module flag / settings scope (per-file convention used across the module).
const SCOPE = "cp2020-augmented";
const SYSTEM_ID = "cyberpunk2020";

// Module-namespaced document sub-type ids (Foundry prefixes the manifest's bare keys with the id).
const VEHICLE_ACTOR  = `${SCOPE}.vehicle`;
const VEHICLE_WEAPON = `${SCOPE}.vehicleWeapon`;
const ACPA_SYSTEM    = `${SCOPE}.acpaSystem`;

/** Partial templates the sheets include via {{> path}} (must be preloaded for the includes to resolve). */
const AUGMENTED_TEMPLATES = [
  "modules/cp2020-augmented/templates/actor/vehicle-sheet.hbs",
  "modules/cp2020-augmented/templates/actor/vehicle-civilian-sheet.hbs",
  "modules/cp2020-augmented/templates/actor/acpa-sheet.hbs",
  "modules/cp2020-augmented/templates/actor/parts/countermeasures.hbs",
  "modules/cp2020-augmented/templates/actor/parts/vehicle-occupants.hbs",
  "modules/cp2020-augmented/templates/actor/parts/vehicle-layout.hbs",
  "modules/cp2020-augmented/templates/actor/parts/aboard-banner.hbs",
  // Augmented character/NPC actor sheet (Option B) + its parts. The {{> "modules/…/parts/X.hbs"}}
  // includes resolve as registered partials only once preloaded here.
  "modules/cp2020-augmented/templates/actor/actor-sheet.hbs",
  "modules/cp2020-augmented/templates/actor/parts/statsrow.hbs",
  "modules/cp2020-augmented/templates/actor/parts/woundtracker.hbs",
  "modules/cp2020-augmented/templates/actor/parts/status-strip.hbs",
  "modules/cp2020-augmented/templates/actor/parts/container-node.hbs",
  "modules/cp2020-augmented/templates/actor/parts/cyber-zone-node.hbs",
  "modules/cp2020-augmented/templates/actor/parts/skills.hbs",
  "modules/cp2020-augmented/templates/actor/parts/skill.hbs",
  "modules/cp2020-augmented/templates/actor/parts/combat.hbs",
  "modules/cp2020-augmented/templates/actor/parts/armor-display.hbs",
  "modules/cp2020-augmented/templates/actor/parts/conditional-armor.hbs",
  "modules/cp2020-augmented/templates/actor/parts/radiation-panel.hbs",
  "modules/cp2020-augmented/templates/actor/parts/armor-layers-panel.hbs",
  "modules/cp2020-augmented/templates/actor/parts/gear.hbs",
  "modules/cp2020-augmented/templates/actor/parts/services.hbs",
  "modules/cp2020-augmented/templates/actor/parts/cyberware.hbs",
  "modules/cp2020-augmented/templates/actor/parts/life.hbs",
  "modules/cp2020-augmented/templates/actor/parts/netrunning.hbs",
  // Tear-off tab window (CyberpunkActorTabSheet PART) — renders one tab body in its own window.
  "modules/cp2020-augmented/templates/actor/actor-tab-popout.hbs",
  // Augmented item sheet (Option B) + its standard-type parts + the Buy-Ammo dialog body.
  "modules/cp2020-augmented/templates/item/item-sheet.hbs",
  "modules/cp2020-augmented/templates/item/parts/weapon/summary.hbs",
  "modules/cp2020-augmented/templates/item/parts/weapon/settings.hbs",
  "modules/cp2020-augmented/templates/item/parts/armor/summary.hbs",
  "modules/cp2020-augmented/templates/item/parts/armor/settings.hbs",
  "modules/cp2020-augmented/templates/item/parts/skill/summary.hbs",
  "modules/cp2020-augmented/templates/item/parts/skill/settings.hbs",
  "modules/cp2020-augmented/templates/item/parts/cyberware/summary.hbs",
  "modules/cp2020-augmented/templates/item/parts/cyberware/settings.hbs",
  "modules/cp2020-augmented/templates/item/parts/ammo/summary.hbs",
  "modules/cp2020-augmented/templates/item/parts/ammo/settings.hbs",
  "modules/cp2020-augmented/templates/item/parts/program/summary.hbs",
  "modules/cp2020-augmented/templates/item/parts/program/settings.hbs",
  "modules/cp2020-augmented/templates/item/parts/misc/summary.hbs",
  "modules/cp2020-augmented/templates/item/parts/misc/settings.hbs",
  "modules/cp2020-augmented/templates/item/parts/vehicle/summary.hbs",
  "modules/cp2020-augmented/templates/item/parts/vehicle/settings.hbs",
  "modules/cp2020-augmented/templates/item/parts/vehicleWeapon/summary.hbs",
  "modules/cp2020-augmented/templates/item/parts/vehicleWeapon/settings.hbs",
  "modules/cp2020-augmented/templates/item/parts/acpaSystem/summary.hbs",
  "modules/cp2020-augmented/templates/item/parts/acpaSystem/settings.hbs",
  // Shop buyer strip — included by the catalog template and re-rendered on its own when the buyer
  // changes, which is why it is a partial at all (module/shop/catalog.js _cpSyncBuyer).
  "modules/cp2020-augmented/templates/shop/buyer-bar.hbs",
  // Shop filter drawer — mounted as a partial by three catalog views (catalog/build/storefront).
  "modules/cp2020-augmented/templates/shop/filter-drawer.hbs",
  // Shop list item strip — the windowed list's row markup, painted by the catalog template's include
  // AND by every scroll repaint (module/shop/catalog.js _renderRowsPartial), one template both ways.
  "modules/cp2020-augmented/templates/shop/catalog-rows.hbs",
  "modules/cp2020-augmented/templates/dialog/ip-neglect.hbs",
  "modules/cp2020-augmented/templates/dialog/preset-picker.hbs",
  "modules/cp2020-augmented/templates/dialog/preset-confirm.hbs",
  // Martial-arts chat fragments (the on-declare effect card).
  "modules/cp2020-augmented/templates/chat/martial-effect.hbs",
  // Drug dose card (carries the conditional full-conversion advisory clause).
  "modules/cp2020-augmented/templates/chat/drug-took.hbs",
  // Radiation dose subsystem cards (Deep Space): dose summary + interactive chance-of-death + result.
  "modules/cp2020-augmented/templates/chat/radiation-dose.hbs",
  "modules/cp2020-augmented/templates/chat/radiation-death-prompt.hbs",
  "modules/cp2020-augmented/templates/chat/radiation-death-result.hbs",
];

Hooks.once("init", function () {
  console.log(`${SCOPE} | Initializing Cyberpunk 2020: Augmented Edition`);

  registerAugmentedSettings();
  // GM-only "Settings Presets" menu button — applies one of the 4 playstyle tiers in one click.
  // Registered here (not settings.js) so settings.js stays free of foundry.applications imports, mirroring
  // the fork. See module/presets.js + dialog/preset-picker.js.
  game.settings.registerMenu(SCOPE, "presetMenu", {
    name: "SETTINGS.PresetMenuName",
    label: "SETTINGS.PresetMenuLabel",
    hint: "SETTINGS.PresetMenuHint",
    icon: "fa-solid fa-sliders",
    type: PresetPicker,
    restricted: true,
  });
  // Fault collector (module/dev/error-journal.js): registered here, near the top of init, because
  // the value of the thing is what it catches — the earlier its listeners are attached on a client
  // that already had the setting on, the more of a load-time fault it can hold. Default off, so on
  // every other client this is one setting registration and nothing else.
  registerDevErrorJournal();
  // Vendor the {{CPLocal}}/{{CPLocalParam}} localization helpers the module's templates use, so
  // they resolve without depending on the base system registering them (vanilla self-sufficiency).
  registerAugmentedHandlebarsHelpers();

  // Book-verified corrections to base-system compendium items (the packs can't be edited in place —
  // they're reinstalled on every system update). Copies created from a corrected compendium item get
  // the corrected data; the shop prices with it too. See module/data-corrections.js.
  registerDataCorrections();

  // Keep spawned child windows (confirm dialogs + the Attack Modifiers window) floating above the
  // ordinary window they were opened from, so clicking the parent never buries them. Idempotent: on a
  // base-system+module install the system already installed this wrap, so this call no-ops.
  registerPinnedSubwindows();

  // Register the module's vehicle/ACPA DataModels. Data lives in system.* of the sub-type
  // documents (no flags) — see module.json `documentTypes` for the manifest declaration.
  Object.assign(CONFIG.Actor.dataModels, { [VEHICLE_ACTOR]: CyberpunkVehicleActorData });
  // Capture the system's own vehicle model BEFORE we overwrite it (its init ran first), so the module's
  // richer model can EXTEND it rather than statically mirror it — future base fields + migrate then chain.
  const SystemVehicleData = CONFIG.Item.dataModels.vehicle;
  Object.assign(CONFIG.Item.dataModels, {
    [VEHICLE_WEAPON]: CyberpunkVehicleWeaponData,
    [ACPA_SYSTEM]:    CyberpunkAcpaSystemData,
    // Re-register the bare `vehicle` type with the richer module model (range/rangeUnit/speed.unit),
    // built to EXTEND the system's model. Module loads after the system, so this wins.
    vehicle:          makeVehicleItemData(SystemVehicleData),
    // Special-mechanics fields (SPECIAL-MECHANICS-PROPOSAL.md D1 — extend, don't flag): misc gear +
    // cyberware gain mechLight (P3 light emitters). Same extend-the-registered-model pattern.
    misc:             makeMechAugmentedData(CONFIG.Item.dataModels.misc),
    cyberware:        makeMechAugmentedData(CONFIG.Item.dataModels.cyberware),
    // Typed SP (fire/radiation/heat garments -- the D5 conditional-SP model): armor gains only the
    // mechTypedSP slot; misc/cyberware get it through makeMechAugmentedData above.
    armor:            makeArmorAugmentedData(CONFIG.Item.dataModels.armor),
    // Ammo two-axis fields (caliber/modifier/…): the base model strips them on vanilla, which broke
    // the caliber-scoped modifier picker. Extend it, adding only the fields the base lacks (no-op on
    // the fork). See module/data/ammo-item-data.js.
    ammo:             makeAmmoAugmentedData(CONFIG.Item.dataModels.ammo),
    // Melee weapon category flags the base model strips on vanilla (edged/mono armor-multiplier
    // inputs + the mono break-on-fumble `broken` flag). Extend it, adding only the missing fields
    // (no-op on a fork that declares them). See module/data/weapon-item-data.js.
    weapon:           makeWeaponAugmentedData(CONFIG.Item.dataModels.weapon),
  });

  // Actor icon repair: a legacy `system.icon` string without a recognized image extension makes
  // the whole actor fail validation at load ("unavailable" documents — the bug upstream PR #39
  // fixes). Wrap the actor data models' migrateData to coerce unusable values to "" before
  // validation. Self-disengaging: inert when the field isn't a strict FilePathField (hand-patched
  // or fork installs) or when the base carries the upstream normalizer. Init-time, before world
  // documents construct. See icon-normalization-shim.js.
  registerIconNormalizationShim();

  // Q7 personality moddies: wrap the actor's prepareData so stat mods with caps/combat context
  // apply on top of the base totals (prepareData, NOT prepareDerivedData — the base computes its
  // stats in prepareData; see the DataModel hazard note in data/mech-item-data.js). Wrapped at
  // INIT (before any actor prepares) so the first world-load prep already reflects them; also
  // wires the combat-context refresh hooks.
  registerMechStatMods();
  // Speedware activation clock: wrap the ITEM's prepareData so an activated initiative boost reads as
  // carrying its printed duration, which is what hands it to the P7 timer already wired at ready.
  // Read-time only — nothing is written to the item or its pack entry. Init-time because the wrap must
  // be in place before any item prepares, and on the ITEM because the actor's stat pass consumes it
  // (Foundry prepares embedded items inside the actor's own super.prepareData()).
  registerSpeedware();
  // D4 combat drugs: wrap prepareData (AFTER the Q7 wrap above, so active-drug boosts overlay last)
  // and wire the round-tick that expires timed drugs. Init-time for the same first-prep reason.
  registerMechDrug();
  // Full-conversion borgs: wrap prepareData to seed the borg body's per-zone SDP into system.sdp
  // (independent of the stat wraps above — touches sdp, not stats). Init-time for the same reason.
  registerBorg();
  // Book-legality enforcement: wrap prepareData so the armor layer law reaches the numbers (the panel
  // follows the legal fold, the 2nd/3rd counted layer charge their EV) and the boost family limit
  // holds, plus the equip-time notices that name the rule. Registered AFTER registerBorg (the chassis
  // SP is folded in by _deriveLiveSP itself — running earlier would double-count) and BEFORE the typed
  // display below, which re-derives the same panel from the same source. Never blocks an equip.
  registerBookLegality();
  // Honest conditional-armor display: wrap prepareData to re-derive the armor panel from the damage
  // system's own type-aware SP (so a fire-only garment stops inflating the panel vs bullets) and build
  // system.conditionalSP for the per-damage-type sub-panel. Registered AFTER registerBorg so it runs
  // after the borg chassis-SP seed (see typed-armor-display.js). Init-time for the first-prep reason.
  registerTypedArmorDisplay();
  // Deep Space radiation dose subsystem: wrap prepareData for the radiation stat-loss overlay, wire the
  // chance-of-death button + the per-round dose tick, and install the radiation-zone hooks. Registered
  // AFTER registerMechDrug so the overlay stacks on the drug boosts (order base → moddy → drug → radiation).
  // No feature toggle: every passive path no-ops until a GM places a zone or applies a dose.
  // Radiation zones are native Regions carrying a custom "Radiation Zone" behavior: register the behavior
  // TYPE here at init (before scenes load — the manifest declares it under documentTypes.RegionBehavior),
  // plus the hook that defaults a fresh rad-zone region to GM-visible.
  registerRadiationZoneBehavior();
  registerRadiationZoneVisibilityDefault();
  // Gas clouds ride the same native-region rail on v14: spawned clouds (damage-hooks.js) attach the
  // "Gas Cloud" behavior so the GM manages them with region tools, and a GM can hand-author one too.
  registerGasCloudBehavior();
  registerGasCloudVisibilityDefault();
  // Suppressive-fire lanes: the first EVENT-driven behavior (native token-enter triggers the evasion
  // save via the module hook seam; damage-hooks.js listens). Player-visible by ruling — hand-authored
  // lanes default to ALWAYS; the placement-forward spawn sets ALWAYS in its creation data.
  registerSuppressiveZoneBehavior();
  registerSuppressiveZoneVisibilityDefault();
  // Cover zones (fourth zone vertical — passive/queried; the damage dialog reads them, the
  // applicator chews them). Placement = GM scene tool + native Region tools.
  registerCoverZoneBehavior();
  registerCoverZoneVisibilityDefault();
  registerCoverSocket();
  registerCoverTools();
  // Unit 3: native Wall documents carry the same cover data via flags; the fields live on the
  // native Wall configuration sheet, and flagged walls join the damage dialog's cover picker.
  registerCoverWallConfig();
  // Shot patterns (buckshot / flechette) are drawn as a ghost rather than as core's half-opaque hatched
  // slab. UNCONDITIONAL, like the FX rail: it only ever touches a region carrying our own isSpreadZone
  // flag, so it costs a flag read per region draw and changes nothing else on the scene.
  registerSpreadZoneLook();
  registerRadiation();
  registerRadiationZones();
  // R3b GM tools: the apply-dose / environmental scene-control buttons (shown to a GM while radiation is
  // enabled). Zone placement is native (draw a Region + add the behavior). Per-actor panel controls are
  // wired by the actor sheet itself.
  registerRadiationTools();
  // The medical-extraction arrival control. Same idiom again: one momentary button on the token group,
  // referee-only, and the button IS the opt-in — nothing in this feature runs until one is pressed.
  registerTraumaTeamTool();
  // The ground-fire clear control — the same idiom a third time, and the other half of the
  // `groundFirePersistent` setting: flames that do not burn out on their own need something that puts
  // them out. Referee-only, momentary, and it acts on the census the FX rail already keeps.
  registerGroundFireClearTool();
  // Cyberlimb install lifecycle: a structural implant equipping into a zone clears that zone's
  // sticky limb state (a NEW limb must not inherit the wound recorded against the meat or the
  // wreck it replaces).
  registerMechCyberlimb();
  // Offered contested defense: the delegated click wiring for the martial defense-offer/result
  // chat cards (the roll is the defender's choice; the outcome is the GM's adjudication).
  registerMartialDefense();
  // Free Fire (the ammo-tracking opt-out) on vanilla: the Modifiers-window row + the keep-topped
  // magazine hook that bypasses the base's hardcoded consumption from outside.
  registerFreeFire();
  // Field assertions (module/dev/field-assertions.js): the LAST prepareData wrap registered at init,
  // deliberately. Each wrap calls the one registered before it and then runs its own post-step, so
  // the one registered last is outermost and reads the numbers every other post-step has finished
  // writing — which is the state a sheet renders. Default off; when off the wrapper reads one cached
  // boolean and returns.
  registerDevFieldAssertions();

  // Register the vehicle/ACPA actor sheet for the module sub-type. v15-readiness: use the
  // namespaced collection, falling back to the bare global on cores that lack it (v13).
  const _Actors = foundry?.documents?.collections?.Actors ?? Actors;
  _Actors.registerSheet(SCOPE, CyberpunkVehicleSheet, { types: [VEHICLE_ACTOR], makeDefault: true });

  // Item sheet for the module's vehicle/ACPA sub-type items. A type-specific makeDefault wins over
  // the base system's typeless makeDefault item sheet (which can't render a namespaced sub-type).
  const _Items = foundry?.documents?.collections?.Items ?? Items;
  _Items.registerSheet(SCOPE, CyberpunkAugmentedItemSheet, { types: [VEHICLE_WEAPON, ACPA_SYSTEM], makeDefault: true });

  // Augmented character/NPC actor sheet (Option B). Register our full V2 sheet and make it default —
  // UNLESS the host already ships the augmented sheet (our own fork declares features.actorSheet, so
  // the fork's sheet stays default and the module does not double-register).
  if (!hostProvides("actorSheet")) {
    _Actors.registerSheet(SCOPE, CyberpunkActorSheet, {
      types: ["character", "npc"],
      makeDefault: true,
      label: "CYBERPUNK.SheetAugmentedActor",
    });
    // The augmented actor sheet is now the world default, overriding whatever the host ships. On stock
    // 1.1.1 the host has only a V1 sheet; a future host V2 sheet (Tilt 1.2.0) would NOT set
    // features.actorSheet (that flag lives only in the fork PRs), so we still win here — log it so the
    // override is visible, not silent. MAINTENANCE: revisit integrating the augmented panels into a
    // host V2 sheet rather than replacing it. (C3)
    console.info(`${SCOPE} | Registered the augmented actor sheet as world default (overriding the host default sheet).`);
  }

  // Augmented item sheet (Option B). Register our full V2 item sheet for the BASE item types and make
  // it default — UNLESS the host already ships it (fork declares features.itemSheet). The module's own
  // CyberpunkAugmentedItemSheet keeps the vehicleWeapon/acpaSystem sub-types (registered just above).
  if (!hostProvides("itemSheet")) {
    _Items.registerSheet(SCOPE, CyberpunkItemSheet, {
      types: ["weapon", "armor", "skill", "cyberware", "ammo", "program", "vehicle", "misc"],
      makeDefault: true,
      label: "CYBERPUNK.SheetAugmentedItem",
    });
    // Same override + visibility log as the actor sheet above; same 1.2.0 maintenance note. (C3)
    console.info(`${SCOPE} | Registered the augmented item sheet as world default (overriding the host default sheet).`);
  }

  // Preload the wrapper sub-templates the sheet includes as Handlebars partials.
  const loadTemplates = foundry?.applications?.handlebars?.loadTemplates ?? globalThis.loadTemplates;
  loadTemplates?.(AUGMENTED_TEMPLATES);

  // Heat-sense detection mode (P4 upgrade, Q1c): registered at init so it exists before any
  // canvas builds; the vision engine adds/removes the token detectionModes entries at apply time.
  registerHeatSenseDetectionMode();

  // Vehicle canvas: tile→token+crew movement coupling. Type-discriminated on the module sub-type,
  // so it coexists with the system's own vehicle-canvas hook (each fires only for its own type).
  registerVehicleCanvasHooks();
  // Item→actor deploy requests (player asks, active GM approves + creates) and the
  // embark/disembark token-HUD gesture.
  registerVehicleDeploySocket();
  registerVehicleBoardingHud();
  // Occupancy badge on the handle + the client-local occupant fade; and the "aboard" strip on a
  // rider's own character sheet. Both are presentation only — no document writes.
  registerVehicleOccupancyHooks();
  registerVehicleOutlineHooks();
  // Riders are DRAWN at their seat on every frame the vehicle is drawn, so a moving car never
  // appears to shake its crew loose. Presentation only, per client, no writes.
  registerVehicleRideHooks();
  registerVehicleAboardBanner();
  // One-time stamp: pre-civilian-split vehicle actors keep the MM combat sheet.
  registerCivilianSheetMigration();
  // One-time hull/frame split: a vehicle's shape moves onto the actor and its token becomes the
  // square that carries it at any angle. Registers the stamp pair here; the sweep runs at ready.
  registerVehicleHullMigration();

  // Public API surface for macros and other modules. Mirrors the system's game.cyberpunk.vehicles
  // shape under the module's own namespace so it never clobbers the system API.
  game.cpAugmented = {
    vehicles: {
      deploy: deployVehicleToScene, board: boardVehicle, disembark,
      requestDeploy: requestVehicleDeploy, createFromItem: createVehicleActorFromItem,
      controlRoll: openControlRollDialog, applyDamage: openVehicleDamageDialog,
      weaponToPen: weaponToPenetration, toHitMod: vehicleToHitModifier, fire: openVehicleFireDialog,
      acpaMelee: openAcpaMeleeDialog, acpaRepair: repairAcpa,
    },
    // IP tracker API: open the GM Improvement-Points tracker.
    ip: { openTracker: openIpTracker },
    // The medical-extraction arrival sequence, for a macro that would rather name a point than click
    // one. Referee-only inside, exactly as the scene control is. `land` takes a canvas point
    // ({x, y}); `end` sends it away; `active`/`state` answer what is on station.
    traumaTeam: {
      land: landTraumaTeam, end: endTraumaTeam,
      active: traumaTeamActive, state: traumaTeamState,
    },
    // Shop API: open the shop window (the sidebar cart is the primary entry point).
    shop: { open: openShopWindow },
    // Presentation rail: put out the ground fires burning on the viewed scene. The macro path for the
    // token-controls button, behind the same referee gate the control is (an API is a door too), and
    // it reports what it did by value: `{cleared}` — or `{skipped: "permission"}` for a player.
    fx: { clearGroundFires: onGroundFireClearTool },
    // Diagnostics: write the fault collector's ring into a journal entry a GM can read and keep.
    // The setting's hint names this call, so a GM who switched the collector on already has it.
    exportErrorJournal,
    // Manual re-run entry points for the one-time world migrations. Each of those passes carries two
    // stamps — one written before the sweep to bound the first attempt's cost, one written after it
    // finishes — so a run that dies part-way IS retried on its own at the next load. These calls are
    // how a GM asks for that retry immediately, and how a GM upgrades content imported after the
    // world was first migrated. Both default to running regardless of the stamps; pass
    // `{ force: false }` for the boot behaviour (run only if the pair says the sweep still owes one).
    migrations: {
      fleshLimbStatus: (opts) => migrateFleshLimbStatus({ force: true, ...(opts ?? {}) }),
      legacyRadZones: (opts) => migrateLegacyRadZones({ force: true, ...(opts ?? {}) }),
      vehicleHullFrames: (opts) => migrateVehicleHullFrames({ force: true, ...(opts ?? {}) }),
    },
  };
  const mod = game.modules.get(SCOPE);
  if (mod) mod.api = game.cpAugmented;
});

/**
 * One-time, self-gating settings migrations mirroring the fork's setting merges (the module has no
 * migrate.js). Reads each orphaned legacy key from world storage, writes the merged value once, then
 * deletes the legacy doc so it never re-runs. Safe to fail — settings just keep their defaults.
 */
async function migrateAugmentedSettings() {
  const rawSetting = (key) => {
    try {
      const doc = game.settings?.storage?.get?.("world")?.find?.((s) => s.key === `${SCOPE}.${key}`);
      if (!doc || doc.value === undefined || doc.value === null) return undefined;
      let v = doc.value;
      if (typeof v === "string") { try { v = JSON.parse(v); } catch (e) { /* bare string */ } }
      return v;
    } catch (e) { return undefined; }
  };
  const dropLegacy = async (key) => {
    const doc = game.settings?.storage?.get?.("world")?.find?.((s) => s.key === `${SCOPE}.${key}`);
    if (doc) await doc.delete();
  };

  // limbCripplingDetailed → limbModel (Listen Up when it was on, else Core). w4rst4rLimbRules was never
  // registered here, so there's nothing to migrate from it.
  const lcd = rawSetting("limbCripplingDetailed");
  if (lcd !== undefined && rawSetting("limbModel") === undefined) {
    const model = lcd === true ? "listenup" : "core";
    await game.settings.set(SCOPE, "limbModel", model);
    await dropLegacy("limbCripplingDetailed");
    console.log(`${SCOPE} | limb-model migrated from limbCripplingDetailed → "${model}".`);
  }

  // ipSystem (3-way) → ipRawTracking (behaviour) + ipHideUI (presence). The dual-bucket flag DATA
  // (per-skill `ip` + actor `ipPool`) already exists, so there's no per-actor data migration — only
  // this setting remap: disabled → hide the UI; raw → RAW auto-tracking on; simple → neither.
  const ipOld = rawSetting("ipSystem");
  if (ipOld !== undefined) {
    if (ipOld === "raw" && rawSetting("ipRawTracking") === undefined) await game.settings.set(SCOPE, "ipRawTracking", true);
    if (ipOld === "disabled" && rawSetting("ipHideUI") === undefined) await game.settings.set(SCOPE, "ipHideUI", true);
    await dropLegacy("ipSystem");
    console.log(`${SCOPE} | IP setting migrated: ipSystem "${ipOld}" → rawTracking=${ipOld === "raw"}, hideUI=${ipOld === "disabled"}.`);
  }

  // damageAutoApply → RETIRED, nothing to merge into. The feature is gone (user ruling 2026-08-14):
  // whether a given instance of damage is applied is answered in that instance's confirmation window,
  // not by a world-wide rule. There is no successor key and no value worth carrying — a world that had
  // it TRUE simply starts seeing windows again, which is the ruled outcome. All this does is drop the
  // orphaned world doc so the setting universe carries no key nothing registers. Self-gating (the doc
  // only exists once), a no-op on a fresh world, and no version bump — the same shape as the merges
  // above, minus the merge.
  if (rawSetting("damageAutoApply") !== undefined) {
    await dropLegacy("damageAutoApply");
    console.log(`${SCOPE} | retired setting dropped: damageAutoApply (every damage resolution now opens its own confirmation window).`);
  }
}

/**
 * One-time, GM-only world migration for the M18 flesh/structural limb-state split. Before M18 both
 * kinds of limb wound shared `flags.cp2020-augmented.limbStatus`; the flesh models now write a
 * separate `fleshLimbStatus`, but any state a pre-M18 build persisted still sits under the old shared
 * key and is misread as structural cyberlimb state. This pass moves every `limbStatus` entry whose
 * zone carries NO structural SDP pool into `fleshLimbStatus` and deletes it from the old key (through
 * deleteFieldUpdate — the deletion form follows the core running NOW, which is what the write has to
 * satisfy, not the vintage of the data being migrated); zones that DO carry a structural pool (a
 * real cyberlimb / borg chassis) keep their
 * `limbStatus` untouched. World actors AND unlinked scene-token actor deltas are both swept. Guarded
 * by a PAIR of world stamps (see the block above the first write below) so it runs to completion
 * exactly once. Safe to fail — a missed actor just keeps its old flags.
 *
 * `force` re-runs the sweep with both stamps already set — the manual re-run path exposed as
 * `game.modules.get("cp2020-augmented").api.migrations.fleshLimbStatus()`.
 */
async function migrateFleshLimbStatus({ force = false } = {}) {
  const DONE = "fleshLimbStatusMigrated";
  const COMPLETED = `${DONE}Completed`;
  for (const key of [DONE, COMPLETED]) {
    if (!game.settings.settings.has(`${SCOPE}.${key}`)) {
      game.settings.register(SCOPE, key, { scope: "world", config: false, type: Boolean, default: false });
    }
  }
  const attempted = game.settings.get(SCOPE, DONE);
  const completed = game.settings.get(SCOPE, COMPLETED);
  if (!force && attempted && completed) return;
  /** Boot found an attempt that never recorded finishing — this run is the retry. */
  const recovering = !force && attempted && !completed;

  // "Has a structural pool" reuses cyberlimb.js's own SDP helper, so the decision matches the damage
  // routing exactly (borg Head/Torso count too — their status is structural and must NOT move).
  const migrateActor = async (actor) => {
    const old = actor?.flags?.[SCOPE]?.limbStatus;
    if (!old || typeof old !== "object") return;
    const flesh = { ...(actor.flags?.[SCOPE]?.fleshLimbStatus ?? {}) };
    const update = {};
    let moved = false;
    for (const [zone, state] of Object.entries(old)) {
      if (!state || cyberlimbSdp(actor, zone).max > 0) continue;   // structural pool → leave as-is
      flesh[zone] = state;
      Object.assign(update, deleteFieldUpdate(`flags.${SCOPE}.limbStatus.${zone}`));
      moved = true;
    }
    if (!moved) return;
    update[`flags.${SCOPE}.fleshLimbStatus`] = flesh;
    await actor.update(update, { render: false })
      .catch((e) => console.warn(`${SCOPE} | flesh-status migration failed for actor ${actor.id}`, e));
  };

  // ⭐ TWO STAMPS: ONE BOUNDS THE ATTEMPT, THE OTHER RECORDS THE FINISH.
  //
  // `fleshLimbStatusMigrated` is still written BEFORE the sweep, for its original reason. Reading
  // `token.actor` on an unlinked token materializes that token's synthetic actor, so this sweep used
  // to build one for every unlinked token on every scene in the world — the largest single burst
  // this module produced at load. Stamped only on success, any throw — or a browser that died under
  // the burst before finishing — left it unset, so the whole burst repeated on every boot of that
  // world forever. Stamped first, the full-cost first attempt happens once.
  //
  // `fleshLimbStatusMigratedCompleted` is written AFTER the sweep returns without throwing, and it
  // is what makes the pass SELF-HEALING. The migration rehearsal (2026-08-19) reproduced the hazard
  // the single-stamp shape carried: a client that dies between the `ready` hook and the end of the
  // sweep — Foundry's first authenticated join after a server boot does exactly that on the rigs —
  // left the stamp set with the sweep never run. That world was then permanently unmigrated, and the
  // only evidence was a console.error in a session that no longer existed. So a boot that finds the
  // first stamp set and this one unset runs the sweep AGAIN and stamps this one on success.
  // What makes the retry affordable is the delta peek in the token loop below: the expensive thing
  // was building synthetic actors for tokens with nothing to move, and the peek no longer builds
  // them, so a repeat over a world with nothing left to migrate is ~1 ms (rehearsal-measured). The
  // old cost argument for never retrying is obsolete.
  //
  // CONSEQUENCE FOR WORLDS AN EARLIER BUILD ALREADY MIGRATED: they carry the first stamp set and no
  // second stamp, so the first boot on this build runs exactly one recovery sweep. It is
  // delta-peeked, it MOVES NOTHING on a world whose entries are already split, and it stamps
  // completion — from the next boot on they are gated exactly as before. No data is rewritten.
  if (recovering) {
    console.warn(
      `${SCOPE} | recovering the flesh-limb-status migration: it is marked as attempted but never `
      + `recorded finishing, so it is running once more now. It is idempotent — on a world that was `
      + `already migrated it moves nothing.`);
  }
  await game.settings.set(SCOPE, DONE, true);
  try {
    for (const actor of game.actors ?? []) await migrateActor(actor);
    for (const scene of game.scenes ?? []) {
      for (const token of scene.tokens ?? []) {
        if (token.actorLink) continue;      // linked tokens share the world actor migrated above
        // Peek at the RAW delta data before touching `token.actor` — that getter is what builds the
        // synthetic actor (the whole document, every embedded item, validated), and a profiled field
        // world showed this loop spending 25+ unbroken seconds doing exactly that for thousands of
        // tokens that had nothing to migrate. The old key can only exist token-side if the token's
        // own DELTA carries it (a synthetic actor's flag writes land on the delta); a delta without
        // it has nothing token-level to move — whatever shows through came from the base actor,
        // which the world-actor sweep above has already migrated. Plain object read, no construction.
        if (!token.delta?._source?.flags?.[SCOPE]?.limbStatus) continue;
        await migrateActor(token.actor);    // the unlinked token's synthetic delta actor
      }
    }
    await game.settings.set(SCOPE, COMPLETED, true);
    console.log(`${SCOPE} | flesh-limb-status migration complete.`);
  } catch (e) {
    console.error(
      `${SCOPE} | the flesh-limb-status migration stopped part-way. Actors it had not reached yet keep `
      + `their pre-split limb flags. Completion was not recorded, so the next load of this world runs it `
      + `once more on its own. A GM can also re-run it immediately from a script macro: `
      + `game.modules.get("${SCOPE}").api.migrations.fleshLimbStatus()`, e);
  }
}

/**
 * ⭐ WHY THE READY WIRING IS ISOLATED STEP BY STEP.
 *
 * Every register* call below is INDEPENDENT of the others — the presentation rail does not need the
 * loadout engine, the seam does not need the sheet skin. But they all run inside ONE synchronous
 * `ready` listener, so before this helper existed the FIRST step to throw ended the listener and
 * every step after it silently never registered. There was no error about the missing features, only
 * about the step that threw; the rest simply were not there.
 *
 * That is not theoretical. Reported from the table twice in one evening: a client whose shots
 * produced an attack roll and a magazine decrement and NOTHING else — no damage application, no
 * muzzle flash, no sound — while every other client on the same world drew that same shot perfectly.
 * A reload cured it. That is this shape exactly: the base system's fire flow is untouched by us and
 * kept working, while the entire Augmented layer below the throwing step was absent. Whether the
 * trigger is a slow client, a busy main thread, or a browser extension holding up the load, the
 * defect is ours — twenty independent features had no business sharing one failure.
 *
 * With this, a step that throws costs its own feature and names itself, and the nineteen after it
 * still register. `wiringFailures` collects the names for the readiness audit at the bottom of the
 * file, which is what tells the GM out loud.
 */
const wiringFailures = [];
function wire(step, register) {
  try {
    register();
  } catch (e) {
    wiringFailures.push(step);
    console.error(`${SCOPE} | ready wiring: "${step}" failed to register (its feature is inactive this session)`, e);
  }
}
/** Set at the very end of the ready listener; the audit below reads it to tell "finished" from "stopped". */
let wiringComplete = false;

Hooks.once("ready", function () {
  // Hard guard: the Augmented Edition only works on the cyberpunk2020 system.
  if (game.system.id !== SYSTEM_ID) {
    console.error(`${SCOPE} | requires the ${SYSTEM_ID} system; current system is "${game.system.id}".`);
    ui.notifications?.error(game.i18n.localize("CYBERPUNK.Augmented.WrongSystem"));
    return;
  }

  // No host-API guard: the module's shared helpers (i18n / chat / lookups / constants / dice via
  // module/system-api.js apiHelper, and schema via the local schema-helpers) PREFER game.cyberpunk.api
  // when the base system exposes it, else fall back to the module's own local copies — so the module
  // runs on a stock (API-less) base too, and self-upgrades to the system's helpers the moment they
  // appear. The hooks it relies on are bridged the same self-disengaging way (registerSeamShim below).

  // One-time settings migrations (GM-only, self-gating, no version bump). The module has no migrate.js,
  // so the fork's setting-merge migrations live here. Each reads the orphaned legacy key straight from
  // world storage, writes the merged value once, then deletes the legacy doc so it never re-runs.
  if (game.user?.isGM) migrateAugmentedSettings().catch((e) => console.warn(`${SCOPE} | settings migration failed`, e));
  // One-time flesh/structural limb-state flag split (M18) — moves stale pre-split entries off the
  // shared key so they stop reading as structural state. World-flag-gated; GM applies.
  if (game.user?.isGM) migrateFleshLimbStatus().catch((e) => console.warn(`${SCOPE} | flesh-limb-status migration failed`, e));
  // One-time vehicle hull/frame split — records each vehicle's own shape and squares its token frame,
  // which is also what stops a pre-split vehicle driving with its longest face leading. Stamp-gated
  // and self-healing; the GM applies.
  if (game.user?.isGM) migrateVehicleHullFrames().catch((e) => console.warn(`${SCOPE} | vehicle hull/frame migration failed`, e));

  // P3 light emitters + P4 vision devices: item toggles drive the bearer's token light/sight
  // (the active GM applies the token writes).
  wire("mech light", registerMechLight);
  wire("mech vision", registerMechVision);
  // P7 timed consumables: dose gate on activation + the per-turn timer tick.
  wire("mech consumable", registerMechConsumable);
  // Q2 chip skill grants: an active chip naming a skill the actor lacks creates it (RAW: chips
  // work untrained); the choose-chips prompt for the skill. Initiating-client/owner writes.
  wire("mech chip grant", registerMechChipGrant);
  // Q6 containers: uninstall cascade — deleting a container detaches its children to loose gear.
  wire("mech container", registerMechContainer);
  // Loadouts: a body carrying a `loadout` manifest (e.g. a full 'borg) materializes its prebuilt
  // options as real cyberware on install, and removes them on uninstall/delete. Initiating-owner writes.
  wire("mech loadout", registerMechLoadout);
  // PA (Powered Armor) skills: linking a character as an ACPA suit's pilot backfills the three Maximum
  // Metal powered-armor skills (PA Combat Sense / PA Tech / Expert (PA Design)) at level 0 from the
  // module skills compendium. Idempotent; only the initiating client that owns the pilot writes.
  wire("PA skill backfill", registerPaSkillBackfill);
  // PA Combat Sense (MM p.52–53) pilot-side bonuses: a Trooper's OWN initiative gains ½ his PA Combat
  // Sense (out-of-suit) via a Combatant init-roll override, and his Awareness/Notice rolls gain full PACS
  // while piloting an ACPA via a rollSkill wrap. In-suit full initiative + Solo-suppression already ship.
  wire("PA combat sense", registerPaCombatSense);

  // First-run only: offer the settings-preset picker once for a new GM (mirrors the system's own
  // first-run picker). The flag flips immediately so the picker never reappears on later loads; the
  // GM can reopen it from the System Settings "Settings Presets" menu. Guarded so a hiccup is non-fatal.
  if (game.user?.isGM) {
    try {
      if (!game.settings.get(SCOPE, "presetFirstRunDone")) {
        game.settings.set(SCOPE, "presetFirstRunDone", true);
        new PresetPicker().render(true);
      }
    } catch (e) {
      console.warn(`${SCOPE} | first-run preset picker failed (open it from System Settings)`, e);
    }
  }

  // Apply the terminal sheet skin's <body> class, following Foundry's applications colour scheme
  // (dark = the module's own look, light = the base system's), and start the class-list observer
  // that tracks a live scheme change. Client-side cosmetic, so it runs independently of the
  // combat-automation gate below.
  wire("terminal skin class", applyCarolingianSkinClass);

  // Player-facing exposure scoping for the base system's two bulk-scraped weapon compendiums
  // (pistols-add / rifles-add): while `hideScrapedPacks` is on (default), their PLAYER/TRUSTED pack
  // ownership is set to NONE so they leave the players' Compendium sidebar. Re-asserted here on every
  // load by the ACTIVE GM client only (a world setting is a GM-only write); the prior ownership is
  // snapshotted before the first change and restored when the setting is turned off. Self-guarded.
  wire("scraped-pack visibility", applyScrapedPackVisibility);

  // TEMPORARY seam shim: emit the weaponFired / skillRolled hooks the module relies on, but ONLY while
  // the base system lacks native emission (the seam PRs aren't merged). Self-disengages the instant the
  // base system emits them — including on a fork+module install (the fork emits natively). See seam-shim.js.
  wire("seam shim", registerSeamShim);

  // Martial-art id-resolution repair: the base system recovers a skill's canonical compendium id
  // only from the legacy flags.core.sourceId, so styles dragged onto a sheet under Foundry v12+
  // lose their Key-Attack bonuses (and a level-0 seeded row can shadow a leveled dragged copy).
  // The candidate half self-disengages when the base reads _stats.compendiumSource itself (the
  // pending upstream fix). See martial/id-resolution-shim.js.
  wire("martial id-resolution shim", registerMartialIdResolutionShim);

  // combatAutomationEnabled is the master gate for the Augmented combat layer (damage application,
  // saves, area effects, combat-tracker controls, vehicle/ACPA weapon fire + targeting + missiles);
  // each individual behaviour is further gated by its own setting. ADDITIONALLY, each feature layer
  // stands down when the host system already provides it (hostProvides → game.cyberpunk.api.features),
  // so the module never double-registers a feature the base absorbed — e.g. two weaponFired listeners
  // applying damage twice. An absent features map reads false, so vanilla behaviour is unchanged.
  // See system-api.js + Data/_seamwork/FOLLOWUP-cherrypick-hardening.md.
  const doCombat   = combatAutomationEnabled() && !hostProvides("combatAutomation");
  const doVehicles = combatAutomationEnabled() && !hostProvides("vehicles");
  // PopOut! chat rebinding registers UNCONDITIONALLY: the delegated chat-card listeners (drug
  // wear-off, martial defense offer/result) register at init regardless of the combat gate, so
  // their PopOut rebinding must too. Inert when PopOut! is absent.
  wire("PopOut! chat rebinding", registerPopoutCompat);
  // One-shot chat-card lock (render pass + GM stamp-relay + severable re-arm). UNCONDITIONAL, like the
  // PopOut rebinding above: the prompt cards it locks (saves, drug/rad checks, martial defense) post
  // regardless of the combat gate, so the lock must be live regardless too.
  wire("chat-card lock", registerCardLock);
  // Combat FX rail (muzzle flash light + shot audio, optional Sequencer/JB2A sprites). UNCONDITIONAL
  // for the same reason as the two above: it is presentation of a shot the base system resolved, not
  // automation, so it must run even where the combat-automation layer stands down. Its own world
  // setting (combatFxEnabled) is read per event, so the switch applies without a reload.
  wire("combat fx rail", registerCombatFx);
  // Persistent condition overlays. Unconditional for the same reason and gated by the same world
  // setting (combatFxEnabled), read per event: it is presentation of a condition something else
  // already applied, so it must run wherever that condition can reach a figure.
  wire("condition overlays", registerStatusFx);
  // The medical-extraction arrival sequence. Unconditional and gated by the same world setting, read
  // per event, for the same reason as the two above: it is presentation a referee asked for by hand,
  // it writes nothing, and its listeners are inert until a control is pressed.
  wire("extraction arrival sequence", registerTraumaTeam);
  if (doCombat) {
    wire("damage hooks", registerDamageHooks);
    wire("movement gate", registerMovementGate);
    wire("save-roll handlers", registerSaveRollHandlers);
  }
  if (doVehicles) {
    // Vehicle / ACPA combat handlers (chat-button + per-round flight + crit hooks).
    wire("vehicle fire handlers", registerVehicleFireHandlers);
    wire("vehicle targeting handlers", registerVehicleTargetingHandlers);
    wire("missile flight hooks", registerMissileFlightHooks);
    wire("ACPA combat hooks", registerAcpaCombatHooks);
  }

  // IP (Improvement Points) tracker — independent of the combat layer; the auto-queue self-gates on
  // ipRawTracking (RAW mode only), the in-sheet UI on ipEnabled (= !ipHideUI).
  const doIp = !hostProvides("ip");
  if (doIp) {
    wire("IP tracker hooks", registerIpHooks);
    // (Option B) The in-sheet IP UI now ships with our registered actor sheet — the old
    // renderCyberpunkActorSheet injector is removed (it rendered poorly on the base system's DOM).
  }

  // Shopping layer — independent of the combat layer; each self-gates on shoppingEnabled.
  const doShopping = !hostProvides("shopping");
  if (doShopping) {
    // (Option B) The cyberware "Install (Surgery)" button now ships with our registered ITEM sheet and
    // the Recurring Services tab with our registered actor sheet — both in-sheet injectors are removed
    // (services dumped into his Gear tab; install is native on our item sheet now).
    // Sidebar cart button + chat links + live buyer sync + the GM stock-decrement relay.
    wire("shop hooks", registerShopHooks);
  }

  // NPC generator — a GM tool that does nothing until a GM opens it and presses Generate, so it needs
  // no automation gate of its own; the master setting only decides whether its directory button exists.
  // It rides the shop's catalog index for gear, but registers independently: a shop layer the host
  // provides does not take the generator with it.
  wire("NPC generator", registerNpcGenHooks);

  // Martial-arts layer (Option B): martial features now ship entirely with our registered sheets — the
  // combat-tab panel via the actor sheet, and the skill martial-art editor via the item sheet (skill
  // type, writing flags.cp2020-augmented.* because his skill DataModel lacks isMartialArt/martialBonuses).
  // Both renderCyberpunk*Sheet injectors are removed; nothing to register at ready (the gate var is kept
  // for the readiness log).
  const doMartial = !hostProvides("martial");

  console.log(`${SCOPE} | Ready (on ${SYSTEM_ID} v${game.system.version}); layers: ` +
    `combat=${doCombat} vehicles=${doVehicles} ip=${doIp} shopping=${doShopping} martial=${doMartial}`);
  wiringComplete = true;
});

/**
 * THE READINESS AUDIT — a SECOND, deliberately tiny `ready` listener.
 *
 * It is separate on purpose. Foundry calls each hook listener inside its own try/catch, so a listener
 * that throws does not stop the ones registered after it — which means this one still runs even when
 * the wiring listener above stopped partway, and it is the only thing that can report that. Putting
 * the audit at the bottom of that same listener would have made it the first casualty of exactly the
 * failure it exists to announce.
 *
 * It reports two conditions, and nothing else:
 *   - the wiring listener did not reach its end (something threw outside a `wire()` step), or
 *   - one or more named steps failed.
 * A GM gets one message naming what is missing; every client gets the console line. Silence means the
 * layer is wired — which is the state the log could not previously distinguish from a total outage.
 */
Hooks.once("ready", function () {
  try {
    if (game.system.id !== SYSTEM_ID) return;      // the hard guard above already spoke
    if (wiringComplete && !wiringFailures.length) return;
    const missing = wiringFailures.length ? wiringFailures.join(", ") : localize("Augmented.WiringStoppedEarly");
    console.error(`${SCOPE} | ready wiring INCOMPLETE (complete=${wiringComplete}); inactive this session: ${missing}. Reload this client; if it repeats, the console error above names the cause.`);
    ui.notifications?.error?.(localizeParam("Augmented.WiringIncomplete", { features: missing }), { permanent: true });
  } catch (e) {
    console.error(`${SCOPE} | readiness audit failed`, e);
  }
});

/**
 * Add a GM "IP Tracker" button to the Actors directory header when the IP system is enabled.
 * Mirrors the system's own button, scoped to the module's tracker.
 */
Hooks.on("renderActorDirectory", (app, html) => {
  try {
    if (!game.user.isGM || ipHideUI() || hostProvides("ip")) return;
    const root = html instanceof jQuery ? html[0] : html;
    if (!root || root.querySelector(".cp2020ae-ip-tracker-btn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cp2020ae-ip-tracker-btn";
    btn.innerHTML = `<i class="fas fa-graduation-cap"></i> ${game.i18n.localize("CYBERPUNK.IpTrackerTitle")}`;
    btn.addEventListener("click", () => openIpTracker());
    const header = root.querySelector(".directory-header") ?? root.querySelector(".header-actions") ?? root.firstElementChild ?? root;
    header.prepend(btn);
  } catch (e) { /* non-fatal */ }
});
