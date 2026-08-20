import { canShop, getShopPriceOverride } from "../settings.js";
import { isUnwornArmor, localize } from "../utils.js";
import { isShopSetupMode } from "./setup-mode.js";

const SCOPE = "cp2020-augmented";

// Actors with a buyItem currently in flight on THIS client — a synchronous claim (added before the funds
// read, removed in finally) makes a same-tick double-buy for one actor a no-op. Mirrors the
// _resolvingPurchaseRequests claim idiom in catalog.js.
const _buyingActors = new Set();

/**
 * Is `raw` a usable price? Coerces to a finite, NON-NEGATIVE number from a non-empty source (0 allowed).
 * Used for GM-set values (price overrides / the GM-entered request price), where 0 is a deliberate
 * "free". For the COMPENDIUM cost use `isPositivePrice` instead — see the note in resolveCatalogPrice.
 * @param {*} raw
 * @returns {boolean}
 */
export function isValidPrice(raw) {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0;
  const s = String(raw).trim();
  if (s === "") return false;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0;
}

/** Is `raw` a usable POSITIVE price (> 0)? The trust gate for a base-compendium cost. */
export function isPositivePrice(raw) {
  return isValidPrice(raw) && Number(raw) > 0;
}

/**
 * Resolve the unit price of a catalog item via a SELF-DISENGAGING precedence:
 *   1. the compendium cost, if a POSITIVE number  (source: "compendium")
 *   2. else a GM price override for this _id, if set (0 allowed = free)  (source: "override")
 *   3. else unpurchasable  (source: "none", price: null)
 *
 * ⚠ Why POSITIVE (not just numeric) for the compendium: the base system's item DataModel defaults a
 * missing/blank `cost` to the number **0** — verified on his 1.1.1 (34 shoppable items read 0, incl.
 * the AK-47, UZI, MP5, Colt Peacemaker, Cloth/Leather armor). So `0` means "unpriced", NOT "free": a
 * bare `Number(cost)` would sell those real guns for nothing. Only a strictly-positive cost is trusted
 * as a real price; everything else routes to the GM price flow. A GM can still mark an item genuinely
 * free by setting an OVERRIDE of 0 (an explicit decision, honored via isValidPrice above).
 *
 * The compendium ALWAYS wins over the override, so the override goes dead the instant a real (positive)
 * cost appears (the base data is fixed upstream / our data PR lands). The override is never written to
 * the compendium — it lives in the module's `shopPriceOverrides` world setting. Pass a pre-fetched
 * `overrides` map to avoid a settings read per row when resolving the whole catalog index.
 * @param {*} rawCost            the item's raw `system.cost`
 * @param {string} itemId        the item `_id` (the override key — stable across rename/localization)
 * @param {object} [overrides]   optional pre-fetched override map (else read live for this id)
 * @param {object} [opts]
 * @param {boolean} [opts.preferOverride] variable-price items (data-corrections `priceRange`): the
 *   compendium cost is only the book range's top end, so a GM-set override IS the real price and wins.
 *   Everything else keeps the self-disengaging order (compendium first) so a fixed upstream cost
 *   retires its override.
 * @returns {{price:number|null, purchasable:boolean, source:"compendium"|"override"|"none"}}
 */
export function resolveCatalogPrice(rawCost, itemId, overrides, { preferOverride = false } = {}) {
  if (preferOverride) {
    const early = overrides ? overrides[itemId] : getShopPriceOverride(itemId);
    if (isValidPrice(early)) return { price: Math.max(0, Math.round(Number(early))), purchasable: true, source: "override" };
  }
  if (isPositivePrice(rawCost)) return { price: Math.round(Number(rawCost)), purchasable: true, source: "compendium" };
  const override = overrides ? overrides[itemId] : getShopPriceOverride(itemId);
  if (isValidPrice(override)) return { price: Math.max(0, Math.round(Number(override))), purchasable: true, source: "override" };
  return { price: null, purchasable: false, source: "none" };
}

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
 * Force an ACQUIRED armor copy into the unworn state, in place.
 *
 * ⚠ The reason this exists is a SCHEMA DEFAULT, not a bad pack entry. The base system's common item
 * schema declares `equipped: booleanField(true)` (systems/cyberpunk2020/module/data/item-data.js:144,
 * mirrored by its DEFAULTS literal at :19 and its `normalizeBooleanIfPresent(source,"equipped",true)`
 * migration at :161). Every one of the base system's 16 armor pack entries OMITS `system.equipped`
 * from its stored source, so the DataModel materializes each one as `equipped: true` — the shipped
 * `armor` pack (12 entries, incl. Flack Vest / Flack Pants) and `armor-add` (4 entries, incl. HeadGear
 * Cybermodem Helmet) alike. No amount of pack-data correction fixes that: the default re-applies on
 * every create, and the data is not ours to rewrite. It has to be normalized at the acquisition seam.
 *
 * Our own 85 `src/packs` armor entries all carry an explicit `equipped: false` and are unaffected —
 * this is a no-op for them, which is the point: one rule, no per-source knowledge.
 *
 * Scope is deliberately narrow — ARMOR ONLY:
 *   • cyberware's `equipped` means "installed", and buy-and-install decides it explicitly
 *     (module/cyberware/install.js) — it never reaches this path.
 *   • ammo's `equipped` means "loaded" (the base system's own item-sheet filters read it that way).
 *   • the NPC generator deliberately creates goons WEARING their armor (module/npcgen/goon-factory.js
 *     `data.system.equipped = true`, module/npcgen/materialize.js likewise). It creates via
 *     `actor.createEmbeddedDocuments` directly and never calls buyItem, so the exemption is
 *     STRUCTURAL — there is no flag to thread and no way for this to reach it.
 *   • GM SETUP MODE takes the opposite branch at the call site (see `equipArmorOnAcquire` below).
 *     The mode is client state read through `game.user`, so the choice is made in buyItem where the
 *     rest of the impure world already is; this function stays a pure, unconditional state-setter.
 *
 * @param {object} data  item data for the buyer's copy (mutated in place)
 * @returns {object} the same object
 */
export function clearEquippedOnAcquire(data) {
  if (data?.type !== "armor") return data;
  data.system = data.system ?? {};
  data.system.equipped = false;
  return data;
}

/**
 * Force an ACQUIRED armor copy into the WORN state, in place — the GM setup-mode counterpart of
 * `clearEquippedOnAcquire`, and armor-only for exactly the same reasons (cyberware's `equipped` means
 * installed, ammo's means loaded).
 *
 * WHY the two directions exist rather than one rule: a PURCHASE is a delivery, and goods a buyer just
 * paid for should not silently start protecting them — that is the standing rule. A GM in setup mode
 * is not buying; they are furnishing, and every piece they hand out is one they would immediately have
 * to switch on by hand. Twenty NPCs is twenty trips through a character sheet. So the mode that already
 * waives the money and the chat card also delivers armor worn (user ruling: "equipped by default for
 * setup mode").
 *
 * It FORCES the state rather than passing the source through. Our own 85 `src/packs` armor entries
 * store `equipped: false` explicitly, so a passthrough would deliver most of the catalog unworn and the
 * exemption would only appear to work on the base system's 16 entries — the same one-rule-no-per-source-
 * knowledge argument that shaped its counterpart.
 *
 * @param {object} data  item data for the buyer's copy (mutated in place)
 * @returns {object} the same object
 */
export function equipArmorOnAcquire(data) {
  if (data?.type !== "armor") return data;
  data.system = data.system ?? {};
  data.system.equipped = true;
  return data;
}

/**
 * Has this client already been told, during the current furnishing run, that setup mode delivers armor
 * worn? Reset by the first acquisition made with the mode OFF, so the notice returns for the next run.
 * Module-local and in-memory, matching the lifetime of the mode it describes.
 */
let _setupArmorNoticeRaised = false;

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

  // Synchronous in-flight claim keyed by actor id (mirrors _resolvingPurchaseRequests): buyItem does
  // read-funds → check → await update → createEmbeddedDocuments, so two same-tick buys for one actor both
  // read the same funds and collapse to one charge but two items. Claim BEFORE the funds read and release
  // in finally so a concurrent second buy for the same actor bails cleanly. (The Buy button is also
  // disabled during flight — this backstops the drag-to-buy path and second windows.)
  if (_buyingActors.has(actor.id)) { ui.notifications?.warn(localize("ShopBuyInProgress")); return false; }
  _buyingActors.add(actor.id);
  try {
  const data = (source && typeof source.toObject === "function") ? source.toObject() : foundry.utils.deepClone(source ?? {});
  // A copy bought from a base-compendium item must carry its origin uuid so the preCreateItem corrections
  // hook (data-corrections.js) recognizes it and applies the book values — toObject() doesn't include it.
  if (source?.pack && typeof source.uuid === "string") {
    data._stats = { ...(data._stats ?? {}), compendiumSource: source.uuid };
  }
  const name = data?.name ?? "item";
  const n = Math.max(1, Math.floor(Number(qty) || 1));
  const base = Number(unitPrice ?? data.system?.cost ?? 0);
  // GM setup mode: a free, silent grant of the REAL item. The price is zeroed here rather than at the
  // call sites so every route in — the Buy button, buy-for-NPC, drag-to-sheet — gets it from one place
  // and none of them can be forgotten. Everything below (the compendium-source stamp, the flag patch,
  // the quantity-vs-copies decision) is untouched, which is the point: same goods, no invoice.
  const setup = isShopSetupMode();
  const total = setup ? 0 : Math.max(0, Math.round(base * n));

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
    // Bought armor is CARRIED, not worn — unless this is a GM furnishing run, which delivers it worn.
    // Applied here — before the copies are cloned below and before the receipt reads the state — so
    // every route into buyItem (catalog Buy, drag-to-buy, buy-for-NPC, a published-shop buy, an
    // approved purchase request) gets the same decision from one place. See the two functions' notes:
    // the standing rule defends against the base system's `equipped` default, not against a pack typo.
    if (setup) equipArmorOnAcquire(data); else clearEquippedOnAcquire(data);
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

  // SETUP-MODE BRANCH — say that the armor arrived WORN, which is the opposite of what every other
  // route does. It cannot be a chat card: the silence below is the mode's contract, and a furnishing
  // run would post one per piece. So it uses the channel that matches the mode itself — a transient,
  // CLIENT-LOCAL notice, on the one client the mode is even on. Raised once per furnishing run rather
  // than once per piece, so kitting out a squad does not queue a stack of identical toasts; an
  // acquisition made with the mode OFF re-arms it. This is the reminder at the moment it happens, not
  // the only telling: the standing explanation lives on the mode's own surfaces (the toggle tooltip
  // and the lit-mode banner, both in templates/shop/catalog.hbs).
  if (!setup) _setupArmorNoticeRaised = false;
  else if (data.type === "armor" && !_setupArmorNoticeRaised) {
    _setupArmorNoticeRaised = true;
    ui.notifications?.info(localize("ShopSetupArmorEquipped"));
  }

  // PAID BRANCH — setup mode posts nothing. A "Bought Kevlar for 0eb" card in the log is a purchase
  // that did not happen, and a GM furnishing twenty NPCs would fill the scrollback with twenty of them.
  // Armor bought here lands in inventory switched off — guaranteed by clearEquippedOnAcquire above
  // rather than assumed of the source data (the base system's schema defaults `equipped` to TRUE, and
  // its 16 armor entries all omit the field, so before that call this cue never fired for them).
  // The receipt is the one place the buyer is already looking at the moment it happens, so it says so —
  // one plain sentence appended to the existing card, no second card, no new surface.
  const deliveredUnworn = isUnwornArmor(data);
  if (!setup) ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: [
      game.i18n.format("CYBERPUNK.ShopBought", {
        qty: n, name, cost: total, label: priceLabel ? ` (${priceLabel})` : ""
      }),
      deliveredUnworn ? localize("ShopArmorUnworn") : null
    ].filter(Boolean).join(" ")
  });
  return true;
  } finally {
    _buyingActors.delete(actor.id);
  }
}
