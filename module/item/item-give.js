/**
 * item-give.js  —  module/item/item-give.js
 *
 * ALT + DROP = GIVE (user rulings 2026-10-22/23). Core's drag between sheets is a COPY and stays exactly that —
 * "I don't like replacing core functionality… if there's a modifier key gesture, it should be our trade rather
 * than the core functionality that goes on the modifier." So the trade rides Alt: holding Alt while dropping an
 * item from one character's sheet onto another's — or onto that character's token on the map — MOVES it: the item
 * leaves the sheet it was on and arrives on the recipient, unequipped. A player may give only what is on a sheet
 * they own (a drag off someone else's sheet is refused with a notice, plain drops aside); when the giver cannot
 * write the recipient the move is relayed to the referee's session, the same road every other player write takes.
 * One card in the chat says who handed what to whom. No lists, no pickers: the recipient is the sheet or the
 * figure the item was dropped on.
 *
 * Wired unconditionally (cp2020-augmented.js): the sheet's own drop handler asks `giveDroppedItem` first when Alt
 * is held, and the canvas drop hook below handles the token case.
 */
import { localize, localizeParam, resolveActorRef } from "../utils.js";
import { postSavePromptCard } from "../compat.js";
import { isPrimaryGMSession } from "../gm-session-primary.js";
import { actorRefOf } from "../combat/damage-receipt.js";

const SCOPE = "cp2020-augmented";
const SOCKET = `module.${SCOPE}`;
const GIVE_TYPE = "itemGive";

/** What changes hands: the things a character carries. Skills, roles, programs and the like are not possessions. */
export const GIVEABLE_TYPES = Object.freeze(new Set(["weapon", "armor", "misc", "ammo", "cyberware", "vehicle"]));

/** The dropped item as an embedded document, or null when the drop is not an item off a sheet. The sheet hands
 *  over the Item document core already resolved; the canvas hook hands over the raw drop data (type + uuid). */
async function _droppedEmbeddedItem(data) {
  let item = null;
  if (data?.documentName === "Item") item = data;
  else if (data?.type === "Item" && data?.uuid) { try { item = await fromUuid(data.uuid); } catch (_e) { return null; } }
  if (!item || item.documentName !== "Item" || item.parent?.documentName !== "Actor") return null;
  return item;
}

/** May this user give this item: it sits on a sheet they own, it is a possession, and it is not installed. */
export function giveRefusal(item, user = game.user) {
  if (!item?.parent) return "GiveNotFromSheet";
  if (!item.parent.testUserPermission?.(user, "OWNER")) return "GiveNotYours";
  if (!GIVEABLE_TYPES.has(item.type)) return "GiveNotGiveable";
  if (item.type === "cyberware" && item.system?.equipped === true) return "GiveInstalled";
  return null;
}

/** The move itself: a copy on the recipient, unequipped, then the original deleted; one card for the table. */
async function _performGive(item, recipient, { byUserName = game.user?.name ?? "" } = {}) {
  const source = item.parent;
  const data = item.toObject();
  delete data._id;
  if (data.system && "equipped" in data.system) data.system.equipped = false;
  const [created] = await recipient.createEmbeddedDocuments("Item", [data]);
  if (!created) return false;
  await item.delete();
  await postSavePromptCard({
    title: localize("GiveCardTitle"),
    body: localizeParam("GiveCardBody", { user: byUserName, item: created.name, from: source?.name ?? "", to: recipient.name }),
    speaker: ChatMessage.getSpeaker({ actor: recipient }),
  });
  return true;
}

/**
 * Handle a drop as a GIVE. Resolves true when the drop was a give — performed, relayed, or refused with a notice —
 * and false when it is not one at all (not an item off a sheet, or a drop back onto its own sheet), so the caller
 * lets core's own drop run.
 */
export async function giveDroppedItem(data, recipient) {
  const item = await _droppedEmbeddedItem(data);
  if (!item || !recipient) return false;
  if (item.parent.uuid === recipient.uuid) return false;   // its own sheet: core's sort
  const refusal = giveRefusal(item);
  if (refusal) { ui.notifications?.warn(localizeParam(refusal, { item: item.name })); return true; }
  if (recipient.isOwner) { await _performGive(item, recipient); return true; }
  if (!game.users?.activeGM) { ui.notifications?.warn(localize("GiveNoGm")); return true; }
  game.socket.emit(SOCKET, { type: GIVE_TYPE, itemUuid: item.uuid, recipientRef: actorRefOf(recipient), requesterId: game.user.id, requesterName: game.user.name });
  ui.notifications?.info(localizeParam("GiveRelayed", { item: item.name, to: recipient.name }));
  return true;
}

/** The figure under a canvas point, for the token drop. */
function _tokenAt(x, y) {
  return canvas?.tokens?.placeables?.find(t => t.visible && t.bounds?.contains?.(x, y)) ?? null;
}

export function registerItemGive() {
  // Alt + drop on a FIGURE on the map: the same give, the token's actor as the recipient. Returns false to keep
  // core from doing anything else with the drop; without Alt the drop is core's as always.
  Hooks.on("dropCanvasData", (_canvas, data, event) => {
    if (!event?.altKey || data?.type !== "Item") return;
    const tok = _tokenAt(Number(data.x), Number(data.y));
    if (!tok?.actor) return;
    giveDroppedItem(data, tok.actor).catch(e => console.warn(`${SCOPE} | item give (canvas) failed`, e));
    return false;
  });

  // The referee's end of a relayed give: exactly one session performs it (the primary GM session), as every
  // other player write is performed. The giver's own permission was checked on their client; it is checked
  // again here on the referee's reading of the same documents.
  game.socket.on(SOCKET, async (data) => {
    if (data?.type !== GIVE_TYPE) return;
    if (!game.user?.isGM || !isPrimaryGMSession()) return;
    try {
      const item = await fromUuid(data.itemUuid);
      const recipient = resolveActorRef(data.recipientRef ?? {});
      const requester = game.users.get(data.requesterId) ?? null;
      if (!item || !recipient) return;
      const refusal = requester ? giveRefusal(item, requester) : "GiveNotYours";
      if (refusal) { ui.notifications?.warn(localizeParam(refusal, { item: item.name })); return; }
      await _performGive(item, recipient, { byUserName: data.requesterName ?? requester?.name ?? "" });
    } catch (e) { console.warn(`${SCOPE} | item give (relay) failed`, e); }
  });
}
