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

/** The filter taxonomy shown in the shop UI (top category → ordered sub-types). */
export const CATEGORIES = [
  { key: "Weapons",    subs: ["Pistols", "SMGs", "Rifles", "Shotguns", "Heavy", "Melee", "Exotic", "Other"] },
  { key: "Armor",      subs: [] },
  { key: "Ammo",       subs: [] },
  { key: "Cyberware",  subs: ["Cyberlimbs", "Cyberoptics", "Cyberaudio", "Neuralware", "Implants", "Bioware", "Fashionware", "Cyberweapons", "Other"] },
  { key: "Gear",       subs: ["Communication", "Electronics", "Entertainment", "Fashion", "Furnishing", "Medical", "Security", "Surveillance", "Tools", "Rentals & Services"] },
  { key: "Netrunning", subs: [] },
  { key: "Programs",   subs: [] },
  { key: "Vehicles",   subs: [] }
];

/** Resolve a pack name to { category, sub }. Unmapped buyable packs → Gear / Other. */
export function categoryOfPack(packName) {
  const hit = PACK_MAP[packName];
  if (hit) return { category: hit[0], sub: hit[1] };
  return { category: "Gear", sub: "Other" };
}

/** Item compendia eligible for the catalog (excludes ammo/skills/sell/MM-vehicle packs). */
export function catalogPacks() {
  return game.packs.filter(p => p.metadata?.type === "Item" && !EXCLUDED_PACKS.has(p.metadata?.name));
}
