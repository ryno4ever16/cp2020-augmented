/**
 * GM SETUP MODE — "I am furnishing this world, not playing in it."
 *
 * A GM kitting out NPCs, seeding a shop's demo stock, or rebuilding a character after a data fix is
 * doing bookkeeping, not shopping. Every one of those actions used to charge eurobucks, decrement the
 * vendor's stock, and narrate itself to the chat log, so the GM's setup afternoon left a trail of
 * purchases nobody made and a shop whose shelves had been emptied by nobody.
 *
 * While this is ON, on THIS CLIENT, every acquisition the client initiates:
 *   · costs 0 eurobucks,
 *   · leaves shop stock alone,
 *   · posts NO chat card at all — a silent grant.
 * Everything else is byte-identical to a paid buy: the same `fromCompendium` copy, so the corrections
 * layer fires the same way; the same ammo loading; the same flags. The point is a free copy of the
 * REAL thing, not a different code path that might drift from it.
 *
 * ⛔⛔ CLIENT-LOCAL, AND THAT IS THE WHOLE SAFETY ARGUMENT. This is deliberately NOT a world setting
 * and not a game setting of any kind:
 *   · A world setting would make purchases free for the PLAYERS TOO, which silently breaks the
 *     economy the shop exists to enforce — the exact bug a "GM convenience" toggle must never cause.
 *   · A player's own buy on their own client never consults this, so they keep paying while the GM's
 *     mode is on. A purchase REQUEST a GM approves runs on the GM's client, so an approval made while
 *     setup mode is on is free — that is a GM deliberately gifting an approved request, and the mode
 *     badge is lit on screen while they do it.
 *
 * ⚠ IN MEMORY, NOT PERSISTED, AND THAT IS DELIBERATE. It resets on reload. A persisted "everything is
 * free" flag that a GM set three sessions ago and forgot is a much worse failure than having to click
 * the badge again after a refresh — the fail-safe direction is BACK TO CHARGING.
 *
 * ⭐ THE ONE EXCEPTION, and it is the user's ruling: a cyberware INSTALL keeps its own cards and
 * knobs. Buying a piece of chrome silently is bookkeeping; installing it is surgery, with a Humanity
 * roll and a damage option the GM still wants to see and decide. So the install flow stays fully
 * narrated — it is only the money (the part price AND the surgery fee) that goes to zero.
 */

let _setupMode = false;

/** Is this client currently granting instead of selling? Always false for a non-GM: the flag is only
 *  ever set from the GM-gated toggle, and this second check means a stale UI or a console call on a
 *  player's client cannot make their own purchases free. */
export function isShopSetupMode() {
  return _setupMode === true && game.user?.isGM === true;
}

/** Set the mode. GM-only; a non-GM call is a no-op rather than an error, matching the module's other
 *  double-gated controls. Returns the resulting state. */
export function setShopSetupMode(on) {
  _setupMode = !!on && game.user?.isGM === true;
  return _setupMode;
}

/** Flip it, and hand back the new state for the caller to paint. */
export function toggleShopSetupMode() {
  return setShopSetupMode(!_setupMode);
}
