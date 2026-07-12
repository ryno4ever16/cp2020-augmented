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

const SCOPE = "cp2020-augmented";
const VEHICLE_SORT = -100;            // render below crew tokens
/** token.id → {dx,dy} captured in preUpdateToken, consumed in updateToken (same client). */
const _moveDeltas = new Map();

/**
 * A token represents a vehicle if its actor is a vehicle (covers tokens dragged from the sidebar
 * like any other actor) or it carries the legacy vehicleHandle flag (tokens placed by an older
 * deploy). Detecting by actor type is what lets a plain drag-to-canvas behave like Deploy did.
 */
function _isVehicleToken(doc) {
  return doc?.actor?.type === "cp2020-augmented.vehicle" || doc?.flags?.[SCOPE]?.vehicleHandle === true;
}

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
  const gw = Math.max(1, Number(opts.gw) || 4);
  const gh = Math.max(1, Number(opts.gh) || 2);
  const wpx = gw * gridSize, hpx = gh * gridSize;
  const px = opts.x ?? Math.round(((scene.width ?? 2000) - wpx) / 2);
  const py = opts.y ?? Math.round(((scene.height ?? 2000) - hpx) / 2);

  const [tokenDoc] = await scene.createEmbeddedDocuments("Token", [{
    name: actor.name, actorId: actor.id, actorLink: true,
    x: px, y: py, width: gw, height: gh,
    sort: VEHICLE_SORT,                              // crew tokens render on top
    texture: { src: actor.img, fit: "contain" },     // art scales to the footprint
    flags: { [SCOPE]: { vehicleHandle: true } },
  }]);
  return { tokenId: tokenDoc.id, existing: false };
}

/** Mark a crew token as riding a vehicle (it will move with the vehicle). */
export async function boardVehicle(crewTokenDoc, vehicleActor) {
  if (!crewTokenDoc || !vehicleActor) return;
  await crewTokenDoc.update({ [`flags.${SCOPE}.boardedVehicle`]: vehicleActor.id });
}

/** Remove a crew token from a vehicle. */
export async function disembark(crewTokenDoc) {
  if (!crewTokenDoc) return;
  await crewTokenDoc.update({ [`flags.${SCOPE}.-=boardedVehicle`]: null });
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
