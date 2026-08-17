/**
 * Catalog category taxonomy ([[shopping-design]]). Two-level: top category → sub-type, mapped from
 * the compendium pack an item lives in. Drives the shop's inclusive category filters. Items default
 * into one searchable pool; selecting filters narrows it.
 */

/** Packs that are NOT personal-shop goods (handled elsewhere or not purchasable). */
export const EXCLUDED_PACKS = new Set([
  "ammo",            // the catalog generates clean caliber rows (box pricing) instead of raw ammo items
  "sellthedead",     // body bank — a SELL feature, not buy
  "vehicle-weapons", // Maximum Metal: built onto vehicles, not personal shopping
  "acpa-systems",    // Maximum Metal: built onto ACPA suits
  "default-skills-en", "default-skills-ru", "role-skills-en", "role-skills-ru" // skills aren't goods
]);

/** Belt-and-suspenders: item types never sold in the shop. */
export const EXCLUDED_TYPES = new Set(["skill", "ammo"]);

/**
 * The imported supplement compendia are named `supplement-<thing>` after the same `<thing>` the base
 * system's own packs are named for — `supplement-pistols` beside `pistols`, `supplement-chipware`
 * beside the chipware shelf. Stripping the prefix before the lookup is therefore the whole mapping:
 * one table serves both halves of the installation, and a pack added on either side is picked up by
 * name rather than by a second, drifting copy of the table.
 */
const SUPPLEMENT_PREFIX = "supplement-";
export function normalizePackName(packName) {
  const n = String(packName ?? "");
  return n.startsWith(SUPPLEMENT_PREFIX) ? n.slice(SUPPLEMENT_PREFIX.length) : n;
}

/**
 * pack name → { category, sub }. Unmapped buyable packs fall back to { Gear, Other }.
 *
 * A "" sub means the pack names a CATEGORY but not a shelf within it: those packs are resolved
 * per item (see resolveCategory), so a vehicle's class and a chip's cyberware type still decide
 * where the item lands. A named sub is authoritative for the whole pack — that is what makes
 * `supplement-exotics` file as Exotic even for the handful of rows whose own `weaponType` says
 * Pistol, which is the pack's editorial judgement and the one the shelf should follow.
 */
const PACK_MAP = {
  // Weapons
  "pistols": ["Weapons", "Pistols"],
  "submachineguns": ["Weapons", "SMGs"],
  "rifles": ["Weapons", "Rifles"],
  "shotguns": ["Weapons", "Shotguns"],
  "heavy": ["Weapons", "Heavy"],
  "melee": ["Weapons", "Melee"],
  "exotics": ["Weapons", "Exotic"],
  "weapons-community": ["Weapons", "Other"], "weapons-noncanon": ["Weapons", "Other"],
  // Armor
  "armor": ["Armor", ""],
  // Cyberware
  "cyberlimbs": ["Cyberware", "Cyberlimbs"],
  "cyberoptic": ["Cyberware", "Cyberoptics"],
  "cyberaudio": ["Cyberware", "Cyberaudio"],
  "neuralware": ["Cyberware", "Neuralware"],
  "implants": ["Cyberware", "Implants"],
  "bioware": ["Cyberware", "Bioware"],
  "fashonware": ["Cyberware", "Fashionware"],
  "cyberweapons": ["Cyberware", "Cyberweapons"],
  "cyberware-old": ["Cyberware", "Other"], "other-cyberware": ["Cyberware", "Other"], "cyberware-noncanon": ["Cyberware", "Other"],
  // The supplement chrome packs: one is all skill chips, the other is mixed chrome whose shelf is
  // still decided per item (the "" sub), so a borg body and the chips filed among it keep their own.
  "chipware": ["Cyberware", "Chipware"],
  "cyberware": ["Cyberware", ""],
  // Gear (the 2020 Gear-List sub-categories)
  "communication": ["Gear", "Communication"],
  "electronics": ["Gear", "Electronics"],
  "entertainment": ["Gear", "Entertainment"],
  "fashion": ["Gear", "Fashion"],
  "furnishing": ["Gear", "Furnishing"],
  "medical": ["Gear", "Medical"],
  "security": ["Gear", "Security"],
  "surveillance": ["Gear", "Surveillance"],
  "tools": ["Gear", "Tools"],
  "rentalandservices": ["Gear", "Rentals & Services"],
  // The supplement gear pack is one undifferentiated shelf in the books it came from, so it stays one.
  "gear": ["Gear", "Other"],
  // Standalone categories
  "netrunningEquipment": ["Netrunning", ""],
  "programs": ["Programs", ""],
  "vehicles": ["Vehicles", ""]
};

/** Vehicles sub-filters (display order: ground → air → water → space → military → unmanned). */
const VEHICLE_SUBS = ["Cars", "Cycles", "Trucks", "AVs", "Aircraft", "Hover", "Watercraft", "Spacecraft", "Military", "Drones", "ACPA", "Other"];

/** The filter taxonomy shown in the shop UI (top category → ordered sub-types). */
export const CATEGORIES = [
  { key: "Weapons",    subs: ["Pistols", "SMGs", "Rifles", "Shotguns", "Heavy", "Melee", "Exotic", "Other"] },
  { key: "Armor",      subs: [] },
  { key: "Ammo",       subs: [] },
  { key: "Cyberware",  subs: ["Cyberlimbs", "Cyberoptics", "Cyberaudio", "Neuralware", "Implants", "Bioware", "Fashionware", "Cyberweapons", "Chipware", "Other"] },
  { key: "FBC",        subs: [] },
  { key: "Gear",       subs: ["Communication", "Electronics", "Entertainment", "Fashion", "Furnishing", "Medical", "Security", "Surveillance", "Tools", "Rentals & Services"] },
  { key: "Netrunning", subs: [] },
  { key: "Programs",   subs: [] },
  { key: "Vehicles",   subs: VEHICLE_SUBS }
];

/**
 * system.vehicleType (a SOFT enum — free text with datalist suggestions) → Vehicles sub-filter.
 * Keyword rules over the books' own class vocabulary; FIRST match wins, so locomotion outranks
 * role ("Hover Tank" is a hovercraft — MM panzers — not Military). Blank stays "" (unclassified:
 * no data is not a class), a non-empty class no rule knows lands in "Other".
 */
const VEHICLE_SUB_RULES = [
  ["ACPA",       /acpa|powered? armou?r/],
  ["Drones",     /rpv|drone|remote/],
  ["Hover",      /hover|panzer|\bgev\b|plenum|ground.effect/],
  ["Military",   /\btank\b|\bapc\b|\bifv\b|\bafv\b|\bmbt\b|acav|artillery/],
  ["AVs",        /aerodyne|\bavs?\b|aircar/],
  ["Aircraft",   /helicopter|gunship|chopper|tilt.?rotor|tilt.?wing|osprey|dirigible|airship|blimp|zeppelin|ultralight|microlight|autogyro|fixed.?wing|plane\b|\bjet\b|fighter|bomber|aircraft|vtol/],
  ["Watercraft", /submarine|submersible|battlesub|\bsub\b|aqua|boat|\bship\b|watercraft|hydrofoil|jet.?ski|yacht|naval/],
  ["Spacecraft", /space|orbit|shuttle/],
  ["Cycles",     /cycle|\bbike\b|trike/],
  // "pickup" lives with Trucks (runs before Cars) so a bare "Pickup" and a "Pickup truck" file together.
  ["Trucks",     /truck|pickup|\bsemi\b|hauler|prime mover|tractor|bulldozer|construction|crane|earthmover|\b\dx\d\b/],
  ["Cars",       /car\b|sedan|coupe|limo|taxi|\bcab\b|\bvan\b|wagon|jeep|buggy|roadster|convertible|hatchback|\brv\b|\batv\b|utility/],
];
export function vehicleSubOf(vehicleType) {
  const t = String(vehicleType ?? "").trim().toLowerCase();
  if (!t) return "";
  for (const [sub, re] of VEHICLE_SUB_RULES) if (re.test(t)) return sub;
  return "Other";
}

/** Resolve a pack name to { category, sub }. Unmapped buyable packs → Gear / Other. */
export function categoryOfPack(packName) {
  const hit = PACK_MAP[normalizePackName(packName)];
  if (hit) return { category: hit[0], sub: hit[1] };
  return { category: "Gear", sub: "Other" };
}

/** True when the pack is explicitly mapped (legacy packs categorize by pack identity, one cat/sub each). */
export function isMappedPack(packName) {
  return Object.prototype.hasOwnProperty.call(PACK_MAP, normalizePackName(packName));
}

/** Weapon system.weaponType → Weapons sub-filter (for type-grouped packs). */
const WEAPON_TYPE_SUB = {
  Pistol: "Pistols", SMG: "SMGs", Rifle: "Rifles", Shotgun: "Shotguns",
  Heavy: "Heavy", Melee: "Melee", Exotic: "Exotic"
};

/**
 * Resolve { category, sub } from an item's OWN data, for packs not in PACK_MAP — e.g. the imported
 * `supplement-*` packs, which are grouped by item TYPE rather than by the fine-grained legacy pack
 * identity. Weapons sub-categorize by system.weaponType; everything else maps from the item type.
 * This is strictly finer than the old blanket Gear/Other fallback for unmapped packs.
 */
export function categoryOfItem(type, system = {}, flags = {}) {
  // A full-conversion borg body (the borgBody flag) gets its own top-level category — checked ahead of
  // the by-type switch so the body lands in FBC regardless of how its cyberware type is set. Keyed on
  // `.sdp` to match borg.js borgBodyOf's own validity test.
  if (flags?.["cp2020-augmented"]?.borgBody?.sdp) return { category: "FBC", sub: "" };
  switch (type) {
    case "weapon":    return { category: "Weapons", sub: WEAPON_TYPE_SUB[system?.weaponType] ?? "Other" };
    case "armor":     return { category: "Armor", sub: "" };
    case "vehicle":   return { category: "Vehicles", sub: vehicleSubOf(system?.vehicleType) };
    case "program":   return { category: "Programs", sub: "" };
    // Skill chips carry cyberwareType CHIPWARE (the supplement-chipware pack + strays elsewhere).
    case "cyberware": return { category: "Cyberware", sub: String(system?.cyberwareType ?? "").toUpperCase() === "CHIPWARE" ? "Chipware" : "Other" };
    default:          return { category: "Gear", sub: "Other" };
  }
}

/**
 * THE ONE PLACE a catalog row's cell is decided, in the order the three sources of truth outrank
 * each other. Split out of the index build so the precedence is stated once, is pure, and can be
 * asserted directly.
 *
 *   1. A full-conversion borg body is FBC wherever it is filed — the flag beats every pack.
 *   2. A pack whose identity names a SHELF is authoritative for everything in it. The pack was
 *      curated by hand; an item's own `weaponType` is data that was scraped, and where the two
 *      disagree the curation is the better answer (a pistol filed in the Exotic pack is filed
 *      there on purpose).
 *   3. Otherwise the item's own data decides — the vehicle class, the chipware flag, the weapon
 *      type. When the pack named a CATEGORY but no shelf, the pack keeps the category and the item
 *      supplies only the shelf, so a stray misc row in a chrome pack cannot escape into Gear.
 *
 * @param {string} packName  the pack's short name (with or without the supplement- prefix)
 * @returns {{category: string, sub: string}}
 */
export function resolveCategory(packName, type, system = {}, flags = {}) {
  if (flags?.["cp2020-augmented"]?.borgBody?.sdp) return { category: "FBC", sub: "" };
  const mapped = PACK_MAP[normalizePackName(packName)];
  if (mapped && mapped[1]) return { category: mapped[0], sub: mapped[1] };
  const byItem = categoryOfItem(type, system, flags);
  if (mapped) return { category: mapped[0], sub: byItem.category === mapped[0] ? byItem.sub : "" };
  return byItem;
}

/** Item compendia eligible for the catalog (excludes ammo/skills/sell/MM-vehicle packs). */
export function catalogPacks() {
  return game.packs.filter(p => p.metadata?.type === "Item" && !EXCLUDED_PACKS.has(p.metadata?.name));
}
