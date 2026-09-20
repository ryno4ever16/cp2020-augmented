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
 *     the current compendium entry of the same name. Posted as a GM-whispered card with actor and item
 *     names and an Apply button per row; the card RETURNS at every launch while rows remain (the earlier
 *     card is replaced, never stacked) until the GM presses "Don't show again" (user ruling 2026-09-19:
 *     not once-ever). Applying a row removes it from the next sweep by itself. The sweep writes nothing.
 *
 * The selects themselves gained a blank option the same day (templates/item/parts/*), so the mechanism
 * cannot fire again; this file is about what it already did.
 */
import { canonicalReliability, canonicalWeaponEnums } from "./data/enum-spellings.js";
import { renderChatCard, getGMUserIds } from "./compat.js";
import { localize } from "./utils.js";
import { onGlobalClick } from "./popout-compat.js";
export { canonicalReliability };

const SCOPE = "cp2020-augmented";

/**
 * The update an item needs so its enum-backed fields are STORED as the enum, or null when it needs
 * none: a weapon's reliability / concealability / availability, a cyberweapon work-block's
 * reliability. The recognised spellings live in data/enum-spellings.js; an unrecognised one is left
 * alone. Reads the SOURCE (`_source`) when the item is a document, because the weapon model already
 * reads spellings as the enum at load and the prepared value would hide what is stored. Pure.
 */
export function enumSpellingUpdate(item) {
  const sys = item?._source?.system ?? item?.system ?? {};
  const id = item?.id ?? item?._id;
  if (item?.type === "weapon") {
    const fix = canonicalWeaponEnums(sys);
    const keys = Object.keys(fix);
    if (!keys.length) return null;
    return { _id: id, ...Object.fromEntries(keys.map(k => [`system.${k}`, fix[k]])) };
  }
  if (item?.type === "cyberware") {
    const stored = sys.CyberWorkType?.Weapon?.reliability;
    if (stored === undefined || stored === null || stored === "") return null;
    const canon = canonicalReliability(stored);
    if (canon && canon !== stored) return { _id: id, "system.CyberWorkType.Weapon.reliability": canon };
  }
  return null;
}
/** ⏪ the first name this shipped under, kept for the API. */
export const reliabilitySpellingUpdate = enumSpellingUpdate;

/**
 * Does this item's data predate the corrected packs? Two tells, either is enough: `_stats.systemVersion`
 * below 1.1.0, or no `_stats.createdTime` at all — a document written before the platform stamped
 * creation times (the user's 2025 items carry none), and the stamp survives later edits where the
 * version stamp does not (every edit rewrites `systemVersion` to the running build). Pure.
 */
export function predatesCorrectedPacks(stats) {
  if (!stats || !(Number(stats.createdTime) > 0)) return true;
  const v = String(stats.systemVersion ?? "").trim();
  if (!v) return true;
  try { return !foundry.utils.isNewerVersion(v, "1.0.999"); } catch (_e) { return true; }
}

/**
 * One key for "the same weapon by name": letters and digits only, lower-case, with a trailing
 * parenthetical dropped — "Sternmeyer Type 35 (left)" is the compendium's Sternmeyer Type 35. Pure.
 */
export function nameKey(name) {
  return String(name ?? "").replace(/\s*\([^)]*\)\s*$/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
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
      rows.push({ actorName: w.actorName, itemName: w.itemName, uuid: String(w.uuid ?? ""), field, fieldLabel: label, stored: String(stored ?? ""), pack: String(expect ?? "") });
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
export async function migrateEnumSpellings({ force = false } = {}) {
  const out = { skipped: null, actors: 0, items: 0, worldItems: 0 };
  if (game.user?.isGM !== true) { out.skipped = "permission"; return out; }
  const DONE = "enumSpellingsMigrated", COMPLETED = `${DONE}Completed`;
  ensureStamps([DONE, COMPLETED]);
  if (!force && game.settings.get(SCOPE, DONE) && game.settings.get(SCOPE, COMPLETED)) { out.skipped = "done"; return out; }
  await game.settings.set(SCOPE, DONE, true);
  try {
    for (const actor of worldActors()) {
      const updates = [];
      for (const item of actor.items ?? []) {
        const u = enumSpellingUpdate(item);
        if (u) updates.push(u);
      }
      if (!updates.length) continue;
      await actor.updateEmbeddedDocuments("Item", updates, { render: false });
      out.actors += 1; out.items += updates.length;
    }
    for (const item of game.items ?? []) {
      const u = enumSpellingUpdate(item);
      if (!u) continue;
      const { _id, ...fields } = u;
      await item.update(fields, { render: false });
      out.worldItems += 1;
    }
    await game.settings.set(SCOPE, COMPLETED, true);
    if (out.items || out.worldItems) console.log(`${SCOPE} | enum spellings canonicalised on ${out.items} embedded + ${out.worldItems} world item(s).`);
  } catch (e) {
    console.warn(`${SCOPE} | enum-spelling migration failed part-way; it retries at the next load, or now via `
      + `game.cpAugmented.migrations.enumSpellings()`, e);
  }
  return out;
}
/** ⏪ the first name this shipped under, kept for the API. */
export const migrateReliabilitySpelling = migrateEnumSpellings;

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

const DISMISSED = "weaponReviewDismissed";   // the GM pressed "Don't show again"
const CARD_ID   = "weaponReviewMessageId";   // the standing card, replaced at each re-post

/** Register the two review settings on demand (the string one is not a Boolean stamp). */
function ensureReviewSettings() {
  ensureStamps([DISMISSED]);
  if (!game.settings.settings.has(`${SCOPE}.${CARD_ID}`)) {
    game.settings.register(SCOPE, CARD_ID, { scope: "world", config: false, type: String, default: "" });
  }
}

/**
 * Remove the standing card, if it still exists. The id is cleared FIRST and removals are serialised
 * through one chain, so two callers in flight together (the dismiss button and a re-post, rig-seen
 * 2026-09-19) cannot both delete the same message — the second delete of a message reaches the server
 * as "does not exist" and is logged as an error before any catch here could see it.
 */
let _removal = Promise.resolve();
function removeStandingCard() {
  _removal = _removal.then(async () => {
    const id = String(game.settings.get(SCOPE, CARD_ID) || "");
    if (!id) return;
    await game.settings.set(SCOPE, CARD_ID, "");
    const msg = game.messages.get(id);
    if (!msg) return;
    try { await msg.delete(); } catch (_e) { /* already gone */ }
  });
  return _removal;
}

/**
 * Post the GM notice naming weapons whose values may have been rewritten (see the file header). Runs
 * at every launch: while rows remain and the GM has not dismissed it, the card is (re)posted, the
 * earlier one removed first so only one stands. `force` posts even after a dismissal (the console
 * re-post). Reads everything, writes nothing but the card and its id. Returns the rows.
 */
export async function reviewSuspectWeapons({ force = false, weapons: given = null, packByKey: givenPacks = null } = {}) {
  const out = { skipped: null, rows: [], posted: false };
  if (game.user?.isGM !== true) { out.skipped = "permission"; return out; }
  ensureReviewSettings();
  if (!force && game.settings.get(SCOPE, DISMISSED)) { out.skipped = "dismissed"; return out; }
  // `weapons` / `packByKey` may be handed in — the keeper's seam, because a document's `_stats`
  // (the version stamp this reads) is the server's to write and a test cannot author an old one.
  const packByKey = givenPacks ?? await compendiumWeaponsByKey();
  const weapons = given ? [...given] : [];
  for (const actor of given ? [] : worldActors()) {
    for (const item of actor.items ?? []) {
      if (item.type !== "weapon") continue;
      weapons.push({ actorName: actor.name, itemName: item.name, uuid: item.uuid, stats: item._stats ?? item._source?._stats, system: item._source?.system ?? item.system });
    }
  }
  out.rows = suspectWeaponRows(weapons, packByKey);
  await removeStandingCard();
  if (!out.rows.length) return out;
  const content = await renderChatCard("data-review-notice.hbs", {
    rows: out.rows.map(r => ({ ...r, fieldLabel: localize(r.fieldLabel) })),
    count: out.rows.length,
  });
  const msg = await ChatMessage.create({ content, whisper: getGMUserIds(), speaker: { alias: localize("DataReviewSpeaker") } });
  if (msg?.id) await game.settings.set(SCOPE, CARD_ID, msg.id);
  out.posted = true;
  return out;
}

/** "Don't show again": stamp the dismissal and take the standing card down. GM-only. */
export async function dismissSuspectReview() {
  if (game.user?.isGM !== true) return { skipped: "permission" };
  ensureReviewSettings();
  await game.settings.set(SCOPE, DISMISSED, true);
  await removeStandingCard();
  return { dismissed: true };
}

/* ═══════════════════ The card's controls — the GM's hand, one row at a time ═══════════════════
 *
 * The notice names what code cannot know; these let the GM act on it without leaving chat. Each row
 * carries its item's uuid, the field and the compendium value; APPLY writes exactly that one field on
 * that one item (`item.update`), so a weapon the GM customised on purpose is skipped by not pressing
 * its button. APPLY ALL presses every row still standing. GM-only twice: at render (the whisper) and
 * here at the click, because a card is a door too. Bound through onGlobalClick so a popped-out chat
 * window is heard (popout-compat.js).
 */
export async function applySuspectValue({ uuid, field, value }) {
  if (game.user?.isGM !== true) return { skipped: "permission" };
  const allowed = new Set(SUSPECT_FIELDS.map(f => f.field));
  if (!allowed.has(String(field))) return { skipped: "field" };
  const item = await fromUuid(String(uuid ?? ""));
  if (!item || item.documentName !== "Item") return { skipped: "item" };
  await item.update({ [`system.${field}`]: String(value ?? "") });
  return { applied: true, name: item.name, field, value: String(value ?? "") };
}

export function registerDataReviewButtons() {
  onGlobalClick(async (ev) => {
    const one = ev.target?.closest?.(".cp-data-review-apply");
    const all = ev.target?.closest?.(".cp-data-review-apply-all");
    const dismiss = ev.target?.closest?.(".cp-data-review-dismiss");
    if (!one && !all && !dismiss) return;
    ev.preventDefault();
    if (game.user?.isGM !== true) return;
    if (dismiss) { await dismissSuspectReview().catch(e => console.warn(`${SCOPE} | data review dismiss failed`, e)); return; }
    const card = (one ?? all).closest(".cp-data-review");
    const targets = one ? [one] : [...(card?.querySelectorAll(".cp-data-review-apply:not(:disabled)") ?? [])];
    for (const btn of targets) {
      btn.disabled = true;
      try {
        const r = await applySuspectValue({ uuid: btn.dataset.uuid, field: btn.dataset.field, value: btn.dataset.value });
        if (r.applied) btn.closest(".cp-data-review-row")?.classList.add("cp-data-review-done");
        else btn.disabled = false;
      } catch (e) {
        console.warn(`${SCOPE} | data review apply failed`, e);
        btn.disabled = false;
      }
    }
    if (all) all.disabled = true;
  });
}
