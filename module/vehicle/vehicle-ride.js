/**
 * vehicle-ride.js — a rider is DRAWN where the vehicle is, on every frame the vehicle is drawn.
 *
 * THE REPORT THIS ANSWERS (walk, 2026-08-18): "on a sudden stop or a sharp turn the crew get thrown
 * off the car, then re-seated a moment later." Nobody was thrown. Each rider is its own token, moved
 * by its own document update, which is sent after the vehicle's has already gone out and then plays
 * its own animation at its own pace; a turn was worse still, because the crew's re-seat deliberately
 * waits out the turning gesture before it writes anything at all. Two tokens animating independently
 * toward related destinations is exactly the picture of one shaking loose from the other.
 *
 * THE FIX IS PRESENTATION, NOT BOOKKEEPING. The documents still change exactly once per move, in
 * vehicle-canvas.js. What is added here is that between the frame the vehicle starts moving on
 * screen and the frame it arrives, each rider is DRAWN at the seat it would occupy for the pose the
 * vehicle is drawn at THAT frame. Nothing is written, nothing is sent, and every client runs it for
 * its own view — which is also why two GMs watching the same car cannot fight over it.
 *
 * WHY THE HAND-OFF IS INVISIBLE: the drawn seat and the committed seat come out of the same
 * function (`riderSeatAt`). When the animation ends, the pose the vehicle is drawn at IS the pose
 * its document is stored at, so the last frame this file draws and the position the rider's document
 * was committed to are the same pixel.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH: a token somebody has hold of. A rider being dragged, and the
 * ghost preview core draws under a drag, are both left alone — the coupling is not allowed to pull a
 * token out from under a hand. Same for a vehicle preview: while the car is still being dragged
 * nothing has moved yet, so the crew stay where they are and follow when the drop animates.
 */

import { drawnPoseOf, storedPoseOf, riderSeatAt, seatOrderAt, ridersOf } from "./vehicle-canvas.js";

const SCOPE = "cp2020-augmented";

/**
 * True while a placeable is still a live display object. Draw/refresh hooks also fire while the
 * canvas is tearing a token down, and touching a destroyed PIXI object throws from inside the
 * engine — the same guard the occupancy badge and the footprint outline carry, for the same reason.
 */
function _isLive(placeable) {
  return !!placeable && placeable.destroyed !== true && !!placeable.transform;
}

function _isVehicle(doc) {
  return doc?.actor?.type === `${SCOPE}.vehicle` || doc?.flags?.[SCOPE]?.vehicleHandle === true;
}

/**
 * Is somebody holding this token right now? A drag preview counts (the core draws the ghost as its
 * own placeable), and so does the real token from the moment the pointer grabs it — GRABBED rather
 * than the core's stricter `isDragging`, because a token somebody has already taken hold of should
 * not be pulled out from under them the instant the car starts moving. Either way it is not ours
 * to place.
 */
function _isBeingHandled(placeable) {
  if (!placeable) return false;
  if (placeable.isPreview === true) return true;
  const mim = placeable.mouseInteractionManager;
  const states = mim?.states
    ?? foundry?.canvas?.interaction?.MouseInteractionManager?.INTERACTION_STATES
    ?? globalThis.MouseInteractionManager?.INTERACTION_STATES;
  if (!states || !Number.isFinite(mim?.state)) return false;
  return mim.state >= states.GRABBED;
}

/**
 * Draw one rider at a pixel position: the placeable itself (frame, bars, nameplate, badges) and the
 * art mesh, which lives in the primary canvas group and is positioned from the token's centre — the
 * same two writes the core's own `_refreshPosition` makes. Nothing else is touched, and no render
 * flag is raised, so this cannot start a refresh of its own.
 */
function _drawRiderAt(placeable, x, y) {
  if (!_isLive(placeable)) return;
  placeable.position.set(x, y);
  const mesh = placeable.mesh;
  if (mesh && mesh.destroyed !== true) {
    mesh.position.set(x + (Number(placeable.w) || 0) / 2, y + (Number(placeable.h) || 0) / 2);
  }
}

/** Has a vehicle's drawn pose moved on from the one we last drew its crew for? */
function _poseChanged(a, b) {
  if (!a || !b) return true;
  return a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h || a.rotation !== b.rotation;
}

/** Is a vehicle mid-move — drawn somewhere its document has not agreed to yet? */
function _isInFlight(handleDoc) {
  return _poseChanged(drawnPoseOf(handleDoc), storedPoseOf(handleDoc));
}

/**
 * Draw every rider of one vehicle at the pose that vehicle is drawn at right now.
 *
 * Cheap when nothing is moving: the pose a vehicle is drawn at only changes while it is being
 * animated, so a refresh that repeats the pose we last drew for returns before it reads a single
 * rider. A parked car costs one object comparison per refresh.
 */
function _syncRiders(vehiclePlaceable) {
  if (!_isLive(vehiclePlaceable) || !vehiclePlaceable.document) return;
  if (vehiclePlaceable.isPreview === true) return;          // a drag ghost has not moved anything
  const doc = vehiclePlaceable.document;
  const scene = doc.parent;
  const actor = doc.actor;
  if (!scene || !actor) return;

  const pose = drawnPoseOf(doc);
  if (!_poseChanged(pose, vehiclePlaceable.cpRidePose)) return;
  vehiclePlaceable.cpRidePose = pose;

  const grid = scene.grid?.size ?? canvas?.grid?.size ?? 100;
  const order = seatOrderAt(actor, pose);
  for (const { doc: riderDoc, seatIndex } of ridersOf(scene, doc.actorId)) {
    const rider = canvas?.tokens?.get(riderDoc.id);
    if (!_isLive(rider) || _isBeingHandled(rider)) continue;
    const seat = riderSeatAt(pose, grid, seatIndex, { w: riderDoc.width, h: riderDoc.height }, order);
    _drawRiderAt(rider, seat.x, seat.y);
  }
}

/** The drawn vehicle a rider is aboard, or null when it is on another scene or not drawn yet. */
function _vehicleOf(riderDoc) {
  const id = riderDoc?.flags?.[SCOPE]?.boardedVehicle;
  if (!id) return null;
  for (const p of canvas?.tokens?.placeables ?? []) {
    if (p.document?.actorId === id && _isVehicle(p.document)) return p;
  }
  return null;
}

/**
 * Re-apply the coupling from the RIDER's own refresh. A rider redraws itself at its DOCUMENT
 * position, which mid-flight is where it is going rather than where the car currently is — so its
 * own refresh would undo the frame we just drew. This is the same shape the occupant fade uses: a
 * bare assignment is wiped by the next refresh, so it is re-applied from the refresh itself.
 *
 * Only while the vehicle is actually in flight. Once it has arrived, the drawn pose is the stored
 * pose and the rider's document already answers with the seat, so there is nothing to correct.
 */
function _restickRider(riderPlaceable) {
  const riderDoc = riderPlaceable?.document;
  const seatIndex = Number(riderDoc?.flags?.[SCOPE]?.seatIndex);
  if (!Number.isInteger(seatIndex) || seatIndex < 0) return;
  if (_isBeingHandled(riderPlaceable)) return;
  const vehicle = _vehicleOf(riderDoc);
  if (!_isLive(vehicle) || !_isInFlight(vehicle.document)) return;

  const scene = vehicle.document.parent;
  const grid = scene?.grid?.size ?? canvas?.grid?.size ?? 100;
  const pose = drawnPoseOf(vehicle.document);
  const seat = riderSeatAt(pose, grid, seatIndex,
    { w: riderDoc.width, h: riderDoc.height }, seatOrderAt(vehicle.document.actor, pose));
  _drawRiderAt(riderPlaceable, seat.x, seat.y);
}

/**
 * Canvas-side registration. Both hooks, for the reason the badge and the outline need both: `draw`
 * is a token's first appearance and `refresh` is every frame of every move afterwards.
 */
export function registerVehicleRideHooks() {
  Hooks.on("drawToken", (placeable) => {
    if (_isVehicle(placeable?.document)) _syncRiders(placeable);
  });

  Hooks.on("refreshToken", (placeable) => {
    if (_isVehicle(placeable?.document)) _syncRiders(placeable);
    else _restickRider(placeable);
  });
}
