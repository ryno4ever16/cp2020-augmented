/**
 * vehicle-area.js — Phase 5e: area weapons (burst + cone).
 *
 * Class B (HE/HEAT shells, GLs, direct rockets) place a circular burst template; Class F
 * (scatter-packs) place a true angular cone (MM p.72-73). Every token in the area is resolved by
 * the unified 5c dispatcher (vehicle → Pen vs Armor; person → MM p.8), with facing detected per
 * token from the firer. The token-in-area test uses PURE geometry (unit-testable); the area
 * document is placed only for the visual, through the core-agnostic shim.
 */

import { pxPerMeter } from "./vehicle-grid.js";
import { createArea, deleteArea } from "../combat/area-shapes.js";

const DEG = Math.PI / 180;

/* --------------------------------- PURE geometry --------------------------------- */

/** Is (px,py) within radius r of (cx,cy)? PURE (pixel space). */
export function pointInCircle(px, py, cx, cy, r) {
  const dx = px - cx, dy = py - cy;
  return (dx * dx + dy * dy) <= r * r;
}

/**
 * Is (px,py) inside a cone from (ox,oy) facing dirDeg (screen degrees: 0 = +x/east, clockwise),
 * with half-angle `halfDeg` and reach `range`? PURE (pixel space). The origin point counts inside.
 */
export function pointInCone(px, py, ox, oy, dirDeg, halfDeg, range) {
  const dx = px - ox, dy = py - oy;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return true;
  if (dist > range) return false;
  const angTo = Math.atan2(dy, dx) / DEG;
  let d = (((angTo - dirDeg) % 360) + 360) % 360;
  if (d > 180) d = 360 - d;
  return d <= halfDeg;
}

/* ------------------------------ Canvas area placement ------------------------------ */

/**
 * Place the burst's visual through the core-agnostic `createArea` shim (combat/area-shapes.js).
 *
 * This used to write a MeasuredTemplate by name. v14 merged that document type into Region and keeps
 * only a deprecated translation of the call (its own warning announces removal in v16), so the visual
 * rode a back-compat path with a deadline instead of the shim every other area in the module already
 * uses — the same correction vehicle-ordnance.js records for its gas cloud. The shim emits a template
 * on v13 and a Region on v14; the handle it returns is what `deleteArea` cleans up. Never throws:
 * `createArea` swallows a backend failure and returns null.
 */
function placeBurstArea(scene, x, y, radiusM) {
  return createArea(scene, { kind: "circle", x, y, radiusM, color: "#ff6600", flags: { vehicleArea: true } });
}

/**
 * Place the cone's visual through the same shim. Regions have no native cone shape, so on v14 the shim
 * draws it as a polygon (apex plus arc points at the cone's range and half-angle — area-geometry.js);
 * on v13 it stays a t:"cone" template. Either way this is the VISUAL only — the damage geometry is
 * `pointInCone` above and does not care how the area is drawn.
 */
function placeConeArea(scene, x, y, dirDeg, angleDeg, rangeM) {
  return createArea(scene, {
    kind: "cone", x, y, dirDeg, angleDeg: Math.max(5, Number(angleDeg) || 60), rangeM,
    color: "#ff6600", flags: { vehicleArea: true },
  });
}

const _center = (t) => ({ x: t.center?.x ?? t.x, y: t.center?.y ?? t.y });

/**
 * Resolve an area shot: place the visual, find every token inside via pure geometry, and dispatch
 * each through the 5c dispatcher (per-token facing from the firer; the firer is skipped). Returns
 * the list of struck actors. `shape` = {type:"circle", radiusM} | {type:"cone", angleDeg, rangeM, dirDeg}.
 */
export async function resolveAreaShot({ firerToken, origin, shape, payload = {}, skipDispatch = false, scene: sceneArg = null } = {}) {
  const scene = sceneArg ?? canvas?.scene;
  if (!scene || !origin) return { struck: [], tokens: 0, inside: [] };
  const ppm = pxPerMeter(scene);
  const { dispatchAttack, detectFacingFromTokens } = await import("./vehicle-targeting.js");

  // Candidate tokens come from the scene's documents (works for the active OR a non-active scene —
  // the latter is what lets this be tested without disturbing whatever scene is on screen). Centres
  // are computed from document fields so we don't depend on rendered placeables.
  const gs = Number(scene.grid?.size) || 100;
  const toks = (scene.tokens?.contents ?? scene.tokens ?? []).filter(td => td.actor).map(td => ({
    id: td.id, actor: td.actor,
    center: { x: td.x + (td.width * gs) / 2, y: td.y + (td.height * gs) / 2 },
    document: { rotation: td.rotation, elevation: td.elevation },
  }));

  // Containment is computed FIRST and outside the placement's try. It is pure geometry and cannot
  // fail, but it used to share one try block with the visual placement under a log-only catch — so a
  // throwing placement left this list empty and the shot resolved against nobody while reporting a
  // clean miss. The visual is best-effort by design; the resolution is not, so they no longer share
  // a failure path.
  let inside = [];
  if (shape.type === "cone") {
    const rangePx = (Number(shape.rangeM) || 0) * ppm, half = (Number(shape.angleDeg) || 60) / 2;
    inside = toks.filter(t => pointInCone(_center(t).x, _center(t).y, origin.x, origin.y, shape.dirDeg, half, rangePx));
  } else {
    const rPx = (Number(shape.radiusM) || 0) * ppm;
    inside = toks.filter(t => pointInCircle(_center(t).x, _center(t).y, origin.x, origin.y, rPx));
  }

  // The visual keeps its own try with the log-only catch: `createArea` already returns null rather
  // than throwing on a backend failure, so this covers only something unexpected on the way in.
  let area = null;
  try {
    area = (shape.type === "cone")
      ? await placeConeArea(scene, origin.x, origin.y, shape.dirDeg, shape.angleDeg, shape.rangeM)
      : await placeBurstArea(scene, origin.x, origin.y, shape.radiusM);
  } catch (err) {
    console.warn("Cyberpunk2020 | area visual placement failed", err);
  }

  // Tokens actually affected (firer excluded). `skipDispatch` returns them without applying Pen —
  // used by warheads whose effect is a DOT / gas cloud rather than penetration (5g White Phosphorus,
  // chemical), which the caller applies afterward.
  const affected = inside.filter(tok => !(firerToken && tok.id === firerToken.id));
  const struck = [];
  if (!skipDispatch) {
    // Scatter-packs (MM p.72): the to-hit tells us only WHETHER a target is caught; the weapon's XD6
    // "ROF" dice are rolled PER hit target for how many individual munitions struck it. The munitions
    // apply as multiple rounds (the MM p.5 multiple-rounds Penetration aggregation). scatterDice 0
    // (any ordinary cone/burst weapon) → a single application, exactly as before.
    const scatterDice = Math.max(0, Number(payload.scatterDice) || 0);
    for (const tok of affected) {
      const facing = firerToken ? detectFacingFromTokens(firerToken, tok) : (payload.facing || "front");
      let shot = payload;
      if (scatterDice > 0) {
        const munitions = (await new Roll(`${scatterDice}d6`).evaluate()).total;
        shot = { ...payload, extraRounds: Math.max(0, munitions - 1) };
      }
      await dispatchAttack({ ...shot, facing, targetTokenId: tok.id }, tok.actor);
      struck.push(tok.actor);
    }
  }
  // Remove the visual after a moment (keeps the scene clean). Deleted through the shim so it removes
  // whichever document type this core placed.
  if (area) setTimeout(() => deleteArea(area).catch(() => {}), 4000);
  return { struck, tokens: struck.length, inside: affected };
}
