/**
 * DamageApplicator.js  —  module/combat/DamageApplicator.js
 *
 * Damage sequence (CP2020 p.98-99):
 *   1. Subtract SP from raw damage (AP rounds halve SP first).
 *      Cover SP is combined as the outermost layer via the proportional table.
 *   2. If damage > SP: penetrated. Remainder is damageAfterSP.
 *   3. BTM is subtracted only when HP is actually written — NOT during dialog preview.
 *      It represents the character's toughness absorbing the hit, not a property of the armor.
 *      Minimum 1 HP if the armor was penetrated (p.99).
 *
 * This module returns damageAfterSP. BTM is applied in DamageDialog._onApply and _autoApply.
 * BTM TABLE (p.99/103): Very Weak=0  Weak=1  Average=2  Strong=3  VStrong=4  Super=5
 */

import { getArmorContributors, getArmorHardness } from "./armor-layers.js";
import { postSavePromptCard } from "../compat.js";
import { localize, localizeParam, combineArmorSP, foldArmorSP, getLimbStatus, cappedWoundDamage } from "../utils.js";
// The per-application severity cadence: N damage events on one body produce ONE progression card and
// ONE mortal prompt at the tier the application finished on (combat/severity-batch.js). Nothing here
// posts a severity card directly any more — it records, and the ledger emits when the batch closes.
import { makeSeverityBatch, recordSeverityHit, recordSeverityEvent, closeSeverityBatch, zoneGrade } from "./severity-batch.js";
import { makeCoverLedger } from "./cover.js";
import { routesToSdp, absorbCyberlimbHit } from "../mech/cyberlimb.js";
import { isFullBorg, borgArmorSP, BORG_CORE_ZONES, killBorgCore } from "../mech/borg.js";
import { typedLayerSP } from "../data/mech-item-data.js";
// The impact's audio, from the one place that owns it (fx/effects.js). This file supplies only the
// two things the rail cannot know: whether the round BEAT ARMOUR, and which zone it landed in — the
// level ladder and the burst bound are the element's own, so no caller here keeps a tally.
import { fxHitSound } from "../fx/effects.js";

export const ARMOR_MODES = {
  FULL:   "full",
  SIMPLE: "simple",
  NONE:   "none",
};

// Proportional armor table (CP2020 p.99) lives in module/utils.js `combineArmorSP` — the single
// definition shared with the borg chassis-SP fold (mech/borg.js).

/**
 * Resolve one hit against armor. Returns damageAfterSP (pre-BTM).
 * BTM is applied at apply-time in DamageDialog._onApply / _autoApply.
 * @param {number}  p.currentSP   Effective armor SP at this location
 * @param {number}  p.rawDamage   Damage before any reduction
 * @param {boolean} p.ap          Armor-piercing: halves spUsed
 * @param {string}  p.armorMode
 * @param {number}  p.coverSP        Outermost-layer cover SP (0 = none)
 * @param {number}  p.penDamageMult  Multiplier on penetrating damage (AP ×0.5, Hollow-Point ×1.5).
 *                                   Applied to the post-armor remainder, before BTM (CP2020/Chromebook).
 * @returns {{ spFull, spUsed, damageAfterSP, penetrates }}
 *
 * Exported so the armour maths can be driven DIRECTLY rather than reached through
 * `resolveAreaDamagesSync`, which is the only route a caller outside this file had: the wrapper adds
 * a roll, a location and its own fields on top, so a reading taken through it cannot isolate what
 * this function alone computed. The golden-master capture consumes the direct export.
 */
export function resolveHitMath({ currentSP, rawDamage, ap, armorMode, coverSP = 0, penDamageMult = 1 }) {
  let effectiveSP = currentSP;
  if (coverSP > 0 && armorMode !== ARMOR_MODES.NONE) {
    // Cover is the outermost layer — combined last (inside-out rule, p.99)
    effectiveSP = combineArmorSP(currentSP, coverSP);
  }

  const spFull = (armorMode === ARMOR_MODES.NONE) ? 0 : effectiveSP;
  const spUsed = (ap && armorMode !== ARMOR_MODES.NONE)
    ? Math.floor(spFull / 2)
    : spFull;

  let damageAfterSP = rawDamage - spUsed;
  const penetrates  = damageAfterSP > 0;

  // Penetrating-damage multiplier applies only to the portion that got through armor.
  // penetrated→min handled later by applyBTM (min 1 when penetrated), so floor at 0 here.
  const pen = Number(penDamageMult) || 1;
  if (penetrates && pen !== 1) {
    damageAfterSP = Math.max(0, Math.floor(damageAfterSP * pen));
  }

  return { spFull, spUsed, damageAfterSP, penetrates };
}

/**
 * Apply BTM to after-SP damage. Called at apply-time, not during dialog preview.
 * @param {number}  damageAfterSP
 * @param {number}  btm          Positive integer (0–5)
 * @param {boolean} penetrated   Whether the bullet got through armor
 * @returns {number}             Final HP damage
 */
export function applyBTM(damageAfterSP, btm, penetrated) {
  if (!penetrated) return 0;
  return Math.max(1, damageAfterSP - btm);
}

export const LIMB_LOCATIONS = new Set(["rArm", "lArm", "rLeg", "lLeg"]);

/**
 * "Groin" (W4RST4R's reference table) has no stored armor / hit-location entry. The groin is covered
 * by torso armor, so SP lookup and ablation use the Torso location at runtime (no actor-data field is
 * added). Other locations pass through unchanged. No roll produces "Groin" any more — location rolls
 * resolve on the Core map (utils.js _hitLocationLookup) — so this now only catches a value that
 * arrived from stored data or an older chat card. Kept: it costs nothing and stays correct.
 */
export function spLocationKey(location) {
  return location === "Groin" ? "Torso" : location;
}

/**
 * Active limb model from the single `limbModel` selector: "w4rst4r" → W4RST4R, "listenup" → Listen Up
 * (detailed crippling), anything else → Core. Returns "Core" when settings are unavailable. The
 * selector is exclusive by construction, so no precedence juggling is needed.
 */
export function activeLimbModel() {
  let m = "core";
  try { m = game.settings.get("cp2020-augmented", "limbModel") || "core"; } catch (e) { /* default */ }
  return m === "w4rst4r" ? "W4RST4R" : (m === "listenup" ? "ListenUp" : "Core");
}

/**
 * Final HP damage for one hit, including the location-doubling rules.
 *   - Head (headHitDoubling, CP2020 p.103): damage doubled AFTER BTM.
 *   - Limb (limbModel = "listenup", Listen Up): post-armor damage doubled BEFORE BTM —
 *     the grittier limb model where crippling thresholds are measured on the doubled value.
 * Centralized so every apply path (auto-apply, damage dialog, socket relay) is identical.
 * @param {number}  afterSP     Post-armor damage (may be a GM override)
 * @param {number}  btm
 * @param {boolean} penetrates
 * @param {string}  location
 */
export function computeNetDamage(afterSP, btm, penetrates, location) {
  let headDoubling = false;
  try { headDoubling = game.settings.get("cp2020-augmented", "headHitDoubling"); } catch (e) { /* default */ }
  // Only Listen Up doubles limb damage. W4RST4R (and Core) do not — they use the raw post-BTM net.
  const detailedLimb = activeLimbModel() === "ListenUp";

  if (detailedLimb && LIMB_LOCATIONS.has(location) && penetrates) {
    return applyBTM(afterSP * 2, btm, penetrates);   // Listen Up: double post-armor, then BTM
  }
  const btmDamage = applyBTM(afterSP, btm, penetrates);
  if (headDoubling && location === "Head" && btmDamage > 0) return btmDamage * 2;
  return btmDamage;
}

/**
 * Limb / head wound severity check (CP2020 p.103, optional Listen Up crippling).
 * Gated by limbLossEnabled; the granular variant by limbModel = "listenup".
 * Posts chat + applies status/death-save. Runs after netDamage is written, on every apply path.
 * FLESH limb state is recorded under the `fleshLimbStatus` flag — deliberately NOT the cyberlimb
 * engine's `limbStatus` (mech/cyberlimb.js, mech/borg.js), whose "destroyed"/"disabled" vocabulary
 * would otherwise be read as structural SDP state and make a fresh cyberlimb soak zero (M18).
 *
 * ⭐ IT RECORDS; IT DOES NOT POST. Every card and every mortal prompt this check used to emit per
 * damage event now goes into the application's severity ledger (combat/severity-batch.js) and is
 * emitted once when the batch closes — one progression card, one mortal prompt at the final tier. A
 * caller that hands in no ledger gets a one-event ledger built and closed here, which replays that
 * event's own card exactly as before, so every single-hit path is unchanged.
 *
 * ⭐ THE SAME-ZONE GUARD. The limb branches WRITE `fleshLimbStatus` and, until now, never read it back:
 * rounds 2..N into a zone that is already gone recorded it gone again, each with a fresh card and a
 * fresh prompt — including next turn's burst re-losing yesterday's arm. The record is now read first
 * and an outcome no worse than what is already there is not re-announced. The damage itself is
 * untouched: it was written before this ever ran.
 *
 * @param {Actor}  target
 * @param {string} location
 * @param {number} netDamage   Final HP applied (already includes any doubling)
 * @param {{token?: object, severityBatch?: object}} [opts]
 */
export async function assessWoundSeverity(target, location, netDamage, { token = null, severityBatch = null } = {}) {
  // Vehicles have no limbs/head/death saves — never run wound severity on them (they use the
  // vehicle resolver). Defense in depth alongside the applyAreaDamages redirect. Vehicle/ACPA actors
  // are the module sub-type "cp2020-augmented.vehicle" (NOT the bare "vehicle", which is an Item type).
  if (target?.type === "cp2020-augmented.vehicle") return;
  // A cyberlimb zone takes structural SDP damage, not a flesh wound — no limb-loss / death save and
  // no shock/stun (RAW, Core p.89). The hit was absorbed into the limb's SDP (mech/cyberlimb.js); the
  // flesh limb-loss logic below must not run for it. Defense in depth alongside applyLocationDamage.
  if (routesToSdp(target, location)) return;
  let limbLoss = false;
  try { limbLoss = game.settings.get("cp2020-augmented", "limbLossEnabled"); } catch (e) { /* default */ }
  if (!limbLoss) return;
  const model = activeLimbModel();   // "W4RST4R" | "ListenUp" | "Core"

  // `target` is a live document — re-fetching by id would send an unlinked token's limb flags and
  // death status to the shared world actor (synthetic actors share their base actor's id). The token
  // fallback matches by IDENTITY first so a multi-token actor resolves the token that was actually hit.
  const liveTarget = target;
  const liveToken  = token
    ?? canvas?.tokens?.placeables?.find(t => t.actor === liveTarget)
    ?? canvas?.tokens?.placeables?.find(t => t.actor?.id === liveTarget.id)
    ?? null;

  // A caller with no ledger of its own gets a one-event ledger, opened and closed around this check.
  // It does NOT own the wound-track prompt — only the four apply-loop owners do — so a lone call here
  // still emits exactly what it emitted before: this zone's own card, and the prompt the zone forces.
  const batch = severityBatch ?? makeSeverityBatch();
  const ownBatch = !severityBatch;

  // Head wound > 8 net = automatic death (Listen Up does not change the head; always Core here).
  if (location === "Head") {
    if (netDamage > 8) {
      recordSeverityEvent(batch, {
        actor: liveTarget, token: liveToken, location, status: "headAutoDeath",
        card: { template: "head-wound-death.hbs", data: { actorName: liveTarget.name, netDamage } },
      });
      // v13+: TokenDocument#toggleActiveEffect was removed — toggle the status on the Actor.
      const deadActor = liveToken?.actor ?? liveTarget;
      if (deadActor?.toggleStatusEffect) {
        await deadActor.toggleStatusEffect("dead", { active: true });
      }
    }
    if (ownBatch) await closeSeverityBatch(batch);
    return;
  }

  // Groin (W4RST4R table) is not a limb and has no head rule — it just takes damage. No-op here.
  if (!LIMB_LOCATIONS.has(location)) return;
  // Location codes (rArm/lArm/rLeg/lLeg) are themselves the i18n keys for the limb names.
  const limbName = localize(location);
  // What this zone is ALREADY recorded as, read through the one accessor every reader of the record
  // uses (utils.getLimbStatus). An outcome that is no worse than the record is not news.
  const recordedGrade = zoneGrade(getLimbStatus(liveTarget, location));

  if (model === "ListenUp") {
    // Listen Up crippling bands (measured on the doubled netDamage). No death save.
    if (netDamage >= 6) {
      const destroyed = netDamage >= 13;
      const status = destroyed ? "destroyed" : "crippled";
      if (zoneGrade(status) > recordedGrade) {
        const cur = foundry.utils.duplicate(liveTarget.getFlag("cp2020-augmented", "fleshLimbStatus") ?? {});
        cur[location] = status;
        await liveTarget.setFlag("cp2020-augmented", "fleshLimbStatus", cur).catch(() => {});
        recordSeverityEvent(batch, {
          actor: liveTarget, token: liveToken, location, status,
          card: { template: "limb-wound.hbs", data: {
            title:  localizeParam(destroyed ? "LimbWoundDestroyedTitle" : "LimbWoundCrippledTitle", { name: liveTarget.name }),
            detail: localizeParam(destroyed ? "LimbWoundLuDestroyedDetail" : "LimbWoundLuCrippledDetail", { net: netDamage, limb: limbName }),
          } },
        });
      }
    }
    if (ownBatch) await closeSeverityBatch(batch);
    return;
  }

  if (model === "W4RST4R") {
    // W4RST4R: >8 net disables the limb, >12 severs it; either way an immediate Death Save at
    // Mortal 0. Damage is NOT doubled (handled in computeNetDamage). Recorded under fleshLimbStatus.
    if (netDamage > 8) {
      const severed = netDamage > 12;
      const status = severed ? "severed" : "disabled";
      if (zoneGrade(status) > recordedGrade) {
        const cur = foundry.utils.duplicate(liveTarget.getFlag("cp2020-augmented", "fleshLimbStatus") ?? {});
        cur[location] = status;
        await liveTarget.setFlag("cp2020-augmented", "fleshLimbStatus", cur).catch(() => {});
        recordSeverityEvent(batch, {
          actor: liveTarget, token: liveToken, location, status, forcedMortalLevel: 0,
          card: { template: "limb-wound.hbs", data: {
            title:           localizeParam(severed ? "LimbWoundSeveredTitle" : "LimbWoundDisabledTitle", { name: liveTarget.name }),
            locationLine:    localizeParam("LimbWoundLocationLine", { limb: limbName }),
            detail:          localizeParam(severed ? "LimbWoundW4SeveredDetail" : "LimbWoundW4DisabledDetail", { net: netDamage }),
            deathSaveClause: localize("LimbWoundDeathSaveClause"),
          } },
        });
      }
    }
    if (ownBatch) await closeSeverityBatch(batch);
    return;
  }

  // Core: a single hit of > 8 net to a limb severs/crushes it → immediate Death Save at Mortal 0.
  // The loss is RECORDED, same flag and same whole-object write as the other two models: Core's own
  // rule says the limb is gone, and the readers of `fleshLimbStatus` are model-agnostic (the sheet's
  // limb label, the gone-limb re-roll in utils.js, the cyberlimb severed-under check) — leaving Core
  // chat-only made all three go blind under the default model.
  if (netDamage > 8 && zoneGrade("severed") > recordedGrade) {
    const cur = foundry.utils.duplicate(liveTarget.getFlag("cp2020-augmented", "fleshLimbStatus") ?? {});
    cur[location] = "severed";
    await liveTarget.setFlag("cp2020-augmented", "fleshLimbStatus", cur).catch(() => {});
    recordSeverityEvent(batch, {
      actor: liveTarget, token: liveToken, location, status: "severed", forcedMortalLevel: 0,
      card: { template: "limb-wound.hbs", data: {
        title:           localizeParam("LimbWoundLossTitle", { name: liveTarget.name }),
        locationLine:    localizeParam("LimbWoundLocationLine", { limb: limbName }),
        detail:          localizeParam("LimbWoundCoreDetail", { net: netDamage }),
        deathSaveClause: localize("LimbWoundDeathSaveClause"),
      } },
    });
  }
  if (ownBatch) await closeSeverityBatch(batch);
}

/**
 * Apply one hit to a personnel target at a location, routing cyberlimb zones to the limb's own SDP
 * instead of the character's wound track (RAW, Core p.89: machinery — no BTM, no shock/stun save, no
 * death save, and per the user's call no overflow). The single seam every apply path funnels through
 * so the routing is identical everywhere. Returns the FLESH HP actually written (0 for a cyberlimb)
 * so callers can gate the post-hit stun/death prompt honestly, plus the cyberlimb flag.
 *   netDamage        — flesh HP (post-armor, post-BTM, post-doubling) for a non-cyberlimb hit.
 *   structuralDamage — post-armor (pre-BTM) damage a cyberlimb absorbs; falls back to netDamage.
 *   penetrates       — armor was beaten (a stopped hit does no structural damage).
 * @returns {Promise<{cyberlimb: boolean, applied: number}>}
 */
export async function applyLocationDamage({ target, location, netDamage = 0, structuralDamage, penetrates = true, token = null, fxSilent = false, severityBatch = null }) {
  /**
   * THE IMPACT AUDIO THIS SEAM OWES, and what makes it different from the rail's.
   *
   * ⛔ TWO LEGS, ONE ASSET SET, DIFFERENT GATES — the split follows from which clock each seam is on:
   *
   *  - THE RAIL sounds a shot at its measured ARRIVAL (fx/effects.js, hitSoundPlanFor), alongside the
   *    impact mark and the blood spray. At that instant nothing knows whether the round beat armour —
   *    penetration is computed HERE, later — so the rail sounds every round that LANDED, which is
   *    exactly the information its two neighbouring draws already use.
   *  - THIS SEAM is the apply, and the apply happens after the presentation settles: for a burst that
   *    is the last round's tail, for a declared corridor it is whenever the GM confirms. Sounding a
   *    rail-driven shot here as well would be a second impact per round, seconds behind the first. So
   *    `fxSilent` is set by the flows that came off a shot, and the flows with NO arrival clock at all
   *    leave it false — an area shell resolved on confirm, a vehicle-weapon hit on a passenger, a burn
   *    tick. Those have nothing to be late for, so they play now.
   *
   * ⛔⛔ THE DAMAGE WINDOW IS A SHOT-DERIVED FLOW, and this note used to say otherwise — which is the
   * defect reported 2026-08-19 (*"the impact sound plays when I press Apply"*). The flag shipped with
   * two shot-derived callers, `_autoApply` and its GM-side relay; the auto-apply ROUTE was deleted on
   * 2026-08-14 with the world setting that selected it, and the flag's only shot-derived caller went
   * with it. That left the damage WINDOW as the only route a shot's damage takes — and the window had
   * never been given the flag, because while auto-apply existed the window WAS the hand-applied case
   * this split leaves loud. Both window paths (DamageDialog._onApply and its `applyDamage` relay) now
   * pass it, and neither decides it: the answer comes from the rail itself
   * (fx/effects.js `railSoundedImpacts`), so the two clocks cannot disagree about one shot again.
   *
   * ⚠ IT IS ALSO SET BY THE APPLIES THAT ARE NOT IMPACTS AT ALL. A burn tick, an acid tick, a
   * radiation dose and an ACPA pilot's overflow all land damage through this seam and none of them is
   * a round arriving on a body — which is why the flag is named for what it DOES here (stay quiet)
   * rather than for one of the two reasons a caller might have. Each call site states its own.
   *
   * ⭐ WHY HERE AND NOT ONE LEVEL UP: this is the seam EVERY personnel apply passes through. The
   * damage dialog's Apply calls it directly, row by row, and never touches applyAreaDamages — a leg
   * placed there would have left the module's most-used manual path silent.
   *
   * ⭐ WHAT THIS SEAM KNOWS THAT THE RAIL CANNOT: penetration, and the hit LOCATION. A round stopped
   * dead by armour is SILENT here (taken because the seam that can tell should), and a hit that routed
   * into a cyberlimb's own SDP sounds as STRUCTURE even on an otherwise flesh target — `routesToSdp`
   * answers per zone, which the rail explicitly cannot (see bearsStructuralSdp's note).
   *
   * ⚠ AND THOSE TWO REFINEMENTS DO NOT REACH THE EAR ON A SHOT-DERIVED APPLY — stated so it is a trade
   * rather than a surprise. Once `fxSilent` is set, a round the armour stopped and a round that went
   * into a cyberlimb both sound exactly as the rail sounded them at arrival: present, and keyed to the
   * ACTOR rather than the zone. That is the same bargain the retired auto-apply route made, and it is
   * the ruling's own direction — the sound belongs to the moment the round lands, and at that moment
   * neither fact is known yet. The refinements still govern every apply with no arrival clock behind it.
   *
   * No index is passed: a caller here keeps no tally, so the element supplies the level ladder and the
   * burst bound itself (HIT_SOUND_BURST_WINDOW_MS) — which is what stops a multi-row dialog putting
   * one clip through the same tick four times over.
   */
  const sounds = !fxSilent && penetrates;
  if (routesToSdp(target, location)) {
    const sdpDmg = penetrates ? Math.max(0, Math.round(Number(structuralDamage ?? netDamage) || 0)) : 0;
    const outcome = sdpDmg > 0 ? await absorbCyberlimbHit(target, location, sdpDmg) : null;
    if (sounds && sdpDmg > 0) fxHitSound("structure");   // the zone's OWN answer — chrome, not the body
    // A full borg's Head (brain) or Torso (biosystem) destroyed ends the actor — the one death the
    // limb model omits (Chromebook 2 p.64,66). A limb just goes useless, so this only fires for a borg.
    if (outcome?.status === "destroyed" && BORG_CORE_ZONES.has(location) && isFullBorg(target)) {
      await killBorgCore(target, location, token);
    }
    return { cyberlimb: true, applied: 0 };
  }
  if (netDamage > 0) {
    const current = Number(target.system.damage) || 0;
    // ⭐ CLAMPED TO THE TRACK'S LAST BOX (utils `cappedWoundDamage`, 2026-08-27). The sheet has forty
    // boxes and `woundState()` is `ceil(damage / 4)`, so an unclamped append let a figure bank a state
    // the table has no row for — and the stun card's penalty line, which is `woundState − 1`, printed
    // it (reported at 94). Nothing about death, severity or stabilization reads differently at the
    // ceiling: everything past Mortal 6 already resolved as Mortal 6.
    await target.update({ "system.damage": cappedWoundDamage(current + netDamage) }, { render: false, fromCyberpunkDamageSystem: true });
    // New damage clears stabilization — death saves restart (CP2020 p.105).
    if (target.getFlag?.("cp2020-augmented", "stabilized")) {
      await target.unsetFlag("cp2020-augmented", "stabilized");
      await postSavePromptCard({
        body: localizeParam("StabilizedLostBody", { name: target.name }),
        speaker: ChatMessage.getSpeaker({ actor: target }),
      });
    }
  }
  if (sounds && netDamage > 0) fxHitSound(isFullBorg(target) ? "structure" : "flesh");
  // THE PROGRESSION STEP THIS EVENT CONTRIBUTES. Recorded here, after the write, because this is the
  // seam every personnel apply passes through and because the wound state read now is the state the
  // event left behind — which is what makes the ladder on the batch's card the real one. A caller with
  // no ledger gets a one-event ledger opened and closed around this call, so nothing changes for it.
  const batch = severityBatch ?? makeSeverityBatch();
  const ownBatch = !severityBatch;
  recordSeverityHit(batch, { actor: target, token, netDamage });
  await assessWoundSeverity(target, location, netDamage, { token, severityBatch: batch });
  if (ownBatch) await closeSeverityBatch(batch);
  return { cyberlimb: false, applied: netDamage > 0 ? netDamage : 0 };
}

/**
 * Apply all hits in an areaDamages object to a target sequentially.
 * @param {Actor}   p.target
 * @param {object}  p.areaDamages
 * @param {boolean} p.ap             Armor-piercing: halves SP equally across all armor types
 * @param {boolean} p.edged          Edged weapon: equivalent to armorMultSoft 0.5 (soft only)
 * @param {boolean} p.mono           Mono-edge weapon: ⅓ SP vs soft armor, ⅔ SP vs hard (CP2020 p.112)
 * @param {number}  p.armorMultSoft  SP multiplier for soft armor (1.0 = no change)
 * @param {number}  p.armorMultHard  SP multiplier for hard armor (1.0 = no change)
 * @param {string}  p.armorMode
 * @param {boolean} p.ablate
 * @param {number}  p.coverSP
 * @param {object}  p.cover        Cover-object row snapshot to wear down round by round (or null)
 * @param {boolean} p.dryRun        If true: runs math only, does not write HP or ablate
 * @param {object}  p.severityBatch The application's severity ledger (combat/severity-batch.js). Passed
 *                                  by a caller whose application is WIDER than this call — a corridor's
 *                                  shells, a blast and its fragments, an apply whose tail prompt the
 *                                  caller owns. Absent, this loop is the whole application and opens
 *                                  and closes its own.
 * @returns {Promise<object[]>}     Per-hit results (includes netDamage when dryRun=false)
 */
export async function applyAreaDamages({ target, areaDamages, ap, edged = false, mono = false, armorMultSoft = 1.0, armorMultHard = 1.0, penDamageMult = 1.0, armorMode, ablate, coverSP = 0, cover = null, damageType = "", token = null, targetTokenId = null, dryRun = false, fxSilent = false, severityBatch = null }) {
  // Vehicles NEVER use the personnel pipeline — they have no limbs, death saves, BTM, or HP. Route
  // any vehicle target to the vehicle damage resolver (Core SP→SDP / Maximum Metal penetration),
  // which reduces SDP / sets vehicle status instead of writing the character `damage` field and
  // running limb/head checks. Catches every apply path (auto-apply, DamageDialog, Apply button).
  // Vehicle/ACPA actors are the module sub-type "cp2020-augmented.vehicle" (the bare "vehicle" is an
  // Item type, so the old check never matched → area/blast hits wrongly fell through to personnel).
  if (!dryRun && target?.type === "cp2020-augmented.vehicle") {
    try {
      const VW = await import("../vehicle/vehicle-weapons.js");
      // The vehicle resolvers own the structure impact from here; `fxSilent` rides along so a shot the
      // FX rail already sounded at its arrival is not sounded a second time when it applies.
      await VW.routeWeaponFiredToVehicle({ areaDamages, ap, fxSilent }, target);
    } catch (err) { console.warn("cp2020-augmented | vehicle damage routing failed:", err); }
    return [];
  }


  // ⭐ THE LOOP BELOW IS ONE APPLICATION. N landed rounds on one body are one moment of the fight, so
  // they share one severity ledger and produce one progression card and one mortal prompt between them
  // (combat/severity-batch.js). A wider caller hands its own ledger in and closes it after its own tail.
  const severity = (dryRun ? null : (severityBatch ?? makeSeverityBatch()));
  const ownSeverity = !dryRun && !severityBatch;

  const results = [];
  const btm = Number(target.system.stats?.bt?.modifier) || 0;
  // Cover wears down per round, exactly like armor: the ledger hands each round the SP the object
  // still offers and books that round's raw damage against its structure (see cover.js
  // makeCoverLedger for the attribution). Armor mode "none" folds no cover, so it books none.
  const coverLedger = makeCoverLedger({ coverSP: armorMode === ARMOR_MODES.NONE ? 0 : coverSP, cover });

  const liveSP = {};
  // Keyed by the SP location (Groin → Torso), so a Groin hit draws on torso armor.
  const getLiveSP = (key) => {
    if (liveSP[key] !== undefined) return liveSP[key];
    // Typed hits — and any wearer of typed layers, even on normal hits — re-derive SP per layer
    // (the prepared fold is type-blind); plain wearers keep the prepared value (ablation included).
    liveSP[key] = (damageType || _wearsTypedLayers(target))
      ? _deriveLiveSP(target, spLocationKey(key), damageType)
      : Number(target.system.hitLocations?.[spLocationKey(key)]?.stoppingPower) || 0;
    return liveSP[key];
  };

  const allHits = [];
  for (const [location, hits] of Object.entries(areaDamages)) {
    for (const hit of hits) {
      // item.js __suppressiveFire uses { dmg } key; all other paths use { damage }
      allHits.push({ location, rawDamage: Number(hit.damage ?? hit.dmg) || 0 });
    }
  }

  for (const { location, rawDamage: baseRaw } of allHits) {
    const rawDamage = baseRaw;
    const spKey = spLocationKey(location);   // armor/ablation location (Groin → Torso)
    let currentSP = getLiveSP(location);

    // Asymmetric armor multipliers: edged/mono weapon and/or ammo armor mults.
    // edged flag = armorMultSoft: 0.5, armorMultHard: 1.0.
    // mono flag (mono-edge, CP2020 p.112) = armorMultSoft: ⅓, armorMultHard: ⅔ — it wins over edged.
    // Combined: take the minimum (most aggressive) of the weapon-category and ammo mults per type.
    const effectiveSoftMult = mono ? Math.min(1 / 3, armorMultSoft) : (edged ? Math.min(0.5, armorMultSoft) : armorMultSoft);
    const effectiveHardMult = mono ? Math.min(2 / 3, armorMultHard) : armorMultHard;
    if ((effectiveSoftMult !== 1.0 || effectiveHardMult !== 1.0) && currentSP > 0 && armorMode !== ARMOR_MODES.NONE) {
      const contributors = getArmorContributors(target, spKey);
      const allItems = [...contributors.cwItems, ...contributors.orderedLayers, ...contributors.unassigned];
      // A full-conversion borg's chassis is metal (hard), so a soft-only multiplier (edged weapon,
      // soft-ammo mult) must not halve its SP even when no armor ITEM is present to mark it hard.
      const hasHardArmor = isFullBorg(target) || allItems.some(item => getArmorHardness(item) === "hard");
      const mult = hasHardArmor ? effectiveHardMult : effectiveSoftMult;
      if (mult !== 1.0) currentSP = Math.max(0, Math.floor(currentSP * mult));
    }

    const roundCoverSP = coverLedger.spForRound();
    const { spFull, spUsed, damageAfterSP, penetrates } = resolveHitMath({
      currentSP, rawDamage, ap, armorMode, coverSP: roundCoverSP, penDamageMult,
    });
    // Booked AFTER the math: the round that empties the pool was still shot THROUGH the object,
    // so it gets the object's SP; only the rounds behind it face bare armor.
    const coverChew = coverLedger.absorb(rawDamage);

    // netDamage centralizes head doubling (p.103) and the optional Listen Up limb model.
    const netDamage = computeNetDamage(damageAfterSP, btm, penetrates, location);

    results.push({ location, rawDamage, spFull, spUsed, damageAfterSP, btm, netDamage, penetrates, cyberlimb: routesToSdp(target, location), coverSP: roundCoverSP, coverChew });

    if (!dryRun) {
      // Prefer the caller's token (the shot's actual target token, threaded from the auto-apply call
      // sites); fall back to the passed id, then the first canvas token of this actor. A multi-token
      // actor's core-kill / limb-loss seam must fire on the token that was hit, not an arbitrary one.
      const liveToken = token
        ?? (targetTokenId ? (canvas?.tokens?.get(targetTokenId) ?? null) : null)
        ?? canvas?.tokens?.placeables?.find(t => t.actor?.id === target.id) ?? null;
      // The shared seam: a cyberlimb zone absorbs into its SDP; flesh advances the wound track and
      // runs the limb/head severity check (CP2020 p.103 + optional Listen Up crippling).
      // `fxSilent` is threaded, not decided here: only the caller knows whether this flow came off a
      // shot the FX rail already sounded. The sound itself is issued one level down, in
      // applyLocationDamage, because that is the seam EVERY personnel apply passes through — this one,
      // the hand-applied damage dialog, and anything else that lands a hit on a body.
      await applyLocationDamage({ target, location, netDamage, structuralDamage: damageAfterSP, penetrates, token: liveToken, fxSilent, severityBatch: severity });

      if (ablate && armorMode === ARMOR_MODES.FULL && penetrates && netDamage > 0) {
        await ablateLocationOnce(target, spKey, damageType);
        liveSP[location] = _deriveLiveSP(target, spKey, damageType);
      }
    }
  }

  // Closed after the loop and before the caller's own tail runs, so the progression card and the one
  // mortal prompt are on screen ahead of whatever the caller posts next (the stun prompt, its notice).
  if (ownSeverity) await closeSeverityBatch(severity);

  if (!dryRun) target.sheet?.render(false);
  return results;
}

// Dry-run variants return damageAfterSP (pre-BTM) without writing any data.

export async function resolveAreaDamages({ target, areaDamages, ap, edged = false, mono = false, armorMultSoft = 1.0, armorMultHard = 1.0, penDamageMult = 1.0, armorMode, coverSP = 0, cover = null }) {
  return applyAreaDamages({ target, areaDamages, ap, edged, mono, armorMultSoft, armorMultHard, penDamageMult, armorMode, ablate: false, coverSP, cover, dryRun: true });
}

/**
 * Synchronous dry-run for dialog preview. Returns damageAfterSP per hit.
 * BTM is not applied here — the dialog shows damageAfterSP so the GM can override it,
 * then applies BTM at click time.
 *
 * Between-hit SP degradation MUST match the async auto-apply path (applyAreaDamages) so the dialog
 * Apply button and auto-apply produce identical totals: the cached per-location SP is the
 * UN-multiplied base (the armor mono/edged/ammo multiplier is applied FRESH each hit off that base),
 * and degradation between hits is the SAME ablation model gated behind the SAME `damageAblation`
 * setting (threaded in as `ablate`). This is a pure resolver — it SIMULATES the ablation the async
 * path performs via real document writes (ablateLocationOnce → _deriveLiveSP re-derive); the actual
 * writes happen in DamageDialog._onApply's apply loop.
 */
export function resolveAreaDamagesSync({ target, areaDamages, ap, edged = false, mono = false, armorMultSoft = 1.0, armorMultHard = 1.0, penDamageMult = 1.0, armorMode, ablate = false, coverSP = 0, cover = null, damageType = "" }) {
  const results = [];
  const liveSP  = {};        // cached UN-multiplied per-location base SP (mirrors applyAreaDamages)
  const ablations = {};      // per-location count of simulated staged-penetration ablations
  // Cover degradation is SIMULATED here on the same ledger the async path writes from, so the
  // preview shows the same mid-burst break the apply will perform — no documents are touched.
  const coverLedger = makeCoverLedger({ coverSP: armorMode === ARMOR_MODES.NONE ? 0 : coverSP, cover });

  const getLiveSP = (key) => {
    if (liveSP[key] !== undefined) return liveSP[key];
    // Mirrors applyAreaDamages: typed hits and typed-layer wearers re-derive per layer.
    liveSP[key] = (damageType || _wearsTypedLayers(target))
      ? _deriveLiveSP(target, spLocationKey(key), damageType)
      : Number(target.system.hitLocations?.[spLocationKey(key)]?.stoppingPower) || 0;
    return liveSP[key];
  };

  for (const [location, hits] of Object.entries(areaDamages)) {
    for (const hit of hits) {
      const baseRaw    = Number(hit.damage ?? hit.dmg) || 0;
      const rawDamage  = baseRaw;
      const spKey      = spLocationKey(location);
      let currentSP    = getLiveSP(location);   // un-multiplied base; mult applied fresh below

      const armorBase   = currentSP;   // pre-multiplier combined armor — the layering fold's own result
      let   armorMult   = 1;
      const effSoftSync = mono ? Math.min(1 / 3, armorMultSoft) : (edged ? Math.min(0.5, armorMultSoft) : armorMultSoft);
      const effHardSync = mono ? Math.min(2 / 3, armorMultHard) : armorMultHard;
      if ((effSoftSync !== 1.0 || effHardSync !== 1.0) && currentSP > 0 && armorMode !== ARMOR_MODES.NONE) {
        const contributors = getArmorContributors(target, spKey);
        const allItems = [...contributors.cwItems, ...contributors.orderedLayers, ...contributors.unassigned];
        // Borg chassis is hard metal (mirror of the async path) — soft-only mults never halve it.
        const hasHardArmor = isFullBorg(target) || allItems.some(item => getArmorHardness(item) === "hard");
        const mult = hasHardArmor ? effHardSync : effSoftSync;
        if (mult !== 1.0) { armorMult = mult; currentSP = Math.max(0, Math.floor(currentSP * mult)); }
      }

      const roundCoverSP = coverLedger.spForRound();
      const { spFull, spUsed, damageAfterSP, penetrates } = resolveHitMath({
        currentSP, rawDamage, ap, armorMode, coverSP: roundCoverSP, penDamageMult,
      });
      // Booked AFTER the math — mirrors applyAreaDamages: the round that empties the pool was
      // still shot through the object, the rounds behind it face bare armor.
      const coverChew = coverLedger.absorb(rawDamage);

      // `sdp` mirrors the async path's `cyberlimb` flag (applyAreaDamages) but is named for what it
      // means at the seam: routesToSdp covers BOTH a cyberlimb limb zone AND every zone of a full
      // borg (Head/Torso included), so the preview marks exactly the rows applyLocationDamage will
      // absorb into a machine zone's SDP (rounded afterSP, no BTM, no doubling) instead of the flesh
      // wound track — the preview must never disagree with what Apply does.
      // The named parts of this round's arithmetic, for the window's expandable math line. Every
      // component is carried as data + a NAME (armor items by their own name, the cover object by
      // its label) — the render edge turns it into text, this stays i18n-free. Structural only:
      // nothing here feeds the damage numbers, it reports on them.
      const layers      = (armorMode === ARMOR_MODES.NONE) ? [] : armorLayerRows(target, spKey, damageType);
      const layerMax    = layers.reduce((m, l) => Math.max(m, l.sp), 0);
      const breakdown = {
        raw: rawDamage,
        layers,
        // What the proportional table (p.99) added on top of the single best layer to reach the
        // combined value the math used — read off armorBase itself, never re-folded.
        layerBonus: Math.max(0, armorBase - layerMax),
        armorBase, armorMult, armorSP: currentSP,
        // The row's DISPLAY name — the one that carries a per-attack verdict when the row had one
        // (combat/cover.js). `label` is the clean name and stays the one the wear receipt is written
        // against; this is what the apply window's breakdown line calls the row.
        coverName: String(cover?.displayLabel || cover?.label || ""),
        coverSP: roundCoverSP,
        effectiveSP: spFull,
        apHalved: !!ap && armorMode !== ARMOR_MODES.NONE && spUsed !== spFull,
        spUsed,
        afterSPRaw: rawDamage - spUsed,
        penMult: Number(penDamageMult) || 1,
        afterSP: damageAfterSP,
        penetrates,
      };

      results.push({ location, rawDamage, spFull, spUsed, damageAfterSP, penetrates, sdp: routesToSdp(target, location), coverSP: roundCoverSP, coverChew, breakdown });

      // Between-hit SP degradation: same model + same gate as the async path's per-layer ablation.
      // async (applyAreaDamages): `ablate && armorMode===FULL && penetrates && netDamage>0` →
      // ablateLocationOnce then liveSP[loc] = _deriveLiveSP(reduced docs). netDamage>0 ⟺ penetrates
      // (applyBTM floors penetrating hits at 1). Here we SIMULATE that re-derive without writing, and
      // cache the un-multiplied result so the next same-location hit multiplies it fresh (fixes the
      // old flat −1 which both degraded unconditionally AND cached the POST-multiplier value —
      // compounding the mono/edged mult across hits). When ablation is OFF, neither path degrades.
      if (ablate && armorMode === ARMOR_MODES.FULL && penetrates) {
        ablations[location] = (ablations[location] || 0) + 1;
        liveSP[location] = _simulateAblatedLiveSP(target, spKey, damageType, ablations[location]);
      }
    }
  }

  return results;
}

/**
 * Pure simulation of the between-hit SP the async path derives after `nAblations` staged-penetration
 * ablations at a location — WITHOUT writing any document. Mirrors ablateLocationOnce (each contributing
 * armor layer's CONVENTIONAL SP drops by 1 per ablation while it still has SP and still contributes to
 * this hit; cyberware layers and the borg chassis never ablate) followed by the _deriveLiveSP
 * proportional fold, so resolveAreaDamagesSync's simulated cache equals applyAreaDamages' re-derived
 * one on a penetrating same-location burst. Pure.
 */
function _simulateAblatedLiveSP(target, location, damageType, nAblations) {
  const contributors = getArmorContributors(target, location);
  const ablatableIds = new Set([...contributors.orderedLayers, ...contributors.unassigned].map(i => i.id));
  const allItems = [...contributors.cwItems, ...contributors.orderedLayers, ...contributors.unassigned];
  const sps = allItems.map(item => {
    if (item.type === "cyberware") {
      // Cyberware never ablates (ablateLocationOnce touches only armor layers).
      return typedLayerSP(item, Number(item.system?.CyberWorkType?.Locations?.[location]) || 0, damageType);
    }
    let itemSP = Number(item.system?.coverage?.[location]?.stoppingPower) || 0;
    if (ablatableIds.has(item.id)) {
      // Replay nAblations sequential −1s under ablateLocationOnce's own guards (SP>0 AND the layer
      // still contributes to this hit's type — a fully-typed non-matching garment never erodes).
      for (let k = 0; k < nAblations && itemSP > 0; k++) {
        if (typedLayerSP(item, itemSP, damageType) <= 0) break;
        itemSP = Math.max(0, itemSP - 1);
      }
    }
    return typedLayerSP(item, itemSP, damageType);
  }).filter(sp => sp > 0);
  let combined = foldArmorSP(sps);
  const borgSP = borgArmorSP(target, location);
  if (borgSP > 0) combined = combineArmorSP(combined, borgSP);
  return combined;
}

export async function ablateLocationOnce(target, location, damageType = "") {
  const contributors = getArmorContributors(target, location);
  const toAblate = [...contributors.orderedLayers, ...contributors.unassigned];

  const updates = [];
  for (const item of toAblate) {
    const liveItem = target.items.get(item.id);
    if (!liveItem) continue;
    // Typed armor ablates like any other layer: the book's armor-degradation (staged-penetration) system
    // does not exempt typed SP, so a layer whose typed rating STOPPED this hit erodes normally (RAW, per
    // user ruling 2026-07-11 — overrides the earlier "material property, not consumable plating" reading).
    const itemSP = Number(liveItem.system?.coverage?.[location]?.stoppingPower) || 0;
    if (itemSP <= 0) continue;
    // A typed layer that contributed 0 to THIS hit (a fully-typed garment whose type doesn't match, e.g. a
    // fire coat struck by a bullet: typedLayerSP → 0) stopped nothing here, so it must not erode. Dual-value
    // and no-type layers return their conventional SP and still ablate.
    if (typedLayerSP(liveItem, itemSP, damageType) <= 0) continue;
    // Full coverage object write — dot-notation paths may wipe the DataModel
    const fullCoverage = foundry.utils.deepClone(liveItem.system.coverage || {});
    if (!fullCoverage[location]) fullCoverage[location] = {};
    fullCoverage[location].stoppingPower = Math.max(0, itemSP - 1);
    updates.push({ _id: liveItem.id, "system.coverage": fullCoverage });
  }

  if (updates.length > 0) {
    // fromCyberpunkDamageSystem lets the live-sheet hook refresh open sheets on every client.
    await target.updateEmbeddedDocuments("Item", updates, { render: false, fromCyberpunkDamageSystem: true });
  }
}

/**
 * Reduce armor SP at a location by a variable amount.
 * Distributes the reduction from outermost layer inward (used by acid DOT).
 * @param {Actor}  target
 * @param {string} location
 * @param {number} amount   Total SP to remove
 */
export async function ablateLocationByAmount(target, location, amount, damageType = "") {
  if (amount <= 0) return;
  const contributors = getArmorContributors(target, location);
  const toAblate = [...contributors.orderedLayers, ...contributors.unassigned];

  const updates = [];
  let remaining = amount;
  for (const item of toAblate) {
    if (remaining <= 0) break;
    const liveItem = target.items.get(item.id);
    if (!liveItem) continue;
    // Typed armor ablates like any other layer (RAW, per user ruling 2026-07-11 — the staged-penetration
    // degradation system does not exempt typed SP; overrides the earlier M15 "material property" reading).
    const itemSP = Number(liveItem.system?.coverage?.[location]?.stoppingPower) || 0;
    if (itemSP <= 0) continue;
    // A fully-typed garment that contributed nothing to this hit (typedLayerSP → 0) stopped nothing, so it
    // does not erode; dual-value and no-type layers return their conventional SP and still ablate.
    if (typedLayerSP(liveItem, itemSP, damageType) <= 0) continue;
    const reduction = Math.min(itemSP, remaining);
    remaining -= reduction;
    const fullCoverage = foundry.utils.deepClone(liveItem.system.coverage || {});
    if (!fullCoverage[location]) fullCoverage[location] = {};
    fullCoverage[location].stoppingPower = Math.max(0, itemSP - reduction);
    updates.push({ _id: liveItem.id, "system.coverage": fullCoverage });
  }

  if (updates.length > 0) {
    // fromCyberpunkDamageSystem lets the live-sheet hook refresh open sheets on every client.
    await target.updateEmbeddedDocuments("Item", updates, { render: false, fromCyberpunkDamageSystem: true });
  }
}


/** Does the target wear any typed-SP layer (armor or cyberware)? Such actors always take the
 *  type-aware per-layer derivation — the base prepared fold sums coverage type-blindly, so a
 *  fire-only garment would wrongly harden them against normal hits. Pure.
 *  Exported so the honest-armor-display prepareData wrap (module/mech/typed-armor-display.js) gates
 *  on the SAME "wears typed?" definition the damage resolver uses — one source of truth, no drift. */
export function _wearsTypedLayers(target) {
  return (target?.items?.contents ?? []).some(i =>
    !!i.system?.equipped && String(i.system?.mechTypedSP?.type ?? "").trim() !== "");
}

// Exported (the leading underscore is kept for churn-free git history) so the honest conditional-armor
// display wraps prepareData around this EXACT function — the single source of truth the damage pipeline
// uses — instead of re-folding SP itself: `_deriveLiveSP(actor, loc, "")` is the conventional total and
// `_deriveLiveSP(actor, loc, type)` the typed total, guaranteeing display == damage math.
export function _deriveLiveSP(target, location, damageType = "") {
  const contributors = getArmorContributors(target, location);
  const allItems = [...contributors.cwItems, ...contributors.orderedLayers, ...contributors.unassigned];
  // Typed SP: a layer whose mechTypedSP matches the hit's damage type contributes its typed value
  // in place of the conventional one; a non-matching typed layer falls back to conventional, so a
  // fire-only garment (conventional 0) is skipped by the sp>0 filter before the combine.
  const sps = allItems.map(item => {
    if (item.type === "cyberware") {
      return typedLayerSP(item, Number(item.system?.CyberWorkType?.Locations?.[location]) || 0, damageType);
    }
    return typedLayerSP(item, Number(item.system?.coverage?.[location]?.stoppingPower) || 0, damageType);
  }).filter(sp => sp > 0);
  // ONE proportional fold of the armor/cyberware layers — the same optimal-over-order combination the
  // base uses for the prepared per-location SP (actor.js maxLayeredSP), so a typed layer's mere presence
  // never silently changes a wearer's conventional armor math (M16: a fixed-order reduce here diverged
  // from the base's DP). Equality with the DISPLAYED sheet SP holds for ordinary and dual-value layers;
  // it does NOT hold for a FULLY-typed garment on a NON-matching hit — typedLayerSP returns 0 and the
  // sp>0 filter above drops it, so this live/preview value is intentionally LOWER than the base-prepared
  // sheet value (base prepareData folds coverage.stoppingPower type-blindly and still counts that garment).
  let combined = foldArmorSP(sps);
  // A full-conversion borg's chassis SP is intrinsic (no armor item); it feeds the ablation refresh (a
  // penetrated burst) and the Maximum Metal anti-vehicle armor value. prepareData folds it into
  // hitLocations.stoppingPower via combineArmorSP AFTER the layered fold (mech/borg.js) — mirror that
  // exact two-step so an armored borg's live value equals its prepared one.
  const borgSP = borgArmorSP(target, location);
  if (borgSP > 0) combined = combineArmorSP(combined, borgSP);
  return combined;
}

/**
 * The NAMED composition behind a location's combined armor SP: one row per layer that actually
 * contributes, carrying the item's own name and the SP it brings to this hit's damage type. Same
 * item set and same per-layer valuation `_deriveLiveSP` folds, so the rows are the pieces of the
 * number the damage math used rather than a second opinion about it. A full-conversion borg's
 * chassis has no item behind it, so it comes back flagged (`chassis`) and nameless for the render
 * edge to label. PURE — no i18n, no documents written.
 */
export function armorLayerRows(target, location, damageType = "") {
  const contributors = getArmorContributors(target, location);
  const allItems = [...contributors.cwItems, ...contributors.orderedLayers, ...contributors.unassigned];
  const rows = [];
  for (const item of allItems) {
    const base = (item.type === "cyberware")
      ? Number(item.system?.CyberWorkType?.Locations?.[location]) || 0
      : Number(item.system?.coverage?.[location]?.stoppingPower) || 0;
    const sp = typedLayerSP(item, base, damageType);
    if (sp > 0) rows.push({ name: item.name, sp });
  }
  const chassis = borgArmorSP(target, location);
  if (chassis > 0) rows.push({ name: "", sp: chassis, chassis: true });
  return rows;
}

/** Effective armor SP at a hit location AFTER proportional layer combination (the value the damage
 *  system actually uses). Exposed for the Maximum Metal p.8 personnel-vs-anti-vehicle resolver. */
export function effectiveArmorSP(target, location) {
  return _deriveLiveSP(target, location);
}

const _MM_AV_LOCATIONS = ["Head", "Torso", "lArm", "rArm", "lLeg", "rLeg"];
/**
 * Personnel Armor Value for Maximum Metal p.8 ("Personnel vs Anti-Vehicle Weapons"): the mean of
 * the PROPORTIONAL per-location SP across the body, ÷ 20. The book rounds the average SP first,
 * then the ÷20 (worked example: an SP19 jacket over 3 of 6 locations → mean 9.5 → 10 → AV 1).
 */
export function personnelArmorValue(target) {
  if (!target) return 0;
  const sps = _MM_AV_LOCATIONS.map(loc => Number(_deriveLiveSP(target, loc)) || 0);
  const meanSP = Math.round(sps.reduce((a, b) => a + b, 0) / sps.length);
  return Math.round(meanSP / 20);
}
