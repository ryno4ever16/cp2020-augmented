import { canShop } from "../settings.js";
import { localize } from "../utils.js";

const SCOPE = "cp2020-augmented";

/**
 * Fashion style multipliers applied at purchase to style-priced (clothing) items.
 * Core 2020 Gear-List fashion pricing ([[core-rules-reference]] #1). `key` is stored; `mult`
 * multiplies the unit price; `label` is the stable English display label (localized at the render
 * edge — see catalog.js `shopStyleLabel`, keyed off `key`; this table stays i18n-free for the unit tests).
 */
export const FASHION_STYLES = [
  { key: "generic",    label: "Generic",     mult: 1 },
  { key: "leisure",    label: "Leisure",     mult: 2 },
  { key: "urbanflash", label: "Urban Flash", mult: 2 },
  { key: "business",   label: "Businesswear", mult: 3 },
  { key: "highfashion", label: "High Fashion", mult: 4 }
];

/** Price multiplier for a stored style key (unknown/empty → ×1, i.e. Generic). */
export function styleMultOf(key) { return FASHION_STYLES.find(s => s.key === key)?.mult ?? 1; }
/** Stable English display label for a stored style key (unknown/empty → ""). Localize via catalog.js `shopStyleLabel`. */
export function styleLabelOf(key) { return FASHION_STYLES.find(s => s.key === key)?.label ?? ""; }

/**
 * Shopping purchase engine — the generic GEAR path ([[shopping-design]]).
 *
 * Mirrors the proven buy-ammo idiom (module/shop/buy-ammo.js): validate → check funds →
 * CHARGE FIRST → create the item → refund on failure, so a failed create can never leave free
 * goods or a double charge. Money lives on `actor.system.eurobucks` (the base system's field).
 * Cyberware (buy-and-install) and services (recurring/one-off) have their own paths; shop
 * pricing/stock lives in shops.js and the buy routing lives in catalog.js.
 *
 * MODULE NOTE: feature metadata the base system does NOT own (e.g. the recurring-service marker)
 * is written to `flags.cp2020-augmented.*`, not `system.*`, so it persists on a vanilla system
 * whose item schema would otherwise drop an unknown `system` field. See `flagPatch` below.
 */

/**
 * Effective price of one unit: catalog cost × (fashion) style multiplier, rounded.
 * @param {Item|object} item
 * @param {{styleMult?:number}} [opts]
 * @returns {number}
 */
export function priceFor(item, { styleMult = 1 } = {}) {
  const base = Number(item?.system?.cost ?? 0);
  return Math.max(0, Math.round(base * (Number(styleMult) || 1)));
}

/**
 * Purchase `qty` of a source item for `actor`: deduct eurobucks, then add it to inventory.
 * @param {Actor} actor
 * @param {Item|object} source       catalog Item (compendium/world doc) or raw item data
 * @param {object} [opts]
 * @param {number} [opts.qty=1]
 * @param {number} [opts.unitPrice]  price per unit (defaults to the item's catalog cost)
 * @param {string} [opts.priceLabel] short note shown on the chat card (e.g. "High Fashion ×4")
 * @param {object} [opts.flagPatch]  module flags merged onto the created item under
 *                                   `flags.cp2020-augmented` (e.g. {serviceMode:"recurring"})
 * @returns {Promise<boolean>} true on success
 */
export async function buyItem(actor, source, { qty = 1, unitPrice, priceLabel = "", flagPatch = null } = {}) {
  if (!actor) { ui.notifications?.warn(localize("ShopNoActor")); return false; }
  if (!canShop()) { ui.notifications?.warn(localize("ShopNotAllowed")); return false; }

  const data = (source && typeof source.toObject === "function") ? source.toObject() : foundry.utils.deepClone(source ?? {});
  const name = data?.name ?? "item";
  const n = Math.max(1, Math.floor(Number(qty) || 1));
  const base = Number(unitPrice ?? data.system?.cost ?? 0);
  const total = Math.max(0, Math.round(base * n));

  const funds = Number(actor.system?.eurobucks ?? 0);
  if (funds < total) {
    ui.notifications?.warn(game.i18n.format("CYBERPUNK.ShopInsufficientFunds", { name, cost: total, funds }));
    return false;
  }

  // Charge first; refund if stocking fails (update before create — same order as buy-ammo).
  await actor.update({ "system.eurobucks": funds - total });
  try {
    delete data._id;
    delete data.folder;
    delete data.ownership;
    // Don't carry shop-only metadata onto the buyer's copy.
    if (data.flags?.["cp2020-augmented"]?.shop) delete data.flags["cp2020-augmented"].shop;
    // Feature metadata lives in module flags (survives a vanilla item schema, unlike a system field).
    if (flagPatch && typeof flagPatch === "object") {
      data.flags = data.flags ?? {};
      data.flags[SCOPE] = { ...(data.flags[SCOPE] ?? {}), ...flagPatch };
    }
    // If the item TYPE's schema carries a numeric quantity (only ammo does), buy one stack of N;
    // otherwise create N copies. (Checking the schema — not the raw source — avoids stacking onto
    // a field the type would drop, which would silently lose the items the buyer paid for.)
    const typeHasQty = !!CONFIG.Item?.dataModels?.[data.type]?.schema?.fields?.quantity;
    const hasQty = typeHasQty && Number.isFinite(Number(data.system?.quantity));
    let toCreate;
    if (hasQty) {
      data.system.quantity = n;
      toCreate = [data];
    } else {
      toCreate = Array.from({ length: n }, () => foundry.utils.deepClone(data));
    }
    await actor.createEmbeddedDocuments("Item", toCreate);
  } catch (err) {
    console.error("cp2020-augmented | Shop purchase failed to stock, refunding.", err);
    await actor.update({ "system.eurobucks": funds });
    ui.notifications?.error(localize("ShopBuyFailed"));
    return false;
  }

  ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: game.i18n.format("CYBERPUNK.ShopBought", {
      qty: n, name, cost: total, label: priceLabel ? ` (${priceLabel})` : ""
    })
  });
  return true;
}
