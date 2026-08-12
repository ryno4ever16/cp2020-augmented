/**
 * spread-placement.js — the client-side aim preview a spread weapon is fired THROUGH.
 *
 * Placement-forward shot patterns (user ruling 2026-08-11: *"shouldn't they have to place the pattern
 * first, then they say how they'll attack?"*). A shotgun is an area weapon in the Core rules, so what a
 * shell does is decided by WHERE it is pointed — the pattern's band, width and banded damage all fall
 * out of the aim. Declaring the modifiers first and discovering the corridor afterwards had the shooter
 * choosing a shot they could not see; aiming IS the declaration, so it comes first.
 *
 * The gesture, in order: the fire control arms this preview → a corridor ghost follows the cursor →
 * a left click confirms the corridor → the ordinary modifiers window opens → the roll commits → the rail
 * draws along the confirmed corridor → the pattern resolves at the end of that presentation.
 *
 * ⚠ THIS FILE SPENDS NOTHING. It is armed BEFORE any roll, so an Esc (or a right click) returns null and
 * the fire flow simply stops: no roll, no ammunition spent, no pattern planted. The magazine is only
 * decremented inside the base system's own fire methods, which are several steps further down.
 *
 * Structurally it is the suppressive lane's preview (`suppressive-placement.js`) with one deliberate
 * difference, and the difference is the whole ruling: the suppressive preview is armed AFTER its shot
 * resolves and RELAYS its geometry onward, so it returns nothing; this one is a step INSIDE the fire
 * gesture, so it hands its geometry back to the caller as a promise and the caller decides what happens
 * next. Everything else — the world-space PIXI corridor, the DOM readout, the window-level capture
 * listeners, the canvasTearDown safety net — is the same shape for the same reasons.
 *
 * The ghost drawn here and the region planted later are built from the SAME pure geometry
 * (area-geometry.js `rayPolygonShape`) off the SAME origin/angle/length/width, and the band and width
 * come from the SAME pure derivation both sides read (lookups.js `spreadBandSpec`), so what the shooter
 * aims is what the module plants.
 */

import { rayPolygonShape } from "./area-geometry.js";
import { metersToPixels, pixelsToMeters } from "../vehicle/vehicle-grid.js";
import { spreadBandSpec, spreadBandDamage } from "../lookups.js";
import { SPREAD_ZONE_LOOK } from "./spread-zone-look.js";
import { localize, localizeParam } from "../utils.js";

/** The shortest corridor the plant will accept, in metres — mirrors the plant's own floor. */
export const SPREAD_MIN_LENGTH_M = 2;

/**
 * How solid the ghost is WHILE IT IS BEING AIMED, and it is deliberately not the planted pattern's own
 * alpha. The planted region is a GM-only aiming aid that sits over other people's tokens, so it is
 * ghosted to 0.10; this one exists for as long as somebody is dragging it, belongs to the person
 * dragging it, and has to be legible against a dark map while they judge the band. Revert to
 * `SPREAD_ZONE_LOOK.fillAlpha` to make the two identical.
 */
export const SPREAD_PREVIEW_FILL_ALPHA = 0.18;

/** The one live preview (only ever one at a time). Null when nothing is being aimed. */
let _active = null;

/** Register the scene-teardown safety net exactly once (lazy — no init wiring needed). */
let _tearDownHooked = false;
function _ensureTearDownHook() {
  if (_tearDownHooked) return;
  _tearDownHooked = true;
  // A scene change / canvas rebuild pulls the stage out from under any live preview — cancel it so no
  // orphaned Graphics or window listeners survive the teardown, and so the promise still settles.
  Hooks.on("canvasTearDown", () => { try { _active?.cancel(); } catch (_e) { /* already gone */ } });
}

/** Draw a filled + outlined polygon, tolerant of the PIXI v7 (beginFill) and v8 (fill/stroke) APIs. */
function _drawCorridor(g, points, fillColor, lineColor) {
  g.clear();
  if (typeof g.beginFill === "function") {
    // PIXI v7 (Foundry v13/v14): retained immediate-mode API.
    g.beginFill(fillColor, SPREAD_PREVIEW_FILL_ALPHA);
    g.lineStyle(SPREAD_ZONE_LOOK.outlineWidth, lineColor, 0.9);
    g.drawPolygon(points);
    g.endFill();
  } else {
    // PIXI v8+: builder API.
    g.poly(points);
    g.fill({ color: fillColor, alpha: SPREAD_PREVIEW_FILL_ALPHA });
    g.stroke({ width: SPREAD_ZONE_LOOK.outlineWidth, color: lineColor, alpha: 0.9 });
  }
}

/** Screen (client) point → world (stage-local) point, using the stage's own transform. */
function _clientToWorld(clientX, clientY) {
  const t = canvas?.stage?.worldTransform;
  if (!t) return { x: clientX, y: clientY };
  const p = t.applyInverse(new PIXI.Point(clientX, clientY));
  return { x: p.x, y: p.y };
}

/**
 * The token a confirmed aim point lands ON, or null. Its own width is what the corridor overshoots by.
 *
 * ⭐ THE OVERSHOOT IS A RULE THIS FLOW INHERITS, not a new one: ending the corridor exactly on a token's
 * centre puts that centre ON the polygon's end edge, so whether the aimed-at figure is inside its own
 * pattern comes down to a floating-point comparison — reproduced on the rig, where a three-shell burst
 * resolved against a bystander and missed the figure that was aimed at. Half the figure's own width is
 * the smallest overshoot that settles it, and it costs no other square.
 */
function _tokenAtPoint(x, y) {
  for (const t of canvas?.tokens?.placeables ?? []) {
    const b = t.bounds ?? null;
    const left = b ? b.x : t.x, top = b ? b.y : t.y;
    const w = b ? b.width : (t.w ?? 0), h = b ? b.height : (t.h ?? 0);
    if (x >= left && x <= left + w && y >= top && y <= top + h) return t;
  }
  return null;
}

/**
 * Arm the aim preview for a spread weapon on THIS client and resolve once the shooter has answered.
 *
 * @param {object} opts
 * @param {object} opts.shooterToken   the figure the shot leaves — the corridor's fixed origin
 * @param {string} [opts.weaponName]   named in the readout so a reader knows what they are aiming
 * @param {{short,medium,long}} [opts.widths]    the load's own per-band widths (metres); Core's when absent
 * @param {{short,medium,long}} [opts.formulas]  the load's own per-band damage; Core's when absent
 * @returns {Promise<object|null>} the confirmed corridor, or null when the shooter cancelled
 */
export async function armSpreadPreview({ shooterToken, weaponName = "", widths = {}, formulas = {} } = {}) {
  _ensureTearDownHook();
  // One preview at a time — arming a second cancels the first (and settles its promise as a cancel).
  if (_active) { try { _active.cancel(); } catch (_e) { /* ignore */ } }

  if (!canvas?.ready || !canvas.scene || !shooterToken) {
    ui.notifications?.warn?.(localize("SpreadFireNoToken"));
    return null;
  }

  const scene = canvas.scene;
  const origin = {
    x: shooterToken.center?.x ?? shooterToken.x,
    y: shooterToken.center?.y ?? shooterToken.y,
  };
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) {
    ui.notifications?.warn?.(localize("SpreadFireNoToken"));
    return null;
  }

  // Opening state: pointed along the figure's own facing at a nominal reach, so the ghost is already on
  // screen before the first mouse move rather than appearing only once the cursor twitches. The same
  // reading the plant falls back to for an untargeted shot (a token's rotation is the only statement of
  // "which way" it is looking), so the two agree on the one frame before the shooter takes over.
  const facingDeg = ((Number(shooterToken.document?.rotation ?? shooterToken.rotation) || 0) + 90) % 360;
  const state = {
    angleDeg: facingDeg,
    reachPx: metersToPixels(scene, 10),
    lastClientX: window.innerWidth / 2,
    lastClientY: window.innerHeight / 2,
  };

  // The corridor Graphics lives in world space on the stage; its points are world pixels.
  const graphics = new PIXI.Graphics();
  graphics.eventMode = "none";   // never intercept the confirming click
  canvas.stage.addChild(graphics);

  // The readout is DOM (styleable + localizable), positioned by the cursor — never canvas text.
  const readout = document.createElement("div");
  readout.className = "cp-spread-preview-readout";
  document.body.appendChild(readout);

  const fillColor = Number(foundry.utils.Color.from(SPREAD_ZONE_LOOK.fillColor));
  const lineColor = Number(foundry.utils.Color.from(SPREAD_ZONE_LOOK.outlineColor));

  /** The corridor the current cursor position describes — the ONE derivation both halves read. */
  const specNow = () => {
    const distM = Math.max(SPREAD_MIN_LENGTH_M, pixelsToMeters(scene, state.reachPx));
    const { band, widthM } = spreadBandSpec(distM, widths);
    return { distM, band, widthM, dmgFormula: spreadBandDamage(band, formulas) };
  };

  const redraw = () => {
    const spec = specNow();
    const shape = rayPolygonShape(origin.x, origin.y, state.angleDeg,
      metersToPixels(scene, spec.distM), metersToPixels(scene, spec.widthM));
    _drawCorridor(graphics, shape.points, fillColor, lineColor);
    readout.textContent = localizeParam("SpreadPreviewReadout", {
      band: localize(`SpreadBand${spec.band}`), width: spec.widthM, dmg: spec.dmgFormula,
    });
    readout.style.left = `${state.lastClientX + 16}px`;
    readout.style.top = `${state.lastClientY + 16}px`;
  };

  const onMove = (ev) => {
    state.lastClientX = ev.clientX;
    state.lastClientY = ev.clientY;
    const w = _clientToWorld(ev.clientX, ev.clientY);
    state.angleDeg = (Math.atan2(w.y - origin.y, w.x - origin.x) * 180) / Math.PI;
    state.reachPx = Math.hypot(w.x - origin.x, w.y - origin.y);
    redraw();
  };

  const onDown = (ev) => {
    if (ev.button === 2) { ev.preventDefault(); ev.stopPropagation(); cancel(); return; }  // right-click cancels
    if (ev.button !== 0) return;                                                            // only left confirms
    ev.preventDefault();
    ev.stopPropagation();
    confirm();
  };

  const onContext = (ev) => { ev.preventDefault(); ev.stopPropagation(); };  // suppress the browser menu on cancel

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
    const spec = specNow();
    const aimX = origin.x + Math.cos((state.angleDeg * Math.PI) / 180) * metersToPixels(scene, spec.distM);
    const aimY = origin.y + Math.sin((state.angleDeg * Math.PI) / 180) * metersToPixels(scene, spec.distM);
    // The overshoot rule (see _tokenAtPoint): a figure standing on the aim point must be unambiguously
    // inside the corridor rather than balanced on its end edge.
    const under = _tokenAtPoint(aimX, aimY);
    const halfM = under
      ? (pixelsToMeters(scene, Number(canvas?.dimensions?.size) || 100)
         * ((Number(under.document?.width ?? under.width) || 1) / 2))
      : 0;
    teardown();
    // ⭐ AN ANGLE AND TWO REACHES, NOT A POINT. Every consumer of this corridor rebuilds it off the
    // shooter's CURRENT figure — the plant, and the presentation rail — so the axis is derived once,
    // in one basis, rather than stored as a pair of world coordinates that a token moved between the
    // aim and the roll would silently contradict. `reachM` is where the shooter clicked (what the rail
    // draws the rounds to); `lengthM` is that plus the overshoot (what the region is planted to, so
    // containment is unambiguous). The origin is recorded for reference and as the fallback.
    resolve({
      sceneId: scene.id,
      originX: origin.x, originY: origin.y,
      angleDeg: state.angleDeg,
      reachM: spec.distM,
      lengthM: Math.max(SPREAD_MIN_LENGTH_M, spec.distM + halfM),
      widthM: spec.widthM,
      band: spec.band,
      dmgFormula: spec.dmgFormula,
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
    ? localizeParam("SpreadPreviewArmedFor", { name: weaponName })
    : localize("SpreadPreviewArmed"));
  redraw();
  return done;
}

/** Cancel any live preview (exported for teardown / tests). Its promise settles as a cancel. */
export function cancelSpreadPreview() {
  try { _active?.cancel(); } catch (_e) { /* ignore */ }
}

/** Is an aim gesture live on this client right now? Read by the keeper; nothing in the flow branches on it. */
export function spreadPreviewActive() {
  return _active !== null;
}
