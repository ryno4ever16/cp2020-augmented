/**
 * One-shot chat-card lock (module ruling).
 *
 * A module PROMPT card that carries action buttons stamps itself "resolved" on its FIRST successful
 * resolution. Once stamped, the render pass disables every button on the card and adds the
 * `.cp-card-resolved` class — for players the buttons never come back (that is the point: a resolved
 * prompt can never be re-fired). A GM-only re-arm control (↺) clears the stamp so a misclick / mis-
 * adjudication can be redone. The re-arm control is a SEVERABLE add-on: flip ENABLE_REARM to false
 * (or delete the two blocks it guards) to remove it entirely.
 *
 * The stamp lives as a message flag under the module scope. A PLAYER who resolves a card they are
 * allowed to act on (e.g. rolling their own actor's stun save) cannot write a flag onto a GM-authored
 * message — Foundry rejects a non-author, non-GM document update. So markCardResolved() routes the
 * write through the module socket to the ACTIVE GM, mirroring the damage / gas-cloud / suppressive-fire
 * relays in combat/damage-hooks.js. The active GM stamps the message; the resulting updateChatMessage
 * broadcast re-renders the card on every client, where the render pass locks the buttons for everyone.
 *
 * Public API (call from a card's resolution path AFTER the action has succeeded — never on click, so a
 * refused / failed action does not burn the card):
 *   isCardResolved(message)            → boolean
 *   markCardResolved(messageOrId, note?) → Promise<boolean>  (true if it stamped or relayed this call)
 */

import { onGlobalClick } from "./popout-compat.js";
import { localize } from "./utils.js";

const SCOPE = "cp2020-augmented";
const FLAG = "cardResolved";
const RELAY_TYPE = "cardResolveStamp";

// Severable: the GM ↺ re-arm control. Set to false to ship without it (no other change needed).
const ENABLE_REARM = true;

/** True when the message has been stamped resolved. */
export function isCardResolved(message) {
  return !!message?.getFlag?.(SCOPE, FLAG)?.resolved;
}

/** This client may write the message directly when it is the author or a GM. */
function _canWriteMessage(message) {
  return !!game.user?.isGM || message?.isAuthor === true;
}

/**
 * Stamp a card resolved. Writes directly when we own the message (author/GM); otherwise relays the
 * write to the active GM over the module socket. Idempotent: a no-op (returns false) if already stamped.
 * @param {ChatMessage|string} messageOrId
 * @param {string} [note]  optional short note recorded in the flag (e.g. which outcome resolved it)
 * @returns {Promise<boolean>}
 */
export async function markCardResolved(messageOrId, note) {
  const message = typeof messageOrId === "string" ? game.messages?.get(messageOrId) : messageOrId;
  if (!message || isCardResolved(message)) return false;
  const data = { resolved: true, at: Date.now(), by: game.user?.id ?? null };
  if (note) data.note = String(note);

  if (_canWriteMessage(message)) {
    try {
      await message.setFlag(SCOPE, FLAG, data);
    } catch (e) {
      console.warn(`${SCOPE} | markCardResolved setFlag failed`, e);
      return false;
    }
  } else {
    // Player resolving a GM-authored card: relay the stamp to the active GM (the damage-relay idiom).
    game.socket.emit(`module.${SCOPE}`, { type: RELAY_TYPE, messageId: message.id, data });
  }
  return true;
}

/** renderChatMessageHTML pass: lock a stamped card's buttons + (GM) inject the re-arm control. */
function _lockRenderedCard(message, html) {
  if (!isCardResolved(message)) return;
  const root = html instanceof jQuery ? html[0] : html;
  const card = root?.querySelector?.(".cyberpunk-card, .cyberpunk");
  if (!card) return;

  card.classList.add("cp-card-resolved");
  card.querySelectorAll("button").forEach((b) => {
    if (b.classList.contains("cp-card-rearm")) return;   // never disable the re-arm control itself
    b.disabled = true;
  });

  if (ENABLE_REARM && game.user?.isGM) _injectRearm(card, message);
}

/** Severable: append the GM-only ↺ re-arm button to a locked card. Guarded against re-render dupes. */
function _injectRearm(card, message) {
  if (card.querySelector(".cp-card-rearm")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cp-card-rearm";
  btn.title = localize("CardRearmTitle");
  btn.setAttribute("aria-label", localize("CardRearmTitle"));
  btn.dataset.messageId = message.id;
  btn.textContent = "↺";   // ↺
  card.appendChild(btn);
}

/** One-time setup: the render pass, the GM stamp-relay listener, and (severable) the re-arm handler. */
export function registerCardLock() {
  Hooks.on("renderChatMessageHTML", _lockRenderedCard);

  // Active-GM listener: write the stamp on behalf of a player who resolved a GM-authored card. Only the
  // active GM writes (mirrors the other relays) so a two-GM table does not double-write the flag.
  game.socket.on(`module.${SCOPE}`, async (data) => {
    if (data?.type !== RELAY_TYPE) return;
    if (!game.user?.isGM || game.users?.activeGM?.id !== game.user.id) return;
    const message = game.messages?.get(data.messageId);
    if (!message || isCardResolved(message)) return;
    try {
      await message.setFlag(SCOPE, FLAG, data.data);
    } catch (e) {
      console.warn(`${SCOPE} | cardResolveStamp relay write failed`, e);
    }
  });

  // ── CARD RE-ARM (severable add-on) ──────────────────────────────────────────────────────────────
  // Clears the stamp on a GM's ↺ click; the message re-renders fresh (buttons enabled, no lock class).
  // Delete this block + set ENABLE_REARM = false to remove the re-arm feature.
  if (ENABLE_REARM) {
    onGlobalClick(async (ev) => {
      const btn = ev.target?.closest?.(".cp-card-rearm");
      if (!btn) return;
      ev.preventDefault();
      if (!game.user?.isGM) return;   // players never re-arm
      const messageId = btn.dataset.messageId || btn.closest?.("[data-message-id]")?.dataset?.messageId;
      const message = messageId ? game.messages?.get(messageId) : null;
      if (!message) return;
      try {
        await message.unsetFlag(SCOPE, FLAG);   // GM is always allowed to write
      } catch (e) {
        console.warn(`${SCOPE} | card re-arm unsetFlag failed`, e);
      }
    });
  }
}
