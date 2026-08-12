/**
 * Vehicle canvas representation (Phase 2, corrected).
 *
 * A vehicle is a single **visible Token** showing the vehicle's image, sized to its footprint
 * (the art scales to the box — `texture.fit:"contain"`; resize the token to fit any image). It is
 * the natural movable/selectable/targetable object, and it is AoE-detected like any token. A low
 * `sort` makes crew tokens render on top of it. Crew flagged as "boarded" ride along when the
 * vehicle moves.
 *
 *   vehicleToken.flags.cp2020-augmented.vehicleHandle = true
 *   crewToken.flags.cp2020-augmented.boardedVehicle  = <vehicleActorId>
 */

import { localizeParam } from "../utils.js";
import { seatSlotPosition, placeBeside } from "./vehicle-seating.js";

const SCOPE = "cp2020-augmented";
const VEHICLE_SORT = -100;            // render below crew tokens
/**
 * How much of its own size a rider is drawn at while aboard (user ruling: ~60%). This scales the
 * token's ARTWORK (`texture.scaleX/scaleY`), deliberately NOT its `width`/`height`: the document
 * stays one grid square, so the seat keeps a full square of hit area and clicking a seat selects
 * the person sitting in it. The prior scale is stored and restored verbatim on the way out.
 * ⚠ Read the prior value from `_source` — the PREPARED `texture.scaleX` is animated by the core
 * and reads back mid-transition (rig-measured 0.77 while 0.6 was stored).
 */
const BOARDED_SCALE = 0.6;
/** How far above the vehicle handle a rider is lifted when its sort would leave it underneath. */
const CREW_SORT_LIFT = 10;
/** token.id → {dx,dy} captured in preUpdateToken, consumed in updateToken (same client). */
const _moveDeltas = new Map();

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
  const gw = Math.max(1, Number(opts.gw) || Number(actor.prototypeToken?.width) || 4);
  const gh = Math.max(1, Number(opts.gh) || Number(actor.prototypeToken?.height) || 2);
  const wpx = gw * gridSize, hpx = gh * gridSize;
  const px = opts.x ?? Math.round(((scene.width ?? 2000) - wpx) / 2);
  const py = opts.y ?? Math.round(((scene.height ?? 2000) - hpx) / 2);

  const [tokenDoc] = await scene.createEmbeddedDocuments("Token", [{
    // Link mode follows the actor's prototype token — the user's choice (linked = THE vehicle,
    // unlinked = independent copies), not a hardcoded override. New vehicles seed linked at creation.
    name: actor.name, actorId: actor.id, actorLink: actor.prototypeToken?.actorLink ?? true,
    x: px, y: py, width: gw, height: gh,
    sort: VEHICLE_SORT,                              // crew tokens render on top
    texture: { src: actor.img, fit: "contain" },     // art scales to the footprint
    flags: { [SCOPE]: { vehicleHandle: true } },
  }]);
  return { tokenId: tokenDoc.id, existing: false };
}

/* ------------------------------------------------------------------ seating helpers */

/** Pixel rectangle of a token document on its scene. */
function tokenRect(doc, gridSize) {
  return { x: doc.x, y: doc.y, w: (doc.width ?? 1) * gridSize, h: (doc.height ?? 1) * gridSize };
}

/** The vehicle's handle token on a scene (the one the crew token is sitting on/next to). */
export function vehicleTokenFor(scene, vehicleActorId) {
  return (scene?.tokens ?? []).find(t => t.actorId === vehicleActorId && isVehicleTokenDoc(t)) ?? null;
}

/**
 * The lowest seat index not already claimed on this vehicle. Seats are claimed by flag rather
 * than by counting heads, so a rider stepping out of the middle frees THAT seat instead of
 * silently doubling two passengers into one square.
 */
function nextFreeSeatIndex(scene, vehicleActorId, exceptTokenId = null) {
  const taken = new Set();
  for (const t of scene?.tokens ?? []) {
    if (t.id === exceptTokenId) continue;
    if (t.flags?.[SCOPE]?.boardedVehicle !== vehicleActorId) continue;
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

  if (vehicleDoc) {
    const src = crewTokenDoc._source ?? crewTokenDoc;
    const seatIndex = nextFreeSeatIndex(scene, vehicleActor.id, crewTokenDoc.id);
    const seat = seatSlotPosition(tokenRect(vehicleDoc, grid), grid, seatIndex,
      { w: crewTokenDoc.width, h: crewTokenDoc.height });
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

  // `teleport` — getting into a car is not a walk across the map. Without it the core animates
  // the rider along a path and streams the document's x/y as it goes, so the token is briefly
  // somewhere between its old spot and its seat (rig-measured mid-glide reads).
  await crewTokenDoc.update(update, { teleport: true });

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
  const vehicleDoc = vehicleActorId ? vehicleTokenFor(scene, vehicleActorId) : null;
  const prior = crewTokenDoc.flags?.[SCOPE]?.boardedRestore ?? null;

  const update = {
    [`flags.${SCOPE}.-=boardedVehicle`]: null,
    [`flags.${SCOPE}.-=seatIndex`]: null,
    [`flags.${SCOPE}.-=boardedRestore`]: null,
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
  await crewTokenDoc.update(update, { teleport: true });
}

/**
 * Register the crew-follow coupling: when a vehicle handle token moves, boarded crew translate by
 * the same delta. Gated to the client that made the move (so preUpdate and update share state and
 * only one client applies it). No tiles, no reverse coupling — nothing to loop on.
 */
export function registerVehicleCanvasHooks() {
  Hooks.on("preUpdateToken", (doc, change, options) => {
    if (options?.cp2020VehicleSync) return;
    if (!_isVehicleToken(doc)) return;
    const dx = (change.x ?? doc.x) - doc.x;
    const dy = (change.y ?? doc.y) - doc.y;
    if (dx || dy) _moveDeltas.set(doc.id, { dx, dy });
  });

  Hooks.on("updateToken", async (doc, change, options, userId) => {
    const delta = _moveDeltas.get(doc.id);
    if (delta) _moveDeltas.delete(doc.id);
    if (options?.cp2020VehicleSync) return;
    if (userId !== game.user.id) return;             // only the client that performed the move
    if (!_isVehicleToken(doc) || !delta || (!delta.dx && !delta.dy)) return;

    const scene = doc.parent;
    const crew = scene.tokens.filter(t => t.flags?.[SCOPE]?.boardedVehicle === doc.actorId);
    // A non-GM driver can move the vehicle but cannot write token docs they don't own (un-owned
    // passengers) — those updates fail silently and the crew stays behind. Split by writability:
    // apply the ones this user can modify directly, and relay the rest to the active GM (mirrors the
    // missile/vehicle-damage socket relay — same scope + active-GM handler applies).
    const mine = [], relay = [];
    for (const t of crew) {
      const u = { _id: t.id, x: t.x + delta.dx, y: t.y + delta.dy };
      (t.canUserModify(game.user, "update") ? mine : relay).push(u);
    }
    if (mine.length) await scene.updateEmbeddedDocuments("Token", mine, { cp2020VehicleSync: true });
    if (relay.length) {
      if (game.users?.activeGM) {
        game.socket.emit("module.cp2020-augmented", {
          type: "vehicleCrewFollow", sceneId: scene.id, updates: relay, requesterId: game.user.id,
        });
      } else {
        ui.notifications?.warn?.(localizeParam("Vehicle.NoGMForCrewFollow", { name: doc.name ?? "the vehicle" }));
      }
    }
  });

  // GM-side relay: a non-GM driver emits the un-owned crew moves; only the active GM (who can write
  // any token) applies them. cp2020VehicleSync suppresses the crew-follow hooks so nothing loops.
  game.socket.on("module.cp2020-augmented", async (data) => {
    if (data?.type !== "vehicleCrewFollow") return;
    if (!game.user?.isGM || game.users?.activeGM?.id !== game.user.id) return;
    const scene = data.sceneId ? game.scenes?.get(data.sceneId) : canvas?.scene;
    if (scene && Array.isArray(data.updates) && data.updates.length) {
      await scene.updateEmbeddedDocuments("Token", data.updates, { cp2020VehicleSync: true });
    }
  });

  // Prototype-token defaults so DRAGGING a vehicle actor onto the canvas behaves exactly like the
  // old Deploy button: linked, 4x2 (resizable), rendered below crew, art scaled to fit, and flagged
  // as a vehicle handle so the crew-follow coupling recognizes it. This is why the Deploy button
  // was removed — a plain drag now produces an identical, fully-functional vehicle token.
  Hooks.on("preCreateActor", (actor, data) => {
    if (data?.type !== "cp2020-augmented.vehicle") return;
    try {
      const base = actor.prototypeToken?.toObject?.() ?? {};
      actor.updateSource({ prototypeToken: foundry.utils.mergeObject(base, {
        actorLink: true, width: 4, height: 2, sort: VEHICLE_SORT,
        texture: { src: data.img ?? base.texture?.src, fit: "contain" },
        flags: { [SCOPE]: { vehicleHandle: true } },
      }, { inplace: false }) });
    } catch (e) { /* non-fatal */ }
  });
}
