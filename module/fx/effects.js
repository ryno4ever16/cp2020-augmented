/**
 * Combat FX adapter (Animation Rail, Unit A1) — the ONE seam between the combat pipeline and any
 * visual/audio effect. Everything the rail knows about outside effect engines lives in this file:
 * capability detection, the weapon-class → asset mapping table, and the small verbs the pipeline
 * calls (fxShot / fxMuzzleFlash / sfx). A dead or renamed dependency is then one file to re-point.
 *
 * Dependency policy (design doc §0): Sequencer + JB2A are OPTIONAL. Sprite/tracer verbs silently
 * no-op when they are absent; the muzzle LIGHT and the AUDIO are native and always work.
 *
 * What runs where: `cyberpunk2020.weaponFired` fires only on the client that resolved the shot, so
 * this adapter reaches the other clients the same way the rest of the module does — the audio is
 * emitted with the broadcast flag, the muzzle flash is announced on the module's socket channel and
 * drawn locally by every client that receives it, and Sequencer effects broadcast through
 * Sequencer's own socket.
 *
 * Numbers are the 60fps frame-study measurements recorded in the design doc §2 (per-shot cadence
 * ~80ms, flash envelope attack 1 frame → hold 2 → decay 2). They are named constants below so the
 * spec is editable in one place.
 */

import { tokensOf } from "../mech/light.js";
import { isFullBorg } from "../mech/borg.js";
import { combatFxEnabled, faceTargetOnFireEnabled, goreEnabled } from "../settings.js";
// THE EITHER/OR, borrowed rather than re-derived. damage-hooks.js asks this same function twice — once
// to decide whether the single-target damage flow claims a payload and once to decide whether the shot
// pattern does — and the burning ground has to land on the same side of that answer as the damage
// does. Importing the derivation is what makes a third caller impossible to disagree with the first two.
import { spreadFlowModeOf, spreadModeForAmmo, SPREAD_MODE_SINGLE, SPREAD_MODE_BUCK } from "../lookups.js";
// The shot pattern's confirmed corridor arrives on the payload in METRES (it is a rules distance, and
// the region is planted from the same numbers) — this is the one conversion that turns it into the
// pixels this file draws in, and it is the same helper the plant and the aim preview use.
import { metersToPixels } from "../vehicle/vehicle-grid.js";
import { localize } from "../utils.js";

const SCOPE = "cp2020-augmented";

/** Socket message announcing one flash. Same channel + type-dispatch shape as every other relay in
 *  the module (cover chew, IP, missile flight): one `game.socket.on` per feature, filtered by type. */
const MSG_FLASH = "fxMuzzleFlash";

/** Where the shipped shot sounds live. Not a manifest entry — a plain asset directory. */
const SOUND_DIR = `modules/${SCOPE}/sounds`;

/** Accepted delivery extensions, in preference order (the asset lane may land any of them). */
const SOUND_EXTENSIONS = ["ogg", "mp3", "wav"];

/** Interface-channel playback level for a shot sound (each client's own interface slider scales it). */
const SHOT_VOLUME = 0.8;

/**
 * DEFAULT per-shot cadence: 10 resolved shots in ~0.67s in the reference (design doc §2.1). A class
 * may override it with a `cadenceMs` of its own — see FX_CLASSES and classCadenceMs.
 */
export const SHOT_CADENCE_MS = 80;

/** Upper bound on per-shot fan-out for one payload — a corrupt/huge shot count can't flood the rail. */
export const MAX_FX_SHOTS = 30;

/**
 * HOW FAR BEHIND ITS OWN SLOT A ROUND MAY START BEFORE IT IS DROPPED, in milliseconds.
 *
 * ⭐ THE DEFECT THIS EXISTS FOR, measured on the rig 2026-08-09 rather than reasoned about. The fan-out
 * loop below paces rounds by the wall clock while everything it queues is drawn by the render loop, so
 * under load the two clocks come apart. The old loop waited a FIXED `cadenceMs` per iteration, which
 * means every millisecond a round's timer fired LATE was added to the next round's start instead of
 * being absorbed — the error compounded, and a burst stretched to somewhere over twice its length and
 * went on drawing after the shooting had stopped. A 30-round flechette payload at the shell's 180 ms
 * cadence was measured at **11 681 ms against an intended 5 220 ms (2.24×)**, and the same ratio held
 * at 5 / 10 / 20 rounds (2.13× / 2.24× / 2.23×), so it is the mechanism and not a one-off.
 * ⏪ TO REPRODUCE THAT LOAD TODAY you need a class whose OWN row draws a group — the flechette overlay
 * stopped forcing one on 2026-08-10 (see its row note), and that removal is what answered the RESIDUAL
 * the two halves below could not: this rule paces the loop, and nothing that paces a loop can reach the
 * backlog the rounds it kept had already queued.
 *
 * ⚠ WHERE THE TIME ACTUALLY GOES, because the obvious answer is wrong and it changes the fix. Building
 * one round's Sequence is CHEAP — `fxShot`'s synchronous cost measured at a median of **1 ms**. The lag
 * is not our work, it is the loop's own `setTimeout` being starved while the engine draws what earlier
 * rounds already queued (the same run measured the canvas at 5 FPS with 421 effects live). So no amount
 * of making the round body cheaper fixes it: the loop has to stop trusting that its sleep slept for the
 * time it asked for. Hence the two halves below.
 *
 * ⭐ HALF ONE — THE SCHEDULE IS ANCHORED TO THE WALL CLOCK. Round `i` is DUE at `t0 + i × cadence`
 * (roundDueAtMs), and the loop sleeps only the REMAINDER to that instant. A round that ran late no
 * longer pushes its successors, so the error stops compounding: it is measured fresh each round against
 * a fixed origin rather than accumulated.
 *
 * ⭐ HALF TWO — A ROUND THAT STILL CANNOT START ON TIME IS DROPPED, NOT QUEUED (user ruling
 * 2026-08-09, verbatim reason: *"the audio already told the ear the story"*). Anchoring alone would
 * still let a starved loop fire five rounds' worth of sprites in one tick once the timer finally came
 * back; the drop is what keeps the picture honest. The round goes ENTIRELY — its audio, its light, its
 * sprites, its tracer and its impact — and the measurement at the drop site records why the first,
 * audio-surviving build of the rule was refused.
 *
 * ⛔ THE LAST ROUND IS NEVER DROPPED, however late it is, and that is a hard rule rather than a
 * preference: it is the round that carries the settle tag, so the damage window's completion signal is
 * named on an element that is certain to be drawn. Keeping it is why no retagging machinery is needed
 * and why the window can never be left waiting on a picture that was refused.
 *
 * ⭐ WHY HALF A CADENCE, AND NOT A FLAT NUMBER OF MILLISECONDS. The first build of this rule used a flat
 * 150 ms, on the reasoning that renderer starvation does not scale with how fast the gun fires. The rig
 * refused it on the second run, and the arithmetic says why. The gap between two rounds that both get
 * drawn is `cadence − (how late the earlier one was)`: a round drawn 150 ms behind its slot is already
 * past the NEXT round's slot when it finishes, so that next round waits not at all and the two are
 * drawn together. Measured, at the shipped 80 ms cadence with a 150 ms threshold: gaps of 256, 1, 256 ms
 * across one burst — two rounds one millisecond apart, which is the very bunching the anchoring was
 * supposed to stop.
 *
 * So the threshold has to be smaller than the cadence, and expressing it as a FRACTION of the cadence is
 * what turns the rule into a guarantee rather than a hope: at half a cadence, no round is ever drawn
 * more than half a slot late, and therefore **no two drawn rounds are ever closer together than half a
 * cadence**. That is a property of the arithmetic, not of the host, and the keeper pins it as one.
 * Concretely: 40 ms at the default 80 ms spacing, 90 ms at the shell's 180 ms.
 *
 * The rule is self-correcting, which is the property that actually retires the report: dropping late
 * rounds removes exactly the queued work that was starving the timer, so the lag falls back under the
 * threshold and the rest of the burst draws normally. A healthy client never reaches it at all — timer
 * lateness there is a frame or two, well inside 40 ms.
 *
 * ⏪ THE REVERT VALUE, if the fraction is ever wanted back as a flat figure, is **150 ms** — but note
 * that it does not hold the separation guarantee at any cadence below 300 ms, which is every class we
 * ship. Set the fraction to 0 to drop nothing at all (anchoring alone — the measured bunching above is
 * what that costs).
 */
export const FX_DROP_LAG_FRACTION = 0.5;

/**
 * When round `index` of a fan-out is DUE, in ms on the same clock the loop started from. Pure, so the
 * anchored schedule is asserted by value rather than by watching a burst.
 */
export function roundDueAtMs(startMs, index, cadenceMs) {
  return (Number(startMs) || 0) + Math.max(0, Number(index) || 0) * (Number(cadenceMs) || 0);
}

/**
 * THE DROP DECISION, as a value: is this round too far behind its own slot to be worth drawing?
 * Pure — no clock, no canvas — so both halves of the rule (the threshold and the last-round exemption)
 * are pinned by the keeper without having to starve a real renderer.
 */
export function roundDropped({ lagMs = 0, isLast = false, dropLagMs = 0 } = {}) {
  if (isLast) return false;                       // the settle tag rides this one — never refused
  const limit = Number(dropLagMs);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return (Number(lagMs) || 0) > limit;
}

// Capture/test seam, sixth of the same family (_setFlashLevels, _setDashMs, _setSpriteRate, _setDbProbe,
// _setSoundManifest) and armed by nothing that ships. It exists because the two ends of the drop rule
// need opposite conditions to be pinned honestly: a threshold set out of reach proves a healthy client
// drops NOTHING (exact counts, no timing), and a threshold set at the floor proves a loaded one drops
// the late rounds and keeps the last. Null restores the shipped value.
let _dropLagOverride = null;

/** Test seam: force an ABSOLUTE drop threshold in ms (null restores the cadence-derived one). */
export function _setDropLagMs(ms) {
  _dropLagOverride = Number.isFinite(ms) ? Number(ms) : null;
  return _dropLagOverride;
}

/**
 * The drop threshold for a burst running at `cadenceMs` — half a slot, unless a seam is armed. Pure
 * apart from the seam, so the separation guarantee is checkable at every cadence the table ships.
 */
export function dropLagMsFor(cadenceMs) {
  if (_dropLagOverride !== null) return _dropLagOverride;
  return Math.max(0, (Number(cadenceMs) || 0) * FX_DROP_LAG_FRACTION);
}

/**
 * How the flash is SHAPED — one of the three shapes muzzleSourceSpecs below can build.
 *  - "cone"   a wedge of `coneDegrees` about the shot's axis (the shipped default). At the measured
 *             width that wedge is most of the circle with a NOTCH cut out behind the shooter, not a
 *             narrow forward beam — see the measurement note under MUZZLE_LIGHT.
 *  - "omni"   one circle, no direction needed (what the first build did)
 *  - "hybrid" the wedge plus a faint circular companion
 *
 * EVERY shot has an axis. Where none is named, one is synthesized from the shooter token's own
 * facing before any shape is built (aimPointOf / facingRad below), so the shape a viewer gets does
 * NOT change with whether a target happened to be picked — the two cases are the same effect. The
 * previous build fell back to the circle here, and a shot fired at nothing therefore drew a plain
 * radius; that is the behaviour this note replaces.
 *
 * WHY THE DEFAULT IS THE PURE WEDGE. The reference frame settles it by measurement rather than by
 * taste: the floor is LIT in every direction except one narrow sector directly behind the shooter,
 * where it reads a median luminance of about 4/255 and a median red-minus-blue of −6 — unlit floor,
 * not dimly lit floor. A circle of any strength would put light in that notch, and only a limited
 * angle can cut it. The other two shapes and `spillLevel` are kept so the choice stays a one-word
 * edit rather than a rebuild.
 */
export const MUZZLE_MODE = "cone";

/**
 * How far down the facing axis the SYNTHESIZED aim point is planted, in grid squares, for a shot
 * that names nothing to aim at (aimPointOf). It is a DISTANCE only — the direction is the token's
 * own rotation — and it exists because the sprite, the tracer and the mote spray all need a point to
 * travel toward, not just a heading.
 *
 * Three squares because it has to be far enough that the tracer reads as leaving the muzzle and
 * crossing ground, and near enough that a shot at nothing does not throw a bolt across half the map
 * toward whatever happens to lie along that axis. It sits just past the mote spray's own far edge
 * (MUZZLE_MOTES.farSquares, 2.1 squares), so the spray lands short of the endpoint rather than
 * beyond it, which is the same relationship an aimed shot at ordinary battle-map range has.
 */
export const FACING_AIM_SQUARES = 3;

/**
 * Muzzle-flash light spec (design doc §2.3) — THE one editable block for the flash.
 *
 * Radii are in GRID SQUARES and are multiplied by the scene's grid distance, then by the scene's
 * pixels-per-distance-unit, at build time: a canvas light source takes its radii in PIXELS, where a
 * token light document takes them in scene distance units.
 *
 * The envelope is counted in TRUE RENDER FRAMES, not milliseconds. The reference flash is one to
 * three frames long, which is below the resolution of any timer this host offers — a setTimeout
 * chain asked for 17ms and delivered whatever the frame budget happened to be. Counting the frames
 * the renderer actually produces is both what the reference does and the only way the spec means
 * anything. `nominalFrameMs` is used for REPORTING the envelope length only; nothing schedules on it.
 *
 * INTENSITY is what the envelope animates; the RADII are held constant for the whole flash. That is
 * deliberate and it is the fix for the reported "radiates out visibly" read: a light whose radius
 * grows and then shrinks draws a visible expanding ring, and at the ~1.3s the old document-write
 * transport actually took, that ring was the whole effect. A flash that snaps to full size and fades
 * in place cannot read that way at any frame rate, including a client running far below 60fps.
 *
 * ILLUMINATION ONLY — `color` IS NULL. ⚠ THIS IS THE ONE PLACE WE DELIBERATELY DIVERGE FROM THE
 * REFERENCE, and the reason is a measured engine difference, not a preference.
 *
 * The reference DOES carry a colour: "#943400" at alpha 0.5, and on ITS engine that reads as
 * near-neutral and stays invisible in a lit area (both confirmed on the reproduction rig). The
 * requirement it satisfies is the one that was reported here: "theirs seems to only light up dark
 * rooms, and when the animations were showcased in a light area there was no visible muzzle flash,
 * not even faintly."
 *
 * That requirement does NOT survive the colour on this engine. Rendered on our own rig at the shipped
 * geometry, varying only this field, patches of floor sampled at fixed distances along the aim:
 *                                       LIT (darkness 0, global light on)      DARK (darkness 1)
 *   colour null,  2.5 squares out       delta (0.0, 0.0, 0.0)                  (+86, +86, +86)
 *   colour null,  5 squares out         delta (0.0, 0.0, 0.0)                  (+61, +61, +61)
 *   "#943400",    2.5 squares out       delta (+79, +28, 0.0)                  (+149, +108, +86)
 *   "#943400",    5 squares out         delta (+57, +20, 0.0)                  (+107, +77, +61)
 * Over the whole canvas the coloured source moved 44.8% of the lit frame's pixels; the uncoloured one
 * moved 0.2% (and 0.09 of a level on average, i.e. nothing). So on this core a coloured flash paints
 * a lit room orange where the reference's does not — the coloration layer blends SCREEN over whatever
 * is already there, while the illumination layer blends MAX_COLOR against the scene's own lighting and
 * therefore contributes exactly nothing once the ambient already exceeds it. The user's requirement is
 * the hard one, so the colour is dropped and the neutral half of the reference's look is kept.
 *
 * The suppression is NOT done with an opacity. Core decides per layer whether to render it at all —
 * the coloration shader's own `isRequired` returns `hasColor`, and `hasColor` is set from
 * `data.color !== null` — so a null colour takes the coloration layer OUT of the render entirely
 * (`layers.coloration.active === false`), where `alpha: 0` would merely make a layer that still runs
 * contribute nothing. The keeper asserts the layer flag, not the opacity.
 *
 * Both alternatives stay one edit away: "#943400" is the reference's own value, "#ffae42" the warm
 * yellow-orange this shipped before. Either restores a tinted flash with no other change.
 *
 * ⭐⭐ SUPERSEDED IN PART (FR#23) — THE COLOUR IS NOW DARKNESS-GATED, which keeps both requirements
 * instead of trading one for the other.
 *
 * The report: with the colour dropped the flash "feels too white now", and the user wants the
 * reference match back. The measurement above is still correct and still binding — a coloured source
 * really does paint a LIT room orange on this core (44.8% of the frame's pixels moved, capture 39) —
 * but it only binds in a lit scene. In the DARK, the same colour is what the reference actually looks
 * like, and the illumination-only version is the thing that reads as white.
 *
 * So the source reads the VIEWED SCENE'S darkness when it is built and picks a regime:
 *   darkness >= darknessColorThreshold  ->  colour "#943400" at alpha 0.5, the reference verbatim
 *   darkness <  darknessColorThreshold  ->  colour null, the coloration layer never renders
 * The lit-floor stain therefore stays impossible by construction rather than by opacity: below the
 * threshold `data.color` is null, `hasColor` is false, and core takes the coloration layer out of the
 * render entirely (`layers.coloration.active === false`) — the same mechanism the note above describes,
 * now applied only where it is needed.
 *
 * Read at BUILD time, per flash, not cached: a GM changing scene darkness mid-session gets the right
 * regime on the next shot with no reload, and a client viewing a different scene builds for the scene
 * IT is looking at. The threshold is a knob rather than "> 0" because a scene at darkness 0.1 is still
 * a lit room to a viewer, and the stain measurement was taken at darkness 0.
 *
 * REFERENCE CITATION for the colour itself: `diwako-cpred-additions/scripts/dfAmbientLights.js`, which
 * hard-codes colour "#943400" at alpha 0.5 on the temporary ambient light it creates (the full value
 * list is in the configuration note below, and the reproduction in import-staging/RED-REFERENCE-RIG.md).
 */

/**
 * The flash colour for a scene at `darkness` — the reference's own value in the dark, null in the
 * light. Pure, so both regimes are assertable without a canvas. A non-finite darkness is treated as
 * lit (null), which is the safe half: it can only ever fail to colour, never stain a lit floor.
 *
 * ⭐ `ammoColor` (FR#24) — the loaded round's OWN flash colour, where its overlay names one (AMMO_FX,
 * `flashColor`). It replaces the reference colour INSIDE the dark regime and nowhere else, which is
 * the whole reason the parameter enters here rather than at the source: the darkness gate is
 * inviolable (the 44.8%-of-frame lit-floor stain measured above is what it exists to prevent), and a
 * tint threaded through this function CANNOT bypass it — below the threshold the early return has
 * already fired and the answer is null whatever the ammo asked for. A null/absent ammo colour leaves
 * the reference value exactly as it was, so every unmodified load is byte-identical to before.
 */
export function flashColorFor(darkness, ammoColor = null) {
  const d = Number(darkness);
  if (!Number.isFinite(d)) return null;
  if (d < MUZZLE_LIGHT.darknessColorThreshold) return null;
  const ammo = typeof ammoColor === "string" ? ammoColor.trim() : "";
  return ammo || MUZZLE_LIGHT.referenceColor;
}

/** The darkness of the scene this client is looking at, for the colour regime. 0 when unknown. */
export function viewedSceneDarkness() {
  const scene = canvas?.scene;
  const d = scene?.environment?.darknessLevel ?? scene?.darkness;
  return Number.isFinite(Number(d)) ? Number(d) : 0;
}
export const MUZZLE_LIGHT = Object.freeze({
  // ⭐ TWO REGIMES NOW (FR#23) — `color` is no longer one value, it is chosen from the VIEWED SCENE'S
  // DARKNESS at the moment the source is built. See flashColorFor and the two-regime note above.
  color: null,            // the LIT regime, and the measured divergence the note describes
  referenceColor: "#943400",   // the DARK regime — the reference's own value, verbatim
  darknessColorThreshold: 0.25,// at or above this scene darkness the reference colour is used
                          // Knob: "#ffae42" is the warm yellow-orange this shipped before
  brightSquares: 12.5,    // reference-exact: bright == dim, so attenuation does ALL the falloff
  dimSquares: 12.5,
  attenuation: 1,         // reference-exact, and core's maximum: the fade spans the whole radius
  alpha: 0.5,             // reference-exact; the coloration layer's intensity, inert while color is null
  luminosity: 0.65,       // ⏱ RAISED ON REPORT (FR#23) — "I'd like them to feel pretty violent". The
                          // reference-exact value was 0.5 (confirmed against the guide's own module);
                          // this is a deliberate departure upward, and the ONE knob that carries it.
                          // It cannot reintroduce the lit-floor stain: that is the coloration layer's
                          // doing, and in a lit scene the colour is null so the layer does not render.
  nominalFrameMs: 17,     // one frame at 60fps — reporting only, nothing is scheduled on it
  attackFrames: 1,
  holdFrames: 2,
  decayFrames: 2,
  attackLevel: 0.6,       // intensity of the ramp-in frame(s), as a fraction of the held value
  decayLevel: 0.4,        // intensity of the final fall-off frame, as a fraction of the held value
  coneDegrees: 270,       // the LIT wedge — reference-exact; see the note below
  spillLevel: 0.35,       // hybrid mode only: the circular companion's intensity, as a fraction
});

/**
 * WHERE THE LIGHT VALUES COME FROM — the reference's OWN CONFIGURATION, read out of the module that
 * creates it. This supersedes the frame measurements that stood here before; those were the best
 * available until the guide's setup was reproduced, and they are kept below as corroboration because
 * they agree with the configuration to within a degree.
 *
 * ⚠ WHAT ACTUALLY MAKES THE REFERENCE FLASH (the open question, now closed): not the animation
 * module, not the sequencer, not the asset pack, and not the RED system. A bridge module
 * (`diwako-cpred-additions`, `scripts/dfAmbientLights.js`) listens for the animation workflow and
 * CREATES A TEMPORARY AMBIENT LIGHT on the scene, pre-loaded with keyframes that strobe it, then
 * deletes it. Every value below is hard-coded there — the animation export carries no light
 * configuration at all. The reproduction is recorded in import-staging/RED-REFERENCE-RIG.md.
 *
 * THE VALUES, verbatim from that module and confirmed live:
 *   angle 270 · attenuation 1 · luminosity 0.5 · alpha 0.5 · colour "#943400" · animation type null
 *   dim and bright are BOTH keyframed 0 ↔ 25 SCENE UNITS — measured live at 1250px on a 100px/2m
 *   grid, i.e. 12.5 grid squares.
 *
 * ⭐ bright EQUALS dim, which is the structural point and not an accident: with no bright/dim split
 * there is no inner plateau and no bright→dim boundary, so `attenuation` (at core's maximum, 1) does
 * ALL of the falloff across the whole radius. That is what "smooth" means here — one gradient from
 * the middle to nothing, with no edge anywhere to see. Our earlier 3/6 split with attenuation 0.63
 * approximated the same look with two overlapping gradients; this is the thing itself.
 *
 * THE CORROBORATION (the earlier measurement off the reference FRAME, which stands):
 *  - Radial luminance/warmth binning about the shooter, in three annuli with the interface masked,
 *    put the unlit notch at 91–96° wide, centred within about 5° of directly opposite the shot —
 *    against the configured 90° notch that angle 270 produces. The frame agreed to a degree or two.
 *    The edges were RADIAL from the shooter and held the same angle across a 260px change in radius,
 *    which is a limited-angle source at that point and not a shadow cast by scene geometry.
 *  - Radial falloff, same frame: a plateau of about 46/255 out to ~2.7 squares, then a monotonic
 *    decay — 38 at 2.9, 31 at 3.2, 27 at 3.9, 25 at 4.6, 22 at 5.3, ~19 at 5.8 squares — still clear
 *    of the ~5 unlit floor at six squares, with no step anywhere. That profile is what a single
 *    attenuation-1 gradient over a 12.5-square radius looks like once it has been through a video
 *    frame; it is also why the provisional 3/6 read as "about twice what we were drawing" rather
 *    than as the whole answer.
 *
 * The sprite measurements from the same frame are unchanged and are what the wedge must exceed: the
 * starburst's ray fan spans about 45–55° across and the mote spray about 34°, so at 270° the pool is
 * several times either and cannot read as part of the sprite.
 *
 * ⚠ WHAT WE DO DIFFERENTLY, DELIBERATELY — the strobe. The reference flashes by animating the
 * RADIUS: its keyframes drive dim and bright 0 → 25 → 0, about 50ms on per shot, repeated at the
 * animation's own cadence (ten times for autofire). We hold the radii CONSTANT and animate INTENSITY
 * instead (muzzleFrameLevels, restarted per round at classCadenceMs). The two read the same at a true
 * frame rate — a light that appears and vanishes inside three frames does not show which parameter
 * moved — and the intensity form is the one that CANNOT reproduce the "radiates out visibly" ring
 * this transport was rewritten to remove: a radius that grows and shrinks draws an expanding ring the
 * moment the client cannot deliver those frames on time, which is exactly the failure that was
 * reported here before. So the equivalence is on purpose, and the divergence is the safer half of it.
 */

/**
 * Hard stop for a flash whose per-frame driver stops getting frames. A browser suspends the renderer
 * on a hidden tab, and a client whose renderer is suspended mid-flash would otherwise keep a source
 * in the lighting collection indefinitely — a token permanently lit, which is the one failure mode
 * this transport must not reintroduce. Enforced from a TIMER as well as from the frame driver,
 * because a stalled renderer is exactly the case where the frame driver cannot enforce anything.
 * Well clear of the envelope even on a client rendering at a few frames per second.
 */
export const MUZZLE_MAX_MS = 2000;

/** Miss divergence for the tracer (design doc §2.4): angle offset and how far short/wide it lands. */
export const MISS_SPREAD_RAD = 0.209;   // ≈12°
export const MISS_REACH_MIN = 0.6;
export const MISS_REACH_MAX = 1.15;

/**
 * How the MUZZLE SPRITE is drawn — the block the "too large / a plume of smoke and fire" report
 * changed. Read with the size fields on the class rows below.
 *
 * WHAT THE ASSET ACTUALLY IS (read off the installed free tier, not assumed): the tier's one
 * muzzle-flash family is `MuzzleFlashSingle01_01_Regular_Yellow_600x300.webm`, declaring a 100px
 * design grid — so played untouched it draws SIX GRID SQUARES wide, and at the previous build's
 * `scale: 0.7` it drew 4.2 squares. That alone is the size complaint. The shape complaint is the
 * other half and it is in the ANIMATION: photographed frame by frame on the rig, the clip opens as a
 * compact forward lance and then develops into two billowing fire-and-smoke clouds that dwarf the
 * lance. That later phase IS the reported plume, and no amount of scaling removes it — scaled down it
 * is simply a small plume. So the fix is two-part: SIZE the sprite in grid units (a spec, the same
 * idiom the pellet dash uses) and TRIM the clip to its opening.
 *
 *  - `endMs` — how much of the clip plays, in CLIP milliseconds. MEASURED, not guessed: the clip runs
 *    0.833s (read off the installed file), the lance occupies roughly its first 0.10s, and the clouds
 *    own the rest. 110ms keeps the whole lance, stops before the first cloud, and lands within a few
 *    milliseconds of the native flash light's own envelope (muzzleEnvelopeDurationMs, 85ms) — so the
 *    sprite and the light now go out together instead of the sprite billowing on for another 0.7s.
 *    ⚠ APPLIED AS A TIME RANGE, and that is not interchangeable with the percentage form. The engine's
 *    `endTimePerc` was tried first and MEASURED TO DO NOTHING on this build: timing how long the effect
 *    stayed in the engine's own list gave 1752ms with the percentage trim against 1634ms untrimmed,
 *    i.e. no cut at all, while a time range gave 861ms — the ~770ms saving a 833s→110ms cut predicts.
 *    The photographs said the same thing before the timing did: the trimmed-away plume was still in
 *    them. Do not swap this back to a percentage without re-measuring.
 *  - `edgeFraction` — how far along the aim line the sprite is planted, as a fraction of the shooter
 *    token's own width, so a bigger token's muzzle sits at ITS edge rather than at a fixed distance.
 *    The reference puts the flash at the token's forward edge, not at its centre, and a sprite drawn
 *    from the centre reads as a flash coming out of the shooter's chest.
 */
export const MUZZLE_SPRITE = Object.freeze({
  endMs: 110,
  edgeFraction: 0.5,
});

/**
 * HOW LONG THE LANCE STAYS ON SCREEN, per class — and why that is a separate number from the trim.
 *
 * Reported (FR#21): "the cone shaped starburst that appears for the rifle shots should be present, but
 * it's not" — on the shotgun. Measured on the rig, in this order, and the first two answers were both
 * "nothing is wrong":
 *   1. QUEUED? Yes — fxShot returns `muzzle: true` for the shell, off the same row field every class
 *      uses, and the key resolves on the installed tier.
 *   2. DRAWN? Yes — one lance sprite on the canvas per round, at 190x96 world px for the shell's 1.9
 *      squares (the LARGEST of any class; the rifle's 1.6 draws 160x80), above lighting, not occluded.
 *   3. FOR HOW LONG? This is where it went. The trimmed range is 110ms of CLIP, and at playback rate 1
 *      that content is spent so fast that the effect's own video had already finished advancing before
 *      the effect became observable in the engine's list at all (clip span measured as 0ms across an
 *      8ms sampler, against 92ms at rate 0.5 and 60ms at 0.33). The effect object then lingers ~790ms
 *      showing nothing more.
 * So the asymmetry is not in the shell at all — it is in the ROUND COUNT. The rifle is fired on auto:
 * ten lances restart at an 80ms cadence, which a viewer reads as one sustained flash. The shotgun's
 * ordinary pull is ONE round, so the identical lance gets one 110ms life and is over before the eye
 * settles. Same sprite, same code, opposite read.
 *
 * THE LEVER IS THE RATE, NOT THE RANGE, and that distinction is load-bearing: extending the time range
 * would let the clip's billowing fire-and-smoke phase back in, which is the exact thing FR#14 trimmed
 * away and which was reported as "a plume" before it was cut. Slowing the playback stretches the SAME
 * 0-110ms of content over more wall clock, so what is shown is byte-for-byte the ruled lance and only
 * its dwell changes.
 *
 * `muzzleMs` on a class row is that dwell in wall-clock milliseconds; the rate is derived from it
 * (muzzleRateFor). A row that omits the field dwells for the trim itself, i.e. rate 1 and not one
 * property changed — so only the class that reported the problem moves.
 *
 * ⏪⏪⏪ THE SHELL ROW NAMES ONE AGAIN (2026-08-09), and the round trip is the point of keeping the
 * chain — the mechanism was right the whole way through and only its host kept changing:
 *   FR#21 ADDED the dwell, for the shell alone, because its single discharge's lance was over before
 *     the eye settled while an automatic's restarts read as sustained.
 *   FR#22 gave the shell a bullet.02 DISCHARGE COLUMN, whose own built-in bloom sits at the barrel,
 *     and the user ruled on seeing the two together: "the newly added spiky cone looks great, but the
 *     flame lance from before still sits below it and it doesn't look good. Remove the flame lance."
 *     So the shell drew NO lance, and this dwell went unused — while the column promptly grew a trim,
 *     a dwell and a derived rate of its OWN, i.e. a second copy of exactly this mechanism.
 *   2026-08-09 the column was DELETED and the lance came back (see the deletion block above the class
 *     table). The shell's dwell is `muzzleMs: 220` — the same number FR#21 ruled, now carried by the
 *     one mechanism instead of two.
 * So the field is live again on exactly one row, which is what it was built for: only the class that
 * reported the problem moves, and the other four still play at rate 1.
 */
export const MUZZLE_DWELL_DEFAULT_MS = MUZZLE_SPRITE.endMs;

/**
 * The SPIKY half of the starburst, drawn on top of the aimed lance — optional per class (`spark`).
 *
 * ⛔ NO CLASS ASKS FOR IT ANY MORE — USER RULING, 2026-08-08, after a matched A/B on the rig (eyes-on
 * 45/46 rifle, 45b/46b pistol: identical shot, identical framing, the field the only difference).
 * The verdict on the radial star was that it reads as "magical" and "busy" for a firearm, and that
 * "the angled one is good enough, and should work for all weapon types that shoot bullets in a
 * straight line" — the shotgun included, asked and answered separately. Three things the captures
 * make plain, kept here as the reasons rather than the taste:
 *   - it is RADIAL, so its rays fire BACKWARD across the shooter's own token; nothing about a
 *     discharge throws light behind the barrel, and a symmetric star is a sparkle idiom, not a gun one;
 *   - `squares` is a fixed size for every class, so it dominates a small muzzle — it is proportionally
 *     largest on the pistol, the class with the least flash to compete with it;
 *   - the aimed lance ALONE still sells the discharge (46/46b), and does it pointing the way the shot
 *     went, so nothing load-bearing was lost by dropping it.
 * What is genuinely given up is the spiky read: the lance is smoother and more flame-like than the
 * reference's forward ray fan. The tier offers no third option (see the finding below), so that is the
 * trade the ruling accepts.
 *
 * THE MECHANISM IS DELIBERATELY LEFT INTACT rather than deleted, and this block with it: the draw is
 * still gated on the per-class `spark` field, so re-enabling it anywhere is adding ONE field back to
 * that class's row in FX_CLASSES — nothing else moves, and a class carrying it still gets exactly the
 * treatment described below. The keeper pins both halves: no class queues it as shipped, and a row
 * given the field still does.
 *
 * The honest finding behind this: the free tier has NO directional spiky starburst. Its muzzle family
 * is the smooth lance above; its spiky stars (the `impact` family) are RADIAL and carry a thin
 * shockwave ring. The reference's flash is both — a forward-biased fan of thin rays, measured at
 * −24°…+33° about the aim line, over a white core. Neither asset delivers that alone, so the shipped
 * flash is the aimed lance for the direction plus a small radial star for the spikes, planted at the
 * same muzzle point where the star's rear rays fall on the shooter token itself — which is what the
 * reference shows too. `impact.006.yellow` is the chosen star: white core, thin yellow rays, the
 * smallest ring of the yellow impacts on the tier.
 *
 * A class that omits `spark` gets the lance alone; setting the key to something the tier does not
 * carry degrades to the lance alone as well (fxDbEntryExists gates it).
 *
 * NO TRIM on this one, unlike the lance: the clip is 0.267s end to end (measured off the installed
 * file) and its rays only form in the back half, so trimming it is trimming the spikes off. The lance
 * is trimmed because its clip is three times longer and its tail is the plume; this one has no tail.
 * That untrimmed length is named here as `clipMs` because it is the LONGEST thing a single round puts
 * on screen, which makes it the floor for how long one round's presentation lasts (presentationTailMs).
 */
export const MUZZLE_SPARK = Object.freeze({
  key: "jb2a.impact.006.yellow",
  squares: 0.8,
  clipMs: 267,
});

/**
 * THE SELF-LUMINOUS ROUTE — how the rail's own sprites are kept out of the lighting layer, which is
 * the fix for "the tracer renders dark".
 *
 * ⚠ THE FIRST FIX FOR THIS WAS WRONG, AND THE CORRECTION IS THE POINT OF THIS BLOCK. It set a high
 * `elevation` (999) on every lit sprite, on the reading that the reference "creates its projectile at
 * elevation 999". Elevation does not do that job. Read off the engine's own source, the layer an
 * effect is parented to is chosen ONLY by its route flags — `_addToContainer()` picks
 * `screenSpaceAboveUI` / `screenSpace` / `aboveInterface` / `aboveLighting`, and otherwise
 * `canvas.primary`, with elevation never consulted. `canvas.primary` IS the group the darkness is
 * multiplied over, so an elevated sprite is darkened exactly like an unelevated one; elevation only
 * sorts it within that group.
 *
 * ⚠ MEASURED ON THE RIG, darkness 1.0, luminance in a band along the shot line, muzzle light off,
 * against the same band before the shot (mean delta / peak delta / share of the band lit):
 *   pistol, elevation only .............  0.30 /  15 / 0.8%     ← invisible
 *   pistol, aboveLighting ..............  4.61 / 232 / 6.5%
 *   rifle,  elevation only .............  0.84 /  15 / 3.1%     ← invisible too
 *   rifle,  aboveLighting .............. 17.63 / 232 / 21.4%
 *   pistol, elevation only, NO filter ...  0.23 /  15 / 0.6%
 *   control: the muzzle light held open . 83.68 / 179 / 100%
 * The tell is the PEAK: every elevation-only case crushes to the same ceiling of 15 out of 255
 * whatever the class or the filter, and the same asset reaches 232 the moment it is routed above the
 * lighting. So the colour matrix was never the cause (filtered and unfiltered read alike), and it was
 * never a pistol-only fault — the pistol is just where it shows first, because `bullet.01` is the
 * thin asset and lights about a fifth of its own frame, so it has the least left to survive the
 * crush. The report said pistols; the defect was every class.
 *
 * WHAT GETS THE ROUTE, and what deliberately does NOT: everything the rail draws that is supposed to
 * EMIT light (the muzzle lance, the spark, the tracer/pellets, the mote spray, the hit confirmation)
 * goes above the lighting. The SMOKE WISP does not — smoke does not glow, and a wisp that stayed
 * bright inside an unlit room would read as a lamp rather than as smoke. That split is the rule to
 * apply to anything added later: self-luminous goes up, lit-by-the-world stays down.
 *
 * ⚠ THE TRADE THIS MAKES, stated so it is a choice and not a surprise: the route parents the sprite
 * to the interface group, which is above the VISION mask as well as the lighting — so a lifted sprite
 * is drawn even across ground the viewer cannot see. That is what "self-luminous" costs here; the
 * engine offers no route that clears the darkness but keeps the vision mask. The muzzle LIGHT is
 * unaffected and still clips to walls (it is a real light source, not a sprite), so the flash stays
 * honest about the room even when the bolt is drawn over it.
 */
export const LIT_SPRITE_ABOVE_LIGHTING = true;

/**
 * How long a TRAVELLED pellet stays alive AFTER it has arrived — the fix for "the shells hit, but
 * visibly they always fall short".
 *
 * ⚠ THE MECHANISM, because it is not the one it looks like. The endpoints were never short: read off
 * the live engine, each pellet's own target position came back at the aimed-at token's centre, fanned
 * across the cone exactly as pelletEndpoints builds it (target centre 1750,1950; the six pellets asked
 * for 1748–1750 x 1901–1999). What went wrong was the CLOCK. The engine drives a moved effect for
 * `movementDuration`, and with no speed set that is the effect's whole lifetime — so the sprite was
 * scheduled to arrive at the same instant it was destroyed. The arrival frame therefore never existed
 * to be seen, and worse, the movement is stepped by the RENDER loop while the lifetime is a wall-clock
 * timeout: on a client that is dropping frames the interpolation gets fewer steps than the timeout
 * gets milliseconds, so the sprite dies part-way. Measured on this rig at 700px of shot line, six
 * pellets, sampling the animated property on a clock rather than per frame: every pellet was destroyed
 * at 0.778 of the line — 155–162px short of the target centre, against a token half-width of 50px, so
 * a good square and a half short of touching it. A coarser per-frame sample of the same shot read
 * 0.556. That spread between two samples of one unchanged build is itself the tell: the shortfall is
 * however far behind the wall clock the render loop happens to be.
 *
 * THE FIX IS TWO PARTS, and both are needed:
 *  - the travel is driven by a SPEED (moveSpeed, pixels per second) instead of by the lifetime, so
 *    `dashMs` keeps its meaning as the crossing time and no longer doubles as the sprite's death;
 *  - the lifetime is the crossing time PLUS this hold, so the pellet is still on screen once it
 *    arrives — which is what makes the arrival visible at all — and so a render loop running behind
 *    the wall clock has slack to finish the interpolation instead of being cut off mid-flight.
 *
 * The value is set by the slack it has to cover rather than by taste: a client stepping the render
 * loop a few times a second is ~100ms per step, so this carries roughly two steps of lag and still
 * reads as a beat rather than as pellets parked on the target. It is spent as a FADE (the pellet
 * fades over the hold rather than blinking out), and it overlaps the HIT CONFIRMATION, which is
 * delayed by the same crossing time — so the impact goes off while the pellets are still there.
 *
 * A MISS is deliberately untouched by all of this: the miss splay sends each pellet to its own reach,
 * one muzzle velocity carries it there in its own time, and it still lands wide or short of the token
 * exactly as the divergence design intends. Arriving is a property of a HIT, not of the mechanism.
 */
export const DASH_ARRIVAL_HOLD_MS = 260;

/**
 * The HIT CONFIRMATION — one impact drawn at the aimed-at point for each round that LANDS.
 *
 * The rail could already say a round was fired; nothing on the canvas said whether it arrived, and
 * the fan-out has always known (it assigns hits to the leading rounds of the burst and hands each
 * shot its own `hit`). So this is the miss/hit distinction becoming visible rather than a new fact.
 *
 * `key` is a radial impact from the free tier, deliberately a DIFFERENT family from the muzzle
 * spark's so the two ends of the shot do not read as the same mark; per-class width is the row field
 * `impactSquares`, on the same footing as `muzzleSquares`. `delayFollowsTracer` waits for a travelled
 * dash to arrive before the impact is drawn — a class whose tracer crosses in `dashMs` would
 * otherwise confirm the hit while its own pellets were still in the air. A painted (stretched) tracer
 * is drawn across the whole line at once and needs no delay.
 *
 * ⭐ `key` IS NOW A DEFAULT RATHER THAN THE ANSWER (FR#24). fxShot plays `entry.impactKey` where the
 * resolved row names one and this key otherwise, so a class row or an ammo overlay can promote the
 * mark — the incendiary load's fire impact, the armour-piercing load's ground crack — with no new
 * branch: the existing tier gate simply guards the resolved key instead of this one. `clipMs` likewise
 * became the DEFAULT trim length (`entry.impactClipMs`), which is what keeps a promotion from moving
 * the apply window; the rule and what it costs are stated in the impact-promotion block below AMMO_FX.
 */
export const HIT_CONFIRM = Object.freeze({
  key: "jb2a.impact.005.orange",
  delayFollowsTracer: true,
  // Measured off the installed file (833ms). This is the LAST thing a landing round puts on screen,
  // so it is what "the action has finished" means for that round — see presentationTailMs.
  clipMs: 833,
});

/**
 * THE BURNING GROUND — small flames left burning ON THE GROUND WHERE THE ROUNDS LANDED, for a payload
 * carrying a load that sets fires. N flames per payload, one placement event per payload.
 *
 * ⏪⏪ THE PREVIOUS ANSWER WAS REJECTED OUTRIGHT (user, 2026-08-09), and both halves of it were wrong:
 * the ASSET and the PLACEMENT. What shipped before was one `jb2a.ground_cracks.orange` at the aim
 * point, for 3200ms. Verbatim: *"it looks like a ground shock effect of some kind, not fire. It darkens
 * and cools, making it not look like an active flame. I was picturing something more like little
 * animated flame decals that stayed burning on the ground in the places the shots landed, not just on
 * the target."*
 *
 * ⚠ THE "DARKENS AND COOLS" WAS PARTLY OURS, and the measurement says which part. Decoded off the
 * installed GroundCrackLoop file, its own luminance is FLAT across the clip — mean 55-57/255 and 46% of
 * the frame lit, at every one of twelve sample points. So the clip does not cool; what cooled was
 * OUR envelope, a 900ms fade-out on a 3200ms life, i.e. the last 28% of the element was a dim-down.
 * The other half of the report is the asset itself: it draws glowing FISSURES in the floor, which is
 * a cooling-magma picture and not a flame however long it is left up. Recorded because the two have
 * different fixes and only one of them is a knob.
 *
 * ⭐ THE ASSET, chosen from a closed enumeration of the installed tier (2061 keys; every family whose
 * name carries fire/flame/burn/ember/torch/brazier/lava/scorch/crack, decoded frame by frame — the
 * survey is in the doc's §6 entry). `jb2a.flames.orange.03.1x1` is authored by its own filename as a
 * 05x05ft GROUND patch, so it is a square top-down plate rather than a side elevation: the two other
 * genuine loops in the tier that hold their light (`Flames04`, `Campfire03`) are 400x600 and 400x1000
 * portraits, which is a flame seen from the SIDE and reads as a wall sprite laid flat. It is a true
 * loop — 5000ms, and the tail third of the clip measures BRIGHTER than its own middle (ratio 1.19),
 * which is the property the report demands: it cannot decay to dark inside its loop because it does
 * not decay at all. The rejected candidates and why are in the doc.
 *
 * ⭐ N FLAMES, AT THE LANDING POINTS — the ruling's own words, and the reason this block now carries
 * geometry constants. Where the landing points come from depends on what the class draws, and neither
 * answer is invented here (see groundFirePoints): a class that draws a FAN already computes real
 * per-pellet endpoints, so a subset of those IS where its shot landed; a class that draws one bolt
 * puts every round on the same aim point, so the rounds are scattered around it inside
 * `scatterSquares`. The scatter is DETERMINISTIC, seeded off the payload — see seededRng.
 *
 * ⚠ THE GATE MOVED FROM "ONE FIRE" TO "ONE PLACEMENT EVENT", deliberately, and the bound it was
 * protecting is unchanged. The old rule existed because the fan-out caps at MAX_FX_SHOTS (30) rounds
 * and a per-ROUND lingering element would put thirty fires on one square for one trigger pull. That
 * still holds: the call site is still outside the round loop, so the loop can never multiply this, and
 * `maxPerPayload` bounds what one placement may draw regardless of how many rounds landed.
 *
 * ⚠ AND A SECOND BOUND, because these now live for the best part of a minute: `maxLive` is a cap on
 * how many flames may be burning on a scene AT ONCE, across bursts, enforced by ending the OLDEST
 * before placing (fxGroundFire). Evicting the oldest rather than refusing the newest is the right way
 * round: the shot a viewer is watching is the one that must be drawn.
 *
 * `lifetimeMs` IS THE "STAYED BURNING" REQUIREMENT, and it is a look call rather than a measurement —
 * tens of seconds, on the precedent the (since-removed, see the block below) ground mark set for a
 * session-bound element with a cap in place of a persistence ruling. The precedent outlived the
 * element that set it: this number is still a cap, and it is still not forever.
 * `fadeOutMs` is a burn-DOWN at the very end and not a dim-through: it
 * is 5.6% of the life here, against the 28% that produced the report.
 *
 * ⚠⚠ THE TRADE, ACCEPTED BY THE USER RATHER THAN HIDDEN: this is self-luminous, so it takes the
 * above-lighting route (LIT_SPRITE_ABOVE_LIGHTING) like every other thing on this rail that emits
 * light — and that route is above the VISION mask as well as the darkness, so a fire burning behind a
 * wall is drawn to a viewer who cannot see that square. The engine offers no route that clears the
 * darkness and keeps the mask (the measurement and the finding are in the LIT_SPRITE_ABOVE_LIGHTING
 * block). The alternative was a fire that is invisible in the dark, which is the only place it exists
 * to be seen. The muzzle LIGHT is unaffected either way — it is a real light source and still clips.
 *
 * ⛔ EXCLUDED FROM THE SETTLE SIGNAL, deliberately and by construction: nothing here is given a
 * settleTag name, and presentationTailMs takes no term for it. The apply window opens when the last
 * ROUND has finished, per the 2026-08-08 ruling; a fire that is meant to go on burning afterwards is
 * scene dressing in exactly the sense that ruling names, and waiting for it would hold the damage
 * window shut for three quarters of a minute.
 */
export const GROUND_FIRE = Object.freeze({
  key: "jb2a.flames.orange.03.1x1",
  // The drawn FRAME width in grid units, and unusually for this file the ink very nearly fills it —
  // measured on the dark range against 0.5 / 0.7 / 1.0 / 1.6 side by side, 0.5 reads as a spark and
  // 1.6 reads as a bonfire covering the square. 0.9 is a fire a body could stand next to.
  squares: 0.9,
  lifetimeMs: 45000,
  fadeInMs: 250,
  fadeOutMs: 2500,
  opacity: 0.9,
  // How far a landed round may fall from the aim point, in grid units, when the class gives the rail
  // no per-round geometry of its own. A radius, not a diameter.
  scatterSquares: 0.8,
  // The most flames ONE payload may place, however many rounds landed.
  maxPerPayload: 4,
  // The most flames one PATTERN may scatter down its own length (the shot-pattern flow).
  maxPerPattern: 5,
  // The most flames that may be burning on a scene at once, across bursts. Oldest out.
  maxLive: 24,
});

/** The name every burning-ground flame is stamped with, so the scene cap can find and evict them. */
export const GROUND_FIRE_NAME = `${SCOPE}.groundfire`;

/* ══════════════════ THE GROUND MARK — REMOVED 2026-08-10 ══════════════════
 *
 * ⏪⏪ The dark decal the burning ground used to leave behind is GONE on user ruling, verbatim: *"kill
 * it"*. The flames above are unchanged; only the mark under them was withdrawn. What stood here was a
 * GROUND_SCORCH constant, a draw site in fxGroundFire, and the `scorch`/`scorchMs` fields on that
 * verb's return shape — all three are deleted rather than left switched off, because a field that is
 * always false is a mechanism a later reader has to disprove.
 *
 * THE FINAL SPEC, recorded so a revert is a transcription and not a rebuild: key
 * `jb2a.scorched_earth.black`, 1.5 squares, opacity 0.7, lifetime 180000 ms, fadeIn 600, fadeOut 3000,
 * `loopOptions({ loops: 1 })` (load-bearing — the asset is 6250 ms and an effect outliving its clip
 * re-blooms by default), BELOW the lighting (it is not a light source, so the file's routing rule put
 * it down), and exactly ONE per payload at the CENTROID of the flames, delayed by the same arrival
 * time they take.
 *
 * The two facts that outlive it, because they were never its alone: the fire's own `lifetimeMs` was
 * set on the precedent this element established for a session-bound element with a cap in place of a
 * persistence ruling; and REAL decal persistence is still an open question, now carried by the blood
 * splash by itself (see the doc's open items).
 */

/**
 * THE BLOOD SPLASH — a short red burst drawn over a LIVING target that a round actually reached.
 * Phase 1: transient only. Nothing is left on the floor and nothing is written anywhere.
 *
 * ⚠ THE GATES are somewhere else on purpose — this block is only the look. The world setting
 * (`goreEnabled`, default OFF), "at least one round landed" and "the target is not structure" are all
 * resolved ONCE at the call site in fxWeaponFired; only the per-round issue and the cap live in the
 * loop. See that site for why the gates and the draws are now in two different places.
 *
 * ⏪⏪ ONCE PER PAYLOAD IS DEAD (user ruling 2026-08-09, on the MPK-9 burst). The first build drew one
 * splash for a whole payload — deliberately, as the burning ground still does — and a ten-round burst
 * therefore marked its target exactly as hard as a single shot did. The rule is now ONE SPRAY PER
 * LANDING ROUND, bounded by `maxPerPayload`.
 *
 * ⭐ WHY THE CAP IS 4, measured rather than picked. The clip lives 900 ms and the hits are the leading
 * rounds of the burst, so at the default 80 ms cadence ten hits would put ten sprays inside one clip's
 * life — every one of them still on screen while the next arrives, which is a fountain rather than a
 * body being hit repeatedly. Four is the most that still reads as SEPARATE events: at 80 ms apart they
 * are four distinguishable arrivals spread over the burst's opening, and each is still visible when the
 * next lands, which is the "repeated spray" the ruling asks for. The cap is a payload bound, not a
 * scene bound — a second burst sprays again.
 *
 * ⭐ THE ASSET IS NATIVELY BLOOD-COLOURED — no colour filter is applied. The free tier carries no
 * family NAMED blood, which is true and is what the earlier survey found; but `jb2a.liquid.*` ships RED
 * variants, and decoding off the installed files gives near-black deep red in every frame with the
 * green and blue channels essentially at zero. A ColorMatrix over that would be repainting red with
 * red.
 *
 * ⏪⏪ THE RADIAL SPLASH IS SUPERSEDED (user ruling 2026-08-09, verbatim: *"It's angled. The blood
 * pushes out in a direction. It should move in the same direction as the bullet that strikes the
 * target."*). The first build chose `liquid.splash02.red` precisely BECAUSE it is radial — its ink
 * centroid holds at 0.50/0.51 of its own frame from 170 ms to 510 ms, so it needed no rotation and
 * could never disagree with the shot axis. That safety is exactly what made it wrong: a radial burst
 * says the wound has no direction. The shipped asset is now `liquid.splash_side02.red`, whose ink
 * TRAVERSES its own frame 0.29 → 0.65 left-to-right — a directional wave — and it is rotated so that
 * travel continues the shooter→target vector THROUGH the target: the spray leaves on the far side,
 * away from the shooter, as an exit. The rotation basis is the tracers' own (`rotateTowards` at a point
 * further along the same ray), so the spray and the round that caused it can never disagree about which
 * way the shot was going.
 *
 * `squares` IS THE DRAWN FRAME, NOT THE INK — the same trap the flechette dart length records. The
 * ink reaches 0.50 of the frame at 170ms and peaks at 0.87 at 510ms, so at 1.5 squares the splash
 * opens at about three quarters of a square and peaks a little wider than one: a mark the size of the
 * body it is on, growing past its edges, rather than a pool over the neighbouring squares.
 *
 * `clipMs` is a trim, and it is chosen where the CONTENT ends rather than where the file does. The
 * clip runs 1133ms but its ink is spent well before that: coverage falls from 17.1% of the frame at
 * 283ms to 0.07% at 680ms, and peak alpha is 5/255 by 963ms. 900 keeps every frame that has anything
 * in it and drops a dead tail, and it holds the element inside the "under a beat" the user asked for.
 *
 * ⚠⚠ ABOVE THE LIGHTING, WHICH IS A DELIBERATE DEPARTURE from this file's own routing rule (the rule
 * is in LIT_SPRITE_ABOVE_LIGHTING: self-luminous elements go up, lit-by-the-world elements stay
 * down). Blood is not a light source, so the rule as written
 * would put it below — and measured on the rig's own dark range at darkness 1.0 that is not a dimmer
 * version of the effect, it is no effect at all. The trade is therefore between an element that is
 * invisible exactly where a table plays and an element drawn across ground the viewer cannot see;
 * the second is the lesser cost HERE and only here, because this element lives for under a second.
 * The one element that took the other side of the same trade — a dark ground mark that stayed down
 * and therefore vanished on a dark range, for minutes at a time — was removed on 2026-08-10 (the note
 * beside GROUND_FIRE), so this is now the only place the departure is taken. It is a knob rather
 * than a constant in the code path so the call can be reversed without finding the draw site.
 *
 * ⛔ EXCLUDED FROM THE SETTLE SIGNAL, by construction and not by a flag: nothing here is given a
 * settleTag name and presentationTailMs takes no term for it, so the damage window never waits on
 * it. Same ruling as the burning ground — the action is over when the last round's own terminal
 * elements end.
 */
export const BLOOD_SPLATTER = Object.freeze({
  key: "jb2a.liquid.splash_side02.red",
  squares: 1.5,
  clipMs: 900,
  aboveLighting: true,
  maxPerPayload: 4,
});

/**
 * How long a PAINTED (stretched) tracer stays on screen, in milliseconds — the other candidate for the
 * last thing a round draws, and the one that matters when a round MISSES and draws no impact.
 *
 * Measured off the installed files: the two mapped bullet families run 533–933ms, and `bullet.01`
 * varies with the distance band the ranged entry hands back (533 / 533 / 633 / 833) while `bullet.02`
 * is a flat 933. This is the LONGEST of them, taken as one constant rather than modelled per band and
 * per class: it is an upper bound on a value that is only ever compared against the impact's 833ms,
 * and being a shade generous here costs a fraction of a second on a miss while being wrong the other
 * way would cut the tracer off mid-flight. A TRAVELLED tracer does not use this — its own on-screen
 * life is its crossing time plus DASH_ARRIVAL_HOLD_MS, both of which the table already names.
 */
export const TRACER_CLIP_MS = 933;

/**
 * WHEN A PAINTED (STRETCHED) ROUND ACTUALLY ARRIVES — the missing half of this rail's second clock,
 * measured per distance band off the installed files.
 *
 * ⏪ THE DEFECT THIS ANSWERS (user, at the bench, 2026-08-11): *"blood splashes and dust/impact marks
 * play when the round DEPARTS"*, and worst on the rifle and the heavy — the two classes whose round is
 * on screen longest. The mechanism was one expression: the impact was held back by
 * `dashSquares > 0 ? dashMs : 0`, so only a TRAVELLED round had an arrival at all and every PAINTED
 * one confirmed its hit in the same tick the muzzle lit. Four of the five shipped classes are painted,
 * so the bug was the ordinary case rather than an edge of it. The same zero reached the blood splash
 * through `arrivalMs`, which is why the two elements were reported together.
 *
 * ⚠ A PAINTED ROUND HAS AN ARRIVAL — it just is not one this file was computing. `stretchTo` scales the
 * asset across the whole shooter→aim line in one go, but the asset is not a static streak: it animates
 * a head travelling from one end of its own frame to the other, and the engine hands back a DIFFERENT
 * FILE per distance band, each animating that crossing over its own span. So the arrival is a property
 * of the band, exactly as the volley's is, and it is read off the file rather than guessed.
 *
 * ⭐ MEASURED, NOT PICKED (2026-08-11, decoded off this rig's installed JB2A free tier). Per frame, the
 * RIGHTMOST lit column of the frame was taken as the head's position, and the arrival is the first
 * frame at which that leading edge stops advancing — 98% of the clip's own maximum, which normalises
 * away each file's different trailing padding. All ten files are 30fps.
 *
 *   bullet.01 (pistol / smg / shotgun)     bullet.02 (rifle / heavy / slug)
 *     05ft  100ms  (16f, 533ms clip)         05ft  267ms  (28f, 933ms clip)
 *     15ft  333ms  (16f, 533ms)              15ft  200ms  (28f, 933ms)
 *     30ft  467ms  (19f, 633ms)              30ft  367ms  (28f, 933ms)
 *     60ft  567ms  (25f, 833ms)              60ft  533ms  (28f, 933ms)
 *     90ft  733ms  (29f, 967ms)              90ft  700ms  (28f, 933ms)
 *
 * ⚠ TWO ANOMALIES IN THE DECODE, recorded rather than smoothed. bullet.01's 05ft file opens with its
 * head already halfway across its own frame and never reaches the frame edge (max lead 0.83), so its
 * 100ms is "this shot is over before it starts" and not a crossing; and bullet.02's 05ft reads LONGER
 * than its 15ft (267 vs 200) because the two files pad differently (max lead 1.00 vs 0.94). Both sit
 * inside the two nearest bands, both are short shots, and neither is worth a special case — but a
 * later reader comparing the ladder to the files should not think the inversion is a typing error.
 *
 * ⛔ THE TABLE IS KEYED BY THE TRACER KEY, not by the class, and that is what makes an ammo overlay
 * that REPLACES the picture (the slug row hands the shotgun a bullet.02) get the right answer with no
 * branch. A key this table does not carry falls to TRACER_ARRIVAL_FALLBACK_MS.
 */
export const TRACER_ARRIVAL_MS = Object.freeze({
  "jb2a.bullet.01.orange": Object.freeze({ "05ft": 100, "15ft": 333, "30ft": 467, "60ft": 567, "90ft": 733 }),
  "jb2a.bullet.02.orange": Object.freeze({ "05ft": 267, "15ft": 200, "30ft": 367, "60ft": 533, "90ft": 700 }),
});

/**
 * The engine's own band boundaries for the five-file ranged families, in grid squares — the same mirror
 * VOLLEY_BANDS is of the four-file volley family, extended by the 05ft entry the bullet families carry
 * and the volley family does not. The engine serves the NEAREST band, so each boundary sits at the
 * midpoint of two neighbours in squares (3, 6, 12 and 18 squares are 15/30/60/90ft on a 5ft grid).
 * Asserted against `getFileForDistance` on the installed engine rather than trusted — see the keeper.
 */
export const TRACER_ARRIVAL_BANDS = Object.freeze([
  Object.freeze({ band: "90ft", minSquares: 15 }),
  Object.freeze({ band: "60ft", minSquares: 9 }),
  Object.freeze({ band: "30ft", minSquares: 5 }),
  Object.freeze({ band: "15ft", minSquares: 2 }),
  Object.freeze({ band: "05ft", minSquares: 0 }),
]);

/**
 * The arrival used for a painted tracer this file has no measurement for — an asset an overlay named
 * that is not one of the two mapped bullet families. The middle of the measured ladder, so a key we
 * have not decoded is neither confirmed at the muzzle nor held for the better part of a second.
 */
export const TRACER_ARRIVAL_FALLBACK_MS = 400;

/** Which band file the engine will serve a five-file ranged family at this many squares. Pure. */
export function tracerBandFor(distSquares) {
  const d = Number(distSquares) || 0;
  return (TRACER_ARRIVAL_BANDS.find((b) => d >= b.minSquares) ?? TRACER_ARRIVAL_BANDS[TRACER_ARRIVAL_BANDS.length - 1]).band;
}

/** How long a painted round of this tracer family takes to cross a shot of this length, in ms. Pure. */
export function tracerArrivalMs(tracerKey, distSquares) {
  const table = TRACER_ARRIVAL_MS[tracerKey];
  if (!table) return TRACER_ARRIVAL_FALLBACK_MS;
  return Number(table[tracerBandFor(distSquares)]) || TRACER_ARRIVAL_FALLBACK_MS;
}

/**
 * The hard ceiling on how long the apply window may be held back waiting for the rail to finish, in
 * milliseconds. Raced against the completion signal — whichever comes first wins — so a fan-out that
 * never reports (a listener that threw, an engine that stalled, a payload nobody registered) can delay
 * the window but can never park it. Comfortably past the longest span the table can produce: the
 * thirty-round cap at the slowest mapped cadence plus a terminal element is ~6.2s, and this sits above
 * a normal burst by a wide margin while still being a bound a person would wait through.
 */
export const PRESENTATION_CAP_MS = 8000;

/**
 * FACE THE TARGET — the shooter turns to look at what it is shooting at, before the first round.
 *
 * `durationMs` is the sweep. It is a visible TURN and not a snap on purpose: a token that changes
 * heading between two frames reads as a glitch, where a short sweep reads as the character bringing
 * the weapon round. Short enough that it is a lead-in rather than a wait.
 *
 * `minDegrees` is the dead zone. A token already pointed at its target must not jitter, and a turn
 * of a couple of degrees is not visible anyway — under this, nothing is written and nothing is waited
 * for. That matters beyond the look: the turn is a DOCUMENT WRITE (unlike everything else this rail
 * draws), so the dead zone is also what stops a burst of shots at one target writing the token over
 * and over.
 */
export const FACE_TARGET = Object.freeze({
  durationMs: 220,
  minDegrees: 5,
});

/**
 * The MOTE SPRAY — the scatter of small hot specks thrown down-range, drawn ONCE PER BURST and only
 * for a multi-round payload. The geometry is a property of a muzzle, not of a particular gun, so it
 * lives here as one spec block; only the COUNT is a per-class field (`motes`), because the number of
 * specks is the part a bore size changes.
 *
 * Every number is off the reference frame (flash-attributable pixels, chrome masked):
 *  - `spreadRad` 0.30 (≈17° half-angle) — the mote field measured −18°…+16° about the aim line, which
 *    is a good deal TIGHTER than the miss divergence and tighter than the ray fan; the specks follow
 *    the round, they do not spray sideways.
 *  - `nearSquares` / `farSquares` — the specks were found between 100 and 340px of a 165px grid, so
 *    from about 0.6 to about 2.1 squares out. Each mote picks its own distance in that band, which is
 *    what makes the group read as a scatter at mixed depths rather than as an arc.
 *  - `sizeSquares` 0.14 — the specks measured 4–7px on that grid. The asset is the same star used for
 *    the spikes; at this size only its core survives, which is exactly a speck.
 *  - `travelMinMs` / `travelMaxMs` — each mote crosses in its own time, so they do not arrive as a
 *    rank. Both are under a burst's own length, so the spray is spent while the burst is still firing.
 */
export const MUZZLE_MOTES = Object.freeze({
  key: "jb2a.impact.006.yellow",
  sizeSquares: 0.14,
  spreadRad: 0.30,
  nearSquares: 0.6,
  farSquares: 2.1,
  travelMinMs: 120,
  travelMaxMs: 260,
});

/**
 * THE MUZZLE SMOKE — a rolling mass built from MANY SHORT PUFFS OVERLAPPING OUT OF PHASE, emitted
 * across a burst, rather than one wisp with a long fade.
 *
 * ⚠ THIS REPLACES THE SINGLE-WISP TREATMENT, and the reason is worth keeping. The wisp was one sprite
 * whose lifetime was stretched to cover the burst and which then faded out slowly (the FR#16 tune took
 * it to 1050–3600ms with a 700ms fade). The user's description of what they actually want is not that:
 * "after the last shots have left the barrel, the smoke effect is still advancing every other frame or
 * so. Different parts of the smoke are sometimes advancing at a different time. One frame, some of the
 * smoke advances, and the next the rest advances. By 'lingering' I mean that a LESSENING AMOUNT of
 * smoke continues to ADVANCE, for several frames, RAPIDLY disappearing." A single sprite dimming
 * cannot produce that; several sprites at different points of their own animation, ending at different
 * times, is exactly that. So the long static fade is superseded for bursts: `fadeOutMs` here is
 * deliberately SHORT (300ms — "rapidly disappearing"), and the linger comes from instances outliving
 * each other rather than from any one of them hanging around.
 *
 * ⭐ THE STRUCTURE IS BORROWED FROM THE REFERENCE, THE ASSETS ARE NOT. Observed on the reference rig
 * (RED-REFERENCE-RIG.md §5): it has NO smoke and NO ember element at all. What reads as a billow
 * rolling through a burst is ONE 633ms tracer clip emitted per shot at a 100ms cadence — about six
 * copies alive at once, each at a different point of its own animation. The evolution is PHASE-OFFSET
 * OVERLAP, not variation between instances and not one long effect. That structure is what is copied
 * here, with a smoke asset in place of a tracer.
 *
 * ⭐⭐ THE TRAP THAT MAKES THIS NON-OBVIOUS, and the reason every puff is built as its OWN section:
 * Sequencer's own randomisers roll ONCE PER SECTION, not per repetition — `_initialize()` flips the
 * mirror coin a single time, so a section with `.repeats(n)` yields n IDENTICAL copies. The reference
 * falls into exactly this (it asks for `randomizeMirrorY` and gets `flipY: true` on all ten). So the
 * variation below is rolled BY US, per emission, and each emission gets a separate `.effect()`.
 *
 * ⏪ SCOPE NARROWED (FR#22): this spec once paced a STREAM of puffs across a burst, and the number it
 * existed to preserve was the concurrency — how many were alive at once. There is no stream any more
 * (see the retirement note on smokePlanFor), so what is left of it describes ONE puff: the shell's
 * single discharge. The per-instance variation below still earns its place — the shell fires repeatedly
 * over a session and identical puffs would read as a stamp — but nothing here is paced against a
 * cadence now, and `clipMs` is documentation rather than an input to any arithmetic.
 *
 * ASSET NOTES, measured off the installed free tier: the five variants all live under ONE database key
 * (`jb2a.smoke.puff.side.grey` holds SmokePuffSide01_01..05), so cycling them means indexing the file
 * list rather than naming five keys. Their durations are NOT equal — 1100 / 1100 / 1200 / 1067 / 1900ms
 * — and that is left alone deliberately: the 1900ms variant is the natural straggler, which is the
 * "lessening amount still advancing" the ruling asks for, for free. `clipMs` below is the typical
 * value (1100) and is now documentation only — the stride arithmetic it fed is retired.
 *
 * ⏪ THE SAVED FALLBACK, if this reads worse than what it replaced: the literal-fidelity option is to
 * DELETE the smoke and the embers entirely and let tracer overlap do the work, exactly as the
 * reference does — it has neither. That is a one-line change (drop the `motes`/`smoke` emission from
 * the fan-out) and is recorded here so it does not have to be rediscovered.
 */
export const MUZZLE_SMOKE = Object.freeze({
  key: "jb2a.smoke.puff.side.grey",
  variants: 5,
  clipMs: 1100,
  // Per-instance variation, all rolled by us (see the trap above).
  rotationDeg: 35,          // ± about the aim — WIDE, so the mass fans instead of pointing down-range
  // ⏱ TUNED ON REPORT (2026-08-08): "too ropy", "starts a bit too far from the shooter", and on the
  // fast automatics "too large" and it "spams". The scale band is wider and the phase spread much
  // wider, so successive puffs stop reading as repeats of one another; opacity is down so the
  // overlapping edges merge into a mass instead of showing as separate strands; and the bloom is
  // softer and slower, which also blurs the moment of arrival that made the metronome obvious.
  scaleMin: 0.8, scaleMax: 1.45,
  rateMin: 0.85, rateMax: 1.15,
  jitterSquares: 0.18,      // positional scatter at the muzzle
  startPhaseMax: 0.55,      // fraction of its own clip an instance may start into
  // Where the puff is BORN, as a fraction of the shooter token's own width along the aim. The muzzle
  // SPRITE sits on the forward edge (0.5); the smoke starts further back, essentially at the barrel
  // and slightly inside the token, and rolls out from there — reported as "starts a bit too far from
  // the shooter" when it shared the sprite's edge offset.
  originFraction: 0.28,
  // DRIFT — a slow roll that hangs at the muzzle, never a launch. See the drift note below.
  // ⏱ TIGHTENED ON REPORT (2026-08-08, FR#20): "still gets a bit too far from the shooter, all
  // classes". Measured live before this pass: 0.48–0.77 squares on a shell burst, 0.54–0.99 across the
  // classes — i.e. the REACH was already about where it should be, but the CAP was more than twice it,
  // so it bounded nothing a viewer ever saw and the tail of the distribution ran out to a tile and a
  // half. Both are moved: the components come in so the typical puff settles nearer, and the cap comes
  // down to the top of the asked-for band (about half a tile to a tile) so it is a bound that bites.
  driftAlongSquares: 0.28,  // component down-range
  driftLateralSquares: 0.24, // component ACROSS the aim — this is what makes it billow, not stream
  driftMaxSquares: 0.9,     // hard cap on where a puff may end up, measured FROM THE SHOOTER
  scaleInFrom: 0.55, scaleInMs: 240,
  fadeOutMs: 300,           // MODEST on purpose — "rapidly disappearing"
  opacity: 0.28,
});
/**
 * The TRACER COLOUR SHIFT — how a class's tracer is pushed from the asset's orange toward the
 * reference's yellow-near-the-head-fading-to-white comet. Optional per class (`tracerColor`).
 *
 * ⚠ THE FINDING THAT PICKED THE MECHANISM, recorded because the obvious lever is the wrong one:
 * Sequencer's `tint` MULTIPLIES the asset's own colours, so tinting an orange asset with a pale
 * yellow CANNOT add white — photographed side by side on the rig, `#ffe9a0` and `#fff6d0` both came
 * back MORE saturated orange than the untinted control, i.e. the opposite of the asked-for shift. A
 * ColorMatrix filter rotates hue and removes saturation instead, which is the operation that actually
 * moves orange toward yellow and then toward white. The values below are the ones that read right in
 * that comparison: the rays go yellow while the head's core stays white. A stronger setting
 * (hue 25 / saturate −0.6) washed the whole bolt out and was rejected.
 *
 * The shell class deliberately carries NO entry — its pellets are a settled look and this is a
 * per-class field precisely so that stays untouched.
 */
export const TRACER_COLOR = Object.freeze({ hue: 18, saturate: -0.35, brightness: 1.15 });

/**
 * THE THREE AMMO TRACER MATRICES — the same mechanism as TRACER_COLOR above (a ColorMatrix, never a
 * tint: the measurement recorded there rules the tint out for all of them) applied to say WHICH ROUND
 * is in the gun rather than which weapon fired it.
 *
 * The free tier delivers bullets in ORANGE (01/02) and BLUE (03) and nothing else — red is a filter
 * result, not an asset (verified on the install), so every one of these is a rotation of the same
 * orange asset and not a different file. Each is stated as the operation it performs on that orange:
 *
 *  - INCENDIARY (api): hue rotated NEGATIVE, i.e. orange → red, with saturation ADDED rather than
 *    removed. It is the only one of the three that moves the hue the other way from the class shift,
 *    which is what makes an incendiary burst read as a different round at a glance and not merely as a
 *    brighter one. Brightness is nudged up because a saturated red loses luminance against a dark floor.
 *  - HARDENED (ap / dualPurpose): saturation stripped almost to nothing and brightness pushed well up —
 *    a near-white bolt. "Colder" here is desaturation, deliberately NOT a rotation toward blue: the
 *    tier's blue bullets are its energy-weapon read (see the note on the class table), so rotating a
 *    slug toward blue would say "laser", which is the opposite of the fact being conveyed.
 *  - INERT (formerly rubber / stundart): saturation halved and brightness pulled DOWN.
 *    ⏪⏪ RETIRED FROM USE 2026-08-09 ON USER RULING. It was the only matrix that darkened, and that was
 *    reported as the defect: "what you did for rubber bullets doesn't look good — instead of
 *    darkening/muting the color, let's look for a better asset to represent rubber bullets." The
 *    premise it was built on — that a baton round should look like it carries less energy — is not
 *    wrong about the round, but it is wrong about the SCREEN: a dimmed sprite on a dark scene is not a
 *    quieter round, it is a round the eye has to hunt for (capture 59-control). Colour is now the wrong
 *    lever for this load entirely; the round is said with a different ASSET (see BATON_ROUND below).
 *    Left declared rather than deleted, the way this file leaves every superseded mechanism wired: it
 *    is one row field from returning if the replacement is vetoed.
 *
 * ⚠ NO WIDTH LEVER EXISTS FOR A PAINTED BOLT. "A thinner bolt for AP" was considered and cannot be
 * built: a painted (stretched) tracer takes its width from the asset's own frame and Sequencer's size
 * call on a stretched effect controls the stretch, not the cross-section. Colour is the whole available
 * palette for a painted tracer, which is why the two live matrices here are colour and why the
 * treatments that genuinely change SHAPE (the slug's single bolt, the impact promotions, and the baton
 * round's travelled slug) do it with different fields.
 */
/**
 * ⏱ EASED ONE NOTCH 2026-08-09 (user): hue −20 → **−14**. The rotation is what pulls the tier's orange
 * bolt toward red, and at −20 the api round read as more red than the load wants to say. −14 keeps it
 * clearly a hotter, redder round than the standard tracer while leaving the orange in it.
 *
 * ⏪ THE REVERT VALUE IS **hue: −20** (saturate 0.30 and brightness 1.20 are unchanged and were never
 * in question) — recorded here rather than in a commit message so the reversal is a one-number edit at
 * the site, per this file's standing habit for values the user may want back.
 */
export const TRACER_COLOR_INCENDIARY = Object.freeze({ hue: -14, saturate: 0.30, brightness: 1.20 });
// ⏪ ON NO SHIPPED ROW as of 2026-08-11 — the hardened rounds' flight tint was removed under the
// realism razor (the ruling is at the AMMO_FX `ap` row). Left declared rather than deleted, the way
// this file leaves every superseded mechanism wired: restoring it is one field on two rows.
export const TRACER_COLOR_HARDENED   = Object.freeze({ hue: 8,   saturate: -0.85, brightness: 1.45 });
export const TRACER_COLOR_INERT      = Object.freeze({ hue: 0,   saturate: -0.55, brightness: 0.60 });

/**
 * THE BATON MATRIX (2026-08-09) — what the baton round's own elements are repainted with.
 *
 * ⭐ THE ONE NUMBER TO READ IS `brightness: 1.30`, and it is above 1 on purpose: the treatment this
 * replaces pulled it to 0.60 and the user rejected exactly that. This matrix takes the COLOUR out and
 * leaves the light in. It is applied to two things and says a different true thing about each:
 *  - the ROUND (BATON_ROUND's asset) is already greyscale — mean luminance 99/255 measured off the
 *    installed file — so saturation does nothing here and the brightness is the whole point: it lifts a
 *    dark grey slug to a pale one that reads against a black floor.
 *  - the shell's DISCHARGE COLUMN is `bullet.02`'s orange bloom, so here the desaturation is the whole
 *    point: a reduced-pressure less-lethal load's blast is gas and pale flash rather than fire.
 * One matrix for both is not a shortcut — it is what makes the shell's two elements agree, which is the
 * standing uniformity ruling (§ the AMMO_FX block).
 */
export const TRACER_COLOR_BATON = Object.freeze({ hue: 0, saturate: -0.85, brightness: 1.30 });

/**
 * THE DART MATRIX (2026-08-09) — what a needle load's own projectiles are repainted with.
 *
 * ⭐ THE DART LANGUAGE, which is a rule and not one row's tuning: on this rail **grey means darts and
 * orange means balls and bullets**. The tier gives us one projectile family and it is orange, so a
 * group of darts and a group of shot were drawn in the same colour and the only difference a viewer had
 * was that one had eight marks and the other six — which at speed is no difference at all. Desaturating
 * the dart loads is what makes the two readable side by side, and it is the load's own true statement:
 * a flechette or a needle-dart is a bare metal spike, where shot and bullets leave a barrel glowing.
 * ⭐ AND IT CARRIES MORE WEIGHT SINCE 2026-08-10, when the single-file ruling took the count off the
 * flechette row: on a class that draws one round per slot the colour, the length and the smaller mark
 * are now the WHOLE difference between a dart and a bullet, where the count used to do part of the work.
 *
 * ⚠ IT IS NOT A DARKENING, and that is deliberate rather than incidental. `brightness: 1.15` sits ABOVE
 * 1 for the same reason TRACER_COLOR_BATON's 1.30 does — the rejected baton treatment pulled a round to
 * 0.60 and the user's ruling was that a dimmed sprite on a dark scene is not a quieter round, it is a
 * round the eye has to hunt for. What is taken out here is the COLOUR (saturate −0.90, the strongest
 * desaturation on the rail); the light is left in and lifted a little, so a needle reads as cold bright
 * metal.
 *
 * WHY IT IS ITS OWN CONSTANT rather than a reuse of TRACER_COLOR_BATON (hue 0, −0.85, 1.30), which is
 * numerically close: the two say different things and are allowed to drift apart. The baton matrix
 * repaints a solid greyscale slug and is tuned to lift THAT asset off a black floor; this one repaints
 * an orange bullet sprite and is tuned to take the fire out of it. A single shared constant would make
 * a later change to one silently change the other.
 */
export const TRACER_COLOR_DART = Object.freeze({ hue: 0, saturate: -0.90, brightness: 1.15 });

/* ══════════════════════ THE DISCHARGE COLUMN — DELETED 2026-08-09 ══════════════════════
 *
 * ⏪⏪⏪ The four-report column saga ends by DELETION, not by another trim. What stood here was
 * COLUMN_SQUARES (1.25), COLUMN_TRIM_MS (55), COLUMN_DWELL_MS (220) and columnRateFor(), plus a build
 * site in fxShot, the `column`/`columnColor` fields on the shell row, `column` in the replace mask,
 * `columnColor` in the recolour mask and on five overlay rows, and a term in presentationTailMs.
 *
 * The history in one line each, because the *shape* of it is the lesson: FR#22 added a stretched
 * `bullet.02` to give the shell the spiky bloom the lance could not (and removed the shell's lance in
 * the same breath); FR#23 shortened it to 1.25 squares because stretched to the aim point it drew a
 * rifle-like round on top of the pellet fan; FR#25 trimmed it 300 → 55 ms because the frames after the
 * bloom were a tail and a starburst; and the same report gave it a 220 ms dwell to buy back the presence
 * the trim had spent. Four reports, each one removing more of an asset that was chosen for one frame of
 * itself.
 *
 * The user's ruling: *"Just replace the control with Shotgun blast muzzle 01. Randomize between 01 and
 * 02 on each shot."* The shell now takes the same `muzzle` lance every other class takes, from the key
 * that natively holds both files — so the thing the column was bought for (a bloom at the barrel) is
 * drawn by the element built for it, at a size the row states, through machinery four other rows
 * already exercise. Nothing is left wired: an element that needs a trim, a dwell, a derived rate and a
 * shortened stretch to show one frame is not a mechanism worth keeping one field from use.
 *
 * The one thing that outlived it is the shell's tinted fan: `tracerColor: null` on the class row still
 * declares the pellets repaintable, so an api or stun-dart shell recolours its shot exactly as before —
 * that ruling never depended on the column, only on the mask. See the AMMO_FX block.
 */

/* ══════ THE BUCKSHOT VOLLEY — A LIVE TRIAL, NOT AN ADOPTED LOOK (2026-08-09) ══════
 *
 * WARNING — STATUS: **ON TRIAL.** The user has seen this composed offline and asked to watch it on the
 * rig before ruling: *"I honestly like the whole clip, the fireballs look good... I need to see this on
 * the test rig myself before I say adopt. Let's try full range."* Nothing below is a settled value; the
 * whole treatment exists so that judgement can be made in motion, and it is built to be withdrawn.
 *
 * REVERT, in one edit: set `VOLLEY.enabled` to false. Buckshot then draws the six travelled dashes the
 * shell row has always described (`pellets: 6`, `dashSquares: 1`, `dashMs: 150`), the hit mark comes
 * back with it, and `presentationTailMs` falls through to the ordinary arithmetic — because every one
 * of those is a fall-through rather than a second path. No row changes, no asset key is removed, and
 * flechette and slug never entered this branch at all.
 *
 * WHAT IT IS. `jb2a.volley_of_projectiles_Line.bullet.001.001.orangeyellow` — one ranged asset that
 * draws a five-round fan crossing to the aim point and blooming into arrival fireballs when it lands,
 * all baked into its own clip. Where our fan is six sprites we place and time, this is one sprite that
 * contains the whole discharge. The user's ruling is that the WHOLE clip is kept, fireballs included.
 *
 * WHICH SHOTS GET IT — `volleyOwns(payload)` below, and the question is asked of the CARTRIDGE, the
 * same way the pattern flow asks it. Buckshot only; the slug and the flechette load keep their own
 * pictures, which is the whole point of having given them one.
 *
 * THE HIT MARK IS SUPPRESSED WHILE THE TRIAL RUNS, and it is not an oversight: the asset's own baked
 * arrival is a bloom of fireballs at the endpoint, so drawing our impact star on top of it puts two
 * arrivals on one square. One of them has to go, and the asset's is the one the user said he liked.
 *
 * THE BANDS, and why a mirror of the engine's own picker is unavoidable. This is a range-banded asset:
 * the database serves a DIFFERENT FILE per distance, and each file bakes its own crossing time. The
 * switch points are not ours to choose — they are `SequencerFileRangeFind.ftToDistanceMap`, read out
 * of the installed engine rather than guessed:
 *     15ft -> 2 squares  .  30ft -> 5  .  60ft -> 9  .  90ft -> 15
 * and the picker takes the band whose minimum the distance meets, so the live boundaries are **5, 9 and
 * 15 squares** (the smallest band's own minimum is collapsed to 0, so 15ft covers everything under 5).
 * `volleyBandFor` reproduces exactly that and nothing else.
 *
 * WHY THE MIRROR IS LOAD-BEARING RATHER THAN TIDY. The four files do not merely look different, they
 * last different lengths, and the apply window is computed from a pure function that never sees a
 * canvas. Decoded off the four installed files at 40ms against each video's own clock:
 *
 *     band   file        duration   ARRIVAL (front edge at the far end)   CONTENT ENDS (peak >= 120)
 *     15ft   1000x400     2567ms      240ms                                600ms
 *     30ft   1600x400     2633ms      480ms                                800ms
 *     60ft   2800x400     3067ms      840ms                               1200ms
 *     90ft   4000x400     3433ms     1200ms                               1600ms
 *
 * Two numbers per band, and they answer two different questions.
 *  - `crossMs` (the ARRIVAL) is when the rounds get there, so it is what the blood spray and the
 *    burning ground are delayed by — the same role `dashMs` plays for a travelled fan.
 *  - `tailMs` (the CONTENT END) is how long the element is worth looking at, so it is the term
 *    `presentationTailMs` takes. It is NOT the file's own duration: every band spends its last one to
 *    two seconds on a dim residue (peak 40-70/255 over 0.1% of the frame), and holding the damage
 *    window shut for 3.4s to wait out something invisible is exactly the cost this file's tail rules
 *    exist to refuse.
 * Take the band off a fixed guess instead and a 15-square shot opens its apply window a full second
 * before its own rounds land. That is the silent one-directional failure `presentationTailMs` warns
 * about, and it is why the mirror exists.
 *
 * THE CHAOS KNOBS, and why they are seeded rather than random. Reported: the volley is too neat — five
 * rounds in the same formation every time. Two knobs answer it, and each is a property of the SHOT
 * rather than of the client that drew it (`seededRng` off `fxSeedOf`), so two clients compute the same
 * jitter and a test can compute it twice:
 *  - `mirrorFlip` — the sprite is mirrored across its own long axis on about half of discharges, which
 *    swaps which side of the fan the leading rounds are on. Free, in the sense that it re-uses the
 *    asset's own art rather than adding anything.
 *  - `jitterDeg` — the aim is rotated by up to this many degrees, ABOUT THE SHOOTER, so the distance
 *    is preserved exactly and the band cannot flip at a boundary because of jitter. 5 degrees at a
 *    9-square shot moves the arrival about 0.8 of a square: a visibly different shot on the same
 *    target, and not a miss.
 * AND THEY ARE PER SHELL, not per payload: the seed folds in the round INDEX, so an autoshotgun's three
 * shells each throw their own differently-mirrored, differently-angled volley. A per-payload seed would
 * have made a burst three identical copies, which is the report restated one level up.
 *
 * ⭐ AND PER TRIGGER PULL, which the round index alone did NOT deliver (2026-08-10, user ruling: *"use a
 * more dynamic seed... damage numbers"*). The seed's first form folded identity fields only — attacker,
 * weapon, round count, hit count, round index — and every one of those is the SAME on two consecutive
 * shots from the same gun at the same target. So the second pull computed the first pull's mirror and
 * the first pull's angle: a table firing repeatedly saw at most two pictures per gun (one hit, one
 * miss), which is the "too neat" report restated one level DOWN rather than answered.
 *   The fix is the entropy rule this file already follows everywhere else it seeds: fold in a value the
 * ROLL produced. `JSON.stringify(payload.areaDamages)` is the rolled damage of this shot — the same term
 * the burning-ground seed folds, in the same position, so the two seeds now have one shape between them.
 * Two identical trigger pulls differ because their rolls differ; two CLIENTS still agree because the
 * rolls ride the payload both of them received. Determinism was never a property of the identity fields;
 * it is a property of seeding off the payload at all.
 */
export const VOLLEY = Object.freeze({
  // ⏪⏪ VETOED (user ruling 2026-08-11, at the bench — the trial's verdict). The whole block below is
  // SHELVED, not deleted, which is this file's standing habit for a superseded mechanism: with this one
  // field false `volleySpecFor` returns null, `volleyOwns` answers no, and every downstream site falls
  // THROUGH to the pellet fan it was written to fall through to — including the hit mark fxShot
  // suppressed while the trial ran, which comes back with it. Restoring the trial is this one field.
  //
  // WHAT WAS WRONG WITH IT, in the user's terms: *"the visible bullets and long trails are a problem"* —
  // buckshot is small balls in an irregular grouped spread, and this asset draws aligned side-by-side
  // lanes of long-trailed rounds, which reads as a rank of rifle fire. The ARRIVALS were the half worth
  // keeping (*"the arrival fireballs were GREAT"*), and they are kept — scaled down and moved onto the
  // fan's own pellet endpoints (PELLET_ARRIVAL). The irregularity the volley was reaching for is now
  // the fan's own (PELLET_CHAOS).
  //
  // The two personal-review findings against it die here with it: F9 (the branch that replaced the round
  // ignored the resolved entry's colour) was fixed on 2026-08-10 and is moot with the branch off, and
  // F4 (the settle cap at the asset's content end) belongs to an element nothing draws.
  enabled: false,
  key: "jb2a.volley_of_projectiles_Line.bullet.001.001.orangeyellow",
  // Measured off the installed files (see the table above). Keyed by the engine's own band names.
  crossMs: Object.freeze({ "15ft": 240, "30ft": 480, "60ft": 840, "90ft": 1200 }),
  tailMs:  Object.freeze({ "15ft": 600, "30ft": 800, "60ft": 1200, "90ft": 1600 }),
  jitterDeg: 5,
  mirrorFlip: true,
});

/**
 * The engine's own band boundaries, in grid squares, mirrored from `SequencerFileRangeFind` — see the
 * VOLLEY block. Pure, and exported so the mirror is asserted by value against the installed engine
 * rather than trusted.
 */
export const VOLLEY_BANDS = Object.freeze([
  Object.freeze({ band: "90ft", minSquares: 15 }),
  Object.freeze({ band: "60ft", minSquares: 9 }),
  Object.freeze({ band: "30ft", minSquares: 5 }),
  Object.freeze({ band: "15ft", minSquares: 0 }),
]);

/** Which band file the engine will serve for a shot this many squares long. Pure. */
export function volleyBandFor(distSquares) {
  const d = Number(distSquares) || 0;
  return (VOLLEY_BANDS.find((b) => d >= b.minSquares) ?? VOLLEY_BANDS[VOLLEY_BANDS.length - 1]).band;
}

/**
 * The volley spec for a shot of this length, or null when the trial is switched off. Pure.
 * `crossMs` is when the rounds arrive; `tailMs` is when the element stops being worth waiting for.
 */
export function volleySpecFor(distSquares) {
  if (!VOLLEY.enabled) return null;
  const band = volleyBandFor(distSquares);
  return { key: VOLLEY.key, band, crossMs: VOLLEY.crossMs[band], tailMs: VOLLEY.tailMs[band] };
}

/**
 * IS THIS PAYLOAD BUCKSHOT? Pure, and asked of the CARTRIDGE exactly as `patternFlowOwns` is.
 *
 * WARNING — IT ASKS `spreadModeForAmmo`, NOT `spreadFlowModeOf`, and the difference is deliberate. The
 * flow question folds in the pattern's world switch, because that switch decides what the module DOES
 * with a shell; this is a question about what LEAVES THE BARREL, and a table that has switched the
 * damage pattern off has not thereby changed what buckshot looks like. Reading the flow question here
 * would have let a world setting silently repaint a gun.
 */
export function volleyOwns(payload) {
  if (!VOLLEY.enabled) return false;
  return spreadModeForAmmo({
    spreadMode: payload?.spreadMode,
    caliber: payload?.caliber,
    modifier: payload?.modifier,
  }) === SPREAD_MODE_BUCK;
}

/**
 * One discharge's chaos, from its own seed. Pure, so both knobs are asserted by value and the
 * determinism is proved by computing it twice rather than by watching two clients.
 */
export function volleyChaosFor(seed) {
  const rng = seededRng(seed);
  const mirrorY = VOLLEY.mirrorFlip ? rng() < 0.5 : false;
  const jitterDeg = Number((((rng() * 2) - 1) * VOLLEY.jitterDeg).toFixed(3));
  return { mirrorY, jitterDeg };
}

/**
 * A point rotated about an origin, in degrees. Pure. Used to jitter a volley's aim WITHOUT changing its
 * distance — which is what keeps the band, and therefore the whole tail arithmetic, out of the
 * jitter's reach.
 */
export function rotateAbout(origin, point, deg) {
  if (!origin || !point) return point ?? null;
  const rad = (Number(deg) || 0) * Math.PI / 180;
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return { x: origin.x + dx * Math.cos(rad) - dy * Math.sin(rad),
           y: origin.y + dx * Math.sin(rad) + dy * Math.cos(rad) };
}

/**
 * The mapping table: our weapon CLASS → Sequencer database keys + our sound basename + options.
 * Database KEYS, never file paths — a key resolves on whichever JB2A tier the user installed, and a
 * key the installed tier lacks is skipped instead of 404ing (see fxDbEntryExists).
 *
 * Every key here is chosen from what the FREE asset tier actually delivers (verified against a real
 * install), so the sprites appear for a user who installed nothing beyond the free module:
 *  - muzzle: the free tier carries exactly ONE muzzle-flash family, and it is labelled yellow — there
 *    is no orange variant below the paid tier. The key holds two interchangeable files, so the engine
 *    picks between them per play and a burst does not repeat one frame. The warm cast a viewer reads
 *    is the SPRITE's own, not the light's: the muzzle light is illumination-only now (MUZZLE_LIGHT
 *    carries a null colour), so it reveals the floor in the floor's own colours and the sprite
 *    supplies all of the heat. Weapon weight is carried by `muzzleSquares` — the DRAWN WIDTH in grid units, not a
 *    scale factor — because one family is all the tier has and its size is the difference a viewer
 *    can see. Sizing in grid units rather than by `scale` (which is what the previous build used) is
 *    what makes the number a spec: it is the same fraction of a square on any scene.
 *  - tracer: bullet 01 (thin) for the light classes, bullet 02 (heavier, brighter head) for rifle and
 *    up. Both are delivered in orange free; the tier's other bullet entries are blue, which would read
 *    as an energy weapon rather than a slug.
 *
 * OPTIONAL per-class fields — a class that omits one simply does not get that treatment, so the table
 * stays a flat readable row per class and no branch anywhere names a specific class:
 *  - `pellets` / `spreadRad`: draw the round as a FAN of `pellets` tracers spread over a cone of
 *    half-angle `spreadRad` instead of one bolt (see pelletEndpoints). Only the shell class carries
 *    them: a shell round IS a spread of projectiles, and one bolt drew it identically to a rifle.
 *  - `dashSquares` / `dashMs`: draw each of those tracers as a SHORT SPRITE THAT TRAVELS the shot line
 *    rather than as a full-length streak painted across it. See the shell-class note below and the
 *    tracer branch in fxShot — a class without `dashSquares` keeps the painted streak untouched.
 *  - `cadenceMs`: the class's own spacing between rounds of one automatic payload, overriding
 *    SHOT_CADENCE_MS. See classCadenceMs.
 *  - `soundBurst`: a SECOND recording of the same weapon, played when the payload is more than one
 *    round so a string of rounds is not one waveform repeated. See shotSoundSrc.
 *  - `spark`: draw the small radial star (MUZZLE_SPARK) over the aimed lance, for the spiky read.
 *  - `tracerColor`: push this class's tracer toward yellow-then-white with the TRACER_COLOR matrix.
 *  - `motes` / `smokeSquares`: the MULTI-ROUND-ONLY treatments — a spray of `motes` specks down the
 *    firing cone and one smoke wisp `smokeSquares` wide at the muzzle, both drawn ONCE PER BURST.
 *    A class that omits either simply does not get it, and NEITHER is drawn for a single-round
 *    payload whatever the row says: the gate is the payload's own round count, read in fxWeaponFired,
 *    because "was this automatic fire" is a property of the shot and not of the weapon. That matches
 *    the reference, where the automatic weapon threw specks and smoke and the semi-automatic one in
 *    the same scene threw neither.
 *  - `smokeSingle`: this class smokes on a SINGLE discharge as well, i.e. it opts out of the
 *    multi-round gate above for the smoke only (never for the specks). See the shell row's note.
 *  - `muzzleMs`: how long this class's lance DWELLS on screen, stretched over the same trimmed clip
 *    range by a derived playback rate. A row that omits it plays at rate 1 and is untouched. See the
 *    MUZZLE_DWELL_DEFAULT_MS block for why dwell and trim have to be two different numbers.
 *
 * SHELL-CLASS NUMBERS (chosen here, tuned by eye on the rig — see the eyes-on record):
 *  - `pellets: 6` — enough to read as a spread rather than a doubled bolt. It was 4 while each pellet
 *    was a full-length streak, where more would have read as a wall; a short travelling dash is a much
 *    smaller mark on the canvas, so the count can carry the "spread" read that the length used to.
 *    An EVEN count is deliberate: pelletEndpoints spaces the offsets across the whole cone, so an even
 *    count leaves no pellet sitting exactly on the aim line and the group cannot read as "one bolt
 *    plus strays". A burst stays bounded — the fan-out caps at MAX_FX_SHOTS units, so the worst case
 *    is MAX_FX_SHOTS × pellets tracers.
 *  - ⏪ `dashSquares` 1 → **0.7** (user ruling 2026-08-11, with the volley veto: *"buckshot = small
 *    balls"*, so the dashes have to stop reading as dashes). The number is the sprite's drawn WIDTH and
 *    the asset lights roughly a fifth of it, so shortening the frame shortens the trail more than it
 *    shortens the ball — which is the read the ruling asks for. It is NOT taken further than this on
 *    purpose: 0.5 was the FIRST value ever tried on this row and was rejected by eye as "a few pixels,
 *    reads as dirt on the screen" (the note below is that measurement, kept), so 0.7 is the shortest
 *    step that stays clear of the value already known to disappear. The per-pellet size jitter
 *    (PELLET_CHAOS.sizeFraction, ±25%) then spreads the six across 0.53–0.88, all of them above the
 *    rejected floor. ⏪ The revert value is `dashSquares: 1`. This wants eyes — it is a look call.
 *  - the previous note, unchanged, and it is why 0.7 rather than 0.5: the drawn WIDTH of one pellet's
 *    sprite, height following the
 *    asset's own aspect (it is sized in grid units, so it is the same fraction of a square on any
 *    scene: measured 100×40px on a 100px grid, against the rifle bolt's 800×200px on the same shot).
 *    This is the answer to "the projectiles read as standard bullets": the previous build stretched
 *    the same asset the rifle uses across the entire shooter→target line, so a shell pellet and a
 *    rifle round were the same mark at the same length and only their count differed. An eighth of
 *    the rifle's drawn length is a difference visible in one frame, without needing a second asset
 *    family — the free tier has only the one.
 *    ⚠ The NUMBER is bigger than the visible slug, and deliberately so: the asset is a bullet with a
 *    trail animating ACROSS its own frame, so the lit part is roughly a fifth of the frame's width.
 *    Sized at half a square (the first value tried) the slug was a few pixels and read as dirt on the
 *    screen; at one square it is a compact bright slug with a short tail. Checked by eye against
 *    0.5 / 1 / 1.5 / 2.5 side by side, since no measurement of the FRAME answers how big the lit part
 *    looks.
 *  - `dashMs: 150` — how long a pellet takes to cross, whatever the range. Under the class's own
 *    cadence below, so one discharge's pellets have landed before the next round leaves the muzzle;
 *    that is what keeps an automatic burst reading as separate discharges rather than a moving stream.
 *  - `cadenceMs: 180` — see classCadenceMs for why this number.
 *  - `spreadRad: 0.07` (≈4°) — the half-angle of the HIT cone. Deliberately far tighter than the miss
 *    divergence (MISS_SPREAD_RAD, ≈12°): a hit has to CONVERGE on the target, and at the ranges a
 *    battle map actually spans (roughly 4–12 grid squares) this puts the outermost pellet 0.28–0.84
 *    squares off the aim point — visibly a cone, still landing on a one-square target. A MISS reuses
 *    the wide miss divergence per pellet instead, so a missed shell splays wide and lands at mixed
 *    depths rather than fanning neatly past the target.
 *  - `muzzle` / `muzzleSquares: 1.9` / `muzzleMs: 220` — ⏪⏪ THE LANCE IS BACK, AND THE DISCHARGE
 *    COLUMN IS GONE (2026-08-09, user ruling: *"just replace the control with Shotgun blast muzzle 01.
 *    Randomize between 01 and 02 on each shot."*). FR#22 had taken the lance OFF this row because it
 *    sat as a second flame under the column's bloom; with the column deleted (see the block above the
 *    class table) that reason is gone with it, and the shell draws its discharge the way every other
 *    class does — one aimed sprite, edge-planted, trimmed to MUZZLE_SPRITE.endMs, stretched to its
 *    dwell by a derived rate. No new mechanism: four rows already exercise all of it.
 *    ⭐ THE RANDOMISATION IS THE KEY'S OWN, not ours, and it was verified on the installed tier rather
 *    than assumed: `jb2a.muzzle_flash.single.01.yellow` resolves to TWO files —
 *    MuzzleFlashSingle01_**01**_Regular_Yellow_600x300.webm and …_**02**_… — so the engine picks one
 *    per play and successive discharges do not stamp the same frame. Both measure 833 ms and differ in
 *    shape rather than in clock (front edge reaches 0.68 of frame on 01, 0.55 on 02), which is exactly
 *    the "randomize between 01 and 02" the ruling asks for, delivered by naming one key. A second key
 *    with hand-rolled alternation would have been a mechanism where the database already has one.
 *    ⭐ `muzzleSquares: 1.9` — MEASURED AGAINST THE RIFLE'S 1.6 rather than picked. The number is drawn
 *    width in grid units, so the ladder across the table IS the read: pistol 1.1 → smg 1.2 → rifle 1.6
 *    → **shell 1.9** → heavy 2.1. A 12-gauge bore is three times a 5.56's and the load leaves the
 *    barrel as an expanding blast rather than a jet, so the shell has to read heavier than the rifle;
 *    it sits one notch under the 20 mm because that weapon is a cannon and this one is not. Capture 67d
 *    is the two shells side by side at 1.6 and 1.9 on the same shot line.
 *    ⭐ `muzzleMs: 220` — the SAME single-discharge dwell FR#21 ruled and the deleted column had
 *    inherited. This class fires one round per trigger pull, so its 110 ms of clip is over before the
 *    eye settles where an automatic's restarts read as sustained. It is now carried by the element that
 *    every other class carries it on, through muzzleDwellMs/muzzleRateFor, with no second pair of
 *    trim-and-dwell constants in the file.
 *  - `tracer: bullet 01` — the THIN variant, where the rifle takes the heavy 02.
 *  - `tracerColor: null` — ⭐ DECLARED, PAINTED WITH NOTHING (2026-08-09, user ruling). `null` is not
 *    the same statement as leaving the field out, and the difference is the whole mechanism behind the
 *    ruling. Omitting it says "this class has no repaintable fan" and an ammo overlay's `tracerColor`
 *    is then dropped by the repaint mask; `null` says "the fan is repaintable, and the CLASS paints it
 *    with nothing". So the base look is unchanged — the draw path's `if (entry.tracerColor)` is false
 *    on null, and buckshot still leaves the muzzle in the asset's own colour, which is the settled
 *    look — while an ammo overlay that recolours reaches the pellets.
 *    Reported: "for incendiary on autoshotgun the little dorito shaped pellets themselves didn't get
 *    the same red treatment as the spiky cone and starburst. Make sure when you update the animation
 *    for one shotgun ammo type, it's updated for all." ⏪ This supersedes FR#24's "shell pellets are
 *    never tinted" for AMMO loads only; for the base look that ruling stands, and it stands here as a
 *    null rather than as a branch. ⚠ The ruling OUTLIVED the column it was reported against: it was
 *    always about the mask, never about which two elements the mask happened to reach, so deleting the
 *    column left it intact with one element instead of two.
 *  - `smokeSingle: true` — ⭐ THE ANSWER TO "I don't see it at all for shotguns" (FR#20), and the
 *    diagnosis is worth keeping because the obvious suspects were all innocent. Measured on the rig:
 *    the shell path emits and DRAWS its puffs correctly — a six-round shell burst put SIX puffs on the
 *    canvas (stride 1, the densest of any class) at 0.48–0.77 squares, against the rifle's two. What
 *    the table actually fires, though, is ONE discharge: the review shotgun on its ordinary trigger
 *    pull reports `shotsFired: 1`, and the multi-round gate above then draws no smoke at all — while
 *    the same table's rifle and SMG are fired on auto and smoke every time. So the class was never
 *    losing puffs; it was never asked for any.
 *    The gate itself stays for everything else: it was ruled off the reference, where an automatic and
 *    a semi-automatic weapon in the SAME scene differed exactly this way — but both of those were
 *    single-projectile weapons. A shell's one discharge is the case that reads wrong without smoke, so
 *    it opts out by row rather than by a branch naming the class. The specks are NOT opted out: a
 *    dozen hot specks off one shell is the "spam" read the burst treatment exists to avoid.
 *
 * MUZZLE SIZES (all five rows): the reference's flash reaches about 0.6 of a grid square forward of
 * the muzzle. Drawn width 1.6 puts the rifle's lance at roughly that reach, which is where the rifle
 * row sits; the others are stepped off it by bore. Against the previous build these are a 2.5×–4×
 * reduction (`scale: 0.7` drew 4.2 squares), which is the reported "too large" answered by value.
 */
export const FX_CLASSES = Object.freeze({
  pistol:  { sound: "shot-pistol",  muzzle: "jb2a.muzzle_flash.single.01.yellow", tracer: "jb2a.bullet.01.orange", tracerColor: TRACER_COLOR, muzzleSquares: 1.1, motes: 8,  impactSquares: 0.7 },
  smg:     { sound: "shot-smg",     muzzle: "jb2a.muzzle_flash.single.01.yellow", tracer: "jb2a.bullet.01.orange", tracerColor: TRACER_COLOR, muzzleSquares: 1.2, motes: 12, impactSquares: 0.75 },
  rifle:   { sound: "shot-rifle",   muzzle: "jb2a.muzzle_flash.single.01.yellow", tracer: "jb2a.bullet.02.orange", tracerColor: TRACER_COLOR, muzzleSquares: 1.6, motes: 13, impactSquares: 0.95 },
  shotgun: { sound: "shot-shotgun", soundBurst: "shot-shotgun-burst", muzzle: "jb2a.muzzle_flash.single.01.yellow", tracer: "jb2a.bullet.01.orange", tracerColor: null, muzzleSquares: 1.9, muzzleMs: 220, motes: 10, smokeSquares: 0.6, smokeSingle: true, impactSquares: 1.15, pellets: 6, spreadRad: 0.07, dashSquares: 0.7, dashMs: 150, cadenceMs: 180 },
  heavy:   { sound: "shot-heavy",   muzzle: "jb2a.muzzle_flash.single.01.yellow", tracer: "jb2a.bullet.02.orange", tracerColor: TRACER_COLOR, muzzleSquares: 2.1, motes: 16, impactSquares: 1.3 },
});

/* ══════════════════════ The ammo overlay (FR#24) ══════════════════════ */

/**
 * THE TWO PROMOTED IMPACTS — a different mark at the far end of the shot for a round that arrives
 * differently. Both are free-tier keys, both verified against the installed database at build time
 * (and gated by fxDbEntryExists at play time, so a tier that lacks one degrades to the ordinary
 * impact rather than showing nothing).
 *
 * `clipMs` is MEASURED off the installed file, not read off a label:
 *   ImpactFire01_01_Regular_Orange_600x600.webm ......... 2267ms
 *   GroundCrackImpact_01_Regular_Orange_600x600.webm .... 5033ms
 * against the ordinary impact's own 833ms (HIT_CONFIRM.clipMs). Those are three to six times the mark
 * they replace, which is the reason the trim below exists rather than being a tuning preference.
 *
 * ⚠ THE KEYS ARE THE PARENT PATHS ON PURPOSE. `jb2a.impact.ground_crack.orange` holds three files
 * (GroundCrackImpact_01..03) and the engine picks one per section, so successive AP hits do not stamp
 * the identical crack. The fire family has only one file on the free tier, so its key resolves to the
 * same clip every time — stated so the asymmetry is not read as an oversight.
 */
// ⏪ ON NO SHIPPED ROW as of 2026-08-09 — the api promotion that used it was withdrawn on report (the
// ruling is at the AMMO_FX api entry). Left declared rather than deleted, the way this file leaves
// every superseded mechanism wired: restoring it is one field on one row.
export const IMPACT_FIRE = Object.freeze({ key: "jb2a.impact.fire.01.orange", clipMs: 2267 });
export const IMPACT_CRACK = Object.freeze({ key: "jb2a.impact.ground_crack.orange", clipMs: 5033 });

/**
 * THE THIRD PROMOTED IMPACT (2026-08-09) — the BLUNT mark, for a round that does not penetrate.
 *
 * `jb2a.smoke.puff.ring.01.white`, 1067ms measured off the installed file (three variants under the
 * key, so successive hits do not stamp the identical puff — the same property IMPACT_CRACK has). It is
 * NOT given its own `impactClipMs`: the default trim is the ordinary mark's 833ms, which is the
 * promotion rule above applied unchanged, and it lands neatly — ink coverage peaks at 0.46s and the
 * ring is breaking up by 0.76s, so 833 keeps the whole readable life and drops the dying specks.
 *
 * ⭐ WHY THIS ONE, out of a closed enumeration of the free tier's impacts (decoded frame by frame, not
 * chosen by name):
 *   impact.001/002/003/011/012.blue ...... yellow or electric SPIKE STARBURSTS. Ruled out by the
 *                                          standing 2026-08-08 no-starburst ruling, which is about the
 *                                          shape and not about the colour.
 *   impact.water.02.blue ................. a wet splat leaving a smudge. Reads liquid, not blunt.
 *   side_impact.part.smoke.blue.01-03 .... crystalline shards, 3067ms. Reads ice/magic.
 *   side_impact.part.shockwave.blue ...... concentric rings, and the best BLUNT read on the tier — but
 *                                          the arcs face one baked direction and the impact is drawn
 *                                          with no rotation, so it would point the same way whichever
 *                                          way the shot went. Rejected on that, not on looks.
 *   smoke.puff.centered.grey ............. wispy curls, 2300ms, peak luminance 87/255. Too slow and too
 *                                          faint to read as an arrival at all.
 *   smoke.puff.ring.01.white ............. ⭐ blooms to a solid cloud by 0.30s and opens into a ring of
 *                                          dust; radial, so no rotation question; peak luminance
 *                                          217/255, so it exists on a dark range.
 *
 * ⚠ IT IS SMOKE ROUTED ABOVE THE LIGHTING, which is a departure from this file's own routing rule in
 * the same shape as the blood splash's — dust does not glow. It is not a NEW departure: the impact draw
 * path lifts every hit mark unconditionally, so this asset simply inherits what the element already
 * does. Recorded here so a reader meets the fact at the asset rather than discovering it.
 */
export const IMPACT_DUST = Object.freeze({ key: "jb2a.smoke.puff.ring.01.white", clipMs: 1067 });

/**
 * WHERE THE PELLETS LANDED — a small mark at each pellet's own endpoint, for a fanned round that hit.
 *
 * ⭐ THE HALF OF THE TRIAL THE USER KEPT (ruling 2026-08-11): *"the arrival fireballs were GREAT but
 * scale them DOWN"* by at least half. The volley baked its arrivals into one clip and they went with
 * it; this puts them back on the fan, where they belong to the pellets that actually caused them —
 * `pelletEndpoints` already computes those positions for the tracers, so nothing is invented here.
 *
 * `squares: 0.45` — the drawn width, against the shell class's own aim-point mark at 1.15 squares.
 * That is under 40% of the mark this rail already draws on the target and comfortably inside the "at
 * least half down" the ruling asks for, which is what keeps six of them from becoming the wall of fire
 * the volley's blooms were being scaled back from. It is a LOOK call and it wants eyes.
 *
 * ⚠ IT IS THE SAME ASSET AS `IMPACT_DUST`, deliberately and not by accident: that key was chosen out of
 * a closed enumeration of the free tier's impacts precisely as the BLUNT, radial, no-rotation-question
 * arrival mark (the survey is at IMPACT_DUST), which is the same job at a smaller size. It is declared
 * as its own constant rather than as a reference because the two elements answer to different rulings
 * and either may be re-pointed without the other. A reader counting sprites should know that a baton
 * shell puts its own dust mark on the aim point at the class's 1.15 squares and six of these at the
 * pellet endpoints at 0.45, all out of one key — so tell them apart by SIZE, not by file.
 *
 * `clipMs: 500` — a trim, not the asset's life (the dust ring runs 1067ms). Six marks landing within a
 * few frames of each other need to be gone before the next discharge, and the ring's ink is dense
 * through its first half; 500 keeps the bloom and drops the drift. It sits under the 833ms the aim-point
 * mark is trimmed to, so these can never be the last thing on screen and the tail arithmetic does not
 * take a term for them.
 *
 * ⛔ THE RAZOR SPLIT — STANDARD BUCK GETS DUST, THE INCENDIARY SHELL GETS ITS FIRES. The ruling reserves
 * fire arrivals for the incendiary load, and the incendiary load ALREADY has them: its landing points
 * are the same pellet endpoints, and `fxGroundFire` sets a real flame burning at each one. So the split
 * is not two assets chosen by load name — it is one gate, `entry.groundFire`, and a load that lights
 * its landings does not also get dust over them. That also honours the standing 2026-08-09 ruling that
 * removed the api row's fire impact ("get rid of the blast circle that lands on the target"): drawing a
 * fire mark here would have re-created exactly the doubling that ruling deleted. The api shell's red
 * treatment is therefore untouched, which is what the user asked for.
 */
export const PELLET_ARRIVAL = Object.freeze({
  key: "jb2a.smoke.puff.ring.01.white",
  squares: 0.45,
  clipMs: 500,
});

/**
 * THE BATON ROUND (2026-08-09, user ruling) — the less-lethal load drawn as a SOLID OBJECT instead of
 * as a light. Everything the rubber/stun-dart treatment is made of, in one block, because a veto lands
 * on the whole idea rather than on one of its numbers.
 *
 * ⭐ WHAT THE RULING ASKED FOR. "What you did for rubber bullets doesn't look good. Instead of
 * darkening/muting the color, let's look for a better asset to represent rubber bullets." So the load
 * is now identified by WHAT IS DRAWN, not by how dim it is.
 *
 * `key` — `jb2a.throwable.launch.cannon_ball.01.black`. Enumerated against the free tier's whole ranged
 * family rather than picked by name; what is actually available as a non-glowing projectile is:
 *   bullet.03.blue ........ a blue bolt that develops a full spiky STARBURST at 0.30s and a rayed radial
 *                           bloom at 0.44s — more "magical" than the orange bullet it would replace, so
 *                           ruled out by the standing no-starburst ruling.
 *   snowball_toss.white ... 2867ms, and it ends in snowflakes and ice crystals.
 *   boulder.toss.02 ....... a tumbling rock. Legible, and it was captured as candidate C (59c) — but its
 *                           art travels BACKWARD across its own frame (centroid 0.46 → 0.27 → 0.65 of
 *                           frame width) and it reads as a thrown stone rather than as a fired round.
 *   throwable.launch.cannon_ball.01.black ... ⭐ a solid tumbling slug with a short speed trail, 467ms
 *                           in the short band, centroid sweeping cleanly forward 0.37 → 0.59. This is
 *                           the tier's only manufactured-looking inert projectile.
 *
 * `squares` = 2.4 — the sprite's drawn FRAME width in grid units, not the slug. Same trap the flechette
 * dart's length records, and measured the same way: the ball occupies 0.10–0.25 of the frame's width
 * across the clip, so 2.4 puts roughly 0.25–0.55 of a square of actual ball on the screen — just above
 * buckshot's ~0.42sq of lit streak at its own 1.0. Do not read 2.4 as "a slug two squares wide".
 *
 * `crossMs` = 240 — how long the round takes to cross to what was aimed at, against buckshot's 150 and
 * the flechette dart's 170. It is the SLOWEST thing this rail fires, and that is the second half of the
 * representation: a baton round is the one load you can watch arrive. This is a TAIL INPUT (see
 * presentationTailMs) and it is threaded, so the apply window moves with it rather than behind it.
 *
 * ⭐ THE TRAVELLED FORM IS ALSO WHAT MAKES THE SWAP SAFE, and that is worth stating because it looks
 * like a style choice and is not. A painted (stretched) tracer's on-screen life is the ASSET's own clip,
 * bounded once for the whole rail by TRACER_CLIP_MS = 933 — measured as the upper bound of the two
 * bullet families. This asset's bands run 467 / 767 / 1167 / 2067 / 2433ms, so painting it would put
 * two of five bands past that bound and the tail would come back short with no signal — the silent,
 * one-directional failure presentationTailMs warns about. A travelled sprite's life is `dashMs +
 * DASH_ARRIVAL_HOLD_MS` and owes the asset nothing.
 */
export const BATON_ROUND = Object.freeze({
  key: "jb2a.throwable.launch.cannon_ball.01.black",
  squares: 2.4,
  crossMs: 240,
});

/**
 * ⭐ THE RULE THAT KEEPS AN IMPACT PROMOTION FROM MOVING THE CLOCK: a promoted impact is drawn for the
 * SAME time the ordinary one is, by trimming it. It changes the MARK, not the PACING.
 *
 * Why this is a rule and not a preference. The apply window waits for the round's terminal elements
 * (presentationTailMs → the settle signal), so an impact that runs 5s instead of 0.833s would hold the
 * damage window shut for five seconds on every armour-piercing hit — a cost nobody asked for, on the
 * cheap tier of this unit, arriving as a side effect of choosing a different picture. Trimming makes
 * the promotion free in exactly the dimension the user is sensitive to.
 *
 * WHAT IS GIVEN UP, stated rather than discovered: both assets spend their opening on the mark itself
 * and their remainder on a fade — embers for the fire, cooling glow for the crack — so the trim keeps
 * the impact and drops the fade. On AP that is simply a shorter mark. On incendiary the loss is
 * covered by something better: the burning-ground element (GROUND_FIRE) sits at that same point for
 * seconds afterwards, so the linger the trim removed is drawn by the element that exists to draw it.
 *
 * Applied UNIFORMLY, with no branch: every impact is played through `timeRange(0, impactClipMs)` and
 * the default is the ordinary impact's own full length, so for an unpromoted row the trim is a no-op
 * on a clip it exactly equals. An overlay that genuinely wants the long fade names its own
 * `impactClipMs` and gets it — and then honestly pays for it in the tail, because the tail reads the
 * same field.
 */

/**
 * THE OVERLAY TABLE — one optional row per ammo modifier id, shallow-merged over the weapon class's
 * row. The class says what KIND of gun fired; this says what was IN it. Ammo that names no row here
 * (standard, brass-cased, anything unrecognised) draws exactly what it drew before this table existed,
 * which is the property every "unchanged" leg in the keeper pins.
 *
 * The ids are `system.modifier` on the loaded ammo item — lookups.js AMMO_MODIFIERS, seeded by
 * ammoModifierSystemFields — and they ride the weaponFired payload as `payload.modifier` (seam-shim
 * AMMO_EFFECT_FIELDS). Resolution is ammoFxKeyOf below.
 *
 * ⚠ THE MERGE IS NOT A PLAIN SPREAD, and the difference is a standing user ruling rather than an
 * implementation detail. See ammoFxEntry: the masked fields may only repaint or re-picture an element
 * the class already DECLARES, never add one — so an overlay cannot give a class a bolt colour, or a
 * bolt asset, on a bolt it does not draw.
 *
 * ⭐ DECLARED IS NOT THE SAME AS PAINTED, and that distinction is what lets one rule serve two rulings
 * (2026-08-09). The mask asks whether the class row CARRIES the field, so a row may carry it as `null`:
 * "this element is repaintable, and I paint it with nothing." The shell row does exactly that for its
 * pellet fan. The outcomes, with no branch anywhere naming a class:
 *   - base shell        — `tracerColor: null` → no ColorMatrix on the fan, the settled buckshot look
 *   - incendiary shell  — the overlay's shift lands on the pellet fan
 *   - incendiary rifle  — the same overlay tints the single bolt it actually draws
 *   - a class whose row omits a field entirely — the overlay's value for it is dropped, never added
 * ⏪ The earlier form of this rule kept the shell's fan untinted under EVERY load by leaving the field
 * out. The user superseded that for ammo: "make sure when you update the animation for one shotgun ammo
 * type, it's updated for all." The base look is unchanged; only the overlays reach further.
 *
 * FIELDS THIS TABLE MAY CARRY, beyond the class row's own vocabulary:
 *  - `impactKey`     the hit-confirmation asset, promoted per round (see the two blocks above)
 *  - `impactClipMs`  how long that impact is drawn — the trim, and the tail term with it
 *  - `impactScale`   a MULTIPLIER on the class's own `impactSquares`, never an absolute width. An
 *                    absolute value would flatten the classes into one size: the table steps the
 *                    impact from 0.7 (pistol) to 1.3 (heavy) precisely because a heavy round lands
 *                    harder, and a hollow-point should be wider THAN ITS OWN CLASS, not wider than
 *                    everything. A multiplier keeps both facts.
 *  - `flashColor`    the muzzle light's colour IN THE DARK REGIME ONLY (flashColorFor). It cannot
 *                    reach a lit scene — the gate returns null before the ammo colour is consulted.
 *  - `groundFire`    this round leaves fire on the ground where it lands (fxGroundFire), once per
 *                    payload, never per round.
 *
 * ⭐ THE REALISM RAZOR (2026-08-09, user ruling): **a load gets a visual only if you could plausibly
 * see the difference.** Two rows were DELETED under it rather than retuned — `hollowPoint` and
 * `safety`, which had existed only to widen and narrow the hit mark by a multiplier. Nobody watching a
 * firefight can tell a hollow-point from ball ammunition by the size of the mark it leaves, and a table
 * that is shown a difference which does not exist learns to distrust the ones that do. Their MECHANICS
 * are untouched — only the pictures died — so bench guns 02 and 03 now draw identically to 01, which is
 * the point of that row rather than a regression in it. `impactScale` is still a live field (flechette
 * uses it), so restoring either is one row.
 *
 * THE ROWS, and what each is saying:
 *  - `api` — the only load that is on fire. Red-shifted bolt, a warm muzzle light in the dark, and the
 *    two ground elements. Everything else on this table is one or two fields.
 *  - `ap` / `dualPurpose` — identical treatment, and deliberately so: their MECHANICS are byte-identical
 *    (lookups.js gives both the same armour and past-armour multipliers), so drawing them differently
 *    would be inventing a distinction the rules do not make. They are two rows rather than one alias
 *    because the ids are what arrive on the payload and a reader looking one up should find it.
 *  - `slug` — ⭐ NEW 2026-08-09. The one shotgun load that puts a SINGLE projectile down the barrel, and
 *    until now it inherited the class's six-pellet fan, which drew a slug as buckshot. It is expressed
 *    entirely in the class row's own vocabulary rather than with a new mechanism:
 *      `pellets: 1`     — pelletEndpoints only fans for a count ABOVE one, so a count of one returns no
 *                         fan at all and the draw path falls through to the single-endpoint branch every
 *                         non-shell class already takes. One is also what the load literally is, which
 *                         is why it is written as 1 and not as 0.
 *      `dashSquares: 0` — a zero length is the draw path's own switch from TRAVELLED to PAINTED, so the
 *                         round is stretched across the shot line like a rifle bolt instead of crossing
 *                         it as a short dash.
 *      `dashMs: 0`      — and this one is NOT cosmetic. `dashMs` is a tail input: left at the shell's
 *                         150 the tail would have computed 150 + 260 for a tracer that is in fact
 *                         painted and lives TRACER_CLIP_MS, and the apply window would have opened
 *                         half a second early on every slug. Zeroing it is what makes the arithmetic
 *                         read the painted branch.
 *      `tracer` / `tracerColor` — the heavy `bullet.02` the rifle and the heavy draw, in the standard
 *                         tracer shift, so a slug reads as rifle fire. Both fields are MASKED fields
 *                         and both land, because the shell row declares each of them (the colour as
 *                         `null` — declared, painted with nothing).
 *  - `flechette` — the overlay that re-pictures the round without changing how many of them there are.
 *    It says the round with a LENGTH, a CROSSING TIME, a MARK WIDTH and a COLOUR, and it says nothing
 *    about the count: on a class that draws one round per slot it draws one, and on a class that draws
 *    a group it draws that class's group. Both of those are fall-throughs, not branches.
 *
 *    ⏪⏪ IT USED TO FORCE A GROUP OF EIGHT ONTO EVERY CLASS (`pellets: 8, spreadRad: 0.1` — the revert
 *    values, recorded at the row itself as well). USER RULING 2026-08-10, verbatim: the marks "should
 *    come out in the same bullet stream as the regular shots do — one after the other, single file."
 *    The report it answers, on a stream-firing bench weapon: "flechettes still keep coming for over a
 *    second after the firing sound stops. The animation simply isn't synced up with the shots."
 *
 *    ⭐ WHY THE COUNT WAS THE DEFECT AND NOT THE CLOCK, because the obvious reading is wrong and it is
 *    the same trap FX_DROP_LAG_FRACTION records one level up. The fan-out loop was ALREADY anchored and
 *    already refused rounds it could not draw on time, so the loop finished when the reports did — and
 *    the picture still did not. What was left is the work the drawn rounds had queued: a count of eight
 *    on a twenty-round payload is a hundred and sixty sprites handed to a renderer that draws them at
 *    its own pace, and no pacing rule can reach a backlog created by the rounds it chose to keep. The
 *    only lever on that backlog is the count itself. MEASURED on the rig, twenty rounds at the rifle's
 *    80ms spacing: the last mark left the screen **3433ms** after the last report was played, against a
 *    tail of 1003ms that the arithmetic said was owed — and thirteen of the twenty rounds had already
 *    been refused by the drop rule in the attempt to keep up. The keeper's measured leg is that number.
 *
 *    ⭐ THE DART LOOK IS UNCHANGED, and that is the ruling's other half: what was rejected is the
 *    GROUP, not the round. `tracerColor: TRACER_COLOR_DART` (2026-08-09) still carries the dart
 *    language — see that constant for why grey-means-darts is a rule rather than a preference — and the
 *    length and crossing are still the load's own. What a viewer loses is the eight-abreast shape; what
 *    separates a dart from a bullet is now the colour, the length and the smaller mark, on a round that
 *    arrives in its own cadence slot like every other.
 *    ⚠ ON A CLASS THAT ALREADY DRAWS A GROUP the row changes nothing about how many: the shell's own
 *    `pellets: 6` and `spreadRad: 0.07` come through the merge untouched, so a dart shell is six grey
 *    darts at the shell's own spread. That is the class row speaking, which is the property the mask
 *    rules exist to keep — an overlay may re-picture an element, and here it no longer re-counts one.
 *    ⏪ `dashSquares` 0.8 → 1.1 (2026-08-09, user approval). 0.8 was picked as "smaller than buckshot"
 *    (the shell's 1.0) and never measured, and it read FAINT on a painted-bolt class — capture 56e on
 *    the rifle. The number is the sprite's drawn WIDTH, not the visible slug: this asset animates a
 *    bullet with a trail across its own frame, so the lit part is roughly a fifth of it (the same
 *    caution the shell's own pellet-size note records, where 0.5 read as dirt on the screen). 1.1 sits
 *    just above buckshot's 1.0 — legible on a lit slug. Compare 56e against 57f.
 *    ⚠ It is also the reason presentationTailMs takes an ammo key — `dashMs` is a tail input, and an
 *    overlay that changes it while the tail is computed from the bare class row would open the apply
 *    window early. The length is NOT a tail input, so that change moved no window, and neither does
 *    dropping the count: `dashMs` stays 170 and the tail arithmetic is untouched by both.
 *    ⛔ AND THE ROW MUST KEEP DECLARING ITS OWN PROJECTILE. `ammoRedefinesProjectile` is key presence
 *    over AMMO_FX_PROJECTILE_FIELDS, which listed `pellets` among them — so removing the count is
 *    exactly the edit that could have silently reclassified this load as "a tint only" and handed it to
 *    the branch that replaces the round wholesale. It still answers yes, off `dashSquares` and `dashMs`,
 *    and a keeper leg pins which fields carry the answer.
 *  - `rubber` — the BATON treatment, and the only overlay that changes what the round IS rather than
 *    what colour it is. The round becomes a solid travelled slug (BATON_ROUND), the hit becomes a dust
 *    puff (IMPACT_DUST), and one matrix (TRACER_COLOR_BATON) repaints it.
 *    ⏪⏪ SUPERSEDES the dulled-bolt/small-mark treatment (tracer brightness 0.60, `impactScale` 0.6),
 *    rejected on report 2026-08-09: "instead of darkening/muting the color, let's look for a better
 *    asset to represent rubber bullets." Both halves of that treatment are gone, and the second half
 *    deliberately: a blunt round does not make a SMALLER mark than a bullet, it makes a different one,
 *    and shrinking it was the same "say it with less" reflex the ruling rejected. The mark is now
 *    identified by its picture and drawn at the class's own width. Captures 59-control vs 59b.
 *  - `stundart` — ⏪ NO LONGER THE BATON'S TWIN (2026-08-09, the realism razor). It used to be
 *    byte-identical to `rubber`, on the reading that both are less-lethal and their only difference is a
 *    stun modifier nobody can see. The ruling reversed that on the object rather than on the mechanic: a
 *    baton round is a fat blunt slug and a stun dart is a **needle** — thin, finned — so they do not
 *    look alike at all, and drawing them alike was the visible error. It says the round in the DART
 *    LANGUAGE: the dart's length, its crossing time, a smaller mark and the grey — which says two true
 *    things at once: it is a needle, and it is not a bullet. The baton asset and the dust puff stay with
 *    `rubber` alone, which is where the round they depict lives.
 *
 *    ⏪⏪ AND IT NO LONGER FORCES A GROUP EITHER (`pellets: 8, spreadRad: 0.1` — the revert values,
 *    recorded at the row itself as well). USER RULING 2026-08-11, verbatim, asked whether this load
 *    should draw single file the way `flechette` now does: *"Is it fired from a weapon that usually
 *    fires in a single file line? If so yes. If it's fired from a shotgun, no."* That is the CLASS
 *    deciding the shape, which is exactly the mechanism the 2026-08-10 single-file ruling put in one row
 *    up — so the answer here is the same removal rather than a second rule. With no count on the row a
 *    stream-firing class draws ONE dart per round through the same per-round path standard ammo takes,
 *    and a shotgun class fans from ITS OWN row (6 at 0.07 rad). Both are fall-throughs, neither is a
 *    branch, and nothing in the draw path was taught a new word.
 *    ⚠ THE 2026-08-10 NOTE THAT STOOD HERE said the count and the cone were this row's own "in their own
 *    right", on the reading that a stun dart is a group of needles out of one cartridge. The ruling
 *    above supersedes the first half and re-reads the second rather than contradicting it: a stun dart
 *    fired out of a SHELL still draws a group of needles, and it draws the shell's own, because the
 *    class row says so. What is gone is the overlay forcing that group onto a rifle.
 *    ⭐ THE DART LOOK IS UNTOUCHED, the same half the flechette ruling kept: `dashSquares: 1.1`,
 *    `dashMs: 170`, `impactScale: 0.7` and `tracerColor: TRACER_COLOR_DART` all stay. `dashMs` is the
 *    tail's own input and it did not move, so the tail is still 1003ms on a stream class and no apply
 *    window opened early.
 *    ⛔ AND THE ROW MUST KEEP DECLARING ITS OWN PROJECTILE, for the reason the flechette note records
 *    one row up: `ammoRedefinesProjectile` is key presence over AMMO_FX_PROJECTILE_FIELDS, which lists
 *    `pellets` among them — so this removal is exactly the edit that could have quietly reclassified the
 *    load as "a tint only" and handed it to the branch that replaces the round wholesale. That is not a
 *    hypothetical here: the stun-dart 00 shell is the very load that branch was drawing orange fireballs
 *    over until 2026-08-10 (see ammoRedefinesProjectile). It still answers yes, off `dashSquares` and
 *    `dashMs`, and a keeper leg pins which fields carry the answer.
 *    ⭐ THE TWO DART ROWS ARE ONE SET OF FIELDS AGAIN, which is what they were before 2026-08-10 and for
 *    the reason that was always true: a stun dart and a flechette dart ARE the same object fired for
 *    different reasons, so a reader who has understood one row has understood both. They are still
 *    written out separately rather than shared, because one ruling has already moved one of them without
 *    the other and the next one may too — a ruling on either is a two-field edit at its own row.
 */
export const AMMO_FX = Object.freeze({
  // ⏪ THE IMPACT PROMOTION IS WITHDRAWN (user ruling 2026-08-09, verbatim: *"get rid of the blast
  // circle that lands on the target. I think multiple are being placed"*). This row used to promote the
  // hit mark to IMPACT_FIRE, which drew a burning ring ON the target on top of the burning ground the
  // same load already sets at the landing points — and because the mark is drawn per LANDING ROUND, a
  // burst stacked one ring per hit in the same place, which is the doubling the report names. Removing
  // the field is the whole fix: with no `impactKey` the row falls through to the class's own standard
  // hit mark, exactly as every unpromoted load does. Everything else about the load is untouched — the
  // tinted rounds, the tinted flash and the burning ground it leaves behind all stay.
  api: Object.freeze({
    tracerColor: TRACER_COLOR_INCENDIARY,
    flashColor: "#ff6a1a",
    groundFire: true,
  }),
  // ⏪ THE FLIGHT TINT IS GONE FROM BOTH HARDENED ROWS (user ruling 2026-08-11, at the bench). The
  // question the user put was a consistency one: the hollow-point treatment had already been deleted
  // under the realism razor for saying a difference a viewer cannot see, so why does an armour-piercing
  // round still FLY differently? It does not, in fact — a hardened core changes what happens when the
  // round lands, not what the round looks like crossing a room — so the near-white bolt was the rail
  // asserting something untrue about the flight. Both rows now fall through to the CLASS's own tracer
  // colour, which is to say an AP round flies exactly like a standard one.
  //   THE IMPACT STAYS, and that is what makes this pass the razor rather than delete a distinction:
  // `IMPACT_CRACK` is a visibly different strike at the far end, which is where the difference actually
  // is. The revert value, so restoring the flight tint is one line at each row:
  // `tracerColor: TRACER_COLOR_HARDENED`.
  ap: Object.freeze({
    impactKey: IMPACT_CRACK.key,
  }),
  dualPurpose: Object.freeze({
    impactKey: IMPACT_CRACK.key,
  }),
  // ⏪ `hollowPoint` and `safety` STOOD HERE and were deleted 2026-08-09 under the realism razor (see
  // the block above): two rows whose entire content was an `impactScale` multiplier on the hit mark.
  // Their mechanics are untouched — this table has never been read by any damage path — so what died
  // is a difference a viewer could not have seen. Restoring either is one line.
  //
  // THE ONE SHOTGUN LOAD THAT IS A SINGLE PROJECTILE. Written only in the class row's own fields, so
  // nothing in the draw path learns a new word; the reasoning for each is in the row notes above, and
  // `dashMs: 0` in particular is a TAIL correction and not a cosmetic one.
  slug: Object.freeze({
    tracer: "jb2a.bullet.02.orange",
    tracerColor: TRACER_COLOR,
    pellets: 1,
    dashSquares: 0,
    dashMs: 0,
  }),
  // ⏪ THE COUNT AND THE CONE ARE GONE (user ruling 2026-08-10 — see the row note above). The revert
  // values, so restoring the group form is one edit at this site: `pellets: 8, spreadRad: 0.1`.
  flechette: Object.freeze({ dashSquares: 1.1, dashMs: 170, impactScale: 0.7, tracerColor: TRACER_COLOR_DART }),
  rubber: Object.freeze({
    tracer: BATON_ROUND.key,
    tracerColor: TRACER_COLOR_BATON,
    dashSquares: BATON_ROUND.squares,
    dashMs: BATON_ROUND.crossMs,
    impactKey: IMPACT_DUST.key,
  }),
  // ⏪ NOT `rubber`'s twin any more — a needle, in the same grey dart language the flechette row speaks.
  // The LOOK is deliberately the dart look (length, crossing, mark and grey), so a reader who has
  // understood one row has understood both.
  // ⏪ THE COUNT AND THE CONE ARE GONE HERE TOO (user ruling 2026-08-11 — see the row note above: the
  // class decides the shape, single file on a stream-firing weapon and the shell's own fan on a shell,
  // exactly as `flechette` does since 2026-08-10). The revert values, so restoring the group form is one
  // edit at this site: `pellets: 8, spreadRad: 0.1`.
  stundart: Object.freeze({ dashSquares: 1.1, dashMs: 170, impactScale: 0.7, tracerColor: TRACER_COLOR_DART }),
});

/**
 * The overlay fields that may only REPAINT, never ADD. See the ruling in the AMMO_FX block: an overlay
 * may change the colour of an element the class already DECLARES; it may not give a class an element
 * its row deliberately omits.
 *
 * ⚠ THE TEST IS `=== undefined`, i.e. key PRESENCE, and that is deliberate rather than incidental — a
 * truthiness test would collapse `null` (declared, painted with nothing) into absent and silently undo
 * the 2026-08-09 pellet ruling. Do not "tidy" it to a falsy check.
 */
export const AMMO_FX_RECOLOR_FIELDS = Object.freeze(["tracerColor"]);

/**
 * The overlay fields that may only REPLACE an element's asset, never ADD the element — the same rule as
 * the recolour fields above, extended (2026-08-09) from "what colour is it" to "what picture is it".
 *
 * WHY THIS EXISTS. The baton treatment is the first overlay that says the round with a different FILE
 * rather than with a different colour, and the slug row is the second. A bare overwrite would let an
 * overlay hand a class an element its row deliberately omits, which is precisely what the
 * repaint-never-add ruling forbids one field away for colour. Every class row declares `tracer`, so a
 * `tracer` swap reaches all five exactly as before; the mask is what keeps that a guarantee rather than
 * a convention.
 *
 * ⏪ `column` WAS THE SECOND ENTRY and went with the mechanism on 2026-08-09 (see the deletion block
 * above the class table). It had been added here for exactly one reason — so that `column` could never
 * become a way to hand a pistol a shotgun's discharge blast — and with no such element in the file
 * there is nothing left for the mask to guard.
 *
 * ⚠ SAME `=== undefined` TEST, for the same reason — key presence, so the shell's declared-but-unpainted
 * fields keep meaning what they mean. See the AMMO_FX block.
 */
export const AMMO_FX_REPLACE_FIELDS = Object.freeze(["tracer"]);

/**
 * The overlay fields that describe THE ROUND'S OWN GEOMETRY — what shape leaves the barrel, how many of
 * them, how long each is and how long it takes to cross. A row carrying any of these has drawn its own
 * picture of the projectile; a row carrying none of them has only said what colour or what mark the
 * class's round makes.
 */
export const AMMO_FX_PROJECTILE_FIELDS = Object.freeze(["pellets", "dashSquares", "dashMs", "tracer"]);

/**
 * DOES THIS LOAD DRAW ITS OWN ROUND? Pure, so the answer is asserted by value against the table rather
 * than by watching a shot.
 *
 * ⚠ WHY THE VOLLEY HAS TO ASK IT (2026-08-10). `volleyOwns` asks the CARTRIDGE — is this buckshot — and
 * that question is right for what it was written for: a table's damage-pattern switch must not repaint a
 * gun. But "buckshot" is derived from the caliber, and several LOADS of buckshot set no spread mode of
 * their own, so every one of them fell into the volley branch — including the two whose whole row is a
 * different projectile. A stun-dart 00 shell was given the grey dart fan by one ruling and then
 * drew orange fireballs anyway, because the branch that replaced the round never asked what the round
 * was; a baton round did the same. (Flechette and slug escaped only because they happen to declare a
 * spread mode, which is a mechanical fact standing in for a presentation one — luck, not a rule.)
 *
 * So the rule is written where it belongs, on the TABLE: an overlay that names its own projectile
 * geometry keeps its own picture, and the volley draws the loads that only tint or re-mark the class's
 * own round (base, api, ap, dualPurpose). Key PRESENCE again, the same test the masks use, so a row that
 * ever declares one of these as `null` is still saying "this is mine to draw".
 */
export function ammoRedefinesProjectile(ammoKey) {
  const row = ammoKey ? AMMO_FX[ammoKey] : null;
  if (!row) return false;
  return AMMO_FX_PROJECTILE_FIELDS.some((f) => row[f] !== undefined);
}

/**
 * WHICH LOAD FIRED — the ammo key for one weaponFired payload. Pure.
 *
 * ID FIRST. The payload carries the modifier's own id (`payload.modifier`, added to the seam's
 * AMMO_EFFECT_FIELDS for exactly this), so when it is there it IS the answer and nothing is inferred.
 * That matters beyond tidiness: `ap` and `dualPurpose` carry byte-identical mechanics, so no amount of
 * looking at the consequences can tell them apart — only the id can.
 *
 * FINGERPRINT SECOND, and only when there is no id: a payload emitted before that field existed (a
 * relayed one, an older session, a test emission) still carries the MECHANICS the modifier seeded, and
 * those are nearly unique. This is a compatibility path, not the design.
 */
export function ammoFxKeyOf(payload) {
  const id = String(payload?.modifier ?? "").trim();
  if (id) return id;
  return ammoFxFingerprintKey(payload);
}

/**
 * The ammo key inferred from a payload's MECHANICS alone, for a payload carrying no id. Pure.
 *
 * Order is load-bearing where two loads overlap:
 *  - api is tested BEFORE ap, because api's armour and past-armour multipliers are ap's exactly; what
 *    separates them is that api is the only load in the registry with a FIRE damage-over-time.
 *  - stundart before rubber (its stun modifier is −2 where rubber's is the default 0).
 *
 * ⚠ RUBBER TAKES AN EXTRA TERM THAT THE SURVEY'S TABLE DID NOT LIST, and the reason is measured rather
 * than theoretical: `stunSaveOnHit` with a zero modifier is ALSO what a taser/explosive warhead's own
 * fields look like — the b1 seam probe's payload carries `stunSaveOnHit: true, stunSaveMod: 0` off a
 * grenade — so that pair alone would paint every such round with the baton-round matrix. Rubber is the
 * only registry entry that pairs it with a HALVED past-armour multiplier, so that term is what makes
 * the test honest. Nothing is lost: a genuine rubber round always carries it (lookups.js AMMO_MODIFIERS).
 *
 * An unrecognised or unremarkable payload comes back "standard", which has no overlay row — so the
 * fallback for "I cannot tell" is drawing exactly what was drawn before this table existed.
 */
export function ammoFxFingerprintKey(payload) {
  if (!payload || typeof payload !== "object") return "standard";
  const n = (v) => Number(v);
  if (payload.dotEnabled === true && String(payload.dotType ?? "") === "fire") return "api";
  if (String(payload.spreadMode ?? "") === "flechette") return "flechette";
  // The slug declares itself the same way the flechette does — `spreadMode` is the one mechanical field
  // that separates the shotgun loads from each other, and it is the same field spreadModeForAmmo reads
  // to decide whether this shot throws a pattern. Added 2026-08-09 with the slug's own row.
  if (String(payload.spreadMode ?? "") === "slug") return "slug";
  if (n(payload.armorMultSoft) === 2 && n(payload.penDamageMult) === 3) return "safety";
  if (n(payload.armorMultSoft) === 2 && n(payload.penDamageMult) === 1.5) return "hollowPoint";
  if (payload.stunSaveOnHit === true && n(payload.stunSaveMod) === -2) return "stundart";
  if (payload.stunSaveOnHit === true && n(payload.stunSaveMod) === 0 && n(payload.penDamageMult) === 0.5) return "rubber";
  if (n(payload.armorMultSoft) === 0.5 && n(payload.penDamageMult) === 0.5) return "ap";
  return "standard";
}

/**
 * THE ONE PLACE A CLASS ROW AND AN AMMO OVERLAY ARE COMBINED. Pure, so every treatment in the table is
 * asserted by value with no canvas, no engine and no shot.
 *
 * Returns the class row untouched (the same frozen object, not a copy) when there is no overlay to
 * apply, which is what makes "standard ammo changes nothing" a checkable identity rather than a
 * field-by-field comparison.
 *
 * THREE STEPS, in this order:
 *  1. THE MASKED FIELDS are applied only where the class row already CARRIES them — key presence, so a
 *     row carrying `null` is repaintable while painting nothing itself (the ruling in the AMMO_FX
 *     block — repaint, never add). Two lists, one rule: AMMO_FX_RECOLOR_FIELDS is what colour an
 *     element is, AMMO_FX_REPLACE_FIELDS is which picture it is.
 *  2. Everything else is a plain overwrite, so an overlay may genuinely give a class an element it did
 *     not have: that is how the baton row gives a painted-bolt class a travelled slug and its own dust
 *     mark. An overlay that names none of a field leaves the class's own answer standing, which is how
 *     BOTH dart rows draw one dart on a class that fires one round and the shell's own six on a class
 *     that fires six.
 *  3. `impactScale` is spent against the CLASS's own impact width and then removed from the result, so
 *     what comes out is an ordinary class row that any existing reader understands — the multiplier is
 *     a way of writing the table, not a new field the draw path has to know about.
 *
 * ⚠ RESOLUTION HAPPENS HERE AND NOWHERE ELSE, and callers pass the KEY rather than the entry: fxShot
 * has no payload to read a key from, so if it resolved its own it would have to be handed one anyway.
 * The key is resolved once per payload in fxWeaponFired and threaded down.
 */
export function ammoFxEntry(weaponClass, ammoKey = null) {
  const base = FX_CLASSES[weaponClass];
  if (!base) return null;
  const overlay = ammoKey ? AMMO_FX[ammoKey] : null;
  if (!overlay) return base;
  const out = { ...base };
  for (const [field, value] of Object.entries(overlay)) {
    const masked = AMMO_FX_RECOLOR_FIELDS.includes(field) || AMMO_FX_REPLACE_FIELDS.includes(field);
    if (masked && base[field] === undefined) continue;
    out[field] = value;
  }
  if (out.impactScale !== undefined) {
    const width = Number(base.impactSquares);
    if (width > 0) out.impactSquares = Number((width * Number(out.impactScale)).toFixed(4));
    delete out.impactScale;
  }
  return out;
}

/**
 * ⭐ THE ONE DERIVATION OF CLOCK 2 — when this round arrives — for every shape this rail draws. Pure.
 *
 * There are three ways a round crosses to what it was pointed at, and before 2026-08-11 only two of
 * them had an answer here: a volley knew its band's baked crossing time, a TRAVELLED dash knew its own
 * `dashMs`, and a PAINTED (stretched) round was given zero, which is what put the impact family at the
 * muzzle instead of at the target (the defect is written up at TRACER_ARRIVAL_MS). The painted answer
 * is now read off the same measured band table the engine picks its file from.
 *
 * IT IS ONE FUNCTION AND NOT THREE BECAUSE THE ELEMENTS HAVE TO AGREE. The hit mark, the blood spray,
 * the burning ground and the tail floor all hang on this number; a second derivation anywhere is a way
 * for the mark and the blood on one shot to disagree about when the round got there. The fan-out
 * resolves it ONCE per payload and threads it, exactly as it threads the load key and the volley spec.
 *
 * `distSquares` is the only impure input, and it is passed rather than measured here so this stays
 * assertable with no canvas. `source` is reported for the keeper — it says WHICH of the three shapes
 * answered, which is the thing a test would otherwise have to infer from the number.
 */
export function arrivalSpecFor(weaponClass, ammoKey = null, distSquares = 0, volley = null) {
  if (volley) return { ms: Number(volley.crossMs) || 0, source: "volley", band: volley.band ?? null };
  const entry = ammoFxEntry(weaponClass, ammoKey);
  if (!entry) return { ms: 0, source: "none", band: null };
  const dash = Number(entry.dashMs) > 0 ? Number(entry.dashMs) : 0;
  if (dash > 0) return { ms: dash, source: "dash", band: null };
  return { ms: tracerArrivalMs(entry.tracer, distSquares), source: "stretch", band: tracerBandFor(distSquares) };
}

/**
 * THE HIT MARK THIS CLASS AND LOAD DRAW, resolved once and read by both the sites that draw it — the
 * ordinary round inside fxShot, and the round the pacing rule refused (fxHitMark). Pure.
 *
 * Factored out on 2026-08-11 for exactly that reason: the second site is new, and a second copy of the
 * promotion rule (`impactKey` where a row names one, HIT_CONFIRM's key otherwise; `impactClipMs` where
 * a row names one, HIT_CONFIRM's clip otherwise) is how a promoted mark ends up drawn on one path and
 * not the other. Returns null for a row that draws no mark at all.
 */
export function hitMarkFor(weaponClass, ammoKey = null) {
  const entry = ammoFxEntry(weaponClass, ammoKey);
  if (!entry || !(Number(entry.impactSquares) > 0)) return null;
  return {
    key: entry.impactKey ?? HIT_CONFIRM.key,
    squares: Number(entry.impactSquares),
    clipMs: Number(entry.impactClipMs) > 0 ? Number(entry.impactClipMs) : HIT_CONFIRM.clipMs,
  };
}

/**
 * Weapon-class resolution is by TYPE, not by item name (design doc §3): the catalog is far too large
 * to enumerate, and every ranged item already carries a type. Both the stored label ("SMG") and the
 * enum key ("submachinegun") are accepted — lookups.js weaponTypes maps one to the other, and older
 * hand-authored data carries either. Melee/exotic are deliberately absent: melee gets no muzzle fx at
 * all, and the exotic palette (bows, beams) is design question Q3, still open with the user.
 */
export const WEAPON_TYPE_TO_CLASS = Object.freeze({
  pistol: "pistol",
  smg: "smg",
  submachinegun: "smg",
  rifle: "rifle",
  shotgun: "shotgun",
  heavy: "heavy",
});

/**
 * The spacing between rounds of one automatic payload for a class — its own `cadenceMs` where the
 * table gives it one, otherwise the default. Pure, and read once per payload, so the audio, the pellet
 * fan and the flash restart all move together: there is exactly ONE wait in the fan-out loop and every
 * per-round effect starts after it (see fxWeaponFired).
 *
 * WHY A CLASS NEEDS ITS OWN: the default 80ms is the rate the reference footage shows for a machine
 * gun, and at that spacing ten rounds are one continuous event — which is right for a machine gun and
 * wrong for a shell. It was reported as "a continuous hail" where "distinct bursts" were expected, and
 * the cadence is the cause: the flash envelope is muzzleEnvelopeFrames() long (five frames, ~85ms at
 * the reference rate), so a round arriving every 80ms restarts the envelope BEFORE the previous one
 * has finished and the light never goes out. The same holds for the ear — each round's report starts
 * before the last one's transient has passed.
 *
 * WHY 180ms FOR THE SHELL CLASS: it is inside the range real automatic shotguns cycle at — 300 rounds
 * per minute is 200ms and 360 is 167ms, the two rates commonly quoted for the automatic 12-gauge
 * designs — so 180ms (333 rpm) sits between them rather than being invented. What makes it the right
 * number HERE, though, is mechanical rather than historical: it is more than twice the flash envelope,
 * so the light is fully out for ~95ms between rounds and each discharge is separated by darkness
 * instead of blending into the next; and it is longer than the shell class's `dashMs`, so one
 * discharge's pellets have landed before the following round leaves the muzzle. Both of those are
 * checkable against the other constants in this file rather than against taste.
 */
export function classCadenceMs(cls) {
  const own = Number(FX_CLASSES[cls]?.cadenceMs);
  return Number.isFinite(own) && own > 0 ? own : SHOT_CADENCE_MS;
}

/* ══════════════════════════ Capability detection ══════════════════════════ */

/** Is the Sequencer module installed, active, and exposing its Sequence constructor? */
export function sequencerActive() {
  try {
    return game.modules?.get("sequencer")?.active === true && typeof globalThis.Sequence === "function";
  } catch (_e) {
    return false;
  }
}

/** Is any JB2A asset module active? Informational only — fxDbEntryExists is the real gate. */
export function jb2aActive() {
  try {
    return ["jb2a_patreon", "JB2A_DnD5e"].some((id) => game.modules?.get(id)?.active === true);
  } catch (_e) {
    return false;
  }
}

/**
 * Test seam: stand a controlled answer in front of the installed asset database, for the one question
 * this adapter ever asks it. Null restores the install's own answer; nothing ships with it armed.
 *
 * ⚠ WHY THIS EXISTS RATHER THAN THE OBVIOUS ALTERNATIVE. The two outcomes a rig carrying every mapped
 * key CANNOT produce — nothing resolves, and only one key of a pair resolves — used to be driven by
 * replacing the engine's whole `Sequencer` global with a stub carrying just a database. That takes the
 * ENGINE AWAY FROM ANY EFFECT STILL RUNNING: a queued section reads `Sequencer.SectionManager` while it
 * starts and `Sequencer.EffectManager` while it plays, both out of that same global, so a shot queued
 * moments earlier throws mid-flight ("Cannot read properties of undefined") from inside the engine.
 * Isolated on the rig: a real sequence played and then the global swapped throws every time; the same
 * sequence with the global left alone is clean, and so is the whole shipped fan-out. This answers the
 * one question instead, so the engine keeps its own namespace and only the answer under test moves.
 */
let _dbProbe = null;
export function _setDbProbe(fn) {
  _dbProbe = typeof fn === "function" ? fn : null;
}

/** Does the Sequencer database resolve this key on THIS install? A key the installed asset tier
 *  lacks (free tier vs patreon tier) must be skipped, not played — that is the silent-degrade rule. */
export function fxDbEntryExists(key) {
  try {
    if (!key) return false;
    if (_dbProbe) return !!_dbProbe(key);
    const db = globalThis.Sequencer?.Database;
    if (!db) return false;
    if (typeof db.entryExists === "function") return !!db.entryExists(key);
    if (typeof db.getEntry === "function") return !!db.getEntry(key);
    return false;
  } catch (_e) {
    return false;
  }
}

/* ══════════════════════════ Sound resolution ══════════════════════════ */

// Basenames present in the sounds directory, or null when the directory could not be listed on this
// client (a plain player lacks FILES_BROWSE by default). Distinguishing the two cases matters:
//   listing succeeded + asset absent → stay SILENT (an attempt would 404 and log a console error)
//   listing unavailable              → trust the shipped asset (these files ship inside the module)
let _soundManifest = null;
let _soundManifestPrimed = false;

function _filePicker() {
  return foundry?.applications?.apps?.FilePicker?.implementation
    ?? foundry?.applications?.apps?.FilePicker
    ?? globalThis.FilePicker;
}

/**
 * List the module's sounds directory once. Browses the module ROOT first (a directory that always
 * exists) so a missing sounds directory is read from the listing rather than from a rejected browse —
 * and so a permission failure is distinguishable from an absent directory.
 */
export async function primeFxSounds() {
  const FP = _filePicker();
  try {
    const root = await FP.browse("data", `modules/${SCOPE}`);
    const hasDir = (root?.dirs ?? []).some((d) => String(d).replace(/\/$/, "").endsWith("/sounds"));
    if (!hasDir) {
      _soundManifest = new Set();          // browse works, directory not delivered → silent
    } else {
      const listing = await FP.browse("data", SOUND_DIR);
      _soundManifest = new Set((listing?.files ?? []).map((f) => decodeURIComponent(String(f)).split("/").pop()));
    }
  } catch (_e) {
    _soundManifest = null;                 // no browse permission → trust the shipped asset
  }
  _soundManifestPrimed = true;
  return _soundManifest;
}

/** Test seam: seed the sound listing without touching the server (used by the rig keeper). */
export function _setSoundManifest(names) {
  _soundManifest = names === null ? null : new Set(names);
  _soundManifestPrimed = true;
  return _soundManifest;
}

/** Has the listing pass run at all on this client? */
export function fxSoundsPrimed() {
  return _soundManifestPrimed;
}

/** The first delivered extension for a basename, or null when the listing says none is delivered. */
function _deliveredSrc(base) {
  if (!base) return null;
  if (_soundManifest) {
    for (const ext of SOUND_EXTENSIONS) {
      const name = `${base}.${ext}`;
      if (_soundManifest.has(name)) return `${SOUND_DIR}/${name}`;
    }
    return null;
  }
  return `${SOUND_DIR}/${base}.${SOUND_EXTENSIONS[0]}`;
}

/**
 * The playable source path for a weapon class, or null when nothing is playable for it.
 *
 * `burst` selects the class's ALTERNATE asset where it carries one (`soundBurst`). Why a class gets
 * two assets rather than one — the reason CHANGED once the cadence became per-class, and the old one
 * is recorded here because it is what the field was originally for:
 *
 * ORIGINALLY it was about OVERLAP. At the 80ms default spacing a report that stays audible for a third
 * of a second has five copies of itself running at once, and the pile-up is what a listener hears
 * instead of five shots — so the alternate asset was simply a shorter one. That job is done: measured
 * on the shipped clips, the shell class now spaces its rounds 180ms apart (classCadenceMs) and its
 * report is audible for 0.22s, so barely more than one copy is ever sounding. Nothing overlaps.
 *
 * WHAT IT IS FOR NOW is repetition. Ten rounds fired from one asset are ten copies of one identical
 * waveform, which phase into a single tone rather than reading as ten discharges; the ordinary fix is
 * a per-round playback-rate wobble, and the note on sfx() below records why this host cannot deliver
 * one to every client. A SECOND recording of the same weapon is the variation that is available: a
 * multi-round payload plays it, a single shot keeps the full-bodied one. So the alternate is chosen
 * for being a different report of the same character — NOT for being shorter, which it no longer needs
 * to be.
 *
 * The alternate is only used when the listing says it is actually delivered — a class whose burst asset
 * is missing falls back to its ordinary one rather than going silent.
 */
export function shotSoundSrc(cls, { burst = false } = {}) {
  const entry = FX_CLASSES[cls];
  if (!entry) return null;
  if (burst && entry.soundBurst) {
    const alt = _deliveredSrc(entry.soundBurst);
    if (alt) return alt;
  }
  return _deliveredSrc(entry.sound);
}

/**
 * Play one shot sound for every client. Native audio, no dependency: the interface channel is used
 * so each player's own interface-volume slider governs it, and the broadcast flag reaches the
 * clients the weaponFired hook never ran on. Returns the Sound (or null when nothing was played).
 *
 * PER-SHOT PITCH VARIATION IS NOT AVAILABLE HERE, and the finding is recorded rather than worked
 * around: varying the playback rate a few percent per round is the ordinary way to keep repeated
 * copies of one clip from phasing into a single tone, but nothing in this host's audio layer carries
 * a rate. Verified against the core sources on this install (Foundry 14, client/audio/): the word
 * `playbackRate` and the word `detune` do not occur anywhere in that directory; a Sound's playback
 * options are exactly {delay, duration, fade, loop, loopStart, loopEnd, offset, onended, volume}; and
 * the broadcast path is narrower still — the receiving client handles `playAudio` by calling
 * `game.audio.play(src, {volume, loop, context})`, so ANY extra field put on the emitted object is
 * discarded on arrival. The underlying buffer node does expose a rate (it is a Web Audio node, and
 * `Sound#sourceNode` is public), but poking it would vary the sound on the FIRING client only while
 * every other client heard the unvaried version — a worse result than no variation at all. Making it
 * uniform would take a bespoke socket channel of our own, which is not worth a de-phasing nicety.
 */
export function sfx(cls, { volume = SHOT_VOLUME, burst = false } = {}) {
  const src = shotSoundSrc(cls, { burst });
  if (!src) return null;
  try {
    return foundry.audio.AudioHelper.play({ src, volume, autoplay: true, loop: false, channel: "interface" }, true);
  } catch (err) {
    console.warn(`${SCOPE} | combat fx audio failed`, err);
    return null;
  }
}

/* ══════════════════ Native muzzle flash — a client-local transient light source ══════════════════ */

/**
 * WHY THIS IS NOT A DOCUMENT WRITE (the defect this shape exists to fix).
 *
 * The first build ran the envelope by UPDATING THE SHOOTER'S TOKEN DOCUMENT once per keyframe. Every
 * one of those is a server round trip that then broadcasts to every client, so the 85ms spec was
 * delivered in ~1.3s of wall clock — long enough that a viewer watched the light bloom outward and
 * fade, which is exactly what was reported. Nothing about the values was wrong; the TRANSPORT was.
 *
 * What replaces it: the flash is a light source this client builds, adds to the canvas lighting
 * collection, drives from the render ticker, and destroys. NO document is written at any point, so
 * there is no round trip, no broadcast of a token update, and nothing to restore if the client dies
 * mid-flash — a source that is never persisted cannot be left behind. Every other client draws its
 * own copy from one socket announcement (fxMuzzleFlash below), so latency moves only the instant the
 * flash STARTS, never its length.
 *
 * What it keeps: it is a REAL light source, so walls and line of sight clip it exactly as they clip
 * any other light (the source computes its own wall-constrained shape from its origin), and a lit
 * room washes it out for free.
 *
 * v13/v14: the source class, its constructor, its `initialize`/`add`/`destroy` lifecycle, the data
 * fields used below and the cone convention are IDENTICAL on both cores on this machine (read from
 * the two shipped bundles, not from memory). The class is resolved through the config entry core
 * itself uses, with the namespace path and the global as fallbacks.
 */

/** The light-source class this core exposes. Resolved the way core resolves it internally. */
export function pointLightSourceClass() {
  try {
    return CONFIG?.Canvas?.lightSourceClass
      ?? foundry?.canvas?.sources?.PointLightSource
      ?? globalThis.PointLightSource
      ?? null;
  } catch (_e) {
    return null;
  }
}

/** The per-render-frame driver this core exposes. */
function _ticker() {
  return canvas?.app?.ticker ?? globalThis.PIXI?.Ticker?.shared ?? null;
}

/**
 * The intensity of each frame of the envelope, in order. Pure; the keeper asserts it by value.
 *
 * Attack frames sit at `attackLevel`, hold frames at full, and the decay frames RAMP from full down
 * to `decayLevel` so the tail falls off instead of stepping to a plateau and switching off.
 */
export function muzzleFrameLevels() {
  const m = MUZZLE_LIGHT;
  const levels = [];
  for (let i = 0; i < m.attackFrames; i++) levels.push(m.attackLevel);
  for (let i = 0; i < m.holdFrames; i++) levels.push(1);
  for (let i = 1; i <= m.decayFrames; i++) {
    levels.push(Number((1 + (m.decayLevel - 1) * (i / m.decayFrames)).toFixed(3)));
  }
  return levels;
}

/** How many render frames one flash lasts. */
export function muzzleEnvelopeFrames() {
  return muzzleFrameLevels().length;
}

/** What that many frames comes to on a client rendering at the reference rate. Reporting only. */
export function muzzleEnvelopeDurationMs() {
  return muzzleEnvelopeFrames() * MUZZLE_LIGHT.nominalFrameMs;
}

/**
 * The light source(s) one flash is made of, at FULL intensity — one entry per source.
 *
 * Pure, so the three shapes are asserted by value rather than by eye. `aimRad` is the direction from
 * the shooter to what it is aiming at, in canvas radians (atan2 of the delta), or null when the shot
 * is pointed at nothing known.
 *
 * Radii come back in PIXELS: `gridDistance` is the scene's distance-per-square and `pixelsPerUnit`
 * its pixels-per-distance-unit, which is what a canvas source wants (a token light DOCUMENT is the
 * one that takes distance units).
 *
 * The wedge direction: core builds a limited-angle shape centred on `rotation + 90` degrees, so a
 * wedge pointed along `aimRad` carries `rotation = degrees(aimRad) - 90`. That is the same
 * conversion core applies to its own placeables.
 *
 * ⚠ THE MODE IS NO LONGER OVERRIDDEN BY A MISSING AIM. This function used to answer a null `aimRad`
 * with the circle whatever mode it was asked for, which is why a shot fired at nothing drew a plain
 * radius instead of the shape every other shot draws. The direction is resolved BEFORE this point
 * now (aimPointOf / facingRad, from the shooter's own facing), so the caller always has a heading to
 * hand over; a null here means only that a pure caller supplied none, and the wedge is then built at
 * the zero heading rather than silently becoming a different shape.
 *
 * ⚠ `angle` MAY EXCEED 180 and the shipped value does. Core supports it directly: a limited-angle
 * shape is built from `rotation + 90 ± angle/2` and its edge test inverts itself above 180 degrees
 * (LimitedAnglePolygon.pointBetweenRays), and nothing on the source path clamps the field. So 269
 * builds one wedge with a 91-degree notch behind the shooter, not two mirrored halves.
 */
export function muzzleSourceSpecs({ gridDistance = 1, pixelsPerUnit = 1, aimRad = null, mode = MUZZLE_MODE, darkness = null, ammoColor = null } = {}) {
  const m = MUZZLE_LIGHT;
  // THE COLOUR REGIME (FR#23), now with the LOADED ROUND's colour where its overlay names one (FR#24).
  // Resolved once here so every source this call returns agrees, and taken from the caller's reading
  // when it has one so the pure function stays drivable without a canvas. The ammo colour is passed
  // THROUGH the gate rather than around it — flashColorFor answers null below the darkness threshold
  // whatever the ammo asked for, so a tinted load cannot stain a lit floor.
  const color = flashColorFor(darkness === null ? viewedSceneDarkness() : darkness, ammoColor);
  const grid = Number(gridDistance) > 0 ? Number(gridDistance) : 1;
  const ppu = Number(pixelsPerUnit) > 0 ? Number(pixelsPerUnit) : 1;
  const px = (squares) => Number((squares * grid * ppu).toFixed(3));
  const bright = px(m.brightSquares);
  const dim = px(m.dimSquares);
  const shape = mode;
  const rotation = Number.isFinite(aimRad) ? Number(((aimRad * 180) / Math.PI - 90).toFixed(3)) : 0;

  const circle = (key, level) => ({
    key, angle: 360, rotation: 0,
    bright: key === "spill" ? 0 : bright,          // the companion glows, it does not light brightly
    dim,
    color,
    attenuation: m.attenuation,
    alpha: Number((m.alpha * level).toFixed(3)),
    luminosity: Number((m.luminosity * level).toFixed(3)),
  });
  const wedge = () => ({
    key: "cone", angle: m.coneDegrees, rotation,
    bright, dim,
    color,
    attenuation: m.attenuation,
    alpha: m.alpha,
    luminosity: m.luminosity,
  });

  if (shape === "omni") return [circle("omni", 1)];
  if (shape === "cone") return [wedge()];
  return [wedge(), circle("spill", m.spillLevel)];
}

// Flashes currently drawn on THIS client, keyed by token id. One entry per token is the whole
// concurrency story: a second shot from a token that is already flashing RESTARTS the running
// envelope in place (frame counter back to zero, aim re-pointed) rather than adding a second set of
// sources. At the automatic cadence — a shot every ~80ms against a ~5-frame envelope — that is what
// produces the continuous flicker the reference shows, and it bounds a burst of any length to one
// source set per shooter. Nothing here is persisted, so nothing here needs cleaning up on reload.
const _flashes = new Map();

/** Is a flash currently drawn for this token on this client? (Read by the keeper and diagnostics.) */
export function flashInFlight(token) {
  const id = typeof token === "string" ? token : (token?.document ?? token)?.id;
  return !!id && _flashes.has(id);
}

/** How many flashes this client is drawing right now. */
export function liveFlashCount() {
  return _flashes.size;
}

// Capture seam: replaces the per-frame level list so a screenshot pass can hold a flash open long
// enough for a slow software renderer to catch it. Null = the shipped envelope.
let _levelsOverride = null;

/** Test/capture seam: force the envelope's per-frame levels (null restores the shipped envelope). */
export function _setFlashLevels(levels) {
  _levelsOverride = Array.isArray(levels) && levels.length ? levels.slice() : null;
  return _levelsOverride;
}

/**
 * When the stalled-renderer deadline fires. The shipped envelope is a handful of frames, so the flat
 * cap is orders of magnitude clear of it. A deliberately lengthened envelope (the capture seam) is
 * given room proportional to the frames it asked for, or the cap meant to catch a stalled renderer
 * would instead cut short a capture that is working exactly as intended.
 */
function _deadlineMs(levels) {
  return _levelsOverride ? Math.max(MUZZLE_MAX_MS, levels.length * 200) : MUZZLE_MAX_MS;
}

function _endFlash(id) {
  const state = _flashes.get(id);
  if (!state) return;
  _flashes.delete(id);
  try { _ticker()?.remove(state.step); } catch (_e) { /* ticker already gone */ }
  clearTimeout(state.deadline);
  for (const source of state.sources) {
    try { source.destroy(); } catch (_e) { /* already detached */ }
  }
  try { canvas?.perception?.update?.({ refreshLighting: true }); } catch (_e) { /* canvas torn down */ }
}

/** Drop every flash this client is drawing (scene change, or the rail being switched off). */
export function clearFlashes() {
  for (const id of [..._flashes.keys()]) _endFlash(id);
}

/**
 * Draw one flash for a token ON THIS CLIENT. Returns true when a flash is now running for it.
 *
 * `tokenRef` may be an id (what the socket carries) or a token/placeable. `aim` is the canvas point
 * the shot is pointed at, or null. A token that is not drawn on this client's canvas gets nothing —
 * there is no lighting to affect — and a payload for a scene this client is not viewing is dropped.
 */
export function muzzleFlashLocal(tokenRef, aim = null, { sceneId = null, mode = MUZZLE_MODE, ammoColor = null } = {}) {
  const SourceClass = pointLightSourceClass();
  const ticker = _ticker();
  if (!SourceClass || !ticker || !canvas?.ready) return false;
  if (sceneId && canvas.scene?.id && sceneId !== canvas.scene.id) return false;

  const id = typeof tokenRef === "string" ? tokenRef : (tokenRef?.document ?? tokenRef)?.id;
  const placeable = id ? canvas.tokens?.get(id) : null;
  if (!placeable) return false;

  const origin = placeable.center ?? centerOf(placeable);
  if (!origin) return false;
  // The heading the wedge is built on. A point to point at where one was announced; otherwise the
  // token's OWN facing, which every drawn token carries — so this never falls back to a shape.
  const aimRad = (aim && Number.isFinite(aim.x) && Number.isFinite(aim.y))
    ? Math.atan2(aim.y - origin.y, aim.x - origin.x)
    : facingRad(placeable.document?.rotation);

  // Already flashing → restart the envelope in place and re-point it. One source set per token.
  // The SOURCES are not rebuilt here, so a restart keeps the colour the first round of the burst
  // built — which is right, because one payload is one load: every round of a burst carries the same
  // ammo. Two payloads with different loads fired inside one five-frame envelope would show the first
  // one's colour for the overlap; that is a handful of frames and it is left alone rather than paid
  // for with a source rebuild per round.
  const running = _flashes.get(id);
  if (running) {
    running.levels = _levelsOverride ?? muzzleFrameLevels();
    running.frame = 0;
    running.startedAt = performance.now();
    running.aimRad = aimRad;
    // The restarted envelope gets its own deadline, or a burst would be cut off by the FIRST round's.
    clearTimeout(running.deadline);
    running.deadline = setTimeout(() => _endFlash(id), _deadlineMs(running.levels));
    return true;
  }

  const dims = canvas.dimensions ?? {};
  const ppu = Number(dims.distancePixels) || ((Number(dims.size) || 100) / (Number(dims.distance) || 1));
  const specs = muzzleSourceSpecs({
    gridDistance: Number(canvas.scene?.grid?.distance) || 1,
    pixelsPerUnit: ppu, aimRad, mode, ammoColor,
  });
  const elevation = Number(placeable.document?.elevation) || 0;

  const sources = [];
  try {
    for (const spec of specs) {
      const source = new SourceClass({ sourceId: `${SCOPE}.flash.${id}.${spec.key}` });
      source.initialize({
        x: origin.x, y: origin.y, elevation,
        dim: spec.dim, bright: spec.bright,
        // A null colour is what takes the coloration layer out of the render — see MUZZLE_LIGHT.
        color: spec.color,
        attenuation: spec.attenuation,
        alpha: spec.alpha, luminosity: spec.luminosity,
        angle: spec.angle, rotation: spec.rotation,
        walls: true,          // the flash is clipped by walls and line of sight like any other light
        vision: false,        // it lights the scene; it does not grant anyone sight
        disabled: false,
      });
      source.add();
      sources.push(source);
    }
  } catch (err) {
    for (const s of sources) { try { s.destroy(); } catch (_e) { /* not attached */ } }
    console.warn(`${SCOPE} | muzzle flash source failed`, err);
    return false;
  }

  const state = {
    sources, specs, aimRad,
    levels: _levelsOverride ?? muzzleFrameLevels(),
    frame: 0,
    startedAt: performance.now(),
    step: null,
    deadline: null,
  };

  // One tick = one rendered frame. The envelope advances by frames because that is the unit the
  // reference is specified in and the only one a renderer can actually honour; the wall-clock cap is
  // a backstop for a client that stops rendering entirely (a backgrounded tab) rather than a timer.
  state.step = () => {
    const live = _flashes.get(id);
    if (live !== state) return;
    if (performance.now() - state.startedAt > _deadlineMs(state.levels)) { _endFlash(id); return; }
    const level = state.levels[state.frame++];
    if (level === undefined) { _endFlash(id); return; }
    try {
      for (let i = 0; i < state.sources.length; i++) {
        const spec = state.specs[i];
        // A partial initialize MERGES — core only writes the keys it is handed — so the radii, the
        // wedge, the colour and the attenuation all survive every frame of the envelope untouched.
        // LUMINOSITY is what the viewer sees move while the flash is illumination-only: core derives
        // its exposure from it (`luminosity * 2 − 1`), so the held frames sit at neutral exposure and
        // the ramp and decay frames darken from there. `alpha` is driven alongside it so the envelope
        // still works unchanged for a table that puts a colour back in the spec.
        state.sources[i].initialize({
          alpha: Number((spec.alpha * level).toFixed(4)),
          luminosity: Number((spec.luminosity * level).toFixed(4)),
        });
      }
      canvas.perception.update({ refreshLighting: true });
    } catch (err) {
      console.warn(`${SCOPE} | muzzle flash frame failed`, err);
      _endFlash(id);
    }
  };

  _flashes.set(id, state);
  ticker.add(state.step);
  state.deadline = setTimeout(() => _endFlash(id), _deadlineMs(state.levels));
  // The sources are already at full spec values, so the first drawn frame is a lit flash rather than
  // a dark one waiting for the ticker; the driver takes over from the frame after.
  try { canvas.perception.update({ refreshLighting: true }); } catch (_e) { /* canvas torn down */ }
  return true;
}

/**
 * Announce one flash to every client and draw it here.
 *
 * Fire-and-forget and synchronous: the emit is one datagram and the local draw is object
 * construction, so this returns inside the same tick as the shot's audio. There is no permission
 * question to answer — nothing is written — so a player firing a GM-owned token, or a GM firing
 * anyone's, all take the identical path.
 */
export function fxMuzzleFlash(shooterToken, aimPoint = null, { mode = MUZZLE_MODE, ammoColor = null } = {}) {
  const doc = shooterToken?.document ?? shooterToken;
  const tokenId = typeof shooterToken === "string" ? shooterToken : doc?.id;
  if (!tokenId) return false;
  const sceneId = doc?.parent?.id ?? canvas?.scene?.id ?? null;
  const aim = (aimPoint && Number.isFinite(aimPoint.x) && Number.isFinite(aimPoint.y))
    ? { x: Math.round(aimPoint.x), y: Math.round(aimPoint.y) }
    : null;
  try {
    // The ammo colour rides the datagram (FR#24) so every client's own flash agrees with the firing
    // one's. It is a COLOUR and not an ammo id deliberately: the receiving client then needs no
    // registry lookup and no agreement about tables, and a client that cannot resolve the id anyway
    // (an older module version) simply receives a field it ignores.
    game.socket?.emit?.(`module.${SCOPE}`, { type: MSG_FLASH, sceneId, tokenId, aim, ammoColor: ammoColor ?? null });
  } catch (err) {
    console.warn(`${SCOPE} | muzzle flash announce failed`, err);
  }
  return muzzleFlashLocal(tokenId, aim, { sceneId, mode, ammoColor });
}

/* ══════════════════════════ Sequencer verbs (optional-only) ══════════════════════════ */

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Canvas centre of a placeable or a token document. */
export function centerOf(token) {
  if (!token) return null;
  if (token.center) return { x: token.center.x, y: token.center.y };
  const doc = token.document ?? token;
  const size = Number(doc?.parent?.grid?.size) || 100;
  const w = (Number(doc?.width) || 1) * size;
  const h = (Number(doc?.height) || 1) * size;
  return { x: (Number(doc?.x) || 0) + w / 2, y: (Number(doc?.y) || 0) + h / 2 };
}

/**
 * Where a MISSED shot's tracer lands: a divergent angle, landing short of or wide past the target
 * (design doc §2.4). `rng` is injectable so the endpoint can be value-asserted deterministically.
 */
export function missEndpoint(from, to, rng = Math.random) {
  if (!from || !to) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const angle = Math.atan2(dy, dx) + MISS_SPREAD_RAD * (rng() * 2 - 1);
  const reach = dist * (MISS_REACH_MIN + rng() * (MISS_REACH_MAX - MISS_REACH_MIN));
  return { x: from.x + Math.cos(angle) * reach, y: from.y + Math.sin(angle) * reach };
}

/**
 * Where each tracer of a FANNED round ends — one endpoint per pellet, for a class carrying `pellets`.
 *
 * A HIT fans by ANGLE about the aim line and keeps the aim distance, so the tracers converge on the
 * aimed-at token: the offsets are spread EVENLY across the full cone (a 4-pellet fan lands at −1, −⅓,
 * +⅓, +1 of `spreadRad`), which both reads as a cone rather than a random scatter and lets the values
 * be asserted directly. An even count leaves no pellet exactly on the aim line, which is what keeps the
 * fan from reading as "one bolt plus some strays".
 *
 * A MISS does not fan neatly — it reuses missEndpoint per pellet, so each tracer takes its own wide
 * divergence AND its own reach and the group splays wide at mixed depths. That is the whole reason the
 * miss machinery is called per pellet instead of being applied once to the group.
 *
 * Pure, and `rng` is injectable, so both branches are value-asserted rather than eyeballed.
 * Returns [] when there is nothing to fan (no aim, or a class carrying no pellet count).
 */
export function pelletEndpoints(from, to, { pellets = 0, spreadRad = 0, hit = true, rng = Math.random, jitter = null } = {}) {
  const n = Math.trunc(pellets);
  if (!from || !to || !(n > 1)) return [];
  if (!hit) return Array.from({ length: n }, () => missEndpoint(from, to, rng));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const aim = Math.atan2(dy, dx);
  return Array.from({ length: n }, (_v, i) => {
    const offset = spreadRad * ((2 * i) / (n - 1) - 1);   // −1 … +1 of the cone, evenly spaced
    // ⭐ THE PER-PELLET IRREGULARITY (2026-08-11), and it is OPTIONAL so the even ladder above stays
    // the readable default: `jitter[i]` adds this pellet's own angle nudge and pushes its endpoint
    // nearer or further along its own line, which is what turns a neat arc into a grouped cluster at
    // mixed depths. See PELLET_CHAOS for the ruling and the values; with no jitter passed every
    // number below is the one this function has always returned.
    const j = jitter?.[i] ?? null;
    // ⛔ CLAMPED TO THE DECLARED CONE. The nudge is symmetric, so an OUTERMOST pellet would otherwise be
    // pushed past the half-angle its class declares — and measured on the rig that is what took a hit
    // off the body it was aimed at. The clamp is what makes "the group stays inside the cone" a
    // guarantee rather than an intention; inner pellets never reach it.
    const nudged = Math.max(-spreadRad, Math.min(spreadRad, offset + (Number(j?.angleRad) || 0)));
    const angle = aim + nudged;
    const reach = dist * (Number(j?.reachScale) > 0 ? Number(j.reachScale) : 1);
    return { x: from.x + Math.cos(angle) * reach, y: from.y + Math.sin(angle) * reach };
  });
}

/**
 * THE BUCKSHOT FAN'S IRREGULARITY — one jitter record per pellet, from the shot's own seed. Pure.
 *
 * ⏪⏪ THE FAN IS BACK, AND THE VOLLEY IS OFF (user ruling 2026-08-11, at the bench). The trial asset's
 * *"visible bullets and trails are a problem"*: buckshot is small balls thrown in an irregular grouped
 * spread, and the volley drew them SIDE BY SIDE in aligned lanes with long trails, which is a rank of
 * rifle rounds and not a shot pattern. The ruling was *"choose a new asset for buckshot or go back to
 * what we had"*, so the six-dash fan is restored — with the four things the volley was reaching for
 * built into the fan itself rather than baked into one clip:
 *
 *  - `slotFraction` — each pellet's angle is nudged by up to this fraction of HALF ITS OWN SLOT in the
 *    even ladder. The slots stop being a ladder — at 0.9 a pellet can reach almost to its neighbour's
 *    place — while the group stays strictly INSIDE the cone the class declares, because the outermost
 *    slots can only ever move inward by less than half a step.
 *  - `reachFraction` — each pellet is sent nearer or further along its own line, by this fraction of
 *    the cone's OWN LATERAL half-spread at that distance. This is the DEPTH half of "irregular grouped
 *    spread": pellets that all stop on one arc read as a painted crescent, and pellets at mixed depths
 *    read as a cluster with a near and a far side.
 *  - `sizeFraction` — each pellet's drawn width varies by this fraction, so no two balls in one shot
 *    are the same ball.
 *  - `staggerMs` — each pellet leaves up to this many milliseconds late. A shot whose pellets all
 *    start on the same frame is one object moving; a few milliseconds apart they are many.
 *
 * ⛔⛔ BOTH GEOMETRY KNOBS ARE SCALED BY THE CLASS'S OWN CONE, AND THAT IS LOAD-BEARING, not tidiness.
 * The first build scaled them by the whole cone and by the whole shot: the angle jitter then pushed
 * the outer pellets to 1.45× the declared spread and the depth jitter moved the arrival by a fifth of
 * the shot's length, and a HIT stopped landing on the body it was aimed at (measured on the rig: 113px
 * from the target's centre against a 50px half-width). Converging on the target is what makes a hit a
 * hit — it is the property the whole `hit`/`miss` split is built on — so the irregularity has to live
 * inside the cone rather than on top of it. Scaled this way the worst case a six-pellet fan can
 * produce is the cone's own edge plus half its lateral spread in depth, which is inside a one-square
 * token at every range a battle map spans.
 *
 * ⛔ SEEDED, AND THE SEED CARRIES PER-EVENT ENTROPY. The record is computed from the SHOT seed the
 * fan-out already builds — attacker, weapon, counts, ROUND INDEX and the rolled `areaDamages` — so two
 * clients draw the identical cluster while two consecutive identical trigger pulls do not (the F3 rule
 * at fxSeedOf's callers, and the same term in the same position as the burning-ground seed). This is
 * the finding the volley failed: its seed folded identity fields only and repeated itself.
 */
export const PELLET_CHAOS = Object.freeze({
  slotFraction: 0.9,
  reachFraction: 0.35,
  sizeFraction: 0.25,
  staggerMs: 45,
});

/**
 * One jitter record per pellet, from a seed — the RAW rolls, in units of ±1. Pure, so determinism is
 * proved by computing it twice, and the rolls are assertable without a cone to multiply them by.
 */
export function pelletChaosFor(seed, count) {
  const n = Math.max(0, Math.trunc(count));
  const rng = seededRng(seed);
  return Array.from({ length: n }, () => ({
    // Each draw is taken in a fixed order so the record is a function of the seed and the index alone.
    angle: Number((rng() * 2 - 1).toFixed(4)),
    reach: Number((rng() * 2 - 1).toFixed(4)),
    sizeScale: Number((1 + (rng() * 2 - 1) * PELLET_CHAOS.sizeFraction).toFixed(4)),
    delayMs: Math.round(rng() * PELLET_CHAOS.staggerMs),
  }));
}

/**
 * The same records RESOLVED against the class's own cone — the form pelletEndpoints reads. Pure, and
 * kept apart from the roll above so the two questions stay separate: what did the seed produce, and
 * how far may it move a pellet of THIS class.
 *
 * The angle is scaled by half of one slot in the even ladder (`1 / (n − 1)` of the cone, halved), so
 * the jitter is always a fraction of the gap between neighbours; the reach is scaled by the cone's own
 * lateral half-spread. See the bound note at PELLET_CHAOS for why neither is scaled by anything bigger.
 */
export function pelletJitterFor(seed, count, spreadRad = 0) {
  const n = Math.max(0, Math.trunc(count));
  const cone = Number(spreadRad) || 0;
  const slotHalf = n > 1 ? cone / (n - 1) : 0;
  return pelletChaosFor(seed, n).map((c) => ({
    ...c,
    angleRad: Number((c.angle * PELLET_CHAOS.slotFraction * slotHalf).toFixed(6)),
    reachScale: Number((1 + c.reach * PELLET_CHAOS.reachFraction * cone).toFixed(6)),
  }));
}

/**
 * A REPEATABLE random source, and the reason this rail has one at all.
 *
 * Every other scatter on this file (the miss splay, the mote spray, the smoke) is drawn once, on one
 * client, and is gone inside a second — so `Math.random` is the right source for it and the injectable
 * `rng` those helpers take exists only so a test can assert them. The burning ground is different in
 * two ways that both argue for a seed:
 *
 *  1. IT IS PLACED FROM DATA THAT TWO DIFFERENT CLIENTS MAY HOLD. Sequencer broadcasts the resolved
 *     sequence rather than the code that built it, so today one client rolls and everyone draws the
 *     same picture — but a scatter that is only correct because of where it happened to be computed is
 *     one refactor away from two clients disagreeing about where a fire is burning for the next 45
 *     seconds. Seeding it off the payload makes the agreement a property of the inputs instead.
 *  2. IT IS ASSERTABLE BY VALUE. A seeded plan can be computed twice in a test and compared, which is
 *     the only way to pin a scatter without pinning the pictures.
 *
 * The generator is mulberry32 — 32 bits of state, one multiply-xor round, uniform enough for placing
 * four flames and short enough to read. `fxSeedOf` folds any list of payload fields into that state
 * with an FNV-1a-shaped walk; it is a SPREADER, not a hash with any security property, and nothing
 * here depends on it having one.
 */
export function fxSeedOf(...parts) {
  let h = 2166136261 >>> 0;
  const s = parts.map((p) => String(p ?? "")).join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function seededRng(seed = 0) {
  let a = (Number(seed) >>> 0) || 1;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * WHERE A PAYLOAD'S ROUNDS LANDED, as a list of points to set alight. Pure, seeded, bounded.
 *
 * ⭐ NEITHER BRANCH INVENTS A POSITION IT COULD HAVE ASKED FOR. That is the whole design:
 *
 *  - A class that draws its round as a FAN has real per-pellet endpoints, computed by the same
 *    `pelletEndpoints` the tracer uses with the same arguments — so the flames are literally where the
 *    pellets went. They are picked EVENLY ACROSS the fan rather than taken from one end (`step`
 *    below), so three flames off six pellets span the cone instead of clustering on one side of it.
 *  - A class that draws ONE bolt puts every round of the burst on the same aim point, because the
 *    payload says how many rounds landed and never where — the same limit that makes the fan-out
 *    assign hits to the leading rounds. So the rounds are SCATTERED around the aim inside a disc of
 *    `scatterPx`, which is an admission that the exact square is not known rather than a claim that it
 *    is. sqrt on the radius keeps the disc evenly covered instead of crowding the centre.
 *
 * `max` is the payload bound and it is applied to both branches. `landed` is the number of rounds that
 * actually hit; a payload that landed nothing does not reach here (the call site gates on it).
 */
export function groundFirePoints(from, to, {
  landed = 1, pellets = 0, spreadRad = 0, scatterPx = 0, max = GROUND_FIRE.maxPerPayload, seed = 0,
  jitter = null,
} = {}) {
  if (!from || !to) return [];
  const want = Math.max(1, Math.min(Math.trunc(max), Math.trunc(landed) || 1));
  const n = Math.trunc(pellets);
  if (n > 1) {
    // ⭐ THE SAME JITTER THE TRACERS TOOK (2026-08-11), passed in rather than rolled here. Once the fan
    // became irregular (PELLET_CHAOS) this call had to take the irregularity with it or the claim above
    // would stop being true: the flames would sit on the even ladder while the pellets that lit them
    // flew a square either side. The caller hands over the FIRST round's own jitter, because the fires
    // are one placement for the whole payload and that is the round whose landing they depict.
    const fan = pelletEndpoints(from, to, { pellets: n, spreadRad, hit: true, jitter });
    if (!fan.length) return [];
    const take = Math.min(want, fan.length);
    const step = fan.length / take;
    return Array.from({ length: take }, (_v, i) => fan[Math.min(fan.length - 1, Math.round(i * step + step / 2 - 0.5))]);
  }
  const rng = seededRng(seed);
  const reach = Number(scatterPx) > 0 ? Number(scatterPx) : 0;
  return Array.from({ length: want }, () => {
    const angle = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * reach;
    return { x: to.x + Math.cos(angle) * r, y: to.y + Math.sin(angle) * r };
  });
}

/**
 * WHERE A SHOT PATTERN'S FIRES BURN — points scattered inside the p.108 pattern a shell throws. Pure,
 * seeded, bounded.
 *
 * ⭐ BUILT IN THE RAY'S OWN COORDINATES (distance along, offset across) and then rotated out, which is
 * what makes every point INSIDE the pattern by construction rather than by a containment test that
 * could be off by a pixel. `pointInPolygon` (combat/area-geometry.js) is the module's containment test
 * and the keeper uses it to check this against the REAL polygon the pattern was drawn with — the
 * construction and the check are deliberately two different pieces of arithmetic.
 *
 * The first `nearFraction` of the ray is left empty on purpose: that end of the pattern is the muzzle,
 * and a fire burning on the shooter's own square says something that did not happen. `lateral` is
 * capped inside the half-width so a flame's own sprite does not hang out of the edge the viewer just
 * watched being drawn.
 */
export function patternFirePoints({
  x = 0, y = 0, dirDeg = 0, lengthPx = 0, widthPx = 0,
  count = GROUND_FIRE.maxPerPattern, nearFraction = 0.3, seed = 0,
} = {}) {
  const n = Math.max(0, Math.min(Math.trunc(count), GROUND_FIRE.maxPerPattern));
  if (!(n > 0) || !(lengthPx > 0)) return [];
  const rad = (Number(dirDeg) || 0) * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const near = Math.min(0.9, Math.max(0, Number(nearFraction) || 0));
  const half = Math.max(0, (Number(widthPx) || 0) / 2) * 0.9;
  const rng = seededRng(seed);
  return Array.from({ length: n }, () => {
    const along = lengthPx * (near + rng() * (1 - near));
    const across = (rng() * 2 - 1) * half;
    return { x: x + cos * along - sin * across, y: y + sin * along + cos * across };
  });
}

/**
 * The point a shot LEAVES from: `offsetPx` along the line from the shooter's centre toward what it is
 * aiming at. Pure.
 *
 * WHY THIS EXISTS: every sprite used to be planted on the shooter's CENTRE, which draws the flash out
 * of the middle of the token. The reference puts it at the forward EDGE. Given no point to walk
 * toward it returns the centre unchanged; its callers resolve one first (aimPointOf), so in the
 * shipped paths there is always a line.
 */
/** The point `distPx` along the from->to axis, starting at `from`. Pure; null when there is no axis. */
export function pointAlong(from, to, distPx = 0) {
  if (!from || !to) return null;
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!len) return { x: from.x, y: from.y };
  return { x: Number((from.x + (dx / len) * distPx).toFixed(3)),
           y: Number((from.y + (dy / len) * distPx).toFixed(3)) };
}

export function muzzlePoint(from, to, offsetPx = 0) {
  if (!from) return null;
  if (!to || !(offsetPx > 0)) return { x: from.x, y: from.y };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (!dist) return { x: from.x, y: from.y };
  return { x: from.x + (dx / dist) * offsetPx, y: from.y + (dy / dist) * offsetPx };
}

/**
 * The canvas heading a token's own facing points along, in radians. Pure.
 *
 * The conversion is core's, not ours: core builds a limited-angle shape centred on `rotation + 90`
 * degrees and hands a token's light source the token document's `rotation` unchanged, so a token at
 * rotation 0 faces 90° in canvas terms — down the +y axis, which is screen-south. Reading it back
 * the same way is what keeps a synthesized heading agreeing with the wedge the same rotation would
 * produce if the token carried a real light.
 */
export function facingRad(rotationDeg) {
  const deg = Number(rotationDeg);
  return (((Number.isFinite(deg) ? deg : 0) + 90) * Math.PI) / 180;
}

/**
 * The token ROTATION that points a token at a canvas point — the inverse of facingRad, in the
 * degrees a token document stores. Pure. Returns null when there is no line to face along.
 */
export function faceTargetRotation(from, to) {
  if (!from || !to) return null;
  const dx = to.x - from.x, dy = to.y - from.y;
  if (!Math.hypot(dx, dy)) return null;
  return ((Math.atan2(dy, dx) * 180) / Math.PI - 90 + 360) % 360;
}

/** The SHORTEST signed turn from one heading to another, in degrees (−180…180]. Pure. */
export function rotationDeltaDeg(fromDeg, toDeg) {
  const a = Number(fromDeg) || 0, b = Number(toDeg) || 0;
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/** A point `distancePx` along a facing from an origin. Pure, so the axis is asserted by value. */
export function facingAimPoint(origin, rotationDeg, distancePx) {
  if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return null;
  const reach = Number(distancePx) > 0 ? Number(distancePx) : 0;
  const rad = facingRad(rotationDeg);
  return { x: origin.x + Math.cos(rad) * reach, y: origin.y + Math.sin(rad) * reach };
}

/**
 * THE ONE ANSWER TO "WHICH WAY IS THIS SHOT POINTED" — the aimed-at token's centre where there is
 * one, else a point synthesized FACING_AIM_SQUARES squares along the shooter's own facing.
 *
 * WHY IT IS ONE POINT AND NOT A PER-EFFECT FALLBACK: the light wedge, the muzzle sprite and its edge
 * offset, the spark, the tracer or pellet fan and the burst ambience all take their direction from
 * this one value, so a shot fired at nothing is drawn along a SINGLE axis and looks like a shot
 * fired at something. The previous build answered the question separately in each place and answered
 * it "unknown" — the light became a plain radius, the sprites were suppressed, and the ambience was
 * skipped — which is the reported difference between the two cases.
 *
 * ⚠ THE HONEST LIMIT ON THE SYNTHESIZED AXIS: it is only as good as the token's rotation, and these
 * are top-down portraits that a table may never turn, so an untargeted shot from a token left at
 * rotation 0 is drawn toward screen-south. That is a real constraint and it is the reason the axis
 * is taken from the token rather than invented: rotation is the only heading a token actually
 * carries, it is visible to whoever set it, and turning the token corrects the effect. The LIGHT is
 * nearly indifferent to it either way — at 269° the wedge is wrong only in where the 91° notch sits.
 */
export function aimPointOf(shooterToken, targetToken, gridSizePx = 100) {
  const aimed = centerOf(targetToken);
  if (aimed && Number.isFinite(aimed.x) && Number.isFinite(aimed.y)) return aimed;
  const from = centerOf(shooterToken);
  if (!from) return null;
  const doc = shooterToken?.document ?? shooterToken;
  const px = (Number(gridSizePx) > 0 ? Number(gridSizePx) : 100) * FACING_AIM_SQUARES;
  return facingAimPoint(from, doc?.rotation, px);
}

/**
 * THE POINT A SPREAD SHOT WAS AIMED AT BEFORE THE TRIGGER WAS PULLED, or null when no corridor was
 * declared. The shooter drags the pattern, confirms it, and only then declares the shot
 * (combat/spread-placement.js), so for those shots the aim is a stated fact rather than an inference
 * from whoever happened to be targeted.
 *
 * ⭐ REBUILT FROM THE ANGLE AND THE REACH, NOT READ AS A STORED POINT — one rotation basis, the rule
 * this file follows everywhere. The corridor is described relative to the shooter, so the point is
 * derived from the figure AS IT STANDS: a token nudged between the aim and the roll still fires along
 * the line the shooter drew, out of the barrel it is actually holding, rather than out of a stale pair
 * of world coordinates. The plant does the same with the same numbers.
 *
 * Null on every ordinary shot, which is what makes every caller a plain fall-through.
 */
export function declaredAimPointOf(payload, shooterToken) {
  const a = payload?.spreadAim;
  if (!a) return null;
  const angleDeg = Number(a.angleDeg), reachM = Number(a.reachM);
  if (!Number.isFinite(angleDeg) || !(reachM > 0)) return null;
  const from = centerOf(shooterToken);
  if (!from) return null;
  const reachPx = metersToPixels(canvas?.scene, reachM);
  if (!(reachPx > 0)) return null;
  const rad = (angleDeg * Math.PI) / 180;
  return { x: from.x + Math.cos(rad) * reachPx, y: from.y + Math.sin(rad) * reachPx };
}

/**
 * WHERE THIS PAYLOAD IS POINTED — the one question every element of a shot takes its axis from, asked
 * with the payload in hand. A declared corridor answers it; everything else falls through to the
 * aimed-at token, and then to the shooter's own facing (`aimPointOf`).
 */
export function payloadAimPoint(payload, shooterToken, targetToken, gridSizePx = 100) {
  return declaredAimPointOf(payload, shooterToken) ?? aimPointOf(shooterToken, targetToken, gridSizePx);
}

/** How far a token's edge is from its own centre, in pixels — a token's own width, not a constant. */
export function tokenRadiusPx(token, gridSizePx = 100) {
  const doc = token?.document ?? token;
  const squares = Number(doc?.width) > 0 ? Number(doc.width) : 1;
  return (squares * (Number(gridSizePx) > 0 ? Number(gridSizePx) : 100)) / 2;
}

/**
 * Where each MOTE of one burst's spray ends — one endpoint per speck. Pure, `rng` injectable, so the
 * scatter is asserted by value rather than eyeballed.
 *
 * Each speck takes its OWN angle within the cone and its OWN distance within the band, which is the
 * difference between a scatter and a rank: spacing the angles evenly (the way the pellet fan does,
 * deliberately) would draw a neat arc, and a muzzle does not throw a neat arc. The pellet fan wants to
 * read as an aimed cone converging on a target; this wants to read as debris.
 *
 * Returns [] when there is nothing to spray — no aim, or a class carrying no mote count.
 */
export function moteEndpoints(from, to, { count = 0, spreadRad = 0, nearPx = 0, farPx = 0, rng = Math.random } = {}) {
  const n = Math.trunc(count);
  if (!from || !to || !(n > 0)) return [];
  const aim = Math.atan2(to.y - from.y, to.x - from.x);
  const span = Math.max(0, farPx - nearPx);
  return Array.from({ length: n }, () => {
    const angle = aim + spreadRad * (rng() * 2 - 1);
    const reach = nearPx + rng() * span;
    return { x: from.x + Math.cos(angle) * reach, y: from.y + Math.sin(angle) * reach };
  });
}

/**
 * ⏪⏪ RETIRED (FR#22, user ruling) — the stride derivation, the concurrency band and every other part of
 * the BURST puff machinery are gone. The chain, so the next reader does not rebuild it:
 *
 *   FR#17 BUILT it — a stream of phase-offset puffs emitted across a burst, because the reference video
 *     showed a billow rolling through automatic fire and we had no smoke of our own.
 *   FR#18/#20 TUNED it — stride overrides for the fast automatics, sizes, opacity, drift, and finally a
 *     per-row opt-in so the shell's single discharge smoked at all.
 *   FR#22 RETIRES it for bursts — because the premise was wrong. Decoding the bullet assets frame by
 *     frame showed `jb2a.bullet.02` (rifle/heavy) carries its OWN gray smoke curls, which linger at the
 *     muzzle for most of its clip, plus a spiky bloom at the origin and a spiky impact star. The
 *     reference's billow was never a smoke system at all — it was those built-in phases OVERLAPPING one
 *     per shot. So our puffs were a second smoke drawn on top of a smoke that was already there, which
 *     is exactly what the user kept reporting: "spammy no matter how we do it."
 *
 * WHAT THIS COSTS, stated plainly rather than discovered later: pistol and SMG map `bullet.01`, which
 * carries NO built-in smoke, so their automatic fire is now smokeless. That matches the reference (it
 * used bullet.01 for every gun and had zero smoke). If the user later wants SMG autos to smoke, it is a
 * ONE-FIELD change — swap that row's `tracer` to `jb2a.bullet.02.orange` — not a rebuild of this.
 *
 * WHAT SURVIVES: the shell's SINGLE-discharge puff (`smokeSingle`), kept by explicit user ruling, and
 * everything it needs — MUZZLE_SMOKE's per-instance spec, smokePuffPlan's randomisation, fxSmokePuff.
 * One puff, one discharge; there is no stream left to pace, so there is no stride to derive.
 */

/** How many puffs a payload emits, and when. Only a `smokeSingle` class firing ONE round draws one; a
 *  burst draws none from us at all (see the retirement note above). Pure. */

/**
 * How long this class's muzzle lance stays on screen, in wall-clock milliseconds. A row that names no
 * `muzzleMs` dwells for the trim itself. Pure — see the MUZZLE_DWELL_DEFAULT_MS block for why dwell and
 * trim are two numbers.
 */
export function muzzleDwellMs(weaponClass) {
  const own = Number(FX_CLASSES[weaponClass]?.muzzleMs);
  return Number.isFinite(own) && own > 0 ? own : MUZZLE_DWELL_DEFAULT_MS;
}

/**
 * The playback rate that makes the trimmed lance last its class's dwell. Exactly 1 for every row that
 * names no dwell, so "unchanged" is a value the keeper can assert rather than a claim. Pure.
 */
export function muzzleRateFor(weaponClass) {
  return Number((MUZZLE_SPRITE.endMs / muzzleDwellMs(weaponClass)).toFixed(4));
}

/**
 * Does this class smoke on a SINGLE discharge as well as on a burst — i.e. does its row opt out of the
 * multi-round gate for the smoke? Pure, and read by BOTH the arithmetic below and the fan-out's own
 * gate, so what the plan predicts and what the loop emits cannot drift apart. See the shell row's note
 * for why exactly one class carries it.
 */
export function smokesOnSingleShot(weaponClass) {
  return FX_CLASSES[weaponClass]?.smokeSingle === true;
}

/** How many puffs a payload of `shots` rounds emits at that stride, and how many overlap. Pure. */
export function smokePlanFor(weaponClass, shots) {
  const n = Math.min(Math.max(Math.trunc(Number(shots) || 0), 0), MAX_FX_SHOTS);
  const emissions = (n === 1 && smokesOnSingleShot(weaponClass)) ? 1 : 0;
  return { emissions, cadenceMs: classCadenceMs(weaponClass) };
}

/**
 * The randomised parameters for ONE puff. Pure, and `rng` is injectable, so "these instances differ"
 * is asserted by value rather than by looking at the canvas.
 *
 * Every roll here is ours. See the trap in the MUZZLE_SMOKE block: Sequencer's own randomisers fire
 * once per section, so anything asked of THEM would come back identical on every instance.
 */
export function smokePuffPlan(index, { files = [], sizeSquares = 0.5, gridPx = 100, from = null, to = null, origin = null, rng = Math.random } = {}) {
  const variant = files.length ? files[index % files.length] : MUZZLE_SMOKE.key;
  const spread = MUZZLE_SMOKE.scaleMax - MUZZLE_SMOKE.scaleMin;
  const rateSpread = MUZZLE_SMOKE.rateMax - MUZZLE_SMOKE.rateMin;
  const plan = {
    file: variant,
    mirrorY: rng() < 0.5,
    rotationDeg: Number(((rng() * 2 - 1) * MUZZLE_SMOKE.rotationDeg).toFixed(2)),
    sizeSquares: Number((sizeSquares * (MUZZLE_SMOKE.scaleMin + rng() * spread)).toFixed(4)),
    playbackRate: Number((MUZZLE_SMOKE.rateMin + rng() * rateSpread).toFixed(3)),
    startTimeMs: Math.round(rng() * MUZZLE_SMOKE.startPhaseMax * MUZZLE_SMOKE.clipMs),
    aimDeg: 0,
    offset: { x: Number(((rng() * 2 - 1) * MUZZLE_SMOKE.jitterSquares * gridPx).toFixed(2)),
              y: Number(((rng() * 2 - 1) * MUZZLE_SMOKE.jitterSquares * gridPx).toFixed(2)) },
    driftTo: null,
  };
  // THE DRIFT — a slow roll that stays with the shooter, reported as "launching out of the gun like a
  // projectile" before this was reworked.
  //
  // ⚠ THE DISTANCE WAS NEVER THE FAULT: the old reach was 0.27–0.63 squares, already inside the "a
  // tile or two" the ruling asks for. What read as a launch was the DIRECTION — every puff slid along
  // exactly the same bullet axis, so the group streamed down-range as one jet. The fix is a LATERAL
  // component per instance (signed, so puffs go to both sides) on top of a smaller along-aim one: the
  // mass now billows around the muzzle instead of queueing down the firing line.
  //
  // Displacement is then CAPPED against the SHOOTER, not the muzzle, so the ruling's bound is the one
  // actually enforced — the muzzle point is itself half a token out along the aim, and a cap measured
  // from there would quietly allow more.
  //
  // SPEED: no duration or speed is set, so the engine moves the puff over the clip's own remaining
  // life — roughly a square across a second, against a tracer's 4000px/s. The easing is left
  // ease-out so most of the travel is early and it settles, which is the "roll" rather than a slide.
  if (from && to) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ax = dx / len, ay = dy / len;                 // along the aim
    const px = -ay, py = ax;                            // across it
    const along = MUZZLE_SMOKE.driftAlongSquares * gridPx * (0.5 + rng() * 0.7);
    const lateral = MUZZLE_SMOKE.driftLateralSquares * gridPx * (rng() * 2 - 1);
    let x = from.x + plan.offset.x + ax * along + px * lateral;
    let y = from.y + plan.offset.y + ay * along + py * lateral;
    const anchor = origin ?? from;
    const cap = MUZZLE_SMOKE.driftMaxSquares * gridPx;
    const outX = x - anchor.x, outY = y - anchor.y;
    const out = Math.hypot(outX, outY);
    if (out > cap) { x = anchor.x + (outX / out) * cap; y = anchor.y + (outY / out) * cap; }
    plan.aimDeg = Number((Math.atan2(dy, dx) * 180 / Math.PI).toFixed(2));
    plan.driftTo = { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
    plan.driftFromOriginSquares = Number((Math.hypot(x - anchor.x, y - anchor.y) / gridPx).toFixed(3));
    plan.lateralSquares = Number((lateral / gridPx).toFixed(3));
  }
  return plan;
}

// Capture seam, the same shape as _setFlashLevels above and for the same reason: a pellet crosses in
// `dashMs`, which is a handful of frames on a client with a graphics card and LESS THAN ONE on a
// software rasteriser, so a screenshot pass has nothing to catch. Lengthening the crossing lets the
// fan be photographed; every image taken that way says HELD in its filename, because the geometry is
// the shipped geometry but the duration is not. Null = the shipped crossing time.
let _dashMsOverride = null;

/** Test/capture seam: force the pellet crossing time (null restores the mapped value). */
export function _setDashMs(ms) {
  _dashMsOverride = Number.isFinite(ms) && ms > 0 ? Number(ms) : null;
  return _dashMsOverride;
}

// Capture seam, third of the same family (_setFlashLevels, _setDashMs). The muzzle sprite is trimmed
// to a third of a short clip and this host takes about two seconds to produce one screenshot, so the
// whole flash is over several times before a camera exists — every attempt to photograph it at the
// shipped rate came back empty. Slowing the sprites' PLAYBACK stretches the same frames over a longer
// wall clock without changing a single value that ships: the sizes, the trim fractions, the geometry
// and the colour are all untouched, only the clock is. Images taken through it say HELD in the name.
// Null = the shipped rate.
let _spriteRateOverride = null;

/** Test/capture seam: force the sprite playback rate (null restores the shipped rate). */
export function _setSpriteRate(rate) {
  _spriteRateOverride = Number.isFinite(rate) && rate > 0 ? Number(rate) : null;
  return _spriteRateOverride;
}

/**
 * Apply the capture seam to one queued effect, if it is armed. Returns the effect so the rest of the
 * chain continues from here — it is applied FIRST, before the size and the trim, deliberately: the
 * engine reads the playback rate when it works out a trim point, so arming the rate afterwards leaves
 * a trimmed clip playing past its own trim. That only ever showed up in capture runs (nothing ships
 * with the seam armed), and it showed up as the trimmed-away plume reappearing in the photographs.
 */
function _held(effect) {
  if (_spriteRateOverride !== null) effect.playbackRate(_spriteRateOverride);
  return effect;
}

/**
 * One shot's visuals: the Sequencer sprite + tracer (when Sequencer is active AND the installed asset
 * tier actually carries the mapped database entries) plus the native muzzle light.
 *
 * ORDERING — both halves start in the SAME tick as the shot's audio. Neither one waits on the other
 * and neither one waits on a server: the flash is a local object plus one datagram, and Sequencer
 * broadcasts over its own socket. (The first build routed the flash through the token-write queue and
 * awaited it before even building the Sequence, which put every sprite a full beat behind the sound
 * it belonged to — measured on a five-round burst: 1126/1197/1337/1494/1794 ms, widening as the queue
 * backed up. Nothing in this path queues any more, so the offset is structurally zero.)
 *
 * `light` gates the flash for callers that only want the sprite half (the keeper's sprite legs).
 *
 * Returns which parts ran, so a caller (and the keeper) can assert the degrade path by value.
 */
export async function fxShot(shooterToken, targetToken, { weaponClass, hit = true, light = true, mode = MUZZLE_MODE, settleTag = null, ammoKey = null, volley = null, shotSeed = 0, arrivalMs = null, aimPoint = null } = {}) {
  const out = { light: false, muzzle: false, spark: false, volley: false, tracer: false, pellets: 0, impact: false, tagged: 0, ammoKey: ammoKey ?? null, arrivalMs: 0, pelletArrivals: 0 };
  // THE CLASS ROW WITH THE LOADED ROUND'S OVERLAY ON TOP (FR#24). Everything below reads `entry` and
  // nothing below knows an overlay happened — which is the point: one merge site, and the draw path is
  // the same code for every load. The KEY is passed in rather than resolved here because there is no
  // payload at this level to resolve it from; fxWeaponFired does that once and threads it.
  const entry = ammoFxEntry(weaponClass, ammoKey);
  if (!entry) return out;
  const from = centerOf(shooterToken);
  const gridPx = Number(canvas?.dimensions?.size) || 100;
  // The axis this whole shot is drawn along — the corridor the shooter declared where there is one
  // (passed in by the fan-out, which resolves it ONCE for the payload), else the aimed-at token's
  // centre, else the shooter's own facing (aimPointOf). Resolved ONCE here too, so the light, the
  // sprite, the spark and the tracer cannot disagree about where the shot is pointed.
  const to = (aimPoint && Number.isFinite(aimPoint.x) && Number.isFinite(aimPoint.y))
    ? aimPoint : aimPointOf(shooterToken, targetToken, gridPx);
  // Where the sprites are planted: the shooter's forward edge, walked along that axis by a fraction
  // of the token's OWN width. The previous build put everything on the centre unconditionally.
  const muzzle = muzzlePoint(from, to, tokenRadiusPx(shooterToken, gridPx) * 2 * MUZZLE_SPRITE.edgeFraction);
  // ⭐ WHEN THIS ROUND GETS THERE (2026-08-11). Passed in by the fan-out, which resolves it ONCE for the
  // whole payload so every element of every round hangs on the same number; derived here from the same
  // resolver when this verb is called on its own (the keeper does, and a caller who has not measured the
  // shot must still get an arrival rather than a zero — that zero was the reported defect). See
  // arrivalSpecFor for the three shapes and TRACER_ARRIVAL_MS for the painted one's measurement.
  const aimSquares = from && to ? Math.hypot(to.x - from.x, to.y - from.y) / gridPx : 0;
  const arrival = (arrivalMs !== null && Number(arrivalMs) >= 0)
    ? Number(arrivalMs) : arrivalSpecFor(weaponClass, ammoKey, aimSquares, volley).ms;
  out.arrivalMs = arrival;
  // The flash is announced and drawn first because it costs nothing to wait for — it is synchronous.
  // It takes the SAME axis as the sprites, so the notch behind the shooter lines up with the bolt.
  // The ammo's own flash colour where its overlay names one. It reaches the source through the
  // darkness gate (flashColorFor), so it can only ever appear in the regime the gate already allows a
  // colour in — a lit scene draws the same uncoloured flash it drew before this existed.
  if (light && shooterToken) out.light = fxMuzzleFlash(shooterToken, to, { mode, ammoColor: entry.flashColor ?? null });

  if (sequencerActive() && shooterToken) {
    try {
      const seq = new globalThis.Sequence();
      // The muzzle sprite is DIRECTIONAL — a bolt drawn along one axis — so it is never played
      // unrotated: unrotated it points its own baked direction no matter where the shooter is
      // aiming, which is what a viewer reads as a bullet stuck on the shooter aiming away from the
      // target (an earlier reported defect). It is always given an axis instead. An earlier build
      // SUPPRESSED it when nothing was aimed at, on the reasoning that a token's own facing is not a
      // stand-in for an aim; that produced two visibly different effects for the same trigger pull
      // and was rejected on report. The facing IS the stand-in now, resolved once in `to` above.
      // rotateTowards accounts for the asset's own baked orientation (measured on
      // jb2a.muzzle_flash.single.01.yellow: it lands along the shooter→aim line with NO additional
      // sprite-rotation offset, so none is applied; the keeper pins that by value).
      // The key is checked before the tier lookup so a row naming no lance is a plain "this class
      // draws none", not a database miss. Every shipped class names one as of 2026-08-09 — the shell
      // was the exception and got its lance back when the discharge column was deleted.
      if (to && entry.muzzle && fxDbEntryExists(entry.muzzle)) {
        // Sized in GRID UNITS (a spec, not a scale factor — see MUZZLE_SPRITE), planted at the
        // token's forward edge, and cut short of the clip's smoke-and-fire phase.
        const lance = _held(seq.effect().file(entry.muzzle)).atLocation(muzzle)
          .size({ width: entry.muzzleSquares }, { gridUnits: true })
          .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING)
          .timeRange(0, MUZZLE_SPRITE.endMs)
          .rotateTowards(to);
        // The class's own DWELL, applied as a rate over the SAME trimmed range (see the dwell block):
        // a single discharge's lance is otherwise over before the eye settles, where an automatic's
        // restarts often enough to read as sustained.
        //
        // ⚠ THE CAPTURE SEAM STILL WINS. _held has already applied it if one is armed, and a class rate
        // set afterwards would silently defeat it — the same "apply the seam FIRST in the chain" trap
        // the trim hit once before. So this is applied only when no capture rate is holding the sprite.
        if (_spriteRateOverride === null) {
          const rate = muzzleRateFor(weaponClass);
          if (rate !== 1) lance.playbackRate(rate);
        }
        out.muzzle = true;
      }
      // The spiky companion. Radial, so it takes no aim of its own; it is planted on the same muzzle
      // point, which puts its rear rays over the shooter exactly as the reference shows.
      if (to && entry.spark && fxDbEntryExists(MUZZLE_SPARK.key)) {
        _held(seq.effect().file(MUZZLE_SPARK.key)).atLocation(muzzle)
          .size({ width: MUZZLE_SPARK.squares }, { gridUnits: true })
          .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING);
        out.spark = true;
      }
      // THE BUCKSHOT VOLLEY (2026-08-09, ON TRIAL — see the VOLLEY block). One asset that contains the
      // whole discharge: a five-round fan crossing to the aim point and blooming into its own arrival
      // fireballs. It REPLACES the pellet fan for this shot rather than joining it, and the hit mark is
      // suppressed below for the same reason — the asset already draws an arrival, and two arrivals on
      // one square is the doubling this rail has been asked to stop drawing twice before.
      //
      // The chaos is this ROUND's own, seeded off the payload plus the round index (volleyChaosFor), so
      // each shell of a burst is mirrored and angled differently while two clients still agree. The
      // jitter rotates the endpoint ABOUT THE SHOOTER, so the shot's LENGTH is untouched and the band —
      // which is what every timing below is derived from — cannot be moved by it.
      //
      // TERMINAL ELEMENT: this is the only thing the round draws that lasts, so it carries the settle
      // name that the tracer and the impact carry on every other load.
      const volleyOk = volley && to && fxDbEntryExists(volley.key);
      if (volleyOk) {
        const chaos = volleyChaosFor(shotSeed);
        const aimed = hit ? rotateAbout(from, to, chaos.jitterDeg) : missEndpoint(from, to);
        const shot = _held(seq.effect().file(volley.key)).atLocation(shooterToken)
          .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING)
          .mirrorY(chaos.mirrorY)
          .stretchTo(aimed);
        // ⭐ THE LOADED ROUND'S COLOUR REACHES THE VOLLEY TOO (2026-08-10). A branch that REPLACES the
        // drawn round still owes the resolved entry its treatments: this one draws the whole discharge
        // in one sprite, so if it read no overlay field at all then an incendiary shell drew the plain
        // orange fan, a hardened one lost its tint, and the "update one shotgun load's animation, update
        // them all" ruling was true of the pellet fan and false of the thing that replaced it.
        // It is the SAME expression the fan uses one branch below (`if (entry.tracerColor)`), which is
        // what keeps the declared-vs-painted semantics intact rather than restating them: the shell row
        // declares `tracerColor: null`, so the BASE volley is painted with nothing and stays the settled
        // look, while api/ap/dualPurpose paint through the merge exactly as they paint the pellets.
        if (entry.tracerColor) shot.filter("ColorMatrix", entry.tracerColor);
        if (settleTag) { shot.name(settleTag); out.tagged++; }
        out.volley = true;
        out.tracer = true;
        out.volleyBand = volley.band;
        out.volleyChaos = chaos;
        // Reported so the keeper reads what was PAINTED rather than what the table declares — null on a
        // base shell is the answer, not the absence of one.
        out.volleyColor = entry.tracerColor ?? null;
      }
      if (!volleyOk && to && fxDbEntryExists(entry.tracer)) {
        // A class carrying a pellet count draws its round as a FAN of tracers instead of one bolt;
        // every other class omits the field and takes the single endpoint. `out.tracer` stays the same
        // boolean either way (did this shot claim a tracer at all) and `out.pellets` reports how many
        // were queued, so a caller can tell the two shapes apart.
        // ⭐ THE FAN IS IRREGULAR NOW (2026-08-11) — each pellet takes its own angle nudge inside the
        // class's cone, its own depth, its own drawn size and its own few milliseconds of lateness, all
        // from THIS shot's seed so two clients draw the identical cluster and two trigger pulls do not.
        // See PELLET_CHAOS for the ruling. A class carrying no pellet count computes an empty record and
        // reads exactly as it did.
        const jitter = pelletJitterFor(shotSeed, Math.trunc(entry.pellets) || 0, entry.spreadRad);
        const fan = pelletEndpoints(from, to, { pellets: entry.pellets, spreadRad: entry.spreadRad, hit, jitter });
        const ends = fan.length ? fan : [hit ? to : missEndpoint(from, to)];
        // Two ways to draw one round, chosen by whether the class asked for a dash length:
        //
        // STRETCHED (no `dashSquares`) — the mapped asset is a ranged database entry, a streak drawn
        // for a distance, and stretchTo scales it along the whole shooter→target line. The round
        // appears as one long mark spanning the shot. This is the rifle read and it stays untouched.
        //
        // TRAVELLED (`dashSquares` present) — the same asset is instead pinned to a fixed SIZE in grid
        // units and moved from muzzle to endpoint over `dashMs`. Sizing in grid units (rather than by
        // `scale`) is what makes the length a spec instead of an accident: the ranged entry hands back
        // a different source file per distance band, so a scale factor would draw a different length on
        // a near shot than a far one, while a grid-unit size is the same fraction of a square every
        // time. Passing only a width leaves the height on the asset's own aspect, so the dash stays
        // proportioned rather than squashed. Rotation is set once, explicitly, and the movement is told
        // not to rotate again, so there is a single source of the sprite's heading.
        // ONE muzzle velocity for every pellet of the round, in pixels per second, derived from the
        // class's crossing time AT THE AIM DISTANCE. See DASH_ARRIVAL_HOLD_MS for why the travel is
        // driven by a speed rather than by the effect's lifetime; `dashMs` still means exactly what the
        // table says it means — how long a pellet takes to cross to what was aimed at. A pellet sent
        // somewhere else (the miss splay reaches short or wide) then takes proportionally more or less
        // time to get there, which is what one muzzle velocity and different distances would do.
        const dashMs = _dashMsOverride ?? entry.dashMs;
        const aimDist = Math.hypot(to.x - from.x, to.y - from.y) || 1;
        const pelletSpeed = (aimDist / Math.max(1, dashMs)) * 1000;
        for (let p = 0; p < ends.length; p++) {
          const end = ends[p];
          const chaos = jitter[p] ?? null;
          const shot = _held(seq.effect().file(entry.tracer)).atLocation(shooterToken)
            .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING);
          // TERMINAL ELEMENT — named so the engine's own end can be observed (see _watchSettleTag).
          if (settleTag) { shot.name(settleTag); out.tagged++; }
          // The colour shift, where the class asks for one. A ColorMatrix and not a tint — see
          // TRACER_COLOR for the measurement that rules the tint out.
          if (entry.tracerColor) shot.filter("ColorMatrix", entry.tracerColor);
          if (entry.dashSquares > 0) {
            // THIS pellet's own drawn width and its own few milliseconds of lateness. The size varies
            // about the row's number and the stagger is spent BEFORE the movement, so the crossing time
            // and therefore the arrival ladder are untouched by either.
            const width = Number((entry.dashSquares * (Number(chaos?.sizeScale) > 0 ? chaos.sizeScale : 1)).toFixed(4));
            shot.size({ width }, { gridUnits: true })
              .rotateTowards(end)
              .moveTowards(end, { ease: "linear", rotate: false })
              .moveSpeed(pelletSpeed)
              .duration(dashMs + DASH_ARRIVAL_HOLD_MS)
              .fadeOut(DASH_ARRIVAL_HOLD_MS);
            if (chaos?.delayMs > 0) shot.delay(chaos.delayMs);
          } else {
            shot.stretchTo(end);
          }
          // ⭐ WHERE THIS PELLET LANDED — the small arrival mark, on a round that HIT and a load that
          // does not already light its own landing points (the razor split is at PELLET_ARRIVAL). It
          // hangs on the same arrival clock as everything else, plus this pellet's own stagger, so the
          // marks pop in the order the pellets got there. Never tagged: they are trimmed well under the
          // aim-point mark, so they cannot be the last thing on screen and the tail takes no term.
          // The capture seam wins here too, for the same reason it wins over the hit mark: a test that
          // shortens the crossing must shorten everything that waits on it.
          if (hit && fan.length && !entry.groundFire && fxDbEntryExists(PELLET_ARRIVAL.key)) {
            _held(seq.effect().file(PELLET_ARRIVAL.key)).atLocation(end)
              .size({ width: PELLET_ARRIVAL.squares }, { gridUnits: true })
              .timeRange(0, PELLET_ARRIVAL.clipMs)
              .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING)
              .delay((_dashMsOverride ?? arrival) + (Number(chaos?.delayMs) || 0));
            out.pelletArrivals++;
          }
        }
        out.tracer = true;
        out.pellets = ends.length;
      }
      // The HIT CONFIRMATION — one impact at the aimed-at point, and only for a round that LANDED.
      // The miss branch draws nothing on purpose: a miss already says so by where its tracer goes,
      // and marking it would make every shot look like a hit. Held back by the tracer's own crossing
      // time where the class travels one, so the impact does not precede its own pellets.
      //
      // ⭐ THE IMPACT IS PROMOTABLE (FR#24). The asset is `entry.impactKey` where a row or an ammo
      // overlay names one and HIT_CONFIRM.key otherwise, and it is TRIMMED to `entry.impactClipMs`
      // (default: the ordinary impact's own full length, so the trim is a no-op for an unpromoted
      // row). The existing tier gate is unchanged and now guards the resolved key, so an overlay
      // naming an asset the installed tier lacks degrades to NO impact rather than to a wrong one —
      // the same silent-degrade rule every other key on this rail follows.
      //
      // SUPPRESSED FOR A VOLLEY (2026-08-09, while the trial runs): that asset bakes its own arrival
      // bloom at the endpoint, so ours would be a second star on the same square. Expressed as a gate
      // here rather than as a zeroed width on the row, because the row is the CLASS's and the volley is
      // a property of the shot — and because switching the trial off must restore the mark with it.
      //
      // ⭐ AND IT NOW WAITS FOR EVERY SHAPE OF ROUND, not just a travelled one (2026-08-11). The delay
      // used to be `dashSquares > 0 ? dashMs : 0`, so the four PAINTED classes confirmed their hit in
      // the same tick they fired — the reported "impacts play when the round departs". It is the
      // resolved arrival now, which is that expression for a travelled round and a measured band
      // crossing for a painted one. `delayFollowsTracer` still switches the whole behaviour off in one
      // field; what changed is the number it gates, not the gate.
      const mark = hitMarkFor(weaponClass, ammoKey);
      if (!volleyOk && hit && to && mark && fxDbEntryExists(mark.key)) {
        const impact = _held(seq.effect().file(mark.key)).atLocation(to)
          .size({ width: mark.squares }, { gridUnits: true })
          .timeRange(0, mark.clipMs)
          .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING);
        // TERMINAL ELEMENT — on a landing round this is normally the last thing to leave the screen.
        if (settleTag) { impact.name(settleTag); out.tagged++; }
        // The capture seam's dash override still wins where one is armed, for the same reason it wins
        // over the sprite rate: a test that shortens the crossing must shorten what waits on it.
        const travel = HIT_CONFIRM.delayFollowsTracer
          ? (entry.dashSquares > 0 ? (_dashMsOverride ?? arrival) : arrival) : 0;
        if (travel > 0) impact.delay(travel);
        out.impact = true;
        // Reported so a caller (and the keeper) can assert WHICH mark was drawn and how wide, by
        // value, rather than by looking at the canvas — the promotion is otherwise invisible to a test.
        out.impactKey = mark.key;
        out.impactSquares = mark.squares;
        out.impactClipMs = mark.clipMs;
        out.impactDelayMs = travel;
      }
      if (out.muzzle || out.tracer || out.impact || out.volley) await seq.play();
    } catch (err) {
      console.warn(`${SCOPE} | sequencer shot effect failed`, err);
    }
  }
  return out;
}

/**
 * ONE smoke puff, emitted mid-burst and fully self-randomised — the unit the rolling mass is made of.
 *
 * Built as its OWN Sequence with its OWN single section, which is the load-bearing part: Sequencer
 * rolls its randomisers once per section, so any attempt to get variation out of one section with
 * repeats produces identical copies (see MUZZLE_SMOKE). Every varying property below is rolled here,
 * per call, and handed to the builder as a fixed value.
 *
 * Returns the plan it used so the fan-out and the keeper can read what was actually asked for.
 * NOT awaited by its caller — the puff must not hold up the round that spawned it.
 */
export async function fxSmokePuff(shooterToken, targetToken, { weaponClass, index = 0, rng = Math.random, aimPoint = null } = {}) {
  const entry = FX_CLASSES[weaponClass];
  if (!entry || !(entry.smokeSquares > 0) || !sequencerActive() || !shooterToken) return null;
  if (!fxDbEntryExists(MUZZLE_SMOKE.key)) return null;
  const gridPx = Number(canvas?.dimensions?.size) || 100;
  const from = centerOf(shooterToken);
  // The payload's own axis where the fan-out resolved one (a declared shot-pattern corridor), else the
  // shared reading — see the note at fxShot's `to`.
  const to = aimPoint ?? aimPointOf(shooterToken, targetToken, gridPx);
  if (!from || !to) return null;
  // Born at the BARREL, not at the sprite's forward edge — see MUZZLE_SMOKE.originFraction.
  const muzzle = muzzlePoint(from, to, tokenRadiusPx(shooterToken, gridPx) * 2 * MUZZLE_SMOKE.originFraction);

  // The five variants live under ONE key, so the cycle indexes the FILE LIST. If the database will not
  // hand it over, the key itself still plays — the engine picks a file and the puff simply loses its
  // deterministic cycling, not its existence.
  let files = [];
  try { files = (globalThis.Sequencer?.Database?.getAllFileEntries?.(MUZZLE_SMOKE.key) ?? []).flat().filter((f) => typeof f === "string"); }
  catch (_e) { files = []; }

  const plan = smokePuffPlan(index, { files, sizeSquares: entry.smokeSquares, gridPx, from: muzzle, to, origin: from, rng });
  try {
    const seq = new globalThis.Sequence();
    // ⚠⚠ NO `rotateTowards` HERE, AND THAT IS THE WHOLE FIX FOR "it seems to be launching out of the
    // gun like a projectile". Read off the engine: `_moveTowards()` moves the effect to
    // `this.targetPosition`, which is `data.target` — and `rotateTowards(aim)` is what SETS data.target.
    // So a puff built with both was never drifting to the point this planner computed at all; it was
    // flying to the aimed-at token, at whatever speed its own lifetime implied. The drift cap below was
    // never consulted. Measured before this fix: puffs sat 6-9 squares from the shooter on a 9-square
    // shot line — i.e. arriving with the rounds.
    //
    // The heading is set directly instead, which is what was actually wanted: the side-puff asset is
    // pointed along the aim plus this instance's own jitter, and `moveTowards` is left as the only
    // thing that owns a destination.
    const puff = seq.effect().file(plan.file)
      .atLocation({ x: muzzle.x + plan.offset.x, y: muzzle.y + plan.offset.y })
      .size({ width: plan.sizeSquares }, { gridUnits: true })
      .spriteRotation(plan.aimDeg + plan.rotationDeg)
      .mirrorY(plan.mirrorY)
      .opacity(MUZZLE_SMOKE.opacity)
      .scaleIn(MUZZLE_SMOKE.scaleInFrom, MUZZLE_SMOKE.scaleInMs, { ease: "easeOutQuad" })
      .fadeOut(MUZZLE_SMOKE.fadeOutMs)
      // The PHASE. Starting each instance at a different point of its own clip is what makes the mass
      // advance in pieces instead of in lockstep, and it is half of the "different parts advance on
      // different frames" the ruling describes; the per-instance rate is the other half, because it
      // makes their frames land on different render ticks.
      .startTime(plan.startTimeMs);
    // The capture seam still wins where it is armed, so a capture run holds every puff at one rate.
    puff.playbackRate(_spriteRateOverride ?? plan.playbackRate);
    // Deliberately NOT tagged for the completion signal: the smoke is dressing and the apply window
    // does not wait for it (see presentationTailMs). There is no settleTag parameter here at all.
    if (plan.driftTo) puff.moveTowards(plan.driftTo, { ease: "easeOutQuad", rotate: false });
    seq.play().catch((err) => console.warn(`${SCOPE} | smoke puff play failed`, err));
    return plan;
  } catch (err) {
    console.warn(`${SCOPE} | smoke puff failed`, err);
    return null;
  }
}

/**
 * The MULTI-ROUND-ONLY muzzle treatments: one spray of hot specks down the firing cone and one smoke
 * wisp at the muzzle, drawn ONCE for the whole burst rather than once per round.
 *
 * WHY ONCE PER BURST. The reference shows roughly a dozen specks and a single wisp for a ten-round
 * burst — not a dozen per round. Drawing them per round would put a hundred-odd sprites on the canvas
 * for one trigger pull and would restart the wisp ten times, which is the opposite of the "lingers
 * between shots" the wisp is here for. So this is called once, from the fan-out, before the rounds go.
 *
 * WHY IT IS NOT CALLED FOR A SINGLE SHOT: the caller does not call it. The gate is the payload's round
 * count, which is a property of the shot rather than of the weapon — the same weapon fires both ways.
 *
 * Returns what it queued, so the keeper asserts the gate by value rather than by watching the canvas.
 */
export async function fxBurstAmbience(shooterToken, targetToken, { weaponClass, shots = 0, cadenceMs = SHOT_CADENCE_MS, aimPoint = null } = {}) {
  const out = { motes: 0 };
  const entry = FX_CLASSES[weaponClass];
  if (!entry || !sequencerActive() || !shooterToken) return out;
  const from = centerOf(shooterToken);
  const gridPx = Number(canvas?.dimensions?.size) || 100;
  // The same axis every other part of the shot takes (aimPointOf) — the aimed-at token's centre, or
  // the shooter's own facing. This used to bail outright when nothing was aimed at, so a burst fired
  // at no target lost its specks and its wisp along with its wedge; that was the reported defect.
  // What remains of the guard is a shooter with no position at all, which has no muzzle to draw from.
  const to = aimPoint ?? aimPointOf(shooterToken, targetToken, gridPx);
  if (!from || !to) return out;

  const muzzle = muzzlePoint(from, to, tokenRadiusPx(shooterToken, gridPx) * 2 * MUZZLE_SPRITE.edgeFraction);

  try {
    const seq = new globalThis.Sequence();
    if (entry.motes > 0 && fxDbEntryExists(MUZZLE_MOTES.key)) {
      const ends = moteEndpoints(muzzle, to, {
        count: entry.motes,
        spreadRad: MUZZLE_MOTES.spreadRad,
        nearPx: MUZZLE_MOTES.nearSquares * gridPx,
        farPx: MUZZLE_MOTES.farSquares * gridPx,
      });
      const span = MUZZLE_MOTES.travelMaxMs - MUZZLE_MOTES.travelMinMs;
      for (const end of ends) {
        _held(seq.effect().file(MUZZLE_MOTES.key)).atLocation(muzzle)
          .size({ width: MUZZLE_MOTES.sizeSquares }, { gridUnits: true })
          .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING)
          .moveTowards(end, { ease: "easeOutQuad", rotate: false })
          .duration(MUZZLE_MOTES.travelMinMs + Math.random() * span);
      }
      out.motes = ends.length;
    }
    // NO SMOKE HERE ANY MORE. The wisp used to be queued alongside the specks, once for the whole
    // burst; smoke is now a stream of overlapping puffs emitted ACROSS the burst (fxSmokePuff, called
    // from the fan-out at the class's stride). The embers are unchanged and stay per burst — they are
    // a single spray thrown once, which is what they always were.
    // NOT awaited, deliberately. The engine's play promise settles somewhere inside the effect's own
    // lifetime, and the wisp is asked to live for the whole burst — so awaiting it here would hold the
    // first round back by up to the wisp's entire duration and the burst would start seconds after the
    // trigger. Measured on this rig before the change: the fan-out's per-round cost went from tens of
    // milliseconds to hundreds, all of it this one await. Queuing is synchronous, so the counts below
    // are already final when this returns.
    if (out.motes) seq.play().catch((err) => console.warn(`${SCOPE} | burst ambience play failed`, err));
  } catch (err) {
    console.warn(`${SCOPE} | burst ambience failed`, err);
  }
  return out;
}

/**
 * HOW MANY FLAMES ARE BURNING ON THIS SCENE RIGHT NOW, oldest first. The scene cap's only reader.
 *
 * Every flame is stamped with a name under one prefix when it is queued, which is what makes this a
 * query rather than a ledger: the engine already knows what is alive, and a count we kept ourselves
 * would drift the moment an effect ended for any reason we did not cause (a scene change, a reload, a
 * GM clearing the canvas). `creationTimestamp` is the engine's own field, so "oldest" is its answer
 * and not our guess about ordering.
 */
/** Flames QUEUED but not yet created by the engine — counted against the cap. See fxGroundFire. */
let _pendingGroundFires = 0;

/** How many flames are on their way but not yet visible to the engine. Read by the keeper. */
export function pendingGroundFires() {
  return _pendingGroundFires;
}

export function liveGroundFires() {
  try {
    const list = globalThis.Sequencer?.EffectManager?.getEffects?.({ name: `${GROUND_FIRE_NAME}.*` }) ?? [];
    return [...list].sort((a, b) => (a?.data?.creationTimestamp ?? 0) - (b?.data?.creationTimestamp ?? 0));
  } catch (_e) {
    return [];
  }
}

/**
 * THE INCENDIARY GROUND FIRE — N small flames at the points a payload's rounds landed.
 *
 * ⏪ It used to draw a second element with them, one dark mark under the whole placement; that was
 * removed 2026-08-10 on user ruling and its values are recorded beside GROUND_FIRE. The verb keeps its
 * name and its shape, and now reports fires only.
 *
 * GATED ON THE ROW, NOT ON A NAME. The caller decides by reading `groundFire` off the resolved entry
 * (ammoFxEntry), so no branch anywhere in this file names the incendiary load — adding the field to a
 * second overlay is all it would take to give another round the same treatment.
 *
 * ⭐ TAKES A LIST OF POINTS (2026-08-09). It used to take one point, which is what put the whole fire
 * on the target; the caller now hands it wherever the rounds went (groundFirePoints for a fired
 * payload, patternFirePoints for a shot pattern) and this verb only draws. The list is truncated to
 * `maxPerPayload` here as well as at the planners, because a bound that only exists in the caller is
 * a bound the next caller will not have.
 *
 * ⭐ THE SCENE CAP IS ENFORCED HERE, BY EVICTION, and only here. These burn for the best part of a
 * minute, so across a firefight they accumulate in a way a 3-second element never could. Before
 * placing, enough of the OLDEST live flames are ended to leave room for this placement — never the
 * newest, because the shot a viewer is watching is the one that must be drawn. Ending is done through
 * the engine's own manager, which relays the end to every other client exactly as the placement was
 * relayed, so no client is left with a fire the others have put out.
 *
 * ONE SECTION PER FLAME, which is the file's standing answer to the randomiser trap: the engine rolls
 * a multi-file key once per SECTION, so N flames in one section would be N identical copies of one
 * roll. Each flame also gets its own name so the cap above can find it.
 *
 * `delayMs` is the travelled tracer's crossing time, so the fires start when the rounds arrive rather
 * than when they leave. It is the same number the hit confirmation is held back by, read from the same
 * row field, so they land together.
 *
 * NOT AWAITED by its caller and NOT TAGGED for the settle signal — see the two spec blocks above for
 * both rulings. Returns what it queued so the gates, the counts and the lifetimes are assertable by
 * value.
 */
export async function fxGroundFire(points, { delayMs = 0, max = GROUND_FIRE.maxPerPayload } = {}) {
  const out = { fires: 0, fireMs: 0, evicted: 0, at: [] };
  const list = (Array.isArray(points) ? points : [points])
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .slice(0, Math.max(0, Math.trunc(max)));
  if (!list.length || !sequencerActive()) return out;
  const delay = Number(delayMs) > 0 ? Number(delayMs) : 0;
  try {
    // THE CAP, applied before anything is queued: make room for this placement by ending the oldest.
    //
    // ⚠ THE PENDING TALLY IS PART OF THE COUNT, and it is not bookkeeping for its own sake. This verb
    // is fire-and-forget and the engine does not create an effect until its own play resolves, so a
    // placement that has been QUEUED is invisible to liveGroundFires until a beat later. Two placements
    // issued inside that beat therefore both read the same "live" number and both under-evict. That was
    // unreachable while the fan-out loop ran at twice its own length; the anchored loop (see
    // FX_DROP_LAG_FRACTION) hands bursts over fast enough to reach it, and the rig caught it immediately —
    // eight bursts left 28 flames alive against a cap of 24. Counting what is already on its way is
    // what makes the cap hold rather than approximately hold.
    if (fxDbEntryExists(GROUND_FIRE.key)) {
      const live = liveGroundFires();
      const overBy = live.length + _pendingGroundFires + list.length - GROUND_FIRE.maxLive;
      if (overBy > 0) {
        const names = live.slice(0, Math.min(overBy, live.length)).map((e) => e?.data?.name).filter(Boolean);
        out.evicted = names.length;
        for (const name of names) {
          globalThis.Sequencer?.EffectManager?.endEffects?.({ name })
            ?.catch?.((err) => console.warn(`${SCOPE} | ground fire eviction failed`, err));
        }
      }
    }
    const seq = new globalThis.Sequence();
    if (fxDbEntryExists(GROUND_FIRE.key)) {
      for (const p of list) {
        const fire = _held(seq.effect().file(GROUND_FIRE.key)).atLocation({ x: p.x, y: p.y })
          .size({ width: GROUND_FIRE.squares }, { gridUnits: true })
          // Self-luminous → above the lighting, with the vision-mask trade documented at the spec block.
          .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING)
          .opacity(GROUND_FIRE.opacity)
          // Each flame is turned a different way so a cluster does not read as one picture stamped N
          // times. The asset is a top-down plate, so a rotation cannot disagree with anything.
          .randomRotation()
          .name(`${GROUND_FIRE_NAME}.${foundry.utils.randomID()}`)
          .fadeIn(GROUND_FIRE.fadeInMs)
          .duration(GROUND_FIRE.lifetimeMs)
          .fadeOut(GROUND_FIRE.fadeOutMs);
        if (delay > 0) fire.delay(delay);
        out.fires++;
        out.at.push({ x: Math.round(p.x), y: Math.round(p.y) });
      }
      out.fireMs = GROUND_FIRE.lifetimeMs;
    }
    // ⏪ The mark that used to be drawn here, at the flames' centroid, was removed 2026-08-10 on user
    // ruling — its final values are recorded in the block above.
    if (out.fires) {
      // Held on the tally from the moment they are queued until the engine has actually made them, at
      // which point liveGroundFires can see them and the tally must let go — released in a finally so
      // a play that throws cannot strand the count high and starve every later placement.
      _pendingGroundFires += out.fires;
      seq.play()
        .catch((err) => console.warn(`${SCOPE} | ground fire play failed`, err))
        .finally(() => { _pendingGroundFires = Math.max(0, _pendingGroundFires - out.fires); });
    }
  } catch (err) {
    console.warn(`${SCOPE} | ground fire failed`, err);
  }
  return out;
}

/**
 * IS THIS PAYLOAD THE SHOT PATTERN'S, RATHER THAN THE SINGLE-TARGET FLOW'S? Pure.
 *
 * The identical call damage-hooks.js makes at both of its own gates — literally the same shared site
 * (lookups.js `spreadFlowModeOf`) — and made here for the same reason it is made there: the two flows
 * never overlap, so an element that belongs to one must not be drawn for the other. The question is
 * asked of the CARTRIDGE, never of a stored flag: every shotgun ammo item ever seeded carries
 * `spreadMode: "single"`, so reading the field would answer "not a pattern" for every shell in every
 * existing world.
 *
 * ⭐ THE PATTERN'S WORLD SWITCH IS PART OF THAT SHARED ANSWER, so this follows it without knowing it
 * exists. With the pattern switched OFF no flow places one, the shell takes the ordinary single-target
 * route, and the fan-out therefore draws an incendiary shell's burning ground itself — which is right,
 * because the confirm that would otherwise have scattered those fires down the path never happens.
 * ⏪ This reverses the earlier note here, which said the setting was deliberately not consulted because
 * neither damage gate consulted it. Neither did — and that was the defect, not the design.
 */
export function patternFlowOwns(payload) {
  return spreadFlowModeOf(payload) !== SPREAD_MODE_SINGLE;
}

/**
 * DOES THIS LOAD SET FIRES — the one question the shot-pattern flow asks of this file. Pure.
 *
 * The pattern flow (combat/damage-hooks.js) resolves its own ammo key when it places a pattern and asks
 * this when the GM confirms it, so the fire is decided by the SAME table every other ammo treatment is
 * decided by. Exported rather than inlined there for the usual reason: a second copy of "which loads
 * burn" is a second thing to keep in step with AMMO_FX.
 */
export function ammoLeavesGroundFire(ammoKey) {
  return AMMO_FX[ammoKey]?.groundFire === true;
}

/**
 * THE SHOT PATTERN'S OWN FIRES — scattered inside a confirmed pattern rather than at one aim point.
 *
 * ⚠ WHY THIS IS A SECOND ENTRY POINT AND NOT A BRANCH IN THE FAN-OUT. A payload is resolved by exactly
 * one of two flows and they never overlap (the either/or is `spreadModeForAmmo`, asked in
 * damage-hooks.js). For a pattern payload, "where the shot landed" is not the target — the Core rules
 * say everyone in the 1-3m path is hit, which is a fact the module already asserts by damaging them —
 * so the fires belong to the PATH. That geometry is computed by the flow that owns it, at the moment
 * the GM commits to it, and this verb is handed the result. The fan-out correspondingly draws no
 * ground fire for a pattern payload; the same call decides both halves, so they cannot disagree.
 *
 * Placed on CONFIRM rather than on placement, deliberately: an unconfirmed pattern is a GM-only aiming
 * aid, and a fire is not. Lighting the ground when the GM is still deciding would both leak the aim and
 * leave fires burning for a shot that was never resolved.
 */
export async function fxPatternGroundFire({ x, y, dirDeg, lengthPx, widthPx, count, seed } = {}) {
  const pts = patternFirePoints({ x, y, dirDeg, lengthPx, widthPx, count, seed });
  if (!pts.length) return { fires: 0, fireMs: 0, evicted: 0, at: [] };
  return fxGroundFire(pts, { max: GROUND_FIRE.maxPerPattern });
}

/**
 * Does this actor take damage into STRUCTURE rather than into flesh? Pure-ish, and the answer is
 * taken at the ACTOR level deliberately.
 *
 * TWO WAYS AN ACTOR IS STRUCTURE, and they are the two the rest of the module already recognises:
 *  - it is a vehicle-type actor — the module's own actor type covers both civilian vehicles and
 *    powered-armour suits (a suit is that type with `isACPA` set), and every damage path treats both
 *    as SDP; and
 *  - it is a full-conversion cyborg — a character-type actor whose whole body is machinery, which is
 *    exactly what `isFullBorg` answers and what makes routesToSdp true for all six of its zones.
 *
 * ⚠ WHY NOT `routesToSdp`, WHICH IS THE FUNCTION THAT REALLY DECIDES: it takes a hit LOCATION, and at
 * the moment this rail draws there is no location to give it. The payload carries how many rounds
 * landed, not where — the fan-out already assigns hits to the leading rounds for the same reason. So
 * a per-zone answer is not available at draw time and would have to be invented. The consequence is
 * stated rather than hidden: an ordinary character with a cyberarm reads as FLESH here, and a round
 * that in fact struck that arm still draws blood. That is phase 1's known limit (the doc's open
 * items carry it), and it is the right way round — the alternative, suppressing blood for anyone
 * wearing chrome, would be wrong far more often than this is.
 */
export function bearsStructuralSdp(actor) {
  if (!actor) return false;
  if (String(actor.type ?? "") === `${SCOPE}.vehicle`) return true;
  return isFullBorg(actor) === true;
}

/**
 * THE BLOOD SPLASH for one payload — drawn ON the target token, once, for a hit that landed.
 *
 * Every gate lives at the call site (see the BLOOD_SPLATTER block); this verb only draws. It is given
 * the TOKEN rather than a point on purpose: blood belongs to a body, so a shot with nothing aimed at
 * has nowhere to put it and the caller simply does not call — the synthesized aim point the rest of
 * the rail falls back to is a direction, not a victim.
 *
 * `delayMs` is the class's own crossing time where it travels one, so the splash appears when the
 * round arrives rather than when it leaves — the same number, from the same row field, that holds
 * back the hit confirmation and the burning ground.
 *
 * The rotation is randomised so two hits on one token are not the same picture; the asset is radial
 * about its own centre (measured — see the spec block), so a rotation cannot put it out of line with
 * anything. One section, one roll: Sequencer rolls its randomisers once per section, which is exactly
 * one splash's worth here.
 *
 * NOT AWAITED by its caller and NOT TAGGED for the settle signal. Returns what it queued so the gate
 * and the values are assertable without looking at the canvas.
 */
export async function fxBloodSplatter(shooterToken, targetToken, { delayMs = 0 } = {}) {
  const out = { drawn: false, key: BLOOD_SPLATTER.key, squares: BLOOD_SPLATTER.squares,
    clipMs: BLOOD_SPLATTER.clipMs, exitPoint: null };
  if (!targetToken || !sequencerActive() || !fxDbEntryExists(BLOOD_SPLATTER.key)) return out;
  const delay = Number(delayMs) > 0 ? Number(delayMs) : 0;
  try {
    const seq = new globalThis.Sequence();
    const splash = _held(seq.effect().file(BLOOD_SPLATTER.key)).atLocation(targetToken)
      .size({ width: BLOOD_SPLATTER.squares }, { gridUnits: true })
      // The departure from the routing rule, with the measurement and the reason at the spec block.
      .aboveLighting(BLOOD_SPLATTER.aboveLighting)
      .timeRange(0, BLOOD_SPLATTER.clipMs);
    // ⭐ THE EXIT VECTOR (2026-08-09 ruling). The asset's ink travels left-to-right across its own
    // frame, so pointing that travel at a location makes the spray move that way. The location asked
    // for is a point BEYOND the target on the shooter→target ray — one grid unit past the body — so the
    // spray continues the round's line and leaves on the far side rather than washing back toward the
    // muzzle. `rotateTowards` is the same call and the same basis the tracers take their heading from,
    // which is what keeps the two from ever disagreeing.
    //
    // The rotation is only possible when the shot HAS an axis; a call with no shooter falls back to the
    // old random rotation rather than drawing every splash pointing screen-right, which would be a
    // worse lie than no direction at all.
    const from = shooterToken ? centerOf(shooterToken) : null;
    const at = centerOf(targetToken);
    if (from && at && (from.x !== at.x || from.y !== at.y)) {
      const gridPx = Number(canvas?.dimensions?.size) || 100;
      const reach = Math.hypot(at.x - from.x, at.y - from.y) + gridPx;
      const exit = pointAlong(from, at, reach);
      splash.rotateTowards(exit);
      out.exitPoint = { x: Math.round(exit.x), y: Math.round(exit.y) };
    } else {
      splash.randomRotation();
    }
    if (delay > 0) splash.delay(delay);
    out.drawn = true;
    seq.play().catch((err) => console.warn(`${SCOPE} | blood splash play failed`, err));
  } catch (err) {
    console.warn(`${SCOPE} | blood splash failed`, err);
  }
  return out;
}

/**
 * THE MARK A REFUSED ROUND STILL OWES — the hit confirmation on its own, with no muzzle, no report and
 * no tracer.
 *
 * ⭐ WHY THIS VERB EXISTS (user ruling 2026-08-11): *"hits late in a long burst get NO blood at all"*.
 * The pacing rule (roundDropped) takes a late round WHOLE — audio with picture — and that rule is right
 * about what it was written for: a report landing on top of another report is worse than a missing
 * report, and a backlog of tracers is what made the picture run a second behind the sound. But it was
 * also taking the round's ARRIVAL with it, and an arrival is not a pacing cost: the mark and the spray
 * are ONE sprite each, they are drawn at the far end of the shot rather than at the muzzle, and they
 * are the only thing on screen that says the round landed on somebody. A ten-round burst that hit six
 * times was marking three, which reads as a burst that mostly missed.
 *
 * So the two budgets are now separate: the TRACER budget is the pacing rule's and may refuse rounds,
 * and the IMPACT budget is the payload's hit count (bounded by HIT_MARK_MAX_PER_PAYLOAD). A round that
 * hit gets its impact family whether or not its tracer was drawn.
 *
 * `delayMs` is what is LEFT of this round's arrival at the moment the drop is decided — the fan-out
 * subtracts the lateness that caused the drop, so a mark for a round that is already 200ms behind its
 * slot lands 200ms sooner than one issued on time and the two arrive together on the canvas.
 *
 * ⛔ NEVER TAGGED. The last round is never dropped (the pacing rule guarantees it), so the settle name
 * always rides an ordinary fxShot; a mark from here can never be the element the damage window waits on.
 */
export async function fxHitMark(shooterToken, targetToken, { weaponClass, ammoKey = null, delayMs = 0, aimPoint = null } = {}) {
  const out = { drawn: false, key: null, squares: 0, clipMs: 0, delayMs: 0 };
  const mark = hitMarkFor(weaponClass, ammoKey);
  if (!mark || !sequencerActive() || !fxDbEntryExists(mark.key)) return out;
  const gridPx = Number(canvas?.dimensions?.size) || 100;
  const to = aimPoint ?? (shooterToken ? aimPointOf(shooterToken, targetToken, gridPx) : (targetToken ? centerOf(targetToken) : null));
  if (!to) return out;
  const delay = Number(delayMs) > 0 ? Number(delayMs) : 0;
  try {
    const seq = new globalThis.Sequence();
    const impact = _held(seq.effect().file(mark.key)).atLocation(to)
      .size({ width: mark.squares }, { gridUnits: true })
      .timeRange(0, mark.clipMs)
      .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING);
    if (delay > 0) impact.delay(delay);
    out.drawn = true;
    out.key = mark.key;
    out.squares = mark.squares;
    out.clipMs = mark.clipMs;
    out.delayMs = delay;
    seq.play().catch((err) => console.warn(`${SCOPE} | hit mark play failed`, err));
  } catch (err) {
    console.warn(`${SCOPE} | hit mark failed`, err);
  }
  return out;
}

/**
 * The bound on how many hit marks ONE payload may draw, refused rounds included.
 *
 * It is the fan-out's own round cap and not a smaller number, deliberately: the mark lives 833ms, it is
 * one sprite, and it lands on the square the shot was aimed at — so N of them is N confirmations of N
 * landed rounds, which is the thing the ruling asks to stop losing. The element that genuinely does not
 * survive repetition is the blood spray (four sprays inside one 900ms clip is a fountain), and that one
 * keeps its own much tighter cap at BLOOD_SPLATTER.maxPerPayload. Stated as a constant rather than left
 * implicit so the bound is a value a keeper can read.
 */
export const HIT_MARK_MAX_PER_PAYLOAD = MAX_FX_SHOTS;

/* ══════════════════════════ Payload → shots ══════════════════════════ */

/** Rounds that HIT: the payload's areaDamages carries one entry per hitting round, by location. */
export function hitCountOf(payload) {
  let n = 0;
  for (const list of Object.values(payload?.areaDamages ?? {})) n += Array.isArray(list) ? list.length : 0;
  return n;
}

/**
 * Rounds FIRED for this payload — the per-shot fan-out count.
 *
 * One payload = one resolved burst against one target (the base system renders one multi-hit card per
 * target and the seam emits per card), so the count is read from the card's own `fired` value, which
 * the seam shim forwards as `shotsFired`. A payload without it (an emitter that predates the field)
 * falls back to the number of hits, then to a single shot — never zero, so a miss still flashes.
 */
export function shotCountOf(payload) {
  const fired = Number(payload?.shotsFired);
  if (Number.isFinite(fired) && fired > 0) return Math.min(Math.trunc(fired), MAX_FX_SHOTS);
  return Math.min(Math.max(hitCountOf(payload), 1), MAX_FX_SHOTS);
}

/** The fired weapon: by id (exact — two same-named weapons can carry different ammo), else by name. */
export function resolveFiredWeapon(payload, actor) {
  if (!actor) return null;
  const byId = payload?.weaponId ? actor.items?.get?.(payload.weaponId) : null;
  if (byId) return byId;
  const name = payload?.weaponName;
  return name ? (actor.items?.find?.((i) => i.name === name) ?? null) : null;
}

/**
 * The FX class for a fired weapon, or null when the weapon takes no muzzle fx (melee, or a type with
 * no v1 mapping). Reads the weapon sub-block so a cyberware weapon resolves like a held one.
 *
 * Shotgun detection runs BEFORE the type map: base-data shotguns are typed Rifle on purpose (the
 * type drives the Rifle SKILL per the book), so shotgun-ness lives in the ATTACK type
 * ("Shotgun"/"Autoshotgun" — lookups.js rangedAttackTypes, the field the base comment reserves for
 * exactly this). An existing enum; no per-item name list. A caliber-based fallback is deliberately
 * NOT here: weapon documents carry `ammoType`, not `caliber` (a caliber write is stripped by the
 * schema), and the pack sweep showed the attack type already covers the full shotgun corpus — the
 * few gauge-ammo entries it misses are attackType omissions in the pack data, not a resolver gap.
 */
export function weaponFxClass(weapon) {
  if (!weapon) return null;
  const sys = weapon._getWeaponSystem?.() ?? weapon.system ?? null;
  if (!sys) return null;
  if (weapon.isRanged?.() === false) return null;
  const attack = String(sys.attackType ?? "").trim().toLowerCase();
  if (attack === "shotgun" || attack === "autoshotgun") return "shotgun";
  const raw = String(sys.weaponType ?? "").trim().toLowerCase();
  if (!raw || raw === "melee") return null;
  return WEAPON_TYPE_TO_CLASS[raw] ?? null;
}

/** The shooter's token: the drawn one on the viewed canvas first, else any token document it owns. */
export function shooterTokenOf(actor) {
  if (!actor) return null;
  const drawn = canvas?.tokens?.placeables?.find((t) => t.actor?.id === actor.id);
  return drawn ?? tokensOf(actor)[0] ?? null;
}

/**
 * The figure THIS payload was fired from — the origin every verb below is drawn out of.
 *
 * ⭐ THE PAYLOAD'S OWN ANSWER COMES FIRST, and the lookup above is only what is left when it has none.
 * An actor id cannot name a figure: two tokens of one actor share it, and an unlinked token's own
 * actor carries the base actor's id too, so `shooterTokenOf` can only answer "whichever was placed
 * first" — which is how a shot fired from the second figure drew its flash, its muzzle work and its
 * rounds out of the first (reported from the table 2026-08-10). The seam captures the firing figure at
 * the trigger pull and carries it as `attackerTokenId` (seam-shim.js), so where that field is present
 * the origin is a fact rather than a guess.
 *
 * Falls back for the two cases where the named figure answers nothing HERE: a payload that carries no
 * such field (an older or re-emitted one), and a named figure this client is not drawing — a payload
 * relayed from another scene. Both then behave exactly as every payload did before the field existed;
 * whether a shot with no figure on the viewed canvas should draw at all is a separate question and is
 * deliberately not decided here.
 */
export function shooterTokenForPayload(payload, actor) {
  const named = payload?.attackerTokenId ? (canvas?.tokens?.get(payload.attackerTokenId) ?? null) : null;
  return named ?? shooterTokenOf(actor);
}

/**
 * The turn this payload's shooter would make before firing, or null when it would make none.
 *
 * Answers one question for two callers that must agree: the fan-out, which performs the turn, and the
 * presentation arithmetic, which has to include the time it takes. Both read it from here so a shot
 * cannot be waited out for a turn that never happens, or fired before a turn that does.
 *
 * Null when the feature is off, when this client does not own the token (only the owner may write
 * it), when there is no aim, or when the token is already pointed within the spec's dead zone.
 */
export function faceTargetTurn(shooterToken, aimPoint) {
  if (!faceTargetOnFireEnabled() || !shooterToken || !aimPoint) return null;
  const doc = shooterToken?.document ?? shooterToken;
  if (doc?.isOwner === false) return null;
  // CORE'S OWN "Lock Rotation" flag, honored as the per-token opt-out. When it is set, core draws the
  // token mesh upright no matter what the rotation FIELD says — the table has told us this token has a
  // fixed facing (portrait art, usually). Turning it would then write a rotation nobody can see AND
  // make the fan-out wait out a sweep with nothing on screen: a dead pause. Checked HERE rather than at
  // the write because this one helper is what both callers read — the fan-out that performs the turn
  // and the arithmetic that budgets for it — so a single check removes the write and the lead-in
  // together. Two independent opt-outs, deliberately: this is per token, faceTargetOnFireEnabled() is
  // the table-wide switch, and either alone is enough to mean "no turn".
  if (doc?.lockRotation === true) return null;
  const from = centerOf(shooterToken);
  const to = faceTargetRotation(from, aimPoint);
  if (to === null) return null;
  const delta = rotationDeltaDeg(Number(doc?.rotation) || 0, to);
  if (Math.abs(delta) < FACE_TARGET.minDegrees) return null;
  return { rotation: Number(to.toFixed(3)), deltaDeg: Number(delta.toFixed(3)), durationMs: FACE_TARGET.durationMs };
}

/**
 * Turn the shooter to face what it is shooting at, and RESOLVE WHEN THE TURN IS DONE — the fan-out
 * awaits this, so the first round leaves the muzzle from a token already pointed the right way.
 *
 * ⚠ This is the ONE document write the rail performs. Everything else it draws is client-local and
 * transient; a heading is a fact about the token that should outlive the shot, so it is written and
 * broadcast like any other token change. The dead zone in faceTargetTurn is what keeps a ten-round
 * burst at one target from writing the token ten times — only the first round can turn it.
 */
export async function faceTarget(shooterToken, aimPoint) {
  const turn = faceTargetTurn(shooterToken, aimPoint);
  if (!turn) return null;
  const doc = shooterToken?.document ?? shooterToken;
  try {
    await doc.update({ rotation: turn.rotation }, { animation: { duration: turn.durationMs } });
  } catch (err) {
    console.warn(`${SCOPE} | face-target turn failed`, err);
    return null;
  }
  return turn;
}

/**
 * How long the LAST round of a payload stays on screen after it leaves the muzzle, in milliseconds.
 * Pure. The longest of the four things one round draws, because they all start together and the round
 * is not finished being looked at until the slowest of them is:
 *   - the muzzle LIGHT envelope (muzzleEnvelopeDurationMs — five frames, 85ms at the reference rate)
 *   - the muzzle SPRITE, trimmed to its opening lance (MUZZLE_SPRITE.endMs, 110ms)
 *   - the SPARK, untrimmed (MUZZLE_SPARK.clipMs, 267ms measured) — but ONLY for a class whose row asks
 *     for it, and as of the 2026-08-08 ruling no shipped class does. Counted per class because a
 *     treatment that is not drawn is not being looked at; the moment a row carries `spark` again that
 *     class's tail grows to cover it with no further edit here.
 *   - the TRACER's end: a travelled one is its crossing time plus its arrival hold (dashMs +
 *     DASH_ARRIVAL_HOLD_MS); a painted one is its own clip (TRACER_CLIP_MS).
 *   - the HIT CONFIRMATION's end, for a class that draws one: it is held back by a travelled tracer's
 *     crossing time and then runs its own clip, so `dashMs + HIT_CONFIRM.clipMs`. On a landing round
 *     this is normally the largest of them and therefore what the whole span resolves to.
 *
 * ⚠ WHAT IS DELIBERATELY NOT IN HERE — user ruling, 2026-08-08: the burst SMOKE and the ember MOTES.
 * They are scene dressing that lingers on purpose (the wisp is asked to live for the whole burst and
 * fade after it), so waiting for them would mean waiting seconds past the point a viewer would say the
 * action was over. "Finished" is the last round's impact/tracer ending, and nothing else.
 */
export function presentationTailMs(weaponClass, ammoKey = null, volley = null, arrivalMs = null) {
  // THE VOLLEY IS ITS OWN WHOLE ANSWER, and returns early rather than joining the max below. That is
  // not a shortcut: when the volley is drawn, the pellet fan is NOT (it replaces it) and the hit mark
  // is NOT (fxShot suppresses it), so folding in a `tracerEnd` and an `impactEnd` for elements this
  // shot does not draw would over-state the wait on exactly the loads that are already the slowest.
  // The term is the band's CONTENT END rather than its file duration — see the VOLLEY block for the
  // decode, and for why a fixed guess opens the window a second early on a long shot.
  if (volley) return Math.max(muzzleEnvelopeDurationMs(), muzzleDwellMs(weaponClass), Number(volley.tailMs) || 0);
  // ⚠ THE OVERLAY IS READ HERE TOO, AND THAT IS NOT OPTIONAL (FR#24). This function used to read
  // FX_CLASSES directly, and an ammo overlay that changes any of its inputs — the dart rows move
  // `dashMs`, the baton row moves it further, a promotion moves the impact's own length — would then be
  // drawn by fxShot and NOT accounted for here. The failure that produces is silent and one-directional:
  // the tail comes back short, the settle floor is short with it, and the apply window opens while the
  // last round is still on screen. Same resolver as the draw path, so the two cannot drift.
  const entry = ammoFxEntry(weaponClass, ammoKey);
  const dash = Number(entry?.dashMs) > 0 ? Number(entry.dashMs) : 0;
  // ⭐ THE IMPACT'S OWN START IS AN INPUT NOW (2026-08-11), and it is PASSED rather than derived: the
  // painted classes' arrival is a property of the shot's LENGTH, and this function is pure and has no
  // way to ask how long the shot was. Both shipping callers resolve it (the fan-out from the canvas it
  // is drawing on, payloadPresentationMs from the same two tokens) and hand it in, so the floor the
  // apply window rests on covers a mark that is now drawn most of a second later than it used to be.
  //   With nothing passed it falls back to the row's own crossing time, which is exactly what this
  // function computed before the arrival existed — so a caller that only has a class and a load still
  // gets the old, travelled-only answer rather than an invented one.
  const travel = (arrivalMs !== null && Number(arrivalMs) >= 0) ? Number(arrivalMs) : dash;
  const spark = entry?.spark ? MUZZLE_SPARK.clipMs : 0;
  // The TRACER's own life is unchanged by any of this — a painted streak lives its clip and a travelled
  // dash lives its crossing plus the hold. It is the impact that moved.
  const tracerEnd = dash > 0 ? dash + DASH_ARRIVAL_HOLD_MS : TRACER_CLIP_MS;
  // The impact term is how long the impact is DRAWN, which for a promoted asset is its trim rather
  // than its own clip — the same field fxShot plays it with (see the impact-promotion rule).
  const impactClipMs = Number(entry?.impactClipMs) > 0 ? Number(entry.impactClipMs) : HIT_CONFIRM.clipMs;
  const impactEnd = Number(entry?.impactSquares) > 0 ? travel + impactClipMs : 0;
  // The lance term is the class's DWELL, not the trim: a row that stretches its lance must be covered
  // by the tail it belongs to. (Every shipped dwell is far under the travelled/impact terms, so this
  // reads the same as before for all five rows — it is written this way so a longer dwell later cannot
  // quietly outlive the signal.)
  //
  // (The discharge column's own term stood here and went with the mechanism on 2026-08-09 — see the
  // deletion block above the class table. The shell's lance dwell is now an ordinary `muzzleDwellMs`
  // term like every other class's, which is one of the things the deletion bought.)
  return Math.max(muzzleEnvelopeDurationMs(), muzzleDwellMs(weaponClass), spark, tracerEnd, impactEnd);
}

/**
 * How long a payload of `shots` rounds of `weaponClass` takes to present, in milliseconds. Pure, so
 * the arithmetic is asserted by value rather than by watching a window.
 *
 * The rounds are spaced by the class's own cadence and the last one still has to finish, so the span
 * is (shots − 1) gaps plus one tail. A single round is one tail, which is the whole span for a
 * semi-automatic shot — small, but not zero, and deliberately not special-cased: a viewer looking at
 * one discharge is looking at something for as long as a viewer looking at the last round of ten.
 *
 * BOUNDED by MAX_FX_SHOTS, the same bound the fan-out itself applies, so a payload claiming a corrupt
 * round count can no more park a wait than it can queue that many rounds.
 */
export function presentationMs(shots, weaponClass, ammoKey = null, volley = null, arrivalMs = null) {
  const n = Math.min(Math.max(Math.trunc(Number(shots) || 0), 1), MAX_FX_SHOTS);
  // The CADENCE is deliberately NOT overlaid: no ammo row carries one and none should. Spacing between
  // rounds is a property of the weapon's action, not of what is in the magazine. The VOLLEY is threaded
  // through for the same reason the ammo key is — it moves the tail, and a floor computed without it
  // would open the window while the last shell's rounds were still crossing.
  return (n - 1) * classCadenceMs(weaponClass) + presentationTailMs(weaponClass, ammoKey, volley, arrivalMs);
}

/**
 * How long THIS payload's presentation runs on screen, in milliseconds — the number a caller waits out
 * before putting a window over the canvas. Resolves the class the way the fan-out does, then defers to
 * the pure arithmetic above.
 *
 * ZERO means "nothing is being presented, do not wait": the rail is switched off, or the fired weapon
 * resolves to no FX class at all (melee, an unmapped type, a payload carrying no weapon). It does NOT
 * depend on the optional effect engine — the muzzle light and the cadence are native and run whether or
 * not any sprite module is installed, so a client without one still has a presentation to wait out.
 */
export function payloadPresentationMs(payload) {
  if (!combatFxEnabled()) return 0;
  const actor = payload?.attackerId ? game.actors?.get(payload.attackerId) : null;
  const weaponClass = weaponFxClass(resolveFiredWeapon(payload, actor));
  if (!weaponClass) return 0;
  // A ruled fumble draws nothing (see the bail in fxWeaponFired), so there is no presentation to wait
  // out. Kept in step with the fan-out deliberately: the two are read by the same callers, and a span
  // reported for a shot that is never drawn would park a window for a second over an empty canvas.
  if (payload?.fumbleRuled) return 0;
  // The LEAD-IN. When the shooter turns first, the rounds do not start until the turn finishes, so
  // the span a caller waits out has to include it — otherwise the apply window would open a turn's
  // worth of time early, which is the whole thing the wait exists to prevent. Read from the same
  // helper the fan-out uses, so a shot that will not turn adds nothing.
  const shooter = shooterTokenForPayload(payload, actor);
  const aimTokenId = payload?.targetTokenId ?? payload?.fxTargetTokenId ?? null;
  const target = aimTokenId ? (canvas?.tokens?.get(aimTokenId) ?? null) : null;
  const gridPx = Number(canvas?.dimensions?.size) || 100;
  const leadIn = shooter ? (faceTargetTurn(shooter, payloadAimPoint(payload, shooter, target, gridPx))?.durationMs ?? 0) : 0;
  // The loaded round's overlay, resolved from the payload the same way the fan-out resolves it, so the
  // arithmetic fallback and the fan-out's own floor agree about a round whose overlay moves the tail.
  // THE VOLLEY the same way, and off the same distance the fan-out will measure — a buckshot payload's
  // tail is a property of its RANGE, so this resolver has to look at the canvas exactly once to find
  // it. With no shooter or no aim there is no distance to band, and the volley term falls away with the
  // shot it belonged to.
  // ⚠ AND IT ASKS THE LOAD THE SAME THIRD QUESTION THE FAN-OUT ASKS (2026-08-10): a load that draws its
  // own projectile is not drawn as a volley, so its tail is its own row's — computing a volley band here
  // for a shot the fan-out will draw as a dart fan would hold the window shut for a second the shot does
  // not spend. Same resolver, same call, so the two cannot drift (the rule at presentationTailMs).
  const key = ammoFxKeyOf(payload);
  const squares = payloadAimSquares(shooter, target, gridPx, payload);
  const volley = volleyOwns(payload) && !ammoRedefinesProjectile(key) ? volleySpecFor(squares) : null;
  // ⭐ AND THE ARRIVAL, resolved off the same distance the fan-out will measure and by the same call, so
  // the floor this arithmetic hands a caller and the floor the fan-out watches out cannot disagree about
  // when the last round's mark starts. A painted round's mark now begins most of a second into the
  // presentation on a long shot, and a window computed without that term would open over it.
  return leadIn + presentationMs(shotCountOf(payload), weaponClass, key, volley,
    arrivalSpecFor(weaponClass, key, squares, volley).ms);
}

/**
 * How many grid squares the shot spans, from the shooter to what it was pointed at. Impure only in that
 * it reads the canvas grid; the arithmetic is the same one the fan-out does, factored out so the tail
 * resolver and the draw path band a shot identically.
 */
export function payloadAimSquares(shooterToken, targetToken, gridPx = 100, payload = null) {
  const from = shooterToken ? centerOf(shooterToken) : null;
  // With a payload in hand the declared corridor answers first (payloadAimPoint); without one this is
  // exactly what it always was. The distance is what bands the shot, so a corridor aimed short of a
  // target — or past it — has to band on the corridor and not on the target.
  const to = from ? payloadAimPoint(payload, shooterToken, targetToken, gridPx) : null;
  if (!from || !to) return 0;
  return Math.hypot(to.x - from.x, to.y - from.y) / (Number(gridPx) || 100);
}

/* ══════════════════════════ The completion signal ══════════════════════════ */

/**
 * Payloads whose fan-out is in flight, each holding the promise that resolves when THAT payload's
 * action has finished. Keyed by the payload object itself — the same object reaches every listener of
 * one emission, so identity is the join between the rail and whoever is waiting on it, with no id to
 * invent and nothing to collide.
 *
 * WHY A SIGNAL RATHER THAN MORE ARITHMETIC. The rail is the thing that queues the durations, so it is
 * the only honest source for "is it over". A caller reproducing the sum has to be re-derived every
 * time a cadence, a hold or a clip is tuned, and it silently drifts when it is not. The arithmetic
 * survives only as the fallback for the cases where there IS no fan-out to ask.
 */
const _settlements = new Map();

/**
 * Terminal-element watches, keyed by the name stamped on the last round's tracer and impact.
 *
 * ⚠ WHY THE ENGINE IS ASKED RATHER THAN THE CLOCK. The first build of this signal resolved on the
 * SCHEDULED tail — the sum of the durations the rail asked for. The engine does not honour those
 * exactly: it keeps an effect alive past its nominal time (the same class of finding as the trimmed
 * lance that measured 861ms against a 110ms trim). Measured on this rig, last observed effect end
 * against the scheduled tail: RIFLE 1022ms vs 933ms (+89ms), SHELL 1045ms vs 983ms (+62ms). That
 * overhang is small but it is exactly the remainder the report was about — the window opening while
 * the impact's last frames are still on screen. So the terminal elements are NAMED when they are
 * queued and the engine's own `endedSequencerEffect` is what resolves the wait.
 *
 * The scheduled tail is kept as the FLOOR (never resolve early if an effect fails to spawn and ends
 * at once) and as the fallback when nothing was created at all — an engine that is absent, or an asset
 * the installed tier does not carry. PRESENTATION_CAP_MS still races the whole thing.
 */
const _tagWatches = new Map();

/** Settle a tag's watch if its terminal elements have all ended and no new ones are still arriving. */
function _maybeSettleTag(tag) {
  const w = _tagWatches.get(tag);
  if (!w || w.done || w.created === 0 || w.ended < w.created) return;
  // A short confirm window: the round's effects are queued together but they do not all spawn in the
  // same tick (a delayed impact spawns after its tracer), so "all ended" is only final once nothing
  // new has appeared for a beat.
  clearTimeout(w.confirm);
  w.confirm = setTimeout(() => {
    if (w.done || w.ended < w.created) return;
    _finishTag(tag, "engine");
  }, SETTLE_CONFIRM_MS);
}

/** Resolve a tag's watch, never before the scheduled floor, and drop it. */
function _finishTag(tag, via) {
  const w = _tagWatches.get(tag);
  if (!w || w.done) return;
  // The rule: open at max(scheduled floor, engine end − lead). Measured from when the engine actually
  // reported the last element gone, NOT from now — by the time this runs the confirm window has
  // already been spent, and the lead is what gives that back.
  const engineElapsed = (w.lastEndAt ?? Date.now()) - w.startedAt;
  const openAt = via === "engine" ? settleOpenAtMs(w.scheduledMs, engineElapsed) : w.scheduledMs;
  const wait = Math.max(0, openAt - (Date.now() - w.startedAt));
  const finish = () => {
    if (w.done) return;
    w.done = true;
    clearTimeout(w.confirm); clearTimeout(w.floor); clearTimeout(w.cap);
    _tagWatches.delete(tag);
    w.settle({ via, ms: Math.max(openAt, Date.now() - w.startedAt),
               scheduledMs: w.scheduledMs, engineMs: engineElapsed, openAt,
               created: w.created, ended: w.ended });
  };
  if (wait > 0) w.floor = setTimeout(finish, wait);
  else finish();
}

/** How long "all ended" has to hold before it is believed, in milliseconds. */
export const SETTLE_CONFIRM_MS = 60;

/**
 * How far AHEAD of the engine's report the apply window is allowed to open, in milliseconds.
 *
 * Reported as "slightly sluggish": waiting for the engine to say the last element is gone is correct
 * in principle but lands a hair after the moment a viewer has already called it over — the final
 * frames of an impact are nearly transparent, so the eye finishes before the engine does. This is the
 * knob that trims that.
 *
 * ⚠ WHAT IT CAN AND CANNOT DO, stated plainly because the arithmetic is not obvious. The rule is
 * `open at max(scheduled_end, engine_end − lead)`, and it is evaluated WHEN THE ENGINE REPORTS —
 * nothing can know the engine's end before it happens. So the lead cannot rewind past that moment; it
 * spends itself on the wait we were still ABOUT to add (the confirm window, and any remainder of the
 * scheduled floor). Measured against the previous build that is roughly the confirm window's worth.
 * The floor is deliberately still the floor: the lead may never drag the open before the scheduled
 * end, which is the guard that stopped the window opening early when the engine is slow to report.
 */
export const APPLY_LEAD_MS = 150;

/**
 * When the apply window may open, in ms from the fan-out's own start. Pure, so both halves of the rule
 * — the lead and the floor that overrides it — are asserted by value rather than by watching a window.
 */
export function settleOpenAtMs(scheduledMs, engineElapsedMs) {
  return Math.max(Number(scheduledMs) || 0, (Number(engineElapsedMs) || 0) - APPLY_LEAD_MS);
}

/** Begin watching a round's named terminal elements. */
function _watchSettleTag(tag, scheduledMs, settle) {
  const w = { created: 0, ended: 0, done: false, startedAt: Date.now(), scheduledMs, settle, confirm: null, floor: null, cap: null };
  _tagWatches.set(tag, w);
  // Nothing named ever appeared by the time the schedule says it should be over → there was nothing to
  // observe (no engine, or no asset), so the arithmetic stands in.
  setTimeout(() => {
    if (!w.done && w.created === 0) _finishTag(tag, "scheduled");
  }, scheduledMs);
  // ⭐ THE HARD STOP (2026-08-09), and it closes a real leak rather than a theoretical one. The two
  // exits above both require a COUNT to be right: the scheduled fallback only fires when nothing was
  // created, and the engine exit only fires when `ended` catches `created`. A watch whose elements were
  // created but never all reported gone satisfies NEITHER and used to sit in these maps for the rest of
  // the session. Measured on the rig: five overlapping 30-round fan-outs left 2 of 5 watches unresolved
  // and still holding their payloads fifteen seconds after everything had left the screen.
  //
  // The apply window itself was never at risk — presentationSettled races PRESENTATION_CAP_MS, so a
  // caller always got an answer — but the bookkeeping grew without bound, which is exactly the sort of
  // slow accumulation a long session turns into a problem. Resolving on the SAME cap the window
  // already honours means this can never change what a caller observes: by the time it fires, any
  // waiter has already taken the capped answer. It only guarantees the entries are dropped.
  w.cap = setTimeout(() => { if (!w.done) _finishTag(tag, "cap"); }, PRESENTATION_CAP_MS);
}

/** Arm the signal for a payload about to be fanned out. Returns the resolver the fan-out will call. */
function _armSettlement(payload) {
  if (!payload || typeof payload !== "object") return () => {};
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  const entry = { promise, resolve, done: false };
  _settlements.set(payload, entry);
  return (info) => {
    if (entry.done) return;
    entry.done = true;
    entry.resolve(info);
    // Dropped once settled: the map holds only what is in flight, so nothing accumulates across a
    // session however many rounds are fired.
    _settlements.delete(payload);
  };
}

/**
 * Resolves when THIS payload's action has finished on screen — the last round's impact/tracer ending,
 * per the 2026-08-08 ruling (burst smoke and ember motes excluded; they are dressing and they linger).
 *
 * Reports HOW it resolved, so a caller and the keeper can tell the three routes apart rather than
 * inferring them from timing:
 *   "signal"     — the fan-out reported its own completion. The normal path.
 *   "arithmetic" — no fan-out registered for this payload, so the pure span stands in. That is the
 *                  rail being switched off, a weapon with no mapped class, or an emission nothing drew.
 *   "cap"        — the signal did not arrive inside PRESENTATION_CAP_MS and the wait was cut short.
 *
 * ⚠ LISTENER ORDER IS NOT ASSUMED. The fx fan-out and the damage handler are independent listeners on
 * the same hook and nothing sequences them, so a caller can reach this before the rail has armed
 * anything. Rather than depend on registration order, this yields a few microtasks first and only then
 * decides it is on the arithmetic path — the fan-out arms synchronously as its first act, so a turn of
 * the microtask queue is enough for a rail that is going to run at all.
 */
export async function presentationSettled(payload) {
  for (let i = 0; i < 8 && !_settlements.has(payload); i++) await Promise.resolve();
  const entry = _settlements.get(payload);
  if (!entry) return { via: "arithmetic", ms: payloadPresentationMs(payload) };
  let capped;
  const cap = new Promise((r) => { capped = setTimeout(() => r({ via: "cap", ms: PRESENTATION_CAP_MS }), PRESENTATION_CAP_MS); });
  const outcome = await Promise.race([entry.promise, cap]);
  clearTimeout(capped);
  return outcome;
}

/** How many payloads are in flight right now. Read by the keeper; also the leak check. */
export function settlementsInFlight() {
  return _settlements.size;
}

/**
 * Fan one weaponFired payload out into per-shot effects at the FIRED CLASS's cadence (classCadenceMs
 * — the measured default, or the class's own where the table names one). The returned `cadenceMs` is
 * the value this payload actually ran at, so the pacing is reportable rather than assumed.
 *
 * Hit/miss is per shot in the reference, and the payload knows only HOW MANY rounds hit (not which),
 * so the hits are assigned to the leading shots of the burst — the per-shot divergence a viewer sees
 * is preserved without inventing an ordering the payload does not carry.
 *
 * Returns a plain result object (counts + the resolved class) rather than nothing, so the rig keeper
 * asserts the fan-out by value instead of by wall-clock observation.
 */
export async function fxWeaponFired(payload) {
  const result = { shots: 0, hits: 0, flashes: 0, motes: 0, smokePuffs: 0, turnedDeg: null, weaponClass: null, cadenceMs: SHOT_CADENCE_MS, skipped: null, ammoKey: null, groundFire: null, blood: null, volley: null, arrival: null, impacts: null, dropped: 0, maxLagMs: 0, loopMs: 0 };
  if (!combatFxEnabled()) return { ...result, skipped: "disabled" };
  const actor = payload?.attackerId ? game.actors?.get(payload.attackerId) : null;
  const weapon = resolveFiredWeapon(payload, actor);
  const weaponClass = weaponFxClass(weapon);
  if (!weaponClass) return { ...result, skipped: "class" };

  // A RULED FUMBLE DRAWS NOTHING. Reported from the table: a fumbled shotgun still threw a full muzzle
  // blast down-range — "if the shotgun didn't fire, it shouldn't blast visibly."
  //
  // WHY THE ROUND COUNT COULD NOT CATCH IT (measured on the rig, not assumed): the base computes
  // `roundsFired` BEFORE it consults the fumble ruling, so the card reports `fired: 1` on a fumble
  // whatever the outcome was, and shotCountOf reads exactly that. Every fumble the table rules on also
  // sets `forceMiss`, so the card comes through as one round fired, zero hits — which is indistinguishable
  // from an ordinary miss by count alone. Hence the seam forwards the base's own ruling as its own
  // field, and this is the one thing that can tell them apart. See the note at the emit in seam-shim.js
  // for why the plain natural-1 field is NOT the right gate: with the fumble table switched off a
  // natural 1 is an ordinary bad roll and the weapon really did fire.
  //
  // EVERYTHING goes with it, not just the sprite: the flash, the muzzle sprite, the tracers/pellets,
  // the impacts, the burst ambience AND the report — the shot's audio is played from inside the loop
  // below, so returning here is what silences it too. (The audio was NOT separately broken: the
  // reproduction played shot-shotgun.ogg for the fumbled shot like any other. Nothing is left as a
  // stand-in — a misfire click would need a sound this library does not carry, recorded as an earmark.)
  //
  // Placed with the other bail-outs, ahead of _armSettlement, for the reason stated there: a
  // payload this rail will not draw must fall to the arithmetic rather than leave a caller waiting on
  // a promise nobody will resolve.
  if (payload?.fumbleRuled) return { ...result, weaponClass, skipped: "fumble" };

  // WHICH LOAD IS IN THE GUN — resolved ONCE, here, with the payload in hand, and threaded into every
  // verb below. It cannot be resolved further down: fxShot and the tail arithmetic never see a payload,
  // so a key resolved there would have to be invented. See ammoFxKeyOf for id-first / fingerprint.
  const ammoKey = ammoFxKeyOf(payload);
  const ammoEntry = ammoFxEntry(weaponClass, ammoKey);

  const shots = shotCountOf(payload);
  const hits = Math.min(hitCountOf(payload), shots);
  // WHICH FIGURE FIRED — the payload's own answer where it has one, so two figures of one actor draw
  // their own shots (see shooterTokenForPayload). The arithmetic above resolves it the same way, so
  // the window a caller waits out is measured from the same figure this draws from.
  const shooter = shooterTokenForPayload(payload, actor);

  // ⭐ NOBODY ON THE MAP TO FIRE FROM (2026-08-10) — the fourth deliberate non-draw, and it says so in
  // `skipped` like the other three. Every verb below is `if (shooter)`-gated already, so a sheet-fire by
  // an actor with no token placed anywhere ran the whole fan-out to draw nothing: no flash, no sprite,
  // no report, and — because nothing was `skipped` — a presentation canary that woke up four seconds
  // later and told the table their module was faulty (review finding F1a). Firing from a sheet with no
  // token down is ordinary play, so the honest report is "there was no shooter", not a defect notice.
  // The silence it also buys is deliberate: the shot's audio is played from inside the loop, so a
  // token-less fire no longer makes a report from nowhere either.
  // Placed AFTER the load and the counts are resolved, so the result still says what was fired and how
  // many rounds — a bail is a report, not a blank — and BEFORE _armSettlement, with the other bails.
  if (!shooter) return { ...result, weaponClass, ammoKey, shots, hits, skipped: "shooter" };

  // ARM THE COMPLETION SIGNAL, and do it here — after the bail-outs above and before the first
  // await. After, because a payload this rail is not going to draw must fall to the arithmetic rather
  // than wait on a promise nobody will resolve; before, because a caller listening to the same hook
  // may reach presentationSettled() in the same turn and must find the arming already done.
  const settle = _armSettlement(payload);
  // The name stamped on the last round's terminal elements, unique per fan-out so two shots in flight
  // never observe each other's endings.
  const settleTag = `${SCOPE}.settle.${foundry.utils.randomID()}`;

  // Read once, so the audio, the pellet fan and the flash restart of every round of this payload are
  // paced by the same number — there is one wait in the loop and everything a round does happens after
  // it. A class that names no cadence of its own gets the default (classCadenceMs).
  const cadenceMs = classCadenceMs(weaponClass);
  // Aim for the sprite/tracer. The payload carries the aimed-at token in two places because they mean
  // two different things (see the note at the emit in seam-shim.js): `targetTokenId` is the field the
  // DAMAGE flow routes on, set only where the fire card resolved a target itself; `fxTargetTokenId` is
  // the aim captured for presentation on every fire mode, including the ones deliberately kept off the
  // mid-action damage dialog. Either one answers "which way was this pointed", so read the routing field
  // first (it is the card's own resolved target) and fall back to the presentation one. A payload
  // carrying NEITHER is not a special case any more: the verbs below resolve the axis from the
  // shooter's own facing instead (aimPointOf), so the same effects are drawn either way.
  const aimTokenId = payload?.targetTokenId ?? payload?.fxTargetTokenId ?? null;
  const target = aimTokenId ? (canvas?.tokens?.get(aimTokenId) ?? null) : null;

  // THE BUCKSHOT VOLLEY, resolved ONCE for the whole payload (2026-08-09, ON TRIAL — see the VOLLEY
  // block). Two questions, both answered here and neither answerable further down: whether this
  // cartridge is buckshot (volleyOwns, asked of the round exactly as patternFlowOwns asks the flow) and
  // which distance band the engine will serve, which needs the canvas and the aim. Null on every other
  // load, and null with the trial switched off, so everything downstream is a fall-through.
  //
  // ⭐ AND A THIRD QUESTION, ASKED OF THE LOAD (2026-08-10): does the round in the gun draw ITSELF? The
  // cartridge question above is about the caliber, and a stun-dart or baton 00 shell is buckshot by
  // caliber while being a fan of needles or a single blunt slug by picture. A branch that replaces the
  // round may not replace one the table has already described — see ammoRedefinesProjectile, where the
  // rule is written against the overlay table rather than against a list of load names.
  const gridSizePx = Number(canvas?.dimensions?.size) || 100;
  // ⭐ WHERE THIS SHOT IS POINTED, RESOLVED ONCE FOR THE WHOLE PAYLOAD (2026-08-11) and threaded into
  // every verb below — the turn, the ambience, the smoke, the burning ground, each round's draw and the
  // hit marks. It was resolved four times from the same two tokens before, which was harmless only
  // while there was one possible answer. There are two now: a spread weapon is AIMED before it is
  // declared (combat/spread-placement.js), and its corridor is a statement by the shooter that a target
  // token cannot be asked for — the shot may be aimed short of a figure, past it, or at open ground.
  // One derivation is what stops the rounds crossing one line while the pattern is planted on another.
  const aim = payloadAimPoint(payload, shooter, target, gridSizePx);
  const aimSquares = payloadAimSquares(shooter, target, gridSizePx, payload);
  const volley = volleyOwns(payload) && shooter && !ammoRedefinesProjectile(ammoKey)
    ? volleySpecFor(aimSquares) : null;
  // WHEN THIS ROUND ARRIVES — the one clock every delayed element of the shot is hung on: the hit mark,
  // the pellet arrival marks, the blood spray and the burning ground. Resolved ONCE, here, and threaded
  // into every verb below and into the tail floor, so nothing on one shot can disagree with anything
  // else about when the round got there.
  //
  // ⏪ IT USED TO BE `dashMs, or zero` (2026-08-11). Zero was the answer for the four PAINTED classes,
  // which is why their impacts and their blood played at the muzzle — the reported defect. The painted
  // arrival is a measured band crossing now; see arrivalSpecFor for the three shapes and
  // TRACER_ARRIVAL_MS for the decode.
  const arrival = arrivalSpecFor(weaponClass, ammoKey, aimSquares, volley);
  const arrivalMs = arrival.ms;

  // ONE round's seed, built in ONE place. Attacker, weapon, the two counts, the ROUND INDEX and the
  // rolled damage — identity plus per-event entropy, which is the rule this file follows everywhere it
  // seeds (see the entropy note at the VOLLEY block and the burning-ground seed above). Hoisted on
  // 2026-08-11 because a second reader appeared: the burning ground now takes the FIRST round's pellet
  // jitter, and two copies of this expression are how the flames and the pellets drift apart.
  const shotSeedFor = (i) => fxSeedOf(payload?.attackerId, payload?.weaponId, shots, hits, i,
    JSON.stringify(payload?.areaDamages ?? {}));

  // One payload = one resolved burst, so whether this is a MULTI-round payload is known before the
  // first round goes out and holds for all of them — every round of one burst gets the same asset,
  // rather than the first sounding different from the rest.
  const burst = shots > 1;

  // Turn to face the target FIRST, and wait for the turn: the muzzle, the wedge and the tracer all
  // take their axis from the aim, so a token that is still swinging round when the first round goes
  // would be drawn firing sideways out of its own portrait. The wait is short by spec and it is
  // included in payloadPresentationMs, so the apply window still lands after everything.
  const turn = shooter ? await faceTarget(shooter, aim) : null;

  // The multi-round-only treatments, queued once for the whole burst before the first round leaves.
  // A single shot never reaches this line, which is the whole gate (see fxBurstAmbience).
  let ambience = { motes: 0 };
  if (burst && shooter) {
    ambience = await fxBurstAmbience(shooter, target, { weaponClass, shots, cadenceMs, aimPoint: aim })
      .catch((err) => { console.warn(`${SCOPE} | burst ambience failed`, err); return { motes: 0 }; });
  }

  // THE INCENDIARY GROUND ELEMENTS — ONE placement event for the whole payload, producing N flames at
  // the points the rounds landed, and only when a round LANDED (a burst that misses sets nothing
  // alight). Placed here, outside the round loop, deliberately: the loop is what would make this
  // per-ROUND, so keeping the call out of it IS the once-per-payload gate (the same shape as
  // fxBurstAmbience above), and `maxPerPayload` bounds what the one placement may draw. Held back by
  // the class's own crossing time so the fires start when the rounds arrive. Not awaited — it must
  // never delay the first round.
  //
  // ⭐ A PATTERN PAYLOAD IS NOT DRAWN HERE, and the gate is the same call the damage rail makes
  // (spreadModeForAmmo — damage-hooks.js asks it twice and this is the third site of the identical
  // question, not a fourth question). A shell that throws the p.108 pattern did not land its shot on
  // the target: the rules put it across the whole path, so its fires belong to that path and are
  // placed by the flow that owns the geometry, when the GM confirms it (fxPatternGroundFire). Drawing
  // both would set the same shot alight twice.
  let groundFire = null;
  if (shooter && hits > 0 && ammoEntry?.groundFire && !patternFlowOwns(payload)) {
    const gridPx = Number(canvas?.dimensions?.size) || 100;
    const at = aim;
    const from = centerOf(shooter);
    if (at && from) {
      // Seeded off the payload, so the scatter is a property of the shot rather than of which client
      // happened to compute it — see seededRng. The damage numbers are folded in so two identical
      // bursts do not stamp the same picture twice.
      const seed = fxSeedOf(payload?.attackerId, payload?.weaponId, shots, hits,
        Math.round(at.x), Math.round(at.y), JSON.stringify(payload?.areaDamages ?? {}));
      const pts = groundFirePoints(from, at, {
        landed: hits, pellets: ammoEntry.pellets, spreadRad: ammoEntry.spreadRad,
        scatterPx: GROUND_FIRE.scatterSquares * gridPx, max: GROUND_FIRE.maxPerPayload, seed,
        // The FIRST round's own pellet jitter, so the flames sit where that round's pellets actually
        // went rather than on the even ladder they no longer fly. Same helper, same seed the draw uses.
        jitter: pelletJitterFor(shotSeedFor(0), Math.trunc(ammoEntry.pellets) || 0, ammoEntry.spreadRad),
      });
      if (pts.length) {
        groundFire = { queued: true, seed, points: pts.length, at: pts.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })) };
        fxGroundFire(pts, { delayMs: arrivalMs })
          .catch((err) => console.warn(`${SCOPE} | ground fire failed`, err));
      }
    }
  }

  // THE BLOOD SPLASH — its gates resolved ONCE here, its draws issued PER LANDING ROUND from inside
  // the loop below. ⏪ REBUILT 2026-08-09: the once-per-payload rule this block used to enforce is
  // dead (user, on the MPK-9 burst — a ten-round burst marked its target once, which read as one
  // wound however many rounds went in). The gates themselves are unchanged and still all in one place:
  //  1. the world setting, read per shot so a GM switching it takes effect with no reload;
  //  2. a round LANDED — a burst that misses draws nothing (the ruled fumble is already gone, several
  //     lines above, so nothing here has to know about it);
  //  3. a TARGET TOKEN, not an aim point: blood needs a body, and an untargeted shot has none;
  //  4. that token's actor is not STRUCTURE (bearsStructuralSdp — vehicles, powered armour and full
  //     conversions), which is where the actor-level limit of the phase-1 answer is documented.
  // What CHANGED is only how many times the draw is issued and when: once per landing round, on that
  // round's own visual-impact clock, bounded by BLOOD_SPLATTER.maxPerPayload. Still never awaited and
  // still never tagged, so it can neither delay a round nor hold the damage window.
  const bleeds = goreEnabled() && hits > 0 && !!target && !bearsStructuralSdp(target.actor);
  let blood = bleeds ? { queued: 0, key: BLOOD_SPLATTER.key, squares: BLOOD_SPLATTER.squares,
    tokenId: target.id, cap: BLOOD_SPLATTER.maxPerPayload } : null;

  // THE IMPACT TALLY — how many of this payload's landing rounds have had their arrival marked, drawn
  // and refused rounds counted together, against the bound at HIT_MARK_MAX_PER_PAYLOAD. Reported by
  // value: "an N-round burst with M hits marks M arrivals" is the ruling, and this is the number that
  // says whether it held.
  const impacts = { queued: 0, refused: 0, cap: HIT_MARK_MAX_PER_PAYLOAD };
  let flashes = 0;
  let smokePuffs = 0;
  // ⏪ INVERTED (FR#22). This gate used to read "a burst always smokes"; it now reads the opposite. Our
  // puffs are drawn ONLY for a single discharge of a class whose row opts in — today just the shell.
  // A burst gets its smoke from the tracer asset's own curls instead (see the retirement note on
  // smokePlanFor), so drawing ours over it was doubling a smoke that was already there.
  const smokes = !burst && smokesOnSingleShot(weaponClass);
  // THE ANCHOR. Every round's due time is measured from this one instant (roundDueAtMs), so a round
  // that starts late cannot push the rounds after it — see FX_DROP_LAG_FRACTION for the measurement that
  // made this necessary and for why the loop may not trust its own sleep.
  const loopStart = Date.now();
  let dropped = 0;
  let maxLagMs = 0;
  for (let i = 0; i < shots; i++) {
    // Sleep the REMAINDER to this round's slot, not a fixed interval. A round already past its slot
    // waits not at all and is dealt with by the drop rule below.
    if (i > 0) {
      const wait = roundDueAtMs(loopStart, i, cadenceMs) - Date.now();
      if (wait > 0) await _sleep(wait);
    }
    // How far behind its own slot this round actually is, measured at the moment it would be issued.
    const lagMs = Date.now() - roundDueAtMs(loopStart, i, cadenceMs);
    if (lagMs > maxLagMs) maxLagMs = lagMs;
    const isLast = i === shots - 1;
    // ⭐ THE DROP, and it takes the WHOLE round — its audio with its picture. The first build of this
    // rule kept the audio and refused only the sprites, on the reading that the ear should still get
    // every round; the rig refused that reading by measurement. Because a starved loop reaches several
    // rounds' slots at once, keeping the audio put two and three shots' worth of it in a SINGLE tick
    // (measured gaps of 231, 0, 235, 0 ms across a five-round burst) — which is not a burst that fires
    // faster, it is two reports landing on top of each other. Dropping the round outright leaves the
    // rounds that DO play sitting on their own slots, so the burst keeps its rhythm at the cost of a
    // round rather than losing the rhythm to keep one. That is what the ruling's reason says out loud:
    // the audio already told the ear the story, so one more report is what there is least need of.
    const refused = roundDropped({ lagMs, isLast, dropLagMs: dropLagMsFor(cadenceMs) });
    // ⭐⭐ THE IMPACT FAMILY IS NOT ON THE TRACER'S BUDGET (user ruling 2026-08-11: *"hits late in a long
    // burst get NO blood at all"*). The pacing rule above refuses a late round's PICTURE AND ITS REPORT,
    // and it is right to — but it was also refusing the round's ARRIVAL, and those are two different
    // costs. A tracer is a sprite per pellet drawn from the muzzle every cadence slot and it is what
    // creates the backlog the rule exists to hold down; a hit mark and a blood spray are one sprite each,
    // at the far end of the shot, and they are the only thing that says the round landed on somebody. So
    // this block sits ABOVE the drop rather than inside the branch below it, and a round that HIT gets
    // its impact family whether or not its tracer was drawn. See fxHitMark for the ruling in full.
    //
    // The remaining lateness comes OFF the arrival, so a round already 200ms behind its slot puts its
    // mark up 200ms sooner and lands on the canvas alongside the rounds that were drawn on time.
    const arriveIn = Math.max(0, arrivalMs - lagMs);
    // What a LANDING round owes at the far end of the shot, issued from one place so the drawn round
    // and the refused one cannot drift. `issueMark` is false for a round that is being drawn: fxShot
    // puts the mark in the same Sequence as that round's tracer, and a second one here would be two
    // marks on one square.
    const markAndBleed = (issueMark) => {
      if (impacts.queued < HIT_MARK_MAX_PER_PAYLOAD) {
        impacts.queued++;
        if (issueMark) {
          impacts.refused++;
          fxHitMark(shooter, target, { weaponClass, ammoKey, delayMs: arriveIn, aimPoint: aim })
            .catch((err) => console.warn(`${SCOPE} | hit mark failed`, err));
        }
      }
      // ⏫ MOVED OUT OF THE DRAW BRANCH with the mark, and for the same reason — this is where the "no
      // blood at all" half of the report was coming from. The gates and the cap are unchanged.
      if (blood && blood.queued < BLOOD_SPLATTER.maxPerPayload) {
        blood.queued++;
        fxBloodSplatter(shooter, target, { delayMs: arriveIn })
          .catch((err) => console.warn(`${SCOPE} | blood splash failed`, err));
      }
    };
    if (refused) {
      dropped++;
      if (shooter && i < hits) markAndBleed(true);
      continue;
    }
    sfx(weaponClass, { burst });
    // Flash + sprite + tracer all start in the SAME tick as this shot's audio, and none of them is
    // awaited: the loop's timer is the cadence a viewer and a listener both read. Every round of a
    // burst announces its own flash — the per-token cap that keeps that bounded lives in the local
    // runner (one source set per token, each round restarting the envelope), not here, so a round is
    // never silently dropped on the way out.
    // THE SINGLE DISCHARGE'S PUFF. What is left of the smoke system after FR#22: one puff, for one
    // round, on a class that asks for it. Not awaited — it must never delay its own round.
    if (shooter && smokes) {
      // Counted on EMISSION, not on the promise: this is async and fire-and-forget, so its return is a
      // promise and would always look truthy. The count is what the stride asked for, which is the
      // number the arithmetic (smokePlanFor) predicts and the keeper asserts against.
      fxSmokePuff(shooter, target, { weaponClass, index: smokePuffs, aimPoint: aim })
        .catch((err) => console.warn(`${SCOPE} | smoke puff failed`, err));
      smokePuffs++;
    }
    if (shooter) {
      flashes++;
      // Only the LAST round is tagged: the ruling is that the action is over when the last round's
      // impact/tracer ends, and those are the latest-ending elements on screen by construction.
      // THE ROUND INDEX RIDES THE SEED, and that is what makes a burst's shells differ from each other
      // rather than being three copies of one jittered volley (see the VOLLEY block's chaos note). It
      // is folded in beside the payload's own fields, so the agreement between clients is a property of
      // the shot and the round rather than of who drew it.
      // ⭐ AND THE ROLLED DAMAGE WITH IT, which is what makes two separate TRIGGER PULLS differ rather
      // than only two rounds of one burst — the identity fields are identical across repeat shots. Same
      // term, same position, as the burning-ground seed above; see the VOLLEY block's chaos note.
      // THE ARRIVAL IS HANDED DOWN rather than re-derived: one derivation per payload, so this round's
      // mark and this round's spray (issued above) are hung on the identical number.
      fxShot(shooter, target, { weaponClass, hit: i < hits, settleTag: isLast ? settleTag : null, ammoKey,
        volley, arrivalMs, shotSeed: shotSeedFor(i), aimPoint: aim })
        .catch((err) => console.warn(`${SCOPE} | combat fx shot failed`, err));
      // ⭐ ONE SPRAY PER LANDING ROUND, on THIS round's own visual-impact clock, and the mark counted
      // against the same budget the refused rounds draw from. The hits are the LEADING rounds of the
      // burst (the same assignment fxShot's `hit` argument uses one line above), so `i < hits` is the
      // round that landed. Issued AFTER the round's own sequence so the ordering on the wire reads the
      // way the shot does.
      if (i < hits) markAndBleed(false);
    }
  }
  // The last round has left the muzzle; what remains on screen is its terminal elements. The watch is
  // started from HERE rather than computed from the start, so the cadence gaps and the face-target
  // sweep are already spent and cannot be double-counted — whatever the loop actually cost, real time
  // has passed and only the tail is left. What ENDS the wait is the engine reporting those elements
  // gone; the scheduled tail is only the floor and the no-engine fallback.
  // The floor takes the AMMO KEY, so an overlay that lengthens the tail (flechette's crossing time, a
  // promoted impact's own trim) is waited out rather than being drawn past a window that already opened.
  // ⭐ AND THE RESOLVED ARRIVAL WITH IT (2026-08-11) — the mark is drawn `arrivalMs` after its round
  // now, so a floor computed without that term would open the apply window while the last round's own
  // confirmation was still coming. Same number the draws were hung on, handed to the same resolver.
  const settleTailMs = presentationTailMs(weaponClass, ammoKey, volley, arrivalMs);
  _watchSettleTag(settleTag, settleTailMs, settle);

  return { ...result, shots, hits, flashes, weaponClass, cadenceMs, motes: ambience.motes, smokePuffs,
    turnedDeg: turn ? turn.deltaDeg : null, settleTailMs, ammoKey, groundFire, blood, volley,
    // The arrival clock, by value, with WHICH of the three shapes answered — see arrivalSpecFor.
    arrival, impacts,
    // WHERE THIS PAYLOAD WAS POINTED, reported rather than inferred — the point every element above
    // was drawn along, the distance that banded it, and whether the shooter DECLARED that corridor
    // (combat/spread-placement.js) or it was read off the aimed-at token. Reported for the same reason
    // the pacing is: an axis that can only be checked by looking at the canvas is an axis nothing can
    // assert, and the shot pattern's whole flow now turns on the rounds and the planted region agreeing
    // about it.
    aim: aim ? { x: aim.x, y: aim.y } : null,
    aimSquares,
    aimDeclared: !!declaredAimPointOf(payload, shooter),
    // The pacing report, by value: how many rounds' pictures were refused and the worst lateness seen.
    // `loopMs` against `(shots-1) × cadence` is the drift the anchored schedule exists to hold down.
    dropped, maxLagMs, loopMs: Date.now() - loopStart };
}

/* ══════════════════════════ Wiring ══════════════════════════ */

// Every effect the engine has reported creating on this client, ever. A counter, not a list: the only
// question asked of it is "did this number move while that shot was being drawn".
let _drawsSeen = 0;
// One message per session. The condition it reports does not clear by itself — it is a property of
// the tab — so repeating it every shot would only be noise on top of silence.
let _silentPresentationWarned = false;
// How long after a fan-out settles the canary waits before calling a shot undrawn. Generous on
// purpose: being late with a true report costs nothing, and being early produced a false one.
const SILENT_CHECK_GRACE_MS = 4000;

/**
 * Say — once — that a shot this rail drew produced nothing on screen.
 *
 * The reading is deliberately narrow, because a warning that cries on ordinary play is worse than no
 * warning at all. It fires only when ALL of these hold:
 *   - the effects engine is installed (without it there are no sprites to count and none are meant);
 *   - an ASSET module is installed with it (see below);
 *   - the rail did NOT bail — and there are four ways to bail, each of them ordinary play and each of
 *     them named in `skipped`: the setting is off ("disabled"), the weapon maps to no class ("class"),
 *     the table ruled the shot a fumble ("fumble"), and the actor has no token anywhere ("shooter");
 *   - the fan-out had rounds to draw;
 *   - and the engine's creation count did not move across the whole fan-out.
 * A miss does not trip it: a missed round still draws its flash and its tracer. A fumble does not
 * trip it: that one is `skipped`. What trips it is the case that used to be invisible — the rail did
 * everything and the screen stayed empty.
 *
 * ⭐ THE ASSET GATE (2026-08-10, review finding F1b). With the engine installed and NO asset module
 * beside it, every sprite verb consults the database, finds no key and skips — silently, by the rule
 * this whole rail follows — so the creation count never moves and the client looks broken while being
 * entirely healthy. Worse, it is told the wrong thing: `flashes` is non-zero on that path, so the
 * message it earns is "reload this tab", and reloading a tab does not install an asset library. The
 * gate is `jb2aActive()` — which stays informational everywhere else (fxDbEntryExists is the real
 * per-key gate) and is exactly the right question HERE, where the subject is not one key but whether
 * there was ever anything to draw at all.
 */
function _reportSilentPresentation(result, drawsBefore) {
  if (_silentPresentationWarned) return;
  if (!globalThis.Sequencer) return;                       // no engine → no sprites are expected
  if (!jb2aActive()) return;                               // engine but no assets → nothing to draw
  if (!result || result.skipped || !(result.shots > 0)) return;   // a deliberate non-draw
  if (_drawsSeen > drawsBefore) return;                    // the engine made something → all is well
  // ⚠ DO NOT DECIDE HERE. The fan-out resolving is not the same instant as the engine reporting what
  // it made: the creation hook for a round queued at the end of the loop can land after this promise
  // settles, and on a one-round shot it usually does. Reading now calls a healthy client dead — it
  // did exactly that the first time this was written, and tripped a keeper leg to prove it. Give the
  // engine the shot's own tail plus a margin, then look again; a tab that genuinely cannot draw will
  // still be at zero, and one that was merely a beat behind will not.
  setTimeout(() => _confirmSilentPresentation(result, drawsBefore), SILENT_CHECK_GRACE_MS + (result.settleTailMs ?? 0));
}

/** The second look, after the grace window. Same test, taken once the engine has had time to answer. */
function _confirmSilentPresentation(result, drawsBefore) {
  if (_silentPresentationWarned || _drawsSeen > drawsBefore) return;
  _silentPresentationWarned = true;
  // ⭐ TWO DIFFERENT FAULTS LOOK THE SAME FROM THE SCREEN, and they need opposite advice. The rail's
  // own report tells them apart for free: `flashes` counts the muzzle flashes it actually queued, so
  // it is non-zero exactly when the rail reached its build sites and handed work to the engine.
  //   flashes > 0 → we asked, the engine made nothing → the fault is this CLIENT's drawing, and a
  //                 reload is the cure (the case a long-open tab reaches).
  //   flashes = 0 → we never asked → the fault is OURS, somewhere in the rail, and a reload will not
  //                 touch it. Saying "reload your tab" there would send someone chasing their own
  //                 browser for a module defect.
  const reached = (result.flashes ?? 0) > 0;
  const shot = `${result.weaponClass} shot (${result.shots} round(s))`;
  console.error(reached
    ? `${SCOPE} | combat fx: the rail queued a ${shot} and the effects engine created nothing. This client cannot draw new effects — most often a browser tab open long enough to run out of media players. Reload this tab.`
    : `${SCOPE} | combat fx: the rail produced no effects at all for a ${shot} that should have drawn. This is a fault in the module, not in this client — reloading will not change it. Please report it. Result: ${JSON.stringify(result)}`);
  try { ui.notifications?.warn?.(localize(reached ? "Augmented.PresentationSilent" : "Augmented.PresentationNotAttempted"), { permanent: true }); }
  catch (_e) { /* no UI on this client */ }
}

/**
 * Hook wiring — called once from the module's ready hook. Registered unconditionally (like the chat
 * card lock and the PopOut rebinding): the setting is read per event, so a GM toggling combatFxEnabled
 * takes effect immediately with no reload, and the listener is inert while it is off.
 */
export function registerCombatFx() {
  Hooks.on("cyberpunk2020.weaponFired", (payload) => {
    if (!combatFxEnabled()) return;
    // THE PRESENTATION CANARY. Take the engine's creation count before the fan-out and again after it,
    // and compare: this rail can run perfectly — payload raised, class resolved, every verb called —
    // and still put nothing on screen, because the drawing itself happens inside the effects engine
    // and can fail there without anything reaching us. That is not hypothetical: a client whose tab
    // had been open for hours reported silent shots all evening while the same shots drew normally on
    // every other client, and its console was full of the engine's own sprite-creation errors (a
    // browser caps how many media elements one document may hold at once, and a tab that has drawn
    // enough of them stops being able to make more until it is reloaded). Nothing above this line
    // could tell — every check we had said the shot was presented.
    //
    // So measure the OUTCOME, not the intent, and say so once. Read only when the engine is present
    // (with no Sequencer installed the rail draws no sprites BY DESIGN — the light and the report are
    // the whole presentation there, and warning about that would be false).
    const drawsBefore = _drawsSeen;
    fxWeaponFired(payload)
      .then((result) => _reportSilentPresentation(result, drawsBefore))
      .catch((err) => console.warn(`${SCOPE} | combat fx failed`, err));
  });
  // The flash announcement. Same channel and same type-dispatch shape as the module's other relays;
  // unlike the write relays there is no GM gate, because every client draws its own copy and nothing
  // is written. `game.socket.emit` never echoes to its sender, so the firing client's own flash comes
  // from the local call inside fxMuzzleFlash rather than from here.
  game.socket.on(`module.${SCOPE}`, (data) => {
    if (data?.type !== MSG_FLASH) return;
    if (!combatFxEnabled()) return;
    try {
      muzzleFlashLocal(data.tokenId, data.aim ?? null, { sceneId: data.sceneId ?? null, ammoColor: data.ammoColor ?? null });
    } catch (err) {
      console.warn(`${SCOPE} | muzzle flash relay failed`, err);
    }
  });
  // THE ENGINE'S OWN REPORT that a drawn element has appeared and gone. These are what resolve the
  // completion signal: the rail names the last round's terminal elements when it queues them, and the
  // engine tells us when each one actually leaves the screen — which runs past the scheduled tail by a
  // measured margin (see _tagWatches). Registered once, and inert for any effect not carrying one of
  // our names, so nothing else on the canvas is affected.
  Hooks.on("createSequencerEffect", (effect) => {
    _drawsSeen++;   // the canary's only reading: did the engine actually make anything (see above)
    const w = _tagWatches.get(effect?.data?.name);
    if (w && !w.done) { w.created++; clearTimeout(w.confirm); }
  });
  Hooks.on("endedSequencerEffect", (effect) => {
    const tag = effect?.data?.name;
    const w = _tagWatches.get(tag);
    if (!w || w.done) return;
    w.ended++;
    w.lastEndAt = Date.now();
    _maybeSettleTag(tag);
  });
  // Nothing is persisted, so there is nothing to sweep up on load — but the sources this client is
  // drawing belong to the scene it is drawing them on, and its lighting collection is emptied under
  // us when the scene changes. Drop the drivers with it.
  Hooks.on("canvasTearDown", () => clearFlashes());
  primeFxSounds().catch(() => { /* listing unavailable → shipped-asset path is used */ });
}
