import { getCalibers, AMMO_MODIFIERS, modifierAppliesToCaliber, getCaliberBox, getAmmoBoxPrice, normalizeCaliber } from "../lookups.js";
import { localize } from "../utils.js";

const SCOPE = "cp2020-augmented";
const AMMO_IMG = "modules/cp2020-augmented/img/weapon-icon.svg";

/**
 * Ammunition purchasing for the Augmented shop catalog ([[shopping-design]]).
 *
 * Ported from the base system's Buy-Ammo dialog: only the headless `purchaseAmmo` engine + its helpers
 * are kept — the shop folds ammo into the catalog as generated caliber rows, so the standalone dialog
 * isn't needed here. Charge-first-then-stock with refund-on-failure (the proven idiom).
 *
 * NOTE (tier-4 ammo subsystem): the ammo combat-metadata fields written below (DoT / spread / armor
 * multipliers, etc.) are the Augmented combat layer's own additions. On the base fork they are part of
 * the `ammo` item schema; on a vanilla system the schema drops the unknown ones — the ammo is still
 * bought (caliber + quantity persist), it just lacks combat metadata until the ammo-relocation slice.
 */

/**
 * Whether the current user may purchase ammunition. GMs always may; players only when the
 * "playersCanBuyAmmo" world setting is on (otherwise they buy at a shop / the GM buys for them).
 * @returns {{ ok: boolean, reason: string }}
 */
export function canBuyAmmo() {
  if (game.user?.isGM) return { ok: true, reason: "" };
  let allowed = true;
  try { allowed = game.settings.get(SCOPE, "playersCanBuyAmmo") !== false; } catch (e) { /* default allow */ }
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

/**
 * Buy `boxes` boxes of `caliber` + `modifier` ammunition for `actor`: charge eurobucks then create/restock
 * a matching ammo Item. Charge-first-then-stock with refund-on-failure (the proven idiom), so a failed
 * create can never leave free ammo or a double charge. Re-validates the access gate + funds at execution
 * time. Used by the shop catalog's generated ammo rows.
 * @param {Actor} actor
 * @param {{caliber:string, modifier?:string, boxes?:number}} opts
 * @returns {Promise<boolean>} true on success
 */
export async function purchaseAmmo(actor, { caliber, modifier = "standard", boxes = 1 } = {}) {
  if (!actor) { ui.notifications.warn(localize("AmmoBuyNoActor")); return false; }
  caliber = String(caliber ?? "").trim();
  if (!caliber) { ui.notifications.warn(localize("AmmoBuyNoCaliber")); return false; }

  // Guard the arrow/bullet family rule: a modifier that doesn't fit this caliber falls back to
  // Standard (an arrow load can't be bought onto a bullet caliber, or vice versa).
  if (!modifierAppliesToCaliber(modifier, caliber)) modifier = "standard";

  // Re-validate access at execution time (settings could have changed since the UI opened).
  const gate = canBuyAmmo();
  if (!gate.ok) { ui.notifications.warn(gate.reason); return false; }

  const n = Math.max(1, Math.floor(Number(boxes) || 1));
  const box = getCaliberBox(caliber);
  const unitPrice = getAmmoBoxPrice(caliber, modifier);
  const totalCost = unitPrice * n;
  const totalRounds = (Number(box.box) || 1) * n;

  const funds = Number(actor.system?.eurobucks ?? 0);
  if (funds < totalCost) {
    ui.notifications.warn(game.i18n.format("CYBERPUNK.AmmoBuyInsufficientFunds", { cost: totalCost, funds }));
    return false;
  }

  // Stack onto an existing matching (same caliber + modifier) ammo item if present.
  const existing = (actor.itemTypes?.ammo ?? []).find(
    a => normalizeCaliber(a.system?.caliber) === normalizeCaliber(caliber)
      && (a.system?.modifier ?? "standard") === modifier
  );

  // Charge first, then stock. (update before create so a failed create doesn't leave free ammo.)
  await actor.update({ "system.eurobucks": funds - totalCost });

  try {
    if (existing) {
      await existing.update({ "system.quantity": Number(existing.system?.quantity ?? 0) + totalRounds });
    } else {
      const calLabel = (getCalibers()[caliber]?.label) ?? caliber;
      const modLabel = AMMO_MODIFIERS[modifier]?.label ?? "Standard";
      const system = foundry.utils.mergeObject(
        {
          caliber,
          ammoType: caliber,
          quantity: totalRounds,
          boxSize: Number(box.box) || 1,
          boxCost: unitPrice
        },
        ammoModifierSystemFields(modifier),
        { inplace: false }
      );
      await actor.createEmbeddedDocuments("Item", [{
        name: `${calLabel} ${modLabel}`,
        type: "ammo",
        img: AMMO_IMG,
        system
      }]);
    }
  } catch (err) {
    // Refund if stocking failed, so the player isn't charged for nothing.
    console.error("cp2020-augmented | Buy ammo: failed to stock, refunding.", err);
    await actor.update({ "system.eurobucks": funds });
    ui.notifications.error(localize("AmmoBuyFailed"));
    return false;
  }

  ui.notifications.info(game.i18n.format("CYBERPUNK.AmmoBoughtFull", {
    rounds: totalRounds, cal: caliber, mod: (AMMO_MODIFIERS[modifier]?.label ?? "Standard"), cost: totalCost
  }));
  return true;
}
