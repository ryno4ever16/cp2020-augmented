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
import { layoutFor, coverSpFor, segmentHitsRect, segmentIntoLocalFrame } from "./vehicle-layout.js";
import { isVehicleTokenDoc, tokenHeadingOf, hullRectOf } from "./vehicle-canvas.js";

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

    // The cover geometry is the HULL, not the token's frame square. Measuring the square would give
    // a car a metre of bulletproof pavement on each side of itself: the frame exists so the core's
    // upright box can hold a turned vehicle, and it is not part of the vehicle.
    const { rect, hull } = hullRectOf(tokenDoc, grid);
    const w = hull.w, h = hull.h;
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
      // The token's own rotation IS the vehicle's heading on the map — read straight, at whatever
      // angle the GM's gesture produced, with no snapping of ours in front of it.
      rotation: tokenHeadingOf(tokenDoc),
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
  // A turned vehicle is handled by turning the SHOT, not the car: both endpoints go back into the
  // vehicle's own frame once, and every cell test below is the plain axis-aligned one again.
  const local = segmentIntoLocalFrame(a, b, row.rect, row.rotation);
  a = local.a; b = local.b;
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

/* ─────────────────────────────── rider cover (ruled D4 / L3) ─────────────────────────────── */

/**
 * How much of a vehicle its own riders get to hide behind.
 *
 * Maximum Metal states this as a fraction of the TIME rather than a fraction of the body: the
 * Riot 8 is open-topped and "troops inside it only receive SP cover 75% of the time"; the Airjeep's
 * "riders only count as in cover 50% of the time." So the two open presets are a per-attack
 * question, not a modifier — which is why the seed rolls it once per apply window and says out loud
 * which way it landed. An enclosed vehicle always covers its riders; an open frame never does.
 */
export const RIDER_COVER_MODES = ["enclosed", "75", "50", "none"];

/** The mode in force: the sheet's choice, else the vehicle type's own answer. */
export function riderCoverModeFor(system) {
  const stored = String(system?.layout?.riderCover ?? "").trim();
  if (RIDER_COVER_MODES.includes(stored)) return stored;
  return derivedRiderCoverFor(system?.vehicleType);
}

/**
 * The default by type. Every modelled type is an enclosed cabin except a cycle, which has no cabin
 * at all. The book's two OPEN examples (Riot 8, Airjeep) are individual vehicles rather than a
 * class — there is no "open-topped" vehicle type to key off — so 75/50 are presets a GM picks per
 * vehicle rather than something a type is silently given.
 */
export function derivedRiderCoverFor(vehicleType) {
  return String(vehicleType ?? "").trim() === "cycle" ? "none" : "enclosed";
}

/** The percentage a mode covers at, or null for the modes that never roll. */
export function riderCoverChance(mode) {
  if (mode === "75") return 75;
  if (mode === "50") return 50;
  return null;
}

/**
 * One coverage draw, 1-100. Synchronous, because the apply window builds its context
 * synchronously and a private determination like this has no card to post — the OUTCOME is what
 * gets surfaced, in the window itself, where it can be overridden.
 *
 * ⚠ It draws from `CONFIG.Dice.randomUniform` — core's own uniform source, the one every die face
 * is drawn from — rather than through a Roll. Rig-proven on core 14.364: `Roll#evaluateSync` does
 * not evaluate a DICE term at all and answers a total of 0, which sailed under a `|| 0` and made
 * every rider "covered" on every attack. A draw that always returns the same answer is worse than
 * no roll at all, so the die comes straight off the RNG the core exposes, with Math.random as the
 * fallback if a future core stops exposing it.
 */
export function rollCoverageDie() {
  let u = NaN;
  try { u = Number(CONFIG?.Dice?.randomUniform?.()); } catch (e) { /* fall through */ }
  if (!Number.isFinite(u) || u < 0 || u > 1) u = Math.random();
  return Math.min(100, Math.max(1, Math.ceil(u * 100)));
}

/**
 * Decide whether the vehicle covers its own rider for THIS attack.
 *
 * ⚠ IT RETURNS THE VERDICT, NOT THE WORDS — the caller composes the label, because the label needs
 * the row's FINAL name (which part of the vehicle the line crossed) and that is not settled until
 * the geometry has run. See `riderCoverRowLabel`.
 *
 * @returns {{covered:boolean, chance:number|null, roll:number|null}}
 */
export function resolveRiderCover(row, mode) {
  if (mode === "none") return { covered: false, chance: null, roll: null };
  if (mode !== "75" && mode !== "50") return { covered: true, chance: null, roll: null };
  const chance = riderCoverChance(mode);
  const roll = rollCoverageDie();
  return { covered: roll <= chance, chance, roll };
}

/**
 * The cover row's own LABEL, carrying the per-attack verdict — "Riot 8 — covered this attack (75%)".
 *
 * ⭐ THE VERDICT BELONGS IN THE ROW'S NAME (user ruling 2026-08-13). It was first shown as a separate
 * sentence beside the Cover SP field, which made this one cover row read differently from every other
 * one: a wall, a zone and a vehicle all state what they are in their own label, and only this row had
 * its statement parked somewhere else. The user's question settles it — "shouldn't it be treated the
 * same as any other cover row?"
 *
 * ⛔ IT IS A DISPLAY LABEL AND ONLY A DISPLAY LABEL. What a round COSTS the vehicle is a fact about
 * the vehicle, not about one attack's coverage roll, so the chew receipt keeps the clean name and this
 * string never reaches it — otherwise a wear card would read "Riot 8 — covered this attack (75%)
 * absorbed 12 damage", which is the deviation this ruling replaces rather than a reason for it. The
 * two names live in two fields (`label` clean, `displayLabel` decorated) precisely so neither can be
 * mistaken for the other.
 *
 * The exposed form names no percentage: a roll that went the other way is not a coverage the row has.
 */
export function riderCoverRowLabel(baseLabel, verdict) {
  if (!verdict || verdict.chance === null) return String(baseLabel ?? "");
  return verdict.covered
    ? localizeParam("Vehicle.RiderCoveredThisAttack", { name: baseLabel, pct: verdict.chance })
    : localizeParam("Vehicle.RiderExposedThisAttack", { name: baseLabel });
}
