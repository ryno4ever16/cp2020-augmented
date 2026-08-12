/**
 * ══════════════ THE MEDICAL-EXTRACTION ARRIVAL SEQUENCE ══════════════
 *
 * A referee marks a rectangle on the ground; an airframe comes down out of frame onto it, holds
 * station over it, four rings go out under it, five figures step off it one after another, and it is
 * STILL THERE when the sequence finishes. A second use of the same control sends it back up.
 *
 * ⛔ THIS DRAWS A PICTURE AND NOTHING ELSE. The five figures are SPRITES, not documents: no actor is
 * created, no token is placed, no region is written, and the scene's own flags are untouched from the
 * first frame to the last (asserted by the keeper, both directions). If a table wants five figures it
 * can then move and roll for, that is a document-creating feature and it belongs to whatever builds
 * non-player figures — the seam is recorded in docs/FX-RAIL.md §8 rather than half-built here.
 *
 * ⭐ WHY IT IS A SEPARATE FILE. Same answer the condition overlays gave: `module/fx/` is the
 * containment boundary, not one file inside it. Every capability question below is asked through the
 * rail's own answers (`sequencerActive`, `fxDbEntryExists`, `fxSoundSrc`), so there is still exactly
 * one adapter to the effects engine; only this element's own table lives here. The referee-facing
 * gesture — the scene-control button and the click-to-place ghost — is `trauma-team-tool.js`, the same
 * split the shot-pattern lane already uses (combat/spread-placement.js beside fx/effects.js).
 *
 * ⭐ NOTHING IS PERSISTED, AND THAT IS THE BARGAIN. The airframe holds station because each client is
 * drawing it, not because anything was written down. The record of what is on station lives in this
 * module's memory on each client, so a scene change and a canvas rebuild are recovered (the reconciler
 * below redraws from the record) while a full reload is not — a reload leaves a clean canvas and the
 * referee places it again. That is the same trade the burning ground and the condition overlays took,
 * and it is what keeps this a presentation rail: no document write, ever.
 *
 * ⭐⭐ THE REDRAW HANGS ON THE ENGINE'S OWN SIGNAL, not on `ready`. Measured on the rig while the
 * condition overlays were built, and it is the same three-beat ladder here:
 *     canvasReady    @ +0 ms     ← the rebuild we need, before this module exists
 *     ready          @ +12 ms    ← where a naive catch-up would run, and queue work at nothing
 *     sequencerReady @ +677 ms   ← where the engine can actually draw
 * `sequencerActive()` is already true at `ready`, so a sweep there does not bail — it queues against an
 * engine that is not up and the work is simply lost. The catch-up is on `sequencerReady`, and it is
 * safe to run repeatedly because the sweep is a RECONCILER.
 */

import {
  sequencerActive, fxDbEntryExists, fxSoundSrc, LIT_SPRITE_ABOVE_LIGHTING,
} from "./effects.js";
import { combatFxEnabled } from "../settings.js";

const SCOPE = "cp2020-augmented";

/** The one prefix every part of the sequence is stamped under, so the census is a query of the engine. */
export const TRAUMA_TEAM_NAME = `${SCOPE}.traumateam`;

/** Socket message types — one channel, dispatched by type, the module's standing relay shape. */
const MSG_LAND = "traumaTeamLand";
const MSG_END = "traumaTeamEnd";

/**
 * ══════════ THE FROZEN SPEC — every number a reviewer might move, with what set it ══════════
 *
 * The SHAPE of the sequence is the reference recording the user described: a marked rectangle that
 * pulses, an airframe that descends and then HOVERS (it never touches down), four rings, five figures
 * one after another, and an ending that leaves the airframe on station. Those five facts are rulings.
 * Every number below is a build-lane pick made against them, each is one constant, and each is listed
 * in docs/FX-RAIL.md §8 so a veto costs one edit.
 *
 * ⏱ THE LADDER IS ONE ANCHORED SCHEDULE, not accumulated waits (standard §D/11): every phase below is
 * an offset from the placement instant, so a late timer cannot push the ones after it. The offsets are
 * absolute for the same reason the fan-out's slot ladder is.
 */
export const TRAUMA_TEAM = Object.freeze({
  /* ── the marked area ── */
  // In grid squares. A 4 × 6 footprint is two figures wide and long enough that an airframe drawn over
  // it reads as an airframe rather than a blob; on this system's 2 m squares that is 8 m × 12 m, which
  // is the order of a real medium lifter. Revert: any two numbers.
  zoneWidthSquares: 4,
  zoneLengthSquares: 6,
  // ⭐ THE PLATE IS SIZED AGAINST ITS OWN INK, NOT ITS FRAME (standard §A/4). Decoded off the installed
  // clip: `ZoningSquare01Out_..._Loop_600x600.webm` is 73 frames at 24 fps (3 042 ms) and its border
  // TRAVELS OUTWARD, reaching **0.893 × 0.895** of its own 600 × 600 frame at its widest. Drawn at the
  // rectangle's own size the border therefore never reaches the corner marks — measured on the rig at
  // 0.73 of the rectangle mid-travel, which is what a first capture showed. So the frame is enlarged by
  // the inverse of that fraction and the pulse now expands out TO the marked boundary, which is also
  // the right reading of an outward zoning marker. Revert: set this to 1.
  zoneInkFraction: 0.893,
  // The four caution marks, one per corner of the rectangle, in grid squares of drawn frame. Their clip
  // carries ink across its whole frame (decoded 1.000 × 1.000), so this is 0.9 squares of actual mark.
  cornerSquares: 0.9,
  zoneOpacity: 0.85,
  cornerOpacity: 0.9,

  /* ── the airframe ── */
  // Drawn as an engine-native SHAPE rather than a sprite, because no airframe art exists anywhere in
  // this module, the base system or the free asset tier (enumerated: 2 061 installed keys, none of an
  // aircraft) and this rail does not source art of its own. What a top-down camera sees of something
  // hanging in the air is its planform and its shadow, so that is what is drawn: a dark rounded body
  // with a lit edge. The asset ask is recorded in docs/FX-RAIL.md §8 — with real art this becomes one
  // `.file()` call and the shape goes.
  airframeWidthSquares: 2.4,
  airframeLengthSquares: 4.6,
  // A lozenge rather than a slab: a rounded planform is what an aerodyne looks like from directly
  // above, and a hard-cornered rectangle read as a hole in the map on the first capture.
  airframeCornerSquares: 0.8,
  airframeFill: 0x0a0d12,
  airframeFillAlpha: 0.72,
  airframeLineWidth: 4,
  airframeLine: 0x37e0c0,
  // How far above the near edge of the rectangle the airframe starts, in grid squares — far enough that
  // it is off any ordinary viewport before it begins to move.
  entryRiseSquares: 8,
  // The airframe is drawn smaller while it is high and reaches full size at station: the one cue a flat
  // camera has for altitude.
  entryScale: 0.55,

  /* ── the ladder, in milliseconds from the placement instant ── */
  zoneAtMs: 0,
  descentAtMs: 900,        // the marker gets a beat to itself before anything moves
  descentMs: 2600,
  hoverAtMs: 3500,         // = descentAtMs + descentMs
  // The station-keeping bob: a small vertical sway, ping-ponged forever, so a stationary airframe still
  // reads as flying rather than as a decal.
  bobSquares: 0.16,
  bobMs: 2400,

  /* ── the rings ── */
  pulseCount: 4,           // RULING: the reference shows four
  pulseFirstAtMs: 3700,    // = hoverAtMs + 200; the first ring goes out as it settles
  // Spaced against the RING'S OWN CLIP rather than picked: each ring runs 2 750 ms, so a 900 ms gap put
  // three on screen at once and read as churn instead of as four waves. At 1 200 ms a ring is a little
  // over half gone when the next leaves, which is a downwash rather than a strobe.
  pulseGapMs: 1200,
  // Drawn frame, sized so the ring's INK (0.893 of its frame) clears the marked rectangle's long axis.
  pulseSquares: 7.2,
  pulseClipMs: 2750,       // measured off the installed clip (66 frames at 24 fps)
  // The downdraft's ink is 0.603 of its frame, so its drawn frame is enlarged to match — same
  // correction, same reason, as the plate's.
  downdraftInkFraction: 0.603,

  /* ── the figures ── */
  figureCount: 5,          // RULING: the reference shows five
  unloadAtMs: 4600,
  unloadGapMs: 700,        // RULING: one after another — never together
  figureSquares: 1,
  figureHoldMs: 1100,      // how long the last figure's mark is given before the ladder is called done
  // Where they step: spaced across the far edge and progressively further out of the rectangle, so five
  // marks read as five people leaving rather than as a row of lights.
  figureStepSquares: 0.9,
  figureWalkSquares: 1.1,
  figureWalkGrowthSquares: 0.18,

  /* ── the downdraft ── */
  downdraftAtMs: 1800,     // it arrives before the airframe does; the air moves first
  downdraftMs: 3200,
  downdraftSquares: 7,
  downdraftOpacity: 0.35,
  dustFirstAtMs: 3100,
  dustGapMs: 500,
  dustCount: 2,
  dustSquares: 6,
  dustOpacity: 0.5,

  /* ── the departure ── */
  ascentMs: 2200,

  /* ── the long-lived contract (standard §G) ── */
  // NOT the sequence's lifetime — the airframe holds station until a referee sends it away. This is the
  // issue length after which the engine's own end is reported and the reconciler re-issues, exactly as
  // the condition overlays' ten minutes is: a cap, not a promise, so a leak cannot outlive a session.
  lifetimeMs: 600000,
  // Every part of one placement, across every client's own copy of it. One placement draws at most
  // 18 (1 plate + 4 marks + 1 airframe + 1 downdraft + 2 dust + 4 rings + 5 figures); the scene-wide
  // bound is a shade over two of those, past which the OLDEST are ended to make room — the same rule
  // and the same reason as the burning ground's and the overlays'.
  maxLive: 40,
  fadeInMs: 350,
  fadeOutMs: 500,
});

/**
 * THE ASSET TABLE — database keys, never file paths, existence guarded per draw (standard §A/2).
 *
 * ⭐ EVERY KEY WAS CHOSEN AGAINST THE INSTALLED TIER, not by name. The free tier's 2 061 keys were
 * enumerated and the shortlist decided as follows:
 *   · `zone` — `jb2a.zoning.outward.square.loop.bluegreen.01` is a SQUARE animated ground marker whose
 *     border travels outward on its own loop; it is the only asset in the tier that is both rectangular
 *     and holographic, which is exactly the two things the reference asks of the marked area. It is a
 *     PARENT key of two variants, so it randomises per placement (asset-native first, standard §A/3).
 *     ⚠ STATED, NOT SMOOTHED: it is authored square and is drawn to a 4 × 6 rectangle, so its border
 *     ink is thicker on the short sides than the long ones. Accepted — the alternative is drawing the
 *     rectangle ourselves, which is art in code and carries no motion at all.
 *   · `corner` — `jb2a.markers_scifi.001.loop.001.orangeyellow`. Amber IS the caution read; the same
 *     family ships nine colourways and only this one says hazard without saying magic.
 *   · `pulse` — `jb2a.zoning.outward.circle.once.bluegreen.01`: concentric arcs travelling outward and
 *     fading, 2 750 ms, one play per ring, ink 0.893 × 0.890 of its own frame. ⚠⚠ IT REPLACED A KEY
 *     CHOSEN BY NAME, and the replacement is the whole lesson of standard §A/4: the first build used
 *     `jb2a.template_circle.out_pulse.01.burst.bluewhite`, which SOUNDS like an outward pulse and is in
 *     fact **a ring of musical notes** — a dance effect. It shipped into a rig capture and was caught by
 *     looking at the picture, not by reading the key. Decode, don't guess. The replacement is also the
 *     plate's own family, so the ring and the marked area now read as one system.
 *   · `figure` — `jb2a.token_stage.round.blue.01` is purpose-built for a figure TAKING ITS PLACE, and
 *     is a parent of six variants, so the five marks differ from each other for free.
 *   · `downdraft` — `jb2a.smoke.plumes_loop.01.grey`: a grey billowing cloud that LOOPS (2 000 ms, three
 *     variants, ink 0.603 × 0.585), which is what air being pushed down onto the ground looks like from
 *     directly above. ⚠ IT ALSO REPLACED A NAME-PICK: `jb2a.wind_stream.white` decodes as a full-bleed
 *     field of HORIZONTAL white streaks with no transparent ground at all — a wind blowing ACROSS the
 *     map, which would have carpeted the scene rather than marked the spot under an aircraft.
 *   · `dust` — the ring puff the shot rail already uses for a round's arrival dust (IMPACT_DUST, ink
 *     0.975 × 0.995), reused rather than re-picked.
 */
export const TRAUMA_TEAM_KEYS = Object.freeze({
  zone: "jb2a.zoning.outward.square.loop.bluegreen.01",
  corner: "jb2a.markers_scifi.001.loop.001.orangeyellow",
  downdraft: "jb2a.smoke.plumes_loop.01.grey",
  dust: "jb2a.smoke.puff.ring.01.white",
  pulse: "jb2a.zoning.outward.circle.once.bluegreen.01",
  figure: "jb2a.token_stage.round.blue.01",
});

/**
 * THE DESCENT CUE, and the honest half of the sound answer.
 *
 * The shipped library was measured rather than skimmed (libsndfile, off `sounds/`), because "is there
 * anything aircraft-adjacent" is a question with a number behind it:
 *
 *   | file                   | dur    | centroid | head/mid/tail rms   |
 *   |------------------------|--------|----------|---------------------|
 *   | `fx-scifi-whoosh.ogg`  | 0.54 s |   197 Hz | 0.858 / 0.580 / 0.104 |
 *   | `rocket-launch.ogg`    | 1.41 s |  6827 Hz | 0.200 / 0.056 / 0.002 |
 *   | `shockwave.ogg`        | 1.41 s |   668 Hz | 0.285 / 0.438 / 0.094 |
 *   | `fx-flamethrower.ogg`  | 1.92 s |  1317 Hz | 0.138 / 0.167 / 0.026 |
 *
 * ONE of them fits ONE beat. `fx-scifi-whoosh` is 197 Hz — the lowest thing in the library — and it
 * decays head-to-tail, i.e. it is a heavy mass passing overhead, which is precisely the descent. So it
 * is used there, at the instant the airframe enters the frame.
 *
 * ⛔ WHAT IS NOT THERE, and is NOT faked: a station-keeping bed. Every candidate above decays to
 * silence — there is no rotor or turbine LOOP in the library, and the sequence's longest phase is a
 * machine hanging in the air. Rather than loop a launch transient into a stutter, the hover is silent
 * and the ask is recorded in docs/FX-RAIL.md §8. No audio was sourced for this unit.
 *
 * ⚠ THE LOCKED-CONTEXT GUARD is taken here rather than deferred. A client whose audio context has never
 * been unlocked hands back a promise that never settles, and the cue would then play whenever the first
 * click happens instead of when the airframe arrived — which on a cinematic is worse than silence. The
 * impact leg already guards this way; `sfx()` still parks it (§8, 2026-08-12).
 */
export const TRAUMA_TEAM_SOUND = Object.freeze({
  descent: "fx-scifi-whoosh",
  volume: 0.5,
});

/* ══════════════════════════ The pure half ══════════════════════════ */

/**
 * THE MARKED RECTANGLE in world pixels, from the placement point and the scene's own grid.
 * Pure — it takes two numbers and a point, never a canvas, so the geometry is assertable without one.
 *
 * @param {{x:number,y:number}} centre  where the referee clicked
 * @param {number} gridPx               the scene's square, in pixels
 */
export function landingRect(centre = { x: 0, y: 0 }, gridPx = 100) {
  const g = Number(gridPx) > 0 ? Number(gridPx) : 100;
  const x = Number(centre?.x) || 0;
  const y = Number(centre?.y) || 0;
  const w = TRAUMA_TEAM.zoneWidthSquares * g;
  const h = TRAUMA_TEAM.zoneLengthSquares * g;
  return {
    x, y, w, h,
    corners: [
      { x: x - w / 2, y: y - h / 2 },
      { x: x + w / 2, y: y - h / 2 },
      { x: x + w / 2, y: y + h / 2 },
      { x: x - w / 2, y: y + h / 2 },
    ],
  };
}

/**
 * WHERE THE AIRFRAME COMES FROM — off the rectangle's near edge, on the placement's own axis.
 *
 * ONE HEADING, and it is the negative Y axis. The rectangle is drawn axis-aligned in v1, so the entry
 * has exactly one basis and nothing computes a second one (standard §B/6). A referee-chosen heading is
 * an §8 open item: it is one rotation on the plate, the marks and this point, not a new mechanism.
 */
export function entryPointFor(centre = { x: 0, y: 0 }, gridPx = 100) {
  const g = Number(gridPx) > 0 ? Number(gridPx) : 100;
  const rect = landingRect(centre, g);
  return { x: rect.x, y: rect.y - (rect.h / 2 + TRAUMA_TEAM.entryRiseSquares * g) };
}

/** How far the airframe travels down the screen, in pixels — the one number the descent animates. */
export function entryRisePx(gridPx = 100) {
  const g = Number(gridPx) > 0 ? Number(gridPx) : 100;
  return (TRAUMA_TEAM.zoneLengthSquares / 2 + TRAUMA_TEAM.entryRiseSquares) * g;
}

/** WHEN EACH RING GOES OUT, as offsets from the placement instant. Four numbers, evenly spaced. */
export function pulseSchedule() {
  return Array.from({ length: TRAUMA_TEAM.pulseCount },
    (_v, i) => TRAUMA_TEAM.pulseFirstAtMs + i * TRAUMA_TEAM.pulseGapMs);
}

/**
 * WHEN AND WHERE EACH FIGURE STEPS OFF — the ruling that they leave ONE AFTER ANOTHER expressed as
 * five distinct instants and five distinct places, rather than as five copies of one.
 *
 * They step off the FAR edge (away from the entry heading) and each one walks a little further out than
 * the one before, so a viewer reads a file of people leaving rather than a row of lights coming on.
 */
export function figureSchedule(centre = { x: 0, y: 0 }, gridPx = 100) {
  const g = Number(gridPx) > 0 ? Number(gridPx) : 100;
  const rect = landingRect(centre, g);
  const n = TRAUMA_TEAM.figureCount;
  return Array.from({ length: n }, (_v, i) => ({
    atMs: TRAUMA_TEAM.unloadAtMs + i * TRAUMA_TEAM.unloadGapMs,
    x: rect.x + (i - (n - 1) / 2) * TRAUMA_TEAM.figureStepSquares * g,
    y: rect.y + rect.h / 2
       + (TRAUMA_TEAM.figureWalkSquares + i * TRAUMA_TEAM.figureWalkGrowthSquares) * g,
  }));
}

/** When the SEQUENCE is over — which is not when the airframe leaves, because it does not. */
export function landingLadderMs() {
  const figuresEnd = TRAUMA_TEAM.unloadAtMs
    + (TRAUMA_TEAM.figureCount - 1) * TRAUMA_TEAM.unloadGapMs
    + TRAUMA_TEAM.figureHoldMs;
  // The last ring outlives the last figure once the rings are spaced against their own clip, so the
  // ladder's end is whichever finishes last. Over-stating is the safe direction here for the same
  // reason it is on the shot rail's tail: a caller that waits is never the failure.
  const ringsEnd = TRAUMA_TEAM.pulseFirstAtMs
    + (TRAUMA_TEAM.pulseCount - 1) * TRAUMA_TEAM.pulseGapMs + TRAUMA_TEAM.pulseClipMs;
  return Math.max(figuresEnd, ringsEnd);
}

/** The engine name one part of one placement is stamped with. Encodes the placement so a sweep can find it. */
export function traumaFxNameFor(id, part) {
  return `${TRAUMA_TEAM_NAME}.${id}.${part}`;
}

/* ══════════════════════════ The capture seam ══════════════════════════ */

/**
 * Run the whole ladder against a compressed clock, so a keeper can watch a nine-second sequence inside
 * one assertion. Applied to the ladder's own offsets and to the transient durations ONLY — the
 * long-lived issue length is a leak bound rather than a phase and does not move with it. Armed by
 * nothing that ships; null restores the shipped clock. (Standard §I/25.)
 */
let _timeScale = null;
export function _setTraumaTimeScale(scale) {
  _timeScale = Number.isFinite(scale) && scale > 0 ? Number(scale) : null;
  return _timeScale;
}
function _scaled(ms) {
  return _timeScale === null ? ms : Math.max(0, Math.round(ms * _timeScale));
}

/* ══════════════════════════ The census ══════════════════════════ */

/** Parts QUEUED but not yet created by the engine — counted against the scene cap. */
let _pending = 0;
export function pendingTraumaFx() { return _pending; }

/** Names WE are ending on purpose, so the ended-hook does not read the end as an expiry and re-issue. */
const _intentionalEnds = new Set();
const INTENT_REGISTER_MAX = 128;

/**
 * EVERY PART ALIVE ON THIS CLIENT RIGHT NOW, oldest first — a query of the engine rather than a ledger
 * of our own, for the reason the burning ground's census gives: a tally we kept would drift the instant
 * an effect ended for a reason we did not cause.
 */
export function liveTraumaFx() {
  try {
    const list = globalThis.Sequencer?.EffectManager?.getEffects?.({ name: `${TRAUMA_TEAM_NAME}.*` }) ?? [];
    return [...list].sort((a, b) => (a?.data?.creationTimestamp ?? 0) - (b?.data?.creationTimestamp ?? 0));
  } catch (_e) {
    return [];
  }
}

/** End one part by name, on purpose. Registers the intent first so the ended-hook stays quiet. */
function endTraumaFx(name) {
  if (_intentionalEnds.size >= INTENT_REGISTER_MAX) {
    _intentionalEnds.delete(_intentionalEnds.values().next().value);   // oldest out; Sets keep insertion order
  }
  _intentionalEnds.add(name);
  try {
    globalThis.Sequencer?.EffectManager?.endEffects?.({ name })
      ?.catch?.((err) => console.warn(`${SCOPE} | arrival sequence end failed`, err));
  } catch (err) {
    console.warn(`${SCOPE} | arrival sequence end failed`, err);
  }
}

/**
 * THE SCENE CAP, enforced in one place by ending the OLDEST — never the newest, because the placement a
 * referee just made is the one that must be drawn. The PENDING tally is part of the count: a part that
 * has been queued is invisible to the census until the engine's own play resolves, so two placements
 * inside that beat would both under-evict.
 */
function evictForRoom(wanting = 0) {
  try {
    const live = liveTraumaFx();
    const overBy = live.length + _pending + wanting - TRAUMA_TEAM.maxLive;
    if (overBy <= 0) return 0;
    const names = live.slice(0, Math.min(overBy, live.length)).map((e) => e?.data?.name).filter(Boolean);
    for (const name of names) endTraumaFx(name);
    return names.length;
  } catch (err) {
    console.warn(`${SCOPE} | arrival sequence cap failed`, err);
    return 0;
  }
}

/* ══════════════════════════ The drawing half ══════════════════════════ */

/** The one live placement on THIS client, or null. Never written anywhere. */
let _active = null;

/** Timers belonging to the live placement, so a departure cancels a sequence still running. */
function clearTimers(record) {
  for (const t of record?.timers ?? []) { try { clearTimeout(t); } catch (_e) { /* already fired */ } }
  if (record) record.timers = [];
}

/** Schedule one draw on the ladder. Fire-and-forget; nothing in the ladder awaits anything (standard §D/13). */
function at(record, ms, verb, fn) {
  const t = setTimeout(() => {
    try { fn(); } catch (err) { console.warn(`${SCOPE} | arrival sequence ${verb} failed`, err); }
  }, _scaled(ms));
  record.timers.push(t);
  return t;
}

/** A named engine section with the common contract already applied. */
function section(seq, name) {
  _pending++;
  const fx = seq.effect().name(name);
  return fx;
}

/** Play one queued sequence, releasing its pending count in `finally` (standard §G/21). */
function playSection(seq, verb) {
  seq.play()
    .catch((err) => console.warn(`${SCOPE} | arrival sequence ${verb} failed`, err))
    .finally(() => { _pending = Math.max(0, _pending - 1); });
}

/** The ground plate — the marked rectangle itself, under the figures on the scene. */
function drawZone(record) {
  const name = traumaFxNameFor(record.id, "zone");
  const seq = new globalThis.Sequence();
  section(seq, name)
    .file(TRAUMA_TEAM_KEYS.zone)
    .atLocation({ x: record.centre.x, y: record.centre.y })
    .size({
      width: TRAUMA_TEAM.zoneWidthSquares / TRAUMA_TEAM.zoneInkFraction,
      height: TRAUMA_TEAM.zoneLengthSquares / TRAUMA_TEAM.zoneInkFraction,
    }, { gridUnits: true })
    .opacity(TRAUMA_TEAM.zoneOpacity)
    .belowTokens()
    .duration(TRAUMA_TEAM.lifetimeMs)
    .fadeIn(TRAUMA_TEAM.fadeInMs)
    .fadeOut(TRAUMA_TEAM.fadeOutMs);
  playSection(seq, "plate");
  return name;
}

/** The four caution marks, one per corner, in the rectangle's own coordinates. */
function drawCorner(record, index) {
  const name = traumaFxNameFor(record.id, `corner.${index}`);
  const rect = landingRect(record.centre, record.gridPx);
  const p = rect.corners[index];
  const seq = new globalThis.Sequence();
  section(seq, name)
    .file(TRAUMA_TEAM_KEYS.corner)
    .atLocation(p)
    .size({ width: TRAUMA_TEAM.cornerSquares }, { gridUnits: true })
    .opacity(TRAUMA_TEAM.cornerOpacity)
    .belowTokens()
    .duration(TRAUMA_TEAM.lifetimeMs)
    .fadeIn(TRAUMA_TEAM.fadeInMs)
    .fadeOut(TRAUMA_TEAM.fadeOutMs);
  playSection(seq, "caution mark");
  return name;
}

/**
 * THE HULL'S OWN GEOMETRY, in one place because two calls draw it (the arrival and the departure) and a
 * body that disagreed with itself between them would read as two different machines.
 *
 * ⭐ THE OFFSET IS A CORRECTION, AND IT WAS MEASURED RATHER THAN ASSUMED. The engine draws its
 * rectangle and rounded-rectangle shapes with the given offset as the **top-left corner**
 * (`graphic.drawRect(offset.x, offset.y, w, h)` in the installed build), so an uncorrected body sits a
 * full half-width right and half-length down of the point it was given — photographed on the rig with
 * the hull hanging off the corner of its own marked area. `anchor` is declared in the engine's own
 * typings but is not applied to these two cases, so it does not fix it; only its ELLIPSE case is
 * centre-drawn. Half the body, negative, in grid units, is the correction, and it is what makes this
 * shape's location mean what every other element's location means.
 */
function airframeShape() {
  return {
    width: TRAUMA_TEAM.airframeWidthSquares,
    height: TRAUMA_TEAM.airframeLengthSquares,
    radius: TRAUMA_TEAM.airframeCornerSquares,
    gridUnits: true,
    offset: {
      x: -TRAUMA_TEAM.airframeWidthSquares / 2,
      y: -TRAUMA_TEAM.airframeLengthSquares / 2,
      gridUnits: true,
    },
    fillColor: TRAUMA_TEAM.airframeFill,
    fillAlpha: TRAUMA_TEAM.airframeFillAlpha,
    lineSize: TRAUMA_TEAM.airframeLineWidth,
    lineColor: TRAUMA_TEAM.airframeLine,
    name: "hull",
  };
}

/**
 * THE AIRFRAME. One element for the whole flight: it is created at station and its own container is
 * animated DOWN into it, rather than being moved by the engine's travel verb — which takes a speed and
 * would have to be back-solved from a distance, where `animateProperty` takes the duration the ladder
 * already states. The station-keeping bob rides the sprite INSIDE that container, delayed to the
 * instant the descent ends, so the two never fight over one property.
 */
function drawAirframe(record) {
  const name = traumaFxNameFor(record.id, "airframe");
  const g = record.gridPx;
  const rise = entryRisePx(g);
  const bobPx = TRAUMA_TEAM.bobSquares * g;
  const seq = new globalThis.Sequence();
  const fx = section(seq, name)
    .shape("roundedRect", airframeShape())
    .atLocation({ x: record.centre.x, y: record.centre.y })
    .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING)
    .duration(TRAUMA_TEAM.lifetimeMs)
    .fadeIn(TRAUMA_TEAM.fadeInMs)
    .fadeOut(TRAUMA_TEAM.fadeOutMs);
  // The descent: the container falls the stated distance over the stated time.
  try {
    fx.animateProperty("spriteContainer", "position.y",
      { from: -rise, to: 0, duration: _scaled(TRAUMA_TEAM.descentMs), ease: "easeOutCubic" });
    fx.animateProperty("sprite", "scale.x",
      { from: TRAUMA_TEAM.entryScale, to: 1, duration: _scaled(TRAUMA_TEAM.descentMs), ease: "easeOutCubic" });
    fx.animateProperty("sprite", "scale.y",
      { from: TRAUMA_TEAM.entryScale, to: 1, duration: _scaled(TRAUMA_TEAM.descentMs), ease: "easeOutCubic" });
  } catch (err) {
    console.warn(`${SCOPE} | arrival sequence descent animation unavailable`, err);
  }
  // Station-keeping. Guarded on its own because a host without the loop verb should still put the
  // airframe on station rather than draw nothing at all.
  try {
    fx.loopProperty("sprite", "position.y", {
      from: -bobPx, to: bobPx, duration: _scaled(TRAUMA_TEAM.bobMs),
      pingPong: true, delay: _scaled(TRAUMA_TEAM.descentMs),
    });
  } catch (err) {
    console.warn(`${SCOPE} | arrival sequence station-keeping unavailable`, err);
  }
  playSection(seq, "airframe");
  return name;
}

/** The air moving under it: one stream, then the dust rings it pushes off the ground. */
function drawDowndraft(record) {
  const name = traumaFxNameFor(record.id, "downdraft");
  const seq = new globalThis.Sequence();
  section(seq, name)
    .file(TRAUMA_TEAM_KEYS.downdraft)
    .atLocation({ x: record.centre.x, y: record.centre.y })
    .size({
      width: TRAUMA_TEAM.downdraftSquares / TRAUMA_TEAM.downdraftInkFraction,
      height: TRAUMA_TEAM.downdraftSquares / TRAUMA_TEAM.downdraftInkFraction,
    }, { gridUnits: true })
    .opacity(TRAUMA_TEAM.downdraftOpacity)
    .belowTokens()
    .duration(_scaled(TRAUMA_TEAM.downdraftMs))
    .fadeIn(TRAUMA_TEAM.fadeInMs)
    .fadeOut(TRAUMA_TEAM.fadeOutMs);
  playSection(seq, "downdraft");
  return name;
}

function drawDust(record, index) {
  const name = traumaFxNameFor(record.id, `dust.${index}`);
  const seq = new globalThis.Sequence();
  section(seq, name)
    .file(TRAUMA_TEAM_KEYS.dust)
    .atLocation({ x: record.centre.x, y: record.centre.y })
    .size({ width: TRAUMA_TEAM.dustSquares }, { gridUnits: true })
    .opacity(TRAUMA_TEAM.dustOpacity)
    .belowTokens();
  playSection(seq, "dust");
  return name;
}

/** One ring, going out under the airframe. */
function drawPulse(record, index) {
  const name = traumaFxNameFor(record.id, `pulse.${index}`);
  const seq = new globalThis.Sequence();
  section(seq, name)
    .file(TRAUMA_TEAM_KEYS.pulse)
    .atLocation({ x: record.centre.x, y: record.centre.y })
    .size({ width: TRAUMA_TEAM.pulseSquares }, { gridUnits: true })
    .belowTokens();
  playSection(seq, "ring");
  return name;
}

/**
 * One figure taking its place. ⛔ A SPRITE, NOT A DOCUMENT — see the file header. Nothing here creates
 * an actor or a token, and the keeper asserts the scene's embedded-document counts are unmoved.
 */
function drawFigure(record, index, point) {
  const name = traumaFxNameFor(record.id, `figure.${index}`);
  const seq = new globalThis.Sequence();
  section(seq, name)
    .file(TRAUMA_TEAM_KEYS.figure)
    .atLocation(point)
    .size({ width: TRAUMA_TEAM.figureSquares }, { gridUnits: true })
    .belowTokens();
  playSection(seq, "figure");
  return name;
}

/** The descent cue. Skipped outright on a client whose audio context has never been unlocked. */
function playDescentCue() {
  try {
    if (game.audio?.locked === true) return null;
    const src = fxSoundSrc(TRAUMA_TEAM_SOUND.descent);
    if (!src) return null;
    return foundry.audio.AudioHelper.play(
      { src, volume: TRAUMA_TEAM_SOUND.volume, autoplay: true, loop: false, channel: "interface" }, false);
  } catch (err) {
    console.warn(`${SCOPE} | arrival sequence cue failed`, err);
    return null;
  }
}

/* ══════════════════════════ The plan, and the one gate site ══════════════════════════ */

/**
 * THE ONCE-PER-PLACEMENT GATE — the one idiom (standard, "The once-per-payload gate"). Every question
 * that can refuse a part is asked HERE, once, into a plan; the ladder below reads the plan and asks
 * nothing. Issue policy for every part of this element is **per-placement**: each is called from the
 * ladder exactly as many times as the plan says, and no loop re-checks a gate.
 */
function planFor(record) {
  const has = (part) => fxDbEntryExists(TRAUMA_TEAM_KEYS[part]);
  return {
    zone: has("zone"),
    corner: has("corner"),
    downdraft: has("downdraft"),
    dust: has("dust"),
    pulse: has("pulse"),
    figure: has("figure"),
    // The airframe is engine-native geometry rather than an asset, so no tier can take it away — which
    // is also why a missing-key install still shows WHERE the sequence is happening.
    airframe: true,
  };
}

/**
 * DRAW ONE PLACEMENT on this client. Returns what it queued, by value, so the whole mechanism is
 * assertable from a keeper — and returns the SAME shape whether it drew everything or nothing.
 */
function drawLanding({ id, x, y, sceneId }) {
  const out = { queued: [], skipped: null };
  if (!sequencerActive()) { out.skipped = "engine"; return out; }
  if (!combatFxEnabled()) { out.skipped = "disabled"; return out; }
  if (!canvas?.ready) { out.skipped = "canvas"; return out; }
  if (sceneId && canvas.scene?.id !== sceneId) { out.skipped = "scene"; return out; }

  // A second placement replaces the first: one sequence at a time is the cap this element's shape
  // gives it, and two airframes over one scene is not a thing anybody asked for.
  if (_active) clearLanding();

  const gridPx = Number(canvas?.dimensions?.size) || 100;
  const record = { id, centre: { x, y }, gridPx, sceneId: sceneId ?? canvas.scene?.id ?? null, timers: [] };
  const plan = planFor(record);
  record.plan = plan;
  _active = record;

  const figures = figureSchedule(record.centre, gridPx);
  const pulses = pulseSchedule();
  // The whole placement's part count, resolved before anything is queued, so the cap is asked once.
  const wanting = (plan.zone ? 1 : 0) + (plan.corner ? 4 : 0) + 1
    + (plan.downdraft ? 1 : 0) + (plan.dust ? TRAUMA_TEAM.dustCount : 0)
    + (plan.pulse ? pulses.length : 0) + (plan.figure ? figures.length : 0);
  evictForRoom(wanting);

  /* ── the marked area, first and on its own beat ── */
  if (plan.zone) { at(record, TRAUMA_TEAM.zoneAtMs, "plate", () => drawZone(record)); out.queued.push("zone"); }
  if (plan.corner) {
    for (let i = 0; i < 4; i++) {
      at(record, TRAUMA_TEAM.zoneAtMs, "caution mark", () => drawCorner(record, i));
      out.queued.push("corner");
    }
  }
  /* ── the airframe, and the air ahead of it ── */
  at(record, TRAUMA_TEAM.descentAtMs, "airframe", () => { drawAirframe(record); playDescentCue(); });
  out.queued.push("airframe");
  if (plan.downdraft) {
    at(record, TRAUMA_TEAM.downdraftAtMs, "downdraft", () => drawDowndraft(record));
    out.queued.push("downdraft");
  }
  if (plan.dust) {
    for (let i = 0; i < TRAUMA_TEAM.dustCount; i++) {
      at(record, TRAUMA_TEAM.dustFirstAtMs + i * TRAUMA_TEAM.dustGapMs, "dust", () => drawDust(record, i));
      out.queued.push("dust");
    }
  }
  /* ── the rings ── */
  if (plan.pulse) {
    pulses.forEach((ms, i) => {
      at(record, ms, "ring", () => drawPulse(record, i));
      out.queued.push("pulse");
    });
  }
  /* ── the figures, one after another ── */
  if (plan.figure) {
    figures.forEach((f, i) => {
      at(record, f.atMs, "figure", () => drawFigure(record, i, { x: f.x, y: f.y }));
      out.queued.push("figure");
    });
  }
  return out;
}

/** Take one placement down: its timers, then every part of it the engine still holds. */
function clearLanding() {
  const record = _active;
  _active = null;
  if (!record) return 0;
  clearTimers(record);
  let n = 0;
  const prefix = `${TRAUMA_TEAM_NAME}.${record.id}.`;
  for (const effect of liveTraumaFx()) {
    const name = String(effect?.data?.name ?? "");
    if (name.startsWith(prefix)) { endTraumaFx(name); n++; }
  }
  return n;
}

/**
 * THE DEPARTURE — the reverse of the arrival, and the only exit the reference describes. A second
 * airframe is queued climbing back out along the entry heading while the first is ended under it, so
 * what a viewer sees is one machine leaving rather than one blinking out.
 */
function drawDeparture(record) {
  const name = traumaFxNameFor(record.id, "exit");
  const g = record.gridPx;
  const seq = new globalThis.Sequence();
  const fx = section(seq, name)
    .shape("roundedRect", airframeShape())
    .atLocation({ x: record.centre.x, y: record.centre.y })
    .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING)
    .duration(_scaled(TRAUMA_TEAM.ascentMs))
    .fadeOut(TRAUMA_TEAM.fadeOutMs);
  try {
    fx.animateProperty("spriteContainer", "position.y",
      { from: 0, to: -entryRisePx(g), duration: _scaled(TRAUMA_TEAM.ascentMs), ease: "easeInCubic" });
    fx.animateProperty("sprite", "scale.x",
      { from: 1, to: TRAUMA_TEAM.entryScale, duration: _scaled(TRAUMA_TEAM.ascentMs), ease: "easeInCubic" });
    fx.animateProperty("sprite", "scale.y",
      { from: 1, to: TRAUMA_TEAM.entryScale, duration: _scaled(TRAUMA_TEAM.ascentMs), ease: "easeInCubic" });
  } catch (err) {
    console.warn(`${SCOPE} | arrival sequence departure animation unavailable`, err);
  }
  playSection(seq, "departure");
  return name;
}

/** Take the live placement away on this client, with its departure. Returns what it ended, by value. */
function endLandingLocal() {
  const record = _active;
  if (!record) return { ended: 0, skipped: "idle" };
  let departed = false;
  if (sequencerActive() && combatFxEnabled() && canvas?.scene?.id === record.sceneId) {
    try { drawDeparture(record); departed = true; } catch (err) {
      console.warn(`${SCOPE} | arrival sequence departure failed`, err);
    }
  }
  const ended = clearLanding();
  if (departed) {
    // The climbing airframe is the one part deliberately outliving the placement it belonged to; it is
    // duration-bounded and named under the same prefix, so the census still owns it.
    setTimeout(() => endTraumaFx(traumaFxNameFor(record.id, "exit")),
      _scaled(TRAUMA_TEAM.ascentMs) + TRAUMA_TEAM.fadeOutMs);
  }
  return { ended, skipped: null };
}

/* ══════════════════════════ The public surface ══════════════════════════ */

/** Is a placement on station on this client right now? */
export function traumaTeamActive() {
  return _active !== null;
}

/** What is on station, by value — for a macro that wants to ask before it acts. */
export function traumaTeamState() {
  if (!_active) return null;
  return { id: _active.id, sceneId: _active.sceneId, x: _active.centre.x, y: _active.centre.y };
}

/**
 * PLACE ONE ARRIVAL, and tell every client to draw its own copy.
 *
 * Referee-only, at the action layer as well as at the control: this puts a sequence on everybody's
 * screen, so it is the referee's call and nobody else's. The gesture that reaches it is already
 * referee-gated (trauma-team-tool.js); this is the second gate, because an API is a door too.
 */
export async function landTraumaTeam(centre = {}, { sceneId = null } = {}) {
  if (game.user?.isGM !== true) return { queued: [], skipped: "permission" };
  if (!combatFxEnabled()) return { queued: [], skipped: "disabled" };
  const scene = sceneId ?? canvas?.scene?.id ?? null;
  const x = Number(centre?.x);
  const y = Number(centre?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { queued: [], skipped: "position" };
  const id = foundry.utils.randomID();
  // Announce first, draw second: the emit never echoes to its sender, so this client's own copy comes
  // from the local call and every other client's from the announcement — one code path, one picture.
  try {
    game.socket?.emit?.(`module.${SCOPE}`, { type: MSG_LAND, id, x, y, sceneId: scene });
  } catch (err) {
    console.warn(`${SCOPE} | arrival sequence announcement failed`, err);
  }
  return drawLanding({ id, x, y, sceneId: scene });
}

/** Send it away — on every client, the same way it arrived. */
export async function endTraumaTeam() {
  if (game.user?.isGM !== true) return { ended: 0, skipped: "permission" };
  try {
    game.socket?.emit?.(`module.${SCOPE}`, { type: MSG_END });
  } catch (err) {
    console.warn(`${SCOPE} | arrival sequence departure announcement failed`, err);
  }
  return endLandingLocal();
}

/**
 * REDRAW THE PERSISTENT HALF — the reconciler, and the only thing a canvas rebuild needs.
 *
 * It rebuilds what is meant to be STANDING (the plate, its caution marks, the airframe) and never
 * replays the sequence: a referee who placed one arrival gets one arrival, and a scene change is not a
 * second one. Idempotent by construction — it compares the census against the record and draws only
 * the difference, so a pass over an already-correct scene draws nothing and ends nothing.
 */
export function redrawTraumaTeam() {
  const out = { added: [], skipped: null };
  if (!_active) { out.skipped = "idle"; return out; }
  if (!sequencerActive()) { out.skipped = "engine"; return out; }
  if (!canvas?.ready) { out.skipped = "canvas"; return out; }
  const record = _active;
  if (canvas.scene?.id !== record.sceneId) { out.skipped = "scene"; return out; }
  if (!combatFxEnabled()) {
    // The master switch is a CLEAR, not a return: a referee turning the rail off expects the screen to
    // settle rather than to keep an airframe until a reload.
    clearLanding();
    out.skipped = "disabled";
    return out;
  }
  const prefix = `${TRAUMA_TEAM_NAME}.${record.id}.`;
  const drawn = new Set(liveTraumaFx()
    .map((e) => String(e?.data?.name ?? ""))
    .filter((n) => n.startsWith(prefix))
    .map((n) => n.slice(prefix.length)));

  const wanted = [];
  if (record.plan?.zone && !drawn.has("zone")) wanted.push("zone");
  if (record.plan?.corner) {
    for (let i = 0; i < 4; i++) if (!drawn.has(`corner.${i}`)) wanted.push(`corner.${i}`);
  }
  if (!drawn.has("airframe")) wanted.push("airframe");
  if (!wanted.length) return out;

  evictForRoom(wanted.length);
  for (const part of wanted) {
    try {
      if (part === "zone") drawZone(record);
      else if (part === "airframe") drawAirframe(record);
      else drawCorner(record, Number(part.split(".")[1]));
      out.added.push(part);
    } catch (err) {
      console.warn(`${SCOPE} | arrival sequence redraw failed`, part, err);
    }
  }
  return out;
}

/** Take every part down on this client, by name. The scene is going, or the client is. */
export function clearTraumaFx() {
  for (const effect of liveTraumaFx()) {
    const name = effect?.data?.name;
    if (name) endTraumaFx(name);
  }
}

/**
 * THE RE-ISSUE. A part that reaches the end of its ten minutes has ended for a reason that has nothing
 * to do with the referee, so the placement is reconciled and gets it back. A part WE ended registered
 * its intent first and is simply forgotten here, which is what stops a departure from undoing itself.
 */
function _onEffectEnded(effect) {
  const name = String(effect?.data?.name ?? "");
  if (!name.startsWith(`${TRAUMA_TEAM_NAME}.`)) return;
  if (_intentionalEnds.delete(name)) return;
  if (!_active) return;
  if (!name.startsWith(`${TRAUMA_TEAM_NAME}.${_active.id}.`)) return;
  redrawTraumaTeam();
}

/**
 * Hook wiring — called once from the module's ready hook, registered unconditionally like the shot rail
 * and the condition overlays: the master switch is read per event, so a referee toggling it takes
 * effect immediately with no reload and the listeners are inert while it is off.
 */
export function registerTraumaTeam() {
  // Every client draws its own copy; nothing is written, so there is no referee gate on the RECEIVING
  // side and no active-referee election — the same shape the muzzle-flash announcement uses.
  game.socket.on(`module.${SCOPE}`, (data) => {
    if (data?.type === MSG_LAND) {
      if (!combatFxEnabled()) return;
      try {
        drawLanding({ id: data.id, x: Number(data.x), y: Number(data.y), sceneId: data.sceneId ?? null });
      } catch (err) {
        console.warn(`${SCOPE} | arrival sequence relay failed`, err);
      }
      return;
    }
    if (data?.type === MSG_END) {
      try { endLandingLocal(); } catch (err) {
        console.warn(`${SCOPE} | arrival sequence departure relay failed`, err);
      }
    }
  });
  Hooks.on("endedSequencerEffect", _onEffectEnded);
  // A canvas rebuild pulls every sprite out from under the placement; the record survives it, so the
  // standing half is redrawn. See the file header for why the catch-up hangs on the engine's own
  // signal as well: `canvasReady` fires before this module exists on a load, and `ready` is too early
  // for the engine to draw anything.
  Hooks.on("canvasReady", () => redrawTraumaTeam());
  Hooks.on("sequencerReady", () => redrawTraumaTeam());
  Hooks.on("canvasTearDown", () => clearTraumaFx());
  // And the case the hooks cannot cover: this function called when the engine is ALREADY up (a late
  // enable, or a spec importing the module mid-session).
  if (canvas?.ready && globalThis.Sequencer?.EffectManager) redrawTraumaTeam();
}
