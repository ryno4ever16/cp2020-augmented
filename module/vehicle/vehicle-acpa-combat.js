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
import { getSkillVal, trainedMartials } from "../martial/martial.js";

const SCOPE = "cp2020-augmented";
const _enabled = (k, d = true) => { try { return game.settings.get(SCOPE, k); } catch { return d; } };
let _rollDataWrapped = false;

// MM p.60: in powered armor a PA Trooper may use Martial Arts ONLY if the Reflex/Control system is at
// least Low Boost, and never above their PA Combat Sense level. Brawling & Melee are always allowed.
// (The Reflex/Control enum lives in vehicle-acpa.js REFLEX_CONTROLS: BASIC / ADVANCED / LOW_BOOST / HIGH_BOOST.)
const MA_REFLEX_CONTROLS = new Set(["LOW_BOOST", "HIGH_BOOST"]);

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

  // Melee-skill auto-pull + Martial-Arts cap/gate (Maximum Metal p.60). The PA Trooper strikes with the
  // LINKED PILOT's own melee skill. Brawling/Melee are always available; Martial Arts is available only
  // when the Reflex/Control system is at least Low Boost (maAllowed) and, even then, is used at no higher
  // than the pilot's PA Combat Sense level (pilotPACS, already derived on the suit each prepare).
  // Read skills through the module's vendored getSkillVal/trainedMartials (base-agnostic; the same
  // readers the module uses elsewhere) — martial arts are per-STYLE skills ("Martial Arts: Karate", …),
  // so a plain getSkillVal("MartialArts") misses them; take the best trained style instead.
  const pilot = actor.system?.pilotId ? game.actors?.get(actor.system.pilotId) : null;
  const readSkill = (name) => pilot ? (Number(getSkillVal(pilot, name)) || 0) : 0;
  let bestMA = 0;
  if (pilot) {
    for (const m of (trainedMartials(pilot) ?? [])) bestMA = Math.max(bestMA, Number(getSkillVal(pilot, m.value)) || 0);
    bestMA = Math.max(bestMA, readSkill("MartialArts"));   // also honor a literal generic "Martial Arts" skill
  }
  const skillByKind = { brawling: readSkill("Brawling"), melee: readSkill("Melee"), martial: bestMA };
  // The Martial-Arts cap (MM p.60) is the pilot's MANEUVER rating — PA Combat Sense OR PA Pilot, whichever
  // is higher (pilotPAManeuver). PA Pilot grants this maneuver cap but no initiative (see vehicle-actor-data.js).
  const pacs = Math.max(0, Number(actor.system?.pilotPAManeuver ?? actor.system?.pilotPACS) || 0);
  const maAllowed = MA_REFLEX_CONTROLS.has(String(actor.system?.reflexControl || ""));

  const content = await renderChatCard("vehicle/acpa-melee-dialog.hbs", {
    actorName: actor.name, effStr,
    strDmgClause: strDmg ? localizeParam("Vehicle.AcpaStrDmgClause", { strDmg }) : "",
    targetName: targetActor?.name ?? targetTok.name, effRef,
    maAllowed, skillDefault: skillByKind.brawling,   // template renders the skill-style picker; seed its default Brawling auto-pull
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
          const kind = root.querySelector("#cp-am-kind")?.value || "punch";   // strike TYPE (punch/crush/kick) → damage
          const ref = Number(root.querySelector("#cp-am-ref")?.value) || 0;
          // Skill KIND (brawling/melee/martial) drives the to-hit skill + the Martial-Arts cap/gate (MM p.60);
          // it is independent of the strike TYPE above. Defaults to Brawling if the picker didn't render.
          const skillKind = root.querySelector("#cp-am-skillkind")?.value || "brawling";
          let skill = Number(root.querySelector("#cp-am-skill")?.value) || 0;
          let capClause = "";
          if (skillKind === "martial") {
            if (!maAllowed) {
              // Reflex/Control below Low Boost: Martial Arts is not applied (the option is normally omitted
              // from the picker — this guards a tampered DOM). Brawling/Melee are never blocked.
              skill = 0;
              capClause = ` — ${localize("Vehicle.AcpaMaBlocked")}`;
            } else if (skill > pacs) {
              // Never above PA Combat Sense (MM p.60). The CAPPED value flows into the to-hit + the card.
              capClause = ` — ${localizeParam("Vehicle.AcpaMaCapNote", { skill, pacs })}`;
              skill = pacs;
            }
          }
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
            flavor: localizeParam("Vehicle.AcpaFlavor", { actor: actor.name, kind: kindName }) + capClause,
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
  // The template renders the skill-style picker (#cp-am-skillkind) + the cap note (#cp-am-capnote). Foundry
  // v14 doesn't fire DialogV2's render: config callback, so WIRE them from a patched _onRender (the same seam
  // vehicle-weapons.js uses for its fire dialog): picking a style auto-pulls that skill's pilot value into the
  // still-editable level field, and the PA Combat Sense cap note updates live while Martial Arts exceeds it.
  const _origOnRender = dialog._onRender?.bind(dialog);
  dialog._onRender = function (context, options) {
    _origOnRender?.(context, options);
    if (this._cpMeleeWired) return;
    this._cpMeleeWired = true;
    const root = this.element;
    const picker = root?.querySelector("#cp-am-skillkind");
    const skillInput = root?.querySelector("#cp-am-skill");
    const capNote = root?.querySelector("#cp-am-capnote");
    if (!picker || !skillInput) return;
    const refreshCap = () => {
      const raw = Number(skillInput.value) || 0;
      const over = picker.value === "martial" && raw > pacs;
      if (capNote) {
        if (over) capNote.textContent = localizeParam("Vehicle.AcpaMaCapNote", { skill: raw, pacs });
        capNote.hidden = !over;
      }
    };
    // Picking a style auto-pulls that skill's pilot value (still hand-editable afterwards).
    picker.addEventListener("change", () => { skillInput.value = skillByKind[picker.value] ?? 0; refreshCap(); });
    skillInput.addEventListener("input", refreshCap);
    refreshCap();
  };

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
