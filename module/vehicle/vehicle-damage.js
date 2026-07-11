/**
 * vehicle-damage.js — Phase 4: the vehicle damage resolver.
 *
 * Two toggle-selectable systems (the `vehicleRuleSystem` setting), mirroring the control resolver:
 *
 *   CORE — "Vehicles in FNFF", CP2020 p.112.
 *     SP is subtracted from incoming damage; the remainder comes off SDP. At 0 SDP the vehicle is
 *     destroyed. Crash/ram: (speed÷20, round down) d6 × Weight Modifier; occupants take half.
 *
 *   MAXIMUM METAL — Combat Procedure, MM p.4-6.
 *     Penetration (base + Good Shot + multiple rounds, − range falloff) is compared to the facing's
 *     Armor Value (flank rules reduce armor). If Pen − AV ≥ 0:
 *        1d10 + (Pen − AV) − Body Value  →  Damage Table:  ≤0 Surface · 1-5 Minor · 6-9 Major · 10+ Catastrophic
 *     Otherwise only a Surface-damage chance. Damage then rolls a Hit Location (+ sub-location) and
 *     applies the severity's crit effects (system destroyed %, fuel fire, engine/ammo explosion,
 *     crew dice). A Damage Control system ignores a hit on a 1d10 of 6-10.
 *
 * As with the control resolver, the math is split into PURE functions that take the rolled die
 * faces as arguments, so the whole resolution is unit-testable without a UI. The dialog at the
 * bottom rolls the dice, calls these, applies the result to the actor, and posts a chat card.
 */

import { openSingletonDialog, localize, localizeParam } from "../utils.js";
import { effectiveVehicleRuleSystem } from "../settings.js";
import { renderChatCard } from "../compat.js";
import { acpaBodyArea, externalSystemHit, acpaSystemHit, acpaRollAgain, acpaCriticalEffect, acpaCriticalUpdate, acpaAreaSDP, systemIntegrity } from "./vehicle-acpa.js";
import { acpaHitSystem, acpaSystemSdp } from "./vehicle-acpa-systems.js";
import { computeNetDamage, applyLocationDamage } from "../combat/DamageApplicator.js";

const SCOPE = "cp2020-augmented";

/* --------------------------------- CORE (p.112) --------------------------------- */

/** Core damage: SP subtracted (AP halves SP), remainder off SDP. PURE. */
export function coreVehicleDamage({ rawDamage = 0, sp = 0, currentSDP = 0, ap = false } = {}) {
  const dmg = Math.max(0, Number(rawDamage) || 0);
  const spVal = Math.max(0, Number(sp) || 0);
  const effSP = ap ? Math.floor(spVal / 2) : spVal;
  const through = Math.max(0, dmg - effSP);
  const newSDP = (Number(currentSDP) || 0) - through;
  return { spUsed: effSP, through, newSDP: Math.max(0, newSDP), destroyed: newSDP <= 0 };
}

/** Weight Modifier table (Core p.112 / MM p.11): crash/ram damage multiplier by mass class. */
export const WEIGHT_MOD = { vlight: 0.5, light: 1, medium: 2, heavy: 3, vheavy: 4 };

/**
 * Core crash/ram (p.112): (speed÷20, round down) d6, × weight modifier; occupants take half the
 * dice. PURE shape — returns the dice plan; the caller rolls `numD6`d6 and multiplies. `rolled` is
 * an optional pre-rolled d6 total for deterministic resolution.
 */
export function coreCrashDamage({ speed = 0, weightClass = "light", rolled = null } = {}) {
  const numD6 = Math.floor((Number(speed) || 0) / 20);
  const mult = WEIGHT_MOD[weightClass] ?? 1;
  const out = { numD6, weightMult: mult };
  if (rolled != null) {
    out.vehicleDamage = Math.floor((Number(rolled) || 0) * mult);
    out.occupantDamage = Math.floor(out.vehicleDamage / 2);
  }
  return out;
}

/* ------------------------------ MAXIMUM METAL (p.4-6) ------------------------------ */

/**
 * Effective penetration (MM p.4 step 2). PURE.
 *   - Good Shot: +½ base Pen per full 10 the to-hit cleared the target number (per step).
 *   - Multiple rounds: +¼ base Pen per extra round hitting the same area (round off).
 *   - Range: −25% at Long, −50% at Extreme (applied last), unless HE penetrators.
 *   - High-density AP (errata p.110): a dense kinetic penetrator does "full damage through armor like
 *     HEAT" → its Penetration is range-immune too (full Pen at every band). Unlike HEAT it is kinetic,
 *     so Composite/Reactive armor (handled by the caller) do not reduce it.
 */
export function mmEffectivePenetration({ basePen = 0, goodShotSteps = 0, extraRounds = 0, range = "normal", hefPenetrator = false, highDensityAP = false } = {}) {
  const base = Math.max(0, Number(basePen) || 0);
  let pen = base;
  pen += Math.round(base * 0.5) * Math.max(0, Number(goodShotSteps) || 0);
  pen += Math.round(base * 0.25) * Math.max(0, Number(extraRounds) || 0);
  if (!hefPenetrator && !highDensityAP) {
    if (range === "long") pen = Math.round(pen * 0.75);
    else if (range === "extreme") pen = Math.round(pen * 0.5);
  }
  return Math.max(0, pen);
}

/**
 * Reactive Armor (MM p.23). Explosive tiles that detonate outward against a shaped-charge jet.
 * Only a shaped-charge (HEAT) attack triggers the deflection roll: roll 1D10, and on a 2-10 the
 * tile fires and halves the Penetration. The roll is reduced by 1 for every TWO prior shaped-charge
 * OR high-explosive hits the vehicle has absorbed (the tiles are consumed), so a fresh array is ~90%
 * effective and degrades toward useless until rearmed ("Replace"). High-explosive hits do not fire a
 * tile but still consume one (they count toward the wear). PURE: takes the d10 value, returns the
 * outcome + the new running hit count; the caller rolls, applies the halving, and persists the count.
 *
 *   reactiveDeflection({ installed, heat, hiEx, priorHits, d10 })
 *     → { fired, deflected, subtract, newHits }
 */
export function reactiveDeflection({ installed = false, heat = false, hiEx = false, priorHits = 0, d10 = 0 } = {}) {
  const prior = Math.max(0, Math.floor(Number(priorHits) || 0));
  const consumes = installed && (!!heat || !!hiEx);          // shaped OR high-explosive wears a tile
  const newHits = prior + (consumes ? 1 : 0);
  // Only a shaped-charge (HEAT) attack actually triggers the deflection roll.
  if (!installed || !heat) return { fired: false, deflected: false, subtract: 0, newHits };
  const subtract = Math.floor(prior / 2);
  const deflected = ((Number(d10) || 0) - subtract) >= 2;    // 2-10 after wear → tile fires
  return { fired: true, deflected, subtract, newHits };
}

/** Flank armor (MM p.4 step 2C): side = 75% (round up), top/rear/bottom = 50% (round up). PURE. */
export function mmEffectiveArmor(armorValue, facing = "front") {
  const av = Math.max(0, Number(armorValue) || 0);
  switch (facing) {
    case "side":   return Math.ceil(av * 0.75);
    case "top":
    case "rear":
    case "back":
    case "bottom": return Math.ceil(av * 0.5);
    default:       return av;   // front
  }
}

/**
 * Damage Table (MM p.4 steps 3-4). PURE: pass the rolled 1d10.
 * Pen − AV < 0 → no penetration (surface chance only). Else 1d10 + (Pen−AV) − Body → severity.
 */
export function mmDamageSeverity({ pen = 0, effectiveArmorValue = 0, bodyValue = 0, d10 = 0 } = {}) {
  const diff = (Number(pen) || 0) - (Number(effectiveArmorValue) || 0);
  if (diff < 0) return { penetrated: false, severity: "noPenetration", score: null, diff };
  const score = (Number(d10) || 0) + diff - (Number(bodyValue) || 0);
  let severity = "surface";
  if (score >= 10) severity = "catastrophic";
  else if (score >= 6) severity = "major";
  else if (score >= 1) severity = "minor";
  return { penetrated: true, severity, score, diff };
}

/** Surface damage (MM p.4 step 5). PURE: 1d10 of 7-10 damages an exposed item; basePen 3+ destroys it. */
export function mmSurfaceDamage(d10, basePen = 0) {
  const r = Number(d10) || 0;
  if (r < 7) return { itemDamaged: false };
  return { itemDamaged: true, destroyed: (Number(basePen) || 0) >= 3 };
}

/** Vehicle Hit Location (MM p.6). PURE: 1d10 with facing shift (+2 top, −1 side, −2 back/bottom). */
export function mmHitLocation(d10, facing = "front") {
  let r = Number(d10) || 0;
  if (facing === "top") r += 2;
  else if (facing === "side") r -= 1;
  else if (facing === "rear" || facing === "back" || facing === "bottom") r -= 2;
  if (r <= 0) return "Fuel";
  if (r <= 3) return "Motive Gear";
  if (r <= 7) return "Hull";
  return "Turret";
}

/** Hull/Turret sub-location (MM p.6). PURE: 1d10 with facing shift (+1 front, −1 back). */
export function mmSubLocation(d10, table = "Hull", facing = "front") {
  let r = Number(d10) || 0;
  if (facing === "front") r += 1;
  else if (facing === "rear" || facing === "back") r -= 1;
  if (table === "Turret") {
    if (r <= 2) return "Cargo/Ammo";
    if (r <= 7) return "Crew";
    if (r === 8) return "Equipment";
    return "Weapon";                       // 9-11 Weapon
  }
  if (r <= 2) return "Cargo/Ammo";
  if (r <= 4) return "Engine";
  if (r <= 7) return "Crew";
  if (r === 8) return "Equipment";
  if (r === 9) return "Weapon";
  return "Empty Space";
}

/** ACPA hit location (MM p.5-6). PURE: 1d10 with the same facing shift as the vehicle table
 *  (+2 top, −1 side, −2 rear/bottom); the book's ACPA table spans −1..12, so a rear/bottom/side
 *  hit can reach the Power Cell (roll ≤0) and a top hit skews toward Torso/Head. */
export function acpaHitLocation(d10, facing = "front") {
  let r = Number(d10) || 0;
  if (facing === "top") r += 2;
  else if (facing === "side") r -= 1;
  else if (facing === "rear" || facing === "back" || facing === "bottom") r -= 2;
  if (r <= 0) return "Power Cell";
  if (r <= 3) return "Legs";
  if (r <= 6) return "Arms";
  return "Torso/Head";
}

/** Crit effects by severity (MM p.6). destroyPct: system; enginePct: engine/ammo explosion. */
export const MM_CRIT = {
  minor:        { destroyPct: 20,  enginePct: 0,  fuelFirePct: 25, crewDice: "4d6" },
  major:        { destroyPct: 90,  enginePct: 50, fuelFirePct: 50, crewDice: "6d6" },
  catastrophic: { destroyPct: 100, enginePct: 90, fuelFirePct: 50, crewDice: "10d6" },
};

/** Damage Control (MM p.4): a hit is ignored on a 1d10 of 6-10. PURE. */
export function damageControlIgnores(d10) {
  return (Number(d10) || 0) >= 6;
}

/* ------------------------------------------------------------------ *
 *  UI wrapper — apply damage to a vehicle actor + chat card.          *
 * ------------------------------------------------------------------ */

const FACINGS = ["front", "side", "rear", "top", "bottom"];

/** Map a facing to the SP/AV key on the actor (rear/back→rear; bottom→bottom; etc.). */
function _facingKey(facing) {
  if (facing === "back") return "rear";
  return FACINGS.includes(facing) ? facing : "front";
}

/**
 * Open the vehicle-damage dialog, roll, resolve, apply to the actor, and post a chat card.
 * Honors `vehicleDamageEnabled` and branches on `vehicleRuleSystem`.
 * @returns {Promise<Dialog|null>}
 */
export async function openVehicleDamageDialog(actor) {
  if (!actor || actor.type !== "cp2020-augmented.vehicle") return null;
  const enabled = (() => { try { return game.settings.get(SCOPE, "vehicleDamageEnabled"); } catch { return true; } })();
  if (!enabled) { ui.notifications?.warn?.(localize("Vehicle.DamageDisabled")); return null; }
  const ruleSystem = effectiveVehicleRuleSystem();
  const isMM = ruleSystem === "MaximumMetal";
  const sys = actor.system ?? {};

  const facingOptions = FACINGS.map(f => ({ value: f, label: localize("Vehicle.Facing_" + f) }));
  const rangeOptions = [
    { value: "normal", label: localize("Vehicle.RangeNormal") },
    { value: "long", label: localize("Vehicle.RangeLong") },
    { value: "extreme", label: localize("Vehicle.RangeExtreme") },
  ];

  const content = await renderChatCard("vehicle/damage-dialog.hbs", {
    isMM, actorName: actor.name,
    systemLabel: localize(isMM ? "Vehicle.SystemMM" : "Vehicle.SystemCore"),
    facingOptions, rangeOptions,
  });

  const dialog = new foundry.applications.api.DialogV2({
    window: { title: localizeParam("Vehicle.DamageDialogTitle", { actor: actor.name }) },
    content,
    buttons: [
      {
        action: "apply",
        label: localize("Vehicle.ResolveBtn"),
        default: true,
        callback: async (ev, btn, dlg) => {
          const root = dlg.element;
          const num = (id) => Number(root.querySelector(id)?.value) || 0;
          const val = (id) => root.querySelector(id)?.value;
          const facing = val("#cp-vd-facing") || "front";
          const chk = (id) => !!root.querySelector(id)?.checked;
          if (isMM) {
            // Warhead flags so a hand-resolved shaped-charge / kinetic hit engages the armor rules the
            // automated fire path already applies: HEAT ½ vs Composite + Reactive deflection, Hi-Ex
            // Reactive wear, HEAT/Hi-Ex range-immunity (hefPenetrator), high-density AP, railgun erosion. (G1)
            const heat = chk("#cp-vd-heat"), hiEx = chk("#cp-vd-hiex");
            await applyVehicleDamageMM(actor, {
              basePen: num("#cp-vd-pen"), facing,
              goodShotSteps: Math.floor(Math.max(0, num("#cp-vd-overby")) / 10),
              extraRounds: num("#cp-vd-rounds"), range: val("#cp-vd-range") || "normal",
              heat, hefPenetrator: heat || hiEx,
              ap: chk("#cp-vd-ap"), highDensityAP: chk("#cp-vd-hda"), railgun: chk("#cp-vd-rg"),
            });
          } else {
            await applyVehicleDamageCore(actor, { rawDamage: num("#cp-vd-raw"), ap: !!root.querySelector("#cp-vd-ap")?.checked, facing });
          }
        },
      },
      { action: "cancel", label: localize("Cancel") },
    ],
  });
  return openSingletonDialog(`vehicle-damage:${actor.id}`, () => dialog);
}

/** Apply Core damage: subtract facing SP, reduce SDP, set destroyed; post a card. */
export async function applyVehicleDamageCore(actor, { rawDamage = 0, ap = false, facing = "front" } = {}) {
  const sys = actor.system ?? {};
  const spKey = _facingKey(facing);
  const sp = Number(sys.sp?.[spKey]) || 0;
  const currentSDP = Number(sys.sdp?.value) || 0;
  const res = coreVehicleDamage({ rawDamage, sp, currentSDP, ap });

  // Write the WHOLE sdp object — a dot-path update ("system.sdp.value") on this ObjectField wipes
  // sdp.max (and thus Body Value). Preserve max.
  await actor.update({ "system.sdp": { value: res.newSDP, max: Number(sys.sdp?.max) || 0 } });

  const body = localizeParam("Vehicle.CoreDmgBody", {
    raw: rawDamage, sp: res.spUsed, apClause: ap ? localize("Vehicle.CoreDmgApClause") : "",
    facing: localize("Vehicle.Facing_" + spKey), through: res.through,
  });
  let lines = localizeParam("Vehicle.CoreDmgSDP", { before: currentSDP, after: res.newSDP, max: Number(sys.sdp?.max) || 0 });
  if (res.destroyed) lines += `<br>${localize("Vehicle.CoreDmgDestroyed")}`;

  const content = await renderChatCard("vehicle/damage-result.hbs", {
    actorName: actor.name, systemLabel: localize("Vehicle.DamageSystemCore"), body, lines,
  });
  await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content });
  return res;
}

const _ACPA_AREA_KEY = { "Head": "head", "Right Arm": "rArm", "Left Arm": "lArm", "Right Leg": "rLeg", "Left Leg": "lLeg", "Torso": "torso" };

// Struck ACPA area → the character hit-location string the personnel damage pipeline expects. Head/Torso
// stay CAPITALIZED (computeNetDamage keys head-doubling on location === "Head"); limbs use the camelCase
// zone keys (LIMB_LOCATIONS = rArm/lArm/rLeg/lLeg). Distinct from _ACPA_AREA_KEY above, whose head/torso
// are lowercase frameSDP object keys.
const _ACPA_AREA_TO_CHAR_LOC = { "Head": "Head", "Torso": "Torso", "Right Arm": "rArm", "Left Arm": "lArm", "Right Leg": "rLeg", "Left Leg": "lLeg" };

// An ACPA resolves damage by one of two book poles selected per suit. Detailed (MM p.52-56,
// pilot-wired SOP + System-Hit) is the faithful default for a piloted suit; Quick Kill (MM p.6,
// small-vehicle severity table) is the squishy pole for an unpiloted suit or when the GM sets it.
// A per-suit override (system.acpaCombatModel — added in Unit D) wins; otherwise a linked pilot ⇒
// detailed, no pilot ⇒ quickkill (MM p.6 is the "increase survivability → use the detailed rules" note inverted).
export function acpaResolveMode(sys) {
  const flag = sys?.acpaCombatModel;
  if (flag === "quickkill" || flag === "detailed") return flag;
  return sys?.pilotId ? "detailed" : "quickkill";
}

/**
 * Faithful ACPA (powered-armor) damage (Maximum Metal p.54-56): SDP damage = incoming damage − armor
 * SP − Toughness Mod. If it gets through, roll a body area → 50% external system → System Hit Table
 * → (Critical Hit Chart on a critical). An "enclosed system" hit consumes a specific mounted system's
 * SDP (a destroyed system spills its overflow to the frame); a "chassis"/"weapons" hit goes to the
 * frame. Frame overflow spills to the pilot; a destroyed area knocks out its systems and a destroyed
 * Torso shuts the suit down.
 *
 * `rawDamage` is the actual rolled weapon damage when the payload carries it; otherwise the incoming
 * damage is estimated from the Penetration Factor (Pen ≈ avgDamage/10). Rolls its own dice (pushed to
 * `rolls`) and returns the chat header/lines + the actor updates + embedded acpaSystem Item updates.
 */
async function _resolveAcpaSopDamage(actor, sys, { pen, rawDamage, str }, rolls) {
  const roll = async (f) => { const r = await new Roll(f).evaluate(); rolls.push(r); return r; };
  const d10 = async () => (await roll("1d10")).total;
  const d100 = async () => (await roll("1d100")).total;
  const updates = {};
  const itemUpdates = [];
  let pilotDamage = 0;   // frame-breach overflow that reaches the wearer (applied to a linked pilot)
  let pilotStun = false; // a Mechanical Shock critical stuns the pilot → Stun/Shock Save
  const damaged = Array.isArray(sys.damagedSystems) ? [...sys.damagedSystems] : [];
  // A Mechanical-Shock critical (MM p.56) also deals its rolled 1d6 to a RANDOM frame area — captured here
  // and applied in the frame-consumption block below (ACPAs never track the vehicle-level sdp.value).
  let mechShockDamage = 0, mechShockAreaName = "", mechShockAreaKey = "";

  const incoming = (rawDamage != null) ? Math.max(0, Number(rawDamage) || 0) : Math.max(0, pen * 10);
  const armorSP = Number(sys.sp?.front) || 0;
  const toughness = Math.abs(Number(sys.toughness) || 0);
  const sdp = incoming - armorSP - toughness;
  const dmgSrc = (rawDamage != null) ? `${incoming} dmg` : `Pen ${pen} ≈ ${incoming} dmg`;
  const body = `${dmgSrc} − Armor SP ${armorSP} − Toughness ${toughness} = <b>${sdp}</b> SDP`;

  if (sdp <= 0) return { body, lines: `Armor + frame absorbed it — no penetration.`, updates, itemUpdates };

  const areaName = acpaBodyArea(await d10());
  const areaKey = _ACPA_AREA_KEY[areaName] ?? "torso";
  let lines = `<b>${sdp}</b> SDP to the <b>${areaName}</b>`;
  // How much SDP reaches the FRAME. A struck system (external or enclosed) may absorb it (frame/suit
  // spared) or, when destroyed, pass its overflow on.
  let frameDamage = sdp;

  // Hit the first live mounted Item (acpaSystem or ACPA weapon) matching `filterFn` in the struck
  // area; records the Item update and returns the outcome (or null if none is there). `sdp` is incoming.
  const hitMountedSystem = (filterFn) => {
    const sysItems = (actor.items?.filter(i => filterFn(i)) ?? []);
    const mounted = sysItems.map(it => ({ id: it.id, key: it.system?.catalogKey, area: it.system?.area, sdp: it.system?.sdp, sp: it.system?.sp, sdpDamage: it.system?.sdpDamage, destroyed: it.system?.destroyed }));
    const hit = acpaHitSystem(mounted, areaKey, sdp);
    if (hit.index < 0) return null;
    const struck = hit.updated[hit.index];
    const it = sysItems.find(x => x.id === struck.id);
    // Keep a reference to the pushed Item update so the Integrity Check can flip it to destroyed.
    const iu = { _id: struck.id, "system.sdpDamage": struck.sdpDamage, "system.destroyed": !!struck.destroyed };
    itemUpdates.push(iu);
    return { name: it?.name ?? "system", struck, destroyed: hit.destroyed, overflow: hit.overflow, total: acpaSystemSdp({ sdp: it?.system?.sdp, sp: it?.system?.sp }), iu };
  };

  // System Integrity Check (MM p.56): a system that ABSORBED a hit without its SDP being fully consumed
  // can still be knocked out — 25% if it has lost < ½ its SDP, 75% if ≥ ½. On failure it's inoperable
  // (marked destroyed) but the frame is still spared (it absorbed the SDP). Returns a note, or "".
  const integrityCheck = async (r) => {
    const chk = systemIntegrity({ sopLost: r.struck.sdpDamage, sopTotal: r.total });
    const pct = Math.round(chk.inopChance * 100);
    if ((await d100()) > pct) return "";
    r.iu["system.destroyed"] = true;
    return ` <span class="result-warn">Integrity check failed (${pct}%) — system knocked <b>INOPERABLE</b>.</span>`;
  };

  // 50% (5-in-10): the hit struck an EXTERNAL (unarmored) system instead of the suit proper (MM p.55).
  if (externalSystemHit(await d10())) {
    const r = hitMountedSystem(i => i.type === "cp2020-augmented.acpaSystem" && i.system?.mount === "external");
    if (r) {
      if (!r.destroyed) {
        const inopNote = await integrityCheck(r);
        lines += `<br>An <b>external system</b> (<b>${r.name}</b>) on the ${areaName} absorbed <b>${sdp}</b> SDP (now ${r.struck.sdpDamage}/${r.total}). Suit proper spared.${inopNote}`;
        return { body, lines, updates, itemUpdates };
      }
      lines += `<br>An <b>external system</b> (<b>${r.name}</b>) on the ${areaName} was <span class="result-warn">DESTROYED</span>.`;
      if (r.overflow <= 0) return { body, lines, updates, itemUpdates };
      frameDamage = r.overflow;
      lines += ` ${r.overflow} SDP overflows into the suit frame.`;
      // falls through to frame consumption with frameDamage = overflow
    } else {
      // No external system is mounted where the hit landed — it reaches the suit frame (mirrors the
      // enclosed / weapon "none mounted" branches below). Previously this returned early, so ~half of
      // penetrating hits silently dealt zero damage. frameDamage stays = sdp → frame consumption below.
      lines += `<br>The hit struck the ${areaName} where <b>no external system</b> is mounted — it reaches the suit frame.`;
    }
  } else {
    // The hit reached the suit proper — roll the System Hit Table (a 10 re-rolls into Critical/System Hit).
    let cat = acpaSystemHit(await d10());
    if (cat === "rollAgain") cat = (acpaRollAgain(await d10()) === "critical") ? "critical" : acpaSystemHit(await d10());
    if (cat === "critical") {
      const eff = acpaCriticalEffect(await d10());
      const amt = eff.formula ? (await roll(eff.formula)).total : 0;
      const { updates: cu, note } = acpaCriticalUpdate(sys, eff, amt);
      lines += `<br><span class="result-fail">CRITICAL</span> — ${eff.label}: ${note}.`;
      if (eff.type === "mechShock") {
        pilotStun = true;   // mechanical shock stuns the pilot
        // MM p.56: the shock also deals its 1d6 to a RANDOM frame area (applied in the frame block below).
        // acpaCriticalUpdate's sdp.value write is deliberately NOT merged for mechShock — ACPAs don't use it.
        mechShockDamage = amt;
        mechShockAreaName = acpaBodyArea(await d10());
        mechShockAreaKey = _ACPA_AREA_KEY[mechShockAreaName] ?? "torso";
      } else {
        Object.assign(updates, cu);   // other criticals (seize/cooling/STR/REF/power/interface) write real fields
      }
    } else if (cat === "enclosed") {
      // Per-system SDP (D-4d): the SDP damages a specific mounted, enclosed system in the struck area.
      const r = hitMountedSystem(i => i.type === "cp2020-augmented.acpaSystem" && i.system?.mount !== "external");
      if (r) {
        if (r.destroyed) {
          lines += `<br>System Hit: <b>${r.name}</b> (${areaName}) — <span class="result-warn">DESTROYED</span>.`;
          frameDamage = r.overflow;
          if (r.overflow > 0) lines += ` ${r.overflow} SDP overflows to the frame.`;
        } else {
          const inopNote = await integrityCheck(r);
          lines += `<br>System Hit: <b>${r.name}</b> (${areaName}) absorbed <b>${sdp}</b> SDP (now ${r.struck.sdpDamage}/${r.total}). Frame spared.${inopNote}`;
          frameDamage = 0;
        }
      } else {
        lines += `<br>System Hit: <b>an enclosed system</b> in the ${areaName} (none mounted there — hits the frame).`;
      }
    } else if (cat === "weapons") {
      // Per-weapon SDP (deferral B): a SDP-tracked ACPA weapon (system.sdp > 0) in the struck area
      // takes the hit; weapons without SDP data fall through to the frame.
      const r = hitMountedSystem(i => i.type === "cp2020-augmented.vehicleWeapon" && (Number(i.system?.sdp) || 0) > 0);
      if (r) {
        if (r.destroyed) {
          lines += `<br>System Hit: <b>${r.name}</b> (weapon, ${areaName}) — <span class="result-warn">DESTROYED</span>.`;
          frameDamage = r.overflow;
          if (r.overflow > 0) lines += ` ${r.overflow} SDP overflows to the frame.`;
          const dn = `${r.name} (destroyed)`;
          if (!damaged.includes(dn)) { damaged.push(dn); updates["system.damagedSystems"] = damaged; }
        } else {
          const inopNote = await integrityCheck(r);
          lines += `<br>System Hit: <b>${r.name}</b> (weapon, ${areaName}) absorbed <b>${sdp}</b> SDP (now ${r.struck.sdpDamage}/${r.total}). Frame spared.${inopNote}`;
          frameDamage = 0;
          if (inopNote) { const dn = `${r.name} (destroyed)`; if (!damaged.includes(dn)) { damaged.push(dn); updates["system.damagedSystems"] = damaged; } }
        }
      } else {
        lines += `<br>System Hit: <b>an internal weapon</b> in the ${areaName} (none mounted there — hits the frame).`;
      }
    } else {
      lines += `<br>System Hit: <b>frame (chassis)</b> in the ${areaName}.`;
    }
  }

  // Consume FRAME SDP: the struck area takes whatever reached the frame; a Mechanical-Shock critical adds its
  // 1d6 to a RANDOM area. Both consume the SAME frameSDP object, and each area's overflow spills to the pilot.
  // Initialize current SDP to full on the first hit (a freshly built/repaired suit has frameSDP = max).
  if (frameDamage > 0 || mechShockDamage > 0) {
    const max = sys.frameSDPMax ?? acpaAreaSDP(str);
    let cur = { ...(sys.frameSDP ?? {}) };
    if (Object.values(cur).every(v => !Number(v))) cur = { ...max };
    const applyFrame = (key, dmg, label) => {
      if (!(dmg > 0)) return;
      const before = Number(cur[key]) || 0;
      const remaining = before - dmg;
      cur[key] = Math.max(0, remaining);
      if (remaining < 0) { pilotDamage += -remaining; lines += `<br>${label} frame SDP ${before} → 0; <b>${-remaining}</b> overflows to the <b>pilot</b>.`; }
      else lines += `<br>${label} frame SDP ${before} → ${cur[key]}.`;
      if (cur[key] === 0) {
        lines += `<br><span class="result-warn">${label} frame destroyed — its systems are inoperable.</span>`;
        // A destroyed area knocks out the systems/weapons mounted there (MM p.61).
        for (const it of actor.items ?? []) {
          if ((it.type === "cp2020-augmented.acpaSystem" || it.type === "cp2020-augmented.vehicleWeapon")
              && it.system?.area === key && !it.system?.destroyed && !itemUpdates.some(u => u._id === it.id)) {
            itemUpdates.push({ _id: it.id, "system.destroyed": true });
            const dn = `${it.name} (destroyed)`;
            if (!damaged.includes(dn)) { damaged.push(dn); updates["system.damagedSystems"] = damaged; }
          }
        }
        if (key === "torso") {
          updates["system.destroyed"] = true;
          updates["system.immobilized"] = true;
          updates["system.sdp"] = { value: 0, max: Number(sys.sdp?.max) || 0 };
          lines += ` <span class="result-fail">TORSO DESTROYED — the suit SHUTS DOWN.</span>`;
        } else if (key === "rLeg" || key === "lLeg") {
          updates["system.immobilized"] = true;
        }
      }
    };
    applyFrame(areaKey, frameDamage, areaName);
    applyFrame(mechShockAreaKey, mechShockDamage, mechShockAreaName);
    updates["system.frameSDP"] = cur;
  }
  return { body, lines, updates, itemUpdates, pilotDamage, pilotStun, areaName };
}

/**
 * Quick Kill ACPA damage (Maximum Metal p.6, "PA in the Vehicle Combat System"): the deliberately
 * lethal pole that treats the suit like a small vehicle. Combat resolves exactly like a vehicle
 * (Penetration vs an all-around Armor Value → the small-vehicle severity table) EXCEPT hit location
 * (the ACPA location table) and damage application — ALL systems in a struck location are affected,
 * crew damage lands on the torso/head, and the power cell can be knocked out outright. Drop-in
 * interchangeable with _resolveAcpaSopDamage: identical return shape (the surface early-return omits
 * pilotDamage/pilotStun/areaName, exactly like the detailed resolver's no-penetration return).
 */
async function _resolveAcpaQuickKill(actor, sys, { pen, rawDamage, str, basePen, facing }, rolls) {
  const roll = async (f) => { const r = await new Roll(f).evaluate(); rolls.push(r); return r; };
  const d10 = async () => (await roll("1d10")).total;
  const updates = {};
  const itemUpdates = [];   // quick-kill tracks damage abstractly (system.damagedSystems), not per-item SDP
  let pilotDamage = 0;      // crew damage on a torso/head hit → the linked pilot (via the shared post-block)
  let pilotStun = false;    // quick-kill has no stun-critical path; kept for return-shape parity
  let areaName = "";
  const damaged = Array.isArray(sys.damagedSystems) ? [...sys.damagedSystems] : [];

  // Treated like a small vehicle: Body = STR/20 (already derived), Armor Value equal all directions.
  const av = Number(sys.armorValue?.front) || 0;
  const bodyValue = Number(sys.bodyValue) || 0;
  const sev = mmDamageSeverity({ pen, effectiveArmorValue: av, bodyValue, d10: await d10() });
  const body = `Pen <b>${pen}</b> vs AV <b>${av}</b> − Body ${bodyValue} <span style="opacity:0.7">(Quick Kill)</span>`;

  // No penetration, or a penetrating-but-surface result: only an exposed-item surface effect (as vehicles).
  if (!sev.penetrated || sev.severity === "surface") {
    const surf = mmSurfaceDamage(await d10(), basePen);
    const itemClause = surf.itemDamaged
      ? `an exposed item is ${surf.destroyed ? "destroyed" : "damaged (50% repairable)"}`
      : `no exposed item hit`;
    const lines = sev.penetrated
      ? `Roll ${sev.score} → <b>Surface</b>: ${itemClause}.`
      : `No penetration — <b>surface</b>: ${itemClause}.`;
    return { body, lines, updates, itemUpdates };
  }

  // Penetrating Minor/Major/Catastrophic → ACPA hit location + the location's damage effects (MM p.6).
  areaName = acpaHitLocation(await d10(), facing);
  const crit = MM_CRIT[sev.severity];
  let lines = `Roll ${sev.score} → <b>${sev.severity.toUpperCase()}</b> · location: <b>${areaName}</b>`;

  // Power Cell: 1d6, 1-4 the cell is destroyed and the suit goes powerless (MM p.6).
  if (areaName === "Power Cell") {
    const cell = (await roll("1d6")).total;
    if (cell <= 4) {
      // A dead cell leaves the suit inert (not wrecked): drop the power counter AND immobilize it —
      // powerHours is only a display/tick counter, so it does not disable the suit on its own. Not
      // `destroyed` (the chassis is intact; a Replace/repair restocks the cell).
      updates["system.powerHours"] = 0;
      updates["system.immobilized"] = true;
      lines += `<br><span class="result-fail">Power cell destroyed (rolled ${cell} ≤ 4) — the suit is powerless and cannot move.</span>`;
    } else {
      lines += `<br>Power cell hit but held (rolled ${cell} > 4).`;
    }
  }

  // Crew damage on a torso/head hit lands on the pilot (MM p.6). The shared post-block routes it through the
  // pilot's BTM/wound/save pipeline; _ACPA_AREA_TO_CHAR_LOC has no "Torso/Head" key, so it falls back to Torso.
  if (areaName === "Torso/Head") {
    const crew = (await roll(crit.crewDice)).total;
    pilotDamage = crew;
    lines += `<br>Crew (pilot) takes <b>${crit.crewDice}</b> = ${crew} to the torso.`;
  }

  // TODO(acpa-quickkill): ammo gang-fire on weapon-location hits (MM p.6) not modelled yet.
  // "ALL systems in a location are affected" (MM p.6): every acpaSystem in the struck location is hit as a
  // group. Map the location to acpaSystem area keys, then a single 1d100 vs the severity's destroy% decides
  // destroyed-vs-damaged for the whole location. Tracked abstractly in system.damagedSystems (a copy assigned
  // whole), like a regular vehicle — no per-item itemUpdates (that is the detailed pole's job).
  // The Power Cell is its OWN hit location (MM p.6) — a cell hit resolves the 1d6 cell check above and
  // nothing else. It must NOT also roll destruction of the torso-mounted systems (which only follows a
  // Torso/Head location hit); so it is deliberately absent from LOC_AREAS and skips this block entirely.
  const LOC_AREAS = { "Legs": ["rLeg", "lLeg"], "Arms": ["rArm", "lArm"], "Torso/Head": ["torso", "head"] };
  if (areaName !== "Power Cell") {
    const areaKeys = LOC_AREAS[areaName] ?? [];
    const struckSystems = actor.items?.filter(it => it.type === "cp2020-augmented.acpaSystem" && areaKeys.includes(it.system?.area)) ?? [];
    if (struckSystems.length) {
      // One 1d100 vs the severity's destroy% decides the whole location's systems (roll only when some are
      // mounted, so an empty location leaves no stray die in the log).
      const sysRoll = (await roll("1d100")).total;
      const wrecked = sysRoll <= crit.destroyPct;
      const names = [];
      let pushedAny = false;
      for (const it of struckSystems) {
        const dn = wrecked ? `${it.name} (destroyed)` : it.name;
        names.push(dn);
        if (!damaged.includes(dn)) { damaged.push(dn); pushedAny = true; }
      }
      if (pushedAny) updates["system.damagedSystems"] = damaged;
      lines += `<br>All systems in the ${areaName} ${wrecked ? `<span class="result-warn">DESTROYED</span> (rolled ${sysRoll} ≤ ${crit.destroyPct}%)` : `damaged (rolled ${sysRoll} > ${crit.destroyPct}%)`}: ${names.join(", ")}.`;
    } else {
      lines += `<br>Systems in the ${areaName}: no systems mounted there.`;
    }
  }

  // Catastrophic → the suit is demolished. Write the WHOLE sdp object (a dot-path would wipe sdp.max).
  if (sev.severity === "catastrophic") {
    updates["system.destroyed"] = true;
    updates["system.immobilized"] = true;
    updates["system.sdp"] = { value: 0, max: Number(sys.sdp?.max) || 0 };
    lines += `<br><span class="result-fail">Catastrophic — the suit is DEMOLISHED.</span>`;
  }

  return { body, lines, updates, itemUpdates, pilotDamage, pilotStun, areaName };
}

/**
 * Apply Maximum Metal damage and post a card. Vehicles use the Penetration → severity → hit-location
 * flow; powered armor (isACPA) uses the faithful SDP-damage flow (MM p.54-56). `rawDamage` is the
 * actual rolled weapon damage when the caller has it (used for ACPA); else ACPA estimates it from Pen.
 */
export async function applyVehicleDamageMM(actor, { basePen = 0, facing = "front", goodShotSteps = 0, extraRounds = 0, range = "normal", hefPenetrator = false, heat = false, highDensityAP = false, ap = false, railgun = false, rawDamage = null } = {}) {
  // Master toggle. The weaponFired auto-dispatch (dispatchAttack) reaches this resolver directly,
  // bypassing the dialog's own pre-check — so without this guard, auto-fire would write the vehicle
  // even when the GM has vehicle-damage automation disabled. No warning here (the manual dialog warns);
  // the auto-path simply no-ops.
  const _vdEnabled = (() => { try { return game.settings.get(SCOPE, "vehicleDamageEnabled"); } catch { return true; } })();
  if (!_vdEnabled) return null;

  const sys = actor.system ?? {};
  const isACPA = !!sys.isACPA;
  const avKey = _facingKey(facing);
  const av = isACPA ? (Number(sys.armorValue?.front) || 0) : (Number(sys.armorValue?.[avKey]) || 0);
  const bodyValue = Number(sys.bodyValue) || 0;

  const rolls = [];
  const d10 = async () => { const r = await new Roll("1d10").evaluate(); rolls.push(r); return r.total; };
  const updates = {};

  const penRaw = mmEffectivePenetration({ basePen, goodShotSteps, extraRounds, range, hefPenetrator, highDensityAP });
  // Composite Armor halves the Penetration of shaped-charge (HEAT) weapons (MM p.23). High-density AP
  // is kinetic, so Composite never applies to it (the !!heat gate already excludes it).
  const composite = !isACPA && !!sys.compositeArmor && !!heat;
  let pen = composite ? Math.ceil(penRaw / 2) : penRaw;

  // Reactive Armor (MM p.23): explosive tiles that may halve a shaped-charge attack on a 1d10 (2-10),
  // degraded −1 per two prior shaped/HE hits and consumed per hit (the counter persists until "Replace").
  // Stacks with Composite — each is an independent layer, so both firing → ¼ Pen. Vehicles only (!isACPA).
  const heHit = !isACPA && !!hefPenetrator && !heat;          // high-explosive (non-shaped): wears tiles only
  const reactiveOn = !isACPA && !!sys.reactiveArmor;
  let reactiveNote = "";
  if (reactiveOn && (heat || heHit)) {
    const rd = reactiveDeflection({ installed: true, heat: !!heat, hiEx: heHit, priorHits: Number(sys.reactiveHits) || 0, d10: heat ? await d10() : 0 });
    updates["system.reactiveHits"] = rd.newHits;             // a tile is consumed by every shaped/HE hit
    if (rd.fired) {
      if (rd.deflected) { pen = Math.ceil(pen / 2); reactiveNote = `, ½ Reactive${rd.subtract ? ` (worn −${rd.subtract})` : ""}`; }
      else reactiveNote = `, Reactive failed${rd.subtract ? ` (worn −${rd.subtract})` : ""}`;
    }
  }

  const effAV = isACPA ? av : mmEffectiveArmor(av, facing);

  let body = "", lines = "", sev = null;
  const damaged = Array.isArray(sys.damagedSystems) ? [...sys.damagedSystems] : [];

  if (isACPA) {
    // Powered armor resolves by one of two book poles (see acpaResolveMode): the faithful SDP-damage
    // flow (MM p.54-56) or the Quick Kill small-vehicle severity table (MM p.6).
    const mode = acpaResolveMode(sys);
    const r = (mode === "quickkill")
      ? await _resolveAcpaQuickKill(actor, sys, { pen, rawDamage, str: Number(sys.str) || 0, basePen, facing }, rolls)
      : await _resolveAcpaSopDamage(actor, sys, { pen, rawDamage, str: Number(sys.str) || 0 }, rolls);
    body = r.body;
    lines = r.lines;
    Object.assign(updates, r.updates);
    // Per-system SDP: apply damage/destruction to the struck embedded acpaSystem Item(s).
    if (r.itemUpdates?.length) await actor.updateEmbeddedDocuments("Item", r.itemUpdates);
    // Frame-breach overflow wounds the linked pilot through the REAL personnel damage pipeline
    // (− pilot's BTM, wound-severity, stun/death saves — MM p.56), NOT a raw HP write. dispatchAttack now
    // relays to the GM whenever this client can't write the pilot (G1: _canModifyAcpaPilot), so this normally
    // runs on a client that CAN — but it's wrapped defensively so a permission failure on any OTHER entry path
    // can't abort the suit-frame write + chat card below (a silent total failure); it degrades to a warning.
    // applyLocationDamage/routesToSdp also handle a full-borg pilot's SDP routing on their own.
    if (r.pilotDamage > 0 && sys.pilotId) {
      const pilot = game.actors?.get(sys.pilotId);
      if (pilot) {
        try {
          const pilotBtm = Number(pilot.system?.stats?.bt?.modifier) || 0;
          const charLoc = _ACPA_AREA_TO_CHAR_LOC[r.areaName] ?? "Torso";
          // penetrates=true → applyBTM floors the wound at 1 (it got through the frame).
          const netDamage = computeNetDamage(r.pilotDamage, pilotBtm, true, charLoc);
          // structuralDamage = the pre-BTM overflow: a full-borg PILOT (e.g. the DaiOni's Alpha) routes it
          // to zone SDP, which absorbs machinery-style with NO BTM (Core p.89); a flesh pilot ignores it and
          // takes the post-BTM netDamage on the wound track. Mirrors the personnel path (DamageApplicator).
          await applyLocationDamage({ target: pilot, location: charLoc, netDamage, structuralDamage: r.pilotDamage, penetrates: true });
        } catch (e) {
          console.warn(`${SCOPE} | ACPA pilot-overflow write failed on this client — suit damage + card still applied`, e);
          lines += `<br><span class="result-warn">Pilot overflow (${r.pilotDamage}) could not be applied on this client — a GM must apply it to the pilot.</span>`;
        }
      }
    }
    // A Mechanical Shock critical stuns the pilot → post their Stun/Shock Save (no damage, so the
    // updateActor hook above wouldn't fire it).
    if (r.pilotStun && sys.pilotId) {
      const pilot = game.actors?.get(sys.pilotId);
      if (pilot) { const { postStunSavePrompt } = await import("../combat/save-rolls.js"); await postStunSavePrompt(pilot); }
    }
  } else {
    sev = mmDamageSeverity({ pen, effectiveArmorValue: effAV, bodyValue, d10: await d10() });
    body = `Pen <b>${pen}</b> (base ${basePen}${highDensityAP ? ", high-density AP (range-immune)" : ""}${composite ? ", ½ vs Composite" : ""}${reactiveNote}) vs AV <b>${effAV}</b>${facing !== "front" ? ` (${facing} flank)` : ""} − Body ${bodyValue}`;

    if (!sev.penetrated) {
      const surf = mmSurfaceDamage(await d10(), basePen);
      lines = surf.itemDamaged
        ? `No penetration — <b>surface</b>: an exposed item is ${surf.destroyed ? "destroyed" : "damaged (50% repairable)"}.`
        : `No penetration — no surface effect.`;
    } else if (sev.severity === "surface") {
      const surf = mmSurfaceDamage(await d10(), basePen);
      lines = `Roll ${sev.score} → <b>Surface</b>: ${surf.itemDamaged ? (surf.destroyed ? "an exposed item destroyed" : "an exposed item damaged") : "no item hit"}.`;
    } else {
      // Penetrating Minor/Major/Catastrophic → hit location + crit effects.
      const loc = mmHitLocation(await d10(), facing);
      const crit = MM_CRIT[sev.severity];
      let locLine = loc;
      let subLoc = null;
      if (loc === "Hull" || loc === "Turret") {
        subLoc = mmSubLocation(await d10(), loc, facing);
        locLine = `${loc} → ${subLoc}`;
      }

      let ignored = false;
      if (sys.damageControl) ignored = damageControlIgnores(await d10());

      lines = `Roll ${sev.score} → <b>${sev.severity.toUpperCase()}</b> · location: <b>${locLine}</b>`;
      if (ignored) {
        lines += `<br><span class="result-success">Damage Control absorbed the hit (rolled 6-10) — system stays functional.</span>`;
      } else {
        if (loc === "Motive Gear") updates["system.immobilized"] = true;
        if (loc === "Fuel") {
          const fire = (await new Roll("1d100").evaluate());
          rolls.push(fire);
          if (fire.total <= crit.fuelFirePct) { updates["system.onFire"] = true; lines += `<br><span class="result-warn">Fuel ignites (rolled ${fire.total} ≤ ${crit.fuelFirePct}%) — on fire: 3d6/crew/turn, 25%/turn to explode.</span>`; }
          else lines += `<br>Fuel hit but did not ignite (rolled ${fire.total} > ${crit.fuelFirePct}%).`;
        }
        const zeroSDP = { value: 0, max: Number(sys.sdp?.max) || 0 };
        const isExplosive = (subLoc === "Engine" || subLoc === "Cargo/Ammo");
        if (isExplosive && crit.enginePct > 0) {
          const ex = await new Roll("1d100").evaluate(); rolls.push(ex);
          if (ex.total <= crit.enginePct) { updates["system.destroyed"] = true; updates["system.sdp"] = zeroSDP; lines += `<br><span class="result-fail">Engine/ammo cooks off (rolled ${ex.total} ≤ ${crit.enginePct}%) — vehicle DEMOLISHED.</span>`; }
          else lines += `<br>Engine/ammo hit but held (rolled ${ex.total} > ${crit.enginePct}%).`;
        }
        if (sev.severity === "catastrophic") { updates["system.destroyed"] = true; updates["system.sdp"] = zeroSDP; }
        const sysName = subLoc ?? loc;
        if (!damaged.includes(sysName)) { damaged.push(sysName); updates["system.damagedSystems"] = damaged; }
        lines += `<br>Crew in that area take <b>${crit.crewDice}</b>; ${crit.destroyPct}% the system is destroyed (else damaged until repaired).`;
      }

      // Crew Morale (optional MM rule): a Minor-or-worse penetrating hit shakes the crew. Roll 1d10;
      // the crew holds if their Leadership ≥ (15 − roll). The GM adjudicates a bail-out / disengage.
      const moraleOn = (() => { try { return game.settings.get(SCOPE, "vehicleMoraleEnabled"); } catch { return false; } })();
      if (moraleOn) {
        const m = await d10();
        const need = Math.max(0, 15 - m);
        lines += `<br><span class="result-note">Crew morale (Leadership + 1d10 vs 15): rolled <b>${m}</b> → crew holds if Leadership ≥ <b>${need}</b>, else they bail / disengage (GM adjudicates).</span>`;
      }
    }

    // Armor Damage via Penetration (errata "ARMOR DAMAGE VIA PENETRATION", optional): a heavy round
    // (>20mm) strips SP from the struck facing whether or not it penetrated — SP removed = factor × Pen.
    // Factors: Railgun 0.20 (hypervelocity — punches through, strips little), HEAT 0.75, AP/DPU 0.60,
    // HE 0.50 (HESH 1.00 unused — no seeded weapon). The book's per-weapon table groups a NORMAL solid
    // round with HE, so an unflagged kinetic round uses the 0.50 HE factor. Armor Value derives from SP
    // (SP/20), so sustained fire erodes AV over time.
    // Off by default; gated behind Maximum Metal being the active rule system (we are in the MM branch).
    const armorDmgOn = (() => { try { return game.settings.get(SCOPE, "vehicleArmorDamageEnabled"); } catch { return false; } })();
    if (armorDmgOn) {
      const factor = railgun ? 0.2 : (heat ? 0.75 : (heHit ? 0.5 : ((ap || highDensityAP) ? 0.6 : 0.5))); // railgun first (railguns are also ap:true); heHit = Hi-Ex (non-shaped)
      const curSP = Number(sys.sp?.[avKey]) || 0;
      const stripped = Math.min(curSP, Math.round(factor * pen));
      if (stripped > 0) {
        // Write the WHOLE sp object — a dot-path update on this ObjectField would wipe the other facings.
        const newSP = { ...(sys.sp ?? {}) };
        newSP[avKey] = curSP - stripped;
        updates["system.sp"] = newSP;
        lines += `<br><span class="result-warn">Armor erosion (errata) — <b>−${stripped} SP</b> at ${facing} (now ${newSP[avKey]} SP / AV ${Math.round(newSP[avKey] / 20)}).</span>`;
      }
    }
  }

  if (Object.keys(updates).length) await actor.update(updates);

  // `body`/`lines` are the MM/ACPA resolution narrative built above. Colour emphasis uses the shared
  // .result-* classes (no inline CSS); the prose itself is English (the rolled numbers baked in).
  // This sprawling, branch-heavy text (esp. the ACPA SDP flow) is left for a focused i18n pass —
  // the same deferral as control's loss text and acpaTickStatus's lines. Triple-stash in the template.
  const content = await renderChatCard("vehicle/damage-result.hbs", {
    actorName: actor.name,
    systemLabel: localize(isACPA ? "Vehicle.DamageSystemACPA" : "Vehicle.DamageSystemMM"),
    body, lines,
  });
  await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content, rolls });
  return { pen, effAV, isACPA, severity: sev?.severity, score: sev?.score, updates };
}
