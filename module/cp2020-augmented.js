/**
 * Cyberpunk 2020: Augmented Edition — companion module entry point.
 *
 * Loads on top of the `cyberpunk2020` system and adds the Augmented features
 * (vehicles & ACPA / Maximum Metal, combat automation, shopping, IP tracking)
 * as opt-in overlays, WITHOUT modifying the base system. Mirrors the system's
 * own init/ready wiring shape: registration functions imported here and called
 * from Hooks.once('init'/'ready').
 */
import { registerAugmentedSettings, combatAutomationEnabled, ipHideUI, applyCarolingianSkinClass } from "./settings.js";
import { registerAugmentedHandlebarsHelpers } from "./handlebars-helpers.js";
import { registerDamageHooks } from "./combat/damage-hooks.js";
import { registerMovementGate } from "./combat/movement-gate.js";
import { registerSaveRollHandlers } from "./combat/save-rolls.js";
import { registerPopoutCompat } from "./popout-compat.js";

// Vehicle / ACPA (Maximum Metal) sub-types — module-owned Actor/Item types, data in system.*.
import { CyberpunkVehicleActorData } from "./data/vehicle-actor-data.js";
import { CyberpunkVehicleWeaponData, CyberpunkAcpaSystemData, makeVehicleItemData } from "./data/vehicle-item-data.js";
import { CyberpunkVehicleSheet } from "./actor/vehicle-sheet.js";
import { CyberpunkAugmentedItemSheet } from "./item/augmented-item-sheet.js";
import { registerVehicleCanvasHooks, deployVehicleToScene, boardVehicle, disembark } from "./vehicle/vehicle-canvas.js";
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
import { registerMechLight } from "./mech/light.js";
import { registerMechVision, registerHeatSenseDetectionMode } from "./mech/vision.js";
import { registerMechConsumable } from "./mech/consumable.js";
import { registerMechChipGrant } from "./mech/chip-grant.js";
import { registerMechContainer } from "./mech/container.js";
import { registerMechStatMods } from "./mech/stat-mods.js";
import { registerMechDrug } from "./mech/drug.js";
import { registerBorg } from "./mech/borg.js";
import { registerTypedArmorDisplay } from "./mech/typed-armor-display.js";
import { registerRadiation } from "./radiation/radiation.js";
import { registerRadiationZones } from "./radiation/radiation-zones.js";
import { registerRadiationTools } from "./radiation/radiation-tools.js";
import { registerMechCyberlimb, cyberlimbSdp } from "./mech/cyberlimb.js";
import { registerPaSkillBackfill } from "./mech/pa-skills.js";
import { registerPaCombatSense } from "./mech/pa-combat-sense.js";
import { registerMartialDefense } from "./martial/martial.js";
import { registerFreeFire } from "./mech/free-fire.js";
import { registerMechLoadout } from "./mech/loadout.js";
import { registerSeamShim } from "./seam-shim.js";
import { hostProvides } from "./system-api.js";

// Shop / economy ([[shopping-design]]) — the sidebar cart opens a standalone catalog/shop window;
// the browse/buy engine + custom-shop curation live in module/shop/.
import { registerShopHooks, openShopWindow } from "./shop/catalog.js";
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
  "modules/cp2020-augmented/templates/actor/acpa-sheet.hbs",
  "modules/cp2020-augmented/templates/actor/parts/countermeasures.hbs",
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
  });

  // Q7 personality moddies: wrap the actor's prepareData so stat mods with caps/combat context
  // apply on top of the base totals (prepareData, NOT prepareDerivedData — the base computes its
  // stats in prepareData; see the DataModel hazard note in data/mech-item-data.js). Wrapped at
  // INIT (before any actor prepares) so the first world-load prep already reflects them; also
  // wires the combat-context refresh hooks.
  registerMechStatMods();
  // D4 combat drugs: wrap prepareData (AFTER the Q7 wrap above, so active-drug boosts overlay last)
  // and wire the round-tick that expires timed drugs. Init-time for the same first-prep reason.
  registerMechDrug();
  // Full-conversion borgs: wrap prepareData to seed the borg body's per-zone SDP into system.sdp
  // (independent of the stat wraps above — touches sdp, not stats). Init-time for the same reason.
  registerBorg();
  // Honest conditional-armor display: wrap prepareData to re-derive the armor panel from the damage
  // system's own type-aware SP (so a fire-only garment stops inflating the panel vs bullets) and build
  // system.conditionalSP for the per-damage-type sub-panel. Registered AFTER registerBorg so it runs
  // after the borg chassis-SP seed (see typed-armor-display.js). Init-time for the first-prep reason.
  registerTypedArmorDisplay();
  // Deep Space radiation dose subsystem: wrap prepareData for the radiation stat-loss overlay, wire the
  // chance-of-death button + the per-round dose tick, and install the radiation-zone hooks. Registered
  // AFTER registerMechDrug so the overlay stacks on the drug boosts (order base → moddy → drug → radiation);
  // the whole subsystem stays inert unless the radiationEnabled world setting is on.
  registerRadiation();
  registerRadiationZones();
  // R3b GM tools: the apply-dose / place-zone / environmental scene-control buttons (shown to a GM while
  // radiation is enabled). The per-actor panel controls are wired by the actor sheet itself.
  registerRadiationTools();
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

  // Public API surface for macros and other modules. Mirrors the system's game.cyberpunk.vehicles
  // shape under the module's own namespace so it never clobbers the system API.
  game.cpAugmented = {
    vehicles: {
      deploy: deployVehicleToScene, board: boardVehicle, disembark,
      controlRoll: openControlRollDialog, applyDamage: openVehicleDamageDialog,
      weaponToPen: weaponToPenetration, toHitMod: vehicleToHitModifier, fire: openVehicleFireDialog,
      acpaMelee: openAcpaMeleeDialog, acpaRepair: repairAcpa,
    },
    // IP tracker API: open the GM Improvement-Points tracker.
    ip: { openTracker: openIpTracker },
    // Shop API: open the shop window (the sidebar cart is the primary entry point).
    shop: { open: openShopWindow },
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
}

/**
 * One-time, GM-only world migration for the M18 flesh/structural limb-state split. Before M18 both
 * kinds of limb wound shared `flags.cp2020-augmented.limbStatus`; the flesh models now write a
 * separate `fleshLimbStatus`, but any state a pre-M18 build persisted still sits under the old shared
 * key and is misread as structural cyberlimb state. This pass moves every `limbStatus` entry whose
 * zone carries NO structural SDP pool into `fleshLimbStatus` and deletes it from the old key (the
 * `-=` idiom); zones that DO carry a structural pool (a real cyberlimb / borg chassis) keep their
 * `limbStatus` untouched. World actors AND unlinked scene-token actor deltas are both swept. Guarded
 * by a world flag so it runs exactly once. Safe to fail — a missed actor just keeps its old flags.
 */
async function migrateFleshLimbStatus() {
  const DONE = "fleshLimbStatusMigrated";
  if (!game.settings.settings.has(`${SCOPE}.${DONE}`)) {
    game.settings.register(SCOPE, DONE, { scope: "world", config: false, type: Boolean, default: false });
  }
  if (game.settings.get(SCOPE, DONE)) return;

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
      update[`flags.${SCOPE}.limbStatus.-=${zone}`] = null;
      moved = true;
    }
    if (!moved) return;
    update[`flags.${SCOPE}.fleshLimbStatus`] = flesh;
    await actor.update(update, { render: false })
      .catch((e) => console.warn(`${SCOPE} | flesh-status migration failed for actor ${actor.id}`, e));
  };

  for (const actor of game.actors ?? []) await migrateActor(actor);
  for (const scene of game.scenes ?? []) {
    for (const token of scene.tokens ?? []) {
      if (token.actorLink) continue;      // linked tokens share the world actor migrated above
      await migrateActor(token.actor);    // the unlinked token's synthetic delta actor
    }
  }

  await game.settings.set(SCOPE, DONE, true);
  console.log(`${SCOPE} | flesh-limb-status migration complete.`);
}

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

  // P3 light emitters + P4 vision devices: item toggles drive the bearer's token light/sight
  // (the active GM applies the token writes).
  registerMechLight();
  registerMechVision();
  // P7 timed consumables: dose gate on activation + the per-turn timer tick.
  registerMechConsumable();
  // Q2 chip skill grants: an active chip naming a skill the actor lacks creates it (RAW: chips
  // work untrained); the choose-chips prompt for the skill. Initiating-client/owner writes.
  registerMechChipGrant();
  // Q6 containers: uninstall cascade — deleting a container detaches its children to loose gear.
  registerMechContainer();
  // Loadouts: a body carrying a `loadout` manifest (e.g. a full 'borg) materializes its prebuilt
  // options as real cyberware on install, and removes them on uninstall/delete. Initiating-owner writes.
  registerMechLoadout();
  // PA (Powered Armor) skills: linking a character as an ACPA suit's pilot backfills the three Maximum
  // Metal powered-armor skills (PA Combat Sense / PA Tech / Expert (PA Design)) at level 0 from the
  // module skills compendium. Idempotent; only the initiating client that owns the pilot writes.
  registerPaSkillBackfill();
  // PA Combat Sense (MM p.52–53) pilot-side bonuses: a Trooper's OWN initiative gains ½ his PA Combat
  // Sense (out-of-suit) via a Combatant init-roll override, and his Awareness/Notice rolls gain full PACS
  // while piloting an ACPA via a rollSkill wrap. In-suit full initiative + Solo-suppression already ship.
  registerPaCombatSense();

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

  // Apply the per-user Carolingian / Restyler terminal sheet skin (toggles the cp-carolingian
  // <body> class that gates the skin CSS in cp2020-augmented.css). Client-side cosmetic, so it
  // runs independently of the combat-automation gate below.
  applyCarolingianSkinClass();

  // TEMPORARY seam shim: emit the weaponFired / skillRolled hooks the module relies on, but ONLY while
  // the base system lacks native emission (the seam PRs aren't merged). Self-disengages the instant the
  // base system emits them — including on a fork+module install (the fork emits natively). See seam-shim.js.
  registerSeamShim();

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
  registerPopoutCompat();
  if (doCombat) {
    registerDamageHooks();
    registerMovementGate();
    registerSaveRollHandlers();
  }
  if (doVehicles) {
    // Vehicle / ACPA combat handlers (chat-button + per-round flight + crit hooks).
    registerVehicleFireHandlers();
    registerVehicleTargetingHandlers();
    registerMissileFlightHooks();
    registerAcpaCombatHooks();
  }

  // IP (Improvement Points) tracker — independent of the combat layer; the auto-queue self-gates on
  // ipRawTracking (RAW mode only), the in-sheet UI on ipEnabled (= !ipHideUI).
  const doIp = !hostProvides("ip");
  if (doIp) {
    registerIpHooks();
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
    registerShopHooks();
  }

  // Martial-arts layer (Option B): martial features now ship entirely with our registered sheets — the
  // combat-tab panel via the actor sheet, and the skill martial-art editor via the item sheet (skill
  // type, writing flags.cp2020-augmented.* because his skill DataModel lacks isMartialArt/martialBonuses).
  // Both renderCyberpunk*Sheet injectors are removed; nothing to register at ready (the gate var is kept
  // for the readiness log).
  const doMartial = !hostProvides("martial");

  console.log(`${SCOPE} | Ready (on ${SYSTEM_ID} v${game.system.version}); layers: ` +
    `combat=${doCombat} vehicles=${doVehicles} ip=${doIp} shopping=${doShopping} martial=${doMartial}`);
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
