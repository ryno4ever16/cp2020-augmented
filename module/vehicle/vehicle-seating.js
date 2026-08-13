/**
 * vehicle-seating.js — the pure geometry behind vehicle seating and placement.
 *
 * Everything here is a plain function over numbers and rectangles: no `game`, no `canvas`, no
 * documents, no i18n. The impure half (reading token documents, writing updates) lives in
 * vehicle-canvas.js. Keeping the arithmetic separate is what makes the seat layout legible and
 * testable without a running world.
 *
 * A rectangle is `{x, y, w, h}` in PIXELS. A token's grid `width`/`height` are square counts, so
 * a rect is built as `{x: doc.x, y: doc.y, w: doc.width * gridSize, h: doc.height * gridSize}`.
 *
 * THE SEAT-SLOT RULE (user ruling 2026-08-11: occupants sit INSIDE the vehicle, one per square,
 * never point-stacked):
 *   The vehicle's footprint is divided into its own one-square cells, enumerated in READING
 *   ORDER — left to right along the top row, then the next row down. Slot 0 is the driver's
 *   seat; passengers fill the remaining slots in that order. The order is a pure function of the
 *   footprint, so every client computes the same seat for the same occupant index.
 *   More occupants than cells (a crowded truck) wrap around to slot 0 again, each wrap nudged by
 *   a quarter square along the diagonal so two riders in one cell are still separately clickable.
 *
 *   ⭐ WHICH cell is slot 0 moved out of this file (2026-08-13). Reading order put the driver on
 *   the hood, because it has no idea which end of the art is the nose. vehicle-layout.js answers
 *   that from the sheet's Front picker and hands the resulting order to seatSlotPosition below;
 *   reading order remains the fallback for any caller with no vehicle to ask.
 */

/** Grid cells of a footprint, in reading order. Each entry is the cell's top-left pixel point. */
export function footprintCells(rect, gridSize) {
  const g = Math.max(1, Number(gridSize) || 100);
  const cols = Math.max(1, Math.round((Number(rect?.w) || g) / g));
  const rows = Math.max(1, Math.round((Number(rect?.h) || g) / g));
  const x0 = Number(rect?.x) || 0;
  const y0 = Number(rect?.y) || 0;
  const cells = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) cells.push({ x: x0 + col * g, y: y0 + row * g });
  }
  return cells;
}

/**
 * Where occupant #index sits inside `rect`. Returns the TOP-LEFT pixel position for a token of
 * `size` grid squares (`{w, h}`, defaulting to 1x1), centred within its cell so a larger token
 * doesn't hang off its seat.
 *
 * `order` (optional) is the vehicle's seat order as row-major cell indices — the list
 * vehicle-layout.js derives from the Front picker, which skips the engine rank and starts at the
 * driver's seat. Without one, seats fall back to plain reading order (every cell, top-left first),
 * which is what every vehicle did before Front existed and what a caller with no actor to read
 * still gets.
 */
export function seatSlotPosition(rect, gridSize, index, size = {}, order = null) {
  const g = Math.max(1, Number(gridSize) || 100);
  const cells = footprintCells(rect, gridSize);
  const seats = (Array.isArray(order) && order.length)
    ? order.map(i => cells[i]).filter(Boolean)
    : cells;
  const slots = seats.length ? seats : cells;
  const i = Math.max(0, Math.trunc(Number(index) || 0));
  const cell = slots[i % slots.length];
  const wrap = Math.floor(i / slots.length);
  const tw = (Math.max(0.1, Number(size.w) || 1)) * g;
  const th = (Math.max(0.1, Number(size.h) || 1)) * g;
  // Centre the token in its cell, then offset each additional wrap by a quarter square so
  // over-capacity riders never share an identical point.
  return {
    x: Math.round(cell.x + (g - tw) / 2 + wrap * (g / 4)),
    y: Math.round(cell.y + (g - th) / 2 + wrap * (g / 4)),
  };
}

/** Do two rectangles share any area? Touching edges do not count as overlapping. */
export function rectsOverlap(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Candidate top-left positions for a `size` (grid squares) token placed beside `anchor`, ordered
 * nearest-first: right, left, below, above at one square's separation, then the same four
 * directions one ring further out, up to `rings`. The first entry is the plain "to its right",
 * which is also the overlap-tolerant fallback when every candidate is blocked.
 */
export function adjacentPlacements(anchor, gridSize, size = {}, rings = 4) {
  const g = Math.max(1, Number(gridSize) || 100);
  const w = (Math.max(0.1, Number(size.w) || 1)) * g;
  const h = (Math.max(0.1, Number(size.h) || 1)) * g;
  const ax = Number(anchor?.x) || 0, ay = Number(anchor?.y) || 0;
  const aw = Number(anchor?.w) || g, ah = Number(anchor?.h) || g;
  const out = [];
  for (let ring = 0; ring < Math.max(1, rings); ring++) {
    const pad = ring * g;
    out.push({ x: Math.round(ax + aw + pad), y: Math.round(ay) });        // right
    out.push({ x: Math.round(ax - w - pad), y: Math.round(ay) });         // left
    out.push({ x: Math.round(ax), y: Math.round(ay + ah + pad) });        // below
    out.push({ x: Math.round(ax), y: Math.round(ay - h - pad) });         // above
  }
  return out;
}

/**
 * The first candidate placement that collides with nothing in `blockers`, or `null` when they are
 * all taken. `blockers` are rectangles; `size` is in grid squares. `bounds` (optional
 * `{width, height}` scene dimensions) rejects candidates that would land off the map.
 */
export function firstFreePlacement(candidates, gridSize, size = {}, blockers = [], bounds = null) {
  const g = Math.max(1, Number(gridSize) || 100);
  const w = (Math.max(0.1, Number(size.w) || 1)) * g;
  const h = (Math.max(0.1, Number(size.h) || 1)) * g;
  for (const c of candidates ?? []) {
    if (bounds) {
      const bw = Number(bounds.width) || 0, bh = Number(bounds.height) || 0;
      if (bw && bh && (c.x < 0 || c.y < 0 || c.x + w > bw || c.y + h > bh)) continue;
    }
    const rect = { x: c.x, y: c.y, w, h };
    if (!(blockers ?? []).some(b => rectsOverlap(rect, b))) return { ...c };
  }
  return null;
}

/**
 * Place a `size` token beside `anchor`: the nearest free spot, else the nearest spot at all
 * (deliberately overlap-tolerant — a vehicle that lands on top of something is still visible and
 * draggable, which is the point of putting it on the canvas at all).
 * @returns {{x:number, y:number, free:boolean}}
 */
export function placeBeside(anchor, gridSize, size = {}, blockers = [], bounds = null) {
  const candidates = adjacentPlacements(anchor, gridSize, size);
  const free = firstFreePlacement(candidates, gridSize, size, blockers, bounds);
  if (free) return { ...free, free: true };
  return { ...candidates[0], free: false };
}
