/**
 * GM "VIEW AS PLAYER" — "show me what my players are being offered."
 *
 * The per-book eyes decide which books PLAYERS see, but a GM always sees everything, so the GM had no
 * way to check the result of those choices short of asking a player to open the shop. While this is
 * ON, on THIS CLIENT, the catalog and storefront views list exactly what a player would: the
 * book-visibility rule is applied as for a non-GM, the book chips and their counts follow, and the
 * eye controls are not drawn.
 *
 * It changes what is LISTED and nothing else. A buy reads `game.user.isGM` itself (purchase routing,
 * price requests, stock writes), never this flag, so a GM looking through a player's eyes still buys
 * as the GM.
 *
 * Same shape as setup mode (module/shop/setup-mode.js), for the same reasons: client-local, because
 * it is one person's way of looking, not a fact about the world; in memory, so a reload turns it off
 * rather than leaving a GM wondering why books have vanished from their own catalog.
 */

let _viewAsPlayer = false;

/** Is this client listing the shop as a player would see it? Always false for a non-GM — a player
 *  already sees the player's list, and the flag is only ever set from the GM-gated toggle. */
export function isShopViewAsPlayer() {
  return _viewAsPlayer === true && game.user?.isGM === true;
}

/** Set the mode. GM-only; a non-GM call is a no-op. Returns the resulting state. */
export function setShopViewAsPlayer(on) {
  _viewAsPlayer = !!on && game.user?.isGM === true;
  return _viewAsPlayer;
}

/** Flip it, and hand back the new state for the caller to paint. */
export function toggleShopViewAsPlayer() {
  return setShopViewAsPlayer(!_viewAsPlayer);
}
