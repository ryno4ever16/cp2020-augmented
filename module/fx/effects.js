/**
 * Combat FX adapter (Animation Rail, Unit A1) — the ONE seam between the combat pipeline and any
 * visual/audio effect. Everything the rail knows about outside effect engines lives in this file:
 * capability detection, the weapon-class → asset mapping table, and the small verbs the pipeline
 * calls (fxShot / fxMuzzleLight / sfx). A dead or renamed dependency is then one file to re-point.
 *
 * Dependency policy (design doc §0): Sequencer + JB2A are OPTIONAL. Sprite/tracer verbs silently
 * no-op when they are absent; the muzzle LIGHT and the AUDIO are native and always work.
 *
 * What runs where: `cyberpunk2020.weaponFired` fires only on the client that resolved the shot, so
 * this adapter reaches the other clients the same way the rest of the module does — the audio is
 * emitted with the broadcast flag, the muzzle light is a token-document write (the update itself
 * broadcasts), and Sequencer effects broadcast through Sequencer's own socket.
 *
 * Numbers are the 60fps frame-study measurements recorded in the design doc §2 (per-shot cadence
 * ~80ms, flash envelope attack 1 frame → hold 2 → decay 2). They are named constants below so the
 * spec is editable in one place.
 */

import { tokensOf, updateTokenDoc, enqueueApply } from "../mech/light.js";
import { combatFxEnabled } from "../settings.js";

const SCOPE = "cp2020-augmented";

/** Token flag holding the token's own light while a flash envelope is running (restore anchor). */
const FLASH_FLAG = "fxBaseLight";

/** Where the shipped shot sounds live. Not a manifest entry — a plain asset directory. */
const SOUND_DIR = `modules/${SCOPE}/sounds`;

/** Accepted delivery extensions, in preference order (the asset lane may land any of them). */
const SOUND_EXTENSIONS = ["ogg", "mp3", "wav"];

/** Interface-channel playback level for a shot sound (each client's own interface slider scales it). */
const SHOT_VOLUME = 0.8;

/** Per-shot cadence: 10 resolved shots in ~0.67s in the reference (design doc §2.1). */
export const SHOT_CADENCE_MS = 80;

/** Upper bound on per-shot fan-out for one payload — a corrupt/huge shot count can't flood the rail. */
export const MAX_FX_SHOTS = 30;

/** Muzzle-flash light spec (design doc §2.3). Radii are in GRID SQUARES; token light fields are in
 *  scene distance units, so they are multiplied by the scene's grid distance at apply time. */
export const MUZZLE_LIGHT = Object.freeze({
  color: "#ffae42",       // warm yellow-orange
  brightSquares: 1.5,
  dimSquares: 3,
  alpha: 0.5,
  frameMs: 17,            // one frame at 60fps
  attackFrames: 1,
  holdFrames: 2,
  decayFrames: 2,
  attackLevel: 0.6,       // ramp-in fraction of the held values
  decayLevel: 0.4,        // fall-off fraction of the held values
});

/** Miss divergence for the tracer (design doc §2.4): angle offset and how far short/wide it lands. */
export const MISS_SPREAD_RAD = 0.209;   // ≈12°
export const MISS_REACH_MIN = 0.6;
export const MISS_REACH_MAX = 1.15;

/**
 * The mapping table: our weapon CLASS → Sequencer database keys + our sound basename + options.
 * Database KEYS, never file paths — a key resolves on whichever JB2A tier the user installed, and a
 * key the installed tier lacks is skipped instead of 404ing (see fxDbEntryExists).
 */
export const FX_CLASSES = Object.freeze({
  pistol:  { sound: "shot-pistol",  muzzle: "jb2a.muzzle_flash.01.orange", tracer: "jb2a.bullet.01.orange", scale: 0.5 },
  smg:     { sound: "shot-smg",     muzzle: "jb2a.muzzle_flash.01.orange", tracer: "jb2a.bullet.01.orange", scale: 0.5 },
  rifle:   { sound: "shot-rifle",   muzzle: "jb2a.muzzle_flash.01.orange", tracer: "jb2a.bullet.02.orange", scale: 0.7 },
  shotgun: { sound: "shot-shotgun", muzzle: "jb2a.muzzle_flash.01.orange", tracer: "jb2a.bullet.02.orange", scale: 0.7 },
  heavy:   { sound: "shot-heavy",   muzzle: "jb2a.muzzle_flash.01.orange", tracer: "jb2a.bullet.02.orange", scale: 0.9 },
});

/**
 * Weapon-class resolution is by TYPE, not by item name (design doc §3): the catalog is far too large
 * to enumerate, and every ranged item already carries a type. Both the stored label ("SMG") and the
 * enum key ("submachinegun") are accepted — lookups.js weaponTypes maps one to the other, and older
 * hand-authored data carries either. Melee/exotic are deliberately absent: melee gets no muzzle fx at
 * all, and the exotic palette (bows, beams) is design question Q3, still open with the user.
 */
export const WEAPON_TYPE_TO_CLASS = Object.freeze({
  pistol: "pistol",
  smg: "smg",
  submachinegun: "smg",
  rifle: "rifle",
  shotgun: "shotgun",
  heavy: "heavy",
});

/* ══════════════════════════ Capability detection ══════════════════════════ */

/** Is the Sequencer module installed, active, and exposing its Sequence constructor? */
export function sequencerActive() {
  try {
    return game.modules?.get("sequencer")?.active === true && typeof globalThis.Sequence === "function";
  } catch (_e) {
    return false;
  }
}

/** Is any JB2A asset module active? Informational only — fxDbEntryExists is the real gate. */
export function jb2aActive() {
  try {
    return ["jb2a_patreon", "JB2A_DnD5e"].some((id) => game.modules?.get(id)?.active === true);
  } catch (_e) {
    return false;
  }
}

/** Does the Sequencer database resolve this key on THIS install? A key the installed asset tier
 *  lacks (free tier vs patreon tier) must be skipped, not played — that is the silent-degrade rule. */
export function fxDbEntryExists(key) {
  try {
    const db = globalThis.Sequencer?.Database;
    if (!db || !key) return false;
    if (typeof db.entryExists === "function") return !!db.entryExists(key);
    if (typeof db.getEntry === "function") return !!db.getEntry(key);
    return false;
  } catch (_e) {
    return false;
  }
}

/* ══════════════════════════ Sound resolution ══════════════════════════ */

// Basenames present in the sounds directory, or null when the directory could not be listed on this
// client (a plain player lacks FILES_BROWSE by default). Distinguishing the two cases matters:
//   listing succeeded + asset absent → stay SILENT (an attempt would 404 and log a console error)
//   listing unavailable              → trust the shipped asset (these files ship inside the module)
let _soundManifest = null;
let _soundManifestPrimed = false;

function _filePicker() {
  return foundry?.applications?.apps?.FilePicker?.implementation
    ?? foundry?.applications?.apps?.FilePicker
    ?? globalThis.FilePicker;
}

/**
 * List the module's sounds directory once. Browses the module ROOT first (a directory that always
 * exists) so a missing sounds directory is read from the listing rather than from a rejected browse —
 * and so a permission failure is distinguishable from an absent directory.
 */
export async function primeFxSounds() {
  const FP = _filePicker();
  try {
    const root = await FP.browse("data", `modules/${SCOPE}`);
    const hasDir = (root?.dirs ?? []).some((d) => String(d).replace(/\/$/, "").endsWith("/sounds"));
    if (!hasDir) {
      _soundManifest = new Set();          // browse works, directory not delivered → silent
    } else {
      const listing = await FP.browse("data", SOUND_DIR);
      _soundManifest = new Set((listing?.files ?? []).map((f) => decodeURIComponent(String(f)).split("/").pop()));
    }
  } catch (_e) {
    _soundManifest = null;                 // no browse permission → trust the shipped asset
  }
  _soundManifestPrimed = true;
  return _soundManifest;
}

/** Test seam: seed the sound listing without touching the server (used by the rig keeper). */
export function _setSoundManifest(names) {
  _soundManifest = names === null ? null : new Set(names);
  _soundManifestPrimed = true;
  return _soundManifest;
}

/** Has the listing pass run at all on this client? */
export function fxSoundsPrimed() {
  return _soundManifestPrimed;
}

/** The playable source path for a weapon class, or null when nothing is playable for it. */
export function shotSoundSrc(cls) {
  const entry = FX_CLASSES[cls];
  if (!entry) return null;
  if (_soundManifest) {
    for (const ext of SOUND_EXTENSIONS) {
      const name = `${entry.sound}.${ext}`;
      if (_soundManifest.has(name)) return `${SOUND_DIR}/${name}`;
    }
    return null;
  }
  return `${SOUND_DIR}/${entry.sound}.${SOUND_EXTENSIONS[0]}`;
}

/**
 * Play one shot sound for every client. Native audio, no dependency: the interface channel is used
 * so each player's own interface-volume slider governs it, and the broadcast flag reaches the
 * clients the weaponFired hook never ran on. Returns the Sound (or null when nothing was played).
 */
export function sfx(cls, { volume = SHOT_VOLUME } = {}) {
  const src = shotSoundSrc(cls);
  if (!src) return null;
  try {
    return foundry.audio.AudioHelper.play({ src, volume, autoplay: true, loop: false, channel: "interface" }, true);
  } catch (err) {
    console.warn(`${SCOPE} | combat fx audio failed`, err);
    return null;
  }
}

/* ══════════════════════════ Native muzzle light (keyframe envelope) ══════════════════════════ */

/** Total envelope length in ms — attack + hold + decay frames at the measured frame length. */
export function muzzleEnvelopeDurationMs() {
  const m = MUZZLE_LIGHT;
  return m.frameMs * (m.attackFrames + m.holdFrames + m.decayFrames);
}

/**
 * The flash envelope as keyframes, for a scene whose grid square is `gridDistance` distance units.
 * Pure — the rig keeper asserts these values directly, and the applier below just writes them.
 * Shape: [{ atMs, light:{ bright, dim, alpha, color, angle } }, …]; the caller restores afterwards.
 */
export function muzzleEnvelope(gridDistance = 1) {
  const m = MUZZLE_LIGHT;
  const grid = Number(gridDistance) > 0 ? Number(gridDistance) : 1;
  const bright = m.brightSquares * grid;
  const dim = m.dimSquares * grid;
  const at = (level) => ({
    bright: Number((bright * level).toFixed(3)),
    dim: Number((dim * level).toFixed(3)),
    alpha: Number((m.alpha * level).toFixed(3)),
    color: m.color,
    angle: 360,             // a flash is omnidirectional even on a token carrying a cone light
  });
  return [
    { atMs: 0, light: at(m.attackLevel) },
    { atMs: m.frameMs * m.attackFrames, light: at(1) },
    { atMs: m.frameMs * (m.attackFrames + m.holdFrames), light: at(m.decayLevel) },
  ];
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tokens with a flash envelope in flight. Each keyframe is a document write (a server round trip
// broadcast to every client), so an automatic burst must not queue one envelope PER ROUND: the
// backlog would outlive the burst, saturate the socket, and delay the per-shot audio timers that
// carry the cadence a listener actually hears. A shot whose token is already flashing therefore
// COALESCES into the running envelope — the light reads as a continuous flicker for the burst,
// which is what the reference shows at this cadence, at a bounded write cost.
const _flashing = new Set();

/** Claim the flash slot for a token. Synchronous by contract: the fan-out claims before it queues,
 *  so the decision is made at fire time rather than when the queued job eventually runs. */
export function claimFlash(token) {
  const id = (token?.document ?? token)?.id;
  if (!id || _flashing.has(id)) return false;
  _flashing.add(id);
  return true;
}

/** Release a claimed flash slot. Safe to call for a token that holds none. */
export function releaseFlash(token) {
  const id = (token?.document ?? token)?.id;
  if (id) _flashing.delete(id);
}

/** Is a flash envelope in flight for this token? (Read for tests/diagnostics.) */
export function flashInFlight(token) {
  const id = (token?.document ?? token)?.id;
  return !!id && _flashing.has(id);
}

/**
 * Run one flash envelope on a token, then restore the token's own light exactly.
 *
 * Permission model: this writes the SHOOTER'S OWN token document — the client that resolved the shot
 * is the shooter's owner in every path that reaches here (a player fires their own character, the GM
 * fires everyone else), so no relay and no AmbientLight creation is needed (players may not create
 * AmbientLight documents at all). A client that does not own the token skips the light silently
 * rather than throwing a permission error.
 *
 * The pre-flash light is snapshotted from `_source` (a complete plain object on every core) and also
 * parked in a token flag, so a client that dies mid-envelope leaves a restorable token rather than a
 * permanently lit one — the canvasReady sweep below picks it up. Writes go through the mech-engine
 * helpers (updateTokenDoc / enqueueApply) so a flash and a flashlight toggle can never interleave.
 */
export async function fxMuzzleLight(token, { claimed = false } = {}) {
  const doc = token?.document ?? token;
  if (!doc?.id || !doc.parent) return false;
  if (!doc.isOwner) { releaseFlash(doc); return false; }
  // A caller that did not pre-claim (a direct verb call) claims here; either way the slot is held
  // for the whole envelope and released once the token's own light is back.
  if (!claimed && !claimFlash(doc)) return false;
  const grid = Number(doc.parent?.grid?.distance) || 1;
  const frames = muzzleEnvelope(grid);
  const base = foundry.utils.deepClone(doc._source?.light ?? {});
  try {
    for (let i = 0; i < frames.length; i++) {
      const patch = { light: { ...base, ...frames[i].light } };
      if (i === 0) patch[`flags.${SCOPE}.${FLASH_FLAG}`] = base;
      await updateTokenDoc(doc, patch);
      const next = frames[i + 1];
      await _sleep((next ? next.atMs : muzzleEnvelopeDurationMs()) - frames[i].atMs);
    }
  } catch (err) {
    console.warn(`${SCOPE} | muzzle light envelope failed`, err);
  }
  try {
    await updateTokenDoc(doc, { light: base, [`flags.${SCOPE}.-=${FLASH_FLAG}`]: null });
  } catch (err) {
    console.warn(`${SCOPE} | muzzle light restore failed`, err);
  } finally {
    releaseFlash(doc);
  }
  return true;
}

/** Restore any token still carrying a flash snapshot (a client that died mid-envelope). Owner-scoped. */
export async function restoreStaleFlashLights(scene) {
  for (const doc of scene?.tokens ?? []) {
    try {
      const base = doc.getFlag?.(SCOPE, FLASH_FLAG);
      if (base === undefined || !doc.isOwner) continue;
      await updateTokenDoc(doc, { light: base, [`flags.${SCOPE}.-=${FLASH_FLAG}`]: null });
    } catch (err) {
      console.warn(`${SCOPE} | stale flash-light restore failed`, err);
    }
  }
}

/* ══════════════════════════ Sequencer verbs (optional-only) ══════════════════════════ */

/** Canvas centre of a placeable or a token document. */
export function centerOf(token) {
  if (!token) return null;
  if (token.center) return { x: token.center.x, y: token.center.y };
  const doc = token.document ?? token;
  const size = Number(doc?.parent?.grid?.size) || 100;
  const w = (Number(doc?.width) || 1) * size;
  const h = (Number(doc?.height) || 1) * size;
  return { x: (Number(doc?.x) || 0) + w / 2, y: (Number(doc?.y) || 0) + h / 2 };
}

/**
 * Where a MISSED shot's tracer lands: a divergent angle, landing short of or wide past the target
 * (design doc §2.4). `rng` is injectable so the endpoint can be value-asserted deterministically.
 */
export function missEndpoint(from, to, rng = Math.random) {
  if (!from || !to) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const angle = Math.atan2(dy, dx) + MISS_SPREAD_RAD * (rng() * 2 - 1);
  const reach = dist * (MISS_REACH_MIN + rng() * (MISS_REACH_MAX - MISS_REACH_MIN));
  return { x: from.x + Math.cos(angle) * reach, y: from.y + Math.sin(angle) * reach };
}

/**
 * One shot's visuals: the native muzzle light always, plus the Sequencer sprite + tracer when
 * Sequencer is active AND the installed asset tier actually carries the mapped database entries.
 * Returns which parts ran, so a caller (and the keeper) can assert the degrade path by value.
 */
export async function fxShot(shooterToken, targetToken, { weaponClass, hit = true, light = null } = {}) {
  const out = { light: false, muzzle: false, tracer: false };
  const entry = FX_CLASSES[weaponClass];
  if (!entry) { if (light) releaseFlash(shooterToken); return out; }
  // `light` is the fan-out's pre-claimed slot (true = this shot owns the envelope, false = another
  // shot's envelope is already running and this one coalesces into it); null = an unclaimed direct call.
  if (light !== false) out.light = await fxMuzzleLight(shooterToken, { claimed: light === true });
  if (!sequencerActive() || !shooterToken) return out;
  try {
    const seq = new globalThis.Sequence();
    const from = centerOf(shooterToken);
    const to = centerOf(targetToken);
    if (fxDbEntryExists(entry.muzzle)) {
      const effect = seq.effect().file(entry.muzzle).atLocation(shooterToken).scale(entry.scale);
      if (to) effect.rotateTowards(to);
      out.muzzle = true;
    }
    if (to && fxDbEntryExists(entry.tracer)) {
      seq.effect().file(entry.tracer).atLocation(shooterToken).stretchTo(hit ? to : missEndpoint(from, to));
      out.tracer = true;
    }
    if (out.muzzle || out.tracer) await seq.play();
  } catch (err) {
    console.warn(`${SCOPE} | sequencer shot effect failed`, err);
  }
  return out;
}

/* ══════════════════════════ Payload → shots ══════════════════════════ */

/** Rounds that HIT: the payload's areaDamages carries one entry per hitting round, by location. */
export function hitCountOf(payload) {
  let n = 0;
  for (const list of Object.values(payload?.areaDamages ?? {})) n += Array.isArray(list) ? list.length : 0;
  return n;
}

/**
 * Rounds FIRED for this payload — the per-shot fan-out count.
 *
 * One payload = one resolved burst against one target (the base system renders one multi-hit card per
 * target and the seam emits per card), so the count is read from the card's own `fired` value, which
 * the seam shim forwards as `shotsFired`. A payload without it (an emitter that predates the field)
 * falls back to the number of hits, then to a single shot — never zero, so a miss still flashes.
 */
export function shotCountOf(payload) {
  const fired = Number(payload?.shotsFired);
  if (Number.isFinite(fired) && fired > 0) return Math.min(Math.trunc(fired), MAX_FX_SHOTS);
  return Math.min(Math.max(hitCountOf(payload), 1), MAX_FX_SHOTS);
}

/** The fired weapon: by id (exact — two same-named weapons can carry different ammo), else by name. */
export function resolveFiredWeapon(payload, actor) {
  if (!actor) return null;
  const byId = payload?.weaponId ? actor.items?.get?.(payload.weaponId) : null;
  if (byId) return byId;
  const name = payload?.weaponName;
  return name ? (actor.items?.find?.((i) => i.name === name) ?? null) : null;
}

/**
 * The FX class for a fired weapon, or null when the weapon takes no muzzle fx (melee, or a type with
 * no v1 mapping). Reads the weapon sub-block so a cyberware weapon resolves like a held one.
 *
 * Shotgun detection runs BEFORE the type map: base-data shotguns are typed Rifle on purpose (the
 * type drives the Rifle SKILL per the book), so shotgun-ness lives in the ATTACK type
 * ("Shotgun"/"Autoshotgun" — lookups.js rangedAttackTypes, the field the base comment reserves for
 * exactly this). An existing enum; no per-item name list. A caliber-based fallback is deliberately
 * NOT here: weapon documents carry `ammoType`, not `caliber` (a caliber write is stripped by the
 * schema), and the pack sweep showed the attack type already covers the full shotgun corpus — the
 * few gauge-ammo entries it misses are attackType omissions in the pack data, not a resolver gap.
 */
export function weaponFxClass(weapon) {
  if (!weapon) return null;
  const sys = weapon._getWeaponSystem?.() ?? weapon.system ?? null;
  if (!sys) return null;
  if (weapon.isRanged?.() === false) return null;
  const attack = String(sys.attackType ?? "").trim().toLowerCase();
  if (attack === "shotgun" || attack === "autoshotgun") return "shotgun";
  const raw = String(sys.weaponType ?? "").trim().toLowerCase();
  if (!raw || raw === "melee") return null;
  return WEAPON_TYPE_TO_CLASS[raw] ?? null;
}

/** The shooter's token: the drawn one on the viewed canvas first, else any token document it owns. */
export function shooterTokenOf(actor) {
  if (!actor) return null;
  const drawn = canvas?.tokens?.placeables?.find((t) => t.actor?.id === actor.id);
  return drawn ?? tokensOf(actor)[0] ?? null;
}

/**
 * Fan one weaponFired payload out into per-shot effects at the measured cadence.
 *
 * Hit/miss is per shot in the reference, and the payload knows only HOW MANY rounds hit (not which),
 * so the hits are assigned to the leading shots of the burst — the per-shot divergence a viewer sees
 * is preserved without inventing an ordering the payload does not carry.
 *
 * Returns a plain result object (counts + the resolved class) rather than nothing, so the rig keeper
 * asserts the fan-out by value instead of by wall-clock observation.
 */
export async function fxWeaponFired(payload) {
  const result = { shots: 0, hits: 0, flashes: 0, weaponClass: null, cadenceMs: SHOT_CADENCE_MS, skipped: null };
  if (!combatFxEnabled()) return { ...result, skipped: "disabled" };
  const actor = payload?.attackerId ? game.actors?.get(payload.attackerId) : null;
  const weapon = resolveFiredWeapon(payload, actor);
  const weaponClass = weaponFxClass(weapon);
  if (!weaponClass) return { ...result, skipped: "class" };

  const shots = shotCountOf(payload);
  const hits = Math.min(hitCountOf(payload), shots);
  const shooter = shooterTokenOf(actor);
  const target = payload?.targetTokenId ? (canvas?.tokens?.get(payload.targetTokenId) ?? null) : null;

  let flashes = 0;
  for (let i = 0; i < shots; i++) {
    if (i > 0) await _sleep(SHOT_CADENCE_MS);
    sfx(weaponClass);
    // The visual half is queued per actor (mech-engine apply queue) and deliberately NOT awaited:
    // the audio cadence is what the ear reads, and the light envelope is longer than one cadence
    // step, so awaiting it would stretch a burst well past its measured length.
    if (shooter) {
      const light = claimFlash(shooter);   // claimed at FIRE time, not when the queued job runs
      if (light) flashes++;
      enqueueApply(actor, () => fxShot(shooter, target, { weaponClass, hit: i < hits, light }))
        .catch((err) => { releaseFlash(shooter); console.warn(`${SCOPE} | combat fx shot failed`, err); });
    }
  }
  return { ...result, shots, hits, flashes, weaponClass };
}

/* ══════════════════════════ Wiring ══════════════════════════ */

/**
 * Hook wiring — called once from the module's ready hook. Registered unconditionally (like the chat
 * card lock and the PopOut rebinding): the setting is read per event, so a GM toggling combatFxEnabled
 * takes effect immediately with no reload, and the listener is inert while it is off.
 */
export function registerCombatFx() {
  Hooks.on("cyberpunk2020.weaponFired", (payload) => {
    if (!combatFxEnabled()) return;
    fxWeaponFired(payload).catch((err) => console.warn(`${SCOPE} | combat fx failed`, err));
  });
  // A client that died mid-envelope left its snapshot on the token; restore it when the scene draws.
  Hooks.on("canvasReady", (c) => {
    if (c?.scene) restoreStaleFlashLights(c.scene).catch(() => { /* nothing restorable */ });
  });
  // canvasReady has ALREADY fired for the initially-drawn scene by the time ready-hook wiring runs,
  // so the current scene gets one sweep here as well.
  if (canvas?.scene) restoreStaleFlashLights(canvas.scene).catch(() => { /* nothing restorable */ });
  primeFxSounds().catch(() => { /* listing unavailable → shipped-asset path is used */ });
}
