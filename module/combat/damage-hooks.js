/**
 * damage-hooks.js  —  module/combat/damage-hooks.js
 *
 * Wires the damage automation system into Foundry's hooks.
 *
 * PATH A — Targeted full-auto:
 *   item.js emits "cyberpunk2020.weaponFired" with a targetTokenId.
 *   Opens DamageDialog immediately (or auto-applies if setting is on).
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

import { DamageDialog }                                       from "./DamageDialog.js";
import { AutomationNotice }                                   from "../dialog/automation-notice.js";
import { onGlobalClick } from "../popout-compat.js";
import { applyAreaDamages, ablateLocationOnce, ablateLocationByAmount, applyLocationDamage, ARMOR_MODES } from "./DamageApplicator.js";
import { routesToSdp, contributingItems } from "../mech/cyberlimb.js";
import { isFullBorg } from "../mech/borg.js";
import { postStunSavePrompt, postDeathSavePrompt, updateTaserState, applyAcidDotState, applyDotFromPayload, postSavePromptCard } from "./save-rolls.js";
import { gasSaveDecisionFor, percentGateOutcome } from "../mech/protection.js";
import { mechRoundTickEnabled } from "../settings.js";
import { rollLocation, localize, localizeParam }              from "../utils.js";
import { renderChatCard }                                     from "../compat.js";
import { dispatchAttack }                                     from "../vehicle/vehicle-targeting.js";
import { createArea, tokensInArea, areasByFlag, deleteArea, areaById, usesRegions, moveArea } from "./area-shapes.js";

// Payload waiting to be attached to the next chat message created
let _pendingPayload = null;

function _isMultiActionEnabled() {
  try { return game.settings.get("cp2020-augmented", "multiActionPenaltyEnabled"); } catch { return false; }
}
function _isMultiActionAutoTrack() {
  try { return game.settings.get("cp2020-augmented", "multiActionAutoTrack"); } catch { return false; }
}
function _getActionCount(actor) {
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
  return _multiActionPenaltyFor(actor, _getActionCount(actor));
}

// ---------------------------------------------------------------------------

export function registerDamageHooks() {
  _hookWeaponFired();
  _hookCreateChatMessage();
  _hookRenderChatMessage();
  _hookSuppressiveFire();
  _hookSuppressiveFirePerTurn();
  _hookSuppressiveTemplateOriginLock();
  _hookAimTracking();
  _hookWaitForTurn();
  _hookDodgeParry();
  _hookDotEffects();
  _hookGasCloud();
  _hookGasCloudPerTurn();
  _hookManualRoundTick();
  _hookExplosion();
  _hookSpread();
  _hookMultiActionPenalty();
  _hookAutomationMigrationNotice();
  _hookSocketRelay();
  _hookLiveSheetUpdate();

  // Combat action button click handler
  onGlobalClick(async (ev) => {
    const evasionBtn    = ev.target.closest(".cp-suppression-evasion-roll");
    const confirmBtn    = ev.target.closest(".cp-confirm-fire-zone");
    const blastBtn      = ev.target.closest(".cp-confirm-explosion");
    const spreadBtn     = ev.target.closest(".cp-confirm-spread-zone");
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
    }

    if (blastBtn && !blastBtn.disabled) {
      ev.preventDefault();
      blastBtn.disabled = true;
      await _confirmExplosion(blastBtn.dataset.templateId);
    }

    if (spreadBtn && !spreadBtn.disabled) {
      ev.preventDefault();
      spreadBtn.disabled = true;
      await _confirmSpreadZone(spreadBtn.dataset.templateId);
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
    }

    // Confirm fire zone — detects tokens in zone and posts evasion prompts
    if (confirmBtn && !confirmBtn.disabled) {
      ev.preventDefault();
      confirmBtn.disabled = true;
      await _confirmFireZone({
        templateId: confirmBtn.dataset.templateId,
        saveDC:     Number(confirmBtn.dataset.saveDc),
        dmgFormula: confirmBtn.dataset.dmgFormula,
        attackerId: confirmBtn.dataset.attackerId,
        weaponName: confirmBtn.dataset.weaponName,
      });
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
    if ((payload.effectTypes ?? []).includes("Explosive")) return;
    if (payload.spreadMode && payload.spreadMode !== "single") return;

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
    // Only the PRIMARY (active) GM handles NPC / offline-owner shots. weaponFired fires on every
    // connected GM client; without the activeGM check, N GMs each open a DamageDialog (and, with
    // auto-apply on, each apply the damage → N× HP loss). It also guarantees exactly one client
    // reaches dispatchAttack per shot, which the vehicle-damage relay below relies on to avoid
    // double-applying to a vehicle. Single-GM tables are unaffected (the lone GM is the active GM).
    const gmHandles = game.user.isGM && !ownerOnline && game.users.activeGM?.id === game.user.id;
    if (!isMyShot && !gmHandles) return;
    if (!payload.areaDamages || Object.keys(payload.areaDamages).length === 0) return;

    // This client + layer is committing to apply this shot — claim it (synchronously, before any
    // await) so a co-resident layer's later weaponFired listener stands down (see the top guard).
    payload.handled = "cp2020-augmented";

    // PATH A: we have a target — open dialog (or auto-apply) immediately
    if (payload.targetTokenId || payload.targetActorId) {
      const target = _resolveTarget(payload);
      if (!target) {
        console.warn("CP2020 | weaponFired: could not resolve target", payload);
        // Still queue for PATH B so GM can use the chat button
        _pendingPayload = payload;
        return;
      }

      // Unified dispatcher (4-way: source scale × target type). Vehicle targets → vehicle resolver
      // (SP→SDP / Penetration vs Armor Value); a Penetration weapon vs a person → MM p.8. Returns
      // true when handled; a normal personnel-vs-person hit falls through to the dialog below.
      if (await dispatchAttack(payload, target)) return;

      if (game.settings.get("cp2020-augmented", "damageAutoApply")) {
        await _autoApply(payload, target);
      } else {
        new DamageDialog(payload, target).render(true);
      }
      return;
    }

    // PATH B: no target — queue payload for the next createChatMessage hook
    _pendingPayload = payload;
  });
}

function _hookCreateChatMessage() {
  Hooks.on("createChatMessage", async (message) => {
    if (!_pendingPayload) return;
    // createChatMessage fires on this client for EVERY message, including ones authored by other users
    // (broadcast). The pending payload belongs to THIS user's shot, so only attach it to a message this
    // user authored — an interleaved message from someone else must not receive the apply flag, nor spend
    // the payload on a message we don't own. When the author can't be determined we fall through rather
    // than block the whole flow.
    const authorId = message.author?.id ?? message.user?.id ?? null;
    if (authorId && authorId !== game.user.id) return;
    // Prefer the shot's own card: if the message names a speaker actor and we know the attacker, require
    // them to match so a same-user message about a different actor doesn't claim this shot's payload.
    const attackerId     = _pendingPayload.attackerId ?? _pendingPayload.actorId ?? null;
    const speakerActorId = message.speaker?.actor ?? null;
    if (attackerId && speakerActorId && speakerActorId !== attackerId) return;

    const payload = _pendingPayload;
    _pendingPayload = null;

    try {
      await message.setFlag("cp2020-augmented", "damagePayload", payload);
    } catch (err) {
      console.warn("CP2020 | Could not set damagePayload flag on chat message", err);
    }
  });
}

function _hookRenderChatMessage() {
  // renderChatMessageHTML replaced the deprecated renderChatMessage in Foundry v15.
  // It passes a native HTMLElement as the second argument on v13 (since v13.331) and v14+.
  // Using this hook name means we work on v13.350, v14, and v15 with a single registration.
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const payload = message.getFlag?.("cp2020-augmented", "damagePayload");
    if (!payload?.areaDamages || Object.keys(payload.areaDamages).length === 0) return;

    // Show button to GM always; show to players only if they own the attacker actor.
    // Avoids any dependency on message.userId / message.author which can be undefined in v14+.
    const attackerActorId = payload.attackerId ?? payload.actorId ?? null;
    const attackerActor = attackerActorId ? game.actors.get(attackerActorId) : null;
    const canApply = game.user.isGM || (attackerActor?.isOwner ?? false);
    if (!canApply) return;

    // renderChatMessageHTML fires again after setFlag and on any later re-render
    // (edit, popout, scrollback). Without this guard each re-render stacks another button.
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

      if (game.settings.get("cp2020-augmented", "damageAutoApply")) {
        await _autoApply(payload, target);
      } else {
        new DamageDialog(payload, target).render(true);
      }
    });

    const container = html.querySelector(".cyberpunk-card") ?? html;
    container.appendChild(btn);
  });
}

/**
 * Suppressive fire flow:
 *   1. Places a ray MeasuredTemplate (fire zone) at the attacker's token, aimed toward
 *      any currently targeted tokens (or East if none). Posts a "Confirm Fire Zone" button.
 *   2. GM aims the template, then clicks Confirm. All tokens inside receive evasion prompts.
 *   3. Template persists with `isSuppressiveZone` flag for per-turn re-checks, then
 *      auto-expires at the start of the next round (_hookSuppressiveFirePerTurn).
 *
 * Evasion: Athletics + REF + 1d10 vs saveDC (CP2020 p.101).
 * Failure: 1d6 random hits with weapon damage formula, routed through PATH A.
 */
function _hookSuppressiveFire() {
  Hooks.on("cyberpunk2020.suppressiveFire", async (payload) => {
    const suppressiveSaves = (() => {
      try { return game.settings.get("cp2020-augmented", "suppressiveFireSaves"); }
      catch { return false; }
    })();
    if (!suppressiveSaves) return;

    // Hooks.callAll is LOCAL to the firing client. Placing the fire-zone template requires the GM,
    // so if we're the active GM place it directly; otherwise relay to the GM over the socket
    // (mirrors the damage relay). Without this, a player firing suppressive produced no template.
    if (game.users.activeGM?.id === game.user.id) {
      await _placeSuppressiveZone(payload);
    } else {
      game.socket.emit("module.cp2020-augmented", { type: "suppressiveFire", payload });
    }
  });
}

/** Place the suppressive-fire ray template + post the Confirm prompt. Runs on the GM's client. */
async function _placeSuppressiveZone(payload) {
  if (!payload) return;
  const { saveDC, dmgFormula, weaponName, actorId, attackerTokenId, zoneWidth, weaponRange } = payload;
  const scene       = canvas?.scene;
  const attackerTok = attackerTokenId ? canvas?.tokens?.placeables?.find(t => t.id === attackerTokenId) : null;

  if (!attackerTok || !scene) {
    ui.notifications.warn(localize("SuppFireNoToken"));
    return;
  }

  {
    // Initial direction: toward centroid of currently-targeted tokens, or East (0°)
    let angleDeg = 0;
    const targetedTokens = Array.from(game.user.targets ?? []);
    if (targetedTokens.length > 0) {
      const cx = targetedTokens.reduce((s, t) => s + (t.center?.x ?? t.x), 0) / targetedTokens.length;
      const cy = targetedTokens.reduce((s, t) => s + (t.center?.y ?? t.y), 0) / targetedTokens.length;
      const dx = cx - (attackerTok.center?.x ?? attackerTok.x);
      const dy = cy - (attackerTok.center?.y ?? attackerTok.y);
      angleDeg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
    }

    // Create the fire zone through the area shim: MeasuredTemplate ray on v13, Region polygon
    // on v14. The direction is already auto-aimed at the target(s) above (the v14 "#1 auto-aim");
    // on v13 the GM can still rotate the template before confirming.
    const origin = {
      x: attackerTok.center?.x ?? attackerTok.x,
      y: attackerTok.center?.y ?? attackerTok.y,
    };
    const handle = await createArea(scene, {
      kind: "ray",
      x: origin.x, y: origin.y,
      dirDeg: angleDeg,
      lengthM: Math.max(1, weaponRange ?? 50),
      widthM:  Math.max(2, zoneWidth ?? 2),
      color: "#ff4400",
      flags: {
        isSuppressiveZone: true, saveDC, dmgFormula, weaponName, actorId,
        maxDistance: weaponRange ?? 50, minWidth: zoneWidth ?? 2,
        originX: origin.x, originY: origin.y, createdRound: game.combat?.round ?? 0,
      },
    });
    if (!handle?.doc) {
      ui.notifications.warn(localize("SuppFireZoneFail"));
      return;
    }
    const created = handle.doc;

    const content = await renderChatCard("suppressive-placement.hbs", {
      weaponName, saveDC, templateId: created.id, dmgFormula, attackerId: actorId,
    });

    await ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor: game.actors.get(actorId) ?? undefined }),
    });
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

/**
 * After the player has aimed the fire zone template, detect all tokens inside it
 * and post evasion prompts for each (excluding the attacker).
 */
async function _confirmFireZone({ templateId, saveDC, dmgFormula, attackerId, weaponName }) {
  const scene = canvas?.scene;
  if (!scene) return;
  if (!_claimAreaConfirm("confirmFireZone", { args: { templateId, saveDC, dmgFormula, attackerId, weaponName } }, templateId)) return;

  const handle = areaById(scene, templateId);
  if (!handle) {
    ui.notifications.warn(localize("FireZoneNotFound"));
    return;
  }

  // Tokens whose centre is inside the zone (excluding the attacker). The shim uses
  // RegionDocument#testPoint on v14 and the template's shape.contains on v13.
  const candidates = (scene.tokens?.contents ?? []).filter(td => td.actor?.id !== attackerId);
  const tokensInZone = tokensInArea(handle, candidates);

  if (!tokensInZone.length) {
    ui.notifications.info(localize("NoTokensInFireZone"));
    return;
  }

  await _postEvasionPrompts(tokensInZone, { saveDC, dmgFormula, weaponName, attackerId });
}

/** Post evasion prompts for a set of tokens. Shared by initial confirm and per-turn hook. */
async function _postEvasionPrompts(tokens, { saveDC, dmgFormula, weaponName, attackerId }) {
  const sceneId = canvas?.scene?.id ?? "";
  for (const tok of tokens) {
    const actor = tok.actor;
    if (!actor) continue;
    const ref       = Number(actor.system?.stats?.ref?.total) || 0;
    const athletics = Number(actor.getSkillVal?.("Athletics") ?? 0);

    const content = await renderChatCard("suppression-evasion-prompt.hbs", {
      actorName: actor.name, saveDC, weaponName, ref, athletics,
      actorId: actor.id, tokenId: tok.id, sceneId, dmgFormula, attackerId,
    });

    await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
  }
}

/**
 * Enforce fire zone template constraints:
 *   - Origin cannot be moved (only direction/angle can change).
 *   - Distance cannot exceed maxDistance.
 *   - Width cannot drop below minWidth.
 */
function _hookSuppressiveTemplateOriginLock() {
  // The drag-to-aim origin lock only applies to MeasuredTemplates (v13). On v14 the zone is a
  // Region created already-aimed (not drag-rotated), so there is no draggable origin to lock.
  if (usesRegions()) return;
  Hooks.on("preUpdateMeasuredTemplate", (doc, change) => {
    const flags = doc.flags?.["cp2020-augmented"];
    if (!flags?.isSuppressiveZone) return;

    // Lock origin position
    if (change.x !== undefined) change.x = flags.originX ?? doc.x;
    if (change.y !== undefined) change.y = flags.originY ?? doc.y;

    // Cap distance at weapon range
    if (change.distance !== undefined && flags.maxDistance) {
      change.distance = Math.min(change.distance, flags.maxDistance);
    }

    // Floor width at minimum zone width
    if (change.width !== undefined && flags.minWidth) {
      change.width = Math.max(change.width, flags.minWidth);
    }
  });
}

/**
 * Per-turn evasion: when a combatant's turn starts, check if their token is
 * inside any active suppressive fire zone template and prompt them to evade.
 * Also removes zones that were created in a previous round (auto-expiry).
 */
function _hookSuppressiveFirePerTurn() {
  Hooks.on("updateCombat", async (combat, updateData) => {
    if (!game.user.isGM) return;
    // Active GM only — otherwise every connected GM posts a duplicate per-turn
    // evasion prompt and races on template deletion.
    if (game.users.activeGM?.id !== game.user.id) return;
    if (updateData.turn === undefined && updateData.round === undefined) return;
    const scene = canvas?.scene;
    if (!scene) return;

    const currentRound = combat.round ?? 0;

    // Expire zones created in a previous round (fire zones last 1 round), via the shim.
    let zones = areasByFlag(scene, "isSuppressiveZone");
    for (const z of zones) {
      const createdRound = z.doc.flags?.["cp2020-augmented"]?.createdRound ?? 0;
      if (currentRound > createdRound) await deleteArea(z);
    }
    zones = areasByFlag(scene, "isSuppressiveZone");   // refresh after any deletions
    if (!zones.length) return;

    const combatant = combat.combatant;
    if (!combatant) return;
    const tokDoc = scene.tokens.get(combatant.tokenId);
    if (!tokDoc?.actor) return;

    for (const z of zones) {
      const zf = z.doc.flags?.["cp2020-augmented"];
      if (tokDoc.actor.id === zf?.actorId) continue;        // skip the attacker
      if (!tokensInArea(z, [tokDoc]).length) continue;

      await _postEvasionPrompts([tokDoc], {
        saveDC:     zf.saveDC,
        dmgFormula: zf.dmgFormula,
        weaponName: localizeParam("WpnVariantPerTurn", { name: zf.weaponName ?? "" }),
        attackerId: zf.actorId,
      });
    }
  });
}

/**
 * Execute a suppressive fire evasion roll. Called by the button click handler.
 * On failure: roll 1d6 hits with the weapon's dmgFormula, apply via PATH B.
 */
async function _executeSuppressionEvasion({ actorId, tokenId, sceneId, saveDC, dmgFormula, attackerId }) {
  const actor = game.actors.get(actorId);
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
      if (surviving.length > 0) {
        await actor.setFlag("cp2020-augmented", "dotState", surviving);
      } else {
        await actor.unsetFlag("cp2020-augmented", "dotState");
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
        const outcome = await applyLocationDamage({ target: actor, location, netDamage: dmg, structuralDamage: fireStructural, penetrates: true, token });
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
      if (surviving.length > 0) {
        await actor.setFlag("cp2020-augmented", "fireDotState", surviving);
      } else {
        await actor.unsetFlag("cp2020-augmented", "fireDotState");
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
    const types = payload.effectTypes ?? [];
    if (!types.includes("Gas")) return;
    // weaponFired fires only on the firing client; placing the cloud needs the GM. The active GM
    // places it directly; anyone else (a player, or a non-active GM) relays to it. Without this a
    // player's gas grenade produced no cloud. Mirrors _hookSuppressiveFire.
    if (game.users.activeGM?.id === game.user.id) await _placeGasCloud(payload);
    else game.socket.emit("module.cp2020-augmented", { type: "gasCloudFired", payload });
  });
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
      // No target token — fall back to the attacker's token, resolved by actor id.
      // weaponFired payloads carry no attacker token id, so we look it up on the canvas.
      const atk = attackerId
        ? canvas?.tokens?.placeables?.find(t => t.actor?.id === attackerId)
        : null;
      if (atk) { cloudX = atk.center?.x ?? atk.x; cloudY = atk.center?.y ?? atk.y; }
    }
    if (cloudX === null) return; // can't place without a position

    const radius      = Number(payload.blastRadius) || 3;
    const duration    = Number(payload.dotTurns)    || 3;
    const stunSaveMod = Number(payload.stunSaveMod) || 0;

    const handle = await createArea(scene, {
      kind: "circle", x: cloudX, y: cloudY, radiusM: radius,
      color: "#88ff44", borderColor: "#44aa22",
      flags: {
        isGasCloud: true, turnsLeft: duration, stunSaveMod,
        createdRound: game.combat?.round ?? 0, weaponName: payload.weaponName ?? localize("WpnGasGrenade"),
      },
    });
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
    if (updateData.turn === undefined && updateData.round === undefined) return;
    // Starting combat is not a turn elapsing (matches the DOT block): tokens already standing
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

/** One per-turn gas-cloud adjudication pass over the scene's clouds: prompt saves for tokens inside,
 *  decrement each cloud's turns, delete when expired. Ungated by the round-tick master so both the
 *  per-turn hook (gated above) and the manual combat-tracker control run it; still respects the
 *  gas-cloud feature toggle. */
async function _runGasCloudTick(combat) {
  const gasEnabled = (() => { try { return game.settings.get("cp2020-augmented", "gasGrenadeCloudEnabled"); } catch { return true; } })();
  if (!gasEnabled) return;

  const scene = canvas?.scene;
  if (!scene) return;

  const clouds = areasByFlag(scene, "isGasCloud");

  for (const cloud of clouds) {
    const flags = cloud.doc.flags["cp2020-augmented"];
    const turnsLeft    = Number(flags.turnsLeft   ?? 0);
    const stunSaveMod  = Number(flags.stunSaveMod ?? 0);
    const weaponName   = flags.weaponName ?? localize("WpnGasGrenade");

    if (turnsLeft <= 0) {
      await deleteArea(cloud);
      continue;
    }

    // Tokens inside the cloud (shim: RegionDocument#testPoint on v14, shape.contains on v13).
    const tokensInCloud = tokensInArea(cloud, scene.tokens?.contents ?? []);

    if (tokensInCloud.length > 0) {
      // P6 protection tags (mech/protection.js): sealed breathing gear (mask / independent air)
      // skips the save entirely; a save-mod tag offsets the gas penalty (never past 0); Q8
      // percent-effective gear (nasal filters "70% effective") rolls one d10 per exposure —
      // at or under percent/10 the wearer is protected this turn, and the card shows the roll.
      const decisions = [];
      for (const tokDoc of tokensInCloud) {
        const liveActor = tokDoc.actor ? (game.actors.get(tokDoc.actor.id) ?? tokDoc.actor) : null;
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

    const autoMove = (() => { try { return game.settings.get("cp2020-augmented", "gasCloudAutoMove"); } catch { return false; } })();
    await cloud.doc.update({ ["flags.cp2020-augmented.turnsLeft"]: turnsLeft - 1 }).catch(() => {});

    if (autoMove) {
      // Drift 2m in a random direction (wind) — shifts the template (v13) or region shape (v14).
      const gridDist = scene.grid?.distance ?? 1;
      const gridSize = scene.grid?.size ?? canvas?.grid?.size ?? 100;
      const movePx   = (2 / gridDist) * gridSize;
      const angle    = Math.random() * 2 * Math.PI;
      await moveArea(cloud, Math.cos(angle) * movePx, Math.sin(angle) * movePx);
    }

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
 *  master is off): drug + consumable timers, then this file's over-time and gas-cloud ticks. The timer
 *  exports are ungated inside; this path is reached only from the GM-only button. */
async function _runManualRoundTick(combat) {
  if (!combat || !game.user.isGM) return;
  const { runDrugTickOnce }       = await import("../mech/drug.js");
  const { runConsumableTickOnce } = await import("../mech/consumable.js");
  await runDrugTickOnce(combat);
  await runConsumableTickOnce(combat);
  await _runOverTimeTick(combat);
  await _runGasCloudTick(combat);
}

/** Apply one area-effect hit to a token's actor through the normal pipeline (GM-side, direct). */
async function _applyAreaHitToToken(tok, dmg, { ap, edged, armorMultSoft, armorMultHard, penDamageMult, weaponName }) {
  if (!tok?.actor || dmg <= 0) return 0;
  const loc = (await rollLocation(tok.actor, null)).areaHit;
  const hits = await applyAreaDamages({
    target:        tok.actor,
    areaDamages:   { [loc]: [{ damage: dmg }] },
    ap:            Boolean(ap),
    edged:         Boolean(edged),
    armorMultSoft: Number(armorMultSoft ?? 1),
    armorMultHard: Number(armorMultHard ?? 1),
    penDamageMult: Number(penDamageMult ?? 1),
    armorMode:     game.settings.get("cp2020-augmented", "damageArmorMode"),
    ablate:        game.settings.get("cp2020-augmented", "damageAblation"),
    dryRun:        false,
  });
  const total = hits.reduce((s, h) => s + h.netDamage, 0);
  if (total > 0) {
    const ws = tok.actor.woundState?.() ?? 0;
    if (ws >= 4) await postDeathSavePrompt(tok.actor, tok);
    else if (ws > 0) await postStunSavePrompt(tok.actor, tok);
  }
  return total;
}

/**
 * Is `tok` shielded from an area effect originating at (ox,oy) by a wall? (CP2020 p.108 — cover
 * between the source and a target exempts it.) Gated by areaEffectOcclusion. Graceful: if the
 * collision backend is unavailable, nothing is treated as occluded.
 */
function _isOccluded(ox, oy, tok) {
  try { if (!game.settings.get("cp2020-augmented", "areaEffectOcclusion")) return false; } catch (e) { /* default on */ }
  try {
    const origin = { x: ox, y: oy };
    const dest   = { x: tok.center?.x ?? tok.x, y: tok.center?.y ?? tok.y };
    const backend = CONFIG?.Canvas?.polygonBackends?.move;
    if (backend?.testCollision) return !!backend.testCollision(origin, dest, { type: "move", mode: "any" });
  } catch (e) { /* no collision support → not occluded */ }
  return false;
}

/**
 * HEP concussion (Listen Up p.105): SP ignored, BTM applies, half of what gets through is
 * permanent HP and half is stun (a Stun Save is always prompted). Soft armor at the torso loses
 * 2 SP. Used by the explosion blast when Detailed Explosives is enabled.
 */
async function _applyConcussionToToken(tok, falloffDmg, { weaponName = localize("WpnExplosion") } = {}) {
  if (!tok?.actor || falloffDmg <= 0) return 0;
  const actor = tok.actor;
  const btm = Number(actor.system.stats?.bt?.modifier) || 0;
  const gotThrough = Math.max(1, falloffDmg - btm);          // SP ignored; BTM applies
  const permanent  = Math.max(1, Math.floor(gotThrough / 2)); // half permanent, half stun

  // Route through the shared seam so a full borg's Torso concussion hits its SDP (and can destroy the
  // biosystem) instead of the flesh wound track; flesh advances system.damage, loses stabilization,
  // and runs wound severity — all inside applyLocationDamage. BTM is already applied above (concussion
  // applies BTM even to machinery, Listen Up p.105), so pass the same permanent value as structural.
  const outcome = await applyLocationDamage({ target: actor, location: "Torso", netDamage: permanent, structuralDamage: permanent, penetrates: true, token: tok });
  await ablateLocationByAmount(actor, "Torso", 2).catch(() => {}); // concussion wears soft armor −2 SP
  await postSavePromptCard({
    body: localizeParam("ConcussionBody", { name: actor.name, weapon: weaponName, permanent, gotThrough }),
    speaker: ChatMessage.getSpeaker({ actor }),
  });
  // Half the blow is stun/blunt → a consciousness check, but only for flesh: a cyberlimb/borg zone
  // that soaked the hit into SDP takes no stun (a destroyed core already ran its own death via the seam).
  if (!outcome.cyberlimb) {
    const ws = actor.woundState?.() ?? 0;
    if (ws >= 4) await postDeathSavePrompt(actor, tok);
    else await postStunSavePrompt(actor, tok);
  }
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
    if (!(payload.effectTypes ?? []).includes("Explosive")) return;
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
    if (cx === null && attackerId) {
      const atk = canvas?.tokens?.placeables?.find(t => t.actor?.id === attackerId);
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
        attackerId, ap: Boolean(payload.ap), edged: Boolean(payload.edged),
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
      await _applyConcussionToToken(tok, dmg, { weaponName: localizeParam("WpnVariantConcussion", { name: f.weaponName ?? localize("WpnExplosion") }) });
      if (f.blastShrapnel) {
        const shrap = await new Roll("1d10").evaluate();
        await _applyAreaHitToToken(tok, Math.max(0, Math.floor(shrap.total)),
          { ap: false, edged: false, armorMultSoft: 1, armorMultHard: 1, penDamageMult: 1, weaponName: localizeParam("WpnVariantShrapnel", { name: f.weaponName ?? localize("WpnExplosion") }) });
      }
    } else {
      // Core blast: range-banded damage through normal armor.
      await _applyAreaHitToToken(tok, dmg, { ...f, weaponName: localizeParam("WpnVariantBlast", { name: f.weaponName ?? localize("WpnExplosion") }) });
    }
  }
}

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
  // Numpad layout around the target (5/10 = on-target). Screen coords: +y is down.
  const DIRS    = { 1: [-1, 1], 2: [0, 1], 3: [1, 1], 4: [-1, 0], 5: [0, 0], 6: [1, 0], 7: [-1, -1], 8: [0, -1], 9: [1, -1], 10: [0, 0] };
  const DIRNAME = { 1: "SW", 2: "S", 3: "SE", 4: "W", 5: "on-target", 6: "E", 7: "NW", 8: "N", 9: "NE", 10: "direct hit" };
  const [vx, vy] = DIRS[dirRoll.total] ?? [0, 0];
  const distM  = distRoll.total;
  const distPx = (distM / gridDist) * gridSize;
  const mag = Math.hypot(vx, vy) || 1;
  const dx = (vx / mag) * distPx;
  const dy = (vy / mag) * distPx;

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
    body: localizeParam("ScatterBody", { dir: DIRNAME[dirRoll.total], drift: (vx || vy) ? localizeParam("ScatterDrift", { dist: distM }) : localize("ScatterNoDrift") }),
  });
}

/**
 * Shotgun / flechette spread (CP2020 p.108). Ammo whose spreadMode is not "single" fires a widening
 * pattern: a ray from the attacker toward the target, width by range band (Close/Med/Long), with
 * range-banded damage (ammo override, else Core 4d6/3d6/2d6). Everyone in the straight path is hit
 * (no evasion). The GM aims and confirms, mirroring suppressive fire.
 */
function _hookSpread() {
  const enabled = () => { try { return game.settings.get("cp2020-augmented", "shotgunSpreadEnabled"); } catch { return true; } };

  Hooks.on("cyberpunk2020.weaponFired", async (payload) => {
    if (!enabled()) return;
    const mode = payload.spreadMode;
    if (!mode || mode === "single") return;
    // weaponFired fires only on the firing client; placing the pattern needs the GM. The active GM
    // places it directly; anyone else (a player, or a non-active GM) relays to it. Mirrors
    // _hookSuppressiveFire. Without this a player's shotgun produced no spread.
    if (game.users.activeGM?.id === game.user.id) await _placeSpreadZone(payload);
    else game.socket.emit("module.cp2020-augmented", { type: "spreadFired", payload });
  });
}

/** Place the shotgun/flechette spread pattern + post its Confirm card. Runs on the active GM. */
async function _placeSpreadZone(payload) {
    const scene = canvas?.scene;
    if (!scene) return;

    const attackerId = payload.attackerId ?? payload.attackerActorId ?? payload.actorId ?? null;
    const atk = attackerId ? canvas?.tokens?.placeables?.find(t => t.actor?.id === attackerId) : null;
    if (!atk) {
      ui.notifications.warn(localize("SpreadFireNoToken"));
      return;
    }
    const ox = atk.center?.x ?? atk.x, oy = atk.center?.y ?? atk.y;
    const gridSize = scene.grid?.size ?? canvas?.grid?.size ?? 100;
    const gridDist = scene.grid?.distance ?? 1;

    // Direction + range band toward the target (East + Medium if no target).
    let angleDeg = 0, band = "Medium", lengthM = 10;
    const tgt = payload.targetTokenId ? canvas?.tokens?.placeables?.find(t => t.id === payload.targetTokenId) : null;
    if (tgt) {
      const tx = tgt.center?.x ?? tgt.x, ty = tgt.center?.y ?? tgt.y;
      angleDeg = Math.round(Math.atan2(ty - oy, tx - ox) * 180 / Math.PI);
      const distM = (Math.hypot(tx - ox, ty - oy) / gridSize) * gridDist;
      band = distM <= 6 ? "Short" : (distM <= 25 ? "Medium" : "Long");   // CP2020 close / medium / long
      lengthM = Math.max(2, distM);
    }

    const widthM = band === "Short" ? Number(payload.spreadWidthShort ?? 1)
                 : band === "Long"  ? Number(payload.spreadWidthLong  ?? 3)
                 :                     Number(payload.spreadWidthMedium ?? 2);
    const dmgFormula =
      (band === "Short" ? payload.spreadDamageShort : band === "Long" ? payload.spreadDamageLong : payload.spreadDamageMedium)
      || (band === "Short" ? "4d6" : band === "Long" ? "2d6" : "3d6");   // Core defaults

    const weaponName = payload.weaponName ?? localize("WpnShotgun");
    // Create via the core-agnostic shim (MeasuredTemplate ray on v13, Region polygon on v14).
    const handle = await createArea(scene, {
      kind: "ray",
      x: ox, y: oy, dirDeg: angleDeg, lengthM, widthM,
      color: "#ffaa00", borderColor: "#cc6600",
      flags: {
        isSpreadZone: true, dmgFormula, band, attackerId, originX: ox, originY: oy,
        ap: Boolean(payload.ap), edged: Boolean(payload.edged),
        armorMultSoft: Number(payload.armorMultSoft ?? 1), armorMultHard: Number(payload.armorMultHard ?? 1),
        penDamageMult: Number(payload.penDamageMult ?? 1), weaponName, createdRound: game.combat?.round ?? 0,
      },
    });
    if (!handle?.doc) { console.warn("CP2020 | Spread area creation failed"); return; }

    const spreadCard = await (foundry?.applications?.handlebars?.renderTemplate ?? renderTemplate)(
      "modules/cp2020-augmented/templates/chat/spread-confirm.hbs",
      { weaponName, band, widthM, dmgFormula, templateId: handle.doc.id }
    );
    await ChatMessage.create({
      content: spreadCard,
      speaker: ChatMessage.getSpeaker({ actor: attackerId ? (game.actors.get(attackerId) ?? undefined) : undefined }),
    });
}

/** Apply spread damage to every token in the confirmed pattern (no evasion — buckshot just hits). */
async function _confirmSpreadZone(templateId) {
  if (!canvas?.scene || !templateId) return;
  if (!_claimAreaConfirm("confirmSpreadZone", { templateId }, templateId)) return;
  const scene = canvas.scene;

  // Shim lookup: works on both v13 (MeasuredTemplate) and v14 (Region).
  const handle = areaById(scene, templateId);
  if (!handle) { ui.notifications.warn(localize("SpreadTemplateNotFound")); return; }
  const f = handle.doc.flags?.["cp2020-augmented"];
  if (!f?.isSpreadZone) return;

  // Origin for cover checks: stored as originX/originY in flags at creation, with a doc.x/y
  // fallback for legacy zones (v14 Regions have no top-level x/y).
  const originX = Number(f.originX ?? handle.doc.x ?? 0);
  const originY = Number(f.originY ?? handle.doc.y ?? 0);

  // Token containment via shim; exclude the attacker; apply cover check.
  const candidates = (scene.tokens?.contents ?? canvas.tokens.placeables.map(t => t.document ?? t))
    .filter(td => (td.actor ?? td.document?.actor) && (td.actor?.id ?? td.document?.actor?.id) !== f.attackerId);
  const inPattern = tokensInArea(handle, candidates);
  const tokens = inPattern.filter(td => {
    const tok = canvas?.tokens?.placeables?.find(t => (t.document?.id ?? t.id) === (td.id ?? td.document?.id)) ?? td;
    return !_isOccluded(originX, originY, tok);    // intervening cover exempts spaces behind it
  });
  if (!tokens.length) { ui.notifications.info(localize("NoTokensInSpread")); return; }

  for (const td of tokens) {
    const tok = canvas?.tokens?.placeables?.find(t => (t.document?.id ?? t.id) === (td.id ?? td.document?.id)) ?? td;
    const dmgRoll = await new Roll(f.dmgFormula || "3d6").evaluate();
    const dmg = Math.max(0, Math.floor(dmgRoll.total));
    await _applyAreaHitToToken(tok, dmg, { ...f, weaponName: localizeParam("WpnVariantSpread", { name: f.weaponName ?? localize("WpnShotgun") }) });
  }
}

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

  Hooks.on("updateCombat", async (combat, updateData) => {
    if (!game.user.isGM || updateData.round === undefined) return;
    // Active GM only — consistent with the other per-turn handlers (idempotent flag clears).
    if (game.users.activeGM?.id !== game.user.id) return;
    for (const combatant of combat.combatants) {
      if (!combatant.actor) continue;
      if ((combatant.actor.getFlag?.("cp2020-augmented", "actionCount") ?? 0) > 0) {
        await combatant.actor.unsetFlag("cp2020-augmented", "actionCount").catch(() => {});
        await combatant.actor.unsetFlag("cp2020-augmented", "actionCountRound").catch(() => {});
      }
    }
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
    let hide = false;
    try { hide = game.settings.get("cp2020-augmented", "automationNoticeHide"); } catch { return; }
    if (hide) return;
    // Not a one-time flag: the notice shows on every load until the GM ticks "Don't show this again"
    // (its checkbox sets `automationNoticeHide`), so the expanded notice reaches users who already
    // dismissed an earlier version.

    // The notice UI now lives in module/dialog/automation-notice.js — an ApplicationV2 whose markup is a
    // template, whose strings live in lang/*.json (translatable), and whose styling lives in
    // css/cyberpunk2020.css. Shown until the GM ticks "Don't show this again" (sets automationNoticeHide).
    new AutomationNotice().render({ force: true });
}

/**
 * Socket relay for player-initiated damage application.
 *
 * Players cannot call actor.update() on unowned NPCs. Instead they emit a
 * socket message; the GM's handler applies the damage with GM permissions,
 * then emits a result notification back to the requesting player.
 *
 * Two modes:
 *   "auto"     — player sends the raw payload; GM re-runs the full damage
 *                pipeline (applyAreaDamages + side effects).
 *   "resolved" — player pre-computed per-hit values in the damage dialog
 *                (armorMode override, cover SP, manual afterSP edits); GM
 *                applies the pre-resolved values directly.
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
  // Area/zone placements relayed from a non-GM firer. weaponFired/suppressiveFire fire only on the
  // firing client, so the active GM places the area on their behalf — one shape for all four effects.
  const AREA_PLACERS = {
    suppressiveFire: _placeSuppressiveZone,
    gasCloudFired:   _placeGasCloud,
    explosionFired:  _placeExplosion,
    spreadFired:     _placeSpreadZone,
  };
  // Area-Confirm clicks relayed from a non-active GM so exactly one client resolves the effect (the
  // handlers also claim the template id, so a stray double-relay is idempotent).
  const AREA_CONFIRMERS = {
    confirmExplosion:  (d) => _confirmExplosion(d.templateId),
    confirmSpreadZone: (d) => _confirmSpreadZone(d.templateId),
    confirmFireZone:   (d) => _confirmFireZone(d.args),
  };

  game.socket.on("module.cp2020-augmented", async (data) => {
    if (!game.user.isGM) {
      if (data.type === "damageApplied" && data.requesterId === game.user.id) {
        ui.notifications.info(localizeParam("DamageApplied", { amount: data.totalApplied, name: data.targetName }));
      } else if (data.type === "damageError" && data.requesterId === game.user.id) {
        ui.notifications.error(localizeParam("DamageApplyFailed", { message: data.message ?? localize("UnknownError") }));
      }
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
      const tgt = game.actors.get(data.targetActorId);
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

    const target = game.actors.get(data.targetActorId);
    if (!target) {
      console.warn("CP2020 | Socket applyDamage: target actor not found:", data.targetActorId);
      return;
    }

    let totalApplied = 0;

    try {
      if (data.mode === "auto") {
        const hits = await applyAreaDamages({
          target,
          areaDamages:   data.areaDamages,
          ap:            Boolean(data.ap),
          edged:         Boolean(data.edged),
          armorMultSoft: Number(data.armorMultSoft ?? 1.0),
          armorMultHard: Number(data.armorMultHard ?? 1.0),
          penDamageMult: Number(data.penDamageMult ?? 1.0),
          armorMode:     game.settings.get("cp2020-augmented", "damageArmorMode"),
          ablate:        game.settings.get("cp2020-augmented", "damageAblation"),
          targetTokenId: data.targetTokenId ?? null,
          dryRun:        false,
        });
        // Cyberlimb hits are soaked into limb SDP, not the wound track — they don't count toward the
        // post-hit stun/death prompt or the taser cumulative-save state (RAW: no shock/stun).
        totalApplied = hits.reduce((s, h) => s + (h.cyberlimb ? 0 : h.netDamage), 0);

        const taserEnabled = (() => { try { return game.settings.get("cp2020-augmented", "taserCumPenaltyEnabled"); } catch { return true; } })();
        if (taserEnabled && data.stunSaveOnHit && hits.some(h => h.penetrates && !h.cyberlimb)) {
          await updateTaserState(target, data);
        }

        // DOT routes by dotType (fire -> HP burn, acid -> armor degradation); see save-rolls.js.
        await applyDotFromPayload(target, hits[0]?.location ?? null, data, hits.some(h => h.penetrates));

        if (totalApplied > 0) {
          const liveTarget = game.actors.get(target.id) ?? target;
          // Resolve the target token from the threaded id (falls back to actor lookup) so the post-hit
          // prompt/status lands on the token that was hit, not an arbitrary same-actor token.
          const liveToken = data.targetTokenId ? (canvas?.tokens?.get(data.targetTokenId) ?? null)
                          : (canvas?.tokens?.placeables?.find(t => t.actor?.id === liveTarget.id) ?? null);
          const woundState = liveTarget.woundState?.() ?? 0;
          if (woundState >= 4) await postDeathSavePrompt(liveTarget, liveToken);
          else if (woundState > 0) await postStunSavePrompt(liveTarget, liveToken);
        }

      } else if (data.mode === "resolved") {
        // Apply pre-computed per-hit values from the player's damage dialog through the shared seam
        // (cyberlimb zones absorb into their SDP; totalApplied counts only flesh HP so the post-hit
        // stun/death prompt stays honest).
        const liveToken = data.targetTokenId ? (canvas?.tokens?.get(data.targetTokenId) ?? null)
                        : (canvas?.tokens?.placeables?.find(t => t.actor?.id === target.id) ?? null);
        for (const hit of data.resolvedHits) {
          const outcome = await applyLocationDamage({ target, location: hit.location, netDamage: hit.netDamage, structuralDamage: hit.afterSP, penetrates: hit.penetrates, token: liveToken });
          totalApplied += outcome.applied;

          // Ablation gates on the bullet penetrating, not on the doubled HP value.
          if (data.ablate && data.armorMode === ARMOR_MODES.FULL && hit.btmResult > 0) {
            await ablateLocationOnce(target, hit.location, data.damageType);
          }
        }

        await target.sheet?.render(false);

        const taserEnabled = (() => { try { return game.settings.get("cp2020-augmented", "taserCumPenaltyEnabled"); } catch { return true; } })();
        if (taserEnabled && data.stunSaveOnHit && data.resolvedHits.some(h => h.penetrates && !routesToSdp(target, h.location))) {
          await updateTaserState(target, data);
        }

        // DOT routes by dotType (fire -> HP burn, acid -> armor degradation); see save-rolls.js.
        await applyDotFromPayload(target, data.firstHitLocation ?? null, data, (data.resolvedHits ?? []).some(h => h.penetrates));

        if (totalApplied > 0) {
          const liveTarget = game.actors.get(target.id) ?? target;
          // Reuse liveToken (resolved above from data.targetTokenId) — re-deriving by actor id would drop
          // the threaded token and land the prompt/status on the wrong token for a multi-token actor.
          const woundState = liveTarget.woundState?.() ?? 0;
          if (woundState >= 4) await postDeathSavePrompt(liveTarget, liveToken);
          else if (woundState > 0) await postStunSavePrompt(liveTarget, liveToken);
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

async function _autoApply(payload, target) {
  if (!game.user.isGM) {
    // Route through GM socket relay — player cannot write to unowned actor documents
    game.socket.emit("module.cp2020-augmented", {
      type:             "applyDamage",
      mode:             "auto",
      requesterId:      game.user.id,
      targetActorId:    target.id,
      targetTokenId:    payload.targetTokenId ?? null,
      areaDamages:      payload.areaDamages,
      ap:               Boolean(payload.ap),
      edged:            Boolean(payload.edged),
      armorMultSoft:    Number(payload.armorMultSoft   ?? 1.0),
      armorMultHard:    Number(payload.armorMultHard   ?? 1.0),
      penDamageMult:    Number(payload.penDamageMult   ?? 1.0),
      stunSaveOnHit:    Boolean(payload.stunSaveOnHit),
      stunSaveMod:      Number(payload.stunSaveMod     ?? 0),
      dotEnabled:       Boolean(payload.dotEnabled),
      dotTurns:         Number(payload.dotTurns        ?? 0),
      dotDamageFormula: String(payload.dotDamageFormula || "1d6"),
      dotType:          String(payload.dotType         || "acid"),
      weaponName:       String(payload.weaponName      || ""),
    });
    ui.notifications.info(localize("DamageSentWaiting"));
    return;
  }

  const armorMode = game.settings.get("cp2020-augmented", "damageArmorMode");
  const ablate    = game.settings.get("cp2020-augmented", "damageAblation");

  const hits = await applyAreaDamages({
    target,
    areaDamages: payload.areaDamages,
    ap:            Boolean(payload.ap),
    edged:         Boolean(payload.edged),
    armorMultSoft: Number(payload.armorMultSoft ?? 1.0),
    armorMultHard: Number(payload.armorMultHard ?? 1.0),
    penDamageMult: Number(payload.penDamageMult ?? 1.0),
    armorMode,
    ablate,
    targetTokenId: payload.targetTokenId ?? null,
    dryRun: false,
  });

  // Cyberlimb hits soak into limb SDP, not the wound track — they don't count toward the
  // notification, the taser cumulative-save state, or the post-hit stun/death prompt (RAW: no
  // shock/stun). Mirrors the relay-compute branch in _hookSocketRelay's "auto" mode.
  const total = hits.reduce((s, h) => s + (h.cyberlimb ? 0 : h.netDamage), 0);
  ui.notifications.info(localizeParam("DamageApplied", { amount: total, name: target.name }));

  // Taser flag must be set BEFORE the save prompt — threshold reads it
  if (payload.stunSaveOnHit && hits.some(h => h.penetrates && !h.cyberlimb)) {
    const taserEnabled = (() => { try { return game.settings.get("cp2020-augmented", "taserCumPenaltyEnabled"); } catch { return true; } })();
    if (taserEnabled) await updateTaserState(target, payload);
  }

  // DOT routes by dotType (fire -> HP burn, acid -> armor degradation); see save-rolls.js.
  await applyDotFromPayload(target, hits[0]?.location ?? null, payload, hits.some(h => h.penetrates));

  if (total > 0) {
    // Honor the shot's target token (also threaded into applyAreaDamages above) so the post-hit prompt
    // lands on the token that was hit, not an arbitrary same-actor token.
    const token = payload.targetTokenId ? (canvas?.tokens?.get(payload.targetTokenId) ?? null)
                : (canvas?.tokens?.placeables?.find(t => t.actor?.id === target.id) ?? null);
    const woundState = target.woundState?.() ?? 0;
    if (woundState >= 4) {
      await postDeathSavePrompt(target, token);
    } else if (woundState > 0) {
      await postStunSavePrompt(target, token);
    }
  }
}
