/**
 * ══════════════════════ PERSISTENT CONDITION OVERLAYS ══════════════════════
 *
 * A looping sprite that rides a figure for exactly as long as the condition that caused it is on that
 * figure, and goes the moment it clears. Nothing here is written anywhere: the overlays are drawn by
 * each client for itself, on the scene it is looking at, and a reload rebuilds them from the
 * conditions that are still there. That is the same bargain the burning ground struck (module/fx/
 * effects.js, GROUND_FIRE) and this file is deliberately built to its shape — cap, census-by-query,
 * eviction through the engine's own manager, a stamped name under one prefix, no document writes.
 *
 * ⭐ WHY IT IS A SEPARATE FILE, and what the rail's one rule now says. `module/fx/effects.js` used to
 * be described as the only file that knows about outside effect engines. The rule is really about
 * CONTAINMENT — one place a reader goes when a drawing looks wrong — and that is now `module/fx/`
 * rather than one 5 000-line file inside it. Every capability question this file asks is asked through
 * the rail's own answers (`sequencerActive`, `fxDbEntryExists`, `_held`'s sibling seam below,
 * `tokenRadiusPx`, `LIT_SPRITE_ABOVE_LIGHTING`), so there is still exactly one adapter to the engine;
 * only the element table lives here. docs/FX-RAIL.md §2a carries the same statement.
 *
 * ⭐ THE DETECTION RULE — TWO SOURCES, ONE ANSWER. A condition reaches a figure by one of two roads on
 * this system, and the resolver below reads both into one list:
 *   1. A CORE STATUS. The base system registers none of its own (verified: zero `CONFIG.statusEffects`
 *      writes anywhere in it), so a token carries exactly Foundry's default set and the module's own
 *      mechanisms speak that vocabulary too — `toggleStatusEffect("dead")` from the damage applicator
 *      and the death save, `toggleStatusEffect("unconscious")` from the stun save. Read through
 *      `actor.statuses`, which is core's own resolved Set.
 *   2. A MODULE FLAG. The lasting-damage engines carry their own state in actor flags rather than as
 *      statuses — `fireDotState` while a figure is burning, `dotState` while a load is eating its
 *      armour. Those are the mechanisms the user named first, and they are NOT statuses, so a build
 *      that only watched `actor.statuses` would have drawn nothing for either.
 * Both roads are ordinary actor mutations, so both are caught by the same hooks and neither is polled.
 *
 * ⛔ WHAT IS DELIBERATELY NOT HERE. The inventory in docs/FX-RAIL.md §2a is closed and most of it has
 * no treatment: the user's instruction was to adapt the ones that do not read across from the source
 * material WITH them, so every other marker on that list is recorded as an open call rather than given
 * a look nobody asked for. Five rows ship. The table is the whole feature — a sixth row is a table
 * entry, not a code change.
 */

// ⚠ `LIT_SPRITE_ABOVE_LIGHTING` is imported and NOT currently read by any row, deliberately. Since the
// reference-exact ruling (2026-08-12) every row draws below the tokens, and the recorded way back for
// any one of them is to restore `aboveLighting: LIT_SPRITE_ABOVE_LIGHTING` — one field, at the row. It
// stays imported so that revert remains one field rather than one field plus an import, and so the
// header's claim that this file asks every capability question through the rail's own answers stays
// literally true.
import {
  sequencerActive, fxDbEntryExists, tokenRadiusPx, LIT_SPRITE_ABOVE_LIGHTING,
} from "./effects.js";
import { combatFxEnabled } from "../settings.js";

const SCOPE = "cp2020-augmented";

/** The one prefix every overlay is stamped under, so the census is a query of the engine. */
export const STATUS_FX_NAME = `${SCOPE}.statusfx`;

/**
 * THE SHARED SPEC — every number a reviewer might move, with the basis that set it.
 *
 * `lifetimeMs` IS NOT THE CONDITION'S LIFETIME. A condition can outlast any clip, so the overlay is
 * issued for a long fixed span and RE-ISSUED when the engine reports it ended while the condition is
 * still there (see `_onEffectEnded`). Ten minutes is chosen so the re-issue is rare enough to be
 * invisible and short enough that a leak cannot outlive a session; it is a cap, not a promise, exactly
 * as the burning ground's 45 s is.
 *
 * ⚠ NOT `persist()`. Sequencer's own persistence writes the effect into the SCENE'S FLAGS, which is a
 * document write from presentation — the thing this rail does not do (standard §G/22). Measured on the
 * rig: an attached, named, duration-bounded effect leaves `scene.flags.sequencer` with **zero** keys
 * and is still queryable and endable by name, so nothing is given up by refusing persistence except a
 * redraw on reload, which `canvasReady` does anyway.
 */
export const STATUS_FX = Object.freeze({
  lifetimeMs: 600000,
  fadeInMs: 300,
  fadeOutMs: 400,
  // The most overlays that may be drawn on one scene at once, across every figure. Five rows × twelve
  // figures; past that a scene is already saturated and the OLDEST are ended to make room, the same way
  // round and for the same reason as the burning ground's `maxLive`.
  maxLive: 60,
  // Where a badge sits: this far above the figure's own top edge, in grid units, and this far apart.
  // Measured against the token's OWN half-width so a 2×2 figure wears its badges outside itself rather
  // than on its chest.
  badgeRise: 0.30,
  badgeSpacing: 0.42,
  // A badge's drawn frame, in grid units. The marker clips carry ink across ~0.7 of their frame, so
  // 0.55 draws about a third of a square of actual mark.
  badgeSquares: 0.55,
  // How far apart two BODY treatments are pushed, as a fraction of the figure's own width, so a
  // burning figure being eaten by acid reads as two things rather than one smear.
  bodySpread: 0.22,
});

/**
 * THE TREATMENT TABLE — the whole feature. One row per condition that has a shipped look.
 *
 * `statuses`  core condition ids that raise this row (read from `actor.statuses`).
 * `flags`     module actor-flag names under `flags.cp2020-augmented` that raise it; a flag counts as
 *             raised when it holds a non-empty array or a truthy object (that is the shape every
 *             lasting-damage engine on this module stores — a list of live markers).
 * `key`       the database key. Existence is guarded per draw; a tier without it skips silently.
 * `placement` `ring` (riding the figure's rim, centered, concentric with its siblings — the house
 *             standard since the 2026-08-12 ruling) · `body` (on the figure, side-spread) · `badge`
 *             (a small mark above it) · `ground` (under it). A ring takes no slot offset: rings
 *             stack concentrically, and their differing rim scales keep them apart.
 * `colour`    an optional ColorMatrix, for a row whose only loop in the free tier is the wrong colour.
 * `suppressedBy` a row id that, when present, cancels this one.
 *
 * ORDER IS LOAD-BEARING: a row's index among its own placement family fixes its slot, so a figure that
 * gains a third condition does not shuffle the two it already wore. Reordering this array moves marks
 * on screen.
 *
 * ⭐ EVERY KEY WAS DECODED BEFORE IT WAS CHOSEN, not picked by name (standard §A/4).
 *
 * ⭐⭐ THE RING STANDARD (user ruling 2026-08-12: "All of our effects should look like this ring
 * effect"). The reference setup dresses a condition as a ring riding the figure's rim — the JB2A
 * `shield_themed` family (fire below/above the token, molten earth, eldritch web) — under a dome
 * sheen that is the asset's own. Every non-ground row below is a RING now; the earlier centered
 * flame / badge treatments are the superseded mechanism, and each row records its revert key.
 * Decode numbers for the ring set (24 fps unless noted; thirds = mean luma per clip third; seam =
 * |first−last| frame):
 *   · shield_themed.below.fire.01.orange       5000 ms, ink 339×345/400², thirds 28.3/30.6/26.5
 *     (flat), seam 5.39 — the flicker masks the seam. THE burning ring.
 *   · shield_themed.above.fire.01.orange       5000 ms, ink 358×361/400², thirds 60.2/49.9/40.9 —
 *     DECAYS across its own clip: looped, it pulses every 5 s. Recorded, not smoothed; it is the
 *     one-constant "stronger tier" swap and carries this caveat at the site.
 *   · shield_themed.below.molten_earth.01.orange 5000 ms, ink 382×384/400², thirds 31.0/31.9/31.0,
 *     seam 2.59 — the cleanest loop of the set. The acid ring (hue-rotated green, as before).
 *   · shield_themed.below.eldritch_web.01.dark_purple 10042 ms, dead-flat thirds 47.6/47.6/47.5,
 *     seam 2.87 — native purple, the stunned ring.
 *   · markers.smoke.ring.loop.bluepurple (30 fps) 5067 ms, ink full-frame, thirds 56.9/56.9/54.5,
 *     seam 5.05 — the poison ring, hue-rotated toward green.
 * Ring SCALE compensates each asset's own ink fraction (frame 400 ÷ ink extent), so every ring's
 * drawn diameter lands on the figure's rim rather than inside it — the basis is beside each value.
 */
export const STATUS_FX_ROWS = Object.freeze([
  Object.freeze({
    // ⭐ TWO SOURCES ON ONE ROW, AND THEY NOW ARRIVE TOGETHER. The fire load's lasting damage lives in
    // `fireDotState` (module/combat/damage-hooks.js), and since 2026-08-13 the engine that writes it
    // also raises core's own `burning` (save-rolls.js `mirrorDotStatus`) and lowers it when the last
    // marker expires — so a burning figure has a real ActiveEffect, which is what the token HUD, the
    // effects list and every other module read. That does NOT double this row: the resolver below asks
    // whether ANY of a row's sources is raised, so one condition arriving by both roads is still one
    // mark. The core id is watched in its own right as well, for the GM who reaches for the token HUD
    // without any load being involved.
    //
    // RING (reference "On Fire (Mild)" = the below-token fire ring), drawn UNDER the mini exactly as the
    // reference draws it — user ruling 2026-08-12: "reference exact", taken with its cost stated. THE
    // COST: below the tokens is below the LIGHTING, so on an unlit square this ring is not there to be
    // seen. The table accepted that in exchange for the reference's own composition, where an over-token
    // ring sat on the figure rather than under it. THE WAY BACK IS THE SAME ONE FIELD IT ALWAYS WAS: drop
    // `below` and restore `aboveLighting: LIT_SPRITE_ABOVE_LIGHTING`, which buys visibility in the dark
    // at the price of the fidelity that was asked for. Stronger tier =
    // `jb2a.shield_themed.above.fire.01.orange`, one key away, but see the header: that clip decays
    // across itself and pulses when looped.
    // Superseded key (centered flame, ruled out 2026-08-12): "jb2a.flames.02.orange" @ body 1.15.
    id: "burning", statuses: ["burning"], flags: ["fireDotState"],
    key: "jb2a.shield_themed.below.fire.01.orange", placement: "ring",
    scale: 1.18,   // frame 400 ÷ ink 339 — the ring's drawn diameter lands on the rim
    opacity: 0.85, aboveLighting: false, below: true,
  }),
  Object.freeze({
    // No module mechanism raises this today — it is the core id only, which is exactly what a GM
    // marking a figure poisoned by hand produces. Recorded as such rather than wired to something
    // approximate: this rail does not invent a mechanism to have something to draw.
    //
    // RING: the free tier's one true smoke ring loop, authored blue-purple; rotated toward a fume
    // green. One constant (drop `colour`) reverts to the asset's own colour. Drawn UNDER the mini with
    // every other row (2026-08-12, reference-exact) and carrying the same accepted cost — invisible on
    // an unlit square — with the same one-field way back: drop `below`, restore
    // `aboveLighting: LIT_SPRITE_ABOVE_LIGHTING`.
    // Superseded key (badge, ruled out 2026-08-12): "jb2a.markers.poison.dark_green.02" @ badge.
    id: "poison", statuses: ["poison"], flags: [],
    key: "jb2a.markers.smoke.ring.loop.bluepurple", placement: "ring",
    colour: Object.freeze({ hue: 130, saturate: 0.1, brightness: 1.0 }),
    scale: 1.0,    // ink reaches the frame edge — the frame IS the ring extent
    opacity: 0.85, aboveLighting: false, below: true,
  }),
  Object.freeze({
    // The acid load degrades armour over turns and keeps its countdown in `dotState`, and — as with the
    // burn above, and since the same day — the engine that writes that flag also raises core's own
    // `corrode` and lowers it with the last marker (save-rolls.js `mirrorDotStatus`), so the two roads
    // arrive together and still draw one mark. `corrode` remains meaningful on its own for a GM who
    // sets it by hand. THE COLOUR IS OURS: the ring set has no green, so the
    // molten-earth ring is rotated to an acid green rather than replaced by a clip that is the right
    // colour and the wrong motion. One constant reverts it to the asset's own orange. Drawn UNDER the
    // mini with every other row (2026-08-12, reference-exact), invisible on an unlit square by the same
    // accepted trade, and back over the lighting by the same one field: drop `below`, restore
    // `aboveLighting: LIT_SPRITE_ABOVE_LIGHTING`.
    // Superseded key (centered bubbles, ruled out 2026-08-12): "jb2a.bubble.002.001.loop.blue" @ 0.9.
    id: "acid", statuses: ["corrode"], flags: ["dotState"],
    key: "jb2a.shield_themed.below.molten_earth.01.orange", placement: "ring",
    colour: Object.freeze({ hue: -120, saturate: 0.15, brightness: 1.0 }),
    scale: 1.05,   // frame 400 ÷ ink 382
    opacity: 0.8, aboveLighting: false, below: true,
  }),
  Object.freeze({
    // ⭐ BOTH IDS, because this engine's stun outcome IS `unconscious`: a failed stun save calls
    // `toggleStatusEffect("unconscious")` (module/combat/save-rolls.js) and the recovery check toggles
    // it back off. Core's own `stun` is watched beside it so a hand-marked figure reads the same.
    // Whether those two deserve two different looks is an open call — docs/FX-RAIL.md §8.
    //
    // RING: the eldritch-web ring — native purple, the longest and flattest loop of the set (10 s,
    // seam 2.87). Drawn UNDER the mini with every other row (2026-08-12, reference-exact): gone on an
    // unlit square, which the table accepted, and back over the lighting by dropping `below` and
    // restoring `aboveLighting: LIT_SPRITE_ABOVE_LIGHTING`.
    // Superseded key (badge, ruled out 2026-08-12): "jb2a.markers.stun.purple.02".
    id: "stunned", statuses: ["stun", "unconscious"], flags: [],
    key: "jb2a.shield_themed.below.eldritch_web.01.dark_purple", placement: "ring",
    scale: 1.25,   // frame 400 ÷ ink 320
    opacity: 0.9, aboveLighting: false, below: true,
    // A corpse wearing a stun ring is noise: `dead` and `unconscious` genuinely stand together here,
    // because the applicator sets one and the stun save had already set the other.
    suppressedBy: "dead",
  }),
  Object.freeze({
    // Deliberately the quietest row in the table. Core already draws its own skull icon on a dead
    // token, so this exists to say "out" at a glance across a table, not to restate the icon — a dim
    // ring on the ground under the figure, drawn BELOW the tokens so it never covers the mini.
    // ⚠ THE TRADE: below the tokens is also below the lighting, so on an unlit square the ring is not
    // there to be seen. It was the FIRST row where that was acceptable — the token's own core icon is
    // unaffected and still carries the fact — and since the reference-exact ruling (2026-08-12) it is
    // the trade every row above makes as well. One field (`placement: "badge"`) moves this one out.
    id: "dead", statuses: ["dead"], flags: [],
    key: "jb2a.markers.simple.001.loop.001.red", placement: "ground",
    scale: 1.25, opacity: 0.55, aboveLighting: false, below: true,
  }),
]);

/* ══════════════════════════ The pure half ══════════════════════════ */

/** Does this module-flag value count as a live marker? The shape every lasting-damage engine stores. */
function flagIsRaised(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

/**
 * WHICH TREATMENTS THIS FIGURE HAS EARNED, in table order. Pure — it takes a snapshot, never a
 * document, so the whole detection rule is assertable without a canvas.
 *
 * @param {{statuses?: Iterable<string>, flags?: object}} source
 * @returns {string[]} row ids, in `STATUS_FX_ROWS` order, with suppression applied
 */
export function statusMarkersOf(source = {}) {
  const statuses = new Set(source.statuses ?? []);
  const flags = source.flags ?? {};
  const raised = STATUS_FX_ROWS
    .filter((row) => row.statuses.some((s) => statuses.has(s)) || row.flags.some((f) => flagIsRaised(flags[f])))
    .map((row) => row.id);
  const present = new Set(raised);
  return raised.filter((id) => {
    const row = STATUS_FX_ROWS.find((r) => r.id === id);
    return !(row.suppressedBy && present.has(row.suppressedBy));
  });
}

/**
 * WHERE ONE TREATMENT SITS on a figure, in grid units from its centre. Pure, and slotted by the row's
 * own index within its placement family rather than by draw order — which is what stops a figure's
 * existing marks from sliding sideways when it gains a new one.
 *
 * @param {string} id            the row id
 * @param {number} widthSquares  the figure's own width in grid squares
 */
export function statusFxOffset(id, widthSquares = 1) {
  const row = STATUS_FX_ROWS.find((r) => r.id === id);
  if (!row) return { x: 0, y: 0 };
  const w = Number(widthSquares) > 0 ? Number(widthSquares) : 1;
  const family = STATUS_FX_ROWS.filter((r) => r.placement === row.placement);
  const slot = family.findIndex((r) => r.id === row.id);
  const centred = slot - (family.length - 1) / 2;
  if (row.placement === "badge") {
    return { x: centred * STATUS_FX.badgeSpacing, y: -(w / 2 + STATUS_FX.badgeRise) };
  }
  if (row.placement === "body") {
    return { x: centred * STATUS_FX.bodySpread * w, y: 0 };
  }
  return { x: 0, y: 0 };
}

/** The engine name one figure's one treatment is stamped with. Encodes the token so a delete can sweep. */
export function statusFxNameFor(tokenId, id) {
  return `${STATUS_FX_NAME}.${tokenId}.${id}`;
}

/* ══════════════════════════ The census ══════════════════════════ */

/** Overlays QUEUED but not yet created by the engine — counted against the scene cap. */
let _pending = 0;
export function pendingStatusFx() { return _pending; }

/** Names WE are ending on purpose, so the ended-hook does not read the end as an expiry and redraw. */
const _intentionalEnds = new Set();

/**
 * EVERY OVERLAY ALIVE ON THIS CLIENT RIGHT NOW, oldest first — the cap's only reader, and a query of
 * the engine rather than a ledger of our own, for the reason the burning ground's census gives: a
 * tally we kept would drift the instant an effect ended for a reason we did not cause.
 */
export function liveStatusFx() {
  try {
    const list = globalThis.Sequencer?.EffectManager?.getEffects?.({ name: `${STATUS_FX_NAME}.*` }) ?? [];
    return [...list].sort((a, b) => (a?.data?.creationTimestamp ?? 0) - (b?.data?.creationTimestamp ?? 0));
  } catch (_e) {
    return [];
  }
}

/**
 * End one overlay by name, on purpose. Registers the intent first so the ended-hook stays quiet.
 *
 * ⚠ THE INTENT REGISTER IS BOUNDED. An entry is normally consumed by the engine's own report a beat
 * later, but an end aimed at a name the engine has already forgotten is never reported and its entry
 * would sit there for the session. Names are short and the bound is generous, so this is housekeeping
 * rather than a real leak — but an unbounded set fed by a hook is how one starts.
 */
const INTENT_REGISTER_MAX = 256;
function endStatusFx(name) {
  if (_intentionalEnds.size >= INTENT_REGISTER_MAX) {
    _intentionalEnds.delete(_intentionalEnds.values().next().value);   // oldest out; Sets keep insertion order
  }
  _intentionalEnds.add(name);
  try {
    globalThis.Sequencer?.EffectManager?.endEffects?.({ name })
      ?.catch?.((err) => console.warn(`${SCOPE} | condition overlay end failed`, err));
  } catch (err) {
    console.warn(`${SCOPE} | condition overlay end failed`, err);
  }
}

/* ══════════════════════════ The impure half ══════════════════════════ */

/**
 * Is this placeable safe to read? ⚠ THE GUARD THAT COST A TEARDOWN DEFECT ELSEWHERE: refresh and draw
 * hooks fire WHILE a token is being destroyed, at which point the placeable is still handed to us but
 * its document and its transform are already going. Everything below reads a token only through this.
 */
function tokenIsLive(token) {
  try {
    return !!token && token.destroyed !== true && !!token.document && !!token.document.id;
  } catch (_e) {
    return false;
  }
}

/** The snapshot the pure resolver takes, built from a live actor. */
export function statusSourceOf(actor) {
  if (!actor) return { statuses: [], flags: {} };
  let statuses = [];
  try { statuses = [...(actor.statuses ?? [])]; } catch (_e) { statuses = []; }
  const flags = actor.flags?.[SCOPE] ?? {};
  return { statuses, flags };
}

/**
 * DRAW ONE TREATMENT ON ONE FIGURE. Not awaited by the reconciler and never tagged for the shot rail's
 * settle signal — an overlay that is meant to outlive the action is scene dressing in exactly the sense
 * that ruling names, and the damage window must never wait on one.
 *
 * ⭐ ATTACHED, NOT PLANTED. `attachTo` makes the engine carry the sprite with the figure, so a token
 * that walks does not leave its condition behind; `followRotation: false` keeps a badge upright when a
 * figure turns to face a shot (the rail turns tokens — see effects.js `faceTarget`).
 */
function drawStatusFx(token, row) {
  const name = statusFxNameFor(token.document.id, row.id);
  const gridPx = Number(canvas?.dimensions?.size) || 100;
  const widthSquares = (tokenRadiusPx(token, gridPx) * 2) / gridPx;
  const offset = statusFxOffset(row.id, widthSquares);
  const seq = new globalThis.Sequence();
  const fx = _heldStatus(seq.effect().file(row.key))
    .attachTo(token, { followRotation: false })
    .opacity(row.opacity ?? 1)
    .name(name)
    .fadeIn(STATUS_FX.fadeInMs)
    .duration(STATUS_FX.lifetimeMs)
    .fadeOut(STATUS_FX.fadeOutMs);
  if (row.placement === "badge") fx.size({ width: STATUS_FX.badgeSquares }, { gridUnits: true });
  else fx.scaleToObject(row.scale ?? 1);
  if (offset.x || offset.y) fx.spriteOffset({ x: offset.x, y: offset.y }, { gridUnits: true });
  if (row.below) fx.belowTokens();
  else if (row.aboveLighting) fx.aboveLighting(true);
  if (row.colour) fx.filter("ColorMatrix", row.colour);
  _pending++;
  seq.play()
    .catch((err) => console.warn(`${SCOPE} | condition overlay play failed`, err))
    .finally(() => { _pending = Math.max(0, _pending - 1); });
  return name;
}

/** Capture seam, mirroring the shot rail's `_held`: applied FIRST so a trim cannot outrun it. */
let _statusRateOverride = null;
export function _setStatusFxRate(rate) {
  _statusRateOverride = Number.isFinite(rate) && rate > 0 ? Number(rate) : null;
  return _statusRateOverride;
}
function _heldStatus(effect) {
  if (_statusRateOverride !== null) effect.playbackRate(_statusRateOverride);
  return effect;
}

/**
 * RECONCILE ONE FIGURE: what it should be wearing against what it is wearing. This is the only writer.
 *
 * It is a reconciler rather than a pair of add/remove handlers on purpose — every hook below simply
 * says "this figure may have changed" and the answer is recomputed from the conditions themselves, so
 * a missed event, a reload, a scene change and a GM clearing a status by hand all converge on the same
 * picture instead of each needing its own branch.
 *
 * Returns what it did, by value, so the whole mechanism is assertable from a keeper.
 */
export function syncTokenStatusFx(token) {
  const out = { added: [], removed: [], evicted: 0, skipped: null, wanted: [] };
  if (!sequencerActive()) { out.skipped = "engine"; return out; }
  if (!tokenIsLive(token)) { out.skipped = "token"; return out; }
  const tokenId = token.document.id;
  const drawn = new Map(
    liveStatusFx()
      .map((e) => String(e?.data?.name ?? ""))
      .filter((n) => n.startsWith(`${STATUS_FX_NAME}.${tokenId}.`))
      .map((n) => [n.slice(`${STATUS_FX_NAME}.${tokenId}.`.length), n]),
  );
  // THE MASTER SWITCH IS A CLEAR, NOT A RETURN. A GM turning the rail off mid-session expects the
  // screen to settle, so "off" means every overlay this file drew comes down at the next event rather
  // than lingering until a reload.
  const wanted = combatFxEnabled() ? statusMarkersOf(statusSourceOf(token.actor)) : [];
  if (!combatFxEnabled()) out.skipped = "disabled";
  out.wanted = wanted;

  for (const [id, name] of drawn) {
    if (!wanted.includes(id)) { endStatusFx(name); out.removed.push(name); }
  }
  const missing = wanted
    .filter((id) => !drawn.has(id))
    .map((id) => STATUS_FX_ROWS.find((r) => r.id === id))
    .filter((row) => row && fxDbEntryExists(row.key));
  if (!missing.length) return out;

  // THE SCENE CAP, enforced here and only here, by ending the OLDEST — never the newest, because the
  // figure a viewer just marked is the one that must be drawn. The PENDING tally is part of the count
  // for the reason the burning ground records: an overlay that has been queued is invisible to the
  // census until the engine's own play resolves, so two syncs inside that beat would both under-evict.
  // ⚠ AN EVICTED OVERLAY IS NOT A LOST CONDITION — the next event that touches that figure redraws it,
  // because the reconciler always recomputes from the condition rather than from what is on screen.
  try {
    const live = liveStatusFx();
    const overBy = live.length + _pending + missing.length - STATUS_FX.maxLive;
    if (overBy > 0) {
      const names = live.slice(0, Math.min(overBy, live.length)).map((e) => e?.data?.name).filter(Boolean);
      out.evicted = names.length;
      for (const name of names) endStatusFx(name);
    }
  } catch (err) {
    console.warn(`${SCOPE} | condition overlay cap failed`, err);
  }

  for (const row of missing) {
    try { out.added.push({ id: row.id, key: row.key, name: drawStatusFx(token, row) }); }
    catch (err) { console.warn(`${SCOPE} | condition overlay draw failed`, row.id, err); }
  }
  return out;
}

/** Reconcile every figure an actor is drawn as on the scene this client is looking at. */
export function syncActorStatusFx(actor) {
  const results = [];
  if (!actor) return results;
  try {
    for (const token of canvas?.tokens?.placeables ?? []) {
      if (tokenIsLive(token) && token.actor?.id === actor.id) results.push(syncTokenStatusFx(token));
    }
  } catch (err) {
    console.warn(`${SCOPE} | condition overlay actor sweep failed`, err);
  }
  return results;
}

/** Reconcile every figure on the viewed scene — the reload path, and the master switch's own sweep. */
export function syncSceneStatusFx() {
  const results = [];
  try {
    for (const token of canvas?.tokens?.placeables ?? []) {
      if (tokenIsLive(token)) results.push(syncTokenStatusFx(token));
    }
  } catch (err) {
    console.warn(`${SCOPE} | condition overlay scene sweep failed`, err);
  }
  return results;
}

/** Take every overlay down — the scene is going, or the client is. Names only: no placeable is read. */
export function clearStatusFx() {
  for (const effect of liveStatusFx()) {
    const name = effect?.data?.name;
    if (name) endStatusFx(name);
  }
}

/** Take down everything belonging to ONE figure, by name — safe while the placeable is being destroyed. */
export function clearTokenStatusFx(tokenId) {
  if (!tokenId) return 0;
  const prefix = `${STATUS_FX_NAME}.${tokenId}.`;
  let n = 0;
  for (const effect of liveStatusFx()) {
    const name = String(effect?.data?.name ?? "");
    if (name.startsWith(prefix)) { endStatusFx(name); n++; }
  }
  return n;
}

/**
 * THE RE-ISSUE. An overlay that reaches the end of its ten minutes has ended for a reason that has
 * nothing to do with the condition, so the figure is reconciled again and gets it back. An overlay WE
 * ended — because the condition cleared, because the cap needed room, because the scene is going —
 * registered its intent first and is simply forgotten here, which is what stops an eviction from
 * immediately undoing itself.
 */
function _onEffectEnded(effect) {
  const name = String(effect?.data?.name ?? "");
  if (!name.startsWith(`${STATUS_FX_NAME}.`)) return;
  if (_intentionalEnds.delete(name)) return;
  const tokenId = name.slice(`${STATUS_FX_NAME}.`.length).split(".")[0];
  const token = canvas?.tokens?.placeables?.find((t) => tokenIsLive(t) && t.document.id === tokenId);
  if (token) syncTokenStatusFx(token);
}

/**
 * Hook wiring — called once from the module's ready hook, registered unconditionally like the shot
 * rail's, because the master switch is read per event rather than at registration.
 *
 * ⭐ THE MUTATION POINTS, NOT A TIMER. A condition arrives one of three ways and each has its own
 * document event: core statuses are ActiveEffects on the actor (create / update / delete), module flags
 * are actor updates, and a figure can also arrive already wearing one (token create, canvas ready).
 * Nothing here polls, and nothing here reads a condition on a schedule.
 *
 * ⭐ WHO SEES THEM: everyone. These are state visibility rather than a GM's secret, and every condition
 * with a shipped row is already public on this system — core draws its own status icon on the token for
 * every client, and the module's own lasting-damage cards post to chat. So the sync runs on each client
 * for itself, with no GM gate; there is no GM-only condition on this system to mirror.
 */
export function registerStatusFx() {
  const syncFromDoc = (doc) => {
    const actor = doc?.parent?.documentName === "Actor" ? doc.parent : (doc?.actor ?? doc);
    if (actor?.documentName === "Actor") syncActorStatusFx(actor);
  };
  Hooks.on("createActiveEffect", syncFromDoc);
  Hooks.on("deleteActiveEffect", syncFromDoc);
  Hooks.on("updateActiveEffect", syncFromDoc);
  // The module-flag road: `setFlag` is an actor update, so this is the same event a condition written
  // by the acid or fire engine arrives on.
  //
  // ⚠ SCOPED TO THE CHANGE, because this is the busiest hook in Foundry — it fires for every damage
  // box, every stat edit, every sheet save on every actor, and an unscoped listener would walk the
  // canvas each time. A core condition never arrives this way (it is an ActiveEffect, caught above), so
  // the only shape worth reacting to is a write inside this module's own flag namespace; `statuses` and
  // `effects` are admitted beside it so a future core that moves conditions onto the actor document
  // itself is not silently unhandled.
  Hooks.on("updateActor", (actor, changes) => {
    const touched = changes?.flags?.[SCOPE] !== undefined
      || changes?.statuses !== undefined || changes?.effects !== undefined;
    if (touched) syncActorStatusFx(actor);
  });
  // An unlinked figure carries its own actor, so its conditions arrive as a token update.
  Hooks.on("updateToken", (tokenDoc) => {
    const token = tokenDoc?.object;
    if (tokenIsLive(token)) syncTokenStatusFx(token);
  });
  Hooks.on("createToken", (tokenDoc) => {
    const token = tokenDoc?.object;
    if (tokenIsLive(token)) syncTokenStatusFx(token);
  });
  // ⚠ BY NAME, NEVER BY PLACEABLE. The placeable is mid-destruction when this fires; the engine's own
  // teardown of an attached effect is not something we can rely on having happened yet.
  Hooks.on("deleteToken", (tokenDoc) => clearTokenStatusFx(tokenDoc?.id));
  // Nothing survives a reload, so the reload path is a redraw from the conditions that are still there.
  Hooks.on("canvasReady", () => syncSceneStatusFx());
  Hooks.on("canvasTearDown", () => clearStatusFx());
  Hooks.on("endedSequencerEffect", _onEffectEnded);
  // ⭐⭐ REGISTER **AND CATCH UP**, ON THE ENGINE'S OWN SIGNAL — and the second half of that sentence is
  // the whole finding. The listener above is registered too late to hear the load that installed it:
  // `canvasReady` fires while the game is being set up, BEFORE the module's ready hook runs, so on a
  // reload the first scene is already drawn and its redraw has already been missed. That much is the
  // chat rail's known shape (module/chat-render-compat.js). But a catch-up taken at `ready` is ALSO too
  // EARLY — measured on the rig, in this order:
  //
  //     canvasReady   @ +0 ms      ← the redraw we needed, before we existed
  //     ready         @ +12 ms     ← where a naive catch-up would run
  //     sequencerReady@ +677 ms    ← where the effect engine can actually draw
  //
  // `sequencerActive()` is already true at `ready` (the module is active and its constructor exists),
  // so a sweep there does not bail — it queues work against an engine that is not up yet and the work
  // is simply lost, which looked exactly like the missing redraw it was meant to fix. Hanging the
  // catch-up on `sequencerReady` puts it after both. Safe to run repeatedly: the sweep is a RECONCILER,
  // so a pass over an already-correct scene draws nothing and ends nothing.
  Hooks.on("sequencerReady", () => syncSceneStatusFx());
  // And the case the hook cannot cover: this function called when the engine is ALREADY up (a late
  // enable, or a spec importing the module mid-session), where `sequencerReady` has long since fired.
  if (canvas?.ready && globalThis.Sequencer?.EffectManager) syncSceneStatusFx();
}
