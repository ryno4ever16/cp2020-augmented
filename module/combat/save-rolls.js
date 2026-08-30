import { onGlobalClick } from "../popout-compat.js";
import { localize, localizeParam, resolveActorRef, cappedWoundState } from "../utils.js";
import { renderChatCard } from "../compat.js";
import { markCardResolved, isCardResolved } from "../card-lock.js";
import { isPrimaryGMSession } from "../gm-session-primary.js";
import { dotStackMode } from "../settings.js";

// The chat-card helpers now live in compat.js so the vehicle module can reuse them without
// importing the combat module. Re-exported here for back-compat (damage-hooks.js imports
// postSavePromptCard from this file).
export { postSavePromptCard } from "../compat.js";

/**
 * save-rolls.js  —  module/combat/save-rolls.js
 *
 * STUN/SHOCK SAVE (CP2020 p.99):
 *   Roll 1d10 ≤ Stun Threshold to stay conscious.
 *   Stun Threshold = Body Type − wound state penalty, min 1.
 *   Penalties: Light 0, Serious -1, Critical -2, Mortal 0 -3, Mortal 1 -4, ...
 *   Table only defined through Mortal 6 (-9 penalty) — original code caps at 7 Mortal levels.
 *   Fail = unconscious. Recover by passing Stun Save on a later turn.
 *
 * DEATH SAVE (CP2020 p.99):
 *   Only required at Mortal wound state (woundState ≥ 4).
 *   Roll 1d10 ≤ Death Threshold to survive this turn. (RAW: "equal to or lower than")
 *   Death Threshold = BT − mortalLevel. No floor — threshold 0 = automatic death.
 *   At threshold 0 (or below): no roll possible, automatic death.
 *   At threshold 1: roll ≤ 1 on d10 → 10% survival chance.
 *   Must repeat every turn while Mortal and unstabilized.
 *
 * BOTH SAVES AT MORTAL (p.99):
 *   At a Mortal wound state, the character must make BOTH saves:
 *   Death Save first (more urgent), then Stun Save.
 *   Death save determines survivability; stun save determines consciousness if alive.
 *
 * MORTAL WOUND SCALE:
 *   Stun save table only defines through Mortal 6 (penalty -9). Original code
 *   (actor-sheet.js Array(7)) caps the wound track at Mortal 6. The rulebook's
 *   "rated from 0 to 8" contradicts both the stun table and character sheet — cap at 6.
 *
 * STUN STATUS — MOVEMENT RESTRICTION:
 *   Foundry's "unconscious" effect can carry movement restriction.
 *   We apply a movement speed override of 0 to stunned tokens.
 */

/**
 * Stun and death saves may only be resolved by the actor's owner or the GM. Players
 * see every prompt (so the table can follow the action) but can only roll saves for
 * characters they own. Returns true if the current user may proceed; otherwise shows
 * a notice and returns false. Synchronous — runs before any roll/await.
 *
 * NOTE: this gate is deliberately NOT used for stabilization. Stabilizing is a medic
 * action performed ON a patient, so any user may attempt it on any target (see
 * executeStabilize); only the resulting flag write is owner-gated, via the relay below.
 */
function _assertCanResolveSave(actor) {
  if (game.user.isGM || (actor?.isOwner ?? false)) return true;
  ui.notifications.warn(localizeParam("SaveNotOwned", { name: actor?.name ?? localize("ThisCharacter") }));
  return false;
}

/** A user can write an actor's documents (set its stabilized flag) only if GM or owner. */
function _canModifyActor(actor) {
  return game.user.isGM || (actor?.isOwner ?? false);
}

/**
 * A medic may stabilize a patient they don't own. The roll runs locally (world-visible
 * chat), but writing the patient's `stabilized` flag needs ownership — so a non-owner's
 * success is relayed to the primary GM, who performs the write. Only the GM listens.
 */
function _relayStabilizedFlag({ actorId, tokenId = null, sceneId = null }) {
  if (!game.users.activeGM) {
    ui.notifications.warn(localize("StabilizeNoGM"));
    return;
  }
  game.socket.emit("module.cp2020-augmented", { type: "stabilizeFlag", actorId, tokenId, sceneId, requesterId: game.user.id });
  ui.notifications.info(localize("StabilizeRelayed"));
}

/**
 * GM-side listener for relayed stabilization writes (see _relayStabilizedFlag).
 * Shares the module.cp2020-augmented channel with the damage relay; filters on
 * type === "stabilizeFlag". Only the primary GM responds (no double-write under 2+ GMs).
 */
function _registerStabilizeSocket() {
  game.socket.on("module.cp2020-augmented", async (data) => {
    if (data?.type !== "stabilizeFlag") return;
    // Idempotent (both writes set the same flag to true), so this row never showed a visible fault —
    // it is here for the same reason as the others: one session, one write.
    if (!isPrimaryGMSession()) return;
    // Token-first: stabilizing an unlinked token's patient must flag THAT token's synthetic actor.
    const actor = resolveActorRef({ tokenId: data.tokenId, sceneId: data.sceneId, actorId: data.actorId });
    if (!actor) return;
    try {
      await actor.setFlag("cp2020-augmented", "stabilized", true);
    } catch (err) {
      console.warn("cp2020-augmented | Stabilize flag relay failed:", err);
    }
  });
}

/**
 * Cumulative taser save penalty: each successive hit within a 3-turn window
 * reduces stun threshold by stunSaveMod. Returns the total penalty (always ≥ 0).
 */
function _getTaserPenalty(actor) {
  // ⏪ `taserCumPenaltyEnabled` RETIRED 2026-08-29 (settings-trim): firing the round that carries the
  // shock rider is the consent, and a figure that was never shocked carries no state to read.
  const state = actor.getFlag?.("cp2020-augmented", "taserState");
  if (!state || state.count <= 1) return 0;
  const currentRound = game?.combat?.round ?? 0;
  // Penalty expires outside the 3-turn window. round=0 means outside combat — always active.
  if (state.round > 0 && currentRound > state.round + 2) return 0;
  return (state.count - 1) * Math.abs(state.mod ?? 2);
}

/**
 * THE LASTING-DAMAGE FLAG'S OWN CORE CONDITION, raised and lowered with it.
 *
 * ⭐ WHY THIS EXISTS (user report): a figure set on fire showed the ring and had NOTHING in its Active
 * Effects. The two lasting-damage engines below keep their state in module flags — `fireDotState` while
 * a body is burning, `dotState` while a load is eating its armour — and nothing ever toggled core's own
 * `burning` / `corrode`, so no ActiveEffect document existed. Everything reading the FLAG agreed with
 * everything else (the condition-overlay rail draws off both roads); everything reading
 * `actor.statuses` — the token HUD, the effects list, any other module — saw an unhurt figure. One
 * mechanism, two vocabularies, and only one of them was being spoken.
 *
 * ⚠ GUARDED ON THE CURRENT STATE rather than trusting the toggle to be idempotent. `toggleStatusEffect`
 * with an explicit `active` is meant to be safe to repeat, but a burn that is re-ignited every turn
 * would otherwise write a document update on every re-ignition for no change at all — and this is
 * called from the damage path, which the busiest hook in the module is already listening to. Reading
 * `actor.statuses` first makes the no-op free and makes the "already off" clear genuinely free too.
 *
 * ⚠ THE ACTOR HANDED IN IS THE ONE TO WRITE. For an unlinked figure that is the token's own synthetic
 * actor, and the status belongs on THAT body rather than on the world actor its id also matches — the
 * same rule every other write in this file follows (see the combat data hazards note).
 *
 * Returns whether it actually moved, so a caller and a keeper can tell a change from a no-op.
 */
export async function mirrorDotStatus(actor, statusId, active) {
  try {
    if (!actor?.toggleStatusEffect || !statusId) return false;
    if ((actor.statuses?.has?.(statusId) === true) === !!active) return false;   // already where we want it
    await actor.toggleStatusEffect(statusId, { active: !!active });
    return true;
  } catch (err) {
    console.warn(`cp2020-augmented | could not mirror the ${statusId} condition`, err);
    return false;
  }
}

/**
 * Apply an acid DOT hit, respecting the shared `dotStackMode` selector.
 * ⏪ `acidDotStackMode` RETIRED 2026-08-29 (settings-trim) — MERGED with `fireDotStackMode` into the one
 * `dotStackMode` key (same three values, same default): no book text distinguishes how an acid timer and
 * a burn timer combine, so two selectors were two ways to answer one question.
 * Modes: "stack" extends turnsLeft at same location, "reset" overwrites, "separate" adds concurrent timer.
 * Legacy single-object dotState is transparently migrated to array format on read.
 * The flag is mirrored onto core's `corrode` on the way in (mirrorDotStatus); the per-turn tick in
 * damage-hooks.js takes it off again when the last marker expires.
 */
export async function applyAcidDotState(target, location, turnsLeft, formula) {
  const mode = dotStackMode();
  const newEntry = { location, turnsLeft: Number(turnsLeft), formula: String(formula || "1d6") };

  if (mode === "reset") {
    await target.setFlag("cp2020-augmented", "dotState", [newEntry]);
    await mirrorDotStatus(target, "corrode", true);
    return;
  }

  const raw = target.getFlag?.("cp2020-augmented", "dotState");
  const states = Array.isArray(raw) ? [...raw] : (raw ? [raw] : []);

  if (mode === "stack") {
    const idx = states.findIndex(s => s.location === location);
    if (idx >= 0) {
      states[idx] = { location, turnsLeft: states[idx].turnsLeft + Number(turnsLeft), formula: String(formula || "1d6") };
    } else {
      states.push(newEntry);
    }
  } else {
    // "separate": push a new independent timer regardless of existing effects at the location
    states.push(newEntry);
  }
  await target.setFlag("cp2020-augmented", "dotState", states);
  await mirrorDotStatus(target, "corrode", true);
}

/**
 * Apply a FIRE (incendiary) DOT hit, respecting the shared `dotStackMode` selector.
 * ⏪ `fireDotStackMode` RETIRED 2026-08-29 (settings-trim) — MERGED into `dotStackMode` alongside the acid
 * one; see {@link applyAcidDotState}.
 * Mirrors {@link applyAcidDotState} but writes the separate `fireDotState` flag — fire burns HP
 * each turn (handled by the combat tick in damage-hooks.js), whereas acid degrades armor SP.
 * Modes: "stack" extends turnsLeft at same location, "reset" overwrites, "separate" adds a
 * concurrent timer. Legacy single-object state is transparently migrated to array form on read.
 * The flag is mirrored onto core's `burning` on the way in (mirrorDotStatus); the per-turn tick in
 * damage-hooks.js takes it off again when the last marker expires.
 */
export async function applyFireDotState(target, location, turnsLeft, formula, flat = false) {
  const mode = dotStackMode();
  // `mult` is the tick's multiplier. By default it HALVES each surviving turn so the burn diminishes —
  // the Armor-Piercing Incendiary load's model (1d6, then 1d6/2), generalized from the CP2020 p.110
  // flamethrower ladder.
  //
  // ⭐ `flat` IS THE OPT-OUT, and it is carried per marker rather than read from a setting because it is
  // a fact about the ROUND that started this burn, not about the table. CP2020 p.64 prints the grenade's
  // own figure with no decay — "Incendiary (4D6 for 3 turns)" — so a marker seeded from that round keeps
  // its multiplier at 1 for every turn it lasts, while a marker seeded from anything else halves exactly
  // as it always has. Two burns on the same figure, one from each source, tick on their own ladders.
  const newEntry = { location, turnsLeft: Number(turnsLeft), formula: String(formula || "1d6"), mult: 1, flat: !!flat };

  if (mode === "reset") {
    await target.setFlag("cp2020-augmented", "fireDotState", [newEntry]);
    await mirrorDotStatus(target, "burning", true);
    return;
  }

  const raw = target.getFlag?.("cp2020-augmented", "fireDotState");
  const states = Array.isArray(raw) ? [...raw] : (raw ? [raw] : []);

  if (mode === "stack") {
    const idx = states.findIndex(s => s.location === location);
    if (idx >= 0) {
      // Re-ignite: extend duration and restore full intensity at this location. The INCOMING round's
      // ladder is the one the extended marker burns on — re-igniting with a flat round makes the whole
      // remaining burn flat, and re-igniting with an ordinary one puts it back on the halving ladder.
      states[idx] = { location, turnsLeft: states[idx].turnsLeft + Number(turnsLeft), formula: String(formula || "1d6"), mult: 1, flat: !!flat };
    } else {
      states.push(newEntry);
    }
  } else {
    states.push(newEntry);
  }
  await target.setFlag("cp2020-augmented", "fireDotState", states);
  await mirrorDotStatus(target, "burning", true);
}

/* ═══════════════ TIMED SENSE CONDITIONS — the Dazzle / Sonic half of CP2020 p.64 ═══════════════
 *
 * ⛔ WHY THESE ARE THE SAME MECHANISM AS THE TWO ABOVE AND NOT A NEW ONE. p.64 prints "Dazzle (Blind
 * for 4 turns), Sonic (deafened 4 turns)" — a condition on a body with a printed number of turns on it,
 * which is exactly what `fireDotState` and `dotState` already are. So this reuses their whole shape
 * rather than inventing a parallel: an ARRAY of markers on an actor flag, each carrying its own
 * `turnsLeft`, counted down by the combat tick in damage-hooks.js (`_runOverTimeTick`), mirrored onto
 * a CORE STATUS on the way in and off it when the LAST marker of that condition expires
 * (`mirrorDotStatus`, whose own note explains why the two vocabularies must both be spoken).
 *
 * ⛔ WHAT IS DELIBERATELY NOT USED. Not a bare `setTimeout` — a wall clock is not the fight's clock and
 * would keep counting through a paused table. Not an unexpiring status either: a condition the referee
 * has to remember to remove is the thing this whole family of engines exists to avoid.
 *
 * ⭐ THE STATUS IDS ARE FOUNDRY'S OWN — `blind` and `deaf` are in core's default `CONFIG.statusEffects`
 * and the base system registers none of its own (verified in fx/status-fx.js's detection note), so a
 * dazzled figure gets a real ActiveEffect that the token HUD, the effects list and every other module
 * can read. The module's own condition-overlay rail reads the same two roads and needs no change.
 *
 * ⚠ ONE MARKER PER CONDITION PER BODY, and the longer duration wins. Two dazzle grenades in one
 * detonation are one blinding, not two four-turn timers running side by side — the same reading the
 * acid/fire engines' "stack" mode takes at a location, resolved here to a MAX rather than a sum because
 * p.64 states a fixed duration for the effect rather than a quantity that accumulates.
 */

/** The two conditions this engine models, keyed by the effect word the payload carries, each naming the
 *  CORE status id it is mirrored onto. Closed: a word outside it is not a sense condition. */
export const WORD_CONDITIONS = Object.freeze({
  Blind: "blind",
  Deaf:  "deaf",
});

/**
 * Raise a timed sense condition on one body.
 *
 * @param {Actor}  target      the actor to mark — for an unlinked figure, ITS OWN synthetic actor
 * @param {string} word        "Blind" or "Deaf" (a word outside WORD_CONDITIONS is a no-op)
 * @param {number} turns       how many turns it lasts (CP2020 p.64 prints 4 for both)
 * @param {string} weaponName  what caused it, for the expiry notice
 * @returns {Promise<boolean>} whether a marker was written
 */
export async function applyWordConditionState(target, word, turns, weaponName = "") {
  const statusId = WORD_CONDITIONS[word];
  const turnsLeft = Math.max(0, Math.floor(Number(turns) || 0));
  if (!target || !statusId || turnsLeft <= 0) return false;

  const raw = target.getFlag?.("cp2020-augmented", "wordConditionState");
  const states = Array.isArray(raw) ? [...raw] : (raw ? [raw] : []);
  const idx = states.findIndex(s => s?.word === word);
  const entry = { word, turnsLeft, weaponName: String(weaponName || "") };
  if (idx >= 0) {
    // The longer of the two stands — see the cardinality note above.
    states[idx] = { ...entry, turnsLeft: Math.max(Number(states[idx].turnsLeft) || 0, turnsLeft) };
  } else {
    states.push(entry);
  }
  await target.setFlag("cp2020-augmented", "wordConditionState", states);
  await mirrorDotStatus(target, statusId, true);
  return true;
}

/**
 * Route a WORD-WARHEAD payload's timed condition to the engine above. The payload states the word and
 * the duration; a word that names no condition (a "Stun" or "Gas" payload, whose consequences are
 * elsewhere) is a clean no-op, so every caller can hand over whatever word it read without branching.
 */
export async function applyWordConditionFromPayload(target, word, src = {}) {
  if (!WORD_CONDITIONS[word]) return false;
  return await applyWordConditionState(target, word, Number(src.dotTurns), String(src.weaponName || ""));
}

/**
 * Route a DOT-bearing payload to the correct mechanic by its dotType ("fire" -> HP burn,
 * anything else -> acid armor degradation). Honors each mechanic's enable setting. Safe no-op
 * when the payload has no active DOT or no hit location. Centralizes the per-site routing so
 * every damage-application path behaves identically.
 */
export async function applyDotFromPayload(target, location, src, penetrated = true) {
  if (!target || !location || !src) return;
  if (!src.dotEnabled || Number(src.dotTurns) <= 0) return;

  const turns   = Number(src.dotTurns);
  const formula = String(src.dotDamageFormula || "1d6");
  const dotType = String(src.dotType || "acid");

  if (dotType === "fire") {
    // Incendiary only ignites the target when the round gets through armor (RAW: "if the bullet
    // penetrates"). An unarmored target always counts as penetrated, so they always catch fire.
    if (!penetrated) return;
    // ⏪ `fireDotEnabled` RETIRED 2026-08-29 (settings-trim): OFF bought the dead state — an incendiary
    // round that lands and burns nothing. The round declaring `dotEnabled` (checked above) is the consent.
    // The round's own ladder rides through with its formula and its duration. A payload from before the
    // field existed passes undefined, which coerces to the halving that has always been the default.
    await applyFireDotState(target, location, turns, formula, Boolean(src.dotFlat));
  } else {
    // ⏪ `acidArmorDotEnabled` RETIRED 2026-08-29 (settings-trim): the `dotEnabled` guard above is the
    // consent, and no shipped ammo item sets it — a GM authors the round by hand.
    await applyAcidDotState(target, location, turns, formula);
  }
}

/** Update taser hit counter on target. Call only when the hit penetrates armor. */
export async function updateTaserState(actor, payload) {
  const mod   = Number(payload.stunSaveMod ?? -2);
  const round = game?.combat?.round ?? 0;
  const state = actor.getFlag?.("cp2020-augmented", "taserState");
  const withinWindow = state && (state.round === 0 || (round > 0 && round <= state.round + 2));
  const count = withinWindow ? (state.count ?? 0) + 1 : 1;
  await actor.setFlag("cp2020-augmented", "taserState", { count, round, mod });
}

/**
 * Stun Threshold: roll ≤ this to stay conscious.
 * Floored at 1. Reduced by cumulative taser penalty.
 */
export function getStunThreshold(actor) {
  // ⭐ DERIVED FROM THE CAPPED STATE (2026-08-27 — utils `cappedWoundState`). The base's own
  // `stunThreshold()` is `BT − woundState() + 1`, and `woundState()` has no ceiling, so a figure
  // carrying banked damage from a build before the write clamp produced a threshold hundreds below
  // zero. It was floored to 1 here and so never printed wrong — but the PENALTY built from the same
  // uncapped number did print wrong (reported at 94), and the two must be built from one reading.
  // The base's own method still answers whenever the state is inside the table, so a base that
  // overrides it keeps winning for every figure a table will ever actually have.
  const raw = Number(actor?.woundState?.() ?? 0) || 0;
  const ws  = cappedWoundState(actor);
  const base = (actor.stunThreshold && raw === ws)
    ? Math.max(1, actor.stunThreshold())
    : Math.max(1, (Number(actor.system?.stats?.bt?.total) || 0) - ws + 1);
  return Math.max(1, base - _getTaserPenalty(actor));
}

/**
 * Death Threshold: roll ≤ this to survive (RAW: "equal to or lower than", p.99).
 * BT − mortalLevel, floored at 0. Threshold 0 = automatic death (roll ≤ 0 on d10 is impossible).
 * Threshold 1 = 10% survival chance. mortalLevel capped at 6 (stun table defines no further).
 */
export function getDeathThreshold(actor) {
  const bt          = Number(actor.system?.stats?.bt?.total) || 0;
  const woundState  = actor.woundState?.() ?? 4;
  const mortalLevel = Math.min(6, Math.max(0, woundState - 4));
  return Math.max(0, bt - mortalLevel);
}

/**
 * The wound track's label for a state number. Exported so the per-application severity ledger
 * (combat/severity-batch.js) writes its progression line off the SAME ladder the stun prompt prints —
 * a second copy of "which state is called what" is a second thing to keep in step.
 */
export function woundStateLabel(woundState) {
  if (woundState <= 0) return localize("Uninjured");
  if (woundState === 1) return localize("Light");
  if (woundState === 2) return localize("Serious");
  if (woundState === 3) return localize("Critical");
  // Mortal 0..6 (the stun table defines no further — cap at Mortal 6).
  return localizeParam("Mortal", { mortality: Math.min(woundState, 10) - 4 });
}

function getTokenId(actor) {
  return canvas?.tokens?.placeables?.find(t => t.actor?.id === actor.id)?.id ?? "";
}

/**
 * ⭐⭐ A SAVE MODIFIER THIS ONE PROMPT WAS BUILT WITH, carried to its own resolution (2026-08-28).
 *
 * ⛔ THE PROBLEM IT SOLVES. CP2020 p.64 gives the stun grenade "Stun (-5 to Stun)": one save, one flat
 * penalty, at the detonation. The module's existing save penalty is the TASER ladder, and that is a
 * different rule by design — `_getTaserPenalty` returns `(count − 1) × |mod|`, so the FIRST shock
 * carries no penalty at all and only successive hits inside a three-turn window bite. Routing the
 * grenade through it would have delivered exactly −0 on the one save the book prices at −5, and
 * routing it through it with a faked count would have made the taser's own ladder read wrong.
 *
 * ⭐ SO IT RIDES THE PROMPT, WHICH IS AN IDIOM THIS FILE ALREADY HAS. `postDeathSavePrompt` takes a
 * `forcedMortalLevel`, prints the threshold it built, puts the value on the button as `data-mortal-
 * level`, and `executeDeathSave` resolves at THAT value rather than re-deriving one — "resolve at the
 * same level the prompt was built with", written out at its own call. This is the same mechanism for
 * the same reason: the number is a fact about the EVENT that asked for the save, not a lasting state of
 * the body, so it travels with the question and dies with it. Nothing is written to the actor, nothing
 * has to be cleared afterwards, and a second unrelated stun save posted the same turn is unaffected.
 *
 * ⚠ THE VALUE IS THE PAYLOAD'S OWN AND IS NEGATIVE (`stunSaveMod: -5`), so it is ADDED to the threshold
 * and the result is floored at 1 exactly as `getStunThreshold` floors its own — a save is never made
 * impossible by it, which is the same guarantee every other threshold in this file gives.
 */
export async function postStunSavePrompt(actor, token = null, { perTurn = false, saveMod = 0 } = {}) {
  // ⭐ THE CAPPED STATE IS WHAT THIS CARD IS BUILT FROM (2026-08-27 — utils `cappedWoundState`). The
  // wound LABEL was already clamped to Mortal 6 inside `woundStateLabel`; the penalty line beside it
  // was not, so one card printed "Mortal 6" and "− 94 (wound penalty)" at the same time. Both halves
  // now read the same number, and it is the last row the table defines.
  const woundState   = actor.woundState ? cappedWoundState(actor) : 1;
  const declaredMod  = Math.min(0, Math.floor(Number(saveMod) || 0));
  const threshold    = Math.max(1, getStunThreshold(actor) + declaredMod);
  const bt           = Number(actor.system?.stats?.bt?.total) || 0;
  const penalty      = woundState > 1 ? woundState - 1 : 0;
  const taserPenalty = _getTaserPenalty(actor);
  const tokenId      = token?.id ?? getTokenId(actor);
  const sceneId      = token?.scene?.id ?? canvas?.scene?.id ?? "";

  // Conditional deduction clauses assembled in JS (the GasCloudPenaltyClause pattern);
  // threshold is already floored to ≥ 1 by getStunThreshold, so no floored note is shown.
  const woundClause = penalty > 0      ? localizeParam("StunWoundPenaltyClause", { penalty }) : "";
  const taserClause = taserPenalty > 0 ? localizeParam("StunTaserPenaltyClause", { penalty: taserPenalty }) : "";
  // The event's own penalty, named beside the other two so the card discloses the whole arithmetic it
  // was built from rather than printing a threshold the reader cannot reconstruct.
  const eventClause = declaredMod < 0  ? localizeParam("StunEventPenaltyClause", { penalty: Math.abs(declaredMod) }) : "";
  const taserCount  = actor.getFlag?.("cp2020-augmented", "taserState")?.count ?? 1;

  const content = await renderChatCard("stun-save-prompt.hbs", {
    actorName: actor.name,
    woundLabel: woundStateLabel(woundState),
    bt, woundClause, taserClause, eventClause, taserPenalty, taserCount, threshold,
    actorId: actor.id, tokenId, sceneId, saveMod: declaredMod,
  });

  await ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor, token }),
    // The per-turn flag is what supersession keys on (_supersedeUnansweredPrompt) — only the
    // updateCombat cadence stamps it, so damage-flow prompts can never be swept.
    ...(perTurn ? { flags: { "cp2020-augmented": { perTurnSave: { actorId: actor.id, kind: "stun" } } } } : {}),
  });
}

/**
 * Post death save prompt to chat.
 * @param {Actor}      actor
 * @param {Token|null} token
 * @param {number|null} forcedMortalLevel  Override the mortal level for this save (e.g. limb loss forces Mortal 0).
 */
export async function postDeathSavePrompt(actor, token = null, forcedMortalLevel = null, { perTurn = false } = {}) {
  const woundState  = actor.woundState?.() ?? 4;
  const bt          = Number(actor.system?.stats?.bt?.total) || 0;
  const mortalLevel = (forcedMortalLevel !== null)
    ? Math.min(6, Math.max(0, forcedMortalLevel))
    : Math.min(6, Math.max(0, woundState - 4));
  const threshold   = Math.max(0, bt - mortalLevel);   // floored at 0
  const tokenId     = token?.id ?? getTokenId(actor);
  const sceneId     = token?.scene?.id ?? canvas?.scene?.id ?? "";
  const isAutoDeath = threshold < 1;              // threshold 0 = no roll possible

  const content = await renderChatCard("death-save-prompt.hbs", {
    actorName: actor.name,
    woundText: localizeParam("Mortal", { mortality: mortalLevel }),
    bt, mortalLevel, threshold, isAutoDeath,
    autoDeathClause: isAutoDeath ? localize("DeathSaveAutoSuffix") : "",
    actorId: actor.id, tokenId, sceneId,
  });

  await ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor, token }),
    // See postStunSavePrompt — only the per-turn cadence stamps this, so supersession stays scoped.
    ...(perTurn ? { flags: { "cp2020-augmented": { perTurnSave: { actorId: actor.id, kind: "death" } } } } : {}),
  });
}

/**
 * Post appropriate saves based on wound state.
 * At Mortal: Death Save first (unless stabilized), then Stun Save.
 * Below Mortal: Stun Save only.
 * Uninjured: nothing.
 *
 * @param {Actor}      actor
 * @param {Token|null} token
 */
export async function postSavePrompts(actor, token = null) {
  // `actor` is a live document — an id re-fetch would swap an unlinked token's synthetic actor for
  // the shared world actor (they collide on id) and read the WRONG damage value.
  const liveActor = actor;
  const woundState = liveActor.woundState?.() ?? 0;
  if (woundState === 0) return;

  const liveToken = token
    ?? canvas?.tokens?.placeables?.find(t => t.actor === liveActor)
    ?? canvas?.tokens?.placeables?.find(t => t.actor?.id === liveActor.id)
    ?? null;

  if (woundState >= 4) {
    // Death Save before Stun Save at Mortal (p.99: both required, death is more urgent)
    const isStabilized = liveActor.getFlag?.("cp2020-augmented", "stabilized");
    if (!isStabilized) {
      await postDeathSavePrompt(liveActor, liveToken);
    }
    await postStunSavePrompt(liveActor, liveToken);
  } else {
    await postStunSavePrompt(liveActor, liveToken);
  }
}

export async function executeStunSave({ actorId, tokenId, sceneId, saveMod = 0 }) {
  // Token-first: the card's tokenId names WHICH body took the wound — an unlinked token's save
  // reads and writes its own synthetic actor, never the shared world actor its id also matches.
  const actor = resolveActorRef({ tokenId, sceneId, actorId });
  if (!actor) return;

  // Only the actor's owner or the GM may resolve this save (see _assertCanResolveSave).
  if (!_assertCanResolveSave(actor)) return;

  // Resolve at the SAME threshold the prompt was built with — the event's own penalty rides the button
  // (`data-save-mod`), exactly as the death save's mortal level does, so a save cannot be asked at one
  // number and rolled at another. A card from before the field existed sends nothing and resolves as it
  // always did. Floored at 1 by the same rule the prompt floors it with.
  const declaredMod = Math.min(0, Math.floor(Number(saveMod) || 0));
  const threshold = Math.max(1, getStunThreshold(actor) + declaredMod);
  const roll      = await new Roll("1d10").evaluate();
  const result    = roll.total;
  const success   = result <= threshold;
  const woundLabel = woundStateLabel(actor.woundState?.() ?? 1);

  const content = await renderChatCard("stun-save-result.hbs", {
    actorName: actor.name, woundLabel, result, threshold, success,
  });

  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor:  localizeParam("StunSaveFlavor", { wound: woundLabel, threshold }),
    content,
  });

  if (!success) {
    await _applyStatusEffect(actorId, tokenId, sceneId, "unconscious", true);
  } else {
    // recovery check success path restores the movement override that the failed-save
    // apply side installed: toggle 'unconscious' off, put walk speed back, drop the flag.
    await _releaseStunMovementOverride(actorId, tokenId, sceneId);
  }
}

export async function executeDeathSave({ actorId, tokenId, sceneId, mortalLevel }) {
  // Token-first (matches executeStunSave) — see resolveActorRef.
  const actor = resolveActorRef({ tokenId, sceneId, actorId });
  if (!actor) return;

  // Only the actor's owner or the GM may resolve this save (see _assertCanResolveSave).
  if (!_assertCanResolveSave(actor)) return;

  // Resolve at the SAME mortal level the prompt was built with (limb loss etc. can FORCE it). The button
  // carries it via data-mortal-level; fall back to the live wound state only when it's missing (an older card).
  const bt = Number(actor.system?.stats?.bt?.total) || 0;
  mortalLevel = Number.isFinite(mortalLevel) ? Math.min(6, Math.max(0, mortalLevel)) : Math.min(6, Math.max(0, (actor.woundState?.() ?? 4) - 4));
  const threshold = Math.max(0, bt - mortalLevel);   // floored at 0

  // Threshold 0 = auto-death (roll ≤ 0 on d10 is impossible)
  if (threshold < 1) {
    const content = await renderChatCard("death-save-result.hbs", {
      actorName: actor.name, isAutoDeath: true,
    });
    await ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor }),
    });
    await _applyStatusEffect(actorId, tokenId, sceneId, "dead", false);
    return;
  }

  const roll    = await new Roll("1d10").evaluate();
  const result  = roll.total;
  // RAW: "equal to or lower than" — roll ≤ threshold to survive
  const success = result <= threshold;

  const content = await renderChatCard("death-save-result.hbs", {
    actorName: actor.name, isAutoDeath: false,
    mortalLevel, result, threshold, success,
    showStabilize: success,
    totalDamage: Number(actor.system?.damage) || 0,
    actorId, tokenId, sceneId,
  });

  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor:  localizeParam("DeathSaveFlavor", { mortal: mortalLevel, threshold }),
    content,
  });

  if (!success) {
    await _applyStatusEffect(actorId, tokenId, sceneId, "dead", false);
  }
}

/**
 * Stabilization dialog and roll (CP2020 p.105).
 * TECH + Medical Skill + 1d10 ≥ total damage taken.
 * Bonuses: Hospital +5, Trauma Team +3, Life Suspension Tank +3.
 * Success: no more Death Saves until new damage is received.
 * Any user may attempt stabilization on any target (a medic acting on a patient) —
 * this is intentionally NOT owner-gated like stun/death saves. The roll runs locally;
 * if the medic doesn't own the patient, the stabilized flag write is relayed to the GM.
 */
export async function executeStabilize({ actorId, tokenId, sceneId }) {
  // Token-first: the patient is the TOKEN whose death-save card offered stabilization — an unlinked
  // token's damage total and stabilized flag live on its synthetic actor.
  const actor = resolveActorRef({ tokenId, sceneId, actorId });
  if (!actor) return;

  const totalDamage = Number(actor.system?.damage) || 0;
  const techVal     = Number(actor.system?.stats?.tech?.total) || 0;
  const medSkill    = actor.getSkillVal?.("MedicalTech") ?? 0;

  const dialogContent = await renderChatCard("stabilize-dialog.hbs", {
    totalDamage, techVal, medSkill,
  });

  new foundry.applications.api.DialogV2({
    window: { title: localizeParam("StabilizeDialogTitle", { name: actor.name }) },
    content: dialogContent,
    buttons: [
      {
        action: "roll",
        label: localize("RollStabilization"),
        default: true,
        callback: async (event, button, dialog) => {
          const root = dialog.element;
          const tech     = Number(root.querySelector("#cp-stab-tech")?.value)     || 0;
          const med      = Number(root.querySelector("#cp-stab-med")?.value)      || 0;
          const facility = Number(root.querySelector("#cp-stab-facility")?.value) || 0;

          const roll   = await new Roll("1d10").evaluate();
          const result = roll.total;
          const total  = tech + med + facility + result;
          const success = total >= totalDamage;

          // Arithmetic-only total string + the conditional facility clause (the
          // GasCloudPenaltyClause pattern) are assembled in JS for the template.
          const breakdown = facility > 0
            ? `${tech}+${med}+${facility}+${result} = ${total}`
            : `${tech}+${med}+${result} = ${total}`;
          const facilityClause = facility > 0 ? localizeParam("StabilizeFacilityClause", { facility }) : "";

          const content = await renderChatCard("stabilize-result.hbs", {
            actorName: actor.name, totalDamage, tech, med,
            facility: facilityClause, result, total, breakdown, success,
          });

          await roll.toMessage({
            speaker: ChatMessage.getSpeaker({ actor }),
            flavor:  localizeParam("StabilizeFlavor", { name: actor.name }),
            content,
          });

          if (success) {
            // A medic may stabilize a patient they don't own: write the flag directly
            // if we can, otherwise relay it to the GM (the roll already posted to chat).
            if (_canModifyActor(actor)) {
              await actor.setFlag("cp2020-augmented", "stabilized", true);
            } else {
              _relayStabilizedFlag({ actorId, tokenId, sceneId });
            }
          }
        },
      },
      { action: "cancel", label: localize("Cancel") },
    ],
  }).render({ force: true });
}

async function _applyStatusEffect(actorId, tokenId, sceneId, statusId, restrictMovement) {
  try {
    let tokenDoc = null;
    if (tokenId && sceneId) {
      tokenDoc = game.scenes.get(sceneId)?.tokens?.get(tokenId) ?? null;
    }
    if (!tokenDoc) {
      tokenDoc = canvas?.tokens?.placeables
        ?.find(t => t.actor?.id === actorId)?.document ?? null;
    }
    if (!tokenDoc) return;

    // v13+: TokenDocument#toggleActiveEffect was removed — toggle the status on the Actor.
    const effActor = tokenDoc.actor;
    if (effActor?.toggleStatusEffect) {
      await effActor.toggleStatusEffect(statusId, { active: true });
    }

    if (restrictMovement && statusId === "unconscious") {
      const currentSpeed = tokenDoc.actor?.system?.movement?.walk
        ?? tokenDoc.actor?.system?.ma?.total
        ?? null;
      if (currentSpeed !== null) {
        await tokenDoc.actor?.setFlag("cp2020-augmented", "preStunMovement", currentSpeed);
      }
      // Foundry v13+: direct TokenDocument movement update
      await tokenDoc.update({ "movement.walk": 0 }).catch(() => {
        // Older versions may not support this; status overlay still applies
      });
    }
  } catch (err) {
    console.warn("cp2020-augmented | Could not apply status effect:", statusId, err);
  }
}

/**
 * Recovery-check success path — the inverse of _applyStatusEffect's 'unconscious' branch.
 * When the actor still carries the 'unconscious' status this mechanism set, toggle it off,
 * restore movement.walk on the token doc from the preStunMovement flag, then unset the flag.
 * Token resolution mirrors _applyStatusEffect exactly (scene/token by id, else the first
 * placeable). The apply side touches ONE token doc and stashes ONE walk value on the actor
 * flag, so restoring that same single token doc faithfully undoes the override. No-op when the
 * actor is not unconscious (nothing for the recovery path to release).
 */
async function _releaseStunMovementOverride(actorId, tokenId, sceneId) {
  try {
    let tokenDoc = null;
    if (tokenId && sceneId) {
      tokenDoc = game.scenes.get(sceneId)?.tokens?.get(tokenId) ?? null;
    }
    if (!tokenDoc) {
      tokenDoc = canvas?.tokens?.placeables
        ?.find(t => t.actor?.id === actorId)?.document ?? null;
    }
    if (!tokenDoc) return;

    const effActor = tokenDoc.actor;
    // Only release the lock this mechanism installed — an actor that isn't unconscious has
    // nothing for the recovery path to undo.
    const isUnconscious = effActor?.statuses?.has("unconscious") ?? false;
    if (!isUnconscious) return;

    // Toggle the status off via the same API the apply side used.
    if (effActor?.toggleStatusEffect) {
      await effActor.toggleStatusEffect("unconscious", { active: false });
    }

    // Restore the stored walk speed onto the same token doc, then drop the flag.
    const stored = effActor?.getFlag?.("cp2020-augmented", "preStunMovement");
    if (stored !== undefined && stored !== null) {
      await tokenDoc.update({ "movement.walk": stored }).catch(() => {
        // Older versions may not support the movement update; the status toggle still lifts.
      });
    }
    await effActor?.unsetFlag?.("cp2020-augmented", "preStunMovement");
  } catch (err) {
    console.warn("cp2020-augmented | Could not release stun movement override:", err);
  }
}

export function registerSaveRollHandlers() {
  // GM-side listener for relayed stabilization writes (non-owner medics).
  _registerStabilizeSocket();

  onGlobalClick(async (ev) => {
    const stunBtn      = ev.target.closest(".cp-stun-save-roll");
    const deathBtn     = ev.target.closest(".cp-death-save-roll");
    const stabilizeBtn = ev.target.closest(".cp-stabilize-roll");

    if (stunBtn && !stunBtn.disabled) {
      ev.preventDefault();
      await executeStunSave({
        actorId: stunBtn.dataset.actorId,
        tokenId: stunBtn.dataset.tokenId,
        sceneId: stunBtn.dataset.sceneId,
        // The event's own penalty, carried on the card that asked (see postStunSavePrompt). Absent on
        // every prompt that declared none and on any card written before the attribute existed —
        // `Number(undefined)` is NaN, which the reader coerces to 0.
        saveMod: Number(stunBtn.dataset.saveMod),
      });
      // One-shot: the save rolled — stamp the prompt so it cannot be re-fired (card-lock.js).
      await markCardResolved(stunBtn.closest("[data-message-id]")?.dataset?.messageId, "stunSave");
    }

    if (deathBtn && !deathBtn.disabled) {
      ev.preventDefault();
      await executeDeathSave({
        actorId:     deathBtn.dataset.actorId,
        tokenId:     deathBtn.dataset.tokenId,
        sceneId:     deathBtn.dataset.sceneId,
        mortalLevel: Number(deathBtn.dataset.mortalLevel),
      });
      await markCardResolved(deathBtn.closest("[data-message-id]")?.dataset?.messageId, "deathSave");
    }

    if (stabilizeBtn && !stabilizeBtn.disabled) {
      ev.preventDefault();
      await executeStabilize({
        actorId: stabilizeBtn.dataset.actorId,
        tokenId: stabilizeBtn.dataset.tokenId,
        sceneId: stabilizeBtn.dataset.sceneId,
      });
      await markCardResolved(stabilizeBtn.closest("[data-message-id]")?.dataset?.messageId, "stabilize");
    }
  });

  // Only the PRIMARY GM SESSION processes this — an isGM-only gate posts the death/stun prompt card
  // twice when two GM clients are connected, and "two GM clients" includes one referee with the world
  // open in two tabs (each connected client fires updateCombat). Post-only; no data write.
  Hooks.on("updateCombat", async (combat, updateData) => {
    if (!isPrimaryGMSession()) return;
    // Only fire on turn/round change, not on other combat updates
    if (updateData.turn === undefined && updateData.round === undefined) return;

    // combat.combatant is the NEW active combatant after the turn/round update
    const combatant = combat.combatant;
    if (!combatant) return;

    const actor = combatant.actor;
    if (!actor) return;

    const woundState = actor.woundState?.() ?? 0;
    if (woundState === 0) return;

    const token = canvas?.tokens?.placeables?.find(t => t.id === combatant.tokenId) ?? null;

    // ⏪ BOTH PROMPTS RUN UNCONDITIONALLY (user ruling 2026-08-28, the settings retired at their
    // registration site): the per-turn cadence IS the book's — p.105 has a Mortal character save
    // each turn, p.104 has an unconscious one re-roll — and a prompt writes nothing until someone
    // answers it, so there is nothing to protect a world from. The one real cost was CHAT SPAM,
    // and that is answered structurally by supersession below, not by a switch.

    // Death Save each turn (CP2020 p.105): Mortal + unstabilized
    if (woundState >= 4) {
      const isStabilized = actor.getFlag?.("cp2020-augmented", "stabilized");
      if (!isStabilized) {
        await _supersedeUnansweredPrompt(actor.id, "death");
        await postDeathSavePrompt(actor, token, null, { perTurn: true });
      }
    }

    // Stun Save recovery (CP2020 p.104): unconscious characters re-roll each turn
    const isUnconscious = actor.statuses?.has("unconscious") ?? false;  // Set<string> in Foundry v11+
    if (isUnconscious) {
      await _supersedeUnansweredPrompt(actor.id, "stun");
      await postStunSavePrompt(actor, token, { perTurn: true });
    }
  });
}

/**
 * ⭐ ONE STANDING ASK PER BODY PER KIND — the structural answer to per-turn prompt spam (user
 * ruling 2026-08-28: mitigate it, "it probably doesn't need to be a setting at all" — so no
 * setting). Before this turn's prompt posts, last turn's UNANSWERED copy of the same question for
 * the same figure is deleted: the question has not changed, only the turn it is asked on. A card
 * that was ANSWERED is history — the resolved stamp (card-lock.js) keeps it — and prompts posted
 * by the damage flow itself carry no per-turn flag, so nothing here can touch them.
 */
async function _supersedeUnansweredPrompt(actorId, kind) {
  for (const m of [...(game.messages ?? [])]) {
    let f = null;
    try { f = m.getFlag("cp2020-augmented", "perTurnSave"); } catch { continue; }
    if (!f || f.actorId !== actorId || f.kind !== kind) continue;
    if (isCardResolved(m)) continue;
    await m.delete().catch(() => {});
  }
}
