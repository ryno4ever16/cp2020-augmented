/**
 * Cyberpunk 2020: Augmented Edition — companion module entry point.
 *
 * Loads on top of the `cyberpunk2020` system and adds the Augmented features
 * (vehicles & ACPA / Maximum Metal, combat automation, shopping, IP tracking)
 * as opt-in overlays, WITHOUT modifying the base system. Mirrors the system's
 * own init/ready wiring shape: registration functions imported here and called
 * from Hooks.once('init'/'ready').
 */
import { registerAugmentedSettings } from "./settings.js";
import { registerCombatAutomation } from "./combat/automation.js";

export const MODULE_ID = "cp2020-augmented";
export const SYSTEM_ID = "cyberpunk2020";

Hooks.once("init", function () {
  console.log(`${MODULE_ID} | Initializing Cyberpunk 2020: Augmented Edition`);

  registerAugmentedSettings();
  registerCombatAutomation();

  // Public API surface for macros and other modules. Populated as features land.
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = {};
});

Hooks.once("ready", function () {
  // Hard guard: the Augmented Edition only works on the cyberpunk2020 system.
  if (game.system.id !== SYSTEM_ID) {
    console.error(`${MODULE_ID} | requires the ${SYSTEM_ID} system; current system is "${game.system.id}".`);
    ui.notifications?.error(game.i18n.localize("CYBERPUNK.Augmented.WrongSystem"));
    return;
  }

  console.log(`${MODULE_ID} | Ready (on ${SYSTEM_ID} v${game.system.version}).`);
});
