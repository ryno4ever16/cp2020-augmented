/**
 * vehicle-grid.js — scene grid ↔ metres conversions for the vehicle/Maximum Metal combat system.
 *
 * Maximum Metal's rules are all in METRES (ranges, bursts, deviation, missile travel). Foundry
 * scenes, however, measure in arbitrary grid units (the `grid.units` label) at `grid.size` pixels
 * per `grid.distance` units. These helpers convert between the rules' metres and the scene so the
 * automation is correct on any grid SIZE *and* common non-metre units (ft/yd/km/mi), instead of
 * silently assuming 1 grid-unit = 1 metre. Everything degrades gracefully (unknown unit → metres,
 * missing/zero distance → 1) so a misconfigured scene never divides by zero or throws.
 */

/** Metres represented by one scene grid-distance unit, parsed from the scene's units label. PURE-ish. */
export function metersPerUnit(scene) {
  const u = String(scene?.grid?.units ?? "").trim().toLowerCase();
  if (!u) return 1;                                                  // unlabelled → assume metres
  if (/^(m|meter|meters|metre|metres)$/.test(u)) return 1;
  if (/^(ft|foot|feet|')$/.test(u)) return 0.3048;
  if (/^(yd|yard|yards)$/.test(u)) return 0.9144;
  if (/^(km|kilometer|kilometers|kilometre|kilometres)$/.test(u)) return 1000;
  if (/^(mi|mile|miles)$/.test(u)) return 1609.344;
  return 1;                                                          // unknown unit → assume metres
}

/** Pixels per metre on a scene: (grid.size / grid.distance) corrected for the unit, guarded. */
export function pxPerMeter(scene) {
  const size = Number(scene?.grid?.size) || 100;
  const dist = Number(scene?.grid?.distance);
  const unitsPerCell = dist > 0 ? dist : 1;
  const mPerUnit = metersPerUnit(scene) || 1;
  return (size / unitsPerCell) / mPerUnit;
}

/** Metres → pixels on a scene. */
export const metersToPixels = (scene, m) => (Number(m) || 0) * pxPerMeter(scene);

/** Pixels → metres on a scene. */
export const pixelsToMeters = (scene, px) => {
  const ppm = pxPerMeter(scene);
  return ppm > 0 ? (Number(px) || 0) / ppm : 0;
};

/** Metres → scene grid-distance units (for a MeasuredTemplate's `distance`, which is in units). */
export const metersToUnits = (scene, m) => (Number(m) || 0) / (metersPerUnit(scene) || 1);
