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
import { postDeathSavePrompt } from "./save-rolls.js";
import { renderChatCard, postSavePromptCard } from "../compat.js";
import { localize, localizeParam, combineArmorSP, foldArmorSP } from "../utils.js";
import { routesToSdp, absorbCyberlimbHit } from "../mech/cyberlimb.js";
import { isFullBorg, borgArmorSP, BORG_CORE_ZONES, killBorgCore } from "../mech/borg.js";
import { typedLayerSP } from "../data/mech-item-data.js";

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
 */
function resolveHitMath({ currentSP, rawDamage, ap, armorMode, coverSP = 0, penDamageMult = 1 }) {
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
 * W4RST4R's hit-location table can roll "Groin", which has no stored armor / hit-location entry.
 * The groin is covered by torso armor, so SP lookup and ablation use the Torso location at runtime
 * (no actor-data field is added). Other locations pass through unchanged.
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
 * @param {Actor}  target
 * @param {string} location
 * @param {number} netDamage   Final HP applied (already includes any doubling)
 * @param {{token?: object}} [opts]
 */
export async function assessWoundSeverity(target, location, netDamage, { token = null } = {}) {
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

  const liveTarget = game.actors.get(target.id) ?? target;
  const liveToken  = token ?? canvas?.tokens?.placeables?.find(t => t.actor?.id === liveTarget.id) ?? null;

  // Head wound > 8 net = automatic death (Listen Up does not change the head; always Core here).
  if (location === "Head") {
    if (netDamage > 8) {
      const content = await renderChatCard("head-wound-death.hbs", {
        actorName: liveTarget.name, netDamage,
      });
      await ChatMessage.create({
        content,
        speaker: ChatMessage.getSpeaker({ actor: liveTarget }),
      });
      // v13+: TokenDocument#toggleActiveEffect was removed — toggle the status on the Actor.
      const deadActor = liveToken?.actor ?? liveTarget;
      if (deadActor?.toggleStatusEffect) {
        await deadActor.toggleStatusEffect("dead", { active: true });
      }
    }
    return;
  }

  // Groin (W4RST4R table) is not a limb and has no head rule — it just takes damage. No-op here.
  if (!LIMB_LOCATIONS.has(location)) return;
  // Location codes (rArm/lArm/rLeg/lLeg) are themselves the i18n keys for the limb names.
  const limbName = localize(location);

  if (model === "ListenUp") {
    // Listen Up crippling bands (measured on the doubled netDamage). No death save.
    if (netDamage >= 6) {
      const destroyed = netDamage >= 13;
      const status = destroyed ? "destroyed" : "crippled";
      const cur = foundry.utils.duplicate(liveTarget.getFlag("cp2020-augmented", "fleshLimbStatus") ?? {});
      cur[location] = status;
      await liveTarget.setFlag("cp2020-augmented", "fleshLimbStatus", cur).catch(() => {});
      const content = await renderChatCard("limb-wound.hbs", {
        title:  localizeParam(destroyed ? "LimbWoundDestroyedTitle" : "LimbWoundCrippledTitle", { name: liveTarget.name }),
        detail: localizeParam(destroyed ? "LimbWoundLuDestroyedDetail" : "LimbWoundLuCrippledDetail", { net: netDamage, limb: limbName }),
      });
      await ChatMessage.create({
        content,
        speaker: ChatMessage.getSpeaker({ actor: liveTarget }),
      });
    }
    return;
  }

  if (model === "W4RST4R") {
    // W4RST4R: >8 net disables the limb, >12 severs it; either way an immediate Death Save at
    // Mortal 0. Damage is NOT doubled (handled in computeNetDamage). Recorded under fleshLimbStatus.
    if (netDamage > 8) {
      const severed = netDamage > 12;
      const status = severed ? "severed" : "disabled";
      const cur = foundry.utils.duplicate(liveTarget.getFlag("cp2020-augmented", "fleshLimbStatus") ?? {});
      cur[location] = status;
      await liveTarget.setFlag("cp2020-augmented", "fleshLimbStatus", cur).catch(() => {});
      const content = await renderChatCard("limb-wound.hbs", {
        title:           localizeParam(severed ? "LimbWoundSeveredTitle" : "LimbWoundDisabledTitle", { name: liveTarget.name }),
        locationLine:    localizeParam("LimbWoundLocationLine", { limb: limbName }),
        detail:          localizeParam(severed ? "LimbWoundW4SeveredDetail" : "LimbWoundW4DisabledDetail", { net: netDamage }),
        deathSaveClause: localize("LimbWoundDeathSaveClause"),
      });
      await ChatMessage.create({
        content,
        speaker: ChatMessage.getSpeaker({ actor: liveTarget }),
      });
      await postDeathSavePrompt(liveTarget, liveToken, 0);
    }
    return;
  }

  // Core: a single hit of > 8 net to a limb severs/crushes it → immediate Death Save at Mortal 0.
  if (netDamage > 8) {
    const content = await renderChatCard("limb-wound.hbs", {
      title:           localizeParam("LimbWoundLossTitle", { name: liveTarget.name }),
      locationLine:    localizeParam("LimbWoundLocationLine", { limb: limbName }),
      detail:          localizeParam("LimbWoundCoreDetail", { net: netDamage }),
      deathSaveClause: localize("LimbWoundDeathSaveClause"),
    });
    await ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor: liveTarget }),
    });
    await postDeathSavePrompt(liveTarget, liveToken, 0);
  }
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
export async function applyLocationDamage({ target, location, netDamage = 0, structuralDamage, penetrates = true, token = null }) {
  if (routesToSdp(target, location)) {
    const sdpDmg = penetrates ? Math.max(0, Math.round(Number(structuralDamage ?? netDamage) || 0)) : 0;
    const outcome = sdpDmg > 0 ? await absorbCyberlimbHit(target, location, sdpDmg) : null;
    // A full borg's Head (brain) or Torso (biosystem) destroyed ends the actor — the one death the
    // limb model omits (Chromebook 2 p.64,66). A limb just goes useless, so this only fires for a borg.
    if (outcome?.status === "destroyed" && BORG_CORE_ZONES.has(location) && isFullBorg(target)) {
      await killBorgCore(target, location, token);
    }
    return { cyberlimb: true, applied: 0 };
  }
  if (netDamage > 0) {
    const current = Number(target.system.damage) || 0;
    await target.update({ "system.damage": current + netDamage }, { render: false, fromCyberpunkDamageSystem: true });
    // New damage clears stabilization — death saves restart (CP2020 p.105).
    if (target.getFlag?.("cp2020-augmented", "stabilized")) {
      await target.unsetFlag("cp2020-augmented", "stabilized");
      await postSavePromptCard({
        body: localizeParam("StabilizedLostBody", { name: target.name }),
        speaker: ChatMessage.getSpeaker({ actor: target }),
      });
    }
  }
  await assessWoundSeverity(target, location, netDamage, { token });
  return { cyberlimb: false, applied: netDamage > 0 ? netDamage : 0 };
}

/**
 * Apply all hits in an areaDamages object to a target sequentially.
 * @param {Actor}   p.target
 * @param {object}  p.areaDamages
 * @param {boolean} p.ap             Armor-piercing: halves SP equally across all armor types
 * @param {boolean} p.edged          Edged weapon: equivalent to armorMultSoft 0.5 (soft only)
 * @param {number}  p.armorMultSoft  SP multiplier for soft armor (1.0 = no change)
 * @param {number}  p.armorMultHard  SP multiplier for hard armor (1.0 = no change)
 * @param {string}  p.armorMode
 * @param {boolean} p.ablate
 * @param {number}  p.coverSP
 * @param {boolean} p.dryRun        If true: runs math only, does not write HP or ablate
 * @returns {Promise<object[]>}     Per-hit results (includes netDamage when dryRun=false)
 */
export async function applyAreaDamages({ target, areaDamages, ap, edged = false, armorMultSoft = 1.0, armorMultHard = 1.0, penDamageMult = 1.0, armorMode, ablate, coverSP = 0, damageType = "", token = null, targetTokenId = null, dryRun = false }) {
  // Vehicles NEVER use the personnel pipeline — they have no limbs, death saves, BTM, or HP. Route
  // any vehicle target to the vehicle damage resolver (Core SP→SDP / Maximum Metal penetration),
  // which reduces SDP / sets vehicle status instead of writing the character `damage` field and
  // running limb/head checks. Catches every apply path (auto-apply, DamageDialog, Apply button).
  // Vehicle/ACPA actors are the module sub-type "cp2020-augmented.vehicle" (the bare "vehicle" is an
  // Item type, so the old check never matched → area/blast hits wrongly fell through to personnel).
  if (!dryRun && target?.type === "cp2020-augmented.vehicle") {
    try {
      const VW = await import("../vehicle/vehicle-weapons.js");
      await VW.routeWeaponFiredToVehicle({ areaDamages, ap }, target);
    } catch (err) { console.warn("cp2020-augmented | vehicle damage routing failed:", err); }
    return [];
  }

  const results = [];
  const btm = Number(target.system.stats?.bt?.modifier) || 0;

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

    // Asymmetric armor multipliers: edged weapon (isEdged) and/or ammo armor mults.
    // edged flag = armorMultSoft: 0.5, armorMultHard: 1.0.
    // Combined: take the minimum (most aggressive) of edged and ammo mults per type.
    const effectiveSoftMult = edged ? Math.min(0.5, armorMultSoft) : armorMultSoft;
    const effectiveHardMult = armorMultHard;
    if ((effectiveSoftMult !== 1.0 || effectiveHardMult !== 1.0) && currentSP > 0 && armorMode !== ARMOR_MODES.NONE) {
      const contributors = getArmorContributors(target, spKey);
      const allItems = [...contributors.cwItems, ...contributors.orderedLayers, ...contributors.unassigned];
      // A full-conversion borg's chassis is metal (hard), so a soft-only multiplier (edged weapon,
      // soft-ammo mult) must not halve its SP even when no armor ITEM is present to mark it hard.
      const hasHardArmor = isFullBorg(target) || allItems.some(item => getArmorHardness(item) === "hard");
      const mult = hasHardArmor ? effectiveHardMult : effectiveSoftMult;
      if (mult !== 1.0) currentSP = Math.max(0, Math.floor(currentSP * mult));
    }

    const { spFull, spUsed, damageAfterSP, penetrates } = resolveHitMath({
      currentSP, rawDamage, ap, armorMode, coverSP, penDamageMult,
    });

    // netDamage centralizes head doubling (p.103) and the optional Listen Up limb model.
    const netDamage = computeNetDamage(damageAfterSP, btm, penetrates, location);

    results.push({ location, rawDamage, spFull, spUsed, damageAfterSP, btm, netDamage, penetrates, cyberlimb: routesToSdp(target, location) });

    if (!dryRun) {
      // Prefer the caller's token (the shot's actual target token, threaded from the auto-apply call
      // sites); fall back to the passed id, then the first canvas token of this actor. A multi-token
      // actor's core-kill / limb-loss seam must fire on the token that was hit, not an arbitrary one.
      const liveToken = token
        ?? (targetTokenId ? (canvas?.tokens?.get(targetTokenId) ?? null) : null)
        ?? canvas?.tokens?.placeables?.find(t => t.actor?.id === target.id) ?? null;
      // The shared seam: a cyberlimb zone absorbs into its SDP; flesh advances the wound track and
      // runs the limb/head severity check (CP2020 p.103 + optional Listen Up crippling).
      await applyLocationDamage({ target, location, netDamage, structuralDamage: damageAfterSP, penetrates, token: liveToken });

      if (ablate && armorMode === ARMOR_MODES.FULL && penetrates && netDamage > 0) {
        await ablateLocationOnce(target, spKey, damageType);
        liveSP[location] = _deriveLiveSP(target, spKey, damageType);
      }
    }
  }

  if (!dryRun) target.sheet?.render(false);
  return results;
}

// Dry-run variants return damageAfterSP (pre-BTM) without writing any data.

export async function resolveAreaDamages({ target, areaDamages, ap, edged = false, armorMultSoft = 1.0, armorMultHard = 1.0, penDamageMult = 1.0, armorMode, coverSP = 0 }) {
  return applyAreaDamages({ target, areaDamages, ap, edged, armorMultSoft, armorMultHard, penDamageMult, armorMode, ablate: false, coverSP, dryRun: true });
}

/**
 * Synchronous dry-run for dialog preview. Returns damageAfterSP per hit.
 * BTM is not applied here — the dialog shows damageAfterSP so the GM can override it,
 * then applies BTM at click time.
 */
export function resolveAreaDamagesSync({ target, areaDamages, ap, edged = false, armorMultSoft = 1.0, armorMultHard = 1.0, penDamageMult = 1.0, armorMode, coverSP = 0, damageType = "" }) {
  const results = [];
  const liveSP  = {};

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
      let currentSP    = getLiveSP(location);

      const effSoftSync = edged ? Math.min(0.5, armorMultSoft) : armorMultSoft;
      const effHardSync = armorMultHard;
      if ((effSoftSync !== 1.0 || effHardSync !== 1.0) && currentSP > 0 && armorMode !== ARMOR_MODES.NONE) {
        const contributors = getArmorContributors(target, spLocationKey(location));
        const allItems = [...contributors.cwItems, ...contributors.orderedLayers, ...contributors.unassigned];
        // Borg chassis is hard metal (mirror of the async path) — soft-only mults never halve it.
        const hasHardArmor = isFullBorg(target) || allItems.some(item => getArmorHardness(item) === "hard");
        const mult = hasHardArmor ? effHardSync : effSoftSync;
        if (mult !== 1.0) currentSP = Math.max(0, Math.floor(currentSP * mult));
      }

      const { spFull, spUsed, damageAfterSP, penetrates } = resolveHitMath({
        currentSP, rawDamage, ap, armorMode, coverSP, penDamageMult,
      });

      results.push({ location, rawDamage, spFull, spUsed, damageAfterSP, penetrates });

      // Simulate SP degradation for next bullet (staged penetration)
      if (penetrates && damageAfterSP > 0) {
        liveSP[location] = Math.max(0, currentSP - 1);
      }
    }
  }

  return results;
}

export async function ablateLocationOnce(target, location, damageType = "") {
  const contributors = getArmorContributors(target, location);
  const toAblate = [...contributors.orderedLayers, ...contributors.unassigned];

  const updates = [];
  for (const item of toAblate) {
    const liveItem = target.items.get(item.id);
    if (!liveItem) continue;
    // A layer whose TYPED rating stopped this hit (mechTypedSP matches the damage type) is protecting
    // by material property, not consumable plating — it does not ablate. A non-matching typed layer
    // that contributed nothing (conventional 0) is skipped by the itemSP<=0 gate just below.
    if (damageType && String(liveItem.system?.mechTypedSP?.type ?? "").trim() === String(damageType).trim()) continue;
    const itemSP = Number(liveItem.system?.coverage?.[location]?.stoppingPower) || 0;
    if (itemSP <= 0) continue;
    // A FULLY-typed garment whose typed rating doesn't match this hit contributes 0 SP (typedLayerSP → 0)
    // even though its coverage SP is >0 — it stopped nothing here, so it must not erode. (The dual-value
    // and no-type layers return their conventional SP and still ablate.)
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
    // Typed protection matching the damage type is a material property, not consumable plating (M15).
    if (damageType && String(liveItem.system?.mechTypedSP?.type ?? "").trim() === String(damageType).trim()) continue;
    const itemSP = Number(liveItem.system?.coverage?.[location]?.stoppingPower) || 0;
    if (itemSP <= 0) continue;
    // A fully-typed garment that contributed nothing to this typed hit (typedLayerSP → 0) does not erode.
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
 *  fire-only garment would wrongly harden them against normal hits. Pure. */
function _wearsTypedLayers(target) {
  return (target?.items?.contents ?? []).some(i =>
    !!i.system?.equipped && String(i.system?.mechTypedSP?.type ?? "").trim() !== "");
}

function _deriveLiveSP(target, location, damageType = "") {
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
