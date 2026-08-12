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
 * nothing. The GM can scale poolMax for massiveness (the book's ×4/×5 or ×1 note).
 *
 * State legibility is COLOR + CARDS, zero custom canvas rendering: the module drives the region
 * color through three bands (intact amber → chewed orange → destroyed gray) and posts a chew
 * card on every debit. Placement is native-first (the radiation lesson): the GM scene tool spawns
 * a small ready-made cover region from the book preset table at the view center, then the native
 * Region tools reshape/move/delete it — or the GM hand-authors a Region and adds the behavior.
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

import { localize, localizeParam } from "../utils.js";
import { COVER_ZONE_BEHAVIOR } from "./cover-zone-behavior.js";

const SCOPE = "cp2020-augmented";
const MSG_CHEW = "coverChew";

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

/* ══════════════════════════════════ Zone access / queries ══════════════════════════════════ */

/** Normalized rows for every enabled cover-zone behavior on a scene. */
export function coverZonesOn(scene) {
  const out = [];
  for (const region of scene?.regions ?? []) {
    for (const behavior of region.behaviors ?? []) {
      if (behavior.type !== COVER_ZONE_BEHAVIOR || behavior.disabled) continue;
      const s = behavior.system ?? {};
      out.push({
        region, behavior,
        uuid: behavior.uuid,
        label: region.name || s.material || localize("CoverZoneFallbackName"),
        sp: Number(s.sp) || 0,
        pool: Number(s.pool) || 0,
        poolMax: Number(s.poolMax) || 0,
        destroyed: !!s.destroyed || (Number(s.pool) || 0) <= 0,
      });
    }
  }
  return out;
}

/**
 * Normalized rows for every cover-flagged wall on a scene (Unit 3). A wall is cover when its
 * coverSp flag is a positive number. Structure defaults follow the zone rule (pool = 3 × SP)
 * until the wall carries explicit numbers — only a real stored NUMBER counts as an explicit
 * pool (a cleared form field submits null and must not read as "destroyed at 0").
 */
export function coverWallsOn(scene) {
  const out = [];
  for (const wall of scene?.walls ?? []) {
    const f = wall.flags?.[SCOPE] ?? {};
    const sp = Math.max(0, Number(f.coverSp) || 0);
    if (sp <= 0) continue;
    const poolMax = (typeof f.coverPoolMax === "number" && Number.isFinite(f.coverPoolMax) && f.coverPoolMax > 0)
      ? Math.round(f.coverPoolMax) : sp * COVER_POOL_MULT;
    const pool = (typeof f.coverPool === "number" && Number.isFinite(f.coverPool))
      ? Math.max(0, Math.round(f.coverPool)) : poolMax;
    const isDoor = (wall.door ?? 0) > 0;
    const material = (typeof f.coverMaterial === "string") ? f.coverMaterial.trim() : "";
    const c = wall.c ?? [];
    out.push({
      wall,
      uuid: wall.uuid,
      label: material || localize(isDoor ? "CoverWallDoorFallbackName" : "CoverWallFallbackName"),
      sp, pool, poolMax,
      destroyed: pool <= 0,
      isDoor,
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

/** Candidate cover rows for a target token's scene — zones AND cover-flagged walls, nearest first
 *  (unknown-centre rows last). Every row carries a uuid; the chew entry point dispatches on it. */
export function coverChoicesFor(tokenDoc) {
  const scene = tokenDoc?.parent ?? canvas?.scene;
  const rows = [...coverZonesOn(scene), ...coverWallsOn(scene)];
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

  const out = [];
  for (const r of coverChoicesFor(targetTokenDoc)) {
    if (r.destroyed) continue;
    let crossed = false;
    try {
      if (r.wall) {
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
    if (crossed) out.push(r);
  }
  return out;
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
 */
export async function chewCoverZone({ behaviorUuid, damage, weaponName = "" }) {
  const behavior = await fromUuid(behaviorUuid);
  if (!behavior || behavior.type !== COVER_ZONE_BEHAVIOR) return null;
  const s = behavior.system ?? {};
  if (s.destroyed) return { pool: 0, destroyed: true, already: true };

  const dmg = Math.max(0, Math.round(Number(damage) || 0));
  if (dmg <= 0) return { pool: Number(s.pool) || 0, destroyed: false };
  const poolMax = Number(s.poolMax) || 0;
  const pool = Math.max(0, (Number(s.pool) || 0) - dmg);
  const destroyed = pool <= 0;

  await behavior.update({ system: { pool, destroyed } });
  const region = behavior.parent;
  try { await region?.update?.({ color: coverBandColor(pool, poolMax) }); } catch (e) { /* cosmetic */ }

  const label = region?.name || s.material || localize("CoverZoneFallbackName");
  const content = await renderTpl(`modules/${SCOPE}/templates/chat/cover-chew.hbs`, {
    label, damage: dmg, pool, poolMax, destroyed, weaponName,
  });
  await ChatMessage.create({ content });
  return { pool, destroyed };
}

/**
 * Debit a cover-flagged WALL's structure (Unit 3, GM-side write). Same lifecycle as the zone:
 * exact debit, destroyed at 0, chat card, idempotent on already-destroyed walls. One extra rule —
 * a DOOR wall broken to 0 structure swings open (door state → open), so movement and sight open
 * with the barrier. Returns {pool, destroyed} or null when the uuid isn't a cover-flagged wall.
 */
export async function chewCoverWall({ wallUuid, damage, weaponName = "" }) {
  const wall = await fromUuid(wallUuid);
  if (!wall || wall.documentName !== "Wall") return null;
  const row = coverWallsOn(wall.parent).find(r => r.uuid === wall.uuid);
  if (!row) return null;
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
  if (doorOpened) changes.ds = OPEN;
  await wall.update(changes);

  const content = await renderTpl(`modules/${SCOPE}/templates/chat/cover-chew.hbs`, {
    label: row.label, damage: dmg, pool, poolMax: row.poolMax, destroyed, doorOpened, weaponName,
  });
  await ChatMessage.create({ content });
  return { pool, destroyed };
}

/**
 * Type dispatcher for chew payloads: the picker rows carry either a RegionBehavior uuid (zone)
 * or a Wall uuid (Unit 3) in the same `behaviorUuid` field — the historical name is kept so the
 * socket message shape stays stable across the two row kinds.
 */
export async function chewCover(payload) {
  const uuid = String(payload?.uuid ?? payload?.behaviorUuid ?? "");
  if (!uuid) return null;
  const doc = await fromUuid(uuid);
  if (doc?.documentName === "Wall") {
    return chewCoverWall({ wallUuid: uuid, damage: payload?.damage, weaponName: payload?.weaponName ?? "" });
  }
  return chewCoverZone({ behaviorUuid: uuid, damage: payload?.damage, weaponName: payload?.weaponName ?? "" });
}

/**
 * Chew entry point for ANY client: the active GM writes directly; everyone else relays.
 * (Region/behavior and wall updates are GM-only — the same permission shape as every zone write.)
 */
export async function requestCoverChew(payload) {
  if (game.user?.isGM && game.users?.activeGM?.id === game.user?.id) {
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
    if (data?.type !== MSG_CHEW) return;
    if (!game.user?.isGM || game.users?.activeGM?.id !== game.user?.id) return;
    await chewCover(data);
  });
}

/* ══════════════════════════════ Placement tool (GM, native-first) ══════════════════════════════ */

/**
 * Spawn a ready-made cover region from a preset at the view centre: small rect, amber, ALWAYS
 * visible, behavior prefilled (pool = 3 × SP). The GM then reshapes/moves it with the NATIVE
 * Region tools — the radiation lesson: the module places data, the platform owns geometry.
 */
export async function placeCoverZone({ scene, label, sp, poolMax } = {}) {
  const sc = scene ?? canvas?.scene;
  if (!sc || !game.user?.isGM) return null;
  const spN = Math.max(0, Math.round(Number(sp) || 0));
  const pool = Math.max(1, Math.round(Number(poolMax) || spN * COVER_POOL_MULT));
  const grid = sc.grid?.size ?? 100;
  const cx = canvas?.stage?.pivot?.x ?? (sc.width ?? 2000) / 2;
  const cy = canvas?.stage?.pivot?.y ?? (sc.height ?? 2000) / 2;
  const w = 2 * grid, h = 1 * grid;

  const [region] = await sc.createEmbeddedDocuments("Region", [{
    name: label || localize("CoverZoneFallbackName"),
    color: coverBandColor(pool, pool),
    visibility: CONST?.REGION_VISIBILITY?.ALWAYS ?? 2,
    shapes: [{ type: "rectangle", x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h, rotation: 0 }],
    behaviors: [{ type: COVER_ZONE_BEHAVIOR, system: { sp: spN, pool, poolMax: pool, material: label ?? "" } }],
  }]);
  return region ?? null;
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
      if (poolIn) poolIn.value = String(p.sp * COVER_POOL_MULT);
      if (labelIn) labelIn.value = p.label;
    });
  });

  try {
    const result = await DialogV2.wait({
      window: { title: localize("CoverPlaceTitle") },
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
      const region = await placeCoverZone(result);
      if (region) ui.notifications?.info?.(localizeParam("CoverPlaced", { name: region.name }));
      return region;
    }
    return null;
  } finally {
    Hooks.off("renderDialogV2", hookId);
  }
}

/**
 * Add the Place-Cover tool to the token scene-control group (the df-active-lights idiom the
 * radiation tools use: augment an existing group, no bespoke canvas layer). GM-only; the tool IS
 * the opt-in. Exported pure-of-the-hook for the keeper.
 */
export function addCoverTool(controls) {
  if (!game.user?.isGM) return false;
  const tokens = controls?.tokens;
  if (!tokens?.tools) return false;
  tokens.tools["cp-cover-place"] = {
    name: "cp-cover-place",
    title: localize("CoverPlaceTool"),
    icon: "fa-solid fa-shield-halved",
    button: true,
    order: Object.keys(tokens.tools).length,
    onChange: () => openCoverPlacementDialog(),
  };
  return true;
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
 * anyway, but the guard keeps it explicit). Editing SP pre-fills empty structure fields with the
 * 3 × SP default — the same convenience the placement dialog gives zones.
 */
export function registerCoverWallConfig() {
  Hooks.on("renderWallConfig", async (app, html) => {
    try {
      if (!game.user?.isGM) return;
      const root = html instanceof HTMLElement ? html : html?.[0];
      const form = root?.tagName === "FORM" ? root : root?.querySelector?.("form");
      if (!form || form.querySelector(".cp-cover-wall-fields")) return;

      const doc = app.document;
      const f = doc?.flags?.[SCOPE] ?? {};
      const content = await renderTpl(`modules/${SCOPE}/templates/dialog/cover-wall-config.hbs`, {
        scope: SCOPE,
        sp: (typeof f.coverSp === "number" && Number.isFinite(f.coverSp)) ? f.coverSp : "",
        pool: (typeof f.coverPool === "number" && Number.isFinite(f.coverPool)) ? f.coverPool : "",
        poolMax: (typeof f.coverPoolMax === "number" && Number.isFinite(f.coverPoolMax)) ? f.coverPoolMax : "",
        material: (typeof f.coverMaterial === "string") ? f.coverMaterial : "",
        isDoor: (doc?.door ?? 0) > 0,
      });
      // Async render may lose the race against a re-render/close — re-check before inserting.
      if (!form.isConnected || form.querySelector(".cp-cover-wall-fields")) return;
      const holder = document.createElement("div");
      holder.innerHTML = content;
      const fieldset = holder.firstElementChild;
      if (!fieldset) return;
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
    } catch (e) {
      console.warn(`${SCOPE} | cover wall-config fields failed`, e);
    }
  });
}
