/**
 * movement-gate.js  —  module/combat/movement-gate.js
 *
 * One move plus one action per turn (CP2020 p.99 — the move does not cost the action). When a
 * combatant repositions AFTER taking a tracked action this turn, the mover sees a WARNING — the
 * move itself always goes through.
 *
 * ⏪ REDESIGNED 2026-08-29 (settings-trim ruling): this used to be a hard BLOCK behind the
 * `restrictMovementOncePerTurn` world setting (default off). Both the block and the switch are
 * retired together for the upstream philosophy the user cited — prefer showing a bad choice over
 * refusing it. Warning-only needs no GM override (nothing is refused) and no opt-in switch (a
 * warning costs nothing to a table that ignores the rule). A stored value for the old key is
 * orphaned unread.
 *
 * The "has acted this turn" signal is the shared per-round action counter (damage-hooks.js
 * `actionCount`) — the same source of truth the multi-action penalty reads.
 */

const SCOPE = "cp2020-augmented";

/**
 * Has this actor taken a tracked action in the current combat round? Mirrors damage-hooks.js
 * `_getActionCount`: the count is stamped with the round it belongs to, and a stale stamp (from a
 * previous round) reads as zero.
 */
function _hasActedThisRound(actor) {
  const round = game?.combat?.round ?? 0;
  const count = Number(actor?.getFlag?.(SCOPE, "actionCount") ?? 0);
  const countRound = actor?.getFlag?.(SCOPE, "actionCountRound") ?? -1;
  if (round > 0 && countRound !== round) return false;   // stale → treat as not-yet-acted
  return count > 0;
}

/**
 * Pure decision: should this token-move draw the over-allowance warning? All inputs are plain
 * values so the rule can be unit-tested without Foundry. `registerMovementGate` wires the live
 * game state into these arguments.
 *
 * GMs are excluded: a referee repositioning any token is an adjudication, not a combatant
 * spending movement, and warning on every GM nudge would be pure noise.
 *
 * @param {object}  o
 * @param {boolean} o.inCombat         an active combat has started
 * @param {boolean} o.isGM             the moving user is a GM (adjudication — never warned)
 * @param {boolean} o.isPositionChange the update actually moves the token (x or y changed)
 * @param {boolean} o.hasActed         the token's actor has taken a tracked action this turn
 * @returns {boolean} true → show the warning (the move still proceeds)
 */
export function shouldWarnMovement({ inCombat, isGM, isPositionChange, hasActed }) {
  if (!isPositionChange) return false;  // not a move (elevation/name/etc.) → ignore
  if (!inCombat) return false;          // only matters during an active combat
  if (isGM) return false;               // referee repositioning — not a combatant spending movement
  return !!hasActed;                    // over the p.99 allowance once a tracked action was taken
}

/**
 * Register the movement advisory. `preUpdateToken` fires only on the client that initiates the
 * move; the warning shows there and the update is never cancelled.
 */
export function registerMovementGate() {
  Hooks.on("preUpdateToken", (tokenDoc, changes) => {
    const isPositionChange = ("x" in (changes ?? {})) || ("y" in (changes ?? {}));
    const warn = shouldWarnMovement({
      inCombat:         !!game.combat?.started,
      isGM:             !!game.user?.isGM,
      isPositionChange,
      hasActed:         tokenDoc?.actor ? _hasActedThisRound(tokenDoc.actor) : false,
    });
    if (warn) ui.notifications?.warn(game.i18n.localize("CYBERPUNK.MovementLockedAfterAction"));
    // no return value — the move always proceeds
  });
}
