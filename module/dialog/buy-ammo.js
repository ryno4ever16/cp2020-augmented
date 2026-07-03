/**
 * Ammo-modifier helpers used by the item sheet's ammo restock / modifier controls:
 *   - canBuyAmmo()               — access gate (GM, or the `playersCanBuyAmmo` world setting)
 *   - ammoModifierSystemFields() — the system.* an ammo modifier seeds onto an ammo item
 *   - applyAmmoModifierUpdate()  — dotted-key form of the above for item.update()
 *
 * The interactive Buy-Ammo DIALOG + its `purchaseAmmo` engine used to live here too, but they duplicated
 * shop/buy-ammo.js (the live copy the shop catalog + item-sheet restock use) and had drifted — removed.
 * If a standalone buy-ammo dialog is wanted again, build it on shop/buy-ammo.js's `purchaseAmmo`.
 */
import { AMMO_MODIFIERS } from "../lookups.js";

/**
 * Whether the current user may purchase ammunition.
 * GMs always may. Players may only when the "playersCanBuyAmmo" world setting is on; otherwise
 * they are told ammo must be bought at a shop (the GM buys on their behalf).
 * @returns {{ ok: boolean, reason: string }}
 */
export function canBuyAmmo() {
  if (game.user?.isGM) return { ok: true, reason: "" };
  let allowed = true;
  try { allowed = game.settings.get("cp2020-augmented", "playersCanBuyAmmo") !== false; } catch (e) { /* default allow */ }
  return allowed ? { ok: true, reason: "" } : { ok: false, reason: game.i18n.localize("CYBERPUNK.AmmoBuyAtShop") };
}

/** The system-data fields (un-dotted) that a given modifier seeds onto an ammo item. */
export function ammoModifierSystemFields(modifierId) {
  const mod = AMMO_MODIFIERS[modifierId] ?? AMMO_MODIFIERS.standard;
  const mech = mod.mech ?? {};
  const fx = ["CoreMods"];
  if (mech.stunSaveOnHit) fx.push("Stun");
  if (mech.dotEnabled) fx.push("DoT");
  return {
    modifier: AMMO_MODIFIERS[modifierId] ? modifierId : "standard",
    armorMultSoft: mech.armorMultSoft ?? 1,
    armorMultHard: mech.armorMultHard ?? 1,
    penDamageMult: mech.penDamageMult ?? 1,
    rawDamageMult: mech.rawDamageMult ?? 1,
    bonusDamageFormula: mech.bonusDamageFormula ?? "",
    accuracyMod: mech.accuracyMod ?? 0,
    stunSaveOnHit: mech.stunSaveOnHit ?? false,
    stunSaveMod: mech.stunSaveMod ?? 0,
    dotEnabled: mech.dotEnabled ?? false,
    dotTurns: mech.dotTurns ?? 0,
    dotDamageFormula: mech.dotDamageFormula ?? "",
    dotType: mech.dotType ?? "acid",
    spreadMode: mech.spreadMode ?? "single",
    effectTypes: (modifierId === "standard") ? ["None"] : fx
  };
}

/** Dotted-key form of {@link ammoModifierSystemFields} for document.update(). */
export function applyAmmoModifierUpdate(modifierId) {
  const out = {};
  for (const [k, v] of Object.entries(ammoModifierSystemFields(modifierId))) out[`system.${k}`] = v;
  return out;
}
