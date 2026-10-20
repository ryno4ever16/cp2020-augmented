/**
 * melee-contest.js  —  module/martial/melee-contest.js
 *
 * THE OPPOSED MELEE ROLL (CP2020 p.111): "ATTACKER REF+SKILL+1D10 vs DEFENDER'S REF+SKILL*+1D10 —
 * *Martial arts, Fencing, Melee, Dodge or Athletics can be used, depending on situation and Referee
 * decision." Ties go to the defender (p.39, Opposed Tasks: "On an equal or higher roll, the defending
 * player wins."). Brawling defends too (the user's ruling: p.111 hands brawlers the whole manoeuvre list).
 *
 * The flow on a 1.1.1 host. The base system rolls the attack, the damage and the location on ONE card and
 * never asks the defender anything. The shot path (combat/damage-hooks.js, PATH A) used to open the apply
 * window straight from that card; for a melee card aimed at one figure it now posts the CONTEST card
 * instead, with the shot's payload stored on it, and the verdict reopens the road the window used to take:
 *
 *   attack card → contest card ─[Choose defense]→ window (skill list, best preselected) → roll → result card
 *               └─ GM: [Hit] / [Miss] without a roll                                          │
 *   hit  → the presenting client runs what PATH A ran: status manoeuvre, parry redirect, apply window
 *   miss → nothing more.
 *
 * WHO. The defender's owner or the GM chooses and rolls (a PC's player, the GM for an NPC) — "the GM says
 * 'roll fencing', the player rolls fencing". The CONSEQUENCE runs on the presenting client — the one that
 * would have opened the apply window had there been no contest (the client that swung, else the primary
 * GM session) — so a player's roll on their own client still opens the window where PATH A would have.
 *
 * WHAT STAYS WHERE IT WAS. Damage and location are the base's dice, rolled before the contest and shown on
 * the attack card (the user's call: card shape B); the verdict only decides whether they are applied. The
 * multi-action counter never sees a defense roll (the opposed roll is free, p.111/p.98). Ranged attacks are
 * untouched. A defender carrying the `unconscious` status cannot defend (p.104 "out of combat") and the
 * card resolves itself as a hit; a fumbled attack resolves itself as a miss; the GM can override either.
 *
 * Stands down with the rest of the combat layer when the host provides combat automation (Tilt's 1.2 has
 * its own `resolveDefense`): wired under `doCombat` in cp2020-augmented.js.
 */
import { localize, localizeParam, firingActorOf } from "../utils.js";
import { renderChatCard, postSavePromptCard } from "../compat.js";
import { onGlobalClick } from "../popout-compat.js";
import { markCardResolved } from "../card-lock.js";
import { isPrimaryGMSession } from "../gm-session-primary.js";
import { martialActions, getMartialActionBonus } from "../lookups.js";
import {
  getSkillVal, trainedMartials, getMartialArtSkill, martialBonusesFor,
  applyOrRelayMartialEffect, CONTESTED_MARTIAL_ACTIONS,
} from "./martial.js";
import { applyResolvedMeleeHit } from "../combat/damage-hooks.js";

const SCOPE = "cp2020-augmented";
const CONTEST_FLAG = "meleeContest";
const RESULT_FLAG = "meleeResult";
const BREAK_FLAG = "parryBreakSave";
const VEHICLE_TYPE = `${SCOPE}.vehicle`;

/** The base's two melee resolvers (seam-shim.js FIRE_METHODS). */
export const MELEE_FIRE_METHODS = new Set(["__meleeBonk", "__martialBonk"]);

/** The non-martial skills p.111 names, plus Brawling (ruling), as the base's skill keys (value-is-key). */
const DEFENSE_SKILLS = ["Melee", "Fencing", "Brawling", "DodgeEscape", "Athletics"];

/** p.112: "must make a save (9 or lower on 1D10) to avoid breaking". */
export const PARRY_BREAK_SAVE_MAX = 9;

const renderDialogTemplate = (path, context) =>
  (foundry?.applications?.handlebars?.renderTemplate ?? renderTemplate)(path, context);

/* ───────────────────────────── pure rules ───────────────────────────── */

/**
 * PURE. The verdict. A fumble never lands (the base ruled it); a defender who cannot defend is hit; otherwise
 * the attacker must EXCEED the defense — "on an equal or higher roll, the defending player wins" (p.39).
 * Unreadable totals read as a miss: a payload relayed as JSON can carry a null, and a null must never hit.
 */
export function meleeVerdict({ attackTotal, defenseTotal, fumble = false, cannotDefend = false } = {}) {
  if (fumble) return "miss";
  if (cannotDefend) return "hit";
  const a = Number(attackTotal), d = Number(defenseTotal);
  if (!Number.isFinite(a) || !Number.isFinite(d)) return "miss";
  return a > d ? "hit" : "miss";
}

/** PURE. The option the window preselects: the highest total, the first of equals. Null for no options. */
export function defaultDefenseOption(options) {
  let best = null;
  for (const o of options ?? []) if (!best || Number(o?.total) > Number(best.total)) best = o;
  return best;
}

/**
 * The defender's eligible defenses, each with the number it would roll on: every p.111 skill (plus Brawling)
 * as REF + level, and every trained art as two rows — Block/Parry and Dodge — carrying the art's key bonus
 * for that manoeuvre (p.100 table; "+0" where the style has none, which makes it a bonus list rather than a
 * permission list). The GM steers which one is used; this is what the window lists.
 */
export function defenseOptionsFor(actor) {
  const ref = Number(actor?.system?.stats?.ref?.total) || 0;
  const out = [];
  for (const key of DEFENSE_SKILLS) {
    const level = Number(getSkillVal(actor, key) ?? 0) || 0;
    const label = game.i18n.has(`CYBERPUNK.Skill${key}`) ? localize(`Skill${key}`) : key;
    out.push({ id: `skill:${key}`, kind: "skill", skillKey: key, label, maneuver: "", maneuverLabel: "", level, ref, key: 0, total: ref + level });
  }
  const blockKey = martialActions.blockParry ?? "BlockParry";
  const dodgeKey = martialActions.dodge ?? "Dodge";
  for (const m of trainedMartials(actor) ?? []) {
    const level = Number(getSkillVal(actor, m.value) ?? 0) || 0;
    const bonuses = martialBonusesFor(getMartialArtSkill(actor, m.value));
    for (const maneuver of [blockKey, dodgeKey]) {
      const key = Number(getMartialActionBonus(m.value, maneuver, bonuses) || 0);
      out.push({ id: `art:${m.value}:${maneuver}`, kind: "art", skillKey: m.value, label: m.label, maneuver,
        maneuverLabel: localize(maneuver), level, ref, key, total: ref + level + key });
    }
  }
  return out;
}

/** Who may choose and roll a defense: the GM, or an owner of the defending actor (a PC's player). */
export function canChooseDefense(user, defender) {
  if (!user || !defender) return false;
  if (user.isGM) return true;
  try { return defender.testUserPermission(user, "OWNER") === true; } catch (_e) { return false; }
}

/**
 * PURE. Where a declared parry sends a hit (p.112: "Any attacks made during the turn must expend their damage
 * against the parrying object first. Swords and other bladed weapons can be used to parry without taking
 * damage, but must make a save (9 or lower on 1D10) to avoid breaking."). A bladed weapon takes the hit in
 * the defender's place and saves; anything else — an arm, or a weapon that is not a blade (the book says
 * only blades parry undamaged) — takes the damage on the arm that holds it. No parry: untouched.
 * `parry` is the stored declaration: { object: "lArm" | "rArm" | "weapon", bladed?, weaponName?, itemId? }.
 */
export function parryRedirect(areaDamages, parry) {
  const src = areaDamages ?? {};
  if (!parry || typeof parry !== "object") return { areaDamages: src, breakSave: false, weaponName: "" };
  const hits = Object.values(src).flat();
  if (parry.object === "weapon" && parry.bladed) {
    return { areaDamages: {}, breakSave: true, weaponName: String(parry.weaponName ?? "") };
  }
  const loc = parry.object === "lArm" ? "lArm" : "rArm";
  return { areaDamages: hits.length ? { [loc]: hits } : {}, breakSave: false, weaponName: String(parry.weaponName ?? "") };
}

/** Does this shot go through the contest: a melee card aimed at exactly one figure. */
export function contestApplies(payload) {
  if (!MELEE_FIRE_METHODS.has(payload?.fireMethod)) return false;
  const n = Number(payload?.targetCount);
  if (Number.isFinite(n) && n > 1) return false;
  return !!(payload?.targetTokenId || payload?.fxTargetTokenId || payload?.targetActorId);
}

/* ───────────────────────────── helpers ───────────────────────────── */

/** Token-first actor resolution (an unlinked token keeps its own state); the directory actor as fallback. */
function _resolveActor(tokenId, actorId) {
  const tokenActor = tokenId ? canvas?.tokens?.get?.(tokenId)?.actor : null;
  if (tokenActor) return tokenActor;
  return (actorId ? game.actors.get(actorId) : null) ?? null;
}

/** The label a card prints for the attack: the martial action's name, else the weapon's. */
function _moveLabel(payload) {
  const action = String(payload?.attackContext?.martialAction ?? "");
  if (action && game.i18n.has(`CYBERPUNK.${action}`)) return localize(action);
  return String(payload?.weaponName ?? "");
}

/** Does this client present the consequence: the named presenter, or the primary GM seat once that user is gone. */
function _presentsHere(presenterUserId) {
  if (presenterUserId && presenterUserId === game.user?.id) return true;
  const presenter = presenterUserId ? game.users.get(presenterUserId) : null;
  return (!presenter || !presenter.active) && isPrimaryGMSession();
}

const _flagOf = (message) => message?.getFlag?.(SCOPE, CONTEST_FLAG) ?? null;

/* ───────────────────────────── the contest card ───────────────────────────── */

/**
 * Post the contest card for a melee shot aimed at `defender`, with the shot's payload stored on it. Called by
 * the shot path in place of opening the apply window. A defender who cannot defend, or a fumbled attack,
 * is resolved right away (the card still posts, so the table sees why).
 */
export async function postMeleeDefenseCard(payload, defender, { defenderTokenId = null, presenterUserId = game.user?.id ?? null } = {}) {
  if (!defender) return null;
  const attacker = firingActorOf(payload) ?? (payload?.attackerId ? game.actors.get(payload.attackerId) : null);
  const action = String(payload?.attackContext?.martialAction ?? "");
  const moveLabel = _moveLabel(payload);
  const cannotDefend = !!defender.statuses?.has?.("unconscious");
  const fumble = payload?.fumbleRuled === true;
  const attackTotal = Number.isFinite(Number(payload?.attackTotal)) ? Number(payload.attackTotal) : null;
  const names = { attacker: attacker?.name ?? "", target: defender.name, move: moveLabel, total: attackTotal ?? "?" };
  const content = await renderChatCard("melee-defense.hbs", {
    title: localizeParam("MeleeDefenseTitle", names),
    body: cannotDefend ? localizeParam("MeleeDefenseCannotBody", names)
        : fumble ? localizeParam("MeleeDefenseFumbleBody", names)
        : localizeParam("MeleeDefenseBody", names),
    autoResolved: cannotDefend || fumble,
  });
  const flag = {
    payload, action, moveLabel, attackTotal, cannotDefend, fumble,
    attackerActorId: attacker?.id ?? payload?.attackerId ?? null, attackerName: attacker?.name ?? "",
    defenderActorId: defender.id, defenderTokenId: defenderTokenId ?? null,
    presenterUserId, resolved: false,
  };
  const message = await ChatMessage.create({
    content, speaker: ChatMessage.getSpeaker({ actor: defender }),
    flags: { [SCOPE]: { [CONTEST_FLAG]: flag } },
  });
  if (cannotDefend || fumble) {
    await _postResult(message, { verdict: cannotDefend ? "hit" : "miss", auto: true });
  }
  return message;
}

/**
 * Open the defense window for a contest card: the eligible skills with their numbers, the best preselected,
 * an extra-modifier box for what the GM says at the table. Only the defender's owner or the GM may open it.
 * Resolves true when a roll was made.
 */
export async function openDefenseWindow(messageId, { defenderOverride = null } = {}) {
  const message = game.messages.get(messageId);
  const f = _flagOf(message);
  if (!f) return false;
  const defender = defenderOverride ?? _resolveActor(f.defenderTokenId, f.defenderActorId);
  if (!canChooseDefense(game.user, defender)) { ui.notifications?.warn(localize("MeleeDefenseNotAllowed")); return false; }
  if (f.resolved) { ui.notifications?.warn(localize("MeleeDefenseAlreadyResolved")); return false; }
  const options = defenseOptionsFor(defender);
  const preset = defaultDefenseOption(options);
  const content = await renderDialogTemplate("modules/cp2020-augmented/templates/dialog/melee-defense.hbs", {
    lead: localizeParam("MeleeDefenseWindowLead", { attacker: f.attackerName, move: f.moveLabel, total: f.attackTotal ?? "?", ref: Number(defender.system?.stats?.ref?.total) || 0 }),
    options: options.map(o => ({
      id: o.id, selected: o.id === preset?.id,
      label: o.kind === "art"
        ? localizeParam("MeleeDefenseOptionArt", { art: o.label, level: o.level, maneuver: o.maneuverLabel, key: o.key, ref: o.ref, total: o.total })
        : localizeParam("MeleeDefenseOptionSkill", { skill: o.label, level: o.level, ref: o.ref, total: o.total }),
    })),
  });
  return new Promise((resolve) => {
    new foundry.applications.api.DialogV2({
      classes: ["cp-melee-defense-dialog"],
      position: { width: 440 },
      window: { title: localizeParam("MeleeDefenseWindowTitle", { target: defender.name, attacker: f.attackerName }) },
      content,
      buttons: [
        {
          action: "roll", icon: "fas fa-dice-d10", label: localize("MeleeDefenseRollBtn"), default: true,
          callback: async (_ev, _btn, dlg) => {
            const root = dlg.element;
            const id = root.querySelector('select[name="defense"]')?.value ?? "";
            const extra = Number(root.querySelector('input[name="extraMod"]')?.value) || 0;
            const option = options.find(o => o.id === id) ?? preset;
            await _rollDefense(message, defender, option, extra);
            resolve(true);
          },
        },
        { action: "cancel", icon: "fas fa-times", label: localize("Cancel"), callback: () => resolve(false) },
      ],
      rejectClose: false,
      close: () => resolve(false),
    }).render({ force: true });
  });
}

/** The defender's roll: 1D10 + REF + skill (+ the art's key for the chosen manoeuvre) + extra. Posts the result. */
async function _rollDefense(message, defender, option, extra) {
  const f = _flagOf(message);
  if (!f || !option) return;
  const roll = await new Roll("1d10 + @base + @extra", { base: option.total, extra }).evaluate();
  const die = Number(roll.dice?.[0]?.total) || 0;
  const defense = {
    ref: option.ref, level: option.level, key: option.key || 0, extra, die, total: roll.total,
    skillLabel: option.kind === "art" ? `${option.label} (${option.maneuverLabel})` : option.label,
  };
  const verdict = meleeVerdict({ attackTotal: f.attackTotal, defenseTotal: roll.total, fumble: f.fumble, cannotDefend: f.cannotDefend });
  await _postResult(message, { verdict, defense, roll, defender });
}

/**
 * The result card: both totals, the breakdown, the verdict. Created by whoever rolled (or the GM who ruled);
 * the presenting client reacts to it (see registerMeleeContest) and runs the consequence.
 */
async function _postResult(contestMessage, { verdict, defense = null, roll = null, forced = false, auto = false, defender = null }) {
  const f = _flagOf(contestMessage);
  if (!f) return null;
  const def = defender ?? _resolveActor(f.defenderTokenId, f.defenderActorId);
  const names = { attacker: f.attackerName, target: def?.name ?? "", move: f.moveLabel, attack: f.attackTotal ?? "?" };
  let breakdown = "";
  if (defense) {
    breakdown = localizeParam("MeleeDefenseResultBreakdown", {
      ...names, skill: defense.skillLabel, ref: defense.ref, level: defense.level, die: defense.die, total: defense.total,
      keyClause: defense.key ? localizeParam("MeleeDefenseKeyClause", { key: defense.key }) : "",
      extraClause: defense.extra ? localizeParam("MeleeDefenseExtraClause", { extra: defense.extra }) : "",
    });
  }
  const clause = forced ? localize("MeleeDefenseForcedClause")
    : auto && f.cannotDefend ? localizeParam("MeleeDefenseAutoHitClause", names)
    : auto && f.fumble ? localize("MeleeDefenseFumbleClause") : "";
  const content = await renderChatCard("melee-defense-result.hbs", {
    title: localizeParam("MeleeDefenseResultTitle", names),
    breakdown,
    verdict: localizeParam(verdict === "hit" ? "MeleeDefenseVerdictHit" : "MeleeDefenseVerdictMiss", names) + clause,
    hit: verdict === "hit",
  });
  const result = {
    contestMessageId: contestMessage.id, verdict, forced, auto, defense, attackTotal: f.attackTotal,
    defenseTotal: defense?.total ?? null, skillLabel: defense?.skillLabel ?? "", presenterUserId: f.presenterUserId,
  };
  const message = await ChatMessage.create({
    content, speaker: ChatMessage.getSpeaker({ actor: def ?? undefined }),
    rolls: roll ? [roll] : [],
    flags: { [SCOPE]: { [RESULT_FLAG]: result } },
  });
  // One-shot persistence for the contest card's buttons (the card-lock render pass); the resolved stamp on
  // the flag itself is written by the presenting client, which authored the card and may update it.
  await markCardResolved(contestMessage.id, "meleeContest");
  return message;
}

/* ───────────────────────────── the consequence ───────────────────────────── */

/** What a HIT does — the road PATH A used to take, plus what the contest adds (manoeuvre, parry, throw). */
async function _runConsequence(result) {
  const contest = game.messages.get(result.contestMessageId);
  const f = _flagOf(contest);
  if (!f || f.consequenceDone) return;
  try { await contest.setFlag(SCOPE, CONTEST_FLAG, { ...f, resolved: true, consequenceDone: true }); } catch (_e) { /* not mine to update */ }
  if (result.verdict !== "hit") return;
  const defender = _resolveActor(f.defenderTokenId, f.defenderActorId);
  if (!defender) return;
  const attacker = f.attackerActorId ? game.actors.get(f.attackerActorId) : null;
  const payload = foundry.utils.deepClone(f.payload ?? {});

  // The status manoeuvres land on the win (hold / grapple / choke / throw / sweep); a disarm is the GM's hands.
  if (f.action && CONTESTED_MARTIAL_ACTIONS.has(f.action)) await applyOrRelayMartialEffect(f.action, defender, attacker);
  if (f.action === martialActions.disarm) {
    await postSavePromptCard({ body: localizeParam("MeleeDisarmNote", { attacker: f.attackerName, target: defender.name }), speaker: ChatMessage.getSpeaker({ actor: defender }) });
  }
  // p.111 Throw: "plus making a stun roll at -2" — the field the ammo path already honours.
  if (f.action === martialActions.throw) payload.stunSaveMod = -2;

  // A declared parry: the parrying object takes it first (p.112).
  const parry = defender.getFlag?.(SCOPE, "parrying");
  const red = parryRedirect(payload.areaDamages, parry && typeof parry === "object" ? parry : null);
  if (red.breakSave) { await _postBreakSave(defender, red.weaponName); return; }
  payload.areaDamages = red.areaDamages;
  if (!payload.areaDamages || !Object.keys(payload.areaDamages).length) return;
  await applyResolvedMeleeHit(payload, defender);
}

/** The blade's break save (p.112): 1D10, 9 or lower holds. The defender takes nothing either way. */
async function _postBreakSave(defender, weaponName) {
  const roll = await new Roll("1d10").evaluate();
  const broke = roll.total > PARRY_BREAK_SAVE_MAX;
  const names = { weapon: weaponName || localize("Weapon"), target: defender.name, roll: roll.total };
  const content = await renderChatCard("parry-break-save.hbs", {
    title: localizeParam("ParryBreakSaveTitle", names),
    body: localizeParam(broke ? "ParryBreakSaveBroke" : "ParryBreakSaveHold", names),
    broke,
  });
  await ChatMessage.create({
    content, speaker: ChatMessage.getSpeaker({ actor: defender }), rolls: [roll],
    flags: { [SCOPE]: { [BREAK_FLAG]: { weaponName, roll: roll.total, broke } } },
  });
}

/* ───────────────────────────── wiring ───────────────────────────── */

/** Card buttons (one delegated handler, the offer-card idiom) + the result-card reaction on the presenting client. */
export function registerMeleeContest() {
  onGlobalClick(async (ev) => {
    const btn = ev.target?.closest?.(".cp-melee-defense-choose, .cp-melee-defense-force");
    if (!btn) return;
    ev.preventDefault();
    const messageId = btn.closest?.("[data-message-id]")?.dataset?.messageId ?? "";
    const message = game.messages.get(messageId);
    const f = _flagOf(message);
    if (!f) return;
    if (btn.classList.contains("cp-melee-defense-choose")) { await openDefenseWindow(messageId); return; }
    // The forced verdicts are the GM's adjudication.
    if (!game.user.isGM) { ui.notifications?.warn(localize("MartialDefenseGmOnly")); return; }
    if (f.resolved) { ui.notifications?.warn(localize("MeleeDefenseAlreadyResolved")); return; }
    await _postResult(message, { verdict: btn.dataset.verdict === "hit" ? "hit" : "miss", forced: true });
  });

  Hooks.on("createChatMessage", async (message) => {
    const result = message?.getFlag?.(SCOPE, RESULT_FLAG);
    if (!result || !_presentsHere(result.presenterUserId)) return;
    try { await _runConsequence(result); } catch (err) {
      console.warn(`${SCOPE} | melee contest consequence failed`, err);
    }
  });
}
