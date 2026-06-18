/**
 * PopOut! compatibility for the system's GLOBAL click delegators.
 *
 * The PopOut! module moves an app's live DOM into a second browser window — so the page then has more
 * than one `document`. Our combat/vehicle chat-card buttons (Take Aim, Wait, saves, vehicle fire, missile
 * reactions, …) are handled by event delegation on the MAIN `document`; a click inside a popped-out
 * window (e.g. the chat log popped out via PopOut!) fires on THAT window's document and never reaches the
 * main-document listener, so the button silently does nothing.
 *
 * `onGlobalClick(handler)` registers a click delegator and binds it to the main document AND to every
 * PopOut! window — current registrations are bound to future popouts via the `PopOut:loaded` hook
 * (`Hooks.callAll("PopOut:loaded", app, node)`, node = the app's root in the new window). With PopOut!
 * absent the hook simply never fires and behaviour is identical to a plain `document` listener.
 */

const _handlers = [];            // { handler, options }
const _boundDocs = new WeakSet(); // documents already wired (lets closed-popout docs GC)

function _bindDoc(doc) {
  if (!doc || _boundDocs.has(doc)) return;
  _boundDocs.add(doc);
  for (const e of _handlers) doc.addEventListener("click", e.handler, e.options);
}

/**
 * Register a global click handler (delegation via `ev.target.closest(...)`). Bound to the main document
 * immediately and to any PopOut! window opened later.
 * @param {(ev: MouseEvent) => any} handler
 * @param {boolean|AddEventListenerOptions} [options]
 */
export function onGlobalClick(handler, options) {
  if (typeof handler !== "function") return;
  _handlers.push({ handler, options });
  document.addEventListener("click", handler, options); // main window
}

/** One-time setup (call at ready): bind our click delegators onto every PopOut! window's document. */
export function registerPopoutCompat() {
  Hooks.on("PopOut:loaded", (app, node) => _bindDoc(node?.ownerDocument));
  // PopOut:close destroys the popped-out document; its listeners + the WeakSet entry GC naturally.
}
