/**
 * suppressive-placement.js — the client-side aim/size preview for a suppressive-fire lane.
 *
 * Placement-forward suppressive fire (the user's design): when a shooter declares suppressive fire the
 * width of the beaten lane IS the evasion difficulty (save = rounds fired ÷ zone width in metres, CP2020
 * p.101), so the player must SEE the lane on the map while they choose it — a blind width field hid the
 * action's central tradeoff. This module runs entirely on the SHOOTING client (a non-GM player included):
 * it draws a PIXI corridor anchored at the shooter's token, aims it with the cursor, sizes its width with
 * the mouse wheel, and shows a live "width Xm → evasion save N" readout. On confirm it relays the drawn
 * geometry to the active GM (players cannot create scene Regions — Foundry's permission model — so the GM
 * plants the actual lane); on cancel it posts nothing and cleans up.
 *
 * The corridor outline and the planted region shape are both built from the SAME pure geometry
 * (area-geometry.js rayPolygonShape) off the SAME origin/angle/length/width, so the preview the player
 * sees is pixel-identical to the lane the GM plants. The GM-side plant + the lock/unlock loop live in
 * damage-hooks.js; this file only knows how to draw, measure, and hand off geometry.
 */

import { rayPolygonShape } from "./area-geometry.js";
import { metersToPixels } from "../vehicle/vehicle-grid.js";
import { localize, localizeParam } from "../utils.js";

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

/** The token the lane is anchored to (the shooter), by token id then owning actor id. Null if not on canvas. */
function _resolveShooterToken({ attackerTokenId, actorId }) {
  const byId = attackerTokenId ? canvas?.tokens?.get(attackerTokenId) : null;
  if (byId) return byId;
  return actorId ? (canvas?.tokens?.placeables?.find((t) => t.actor?.id === actorId) ?? null) : null;
}

/**
 * Arm the aim/size preview on THIS client for a suppressive burst. Called by damage-hooks on the shooting
 * client (the `cyberpunk2020.suppressiveFire` seam hook is local to the firer) and again, primed with the
 * existing geometry, when the GM unlocks a placed lane (`rearm: true`, carrying `regionId`).
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

  // No GM connected → the confirmed lane could never be planted (only the GM can create a Region). Don't
  // waste the player's aim gesture: warn and skip arming entirely. When THIS client is the GM, activeGM
  // resolves to them, so a GM firing solo still arms. (Chosen over a confirm-time drop so the player never
  // aims into the void.)
  if (!game.users?.activeGM) {
    ui.notifications?.warn?.(localize("SuppNoActiveGM"));
    return;
  }

  const shooterTok = _resolveShooterToken(opts);
  const origin = opts.origin ?? (shooterTok
    ? { x: shooterTok.center?.x ?? shooterTok.x, y: shooterTok.center?.y ?? shooterTok.y }
    : null);
  if (!origin) {
    ui.notifications?.warn?.(localize("SuppFireNoToken"));
    return;
  }

  const scene = canvas.scene;
  const roundsFired = Math.max(0, Math.floor(Number(opts.roundsFired) || 0));
  const lengthM = Math.max(1, Number(opts.weaponRange) || 50);
  const WIDTH_FLOOR = 2;   // metres — the rulebook floor on a suppressive lane's width
  const WIDTH_STEP = 1;    // metres per wheel notch

  const state = {
    origin,
    angleDeg: Number.isFinite(opts.angleDeg) ? Number(opts.angleDeg) : 0,
    // Seed the opening width from the DECLARED zone width (the dialog's zoneWidth field, floored at 2m); an
    // unlock re-arm instead carries the existing lane's widthM. Either way the shooter can re-size with the
    // wheel. The live DC readout is ceil(roundsFired / this width).
    widthM: Math.max(WIDTH_FLOOR, Math.floor(Number(opts.widthM ?? opts.zoneWidth) || WIDTH_FLOOR)),
    lastClientX: window.innerWidth / 2,
    lastClientY: window.innerHeight / 2,
  };

  // The corridor Graphics lives in world space on the stage; its points are world pixels.
  const graphics = new PIXI.Graphics();
  graphics.eventMode = "none";   // never intercept the confirming click
  canvas.stage.addChild(graphics);

  // The readout is DOM (styleable + localizable), positioned by the cursor — never canvas text.
  const readout = document.createElement("div");
  readout.className = "cp-supp-preview-readout";
  document.body.appendChild(readout);

  const dcFor = (widthM) => Math.max(1, Math.ceil(roundsFired / Math.max(1, widthM)));

  const redraw = () => {
    const lengthPx = metersToPixels(scene, lengthM);
    const widthPx = metersToPixels(scene, state.widthM);
    const shape = rayPolygonShape(state.origin.x, state.origin.y, state.angleDeg, lengthPx, widthPx);
    _drawCorridor(graphics, shape.points, 0xff4400, 0xff8844);
    readout.textContent = localizeParam("SuppPreviewReadout", { width: state.widthM, dc: dcFor(state.widthM) });
    readout.style.left = `${state.lastClientX + 16}px`;
    readout.style.top = `${state.lastClientY + 16}px`;
  };

  const onMove = (ev) => {
    state.lastClientX = ev.clientX;
    state.lastClientY = ev.clientY;
    const w = _clientToWorld(ev.clientX, ev.clientY);
    state.angleDeg = (Math.atan2(w.y - state.origin.y, w.x - state.origin.x) * 180) / Math.PI;
    redraw();
  };

  // The aim listeners are window-level captures, so each one first checks the event actually landed on
  // the game canvas (`#board`) — without that, a click on ANY open UI (an actor sheet being dragged out
  // of the way, the sidebar) would confirm the lane, and a wheel over a sheet would resize it instead of
  // scrolling (user-hit 2026-08-12, in the spread twin). Events on UI elements are left entirely alone.
  const isCanvasEvent = (ev) => ev.target === canvas?.app?.view || ev.target?.id === "board";

  const onWheel = (ev) => {
    if (!isCanvasEvent(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    // Scroll up widens the lane (easier save), scroll down narrows it toward the 2m floor (harder save).
    state.widthM = ev.deltaY < 0 ? state.widthM + WIDTH_STEP : Math.max(WIDTH_FLOOR, state.widthM - WIDTH_STEP);
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
    // Freeze the drawn geometry into a relay payload. lengthPx/widthPx are computed here (on the shooter's
    // scene) so the GM plants the identical polygon without re-reading grid scale; the metre values and
    // origin/angle ride along so an UNLOCK can re-prime this preview with the same lane.
    const lengthPx = metersToPixels(scene, lengthM);
    const widthPx = metersToPixels(scene, state.widthM);
    const geo = {
      sceneId: scene.id,   // plant on THIS scene even if the GM is viewing another (grid was read here)
      origin: state.origin,
      angleDeg: state.angleDeg,
      widthM: state.widthM,
      lengthPx,
      widthPx,
      weaponRange: lengthM,
      roundsFired,
      saveDC: dcFor(state.widthM),
      dmgFormula: opts.dmgFormula || "1d6",
      weaponName: opts.weaponName || "",
      actorId: opts.actorId || "",
      attackerTokenId: opts.attackerTokenId || "",
      userId: opts.userId || game.user?.id || "",
      regionId: opts.regionId || null,   // present on a re-confirm after unlock → the GM UPDATES that region
    };
    teardown();
    try {
      if (game.users?.activeGM?.id === game.user?.id) {
        // We are the GM — plant directly (a socket emit never reaches its own sender).
        const { placeSuppressiveZoneFromGeometry } = await import("./damage-hooks.js");
        await placeSuppressiveZoneFromGeometry(geo);
      } else {
        game.socket.emit("module.cp2020-augmented", { type: "suppressiveZonePlace", payload: geo });
      }
    } catch (e) {
      console.warn(`${SCOPE} | suppressive placement relay failed`, e);
    }
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

/** Cancel any live preview (exported for teardown / tests). */
export function cancelSuppressivePreview() {
  try { _active?.cancel(); } catch (_e) { /* ignore */ }
}
