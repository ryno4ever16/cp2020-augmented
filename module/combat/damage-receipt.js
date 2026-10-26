/**
 * damage-receipt.js  —  module/combat/damage-receipt.js
 *
 * THE APPLY'S THREE READERS (user ruling 2026-10-22, from the table: "only players receive the apply-damage
 * popup… I want the GM to be able to see it too… the players will click through the window and I can't see
 * what the damage breakdown was… go back into the same window… maybe an undo feature as well"):
 *
 *   1. THE SEAT. The apply window opens on the client that CONTROLS THE TARGET — a player-owned figure's
 *      player when one is connected, else the primary GM session — for a ranged shot and a melee verdict
 *      alike. It used to open on the client that fired, so a player's hit on the referee's NPC was decided on
 *      the player's screen and the referee saw a notice. The firing client still presents the shot; when the
 *      seat is elsewhere it hands the window over the socket (`openDamageWindow`) and says so.
 *   2. THE RECEIPT. Every apply posts a card of its own — the rows as applied (raw − SP = after-SP → net, per
 *      location), the total, the wound state before and after, who applied it — with a View control that
 *      reopens the apply window read-only on exactly those numbers. Its own message, created by the client
 *      that wrote the target (the GM for a relayed apply): nothing has to write a flag onto somebody else's
 *      card, and a player's apply to their own figure needs no relay at all.
 *   3. UNDO (GM). The receipt carries a snapshot of the target taken before the rows were written — the wound
 *      track, the module's own flags, every armour and cyberware item's data, the statuses — and Undo puts
 *      them back and stamps the receipt. The prompts and progression cards the apply posted stay in the log;
 *      the receipt says the apply was undone.
 *
 * Wired under `doCombat` beside the card lock (cp2020-augmented.js). The window class is imported lazily:
 * DamageDialog.js imports this file for the snapshot and the receipt, and a static import back would be a
 * cycle at module evaluation.
 */
import { localize, localizeParam, resolveActorRef } from "../utils.js";
import { renderChatCard, getHtmlElement } from "../compat.js";
import { onGlobalClick } from "../popout-compat.js";
import { onChatCardRender } from "../chat-render-compat.js";
import { isPrimaryGMSession } from "../gm-session-primary.js";
import { woundStateLabel } from "./save-rolls.js";

const SCOPE = "cp2020-augmented";
const SOCKET = `module.${SCOPE}`;
export const RECEIPT_FLAG = "damageReceipt";
const OPEN_WINDOW_TYPE = "openDamageWindow";

/* ───────────────────────────── the seat ───────────────────────────── */

/** The user who controls a figure for the apply: the first CONNECTED player with owner rights on it. Null when
 *  no player holds it (an NPC, or a player-owned figure whose player is offline) — the referee's seat. */
export function damageSeatUserId(target) {
  if (!target) return null;
  const owner = (game.users?.players ?? []).find(u => u.active && target.testUserPermission?.(u, "OWNER"));
  return owner?.id ?? null;
}

/** The unambiguous reference a relay carries for a figure: an unlinked token's synthetic actor shares its id
 *  with the world actor, so the token and its scene travel beside the id and the uuid (resolveActorRef). */
export function actorRefOf(target, payload = null) {
  const tokenId = target?.token?.id ?? payload?.targetTokenId ?? null;
  const sceneId = target?.token?.parent?.id ?? (tokenId ? (canvas?.scene?.id ?? null) : null);
  return { actorId: target?.id ?? null, actorUuid: target?.uuid ?? null, tokenId, sceneId };
}

/**
 * Open the apply window where it belongs. Local when this client holds the seat; otherwise handed over the
 * socket to the seat's client (a named player, or the primary GM session). With no GM connected and no
 * player seat, the window opens here, exactly as it always did — a shot is never left with no window.
 *
 * ⚠ A FIGURE WITH NO PLAYER SEAT IS THE REFEREE'S, AND THE REFEREE WHO FIRED IS THE REFEREE. This used to
 * ask whether this GM session was the PRIMARY one, so a GM presenting a shot from a second session (a
 * second tab, a co-referee) had the window taken off their screen and opened on the other GM's — the very
 * regression the "client that pulled the trigger presents its own shot" rule in damage-hooks had closed
 * (1.2.12 gate, fx-rail's two-GM legs). Any GM session that is presenting the shot keeps the window; the
 * primary-session election only decides WHICH GM session answers a hand-over from a player, and that is
 * the socket handler's question (registerDamageReceipt), not this one.
 * @returns {"local"|"player"|"gm"} where it went
 */
export async function openDamageWindowAtSeat(payload, target, { cardMessageId = null } = {}) {
  const { DamageDialog } = await import("./DamageDialog.js");
  const seat = damageSeatUserId(target);
  const mine = seat ? seat === game.user?.id : !!game.user?.isGM;
  if (mine || (!seat && !game.users?.activeGM)) {
    new DamageDialog(payload, target, { cardMessageId }).render(true);
    return "local";
  }
  game.socket.emit(SOCKET, { type: OPEN_WINDOW_TYPE, forUserId: seat, cardMessageId, payload, targetRef: actorRefOf(target, payload) });
  const seatUser = seat ? game.users.get(seat) : null;
  ui.notifications?.info(seat
    ? localizeParam("DamageSeatHandedToPlayer", { target: target.name, user: seatUser?.name ?? "" })
    : localizeParam("DamageSeatHandedToGm", { target: target.name }));
  return seat ? "player" : "gm";
}

/* ───────────────────────────── the snapshot ───────────────────────────── */

/** What an apply can change on a figure, as it stood before the rows were written: the wound track, the
 *  module's own flags (wound marks, limb states, burn and shock ladders), every armour and cyberware item's
 *  data (SP wear, a cyberlimb's SDP), the statuses. Source data, so it writes back as it was. */
export function snapshotTarget(target) {
  const items = [];
  for (const it of target?.items ?? []) {
    if (it.type !== "armor" && it.type !== "cyberware") continue;
    items.push({ _id: it.id, system: foundry.utils.deepClone(it.toObject().system ?? {}) });
  }
  return {
    damage: Number(target?.system?.damage) || 0,
    flags: foundry.utils.deepClone(target?.flags?.[SCOPE] ?? {}),
    statuses: [...(target?.statuses ?? [])],
    items,
  };
}

/* ───────────────────────────── the receipt ───────────────────────────── */

function _rowLine(r) {
  const math = `${r.raw} − ${r.sp} = ${r.afterSP}`;
  const net = r.penetrates ? `→ ${r.net}` + (r.sdp ? ` ${localize("DamageReceiptSdp")}` : "") : localize("DamageReceiptStopped");
  return { location: r.location, math, net, overridden: !!r.overridden };
}

async function _renderReceipt(r) {
  const total = Number(r.totalApplied) || 0;
  return renderChatCard("damage-receipt.hbs", {
    title: total > 0 ? localizeParam("DamageReceiptTitle", { total, target: r.targetName ?? "" }) : localizeParam("DamageReceiptTitleNone", { target: r.targetName ?? "" }),
    rows: (r.rows ?? []).map(_rowLine),
    woundLine: localizeParam("DamageReceiptWound", { before: woundStateLabel(Number(r.woundBefore) || 0), after: woundStateLabel(Number(r.woundAfter) || 0) }),
    byLine: localizeParam("DamageReceiptBy", { user: r.appliedByName ?? "", weapon: r.weaponName ?? "" }),
    undone: !!r.undone,
    undoneLine: r.undone ? localizeParam("DamageReceiptUndoneLine", { user: r.undone.byName ?? "" }) : "",
  });
}

/** Post the receipt card for one apply. Called by the client that wrote the target. */
export async function postDamageReceipt(receipt) {
  const content = await _renderReceipt(receipt);
  const target = resolveActorRef(receipt.targetRef ?? {});
  return ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker(target ? { actor: target } : {}),
    flags: { [SCOPE]: { [RECEIPT_FLAG]: receipt } },
  });
}

/**
 * Put the figure back as the snapshot has it and stamp the receipt. The referee's hands only. The module's
 * flag scope is cleared and rewritten in two steps so a key the apply ADDED (a burn ladder, a limb mark) goes
 * away rather than merging into the restored object.
 */
export async function undoReceipt(message) {
  const r = message?.getFlag?.(SCOPE, RECEIPT_FLAG);
  if (!r || r.undone) return false;
  if (!game.user?.isGM) { ui.notifications?.warn(localize("DamageReceiptUndoGmOnly")); return false; }
  const target = resolveActorRef(r.targetRef ?? {});
  if (!target) { ui.notifications?.warn(localize("DamageReceiptUndoNoTarget")); return false; }
  const snap = r.snapshot ?? {};
  const opts = { render: false, fromCyberpunkDamageSystem: true };
  const clear = {};
  for (const k of Object.keys(target.flags?.[SCOPE] ?? {})) clear[`flags.${SCOPE}.-=${k}`] = null;
  if (Object.keys(clear).length) await target.update(clear, opts);
  const restore = { "system.damage": Number(snap.damage) || 0 };
  for (const [k, v] of Object.entries(snap.flags ?? {})) restore[`flags.${SCOPE}.${k}`] = v;
  await target.update(restore, opts);
  const itemUpdates = (snap.items ?? []).filter(i => target.items?.has?.(i._id)).map(i => ({ _id: i._id, system: i.system }));
  if (itemUpdates.length) await target.updateEmbeddedDocuments("Item", itemUpdates, opts);
  const want = new Set(snap.statuses ?? []);
  const have = new Set(target.statuses ?? []);
  for (const s of have) if (!want.has(s)) await target.toggleStatusEffect(s, { active: false }).catch(() => {});
  for (const s of want) if (!have.has(s)) await target.toggleStatusEffect(s, { active: true }).catch(() => {});
  await target.sheet?.render(false);
  const stamped = { ...r, undone: { by: game.user.id, byName: game.user.name, at: Date.now() } };
  await message.update({ content: await _renderReceipt(stamped), [`flags.${SCOPE}.${RECEIPT_FLAG}`]: stamped });
  ui.notifications?.info(localizeParam("DamageReceiptUndoDone", { total: Number(r.totalApplied) || 0, target: target.name }));
  return true;
}

/* ───────────────────────────── wiring ───────────────────────────── */

export function registerDamageReceipt() {
  // The receipt card's controls: View reopens the window read-only on the receipt's own rows; Undo is the GM's.
  onGlobalClick(async (ev) => {
    const btn = ev.target?.closest?.(".cp-receipt-view, .cp-receipt-undo");
    if (!btn) return;
    ev.preventDefault();
    const message = game.messages.get(btn.closest?.("[data-message-id]")?.dataset?.messageId ?? "");
    const r = message?.getFlag?.(SCOPE, RECEIPT_FLAG);
    if (!r) return;
    if (btn.classList.contains("cp-receipt-undo")) { await undoReceipt(message); return; }
    const { DamageDialog } = await import("./DamageDialog.js");
    const target = resolveActorRef(r.targetRef ?? {}) ?? { name: r.targetName ?? "", system: {} };
    new DamageDialog({ weaponName: r.weaponName ?? "", areaDamages: {} }, target, { receipt: r }).render(true);
  });

  // The Undo control is the referee's: a player's log shows the receipt without it.
  onChatCardRender((message, html) => {
    if (!message?.getFlag?.(SCOPE, RECEIPT_FLAG)) return;
    if (game.user?.isGM) return;
    getHtmlElement(html)?.querySelector?.(".cp-receipt-undo")?.remove();
  });

  // The seat's end of the hand-over: a named player's client, or the primary GM session, opens the window.
  game.socket.on(SOCKET, async (data) => {
    if (data?.type !== OPEN_WINDOW_TYPE) return;
    const mine = data.forUserId ? data.forUserId === game.user?.id : (game.user?.isGM && isPrimaryGMSession());
    if (!mine) return;
    const target = resolveActorRef(data.targetRef ?? {});
    if (!target) { console.warn(`${SCOPE} | openDamageWindow: target not found`, data.targetRef); return; }
    const { DamageDialog } = await import("./DamageDialog.js");
    new DamageDialog(data.payload, target, { cardMessageId: data.cardMessageId ?? null }).render(true);
  });
}
