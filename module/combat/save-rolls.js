import { onGlobalClick } from "../popout-compat.js";
import { localize, localizeParam } from "../utils.js";
import { renderChatCard } from "../compat.js";

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
function _relayStabilizedFlag(actorId) {
  if (!game.users.activeGM) {
    ui.notifications.warn(localize("StabilizeNoGM"));
    return;
  }
  game.socket.emit("module.cp2020-augmented", { type: "stabilizeFlag", actorId, requesterId: game.user.id });
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
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;
    const actor = game.actors.get(data.actorId);
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
  const enabled = (() => {
    try { return game.settings.get("cp2020-augmented", "taserCumPenaltyEnabled"); }
    catch { return true; }
  })();
  if (!enabled) return 0;
  const state = actor.getFlag?.("cp2020-augmented", "taserState");
  if (!state || state.count <= 1) return 0;
  const currentRound = game?.combat?.round ?? 0;
  // Penalty expires outside the 3-turn window. round=0 means outside combat — always active.
  if (state.round > 0 && currentRound > state.round + 2) return 0;
  return (state.count - 1) * Math.abs(state.mod ?? 2);
}

/**
 * Apply an acid DOT hit, respecting the acidDotStackMode setting.
 * Modes: "stack" extends turnsLeft at same location, "reset" overwrites, "separate" adds concurrent timer.
 * Legacy single-object dotState is transparently migrated to array format on read.
 */
export async function applyAcidDotState(target, location, turnsLeft, formula) {
  const mode = (() => { try { return game.settings.get("cp2020-augmented", "acidDotStackMode"); } catch { return "stack"; } })();
  const newEntry = { location, turnsLeft: Number(turnsLeft), formula: String(formula || "1d6") };

  if (mode === "reset") {
    await target.setFlag("cp2020-augmented", "dotState", [newEntry]);
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
}

/**
 * Apply a FIRE (incendiary) DOT hit, respecting the fireDotStackMode setting.
 * Mirrors {@link applyAcidDotState} but writes the separate `fireDotState` flag — fire burns HP
 * each turn (handled by the combat tick in damage-hooks.js), whereas acid degrades armor SP.
 * Modes: "stack" extends turnsLeft at same location, "reset" overwrites, "separate" adds a
 * concurrent timer. Legacy single-object state is transparently migrated to array form on read.
 */
export async function applyFireDotState(target, location, turnsLeft, formula) {
  const mode = (() => { try { return game.settings.get("cp2020-augmented", "fireDotStackMode"); } catch { return "stack"; } })();
  // mult halves each surviving turn so a burn diminishes: RAW API is 1d6 then 1d6/2 (Chromebook 2).
  const newEntry = { location, turnsLeft: Number(turnsLeft), formula: String(formula || "1d6"), mult: 1 };

  if (mode === "reset") {
    await target.setFlag("cp2020-augmented", "fireDotState", [newEntry]);
    return;
  }

  const raw = target.getFlag?.("cp2020-augmented", "fireDotState");
  const states = Array.isArray(raw) ? [...raw] : (raw ? [raw] : []);

  if (mode === "stack") {
    const idx = states.findIndex(s => s.location === location);
    if (idx >= 0) {
      // Re-ignite: extend duration and restore full intensity at this location.
      states[idx] = { location, turnsLeft: states[idx].turnsLeft + Number(turnsLeft), formula: String(formula || "1d6"), mult: 1 };
    } else {
      states.push(newEntry);
    }
  } else {
    states.push(newEntry);
  }
  await target.setFlag("cp2020-augmented", "fireDotState", states);
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
    const on = (() => { try { return game.settings.get("cp2020-augmented", "fireDotEnabled"); } catch { return true; } })();
    if (on) await applyFireDotState(target, location, turns, formula);
  } else {
    const on = (() => { try { return game.settings.get("cp2020-augmented", "acidArmorDotEnabled"); } catch { return true; } })();
    if (on) await applyAcidDotState(target, location, turns, formula);
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
  const base = actor.stunThreshold
    ? Math.max(1, actor.stunThreshold())
    : Math.max(1, (Number(actor.system?.stats?.bt?.total) || 0) - (actor.woundState?.() ?? 0) + 1);
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

function getWoundStateLabel(woundState) {
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

export async function postStunSavePrompt(actor, token = null) {
  const woundState   = actor.woundState?.() ?? 1;
  const threshold    = getStunThreshold(actor);
  const bt           = Number(actor.system?.stats?.bt?.total) || 0;
  const penalty      = woundState > 1 ? woundState - 1 : 0;
  const taserPenalty = _getTaserPenalty(actor);
  const tokenId      = token?.id ?? getTokenId(actor);
  const sceneId      = token?.scene?.id ?? canvas?.scene?.id ?? "";

  // Conditional deduction clauses assembled in JS (the GasCloudPenaltyClause pattern);
  // threshold is already floored to ≥ 1 by getStunThreshold, so no floored note is shown.
  const woundClause = penalty > 0      ? localizeParam("StunWoundPenaltyClause", { penalty }) : "";
  const taserClause = taserPenalty > 0 ? localizeParam("StunTaserPenaltyClause", { penalty: taserPenalty }) : "";
  const taserCount  = actor.getFlag?.("cp2020-augmented", "taserState")?.count ?? 1;

  const content = await renderChatCard("stun-save-prompt.hbs", {
    actorName: actor.name,
    woundLabel: getWoundStateLabel(woundState),
    bt, woundClause, taserClause, taserPenalty, taserCount, threshold,
    actorId: actor.id, tokenId, sceneId,
  });

  await ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor, token }),
  });
}

/**
 * Post death save prompt to chat.
 * @param {Actor}      actor
 * @param {Token|null} token
 * @param {number|null} forcedMortalLevel  Override the mortal level for this save (e.g. limb loss forces Mortal 0).
 */
export async function postDeathSavePrompt(actor, token = null, forcedMortalLevel = null) {
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
  // Refresh the actor from the collection to get the latest damage value
  const liveActor = game.actors.get(actor.id) ?? actor;
  const woundState = liveActor.woundState?.() ?? 0;
  if (woundState === 0) return;

  const liveToken = token ?? canvas?.tokens?.placeables?.find(t => t.actor?.id === liveActor.id) ?? null;

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

export async function executeStunSave({ actorId, tokenId, sceneId }) {
  const actor = game.actors.get(actorId);
  if (!actor) return;

  // Only the actor's owner or the GM may resolve this save (see _assertCanResolveSave).
  if (!_assertCanResolveSave(actor)) return;

  const threshold = getStunThreshold(actor);
  const roll      = await new Roll("1d10").evaluate();
  const result    = roll.total;
  const success   = result <= threshold;
  const woundLabel = getWoundStateLabel(actor.woundState?.() ?? 1);

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
  }
}

export async function executeDeathSave({ actorId, tokenId, sceneId, mortalLevel }) {
  const actor = game.actors.get(actorId);
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
export async function executeStabilize({ actorId }) {
  const actor = game.actors.get(actorId);
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
              _relayStabilizedFlag(actorId);
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
      });
    }

    if (deathBtn && !deathBtn.disabled) {
      ev.preventDefault();
      await executeDeathSave({
        actorId:     deathBtn.dataset.actorId,
        tokenId:     deathBtn.dataset.tokenId,
        sceneId:     deathBtn.dataset.sceneId,
        mortalLevel: Number(deathBtn.dataset.mortalLevel),
      });
    }

    if (stabilizeBtn && !stabilizeBtn.disabled) {
      ev.preventDefault();
      await executeStabilize({
        actorId: stabilizeBtn.dataset.actorId,
      });
    }
  });

  // Only the ACTIVE GM processes this — an isGM-only gate posts the death/stun prompt card twice when two
  // GMs are connected (each connected GM client fires updateCombat). Post-only; no data write.
  Hooks.on("updateCombat", async (combat, updateData) => {
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;
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

    // Death Save each turn (CP2020 p.105): Mortal + unstabilized
    const deathPerTurn = (() => {
      try { return game.settings.get("cp2020-augmented", "autoDeathSavePerTurn"); }
      catch { return false; }
    })();
    if (deathPerTurn && woundState >= 4) {
      const isStabilized = actor.getFlag?.("cp2020-augmented", "stabilized");
      if (!isStabilized) {
        await postDeathSavePrompt(actor, token);
      }
    }

    // Stun Save recovery (CP2020 p.104): unconscious characters re-roll each turn
    const stunRecovery = (() => {
      try { return game.settings.get("cp2020-augmented", "autoSaveRePrompt"); }
      catch { return false; }
    })();
    if (stunRecovery) {
      const isUnconscious = actor.statuses?.has("unconscious") ?? false;  // Set<string> in Foundry v11+
      if (isUnconscious) {
        await postStunSavePrompt(actor, token);
      }
    }
  });
}
