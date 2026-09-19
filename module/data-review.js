/**
 * DATA REVIEW — the two answers to the 2026-09-19 finding that a sheet select with no blank option
 * rewrote out-of-enum values into its first option on the next submit, silently, in users' worlds.
 *
 * The finding (user's own world, read off disk, then Tilt's git history): the base system's Aug-2025
 * packs stored reliability as `"standard"` (lower-case, outside the `Standard / VeryReliable /
 * Unreliable` enum) — and attack type / concealability blank on many rows. Any item dragged from
 * those packs and then edited on a sheet whose select had no blank option was rewritten to the first
 * option: reliability → VeryReliable, attack type → Auto (which the fire path reads as full-auto
 * capable), concealability → ConcealPocket. Tilt corrected his packs in Jan 2026; copies already in
 * worlds kept the damage. The user's words: "I've already poisoned the data of my entire userbase."
 *
 * Two things this file does, both one-time and GM-only, both re-runnable from
 * `game.cpAugmented.migrations`:
 *
 *  1. `migrateReliabilitySpelling` — the part that CAN be repaired: a stored spelling the enum does
 *     not know but the module's canonical map does (`"standard"`, `"very reliable"`, `"ST"`, `"VR"`…)
 *     is rewritten to the enum value, on every weapon and cyberweapon in the world, before any sheet
 *     can rewrite it to the wrong one. Idempotent; a value already in the enum is never touched.
 *
 *  2. `reviewSuspectWeapons` — the part that CANNOT be repaired by code: a value already rewritten to
 *     VeryReliable / Auto / ConcealPocket is indistinguishable from a legitimate one. What code can do
 *     is name the suspects: every weapon on an actor that was written by a system version older than
 *     the corrected packs (`_stats.systemVersion` < 1.1.0, or missing) AND whose value disagrees with
 *     the current compendium entry of the same name. Posted ONCE as a GM-whispered card with actor and
 *     item names, for the GM to check against the book. Writes nothing.
 *
 * The selects themselves gained a blank option the same day (templates/item/parts/*), so the mechanism
 * cannot fire again; this file is about what it already did.
 */
import { RELIABILITY_CANONICAL } from "./data-corrections.js";
import { renderChatCard, getGMUserIds } from "./compat.js";
import { localize } from "./utils.js";

const SCOPE = "cp2020-augmented";

/** The enum the sheet's select offers (lookups.js `reliability`), by value. */
const RELIABILITY_ENUM = new Set(["VeryReliable", "Standard", "Unreliable"]);

/** Every spelling the canonical map knows, plus the book's own abbreviations. Keyed lower-case, no spaces. */
const RELIABILITY_SPELLINGS = {
  ...Object.fromEntries(Object.entries(RELIABILITY_CANONICAL).map(([k, v]) => [k.replace(/\s+/g, ""), v])),
  vr: "VeryReliable", st: "Standard", ur: "Unreliable",
  veryreliable: "VeryReliable", standard: "Standard", unreliable: "Unreliable",
};

/**
 * The enum value for a stored reliability, or null when the stored value is not a spelling this
 * module recognises (an enum value answers itself). Pure.
 */
export function canonicalReliability(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (RELIABILITY_ENUM.has(raw)) return raw;
  return RELIABILITY_SPELLINGS[raw.toLowerCase().replace(/\s+/g, "")] ?? null;
}

/** The update an item needs for its reliability spelling, or null when it needs none. Pure. */
export function reliabilitySpellingUpdate(item) {
  const sys = item?.system ?? {};
  if (item?.type === "weapon") {
    const canon = canonicalReliability(sys.reliability);
    if (canon && canon !== sys.reliability) return { _id: item.id ?? item._id, "system.reliability": canon };
    return null;
  }
  if (item?.type === "cyberware") {
    const stored = sys.CyberWorkType?.Weapon?.reliability;
    if (stored === undefined || stored === null || stored === "") return null;
    const canon = canonicalReliability(stored);
    if (canon && canon !== stored) return { _id: item.id ?? item._id, "system.CyberWorkType.Weapon.reliability": canon };
  }
  return null;
}

/** Does this build's data predate the corrected packs? `_stats.systemVersion` < 1.1.0, or absent. Pure. */
export function predatesCorrectedPacks(stats) {
  const v = String(stats?.systemVersion ?? "").trim();
  if (!v) return true;
  try { return !foundry.utils.isNewerVersion(v, "1.0.999"); } catch (_e) { return true; }
}

/** One key for "the same weapon by name": letters and digits only, lower-case. Pure. */
export function nameKey(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The three fields the first-option rewrite could reach on a weapon, and how each is compared. */
const SUSPECT_FIELDS = [
  { field: "reliability", label: "Reliability", same: (a, b) => (canonicalReliability(a) ?? String(a)) === (canonicalReliability(b) ?? String(b)) },
  { field: "attackType", label: "AttackType", same: (a, b) => String(a ?? "").trim() === String(b ?? "").trim() },
  { field: "concealability", label: "Concealability", same: (a, b) => String(a ?? "").trim() === String(b ?? "").trim() },
];

/**
 * THE SUSPECT ROWS, pure. `weapons` are `{ actorName, itemName, stats, system }` records; `packByKey`
 * maps a name key to the current compendium entry's `system`. A row is a suspect when the item
 * predates the corrected packs AND a rewrite-reachable field disagrees with the compendium — a blank
 * compendium value is not a disagreement (the pack rot that the corrections layer already handles).
 * @returns {{actorName:string,itemName:string,field:string,stored:string,pack:string}[]}
 */
export function suspectWeaponRows(weapons, packByKey) {
  const rows = [];
  for (const w of weapons ?? []) {
    if (!predatesCorrectedPacks(w.stats)) continue;
    const pack = packByKey?.get?.(nameKey(w.itemName)) ?? packByKey?.[nameKey(w.itemName)];
    if (!pack) continue;
    for (const { field, label, same } of SUSPECT_FIELDS) {
      const stored = w.system?.[field], expect = pack[field];
      if (String(expect ?? "").trim() === "") continue;
      if (same(stored, expect)) continue;
      rows.push({ actorName: w.actorName, itemName: w.itemName, field: label, stored: String(stored ?? ""), pack: String(expect ?? "") });
    }
  }
  return rows;
}

/** Every actor that can carry items: world actors plus unlinked scene-token deltas. */
function* worldActors() {
  for (const a of game.actors ?? []) yield a;
  for (const scene of game.scenes ?? []) {
    for (const token of scene.tokens ?? []) {
      if (token.actorLink) continue;
      const a = token.actor;
      if (a) yield a;
    }
  }
}

function ensureStamps(keys) {
  for (const key of keys) {
    if (!game.settings.settings.has(`${SCOPE}.${key}`)) {
      game.settings.register(SCOPE, key, { scope: "world", config: false, type: Boolean, default: false });
    }
  }
}

/**
 * Canonicalise reliability spelling on every weapon and cyberweapon in the world (see the file
 * header). Two stamps, the flesh-limb migration's shape: one before the sweep, one after it returns,
 * so a run that dies part-way is retried at the next load. GM-only. Returns counts, by value.
 */
export async function migrateReliabilitySpelling({ force = false } = {}) {
  const out = { skipped: null, actors: 0, items: 0, worldItems: 0 };
  if (game.user?.isGM !== true) { out.skipped = "permission"; return out; }
  const DONE = "reliabilitySpellingMigrated", COMPLETED = `${DONE}Completed`;
  ensureStamps([DONE, COMPLETED]);
  if (!force && game.settings.get(SCOPE, DONE) && game.settings.get(SCOPE, COMPLETED)) { out.skipped = "done"; return out; }
  await game.settings.set(SCOPE, DONE, true);
  try {
    for (const actor of worldActors()) {
      const updates = [];
      for (const item of actor.items ?? []) {
        const u = reliabilitySpellingUpdate(item);
        if (u) updates.push(u);
      }
      if (!updates.length) continue;
      await actor.updateEmbeddedDocuments("Item", updates, { render: false });
      out.actors += 1; out.items += updates.length;
    }
    for (const item of game.items ?? []) {
      const u = reliabilitySpellingUpdate(item);
      if (!u) continue;
      const { _id, ...fields } = u;
      await item.update(fields, { render: false });
      out.worldItems += 1;
    }
    await game.settings.set(SCOPE, COMPLETED, true);
    if (out.items || out.worldItems) console.log(`${SCOPE} | reliability spelling canonicalised on ${out.items} embedded + ${out.worldItems} world item(s).`);
  } catch (e) {
    console.warn(`${SCOPE} | reliability-spelling migration failed part-way; it retries at the next load, or now via `
      + `game.cpAugmented.migrations.reliabilitySpelling()`, e);
  }
  return out;
}

/** The current compendium weapons, keyed by name — the base system's packs first, the module's after. */
async function compendiumWeaponsByKey() {
  const byKey = new Map();
  const packs = [...(game.packs ?? [])]
    .filter(p => p.metadata?.type === "Item")
    .sort((a, b) => (a.collection.startsWith("cyberpunk2020.") ? 0 : 1) - (b.collection.startsWith("cyberpunk2020.") ? 0 : 1));
  for (const pack of packs) {
    let index;
    try { index = await pack.getIndex({ fields: ["type", "system.reliability", "system.attackType", "system.concealability"] }); }
    catch (_e) { continue; }
    for (const e of index) {
      if (e.type !== "weapon") continue;
      const key = nameKey(e.name);
      if (!byKey.has(key)) byKey.set(key, { reliability: e.system?.reliability, attackType: e.system?.attackType, concealability: e.system?.concealability });
    }
  }
  return byKey;
}

/**
 * Post the one-time GM notice naming weapons whose values may have been rewritten (see the file
 * header). Reads everything, writes nothing but the stamp. `force` re-posts. Returns the rows.
 */
export async function reviewSuspectWeapons({ force = false, weapons: given = null, packByKey: givenPacks = null } = {}) {
  const out = { skipped: null, rows: [], posted: false };
  if (game.user?.isGM !== true) { out.skipped = "permission"; return out; }
  const STAMP = "weaponReviewNoticePosted";
  ensureStamps([STAMP]);
  if (!force && game.settings.get(SCOPE, STAMP)) { out.skipped = "done"; return out; }
  // `weapons` / `packByKey` may be handed in — the keeper's seam, because a document's `_stats`
  // (the version stamp this reads) is the server's to write and a test cannot author an old one.
  const packByKey = givenPacks ?? await compendiumWeaponsByKey();
  const weapons = given ? [...given] : [];
  for (const actor of given ? [] : worldActors()) {
    for (const item of actor.items ?? []) {
      if (item.type !== "weapon") continue;
      weapons.push({ actorName: actor.name, itemName: item.name, stats: item._stats ?? item._source?._stats, system: item._source?.system ?? item.system });
    }
  }
  out.rows = suspectWeaponRows(weapons, packByKey);
  await game.settings.set(SCOPE, STAMP, true);
  if (!out.rows.length) return out;
  const content = await renderChatCard("data-review-notice.hbs", {
    rows: out.rows.map(r => ({ ...r, fieldLabel: localize(r.field) })),
    count: out.rows.length,
  });
  await ChatMessage.create({ content, whisper: getGMUserIds(), speaker: { alias: localize("DataReviewSpeaker") } });
  out.posted = true;
  return out;
}
