/**
 * aim-placement.js — the client-side AIM POINT an area-delivery weapon is fired THROUGH.
 *
 * ⭐⭐ EVERY THROW IS AIMED ON THE MAP (user ruling 2026-08-28, clarifying the ruling of the same day:
 * *"I want the throw gesture"* — for throws IN GENERAL, not as a fallback for a shot with nothing
 * targeted). CP2020 p.108 is written about a SPOT, not about a figure:
 *
 *   "Attacks are made as with other ranged weapons, with the center of the area effect falling on the
 *    designated target, and anything within the area of effect taking damage as well."
 *
 * A token was only ever a convenient way to name that spot. So firing a grenade, a launcher or a
 * missile opens this gesture FIRST — before the fire dialog — and the point the shooter clicks is what
 * the blast is centred on (on a hit) and what it scatters FROM (on a miss).
 *
 * ⛔ LAUNCHERS ARE INCLUDED DELIBERATELY, and it is one flow rather than two: the page above draws no
 * distinction between a thrown warhead and a launched one, both resolve through the same
 * `_placeExplosion`, and a gesture that appeared for a grenade and not for the tube beside it would be
 * a rule the table has to remember. `areaDeliveryKind` is the one predicate (combat/area-delivery.js),
 * so whatever the damage rail treats as an area delivery is what this gesture is armed for.
 *
 * ⛔ NOTHING NEW WAS BUILT TO DRAW THIS. It is `spread-placement.js`'s gesture with a point where the
 * corridor was: the same world-space PIXI Graphics on the stage, the same DOM readout positioned by the
 * cursor, the same window-level capture listeners with the same `_isCanvasEvent` guard (a click on an
 * open sheet moves the sheet and never confirms the aim), the same `canvasTearDown` safety net, and the
 * same promise-back-to-the-caller shape so the fire flow can simply stop when the shooter cancels.
 *
 * ⚠ THIS FILE SPENDS NOTHING. It is armed BEFORE any roll, so Esc (or a right click) resolves null and
 * the shot never happens: no attack roll, no ammunition, no area, no card. The magazine is decremented
 * inside the base system's own fire methods, several steps further down.
 *
 * ⭐ THE GHOST IS THE AREA ITSELF, not a bare crosshair. The circle drawn under the cursor is the
 * weapon's own area of effect — its stated `blastRadius` when it has one, else the book's row for its
 * delivery kind (`AREA_DELIVERY_RADIUS_M`, CP2020 p.99, cited in full at combat/area-delivery.js) — so
 * the shooter is choosing a point with the consequence drawn around it rather than guessing at a radius
 * they cannot see. The crosshair sits at the centre so the exact designated point is unambiguous.
 */

import { metersToPixels } from "../vehicle/vehicle-grid.js";
import { areaDeliveryKind, AREA_DELIVERY_RADIUS_M } from "./area-delivery.js";
import { getWeaponLongRange, getRangeCategory, gridDistanceBetween, RANGE_CATEGORIES } from "./rangefinding.js";
import { localize, localizeParam } from "../utils.js";

/** How solid the area ghost is WHILE it is being aimed — the spread preview's own alpha, so the two
 *  aim gestures read as the same weight of thing on the map. */
export const AIM_PREVIEW_FILL_ALPHA = 0.18;

/** The blast's own colours, taken from the area this gesture is about to create (`_placeExplosion`
 *  creates the circle at `#ff8800` / `#cc4400`), so the ghost and the thing it becomes match. */
const AIM_FILL_COLOR = "#ff8800";
const AIM_LINE_COLOR = "#cc4400";

/** How long each arm of the centre crosshair is, in screen-independent world pixels. */
const AIM_CROSS_PX = 18;

/** The one live gesture (only ever one at a time). Null when nothing is being aimed. */
let _active = null;

/** Register the scene-teardown safety net exactly once (lazy — no init wiring needed). */
let _tearDownHooked = false;
function _ensureTearDownHook() {
  if (_tearDownHooked) return;
  _tearDownHooked = true;
  // A scene change / canvas rebuild pulls the stage out from under a live gesture — cancel it so no
  // orphaned Graphics or window listeners survive the teardown, and so the promise still settles.
  Hooks.on("canvasTearDown", () => { try { _active?.cancel(); } catch (_e) { /* already gone */ } });
}

/** Screen (client) point → world (stage-local) point, using the stage's own transform. */
function _clientToWorld(clientX, clientY) {
  const t = canvas?.stage?.worldTransform;
  if (!t) return { x: clientX, y: clientY };
  const p = t.applyInverse(new PIXI.Point(clientX, clientY));
  return { x: p.x, y: p.y };
}

/**
 * Did this pointer event land on the game canvas itself? The listeners are window-level captures, so
 * without this guard a click on ANY open UI — the actor sheet being dragged out of the way, the sidebar
 * — would designate an aim point. Verbatim from `spread-placement.js` for the same reason.
 */
function _isCanvasEvent(ev) {
  return ev.target === canvas?.app?.view || ev.target?.id === "board";
}

/** Draw the area ghost + its centre crosshair, tolerant of the PIXI v7 (beginFill) and v8 (fill) APIs. */
function _drawAim(g, x, y, radiusPx, fillColor, lineColor) {
  g.clear();
  const arm = AIM_CROSS_PX;
  if (typeof g.beginFill === "function") {
    // PIXI v7 (Foundry v13/v14): retained immediate-mode API.
    g.beginFill(fillColor, AIM_PREVIEW_FILL_ALPHA);
    g.lineStyle(2, lineColor, 0.9);
    g.drawCircle(x, y, radiusPx);
    g.endFill();
    g.lineStyle(2, lineColor, 1);
    g.moveTo(x - arm, y); g.lineTo(x + arm, y);
    g.moveTo(x, y - arm); g.lineTo(x, y + arm);
  } else {
    // PIXI v8+: builder API.
    g.circle(x, y, radiusPx);
    g.fill({ color: fillColor, alpha: AIM_PREVIEW_FILL_ALPHA });
    g.stroke({ width: 2, color: lineColor, alpha: 0.9 });
    g.moveTo(x - arm, y); g.lineTo(x + arm, y);
    g.moveTo(x, y - arm); g.lineTo(x, y + arm);
    g.stroke({ width: 2, color: lineColor, alpha: 1 });
  }
}

/**
 * THE AREA A DELIVERY WEAPON COVERS, in metres — the item-side reading of the same ladder the damage
 * rail applies to the payload (`areaDeliveryOf`).
 *
 * The weapon's own `blastRadius` wins when it states one, which is the action-as-consent rule this
 * project applies everywhere; otherwise the book's row for the kind. 0 for anything that is not an area
 * delivery, in which case the caller never armed this gesture at all.
 */
export function aimPreviewRadiusM(weapon) {
  const sys = weapon?._getWeaponSystem?.() ?? weapon?.system ?? {};
  const kind = areaDeliveryKind(sys.attackType);
  if (!kind) return 0;
  const own = Number(sys.blastRadius);
  if (Number.isFinite(own) && own > 0) return own;
  return AREA_DELIVERY_RADIUS_M[kind] ?? 0;
}

/** The i18n key naming a measured range category — the same six the rangefinding note prints. */
const RANGE_CAT_LABEL_KEY = {
  [RANGE_CATEGORIES.POINT_BLANK]: "RangeCatPointBlank",
  [RANGE_CATEGORIES.CLOSE]:       "RangeCatClose",
  [RANGE_CATEGORIES.MEDIUM]:      "RangeCatMedium",
  [RANGE_CATEGORIES.LONG]:        "RangeCatLong",
  [RANGE_CATEGORIES.EXTREME]:     "RangeCatExtreme",
  [RANGE_CATEGORIES.OUT_OF_RANGE]: "RangeCatOutOfRange",
};

/**
 * THE RANGE BAND A DESIGNATED POINT SITS IN — the pure derivation the gesture's readout and the fire
 * dialog's pre-fill both read, so the band the shooter was shown and the band the window opens on are
 * one answer to one question.
 *
 * @param {{x:number,y:number}} origin  the shooter's own figure centre
 * @param {{x:number,y:number}} point   the designated point
 * @param {number} longRangeM           the weapon's own Long range (combat/rangefinding.js)
 * @returns {{distanceM:number, category:string}}
 */
export function aimPointRangeBand(origin, point, longRangeM) {
  const distanceM = gridDistanceBetween(origin, point);
  return {
    distanceM: Number.isFinite(distanceM) ? Math.round(distanceM * 10) / 10 : 0,
    category: getRangeCategory(distanceM, longRangeM),
  };
}

/**
 * Arm the aim gesture for an area-delivery weapon on THIS client and resolve once the shooter answers.
 *
 * @param {object} opts
 * @param {object} opts.shooterToken     the figure the throw leaves — the distance is measured from it
 * @param {string} [opts.weaponName]     named in the notification so a reader knows what they are aiming
 * @param {number} [opts.radiusM]        the area drawn under the cursor (see `aimPreviewRadiusM`)
 * @param {number} [opts.rangeM]         the weapon's own Long range — what the readout's band is against
 * @param {object} [opts.seedToken]      a TARGETED figure whose centre the aim opens on (convenience only)
 * @returns {Promise<{x:number,y:number,sceneId:string,distanceM:number,category:string}|null>}
 *          the designated point, or null when the shooter cancelled
 */
export async function armAimPointPlacement({ shooterToken, weaponName = "", radiusM = 0, rangeM = null, seedToken = null } = {}) {
  _ensureTearDownHook();
  // One gesture at a time — arming a second cancels the first (and settles its promise as a cancel).
  if (_active) { try { _active.cancel(); } catch (_e) { /* ignore */ } }

  if (!canvas?.ready || !canvas.scene || !shooterToken) {
    ui.notifications?.warn?.(localize("AimPointNoToken"));
    return null;
  }

  const scene = canvas.scene;
  const origin = {
    x: shooterToken.center?.x ?? shooterToken.x,
    y: shooterToken.center?.y ?? shooterToken.y,
  };
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) {
    ui.notifications?.warn?.(localize("AimPointNoToken"));
    return null;
  }

  const longRangeM = Number.isFinite(Number(rangeM)) && Number(rangeM) > 0 ? Number(rangeM) : 50;
  const radiusPx = metersToPixels(scene, Math.max(0, Number(radiusM) || 0));

  // ⭐ A TARGETED FIGURE SEEDS THE OPENING AIM — a CONVENIENCE, and nothing more. The shooter has
  // already said which way they are looking by targeting something, so the gesture opens there rather
  // than wherever the cursor happens to be resting; one mouse move takes it anywhere else. Nothing
  // downstream reads the seed: what rides the payload is the point that was CLICKED.
  const seeded = seedToken
    ? { x: seedToken.center?.x ?? seedToken.x, y: seedToken.center?.y ?? seedToken.y }
    : null;
  const state = {
    x: Number.isFinite(seeded?.x) ? seeded.x : origin.x,
    y: Number.isFinite(seeded?.y) ? seeded.y : origin.y,
    lastClientX: window.innerWidth / 2,
    lastClientY: window.innerHeight / 2,
  };

  // The ghost lives in world space on the stage; its points are world pixels.
  const graphics = new PIXI.Graphics();
  graphics.eventMode = "none";   // never intercept the confirming click
  canvas.stage.addChild(graphics);

  // The readout is DOM (styleable + localizable), positioned by the cursor — never canvas text. The
  // spread preview's own class, reused rather than restyled: same gesture, same furniture.
  const readout = document.createElement("div");
  readout.className = "cp-spread-preview-readout";
  document.body.appendChild(readout);

  const fillColor = Number(foundry.utils.Color.from(AIM_FILL_COLOR));
  const lineColor = Number(foundry.utils.Color.from(AIM_LINE_COLOR));

  const bandNow = () => aimPointRangeBand(origin, { x: state.x, y: state.y }, longRangeM);

  const redraw = () => {
    _drawAim(graphics, state.x, state.y, radiusPx, fillColor, lineColor);
    const band = bandNow();
    readout.textContent = localizeParam("AimPointReadout", {
      dist: band.distanceM,
      band: localize(RANGE_CAT_LABEL_KEY[band.category] ?? "RangeCatClose"),
      radius: Math.round((Number(radiusM) || 0) * 10) / 10,
    });
    readout.style.left = `${state.lastClientX + 16}px`;
    readout.style.top = `${state.lastClientY + 16}px`;
  };

  const onMove = (ev) => {
    state.lastClientX = ev.clientX;
    state.lastClientY = ev.clientY;
    const w = _clientToWorld(ev.clientX, ev.clientY);
    state.x = w.x;
    state.y = w.y;
    redraw();
  };

  const onDown = (ev) => {
    if (!_isCanvasEvent(ev)) return;         // clicks on open UI move/close windows, never the aim
    if (ev.button === 2) { ev.preventDefault(); ev.stopPropagation(); cancel(); return; }  // right-click cancels
    if (ev.button !== 0) return;                                                            // only left confirms
    ev.preventDefault();
    ev.stopPropagation();
    confirm();
  };

  // Suppress the browser menu only over the canvas (the right-click cancel); UI menus stay usable.
  const onContext = (ev) => { if (_isCanvasEvent(ev)) { ev.preventDefault(); ev.stopPropagation(); } };

  const onKey = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancel(); } };

  const removeListeners = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("contextmenu", onContext, true);
    window.removeEventListener("keydown", onKey, true);
  };

  let settle = null;
  const done = new Promise((resolve) => { settle = resolve; });

  const teardown = () => {
    removeListeners();
    try { graphics.parent?.removeChild(graphics); } catch (_e) { /* already detached */ }
    try { graphics.destroy(); } catch (_e) { /* already destroyed */ }
    try { readout.remove(); } catch (_e) { /* already gone */ }
    if (_active === handle) _active = null;
  };

  const cancel = () => {
    if (!settle) return;
    const resolve = settle; settle = null;
    teardown();
    resolve(null);                 // a cancelled aim is a cancelled SHOT — nothing is spent
  };

  const confirm = () => {
    if (!settle) return;
    const resolve = settle; settle = null;
    const band = bandNow();
    const point = { x: state.x, y: state.y };
    teardown();
    // ⭐ A POINT, IN SCENE PIXELS. Unlike the corridor — which is stored as an angle and a reach so that
    // every consumer can rebuild it off the shooter's CURRENT figure — a blast centre is not relative to
    // anything: p.108 designates a spot on the ground, and the spot does not move because the thrower
    // did. So the two coordinates ARE the declaration, and they are what travels.
    resolve({
      sceneId: scene.id,
      x: point.x, y: point.y,
      distanceM: band.distanceM,
      category: band.category,
      declaredAt: Date.now(),
    });
  };

  const handle = { cancel, teardown };
  _active = handle;

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("contextmenu", onContext, true);
  window.addEventListener("keydown", onKey, true);

  ui.notifications?.info?.(weaponName
    ? localizeParam("AimPointArmedFor", { name: weaponName })
    : localize("AimPointArmed"));
  redraw();
  return done;
}

/** Cancel any live aim gesture (exported for teardown / tests). Its promise settles as a cancel. */
export function cancelAimPointPlacement() {
  try { _active?.cancel(); } catch (_e) { /* ignore */ }
}

/** Is an aim gesture live on this client right now? Read by the keeper; nothing in the flow branches on it. */
export function aimPointPlacementActive() {
  return _active !== null;
}
