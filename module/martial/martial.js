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
} from "../lookups.js";
import { localize, localizeParam } from "../utils.js";
import { renderChatCard, postSavePromptCard } from "../compat.js";
import { onGlobalClick } from "../popout-compat.js";
import { markCardResolved } from "../card-lock.js";
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

/** Find an owned skill Item by the stable id used in the lookup tables. Among multiple matches
 *  (actor creation seeds every built-in style at level 0 under its canonical _id, so a seeded
 *  row can coexist with a leveled compendium-dragged copy) the highest effective level wins —
 *  the old first-match returned the seeded 0 and shadowed the real skill. Ties go to the
 *  direct embedded-id match, the previous behavior's preference. */
function getSkillByStableId(actor, stableId) {
  if (!actor || !stableId) return null;
  const matches = actor.items.filter((item) =>
    item.type === "skill" && getItemIdCandidates(item).includes(stableId));
  if (!matches.length) return null;
  let best = matches[0];
  for (const s of matches.slice(1)) {
    const d = realSkillValue(s) - realSkillValue(best);
    if (d > 0 || (d === 0 && s.id === stableId && best.id !== stableId)) best = s;
  }
  return best;
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

  // "DodgeEscape" resolves the base's canonical skill (CYBERPUNK.SkillDodgeEscape → "Dodge & Escape");
  // the bare "Dodge" candidate had no i18n key, so the canonical skill contributed 0 (review H3's
  // latent defect). "Dodge" is kept for custom skills literally named that — consider() takes the best.
  const CANDIDATES = ["Melee", "Fencing", "Brawling", "DodgeEscape", "Dodge", "Athletics"];
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
// Offered contested defense (the GM-choice model — user directive: never a silent auto-resolve).
//
// The status maneuvers (hold / grapple / choke / throw / sweep) used to apply ON-DECLARE; now the
// declare posts an OFFER card instead: the target's owner (or the GM) may roll the opposed defense
// (rollMeleeDefense + the declared-dodge fold — the same engine the keeper proves), and the GM
// adjudicates the outcome against the attack roll already on the table — [effect lands] applies the
// status, [evaded] posts the miss. [Apply effect] skips the contest entirely (the old on-declare
// behavior, one click away). Escape never contests: it is the actor freeing themselves.
// Card buttons carry their context in data-* attrs (the drug/stun save-card idiom) and are wired
// by ONE delegated handler registered at init (registerMartialDefense).
// ---------------------------------------------------------------------------

/** Apply a status effect to the target — directly when this client may write it, else relayed to
 *  the active GM over the socket (the martialEffect relay in combat/damage-hooks.js). Single home:
 *  the sheet's on-declare path and the offer card's buttons both call this. */
export async function applyOrRelayMartialEffect(action, targetActor, attackerActor) {
  if (!targetActor) return;
  if (game.user.isGM || targetActor.isOwner) {
    await applyMartialHitEffects(action, targetActor, attackerActor);
  } else if (game.users.activeGM) {
    // Unambiguous refs: a synthetic (unlinked-token) actor's id collides with its world actor's —
    // the uuid + scene-qualified token keep the GM-side flag write on the token that was grabbed.
    game.socket.emit("module.cp2020-augmented", {
      type: "martialEffect", action,
      targetActorId: targetActor.id, attackerActorId: attackerActor?.id ?? null,
      targetActorUuid: targetActor.uuid ?? null,
      targetTokenId: targetActor.token?.id ?? null,
      targetSceneId: targetActor.token?.parent?.id ?? null,
    });
  }
}

/** The status maneuvers whose application is offered as a contest (escape excluded — self-directed). */
export const CONTESTED_MARTIAL_ACTIONS = new Set([
  martialActions.hold, martialActions.grapple, martialActions.choke,
  martialActions.throw, martialActions.sweepTrip,
]);

/**
 * Post the defense-offer card for a declared status maneuver. Gated like the effects themselves
 * (specialMeleeEffectsEnabled) — with the feature off there is no effect to contest.
 */
export async function postMartialDefenseOffer({ attackerActor, targetActor, targetTokenId = "", action }) {
  if (!specialMeleeEffectsEnabled() || !targetActor || !CONTESTED_MARTIAL_ACTIONS.has(action)) return false;
  const content = await renderChatCard("martial-defense-offer.hbs", {
    title: localizeParam("MartialDefenseOfferTitle", { target: targetActor.name }),
    body: localizeParam("MartialDefenseOfferBody", {
      attacker: attackerActor?.name ?? "", target: targetActor.name, action: localize(action),
    }),
    action,
    attackerActorId: attackerActor?.id ?? "",
    targetActorId: targetActor.id,
    targetTokenId,
  });
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor: targetActor }) });
  return true;
}

/** Roll the offered defense and post the result card (breakdown + the GM's outcome buttons). */
async function _rollOfferedDefense({ targetActor, targetTokenId = "", attackerActorId, action }) {
  const isDodging = !!targetActor.getFlag?.(SCOPE, "dodging");
  const def = await rollMeleeDefense(targetActor, { dodging: isDodging });
  const dodgeBonus = declaredDodgeBonus(isDodging, def.dodgeKeyBonus);
  const total = def.total + dodgeBonus;
  // Render edge: the pure roll reports the stable candidate KEY (e.g. "DodgeEscape"); the card
  // shows its localized skill name when one exists (value-is-key convention), else the raw label.
  const skillLabel = game.i18n.has(`CYBERPUNK.Skill${def.skillName}`)
    ? localize(`Skill${def.skillName}`) : def.skillName;
  const content = await renderChatCard("martial-defense-result.hbs", {
    title: localizeParam("MartialDefenseResultTitle", { target: targetActor.name }),
    breakdown: localizeParam("MartialDefenseBreakdown", {
      skill: skillLabel, val: def.skillVal, ref: def.ref, total,
    }),
    dodgeClause: dodgeBonus > 0 ? localizeParam("MartialDefenseDodgeClause", { bonus: dodgeBonus }) : "",
    action,
    attackerActorId: attackerActorId ?? "",
    targetActorId: targetActor.id,
    targetTokenId,
  });
  await ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor: targetActor }),
    rolls: [def.roll],
  });
}

/** Resolve an actor from a card's data-* pair token-first: an unlinked token shares no state with the
 *  world prototype, so the opposed roll must read — and the status flags must write to — the TOKEN's
 *  actor, not `game.actors.get(id)`. Mirrors the combat subsystem's target resolution (damage-hooks.js). */
function _resolveCardActor(tokenId, actorId) {
  const tokenActor = tokenId ? canvas.tokens?.get(tokenId)?.actor : null;
  if (tokenActor) return tokenActor;
  return (actorId ? game.actors.get(actorId) : null) ?? null;
}

// Per-client claim of an offer/result card: the first adjudication click (or defense roll) disables the
// card's button row and stamps the message id, so a repeat click is a no-op — no duplicate contest rolls
// or effect cards. Keyed by message id so a chat re-render (which restores the DOM) still no-ops. The
// AREA_CONFIRMERS claim idiom (combat/damage-hooks.js).
const _claimedMartialCards = new Set();
function _claimMartialCard(btn, messageId) {
  if (messageId) {
    if (_claimedMartialCards.has(messageId)) return false;
    _claimedMartialCards.add(messageId);
  }
  btn.closest(".save-buttons")?.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  return true;
}

/** Delegated click wiring for the offer/result card buttons — called once from the module's init. */
export function registerMartialDefense() {
  onGlobalClick(async (ev) => {
    const btn = ev.target?.closest?.(
      ".cp-martial-defense-roll, .cp-martial-defense-apply, .cp-martial-defense-lands, .cp-martial-defense-evaded");
    if (!btn) return;
    ev.preventDefault();
    const messageId = btn.closest?.("[data-message-id]")?.dataset?.messageId ?? "";
    const targetTokenId = btn.dataset.targetTokenId ?? "";
    const targetActor = _resolveCardActor(targetTokenId, btn.dataset.targetActorId);
    const attackerActor = _resolveCardActor("", btn.dataset.attackerActorId);
    const action = btn.dataset.action ?? "";
    if (!targetActor || !action) return;

    if (btn.classList.contains("cp-martial-defense-roll")) {
      // The defender's owner (or the GM) chooses to roll — the offer, not an auto-resolve.
      if (!game.user.isGM && !targetActor.isOwner) {
        ui.notifications?.warn(localize("MartialDefenseNotAllowed"));
        return;
      }
      if (!_claimMartialCard(btn, messageId)) return;
      await _rollOfferedDefense({ targetActor, targetTokenId, attackerActorId: btn.dataset.attackerActorId, action });
      // One-shot persistence: the in-memory claim above disables the buttons for this session; the stamp
      // survives reload + drives the render-pass lock for every client (card-lock.js).
      await markCardResolved(messageId, "martialDefenseRoll");
      return;
    }

    // The outcome calls (apply-without-contest / lands / evaded) are the GM's adjudication.
    if (!game.user.isGM) {
      ui.notifications?.warn(localize("MartialDefenseGmOnly"));
      return;
    }
    if (!_claimMartialCard(btn, messageId)) return;
    if (btn.classList.contains("cp-martial-defense-evaded")) {
      await postSavePromptCard({
        body: localizeParam("MartialDefenseEvadedBody", { target: targetActor.name, action: localize(action) }),
        speaker: ChatMessage.getSpeaker({ actor: targetActor }),
      });
      await markCardResolved(messageId, "martialDefenseEvaded");
      return;   // nothing was applied at declare time, so an evade writes no state
    }
    // cp-martial-defense-apply (skip the contest) and cp-martial-defense-lands (contest won) both apply.
    await applyOrRelayMartialEffect(action, targetActor, attackerActor);
    await markCardResolved(messageId, "martialDefenseApplied");
  });
}
