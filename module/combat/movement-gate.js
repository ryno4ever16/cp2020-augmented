/**
 * movement-gate.js  —  module/combat/movement-gate.js
 *
 * Optional rule: restrict token movement to once per turn (CP2020 p.99 — a character gets one move
 * plus one action per turn, and the move does not cost the action).
 *
 * When the `restrictMovementOncePerTurn` setting is ON, during an active combat a combatant may
 * reposition freely UNTIL they take a tracked action this turn (which stamps the shared per-round
 * action counter — see damage-hooks.js `actionCount`). Once they have acted, further token movement
 * is blocked until the next round. GMs are never blocked (they can always reposition any token —
 * the GM override). Off by default.
 *
 * The "has acted this turn" signal is the same `actionCount` flag the multi-action system uses, so
 * the two features share one source of truth. So that the gate works on its own (without the
 * multi-action penalty being enabled), the weapon-fire increment in damage-hooks.js also stamps the
 * counter whenever this setting is on.
 */

const SCOPE = "cp2020-augmented";

function _movementGateEnabled() {
  try { return game.settings.get(SCOPE, "restrictMovementOncePerTurn") === true; } catch { return false; }
}

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
 * Pure decision: should this token-move be blocked? All inputs are plain values so the rule can be
 * unit-tested without Foundry. `registerMovementGate` wires the live game state into these arguments.
 *
 * @param {object}  o
 * @param {boolean} o.enabled          restrictMovementOncePerTurn is on
 * @param {boolean} o.inCombat         an active combat has started
 * @param {boolean} o.isGM             the moving user is a GM (override — never blocked)
 * @param {boolean} o.isPositionChange the update actually moves the token (x or y changed)
 * @param {boolean} o.hasActed         the token's actor has taken a tracked action this turn
 * @returns {boolean} true → cancel the move
 */
export function shouldBlockMovement({ enabled, inCombat, isGM, isPositionChange, hasActed }) {
  if (!enabled) return false;           // opt-in rule is off → never block
  if (!isPositionChange) return false;  // not a move (elevation/name/etc.) → ignore
  if (!inCombat) return false;          // only matters during an active combat
  if (isGM) return false;               // GM override — GMs may always reposition any token
  return !!hasActed;                    // locked once a tracked action was taken this turn
}

/**
 * Register the movement gate. `preUpdateToken` fires only on the client that initiates the move, so
 * returning false aborts that move before it is sent to the server.
 */
export function registerMovementGate() {
  Hooks.on("preUpdateToken", (tokenDoc, changes) => {
    const isPositionChange = ("x" in (changes ?? {})) || ("y" in (changes ?? {}));
    const blocked = shouldBlockMovement({
      enabled:          _movementGateEnabled(),
      inCombat:         !!game.combat?.started,
      isGM:             !!game.user?.isGM,
      isPositionChange,
      hasActed:         tokenDoc?.actor ? _hasActedThisRound(tokenDoc.actor) : false,
    });
    if (!blocked) return;
    ui.notifications?.warn(game.i18n.localize("CYBERPUNK.MovementLockedAfterAction"));
    return false;   // cancel the position update on the initiating client
  });
}
