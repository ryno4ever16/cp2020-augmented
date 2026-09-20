/**
 * THE SPELLINGS THE SHEET ENUMS DO NOT KNOW, AND WHAT THEY MEAN. Pure — no game, no i18n.
 *
 * Two sources write weapon fields in spellings the sheet selects do not offer:
 *  - the base system's own DEFAULT_WEAPON (module/data/item-data.js): `reliability: "ST"`,
 *    `concealability: "P"`, `availability: "common"` — every weapon created from scratch starts there;
 *  - the base system's 2025 packs: `"standard"`, `"very reliable"`, `"jacket"`, `"long coat"`,
 *    `"undefined"` placeholders.
 * A select with no blank option rendered any of them as its FIRST option and the next submit saved
 * it — Very Reliable, Pocket, Excellent — silently, in users' worlds (found 2026-09-19). These maps
 * are the reading that turns each spelling into the value the enum, the math and the sheet all mean.
 * An unknown spelling maps to null: never guessed, left as it is.
 */

const RELIABILITY = {
  veryreliable: "VeryReliable", very: "VeryReliable", vr: "VeryReliable",
  standard: "Standard", st: "Standard",
  unreliable: "Unreliable", ur: "Unreliable",
};
const CONCEALABILITY = {
  concealpocket: "ConcealPocket", pocket: "ConcealPocket", p: "ConcealPocket",
  concealjacket: "ConcealJacket", jacket: "ConcealJacket", j: "ConcealJacket",
  conceallongcoat: "ConcealLongcoat", longcoat: "ConcealLongcoat", l: "ConcealLongcoat",
  concealnohide: "ConcealNoHide", nohide: "ConcealNoHide", n: "ConcealNoHide",
};
const AVAILABILITY = {
  excellent: "Excellent", e: "Excellent",
  common: "Common", c: "Common",
  poor: "Poor", p: "Poor",
  rare: "Rare", r: "Rare",
};
/** Placeholder text meaning "no value was authored here" → a clean blank. */
const PLACEHOLDERS = new Set(["undefined", "null", "none", "n/a", "na"]);

const key = (v) => String(v ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");

/** The enum value for a stored reliability, or null when unrecognised. An enum value answers itself. */
export function canonicalReliability(value) {
  const k = key(value);
  return k ? (RELIABILITY[k] ?? null) : null;
}
/** The enum value for a stored concealability, or null when unrecognised. */
export function canonicalConcealability(value) {
  const k = key(value);
  return k ? (CONCEALABILITY[k] ?? null) : null;
}
/** The enum value for a stored availability; "" for a placeholder; null when unrecognised. */
export function canonicalAvailability(value) {
  const k = key(value);
  if (!k) return null;
  if (PLACEHOLDERS.has(k)) return "";
  return AVAILABILITY[k] ?? null;
}

/**
 * The changes a weapon `system` block needs so its three enum fields read as the enum — an object of
 * field → canonical value for every field whose stored spelling is recognised AND differs, or an
 * empty object. Fields absent from `system` are ignored (a partial update carries only what changed).
 */
export function canonicalWeaponEnums(system) {
  const out = {};
  if (!system || typeof system !== "object") return out;
  if (system.reliability !== undefined) {
    const c = canonicalReliability(system.reliability);
    if (c !== null && c !== system.reliability) out.reliability = c;
  }
  if (system.concealability !== undefined) {
    const c = canonicalConcealability(system.concealability);
    if (c !== null && c !== system.concealability) out.concealability = c;
  }
  if (system.availability !== undefined) {
    const c = canonicalAvailability(system.availability);
    if (c !== null && c !== system.availability) out.availability = c;
  }
  return out;
}
