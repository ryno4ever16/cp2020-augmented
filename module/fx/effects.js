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
 */
export const MUZZLE_LIGHT = Object.freeze({
  color: null,            // ILLUMINATION ONLY on this engine — measured divergence, see the note.
                          // Knobs: "#943400" (reference) / "#ffae42" (previous)
  brightSquares: 12.5,    // reference-exact: bright == dim, so attenuation does ALL the falloff
  dimSquares: 12.5,
  attenuation: 1,         // reference-exact, and core's maximum: the fade spans the whole radius
  alpha: 0.5,             // reference-exact; the coloration layer's intensity, inert while color is null
  luminosity: 0.5,        // reference-exact (confirmed against the guide's own module)
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
 * The SPIKY half of the starburst, drawn on top of the aimed lance — optional per class (`spark`).
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
 */
export const HIT_CONFIRM = Object.freeze({
  key: "jb2a.impact.005.orange",
  delayFollowsTracer: true,
});

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
 * The SMOKE WISP — one small puff at the muzzle, angled along the aim, drawn ONCE PER BURST and only
 * for a multi-round payload. Width is the per-class field (`smokeSquares`); everything else is a
 * property of the asset and of the burst.
 *
 * ⚠ SIZE IS THE THING TO GET RIGHT HERE, and the first values shipped were wrong: at 1.4 squares the
 * puff photographed as a large tangled cloud filling the space between shooter and target — a second
 * effect competing with the shot rather than a wisp beside it. The reference's wisp measures about
 * 30x25px on its 165px grid, i.e. under a fifth of a square. The per-class widths below are a
 * compromise on that: appreciably under half a square so it reads as a wisp at the muzzle, but not so
 * small that the asset's own detail disappears into a smudge. Opacity is held low for the same reason
 * — it is meant to be noticed second, after the flash.
 *
 * `key` is the tier's SIDE puff (a directional asset — it drifts one way), which is what lets it
 * carry an aim at all; the centred puff in the same family has no direction to rotate. LIFETIME is
 * asked to be the burst's own length (shots × cadence) so the wisp is still there between rounds and
 * gone shortly after the last one, clamped at both ends: `minMs` so a two-round burst still leaves
 * something visible, `maxMs` so a thirty-round payload does not park smoke on the map.
 */
export const MUZZLE_SMOKE = Object.freeze({
  key: "jb2a.smoke.puff.side.grey",
  minMs: 700,
  maxMs: 2600,
  fadeOutMs: 450,
  opacity: 0.35,
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
 *  - `muzzleSquares: 1.9` — heavier than the rifle's 1.6 so the blast reads as a bigger bore, still
 *    under the heavy class's 2.1 so the largest flash on the table remains the largest weapon on it.
 *    (This is the MUZZLE sprite's drawn width; the tracer takes its size from `dashSquares` instead,
 *    so the two are independent.)
 *  - `tracer: bullet 01` — the THIN variant, where the rifle takes the heavy 02.
 *  - NO `tracerColor` — the shell's pellets are a settled look; the colour shift is for the classes
 *    that draw a single comet.
 *
 * MUZZLE SIZES (all five rows): the reference's flash reaches about 0.6 of a grid square forward of
 * the muzzle. Drawn width 1.6 puts the rifle's lance at roughly that reach, which is where the rifle
 * row sits; the others are stepped off it by bore. Against the previous build these are a 2.5×–4×
 * reduction (`scale: 0.7` drew 4.2 squares), which is the reported "too large" answered by value.
 */
export const FX_CLASSES = Object.freeze({
  pistol:  { sound: "shot-pistol",  muzzle: "jb2a.muzzle_flash.single.01.yellow", tracer: "jb2a.bullet.01.orange", tracerColor: TRACER_COLOR, muzzleSquares: 1.1, spark: true, motes: 8,  smokeSquares: 0.4,  impactSquares: 0.7 },
  smg:     { sound: "shot-smg",     muzzle: "jb2a.muzzle_flash.single.01.yellow", tracer: "jb2a.bullet.01.orange", tracerColor: TRACER_COLOR, muzzleSquares: 1.2, spark: true, motes: 12, smokeSquares: 0.45, impactSquares: 0.75 },
  rifle:   { sound: "shot-rifle",   muzzle: "jb2a.muzzle_flash.single.01.yellow", tracer: "jb2a.bullet.02.orange", tracerColor: TRACER_COLOR, muzzleSquares: 1.6, spark: true, motes: 13, smokeSquares: 0.5,  impactSquares: 0.95 },
  shotgun: { sound: "shot-shotgun", soundBurst: "shot-shotgun-burst", muzzle: "jb2a.muzzle_flash.single.01.yellow", tracer: "jb2a.bullet.01.orange", muzzleSquares: 1.9, spark: true, motes: 10, smokeSquares: 0.6, impactSquares: 1.15, pellets: 6, spreadRad: 0.07, dashSquares: 1, dashMs: 150, cadenceMs: 180 },
  heavy:   { sound: "shot-heavy",   muzzle: "jb2a.muzzle_flash.single.01.yellow", tracer: "jb2a.bullet.02.orange", tracerColor: TRACER_COLOR, muzzleSquares: 2.1, spark: true, motes: 16, smokeSquares: 0.65, impactSquares: 1.3 },
});

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
export function muzzleSourceSpecs({ gridDistance = 1, pixelsPerUnit = 1, aimRad = null, mode = MUZZLE_MODE } = {}) {
  const m = MUZZLE_LIGHT;
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
    color: m.color,
    attenuation: m.attenuation,
    alpha: Number((m.alpha * level).toFixed(3)),
    luminosity: Number((m.luminosity * level).toFixed(3)),
  });
  const wedge = () => ({
    key: "cone", angle: m.coneDegrees, rotation,
    bright, dim,
    color: m.color,
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
export function muzzleFlashLocal(tokenRef, aim = null, { sceneId = null, mode = MUZZLE_MODE } = {}) {
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
    pixelsPerUnit: ppu, aimRad, mode,
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
export function fxMuzzleFlash(shooterToken, aimPoint = null, { mode = MUZZLE_MODE } = {}) {
  const doc = shooterToken?.document ?? shooterToken;
  const tokenId = typeof shooterToken === "string" ? shooterToken : doc?.id;
  if (!tokenId) return false;
  const sceneId = doc?.parent?.id ?? canvas?.scene?.id ?? null;
  const aim = (aimPoint && Number.isFinite(aimPoint.x) && Number.isFinite(aimPoint.y))
    ? { x: Math.round(aimPoint.x), y: Math.round(aimPoint.y) }
    : null;
  try {
    game.socket?.emit?.(`module.${SCOPE}`, { type: MSG_FLASH, sceneId, tokenId, aim });
  } catch (err) {
    console.warn(`${SCOPE} | muzzle flash announce failed`, err);
  }
  return muzzleFlashLocal(tokenId, aim, { sceneId, mode });
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
 * How long one burst's smoke wisp lives: the burst's own length (rounds × cadence), clamped. Pure.
 * Asking for the burst length is what makes the wisp still be there between rounds — the thing the
 * reference shows and a per-shot puff cannot do.
 */
export function burstSmokeMs(shots, cadenceMs) {
  const span = Math.max(0, (Number(shots) || 0)) * (Number(cadenceMs) || 0);
  return Math.min(MUZZLE_SMOKE.maxMs, Math.max(MUZZLE_SMOKE.minMs, Math.round(span)));
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
export async function fxShot(shooterToken, targetToken, { weaponClass, hit = true, light = true, mode = MUZZLE_MODE } = {}) {
  const out = { light: false, muzzle: false, spark: false, tracer: false, pellets: 0, impact: false };
  const entry = FX_CLASSES[weaponClass];
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
  if (light && shooterToken) out.light = fxMuzzleFlash(shooterToken, to, { mode });

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
      if (to && fxDbEntryExists(entry.muzzle)) {
        // Sized in GRID UNITS (a spec, not a scale factor — see MUZZLE_SPRITE), planted at the
        // token's forward edge, and cut short of the clip's smoke-and-fire phase.
        _held(seq.effect().file(entry.muzzle)).atLocation(muzzle)
          .size({ width: entry.muzzleSquares }, { gridUnits: true })
          .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING)
          .timeRange(0, MUZZLE_SPRITE.endMs)
          .rotateTowards(to);
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
        for (const end of ends) {
          const shot = _held(seq.effect().file(entry.tracer)).atLocation(shooterToken)
            .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING);
          // The colour shift, where the class asks for one. A ColorMatrix and not a tint — see
          // TRACER_COLOR for the measurement that rules the tint out.
          if (entry.tracerColor) shot.filter("ColorMatrix", entry.tracerColor);
          if (entry.dashSquares > 0) {
            shot.size({ width: entry.dashSquares }, { gridUnits: true })
              .rotateTowards(end)
              .moveTowards(end, { ease: "linear", rotate: false })
              .duration(_dashMsOverride ?? entry.dashMs);
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
      if (hit && to && entry.impactSquares > 0 && fxDbEntryExists(HIT_CONFIRM.key)) {
        const impact = _held(seq.effect().file(HIT_CONFIRM.key)).atLocation(to)
          .size({ width: entry.impactSquares }, { gridUnits: true })
          .aboveLighting(LIT_SPRITE_ABOVE_LIGHTING);
        const travel = HIT_CONFIRM.delayFollowsTracer && entry.dashSquares > 0
          ? (_dashMsOverride ?? entry.dashMs) : 0;
        if (travel > 0) impact.delay(travel);
        out.impact = true;
      }
      if (out.muzzle || out.tracer || out.impact) await seq.play();
    } catch (err) {
      console.warn(`${SCOPE} | sequencer shot effect failed`, err);
    }
  }
  return out;
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
  const out = { motes: 0, smoke: false };
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
    if (entry.smokeSquares > 0 && fxDbEntryExists(MUZZLE_SMOKE.key)) {
      _held(seq.effect().file(MUZZLE_SMOKE.key)).atLocation(muzzle)
        .size({ width: entry.smokeSquares }, { gridUnits: true })
        .rotateTowards(to)
        .opacity(MUZZLE_SMOKE.opacity)
        .duration(burstSmokeMs(shots, cadenceMs))
        .fadeOut(MUZZLE_SMOKE.fadeOutMs);
      out.smoke = true;
    }
    // NOT awaited, deliberately. The engine's play promise settles somewhere inside the effect's own
    // lifetime, and the wisp is asked to live for the whole burst — so awaiting it here would hold the
    // first round back by up to the wisp's entire duration and the burst would start seconds after the
    // trigger. Measured on this rig before the change: the fan-out's per-round cost went from tens of
    // milliseconds to hundreds, all of it this one await. Queuing is synchronous, so the counts below
    // are already final when this returns.
    if (out.motes || out.smoke) seq.play().catch((err) => console.warn(`${SCOPE} | burst ambience play failed`, err));
  } catch (err) {
    console.warn(`${SCOPE} | burst ambience failed`, err);
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
 *   - the SPARK, which is untrimmed and is the longest of them (MUZZLE_SPARK.clipMs, 267ms measured)
 *   - a travelled tracer's crossing time, for a class that draws one (`dashMs`) — 150ms on the shell
 *     class, i.e. shorter than the spark, but it is read from the row rather than assumed so a class
 *     given a slower dash later is covered without another edit here.
 * A painted (stretched) tracer contributes no travel time — it is drawn along the whole line at once.
 */
export function presentationTailMs(weaponClass) {
  const entry = FX_CLASSES[weaponClass];
  const travel = Number(entry?.dashMs) > 0 ? Number(entry.dashMs) : 0;
  return Math.max(muzzleEnvelopeDurationMs(), MUZZLE_SPRITE.endMs, MUZZLE_SPARK.clipMs, travel);
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
export function presentationMs(shots, weaponClass) {
  const n = Math.min(Math.max(Math.trunc(Number(shots) || 0), 1), MAX_FX_SHOTS);
  return (n - 1) * classCadenceMs(weaponClass) + presentationTailMs(weaponClass);
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
  // The LEAD-IN. When the shooter turns first, the rounds do not start until the turn finishes, so
  // the span a caller waits out has to include it — otherwise the apply window would open a turn's
  // worth of time early, which is the whole thing the wait exists to prevent. Read from the same
  // helper the fan-out uses, so a shot that will not turn adds nothing.
  const shooter = shooterTokenOf(actor);
  const aimTokenId = payload?.targetTokenId ?? payload?.fxTargetTokenId ?? null;
  const target = aimTokenId ? (canvas?.tokens?.get(aimTokenId) ?? null) : null;
  const gridPx = Number(canvas?.dimensions?.size) || 100;
  const leadIn = shooter ? (faceTargetTurn(shooter, aimPointOf(shooter, target, gridPx))?.durationMs ?? 0) : 0;
  return leadIn + presentationMs(shotCountOf(payload), weaponClass);
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
  const result = { shots: 0, hits: 0, flashes: 0, motes: 0, smoke: false, turnedDeg: null, weaponClass: null, cadenceMs: SHOT_CADENCE_MS, skipped: null };
  if (!combatFxEnabled()) return { ...result, skipped: "disabled" };
  const actor = payload?.attackerId ? game.actors?.get(payload.attackerId) : null;
  const weapon = resolveFiredWeapon(payload, actor);
  const weaponClass = weaponFxClass(weapon);
  if (!weaponClass) return { ...result, skipped: "class" };

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
  let ambience = { motes: 0, smoke: false };
  if (burst && shooter) {
    ambience = await fxBurstAmbience(shooter, target, { weaponClass, shots, cadenceMs })
      .catch((err) => { console.warn(`${SCOPE} | burst ambience failed`, err); return { motes: 0, smoke: false }; });
  }

  let flashes = 0;
  for (let i = 0; i < shots; i++) {
    if (i > 0) await _sleep(cadenceMs);
    sfx(weaponClass, { burst });
    // Flash + sprite + tracer all start in the SAME tick as this shot's audio, and none of them is
    // awaited: the loop's timer is the cadence a viewer and a listener both read. Every round of a
    // burst announces its own flash — the per-token cap that keeps that bounded lives in the local
    // runner (one source set per token, each round restarting the envelope), not here, so a round is
    // never silently dropped on the way out.
    if (shooter) {
      flashes++;
      fxShot(shooter, target, { weaponClass, hit: i < hits })
        .catch((err) => console.warn(`${SCOPE} | combat fx shot failed`, err));
    }
  }
  return { ...result, shots, hits, flashes, weaponClass, cadenceMs, motes: ambience.motes, smoke: ambience.smoke,
    turnedDeg: turn ? turn.deltaDeg : null };
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
      muzzleFlashLocal(data.tokenId, data.aim ?? null, { sceneId: data.sceneId ?? null });
    } catch (err) {
      console.warn(`${SCOPE} | muzzle flash relay failed`, err);
    }
  });
  // Nothing is persisted, so there is nothing to sweep up on load — but the sources this client is
  // drawing belong to the scene it is drawing them on, and its lighting collection is emptied under
  // us when the scene changes. Drop the drivers with it.
  Hooks.on("canvasTearDown", () => clearFlashes());
  primeFxSounds().catch(() => { /* listing unavailable → shipped-asset path is used */ });
}
