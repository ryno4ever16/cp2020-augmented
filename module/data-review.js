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
import { localize, localizeParam } from "./utils.js";
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

/**
 * The fields the first-option rewrite could reach, per item type, and how each is compared. A blank
 * compendium value is "no statement" (the pack rot the corrections layer handles) unless a field says
 * otherwise (`blankPackIsValue`). Per-type since 2026-09-20, when every dropdown on every item sheet was
 * measured against the base defaults and the installed packs: weapons are the exposure. The one other
 * candidate, a skill's stat (six role skills ship blank), is NOT reviewable under the base 1.1.1 model -
 * its own migrateData rewrites a blank stat to "cool" on read, so blank never reaches a sheet and can
 * never be restored by an Apply. Program type (blank, unread by anything) got a blank option in its
 * dropdown instead; armor type (our own "Soft"/"Hard" spelling) is canonicalised on read.
 */
const SUSPECT_FIELDS = [
  { type: "weapon", field: "reliability", label: "Reliability", same: (a, b) => (canonicalReliability(a) ?? String(a)) === (canonicalReliability(b) ?? String(b)) },
  { type: "weapon", field: "attackType", label: "AttackType", same: (a, b) => String(a ?? "").trim() === String(b ?? "").trim() },
  { type: "weapon", field: "concealability", label: "Concealability", same: (a, b) => String(a ?? "").trim() === String(b ?? "").trim() },
];
const REVIEWED_TYPES = Object.freeze([...new Set(SUSPECT_FIELDS.map(f => f.type))]);
const INDEX_FIELDS = Object.freeze(["type", ...new Set(SUSPECT_FIELDS.map(f => "system." + f.field))]);
/** The pack-map key for one item: type-qualified, so a skill and a weapon of one name never collide. */
const packKeyOf = (type, name) => type + ":" + nameKey(name);

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
    const type = String(w.type || "weapon");
    // the type-qualified key first; a bare name key is the older seam shape (weapons only)
    const pack = packByKey?.get?.(packKeyOf(type, w.itemName)) ?? packByKey?.[packKeyOf(type, w.itemName)]
      ?? (type === "weapon" ? (packByKey?.get?.(nameKey(w.itemName)) ?? packByKey?.[nameKey(w.itemName)]) : undefined);
    if (!pack) continue;
    for (const { type: ft, field, label, same, blankPackIsValue } of SUSPECT_FIELDS) {
      if (ft !== type) continue;
      if (!(field in pack)) continue;
      const stored = w.system?.[field], expect = pack[field];
      if (!blankPackIsValue && String(expect ?? "").trim() === "") continue;
      if (same(stored, expect)) continue;
      rows.push({ actorName: w.actorName, actorUuid: String(w.actorUuid ?? ""), itemName: w.itemName, uuid: String(w.uuid ?? ""), field, fieldLabel: label, stored: String(stored ?? ""), pack: String(expect ?? ""), packSource: String(pack.source ?? "") });
    }
  }
  return rows;
}

/**
 * Every actor that can carry items: world actors plus unlinked scene-token deltas. An unlinked token's
 * synthetic actor is MATERIALISED only when its delta's raw source holds a weapon old enough to matter
 * (`predatesCorrectedPacks` on the source stats) — `token.actor` builds a whole Actor per token, and a
 * profiled world put that at 25+ seconds per launch (the flesh-limb sweep learned the same lesson).
 * Server-impact audit 2026-09-19: the launch sweep must cost a clean world one in-memory pass.
 */
function* worldActors() {
  for (const a of game.actors ?? []) yield a;
  for (const scene of game.scenes ?? []) {
    for (const token of scene.tokens ?? []) {
      if (token.actorLink) continue;
      const rawItems = token.delta?._source?.items;
      if (Array.isArray(rawItems) && !rawItems.some(i => REVIEWED_TYPES.includes(i?.type) && predatesCorrectedPacks(i._stats))) continue;
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

/** The current compendium weapons and skills, keyed by type and name - the base system's packs first,
 *  the module's after. */
async function compendiumWeaponsByKey() {
  const byKey = new Map();
  const packs = [...(game.packs ?? [])]
    .filter(p => p.metadata?.type === "Item")
    .sort((a, b) => (a.collection.startsWith("cyberpunk2020.") ? 0 : 1) - (b.collection.startsWith("cyberpunk2020.") ? 0 : 1));
  for (const pack of packs) {
    let index;
    try { index = await pack.getIndex({ fields: [...INDEX_FIELDS] }); }
    catch (_e) { continue; }
    for (const e of index) {
      if (!REVIEWED_TYPES.includes(e.type)) continue;
      const key = packKeyOf(e.type, e.name);
      if (byKey.has(key)) continue;
      // `source` names the pack the value came from - the card shows it, because the compendium is the
      // module's reference and not the book, and a scraped expansion pack deserves less trust than a
      // hand-entered one (user, 2026-09-20: the item audit is open and will stay open for now).
      const entry = { source: String(pack.metadata?.label ?? pack.collection ?? "") };
      for (const f of SUSPECT_FIELDS) if (f.type === e.type) entry[f.field] = e.system?.[f.field];
      byKey.set(key, entry);
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
let _sweep = Promise.resolve();
export function reviewSuspectWeapons(opts = {}) {
  // ONE SWEEP AT A TIME per client: the launch sweep takes seconds over a big world, and a forced
  // call arriving inside it (rig-seen 2026-09-19) left the first card orphaned — each had cleared
  // the id and posted. Serialised, the second waits and replaces the first's card as intended.
  const run = _sweep.then(() => _reviewSuspectWeapons(opts));
  _sweep = run.catch(() => {});
  return run;
}
async function _reviewSuspectWeapons({ force = false, weapons: given = null, packByKey: givenPacks = null } = {}) {
  const out = { skipped: null, rows: [], posted: false };
  if (game.user?.isGM !== true) { out.skipped = "permission"; return out; }
  ensureReviewSettings();
  if (!force && game.settings.get(SCOPE, DISMISSED)) { out.skipped = "dismissed"; return out; }
  // `weapons` / `packByKey` may be handed in — the keeper's seam, because a document's `_stats`
  // (the version stamp this reads) is the server's to write and a test cannot author an old one.
  const weapons = given ? [...given] : [];
  for (const actor of given ? [] : worldActors()) {
    for (const item of actor.items ?? []) {
      if (!REVIEWED_TYPES.includes(item.type)) continue;
      const stats = item._stats ?? item._source?._stats;
      if (!predatesCorrectedPacks(stats)) continue;   // the gate first: a current-build item is never a suspect
      weapons.push({ type: item.type, actorName: actor.name, actorUuid: actor.uuid, itemName: item.name, uuid: item.uuid, stats, system: item._source?.system ?? item.system });
    }
  }
  // ⭐ THE PACK INDEXES ARE READ ONLY WHEN THERE IS SOMETHING TO COMPARE (server-impact audit 2026-09-19):
  // a field-projected getIndex over every Item pack makes the server read pack documents, and this runs
  // at every launch. A world with no pre-correction weapon costs one in-memory pass and no pack reads.
  const packByKey = weapons.length ? (givenPacks ?? await compendiumWeaponsByKey()) : (givenPacks ?? new Map());
  out.rows = suspectWeaponRows(weapons, packByKey);
  await removeStandingCard();
  if (!out.rows.length) return out;
  const content = await renderChatCard("data-review-notice.hbs", {
    groups: groupRowsByActor(out.rows.map(r => ({ ...r, fieldLabel: localize(r.fieldLabel) }))),
    count: out.rows.length,
  });
  const msg = await ChatMessage.create({ content, whisper: getGMUserIds(), speaker: { alias: localize("DataReviewSpeaker") } });
  if (msg?.id) await game.settings.set(SCOPE, CARD_ID, msg.id);
  out.posted = true;
  return out;
}

/**
 * The card's shape (user, 2026-09-19): rows under a header PER ACTOR, so the GM can see who carries the
 * weapon and go look at whether it was meant. Groups keep first-seen order (world actors, then unlinked
 * scene tokens, the sweep's order); rows keep theirs. Pure.
 * @returns {{actorName:string, actorUuid:string, count:number, rows:object[]}[]}
 */
export function groupRowsByActor(rows) {
  const groups = new Map();
  for (const r of rows ?? []) {
    const key = r.actorUuid || r.actorName;
    if (!groups.has(key)) groups.set(key, { actorName: r.actorName, actorUuid: r.actorUuid ?? "", count: 0, rows: [] });
    const g = groups.get(key); g.rows.push(r); g.count++;
  }
  return [...groups.values()];
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
  const item = await fromUuid(String(uuid ?? ""));
  if (!item || item.documentName !== "Item") return { skipped: "item" };
  if (!SUSPECT_FIELDS.some(f => f.type === item.type && f.field === String(field))) return { skipped: "field" };
  await item.update({ [`system.${field}`]: String(value ?? "") });
  return { applied: true, name: item.name, field, value: String(value ?? "") };
}

/**
 * Apply MANY rows in as few writes as the platform allows: rows are grouped by the item they name (several
 * fields on one weapon become one update) and then by the item's parent, so an actor's weapons go through
 * one updateEmbeddedDocuments call and world items through one Item.updateDocuments. A card over
 * hundreds of rows (a world that lived through the rewrite for a year) is otherwise hundreds of round
 * trips, each re-rendering the sheet. Same gates as the single apply. Returns the rows applied.
 * @param {{uuid:string, field:string, value:string}[]} rows
 */
export async function applySuspectValues(rows) {
  if (game.user?.isGM !== true) return { skipped: "permission", applied: [] };
  const byItem = new Map();
  for (const r of rows ?? []) {
    const uuid = String(r?.uuid ?? "");
    if (!byItem.has(uuid)) byItem.set(uuid, {});
    byItem.get(uuid)["system." + String(r?.field)] = String(r?.value ?? "");
  }
  const applied = [];
  const byParent = new Map();   // parent uuid ("" = world) -> [{ _id, ...changes }]
  for (const [uuid, rawChanges] of byItem) {
    const item = await fromUuid(uuid);
    if (!item || item.documentName !== "Item") continue;
    const changes = {};
    for (const [k, v] of Object.entries(rawChanges)) {
      const field = k.slice("system.".length);
      if (SUSPECT_FIELDS.some(f => f.type === item.type && f.field === field)) changes[k] = v;
    }
    if (!Object.keys(changes).length) continue;
    const key = item.parent?.uuid ?? "";
    if (!byParent.has(key)) byParent.set(key, { parent: item.parent ?? null, updates: [] });
    byParent.get(key).updates.push({ _id: item.id, ...changes });
    applied.push(...Object.keys(changes).map(k => ({ uuid, field: k.slice("system.".length) })));
  }
  for (const { parent, updates } of byParent.values()) {
    if (parent) await parent.updateEmbeddedDocuments("Item", updates);
    else await Item.updateDocuments(updates);
  }
  return { applied };
}

/**
 * The "are you sure" before a write to an actor's item. Returns false (declined), true (write), or
 * "noask" (write, and stop asking for this card's single rows). DialogV2, the module's own confirm idiom.
 */
async function confirmApply({ title, body, yes, noAsk }) {
  const DialogV2 = foundry.applications.api.DialogV2;
  const noAskHtml = noAsk ? `<label class="cp-data-review-noask"><input type="checkbox" name="noask"> ${localize("DataReviewConfirmNoAsk")}</label>` : "";
  let checked = false;
  const ok = await DialogV2.confirm({
    window: { title },
    classes: ["cp-data-review-confirm"],
    content: `<div class="cp-data-review-confirm-body">${body}${noAskHtml}</div>`,
    yes: { label: yes, callback: (_ev, _btn, dialog) => { checked = dialog?.element?.querySelector?.('input[name="noask"]')?.checked === true; return true; } },
    no: { label: localize("DataReviewConfirmNo") },
    rejectClose: false,
  });
  if (!ok) return false;
  return checked ? "noask" : true;
}

export function registerDataReviewButtons() {
  onGlobalClick(async (ev) => {
    const one = ev.target?.closest?.(".cp-data-review-apply");
    const all = ev.target?.closest?.(".cp-data-review-apply-all");
    const dismiss = ev.target?.closest?.(".cp-data-review-dismiss");
    const head = ev.target?.closest?.(".cp-data-review-actor-head[data-actor-uuid]");
    if (!one && !all && !dismiss && !head) return;
    ev.preventDefault();
    if (game.user?.isGM !== true) return;
    if (head) {   // the actor's name opens the actor, so the GM can judge the weapon in place
      const actor = await fromUuid(String(head.dataset.actorUuid)).catch(() => null);
      if (actor?.sheet) actor.sheet.render(true);
      return;
    }
    if (dismiss) { await dismissSuspectReview().catch(e => console.warn(`${SCOPE} | data review dismiss failed`, e)); return; }
    const card = (one ?? all).closest(".cp-data-review");
    const markDone = (btn) => { btn.disabled = true; btn.closest(".cp-data-review-row")?.classList.add("cp-data-review-done"); };
    if (one) {
      // ⭐ ASKS FIRST (user, 2026-09-20): the compendium value is the module's reference, not the book -
      // the item audit is open - so a write to an actor's item is a decision, not a reflex. The card
      // remembers "don't ask again" for its own rows only.
      if (card?.dataset.cpNoAsk !== "1") {
        const row = one.closest(".cp-data-review-row");
        const head = (() => { let el = row?.previousElementSibling; while (el && !el.classList.contains("cp-data-review-actor-head")) el = el.previousElementSibling; return el; })();
        const ok = await confirmApply({
          title: localize("DataReviewConfirmOneTitle"),
          body: localizeParam("DataReviewConfirmOneBody", {
            item: row?.querySelector(".cp-data-review-item")?.textContent?.trim() ?? "",
            actor: head?.firstChild?.textContent?.trim() ?? "",
            field: row?.querySelector(".cp-data-review-change")?.textContent?.trim() ?? one.dataset.field,
            value: one.dataset.value ?? "",
            source: row?.querySelector(".cp-data-review-source")?.textContent?.trim() ?? "",
          }),
          yes: localize("DataReviewConfirmOneYes"),
          noAsk: true,
        });
        if (!ok) return;
        if (ok === "noask" && card) card.dataset.cpNoAsk = "1";
      }
      one.disabled = true;
      try {
        const r = await applySuspectValue({ uuid: one.dataset.uuid, field: one.dataset.field, value: one.dataset.value });
        if (r.applied) markDone(one); else one.disabled = false;
      } catch (e) { console.warn(`${SCOPE} | data review apply failed`, e); one.disabled = false; }
      return;
    }
    // Apply all: every button still standing, batched (one write per actor), then each row marked.
    const standing = [...(card?.querySelectorAll(".cp-data-review-apply:not(:disabled)") ?? [])];
    if (!standing.length) return;
    {
      const actors = new Set(), sources = new Set();
      for (const btn of standing) {
        const row = btn.closest(".cp-data-review-row");
        let el = row?.previousElementSibling; while (el && !el.classList.contains("cp-data-review-actor-head")) el = el.previousElementSibling;
        if (el) actors.add(el.firstChild?.textContent?.trim() ?? "");
        const s = row?.querySelector(".cp-data-review-source")?.textContent?.trim(); if (s) sources.add(s);
      }
      const ok = await confirmApply({
        title: localizeParam("DataReviewConfirmAllTitle", { count: standing.length, actors: actors.size }),
        body: localizeParam("DataReviewConfirmAllBody", { count: standing.length, actors: actors.size, sources: [...sources].join(", ") || "—" }),
        yes: localize("DataReviewConfirmAllYes"),
        noAsk: false,
      });
      if (!ok) return;
    }
    all.disabled = true;
    for (const btn of standing) btn.disabled = true;
    try {
      const r = await applySuspectValues(standing.map(b => ({ uuid: b.dataset.uuid, field: b.dataset.field, value: b.dataset.value })));
      const done = new Set((r.applied ?? []).map(a => `${a.uuid}|${a.field}`));
      for (const btn of standing) { if (done.has(`${btn.dataset.uuid}|${btn.dataset.field}`)) markDone(btn); else btn.disabled = false; }
    } catch (e) {
      console.warn(`${SCOPE} | data review apply-all failed`, e);
      for (const btn of standing) btn.disabled = false;
      all.disabled = false;
    }
  });
}

/* ═══════════════ The settings-menu button — the GM's way back to the card ═══════════════
 *
 * Module Settings → "Data review" → [Post the review card]. The console call has always worked; a GM who
 * pressed "Don't show again" and later wants the card back should not need it (user, 2026-09-20). The
 * menu's `type` must be an Application class (core checks); this one renders nothing — its render IS the
 * action, a forced sweep, and the referee is told what came of it either way. GM-only via `restricted`.
 */
export class DataReviewMenu extends foundry.applications.api.ApplicationV2 {
  async render() {
    if (game.user?.isGM !== true) return this;
    const r = await reviewSuspectWeapons({ force: true });
    if (r.posted) ui.notifications?.info?.(localize("DataReviewPosted"));
    else ui.notifications?.info?.(localize("DataReviewNothing"));
    return this;
  }
}

export function registerDataReviewMenu() {
  game.settings.registerMenu(SCOPE, "dataReviewMenu", {
    name: "SETTINGS.DataReviewMenuName",
    label: "SETTINGS.DataReviewMenuLabel",
    hint: "SETTINGS.DataReviewMenuHint",
    icon: "fa-solid fa-magnifying-glass",
    type: DataReviewMenu,
    restricted: true,
  });
}
