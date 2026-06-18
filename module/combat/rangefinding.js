/**
 * rangefinding.js  —  module/combat/rangefinding.js
 *
 * Automated range category determination from token distance.
 *
 * CP2020 range definitions (p.99):
 *   Point Blank: touching to 1m
 *   Close:       up to 1/4 of weapon's Long range
 *   Medium:      up to 1/2 of weapon's Long range
 *   Long:        up to the weapon's listed range
 *   Extreme:     up to 2× the weapon's listed range
 *
 * Weapon Long ranges (p.99):
 *   Handguns:     50m
 *   SMGs:         150m
 *   Shotguns:     50m
 *   Rifles:       400m
 *   Melee:        1m (melee range)
 *
 * Hit number modifiers per range (p.99):
 *   Point Blank: 10  Close: 15  Medium: 20  Long: 25  Extreme: 30
 *
 * In Foundry VTT (v12+/v13):
 *   canvas.grid.measurePath([pos1, pos2]).distance returns distance in the scene's
 *   distance unit (configured per scene, typically meters or feet). See gridDistanceBetween,
 *   which wraps it with legacy + Euclidean fallbacks.
 *   canvas.scene.dimensions.distance = units per grid square.
 *
 * Usage: called from item.js attack flow when autoRangefinding setting is on.
 */

export const RANGE_CATEGORIES = {
  POINT_BLANK: "pointBlank",
  CLOSE:       "close",
  MEDIUM:      "medium",
  LONG:        "long",
  EXTREME:     "extreme",
  OUT_OF_RANGE: "outOfRange",
};

// Hit number per range (p.99)
export const RANGE_HIT_NUMBERS = {
  pointBlank: 10,
  close:      15,
  medium:     20,
  long:       25,
  extreme:    30,
};

// Weapon type to Long range in meters (p.99 WEAPON RANGES table)
// The `range` field on each weapon item is its Long range in meters.
const WEAPON_TYPE_DEFAULT_RANGES = {
  Pistol:   50,
  SMG:      150,
  Shotgun:  50,
  Rifle:    400,
  Heavy:    400,
  Melee:    1,
  Bow:      150,
  Exotic:   20,
};

/**
 * Get the long range (in meters) for a weapon item.
 * Uses item.system.range if set; falls back to weapon type default.
 * @param {Item} weaponItem
 * @returns {number}  Long range in meters
 */
export function getWeaponLongRange(weaponItem) {
  const fromItem = Number(weaponItem.system?.range);
  if (fromItem && fromItem > 0) return fromItem;
  const wtype = weaponItem.system?.weaponType || "";
  return WEAPON_TYPE_DEFAULT_RANGES[wtype] ?? 50;
}

/**
 * Determine range category from a distance (in meters) and weapon long range.
 * @param {number} distanceMeters
 * @param {number} longRange       Weapon's full/Long range in meters
 * @returns {string}               One of RANGE_CATEGORIES values
 */
export function getRangeCategory(distanceMeters, longRange) {
  if (distanceMeters <= 1)                    return RANGE_CATEGORIES.POINT_BLANK;
  if (distanceMeters <= longRange / 4)        return RANGE_CATEGORIES.CLOSE;
  if (distanceMeters <= longRange / 2)        return RANGE_CATEGORIES.MEDIUM;
  if (distanceMeters <= longRange)            return RANGE_CATEGORIES.LONG;
  if (distanceMeters <= longRange * 2)        return RANGE_CATEGORIES.EXTREME;
  return RANGE_CATEGORIES.OUT_OF_RANGE;
}

/**
 * Grid-aware distance in scene units between two canvas POINTS (e.g. token centers).
 *
 * Uses the v12+/v13 grid API (`canvas.grid.measurePath`). Foundry v13 REMOVED the old
 * `canvas.grid.measureDistances` / `measureDistance`, so calling them threw "is not a function" on a
 * fresh v13 world. Falls back to the legacy method on older cores, then to a plain Euclidean estimate,
 * so this never throws regardless of core version. Returns the same units the old API did (scene
 * distance units — e.g. meters), so it's a drop-in replacement.
 *
 * @param {{x:number,y:number}} from
 * @param {{x:number,y:number}} to
 * @returns {number}
 */
export function gridDistanceBetween(from, to) {
  const grid = canvas?.grid;
  if (!grid || !from || !to) return Infinity;

  // v12+/v13: grid.measurePath(waypoints).distance, already in scene units.
  if (typeof grid.measurePath === "function") {
    const r = grid.measurePath([from, to]);
    return Number.isFinite(r?.distance) ? r.distance : Infinity;
  }
  // Last resort: Euclidean pixels -> scene units. (The pre-v12 `measureDistances`/`Ray`
  // path was removed — `Ray` is a v15-removed global and `measurePath` is guaranteed on
  // every supported core (min 13), so that branch was dead. This safety net covers the
  // impossible "grid has neither method" case without referencing any removed global.)
  const size = canvas.dimensions?.size || grid.size || 100;
  const dist = canvas.dimensions?.distance || grid.distance || 1;
  return (Math.hypot(to.x - from.x, to.y - from.y) / size) * dist;
}

/**
 * Measure the distance in scene units (assumed meters) between two canvas tokens.
 * @param {Token} attackerToken
 * @param {Token} targetToken
 * @returns {number}  Distance in the scene's distance unit (assumed meters)
 */
export function measureTokenDistance(attackerToken, targetToken) {
  if (!attackerToken || !targetToken) return Infinity;
  // Token center: placeables expose `.center`; fall back to a manual calc for docs/edge cases.
  const centerOf = (t) =>
    t.center ?? t.object?.center ?? {
      x: (t.x ?? 0) + ((t.w ?? 0) / 2),
      y: (t.y ?? 0) + ((t.h ?? 0) / 2),
    };
  return gridDistanceBetween(centerOf(attackerToken), centerOf(targetToken));
}

/**
 * Get the full range result for an attack.
 * Called from item.js when autoRangefinding is enabled.
 *
 * @param {Item}  weaponItem
 * @param {Token} attackerToken
 * @param {Token} targetToken
 * @returns {{
 *   category: string,
 *   hitNumber: number,
 *   distanceMeters: number,
 *   longRange: number,
 *   label: string,
 * }}
 */
export function resolveAttackRange(weaponItem, attackerToken, targetToken) {
  const longRange     = getWeaponLongRange(weaponItem);
  const distanceMeters = measureTokenDistance(attackerToken, targetToken);
  const category      = getRangeCategory(distanceMeters, longRange);
  const hitNumber     = RANGE_HIT_NUMBERS[category] ?? 25;

  const LABELS = {
    pointBlank:  "Point Blank",
    close:       "Close",
    medium:      "Medium",
    long:        "Long",
    extreme:     "Extreme",
    outOfRange:  "Out of Range",
  };

  return {
    category,
    hitNumber,
    distanceMeters: Math.round(distanceMeters * 10) / 10,
    longRange,
    label: LABELS[category] ?? category,
  };
}
