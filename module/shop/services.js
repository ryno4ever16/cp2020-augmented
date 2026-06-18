import { canShop } from "../settings.js";
import { localize } from "../utils.js";

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

// ONE-OFF is checked BEFORE recurring so a per-use item that also contains a recurring-ish word
// (e.g. "PayPhone Call" — has "phone" but is billed per call) resolves correctly.

/** Names that read as a single transaction → one-off service (pay-and-confirm). */
const ONEOFF_KEYWORDS = [
  "taxi", "cab ", "fare", "ride", "ticket", "fee", "visit", "exam", "checkup",
  "meal", "drink", "dinner", "lunch", "breakfast", "restaurant", "fast food", "food", "prepak", "kibble",
  "clinic", "treatment", "session", "surgery", "repair", "cleaning", "laundry",
  "haircut", "tattoo", "bribe", "cover charge", "admission", "per day", "per mile",
  "per hour", "day rate", "hire", "charter", "rental car", "courier", "delivery",
  "translation", "forgery", "bail", "fine", "toll", "passage",
  // per-use / per-night lodging / per-call (vs the ongoing arrangements below)
  "call", "hotel", "motel", "coffin", "chit", "fastcharge", "day in", "clone"
];

/** Names that read as an ongoing, billed-over-time arrangement → recurring. */
const RECURRING_KEYWORDS = [
  "rent", "lease", "apartment", "appartment", "house", "housing", "condo", "studio", "mortgage",
  "phone", "cell", "cellular", "beeper", "pager", "subscription", "subscript",
  "plan", "insurance", "policy", "premium", "trauma team", "medical plan", "health",
  "membership", "gym", "club dues", "dues", "retainer", "salary", "wage", "upkeep",
  "utilities", "utility", "power", "water", "cable", "net link", "netlink", "data link",
  "account", "acct", "service contract", "maintenance contract", "bodyguard", "agent", "manager",
  "storage", "garage", "parking", "lodging", "board", "fee/month", "per month", "monthly"
];

/**
 * Classify a (catalog or embedded) item as "gear" | "recurring" | "oneoff".
 * @param {Item|object} item
 * @param {string} [packName]  the compendium pack name/label, when known (catalog browsing)
 * @returns {"gear"|"recurring"|"oneoff"}
 */
export function classifyService(item, packName = "") {
  const mode = serviceModeOf(item);
  if (SERVICE_MODES.includes(mode)) return mode;   // explicit override wins

  const name = String(item?.name ?? "").toLowerCase();
  const source = String(item?.system?.source ?? "").toLowerCase();
  const inServicePack = SERVICE_PACK_RE.test(packName) || SERVICE_PACK_RE.test(source);

  // Keyword sense (works for embedded items with no pack context). One-off is tested first so a
  // per-use item that also contains a recurring word (e.g. "PayPhone Call") resolves correctly.
  if (ONEOFF_KEYWORDS.some(k => name.includes(k))) return "oneoff";
  if (RECURRING_KEYWORDS.some(k => name.includes(k))) return "recurring";
  // Otherwise: an item from the Rentals & Services list with no clear keyword defaults to one-off
  // (the safer, non-persistent option); anything else is plain gear.
  return inServicePack ? "oneoff" : "gear";
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
  const cost = Math.max(0, Math.round(Number(unitPrice ?? source?.system?.cost ?? 0)));
  const funds = Number(actor.system?.eurobucks) || 0;
  if (funds < cost) {
    ui.notifications?.warn(game.i18n.format("CYBERPUNK.ShopInsufficientFunds", { name, cost, funds }));
    return false;
  }
  await actor.update({ "system.eurobucks": funds - cost });
  ChatMessage.create({
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
