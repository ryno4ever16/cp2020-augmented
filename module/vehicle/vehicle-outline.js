/**
 * vehicle-outline.js — drawing the footprint a vehicle actually has.
 *
 * Core token frames are axis-aligned rectangles and cannot tilt, so once a vehicle can sit at any
 * heading (vehicle-layout.js Layer 4) the frame stops describing it: a car at 30° gets a box that
 * contains a good deal of pavement it is nowhere near. The mechanics already read the ROTATED
 * rectangle; this file is the matching picture, so a GM can see the shape the rules are using.
 *
 * It is rendering and nothing else — a PIXI outline drawn as the token placeable's own child, the
 * same shape as the occupancy badge next door. Nothing is written to any document, the token keeps
 * its image, its targeting, its HUD and its bars, and a client that never looks at a vehicle never
 * pays for any of it.
 *
 * The outline is drawn in the placeable's LOCAL space (origin at the token's top-left, sized in
 * pixels), because the placeable container does NOT inherit the token's rotation — core rotates the
 * art mesh, not the frame. So the four corners are turned about the local centre by hand, which is
 * also why the outline lands exactly where pointInRotatedRect says the vehicle is.
 */

import { rotatedRectCorners } from "./vehicle-layout.js";

const SCOPE = "cp2020-augmented";
/** Amber, matching the cover system's intact band — this IS the thing a shot has to cross. */
const OUTLINE_COLOR = 0xd1a054;
const OUTLINE_WIDTH = 2;
const OUTLINE_ALPHA = 0.9;
/**
 * How far core's own rectangular frame is faded on a vehicle handle. Not hidden outright: it is
 * still the selection affordance every Foundry user knows, and a GM dragging a selection box wants
 * to see what is selected. Dimmed enough that the rotated outline reads as the real shape.
 */
const CORE_BORDER_ALPHA = 0.2;

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

/** Draw (or redraw) one vehicle's rotated footprint outline. */
function _syncOutline(placeable) {
  if (!_isLive(placeable) || !placeable.document) return;
  const doc = placeable.document;
  const grid = doc.parent?.grid?.size ?? canvas?.grid?.size ?? 100;
  const w = (Number(doc.width) || 1) * grid;
  const h = (Number(doc.height) || 1) * grid;

  let outline = placeable.cpFootprintOutline;
  if (!outline || outline.destroyed || outline.parent !== placeable) {
    outline = new PIXI.Graphics();
    outline.eventMode = "none";                 // decoration: never eats a click meant for the token
    placeable.addChild(outline);
    placeable.cpFootprintOutline = outline;
  }

  const corners = rotatedRectCorners({ x: 0, y: 0, w, h }, doc.rotation);
  outline.clear();
  outline.lineStyle(OUTLINE_WIDTH, OUTLINE_COLOR, OUTLINE_ALPHA);
  outline.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i++) outline.lineTo(corners[i].x, corners[i].y);
  outline.lineTo(corners[0].x, corners[0].y);
  // A short spur from the middle of the LEADING edge: at a glance, which way the thing is pointing.
  // Corners run top-left, top-right, bottom-right, bottom-left, so the leading edge is the pair at
  // the BOTTOM — a token at rotation 0 faces south (vehicle-layout ROTATION_ZERO_FRONT, the core's
  // own convention). The spur used to be drawn off the top pair, which pointed it at the vehicle's
  // tail and disagreed with both the engine region and the front armour facing.
  const nose = { x: (corners[2].x + corners[3].x) / 2, y: (corners[2].y + corners[3].y) / 2 };
  const centre = { x: w / 2, y: h / 2 };
  outline.moveTo(nose.x, nose.y);
  outline.lineTo(nose.x + (nose.x - centre.x) * 0.18, nose.y + (nose.y - centre.y) * 0.18);

  // Core's own frame is now the bounding box of a shape it cannot draw, so it is faded down to a
  // selection hint. Guarded rather than assumed: `border` is core's, and a core that stops
  // providing it must not take the outline down with it.
  try {
    if (placeable.border) placeable.border.alpha = CORE_BORDER_ALPHA;
  } catch (e) { /* cosmetic only */ }
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
}
