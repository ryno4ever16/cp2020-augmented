/**
 * P4 — Vision devices (SPECIAL-MECHANICS-PROPOSAL.md; IR / low-light / thermograph / UV optics).
 *
 * Where mechLight changes how the token is SEEN, mechVision changes how it SEES: an equipped item
 * with `system.mechVision.enabled` switched on overrides the wearer's token sight with the device's
 * profile. Only ONE device governs a token's sight at a time — by default the longest range wins
 * (deterministic tie-break by mode then stable order); the actor flag `visionPick` (the Q5 picker)
 * overrides that: an item id picks that device, "natural" suspends all overrides (base sight even
 * while devices are on). The token's own sight AND detection modes are preserved in flags on first
 * override and restored exactly when the override ends — same discipline as the light engine, whose
 * applier/token helpers this module shares.
 *
 * MODE TABLE:
 *   lowlight    — light amplification (or darkvision fallback); no heat sense.
 *   infrared    — heat vision: basic sight + heat sense, no terrain darkvision. Its own text is
 *                 "total darkness, using heat emissions" — cold terrain emits no heat, so it shows
 *                 living/warm sources in the dark, not walls. Deliberately IDENTICAL to thermograph
 *                 (2026-07-12 balance call): both are heat-only, so IR no longer strictly dominates
 *                 thermograph at the same 200eb/1 humanity price.
 *   thermograph — heat patterns only: BASIC vision + heat sense (no terrain darkvision — in the
 *                 dark it shows living heat sources, not walls).
 *   uv          — darkvision, but only while its ILLUMINATOR is carried (requiresItem — the
 *                 IR/UV Flashlight finger or the IR Flash).
 *
 * HEAT SENSE = a custom DetectionMode (`cpHeatSense`): reveals LIVING tokens within the device
 * range, wall-blocked, light-independent. Living = actor flag `living` when set, else the type
 * default (character/npc yes; vehicles/ACPA/others no).
 */

import { tokensOf, iAmTheApplier, enqueueApply, updateTokenDoc } from "./light.js";
import { contributingItems } from "./cyberlimb.js";
import { cwIsEnabled } from "../utils.js";
import { mechTokenWritesEnabled } from "../settings.js";

const SCOPE = "cp2020-augmented";
const BASE_FLAG = "mechBaseSight";
const PICK_FLAG = "visionPick";
export const HEAT_SENSE_ID = "cpHeatSense";

/** mode → { prefs: ordered vision-mode preferences (first the core ships wins), heat: heat sense } */
export const MODE_TABLE = {
  lowlight:    { prefs: ["lightAmplification", "darkvision", "basic"], heat: false },
  // terrainSight false: core renders sight.range as "distance seen in total darkness" — a
  // heat-only device must not grant that (lit areas stay visible regardless; the heat-sense
  // detection entry keeps the device range). IR and thermograph share this profile by design.
  infrared:    { prefs: ["basic"], heat: true, terrainSight: false },
  thermograph: { prefs: ["basic"], heat: true, terrainSight: false },
  uv:          { prefs: ["darkvision", "basic"], heat: false },
  // Sonic imaging (CB4 p.13 processor + the Tritech goggles): sees in pitch-blackness regardless
  // of the EM spectrum — darkvision, no heat sense (sound, not IR).
  echolocation: { prefs: ["darkvision", "basic"], heat: false }
};
/** The sheet's mode <select> list — derived from MODE_TABLE so the two can never diverge
 *  (a mode missing from the select gets silently rewritten on the next sheet submit). */
export const VISION_DEVICE_MODES = Object.keys(MODE_TABLE);

/** Living gate for heat sense: explicit actor flag wins; else the actor-type default. Pure-ish. */
export function isLivingActor(actor) {
  if (!actor) return false;
  const flag = actor.getFlag?.(SCOPE, "living") ?? actor.flags?.[SCOPE]?.living;
  if (flag !== undefined && flag !== null) return !!flag;
  return actor.type === "character" || actor.type === "npc";
}

/** True when `item` currently works as an illuminator: equipped, cyberware switched on, and (if it
 *  is itself a light emitter) lit. Pure. */
export function illuminatorLit(item) {
  if (!item?.system?.equipped) return false;
  if (item.type === "cyberware" && !cwIsEnabled(item)) return false;
  const ml = item.system?.mechLight;
  if (ml?.enabled) return !!ml.on;
  return true;
}

/** The device's requiresItem dependency is satisfied by `items` (empty = self-sufficient). Pure. */
export function illuminatorSatisfied(requiresItem, items) {
  const names = String(requiresItem ?? "").split("|").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length) return true;
  return (items ?? []).some(it => names.includes(String(it?.name ?? "").trim().toLowerCase()) && illuminatorLit(it));
}

/** The item's vision profile when it is an enabled device, else null. Pure. */
export function visionProfileOf(item) {
  const mv = item?.system?.mechVision;
  if (!mv?.enabled) return null;
  return {
    itemId: item.id ?? item._id ?? "",
    mode: MODE_TABLE[mv.mode] ? mv.mode : "lowlight",
    range: Math.max(0, Number(mv.range) || 0),
    requiresItem: String(mv.requiresItem ?? ""),
    on: !!mv.on
  };
}

/** True when the item currently governs sight candidates (equipped + enabled + on + illuminator).
 *  `allItems` supplies the illuminator context; omitted = dependency assumed unmet unless empty. */
export function isViewing(item, allItems) {
  const p = visionProfileOf(item);
  if (!p?.on || !item?.system?.equipped) return false;
  if (item.type === "cyberware" && !cwIsEnabled(item)) return false;   // switched-off optic doesn't govern
  return illuminatorSatisfied(p.requiresItem, allItems);
}

/**
 * The ONE device profile that should govern the wearer's sight, or null.
 * `pick` (the Q5 picker): "" = auto (longest range, ties by mode then stable order);
 * "natural" = no override; an item id = that device when it is active, else auto.
 */
export function desiredVisionFor(items, pick = "") {
  if (pick === "natural") return null;
  const active = (items ?? []).filter(it => isViewing(it, items)).map(visionProfileOf);
  if (!active.length) return null;
  if (pick) {
    const chosen = active.find(p => p.itemId === pick);
    if (chosen) return chosen;
  }
  active.sort((a, b) => (b.range - a.range) || a.mode.localeCompare(b.mode));
  return active[0];
}

/** Resolve the device mode to a vision mode the running core actually provides. */
export function resolveVisionMode(mode) {
  const provided = CONFIG?.Canvas?.visionModes ?? {};
  for (const pref of MODE_TABLE[mode]?.prefs ?? []) if (pref in provided) return pref;
  return "basic";
}

/** The actor's picker choice ("" auto | "natural" | item id). */
export function visionPickOf(actor) {
  return String(actor?.getFlag?.(SCOPE, PICK_FLAG) ?? "");
}

/**
 * Register the heat-sense DetectionMode (init hook — before any canvas builds): reveals LIVING
 * tokens within the entry's range; wall-blocked (SIGHT type); light-independent like every
 * detection mode. Range/LOS legs stay the core's own tests — only the living gate is ours.
 */
export function registerHeatSenseDetectionMode() {
  const DM = foundry?.canvas?.perception?.DetectionMode ?? globalThis.DetectionMode;
  if (!DM) return;
  const TokenCls = () => foundry?.canvas?.placeables?.Token ?? globalThis.Token;
  class HeatSenseDetectionMode extends DM {
    constructor() {
      super({
        id: HEAT_SENSE_ID, label: "CYBERPUNK.HeatSense",
        walls: true, angle: false, type: DM.DETECTION_TYPES.SIGHT
      });
    }
    /** @override */
    _canDetect(visionSource, target) {
      const Token = TokenCls();
      if (Token && !(target instanceof Token)) return false;
      return isLivingActor(target?.actor ?? target?.document?.actor);
    }
  }
  CONFIG.Canvas.detectionModes[HEAT_SENSE_ID] = new HeatSenseDetectionMode();
}

/** Apply (or restore) the governing device's sight on every active token of `actor` — serialized
 *  through the shared per-actor queue (see light.js enqueueApply: overlapping applies raced). */
export function applyActorVision(actor) {
  if (!actor) return Promise.resolve();
  return enqueueApply(actor, () => _applyActorVision(actor));
}

/**
 * Detection-modes patch keys for adding/removing OUR heat-sense entry, shape-aware:
 *   v14: `detectionModes` is a TypedObjectField keyed by mode id — per-key merge, so a dotted
 *        add (`detectionModes.cpHeatSense`) / deletion key (`-=`) never touches other modes.
 *   v13: an ArrayField — arrays replace wholesale, so rebuild the array keeping foreign entries.
 * No snapshot needed either way: we only ever own our single entry.
 */
function heatSensePatch(tokenDoc, wanted, range) {
  const src = tokenDoc._source?.detectionModes;
  if (Array.isArray(src)) {
    const keep = src.filter(d => d?.id !== HEAT_SENSE_ID);
    if (wanted) keep.push({ id: HEAT_SENSE_ID, enabled: true, range });
    return { detectionModes: keep };
  }
  const has = !!src?.[HEAT_SENSE_ID];
  if (wanted) return { [`detectionModes.${HEAT_SENSE_ID}`]: { enabled: true, range } };
  return has ? { [`detectionModes.-=${HEAT_SENSE_ID}`]: null } : {};
}

async function _applyActorVision(actor) {
  // Zone gate (M19): a device whose host limb is destroyed no longer governs sight.
  const items = contributingItems(actor);
  const desired = desiredVisionFor(items, visionPickOf(actor));
  for (const tokenDoc of tokensOf(actor)) {
    try {
      const base = tokenDoc.getFlag(SCOPE, BASE_FLAG);
      if (desired) {
        const patch = {
          "sight.enabled": true,
          "sight.visionMode": resolveVisionMode(desired.mode),
          "sight.range": MODE_TABLE[desired.mode]?.terrainSight === false ? 0 : desired.range,
          ...heatSensePatch(tokenDoc, !!MODE_TABLE[desired.mode]?.heat, desired.range)
        };
        // Snapshot the SOURCE sight (token.sight is a plain object on some cores — no toObject()).
        if (base === undefined) patch[`flags.${SCOPE}.${BASE_FLAG}`] = foundry.utils.deepClone(tokenDoc._source?.sight ?? {});
        await updateTokenDoc(tokenDoc, patch);
      } else if (base !== undefined) {
        await updateTokenDoc(tokenDoc, {
          sight: base,
          [`flags.${SCOPE}.-=${BASE_FLAG}`]: null,
          ...heatSensePatch(tokenDoc, false, 0)
        });
      }
    } catch (err) {
      console.warn("cp2020-augmented | mech-vision token update failed:", err);
    }
  }
}

/** Force-restore ONE token's own saved sight + strip our heat-sense entry (base flag → sight, flag
 *  removed), independent of whether the actor still has an active device. Used when the write gate
 *  turns off. Whole-object `sight:` write is the established restore pattern — `base` is the
 *  complete _source snapshot. */
async function restoreTokenVision(tokenDoc) {
  try {
    const base = tokenDoc.getFlag(SCOPE, BASE_FLAG);
    if (base === undefined) return;
    await updateTokenDoc(tokenDoc, {
      sight: base,
      [`flags.${SCOPE}.-=${BASE_FLAG}`]: null,
      ...heatSensePatch(tokenDoc, false, 0)
    });
  } catch (err) {
    console.warn("cp2020-augmented | mech-vision restore failed:", err);
  }
}

/** Apply-or-restore the governing device's sight for every actor on `scene` that owns a vision-enabled
 *  item or still carries our base-sight flag (deduped per actor — linked tokens are covered by one
 *  applyActorVision). Applier-scoped. Shared by the canvasReady resync and the ON settings sweep. */
async function reconcileSceneVision(scene) {
  const seen = new Set();
  for (const tokenDoc of scene?.tokens ?? []) {
    const actor = tokenDoc.actor;
    if (!actor || !iAmTheApplier(actor)) continue;
    const key = actor.uuid ?? actor.id;
    if (seen.has(key)) continue;
    const hasDevice = (actor.items?.contents ?? []).some(i => i.system?.mechVision?.enabled);
    const staleFlag = tokenDoc.getFlag?.(SCOPE, BASE_FLAG) !== undefined;
    if (hasDevice || staleFlag) { seen.add(key); applyActorVision(actor); }
  }
}

/** Settings-toggle reconcile for mechTokenWrites (settings.js onChange). OFF → force-restore every
 *  token still carrying our base-sight flag (the gear-off restore is now gated out). ON → one
 *  apply-or-restore sweep across all scenes. Applier-scoped; safe to fire on every client. */
export async function reconcileTokenWrites(enabled) {
  if (enabled) {
    for (const scene of game.scenes ?? []) await reconcileSceneVision(scene);
    return;
  }
  for (const scene of game.scenes ?? []) {
    for (const tokenDoc of scene.tokens ?? []) {
      const actor = tokenDoc.actor;
      if (!actor || !iAmTheApplier(actor)) continue;
      if (tokenDoc.getFlag?.(SCOPE, BASE_FLAG) !== undefined) await restoreTokenVision(tokenDoc);
    }
  }
}

/** Does this item event concern the vision engine at all? (Illuminator items count: toggling the
 *  flashlight can gate a dependent UV device on another item of the same actor.) */
function visionRelevant(item, changed) {
  if (!item?.actor || item.actor.documentName !== "Actor") return false;
  const anyDependent = (item.actor.items?.contents ?? []).some(i => i.system?.mechVision?.enabled && i.system?.mechVision?.requiresItem);
  if (changed) {
    const sys = changed.system ?? {};
    if ("mechVision" in sys) return true;
    if ("equipped" in sys && (item.system?.mechVision?.enabled || anyDependent)) return true;
    // EffectActive re-evaluates the DEVICE itself (a switched-off cyberware optic stops governing)
    // as well as any dependent (an illuminator implant gating a UV device).
    if ("EffectActive" in sys && (item.system?.mechVision?.enabled || anyDependent)) return true;
    if ("mechLight" in sys && anyDependent) return true;
    return false;
  }
  return !!item.system?.mechVision?.enabled || anyDependent;
}

/** Hook wiring — called once from the module's ready hook. Every reaction is gated by the same
 *  token-writes toggle as the light engine (settings.js mechTokenWritesEnabled): with it off,
 *  vision devices never rewrite token sight/detection — the GM's token settings stand. */
export function registerMechVision() {
  Hooks.on("updateItem", (item, changed) => {
    if (!mechTokenWritesEnabled()) return;
    if (visionRelevant(item, changed) && iAmTheApplier(item.actor)) applyActorVision(item.actor);
  });
  Hooks.on("createItem", (item) => {
    if (!mechTokenWritesEnabled()) return;
    if (visionRelevant(item) && iAmTheApplier(item.actor)) applyActorVision(item.actor);
  });
  Hooks.on("deleteItem", (item) => {
    if (!mechTokenWritesEnabled()) return;
    if (visionRelevant(item) && iAmTheApplier(item.actor)) applyActorVision(item.actor);
  });
  // A token PASTED from an overridden original carries stale sight values + our base flag but nothing
  // may govern — apply anyway (its else-branch restores) so the copy sheds the stale sight.
  Hooks.on("createToken", (tokenDoc) => {
    if (!mechTokenWritesEnabled()) return;
    const actor = tokenDoc?.actor;
    if (!actor || !iAmTheApplier(actor)) return;
    const items = actor.items?.contents ?? [];
    const views = items.some(i => isViewing(i, items));
    const staleFlag = tokenDoc.getFlag?.(SCOPE, BASE_FLAG) !== undefined;
    if (views || staleFlag) applyActorVision(actor);
  });
  // Newly readied scene: reconcile tokens the applier may never have updated (a device toggled while
  // it viewed another scene) or whose override went stale — apply-or-restore per actor.
  Hooks.on("canvasReady", (canvas) => {
    if (!mechTokenWritesEnabled()) return;
    if (canvas?.scene) reconcileSceneVision(canvas.scene);
  });
  // The Q5 picker: changing the actor's visionPick flag re-resolves the governor. Zone-state
  // changes (limbStatus, M19) re-resolve too — a device in a newly destroyed limb stops governing.
  Hooks.on("updateActor", (actor, changed) => {
    if (!mechTokenWritesEnabled()) return;
    const flags = changed?.flags?.[SCOPE];
    if (!flags) return;
    const relevant = Object.keys(flags).some(k =>
      k === PICK_FLAG || k === `-=${PICK_FLAG}` || k === "limbStatus" || k === "-=limbStatus");
    if (!relevant) return;
    if (iAmTheApplier(actor)) applyActorVision(actor);
  });
}
