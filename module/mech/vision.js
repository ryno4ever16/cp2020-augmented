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
 * MODE TABLE (the user-approved Q1 fidelity):
 *   lowlight    — light amplification (or darkvision fallback); no heat sense.
 *   infrared    — its own text "total darkness, using heat emissions": darkvision AND heat sense.
 *   thermograph — heat patterns only: BASIC vision + heat sense (no terrain darkvision — in the
 *                 dark it shows living heat sources, not walls).
 *   uv          — darkvision, but only while its ILLUMINATOR is carried (requiresItem — the
 *                 IR/UV Flashlight finger or the IR Flash).
 *
 * HEAT SENSE = a custom DetectionMode (`cpHeatSense`): reveals LIVING tokens within the device
 * range, wall-blocked, light-independent. Living = actor flag `living` when set, else the type
 * default (character/npc yes; vehicles/ACPA/others no).
 */

import { tokensOf, iAmTheApplier, enqueueApply } from "./light.js";
import { cwIsEnabled } from "../utils.js";

const SCOPE = "cp2020-augmented";
const BASE_FLAG = "mechBaseSight";
const PICK_FLAG = "visionPick";
export const HEAT_SENSE_ID = "cpHeatSense";

/** mode → { prefs: ordered vision-mode preferences (first the core ships wins), heat: heat sense } */
export const MODE_TABLE = {
  lowlight:    { prefs: ["lightAmplification", "darkvision", "basic"], heat: false },
  infrared:    { prefs: ["darkvision", "basic"], heat: true },
  thermograph: { prefs: ["basic"], heat: true },
  uv:          { prefs: ["darkvision", "basic"], heat: false },
  // Sonic imaging (CB4 p.13 processor + the Tritech goggles): sees in pitch-blackness regardless
  // of the EM spectrum — darkvision, no heat sense (sound, not IR).
  echolocation: { prefs: ["darkvision", "basic"], heat: false }
};
/** Back-compat alias (pre-upgrade name, consumed by resolveVisionMode + older specs). */
export const MODE_VISION_PREFS = Object.fromEntries(
  Object.entries(MODE_TABLE).map(([k, v]) => [k, v.prefs]));

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
  const items = actor.items?.contents ?? actor.items ?? [];
  const desired = desiredVisionFor(items, visionPickOf(actor));
  for (const tokenDoc of tokensOf(actor)) {
    try {
      const base = tokenDoc.getFlag(SCOPE, BASE_FLAG);
      if (desired) {
        const patch = {
          "sight.enabled": true,
          "sight.visionMode": resolveVisionMode(desired.mode),
          "sight.range": desired.range,
          ...heatSensePatch(tokenDoc, !!MODE_TABLE[desired.mode]?.heat, desired.range)
        };
        // Snapshot the SOURCE sight (token.sight is a plain object on some cores — no toObject()).
        if (base === undefined) patch[`flags.${SCOPE}.${BASE_FLAG}`] = foundry.utils.deepClone(tokenDoc._source?.sight ?? {});
        await tokenDoc.update(patch);
      } else if (base !== undefined) {
        await tokenDoc.update({
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

/** Does this item event concern the vision engine at all? (Illuminator items count: toggling the
 *  flashlight can gate a dependent UV device on another item of the same actor.) */
function visionRelevant(item, changed) {
  if (!item?.actor || item.actor.documentName !== "Actor") return false;
  const anyDependent = (item.actor.items?.contents ?? []).some(i => i.system?.mechVision?.enabled && i.system?.mechVision?.requiresItem);
  if (changed) {
    const sys = changed.system ?? {};
    if ("mechVision" in sys) return true;
    if ("equipped" in sys && (item.system?.mechVision?.enabled || anyDependent)) return true;
    if (("mechLight" in sys || "EffectActive" in sys) && anyDependent) return true;
    return false;
  }
  return !!item.system?.mechVision?.enabled || anyDependent;
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
    const items = actor.items?.contents ?? [];
    if (items.some(i => isViewing(i, items)) && iAmTheApplier(actor)) applyActorVision(actor);
  });
  // The Q5 picker: changing the actor's visionPick flag re-resolves the governor.
  Hooks.on("updateActor", (actor, changed) => {
    const flags = changed?.flags?.[SCOPE];
    if (!flags || !(PICK_FLAG in flags || `-=${PICK_FLAG}` in flags)) return;
    if (iAmTheApplier(actor)) applyActorVision(actor);
  });
}
