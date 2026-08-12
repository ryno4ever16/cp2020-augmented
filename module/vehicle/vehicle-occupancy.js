/**
 * vehicle-occupancy.js — who is aboard a vehicle, and the two client-side ways of seeing it.
 *
 * 1. QUERIES (pure over a scene + actor): the occupant token documents, the capacity, and the
 *    "N / max" summary. The vehicle sheet, the character-sheet banner and the badge all read
 *    these, so there is one definition of "aboard" — the crew token's `boardedVehicle` flag.
 * 2. THE BADGE: a small count drawn beside the vehicle handle so a GM can see a car is loaded
 *    without opening anything. Drawn on the canvas as the token's own child object — it is
 *    rendering, not data: nothing is written to any document.
 * 3. THE OCCUPANT FADE: a per-client dimming of one vehicle's riders, toggled from the vehicle
 *    token's HUD. Also pure presentation — it touches the placeable's alpha, never the document,
 *    so one player fading a crowded bus does not change anyone else's view, and a reload clears
 *    it. A placeable's alpha is reset by every refresh, so the dim is re-applied from the
 *    `refreshToken` hook for as long as the vehicle stays faded (rig-verified: without the hook
 *    the dim survives exactly until the next refresh).
 */

import { localizeParam } from "../utils.js";

const SCOPE = "cp2020-augmented";
const FADE_ALPHA = 0.25;

/* --------------------------------------------------------------- queries */

/** Token documents currently riding `vehicleActorId` on this scene. */
export function occupantTokens(scene, vehicleActorId) {
  if (!scene || !vehicleActorId) return [];
  return (scene.tokens ?? []).filter(t => t.flags?.[SCOPE]?.boardedVehicle === vehicleActorId);
}

/** Seats the vehicle claims to have: crew + passengers (0 = unstated, not "no room"). */
export function vehicleCapacity(actor) {
  return (Number(actor?.system?.crewSlots) || 0) + (Number(actor?.system?.passengerSlots) || 0);
}

/**
 * Occupancy of a vehicle actor across the scene it is on (defaults to the active/viewed scene).
 * @returns {{count:number, capacity:number, over:boolean, occupants:object[]}}
 */
export function occupancyOf(vehicleActor, scene = null) {
  const sc = scene ?? canvas?.scene ?? game?.scenes?.active ?? null;
  const occupants = occupantTokens(sc, vehicleActor?.id);
  const capacity = vehicleCapacity(vehicleActor);
  return { count: occupants.length, capacity, over: capacity > 0 && occupants.length > capacity, occupants };
}

/**
 * Occupancy for a SHEET, which has no canvas to lean on: every rider of this vehicle on every
 * scene, as display rows. A sheet opened from the sidebar must answer the same question the
 * canvas does, even when the vehicle is parked on a scene nobody is looking at.
 * @returns {{count:number, capacity:number, over:boolean, occupants:{tokenId,sceneId,name,img}[]}}
 */
export function occupancyAcrossScenes(vehicleActor) {
  const occupants = [];
  for (const scene of game.scenes ?? []) {
    for (const t of occupantTokens(scene, vehicleActor?.id)) {
      occupants.push({
        tokenId: t.id, sceneId: scene.id,
        name: t.name ?? t.actor?.name ?? "",
        img: t.texture?.src ?? t.actor?.img ?? "",
      });
    }
  }
  const capacity = vehicleCapacity(vehicleActor);
  return { count: occupants.length, capacity, over: capacity > 0 && occupants.length > capacity, occupants };
}

/** The vehicle actor a crew token is riding, or null. */
export function vehicleOfOccupant(tokenDoc) {
  const id = tokenDoc?.flags?.[SCOPE]?.boardedVehicle;
  return id ? (game.actors?.get(id) ?? null) : null;
}

/**
 * The vehicle an ACTOR is aboard, found from any of its tokens on any scene — the character sheet
 * has no token of its own to ask, and the sidebar must answer the same question a token would.
 * @returns {{vehicle:Actor, tokenDoc:object, scene:object}|null}
 */
export function aboardVehicleFor(actor) {
  if (!actor?.id) return null;
  for (const scene of game.scenes ?? []) {
    for (const t of scene.tokens ?? []) {
      if (t.actorId !== actor.id) continue;
      const vehicleId = t.flags?.[SCOPE]?.boardedVehicle;
      if (!vehicleId) continue;
      const vehicle = game.actors?.get(vehicleId);
      if (vehicle) return { vehicle, tokenDoc: t, scene };
    }
  }
  return null;
}

/* --------------------------------------------------------------- client-local occupant fade */

/** Vehicle actor ids whose riders this client is currently dimming. Never persisted. */
const _faded = new Set();

export function isVehicleFaded(vehicleActorId) {
  return _faded.has(vehicleActorId);
}

/**
 * True while a placeable is still a live display object. Draw/refresh hooks also fire while the
 * canvas is tearing a token down (scene change, token deleted), and touching a destroyed PIXI
 * object throws from inside the engine — rig-caught as a `_parentID` error on scene teardown.
 */
function _isLive(placeable) {
  return !!placeable && placeable.destroyed !== true && !!placeable.transform;
}

/** Apply (or clear) the dim on one placeable, from its own boarding flag. */
function _applyFade(placeable) {
  if (!_isLive(placeable)) return;
  const vehicleId = placeable?.document?.flags?.[SCOPE]?.boardedVehicle;
  if (!vehicleId) return;
  const alpha = _faded.has(vehicleId) ? FADE_ALPHA : 1;
  placeable.alpha = alpha;
  if (placeable.mesh) placeable.mesh.alpha = alpha;
}

/** Re-apply the dim across every drawn token (after a toggle). */
function _refreshFadedTokens(vehicleActorId) {
  for (const p of canvas?.tokens?.placeables ?? []) {
    if (p.document?.flags?.[SCOPE]?.boardedVehicle !== vehicleActorId) continue;
    _applyFade(p);
  }
}

/**
 * Toggle this client's dimming of one vehicle's occupants.
 * @returns {boolean} the new state (true = dimmed)
 */
export function toggleOccupantFade(vehicleActorId) {
  if (!vehicleActorId) return false;
  if (_faded.has(vehicleActorId)) _faded.delete(vehicleActorId);
  else _faded.add(vehicleActorId);
  _refreshFadedTokens(vehicleActorId);
  return _faded.has(vehicleActorId);
}

/* --------------------------------------------------------------- occupancy badge */

/** Text class + style, resolved across cores (v13+ namespaced the canvas containers). */
function _badgeText(content) {
  const TextCls = foundry.canvas?.containers?.PreciseText ?? globalThis.PreciseText ?? PIXI.Text;
  const style = (CONFIG?.canvasTextStyle?.clone?.() ?? new PIXI.TextStyle());
  style.fontSize = 20;
  style.fill = "#f5f5f5";
  const text = new TextCls(content, style);
  text.anchor?.set?.(1, 0);
  return text;
}

/** The badge label for a vehicle token, or "" when nobody is aboard (no clutter on empty cars). */
export function badgeLabelFor(tokenDoc) {
  const actor = tokenDoc?.actor;
  if (!actor) return "";
  const { count, capacity } = occupancyOf(actor, tokenDoc.parent);
  if (count <= 0) return "";
  return capacity > 0
    ? localizeParam("Vehicle.OccupancyBadge", { count, cap: capacity })
    : localizeParam("Vehicle.OccupancyBadgeNoCap", { count });
}

/** Draw / update / remove the badge on one vehicle placeable. */
function _syncBadge(placeable) {
  if (!_isLive(placeable) || !placeable.document) return;
  const label = badgeLabelFor(placeable.document);
  let badge = placeable.cpOccupancyBadge;
  if (!label) {
    if (badge && !badge.destroyed) { badge.removeFromParent?.(); badge.destroy(); }
    placeable.cpOccupancyBadge = null;
    return;
  }
  if (!badge || badge.destroyed || badge.parent !== placeable) {
    badge = _badgeText(label);
    placeable.addChild(badge);
    placeable.cpOccupancyBadge = badge;
  } else if (badge.text !== label) {
    badge.text = label;
  }
  const grid = placeable.document.parent?.grid?.size ?? canvas?.grid?.size ?? 100;
  badge.position.set(placeable.document.width * grid - 4, 2);
}

/** Redraw the badges of every vehicle carrying this actor's riders. */
function _syncBadgesForVehicle(vehicleActorId) {
  for (const p of canvas?.tokens?.placeables ?? []) {
    if (p.document?.actorId === vehicleActorId) _syncBadge(p);
  }
}

/**
 * Canvas-side registration: keep the badge current and the fade sticky. Both are per-client
 * rendering concerns, so everything here reacts to draw/refresh rather than writing anything.
 */
export function registerVehicleOccupancyHooks() {
  const isVehicle = (doc) => doc?.actor?.type === `${SCOPE}.vehicle` || doc?.flags?.[SCOPE]?.vehicleHandle === true;

  Hooks.on("drawToken", (placeable) => {
    if (isVehicle(placeable.document)) _syncBadge(placeable);
    else _applyFade(placeable);
  });

  Hooks.on("refreshToken", (placeable) => {
    if (isVehicle(placeable.document)) _syncBadge(placeable);
    else _applyFade(placeable);
  });

  // A rider boarding or stepping out changes a badge on a DIFFERENT token than the one updated.
  Hooks.on("updateToken", (doc, change) => {
    const flagChange = change?.flags?.[SCOPE] ?? {};
    if (!("boardedVehicle" in flagChange) && !("-=boardedVehicle" in flagChange)) return;
    const vehicleId = doc.flags?.[SCOPE]?.boardedVehicle;
    if (vehicleId) _syncBadgesForVehicle(vehicleId);
    // The vehicle just left is no longer named on the token — refresh every vehicle's badge.
    for (const p of canvas?.tokens?.placeables ?? []) if (isVehicle(p.document)) _syncBadge(p);
  });

  Hooks.on("deleteToken", (doc) => {
    const vehicleId = doc.flags?.[SCOPE]?.boardedVehicle;
    if (vehicleId) _syncBadgesForVehicle(vehicleId);
  });
}
