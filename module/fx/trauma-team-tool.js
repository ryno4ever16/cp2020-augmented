/**
 * trauma-team-tool.js — the referee-facing gesture that places the medical-extraction arrival.
 *
 * Two halves, and both are deliberately thin:
 *   • the CONTROL — one momentary button added to the token scene-control group. It augments an
 *     existing group's `tools` rather than registering a canvas layer of its own, which is the idiom
 *     the radiation tools and the cover placement already follow on this module (and which they took
 *     from df-active-lights). Referee-only at render, and again inside the handler, because a control
 *     that is merely hidden is not a control that is refused.
 *   • the GHOST — the marked rectangle following the cursor until a click puts it down. Structurally
 *     this is combat/spread-placement.js: a world-space PIXI outline on the stage, window-level capture
 *     listeners so the click cannot be eaten by a placeable, a right-click / Esc cancel, and a
 *     `canvasTearDown` safety net so no orphaned Graphics or listener survives a scene change. It draws
 *     the SAME rectangle the sequence will (fx/trauma-team.js `landingRect`), by import rather than by
 *     copy, so what the referee aims is what the module puts down.
 *
 * ⚠ THIS FILE SPENDS NOTHING AND WRITES NOTHING. Cancelling costs nothing because nothing has happened
 * yet, and confirming only calls the presentation rail — no document is created at either end.
 *
 * THE BUTTON IS A TOGGLE IN BEHAVIOUR, NOT IN STATE: with nothing on station it arms the ghost; with
 * something on station it sends that away. One control for both, because "there is an airframe over my
 * scene" is a fact the referee can already see, and a second button for the second half of one act is
 * clutter.
 */

import {
  landingRect, landTraumaTeam, endTraumaTeam, traumaTeamActive,
} from "./trauma-team.js";
import { localize } from "../utils.js";

const SCOPE = "cp2020-augmented";

/**
 * The ghost's look. Amber, because the rectangle it previews carries amber caution marks, and thin,
 * because it is an outline over somebody's map rather than a slab on it. One block, one veto each.
 */
export const LANDING_GHOST = Object.freeze({
  fillColor: 0xffb020,
  fillAlpha: 0.12,
  lineColor: 0xffc94d,
  lineAlpha: 0.9,
  lineWidth: 3,
});

/** The one live ghost (only ever one at a time). Null when nothing is being placed. */
let _active = null;

/** Register the scene-teardown safety net exactly once (lazy — no init wiring needed). */
let _tearDownHooked = false;
function _ensureTearDownHook() {
  if (_tearDownHooked) return;
  _tearDownHooked = true;
  Hooks.on("canvasTearDown", () => { try { _active?.cancel(); } catch (_e) { /* already gone */ } });
}

/** Draw the outline, tolerant of the PIXI v7 (beginFill) and v8 (fill/stroke) APIs. */
function _drawRect(g, rect) {
  g.clear();
  const x = rect.x - rect.w / 2;
  const y = rect.y - rect.h / 2;
  if (typeof g.beginFill === "function") {
    g.beginFill(LANDING_GHOST.fillColor, LANDING_GHOST.fillAlpha);
    g.lineStyle(LANDING_GHOST.lineWidth, LANDING_GHOST.lineColor, LANDING_GHOST.lineAlpha);
    g.drawRect(x, y, rect.w, rect.h);
    g.endFill();
  } else {
    g.rect(x, y, rect.w, rect.h);
    g.fill({ color: LANDING_GHOST.fillColor, alpha: LANDING_GHOST.fillAlpha });
    g.stroke({ width: LANDING_GHOST.lineWidth, color: LANDING_GHOST.lineColor, alpha: LANDING_GHOST.lineAlpha });
  }
}

/** Screen (client) point → world (stage-local) point, using the stage's own transform. */
function _clientToWorld(clientX, clientY) {
  const t = canvas?.stage?.worldTransform;
  if (!t) return { x: clientX, y: clientY };
  const p = t.applyInverse(new PIXI.Point(clientX, clientY));
  return { x: p.x, y: p.y };
}

/** The scene's own snap, where this core offers one — a marked area sitting off-grid reads as a mistake. */
function _snap(point) {
  try {
    const snapped = canvas?.grid?.getSnappedPoint?.(point, { mode: 0xff0, resolution: 1 });
    if (snapped && Number.isFinite(snapped.x) && Number.isFinite(snapped.y)) return snapped;
  } catch (_e) { /* this core has no snap for the mode asked; the raw point is fine */ }
  return point;
}

/**
 * Arm the placement ghost on THIS client and resolve once the referee has answered.
 * @returns {Promise<{x:number,y:number}|null>} the confirmed centre, or null when cancelled
 */
export async function armLandingPicker() {
  _ensureTearDownHook();
  if (_active) { try { _active.cancel(); } catch (_e) { /* ignore */ } }
  if (!canvas?.ready || !canvas.scene) {
    ui.notifications?.warn?.(localize("TraumaTeamNoScene"));
    return null;
  }

  const gridPx = Number(canvas?.dimensions?.size) || 100;
  const state = { x: canvas.dimensions.width / 2, y: canvas.dimensions.height / 2 };

  const graphics = new PIXI.Graphics();
  graphics.eventMode = "none";           // never intercept the confirming click
  canvas.stage.addChild(graphics);

  const redraw = () => _drawRect(graphics, landingRect(state, gridPx));

  const onMove = (ev) => {
    const w = _snap(_clientToWorld(ev.clientX, ev.clientY));
    state.x = w.x; state.y = w.y;
    redraw();
  };
  const onDown = (ev) => {
    if (ev.button === 2) { ev.preventDefault(); ev.stopPropagation(); cancel(); return; }
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    confirm();
  };
  const onContext = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
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
    if (_active === handle) _active = null;
  };
  const cancel = () => {
    if (!settle) return;
    const resolve = settle; settle = null;
    teardown();
    resolve(null);
  };
  const confirm = () => {
    if (!settle) return;
    const resolve = settle; settle = null;
    const point = { x: state.x, y: state.y };
    teardown();
    resolve(point);
  };

  const handle = { cancel, teardown };
  _active = handle;

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("contextmenu", onContext, true);
  window.addEventListener("keydown", onKey, true);

  ui.notifications?.info?.(localize("TraumaTeamPickerArmed"));
  redraw();
  return done;
}

/** Cancel any live ghost (exported for teardown / tests). Its promise settles as a cancel. */
export function cancelLandingPicker() {
  try { _active?.cancel(); } catch (_e) { /* ignore */ }
}

/** Is a placement gesture live on this client right now? Read by the keeper; nothing branches on it. */
export function landingPickerActive() {
  return _active !== null;
}

/**
 * THE CONTROL'S HANDLER — the second referee gate, and the one that actually refuses. Returns what it
 * did, by value, so both halves and the refusal are assertable.
 */
export async function onTraumaTeamTool() {
  if (game.user?.isGM !== true) return { skipped: "permission" };
  if (traumaTeamActive()) {
    const departed = await endTraumaTeam();
    ui.notifications?.info?.(localize("TraumaTeamDeparted"));
    return { departed };
  }
  const point = await armLandingPicker();
  if (!point) return { skipped: "cancelled" };
  const placed = await landTraumaTeam(point);
  if (!placed.skipped) ui.notifications?.info?.(localize("TraumaTeamPlaced"));
  return { placed };
}

/**
 * Add the placement control to the token scene-control group (pure of the hook — exported for the
 * keeper). Augments an EXISTING group's `tools`; no bespoke canvas layer. Referee-only. Returns true
 * when the control was added, for the keeper's negative case.
 */
export function addTraumaTeamTool(controls) {
  if (game.user?.isGM !== true) return false;
  const tokens = controls?.tokens;
  if (!tokens?.tools) return false;
  tokens.tools["cp-tt-land"] = {
    name: "cp-tt-land",
    title: localize("TraumaTeamTool"),
    icon: "fa-solid fa-helicopter-symbol",
    button: true,
    order: Object.keys(tokens.tools).length,
    onChange: () => { onTraumaTeamTool().catch((e) => console.warn(`${SCOPE} | arrival control failed`, e)); },
  };
  return true;
}

/** Install the control (the getSceneControlButtons hook). Wrapped so a control-API shift cannot break
 *  the scene controls. Wired once from cp2020-augmented.js. */
export function registerTraumaTeamTool() {
  Hooks.on("getSceneControlButtons", (controls) => {
    try { addTraumaTeamTool(controls); } catch (e) { console.warn(`${SCOPE} | arrival control failed`, e); }
  });
}
