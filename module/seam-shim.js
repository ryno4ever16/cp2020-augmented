/**
 * Seam shim — a TEMPORARY, self-disengaging compatibility patch.
 *
 * The Augmented module reacts to three base-system events: `cyberpunk2020.weaponFired` (drives the damage
 * automation), `cyberpunk2020.suppressiveFire` (draws the fire zone + posts evasion prompts), and
 * `cyberpunkSkillRolled` (drives the IP tracker). Those hook emissions are proposed to
 * the base system as PRs; until they land, the base system does not emit them, so the module's
 * automation is inert on a stock install. This shim monkey-patches the base roll methods to emit the
 * hooks ITSELF — but only for as long as the base system lacks them.
 *
 * ⛔ SELF-DISENGAGING (this is the whole contract): before patching anything, we read the target
 * method's OWN source. If it already emits the hook — because the PR was merged, OR because we are
 * running on the fork that carries the seam — we DO NOT patch it. So the instant the base system gains
 * native emission, this shim goes completely dormant: no version checks, no settings, no double-emit.
 * On a fork+module install it is dormant from the start (the fork emits natively).
 *
 * When the upstream PRs are accepted, this whole file can be deleted.
 */

import { localize, localizeParam, tryLocalize } from "./utils.js";
import { scatterDriftM } from "./combat/scatter-table.js";
// The scatter DECISION comes from the verdict's own home (2026-08-26), the drift TABLE from the file
// above; they were one import until the predicate had to start reading the base's ruling.
import { payloadScattersOnMiss } from "./combat/spread-geometry.js";
import { areaDeliveryKind, deliveryShotMissed } from "./combat/area-delivery.js";
import { getWeaponLongRange } from "./combat/rangefinding.js";
// ⭐ WHICH ROW OF THE BASE'S FUMBLE TABLE WAS RULED. This file is the ONE caller of the derivation —
// see the "one derivation, one caller" note in combat/fumble-outcome.js. Its answer rides the payload
// as `fumbleClass` and every consumer reads the FIELD, never the derivation.
import { rangedFumbleClassFrom } from "./combat/fumble-outcome.js";

const SCOPE = "cp2020-augmented";

const WEAPON_FIRED = "cyberpunk2020.weaponFired";
const SUPPRESSIVE_FIRE = "cyberpunk2020.suppressiveFire";
const SKILL_ROLLED = "cyberpunkSkillRolled";
const MULTI_HIT_TEMPLATE = "systems/cyberpunk2020/templates/chat/multi-hit.hbs";
const SUPPRESSIVE_TEMPLATE = "systems/cyberpunk2020/templates/chat/suppressive.hbs";
// The base system's five ranged/melee fire resolvers; each builds the per-location areaDamages and
// renders multi-hit.hbs. Matches the seam PR (item.js: __fullAuto/__threeRoundBurst/__semiAuto/__meleeBonk),
// plus __martialBonk — item.__weaponRoll routes a martial strike there and it renders multi-hit.hbs the same
// way, so it MUST set _fireCtx too; otherwise the render wrap would emit weaponFired with a stale prior
// context (mis-attributing the martial strike — and thus its attackerId — to the last ranged fire, which
// starved the action counter / aim clear / arm-use notice that key on it).
const FIRE_METHODS = ["__fullAuto", "__threeRoundBurst", "__semiAuto", "__meleeBonk", "__martialBonk"];

// Shared claim registry for the skillRolled listeners. Two overlapping same-user rollSkill calls each
// register their own createChatMessage listener; author alone can't tell their two cards apart, so both
// would match the FIRST numeric card and cross-wire (listener B emits skill B's id with card A's total).
// Every listener records the id of the card it claims here and skips any id already claimed, so the first
// card goes to the first (oldest) live listener and the second card to the second — order preserved, no
// two listeners can ever consume the same message. Entries are deleted when a listener unhooks, so the
// set only ever holds in-flight claims.
const _claimedSkillCards = new Set();

/* ─── Pure decision logic (no Foundry globals → unit-testable) ─────────────────────────────────── */

/** Does this function's OWN source emit `hookName`? */
export function nativelyEmits(fn, hookName) {
  try {
    return typeof fn === "function" && fn.toString().includes(hookName);
  } catch (_e) {
    return false;
  }
}

/**
 * Does ANY of the class's OWN methods emit `hookName`? This is the disengage condition — and it must
 * scan the whole prototype, not just the one method we wrap: the fork emits cyberpunkSkillRolled from a
 * helper (`_fireSkillRolled`) that `rollSkill` CALLS, so a single-method check would miss it and the
 * shim would double-emit. Our own wrappers carry `__cpSeamShim` and are excluded so a re-run doesn't
 * mistake them for native emission. (Caveat: an emit relocated to a free function — not a method on this
 * class — would not be seen; the seam PRs and the fork both emit from methods on the class.)
 */
export function prototypeEmits(proto, hookName) {
  if (!proto) return false;
  for (const key of Object.getOwnPropertyNames(proto)) {
    try {
      const fn = Object.getOwnPropertyDescriptor(proto, key)?.value;
      if (typeof fn === "function" && fn.__cpSeamShim !== true && fn.toString().includes(hookName)) return true;
    } catch (_e) { /* getter / exotic prop — ignore */ }
  }
  return false;
}

/** Should we wrap `method`? Only if it's a real function we haven't already wrapped. (Whether the base
 *  system is native is decided once per class via prototypeEmits, before any wrapping.) */
export function shouldPatch(method) {
  return typeof method === "function" && method.__cpSeamShim !== true;
}

/** Was the attack roll a natural 1 (CP2020 fumble)? Self-contained mirror of the base's isFumbleRoll:
 *  the first non-discarded/non-rerolled result of the first Die term. Drives the mono break-on-fumble
 *  rule independently of the optional fumble-crit-table setting. Pure; false on any unreadable roll. */
export function rollIsNaturalOne(roll) {
  try {
    const DieClass = foundry?.dice?.terms?.Die;
    const dieTerm = roll?.terms?.find(t => (DieClass ? t instanceof DieClass : t?.faces === 10));
    const res = dieTerm?.results?.find(r => !r.discarded && !r.rerolled);
    return Number(res?.result) === 1;
  } catch (_e) {
    return false;
  }
}

/* ─── weaponFired: identity from the fire method, areaDamages from the render ──────────────────── */

// Set while a SHIM-wrapped fire method runs, so the renderTemplate wrap below knows the attacker/weapon
// for the multi-hit card it is about to render. Not cleared eagerly: two of the base fire methods call
// roll.execute() WITHOUT awaiting it, so the multi-hit render happens after the method returns — a
// stale clear would drop the payload. multi-hit.hbs is only ever rendered by a fire, and every fire
// refreshes this first, so leaving the last context set is correct and never mis-attributes.
let _fireCtx = null;

// Set while a SHIM-wrapped __suppressiveFire runs, so the renderTemplate wrap below can emit the
// suppressiveFire hook for the suppressive card it renders. The base method AWAITS its render inside the
// call (unlike two of the fire methods), so this is set immediately before and never goes stale mid-render.
let _suppressiveCtx = null;

// ⭐ THE ONE PART OF THIS SHIM THAT CAN GO AWAY WITHOUT SAYING SO.
//
// The fire methods are patched onto a document-class PROTOTYPE: durable, private to us, and nothing
// else on a Foundry client rewrites it. The EMISSION, though, rides a wrap on `globalThis.render-
// Template` — one shared global binding, assigned through a core deprecation accessor. Whoever
// assigns it last wins, and the loser leaves no trace: the fire methods still run, the roll still
// posts, the magazine still decrements, and the module's whole combat layer simply never hears about
// the shot. Reported from the table twice in one day, both times cured by a reload.
//
// So we keep the wrapper we installed BY IDENTITY. That is what lets us answer "is our emit still the
// one the base system's bare `renderTemplate(...)` call reaches?" — see renderEmitLive() — instead of
// assuming the install held for the life of the session.
let _renderWrapper = null;
// One visible message per session when the rail is found dead. The console keeps every occurrence;
// the notification exists so a GM is told rather than left wondering why nothing happens.
let _railWarned = false;
// Cards this shim has already emitted for. A second wrapper can end up in the chain — something else
// may wrap OURS after we install, and from outside we cannot see that ours is still buried in there,
// so a re-assert can legitimately add a layer. The card's render DATA is the same object at every
// level of that chain, so marking it is what keeps one card to exactly one emission however many
// wrappers the call passes through. Weak, so a finished card is collected normally.
const _emittedFor = new WeakSet();

/**
 * Is the card-render wrap this shim installed still the one the base system's bare
 * `renderTemplate(...)` call resolves to? False before any install, and false once something has
 * replaced the global.
 *
 * ⚠ HONEST LIMIT: if another actor wrapped OUR wrapper rather than replacing it, our emit still runs
 * but this reads false, because from out here the two cases look identical. Re-asserting in that case
 * is harmless (the per-card mark above prevents the double emission), and no module on the supported
 * stack wraps this binding — but the reading is "ours is not the outermost", not "the emit is dead".
 */
export function renderEmitLive() {
  return !!_renderWrapper && globalThis.renderTemplate === _renderWrapper;
}

/**
 * Re-assert the card-render wrap when it is no longer ours, and say so once.
 *
 * Called on every shot, which is the one moment the answer matters and the one moment we can still
 * do something about it: re-installing here repairs THIS shot, not merely the next one. Cheap by
 * construction — installRenderEmit() returns immediately while ours is live, so the ordinary case
 * costs one identity comparison.
 */
function assertRenderEmit() {
  if (!_renderWrapper || renderEmitLive()) return;
  console.warn(`${SCOPE} | seam shim: the card-render wrap is no longer ours — re-asserting it. Any shot taken before now raised no ${WEAPON_FIRED}, so it got no damage automation and no presentation.`);
  installRenderEmit();
  if (_railWarned) return;
  _railWarned = true;
  try { ui.notifications?.warn?.(localize("Augmented.SeamRailReasserted")); } catch (_e) { /* no UI on this client */ }
}

// The effect fields the combat engine reads off a weaponFired payload (beyond identity + areaDamages).
// On stock, the base fire methods build ONLY areaDamages, so without these the module's explosion / gas /
// spread / DOT / taser / armor-piercing / penetration branches never fire. They live on the loaded ammo
// item's system.* (seeded by ammoModifierSystemFields + the ammo sheet); `edged` is weapon-level for melee.
const AMMO_EFFECT_FIELDS = [
  // ⭐ THE AMMO'S OWN IDENTITY (FR#24). Everything else in this list is a MECHANICAL consequence of the
  // loaded modifier; this is the modifier itself. Without it the presentation layer could only guess
  // which load fired, from the fingerprint its mechanics left behind — and two of the thirteen (ap and
  // dualPurpose) carry byte-identical mechanics, so they were indistinguishable at any distance. One
  // string closes that. It is presentation-only downstream: no damage path reads it.
  //
  // ⚠ IT MUST SIT BESIDE THE CARTRIDGE, NEVER INSTEAD OF IT. The spread unit added `caliber` here and
  // took this line out with it, and nothing failed: `ammoFxKeyOf` falls back to a fingerprint of the
  // mechanics when there is no id, so every load still resolved — except the one pair the id exists to
  // settle, which silently collapsed (`dualPurpose` → `ap`). The two fields answer different questions
  // and are both load-bearing.
  "modifier",
  // ⭐ THE CARTRIDGE. The shotgun is an area weapon in the Core rules, so whether a shot throws a
  // pattern is a fact about the round in the chamber — not about a flag somebody set on an item.
  // spreadModeForAmmo (lookups.js) derives the mode from this at fire time, which is what lets an
  // untouched world's buckshot fire the book pattern with no migration. Only the AMMO item carries it
  // under this key; the weapon's own chambering has a different name and is resolved separately below.
  "caliber",
  "ap", "edged", "mono", "effectTypes", "blastRadius", "blastFullDamageWithin", "blastMultipliers", "blastShrapnel",
  "penDamageMult", "armorMultSoft", "armorMultHard",
  "spreadMode", "spreadDamageShort", "spreadDamageMedium", "spreadDamageLong",
  "spreadWidthShort", "spreadWidthMedium", "spreadWidthLong",
  "stunSaveOnHit", "stunSaveMod", "dotEnabled", "dotTurns", "dotType", "dotDamageFormula",
  // ⭐ RIDES WITH THE OTHER FOUR OVER-TIME FIELDS BECAUSE IT IS THE FIFTH STATEMENT ABOUT THE SAME TICK.
  // The other four say whether there is one, for how long, of which kind and at what formula; this one
  // says whether its multiplier DIMINISHES. Left out of this list, the flag never leaves the ammo
  // document — the tick reads its state, the state is seeded from the payload, and the payload is built
  // from exactly this list — so a round that states it would burn on the halving ladder anyway.
  "dotFlat",
];

/** Effect fields for the fired weapon, read from its loaded ammo (system.*) first, then the weapon
 *  itself (melee `edged`). Only defined fields are copied → the engine applies its own defaults for the
 *  rest. Pure-ish read; safe when there's no ammo (returns whatever the weapon provides, else {}). */
export function ammoEffectFields(weapon) {
  const out = {};
  const ammoSys = weapon?.actor?.items?.get?.(weapon?.system?.ammoItemId)?.system;
  for (const sys of [ammoSys, weapon?.system]) {
    if (!sys) continue;
    for (const k of AMMO_EFFECT_FIELDS) if (out[k] === undefined && sys[k] !== undefined) out[k] = sys[k];
  }
  // ⚠ THE CARTRIDGE IS RECORDED UNDER TWO DIFFERENT NAMES, and the plain copy above only ever finds
  // one of them. An AMMO item stores the round it IS in `caliber`; a WEAPON stores the round it TAKES
  // in `ammoType` — the base system's own field, and the only one its weapon schema has (`caliber` on
  // a weapon is dropped on write). Every shotgun in the shipped catalogue records a gauge there and
  // nothing anywhere else, so without this line a shell fired without a distinct ammo item — free
  // fire, or a weapon never reloaded — reports no cartridge at all and throws no pattern.
  if (!String(out.caliber ?? "").trim()) {
    const weaponCaliber = String(weapon?.system?.ammoType ?? "").trim();
    if (weaponCaliber) out.caliber = weaponCaliber;
  }
  return out;
}

/** The token this user is currently aiming at (the first, when several are held). Mirrors the reading
 *  the attack dialog takes when it builds the target list it passes to the base fire methods, so the
 *  captured id is the same id the full-auto card would have carried. Null when nothing is targeted. */
function _firstTargetTokenId() {
  try {
    for (const t of game.user?.targets ?? []) return t?.id ?? null;
  } catch (_e) { /* no canvas / no user targets on this client */ }
  return null;
}

/** The token the shot is fired FROM, captured at the trigger pull.
 *
 *  ⭐ WHY THE ACTOR ID IS NOT AN ANSWER. Two tokens of one actor share it, and an unlinked token's own
 *  actor carries the base actor's id as well — so a consumer resolving the origin by actor id can only
 *  answer "whichever was placed first", which is how a shot fired from the second figure drew its
 *  muzzle work and its rounds out of the first (reported 2026-08-10). The identity is known here, at
 *  the one moment it is unambiguous, so it is captured here and carried on the payload.
 *
 *  In priority order: a synthetic actor belongs to exactly one token and names it itself; else the
 *  token this user has SELECTED on the viewed canvas, which is what the ordinary fire flow leaves
 *  selected; else core's own speaker resolution for this actor (which prefers a selected token and
 *  otherwise takes the actor's first drawn one). Null when none of them answers — every consumer
 *  falls back to its own actor lookup, i.e. to the behaviour it had before this field existed.
 *  Fully optional-chained: a client with no canvas yet must not throw on the way to firing. */
export function firingTokenIdOf(actor) {
  if (!actor) return null;
  try {
    if (actor.isToken) return actor.token?.id ?? null;
    const selected = canvas?.tokens?.controlled?.find(t => t.actor?.id === actor.id);
    if (selected) return selected.id ?? null;
    return ChatMessage.getSpeaker({ actor })?.token ?? null;
  } catch (_e) { return null; }   // no canvas / no scene on this client
}

/**
 * Whether a fumble on THIS weapon would take the base's auto-only-jam early return instead of rolling
 * the printed Reflex (Combat) table — the one fact the class derivation cannot get from the card.
 *
 * Mirrors base item.js:226-227 exactly and prefers the base's OWN predicate over any restatement of it:
 * `_isAutoWeapon(sys)` (item.js:216) is what actually chooses the branch, so asking it is the only
 * reading that cannot drift from the branch it describes. The literal comparison below is reached only
 * on a host where that method is missing, and it uses the same two `rangedAttackTypes` values the
 * predicate does. Never throws — a weapon this cannot read reports FALSE, which puts the derivation on
 * the table-reading path, and the derivation's own anchor check refuses anything it cannot read there.
 *
 * @param {object} item a base CyberpunkItem (a weapon)
 * @returns {boolean}
 */
export function _autoOnlyJamBranchFor(item) {
  try {
    if (!game.settings.get("cyberpunk2020", "autoFumbleOnlyJam")) return false;
    const sys = item?._getWeaponSystem?.() ?? item?.system ?? {};
    if (typeof item?._isAutoWeapon === "function") return !!item._isAutoWeapon(sys);
    const atk = sys?.attackType;
    return atk === "Auto" || atk === "Autoshotgun";
  } catch (_e) {
    return false;
  }
}

function installWeaponFiredShim(ItemProto) {
  if (prototypeEmits(ItemProto, WEAPON_FIRED)) return false;   // base system emits it (method or helper) → disengage
  let patchedAny = false, foundAny = false;
  for (const name of FIRE_METHODS) {
    const orig = ItemProto?.[name];
    if (typeof orig === "function") foundAny = true;           // the method exists (base's or already ours)
    if (!shouldPatch(orig)) continue;                          // missing or already ours → skip
    function fireWrapper(attackMods, ...rest) {
      // Check the rail at the one moment it matters — the shot — and repair it in time for THIS one.
      // See the note on _renderWrapper for why this is the half that can vanish quietly.
      assertRenderEmit();
      _fireCtx = {
        attackerId: this.actor?.id ?? null,
        // WHICH FIGURE FIRED, as opposed to whose it is (see firingTokenIdOf). Read at CALL time for
        // the same reason the aim is: it is a fact about this trigger pull.
        attackerTokenId: firingTokenIdOf(this.actor),
        weaponName: this.name,
        weaponId: this.id ?? null,   // resolve the EXACT weapon downstream (two same-named weapons with different ammo)
        fallbackTargetActorId: attackMods?.targetActor?.id ?? null,
        // The aimed-at token, captured for PRESENTATION only (see the two-field note at the emit below).
        // The base system hands its target-token list to __fullAuto ONLY, so the multi-hit card carries a
        // `target` for that one fire mode; the semi-auto / three-round-burst / melee cards render with no
        // target at all. The token IS known at fire time — it is the same reading the attack dialog took
        // to build the list it passes on (the user's current targets) — so capture it here. Read at CALL
        // time, like the dialog does, so it reflects the token the shot was actually aimed at; null when
        // nothing is targeted.
        fxTargetTokenId: _firstTargetTokenId(),
        // ⭐ THE CORRIDOR A SPREAD SHOT WAS AIMED ALONG BEFORE THE TRIGGER WAS PULLED (2026-08-11).
        // It arrives on the attack modifiers because that object is the one thing that travels from the
        // fire gesture into the base's own fire method — the aim is declared by the shooter several
        // steps before this, in combat/spread-placement.js, and carrying it here means no global to keep
        // in step and no second channel to go stale. Absent on every ordinary shot, and absent on a
        // spread shot fired by anything other than the sheet's own control (a macro, a keeper driving
        // the roll directly), in which case the plant falls back to computing an axis from the target
        // exactly as it did before this existed.
        spreadAim: attackMods?.cpSpreadAim ?? null,
        // ⭐ THE SPOT AN AREA DELIVERY WAS AIMED AT before the trigger was pulled (2026-08-28). Same
        // channel as the corridor above it, for the same reason and with the same absence rule: the
        // point is declared by the shooter several steps before this (combat/aim-placement.js) and the
        // attack modifiers are the one object that travels from the fire gesture into the base's own
        // fire method. Null on every ordinary shot, and null on a delivery fired by anything other than
        // the sheet's own control (a macro, a keeper driving the roll directly) — in which case the
        // blast falls back to centring on the target token exactly as it did before this existed.
        aimPoint: attackMods?.cpAimPoint ?? null,
        // ⭐ THE WEAPON'S OWN LONG RANGE, in metres — a WEAPON fact, which is why it is captured here
        // beside the weapon's name and not in `ammoEffectFields` with the load's own numbers. The shot
        // pattern's range bands are FRACTIONS OF IT (Core p.99: Close ¼, Medium ½, Long the full range)
        // and the shotgun table prints the pattern's width and damage per band (p.109), so every reader
        // of the corridor — the aim preview, the plant, the presentation sweep — has to measure against
        // the same number. Read through the shared resolver (combat/rangefinding.js), the same call the
        // aim gesture makes, so the ghost the shooter drew and the region the GM plants cannot disagree.
        spreadRangeM: getWeaponLongRange(this),
        // ⭐ WHETHER A FUMBLE ON THIS SHOT WOULD SKIP THE PRINTED TABLE (2026-08-26). The base's
        // `buildRangedCombatFumbleData` has an early return for auto-class weapons when the
        // `autoFumbleOnlyJam` setting is on: it rolls RELIABILITY instead of the Reflex (Combat) table,
        // so the fumble block it writes carries no table row at all (base utils.js:617-638). The class
        // derivation has to be told which branch was taken — it reads the block's html positionally and
        // a reliability face sitting where a table face belongs would be classified as a table row.
        //
        // ⛔ ASKED OF THE WEAPON, AT THE TRIGGER PULL, THE WAY THE BASE ASKS IT. `_isAutoWeapon` is the
        // base's own predicate (item.js:216) and this is the base's own pair of inputs (item.js:226-227),
        // so the two cannot drift; the literal fallback exists only for a host that has renamed the
        // method, and it uses the same two `rangedAttackTypes` values that predicate does ("Auto",
        // "Autoshotgun", lookups.js:35,50). Captured HERE rather than at the emit because it is a fact
        // about this weapon and this trigger pull, like the aim and the range beside it, and because the
        // render wrapper has the card's data but not the item.
        fumbleAutoOnlyJam: _autoOnlyJamBranchFor(this),
        // ⭐ THE WEAPON'S OWN ATTACK TYPE (2026-08-27) — a WEAPON fact, captured here beside the
        // weapon's name and its Long range for the same reason those two are, and NOT folded into
        // `ammoEffectFields` below: that list is the LOADED ROUND's mechanical consequences, and the
        // attack type is a property of the thing doing the firing.
        //
        // WHY THE DAMAGE RAIL NEEDS IT. An AREA-DELIVERY weapon — a grenade, a launcher, a missile —
        // is its own warhead: it carries no ammo item, so it reaches the explosion hook with none of
        // the `effectTypes` that hook has always keyed on, and a thrown grenade therefore resolved as
        // an ordinary single-target shot. `combat/area-delivery.js` reads this field to widen that
        // door (see `payloadDetonates`). The presentation rail asks the ITEM instead, because it has
        // the item in hand; this exists for the readers that only ever see the relayed payload.
        //
        // The base system's own field (lookups.js `rangedAttackTypes`), read through the same
        // `_getWeaponSystem()` accessor the base's fire methods use, so a cyberware weapon reports the
        // type of its Weapon work-block rather than the shell's. Null where the item cannot answer.
        attackType: (this._getWeaponSystem?.() ?? this.system)?.attackType ?? null,
        effectFields: ammoEffectFields(this),   // ammo-derived explosion/gas/spread/DOT/taser/AP/pen fields
      };
      return orig.call(this, attackMods, ...rest);
    }
    fireWrapper.__cpSeamShim = true;
    ItemProto[name] = fireWrapper;
    patchedAny = true;
  }
  // We got past the disengage check (the base does NOT emit weaponFired natively), yet NONE of the base
  // fire methods exist to wrap → the damage automation would silently never run. Make that loud so a
  // host rename of these methods is diagnosable, not a mysterious "nothing happens on fire". (C5)
  if (!foundAny) {
    console.warn(`${SCOPE} | seam shim: base emits no ${WEAPON_FIRED} and none of its fire methods (${FIRE_METHODS.join(", ")}) were found to patch — combat damage automation is inactive (did the base system rename them?).`);
  }
  // Only intercept the renderer if at least one fire method is actually shimmed; if all four emit
  // natively we never get here, so renderTemplate is left untouched (no chance of a double-emit).
  if (patchedAny) installRenderEmit();
  return patchedAny;
}

/**
 * SAY OUT LOUD THAT THE PATTERN MOVED — one notification, on the client that pulled the trigger, at the
 * moment its two faces are known (user ruling 2026-08-16: *"or just some way to let the player know it's
 * behaving as intended"*).
 *
 * ⭐ WHY A SIGNPOST IS OWED AT ALL. A missed pattern's true centre goes to the grenade table, so the
 * corridor the shooter carefully aimed is NOT the corridor that resolves — the rounds fly somewhere else
 * and the region is planted somewhere else. From the shooter's seat that is indistinguishable from the
 * aim gesture having been ignored, which is what a table reported it as. Naming the direction and the
 * distance turns a suspected bug into a visible rule.
 *
 * ⭐ WHY HERE. This is the earliest point at which ONE client knows both facts — that the base system
 * ruled the shot a miss, and which way the centre went — and it is the FIRING client, the one seat that
 * is certainly a person watching this shot. The plant runs on the active GM, which on a player's shot is
 * somebody else entirely. It fires once per pattern because the roll it sits beside does: the render
 * wrapper raises one payload per fire card (`_emittedFor`), and one card is one pattern however many
 * shells ride it.
 *
 * The direction NAME goes through `tryLocalize` and the sentence through the same two keys shape the
 * resolution card's own scatter line uses (damage-hooks.js `SpreadScatterLine`), so the notification and
 * the card cannot describe one drift two ways. Never throws: a client with no notifications banner still
 * fires the shot.
 */
function _signpostSpreadScatter(faces) {
  try {
    const drift = scatterDriftM(faces?.dirFace, faces?.distFace);
    ui.notifications?.info?.(drift.distanceM
      ? localizeParam("SpreadScatterNotice", { dir: tryLocalize(drift.name), dist: drift.distanceM })
      : localize("SpreadScatterNoticeNoDrift"));
  } catch (_e) { /* no UI on this client — the pattern still scatters */ }
}

/** Wrap the global renderTemplate ONCE so each fire-card render emits its hook, combining the captured
 *  method context with the render's own computed data: multi-hit.hbs → weaponFired (one per resolved
 *  target); suppressive.hbs → suppressiveFire. Idempotent — either shim half may install it. */
function installRenderEmit() {
  // The base fire methods render multi-hit.hbs via the BARE GLOBAL renderTemplate (Multiroll.execute →
  // renderTemplate(path, data)). On v13/v14 that global is a deprecation accessor whose SETTER overrides
  // what callers resolve, whereas foundry.applications.handlebars.renderTemplate is a NON-WRITABLE property
  // (assigning it throws in strict mode → aborts the shim). So capture + wrap the GLOBAL only.
  const orig = globalThis.renderTemplate;
  if (typeof orig !== "function" || orig.__cpSeamShim === true) return;

  async function renderWrapper(path, data, ...rest) {
    let out = await orig.call(this, path, data, ...rest);
    // ⭐ THE BASE SUPPRESSIVE CARD ARRIVES UNTHEMED (user report 2026-08-28): suppressive.hbs is the
    // one base chat card whose root <div> carries no `cyberpunk` class, so it takes neither the
    // system's own chat font nor this module's scheme-aware card styling (.chat-message .cyberpunk) —
    // it rendered as Foundry's default light parchment in every theme. The class is added HERE, at
    // the same seam that already reads this render, because the template is the base system's file
    // (base patches are temporary by policy) and the patched markup persists into the stored
    // ChatMessage content. First occurrence only: the template's root is its first <div>.
    if (path === SUPPRESSIVE_TEMPLATE && typeof out === "string") {
      out = out.replace("<div>", '<div class="cyberpunk">');
    }
    try {
      if (_fireCtx && path === MULTI_HIT_TEMPLATE && !(data && _emittedFor.has(data))) {
        if (data) _emittedFor.add(data);   // one card, one emission — however many wrappers are stacked
        const target = data?.target;   // a Token (full-auto sets it per shot); may be undefined otherwise
        // ⭐⭐ THE SCATTER DICE ARE ROLLED HERE, ONCE, AND TRAVEL WITH THE SHOT.
        //
        // A missed shot pattern goes to the grenade table (CP2020 p.108) and its true centre moves. TWO
        // rails then need to know where it moved to: the DAMAGE rail plants the pattern there, and the
        // PRESENTATION rail draws the rounds toward it. Those two rails run on DIFFERENT CLIENTS — the
        // plant runs on the active GM, the fan-out on whoever pulled the trigger — so a roll made inside
        // the plant is a roll the presentation never sees. It had already resolved its axis toward the
        // point the shooter aimed at, so on every miss the rounds flew one way and the pattern landed
        // another. Rolling at the one place the payload is ASSEMBLED puts both readers behind the same
        // two faces, and the fan-out reads the payload before anything else touches it.
        //
        // ⚠ THE RESULTS TRAVEL, NOT A SEED. This payload is relayed over the socket to the GM as JSON,
        // and there is no shared generator across clients to re-run a seed against — two faces of data
        // are the whole answer and they survive the trip unchanged.
        //
        // Nothing is rolled for a shot that cannot scatter: `payloadScattersOnMiss` wants a corridor the
        // shooter actually declared AND the base system's own verdict of a miss (see that function).
        // Every ordinary shot leaves this field absent, and every reader treats absent as "nobody
        // asked" — the behaviour that shipped before this existed.
        //
        // ⭐ THE PROBE CARRIES THE BASE'S RULED VERDICT TOO, not just the two numbers, and it must: the
        // predicate reads `spreadAttackOutcome`, and a probe assembled without `baseHit`/`fumbleRuled`
        // would send it back to the bare comparison — the very reading that ruled a fumbled shell a hit
        // (2026-08-26). Same three fields the emitted payload carries below, spelled the same way.
        // ⭐⭐ THE FUMBLE'S OUTCOME CLASS, DERIVED EXACTLY ONCE, HERE (2026-08-26). The base rules its
        // fumble table row before this render and writes the face into the block's html; nothing else in
        // this module may read it. Both the probe below and the emitted payload take THIS value, and the
        // four consumers switch on the field rather than deriving anything of their own — see
        // combat/fumble-outcome.js for the table, the parse and why the sub-roll is not on a field.
        // Null on every ordinary shot (no fumble block) and on a block this cannot read honestly.
        const fumbleClass = data?.fumble
          ? rangedFumbleClassFrom({ html: data.fumble?.html, autoOnlyJamBranch: !!_fireCtx.fumbleAutoOnlyJam })
          : null;
        const verdict = {
          spreadAim: _fireCtx.spreadAim ?? null,
          attackTotal: Number.isFinite(Number(data?.attackRoll?.total)) ? Number(data.attackRoll.total) : null,
          toHitDC: Number.isFinite(Number(data?.toHit)) ? Number(data.toHit) : null,
          baseHit: typeof data?.hit === "boolean" ? data.hit : null,
          fumbleRuled: !!data?.fumble,
          // ⛔ THE CLASS RIDES THE PROBE TOO, and it must: `payloadScattersOnMiss` is what decides
          // whether the grenade-table faces are rolled at all, and a rows-1-4 fumble is an ORDINARY MISS
          // that scatters. A probe assembled without this field would send that shell down the uniform
          // bail — no faces rolled — while the plant, reading the emitted payload, scattered it anyway
          // and rolled its own. That is the two-rails-two-answers defect, re-entered through the probe.
          fumbleClass,
        };
        let spreadScatter = null;
        if (payloadScattersOnMiss(verdict)) {
          spreadScatter = {
            dirFace: (await new Roll("1d10").evaluate()).total,
            distFace: (await new Roll("1d10").evaluate()).total,
          };
          _signpostSpreadScatter(spreadScatter);
        }
        // ⭐⭐ A MISSED WARHEAD'S FACES ARE ROLLED HERE TOO (2026-08-28, user report at the release
        // gate: the grenade flew to the aim point while the blast circle appeared where it landed).
        // Same two-rails reason as spreadScatter above: the plant scatters the blast on the active
        // GM's client (`_placeExplosion`), the presentation draws the lob on whoever pulled the
        // trigger, and a roll made at the plant is one the picture never sees. The miss test is the
        // SAME one the plant makes — a delivery payload whose card carried no rolled damage (the
        // base fills areaDamages only on a hit) — so the two sites cannot rule differently. Null on
        // every hit and every non-delivery shot; the plant keeps its own roll as the fallback for a
        // payload relayed from a build without this field.
        //
        // ⭐⭐ AND THE MISS TEST IS NOW A SHARED CALL (2026-08-28, the word-warhead family). It used to
        // be a damage sum written out here and a second copy of the same sum written out at the plant;
        // both read a card that carried no dice as a miss, which is exact for a warhead WITH dice and
        // wrong for one whose whole effect is a word (it fires through a substituted rollable zero and
        // lands a clean hit summing to nothing). `deliveryShotMissed` asks the base's own carried
        // verdict first and keeps the sum as its fallback — the full reasoning is at its definition in
        // combat/area-delivery.js. The base's boolean is passed in the shape the payload carries it in,
        // so this site and the plant are asking the identical question of the identical facts.
        let blastScatter = null;
        if (areaDeliveryKind(_fireCtx.attackType)) {
          const missed = deliveryShotMissed({
            baseHit: typeof data?.hit === "boolean" ? data.hit : null,
            areaDamages: data?.areaDamages,
          });
          if (missed) {
            blastScatter = {
              dirFace: (await new Roll("1d10").evaluate()).total,
              distFace: (await new Roll("1d10").evaluate()).total,
            };
          }
        }
        Hooks.callAll(WEAPON_FIRED, {
          attackerId: _fireCtx.attackerId,
          // WHICH FIGURE ON THE MAP FIRED — the attacker's id names the ACTOR, and an actor can have
          // several figures drawn, so the two are different questions and the presentation needs this
          // one. Same field name the suppressive payload uses, so both are read the same way. Null
          // when the seam could not establish it; a consumer that finds it absent resolves the origin
          // from the actor exactly as it did before the field existed.
          attackerTokenId: _fireCtx.attackerTokenId ?? null,
          weaponName: _fireCtx.weaponName,
          weaponId: _fireCtx.weaponId,
          // WHAT KIND OF ATTACK THIS WEAPON MAKES — carried for the readers that never see the item
          // (the GM's client, resolving a relayed payload). See the note where it is captured.
          attackType: _fireCtx.attackType ?? null,
          areaDamages: data?.areaDamages ?? {},
          // Rounds spent and rounds that landed for THIS card. areaDamages counts only the rounds
          // that hit, so a listener that needs the full round count (the per-shot fx fan-out) cannot
          // derive it — the card's own computed values carry it. Undefined on cards that don't set
          // them; consumers fall back to the hit count.
          shotsFired: data?.fired,
          shotsHit: data?.hits,
          // ⭐ TWO TARGET FIELDS, ON PURPOSE — they answer two different questions.
          //
          //   targetTokenId  = DAMAGE-FLOW ROUTING. The weaponFired handler branches on it: a payload
          //     that carries one resolves the target and opens the damage dialog mid-action (PATH A);
          //     a payload without one is flagged onto the shot's chat card so the GM applies it with a
          //     button, on their own beat (PATH B). Only the card's OWN target belongs here — full auto
          //     sets one per resolved target, so a multi-target burst still attributes each card
          //     correctly. The single-shot / burst / melee cards carry none, which is what keeps them on
          //     PATH B; the user chose card-then-click for those (a dialog opening in the middle of the
          //     action interrupts the turn), so folding the aimed-at token in here would silently move
          //     every one of them onto PATH A.
          //   fxTargetTokenId = PRESENTATION AIM. The effects rail needs to know which way the shot was
          //     pointed to draw a tracer and orient the muzzle sprite; that is true of every fire mode,
          //     including the ones deliberately left off PATH A. Carried separately so knowing the aim
          //     costs nothing in damage routing — the fx adapter reads targetTokenId first and falls back
          //     to this, and the damage handler never reads it at all.
          targetTokenId: target?.id ?? null,
          fxTargetTokenId: _fireCtx.fxTargetTokenId ?? null,
          // The declared corridor, carried whole. Null on every shot that was not aimed first — every
          // consumer treats a null as "nobody declared an aim" and computes one, which is the behaviour
          // that shipped before the placement gesture existed.
          spreadAim: _fireCtx.spreadAim ?? null,
          // WHERE THIS WARHEAD WAS AIMED — two scene-pixel coordinates, or null. Read by the damage rail
          // only (`_placeExplosion`): the blast is created on this point when the throw lands and
          // scatters FROM it when it misses. A payload without the field — a macro's shot, or one
          // relayed from a client on an older build — falls back to the aimed-at token's centre, which
          // is the behaviour that shipped before the gesture existed.
          aimPoint: _fireCtx.aimPoint ?? null,
          // WHAT THE PATTERN'S BAND EDGES ARE FRACTIONS OF — the firing weapon's own Long range, captured
          // at the trigger pull (see the note where it is read). Every reader of the corridor measures
          // its aim point against this one number; absent, they fall back to the ladder's compat edges.
          spreadRangeM: _fireCtx.spreadRangeM ?? null,
          // WHERE THE MISSED CENTRE WENT — the two grenade-table faces, rolled once above. Null on every
          // shot that hit and on every shot that declared no corridor.
          spreadScatter,
          // WHERE THE MISSED WARHEAD WENT — the same two faces for the delivery flow, rolled once
          // above. Read by the presentation (the lob flies to the landed point) and by the plant
          // (`_placeExplosion` consumes these instead of rolling its own). Null on every hit and
          // every non-delivery shot.
          blastScatter,
          // ⭐ WHETHER THE SHOT ACTUALLY HIT WHAT IT WAS POINTED AT, as the BASE SYSTEM already ruled it.
          //
          // The base rolls one attack per card — REF + the attack skill + every modifier the window
          // folded in + the weapon's accuracy — and compares it against the DC its own range table
          // gives the declared band (`rangeDCs`, lookups.js). Both numbers are already on the card's
          // computed data by the time this render runs, so they are carried rather than re-derived:
          // a pattern that decided hit-or-miss with a second roll would sit in the same chat log as
          // the base's own card saying the opposite, and a pattern that re-derived the DC from the
          // aim's distance would do the same for the same reason. One shot, one roll, one verdict.
          //
          // Read by the shot-pattern flow ONLY (combat/damage-hooks.js) — the ordinary single-target
          // damage path takes its outcome from the card's `areaDamages` exactly as before. Undefined
          // on any card that does not compute them, in which case the pattern behaves as it did
          // before this field existed and resolves where it was aimed.
          // ⚠ NULL, NOT NaN, when the card computes neither. This payload is also RELAYED over the
          // socket (a player's shot reaches the GM as JSON), and JSON turns a NaN into a null that
          // `Number()` then reads back as a perfectly finite ZERO — which would rule every relayed
          // shot a hit against a DC of zero. Nulled at the source and null-checked at the reader.
          attackTotal: Number.isFinite(Number(data?.attackRoll?.total)) ? Number(data.attackRoll.total) : null,
          toHitDC: Number.isFinite(Number(data?.toHit)) ? Number(data.toHit) : null,
          // ⭐⭐ AND THE BASE'S RULED VERDICT ITSELF (2026-08-26), which is a DIFFERENT fact from the two
          // numbers above and is why both travel now.
          //
          // The two numbers are the INPUTS to the base's ruling; they are not the ruling. The base
          // decides on more than the arithmetic — `_maybeApplyRangedFumble` (base item/item.js:221)
          // returns `forceMiss` for every fumble its table resolves, and each fire path then zeroes its
          // own hit count from that flag (autofire item.js:508, burst item.js:577, semi-auto
          // item.js:690) — so the card it posts can read MISS while `attackRoll.total` stands well over
          // the DC. It also does not rule the same way in every fire mode: autofire counts rounds as
          // `total − DC` (item.js:503), so a TIE lands zero rounds there and hits in semi-auto
          // (item.js:689). Any consumer re-deriving hit-or-miss from the two numbers therefore had to
          // disagree with the card sooner or later, and did — reported from the table: a fumbled shell
          // posted the base's fumble card and drew no presentation, while the corridor card announced
          // "31 vs 15 — hit". `templateData.hit` is the base's own boolean, computed after every one of
          // those rules; carrying it ends the second derivation.
          //
          // ⚠ BOOLEAN OR NULL, never coerced. This payload is relayed as JSON, and the readers treat
          // "not a boolean" as "the payload does not say" and fall back to the comparison — which is
          // what a payload from a client on an older build genuinely is.
          baseHit: typeof data?.hit === "boolean" ? data.hit : null,
          // How many rounds the base ruled home, beside the boolean, for readers that want the count
          // rather than the yes/no (the pattern flow wants the yes/no). Null when the card computes none.
          baseHits: Number.isFinite(Number(data?.hits)) ? Number(data.hits) : null,
          // WHO PULLED THE TRIGGER. This hook is a LOCAL `Hooks.callAll` — it is raised only on the
          // client that resolved the shot, never broadcast — so this field names the one client that
          // has the shot in hand. The damage handler uses it to decide who presents the result:
          // without it, that decision fell to whoever happened to hold the "active GM" seat, and at a
          // table with two GM sessions the GM who fired was not that seat, so nobody opened the apply
          // window for their own shot. A payload that lacks the field (a relayed or re-emitted one)
          // keeps the seat rule; see the gate in damage-hooks.js.
          firedByUserId: game.user?.id ?? null,
          targetActorId: target?.actor?.id ?? _fireCtx.fallbackTargetActorId ?? null,
          // Natural-1 on the attack roll (the multi-hit card carries it) — drives the mono
          // break-on-fumble rule in the weaponFired handler. Absent on non-melee cards → false.
          fumble: rollIsNaturalOne(data?.attackRoll),
          // ⭐ THE BASE'S OWN FUMBLE RULING, which is a DIFFERENT question from the field above and is
          // why both are carried. `fumble` is "the attack die came up 1" and is true whether or not the
          // table is in play; this one is true only when the base actually RESOLVED a fumble — its
          // `_maybeApplyRangedFumble` builds this block only when the `fumbleTableEnabled` setting is on,
          // and every path that builds it also sets `forceMiss`. So this is the honest signal for "the
          // round never went down-range": with the table OFF a natural 1 is an ordinary bad roll and the
          // gun really did fire, and suppressing that shot's presentation would be wrong.
          //
          // Reported from the table: a fumbled shot still drew a full muzzle blast down-range. The base
          // hands the card `fired: 1` on a fumble whatever the outcome was (roundsFired is computed
          // before the ruling is consulted), so the count alone cannot tell the rail that nothing was
          // discharged — measured on the rig: fired 1 / hits 0 / fumble block present. Only a boolean is
          // carried, not the block: the title/html are localized prose for the CARD, and the rail needs
          // one yes/no.
          fumbleRuled: !!data?.fumble,
          // ⭐⭐ WHICH ROW OF THE FUMBLE TABLE (2026-08-26, user ruling decided by Core p.43's REFLEX
          // Combat column, text-verified). `fumbleRuled` says a fumble was resolved; it does NOT say
          // what the table ruled, and the table does not rule one thing. Forty per cent of it (rows 1–4)
          // reads "No fumble. You just screw up." — a round that went down-range and MISSED — while the
          // rest is a dropped weapon, a jam, a harmless discharge, or a wound to the shooter's own side.
          // Treating them alike made every fumbled shell vanish, including the four-in-ten that should
          // have scattered like any other miss (p.108).
          //
          // ONE OF: "plainMiss" | "noDischarge" | "harmlessDischarge" | "ownSide" | null. Null is
          // "the class could not be read" and every consumer treats it as the old uniform bail, which is
          // also what a payload relayed from a client on an older build honestly is.
          //
          // ⛔ DERIVED ONCE, ABOVE, FROM THE BASE'S OWN ROLL. Nothing here re-rolls the table die — the
          // card on the table and this field describe the same 1d10, or they would be two fumbles.
          fumbleClass,
          ...(_fireCtx.effectFields ?? {}),   // explosion/gas/spread/DOT/taser/AP/pen fields from the ammo
        });
      } else if (_suppressiveCtx && path === SUPPRESSIVE_TEMPLATE) {
        // suppressive.hbs carries the base method's already-computed saveDC/dmgFormula/weaponName/width;
        // the wrapper supplies the actor/token/range context the render data lacks. Matches the fork's
        // native cyberpunk2020.suppressiveFire payload so damage-hooks.js draws the fire zone identically.
        // roundsFired is the placement preview's DC numerator (it divides by the player-drawn width to
        // derive the live evasion DC); zoneWidth is the DECLARED width (dialog field) — it seeds the preview's
        // opening corridor, and saveDC is the base's DC for that declared width (what the base card quotes and
        // what stands when the zone automation is off).
        Hooks.callAll(SUPPRESSIVE_FIRE, {
          saveDC: data?.saveDC,
          dmgFormula: data?.dmgFormula,
          weaponName: data?.weaponName,
          actorId: _suppressiveCtx.actorId,
          attackerTokenId: _suppressiveCtx.attackerTokenId,
          zoneWidth: data?.width,
          weaponRange: _suppressiveCtx.weaponRange,
          roundsFired: _suppressiveCtx.roundsFired,
        });
      }
    } catch (e) {
      console.warn(`${SCOPE} | seam-shim card render emit failed`, e);
    }
    return out;
  }
  renderWrapper.__cpSeamShim = true;
  // Assign the global (an accessor with a working setter on v13/v14); the base system's bare
  // `renderTemplate(...)` call then resolves to our wrapper. Guarded so a non-writable binding on some
  // future core can't abort the shim — weaponFired auto-emit just won't engage there.
  try {
    globalThis.renderTemplate = renderWrapper;
    // Remember WHICH function we put there, so "did the install hold?" is an identity question with a
    // yes/no answer rather than an assumption. renderEmitLive() is the only reader.
    _renderWrapper = renderWrapper;
  } catch (e) {
    console.warn(`${SCOPE} | seam-shim could not wrap renderTemplate; weaponFired/suppressiveFire will not auto-emit`, e);
  }
}

/* ─── suppressiveFire: identity/range from the method, computed values from the render ─────────── */

/** Wrap __suppressiveFire so it emits suppressiveFire on stock (the base posts a card but fires no hook,
 *  so damage-hooks.js never draws the fire zone / prompts evasion). The wrapper only CAPTURES the context
 *  the suppressive.hbs render data lacks (attacker actor/token + weapon range); installRenderEmit() does
 *  the actual emit when that template renders, reading the base's already-computed saveDC/dmgFormula/width
 *  (recomputing saveDC here would drift — the base derives it from a shot count it then decrements). */
function installSuppressiveFireShim(ItemProto) {
  if (prototypeEmits(ItemProto, SUPPRESSIVE_FIRE)) return false;  // base system emits it → disengage
  const orig = ItemProto?.__suppressiveFire;
  if (!shouldPatch(orig)) return false;                          // missing or already ours → skip
  function suppressiveWrapper(mods, ...rest) {
    const sys = this._getWeaponSystem?.() ?? {};
    // Rounds actually laid down this burst — recomputed EXACTLY as base item.js __suppressiveFire does
    // (rof/shotsLeft floored to non-negative ints, requested = mods.roundsFired || maxRounds, clamped
    // 1..maxRounds, and 0 when the gun is empty). This is the numerator of the base's saveDC =
    // ceil(rounds ÷ width); the placement preview divides it by the player-DRAWN width to derive the
    // live evasion DC, so it must equal the base's `rounds` to the round — hence mirroring the base
    // formula here rather than taking a fresh reading. saveDC itself is NOT recomputed (drift note above).
    const rof = Math.max(0, Math.floor(Number(sys.rof) || 0));
    const shotsLeft = Math.max(0, Math.floor(Number(sys.shotsLeft) || 0));
    const maxRounds = Math.min(rof, shotsLeft);
    const requested = Math.floor(Number(mods?.roundsFired) || maxRounds);
    const roundsFired = maxRounds > 0 ? Math.min(Math.max(requested, 1), maxRounds) : 0;
    _suppressiveCtx = {
      actorId: this.actor?.id ?? null,
      // Captured by the SAME rule the fire wrapper uses, so the zone is laid from the figure that laid
      // it down. This used to take the first figure on the canvas whose actor matched, which cannot
      // tell two figures of one actor apart (see firingTokenIdOf).
      attackerTokenId: firingTokenIdOf(this.actor),
      weaponRange: Number(sys.range ?? 50),
      roundsFired,
    };
    return orig.call(this, mods, ...rest);
  }
  suppressiveWrapper.__cpSeamShim = true;
  ItemProto.__suppressiveFire = suppressiveWrapper;
  installRenderEmit();   // the shared render wrap emits suppressiveFire when suppressive.hbs renders
  return true;
}

/* ─── skillRolled: the whole payload is available to a simple wrapper ──────────────────────────── */

function installSkillRolledShim(ActorProto) {
  if (prototypeEmits(ActorProto, SKILL_ROLLED)) return false;  // base system emits it (rollSkill or a helper) → disengage
  const orig = ActorProto?.rollSkill;
  if (!shouldPatch(orig)) return false;                        // missing or already ours → skip
  function rollSkillWrapper(skillId, ...rest) {
    // Emit cyberpunkSkillRolled AFTER the roll, carrying its total. The base's common rollSkill path
    // posts its roll card WITHOUT awaiting it and returns nothing, so the total isn't on the return —
    // instead capture the roll card as it's created (Multiroll attaches rolls:[…]) and emit from there.
    // The old shim emitted BEFORE the roll with no total, so every IP-tracker queue row showed 0 (F8).
    try {
      const skill = this.items?.get?.(skillId);
      if (skill) {
        const actorId = this.id, actorName = this.name, rolledSkillId = skill.id, skillName = skill.name;
        let done = false;
        let claimedId = null;   // the card id THIS listener consumed (for cleanup)
        const hookId = Hooks.on("createChatMessage", (msg) => {
          if (done) return;
          const total = msg?.rolls?.[0]?.total;
          if (typeof total !== "number") return;   // wait for the actual rolled card
          // Consume ONLY this user's own roll card — another user's card in the window would mis-attribute
          // its total to this queue row. Author is the reliable owner signal at creation and is
          // authoritative; only when it's unavailable (msg.author can be absent on v14+) fall back to
          // matching the card's speaker actor to the rolled actor.
          const authorId = msg?.author?.id ?? msg?._source?.author ?? null;
          if (authorId) {
            if (authorId !== game.user?.id) return;            // another user's card
          } else {
            const speakerActorId = msg?.speaker?.actor ?? null; // author unknown → prefer a speaker match
            if (speakerActorId && speakerActorId !== actorId) return;
          }
          // Two overlapping same-user rolls pass the author check identically; the shared claim set keeps
          // them apart. Skip a card another live listener already took, and claim this one so a sibling
          // listener can't take it too. Hooks fire in registration order, so the oldest live listener
          // claims the first card and the next claims the second → totals stay matched to their skills.
          const cardId = msg?.id ?? null;
          if (cardId) {
            if (_claimedSkillCards.has(cardId)) return;        // already consumed by another live listener
            _claimedSkillCards.add(cardId);
            claimedId = cardId;
          }
          done = true;
          Hooks.off("createChatMessage", hookId);
          try { Hooks.callAll(SKILL_ROLLED, { actorId, skillId: rolledSkillId, actorName, skillName, total }); }
          catch (e) { console.warn(`${SCOPE} | seam-shim skillRolled emit failed`, e); }
        });
        // Never leak the hook (or a stale claim) if no rolled card appears (e.g., the skill vanished before the roll).
        setTimeout(() => {
          if (!done) { done = true; Hooks.off("createChatMessage", hookId); }
          if (claimedId) { _claimedSkillCards.delete(claimedId); claimedId = null; }
        }, 8000);
      }
    } catch (e) {
      console.warn(`${SCOPE} | seam-shim skillRolled setup failed`, e);
    }
    return orig.call(this, skillId, ...rest);
  }
  rollSkillWrapper.__cpSeamShim = true;
  ActorProto.rollSkill = rollSkillWrapper;
  return true;
}

/* ─── Entry point (call once at ready, after the base system's classes exist) ──────────────────── */

/** Install the seam shim, self-disengaging where the base system already emits the hooks.
 *  @returns {{weaponFired:boolean, skillRolled:boolean}} which halves actually engaged. */
export function registerSeamShim() {
  const out = { weaponFired: false, suppressiveFire: false, skillRolled: false };
  const ItemProto = CONFIG?.Item?.documentClass?.prototype;
  const ActorProto = CONFIG?.Actor?.documentClass?.prototype;
  // Install each half in its OWN try/catch: a failure wrapping one hook must never abort the other.
  try {
    if (ItemProto) out.weaponFired = installWeaponFiredShim(ItemProto);
  } catch (e) {
    console.warn(`${SCOPE} | seam shim weaponFired install failed`, e);
  }
  try {
    if (ItemProto) out.suppressiveFire = installSuppressiveFireShim(ItemProto);
  } catch (e) {
    console.warn(`${SCOPE} | seam shim suppressiveFire install failed`, e);
  }
  try {
    if (ActorProto) out.skillRolled = installSkillRolledShim(ActorProto);
  } catch (e) {
    console.warn(`${SCOPE} | seam shim skillRolled install failed`, e);
  }
  // PROVE THE WRAP TOOK, rather than reporting that we asked for it. Everything above can return true
  // and still leave the rail dead: patching the fire methods is the easy half, and the emission that
  // makes them matter rides the one assignment that can be defeated without throwing. Retry once —
  // an install that lost a race can win the re-run — and if it still is not ours, say so where a GM
  // will actually see it. A combat layer that is silently inert is precisely the failure that took
  // two evenings to characterize; it should announce itself in one line.
  if (out.weaponFired && !renderEmitLive()) {
    installRenderEmit();
    if (!renderEmitLive()) {
      console.error(`${SCOPE} | seam shim: the card-render wrap did not take — ${WEAPON_FIRED} will not be emitted on this client, so damage automation and combat presentation are inactive until it is reloaded.`);
      try { ui.notifications?.error?.(localize("Augmented.SeamRailInactive"), { permanent: true }); } catch (_e) { /* no UI on this client */ }
    }
  }
  if (out.weaponFired || out.suppressiveFire || out.skillRolled) {
    console.log(`${SCOPE} | seam shim engaged (base system lacks native hooks):`, out, `render emit live: ${renderEmitLive()}`);
  }
  return out;
}
