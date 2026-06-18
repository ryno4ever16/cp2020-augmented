/**
 * Custom shops as WORLD DATA ([[shopping-design]] round-7). Shops are no longer Actors — each shop is
 * a plain object ("ShopDef") stored in the world setting `shops` ({ [id]: ShopDef }). The GM owns the
 * setting (only GMs can write world settings); every client can READ it, so players see published
 * shops. Player purchases charge the player's own actor and RELAY the stock decrement to the GM (who
 * writes the setting) via the socket in catalog.js.
 *
 * ShopDef = {
 *   id, name, notes,
 *   open:        boolean,                 // visible/buyable to players
 *   fullSearch:  boolean,                 // players may browse the whole catalog (curated = featured)
 *   discountPct: number,                  // 0..100 shop-wide discount the GM can nudge live
 *   publishedTo: "all" | string[],        // which players see it when open (default "all")
 *   items: { [sourceKey]: ShopItem }      // sourceKey = "packId.itemId"
 * }
 * ShopItem = { price: number|null, unlimited: boolean, qty: number, style: string|null }
 *   style = a FASHION_STYLES key (clothing only — Gear/Fashion); null = Generic (×1) / not clothing.
 */

const SCOPE = "cp2020-augmented";
const KEY = "shops";

/** Default fields merged onto any ShopDef read (forward-compatible if the shape grows). */
function _normalizeDef(id, raw) {
  const d = raw ?? {};
  return {
    id,
    name: typeof d.name === "string" ? d.name : "Shop",
    notes: typeof d.notes === "string" ? d.notes : "",
    open: d.open === true,
    fullSearch: d.fullSearch === true,
    discountPct: Math.min(100, Math.max(0, Number(d.discountPct) || 0)),
    publishedTo: Array.isArray(d.publishedTo) ? d.publishedTo : "all",
    items: (d.items && typeof d.items === "object") ? d.items : {}
  };
}

/** Normalize a single stock entry. Missing flag = unlimited (safe default). */
export function normalizeShopItem(raw) {
  const e = raw ?? {};
  // price is an OPTIONAL override: null/undefined/"" → no override (use catalog cost). Only a real
  // number sets it. (Number(null) is 0 — must NOT treat that as a 0eb override, or items go free.)
  let price = null;
  if (e.price !== null && e.price !== undefined && e.price !== "") {
    const n = Number(e.price);
    if (Number.isFinite(n)) price = Math.max(0, Math.round(n));
  }
  // style = a clothing style-tier key (Gear/Fashion only); null = Generic / not clothing. (Replaces the
  // old boolean `fashion` flag — style pricing is now category-derived + GM-set per clothing item.)
  return {
    price,
    unlimited: e.unlimited !== false,
    qty: Math.max(0, Math.floor(Number(e.qty) || 0)),
    style: typeof e.style === "string" && e.style ? e.style : null
  };
}

/** Raw setting map (defensive: always an object). */
function _rawMap() {
  try { return game.settings.get(SCOPE, KEY) || {}; } catch { return {}; }
}

/** All shops, normalized, as a { [id]: ShopDef } map. */
export function getShops() {
  const raw = _rawMap();
  const out = {};
  for (const [id, def] of Object.entries(raw)) out[id] = _normalizeDef(id, def);
  return out;
}

/** A single shop by id (normalized) or null. */
export function getShop(id) {
  const raw = _rawMap();
  return raw[id] ? _normalizeDef(id, raw[id]) : null;
}

/** Shops as an array, sorted by name. */
export function listShops() {
  return Object.values(getShops()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Shops a given user may SEE (GM sees all; players see open + published-to-them). */
export function shopsVisibleTo(user = game.user) {
  const all = listShops();
  if (user?.isGM) return all;
  return all.filter(s => s.open && (s.publishedTo === "all" || (Array.isArray(s.publishedTo) && s.publishedTo.includes(user.id))));
}

/** Persist the whole map (GM only). */
async function _save(map) {
  if (!game.user.isGM) { console.warn("cp2020-augmented | non-GM tried to write shops"); return false; }
  try { await game.settings.set(SCOPE, KEY, map); return true; }
  catch (e) { console.error("cp2020-augmented | failed to save shops", e); return false; }
}

/** Create a new shop; returns its ShopDef (GM only). */
export async function createShop({ name } = {}) {
  if (!game.user.isGM) return null;
  const id = foundry.utils.randomID();
  const map = _rawMap();
  map[id] = _normalizeDef(id, { name: name?.trim() || game.i18n.localize("CYBERPUNK.ShopNewDefault") });
  await _save(map);
  return getShop(id);
}

/** Shallow-merge a patch onto a shop's top-level fields (GM only). */
export async function updateShop(id, patch = {}) {
  const map = _rawMap();
  if (!map[id]) return false;
  map[id] = { ..._normalizeDef(id, map[id]), ...patch };
  // never let the merge clobber the items map with undefined
  if (!map[id].items || typeof map[id].items !== "object") map[id].items = {};
  return _save(map);
}

/** Delete a shop (GM only). */
export async function deleteShop(id) {
  const map = _rawMap();
  if (!map[id]) return false;
  delete map[id];
  return _save(map);
}

/** Duplicate a shop (name + " (Copy)"), returns the new ShopDef (GM only). */
export async function duplicateShop(id) {
  const src = getShop(id);
  if (!src || !game.user.isGM) return null;
  const newId = foundry.utils.randomID();
  const map = _rawMap();
  map[newId] = { ...foundry.utils.deepClone(src), id: newId, name: `${src.name} (Copy)`, open: false };
  await _save(map);
  return getShop(newId);
}

/** Add a catalog item (by sourceKey) to a shop with default stock (GM only). No-op if already present. */
export async function addShopItem(id, sourceKey) {
  const map = _rawMap();
  if (!map[id] || !sourceKey) return false;
  map[id].items = map[id].items ?? {};
  if (map[id].items[sourceKey]) return false;
  map[id].items[sourceKey] = normalizeShopItem({ unlimited: true, qty: 0, price: null });
  return _save(map);
}

/** Add many sourceKeys at once (bulk "Add all shown"); returns the count added (GM only). */
export async function addShopItems(id, entries = []) {
  const map = _rawMap();
  if (!map[id]) return 0;
  map[id].items = map[id].items ?? {};
  let n = 0;
  for (const e of entries) {
    const sk = typeof e === "string" ? e : e?.sourceKey;
    if (!sk || map[id].items[sk]) continue;
    map[id].items[sk] = normalizeShopItem({ unlimited: true, qty: 0, price: null });
    n++;
  }
  if (n) await _save(map);
  return n;
}

/** Remove a stocked item from a shop (GM only). */
export async function removeShopItem(id, sourceKey) {
  const map = _rawMap();
  if (!map[id]?.items?.[sourceKey]) return false;
  delete map[id].items[sourceKey];
  return _save(map);
}

/** Remove ALL stocked items from a shop, returning the count removed (GM only). */
export async function clearShopItems(id) {
  const map = _rawMap();
  if (!map[id]) return 0;
  const n = Object.keys(map[id].items ?? {}).length;
  map[id].items = {};
  if (n) await _save(map);
  return n;
}

/** Patch a stocked item's metadata (price/unlimited/qty/style) (GM only). */
export async function setShopItem(id, sourceKey, patch = {}) {
  const map = _rawMap();
  if (!map[id]?.items?.[sourceKey]) return false;
  map[id].items[sourceKey] = normalizeShopItem({ ...map[id].items[sourceKey], ...patch });
  return _save(map);
}

/** Apply a stock patch ({unlimited?, qty?}) to EVERY item in a shop ("Set all"); count touched (GM only). */
export async function setAllShopStock(id, patch = {}) {
  const map = _rawMap();
  const items = map[id]?.items;
  if (!items) return 0;
  const keys = Object.keys(items);
  for (const sk of keys) items[sk] = normalizeShopItem({ ...items[sk], ...patch });
  if (keys.length) await _save(map);
  return keys.length;
}

/** Decrement a stocked item's quantity (used by the GM relay when a player buys) (GM only). */
export async function decrementShopStock(id, sourceKey, by = 1) {
  const map = _rawMap();
  const e = map[id]?.items?.[sourceKey];
  if (!e || e.unlimited === true) return false;
  e.qty = Math.max(0, (Math.floor(Number(e.qty)) || 0) - (Math.floor(Number(by)) || 1));
  return _save(map);
}

/**
 * Effective unit price for a stocked item: (per-item override OR catalog cost) × style × shop discount.
 * @param {ShopDef} def
 * @param {string} sourceKey
 * @param {number} catalogCost
 * @param {number} [styleMult=1]
 * @returns {number}
 */
export function effectivePrice(def, sourceKey, catalogCost, styleMult = 1) {
  const e = normalizeShopItem(def?.items?.[sourceKey]);
  const base = e.price != null ? e.price : (Number(catalogCost) || 0);
  const disc = 1 - (Math.min(100, Math.max(0, Number(def?.discountPct) || 0)) / 100);
  return Math.max(0, Math.round(base * (Number(styleMult) || 1) * disc));
}

// NOTE: the base system's one-time `shop`-Actor → ShopDef migration is intentionally NOT ported. The
// module never shipped a `shop` Actor type, so there is nothing to migrate; shops are world-data from
// the first install (see the `shops` world setting).
