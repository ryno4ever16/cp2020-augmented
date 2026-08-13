/**
 * THE GRENADE TABLE'S SCATTER — the rose, the drift arithmetic, and where a missed centre lands.
 *
 * ⭐ WHY THIS IS ITS OWN FILE. Two rails need these numbers and they sit on opposite sides of an import
 * edge: the DAMAGE rail plants the pattern (combat/damage-hooks.js) and the PRESENTATION rail draws the
 * rounds toward it (fx/effects.js), and damage-hooks already imports effects, so effects cannot import
 * back. A copy of a direction table in the second file is exactly how two flows start disagreeing about
 * which way a 3 goes — and here that disagreement is VISIBLE: the rounds fly one way and the pattern
 * lands another. Everything in here is pure and imports nothing, so both sides can read it.
 *
 * Lifted out of damage-hooks on 2026-08-13 with the seam fix; damage-hooks re-exports the rose and the
 * drift so every existing reader (and every keeper) keeps the name it already had.
 */

/**
 * The scatter rose (CP2020 p.108, the Grenade Table). PURE data.
 *
 * ⭐ ONE ROSE, TWO FLOWS. It was a pair of locals inside the grenade scatter while a missed throw was the
 * only thing that scattered; p.108 sends a missed shot PATTERN to the same rules by name, so both read
 * this.
 *
 * The layout is a NUMPAD around the aim point, so the face reads off the keypad a table already has
 * under its hand, and screen axes apply: +y is DOWN, which is why south is +1. Faces 5 and 10 are the
 * table's two no-drift results — a shot that missed the roll can still land where it was pointed, and
 * that is the book's own answer rather than a rounding of ours.
 *
 * ⚠ THIS IS NOT THE ONLY SCATTER ROSE IN THE MODULE, deliberately. `vehicle-indirect.js`
 * `scatterDirectionDeg` spaces ten headings 36° apart with no no-drift face, because it serves
 * Maximum Metal's indirect-fire and bombing tables (MM p.8-9) and those deviate by a computed distance
 * that is never zero. Two different books, two different tables; they are kept apart on purpose.
 *
 * The NAMES stay English here — this is data, and the render edge wraps them with `tryLocalize` (the
 * value-is-key convention, lookups.js line 2), so a table that adds `CYBERPUNK.SW` gets its own word
 * and one that does not keeps the compass point unchanged.
 */
export const SCATTER_ROSE = Object.freeze({
  1:  Object.freeze({ vx: -1, vy:  1, name: "SW" }),
  2:  Object.freeze({ vx:  0, vy:  1, name: "S" }),
  3:  Object.freeze({ vx:  1, vy:  1, name: "SE" }),
  4:  Object.freeze({ vx: -1, vy:  0, name: "W" }),
  5:  Object.freeze({ vx:  0, vy:  0, name: "on-target" }),
  6:  Object.freeze({ vx:  1, vy:  0, name: "E" }),
  7:  Object.freeze({ vx: -1, vy: -1, name: "NW" }),
  8:  Object.freeze({ vx:  0, vy: -1, name: "N" }),
  9:  Object.freeze({ vx:  1, vy: -1, name: "NE" }),
  10: Object.freeze({ vx:  0, vy:  0, name: "direct hit" }),
});

/**
 * The drift a missed throw or a missed pattern takes, in METRES, from the two d10 faces. PURE.
 *
 * The diagonal faces are normalised to unit length before the distance is applied, so a 3 travels the
 * rolled number of metres south-east rather than that many metres on each axis — the table gives one
 * distance, not two. A no-drift face reports `distanceM: 0` however the distance die fell, which is
 * what lets a caller print "landed on the aimed point" without re-deriving the rose.
 *
 * @param {number} dirFace  the 1d10 direction face
 * @param {number} distFace the 1d10 distance face, in metres
 * @returns {{dxM:number, dyM:number, distanceM:number, face:number, name:string}}
 */
export function scatterDriftM(dirFace, distFace) {
  const face = Math.min(10, Math.max(1, Math.round(Number(dirFace) || 1)));
  const { vx, vy, name } = SCATTER_ROSE[face];
  const mag = Math.hypot(vx, vy) || 1;
  const drift = (vx || vy) ? Math.max(0, Number(distFace) || 0) : 0;
  return { dxM: (vx / mag) * drift, dyM: (vy / mag) * drift, distanceM: drift, face, name };
}

/**
 * WHERE THE TRUE CENTRE OF A MISSED SHOT ENDED UP, in pixels. PURE.
 *
 * ⭐ THE SINGLE SITE BOTH RAILS ASK. The pattern is planted about this point and the rounds are drawn
 * toward it; if either side derived it on its own — even with the same two faces in hand — the clamp
 * below would be enough to part them. One function, one answer, two readers.
 *
 * `sceneRect` clamps the centre onto the map when the drift would carry it off the edge: a corridor
 * pointed at nothing outside the scene is a corridor nobody can read. Walls are NOT consulted — a wall
 * does not stop a point from being a point, and whether a wall shields the figures standing near it is
 * the cover exemption's job, which runs later on the corridor this point produces.
 *
 * @param {object} args
 * @param {number} args.aimedX the centre AS DECLARED, in pixels — where the shooter pointed
 * @param {number} args.aimedY
 * @param {number} args.pixelsPerMeter
 * @param {number} args.dirFace  the 1d10 direction face
 * @param {number} args.distFace the 1d10 distance face, in metres
 * @param {{x:number,y:number,width:number,height:number}} [args.sceneRect]
 * @returns {{x:number, y:number, driftM:number, dirName:string, dirFace:number, clamped:boolean}}
 */
export function scatterLandedPoint({
  aimedX = 0, aimedY = 0, pixelsPerMeter = 1, dirFace = 1, distFace = 0, sceneRect = null,
} = {}) {
  const ppm = Number(pixelsPerMeter) > 0 ? Number(pixelsPerMeter) : 1;
  const drift = scatterDriftM(dirFace, distFace);
  let x = aimedX + drift.dxM * ppm;
  let y = aimedY + drift.dyM * ppm;
  let clamped = false;
  if (sceneRect && Number.isFinite(sceneRect.x) && Number.isFinite(sceneRect.width)) {
    const cx = Math.min(Math.max(x, sceneRect.x), sceneRect.x + sceneRect.width);
    const cy = Math.min(Math.max(y, sceneRect.y), sceneRect.y + sceneRect.height);
    clamped = cx !== x || cy !== y;
    x = cx; y = cy;
  }
  return { x, y, driftM: drift.distanceM, dirName: drift.name, dirFace: drift.face, clamped };
}

/**
 * THE TWO FACES A MISSED PATTERN SHOULD SCATTER ON, or null when this shot does not scatter. PURE.
 *
 * ⛔ THE DECISION AND THE DICE MUST HAPPEN ONCE, ON THE FIRING CLIENT — that is the whole point of this
 * function existing next to the roll rather than inside the plant. See the note at the roll site in
 * seam-shim.js.
 *
 * A shot scatters when the shooter DECLARED a corridor (an undeclared shot has no aimed centre to miss
 * from — the plant computes an axis instead) and the base system RULED IT A MISS. Both facts are already
 * on the payload by the time it is assembled; nothing is re-derived and nothing is rolled here.
 *
 * @param {object} payload a weaponFired payload, as far as it has been assembled
 * @returns {boolean} whether this shot's centre needs the grenade table
 */
export function payloadScattersOnMiss(payload) {
  if (!payload?.spreadAim) return false;
  const total = payload.attackTotal, dc = payload.toHitDC;
  // ⚠ Absent means absent. `Number(null)` is 0 — a finite number — so a payload whose verdict fields
  // were never computed would otherwise be ruled a miss against a DC of zero and scatter every time.
  if (total === null || total === undefined || dc === null || dc === undefined) return false;
  const t = Number(total), d = Number(dc);
  if (!Number.isFinite(t) || !Number.isFinite(d)) return false;
  return t < d;
}
