/**
 * Cyberpunk 2020: Augmented Edition — companion module entry point.
 *
 * Loads on top of the `cyberpunk2020` system and adds the Augmented features
 * (vehicles & ACPA / Maximum Metal, combat automation, shopping, IP tracking)
 * as opt-in overlays, WITHOUT modifying the base system. Mirrors the system's
 * own init/ready wiring shape: registration functions imported here and called
 * from Hooks.once('init'/'ready').
 */
import { registerAugmentedSettings, combatAutomationEnabled } from "./settings.js";
import { registerDamageHooks } from "./combat/damage-hooks.js";
import { registerMovementGate } from "./combat/movement-gate.js";
import { registerSaveRollHandlers } from "./combat/save-rolls.js";
import { registerPopoutCompat } from "./popout-compat.js";

// Vehicle / ACPA (Maximum Metal) sub-types — module-owned Actor/Item types, data in system.*.
import { CyberpunkVehicleActorData } from "./data/vehicle-actor-data.js";
import { CyberpunkVehicleWeaponData, CyberpunkAcpaSystemData } from "./data/vehicle-item-data.js";
import { CyberpunkVehicleSheet } from "./actor/vehicle-sheet.js";
import { registerVehicleCanvasHooks, deployVehicleToScene, boardVehicle, disembark } from "./vehicle/vehicle-canvas.js";
import { openControlRollDialog } from "./vehicle/vehicle-control.js";
import { openVehicleDamageDialog } from "./vehicle/vehicle-damage.js";
import { weaponToPenetration, vehicleToHitModifier, openVehicleFireDialog, registerVehicleFireHandlers } from "./vehicle/vehicle-weapons.js";
import { registerVehicleTargetingHandlers } from "./vehicle/vehicle-targeting.js";
import { registerMissileFlightHooks } from "./vehicle/vehicle-missile-flight.js";
import { openAcpaMeleeDialog, registerAcpaCombatHooks, repairAcpa } from "./vehicle/vehicle-acpa-combat.js";

export const MODULE_ID = "cp2020-augmented";
export const SYSTEM_ID = "cyberpunk2020";

// Module-namespaced document sub-type ids (Foundry prefixes the manifest's bare keys with the id).
const VEHICLE_ACTOR  = `${MODULE_ID}.vehicle`;
const VEHICLE_WEAPON = `${MODULE_ID}.vehicleWeapon`;
const ACPA_SYSTEM    = `${MODULE_ID}.acpaSystem`;

/** Wrapper-partial templates the vehicle/ACPA sheet includes via {{> path}} (must be preloaded). */
const AUGMENTED_TEMPLATES = [
  "modules/cp2020-augmented/templates/actor/vehicle-sheet.hbs",
  "modules/cp2020-augmented/templates/actor/acpa-sheet.hbs",
];

Hooks.once("init", function () {
  console.log(`${MODULE_ID} | Initializing Cyberpunk 2020: Augmented Edition`);

  registerAugmentedSettings();

  // Register the module's vehicle/ACPA DataModels. Data lives in system.* of the sub-type
  // documents (no flags) — see module.json `documentTypes` for the manifest declaration.
  Object.assign(CONFIG.Actor.dataModels, { [VEHICLE_ACTOR]: CyberpunkVehicleActorData });
  Object.assign(CONFIG.Item.dataModels, {
    [VEHICLE_WEAPON]: CyberpunkVehicleWeaponData,
    [ACPA_SYSTEM]:    CyberpunkAcpaSystemData,
  });

  // Register the vehicle/ACPA actor sheet for the module sub-type. v15-readiness: use the
  // namespaced collection, falling back to the bare global on cores that lack it (v13).
  const _Actors = foundry?.documents?.collections?.Actors ?? Actors;
  _Actors.registerSheet(MODULE_ID, CyberpunkVehicleSheet, { types: [VEHICLE_ACTOR], makeDefault: true });

  // Preload the wrapper sub-templates the sheet includes as Handlebars partials.
  const loadTemplates = foundry?.applications?.handlebars?.loadTemplates ?? globalThis.loadTemplates;
  loadTemplates?.(AUGMENTED_TEMPLATES);

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
  };
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = game.cpAugmented;
});

Hooks.once("ready", function () {
  // Hard guard: the Augmented Edition only works on the cyberpunk2020 system.
  if (game.system.id !== SYSTEM_ID) {
    console.error(`${MODULE_ID} | requires the ${SYSTEM_ID} system; current system is "${game.system.id}".`);
    ui.notifications?.error(game.i18n.localize("CYBERPUNK.Augmented.WrongSystem"));
    return;
  }

  // combatAutomationEnabled is the master gate for the Augmented combat layer
  // (damage application, saves, area effects, combat-tracker controls, vehicle/ACPA
  // weapon fire + targeting + missiles); each individual behaviour is further gated by
  // its own setting. This mirrors the system's own "ready" registration, minus the
  // shop/IP registrars that land in later slices.
  if (combatAutomationEnabled()) {
    registerPopoutCompat();
    registerDamageHooks();
    registerMovementGate();
    registerSaveRollHandlers();

    // Vehicle / ACPA combat handlers (chat-button + per-round flight + crit hooks).
    registerVehicleFireHandlers();
    registerVehicleTargetingHandlers();
    registerMissileFlightHooks();
    registerAcpaCombatHooks();
  }

  console.log(`${MODULE_ID} | Ready (on ${SYSTEM_ID} v${game.system.version}).`);
});
