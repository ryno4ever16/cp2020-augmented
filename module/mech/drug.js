/**
 * D4 — Combat-drug engine (SPECIAL-MECHANICS-D4-PROPOSAL.md §T2a). A dose-taken item grants a
 * timed boost that later wears off with a save, and (if addictive) bumps a per-actor counter shown
 * in the status strip.
 *
 * Built by composing three patterns we already ship, plus one new gate:
 *   - TIMER lifecycle — mirrors mech/consumable.js: a per-actor marker flag (`drugState`) + the
 *     active-GM round tick counts down any drug that sets an in-combat duration. rollDurationTurns
 *     is reused verbatim from consumable.js (one duration parser, not two).
 *   - STAT overlay — mirrors mech/stat-mods.js: a prepareData wrapper applies the active markers'
 *     statBoosts on top of the base totals (WRAP prepareData, not prepareDerivedData — the base
 *     computes stats in prepareData; see feedback-datamodel-partial-updates §4).
 *   - WEAR-OFF SAVE (new) — on expiry the drug posts the module's standard save-prompt NOTICE naming
 *     the save characteristic + difficulty + the printed failure penalty; the GM/owner rolls and
 *     adjudicates the penalty (the same UX as every gas/toxin save in damage-hooks.js). D-drug-2.
 *   - ADDICTION COUNTER (new) — each dose of an addictive drug bumps `addictionState` {byDrug,total};
 *     mech/status.js surfaces it as a status-strip row (the user's ask). Withdrawal stays GM-run. D-drug-3.
 *
 * A drug is "active" while its marker is present (you TOOK it) — independent of equip/activation,
 * unlike the passive mech engines. Printed drugs use book-unit durations that outlast a fight, so
 * they carry no `durationTurns` and wear off when the GM ends them (the item-sheet "Wear off"
 * control); the round tick handles any drug that DOES set a turn count (future short drugs + the
 * rig keeper). Pure helpers are exported for the keeper; the wrapper + hooks are wired by
 * registerMechDrug().
 */

import { localize, localizeParam } from "../utils.js";
import { postSavePromptCard, renderChatCard } from "../compat.js";
import { onGlobalClick } from "../popout-compat.js";
import { rollDurationTurns } from "./consumable.js";
import { btmFromBT } from "../lookups.js";

const SCOPE = "cp2020-augmented";
const DRUG_FLAG = "drugState";
const ADDICTION_FLAG = "addictionState";

/** The item's drug block when enabled, else null. Pure. */
export function drugOf(item) {
  const md = item?.system?.mechDrug;
  if (!md?.enabled) return null;
  return md;
}

/** Active drug markers on the actor (the drugState flag → array). Pure. */
export function drugMarkersFor(actor) {
  const raw = actor?.getFlag?.(SCOPE, DRUG_FLAG) ?? actor?.flags?.[SCOPE]?.[DRUG_FLAG];
  return Array.isArray(raw) ? raw : (raw ? [raw] : []);
}

/** The per-actor addiction tally { byDrug:{name:count}, total }. Pure. */
export function addictionStateFor(actor) {
  const raw = actor?.getFlag?.(SCOPE, ADDICTION_FLAG) ?? actor?.flags?.[SCOPE]?.[ADDICTION_FLAG];
  const byDrug = raw && typeof raw.byDrug === "object" ? raw.byDrug : {};
  const total = Number(raw?.total) || Object.values(byDrug).reduce((s, n) => s + (Number(n) || 0), 0);
  return { byDrug, total };
}

/** Build a marker from a drug block (snapshots the payload so later item edits don't rewrite history). Pure. */
export function drugMarker(item, drug, turns) {
  return {
    itemId: item.id ?? item._id,
    name: item.name,
    note: drug.note ?? "",
    statBoosts: (drug.statBoosts ?? []).map(b => ({ stat: String(b.stat ?? "").toLowerCase(), mod: Number(b.mod) || 0 })),
    rollBoosts: (drug.rollBoosts ?? []).map(b => ({ label: String(b.label ?? ""), mod: Number(b.mod) || 0 })),
    expireSave: {
      stat: String(drug.expireSave?.stat ?? ""),
      difficulty: Number(drug.expireSave?.difficulty) || 0,
      penalty: String(drug.expireSave?.penalty ?? "")
    },
    psychosis: String(drug.psychosis ?? ""),
    turnsLeft: Number(turns) || 0
  };
}

/** One tick over drug markers: { surviving, expired }. Untimed markers (turnsLeft ≤ 0) never expire. Pure. */
export function tickDrugMarkers(markers) {
  const surviving = [];
  const expired = [];
  for (const m of markers ?? []) {
    const t = Number(m?.turnsLeft) || 0;
    if (t <= 0) { surviving.push(m); continue; }   // untimed: lasts until worn off manually
    const left = t - 1;
    if (left <= 0) expired.push(m);
    else surviving.push({ ...m, turnsLeft: left });
  }
  return { surviving, expired };
}

/** Human summary of a marker's boosts ("COOL +3, EMP −3, Awareness +3"), or "". Pure. */
export function boostSummary(marker) {
  const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;
  const parts = [];
  for (const b of marker?.statBoosts ?? []) if (b.mod) parts.push(`${String(b.stat).toUpperCase()} ${signed(b.mod)}`);
  for (const b of marker?.rollBoosts ?? []) if (b.mod) parts.push(`${b.label} ${signed(b.mod)}`);
  return parts.join(", ");
}

/** Replace any existing marker for this item, then store. */
async function setDrugMarker(actor, marker) {
  const rest = drugMarkersFor(actor).filter(m => m.itemId !== marker.itemId);
  await actor.setFlag(SCOPE, DRUG_FLAG, [...rest, marker]);
}

/** Increment the addiction counter for a drug by name. */
async function bumpAddiction(actor, name) {
  const { byDrug } = addictionStateFor(actor);
  const next = { ...byDrug, [name]: (Number(byDrug[name]) || 0) + 1 };
  const total = Object.values(next).reduce((s, n) => s + (Number(n) || 0), 0);
  await actor.setFlag(SCOPE, ADDICTION_FLAG, { byDrug: next, total });
}

/** GM/owner action: clear the whole addiction tally (a character kicks the habit). */
export async function clearAddiction(actor) {
  await actor.unsetFlag(SCOPE, ADDICTION_FLAG);
}

/**
 * The prepareData post-step: apply active drug statBoosts on top of the actor's already-computed
 * stat totals, record the contributions (for the strip tooltips), and re-derive movement/body if a
 * boost touches MA/BT. A plain temp overlay added last — NOT subject to Q7 caps (a transient drug
 * bonus, the RAW "temporary" reading). Mutates prepared data only; never persists.
 */
export function applyMechDrugBoosts(actor) {
  if (!actor || (actor.type !== "character" && actor.type !== "npc")) return;
  const stats = actor.system?.stats;
  if (!stats) { actor._mechDrugMods = null; return; }
  const markers = drugMarkersFor(actor);
  if (!markers.length) { actor._mechDrugMods = null; return; }

  const contrib = {};   // stat → [{ name, value }]
  let touchedMA = false, touchedBT = false;
  for (const m of markers) {
    for (const b of m.statBoosts ?? []) {
      const key = String(b.stat ?? "").toLowerCase();
      const stat = stats[key];
      const mod = Number(b.mod) || 0;
      if (!stat || !mod) continue;
      stat.total = (Number(stat.total) || 0) + mod;
      (contrib[key] ??= []).push({ name: m.name, value: mod });
      if (key === "ma") touchedMA = true;
      if (key === "bt") touchedBT = true;
    }
  }

  if (touchedMA && stats.ma) {
    stats.ma.run = stats.ma.total * 3;
    stats.ma.leap = Math.floor(stats.ma.run / 4);
  }
  if (touchedBT && stats.bt) {
    stats.bt.carry = stats.bt.total * 10;
    stats.bt.lift = stats.bt.total * 40;
    stats.bt.modifier = btmFromBT(stats.bt.total);
  }

  actor._mechDrugMods = Object.keys(contrib).length ? contrib : null;
}

/** The "took" chat card (JS-assembled clauses, the ConsumableUsedBody pattern). */
async function postTookCard(item, drug, marker) {
  const boosts = boostSummary(marker);
  const boostClause = boosts ? localizeParam("DrugBoostClause", { boosts }) : "";
  const durationClause = drug.duration ? localizeParam("DrugDurationClause", { duration: drug.duration }) : "";
  const addictionClause = Number(drug.addictionDifficulty) > 0
    ? localizeParam("DrugAddictionClause", { difficulty: Number(drug.addictionDifficulty) }) : "";
  const psychosisClause = drug.psychosis ? localizeParam("DrugPsychosisClause", { note: drug.psychosis }) : "";
  await postSavePromptCard({
    body: localizeParam("DrugTookBody", {
      name: item.name, boostClause, durationClause, addictionClause, psychosisClause
    }),
    speaker: item.actor ? ChatMessage.getSpeaker({ actor: item.actor }) : undefined
  });
}

/**
 * The wear-off card. When the drug carries a rollable stat check (expireSave.stat + difficulty), an
 * INTERACTIVE save card with a Roll button (executeDrugExpireSave applies the crash on a failure);
 * otherwise the standard save-prompt NOTICE stating the printed consequence. A crash marker's own
 * expiry posts a plain "crash passes" recovery note (no re-save).
 */
async function postWoreOffCard(actor, marker) {
  if (marker.isPenalty) {
    await postSavePromptCard({
      body: localizeParam("DrugCrashEndedBody", { name: marker.name, actor: actor.name }),
      speaker: ChatMessage.getSpeaker({ actor })
    });
    return;
  }
  const es = marker.expireSave ?? {};
  if (es.stat && es.difficulty && marker.itemId) {
    const content = await renderChatCard("drug-save-prompt.hbs", {
      name: marker.name, actorName: actor.name,
      stat: String(es.stat).toUpperCase(), difficulty: es.difficulty, penalty: es.penalty ?? "",
      actorId: actor.id, itemId: marker.itemId
    });
    await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
    return;
  }
  const saveClause = es.penalty ? localizeParam("DrugSaveClauseNoTN", { penalty: es.penalty }) : "";
  await postSavePromptCard({
    body: localizeParam("DrugWoreOffBody", { name: marker.name, actor: actor.name, saveClause }),
    speaker: ChatMessage.getSpeaker({ actor })
  });
}

/**
 * Resolve a drug's wear-off save (the card's Roll button). A CP2020 stat check — 1d10 + the save
 * stat vs the printed difficulty; meet-or-beat resists. On a failure the stat portion of the penalty
 * is applied as a timed "crash" overlay (reusing the boost machinery, negated) and the result card
 * shows the full printed consequence for the GM. Owner/GM only (mirrors the stun/death save gate).
 */
export async function executeDrugExpireSave({ actorId, itemId }) {
  const actor = game.actors.get(actorId);
  if (!actor) return;
  if (!(game.user.isGM || actor.isOwner)) {
    ui.notifications?.warn(localizeParam("SaveNotOwned", { name: actor.name }));
    return;
  }
  const item = actor.items?.get?.(itemId);
  const es = item?.system?.mechDrug?.expireSave ?? {};
  const statKey = String(es.stat ?? "").toLowerCase();
  const difficulty = Number(es.difficulty) || 0;
  if (!statKey || !difficulty) return;

  const statVal = Number(actor.system?.stats?.[statKey]?.total) || 0;
  const roll = await new Roll("1d10").evaluate();
  const total = roll.total + statVal;
  const success = total >= difficulty;

  const content = await renderChatCard("drug-save-result.hbs", {
    name: item?.name ?? "", actorName: actor.name,
    stat: statKey.toUpperCase(), statVal, die: roll.total, total, difficulty, success,
    penalty: es.penalty ?? ""
  });
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: localizeParam("DrugSaveFlavor", { name: item?.name ?? "", stat: statKey.toUpperCase(), difficulty }),
    content
  });

  if (success) return;
  const penaltyBoosts = (es.penaltyBoosts ?? []).map(b => ({ stat: String(b.stat ?? "").toLowerCase(), mod: Number(b.mod) || 0 })).filter(b => b.mod);
  if (!penaltyBoosts.length) return;   // penalty is prose-only → the card states it, the GM applies it
  const turns = await rollDurationTurns(es.penaltyTurns);
  await setDrugMarker(actor, {
    itemId, name: item?.name ?? "", note: "", statBoosts: penaltyBoosts, rollBoosts: [],
    expireSave: { stat: "", difficulty: 0, penalty: "" }, psychosis: "", turnsLeft: turns, isPenalty: true
  });
}

/** Drop a marker, post the wear-off card, and re-prepare so the boost lifts. GM/owner-side. */
async function wearOffMarker(actor, marker) {
  const rest = drugMarkersFor(actor).filter(m => m.itemId !== marker.itemId);
  if (rest.length) await actor.setFlag(SCOPE, DRUG_FLAG, rest);
  else await actor.unsetFlag(SCOPE, DRUG_FLAG);
  await postWoreOffCard(actor, marker);
}

/**
 * Take a dose (the item-sheet "Take" button). Adds/refreshes the drug marker, bumps the addiction
 * counter when the drug is addictive, and posts the "took" card. The boost applies on the next
 * prepareData (setFlag re-prepares the actor). Warns and no-ops without an owning actor.
 */
export async function takeDrug(item) {
  const drug = drugOf(item);
  if (!drug) return false;
  const actor = item.actor;
  if (!actor) {
    ui.notifications?.warn(localizeParam("DrugNoActor", { name: item.name }));
    return false;
  }
  const turns = await rollDurationTurns(drug.durationTurns);
  const marker = drugMarker(item, drug, turns);
  await setDrugMarker(actor, marker);
  if (Number(drug.addictionDifficulty) > 0) await bumpAddiction(actor, item.name);
  await postTookCard(item, drug, marker);
  return true;
}

/** Manually wear a drug off now (the item-sheet "Wear off" button). No-op when it isn't active. */
export async function endDrug(item) {
  const actor = item.actor;
  if (!actor) return false;
  const marker = drugMarkersFor(actor).find(m => m.itemId === (item.id ?? item._id));
  if (!marker) return false;
  await wearOffMarker(actor, marker);
  return true;
}

let _wrapped = false;
export function registerMechDrug() {
  // Wrap prepareData once so active drug boosts apply after the base's stat pass (and after the Q7
  // moddy wrap, which registers first at init) — the same reason stat-mods.js wraps prepareData.
  const proto = CONFIG?.Actor?.documentClass?.prototype;
  if (proto && !_wrapped) {
    const orig = proto.prepareData;
    proto.prepareData = function () {
      orig.call(this);
      try { applyMechDrugBoosts(this); } catch (e) { console.warn(`${SCOPE} | mech drug boosts failed`, e); }
    };
    _wrapped = true;
  }

  // The wear-off card's Roll button (mirrors the stun/death save button wiring in save-rolls.js).
  onGlobalClick(async (ev) => {
    const btn = ev.target?.closest?.(".cp-drug-save-roll");
    if (!btn || btn.disabled) return;
    ev.preventDefault();
    await executeDrugExpireSave({ actorId: btn.dataset.actorId, itemId: btn.dataset.itemId });
  });

  // Round tick — the ACTIVE GM counts down the CURRENT combatant's timed drugs when their turn comes
  // up (the acid/fire/consumable per-turn pattern, including the multi-GM + begin-combat guards).
  Hooks.on("updateCombat", async (combat, updateData) => {
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;
    if (updateData.turn === undefined && updateData.round === undefined) return;
    const prevRound = combat.previous?.round;
    if (prevRound !== undefined && prevRound < 1) return;   // Begin Combat is not a turn elapsing

    const actor = combat.combatant?.actor;
    if (!actor) return;
    const markers = drugMarkersFor(actor);
    if (!markers.length) return;

    const { surviving, expired } = tickDrugMarkers(markers);
    if (!expired.length) return;   // nothing timed out this tick
    if (surviving.length) await actor.setFlag(SCOPE, DRUG_FLAG, surviving);
    else await actor.unsetFlag(SCOPE, DRUG_FLAG);
    for (const m of expired) await postWoreOffCard(actor, m);
  });
}
