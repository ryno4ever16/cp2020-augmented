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
// WHICH ROW OF THE BASE'S FUMBLE TABLE WAS RULED — read from the payload's carried field, never derived
// here (the derivation has one caller, the seam). See combat/fumble-outcome.js.
import { fumbleClassOf, fumbleIsOrdinaryMiss } from "./fumble-outcome.js";

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
 * ⭐⭐ THE BASE'S RULED BOOLEAN IS PREFERRED OVER THE COMPARISON (2026-08-26 — the defect that sent me
 * here). Re-deriving hit-or-miss from the two numbers looked equivalent to reading the base's own
 * verdict, and it is not, because the base rules on more than the arithmetic: `_maybeApplyRangedFumble`
 * (base item/item.js:221) sets `forceMiss` on every fumble the table resolves, and EVERY fire path then
 * zeroes its own hit count from that flag — autofire item.js:508, the burst item.js:577, semi-auto
 * item.js:690 — so the card the base posts says MISS while its `attackRoll.total` still stands well over
 * the DC. Reproduced at the table: a fumbled shell posted the base's fumble card and drew no
 * presentation at all, while this function's comparison ruled the same shot a hit and the corridor card
 * announced "31 vs 15 — hit". One shot, two verdicts, in the same chat log — the exact failure the
 * paragraph above says this function exists to prevent, arriving through the one input it did not read.
 *
 * So the ORDER is: a ruled fumble is a miss; else the base's own `baseHit` when the payload carries it;
 * else the comparison, for payloads that carry no verdict at all.
 *
 * ⏪ THE COMPARISON FALLBACK IS `>=` — MEETS-IT-BEATS-IT — AND IT IS NOT A CHOICE THIS FUNCTION MAKES.
 * It mirrors the base's own semi-auto rule (`attackRoll.total >= DC`, item.js:689), which is the path a
 * plain shotgun ALWAYS takes: `__getFireModes` (item.js:408) gives a non-auto weapon semi-auto and
 * nothing else, so every ordinary buckshot pattern is ruled by that line. The base is NOT uniform about
 * this — its autofire path counts rounds as `total − DC` (item.js:503) and so rules a TIE zero hits,
 * a miss — which means "the base's tie rule" is a different answer per fire mode and cannot be restated
 * here as one constant. It does not have to be: an autoshotgun's fired-in-anger tie now arrives with
 * `baseHit: false` on the payload and is ruled a miss by the base's own word, above the fallback. Only
 * an UNSTAMPED payload (a macro, a keeper placement, a client mid-update) reaches the comparison, and
 * for those the semi-auto rule is the honest default. ⛔ Do not flip this to strictly-over without
 * flipping `payloadScattersOnMiss` in the same edit — see the note there.
 *
 * @param {object} payload a weaponFired payload
 * @returns {null|{hit:boolean, total:number, dc:number, hits:number|null, fumbled:boolean,
 *   fumbleClass:("plainMiss"|"noDischarge"|"harmlessDischarge"|"ownSide"|null),
 *   source:"fumble"|"base"|"derived"}}
 */
export function spreadAttackOutcome(payload) {
  const rawTotal = payload?.attackTotal, rawDc = payload?.toHitDC;
  // ⚠ THE NULL CHECK IS LOAD-BEARING, not defensive tidiness. `Number(null)` is 0 — a finite number —
  // so a payload that reached here over the socket with its fields nulled (JSON has no NaN) would
  // otherwise rule the shot a HIT against a DC of zero on every relayed player shot. Absent means
  // absent; only a real number is an answer.
  //
  // ⚠ AND THE TWO NUMBERS REMAIN THE ENTRY CONDITION even now that the ruled boolean outranks them,
  // because the corridor's own card PRINTS them ("31 vs 15 — hit"): an outcome object with a verdict
  // and no numbers behind it would put a line reading "null vs null" on the table. Every card the base
  // renders through multi-hit.hbs computes `toHit` and `attackRoll` beside its `hit`, so this costs
  // nothing real — the only payloads it turns away are the ones that never went down a barrel.
  if (rawTotal === null || rawTotal === undefined || rawDc === null || rawDc === undefined) return null;
  const total = Number(rawTotal), dc = Number(rawDc);
  if (!Number.isFinite(total) || !Number.isFinite(dc)) return null;
  // A RULED FUMBLE IS A MISS, ahead of everything. `fumbleRuled` is true only when the base's fumble
  // TABLE actually resolved a fumble (seam-shim.js forwards `templateData.fumble`), and every path that
  // builds that block also sets `forceMiss` — so this is not a second opinion about the roll, it is the
  // same ruling read one field earlier. It sits above `baseHit` rather than trusting it because the
  // fail-safe direction for "the gun misbehaved" is that nothing went down-range.
  const fumbled = payload?.fumbleRuled === true;
  // THE BASE'S OWN WORD, when the payload carries it. Strictly a boolean — an absent field, a null over
  // the socket, or anything else is "the payload does not say" and falls through to the comparison.
  const ruled = typeof payload?.baseHit === "boolean" ? payload.baseHit : null;
  const rawHits = payload?.baseHits;
  const hits = (rawHits === null || rawHits === undefined || !Number.isFinite(Number(rawHits)))
    ? null : Number(rawHits);
  if (fumbled) {
    // ⭐ THE VERDICT IS STILL "MISS" FOR EVERY FUMBLE — what CHANGED on 2026-08-26 is that the outcome
    // now says WHICH KIND, because the table does not rule one thing (Core p.43). A rows-1–4 fumble is
    // an ordinary miss and the pattern scatters for it; the other classes put no round down-range and
    // nothing is planted or drawn at all. The class is carried, not re-derived: the seam derived it once
    // from the base's own table die (combat/fumble-outcome.js) and every reader switches on the field.
    return { hit: false, total, dc, hits: 0, fumbled: true, fumbleClass: fumbleClassOf(payload), source: "fumble" };
  }
  if (ruled !== null) return { hit: ruled, total, dc, hits, fumbled: false, fumbleClass: null, source: "base" };
  return { hit: total >= dc, total, dc, hits, fumbled: false, fumbleClass: null, source: "derived" };
}

/**
 * WHETHER THIS SHOT'S CENTRE NEEDS THE GRENADE TABLE, or false when it does not. PURE.
 *
 * ⛔ THE DECISION AND THE DICE MUST HAPPEN ONCE, ON THE FIRING CLIENT — that is the whole point of this
 * predicate living beside the roll rather than inside the plant. See the note at the roll site in
 * seam-shim.js.
 *
 * A shot scatters when the shooter DECLARED a corridor (an undeclared shot has no aimed centre to miss
 * from — the plant computes an axis instead) and the base system RULED IT A MISS. Both facts are already
 * on the payload by the time it is assembled; nothing is re-derived and nothing is rolled here.
 *
 * ⛔ ONE VERDICT, ASKED ONCE. This reads `spreadAttackOutcome` rather than re-comparing the two numbers
 * itself, and that is the fix for the second half of the 2026-08-26 defect: while it carried its own
 * `total < dc` it could not see a ruled fumble either, so on a fumbled shell the seam rolled NO scatter
 * faces and announced no drift — and had the plant been left to rule the same shot a miss on its own, it
 * would have scattered on dice the presentation never saw. A predicate and the flow it gates must not be
 * able to disagree about what "miss" means.
 *
 * ⏪ MOVED HERE FROM combat/scatter-table.js on 2026-08-26 for that one reason, and the direction of the
 * move is forced: this file already imports the drift table, so the verdict could not travel the other
 * way without a cycle. What is left in scatter-table.js is the TABLE — the 1d10 faces and the drift
 * arithmetic — which is what that file is named after.
 *
 * A RULED FUMBLE DOES NOT SCATTER. Nothing is planted for one at all (damage-hooks `_placeSpreadZone`)
 * and nothing is drawn for one (fx/effects.js), so rolling its faces would light the "the pattern
 * scattered N metres <direction>" notice over a shot that produced no pattern to scatter.
 *
 * @param {object} payload a weaponFired payload, as far as it has been assembled
 * @returns {boolean} whether this shot's centre needs the grenade table
 */
export function payloadScattersOnMiss(payload) {
  if (!payload?.spreadAim) return false;
  const outcome = spreadAttackOutcome(payload);
  if (!outcome) return false;
  // ⭐ A ROWS-1–4 FUMBLE SCATTERS LIKE ANY OTHER MISS (2026-08-26). The book calls that row "No fumble.
  // You just screw up." — the shell left the barrel and missed, which is precisely the case p.108 sends
  // to the grenade table. The other three classes put no round down-range, so there is no centre to
  // move and rolling their faces would light the "the pattern scattered N metres <direction>" notice
  // over a shot that produced no pattern. `fumbleIsOrdinaryMiss` is the ONE predicate the plant and the
  // presentation rail both ask, so the faces are rolled exactly when a corridor will be built from them.
  if (outcome.fumbled) return fumbleIsOrdinaryMiss(payload);
  return !outcome.hit;
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
