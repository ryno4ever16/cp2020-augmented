/**
 * spread-zone-look.js — how a shot pattern is DRAWN, and nothing else.
 *
 * The pattern's mechanics live in damage-hooks.js; this file owns only its appearance, in one block
 * of constants, on the same doctrine as module/fx/effects.js: if the pattern looks wrong, it is wrong
 * here and nothing else needs opening.
 *
 * ⭐ WHY THERE IS A FILE AT ALL — core gives the document no way to say this. A v14 Region carries
 * `color` and `visibility` and no opacity of any kind: its highlight is a `RegionMesh` whose alpha is
 * assigned the literal 0.5 inside the placeable's own `_draw`, and whose diagonal hatch is switched
 * back on by `_refreshState` on every refresh (`hatchEnabled = !controlled && !hover && !isPreview`).
 * A half-opaque hatched slab over the shot line is exactly what the user rejected — "horrible to look
 * at and it blocks things including the shots" — so the only place the look can be changed is on the
 * drawn object, after core has drawn it. That is what this file does, for OUR regions only, keyed off
 * the `isSpreadZone` flag; every other region on the scene is left exactly as core drew it.
 *
 * The outline is ours for the same reason. Core's own region border is bound to interaction
 * (`#border.visible = controlled || hover || layer.highlightObjects`), so an unhovered region on a
 * non-active layer has no edge at all — and a fill at this alpha with no edge is not "ghost", it is
 * "gone". The outline is therefore drawn here, from the region's own polygons, and it is what carries
 * the pattern's shape and its colour to the eye.
 */

const SCOPE = "cp2020-augmented";

/**
 * THE LOOK. Every number a reviewer might want to move.
 *
 *  - `fillAlpha` 0.10 — the user's ruling is "near-transparent … you can read tokens and shots
 *    through it", against core's 0.5. At 0.10 an orange wash is still legible as a wash on both a lit
 *    and a dark floor, and a token's own art and a tracer crossing the pattern both read through it.
 *    It is the floor of the band the build spec named (0.08–0.12): below ~0.08 the fill stops
 *    surviving the dark-scene darkness layer and only the outline remains.
 *  - `hatch` false — the hatch is a *pattern of opaque diagonal bars*, so it is the half of core's
 *    treatment that actually occludes; alpha alone would have left it, thinner. Switched off every
 *    refresh because core switches it back on every refresh.
 *  - `outlineWidth` 2 / `outlineAlpha` 0.85 — thin and nearly solid, which is the inverse of the fill
 *    and is what makes the shape readable without filling it in. Width is in pixels of canvas, scaled
 *    by the scene's ui scale so it stays one hairline at any zoom.
 *  - `fillColor` / `outlineColor` — the orange family, kept. The fill is the warmer of the two so the
 *    edge reads as the drawn line and the interior as its glow.
 */
export const SPREAD_ZONE_LOOK = Object.freeze({
  fillColor: "#ffaa00",
  outlineColor: "#cc6600",
  fillAlpha: 0.10,
  hatch: false,
  outlineWidth: 2,
  outlineAlpha: 0.85,
});

/** The PIXI child this file adds to a spread zone's placeable, so a redraw can find and replace it. */
const OUTLINE_KEY = "cpSpreadOutline";

/** Is this document one of ours? Reads the flag the pattern is created with — never a name. */
function isSpreadZoneDoc(doc) {
  return !!doc?.flags?.[SCOPE]?.isSpreadZone;
}

/** The RegionMesh core built for a Region placeable, or null. `region` is a public getter on the mesh. */
function highlightMeshFor(regionObject) {
  try {
    for (const mesh of regionObject?.layer?._highlights?.children ?? []) {
      if (mesh?.region === regionObject) return mesh;
    }
  } catch (e) { /* no canvas / a core without the highlight container → no ghosting, never a throw */ }
  return null;
}

/**
 * Apply the ghost treatment to one drawn Region placeable. Idempotent — safe on every refresh, which
 * is how it has to be: `_refreshState` re-asserts the hatch each time, and a `_draw` re-assigns the
 * mesh's 0.5 alpha, so this runs on both hooks rather than once at creation.
 */
function ghostRegion(regionObject) {
  const doc = regionObject?.document;
  if (!isSpreadZoneDoc(doc)) return;
  const mesh = highlightMeshFor(regionObject);
  if (mesh) {
    mesh.alpha = SPREAD_ZONE_LOOK.fillAlpha;
    try { mesh.shader.uniforms.hatchEnabled = SPREAD_ZONE_LOOK.hatch; } catch (e) { /* shader shape changed → fill alpha alone */ }
  }
  drawOutline(regionObject);
}

/**
 * Draw (or redraw) our own thin outline around the pattern, from the region's own polygons — the same
 * geometry core tests containment against, so the line a GM aims by is the line that decides who is hit.
 */
function drawOutline(regionObject) {
  try {
    const existing = regionObject[OUTLINE_KEY];
    const gfx = existing ?? new PIXI.Graphics();
    if (!existing) {
      gfx.eventMode = "none";
      regionObject[OUTLINE_KEY] = gfx;
      regionObject.addChild(gfx);
    }
    gfx.clear();
    const uiScale = Number(canvas?.dimensions?.uiScale) > 0 ? Number(canvas.dimensions.uiScale) : 1;
    const color = Number(foundry.utils.Color.from(SPREAD_ZONE_LOOK.outlineColor));
    gfx.lineStyle({ width: SPREAD_ZONE_LOOK.outlineWidth * uiScale, color, alpha: SPREAD_ZONE_LOOK.outlineAlpha, alignment: 0.5 });
    // The geometry is read off the DOCUMENT: the placeable's own `polygons` is a deprecated forwarder
    // on v13+ and logs a warning on every region refresh, which is every frame the shape moves. The
    // old getter is kept as the fallback so a core that has only that shape still draws.
    for (const poly of regionObject.document?.polygons ?? regionObject.polygons ?? []) gfx.drawPolygon(poly);
  } catch (e) { /* geometry not ready on this frame → the next refresh draws it */ }
}

/**
 * Wire the look. Called once at ready. Two hooks because core resets the two halves at two different
 * times: `drawRegion` after the mesh is rebuilt with its 0.5 alpha, `refreshRegion` after the hatch is
 * re-asserted and after the shape has moved.
 */
export function registerSpreadZoneLook() {
  Hooks.on("drawRegion", ghostRegion);
  Hooks.on("refreshRegion", ghostRegion);
  // v13 (MeasuredTemplate) — the same two facts said in that core's terms: core fills the template
  // graphic opaquely and hangs a control icon on it. Alpha on the placeable carries the whole look
  // there, because a template's own border IS drawn unconditionally and is already the thin outline
  // this file has to hand-draw on v14. ⚠ Written from the v13 API, verified on v14 only.
  const ghostTemplate = (obj) => {
    if (!isSpreadZoneDoc(obj?.document)) return;
    try {
      if (obj.template) obj.template.alpha = SPREAD_ZONE_LOOK.fillAlpha;
      if (obj.controlIcon) obj.controlIcon.visible = false;
    } catch (e) { /* not this core's shape */ }
  };
  Hooks.on("drawMeasuredTemplate", ghostTemplate);
  Hooks.on("refreshMeasuredTemplate", ghostTemplate);
}
