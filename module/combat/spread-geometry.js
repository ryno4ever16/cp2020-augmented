/**
 * The shot pattern's PURE geometry questions — what corridor was declared, did the base system rule
 * the shot a hit, and where a missed corridor actually went. Moved here from damage-hooks.js
 * (2026-08-14) for the same reason the grenade table lives in scatter-table.js: BOTH rails read these
 * answers. The damage flow plants and applies by them; the presentation rail (fx/effects.js) sounds a
 * corridor's victims at its rounds' arrival by them — and effects.js cannot import damage-hooks.js
 * (damage-hooks imports the rail; the reverse edge would be a cycle), while a second copy of this
 * arithmetic is how a preview starts promising a corridor the plant does not honour. One home, no
 * cycle, one answer. Everything here is PURE: no document, no canvas, no setting.
 */

import { spreadBandSpec } from "../lookups.js";
import { scatterLandedPoint } from "./scatter-table.js";
import { SPREAD_MIN_LENGTH_M, SPREAD_MIN_WIDTH_M } from "./spread-placement.js";

/**
 * THE CORRIDOR THE SHOOTER DECLARED, or null when nobody declared one.
 *
 * Exported and pure so both the plant and the keeper read the same answer: a payload either carries a
 * usable corridor — a finite angle, a positive reach, a positive width — or it does not, and there is
 * no half-declared state in between. A record that fails any of these is treated as absent rather than
 * repaired, so a malformed aim degrades to the computed axis instead of planting a corridor of NaN.
 *
 * @param {object} payload a weaponFired payload
 * @returns {null|{angleDeg:number, reachM:number, lengthM:number, widthM:number, band:string}}
 */
export function declaredSpreadAim(payload) {
  const a = payload?.spreadAim;
  if (!a) return null;
  const angleDeg = Number(a.angleDeg), reachM = Number(a.reachM);
  const lengthM = Number(a.lengthM), widthM = Number(a.widthM);
  if (!Number.isFinite(angleDeg) || !(reachM > 0) || !(lengthM > 0) || !(widthM > 0)) return null;
  // A record that names no band has one derived from its own reach — against the firing weapon's range,
  // which the payload carries beside the aim, because the band edges are fractions of it (Core p.99).
  const band = ["Short", "Medium", "Long"].includes(a.band)
    ? a.band : spreadBandSpec(reachM, {}, payload?.spreadRangeM).band;
  return { angleDeg, reachM, lengthM, widthM, band };
}

/**
 * DID THE SHOT ACTUALLY HIT WHAT IT WAS POINTED AT — as the BASE SYSTEM already ruled it, or null when
 * the payload does not say.
 *
 * ⛔ NOTHING IS ROLLED HERE, AND THAT IS THE WHOLE DESIGN. The base system rolls exactly one attack per
 * fire card (`attackRoll` — REF + the attack skill + every modifier the window folded in + the weapon's
 * accuracy) and compares it against the DC its own range table gives the declared band (`rangeDCs`,
 * the base's lookups.js). Both numbers ride the payload from the render (seam-shim.js). A second roll
 * here would be a second answer to a question that has already been answered, sitting in the same chat
 * log as the base's own card saying otherwise.
 *
 * Null — a payload that carries neither number — means "nobody asked whether this hit", and the flow
 * that reads it plants where it was aimed, which is what every pattern did before this existed. A shot
 * driven straight through `_placeSpreadZone` (a macro, the keeper's own placement legs) lands there.
 *
 * @param {object} payload a weaponFired payload
 * @returns {null|{hit:boolean, total:number, dc:number}}
 */
export function spreadAttackOutcome(payload) {
  const rawTotal = payload?.attackTotal, rawDc = payload?.toHitDC;
  // ⚠ THE NULL CHECK IS LOAD-BEARING, not defensive tidiness. `Number(null)` is 0 — a finite number —
  // so a payload that reached here over the socket with its fields nulled (JSON has no NaN) would
  // otherwise rule the shot a HIT against a DC of zero on every relayed player shot. Absent means
  // absent; only a real number is an answer.
  if (rawTotal === null || rawTotal === undefined || rawDc === null || rawDc === undefined) return null;
  const total = Number(rawTotal), dc = Number(rawDc);
  if (!Number.isFinite(total) || !Number.isFinite(dc)) return null;
  return { hit: total >= dc, total, dc };
}

/**
 * WHERE A MISSED PATTERN ACTUALLY WENT — the declared corridor re-derived about a scattered centre. PURE.
 *
 * CP2020 p.108 hands a missed pattern to the grenade rules: *"If the target is missed, the true center
 * of the attack must be determined"* — 1d10 for a direction off the Grenade Table, 1d10 for the metres.
 * So the thing that moves is the corridor's TRUE CENTRE, meaning the point the shooter aimed at; the
 * MUZZLE does not move, because the shell still left the same barrel. Everything else falls out of the
 * new geometry rather than being carried over from the aim:
 *   - the heading is re-read from the muzzle to the scattered point,
 *   - the reach is the new distance, so the range BAND re-derives, and with it the book's width and
 *     the banded damage — a pattern that scatters long really does spread wider and hit softer.
 * That is the same one derivation the aim preview and the plant already share (`spreadBandSpec`), so a
 * scattered corridor cannot be a different shape of the same rule from an aimed one.
 *
 * ⏪ NOTHING IS RECOVERED FROM THE DECLARED WIDTH ANY MORE. While the width wheel existed this function
 * reconstructed the table's ±1 m per notch — `declared.widthM − spreadBandSpec(declared.reachM).widthM`
 * — and re-applied it on top of the new band's width. The wheel was retired on 2026-08-16 (no book
 * behind it; see combat/spread-placement.js), so a declared corridor's width is now always either the
 * band's own or the load's printed one for that band, and BOTH of those re-derive correctly from the
 * new band on their own. Recovering a difference that is structurally zero would only be a way to carry
 * an arithmetic error across the scatter. Still floored at the same metre, for the same reason (a
 * zero-width corridor is a line nobody can stand in).
 *
 * ⭐ THE BAND LADDER NEEDS NO CAP, and this is worth saying out loud because it looks like a missing
 * guard: `spreadBandSpec` SATURATES — past the firing weapon's own full range the Long row simply
 * continues — so a shell that scatters past its own reach earns the outermost band's width and the
 * outermost band's damage and nothing further. The pellets gain no reach they did not have; the
 * corridor is simply the longest, widest, weakest one the book describes. Nothing to clamp.
 *
 * `sceneRect` clamps the centre onto the map when the drift would carry it off the edge — a corridor
 * pointed at nothing outside the scene is a corridor nobody can read. Walls are NOT consulted: a wall
 * does not stop a point from being a point, and whether a wall shields the figures standing near it is
 * the cover exemption's job (`_spreadPatternOccupants`), which runs on the corridor this returns.
 *
 * @param {object} args
 * @param {number} args.originX      the muzzle, in pixels — unchanged by the scatter
 * @param {number} args.originY
 * @param {object} args.declared     the corridor the shooter confirmed (declaredSpreadAim's shape)
 * @param {object} [args.widths]     the load's own per-band widths, for the re-derivation
 * @param {number} [args.rangeM]     the firing weapon's own Long range — what the band edges are
 *   fractions of, so the NEW distance lands in the same band ladder the aim was measured against
 * @param {number} args.pixelsPerMeter
 * @param {{x:number,y:number,width:number,height:number}} [args.sceneRect]
 * @param {number} args.dirFace      the 1d10 direction face
 * @param {number} args.distFace     the 1d10 distance face, in metres
 * @param {number} [args.overshootM] how far past the new centre the corridor runs (see the plant)
 * @returns {{angleDeg:number, reachM:number, lengthM:number, widthM:number, band:string,
 *           aimX:number, aimY:number, driftM:number, dirName:string, dirFace:number, clamped:boolean}}
 */
export function scatteredSpreadCorridor({
  originX = 0, originY = 0, declared, widths = {}, rangeM = null, pixelsPerMeter = 1,
  sceneRect = null, dirFace = 1, distFace = 0, overshootM = 0,
} = {}) {
  const ppm = Number(pixelsPerMeter) > 0 ? Number(pixelsPerMeter) : 1;
  const rad = (Number(declared.angleDeg) * Math.PI) / 180;
  // The centre as declared: where the shooter clicked, which is `reachM` along the confirmed heading.
  const aimedX = originX + Math.cos(rad) * declared.reachM * ppm;
  const aimedY = originY + Math.sin(rad) * declared.reachM * ppm;

  // The landed centre comes from the SHARED site (combat/scatter-table.js), because the presentation
  // rail asks the same question of the same two faces and derives the point the rounds fly to. Two
  // derivations — even from identical dice — part company at the clamp.
  const { x: aimX, y: aimY, driftM, dirName, dirFace: face, clamped } = scatterLandedPoint({
    aimedX, aimedY, pixelsPerMeter: ppm, dirFace, distFace, sceneRect,
  });

  const reachM = Math.max(SPREAD_MIN_LENGTH_M, Math.hypot(aimX - originX, aimY - originY) / ppm);
  const angleDeg = (Math.atan2(aimY - originY, aimX - originX) * 180) / Math.PI;
  const spec = spreadBandSpec(reachM, widths, rangeM);
  return {
    angleDeg, reachM,
    lengthM: Math.max(SPREAD_MIN_LENGTH_M, reachM + (Number(overshootM) || 0)),
    widthM: Math.max(SPREAD_MIN_WIDTH_M, spec.widthM),
    band: spec.band,
    aimX, aimY, driftM, dirName, dirFace: face, clamped,
  };
}
