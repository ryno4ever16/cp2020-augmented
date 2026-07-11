/**
 * PA Combat Sense — the CHARACTER-side bonuses (Maximum Metal p.52–53).
 *
 * A Powered Armor Trooper's PA Combat Sense already feeds the ACPA suit's initiative at FULL value while
 * piloting (module/data/vehicle-actor-data.js → system.pilotPACS → the suit's @CombatSenseMod, capped so
 * SIB + PACS ≤ 20), and a Solo's ordinary Combat Sense is correctly NOT applied in a suit. This file adds
 * the two remaining book bonuses, which live on the PILOT (a character/npc), not the suit:
 *
 *   • OUTSIDE the suit — ½ initiative (round down), no maneuver bonus (MM p.52 "very restricted when
 *     you're out of your armor"). A character only ever rolls its OWN initiative when it is NOT the suit
 *     (in a suit, the ACPA vehicle actor is the combatant and rolls with full PACS), so a character's own
 *     initiative always gains floor(PACS/2). Wired by overriding the Combatant initiative roll — the base
 *     initiative formula ("1d10 + @stats.ref.total + @CombatSenseMod + @initiativeMod + @initiativeImplantMod")
 *     lives in the system's system.json and @CombatSenseMod double-duties Initiative AND Awareness, so
 *     there is no clean initiative-only stat to fold into; the roll override appends the bonus for init only.
 *
 *   • Awareness — full PACS is added to a Trooper's Awareness/Notice rolls WHENEVER he is in Powered Armor
 *     (MM p.52). "In powered armor" = this character is the linked pilot of an ACPA suit. The base
 *     rollSkill (system module/actor/actor.js) already adds @CombatSenseMod to Awareness/Notice; we wrap it
 *     to add the piloting Trooper's full PACS on top, via its extraMod, without touching the system file.
 *
 * Both are keyed off the PA Combat Sense skill by its stable compendium _id (isPACombatSenseSkill), never
 * by name. PA Pilot (the non-Trooper alternative, MM p.53) grants the maneuver bonuses but NOT the
 * initiative bonus, so it is deliberately absent here — it is wired only into the in-suit maneuver cap
 * (vehicle-actor-data.js system.pilotPAManeuver). No feature toggle: the bonuses apply only when a pilot
 * actually has the skill (opt-in by owning it), mirroring the ungated in-suit PACS.
 */

import { localize } from "../utils.js";
import { isPACombatSenseSkill } from "../utils.js";

const SCOPE = "cp2020-augmented";
const VEHICLE_ACTOR = `${SCOPE}.vehicle`;

/** Only character/npc actors carry the pilot-side PA bonuses (the ACPA vehicle actor handles PACS itself). */
function isPilotActor(actor) {
  return actor?.type === "character" || actor?.type === "npc";
}

/** The actor's PA Combat Sense skill level (chip-aware, via the system's realSkillValue), else 0. Pure-ish. */
function paCombatSenseLevel(actor) {
  const skill = actor?.itemTypes?.skill?.find(isPACombatSenseSkill);
  if (!skill) return 0;
  const rsv = actor?.constructor?.realSkillValue;
  return typeof rsv === "function" ? (Number(rsv(skill)) || 0) : (Number(skill?.system?.level) || 0);
}

/** True when `actor` is the linked pilot of an ACPA suit (= "in powered armor" for the Awareness bonus). */
export function isPilotingAcpa(actor) {
  if (!actor?.id) return false;
  for (const a of game.actors?.contents ?? []) {
    if (a.type === VEHICLE_ACTOR && a.system?.isACPA && a.system?.pilotId === actor.id) return true;
  }
  return false;
}

/** Outside-suit initiative bonus (MM p.52): ½ the pilot's PA Combat Sense, rounded down. 0 for the suit
 *  actor / a pilot without the skill. Exported for the keeper. */
export function paInitBonus(actor) {
  if (!isPilotActor(actor)) return 0;
  return Math.floor(paCombatSenseLevel(actor) / 2);
}

/** In-suit Awareness bonus (MM p.52): the pilot's FULL PA Combat Sense, added to Awareness/Notice rolls
 *  only while piloting an ACPA. 0 otherwise. `skill` is the skill being rolled. Exported for the keeper. */
export function paAwarenessBonus(actor, skill) {
  if (!isPilotActor(actor) || !skill) return 0;
  // The system's rollSkill matches the Awareness/Notice skill by its localized name for @CombatSenseMod;
  // mirror that here so the two stay in lockstep (same skill, same detection).
  if (skill.name !== localize("SkillAwarenessNotice")) return 0;
  if (!isPilotingAcpa(actor)) return 0;
  return paCombatSenseLevel(actor);
}

let _wrapped = false;
/**
 * Install the two pilot-side wraps (idempotent). Wired from cp2020-augmented.js at init.
 *   (1) Combatant#getInitiativeRoll — append floor(PACS/2) to a pilot's OWN initiative roll (init-only).
 *   (2) Actor#rollSkill — add full PACS to a piloting Trooper's Awareness/Notice roll via its extraMod.
 * Both wrap the SYSTEM's classes (the module owns no actor.js), the same prototype-wrap technique the mech
 * overlays already use; each guarded so a re-register can't double-wrap.
 */
export function registerPaCombatSense() {
  // (1) Initiative-roll override.
  const CombatantCls = CONFIG?.Combatant?.documentClass;
  if (CombatantCls?.prototype && !CombatantCls.prototype._cpPaInitWrapped) {
    const origGetInit = CombatantCls.prototype.getInitiativeRoll;
    CombatantCls.prototype.getInitiativeRoll = function (formula) {
      const roll = origGetInit.call(this, formula);
      try {
        const bonus = paInitBonus(this.actor);
        if (bonus) return new Roll(`${roll.formula} + ${bonus}`, roll.data);
      } catch (e) { console.warn(`${SCOPE} | PA Combat Sense init bonus failed`, e); }
      return roll;
    };
    CombatantCls.prototype._cpPaInitWrapped = true;
  }

  // (2) Awareness-roll bonus (fold into extraMod so it rides the existing @CombatSenseMod path).
  const ActorCls = CONFIG?.Actor?.documentClass;
  if (ActorCls?.prototype?.rollSkill && !ActorCls.prototype._cpPaRollSkillWrapped) {
    const origRollSkill = ActorCls.prototype.rollSkill;
    ActorCls.prototype.rollSkill = function (skillId, extraMod = 0, ...rest) {
      let bonus = 0;
      try { bonus = paAwarenessBonus(this, this.items.get(skillId)); }
      catch (e) { console.warn(`${SCOPE} | PA Combat Sense awareness bonus failed`, e); }
      return origRollSkill.call(this, skillId, (Number(extraMod) || 0) + bonus, ...rest);
    };
    ActorCls.prototype._cpPaRollSkillWrapped = true;
  }
}
