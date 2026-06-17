/**
 * Augmented combat automation — feasibility slice.
 *
 * Proves the module can sit on top of the cyberpunk2020 system and react to its
 * combat events. The system emits "cyberpunk2020.weaponFired" when a weapon is
 * fired (currently from our fork's item.js; upstream via the weaponFired seam-PR).
 * This listener receives it, reads the attacker's actor, and posts a localized
 * confirmation. The full damage / save / area engine is ported on top of this
 * same seam in later slices — this stub only proves the hook architecture works
 * from a module.
 */
import { combatAutomationEnabled } from "../settings.js";
import { localizeParam } from "../utils.js";

export function registerCombatAutomation() {
  Hooks.on("cyberpunk2020.weaponFired", onWeaponFired);
}

function onWeaponFired(payload = {}) {
  if (!combatAutomationEnabled()) return;

  // Only the single active GM acts, so the automation runs exactly once even with
  // multiple GM clients connected (mirrors the system's combat-data GM gating).
  if (game.user !== game.users.activeGM) return;

  // item.js emits "attackerId"; support legacy "actorId" for other callers.
  const attackerId = payload.attackerId ?? payload.actorId ?? null;
  const attacker = attackerId ? game.actors?.get(attackerId) : null;
  const weaponName = payload.weaponName ?? "?";

  console.log("cp2020-augmented | weaponFired received", {
    weapon: weaponName,
    attacker: attacker?.name ?? null,
    payload
  });
  ui.notifications?.info(localizeParam("Augmented.AutomationReceived", {
    actor: attacker?.name ?? "?",
    weapon: weaponName
  }));
}
