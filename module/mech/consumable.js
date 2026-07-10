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
import { mechRoundTickEnabled } from "../settings.js";
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

/** Add/REPLACE the item's timer (one timer per item): re-use/re-activation restarts the clock —
 *  stacking a second marker would let the OLDER sibling's expiry switch the fresh dose off early. */
async function addMarker(actor, marker) {
  const raw = actor.getFlag?.(SCOPE, FLAG);
  const list = Array.isArray(raw) ? raw.slice() : (raw ? [raw] : []);
  const rest = list.filter(m => m.itemId !== marker.itemId);
  await actor.setFlag(SCOPE, FLAG, [...rest, marker]);
}

/** Drop an item's timer marker(s) + icon (manual switch-off, item deletion). Owner-side. */
async function clearMarkersFor(actor, itemId) {
  if (!actor) return;
  const raw = actor.getFlag?.(SCOPE, FLAG);
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const rest = list.filter(m => m.itemId !== itemId);
  if (rest.length !== list.length) {
    if (rest.length) await actor.setFlag(SCOPE, FLAG, rest);
    else await actor.unsetFlag(SCOPE, FLAG);
  }
  await pruneTimerIcons(actor, new Set(rest.map(m => m.itemId)));
}

/**
 * Display-only token icon for a running timer (§3c visibility): an ActiveEffect with NO changes —
 * mechanically inert on any system — whose icon rides the token while the timer runs. Created by
 * the initiating client (an owner); deleted when the marker expires. `duration.rounds` is set so
 * the effect registers as temporary (that's what token overlays render).
 */
async function addTimerIcon(actor, item, turns) {
  try {
    // One icon per item: a restart replaces the old icon rather than stacking a twin.
    const prior = (actor.effects?.contents ?? [])
      .filter(e => e.getFlag?.(SCOPE, "consumableItemId") === item.id)
      .map(e => e.id);
    if (prior.length) await actor.deleteEmbeddedDocuments("ActiveEffect", prior);
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: item.name, img: item.img,
      duration: { rounds: turns },
      changes: [], disabled: false, transfer: false,
      flags: { [SCOPE]: { consumableItemId: item.id } }
    }]);
  } catch (err) {
    console.warn(`${SCOPE} | timer icon create failed:`, err);
  }
}

/** Remove the timer icons whose markers are gone (expiry + stray reconciliation). GM-side. */
async function pruneTimerIcons(actor, survivingItemIds) {
  try {
    const stale = (actor.effects?.contents ?? []).filter(e => {
      const tag = e.getFlag?.(SCOPE, "consumableItemId");
      return tag && !survivingItemIds.has(tag);
    });
    if (stale.length) await actor.deleteEmbeddedDocuments("ActiveEffect", stale.map(e => e.id));
  } catch (err) {
    console.warn(`${SCOPE} | timer icon prune failed:`, err);
  }
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
    await addTimerIcon(item.actor, item, turns);
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

  // Activating a consumable-tagged Activatable cyberware spends a dose + starts its timer;
  // switching it OFF (manually or via the tick's own off-flip) ends the timer with the payload,
  // so a re-activation starts fresh instead of inheriting a stale countdown.
  // Initiating client only (it holds owner rights); the dose decrement's own update carries no
  // EffectActive key, so this never re-enters.
  Hooks.on("updateItem", async (item, changes, options, userId) => {
    if (userId !== game.user.id) return;
    if (item.type !== "cyberware") return;
    const mc = consumableOf(item);
    if (!mc) return;
    if (foundry.utils.getProperty(changes ?? {}, "system.EffectActive") === false) {
      // A tick-expiry flip already owns the marker + icon cleanup (below); re-clearing here would
      // race it into a double ActiveEffect delete ("does not exist"). Only a MANUAL switch-off cleans.
      if (options?.cp2020TimerExpiry) return;
      await clearMarkersFor(item.actor, item.id);
      return;
    }
    if (!activationInChanges(changes)) return;
    const dosesAfter = Math.max(0, dosesLeft(item) - 1);
    await item.update({ "system.mechConsumable.doses": dosesAfter });
    const turns = await rollDurationTurns(mc.durationTurns);
    if (turns > 0 && item.actor) {
      await addMarker(item.actor, { itemId: item.id, name: item.name, note: mc.note ?? "", turnsLeft: turns });
      await addTimerIcon(item.actor, item, turns);
    }
    await postUseCard(item, { turns, dosesAfter });
  });

  // A consumable item deleted while its timer runs would orphan the marker + icon (out of combat
  // nothing ever ticks them out) — clear them with the item, like the sibling engines do.
  Hooks.on("deleteItem", async (item, options, userId) => {
    if (userId !== game.user?.id) return;
    if (!item.actor?.isOwner) return;
    if (!consumableOf(item)) return;
    await clearMarkersFor(item.actor, item.id ?? item._id);
  });

  // Round tick — the ACTIVE GM processes the CURRENT combatant's timers when their turn comes up
  // (mirrors the acid/fire per-turn block in combat/damage-hooks.js, including the multi-GM guard).
  // Gated by the round-tick toggle: off = timers wait; Use/activation and the cards still work.
  Hooks.on("updateCombat", async (combat, updateData) => {
    if (!mechRoundTickEnabled()) return;
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;
    if (updateData.turn === undefined && updateData.round === undefined) return;
    // Starting combat is not a turn elapsing (matches the damage-hooks per-turn blocks): an
    // effect running when the GM clicks Begin Combat keeps its full remaining duration.
    const prevRound = combat.previous?.round;
    if (prevRound !== undefined && prevRound < 1) return;

    const actor = combat.combatant?.actor;
    if (!actor) return;
    const raw = actor.getFlag?.(SCOPE, FLAG);
    const markers = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    if (!markers.length) return;

    const { surviving, expired } = tickMarkers(markers);
    for (const m of expired) {
      // A cyberware timer switches the item back off — the base engine drops its payload with it.
      // Tag the update so the EffectActive-off hook doesn't ALSO clear (the tick prunes below); the
      // hook only cleans a manual switch-off, so the icon isn't deleted twice.
      const item = actor.items.get(m.itemId);
      if (item?.type === "cyberware" && item.system?.EffectActive) {
        await item.update({ "system.EffectActive": false }, { cp2020TimerExpiry: true }).catch(() => {});
      }
      const noteClause = m.note ? localizeParam("ConsumableNoteClause", { note: m.note }) : "";
      await postSavePromptCard({
        body: localizeParam("ConsumableExpiredBody", { name: m.name, actor: actor.name, noteClause }),
        speaker: ChatMessage.getSpeaker({ actor })
      });
    }
    if (surviving.length) await actor.setFlag(SCOPE, FLAG, surviving);
    else await actor.unsetFlag(SCOPE, FLAG);
    // Drop the expired timers' token icons (and any stray icon whose marker is gone).
    await pruneTimerIcons(actor, new Set(surviving.map(m => m.itemId)));
  });
}
