/**
 * vehicle-layout.js — where the seats and the engine are, inside a vehicle's footprint.
 *
 * Pure like vehicle-seating.js: plain functions over numbers and strings, no `game`, no `canvas`,
 * no documents, no i18n. The impure half (reading the actor, moving tokens) lives in
 * vehicle-canvas.js and the sheet.
 *
 * THE PROBLEM THIS SOLVES (user, 2026-08-13): the module cannot know which end of a vehicle's
 * ARTWORK is its nose, so seating used to start at the footprint's top-left square — which put the
 * driver on the hood. One fact fixes it: **Front**, the compass direction the nose points on the
 * map. Everything else here derives from Front plus the footprint's width × height.
 *
 * THE LOCAL FRAME (the whole file is written in it):
 *   A footprint is addressed as RANK × FILE instead of row × column.
 *     · rank 0 = the front-most line of cells (the nose); rank grows toward the tail.
 *     · file 0 = the DRIVER'S LEFT — left as someone sitting in the vehicle facing forward sees
 *       it, not left-on-screen. Facing north, that is west; facing south, east.
 *   So a rank/file pair is the same seat on the same vehicle at every heading, and Front is the
 *   only thing that has to change when the GM turns the car around.
 *
 * THE DEFAULTS (user ruling 2026-08-13, VEHICLE-LAYOUT-DESIGN.md L1):
 *   · Engine = rank 0, the front-most line of cells.
 *   · Seats  = every remaining cell, ranks front-to-back, each rank left-to-right. Seat 0 — the
 *     driver — is therefore rank 1, file 0: the left cell of the row BEHIND the hood, which on a
 *     2-wide 4-deep car is the real driver's seat.
 *   · A footprint only ONE rank deep (a 1×1 remote, a bike stood on its wheel) has no room to
 *     spend a whole rank on an engine, so it keeps every cell as seating and declares no engine
 *     region. Carving one out would leave a vehicle nobody can sit in.
 */

/** The four headings. Stored lowercase on the actor; "" means "derive from the footprint". */
export const FRONTS = ["n", "e", "s", "w"];

/**
 * The heading a footprint gets before anyone picks one: a WIDE vehicle is drawn facing across the
 * screen (nose east), a TALL one facing down it (nose south). Square footprints take south — the
 * neutral "parked facing the reader" pose most vehicle art is drawn in.
 */
export function defaultFrontFor(w, h) {
  const gw = Math.max(1, Math.round(Number(w) || 1));
  const gh = Math.max(1, Math.round(Number(h) || 1));
  return gw > gh ? "e" : "s";
}

/** The stored heading if it is one of the four, else the footprint's default. */
export function resolveFront(front, w, h) {
  const f = String(front ?? "").trim().toLowerCase();
  return FRONTS.includes(f) ? f : defaultFrontFor(w, h);
}

/**
 * The local frame's dimensions for a footprint at a heading. A vehicle facing east or west runs
 * nose-to-tail along the map's X axis, so its RANKS are the footprint's columns and its FILES are
 * its rows — width and height swap over.
 * @returns {{front:string, ranks:number, files:number, w:number, h:number}}
 */
export function layoutFrame(w, h, front) {
  const gw = Math.max(1, Math.round(Number(w) || 1));
  const gh = Math.max(1, Math.round(Number(h) || 1));
  const f = resolveFront(front, gw, gh);
  const sideways = (f === "e" || f === "w");
  return { front: f, ranks: sideways ? gw : gh, files: sideways ? gh : gw, w: gw, h: gh };
}

/**
 * The footprint cell at a rank/file, as a row-major index (row * width + col) — the same numbering
 * footprintCells() walks in vehicle-seating.js, so an index here is directly a cell there.
 *
 * The four cases are just "which corner is the nose-left one, and which way do rank and file run":
 *   n → nose at the top, driver's left is west  → col = file, row = rank
 *   s → nose at the bottom, driver's left is east → col mirrored, row mirrored
 *   e → nose at the right, driver's left is north → col mirrored (rank), row = file
 *   w → nose at the left, driver's left is south  → col = rank, row mirrored
 * @returns {number} row-major index, or -1 when the rank/file is outside the footprint
 */
export function cellIndexAt(w, h, front, rank, file) {
  const fr = layoutFrame(w, h, front);
  const r = Math.trunc(Number(rank));
  const fl = Math.trunc(Number(file));
  if (!(r >= 0 && r < fr.ranks && fl >= 0 && fl < fr.files)) return -1;
  let col, row;
  switch (fr.front) {
    case "n": col = fl;                 row = r;                 break;
    case "s": col = fr.w - 1 - fl;      row = fr.h - 1 - r;      break;
    case "e": col = fr.w - 1 - r;       row = fl;                break;
    default:  col = r;                  row = fr.h - 1 - fl;     break;   // "w"
  }
  return row * fr.w + col;
}

/** Every cell index of one rank, driver's-left to driver's-right. */
export function rankCells(w, h, front, rank) {
  const fr = layoutFrame(w, h, front);
  const out = [];
  for (let file = 0; file < fr.files; file++) {
    const i = cellIndexAt(w, h, front, rank, file);
    if (i >= 0) out.push(i);
  }
  return out;
}

/**
 * The engine region a vehicle gets when nobody has painted one: the front-most rank. Empty for a
 * one-rank footprint (see the file header — there would be nothing left to sit in).
 * @returns {number[]} row-major cell indices
 */
export function derivedEngineCells(w, h, front) {
  const fr = layoutFrame(w, h, front);
  if (fr.ranks < 2) return [];
  return rankCells(w, h, front, 0);
}

/**
 * The seat order a vehicle gets when nobody has painted one: every cell that is not engine, ranks
 * front-to-back, each rank driver's-left first. Seat 0 is the driver.
 * @returns {number[]} row-major cell indices, in seating order
 */
export function derivedSeatOrder(w, h, front) {
  const fr = layoutFrame(w, h, front);
  const skipFirstRank = fr.ranks >= 2;
  const out = [];
  for (let rank = skipFirstRank ? 1 : 0; rank < fr.ranks; rank++) out.push(...rankCells(w, h, front, rank));
  return out;
}

/* ─────────────────────────────────── segment geometry ─────────────────────────────────── */

/**
 * Does the segment a→b touch the axis-aligned rectangle `{x,y,w,h}`? Liang-Barsky clipping: walk
 * the rectangle's four edge planes, narrowing the parameter window the segment is allowed to live
 * in, and answer no the moment the window closes. Exact — no sampling, so a shot cannot slip
 * between two probe points and miss a cell it really crossed.
 *
 * Axis-aligned is not a limitation on rotated vehicles: a rotated footprint is tested by rotating
 * the SEGMENT into the vehicle's own frame first, where its cells are square again.
 */
export function segmentHitsRect(a, b, rect) {
  if (!a || !b || !rect) return false;
  const dx = b.x - a.x, dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - rect.x, rect.x + rect.w - a.x, a.y - rect.y, rect.y + rect.h - a.y];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;               // parallel to this edge and outside it
      continue;
    }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else          { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

/* ────────────────────────────── cover profile by vehicle type ────────────────────────────── */

/**
 * What a vehicle of each type stops when someone shoots THROUGH it (Core p.99 "COMMON COVER SPS",
 * ruled D2 2026-08-12). The book prints exactly three vehicle rows — Car Body/Door 10, Engine
 * Block 35, Armored Car Body 40 (AV-4 Body likewise 40) — so every type maps onto one of them:
 *
 *   · cycle → NO cover at all. A motorcycle is a frame and two wheels; the book gives it no body
 *     row, and the user ruled bikes contribute nothing rather than inventing a number for them.
 *   · AV-4 / AV-6 / AV-7 / tank / APC → 40, the armoured row. A tank plainly stops more than an
 *     armoured car, but 40 is the largest cover SP the book prints and inventing a bigger one is
 *     exactly the kind of number this project does not make up.
 *   · everything else (car, sportscar, limo, truck, rotor, osprey, boat) → 10, the car-body row.
 *
 * The engine block is 35 for anything that has a body at all; a vehicle whose engine region is
 * empty simply never reads it. These are PREFILLS, not settings: the sheet shows them and a GM
 * number typed over one wins, so nothing is written to an actor that never needed it.
 */
const ARMORED_TYPES = ["AV-4", "AV-6", "AV-7", "tank", "APC"];
const OPEN_TYPES = ["cycle"];
export const COVER_BODY_SP_ARMORED = 40;
export const COVER_BODY_SP_DEFAULT = 10;
export const COVER_ENGINE_SP = 35;

/**
 * @returns {{providesCover:boolean, bodySp:number, engineSp:number}} the type's book prefills.
 */
export function coverProfileFor(vehicleType) {
  const t = String(vehicleType ?? "").trim();
  if (OPEN_TYPES.includes(t)) return { providesCover: false, bodySp: 0, engineSp: 0 };
  const armored = ARMORED_TYPES.includes(t);
  return {
    providesCover: true,
    bodySp: armored ? COVER_BODY_SP_ARMORED : COVER_BODY_SP_DEFAULT,
    engineSp: COVER_ENGINE_SP,
  };
}

/**
 * The SP figures actually in play for a vehicle: the type's prefill unless the sheet carries a
 * typed override. A stored number of 0 is a deliberate "this stops nothing", so only null/""/
 * non-numbers fall back to the prefill.
 * @param {object} p.system  the vehicle actor's system data (vehicleType + layout.*)
 */
export function coverSpFor(system) {
  const profile = coverProfileFor(system?.vehicleType);
  const stored = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0) ? Math.round(v) : null;
  const body = stored(system?.layout?.bodySp);
  const engine = stored(system?.layout?.engineSp);
  return {
    providesCover: profile.providesCover || body > 0,
    bodySp: body ?? profile.bodySp,
    engineSp: engine ?? profile.engineSp,
  };
}
