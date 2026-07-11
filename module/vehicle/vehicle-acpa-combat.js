/**
 * vehicle-acpa-combat.js — Phase 6: stateful ACPA combat (melee dialog + per-turn ticks).
 *
 * ACPA hand-to-hand (MM p.58) strikes at VEHICLE scale: Punch/Crush/Kick roll Nd10, which we convert
 * to a vehicle Penetration (Penetration Factor = round(avgDamage/10)) and route through the unified
 * dispatcher — vehicle/ACPA target → Pen vs Armor Value, personnel target → MM p.8. Suit STR damaged
 * by criticals (strDamage) reduces the effective STR.
 */

import { acpaMeleeDamage, acpaTickStatus, acpaInitiativeRollData } from "./vehicle-acpa.js";
import { penetrationFactor } from "./vehicle-weapons.js";
import { postStunSavePrompt } from "../combat/save-rolls.js";
import { openSingletonDialog, localize, localizeParam } from "../utils.js";
import { renderChatCard, postSavePromptCard } from "../compat.js";

const SCOPE = "cp2020-augmented";
const _enabled = (k, d = true) => { try { return game.settings.get(SCOPE, k); } catch { return d; } };
let _rollDataWrapped = false;

/** The acting suit's token: prefer the selected one, else any of its tokens. */
function _firerTokenOf(actor) {
  return (canvas?.tokens?.controlled ?? []).find(t => t.actor?.id === actor.id)
      ?? canvas?.tokens?.placeables?.find(t => t.actor?.id === actor.id) ?? null;
}

/** Average of an Nd10 = N × 5.5. ACPA melee Penetration = round(avg/10). */
function _meleePen(dice) {
  return penetrationFactor({ avgDamage: (Number(dice) || 0) * 5.5 });
}

/**
 * ACPA melee dialog (MM p.58). Strike a targeted token with Punch / Crush / Kick; on a hit, the
 * vehicle-scale Penetration routes through the dispatcher. To-hit = 1d10 + pilot REF + melee skill.
 */
export async function openAcpaMeleeDialog(actor) {
  if (!actor || actor.type !== "cp2020-augmented.vehicle" || !actor.system?.isACPA) { ui.notifications?.warn?.(localize("Vehicle.AcpaMeleeOnlyAcpa")); return null; }
  if (!_enabled("vehicleDamageEnabled")) { ui.notifications?.warn?.(localize("Vehicle.DamageDisabled")); return null; }

  const targets = [...(game.user?.targets ?? [])];
  const targetTok = targets.length === 1 ? targets[0] : null;
  if (!targetTok) { ui.notifications?.warn?.(localize("Vehicle.AcpaNeedTarget")); return null; }
  const targetActor = targetTok.actor;
  const firerTok = _firerTokenOf(actor);
  const strDmg = Number(actor.system?.strDamage) || 0;
  const effStr = Math.max(0, (Number(actor.system?.str) || 0) - strDmg);
  const effRef = Number(actor.system?.effectiveRef) || 0;   // pilot REF capped by the Reflex/Control system

  const content = await renderChatCard("vehicle/acpa-melee-dialog.hbs", {
    actorName: actor.name, effStr,
    strDmgClause: strDmg ? localizeParam("Vehicle.AcpaStrDmgClause", { strDmg }) : "",
    targetName: targetActor?.name ?? targetTok.name, effRef,
  });

  const dialog = new foundry.applications.api.DialogV2({
    window: { title: localizeParam("Vehicle.AcpaMeleeDialogTitle", { actor: actor.name }) },
    content,
    buttons: [
      {
        action: "strike",
        label: localize("Vehicle.AcpaStrikeBtn"),
        default: true,
        callback: async (ev, btn, dlg) => {
          const root = dlg.element;
          const kind = root.querySelector("#cp-am-kind")?.value || "punch";
          const ref = Number(root.querySelector("#cp-am-ref")?.value) || 0;
          const skill = Number(root.querySelector("#cp-am-skill")?.value) || 0;
          const dv = Number(root.querySelector("#cp-am-dv")?.value) || 15;
          const dmg = acpaMeleeDamage(effStr, kind);
          const pen = _meleePen(dmg.dice);
          const d10 = (await new Roll("1d10").evaluate());
          const total = d10.total + ref + skill;
          const hit = total >= dv;
          const verdict = hit ? localize("Vehicle.AcpaHit") : localize("Vehicle.AcpaMiss");
          const kindName = localize("Vehicle.AcpaKind_" + kind);
          const content = await renderChatCard("vehicle/acpa-melee-result.hbs", {
            kindName, d10: d10.total, ref, skill, total, dv, verdict,
            formula: dmg.formula, pen,
          });
          await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            flavor: localizeParam("Vehicle.AcpaFlavor", { actor: actor.name, kind: kindName }),
            rolls: [d10], content,
          });
          if (hit && targetActor) {
            // Roll the strike's real damage so an ACPA target's SDP flow uses it, not the Pen×10 estimate.
            const dmgRoll = await new Roll(dmg.formula).evaluate();
            const { dispatchAttack, detectFacingFromTokens } = await import("./vehicle-targeting.js");
            const facing = (firerTok && targetTok) ? detectFacingFromTokens(firerTok, targetTok) : "front";
            await dispatchAttack({ scale: "penetration", penetration: pen, rawDamage: dmgRoll.total, facing, targetTokenId: targetTok.id, weaponName: `ACPA ${kindName}` }, targetActor);
          }
        },
      },
      { action: "cancel", label: localize("Cancel") },
    ],
  });
  return openSingletonDialog(`acpa-melee:${actor.id}`, () => dialog);
}

/** Field repair: restore an ACPA suit to full — frame SDP, SDP, power, and clear all damage/status. */
export async function repairAcpa(actor) {
  if (!actor || actor.type !== "cp2020-augmented.vehicle" || !actor.system?.isACPA) { ui.notifications?.warn?.(localize("Vehicle.RepairOnlyAcpa")); return; }
  const sys = actor.system;
  const sdpMax = Number(sys.sdp?.max) || 0;
  await actor.update({
    "system.frameSDP": { ...(sys.frameSDPMax ?? {}) },
    "system.sdp": { value: sdpMax, max: sdpMax },
    "system.strDamage": 0, "system.refDamage": 0, "system.powerHours": 24,
    "system.coolingTimer": 0, "system.heatstrokeLevel": 0, "system.interfaceOut": 0, "system.seizeUp": 0,
    "system.destroyed": false, "system.immobilized": false, "system.onFire": false,
  });
  // Un-damage every mounted system + ACPA weapon (per-system / per-weapon SDP).
  const itemRepairs = (actor.items ?? [])
    .filter(i => (i.type === "cp2020-augmented.acpaSystem" || i.type === "cp2020-augmented.vehicleWeapon") && ((Number(i.system?.sdpDamage) || 0) > 0 || i.system?.destroyed))
    .map(i => ({ _id: i.id, "system.sdpDamage": 0, "system.destroyed": false }));
  if (itemRepairs.length) await actor.updateEmbeddedDocuments("Item", itemRepairs);
  ui.notifications?.info?.(localizeParam("Vehicle.AcpaRepaired", { actor: actor.name }));
}

/**
 * Per-round ACPA status ticks (MM p.55-56): seize-up and interface-out timers count down each combat
 * round for every ACPA combatant; seize-up ending restores mobility. Active GM only (so N GMs don't
 * multiply the decrement). Cooling (minutes) is shown on the sheet and left for the GM to adjudicate.
 */
/**
 * One ACPA combatant's per-round upkeep: decay seize-up / interface-out / cooling, then — once the
 * heat build-up completes — post the linked pilot's escalating Stun/Shock Save. Exported so it's
 * directly testable without driving a full combat. Safe to call on any actor (no-ops on non-ACPA).
 */
export async function tickAcpaCombatant(actor) {
  if (!actor || actor.type !== "cp2020-augmented.vehicle" || !actor.system?.isACPA) return;
  const { updates, lines } = acpaTickStatus(actor.system);
  // Capture this BEFORE the update — actor.update() expands the dot-keys in `updates` in place.
  const heatstrokeFired = updates["system.heatstrokeLevel"] != null;
  if (Object.keys(updates).length) await actor.update(updates);
  // acpaTickStatus emits the status lines as i18n descriptors ({key, params}); localize them here
  // at the render edge so the pure logic stays game.i18n-free.
  if (lines.length) await postSavePromptCard({
    title: localizeParam("Vehicle.AcpaTickTitle", { actor: actor.name }),
    body: `${lines.map(l => localizeParam(l.key, l.params ?? {})).join("; ")}.`,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
  // Heatstroke: once the build-up completes, the linked pilot makes a real Stun/Shock Save each round.
  if (heatstrokeFired && actor.system?.pilotId) {
    const pilot = game.actors?.get(actor.system.pilotId);
    if (pilot) await postStunSavePrompt(pilot);
  }
}

// An ACPA suit is a `vehicle` actor with no native stats, so Foundry's initiative formula
// (1d10 + @stats.ref.total + @CombatSenseMod + @initiativeMod + @initiativeImplantMod) evaluates
// to 1d10 alone. Map the suit's derived init terms into getRollData ONLY for ACPA vehicles — every
// other actor (characters, plain vehicles) is returned untouched. Weapon to-hit builds literal-number
// formulas (not @-terms), so it is unaffected by these keys.
function wrapAcpaRollData() {
  const proto = CONFIG?.Actor?.documentClass?.prototype;
  if (!proto || _rollDataWrapped) return;
  const orig = proto.getRollData;
  proto.getRollData = function () {
    const data = orig.call(this);
    try {
      if (this.type === "cp2020-augmented.vehicle" && this.system?.isACPA) {
        return Object.assign({ ...data }, acpaInitiativeRollData(this.system));
      }
    } catch (e) { console.warn(`${SCOPE} | ACPA getRollData wrap failed`, e); }
    return data;
  };
  _rollDataWrapped = true;
}

export function registerAcpaCombatHooks() {
  wrapAcpaRollData();
  Hooks.on("updateCombat", async (combat, changed) => {
    if (!game.user?.isGM || game.users?.activeGM?.id !== game.user.id) return;
    if (changed.round === undefined) return;   // once per round
    for (const c of combat.combatants ?? []) {
      await tickAcpaCombatant(c.actor);
    }
  });

  // An ACPA's effective REF + run/jump are DERIVED from its linked pilot's REF and MA (prepareDerivedData
  // reads the pilot actor). Foundry only re-derives a suit when the SUIT itself changes, not when the
  // PILOT does — so a pilot REF or MA change left the suit's derived stats stale until an unrelated
  // re-prepare. Re-derive + refresh any suit linked to a pilot whose stats just changed. (A PA Combat
  // Sense skill-item add/remove is NOT caught here — the suit picks it up on its next prepare/reset.)
  // Derived data is per-client, so every client runs it.
  Hooks.on("updateActor", (actor, changed) => {
    if (!actor || actor.type === "cp2020-augmented.vehicle") return;   // pilots (non-suit actors) only
    if (!foundry.utils.hasProperty(changed, "system.stats")) return;
    for (const suit of game.actors ?? []) {
      if (suit.type !== "cp2020-augmented.vehicle" || suit.system?.pilotId !== actor.id) continue;
      suit.reset();                                        // recompute derived data (effectiveRef)
      if (suit.sheet?.rendered) suit.sheet.render(false);  // refresh an open suit sheet
    }
  });
}
