/**
 * vehicle-weapons.js — Phase 5 (foundation): vehicle weapons & the PC↔vehicle firing bridge.
 *
 * Maximum Metal puts personnel weapons and vehicle weapons on the same scale via conversion
 * factors (MM p.4):
 *   Penetration Factor = round(Average Damage ÷ 10) · ×2 for any AP · ×½ for small arms (d6 damage)
 *   Armor Value = SP ÷ 20 · Body Value = SDP ÷ 20
 * and a common to-hit modifier table (MM p.4, "COMMON VEHICLE TO-HIT MODIFIERS").
 *
 * This module supplies the PURE, testable core that the mount-firing UI and the live
 * weapon-fired→vehicle routing (later in Phase 5) build on:
 *   - averageDamageFromFormula / isSmallArms  — read a weapon's damage dice
 *   - penetrationFactor / weaponToPenetration — convert a PC weapon to a vehicle Penetration
 *   - vehicleToHitModifier                    — total the MM to-hit modifiers for a shot
 *
 * The actual damage application reuses the Phase 4 resolver (applyVehicleDamageMM / ...Core).
 */

import { openSingletonDialog, localize, localizeParam } from "../utils.js";
import { effectiveVehicleRuleSystem, vehicleArcEnforcement } from "../settings.js";
import { onGlobalClick } from "../popout-compat.js";
import { gridDistanceBetween } from "../combat/rangefinding.js";
import { renderChatCard } from "../compat.js";
import { acpaMeleeDamage } from "./vehicle-acpa.js";

/** Average of a CP2020 damage formula ("2d6+1", "5d6", "1d10", "3d6+2"). PURE. */
export function averageDamageFromFormula(formula) {
  const s = String(formula ?? "").replace(/\s+/g, "");
  if (!s) return 0;
  const terms = s.match(/[+-]?[^+-]+/g) ?? [];
  let total = 0;
  for (const t of terms) {
    const m = t.match(/^([+-]?)(\d*)d(\d+)$/i);
    if (m) {
      const sign = m[1] === "-" ? -1 : 1;
      const count = m[2] === "" ? 1 : Number(m[2]);
      const faces = Number(m[3]);
      total += sign * count * (faces + 1) / 2;
    } else if (/^[+-]?\d+$/.test(t)) {
      total += Number(t);
    }
  }
  return total;
}

/** Small arms = anything using D6 for damage (MM p.4). PURE. */
export function isSmallArms(formula) {
  return /d6/i.test(String(formula ?? ""));
}

/**
 * Penetration Factor (MM p.4). PURE.
 *   round(avgDamage ÷ 10), then ×2 if AP, then ×½ if small arms (round). Floored at 0.
 */
export function penetrationFactor({ avgDamage = 0, ap = false, smallArms = false } = {}) {
  let pf = Math.round((Number(avgDamage) || 0) / 10);
  if (ap) pf *= 2;
  if (smallArms) pf = Math.round(pf * 0.5);
  return Math.max(0, pf);
}

/**
 * Convert a personnel weapon Item to a vehicle Penetration (the PC → vehicle bridge). PURE-ish:
 * reads the weapon's damage formula + AP. `apOverride` lets a caller fold in loaded-ammo AP.
 */
export function weaponToPenetration(weaponItem, { apOverride = null } = {}) {
  const sys = weaponItem?._getWeaponSystem ? weaponItem._getWeaponSystem() : (weaponItem?.system ?? {});
  const formula = sys?.damage ?? "";
  const ap = apOverride != null ? !!apOverride : !!sys?.ap;
  return penetrationFactor({ avgDamage: averageDamageFromFormula(formula), ap, smallArms: isSmallArms(formula) });
}

/**
 * Total the Maximum Metal vehicle to-hit modifiers for one shot (MM p.4). PURE.
 * A vehicle target is Large (+4); ACPA takes no size modifier. Target movement subtracts −1 per
 * full 20 mph (per full 40 mph if moving directly toward the firer).
 */
export function vehicleToHitModifier({
  targetLarge = true, targetSmall = false, isACPATarget = false,
  stationary = false, targetSpeedMph = 0, movingStraightAt = false,
  turret = false, targetingComputer = 0,
  firerMoving = false, turningToFace = false, vehicleLink = false,
  darkObscured = false, heatSeekerVsAV = false, rocketSalvo = false,
  dfb = 0,
} = {}) {
  let mod = 0;
  if (!isACPATarget) {
    if (targetLarge) mod += 4;
    if (targetSmall) mod -= 4;
  }
  if (stationary) mod += 4;
  const speed = Number(targetSpeedMph) || 0;
  if (speed > 0) mod -= Math.floor(speed / (movingStraightAt ? 40 : 20));
  if (turret) mod += 2;
  mod += Number(targetingComputer) || 0;
  if (firerMoving) mod -= 3;        // non-stabilized weapon
  if (turningToFace) mod -= 2;
  if (vehicleLink) mod += 2;
  if (darkObscured) mod -= 3;
  if (heatSeekerVsAV) mod += 4;
  if (rocketSalvo) mod -= 2;
  mod += Number(dfb) || 0;          // ACPA Direct-Fire Bonus (Reality Interface) when the suit fires
  return mod;
}

/**
 * Good Shot steps (MM p.5): +1 step per full 10 the to-hit roll cleared the target number.
 * Each step adds ½ the weapon's base penetration (handled by the Phase 4 resolver). PURE.
 */
export function goodShotSteps(toHitTotal, targetNumber) {
  const over = (Number(toHitTotal) || 0) - (Number(targetNumber) || 0);
  return over >= 0 ? Math.floor(over / 10) : 0;
}

/**
 * Multiple-rounds count (MM p.5): a high-ROF burst hits with several rounds per shot that hits.
 * ROF 30 → 5 rounds/hit, ROF 100 → 10 rounds/hit; otherwise 1. PURE.
 */
export function roundsPerHit(rof) {
  const r = Number(rof) || 0;
  if (r >= 100) return 10;
  if (r >= 30) return 5;
  return 1;
}

/**
 * Resolve a vehicle weapon's to-hit and the resulting Good Shot steps. PURE — pass the rolled d10.
 * total = 1d10 + REF + skill + the totalled to-hit modifiers; a hit needs total ≥ the target number,
 * and clears Good Shot at +1 step per full 10 over it.
 */
export function resolveVehicleToHit({ d10 = 0, ref = 0, skill = 0, mods = 0, targetNumber = 0 } = {}) {
  const total = (Number(d10) || 0) + (Number(ref) || 0) + (Number(skill) || 0) + (Number(mods) || 0);
  const tn = Number(targetNumber) || 0;
  const hit = total >= tn;
  return { total, hit, goodShotSteps: hit ? Math.max(0, Math.floor((total - tn) / 10)) : 0 };
}

/* ------------------------------------------------------------------ *
 *  Live bridge — a personnel weapon fired at a vehicle token routes   *
 *  to the Phase 4 vehicle resolver instead of the personnel pipeline. *
 * ------------------------------------------------------------------ */

const SCOPE = "cp2020-augmented";

/**
 * Resolve the firing weapon's vehicle Penetration for a weaponFired payload (Maximum Metal).
 * Ranged shots carry `weaponName`, so we resolve the actual weapon Item and use its exact
 * (average-based, small-arms-aware) Penetration. If the weapon can't be found (e.g. a melee/martial
 * payload with no weaponName), fall back to treating the rolled total as the damage sample.
 */
function _payloadPenetration(payload, totalRolled, ap) {
  const attacker = game.actors?.get(payload.attackerId ?? payload.actorId ?? "");
  if (attacker) {
    // Prefer the EXACT weapon by id — two same-named weapons with different ammo would otherwise both
    // resolve to whichever name-match is found first. Fall back to name for payloads that carry no id.
    const w = (payload.weaponId ? attacker.items.get(payload.weaponId) : null)
           ?? (payload.weaponName
                 ? (attacker.items.find(i => i.type === "weapon" && i.name === payload.weaponName)
                    ?? attacker.items.find(i => i.type === "cyberware" && i.name === payload.weaponName))
                 : null);
    if (w) return weaponToPenetration(w, { apOverride: ap });
  }
  return penetrationFactor({ avgDamage: totalRolled, ap, smallArms: false });
}

/**
 * Route a `cyberpunk2020.weaponFired` payload aimed at a vehicle actor to the vehicle resolver.
 * Core: the summed rolled damage goes through SP→SDP. Maximum Metal: the firing weapon's
 * Penetration is compared to Armor Value (front facing). Honors `vehicleDamageEnabled`.
 * @returns {Promise<boolean>} whether it handled the hit.
 */
export async function routeWeaponFiredToVehicle(payload, vehicleActor) {
  if (!vehicleActor || vehicleActor.type !== "cp2020-augmented.vehicle") return false;
  const enabled = (() => { try { return game.settings.get(SCOPE, "vehicleDamageEnabled"); } catch { return true; } })();
  if (!enabled) return false;

  let total = 0;
  for (const hits of Object.values(payload?.areaDamages ?? {})) {
    for (const h of (hits ?? [])) total += Number(h.damage ?? h.dmg) || 0;
  }
  const ap = !!payload?.ap;

  const ruleSystem = effectiveVehicleRuleSystem();
  // Imported lazily to keep the pure-math top of this module free of Phase 4 UI deps in tests.
  const VD = await import("./vehicle-damage.js");
  if (ruleSystem === "MaximumMetal") {
    const pen = _payloadPenetration(payload, total, ap);
    // ACPA's faithful SDP flow uses the actual rolled damage; pass it through (vehicles ignore it).
    await VD.applyVehicleDamageMM(vehicleActor, { basePen: pen, facing: "front", rawDamage: total });
  } else {
    await VD.applyVehicleDamageCore(vehicleActor, { rawDamage: total, ap, facing: "front" });
  }
  return true;
}

/* ------------------------------------------------------------------ *
 *  Vehicle weapon mount firing — to-hit roll + Good Shot → resolver.  *
 * ------------------------------------------------------------------ */

const FACINGS = ["front", "side", "rear", "top", "bottom"];
const GUNNER_SKILL = "HeavyWeapons";   // the usual vehicle-weapon skill; prefilled, editable

/**
 * Candidate gunners for a vehicle: its boarded crew first, then the user's owned characters/npcs.
 * A vehicle weapon is operated by a crew member, but we don't HARD-require one — drones/RPVs/remote
 * turrets fire with no occupant — so a gunner is optional; picking one prefills REF + weapon skill.
 */
function _candidateGunners(actor) {
  const boarded = (canvas?.tokens?.placeables ?? [])
    .filter(t => t.document?.flags?.[SCOPE]?.boardedVehicle === actor.id && t.actor)
    .map(t => t.actor);
  const owned = game.actors.filter(a => (a.type === "character" || a.type === "npc") && a.isOwner && !a.getFlag(SCOPE, "missileProxy"));
  const out = [], seen = new Set();
  for (const a of [...boarded, ...owned]) { if (!seen.has(a.id)) { seen.add(a.id); out.push(a); } }
  return out;
}

/**
 * Fire one of a vehicle's weapon mounts at a target. Opens a dialog to set the gunner (prefills
 * REF/skill from a crew member), the to-hit situation (the common vehicle modifiers), and the shot,
 * then rolls to-hit; on a hit it resolves Good Shot + multiple-rounds and applies damage to the
 * target vehicle via the Phase 4 resolver. Singleton + honors `vehicleDamageEnabled`.
 * @param {Actor} actor  the firing vehicle
 * @param {object} mount {name, penetration, rof, arc}; if omitted, the dialog asks for penetration/ROF
 * @returns {Promise<Dialog|null>}
 */
export async function openVehicleFireDialog(actor, mount = {}) {
  if (!actor || actor.type !== "cp2020-augmented.vehicle") return null;
  const enabled = (() => { try { return game.settings.get(SCOPE, "vehicleDamageEnabled"); } catch { return true; } })();
  if (!enabled) { ui.notifications?.warn?.(localize("Vehicle.DamageDisabled")); return null; }

  // Resolve the full vehicleWeapon Item (the sheet passes {itemId,...}); fall back to mount values.
  const item = mount.itemId ? actor.items.get(mount.itemId) : null;
  const w = item?.system ?? {};
  const wName = item?.name ?? mount.name ?? "weapon";
  const basePen = Number(w.penetration ?? mount.penetration) || 0;
  const wa = Number(w.wa) || 0;
  const rof0 = Number(w.rof ?? mount.rof) || 1;
  const rofAlt = Number(w.rofAlt) || 0;           // variable-ROF weapons ("30 OR 5"): offer a high/low fire-rate pick (MM p.5)
  const arc = w.arc ?? mount.arc ?? "turret";
  const ap = !!w.ap, heat = !!w.heat, hiEx = !!w.hiEx;
  const highDensityAP = !!w.highDensityAP;        // errata p.110: kinetic, range-immune like HEAT (weapon-level, all shells)
  const railgun = !!w.railgun;                    // errata "Armor Damage via Penetration": SP-erosion factor 0.20, not 0.60 generic AP
  const hefPenetrator = heat || hiEx;             // HEAT / Hi-Ex → Penetration not reduced by range
  const weaponRange = Number(w.range) || 0;
  const minRange = Number(w.minRange) || 0;       // missiles: fired at a target inside this → the warhead won't arm (MM p.9)
  const burst = Number(w.burst) || 0;             // Class B area weapons (HE/HEAT shells, GLs, rockets)
  const coneAngle = Number(w.coneAngle) || 0;     // Class F scatter-packs
  const scatterDice = Number(w.scatterDice) || 0; // Class F: XD6 rolled per hit target for # munitions that strike (MM p.72)
  const weaponClass = w.weaponClass ?? "directFire";
  // Indirect artillery and bombs use their own guided helpers (5g) — delegate before building the
  // direct-fire dialog.
  if (weaponClass === "artillery") { const { openIndirectFireDialog } = await import("./vehicle-ordnance.js"); return openIndirectFireDialog(actor, mount); }
  if (weaponClass === "bomb")      { const { openBombDialog } = await import("./vehicle-ordnance.js"); return openBombDialog(actor, mount); }
  const guidance = w.guidance ?? "none";          // Class C guided missiles
  const guidanceSkill = Number(w.guidanceSkill) || 0;
  const homingMethod = w.homingMethod ?? "radar";

  // Shell selection (MM p.17): a cannon/launcher with shellVariants fires a chosen round per shot —
  // the base (solid / standard) round or a Hi-Ex / HEAT variant, each with its own Penetration, burst
  // and range-immunity. The pick is PERSISTED in system.activeShell (survives + shows on the sheet).
  const baseShell = { name: "", label: localizeParam("Vehicle.FireShellBase", { weapon: wName, pen: basePen }), pen: basePen, burst, ap, heat, hiEx, warhead: w.warhead || (heat ? "heat" : "") };
  const variantShells = (Array.isArray(w.shellVariants) ? w.shellVariants : []).map(v => {
    const vname = v.name || "shell";
    const burstClause = v.burst ? localizeParam("Vehicle.FireShellBurst", { burst: v.burst }) : "";
    const warheadClause = v.heat ? localize("Vehicle.FireShellHeat") : (v.hiEx ? localize("Vehicle.FireShellHiEx") : "");
    return {
      name: vname,
      label: localizeParam("Vehicle.FireShellVariant", { name: vname, pen: Number(v.pen) || 0, burst: burstClause, warhead: warheadClause }),
      pen: Number(v.pen) || 0, burst: Number(v.burst) || 0, ap: !!v.ap, heat: !!v.heat, hiEx: !!v.hiEx,
      warhead: v.warhead || (v.heat ? "heat" : ""),   // WP/cluster/chemical/heat → resolved by the burst path (G8)
      damage: v.damage || "",   // a variant may carry its OWN dice (e.g. the Photon's power settings); else Pen-only
    };
  });
  const shells = [baseShell, ...variantShells];
  let shellIdx = shells.findIndex(s => s.name === String(w.activeShell || ""));
  if (shellIdx < 0) shellIdx = 0;

  // Target = a single targeted token (vehicle OR character — the dispatcher routes both, MM p.6 / p.8).
  const targets = [...(game.user?.targets ?? [])];
  const targetTok = targets.length === 1 ? targets[0] : null;
  const targetActor = targetTok?.actor ?? null;

  // Diegetic facing + range band + arc check from the tokens (auto; facing/range overridable below).
  const VT = await import("./vehicle-targeting.js");
  // Resolve the FIRING token. A vehicle can have several tokens on the scene (duplicates), so prefer
  // the token the user has SELECTED, and never treat the targeted token as the firer. Falling back to
  // the first matching placeable keeps single-token vehicles working. (Picking the first blindly is
  // the bug that made facing/arc read a stale token's rotation no matter which one you spun.)
  const firerCandidates = (canvas?.tokens?.placeables ?? []).filter(t => t.actor?.id === actor.id && t !== targetTok);
  const controlledFirer = (canvas?.tokens?.controlled ?? []).find(t => t.actor?.id === actor.id && t !== targetTok);
  const firerTok = controlledFirer ?? firerCandidates[0] ?? null;
  if (firerCandidates.length > 1 && !controlledFirer) {
    ui.notifications?.info?.(localizeParam("Vehicle.FireMultiToken", { actor: actor.name }));
  }
  const strictArc = vehicleArcEnforcement() === "strict";
  // Builds the arc message for a given bearing/bears result. Shared by the initial render and the
  // live recheck (below) so spinning the firing vehicle updates the warning in real time. Returns a
  // localized, CSS-class-based fragment (re-injected into #cp-vf-arcwarn via innerHTML on token move).
  const arcWarnHtml = (bearing, bears) => {
    if (bears) return "";
    const key = strictArc ? "Vehicle.ArcWarnStrict" : "Vehicle.ArcWarnSoft";
    const cls = strictArc ? "arc-warn strict" : "arc-warn soft";
    return `<div class="${cls}">${localizeParam(key, { bearing, arc })}</div>`;
  };
  let detFacing = "front", detRange = "normal", arcWarn = "";
  if (firerTok && targetTok) {
    detFacing = VT.detectFacingFromTokens(firerTok, targetTok);
    const dist = (() => { try { return gridDistanceBetween(firerTok.center, targetTok.center); } catch { return 0; } })();
    detRange = VT.rangeBand(dist, weaponRange);
    const bearing = VT.bearingFromFirer(firerTok, targetTok);
    arcWarn = arcWarnHtml(bearing, VT.mountArcBears(bearing, arc));
  }

  const isTurret = String(arc).toLowerCase().includes("turret");

  // Gunner picker — prefills REF + weapon skill from a boarded crew member (optional).
  const gunners = _candidateGunners(actor);
  const gunnersById = Object.fromEntries(gunners.map(a => [a.id, a]));
  const firstGunner = gunners[0] ?? null;
  const isAcpaFirer = !!actor.system?.isACPA;
  const acpaDfb = isAcpaFirer ? (Number(actor.system?.dfb) || 0) : 0;
  // An ACPA fires with the pilot's capped effective REF when no separate gunner is boarded.
  const ref0 = Number(firstGunner?.system?.stats?.ref?.total) || (isAcpaFirer ? (Number(actor.system?.effectiveRef) || 0) : 0);
  // ...and with the linked PILOT's weapon skill when no gunner is boarded (MM p.52). GUNNER_SKILL is
  // already "HeavyWeapons"; the field is user-editable, so the book's optional "Rifle for a two-handed
  // rifled weapon" case is left to a GM override rather than auto-detected here.
  const pilot = actor.system?.pilotId ? game.actors?.get(actor.system.pilotId) : null;
  const skill0 = firstGunner
    ? (firstGunner.getSkillVal?.(GUNNER_SKILL) ?? 0)
    : (isAcpaFirer && pilot ? (pilot.getSkillVal?.("HeavyWeapons") ?? 0) : 0);

  // Intro sentence assembled from localized clauses (target present/absent, WA auto-applied).
  const targetClause = targetActor ? localizeParam("Vehicle.FireTargetClause", { target: targetActor.name }) : localize("Vehicle.FireNoTargetClause");
  const waClause = wa ? localizeParam("Vehicle.FireWaClause", { wa: `${wa >= 0 ? "+" : ""}${wa}` }) : "";
  const intro = localizeParam("Vehicle.FireIntro", { actor: actor.name, weapon: wName, targetClause, waClause });
  const cap = (r) => r.charAt(0).toUpperCase() + r.slice(1);

  const content = await renderChatCard("vehicle/fire-dialog.hbs", {
    intro, arcWarn,
    gunnerOptions: gunners.length ? gunners.map(a => ({ value: a.id, label: a.name })) : [{ value: "", label: localize("Vehicle.GunnerNoOccupant") }],
    ref0, skill0,
    hasShells: variantShells.length > 0,
    shellOptions: shells.map((s, i) => ({ value: i, label: s.label, selected: i === shellIdx })),
    pen0: shells[shellIdx].pen, rof0,
    hasRofAlt: rofAlt > 0,
    rofModeOptions: rofAlt > 0 ? [
      { value: rof0, label: localizeParam("Vehicle.RofHigh", { rof: rof0 }), selected: true },
      { value: rofAlt, label: localizeParam("Vehicle.RofLow", { rof: rofAlt }) },
    ] : [],
    facingOptions: FACINGS.map(f => ({ value: f, label: localize("Vehicle.Facing_" + f), selected: f === detFacing })),
    rangeOptions: ["normal", "long", "extreme"].map(r => ({ value: r, label: localize("Vehicle.Range" + cap(r)), selected: r === detRange })),
    isTurret, vehicleLink: !!actor.system?.vehicleLink,
    fireControl: Number(actor.system?.fireControl) || 0,
    isAcpaFirer, acpaDfb,
  });

  const dialog = new foundry.applications.api.DialogV2({
    window: { title: localizeParam("Vehicle.FireDialogTitle", { actor: actor.name }) },
    content,
    buttons: [
      {
        action: "fire",
        label: localize("Vehicle.FireBtn"),
        default: true,
        callback: async (ev, btn, dlg) => {
          const root = dlg.element;
          const num = (id) => Number(root.querySelector(id)?.value) || 0;
          const chk = (id) => !!root.querySelector(id)?.checked;
          // Strict arc: re-check at fire time (the firer may have been rotated while the dialog was open).
          if (strictArc && firerTok && targetTok) {
            const bearing = VT.bearingFromFirer(firerTok, targetTok);
            if (!VT.mountArcBears(bearing, arc)) {
              ui.notifications?.warn?.(localizeParam("Vehicle.ArcStrictBlock", { bearing, arc }));
              return;
            }
          }
          // Resolve + persist the chosen shell (system.activeShell). The shell sets the structural
          // properties (burst, HEAT/Hi-Ex range-immunity, AP); the Pen field follows it (and any manual tweak).
          const shellSel = shells[num("#cp-vf-shell")] ?? shells[0];
          if (item && (item.system?.activeShell ?? "") !== shellSel.name) {
            try { await item.update({ "system.activeShell": shellSel.name }); } catch (e) { /* non-owner: shell stays transient for this shot */ }
          }
          // ACPA armed-melee (+FIST): the weapon's dice get the chassis Fist strike (round(STR/9) d10)
          // added on top, plus its Penetration (avg/10), when an ACPA wields an addFist weapon (MM p.70).
          // A variant with its own dice (Photon power settings) rolls those; an old Pen-only variant rolls
          // nothing (Pen drives it); the base round uses the weapon's dice.
          let dmgFormula = shellSel.damage ? shellSel.damage : (shellSel.name ? "" : (item?.system?.damage ?? ""));
          let firePen = num("#cp-vf-pen");
          if (item?.system?.addFist && actor?.system?.isACPA && !shellSel.name) {
            const effStr = Math.max(0, (Number(actor.system.str) || 0) - (Number(actor.system.strDamage) || 0));
            const fist = acpaMeleeDamage(effStr);
            if (fist.dice > 0) {
              dmgFormula = dmgFormula ? `${dmgFormula} + ${fist.formula}` : fist.formula;
              firePen += Math.max(0, Math.round((fist.dice * 5.5) / 10));
            }
          }
          await _executeVehicleFire(actor, targetActor, {
            ref: num("#cp-vf-ref"), skill: num("#cp-vf-skill"), targetNumber: num("#cp-vf-tn"),
            penetration: firePen, rof: num("#cp-vf-rof"),
            facing: root.querySelector("#cp-vf-facing")?.value || "front",
            range: root.querySelector("#cp-vf-range")?.value || "normal",
            ap: shellSel.ap, hefPenetrator: (shellSel.heat || shellSel.hiEx), heat: shellSel.heat, highDensityAP, railgun,
            damageFormula: dmgFormula,   // base round carries the weapon's dice (+ chassis FIST for armed melee)
            burst: shellSel.burst, warhead: shellSel.warhead, coneAngle, scatterDice, weaponClass, weaponRange,
            guidance, missileSkill: guidanceSkill, homingMethod, minRange,
            firerTokenId: firerTok?.id, targetTokenId: targetTok?.id,
            mods: wa + vehicleToHitModifier({
              targetLarge: targetActor ? targetActor.type === "cp2020-augmented.vehicle" : true,
              isACPATarget: !!targetActor?.system?.isACPA,
              stationary: chk("#cp-vf-stationary"), targetSpeedMph: num("#cp-vf-tspeed"),
              turret: chk("#cp-vf-turret"), vehicleLink: chk("#cp-vf-link"),
              firerMoving: chk("#cp-vf-moving"), darkObscured: chk("#cp-vf-dark"),
              targetingComputer: num("#cp-vf-other"), dfb: num("#cp-vf-dfb"),
            }),
            mountName: shellSel.name ? `${wName} (${shellSel.name})` : wName,
          });
        },
      },
      { action: "cancel", label: localize("Cancel") },
    ],
  });
  // Foundry v14 does not invoke DialogV2's `render:` config callback, so wire the dialog's live
  // controls from the lifecycle it DOES call: patch this instance's _onRender (the module's standard
  // post-render hook, mirroring the sheets). Bind-once per instance — the content is static after open.
  const _origOnRender = dialog._onRender?.bind(dialog);
  dialog._onRender = function (context, options) {
    _origOnRender?.(context, options);
    if (this._cpFireWired) return;
    this._cpFireWired = true;
    const root = this.element;
    if (!root) return;
    const gSel = root.querySelector("#cp-vf-gunner");
    const refIn = root.querySelector("#cp-vf-ref");
    const skillIn = root.querySelector("#cp-vf-skill");
    gSel?.addEventListener("change", () => {
      const g = gunnersById[gSel.value];
      if (!g) return;
      if (refIn) refIn.value = Number(g.system?.stats?.ref?.total) || 0;
      if (skillIn) skillIn.value = g.getSkillVal?.(GUNNER_SKILL) ?? 0;
    });
    // Picking a shell updates the Penetration field to that round's Pen (still hand-editable after).
    const shellSelEl = root.querySelector("#cp-vf-shell");
    const penInEl = root.querySelector("#cp-vf-pen");
    shellSelEl?.addEventListener("change", () => {
      const s = shells[Number(shellSelEl.value) || 0];
      if (s && penInEl) penInEl.value = s.pen;
    });
    // Variable-ROF weapons: picking the fire-rate mode seeds the ROF field (still hand-editable after).
    const rofModeEl = root.querySelector("#cp-vf-rofmode");
    const rofInEl = root.querySelector("#cp-vf-rof");
    rofModeEl?.addEventListener("change", () => {
      if (rofInEl) rofInEl.value = rofModeEl.value;
    });
    // Live arc recheck: spin/move the firing vehicle (or the target) and the warning updates in
    // place — no need to close and reopen. Under strict arc, also enable/disable the Fire button.
    if (firerTok && targetTok) {
      const refreshArc = () => {
        const bearing = VT.bearingFromFirer(firerTok, targetTok);
        const bears = VT.mountArcBears(bearing, arc);
        const el = dialog.element ?? root;
        const warnEl = el?.querySelector("#cp-vf-arcwarn");
        if (warnEl) warnEl.innerHTML = arcWarnHtml(bearing, bears);
        // DialogV2 buttons use data-action (not data-button)
        if (strictArc) { const fb = el?.querySelector('button[data-action="fire"]'); if (fb) fb.disabled = !bears; }
      };
      const onTokUpdate = (doc, change) => {
        if (doc.id !== firerTok.id && doc.id !== targetTok.id) return;
        if (change.rotation === undefined && change.x === undefined && change.y === undefined && change.elevation === undefined) return;
        refreshArc();
      };
      Hooks.on("updateToken", onTokUpdate);
      dialog._cpArcHook = onTokUpdate;
      // Clean the hook up on ANY close path (✕, Escape, or a button) by wrapping the instance
      // close() — the single path every Application close goes through. Guard against re-wraps.
      if (!dialog._cpCloseWrapped) {
        dialog._cpCloseWrapped = true;
        const origClose = dialog.close.bind(dialog);
        dialog.close = async (...args) => {
          if (dialog._cpArcHook) { Hooks.off("updateToken", dialog._cpArcHook); dialog._cpArcHook = null; }
          return origClose(...args);
        };
      }
      refreshArc();   // sync once on render (also corrects a stale singleton that was re-shown)
    }
  };
  return openSingletonDialog(`vehicle-fire:${actor.id}`, () => dialog);
}

async function _executeVehicleFire(actor, targetActor, p) {
  // Guided missiles fly for multiple turns: launch a tracked missile token; the to-hit is at impact.
  if (p.weaponClass === "missile") {
    const firerTok = p.firerTokenId ? canvas?.tokens?.get(p.firerTokenId) : null;
    const targetTok = p.targetTokenId ? canvas?.tokens?.get(p.targetTokenId) : null;
    if (firerTok && targetTok) {
      const { launchMissile } = await import("./vehicle-missile-flight.js");
      await launchMissile({ shooterToken: firerTok, targetToken: targetTok, missile: {
        guidance: p.guidance, homingMethod: p.homingMethod, penetration: p.penetration,
        ap: p.ap, heat: p.heat, hefPenetrator: p.hefPenetrator, weaponName: p.mountName,
        operatorBonus: (p.ref || 0) + (p.skill || 0), missileSkill: p.missileSkill, targetNumber: p.targetNumber,
        minRange: p.minRange,
      } });
      return { launched: true };
    }
    ui.notifications?.warn?.(localize("Vehicle.MissileNeedTokensDirect"));
  }
  const d10 = (await new Roll("1d10").evaluate());
  const res = resolveVehicleToHit({ d10: d10.total, ref: p.ref, skill: p.skill, mods: p.mods, targetNumber: p.targetNumber });
  const extraRounds = roundsPerHit(p.rof) - 1;

  const goodShot = res.goodShotSteps ? localizeParam("Vehicle.GoodShotClause", { steps: res.goodShotSteps }) : "";
  const verdict = res.hit
    ? localizeParam("Vehicle.FireHit", { total: res.total, tn: p.targetNumber, goodShot })
    : localizeParam("Vehicle.FireMiss", { total: res.total, tn: p.targetNumber });

  // On a hit with no pre-selected target, the card's apply block (the cp-vfire-apply button + its
  // data-* payload, read by registerVehicleFireHandlers) lets the GM target a token and apply the
  // same shot afterward — mirrors the personnel Apply-Damage flow.
  const content = await renderChatCard("vehicle/fire-result.hbs", {
    mountName: p.mountName,
    d10: d10.total, ref: p.ref, skill: p.skill, modsSigned: `${p.mods >= 0 ? "+" : ""}${p.mods}`, total: res.total,
    verdict,
    showApply: res.hit && !targetActor,
    pen: p.penetration, facing: p.facing, range: p.range, gs: res.goodShotSteps, rounds: extraRounds,
    ap: p.ap ? 1 : 0, hef: p.hefPenetrator ? 1 : 0, heat: p.heat ? 1 : 0, hda: p.highDensityAP ? 1 : 0, rg: p.railgun ? 1 : 0,
    weapon: p.mountName, dmg: p.damageFormula ?? "",
  });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: localizeParam("Vehicle.FireFlavor", { actor: actor.name, weapon: p.mountName }),
    content,
    rolls: [d10],
  });

  if (!res.hit || !targetActor) return res;
  // Area weapons (cone scatter-packs, burst HE/HEAT shells/rockets) hit everything in the template.
  if (p.weaponClass === "cone" || p.burst > 0) {
    await _applyAreaShot(p, res, extraRounds);
  } else {
    await _applyVehicleShot(targetActor, {
      penetration: p.penetration, facing: p.facing, range: p.range,
      goodShotSteps: res.goodShotSteps, extraRounds, ap: p.ap, hefPenetrator: p.hefPenetrator, heat: p.heat, highDensityAP: p.highDensityAP, railgun: p.railgun, weaponName: p.mountName,
      damageFormula: p.damageFormula
    });
  }
  return res;
}

/** Apply an area weapon's shot: burst (circle, centered on the target) or cone (from the firer). */
async function _applyAreaShot(p, res, extraRounds) {
  const { resolveAreaShot } = await import("./vehicle-area.js");
  const firerTok = p.firerTokenId ? canvas?.tokens?.get(p.firerTokenId) : null;
  const targetTok = p.targetTokenId ? canvas?.tokens?.get(p.targetTokenId) : null;
  const center = (t) => t ? (t.center ?? { x: t.x, y: t.y }) : null;
  // One damage roll for the whole burst/cone (one shell), so an ACPA caught in it uses real damage.
  let rawDamage = null;
  if (p.damageFormula) { try { rawDamage = (await new Roll(String(p.damageFormula)).evaluate()).total; } catch (e) { rawDamage = null; } }
  const payload = {
    scale: "penetration", penetration: p.penetration, range: p.range,
    goodShotSteps: res.goodShotSteps, extraRounds, ap: p.ap, hefPenetrator: p.hefPenetrator, heat: p.heat, highDensityAP: p.highDensityAP, railgun: p.railgun, weaponName: p.mountName, rawDamage
  };
  if (p.weaponClass === "cone") {
    const fc = center(firerTok), tc = center(targetTok);
    if (!fc || !tc) return;
    const dirDeg = Math.atan2(tc.y - fc.y, tc.x - fc.x) * 180 / Math.PI;
    await resolveAreaShot({ firerToken: firerTok, origin: fc, shape: { type: "cone", angleDeg: p.coneAngle || 60, rangeM: p.weaponRange || 15, dirDeg }, payload: { ...payload, scatterDice: p.scatterDice || 0 } });
  } else {
    const tc = center(targetTok);
    if (!tc) return;
    // Route the burst through the warhead resolver so an authored WP / cluster / chemical round
    // resolves (DOT / spread / gas) instead of a plain-HE blast. Plain HE and HEAT profiles are
    // identity ({pen, burstM}), so a solid or Hi-Ex / HEAT shell resolves exactly as before. (G8)
    const { resolveWarheadBurst } = await import("./vehicle-ordnance.js");
    await resolveWarheadBurst({ firerToken: firerTok, origin: tc, warhead: p.warhead || "", pen: p.penetration, burstM: p.burst, payload });
  }
}

/**
 * Apply a resolved vehicle shot to ANY target via the unified 5c dispatcher: a vehicle target uses
 * the Phase-4 resolver (Pen vs Armor Value), a person uses MM p.8 (Penetration vs the personal AV).
 */
async function _applyVehicleShot(targetActor, { penetration = 0, facing = "front", range = "normal", goodShotSteps = 0, extraRounds = 0, ap = false, hefPenetrator = false, heat = false, highDensityAP = false, railgun = false, weaponName = "weapon", damageFormula = "" } = {}) {
  const { dispatchAttack } = await import("./vehicle-targeting.js");
  // Roll the weapon's real damage when known so an ACPA target's SDP flow uses it (not the Pen×10 estimate).
  let rawDamage = null;
  if (damageFormula) { try { rawDamage = (await new Roll(String(damageFormula)).evaluate()).total; } catch (e) { rawDamage = null; } }
  await dispatchAttack({
    scale: "penetration", penetration, facing, range, goodShotSteps, extraRounds, ap, hefPenetrator, heat, highDensityAP, railgun, weaponName, rawDamage
  }, targetActor);
}

/** Chat handler for the "Apply to Targeted Vehicle" button on a vehicle-fire card. */
export function registerVehicleFireHandlers() {
  onGlobalClick(async (ev) => {
    const btn = ev.target.closest?.(".cp-vfire-apply");
    if (!btn || btn.disabled) return;
    ev.preventDefault();
    const targets = [...(game.user?.targets ?? [])];
    if (targets.length !== 1) { ui.notifications?.warn?.(localize("Vehicle.ApplyTargetOne")); return; }
    await _applyVehicleShot(targets[0].actor, {
      penetration: Number(btn.dataset.pen) || 0, facing: btn.dataset.facing || "front",
      range: btn.dataset.range || "normal", goodShotSteps: Number(btn.dataset.gs) || 0,
      extraRounds: Number(btn.dataset.rounds) || 0, ap: btn.dataset.ap === "1",
      hefPenetrator: btn.dataset.hef === "1", heat: btn.dataset.heat === "1", highDensityAP: btn.dataset.hda === "1", railgun: btn.dataset.rg === "1", weaponName: btn.dataset.weapon || "weapon",
      damageFormula: btn.dataset.dmg || "",
    });
  });
}
