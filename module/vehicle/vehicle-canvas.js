/**
 * Vehicle canvas representation (Phase 2, corrected).
 *
 * A vehicle is a single **visible Token** showing the vehicle's image, sized to its footprint
 * (the art scales to the box — `texture.fit:"contain"`; resize the token to fit any image). It is
 * the natural movable/selectable/targetable object, and it is AoE-detected like any token. A low
 * `sort` makes crew tokens render on top of it. Crew flagged as "boarded" ride along when the
 * vehicle moves.
 *
 *   vehicleToken.flags.cp2020-augmented.vehicleHandle      = true
 *   crewToken.flags.cp2020-augmented.boardedVehicle       = <vehicleActorId>
 *   crewToken.flags.cp2020-augmented.boardedVehicleToken  = <vehicleTokenId>   ⭐ see below
 *
 * ⛔ WHICH TOKEN, NOT JUST WHICH VEHICLE (field report 2026-08-25). A rider recorded only the
 * vehicle ACTOR it was aboard. With TWO tokens of the same vehicle actor on one canvas — the
 * reported "Goofy Goobermobile", two 40-Ton trucks — both tokens matched every rider, so the seats
 * belonged to whichever token moved last: driving the EMPTY truck yanked the other truck's crew out
 * of it and into the one being driven. `boardedVehicleToken` is the second half of the answer, and
 * it is what every GEOMETRY question now asks: whose seats are these, which handle do they follow,
 * which badge counts them.
 *
 * The actor flag stays and stays authoritative for every question that is about the MACHINE rather
 * than the drawn copy — cover, the control-roll crew list, the gunnery crew list, the vehicle
 * sheet's passenger list. Those are the same answer for every token of one vehicle, and should be.
 *
 * ADDITIVE, with the neutralization at the READ path (project migration discipline): a rider
 * boarded before this exists carries no token id, so `riderVehicleTokenIdOn` resolves it to the
 * FIRST handle of that vehicle in the scene's own document order — one deterministic answer on
 * every client, and byte-for-byte today's behaviour wherever there is only one handle. No migration
 * pass, no rewrite of anybody's flags.
 */

import { deleteFieldUpdate, localizeParam } from "../utils.js";
import { seatSlotPosition, placeBeside } from "./vehicle-seating.js";
import { layoutFor, hullDimsOf, hasRecordedHull, frameSquareFor, hullRectIn, hullArtScale, DEFAULT_HULL } from "./vehicle-layout.js";
import { isPrimaryGMSession } from "../gm-session-primary.js";

const SCOPE = "cp2020-augmented";
const VEHICLE_SORT = -100;            // render below crew tokens
/**
 * How much of its own size a rider is drawn at while aboard (user ruling: ~60%). This scales the
 * token's ARTWORK (`texture.scaleX/scaleY`), deliberately NOT its `width`/`height`: the document
 * stays one grid square, so the seat keeps a full square of hit area and clicking a seat selects
 * the person sitting in it. The prior scale is stored and restored verbatim on the way out.
 * ⚠ Read the prior value from `_source` — the PREPARED `texture.scaleX` is animated by the core
 * and reads back mid-transition (rig-measured 0.77 while 0.6 was stored).
 *
 * TODO (user, 2026-08-19): riders are "a bit too easy to select" when clicking the vehicle —
 * "we can live with this." Recorded, not acted on. The full square kept here is exactly what makes
 * a seat clickable, so shrinking the hit area to the drawn 60% would trade one complaint for the
 * opposite one; any change here has to be weighed against the vehicle's own hull hitArea in
 * vehicle-outline.js, which the seats sit on top of.
 */
const BOARDED_SCALE = 0.6;
/** How far above the vehicle handle a rider is lifted when its sort would leave it underneath. */
const CREW_SORT_LIFT = 10;
/**
 * The HULL a vehicle gets before anyone sizes it: TWO squares across, FOUR deep. Deep and not wide,
 * because a vehicle's long axis is the axis it travels along and a token at rotation 0 travels
 * SOUTH (vehicle-layout's ROTATION_ZERO_FRONT — the core's own convention, which its drag
 * auto-rotate then acts on). Shipping this the other way round is what made a driven vehicle
 * present its longest face to the direction of travel.
 *
 * ⚠ This is the HULL, not the token's width/height. The token document is given the SQUARE that
 * carries this hull at any angle (`frameSquareFor`) — 4 × 4 for the 2 × 4 default. The name is kept
 * for the callers that import it, and it now points at the layout layer's own constant so the two
 * can never drift into two different shipped shapes.
 */
export const DEFAULT_FOOTPRINT = DEFAULT_HULL;
/**
 * How long the heading has to hold still before riders are re-seated to it. Core's rotation
 * gestures stream one update per scroll notch, so this is what turns "a dozen updates" into "one
 * turn of the wheel". Long enough to ride out a gesture, short enough that a GM who stops turning
 * sees the crew follow immediately.
 */
const ROTATION_SETTLE_MS = 400;
/** token.id → pending re-seat timer, so a continuing gesture keeps pushing the settle out. */
const _rotationSettles = new Map();

/**
 * A token represents a vehicle if its actor is a vehicle (covers tokens dragged from the sidebar
 * like any other actor) or it carries the legacy vehicleHandle flag (tokens placed by an older
 * deploy). Detecting by actor type is what lets a plain drag-to-canvas behave like Deploy did.
 */
export function isVehicleTokenDoc(doc) {
  return doc?.actor?.type === "cp2020-augmented.vehicle" || doc?.flags?.[SCOPE]?.vehicleHandle === true;
}
const _isVehicleToken = isVehicleTokenDoc;

/**
 * Place a vehicle on a scene as a single visible, scalable handle token.
 * Idempotent per (actor, scene): if one already exists it is reused, not stacked.
 * @returns {Promise<{tokenId:string, existing:boolean}|null>}
 */
export async function deployVehicleToScene(actor, opts = {}) {
  const scene = opts.scene ?? canvas?.scene;
  if (!actor || actor.type !== "cp2020-augmented.vehicle" || !scene) return null;

  const existing = scene.tokens.find(t => t.actorId === actor.id && t.flags?.[SCOPE]?.vehicleHandle);
  if (existing) {
    ui.notifications?.info?.(localizeParam("Vehicle.AlreadyOnScene", { name: actor.name }));
    return { tokenId: existing.id, existing: true };
  }

  const gridSize = scene.grid?.size ?? canvas?.grid?.size ?? 100;
  // The HULL comes from the actor (a caller may still state one), and the token's own width/height
  // are the SQUARE that carries it at any angle — see vehicle-layout's hull/frame note.
  const hull = hullDimsOf(actor.system,
    Number(opts.gw) || Number(actor.prototypeToken?.width),
    Number(opts.gh) || Number(actor.prototypeToken?.height));
  const side = frameSquareFor(hull);
  const sidePx = side * gridSize;
  const px = opts.x ?? Math.round(((scene.width ?? 2000) - sidePx) / 2);
  const py = opts.y ?? Math.round(((scene.height ?? 2000) - sidePx) / 2);

  const [tokenDoc] = await scene.createEmbeddedDocuments("Token", [{
    // Link mode follows the actor's prototype token — the user's choice (linked = THE vehicle,
    // unlinked = independent copies), not a hardcoded override. New vehicles seed linked at creation.
    name: actor.name, actorId: actor.id, actorLink: actor.prototypeToken?.actorLink ?? true,
    x: px, y: py, width: side, height: side,
    sort: VEHICLE_SORT,                              // crew tokens render on top
    // Art fits the square, then scales down to the hull — otherwise a car is drawn a square wider
    // than the shape it occupies, hanging outside its own outline.
    texture: { src: actor.img, fit: "contain", scaleX: hullArtScale(hull), scaleY: hullArtScale(hull) },
    flags: { [SCOPE]: { vehicleHandle: true } },
  }]);
  return { tokenId: tokenDoc.id, existing: false };
}

/* ------------------------------------------------------------------ seating helpers */

/**
 * Pixel rectangle of a token document on its scene — its FRAME, deliberately. Used for placement
 * clearance (where to stand a stepped-out rider, what a deploy must not land on), where the frame is
 * the right measure precisely because it is the box core keeps the token in: a spot clear of the
 * square is clear of the hull inside it, so nobody is ever put down under the bodywork.
 */
function tokenRect(doc, gridSize) {
  return { x: doc.x, y: doc.y, w: (doc.width ?? 1) * gridSize, h: (doc.height ?? 1) * gridSize };
}

/**
 * The heading a vehicle is STORED at — read from `_source`, never from the prepared document.
 * ⚠ The core animates rotation the way it animates position and art scale: the prepared value
 * sweeps toward the new angle over the next half second, so anything that reads `doc.rotation`
 * immediately after a turn gets a frame of the way there (rig-measured 29.988 while 37 was
 * stored). Seats and the cover ray must both answer for the angle the GM chose, not for whatever
 * the tween happened to be showing.
 */
export function tokenHeadingOf(doc) {
  const stored = doc?._source?.rotation;
  return Number(Number.isFinite(stored) ? stored : doc?.rotation) || 0;
}

/**
 * The seat order for a deployed vehicle: which footprint cells are seats, in the order riders take
 * them. Derived from the handle's own footprint and the vehicle's Front heading, so both clients
 * and both call sites (boarding, and the re-seat that follows a footprint change) agree without
 * storing anything per rider beyond the seat INDEX they already carry.
 */
export function seatOrderFor(vehicleActor, vehicleTokenDoc) {
  const w = Number(vehicleTokenDoc?.width) || Number(vehicleActor?.prototypeToken?.width) || 1;
  const h = Number(vehicleTokenDoc?.height) || Number(vehicleActor?.prototypeToken?.height) || 1;
  return seatOrderAt(vehicleActor, { w, h, hull: hullDimsOf(vehicleActor?.system, w, h) });
}

/**
 * The seat order for a vehicle at a given pose — the layout layer's answer, in one place.
 *
 * ⚠ It reads the pose's HULL, never its frame. The frame is the square the core carries the vehicle
 * in and has no cells of its own; asking it for a seat order would put the driver a square out into
 * empty tarmac on every vehicle whose hull is narrower than it is deep — which is all of them.
 */
export function seatOrderAt(vehicleActor, pose) {
  const layout = vehicleActor?.system?.layout ?? {};
  const hull = pose?.hull ?? hullDimsOf(vehicleActor?.system, pose?.w, pose?.h);
  return layoutFor(hull.w, hull.h, layout.front, layout.cells).seats;
}

/**
 * The pose a vehicle handle is STORED at — the one every client's documents agree on, and the one a
 * rider's committed seat has to be measured from.
 *
 * ⚠ `_source` throughout, and the reason is not academic. The core animates a moving token by
 * merging each frame's values onto the PREPARED document, so anything that reads `doc.x` while a
 * move is playing gets a frame of the way there rather than the destination. A dragged vehicle was
 * measured leaving its crew 6.6 squares behind for exactly this reason: the follow arithmetic read
 * a position the core was still sweeping.
 */
export function storedPoseOf(handleDoc) {
  const src = handleDoc?._source ?? handleDoc ?? {};
  const w = Math.max(1, Number(src.width ?? handleDoc?.width) || 1);
  const h = Math.max(1, Number(src.height ?? handleDoc?.height) || 1);
  return {
    x: Number(src.x) || 0,
    y: Number(src.y) || 0,
    w, h,
    // The frame is w × h; the HULL travels with the pose so every consumer of a pose answers for the
    // vehicle's real shape without having to fetch the actor again. A vehicle that has not recorded
    // one falls back to the frame, which for those vehicles IS the old rectangle.
    hull: hullDimsOf(handleDoc?.actor?.system, w, h),
    rotation: tokenHeadingOf(handleDoc),
  };
}

/** The pose a vehicle handle is DRAWN at this frame — the prepared values, which the core animates. */
export function drawnPoseOf(handleDoc) {
  const w = Math.max(1, Number(handleDoc?.width) || 1);
  const h = Math.max(1, Number(handleDoc?.height) || 1);
  return {
    x: Number(handleDoc?.x) || 0,
    y: Number(handleDoc?.y) || 0,
    w, h,
    hull: hullDimsOf(handleDoc?.actor?.system, w, h),
    rotation: Number(handleDoc?.rotation) || 0,
  };
}

/**
 * Where rider #seatIndex sits when the vehicle is at `pose`. THE one answer to that question: the
 * document commit below asks it for the stored pose, and the per-frame coupling in vehicle-ride.js
 * asks it for the pose the vehicle is drawn at this frame. Because both ask the same arithmetic,
 * the last frame the coupling draws and the position the document was committed to are the same
 * pixel, and the hand-off at the end of a move is invisible.
 */
export function riderSeatAt(pose, grid, seatIndex, riderSize, order) {
  const g = Math.max(1, Number(grid) || 100);
  const frame = { x: pose.x, y: pose.y, w: pose.w * g, h: pose.h * g };
  // Seats live in the HULL, centred inside the frame square — never in the square itself, which has a
  // square's worth of tarmac round the vehicle on its narrow axis.
  const rect = hullRectIn(frame, pose.hull ?? { w: pose.w, h: pose.h }, g);
  return seatSlotPosition(rect, g, seatIndex, riderSize, order, pose.rotation);
}

/**
 * A vehicle handle's HULL rectangle on the map — the axis-aligned shape that, turned by the token's
 * rotation about its own centre, is what the vehicle actually occupies. The one place the frame
 * square is converted into the vehicle's real footprint, so cover, boarding reach and the outline
 * cannot each measure it their own way.
 */
export function hullRectOf(tokenDoc, grid) {
  const g = Math.max(1, Number(grid) || 100);
  const w = Math.max(1, Math.round(Number(tokenDoc?.width) || 1));
  const h = Math.max(1, Math.round(Number(tokenDoc?.height) || 1));
  const hull = hullDimsOf(tokenDoc?.actor?.system, w, h);
  const frame = { x: Number(tokenDoc?.x) || 0, y: Number(tokenDoc?.y) || 0, w: w * g, h: h * g };
  return { rect: hullRectIn(frame, hull, g), hull };
}

/**
 * WHICH HANDLE a rider is aboard on a given scene — the id of one token, never a set.
 *
 * The stamped token id is the answer whenever it still names a token on this scene. Otherwise (a
 * rider boarded before the stamp existed, or one whose handle has since been deleted) the answer
 * is the FIRST handle of that vehicle in the scene's own document order: deterministic, identical
 * on every client, and exactly today's behaviour wherever a vehicle has only one handle.
 *
 * @returns {string|null}
 */
export function riderVehicleTokenIdOn(scene, riderDoc) {
  const f = riderDoc?.flags?.[SCOPE];
  const actorId = f?.boardedVehicle;
  if (!actorId) return null;
  const stamped = f?.boardedVehicleToken;
  const stampedDoc = stamped ? (scene?.tokens?.get?.(stamped) ?? null) : null;
  // A stamp that still names a live handle OF THIS VEHICLE wins. The actor check matters: a token
  // id can be recycled by a scene import, and a stamp pointing at somebody else's token would seat
  // a rider inside a vehicle they never boarded.
  if (stampedDoc && stampedDoc.actorId === actorId) return stamped;
  return vehicleTokenFor(scene, actorId)?.id ?? null;
}

/**
 * THE membership test: is this rider aboard THIS handle? Every geometry site asks it — the per-frame
 * draw, the crew-follow commit, the seat-claim search, the badge, the drag-lock — so no two of them
 * can disagree about which truck somebody is sitting in.
 */
export function riderIsAboardToken(riderDoc, vehicleTokenDoc) {
  if (!vehicleTokenDoc) return false;
  if (riderDoc?.flags?.[SCOPE]?.boardedVehicle !== vehicleTokenDoc.actorId) return false;
  return riderVehicleTokenIdOn(vehicleTokenDoc.parent, riderDoc) === vehicleTokenDoc.id;
}

/**
 * Everyone aboard a vehicle on a scene, each with the seat index they claim. The occupancy flag is
 * the only membership test anywhere in the module, so the coupling, the badge and the re-seat can
 * never disagree about who is in the car.
 *
 * @param {Scene} scene
 * @param {string} vehicleActorId
 * @param {TokenDocument|null} [vehicleTokenDoc]  narrow to ONE handle. Every caller that is about a
 *   drawn vehicle passes it — seats, movement and the badge belong to a token, not to an actor with
 *   two copies on the canvas. Omitting it keeps the actor-wide answer, which is what the questions
 *   that really are about the machine (cross-scene occupancy totals) want.
 */
export function ridersOf(scene, vehicleActorId, vehicleTokenDoc = null) {
  const out = [];
  for (const doc of scene?.tokens ?? []) {
    if (doc.flags?.[SCOPE]?.boardedVehicle !== vehicleActorId) continue;
    if (vehicleTokenDoc && !riderIsAboardToken(doc, vehicleTokenDoc)) continue;
    const seatIndex = Number(doc.flags?.[SCOPE]?.seatIndex);
    if (!Number.isInteger(seatIndex) || seatIndex < 0) continue;
    out.push({ doc, seatIndex });
  }
  return out;
}

/**
 * The updates that would put every rider of `actor` in the seat its stored index points at for the
 * vehicle's `pose` — built, not written, so the caller can decide who writes which of them.
 *
 * The pose is passed in rather than read back off the handle because the caller that just resized
 * or drove it knows the new figures before the document animation has finished agreeing with them.
 * Riders already sitting on their seat are left out entirely, which is what keeps a move that
 * changes nothing from writing anything.
 */
function seatUpdatesFor(scene, actor, pose, vehicleTokenDoc = null) {
  const grid = scene?.grid?.size ?? 100;
  const order = seatOrderAt(actor, pose);
  const updates = [];
  // ⛔ TOKEN-SCOPED. Without the handle this moved every rider of every copy of this vehicle to the
  // seats of whichever copy was being driven — the reported two-truck swap.
  for (const { doc, seatIndex } of ridersOf(scene, actor.id, vehicleTokenDoc)) {
    const seat = riderSeatAt(pose, grid, seatIndex, { w: doc.width, h: doc.height }, order);
    const src = doc._source ?? doc;
    if (seat.x === src.x && seat.y === src.y) continue;
    updates.push({ _id: doc.id, x: seat.x, y: seat.y });
  }
  return updates;
}

/**
 * Write a batch of seat updates as ONE document operation, instantly. Instantly because the crew's
 * ride is already being drawn frame by frame by the presentation coupling — letting the core also
 * animate each rider from its old spot to its new one would put a second, slower copy of the same
 * journey on screen, which is the picture the walk report described.
 */
async function commitSeats(scene, updates) {
  if (!updates?.length) return 0;
  const movement = {};
  for (const u of updates) {
    const instruction = displaceWaypointFor(scene.tokens.get(u._id), u);
    if (instruction) movement[u._id] = instruction;
  }
  await scene.updateEmbeddedDocuments("Token", updates, { movement, cp2020VehicleSync: true });
  return updates.length;
}

/**
 * Move every rider of `actor` to its seat for `pose`. Shared by every edit that can move seats — a
 * drive, a footprint resize, a Front change, a repaint, a turn of the wheel — so all of them put
 * people in the same places.
 */
async function reseatRiders(scene, actor, pose, vehicleTokenDoc = null) {
  return commitSeats(scene, seatUpdatesFor(scene, actor, pose, vehicleTokenDoc));
}

/**
 * The crew-follow commit: recompute every rider's seat from the vehicle's STORED pose and write it
 * once.
 *
 * ⭐ THERE IS NO DELTA ARITHMETIC LEFT. The old version captured the vehicle's x/y change in
 * `preUpdateToken` and translated each rider by it, which broke twice over: the "before" position
 * it subtracted was the PREPARED one (mid-animation on a dragged move — measured 143 px of a 900 px
 * drive, stranding the crew), and a translation carries nobody around a turn. Asking the seat where
 * it is for the pose the vehicle actually holds answers both at once, and it is the same question
 * the re-seat and the per-frame coupling ask.
 */
async function commitCrewFollow(handle) {
  const scene = handle?.parent;
  const actor = handle?.actor;
  if (!scene || !actor) return 0;
  // The handle that moved carries ONLY its own riders. A second token of the same vehicle standing
  // elsewhere on the canvas keeps the people sitting in it.
  const updates = seatUpdatesFor(scene, actor, storedPoseOf(handle), handle);
  if (!updates.length) return 0;

  // A non-GM driver can move the vehicle but cannot write token documents they do not own (an
  // un-owned passenger) — those updates fail silently and that rider stays behind. Split by
  // writability: apply the ones this user can modify, relay the rest to the active GM (the same
  // socket shape the missile and vehicle-damage relays use).
  const mine = [], relay = [];
  for (const u of updates) {
    (scene.tokens.get(u._id)?.canUserModify(game.user, "update") ? mine : relay).push(u);
  }
  if (mine.length) await commitSeats(scene, mine);
  if (relay.length) {
    if (game.users?.activeGM) {
      game.socket.emit("module.cp2020-augmented", {
        type: "vehicleCrewFollow", sceneId: scene.id, updates: relay, requesterId: game.user.id,
      });
    } else {
      ui.notifications?.warn?.(localizeParam("Vehicle.NoGMForCrewFollow", { name: handle.name ?? "" }));
    }
  }
  return updates.length;
}

/**
 * Update options that carry the update's new x/y as a single instant `displace` movement waypoint —
 * the core's replacement for the deprecated `teleport: true` option (same shape on v13 and v14).
 * Getting into a car is not a walk across the map: without this the core animates the token along
 * a path and streams the document's x/y as it goes, so the token is briefly somewhere between its
 * old spot and its seat (rig-measured mid-glide reads). No position change ⇒ no movement options.
 */
function displaceWaypointFor(tokenDoc, update) {
  if (update.x === undefined && update.y === undefined) return null;
  const src = tokenDoc._source ?? tokenDoc;
  return { waypoints: [{
    x: update.x ?? src.x, y: update.y ?? src.y,
    action: "displace", snapped: false, explicit: false, checkpoint: true,
  }] };
}
/**
 * Update options for a rider the MODULE is moving — boarding, stepping out, a re-seat: the displace
 * waypoint above, plus the mark that says we did it.
 *
 * `cp2020VehicleSync` is that mark. The crew-follow hook already read it to recognise its own writes
 * and skip them; the ride lock in vehicle-ride-lock.js now reads the SAME mark to let those writes
 * through while it refuses a hand-drag off the bodywork. One answer to "did we do this", rather than
 * one per feature. Every module path that moves a rider goes through here or through `commitSeats`,
 * which stamps it the same way.
 */
function moduleRiderMove(tokenDoc, update) {
  const instruction = displaceWaypointFor(tokenDoc, update);
  return instruction
    ? { movement: { [tokenDoc.id]: instruction }, cp2020VehicleSync: true }
    : { cp2020VehicleSync: true };
}

/**
 * The vehicle's FIRST handle token on a scene, in the scene's own document order.
 *
 * ⚠ "First" is load-bearing where a vehicle has more than one handle: it is the deterministic
 * fallback `riderVehicleTokenIdOn` gives a rider that carries no token stamp, and every client
 * walks the same list in the same order, so they all name the same token. Callers that need every
 * copy — a resize that has to reach all of them — use `vehicleTokensFor`.
 */
export function vehicleTokenFor(scene, vehicleActorId) {
  return (scene?.tokens ?? []).find(t => t.actorId === vehicleActorId && isVehicleTokenDoc(t)) ?? null;
}

/** EVERY handle of one vehicle on a scene. Two copies of a truck are two trucks to draw and seat. */
export function vehicleTokensFor(scene, vehicleActorId) {
  return (scene?.tokens ?? []).filter(t => t.actorId === vehicleActorId && isVehicleTokenDoc(t));
}

/**
 * The lowest seat index not already claimed on this vehicle. Seats are claimed by flag rather
 * than by counting heads, so a rider stepping out of the middle frees THAT seat instead of
 * silently doubling two passengers into one square.
 *
 * Claims are counted PER HANDLE: the driver's seat of one truck says nothing about the driver's
 * seat of the truck parked beside it, so two copies of a vehicle each fill from seat 0.
 */
function nextFreeSeatIndex(scene, vehicleActorId, exceptTokenId = null, vehicleTokenDoc = null) {
  const taken = new Set();
  for (const t of scene?.tokens ?? []) {
    if (t.id === exceptTokenId) continue;
    if (t.flags?.[SCOPE]?.boardedVehicle !== vehicleActorId) continue;
    if (vehicleTokenDoc && !riderIsAboardToken(t, vehicleTokenDoc)) continue;
    const idx = Number(t.flags?.[SCOPE]?.seatIndex);
    if (Number.isInteger(idx) && idx >= 0) taken.add(idx);
  }
  let i = 0;
  while (taken.has(i)) i++;
  return i;
}

/**
 * Seat a crew token: flag it as riding, move it into its seat inside the vehicle's footprint,
 * draw it at BOARDED_SCALE, and make sure it sorts ABOVE the handle so the seat square selects
 * the person while the rest of the hull still selects the car. Everything the presentation
 * overwrites is stored first, so stepping out restores the token exactly as it was.
 */
export async function boardVehicle(crewTokenDoc, vehicleActor, vehicleTokenDoc = null) {
  if (!crewTokenDoc || !vehicleActor) return;
  const scene = crewTokenDoc.parent;
  const grid = scene?.grid?.size ?? canvas?.grid?.size ?? 100;
  const vehicleDoc = vehicleTokenDoc ?? vehicleTokenFor(scene, vehicleActor.id);

  const update = { [`flags.${SCOPE}.boardedVehicle`]: vehicleActor.id };
  // ⭐ WHICH COPY. The handle the rider actually boarded is recorded alongside the vehicle, so a
  // second token of the same vehicle elsewhere on the canvas has no claim on this person.
  if (vehicleDoc) update[`flags.${SCOPE}.boardedVehicleToken`] = vehicleDoc.id;

  if (vehicleDoc) {
    const src = crewTokenDoc._source ?? crewTokenDoc;
    const seatIndex = nextFreeSeatIndex(scene, vehicleActor.id, crewTokenDoc.id, vehicleDoc);
    const pose = storedPoseOf(vehicleDoc);
    const seat = riderSeatAt(pose, grid, seatIndex,
      { w: crewTokenDoc.width, h: crewTokenDoc.height }, seatOrderAt(vehicleActor, pose));
    // Only record the restore point on the FIRST boarding — re-seating an already-aboard token
    // must not overwrite the original size/position with the boarded presentation.
    if (!crewTokenDoc.flags?.[SCOPE]?.boardedRestore) {
      update[`flags.${SCOPE}.boardedRestore`] = {
        x: src.x, y: src.y, sort: src.sort ?? 0,
        scaleX: src.texture?.scaleX ?? 1, scaleY: src.texture?.scaleY ?? 1,
      };
    }
    const prior = crewTokenDoc.flags?.[SCOPE]?.boardedRestore
      ?? { scaleX: src.texture?.scaleX ?? 1, scaleY: src.texture?.scaleY ?? 1, sort: src.sort ?? 0 };
    Object.assign(update, {
      [`flags.${SCOPE}.seatIndex`]: seatIndex,
      x: seat.x, y: seat.y,
      "texture.scaleX": (Number(prior.scaleX) || 1) * BOARDED_SCALE,
      "texture.scaleY": (Number(prior.scaleY) || 1) * BOARDED_SCALE,
    });
    const lift = (Number(vehicleDoc.sort) || 0) + CREW_SORT_LIFT;
    if ((Number(src.sort) || 0) < lift) update.sort = lift;
  }

  await crewTokenDoc.update(update, moduleRiderMove(crewTokenDoc, update));

  // A handle placed outside our own defaults (an older token, a hand-made one) may sort at or
  // above its riders, which would let the hull swallow every seat click. Push it back down.
  if (vehicleDoc && (Number(vehicleDoc.sort) || 0) > VEHICLE_SORT
      && vehicleDoc.canUserModify?.(game.user, "update")) {
    await vehicleDoc.update({ sort: VEHICLE_SORT });
  }
}

/**
 * Step a crew token out: restore the size/sort it had before boarding and drop it on the ground
 * BESIDE the vehicle's current footprint (never inside it — a token left under the hull reads as
 * still aboard and is awkward to grab).
 */
export async function disembark(crewTokenDoc) {
  if (!crewTokenDoc) return;
  const scene = crewTokenDoc.parent;
  const grid = scene?.grid?.size ?? canvas?.grid?.size ?? 100;
  const vehicleActorId = crewTokenDoc.flags?.[SCOPE]?.boardedVehicle;
  // Step out beside the handle this rider was actually IN, not beside whichever copy of the vehicle
  // the scene happens to list first.
  const boardedTokenId = riderVehicleTokenIdOn(scene, crewTokenDoc);
  const vehicleDoc = (boardedTokenId ? scene?.tokens?.get?.(boardedTokenId) : null)
    ?? (vehicleActorId ? vehicleTokenFor(scene, vehicleActorId) : null);
  const prior = crewTokenDoc.flags?.[SCOPE]?.boardedRestore ?? null;

  // deleteFieldUpdate picks the core's supported deletion form (ForcedDeletion on v14, `-=` on v13).
  const update = {
    ...deleteFieldUpdate(`flags.${SCOPE}.boardedVehicle`),
    ...deleteFieldUpdate(`flags.${SCOPE}.boardedVehicleToken`),
    ...deleteFieldUpdate(`flags.${SCOPE}.seatIndex`),
    ...deleteFieldUpdate(`flags.${SCOPE}.boardedRestore`),
  };
  if (prior) {
    update["texture.scaleX"] = Number(prior.scaleX) || 1;
    update["texture.scaleY"] = Number(prior.scaleY) || 1;
    update.sort = Number(prior.sort) || 0;
  }
  if (vehicleDoc) {
    const blockers = (scene?.tokens ?? [])
      .filter(t => t.id !== crewTokenDoc.id)
      .map(t => tokenRect(t, grid));
    const spot = placeBeside(tokenRect(vehicleDoc, grid), grid,
      { w: crewTokenDoc.width, h: crewTokenDoc.height }, blockers,
      { width: scene?.width, height: scene?.height });
    update.x = spot.x;
    update.y = spot.y;
  }
  await crewTokenDoc.update(update, moduleRiderMove(crewTokenDoc, update));
}

/**
 * A rider dragged onto another square of the footprint has CHOSEN that seat, so the drag is
 * recorded as a seat INDEX rather than left as a position.
 *
 * ⭐ WHY IT HAS TO BE THE INDEX. The index is the only thing about a rider that survives a footprint
 * resize, a change of heading or a repaint of the grid — every one of those recomputes positions
 * from it. A drag left as a bare position therefore held only until the next thing that moved the
 * seats, and then put the rider back where their flag still said they sat, which is exactly what
 * the drag was trying to change.
 *
 * A drop that is not on a seat (the engine rank, outside the footprint) or is on a seat somebody
 * else holds changes nothing — the rider simply goes back to their own seat, which reads as the
 * drag not taking rather than as two people in one square.
 */
async function adoptDraggedSeat(riderDoc) {
  const scene = riderDoc?.parent;
  const vehicleActorId = riderDoc?.flags?.[SCOPE]?.boardedVehicle;
  if (!scene || !vehicleActorId) return;
  // The seat the drag landed in is a seat of the handle this rider is IN — measured against the
  // other copy of the vehicle it would be measured against the wrong rectangle entirely.
  const boardedTokenId = riderVehicleTokenIdOn(scene, riderDoc);
  const handle = (boardedTokenId ? scene.tokens.get(boardedTokenId) : null)
    ?? vehicleTokenFor(scene, vehicleActorId);
  const actor = handle?.actor;
  if (!handle || !actor) return;

  const grid = scene.grid?.size ?? 100;
  const pose = storedPoseOf(handle);
  const order = seatOrderAt(actor, pose);
  const size = { w: riderDoc.width, h: riderDoc.height };
  const src = riderDoc._source ?? riderDoc;
  const current = Number(riderDoc.flags?.[SCOPE]?.seatIndex);

  // Which seat is the drop closest to? Half a square is the tolerance a hand-drag needs; beyond
  // that the rider was not aiming at a seat at all.
  let best = -1, bestDistance = Infinity;
  for (let i = 0; i < order.length; i++) {
    const seat = riderSeatAt(pose, grid, i, size, order);
    const d = Math.hypot(seat.x - src.x, seat.y - src.y);
    if (d < bestDistance) { bestDistance = d; best = i; }
  }
  const landed = (bestDistance <= grid / 2) ? best : -1;
  const taken = landed >= 0 && ridersOf(scene, vehicleActorId, handle)
    .some(r => r.doc.id !== riderDoc.id && r.seatIndex === landed);
  const target = (landed >= 0 && !taken) ? landed : current;
  if (!Number.isInteger(target) || target < 0) return;

  const seat = riderSeatAt(pose, grid, target, size, order);
  const update = { [`flags.${SCOPE}.seatIndex`]: target, x: seat.x, y: seat.y };
  if (target === current && seat.x === src.x && seat.y === src.y) return;   // already exactly there
  await scene.updateEmbeddedDocuments("Token", [{ _id: riderDoc.id, ...update }],
    { movement: { [riderDoc.id]: displaceWaypointFor(riderDoc, seat) }, cp2020VehicleSync: true });
}

/**
 * Hold the crew's documents off until a turning gesture stops, then commit their seats. The timer
 * is per handle, and each further notch pushes it out again, so one turn of the wheel is one write.
 */
function settleRotation(handle) {
  const prior = _rotationSettles.get(handle.id);
  if (prior) clearTimeout(prior);
  _rotationSettles.set(handle.id, setTimeout(async () => {
    _rotationSettles.delete(handle.id);
    try { await commitCrewFollow(handle); }
    catch (e) { console.warn(`${SCOPE} | rotation re-seat failed`, e); }
  }, ROTATION_SETTLE_MS));
}

/**
 * Register the crew-follow coupling: when a vehicle handle token changes pose, its riders' seats are
 * recomputed and written once. Gated to the client that made the change, so exactly one client
 * writes. What the eye sees WHILE the vehicle is moving is not here at all — that is the per-frame
 * presentation coupling in vehicle-ride.js, which draws and never writes. No reverse coupling and
 * no tiles, so there is nothing to loop on.
 */
export function registerVehicleCanvasHooks() {
  // ONE handler for every way a vehicle can change pose. A move (or a resize) commits at once,
  // because the vehicle already knows where it is going. A turn on its own SETTLES first: the
  // core's rotation gestures fire one update per scroll notch, and writing the crew's documents a
  // dozen times for one turn of the wheel is noise — the crew are already following the turn frame
  // by frame on screen, so the write can afford to wait for the gesture to finish.
  Hooks.on("updateToken", async (doc, change, options, userId) => {
    if (options?.cp2020VehicleSync) return;
    if (userId !== game.user.id) return;             // one writer: the client that made the change
    if (!_isVehicleToken(doc)) {
      // A RIDER that moved on its own was dragged by hand: record which seat it landed in.
      if ((change.x !== undefined || change.y !== undefined) && doc.flags?.[SCOPE]?.boardedVehicle) {
        await adoptDraggedSeat(doc);
      }
      return;
    }
    const moved = change.x !== undefined || change.y !== undefined
      || change.width !== undefined || change.height !== undefined;
    const turned = change.rotation !== undefined;
    if (!moved && !turned) return;
    if (!moved) { settleRotation(doc); return; }
    const pending = _rotationSettles.get(doc.id);
    if (pending) { clearTimeout(pending); _rotationSettles.delete(doc.id); }
    await commitCrewFollow(doc);
  });

  // GM-side relay: a non-GM driver emits the un-owned crew moves; only the primary GM SESSION (which
  // can write any token) applies them. cp2020VehicleSync suppresses the crew-follow hooks so nothing
  // loops. Converges — both clients would write the same seat coordinates — so this row cost a
  // redundant token update, not a wrong one.
  game.socket.on("module.cp2020-augmented", async (data) => {
    if (data?.type !== "vehicleCrewFollow") return;
    if (!isPrimaryGMSession()) return;
    const scene = data.sceneId ? game.scenes?.get(data.sceneId) : canvas?.scene;
    if (scene && Array.isArray(data.updates) && data.updates.length) {
      await commitSeats(scene, data.updates);
    }
  });

  // Layout follows the sheet: when a vehicle actor's prototype-token size changes (the Footprint
  // field), its Front heading does (the picker) or its painted grid does, resize its handle tokens
  // on every scene and re-seat anyone aboard. All three edits move seats — the footprint changes
  // which cells exist, the heading changes which of them are seats and in what order, the paint
  // grid names them outright — and a rider's stored seat INDEX is the only thing that survives any
  // of them, by design. Runs on the active GM's client only (one writer, and the GM can modify any
  // token) — the same gating as the crew-follow relay.
  Hooks.on("updateActor", async (actor, change) => {
    if (actor.type !== "cp2020-augmented.vehicle") return;
    const pt = change?.prototypeToken;
    const sizeChanged = !!pt && (pt.width !== undefined || pt.height !== undefined);
    const hullChanged = change?.system?.layout?.hullW !== undefined
      || change?.system?.layout?.hullH !== undefined;
    const layoutChanged = change?.system?.layout?.front !== undefined
      || change?.system?.layout?.cells !== undefined;
    if (!sizeChanged && !hullChanged && !layoutChanged) return;
    if (!isPrimaryGMSession()) return;
    // The HULL is the edited figure now (the sheet's Footprint fields write it); the frame square and
    // the art scale are both derived from it, here, so there is exactly one place that decides them.
    //
    // ⛔ THIS IS THE WRITE THAT BLEW THE TOKEN UP (field incident 2026-08-25). A Footprint edit of
    // 10000 arrived here and `frameSquareFor` squared it into a 10000 × 10000 token before anything
    // had questioned the figure. Both halves are bounded now — the model clamps the hull on the way
    // in, and `frameSquareFor`/`hullDimsOf` bound whatever they are handed on the way out — so `side`
    // cannot exceed the ceiling however this hook is reached. It also HEALS: a vehicle left with a
    // poisoned frame gets it rewritten to the bounded square the moment its hull is edited again.
    const hull = hullDimsOf(actor.system,
      Number(actor.prototypeToken?.width), Number(actor.prototypeToken?.height));
    const side = frameSquareFor(hull);
    const scale = hullArtScale(hull);
    if (hullChanged && (Number(actor.prototypeToken?.width) !== side
        || Number(actor.prototypeToken?.height) !== side)) {
      await actor.update({ prototypeToken: {
        width: side, height: side, texture: { scaleX: scale, scaleY: scale },
      } });
    }
    for (const scene of game.scenes ?? []) {
      // EVERY handle, not just the first: two copies of one vehicle on a scene are two vehicles to
      // resize and two sets of riders to re-seat, each into its own copy's cells.
      for (const handle of vehicleTokensFor(scene, actor.id)) {
        if (handle.width !== side || handle.height !== side) {
          await handle.update({ width: side, height: side, texture: { scaleX: scale, scaleY: scale } });
        }
        // The pose comes from the actor's OWN new figures and never from the handle document. Reading
        // the token back after its resize looked equivalent and was not: rig-measured, the doc still
        // answered with its old footprint on the pass that had just resized it, so the seat order was
        // the old shape's while the rect was the new one, and riders landed in cells that belonged to
        // neither.
        const pose = { ...storedPoseOf(handle), w: side, h: side, hull };
        await reseatRiders(scene, actor, pose, handle);
      }
    }
  });

  // Prototype-token defaults so DRAGGING a vehicle actor onto the canvas behaves exactly like the
  // old Deploy button: linked, the default footprint (resizable), rendered below crew, art scaled to
  // fit, and flagged as a vehicle handle so the crew-follow coupling recognizes it. This is why the
  // Deploy button was removed — a plain drag now produces an identical, fully-functional token.
  Hooks.on("preCreateActor", (actor, data) => {
    if (data?.type !== "cp2020-augmented.vehicle") return;
    try {
      const base = actor.prototypeToken?.toObject?.() ?? {};
      // A hull the caller ASKED for is left alone — either stated outright in system.layout, or, for
      // the callers that still speak in token sizes, as a prototype footprint bigger than the core's
      // own 1×1. The default only fills in when neither said anything.
      const asked = hullDimsOf(data?.system, null, null);
      const statedHull = hasRecordedHull(data?.system);
      const statedFrame = (Number(base.width) || 1) > 1 || (Number(base.height) || 1) > 1;
      const hull = statedHull ? asked
        : (statedFrame ? { w: Number(base.width) || 1, h: Number(base.height) || 1 } : DEFAULT_HULL);
      const side = frameSquareFor(hull);
      const scale = hullArtScale(hull);
      // The hull is RECORDED on the actor and the prototype token becomes the square that carries
      // it — the two halves of the same fact, written together so a fresh vehicle never exists in a
      // state where its frame and its hull disagree.
      actor.updateSource({
        system: { layout: { hullW: hull.w, hullH: hull.h } },
        prototypeToken: foundry.utils.mergeObject(base, {
          actorLink: true, width: side, height: side, sort: VEHICLE_SORT,
          texture: { src: data.img ?? base.texture?.src, fit: "contain", scaleX: scale, scaleY: scale },
          flags: { [SCOPE]: { vehicleHandle: true } },
        }, { inplace: false }),
      });
    } catch (e) { /* non-fatal */ }
  });
}
