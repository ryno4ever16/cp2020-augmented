/**
 * vehicle-ride-lock.js — while a token is aboard a vehicle, the vehicle owns where it is.
 *
 * Three parts, one fact. The LOCK refuses a hand-move that would contradict the coupling. The
 * SELECTION RULE keeps a rubber-band from picking up the crew along with the car, so the refusal
 * is not provoked by a gesture that was never aimed at them. The NOTICE RULE decides how loud a
 * refusal is: one gesture gets one message, and none at all when the car is moving too.
 *
 * THE REPORT THIS ANSWERS (user, 2026-08-19): "even though moving the token snaps it back
 * perfectly, you shouldn't be able to move the token at all while in the vehicle."
 *
 * WHAT USED TO HAPPEN. A rider dragged off the bodywork was a perfectly ordinary token move: the
 * document was written to wherever the pointer let go, the seat-adopter in vehicle-canvas.js then
 * found no seat under that drop and wrote the rider back to the seat its flag still named. Two
 * writes, and the second one visibly undoing the first — which is the "snaps it back" the report
 * describes. The end state was always right; the gesture was allowed to happen first.
 *
 * WHAT HAPPENS NOW. The move is REFUSED at the source instead. `preUpdateToken` fires only on the
 * client that started the change and returning false there cancels it before anything is sent, so
 * no document is written, nothing is undone, and the toast says why. That is the same shape the
 * combat movement gate (module/combat/movement-gate.js) uses for the once-per-turn rule, and the
 * same shape of thing a Foundry user already meets when a move is not allowed.
 *
 * ⭐ THE IN-HULL HALF OF THE SAME REPORT (user ruling, 2026-08-20: *"refuse too"*). The rule above
 * measured only whether the drop was ON the bodywork, so a rider dragged onto an ENGINE square — or
 * any painted square that is not a seat — was still an ordinary move: written, then found by
 * `adoptDraggedSeat` to be on no seat, then written back to the seat the rider's flag still named.
 * That is the same two-write land-then-return the off-hull case used to do, one square further in,
 * and it reads to the table as the same defect. A drop that is not on a seat is now refused wherever
 * it is, so the lock's question is "did this land on a SEAT" rather than "did this land on the CAR".
 *
 * ⚠ THE SEAT TEST IS THE ADOPTER'S OWN TEST, not a second opinion about the same squares: the
 * nearest seat position within half a grid square (`vehicle-canvas.js` adoptDraggedSeat). Asking the
 * question the same way is what guarantees the lock never refuses a drop the adopter would have
 * taken — a rule written independently would drift out of agreement the first time either moved.
 *
 * WHAT IS DELIBERATELY STILL ALLOWED — four exemptions, and each one is a real gesture somebody
 * needs:
 *   1. A drop that lands on a SEAT is the SEAT-CHANGE gesture (USER-GUIDE §4) and is passed
 *      straight through to `adoptDraggedSeat`. That includes a seat somebody else already holds:
 *      the square IS a seat, the drop is a legitimate attempt at it, and the adopter's own
 *      already-taken rule returns the rider to their own seat. That is the one land-then-return
 *      still reachable by hand, and it is a refusal of the SEAT rather than of the gesture.
 *   2. Every move the MODULE makes to a rider — the crew-follow commit, the re-seat after a
 *      footprint or heading edit, boarding, stepping out — is marked `cp2020VehicleSync` on the
 *      update options and exempted by that mark. It is the flag the crew-follow hook already used
 *      to know its own writes, extended to boarding and step-out so there is ONE answer to "did we
 *      do this" rather than two competing ones.
 *   3. An update that CLEARS the aboard flag is somebody leaving, whoever wrote it. Belt and
 *      braces beside the mark above, so a future path that steps a rider out cannot be locked in
 *      by forgetting to carry it.
 *   4. A rider whose vehicle is not on the scene has no hull to be inside, and is left alone
 *      rather than frozen where it stands.
 *
 * ⛔ THERE IS NO GAMEMASTER EXEMPTION (user, 2026-08-19: "you shouldn't be able to move the token
 * at all"). A GM who wants somebody out of a car uses the token HUD's step-out control, which is
 * exemption 2 and always available to them.
 *
 * ⚠ MEMBERSHIP IS READ FROM THE TOKEN DOCUMENT'S OWN FLAGS, never from its actor. Unlinked copies
 * of one actor share an actor id, so anything that asked the actor "are you aboard" would answer
 * for every copy of that person on the map at once; the aboard flag and the seat index have always
 * lived on the token, and this file reads them there.
 */

import { hullRectIn, pointInRotatedRect } from "./vehicle-layout.js";
import { isVehicleTokenDoc, riderSeatAt, seatOrderAt, storedPoseOf, vehicleTokenFor, riderVehicleTokenIdOn, riderIsAboardToken } from "./vehicle-canvas.js";
import { localizeParam } from "../utils.js";

const SCOPE = "cp2020-augmented";

/**
 * Marks the one update operation a refusal has already spoken for. A drag moves every selected
 * token in a SINGLE database operation, and every document in that operation is handed the SAME
 * options object, so a property written on it is read by the rest of the batch — which makes it an
 * exact "this gesture has had its message" latch, with no timer and no guessed window.
 */
const ANNOUNCED = "cp2020RideLockAnnounced";

/**
 * Pure decision: should this token move be refused? Every input is a plain value, so the rule can
 * be read as a table and checked without a running world — the same shape as
 * `shouldBlockMovement` in module/combat/movement-gate.js.
 *
 * @param {object}  o
 * @param {boolean} o.aboard             the token is flagged as riding a vehicle
 * @param {boolean} o.isPositionChange   the update actually moves it (x or y changed)
 * @param {boolean} o.moduleMove         the module made this move (crew-follow, board, step-out)
 * @param {boolean} o.leavesVehicle      this same update clears the aboard flag
 * @param {boolean} o.hullKnown          the vehicle's handle is on this scene, so a hull can be measured
 * @param {boolean} o.destinationInHull  the destination lies on the vehicle's hull
 * @param {boolean} o.destinationIsSeat  the destination is close enough to a seat for the adopter to
 *                                       take it (the adopter's own half-square tolerance). Defaults
 *                                       true, so a caller that cannot measure the seats gets the
 *                                       pre-ruling behaviour rather than a refusal it cannot explain.
 * @returns {boolean} true → cancel the move
 */
export function shouldRefuseRiderMove({
  aboard, isPositionChange, moduleMove, leavesVehicle, hullKnown, destinationInHull,
  destinationIsSeat = true,
}) {
  if (!aboard) return false;             // an ordinary token: never ours to stop
  if (!isPositionChange) return false;   // elevation, name, a flag on its own — not a move
  if (moduleMove) return false;          // the module put them there
  if (leavesVehicle) return false;       // the same update takes them out of the vehicle
  if (!hullKnown) return false;          // no vehicle on this scene to be inside of
  if (!destinationInHull) return true;   // off the bodywork entirely
  return !destinationIsSeat;             // on the car but not on a seat (engine rank, bare bodywork)
}

/**
 * Pure decision: should this rider be dropped out of a selection? The rule is about what was
 * GRABBED, not about who may be selected — a rider picked out on its own stays picked, because
 * opening a sheet, targeting and rolling all start with selecting the person.
 *
 * @param {object}  o
 * @param {boolean} o.aboard          the token is flagged as riding a vehicle
 * @param {boolean} o.vehicleGrabbed  that same vehicle's handle is in the selection too
 * @returns {boolean} true → take the rider back out of the selection
 */
export function shouldDropFromGrab({ aboard, vehicleGrabbed }) {
  return !!aboard && !!vehicleGrabbed;
}

/**
 * Pure decision: should a refusal be SAID OUT LOUD? The refusal itself is settled by
 * `shouldRefuseRiderMove`; this only decides whether the reader is told about this one.
 *
 * @param {object}  o
 * @param {boolean} o.vehicleMovesToo      the vehicle is in the same selection, so it is moving too
 * @param {boolean} o.alreadyAnnounced     this same operation has already raised a message
 * @returns {boolean} true → raise the message
 */
export function shouldAnnounceRefusal({ vehicleMovesToo, alreadyAnnounced }) {
  // The car is going where the reader dragged it and the coupling puts the crew in their seats
  // when it arrives, so nothing has gone wrong for them to be told about.
  if (vehicleMovesToo) return false;
  // Otherwise once per gesture, however many riders it swept up: five people refused is one
  // refusal, and five stacked messages saying the same sentence is the noise being fixed here.
  return !alreadyAnnounced;
}

/**
 * Does this update clear the aboard flag? Checked in both the flat dot-key form an update is
 * written in and the expanded form a hook may be handed, and for both deletion spellings the core
 * has used (`ForcedDeletion` on v14, the `-=` prefix before it) — `deleteFieldUpdate` in utils.js
 * picks whichever the running core provides, so this has to recognise either.
 */
function _leavesVehicle(changes) {
  const path = `flags.${SCOPE}.boardedVehicle`;
  const flat = changes ?? {};
  if (`flags.${SCOPE}.-=boardedVehicle` in flat) return true;
  if (flat[`flags.${SCOPE}`]?.["-=boardedVehicle"] !== undefined) return true;
  const stated = (path in flat)
    ? flat[path]
    : foundry.utils.getProperty(flat, path);
  if (stated === undefined) return false;
  // A string is somebody boarding a DIFFERENT vehicle, which is a move onto that one, not a
  // departure. Anything else — null, or a deletion operator instance — is a departure.
  return typeof stated !== "string";
}

/**
 * The plain values `shouldRefuseRiderMove` needs, read off the live documents. Impure by design and
 * kept apart from the rule above for the same reason the rest of the vehicle layer is split that
 * way: the arithmetic can be checked on its own.
 */
export function riderMoveContext(tokenDoc, changes, options) {
  const aboardId = tokenDoc?.flags?.[SCOPE]?.boardedVehicle ?? null;
  const isPositionChange = changes?.x !== undefined || changes?.y !== undefined;
  const ctx = {
    aboard: !!aboardId,
    isPositionChange,
    moduleMove: options?.cp2020VehicleSync === true,
    leavesVehicle: _leavesVehicle(changes),
    hullKnown: false,
    destinationInHull: false,
    // True until a seat layout can actually be read and says otherwise — see the rule's own note.
    destinationIsSeat: true,
    vehicleControlled: false,
    vehicleName: "",
  };
  if (!ctx.aboard || !isPositionChange) return ctx;

  const scene = tokenDoc.parent;
  // The hull a rider must stay on is the hull of the handle they are IN. Resolved by the rider's own
  // record so two copies of one vehicle cannot each claim the drop (field report 2026-08-25).
  const handleId = scene ? riderVehicleTokenIdOn(scene, tokenDoc) : null;
  const handle = (handleId ? scene.tokens.get(handleId) : null)
    ?? (scene ? vehicleTokenFor(scene, aboardId) : null);
  if (!handle) return ctx;
  ctx.hullKnown = true;
  ctx.vehicleName = handle.name ?? handle.actor?.name ?? "";
  // Is the vehicle in the same selection? Every gesture that moves tokens — a drag or the arrow
  // keys — moves the whole selection, so a selected vehicle is a MOVING vehicle, and this rider's
  // own move is the redundant half of a gesture that is going to seat them anyway.
  ctx.vehicleControlled = canvas?.tokens?.get(handle.id)?.controlled === true;

  // The vehicle's STORED pose, never the prepared one: a rider dropped while the car is still
  // animating would otherwise be measured against a hull that is part of the way somewhere else.
  const grid = scene.grid?.size ?? canvas?.grid?.size ?? 100;
  const pose = storedPoseOf(handle);
  const rect = hullRectIn(
    { x: pose.x, y: pose.y, w: pose.w * grid, h: pose.h * grid }, pose.hull, grid);
  const src = tokenDoc._source ?? tokenDoc;
  const nx = changes.x ?? src.x;
  const ny = changes.y ?? src.y;
  // The rider's CENTRE is what has to be on the bodywork — the same point the boarding reach and
  // the seat arithmetic answer for, so a drop the seat-adopter would accept is never refused here.
  const centre = {
    x: nx + ((Number(tokenDoc.width) || 1) * grid) / 2,
    y: ny + ((Number(tokenDoc.height) || 1) * grid) / 2,
  };
  ctx.destinationInHull = pointInRotatedRect(centre, rect, pose.rotation);
  // Which SQUARE it landed on is only asked once the drop is on the car at all — off the bodywork the
  // answer is already settled and the seat arithmetic would be wasted work on every rejected drag.
  if (ctx.destinationInHull) ctx.destinationIsSeat = _dropLandsOnSeat(handle, pose, grid, tokenDoc, nx, ny);
  return ctx;
}

/**
 * Would the seat adopter TAKE this drop? The adopter's own question, asked with the adopter's own
 * numbers: the seat positions `seatOrderAt`/`riderSeatAt` compute for this pose, and the half-square
 * tolerance a hand-drag needs (`adoptDraggedSeat` in vehicle-canvas.js).
 *
 * Compared against the drop's TOP-LEFT rather than its centre because that is the coordinate the
 * adopter compares — seat positions are themselves top-left corners for a rider of this size — and a
 * lock measured against a different point than the adopter would start refusing drops the adopter
 * would have accepted.
 *
 * A vehicle whose seats cannot be read (no actor, a layout that throws) answers TRUE: unreadable is
 * not the same as "not a seat", and the same reasoning governs the caller's try/catch — a lock that
 * cannot measure lets the move through, which is what every token did before this file existed.
 */
function _dropLandsOnSeat(handle, pose, grid, riderDoc, nx, ny) {
  const actor = handle?.actor;
  if (!actor) return true;
  const order = seatOrderAt(actor, pose);
  if (!order?.length) return true;
  const size = { w: riderDoc.width, h: riderDoc.height };
  for (let i = 0; i < order.length; i++) {
    const seat = riderSeatAt(pose, grid, i, size, order);
    if (Math.hypot(seat.x - nx, seat.y - ny) <= grid / 2) return true;
  }
  return false;
}

/* ------------------------------------------------------ a band grab takes the car, not the crew */

/**
 * Was the gesture that is selecting things a rubber-band?
 *
 * WHY IT IS READ FROM A POINTER *MOVE*. The core marks its selection rectangle `active` for the
 * length of the gesture and clears that mark as the FIRST act of the drop handler that then sweeps
 * the rectangle — so by the time a token is controlled the evidence is already gone. It is gone for
 * every pointer-up listener too: the board handles that event ahead of anything this module can
 * add, capture phase and window included (measured on the rig — `controlToken` and every pointer-up
 * listener alike read the mark as false, while the last pointer MOVE of the same gesture read it as
 * true). So the mark is taken on the way past, from the moves, where it is still set. One boolean
 * read per move, no DOM access. Both v13 and v14 keep the mark in the same place; a core that does
 * not is simply read as "not a band", and selection behaves as it always did.
 */
let _bandGrab = false;

/** One prune per band grab, however many riders the band swept up. */
let _prunePending = false;

/**
 * Take every rider back out of the selection whose vehicle is in it. Read from the control set
 * rather than from the rectangle, so a rider added to a grab the car was already in is treated the
 * same as one the band swept up with it — the question is only ever "did the car come too".
 */
function _dropRidersOfGrabbedVehicles() {
  const controlled = canvas?.tokens?.controlled ?? [];
  if (controlled.length < 2) return;
  // The grabbed HANDLES, not the grabbed vehicle actors: a rider is released because the truck they
  // are sitting in came along, and the identical truck parked across the street coming along is not
  // the same fact.
  const grabbed = [];
  for (const p of controlled) {
    if (isVehicleTokenDoc(p.document)) grabbed.push(p.document);
  }
  if (!grabbed.length) return;
  for (const p of [...controlled]) {
    const aboard = p.document?.flags?.[SCOPE]?.boardedVehicle ?? null;
    const vehicleGrabbed = !!aboard && grabbed.some(h => riderIsAboardToken(p.document, h));
    if (shouldDropFromGrab({ aboard: !!aboard, vehicleGrabbed })) {
      p.release();
    }
  }
}

/**
 * Register the ride lock. Wired from `registerVehicleRideHooks` in vehicle-ride.js — the other half
 * of the same fact, that a rider's position belongs to the vehicle it is aboard.
 */
export function registerVehicleRideLock() {
  Hooks.on("preUpdateToken", (tokenDoc, changes, options) => {
    let ctx;
    try {
      ctx = riderMoveContext(tokenDoc, changes, options);
    } catch (e) {
      // A lock that throws must not become a lock on everything: an unreadable pose lets the move
      // through, which is the behaviour every token had before this file existed.
      console.warn(`${SCOPE} | ride lock could not read the move`, e);
      return;
    }
    if (!shouldRefuseRiderMove(ctx)) return;
    const announce = shouldAnnounceRefusal({
      vehicleMovesToo: ctx.vehicleControlled,
      alreadyAnnounced: options?.[ANNOUNCED] === true,
    });
    if (announce) {
      if (options) options[ANNOUNCED] = true;
      ui.notifications?.warn?.(localizeParam("Vehicle.RiderMoveLocked", {
        name: tokenDoc.name ?? "", vehicle: ctx.vehicleName,
      }));
    }
    return false;   // cancel the move on the initiating client, before anything is written
  });

  // The band-grab mark, taken off the core's own selection rectangle while it is still set (see
  // `_bandGrab`). Moving the pointer without a band under way clears it, so the click that reaches
  // a token — which is always preceded by moving onto that token — can never be read as a band.
  document.addEventListener("pointermove", () => {
    _bandGrab = canvas?.controls?.select?.active === true;
  }, true);

  // `controlToken` fires once per token the sweep takes, in whatever order the layer holds them,
  // so no single one of them can answer "did the car come too". The answer is deferred to a timer,
  // which runs after the whole sweep — and after the pointer event carrying it — with the
  // selection final.
  Hooks.on("controlToken", (placeable, controlled) => {
    if (!controlled || !_bandGrab || _prunePending) return;
    if (!placeable?.document?.flags?.[SCOPE]?.boardedVehicle) return;
    _prunePending = true;
    setTimeout(() => {
      _prunePending = false;
      _bandGrab = false;
      try {
        _dropRidersOfGrabbedVehicles();
      } catch (e) {
        // A selection that cannot be pruned is left exactly as the core made it — the crew are
        // then merely selected, which is where this started, not broken.
        console.warn(`${SCOPE} | ride lock could not prune the selection`, e);
      }
    }, 0);
  });
}
