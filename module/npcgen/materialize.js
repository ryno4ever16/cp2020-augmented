/**
 * NPC GENERATOR — THE MATERIALIZE LAYER. The ONLY file in npcgen/ that touches documents.
 *
 * `blueprint.js` plans an NPC as plain data; this turns a plan into a real Actor with real items. The
 * split is the one `module/mech/loadout.js` already draws (a pure `loadoutItemData` beside an impure
 * materializer) and it is load-bearing here for the same reason: the plan stays testable under plain
 * `node`, and everything that needs `game` lives behind this door.
 *
 * ⭐⭐ THE ONE THING A MAINTAINER MUST NOT MISS: **we never create skill items.** The base system's
 * `CyberpunkActor._preCreate` (`actor/actor.js:33-40`) already grants the entire default skill set —
 * 103 items — plus the unarmed Kick and Strike, to every new `npc`. So `Actor.create` is where the
 * skills appear, and the generator's skill job is to UPDATE LEVELS on items that already exist. Any
 * version of this file that starts by adding skills is fighting `_preCreate` and will double them.
 *
 * ⭐ THE SECOND THING: every pack copy goes through `game.items.fromCompendium`, because that helper
 * keeps `_stats.compendiumSource`, and that stamp is the ONLY thing that makes the corrections layer
 * fire (`data-corrections.js` reads it in its `preCreateItem` hook). A copy made with a bare
 * `toObject()` silently hands out uncorrected pack data — and the packs are known defective at scale,
 * which is why the corrections layer exists at all. The shop's hand-re-stamp (`shop/purchase.js`) is
 * the other way to get there; it exists because the shop mutates its copy before create. We do not, so
 * we use the native helper and there is nothing to forget.
 */

import { localize, localizeParam, tryLocalize, getSkillIndex, getSkillsPackNames } from "../utils.js";
import { renderChatCard, getGMUserIds } from "../compat.js";
import { getCatalogIndex } from "../shop/catalog.js";
import { isVisibleTo } from "../shop/supplements.js";
import { shopSourceConfig, npcGenTokenArtFolder } from "../settings.js";
import { ammoModifierSystemFields } from "../shop/buy-ammo.js";
import { getCalibers, getCaliberBox } from "../lookups.js";
import { seededRng, seedFrom, humanityFromChrome, empAfterChrome, breakpointAdvisories } from "./blueprint.js";

const SCOPE = "cp2020-augmented";

/**
 * ⚠ THE SQUAD CAP, AND WHY IT IS THIS NUMBER — 2026-08-13, awaiting the user's ruling.
 *
 * Design §R1 called bulk-creation cost "the single biggest technical unknown in the feature" and asked
 * for a measurement before any N was promised. The measurement came back at roughly HALF A SECOND per
 * actor on the rig, which is the base `_preCreate` embedding 103 skill items + 2 melee weapons before
 * our loadout copies even start. Twelve is therefore about six seconds of work with a progress-free
 * window — tolerable, and past the "four corpsec NOW" panic case the design was written around.
 *
 * ⛔ It is MY number, not a ruling. The design's own question was *"What's a realistic max you'd want?
 * (5? 12? 30?)"* and it is still open. Thirty is not a technical problem so much as a twelve-second
 * one; if the answer is thirty, raise this constant and give the window a progress line.
 */
export const NPCGEN_MAX_COUNT = 12;

/** Where generated NPCs land. Localized folder NAME, resolved find-or-create — the exact shape
 *  `vehicle/vehicle-deploy-request.js` uses for deployed vehicles, so a GM meets one convention. */
export function npcGenFolderName() {
  return tryLocalize("NpcGen.Folder", "Generated NPCs");
}

/** Find-or-create the output folder. Mirrors vehicle-deploy-request.js:114-116 verbatim in shape. */
export async function ensureNpcGenFolder() {
  const name = npcGenFolderName();
  return game.folders.find((f) => f.type === "Actor" && f.name === name)
    ?? await Folder.create({ type: "Actor", name });
}

// =================================================================================================
// THE CATALOG SIDE — what this table actually stocks
// =================================================================================================

/**
 * The catalog rows the generator may draw from.
 *
 * ⭐ GM CURATION IS HONORED, AND THAT IS A DELIBERATE CHOICE (design §Q3, ruled): the index already
 * carries each row's supplement + canon, and `isVisibleTo` already knows which of those the GM has
 * switched on for the table. We ask it the PLAYER question (`isGM: false`) on purpose — the GM's own
 * view shows everything including the books they have hidden, and a generator that drew from *that*
 * would hand out gear the GM deliberately took off the table. Price overrides need no handling here:
 * the index has already folded them into `cost`/`unpriced`.
 *
 * Unpriced rows are dropped. In this module an unpriced item is not free — it is an item whose price
 * the GM has never set (`shop/purchase.js` `resolveCatalogPrice` is emphatic about it, because the base
 * data defaults a blank cost to the number 0 and real guns read 0). A budget filler cannot reason about
 * a row like that, and silently treating it as free is how a mook ends up in Metal Gear.
 */
export async function npcGenCatalogRows() {
  const all = await getCatalogIndex();
  const cfg = shopSourceConfig();
  return all.filter((r) => !r.unpriced && isVisibleTo(r.supplement, r.canon, cfg, false));
}

/** Does a row satisfy one of a slot's `{category, sub}` shapes? A null/blank `sub` means "any sub of
 *  this category" — which is what the taxonomy itself uses for the single-level categories (Armor and
 *  Vehicles both declare `subs: []`, and their rows carry `sub: ""`). */
function rowMatchesCategory(row, want) {
  if (!want || row.category !== want.category) return false;
  const sub = want.sub ?? null;
  return (sub === null || sub === "") ? true : row.sub === sub;
}

/**
 * PICK ONE ROW FOR A SLOT — deterministic, budget-aware, and pure over the rows it is handed.
 *
 * Pure over `rows` so the whole plan can be recomputed identically for the preview and again for the
 * create, which is what makes "the preview is what you get" true rather than hoped for. The randomness
 * is the injected `rng`, seeded per NPC per slot by the caller.
 *
 * ⚠ WHAT HAPPENS WHEN THE BUDGET BUYS NOTHING. A slot the archetype marked `min: 1` is a slot the NPC
 * is supposed to have — a goon with no gun is a worse outcome than a goon slightly over budget. So an
 * empty affordable set falls back to the CHEAPEST row in the category and reports `overBudget: true`,
 * which the summary card then says out loud. Silently returning nothing would produce an unarmed
 * "Goon 3" and no explanation anywhere.
 */
export function pickSlotRow(rows, slot, rng) {
  const cats = slot?.categories ?? [];
  const inCategory = rows.filter((r) => cats.some((c) => rowMatchesCategory(r, c)));
  if (!inCategory.length) return null;

  const budget = Number(slot?.budgetEb) || 0;
  const affordable = budget > 0 ? inCategory.filter((r) => (Number(r.cost) || 0) <= budget) : inCategory;
  if (affordable.length) {
    const pick = affordable[Math.min(Math.floor(rng() * affordable.length), affordable.length - 1)];
    return { row: pick, overBudget: false };
  }
  // Nothing affordable — take the cheapest the category has and flag it rather than arm nobody.
  const cheapest = inCategory.reduce((a, b) => ((Number(b.cost) || 0) < (Number(a.cost) || 0) ? b : a));
  return { row: cheapest, overBudget: true };
}

/**
 * THE WHOLE GEAR PLAN FOR ONE NPC — every slot resolved to a concrete catalog row, plus the chrome.
 *
 * ⭐ DETERMINISM IS THE POINT. Each slot draws from its OWN rng stream, folded from the NPC's seed and
 * the slot's name, so adding a slot to an archetype does not reshuffle the slots before it — the same
 * reasoning as the per-NPC seed fold in `blueprint.js`, and the reason neither uses `seed + i`.
 *
 * Slot COUNT (`min`/`max`) is rolled per slot; a `min: 0` slot genuinely may come up empty, which is
 * how "some of them carry a backup piece" reads at the table.
 */
export function planNpcGear(bp, rows) {
  const slots = [];
  for (const slot of bp.loadoutSlots ?? []) {
    const rng = seededRng(seedFrom(bp.seed, "slot", slot.slot));
    const min = Math.max(0, Math.trunc(Number(slot.min) || 0));
    const max = Math.max(min, Math.trunc(Number(slot.max) || 0));
    const n = min + Math.floor(rng() * (max - min + 1));
    for (let i = 0; i < n; i++) {
      const picked = pickSlotRow(rows, slot, rng);
      if (!picked) continue;
      slots.push({ slot: slot.slot, key: picked.row.key, name: picked.row.name, cost: picked.row.cost,
        overBudget: picked.overBudget, spBand: slot.spBand ?? null, isArmorSlot: !!slot.spBand });
    }
  }

  // CHROME. The book rolls a COUNT (blueprint.cyberwareCountPlan); the ITEMS come from our own packs,
  // filtered to the archetype's allowed sub-categories — the RTG line the design draws in §4, where the
  // dice procedure is a rule we may implement and the result TABLE is content we may not ship.
  const plan = bp.cyberwareCountPlan ?? {};
  const subs = new Set(plan.subs ?? []);
  const chromeRng = seededRng(seedFrom(bp.seed, "chrome"));
  // ⚑ MINE: the tier's whole loadout budget doubles as the per-implant ceiling. The design gives chrome
  // no budget of its own (the book's roll costs no money), but with no ceiling at all a mook draws a
  // 50,000eb implant out of the same pool as a Heavy. Scaling the ceiling with the tier keeps the dial
  // meaningful and is legible in one line. A real chrome budget belongs to the pool-algorithm session
  // the design still owes (§Q3, OWED).
  const ceiling = Math.max(...(bp.loadoutSlots ?? []).map((s) => Number(s.budgetEb) || 0), 0);
  const pool = rows.filter((r) => r.category === "Cyberware" && subs.has(r.sub)
    && (ceiling <= 0 || (Number(r.cost) || 0) <= ceiling));
  const chrome = [];
  const taken = new Set();
  let guard = pool.length * 4 + 16;
  while (chrome.length < (Number(plan.count) || 0) && pool.length && guard-- > 0) {
    const r = pool[Math.min(Math.floor(chromeRng() * pool.length), pool.length - 1)];
    if (taken.has(r.key)) continue;                 // "reroll duplicates", the book's own procedure
    taken.add(r.key);
    chrome.push({ key: r.key, name: r.name, cost: r.cost });
  }
  return { slots, chrome };
}

// =================================================================================================
// SKILLS — updating levels on items the base system already granted
// =================================================================================================

/** Fold a name or a schema key to one comparable token. Proven injective over the shipped skill packs
 *  (113 rows → 113 distinct tokens, no collisions), which is what lets a key be matched to an item by
 *  name at all: `AwarenessNotice` → `awarenessnotice` ← `Awareness/Notice`. */
function normalizeSkillToken(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * SCHEMA KEY → THE GRANTED ITEM'S NAME, ACROSS LANGUAGES.
 *
 * ⛔ THE PROBLEM THIS SOLVES, measured on the rig rather than assumed (design §R2 flagged it as a live
 * unknown): the skills the base system grants carry **no `_stats.compendiumSource` and no
 * `flags.core.sourceId`** — 0 of 103 — because `_preCreate` maps `toObject()` and pushes without
 * `keepId`. So there is no id to match on. The only stable handle left is the NAME, and the name is
 * localized.
 *
 * The route, therefore, is the one `mech/roll-mods.js` already established for exactly this shape of
 * problem — join the EN pack index to the active-language pack index on the stable compendium `_id`:
 *   schema key → (normalize) → EN index row → its `_id` → the same `_id` in the language index → the
 *   localized name the granted item actually carries.
 * On an EN world the join is the identity and this costs nothing. The fallback, when a language pack
 * lacks a row, is the normalized EN name — which is exactly right, because a partially-translated pack
 * grants the untranslated item under its English name.
 */
export async function skillNameIndex() {
  const enRows = await getSkillIndex("en");
  const locRows = getSkillsPackNames(game.i18n.lang).join("|") === getSkillsPackNames("en").join("|")
    ? enRows
    : await getSkillIndex(game.i18n.lang);
  const locById = new Map(locRows.map((r) => [r.id, r.name]));
  const byKey = new Map();
  for (const r of enRows) {
    const token = normalizeSkillToken(r.name);
    if (!byKey.has(token)) byKey.set(token, { id: r.id, name: locById.get(r.id) ?? r.name });
  }
  return byKey;
}

/**
 * Build the item data for a skill the actor does NOT have.
 *
 * ⛔ WHY THIS EXISTS AT ALL, given that the file header says we never create skills. Both are true, and
 * the boundary between them is the point: the base `_preCreate` grants `getDefaultSkills()`, and that
 * helper (`utils.js:325`) resolves ONLY the pack whose id starts `default-skills-`. The ten SPECIAL
 * ABILITIES — Combat Sense, Authority, Resources, Streetdeal and the rest — ship in the separate
 * `role-skills-` pack and are therefore **never granted to anybody**. A rig run found it the honest
 * way: the Goon's ruled special ability, Combat Sense, resolved to nothing on a freshly created NPC,
 * so the one skill the book insists every character must have was the one skill the generator could
 * not set.
 *
 * So: the 103 defaults are updated, never created (creating them would duplicate the whole sheet), and
 * a skill the actor genuinely lacks is created. That is the same line `mech/chip-grant.js` draws — an
 * active chip naming a skill the actor lacks creates it — and this mirrors its `grantedSkillData`
 * shape, including copying the pack document's own system block so the skill arrives with its correct
 * stat and difficulty modifier rather than a guessed one.
 */
async function missingSkillData(name, level) {
  let system = { level, chipLevel: 0, ip: 0, diffMod: 1, isChipped: false, isRoleSkill: false, stat: "int", flavor: "", notes: "" };
  try {
    for (const packName of getSkillsPackNames(game.i18n.lang)) {
      const pack = game.packs?.get(packName);
      if (!pack) continue;
      const idx = await pack.getIndex();
      const hit = idx?.find((e) => normalizeSkillToken(e.name) === normalizeSkillToken(name));
      if (!hit) continue;
      const doc = await pack.getDocument(hit._id);
      system = { ...foundry.utils.deepClone(doc.system), level, chipLevel: 0, isChipped: false, ip: 0 };
      return { name: doc.name, type: "skill", img: doc.img, system };
    }
  } catch (e) { /* fall through to the neutral shape below */ }
  return { name, type: "skill", system };
}

/**
 * Set the blueprint's levels on the skills the actor already owns.
 *
 * ONE `updateEmbeddedDocuments` with K entries, never K separate updates (design §R2). Returns what it
 * could and could not resolve, because a skill key that matches nothing must not fail silently — an
 * archetype naming a skill this world does not ship should say so, not quietly produce a goon with a
 * shorter list than the tier promised.
 *
 * ⚠ THE FOUR PARAMETERIZED KEYS. `Expert`, `Language`, `MartialArts` and `Pilot` exist in the actor
 * schema but ship in the packs only as filled-in variants ("Martial Arts: Choi Li Fut", "Expert: …"),
 * so a bare one of those resolves to nothing and lands in `unresolved`. That is correct behaviour, not
 * a gap to paper over: an archetype that wants a martial art has to name WHICH one.
 */
export async function applySkillLevels(actor, bp, nameByKey) {
  const byName = new Map();
  for (const it of actor.items) {
    if (it.type !== "skill") continue;
    const token = normalizeSkillToken(it.name);
    if (!byName.has(token)) byName.set(token, it);
  }
  const updates = [];
  const toCreate = [];
  const granted = [];
  const unresolved = [];
  for (const { skillKey, level } of bp.skillLevels ?? []) {
    const hit = nameByKey.get(normalizeSkillToken(skillKey));
    const item = byName.get(normalizeSkillToken(hit?.name ?? skillKey));
    if (item) { updates.push({ _id: item.id, "system.level": level }); continue; }
    if (hit) {
      // The pack knows this skill but the actor does not — the special-ability case. Create it.
      toCreate.push(await missingSkillData(hit.name, level));
      granted.push(skillKey);
      continue;
    }
    unresolved.push(skillKey);
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  if (toCreate.length) await actor.createEmbeddedDocuments("Item", toCreate);
  if (unresolved.length) {
    // Not a silent shrug: an archetype naming a skill this world does not ship has produced an NPC
    // weaker than its tier promised, and the four parameterized keys (Expert / Language / MartialArts
    // / Pilot) land here by design — the packs carry only their filled-in variants, so an archetype
    // that wants a martial art has to name which one.
    console.warn(`${SCOPE} | npcgen: ${unresolved.length} skill key(s) matched nothing in this world's `
      + `skill packs for "${actor.name}": ${unresolved.join(", ")}`);
  }
  return { updated: updates.length, granted, unresolved };
}

// =================================================================================================
// GEAR — copying the picked rows onto the actor
// =================================================================================================

/** Load the compendium document behind a catalog `key` ("packId.itemId"; the packId itself contains a
 *  dot, so the split is from the LAST one). Missing pack or missing document degrades to null and
 *  warns by name — the `mech/pa-skills.js` discipline, so a world with a trimmed pack set produces a
 *  thinner NPC instead of a thrown generator. */
async function loadCatalogDoc(key) {
  const i = String(key ?? "").lastIndexOf(".");
  if (i < 0) return null;
  const packId = key.slice(0, i);
  const itemId = key.slice(i + 1);
  try {
    const doc = await game.packs.get(packId)?.getDocument(itemId);
    if (!doc) console.warn(`${SCOPE} | npcgen: catalog row ${key} has no document (pack trimmed?)`);
    return doc ?? null;
  } catch (e) {
    console.warn(`${SCOPE} | npcgen: could not load ${key}`, e);
    return null;
  }
}

/**
 * Build the ammo item that loads a weapon.
 *
 * ⭐ REUSES `ammoModifierSystemFields` from the shop's own buy-ammo engine rather than restating the
 * ammo schema here. That helper is what a bought box of Standard rounds is made of, so a generated
 * NPC's magazine is the same shape as a purchased one — which is the whole "real parts, real systems"
 * requirement, and it means the ammo subsystem's combat metadata travels for free.
 */
function ammoItemDataFor(weaponDoc) {
  const caliber = String(weaponDoc.system?.ammoType ?? "").trim();
  if (!caliber) return null;
  const shots = Math.max(0, Math.trunc(Number(weaponDoc.system?.shots) || 0));
  if (shots <= 0) return null;                       // a melee weapon has no magazine to fill
  const calLabel = getCalibers()[caliber]?.label ?? caliber;
  return {
    name: `${calLabel} Standard`,                    // a stored document name is data — it stays English
    type: "ammo",
    img: "modules/cp2020-augmented/img/weapon-icon.svg",
    system: foundry.utils.mergeObject(
      { caliber, ammoType: caliber, quantity: shots, boxSize: Number(getCaliberBox(caliber).box) || 1, equipped: true },
      ammoModifierSystemFields("standard"),
      { inplace: false },
    ),
  };
}

/**
 * Copy the planned gear onto the actor, load the guns, equip the armor, and leave the chrome loose.
 *
 * ⛔ THE RETURN-ORDER TRAP, and how this file avoids it. `mech/loadout.js:100-104` carries the warning
 * verbatim: *"createEmbeddedDocuments' return order is NOT guaranteed to match its input order
 * (rig-proven on multi-creates), so index-based mapping could nest a child under the wrong parent."*
 * We need to point each weapon at the ammo item that loads it, which is exactly that kind of mapping.
 * So nothing here reads the create call's return array by index, and nothing matches by NAME either
 * (two identical pistols would collide). Every created item carries a unique `npcGenToken` in our own
 * flag namespace, and the pairing is resolved by that token afterwards. One create call, one update
 * call, no ordering assumption anywhere.
 */
export async function stockLoadout(actor, gearPlan) {
  const toCreate = [];
  const pairs = [];                                  // { weaponToken, ammoToken } — resolved after create
  const chromeDocs = [];
  const stocked = { weapons: [], armor: [], chrome: [], missing: [] };
  let seq = 0;

  const stamp = (data, token, extra = {}) => {
    data.flags = data.flags ?? {};
    data.flags[SCOPE] = { ...(data.flags[SCOPE] ?? {}), npcGenToken: token, ...extra };
    return data;
  };

  for (const entry of gearPlan.slots ?? []) {
    const doc = await loadCatalogDoc(entry.key);
    if (!doc) { stocked.missing.push(entry.name); continue; }
    // fromCompendium keeps _stats.compendiumSource — the corrections trigger. See the file header.
    const data = game.items.fromCompendium(doc);
    const token = `w${seq++}`;
    stamp(data, token);
    data.system = data.system ?? {};

    if (doc.type === "armor") {
      // Ruled (design §Q3b): armor goes on like a normal character's, so the damage pipeline reads its
      // SP without the GM opening the sheet. The per-location coverage is the pack's own data; the only
      // thing that decides whether the pipeline counts it is `equipped`, which is what armor-layers.js
      // filters on. The `common` template already defaults it true — set it anyway, because a pack item
      // that happens to carry false would otherwise ship silently inert.
      data.system.equipped = true;
      const sp = Math.max(0, ...Object.values(doc.system?.coverage ?? {}).map((c) => Number(c?.stoppingPower) || 0));
      stocked.armor.push({ name: data.name, sp, advisories: breakpointAdvisories(sp).crossed.map((b) => b.key) });
    } else if (doc.type === "cyberware") {
      // Carried, NOT installed (design §Q12, ruled: counts from the book, picks from our packs, and the
      // install pipeline explicitly out of scope for this build). `equipped` is the flag every mech
      // engine reads to mean "installed and working", and the `common` template defaults it TRUE — so
      // leaving it alone would hand the NPC a fully-installed implant with none of the zone, humanity
      // or side resolution the real install path does. Off, deliberately, and the summary card says so.
      data.system.equipped = false;
      chromeDocs.push(doc);
      stocked.chrome.push({ name: data.name });
    } else {
      const ammo = ammoItemDataFor(doc);
      if (ammo) {
        const ammoToken = `a${seq++}`;
        stamp(ammo, ammoToken);
        toCreate.push(ammo);
        pairs.push({ weaponToken: token, ammoToken });
        stocked.weapons.push({ name: data.name, rounds: ammo.system.quantity });
      } else {
        stocked.weapons.push({ name: data.name, rounds: null });
      }
    }
    toCreate.push(data);
  }

  // The chrome the plan drew, copied the same provenance-preserving way.
  for (const entry of gearPlan.chrome ?? []) {
    const doc = await loadCatalogDoc(entry.key);
    if (!doc) { stocked.missing.push(entry.name); continue; }
    const data = game.items.fromCompendium(doc);
    stamp(data, `c${seq++}`);
    data.system = data.system ?? {};
    data.system.equipped = false;                    // carried, not installed — see above
    chromeDocs.push(doc);
    stocked.chrome.push({ name: data.name });
    toCreate.push(data);
  }

  if (!toCreate.length) return { ...stocked, chromeDocs };
  await actor.createEmbeddedDocuments("Item", toCreate);

  // Resolve the weapon↔ammo pairing by TOKEN, never by index or name (see the header of this function).
  const byToken = new Map();
  for (const it of actor.items) {
    const t = it.getFlag(SCOPE, "npcGenToken");
    if (t) byToken.set(t, it);
  }
  const loadUpdates = [];
  for (const { weaponToken, ammoToken } of pairs) {
    const weapon = byToken.get(weaponToken);
    const ammo = byToken.get(ammoToken);
    if (!weapon || !ammo) continue;
    loadUpdates.push({
      _id: weapon.id,
      "system.ammoItemId": ammo.id,
      "system.shotsLeft": Math.max(0, Math.trunc(Number(weapon.system?.shots) || 0)),
      "system.equipped": true,
    });
  }
  if (loadUpdates.length) await actor.updateEmbeddedDocuments("Item", loadUpdates);
  return { ...stocked, chromeDocs };
}

// =================================================================================================
// THE ACTOR
// =================================================================================================

/**
 * Token defaults for a generated NPC (design §Q6, ruled: hostile, no nameplate).
 *
 * ⛔ `actorLink` IS DELIBERATELY ABSENT. The base system gives `npc` no actorLink on purpose —
 * `actor/actor.js:114-115` says so in a comment — which means every generated goon's tokens take their
 * own hits, which is what you want for a squad. `combat-data-hazards.md` states our role here exactly:
 * *"our only role is seeding a sensible default and never fighting the toggle."* Writing `false` here
 * would be us re-deciding something the system already decided the same way, and it would fight a GM
 * who linked one deliberately.
 */
function prototypeTokenDefaults(img) {
  const proto = {
    disposition: CONST.TOKEN_DISPOSITIONS.HOSTILE,
    displayName: CONST.TOKEN_DISPLAY_MODES.NONE,
  };
  const folder = String(npcGenTokenArtFolder() ?? "").trim();
  if (folder) {
    // Foundry-native wildcard art (design §Q5C): point at a folder and every token rolls its own face.
    // Degrades to the plain icon when the folder is empty or holds nothing — `randomImg` with no match
    // simply leaves the source as-is, so there is no failure mode to guard.
    proto.randomImg = true;
    proto.texture = { src: `${folder.replace(/\/+$/, "")}/*` };
  } else if (img) {
    proto.texture = { src: img };
  }
  return proto;
}

/** The default face. Design §Q5B: per-archetype art drawn from what already ships, so the feature adds
 *  no asset-licensing surface at all. The base system's own edgerunner is what it uses for characters
 *  (`actor/actor.js:23`) and it is the honest "a person" placeholder. */
const NPCGEN_DEFAULT_IMG = "systems/cyberpunk2020/img/edgerunner.svg";

/**
 * ONE blueprint → one Actor, fully stocked.
 *
 * The order is not arbitrary and each step depends on the one before it:
 *   1. `Actor.create` — and the base `_preCreate` grants 103 skills + Kick/Strike right here.
 *   2. skill LEVELS onto those granted items.
 *   3. the gear, which is also what tells us how much chrome the NPC is carrying.
 *   4. humanity, LAST, because it is a function of the chrome that step 3 actually found — not of the
 *      chrome the plan asked for, which a trimmed pack set can fail to deliver.
 */
/**
 * The nine stats as the schema wants them — every stat present, each with BOTH of its fields.
 *
 * ⛔ WHOLE-OBJECT, ALWAYS, AND THAT IS NOT TIDINESS. `system.stats` is an **ObjectField**
 * (`data/actor-data.js:38`, `objectField(DEFAULT_STATS)`), and a dotted write into one of those does
 * not merge the way a SchemaField would — it replaces the object and the schema's own defaults fill
 * the siblings back in. A rig run caught exactly that here: writing `"system.stats.emp.base"` on its
 * own after create silently reset REF and BT from their rolled 10 and 8 back to the template's 5, and
 * every other assertion still passed because the value we had just written was the one we then read.
 * The same hazard is on record from the cyberlimb repair (`mech/cyberlimb.js`, where a dotted
 * `current.<zone>` write zeroed the sibling zones) and in `feedback-datamodel-partial-updates`.
 * So both writes below send the COMPLETE object.
 */
function statsPayload(stats, empOverride) {
  return Object.fromEntries(Object.entries(stats).map(([k, v]) => [
    k, { base: k === "emp" && empOverride != null ? empOverride : v, tempMod: 0 },
  ]));
}

export async function materializeNpc(bp, { folder, rows, nameByKey }) {
  const actor = await Actor.create({
    name: bp.name,
    type: "npc",
    img: NPCGEN_DEFAULT_IMG,
    folder: folder?.id,
    prototypeToken: prototypeTokenDefaults(NPCGEN_DEFAULT_IMG),
    flags: { [SCOPE]: { npcGen: {
      archetype: bp.plan?.archetype ?? null,
      archetypePlaceholder: !!bp.plan?.archetypePlaceholder,
      tier: bp.plan?.tier ?? null,
      dials: bp.plan?.dials ?? null,
      seed: bp.seed,
      rootSeed: bp.plan?.rootSeed ?? null,
      index: bp.plan?.index ?? 0,
      version: game.modules.get(SCOPE)?.version ?? "",
    } } },
    system: {
      role: { value: bp.role },
      stats: statsPayload(bp.stats),
    },
  });
  if (!actor) return null;

  const skills = await applySkillLevels(actor, bp, nameByKey);
  const gearPlan = planNpcGear(bp, rows);
  const stocked = await stockLoadout(actor, gearPlan);

  // HUMANITY (design §Q12b, ruled: compute the loss at generation time so EMP is consistent with the
  // chrome, and keep no ongoing ledger). Computed from the items actually stocked, and NOT clamped —
  // the ruling is explicit that it may go negative: *"let it happen and let them figure it out."*
  const chrome = humanityFromChrome(stocked.chromeDocs ?? []);
  const { humanity, emp } = empAfterChrome(bp.stats.emp, chrome.loss);
  // The whole stats object goes back, with EMP replaced — see statsPayload for why a dotted
  // `system.stats.emp.base` would take the other eight stats with it.
  await actor.update({ "system.humanity": humanity, "system.stats": statsPayload(bp.stats, emp) });

  return {
    id: actor.id, name: actor.name, role: bp.role,
    tier: bp.plan?.tier ?? "", stats: bp.stats,
    skillsUpdated: skills.updated, skillsGranted: skills.granted, skillsUnresolved: skills.unresolved,
    weapons: stocked.weapons, armor: stocked.armor, chrome: stocked.chrome, missing: stocked.missing,
    humanity, emp, humanityLoss: chrome.loss,
    overBudget: (gearPlan.slots ?? []).some((s) => s.overBudget),
  };
}

/**
 * The whole squad, and the one card that reports it.
 *
 * ⚠ SEQUENTIAL ON PURPOSE. Each `Actor.create` costs roughly half a second because of the 105 embedded
 * documents the base grants inside it; firing N of them concurrently does not make the work smaller,
 * it makes the failure modes concurrent. One at a time also means a squad that fails half-way has
 * produced N whole NPCs rather than N broken ones.
 */
export async function materializeNpcSquad(blueprints) {
  if (!game.user?.isGM) {
    // The handler re-check the design asks for (§"GM-only gating"): the button is GM-gated at render,
    // and this is the second gate, so a stale window or a console call cannot route around it.
    ui.notifications?.warn(localize("NpcGen.GmOnly"));
    return [];
  }
  const folder = await ensureNpcGenFolder();
  const rows = await npcGenCatalogRows();
  const nameByKey = await skillNameIndex();
  const made = [];
  for (const bp of blueprints.slice(0, NPCGEN_MAX_COUNT)) {
    try {
      const summary = await materializeNpc(bp, { folder, rows, nameByKey });
      if (summary) made.push(summary);
    } catch (e) {
      console.error(`${SCOPE} | npcgen: "${bp?.name}" failed to materialize`, e);
    }
  }
  if (made.length) await postNpcGenSummary(made, folder);
  return made;
}

/**
 * The summary card — GM-whispered, one per generation.
 *
 * ⛔ It states the CARRIED-NOT-INSTALLED limitation in plain words on every card that has chrome on it.
 * The design asked for exactly that (§Q12): *"State plainly … that generated cyberware is carried, not
 * surgically installed … silent half-limitations are worse than an honest one."*
 */
export async function postNpcGenSummary(summaries, folder) {
  const content = await renderChatCard("npcgen/summary.hbs", {
    folder: folder?.name ?? npcGenFolderName(),
    count: summaries.length,
    npcs: summaries.map((s) => ({
      name: s.name,
      tier: tryLocalize(`NpcGen.Tier.${s.tier.charAt(0).toUpperCase()}${s.tier.slice(1)}`, s.tier),
      statLine: `REF ${s.stats.ref} · BT ${s.stats.bt} · INT ${s.stats.int} · CL ${s.stats.cool}`,
      humanity: s.humanity,
      weapons: s.weapons.map((w) => (w.rounds == null ? w.name : localizeParam("NpcGen.WeaponLoaded", { name: w.name, rounds: w.rounds }))),
      armor: s.armor.map((a) => localizeParam("NpcGen.ArmorLine", { name: a.name, sp: a.sp })),
      chrome: s.chrome.map((c) => c.name),
      hasChrome: s.chrome.length > 0,
      missing: s.missing,
      hasMissing: s.missing.length > 0,
      overBudget: s.overBudget,
    })),
    carriedNote: localize("NpcGen.ChromeCarriedNote"),
    anyChrome: summaries.some((s) => s.chrome.length > 0),
    placeholderNames: true,
  });
  return ChatMessage.create({ content, whisper: getGMUserIds() });
}
