// This is where all the magic values go, because cyberpunk has SO many of those
// Any given string value is the same as its key in the localization file, and will be used for translation
import { cloneSystemDefault, DEFAULT_HIT_LOCATIONS, STAT_KEYS } from "./constants.js";
import { apiHelper } from "./system-api.js";

// Prefer the base system's lookup helpers (game.cyberpunk.api.lookups) at call time; fall back to the
// local copies (the _-prefixed functions below). See module/system-api.js. (Data tables stay local.)
export const defaultHitLocations       = apiHelper("lookups", "defaultHitLocations", _defaultHitLocations);
export const strengthDamageBonus       = apiHelper("lookups", "strengthDamageBonus", _strengthDamageBonus);
export const isFnff2Enabled            = apiHelper("lookups", "isFnff2Enabled", _isFnff2Enabled);
export const getFnff2DamageBonusSymbol = apiHelper("lookups", "getFnff2DamageBonusSymbol", _getFnff2DamageBonusSymbol);
export const getMartialActionBonus     = apiHelper("lookups", "getMartialActionBonus", _getMartialActionBonus);

// Module flag / settings scope (per-file convention used across the module).
const SCOPE = "cp2020-augmented";

export let weaponTypes = {
    pistol: "Pistol",
    submachinegun: "SMG",
    shotgun: "Shotgun",
    rifle: "Rifle",
    heavy: "Heavy",
    melee: "Melee",
    exotic: "Exotic"
}
export let attackSkills = {
    "Pistol": ["Handgun"],
    "SMG": ["Submachinegun"],
    "Shotgun": ["Rifle"],
    // "Rifle": [localize("Rifle")],
    "Rifle": ["Rifle"],
    "Heavy": ["HeavyWeapons"],
    // Trained martial arts get added in item-sheet for now
    "Melee": ["Fencing", "Melee", "Brawling"],
    // No limitations for exotic, go nuts
    "Exotic": []
}

export function getStatNames() {
  return [...STAT_KEYS];
}

// How a weapon attacks. Something like pistol or an SMG have rigid rules on how they can attack, but shotguns can be regular or auto shotgun, exotic can be laser, etc. So this is for weird and special stuff that isn't necessarily covered by the weapon's type or other information
// If we change attack type to be an array, we could say, have ["BEAM" "LASER"]
export let rangedAttackTypes = {
    semiAuto: "SemiAuto",
    auto: "Auto",
    // Strange ranged weapons
    paint: "Paint",
    drugs: "Drugs",
    acid: "Acid",
    taser: "Taser",
    dart: "Dart",
    squirt: "Squirt",
    throwable: "Throw",
    archer: "Archer",
    // Beam weapons
    laser: "Laser",
    microwave: "Microwave",
    // Area effect weapons
    shotgun: "Shotgun",
    autoshotgun: "Autoshotgun",
    grenade: "Grenade", // Separate entry from throwable because grenades have different throw distance
    gas: "Gas",
    flamethrow: "Flamethrow",
    landmine: "Landmine",
    claymore: "Claymore",
    rpg: "RPG", // Fired same as with other grenade launchers or shoulder mounts, so not sure if should be here,
    missile: "Missile",
    explosiveCharge: "Explocharge"
}

/**
 * Beam/energy weapons (laser, microwave) recharge from a power source instead of consuming
 * ammunition — CP2020 (FNFF): "Like lasers, microwavers recharge from a wall socket." They keep a
 * finite shot pool but are reloaded by recharging (no ammo item / no purchase). Keyed off attackType,
 * so it ignores the weapon's (often "Special"/blank) ammoType.
 * @param {string} attackType  the weapon's system.attackType
 * @returns {boolean}
 */
export function isEnergyAttackType(attackType) {
  const a = String(attackType ?? "").toLowerCase();
  return a === "laser" || a === "microwave";
}

export let meleeAttackTypes = {
    melee: "Melee", // Regular melee bonk
    mono: "Mono", // Monokatanas, etc
    martial: "Martial", // Martial arts! Here, the chosen attack skill does not matter
    cyberbeast: "Beast"
}

// There's a lot of these, so here's a sorted one for convenience 
export let sortedAttackTypes = Object.values(rangedAttackTypes).concat(Object.values(meleeAttackTypes)).sort();

// These are preceded by Conceal, as for example, conceal Jacket is in fact supposed to show "Jacket/Coat/Shoulder Rig", so just "Jacket" doesn't make sense
export let concealability = {
    pocket: "ConcealPocket",
    jacket: "ConcealJacket",
    longcoat: "ConcealLongcoat",
    noHide: "ConcealNoHide"
}

export let availability = {
    excellent: "Excellent",
    common: "Common",
    poor: "Poor",
    rare: "Rare"
}

export let reliability = {
    very: "VeryReliable",
    standard: "Standard",
    unreliable: "Unreliable"
}

export let fireModes = {
    fullAuto: "FullAuto",
    threeRoundBurst: "ThreeRoundBurst",
    suppressive: "Suppressive",
    // Really semi auto is any none auto with RoF with more than 1
    semiAuto: "SemiAuto"
}

/* ──────────────────────────────────────────────────────────────────────────
 * AMMUNITION: types (calibers) + modifiers (loads)
 *
 * CP2020 ammo has two axes:
 *   - TYPE (caliber): what a weapon accepts (weapon.system.ammoType), e.g. "9mm".
 *   - MODIFIER (load): how the round behaves and what it costs, e.g. AP / Hollow-Point.
 *
 * Box size & price come from the caliber's COST CLASS (CP2020 Core "Reloads & Options");
 * the modifier applies a cost multiplier. Two optional settings switch firearm pricing to
 * Blackhand's Guide conventions (uniform box-of-100; brass ×3).
 * Sources: CP2020 Core; Reference Book (7.62 NATO vs 7.62 Soviet); Blackhand's Guide
 * (consolidating Cyberpunk 2020 + Chromebook 1 & 2) for modifier cost multipliers.
 * ────────────────────────────────────────────────────────────────────────── */

// Per-class box size / price. Core defaults; Blackhand's Guide alternative.
// Vehicle class suggestions for the item sheet's soft-enum datalist (VEHICLE-SPEC.md §4/§6:
// `vehicleType` is a free string so the books' own type vocabulary survives — "Super-heavy
// Construction Vehicle" stays intact — while these common values keep filtering consistent).
// Stored raw (data, not UI labels), same as the mph/kph unit designations.
export const VEHICLE_TYPE_SUGGESTIONS = [
  "Car", "Cycle", "Truck", "Hovercraft", "AV (Aerodyne)", "Helicopter", "Fixed-Wing",
  "Osprey", "Dirigible", "Boat", "Submarine", "Spacecraft", "Tank", "APC/IFV",
  "RPV/Drone", "Ultralight", "Construction", "ACPA (Powered Armor)"
];

export const AMMO_COST_CLASSES = {
  lightPistol:     { label: "Light Pistol / Lt. SMG",  core: { box: 100, price: 15 }, blackhands: { box: 100, price: 15 } },
  mediumPistol:    { label: "Medium Pistol / SMG",     core: { box: 50,  price: 15 }, blackhands: { box: 100, price: 30 } },
  heavyPistol:     { label: "Heavy Pistol / Hvy. SMG", core: { box: 50,  price: 18 }, blackhands: { box: 100, price: 36 } },
  veryHeavyPistol: { label: "Very Heavy Pistol",       core: { box: 50,  price: 20 }, blackhands: { box: 100, price: 40 } },
  assaultRifle:    { label: "Assault Rifle",           core: { box: 100, price: 40 }, blackhands: { box: 100, price: 40 } },
  shotgun:         { label: "Shotgun",                 core: { box: 12,  price: 15 }, blackhands: { box: 12,  price: 15 } },
  airgun:          { label: "Airgun",                  core: { box: 100, price: 6  }, blackhands: { box: 100, price: 6  } },
  needlegun:       { label: "Needlegun",               core: { box: 50,  price: 25 }, blackhands: { box: 100, price: 50 } },
  cannon20mm:      { label: "20mm Cannon",             core: { box: 1,   price: 25 }, blackhands: { box: 1,   price: 25 } },
  arrows:          { label: "Arrows",                  core: { box: 12,  price: 24 }, blackhands: { box: 12,  price: 24 } },
  crossbow:        { label: "Crossbow Bolts",          core: { box: 12,  price: 30 }, blackhands: { box: 12,  price: 30 } },
  flamethrower:    { label: "Flamethrower Fuel",       core: { box: 1,   price: 50 }, blackhands: { box: 1,   price: 50 } },
  none:            { label: "—",                       core: { box: 1,   price: 0  }, blackhands: { box: 1,   price: 0  } }
};

// Built-in calibers. costClass keys into AMMO_COST_CLASSES.
// 7.62 is split into NATO ("7.62") and Soviet ("7.62sov") per the Reference Book rifle table.
export const CALIBERS = {
  ".22":     { label: ".22",            costClass: "lightPistol" },
  ".25":     { label: ".25",            costClass: "lightPistol" },
  ".38":     { label: ".38",            costClass: "lightPistol" },
  "5mm":     { label: "5mm",            costClass: "lightPistol" },
  "6mm":     { label: "6mm",            costClass: "lightPistol" },
  "9mm":     { label: "9mm",            costClass: "mediumPistol" },
  ".45":     { label: ".45",            costClass: "mediumPistol" },
  ".357":    { label: ".357",           costClass: "heavyPistol" },
  "10mm":    { label: "10mm",           costClass: "heavyPistol" },
  "11mm":    { label: "11mm",           costClass: "heavyPistol" },
  ".44":     { label: ".44",            costClass: "veryHeavyPistol" },
  "12mm":    { label: "12mm",           costClass: "veryHeavyPistol" },
  "5.56":    { label: "5.56",           costClass: "assaultRifle" },
  "7.62":    { label: "7.62 (NATO)",    costClass: "assaultRifle" },
  "7.62sov": { label: "7.62 Soviet",    costClass: "assaultRifle" },
  "30-06":   { label: "30-06",          costClass: "assaultRifle" },
  "00":      { label: "00 Buck / Slug", costClass: "shotgun" },
  "20mm":    { label: "20mm",           costClass: "cannon20mm" },
  "Arrow":   { label: "Arrow",          costClass: "arrows" },
  "Bolt":    { label: "Crossbow Bolt",  costClass: "crossbow" },
  "Airgun":  { label: "Airgun Pellet",  costClass: "airgun" },
  "Needle":  { label: "Needlegun Round",costClass: "needlegun" },
  "Napalm":  { label: "Flamethrower Fuel", costClass: "flamethrower" }
};

// Ammo modifiers (loads). costMult = ×basic ammo cost. mech values are applied as DEFAULTS
// to an ammo item when its modifier is chosen, and remain editable on the item afterward.
export const AMMO_MODIFIERS = {
  standard:    { label: "Standard",          costMult: 1,     mech: { armorMultSoft: 1,   armorMultHard: 1,   penDamageMult: 1,   bonusDamageFormula: "" } },
  ap:          { label: "Armor-Piercing",    costMult: 3,     mech: { armorMultSoft: 0.5, armorMultHard: 0.5, penDamageMult: 0.5, bonusDamageFormula: "" } },
  hollowPoint: { label: "Hollow-Point",      costMult: 1.125, mech: { armorMultSoft: 2,   armorMultHard: 2,   penDamageMult: 1.5, bonusDamageFormula: "" } },
  api:         { label: "Armor-Piercing Incendiary", costMult: 4, mech: { armorMultSoft: 0.5, armorMultHard: 0.5, penDamageMult: 0.5, dotEnabled: true, dotTurns: 2, dotDamageFormula: "1d6", dotType: "fire" } },
  dualPurpose: { label: "Dual-Purpose",      costMult: 4,     mech: { armorMultSoft: 0.5, armorMultHard: 0.5, penDamageMult: 0.5, bonusDamageFormula: "" } },
  rubber:      { label: "Rubber",            costMult: 0.333, mech: { armorMultSoft: 1,   armorMultHard: 1,   penDamageMult: 0.5, stunSaveOnHit: true } },
  flechette:   { label: "Flechette",         costMult: 5,     mech: { armorMultSoft: 0.25, armorMultHard: 0.25, penDamageMult: 0.5, spreadMode: "flechette" } },
  safety:      { label: "Safety",            costMult: 6,     mech: { armorMultSoft: 2,   armorMultHard: 2,   penDamageMult: 3 } },
  brassCased:  { label: "Brass-cased",       costMult: 2, costMultBlackhands: 3, mech: {} }
};

/** Merge built-in CALIBERS with any GM-registered custom calibers (world setting). */
export function getCalibers() {
  // Dual-scope: the fork's system copy is authoritative; fall back to the module shadow (vanilla).
  let custom = {};
  for (const scope of ["cyberpunk2020", "cp2020-augmented"]) {
    try {
      const raw = game.settings.get(scope, "customCalibers");
      if (raw && typeof raw === "object" && Object.keys(raw).length) { custom = raw; break; }
    } catch (e) { /* not registered under this scope */ }
  }
  return { ...CALIBERS, ...custom };
}

// Blackhand's-Guide ammo-pricing mode: "off" | "boxes" | "brass" | "both" (Core when unset). (Scope
// fixed: reads the cp2020-augmented setting, not the base system's — a copy-from-fork bug.)
function _blackhandsPricing() {
  try { return game.settings.get("cp2020-augmented", "ammoBlackhandsPricing") || "off"; } catch (e) { return "off"; }
}

/** Box size + price for a caliber, honoring the Blackhand's box-pricing mode. */
export function getCaliberBox(caliberId) {
  const cal = getCalibers()[caliberId];
  const cls = AMMO_COST_CLASSES[cal?.costClass] ?? AMMO_COST_CLASSES.none;
  const p = _blackhandsPricing();
  const conv = (p === "boxes" || p === "both") ? cls.blackhands : cls.core;
  return { box: Number(conv.box) || 1, price: Number(conv.price) || 0 };
}

/** Cost multiplier for a modifier, honoring the Blackhand's brass-pricing mode. */
export function getModifierCostMult(modifierId) {
  const mod = AMMO_MODIFIERS[modifierId] ?? AMMO_MODIFIERS.standard;
  const p = _blackhandsPricing();
  if (mod.costMultBlackhands !== undefined && (p === "brass" || p === "both")) {
    return Number(mod.costMultBlackhands) || 1;
  }
  return Number(mod.costMult) || 1;
}

/** Price for one box of (caliber + modifier). */
export function getAmmoBoxPrice(caliberId, modifierId) {
  return Math.round(getCaliberBox(caliberId).price * getModifierCostMult(modifierId));
}

// Known data aliases/typos -> canonical caliber id. The Core rulebook prints the FN-FAL as
// "7.56" (a typo for 7.62) and the AK family as "7.62S" (Soviet), which the system data stored
// as "7.56"/"7.565". We normalize these at read-time so matching works WITHOUT mutating data.
const CALIBER_ALIASES = {
  "7.56":  "7.62",
  "7.565": "7.62sov",
  "7.62s": "7.62sov",
  "7.62S": "7.62sov"
};

/** Canonical caliber id for a stored value (resolves known typos/aliases). Never throws. */
export function normalizeCaliber(id) {
  const s = String(id ?? "").trim();
  if (!s) return "";
  return CALIBER_ALIASES[s] ?? s;
}

/**
 * True if ammo of `ammoCaliber` can be loaded into a weapon chambered for `weaponCaliber`.
 * A blank ammo caliber is treated as a WILDCARD (loads into any weapon) so that pre-existing
 * ammo items — which have no caliber yet — are never broken by the hard-block rule.
 */
export function caliberMatches(weaponCaliber, ammoCaliber) {
  const a = normalizeCaliber(ammoCaliber);
  if (a === "") return true;
  return normalizeCaliber(weaponCaliber) === a;
}

export let martialActions = {
  dodge: "Dodge",
  blockParry: "BlockParry",

  // FNFF2 defensive variants
  allOutParry: "AllOutParry",
  allOutDodge: "AllOutDodge",

  // Attacks
  strike: "Strike",
  punch: "Punch",
  kick: "Kick",
  disarm: "Disarm",
  sweepTrip: "SweepTrip",
  ram: "Ram",
  jumpKick: "JumpKick",
  cast: "Cast",

  // Grapple chain
  grapple: "Grapple",
  hold: "Hold",
  choke: "Choke",
  throw: "Throw",
  escape: "Escape"
};

export const MARTIAL_ART_ID_BY_KEY = {
  "Martial Arts: Aikido": "oeXfrhKtdtuxn5dx",
  "Martial Arts: AnimalKungFu": "x5mxWMFyRWHg5lEV",
  "Martial Arts: ArasakaTe": "nBVSZDIj1QOmd3nL",
  "Martial Arts: Boxing": "g75H0sMFUSaRIXfe",
  "Martial Arts: Capoeira": "hJsbE1MGbFpY4lyi",
  "Martial Arts: ChoiLiFut": "4DcaO3UAAv2wJE50",
  "Martial Arts: GunFu": "tdIiYYtLLF3HjO8Y",
  "Martial Arts: JeetKunDo": "abOBXqkPPrGfG3vs",
  "Martial Arts: Judo": "U7lhKboDQnnytPIe",
  "Martial Arts: Jujitsu": "i5D9nmQQf7bLTjgv",
  "Martial Arts: Karate": "JtA82aiEfaiKgkt4",
  "Martial Arts: Koppo": "fEBnTz80vz4hwuhd",
  "Martial Arts: Ninjutsu": "dDLyPjr39EQY6UwZ",
  "Martial Arts: PanzerFaust": "ONsXdXJVyBYGYgjH",
  "Martial Arts: Sambo": "sj9crrcjhlkhWIk9",
  "Martial Arts: Savate": "ZCnRa590mHEV6UBX",
  "Martial Arts: Sumo": "ZrVsKBYGxY56jnMb",
  "Martial Arts: TaeKwonDo": "E8XJt0vAzvlOspLU",
  "Martial Arts: TaiChiChuan": "3MsLf8ixMyBGG7je",
  "Martial Arts: Te": "v0W0oqDBHY2yqqt3",
  "Martial Arts: ThaiKickBoxing": "jgvFY5BWVsanP0md",
  "Martial Arts: Thamoc": "ZyMZ6C7r9V2TXmV9",
  "Martial Arts: WingChung": "WsPa5ZiNIjLhCIxH",
  "Martial Arts: Wrestling": "GZtVOGgtxv8CCuuz"
};

export const MARTIAL_ART_KEY_BY_ID = Object.fromEntries(
  Object.entries(MARTIAL_ART_ID_BY_KEY).map(([k, id]) => [id, k])
);

export const FNFF2_ONLY_MARTIAL_ART_KEYS = new Set([
  "Martial Arts: ArasakaTe",
  "Martial Arts: GunFu",
  "Martial Arts: JeetKunDo",
  "Martial Arts: Jujitsu",
  "Martial Arts: Koppo",
  "Martial Arts: Ninjutsu",
  "Martial Arts: PanzerFaust",
  "Martial Arts: Sambo",
  "Martial Arts: Sumo",
  "Martial Arts: TaiChiChuan",
  "Martial Arts: Te",
  "Martial Arts: Thamoc",
  "Martial Arts: WingChung"
]);

export const FNFF2_ONLY_MARTIAL_ART_IDS = new Set(
  [...FNFF2_ONLY_MARTIAL_ART_KEYS]
    .map(k => MARTIAL_ART_ID_BY_KEY[k])
    .filter(Boolean)
);

export function isFnff2OnlyMartialArtKey(key) {
  return FNFF2_ONLY_MARTIAL_ART_KEYS.has(key);
}

export function isFnff2OnlyMartialArtId(id) {
  return FNFF2_ONLY_MARTIAL_ART_IDS.has(id);
}

function _isFnff2Enabled() {
  // FNFF2 is a fork feature. Prefer the system's setting when present (running on the fork),
  // then the module's own toggle (running on vanilla, where the system key is unregistered and
  // game.settings.get THROWS), then default off. Never throw — the martial engine calls this on
  // vanilla actors. See the module-owned fnff2Enabled registration in settings.js.
  try { return Boolean(game?.settings?.get("cyberpunk2020", "fnff2Enabled")); } catch { /* not on the fork */ }
  try { return Boolean(game?.settings?.get(SCOPE, "fnff2Enabled")); } catch { /* not registered (yet) */ }
  return false;
}

// A skill is treated as a martial art if it carries the explicit flag or is named with the
// "Martial Arts:" convention. Built-in styles are additionally matched by stable id in
// actor.trainedMartials() so localized packs (which may name them "Aikido(3)") still resolve.
export const MARTIAL_ART_PREFIX_RE = /^\s*martial\s*arts\s*:/i;

export function isMartialArtSkillItem(item) {
  if (!item || item.type !== "skill") return false;
  if (item.system?.isMartialArt === true) return true;
  return MARTIAL_ART_PREFIX_RE.test(String(item.name ?? ""));
}

// Clean display label for a martial art: drop the "Martial Arts:" prefix, the trailing
// "(N)" IP-difficulty tag (the real value lives in system.diffMod), and any "~" marker.
export function martialArtDisplayName(name) {
  return String(name ?? "")
    .replace(MARTIAL_ART_PREFIX_RE, "")
    .replace(/\s*\(\d+\)\s*$/g, "")
    .replace(/~/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Actions that can carry a per-style bonus, shown in the skill sheet's martial-art editor.
export const MARTIAL_BONUS_ACTIONS = [
  "Strike", "Punch", "Kick", "Disarm", "SweepTrip", "BlockParry",
  "Dodge", "Grapple", "Throw", "Hold", "Choke", "Escape", "Ram"
];

// CORE set rules martial action bonuses
export const martialActionBonusesCore = {
  "Martial Arts: Karate": { Strike: 2, Kick: 2, BlockParry: 2 },
  "Martial Arts: Judo": { Throw: 3, Hold: 3, Escape: 3 },
  "Martial Arts: Boxing": { Strike: 3, BlockParry: 3, Dodge: 1, Grapple: 2 },
  "Martial Arts: ThaiKickBoxing": { Strike: 3, Kick: 3, BlockParry: 2, Dodge: 1, Grapple: 1 },
  "Martial Arts: ChoiLiFut": { Strike: 2, Kick: 2, BlockParry: 2, Dodge: 1, Throw: 1 },
  "Martial Arts: Aikido": { BlockParry: 4, Dodge: 3, Throw: 3, Hold: 3, Escape: 3 },
  "Martial Arts: AnimalKungFu": { Strike: 2, Kick: 2, BlockParry: 2, SweepTrip: 1 },
  "Martial Arts: TaeKwonDo": { Strike: 3, Kick: 3, BlockParry: 2, Dodge: 1, SweepTrip: 2 },
  "Martial Arts: Savate": { Kick: 4, BlockParry: 1, Dodge: 1 },
  "Martial Arts: Wrestling": { Throw: 3, Hold: 4, Escape: 4, Choke: 2, SweepTrip: 2, Grapple: 4 },
  "Martial Arts: Capoeira": { Strike: 1, Kick: 2, Dodge: 2, SweepTrip: 3 },
  "Brawling": {}
};

// FNFF2 set rules martial action bonuses
export const martialActionBonusesFNFF2 = {
  "Martial Arts: Aikido": {
    Disarm: 3, SweepTrip: 3, BlockParry: 4, Dodge: 3, Grapple: 2, Throw: 3, Hold: 2, Choke: 1, Escape: 2
  },
  "Martial Arts: AnimalKungFu": {
    Strike: 2, Punch: 2, Kick: 2, Disarm: 1, SweepTrip: 1, BlockParry: 2
  },
  "Martial Arts: ArasakaTe": {
    Strike: 1, Punch: 1, Kick: 1, BlockParry: 1, Dodge: 1, Grapple: 1, Throw: 1, Hold: 1, Choke: 2, Escape: 1
  },
  "Martial Arts: Boxing": {
    Strike: 1, Punch: 2, Kick: 3, SweepTrip: 3, Dodge: 1, Throw: 1, Escape: 2
  },
  "Martial Arts: Capoeira": {
    Punch: 1, Kick: 2, SweepTrip: 3, BlockParry: 2, Dodge: 2
  },
  "Martial Arts: ChoiLiFut": {
    Strike: 2, Punch: 2, Kick: 2, Disarm: 1, SweepTrip: 2, BlockParry: 2, Dodge: 1, Grapple: 1, Throw: 1
  },
  "Martial Arts: GunFu": {
    SweepTrip: 3, BlockParry: 2, Dodge: 4, Grapple: 4, Escape: 2
  },
  "Martial Arts: JeetKunDo": {
    Strike: 3, Punch: 3, Kick: 2, Disarm: 1, SweepTrip: 1, BlockParry: 2
  },
  "Martial Arts: Judo": {
    SweepTrip: 2, Dodge: 1, Grapple: 2, Throw: 3, Hold: 2, Choke: 1, Escape: 2
  },
  "Martial Arts: Jujitsu": {
    SweepTrip: 2, BlockParry: 3, Dodge: 2, Throw: 2, Hold: 4, Choke: 3
  },
  "Martial Arts: Karate": {
    Punch: 2, Kick: 2, Disarm: 1, BlockParry: 2
  },
  "Martial Arts: Koppo": {
    Punch: 4, Kick: 2, SweepTrip: 3, BlockParry: 3, Grapple: 2, Hold: 2, Choke: 1, Escape: 2
  },
  "Martial Arts: Ninjutsu": {
    Strike: 3, Punch: 3, Kick: 1, Disarm: 2, SweepTrip: 2, BlockParry: 1, Dodge: 2, Grapple: 1, Throw: 1, Hold: 1, Choke: 1, Escape: 1
  },
  "Martial Arts: PanzerFaust": {
    Punch: 3, Kick: 3, SweepTrip: 1, Dodge: 3, Grapple: 3, Throw: 1, Escape: 4, Ram: 3
  },
  "Martial Arts: Sambo": {
    Strike: 2, Punch: 2, Kick: 2, Disarm: 2, SweepTrip: 2, Grapple: 2, Throw: 3, Hold: 2, Escape: 2
  },
  "Martial Arts: Savate": {
    Kick: 4, BlockParry: 1, Dodge: 1
  },
  "Martial Arts: Sumo": {
    Punch: 2, SweepTrip: 2, Dodge: 2, Grapple: 2, Throw: 3, Hold: 1, Escape: 1, Ram: 4
  },
  "Martial Arts: TaeKwonDo": {
    Punch: 3, Kick: 3, SweepTrip: 2, BlockParry: 2, Dodge: 1
  },
  "Martial Arts: TaiChiChuan": {
    Strike: 2, Punch: 2, Kick: 1, Disarm: 1, BlockParry: 2, Dodge: 1, Grapple: 1
  },
  "Martial Arts: Te": {
    Strike: 2, Punch: 2, Kick: 1, Disarm: 1, SweepTrip: 2, Dodge: 1
  },
  "Martial Arts: ThaiKickBoxing": {
    Punch: 3, Kick: 4, BlockParry: 2, Grapple: 1
  },
  "Martial Arts: Thamoc": {
    Strike: 1, Disarm: 4, SweepTrip: 1, BlockParry: 1, Dodge: 2, Grapple: 1, Escape: 2
  },
  "Martial Arts: WingChung": {
    Punch: 4, Kick: 2, SweepTrip: 1, BlockParry: 3, Dodge: 1, Hold: 2
  },
  "Martial Arts: Wrestling": {
    SweepTrip: 2, Grapple: 4, Throw: 3, Hold: 4, Choke: 2, Escape: 4
  },

  "Brawling": {}
};

export const fnff2DamageBonusSymbols = {
  Strike: "*",
  Punch: "*",
  Kick: "*",
  Disarm: "%",
  SweepTrip: "$",
  BlockParry: "@",
  Dodge: "@",
  Grapple: "%",
  Throw: "*",
  Hold: "$",
  Choke: "*",
  Escape: "@",
  Ram: "*"
};

function _getFnff2DamageBonusSymbol(actionKey) {
  return fnff2DamageBonusSymbols[actionKey] ?? "*";
}

/**
 * Action bonus for a martial style.
 * @param {string} martialKey  Built-in canonical key, or a custom skill name.
 * @param {string} actionKey   Martial action (Strike, Kick, ...).
 * @param {object|null} skillBonuses  Optional per-skill bonus map from skill.system.martialBonuses.
 *   Used for custom styles (no built-in table) and to let any skill override a built-in bonus.
 */
function _getMartialActionBonus(martialKey, actionKey, skillBonuses = null) {
  // Per-skill bonus takes priority — this is how custom styles (and overrides) work.
  const perSkill = skillBonuses ? Number(skillBonuses[actionKey] || 0) : 0;
  if (perSkill) return perSkill;

  const fnff2 = isFnff2Enabled();
  if (!fnff2 && FNFF2_ONLY_MARTIAL_ART_KEYS.has(martialKey)) {
    return 0;
  }

  const table = fnff2 ? martialActionBonusesFNFF2 : martialActionBonusesCore;
  const style = table[martialKey] || {};
  return Number(style[actionKey] || 0);
}

// Be warned that the localisations of these take a range parameter
export let ranges = {
    pointBlank: "RangePointBlank",
    close: "RangeClose",
    medium: "RangeMedium",
    long: "RangeLong",
    extreme: "RangeExtreme"
}
let rangeDCs = {}
rangeDCs[ranges.pointBlank] = 10;
rangeDCs[ranges.close] = 15;
rangeDCs[ranges.medium] = 20;
rangeDCs[ranges.long] = 25;
rangeDCs[ranges.extreme] = 30;
let rangeResolve = {};
rangeResolve[ranges.pointBlank] = range => 1;
rangeResolve[ranges.close] = range => range/4;
rangeResolve[ranges.medium] = range => range/2;
rangeResolve[ranges.long] = range => range;
rangeResolve[ranges.extreme] = range => range*2;
export { rangeDCs, rangeResolve }

/**
 * Cyberware-tab anatomy images the player can pick between. DEVELOPER-SIDE registry: add a new body
 * type by adding an entry here (players only choose from what's registered; they can't add images).
 *   - `svg: true`  → rendered via <object type="image/svg+xml"> (vector, scales to the box).
 *   - `svg: false` → a raster image rendered via <img object-fit:contain>.
 * Keep new art sized to the same proportions as the existing anatomy so the cyberware zone panels
 * stay aligned. The chosen key is stored per-actor in flags.cyberpunk2020.anatomyImage.
 */
export const ANATOMY_IMAGES = {
  male:   { label: "Male",   src: "modules/cp2020-augmented/img/male-anatomy-unsegmented.svg", svg: true  },
  female: { label: "Female", src: "modules/cp2020-augmented/img/female-anatomy-unsegmented.png", svg: false },
};
export const DEFAULT_ANATOMY_KEY = "male";

export let defaultTargetLocations = ["Head", "Torso", "lArm", "rArm", "lLeg", "rLeg"]
export let defaultAreaLookup = {
    1: "Head",
    2: "Torso",
    3: "Torso",
    4: "Torso",
    5: "rArm",
    6: "lArm",
    7: "lLeg",
    8: "lLeg",
    9: "rLeg",
    10: "rLeg"
}

function _defaultHitLocations() {
  return cloneSystemDefault(DEFAULT_HIT_LOCATIONS);
}

// W4RST4R's Limb Rules hit-location table (1d10): 1 Head, 2 R.Arm, 3 L.Arm, 4-7 Torso,
// 8 R.Leg, 9 L.Leg, 0(=10) Groin. Used for rolling + chat display when that model is active.
// Groin has no stored SP/hitLocation; the damage resolver maps it to Torso armor at runtime.
export let W4RST4R_AREA_LOOKUP = {
  1: "Head",
  2: "rArm",
  3: "lArm",
  4: "Torso",
  5: "Torso",
  6: "Torso",
  7: "Torso",
  8: "rLeg",
  9: "lLeg",
  10: "Groin"
};

export function rangedModifiers(weapon, targetTokens=[], savedOptions={}) {
    let range = weapon.system.range || 50;
    let fireModes = weapon.__getFireModes() || [];
    // Saved attack options: pre-fill the weapon's last-used fire mode, if still a valid choice.
    const savedFireMode = savedOptions?.fireMode;
    const fireModeDefault = fireModes.includes(savedFireMode) ? savedFireMode : fireModes[0];
    return [
        [{
            localKey: "FireMode",
            dataPath: "fireMode",
            choices: fireModes,
            defaultValue: fireModeDefault
        },
        {
            localKey: "Range", 
            dataPath: "range", 
            defaultValue: "RangeClose",
            choices: [
                {value:"RangePointBlank", localData: {range: 1}},
                {value:"RangeClose", localData: {range: range/4}},
                {value:"RangeMedium", localData: {range: range/2}},
                {value:"RangeLong", localData: {range: range}},
                {value:"RangeExtreme", localData: {range: range*2}}
            ]
        }],
        [{
            localKey: "Aiming",
            dataPath: "aimRounds",
            defaultValue: 0,
            choices: [0,1,2,3].map(x => {
                return { value: x, localKey: "Rounds", localData: {rounds: x}}
            }),
        },
        {
            localKey: "TargetArea",
            dataPath: "targetArea",
            defaultValue: "",
            choices: defaultTargetLocations,
            allowBlank: true
        },
        {localKey:"Ambush", dataPath:"ambush",defaultValue: false},
        {localKey:"Blinded", dataPath:"blinded",defaultValue: false},
        {localKey:"DualWield", dataPath:"dualWield",defaultValue: false},
        {localKey:"FastDraw", dataPath:"fastDraw",defaultValue: false},
        {localKey:"Hipfire", dataPath:"hipfire",defaultValue: false},
        {localKey:"Ricochet", dataPath:"ricochet",defaultValue: false},
        {localKey:"Running", dataPath:"running",defaultValue: false},
        {localKey:"TurnFace", dataPath:"turningToFace",defaultValue: false},
        // Full-auto only: how many rounds of the burst to fire (1..ROF). Shown for fullAuto, hidden otherwise.
        // min/max constrain the input itself so the player can't enter more than ROF (it was only
        // silently capped at fire time before, which was confusing).
        {localKey:"AutofireRounds", dataPath:"autoRounds", dtype:"Number", defaultValue: weapon.system.rof, min: 1, max: weapon.system.rof},
        {localKey:"FireZoneWidth",  dataPath:"zoneWidth",  dtype:"Number", defaultValue: 2},
        {localKey:"RoundsFiredLbl", dataPath:"roundsFired", dtype:"Number", defaultValue: weapon.system.rof},
        {
            localKey: "TargetsCount",
            dataPath:"targetsCount",
            dtype:"Number",
            defaultValue: Math.max(1, targetTokens.length)
        },
        ]
    ];
}

/**
 * Martial-arts ACTIONS grouped under the same subheaders the attack dialog used (Defensive /
 * Attacks / Grapple). FNFF2 adds the all-out defenses and the extra strikes. The combat tab renders
 * these as clickable buttons; the action is chosen by which button the player presses, so the
 * dialog no longer carries an Action dropdown. Returns [{ groupName, choices:[actionKey,...] }].
 */
export function martialActionGroups() {
    const base = [
        { groupName: "Defensive", choices: ["Dodge", "BlockParry"] },
        { groupName: "Attacks",   choices: ["Strike", "Kick", "Disarm", "SweepTrip"] },
        { groupName: "Grapple",   choices: ["Grapple", "Hold", "Choke", "Throw", "Escape"] },
    ];
    if (isFnff2Enabled()) {
        base[0].choices.unshift("AllOutParry", "AllOutDodge");
        base[1].choices.splice(1, 0, "Punch");
        base[1].choices.push("Ram", "JumpKick", "Cast");
    }
    return base;
}

/**
 * Modifier groups for a martial-arts attack dialog. The ACTION is no longer chosen here — it comes
 * from the combat-tab button the player pressed (see martialActionGroups + the .martial-action
 * handler), and is injected into the fire options. The dialog only collects the style and cyberlimb.
 */
export function martialOptions(actor, savedOptions={}) {
    const martialChoices = [
      { value: "Brawling", localKey: "SkillBrawling" },

      // trainedMartials() shape differs by platform: the installed 1.1.1 system returns STRING keys
      // (display name via getMartialDisplayName), the fork returns { value, label } objects. Handle
      // both, else the dropdown collapses to just "Brawling" on stock. `text` is rendered literally.
      ...(actor.trainedMartials().map(m => {
        if (typeof m === "string") return { value: m, text: actor.getMartialDisplayName?.(m) ?? m };
        return { value: m.value, text: m.label ?? m.value };
      }))
    ];
    // Saved attack options: pre-fill the weapon's last-used martial art, if still a valid choice.
    const savedMartialArt = savedOptions?.martialArt;
    const martialArtDefault = martialChoices.map(c => c.value).includes(savedMartialArt) ? savedMartialArt : "Brawling";

    const cyberTerminusChoices = [
        { value: "NoCyberlimb", localKey: "NoCyberlimb" },
        { value: "CyberTerminusX2", localKey: "CyberTerminusX2" },
        { value: "CyberTerminusX3", localKey: "CyberTerminusX3" }
    ];
    const savedCyberTerminus = savedOptions?.cyberTerminus;
    const cyberTerminusDefault = cyberTerminusChoices.map(c => c.value).includes(savedCyberTerminus) ? savedCyberTerminus : "NoCyberlimb";

    return [
        [{
            localKey: "MartialArt",
            dataPath: "martialArt",
            defaultValue: martialArtDefault,
            choices: martialChoices
        },
        {
            localKey: "CyberTerminus",
            dataPath: "cyberTerminus",
            defaultValue: cyberTerminusDefault,
            choices: cyberTerminusChoices
        }
    ]]
}

// Needs to be a function, or every time the modifiers dialog is launched, it'll add "extra mods" on
export function meleeBonkOptions(savedOptions={}) {
    const cyberTerminusChoices = [
        { value: "NoCyberlimb", localKey: "NoCyberlimb" },
        { value: "CyberTerminusX2", localKey: "CyberTerminusX2" },
        { value: "CyberTerminusX3", localKey: "CyberTerminusX3" }
    ];
    const savedCyberTerminus = savedOptions?.cyberTerminus;
    const cyberTerminusDefault = cyberTerminusChoices.map(c => c.value).includes(savedCyberTerminus) ? savedCyberTerminus : "NoCyberlimb";

    return [[
        {
            localKey: "TargetArea",
            dataPath: "targetArea",
            defaultValue: "",
            choices: defaultTargetLocations,
            allowBlank: true
        },
        {
            localKey: "CyberTerminus",
            dataPath: "cyberTerminus",
            defaultValue: cyberTerminusDefault,
            choices: cyberTerminusChoices
        }
    ]]
}

/**
 * Get a body type modifier from the body type stat (body)
 * I couldn't figure out a single formula that'd work for it (cos of the weird widths of BT values)
 */
export function btmFromBT(body) {
    if(body <= 2) {
        return 0;
      }
      switch(body) {
        // Very weak
        case 2: return 0
        // Weak
        case 3: 
        case 4: return 1
        // Average
        case 5:
        case 6:
        case 7: return 2;
        // Strong
        case 8:
        case 9: return 3;
        // Very strong
        case 10: return 4;
        default: return 5;
      }
}

function _strengthDamageBonus(bt) {
    let btm = btmFromBT(bt);
    if(btm < 5)
        return btm - 2;

    switch(bt) {
        case 11:
        case 12: return 4 
        case 13:
        case 14: return 6
        default: return 8
    }
}