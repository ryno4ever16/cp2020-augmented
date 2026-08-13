/**
 * vehicle-cover.js — a parked vehicle is cover, and shooting through it wrecks it.
 *
 * RULED 2026-08-12 (VEHICLE-COVER-REGIONS-DESIGN.md, D1 = Option A):
 *   The vehicle handle token IS the cover object. There are no regions to place, nothing to
 *   attach, nothing to clean up when the car drives away — a shot whose line crosses a deployed
 *   vehicle's footprint is resolved through it, exactly as it already is through a cover zone or a
 *   flagged wall. Deploying the vehicle IS the placement (placement = consent, so there is no
 *   toggle in front of it).
 *
 * WHAT IT STOPS (Core p.99 "COMMON COVER SPS", ruled D2):
 *   Which SP the shot meets depends on WHERE it crossed, because the book's table separates the
 *   two: Car Body/Door 10 (Armored Car / AV-4 Body 40) versus Engine Block 35. So the footprint's
 *   ENGINE cells are worth 35 and everything else is body, and a line clipping both is stopped by
 *   the higher of the two — the engine block it crossed does not stop being an engine block
 *   because the shot also grazed a door. Bikes contribute nothing at all (ruled): a motorcycle is
 *   a frame and two wheels, and the book prints no body row for one.
 *
 * WHAT IT COSTS THE VEHICLE (ruled D3):
 *   The debit lands on the vehicle's REAL SDP, not a separate cover pool. Maximum Metal p.58
 *   reserves its 3 × SP invention for objects with no printed structure; a vehicle has printed
 *   structure, so suppressive fire through a parked car wears down the same number its own damage
 *   model reads, and a wreck stops being cover the moment that number reaches zero (the design's
 *   own wording: "a destroyed vehicle stops contributing cover").
 *
 * ⚠ A vehicle with NO printed SDP at all (sdp.max 0 — a hand-made blank) still provides cover but
 * is deliberately NOT chewable: its row carries no uuid, which is the same "cover applies, nothing
 * is debited" path a hand-typed Cover SP already takes. Writing a structure total onto an actor
 * that never had one would be inventing the vehicle's stats out of the cover system.
 */

import { localizeParam } from "../utils.js";
import { footprintCells } from "./vehicle-seating.js";
import { layoutFor, coverSpFor, segmentHitsRect } from "./vehicle-layout.js";
import { isVehicleTokenDoc } from "./vehicle-canvas.js";

const SCOPE = "cp2020-augmented";
const VEHICLE_ACTOR_TYPE = "cp2020-augmented.vehicle";

/** v13/v14-safe template renderer (the module-wide shim). */
function renderTpl(path, data) {
  const render = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  return render(path, data);
}

/**
 * Every deployed vehicle on a scene, as a cover row in the same shape zones and walls use
 * (uuid / label / sp / pool / poolMax / destroyed / center), plus the footprint geometry the
 * segment test needs. `sp` starts at the body value — the answer for a vehicle nobody has drawn a
 * line through yet; vehicleCoverSpAlong raises it to the engine block when a line crosses one.
 */
export function vehicleCoverRowsOn(scene) {
  const out = [];
  const grid = scene?.grid?.size ?? canvas?.scene?.grid?.size ?? 100;
  for (const tokenDoc of scene?.tokens ?? []) {
    if (!isVehicleTokenDoc(tokenDoc)) continue;
    const actor = tokenDoc.actor;
    if (!actor || actor.type !== VEHICLE_ACTOR_TYPE) continue;
    const system = actor.system ?? {};
    const { providesCover, bodySp, engineSp } = coverSpFor(system);
    if (!providesCover || bodySp <= 0) continue;

    const w = Math.max(1, Math.round(Number(tokenDoc.width) || 1));
    const h = Math.max(1, Math.round(Number(tokenDoc.height) || 1));
    const rect = { x: tokenDoc.x, y: tokenDoc.y, w: w * grid, h: h * grid };
    const sdpMax = Math.max(0, Math.round(Number(system.sdp?.max) || 0));
    const tracked = sdpMax > 0;
    const pool = tracked ? Math.max(0, Math.round(Number(system.sdp?.value) || 0)) : 0;

    out.push({
      vehicle: true,
      actor, tokenDoc,
      // No uuid when there is no structure to charge — makeCoverLedger reads that as "apply the SP,
      // debit nothing", which is exactly the honest answer for a vehicle with no printed SDP.
      uuid: tracked ? actor.uuid : "",
      label: actor.name,
      sp: bodySp,
      bodySp, engineSp,
      pool, poolMax: tracked ? sdpMax : 0,
      destroyed: tracked ? (pool <= 0 || system.destroyed === true) : false,
      center: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
      rect, grid,
      engineCells: layoutFor(w, h, system.layout?.front, system.layout?.cells).engine,
      footprint: { w, h },
    });
  }
  return out;
}

/**
 * What the line a→b actually meets inside this vehicle: the highest SP among the cells it crosses,
 * and whether an engine cell was one of them. `{sp: 0}` when the line misses the footprint
 * entirely, which is how the caller decides the vehicle is not on the shot at all.
 * @returns {{sp:number, engine:boolean}}
 */
export function vehicleCoverSpAlong(row, a, b) {
  if (!row || !a || !b) return { sp: 0, engine: false };
  const cells = footprintCells(row.rect, row.grid);
  const engineSet = new Set(row.engineCells ?? []);
  let sp = 0, engine = false;
  for (let i = 0; i < cells.length; i++) {
    const cell = { x: cells[i].x, y: cells[i].y, w: row.grid, h: row.grid };
    if (!segmentHitsRect(a, b, cell)) continue;
    const isEngine = engineSet.has(i);
    const cellSp = isEngine ? row.engineSp : row.bodySp;
    if (cellSp > sp) { sp = cellSp; engine = isEngine; }
    else if (cellSp === sp && isEngine) engine = true;
  }
  return { sp, engine };
}

/**
 * The row label a crossed vehicle carries into the apply window and the chew card. A body hit is
 * just the vehicle's name; an engine hit says so, because 35 versus 10 is a large enough difference
 * that a GM reading the line deserves to know which part of the car stopped the round.
 */
export function vehicleCoverLabel(row, engine) {
  const name = row?.actor?.name ?? row?.label ?? "";
  return engine ? localizeParam("Vehicle.CoverEngineLabel", { name }) : name;
}

/**
 * Debit a vehicle's structure for what a burst put through it (GM-side write) — the vehicle
 * counterpart of chewCoverZone / chewCoverWall, with the same lifecycle: exact debit, one document
 * write, one card, idempotent once the vehicle is already wrecked. The card is the shared cover
 * chew card; a vehicle's "structure" line is its SDP, which is the number it was already reading.
 */
export async function chewVehicleCover({ actorUuid, damage, weaponName = "", rounds = null, destroyedAtRound = 0, label = "" }) {
  const actor = await fromUuid(actorUuid);
  if (!actor || actor.type !== VEHICLE_ACTOR_TYPE) return null;
  const system = actor.system ?? {};
  const poolMax = Math.max(0, Math.round(Number(system.sdp?.max) || 0));
  if (poolMax <= 0) return null;                       // nothing printed to charge (see the header)
  const before = Math.max(0, Math.round(Number(system.sdp?.value) || 0));
  if (before <= 0) return { pool: 0, destroyed: true, already: true };

  const dmg = Math.max(0, Math.round(Number(damage) || 0));
  if (dmg <= 0) return { pool: before, destroyed: false };
  const pool = Math.max(0, before - dmg);
  const destroyed = pool <= 0;

  await actor.update({ "system.sdp.value": pool });

  const name = label || actor.name;
  const content = await renderTpl(`modules/${SCOPE}/templates/chat/cover-chew.hbs`, {
    label: name, damage: dmg, pool, poolMax, destroyed, weaponName,
    ...vehicleBurstLines({ rounds, destroyedAtRound, label: name, poolMax }),
  });
  await ChatMessage.create({ content });
  return { pool, destroyed };
}

/**
 * Round-by-round wear lines for the card, pre-localized here (the render edge) so the shared
 * template stays a plain {{#each}}. Mirrors cover.js's burstLines — a single unrecorded debit
 * posts exactly the card it always did.
 */
function vehicleBurstLines({ rounds, destroyedAtRound, label, poolMax }) {
  const list = Array.isArray(rounds) ? rounds : [];
  if (list.length < 2) return {};
  return {
    roundLines: list.map(r => localizeParam("CoverChewRoundLine", {
      round: r.round, damage: r.absorbed, pool: r.poolAfter, poolMax,
    })),
    brokeLine: destroyedAtRound > 0
      ? localizeParam("CoverChewBrokeAtRound", { name: label, round: destroyedAtRound })
      : "",
  };
}

/** Is this uuid a vehicle actor? The chew dispatcher's test, kept beside the handler it routes to. */
export function isVehicleCoverUuid(doc) {
  return doc?.documentName === "Actor" && doc?.type === VEHICLE_ACTOR_TYPE;
}

/** The vehicle a token is riding in, or null. Used to keep a shooter's own car off their own shot. */
export function boardedVehicleIdOf(tokenDoc) {
  const id = tokenDoc?.flags?.[SCOPE]?.boardedVehicle;
  return (typeof id === "string" && id) ? id : null;
}
