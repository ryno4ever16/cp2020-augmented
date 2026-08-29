/**
 * AREA-DELIVERY WEAPONS — the one derivation that says a fired thing ARRIVES SOMEWHERE AND GOES OFF,
 * and how wide the area it covers is.
 *
 * ⛔ WHY THIS FILE EXISTS RATHER THAN A PREDICATE IN EACH RAIL. Three readers need the same answer and
 * two of them cannot import the third:
 *   · the DAMAGE rail (combat/damage-hooks.js) — whether a payload routes into the p.108 blast flow
 *     instead of the single-target apply, and what radius the area is created at;
 *   · the PRESENTATION rail (fx/effects.js) — whether the shot is drawn as a delivered object rather
 *     than as a bullet, and which of the two delivery pictures it takes;
 *   · the ATTACK gesture (actor/actor-sheet.js) — whether a weapon with no rollable warhead of its own
 *     is a launcher whose ROUND supplies the damage, and WHICH round that is when the tube is empty.
 * damage-hooks already imports effects, so effects cannot import back — the same constraint that put
 * the grenade table's rose in combat/scatter-table.js. This file imports ONLY the caliber registry
 * (lookups.js, whose own imports are constants.js and system-api.js — no rail imports it back), so any
 * of the three may still read it. It is imported rather than re-derived because the module already owns
 * one answer to "can this round be loaded into this weapon" (`caliberMatches`), and the round-defaulting
 * ladder below must give the SAME answer the reload picker gives or a GM would be offered one set of
 * rounds and defaulted another.
 *
 * ⛔ NOTHING HERE DECIDES ANYTHING NEW ABOUT THE BLAST. The confirm card, the grenade-table scatter,
 * the falloff ladder and the cover charging are the existing p.108 flow, untouched; this only widens
 * the door that flow already has (`effectTypes: ["Explosive"]` on a loaded round) so that a weapon
 * which IS its own warhead — a grenade — can walk through it too.
 *
 * ─────────────────────────── THE BOOK, TEXT-LAYER VERIFIED 2026-08-27 ───────────────────────────
 *
 * ⚠ p.108 DOES NOT PRINT A RADIUS. The page the unit was specified against is the AREA EFFECT WEAPONS
 * rules page, and what it prints is the targeting rule and the scatter rule, verbatim:
 *
 *   "Attacks are made as with other ranged weapons, with the center of the area effect falling on the
 *    designated target, and anything within the area of effect taking damage as well. If the target is
 *    missed, the true center of the attack must be determined. When calculating where a grenade or
 *    other Area weapon has hit, roll 1D10 to determine the directrion on the Grenade Table, then roll
 *    a second D10 to see how many meters away it hit."          — CP2020 Core p.108 [sic "directrion"]
 *
 * Both halves of that are ALREADY BUILT, and since 2026-08-28 they are ONE step: damage-hooks
 * `_placeExplosion` centres the area on the designated target for a throw that landed, and for one that
 * missed it rolls the two faces off combat/scatter-table.js itself and creates the area at the point
 * they name. Nothing is left for the referee to press — the confirm card states which of the two
 * happened.
 *
 * ⚠ THE NUMBER IS ON TWO OTHER PAGES, and only one of them is unambiguous:
 *
 *   p.110, prose, unambiguous: "Grenades come in fragmentation, incendiary, stun, dazzle, sonic,
 *   concussion and gas varieties. Each type has its own area of effect, usually between 2 to 5
 *   meters." — a BAND, not a figure.
 *
 *   p.99, AREA EFFECT TABLE, the per-type column. Text layer, verbatim rows:
 *       "Grenades .......................................... Sm"
 *       "RPG....... .. .................................. .4m"
 *       "Missile ............................................ 6m"
 *       "Micromissile ................................ 2m each"
 *       "Shotgun (Clos.e) ............................... 1 m"
 *       "Shotgun (Med) ................................. 2m"
 *       "Shotgun (Lng/Ext) ............................ 3m"
 *
 * ⛔ SO THE GRENADE FIGURE IS AN OCR GLYPH, NOT A DIGIT — "Sm", the documented S↔5 confusion class
 * (memory `ocr-error-awareness`). It is reported rather than asserted, and this constant is the place
 * a ruling lands. What the reading has going for it, stated so a reader can weigh it:
 *   · ANCHOR-VALIDATION of the same table's numeric column: its three Shotgun rows read 1 m / 2 m /
 *     3 m, which is exactly the independently text-verified SHOTGUN TABLE on p.109 (memory
 *     `reference-shotgun-pattern-table`). The column extracts faithfully; only the glyph is in doubt.
 *   · p.110's prose band tops out at 5 m, and 5 is the only digit consistent with both pages.
 *   · the same table's C-6 row reads "Sm !kg" (5 m/kg) — the identical glyph in the identical column.
 * ⏪ REVERT / RE-RULE: `grenade` below is the one field. Nothing else moves.
 *
 * The two rows that need no ruling are carried as printed: Missile 6 m, RPG 4 m.
 *
 * ⛔ AND A WEAPON'S OWN `blastRadius` STILL WINS. These are the fallback for a catalogue weapon that
 * carries no radius of its own (every grenade in the shipped packs); a GM who types a number on the
 * item or on the loaded round is answered with THEIR number, which is the action-as-consent rule this
 * project applies everywhere (memory `feedback-action-as-consent-rules`).
 */
import { caliberMatches, normalizeCaliber } from "../lookups.js";

/** Area of effect in metres, by delivery kind — CP2020 p.99 AREA EFFECT TABLE (see the header). */
export const AREA_DELIVERY_RADIUS_M = Object.freeze({
  // ⚠ THE OCR-AMBIGUOUS ROW ("Sm"). See the header for the anchor-validation and the revert note.
  grenade: 5,
  // Printed cleanly in the same column, no ambiguity.
  missile: 6,
  rpg: 4,
});

/**
 * How much of the radius takes FULL damage before the falloff ladder starts, in metres.
 *
 * ⛔ NOT A NEW RULE — it is the field the existing flow already reads (`blastFullDamageWithin`, whose
 * own default at both the item sheet and `_placeExplosion` is 1). Repeated here only so a weapon that
 * carries no value of its own reaches the flow with the SAME number the flow would have defaulted to,
 * rather than with a second opinion.
 */
export const AREA_DELIVERY_FULL_WITHIN_M = 1;

/**
 * WHICH DELIVERY KIND AN ATTACK TYPE IS, or null for every ordinary shot.
 *
 * The attack type is the base system's own field for exactly this question (lookups.js
 * `rangedAttackTypes`) and it is what the shipped catalogue already records: the heavy pack's
 * grenades and its Grenade Launcher are all `attackType: "Grenade"`, the Scorpion 16 is
 * `attackType: "Missile"`. Matched case-insensitively and trimmed, because pack data is hand-typed.
 *
 * "Rocket" and "RPG" are accepted alongside "Missile" although no shipped item uses them: they are
 * the names a GM authoring a launcher reaches for, and answering them costs one array entry.
 */
export function areaDeliveryKind(attackType) {
  const a = String(attackType ?? "").trim().toLowerCase();
  if (a === "grenade") return "grenade";
  if (a === "missile" || a === "rocket") return "missile";
  if (a === "rpg") return "rpg";
  return null;
}

/**
 * THE PAYLOAD'S DELIVERY, or null — the form the damage rail asks in.
 *
 * `{ kind, radiusM }`, where `radiusM` is the payload's OWN `blastRadius` when it carries one (a
 * loaded round with a radius typed on it, or an item a GM has stated) and the book's row otherwise.
 * Reads only fields the seam already puts on a weaponFired payload, so it works identically on the
 * firing client and on a payload relayed to the GM as JSON.
 */
export function areaDeliveryOf(payload) {
  const kind = areaDeliveryKind(payload?.attackType);
  if (!kind) return null;
  const own = Number(payload?.blastRadius);
  const radiusM = (Number.isFinite(own) && own > 0) ? own : (AREA_DELIVERY_RADIUS_M[kind] ?? 0);
  return { kind, radiusM };
}

/**
 * DOES THIS PAYLOAD DETONATE — the ONE predicate the damage rail's two halves both read.
 *
 * ⛔ IT MUST BE ONE CALL, and the file it lives in is why: `_hookWeaponFired` skips the single-target
 * apply for a detonating payload and `_hookExplosion` claims it, and those two are the two halves of
 * one either/or. If they ever disagreed, a grenade would either be damaged twice (dialog AND blast) or
 * not at all — the identical trap the shot pattern's own comment records against `_spreadModeOf`.
 *
 * True for the load-driven route this flow has always had (an ammo item whose `effectTypes` include
 * "Explosive") and, since 2026-08-27, for a weapon that IS its own warhead.
 */
export function payloadDetonates(payload) {
  const t = payload?.effectTypes;
  const types = Array.isArray(t) ? t : (typeof t === "string" && t ? [t] : []);
  if (types.includes("Explosive")) return true;
  return !!areaDeliveryKind(payload?.attackType);
}

/**
 * DOES THIS WEAPON DETONATE — the same question as `payloadDetonates`, asked of the ITEM instead of
 * the datagram, because two readers have to ask it BEFORE a payload exists.
 *
 * ⛔ WHY IT IS A SECOND FUNCTION RATHER THAN A CALL INTO THE FIRST. `payloadDetonates` reads a flat
 * relay object whose fields the seam has already gathered; an ITEM keeps the same two facts in two
 * different places — its own `attackType` (through the weapon-system indirection, so a Weapon-typed
 * cyberware answers off its nested block, exactly as `areaDeliveryIsLaunched` reads it) and its LOADED
 * ROUND's `effectTypes`, which live on a different document entirely. Both halves are the same two
 * halves the payload predicate has, in the same order, so the two can never disagree about a shot:
 * whatever this says before the trigger is pulled is what that says about the payload it produced.
 *
 * The two readers, and what each is protecting against:
 *   · the ATTACK MODIFIERS window (lookups.js `rangedModifiers`) — a called-shot row on a weapon whose
 *     damage is resolved per-figure by the blast is a paid no-op, so the row is not offered;
 *   · the ATTACK gesture (actor/actor-sheet.js `_cpFireThroughDamageGuard`) — the base's point-blank
 *     maximize must not decide a warhead's yield.
 *
 * `effectTypes` is coerced exactly as the payload predicate coerces it (array, bare string, junk), so a
 * hand-authored round carrying the word as a plain string still answers and a round carrying
 * "Non-Explosive" is not read as a substring match.
 */
export function weaponDetonates(weapon) {
  if (areaDeliveryKind(weapon?._getWeaponSystem?.()?.attackType ?? weapon?.system?.attackType)) return true;
  const t = loadedRoundOf(weapon)?.system?.effectTypes;
  const types = Array.isArray(t) ? t : (typeof t === "string" && t ? [t] : []);
  return types.includes("Explosive");
}

/**
 * IS THIS STRING SOMETHING `Roll` CAN EVALUATE — the guard's whole question.
 *
 * ⛔ THE DEFECT IT ANSWERS (reported from the table): the Grenade Launcher's shipped damage is the
 * literal word **"Varies"**, and the base system's fire path builds `new Roll(system.damage, …)` from
 * it unconditionally (base item/item.js `__semiAuto`). Foundry's parser turns an unrecognised word
 * into a `StringTerm` and then throws `Unresolved StringTerm Varies` out of the fire call — the shot
 * dies with an uncaught error and the window stays open with nothing said. The shipped catalogue has
 * six more of them: "Gas", "Stun", "Deaf", "Blind" and the two states of an empty launcher.
 *
 * DELIBERATELY CONSERVATIVE, and the direction matters. This answers "is it plainly a dice/number
 * expression", so anything exotic a GM types is refused with a message rather than allowed through to
 * throw. Roll-data references are substituted for a number first, because the base itself builds
 * `${damage}+@strengthBonus` on the melee path and a formula naming one has to pass; what is left
 * must be nothing but digits, `d`, the four operators, parentheses and spaces — and must contain at
 * least one digit, so `""` and a bare `"dd"` are both refused.
 *
 * Measured against the shipped catalogue: `7d6`, `4d6`, `7d10`, `2d6+1`, `(2d6+1)*2` and
 * `@strengthBonus` all pass; `Varies`, `Gas`, `Stun`, `Deaf`, `Blind` and `""` are all refused.
 */
export function damageFormulaIsRollable(formula) {
  const s = String(formula ?? "").trim();
  if (!s) return false;
  const bare = s.replace(/@[A-Za-z_][A-Za-z0-9_.]*/g, "1");
  if (!/^[0-9dD+\-*/().\s]+$/.test(bare)) return false;
  return /\d/.test(bare);
}

/**
 * THE ROUND LOADED IN A WEAPON, or null — the base system's own link, read in one place.
 *
 * `system.ammoItemId` is the field the base fire path and our seam both treat as "loaded"
 * (seam-shim.js `ammoEffectFields`), so this asks exactly what they ask. Fully optional-chained: an
 * unowned item, a stale id, or a cyberware weapon with no such field all answer null.
 */
export function loadedRoundOf(weapon) {
  const id = weapon?._getWeaponSystem?.()?.ammoItemId ?? weapon?.system?.ammoItemId ?? "";
  if (!id) return null;
  return weapon?.actor?.items?.get?.(id) ?? null;
}

/**
 * THE DAMAGE A LOADED ROUND SUPPLIES, or "" — the plain one-call reader.
 *
 * ⚠ THIS IS NOT WHAT THE LADDER BELOW ASKS, and the difference is the whole of the 2026-08-28 fix. It
 * COLLAPSES two different facts into the same "": "there is no round in the tube" and "there is a round
 * and it carries no dice". `warheadDamageFor` has to tell those apart — the first falls through to the
 * standard round, the second must not — so it asks `loadedRoundOf` + `roundDamageOf` itself. Kept here
 * as the reader for callers that only ever want a formula and do not care which of the two "" means.
 */
export function loadedRoundDamage(weapon) {
  const sys = loadedRoundOf(weapon)?.system;
  return sys ? roundDamageOf(sys) : "";
}

/**
 * THE DAMAGE ANY ONE ROUND CARRIES, read off its `system` — one precedence, in one place, used both for
 * the round in the tube and for a CANDIDATE round the standard-round ladder below is pricing.
 *
 * ⛔ THREE FIELDS, IN THIS ORDER, AND EACH HAS A REASON:
 *   1. `damage` — what a GM types when they think of the round as the thing that goes off, and the
 *      name every WEAPON in this system uses for the same idea.
 *   2. `damageFormula` — the name the UPSTREAM 1.2 development branch gives an ammo item's own damage
 *      (it REPLACES the weapon's; see memory `reference-upstream-supercoon`, third-pass notes). Read
 *      now so a world that has been through his migration answers here without a second unit.
 *   3. `bonusDamageFormula` — 1.1.1's only damage-bearing ammo field, and the ONLY one the shipped
 *      ammo sheet actually renders (templates/item/parts/ammo/settings.hbs, "AmmoBonusDamage"). For a
 *      round whose host weapon has no warhead of its own, a bonus over nothing IS the whole damage —
 *      which is what makes "set the loaded round's damage" an instruction a GM can actually carry out
 *      on today's build without a schema change.
 * The first ROLLABLE one wins; a field holding another unrollable word is skipped rather than
 * returned, so a half-filled round falls through to the guard's message instead of to a crash.
 */
export function roundDamageOf(system) {
  for (const key of ["damage", "damageFormula", "bonusDamageFormula"]) {
    const v = String(system?.[key] ?? "").trim();
    if (v && damageFormulaIsRollable(v)) return v;
  }
  return "";
}

/* ═══════════════════ THE STANDARD ROUND — what an EMPTY tube fires ═══════════════════════════════
 *
 * ⛔ THE RULING (user, 2026-08-27, verbatim): "I would really prefer the default behavior of the
 * weapons was not to spit an error and instead defaulted to standard grenade ammo in the same way
 * standard weapons default to standard bullets."
 *
 * So an empty grenade tube stops being a refusal and becomes a shot with a STANDARD round in it.
 * The refusal stays as the last rung — a build with no rounds anywhere still says so rather than
 * inventing a number.
 *
 * ⭐ STANDARD = FRAGMENTATION, and the basis is the book's own ordering. CP2020 p.64, the Grenade
 * row's note, verbatim: "Types include Fragmentation (7D6), Incendiary (4D6 for 3 turns), Stun (-5 to
 * Stun), Dazzle (Blind for 4 turns), Sonic (deafened 4 turns), Gas (see FNFF Gas Table)." Fragmentation
 * is the FIRST-LISTED archetype and the only one of the six whose printed effect is plain damage, which
 * is what "the standard round" has to mean for a tube that is otherwise refused. (Text-layer verbatim
 * recorded at import-staging/PRESHIP-POLISH.md, ledger #23bs.)
 *
 * ⛔ NO DAMAGE FORMULA IS WRITTEN IN THIS FILE. Every rung resolves a REAL document and reads its data
 * through `roundDamageOf` — the owner's own round, or the module pack's Fragmentation Grenade Round.
 * If neither exists the ladder answers "" and the caller shows its message; it never falls back to a
 * hardcoded 7d6, because the printed 7D6 lives on the item and only on the item.
 */

/** The caliber a grenade tube is chambered for — the `ammoType` the base's own Grenade Launcher prints. */
export const GRENADE_ROUND_CALIBER = "Grenade";

/**
 * The word a weapon prints when its warhead is the ROUND's business — CP2020 p.64 prints "Varies" in
 * the damage column of the Grenade Launchers row, and the base heavy pack copies it onto the item.
 */
export const ROUND_DEFERRAL_WORD = "Varies";

/** Where the standard round ships: the `src/packs` directory and the id that rides its FILENAME
 *  (`src/packs/supplement-heavy/Fragmentation_Grenade_Round_2smdtLN5J0FvhvoS.json`). The compendium KEY
 *  is never written out — it is derived from the module's own pack registration (`standardRoundPack`). */
const MODULE_ID = "cp2020-augmented";
const STANDARD_ROUND_PACK = "supplement-heavy";
const STANDARD_ROUND_ID = "2smdtLN5J0FvhvoS";
/** The name rung 2 falls back to when a copy carries no source pointer (a hand-made or re-created one). */
const STANDARD_ROUND_NAME = "Fragmentation Grenade Round";

/**
 * DOES THIS WEAPON DEFER ITS DAMAGE TO A GRENADE ROUND — the scope of the whole ladder, and the reason
 * a gas grenade is still refused.
 *
 * TWO CONDITIONS, both read off the item, neither a name list:
 *   1. it is CHAMBERED for grenade rounds (`ammoType` normalizes to "Grenade"), i.e. it is a thing you
 *      put a round into — the same field the reload picker reads as the weapon's caliber; and
 *   2. its own printed damage is the DEFERRAL WORD "Varies", i.e. the item itself says "my ammunition
 *      decides" rather than naming an effect it already has.
 *
 * ⛔ THE SECOND CONDITION IS NOT DECORATION — it is what keeps a THROWN grenade out. Every hand grenade
 * in the base heavy pack is also `ammoType: "Grenade"` and several print an unrollable word of their own
 * ("Gas", "Stun", "Blind", "Deaf"): those weapons ARE their own warhead, and handing them a frag round
 * would silently turn a gas grenade into an explosion.
 * ⏪ WHAT BECOMES OF THEM INSTEAD (corrected 2026-08-28 — this used to read "they keep the refusal
 * message", which was true only while the family was refused): all four are now WORD WARHEADS, so the
 * guard substitutes a rollable zero for the printed word and each rides its own modelled consequence.
 * The exclusion here is unchanged and still load-bearing — it is what stops the frag substitution — but
 * the shot it excludes now completes rather than being declined.
 *
 * ⭐ CLOSED ENUMERATION over the shipped catalogue (base `packs/*.db` + this module's `src/packs`,
 * 2026-08-27): exactly ONE document satisfies both — the base heavy pack's Grenade Launcher
 * (`ammoType: "Grenade"`, `damage: "Varies"`), which is the weapon the defect was reported against.
 * Two other items print "Varies" and are correctly excluded by condition 1 (Classic Rifle Grenades,
 * `ammoType: "rifle grenade"`; the Sten, `"varies (.22lr to 12mm cl)"`), and the module's own
 * grenade-chambered items (EMP Grenade, Stench Bomb, Anti-Tank Grenade, GPz-7B) are excluded by
 * condition 2. So the ladder changes the behaviour of one catalogue weapon plus anything a GM authors
 * the same way, and nothing else.
 */
export function defersDamageToGrenadeRound(weapon) {
  const sys = weapon?._getWeaponSystem?.() ?? weapon?.system ?? {};
  if (normalizeCaliber(String(sys.ammoType ?? "").trim()) !== GRENADE_ROUND_CALIBER) return false;
  return String(sys.damage ?? "").trim().toLowerCase() === ROUND_DEFERRAL_WORD.toLowerCase();
}

/** The module's own supplement-heavy compendium, found through the RUNTIME pack registration rather
 *  than by writing its collection key out — `null` before the module's packs register, or in a build
 *  where the pack was renamed. */
function standardRoundPack() {
  return game?.packs?.find?.(p => p?.metadata?.packageName === MODULE_ID && p?.metadata?.name === STANDARD_ROUND_PACK) ?? null;
}

/** The pinned catalog UUID of the standard round, or "" when the pack is not registered. The same
 *  pointer Foundry stamps into `_stats.compendiumSource` on a copy dragged out of that pack, which is
 *  what makes rung 2's first match name-blind. */
export function standardGrenadeRoundUuid() {
  const pack = standardRoundPack();
  return pack ? `Compendium.${pack.collection}.Item.${STANDARD_ROUND_ID}` : "";
}

/**
 * RUNG 2 — a round the ACTOR ALREADY OWNS, standard first.
 *
 * Candidates are the owner's ammo items that the reload picker would offer for this tube: `equipped`
 * not false and `caliberMatches(weapon ammoType, round caliber)` — the module's own loadability rule
 * (item-sheet.js ammoChoices), imported rather than restated so the two can never disagree. A round
 * carrying no rollable warhead at all is dropped, because defaulting to it would only re-produce the
 * refusal one step later.
 *
 * Exact-caliber matches are ordered ahead of blank-caliber wildcards (`caliberMatches` treats a blank
 * ammo caliber as "loads into anything", which is right for the picker but too eager for a default).
 * Within that order, three deterministic rungs, highest first — the shape proven by the martial-action
 * resolver (`actor-sheet.js _cpResolveMartialActionItem`):
 *   1. SOURCE POINTER — `_stats.compendiumSource` is exactly the pack UUID of the Fragmentation round.
 *      Name-blind, so a renamed copy of the standard round still answers.
 *   2. EXACT NAME — trimmed, case-insensitive EQUALITY with "Fragmentation Grenade Round". Equality,
 *      never a substring, so "Anti-Tank Fragmentation Grenade Round" is not it.
 *   3. Whatever else the tube will take, first in the ordered list.
 *
 * ⚠ QUANTITY IS DELIBERATELY NOT CONSUMED AND NOT REQUIRED. In this system firing decrements the
 * WEAPON's `shotsLeft` (base item.js `__setWeaponField("shotsLeft", …)`); a round's `quantity` is spent
 * by the RELOAD path only (base dialog/modifiers.js). So "consume per the normal firing economy" means
 * consuming nothing here — a loaded round is not decremented on the trigger pull either — and gating on
 * quantity would silently exclude the shipped round, which ships at `quantity: 0` with `qtyLocked`.
 */
function ownedStandardRoundDamage(weapon) {
  const actor = weapon?.actor;
  if (!actor) return "";
  const sys = weapon?._getWeaponSystem?.() ?? weapon?.system ?? {};
  const weaponCaliber = String(sys.ammoType ?? "");
  const all = actor.itemTypes?.ammo ?? actor.items?.filter?.(i => i.type === "ammo") ?? [];
  const usable = [...all].filter(a =>
    a?.system?.equipped !== false
    && caliberMatches(weaponCaliber, a?.system?.caliber ?? "")
    && roundDamageOf(a?.system));
  if (!usable.length) return "";

  const stated = normalizeCaliber(String(weaponCaliber).trim());
  const exact = usable.filter(a => normalizeCaliber(String(a.system?.caliber ?? "").trim()) === stated);
  const ordered = [...exact, ...usable.filter(a => !exact.includes(a))];

  const uuid = standardGrenadeRoundUuid();
  const bySource = uuid ? ordered.find(a => a?._stats?.compendiumSource === uuid) : null;
  const byName = ordered.find(a => String(a.name ?? "").trim().toLowerCase() === STANDARD_ROUND_NAME.toLowerCase());
  return roundDamageOf((bySource ?? byName ?? ordered[0]).system);
}

/**
 * RUNG 3 — the module compendium's own Fragmentation Grenade Round, for a world that owns none.
 *
 * The pack document is READ, never created: nothing is added to anyone's inventory and nothing is
 * written to the weapon — the formula is a fact about this shot, exactly as a loaded round's is. A
 * world whose compiled pack predates the round (anything before the release re-seed) finds nothing
 * here and falls to the message, which is the honest answer for that build.
 */
async function packStandardRoundDamage() {
  const pack = standardRoundPack();
  if (!pack) return "";
  try {
    const doc = await pack.getDocument(STANDARD_ROUND_ID);
    return doc ? roundDamageOf(doc.system) : "";
  } catch (err) {
    console.warn("cp2020-augmented | the standard grenade round could not be read from its pack", err);
    return "";
  }
}

/**
 * THE WARHEAD A DELIVERY WEAPON FIRES, or "" — the whole ladder, read by both rails that ask.
 *
 * ⭐⭐ THE RULE, RESTATED 2026-08-28: **A LOADED ROUND ALWAYS ANSWERS FOR THE TUBE, INCLUDING ANSWERING
 * WITH NOTHING.** Rung 1 is now "is there a round in the tube", not "does the round in the tube carry
 * dice" — so a round that carries none ends the ladder at "" instead of letting the standard-round rungs
 * answer over the top of it.
 *
 * ⛔ THE DEFECT THAT FORCED IT. Rung 1 used to be `loadedRoundDamage(weapon)` and take the fall-through
 * on a falsy result, which cannot distinguish an EMPTY TUBE from a tube holding a round that has no dice
 * on purpose — the module pack's Gas Grenade Round is exactly that (`effectTypes: ["Gas"]`, all three
 * damage fields empty, because gas is an area effect and not a number). A launcher loaded with it
 * therefore priced its shot off the standard FRAGMENTATION round and fired 7d6: the round the referee
 * chambered was silently swapped for a different one. That is the same substitution
 * `defersDamageToGrenadeRound` refuses for a thrown gas grenade, and it is refused here for the same
 * reason.
 *
 * 1. the ROUND IN THE TUBE, when there IS one — whatever it carries, "" included;
 * 2. else, for a grenade tube whose damage is the deferral word, an OWNED standard round;
 * 3. else that round's entry in this module's own pack;
 * 4. else "" — the caller shows its message, or substitutes for a word warhead (below).
 *
 * ⚠ THE EMPTY-TUBE RULING IS UNTOUCHED (user, 2026-08-27 — an empty tube fires the standard
 * Fragmentation round). Rungs 2 and 3 are reached on exactly the same condition as before: NO round
 * loaded. Only the loaded-but-diceless case changed, and it had no honest answer before.
 *
 * Both readers must use this one function or a shot could be priced two ways: the ATTACK gesture rolls
 * the warhead on a hit (actor-sheet `_cpFireThroughDamageGuard`) and the DAMAGE rail rolls it on a MISS
 * so the p.108 scatter still has something to detonate (damage-hooks `_rollDeliveryWarhead`).
 */
export async function warheadDamageFor(weapon) {
  const loaded = loadedRoundOf(weapon);
  if (loaded) return roundDamageOf(loaded.system);
  if (!defersDamageToGrenadeRound(weapon)) return "";
  return ownedStandardRoundDamage(weapon) || await packStandardRoundDamage();
}

/**
 * THE WORD A NON-DICE WARHEAD IS PRINTED AS, when this shot has one — currently only `"Gas"`, else null.
 *
 * ⭐ WHAT IT IS FOR. `damageFormulaIsRollable` splits every printed damage into "a formula" and "a word",
 * and until now BOTH halves of the second group were treated the same: refuse the shot. But the two are
 * not the same. "Varies" means *the round decides* — answered by the ladder above. "Gas" means *there is
 * nothing to decide*: the payload's whole effect is an AREA the module already models
 * (combat/damage-hooks.js `_hookGasCloud`, keyed on the payload's `effectTypes` carried by
 * seam-shim.js `ammoEffectFields`). Refusing those shots did not protect anything — it made the base
 * heavy pack's thrown Gas Grenade undeliverable and left a complete cloud mechanic unreachable.
 *
 * TWO WAYS A SHOT CAN BE ONE, and they are the thrown case and the launched case of the same thing:
 *   (a) THE WEAPON ITSELF prints the word (base heavy pack "Gas Grenade", `damage: "Gas"`) — a thrown
 *       grenade IS its own warhead, so its own damage column is the whole statement;
 *   (b) THE LOADED ROUND declares the cloud AND carries no dice — `effectTypes` includes "Gas" and
 *       `roundDamageOf` is "". Both halves are required: a round that has a cloud AND dice (an
 *       incendiary-style load a GM authored) keeps its dice and is priced by the ladder as usual.
 *
 * `effectTypes` is coerced and matched EXACTLY as `_hookGasCloud` coerces and matches it (array, bare
 * string, junk; `includes("Gas")`), so this answers on precisely the shots that will produce a cloud —
 * the guard can never let a shot through that the cloud hook then ignores, or refuse one it would have
 * served.
 *
 * ⭐⭐ THE FAMILY IS COMPLETE FOR THE SHIPPED CATALOGUE (2026-08-28). Until this change the list held
 * "Gas" alone and the other four printed words were refused for a stated reason: none of them had a
 * modelled consequence for the shot to ride, so letting one fire would have produced a silent nothing
 * instead of a message. Each has one now, so each is admitted — CP2020 p.64, verbatim, is the whole
 * specification and nothing here exceeds it:
 *
 *   "Types include Fragmentation (7D6), Incendiary (4D6 for 3 turns), Stun (-5 to Stun), Dazzle
 *    (Blind for 4 turns), Sonic (deafened 4 turns), Gas (see FNFF Gas Table)."
 *
 *   · "Stun"  — every figure the detonation catches makes ONE stun save at the payload's own
 *               `stunSaveMod` (−5 as the corrections layer stamps it). No damage, no duration.
 *   · "Blind" — the Dazzle grenade's printed damage word; a timed condition for `dotTurns` turns.
 *   · "Deaf"  — the Sonic grenade's printed damage word; the same shape, the other sense.
 * All three are raised on the figures the BLAST's own enumeration already names (damage-hooks.js
 * `_confirmExplosion`), which is why they are words on this list rather than a second placement.
 *
 * ⚠ "Dazzle" AND "Sonic" ARE NOT ON THE LIST, and that is not an omission. They are the ITEM NAMES;
 * the base heavy pack writes the EFFECT in the damage column — `Blind` on the Dazzle Grenade, `Deaf`
 * on the Sonic Grenade (read off packs/heavy.db, 2026-08-28) — and this reader answers about the
 * effect, never about the name.
 *
 * ⛔ WHAT A GM-AUTHORED WORD STILL GETS. The set below is closed, so a weapon printing any other word
 * — "Flash", "EMP", "Varies" on something that is not a grenade tube — resolves to null here, falls
 * through the guard's ladder, and is DECLINED with the `FireDamageNotRollable` notification naming the
 * word and the fix. That message is the honest answer for a word nothing models: a shot admitted with
 * no consequence behind it is a silent nothing, which is what the refusal exists to prevent. The
 * shipped catalogue's refused set is now empty; the door stays shut for everything outside it.
 */
export const WORD_WARHEADS = Object.freeze(["Gas", "Stun", "Blind", "Deaf"]);

/** ⏪ The single-word constant this list grew out of, kept as the name the gas hook's own reasoning
 *  is written against so a reader of `_hookGasCloud` still finds it spelled the same way. */
export const WORD_WARHEAD_GAS = "Gas";

/**
 * WHICH WORD A LIST OF EFFECT TYPES DECLARES, or null — one coercion, one match, in one place.
 *
 * `effectTypes` is coerced exactly as every other reader coerces it (array, bare string, junk) and
 * matched by EQUALITY against the closed set, never as a substring, so a hand-authored "Non-Explosive"
 * or "Stunning" is not read as one of ours. Case-insensitive because pack data is hand-typed, and the
 * canonical spelling from the set is what is returned — so downstream branches compare one form.
 */
function wordWarheadIn(effectTypes) {
  const t = effectTypes;
  const types = Array.isArray(t) ? t : (typeof t === "string" && t ? [t] : []);
  for (const raw of types) {
    const hit = WORD_WARHEADS.find(w => w.toLowerCase() === String(raw ?? "").trim().toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** The formula a word warhead is rolled with — a real, rollable ZERO. The shot has to complete for its
 *  area consequence to be raised at all, and it must contribute no dice while doing so. */
export const WORD_WARHEAD_FORMULA = "0";

export function wordWarheadOf(weapon) {
  const sys = weapon?._getWeaponSystem?.() ?? weapon?.system ?? {};
  const printed = String(sys.damage ?? "").trim().toLowerCase();
  const own = WORD_WARHEADS.find(w => w.toLowerCase() === printed);
  if (own) return own;

  const round = loadedRoundOf(weapon);
  if (!round) return null;
  const declared = wordWarheadIn(round.system?.effectTypes);
  if (!declared) return null;
  return roundDamageOf(round.system) ? null : declared;
}

/**
 * THE WORD A FIRED PAYLOAD CARRIES, or null — the same question as `wordWarheadOf`, asked of the
 * DATAGRAM instead of the item.
 *
 * ⛔ WHY IT IS A SECOND FUNCTION, for the same reason `payloadDetonates` and `weaponDetonates` are two.
 * The item reader is asked BEFORE the trigger is pulled (the attack gesture's guard, deciding what to
 * substitute for the printed word); this one is asked AFTER, on a client that may never have held the
 * item at all — a player's throw reaches the GM as relayed JSON. The seam gathers the same two facts
 * into one flat field on the way out (`ammoEffectFields` reads the loaded round's `effectTypes` first
 * and falls back to the WEAPON's own, which is where the corrections layer stamps a thrown grenade's),
 * so by the time a payload exists the two doors have already been collapsed into one list and there is
 * exactly one thing left to read.
 *
 * ⚠ IT DOES NOT RE-ASK THE DICELESS QUESTION, and cannot: a payload carries no round document. It does
 * not need to — a load that carries BOTH a word and dice was priced by the ladder at fire time and its
 * card arrives here with real damage in `areaDamages`, which is what the blast prices off. The word is
 * read for its CONSEQUENCE, and an incendiary-style load that also states one is entitled to it.
 */
export function wordWarheadOfPayload(payload) {
  return wordWarheadIn(payload?.effectTypes);
}

/**
 * DID THIS DELIVERED WARHEAD MISS — the ONE test the two rails that ask must both read.
 *
 * ⛔ THE DEFECT IT ANSWERS (2026-08-28, the word-warhead family). Both sites used to ask "did the card
 * carry any rolled damage", summing `areaDamages` and treating a zero as a miss (seam-shim.js
 * `blastScatter`, damage-hooks.js `missedThrow`). That is exact for a warhead with dice — 7d6 cannot
 * roll zero — and WRONG for a word warhead, which fires through a substituted rollable ZERO
 * (`WORD_WARHEAD_FORMULA`) and therefore lands a clean HIT whose damage sums to nothing. A stun
 * grenade thrown squarely at a figure would have been ruled a miss and sent to the grenade table.
 *
 * ⭐ SO THE BASE'S OWN VERDICT IS ASKED FIRST. `baseHit` is the boolean the base system computed after
 * every rule it applies — the range DC, the fumble table's `forceMiss`, the per-fire-mode tie rule —
 * carried on the payload since 2026-08-26 precisely so no consumer has to re-derive it (seam-shim.js).
 * A payload that states it is answered by it and nothing else.
 *
 * ⚠ THE DAMAGE SUM SURVIVES AS THE FALLBACK, unchanged, for a payload that does NOT state the verdict:
 * a macro's shot, a keeper driving the hook directly, or one relayed from a client on a build before
 * the field existed. Absence is the compatibility mechanism, exactly as it is everywhere else in this
 * flow — and for every dice-bearing warhead the two readings agree anyway, so nothing that fires today
 * changes behaviour.
 */
export function deliveryShotMissed(payload) {
  if (typeof payload?.baseHit === "boolean") return !payload.baseHit;
  let landed = 0;
  for (const hits of Object.values(payload?.areaDamages ?? {})) {
    for (const h of (hits ?? [])) landed += Number(h?.damage ?? h?.dmg) || 0;
  }
  return landed <= 0;
}

/**
 * IS THIS WEAPON LAUNCHED RATHER THAN THROWN — the one thing that separates the two delivery pictures.
 *
 * ⛔ ONE CLAUSE, ONE REASON: a launcher is a delivery weapon with a ROUND IN IT. A thrown grenade is
 * its own warhead and never carries one. So "does it have a loaded round" is the same question as "is
 * this thing a tube you put something in", asked of the data rather than of a name list or of a range
 * number.
 *
 * ⚠ THE PICTURE IS DELIBERATELY LEFT ON THE LOADED-ROUND TEST, and that is now a KNOWN gap rather than
 * an identity. Until 2026-08-27 the second half of the argument was "a launcher cannot fire at all
 * without a round, because the attack gesture refuses it" — the standard-round ladder above ends that,
 * so an EMPTY tube firing its default round is still drawn as a THROWN lob. `defersDamageToGrenadeRound`
 * is the one clause that would close it, and it is not added here on purpose: the two pictures carry
 * different arrival ladders and therefore different SETTLE FLOORS (at 60 ft, thrown 2867+700 = 3567 ms
 * against launched 1833+1067 = 2900 ms on the shipped cannon ball), and the settle floor is what the
 * pending apply-window timing discussion is about. Parked for that discussion, not overlooked.
 *
 * A `Missile`/`Rocket`/`RPG` attack type is launched whatever it carries — the Scorpion 16 is a
 * shoulder tube with its warhead priced into the weapon, so it answers here by its type.
 */
export function areaDeliveryIsLaunched(weapon) {
  const kind = areaDeliveryKind(weapon?._getWeaponSystem?.()?.attackType ?? weapon?.system?.attackType);
  if (!kind) return false;
  if (kind !== "grenade") return true;
  return !!loadedRoundOf(weapon);
}
