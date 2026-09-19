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
 * ⚠ NOTHING IS SPENT AND NOTHING IS WRITTEN UNTIL THE CLICK LANDS. Both steps — the crew question and
 * the ghost — are cheap to abandon at any point, and cancelling either leaves the world exactly as it
 * was. Confirming calls the presentation rail, which writes documents only if the referee named a crew
 * (see fx/trauma-team.js, "The crew a referee can move afterwards"); with no crew named, still nothing.
 *
 * THE BUTTON IS A TOGGLE IN BEHAVIOUR, NOT IN STATE: with nothing on station it arms the ghost; with
 * something on station it sends that away. One control for both, because "there is an airframe over my
 * scene" is a fact the referee can already see, and a second button for the second half of one act is
 * clutter.
 */

import {
  landingRect, landTraumaTeam, endTraumaTeam, traumaTeamActive, clampCrewCount, TRAUMA_TEAM,
} from "./trauma-team.js";
import { localize, localizeParam } from "../utils.js";

const SCOPE = "cp2020-augmented";

const renderTpl = (path, data) =>
  (foundry.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate)(path, data);

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

/** The built-in aircraft, as the portrait shows it before an image is chosen. */
const PLACEHOLDER_IMG = `modules/${SCOPE}/img/av-lozenge.svg`;

/**
 * WHAT THE LAST CALL ASKED FOR, kept for the session on this client only. A referee calling the same
 * aircraft in twice should not have to find the picture twice; nothing about it is written anywhere.
 */
let _lastCall = { img: "", crewOn: false, rows: [] };
/** The file browser the window opened, if any — closed with the window so a pick cannot outlive it. */
let _picker = null;

/** The drag payload the platform puts on a sidebar drag, whichever namespace this core exposes it under. */
function dragDataOf(ev) {
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor ?? null;
  try { return TE?.getDragEventData?.(ev) ?? null; } catch (_e) { return null; }
}

/**
 * THE CALL WINDOW (reworked 2026-09-19, user-ruled). One window, three parts, asked BEFORE the spot is
 * picked so that the click stays the trigger:
 *   • the AIRCRAFT IMAGE — the sheet's own idiom (`data-edit="img"` → the platform's file browser),
 *     chosen per call; no world setting, because the gesture is opt-in by nature;
 *   • the CREW TOGGLE — tokens step off only when it is on; its tooltip is on the label TEXT only;
 *   • the SQUAD LIST — rows of actor + count in step-off order, with no ceiling on the total; an actor
 *     dragged from the sidebar onto the window becomes a row (or one more of an existing row).
 *
 * ⛔ THE LIST IS THE WORLD'S OWN ACTORS AND NOTHING ELSE. This module ships no NPC, names none and
 * bundles no stat block; the referee supplies the figures.
 *
 * The rows are cloned from the template's own hidden prototype row — the markup lives in the .hbs, the
 * wiring here. DialogV2's config `render` callback never fires on v14, so the wiring rides the
 * `renderDialogV2` hook, bound for exactly this dialog's lifetime (the cover dialog's idiom).
 *
 * @returns {Promise<{crew:Array<{actorId:string,count:number}>|null, img:string}|null>} null = backed out
 */
export async function promptTraumaTeamCrew() {
  const { DialogV2 } = foundry.applications.api;
  const actors = (game.actors?.contents ?? [])
    .map((a) => ({ id: a.id, name: String(a.name ?? "") }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const last = _lastCall;
  const content = await renderTpl(`modules/${SCOPE}/templates/dialog/trauma-team-crew.hbs`, {
    actors,
    img: last.img || PLACEHOLDER_IMG,
    imgValue: last.img,
    crewOn: last.crewOn,
  });

  const hookId = Hooks.on("renderDialogV2", (app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    const body = root?.querySelector?.(".cp-tt-crew-body");
    if (!body || body.dataset.cpWired === "1") return;
    body.dataset.cpWired = "1";
    const img = body.querySelector(".cp-tt-av-img");
    const imgIn = body.querySelector('input[name="cp-tt-img"]');
    const toggle = body.querySelector('input[name="cp-tt-crew-on"]');
    const squad = body.querySelector(".cp-tt-squad");
    const rowsEl = body.querySelector(".cp-tt-rows");
    const proto = body.querySelector(".cp-tt-row-proto");
    const seats = body.querySelector(".cp-tt-seats");

    const refresh = () => {
      const total = [...rowsEl.querySelectorAll(".cp-tt-row")]
        .filter((r) => r.querySelector(".cp-tt-row-actor")?.value)
        .reduce((n, r) => n + clampCrewCount(r.querySelector(".cp-tt-row-count")?.value), 0);
      if (seats) seats.textContent = total
        ? localizeParam("TraumaTeamCrewSeats", { n: total, marks: TRAUMA_TEAM.figureCount })
        : localize("TraumaTeamCrewSeatsNone");
    };
    const addRow = (actorId = "", count = 1) => {
      if (!proto || !rowsEl) return null;
      const row = proto.cloneNode(true);
      row.classList.remove("cp-tt-row-proto");
      const sel = row.querySelector(".cp-tt-row-actor");
      const cnt = row.querySelector(".cp-tt-row-count");
      if (sel) sel.value = actorId;
      if (cnt) cnt.value = String(clampCrewCount(count));
      row.querySelector(".cp-tt-row-remove")?.addEventListener("click", () => { row.remove(); refresh(); });
      sel?.addEventListener("change", refresh);
      cnt?.addEventListener("input", refresh);
      rowsEl.append(row);
      refresh();
      return row;
    };
    const setCrewOn = (on) => {
      if (toggle) toggle.checked = !!on;
      squad?.classList.toggle("cp-hidden", !on);
    };

    // The picture: the sheet's own picker, the sheet's own bind. ⭐ THE PICKER IS PINNED WITH THIS
    // WINDOW (user report 2026-09-19: it opened behind). This window is a DialogV2, and the module's
    // pin-window helper floats every DialogV2 above ordinary windows — so an ordinary file browser it
    // spawns is re-buried the moment it renders. Pinned as well (`_cpPinOnTop`, the instance opt-in the
    // helper reads), the two keep normal click order between themselves: whichever was touched last is
    // in front. The picker is held so the window can close it, and a pick made after this window has
    // already gone still lands in the session memory — so it applies to the next call, as the user
    // expects, instead of writing into a detached field.
    img?.addEventListener("click", (ev) => {
      ev.preventDefault();
      const FP = foundry.applications?.apps?.FilePicker?.implementation ?? foundry.applications?.apps?.FilePicker ?? globalThis.FilePicker;
      const fp = new FP({
        type: "image",
        activeSource: "data",
        current: imgIn?.value || "",
        callback: (path) => {
          if (imgIn?.isConnected) imgIn.value = path;
          if (img?.isConnected) img.src = path;
          _lastCall = { ..._lastCall, img: path };
        },
      });
      fp._cpPinOnTop = true;
      _picker = fp;
      fp.render(true);
    });

    toggle?.addEventListener("change", () => setCrewOn(toggle.checked));
    body.querySelector(".cp-tt-row-add")?.addEventListener("click", () => addRow());

    // An actor dragged from the sidebar, dropped anywhere on the window: a row, or one more of one.
    body.addEventListener("dragover", (ev) => { ev.preventDefault(); body.classList.add("cp-drop-hot"); });
    body.addEventListener("dragleave", () => body.classList.remove("cp-drop-hot"));
    body.addEventListener("drop", (ev) => {
      ev.preventDefault();
      body.classList.remove("cp-drop-hot");
      const data = dragDataOf(ev);
      if (data?.type !== "Actor") return;
      const doc = data.uuid ? fromUuidSync(data.uuid) : (data.id ? game.actors?.get(data.id) : null);
      const actor = doc?.id ? game.actors?.get(doc.id) : null;
      if (!actor) { ui.notifications?.warn?.(localize("TraumaTeamCrewWorldOnly")); return; }
      setCrewOn(true);
      const existing = [...rowsEl.querySelectorAll(".cp-tt-row")]
        .find((r) => r.querySelector(".cp-tt-row-actor")?.value === actor.id);
      if (existing) {
        const cnt = existing.querySelector(".cp-tt-row-count");
        if (cnt) cnt.value = String(clampCrewCount(cnt.value) + 1);
        refresh();
      } else addRow(actor.id, 1);
    });

    for (const r of last.rows) addRow(r.actorId, r.count);
    refresh();
  });

  try {
    const answer = await DialogV2.wait({
      window: { title: localize("TraumaTeamCrewTitle"), resizable: true },
      // Stated width for the reason the cover dialog states one: DialogV2 is fixed-size by default and
      // its default is narrow enough to wrap a long actor name onto three lines.
      position: { width: 480 },
      classes: ["cyberpunk", "cp-tt-crew"],
      content,
      rejectClose: false,
      buttons: [{
        action: "call", default: true, label: localize("TraumaTeamCrewConfirm"),
        callback: (event, button, dialog) => {
          const el = (dialog.element ?? dialog);
          const img = el.querySelector('input[name="cp-tt-img"]')?.value?.trim() ?? "";
          const crewOn = el.querySelector('input[name="cp-tt-crew-on"]')?.checked === true;
          const rows = [...el.querySelectorAll(".cp-tt-rows .cp-tt-row")]
            .map((r) => ({
              actorId: r.querySelector(".cp-tt-row-actor")?.value ?? "",
              count: clampCrewCount(r.querySelector(".cp-tt-row-count")?.value),
            }))
            .filter((r) => r.actorId);
          _lastCall = { img, crewOn, rows };
          return { crew: crewOn && rows.length ? rows : null, img };
        },
      }, { action: "cancel", label: localize("Cancel") }],
    });
    if (!answer || answer === "cancel") return null;
    return answer;
  } finally {
    Hooks.off("renderDialogV2", hookId);
    const fp = _picker; _picker = null;
    if (fp?.rendered) { try { await fp.close(); } catch (_e) { /* already gone */ } }
  }
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
  const answer = await promptTraumaTeamCrew();
  if (!answer) return { skipped: "cancelled" };
  const point = await armLandingPicker();
  if (!point) return { skipped: "cancelled" };
  const placed = await landTraumaTeam(point, { crew: answer.crew, img: answer.img });
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
