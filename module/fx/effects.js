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
import { combatFxEnabled, faceTargetOnFireEnabled } from "../settings.js";

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
 * ⏪⏪ NO ROW NAMES ONE ANY MORE (FR#22, user ruling) — and the chain is worth keeping because the
 * mechanism outlived the reason for it:
 *   FR#21 ADDED the dwell, for the shell alone, because its single discharge's lance was over before
 *     the eye settled while an automatic's restarts read as sustained.
 *   FR#22 gave the shell a bullet.02 DISCHARGE COLUMN, whose own built-in bloom sits at the barrel.
 *   The user then ruled on seeing the two together: "the newly added spiky cone looks great, but the
 *     flame lance from before still sits below it and it doesn't look good. Remove the flame lance."
 *     So the shell draws NO lance, and the dwell that existed only to make that lance visible goes
 *     with it. The shell's muzzle is now the column's bloom, the pellet fan, one smoke puff, and the
 *     native flash light.
 * The mechanism below is deliberately LEFT WIRED rather than deleted: it is one row field away from
 * use if another class ever wants a longer lance, and it is measured and documented. Every shipped row
 * omits it today, so every shipped lance plays at rate 1.
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
 * THE BURNING GROUND — fire left at the point an incendiary payload landed. Drawn ONCE PER PAYLOAD.
 *
 * ⭐ ONCE PER PAYLOAD IS THE WHOLE GATE, and it is the same gate `smokeSingle` and fxBurstAmbience sit
 * behind for the same reason: the fan-out caps at MAX_FX_SHOTS (30) rounds, so a per-round element
 * that lingers for seconds would put thirty overlapping fires on one square for one trigger pull. One
 * burst sets one fire. The call site is outside the round loop, which is what enforces it — there is
 * no counter to get wrong.
 *
 * ⚠ NOT PERSISTENT, and the lifetime is a cap rather than a look: `lifetimeMs` is a few seconds so the
 * fire is a consequence a viewer connects to the shot they just watched. The asset is a TRUE LOOP
 * (GroundCrackLoop_01..03, 2667ms measured on the install), so it runs to the lifetime cleanly instead
 * of ending mid-animation, and the key is the parent path so the three variants rotate per payload.
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
 * window shut for the whole burn.
 */
export const GROUND_FIRE = Object.freeze({
  key: "jb2a.ground_cracks.orange",
  squares: 1.6,
  lifetimeMs: 3200,
  fadeInMs: 250,
  fadeOutMs: 900,
  opacity: 0.85,
});

/**
 * THE SCORCH — the mark the fire leaves behind, drawn with it and outliving it by minutes.
 *
 * ⚠ WHAT THIS HONESTLY IS, stated at the site because the limit is invisible from the outside: it is a
 * long-lived SEQUENCER EFFECT, not a Tile and not a document. It is bound to the session — a page
 * reload, a scene change or a client reconnect takes it away, and it never existed for a client that
 * joined after the shot. NOTHING IS WRITTEN, which is the requirement: this rail performs exactly one
 * document write (the face-target turn) and a decal that persisted properly would be a second one, on
 * the scene, from whichever client happened to resolve the shot.
 *
 * Real persistence is a shared question with blood decals and needs a ruling of its own (who owns the
 * write, who cleans it up, what a table does about a scene that accumulates them across a campaign).
 * Recorded here so that when it is answered, this is the site that changes.
 *
 * `lifetimeMs` IS A CAP AND NOT A LOOK. Minutes, not forever: a Sequencer effect with no end is a leak
 * by another name, and a scorch that is still there an hour later is a mark on the map nobody can
 * remove without clearing every effect on the canvas.
 *
 * ⚠ `loops: 1` IS LOAD-BEARING. The asset is 6250ms and the lifetime is far longer, and an effect
 * whose duration exceeds its clip LOOPS by default — a scorch mark that re-blooms every six seconds
 * for three minutes is a strobe, not a decal. One loop plays the mark forming and then holds it for
 * the remainder.
 *
 * BELOW THE LIGHTING, unlike the fire above it, and that is the file's own rule applied rather than an
 * exception: self-luminous elements go up, lit-by-the-world elements stay down. A scorch is a black
 * mark on a floor. It has no light of its own and it should be as dark as the room is.
 *
 * ⛔ EXCLUDED FROM THE SETTLE SIGNAL for the same reason as the fire, and much more so.
 */
export const GROUND_SCORCH = Object.freeze({
  key: "jb2a.scorched_earth.black",
  squares: 1.5,
  lifetimeMs: 180000,
  fadeInMs: 600,
  fadeOutMs: 3000,
  opacity: 0.7,
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
 *  - INERT (rubber / stundart): saturation halved and brightness pulled DOWN. It is the only matrix
 *    that darkens, and that is the point — a baton round is the one load that should look like it is
 *    carrying less energy than a standard one.
 *
 * ⚠ NO WIDTH LEVER EXISTS. "A thinner bolt for AP" was considered and cannot be built: a painted
 * (stretched) tracer takes its width from the asset's own frame and Sequencer's size call on a
 * stretched effect controls the stretch, not the cross-section. Colour is the whole available palette
 * for a painted tracer, which is why all three of these are colour and why the two treatments that
 * genuinely change SHAPE (flechette's fan, the impact promotions) do it with different fields.
 */
export const TRACER_COLOR_INCENDIARY = Object.freeze({ hue: -20, saturate: 0.30, brightness: 1.20 });
export const TRACER_COLOR_HARDENED   = Object.freeze({ hue: 8,   saturate: -0.85, brightness: 1.45 });
export const TRACER_COLOR_INERT      = Object.freeze({ hue: 0,   saturate: -0.55, brightness: 0.60 });

/**
 * How far the discharge column is stretched, in grid units, measured from the shooter's own edge.
 *
 * ⏱ FR#23. It used to reach the aim point, which drew a full bolt down the shot line and read as a
 * single rifle round riding on top of the shell's pellet fan. The element exists for the BLOOM baked
 * into its origin, so the stretch only has to be long enough to carry that bloom and a short streak
 * behind it. A grid-unit distance keeps it the same size on any scene and independent of range — a
 * shot at two squares and a shot at twelve now draw the same muzzle blast.
 *
 * ⚠ THE ASSET IS DISTANCE-BANDED, which is what makes this worth measuring rather than assuming: the
 * database hands back a different source file per stretch distance, so shortening the stretch does not
 * merely scale the same clip, it selects a different one. At 1.25 squares the database serves the
 * SHORTEST band, and that is the right one — measured, see below.
 *
 * ⏪ THE "USE A LONG BAND INSTEAD" ALTERNATIVE IS DEAD (2026-08-09). It used to be recorded here as the
 * escape hatch if the short band's phases were ever inseparable, on the assumption that a longer band
 * spreads bloom / travel / arrival further apart in TIME. Decoded off the installed files, that
 * assumption is false in the direction that matters:
 *   Bullet_02_Regular_Orange_{05,15,30,60,90}ft — 933ms EVERY ONE. The bands differ in WIDTH
 *   (600 / 1000 / 1600 / 2800 / 4000 px), not in duration.
 * The bloom is the same ~230px of art in all five, so a longer band is the same bloom with more
 * distance for the round to cover in the same 933ms. Frame-analysed, head position as a multiple of
 * the bloom's own extent at 133ms of clip: 05ft = 1.05×, 90ft = 1.9×. The long band puts the round
 * FURTHER from the bloom at every clip time, not nearer. The short band is strictly the best available
 * for a bloom-only read, and the only lever that separates the phases is the TRIM below.
 */
export const COLUMN_SQUARES = 1.25;

/**
 * How much of the column's clip plays, in clip milliseconds — the trim that keeps its BLOOM and drops
 * everything after it.
 *
 * The stretch controls WHERE the clip is drawn; only a trim controls HOW MUCH of it is drawn. Same tool
 * and same reasoning as the muzzle lance's own trim (MUZZLE_SPRITE.endMs), including the finding
 * recorded there that a TIME RANGE really cuts on this build where the percentage form cut nothing.
 *
 * ⏪⏪ 300 → 70 (2026-08-09, user ruling). At 300ms the user reported two things about this one element,
 * and they turned out to be the same element: "the spiky cone is currently emitting a tail (looks like
 * a round or round tail)", and "shotgun also has this standard starburst in addition to the spiky
 * cone". Both are `bullet.02`'s own baked phases, and the value here decided how many of them played.
 *
 * ⭐ THE CLIP, DECODED FRAME BY FRAME off the installed 05ft file (600x400, 933ms) rather than guessed —
 * this is the whole basis for the number:
 *      0–33ms    the bloom forming, small
 *     33–66ms    ⭐ THE SPIKY CONE at full size, apex on the barrel, nothing else on screen
 *     66–96ms    a white streak develops BEHIND the muzzle (the speed trail)
 *     96–160ms   bright heads separate and run forward — the "round with a tail"
 *    160–300ms   ⭐ THE STARBURST, ~1.5 squares ahead of the barrel, bright and detached
 *    300–933ms   sparks and smoke curls, dimming
 * Confirmed on the rig at four trims played through the ship chain (capture 57d): 300ms shows cone,
 * trail AND starburst; 140ms shows cone and a pronounced trail, no starburst; 100ms shows the cone with
 * a modest trail; 70ms shows the cone alone. So ~70 is the largest value that draws ONLY what the user
 * asked to keep — and 55 is that value with the overrun margin below subtracted.
 *
 * ⚠⚠ THE TRIM IS A BUDGET, NOT A GUARANTEE, and this is the measurement that sets the final number.
 * The media element starts playing when its texture is ready, which lags the effect's own start, while
 * the effect's death is scheduled from the effect's start — so the video can run PAST the range end.
 * Sampled at 4ms against the video's own `currentTime`, worst clip actually reached over repeated real
 * discharges:
 *     trim  70 / rate 1      → 139ms   ⚠ a rate of 1 is the WORST case, not the safest: a 70ms budget
 *                                        is shorter than the start lag, so the media runs at full speed
 *                                        through the whole overshoot
 *     trim  70 / rate 1/3    →  76ms   (bare chain)   ·  103ms worst of 12 real discharges (ship chain)
 *     trim  45 / rate 1/3    →  50ms
 * A slower rate makes the trim MORE accurate, because the overshoot is a fixed slice of WALL time and a
 * slow rate converts less of it into clip. 55 with the dwell below keeps the worst observed reach inside
 * the clean-cone window even on this rig, which renders at ~12fps and therefore exaggerates every
 * scheduling lag a real client would have.
 *
 * ⚠ IT IS NOT THE ON-SCREEN LIFE — see COLUMN_DWELL_MS. 55ms of clip would be a shorter discharge than
 * any class's lance, and this is the one class that draws no lance at all. The dwell is what keeps the
 * blast readable; this number only decides which frames exist.
 */
export const COLUMN_TRIM_MS = 55;

/**
 * How long the trimmed column stays on screen, in WALL-CLOCK milliseconds.
 *
 * Two numbers rather than one, for exactly the reason the lance's own pair exists (see the
 * MUZZLE_DWELL_DEFAULT_MS block): the trim decides WHICH frames are drawn and the dwell decides HOW LONG
 * they take to play. Extending the trim to buy on-screen time is what lets the tail and the starburst
 * back in — they are later frames of this same clip — so the time has to come from the playback RATE
 * instead. What is shown stays byte-for-byte the frames ruled in above.
 *
 * WHY 220. FR#21 measured that a SINGLE discharge's muzzle sprite is over before the eye settles where
 * an automatic's restarts read as sustained, and ruled a 220ms dwell for the one class that fires one
 * round — this class. FR#22 then removed that class's lance and the dwell went with it, leaving the
 * column's own 300ms clip carrying the discharge's whole on-screen presence. Cutting the clip to 55ms
 * without restoring a dwell would hand back the defect FR#21 fixed, so the dwell comes back on the
 * element that now carries the blast, at the value that was already ruled for it.
 *
 * ⭐ IT IS ALSO WHAT MAKES THE TRIM ACCURATE, which is the part that would not survive being "tidied
 * away". The trim block records the measurement: the media overshoots its range end by a slice of WALL
 * time, so the slower the rate, the less of that slice becomes clip. Rate 1 was measured as the worst
 * case (139ms reached against a 70ms range), not the safest. 55/220 is an exact 0.25, the same kind of
 * round derived rate the lance's ruled dwell gave it.
 *
 * ⚠ 220 IS THE ASK, NOT A MEASURED DELIVERY. Sampled at 4ms against the sprite's own media element, the
 * shipped pair puts the column on screen for ~160ms of wall clock rather than the full 220 — the media
 * starts a little after the effect does and the host does not hold the requested rate exactly under
 * load. It is recorded here because presentationTailMs takes this constant as the column's term, and a
 * term that over-states an element's life is the SAFE direction for a floor the damage window waits on
 * (the window may open late, never early). Do not "correct" it downward to the measured number without
 * re-reading that function's opening note.
 */
export const COLUMN_DWELL_MS = 220;

/**
 * The playback rate that makes the trimmed column last its dwell. Pure, and exported so the pair is
 * asserted by value rather than by watching a sprite.
 */
export function columnRateFor() {
  return COLUMN_TRIM_MS / COLUMN_DWELL_MS;
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
 *  - `dashSquares: 1` — the drawn WIDTH of one pellet's sprite, one grid square, height following the
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
 *  - NO `muzzle` KEY AT ALL, and no `muzzleSquares`/`muzzleMs` with it (FR#22, user ruling). The shell
 *    is the one class that draws no aimed lance: with the discharge column below it, the lance read as
 *    a second flame sitting under the bloom — "the newly added spiky cone looks great, but the flame
 *    lance from before still sits below it and it doesn't look good." Its discharge is now the column's
 *    own built-in bloom, the pellet fan, one smoke puff and the native flash light. Restoring it is
 *    adding the two fields back; the dwell mechanism they used is still wired (MUZZLE_DWELL_DEFAULT_MS).
 *  - `tracer: bullet 01` — the THIN variant, where the rifle takes the heavy 02.
 *  - `tracerColor: null` — ⭐ DECLARED, PAINTED WITH NOTHING (2026-08-09, user ruling). `null` is not
 *    the same statement as leaving the field out, and the difference is the whole mechanism behind the
 *    ruling. Omitting it says "this class has no repaintable fan" and an ammo overlay's `tracerColor`
 *    is then dropped by the repaint mask; `null` says "the fan is repaintable, and the CLASS paints it
 *    with nothing". So the base look is unchanged — the draw path's `if (entry.tracerColor)` is false
 *    on null, and buckshot still leaves the muzzle in the asset's own colour, which is the settled
 *    look — while an ammo overlay that recolours now reaches the pellets as well as the column.
 *    Reported: "for incendiary on autoshotgun the little dorito shaped pellets themselves didn't get
 *    the same red treatment as the spiky cone and starburst. Make sure when you update the animation
 *    for one shotgun ammo type, it's updated for all." ⏪ This supersedes FR#24's "shell pellets are
 *    never tinted" for AMMO loads only; for the base look that ruling stands, and it stands here as a
 *    null rather than as a branch.
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
  shotgun: { sound: "shot-shotgun", soundBurst: "shot-shotgun-burst", tracer: "jb2a.bullet.01.orange", tracerColor: null, motes: 10, smokeSquares: 0.6, smokeSingle: true, column: "jb2a.bullet.02.orange", columnColor: TRACER_COLOR, impactSquares: 1.15, pellets: 6, spreadRad: 0.07, dashSquares: 1, dashMs: 150, cadenceMs: 180 },
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
export const IMPACT_FIRE = Object.freeze({ key: "jb2a.impact.fire.01.orange", clipMs: 2267 });
export const IMPACT_CRACK = Object.freeze({ key: "jb2a.impact.ground_crack.orange", clipMs: 5033 });

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
 * implementation detail. See ammoFxEntry: the two RECOLOUR fields may only repaint an element the
 * class already DECLARES, never add one — so an overlay cannot give a pistol a discharge column, and
 * cannot give a class a bolt colour on a bolt it does not draw.
 *
 * ⭐ DECLARED IS NOT THE SAME AS PAINTED, and that distinction is what lets one rule serve two rulings
 * (2026-08-09). The mask asks whether the class row CARRIES the field, so a row may carry it as `null`:
 * "this element is repaintable, and I paint it with nothing." The shell row does exactly that for its
 * pellet fan. The outcomes, with no branch anywhere naming a class:
 *   - base shell        — `tracerColor: null` → no ColorMatrix on the fan, the settled buckshot look
 *   - incendiary shell  — the overlay's shift lands on the column AND the fan, one treatment
 *   - incendiary rifle  — the same overlay tints the single bolt it actually draws
 *   - incendiary pistol — no `column`/`columnColor` field at all, so it gains no column
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
 * THE ROWS, and what each is saying:
 *  - `api` — the only load that is on fire. Red-shifted bolt, a fire impact, a warm muzzle light in
 *    the dark, and the two ground elements. Everything else on this table is one or two fields.
 *  - `ap` / `dualPurpose` — identical treatment, and deliberately so: their MECHANICS are byte-identical
 *    (lookups.js gives both the same armour and past-armour multipliers), so drawing them differently
 *    would be inventing a distinction the rules do not make. They are two rows rather than one alias
 *    because the ids are what arrive on the payload and a reader looking one up should find it.
 *  - `hollowPoint` / `safety` — the pure size pair. A hollow-point deforms and makes a wide messy
 *    bloom; a safety round is built NOT to over-penetrate, and its mark is correspondingly small.
 *    Nothing else changes for either: same colour, same asset, same timing.
 *  - `flechette` — the one overlay that changes the SHAPE of the round. It is a fan of darts, so it
 *    takes the travelled-fan fields the shell class already uses, on whatever class fires it: more
 *    darts than the shell's buckshot, spread wider, each dart smaller and faster. ⚠ It is also the
 *    reason presentationTailMs takes an ammo key — `dashMs` is a tail input, and an overlay that
 *    changes it while the tail is computed from the bare class row would open the apply window early.
 *  - `rubber` / `stundart` — the inert pair: dull bolt, small impact. They differ mechanically only in
 *    the stun modifier, which is not a visible fact, so they draw alike.
 */
export const AMMO_FX = Object.freeze({
  api: Object.freeze({
    tracerColor: TRACER_COLOR_INCENDIARY,
    columnColor: TRACER_COLOR_INCENDIARY,
    impactKey: IMPACT_FIRE.key,
    flashColor: "#ff6a1a",
    groundFire: true,
  }),
  ap: Object.freeze({
    tracerColor: TRACER_COLOR_HARDENED,
    columnColor: TRACER_COLOR_HARDENED,
    impactKey: IMPACT_CRACK.key,
  }),
  dualPurpose: Object.freeze({
    tracerColor: TRACER_COLOR_HARDENED,
    columnColor: TRACER_COLOR_HARDENED,
    impactKey: IMPACT_CRACK.key,
  }),
  hollowPoint: Object.freeze({ impactScale: 1.6 }),
  safety: Object.freeze({ impactScale: 0.55 }),
  flechette: Object.freeze({ pellets: 8, spreadRad: 0.1, dashSquares: 0.8, dashMs: 170, impactScale: 0.7 }),
  rubber: Object.freeze({ tracerColor: TRACER_COLOR_INERT, columnColor: TRACER_COLOR_INERT, impactScale: 0.6 }),
  stundart: Object.freeze({ tracerColor: TRACER_COLOR_INERT, columnColor: TRACER_COLOR_INERT, impactScale: 0.6 }),
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
export const AMMO_FX_RECOLOR_FIELDS = Object.freeze(["tracerColor", "columnColor"]);

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
 *  1. RECOLOUR FIELDS are applied only where the class row already CARRIES them — key presence, so a
 *     row carrying `null` is repaintable while painting nothing itself (the ruling in the AMMO_FX
 *     block — repaint, never add).
 *  2. Everything else is a plain overwrite, so an overlay may genuinely give a class an element it did
 *     not have: that is how flechette gives a rifle a fan of darts.
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
    if (AMMO_FX_RECOLOR_FIELDS.includes(field) && base[field] === undefined) continue;
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
export function pelletEndpoints(from, to, { pellets = 0, spreadRad = 0, hit = true, rng = Math.random } = {}) {
  const n = Math.trunc(pellets);
  if (!from || !to || !(n > 1)) return [];
  if (!hit) return Array.from({ length: n }, () => missEndpoint(from, to, rng));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const aim = Math.atan2(dy, dx);
  return Array.from({ length: n }, (_v, i) => {
    const offset = spreadRad * ((2 * i) / (n - 1) - 1);   // −1 … +1 of the cone, evenly spaced
    return { x: from.x + Math.cos(aim + offset) * dist, y: from.y + Math.sin(aim + offset) * dist };
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
export async function fxShot(shooterToken, targetToken, { weaponClass, hit = true, light = true, mode = MUZZLE_MODE, settleTag = null, ammoKey = null } = {}) {
  const out = { light: false, muzzle: false, spark: false, column: false, tracer: false, pellets: 0, impact: false, tagged: 0, ammoKey: ammoKey ?? null };
  // THE CLASS ROW WITH THE LOADED ROUND'S OVERLAY ON TOP (FR#24). Everything below reads `entry` and
  // nothing below knows an overlay happened — which is the point: one merge site, and the draw path is
  // the same code for every load. The KEY is passed in rather than resolved here because there is no
  // payload at this level to resolve it from; fxWeaponFired does that once and threads it.
  const entry = ammoFxEntry(weaponClass, ammoKey);
  if (!entry) return out;
  const from = centerOf(shooterToken);
  const gridPx = Number(canvas?.dimensions?.size) || 100;
  // The axis this whole shot is drawn along — the aimed-at token's centre, or the shooter's own
  // facing when nothing was aimed at (aimPointOf). Resolved ONCE, so the light, the sprite, the
  // spark and the tracer cannot disagree about where the shot is pointed.
  const to = aimPointOf(shooterToken, targetToken, gridPx);
  // Where the sprites are planted: the shooter's forward edge, walked along that axis by a fraction
  // of the token's OWN width. The previous build put everything on the centre unconditionally.
  const muzzle = muzzlePoint(from, to, tokenRadiusPx(shooterToken, gridPx) * 2 * MUZZLE_SPRITE.edgeFraction);
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
      // A row may name NO lance at all (the shell, FR#22) — its discharge is read from the column's
      // own bloom instead. The key is checked before the tier lookup so an absent row is a plain
      // "this class draws no lance", not a database miss.
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
      // THE DISCHARGE COLUMN (FR#22, user ruling) — one stretched bolt from the muzzle to the aim
      // point, drawn UNDER the pellet fan, for a class whose row names a `column` asset.
      //
      // WHAT IT IS FOR, and why it is a second tracer rather than a new sprite: decoding the assets
      // showed `bullet.02` carries three things baked into ITS OWN clip that `bullet.01` does not — a
      // SPIKY BLOOM at its origin, gray smoke curls that hang at that origin for most of the clip, and
      // a spiky impact star. The shell fires `bullet.01` pellets, so it had none of them. Laying one
      // stretched `bullet.02` down the shot plants that bloom at the barrel — which is the "spiky
      // piece" the user has been asking after, and it turns out to live in the asset rather than in our
      // lance — and brings the asset's own smoke to the discharge with it.
      //
      // ORDER IS LOAD-BEARING: queued BEFORE the pellets, deliberately. Both sit at the same elevation
      // above lighting, so the engine draws them in the order they were added — the column goes down
      // first and the dashes read on top of it, which is the ruled composition ("under the fan").
      //
      // NOT tagged for the settle signal even though it is a terminal-ish element: the tail arithmetic
      // accounts for it by value instead (presentationTailMs takes a column term), so the window's wait
      // does not depend on which of two overlapping clips the engine happens to report last.
      if (to && entry.column && fxDbEntryExists(entry.column)) {
        // ⏱ SHORTENED ON REPORT (FR#23). Stretched to the AIM POINT the column was a full-length bolt,
        // so every shotgun discharge grew a rifle-like single round on top of its pellet fan — "the
        // column added a rifle-like single bullet per shotgun shot". What it is here for is the BLOOM
        // at its origin, not the projectile, so it now stretches to a SHORT endpoint a fixed distance
        // along the aim: the bloom lands at the barrel exactly as before and what follows it reads as
        // the blast rather than as a round in flight. The endpoint is a spec knob in grid units, so it
        // is the same fraction of a square on any scene and does not scale with the range.
        const colPx = COLUMN_SQUARES * (Number(canvas?.dimensions?.size) || 100);
        const colEnd = pointAlong(from, to, tokenRadiusPx(shooterToken, gridPx) + colPx);
        const column = _held(seq.effect().file(entry.column)).atLocation(shooterToken)
          .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING)
          .timeRange(0, COLUMN_TRIM_MS)
          .stretchTo(colEnd);
        // THE DWELL (2026-08-09) — the trim above cuts the clip down to its bloom, which is 55ms of
        // content on a class that draws no lance at all, so the rate stretches those same frames over
        // COLUMN_DWELL_MS of wall clock. Rate, never range: a longer range is how the tail and the
        // starburst get back in (they are later frames of this one clip), and a rate of 1 is measured
        // as the WORST case for overshoot rather than the safest — see the COLUMN_TRIM_MS block.
        //
        // ⚠ THE CAPTURE SEAM STILL WINS, same trap as the lance's dwell: _held has already applied a
        // capture rate if one is armed, and setting this afterwards would silently defeat it.
        if (_spriteRateOverride === null) column.playbackRate(columnRateFor());
        // The column keeps its OWN colour field rather than reusing `tracerColor`, and that stays true
        // now that an ammo overlay also reaches the pellet fan: the two are separate fields because the
        // CLASS paints them differently — the column orange, the fan nothing (`tracerColor: null`) —
        // and only an overlay makes them agree. Dropping the column's shift is deleting one row field.
        if (entry.columnColor) column.filter("ColorMatrix", entry.columnColor);
        out.column = true;
      }
      if (to && fxDbEntryExists(entry.tracer)) {
        // A class carrying a pellet count draws its round as a FAN of tracers instead of one bolt;
        // every other class omits the field and takes the single endpoint. `out.tracer` stays the same
        // boolean either way (did this shot claim a tracer at all) and `out.pellets` reports how many
        // were queued, so a caller can tell the two shapes apart.
        const fan = pelletEndpoints(from, to, { pellets: entry.pellets, spreadRad: entry.spreadRad, hit });
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
        for (const end of ends) {
          const shot = _held(seq.effect().file(entry.tracer)).atLocation(shooterToken)
            .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING);
          // TERMINAL ELEMENT — named so the engine's own end can be observed (see _watchSettleTag).
          if (settleTag) { shot.name(settleTag); out.tagged++; }
          // The colour shift, where the class asks for one. A ColorMatrix and not a tint — see
          // TRACER_COLOR for the measurement that rules the tint out.
          if (entry.tracerColor) shot.filter("ColorMatrix", entry.tracerColor);
          if (entry.dashSquares > 0) {
            shot.size({ width: entry.dashSquares }, { gridUnits: true })
              .rotateTowards(end)
              .moveTowards(end, { ease: "linear", rotate: false })
              .moveSpeed(pelletSpeed)
              .duration(dashMs + DASH_ARRIVAL_HOLD_MS)
              .fadeOut(DASH_ARRIVAL_HOLD_MS);
          } else {
            shot.stretchTo(end);
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
      const impactKey = entry.impactKey ?? HIT_CONFIRM.key;
      const impactClipMs = Number(entry.impactClipMs) > 0 ? Number(entry.impactClipMs) : HIT_CONFIRM.clipMs;
      if (hit && to && entry.impactSquares > 0 && fxDbEntryExists(impactKey)) {
        const impact = _held(seq.effect().file(impactKey)).atLocation(to)
          .size({ width: entry.impactSquares }, { gridUnits: true })
          .timeRange(0, impactClipMs)
          .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING);
        // TERMINAL ELEMENT — on a landing round this is normally the last thing to leave the screen.
        if (settleTag) { impact.name(settleTag); out.tagged++; }
        const travel = HIT_CONFIRM.delayFollowsTracer && entry.dashSquares > 0
          ? (_dashMsOverride ?? entry.dashMs) : 0;
        if (travel > 0) impact.delay(travel);
        out.impact = true;
        // Reported so a caller (and the keeper) can assert WHICH mark was drawn and how wide, by
        // value, rather than by looking at the canvas — the promotion is otherwise invisible to a test.
        out.impactKey = impactKey;
        out.impactSquares = entry.impactSquares;
        out.impactClipMs = impactClipMs;
      }
      if (out.muzzle || out.tracer || out.impact) await seq.play();
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
export async function fxSmokePuff(shooterToken, targetToken, { weaponClass, index = 0, rng = Math.random } = {}) {
  const entry = FX_CLASSES[weaponClass];
  if (!entry || !(entry.smokeSquares > 0) || !sequencerActive() || !shooterToken) return null;
  if (!fxDbEntryExists(MUZZLE_SMOKE.key)) return null;
  const gridPx = Number(canvas?.dimensions?.size) || 100;
  const from = centerOf(shooterToken);
  const to = aimPointOf(shooterToken, targetToken, gridPx);
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
export async function fxBurstAmbience(shooterToken, targetToken, { weaponClass, shots = 0, cadenceMs = SHOT_CADENCE_MS } = {}) {
  const out = { motes: 0 };
  const entry = FX_CLASSES[weaponClass];
  if (!entry || !sequencerActive() || !shooterToken) return out;
  const from = centerOf(shooterToken);
  const gridPx = Number(canvas?.dimensions?.size) || 100;
  // The same axis every other part of the shot takes (aimPointOf) — the aimed-at token's centre, or
  // the shooter's own facing. This used to bail outright when nothing was aimed at, so a burst fired
  // at no target lost its specks and its wisp along with its wedge; that was the reported defect.
  // What remains of the guard is a shooter with no position at all, which has no muzzle to draw from.
  const to = aimPointOf(shooterToken, targetToken, gridPx);
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
 * THE INCENDIARY GROUND ELEMENTS — the burning ground and the scorch it leaves, drawn ONCE for a whole
 * payload at the point that payload landed. The two live in one verb because they are one event: the
 * fire and its mark start together and only their lifetimes differ.
 *
 * GATED ON THE ROW, NOT ON A NAME. The caller decides by reading `groundFire` off the resolved entry
 * (ammoFxEntry), so no branch anywhere in this file names the incendiary load — adding the field to a
 * second overlay is all it would take to give another round the same treatment.
 *
 * `delayMs` is the travelled tracer's crossing time, so the fire starts when the round arrives rather
 * than when it leaves. It is the same number the hit confirmation is held back by, read from the same
 * row field, so the two land together.
 *
 * NOT AWAITED by its caller and NOT TAGGED for the settle signal — see the two spec blocks above for
 * both rulings. Returns what it queued so the gate and the lifetimes are assertable by value.
 */
export async function fxGroundFire(point, { delayMs = 0 } = {}) {
  const out = { fire: false, scorch: false, fireMs: 0, scorchMs: 0 };
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !sequencerActive()) return out;
  const at = { x: point.x, y: point.y };
  const delay = Number(delayMs) > 0 ? Number(delayMs) : 0;
  try {
    const seq = new globalThis.Sequence();
    // TWO SEPARATE SECTIONS, which is the file's standing answer to the randomiser trap: the engine
    // rolls a multi-file key once per section, so the fire picking its variant and the scorch picking
    // its own have to be two sections. They are also two different lifetimes, which one section could
    // not express anyway.
    if (fxDbEntryExists(GROUND_FIRE.key)) {
      const fire = _held(seq.effect().file(GROUND_FIRE.key)).atLocation(at)
        .size({ width: GROUND_FIRE.squares }, { gridUnits: true })
        // Self-luminous → above the lighting, with the vision-mask trade documented at the spec block.
        .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING)
        .opacity(GROUND_FIRE.opacity)
        .fadeIn(GROUND_FIRE.fadeInMs)
        .duration(GROUND_FIRE.lifetimeMs)
        .fadeOut(GROUND_FIRE.fadeOutMs);
      if (delay > 0) fire.delay(delay);
      out.fire = true;
      out.fireMs = GROUND_FIRE.lifetimeMs;
    }
    if (fxDbEntryExists(GROUND_SCORCH.key)) {
      const scorch = _held(seq.effect().file(GROUND_SCORCH.key)).atLocation(at)
        .size({ width: GROUND_SCORCH.squares }, { gridUnits: true })
        // NOT above the lighting: a scorch mark is not a light source (the split is stated in the
        // LIT_SPRITE_ABOVE_LIGHTING block — self-luminous up, lit-by-the-world down).
        .opacity(GROUND_SCORCH.opacity)
        .fadeIn(GROUND_SCORCH.fadeInMs)
        // ONE LOOP, then hold. Without this the mark re-blooms every clip length for the whole
        // lifetime — see the ruling in the GROUND_SCORCH block.
        .loopOptions({ loops: 1 })
        .duration(GROUND_SCORCH.lifetimeMs)
        .fadeOut(GROUND_SCORCH.fadeOutMs);
      if (delay > 0) scorch.delay(delay);
      out.scorch = true;
      out.scorchMs = GROUND_SCORCH.lifetimeMs;
    }
    if (out.fire || out.scorch) {
      seq.play().catch((err) => console.warn(`${SCOPE} | ground fire play failed`, err));
    }
  } catch (err) {
    console.warn(`${SCOPE} | ground fire failed`, err);
  }
  return out;
}

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
export function presentationTailMs(weaponClass, ammoKey = null) {
  // ⚠ THE OVERLAY IS READ HERE TOO, AND THAT IS NOT OPTIONAL (FR#24). This function used to read
  // FX_CLASSES directly, and an ammo overlay that changes any of its inputs — flechette moves `dashMs`
  // and gives a class a fan it did not have, a promotion moves the impact's own length — would then be
  // drawn by fxShot and NOT accounted for here. The failure that produces is silent and one-directional:
  // the tail comes back short, the settle floor is short with it, and the apply window opens while the
  // last round is still on screen. Same resolver as the draw path, so the two cannot drift.
  const entry = ammoFxEntry(weaponClass, ammoKey);
  const travel = Number(entry?.dashMs) > 0 ? Number(entry.dashMs) : 0;
  const spark = entry?.spark ? MUZZLE_SPARK.clipMs : 0;
  const tracerEnd = travel > 0 ? travel + DASH_ARRIVAL_HOLD_MS : TRACER_CLIP_MS;
  // The impact term is how long the impact is DRAWN, which for a promoted asset is its trim rather
  // than its own clip — the same field fxShot plays it with (see the impact-promotion rule).
  const impactClipMs = Number(entry?.impactClipMs) > 0 ? Number(entry.impactClipMs) : HIT_CONFIRM.clipMs;
  const impactEnd = Number(entry?.impactSquares) > 0 ? travel + impactClipMs : 0;
  // The lance term is the class's DWELL, not the trim: a row that stretches its lance must be covered
  // by the tail it belongs to. (Every shipped dwell is far under the travelled/impact terms, so this
  // reads the same as before for all five rows — it is written this way so a longer dwell later cannot
  // quietly outlive the signal.)
  //
  // THE COLUMN TERM (FR#22): a class drawing a discharge column lays down a full painted bolt, which
  // runs its own clip from the instant the round goes out — so the window has to wait for whichever of
  // the two chains ends LAST, not for the one that happens to be named. Counted by value here rather
  // than tagged, so the arithmetic stays readable and does not depend on engine reporting order.
  // The column is TRIMMED and then DWELT: the honest term is how long it is actually on screen, which
  // is the dwell (COLUMN_DWELL_MS), not the 55ms of clip the trim admits. Reading the trim here would
  // under-count the element by a factor of four — the exact silent, one-directional failure this
  // function's opening note warns about.
  const columnEnd = entry?.column ? COLUMN_DWELL_MS : 0;
  return Math.max(muzzleEnvelopeDurationMs(), muzzleDwellMs(weaponClass), spark, tracerEnd, impactEnd, columnEnd);
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
export function presentationMs(shots, weaponClass, ammoKey = null) {
  const n = Math.min(Math.max(Math.trunc(Number(shots) || 0), 1), MAX_FX_SHOTS);
  // The CADENCE is deliberately NOT overlaid: no ammo row carries one and none should. Spacing between
  // rounds is a property of the weapon's action, not of what is in the magazine.
  return (n - 1) * classCadenceMs(weaponClass) + presentationTailMs(weaponClass, ammoKey);
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
  const shooter = shooterTokenOf(actor);
  const aimTokenId = payload?.targetTokenId ?? payload?.fxTargetTokenId ?? null;
  const target = aimTokenId ? (canvas?.tokens?.get(aimTokenId) ?? null) : null;
  const gridPx = Number(canvas?.dimensions?.size) || 100;
  const leadIn = shooter ? (faceTargetTurn(shooter, aimPointOf(shooter, target, gridPx))?.durationMs ?? 0) : 0;
  // The loaded round's overlay, resolved from the payload the same way the fan-out resolves it, so the
  // arithmetic fallback and the fan-out's own floor agree about a round whose overlay moves the tail.
  return leadIn + presentationMs(shotCountOf(payload), weaponClass, ammoFxKeyOf(payload));
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
    clearTimeout(w.confirm); clearTimeout(w.floor);
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
  const w = { created: 0, ended: 0, done: false, startedAt: Date.now(), scheduledMs, settle, confirm: null, floor: null };
  _tagWatches.set(tag, w);
  // Nothing named ever appeared by the time the schedule says it should be over → there was nothing to
  // observe (no engine, or no asset), so the arithmetic stands in.
  setTimeout(() => {
    if (!w.done && w.created === 0) _finishTag(tag, "scheduled");
  }, scheduledMs);
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
  const result = { shots: 0, hits: 0, flashes: 0, motes: 0, smokePuffs: 0, turnedDeg: null, weaponClass: null, cadenceMs: SHOT_CADENCE_MS, skipped: null, ammoKey: null, groundFire: null };
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
  // Placed with the other two bail-outs, ahead of _armSettlement, for the reason stated there: a
  // payload this rail will not draw must fall to the arithmetic rather than leave a caller waiting on
  // a promise nobody will resolve.
  if (payload?.fumbleRuled) return { ...result, weaponClass, skipped: "fumble" };

  // ARM THE COMPLETION SIGNAL, and do it here — after the two bail-outs above and before the first
  // await. After, because a payload this rail is not going to draw must fall to the arithmetic rather
  // than wait on a promise nobody will resolve; before, because a caller listening to the same hook
  // may reach presentationSettled() in the same turn and must find the arming already done.
  const settle = _armSettlement(payload);
  // The name stamped on the last round's terminal elements, unique per fan-out so two shots in flight
  // never observe each other's endings.
  const settleTag = `${SCOPE}.settle.${foundry.utils.randomID()}`;

  // WHICH LOAD IS IN THE GUN — resolved ONCE, here, with the payload in hand, and threaded into every
  // verb below. It cannot be resolved further down: fxShot and the tail arithmetic never see a payload,
  // so a key resolved there would have to be invented. See ammoFxKeyOf for id-first / fingerprint.
  const ammoKey = ammoFxKeyOf(payload);
  const ammoEntry = ammoFxEntry(weaponClass, ammoKey);

  const shots = shotCountOf(payload);
  const hits = Math.min(hitCountOf(payload), shots);
  const shooter = shooterTokenOf(actor);
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

  // One payload = one resolved burst, so whether this is a MULTI-round payload is known before the
  // first round goes out and holds for all of them — every round of one burst gets the same asset,
  // rather than the first sounding different from the rest.
  const burst = shots > 1;

  // Turn to face the target FIRST, and wait for the turn: the muzzle, the wedge and the tracer all
  // take their axis from the aim, so a token that is still swinging round when the first round goes
  // would be drawn firing sideways out of its own portrait. The wait is short by spec and it is
  // included in payloadPresentationMs, so the apply window still lands after everything.
  const turn = shooter ? await faceTarget(shooter, aimPointOf(shooter, target, Number(canvas?.dimensions?.size) || 100)) : null;

  // The multi-round-only treatments, queued once for the whole burst before the first round leaves.
  // A single shot never reaches this line, which is the whole gate (see fxBurstAmbience).
  let ambience = { motes: 0 };
  if (burst && shooter) {
    ambience = await fxBurstAmbience(shooter, target, { weaponClass, shots, cadenceMs })
      .catch((err) => { console.warn(`${SCOPE} | burst ambience failed`, err); return { motes: 0 }; });
  }

  // THE INCENDIARY GROUND ELEMENTS, queued ONCE for the whole payload and only when a round LANDED —
  // a burst that misses sets nothing alight. Placed here, outside the round loop, deliberately: the
  // loop is what would make it per-round, so keeping the call out of it IS the once-per-payload gate
  // (the same shape as fxBurstAmbience above). Held back by the class's own crossing time so the fire
  // starts when the round arrives. Not awaited — it must never delay the first round.
  let groundFire = null;
  if (shooter && hits > 0 && ammoEntry?.groundFire) {
    const gridPx = Number(canvas?.dimensions?.size) || 100;
    const at = aimPointOf(shooter, target, gridPx);
    if (at) {
      groundFire = { queued: true, at: { x: Math.round(at.x), y: Math.round(at.y) } };
      fxGroundFire(at, { delayMs: Number(ammoEntry.dashMs) > 0 ? Number(ammoEntry.dashMs) : 0 })
        .catch((err) => console.warn(`${SCOPE} | ground fire failed`, err));
    }
  }

  let flashes = 0;
  let smokePuffs = 0;
  // ⏪ INVERTED (FR#22). This gate used to read "a burst always smokes"; it now reads the opposite. Our
  // puffs are drawn ONLY for a single discharge of a class whose row opts in — today just the shell.
  // A burst gets its smoke from the tracer asset's own curls instead (see the retirement note on
  // smokePlanFor), so drawing ours over it was doubling a smoke that was already there.
  const smokes = !burst && smokesOnSingleShot(weaponClass);
  for (let i = 0; i < shots; i++) {
    if (i > 0) await _sleep(cadenceMs);
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
      fxSmokePuff(shooter, target, { weaponClass, index: smokePuffs })
        .catch((err) => console.warn(`${SCOPE} | smoke puff failed`, err));
      smokePuffs++;
    }
    if (shooter) {
      flashes++;
      // Only the LAST round is tagged: the ruling is that the action is over when the last round's
      // impact/tracer ends, and those are the latest-ending elements on screen by construction.
      fxShot(shooter, target, { weaponClass, hit: i < hits, settleTag: i === shots - 1 ? settleTag : null, ammoKey })
        .catch((err) => console.warn(`${SCOPE} | combat fx shot failed`, err));
    }
  }
  // The last round has left the muzzle; what remains on screen is its terminal elements. The watch is
  // started from HERE rather than computed from the start, so the cadence gaps and the face-target
  // sweep are already spent and cannot be double-counted — whatever the loop actually cost, real time
  // has passed and only the tail is left. What ENDS the wait is the engine reporting those elements
  // gone; the scheduled tail is only the floor and the no-engine fallback.
  // The floor takes the AMMO KEY, so an overlay that lengthens the tail (flechette's crossing time, a
  // promoted impact's own trim) is waited out rather than being drawn past a window that already opened.
  const settleTailMs = presentationTailMs(weaponClass, ammoKey);
  _watchSettleTag(settleTag, settleTailMs, settle);

  return { ...result, shots, hits, flashes, weaponClass, cadenceMs, motes: ambience.motes, smokePuffs,
    turnedDeg: turn ? turn.deltaDeg : null, settleTailMs, ammoKey, groundFire };
}

/* ══════════════════════════ Wiring ══════════════════════════ */

/**
 * Hook wiring — called once from the module's ready hook. Registered unconditionally (like the chat
 * card lock and the PopOut rebinding): the setting is read per event, so a GM toggling combatFxEnabled
 * takes effect immediately with no reload, and the listener is inert while it is off.
 */
export function registerCombatFx() {
  Hooks.on("cyberpunk2020.weaponFired", (payload) => {
    if (!combatFxEnabled()) return;
    fxWeaponFired(payload).catch((err) => console.warn(`${SCOPE} | combat fx failed`, err));
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
