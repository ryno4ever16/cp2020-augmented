/**
 * movement-allowance.js  —  module/combat/movement-allowance.js
 *
 * The token ruler reads how far a figure has moved THIS TURN against its Run (CP2020 p.99: Run = MA × 3
 * metres per turn), tints the path once the allowance is spent, and tells a player when a drop goes past
 * it. Nothing is refused — the house rule for movement since the 2026-08-29 trim is show the bad choice,
 * never block it. movement-gate.js carries the one-move-after-acting half of p.99; this file carries the
 * distance half.
 *
 * Core supplies every piece. `TokenDocument#movementHistory` is recorded while a started encounter exists
 * and cleared at every turn start (combat.mjs `_clearMovementHistoryOnStartTurn`); the TokenRuler measures
 * that history and the planned path as ONE path, so `waypoint.measurement.cost` already IS the turn's
 * running total; and the three style/label methods wrapped below are the documented seams a system or
 * module overrides. They are patched on the prototype for the reason fx/afterimage.js gives for its own
 * wrap: this registers at `ready`, when every drawn token already holds a ruler INSTANCE, and a class
 * swap would miss them all. Each wrap calls whatever was there before it, so the afterimage's
 * quiet-highlight wrap and these compose in either order.
 *
 * Run is in METRES. A scene measured in other units converts through vehicle-grid.js `metersPerUnit`
 * (an unknown unit reads as metres, like every other rules-to-scene conversion in the module).
 */
import { localizeParam } from "../utils.js";
import { metersPerUnit } from "../vehicle/vehicle-grid.js";

const SCOPE = "cp2020-augmented";

/** Vehicles have their own movement model (vehicle-control.js); their Run is not a figure's Run. */
const VEHICLE_TYPE = `${SCOPE}.vehicle`;

/** The two status colours the ruler paints with (the css `.result-warn` / `.result-fail` pair, as PIXI numbers —
 *  the ruler draws on the canvas, so there is no stylesheet to put them in). */
export const RUN_TINT = Object.freeze({ at: 0xc0791a, over: 0xd1502f });

/** Round to the ruler's own precision (it prints to 0.01) so "exactly the allowance" means what the label shows. */
const r2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * PURE. Where a running total stands against the allowance.
 * @param {object} o
 * @param {number} o.usedUnits      distance used, in SCENE units
 * @param {number} o.runMeters      the figure's Run, in metres (0 / NaN / missing → no allowance)
 * @param {number} [o.metersPerUnit=1]  metres per scene unit
 * @returns {{runUnits:number, usedUnits:number, remainingUnits:number, state:"within"|"at"|"over"|"none"}}
 */
export function runBudget({ usedUnits, runMeters, metersPerUnit: mpu = 1 } = {}) {
  const per = Number(mpu) > 0 ? Number(mpu) : 1;
  const run = Number(runMeters);
  const used = Number(usedUnits);
  const runUnits = Number.isFinite(run) && run > 0 ? run / per : 0;
  if (!(runUnits > 0) || !Number.isFinite(used)) {
    return { runUnits, usedUnits: Number.isFinite(used) ? used : 0, remainingUnits: 0, state: "none" };
  }
  const u = r2(used), r = r2(runUnits);
  const state = u > r ? "over" : u === r ? "at" : "within";
  return { runUnits, usedUnits: used, remainingUnits: Math.max(0, runUnits - used), state };
}

/**
 * PURE. Should a drop raise the advisory? The referee is never advised — moving any token is adjudication,
 * the same reasoning the one-move gate uses — and nothing is said outside a started encounter.
 */
export function shouldWarnOverRun({ inCombat, isGM, totalUnits, runUnits } = {}) {
  if (!inCombat) return false;
  if (isGM) return false;
  const run = Number(runUnits), total = Number(totalUnits);
  if (!(run > 0) || !Number.isFinite(total)) return false;
  return r2(total) > r2(run);
}

/** Run in metres for an actor (or an actor-like object). 0 when it has none to speak of. */
export function runMetersOf(actor) {
  if (!actor || actor.type === VEHICLE_TYPE) return 0;
  const run = Number(actor.system?.stats?.ma?.run);
  return Number.isFinite(run) && run > 0 ? run : 0;
}

/** Metres per scene unit, guarded. */
export function metersPerUnitOf(scene) {
  return metersPerUnit(scene) || 1;
}

/** Is the per-turn allowance in force for this token: a STARTED encounter that the token is part of (which is
 *  exactly when core records its movement history). */
export function allowanceActiveFor(tokenDoc) {
  const combat = game?.combat;
  if (!combat?.started || !tokenDoc?.id) return false;
  return combat.combatants.some(c => c.tokenId === tokenDoc.id);
}

/** Distance used THIS TURN in scene units: the sum of core's recorded history costs. */
export function usedUnitsOf(tokenDoc) {
  let sum = 0;
  for (const w of tokenDoc?.movementHistory ?? []) {
    const c = Number(w?.cost);
    if (Number.isFinite(c)) sum += c;
  }
  return sum;
}

/** The budget at a given running total for this token, or null when no allowance is in force. */
function budgetAt(tokenDoc, costUnits) {
  if (!allowanceActiveFor(tokenDoc)) return null;
  const b = runBudget({
    usedUnits: costUnits,
    runMeters: runMetersOf(tokenDoc.actor),
    metersPerUnit: metersPerUnitOf(tokenDoc.parent ?? canvas?.scene)
  });
  return b.state === "none" ? null : b;
}

/** The live reading for a token: the history already walked this turn against its Run. */
export function allowanceFor(tokenDoc) {
  const b = budgetAt(tokenDoc, usedUnitsOf(tokenDoc));
  if (!b) {
    return { active: false, state: "none", usedUnits: usedUnitsOf(tokenDoc), runUnits: 0, remainingUnits: 0 };
  }
  return { active: true, ...b };
}

const fmt = (n) => Number(n).toNearest(0.01).toLocaleString(game.i18n.lang);

/** The readout a ruler label carries for a path whose running total is `costUnits`: "used / Run" plus the
 *  state class the stylesheet colours. Null when no allowance is in force (the label then stays stock). */
export function runReadoutFor(tokenDoc, costUnits) {
  const b = budgetAt(tokenDoc, costUnits);
  if (!b) return null;
  return {
    text: localizeParam("MovementRunReadout", { used: fmt(b.usedUnits), run: fmt(b.runUnits) }),
    cssClass: `cp-run-${b.state}`,
    state: b.state
  };
}

/** The tint for a path element whose running total is `costUnits`; null = leave the stock colour. */
function tintFor(tokenDoc, costUnits) {
  const b = budgetAt(tokenDoc, costUnits);
  if (!b) return null;
  return b.state === "over" ? RUN_TINT.over : b.state === "at" ? RUN_TINT.at : null;
}

/**
 * Patch the three ruler seams on the prototype (idempotent). Each wrap calls the prior implementation and
 * only ever ADDS to its answer; any failure inside the addition falls back to the stock answer.
 */
export function registerMovementAllowanceRuler() {
  const proto = CONFIG?.Token?.rulerClass?.prototype;
  if (!proto) return false;
  if (proto._getSegmentStyle?.__cpMovementAllowance) return false;

  const wrap = (name, extend) => {
    const orig = proto[name];
    if (typeof orig !== "function") return;
    const wrapped = function (...args) {
      const stock = orig.apply(this, args);
      try { return extend.call(this, stock, ...args) ?? stock; } catch (_e) { return stock; }
    };
    // Carry the markers of the wrap beneath (the afterimage's `__cpAfterimageQuiet`) so every registration's
    // own idempotency check still sees its flag on the method whichever wrap ended up outermost.
    for (const k of Object.keys(orig)) if (k.startsWith("__cp")) wrapped[k] = orig[k];
    wrapped.__cpMovementAllowance = true;
    proto[name] = wrapped;
  };

  // The segment from the previous waypoint: tinted once the running total reaches the allowance.
  wrap("_getSegmentStyle", function (stock, waypoint) {
    if (!(stock?.width > 0)) return stock;
    const tint = tintFor(this.token?.document, waypoint?.measurement?.cost);
    return tint == null ? stock : { ...stock, color: tint };
  });

  // A highlighted square: same tint. A square the stock answer hides (alpha 0 — core's unreachable squares,
  // the afterimage's quiet drag) stays hidden; core's own default alpha is 0.5 when the field is absent.
  wrap("_getGridHighlightStyle", function (stock, waypoint) {
    if (!stock || !((stock.alpha ?? 0.5) > 0)) return stock;
    const tint = tintFor(this.token?.document, waypoint?.measurement?.cost);
    return tint == null ? stock : { ...stock, color: tint };
  });

  // The label: the running total becomes "used / Run" (the template appends the units), and the state rides
  // as a class the stylesheet colours. The context is data for core's own template — no markup here.
  wrap("_getWaypointLabelContext", function (stock, waypoint) {
    if (!stock?.cost) return stock;
    const readout = runReadoutFor(this.token?.document, waypoint?.measurement?.cost);
    if (!readout) return stock;
    stock.cost.total = readout.text;
    stock.cssClass = [stock.cssClass, readout.cssClass].filter(Boolean).join(" ");
    return stock;
  });
  return true;
}

/**
 * The drop-time advisory, run from `preMoveToken` on the moving client. The total is the turn's history plus
 * everything this move will walk (core hands both on the operation). Returns nothing: the move is never
 * cancelled. `isGM` can be given so a probe speaks as a player.
 */
export function advisePreMove(tokenDoc, move, { isGM = !!game?.user?.isGM } = {}) {
  const total = (Number(move?.history?.cost) || 0) + (Number(move?.passed?.cost) || 0) + (Number(move?.pending?.cost) || 0);
  const scene = tokenDoc?.parent ?? canvas?.scene;
  const runUnits = runMetersOf(tokenDoc?.actor) / metersPerUnitOf(scene);
  if (!shouldWarnOverRun({ inCombat: allowanceActiveFor(tokenDoc), isGM, totalUnits: total, runUnits })) return;
  ui.notifications?.warn(localizeParam("MovementOverRun", {
    name: tokenDoc?.name ?? "", used: fmt(total), run: fmt(runUnits), units: scene?.grid?.units ?? ""
  }));
}

/** Wiring — called once from the module's ready hook, inside the combat layer. */
export function registerMovementAllowance() {
  try { registerMovementAllowanceRuler(); } catch (err) {
    console.warn(`${SCOPE} | movement allowance ruler failed to register`, err);
  }
  const onPreMoveTokenAllowance = (tokenDoc, move) => {
    try { advisePreMove(tokenDoc, move); } catch (err) {
      console.warn(`${SCOPE} | movement allowance advisory failed`, err);
    }
  };
  onPreMoveTokenAllowance.__cpMovementAllowance = true;
  Hooks.on("preMoveToken", onPreMoveTokenAllowance);
}
