/**
 * ⭐ WHAT KIND OF FUMBLE THE BASE SYSTEM ACTUALLY RULED — one derivation, four named classes. PURE.
 *
 * ⛔ THE PROBLEM THIS FILE EXISTS FOR. Until 2026-08-26 every reader of a ruled fumble treated all
 * fumbles alike: nothing planted, nothing drawn, no card (see the bails in combat/damage-hooks.js
 * `_placeSpreadZone` and fx/effects.js `fxWeaponFired`). That is right for most of the base's Reflex
 * (Combat) fumble table and WRONG for the biggest slice of it. Core p.43's REFLEX Combat column reads:
 *
 *   1–4  No fumble. You just screw up.                       ← the shot simply MISSED
 *   5    You drop your weapon.                               ← nothing left the barrel
 *   6    Weapon discharges or strikes something harmless.     ← a round left, harmlessly
 *   7    Weapon jams, or knocks you to the ground for 1 round.← nothing left the barrel
 *   8    You manage to wound yourself.                        ← the base's own card owns it
 *   9–10 You manage to wound a member of your own party.      ← the base's own card owns it
 *
 * Rows 1–4 are FORTY PER CENT of the table and they say, in the book's own words, "no fumble" — the
 * shell went down-range and missed. Planting nothing for those was a shot that vanished. p.105 is the
 * line that sends a natural 1 here at all (*"roll an additional 1D10 and check the result against the
 * Fumble Table"*), and p.108 is what an ordinary miss owes a pattern: a scattered true centre.
 * User ruling, 2026-08-26 — decided by the book, text-verified.
 *
 * ⛔⛔ WHERE THE SUB-ROLL COMES FROM, AND WHY IT IS PARSED RATHER THAN READ OFF A FIELD.
 *
 * The base builds the fumble in `buildRangedCombatFumbleData` (base module/utils.js:600). It rolls the
 * table die ONCE (`utils.js:641`, `new Roll("1d10")`), picks its row from `_TABLE_REF_COMBAT`
 * (`utils.js:339-346`), and returns `{ title, html, outcome }` where `outcome` is ONLY
 * `{ discharge, jam, jamRounds }` (`utils.js:611`). `_maybeApplyRangedFumble` (base item/item.js:221)
 * then forwards `{ fumble: { title, html }, forceMiss: true, outcome }` — and every fire path puts
 * **only the `{title, html}` half** on the card's template data (`item.js:545`, `:613`, `:715`,
 * `fumble: rangedFumble?.fumble ?? null`). The `outcome` object never leaves item.js's local scope, so
 * the render our seam wraps cannot see it, and even if it could it would not answer the question: it
 * distinguishes rows 6 and 7 (and only when their reliability check FAILS) and says nothing at all
 * about 1–4 versus 5 versus 8–10.
 *
 * So the ONE place the ruled sub-roll survives into data a consumer can reach is the fumble block's own
 * `html`, where the base wrote it with `_dieSpan(10, fRoll.total, fRoll)` (`utils.js:646`) — a
 * `<a>`/`<span>` carrying the classes `die d10` and the face as its text (`utils.js:286-304`). That is
 * the base's OWN roll, recorded by the base, read once. ⛔ NOTHING HERE RE-ROLLS ANYTHING: a second d10
 * would be a second fumble, and the card on the table would describe a different one.
 *
 * ⭐ THE SHAPE IS ANCHORED, NOT COUNTED BLIND. The base always writes the MAIN attack die first
 * (`Fumble.MainRollLine`, `utils.js:613-615`) and the table die second (`Fumble.TableRollLine`,
 * `utils.js:644-647`); anything after that (a location die, a reliability die) comes later. The main
 * die on this path is ALWAYS 1 — `_maybeApplyRangedFumble` only builds the block when
 * `isFumbleRoll(attackRoll)` is true, and that is `getInitialD10Result(roll) === 1`
 * (base utils.js:282-284). So "first face is 1" is a checkable ANCHOR: if the first `d10` face this
 * function finds is not 1, the html is not the shape this function was written against — a translation
 * that dropped `{die}`, a base version that reordered its lines, a hand-built payload — and it says
 * UNKNOWN rather than guessing. Unknown falls back to the uniform bail, which is the behaviour that
 * shipped before this file existed.
 *
 * ⚠ THE AUTO-ONLY-JAM BRANCH SKIPS THE TABLE ENTIRELY and must never be read positionally. With
 * `autoFumbleOnlyJam` on and an auto-class weapon (`Auto` / `Autoshotgun`), the base takes an early
 * return that rolls a RELIABILITY die instead of a table die (`utils.js:617-638`) — so the second face
 * in the html is not a table row at all. The caller therefore states which branch the base took, from
 * the same two facts item.js uses to choose it (`item.js:226-227`: the weapon's own `_isAutoWeapon`
 * and the `autoFumbleOnlyJam` setting), and this function classifies that branch WITHOUT parsing.
 * Both of its outcomes — a jam, or the "lucky you, it didn't jam - just a misfire" pass
 * (`CYBERPUNK.Fumble.ReliabilityResult.NoJam`) — are rounds that did not go down-range, so the whole
 * branch is `noDischarge`. ⛔ That is a LANE CALL, not the user's ruling: the ruling maps the printed
 * table's ten rows, and this branch prints none of them. It is deliberately the conservative direction
 * — it never invents a shell in flight — and reverting it means classifying the branch's own
 * reliability face instead (the threshold is `reliabilityThreshold`, base utils.js:479).
 *
 * ⛔ ONE DERIVATION, ONE CALLER. `rangedFumbleClassFrom` is called from exactly one place — the seam,
 * where the payload is assembled (module/seam-shim.js) — and its answer rides the payload as
 * `fumbleClass`. Every consumer reads the field through `fumbleClassOf` / `fumbleIsOrdinaryMiss` and
 * NEVER re-derives, for the reason the whole 2026-08-26 defect was about: two rails deriving one
 * verdict is two rails that can disagree about one shell.
 */

/**
 * The four outcome classes, named after the MECHANISM each one describes:
 *
 *  - `plainMiss`          rows 1–4 — a round went down-range and missed. Resolves and presents exactly
 *                         like any other missed shot: the pattern scatters (p.108) and the rail draws it.
 *  - `noDischarge`        rows 5 and 7 — dropped or jammed. No round left the barrel: nothing plants,
 *                         nothing is drawn. (Also the whole auto-only-jam branch; see the note above.)
 *  - `harmlessDischarge`  row 6 — a round left the weapon and struck nothing that matters. No damage
 *                         corridor. Presentation is SILENT today; see the note at the fx bail for why,
 *                         and what it would cost to draw a muzzle for it.
 *  - `ownSide`            rows 8–10 — the shooter or a team-mate is wounded. The base's own fumble card
 *                         is the entire account of the shot; this rail adds nothing to it.
 */
export const FUMBLE_CLASSES = Object.freeze(["plainMiss", "noDischarge", "harmlessDischarge", "ownSide"]);

const _FUMBLE_CLASS_SET = new Set(FUMBLE_CLASSES);

/**
 * Every d10 face the base wrote into a fumble block's html, in the order it wrote them. PURE.
 *
 * Matches the two shapes `_dieSpan` produces (base utils.js:286-304) and nothing else — both carry the
 * class pair `die d10`, and the DAMAGE line of a self-wound row goes through `_inlineRollResult`, which
 * does NOT (`utils.js:305-323`, no `die` class), so a wound row's damage total can never be mistaken
 * for a face. The `data-roll` payload on the anchor form is `encodeURIComponent`d, so it contains no
 * `"` or `>` to run the attribute match past its own tag.
 *
 * @param {string} html the base fumble block's html
 * @returns {number[]} the faces, in document order; empty when the html is absent or carries none
 */
export function fumbleTableDieFaces(html) {
  const src = typeof html === "string" ? html : "";
  if (!src) return [];
  const faces = [];
  const re = /<(?:a|span)\b[^>]*\bclass="[^"]*\bdie\s+d10\b[^"]*"[^>]*>\s*(\d+)\s*</g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) faces.push(n);
  }
  return faces;
}

/**
 * The base's ruled fumble table face for THIS block, or null when the html is not the shape this file
 * was written against. PURE. See the anchor note in the file header — the first face must be the
 * main attack die and must be 1, because that is the only reason a fumble block exists at all.
 *
 * @param {string} html the base fumble block's html
 * @returns {number|null} the table sub-roll (1-10), or null when it cannot be read honestly
 */
export function fumbleTableSubRoll(html) {
  const faces = fumbleTableDieFaces(html);
  if (faces.length < 2) return null;
  if (faces[0] !== 1) return null;          // the anchor did not hold — say unknown, do not guess
  const sub = faces[1];
  return (Number.isInteger(sub) && sub >= 1 && sub <= 10) ? sub : null;
}

/**
 * ⭐ THE ONE DERIVATION. Which outcome class the base's own fumble block describes. PURE.
 *
 * ⛔ Called from ONE place — the seam that assembles the weaponFired payload. Consumers read the
 * resulting `fumbleClass` field; none of them calls this.
 *
 * @param {object} args
 * @param {string} args.html the base fumble block's html (`templateData.fumble.html`)
 * @param {boolean} [args.autoOnlyJamBranch] whether the base took its auto-only-jam early return —
 *   the caller decides this from the weapon and the `autoFumbleOnlyJam` setting, exactly as
 *   base item.js:226-227 does, because that branch prints no table row to read.
 * @returns {"plainMiss"|"noDischarge"|"harmlessDischarge"|"ownSide"|null} null = could not be read
 */
export function rangedFumbleClassFrom({ html, autoOnlyJamBranch = false } = {}) {
  // The branch that never touches the printed table. Jam or misfire — neither puts a round down-range.
  if (autoOnlyJamBranch === true) return "noDischarge";
  const sub = fumbleTableSubRoll(html);
  if (sub === null) return null;
  if (sub <= 4) return "plainMiss";           // "No fumble. You just screw up." — an ordinary miss
  if (sub === 5 || sub === 7) return "noDischarge";  // dropped · jammed/knocked down
  if (sub === 6) return "harmlessDischarge";  // discharged, or struck something harmless
  return "ownSide";                           // 8, 9-10 — the base's card is the whole story
}

/**
 * The class a payload CARRIES, normalised. PURE. Anything that is not one of the four known strings —
 * absent (every payload assembled before this field existed), null, a value from a client on an older
 * build, a hand-built keeper payload — reads as null, and null means "the payload does not say".
 *
 * ⚠ EVERY CONSUMER TREATS NULL AS THE OLD UNIFORM BEHAVIOUR: nothing plants, nothing is drawn. That is
 * deliberate backward compatibility, not a fallback nobody thought about — a relayed payload from a
 * client mid-update must not start scattering patterns on the strength of a field it never sent.
 *
 * @param {object} payload a weaponFired payload
 * @returns {string|null}
 */
export function fumbleClassOf(payload) {
  const raw = payload?.fumbleClass;
  return (typeof raw === "string" && _FUMBLE_CLASS_SET.has(raw)) ? raw : null;
}

/**
 * ⭐ THE ONE QUESTION EVERY CONSUMER ASKS: is this ruled fumble the kind that still put a round
 * down-range at a target it missed? PURE.
 *
 * TRUE for exactly one class — `plainMiss`, the book's rows 1–4 — and for that class the shot is
 * resolved and presented as an ORDINARY MISS by both rails: the corridor plants at the scattered
 * centre, the banded damage and width re-derive there, the grenade-table faces are rolled at the seam,
 * and the fx fan-out draws the miss it would draw for any other missed shot.
 *
 * FALSE for the other three classes AND for a payload that does not say — the uniform bail.
 *
 * ⛔ RESOLUTION AND PRESENTATION MUST ANSWER THIS IDENTICALLY. Both rails call this one function for
 * that reason; the whole defect this work came out of was two rails ruling one shell two ways.
 *
 * @param {object} payload a weaponFired payload
 * @returns {boolean}
 */
export function fumbleIsOrdinaryMiss(payload) {
  if (payload?.fumbleRuled !== true) return false;
  return fumbleClassOf(payload) === "plainMiss";
}

/**
 * Whether this payload's ruled fumble stands the rails down — the negation of the above, spelled out
 * so the four bail sites read as what they are rather than as a double negative. PURE.
 *
 * FALSE for a payload with no ruled fumble at all (there is nothing to stand down), and false for a
 * `plainMiss`. TRUE for `noDischarge`, `harmlessDischarge`, `ownSide`, and for a payload that carries
 * no class.
 *
 * @param {object} payload a weaponFired payload
 * @returns {boolean}
 */
export function fumbleStandsRailsDown(payload) {
  if (payload?.fumbleRuled !== true) return false;
  return !fumbleIsOrdinaryMiss(payload);
}
