/**
 * vehicle-area.js — Phase 5e: area weapons (burst + cone).
 *
 * Class B (HE/HEAT shells, GLs, direct rockets) place a circular burst template; Class F
 * (scatter-packs) place a true angular cone (MM p.72-73). Every token in the area is resolved by
 * the unified 5c dispatcher (vehicle → Pen vs Armor; person → MM p.8), with facing detected per
 * token from the firer. The token-in-area test uses PURE geometry (unit-testable); the
 * MeasuredTemplate is placed only for the visual.
 */

import { pxPerMeter, metersToUnits } from "./vehicle-grid.js";

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

/* ------------------------------ Canvas template placement ------------------------------ */

async function placeBurstTemplate(scene, x, y, radiusM) {
  const td = {
    t: "circle", x, y, distance: Math.max(0.5, metersToUnits(scene, radiusM)),   // template distance is in grid units
    fillColor: "#ff6600", borderColor: "#ff6600",
    flags: { "cp2020-augmented": { vehicleArea: true } }
  };
  const [doc] = await scene.createEmbeddedDocuments("MeasuredTemplate", [td]);
  return doc;
}

async function placeConeTemplate(scene, x, y, dirDeg, angleDeg, rangeM) {
  const td = {
    t: "cone", x, y, direction: dirDeg, angle: Math.max(5, Number(angleDeg) || 60),
    distance: Math.max(0.5, metersToUnits(scene, rangeM)),
    fillColor: "#ff6600", borderColor: "#ff6600",
    flags: { "cp2020-augmented": { vehicleArea: true } }
  };
  const [doc] = await scene.createEmbeddedDocuments("MeasuredTemplate", [td]);
  return doc;
}

const _center = (t) => ({ x: t.center?.x ?? t.x, y: t.center?.y ?? t.y });

/**
 * Resolve an area shot: place the template, find every token inside via pure geometry, and dispatch
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

  let template = null, inside = [];
  try {
    if (shape.type === "cone") {
      const rangePx = (Number(shape.rangeM) || 0) * ppm, half = (Number(shape.angleDeg) || 60) / 2;
      template = await placeConeTemplate(scene, origin.x, origin.y, shape.dirDeg, shape.angleDeg, shape.rangeM);
      inside = toks.filter(t => pointInCone(_center(t).x, _center(t).y, origin.x, origin.y, shape.dirDeg, half, rangePx));
    } else {
      const rPx = (Number(shape.radiusM) || 0) * ppm;
      template = await placeBurstTemplate(scene, origin.x, origin.y, shape.radiusM);
      inside = toks.filter(t => pointInCircle(_center(t).x, _center(t).y, origin.x, origin.y, rPx));
    }
  } catch (err) {
    console.warn("Cyberpunk2020 | area template placement failed", err);
  }

  // Tokens actually affected (firer excluded). `skipDispatch` returns them without applying Pen —
  // used by warheads whose effect is a DOT / gas cloud rather than penetration (5g White Phosphorus,
  // chemical), which the caller applies afterward.
  const affected = inside.filter(tok => !(firerToken && tok.id === firerToken.id));
  const struck = [];
  if (!skipDispatch) {
    for (const tok of affected) {
      const facing = firerToken ? detectFacingFromTokens(firerToken, tok) : (payload.facing || "front");
      await dispatchAttack({ ...payload, facing, targetTokenId: tok.id }, tok.actor);
      struck.push(tok.actor);
    }
  }
  // Remove the visual template after a moment (keeps the scene clean).
  if (template) setTimeout(() => template.delete?.().catch(() => {}), 4000);
  return { struck, tokens: struck.length, inside: affected };
}
