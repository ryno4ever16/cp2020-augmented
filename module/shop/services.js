import { canShop } from "../settings.js";
import { localize } from "../utils.js";
import { isShopSetupMode } from "./setup-mode.js";
import { correctedServiceMode } from "../data-corrections.js";

const SCOPE = "cp2020-augmented";

/**
 * Service classification + payment (Shopping #15 — [[shopping-design]]).
 *
 * Items are all type `misc`, so "is this a service?" is inferred — but reviewable: an item's service
 * mode ("gear" | "recurring" | "oneoff") is an explicit override that wins over the inference. The GM
 * can set it on the item sheet. Inference uses the source pack (the Core "Rentals & Services" gear
 * list) plus real-world keyword sense.
 *
 * MODULE NOTE: the base system's `misc` type is bare (no `serviceMode`/`servicePeriod` fields), so the
 * Augmented Edition stores them in `flags.cp2020-augmented.*` instead of `system.*` — that way they
 * persist on a vanilla system whose schema would drop an unknown `system` field. `serviceModeOf` /
 * `servicePeriodOf` read those flags off either a live Item document or raw item data.
 *
 * Behaviour by class:
 *   • gear      → bought as a normal item.
 *   • recurring → bought as an item that lives on the character's Services tab; a per-service Pay
 *                 button charges its cost on demand (no scheduler in v1).
 *   • oneoff    → pay-and-confirm: deduct eurobucks + post a chat note, NO item created.
 */

export const SERVICE_MODES = ["gear", "recurring", "oneoff"];

/** A pack/source string that denotes the Rentals & Services gear list. */
const SERVICE_PACK_RE = /rental|service/i;

/** Read the module-flag service mode off an Item doc or raw item data ("" when unset). */
export function serviceModeOf(item) {
  const v = (typeof item?.getFlag === "function")
    ? item.getFlag(SCOPE, "serviceMode")
    : item?.flags?.[SCOPE]?.serviceMode;
  return String(v ?? "").trim().toLowerCase();
}

/** Read the module-flag service period off an Item doc or raw item data ("month" default). */
export function servicePeriodOf(item) {
  const v = (typeof item?.getFlag === "function")
    ? item.getFlag(SCOPE, "servicePeriod")
    : item?.flags?.[SCOPE]?.servicePeriod;
  return (typeof v === "string" && v) ? v : "month";
}

/**
 * ⛔ A SERVICE IS DECLARED, NEVER INFERRED (user ruling 2026-09-27: "adding a service should be an
 * intentional action, not something the module intuits from a keyword in the title"). Until this date
 * the classifier substring-matched item NAMES against ~100 words ("phone", "cell", "cable", "board",
 * "power", "food", "cleaning"…): a homebrew "Headphones" landed on the Services tab, every "Selling …
 * Excellent Condition" row matched "cell" inside "excellent", and a Gun Cleaning Kit bought from the
 * shop was paid for with NO item created. Measured: 66 of 722 misc items in ordinary gear packs
 * classified as services. All of that is gone. What declares a service now, in order:
 *   1. the item's own flag (`serviceMode`) — set by the GM on the item sheet, by the Services tab's
 *      "+" button, by a shop purchase (buyItem's flagPatch), or authored into a module pack source;
 *   2. the corrections registry (`module/data-corrections.js`, THE place for facts about the base
 *      system's rows we cannot edit): the Rentals & Services list is declared there row by row, and an
 *      entry-less row of that pack is a one-off, never gear — read live by `correctedServiceMode`
 *      through the document's pack or an embedded copy's `_stats.compendiumSource`;
 *   3. otherwise gear.
 * No table lives in this file: our rows declare in their pack sources, the base rows in the registry.
 */

/**
 * Classify a (catalog or embedded) item as "gear" | "recurring" | "oneoff" — by declaration only.
 * @param {Item|object} item
 * @param {string} [_packName]  kept for the callers' signature; origin is read off the document
 * @returns {"gear"|"recurring"|"oneoff"}
 */
export function classifyService(item, _packName = "") {
  const mode = serviceModeOf(item);
  if (SERVICE_MODES.includes(mode)) return mode;   // the item's own declaration wins
  const declared = correctedServiceMode(item);
  return declared || "gear";
}

/**
 * Pay for a one-off service: deduct eurobucks and post a chat note. Creates NO item.
 * @param {Actor} actor
 * @param {Item|object} source
 * @param {{unitPrice?:number, priceLabel?:string}} [opts]
 * @returns {Promise<boolean>}
 */
export async function payOneOffService(actor, source, { unitPrice, priceLabel = "" } = {}) {
  if (!actor) { ui.notifications?.warn(localize("ShopNoActor")); return false; }
  if (!canShop()) { ui.notifications?.warn(localize("ShopNotAllowed")); return false; }
  const name = source?.name ?? "service";
  // GM setup mode: free and silent, exactly as for gear (module/shop/setup-mode.js).
  const setup = isShopSetupMode();
  const cost = setup ? 0 : Math.max(0, Math.round(Number(unitPrice ?? source?.system?.cost ?? 0)));
  const funds = Number(actor.system?.eurobucks) || 0;
  if (funds < cost) {
    ui.notifications?.warn(game.i18n.format("CYBERPUNK.ShopInsufficientFunds", { name, cost, funds }));
    return false;
  }
  await actor.update({ "system.eurobucks": funds - cost });
  if (!setup) ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: game.i18n.format("CYBERPUNK.ServicePaid", { name, cost, label: priceLabel ? ` (${priceLabel})` : "" })
  });
  return true;
}

/**
 * Pay one period of a recurring service the character already has (the Services-tab Pay button).
 * Deducts the service item's cost and posts a chat note. No item is created or removed.
 * @param {Actor} actor
 * @param {Item} item   a recurring service item embedded on `actor`
 * @returns {Promise<boolean>}
 */
export async function payService(actor, item) {
  if (!actor || !item) return false;
  const cost = Math.max(0, Math.round(Number(item.system?.cost) || 0));
  const period = servicePeriodOf(item);
  const funds = Number(actor.system?.eurobucks) || 0;
  if (funds < cost) {
    ui.notifications?.warn(game.i18n.format("CYBERPUNK.ShopInsufficientFunds", { name: item.name, cost, funds }));
    return false;
  }
  await actor.update({ "system.eurobucks": funds - cost });
  ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: game.i18n.format("CYBERPUNK.ServicePaidRecurring", { name: item.name, cost, period })
  });
  return true;
}
