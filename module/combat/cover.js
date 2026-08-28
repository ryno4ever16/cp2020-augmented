/**
 * Cover engine (unified cover system, Unit 1).
 *
 * Cover zones are native Regions carrying the CoverZoneBehavior (cover-zone-behavior.js) — the
 * fourth zone vertical, and the first PASSIVE one: nothing here subscribes to events or round
 * ticks. The damage pipeline QUERIES zones (the Apply Damage window resolves which object the shot
 * crossed) and, as the burst's rounds resolve through one, DEBITS its structure pool here ("chew").
 *
 * Chew rule (Maximum Metal p.58, read from the printed text): the pool is the object's hit
 * points — SDP = 3 × SP by default — and the book's examples count damage RECEIVED against it
 * ("a 10SP concrete block wall which has received 30pts SDP … has had the block shattered").
 * SP stays constant while the object stands; at pool 0 the zone is destroyed and contributes
 * nothing. The GM can scale poolMax for massiveness (the book's ×4/×5 or ×1 note). The pool is
 * worn down ROUND BY ROUND inside the damage loop (makeCoverLedger), so a burst can break an
 * object part-way through and leave its own later rounds unobstructed.
 *
 * State legibility is COLOR + CARDS, zero custom canvas rendering: the module drives the region
 * color through three bands (intact amber → chewed orange → destroyed gray) and posts a chew
 * card on every debit. Placement is native-first (the radiation lesson): the GM tool — which sits with
 * the REGION controls, because a cover zone is a Region — takes the book preset's values, then hands the
 * drawing back to the platform. The next region the GM draws with any native shape tool becomes that
 * cover, geometry untouched. (Or the GM hand-authors a Region and adds the behavior; or an API caller
 * uses `placeCoverZone`, which still drops a ready-made rectangle at the view centre.)
 *
 * Writes (chew) are active-GM gated with a socket relay for non-GM appliers — the same rail as
 * every other zone write in the module.
 *
 * Unit 3 (walls/doors): native Wall documents can carry the SAME cover data as a zone, stored as
 * wall flags (coverSp / coverPool / coverPoolMax) and edited through fields this module adds to
 * the native Wall configuration sheet. Flagged walls sit alongside zones in every query here —
 * the rows carry a uuid either way, and the chew entry point dispatches on the resolved document
 * type. Cover flags are meant for walls a shot can
 * cross (windows, thin barriers, doors — walls that do NOT block sight); a DOOR wall whose
 * structure reaches 0 is broken open (door state → open), so the barrier and sightline open
 * with it. Non-door walls at 0 simply stop contributing (the map art stays).
 */

import { localize, localizeParam, deleteFieldUpdate } from "../utils.js";
import { onGlobalClick } from "../popout-compat.js";
import { COVER_ZONE_BEHAVIOR } from "./cover-zone-behavior.js";
// The NAKED half of the area split (see areaCoverVerdict): a move-blocking wall with no cover values
// on it. area-shapes.js owns that test because the presentation rail needs it without reaching the
// damage pipeline; this file owns the VALUED half and asks that one only after its own has answered.
import { areaOcclusionTest } from "./area-shapes.js";
import {
  vehicleCoverRowsOn, vehicleCoverSpAlong, vehicleCoverLabel, chewVehicleCover,
  isVehicleCoverUuid, boardedVehicleIdOf, riderCoverModeFor, resolveRiderCover, riderCoverRowLabel,
} from "../vehicle/vehicle-cover.js";
// Which HANDLE a rider is in — not just which vehicle. Two tokens of one vehicle on a canvas are
// two separate pieces of bodywork, and only the one somebody is actually sitting in is theirs.
import { riderVehicleTokenIdOn } from "../vehicle/vehicle-canvas.js";
import { isPrimaryGMSession } from "../gm-session-primary.js";

const SCOPE = "cp2020-augmented";
const MSG_CHEW = "coverChew";
/** The breach-undo relay (2026-08-26). Same channel and type-dispatch shape as the chew. */
const MSG_REPAIR = "coverRepair";

/** v13/v14-safe template renderer (the module-wide shim). */
function renderTpl(path, data) {
  const render = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  return render(path, data);
}

/* ══════════════════════════ Book presets (Core "Common Cover SPs") ══════════════════════════ */

/**
 * Core rulebook "COMMON COVER SPS" table, entered from the PDF text layer. Labels stay the
 * book's own strings (catalog practice — item names aren't localized either). Pool = 3 × SP
 * (MM p.58) unless the GM edits it.
 */
export const COVER_PRESETS = [
  { key: "sheetrock-wall",      label: "Sheetrock Wall",        sp: 5  },
  { key: "wood-door",           label: "Wood Door",             sp: 5  },
  { key: "concrete-block-wall", label: "Concrete Block Wall",   sp: 10 },
  { key: "car-body",            label: "Car Body, Door",        sp: 10 },
  { key: "heavy-wood-door",     label: "Heavy Wood Door",       sp: 15 },
  { key: "steel-door",          label: "Steel Door",            sp: 20 },
  { key: "brick-wall",          label: "Brick Wall",            sp: 25 },
  { key: "data-term",           label: "Data Term",             sp: 25 },
  { key: "mailbox",             label: "Mailbox",               sp: 25 },
  { key: "curb",                label: "Curb",                  sp: 25 },
  { key: "stone-wall",          label: "Stone Wall",            sp: 30 },
  { key: "tree-phone-pole",     label: "Tree, Phone Pole",      sp: 30 },
  { key: "concrete-pole",       label: "Concrete Utility Pole", sp: 35 },
  { key: "engine-block",        label: "Engine Block",          sp: 35 },
  { key: "hydrant",             label: "Hydrant",               sp: 35 },
  { key: "armored-car-body",    label: "Armored Car Body",      sp: 40 },
  { key: "av4-body",            label: "AV-4 Body",             sp: 40 },
];

/** Default structure multiplier (MM p.58: SDP = 3 × SP for objects with no printed SDP). */
export const COVER_POOL_MULT = 3;

/**
 * ⭐⭐ STRUCTURE IS AN OPT-IN, AND ENTERING IT IS THE CONSENT (user ruling 2026-08-26 — the
 * action-as-consent design). Read this before touching any pool arithmetic in this file.
 *
 * There are TWO cover models in the books and the module now ships both, selected by what the GM
 * actually typed rather than by a world switch:
 *
 *   **CORE mode — an SP and nothing else** (Core p.103, "Common Cover SPs"). The object soaks: its SP
 *   folds as the outermost armour layer exactly as it always has. It NEVER chews, NEVER destroys and
 *   NEVER breaches. There is no pool, no structure card, no repair button. This is the whole of what
 *   the core rulebook prints, and a table that has never opened Maximum Metal gets it by default.
 *
 *   **MAXIMUM METAL mode — an SP *and* a structure value** (MM p.58, "SDP for Cover Objects"). The
 *   full lifecycle: the pool is charged the damage received, the object is destroyed at 0, a wall
 *   BREACHES when it goes (its move/sight/sound restrictions open) and the destruction card carries a
 *   one-click repair.
 *
 * ⚠⚠ THIS FLIPS THE PREVIOUS DEFAULT, deliberately and with the sweep done. Until today a valued wall
 * carrying a BLANK structure field silently inherited `3 × SP` and entered the MM lifecycle without
 * anybody choosing it — so a GM who had only ever read the core rulebook's cover table could watch a
 * door they priced at SP 5 shatter under a rule from a book they do not own. Blank now means
 * PERMANENT. The 3 × SP figure did not go away; it is PREFILLED VISIBLY into the form instead (the
 * wall fieldset's SP handler and the placement dialog's preset picker both write it into the input
 * where the GM can see it), so the MM lifecycle is one keystroke away and opting OUT of it is one
 * keystroke too — blank the field.
 *
 * HOW A ROW SAYS WHICH MODE IT IS IN: every row this file produces carries `structured`.
 *   - a WALL is structured when a real stored NUMBER is on `coverPool` or `coverPoolMax`;
 *   - a ZONE is structured when its `poolMax` is above zero (the behavior schema's NumberField cannot
 *     hold a blank, so zero is the "no structure" value — see cover-zone-behavior.js);
 *   - a VEHICLE row carries its own printed structure and never sets the field, which is why every
 *     consumer below tests `structured !== false` rather than truthiness: only an EXPLICIT core-mode
 *     row stands the ledger down, and a row shape that predates this field behaves exactly as it did.
 * An unstructured row reports `pool: 0, poolMax: 0, destroyed: false` — ⛔ `pool <= 0` is NOT
 * "destroyed" for it, which is why `destroyed` is computed here and never re-derived by a caller.
 */
export const COVER_MODE_CORE = "core";   // SP only — soaks, never chews (Core p.103)
export const COVER_MODE_MM   = "mm";     // SP + structure — the full lifecycle (Maximum Metal p.58)

/** Which of the two models a resolved cover row is in. Never compare `structured` by hand. */
export function coverModeOf(row) {
  return (row && row.structured === false) ? COVER_MODE_CORE : COVER_MODE_MM;
}

/** Does this row keep a structure ledger at all? The one predicate every chew site asks. */
export function coverChews(row) {
  return coverModeOf(row) === COVER_MODE_MM;
}

/* ══════════════════════════════════ Zone access / queries ══════════════════════════════════ */

/** Normalized rows for every enabled cover-zone behavior on a scene. */
export function coverZonesOn(scene) {
  const out = [];
  for (const region of scene?.regions ?? []) {
    for (const behavior of region.behaviors ?? []) {
      if (behavior.type !== COVER_ZONE_BEHAVIOR || behavior.disabled) continue;
      const s = behavior.system ?? {};
      // THE ZONE'S OPT-IN SIGNAL (see COVER_MODE_CORE): the behavior schema's NumberFields are
      // `required` with a minimum of zero, so a zone cannot hold a BLANK the way a wall flag can —
      // zero total structure is the value that says "no structure ledger". A zone whose total is
      // above zero is in the MM lifecycle exactly as it was.
      const poolMax = Math.max(0, Number(s.poolMax) || 0);
      const structured = poolMax > 0;
      const pool = structured ? Math.max(0, Number(s.pool) || 0) : 0;
      out.push({
        region, behavior,
        uuid: behavior.uuid,
        label: region.name || localize("CoverZoneFallbackName"),
        sp: Number(s.sp) || 0,
        pool, poolMax, structured,
        // ⛔ `pool <= 0` is only destruction for a STRUCTURED row. A core-mode zone reports a pool of
        // zero because it has no pool, and reading that as rubble would delete the one thing it does.
        destroyed: structured && (!!s.destroyed || pool <= 0),
      });
    }
  }
  return out;
}

/**
 * Normalized rows for every cover-flagged wall on a scene (Unit 3). A wall is cover when its
 * coverSp flag is a positive number.
 *
 * ⚠⚠ STRUCTURE IS NO LONGER DEFAULTED HERE (2026-08-26 — read COVER_MODE_CORE above for the ruling
 * and the flip it makes). A wall carrying an SP and NO stored structure number is CORE cover: it
 * soaks and it is permanent. Only a real stored NUMBER on `coverPool` or `coverPoolMax` opts the wall
 * into the Maximum Metal lifecycle. A cleared form field submits null, which is not a number, so
 * blanking the field in the wall sheet is the opt-OUT gesture and must not read as "destroyed at 0".
 *
 * ⏪ THE REVERT, if the silent default is ever wanted back, is the pair of lines this replaced:
 *   poolMax = <stored, if a positive number> else `sp * COVER_POOL_MULT`
 *   pool    = <stored, if a number>          else poolMax
 * with `structured` forced true. The 3 × SP figure itself is not gone — it is prefilled into the
 * form by `registerCoverWallConfig` and by the placement dialog, where the GM can see and refuse it.
 */
export function coverWallsOn(scene) {
  const out = [];
  for (const wall of scene?.walls ?? []) {
    const f = wall.flags?.[SCOPE] ?? {};
    const sp = Math.max(0, Number(f.coverSp) || 0);
    if (sp <= 0) continue;
    const storedMax = (typeof f.coverPoolMax === "number" && Number.isFinite(f.coverPoolMax) && f.coverPoolMax > 0)
      ? Math.round(f.coverPoolMax) : null;
    const storedPool = (typeof f.coverPool === "number" && Number.isFinite(f.coverPool))
      ? Math.max(0, Math.round(f.coverPool)) : null;
    const structured = storedMax !== null || storedPool !== null;
    // A wall carrying only a REMAINING structure (the shape a mid-fight chew leaves if the total is
    // ever cleared by hand) takes that number as its own total, so the band colouring and the repair
    // have a ceiling to work against rather than dividing by zero.
    const poolMax = structured ? (storedMax ?? storedPool ?? 0) : 0;
    const pool = structured ? (storedPool ?? poolMax) : 0;
    const isDoor = (wall.door ?? 0) > 0;
    // A wall document has no name of its own. The retired material field is still READ here so
    // walls named before it was removed keep their label; everything else falls back to the
    // generic wall/door name.
    const material = (typeof f.coverMaterial === "string") ? f.coverMaterial.trim() : "";
    const c = wall.c ?? [];
    out.push({
      wall,
      uuid: wall.uuid,
      label: material || localize(isDoor ? "CoverWallDoorFallbackName" : "CoverWallFallbackName"),
      sp, pool, poolMax, structured,
      // ⛔ STRUCTURED ONLY. An SP-only wall reports a pool of zero because it HAS no pool; reading
      // that as destruction would make every core-mode barrier arrive on the table pre-shattered.
      destroyed: structured && pool <= 0,
      isDoor,
      // Whether this wall is standing open because its structure gave out — the flag the repair
      // reads, surfaced on the row so a caller can say "breached" without a second document read.
      breached: !!f.coverBreach,
      center: (c.length >= 4) ? { x: (c[0] + c[2]) / 2, y: (c[1] + c[3]) / 2 } : null,
    });
  }
  return out;
}

/** Approximate centre of a region (mean of its shapes' bounding-box centres; null when unknowable). */
function _regionCenter(region) {
  const shapes = region?.shapes ?? [];
  if (!shapes.length) return null;
  let sx = 0, sy = 0, n = 0;
  for (const s of shapes) {
    if (typeof s.x === "number" && typeof s.width === "number") {
      sx += s.x + s.width / 2; sy += s.y + (s.height ?? 0) / 2; n++;
    } else if (Array.isArray(s.points) && s.points.length >= 2) {
      let px = 0, py = 0;
      for (let i = 0; i < s.points.length - 1; i += 2) { px += s.points[i]; py += s.points[i + 1]; }
      sx += px / (s.points.length / 2); sy += py / (s.points.length / 2); n++;
    }
  }
  return n ? { x: sx / n, y: sy / n } : null;
}

/** Centre of a token document in scene pixels. */
function _tokenCenter(tokenDoc) {
  const grid = tokenDoc?.parent?.grid?.size ?? canvas?.scene?.grid?.size ?? 100;
  return {
    x: (tokenDoc?.x ?? 0) + ((tokenDoc?.width ?? 1) * grid) / 2,
    y: (tokenDoc?.y ?? 0) + ((tokenDoc?.height ?? 1) * grid) / 2,
  };
}

/** Candidate cover rows for a target token's scene — zones, cover-flagged walls AND deployed
 *  vehicles, nearest first (unknown-centre rows last). Every row carries a uuid the chew entry
 *  point dispatches on, except a vehicle with no printed structure, which is cover that cannot be
 *  charged (see vehicle-cover.js). */
export function coverChoicesFor(tokenDoc) {
  const scene = tokenDoc?.parent ?? canvas?.scene;
  const rows = [...coverZonesOn(scene), ...coverWallsOn(scene), ...vehicleCoverRowsOn(scene)];
  const { x: tx, y: ty } = _tokenCenter(tokenDoc);
  for (const r of rows) {
    const c = r.center ?? _regionCenter(r.region);
    r.d2 = c ? (c.x - tx) ** 2 + (c.y - ty) ** 2 : Number.POSITIVE_INFINITY;
  }
  return rows.sort((a, b) => a.d2 - b.d2);
}

/* ═════════════════════════════ Segment auto-detect (Unit 4) ═════════════════════════════ */

/**
 * The cover rows actually CROSSED by the shot line from the attacker's token to the target's
 * token. Wall rows use an exact segment-vs-segment test; zone rows sample the line at
 * quarter-grid steps through the native region containment test — the platform owns the
 * geometry either way. The first half-grid at the ATTACKER'S end is trimmed off the line: the
 * shooter's own adjacent cover doesn't block their outgoing shot, while cover adjacent to the
 * target is exactly what should be found. Destroyed rows are never returned. Order inherits
 * coverChoicesFor's nearest-to-target-first sort, so [0] is the natural auto-pick.
 */
export function coverBetween(attackerTokenDoc, targetTokenDoc) {
  const scene = targetTokenDoc?.parent ?? canvas?.scene;
  if (!attackerTokenDoc || !targetTokenDoc || !scene) return [];
  const grid = scene.grid?.size ?? 100;
  const a = _tokenCenter(attackerTokenDoc);
  const b = _tokenCenter(targetTokenDoc);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(len > 0)) return [];
  const t0 = Math.min(0.4, (grid / 2) / len);
  const o = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 };

  // A vehicle is never cover for the shot it is part of: not the car being aimed at, not the car
  // the shooter is sitting in, not the car doing the shooting. Without these three the first
  // vehicle-mounted burst would be stopped by its own bodywork.
  // ⛔ THE SHOOTER'S OWN HANDLE, not every copy of their vehicle. Matched on the vehicle ACTOR this
  // also excused an IDENTICAL truck parked across the street from stopping the shot, because it
  // shares the actor. The rider's own record names exactly one handle (2026-08-25 sweep).
  const attackerVehicleId = boardedVehicleIdOf(attackerTokenDoc);
  const attackerHandleId = attackerVehicleId
    ? riderVehicleTokenIdOn(attackerTokenDoc?.parent, attackerTokenDoc) : null;
  const excludedVehicle = (row) => row.tokenDoc?.id === targetTokenDoc.id
    || row.tokenDoc?.id === attackerTokenDoc.id
    || (!!attackerHandleId && row.tokenDoc?.id === attackerHandleId);

  // The vehicle the TARGET is riding in is the rider-cover case (ruled D4): it is cover for them,
  // but only as much of the time as its own bodywork allows. A row that loses that roll is still
  // returned — at SP 0, and LAST, so it neither hides a real crossing nor resolves silently.
  // Same correction for the rider-cover case: the bodywork that covers a rider is the bodywork they
  // are inside, not any vehicle that happens to share its actor.
  const targetVehicleId = boardedVehicleIdOf(targetTokenDoc);
  const targetHandleId = targetVehicleId
    ? riderVehicleTokenIdOn(targetTokenDoc?.parent, targetTokenDoc) : null;

  const out = [];
  const exposed = [];
  for (const r of coverChoicesFor(targetTokenDoc)) {
    if (r.destroyed) continue;
    let crossed = false;
    // The rider-cover draw for THIS row, when one was made. Held so the row's name can be composed
    // once, after the geometry has finished deciding what to call it.
    let riderVerdict = null;
    try {
      if (r.vehicle) {
        if (excludedVehicle(r)) continue;
        if (!!targetHandleId && r.tokenDoc?.id === targetHandleId) {
          const mode = riderCoverModeFor(r.actor.system);
          if (mode === "none") continue;               // an open frame hides nobody
          const verdict = resolveRiderCover(r, mode);
          if (!verdict.covered) {
            r.sp = 0;
            // The row still says what happened, in its own name — see riderCoverRowLabel. An exposed
            // row never reaches the geometry below, so its label is final here.
            r.displayLabel = riderCoverRowLabel(r.label, verdict);
            exposed.push(r);
            continue;
          }
          // A covered row goes on to the geometry, which may rename it after the part the line
          // crossed ("… — engine block"). The verdict is folded in AFTER that, so the row's name
          // reads in the order it was decided.
          riderVerdict = verdict;
        }
        // WHICH cells the line crossed decides the SP, so the row's own numbers are settled here
        // rather than at row-build time: body 10 unless it went through the engine block, 35 if it
        // did. The label follows, because a 35 that does not say "engine block" reads as a typo.
        const hit = vehicleCoverSpAlong(r, o, b);
        if (hit.sp > 0) {
          r.sp = hit.sp;
          r.engine = hit.engine;
          r.label = vehicleCoverLabel(r, hit.engine);
          crossed = true;
        }
      } else if (r.wall) {
        const c = r.wall.c ?? [];
        crossed = c.length >= 4
          && !!foundry.utils.lineSegmentIntersects(o, b, { x: c[0], y: c[1] }, { x: c[2], y: c[3] });
      } else if (typeof r.region?.testPoint === "function") {
        const steps = Math.min(200, Math.max(2, Math.ceil(Math.hypot(b.x - o.x, b.y - o.y) / (grid / 4))));
        const elevation = targetTokenDoc.elevation ?? 0;
        for (let i = 0; i <= steps && !crossed; i++) {
          const t = i / steps;
          // One call form for both cores: v13's testPoint(point, elevation) reads the second
          // argument; v14's testPoint(point) reads point.elevation and ignores extras. Omitting
          // elevation from the point object makes v14 test `undefined` and answer false for
          // EVERY point — a silent zone-detection kill (rig-proven).
          crossed = !!r.region.testPoint(
            { x: o.x + (b.x - o.x) * t, y: o.y + (b.y - o.y) * t, elevation },
            elevation,
          );
        }
      }
    } catch (e) { crossed = false; }
    if (crossed) {
      // The row's DISPLAY name, settled last so it carries whatever the geometry decided to call the
      // row plus the per-attack verdict when there was one. `label` stays the clean name — it is what
      // the wear receipt is written against (see riderCoverRowLabel).
      if (riderVerdict) r.displayLabel = riderCoverRowLabel(r.label, riderVerdict);
      out.push(r);
    }
  }
  // Anything a rider was exposed to this attack trails the real crossings: it carries no SP, only a
  // name that says the roll happened and which way it went.
  return [...out, ...exposed];
}

/**
 * ⭐⭐ THE AIMED SHOT'S VERDICT — valued cover, or a wall the round never got past.
 *
 * ⛔ THE GAP THIS CLOSES (user field report 2026-08-27, hypothesis "only shotguns stop": correct).
 * `coverBetween` above can only see rows somebody VALUED — it walks `coverChoicesFor`, which is built
 * from cover zones, walls carrying `coverSp`, and deployed vehicles. A plain move-blocking wall with no
 * cover values is in none of those lists, so it was in nothing the aimed path ever asked about, and an
 * aimed round crossed it as if it were not on the map. The AREA paths never had that gap — they ask
 * `areaCoverVerdict`, which falls through to the naked-wall test — which is exactly why the table saw
 * pattern weapons stopped by a wall and aimed fire sail through the same wall in the same firefight.
 *
 * SAME SPLIT, SAME ORDER, SAME HELPER as `areaCoverVerdict` twenty lines below, deliberately: a second
 * notion of "blocking" would exempt against one wall and soak against another.
 *   SOAKED — something valued is on the line. Unchanged in every particular: `rows` is `coverBetween`'s
 *            own answer in its own order, so the Apply window's seed is the row it always picked.
 *   EXEMPT — nothing valued, and a move-blocking wall stands between the two figures. The round did not
 *            reach the body.
 *   IN     — a clear line.
 *
 * ⛔ NO ORIGIN TRIM ON THE NAKED HALF, and that is a decision rather than an oversight. `coverBetween`
 * trims the first half-grid at the shooter's end so their own adjacent cover cannot block their outgoing
 * shot, and a valued row keeps that trim here. The naked test does NOT get it: the case it exists for is
 * a shooter INSIDE a closed room firing at somebody outside it, where the blocking wall is by
 * construction the one at their elbow — trimming it away would answer "clear line" for the very shape
 * the report is about. The area path makes the same choice (it tests from the blast's own point with no
 * trim), and the referee's override below is what covers the shot this reads too strictly.
 *
 * ⚠ GATED BY THE AREA-OCCLUSION SWITCH, because `areaOcclusionTest` reads it itself. A table that turned
 * that off has said walls do not interact with shots, and this half honours it for the same reason the
 * area half does. The VALUED half stays ungated, exactly as it was — placing a cover object IS the opt-in.
 *
 * @returns {{state:string, row:object|null, sp:number, rows:object[]}}
 */
export function aimedCoverVerdict(attackerTokenDoc, targetTokenDoc) {
  const rows = coverBetween(attackerTokenDoc, targetTokenDoc);
  const valued = rows.filter(r => (Number(r.sp) || 0) > 0);
  if (valued.length) {
    return { state: AREA_COVER_SOAKED, row: rows[0] ?? null, sp: Math.max(0, Number(rows[0]?.sp) || 0), rows };
  }
  if (!attackerTokenDoc || !targetTokenDoc) return { state: AREA_COVER_IN, row: rows[0] ?? null, sp: 0, rows };
  const from = _tokenCenter(attackerTokenDoc);
  const to   = _tokenCenter(targetTokenDoc);
  // `areaOcclusionTest` reads `tok.center?.x ?? tok.x`, so it is handed a resolved centre rather than a
  // document whose `x` is a top-left corner — the same point the geometry above measured to.
  if (areaOcclusionTest(from.x, from.y, { center: to })) {
    return { state: AREA_COVER_EXEMPT, row: rows[0] ?? null, sp: 0, rows };
  }
  return { state: AREA_COVER_IN, row: rows[0] ?? null, sp: 0, rows };
}

/* ════════════════ The area split: valued cover soaks, a naked wall exempts ════════════════ */

/** The three answers `areaCoverVerdict` gives. Named constants so no caller compares strings by hand. */
export const AREA_COVER_IN     = "in";       // nothing between: the area's damage arrives whole
export const AREA_COVER_SOAKED = "soaked";   // a VALUED object is in the way: its SP folds, and it chews
export const AREA_COVER_EXEMPT = "exempt";   // a NAKED move-blocking wall: no damage, no chew (unchanged)

/**
 * Is the area↔cover interaction switched on at all? The same world switch `areaOcclusionTest` reads,
 * asked once here so the SOAK half and the EXEMPT half cannot be enabled independently: a table that
 * turned area occlusion off has said "areas hit everything in them, plainly", and half-honouring that
 * by still folding SP would be a third behaviour nobody chose. Defaults ON when settings are absent.
 */
export function areaCoverEnabled() {
  try { return !!game.settings.get(SCOPE, "areaEffectOcclusion"); } catch (e) { return true; }
}

/** Centre of a token in scene pixels, from a placeable OR a bare TokenDocument. */
function _anyTokenCenter(tok) {
  if (tok?.center && Number.isFinite(tok.center.x)) return { x: tok.center.x, y: tok.center.y };
  const doc = tok?.document ?? tok;
  return _tokenCenter(doc);
}

/**
 * The VALUED cover rows a straight line crosses, between two POINTS on a scene.
 *
 * The point-to-point sibling of `coverBetween`, which can only be asked about two tokens. An area
 * effect has an ORIGIN, not a shooter — a pattern's muzzle point, a blast's centre — so the question
 * "what valued object is between that point and this figure" needs a form that takes points, and the
 * miss-chew case (an empty corridor crossing a barrier) has no figure at either end at all.
 *
 * Zones and cover-flagged walls only. A deployed VEHICLE is cover on the aimed path (vehicle-cover.js)
 * but is deliberately not consulted here: its row needs the attacker's own handle to exclude the
 * bodywork the shooter is sitting in, and its rider-cover verdict is a per-attack draw — neither of
 * which an area origin can supply. Recorded as a follow-up rather than guessed at.
 *
 * Geometry is the same on both row kinds as `coverBetween` uses — exact segment intersection for a
 * wall, native containment sampled at quarter-grid steps for a zone, with the v13/v14 elevation
 * double-carry that file's note explains. The first half-grid at the ORIGIN end is trimmed for the
 * same reason too: the object the muzzle is pressed against is not between the shot and anyone.
 *
 * Rows come back nearest-to-`to`-first, so `[0]` is the outermost layer a figure at `to` is behind.
 */
export function valuedCoverAlong(scene, from, to, { elevation = 0 } = {}) {
  const sc = scene ?? canvas?.scene;
  if (!sc || !from || !to) return [];
  const grid = sc.grid?.size ?? 100;
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (!(len > 0)) return [];
  const t0 = Math.min(0.4, (grid / 2) / len);
  const o = { x: from.x + (to.x - from.x) * t0, y: from.y + (to.y - from.y) * t0 };

  const out = [];
  for (const r of [...coverZonesOn(sc), ...coverWallsOn(sc)]) {
    if (r.destroyed || !(r.sp > 0)) continue;
    let crossed = false;
    try {
      if (r.wall) {
        const c = r.wall.c ?? [];
        crossed = c.length >= 4
          && !!foundry.utils.lineSegmentIntersects(o, to, { x: c[0], y: c[1] }, { x: c[2], y: c[3] });
      } else if (typeof r.region?.testPoint === "function") {
        const steps = Math.min(200, Math.max(2, Math.ceil(Math.hypot(to.x - o.x, to.y - o.y) / (grid / 4))));
        for (let i = 0; i <= steps && !crossed; i++) {
          const t = i / steps;
          crossed = !!r.region.testPoint(
            { x: o.x + (to.x - o.x) * t, y: o.y + (to.y - o.y) * t, elevation }, elevation,
          );
        }
      }
    } catch (e) { crossed = false; }
    if (!crossed) continue;
    if (!r.center) r.center = _regionCenter(r.region);
    out.push(r);
  }
  for (const r of out) {
    r.d2 = r.center ? (r.center.x - to.x) ** 2 + (r.center.y - to.y) ** 2 : Number.POSITIVE_INFINITY;
  }
  return out.sort((a, b) => a.d2 - b.d2);
}

/**
 * The valued cover rows whose own centre stands within `radiusPx` of a point.
 *
 * The blast's form of the same question `valuedCoverAlong` answers for a corridor. A circle has no
 * direction, so "did the shot land on this object" is simply "is it inside the radius" — the same
 * question the figures in the blast are asked. Nearest-first, and every row carries a resolved
 * `center` so a caller can band its distance without asking the geometry twice.
 */
export function valuedCoverWithin(scene, point, radiusPx) {
  const sc = scene ?? canvas?.scene;
  if (!sc || !point || !(radiusPx > 0)) return [];
  const out = [];
  for (const r of [...coverZonesOn(sc), ...coverWallsOn(sc)]) {
    if (r.destroyed || !(r.sp > 0)) continue;
    const c = r.center ?? _regionCenter(r.region);
    if (!c) continue;
    r.center = c;
    r.d2 = (c.x - point.x) ** 2 + (c.y - point.y) ** 2;
    if (r.d2 <= radiusPx * radiusPx) out.push(r);
  }
  return out.sort((a, b) => a.d2 - b.d2);
}

/**
 * ⭐ THE ONE PREDICATE the area paths ask about a figure — valued cover or naked wall, in one place.
 *
 * User ruling 2026-08-25, on the Core p.103 reading (`reference-cover-rules-raw`): cover is SP that
 * SOAKS, not an exemption, and the printed area/shotgun prose carries no exemption sentence at all.
 * So the answer splits three ways instead of two:
 *
 *   SOAKED  — a cover-VALUED object (a coverZone region, a wall carrying coverSp) is on the line.
 *             The figure IS in the area and takes its damage with that object's SP folded as the
 *             OUTERMOST armour layer (DamageApplicator resolveHitMath's existing `coverSP` fold —
 *             the same proportional table the aimed path uses; nothing re-implements it here), and
 *             the object CHEWS the raw damage it received (MM p.58, through this file's ledger).
 *   EXEMPT  — a move-blocking wall carrying NO cover values. Unchanged from what shipped: no damage,
 *             no chew. A naked wall is map furniture the module knows nothing about, and inventing an
 *             SP for it would be inventing the table's map.
 *   IN      — nothing in the way.
 *
 * VALUED IS ASKED FIRST, and that ordering is the whole of the second ruling: a cover-flagged wall
 * that also happens to block movement soaks rather than exempts, because the GM who typed an SP onto
 * it said what it is worth. Only a wall nobody has valued falls through to the move test.
 *
 * NEAREST-ONLY, not stacked: `[0]` of the crossed rows folds and only that row chews. Layering cover
 * on cover has no printed basis (the book prints one line of SP per object, and p.99's proportional
 * table is about worn armour), and stacking two barriers through `combineArmorSP` would make a pair of
 * sheetrock walls stop more than the steel door beside them. The rest of the crossed rows travel back
 * on `rows` so a caller that wants to say what else was in the way can.
 *
 * @param {number} ox  area origin X in scene pixels
 * @param {number} oy  area origin Y in scene pixels
 * @param {object} tok token placeable OR TokenDocument
 * @returns {{state:string, row:object|null, sp:number, rows:object[]}}
 */
export function areaCoverVerdict(ox, oy, tok, scene = null) {
  const plain = { state: AREA_COVER_IN, row: null, sp: 0, rows: [] };
  if (!tok || !areaCoverEnabled()) return plain;
  const doc = tok?.document ?? tok;
  const sc = scene ?? doc?.parent ?? canvas?.scene;
  const c = _anyTokenCenter(tok);
  const elevation = Number(doc?.elevation ?? 0) || 0;
  const rows = valuedCoverAlong(sc, { x: ox, y: oy }, c, { elevation });
  if (rows.length) return { state: AREA_COVER_SOAKED, row: rows[0], sp: Math.max(0, Number(rows[0].sp) || 0), rows };
  if (areaOcclusionTest(ox, oy, tok)) return { state: AREA_COVER_EXEMPT, row: null, sp: 0, rows: [] };
  return plain;
}

/* ═════════════════════ Per-round structure ledger (pure, no document writes) ═════════════════════ */

/**
 * The bookkeeper a burst runs its rounds through, so cover wears down the same way armor does:
 * one round at a time, with the object's state carried forward to the NEXT round.
 *
 * WHY IT EXISTS: the debit used to be a single lump charged after the whole volley had already
 * been resolved, which meant a burst that should have blown a hole in a door on its third round
 * instead resolved all six rounds against an intact door and then knocked it down afterwards. The
 * ledger moves the bookkeeping INTO the per-round loop, so the round that empties the pool is the
 * last round the object stands for and every later round in the same burst faces bare armor.
 *
 * THE ATTRIBUTION (the honest definition of "what the object absorbed"):
 *   a round's debit = min(that round's RAW damage, the structure still standing).
 * The book is the reason it is raw damage and not the object's share of the stopped damage:
 * Maximum Metal p.58 counts damage RECEIVED against an object's structure ("a 10SP concrete block
 * wall which has received 30pts SDP … has had the block shattered") — the shot hits the object
 * with everything it has, and what gets through to the target afterwards is a separate question
 * answered by the SP fold. So the object receives the round's full roll, capped by what is left of
 * it. The cap is what makes the last round's debit smaller than its roll, and the overflow is NOT
 * carried anywhere: a door does not owe damage once it is off its hinges.
 *
 * SP stays constant while the object stands (the same book rule) — `spForRound` returns either the
 * cover SP in play or, once the pool is gone, zero. Nothing here writes a document: the caller
 * accumulates the whole burst and performs ONE debit through chewCover.
 *
 * @param {number} p.coverSP  The SP actually in play this apply (a GM-typed value overrides the
 *                            object's own printed SP; 0 = cover is not folded at all).
 * @param {object} p.cover    The row snapshot to attribute to ({uuid,label,pool,poolMax,destroyed}),
 *                            or null when a bare number was typed with no object behind it.
 */
export function makeCoverLedger({ coverSP = 0, cover = null } = {}) {
  const sp = Math.max(0, Number(coverSP) || 0);
  const uuid = String(cover?.uuid ?? "");
  const label = String(cover?.label ?? "");
  const poolMax = Math.max(0, Math.round(Number(cover?.poolMax) || 0));
  // ⭐ CORE-MODE COVER KEEPS NO LEDGER (2026-08-26 — see COVER_MODE_CORE). An SP entered on its own
  // soaks and is permanent, so there is nothing to book: `absorb` returns null for every round, no
  // receipt reaches `coverChewSummary`, and therefore no debit is written and no structure card is
  // posted anywhere downstream. `spForRound` still answers the SP, because soaking is exactly what
  // core cover DOES — it is only the wearing-down half that stands down.
  // ⛔ `!== false`, not truthiness: a vehicle row carries its own printed structure and never sets the
  // field, and a payload relayed from a client mid-update carries the pre-field row shape. Only a row
  // that has EXPLICITLY said it is core-mode turns the ledger off.
  const tracked = !!uuid && sp > 0 && coverChews(cover);
  let pool = Math.max(0, Math.round(Number(cover?.pool) || 0));
  let gone = tracked ? (!!cover?.destroyed || pool <= 0) : false;
  let round = 0;

  return {
    /** SP the NEXT round faces — zero once the object has been knocked down mid-burst. */
    spForRound() { return gone ? 0 : sp; },
    /**
     * Book one round's raw damage against the object. Returns that round's receipt, or null when
     * there is no object to charge (bare typed SP) or nothing left of it.
     */
    absorb(rawDamage) {
      round += 1;
      if (!tracked || gone) return null;
      const dmg = Math.max(0, Math.round(Number(rawDamage) || 0));
      const absorbed = Math.min(dmg, pool);
      if (absorbed <= 0) return null;
      pool -= absorbed;
      const destroyed = pool <= 0;
      if (destroyed) gone = true;
      return { uuid, label, round, absorbed, poolAfter: pool, poolMax, destroyed };
    },
  };
}

/**
 * Fold a resolved burst's per-round receipts into the one debit that gets written and the figures
 * the summary card reports. Reads the `coverChew` field the resolvers attach to each hit row, so
 * the preview and the apply path derive it from exactly the same numbers. Returns null when the
 * burst never touched a cover object.
 */
export function coverChewSummary(rows) {
  const receipts = (rows ?? []).map(r => r?.coverChew).filter(Boolean);
  if (!receipts.length) return null;
  const last = receipts[receipts.length - 1];
  return {
    uuid: last.uuid,
    label: last.label,
    absorbed: receipts.reduce((s, r) => s + r.absorbed, 0),
    pool: last.poolAfter,
    poolMax: last.poolMax,
    destroyed: !!last.destroyed,
    destroyedAtRound: receipts.find(r => r.destroyed)?.round ?? 0,
    rounds: receipts.map(r => ({ round: r.round, absorbed: r.absorbed, poolAfter: r.poolAfter, destroyed: !!r.destroyed })),
  };
}

/* ═══════════════ Area chew: one ledger per crossed object, per application ═══════════════ */

/**
 * ⭐ THE CHEW CARDINALITY for an area effect — ONE ledger per crossed object per APPLICATION,
 * never one per figure sheltering behind it (user ruling 2026-08-25, recorded here because it is the
 * only place the arithmetic can be read).
 *
 * WHY NOT PER FIGURE. A door with three people behind it is one door. Debiting it once per person
 * would make a barrier's survival depend on how crowded the room is, and three figures behind a 30
 * SDP door would take it down on a burst that one figure's share would have left standing. The object
 * is charged for the rounds that CROSSED IT, which is a fact about the corridor, not about the crowd.
 *
 * WHAT IT IS CHARGED. MM p.58 counts damage RECEIVED against structure, so each of the area's rounds
 * hits the object with its full damage number, capped by what is left of it (`makeCoverLedger`).
 *
 * ⭐ THAT NUMBER IS THE SHOT'S OWN, ROLLED ONCE (user ruling 2026-08-26: *"a bullet doesn't get two
 * different damage resolutions"*). `rawFor` is the caller's hook for exactly this: the pattern flow
 * hands back the FIRST soaked figure's shell rolls, so the barrier and the body behind it are resolved
 * from one set of dice — the barrier receives the roll, the body receives it less the barrier's SP.
 * The hook rolls fresh ONLY where no figure is behind the object (the empty-corridor case, ruling 3),
 * because then there is no shell-roll to share and the object is the only body the shot reached.
 * A blast passes a positional falloff value rather than dice; there is no second roll to reconcile.
 *
 * WHAT THE FIGURES BEHIND IT GET. `spByRound` — the SP the object still had when round i left the
 * muzzle, so a barrier that gives out on shell 3 stops soaking for shells 4..N of the SAME burst, the
 * mid-burst rule the aimed path already has. Callers thread that number into `resolveHitMath`'s
 * `coverSP` and pass NO `cover` row of their own, so the per-figure pipeline books no second debit.
 *
 * Pure of document writes; `commitAreaCoverChew` performs them.
 *
 * @param {object[]} rows    unique valued cover rows (dedupe by uuid before calling)
 * @param {number}   rounds  how many rounds the area throws
 * @param {(row:object, i:number) => Promise<number>|number} rawFor  that round's raw damage on that row
 * @returns {Promise<Map<string, {row:object, spByRound:number[], summary:object|null}>>}
 */
export async function resolveAreaCoverChew(rows, rounds, rawFor) {
  const plan = new Map();
  const n = Math.max(0, Math.floor(Number(rounds) || 0));
  for (const row of rows ?? []) {
    const uuid = String(row?.uuid ?? "");
    if (!uuid || plan.has(uuid)) continue;
    const ledger = makeCoverLedger({ coverSP: row.sp, cover: row });
    const spByRound = [];
    const receipts = [];
    for (let i = 0; i < n; i++) {
      spByRound.push(ledger.spForRound());
      const raw = Math.max(0, Math.round(Number(await rawFor(row, i)) || 0));
      const rec = ledger.absorb(raw);
      if (rec) receipts.push(rec);
    }
    // The fold is coverChewSummary's, not a second one written here — the receipts are wrapped in the
    // field name it reads so the burst summary and the aimed path's summary are literally one function.
    plan.set(uuid, { row, spByRound, summary: coverChewSummary(receipts.map(c => ({ coverChew: c }))) });
  }
  return plan;
}

/** The SP a plan says round `i` faced on that row, or the row's printed SP when it was never planned. */
export function areaCoverSpForRound(plan, row, i) {
  const entry = row?.uuid ? plan?.get?.(String(row.uuid)) : null;
  if (!entry) return Math.max(0, Number(row?.sp) || 0);
  const sp = entry.spByRound[Math.max(0, Math.floor(i))];
  return Number.isFinite(sp) ? sp : 0;
}

/** Write every debit a plan booked — one relayed chew per object, in the plan's own order. */
export async function commitAreaCoverChew(plan, weaponName = "") {
  for (const { row, summary } of plan?.values?.() ?? []) {
    if (!summary || !(summary.absorbed > 0)) continue;
    await requestCoverChew({
      uuid: row.uuid, label: summary.label || row.label, damage: summary.absorbed,
      weaponName, rounds: summary.rounds, destroyedAtRound: summary.destroyedAtRound,
    });
  }
}

/* ═══════════════════════════════════ Chew lifecycle (GM) ═══════════════════════════════════ */

/** Pool band → region color. Intact amber, chewed orange, destroyed gray. */
export function coverBandColor(pool, poolMax) {
  if (pool <= 0) return "#555555";
  if (poolMax > 0 && pool < (2 * poolMax) / 3) return "#cc5500";
  return "#d1a054";
}

/**
 * Debit a cover zone's structure pool (GM-side write). Recolors the region by band, flips
 * `destroyed` at 0, posts the chew/destroyed chat card. Returns {pool, destroyed} or null when
 * the behavior can't be resolved. Idempotent-safe on already-destroyed zones (no double cards).
 *
 * `damage` is a whole BURST's debit and `rounds` its per-round receipts (makeCoverLedger): one
 * document write, one card, with the round-by-round wear readable on the card. Direct callers that
 * pass no receipts get the plain single-debit card they always got.
 */
export async function chewCoverZone({ behaviorUuid, damage, weaponName = "", rounds = null, destroyedAtRound = 0 }) {
  const behavior = await fromUuid(behaviorUuid);
  if (!behavior || behavior.type !== COVER_ZONE_BEHAVIOR) return null;
  const s = behavior.system ?? {};
  // ⭐ CORE-MODE ZONE — SP with no structure (total zero). It soaked, and that is all it does: no
  // debit, no colour change, ⛔ AND NO CARD. A structure card posted for an object that keeps no
  // structure is the card contradicting the model (see COVER_MODE_CORE).
  if (!(Number(s.poolMax) > 0)) return { pool: 0, destroyed: false, mode: COVER_MODE_CORE, skipped: "core" };
  if (s.destroyed) return { pool: 0, destroyed: true, already: true };

  const dmg = Math.max(0, Math.round(Number(damage) || 0));
  if (dmg <= 0) return { pool: Number(s.pool) || 0, destroyed: false };
  const poolMax = Number(s.poolMax) || 0;
  const pool = Math.max(0, (Number(s.pool) || 0) - dmg);
  const destroyed = pool <= 0;

  await behavior.update({ system: { pool, destroyed } });
  const region = behavior.parent;
  try { await region?.update?.({ color: coverBandColor(pool, poolMax) }); } catch (e) { /* cosmetic */ }

  const label = region?.name || localize("CoverZoneFallbackName");
  const content = await renderTpl(`modules/${SCOPE}/templates/chat/cover-chew.hbs`, {
    label, damage: dmg, pool, poolMax, destroyed, weaponName,
    ...burstLines({ rounds, destroyedAtRound, label, poolMax }),
  });
  await ChatMessage.create({ content });
  return { pool, destroyed };
}

/**
 * Card data for a burst's round-by-round wear. Pre-localized here (the render edge) so the card
 * template stays a plain `{{#each}}` — the established "assemble dynamic content in JS" rule.
 * Returns an empty object for a single unrecorded debit, which leaves the card exactly as it was.
 */
function burstLines({ rounds, destroyedAtRound, label, poolMax }) {
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

/**
 * ⭐ THE THREE RESTRICTIONS A WALL IMPOSES, and the values that mean "open".
 *
 * Named here rather than inlined so the snapshot, the breach and the repair are provably reading and
 * writing the SAME set of fields — a breach that opened two of the three and a repair that restored
 * all three would drift silently, and the drift would only ever be visible on somebody's table.
 * `NONE` is 0 in both of the core enumerations (WALL_MOVEMENT_TYPES.NONE and WALL_SENSE_TYPES.NONE);
 * the literals are the fallback for a core that does not publish them.
 */
export const WALL_BREACH_FIELDS = Object.freeze(["move", "sight", "sound"]);

/** The "no longer restricts" value for each of the three. */
function _breachOpenValues() {
  return {
    move:  CONST?.WALL_MOVEMENT_TYPES?.NONE ?? 0,
    sight: CONST?.WALL_SENSE_TYPES?.NONE ?? 0,
    sound: CONST?.WALL_SENSE_TYPES?.NONE ?? 0,
  };
}

/**
 * What this wall restricts RIGHT NOW, as the object the repair will play back. Captured from the live
 * document before anything is opened — ⛔ the snapshot is written in the SAME update as the opening,
 * so there is no instant at which a wall is breached with no record of what it used to be.
 */
export function wallBreachSnapshot(wall) {
  const snap = { ds: null };
  for (const k of WALL_BREACH_FIELDS) snap[k] = Number(wall?.[k] ?? 0);
  // A door's own state travels with them: breaching a door pops it open (the pre-existing path), and
  // the repair has to be able to shut it again.
  if ((wall?.door ?? 0) > 0) snap.ds = Number(wall?.ds ?? 0);
  return snap;
}

/**
 * Debit a cover-flagged WALL's structure (Unit 3, GM-side write). Exact debit, destroyed at 0, chat
 * card, idempotent on an already-destroyed wall.
 *
 * ⭐⭐ AND AT ZERO THE WALL **BREACHES** (user ruling 2026-08-26). A barrier that has been shot to
 * pieces is a hole, so all three of its restrictions open — movement, sight and sound — and what it
 * used to restrict is snapshotted into `flags.<scope>.coverBreach` FIRST, in the same write, so the
 * change is reversible by construction rather than by anyone remembering the old numbers. The
 * destruction card carries a GM-only REPAIR button that plays the snapshot back and refills the pool
 * in one press (`repairCoverWall`). ⛔ THE BREACH IS REVERSIBLE BY DESIGN and the card says so.
 *
 * A DOOR keeps the pop-open path it already had (door state → open) — field-confirmed working, and
 * now recorded in the same snapshot so a repair shuts it again.
 *
 * ⭐ CORE-MODE COVER NEVER REACHES ANY OF THIS: an SP typed with no structure keeps no pool, so the
 * bail below returns before a debit, before a card, and before a breach (see COVER_MODE_CORE).
 *
 * Returns {pool, destroyed, breached} or null when the uuid isn't a cover-flagged wall.
 */
export async function chewCoverWall({ wallUuid, damage, weaponName = "", rounds = null, destroyedAtRound = 0 }) {
  const wall = await fromUuid(wallUuid);
  if (!wall || wall.documentName !== "Wall") return null;
  const row = coverWallsOn(wall.parent).find(r => r.uuid === wall.uuid);
  if (!row) return null;
  // ⭐ THE CORE/MM SPLIT, at the write edge. Nothing is debited, nothing is opened and ⛔ NO CARD IS
  // POSTED for a wall the GM priced with an SP alone — that wall is permanent by their own entry.
  if (!row.structured) return { pool: 0, destroyed: false, mode: COVER_MODE_CORE, skipped: "core" };
  if (row.pool <= 0) return { pool: 0, destroyed: true, already: true };

  const dmg = Math.max(0, Math.round(Number(damage) || 0));
  if (dmg <= 0) return { pool: row.pool, destroyed: false };
  const pool = Math.max(0, row.pool - dmg);
  const destroyed = pool <= 0;

  const changes = {
    [`flags.${SCOPE}.coverPool`]: pool,
    [`flags.${SCOPE}.coverPoolMax`]: row.poolMax,
  };
  const OPEN = CONST?.WALL_DOOR_STATES?.OPEN ?? 1;
  const doorOpened = destroyed && row.isDoor && wall.ds !== OPEN;
  // ⛔ SNAPSHOT FIRST, THEN OPEN — one update, snapshot key included, so a client that reads the wall
  // at any point after the write finds either an unbreached wall or a breached one WITH its record.
  // A wall already carrying a snapshot is not re-snapshotted: the first breach holds the true original
  // (a second debit on an already-open wall would otherwise record the OPEN values as the "original").
  let breached = false;
  if (destroyed && !row.breached) {
    changes[`flags.${SCOPE}.coverBreach`] = wallBreachSnapshot(wall);
    Object.assign(changes, _breachOpenValues());
    breached = true;
  }
  if (doorOpened) changes.ds = OPEN;
  await wall.update(changes);

  const content = await renderTpl(`modules/${SCOPE}/templates/chat/cover-chew.hbs`, {
    label: row.label, damage: dmg, pool, poolMax: row.poolMax, destroyed, doorOpened, weaponName,
    // The breach is ANNOUNCED, and the announcement carries its own undo. `canRepair` is the render
    // gate (the button is GM-only), `wallUuid` is what the handler acts on.
    breached, canRepair: breached && !!game.user?.isGM, wallUuid: wall.uuid,
    ...burstLines({ rounds, destroyedAtRound, label: row.label, poolMax: row.poolMax }),
  });
  await ChatMessage.create({ content });
  return { pool, destroyed, breached };
}

/**
 * ⭐ UNDO A BREACH — the destruction card's one-click repair (GM write, user ruling 2026-08-26:
 * *full restore, one click*). Two things go back at once, because a wall that stands again with an
 * empty pool would shatter to the next round and a wall with a full pool that still lets everyone
 * walk through it is not repaired:
 *
 *   1. the three restrictions (and a door's own state) are played back from the snapshot the breach
 *      wrote — ⛔ the snapshot, not a guess at what a wall "usually" restricts;
 *   2. the structure pool is refilled to its own total.
 *
 * The snapshot flag is deleted with the restore, so the wall is indistinguishable from one that was
 * never breached and a later breach snapshots afresh. Idempotent: a wall carrying no snapshot is
 * already whole and returns without writing.
 */
export async function repairCoverWall({ wallUuid } = {}) {
  const wall = await fromUuid(String(wallUuid ?? ""));
  if (!wall || wall.documentName !== "Wall") return null;
  const snap = wall.flags?.[SCOPE]?.coverBreach ?? null;
  const row = coverWallsOn(wall.parent).find(r => r.uuid === wall.uuid) ?? null;
  if (!snap) return { repaired: false, already: true, pool: row?.pool ?? 0 };

  const poolMax = Math.max(0, Math.round(Number(row?.poolMax) || 0));
  // Modern deletion operator with the legacy `-=` fallback on v13 (utils.deleteFieldUpdate)
  // — the hand-rolled legacy key tripped core v14's compatibility warning on every repair/clear.
  const changes = { ...deleteFieldUpdate(`flags.${SCOPE}.coverBreach`) };
  for (const k of WALL_BREACH_FIELDS) {
    const v = Number(snap[k]);
    if (Number.isFinite(v)) changes[k] = v;
  }
  if (Number.isFinite(Number(snap.ds))) changes.ds = Number(snap.ds);
  // Refill only a wall that still has a structure model. A GM who cleared the structure fields while
  // the wall stood breached has said it is core cover now; the restrictions still go back.
  if (poolMax > 0) {
    changes[`flags.${SCOPE}.coverPool`] = poolMax;
    changes[`flags.${SCOPE}.coverPoolMax`] = poolMax;
  }
  await wall.update(changes);

  const label = row?.label ?? localize((wall.door ?? 0) > 0 ? "CoverWallDoorFallbackName" : "CoverWallFallbackName");
  const content = await renderTpl(`modules/${SCOPE}/templates/chat/cover-repair.hbs`, {
    label, pool: poolMax, poolMax,
  });
  await ChatMessage.create({ content });
  return { repaired: true, pool: poolMax, poolMax };
}

/**
 * Repair entry point for ANY client — the same primary-session-writes/everyone-else-relays rail every
 * other cover write takes. The BUTTON is GM-only by render gate; this guard is what makes that true of
 * the write as well, and it lets a press from a non-primary client still land. A GM's SECOND tab falls
 * to the relay below and the primary session performs the one write, which is correct: the gesture
 * happened once, so it is carried once.
 */
export async function requestCoverRepair(payload) {
  if (isPrimaryGMSession()) {
    return repairCoverWall(payload);
  }
  if (!game.users?.activeGM) {
    ui.notifications?.warn?.(localize("CoverNoGMForChew"));
    return null;
  }
  game.socket.emit(`module.${SCOPE}`, { type: MSG_REPAIR, ...payload });
  return null;
}

/**
 * Type dispatcher for chew payloads: the picker rows carry a RegionBehavior uuid (zone), a Wall
 * uuid (Unit 3) or a vehicle Actor uuid in the same `behaviorUuid` field — the historical name is
 * kept so the socket message shape stays stable across every row kind.
 */
export async function chewCover(payload) {
  const uuid = String(payload?.uuid ?? payload?.behaviorUuid ?? "");
  if (!uuid) return null;
  const doc = await fromUuid(uuid);
  const common = {
    damage: payload?.damage,
    weaponName: payload?.weaponName ?? "",
    rounds: Array.isArray(payload?.rounds) ? payload.rounds : null,
    destroyedAtRound: Number(payload?.destroyedAtRound) || 0,
  };
  if (doc?.documentName === "Wall") return chewCoverWall({ wallUuid: uuid, ...common });
  // The label travels with the payload for a vehicle because the row's own label may name the part
  // that was crossed ("… — engine block"), which is what the card should report too.
  if (isVehicleCoverUuid(doc)) {
    return chewVehicleCover({ actorUuid: uuid, label: String(payload?.label ?? ""), ...common });
  }
  return chewCoverZone({ behaviorUuid: uuid, ...common });
}

/**
 * Chew entry point for ANY client: the primary GM SESSION writes directly; everyone else relays.
 * (Region/behavior and wall updates are GM-only — the same permission shape as every zone write.)
 */
export async function requestCoverChew(payload) {
  if (isPrimaryGMSession()) {
    return chewCover(payload);
  }
  if (!game.users?.activeGM) {
    ui.notifications?.warn?.(localize("CoverNoGMForChew"));
    return null;
  }
  game.socket.emit(`module.${SCOPE}`, { type: MSG_CHEW, ...payload });
  return null;
}

export function registerCoverSocket() {
  game.socket.on(`module.${SCOPE}`, async (data) => {
    // ⛔ NOT idempotent — `chewCover` DEBITS the structure pool, so a second session running it takes
    // the hit out of the wall twice (the duplicated destruction card the cover lane saw).
    if (!isPrimaryGMSession()) return;
    if (data?.type === MSG_CHEW) return void await chewCover(data);
    if (data?.type === MSG_REPAIR) return void await repairCoverWall(data);
  });
}

/**
 * The destruction card's REPAIR button (⛔ GM-only, twice over: the button is not rendered for a
 * player — see cover-chew.hbs's `canRepair` — and this handler refuses one anyway, because a rendered
 * card lives in a player's own log and its markup is theirs to edit).
 *
 * One press, then the button is spent: a second press would refill a pool the first press already
 * filled and post a second card saying so.
 */
export function registerCoverRepairButton() {
  // `onGlobalClick`, not a bare document listener: a chat card the GM has popped out into its own
  // window has its own document, and a raw listener never hears it (popout-compat.js).
  onGlobalClick(async (ev) => {
    const btn = ev.target?.closest?.(".cp-cover-repair");
    if (!btn || btn.disabled) return;
    ev.preventDefault();
    if (!game.user?.isGM) return;
    btn.disabled = true;
    try {
      await requestCoverRepair({ wallUuid: btn.dataset.wallUuid ?? "" });
    } catch (e) {
      console.warn(`${SCOPE} | cover repair failed`, e);
      btn.disabled = false;
    }
  });
}

/* ══════════════════════════════ Placement tool (GM, native-first) ══════════════════════════════ */

/**
 * Spawn a ready-made cover region from a preset at the view centre: small rect, amber, ALWAYS
 * visible, behavior prefilled from the dialog's own inputs. The GM then reshapes/moves it with the
 * NATIVE Region tools — the radiation lesson: the module places data, the platform owns geometry.
 *
 * ⭐ A STRUCTURE OF ZERO IS AN ANSWER, NOT A MISSING VALUE (2026-08-26 — COVER_MODE_CORE). The
 * dialog prefills `3 × SP` visibly; a GM who clears that field (or types 0) has said "Core p.103
 * cover, permanent", and the zone is placed with no structure ledger. ⏪ This used to be
 * `Math.max(1, … || spN * COVER_POOL_MULT)`, which silently re-supplied the Maximum Metal figure and
 * made the empty field unreachable.
 */
export async function placeCoverZone({ scene, label, sp, poolMax } = {}) {
  const sc = scene ?? canvas?.scene;
  if (!sc || !game.user?.isGM) return null;
  const spN = Math.max(0, Math.round(Number(sp) || 0));
  const pool = Math.max(0, Math.round(Number(poolMax) || 0));
  const grid = sc.grid?.size ?? 100;
  const cx = canvas?.stage?.pivot?.x ?? (sc.width ?? 2000) / 2;
  const cy = canvas?.stage?.pivot?.y ?? (sc.height ?? 2000) / 2;
  const w = 2 * grid, h = 1 * grid;

  const [region] = await sc.createEmbeddedDocuments("Region", [{
    name: label || localize("CoverZoneFallbackName"),
    // A core-mode zone (structure 0) is INTACT permanent cover, not rubble — `coverBandColor` is
    // asked for the intact band explicitly rather than being handed a zero it would read as gray.
    color: pool > 0 ? coverBandColor(pool, pool) : coverBandColor(1, 1),
    visibility: CONST?.REGION_VISIBILITY?.ALWAYS ?? 2,
    shapes: [{ type: "rectangle", x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h, rotation: 0 }],
    behaviors: [{ type: COVER_ZONE_BEHAVIOR, system: { sp: spN, pool, poolMax: pool } }],
  }]);
  return region ?? null;
}

/* ══════════════════ Draw-arming: the GM draws the shape, the module writes the data ══════════════════
 *
 * ⭐ THE PLACEMENT GESTURE (2026-08-28, user order). What this replaces: the dialog dropped a fixed
 * 2 × 1 rectangle at the VIEW CENTRE, and the referee then had to go find it, switch to the region
 * layer, select it, and drag it where the cover actually is. Every one of those steps is the platform's
 * own draw gesture done backwards.
 *
 * What happens now: confirming the preset ARMS this client — "the next region you draw is this cover" —
 * switches the UI to the Regions layer with a shape tool live, and says so. The referee draws the
 * barrier wherever it stands, in whatever shape it is, with the native tool of their choice; the module
 * then writes ITS half onto that document (name, band colour, ALWAYS visibility, the cover behavior with
 * sp/pool) and touches the shape not at all.
 *
 * ⛔ THE SHAPE IS NEVER OURS. That is the file's standing principle — the module places DATA, the
 * platform owns GEOMETRY — and this is the half that was missing: we used to author a rectangle nobody
 * asked for. The write below names `name`, `color`, `visibility` and the behavior, and nothing else.
 *
 * The arming is ONE-SHOT and cheap to abandon: it disarms itself before it writes, a second dialog
 * confirm re-arms with the new preset, and an arming that never fires costs nothing — no document was
 * created, no pool was spent. It is torn down on a scene change (`canvasTearDown`) and is refused
 * outright for a region drawn on a different scene or by a different user, so a stale arm cannot
 * silently adopt somebody else's shape.
 */

/** The one live arming on this client (only ever one). Null when nothing is armed. */
let _armedCover = null;

/**
 * ⭐ THE ARMED NOTICE IS PERMANENT, AND IT IS DISMISSED BY THE ARM ITSELF (user ruling 2026-08-28:
 * *"fine as long as the message stays visible for the user and it's clear what to do"*).
 *
 * Why it had to change: the instruction and the gesture it describes are separated by however long the
 * referee takes to pick a shape tool, find the barrier and drag it out. An ordinary toast is gone in
 * seconds, so the one sentence naming what to do next expired before the doing — which is the whole of
 * the complaint. `{ permanent: true }` makes it stand.
 *
 * ⛔ AND SOMETHING HAS TO TAKE IT DOWN, or a permanent notice becomes litter that outlives its own
 * instruction. The notice's lifetime is EXACTLY the arm's, so it is carried ON the arm state and
 * removed in `cancelCoverDrawArming` — the single choke point every ending already goes through:
 *   · the draw LANDS      → the createRegion hook disarms before it writes → notice goes
 *   · a second CONFIRM    → `armCoverDraw` disarms before it re-arms → the old notice goes, then the
 *                           new one posts, so exactly one ever stands
 *   · a scene CHANGE      → the canvasTearDown net disarms → notice goes
 * One site, three endings, no fourth path to forget.
 */
function _dismissArmedNotice(state) {
  const notice = state?.notice ?? null;
  if (!notice) return false;
  state.notice = null;
  try {
    ui.notifications?.remove?.(notice);
    return true;
  } catch (e) {
    console.warn(`${SCOPE} | cover draw notice dismissal failed`, e);
    return false;
  }
}

/** Register the scene-teardown safety net exactly once (lazy — no init wiring needed). */
let _armTearDownHooked = false;
function _ensureArmTearDown() {
  if (_armTearDownHooked) return;
  _armTearDownHooked = true;
  // Changing scene disarms: the arm names the scene it was made on, and an arm that outlived its
  // canvas is a trap waiting for the next region drawn anywhere.
  Hooks.on("canvasTearDown", () => { try { cancelCoverDrawArming(); } catch (_e) { /* already gone */ } });
}

/**
 * Write the module's half onto a region the GM drew. ⛔ `shapes` is deliberately absent from the
 * update — see the block comment above. Exported for the keeper.
 */
export async function applyCoverDataToRegion(region, { label, sp, poolMax } = {}) {
  if (!region) return null;
  const spN = Math.max(0, Math.round(Number(sp) || 0));
  const pool = Math.max(0, Math.round(Number(poolMax) || 0));
  await region.update({
    name: String(label || "").trim() || localize("CoverZoneFallbackName"),
    // A core-mode zone (structure 0) is INTACT permanent cover, not rubble — the same reading
    // `placeCoverZone` applies, asked of the intact band explicitly rather than handed a zero.
    color: pool > 0 ? coverBandColor(pool, pool) : coverBandColor(1, 1),
    visibility: CONST?.REGION_VISIBILITY?.ALWAYS ?? 2,
  });
  await region.createEmbeddedDocuments("RegionBehavior", [{
    type: COVER_ZONE_BEHAVIOR, system: { sp: spN, pool, poolMax: pool },
  }]);
  return region;
}

/**
 * Arm this client: the next region THIS user draws on THIS scene becomes the described cover.
 * Returns the armed state (by value, so the keeper can assert it) or null when it refused.
 */
export function armCoverDraw({ label, sp, poolMax } = {}) {
  if (!game.user?.isGM) return null;
  const sc = canvas?.scene;
  if (!sc) { ui.notifications?.warn?.(localize("CoverDrawNoScene")); return null; }
  // A second confirm RE-ARMS rather than stacking: one client, one pending cover.
  cancelCoverDrawArming();
  _ensureArmTearDown();

  const state = {
    sceneId: sc.id,
    label: String(label || "").trim(),
    sp: Math.max(0, Math.round(Number(sp) || 0)),
    poolMax: Math.max(0, Math.round(Number(poolMax) || 0)),
    hookId: null,
    // The standing instruction, filled in below once it has been posted. Its lifetime is this arm's.
    notice: null,
  };
  state.hookId = Hooks.on("createRegion", (doc, _options, userId) => {
    // Somebody else's region is theirs, and a region on another scene is not what was armed.
    if (userId !== game.user?.id) return;
    if ((doc?.parent?.id ?? null) !== state.sceneId) return;
    // ⛔ DISARM FIRST, then write: the one-shot has to be spent before any await, or a fast second
    // draw during the write would find the arm still live and take it too.
    cancelCoverDrawArming();
    applyCoverDataToRegion(doc, state)
      .then(() => ui.notifications?.info?.(localizeParam("CoverPlaced", { name: doc.name })))
      .catch((e) => console.warn(`${SCOPE} | cover draw write failed`, e));
  });
  _armedCover = state;

  // Put the referee where the drawing happens: the Regions control group with a shape tool live. Both
  // calls are made because they answer different halves — `ui.controls.activate` moves the toolbar (and
  // its own onChange activates the layer), `canvas.regions.activate` is the layer itself for a build
  // whose control group is named or shaped differently. Neither is allowed to break the arming.
  try {
    // `activate` is async on v14 — its rejection has to be caught here or it escapes as an unhandled
    // one and shows up as a console error in a run that is otherwise clean.
    const act = ui.controls?.activate?.({ control: "regions", tool: "rectangle" });
    if (act?.catch) act.catch((e) => console.warn(`${SCOPE} | region controls activation failed`, e));
    canvas.regions?.activate?.();
  } catch (e) {
    console.warn(`${SCOPE} | region layer activation failed`, e);
  }
  // ⭐ PERMANENT: this sentence has to outlive the pause between reading it and doing it (see the
  // block on `_dismissArmedNotice`). The wording already names the gesture ("draw it with any Region
  // shape tool"), what the next region becomes, and how to back out ("draw nothing to cancel"), which
  // is the test the ruling set — so the string is unchanged and only its lifetime moved.
  state.notice = ui.notifications?.info?.(localizeParam("CoverDrawArmed",
    { name: state.label || localize("CoverZoneFallbackName") }), { permanent: true }) ?? null;
  return { ...state };
}

/** Cancel any live arming (exported for teardown / tests). Nothing was created, so nothing is undone —
 *  except the standing instruction, which is taken down here because this is where every ending meets. */
export function cancelCoverDrawArming() {
  if (!_armedCover) return false;
  try { Hooks.off("createRegion", _armedCover.hookId); } catch (_e) { /* ignore */ }
  _dismissArmedNotice(_armedCover);
  _armedCover = null;
  return true;
}

/** Is a cover draw armed on this client right now? Read by the keeper; nothing branches on it. */
export function coverDrawArmed() {
  return _armedCover ? { ..._armedCover } : null;
}

/** The standing instruction's id, or null. Exported so the keeper can ask the notification manager
 *  about it by value rather than counting toasts on the screen. */
export function coverDrawNoticeId() {
  return _armedCover?.notice?.id ?? null;
}

/** The preset-picker dialog behind the scene-control button. */
export async function openCoverPlacementDialog() {
  const { DialogV2 } = foundry.applications.api;
  const content = await renderTpl(`modules/${SCOPE}/templates/dialog/cover-place.hbs`, {
    presets: COVER_PRESETS.map(p => ({ ...p, pool: p.sp * COVER_POOL_MULT })),
  });

  // DialogV2's config render callback never fires on v14 — wire the preset→SP sync through the
  // renderDialogV2 hook instead (bind-once via the dialog's distinctive class).
  const hookId = Hooks.on("renderDialogV2", (app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root?.querySelector?.(".cp-cover-place-body")) return;
    const sel = root.querySelector('select[name="cp-cover-preset"]');
    const spIn = root.querySelector('input[name="cp-cover-sp"]');
    const poolIn = root.querySelector('input[name="cp-cover-pool"]');
    const labelIn = root.querySelector('input[name="cp-cover-label"]');
    sel?.addEventListener("change", () => {
      const p = COVER_PRESETS.find(x => x.key === sel.value);
      if (!p) return;
      if (spIn) spIn.value = String(p.sp);
      // ⭐ THE VISIBLE PREFILL (2026-08-26 — COVER_MODE_CORE). The Maximum Metal figure goes into the
      // input where the GM can read it and refuse it. Clearing this field is what places permanent
      // Core p.103 cover; nothing re-supplies the number after this point.
      if (poolIn) poolIn.value = String(p.sp * COVER_POOL_MULT);
      if (labelIn) labelIn.value = p.label;
    });
  });

  try {
    const result = await DialogV2.wait({
      window: { title: localize("CoverPlaceTitle"), resizable: true },
      // ⚠ DialogV2 IS FIXED-SIZE BY DEFAULT, and the default is far too narrow for this content —
      // rig-measured at 216px of usable width, which wrapped every label to three lines and clipped
      // the hint block. A stated width plus `resizable` is the shipped idiom for this (see the css/ui
      // procedure's DialogV2 notes); the content itself is a plain column, so nothing else is needed.
      position: { width: 480 },
      classes: ["cyberpunk", "cp-cover-place"],
      content,
      rejectClose: false,
      buttons: [{
        action: "place", default: true, label: localize("CoverPlaceBtn"),
        callback: (event, button, dialog) => {
          const el = (dialog.element ?? dialog);
          return {
            label: el.querySelector('input[name="cp-cover-label"]')?.value?.trim() ?? "",
            sp: Number(el.querySelector('input[name="cp-cover-sp"]')?.value) || 0,
            poolMax: Number(el.querySelector('input[name="cp-cover-pool"]')?.value) || 0,
          };
        },
      }, { action: "cancel", label: localize("Cancel") }],
    });
    if (result && result !== "cancel") {
      // ⭐ THE DIALOG ARMS, IT NO LONGER DROPS (2026-08-28). Confirming states WHAT the cover is; the
      // referee then draws WHERE and WHAT SHAPE it is with the platform's own tools. `placeCoverZone`
      // is still exported and still works — it is the API/keeper entry point for "place one at the
      // view centre" — but the gesture a referee performs is the draw.
      return armCoverDraw(result);
    }
    return null;
  } finally {
    Hooks.off("renderDialogV2", hookId);
  }
}

/**
 * Add the Place-Cover tool to a scene-control group (the df-active-lights idiom the radiation tools
 * use: augment an existing group, no bespoke canvas layer). GM-only; the tool IS the opt-in.
 * Exported pure-of-the-hook for the keeper.
 *
 * ⭐ IT LIVES WITH THE REGION TOOLS (2026-08-28, user order: "if this control drops regions, why isn't
 * it in the region section?"). A cover zone IS a Region — the button belongs beside the tools that draw
 * them, not in the token group, and the group it now sits in is the one the arming switches to anyway.
 * TOKENS IS THE FALLBACK, not a preference: on a build with no `regions` control group (an older core,
 * or a user without REGION_CREATE, whose group is not rendered at all) the button keeps its old home
 * rather than vanishing. Returns the group key it landed in so the keeper can assert it by value.
 */
export function addCoverTool(controls) {
  if (!game.user?.isGM) return false;
  const key = controls?.regions?.tools ? "regions" : (controls?.tokens?.tools ? "tokens" : null);
  if (!key) return false;
  const group = controls[key];
  group.tools["cp-cover-place"] = {
    name: "cp-cover-place",
    title: localize("CoverPlaceTool"),
    icon: "fa-solid fa-shield-halved",
    button: true,
    order: Object.keys(group.tools).length,
    onChange: () => openCoverPlacementDialog(),
  };
  return key;
}

export function registerCoverTools() {
  Hooks.on("getSceneControlButtons", (controls) => {
    try { addCoverTool(controls); } catch (e) { console.warn(`${SCOPE} | cover tool failed`, e); }
  });
}

/* ═══════════════════════════ Wall configuration fields (Unit 3, GM) ═══════════════════════════ */

/**
 * Add the cover fields to the NATIVE Wall configuration sheet (renderWallConfig). The inputs are
 * named `flags.<scope>.*`, so the sheet's own form submit persists them — no bespoke save path.
 * Idempotent per render (the fieldset marks itself), GM-only (players can't open WallConfig
 * anyway, but the guard keeps it explicit).
 *
 * ⭐ THE SP HANDLER'S PREFILL IS THE OPT-IN GESTURE, NOT A DEFAULT (2026-08-26 — COVER_MODE_CORE).
 * Typing an SP writes `3 × SP` into the two structure inputs **where the GM can see it**, so the
 * Maximum Metal lifecycle is offered rather than assumed: the number is on screen, it is theirs to
 * accept by saving or to refuse by clearing the field, and clearing it is what leaves the wall as
 * permanent Core p.103 cover. That visibility is the entire difference from what this used to do —
 * the same figure used to be supplied invisibly by `coverWallsOn` at read time, where nobody could
 * see it and nobody could decline it.
 *
 * ⭐ AND THE CLEAR BUTTON (2026-08-26) returns the wall to plain indestructible in one press: the
 * cover flags are DELETED from the document (not merely blanked in the form, which would leave a
 * breached wall breached and stale flags behind), any outstanding breach is restored first, and the
 * inputs are emptied so the sheet's own pending submit cannot write them back.
 */
export function registerCoverWallConfig() {
  Hooks.on("renderWallConfig", async (app, html) => {
    try {
      if (!game.user?.isGM) return;
      const root = html instanceof HTMLElement ? html : html?.[0];
      const form = root?.tagName === "FORM" ? root : root?.querySelector?.("form");
      if (!form) return;

      const doc = app.document;
      const f = doc?.flags?.[SCOPE] ?? {};
      // ⭐ THE FIELDSET IS REBUILT WHEN THE WALL'S STATE HAS MOVED UNDER IT (2026-08-27, ship-walk
      // finding). This guard used to be a plain "already injected → return", which is right for the
      // re-renders that change nothing and WRONG for the one that changes everything: a shot breaches
      // the wall, the document update re-renders the open sheet, and the early return left the
      // pre-breach fieldset in place — no Repair control, no breach notice — until the referee closed
      // the sheet and opened it again. The state the fieldset was built for is stamped on it, so
      // "still current?" is an identity question with a yes/no answer rather than an assumption.
      // ⛔ THE DOUBLE-INJECTION GUARD IS KEPT, and this is still it: a render whose stamp MATCHES
      // returns exactly as before, so nothing can end up with two fieldsets.
      //
      // ⛔ THE STAMP CARRIES EVERY FACT THE FIELDSET RENDERS, not just the breach — a correction the
      // cover-walls keeper caught the same session. With only the breach on it, pressing CLEAR (which
      // repairs first, then deletes the values) rebuilt the fieldset on the REPAIR's re-render, while
      // the values were still on the document, and then early-returned on the delete's re-render
      // because the breach flag had not moved again. The result was a fieldset showing 20/60/60 for a
      // wall that no longer had them, and the handler's own blanking wrote to the node it had just
      // been detached from. A stamp that changes when the DISPLAY changes cannot have that shape.
      const stamp = JSON.stringify([f.coverSp ?? null, f.coverPool ?? null, f.coverPoolMax ?? null, !!f.coverBreach, (doc?.door ?? 0) > 0]);
      const existing = form.querySelector(".cp-cover-wall-fields");
      if (existing) {
        if (existing.dataset.cpCoverState === stamp) return;
        existing.remove();
      }
      const content = await renderTpl(`modules/${SCOPE}/templates/dialog/cover-wall-config.hbs`, {
        scope: SCOPE,
        sp: (typeof f.coverSp === "number" && Number.isFinite(f.coverSp)) ? f.coverSp : "",
        pool: (typeof f.coverPool === "number" && Number.isFinite(f.coverPool)) ? f.coverPool : "",
        poolMax: (typeof f.coverPoolMax === "number" && Number.isFinite(f.coverPoolMax)) ? f.coverPoolMax : "",
        isDoor: (doc?.door ?? 0) > 0,
        // Whether this wall is standing open on a breach — the fieldset says so and offers the same
        // restore the card's button performs, because the card scrolls away and the wall does not.
        breached: !!f.coverBreach,
      });
      // Async render may lose the race against a re-render/close — re-check before inserting.
      if (!form.isConnected || form.querySelector(".cp-cover-wall-fields")) return;
      const holder = document.createElement("div");
      holder.innerHTML = content;
      const fieldset = holder.firstElementChild;
      if (!fieldset) return;
      // WHICH STATE THIS FIELDSET WAS BUILT FOR — read by the guard above on the next render.
      fieldset.dataset.cpCoverState = stamp;
      const footer = form.querySelector(".form-footer");
      if (footer) footer.before(fieldset); else form.append(fieldset);

      const spIn = fieldset.querySelector(`input[name="flags.${SCOPE}.coverSp"]`);
      const poolIn = fieldset.querySelector(`input[name="flags.${SCOPE}.coverPool"]`);
      const poolMaxIn = fieldset.querySelector(`input[name="flags.${SCOPE}.coverPoolMax"]`);
      spIn?.addEventListener("change", () => {
        const sp = Math.max(0, Number(spIn.value) || 0);
        if (sp <= 0) return;
        if (poolMaxIn && !poolMaxIn.value) poolMaxIn.value = String(sp * COVER_POOL_MULT);
        if (poolIn && !poolIn.value) poolIn.value = String(sp * COVER_POOL_MULT);
      });

      // ⭐ CLEAR COVER — one press back to a plain wall the module knows nothing about. The DOCUMENT
      // write is what makes that true (blank inputs alone leave the stored flags, and a breached wall
      // open); the input blanking is what stops the sheet's own pending submit from re-writing them.
      // A breached wall is REPAIRED first, so "clear" can never strand a hole in the map.
      fieldset.querySelector(".cp-cover-wall-clear")?.addEventListener("click", async (ev) => {
        ev.preventDefault();
        try {
          if (doc?.flags?.[SCOPE]?.coverBreach) await repairCoverWall({ wallUuid: doc.uuid });
          await doc.update({
            ...deleteFieldUpdate(`flags.${SCOPE}.coverSp`),
            ...deleteFieldUpdate(`flags.${SCOPE}.coverPool`),
            ...deleteFieldUpdate(`flags.${SCOPE}.coverPoolMax`),
            ...deleteFieldUpdate(`flags.${SCOPE}.coverBreach`),
          });
          for (const input of [spIn, poolIn, poolMaxIn]) if (input) input.value = "";
          ui.notifications?.info?.(localize("CoverWallCleared"));
        } catch (e) {
          console.warn(`${SCOPE} | cover clear failed`, e);
        }
      });

      // The fieldset's own repair control, for a breach whose card has scrolled out of the log.
      fieldset.querySelector(".cp-cover-wall-repair")?.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.currentTarget.disabled = true;
        try { await requestCoverRepair({ wallUuid: doc.uuid }); }
        catch (e) { console.warn(`${SCOPE} | cover repair failed`, e); }
      });
    } catch (e) {
      console.warn(`${SCOPE} | cover wall-config fields failed`, e);
    }
  });
}
