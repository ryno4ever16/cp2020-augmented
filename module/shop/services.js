import { canShop } from "../settings.js";
import { localize } from "../utils.js";
import { isShopSetupMode } from "./setup-mode.js";

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
 *   2. the base system's Rentals & Services compendium, row by row (`RENTALS_SERVICE_MODES` below,
 *      keyed by the row's `_id`, reached through the document's pack or, for an embedded copy, the
 *      `_stats.compendiumSource` core stamps on drag-in and purchase). The pack IS the book's services
 *      list, so membership in it is the declaration; a row not in the table is a one-off (the safer,
 *      non-persistent class), never gear;
 *   3. otherwise gear.
 */
const RENTALS_PACK = "cyberpunk2020.rentalandservices";

/**
 * The base Rentals & Services pack, classified row by row (Core p.63 list; 40 rows at system 1.1.1).
 * Recurring = billed per period (housing, phone/utility/cable, plans and accounts, the monthly food
 * budgets); one-off = paid per use (rides, calls, a night's lodging, a clinic visit, a day in hospital).
 * The period rides with a recurring row where the book's isn't the default month.
 */
export const RENTALS_SERVICE_MODES = Object.freeze({
  // housing — monthly
  oN5HJZeZ4Ef4MMTY: "recurring", Odj2rS5kKKejVWVr: "recurring", a1PfGEaWAmwhvKIg: "recurring", fe2JHml3p3rOS9M3: "recurring",   // Appartment/Condo ×4
  LJ2N1CRa9q5UJjor: "recurring", JiAMrymDUuqzXH2G: "recurring", "8kMNCMooW7gID3Ki": "recurring", L9oN4cVPnGTf58fc: "recurring", // House ×4
  // plans, accounts, lines — monthly
  "3xXDt7msEp0rodwB": "recurring",   // Cell Phone Service
  LdrNwR79wlxSid09: "recurring",     // Standard Phone Service
  BUCT1O4inYF7AtU5: "recurring",     // Utilities
  g1HLhgxSH0kjlv19: "recurring",     // Cable TV
  "1wSczzdjOpEZHUG4": "recurring",   // Health Plan
  nnzTwmtbnwsuT5LH: "recurring",     // Trauma Team Acct
  "1MUFsLYenBNcW0VV": "recurring",   // CredChip Account
  // food budgets — monthly (Core p.63 prices them per month)
  nEYfvmgrG2BneL9F: "recurring",     // Kibble
  "3DKBHvIJRMQ7nz7O": "recurring",   // Generic Prepak
  kby6H8nselTicIdq: "recurring",     // Good Prepak
  sJhbh46gnrrx9NL0: "recurring",     // Fresh Food
  // per use
  "97xCt0Z74g613nHN": "oneoff",      // Taxi
  HDJMDrJwwyd7W4HF: "oneoff",        // AV-Taxi
  "2O2PlXxgAJTYbHcr": "oneoff",      // PayPhone Call
  asfDWfOJkdyTckyw: "oneoff",        // Data Term Use
  utDVxkOftG5ei4iA: "oneoff",        // Clinic Visit
  RfWVJIgFgoGgZzeo: "oneoff",        // Day in Hospital
  KdUSPc9jKlxZBYTz: "oneoff",        // Day in Intensive Care
  qyyD4zTJnXrmsIqF: "oneoff",        // Clone Limb Replacement
  ww5M1GUNlFxGQ4Ki: "oneoff",        // Mag Lev Chit
  TcE1Dce0LumTnmMt: "oneoff",        // Fastcharge
  RjIQ1XyKF8rjAF6R: "oneoff",        // Cab Hailer Activationfee
  UTQE3c98erdd4Z4z: "oneoff",        // CHOOH² (fuel, per fill)
  z2f2TvELHm3t1YCs: "oneoff",        // Air
  ayf8BevRGNfVDW43: "oneoff", UMgA64Ze5RUNqVkC: "oneoff", ox0PovQuEYpxgXnj: "oneoff", kzxa75xkXUJtfvnJ: "oneoff", // Hotel Room ×4 (per night)
  MV0opo466kDttaku: "oneoff", "7ynv1iRjCVS6tKqT": "oneoff", c2NLex4kqxhj5c88: "oneoff", YEsC8bdEgXNZsvYc: "oneoff", // Coffin ×4 (per night)
});

/**
 * Which base-pack row an item IS: `{pack, id}` for a compendium document, or for an embedded copy the
 * row it was made from (`_stats.compendiumSource`, "Compendium.<pack>.Item.<id>"). Null when neither.
 */
export function compendiumRowOf(item) {
  const pack = item?.pack ?? item?.collection?.metadata?.id ?? null;
  const id = item?.id ?? item?._id ?? null;
  if (pack && id && !item?.parent) return { pack: String(pack), id: String(id) };
  const src = String(item?._stats?.compendiumSource ?? item?._source?._stats?.compendiumSource ?? "");
  const m = /^Compendium\.([^.]+\.[^.]+)\.Item\.([A-Za-z0-9]+)$/.exec(src);
  return m ? { pack: m[1], id: m[2] } : null;
}

/**
 * Classify a (catalog or embedded) item as "gear" | "recurring" | "oneoff" — by declaration only.
 * @param {Item|object} item
 * @param {string} [_packName]  kept for the callers' signature; the pack is read off the document
 * @returns {"gear"|"recurring"|"oneoff"}
 */
export function classifyService(item, _packName = "") {
  const mode = serviceModeOf(item);
  if (SERVICE_MODES.includes(mode)) return mode;   // the item's own declaration wins
  const row = compendiumRowOf(item);
  if (row?.pack === RENTALS_PACK) return RENTALS_SERVICE_MODES[row.id] ?? "oneoff";
  return "gear";
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
