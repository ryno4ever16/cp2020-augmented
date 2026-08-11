/**
 * Chat-card render passes that also cover the log's SCROLLBACK batch.
 *
 * THE DEFECT THIS SOLVES (rig-measured on Foundry 14.364 and 13.350, :30004 / :30003).
 * Core renders the chat log in two ways:
 *   - LIVE — one message at a time as it arrives (`ChatLog##postOne`);
 *   - BATCH — many at once, used to repopulate the log after a page load and again for "load more"
 *     when you scroll to the top (`ChatLog#renderBatch` → `ChatLog##doRenderBatch`,
 *     v14 client/applications/sidebar/tabs/chat.mjs:285-324, v13 same file:247-286).
 * Both funnel through `ChatLog.renderMessage` → `ChatMessage#renderHTML`, which emits
 * `renderChatMessageHTML` once per message (v14 client/documents/chat-message.mjs:435,
 * v13 client/documents/chat-message.mjs:419). So the batch path is NOT hook-free.
 *
 * The problem is WHEN the first batch runs. `ChatLog#_onFirstRender` awaits
 * `renderBatch(CONFIG.ChatMessage.batchSize)` (v14 chat.mjs:393, v13 chat.mjs:355) while the UI is
 * being built — which completes BEFORE the `ready` hook. Measured order on a 100-message log:
 *     init → renderBatch enter → renderChatMessageHTML ×100 → renderBatch exit → renderChatLog → ready
 * The module wires its chat-card passes at `ready` (they need settings, users and actors), so every
 * message already in the log had its one and only render pass fire before any listener existed.
 * Result after a reload: payload cards with no Apply control, resolved cards that no longer look
 * locked, shop links with no click handler. The live path and the scroll-up "load more" batch were
 * never affected — by then the listeners are registered — which is why this stayed hidden.
 *
 * THE FIX is registration-shaped, not hook-shaped: a pass registers on `renderChatMessageHTML` for
 * everything rendered from now on, AND immediately runs over the messages already sitting in the log
 * to catch up the batch it was too late for. Same idea as `popout-compat.js`, which binds a click
 * delegator to the current document and to popout windows opened later.
 *
 * A pass is a plain `(message, htmlElement) => void` and MUST be idempotent — the catch-up and the
 * hook can both reach the same card (and a card re-renders on any later edit or flag write), so each
 * pass checks for its own mark before adding anything.
 */

import { getHtmlElement } from "./compat.js";

/**
 * Register a chat-card render pass.
 *
 * Runs for every message rendered from now on, plus once for each message already in the log.
 * @param {(message: ChatMessage, html: HTMLElement) => void} pass  idempotent; must tolerate re-entry
 */
export function onChatCardRender(pass) {
  if (typeof pass !== "function") return;
  Hooks.on("renderChatMessageHTML", pass);
  _catchUp(pass);
}

/**
 * The chat logs whose cards we decorate: the sidebar log and any popped-out copy of it. Deliberately
 * NOT a bare `document.querySelectorAll` — the chat NOTIFICATIONS framework keeps its own transient
 * `.chat-log` holding duplicate elements for the same message ids (v14 chat.mjs:1272), and a card
 * decorated there would be a second copy of a control the user can already see in the log.
 * @returns {HTMLElement[]}
 */
function _chatLogs() {
  const logs = [];
  const add = (app) => {
    const log = app?.element?.querySelector?.(".chat-log");
    if (log && !logs.includes(log)) logs.push(log);
  };
  add(ui.chat);
  add(ui.chat?.popout);
  return logs;
}

/** Run one pass over every message element currently rendered in a chat log. */
function _catchUp(pass) {
  try {
    for (const log of _chatLogs()) {
      for (const el of log.querySelectorAll("[data-message-id]")) {
        const message = game.messages?.get(el.dataset.messageId);
        if (!message) continue;
        try {
          pass(message, getHtmlElement(el));
        } catch (e) {
          console.warn("cp2020-augmented | chat-card render pass failed on a scrollback card", e);
        }
      }
    }
  } catch (e) {
    // Display-only: a card missing its control is better than a broken ready sequence.
    console.warn("cp2020-augmented | chat scrollback catch-up failed", e);
  }
}
