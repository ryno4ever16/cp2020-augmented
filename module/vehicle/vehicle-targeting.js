/**
 * STUB — the full vehicle-targeting port lands with the vehicle slice. Until then
 * dispatchAttack() always returns false (no shot is treated as a vehicle attack),
 * so combat damage flows the normal personnel path in damage-hooks.
 */
export async function dispatchAttack() { return false; }
