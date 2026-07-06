/**
 * P4 — Vision devices (SPECIAL-MECHANICS-PROPOSAL.md; IR / low-light / thermograph / UV optics).
 *
 * Where mechLight changes how the token is SEEN, mechVision changes how it SEES: an equipped item
 * with `system.mechVision.enabled` switched on overrides the wearer's token sight with the device's
 * profile. Only ONE device can govern a token's sight at a time — among active devices the longest
 * range wins (deterministic tie-break by mode then item id). The token's own sight is preserved in
 * a flag on first override and restored exactly when the last device goes dark — same discipline as
 * the light engine, whose applier/token helpers this module shares.
 *
 * MODE MAPPING (the deliberate default — see the proposal's open questions): every device mode maps
 * to a see-in-dark vision mode with the device's range; low-light prefers the core's light
 * amplification when present. Higher-fidelity treatments (live-target detection for thermograph,
 * illuminator-dependent IR/UV) are a TABLE change here, not a redesign.
 */

import { tokensOf, iAmTheApplier, enqueueApply } from "./light.js";

const SCOPE = "cp2020-augmented";
const BASE_FLAG = "mechBaseSight";

/** mode → ordered vision-mode preferences; the first one the core actually ships is used. */
const MODE_VISION_PREFS = {
  lowlight:    ["lightAmplification", "darkvision", "basic"],
  infrared:    ["darkvision", "basic"],
  thermograph: ["darkvision", "basic"],
  uv:          ["darkvision", "basic"]
};

/** The item's vision profile when it is an enabled device, else null. Pure. */
export function visionProfileOf(item) {
  const mv = item?.system?.mechVision;
  if (!mv?.enabled) return null;
  return {
    mode: MODE_VISION_PREFS[mv.mode] ? mv.mode : "lowlight",
    range: Math.max(0, Number(mv.range) || 0),
    on: !!mv.on
  };
}

/** True when the item currently governs sight candidates (equipped + enabled + on). Pure. */
export function isViewing(item) {
  const p = visionProfileOf(item);
  return !!(p?.on && item?.system?.equipped);
}

/**
 * The ONE device profile that should govern the wearer's sight, or null: longest range wins,
 * ties break by mode name then stable order. Pure.
 */
export function desiredVisionFor(items) {
  const active = (items ?? []).filter(isViewing).map(visionProfileOf);
  if (!active.length) return null;
  active.sort((a, b) => (b.range - a.range) || a.mode.localeCompare(b.mode));
  return active[0];
}

/** Resolve the device mode to a vision mode the running core actually provides. */
export function resolveVisionMode(mode) {
  const provided = CONFIG?.Canvas?.visionModes ?? {};
  for (const pref of MODE_VISION_PREFS[mode] ?? []) if (pref in provided) return pref;
  return "basic";
}

/** Apply (or restore) the governing device's sight on every active token of `actor` — serialized
 *  through the shared per-actor queue (see light.js enqueueApply: overlapping applies raced). */
export function applyActorVision(actor) {
  if (!actor) return Promise.resolve();
  return enqueueApply(actor, () => _applyActorVision(actor));
}

async function _applyActorVision(actor) {
  const desired = desiredVisionFor(actor.items?.contents ?? actor.items ?? []);
  for (const tokenDoc of tokensOf(actor)) {
    try {
      const base = tokenDoc.getFlag(SCOPE, BASE_FLAG);
      if (desired) {
        const patch = {
          "sight.enabled": true,
          "sight.visionMode": resolveVisionMode(desired.mode),
          "sight.range": desired.range
        };
        // Snapshot the SOURCE sight (token.sight is a plain object on some cores — no toObject()).
        if (base === undefined) patch[`flags.${SCOPE}.${BASE_FLAG}`] = foundry.utils.deepClone(tokenDoc._source?.sight ?? {});
        await tokenDoc.update(patch);
      } else if (base !== undefined) {
        await tokenDoc.update({ sight: base, [`flags.${SCOPE}.-=${BASE_FLAG}`]: null });
      }
    } catch (err) {
      console.warn("cp2020-augmented | mech-vision token update failed:", err);
    }
  }
}

/** Does this item event concern the vision engine at all? */
function visionRelevant(item, changed) {
  if (!item?.actor || item.actor.documentName !== "Actor") return false;
  if (changed) {
    const sys = changed.system ?? {};
    return ("mechVision" in sys) || ("equipped" in sys && !!item.system?.mechVision?.enabled);
  }
  return !!item.system?.mechVision?.enabled;
}

/** Hook wiring — called once from the module's ready hook. */
export function registerMechVision() {
  Hooks.on("updateItem", (item, changed) => {
    if (visionRelevant(item, changed) && iAmTheApplier(item.actor)) applyActorVision(item.actor);
  });
  Hooks.on("createItem", (item) => {
    if (visionRelevant(item) && iAmTheApplier(item.actor)) applyActorVision(item.actor);
  });
  Hooks.on("deleteItem", (item) => {
    if (visionRelevant(item) && iAmTheApplier(item.actor)) applyActorVision(item.actor);
  });
  Hooks.on("createToken", (tokenDoc) => {
    const actor = tokenDoc?.actor;
    if (!actor) return;
    if ((actor.items?.contents ?? []).some(isViewing) && iAmTheApplier(actor)) applyActorVision(actor);
  });
}
