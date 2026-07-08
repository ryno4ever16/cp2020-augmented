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

// Module flag / settings scope (per-file convention used across the module).
const SCOPE = "cp2020-augmented";

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

  // Foundry v12+ records a document's compendium origin on _stats.compendiumSource
  // (flags.core.sourceId is deprecated/absent on items created after that change). Without
  // this, a built-in martial-art skill added to a sheet keeps only its fresh embedded _id,
  // fails the id lookup, and is misclassified as a custom style — losing its Key-Attack bonus.
  addSourceId(itemData?._stats?.compendiumSource);
  addSourceId(itemData?._source?._stats?.compendiumSource);

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
  try { return item.getFlag?.(SCOPE, "isMartialArt") === true; } catch { return false; }
}

/** Per-action bonus override map for a style: system field (fork) then flag (vanilla), else null. */
export function martialBonusesFor(skill) {
  if (!skill) return null;
  const sys = skill.system?.martialBonuses;
  if (sys) return sys;
  try { return skill.getFlag?.(SCOPE, "martialBonuses") ?? null; } catch { return null; }
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
 * Opposed melee/martial defense roll (CP2020 melee formula): the defender's best SINGLE defense skill +
 * REF + 1d10. The eligible skills are Melee, Fencing, Brawling, Dodge & Escape, Athletics, or a trained
 * martial art — the defender uses ONE, not several. Vendored from CyberpunkItem._rollMeleeDefense
 * (item.js), using the module's own getSkillVal/trainedMartials so it runs on his vanilla.
 *
 * When a dodge is DECLARED, a trained martial art's Dodge key-attack bonus (Core p.100) rides on THAT
 * art's roll, so it is folded into the skill SELECTION here — an art is only worth choosing over a plain
 * higher-level skill if its level+Dodge-key wins. `dodgeKeyBonus` is the chosen skill's Dodge key (0 for
 * a non-martial skill, or when no dodge is declared), so an art's level and its key never come from two
 * different skills. The generic declared-dodge stance (+2, available to anyone) is added by the caller.
 *
 * @param {Actor}   targetActor
 * @param {object}  [opts]
 * @param {boolean} [opts.dodging]  the defender declared a dodge → weigh + report the Dodge key bonus
 * @returns {Promise<{roll: Roll, total: number, skillName: string, skillVal: number, ref: number, dodgeKeyBonus: number}>}
 */
export async function rollMeleeDefense(targetActor, { dodging = false } = {}) {
  const ref = Number(targetActor?.system?.stats?.ref?.total) || 0;

  const CANDIDATES = ["Melee", "Fencing", "Brawling", "Dodge", "Athletics"];
  let best = { name: localize("NoSkill"), val: 0, dodgeKeyBonus: 0 };
  // Rank by effective defense value (level + Dodge key when dodging); ties keep the earlier candidate.
  const consider = (name, val, dodgeKeyBonus) => {
    if ((val + dodgeKeyBonus) > (best.val + best.dodgeKeyBonus)) best = { name, val, dodgeKeyBonus };
  };
  for (const sk of CANDIDATES) consider(sk, Number(getSkillVal(targetActor, sk) ?? 0), 0);
  for (const m of trainedMartials(targetActor)) {
    const val = Number(getSkillVal(targetActor, m.value) ?? 0);
    const key = dodging
      ? Number(getMartialActionBonus(m.value, martialActions.dodge, martialBonusesFor(getMartialArtSkill(targetActor, m.value))) || 0)
      : 0;
    consider(m.label, val, key);
  }

  const roll = await new Roll("1d10 + @ref + @skill", { ref, skill: best.val }).evaluate();
  return { roll, total: roll.total, skillName: best.name, skillVal: best.val, ref, dodgeKeyBonus: best.dodgeKeyBonus };
}

/**
 * The bonus a DECLARED dodge adds to the defender's opposed roll (CP2020 p.102): a generic +2 stance
 * available to anyone dodging (the book's "−2 to attacker", expressed as +2 to the defender's total),
 * PLUS the defender's martial-style Dodge key-attack bonus (Core p.100) — additive, per the user's
 * ruling. `dodgeKeyBonus` must be the key of the SAME art rollMeleeDefense chose (0 for a non-martial
 * dodge), so the two never compose across different skills. Pure (no dice/i18n) for the unit rig.
 *
 * @param {boolean} isDodging
 * @param {number}  dodgeKeyBonus  the chosen art's Dodge key from rollMeleeDefense (0 if none)
 * @returns {number}
 */
export function declaredDodgeBonus(isDodging, dodgeKeyBonus) {
  return isDodging ? 2 + (Number(dodgeKeyBonus) || 0) : 0;
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
    await targetActor.setFlag(SCOPE, "heldBy", attackerActor?.id ?? "").catch(() => {});
    titleKey = "MartialFxHeldTitle"; bodyKey = "MartialFxHeldBody";
  } else if (action === martialActions.grapple) {
    await targetActor.setFlag(SCOPE, "grappledBy", attackerActor?.id ?? "").catch(() => {});
    titleKey = "MartialFxGrappledTitle"; bodyKey = "MartialFxGrappledBody";
  } else if (action === martialActions.choke) {
    await targetActor.setFlag(SCOPE, "chokeState", { formula: "1d6" }).catch(() => {});
    titleKey = "MartialFxChokeTitle"; bodyKey = "MartialFxChokeBody";
  } else if (action === martialActions.escape) {
    await targetActor.unsetFlag(SCOPE, "heldBy").catch(() => {});
    await targetActor.unsetFlag(SCOPE, "grappledBy").catch(() => {});
    await targetActor.unsetFlag(SCOPE, "chokeState").catch(() => {});
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
    // rolls REF + best defense skill; the attack lands only if it beats that total. A declared Dodge
    // adds a generic +2 to the defense PLUS the defender's martial style Dodge key-attack bonus (Core
    // p.100 — additive per the user's ruling); a held Parry blocks outright. Those flags are set by the
    // module's own Dodge/Parry actions under the module scope (see damage-hooks.js); on plain vanilla
    // they are simply absent, so this reduces to a straight opposed roll.
    let doEmit = true;
    if (targetActor) {
      const isDodging = !!targetActor.getFlag?.(SCOPE, "dodging");
      const def = await rollMeleeDefense(targetActor, { dodging: isDodging });
      rolls.push(def.roll);

      // def.dodgeKeyBonus is the Dodge key of the SAME art rollMeleeDefense chose for the roll (0 for a
      // non-martial dodge), so the generic stance and the style bonus stack without composing two skills.
      const dodgeBonus = declaredDodgeBonus(isDodging, def.dodgeKeyBonus);
      const parried = !!targetActor.getFlag?.(SCOPE, "parrying");
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
