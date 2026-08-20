/**
 * vehicle-outline.js — THE FRAME YOU SEE IS THE HULL.
 *
 * Core token frames are axis-aligned rectangles and cannot tilt. A vehicle's token is therefore a
 * SQUARE (vehicle-layout.js's hull/frame split) big enough to carry its hull at any angle, and the
 * hull itself — the shape every rule in the module measures — is drawn here, turned to the token's
 * own rotation. Core's square border is suppressed on these tokens, so what a GM sees round a
 * vehicle is the vehicle, not the box the platform keeps it in.
 *
 * Three things follow from that and all three live in this file:
 *   · the rotated hull rectangle plus a nose spur, so the shape and its heading are legible;
 *   · core's own border faded out of the way, and the hull outline taking over its job — it is drawn
 *     in core's OWN border colour whenever core would have drawn one (hover, control, target), so
 *     the selection affordance every Foundry user knows survives, in the right shape;
 *   · the placeable's pointer `hitArea`, re-pointed at the same rotated polygon, so hovering,
 *     clicking and targeting a vehicle answer for the hull and not for the corners of a square.
 *
 * It is rendering and nothing else — PIXI drawn as the token placeable's own child, the same shape
 * as the occupancy badge next door. Nothing is written to any document, the token keeps its image,
 * its HUD and its bars, and a client that never looks at a vehicle never pays for any of it.
 *
 * The outline is drawn in the placeable's LOCAL space (origin at the token's top-left, sized in
 * pixels), because the placeable container does NOT inherit the token's rotation — core rotates the
 * art mesh, not the frame. So the four corners are turned about the local centre by hand, which is
 * also why the outline lands exactly where pointInRotatedRect says the vehicle is.
 */

import { rotatedRectCorners, hullDimsOf, hullRectIn, noseMidpoint } from "./vehicle-layout.js";

const SCOPE = "cp2020-augmented";
/** Amber, matching the cover system's intact band — this IS the thing a shot has to cross. */
const OUTLINE_COLOR = 0xd1a054;
const OUTLINE_WIDTH = 2;
/** Thicker while core would be drawing a border of its own, so a selected vehicle still announces itself. */
const OUTLINE_WIDTH_ACTIVE = 3;
const OUTLINE_ALPHA = 0.9;

/**
 * True while a placeable is still a live display object. Draw/refresh hooks also fire while the
 * canvas is tearing a token down, and touching a destroyed PIXI object throws from inside the
 * engine — the same guard the occupancy badge carries, for the same reason.
 */
function _isLive(placeable) {
  return !!placeable && placeable.destroyed !== true && !!placeable.transform;
}

function _isVehicle(doc) {
  return doc?.actor?.type === `${SCOPE}.vehicle` || doc?.flags?.[SCOPE]?.vehicleHandle === true;
}

/**
 * The hull's four corners in the placeable's LOCAL space, turned to the token's rotation. The one
 * geometry both the drawn outline and the pointer hit area are built from, so what the eye picks out
 * and what the pointer picks up cannot come apart.
 */
export function hullCornersLocal(doc, grid) {
  const g = Math.max(1, Number(grid) || 100);
  const fw = (Number(doc?.width) || 1) * g;
  const fh = (Number(doc?.height) || 1) * g;
  const hull = hullDimsOf(doc?.actor?.system, Number(doc?.width), Number(doc?.height));
  const rect = hullRectIn({ x: 0, y: 0, w: fw, h: fh }, hull, g);
  return { corners: rotatedRectCorners(rect, doc?.rotation), centre: { x: fw / 2, y: fh / 2 } };
}

/**
 * Where this vehicle's nose is, in the placeable's local space: the midpoint of the hull edge the
 * vehicle's own HEADING puts at the front, on corners already turned by the token's rotation.
 *
 * ⭐ THE HEADING AND THE ROTATION ARE BOTH READ, and that is the whole point. The heading
 * (`system.layout.front`) says which end of the ARTWORK is the nose — the one fact the module cannot
 * see in a picture, and the fact the sheet's Front picker sets. The rotation says which way that end is
 * currently pointing on the map. `layoutFor` has always composed the two for the seats, the engine
 * region and the cover facings; before this the outline composed neither, and drew its spur off the
 * bottom edge whatever the GM had picked. The convention itself lives in vehicle-layout.js
 * (`noseMidpoint`), so the drawn nose and the front rank cannot come apart again.
 *
 * Exported so the same point can be read back without a canvas.
 */
export function hullNoseLocal(doc, grid) {
  const { corners, centre } = hullCornersLocal(doc, grid);
  const nose = noseMidpoint(corners, doc?.actor?.system?.layout?.front);
  return { nose, centre, corners };
}

/**
 * The colour core would draw this token's border in, or null when core would draw none. Reading
 * core's own answer rather than re-deriving hover/control/target state keeps the vehicle outline
 * behaving like every other token's border, including whatever a future core adds to that rule.
 */
function _coreBorderColor(placeable) {
  try {
    const c = placeable?._getBorderColor?.();
    if (c === null || c === undefined) return null;
    // v13 returns a number, v14 a Color instance; both answer to Number().
    const n = Number(c?.valueOf?.() ?? c);
    return Number.isFinite(n) ? n : null;
  } catch (e) { return null; }
}

/** Draw (or redraw) one vehicle's rotated hull outline, and point the pointer at the same shape. */
function _syncOutline(placeable) {
  if (!_isLive(placeable) || !placeable.document) return;
  const doc = placeable.document;
  const grid = doc.parent?.grid?.size ?? canvas?.grid?.size ?? 100;

  let outline = placeable.cpFootprintOutline;
  if (!outline || outline.destroyed || outline.parent !== placeable) {
    outline = new PIXI.Graphics();
    outline.eventMode = "none";                 // decoration: never eats a click meant for the token
    placeable.addChild(outline);
    placeable.cpFootprintOutline = outline;
  }

  const { corners, centre, nose } = hullNoseLocal(doc, grid);
  // Core's border is suppressed and this outline stands in for it, so it wears core's own colour
  // whenever core had one to give and the hull's amber the rest of the time.
  const active = _coreBorderColor(placeable);
  outline.clear();
  outline.lineStyle(active === null ? OUTLINE_WIDTH : OUTLINE_WIDTH_ACTIVE,
    active === null ? OUTLINE_COLOR : active, OUTLINE_ALPHA);
  outline.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i++) outline.lineTo(corners[i].x, corners[i].y);
  outline.lineTo(corners[0].x, corners[0].y);
  // A short spur from the middle of the LEADING edge: at a glance, which way the thing is pointing.
  // WHICH edge that is comes from the vehicle's own heading composed with the token's rotation
  // (hullNoseLocal above) — the same composition layoutFor performs for the seats, the engine region
  // and the cover facings. It used to be the bottom pair unconditionally, i.e. ROTATION_ZERO_FRONT and
  // nothing else, so a GM who pointed the nose east got a spur out of the vehicle's flank.
  if (nose) {
    outline.moveTo(nose.x, nose.y);
    outline.lineTo(nose.x + (nose.x - centre.x) * 0.18, nose.y + (nose.y - centre.y) * 0.18);
  }

  // Core's own square border is the box a shape it cannot draw happens to fit in, so on a vehicle it
  // is taken out of the picture entirely and this outline does its job. Guarded rather than assumed:
  // `border` is core's, and a core that stops providing it must not take the outline down with it.
  try {
    if (placeable.border) placeable.border.alpha = 0;
  } catch (e) { /* cosmetic only */ }

  // THE POINTER FOLLOWS THE PICTURE. Core sizes the hit area to the token's rect, which on a vehicle
  // is the carrying square — so a click a square clear of a narrow car still selected it, and a click
  // on the far corner of a turned one did too. Pointing it at the same polygon the outline draws puts
  // hover, click and target back on the bodywork. Wrapped: hitArea is core's property and a core that
  // rejects a polygon must not cost us the outline (the fallback is core's square, which is what
  // every vehicle had before this).
  try {
    const flat = [];
    for (const c of corners) flat.push(c.x, c.y);
    placeable.hitArea = new PIXI.Polygon(flat);
  } catch (e) { /* keep core's square hit zone */ }
}

/** Remove the outline from a placeable that is no longer a vehicle handle. */
function _clearOutline(placeable) {
  const outline = placeable?.cpFootprintOutline;
  if (outline && !outline.destroyed) { outline.removeFromParent?.(); outline.destroy(); }
  if (placeable) placeable.cpFootprintOutline = null;
}

/**
 * Canvas-side registration. Both hooks, for the same reason the badge needs both: `drawToken` is
 * the first appearance, and `refreshToken` is every move, resize and turn afterwards.
 */
export function registerVehicleOutlineHooks() {
  Hooks.on("drawToken", (placeable) => {
    if (_isVehicle(placeable.document)) _syncOutline(placeable);
  });
  Hooks.on("refreshToken", (placeable) => {
    if (_isVehicle(placeable.document)) _syncOutline(placeable);
    else if (placeable?.cpFootprintOutline) _clearOutline(placeable);
  });

  /**
   * THE THIRD WAY THIS PICTURE GOES OUT OF DATE, and the one the two hooks above cannot see. Both of
   * them are TOKEN hooks: the outline redraws when a token appears, moves, resizes or turns. But a
   * heading and a hull are recorded on the ACTOR — the sheet's Front picker writes
   * `system.layout.front` and the Footprint fields write `hullW`/`hullH` — and neither of those
   * touches the token document at all when the frame square happens to come out the same (2×4 → 4×2
   * is the everyday case). So the shape and the nose the GM had just changed stayed on screen exactly
   * as they were, which is the other half of the reported *"the Front buttons have no visible effect"*.
   *
   * Presentation only, so unlike the re-seating watcher next door (vehicle-canvas.js) this is NOT
   * gated to the active GM: every client draws its own outline, and every client's copy has to follow.
   * Nothing here writes anything.
   */
  Hooks.on("updateActor", (actor, change) => {
    if (actor?.type !== `${SCOPE}.vehicle`) return;
    const layout = change?.system?.layout;
    if (!layout) return;
    if (layout.front === undefined && layout.hullW === undefined && layout.hullH === undefined) return;
    for (const placeable of canvas?.tokens?.placeables ?? []) {
      if (placeable?.document?.actor?.id !== actor.id) continue;
      if (_isVehicle(placeable.document)) _syncOutline(placeable);
    }
  });
}
