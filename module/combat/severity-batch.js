/**
 * severity-batch.js  —  module/combat/severity-batch.js
 *
 * THE PER-APPLICATION SEVERITY CADENCE. One application — a burst, a corridor of shells, a blast and
 * the fragments it throws, a multi-row apply window — is ONE moment of the fight, and this file is the
 * memory that moment used to lack.
 *
 * WHAT WENT WRONG WITHOUT IT. `assessWoundSeverity` (DamageApplicator.js) runs once per landed round,
 * and each run posted its own cards: an over-threshold zone announced itself again for every round that
 * reached it, and each announcement dragged a forced mortal-save prompt along behind it. Measured on the
 * rig: five rounds into one zone produced eleven cards for one trigger pull. Nothing between the apply
 * loop and the severity check carried any notion of "these N rounds are one application", so there was
 * nowhere for the count to be collapsed.
 *
 * THE CADENCE THIS FILE IMPLEMENTS (user ruling 2026-08-14):
 *   - ONE consolidated progression card per body per application, showing the severity ladder the batch
 *     walked ("7 hits: Light → Serious → Mortal 2 → Mortal 6") plus one line per zone outcome.
 *   - ONE mortal-save prompt per body per application, at the FINAL tier the batch reached — not one
 *     per hit, and not at a tier the batch has already passed.
 *   - STUN prompts are NOT this file's business. They stay exactly where they are, on the per-damage-
 *     event cadence the printed rule gives them (CP2020 p.104: "every time a character takes damage").
 *
 * COMPATIBILITY IS THE DEFAULT. A batch that recorded ONE damage event replays that event's own card
 * verbatim — the same template, the same data, the same look as before this file existed — so every
 * single-hit path through the pipeline is unchanged. A caller that supplies no batch at all gets an
 * implicit one-event batch built for it, which is the same thing by another route.
 *
 * ⚠ KEYED BY TOKEN, NOT BY ACTOR. An unlinked token's synthetic actor shares the world actor's `id`
 * (see the combat data-hazards note), so an actor-keyed ledger would fold two different bodies onto one
 * entry and swallow a card and a prompt the second body is owed.
 *
 * ⛔ WHO OWNS THE WOUND-TRACK PROMPT. Only a caller that would otherwise have posted the wound-track
 * mortal prompt itself creates its batch with `ownsWoundTrackPrompt: true` — the four apply-loop owners.
 * Every other batch handles the FORCED prompt alone (the one a zone outcome demands), leaving each
 * caller's own tail exactly as it was. Without that split, a radiation tick or a burn tick — both of
 * which come through the same seam — would have grown a mortal prompt nobody asked them for.
 */

import { renderChatCard } from "../compat.js";
import { localize, localizeParam } from "../utils.js";
import { postDeathSavePrompt, woundStateLabel } from "./save-rolls.js";

const SCOPE = "cp2020-augmented";

/**
 * How far gone a zone already is, as one comparable number. The two vocabularies the limb models use
 * ("disabled"/"crippled" for a zone that still exists, "severed"/"destroyed" for one that does not)
 * collapse onto two grades, so the guard can ask "is this outcome worse than what is already recorded?"
 * without knowing which model wrote the record. Pure.
 */
const ZONE_GRADES = { crippled: 1, disabled: 1, severed: 2, destroyed: 2 };

export function zoneGrade(status) {
  return ZONE_GRADES[String(status ?? "").trim().toLowerCase()] ?? 0;
}

/** The status word for a recorded zone grade, localized. Reuses the existing FleshLimbStatus* values. */
function zoneStatusLabel(status) {
  const key = String(status ?? "").trim().toLowerCase();
  if (key === "severed")   return localize("FleshLimbStatusSevered");
  if (key === "disabled")  return localize("FleshLimbStatusDisabled");
  if (key === "crippled")  return localize("FleshLimbStatusCrippled");
  if (key === "destroyed") return localize("FleshLimbStatusDestroyed");
  return key;
}

/**
 * THE BODY KEY — token document id first, the placeable's id next, the actor's id only as a last
 * resort. Same rule and same reason as `_postWoundSavePrompts` (combat/damage-hooks.js): synthetic
 * actors collide on id, token documents do not.
 */
export function severityBodyKey(actor, token = null) {
  return token?.document?.id ?? token?.id ?? actor?.id ?? "";
}

/**
 * Open one application's severity ledger.
 * @param {boolean} p.ownsWoundTrackPrompt  True only for the four apply-loop owners — see the header.
 */
export function makeSeverityBatch({ ownsWoundTrackPrompt = false } = {}) {
  return { bodies: new Map(), closed: false, ownsWoundTrackPrompt: !!ownsWoundTrackPrompt };
}

/** Is this a severity batch (rather than the plain Set the wound-track prompt used to be handed)? */
export function isSeverityBatch(batch) {
  return !!batch && batch instanceof Object && batch.bodies instanceof Map;
}

/** Does this batch own the wound-track mortal prompt, so a caller's own tail must stand down? */
export function severityBatchOwnsMortal(batch) {
  return isSeverityBatch(batch) && batch.ownsWoundTrackPrompt === true;
}

/** Did the batch already answer the mortal question for this body (posted it, or ruled it not owed)? */
export function severityBatchHandledMortal(batch, actor, token = null) {
  if (!isSeverityBatch(batch)) return false;
  return !!batch.bodies.get(severityBodyKey(actor, token))?.mortalHandled;
}

function entryFor(batch, actor, token) {
  const key = severityBodyKey(actor, token);
  let entry = batch.bodies.get(key);
  if (!entry) {
    entry = {
      key, actor, token,
      hits: 0,              // damage events this application landed on this body
      applied: 0,           // flesh HP written across them
      steps: [],            // wound state after each event — the progression ladder
      zoneEvents: [],       // one per zone outcome, latest grade wins
      forcedMortal: false,  // a zone outcome that demands a mortal save whatever the wound track says
      forcedMortalLevel: 0,
      mortalHandled: false,
      mortalLevel: 0,
    };
    batch.bodies.set(key, entry);
  }
  if (token && !entry.token) entry.token = token;
  return entry;
}

/**
 * Record one damage event's contribution to the progression. Called from the single seam every
 * personnel apply passes through (`applyLocationDamage`), after the HP write, so the wound state read
 * here is the state the event left behind.
 */
export function recordSeverityHit(batch, { actor, token = null, netDamage = 0, woundState = null } = {}) {
  if (!isSeverityBatch(batch) || !actor) return;
  const entry = entryFor(batch, actor, token);
  entry.hits += 1;
  entry.applied += Math.max(0, Number(netDamage) || 0);
  const ws = (woundState === null) ? (actor.woundState?.() ?? 0) : (Number(woundState) || 0);
  entry.steps.push(ws);
}

/**
 * Record one zone outcome — a limb lost, a head wound past the automatic-death threshold.
 * `card` is the template + data the un-batched cadence would have posted, kept verbatim so a one-event
 * batch can replay it unchanged. `forcedMortalLevel` is the tier a zone outcome demands on its own
 * (limb loss: Mortal 0); leave it null for an outcome that demands no save.
 */
export function recordSeverityEvent(batch, {
  actor, token = null, location = "", status = "", card = null, forcedMortalLevel = null,
} = {}) {
  if (!isSeverityBatch(batch) || !actor) return;
  const entry = entryFor(batch, actor, token);
  // Latest grade per zone wins: an arm disabled by one round and severed by the next is ONE zone with
  // one final state, not two announcements. The card kept is the latest one for the same reason.
  const at = entry.zoneEvents.findIndex(e => e.location === location);
  const event = { location, status, card };
  if (at >= 0) entry.zoneEvents[at] = event;
  else entry.zoneEvents.push(event);
  if (forcedMortalLevel !== null) {
    entry.forcedMortal = true;
    entry.forcedMortalLevel = Math.max(entry.forcedMortalLevel, Math.min(6, Math.max(0, Number(forcedMortalLevel) || 0)));
  }
}

/** The progression ladder as text: one label per step, consecutive repeats collapsed. Pure. */
export function progressionLabels(steps) {
  const out = [];
  for (const ws of steps ?? []) {
    const label = woundStateLabel(Number(ws) || 0);
    if (out[out.length - 1] !== label) out.push(label);
  }
  return out;
}

/**
 * Close the ledger: for each body, ONE card and at most ONE mortal prompt.
 * Idempotent — a second close does nothing, so a caller may close defensively.
 */
export async function closeSeverityBatch(batch) {
  if (!isSeverityBatch(batch) || batch.closed) return batch;
  batch.closed = true;
  for (const entry of batch.bodies.values()) {
    try { await closeSeverityBody(batch, entry); }
    catch (err) { console.warn("cp2020-augmented | severity batch close failed:", err); }
  }
  return batch;
}

async function closeSeverityBody(batch, entry) {
  if (entry.hits === 0 && entry.zoneEvents.length === 0) return;
  const actor = entry.actor;
  const token = entry.token ?? null;

  // ── the mortal question, answered ONCE, at the tier the batch finished on ────────────────────────
  const woundState = actor.woundState?.() ?? 0;
  const trackLevel = Math.min(6, Math.max(0, woundState - 4));
  // A batch that wrote nothing raises no question: an application that bounced off armour must not
  // prompt a body that was already down before it started.
  const moved = entry.applied > 0 || entry.forcedMortal;
  const owed  = moved && (woundState >= 4 || entry.forcedMortal)
                && (batch.ownsWoundTrackPrompt || entry.forcedMortal);
  const level = Math.max(woundState >= 4 ? trackLevel : 0, entry.forcedMortal ? entry.forcedMortalLevel : 0);
  // ⭐ THE STABILIZATION READ, ALIGNED. Both sibling prompt paths make it before offering a death save
  // (save-rolls.js `postSavePrompts`, damage-hooks.js `_postWoundSavePrompts`, and the per-turn cadence);
  // the forced per-zone prompt did not, so a stabilized patient losing a limb was asked to save against
  // dying while the other two rails would not have asked. Consistency only — nothing about WHEN
  // stabilization is cleared changes here: fresh damage still clears it in `applyLocationDamage`
  // (Core p.105), so on the damage path the flag is already gone by the time this reads it.
  const stabilized = !!actor.getFlag?.(SCOPE, "stabilized");
  entry.mortalHandled = owed;
  entry.mortalLevel   = level;
  const prompting = owed && !stabilized;

  // ── the card ────────────────────────────────────────────────────────────────────────────────────
  const multi = entry.hits > 1;
  if (!multi) {
    // ONE damage event: replay exactly what the un-batched cadence posted, so nothing about a single
    // hit's presentation changes.
    for (const event of entry.zoneEvents) {
      if (!event.card) continue;
      const content = await renderChatCard(event.card.template, event.card.data);
      await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
    }
  } else if (entry.applied > 0 || entry.zoneEvents.length > 0) {
    const ladder = progressionLabels(entry.steps);
    const zoneLines = entry.zoneEvents.map(event => (event.status === "headAutoDeath")
      ? localizeParam("HeadWoundAutoDeath", { name: actor.name })
      : localizeParam("SeverityBatchZoneLine", { limb: localize(event.location), status: zoneStatusLabel(event.status) }));
    const content = await renderChatCard("severity-progression.hbs", {
      title:           localizeParam("SeverityBatchTitle", { name: actor.name }),
      hitsLine:        localizeParam("SeverityBatchHitsLine", { hits: entry.hits, total: entry.applied }),
      progressionLine: ladder.length
        ? localizeParam("SeverityBatchProgressionLine", { progression: ladder.join(" → ") })
        : "",
      zoneLines,
      deathSaveClause: prompting
        ? localizeParam("SeverityBatchDeathSaveClause", { level: localizeParam("Mortal", { mortality: level }) })
        : "",
    });
    await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
  }

  // ── the prompt, after the card that explains it ─────────────────────────────────────────────────
  if (prompting) await postDeathSavePrompt(actor, token, level);
}
