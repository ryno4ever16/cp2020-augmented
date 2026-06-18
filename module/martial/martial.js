/**
 * Martial-arts engine (module side).
 *
 * On the fork these live as CyberpunkActor methods (actor.js trainedMartials/getMartialArtSkill/
 * getSkillVal + the static id-resolution helpers). His vanilla actor has none of them, so the
 * module vendors them here as free functions that take the actor as an argument — a faithful
 * mirror of the fork code, not a parallel reinvention, so the two stay reconcilable for the
 * eventual upstream merge.
 *
 * Ours-only skill fields (isMartialArt / martialBonuses) are not in his vanilla skill DataModel,
 * so they are read through the flag-relocation accessors below: system field first (fork), then
 * flags.cp2020-augmented.* (vanilla). Built-in styles resolve by stable id and need neither.
 */

import { MODULE_ID } from "../constants.js";
import {
  MARTIAL_ART_ID_BY_KEY,
  MARTIAL_ART_KEY_BY_ID,
  FNFF2_ONLY_MARTIAL_ART_KEYS,
  isFnff2Enabled,
  isMartialArtSkillItem,
  martialArtDisplayName,
  martialActions,
  getMartialActionBonus,
  getFnff2DamageBonusSymbol,
  strengthDamageBonus,
} from "../lookups.js";
import { localize, localizeParam, rollLocation } from "../utils.js";
import { renderChatCard } from "../compat.js";
import { specialMeleeEffectsEnabled } from "../settings.js";

// ---------------------------------------------------------------------------
// Stable-id / skill-value resolution (vendored from CyberpunkActor statics).
// Pure reads — no dependence on the fork's actor class.
// ---------------------------------------------------------------------------

/** All stable ids that can identify an Item (embedded id + compendium source id). Names ignored. */
function getItemIdCandidates(itemData) {
  const ids = new Set();
  const add = (value) => {
    if (value == null || value === "") return;
    ids.add(String(value));
  };
  const addSourceId = (sourceId) => {
    if (!sourceId || typeof sourceId !== "string") return;
    add(sourceId.split(".").pop());
  };

  add(itemData?.id);
  add(itemData?._id);
  add(itemData?._source?._id);
  addSourceId(itemData?.flags?.core?.sourceId);
  addSourceId(itemData?._source?.flags?.core?.sourceId);

  return [...ids];
}

/** Effective skill value, honouring an active chip override. */
function realSkillValue(skill) {
  if (!skill) return 0;
  const data = skill.system ?? skill;
  let value = Number(data.level) || 0;
  const chipActive = !!(data.isChipped || data.autoChipped);
  if (chipActive) value = Number(data.chipLevel) || 0;
  return value;
}

/** A manually-entered base level still makes an art selectable even if a stale chip zeroes it. */
function hasAnyPositiveSkillValue(skill) {
  const data = skill?.system ?? skill ?? {};
  return (Number(data.level) || 0) > 0
    || (Number(data.chipLevel) || 0) > 0
    || realSkillValue(skill) > 0;
}

/** Normalize skill names for non-martial fallback lookups only (martial arts resolve by id). */
function normalizeSkillName(value) {
  return String(value ?? "")
    .replace(/\s*~\s*/g, "")
    .replace(/\s*\(\d+\)\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Find an owned skill Item by the stable id used in the lookup tables. */
function getSkillByStableId(actor, stableId) {
  if (!actor || !stableId) return null;
  const direct = actor.items.get(stableId);
  if (direct?.type === "skill") return direct;
  return actor.items.find((item) => {
    if (item.type !== "skill") return false;
    return getItemIdCandidates(item).includes(stableId);
  }) ?? null;
}

// ---------------------------------------------------------------------------
// Flag-relocation accessors for ours-only skill fields.
// ---------------------------------------------------------------------------

/** True if a skill is a martial art: system field / "Martial Arts:" name (fork + built-ins) or our flag (vanilla custom styles). */
export function isMartialArtSkill(item) {
  if (!item) return false;
  if (isMartialArtSkillItem(item)) return true;
  try { return item.getFlag?.(MODULE_ID, "isMartialArt") === true; } catch { return false; }
}

/** Per-action bonus override map for a style: system field (fork) then flag (vanilla), else null. */
export function martialBonusesFor(skill) {
  if (!skill) return null;
  const sys = skill.system?.martialBonuses;
  if (sys) return sys;
  try { return skill.getFlag?.(MODULE_ID, "martialBonuses") ?? null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Public actor helpers (vendored from CyberpunkActor; this -> actor).
// ---------------------------------------------------------------------------

/** Effective level of a skill (built-in martial arts resolve by stable id; others by localized/raw name). */
export function getSkillVal(actor, skillName) {
  if (!actor) return 0;

  const martialId = MARTIAL_ART_ID_BY_KEY?.[skillName];
  if (martialId) {
    const byId = getSkillByStableId(actor, martialId);
    return byId ? realSkillValue(byId) : 0;
  }

  const nameLoc = localize("Skill" + skillName);
  const prefixLoc = localize("SkillMartialArts");

  const shortName = nameLoc.includes("Skill") ? null : nameLoc;
  const candidates = new Set();

  if (shortName) candidates.add(normalizeSkillName(shortName));
  if (shortName && !prefixLoc.includes("Skill")) {
    candidates.add(normalizeSkillName(`${prefixLoc}: ${shortName}`));
  }
  candidates.add(normalizeSkillName(skillName));

  const skillItem = actor.itemTypes.skill.find((s) => candidates.has(normalizeSkillName(s.name)));
  return skillItem ? realSkillValue(skillItem) : 0;
}

/** Resolve the skill Item backing a martial-art selection value (built-in key by id, custom by name). */
export function getMartialArtSkill(actor, value) {
  if (!actor || !value || value === "Brawling") return null;

  const id = MARTIAL_ART_ID_BY_KEY[value];
  if (id) {
    const byId = getSkillByStableId(actor, id);
    if (byId) return byId;
  }
  const norm = normalizeSkillName(value);
  return actor.itemTypes.skill.find((s) => normalizeSkillName(s.name) === norm) ?? null;
}

/** Trained martial-art styles for the attack-dialog dropdown: [{ value, label }]. */
export function trainedMartials(actor) {
  if (!actor) return [];

  const fnff2 = isFnff2Enabled();
  const out = [];

  for (const skill of actor.itemTypes.skill) {
    // Built-in style? Resolve its canonical key via any of the skill's stable ids.
    let builtinKey = null;
    for (const id of getItemIdCandidates(skill)) {
      if (MARTIAL_ART_KEY_BY_ID[id]) { builtinKey = MARTIAL_ART_KEY_BY_ID[id]; break; }
    }

    const isMartial = (builtinKey !== null) || isMartialArtSkill(skill);
    if (!isMartial) continue;
    if (!hasAnyPositiveSkillValue(skill)) continue;

    // Hide FNFF2-only built-in styles when FNFF2 is disabled.
    if (builtinKey && !fnff2 && FNFF2_ONLY_MARTIAL_ART_KEYS.has(builtinKey)) continue;

    const value = builtinKey ?? skill.name;
    const label = martialArtDisplayName(skill.name) || skill.name;
    out.push({ value, label });
  }

  return out;
}

/**
 * Opposed melee/martial defense roll: the defender's best of the standard defense skills (plus any
 * trained martial art) + REF + 1d10. Vendored from CyberpunkItem._rollMeleeDefense (item.js), using
 * the module's own getSkillVal/trainedMartials so it runs on his vanilla.
 *
 * @param {Actor} targetActor
 * @returns {Promise<{roll: Roll, total: number, skillName: string, skillVal: number, ref: number}>}
 */
export async function rollMeleeDefense(targetActor) {
  const ref = Number(targetActor?.system?.stats?.ref?.total) || 0;

  const CANDIDATES = ["Melee", "Fencing", "Brawling", "Dodge", "Athletics"];
  let best = { name: localize("NoSkill"), val: 0 };
  for (const sk of CANDIDATES) {
    const val = Number(getSkillVal(targetActor, sk) ?? 0);
    if (val > best.val) best = { name: sk, val };
  }
  for (const m of trainedMartials(targetActor)) {
    const val = Number(getSkillVal(targetActor, m.value) ?? 0);
    if (val > best.val) best = { name: m.label, val };
  }

  const roll = await new Roll("1d10 + @ref + @skill", { ref, skill: best.val }).evaluate();
  return { roll, total: roll.total, skillName: best.name, skillVal: best.val, ref };
}

/**
 * Special martial hit-effects (CP2020 p.100–102). Faithful port of CyberpunkItem._applyMartialHitEffects,
 * but built the conformant way — a chat template + i18n, not the fork's inline HTML strings. Status
 * flags are written under the module scope (the module owns combat status on vanilla, like dodging/
 * parrying in damage-hooks.js). Gated on specialMeleeEffectsEnabled().
 *
 * @param {string} action          a martialActions value
 * @param {Actor}  targetActor
 * @param {Actor}  [attackerActor]
 */
export async function applyMartialHitEffects(action, targetActor, attackerActor) {
  if (!specialMeleeEffectsEnabled() || !targetActor) return;
  const names = { target: targetActor.name, attacker: attackerActor?.name ?? "" };

  let titleKey = null, bodyKey = null;
  if (action === martialActions.throw || action === martialActions.sweepTrip) {
    titleKey = "MartialFxKnockdownTitle"; bodyKey = "MartialFxKnockdownBody";
  } else if (action === martialActions.hold) {
    await targetActor.setFlag(MODULE_ID, "heldBy", attackerActor?.id ?? "").catch(() => {});
    titleKey = "MartialFxHeldTitle"; bodyKey = "MartialFxHeldBody";
  } else if (action === martialActions.grapple) {
    await targetActor.setFlag(MODULE_ID, "grappledBy", attackerActor?.id ?? "").catch(() => {});
    titleKey = "MartialFxGrappledTitle"; bodyKey = "MartialFxGrappledBody";
  } else if (action === martialActions.choke) {
    await targetActor.setFlag(MODULE_ID, "chokeState", { formula: "1d6" }).catch(() => {});
    titleKey = "MartialFxChokeTitle"; bodyKey = "MartialFxChokeBody";
  } else if (action === martialActions.escape) {
    await targetActor.unsetFlag(MODULE_ID, "heldBy").catch(() => {});
    await targetActor.unsetFlag(MODULE_ID, "grappledBy").catch(() => {});
    await targetActor.unsetFlag(MODULE_ID, "chokeState").catch(() => {});
    titleKey = "MartialFxEscapedTitle"; bodyKey = "MartialFxEscapedBody";
  } else {
    return; // no special effect for this action
  }

  const content = await renderChatCard("martial-effect.hbs", {
    title: localizeParam(titleKey, names),
    body: localizeParam(bodyKey, names),
  });
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor: targetActor }) });
}

// ---------------------------------------------------------------------------
// Attack resolver.
//
// Faithful port of the initiation half of the fork's CyberpunkItem.__martialBonk (item.js):
// build the to-hit + damage rolls (Core or FNFF2 damage-bonus rules, CyberTerminus ×2/×3), post a
// chat card, and emit cyberpunk2020.weaponFired so the module's combat engine applies the damage.
// Operates on a plain actor so it runs on his vanilla, where item.js has no such method.
//
// Contested defense + special MA hit-effects are intentionally NOT here (see the martial slice
// plan): v1 emits the resolved strike and the GM confirms the hit via the engine's Apply-Damage
// path; contested defense is added as the final v1 step.
// ---------------------------------------------------------------------------

/**
 * @param {Actor}  actor
 * @param {object} opts
 * @param {string} opts.martialArt        "Brawling" or a trainedMartials() value
 * @param {string} opts.action            a martialActions value; the combat-tab button chooses it
 * @param {string} [opts.cyberTerminus]   "NoCyberlimb" | "CyberTerminusX2" | "CyberTerminusX3"
 * @param {number} [opts.extraMod]        extra to-hit modifier from the dialog
 * @param {Item}   [opts.weaponItem]      optional melee/cyber weapon backing the strike (WA + base damage)
 * @returns {Promise<{attackRoll: Roll}|null>}
 */
export async function rollMartialAttack(actor, {
  martialArt,
  action = martialActions.strike,
  cyberTerminus = "NoCyberlimb",
  extraMod = 0,
  weaponItem = null,
} = {}) {
  if (!actor) return null;

  const isMartial = !!martialArt && martialArt !== "Brawling";
  const martialSkillLevel = getSkillVal(actor, martialArt);
  const keyTechniqueBonus = 0;

  // Resolve the backing skill so custom styles can supply per-action bonuses + a clean title.
  const maSkill = getMartialArtSkill(actor, martialArt);
  const skillBonuses = martialBonusesFor(maSkill);
  const martialTitle = (martialArt === "Brawling")
    ? localize("SkillBrawling")
    : (maSkill ? martialArtDisplayName(maSkill.name)
               : (game.i18n.has(`CYBERPUNK.Skill${martialArt}`) ? localize("Skill" + martialArt) : martialArt));

  const actionBonus = getMartialActionBonus(martialArt, action, skillBonuses);
  const extra = Number(extraMod || 0);

  // FNFF2 martial damage-bonus rules (mirror of item.js): the bonus applies only to a Key Variant
  // (a style that has an action bonus) whose damage symbol is * or $; PanzerFaust uses level ×1.5.
  const fnff2 = isFnff2Enabled();
  let martialDamageBonusValue = 0;
  if (isMartial) {
    if (!fnff2) {
      martialDamageBonusValue = martialSkillLevel;
    } else {
      const symbol = getFnff2DamageBonusSymbol(action);
      const isKeyVariant = actionBonus > 0;
      const levelForDamage = (martialArt === "Martial Arts: PanzerFaust")
        ? Math.floor(martialSkillLevel * 1.5)
        : martialSkillLevel;
      martialDamageBonusValue = ((symbol === "*" || symbol === "$") && isKeyVariant) ? levelForDamage : 0;
    }
  }

  // Accuracy from a backing weapon, if any (unarmed = 0).
  const sysWeapon = weaponItem?.system ?? null;
  const weaponAccuracy = Number(sysWeapon?.accuracy ?? 0) || 0;

  const attackRoll = await new Roll(
    `1d10x10 + @stats.ref.total + @attackBonus + @keyTechniqueBonus + @actionBonus + @extraMod${weaponAccuracy !== 0 ? " + @weaponAccuracy" : ""}`,
    {
      stats: actor.system.stats,
      attackBonus: martialSkillLevel,
      keyTechniqueBonus,
      actionBonus,
      extraMod: extra,
      weaponAccuracy,
    },
  ).evaluate();

  // Damage formula: a backing weapon's damage if present, else the unarmed strike/kick dice.
  // Non-damaging actions (block/dodge/grapple/hold/sweep/disarm/escape) deal no damage.
  const baseWeaponDamage = (sysWeapon?.damage && String(sysWeapon.damage).trim()) ? String(sysWeapon.damage).trim() : "";
  let damageFormula = "";
  if (baseWeaponDamage) {
    damageFormula = `${baseWeaponDamage}+@strengthBonus+@martialDamageBonus`;
  } else if (action === martialActions.strike) {
    damageFormula = "1d3+@strengthBonus+@martialDamageBonus";
  } else if ([martialActions.kick, martialActions.throw, martialActions.choke].includes(action)) {
    damageFormula = "1d6+@strengthBonus+@martialDamageBonus";
  }
  if (damageFormula) {
    if (cyberTerminus === "CyberTerminusX2") damageFormula = `(${damageFormula})*2`;
    else if (cyberTerminus === "CyberTerminusX3") damageFormula = `(${damageFormula})*3`;
  }

  const rolls = [attackRoll];
  const cardData = {
    actorName: actor.name,
    img: actor.img,
    title: localizeParam("MartialTitle", { action: localize(action), martialArt: martialTitle }),
    attackRender: await attackRoll.render(),
    hasDamage: false,
  };

  if (damageFormula) {
    // Resolve the target (if exactly one) so the hit lands on their body + the engine can target them.
    const target = (game.user?.targets?.size === 1) ? game.user.targets.first() : null;
    const targetActor = target?.actor ?? null;

    const loc = await rollLocation(targetActor, null);
    const damageRoll = await new Roll(damageFormula, {
      strengthBonus: strengthDamageBonus(Number(actor.system?.stats?.bt?.total) || 0),
      martialDamageBonus: martialDamageBonusValue,
    }).evaluate();
    damageRoll._total = Math.floor(damageRoll.total);   // CP2020: any fractional damage rounds down

    rolls.push(loc.roll, damageRoll);
    cardData.hasDamage = true;
    cardData.areaHit = loc.areaHit;
    cardData.damageRender = await damageRoll.render();

    // Contested resolution (mirror of __martialBonk): when there is exactly one target, the defender
    // rolls REF + best defense skill; the attack lands only if it beats that total. A held Dodge adds
    // +2 to the defense; a held Parry blocks outright. Those flags are set by the module's own Dodge/
    // Parry actions under the module scope (see damage-hooks.js); on plain vanilla they are simply
    // absent, so this reduces to a straight opposed roll.
    let doEmit = true;
    if (targetActor) {
      const def = await rollMeleeDefense(targetActor);
      rolls.push(def.roll);

      const dodgeBonus = targetActor.getFlag?.(MODULE_ID, "dodging") ? 2 : 0;
      const parried = !!targetActor.getFlag?.(MODULE_ID, "parrying");
      const hits = !parried && (attackRoll.total > def.total + dodgeBonus);

      cardData.contested = {
        defenderName: targetActor.name,
        skillName: def.skillName,
        skillVal: def.skillVal,
        ref: def.ref,
        dodgeBonus,
        parried,
        hits,
        defenseRender: await def.roll.render(),
      };
      doEmit = hits;
    }

    // Emit so the module's combat engine applies damage. With a target, only on a contested hit;
    // with no target, always (the engine surfaces an Apply-Damage control for the GM to adjudicate).
    if (doEmit) {
      const payload = {
        areaDamages: { [loc.areaHit]: [{ damage: damageRoll.total }] },
        ap: Boolean(sysWeapon?.ap),
        edged: Boolean(sysWeapon?.isEdged),
        weaponName: cardData.title,
      };
      if (targetActor) {
        payload.targetTokenId = target.id;
        payload.targetActorId = targetActor.id;
      }
      Hooks.callAll("cyberpunk2020.weaponFired", payload);
      // Damage actions that also carry an effect (Throw knockdown, Choke status) apply it on a hit.
      if (targetActor) await applyMartialHitEffects(action, targetActor, actor);
    }
  }

  // Non-damaging special maneuvers (Hold / Grapple / Sweep-Trip / Escape): opposed roll, and on a hit
  // the status effect is applied (mirror of __martialBonk's T4-B block). No damage, no weaponFired.
  const SPECIAL_NO_DAMAGE = [martialActions.hold, martialActions.grapple, martialActions.sweepTrip, martialActions.escape];
  if (!damageFormula && specialMeleeEffectsEnabled() && SPECIAL_NO_DAMAGE.includes(action)) {
    const target = (game.user?.targets?.size === 1) ? game.user.targets.first() : null;
    const targetActor = target?.actor ?? null;
    if (targetActor) {
      const def = await rollMeleeDefense(targetActor);
      rolls.push(def.roll);
      const hits = attackRoll.total > def.total;
      cardData.contested = {
        defenderName: targetActor.name,
        skillName: def.skillName,
        skillVal: def.skillVal,
        ref: def.ref,
        dodgeBonus: 0,
        parried: false,
        hits,
        defenseRender: await def.roll.render(),
      };
      if (hits) await applyMartialHitEffects(action, targetActor, actor);
    }
  }

  const content = await renderChatCard("martial-attack.hbs", cardData);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    rolls,
  });

  return { attackRoll };
}
