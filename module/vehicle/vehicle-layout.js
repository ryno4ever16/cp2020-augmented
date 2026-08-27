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
 * THE FOOTPRINT RULE (walk ruling 2026-08-18): a vehicle's LONG axis is the axis it travels
 * along, so a footprint is DEEP rather than wide and a SHORT face leads. At rotation 0 a token
 * faces south (ROTATION_ZERO_FRONT below, which is the core's own convention), so the shipped
 * footprint runs nose-to-tail down the screen and the core's drag auto-rotate then keeps the long
 * axis pointing wherever the vehicle is driven.
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

/* ──────────────────────── the hull and the frame it is carried in ──────────────────────── */

/**
 * THE HULL / FRAME SPLIT (user ruling 2026-08-19, "make the frame follow the hull").
 *
 * On a square grid the core never turns a token's occupied rectangle. A 2-across, 4-deep vehicle
 * turned 37° therefore drew its art at an angle INSIDE an upright 2×4 box: the picture leaned, the
 * box did not, and every interaction the core scopes to that box (hover, click, the selection
 * border, the drag marquee) answered for a rectangle the vehicle was no longer in.
 *
 * So the two facts are separated:
 *   · THE HULL is the vehicle's real shape — `hullW` × `hullH` grid squares, recorded on the ACTOR
 *     (`system.layout.hullW/hullH`). Every mechanic reads it: the seats, the engine region, the
 *     cover cells, the boarding reach, the outline. It turns with the vehicle.
 *   · THE FRAME is the token document's `width`/`height`, and it is now a SQUARE big enough to hold
 *     the hull at ANY angle — `frameSquareFor` below. A square is the one rectangle that a rotation
 *     cannot change the outline of, so the core's own box stops disagreeing with the vehicle the
 *     moment the vehicle turns.
 *
 * The hull sits CENTRED in that square, because rotation is about the token's centre and centring is
 * the only placement a turn leaves alone.
 *
 * ⚠ THE FALLBACK IS LOAD-BEARING. A vehicle saved before the hull was recorded has no hullW/hullH,
 * and `hullDimsOf` then answers with the FRAME it was given — which for those vehicles is still the
 * old rectangle, i.e. exactly the behaviour they have today. Nothing changes for them until the
 * one-time migration records their hull and squares their frame.
 */
export const DEFAULT_HULL = Object.freeze({ w: 2, h: 4 });

/**
 * ⛔ THE CEILING ON A FOOTPRINT, AND WHY THERE HAS TO BE ONE (field incident 2026-08-25).
 *
 * A GM typed `10000` into the second Footprint box. Nothing anywhere refused it, and three separate
 * costs compounded off that one number:
 *   · the sheet's paint grid is one `<button>` per cell, so a 2 × 10000 hull asked the browser for
 *     20,000 buttons, each with a localized tooltip — the sheet drew a mile-long column and then the
 *     tab ran out of memory;
 *   · `frameSquareFor` squares to the LONG axis, so the token frame became 10000 × 10000 squares —
 *     a million grid squares of canvas, a texture the renderer cannot allocate;
 *   · and because both are recomputed every time the sheet opens, the vehicle became unopenable:
 *     the crash reproduced on every attempt to get back in and fix the number.
 *
 * THE NUMBER. Grid squares, not metres: on the 2 m squares these vehicles are drawn on, the largest
 * thing the books actually print is a Maximum Metal airframe — an Osprey-class tilt-rotor at roughly
 * 8–9 squares along its long axis. 20 squares is 40 m, better than double the biggest printed hull,
 * so no book vehicle can reach it and a GM's oversized homebrew still fits. It is also small enough
 * that the two costs above stay ordinary: 20 × 20 is 400 paint cells and a 400-square token frame.
 * Deliberately a SOFT sanity ceiling rather than a rules limit — it exists to stop a typo, not to
 * tell a GM what they may build.
 */
export const HULL_MAX_SQUARES = 20;

/**
 * A count of grid squares, forced into the range a footprint may occupy: at least 1, at most
 * `HULL_MAX_SQUARES`, rounded to a whole square. Unreadable input answers `fallback`.
 *
 * ⭐ THIS IS THE READ-PATH NEUTRALIZATION, and it is why nothing has to be written to repair a
 * poisoned vehicle. An actor that already stores 10000 keeps storing it; every reader of that
 * number — the seats, the engine region, the paint grid, the frame square, the outline — comes
 * through here or through one of the helpers below that call it, so what they all RETURN is
 * bounded. The vehicle's sheet opens, its token draws, and the GM can then type a real number over
 * the stored one (which the sheet's submit guard and the data model both now hold to this range).
 */
export function clampHullDim(v, fallback = 1) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(HULL_MAX_SQUARES, Math.max(1, n));
}

/**
 * A stored hull dimension if it is a usable count of squares, else null.
 *
 * ⚠ An out-of-range stored number is CLAMPED here, not rejected: 10000 is a recorded hull that is
 * too big, not an absent one. Answering null for it would send `hullDimsOf` to the token frame —
 * which on a poisoned vehicle is the same absurd figure, squared — and would make `hasRecordedHull`
 * say the vehicle had never stated a shape, so the hull migration would "record" one over it.
 */
function _hullDim(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(HULL_MAX_SQUARES, n) : null;
}

/**
 * A TOKEN FRAME dimension if it is a credible statement of a vehicle's shape, else null.
 *
 * ⛔ THE FALLBACK NEEDS ITS OWN TEST, AND THE FIELD INCIDENT IS WHY (2026-08-25, measured on the
 * reporter's own actor). The crash was NOT a vehicle carrying an absurd recorded hull. The sequence
 * was: the GM typed 10000 into the Footprint box, the hull-change watcher squared the token frame to
 * 10000 × 10000 — and THEN a stray "E" keystroke in the same box submitted as empty and nulled
 * `hullH`. With the hull no longer recorded, `hullDimsOf` fell back to the frame, which by that point
 * was the poison; the sheet asked for 10000 × 10000 = one hundred million grid cells and the tab died.
 * So the number that has to be disbelieved is the one on the TOKEN, and a clamp alone would have
 * answered "20 × 20" — bounded, but a shape the GM never chose and nine times the car's real size.
 *
 * A frame beyond the ceiling is therefore not clamped but REJECTED: it is damage, not a measurement,
 * and rejecting it drops through to `DEFAULT_HULL`, which puts the poisoned vehicle back to the
 * ordinary 2 × 4 car it always was. A frame WITHIN the range is trusted exactly as before, so the
 * pre-migration vehicles this fallback exists for are untouched.
 */
function _frameDim(v) {
  const n = _hullDim(v);
  return (n !== null && Math.round(Number(v)) <= HULL_MAX_SQUARES) ? n : null;
}

/**
 * Has this vehicle written its hull down, or is it still reading its shape off its token frame?
 *
 * ⛔ ASK THIS, never `Number.isFinite(Number(system.layout.hullW))`. The field's un-recorded value is
 * `null`, and `Number(null)` is **0**, which is finite — so the obvious test answers "recorded" for
 * every vehicle that has recorded nothing. It cost this unit a green migration that silently wrote no
 * hull at all: the frames were squared, the field stayed null, and the pass reported success.
 */
export function hasRecordedHull(system) {
  return _hullDim(system?.layout?.hullW) !== null && _hullDim(system?.layout?.hullH) !== null;
}

/**
 * The hull a vehicle actually has: the recorded dimensions, else the frame it is being carried in.
 * @param {object} system      the vehicle actor's system data
 * @param {number} fallbackW   the token frame's width in squares (used when nothing is recorded)
 * @param {number} fallbackH   the token frame's height in squares
 * @returns {{w:number, h:number}}
 */
export function hullDimsOf(system, fallbackW, fallbackH) {
  const w = _hullDim(system?.layout?.hullW);
  const h = _hullDim(system?.layout?.hullH);
  if (w && h) return { w, h };
  // `_frameDim`, not `_hullDim`: a frame bigger than the ceiling is discarded rather than clamped, so
  // a vehicle whose token was blown up by the field incident falls back to the default car instead of
  // to a 20 × 20 slab. See `_frameDim` for the measured sequence.
  return {
    w: _frameDim(fallbackW) ?? DEFAULT_HULL.w,
    h: _frameDim(fallbackH) ?? DEFAULT_HULL.h,
  };
}

/**
 * The token frame a hull needs: a square whose side covers the hull's LONG axis, so the hull fits
 * inside it at every angle. (A tighter frame would clip the hull's corners on the diagonals; the
 * circumscribing square of a rotated rectangle is bigger still, and paying for the diagonal would
 * put a 6×6 box round a 2×4 car for the sake of two angles.)
 */
export function frameSquareFor(hull) {
  // Clamped, and not only for tidiness: this is the number that becomes a token's width AND height,
  // so an unbounded long axis is squared into the canvas cost — 10000 deep asked for 100,000,000
  // grid squares of token. The hull it is given is normally already bounded; a caller handing over a
  // raw pair (a legacy token frame, say) is bounded here.
  return clampHullDim(Math.max(Number(hull?.w) || 1, Number(hull?.h) || 1));
}

/**
 * The hull's own axis-aligned rectangle, centred inside the token frame. Turn it about its centre by
 * the token's rotation and you have the shape the vehicle really occupies; every rotated-rect helper
 * further down this file takes it as-is.
 * @param {{x:number,y:number,w:number,h:number}} frameRect  the token's pixel rect (a square)
 * @param {{w:number,h:number}} hull                          hull size in grid squares
 * @param {number} grid                                       pixels per square
 */
export function hullRectIn(frameRect, hull, grid) {
  const g = Math.max(1, Number(grid) || 100);
  const hw = clampHullDim(hull?.w) * g;
  const hh = clampHullDim(hull?.h) * g;
  const c = rectCenter(frameRect);
  return { x: c.x - hw / 2, y: c.y - hh / 2, w: hw, h: hh };
}

/**
 * How far down the artwork is scaled so it stays inside the hull rather than filling the square.
 *
 * The token's texture is fitted (`fit: "contain"`) to the FRAME, which is now bigger than the hull —
 * left alone, a car would be drawn a square wider than the shape it occupies, hanging outside its own
 * outline. The scale is UNIFORM (`short ÷ long`) rather than per-axis: a per-axis scale would make the
 * art exactly fill the hull, at the cost of squashing whatever picture the GM chose, and distorting a
 * GM's artwork is a worse trade than drawing it a little smaller.
 *
 * For the ordinary case — a landscape vehicle picture in a deep hull — this reproduces the OLD
 * drawing exactly: contain-in-a-square then ×(short/long) lands on the same pixels as contain-in-the-
 * hull did, because the art's width was the limiting dimension both times.
 */
export function hullArtScale(hull) {
  const w = clampHullDim(hull?.w);
  const h = clampHullDim(hull?.h);
  return Math.min(w, h) / Math.max(w, h);
}

/* ────────────────── which way a token points when its rotation is zero ────────────────── */

/**
 * SOUTH — and this is not ours to choose. The core states it in its own token schema ("A value of
 * 0 represents a southward-facing Token", foundry `common/documents/_types.mjs`) and then acts on
 * it: drag a token and the core turns it to face where it went, by
 * `rotation = degrees(atan2(dy, dx)) − 90`. Drive east and it writes −90; drive south and it
 * writes 0. The setting behind that (`core.tokenAutoRotate`) is on out of the box, so every
 * hand-dragged vehicle is turned by the core whether or not the module agrees with it.
 *
 * ⛔ WHAT WENT WRONG WITHOUT THIS CONSTANT (walk report: "it drives with its longest face
 * leading"). The module carried THREE different answers to the same question. The shipped
 * footprint said EAST — four squares wide by two deep, nose along the width. The facing math said
 * NORTH. The footprint outline drew its nose spur NORTH. So a vehicle dragged east was turned 90°
 * by the core, its long side swung broadside across the direction of travel, and the crew, the
 * engine block and the front armour each answered for a different end of the same car. There is
 * one answer now and every consumer reads it from here.
 */
export const ROTATION_ZERO_FRONT = "s";

/**
 * The unit vector a token at `deg` points along, in screen pixels — +y is DOWN, as everywhere else
 * on the canvas. Rotation 0 is south = (0, 1) and the angle runs clockwise on screen, which is the
 * same thing the core's own −90-for-east formula says.
 */
export function headingVector(deg) {
  const r = ((Number(deg) || 0) * Math.PI) / 180;
  return { x: -Math.sin(r), y: Math.cos(r) };
}

/**
 * The heading a vehicle gets before anyone picks one: the core's, because an unrotated token is
 * drawn exactly as its art was drawn and the core has already declared which way that is.
 *
 * ⛔ It used to guess from the footprint's SHAPE (wide ⇒ nose east, tall ⇒ nose south). That guess
 * is what let a four-wide vehicle claim an eastward nose while the core turned it as though it
 * faced south — two headings 90° apart, on the same car, in the same moment. A shape cannot say
 * which end of a picture is the front; the sheet's Front picker is how a GM says so for art that
 * disagrees with the core's convention.
 */
export function defaultFrontFor() {
  return ROTATION_ZERO_FRONT;
}

/** The stored heading if it is one of the four, else the convention's. */
export function resolveFront(front) {
  const f = String(front ?? "").trim().toLowerCase();
  return FRONTS.includes(f) ? f : defaultFrontFor();
}

/**
 * The local frame's dimensions for a footprint at a heading. A vehicle facing east or west runs
 * nose-to-tail along the map's X axis, so its RANKS are the footprint's columns and its FILES are
 * its rows — width and height swap over.
 * @returns {{front:string, ranks:number, files:number, w:number, h:number}}
 */
export function layoutFrame(w, h, front) {
  // Every rank/file walk in this file goes through here, so bounding the two dimensions once bounds
  // the cell enumeration everywhere: no caller can ask for a rank list a browser cannot hold.
  const gw = clampHullDim(w);
  const gh = clampHullDim(h);
  const f = resolveFront(front);
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
 * WHICH EDGE OF THE HULL IS THE NOSE, for a heading — the SAME answer `cellIndexAt` gives for rank 0,
 * said once so the picture and the mechanics cannot state it differently.
 *
 * ⛔ WHY THIS EXISTS (reported from the table 2026-08-19: *"the Front buttons have no visible effect
 * and there's no way to tell which side the front is"*). Front moved the seats, the engine region and
 * the cover facings — `layoutFor` reads it — but the drawn hull outline did not read it at all: its
 * nose spur was pinned to the bottom edge, i.e. to `ROTATION_ZERO_FRONT` alone. So a vehicle whose GM
 * had pointed its nose east was drawn with a spur out of its flank while its engine block, its driver
 * and its front armour were all at the other end. Two notions of "front" on one car.
 *
 * The pairs index `rotatedRectCorners`, which returns [top-left, top-right, bottom-right, bottom-left]
 * — so the four edges are (0,1) top, (1,2) right, (2,3) bottom, (3,0) left, exactly the four faces
 * `cellIndexAt` puts rank 0 against. Because those corners come back ALREADY turned by the token's
 * rotation, taking the pair here composes the two facts: the heading picks the face, the rotation
 * carries it round. PURE.
 */
export const NOSE_CORNERS = Object.freeze({ n: [0, 1], e: [1, 2], s: [2, 3], w: [3, 0] });

/** The two corner indices of the nose edge for a stored heading (unrecognized ⇒ the convention's). */
export function noseCornerPair(front) {
  return NOSE_CORNERS[resolveFront(front)];
}

/**
 * The midpoint of the nose edge, given a hull's four (already rotated) corners and a heading. The one
 * point the outline's spur is drawn from and the one a keeper reads back.
 * @param {{x:number,y:number}[]} corners  `rotatedRectCorners` output
 * @param {string} front                   the stored heading
 */
export function noseMidpoint(corners, front) {
  const [i, j] = noseCornerPair(front);
  const a = corners?.[i], b = corners?.[j];
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
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

/* ──────────────────────────────── the painted grid (Layer 2) ──────────────────────────────── */

/**
 * A vehicle whose shape the defaults get wrong — a rear-engine car, a bus, a pickup bed, a gunner
 * standing where a passenger would sit — is edited by PAINTING its footprint: one character per
 * cell, row-major, read straight off the sheet's grid.
 *
 *   "." body (the default)   "S" seat   "E" engine
 *
 * Painted cells REPLACE the derived layer wholesale rather than merging with it: seats become the
 * painted seats, the engine region becomes the painted engine cells (possibly none at all, which
 * is how a trailer or an electric runabout says it has no engine block). Nothing painted = the
 * Layer-1 defaults, so the string is absent on every vehicle that never needed it.
 */
export const CELL_BODY = ".";
export const CELL_SEAT = "S";
export const CELL_ENGINE = "E";
const CELL_CYCLE = [CELL_BODY, CELL_SEAT, CELL_ENGINE];

/**
 * The painted grid as an array of cell characters, or null when there is nothing usable to read.
 * A string whose length does not match the footprint is treated as ABSENT rather than repaired:
 * it was painted for a different shape, and silently stretching it would put seats in cells the
 * GM never chose. Resizing a vehicle therefore drops back to the derived layout, which is visible
 * on the sheet the moment it is opened.
 */
export function parseCells(cells, w, h) {
  const gw = clampHullDim(w);
  const gh = clampHullDim(h);
  const s = String(cells ?? "").trim().toUpperCase();
  if (!s || s.length !== gw * gh) return null;
  const arr = [...s];
  if (!arr.every(c => CELL_CYCLE.includes(c))) return null;
  return arr;
}

/** The stored form of a painted grid. */
export function formatCells(arr) {
  return (arr ?? []).map(c => (CELL_CYCLE.includes(c) ? c : CELL_BODY)).join("");
}

/** Body → Seat → Engine → Body. The whole editor is this one step, repeated by clicking. */
export function cycleCell(ch) {
  const i = CELL_CYCLE.indexOf(String(ch ?? CELL_BODY).toUpperCase());
  return CELL_CYCLE[(i < 0 ? 0 : i + 1) % CELL_CYCLE.length];
}

/**
 * The cell roles a vehicle STARTS from when the GM first paints one — the derived layout written
 * out, so the grid opens showing what the vehicle is already doing instead of a blank slate.
 */
export function derivedCells(w, h, front) {
  const gw = clampHullDim(w);
  const gh = clampHullDim(h);
  const arr = new Array(gw * gh).fill(CELL_BODY);
  for (const i of derivedEngineCells(gw, gh, front)) arr[i] = CELL_ENGINE;
  for (const i of derivedSeatOrder(gw, gh, front)) arr[i] = CELL_SEAT;
  return arr;
}

/**
 * The order riders take PAINTED seats — ranks front-to-back, driver's-left first within a rank, so
 * the driver is the front-most, left-most painted seat.
 *
 * ⭐ RULED FRONT-RELATIVE (user, 2026-08-13): painted and derived layouts agree about what "first
 * seat" means. The original L2 wording was "driver = first painted seat in reading order", which
 * pulled against the L1 correction made one day later — that moved the DERIVED driver from the
 * top-left cell to the front-left one. Reading order is a fact about the STRING; the two layers are
 * describing the same vehicle, so the order that matters is a fact about the VEHICLE. On an
 * east-facing car the two disagree outright: reading order seats the driver at the rear-left while
 * the derived layout seats them at the front-left, and one car cannot have its driver in two places
 * depending on which way its seats were entered.
 *
 * The walk is `derivedSeatOrder`'s, minus the engine-rank skip: every rank is offered, front first,
 * and only the cells actually painted as seats are taken. A painted grid states its own engine
 * region (possibly none), so there is no rank to skip on faith here.
 */
export function paintedSeatOrder(painted, w, h, front) {
  const fr = layoutFrame(w, h, front);
  const out = [];
  for (let rank = 0; rank < fr.ranks; rank++) {
    for (const i of rankCells(w, h, front, rank)) {
      if (painted[i] === CELL_SEAT) out.push(i);
    }
  }
  return out;
}

/**
 * THE one layout answer every consumer reads — seating, the engine region, the cover ray and the
 * sheet's own grid all come through here, so they cannot disagree about the same vehicle.
 * @returns {{front:string, painted:boolean, cells:string[], engine:number[], seats:number[]}}
 */
export function layoutFor(w, h, front, cells) {
  // The one answer every consumer reads is also the one place a runaway footprint would reach all of
  // them from, so the bound is applied here as well as inside layoutFrame — `cells` is sized from
  // these two figures directly.
  const gw = clampHullDim(w);
  const gh = clampHullDim(h);
  const f = resolveFront(front);
  const painted = parseCells(cells, gw, gh);
  if (!painted) {
    return {
      front: f, painted: false, cells: derivedCells(gw, gh, f),
      engine: derivedEngineCells(gw, gh, f), seats: derivedSeatOrder(gw, gh, f),
    };
  }
  const engine = [];
  for (let i = 0; i < painted.length; i++) if (painted[i] === CELL_ENGINE) engine.push(i);
  const seats = paintedSeatOrder(painted, gw, gh, f);
  return {
    front: f, painted: true, cells: painted, engine,
    // A grid painted with no seats at all would be a vehicle nobody can board, which reads as a
    // slip rather than an instruction — fall back to the derived seating and leave the painted
    // engine region standing.
    seats: seats.length ? seats : derivedSeatOrder(gw, gh, f),
  };
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

/* ──────────────────────────── the rotated footprint (Layer 4) ──────────────────────────── */

/**
 * A core token frame is an axis-aligned rectangle and cannot tilt, so a car parked across a street
 * at 30° has a footprint the platform simply cannot express. The honest architecture (ruled
 * 2026-08-13, FREE rotation — steps were rejected as not granular enough) is that the vehicle's
 * TRUE footprint is a module-owned ROTATED RECTANGLE: the token's own rect, turned about its
 * centre by the token's own rotation, at any angle the GM's gesture produces.
 *
 * Nothing here changes what the token is. The document keeps its axis-aligned x/y/width/height —
 * that is what core, targeting, the HUD and every other module read — and the rotated rect is
 * metadata OUR mechanics read on top of it: containment, seat positions, the engine region, the
 * cover ray.
 *
 * ⭐ THE TRICK THAT KEEPS ALL OF IT SIMPLE: rather than rotating the geometry, rotate the
 * QUESTION. A point or a segment is turned by −θ about the rect's centre, and every existing
 * axis-aligned test then answers correctly in the vehicle's own frame. One helper, and cells,
 * seats and the cover ray all become angle-agnostic for free.
 */

/** Turn a point about a centre by `deg` degrees (clockwise on screen, as token rotation reads). */
export function rotatePointAbout(p, center, deg) {
  const d = Number(deg) || 0;
  if (!d) return { x: p.x, y: p.y };
  const r = (d * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const dx = p.x - center.x, dy = p.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

/** The centre of a `{x,y,w,h}` rectangle. */
export function rectCenter(rect) {
  return { x: (Number(rect?.x) || 0) + (Number(rect?.w) || 0) / 2, y: (Number(rect?.y) || 0) + (Number(rect?.h) || 0) / 2 };
}

/** The four corners of a rectangle turned about its own centre, top-left first, clockwise. */
export function rotatedRectCorners(rect, deg) {
  const c = rectCenter(rect);
  const x0 = Number(rect?.x) || 0, y0 = Number(rect?.y) || 0;
  const x1 = x0 + (Number(rect?.w) || 0), y1 = y0 + (Number(rect?.h) || 0);
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
    .map(p => rotatePointAbout(p, c, deg));
}

/**
 * Is a point inside the rotated footprint? Answered by turning the POINT back into the vehicle's
 * own frame — where the footprint is the plain rectangle it always was.
 */
export function pointInRotatedRect(p, rect, deg) {
  if (!p || !rect) return false;
  const local = rotatePointAbout(p, rectCenter(rect), -(Number(deg) || 0));
  return local.x >= rect.x && local.x <= rect.x + rect.w
    && local.y >= rect.y && local.y <= rect.y + rect.h;
}

/** The same trick for a segment: both endpoints back into the vehicle's frame, once, up front. */
export function segmentIntoLocalFrame(a, b, rect, deg) {
  const c = rectCenter(rect);
  const d = -(Number(deg) || 0);
  return { a: rotatePointAbout(a, c, d), b: rotatePointAbout(b, c, d) };
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
