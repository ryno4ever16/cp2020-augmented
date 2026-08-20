/**
 * vehicle-hull-migration.js — the one-time pass that separates a vehicle's HULL from its FRAME.
 *
 * WHAT CHANGED UNDER THESE VEHICLES. A vehicle's token document used to BE its shape: a 2-across,
 * 4-deep rectangle. On a square grid the core never turns that rectangle, so a vehicle at any angle
 * drew its art leaning inside an upright box, and every interaction the core scopes to the box
 * answered for a rectangle the vehicle was no longer in. The shape is now recorded on the ACTOR
 * (`system.layout.hullW/hullH`) and the token carries a SQUARE big enough to hold it at any angle
 * (vehicle-layout.js's hull/frame note). Nothing reads a vehicle's token rect as its shape any more.
 *
 * A vehicle that has recorded no hull is not broken by that — `hullDimsOf` falls back to the frame
 * it is in, which for those vehicles is still the old rectangle, so they behave exactly as they did.
 * This pass is what stops them relying on the fallback: it writes the hull down and squares the frame.
 *
 * ⭐ IT ALSO CURES THE LONG-FACE LEAD, AND THAT IS THE REASON IT FLIPS SHAPES.
 * The module used to ship vehicles 4 ACROSS by 2 DEEP. A token at rotation 0 faces SOUTH (the core's
 * own convention, which its drag auto-rotate then acts on), so a 4-across vehicle dragged anywhere
 * was turned to put its LONGEST face across the direction of travel — measured on the rig: dragged
 * east, the core writes rotation 270 and the four-square axis ends up exactly broadside. That is the
 * "it moves with the side forward" report, and it survives in every world because the shape is
 * stored per vehicle. So a hull recorded here from a WIDER-THAN-DEEP prototype is written the other
 * way round: the long axis becomes the vehicle's depth, which is the axis it travels along. A vehicle
 * that is already deeper than it is wide keeps the shape it has.
 *
 * A GM who genuinely wants a broad, shallow vehicle types the figures into the sheet's Footprint
 * fields afterwards — they edit the hull directly now, and nothing re-flips them.
 *
 * WHERE THE VEHICLE ENDS UP ON THE MAP: exactly where it was. The frame square is grown around the
 * hull's own centre, so each handle token is offset by half the difference and the bodywork does not
 * move a pixel.
 */

import { hullDimsOf, hasRecordedHull, frameSquareFor, hullArtScale } from "./vehicle-layout.js";

const SCOPE = "cp2020-augmented";
const VEHICLE_ACTOR_TYPE = "cp2020-augmented.vehicle";

/** The stamp pair: one bounds the attempt, the other records the finish. Hidden stores, not settings. */
const HULL_MIGRATED = "vehicleHullFramed";
const HULL_COMPLETED = `${HULL_MIGRATED}Completed`;

/** Register the two hidden world stores. Called from the module's `init` wiring. */
export function registerVehicleHullMigration() {
  for (const key of [HULL_MIGRATED, HULL_COMPLETED]) {
    game.settings.register(SCOPE, key, { scope: "world", config: false, type: Boolean, default: false });
  }
}

/**
 * The hull to record for a vehicle that has never stated one: its prototype's rectangle, with the
 * long axis turned into DEPTH (see the header — that is the side-forward cure). Already-recorded
 * hulls are returned untouched, so a re-run never re-flips anything.
 * PURE — the arithmetic is separated from the writing so it can be checked without a world.
 * @returns {{w:number, h:number, recorded:boolean}}
 */
export function hullToRecord(system, protoW, protoH) {
  const already = hasRecordedHull(system);
  const hull = hullDimsOf(system, protoW, protoH);
  if (already) return { w: hull.w, h: hull.h, recorded: true };
  const long = Math.max(hull.w, hull.h), short = Math.min(hull.w, hull.h);
  return { w: short, h: long, recorded: false };
}

/** Is this token one of `actor`'s vehicle handles? Unlinked copies count — each carries its own frame. */
function _handlesOf(scene, actorId) {
  return [...(scene?.tokens ?? [])].filter(t =>
    t.actorId === actorId
    && (t.actor?.type === VEHICLE_ACTOR_TYPE || t.flags?.[SCOPE]?.vehicleHandle === true));
}

/**
 * Run the pass. GM-only, active-GM-only, self-gating on the stamp pair.
 *
 * `force` runs it regardless of the stamps — the manual re-run path
 * (`game.modules.get("cp2020-augmented").api.migrations.vehicleHullFrames()`), which is also how a
 * GM upgrades a vehicle imported from an older world after this world was first migrated. It is
 * idempotent: a vehicle whose hull is already recorded keeps it, and a handle already square and
 * already centred is skipped, so a repeat writes nothing.
 * @returns {Promise<{actors:number, tokens:number, skipped:boolean}>}
 */
export async function migrateVehicleHullFrames({ force = false } = {}) {
  const nothing = { actors: 0, tokens: 0, skipped: true };
  if (!game.user?.isGM || game.users?.activeGM?.id !== game.user?.id) return nothing;
  const attempted = game.settings.get(SCOPE, HULL_MIGRATED);
  const completed = game.settings.get(SCOPE, HULL_COMPLETED);
  if (!force && attempted && completed) return nothing;
  /** Boot found an attempt that never recorded finishing — this run is the retry. */
  const recovering = !force && attempted && !completed;
  if (recovering) {
    console.warn(
      `${SCOPE} | recovering the vehicle hull/frame migration: it is marked as attempted but never `
      + `recorded finishing, so it is running once more now. It is idempotent — a vehicle whose hull `
      + `is already recorded is left exactly as it is.`);
  }

  // TWO STAMPS: ONE BOUNDS THE ATTEMPT, THE OTHER RECORDS THE FINISH — the same shape the rad-zone
  // and flesh-limb passes carry, for the same two reasons. Attempted-first, because a sweep whose
  // only stamp lands on success repeats its whole cost on every boot once anything in it throws.
  // Completed-after, because attempted-first ALONE left a client that died mid-sweep with a world
  // permanently half-migrated and nothing but a console line in a dead session to say so.
  await game.settings.set(SCOPE, HULL_MIGRATED, true);
  let actors = 0, tokens = 0;
  try {
    for (const actor of (game.actors ?? []).filter(a => a.type === VEHICLE_ACTOR_TYPE)) {
      try {
        const protoW = Number(actor.prototypeToken?.width);
        const protoH = Number(actor.prototypeToken?.height);
        const hull = hullToRecord(actor.system, protoW, protoH);
        const side = frameSquareFor(hull);
        const scale = hullArtScale(hull);

        // TOKENS FIRST, THEN THE ACTOR. The actor write is what the canvas hook watches, and it
        // re-seats every rider from the vehicle's new pose — so the handles have to be the right
        // size and in the right place before it lands, or the re-seat answers for a shape that is
        // still changing. cp2020VehicleSync keeps the token writes from starting a crew-follow of
        // their own against a hull that is not recorded yet.
        for (const scene of game.scenes ?? []) {
          const grid = scene.grid?.size ?? 100;
          for (const handle of _handlesOf(scene, actor.id)) {
            const src = handle._source ?? handle;
            const curW = Math.max(1, Number(src.width) || 1);
            const curH = Math.max(1, Number(src.height) || 1);
            // Grow the frame about the hull's own centre so the bodywork does not move.
            const x = Math.round((Number(src.x) || 0) + ((curW - side) * grid) / 2);
            const y = Math.round((Number(src.y) || 0) + ((curH - side) * grid) / 2);
            const update = {};
            if (curW !== side || curH !== side) Object.assign(update, { width: side, height: side, x, y });
            if (Number(src.texture?.scaleX) !== scale || Number(src.texture?.scaleY) !== scale) {
              update["texture.scaleX"] = scale;
              update["texture.scaleY"] = scale;
            }
            if (!Object.keys(update).length) continue;
            await scene.updateEmbeddedDocuments("Token", [{ _id: handle.id, ...update }],
              { cp2020VehicleSync: true });
            tokens++;
          }
        }

        const actorUpdate = {};
        if (!hull.recorded) {
          actorUpdate["system.layout.hullW"] = hull.w;
          actorUpdate["system.layout.hullH"] = hull.h;
        }
        if (protoW !== side || protoH !== side
            || Number(actor.prototypeToken?.texture?.scaleX) !== scale) {
          actorUpdate.prototypeToken = {
            width: side, height: side, texture: { scaleX: scale, scaleY: scale },
          };
        }
        if (Object.keys(actorUpdate).length) { await actor.update(actorUpdate); actors++; }
      } catch (e) {
        console.warn(`${SCOPE} | hull/frame migration failed for vehicle ${actor.id}`, e);
      }
    }
    await game.settings.set(SCOPE, HULL_COMPLETED, true);
    console.log(`${SCOPE} | vehicle hull/frame migration complete (${actors} vehicles, ${tokens} tokens).`);
  } catch (e) {
    console.error(
      `${SCOPE} | the vehicle hull/frame migration stopped part-way. Vehicles it had not reached yet `
      + `keep reading their shape off their token frame, which is what they did before — nothing is `
      + `broken, but their frames are still rectangles. Completion was not recorded, so the next load `
      + `runs it again; to run it now: `
      + `game.modules.get("${SCOPE}").api.migrations.vehicleHullFrames()`, e);
  }
  return { actors, tokens, skipped: false };
}
