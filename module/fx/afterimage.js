/**
 * ══════════════ THE MOVEMENT ECHO TRAIL, AND THE ACTIVATION GRADE ══════════════
 *
 * A figure whose activated initiative boost is switched on leaves copies of itself behind as it
 * crosses the map — full-opacity clones of its OWN token art, planted along the REAL path it walked,
 * running a colour ramp from the oldest copy to the newest and unravelling oldest-first. At the
 * instant the implant is switched on, the whole scene takes one green pass and lets go of it again.
 *
 * ⛔ IT DRAWS A PICTURE AND NOTHING ELSE. No document is written, no flag is set, no actor or token
 * is created; the trail is per-client presentation over state that already exists. The mechanism it
 * reads is the one `mech/speedware.js` and `mech/consumable.js` already run — an Activatable
 * Characteristic-initiative implant's `EffectActive` — and this file NEVER writes it, never mirrors
 * it into a parallel flag, and never keeps its own clock. When the printed five turns run out, the
 * consumable tick flips `EffectActive` back off; the very next movement reads false and draws
 * nothing. That is the whole of the expiry handling, and it is why there is none.
 *
 * ⭐ WHY IT IS A SEPARATE FILE. The same answer the condition overlays and the extraction arrival
 * gave: `module/fx/` is the containment boundary, not one file inside it. Every capability question
 * is asked through the rail's own adapters (`sequencerActive`, and the master switch through
 * `combatFxEnabled`), so there is still exactly one adapter to the effects engine; only this
 * element's own table lives here.
 *
 * ⭐ NO RELAY, AND THAT IS A FINDING RATHER THAN A SHORTCUT. Both triggers are already broadcast by
 * the core: `moveToken` fires "for every Token document that was moved … for all connected clients
 * after the update has been processed" (client/documents/token.mjs, `#onUpdateOperationMovement`),
 * and an item update reaches every client's `updateItem`. So every client arms itself from the same
 * event, draws its own copy, and no socket path is added — which is what the standing reuse rule
 * asks for. The engine's own per-sprite push is therefore turned OFF (`.locally()`), for exactly the
 * reason status-fx.js and trauma-team.js record: when every client is already a drawer, the engine
 * must not ALSO transport the drawings, or N clients see N copies.
 *
 * ⭐ THE ART IS THE FIGURE'S OWN TEXTURE, which is the one documented exemption from "database keys,
 * never file paths" (standard §A/2). That rule exists so a draw resolves on whichever asset tier is
 * installed and so nothing is vendored; a token's `texture.src` is neither — it is a path the scene
 * already owns and is already drawing this frame. Guarded all the same: no source, no trail.
 *
 * ⛔ SETTLE-EXCLUDED, AND STRUCTURALLY SO. This element is scene dressing on the movement clock, not
 * on a shot's. It is never queued from `fxWeaponFired`, contributes no field any resolved entry
 * carries, and therefore cannot appear in `presentationTailMs` — the damage-apply window can no more
 * wait on a movement echo than it can on the weather. The exclusion is stated here, asserted by the
 * keeper against the real tail arithmetic, and recorded in docs/FX-RAIL.md §2.
 */

import { sequencerActive } from "./effects.js";
import { combatFxEnabled } from "../settings.js";
import { isActivatedInitiativeBoost } from "../mech/speedware.js";

const SCOPE = "cp2020-augmented";

/** The one prefix every part of this element is stamped under, so the census is a query of the engine. */
export const AFTERIMAGE_NAME = `${SCOPE}.afterimage`;

/**
 * ══════════ THE FROZEN SPEC — every number a reviewer might move, with what set it ══════════
 *
 * THE MEASURED HALF comes from the 60 fps frame study of the reference recording (the same
 * instrument that built the extraction arrival), recorded verbatim in memory
 * `project-red-feature-slate.md` § "VIDEO FRAME-STUDY SPECS" and re-stated in ledger #23bv:
 *
 *   "12 full-opacity ghost clones, edge-to-edge 1/grid, ~1 ghost per 200 ms along the REAL path
 *    (turns corners); hue ramp oldest→newest lime→teal→cyan→blue→violet→magenta; teardown
 *    oldest-first ~250-400 ms; scene GREEN pass (R −42%, B −23%, G held) ramps 1.6 s, holds 2.4 s."
 *
 * Every number below is either one of those, or a build-lane pick made against them and named as
 * such. The build-lane picks are listed in docs/FX-RAIL.md §5 and §8 so a veto costs one edit.
 */
export const AFTERIMAGE = Object.freeze({
  /* ── the trail ── */
  // ⭐⭐ THE SETTLE-THEN-UNZIP MODEL (user refinement 2026-08-28, watching the reference): copies are
  // laid out as the figure moves and NONE of them fades while it is still moving; when it SETTLES,
  // the trail unzips from the FIRST copy laid to the newest, very rapidly. There is NO count cap —
  // the whole drag is ghosted (the reference's 13 was simply how far that figure moved), and the
  // safety rail below bounds queued work, not the look. This SUPERSEDES the same day's per-copy-
  // lifetime rolling window (ghostLifetimeMs, deleted — §6 has the chain): under it the count and
  // the decay speed fought over one ratio; under settle-then-unzip they are independent.
  //
  // The reference count, kept as the hue ramp's wrap period for a caller that has no trail total
  // (the ramp normally SPANS the whole trail — see ghostHueFor).
  ghostCap: 13,
  // MEASURED: ~1 ghost per 200 ms of movement. (The 2026-08-28 density detour to 80 ms existed only
  // to hold 13 alive under the per-lifetime model; the settle model gets its count from the PATH, so
  // the measured gate returns.)
  ghostCadenceMs: 200,
  // MEASURED: edge-to-edge ~1 grid square — centre-to-centre spacing of one square, which for a
  // one-square figure is edges very nearly touching. (Restored with the cadence, same reason.)
  ghostSpacingSquares: 1,
  // ⭐ THE TWO GATES ARE BOTH REQUIRED, and the arithmetic says which one binds. Foundry's own
  // default token speed is `CONFIG.Token.movement.defaultSpeed` = 6 grid spaces per second
  // (client/config.mjs), i.e. one square per 166.7 ms. So at the engine's default pace the 200 ms
  // cadence is the binding gate and plants land every 1.2 squares; a figure moving SLOWER than
  // 5 squares/second is bound by the spacing gate instead and its plants land one square apart.
  // Requiring both is the non-spammy reading: a crawl does not carpet the floor, and a sprint does
  // not draw a solid line.
  requireBothGates: true,

  // MEASURED: full opacity. The reference's copies are not faint.
  ghostOpacity: 1,
  // ⭐ MEASURED (2026-08-28, this session's own 60 fps frame-diff of the showcase's 49-53 s move,
  // sandy_unzip.py): the mover settles ~52.9 s and the first copy's fade begins ~53.12 s.
  settleDelayMs: 200,
  // ⭐ MEASURED (same study): the fade-starts walk the trail at ~20 ms per copy — slots 0→5 begin at
  // 53.117 / 53.150 / 53.167 / 53.183 / 53.200 / 53.217. A 13-copy trail is clean ~450 ms after the
  // wave starts. This is the "very rapidly" the user described.
  unzipStaggerMs: 20,
  // ⭐ MEASURED (same study): each copy's own fade runs ~150-200 ms (last fade-start ~53.34, trail
  // clean by ~53.55). Lerped front-to-back so the wave reads as motion. ⏪ The frame study's older
  // 250/400 read was this same phenomenon timed coarsely.
  ghostTeardownMinMs: 150,
  ghostTeardownMaxMs: 200,
  // BUILD-LANE PICK: a clone appears at once. A fade-in would make the newest copy the faintest,
  // which is the opposite of the reference's read.
  ghostFadeInMs: 0,

  /* ── the colour, and the one number that makes the ramp source-independent ── */
  // The equal-weight greyscale applied to the figure's own art BEFORE the colour is multiplied on.
  // ⭐ 1/3 AND NOT 1: PIXI's `greyscale(scale)` matrix is all-`scale` rows, so it SUMS the three
  // channels rather than averaging them — at scale 1 a white pixel maps to 3× white and clips. One
  // third is the average, and it is what makes the duotone below preserve the figure's shading.
  // ⏪ REVERT: `null` drops the greyscale op entirely, leaving a plain multiply of the token's own
  // colours by the ramp colour (murkier, more literally "the token art", far weaker hue read).
  ghostGreyscale: 1 / 3,

  /* ── the scene grade ── */
  // MEASURED: R −42%, B −23%, G held.
  gradeRedScale: 0.58,
  gradeGreenScale: 1.00,
  gradeBlueScale: 0.77,
  // ⭐⭐ THE PASS RIDES THE MOVEMENT — measured off the video's channel ratios (sandy_grade.py,
  // R/G and B/G of the map region, 10 samples/s): NEUTRAL before the move (1.015/1.116 through
  // 46-49 s), snapping in at 49.1 s exactly as the movement starts, ramping ~1.6 s to full
  // (R/G 0.51, B/G 0.48), HELD through the move, releasing ~53.3 s — as the unzip runs out — and
  // fully neutral by ~54.0. NOT sustained for the implant's five turns (the earlier "whole clip is
  // green" read was the map's own art fooling a baseline subtraction) and NOT a fixed burst at an
  // activation instant. Release begins at settle + the unzip's span (predicted 53.36 vs observed
  // ~53.3) — gradeReleaseAtMsFor.
  // MEASURED: ramp 1.6 s.
  gradeRampMs: 1600,
  // Kept for the pure ladder's fixed-hold (burst) arithmetic, which the keeper pins and a macro may
  // ask for; the shipped movement-tied pass holds by state, not by this number.
  gradeHoldMs: 2400,
  // ⭐ MEASURED (2026-08-28): the release runs ~0.7-0.8 s (ratios depart ~53.3, neutral at ~54.0).
  // ⏪ REVERT: 1600 (the earlier ramp-mirrored pick).
  gradeReleaseMs: 800,

  /* ── the long-lived contract (standard §G) ── */
  // ⛔ SAFETY-ONLY under the settle-then-unzip model (the reference shows NO live cap — a 13-copy
  // trail stands whole until the settle): equal to the plant rail, so eviction can only fire on a
  // pathological pile-up, never on an honest drag. The unzip is the real bound. §G's cap+eviction
  // machinery is kept wired for exactly that overflow case.
  maxLive: 160,
  // ⛔ USER RULING (2026-08-28): a long continuous drag keeps producing copies for its WHOLE length —
  // the trail follows the mover as a rolling window, with `maxLive` and the per-copy lifetime doing
  // the bounding. This number only bounds the TIMERS one movement may queue, so a pathological
  // cross-map drag cannot schedule unbounded work: it is a safety rail, not a look number. 160 plants
  // ≈ 13 s of continuous movement at the dense cadence.
  plantSafetyCap: 160,
});

/**
 * ══════════ THE SIX COLOURS ══════════
 *
 * MEASURED as NAMES, not as numbers: the frame study records the ramp as
 * lime → teal → cyan → blue → violet → magenta and nothing finer. The six hue ANGLES below are
 * therefore a build-lane derivation from those names — each is the standard angle for the colour it
 * is named after, chosen so the walk is strictly monotone from yellow-green to magenta-pink, which
 * is the one property the named sequence does assert. ⚠ UNSIGNED LOOK CALL (docs/FX-RAIL.md §8): the
 * six hexes are the lane's, not the user's, and each is one number.
 *
 * Thirteen ghosts over six colours is two-to-three ghosts per colour, in order — a discrete ramp
 * rather than an interpolated one, because the reference names six colours and a blend would show
 * eleven.
 */
export const AFTERIMAGE_HUES = Object.freeze([
  Object.freeze({ name: "lime", hex: 0x80ff00, hueDeg: 90 }),
  Object.freeze({ name: "teal", hex: 0x00ffcc, hueDeg: 168 }),
  Object.freeze({ name: "cyan", hex: 0x00d4ff, hueDeg: 190 }),
  Object.freeze({ name: "blue", hex: 0x0033ff, hueDeg: 228 }),
  Object.freeze({ name: "violet", hex: 0x9900ff, hueDeg: 276 }),
  Object.freeze({ name: "magenta", hex: 0xff00cc, hueDeg: 312 }),
]);

/* ══════════════════════════ The colour engine, and the lesson it is built around ══════════════════════════ */

/**
 * ⚠⚠ THE PIXI COLOURMATRIX CHAINED-MULTIPLY TRAP, which is why this file carries an emulator at all.
 *
 * Sequencer's `.filter("ColorMatrix", {...})` hands each key to PIXI as `super[key](value, true)` —
 * the `true` is PIXI's `multiply` flag (module `sequencer/dist/sequencer.js`, class
 * `ColorMatrixFilter#setValue`). PIXI then composes `out = existing · new`
 * (`@pixi/filter-color-matrix` 7.4.3, `_loadMatrix` → `_multiply`), and a 5×4 colour matrix acting on
 * a pixel means `out(c) = existing(new(c))`. **The LATER key is applied to the pixel FIRST.** The
 * object literal therefore reads backwards from the operation order, and two things follow that
 * naive hue arithmetic gets wrong:
 *
 *   1. ORDER IS LOAD-BEARING. `{tint, greyscale}` composes to TINT·GREY — grey the pixel, then paint
 *      it — which is a duotone. `{greyscale, tint}` composes to GREY·TINT — paint, then average the
 *      channels back together — which is a GREY IMAGE. Measured both ways in the derivation below;
 *      the wrong order returns hue "none" on every input.
 *   2. A HUE ROTATION CANNOT COLOUR A GREY PIXEL. PIXI's `hue()` is a rotation of the RGB cube about
 *      its neutral axis, so it moves chroma that is already there and creates none. Measured: a
 *      mid-grey pixel through `{hue: 90, saturate: 1}` comes back (127.5, 127.5, 127.5) — unchanged.
 *      A ramp built as "rotate the token's art to lime" therefore draws NOTHING on any figure whose
 *      art is desaturated, and something different on every figure whose art is not. That is the
 *      whole reason the six colours below are applied as a GREYSCALE-THEN-TINT duotone: the output
 *      hue is then a property of the ramp and not of whose portrait is moving.
 *
 * So the six matrices are derived against measured output rather than asserted from hue maths, and
 * the emulator that measures them is exported so the keeper can hold it against the LIVE engine's
 * own filter and fail if PIXI, Sequencer or Foundry ever moves underneath it.
 */

/** PIXI's identity colour matrix. */
const CM_IDENTITY = Object.freeze([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]);

/**
 * PIXI `_multiply(out, a, b)` — and ⚠⚠ THE ALIAS IS THE POINT, not an implementation detail.
 *
 * `_loadMatrix` calls `this._multiply(newMatrix, this.uniforms.m, matrix)` with `newMatrix === matrix`
 * (@pixi/filter-color-matrix 7.4.3): **`out` and `b` are the same array.** `_multiply` then writes its
 * twenty terms in order while still reading `b`, so every term after the fifth reads columns that its
 * own earlier terms have already overwritten. THAT is the chained-multiply aliasing this codebase has
 * on record, and it is not a rounding artefact — measured on the live engine, the reversed key order
 * comes back with three DIFFERENT rows (0.1673/0.3333, 0.0558/0.4444, 0.0744/0.2593) where honest
 * matrix algebra says all three should be identical.
 *
 * The alias cancels exactly when `a` is DIAGONAL, because then every clobbered cross-term was being
 * multiplied by zero — which is why the shipped order (`{tint, greyscale}`, so `a` = the tint's
 * diagonal) composes to the clean duotone and the reversed one does not. That is a property of the
 * chosen order, not a lucky escape, and the keeper pins both halves of it.
 *
 * So this reproduces the alias rather than the algebra: `o` starts as a copy of `b` and is written
 * through in the engine's own order. The returned matrix acts as a(b(pixel)) only in the diagonal
 * case; in every other case it is whatever the engine actually produces, which is the number that
 * matters. Pure.
 */
export function colorMatrixMultiply(a, b) {
  const o = b.slice();   // ⚠ out === b in the engine; the copy makes the alias explicit, not absent
  o[0] = a[0] * o[0] + a[1] * o[5] + a[2] * o[10] + a[3] * o[15];
  o[1] = a[0] * o[1] + a[1] * o[6] + a[2] * o[11] + a[3] * o[16];
  o[2] = a[0] * o[2] + a[1] * o[7] + a[2] * o[12] + a[3] * o[17];
  o[3] = a[0] * o[3] + a[1] * o[8] + a[2] * o[13] + a[3] * o[18];
  o[4] = a[0] * o[4] + a[1] * o[9] + a[2] * o[14] + a[3] * o[19] + a[4];
  o[5] = a[5] * o[0] + a[6] * o[5] + a[7] * o[10] + a[8] * o[15];
  o[6] = a[5] * o[1] + a[6] * o[6] + a[7] * o[11] + a[8] * o[16];
  o[7] = a[5] * o[2] + a[6] * o[7] + a[7] * o[12] + a[8] * o[17];
  o[8] = a[5] * o[3] + a[6] * o[8] + a[7] * o[13] + a[8] * o[18];
  o[9] = a[5] * o[4] + a[6] * o[9] + a[7] * o[14] + a[8] * o[19] + a[9];
  o[10] = a[10] * o[0] + a[11] * o[5] + a[12] * o[10] + a[13] * o[15];
  o[11] = a[10] * o[1] + a[11] * o[6] + a[12] * o[11] + a[13] * o[16];
  o[12] = a[10] * o[2] + a[11] * o[7] + a[12] * o[12] + a[13] * o[17];
  o[13] = a[10] * o[3] + a[11] * o[8] + a[12] * o[13] + a[13] * o[18];
  o[14] = a[10] * o[4] + a[11] * o[9] + a[12] * o[14] + a[13] * o[19] + a[14];
  o[15] = a[15] * o[0] + a[16] * o[5] + a[17] * o[10] + a[18] * o[15];
  o[16] = a[15] * o[1] + a[16] * o[6] + a[17] * o[11] + a[18] * o[16];
  o[17] = a[15] * o[2] + a[16] * o[7] + a[17] * o[12] + a[18] * o[17];
  o[18] = a[15] * o[3] + a[16] * o[8] + a[17] * o[13] + a[18] * o[18];
  o[19] = a[15] * o[4] + a[16] * o[9] + a[17] * o[14] + a[18] * o[19] + a[19];
  return o;
}

/** PIXI `_colorMatrix`: the four offset terms are divided by 255 on every multiply. Pure. */
function colorMatrixNormalize(m) {
  const o = m.slice();
  o[4] /= 255; o[9] /= 255; o[14] /= 255; o[19] /= 255;
  return o;
}

/** PIXI `greyscale(scale)` — all-`scale` rows, i.e. a SUM unless scale is 1/3. Pure. */
export function greyscaleMatrix(scale) {
  const s = Number(scale) || 0;
  return [s, s, s, 0, 0, s, s, s, 0, 0, s, s, s, 0, 0, 0, 0, 0, 1, 0];
}

/** PIXI `tint(hex)` — the three channel scales on the diagonal. Pure. */
export function tintMatrix(hex) {
  const h = Number(hex) || 0;
  const r = ((h >> 16) & 255) / 255;
  const g = ((h >> 8) & 255) / 255;
  const b = (h & 255) / 255;
  return [r, 0, 0, 0, 0, 0, g, 0, 0, 0, 0, 0, b, 0, 0, 0, 0, 0, 1, 0];
}

/**
 * THE EMULATOR. Compose a Sequencer ColorMatrix option object exactly as the engine will, in the
 * object's own key order, every op multiplied. Returns the 20-number matrix the shader would get.
 * Pure — this is the thing the keeper holds against the live filter.
 */
export function pixiColorMatrixOf(ops = {}) {
  let m = CM_IDENTITY.slice();
  for (const [key, value] of Object.entries(ops)) {
    if (value === undefined || value === null) continue;
    let op = null;
    if (key === "greyscale") op = greyscaleMatrix(value);
    else if (key === "tint") op = tintMatrix(value);
    else throw new Error(`${SCOPE} | afterimage: no emulation for ColorMatrix op "${key}"`);
    m = colorMatrixNormalize(colorMatrixMultiply(m, op));
  }
  return m;
}

/** Put one linear RGB triple (0-1) through a colour matrix. The measurement instrument. Pure. */
export function colorMatrixApply(m, rgb) {
  const [r, g, b] = rgb;
  return [
    m[0] * r + m[1] * g + m[2] * b + m[4],
    m[5] * r + m[6] * g + m[7] * b + m[9],
    m[10] * r + m[11] * g + m[12] * b + m[14],
  ];
}

/**
 * The hue angle of an RGB triple, or null for a neutral. The instrument's readout. Pure.
 *
 * ⚠ NEUTRAL IS HALF AN 8-BIT STEP, not a float epsilon. A live PIXI hue rotation returns a grey pixel
 * with about 1e-8 of channel spread on it — a difference no screen can show and no viewer can see —
 * and a 1e-9 threshold reads that dust as a confident hue (measured: 216.5° off a pixel that is
 * (0.5, 0.5, 0.5) to four decimal places). Anything under half of one 255th is the same pixel.
 */
const HUE_NEUTRAL_EPSILON = 0.5 / 255;
export function hueOfRgb(rgb) {
  const [r, g, b] = rgb;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d < HUE_NEUTRAL_EPSILON) return null;
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
}

/* ══════════════════════════ The pure half — the ramp ══════════════════════════ */

/**
 * WHICH OF THE SIX a ghost wears, by its index in the trail — and the ramp SPANS the trail.
 *
 * ⭐ MEASURED (the 52.5 s showcase frame): eleven copies on screen walk lime→violet across the WHOLE
 * line — the ramp is stretched over the trail's full length, however long the drag was, not wrapped
 * every thirteen. So when the caller knows the trail's total the slot is the index's FRACTION of it;
 * a caller with no total (an index-only question) falls back to wrapping at `ghostCap`, the reference
 * count. Pure.
 */
export function ghostHueFor(index, total = null) {
  const hues = AFTERIMAGE_HUES;
  const t = Number(total);
  if (Number.isFinite(t) && t > 1) {
    const i = Math.max(0, Math.min(t - 1, Number(index) || 0));
    return hues[Math.min(hues.length - 1, Math.floor((i / t) * hues.length))];
  }
  const cap = AFTERIMAGE.ghostCap;
  const i = ((Number(index) || 0) % cap + cap) % cap;
  const per = cap / hues.length;
  return hues[Math.min(hues.length - 1, Math.floor(i / per))];
}

/**
 * THE FILTER OPTIONS for one ghost — and the key order IS the operation order, backwards.
 * `tint` first in the literal so it is applied to the pixel LAST; `greyscale` second so it is applied
 * FIRST. See the trap note above; reversing these two keys returns a grey silhouette. Pure.
 */
export function ghostFilterOpsFor(index, total = null) {
  const ops = { tint: ghostHueFor(index, total).hex };
  if (AFTERIMAGE.ghostGreyscale !== null) ops.greyscale = AFTERIMAGE.ghostGreyscale;
  return ops;
}

/** The composed matrix one ghost is drawn through. Pure. */
export function ghostColorMatrixFor(index, total = null) {
  return pixiColorMatrixOf(ghostFilterOpsFor(index, total));
}

/**
 * WHAT ONE GHOST ACTUALLY COMES OUT AS, for a given input pixel — the measurement the six colours are
 * derived against rather than asserted from. Returns the output triple and its hue. Pure.
 */
export function ghostMeasuredOutput(index, rgb = [0.5, 0.5, 0.5], total = null) {
  const out = colorMatrixApply(ghostColorMatrixFor(index, total), rgb);
  return { rgb: out, hueDeg: hueOfRgb(out) };
}

/**
 * HOW LONG ONE GHOST'S OWN FADE RUNS during the unzip, lerped front-to-back across the trail — so
 * the wave reads as motion rather than a synchronized blink. Index-fraction of the trail's total
 * when known; the reference count otherwise. Pure.
 */
export function ghostTeardownMsFor(index, total = null) {
  const t0 = Number(total);
  const span = Number.isFinite(t0) && t0 > 1 ? t0 : AFTERIMAGE.ghostCap;
  const i = Math.max(0, Math.min(span - 1, Number(index) || 0));
  const t = span <= 1 ? 0 : i / (span - 1);
  return Math.round(AFTERIMAGE.ghostTeardownMinMs
    + t * (AFTERIMAGE.ghostTeardownMaxMs - AFTERIMAGE.ghostTeardownMinMs));
}

/**
 * ⭐ THE SETTLE-THEN-UNZIP SCHEDULE — every copy's whole life, resolved before anything is drawn
 * (standard §D/11, one anchored ladder). NOTHING fades while the figure is still moving: copy i's
 * fade begins at settle + delay + i × stagger (measured off the showcase, spec block), runs its own
 * lerped fade, and the death is baked into the copy's DURATION at creation — no second timer, no
 * end-by-name choreography, nothing to cancel but the plant timers themselves.
 *
 * The guard against a plant landing after its own fade-start cannot fire on an honest schedule
 * (plants land within the movement, fades start after it) but a derived duration estimate can be
 * short — so the fade-start is floored at the plant's own landing. Pure.
 */
export function unzipScheduleFor(plants = [], { durationMs = 0 } = {}) {
  const total = plants.length;
  const settle = Math.max(0, Number(durationMs) || 0) + AFTERIMAGE.settleDelayMs;
  return plants.map((p, i) => {
    const fadeMs = ghostTeardownMsFor(i, total);
    const fadeStartMs = Math.max(p.atMs, Math.round(settle + i * AFTERIMAGE.unzipStaggerMs));
    return { ...p, fadeMs, fadeStartMs, dieAtMs: fadeStartMs + fadeMs };
  });
}

/* ══════════════════════════ The pure half — the path ══════════════════════════ */

/**
 * THE REAL PATH, as a polyline of token CENTRES.
 *
 * ⭐ THE CORNERS COME FROM THE ENGINE, NOT FROM A GUESS. Foundry v13+ hands `moveToken` the movement's
 * own `passed.waypoints` (client/documents/token.mjs), which is the sequence of points the figure
 * actually traversed — so a path that turns is a path that turns here too, and nothing interpolates a
 * straight line between the ends. The origin is prepended because `passed` describes where it WENT,
 * not where it started.
 *
 * Waypoints are token TOP-LEFT positions like every stored token x/y, so each is offset by half the
 * figure's own footprint. Consecutive duplicates are dropped: a zero-length segment is not a corner.
 * Pure — it takes plain objects and two numbers, never a canvas.
 */
export function pathPointsOf(movement, { gridPx = 100, width = 1, height = 1 } = {}) {
  const g = Number(gridPx) > 0 ? Number(gridPx) : 100;
  const raw = [];
  const push = (w) => {
    if (!w) return;
    const x = Number(w.x);
    const y = Number(w.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const wSq = Number(w.width) > 0 ? Number(w.width) : (Number(width) > 0 ? Number(width) : 1);
    const hSq = Number(w.height) > 0 ? Number(w.height) : (Number(height) > 0 ? Number(height) : 1);
    raw.push({ x: x + (wSq * g) / 2, y: y + (hSq * g) / 2 });
  };
  push(movement?.origin);
  for (const w of movement?.passed?.waypoints ?? []) push(w);
  const out = [];
  for (const p of raw) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
    out.push(p);
  }
  return out;
}

/** The arc length of a polyline, in pixels. Pure. */
export function pathLengthPx(points = []) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

/** The point at a given arc length along a polyline — the corner-following sampler. Pure. */
export function pointAtArc(points = [], arcPx = 0) {
  if (!points.length) return null;
  if (points.length === 1) return { ...points[0] };
  let remaining = Math.max(0, arcPx);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg <= 0) continue;
    if (remaining <= seg) {
      const t = remaining / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= seg;
  }
  return { ...points[points.length - 1] };
}

/**
 * WHERE AND WHEN EVERY COPY IS PLANTED — the whole trail, resolved before anything is drawn.
 *
 * ⏱ ONE ANCHORED SCHEDULE (standard §D/11): every plant carries an absolute offset from the movement's
 * start, so a late timer cannot push the ones after it. Time along the path is taken as proportional
 * to arc length — the engine animates a move at a constant speed, so arc fraction IS time fraction —
 * which is what lets a pure function answer "when" without a canvas.
 *
 * BOTH GATES, as the spec block records: a plant needs BOTH the measured spacing AND the measured
 * cadence since the previous one. The first plant is at the path's start.
 *
 * ⛔ THE WHOLE PATH IS PLANTED (user ruling 2026-08-28): the list runs to the end of the drag, not to
 * one trail-length — a long continuous movement keeps spitting copies, and the rolling window behind
 * the mover is kept twelve-wide by the live cap and each copy's own lifetime, not by cutting the list
 * short. `cap` here is only the plant SAFETY RAIL (spec block), bounding queued timers.
 *
 * @param {{x:number,y:number}[]} points   token centres, in world pixels
 * @param {object} opts                    gridPx · durationMs · cap · cadenceMs · spacingSquares
 * @returns {{x:number,y:number,atMs:number,index:number,arcPx:number}[]}
 */
export function ghostPlantsFor(points = [], {
  gridPx = 100,
  durationMs = 0,
  cap = AFTERIMAGE.plantSafetyCap,
  cadenceMs = AFTERIMAGE.ghostCadenceMs,
  spacingSquares = AFTERIMAGE.ghostSpacingSquares,
} = {}) {
  const g = Number(gridPx) > 0 ? Number(gridPx) : 100;
  const total = pathLengthPx(points);
  if (!(total > 0)) return [];
  const spacingPx = Math.max(1, spacingSquares * g);
  const dur = Number(durationMs) > 0 ? Number(durationMs) : 0;
  const msPerPx = dur > 0 ? dur / total : 0;
  const plants = [];
  let arc = 0;
  while (plants.length < cap) {
    const p = pointAtArc(points, arc);
    if (!p) break;
    plants.push({ x: p.x, y: p.y, arcPx: arc, atMs: Math.round(arc * msPerPx), index: plants.length });
    // The next plant must clear BOTH gates: one spacing of distance, and one cadence of time. With a
    // known duration the cadence is an arc distance too, so the step is simply the larger of the two.
    const cadenceArcPx = msPerPx > 0 ? cadenceMs / msPerPx : 0;
    const step = AFTERIMAGE.requireBothGates ? Math.max(spacingPx, cadenceArcPx) : spacingPx;
    if (!(step > 0)) break;
    arc += step;
    if (arc > total + 1e-6) break;
  }
  return plants;
}

/* ══════════════════════════ The pure half — the grade ══════════════════════════ */

/**
 * THE GRADE'S THREE CHANNEL SCALES at a given moment, plus which phase it is in.
 *
 * The whole arithmetic of the pass in one pure function: ramp linearly from neutral to the measured
 * target over `gradeRampMs`, hold it for `gradeHoldMs`, release back to neutral over
 * `gradeReleaseMs`, and read exactly neutral before and after. Green is held at 1 throughout, which
 * is the measurement — the pass takes red and blue AWAY rather than adding green.
 *
 * In the shipped movement-tied pass the hold has no fixed length: the function is asked with
 * `held: true` while the pass is up and the phase stays "hold" until the release re-bases the
 * clock. The fixed-hold arithmetic remains for the explicit `sustained: false` burst ladder. Pure.
 */
export function gradeScalesAt(elapsedMs, { held = false } = {}) {
  const t = Math.max(0, Number(elapsedMs) || 0);
  const ramp = AFTERIMAGE.gradeRampMs;
  const hold = AFTERIMAGE.gradeHoldMs;
  const release = AFTERIMAGE.gradeReleaseMs;
  const at = (f) => ({
    r: 1 + (AFTERIMAGE.gradeRedScale - 1) * f,
    g: 1 + (AFTERIMAGE.gradeGreenScale - 1) * f,
    b: 1 + (AFTERIMAGE.gradeBlueScale - 1) * f,
    progress: f,
  });
  if (t < ramp) return { ...at(ramp > 0 ? t / ramp : 1), phase: "ramp" };
  if (held) return { ...at(1), phase: "hold" };
  if (t < ramp + hold) return { ...at(1), phase: "hold" };
  if (t < ramp + hold + release) {
    const f = release > 0 ? 1 - (t - ramp - hold) / release : 0;
    return { ...at(f), phase: "release" };
  }
  return { ...at(0), phase: "done" };
}

/** How long the whole pass lasts in its shipped (burst) form. Pure. */
export function gradeLadderMs() {
  return AFTERIMAGE.gradeRampMs + AFTERIMAGE.gradeHoldMs + AFTERIMAGE.gradeReleaseMs;
}

/** The colour matrix for a set of channel scales — a plain diagonal, set outright, never multiplied. */
export function gradeMatrixOf({ r = 1, g = 1, b = 1 } = {}) {
  return [r, 0, 0, 0, 0, 0, g, 0, 0, 0, 0, 0, b, 0, 0, 0, 0, 0, 1, 0];
}

/* ══════════════════════════ The pure half — the gate ══════════════════════════ */

/**
 * IS THIS FIGURE'S BOOST SWITCHED ON RIGHT NOW?
 *
 * ⛔ THE MECHANISM IS READ, NEVER MIRRORED. `isActivatedInitiativeBoost` (mech/speedware.js) says what
 * KIND of implant it is — Activatable, Characteristic payload, initiative above zero — and
 * `EffectActive` is the base system's own switch, the same field the base payload sum and the
 * consumable timer read. There is no parallel flag to go stale, and the printed five turns need no
 * handling here: when the tick expires the implant it flips `EffectActive` off and this returns
 * false on the very next question. Pure.
 */
export function armedImplantOf(actor) {
  for (const item of actor?.items ?? []) {
    if (!isActivatedInitiativeBoost(item)) continue;
    if (item.system?.EffectActive === true) return item;
  }
  return null;
}

/** The gate, as a boolean. Pure. */
export function afterimageArmedFor(actor) {
  return armedImplantOf(actor) !== null;
}

/** The engine name one copy is stamped with. Encodes the movement so a sweep can find its trail. */
export function afterimageFxNameFor(moveId, index) {
  return `${AFTERIMAGE_NAME}.${moveId}.${index}`;
}

/* ══════════════════════════ The capture seam ══════════════════════════ */

/**
 * Run the trail's ladder against a compressed clock so a keeper can watch a two-and-a-half-second
 * trail inside one assertion. Applied to the plant offsets and the transient durations only. Armed by
 * nothing that ships; null restores the shipped clock. (Standard §I/25 — applied FIRST in the chain.)
 */
let _timeScale = null;
export function _setAfterimageTimeScale(scale) {
  _timeScale = Number.isFinite(scale) && scale > 0 ? Number(scale) : null;
  return _timeScale;
}
function _scaled(ms) {
  return _timeScale === null ? ms : Math.max(0, Math.round(ms * _timeScale));
}

/* ══════════════════════════ The census ══════════════════════════ */

/** Copies QUEUED but not yet created by the engine — counted against the scene cap. */
let _pending = 0;
export function pendingAfterimageFx() { return _pending; }

/**
 * ⛔ NO RE-ISSUE RECONCILER, ON PURPOSE — and the difference from the extraction arrival is the point.
 * That element holds station until a referee sends it away, so an effect that ends for a reason nobody
 * caused has to come back. A movement echo is transient by construction: every copy's death is baked
 * into its own duration at creation (the unzip schedule), so a canvas rebuild mid-trail simply loses a
 * trail that was about to go anyway, and redrawing one would be redrawing a walk that already
 * finished. `canvasTearDown` therefore sweeps and nothing rebuilds — which is also why this file
 * needs no intentional-end register.
 */

/**
 * EVERY COPY ALIVE ON THIS CLIENT RIGHT NOW, oldest first — a query of the engine rather than a ledger
 * of our own, for the reason the burning ground's census gives: a tally we kept would drift the
 * instant an effect ended for a reason we did not cause.
 */
export function liveAfterimageFx() {
  try {
    const list = globalThis.Sequencer?.EffectManager?.getEffects?.({ name: `${AFTERIMAGE_NAME}.*` }) ?? [];
    return [...list].sort((a, b) => (a?.data?.creationTimestamp ?? 0) - (b?.data?.creationTimestamp ?? 0));
  } catch (_e) {
    return [];
  }
}

/** End one copy by name, on purpose. `false` = do not push the end: every client owns its own copy. */
function endAfterimageFx(name) {
  try {
    globalThis.Sequencer?.EffectManager?.endEffects?.({ name }, false)
      ?.catch?.((err) => console.warn(`${SCOPE} | movement echo end failed`, err));
  } catch (err) {
    console.warn(`${SCOPE} | movement echo end failed`, err);
  }
}

/**
 * THE SCENE CAP, enforced in one place by ending the OLDEST — which for this element is also the
 * look: the trail is meant to unravel from its tail, so eviction and teardown are the same gesture.
 * The PENDING tally is part of the count, because a copy that has been queued is invisible to the
 * census until the engine's own play resolves. Returns how many it ended, by value.
 */
export function evictForRoom(wanting = 0) {
  try {
    const live = liveAfterimageFx();
    const overBy = live.length + _pending + wanting - AFTERIMAGE.maxLive;
    if (overBy <= 0) return 0;
    const names = live.slice(0, Math.min(overBy, live.length)).map((e) => e?.data?.name).filter(Boolean);
    for (const name of names) endAfterimageFx(name);
    return names.length;
  } catch (err) {
    console.warn(`${SCOPE} | movement echo cap failed`, err);
    return 0;
  }
}

/* ══════════════════════════ The drawing half ══════════════════════════ */

/** Timers belonging to trails still being laid, so a teardown cancels the plants that have not landed. */
const _timers = new Set();
function at(ms, verb, fn) {
  const t = setTimeout(() => {
    _timers.delete(t);
    try { fn(); } catch (err) { console.warn(`${SCOPE} | movement echo ${verb} failed`, err); }
  }, _scaled(ms));
  _timers.add(t);
  return t;
}

/**
 * WHAT ONE COPY IS DRAWN FROM — the figure's own texture and its own footprint.
 *
 * Returns a plain description so the whole decision is assertable without a canvas: the source path,
 * the size in grid units, the rotation, and whether the art is mirrored. Null when there is nothing to
 * clone, which is the guard the "database keys" exemption is paid for with.
 */
export function ghostSourceOf(tokenDoc) {
  const src = tokenDoc?.texture?.src;
  if (typeof src !== "string" || !src.length) return null;
  const sx = Number(tokenDoc.texture?.scaleX);
  const sy = Number(tokenDoc.texture?.scaleY);
  const w = Number(tokenDoc.width) > 0 ? Number(tokenDoc.width) : 1;
  const h = Number(tokenDoc.height) > 0 ? Number(tokenDoc.height) : 1;
  return {
    src,
    widthSquares: w * (Number.isFinite(sx) && sx !== 0 ? Math.abs(sx) : 1),
    heightSquares: h * (Number.isFinite(sy) && sy !== 0 ? Math.abs(sy) : 1),
    // A copy is drawn the way the figure is DRAWN, not the way its document is posed: with Lock
    // Rotation on, core keeps the art upright whatever `rotation` says (facing automation still
    // writes the angle), so the copies stay upright too (user report 2026-08-28).
    rotation: tokenDoc.lockRotation === true ? 0 : (Number(tokenDoc.rotation) || 0),
    mirrorX: Number.isFinite(sx) && sx < 0,
    mirrorY: Number.isFinite(sy) && sy < 0,
  };
}

/**
 * Draw one copy. Fire-and-forget; the pending count is released in `finally` (standard §G/21).
 * The copy's DURATION is its whole scheduled life — from its own landing to the end of its unzip
 * fade — so the settle-then-unzip choreography needs no timer beyond the plant's own.
 */
function drawGhost(moveId, plant, source, total) {
  const name = afterimageFxNameFor(moveId, plant.index);
  const seq = new globalThis.Sequence();
  _pending++;
  const fx = seq.effect().name(name).locally()
    .file(source.src)
    .atLocation({ x: plant.x, y: plant.y })
    .size({ width: source.widthSquares, height: source.heightSquares }, { gridUnits: true })
    .rotate(source.rotation)
    .opacity(AFTERIMAGE.ghostOpacity)
    .belowTokens()
    .duration(_scaled(Math.max(1, plant.dieAtMs - plant.atMs)))
    .fadeOut(_scaled(plant.fadeMs));
  if (AFTERIMAGE.ghostFadeInMs > 0) fx.fadeIn(_scaled(AFTERIMAGE.ghostFadeInMs));
  if (source.mirrorX) fx.mirrorX();
  if (source.mirrorY) fx.mirrorY();
  fx.filter("ColorMatrix", ghostFilterOpsFor(plant.index, total));
  seq.play()
    .catch((err) => console.warn(`${SCOPE} | movement echo copy failed`, err))
    .finally(() => { _pending = Math.max(0, _pending - 1); });
  return name;
}

/**
 * THE ONCE-PER-MOVEMENT GATE — the one idiom (standard, "the once-per-payload gate"). Every question
 * that can refuse the trail is asked HERE, once, into a plan; the ladder below reads the plan and asks
 * nothing. Issue policy: **per-round-capped, rolling** — the plant list runs the whole path (bounded
 * only by the safety rail), and the LIVE bound is enforced per plant at draw time, oldest-out, so the
 * window rolls behind the mover instead of the list being cut short (user ruling 2026-08-28).
 *
 * Returned by value, in the same shape whether it drew everything or nothing, so a keeper can assert
 * the whole mechanism without a screenshot.
 */
export function planTrailFor(tokenDoc, movement, { gridPx = null } = {}) {
  const out = { queued: [], plants: [], skipped: null };
  if (!sequencerActive()) { out.skipped = "engine"; return out; }
  if (!combatFxEnabled()) { out.skipped = "disabled"; return out; }
  if (!afterimageArmedFor(tokenDoc?.actor)) { out.skipped = "unarmed"; return out; }
  const source = ghostSourceOf(tokenDoc);
  if (!source) { out.skipped = "art"; return out; }
  const g = Number(gridPx) > 0 ? Number(gridPx) : (Number(canvas?.dimensions?.size) || 100);
  const points = pathPointsOf(movement, {
    gridPx: g, width: tokenDoc?.width ?? 1, height: tokenDoc?.height ?? 1,
  });
  if (points.length < 2) { out.skipped = "path"; return out; }
  const durationMs = movementDurationMs(tokenDoc, points, g);
  const plants = ghostPlantsFor(points, { gridPx: g, durationMs, cap: AFTERIMAGE.plantSafetyCap });
  if (!plants.length) { out.skipped = "path"; return out; }
  out.plants = unzipScheduleFor(plants, { durationMs });
  out.source = source;
  out.durationMs = durationMs;
  return out;
}

/**
 * HOW LONG THE FIGURE TAKES TO WALK THE PATH.
 *
 * The engine's own animation duration when it has resolved one, because that is the truth the eye
 * will see; otherwise derived from the path and `CONFIG.Token.movement.defaultSpeed` (grid spaces per
 * second, 6 by default), which is the same number the engine would have used. Never zero: a zero
 * would collapse the whole trail onto the first frame.
 */
export function movementDurationMs(tokenDoc, points, gridPx) {
  const live = Number(tokenDoc?.movement?.animation?.duration);
  if (Number.isFinite(live) && live > 0) return live;
  const speed = Number(globalThis.CONFIG?.Token?.movement?.defaultSpeed);
  const spaces = pathLengthPx(points) / (Number(gridPx) > 0 ? Number(gridPx) : 100);
  const perSecond = Number.isFinite(speed) && speed > 0 ? speed : 6;
  return Math.max(1, Math.round((spaces / perSecond) * 1000));
}

/**
 * LAY ONE TRAIL on this client. Returns what it queued, by value.
 *
 * Nothing here awaits anything (standard §D/13): the plants go on one anchored ladder of timers and
 * each draw is fire-and-forget with a `.catch` naming the verb.
 */
export function layTrail(tokenDoc, movement, { gridPx = null, moveId = null } = {}) {
  const plan = planTrailFor(tokenDoc, movement, { gridPx });
  if (plan.skipped) return plan;
  const id = moveId ?? movement?.id ?? foundry.utils.randomID();
  // Room is made PER PLANT, at its own draw moment. Under the settle-then-unzip model the live cap
  // is a safety rail (spec block) that an honest drag never reaches — the whole trail is MEANT to
  // stand until the settle — so this can only fire on a pathological pile-up.
  const total = plan.plants.length;
  for (const plant of plan.plants) {
    at(plant.atMs, "copy", () => { evictForRoom(1); drawGhost(id, plant, plan.source, total); });
    plan.queued.push(plant.index);
  }
  // ⭐ THE PASS RIDES THE MOVEMENT (measured — spec block): it comes up as the trail starts being
  // laid, holds while a pass is already up (a chained move never restarts the ramp, it just pushes
  // the release out), and lets go on the schedule as the unzip runs out.
  if (!_grade?.held) startSceneGrade();
  _scheduleGradeRelease(gradeReleaseAtMsFor(plan));
  return plan;
}

/** Take every copy down on this client, by name. The scene is going, or the client is. */
export function clearAfterimageFx() {
  for (const t of _timers) { try { clearTimeout(t); } catch (_e) { /* already fired */ } }
  _timers.clear();
  for (const effect of liveAfterimageFx()) {
    const name = effect?.data?.name;
    if (name) endAfterimageFx(name);
  }
}

/* ══════════════════════════ The scene grade ══════════════════════════ */

/**
 * THE PASS ITSELF — a PIXI colour matrix on the scene's own group, driven by the engine's ticker.
 *
 * ⭐ WHY NOT THROUGH SEQUENCER. Sequencer's filter machinery paints ONE SPRITE; the reference grades
 * the whole picture. The scene group already exists and already renders, so the pass is the one
 * filter appended to it — no sprite, no asset, no key. The matrix is SET rather than multiplied, so
 * none of the chained-multiply arithmetic above applies to it: it is a plain per-channel diagonal and
 * the ramp moves the three numbers on it.
 *
 * ⛔ IT WRITES NOTHING AND OWNS ONLY WHAT IT ADDED: the filter array is copied, ours appended, and
 * removal is by object identity — so a scene that already carried filters keeps them, and two passes
 * cannot leak into one another.
 */
let _grade = null;

/** The group the pass is hung on: the SCENE, not the interface. Returns null when there is no canvas. */
function gradeTarget() {
  const env = canvas?.environment;
  if (env && Array.isArray(env.filters ?? [])) return env;
  const stage = canvas?.stage;
  if (stage) return stage;
  return null;
}

function detachGrade() {
  const g = _grade;
  _grade = null;
  if (!g) return false;
  try { if (g.tickerFn) canvas?.app?.ticker?.remove?.(g.tickerFn); } catch (_e) { /* ticker gone */ }
  try {
    const target = g.target;
    if (target && Array.isArray(target.filters)) {
      const rest = target.filters.filter((f) => f !== g.filter);
      target.filters = rest.length ? rest : null;
    }
  } catch (err) {
    console.warn(`${SCOPE} | scene pass detach failed`, err);
  }
  return true;
}

/**
 * START THE PASS. Idempotent by replacement: a second activation while one is running restarts the
 * clock rather than stacking two filters on one scene. Returns what it did, by value.
 */
export function startSceneGrade({ sustained = null } = {}) {
  const out = { started: false, skipped: null };
  if (!combatFxEnabled()) { out.skipped = "disabled"; return out; }
  if (!canvas?.ready) { out.skipped = "canvas"; return out; }
  const target = gradeTarget();
  if (!target) { out.skipped = "canvas"; return out; }
  const Filter = globalThis.PIXI?.ColorMatrixFilter;
  if (typeof Filter !== "function") { out.skipped = "engine"; return out; }
  detachGrade();

  let filter;
  try { filter = new Filter(); } catch (err) {
    console.warn(`${SCOPE} | scene pass unavailable`, err);
    out.skipped = "engine";
    return out;
  }
  // Held by default: the shipped pass is movement-tied — started as a trail begins and released by
  // the schedule (gradeReleaseAtMsFor) — so the caller that wants the fixed 5.6 s burst ladder asks
  // for it explicitly with sustained: false.
  const held = sustained === null ? true : !!sustained;
  const startedAt = performance.now();
  const record = { filter, target, held, startedAt, tickerFn: null };
  const tick = () => {
    try {
      const elapsed = (performance.now() - record.startedAt) / (_timeScale === null ? 1 : _timeScale);
      const scales = gradeScalesAt(elapsed, { held: record.held });
      filter.uniforms.m = new Float32Array(gradeMatrixOf(scales));
      if (scales.phase === "done") detachGrade();
    } catch (err) {
      console.warn(`${SCOPE} | scene pass tick failed`, err);
      detachGrade();
    }
  };
  record.tickerFn = tick;
  // Recorded BEFORE the attach, so a half-finished attach is something `detachGrade` can undo — the
  // filter is on the group by then and a bare `return` would leak it onto the scene until a reload.
  _grade = record;
  try {
    filter.uniforms.m = new Float32Array(gradeMatrixOf(gradeScalesAt(0, { held })));
    target.filters = [...(target.filters ?? []), filter];
    canvas.app.ticker.add(tick);
  } catch (err) {
    console.warn(`${SCOPE} | scene pass attach failed`, err);
    detachGrade();
    out.skipped = "engine";
    return out;
  }
  out.started = true;
  return out;
}

/**
 * RELEASE THE PASS. In the shipped burst form the ticker already does this at its own end; this is
 * what the SUSTAINED alternative needs — the implant switching off is the release — and what a canvas
 * teardown needs. Held passes are released by re-basing the clock to the start of the release phase,
 * so the picture eases out rather than snapping.
 */
export function releaseSceneGrade({ immediate = false } = {}) {
  if (!_grade) return { released: false, skipped: "idle" };
  if (immediate || !_grade.held) { detachGrade(); return { released: true, skipped: null }; }
  // Re-based in the SAME units the tick reads (real ms scaled by the capture seam), and FROM THE
  // CURRENT PROGRESS: a pass released mid-ramp (a one-square move ends before 1.6 s) eases out from
  // wherever it reached — the old full-grade re-base would have flashed it TO full first. At p = 1
  // this is exactly the old arithmetic.
  const scale = _timeScale === null ? 1 : _timeScale;
  const elapsed = (performance.now() - _grade.startedAt) / scale;
  const p = gradeScalesAt(elapsed, { held: true }).progress;
  _grade.held = false;
  _grade.startedAt = performance.now()
    - (AFTERIMAGE.gradeRampMs + AFTERIMAGE.gradeHoldMs + AFTERIMAGE.gradeReleaseMs * (1 - p)) * scale;
  return { released: true, skipped: null };
}

/** The one pending movement-release timer: a new trail while the pass is up pushes the release out. */
let _gradeReleaseTimer = null;
function _scheduleGradeRelease(afterMs) {
  if (_gradeReleaseTimer) {
    try { clearTimeout(_gradeReleaseTimer); } catch (_e) { /* already fired */ }
    _timers.delete(_gradeReleaseTimer);
  }
  _gradeReleaseTimer = at(afterMs, "pass release", () => { _gradeReleaseTimer = null; releaseSceneGrade(); });
}

/** Is a pass running on this client right now, and in which phase? For a macro that wants to ask. */
export function sceneGradeState() {
  if (!_grade) return null;
  const elapsed = (performance.now() - _grade.startedAt) / (_timeScale === null ? 1 : _timeScale);
  const scales = gradeScalesAt(elapsed, { held: _grade.held });
  return { held: _grade.held, elapsedMs: Math.round(elapsed), ...scales };
}

/* ══════════════════════════ The public surface ══════════════════════════ */

/** What this element is doing on this client, by value. */
export function afterimageState() {
  return {
    live: liveAfterimageFx().length,
    pending: pendingAfterimageFx(),
    grade: sceneGradeState(),
  };
}

/**
 * WHEN THE MOVEMENT'S PASS LETS GO, in ms from the movement's start — the release begins as the
 * unzip runs out: settle + the settle beat + one stagger per copy. Measured against the video:
 * 3900 + 200 + 13×20 = 4360 predicts the observed ~53.3 s release onset of a 49.0 s move. Pure.
 */
export function gradeReleaseAtMsFor(plan) {
  const total = plan?.plants?.length ?? 0;
  return Math.round((Number(plan?.durationMs) || 0) + AFTERIMAGE.settleDelayMs
    + total * AFTERIMAGE.unzipStaggerMs);
}

/**
 * Does this activation belong on THIS client's screen? The scene test, and nothing else: the trigger
 * is already broadcast, the draw is already local, and there is no referee gate because there is no
 * write. A figure activating three scenes away does not grade the room you are looking at.
 */
export function activationVisibleHere(actor) {
  const sceneId = canvas?.scene?.id;
  if (!sceneId) return false;
  for (const token of actor?.getActiveTokens?.(false, true) ?? []) {
    if ((token?.parent?.id ?? token?.scene?.id) === sceneId) return true;
  }
  return false;
}

/**
 * Hook wiring — called once from the module's ready hook, registered unconditionally like the shot
 * rail and the extraction arrival: the master switch is read per event, so a referee toggling it
 * takes effect immediately with no reload and the listeners are inert while it is off.
 */
export function registerAfterimage() {
  // ⭐ NO SESSION ELECTION AND NO REFEREE GATE, the third instance of the deliberate exemption
  // (module/gm-session-primary.js): every client draws its own copy of a picture nobody wrote down,
  // so electing one client here would mean exactly one viewer saw the trail.
  Hooks.on("moveToken", (tokenDoc, movement) => {
    try { layTrail(tokenDoc, movement); } catch (err) {
      console.warn(`${SCOPE} | movement echo failed`, err);
    }
  });

  // The pass is STARTED by the trail (layTrail — the measured model is movement-tied), so the only
  // thing the base system's own switch drives here is the early let-go: an implant switched OFF
  // mid-pass releases it now rather than on the schedule. Reading the same key mech/consumable.js
  // watches keeps one activation mechanism in the module.
  Hooks.on("updateItem", (item, changes) => {
    try {
      const flipped = foundry.utils.getProperty(changes ?? {}, "system.EffectActive");
      if (flipped !== false) return;
      if (!isActivatedInitiativeBoost(item)) return;
      if (!activationVisibleHere(item.actor)) return;
      releaseSceneGrade();
    } catch (err) {
      console.warn(`${SCOPE} | scene pass trigger failed`, err);
    }
  });

  Hooks.on("canvasTearDown", () => {
    try { clearAfterimageFx(); } catch (_e) { /* canvas already gone */ }
    try { releaseSceneGrade({ immediate: true }); } catch (_e) { /* canvas already gone */ }
  });
}
