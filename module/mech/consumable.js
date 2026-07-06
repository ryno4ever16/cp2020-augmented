/**
 * P7 — Timed consumables (SPECIAL-MECHANICS-PROPOSAL.md; dose-priced drugs/patches, the Adrenal
 * Booster's "3x per day, 1d6+2 turns" class).
 *
 * Split of responsibilities: P7 owns TIME + USES only. The effect math stays where it already
 * lives — an Activatable cyberware's payload (the base engine applies it while EffectActive) or
 * the GM's adjudication for prose effects. So:
 *   - "Use" (misc items; sheet button) — spends one dose, posts a card, and if the item carries a
 *     duration, starts a per-actor timer.
 *   - Activating a consumable-tagged Activatable cyberware spends one dose and starts the timer;
 *     the timer's expiry flips EffectActive back off (which switches the base payload off) and
 *     posts a wear-off card. Activation with an empty counter is blocked.
 *   - The round tick mirrors the acid/fire pattern in combat/damage-hooks.js: the ACTIVE GM
 *     processes the CURRENT combatant's timers when their turn comes up (per-owner turns, the
 *     same reading the other per-turn effects use). Out of combat, timers simply wait — the card
 *     states the rolled duration and the GM adjudicates.
 *
 * Timer storage: actor flag `cp2020-augmented.consumableState` = [{ itemId, name, note, turnsLeft }].
 * Pure helpers are exported for the rig spec; hooks are wired by registerMechConsumable().
 */

import { localizeParam } from "../utils.js";
import { postSavePromptCard } from "../compat.js";

const SCOPE = "cp2020-augmented";
const FLAG = "consumableState";

/** The item's consumable block when enabled, else null. Pure. */
export function consumableOf(item) {
  const mc = item?.system?.mechConsumable;
  if (!mc?.enabled) return null;
  return mc;
}

/** Doses remaining (0 floor). Pure. */
export function dosesLeft(item) {
  return Math.max(0, Number(consumableOf(item)?.doses) || 0);
}

/** One tick over a marker array: { surviving, expired }. Pure. */
export function tickMarkers(markers) {
  const surviving = [];
  const expired = [];
  for (const m of markers ?? []) {
    const left = (Number(m?.turnsLeft) || 0) - 1;
    if (left <= 0) expired.push(m);
    else surviving.push({ ...m, turnsLeft: left });
  }
  return { surviving, expired };
}

/** Roll the duration spec ("", number, or dice formula) → integer turns (0 = untimed). Impure (dice). */
export async function rollDurationTurns(spec) {
  const s = String(spec ?? "").trim();
  if (!s) return 0;
  try {
    const roll = await new Roll(s).evaluate();
    return Math.max(0, Math.floor(roll.total));
  } catch (e) {
    console.warn(`${SCOPE} | consumable duration "${s}" is not rollable`, e);
    return 0;
  }
}

/** Append a timer to the actor's marker flag. */
async function addMarker(actor, marker) {
  const raw = actor.getFlag?.(SCOPE, FLAG);
  const list = Array.isArray(raw) ? raw.slice() : (raw ? [raw] : []);
  list.push(marker);
  await actor.setFlag(SCOPE, FLAG, list);
}

/** The used/activated chat card (JS-assembled clauses, GasCloudTurnBody pattern). */
async function postUseCard(item, { turns, dosesAfter }) {
  const mc = consumableOf(item) ?? {};
  const noteClause = mc.note ? localizeParam("ConsumableNoteClause", { note: mc.note }) : "";
  const durationClause = turns > 0 ? localizeParam("ConsumableDurationClause", { turns }) : "";
  await postSavePromptCard({
    body: localizeParam("ConsumableUsedBody", {
      name: item.name, noteClause, durationClause, doses: dosesAfter
    }),
    speaker: item.actor ? ChatMessage.getSpeaker({ actor: item.actor }) : undefined
  });
}

/**
 * Spend one dose of a consumable-tagged item (the sheet's Use button; misc or manual cyberware
 * use). Warns and no-ops when the block is off or the counter is empty. Starts the timer when the
 * item carries a duration and is owned by an actor.
 */
export async function useConsumable(item) {
  const mc = consumableOf(item);
  if (!mc) return false;
  const left = dosesLeft(item);
  if (left <= 0) {
    ui.notifications?.warn(localizeParam("ConsumableEmpty", { name: item.name }));
    return false;
  }
  const dosesAfter = left - 1;
  await item.update({ "system.mechConsumable.doses": dosesAfter });
  const turns = await rollDurationTurns(mc.durationTurns);
  if (turns > 0 && item.actor) {
    await addMarker(item.actor, { itemId: item.id, name: item.name, note: mc.note ?? "", turnsLeft: turns });
  }
  await postUseCard(item, { turns, dosesAfter });
  return true;
}

/** True when this update flips EffectActive on (diffed updates only carry changed keys). */
function activationInChanges(changes) {
  return foundry.utils.getProperty(changes ?? {}, "system.EffectActive") === true;
}

export function registerMechConsumable() {
  // Block switching an EMPTY consumable on (runs on the initiating client, before the write).
  Hooks.on("preUpdateItem", (item, changes) => {
    if (!activationInChanges(changes)) return;
    if (item.type !== "cyberware" || !consumableOf(item)) return;
    if (dosesLeft(item) > 0) return;
    ui.notifications?.warn(localizeParam("ConsumableEmpty", { name: item.name }));
    return false;
  });

  // Activating a consumable-tagged Activatable cyberware spends a dose + starts its timer.
  // Initiating client only (it holds owner rights); the dose decrement's own update carries no
  // EffectActive key, so this never re-enters.
  Hooks.on("updateItem", async (item, changes, options, userId) => {
    if (userId !== game.user.id) return;
    if (!activationInChanges(changes)) return;
    if (item.type !== "cyberware") return;
    const mc = consumableOf(item);
    if (!mc) return;
    const dosesAfter = Math.max(0, dosesLeft(item) - 1);
    await item.update({ "system.mechConsumable.doses": dosesAfter });
    const turns = await rollDurationTurns(mc.durationTurns);
    if (turns > 0 && item.actor) {
      await addMarker(item.actor, { itemId: item.id, name: item.name, note: mc.note ?? "", turnsLeft: turns });
    }
    await postUseCard(item, { turns, dosesAfter });
  });

  // Round tick — the ACTIVE GM processes the CURRENT combatant's timers when their turn comes up
  // (mirrors the acid/fire per-turn block in combat/damage-hooks.js, including the multi-GM guard).
  Hooks.on("updateCombat", async (combat, updateData) => {
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;
    if (updateData.turn === undefined && updateData.round === undefined) return;

    const actor = combat.combatant?.actor;
    if (!actor) return;
    const raw = actor.getFlag?.(SCOPE, FLAG);
    const markers = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    if (!markers.length) return;

    const { surviving, expired } = tickMarkers(markers);
    for (const m of expired) {
      // A cyberware timer switches the item back off — the base engine drops its payload with it.
      const item = actor.items.get(m.itemId);
      if (item?.type === "cyberware" && item.system?.EffectActive) {
        await item.update({ "system.EffectActive": false }).catch(() => {});
      }
      const noteClause = m.note ? localizeParam("ConsumableNoteClause", { note: m.note }) : "";
      await postSavePromptCard({
        body: localizeParam("ConsumableExpiredBody", { name: m.name, actor: actor.name, noteClause }),
        speaker: ChatMessage.getSpeaker({ actor })
      });
    }
    if (surviving.length) await actor.setFlag(SCOPE, FLAG, surviving);
    else await actor.unsetFlag(SCOPE, FLAG);
  });
}
