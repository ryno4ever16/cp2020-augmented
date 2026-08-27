/**
 * suppressive-placement.js — the client-side placement preview for a suppressive fire zone.
 *
 * Placement-forward suppressive fire (the user's design): when a shooter declares suppressive fire the
 * width of the fire zone IS the evasion difficulty (save = rounds fired ÷ zone width in metres, CP2020
 * p.101), so the player must SEE the zone on the map while they place it — a blind width field hid the
 * action's central tradeoff. This module runs entirely on the SHOOTING client (a non-GM player included):
 * it draws a PIXI square, carries it on the cursor, re-sizes and turns it with the mouse wheel, and shows
 * a live "width Xm → evasion save N" readout. On confirm it relays the drawn geometry to the active GM (players
 * cannot create scene Regions — Foundry's permission model — so the GM plants the actual zone); on cancel
 * it posts nothing and cleans up.
 *
 * ⭐ THE ZONE IS A SQUARE, WIDTH × WIDTH (ruled 2026-08-27, ledger #23as). The book gives the fire zone
 * exactly one measurement — p.101 divides the save by "the width of the fire zone in meters", and the
 * p.106-107 worked examples call the whole thing "a 2 meter area" — so a second axis would be bought for
 * nothing: the same rounds price the same save however far the zone runs. What this replaced ran the
 * zone the whole of the weapon's Range stat, which put a 400 m strip across the map for one burst and
 * priced none of it. Depth ≈ width is the printed shape, and it is also the geometry the base system's
 * own 1.2 development builds, so the two converge on one zone rather than two readings of one rule.
 *
 * ⭐⭐ TWO PLACEMENT PATHS, CHOSEN BY CAPABILITY, NEVER BY VERSION SNIFFING (ruled 2026-08-27): where
 * Foundry ships a native placement API we use it, exactly as the base system's own 1.2 development build
 * does, instead of maintaining a hand-rolled twin of it.
 *
 *   · NATIVE (v14+) — `canvas.regions.placeRegion(data, {create: false, preConfirm})`. Core owns the
 *     preview object, the cursor carry, grid snapping, the confirming click, right-click skip, ESC
 *     dismiss and the off-map refusal; we own only the shape we hand it and the gesture bindings. The
 *     call shape MIRRORS the base system's: one `rectangle` shape, `width = height = sidePx`,
 *     `anchorX: 0, anchorY: 0.5`, `levels: [canvas.level.id]`, `visibility: ALWAYS`, `create: false`
 *     (a preview document, never a database write — which is why a PLAYER can run it at all, and why a
 *     paused world does not block it: only creation is gated). `preConfirm` refuses a placement whose
 *     anchor is off the map, the same guard and the same wording as his.
 *   · LEGACY (v13) — v13 core has no `placeRegion` at all, so the hand-rolled PIXI preview below stays
 *     as the fallback and carries the identical gesture split. It retires with v13 support; nothing new
 *     should be taught to it that is not also taught to the native path.
 *
 * The branch is a CAPABILITY PROBE (`typeof canvas.regions?.placeRegion === "function"`), never a core
 * version test, so a core that gains or loses the API is followed automatically. `_setNativePlacement`
 * is the test seam that forces either path on one client.
 *
 * ⭐ THE WHEEL SPLIT: PLAIN wheel RE-SIZES, SHIFT+wheel TURNS (ruled 2026-08-27, ledger #23aw), on BOTH
 * paths. The fire dialog's declared fire-zone number seeds the opening size and nothing else changes
 * about where it comes from; from there a plain notch steps the width one metre, and SHIFT+notch turns
 * the square. The shooter is the one standing at this preview and, being a player, is also the one who
 * will NEVER be able to touch the zone again — scene Region controls are GM-only — so placement is their
 * single chance to size the thing they are paying for, which is why the re-size gesture outranks the turn
 * gesture for the unmodified wheel. Nothing downstream moves with it: the readout, the relayed payload
 * and the planted region all read the SAME live width, so the save on the card is recomputed from the
 * width actually placed rather than the width originally typed. The wheel enforces the same bounds the
 * declaration does — 2 m floor, and no wider than the rounds this burst fires (past which the save goes
 * inert at 1) — the pair being authored in module/dialog/modifiers.js, so scrolling can never reach a
 * figure the save math would reject.
 *
 * ⛔ WHERE THE NATIVE GESTURE HAD TO BE SPLIT ACROSS TWO SEAMS, and it is core's routing that forces it.
 * `MouseManager##onWheel` (client/helpers/interaction/mouse-manager.mjs) hands a wheel event to
 * `canvas.activeLayer._onMouseWheel` — the call that reaches core's `onRotate` hook — ONLY while Ctrl or
 * Shift is held; an unmodified notch is core's canvas ZOOM and never reaches the region layer at all. So
 * the modified half of the ratified gesture rides the sanctioned hook and the unmodified half cannot:
 *   · SHIFT+wheel → core's own `_onMouseWheel` → our `onRotate` returns undefined → CORE rotates the
 *     shape (15° coarse, since core reads `precise = !event.shiftKey`). Rotation is not reimplemented.
 *   · plain wheel → a capture-phase window listener live only for the duration of the placement, which
 *     re-sizes the shape by the SAME mechanism core's own wheel handler uses (mutate the placement
 *     context's shape with `updateSource`, re-`updateSource` the preview document's shapes, then
 *     `updateShapeConstraints()` + `refreshShapes`) and stops the event so core does not zoom under it.
 * The legacy preview loses no zoom it ever had — its own wheel handler already consumed every notch
 * over the board.
 *
 * ⛔ A KNOWN, DELIBERATE DIVERGENCE FROM THE INSTALLED BASE SYSTEM'S CARD (documented 2026-08-27, not a
 * bug to be fixed here). Our save quotient rounds DOWN (see `_dcFor`); the base 1.1.x system's own
 * suppressive card computes `Math.ceil(rounds / width)` (its module/item/item.js, the `saveDC` line) and
 * posts that number. We deliberately do not recompute or rewrite his card — rewriting another package's
 * posted message is exactly the kind of reach this module refuses. So on a 1.1.x host a burst whose
 * quotient is fractional shows the base card ONE HIGHER than the number the zone actually asks a crossing
 * token for. The ZONE PROMPT is the resolving number and the one the book's example matches; the base
 * card is informational and off-book on this point. The divergence disappears at upstream 1.2, where his
 * own derivation floors and our zone stands down in favour of his.
 *
 * On confirm BOTH paths produce the identical relay payload `geo`, read off the placed square: the
 * anchor point is `origin`, the shape's rotation is `angleDeg`, and the side is `widthM` / `lengthPx` /
 * `widthPx`. The GM-side plant rebuilds that with area-geometry.js `rayPolygonShape` off the same origin
 * and angle with equal length and width — the same square, from the same numbers — so the plant, the
 * socket relay and the lock/unlock loop in damage-hooks.js needed no change for either path. The origin
 * is the middle of the square's near edge (`anchorX: 0, anchorY: 0.5`): that is the point the cursor
 * holds, the point a turn pivots about, and the edge a re-size grows away from, so the square stands in
 * front of the cursor and swings about it instead of pivoting on a corner, and widening never walks it
 * back over the shooter. This file only knows how to preview, measure, and hand off geometry.
 */

import { rayPolygonShape } from "./area-geometry.js";
import { metersToPixels } from "../vehicle/vehicle-grid.js";
import { localize, localizeParam } from "../utils.js";
import { isPrimaryGMSession } from "../gm-session-primary.js";

const SCOPE = "cp2020-augmented";

/** The one live preview (only ever one at a time). Null when nothing is being aimed. */
let _active = null;

/** Register the scene-teardown safety net exactly once (lazy — no init wiring needed). */
let _tearDownHooked = false;
function _ensureTearDownHook() {
  if (_tearDownHooked) return;
  _tearDownHooked = true;
  // A scene change / canvas rebuild pulls the stage out from under any live preview — cancel it so no
  // orphaned Graphics or window listeners survive the teardown.
  Hooks.on("canvasTearDown", () => { try { _active?.cancel(); } catch (_e) { /* already gone */ } });
}

/** Draw a filled + outlined polygon, tolerant of the PIXI v7 (beginFill) and v8 (fill/stroke) APIs. */
function _drawCorridor(g, points, fillColor, lineColor) {
  g.clear();
  if (typeof g.beginFill === "function") {
    // PIXI v7 (Foundry v13/v14): retained immediate-mode API.
    g.beginFill(fillColor, 0.18);
    g.lineStyle(2, lineColor, 0.9);
    g.drawPolygon(points);
    g.endFill();
  } else {
    // PIXI v8+: builder API.
    g.poly(points);
    g.fill({ color: fillColor, alpha: 0.18 });
    g.stroke({ width: 2, color: lineColor, alpha: 0.9 });
  }
}

/** Screen (client) point → world (stage-local) point, using the stage's own transform. */
function _clientToWorld(clientX, clientY) {
  const t = canvas?.stage?.worldTransform;
  if (!t) return { x: clientX, y: clientY };
  const p = t.applyInverse(new PIXI.Point(clientX, clientY));
  return { x: p.x, y: p.y };
}

/** The shooter's token, by token id then owning actor id. Null if not on canvas. */
function _resolveShooterToken({ attackerTokenId, actorId }) {
  const byId = attackerTokenId ? canvas?.tokens?.get(attackerTokenId) : null;
  if (byId) return byId;
  return actorId ? (canvas?.tokens?.placeables?.find((t) => t.actor?.id === actorId) ?? null) : null;
}

/**
 * Where the square sits before the pointer has moved once. Placement is free, so this is only an
 * opening position: the shooter's own token when one is on the canvas (the square then starts at the
 * muzzle and is carried out from there), the re-armed zone's own origin on an unlock, and the centre of
 * the viewed area when neither is available. Nothing here refuses to arm — a shooter with no token on
 * the canvas can still place a zone, which is the whole point of free placement.
 */
function _openingOrigin(opts) {
  if (Number.isFinite(opts?.origin?.x) && Number.isFinite(opts?.origin?.y)) return { x: opts.origin.x, y: opts.origin.y };
  const tok = _resolveShooterToken(opts ?? {});
  if (tok) return { x: tok.center?.x ?? tok.x, y: tok.center?.y ?? tok.y };
  const r = canvas?.dimensions?.rect;
  return { x: (r?.x ?? 0) + (r?.width ?? 0) / 2, y: (r?.y ?? 0) + (r?.height ?? 0) / 2 };
}

const WIDTH_FLOOR = 2;      // metres — the rulebook floor on a fire zone's width
const WIDTH_STEP = 1;       // metres per plain wheel notch
const ROTATE_STEP_DEG = 15; // degrees per SHIFT+wheel notch on the legacy preview (core's own coarse step)

/**
 * The wheel's ceiling for a burst: a zone wider than the rounds fired divides the save below 1, where it
 * is pinned anyway, so every metre past this one would be free. Raised to the floor for a burst so short
 * the two would cross.
 */
function _widthCap(roundsFired) { return Math.max(WIDTH_FLOOR, roundsFired); }

/**
 * The evasion save a burst of `roundsFired` asks for at `widthM` metres — CP2020 p.101, the quotient
 * ROUNDED DOWN (ruled 2026-08-27). The book settles the rounding in its own worked example: p.106 puts
 * 64 rounds into a 5-metre area and calls for "a save of 12 or greater" — 12.8 floored, not 13 — and the
 * base system's 1.2 development build computes `Math.floor` at both of its sites (its item/item.js at
 * fire time, its combat.js in the turn upkeep), so the two readings converge. The `max(1, …)` guard stays:
 * a save of 0 or less is not a save, and it is what pins the wheel's own width cap.
 */
function _dcFor(roundsFired, widthM) { return Math.max(1, Math.floor(roundsFired / Math.max(1, widthM))); }

/**
 * The opening width: the DECLARED fire-zone number and nothing else — the dialog's zoneWidth field, or the
 * existing zone's widthM on an unlock re-arm. The 2 m floor is repeated here because a payload can reach
 * this file from an older card or a relay, not because the declaration is unchecked.
 */
function _seedWidth(opts) {
  return Math.max(WIDTH_FLOOR, Math.floor(Number(opts?.widthM ?? opts?.zoneWidth) || WIDTH_FLOOR));
}

/**
 * One plain wheel notch, as a value. Scroll away widens the zone (an easier save), scroll toward narrows it
 * (a harder one). The cap is applied only when WIDENING and is itself floored at the current width, so a
 * re-armed zone seeded wider than this burst's cap (an unlock of an older lane) is never yanked smaller by
 * the first notch — it can only be walked down by hand. Pure, so both placement paths step identically.
 */
function _steppedWidth(widthM, deltaY, roundsFired) {
  const step = deltaY < 0 ? WIDTH_STEP : -WIDTH_STEP;
  return step > 0
    ? Math.min(Math.max(_widthCap(roundsFired), widthM), widthM + step)
    : Math.max(WIDTH_FLOOR, widthM + step);
}

/** The cursor-following width/save readout — DOM (styleable + localizable), never canvas text. */
function _makeReadout() {
  const el = document.createElement("div");
  el.className = "cp-supp-preview-readout";
  document.body.appendChild(el);
  return el;
}

/**
 * The event gate both paths share: a wheel or a click that landed on open UI (a sheet dragged out of the
 * way, the sidebar) is not a placement gesture. Without it a scroll over a sheet re-sized the zone instead
 * of scrolling the sheet (user-hit 2026-08-12, in the spread twin).
 */
function _isCanvasEvent(ev) { return ev?.target === canvas?.app?.view || ev?.target?.id === "board"; }

/**
 * The relay payload, frozen off the placed square, and the hand-off. Identical on both placement paths so
 * the GM-side plant, the socket relay and the unlock loop in damage-hooks.js never learn which one ran.
 * The side rides in BOTH lengthPx and widthPx because the planted square is `rayPolygonShape`'s rectangle
 * with equal sides, and the GM-side plant reads those two names.
 */
async function _relayPlacement({ scene, opts, roundsFired, origin, angleDeg, widthM, sidePx }) {
  const geo = {
    sceneId: scene.id,   // plant on THIS scene even if the GM is viewing another (grid was read here)
    origin,
    angleDeg,
    widthM,
    lengthPx: sidePx,
    widthPx: sidePx,
    // Carried for the record only — the zone's size no longer reads the weapon's Range stat.
    weaponRange: Math.max(0, Number(opts.weaponRange) || 0),
    roundsFired,
    saveDC: _dcFor(roundsFired, widthM),
    dmgFormula: opts.dmgFormula || "1d6",
    weaponName: opts.weaponName || "",
    actorId: opts.actorId || "",
    attackerTokenId: opts.attackerTokenId || "",
    userId: opts.userId || game.user?.id || "",
    regionId: opts.regionId || null,   // present on a re-confirm after unlock → the GM UPDATES that region
  };
  try {
    if (isPrimaryGMSession()) {
      // We are the acting session — plant directly (a socket emit never reaches its own sender).
      // A GM's OTHER tab takes the relay branch instead, so the zone is planted exactly once.
      const { placeSuppressiveZoneFromGeometry } = await import("./damage-hooks.js");
      await placeSuppressiveZoneFromGeometry(geo);
    } else {
      game.socket.emit("module.cp2020-augmented", { type: "suppressiveZonePlace", payload: geo });
    }
  } catch (e) {
    console.warn(`${SCOPE} | suppressive placement relay failed`, e);
  }
  return geo;
}

/* ─────────────────────────── The capability probe and its test seam ─────────────────────────── */

/**
 * Forced answer for the native-placement probe, armed by nothing that ships. It exists because the two
 * placement paths cannot both be exercised on one core: :30004 is v14 and would only ever run the native
 * one, leaving the v13 fallback certified by nothing until v13 support retires.
 */
let _nativePlacementOverride = null;

/** Test seam: force the placement path (true = native, false = legacy preview, null = the real probe). */
export function _setNativePlacement(available) {
  _nativePlacementOverride = typeof available === "boolean" ? available : null;
  return _nativePlacementOverride;
}

/**
 * Does this core ship the native region placement API? A CAPABILITY probe, never a version test, so a core
 * that gains or loses `placeRegion` is followed without a release of ours. v13 has no such method (0 hits
 * in its regions layer); v14 does.
 */
export function nativePlacementAvailable() {
  if (_nativePlacementOverride !== null) return _nativePlacementOverride;
  return typeof canvas?.regions?.placeRegion === "function";
}

/**
 * Arm the placement preview on THIS client for a suppressive burst. Called by damage-hooks on the shooting
 * client (the `cyberpunk2020.suppressiveFire` seam hook is local to the firer) and again, primed with the
 * existing geometry, when the GM unlocks a placed zone (`rearm: true`, carrying `regionId`).
 *
 * ⛔ HOW LONG THE RETURNED PROMISE LIVES DIFFERS BY PATH — AND THAT CHANGED A CALLER. The legacy preview
 * arms its listeners and resolves at once; the native path resolves only when the placement ENDS
 * (confirmed, skipped or dismissed), because that is core's own contract. The fire hook may await it
 * harmlessly (Hooks ignores the returned promise), but the UNLOCK chain could not: awaiting there held a
 * GM's unlock button open for as long as the shooter took to aim, so both re-arm sites in damage-hooks.js
 * now START this and do not await it. Any NEW caller that must continue while the shooter is still aiming
 * has to do the same.
 *
 * @param {object} opts payload — { actorId, attackerTokenId, weaponRange, roundsFired, dmgFormula,
 *   weaponName, userId?, saveDC?, angleDeg?, widthM?, regionId?, rearm? }.
 */
export async function armSuppressivePreview(opts = {}) {
  _ensureTearDownHook();
  // One preview at a time — arming a second cancels the first (and its listeners) first.
  if (_active) { try { _active.cancel(); } catch (_e) { /* ignore */ } }

  if (!canvas?.ready || !canvas.scene) {
    ui.notifications?.warn?.(localize("SuppFireNoToken"));
    return;
  }

  // No GM connected → the confirmed zone could never be planted (only the GM can create a Region). Don't
  // waste the player's placement gesture: warn and skip arming entirely. When THIS client is the GM,
  // activeGM resolves to them, so a GM firing solo still arms. (Chosen over a confirm-time drop so the
  // player never places into the void.)
  if (!game.users?.activeGM) {
    ui.notifications?.warn?.(localize("SuppNoActiveGM"));
    return;
  }

  const scene = canvas.scene;
  const roundsFired = Math.max(0, Math.floor(Number(opts.roundsFired) || 0));
  return nativePlacementAvailable()
    ? _armNativePlacement({ scene, opts, roundsFired })
    : _armLegacyPreview({ scene, opts, roundsFired });
}

/**
 * ⚠ LEGACY PATH — the hand-rolled PIXI preview, for cores with no `canvas.regions.placeRegion` (v13). It
 * carries the same gesture split and produces the same payload as the native path, and retires with v13.
 */
async function _armLegacyPreview({ scene, opts, roundsFired }) {
  const state = {
    // Free placement: the origin is wherever the pointer is, and it is the MIDDLE OF THE NEAR EDGE of
    // the square rather than its centre, so the zone stands in front of the cursor and turns about it.
    origin: _openingOrigin(opts),
    angleDeg: Number.isFinite(opts.angleDeg) ? Number(opts.angleDeg) : 0,
    widthM: _seedWidth(opts),
    lastClientX: window.innerWidth / 2,
    lastClientY: window.innerHeight / 2,
  };

  // The corridor Graphics lives in world space on the stage; its points are world pixels.
  const graphics = new PIXI.Graphics();
  graphics.eventMode = "none";   // never intercept the confirming click
  canvas.stage.addChild(graphics);

  const readout = _makeReadout();
  const dcFor = (widthM) => _dcFor(roundsFired, widthM);

  /** The one geometry both the drawn outline and the planted region are built from: a square whose side
   *  is the declared width, anchored at the middle of its near edge. `rayPolygonShape` with EQUAL length
   *  and width is exactly that shape — the same helper the corridor used, given the one measurement the
   *  book prints for both axes. */
  const squareShape = (sidePx) => rayPolygonShape(state.origin.x, state.origin.y, state.angleDeg, sidePx, sidePx);

  const redraw = () => {
    const sidePx = metersToPixels(scene, state.widthM);
    _drawCorridor(graphics, squareShape(sidePx).points, 0xff4400, 0xff8844);
    readout.textContent = localizeParam("SuppPreviewReadout", { width: state.widthM, dc: dcFor(state.widthM) });
    readout.style.left = `${state.lastClientX + 16}px`;
    readout.style.top = `${state.lastClientY + 16}px`;
  };

  const onMove = (ev) => {
    state.lastClientX = ev.clientX;
    state.lastClientY = ev.clientY;
    // The zone rides the cursor. It used to be anchored to the shooter and only AIMED from there, which
    // is what made a zone the shooter could not stand beside impossible to place.
    const w = _clientToWorld(ev.clientX, ev.clientY);
    state.origin = { x: w.x, y: w.y };
    redraw();
  };

  // The placement listeners are window-level captures, so each one first checks the event actually
  // landed on the game canvas (`#board`) — without that, a click on ANY open UI (an actor sheet being
  // dragged out of the way, the sidebar) would confirm the zone, and a wheel over a sheet would turn it
  // instead of scrolling (user-hit 2026-08-12, in the spread twin). Events on UI elements are left
  // entirely alone. ⚠ `onMove` is deliberately NOT gated: free placement follows the pointer wherever
  // it goes, and the zone is only ever committed by a click that IS gated.
  const isCanvasEvent = _isCanvasEvent;

  const onWheel = (ev) => {
    if (!isCanvasEvent(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.shiftKey) {
      // SHIFT+wheel TURNS the square about the middle of its near edge — the point the cursor holds. The
      // native path hands this same gesture to CORE's rotate rather than doing the arithmetic itself.
      state.angleDeg = (state.angleDeg + (ev.deltaY < 0 ? -ROTATE_STEP_DEG : ROTATE_STEP_DEG)) % 360;
    } else {
      // Plain wheel RE-SIZES, by the same pure step the native path uses.
      state.widthM = _steppedWidth(state.widthM, ev.deltaY, roundsFired);
    }
    redraw();
  };

  const onDown = (ev) => {
    if (!isCanvasEvent(ev)) return;          // clicks on open UI move/close windows, never the aim
    if (ev.button === 2) { ev.preventDefault(); ev.stopPropagation(); cancel(); return; }  // right-click cancels
    if (ev.button !== 0) return;                                                            // only left confirms
    ev.preventDefault();
    ev.stopPropagation();
    confirm();
  };

  // Suppress the browser menu only over the canvas (the right-click cancel); UI menus stay usable.
  const onContext = (ev) => { if (isCanvasEvent(ev)) { ev.preventDefault(); ev.stopPropagation(); } };

  const onKey = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancel(); } };

  const removeListeners = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("wheel", onWheel, { capture: true });
    window.removeEventListener("contextmenu", onContext, true);
    window.removeEventListener("keydown", onKey, true);
  };

  const teardown = () => {
    removeListeners();
    try { graphics.parent?.removeChild(graphics); } catch (_e) { /* already detached */ }
    try { graphics.destroy(); } catch (_e) { /* already destroyed */ }
    try { readout.remove(); } catch (_e) { /* already gone */ }
    if (_active === handle) _active = null;
  };

  const cancel = () => { teardown(); };   // cancel posts nothing

  const confirm = async () => {
    // Freeze the drawn geometry into the SAME relay payload the native path produces. The side is computed
    // here (on the shooter's scene) so the GM plants the identical polygon without re-reading grid scale.
    const sidePx = metersToPixels(scene, state.widthM);
    teardown();
    await _relayPlacement({ scene, opts, roundsFired, origin: state.origin, angleDeg: state.angleDeg, widthM: state.widthM, sidePx });
  };

  const handle = { cancel, teardown };
  _active = handle;

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("contextmenu", onContext, true);
  window.addEventListener("keydown", onKey, true);

  ui.notifications?.info?.(localize("SuppPreviewArmed"));
  redraw();
}

/**
 * `preConfirm` for the native placement: refuse a square whose anchor is off the map, with the same guard
 * and the same shape of warning the base system uses. Returning false leaves the placement live, so the
 * shooter simply keeps aiming rather than losing the gesture.
 */
function _refuseOffMap({ shape }) {
  if (canvas?.dimensions?.sceneRect?.contains?.(shape.x, shape.y)) return undefined;
  ui.notifications?.warn?.(localize("SuppPlacementOffMap"));
  return false;
}

/**
 * ⭐ NATIVE PATH (v14+) — core owns the preview, we own the shape and the gestures.
 *
 * `create: false` returns the preview DOCUMENT and never touches the database, which is why a PLAYER can
 * run this at all and why a paused world does not block it: only creation is gated. The document is then
 * read for its final square and thrown away — the actual Region is planted by the GM from the relayed
 * geometry, exactly as before.
 */
async function _armNativePlacement({ scene, opts, roundsFired }) {
  const layer = canvas.regions;
  const state = { widthM: _seedWidth(opts), lastClientX: window.innerWidth / 2, lastClientY: window.innerHeight / 2 };
  const readout = _makeReadout();

  const paint = () => {
    readout.textContent = localizeParam("SuppPreviewReadout", { width: state.widthM, dc: _dcFor(roundsFired, state.widthM) });
    readout.style.left = `${state.lastClientX + 16}px`;
    readout.style.top = `${state.lastClientY + 16}px`;
  };

  /** Track the pointer for the readout only — core moves the square itself. */
  const trackPointer = (ev) => {
    if (Number.isFinite(ev?.clientX)) { state.lastClientX = ev.clientX; state.lastClientY = ev.clientY; }
    paint();
  };

  /**
   * Re-size the LIVE placement square by the mechanism core's own wheel handler uses, so the preview the
   * shooter is looking at is the one core will hand back on confirm: mutate the placement context's shape,
   * write it back over the preview document's last shape, re-derive the constraints and ask for a shape
   * refresh. Silent (and harmless) if the placement has already ended.
   */
  const resizeLivePreview = () => {
    const ctx = layer?._placementContext;
    const preview = ctx?.preview;
    const shape = ctx?.shape;
    const doc = preview?.document;
    if (!doc || !shape || typeof shape.updateSource !== "function") return false;
    const sidePx = metersToPixels(scene, state.widthM);
    shape.updateSource({ width: sidePx, height: sidePx });
    const diff = doc.updateSource({ shapes: [...doc.shapes.slice(0, -1), shape] });
    if (foundry.utils.isEmpty(diff)) return false;
    doc.updateShapeConstraints?.();
    preview.renderFlags?.set?.({ refreshShapes: true });
    return true;
  };

  /**
   * ⛔ THE UNMODIFIED HALF OF THE GESTURE, which core's routing will not deliver to `onRotate`.
   * `MouseManager##onWheel` only forwards to `canvas.activeLayer._onMouseWheel` while Ctrl or Shift is
   * held; a plain notch is the canvas ZOOM and never reaches the region layer. So the re-size rides a
   * capture-phase window listener that consumes plain notches over the board and leaves every modified one
   * to core. Live only for the duration of this placement.
   */
  const onPlainWheel = (ev) => {
    if (!_isCanvasEvent(ev)) return;                       // a scroll over open UI scrolls that UI
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey) return;   // modified notches are core's to rotate with
    ev.preventDefault();
    ev.stopPropagation();                                  // ...and core does not zoom under the preview
    state.widthM = _steppedWidth(state.widthM, ev.deltaY, roundsFired);
    resizeLivePreview();
    paint();
  };

  const teardown = () => {
    window.removeEventListener("wheel", onPlainWheel, { capture: true });
    window.removeEventListener("pointermove", trackPointer, true);
    try { readout.remove(); } catch (_e) { /* already gone */ }
    if (_active === handle) _active = null;
  };

  // Cancelling a native placement is core's own dismiss — the same path ESC takes.
  const handle = { cancel: () => { try { layer?._cancelPlacement?.(); } catch (_e) { /* not placing */ } teardown(); }, teardown };
  _active = handle;

  window.addEventListener("wheel", onPlainWheel, { capture: true, passive: false });
  window.addEventListener("pointermove", trackPointer, true);
  ui.notifications?.info?.(localize("SuppPreviewArmed"));
  paint();

  const sidePx = metersToPixels(scene, state.widthM);
  let placed = null;
  try {
    // The call shape MIRRORS the base system's suppression zone: one square rectangle anchored at the
    // middle of its near edge, on this level, always visible, previewed and never created.
    placed = await layer.placeRegion({
      name: localize("SuppZoneBehaviorLabel"),
      shapes: [{ type: "rectangle", x: 0, y: 0, width: sidePx, height: sidePx, anchorX: 0, anchorY: 0.5 }],
      ...(canvas.level?.id ? { levels: [canvas.level.id] } : {}),
      visibility: CONST?.REGION_VISIBILITY?.ALWAYS ?? 2,
    }, {
      create: false,
      preConfirm: _refuseOffMap,
      // Core calls this for every notch it routes (Ctrl or Shift held). Returning undefined lets CORE
      // rotate the shape — 15° coarse under Shift, 5° precise under Ctrl, its own steps, not ours — and
      // we only reprice the readout, which cannot move with a turn but is repainted for the cursor.
      onRotate: () => { paint(); return undefined; },
    });
  } catch (e) {
    console.warn(`${SCOPE} | native suppressive placement failed`, e);
  } finally {
    teardown();
  }

  // Dismissed (ESC) or skipped (right-click): nothing is posted, exactly as a legacy cancel.
  const shape = placed?.shapes?.[0];
  if (!shape) return;
  // The placed square, read back: its origin IS the anchor (the near-edge midpoint), its rotation is the
  // angle, and its width is the side — the three numbers the GM-side plant rebuilds the polygon from.
  await _relayPlacement({
    scene, opts, roundsFired,
    origin: { x: shape.x, y: shape.y },
    angleDeg: Number(shape.rotation) || 0,
    widthM: state.widthM,
    sidePx: Number(shape.width) || metersToPixels(scene, state.widthM),
  });
}

/** Cancel any live preview (exported for teardown / tests). */
export function cancelSuppressivePreview() {
  try { _active?.cancel(); } catch (_e) { /* ignore */ }
}
