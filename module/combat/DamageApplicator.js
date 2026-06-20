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
import { localize, localizeParam } from "../utils.js";

export const ARMOR_MODES = {
  FULL:   "full",
  SIMPLE: "simple",
  NONE:   "none",
};

// Proportional armor table (CP2020 p.99). Single definition — do not duplicate.
function _combineSP(a, b) {
  a = Number(a) || 0;
  b = Number(b) || 0;
  if (!a) return b;
  if (!b) return a;
  const diff = Math.abs(a - b);
  let mod;
  if      (diff >= 27) mod = 0;
  else if (diff >= 21) mod = 1;
  else if (diff >= 15) mod = 2;
  else if (diff >= 9)  mod = 3;
  else if (diff >= 5)  mod = 4;
  else                 mod = 5;
  return Math.max(a, b) + mod;
}

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
    effectiveSP = _combineSP(currentSP, coverSP);
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
 * @param {Actor}  target
 * @param {string} location
 * @param {number} netDamage   Final HP applied (already includes any doubling)
 * @param {{token?: object}} [opts]
 */
export async function assessWoundSeverity(target, location, netDamage, { token = null } = {}) {
  // Vehicles have no limbs/head/death saves — never run wound severity on them (they use the
  // vehicle resolver). Defense in depth alongside the applyAreaDamages redirect.
  if (target?.type === "vehicle") return;
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
      const cur = foundry.utils.duplicate(liveTarget.getFlag("cp2020-augmented", "limbStatus") ?? {});
      cur[location] = status;
      await liveTarget.setFlag("cp2020-augmented", "limbStatus", cur).catch(() => {});
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
    // Mortal 0. Damage is NOT doubled (handled in computeNetDamage). The limbStatus flag is reused.
    if (netDamage > 8) {
      const severed = netDamage > 12;
      const status = severed ? "severed" : "disabled";
      const cur = foundry.utils.duplicate(liveTarget.getFlag("cp2020-augmented", "limbStatus") ?? {});
      cur[location] = status;
      await liveTarget.setFlag("cp2020-augmented", "limbStatus", cur).catch(() => {});
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
export async function applyAreaDamages({ target, areaDamages, ap, edged = false, armorMultSoft = 1.0, armorMultHard = 1.0, penDamageMult = 1.0, armorMode, ablate, coverSP = 0, dryRun = false }) {
  // Vehicles NEVER use the personnel pipeline — they have no limbs, death saves, BTM, or HP. Route
  // any vehicle target to the vehicle damage resolver (Core SP→SDP / Maximum Metal penetration),
  // which reduces SDP / sets vehicle status instead of writing the character `damage` field and
  // running limb/head checks. Catches every apply path (auto-apply, DamageDialog, Apply button).
  if (!dryRun && target?.type === "vehicle") {
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
    liveSP[key] = Number(target.system.hitLocations?.[spLocationKey(key)]?.stoppingPower) || 0;
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
      const hasHardArmor = allItems.some(item => getArmorHardness(item) === "hard");
      const mult = hasHardArmor ? effectiveHardMult : effectiveSoftMult;
      if (mult !== 1.0) currentSP = Math.max(0, Math.floor(currentSP * mult));
    }

    const { spFull, spUsed, damageAfterSP, penetrates } = resolveHitMath({
      currentSP, rawDamage, ap, armorMode, coverSP, penDamageMult,
    });

    // netDamage centralizes head doubling (p.103) and the optional Listen Up limb model.
    const netDamage = computeNetDamage(damageAfterSP, btm, penetrates, location);

    results.push({ location, rawDamage, spFull, spUsed, damageAfterSP, btm, netDamage, penetrates });

    if (!dryRun) {
      if (netDamage > 0) {
        const current = Number(target.system.damage) || 0;
        await target.update(
          { "system.damage": current + netDamage },
          { render: false, fromCyberpunkDamageSystem: true }
        );
        // New damage clears stabilization — death saves restart (CP2020 p.105)
        if (target.getFlag?.("cp2020-augmented", "stabilized")) {
          await target.unsetFlag("cp2020-augmented", "stabilized");
          await postSavePromptCard({
            body: localizeParam("StabilizedLostBody", { name: target.name }),
            speaker: ChatMessage.getSpeaker({ actor: target }),
          });
        }
      }

      if (ablate && armorMode === ARMOR_MODES.FULL && penetrates && netDamage > 0) {
        await ablateLocationOnce(target, spKey);
        liveSP[location] = _deriveLiveSP(target, spKey);
      }

      // Limb / head wound severity (CP2020 p.103 + optional Listen Up crippling) — centralized.
      const liveToken = canvas?.tokens?.placeables?.find(t => t.actor?.id === target.id) ?? null;
      await assessWoundSeverity(target, location, netDamage, { token: liveToken });
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
export function resolveAreaDamagesSync({ target, areaDamages, ap, edged = false, armorMultSoft = 1.0, armorMultHard = 1.0, penDamageMult = 1.0, armorMode, coverSP = 0 }) {
  const results = [];
  const liveSP  = {};

  const getLiveSP = (key) => {
    if (liveSP[key] !== undefined) return liveSP[key];
    liveSP[key] = Number(target.system.hitLocations?.[spLocationKey(key)]?.stoppingPower) || 0;
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
        const hasHardArmor = allItems.some(item => getArmorHardness(item) === "hard");
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

export async function ablateLocationOnce(target, location) {
  const contributors = getArmorContributors(target, location);
  const toAblate = [...contributors.orderedLayers, ...contributors.unassigned];

  const updates = [];
  for (const item of toAblate) {
    const liveItem = target.items.get(item.id);
    if (!liveItem) continue;
    const itemSP = Number(liveItem.system?.coverage?.[location]?.stoppingPower) || 0;
    if (itemSP <= 0) continue;
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
export async function ablateLocationByAmount(target, location, amount) {
  if (amount <= 0) return;
  const contributors = getArmorContributors(target, location);
  const toAblate = [...contributors.orderedLayers, ...contributors.unassigned];

  const updates = [];
  let remaining = amount;
  for (const item of toAblate) {
    if (remaining <= 0) break;
    const liveItem = target.items.get(item.id);
    if (!liveItem) continue;
    const itemSP = Number(liveItem.system?.coverage?.[location]?.stoppingPower) || 0;
    if (itemSP <= 0) continue;
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

function _deriveLiveSP(target, location) {
  const contributors = getArmorContributors(target, location);
  const allItems = [...contributors.cwItems, ...contributors.orderedLayers, ...contributors.unassigned];
  const sps = allItems.map(item => {
    if (item.type === "cyberware") {
      return Number(item.system?.CyberWorkType?.Locations?.[location]) || 0;
    }
    return Number(item.system?.coverage?.[location]?.stoppingPower) || 0;
  }).filter(sp => sp > 0);
  if (!sps.length) return 0;
  return sps.reduce((acc, sp) => _combineSP(acc, sp), 0);
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
