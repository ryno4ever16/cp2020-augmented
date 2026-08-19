/**
 * damage-hooks.js  —  module/combat/damage-hooks.js
 *
 * Wires the damage automation system into Foundry's hooks.
 *
 * PATH A — Targeted full-auto:
 *   item.js emits "cyberpunk2020.weaponFired" with a targetTokenId.
 *   Opens DamageDialog once the shot has finished being presented on the canvas, so the window does
 *   not cover the action it reports on. There is no unattended route: whether a given instance of
 *   damage is applied is answered at that instance, in that window (user ruling 2026-08-14).
 *   The card is deliberately NOT flagged here — one path, not both — but the shot's card IS noted as
 *   it is created, so a window closed without applying can fall back to PATH B's button on that same
 *   card rather than leaving the shot with no way to apply it at all.
 *
 * PATH B — Everything else (semi-auto, burst, untargeted full-auto):
 *   We listen for "cyberpunk2020.weaponFired" with no targetTokenId and
 *   write the payload as a flag onto the chat message that Foundry creates
 *   immediately afterward. renderChatMessageHTML then injects the Apply Damage
 *   button onto any message carrying that flag.
 *
 *   The flag-writing uses a short-lived pending payload that is consumed
 *   by the next createChatMessage hook call, which fires synchronously
 *   right after roll.execute().
 */

import { DamageDialog, DAMAGE_DIALOG_DISMISSED_HOOK }         from "./DamageDialog.js";
import { AutomationNotice }                                   from "../dialog/automation-notice.js";
import { onGlobalClick } from "../popout-compat.js";
import { onChatCardRender } from "../chat-render-compat.js";
// The one-shot card stamp is ALSO the pattern lifecycle's "has this shot been dealt with?" reader:
// a pattern whose card is still unresolved is a decision somebody has not made yet, and no expiry
// clock may take that decision away from them (see _spreadZoneCardPending).
import { markCardResolved, isCardResolved } from "../card-lock.js";
import { applyAreaDamages, ablateLocationOnce, ablateLocationByAmount, applyLocationDamage, ARMOR_MODES } from "./DamageApplicator.js";
// The per-application severity cadence — one progression card and one mortal prompt per body per
// application, whatever the application is made of (a burst's rounds, a corridor's shells, a blast and
// the fragments it throws). See combat/severity-batch.js for who owns the wound-track prompt.
import { makeSeverityBatch, closeSeverityBatch, severityBatchOwnsMortal, severityBatchHandledMortal, isSeverityBatch } from "./severity-batch.js";
import { routesToSdp, contributingItems } from "../mech/cyberlimb.js";
import { isFullBorg } from "../mech/borg.js";
import { postStunSavePrompt, postDeathSavePrompt, updateTaserState, applyAcidDotState, applyDotFromPayload, postSavePromptCard, mirrorDotStatus } from "./save-rolls.js";
import { gasSaveDecisionFor, percentGateOutcome } from "../mech/protection.js";
// combatFxEnabled is read (with the presentation rail's patternFlowOwns) at the pattern's apply, so one
// round is not sounded twice — once on arrival by the rail and again when the corridor is confirmed.
import { mechRoundTickEnabled, combatFxEnabled } from "../settings.js";
import { rollLocation, rerollGoneLimbAreaDamages, resolveActorRef, localize, localizeParam, tryLocalize } from "../utils.js";
import { renderChatCard, getHtmlElement }                     from "../compat.js";
import { dispatchAttack }                                     from "../vehicle/vehicle-targeting.js";
import { createArea, tokensInArea, areasByFlag, deleteArea, areaById, areaDeleteHook, usesRegions, moveArea, areaOcclusionTest } from "./area-shapes.js";
import { GAS_CLOUD_BEHAVIOR } from "./gas-cloud-behavior.js";
import { SUPPRESSIVE_ZONE_BEHAVIOR, SUPPRESSIVE_ZONE_ENTERED_HOOK } from "./suppressive-zone-behavior.js";
import { rayPolygonShape } from "./area-geometry.js";
import { SCATTER_ROSE, scatterDriftM, scatterLandedPoint } from "./scatter-table.js";
import { spreadFlowModeOf, spreadBandSpec, spreadBandDamage, SPREAD_MODE_SINGLE } from "../lookups.js";
import { SPREAD_ZONE_LOOK } from "./spread-zone-look.js";
// The two floors a corridor may not go under, taken from the gesture that declares one rather than
// re-typed here: the aim preview and the plant have always had to agree about them, and the note at
// their definition says so. Nothing else in the aim module is touched (it is a client-side preview),
// and it reaches for no canvas at import time.
import { SPREAD_MIN_LENGTH_M, SPREAD_MIN_WIDTH_M } from "./spread-placement.js";
// ⚠ IMPORTED for this file's OWN plant calls AND re-exported below (the scatter-table idiom at the
// rose/drift re-export): a `export {...} from` alone wires importers but binds NOTHING here — the
// certification lane caught _placeSpreadZone throwing ReferenceError on exactly that.
import { declaredSpreadAim, spreadAttackOutcome, scatteredSpreadCorridor } from "./spread-geometry.js";
import { pixelsToMeters, metersToPixels } from "../vehicle/vehicle-grid.js";
// One source of truth for when a shot has FINISHED being looked at: the fx adapter queues the cadence,
// the round count and every clip length, so it reports its own completion rather than having the sum
// duplicated here — a copy that would drift the moment any of them is tuned.
import { presentationSettled, ammoFxKeyOf, ammoLeavesGroundFire, fxPatternGroundFire, fxSeedOf, patternFlowOwns } from "../fx/effects.js";

/**
 * The effect list, however a caller spelled it.
 *
 * `?? []` was not enough, and the gap had two halves. A value that is PRESENT but not an array — an
 * object from a re-typing producer, a number, a boolean — sails past the nullish default and then
 * throws on `.includes`, out of an async listener, i.e. as an unhandled rejection Foundry never
 * reports. A BARE STRING is worse because it does NOT throw: it has `.includes`, so it is read with
 * SUBSTRING semantics, and "Non-Explosive".includes("Explosive") is true — a shot the module should
 * route to the single-target path gets routed into the explosion path on a text match.
 *
 * Coercing rather than merely strict, because it mirrors the normalization item-sheet.js already
 * applies to the stored field, and it keeps a bare-string caller working as they plainly intended.
 * For every payload this module's own producers emit the field is already an array, so this computes
 * exactly what the raw reads computed.
 */
const _effectTypesOf = (payload) => {
  const t = payload?.effectTypes;
  return Array.isArray(t) ? t : (typeof t === "string" && t ? [t] : []);
};

// Payload waiting to be attached to the next chat message created, and WHEN it started waiting.
//
// The pairing is the point. The payload is queued from inside the render of the very card it belongs
// to (the fire's own multi-hit card — see seam-shim.js), so that card's creation follows within one
// server round trip. A queue entry still waiting long after that is one whose card never arrived —
// a fire that posted no card, or a card the speaker check ruled out — and handing it to whatever
// this user says next is how an ORDINARY CHAT LINE ended up carrying an apply button (reproduced on
// the rig: an unconsumed queue entry, then a plain message, and the plain message came back flagged).
// So the wait is bounded rather than open-ended.
//
// NOT cleared by the next shot instead, deliberately: two fires can legitimately overlap, and the
// earlier one's card may still be on its way, so a newer shot is no evidence that an older payload
// is stale. Elapsed time is.
let _pendingPayload = null;
let _pendingPayloadAt = 0;

/**
 * How long a queued payload stays claimable, in milliseconds.
 *
 * It is waiting for ONE thing — the creation of the card whose render queued it — which is a single
 * round trip to the server. Five seconds is many times the worst that has been seen and still far
 * shorter than the gap between two separate table actions, so a card that has not arrived inside it
 * is not coming.
 */
export const PENDING_PAYLOAD_TTL_MS = 5000;

/** Queue a payload for the card of the shot that produced it, stamped with its start of waiting. */
function _queuePendingPayload(payload) {
  _pendingPayload = payload;
  _pendingPayloadAt = Date.now();
}

// WHICH CARD A PATH-A SHOT POSTED — remembered, not flagged.
//
// PATH A opens a window INSTEAD of putting the button on the card ("one path, not both"), so it never
// had any reason to learn the card's id — and that is exactly what went missing when the window is
// dismissed without applying: the shot had a card, but nothing knew which one, so the affordance was
// simply thrown away. The card is identified by the SAME matcher PATH B uses to claim one; the only
// difference is what is done with the match — recorded here, flagged there.
//
// TWO STRUCTURES, TWO LIFETIMES, and the split is the whole design:
//  - _awaitingCard is the MATCHING window, and it is bounded by the same TTL as the PATH-B queue for the
//    same reason: it waits for ONE thing — the card whose render emitted this shot — which arrives within
//    a round trip. Past that the card is not coming and no later message is it.
//  - _cardIdByPayload is the MEMORY, and it must outlive that window by however long the reader leaves
//    the window open, which can be minutes. It is keyed on the payload OBJECT, which the open dialog
//    already holds for its own lifetime — so the entry exists for exactly as long as something can still
//    ask for it, and is collected with the payload when nothing can. No timer, nothing to expire, and no
//    id kept for a window that has already gone.
const _cardIdByPayload = new WeakMap();
let _awaitingCard = null;
let _awaitingCardAt = 0;

/** Start watching for the card of a PATH-A shot, stamped with its start of waiting. */
function _rememberCardFor(payload) {
  _awaitingCard = payload;
  _awaitingCardAt = Date.now();
}

/**
 * Is this newly created message the card of the shot `payload` came from? The two questions that answer
 * it were previously inline in the PATH-B claim; they are the matcher for both users now.
 *
 * createChatMessage fires on this client for EVERY message, including ones authored by other users
 * (broadcast). The payload belongs to THIS user's shot, so an interleaved message from someone else is
 * never it. And when the message names a speaker actor and the attacker is known, they must agree, so a
 * same-user message about a different actor cannot claim this shot. Either signal missing = not
 * disqualifying (fall through rather than block the whole flow).
 */
function _isShotCard(message, payload) {
  const authorId = message.author?.id ?? message.user?.id ?? null;
  if (authorId && authorId !== game.user.id) return false;
  const attackerId     = payload.attackerId ?? payload.actorId ?? null;
  const speakerActorId = message.speaker?.actor ?? null;
  if (attackerId && speakerActorId && speakerActorId !== attackerId) return false;
  return true;
}

function _isMultiActionEnabled() {
  try { return game.settings.get("cp2020-augmented", "multiActionPenaltyEnabled"); } catch { return false; }
}
function _isMultiActionAutoTrack() {
  try { return game.settings.get("cp2020-augmented", "multiActionAutoTrack"); } catch { return false; }
}
/** True when there is a started combat that this actor is a combatant in. The multi-action counter is
 *  combat-scoped: only a running combat has the round boundary that resets it (see the round-reset and
 *  combatStart hooks in _hookMultiActionPenalty), so OUT of combat the counter must neither accumulate
 *  nor penalize — otherwise it climbs forever with nothing to clear it. The membership set is exactly the
 *  one the reset hook clears (combat.combatants), so a non-combatant that fired could never be reset
 *  either — hence it is excluded here too. Reuses the same game.combat.started notion the movement gate
 *  keys off. */
function _inActiveCombat(actor) {
  const combat = game?.combat;
  if (!combat?.started || !actor) return false;
  return combat.combatants.some(c => c.actor?.id === actor.id);
}
function _getActionCount(actor) {
  if (!_inActiveCombat(actor)) return 0;   // out of combat / not a combatant → no count, no penalty
  const round = game?.combat?.round ?? 0;
  const count = Number(actor.getFlag?.("cp2020-augmented", "actionCount") ?? 0);
  const countRound = actor.getFlag?.("cp2020-augmented", "actionCountRound") ?? -1;
  if (round > 0 && countRound !== round) return 0;
  return count;
}
// Per-actor serialization for the action counter: two quick actions must not both read the same count
// and each write count+1 (one increment lost). Each increment chains after the prior write for that
// actor, so the read sees the committed value; the pair (count + its round stamp) goes in ONE update
// instead of two sequential setFlags. Callers may still fire-and-forget — the returned promise carries
// the chain, so a trailing .catch() is enough.
const _actionCountChains = new WeakMap();
function _incrementActionCount(actor) {
  // Single choke point for every increment path (weapon fire, aim/dodge/parry, manual +action): the
  // counter only advances inside a combat this actor is part of. Out of combat it is a no-op so the
  // penalty never accrues with no round boundary to reset it.
  if (!_inActiveCombat(actor)) return Promise.resolve();
  const next = (_actionCountChains.get(actor) ?? Promise.resolve()).catch(() => {}).then(() => {
    const round   = game?.combat?.round ?? 0;
    const current = _getActionCount(actor);
    return actor.update({
      "flags.cp2020-augmented.actionCount":      current + 1,
      "flags.cp2020-augmented.actionCountRound": round,
    });
  });
  _actionCountChains.set(actor, next);
  return next;
}
/** True for an ACPA / powered-armor actor — the Maximum Metal multi-action rules apply to these. */
export function _isAcpa(actor) {
  return actor?.system?.isACPA === true;
}
/** Max actions a PA pilot may take in a round (MM p.54): ½ the suit's modified REF, floored, min 1.
 *  ACPA actors expose their modified reflex as system.effectiveRef. Advisory only (we don't hard-block). */
export function _acpaMaxActions(actor) {
  return Math.max(1, Math.floor((Number(actor?.system?.effectiveRef) || 0) / 2));
}
/**
 * The multi-action penalty on the Nth declared action this round. CP2020 p.105: a flat −3 per additional
 * action (−3, −6, −9…). ACPA / PA (MM p.54): the pilot's brain + the suit's control system soften it —
 * the 2nd action is −3, and each action AFTER the second adds only −1 more (−3, −4, −5, −6…), i.e.
 * −(count+1). Pure of the feature toggle (callers gate). Exported for the keeper. */
export function _multiActionPenaltyFor(actor, count) {
  if (count <= 1) return 0;
  if (_isAcpa(actor)) return -(count + 1);
  return -(count - 1) * 3;
}
function _getMultiActionPenalty(actor) {
  if (!_isMultiActionEnabled()) return 0;
  // The attack dialog pre-fills the penalty for the action being DECLARED — i.e. count+1. The shared
  // action counter is incremented AFTER the roll (on the weaponFired hook), so at dialog-render it still
  // holds only the PRIOR actions' count; without the +1 the 2nd action would show −0 instead of −3 (and
  // every later action one step too lenient). The combat-tracker BADGE, by contrast, shows the count of
  // actions already taken and uses _multiActionPenaltyFor(count) directly — that is correct as-is.
  return _multiActionPenaltyFor(actor, _getActionCount(actor) + 1);
}

// ---------------------------------------------------------------------------

export function registerDamageHooks() {
  _hookWeaponFired();
  _hookCreateChatMessage();
  _hookRenderChatMessage();
  _hookClearedPatternCard();
  _hookDamageDialogDismissed();
  _hookSuppressiveFire();
  _hookSuppressiveZoneEntered();
  _hookSuppressiveExpiry();
  _hookAimTracking();
  _hookWaitForTurn();
  _hookDodgeParry();
  _hookDotEffects();
  _hookGasCloud();
  _hookGasCloudPerTurn();
  _hookManualRoundTick();
  _hookExplosion();
  _hookSpread();
  _hookSpreadZoneExpiry();
  _hookMultiActionPenalty();
  _hookAutomationMigrationNotice();
  _hookSocketRelay();
  _hookLiveSheetUpdate();

  // Combat action button click handler
  onGlobalClick(async (ev) => {
    const evasionBtn    = ev.target.closest(".cp-suppression-evasion-roll");
    const unlockBtn     = ev.target.closest(".cp-suppressive-unlock");
    const blastBtn      = ev.target.closest(".cp-confirm-explosion");
    const spreadBtn     = ev.target.closest(".cp-confirm-spread-zone");
    const clearSpreadBtn = ev.target.closest(".cp-clear-spread-zone");
    const takeAimBtn    = ev.target.closest(".cp-take-aim-btn");
    const waitBtn       = ev.target.closest(".cp-wait-for-turn-btn");
    const actNowBtn     = ev.target.closest(".cp-wait-act-btn");
    const dodgeBtn      = ev.target.closest(".cp-dodge-btn");
    const parryBtn      = ev.target.closest(".cp-parry-btn");
    const addActionBtn  = ev.target.closest(".cp-add-action-btn");
    const manualTickBtn = ev.target.closest(".cp-manual-tick-btn");

    const scatterBtn = ev.target.closest(".cp-confirm-explosion-scatter");
    if (scatterBtn && !scatterBtn.disabled) {
      ev.preventDefault();
      scatterBtn.disabled = true;
      await _scatterExplosion(scatterBtn.dataset.templateId);
      // One-shot: scatter + confirm are two buttons on ONE explosion card — either resolves it (card-lock.js).
      await markCardResolved(scatterBtn.closest("[data-message-id]")?.dataset?.messageId, "explosionScatter");
    }

    if (blastBtn && !blastBtn.disabled) {
      ev.preventDefault();
      blastBtn.disabled = true;
      await _confirmExplosion(blastBtn.dataset.templateId);
      await markCardResolved(blastBtn.closest("[data-message-id]")?.dataset?.messageId, "explosionConfirm");
    }

    if (spreadBtn && !spreadBtn.disabled) {
      ev.preventDefault();
      spreadBtn.disabled = true;
      await _confirmSpreadZone(spreadBtn.dataset.templateId);
      await markCardResolved(spreadBtn.closest("[data-message-id]")?.dataset?.messageId, "spreadConfirm");
    }

    // Clear = the apply's opposite exit, on the same card: void the shot, remove the pattern, and say
    // so where the button was. The message id travels with the call because the pattern is deleted by
    // it — after that there is nothing left to read a recorded card id off.
    if (clearSpreadBtn && !clearSpreadBtn.disabled) {
      ev.preventDefault();
      clearSpreadBtn.disabled = true;
      await _clearSpreadZone(
        clearSpreadBtn.dataset.templateId,
        clearSpreadBtn.closest("[data-message-id]")?.dataset?.messageId ?? "",
      );
    }

    if (evasionBtn && !evasionBtn.disabled) {
      ev.preventDefault();
      evasionBtn.disabled = true;
      await _executeSuppressionEvasion({
        actorId:    evasionBtn.dataset.actorId,
        tokenId:    evasionBtn.dataset.tokenId,
        sceneId:    evasionBtn.dataset.sceneId,
        saveDC:     Number(evasionBtn.dataset.saveDc),
        dmgFormula: evasionBtn.dataset.dmgFormula,
        attackerId: evasionBtn.dataset.attackerId,
      });
      // One-shot per defender: this token evades once (card-lock.js).
      await markCardResolved(evasionBtn.closest("[data-message-id]")?.dataset?.messageId, "suppressionEvasion");
    }

    // Unlock a placed suppressive lane (GM only) — re-opens the shooter's aim/size preview to re-place it.
    if (unlockBtn && !unlockBtn.disabled) {
      ev.preventDefault();
      unlockBtn.disabled = true;
      await _unlockSuppressiveZone(unlockBtn.dataset.regionId, unlockBtn.dataset.sceneId);
    }

    if (takeAimBtn) {
      ev.preventDefault();
      const actor = game.actors.get(takeAimBtn.dataset.actorId);
      if (!actor) return;
      const current = actor.getFlag("cp2020-augmented", "aimRounds") ?? 0;
      const next = current >= 3 ? 0 : current + 1;
      if (next === 0) {
        await actor.unsetFlag("cp2020-augmented", "aimRounds");
      } else {
        await actor.setFlag("cp2020-augmented", "aimRounds", next);
        if (_isMultiActionEnabled() && _isMultiActionAutoTrack()) await _incrementActionCount(actor);
      }
      ui.combat?.render();
    }

    if (waitBtn) {
      ev.preventDefault();
      const combat = game.combat;
      if (!combat) return;
      const combatant = combat.combatants.get(waitBtn.dataset.combatantId);
      if (!combatant) return;

      const remaining = combat.turns.slice((combat.turn ?? 0) + 1)
        .filter(c => c.id !== combatant.id && !c.getFlag?.("cp2020-augmented", "waitingForTurn") && c.actor);

      // Guard: if already last in order, there is no one to follow — don't advance the round
      if (remaining.length === 0) {
        ui.notifications.info(localizeParam("WaitNoOneAfter", { name: combatant.name }));
        return;
      }

      const content = await renderChatCard("wait-target-dialog.hbs", {
        options: remaining.map(c => ({ value: c.id, label: c.name })),
      });
      const targetId = await new Promise(resolve => {
        new foundry.applications.api.DialogV2({
          window: { title: localize("WaitForTurnTitle") },
          content,
          buttons: [
            { action: "confirm", label: localize("Wait"),   default: true,  callback: (ev, btn, dlg) => resolve(dlg.element.querySelector("#cp-wait-target")?.value ?? null) },
            { action: "cancel",  label: localize("Cancel"),                  callback: () => resolve(null) },
          ],
          rejectClose: false,
          close: () => resolve(null),
        }).render({ force: true });
      });
      if (!targetId) return; // cancelled
      const targetName = remaining.find(c => c.id === targetId)?.name ?? localize("ChosenCombatant");

      await combatant.setFlag("cp2020-augmented", "waitingForTurn", true);
      await combatant.setFlag("cp2020-augmented", "waitingAfterId", targetId);
      await combat.nextTurn();

      await postSavePromptCard({
        title: localizeParam("WaitingTitle", { name: combatant.name }),
        body: localizeParam("WaitingBody", { target: targetName }),
        speaker: ChatMessage.getSpeaker({ actor: combatant.actor ?? undefined }),
      });
    }

    if (dodgeBtn) {
      ev.preventDefault();
      const actor = game.actors.get(dodgeBtn.dataset.actorId);
      if (!actor) return;
      const alreadyDodging = actor.getFlag("cp2020-augmented", "dodging") ?? false;
      if (alreadyDodging) {
        await actor.unsetFlag("cp2020-augmented", "dodging");
        ui.notifications.info(localizeParam("DodgeCancelled", { name: actor.name }));
      } else {
        await actor.setFlag("cp2020-augmented", "dodging", true);
        if (_isMultiActionEnabled() && _isMultiActionAutoTrack()) await _incrementActionCount(actor);
        await postSavePromptCard({
          title: localizeParam("DodgeDeclareTitle", { name: actor.name }),
          body: localizeParam("DodgeDeclareBody", { name: actor.name }),
          speaker: ChatMessage.getSpeaker({ actor }),
        });
      }
      ui.combat?.render();
    }

    if (parryBtn) {
      ev.preventDefault();
      const actor = game.actors.get(parryBtn.dataset.actorId);
      if (!actor) return;
      const alreadyParrying = actor.getFlag("cp2020-augmented", "parrying") ?? false;
      if (alreadyParrying) {
        await actor.unsetFlag("cp2020-augmented", "parrying");
        ui.notifications.info(localizeParam("ParryCancelled", { name: actor.name }));
      } else {
        await actor.setFlag("cp2020-augmented", "parrying", true);
        if (_isMultiActionEnabled() && _isMultiActionAutoTrack()) await _incrementActionCount(actor);
        await postSavePromptCard({
          title: localizeParam("ParryDeclareTitle", { name: actor.name }),
          body: localize("ParryDeclareBody"),
          speaker: ChatMessage.getSpeaker({ actor }),
        });
      }
      ui.combat?.render();
    }

    if (actNowBtn) {
      ev.preventDefault();
      const combat = game.combat;
      if (!combat) return;
      const combatant = combat.combatants.get(actNowBtn.dataset.combatantId);
      if (!combatant) return;
      await combatant.unsetFlag("cp2020-augmented", "waitingForTurn");
      await combatant.unsetFlag("cp2020-augmented", "waitingAfterId").catch(() => {});
      await postSavePromptCard({
        title: localizeParam("ActNowTitle", { name: combatant.name }),
        body: localize("ActNowBody"),
        speaker: ChatMessage.getSpeaker({ actor: combatant.actor ?? undefined }),
      });
      ui.combat?.render();
    }

    if (addActionBtn) {
      ev.preventDefault();
      if (!_isMultiActionEnabled()) return;
      const actor = game.actors.get(addActionBtn.dataset.actorId);
      if (!actor) return;
      await _incrementActionCount(actor);
      const count   = _getActionCount(actor);
      const penalty = _multiActionPenaltyFor(actor, count);
      let msg = localizeParam("ActionRecorded", { name: actor.name, count }) + (penalty < 0 ? localizeParam("ActionPenaltyClause", { penalty }) : "");
      if (_isAcpa(actor) && count > _acpaMaxActions(actor)) msg += localizeParam("ActionAcpaOverCapClause", { max: _acpaMaxActions(actor) });
      ui.notifications.info(msg);
      ui.combat?.render();
    }

    if (manualTickBtn && !manualTickBtn.disabled) {
      ev.preventDefault();
      manualTickBtn.disabled = true;   // claim synchronously so a double-click can't run two passes
      try { await _runManualRoundTick(game.combat); }
      finally { ui.combat?.render(); } // the re-render re-injects a fresh (enabled) control
    }
  });
}

/** Mono-edge weapons break on a fumble (a natural 1 on the attack roll, CP2020 p.112). Called from the
 *  weaponFired handler on the shot's authoritative client so the weapon write + chat note happen exactly
 *  once. No-op unless the fired weapon is `mono` and the roll fumbled; idempotent (skips an already-broken
 *  weapon), so a re-emitted payload never double-posts. */
async function _maybeBreakMonoWeapon(payload, attackerActor) {
  if (!payload?.mono || !payload?.fumble) return;
  const weapon = payload.weaponId ? attackerActor?.items?.get(payload.weaponId) : null;
  if (!weapon || weapon.system?.broken) return;
  try {
    await weapon.update({ "system.broken": true });
    await ChatMessage.create({
      content: localizeParam("MonoWeaponBroke", { weapon: weapon.name }),
      speaker: ChatMessage.getSpeaker(attackerActor ? { actor: attackerActor } : {}),
    });
  } catch (err) {
    console.warn("CP2020 | mono break-on-fumble failed:", err);
  }
}

function _hookWeaponFired() {
  Hooks.on("cyberpunk2020.weaponFired", async (payload) => {
    // Defense-in-depth: if a co-resident automation layer already claimed this shot (e.g. the base
    // system, were it to absorb combat automation), stand down so damage isn't applied twice. The
    // claim is set below, once THIS layer commits to handling the shot — self-coordinating: whichever
    // layer runs first and commits wins; the others see the claim and return. See the cherry-pick
    // hardening follow-up. (Primary defense is per-feature stand-down in cp2020-augmented.js.)
    if (payload.handled) return;
    // Area-effect ammo is owned by the dedicated explosion/spread hooks. Skip the single-target
    // apply path here so the primary target isn't damaged twice. The per-token blast/pattern
    // re-emits plain weaponFired payloads (no effectTypes/spreadMode), which fall through normally.
    if (_effectTypesOf(payload).includes("Explosive")) return;
    // ⚠ THE SAME DERIVATION THE PATTERN HOOK USES, and it must stay the same call: this line and
    // _hookSpread are the two halves of one either/or. If they ever disagreed, a shell would either be
    // damaged twice (dialog AND pattern) or not at all. Reading the stored spreadMode flag here while
    // the pattern hook derived from the caliber is exactly that disagreement, which is why the flag is
    // no longer read in either place.
    if (_spreadModeOf(payload) !== SPREAD_MODE_SINGLE) return;

    // item.js uses "attackerId"; support legacy "actorId" for any third-party callers.
    const attackerActorId = payload.attackerId ?? payload.actorId ?? null;
    const attackerActor = attackerActorId ? game.actors.get(attackerActorId) : null;
    // Player handles their own actor's shots; the GM handles everything else (NPCs, and PCs
    // whose owning player is currently offline). NOTE: actor.hasPlayerOwner is permission-based
    // and stays true even when the player is disconnected — so we must check for a *connected*
    // owner here, otherwise the GM never takes over an offline player's shots and the Apply
    // Damage button appears for nobody.
    const ownerOnline = !!attackerActor && game.users.players.some(
      u => u.active && attackerActor.testUserPermission(u, "OWNER")
    );
    const isMyShot  = !game.user.isGM && (attackerActor?.isOwner ?? false);
    // Only the PRIMARY (active) GM handles a shot NOBODY here fired — an NPC or offline-owner payload
    // that arrived by some route other than this client pulling the trigger. Without that rule, every
    // GM client receiving such a payload would open its own DamageDialog (and, with auto-apply on,
    // each would apply the damage → N× HP loss); it is also what guarantees exactly one client reaches
    // dispatchAttack, which the vehicle-damage relay below relies on.
    const gmHandles = game.user.isGM && !ownerOnline && game.users.activeGM?.id === game.user.id;

    // ⚠ THE SEAT IS THE WRONG QUESTION FOR A SHOT THIS CLIENT ITSELF FIRED, and that was a reported
    // regression: at a table with TWO GM sessions, every fire mode stopped opening the apply window
    // for the GM who fired. The comment this replaces claimed "weaponFired fires on every connected GM
    // client" — it does not. The single-target emission is a LOCAL `Hooks.callAll` from the seam
    // (seam-shim.js), raised only on the client that resolved the shot, so a GM who is not the active
    // GM was the ONLY client to receive their own shot AND the only one told to stand down. Nobody
    // opened anything; the reader saw the plain fire card and nothing else.
    //
    // So the client that pulled the trigger presents its own shot, whatever seat it holds. That cannot
    // reintroduce the N-dialog hazard the seat rule defends against: `firedByUserId` names ONE user, so
    // at most one client can match it however the payload travels — a strictly tighter guarantee than
    // the seat gave. Payloads WITHOUT the stamp (the suppressive re-emission below, anything relayed,
    // a future native emitter) are untouched and keep the seat rule exactly.
    const firedHere = payload.firedByUserId != null && payload.firedByUserId === game.user.id;
    if (!firedHere && !isMyShot && !gmHandles) return;

    // This client + layer is committing to apply this shot — claim it (synchronously, before any
    // await) so a co-resident layer's later weaponFired listener stands down (see the top guard).
    //
    // ⚠ THE STAMP MUST PRECEDE THE MONO-BREAK AWAIT, and it did not: awaiting first suspended the
    // listener, so the write landed a microtask AFTER `Hooks.callAll` returned and any layer reading
    // `payload.handled` synchronously saw an unclaimed shot — the exact opposite of what the comment
    // promised. The mono break neither returns a value this branch consumes nor touches `areaDamages`
    // (it reads mono/fumble/weaponId and writes the weapon + a chat note), so the commit decision can
    // be made before it runs. The areaDamages verdict is taken here and acted on after, which keeps
    // the break running even for a damage-less fumble card.
    const hasAreaDamages = !!payload.areaDamages && Object.keys(payload.areaDamages).length > 0;
    if (hasAreaDamages) payload.handled = "cp2020-augmented";

    // Mono-edge break-on-fumble (CP2020 p.112): this is the shot's single authoritative client, so mark
    // the weapon broken + post the note here (exactly once). Runs BEFORE the areaDamages guard so a
    // damage-less fumble card still breaks the blade; a no-op unless the weapon is mono and it fumbled.
    await _maybeBreakMonoWeapon(payload, attackerActor);

    if (!hasAreaDamages) return;

    // PATH A: we know what this shot was aimed at — auto-apply, or open the (deferred) dialog.
    //
    // ⚠ THE AIM FIELD IS NOW A ROUTING FIELD TOO, and that is a reversal of an earlier decision worth
    // stating. The base system only attaches `targetTokenId` on FULL AUTO, so every single and
    // semi-automatic shot arrived here looking untargeted and fell to PATH B — the reader got a chat
    // button where a burst got a window, for the same trigger pull at the same target. The seam's own
    // `fxTargetTokenId` is captured on EVERY fire mode, so it answers "what was this aimed at" for the
    // modes the base field does not cover. It was deliberately kept OUT of this branch before, because
    // routing on it opened a window instantly, mid-action — that objection is answered: the dialog now
    // waits out the shot's presentation. PATH B is left for shots genuinely aimed at nothing.
    if (payload.targetTokenId || payload.targetActorId || payload.fxTargetTokenId) {
      const target = _resolveTarget(payload);
      if (!target) {
        console.warn("CP2020 | weaponFired: could not resolve target", payload);
        // Still queue for PATH B so GM can use the chat button
        _queuePendingPayload(payload);
        return;
      }

      // Remember which card this shot posts, so a window dismissed without applying can put the apply
      // button back on it (_hookDamageDialogDismissed). Registered HERE, in the same tick as the shot,
      // rather than where the window opens: the card is created within a round trip of this emission,
      // while the dialog branch below is several awaits away — it waits out the whole presentation
      // first — so by then the card would already have gone past unrecorded. The branches that open no
      // window (auto-apply, the vehicle resolver) register too, deliberately: it costs one map entry
      // nobody reads, collected with the payload, and keeps the registration on the one line where the
      // shot is known to have a target.
      _rememberCardFor(payload);

      // Re-roll any hit that landed on a limb that isn't there to be hit (a severed/destroyed flesh limb
      // or a destroyed cyberlimb wreck). Single-shot/burst/melee location is rolled in the BASE system's
      // item.js, which has no concept of a gone limb (that state lives in THIS module's M18/M19 flags), so
      // the module re-checks it here — the one point where both the resolved target and the rolled
      // locations are in hand, before the dialog or auto-apply reads them. No-ops off-toggle / non-actor /
      // when nothing hit a gone limb. (Module-rolled paths — suppressive/area/vehicle — re-roll at the
      // rollLocation source instead.)
      payload.areaDamages = await rerollGoneLimbAreaDamages(target, payload.areaDamages);

      // Unified dispatcher (4-way: source scale × target type). Vehicle targets → vehicle resolver
      // (SP→SDP / Penetration vs Armor Value); a Penetration weapon vs a person → MM p.8. Returns
      // true when handled; a normal personnel-vs-person hit falls through to the dialog below.
      if (await dispatchAttack(payload, target)) return;

      // ⭐ EVERY RESOLUTION OPENS THE WINDOW (user ruling, 2026-08-14): "auto apply should be removed as
      // a feature and the option of whether to apply it can be handled at each instance of damage
      // instead of a module-wide rule that can be mysteriously turned on or off". A world setting used
      // to branch here and skip the window for the whole table; it is gone, and so is the route it
      // selected. The per-instance decision IS this window — one per application, since the batch
      // cadence made a burst one application rather than N.
      //
      // Let the shot finish before putting the window over the canvas. It used to open the instant the
      // shot resolved, which is while the rail is still fanning the rounds out — so the window covered
      // the action it was reporting on, centre-screen, for the whole burst. It opens now when the
      // action is OVER: the last round's impact/tracer ending, which is where the user drew that line
      // (burst smoke and ember motes are dressing and are deliberately not waited on). PATH B does not
      // wait, because its window is opened by the reader, when the reader chooses.
      // The claim above is already set synchronously, so a second layer still stands down at once,
      // and two payloads in flight each settle on their own signal without any queue between them.
      // WAIT FOR THE RAIL TO SAY IT IS DONE, rather than for a sum reproduced here. The rail queues
      // every duration, so it is the only honest source for "the action has finished"; the arithmetic
      // this used to sleep on had to be re-derived whenever a cadence, a hold or a clip was tuned and
      // drifted silently when it was not — the travelled class was the visible case, where the sum
      // read 150ms against a real 983ms and the window landed on top of the pellets still in flight.
      // presentationSettled owns all three routes (the signal, the arithmetic when no fan-out ran,
      // and the hard cap that stops anything parking the window), so this reads as one await.
      await presentationSettled(payload);
      new DamageDialog(payload, target).render(true);
      return;
    }

    // PATH B: no target — queue payload for the next createChatMessage hook
    _queuePendingPayload(payload);
  });
}

function _hookCreateChatMessage() {
  Hooks.on("createChatMessage", async (message) => {
    // The card either entry is waiting for is created within a round trip of the shot behind it. Past
    // that, the card is not coming, and this message — whatever it is — is not the one. Drop the entry
    // rather than just skipping it, so it cannot claim a later message either.
    if (_pendingPayload && Date.now() - _pendingPayloadAt > PENDING_PAYLOAD_TTL_MS) _pendingPayload = null;
    if (_awaitingCard   && Date.now() - _awaitingCardAt   > PENDING_PAYLOAD_TTL_MS) _awaitingCard   = null;

    // A PATH-A shot's own card is RECORDED and nothing else — its window is already open (or is waiting
    // out the presentation before it opens), and flagging here would give one shot both affordances at
    // once. The id is what the dismissal path needs later.
    //
    // Read ahead of the PATH-B claim deliberately: when both are live, this message was created by the
    // shot that is still on screen, not by the older queued one, so handing it to the queue would be the
    // mis-attribution the TTL exists to prevent. The queued entry stays claimable for its own card.
    if (_awaitingCard && _isShotCard(message, _awaitingCard)) {
      _cardIdByPayload.set(_awaitingCard, message.id);
      _awaitingCard = null;
      return;   // one card belongs to one shot
    }

    if (!_pendingPayload || !_isShotCard(message, _pendingPayload)) return;

    const payload = _pendingPayload;
    _pendingPayload = null;

    try {
      await message.setFlag("cp2020-augmented", "damagePayload", payload);
    } catch (err) {
      console.warn("CP2020 | Could not set damagePayload flag on chat message", err);
    }
  });
}

/**
 * A dismissed apply window hands its shot back to the shot's own chat card.
 *
 * The window is PATH A's whole affordance: it takes the routing so the card does not get a button ("one
 * path, not both"). Closing it with the X or Cancel therefore used to discard the only way to apply that
 * shot — which is the gap reported from the table ("if you close the apply window it doesn't go back to
 * the chat cards"). The card-first flow always had that fallback; routing to the window orphaned it.
 *
 * So on a dismissal the card gets the flag it would have got had the shot gone to PATH B, and the standard
 * Apply button renders on it from _hookRenderChatMessage. Nothing is queued and no card is searched for at
 * this point — the card was identified when it was created, while the matcher could still be sure of it.
 *
 * Runs on the client that held the window, which is the client that authored the card (the shot's own).
 * The flag lands on the document, so every permitted reader sees the button; already-flagged cards are
 * left alone, so a PATH-B window dismissed a second time cannot stack anything.
 */
function _hookDamageDialogDismissed() {
  Hooks.on(DAMAGE_DIALOG_DISMISSED_HOOK, async (payload) => {
    // No memory for this payload = nothing to restore. That is the normal answer for a PATH-B window
    // (its payload came OFF a card, which already carries the flag) and for a shot whose card never came.
    const messageId = payload ? _cardIdByPayload.get(payload) : null;
    if (!messageId) return;
    const message = game.messages?.get(messageId);
    if (!message) return;
    if (message.getFlag?.("cp2020-augmented", "damagePayload")) return;
    try {
      await message.setFlag("cp2020-augmented", "damagePayload", payload);
    } catch (err) {
      console.warn("CP2020 | Could not return the damage payload to the shot's chat message", err);
    }
  });
}

/**
 * The render pass itself: put the Apply Damage control on a card that carries a damage payload.
 * Kept separate from its registration so the same function serves both the per-message render hook
 * and the scrollback catch-up in chat-render-compat.js. Idempotent — see the guard below.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
function _injectApplyDamageControl(message, html) {
  const payload = message.getFlag?.("cp2020-augmented", "damagePayload");
  if (!payload?.areaDamages || Object.keys(payload.areaDamages).length === 0) return;

  // Show button to GM always; show to players only if they own the attacker actor.
  // Avoids any dependency on message.userId / message.author which can be undefined in v14+.
  const attackerActorId = payload.attackerId ?? payload.actorId ?? null;
  const attackerActor = attackerActorId ? game.actors.get(attackerActorId) : null;
  const canApply = game.user.isGM || (attackerActor?.isOwner ?? false);
  if (!canApply) return;

  // This pass runs again after setFlag, on any later re-render (edit, popout), and once more from
  // the scrollback catch-up. Without this guard each of those stacks another button.
  if (html.querySelector(".cp2020-apply-damage-btn")) return;

  const btn = document.createElement("button");
  btn.classList.add("cp2020-apply-damage-btn");
  btn.textContent = localize("ApplyDamageBtn");

  btn.addEventListener("click", async () => {
    // Prefer a currently-targeted token; fall back to payload IDs
    let target = null;

    const currentTargets = game.user.targets;
    if (currentTargets.size > 0) {
      const tok = currentTargets.first();
      target = tok.actor;
      payload.targetTokenId = tok.id;
      payload.targetActorId = target?.id ?? null;
    } else {
      target = _resolveTarget(payload);
    }

    if (!target) {
      target = await _pickTargetDialog();
      if (!target) return;
    }

    // Dispatch by target type: a vehicle target (or a Penetration weapon vs a person) is handled
    // by the unified resolver; a normal personnel-vs-person hit falls through to the dialog.
    if (await dispatchAttack(payload, target)) return;

    // The reader pressed the button on the card, so the window opens now — no wait for a presentation
    // that finished long ago, and no world setting deciding on their behalf whether they get one.
    new DamageDialog(payload, target).render(true);
  });

  const container = html.querySelector(".cyberpunk-card") ?? html;
  container.appendChild(btn);
}

/**
 * Render pass: a CLEARED pattern card shows a line where its buttons were.
 *
 * The user's ruling in one behaviour — "it should go away on application and should otherwise be able
 * to be cleared". Applied, the card is locked by the shared card lock and keeps its (disabled) button
 * as the record of what happened; CLEARED, the buttons are removed outright and replaced by a sentence
 * saying the shot was voided, because there is no longer a pattern for any of them to act on.
 *
 * Driven off the message flag rather than off rewritten message content, so it survives a reload,
 * reaches every client, and needs no stored copy of the card's original render context. Keyed on
 * `spreadCleared` and NOT on the resolved lock, deliberately: the GM's ↺ re-arm control lifts the lock,
 * and a re-armed cleared card must still not offer to apply a pattern that is gone.
 *
 * Idempotent (the contract every pass here has): it returns as soon as its own line is present.
 */
function _renderClearedPatternCard(message, html) {
  if (!message?.getFlag?.("cp2020-augmented", "spreadCleared")) return;
  const root = getHtmlElement(html);
  const buttons = root?.querySelector?.(".save-buttons");
  if (!buttons || buttons.querySelector(".cp-spread-cleared")) return;
  buttons.replaceChildren();
  const line = document.createElement("span");
  // save-note is the card's own quiet-text class (the hint line these templates already carry), so the
  // cleared line needs no styling of its own.
  line.classList.add("save-note", "cp-spread-cleared");
  line.textContent = localize("SpreadClearedLine");
  buttons.appendChild(line);
}

function _hookClearedPatternCard() {
  // Registered through onChatCardRender for the same reason the apply control and the card lock are:
  // the log's first scrollback batch renders before `ready`, so a plain Hooks.on would leave every
  // cleared card in the log still showing live buttons after a reload.
  onChatCardRender(_renderClearedPatternCard);
}

function _hookRenderChatMessage() {
  // renderChatMessageHTML replaced the deprecated renderChatMessage in Foundry v15.
  // It passes a native HTMLElement as the second argument on v13 (since v13.331) and v14+.
  // Using this hook name means we work on v13.350, v14, and v15 with a single registration.
  //
  // Registered through onChatCardRender, not Hooks.on directly: the log's first scrollback batch
  // renders (and fires this hook for every message in it) BEFORE the `ready` hook this wiring runs
  // in, so a plain registration would miss every card already in the log — the reason a reload used
  // to strip the Apply control off existing cards. See module/chat-render-compat.js.
  onChatCardRender(_injectApplyDamageControl);
}

/**
 * Suppressive fire flow (placement-forward, native-region rail — regions on BOTH cores here):
 *   1. The shooter's client gets the local `cyberpunk2020.suppressiveFire` seam hook and enters an
 *      aim/size PREVIEW (module/combat/suppressive-placement.js): a PIXI corridor anchored at the
 *      shooter's token, aimed with the cursor, widened with the wheel, with a live "width Xm → evasion
 *      save N" readout (DC = rounds fired ÷ drawn width). The width IS the difficulty, so the player sees
 *      the tradeoff as they draw it.
 *   2. Confirm relays the drawn geometry to the active GM (players cannot create Regions), who PLANTS the
 *      lane: a Region carrying the `cp2020-augmented.suppressiveFire` behavior + an ALWAYS visibility + a
 *      `suppressiveLocked` flag. Creating the behavior inline fires the native token-enter event for every
 *      token ALREADY standing in the lane, so "prompt everyone in the beaten zone at confirm" happens with
 *      no extra pass — the same enter path later crossers take.
 *   3. Entry (at plant, or by walking in) → the behavior emits SUPPRESSIVE_ZONE_ENTERED_HOOK on the active
 *      GM → _hookSuppressiveZoneEntered posts the evasion prompt for the entering token.
 *   4. The GM can UNLOCK a placed lane (card button): clears the lock flag + re-arms the shooter's preview
 *      with the existing geometry; on re-confirm the GM UPDATES the region's shape + behavior + re-locks.
 *   5. Expiry: a shooter-owned lane is deleted when the round advances past its createdRound; a blank-shooter
 *      lane is a permanent hand-authored kill lane and never auto-expires.
 *
 * Evasion: Athletics + REF + 1d10 vs saveDC (CP2020 p.101). Failure: 1d6 random hits with the weapon's
 * damage formula, routed back through the weaponFired pipeline. The whole feature is gated by the
 * `suppressiveFireSaves` setting.
 */
function _suppressiveSavesEnabled() {
  try { return game.settings.get("cp2020-augmented", "suppressiveFireSaves"); }
  catch { return false; }
}

function _hookSuppressiveFire() {
  Hooks.on("cyberpunk2020.suppressiveFire", async (payload) => {
    if (!_suppressiveSavesEnabled()) return;
    // Hooks.callAll is LOCAL to the firing client, so this runs on the SHOOTER's client (player or GM).
    // Placement-forward: enter the aim/size preview here instead of auto-placing; the preview seeds its
    // opening width from the DECLARED zoneWidth and relays the confirmed geometry to the active GM to plant.
    // The base suppressive card (posted just before this) quotes the DC for the DECLARED width, so with zones
    // ON it matches the planted lane's card unless the shooter re-sizes on the canvas (a visible, expected
    // divergence); with zones OFF (this handler bails on the setting gate) the base flow is untouched.
    const { armSuppressivePreview } = await import("./suppressive-placement.js");
    await armSuppressivePreview(payload);
  });
}

/**
 * GM-side PLANT of a suppressive lane from the geometry the shooter's preview confirmed (relayed over the
 * module socket, or called directly when the shooter IS the active GM). Creates — or, when the geometry
 * carries a `regionId` (a re-confirm after an unlock), UPDATES — a Region carrying the suppressiveFire
 * behavior. Regions on BOTH cores for this feature, so this does NOT route through createArea/usesRegions.
 * Exported for the preview's direct-plant path and the keeper. Runs on the active GM.
 */
export async function placeSuppressiveZoneFromGeometry(geo) {
  // Plant on the scene the shooter aimed on (its grid computed the pixel geometry), NOT the GM's currently
  // viewed scene — the two can differ when the GM is looking elsewhere at confirm time. Fall back to the
  // viewed scene only when no sceneId rode along (older payloads).
  const scene = (geo?.sceneId ? game.scenes?.get(geo.sceneId) : null) ?? canvas?.scene;
  if (!scene || !geo?.origin) { ui.notifications?.warn?.(localize("SuppFireNoToken")); return null; }

  const V = CONST?.REGION_VISIBILITY ?? {};
  // Same pure geometry the preview drew (rayPolygonShape off the same origin/angle/length/width) → the
  // planted lane is pixel-identical to what the player saw.
  const shape = rayPolygonShape(geo.origin.x, geo.origin.y, geo.angleDeg, geo.lengthPx, geo.widthPx);
  const saveDC = Math.max(1, Number(geo.saveDC) || 1);
  const name = localize("SuppZoneBehaviorLabel");
  const dmgFormula = geo.dmgFormula || "1d6";
  const weaponName = geo.weaponName || "";
  // The full geometry rides on the region's flags so an Unlock can re-prime the preview with this lane (the
  // sceneId is carried so a re-confirm UPDATE lands on this same scene).
  const geometryFlag = {
    sceneId: scene.id,
    origin: geo.origin, angleDeg: geo.angleDeg, widthM: geo.widthM,
    lengthPx: geo.lengthPx, widthPx: geo.widthPx, weaponRange: geo.weaponRange,
    roundsFired: geo.roundsFired, userId: geo.userId ?? "", attackerTokenId: geo.attackerTokenId ?? "",
    actorId: geo.actorId ?? "", dmgFormula, weaponName,
  };

  // UPDATE path — a re-confirm after unlock rewrites the existing lane's shape + behavior and re-locks it.
  if (geo.regionId) {
    const region = scene.regions?.get?.(geo.regionId);
    if (region) {
      await region.update({
        shapes: [shape],
        flags: { "cp2020-augmented": { suppressiveLocked: true, suppressiveGeometry: geometryFlag } },
      }).catch(() => {});
      const behavior = region.behaviors?.find((b) => b.type === SUPPRESSIVE_ZONE_BEHAVIOR);
      if (behavior) await behavior.update({ "system.saveDC": saveDC, "system.dmgFormula": dmgFormula, "system.weaponName": weaponName }).catch(() => {});
      await _postSuppressivePlacementCard({ weaponName, saveDC, regionId: region.id, sceneId: scene.id, actorId: geo.actorId });
      return region;
    }
    // The region vanished (deleted meanwhile) — fall through to a fresh create.
  }

  const [region] = await scene.createEmbeddedDocuments("Region", [{
    name,
    color: "#ff4400",
    shapes: [shape],
    visibility: V.ALWAYS ?? 2,
    flags: { "cp2020-augmented": { suppressiveLocked: true, suppressiveGeometry: geometryFlag } },
    behaviors: [{
      type: SUPPRESSIVE_ZONE_BEHAVIOR,
      name,
      system: {
        saveDC,
        dmgFormula,
        attackerId: geo.actorId || "",
        weaponName,
        createdRound: game.combat?.round ?? 0,
      },
    }],
  }]);
  if (!region) { ui.notifications?.warn?.(localize("SuppFireZoneFail")); return null; }

  await _postSuppressivePlacementCard({ weaponName, saveDC, regionId: region.id, sceneId: scene.id, actorId: geo.actorId });
  return region;
}

/** Post the "lane placed" card (states the DC + carries the GM-only Unlock control). */
async function _postSuppressivePlacementCard({ weaponName, saveDC, regionId, sceneId, actorId }) {
  const content = await renderChatCard("suppressive-placement.hbs", {
    weaponName, saveDC, regionId, sceneId, isGM: game.user?.isGM === true,
  });
  await ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor: (actorId ? game.actors.get(actorId) : null) ?? undefined }),
  });
}

/**
 * GM UNLOCK: re-open the shooter's aim/size preview for a placed lane. Clears the region's lock flag and
 * re-arms the preview (locally if the shooter is this GM, else relayed to the shooter's client) primed with
 * the lane's stored geometry + its regionId, so a re-confirm UPDATES this same region. Gated to the active
 * GM (only it owns the region write; a stray click on another GM client is a no-op). The lane keeps firing
 * while unlocked — the enter listener is not gated on the lock.
 */
export async function _unlockSuppressiveZone(regionId, sceneId) {
  if (!game.user?.isGM || game.users?.activeGM?.id !== game.user?.id) return;
  // Resolve the lane's OWN scene (the card carries it), not necessarily the GM's viewed scene.
  const scene = (sceneId ? game.scenes?.get(sceneId) : null) ?? canvas?.scene;
  const region = scene?.regions?.get?.(regionId);
  if (!region) { ui.notifications?.warn?.(localize("SuppFireZoneFail")); return; }
  const geo = foundry.utils.deepClone(region.flags?.["cp2020-augmented"]?.suppressiveGeometry ?? null);
  await region.update({ flags: { "cp2020-augmented": { suppressiveLocked: false } } }).catch(() => {});
  if (!geo) return;
  await _relaySuppressiveRearm({ ...geo, regionId: region.id, saveDC: Math.ceil((Number(geo.roundsFired) || 0) / Math.max(1, Number(geo.widthM) || 2)) });
}

/** Send the re-arm to the shooter's client (arm locally if that client is this GM — a socket never reaches
 *  its own sender). */
async function _relaySuppressiveRearm(geo) {
  if (geo.userId && geo.userId === game.user?.id) {
    const { armSuppressivePreview } = await import("./suppressive-placement.js");
    await armSuppressivePreview({ ...geo, rearm: true });
  } else {
    game.socket.emit("module.cp2020-augmented", { type: "suppressiveZoneRearm", payload: geo });
  }
}

// Area-Confirm ids already resolved on THIS client. The confirm handlers below apply their effect but do
// NOT consume the template (it persists for scatter + visibility), so without this a double-click — or two
// GMs each clicking Confirm — applies the blast/spread/fire-zone twice. The synchronous check+add (before
// any await) makes it race-free; all confirms route to the active GM, so its Set is the authoritative one.
const _resolvedAreaConfirms = new Set();

/**
 * Gate an area-Confirm to the active GM and make it idempotent. A non-active-GM's click is relayed to the
 * active GM (mirrors the placement relay) so exactly one client resolves the effect; the active GM claims
 * the template id so a stray double-click/double-relay is a no-op. `relayData` is spread into the socket
 * payload (fire-zone carries its full args; blast/spread carry only the template id).
 * @returns {boolean} true iff this client should resolve the Confirm now.
 */
function _claimAreaConfirm(relayType, relayData, templateId) {
  if (game.users.activeGM?.id !== game.user.id) {
    game.socket.emit("module.cp2020-augmented", { type: relayType, ...relayData });
    return false;
  }
  if (_resolvedAreaConfirms.has(templateId)) return false;
  _resolvedAreaConfirms.add(templateId);
  return true;
}

/** Post an evasion prompt for one token caught in a suppressive lane. `sceneId` lets the evasion executor
 *  resolve the exact (possibly unlinked) token later. Shared by the enter listener. */
async function _postEvasionPrompt(tokDoc, { saveDC, dmgFormula, weaponName, attackerId, sceneId }) {
  const actor = tokDoc?.actor;
  if (!actor) return;
  const ref       = Number(actor.system?.stats?.ref?.total) || 0;
  const athletics = Number(actor.getSkillVal?.("Athletics") ?? 0);

  const content = await renderChatCard("suppression-evasion-prompt.hbs", {
    actorName: actor.name, saveDC, weaponName, ref, athletics,
    actorId: actor.id, tokenId: tokDoc.id, sceneId, dmgFormula, attackerId,
  });

  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
}

/**
 * Native-region ENTER → evasion prompt. The suppressiveFire behavior fires SUPPRESSIVE_ZONE_ENTERED_HOOK
 * (on the active GM only) for a token crossing INTO the lane AND for every token already standing in it at
 * plant/re-enable, so this one path covers "in the beaten zone at confirm" and "walked in later". The
 * shooter is never prompted by their own lane; the lane's lock state is irrelevant (an unlocked lane is
 * still firing). Values come off the behavior's system data (weapon name falls back to a localized generic
 * at display time so a stored blank never freezes the UI language).
 */
function _hookSuppressiveZoneEntered() {
  Hooks.on(SUPPRESSIVE_ZONE_ENTERED_HOOK, async ({ behavior, region, tokenDoc }) => {
    try {
      if (!_suppressiveSavesEnabled()) return;
      const sys = behavior?.system ?? {};
      const attackerId = String(sys.attackerId ?? "").trim();
      if (attackerId && tokenDoc?.actor?.id === attackerId) return;   // never prompt the shooter's own lane
      if (!tokenDoc?.actor) return;
      const weaponName = String(sys.weaponName ?? "").trim() || localize("SuppZoneBehaviorLabel");
      const sceneId = region?.parent?.id ?? tokenDoc?.parent?.id ?? canvas?.scene?.id ?? "";
      await _postEvasionPrompt(tokenDoc, {
        saveDC: Number(sys.saveDC) || 1,
        dmgFormula: sys.dmgFormula || "1d6",
        weaponName,
        attackerId,
        sceneId,
      });
    } catch (e) {
      console.warn("cp2020-augmented | suppressive zone-entered handler failed", e);
    }
  });
}

/**
 * Expiry tick: when the combat round advances, delete every shooter-owned suppressive lane laid on an
 * earlier round (its shooter's turn has passed). A blank-shooter lane is a permanent hand-authored kill
 * lane and is left alone. Regions on both cores. Same gating chain as the gas/radiation ticks + the
 * whole-feature setting gate. The old per-turn standing re-test is dropped by design (entry now drives the
 * saves).
 */
function _hookSuppressiveExpiry() {
  Hooks.on("updateCombat", async (combat, updateData) => {
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;   // one GM only, else a delete race
    if (updateData.round === undefined) return;             // round advance only
    if (!_suppressiveSavesEnabled()) return;
    const scene = canvas?.scene;
    if (!scene) return;

    const currentRound = combat.round ?? 0;
    for (const region of [...(scene.regions ?? [])]) {
      const behavior = region.behaviors?.find((b) => !b.disabled && b.type === SUPPRESSIVE_ZONE_BEHAVIOR);
      if (!behavior) continue;
      const attackerId = String(behavior.system?.attackerId ?? "").trim();
      if (!attackerId) continue;                            // permanent lane — never auto-expires
      const createdRound = Number(behavior.system?.createdRound ?? 0);
      if (currentRound > createdRound) await region.delete().catch(() => {});
    }
  });
}

/**
 * Execute a suppressive fire evasion roll. Called by the button click handler.
 * On failure: roll 1d6 hits with the weapon's dmgFormula, apply via PATH B.
 */
export async function _executeSuppressionEvasion({ actorId, tokenId, sceneId, saveDC, dmgFormula, attackerId }) {
  // Token-first: the evader is the TOKEN caught in the zone — an unlinked token's REF/Athletics
  // (and the follow-up hits) belong to its synthetic actor, not the shared world actor.
  const actor = resolveActorRef({ tokenId, sceneId, actorId });
  if (!actor) return;

  const ref       = Number(actor.system?.stats?.ref?.total) || 0;
  const athletics = Number(actor.getSkillVal?.("Athletics") ?? 0);

  const roll   = await new Roll("1d10 + @ref + @athletics", { ref, athletics }).evaluate();
  const total  = roll.total;
  const dc     = Number(saveDC) || 0;
  const evaded = total > dc;

  const content = await renderChatCard("suppression-evasion-result.hbs", {
    actorName: actor.name, athletics, ref, die: roll.dice[0].total, total, dc, evaded,
  });

  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor:  localizeParam("SuppEvasionFlavor", { dc }),
    content,
  });

  if (!evaded) {
    const hitsRoll = await new Roll("1d6").evaluate();
    const hits = hitsRoll.total;
    const rollData = {};
    const areaDamages = {};

    for (let i = 0; i < hits; i++) {
      const locResult = await rollLocation(actor, null);
      const loc = locResult.areaHit;
      const dmgRoll = await new Roll(dmgFormula || "1d6", rollData).evaluate();
      const dmg = Math.floor(dmgRoll.total);
      if (!areaDamages[loc]) areaDamages[loc] = [];
      areaDamages[loc].push({ damage: dmg });
    }

    if (Object.keys(areaDamages).length > 0) {
      Hooks.callAll("cyberpunk2020.weaponFired", {
        areaDamages,
        ap:           false,
        targetTokenId: tokenId,
        targetActorId: actorId,
        weaponName:   localize("WpnSuppressiveFireHit"),
      });
    }
  }
}

function _resolveTarget(payload) {
  if (payload.targetTokenId) {
    const token = canvas.tokens?.get(payload.targetTokenId);
    if (token?.actor) return token.actor;
  }
  if (payload.targetActorId) {
    return game.actors.get(payload.targetActorId) ?? null;
  }
  // The presentation aim, last: it is set on every fire mode where the routing field is set only on
  // full auto, so it is what a single or semi-automatic shot at a held target resolves through. Read
  // after the routing fields so a card that resolved its own target still wins.
  if (payload.fxTargetTokenId) {
    const token = canvas.tokens?.get(payload.fxTargetTokenId);
    if (token?.actor) return token.actor;
  }
  return null;
}

/**
 * Show a token-picker dialog when no target is pre-selected.
 * Lists all tokens on the current canvas scene. Returns the chosen Actor or null.
 */
async function _pickTargetDialog() {
  const tokens = canvas?.tokens?.placeables ?? [];
  const validTokens = tokens.filter(t => t.actor);

  if (!validTokens.length) {
    ui.notifications.warn(localize("NoTokensOnScene"));
    return null;
  }

  // Read targeting state at dialog-open time (informs the default button and status hint).
  // "Use Canvas Target" re-reads game.user.targets at click time, so the GM can target
  // a token while the dialog is open and still use that button.
  const openTimeTarget = game.user.targets?.first() ?? null;
  const targetedName   = openTimeTarget?.name ?? null;

  const content = await renderChatCard("target-pick-dialog.hbs", {
    targetedName,
    options: validTokens.map((t, i) => ({ value: i, label: t.name })),
  });

  return new Promise((resolve) => {
    new foundry.applications.api.DialogV2({
      window: { title: localize("ApplyDamageSelectTarget") },
      classes: ["cp-apply-target-dialog"],
      // A DialogV2 sizes itself to a narrow default (measured 241px here), which left the footer
      // 208px to divide between three buttons — not enough for "Use Canvas Target" to stay on one
      // line. The css sizes each button to its own label; this is the width that then fits all
      // three across. Resizable, so a longer translation can still be given more room by hand.
      position: { width: 420 },
      content,
      buttons: [
        {
          action: "useCanvas",
          icon: "fas fa-crosshairs",
          label: localize("UseCanvasTarget"),
          default: !!openTimeTarget,
          callback: () => {
            // Re-read targets at click time — GM may have targeted while dialog was open
            const tok = game.user.targets?.first() ?? null;
            if (!tok?.actor) {
              ui.notifications.warn(localize("NoTokenTargeted"));
              resolve(null);
            } else {
              resolve(tok.actor);
            }
          },
        },
        {
          action: "useList",
          icon: "fas fa-list",
          label: localize("UseList"),
          default: !openTimeTarget,
          callback: (ev, btn, dlg) => {
            const idx = Number(dlg.element.querySelector("#cp-target-pick")?.value) || 0;
            resolve(validTokens[idx]?.actor ?? null);
          },
        },
        {
          action: "cancel",
          label: localize("Cancel"),
          callback: () => resolve(null),
        },
      ],
      rejectClose: false,
      close: () => resolve(null),
    }).render({ force: true });
  });
}

/**
 * Aim accumulation tracking (CP2020 p.99 — +1 per consecutive aim round, max +3).
 * Persists aimRounds on the actor flag across turns; pre-fills the attack dialog on open;
 * clears the flag when the actor fires.
 */
function _hookAimTracking() {
  const isEnabled = () => {
    try { return game.settings.get("cp2020-augmented", "aimTrackingEnabled"); }
    catch { return true; }
  };

  Hooks.on("renderCombatTracker", (tracker, html) => {
    if (!isEnabled()) return;
    const combat = game.combat;
    if (!combat) return;
    const combatant = combat.combatants.get(combat.current?.combatantId);
    if (!combatant?.actor) return;
    const actor = combatant.actor;
    if (!game.user.isGM && !actor.isOwner) return;

    const aimCount = actor.getFlag("cp2020-augmented", "aimRounds") ?? 0;
    const root = html instanceof jQuery ? html[0] : (Array.isArray(html) ? html[0] : html);
    const li   = root?.querySelector?.(`[data-combatant-id="${combatant.id}"]`);
    if (!li) return;
    li.querySelectorAll(".cp-take-aim-btn").forEach(e => e.remove()); // idempotent across re-renders

    const controls = li.querySelector(".combatant-controls") ?? li.querySelector("menu") ?? li;
    const btn = document.createElement("a");
    btn.classList.add("cp-take-aim-btn", "combatant-control");
    btn.dataset.actorId = actor.id;
    btn.title = aimCount > 0
      ? localizeParam("TakeAimTitleActive", { n: aimCount })
      : localize("TakeAimTitle");
    if (aimCount > 0) btn.classList.add("cp-active");
    btn.innerHTML = `🎯${aimCount > 0 ? aimCount : ""}`;
    controls.prepend(btn);
  });

  Hooks.on("renderModifiersDialog", (app, html) => {
    if (!isEnabled()) return;
    const actor = (app._weapon ?? app.options?.weapon)?.actor;
    if (!actor) return;
    const savedAim = actor.getFlag("cp2020-augmented", "aimRounds") ?? 0;
    if (savedAim <= 0) return;
    const root   = html instanceof jQuery ? html[0] : (Array.isArray(html) ? html[0] : html);
    const select = root?.querySelector?.("select[name='aimRounds']");
    if (select) select.value = String(Math.min(3, savedAim));
  });

  Hooks.on("cyberpunk2020.weaponFired", (payload) => {
    const actorId = payload.attackerId ?? payload.actorId;
    if (!isEnabled() || !actorId) return;
    const actor = game.actors.get(actorId);
    if (!actor) return;
    if ((actor.getFlag("cp2020-augmented", "aimRounds") ?? 0) > 0) {
      actor.unsetFlag("cp2020-augmented", "aimRounds").catch(() => {});
    }
  });
}

/**
 * Wait for Turn system (CP2020 p.98). Initiative order is never modified.
 * A combatant flag tracks waiting state instead.
 *
 * ⏸ = active, not waiting → opens dialog to pick who to follow, then skips current slot
 * ⚡ = currently waiting  → announces delayed action, clears flag
 * "Your moment" alert fires when the followed combatant ends their turn.
 * All waiting flags clear on round end.
 */
function _hookWaitForTurn() {
  const isEnabled = () => {
    try { return game.settings.get("cp2020-augmented", "waitForTurnEnabled"); }
    catch { return true; }
  };

  Hooks.on("renderCombatTracker", (tracker, html) => {
    if (!isEnabled()) return;
    const combat = game.combat;
    if (!combat) return;
    const root = html instanceof jQuery ? html[0] : (Array.isArray(html) ? html[0] : html);
    if (!root) return;

    for (const combatant of combat.combatants) {
      const canControl = game.user.isGM || combatant.actor?.isOwner;
      if (!canControl) continue;

      const li = root.querySelector?.(`[data-combatant-id="${combatant.id}"]`);
      if (!li) continue;
      li.querySelectorAll(".cp-wait-for-turn-btn, .cp-wait-act-btn").forEach(e => e.remove()); // idempotent across re-renders

      const controls = li.querySelector(".combatant-controls") ?? li.querySelector("menu") ?? li;
      const isWaiting = combatant.getFlag("cp2020-augmented", "waitingForTurn");
      const isActive  = combatant.id === combat.current?.combatantId;

      if (isWaiting) {
        const actBtn = document.createElement("a");
        actBtn.classList.add("cp-wait-act-btn", "combatant-control");
        actBtn.dataset.combatantId = combatant.id;
        actBtn.title = localize("WaitActTitle");
        actBtn.innerHTML = "⚡";
        controls.prepend(actBtn);
      } else if (isActive) {
        const waitBtn = document.createElement("a");
        waitBtn.classList.add("cp-wait-for-turn-btn", "combatant-control");
        waitBtn.dataset.combatantId = combatant.id;
        waitBtn.title = localize("WaitForTurnBtnTitle");
        waitBtn.innerHTML = "⏸";
        controls.prepend(waitBtn);
      }
    }
  });

  Hooks.on("updateCombat", async (combat, updateData) => {
    if (!game.user.isGM) return;
    // Active GM only — otherwise each connected GM posts a duplicate "your moment" alert.
    if (game.users.activeGM?.id !== game.user.id) return;

    if (updateData.round !== undefined) {
      for (const combatant of combat.combatants) {
        if (combatant.getFlag("cp2020-augmented", "waitingForTurn")) {
          await combatant.unsetFlag("cp2020-augmented", "waitingForTurn").catch(() => {});
          await combatant.unsetFlag("cp2020-augmented", "waitingAfterId").catch(() => {});
        }
      }
      return;
    }

    if (updateData.turn === undefined) return;

    // The combatant at turn-1 just completed their action
    const prevIdx = (combat.turn ?? 0) - 1;
    if (prevIdx < 0) return;
    const justActed = combat.turns[prevIdx];
    if (!justActed) return;

    // Alert any waiting combatants that were following this one
    for (const combatant of combat.combatants) {
      if (!combatant.getFlag("cp2020-augmented", "waitingForTurn")) continue;
      if (combatant.getFlag("cp2020-augmented", "waitingAfterId") !== justActed.id) continue;

      await postSavePromptCard({
        title: localizeParam("YourMomentTitle", { name: combatant.name }),
        body: localizeParam("YourMomentBody", { name: justActed.name }),
        speaker: ChatMessage.getSpeaker({ actor: combatant.actor ?? undefined }),
      });
    }
  });
}

/**
 * Active defense buttons (CP2020 p.102).
 *
 * Dodge (active combatant): sets "dodging" flag → +2 to defender's contested roll until next turn.
 * Parry (any combatant): sets "parrying" flag → next incoming melee attack blocked; consumed on use.
 *   Parry also costs an action (−3 to other rolls this turn); chat reminds the GM to enforce it.
 *
 * The mechanical effects are applied in item.js __meleeBonk / __martialBonk, which
 * read these flags on the defending actor.
 */
function _hookDodgeParry() {
  const isEnabled = () => {
    try { return game.settings.get("cp2020-augmented", "activeDodgeParryEnabled"); }
    catch { return true; }
  };

  Hooks.on("renderCombatTracker", (tracker, html) => {
    if (!isEnabled()) return;
    const combat = game.combat;
    if (!combat) return;
    const root = html instanceof jQuery ? html[0] : (Array.isArray(html) ? html[0] : html);
    if (!root) return;

    for (const combatant of combat.combatants) {
      const actor = combatant.actor;
      if (!actor) continue;
      const canControl = game.user.isGM || actor.isOwner;
      if (!canControl) continue;

      const li = root.querySelector?.(`[data-combatant-id="${combatant.id}"]`);
      if (!li) continue;
      li.querySelectorAll(".cp-dodge-btn, .cp-parry-btn").forEach(e => e.remove()); // idempotent across re-renders

      const controls = li.querySelector(".combatant-controls") ?? li.querySelector("menu") ?? li;
      const isDodging  = actor.getFlag("cp2020-augmented", "dodging")  ?? false;
      const isParrying = actor.getFlag("cp2020-augmented", "parrying") ?? false;
      const isActive   = combatant.id === combat.current?.combatantId;

      if (isActive) {
        const dodgeBtn = document.createElement("a");
        dodgeBtn.classList.add("cp-dodge-btn", "combatant-control");
        dodgeBtn.dataset.actorId = actor.id;
        dodgeBtn.title = isDodging ? localize("DodgeTitleActive") : localize("DodgeTitle");
        if (isDodging) dodgeBtn.classList.add("cp-active");
        dodgeBtn.innerHTML = isDodging ? "🛡✓" : "🛡";
        controls.prepend(dodgeBtn);
      }

      const parryBtn = document.createElement("a");
      parryBtn.classList.add("cp-parry-btn", "combatant-control");
      parryBtn.dataset.actorId = actor.id;
      parryBtn.title = isParrying ? localize("ParryTitleActive") : localize("ParryTitle");
      if (isParrying) parryBtn.classList.add("cp-active");
      parryBtn.innerHTML = isParrying ? "⛨✓" : "⛨";
      controls.prepend(parryBtn);
    }
  });

  Hooks.on("updateCombat", async (combat, updateData) => {
    if (!game.user.isGM) return;
    // Active GM only — keeps multi-GM tables from double-clearing dodge/parry flags
    // (idempotent, but consistent with the other per-turn handlers).
    if (game.users.activeGM?.id !== game.user.id) return;
    if (updateData.turn === undefined && updateData.round === undefined) return;

    const combatant = combat.combatant;
    if (!combatant?.actor) return;

    const actor = combatant.actor;
    if (actor.getFlag("cp2020-augmented", "dodging")) {
      await actor.unsetFlag("cp2020-augmented", "dodging").catch(() => {});
    }
    // Parry is consumed in item.js on hit; clear it here on round end as a safety net
    // in case it was declared but no melee attack ever came
    if (updateData.round !== undefined && actor.getFlag("cp2020-augmented", "parrying")) {
      await actor.unsetFlag("cp2020-augmented", "parrying").catch(() => {});
    }
  });
}

function _hookDotEffects() {
  Hooks.on("updateCombat", async (combat, updateData) => {
    if (!game.user.isGM) return;
    // Only the primary GM applies DOT damage/ablation. updateCombat fires on EVERY
    // connected GM client; without this guard, N connected GMs each apply the tick,
    // multiplying HP loss / armor degradation by N (matches the gas-cloud guard below).
    if (game.users.activeGM?.id !== game.user.id) return;
    if (updateData.turn === undefined && updateData.round === undefined) return;
    // Starting combat is not a turn elapsing: the round-0→1 transition must not tick an
    // ongoing effect (a character carrying one into the encounter would take instant
    // damage the moment the GM clicks Begin Combat). Missing `previous` falls through.
    const dotPrevRound = combat.previous?.round;
    if (dotPrevRound !== undefined && dotPrevRound < 1) return;
    // Round-tick automation master (settings): the over-time DOT/ablation tick is a sub-toggle of the
    // round-tick automation, exactly like the gas per-turn hook — a table that turns off round-tick
    // automation runs these ticks manually (the combat-tracker control), not on every turn advance.
    if (!mechRoundTickEnabled()) return;
    await _runOverTimeTick(combat);
  });
}

/** One over-time (DOT / ablation / choke / hold-grapple) pass for the combat's current combatant.
 *  Ungated by the round-tick master so both the per-turn hook (gated above) and the manual combat-tracker
 *  control run it; the per-feature toggles (acid/fire/melee) stay inline. */
async function _runOverTimeTick(combat) {
  const combatant = combat.combatant;
  if (!combatant?.actor) return;
  const actor = combatant.actor;
  const token = canvas?.tokens?.placeables?.find(t => t.id === combatant.tokenId) ?? null;

  // ── Acid armor DOT ────────────────────────────────────────────────────────
  const acidEnabled = (() => {
    try { return game.settings.get("cp2020-augmented", "acidArmorDotEnabled"); }
    catch { return true; }
  })();
  if (acidEnabled && !actor.statuses?.has("dead")) {
    const rawDot = actor.getFlag?.("cp2020-augmented", "dotState");
    // Migrate legacy single-object format to array
    const dotStates = Array.isArray(rawDot) ? rawDot : (rawDot ? [rawDot] : []);
    if (dotStates.length > 0) {
      const surviving = [];
      for (const ds of dotStates) {
        const { location, turnsLeft, formula } = ds;
        if (!location || turnsLeft <= 0) continue;
        let spReduction = 0;
        try {
          const roll = await new Roll(formula || "1d6").evaluate();
          spReduction = roll.total;
          await roll.toMessage({
            speaker: ChatMessage.getSpeaker({ actor }),
            flavor: `Acid DOT — SP degradation at ${location} (${turnsLeft} turn${turnsLeft !== 1 ? "s" : ""} remaining)`,
          });
        } catch {
          spReduction = 3;
        }
        if (spReduction > 0) {
          await ablateLocationByAmount(actor, location, spReduction);
          actor.sheet?.render(false);
        }
        const newTurnsLeft = turnsLeft - 1;
        if (newTurnsLeft <= 0) {
          await postSavePromptCard({
            body: localizeParam("AcidExpiredBody", { name: actor.name, location }),
            speaker: ChatMessage.getSpeaker({ actor }),
          });
        } else {
          surviving.push({ location, turnsLeft: newTurnsLeft, formula });
        }
      }
      // ⭐ THE CORE CONDITION GOES WITH THE LAST MARKER, AND ONLY WITH THE LAST ONE. The flag is
      // mirrored onto core's `corrode` when the etch is applied (save-rolls.js mirrorDotStatus), so the
      // token HUD and the effects list say what the flag says; this is the other end of that. Lowering
      // it while entries survive would clear the mark off a figure that is still being eaten — hence
      // the branch rather than an unconditional clear at the end of the pass.
      if (surviving.length > 0) {
        await actor.setFlag("cp2020-augmented", "dotState", surviving);
      } else {
        await actor.unsetFlag("cp2020-augmented", "dotState");
        await mirrorDotStatus(actor, "corrode", false);
      }
    }
  }

  // ── Fire / Incendiary DOT (burns HP at the hit location, not armor) ───────
  const fireEnabled = (() => {
    try { return game.settings.get("cp2020-augmented", "fireDotEnabled"); }
    catch { return true; }
  })();
  if (fireEnabled && !actor.statuses?.has("dead")) {
    const rawFire = actor.getFlag?.("cp2020-augmented", "fireDotState");
    const fireStates = Array.isArray(rawFire) ? rawFire : (rawFire ? [rawFire] : []);
    if (fireStates.length > 0) {
      const surviving = [];
      // BTM reduces ALL damage that reaches the target — fire bypasses armor SP, not body toughness.
      const fireBtm = Number(actor.system?.stats?.bt?.modifier) || 0;
      // Fire also chars worn armor: one ablation per turn at the location (optional-rule gated).
      const fireAblate = (() => { try { return game.settings.get("cp2020-augmented", "damageAblation"); } catch { return false; } })();
      for (const fs of fireStates) {
        const { location, turnsLeft, formula } = fs;
        const mult = Number(fs.mult ?? 1);   // halves each turn (burn diminishes: 1d6, then 1d6/2…)
        if (!location || turnsLeft <= 0) continue;
        let rolled = 0;
        let roll = null;
        try {
          roll = await new Roll(formula || "1d6").evaluate();
          rolled = Math.floor((Number(roll.total) || 0) * mult);
        } catch {
          rolled = Math.max(1, Math.floor(mult));
        }
        // Floored at 1 like a penetrating hit (applyBTM semantics): a burn still stings.
        const dmg = Math.max(1, rolled - fireBtm);        // flesh HP (BTM applies to the body)
        const fireStructural = Math.max(1, rolled);       // cyberlimb SDP (pre-BTM: machinery has no body toughness)
        if (roll) {
          await roll.toMessage({
            speaker: ChatMessage.getSpeaker({ actor }),
            flavor: `🔥 Fire DOT — ${actor.name} burns at ${location}: ${dmg} dmg (after BTM ${fireBtm}; ${turnsLeft} turn${turnsLeft !== 1 ? "s" : ""} left)`,
          });
        }
        // Route through the shared seam: a burning cyberlimb takes structural SDP damage pre-BTM (no
        // wound track, no stun save); flesh burns HP post-BTM and rolls a stun save.
        // No impact sound: a burn or an etch ticking down is damage landing, but it is not a round
        // arriving on a body, and the seam below cannot tell the two apart on its own.
        const outcome = await applyLocationDamage({ target: actor, location, netDamage: dmg, structuralDamage: fireStructural, penetrates: true, token, fxSilent: true });
        if (fireAblate) {
          // Pass the "fire" type so the burning tick erodes armor by the SAME typed rule as a point-of-impact
          // hit: every layer that actually stopped this fire ablates — a fire garment via its typed rating,
          // a plain layer via its normal SP (RAW, per the ablation ruling 2026-07-11) — while only a
          // fully-typed garment of a DIFFERENT type, which contributed nothing here, is left untouched.
          try { await ablateLocationOnce(actor, location, "fire"); } catch (e) { /* no ablatable armor here */ }
        }
        actor.sheet?.render(false);
        if (!outcome.cyberlimb) await postStunSavePrompt(actor, token);

        const newTurnsLeft = turnsLeft - 1;
        if (newTurnsLeft <= 0) {
          await postSavePromptCard({
            body: localizeParam("FireExpiredBody", { name: actor.name, location }),
            speaker: ChatMessage.getSpeaker({ actor }),
          });
        } else {
          surviving.push({ location, turnsLeft: newTurnsLeft, formula, mult: mult / 2 });
        }
      }
      // The burn's own end of the same mirror (see the acid branch above): `burning` comes off when the
      // LAST fire marker expires, never while one is still counting down at another location.
      if (surviving.length > 0) {
        await actor.setFlag("cp2020-augmented", "fireDotState", surviving);
      } else {
        await actor.unsetFlag("cp2020-augmented", "fireDotState");
        await mirrorDotStatus(actor, "burning", false);
      }
    }
  }

  // ── Choke DOT ────────────────────────────────────────────────────────────
  const meleeEnabled = (() => {
    try { return game.settings.get("cp2020-augmented", "specialMeleeEffectsEnabled"); }
    catch { return true; }
  })();
  if (meleeEnabled) {
    const isDead = actor.statuses?.has("dead");

    const chokeState = actor.getFlag?.("cp2020-augmented", "chokeState");
    if (chokeState) {
      if (isDead) {
        // Dead actor: clear the flag; don't apply damage they can't receive
        await actor.unsetFlag("cp2020-augmented", "chokeState").catch(() => {});
      } else {
        const formula = chokeState.formula || "1d6";
        const roll = await new Roll(formula).evaluate();
        // BTM reduces ALL damage that reaches the target (CP2020 p.99) — choke included.
        const chokeBtm = Number(actor.system?.stats?.bt?.modifier) || 0;
        const damage = Math.max(1, (Number(roll.total) || 0) - chokeBtm);
        const current = Number(actor.system?.damage) || 0;
        await actor.update({ "system.damage": current + damage }, { render: false, fromCyberpunkDamageSystem: true });
        await roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor }),
          flavor: `Choke — ${actor.name} takes ${damage} damage (after BTM ${chokeBtm}). Must make Stun Save.`,
        });
        actor.sheet?.render(false);
        await postStunSavePrompt(actor, token);
      }
    }

    // ── Hold/Grapple turn reminders ──────────────────────────────────────
    if (!isDead) {
      const heldBy      = actor.getFlag?.("cp2020-augmented", "heldBy");
      const grappledBy  = actor.getFlag?.("cp2020-augmented", "grappledBy");
      if (heldBy) {
        const holder = game.actors.get(heldBy);
        await postSavePromptCard({
          body: localizeParam("StillHeldBody", { name: actor.name, holder: holder?.name ?? localize("Attacker") }),
          speaker: ChatMessage.getSpeaker({ actor }),
        });
      } else if (grappledBy) {
        const grappler = game.actors.get(grappledBy);
        await postSavePromptCard({
          body: localizeParam("GrappledReminderBody", { name: actor.name, grappler: grappler?.name ?? localize("Attacker") }),
          speaker: ChatMessage.getSpeaker({ actor }),
        });
      }
    }
  }
}

function _hookGasCloud() {
  const gasEnabled = () => {
    try { return game.settings.get("cp2020-augmented", "gasGrenadeCloudEnabled"); }
    catch { return true; }
  };

  Hooks.on("cyberpunk2020.weaponFired", async (payload) => {
    if (!gasEnabled()) return;
    const types = _effectTypesOf(payload);
    if (!types.includes("Gas")) return;
    // weaponFired fires only on the firing client; placing the cloud needs the GM. The active GM
    // places it directly; anyone else (a player, or a non-active GM) relays to it. Without this a
    // player's gas grenade produced no cloud. Mirrors _hookSuppressiveFire.
    if (game.users.activeGM?.id === game.user.id) await _placeGasCloud(payload);
    else game.socket.emit("module.cp2020-augmented", { type: "gasCloudFired", payload });
  });
}

/**
 * WHICH FIGURE FIRED THIS — the point the three untargeted placements below are drawn out of.
 *
 * ⭐ THE PAYLOAD'S OWN ANSWER COMES FIRST. An actor id cannot name a figure: two tokens of one actor
 * share it, and an UNLINKED copy's synthetic actor answers the base actor's id as well (the id-collision
 * class recorded in combat-data-hazards), so a scan by actor id can only ever report "whichever figure
 * the canvas drew first". That is how a pattern aimed from the second figure was planted from the first
 * — same heading, same reach, same width, the whole corridor translated by the distance between the two
 * (reproduced on the rig 2026-08-15). The seam captures the firing figure at the trigger pull
 * (seam-shim.js firingTokenIdOf) and carries it as `attackerTokenId` for exactly this question.
 *
 * Same preference the presentation rail (fx/effects.js shooterTokenForPayload), the suppressive lane
 * (suppressive-placement.js _resolveShooterToken), the damage window (DamageDialog.js _attackerTokenDoc)
 * and the vehicle facing (vehicle-targeting.js resolveFacing) already apply — this is the one family of
 * placement sites that never got it.
 *
 * The actor scan stays as the fallback it was always meant to be: a payload that carries no such field
 * (a direct macro call, a keeper, a build older than the seam change). Deliberately NOT delegated to
 * `shooterTokenForPayload`, whose own fallback reaches past the canvas to `tokensOf` — a TokenDocument
 * has no `.center`, and one from another scene would put a region at that scene's coordinates on this
 * one. These three sites want a placeable on the viewed canvas or nothing at all.
 */
function _firingTokenOf(payload) {
  const named = payload?.attackerTokenId ? (canvas?.tokens?.get(payload.attackerTokenId) ?? null) : null;
  if (named) return named;
  const attackerId = payload?.attackerId ?? payload?.attackerActorId ?? payload?.actorId ?? null;
  return attackerId ? (canvas?.tokens?.placeables?.find(t => t.actor?.id === attackerId) ?? null) : null;
}

/** Place the gas cloud + post its notice card. Runs on the active GM (directly or via socket relay). */
async function _placeGasCloud(payload) {
    const scene = canvas?.scene;
    if (!scene) return;

    // item.js emits the attacker as "attackerId"; accept legacy aliases too.
    const attackerId = payload.attackerId ?? payload.attackerActorId ?? payload.actorId ?? null;

    // Determine cloud center: target token position, or attacker position if none
    let cloudX = null, cloudY = null;
    if (payload.targetTokenId) {
      const tok = canvas?.tokens?.placeables?.find(t => t.id === payload.targetTokenId);
      if (tok) { cloudX = tok.center?.x ?? tok.x; cloudY = tok.center?.y ?? tok.y; }
    }
    if (cloudX === null) {
      // No target token — the cloud forms on the thrower's own figure. The payload NAMES that figure
      // (`attackerTokenId`, carried since the seam change); the actor-id scan inside _firingTokenOf is
      // only what is left for a payload that predates the field or was raised without going through the
      // seam at all, and it cannot tell two figures of one actor apart.
      const atk = _firingTokenOf(payload);
      if (atk) { cloudX = atk.center?.x ?? atk.x; cloudY = atk.center?.y ?? atk.y; }
    }
    if (cloudX === null) return; // can't place without a position

    const radius      = Number(payload.blastRadius) || 3;
    const duration    = Number(payload.dotTurns)    || 3;
    const stunSaveMod = Number(payload.stunSaveMod) || 0;
    const weaponName  = payload.weaponName ?? localize("WpnGasGrenade");

    // On v14 the area is a Region: carry the cloud's data on a native Gas Cloud behavior, attached INLINE so
    // the spawn stays atomic (no window where the tick sees a behavior-less region). The behavior then OWNS
    // the countdown / penalty / weapon name — the tick reads it first, and the GM manages the cloud with
    // Foundry's own region tools (reshape, hide, delete, edit the fields) — so we do NOT also write the
    // legacy `isGasCloud`/turnsLeft/… flags here. On v13 the area is a MeasuredTemplate, which cannot carry a
    // behavior; it keeps the full legacy flag set the tick's back-compat path reads. Region visibility is
    // fixed to GAMEMASTER inside buildAreaData (the GM-only-default ruling).
    const descriptor = {
      kind: "circle", x: cloudX, y: cloudY, radiusM: radius,
      color: "#88ff44", borderColor: "#44aa22",
    };
    if (usesRegions()) {
      descriptor.behaviors = [{
        type: GAS_CLOUD_BEHAVIOR,
        name: localize("GasCloudBehaviorLabel"),
        system: { turnsLeft: duration, stunSaveMod, weaponName },
      }];
    } else {
      descriptor.flags = {
        isGasCloud: true, turnsLeft: duration, stunSaveMod,
        createdRound: game.combat?.round ?? 0, weaponName,
      };
    }

    const handle = await createArea(scene, descriptor);
    if (!handle?.doc) { console.warn("CP2020 | Gas cloud creation failed"); return; }

    await postSavePromptCard({
      title: localizeParam("GasCloudTitle", { weapon: payload.weaponName ?? localize("GasGrenade") }),
      body: localizeParam("GasCloudPlacedBody", { radius, mod: stunSaveMod, duration }),
      speaker: ChatMessage.getSpeaker({ actor: attackerId ? game.actors.get(attackerId) : undefined }),
    });
}

/** Per-turn: prompt saves for tokens in a gas cloud; decrement turns; delete when expired. */
function _hookGasCloudPerTurn() {
  Hooks.on("updateCombat", async (combat, updateData) => {
    if (!game.user.isGM) return;
    // Only the primary GM runs the per-turn cloud logic, else duplicate prompts/updates.
    if (game.users.activeGM?.id !== game.user.id) return;
    // Per-ROUND, not per-combatant-turn: a cloud adjudicates its tokens ONCE per combat round (a CP2020
    // turn = one 3-second round), and its duration counts down once per round. Firing on every turn
    // advance would prompt each token N× per round (N = combatant count) and expire the cloud N× too fast.
    if (updateData.round === undefined) return;
    // Starting combat is not a round elapsing (matches the DOT block): tokens already standing
    // in a cloud must not be prompted for saves — and the cloud must not lose a turn — the
    // moment the GM clicks Begin Combat. Missing `previous` falls through.
    const gasPrevRound = combat.previous?.round;
    if (gasPrevRound !== undefined && gasPrevRound < 1) return;
    // Round-tick automation master (settings): the per-turn cloud adjudication is a sub-toggle of the
    // gas-cloud feature — a table that turns off round-tick automation runs saves manually (via the
    // combat-tracker control, which calls _runGasCloudTick directly).
    if (!mechRoundTickEnabled()) return;
    await _runGasCloudTick(combat);
  });
}

/**
 * Adjudicate ONE gas cloud for a round: prompt saves for the tokens standing inside it, honoring the
 * protection engine (sealed breathing gear skips the save; save-mod tags offset the penalty; Q8
 * percent-effective filters roll a per-turn gate) and full-borg biosystem immunity, then post the single
 * per-round cloud card. Shared by the native region-behavior path and the legacy flag path — the countdown /
 * drift / expiry stay with each caller (the count lives on the behavior for native clouds, on the flags for
 * legacy ones). `tokenDocs` is the array of TokenDocuments inside the cloud this round. Impure (dice + cards
 * + actor flag writes).
 */
async function _adjudicateGasCloud({ turnsLeft, stunSaveMod, weaponName, tokenDocs }) {
  if (!tokenDocs?.length) return;

  // P6 protection tags (mech/protection.js): sealed breathing gear (mask / independent air)
  // skips the save entirely; a save-mod tag offsets the gas penalty (never past 0); Q8
  // percent-effective gear (nasal filters "70% effective") rolls one d10 per exposure —
  // at or under percent/10 the wearer is protected this turn, and the card shows the roll.
  const decisions = [];
  for (const tokDoc of tokenDocs) {
    // The token's own actor — for an unlinked token that's its synthetic actor, and preferring
    // the world actor here would read the wrong gear/borg state and write saves to the prototype.
    const liveActor = tokDoc.actor ?? null;
    // Zone gate: protection gear installed in a destroyed cyberlimb zone is inert wreckage and must
    // not count toward the gas-save decision — the same enumeration every other contribution engine uses.
    const items = liveActor ? contributingItems(liveActor) : [];
    const d = { tokDoc, liveActor, ...gasSaveDecisionFor(items, stunSaveMod, { isFullBorg: isFullBorg(liveActor) }) };
    if (d.liveActor && !d.skip && d.percent > 0) {
      const gateRoll = await new Roll("1d10").evaluate();
      const gate = percentGateOutcome(d.percent, gateRoll.total);
      d.gateRoll = gateRoll.total;
      d.gateThreshold = gate.threshold;
      d.gated = gate.gated;
    }
    decisions.push(d);
  }
  const affected = decisions.filter(d => d.liveActor && !d.skip && !d.gated);
  // A full borg is sealed by its own biosystem, not by gear — report it as an immunity, separate
  // from the "sealed breathing gear" group, so the flavour is honest.
  const sealed = decisions.filter(d => d.liveActor && d.skip && !d.borgSealed);
  const borgSealed = decisions.filter(d => d.liveActor && d.skip && d.borgSealed);
  const gasNames = affected.map(d => `<b>${d.tokDoc.name}</b>`).join(", ");
  const gasPenalty = stunSaveMod < 0 ? localizeParam("GasCloudPenaltyClause", { mod: stunSaveMod }) : "";
  const sealedClause = sealed.length
    ? (affected.length ? " " : "") + localizeParam("GasCloudProtectedClause", { names: sealed.map(d => `<b>${d.tokDoc.name}</b>`).join(", ") })
    : "";
  const borgClause = borgSealed.length
    ? ((affected.length || sealed.length) ? " " : "") + localizeParam("GasCloudBorgImmuneClause", { names: borgSealed.map(d => `<b>${d.tokDoc.name}</b>`).join(", ") })
    : "";
  // Q8 clauses — one per rolled gate, held or failed, always naming the roll vs threshold.
  const gateClauses = decisions.filter(d => d.gateRoll !== undefined).map(d =>
    " " + localizeParam(d.gated ? "GasCloudFilterHeldClause" : "GasCloudFilterFailClause",
      { name: `<b>${d.tokDoc.name}</b>`, roll: d.gateRoll, threshold: d.gateThreshold })
  ).join("");
  await postSavePromptCard({
    title: localizeParam("GasCloudTurnTitle", { weapon: weaponName, turnsLeft }),
    body: (affected.length ? localizeParam("GasCloudTurnBody", { names: gasNames, penalty: gasPenalty }) : "") + sealedClause + borgClause + gateClauses,
  });
  for (const d of affected) {
    // Temporarily apply the (protection-offset) penalty via the taser additive-threshold path
    if (d.effMod < 0) {
      const existingState = d.liveActor.getFlag?.("cp2020-augmented", "taserState");
      const round = game?.combat?.round ?? 0;
      const count = existingState && (existingState.round === 0 || round <= existingState.round + 2)
        ? (existingState.count ?? 0) + 1 : 1;
      await d.liveActor.setFlag("cp2020-augmented", "taserState", { count, round, mod: d.effMod });
    }
    await postStunSavePrompt(d.liveActor, d.tokDoc);
  }
}

/** One per-turn adjudication pass over every gas cloud on the viewed scene, from TWO sources:
 *   1) NATIVE region clouds — Regions carrying an ENABLED `cp2020-augmented.gasCloud` behavior (the model
 *      since the region rework: the GM draws / reshapes / hides / removes them with Foundry's own tools, and
 *      the countdown lives on `behavior.system.turnsLeft`). Regions exist v12+, so this also lets a v13 GM
 *      hand-author a lingering cloud even though v13 spawns are templates.
 *   2) LEGACY flag clouds — areas tagged `flags.cp2020-augmented.isGasCloud` (v13 spawn templates, the
 *      vehicle-ordnance chemical clouds, and any pre-behavior cloud). A region that ALSO carries the
 *      behavior is owned by path 1 and skipped here so it is never adjudicated twice.
 *  Ungated by the round-tick master so both the per-turn hook (gated above) and the manual combat-tracker
 *  control run it; still respects the gas-cloud feature toggle. */
async function _runGasCloudTick(combat) {
  const gasEnabled = (() => { try { return game.settings.get("cp2020-augmented", "gasGrenadeCloudEnabled"); } catch { return true; } })();
  if (!gasEnabled) return;

  const scene = canvas?.scene;
  if (!scene) return;

  const autoMove = (() => { try { return game.settings.get("cp2020-augmented", "gasCloudAutoMove"); } catch { return false; } })();
  // Drift a cloud 2m in a random direction (wind) — shifts the template (v13) or region shape (v14). The
  // handle just needs { doc, isRegion } for moveArea; a native region cloud passes { doc: region, isRegion: true }.
  const drift = async (handle) => {
    const gridDist   = scene.grid?.distance ?? 1;
    const gridSizePx = scene.grid?.size ?? canvas?.grid?.size ?? 100;
    const movePx     = (2 / gridDist) * gridSizePx;
    const angle      = Math.random() * 2 * Math.PI;
    await moveArea(handle, Math.cos(angle) * movePx, Math.sin(angle) * movePx);
  };

  // 1) Native region clouds (behavior owns the countdown).
  for (const region of scene.regions ?? []) {
    const behavior = region.behaviors?.find((b) => !b.disabled && b.type === GAS_CLOUD_BEHAVIOR);
    if (!behavior) continue;
    const sys = behavior.system ?? {};
    const turnsLeft   = Number(sys.turnsLeft   ?? 0);
    const stunSaveMod = Number(sys.stunSaveMod ?? 0);
    const weaponName  = String(sys.weaponName ?? "").trim() || localize("WpnGasGrenade");

    if (turnsLeft <= 0) { await region.delete().catch(() => {}); continue; }

    // Tokens inside come from the region's native live `tokens` Set (Foundry maintains membership).
    await _adjudicateGasCloud({ turnsLeft, stunSaveMod, weaponName, tokenDocs: [...(region.tokens ?? [])] });

    await behavior.update({ "system.turnsLeft": turnsLeft - 1 }).catch(() => {});
    if (autoMove) await drift({ doc: region, isRegion: true });
    if (turnsLeft - 1 <= 0) {
      await region.delete().catch(() => {});
      await postSavePromptCard({ body: localizeParam("GasDispersedBody", { name: weaponName }) });
    }
  }

  // 2) Legacy flag clouds (back-compat: v13 templates, vehicle-ordnance clouds, pre-behavior regions).
  for (const cloud of areasByFlag(scene, "isGasCloud")) {
    if (cloud.doc?.behaviors?.some?.((b) => b.type === GAS_CLOUD_BEHAVIOR)) continue;   // owned by path 1
    const flags = cloud.doc.flags["cp2020-augmented"];
    const turnsLeft    = Number(flags.turnsLeft   ?? 0);
    const stunSaveMod  = Number(flags.stunSaveMod ?? 0);
    const weaponName   = flags.weaponName ?? localize("WpnGasGrenade");

    if (turnsLeft <= 0) {
      await deleteArea(cloud);
      continue;
    }

    // Tokens inside the cloud (shim: RegionDocument#testPoint on v14, shape.contains on v13).
    await _adjudicateGasCloud({ turnsLeft, stunSaveMod, weaponName, tokenDocs: tokensInArea(cloud, scene.tokens?.contents ?? []) });

    await cloud.doc.update({ ["flags.cp2020-augmented.turnsLeft"]: turnsLeft - 1 }).catch(() => {});
    if (autoMove) await drift(cloud);
    if (turnsLeft - 1 <= 0) {
      await deleteArea(cloud);
      await postSavePromptCard({
        body: localizeParam("GasDispersedBody", { name: weaponName }),
      });
    }
  }
}

/**
 * Manual round-tick control (GM-only). When the round-tick master (mechRoundTickEnabled) is OFF, the
 * per-turn hooks stand down, so this ⏭ control on the combat tracker lets the GM run one per-turn pass on
 * demand: the drug + consumable timers, this file's over-time (DOT/ablation/choke) tick, and the gas-cloud
 * adjudication. Placed on the active combatant's controls (or the first combatant before the encounter
 * starts) via the same renderCombatTracker idiom the aim/wait/dodge controls use.
 */
function _hookManualRoundTick() {
  Hooks.on("renderCombatTracker", (tracker, html) => {
    if (!game.user.isGM || mechRoundTickEnabled()) return;
    const combat = game.combat;
    if (!combat) return;
    const root = html instanceof jQuery ? html[0] : (Array.isArray(html) ? html[0] : html);
    if (!root) return;

    const combatant = combat.combatant ?? combat.combatants.contents[0];
    if (!combatant) return;
    const li = root.querySelector?.(`[data-combatant-id="${combatant.id}"]`);
    if (!li) return;
    li.querySelectorAll(".cp-manual-tick-btn").forEach(e => e.remove()); // idempotent across re-renders

    const controls = li.querySelector(".combatant-controls") ?? li.querySelector("menu") ?? li;
    const btn = document.createElement("a");
    btn.classList.add("cp-manual-tick-btn", "combatant-control");
    btn.title = localize("ManualRoundTickTitle");
    btn.innerHTML = "⏭";
    controls.prepend(btn);
  });
}

/** Run one manual per-turn pass for `combat` (the GM-only combat-tracker control, used when the round-tick
 *  master is off): drug + consumable timers, this file's over-time and gas-cloud ticks, and BOTH radiation
 *  passes (marker count-down + placed-zone dosing/aging) — all of which also stand down when the master is
 *  off. The timer exports are ungated inside; this path is reached only from the GM-only button. */
async function _runManualRoundTick(combat) {
  if (!combat || !game.user.isGM) return;
  const { runDrugTickOnce }         = await import("../mech/drug.js");
  const { runConsumableTickOnce }   = await import("../mech/consumable.js");
  const { runRadiationTickOnce }    = await import("../radiation/radiation.js");
  const { runRadZoneTick }          = await import("../radiation/radiation-zones.js");
  await runDrugTickOnce(combat);
  await runConsumableTickOnce(combat);
  await _runOverTimeTick(combat);
  await _runGasCloudTick(combat);
  await runRadiationTickOnce(combat);
  await runRadZoneTick(combat);
}

/**
 * The two save prompts a landed hit owes, on the two DIFFERENT cadences the printed rules give them
 * (CP2020 p.104, read off the text rather than inferred). This file used to run both on one clock —
 * once per damage event — and that is right for only one of them:
 *
 *   Stun/Shock — "Every time a character takes damage, he must make a save." A per-damage-event prompt
 *                is exactly the rule. Unchanged: every event that gets through still asks for one, AT
 *                EVERY WOUND LEVEL — including Mortal, where this flow used to ask for the death save
 *                alone and leave the consciousness question unasked (user ruling: "both"; the single-
 *                target rail has always posted the pair, save-rolls.js `postSavePrompts`, p.99).
 *   Death      — "Determining whether he survives requires that a Death Save be made, with a new save
 *                required every turn that the character remains untreated… Each turn, you must make
 *                another Death Save to see if you survive to the next turn." That is a PER-TURN
 *                cadence, not a per-hit one. A three-shell burst that dropped a figure to Mortal used
 *                to post three death prompts for one moment of the fight, and each was a separate roll
 *                the table had to resolve — three chances to die where the book gives one per turn.
 *
 * So a caller that applies several hits as ONE moment passes a `batch` set and the death prompt is
 * offered once for each body in it. The recurring per-turn prompt is not this function's job and is
 * already built: save-rolls.js posts one on every round/turn advance for a Mortal, unstabilized actor
 * (world setting `autoDeathSavePerTurn`), which is the cadence the book describes and the place the
 * "only way out is stabilization" reading is already honored.
 *
 * ⚠ The batch is keyed by TOKEN id, not actor id. An unlinked token's synthetic actor shares the world
 * actor's id (see the combat data hazards note), so an actor-keyed set would collapse two different
 * bodies onto one entry and silence a prompt the second body is owed. A caller that passes no batch
 * keeps the per-event behaviour, so every single-hit path through here is unchanged.
 */
export async function _postWoundSavePrompts(actor, tok, batch = null) {
  const ws = actor?.woundState?.() ?? 0;
  if (ws <= 0) return;
  if (ws < 4) { await postStunSavePrompt(actor, tok); return; }
  // ⭐ WHEN THE APPLICATION'S SEVERITY LEDGER OWNS THE MORTAL PROMPT, this rail posts only the stun
  // half. The ledger closes AFTER the last event of the application and offers the death save once, at
  // the tier the application FINISHED on (combat/severity-batch.js) — which is the whole point of the
  // batch cadence: the first shell of a corridor no longer fixes the tier the whole burst is judged at.
  // A caller that hands in the plain Set this rail used to take keeps the old once-per-body rule below,
  // so nothing that predates the ledger changes.
  if (severityBatchOwnsMortal(batch)) { await postStunSavePrompt(actor, tok); return; }
  // ⭐ AT MORTAL, BOTH — and that is a correction, not a new rule (user ruling: "both"). The single-
  // target rail has always posted the pair here (save-rolls.js `postSavePrompts`, on p.99's reading:
  // the stun save governs whether the body stays on its feet, the death save whether it survives at
  // all), while this one posted the death prompt alone — so a figure shot to Mortal by a pattern or a
  // blast was never asked whether it was still conscious. The two keep the DIFFERENT clocks the section
  // above sets out: the death prompt is offered once for the whole application batch, the stun prompt
  // once per damage event, exactly as it is below Mortal. Death goes first, in the single-target rail's
  // own order — the more urgent question is the one a reader should meet first.
  // ⭐ A STABILIZED PATIENT IS NOT ASKED TO SAVE AGAINST DYING — the read the single-target rail has
  // always made (save-rolls.js `postSavePrompts`) and the per-turn cadence makes before re-offering.
  // This rail did not make it, which was a genuine gap in the shape of the thing even though the two
  // rails cannot be told apart on the DAMAGE path today: `applyLocationDamage` clears stabilization the
  // moment fresh damage lands (Core p.105 — new damage restarts the death saves), so by the time either
  // rail reaches its own check the flag is already gone and both post. The check earns its keep for the
  // caller that prompts WITHOUT fresh damage, and for the day the p.105 clear grows a condition; what it
  // must never be is a place where this rail and the single-target one answer differently.
  // Consciousness is a separate question with a separate answer, so the stun prompt goes out either way.
  const body = tok?.document?.id ?? tok?.id ?? actor.id;
  const isStabilized = actor.getFlag?.("cp2020-augmented", "stabilized");
  const legacySet = (batch instanceof Set) ? batch : null;
  const deathOwed = !isStabilized && (!legacySet || !legacySet.has(body));
  if (deathOwed) {
    legacySet?.add(body);
    await postDeathSavePrompt(actor, tok);
  }
  await postStunSavePrompt(actor, tok);
}

/** Apply one area-effect hit to a token's actor through the normal pipeline (GM-side, direct).
 *
 * ⭐ THE LOAD'S PER-HIT RIDERS ARE APPLIED HERE TOO (2026-08-10), and they are the single-target flow's
 * own two calls rather than a second reading of the same rules: `updateTaserState` for a round that
 * delivers shock, `applyDotFromPayload` for one that starts a burn or an etch (_autoApply makes exactly
 * these two, in exactly this order — the taser flag has to be written BEFORE the prompt, because the
 * stun threshold reads it). Both are driven off the fields the CALLER passes, which for a pattern shell
 * is the spread flags and for a blast is the blast flags: a caller that never carried them passes
 * nothing, `stunSaveOnHit` is falsy and `dotEnabled` is falsy, and neither call does anything — so the
 * explosion path through this helper is unchanged by their arrival.
 * Once per landed shell per token, which is what the pattern flow already does with everything else it
 * applies (N shells = N banded rolls = N trips through the armour pipeline). */
async function _applyAreaHitToToken(tok, dmg, payload = {}, severityBatch = null) {
  const { ap, edged, mono, armorMultSoft, armorMultHard, penDamageMult, weaponName,
          stunSaveOnHit, stunSaveMod, dotEnabled, dotTurns, dotType, dotDamageFormula } = payload;
  if (!tok?.actor || dmg <= 0) return 0;
  const loc = (await rollLocation(tok.actor, null)).areaHit;
  // ⭐ THE IMPACT AUDIO, ONCE PER ROUND — NOT ONCE ON ARRIVAL AND AGAIN ON CONFIRM. When the pattern
  // flow owns this payload, the presentation rail sounds the figures the corridor caught at the moment
  // the shot ARRIVES; the apply that follows the GM's confirm would otherwise sound each of them a
  // second time, seconds later. The predicate pair is the rail's own, asked of the same payload
  // (fx/effects.js `patternFlowOwns` + the world FX switch), so the two halves cannot answer
  // differently: rail draws ⇒ apply is quiet, rail off ⇒ apply keeps the sound it has always made.
  // A blast's shells are NOT a pattern payload, so they are unaffected and still sound here.
  const railSounded = patternFlowOwns(payload) && combatFxEnabled();
  const hits = await applyAreaDamages({
    target:        tok.actor,
    areaDamages:   { [loc]: [{ damage: dmg }] },
    ap:            Boolean(ap),
    edged:         Boolean(edged),
    mono:          Boolean(mono),
    armorMultSoft: Number(armorMultSoft ?? 1),
    armorMultHard: Number(armorMultHard ?? 1),
    penDamageMult: Number(penDamageMult ?? 1),
    armorMode:     game.settings.get("cp2020-augmented", "damageArmorMode"),
    ablate:        game.settings.get("cp2020-augmented", "damageAblation"),
    dryRun:        false,
    fxSilent:      railSounded,
    // The application is WIDER than this shell — every shell of the burst, against every figure in the
    // corridor, shares the caller's ledger and the caller closes it.
    severityBatch: isSeverityBatch(severityBatch) ? severityBatch : null,
  });
  // The rider payload, in the shape both helpers read (save-rolls.js). Built from this call's own
  // arguments so nothing here has to know which flow handed them over.
  const rider = { stunSaveOnHit: Boolean(stunSaveOnHit), stunSaveMod: Number(stunSaveMod ?? 0),
                  dotEnabled: Boolean(dotEnabled), dotTurns: Number(dotTurns ?? 0),
                  dotType: String(dotType || "acid"), dotDamageFormula: String(dotDamageFormula || "1d6"),
                  weaponName: String(weaponName || "") };
  // A shock rider counts only where the round got through and did not land in a limb's own structure —
  // the same reading the single-target flow applies (RAW: no shock through a cyberlimb).
  if (rider.stunSaveOnHit && hits.some(h => h.penetrates && !h.cyberlimb)) {
    const taserEnabled = (() => { try { return game.settings.get("cp2020-augmented", "taserCumPenaltyEnabled"); } catch { return true; } })();
    if (taserEnabled) await updateTaserState(tok.actor, rider);
  }
  // DOT routes by dotType (fire -> HP burn, acid -> armor degradation); see save-rolls.js. The location
  // is this shell's own rolled one, which is what the single-target flow passes as well.
  await applyDotFromPayload(tok.actor, hits[0]?.location ?? loc, rider, hits.some(h => h.penetrates));
  const total = hits.reduce((s, h) => s + h.netDamage, 0);
  // The shell's own stun prompt is per damage event, as the book has it; the death prompt is offered
  // once per application batch when the caller named one (a burst of shells is one moment of the fight).
  if (total > 0) await _postWoundSavePrompts(tok.actor, tok, severityBatch);
  return total;
}

/**
 * ⏩ The wall-occlusion exemption now lives in `combat/area-shapes.js` (`areaOcclusionTest`) — moved
 * 2026-08-14 with the spread-geometry relocation so the presentation rail can ask the identical
 * question of a corridor's occupants without importing this file. Local alias keeps every call site.
 */
const _isOccluded = areaOcclusionTest;

/**
 * HEP concussion (Listen Up p.105): SP ignored, BTM applies, half of what gets through is
 * permanent HP and half is stun (a Stun Save is always prompted). Soft armor at the torso loses
 * 2 SP. Used by the explosion blast when Detailed Explosives is enabled.
 */
async function _applyConcussionToToken(tok, falloffDmg, { weaponName = localize("WpnExplosion") } = {}, severityBatch = null) {
  if (!tok?.actor || falloffDmg <= 0) return 0;
  const actor = tok.actor;
  const btm = Number(actor.system.stats?.bt?.modifier) || 0;
  const gotThrough = Math.max(1, falloffDmg - btm);          // SP ignored; BTM applies
  const permanent  = Math.max(1, Math.floor(gotThrough / 2)); // half permanent, half stun

  // Route through the shared seam so a full borg's Torso concussion hits its SDP (and can destroy the
  // biosystem) instead of the flesh wound track; flesh advances system.damage, loses stabilization,
  // and runs wound severity — all inside applyLocationDamage. BTM is already applied above (concussion
  // applies BTM even to machinery, Listen Up p.105), so pass the same permanent value as structural.
  // No impact sound, for the same reason the over-time tick above is silent: this is accumulated
  // damage becoming permanent, not a round arriving.
  const outcome = await applyLocationDamage({ target: actor, location: "Torso", netDamage: permanent, structuralDamage: permanent, penetrates: true, token: tok, fxSilent: true,
                                              severityBatch: isSeverityBatch(severityBatch) ? severityBatch : null });
  await ablateLocationByAmount(actor, "Torso", 2).catch(() => {}); // concussion wears soft armor −2 SP
  await postSavePromptCard({
    body: localizeParam("ConcussionBody", { name: actor.name, weapon: weaponName, permanent, gotThrough }),
    speaker: ChatMessage.getSpeaker({ actor }),
  });
  // Half the blow is stun/blunt → a consciousness check, but only for flesh: a cyberlimb/borg zone
  // that soaked the hit into SDP takes no stun (a destroyed core already ran its own death via the seam).
  if (!outcome.cyberlimb) await _postWoundSavePrompts(actor, tok, severityBatch);
  return permanent;
}

/**
 * Explosions & grenades (CP2020 p.108). Ammo whose effectTypes include "Explosive" detonates as an
 * area-effect blast: a circle of radius blastRadius centered on the target (or attacker), with
 * range-banded damage falloff outward (blastMultipliers). The GM repositions/confirms, then every
 * token in the blast takes damage through the normal pipeline. Mirrors gas-cloud + suppressive-confirm.
 */
function _hookExplosion() {
  const enabled = () => { try { return game.settings.get("cp2020-augmented", "explosivesEnabled"); } catch { return true; } };

  Hooks.on("cyberpunk2020.weaponFired", async (payload) => {
    if (!enabled()) return;
    if (!_effectTypesOf(payload).includes("Explosive")) return;
    // weaponFired fires only on the firing client; placing the blast needs the GM. The active GM
    // places it directly; anyone else (a player, or a non-active GM) relays to it. Mirrors
    // _hookSuppressiveFire. Without this a player's grenade produced no blast.
    if (game.users.activeGM?.id === game.user.id) await _placeExplosion(payload);
    else game.socket.emit("module.cp2020-augmented", { type: "explosionFired", payload });
  });
}

/** Place the explosion blast area + post its Confirm card. Runs on the active GM (direct or relay). */
async function _placeExplosion(payload) {
    const scene = canvas?.scene;
    if (!scene) return;

    const attackerId = payload.attackerId ?? payload.attackerActorId ?? payload.actorId ?? null;

    // Blast center: target token position, else attacker token.
    let cx = null, cy = null;
    if (payload.targetTokenId) {
      const tok = canvas?.tokens?.placeables?.find(t => t.id === payload.targetTokenId);
      if (tok) { cx = tok.center?.x ?? tok.x; cy = tok.center?.y ?? tok.y; }
    }
    if (cx === null) {
      // Nothing targeted — the blast is centred on the thrower's own figure, the one the payload names.
      const atk = _firingTokenOf(payload);
      if (atk) { cx = atk.center?.x ?? atk.x; cy = atk.center?.y ?? atk.y; }
    }
    if (cx === null) return;

    // Base blast damage = the rolled weapon damage carried in areaDamages.
    let baseDamage = 0;
    for (const hits of Object.values(payload.areaDamages ?? {})) {
      for (const h of (hits ?? [])) baseDamage += Number(h.damage ?? h.dmg) || 0;
    }
    const radius = Number(payload.blastRadius) || 0;
    if (baseDamage <= 0 || radius <= 0) return;

    const weaponName = payload.weaponName ?? localize("WpnExplosion");
    const fullWithin = Number(payload.blastFullDamageWithin ?? 1);
    // Create via the core-agnostic shim (MeasuredTemplate circle on v13, Region ellipse on v14).
    // originX/originY are stored in flags so _confirmExplosion can compute falloff distances even
    // on v14 where a Region has no top-level x/y.
    const handle = await createArea(scene, {
      kind: "circle", x: cx, y: cy, radiusM: radius,
      color: "#ff8800", borderColor: "#cc4400",
      flags: {
        isExplosion: true, baseDamage, blastRadius: radius, blastFullDamageWithin: fullWithin,
        blastMultipliers: Array.isArray(payload.blastMultipliers) ? payload.blastMultipliers : [0.5, 0.25, 0.125, 0.0625],
        attackerId, ap: Boolean(payload.ap), edged: Boolean(payload.edged), mono: Boolean(payload.mono),
        armorMultSoft: Number(payload.armorMultSoft ?? 1), armorMultHard: Number(payload.armorMultHard ?? 1),
        penDamageMult: Number(payload.penDamageMult ?? 1), blastShrapnel: Boolean(payload.blastShrapnel),
        weaponName, createdRound: game.combat?.round ?? 0,
        originX: cx, originY: cy,
      },
    });
    if (!handle?.doc) { console.warn("CP2020 | Explosion area creation failed"); return; }

    const explosionCard = await (foundry?.applications?.handlebars?.renderTemplate ?? renderTemplate)(
      "modules/cp2020-augmented/templates/chat/explosion-confirm.hbs",
      { weaponName, radius, baseDamage, fullWithin, templateId: handle.doc.id }
    );
    await ChatMessage.create({
      content: explosionCard,
      speaker: ChatMessage.getSpeaker({ actor: attackerId ? (game.actors.get(attackerId) ?? undefined) : undefined }),
    });
}

/** Detonate a confirmed blast: damage every token in the template with range-banded falloff. */
async function _confirmExplosion(templateId) {
  if (!canvas?.scene || !templateId) return;
  if (!_claimAreaConfirm("confirmExplosion", { templateId }, templateId)) return;
  const scene = canvas.scene;

  // Shim lookup: works on both v13 (MeasuredTemplate) and v14 (Region).
  const handle = areaById(scene, templateId);
  if (!handle) { ui.notifications.warn(localize("ExplosionTemplateNotFound")); return; }
  const f = handle.doc.flags?.["cp2020-augmented"];
  if (!f?.isExplosion) return;

  const gridSize = scene.grid?.size ?? canvas?.grid?.size ?? 100;
  const gridDist = scene.grid?.distance ?? 1;
  const fullR    = Number(f.blastFullDamageWithin) || 1;
  const radius   = Number(f.blastRadius) || 1;
  const mults    = Array.isArray(f.blastMultipliers) && f.blastMultipliers.length ? f.blastMultipliers : [0.5, 0.25, 0.125, 0.0625];
  const base     = Number(f.baseDamage) || 0;

  // Blast centre: stored as originX/originY in flags (v14 Regions have no top-level x/y).
  const originX  = Number(f.originX ?? handle.doc.x ?? 0);
  const originY  = Number(f.originY ?? handle.doc.y ?? 0);

  const detailed = (() => { try { return game.settings.get("cp2020-augmented", "explosivesDetailed"); } catch { return false; } })();

  // Token containment via shim; also apply cover check using origin from flags.
  const candidates = (scene.tokens?.contents ?? canvas.tokens.placeables.map(t => t.document ?? t))
    .filter(td => (td.actor ?? td.document?.actor));
  const inBlast = tokensInArea(handle, candidates);
  const tokens = inBlast.filter(td => {
    // td is a TokenDocument; _isOccluded expects the placeable object, so find it.
    const tok = canvas?.tokens?.placeables?.find(t => (t.document?.id ?? t.id) === (td.id ?? td.document?.id)) ?? td;
    return !_isOccluded(originX, originY, tok);   // cover between center and target exempts it
  });
  if (!tokens.length) { ui.notifications.info(localize("NoTokensInBlast")); return; }

  // One detonation is ONE application batch, which matters most on the detailed branch: the blow and the
  // fragments it throws are two applications on the same body at the same instant, and each used to post
  // its own card and its own death prompt. The ledger collects both and emits once per body
  // (combat/severity-batch.js), and it owns the wound-track prompt because this loop is the whole
  // application — nothing after it posts a tail of its own.
  const severity = makeSeverityBatch({ ownsWoundTrackPrompt: true });

  for (const td of tokens) {
    // Get pixel position from either a TokenDocument or a placeable.
    const tok = canvas?.tokens?.placeables?.find(t => (t.document?.id ?? t.id) === (td.id ?? td.document?.id)) ?? td;
    const dxPx = (tok.center?.x ?? tok.document?.x ?? tok.x ?? 0) - originX;
    const dyPx = (tok.center?.y ?? tok.document?.y ?? tok.y ?? 0) - originY;
    const distM = (Math.hypot(dxPx, dyPx) / gridSize) * gridDist;

    let mult = 1;
    if (distM > fullR) {
      const span = Math.max(0.0001, radius - fullR);
      const band = Math.min(mults.length - 1, Math.max(0, Math.floor(((distM - fullR) / span) * mults.length)));
      mult = Number(mults[band]) || 0;
    }
    const dmg = Math.max(0, Math.floor(base * mult));
    if (dmg <= 0) continue;

    if (detailed) {
      // HEP concussion (SP ignored, ½ permanent + ½ stun, soft armor −2). Optional shrapnel on top.
      await _applyConcussionToToken(tok, dmg, { weaponName: localizeParam("WpnVariantConcussion", { name: f.weaponName ?? localize("WpnExplosion") }) }, severity);
      if (f.blastShrapnel) {
        const shrap = await new Roll("1d10").evaluate();
        await _applyAreaHitToToken(tok, Math.max(0, Math.floor(shrap.total)),
          { ap: false, edged: false, mono: false, armorMultSoft: 1, armorMultHard: 1, penDamageMult: 1, weaponName: localizeParam("WpnVariantShrapnel", { name: f.weaponName ?? localize("WpnExplosion") }) },
          severity);
      }
    } else {
      // Core blast: range-banded damage through normal armor.
      await _applyAreaHitToToken(tok, dmg, { ...f, weaponName: localizeParam("WpnVariantBlast", { name: f.weaponName ?? localize("WpnExplosion") }) }, severity);
    }
  }

  // Every body the detonation touched, reported once: the progression card, then the one mortal prompt
  // at the tier the detonation finished on.
  await closeSeverityBatch(severity);
}

/**
 * THE GRENADE TABLE'S DIRECTION ROSE (CP2020 p.108) — a d10 face to a unit heading, and its name.
 *
 * ⏩ THE ROSE AND THE DRIFT NOW LIVE IN `combat/scatter-table.js` and are re-exported from here so every
 * reader (and every keeper) keeps the name it already had. They moved on 2026-08-13 because the
 * PRESENTATION rail needs them too — fx/effects.js draws the rounds toward the point this table
 * produces — and this file already imports effects, so effects cannot import back. See that file's
 * header for the full reasoning; nothing about the numbers changed.
 */
export { SCATTER_ROSE, scatterDriftM };

/** Scatter a missed grenade: Grenade Table (CP2020 p.108) — 1d10 direction + 1d10 metres. */
async function _scatterExplosion(templateId) {
  if (!canvas?.scene || !templateId) return;
  const scene = canvas.scene;

  // Shim lookup: works on both v13 (MeasuredTemplate) and v14 (Region).
  const handle = areaById(scene, templateId);
  if (!handle?.doc?.flags?.["cp2020-augmented"]?.isExplosion) { ui.notifications.warn(localize("BlastTemplateNotFound")); return; }

  const gridSize = scene.grid?.size ?? canvas?.grid?.size ?? 100;
  const gridDist = scene.grid?.distance ?? 1;

  const dirRoll  = await new Roll("1d10").evaluate();
  const distRoll = await new Roll("1d10").evaluate();
  // The rose and the arithmetic both come from the shared site above, so a missed throw and a missed
  // pattern travel the same way for the same face.
  const drift = scatterDriftM(dirRoll.total, distRoll.total);
  const distM = drift.distanceM;
  const dx = (drift.dxM / gridDist) * gridSize;
  const dy = (drift.dyM / gridDist) * gridSize;

  // Move via the shim (MeasuredTemplate.update on v13; shifts Region shape vertices on v14).
  await moveArea(handle, dx, dy);

  // Update the stored originX/originY flags so _confirmExplosion uses the new blast centre.
  const f = handle.doc.flags?.["cp2020-augmented"] ?? {};
  const newOriginX = (Number(f.originX) || 0) + dx;
  const newOriginY = (Number(f.originY) || 0) + dy;
  try {
    await handle.doc.setFlag("cp2020-augmented", "originX", newOriginX);
    await handle.doc.setFlag("cp2020-augmented", "originY", newOriginY);
  } catch { /* non-fatal */ }

  await postSavePromptCard({
    // The rose's name goes through tryLocalize at the render edge (the value-is-key convention), so a
    // world with no compass keys prints exactly the compass point it printed before.
    body: localizeParam("ScatterBody", { dir: tryLocalize(drift.name), drift: distM ? localizeParam("ScatterDrift", { dist: distM }) : localize("ScatterNoDrift") }),
  });
}

/**
 * How long an UNCONFIRMED pattern lives when no encounter is running, in wall-clock milliseconds.
 *
 * ⭐ WHY A CLOCK AND NOT JUST A ROUND. The round rule below is the honest one — a pattern belongs to
 * the shot that threw it, and the shot is over when its round is — but outside an encounter the round
 * NEVER ADVANCES, so a round-only rule expires nothing and every ignored shot leaves a region behind
 * forever. That is the litter defect this replaces: patterns accumulated on the scene one per shot,
 * with nothing on any path deleting them.
 *
 * 60 seconds is chosen against the one thing that must not happen: a pattern vanishing while the GM is
 * still looking at it. Out of combat there is no turn to hold, so the realistic window is "read the
 * card, drag the pattern, click Confirm" — comfortably under a minute — and a GM who takes longer has
 * the card still in chat and can fire again. The sweep runs on its own interval rather than on a
 * per-zone timer so a client that was closed mid-shot still cleans up on its next session.
 */
export const SPREAD_ZONE_TTL_MS = 60000;

/** How often the out-of-combat sweep looks. Well under the TTL, cheap enough to ignore (one filter). */
export const SPREAD_ZONE_SWEEP_MS = 15000;

/** The flow that owns a fired payload — the ONE place the damage rail asks the question, and it asks
 *  the same shared site (lookups.js `spreadFlowModeOf`) the presentation rail asks. That site folds the
 *  world switch into the answer, which is what keeps "pattern off" meaning "shells take the ordinary
 *  single-target route" rather than "shells are owned by nobody". */
function _spreadModeOf(payload) {
  return spreadFlowModeOf(payload);
}

/*
 * ⏩ THE PATTERN'S PURE GEOMETRY NOW LIVES IN `combat/spread-geometry.js` — declaredSpreadAim,
 * spreadAttackOutcome and scatteredSpreadCorridor moved 2026-08-14 (same idiom as the rose and the
 * drift above): the presentation rail must read the SAME corridor answers this flow plants by, and
 * it cannot import this file (this file imports the rail — the reverse edge is a cycle). Re-exported
 * from here so every existing runtime reader keeps working.
 */
export { declaredSpreadAim, spreadAttackOutcome, scatteredSpreadCorridor };

/**
 * Shotgun / flechette spread (CP2020 p.109). A shell throws a widening pattern: a ray from the attacker
 * toward the target, width by range band (Close/Med/Long — and the band edges are fractions of the
 * FIRING WEAPON'S OWN range, p.99), with range-banded damage (ammo override, else Core 4d6/3d6/2d6).
 * Everyone in the straight path is hit (no evasion). The GM aims and confirms, mirroring suppressive fire.
 *
 * ⭐ WHAT MAKES A SHOT A PATTERN IS THE CARTRIDGE, NOT A FLAG (spreadModeForAmmo, lookups.js). The
 * shotgun is an area weapon in the Core rules, so buckshot patterns because of what it is; the ONE
 * shotgun load that does not is the slug, which says so on the load. Deriving it here rather than
 * reading the stored `spreadMode` is what lets a world's existing, untouched buckshot fire the book
 * pattern on its next shot — every shotgun ammo item ever seeded carries `spreadMode: "single"`.
 */
function _hookSpread() {
  Hooks.on("cyberpunk2020.weaponFired", async (payload) => {
    // ⚠ THE WORLD SWITCH IS NOT READ HERE. It is folded into the shared answer (lookups.js
    // `spreadFlowModeOf`), so switching the pattern off resolves a shell to "single" for BOTH gates at
    // once and the single-target flow picks it up. Reading the setting separately here is exactly the
    // defect that fix removed: this hook stood down for the setting while the gate above stood down for
    // the cartridge, and the payload fell between them — no window, no pattern, no damage.
    if (_spreadModeOf(payload) === SPREAD_MODE_SINGLE) return;
    // weaponFired fires only on the firing client; placing the pattern needs the GM. The active GM
    // places it directly; anyone else (a player, or a non-active GM) relays to it. Mirrors
    // _hookSuppressiveFire. Without this a player's shotgun produced no spread.
    if (game.users.activeGM?.id === game.user.id) await _placeSpreadZone(payload);
    else game.socket.emit("module.cp2020-augmented", { type: "spreadFired", payload });
  });
}

/**
 * Half the width, in metres, of whatever figure is standing on a point — 0 when the point is bare ground.
 *
 * ⭐ THE OVERSHOOT RULE, third reader. A corridor that ends exactly on a figure's centre puts that
 * centre ON the polygon's end edge, so whether it is inside its own pattern comes down to a
 * floating-point comparison — reproduced on the rig, where a three-shell burst resolved against a
 * bystander and missed the figure that was aimed at. Half the figure's own width is the smallest
 * overshoot that settles it and it costs no other square, because the extra reach lies inside the
 * square that figure already occupies. The aim gesture applies it at the confirm
 * (combat/spread-placement.js `_tokenAtPoint`) and the undeclared fallback applies it to the aimed-at
 * token; a SCATTERED centre needs it too, and for exactly the same reason.
 */
function _halfTokenWidthAtM(scene, x, y, gridSize) {
  for (const t of canvas?.tokens?.placeables ?? []) {
    const b = t.bounds ?? null;
    const left = b ? b.x : t.x, top = b ? b.y : t.y;
    const w = b ? b.width : (t.w ?? 0), h = b ? b.height : (t.h ?? 0);
    if (x >= left && x <= left + w && y >= top && y <= top + h) {
      return pixelsToMeters(scene, gridSize) * ((Number(t.document?.width ?? t.width) || 1) / 2);
    }
  }
  return 0;
}

/** Place the shotgun/flechette spread pattern + post its Confirm card. Runs on the active GM.
 *  Exported for the keeper, which drives placement and confirmation as the two halves they are. */
export async function _placeSpreadZone(payload) {
    const scene = canvas?.scene;
    if (!scene) return;

    const attackerId = payload.attackerId ?? payload.attackerActorId ?? payload.actorId ?? null;
    // The corridor's ORIGIN, and it must be the figure that actually fired — the corridor is rebuilt
    // here as an angle and a length from this point, so a wrong origin translates the whole polygon
    // away from the ghost the shooter drew. _firingTokenOf reads the id the aim itself used
    // (actor-sheet.js firingTokenIdOf → payload.attackerTokenId) before falling back to an actor scan.
    const atk = _firingTokenOf(payload);
    if (!atk) {
      ui.notifications.warn(localize("SpreadFireNoToken"));
      return;
    }
    const ox = atk.center?.x ?? atk.x, oy = atk.center?.y ?? atk.y;
    const gridSize = scene.grid?.size ?? canvas?.grid?.size ?? 100;

    // ⭐ THE SHOOTER'S OWN DECLARED CORRIDOR COMES FIRST (2026-08-11). A spread weapon fired from the
    // sheet is AIMED before it is declared — the shooter drags the corridor, confirms it, and only then
    // sees the modifiers window — so by the time this runs the angle, the reach and the band are facts
    // the shooter stated rather than an axis this function guessed from whoever happened to be targeted.
    // See combat/spread-placement.js for the gesture and seam-shim.js for how it rides the payload.
    //
    // The origin is taken from the figure AS IT STANDS NOW, not from the aim record, so the corridor,
    // the rounds the rail draws and the cover ray all leave the same point even if the figure was
    // nudged between the aim and the roll. Everything else is the shooter's.
    const declared = declaredSpreadAim(payload);
    const widths = {
      short: payload.spreadWidthShort, medium: payload.spreadWidthMedium, long: payload.spreadWidthLong,
    };
    // ⭐ THE FIRING WEAPON'S OWN RANGE, because the band edges are FRACTIONS OF IT (Core p.99: Close is a
    // quarter of the weapon's Long range, Medium a half, Long the full range) and the shotgun table
    // (p.109) prints its pattern against those bands. Carried on the payload from the seam, beside the
    // load's own widths, so the aim preview, this plant and the presentation rail all measure the same
    // aim point against the same ladder. Absent on a payload assembled before the field existed, or on
    // a weapon with no range recorded — the ladder falls back to its compat edges (lookups.js).
    const rangeM = payload.spreadRangeM;
    let band, lengthM, widthM, angleDeg;
    // What the roll said, and — when it said MISS — where the shell actually went. Both stay null on
    // an undeclared corridor and on a payload that carries no roll, and the card prints neither.
    let outcome = null, scatter = null;
    if (declared) {
      angleDeg = declared.angleDeg;
      lengthM = declared.lengthM;
      widthM = declared.widthM;
      band = declared.band;

      // ⭐ A DECLARED CORRIDOR IS STILL A SHOT THAT CAN MISS (2026-08-13, user ruling; CP2020 p.108:
      // *"Attacks are made as with other ranged weapons… If the target is missed, the true center of
      // the attack must be determined"*). Until now the aim WAS the outcome — the corridor resolved
      // exactly where it was pointed and the attack roll the base system had already made was thrown
      // away. Now the base's own verdict decides (spreadAttackOutcome: nothing is rolled here, the
      // roll and its DC ride the payload), and a miss sends the pattern to the grenade table.
      //
      // The MUZZLE does not move — the shell left the same barrel — so only the far end is re-aimed
      // and the corridor is rebuilt from the shooter as they stand to wherever the shell landed.
      outcome = spreadAttackOutcome(payload);
      if (outcome && !outcome.hit) {
        // ⭐⭐ THE DICE ARE THE PAYLOAD'S, NOT THIS FUNCTION'S (2026-08-13). This runs on the ACTIVE GM,
        // which on a player's shot — and on a shot by any GM who does not hold that seat — is a
        // DIFFERENT CLIENT from the one that drew the rounds. The presentation had already resolved its
        // axis toward the point the shooter aimed at by the time this ran, so rolling here produced a
        // second, unrelated answer: on a miss the rounds flew one way and the pattern landed another,
        // in front of the table, every time. Rolling once at the seam where the payload is assembled
        // (seam-shim.js) and carrying the RESULTS means both rails read the same two faces. Results,
        // not a seed — results are data and need no shared generator across clients.
        //
        // ⏪ THE FALLBACK IS FOR PAYLOADS THAT PREDATE THE CARRIED FIELDS, and it is not dead code: a
        // client still on the older build mid-update relays one, a macro or a keeper can call this
        // directly, and on the fork the seam shim is dormant so nothing stamps them. Those shots
        // scatter exactly as they did before — correctly placed, merely un-followed by the rounds.
        const carried = payload?.spreadScatter ?? null;
        const dirFace = Number(carried?.dirFace);
        const distFace = Number(carried?.distFace);
        const haveCarried = Number.isFinite(dirFace) && Number.isFinite(distFace);
        const dirTotal = haveCarried ? dirFace : (await new Roll("1d10").evaluate()).total;
        const distTotal = haveCarried ? distFace : (await new Roll("1d10").evaluate()).total;
        const ppm = metersToPixels(scene, 1) || 1;
        // The scattered centre earns its own overshoot from whatever is standing there NOW, by the same
        // rule the aim gesture and the undeclared fallback both apply (see _tokenAtPoint's note): a
        // corridor that ends exactly on a figure's centre leaves that figure balanced on the polygon's
        // end edge. The aim's own overshoot is not carried over — it belonged to the figure that WAS
        // aimed at, and after a scatter that is usually not who is standing there.
        // The geometry answers first (it is pure and needs no canvas), then the overshoot is measured
        // against the point it landed on and folded into the reach — which is why the reach is the
        // thing this file adjusts and the corridor's own numbers are left exactly as derived.
        const landed = scatteredSpreadCorridor({
          originX: ox, originY: oy, declared, widths, rangeM, pixelsPerMeter: ppm,
          sceneRect: canvas?.dimensions?.sceneRect ?? null,
          dirFace: dirTotal, distFace: distTotal,
        });
        const overshootM = _halfTokenWidthAtM(scene, landed.aimX, landed.aimY, gridSize);
        scatter = { ...landed, lengthM: Math.max(SPREAD_MIN_LENGTH_M, landed.reachM + overshootM) };
        angleDeg = scatter.angleDeg;
        lengthM = scatter.lengthM;
        widthM = scatter.widthM;
        band = scatter.band;
      }
    } else {
      // ⏪ THE UNDECLARED FALLBACK — what every shot did before the gesture existed, kept because a
      // shell can still be fired by something that never armed it (a macro, a keeper driving the roll
      // directly, a future entry point). Direction + range band toward the target; with NOTHING targeted
      // the pattern is thrown along the shooter's OWN FACING rather than due east, because a token's
      // rotation is the only statement of "which way" an untargeted shot leaves behind and the
      // presentation rail answers the same question the same way (fx/effects.js facingRad). The band
      // stays Medium because an untargeted shot names no distance to measure.
      lengthM = 10;
      angleDeg = Math.round(((Number(atk.document?.rotation ?? atk.rotation) || 0) + 90) % 360);
      let distM = null;
      const tgt = payload.targetTokenId ? canvas?.tokens?.placeables?.find(t => t.id === payload.targetTokenId) : null;
      if (tgt) {
        const tx = tgt.center?.x ?? tgt.x, ty = tgt.center?.y ?? tgt.y;
        angleDeg = Math.round(Math.atan2(ty - oy, tx - ox) * 180 / Math.PI);
        distM = pixelsToMeters(scene, Math.hypot(tx - ox, ty - oy));
        // ⭐ THE PATTERN REACHES THE FAR EDGE OF THE TARGET'S OWN SQUARE, not its centre point. Ending
        // the ray exactly at the aimed-at centre put that centre ON the polygon's end edge, so whether
        // the token the shooter aimed at was inside its own pattern came down to a floating-point
        // comparison — reproduced on the rig, where a three-shell burst resolved against a bystander
        // and missed the target entirely. Half the target's own width is the smallest overshoot that
        // makes the aimed-at token unambiguously inside, and it costs no other square: the extra reach
        // is inside the square the target already occupies. (The aim gesture applies the same rule.)
        const halfTargetM = pixelsToMeters(scene, gridSize) * ((Number(tgt.document?.width ?? tgt.width) || 1) / 2);
        lengthM = Math.max(2, distM + halfTargetM);
      }
      // The band ladder and the per-load widths come from the ONE shared derivation the aim preview
      // reads, so a declared corridor and a guessed one cannot be two different shapes of the same rule.
      // With no target there is no distance to measure, and `null` is what resolves to the Medium band.
      const spec = spreadBandSpec(distM === null ? 10 : distM, widths, rangeM);
      band = spec.band;
      widthM = spec.widthM;
    }
    const dmgFormula = spreadBandDamage(band, {
      short: payload.spreadDamageShort, medium: payload.spreadDamageMedium, long: payload.spreadDamageLong,
    });

    // ⭐ ONE PATTERN, N SHELLS. No autoshotgun rule exists in the Core read, so RAW is that each shell
    // fires its own pattern — and N patterns aimed identically ARE one pattern resolved N times. The
    // burst therefore places ONE region and one resolution rolls the shells, which is the whole of the
    // "per-shell mechanics, one card" ruling: the mechanics stay per shell (N banded rolls per token
    // below), only the aiming and the resolving collapse. shotsFired is absent on cards that don't set
    // it. Unchanged by the placement-forward gesture: one aim is still one pattern, however many shells
    // ride it.
    const shells = Math.max(1, Math.floor(Number(payload.shotsFired) || 1));

    const weaponName = payload.weaponName ?? localize("WpnShotgun");
    // Create via the core-agnostic shim (MeasuredTemplate ray on v13, Region polygon on v14).
    // Visibility is the shim's GAMEMASTER default (buildAreaData). It stays that way for both corridors:
    // an UNDECLARED one is an aiming aid nobody has committed to, so the table must not watch it hover
    // over their tokens; a DECLARED one was already shown to the shooter who drew it (as a client-local
    // ghost, in combat/spread-placement.js) and lives on the canvas only for the length of the shot.
    const handle = await createArea(scene, {
      kind: "ray",
      x: ox, y: oy, dirDeg: angleDeg, lengthM, widthM,
      color: SPREAD_ZONE_LOOK.fillColor, borderColor: SPREAD_ZONE_LOOK.outlineColor,
      flags: {
        isSpreadZone: true, dmgFormula, band, attackerId, originX: ox, originY: oy, shells,
        // ⭐ THE PATTERN'S OWN GEOMETRY, recorded because the pattern OUTLIVES the payload that threw
        // it: the fires a burning load leaves are placed when the GM CONFIRMS (fx/effects.js
        // fxPatternGroundFire), by which point the payload is gone and the region carries no direction
        // or reach of its own that both cores agree on. Three numbers and the load's presentation key,
        // written where every other fact about this pattern is already written. Presentation only — no
        // damage path reads any of them.
        dirDeg: angleDeg, lengthM, widthM, ammoKey: ammoFxKeyOf(payload),
        // ⭐ WHICH FLOW OWNS THIS CORRIDOR, recorded for the same reason the geometry is: the pattern
        // OUTLIVES the payload, and at confirm time the apply has to ask the rail's own question —
        // "did the presentation already sound these figures at arrival?" — of something. The stored
        // answer is the one shared derivation (lookups.js spreadFlowModeOf), so the confirm cannot
        // answer differently from the placement that put the corridor there. A corridor placed before
        // this field existed simply answers "single" and its apply sounds as it always did.
        spreadMode: _spreadModeOf(payload),
        ap: Boolean(payload.ap), edged: Boolean(payload.edged), mono: Boolean(payload.mono),
        armorMultSoft: Number(payload.armorMultSoft ?? 1), armorMultHard: Number(payload.armorMultHard ?? 1),
        penDamageMult: Number(payload.penDamageMult ?? 1), weaponName, createdRound: game.combat?.round ?? 0,
        // ⭐ THE LOAD'S PER-HIT RIDERS TRAVEL WITH THE PATTERN (2026-08-10). The flags above are the
        // ARMOUR half of what a load does; these are the other half — the shock a stun round delivers
        // and the burn an incendiary one starts. They were left out while only flechette threw a
        // pattern (that load has no riders), and the moment RAW buckshot joined the pattern flow every
        // 00 shell carrying them lost them: a stundart shell's −2 and an api shell's ignition simply
        // stopped happening, because the pattern outlives the payload and the region carried no record
        // of either. Written here, where every other fact about this pattern is written, and honored
        // per landed shell in _applyAreaHitToToken — the same two calls the single-target flow makes,
        // in the same order (the taser flag before the prompt that reads it).
        // Same defensive coercion as the fields above, so a payload missing any of them stores the
        // "does nothing" value rather than undefined.
        stunSaveOnHit: Boolean(payload.stunSaveOnHit), stunSaveMod: Number(payload.stunSaveMod ?? 0),
        dotEnabled: Boolean(payload.dotEnabled), dotTurns: Number(payload.dotTurns ?? 0),
        dotType: String(payload.dotType || "acid"), dotDamageFormula: String(payload.dotDamageFormula || "1d6"),
        // Recorded with them because it is the same contract (seam-shim AMMO_EFFECT_FIELDS) and a
        // pattern that carries five of a load's six statements is a pattern nobody can read back. No
        // damage path in this flow consults it today — the explosive branch is a different flow, and it
        // is gated before a pattern is ever placed.
        effectTypes: Array.isArray(payload.effectTypes) ? [...payload.effectTypes] : [],
        // ⭐ WHICH CLOCK OWNS THIS PATTERN, decided once, at the moment it is thrown. A pattern thrown
        // during an encounter belongs to that encounter's rounds; one thrown outside any encounter has
        // no round to wait for and belongs to the wall clock. Asking the question later — "is a combat
        // running now?" — gets it wrong in both directions: a pattern thrown out of combat became
        // immortal the moment somebody rolled initiative, and a pattern thrown in combat was swept off
        // the table by the clock if its own round happened to run long. The id also survives the
        // encounter being deleted, which is what lets the sweep collect a pattern whose combat is gone.
        combatId: (game.combats?.active?.started ? game.combats.active.id : "") ?? "",
        // The wall clock the out-of-combat sweep reads. Written at creation because a region carries no
        // creation time of its own that survives a reload.
        createdAt: Date.now(),
        // WHOSE CORRIDOR THIS IS — the shooter's, or this function's. It decides who ends the shot (see
        // below), and it is recorded rather than re-derived because the payload does not outlive the
        // plant and a reader of the region has no other way to tell the two apart.
        declaredAim: !!declared,
        // WHETHER THIS CORRIDOR IS WHERE IT WAS AIMED. Recorded for the same reason `declaredAim` is —
        // the payload does not outlive the plant, and a reader of the region (or a keeper reading it
        // back) has no other way to tell a corridor the shooter placed from one the grenade table did.
        // Presentation and diagnosis only; no damage path branches on it, because a scattered pattern
        // hurts whoever is standing in it exactly as an aimed one does.
        scattered: !!scatter,
        scatterDirFace: scatter ? scatter.dirFace : 0,
        scatterDriftM: scatter ? scatter.driftM : 0,
      },
    });
    if (!handle?.doc) { console.warn("CP2020 | Spread area creation failed"); return; }

    // ⭐ THE APPLY MOMENT IS A MOMENT SOMEBODY TAKES (2026-08-13, user ruling). A declared corridor used
    // to resolve ITSELF here — the shot's presentation ended and the damage simply landed, with nobody
    // left to press anything. That removed the one beat at which a reader can look at who the corridor
    // caught and decide. The corridor stays the shooter's (it was aimed and confirmed before the roll);
    // what comes back is the APPLY, on a card, at the end of the shot rather than over the top of it.
    //
    // So both corridors now end in a card, and the difference between them is only WHAT the card is
    // asking and WHEN it arrives:
    //   declared   — the shooter already aimed it, so the card is posted once the shot has finished
    //                being presented, lists who is standing in the corridor, and asks for the apply.
    //   undeclared — nobody aimed it, so the card is posted at once and asks the reader to look at a
    //                corridor this function GUESSED before it resolves.
    // Both carry the same `.cp-confirm-spread-zone` button, so ONE dispatch resolves either of them
    // (see registerDamageHooks) and neither can be resolved twice (card-lock.js).
    //
    // The wait is the rail's own completion signal, the same one the single-target window waits out
    // (fx/effects.js presentationSettled) — the signal on the client that drew the shot, and the honest
    // arithmetic floor on a client that did not (a player's shot relayed here, where no fan-out ran).
    // Nothing is held open by it: the cap inside presentationSettled bounds the wait either way.
    const speaker = ChatMessage.getSpeaker({ actor: attackerId ? (game.actors.get(attackerId) ?? undefined) : undefined });
    if (declared) {
      await presentationSettled(payload);
      // The region is still on the scene and stays there until the card is resolved — the reader is
      // being asked about a corridor they can see, and NEITHER expiry clock will take it away from
      // them while the card is unresolved (_spreadZoneCardPending). A pattern nobody has dealt with is
      // a decision still owed, not litter; the two ways it ends are the card's two buttons.
      await _postSpreadResolutionCard(handle, { weaponName, band, widthM, dmgFormula, shells, speaker, outcome, scatter });
      return;
    }

    const spreadCard = await renderChatCard("spread-confirm.hbs",
      { weaponName, band, widthM, dmgFormula, shells, multiShell: shells > 1, templateId: handle.doc.id });
    const message = await ChatMessage.create({ content: spreadCard, speaker });
    await _stampPatternCardId(handle, message);
}

/**
 * TIE THE PATTERN TO ITS CARD — the one write that turns the two documents into one shot.
 *
 * Recorded on the REGION rather than derived later because nothing else relates them: the card names
 * the pattern (data-template-id) but the pattern had no way back, so every reader of a pattern — the
 * two expiry clocks, the delete hook — had to guess whether somebody was still looking at a card about
 * it. With the id written here they can simply ask. Written after the card is created because that is
 * when the id exists; the window between the two is one round trip in which the clocks would answer
 * "no card" and behave exactly as they did before this existed, which is the safe answer.
 *
 * Never throws: a failed stamp costs the pattern its lifecycle protection (it falls back to the old
 * clock behaviour), not the shot.
 */
async function _stampPatternCardId(handle, message) {
  const id = message?.id;
  if (!handle?.doc || !id) return;
  try { await handle.doc.setFlag("cp2020-augmented", "cardMessageId", id); }
  catch (err) { console.warn("CP2020 | could not record the pattern's card id on the pattern", err); }
}

/**
 * Who is standing in a placed pattern right now, and who cover exempts — ONE reader, so the card a
 * reader is looking at and the resolution the button runs cannot disagree about the same corridor.
 *
 * Reads only; no document is written here, which is what lets the resolution card be built from it on
 * the presentation path. The attacker is never their own target, and cover between the pattern's origin
 * and a space exempts that space (CP2020 p.108) — the same two rules the resolution applied inline
 * before this was lifted out of it.
 *
 * Returns placeables where the scene has them and the token documents otherwise, which is what both
 * callers already coped with.
 */
function _spreadPatternOccupants(handle) {
  const scene = canvas?.scene;
  const f = handle?.doc?.flags?.["cp2020-augmented"] ?? {};
  // Origin for cover checks: stored as originX/originY in flags at creation, with a doc.x/y
  // fallback for legacy zones (v14 Regions have no top-level x/y).
  const originX = Number(f.originX ?? handle?.doc?.x ?? 0);
  const originY = Number(f.originY ?? handle?.doc?.y ?? 0);
  const candidates = (scene?.tokens?.contents ?? canvas?.tokens?.placeables?.map(t => t.document ?? t) ?? [])
    .filter(td => (td.actor ?? td.document?.actor) && (td.actor?.id ?? td.document?.actor?.id) !== f.attackerId);
  const exposed = [], covered = [];
  for (const td of tokensInArea(handle, candidates)) {
    const tok = canvas?.tokens?.placeables?.find(t => (t.document?.id ?? t.id) === (td.id ?? td.document?.id)) ?? td;
    (_isOccluded(originX, originY, tok) ? covered : exposed).push(tok);
  }
  return { originX, originY, exposed, covered };
}

/** The name a pattern card prints for one figure, from a placeable or a bare token document. */
function _spreadRowName(tok) {
  return tok?.name ?? tok?.document?.name ?? "?";
}

/**
 * The pattern's RESOLUTION CARD: what the corridor caught, and one button that applies it.
 *
 * Posted for a DECLARED corridor once the shot has finished being presented. It states the corridor's
 * own terms (band, width, the banded formula, how many shells ride it), then one row per figure the
 * corridor contains — each row saying whether that figure is IN the pattern or exempted by cover — and
 * the p.109 basis the rows rest on: everyone in the pattern takes the banded damage and nobody is rolled
 * against individually. The button is the same `.cp-confirm-spread-zone` the guessed-corridor card
 * carries, so it runs the same resolution through the same dispatch and the same GM relay.
 *
 * The rows are a SNAPSHOT of the moment the card is posted; the resolution re-reads the corridor when
 * the button is pressed, so a figure who walks in or out between the two is resolved as it stands then.
 * That is deliberate — the region is on the table for exactly that reason.
 */
async function _postSpreadResolutionCard(handle, { weaponName, band, widthM, dmgFormula, shells, speaker, outcome = null, scatter = null }) {
  const { exposed, covered } = _spreadPatternOccupants(handle);
  // Status is assembled in JS and passed as a localized param (the GasCloudPenaltyClause pattern), so the
  // template stays one declarative row shape rather than branching per figure.
  const rows = [
    ...exposed.map(t => ({ name: _spreadRowName(t), status: localize("SpreadRowInPattern") })),
    ...covered.map(t => ({ name: _spreadRowName(t), status: localize("SpreadRowCovered") })),
  ];
  // ⭐ THE ROLL LINE, and the scatter under it when there is one. Assembled here as PRE-LOCALIZED
  // strings rather than as branches in the template (the GasCloudPenaltyClause pattern), so the card
  // stays two declarative optional lines and the verdict's own colour lives inside its i18n value —
  // the IndirectOnTarget idiom this module already uses for HIT/MISS wording.
  //
  // Both are absent — and the card is byte-identical to the one that shipped before — whenever the
  // payload carried no roll: a macro, a keeper's own placement leg, or any entry point that never went
  // through the base system's fire methods.
  const rollLine = outcome
    ? localizeParam("SpreadRollLine", {
        total: outcome.total, dc: outcome.dc,
        verdict: localize(outcome.hit ? "SpreadRollHit" : "SpreadRollMiss"),
      })
    : "";
  const scatterLine = scatter
    ? (scatter.driftM > 0
        ? localizeParam("SpreadScatterLine", { dir: tryLocalize(scatter.dirName), dist: scatter.driftM })
        : localize("SpreadScatterNoDrift"))
    : "";
  const content = await renderChatCard("spread-resolution.hbs", {
    weaponName, band, widthM, dmgFormula, shells, multiShell: shells > 1,
    templateId: handle.doc.id, rows, anyRows: rows.length > 0,
    rollLine, scatterLine,
  });
  const message = await ChatMessage.create({ content, speaker });
  await _stampPatternCardId(handle, message);
}

/**
 * Apply spread damage to every token in the confirmed pattern (no evasion — buckshot just hits), then
 * DELETE the pattern. The delete is the user's "confirm, then vanish" ruling and it runs on every exit
 * from here that got as far as a real pattern, including the one where nothing was inside it: a
 * resolved shot must not leave an aiming aid on the table either way.
 */
export async function _confirmSpreadZone(templateId) {
  if (!canvas?.scene || !templateId) return;
  if (!_claimAreaConfirm("confirmSpreadZone", { templateId }, templateId)) return;
  const scene = canvas.scene;

  // Shim lookup: works on both v13 (MeasuredTemplate) and v14 (Region).
  //
  // ⚠ THIS WARN IS A LAST-RESORT GUARD, not a path normal play reaches any more. It used to be the
  // dead end an expiry clock produced: the pattern was collected out from under an unresolved card and
  // the button then had nothing to resolve. Both clocks now skip a pattern whose card is unresolved,
  // and a pattern deleted by hand flips its card to cleared before the button can be pressed, so the
  // only ways to arrive here are a lost delete hook or a card resurrected by the GM re-arm control.
  const handle = areaById(scene, templateId);
  if (!handle) { ui.notifications.warn(localize("SpreadTemplateNotFound")); return; }
  const f = handle.doc.flags?.["cp2020-augmented"];
  if (!f?.isSpreadZone) return;

  // THE SHOT IS DEALT WITH FROM HERE ON — stamped before any of the work below, for two readers. The
  // delete at the end of this function fires the same delete hook a HAND deletion does, and that hook
  // must be able to tell "the GM removed an unresolved pattern" (flip its card to cleared) from "the
  // apply removed the pattern it just resolved" (leave it alone). And a resolution runs several awaits
  // long, during which the clocks would otherwise still see an unresolved card.
  // Idempotent: the click dispatch stamps the same flag from the clicking client, and this stamp also
  // covers the RELAYED press, where that client's stamp is the only other one.
  await _markPatternCardResolved(f.cardMessageId, "spreadApply");

  const shells = Math.max(1, Math.floor(Number(f.shells) || 1));

  // Who the corridor caught, read through the SAME reader the resolution card was built from, so the
  // rows a reader pressed the button on and the figures this loop resolves against are one answer to
  // one question (containment, minus the attacker, minus whatever cover exempts).
  const { originX, originY, exposed: tokens } = _spreadPatternOccupants(handle);

  const weaponName = localizeParam("WpnVariantSpread", { name: f.weaponName ?? localize("WpnShotgun") });
  // ONE APPLICATION BATCH: every shell of this burst, against every figure in the corridor, is one
  // moment of the fight. The ledger collects each figure's severity steps and zone outcomes and emits
  // once per figure — one progression card, one mortal prompt at the tier the burst finished on (see
  // combat/severity-batch.js, and _postWoundSavePrompts for why a burst owes at most one).
  const severity = makeSeverityBatch({ ownsWoundTrackPrompt: true });
  const rows = [];
  for (const tok of tokens) {
    // ⭐ N ROLLS, NOT ONE ROLL APPLIED N TIMES. Each shell is its own discharge of shot, so each gets
    // its own banded roll and its own trip through the armour pipeline — which is a different number
    // from N × one roll the moment armour is in the way, because SP is subtracted per hit.
    const shots = [];
    for (let i = 0; i < shells; i++) {
      const dmgRoll = await new Roll(f.dmgFormula || "3d6").evaluate();
      const dmg = Math.max(0, Math.floor(dmgRoll.total));
      shots.push(dmg);
      await _applyAreaHitToToken(tok, dmg, { ...f, weaponName }, severity);
    }
    rows.push({ name: _spreadRowName(tok), rolls: shots.join(", "), total: shots.reduce((s, n) => s + n, 0) });
  }

  // Closed before the resolution card so the per-figure progression cards sit next to the numbers that
  // produced them rather than after the burst's own summary.
  await closeSeverityBatch(severity);

  // ONE resolution card for the whole burst, so N shells are readable as N numbers rather than as N
  // separate cards. Posted before the delete so a reader still has the pattern on screen as it lands.
  if (rows.length) {
    const resultCard = await (foundry?.applications?.handlebars?.renderTemplate ?? renderTemplate)(
      "modules/cp2020-augmented/templates/chat/spread-result.hbs",
      { weaponName: f.weaponName ?? localize("WpnShotgun"), band: f.band, shells, multiShell: shells > 1, dmgFormula: f.dmgFormula, rows }
    );
    await ChatMessage.create({ content: resultCard });
  } else {
    ui.notifications.info(localize("NoTokensInSpread"));
  }

  // THE FIRES A BURNING LOAD LEAVES ALONG THE PATH — scattered inside the pattern, not put on one
  // target, because for a pattern shot the path IS where the shot landed (the rows above have just
  // damaged everyone standing in it). Placed HERE and not at placement time: an unconfirmed pattern is
  // a GM-only aiming aid and a fire is not, so lighting the ground while the GM is still deciding would
  // both leak the aim and leave fires burning for a shot nobody resolved.
  //
  // Ordered before the delete so the pattern the fires are being scattered inside is still the thing on
  // screen; not awaited, so a resolved shot is never held up by scene dressing. The load is asked of
  // the presentation table (ammoLeavesGroundFire), so nothing here knows which loads burn.
  if (ammoLeavesGroundFire(f.ammoKey)) {
    const gridSize = scene.grid?.size ?? canvas?.grid?.size ?? 100;
    const gridDist = scene.grid?.distance ?? 1;
    const pxPerM = gridSize / (gridDist || 1);
    // Seeded off the pattern's own recorded facts, so every client that computes this agrees and a
    // keeper can compute it twice — the reasoning is at seededRng in fx/effects.js.
    fxPatternGroundFire({
      x: originX, y: originY, dirDeg: Number(f.dirDeg) || 0,
      lengthPx: (Number(f.lengthM) || 0) * pxPerM, widthPx: (Number(f.widthM) || 0) * pxPerM,
      seed: fxSeedOf(f.attackerId, f.createdAt, shells, f.band, f.dmgFormula),
    }).catch((err) => console.warn("CP2020 | spread ground fire failed:", err));
  }

  await deleteArea(handle);
}

/**
 * VOID the shot: remove the pattern without applying anything, and say so on its card.
 *
 * The other half of the user's lifecycle ruling — "the apply button should never go out of date; it
 * should go away on application and should otherwise be able to be cleared". Apply and Clear are the
 * only two ways a pattern ends, and both leave the card stating which happened, so a pattern on the
 * table is always a decision somebody still owes rather than something a timer will quietly take away.
 *
 * Claimed through the SAME registry the apply uses, so a pattern cannot be applied and cleared at once
 * and a non-active-GM's press relays instead of failing on a document it may not write.
 *
 * @param {string} templateId  the pattern's area document id (the card's data-template-id)
 * @param {string} [messageId] the card that was pressed; falls back to the id the pattern itself carries
 */
export async function _clearSpreadZone(templateId, messageId = "") {
  if (!templateId) return;
  if (!_claimAreaConfirm("clearSpreadZone", { templateId, messageId }, templateId)) return;

  const scene = canvas?.scene;
  const handle = scene ? areaById(scene, templateId) : null;
  const f = handle?.doc?.flags?.["cp2020-augmented"] ?? {};
  // The pressed card wins over the recorded one: they are the same document in every ordinary case, and
  // when they are not it is the card in front of the reader that should end up saying "cleared".
  const cardId = String(messageId || f.cardMessageId || "").trim();

  // Stamped BEFORE the delete for the same reason the apply stamps first — the delete hook below reads
  // this flag to decide whether a vanished pattern orphaned a live card, and the answer here is no.
  await _markPatternCardCleared(cardId);
  if (handle && f.isSpreadZone) await deleteArea(handle);
}

/**
 * Stamp a pattern's card as dealt with, through the module's one card lock (card-lock.js). Returns
 * true when a card was found and stamped. A pattern with no recorded card (placed by a build before the
 * id was recorded, or by a keeper's direct placement) simply answers false — nothing to stamp.
 */
async function _markPatternCardResolved(messageId, note) {
  const id = String(messageId ?? "").trim();
  const message = id ? game.messages?.get(id) : null;
  if (!message) return false;
  await markCardResolved(message, note);
  return true;
}

/**
 * Stamp a pattern's card CLEARED: the resolved stamp (so every clock and the lock treat it as dealt
 * with) plus the flag the render pass reads to swap the card's buttons for the cleared line.
 *
 * The two are separate flags deliberately. `cardResolved` is the shared one-shot lock and the GM's ↺
 * re-arm control can lift it; `spreadCleared` is a statement about this shot that stays true whatever
 * the lock says, so a re-armed card cannot offer an Apply button for a pattern that no longer exists.
 */
async function _markPatternCardCleared(messageId) {
  const id = String(messageId ?? "").trim();
  const message = id ? game.messages?.get(id) : null;
  if (!message) return false;
  try { await message.setFlag("cp2020-augmented", "spreadCleared", true); }
  catch (err) { console.warn("CP2020 | could not mark the pattern card cleared", err); }
  await markCardResolved(message, "spreadCleared");
  return true;
}

/**
 * ⭐ THE CLOCK-SKIP PREDICATE. "Is somebody still being asked about this pattern?"
 *
 * True only when the pattern names a card, that card still exists, and it has not been resolved. Every
 * collection clock consults this before deleting: the round-advance rule in combat and the wall-clock
 * sweep outside one. Both survive, but only as an ORPHAN NET — a pattern whose card was hand-deleted,
 * or one placed before this field existed, has nobody to ask and stays collectible exactly as before.
 *
 * Not folded into spreadZoneRoundExpired / spreadZoneClockExpired, which are pure value rules asserted
 * as such: this one reads the message collection, so it is its own question asked next to them.
 */
export function _spreadZoneCardPending(flags) {
  const id = String(flags?.cardMessageId ?? "").trim();
  if (!id) return false;
  const message = game.messages?.get(id);
  if (!message) return false;
  return !isCardResolved(message);
}

/**
 * Pattern lifecycle, the half that runs when nobody clicks Confirm. Two consumers because there are two
 * clocks and only one of them ever ticks at a given table:
 *
 *   in combat  — a pattern belongs to the shot that threw it, so it dies when the round it was thrown
 *                on is over. Same rule, same shape, as the suppressive lane's expiry above.
 *   otherwise  — no round ever advances, so the wall clock is the only clock there is (SPREAD_ZONE_TTL_MS).
 *
 * The sweep also cleans up patterns left by a PREVIOUS session (it reads a stored timestamp, not a live
 * timer), which is what makes an already-littered world tidy itself on the next load rather than needing
 * a migration. Both run on the active GM only — two GMs would race the same delete.
 *
 * ⭐ BOTH CLOCKS ARE NOW AN ORPHAN NET, not a deadline. Neither collects a pattern whose card is still
 * unresolved (_spreadZoneCardPending) — that is a decision the reader has not made yet, and taking the
 * pattern away is what used to leave the card's button resolving nothing. What they still collect is a
 * pattern nobody can be asked about: one whose card was hand-deleted, and one from a build that
 * recorded no card at all.
 */
function _hookSpreadZoneExpiry() {
  Hooks.on("updateCombat", async (combat, updateData) => {
    if (!_ownsSpreadSweep()) return;
    if (updateData.round === undefined) return;               // round advance only
    const scene = canvas?.scene;
    if (!scene) return;
    for (const handle of areasByFlag(scene, "isSpreadZone")) {
      const flags = handle.doc.flags?.["cp2020-augmented"] ?? {};
      if (_spreadZoneCardPending(flags)) continue;            // its card is still open — not this clock's
      if (spreadZoneRoundExpired(flags, combat)) await deleteArea(handle);
    }
  });

  // A pattern that vanishes with its card still open flips that card to CLEARED, so the button on it can
  // never be pressed against a pattern that is not there. The ordinary source of this is the GM deleting
  // the region by hand off the canvas; the apply and the clear both stamp their card BEFORE they delete,
  // so neither is mistaken for one. Registered on the shim's per-core hook name so one listener covers
  // Regions (v14) and MeasuredTemplates (v13).
  Hooks.on(areaDeleteHook(), async (doc) => {
    if (!_ownsSpreadSweep()) return;
    const flags = doc?.flags?.["cp2020-augmented"] ?? {};
    if (!flags.isSpreadZone) return;
    if (!_spreadZoneCardPending(flags)) return;               // already applied, already cleared, or no card
    await _markPatternCardCleared(flags.cardMessageId);
  });

  // The out-of-combat clock. This function is itself called from the ready pass, so the interval starts
  // here rather than behind another `ready` hook — a listener added during the ready call is not invoked
  // for that call, and the sweep would silently never start. Each tick guards itself, so a session that
  // begins an encounter later needs no re-wiring.
  if (_spreadSweepTimer === null) _spreadSweepTimer = setInterval(_sweepStaleSpreadZones, SPREAD_ZONE_SWEEP_MS);
  // A scene the GM has just opened may be carrying patterns left by a previous session; the interval's
  // own first tick is a sweep interval away, and this makes the tidy immediate on arrival.
  Hooks.on("canvasReady", () => { _sweepStaleSpreadZones(); });
}

/** The one live sweep interval, so a re-registration cannot stack a second one. */
let _spreadSweepTimer = null;

/** Only the active GM deletes zones — every GM client receives the same hooks, and two would race. */
function _ownsSpreadSweep() {
  return !!game.user?.isGM && game.users.activeGM?.id === game.user.id;
}

/**
 * ROUND RULE, as a value. A pattern dies when the round it was thrown on is over — but only for the
 * encounter it was thrown in: two encounters can exist at once, and a pattern must not be expired by a
 * round advancing somewhere it has nothing to do with. A pattern with no encounter recorded (thrown out
 * of combat, or left by a build before this flag existed) is not the round rule's business at all.
 * Pure — no documents, so the whole decision is asserted by value.
 */
export function spreadZoneRoundExpired(flags, combat) {
  const combatId = String(flags?.combatId ?? "").trim();
  if (!combatId || !combat?.id || combatId !== combat.id) return false;
  return (Number(combat.round) || 0) > (Number(flags?.createdRound) || 0);
}

/**
 * WALL-CLOCK RULE, as a value. Answers "has this unconfirmed pattern outlived its welcome?" for the
 * patterns the round rule does not own. `encounterRunning` is asked of the pattern's OWN encounter —
 * a pattern belonging to a live, started encounter is the round rule's, whatever the clock says.
 * A pattern with no timestamp is litter from the build that had no expiry at all, and reading a missing
 * timestamp as "created at the epoch" is what lets an already-littered world tidy itself: the
 * alternative reading makes exactly the documents this rule exists to remove immortal.
 * Pure — `now` is passed in, so the keeper asserts the boundary rather than waiting out a minute.
 */
export function spreadZoneClockExpired(flags, { encounterRunning = false, now = Date.now(), ttlMs = SPREAD_ZONE_TTL_MS } = {}) {
  if (encounterRunning) return false;
  return (now - (Number(flags?.createdAt) || 0)) >= ttlMs;
}

/**
 * Delete every unconfirmed pattern the wall clock has outlived. Exported for the keeper, which drives it
 * directly rather than waiting out a real minute.
 */
export async function _sweepStaleSpreadZones() {
  if (!_ownsSpreadSweep()) return 0;
  // One sweep at a time. The interval tick, the canvasReady tidy, and a keeper-driven call are all
  // the same function on the same client; two of them interleaving would enumerate the same expired
  // zone and both reach for the delete — the loser makes core log a does-not-exist error.
  if (_spreadSweepBusy) return 0;
  const scene = canvas?.scene;
  if (!scene) return 0;
  _spreadSweepBusy = true;
  try {
    const now = Date.now();
    let deleted = 0;
    for (const handle of areasByFlag(scene, "isSpreadZone")) {
      const flags = handle.doc.flags?.["cp2020-augmented"] ?? {};
      // An unresolved card outranks the wall clock: the shot is still somebody's decision to make, and
      // this sweep exists to collect patterns nobody CAN decide about (see _spreadZoneCardPending).
      if (_spreadZoneCardPending(flags)) continue;
      const own = String(flags.combatId ?? "").trim();
      const encounterRunning = !!own && !!game.combats?.get?.(own)?.started;
      if (spreadZoneClockExpired(flags, { encounterRunning, now })) { await deleteArea(handle); deleted++; }
    }
    return deleted;
  } finally {
    _spreadSweepBusy = false;
  }
}

/** True while a sweep pass is enumerating and deleting — the re-entrancy latch for the three callers. */
let _spreadSweepBusy = false;

/**
 * Multi-action penalty tracker (CP2020 p.105 — −3 per additional action).
 * Auto-tracks weapon fire, Aim, Dodge, and Parry; ➕ button for untracked actions.
 * Pre-fills extraMod in the attack dialog. Resets all counts on round end.
 */
function _hookMultiActionPenalty() {
  Hooks.on("renderCombatTracker", (tracker, html) => {
    if (!_isMultiActionEnabled()) return;
    const combat = game.combat;
    if (!combat) return;
    const root = html instanceof jQuery ? html[0] : (Array.isArray(html) ? html[0] : html);
    if (!root) return;

    for (const combatant of combat.combatants) {
      const canControl = game.user.isGM || combatant.actor?.isOwner;
      if (!canControl || !combatant.actor) continue;

      const li = root.querySelector?.(`[data-combatant-id="${combatant.id}"]`);
      if (!li) continue;

      // Idempotent: clear any badge/button left from a prior render so repeated renders don't stack duplicates.
      li.querySelectorAll(".cp-action-count-badge, .cp-add-action-btn").forEach(e => e.remove());

      const actor   = combatant.actor;
      const count   = _getActionCount(actor);
      const penalty = _multiActionPenaltyFor(actor, count);
      // ACPA ½-REF action cap (MM p.54) — advisory: flag when a pilot declares more actions than allowed.
      const maxActions = _isAcpa(actor) ? _acpaMaxActions(actor) : 0;
      const overCap    = maxActions > 0 && count > maxActions;
      const controls = li.querySelector(".combatant-controls") ?? li.querySelector("menu") ?? li;

      if (count > 0) {
        const badge = document.createElement("span");
        badge.classList.add("cp-action-count-badge");
        const penaltyText = penalty || localize("MultiActionPenaltyNone");
        badge.title = maxActions > 0
          ? localizeParam(overCap ? "MultiActionAcpaOverCap" : "MultiActionAcpaBadgeTitle", { count, penalty: penaltyText, max: maxActions })
          : localizeParam("MultiActionBadgeTitle", { count, penalty: penaltyText });
        if (overCap) badge.classList.add("cp-over-cap");
        badge.textContent = penalty < 0 ? `×${count} (${penalty})` : `×${count}`;
        controls.prepend(badge);
      }

      if (combatant.id === combat.current?.combatantId) {
        const addBtn = document.createElement("a");
        addBtn.classList.add("cp-add-action-btn", "combatant-control");
        addBtn.dataset.actorId = actor.id;
        addBtn.title = localize("AddActionTitle");
        addBtn.innerHTML = "➕";
        controls.prepend(addBtn);
      }
    }
  });

  Hooks.on("renderModifiersDialog", (app, html) => {
    if (!_isMultiActionEnabled()) return;
    const actor = (app._weapon ?? app.options?.weapon)?.actor;
    if (!actor) return;
    const penalty = _getMultiActionPenalty(actor);
    if (penalty === 0) return;
    const root  = html instanceof jQuery ? html[0] : (Array.isArray(html) ? html[0] : html);
    const input = root?.querySelector?.("input[name='extraMod']");
    if (!input) return;
    const existing = Number(input.value) || 0;
    input.value = String(existing + penalty);
  });

  Hooks.on("cyberpunk2020.weaponFired", (payload) => {
    // Stamp the shared per-round action counter on weapon fire. This is the single increment site
    // (a second listener would double-count). It fires when multi-action auto-tracking is on, OR
    // when the once-per-turn movement gate is on — the gate reads the same counter to lock movement
    // after a tracked action, so it needs weapon fire to register even when the penalty is off.
    const trackForMultiAction = _isMultiActionEnabled() && _isMultiActionAutoTrack();
    const trackForMovementGate = (() => { try { return game.settings.get("cp2020-augmented", "restrictMovementOncePerTurn") === true; } catch { return false; } })();
    if (!trackForMultiAction && !trackForMovementGate) return;
    const actorId = payload.attackerId ?? payload.actorId;
    const actor = actorId ? game.actors.get(actorId) : null;
    if (!actor) return;
    _incrementActionCount(actor).catch(() => {});
  });

  const _clearActionCounts = async (combat) => {
    for (const combatant of combat.combatants) {
      if (!combatant.actor) continue;
      if ((combatant.actor.getFlag?.("cp2020-augmented", "actionCount") ?? 0) > 0) {
        await combatant.actor.unsetFlag("cp2020-augmented", "actionCount").catch(() => {});
        await combatant.actor.unsetFlag("cp2020-augmented", "actionCountRound").catch(() => {});
      }
    }
  };

  Hooks.on("updateCombat", async (combat, updateData) => {
    if (!game.user.isGM || updateData.round === undefined) return;
    // Active GM only — consistent with the other per-turn handlers (idempotent flag clears).
    if (game.users.activeGM?.id !== game.user.id) return;
    await _clearActionCounts(combat);
  });

  // A fresh combat must start from a clean count. The round-stamp guard in _getActionCount can be fooled
  // when a new combat reuses a round number a stale stamp still matches (e.g. a prior combat left a count
  // stamped at round 1 and this combat is also at round 1). Clearing on combatStart guarantees the first
  // in-combat action counts as the first. Active GM only, idempotent — mirrors the round-reset above.
  Hooks.on("combatStart", async (combat) => {
    if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
    await _clearActionCounts(combat);
  });
}

/**
 * Show a one-time first-run notice to the GM explaining new automation features
 * and which settings are active by default. Sets a world flag so it only fires once.
 */
function _hookAutomationMigrationNotice() {
  // Invoked from registerDamageHooks(), which already runs INSIDE the "ready" hook — so run the body
  // directly. Registering another Hooks.on("ready") here was too late to ever fire (Foundry does not
  // re-fire "ready" for listeners added during the ready emission); that is why this notice never appeared.
    if (!game.user.isGM) return;
    let hide = false, seenVersion = "";
    try { hide = game.settings.get("cp2020-augmented", "automationNoticeHide"); } catch { return; }
    try { seenVersion = game.settings.get("cp2020-augmented", "automationNoticeVersion"); } catch { /* new setting */ }
    const currentVersion = game.modules.get("cp2020-augmented")?.version ?? "";
    // Version-aware gate: the notice shows on every load UNTIL the GM ticks "Don't show this again"
    // (which sets `automationNoticeHide` AND stamps the current version into `automationNoticeVersion`).
    // A dismissed notice re-surfaces once the module version changes — so an updated notice reaches
    // GMs who dismissed an older one. Suppress only when dismissed AND still on the dismissed version.
    if (hide && seenVersion === currentVersion) return;

    // The notice UI lives in module/dialog/automation-notice.js — an ApplicationV2 whose markup is a
    // template, whose strings live in lang/*.json (translatable), and whose styling lives in
    // css/cyberpunk2020.css.
    new AutomationNotice().render({ force: true });
}

/**
 * Socket relay for player-initiated damage application.
 *
 * Players cannot call actor.update() on unowned NPCs. Instead they emit a
 * socket message; the GM's handler applies the damage with GM permissions,
 * then emits a result notification back to the requesting player.
 *
 * ONE mode:
 *   "resolved" — player pre-computed per-hit values in the damage dialog
 *                (armorMode override, cover SP, manual afterSP edits); GM
 *                applies the pre-resolved values directly.
 * A second mode, "auto" (player sends the raw payload, GM re-runs the whole
 * pipeline unattended), went with the auto-apply route it served.
 */
/**
 * Live sheet refresh across all clients.
 *
 * Damage and ablation writes pass { render: false } so applying several hits in a row
 * doesn't flicker the sheet, and the applying client re-renders once at the end. But the
 * { render: false } option propagates with the update to every client and suppresses their
 * automatic re-render too — so a player viewing the target's sheet (or the GM, when a player
 * applied damage through the socket relay) would not see the change until reopening the sheet.
 *
 * These hooks fire on every client regardless of the render option. They re-render the open
 * sheet wherever our damage system touched the actor. render(false) is a no-op on clients
 * where the sheet isn't open, so there's no cost or unexpected pop-ups.
 */
function _hookLiveSheetUpdate() {
  Hooks.on("updateActor", (actor, _changed, options) => {
    if (!options?.fromCyberpunkDamageSystem) return;
    actor.sheet?.render(false);
  });
  // Armor ablation edits embedded Item SP; refresh the owning actor's sheet too.
  Hooks.on("updateItem", (item, _changed, options) => {
    if (!options?.fromCyberpunkDamageSystem) return;
    item.actor?.sheet?.render(false);
  });
}

function _hookSocketRelay() {
  // Area/zone placements relayed from a non-GM firer. gasCloud/explosion/spread fire only on the firing
  // client, so the active GM places the area on their behalf. (Suppressive is placement-forward — its
  // geometry relay is handled separately as `suppressiveZonePlace` below.)
  const AREA_PLACERS = {
    gasCloudFired:   _placeGasCloud,
    explosionFired:  _placeExplosion,
    spreadFired:     _placeSpreadZone,
  };
  // Area-Confirm clicks relayed from a non-active GM so exactly one client resolves the effect (the
  // handlers also claim the template id, so a stray double-relay is idempotent).
  const AREA_CONFIRMERS = {
    confirmExplosion:  (d) => _confirmExplosion(d.templateId),
    confirmSpreadZone: (d) => _confirmSpreadZone(d.templateId),
    // Clear is a resolution too — it deletes an area document and writes a message flag, both of which
    // want GM permissions and exactly one performer, so it rides the same relay as its Apply twin.
    clearSpreadZone:   (d) => _clearSpreadZone(d.templateId, d.messageId ?? ""),
  };

  game.socket.on("module.cp2020-augmented", async (data) => {
    // Re-arm a suppressive-fire preview on the SHOOTER's client (a GM unlocked their placed lane). This
    // must reach a non-GM shooter, so it is handled BEFORE the GM gate; only the matching user acts.
    if (data.type === "suppressiveZoneRearm") {
      if (data.payload?.userId && data.payload.userId === game.user.id) {
        const { armSuppressivePreview } = await import("./suppressive-placement.js");
        await armSuppressivePreview({ ...data.payload, rearm: true });
      }
      return;
    }

    if (!game.user.isGM) {
      if (data.type === "damageApplied" && data.requesterId === game.user.id) {
        ui.notifications.info(localizeParam("DamageApplied", { amount: data.totalApplied, name: data.targetName }));
      } else if (data.type === "damageError" && data.requesterId === game.user.id) {
        ui.notifications.error(localizeParam("DamageApplyFailed", { message: data.message ?? localize("UnknownError") }));
      }
      return;
    }

    // Suppressive lane geometry relayed from a non-GM shooter's confirmed preview → the active GM plants
    // (or, with a regionId, updates) the lane.
    if (data.type === "suppressiveZonePlace") {
      if (game.users.activeGM?.id !== game.user.id) return;
      await placeSuppressiveZoneFromGeometry(data.payload);
      return;
    }

    // Relayed area placement (suppressive / gas / explosion / spread): only the active GM performs
    // it, else N connected GMs each place a duplicate.
    const areaPlacer = AREA_PLACERS[data.type];
    if (areaPlacer) {
      if (game.users.activeGM?.id !== game.user.id) return;
      await areaPlacer(data.payload);
      return;
    }

    // Relayed area-Confirm (blast / spread / fire-zone): only the active GM resolves it, else two GMs
    // both clicking Confirm apply it twice. The handler also claims the template id (double-relay safe).
    const areaConfirmer = AREA_CONFIRMERS[data.type];
    if (areaConfirmer) {
      if (game.users.activeGM?.id !== game.user.id) return;
      await areaConfirmer(data);
      return;
    }

    // Relayed special martial hit-effect (A6): a player performed a grapple/choke/hold on a target
    // they can't write. Only the active GM applies it (writes the target's held/grapple/choke flags +
    // posts the effect card), else N GMs each apply it N times.
    if (data.type === "martialEffect") {
      if (game.users.activeGM?.id !== game.user.id) return;
      // Token-first: an unlinked token's grapple/choke flags belong to THAT token's synthetic
      // actor, not the shared world actor its id also resolves to.
      const tgt = resolveActorRef({ tokenId: data.targetTokenId, sceneId: data.targetSceneId,
                                    actorUuid: data.targetActorUuid, actorId: data.targetActorId });
      if (tgt) {
        const { applyMartialHitEffects } = await import("../martial/martial.js");
        const atk = data.attackerActorId ? game.actors.get(data.attackerActorId) : null;
        await applyMartialHitEffects(data.action, tgt, atk);
      }
      return;
    }

    if (data.type !== "applyDamage") return;

    // The socket fires on every connected GM client. Only the primary (active) GM
    // applies the damage, otherwise N connected GMs would each apply it N times.
    if (game.users.activeGM?.id !== game.user.id) return;

    // Token-first (the player-relay path is where prototype bleed-through hurt most): a hit on an
    // unlinked token must write that token's synthetic actor. The bare-actorId fallback keeps
    // pre-fix cards in the log working.
    const target = resolveActorRef({ tokenId: data.targetTokenId, sceneId: data.targetSceneId,
                                     actorUuid: data.targetActorUuid, actorId: data.targetActorId });
    if (!target) {
      console.warn("CP2020 | Socket applyDamage: target actor not found:", data.targetActorId);
      return;
    }

    let totalApplied = 0;

    try {
      // ONE MODE. The relay used to carry a second one, "auto", for the route that applied a player's
      // shot with no window anywhere; that route was removed with the world setting that selected it
      // (user ruling 2026-08-14), and nothing emits "auto" any more. What reaches here is a window's
      // own resolved rows, relayed because the player who filled the window may not write the target.
      if (data.mode === "resolved") {
        // Apply pre-computed per-hit values from the player's damage dialog through the shared seam
        // (cyberlimb zones absorb into their SDP; totalApplied counts only flesh HP so the post-hit
        // stun/death prompt stays honest).
        const liveToken = data.targetTokenId ? (canvas?.tokens?.get(data.targetTokenId) ?? null)
                        : (canvas?.tokens?.placeables?.find(t => t.actor === target) ?? null);
        // The relayed window's rows are ONE application, exactly as the window's own Apply loop is.
        const severity = makeSeverityBatch({ ownsWoundTrackPrompt: true });
        for (const hit of data.resolvedHits) {
          const outcome = await applyLocationDamage({ target, location: hit.location, netDamage: hit.netDamage, structuralDamage: hit.afterSP, penetrates: hit.penetrates, token: liveToken, severityBatch: severity });
          totalApplied += outcome.applied;

          // Ablation gates on the bullet penetrating, not on the doubled HP value.
          if (data.ablate && data.armorMode === ARMOR_MODES.FULL && hit.btmResult > 0) {
            await ablateLocationOnce(target, hit.location, data.damageType);
          }
        }
        await closeSeverityBatch(severity);

        await target.sheet?.render(false);

        const taserEnabled = (() => { try { return game.settings.get("cp2020-augmented", "taserCumPenaltyEnabled"); } catch { return true; } })();
        if (taserEnabled && data.stunSaveOnHit && data.resolvedHits.some(h => h.penetrates && !routesToSdp(target, h.location))) {
          await updateTaserState(target, data);
        }

        // DOT routes by dotType (fire -> HP burn, acid -> armor degradation); see save-rolls.js.
        await applyDotFromPayload(target, data.firstHitLocation ?? null, data, (data.resolvedHits ?? []).some(h => h.penetrates));

        if (totalApplied > 0) {
          // Reuse liveToken (resolved above from data.targetTokenId) — re-deriving by actor id would drop
          // the threaded token and land the prompt/status on the wrong token for a multi-token actor.
          // `target` stays as resolved (token-first) — re-fetching by id here would retarget an
          // unlinked token's hit back to the shared world actor ([[combat-data-hazards]]).
          const woundState = target.woundState?.() ?? 0;
          // Mortal half deferred to the ledger, as at every other apply-loop tail.
          if (woundState >= 4) {
            if (!severityBatchHandledMortal(severity, target, liveToken)) await postDeathSavePrompt(target, liveToken);
          } else if (woundState > 0) await postStunSavePrompt(target, liveToken);
        }
      }

    } catch (err) {
      console.error("CP2020 | Socket applyDamage handler failed:", err);
      game.socket.emit("module.cp2020-augmented", {
        type:        "damageError",
        requesterId: data.requesterId,
        message:     err.message ?? "Unknown error",
      });
      return;
    }

    game.socket.emit("module.cp2020-augmented", {
      type:        "damageApplied",
      requesterId: data.requesterId,
      targetName:  target.name,
      totalApplied,
    });
  });
}
