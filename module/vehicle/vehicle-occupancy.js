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
import { hullDimsOf } from "./vehicle-layout.js";
import { riderIsAboardToken, riderVehicleTokenIdOn } from "./vehicle-canvas.js";

const SCOPE = "cp2020-augmented";
const FADE_ALPHA = 0.25;

/* --------------------------------------------------------------- queries */

/**
 * Token documents currently riding a vehicle on this scene.
 *
 * @param {Scene} scene
 * @param {string} vehicleActorId
 * @param {TokenDocument|null} [vehicleTokenDoc]  narrow to ONE handle. The BADGE passes it: a count
 *   floating over a truck has to be the people in THAT truck, not the total across every copy of it
 *   on the canvas. The sheet's list and the cross-scene total deliberately do not — those questions
 *   are about the machine.
 */
export function occupantTokens(scene, vehicleActorId, vehicleTokenDoc = null) {
  if (!scene || !vehicleActorId) return [];
  return (scene.tokens ?? []).filter(t =>
    t.flags?.[SCOPE]?.boardedVehicle === vehicleActorId
    && (!vehicleTokenDoc || riderIsAboardToken(t, vehicleTokenDoc)));
}

/** Seats the vehicle claims to have: crew + passengers (0 = unstated, not "no room"). */
export function vehicleCapacity(actor) {
  return (Number(actor?.system?.crewSlots) || 0) + (Number(actor?.system?.passengerSlots) || 0);
}

/**
 * Occupancy of a vehicle actor across the scene it is on (defaults to the active/viewed scene).
 * @returns {{count:number, capacity:number, over:boolean, occupants:object[]}}
 */
export function occupancyOf(vehicleActor, scene = null, vehicleTokenDoc = null) {
  const sc = scene ?? canvas?.scene ?? game?.scenes?.active ?? null;
  const occupants = occupantTokens(sc, vehicleActor?.id, vehicleTokenDoc);
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
 * EVERY place this actor is currently sitting in a vehicle — one entry per ABOARD TOKEN.
 *
 * ⭐ TOKEN-SCOPED, and it has to be (field report 2026-08-25). An actor with two tokens can be
 * aboard on one scene and standing on the pavement on another; "is this actor aboard" has no
 * single answer, and answering it actor-wide is what let a character sheet opened on the second
 * scene offer a Step Out control with nothing on screen to step out of. Each entry names the
 * token, its scene and the HANDLE it is in, so a caller can say WHERE it would act.
 *
 * @returns {{vehicle:Actor, tokenDoc:object, scene:object, handle:object|null}[]}
 */
export function aboardPlacesFor(actor) {
  const out = [];
  if (!actor?.id) return out;
  for (const scene of game.scenes ?? []) {
    for (const t of scene.tokens ?? []) {
      if (t.actorId !== actor.id) continue;
      const vehicleId = t.flags?.[SCOPE]?.boardedVehicle;
      if (!vehicleId) continue;
      const vehicle = game.actors?.get(vehicleId);
      if (!vehicle) continue;
      const handleId = riderVehicleTokenIdOn(scene, t);
      out.push({ vehicle, tokenDoc: t, scene, handle: handleId ? (scene.tokens.get(handleId) ?? null) : null });
    }
  }
  return out;
}

/**
 * The vehicle an ACTOR is aboard, found from any of its tokens on any scene — the character sheet
 * has no token of its own to ask, and the sidebar must answer the same question a token would.
 *
 * Deliberately still cross-scene: the sidebar sheet is the one surface a passenger can always
 * reach, and a rider parked on a scene nobody is looking at is still a rider. What CHANGED is that
 * the answer names one specific aboard token — see `aboardPlacesFor` — so the caller can say which
 * vehicle on which scene it is talking about instead of implying "here".
 *
 * @returns {{vehicle:Actor, tokenDoc:object, scene:object, handle:object|null}|null}
 */
export function aboardVehicleFor(actor) {
  return aboardPlacesFor(actor)[0] ?? null;
}

/* --------------------------------------------------------------- client-local occupant fade */

/**
 * Vehicle HANDLE TOKEN ids whose riders this client is currently dimming. Never persisted.
 *
 * Token ids, not actor ids: the control lives on one truck's HUD, so fading it must dim the people
 * in THAT truck. Keyed by actor it also dimmed the crew of every other copy of the same vehicle on
 * the canvas — a control pressed on one token silently changing another.
 */
const _faded = new Set();

export function isVehicleFaded(vehicleTokenId) {
  return _faded.has(vehicleTokenId);
}

/**
 * True while a placeable is still a live display object. Draw/refresh hooks also fire while the
 * canvas is tearing a token down (scene change, token deleted), and touching a destroyed PIXI
 * object throws from inside the engine — rig-caught as a `_parentID` error on scene teardown.
 */
function _isLive(placeable) {
  return !!placeable && placeable.destroyed !== true && !!placeable.transform;
}

/** Apply (or clear) the dim on one placeable, from the HANDLE its own boarding flag resolves to. */
function _applyFade(placeable) {
  if (!_isLive(placeable)) return;
  const doc = placeable?.document;
  if (!doc?.flags?.[SCOPE]?.boardedVehicle) return;
  const handleId = riderVehicleTokenIdOn(doc.parent, doc);
  if (!handleId) return;
  const alpha = _faded.has(handleId) ? FADE_ALPHA : 1;
  placeable.alpha = alpha;
  if (placeable.mesh) placeable.mesh.alpha = alpha;
}

/** Re-apply the dim across the riders of one handle (after a toggle). */
function _refreshFadedTokens(vehicleTokenId) {
  const scene = canvas?.scene ?? null;
  const handle = scene?.tokens?.get?.(vehicleTokenId) ?? null;
  for (const p of canvas?.tokens?.placeables ?? []) {
    if (!p.document?.flags?.[SCOPE]?.boardedVehicle) continue;
    if (handle && !riderIsAboardToken(p.document, handle)) continue;
    _applyFade(p);
  }
}

/**
 * Toggle this client's dimming of one HANDLE's occupants.
 * @param {string} vehicleTokenId  the vehicle token whose HUD the control was pressed on
 * @returns {boolean} the new state (true = dimmed)
 */
export function toggleOccupantFade(vehicleTokenId) {
  if (!vehicleTokenId) return false;
  if (_faded.has(vehicleTokenId)) _faded.delete(vehicleTokenId);
  else _faded.add(vehicleTokenId);
  _refreshFadedTokens(vehicleTokenId);
  return _faded.has(vehicleTokenId);
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

/**
 * The badge label for a vehicle token, or "" when nobody is aboard (no clutter on empty cars).
 *
 * ⛔ PER TOKEN. Two copies of one vehicle on a canvas used to wear the same count — the total of
 * both — so an empty truck parked beside a full one claimed a full load. The count is now the
 * people in THIS truck.
 */
export function badgeLabelFor(tokenDoc) {
  const actor = tokenDoc?.actor;
  if (!actor) return "";
  const { count, capacity } = occupancyOf(actor, tokenDoc.parent, tokenDoc);
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
  // The badge sits on the HULL's top-right corner, not the carrying square's — on a 2-across car in
  // a 4-square frame those are a whole square apart, and a count floating in empty tarmac beside the
  // car reads as belonging to nothing. Measured un-rotated, like every other token badge: it stays
  // upright and legible rather than swinging round with the bodywork.
  const doc = placeable.document;
  const hull = hullDimsOf(doc.actor?.system, Number(doc.width), Number(doc.height));
  const inset = ((Number(doc.width) || 1) - hull.w) / 2;
  const drop = ((Number(doc.height) || 1) - hull.h) / 2;
  badge.position.set((inset + hull.w) * grid - 4, drop * grid + 2);
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
