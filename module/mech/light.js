/**
 * P3 — Light emitters (SPECIAL-MECHANICS-PROPOSAL.md; the flashlight pattern).
 *
 * An equipped item with `system.mechLight.enabled` and `.on` lights the bearer's token: cone for
 * flashlights, circle for glowsticks/lamps. The engine listens to the owning actor's item events
 * (create/update/delete fire on EVERY client), and the ACTIVE GM applies the token update — so a
 * player toggling their flashlight on the item sheet needs no special permission and no extra
 * socket traffic. If no GM is connected, an owning client tries the update directly (best effort).
 *
 * The token's pre-existing light is preserved in a token flag the first time an emitter overrides
 * it and restored when the last emitter goes dark — a GM-authored torch glow is never clobbered.
 *
 * Pure pieces (profile read + merge) are exported for tests; only register/apply touch the world.
 */

import { mechTokenWritesEnabled } from "../settings.js";
import { contributingItems } from "./cyberlimb.js";

const SCOPE = "cp2020-augmented";
const BASE_FLAG = "mechBaseLight";

/** The item's light profile when it is an enabled emitter, else null. Pure. */
export function lightProfileOf(item) {
  const ml = item?.system?.mechLight;
  if (!ml?.enabled) return null;
  return {
    shape: ml.shape === "circle" ? "circle" : "cone",
    bright: Math.max(0, Number(ml.bright) || 0),
    dim: Math.max(0, Number(ml.dim) || 0),
    angle: Math.min(360, Math.max(1, Number(ml.angle) || 45)),
    color: String(ml.color ?? "").trim(),
    on: !!ml.on
  };
}

/** True when the item is currently emitting (equipped + enabled + on). Pure. */
export function isEmitting(item) {
  const p = lightProfileOf(item);
  return !!(p?.on && item?.system?.equipped);
}

/**
 * Merge the actor's emitting items into ONE desired token light, or null when nothing emits.
 * Ranges take the max across emitters; any circle contributor opens the beam to 360°, otherwise
 * the widest cone wins; the first non-empty color (stable item order) tints the light. Pure.
 */
export function desiredLightFor(items) {
  const emitting = (items ?? []).filter(isEmitting).map(lightProfileOf);
  if (!emitting.length) return null;
  const anyCircle = emitting.some(p => p.shape === "circle");
  return {
    bright: Math.max(...emitting.map(p => p.bright)),
    dim: Math.max(...emitting.map(p => p.dim)),
    angle: anyCircle ? 360 : Math.max(...emitting.map(p => p.angle)),
    color: emitting.map(p => p.color).find(c => c) || null
  };
}

/** The actor's tokens on the viewed scene (token DOCUMENTS; handles synthetic token-actors).
 *  Shared by the mech/ engines (vision.js imports it).
 *  ⚠ getActiveTokens resolves through canvas PLACEABLES, which draw async after the token
 *  document exists — an apply fired in that window (fresh scene load, just-dropped token) would
 *  see zero tokens and silently skip. Fall back to the viewed scene's linked token DOCUMENTS,
 *  which exist as soon as the document does. */
export function tokensOf(actor) {
  if (actor?.isToken) return actor.token ? [actor.token] : [];
  const active = actor?.getActiveTokens?.(true, true) ?? [];
  if (active.length) return active;
  const scene = game.scenes?.viewed ?? game.scenes?.active;
  return scene?.tokens?.filter?.(t => t.actorLink && t.actorId === actor?.id) ?? [];
}

/** Per-actor apply queue shared by the mech/ engines: rapid toggles fire overlapping async applies,
 *  and an EARLIER apply's token write can land after a LATER restore (rig-proven race). Chaining
 *  per actor serializes the writes; each job re-reads item state at run time, so the chain
 *  converges on the latest toggle. */
const _applyQueues = new Map();
export function enqueueApply(actor, job) {
  const key = actor?.uuid ?? actor?.id ?? "?";
  const next = (_applyQueues.get(key) ?? Promise.resolve()).then(job, job);
  _applyQueues.set(key, next);
  return next;
}

/** Apply (or restore) the merged emitter light on every active token of `actor` (serialized). */
export function applyActorLight(actor) {
  if (!actor) return Promise.resolve();
  return enqueueApply(actor, () => _applyActorLight(actor));
}

async function _applyActorLight(actor) {
  // Zone gate (M19): an emitter whose host limb is destroyed goes dark with it.
  const desired = desiredLightFor(contributingItems(actor));
  for (const tokenDoc of tokensOf(actor)) {
    try {
      const base = tokenDoc.getFlag(SCOPE, BASE_FLAG);
      if (desired) {
        const patch = {
          "light.bright": desired.bright, "light.dim": desired.dim,
          "light.angle": desired.angle, "light.color": desired.color
        };
        // First override: remember the token's own light so going dark restores it exactly.
        // Snapshot the SOURCE (a plain, complete object on every core — prepared `token.light`
        // is a DataModel here but plain elsewhere, and a failed toObject() would store {} and
        // silently break the restore, the exact defect the sight engine hit).
        if (base === undefined) patch[`flags.${SCOPE}.${BASE_FLAG}`] = foundry.utils.deepClone(tokenDoc._source?.light ?? {});
        await tokenDoc.update(patch);
      } else if (base !== undefined) {
        await tokenDoc.update({ light: base, [`flags.${SCOPE}.-=${BASE_FLAG}`]: null });
      }
    } catch (err) {
      console.warn("cp2020-augmented | mech-light token update failed:", err);
    }
  }
}

/** True when THIS client should perform the token writes for the event.
 *  Shared by the mech/ engines (vision.js imports it). */
export function iAmTheApplier(actor) {
  const gm = game.users?.activeGM;
  if (gm) return gm.id === game.user.id;      // exactly one applier when any GM is on
  return !!actor?.isOwner;                     // no GM online: an owner tries directly
}

/** Does this item event concern the light engine at all? */
function lightRelevant(item, changed) {
  if (!item?.actor || item.actor.documentName !== "Actor") return false;
  if (changed) {
    const sys = changed.system ?? {};
    return ("mechLight" in sys) || ("equipped" in sys && !!item.system?.mechLight?.enabled);
  }
  return !!item.system?.mechLight?.enabled;
}

/** Hook wiring — called once from the module's ready hook. Every reaction is gated by the
 *  token-writes toggle (settings.js mechTokenWritesEnabled): with it off, gear toggles never
 *  touch token documents — GMs who hand-author token lighting keep full ownership. */
export function registerMechLight() {
  Hooks.on("updateItem", (item, changed) => {
    if (!mechTokenWritesEnabled()) return;
    if (lightRelevant(item, changed) && iAmTheApplier(item.actor)) applyActorLight(item.actor);
  });
  Hooks.on("createItem", (item) => {
    if (!mechTokenWritesEnabled()) return;
    if (lightRelevant(item) && iAmTheApplier(item.actor)) applyActorLight(item.actor);
  });
  Hooks.on("deleteItem", (item) => {
    if (!mechTokenWritesEnabled()) return;
    if (lightRelevant(item) && iAmTheApplier(item.actor)) applyActorLight(item.actor);
  });
  // A freshly placed token for an actor with a lit emitter starts lit.
  Hooks.on("createToken", (tokenDoc) => {
    if (!mechTokenWritesEnabled()) return;
    const actor = tokenDoc?.actor;
    if (!actor) return;
    if ((actor.items?.contents ?? []).some(isEmitting) && iAmTheApplier(actor)) applyActorLight(actor);
  });
  // Zone-state changes (limbStatus, M19) re-resolve the merged light — an emitter in a newly
  // destroyed limb goes dark; a repaired limb's emitter comes back. Mirrors the vision engine.
  Hooks.on("updateActor", (actor, changed) => {
    if (!mechTokenWritesEnabled()) return;
    const flags = changed?.flags?.[SCOPE];
    if (!flags) return;
    if (!Object.keys(flags).some(k => k === "limbStatus" || k === "-=limbStatus")) return;
    if (iAmTheApplier(actor)) applyActorLight(actor);
  });
}
