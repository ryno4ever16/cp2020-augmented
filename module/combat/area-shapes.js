/**
 * area-shapes.js — core-agnostic "area on the canvas" abstraction.
 *
 * Foundry v14 DELETED the MeasuredTemplate embedded document type (absorbed into Scene
 * Regions). v13.350 still has it. This shim lets the combat code create an area, find the
 * tokens inside it, and clean it up WITHOUT caring which core it's on — so one codebase runs
 * on both. Feature-detect is by the Scene's embedded-document list (authoritative); the
 * MeasuredTemplate *class* still exists on v14 as a hollow deprecation shim, so we must NOT
 * detect on the class reference.
 *
 * Callers pass a core-agnostic descriptor (METRES + pixel origin); the shim converts and emits
 * either a MeasuredTemplate (v13) or a Region (v14). Geometry for Region polygons is the pure,
 * unit-tested code in area-geometry.js. The pure translation `buildAreaData` is exported for tests.
 */

import { metersToUnits, metersToPixels } from "../vehicle/vehicle-grid.js";
import { circleEllipseShape, conePolygonShape, rayPolygonShape } from "./area-geometry.js";

const SCOPE = "cp2020-augmented";

/* ------------------------------------------------------------------ feature detect */

/** The Scene document class's embedded-type map, on any core. */
function sceneEmbedded() {
  try {
    const SceneCls = (typeof CONFIG !== "undefined" && CONFIG?.Scene?.documentClass)
      || (typeof foundry !== "undefined" && foundry?.documents?.BaseScene);
    return SceneCls?.metadata?.embedded ?? {};
  } catch { return {}; }
}

/** True on v13 (MeasuredTemplate is a native Scene embedded type). */
export function supportsMeasuredTemplates() {
  return "MeasuredTemplate" in sceneEmbedded();
}

/** True on v14 (Region is a native Scene embedded type). */
export function regionsSupported() {
  return "Region" in sceneEmbedded();
}

/**
 * Which backend will createArea use? Regions only when MeasuredTemplate is gone AND Region
 * exists — otherwise templates. Defaults to templates if detection is somehow empty (safest
 * for the must-keep v13 platform).
 */
export function usesRegions() {
  return !supportsMeasuredTemplates() && regionsSupported();
}

/* ------------------------------------------------------------------ pure translation */

/**
 * Build the embedded-document creation data for an area, pure & unit-testable.
 *
 * @param {boolean} useRegions  true → Region data, false → MeasuredTemplate data
 * @param {object}  d           descriptor (see createArea)
 * @param {object}  scene       a scene-like object with `.grid` (for unit conversion only)
 * @returns {object} createEmbeddedDocuments payload (single doc)
 */
export function buildAreaData(useRegions, d, scene) {
  const flags = { [SCOPE]: d.flags ?? {} };
  const color = d.color ?? "#ff6600";
  const x = Number(d.x) || 0;
  const y = Number(d.y) || 0;

  if (useRegions) {
    let shape;
    if (d.kind === "cone") {
      shape = conePolygonShape(x, y, Number(d.dirDeg) || 0, (Number(d.angleDeg) || 60) / 2,
        metersToPixels(scene, d.rangeM), d.segments ?? 12);
    } else if (d.kind === "ray") {
      shape = rayPolygonShape(x, y, Number(d.dirDeg) || 0,
        metersToPixels(scene, d.lengthM), metersToPixels(scene, d.widthM));
    } else { // circle
      shape = circleEllipseShape(x, y, metersToPixels(scene, d.radiusM));
    }
    return { name: d.name ?? "CP2020 Area", color, shapes: [shape], visibility: 1, flags };
  }

  // MeasuredTemplate (v13): distance/width are in scene grid-distance UNITS.
  const base = {
    x, y, fillColor: color, borderColor: d.borderColor ?? color, flags,
  };
  if (d.kind === "cone") {
    return { ...base, t: "cone", direction: Number(d.dirDeg) || 0,
      angle: Math.max(5, Number(d.angleDeg) || 60), distance: Math.max(0.5, metersToUnits(scene, d.rangeM)) };
  }
  if (d.kind === "ray") {
    return { ...base, t: "ray", direction: Number(d.dirDeg) || 0,
      distance: Math.max(0.5, metersToUnits(scene, d.lengthM)),
      width: Math.max(0.5, metersToUnits(scene, d.widthM)) };
  }
  return { ...base, t: "circle", direction: 0, distance: Math.max(0.5, metersToUnits(scene, d.radiusM)) };
}

/* ------------------------------------------------------------------ handle + I/O */

/** Opaque handle wrapping the created doc so callers never touch the raw type. */
function makeHandle(doc, type) {
  return { doc, type, id: doc?.id ?? null, isRegion: type === "Region" };
}

function gridSize(scene) { return Number(scene?.grid?.size) || 100; }

/** Center point (pixels) of a TokenDocument, from document fields (works off-canvas). */
function tokenCenter(tokenDoc, scene) {
  const gs = gridSize(scene);
  const w = (tokenDoc.width ?? tokenDoc.document?.width ?? 1) * gs;
  const h = (tokenDoc.height ?? tokenDoc.document?.height ?? 1) * gs;
  const tx = tokenDoc.x ?? tokenDoc.document?.x ?? 0;
  const ty = tokenDoc.y ?? tokenDoc.document?.y ?? 0;
  return { x: tx + w / 2, y: ty + h / 2, elevation: tokenDoc.elevation ?? tokenDoc.document?.elevation ?? 0 };
}

/**
 * Create an area on a scene. Descriptor (core-agnostic; METRES + pixel origin):
 *   { kind: "circle"|"cone"|"ray", x, y,                              // origin in PIXELS
 *     radiusM | {dirDeg, angleDeg, rangeM} | {dirDeg, lengthM, widthM},
 *     color?, borderColor?, name?, segments?, flags? }                // flags = cyberpunk2020-scoped
 * @returns {Promise<object|null>} handle, or null on failure (never throws).
 */
export async function createArea(scene, descriptor) {
  if (!scene || !descriptor) return null;
  const useRegions = usesRegions();
  const data = buildAreaData(useRegions, descriptor, scene);
  const type = useRegions ? "Region" : "MeasuredTemplate";
  try {
    const [doc] = await scene.createEmbeddedDocuments(type, [data]);
    return doc ? makeHandle(doc, type) : null;
  } catch (err) {
    console.warn(`Cyberpunk2020 | createArea (${type}) failed`, err);
    return null;
  }
}

/**
 * Tokens whose centre lies inside the area. v14 uses RegionDocument#testPoint; v13 uses the
 * template placeable's PIXI shape.contains (origin-relative). Candidates default to every token
 * on the area's scene. Returns the same token objects passed in (TokenDocuments by default).
 */
export function tokensInArea(handle, candidates) {
  if (!handle?.doc) return [];
  const scene = handle.doc.parent ?? canvas?.scene;
  const toks = candidates ?? (scene?.tokens?.contents ?? scene?.tokens ?? []);
  const out = [];
  if (handle.isRegion) {
    const reg = handle.doc;
    for (const t of toks) {
      const c = tokenCenter(t, scene);
      try { if (reg.testPoint({ x: c.x, y: c.y, elevation: c.elevation })) out.push(t); } catch { /* skip */ }
    }
  } else {
    const obj = handle.doc.object ?? handle.doc._object;
    const shape = obj?.shape;
    const ox = handle.doc.x, oy = handle.doc.y;
    // The MeasuredTemplate placeable (and its .shape) is drawn a beat after the doc is created; if we
    // land here before that, we'd silently report zero tokens. Warn so a "nothing was hit" isn't invisible.
    if (!shape) { console.warn("CP2020 | area containment: template placeable not drawn yet — 0 tokens detected"); return out; }
    for (const t of toks) {
      const c = tokenCenter(t, scene);
      try { if (shape.contains(c.x - ox, c.y - oy)) out.push(t); } catch { /* skip */ }
    }
  }
  return out;
}

/** Existing areas on a scene tagged with our flag key. Returns handles. */
export function areasByFlag(scene, flagKey) {
  if (!scene) return [];
  const coll = usesRegions() ? scene.regions : scene.templates;
  const type = usesRegions() ? "Region" : "MeasuredTemplate";
  const docs = coll?.filter?.((d) => d?.flags?.[SCOPE]?.[flagKey]) ?? [];
  return docs.map((d) => makeHandle(d, type));
}

/** Delete the area behind a handle. Never throws. */
export async function deleteArea(handle) {
  try { await handle?.doc?.delete?.(); } catch { /* already gone */ }
}

/** Hook name for "area document about to update", per core. */
export function areaPreUpdateHook() {
  return usesRegions() ? "preUpdateRegion" : "preUpdateMeasuredTemplate";
}

/** Wrap an existing area document (looked up by id on its scene) into a handle, or null. */
export function areaById(scene, id) {
  if (!scene || !id) return null;
  if (usesRegions()) {
    const d = scene.regions?.get?.(id);
    return d ? makeHandle(d, "Region") : null;
  }
  const d = scene.templates?.get?.(id);
  return d ? makeHandle(d, "MeasuredTemplate") : null;
}

/**
 * Shift an area by (dx, dy) pixels — used for gas-cloud wind drift. v13 MeasuredTemplates move
 * by their doc x/y; v14 Regions have no top-level position, so we shift every shape (ellipse
 * centre, or each polygon vertex). Never throws.
 */
export async function moveArea(handle, dx, dy) {
  if (!handle?.doc || (!dx && !dy)) return;
  try {
    if (handle.isRegion) {
      const shapes = (handle.doc.shapes ?? []).map((s) => {
        const o = typeof s.toObject === "function" ? s.toObject() : { ...s };
        if (Array.isArray(o.points)) o.points = o.points.map((v, i) => v + (i % 2 === 0 ? dx : dy));
        else { o.x = (o.x ?? 0) + dx; o.y = (o.y ?? 0) + dy; }
        return o;
      });
      await handle.doc.update({ shapes });
    } else {
      await handle.doc.update({ x: (handle.doc.x ?? 0) + dx, y: (handle.doc.y ?? 0) + dy });
    }
  } catch (e) { console.warn("Cyberpunk2020 | moveArea failed", e); }
}
