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

/** pack name → { category, sub }. Unmapped buyable packs fall back to { Gear, Other }. */
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
  { key: "Cyberware",  subs: ["Cyberlimbs", "Cyberoptics", "Cyberaudio", "Neuralware", "Implants", "Bioware", "Fashionware", "Cyberweapons", "Other"] },
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
  ["Watercraft", /submarine|submersible|\bsub\b|boat|\bship\b|watercraft|hydrofoil|jet.?ski|yacht|naval/],
  ["Spacecraft", /space|orbit|shuttle/],
  ["Cycles",     /cycle|\bbike\b|trike/],
  ["Trucks",     /truck|\bsemi\b|hauler|prime mover|tractor|bulldozer|construction|crane|earthmover|\b\dx\d\b/],
  ["Cars",       /car\b|sedan|coupe|limo|taxi|\bcab\b|\bvan\b|wagon|jeep|buggy|roadster|convertible|hatchback|pickup|\batv\b|utility/],
];
export function vehicleSubOf(vehicleType) {
  const t = String(vehicleType ?? "").trim().toLowerCase();
  if (!t) return "";
  for (const [sub, re] of VEHICLE_SUB_RULES) if (re.test(t)) return sub;
  return "Other";
}

/** Resolve a pack name to { category, sub }. Unmapped buyable packs → Gear / Other. */
export function categoryOfPack(packName) {
  const hit = PACK_MAP[packName];
  if (hit) return { category: hit[0], sub: hit[1] };
  return { category: "Gear", sub: "Other" };
}

/** True when the pack is explicitly mapped (legacy packs categorize by pack identity, one cat/sub each). */
export function isMappedPack(packName) {
  return Object.prototype.hasOwnProperty.call(PACK_MAP, packName);
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
export function categoryOfItem(type, system = {}) {
  switch (type) {
    case "weapon":    return { category: "Weapons", sub: WEAPON_TYPE_SUB[system?.weaponType] ?? "Other" };
    case "armor":     return { category: "Armor", sub: "" };
    case "vehicle":   return { category: "Vehicles", sub: vehicleSubOf(system?.vehicleType) };
    case "program":   return { category: "Programs", sub: "" };
    case "cyberware": return { category: "Cyberware", sub: "Other" };
    default:          return { category: "Gear", sub: "Other" };
  }
}

/** Item compendia eligible for the catalog (excludes ammo/skills/sell/MM-vehicle packs). */
export function catalogPacks() {
  return game.packs.filter(p => p.metadata?.type === "Item" && !EXCLUDED_PACKS.has(p.metadata?.name));
}
