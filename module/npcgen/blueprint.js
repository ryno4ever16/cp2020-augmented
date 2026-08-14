/**
 * NPC GENERATOR — THE BLUEPRINT LAYER. Pure functions only: no Foundry document, no `game`, no
 * `Math.random`, no i18n, no DOM. Everything here takes its randomness as an INJECTED `rng` and
 * returns plain data, so the whole layer runs under `node` with no VTT (`tests/npcgen-blueprint.test.mjs`).
 *
 * WHY THE SPLIT EXISTS AT ALL (design §Step 2): `module/mech/loadout.js` already draws this line —
 * a pure `loadoutItemData(spec, …)` beside an impure materializer — *"so the spec→document mapping is
 * testable without a Foundry document"*. The same split applies here: this file plans an NPC;
 * `materialize.js` (a LATER unit, not this one) turns a plan into documents. Nothing in this file may
 * reach for a document, and nothing that reaches for a document may compute a plan.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO:
 *  · It does not pick gear items. A slot names a CATEGORY; the catalog index resolves it at
 *    materialize time (design §Q3C). Picking here would need `game.packs`.
 *  · It does not create or update skill items. Creating an `npc` actor already grants 103 skill items
 *    (base `actor/actor.js:33-40`); the generator's skill job is to UPDATE levels (design §Step 1's
 *    "single biggest shape change"). This file produces the levels, keyed by schema key.
 *  · It does not generate names. See `placeholderName`.
 */

import {
  ARCHETYPES, ARMOR_BREAKPOINTS, ARMOR_WEAPON_ROLE_MODIFIERS, CYBERWARE_ROLLS,
  PLACEHOLDER_NAME_PREFIX, PLACEHOLDER_NAME_START, ROLE_ENUM, SKILL_MAX_LEVEL,
  SKILL_DIAL_BY_KEY, ARMOR_DIAL_BY_KEY, TOUGHNESS_DIAL_BY_KEY, WEAPONS_DIAL_BY_RUNG, TIERS_BY_KEY
} from "./tables.js";

// =============================================================================================
// SEEDED RANDOMNESS
// =============================================================================================

/**
 * ⭐ PROVENANCE: `seededRng` and `seedFrom` are the SHAPE of `module/fx/effects.js`'s `seededRng`
 * (mulberry32) and `fxSeedOf` (an FNV-1a-shaped walk), COPIED rather than imported.
 *
 * Copied deliberately, and the reason is the point of this whole file: `effects.js` is the FX rail —
 * it imports Sequencer, canvas and settings, and a pure layer that imports it stops being loadable
 * under plain `node`. A ~10-line generator is a cheaper dependency than a cross-module coupling that
 * would make this file untestable. The FX rail's own comment applies verbatim here: it is *"a
 * SPREADER, not a hash with any security property, and nothing here depends on it having one."*
 *
 * Determinism is the ruled requirement (design Q14: *"same seed → same NPC"*, and *"the module
 * already has seededRng (mulberry32) … built for exactly this reason"*). Keep the arithmetic
 * byte-identical to the FX rail's so a future merge of the two is a deletion, not a re-derivation.
 */
export function seedFrom(...parts) {
  let h = 2166136261 >>> 0;
  const s = parts.map((p) => String(p ?? "")).join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function seededRng(seed = 0) {
  let a = (Number(seed) >>> 0) || 1;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One die. `rng()` is expected in [0,1); a caller's rng that returns 1 exactly still lands in range. */
export function rollDie(rng, sides) {
  const r = Math.min(Math.max(Number(rng()) || 0, 0), 0.9999999999);
  return Math.floor(r * sides) + 1;
}

/** 2D6, as two separate dice — NOT one 2-12 draw, because the book rolls two dice. */
export function roll2d6(rng) {
  return rollDie(rng, 6) + rollDie(rng, 6);
}

// =============================================================================================
// NAMES
// =============================================================================================

/**
 * ⛔⛔⛔ SHIP BLOCKER — PLACEHOLDER NAMES MUST BE REPLACED BY HUMAN-CREATED LISTS BEFORE ANY RELEASE.
 * (User ruling 2026-08-13; memory `feedback-npcgen-placeholder-names-blocker`.)
 *
 * ⛔ THIS IS NOT A NAME GENERATOR AND MUST NEVER BECOME ONE. Design §RULINGS Q4, verbatim: *"You are
 * strictly not to generate any names for this list. We will source a list of human created names
 * either from the internet, or myself."* What this returns is an INDEX with a prefix — "Goon 1",
 * "Goon 2" — so that N generated actors have N distinct document names while the machinery is under
 * construction. There is no pool, no composition, no randomness, and nothing to grow into one.
 *
 * When the human-created list arrives it replaces this function's BODY; the call site in
 * `npcBlueprint` does not change. Anything that ships while this still returns "Goon 3" is shipping
 * the placeholder.
 */
export function placeholderName(n, prefix = PLACEHOLDER_NAME_PREFIX) {
  const i = Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : PLACEHOLDER_NAME_START;
  return `${prefix} ${i}`;
}

// =============================================================================================
// STATS — Fast Character System, Core p.29
// =============================================================================================

/** Nine stats, in the schema's own order (`template.json` stats template, verified). */
export const STAT_KEYS = ["int", "ref", "tech", "cool", "attr", "luck", "ma", "bt", "emp"];

/**
 * A guard on the reroll loop. The book's rule terminates against real dice; an INJECTED rng is not
 * guaranteed to be real dice (a test stub that always returns 0.99 rolls 12 forever), and a pure
 * function that can hang is a worse bug than a stat one point off. On exhaustion the value is clamped
 * to the highest legal roll rather than thrown, because a generator that refuses to produce an NPC
 * mid-squad is the worse failure at the table. ⚑ Mine — the design does not address a hostile rng.
 */
const REROLL_ATTEMPT_CAP = 64;

/** The highest 2D6 result the book's reroll rule leaves standing (11 and 12 are rerolled). */
export const STAT_ROLL_MAX = 10;
export const STAT_ROLL_MIN = 2;

/**
 * ROLL NINE STATS — Core p.29 Fast Character System, per design §4 "RULES": **2D6 ×9, reroll 11+**.
 * A dice procedure, which is the side of the RTG line we may implement.
 *
 * Tier-BLIND by construction, exactly as the design observes (§Q1a: *"the book's Fast Character roll
 * is tier-blind — it can hand a 'Boss' REF 3"*). The archetype's alignment happens in `weightStats`,
 * which re-ASSIGNS these rolls without adding to them, so the output stays a legal book roll.
 */
export function rollStats(rng) {
  const stats = {};
  for (const key of STAT_KEYS) {
    let v = roll2d6(rng);
    let tries = 0;
    while (v > STAT_ROLL_MAX && tries < REROLL_ATTEMPT_CAP) { v = roll2d6(rng); tries++; }
    stats[key] = Math.min(v, STAT_ROLL_MAX);
  }
  return stats;
}

/**
 * ALIGN A ROLL WITH THE ARCHETYPE — design §RULINGS Q11: *"Archetypes carry skill AND stat WEIGHTS to
 * roll values that align with the character type."*
 *
 * ⭐ THE MECHANISM IS RE-ASSIGNMENT, NOT ADDITION, and that is the whole design decision here. The
 * nine rolled values are sorted descending and dealt out to the nine stats in weight order: the
 * archetype's highest-weighted stat gets the highest roll it actually rolled. The MULTISET of values
 * is preserved exactly, so the result is still a legal 2D6-×9 roll — which is what keeps the user's
 * ruled BOOK-LEGAL constraint (design §RULINGS Q1: legality in the *physical/structural* sense) true
 * without the generator handing out free points. A weight of 0/absent sorts last.
 *
 * Ties in weight resolve by `STAT_KEYS` order, so the function is deterministic with no rng at all.
 * ⚑ Mine: the design names stat weights but not how they apply to a fixed dice procedure.
 */
export function weightStats(stats, statWeights = {}) {
  const values = STAT_KEYS.map((k) => stats[k]).sort((a, b) => b - a);
  const order = [...STAT_KEYS].sort((a, b) => {
    const wa = Number(statWeights[a]) || 0;
    const wb = Number(statWeights[b]) || 0;
    if (wb !== wa) return wb - wa;
    return STAT_KEYS.indexOf(a) - STAT_KEYS.indexOf(b);
  });
  const out = {};
  order.forEach((k, i) => { out[k] = values[i]; });
  // Re-key into schema order so two blueprints deep-compare cleanly.
  return Object.fromEntries(STAT_KEYS.map((k) => [k, out[k]]));
}

// =============================================================================================
// SKILLS — the book's point economy, tier-scaled (design Q11B)
// =============================================================================================

/**
 * SPEND A POINT POOL OVER A NAMED SKILL LIST — the book's own allocation procedure (Core p.29 +
 * p.43-45): points across the career list, **one of which must be the Special Ability**. Design Q11B
 * (⭐ recommended, ruled in): same allocator, tier-scaled pool, *"the mechanism is the book's own"*.
 *
 * `careerSkillIds` accepts either bare schema keys (`"Handgun"`) or rows
 * `{key|id, weight, special, floor}`. Keys are the system's STABLE SCHEMA KEYS, never English display
 * names (design §Step 4: a hand-typed skill name only matches in an English world).
 *
 * INVARIANTS this function guarantees, and the tests pin all three:
 *  1. The levels sum EXACTLY to `pool` — unless the list's capacity (entries × SKILL_MAX_LEVEL) is
 *     smaller, in which case it sums to capacity and the shortfall is returned as `unspent`.
 *     A silent under-spend is how a "40-point" NPC quietly becomes a 31-point one.
 *  2. If any entry is marked `special`, it ends at 1 or better — the book's must-include rule.
 *  3. No level exceeds `SKILL_MAX_LEVEL` (the book's creation ceiling).
 *
 * Points are dealt ONE AT A TIME by weighted draw rather than by a proportional split, because a
 * proportional split has to round and rounding is where an allocator silently loses or invents the
 * last point. One-at-a-time is O(pool) on a pool of tens; that is free, and it is legible.
 */
export function allocateSkills(pool, careerSkillIds, rng, opts = {}) {
  const maxLevel = Number.isFinite(opts.maxLevel) ? opts.maxLevel : SKILL_MAX_LEVEL;
  const floors = opts.floors || {};
  const entries = (careerSkillIds || []).map((e) => (typeof e === "string"
    ? { key: e, weight: 1, special: false }
    : { key: e.key ?? e.id, weight: Number(e.weight) > 0 ? Number(e.weight) : 1, special: !!e.special, floor: e.floor }
  )).filter((e) => !!e.key);

  const levels = new Map(entries.map((e) => [e.key, 0]));
  const capacity = entries.length * maxLevel;
  const budget = Math.max(0, Math.min(Math.trunc(Number(pool) || 0), capacity));
  let spent = 0;

  const give = (key, n) => {
    const cur = levels.get(key) ?? 0;
    const room = Math.min(n, maxLevel - cur, budget - spent);
    if (room <= 0) return 0;
    levels.set(key, cur + room);
    spent += room;
    return room;
  };

  // 1. The special ability first — the book's "one of which must be" is a floor, not a preference.
  const special = entries.find((e) => e.special);
  if (special) give(special.key, Math.max(1, Number(special.floor) || 0));

  // 2. Declared floors (the Skill dial's weapon-skill points land here). Before the weighted spend so
  //    a bad draw cannot leave the tier's defining number unmet.
  for (const e of entries) {
    const floor = Number(floors[e.key] ?? e.floor);
    if (Number.isFinite(floor) && floor > 0) give(e.key, floor - (levels.get(e.key) ?? 0));
  }

  // 3. The remainder, one point at a time, weighted, skipping anything already at the ceiling.
  let guard = budget * 4 + 16;                       // cannot loop forever even if every entry saturates
  while (spent < budget && guard-- > 0) {
    const open = entries.filter((e) => (levels.get(e.key) ?? 0) < maxLevel);
    if (!open.length) break;
    const total = open.reduce((s, e) => s + e.weight, 0);
    let t = (Number(rng()) || 0) * total;
    let pick = open[open.length - 1];
    for (const e of open) { t -= e.weight; if (t < 0) { pick = e; break; } }
    give(pick.key, 1);
  }

  const skillLevels = entries
    .filter((e) => (levels.get(e.key) ?? 0) > 0)
    .map((e) => ({ skillKey: e.key, level: levels.get(e.key) }));

  return {
    skillLevels,
    spent,
    unspent: Math.max(0, Math.trunc(Number(pool) || 0) - spent),
    capacity
  };
}

/**
 * The book's pickup pool: **REF + INT**, not usable on career skills (Core p.29, via
 * `core-read-fulldetail.md:79-81`). Returned as a NUMBER only — which pickup skills a goon takes is
 * an archetype question the user's starter set answers, so nothing here invents a pickup list.
 */
export function pickupPool(stats) {
  return (Number(stats?.ref) || 0) + (Number(stats?.int) || 0);
}

// =============================================================================================
// CYBERWARE — counts only
// =============================================================================================

/**
 * THE BOOK'S COUNT PROCEDURE, AND NOTHING ELSE (Core p.29; design §4 lists it under RULES: *"a dice
 * procedure"*): **1D10 — Solos roll 6×, others 3× — reroll duplicates.**
 *
 * ⛔ THE RESULT TABLES ARE BOOK CONTENT AND ARE NOT HERE. Design §4: roll the COUNT, draw the ITEMS
 * from our own packs via the catalog index, filtered to the archetype's allowed subs. So this returns
 * how many distinct implants the NPC ends up with, plus the raw distinct d10 faces (kept because the
 * face is what a GM would have read a table row off, and a preview can show the roll it made).
 *
 * "Reroll duplicates" is implemented as what it means — the results are a SET. With 6 rolls of a d10
 * the set can never exhaust the die, but the loop is bounded anyway: an injected rng that returns a
 * constant would otherwise reroll forever.
 *
 * `tierDials.cyberwareRollsDelta` is the tier's addition to the count (⚑ my number, flagged in
 * tables.js). `opts.rollsOverride` lets an archetype override the role-derived base — the Goon uses it,
 * and the reason is written at that field.
 */
export function cyberwareCounts(role, tierDials = {}, rng, opts = {}) {
  const base = Number.isFinite(Number(opts.rollsOverride))
    ? Math.max(0, Math.trunc(Number(opts.rollsOverride)))
    : (role === "solo" ? CYBERWARE_ROLLS.solo : CYBERWARE_ROLLS.default);
  const delta = Math.trunc(Number(tierDials.cyberwareRollsDelta) || 0);
  const sides = CYBERWARE_ROLLS.dieSides;
  const rolls = Math.max(0, Math.min(base + delta, sides));   // cannot ask for more distinct faces than exist

  const results = [];
  const seen = new Set();
  let guard = rolls * 20 + 32;
  while (results.length < rolls && guard-- > 0) {
    const face = rollDie(rng, sides);
    if (seen.has(face)) continue;                              // ← "reroll duplicates", literally
    seen.add(face);
    results.push(face);
  }

  return { rolls, results, count: results.length, roleBase: base, tierDelta: delta };
}

/**
 * HUMANITY COST OF THE CHROME — design Q12b, ruled: *"compute the loss at generation time so EMP is
 * consistent with the chrome, but keep no ongoing ledger."* So this is a SUM, called once, by the
 * impure layer once it knows which items were actually drawn. No ledger, no tracking, no hooks.
 *
 * Reads `system.humanityLoss` (the system's own numeric field — `data/item-data.js:339`, defaulting
 * to 0). `system.humanityCost` is the DICE STRING ("1d6") the sheet rolls interactively and is
 * deliberately NOT rolled here: a pure function must not invent a roll the GM never saw, and the
 * numeric field is what the installed item actually costs.
 *
 * ⚠ Humanity may go NEGATIVE and that is ruled correct (design §RULINGS Q12: *"track it, even into
 * negative — let it happen and let them figure it out"*). Nothing here clamps.
 */
export function humanityFromChrome(items = []) {
  let loss = 0;
  let counted = 0;
  for (const it of items) {
    const v = Number(it?.system?.humanityLoss ?? it?.humanityLoss ?? 0);
    if (!Number.isFinite(v) || v === 0) continue;
    loss += v;
    counted++;
  }
  return { loss, counted, items: (items || []).length };
}

/**
 * Humanity = EMP × 10 (Core, via `core-read-fulldetail.md:44`), less the chrome's cost; EMP is then
 * humanity/10 rounded down. The system derives BTM/humanity/run from the stats we write, so this
 * exists only so the generator can write an EMP that is already CONSISTENT with the chrome it hands
 * out — the Q12b ruling's actual requirement. Not clamped at zero (see above).
 */
export function empAfterChrome(baseEmp, humanityLoss = 0) {
  const humanity = (Number(baseEmp) || 0) * 10 - (Number(humanityLoss) || 0);
  return { humanity, emp: Math.floor(humanity / 10) };
}

// =============================================================================================
// THE ARMOR & WEAPON ROLL
// =============================================================================================

/**
 * Core p.29: **1D10 + the role modifier**, read against the book's armor & weapon table. Design §4
 * puts the roll and its eight-number modifier table on the RULES side of the RTG line and the RESULT
 * TABLE on the CONTENT side — so this returns the NUMBER, and what that number buys is a category +
 * budget question the loadout filler answers from our own packs.
 */
export function armorWeaponRoll(roleMod, rng) {
  const die = rollDie(rng, 10);
  const mod = Math.trunc(Number(roleMod) || 0);
  return { die, mod, total: die + mod };
}

/** The book's modifier for a role, with `inBook` carried through so a UI can flag the two we defaulted. */
export function armorWeaponRoleModifier(role) {
  return ARMOR_WEAPON_ROLE_MODIFIERS[role] ?? { mod: 0, inBook: false };
}

// =============================================================================================
// ADVISORIES
// =============================================================================================

/**
 * ⛔ INFORMATIONAL ONLY — NEVER A CAP, NEVER A VALIDATOR. Design §RULINGS Q1: *"NO ceiling. Anything
 * from a street goon to an army of Adam Smashers"*, paired with *"the tool must inform GMs of power
 * breakpoints"*. This function's entire job is to say what a given SP means for the party's guns.
 *
 * Returns EVERY threshold the value has crossed, ascending — so SP 30 returns all four and the GM
 * sees the whole escalation, not just the top rung. `highest` is the last one, for a one-line UI.
 * Below the first threshold the list is empty: silence is the correct output for ordinary armor.
 */
export function breakpointAdvisories(sp) {
  const v = Number(sp);
  if (!Number.isFinite(v)) return { sp: null, crossed: [], highest: null };
  const crossed = ARMOR_BREAKPOINTS.filter((b) => v >= b.minSp);
  return { sp: v, crossed, highest: crossed.length ? crossed[crossed.length - 1] : null };
}

/** Which printed Night City armor band an SP falls in. ⚠ Bands C/D OVERLAP at SP 10 as printed —
 *  the overlap is reported, not resolved (see ARMOR_DIAL's flags). FIRST match wins, weakest first,
 *  so SP 10 reads as band D and `ambiguous` says out loud that the book also allows C. */
export function armorBandFor(sp) {
  const v = Number(sp);
  const hits = Object.values(ARMOR_DIAL_BY_KEY).filter((b) => v >= b.spMin && v <= b.spMax);
  return { band: hits[0] ?? null, ambiguous: hits.length > 1, candidates: hits.map((b) => b.key) };
}

// =============================================================================================
// ARCHETYPE COMPOSITION
// =============================================================================================

/**
 * ⭐ ARCHETYPES ARE STACKABLE MODIFIERS — design §RULINGS Q2, the user's own words: *"think of them
 * like MODIFIERS you can add"*. This is the one place that stacking is defined, so the rule is
 * readable in one screen:
 *   · numeric weight maps (`statWeights`, `skillWeights`) ADD, so two modifiers that both want REF
 *     want it more;
 *   · `loadoutSlots` CONCATENATE, so a modifier can bolt a slot on without redefining the recipe;
 *   · `cyberware.subs` UNION, and `allowFbc` is true if ANY layer allows it;
 *   · scalars (`role`, `primaryWeaponSkill`, `specialAbilitySkill`, `cyberwareRollsOverride`) are
 *     LAST-WINS, because two layers cannot both decide which enum value gets written.
 *
 * Pure and order-dependent only where last-wins says so. Nothing is mutated: every input is copied.
 */
export function mergeArchetypes(...layers) {
  const src = layers.filter(Boolean);
  const out = {
    key: null, labelKey: null, placeholder: false, role: null,
    specialAbilitySkill: null, primaryWeaponSkill: null, cyberwareRollsOverride: undefined,
    statWeights: {}, skillWeights: {}, loadoutSlots: [], cyberware: { subs: [], allowFbc: false },
    layers: []
  };
  const subs = new Set();
  for (const a of src) {
    out.layers.push(a.key ?? null);
    for (const k of ["key", "labelKey", "role", "specialAbilitySkill", "primaryWeaponSkill"]) {
      if (a[k] !== undefined && a[k] !== null) out[k] = a[k];
    }
    if (a.cyberwareRollsOverride !== undefined) out.cyberwareRollsOverride = a.cyberwareRollsOverride;
    if (a.placeholder) out.placeholder = true;                 // a placeholder layer taints the stack
    for (const [k, v] of Object.entries(a.statWeights || {})) out.statWeights[k] = (out.statWeights[k] || 0) + (Number(v) || 0);
    for (const [k, v] of Object.entries(a.skillWeights || {})) out.skillWeights[k] = (out.skillWeights[k] || 0) + (Number(v) || 0);
    for (const s of a.loadoutSlots || []) out.loadoutSlots.push({ ...s });
    for (const s of a.cyberware?.subs || []) subs.add(s);
    if (a.cyberware?.allowFbc) out.cyberware.allowFbc = true;
  }
  out.cyberware.subs = [...subs];
  return out;
}

/** Resolve an archetype argument: a key from ARCHETYPES, an inline object, or a stack of either. */
export function resolveArchetype(archetype) {
  const one = (a) => (typeof a === "string" ? ARCHETYPES[a] : a);
  const layers = (Array.isArray(archetype) ? archetype : [archetype]).map(one).filter(Boolean);
  if (!layers.length) return null;
  return layers.length === 1 ? mergeArchetypes(layers[0]) : mergeArchetypes(...layers);
}

/**
 * Resolve the dial argument into one effective dial set. Accepts a tier key (`"veteran"`), or an
 * object `{tier, skill, weapons, armor, toughness, ...buildOverrides}` whose named dials override the
 * tier's. The dials stay FREE by design (§B.2: *"mismatched combos are book-legal by demonstration"*),
 * so an override is never validated against the tier it came from.
 * ⚑ Mine: the design says "dials" without fixing the argument's shape.
 */
export function resolveDials(dials) {
  const spec = typeof dials === "string" ? { tier: dials } : (dials || {});
  const tier = TIERS_BY_KEY[spec.tier] ?? TIERS_BY_KEY.mook;
  const build = { ...tier.build, ...(spec.build || {}) };
  const skillKey = spec.skill ?? tier.dials.skill;
  const armorKey = spec.armor ?? tier.dials.armor;
  const toughKey = spec.toughness ?? tier.dials.toughness;
  const weaponsRung = spec.weapons ?? tier.dials.weapons;
  return {
    tier: tier.key,
    tierRow: tier,
    build,
    cyberwareRollsDelta: build.cyberwareRollsDelta,
    skill: SKILL_DIAL_BY_KEY[skillKey] ?? SKILL_DIAL_BY_KEY.E,
    armor: ARMOR_DIAL_BY_KEY[armorKey] ?? ARMOR_DIAL_BY_KEY.E,
    toughness: TOUGHNESS_DIAL_BY_KEY[toughKey] ?? TOUGHNESS_DIAL_BY_KEY.bt5,
    weapons: WEAPONS_DIAL_BY_RUNG[weaponsRung] ?? WEAPONS_DIAL_BY_RUNG[5]
  };
}

// =============================================================================================
// THE BLUEPRINT
// =============================================================================================

/**
 * THE WHOLE PLAN FOR N NPCs, AS PLAIN DATA. Deterministic: the same `seed` produces byte-identical
 * output, which is the ruled Q14 requirement (*"same seed → same NPC"*) and is what makes both a rig
 * assertion and a GM's "regenerate that squad" possible.
 *
 * ⭐ PER-NPC SEEDING IS FOLDED, NOT ADDED. The design sketch writes `seededRng(seed + i)`; this folds
 * `(seed, archetype, tier, i)` through `seedFrom` instead. Two reasons, both concrete: an added seed
 * collides across generations (seed 1/index 1 and seed 2/index 0 are the same stream, so "reroll with
 * seed 2" would hand back NPC #2 unchanged), and folding lets the seed be a STRING the GM typed.
 * ⚑ A deliberate deviation from the sketch, recorded here rather than silently taken.
 *
 * ⚠ SEED DEFAULTS TO 0 AND THAT IS NOT A FRESH SEED. A pure function may not call `Math.random` or
 * read a clock, so the IMPURE caller supplies a fresh seed when the GM has not pinned one; calling
 * this with no seed twice deliberately returns the same squad.
 *
 * Returns an ARRAY of blueprint objects, each `{name, stats, skillLevels, loadoutSlots,
 * cyberwareCountPlan, role, seed}` plus the provenance a preview and a materializer need. Nothing in
 * it is a document, an id, or a localized string.
 */
export function npcBlueprint({ archetype = "goon", dials = "mook", count = 1, seed = 0 } = {}) {
  const arch = resolveArchetype(archetype);
  if (!arch) throw new Error("npcBlueprint: unknown archetype");
  const d = resolveDials(dials);

  const role = ROLE_ENUM.includes(arch.role) ? arch.role : "solo";   // never write an off-enum role
  const roleMod = armorWeaponRoleModifier(role);
  const n = Math.max(0, Math.trunc(Number(count) || 0));

  // The career list is the archetype's weighted skills, with the special ability marked and the
  // Skill dial's weapon-skill points as a floor on the primary weapon skill.
  const careerSkills = Object.entries(arch.skillWeights).map(([key, weight]) => ({
    key, weight, special: key === arch.specialAbilitySkill
  }));
  const floors = arch.primaryWeaponSkill ? { [arch.primaryWeaponSkill]: d.skill.weaponSkillPoints } : {};

  const out = [];
  for (let i = 0; i < n; i++) {
    const npcSeed = seedFrom(seed, arch.key ?? "archetype", d.tier, i);
    const rng = seededRng(npcSeed);

    const rolled = rollStats(rng);
    const stats = weightStats(rolled, arch.statWeights);
    const alloc = allocateSkills(d.build.careerPool, careerSkills, rng, { floors });
    const chrome = cyberwareCounts(role, { cyberwareRollsDelta: d.cyberwareRollsDelta }, rng, {
      rollsOverride: arch.cyberwareRollsOverride
    });
    const gearRoll = armorWeaponRoll(roleMod.mod + (Number(d.build.armorWeaponRollModifier) || 0), rng);

    out.push({
      // ⛔ SHIP BLOCKER: a sequence, not a name. See placeholderName.
      name: placeholderName(PLACEHOLDER_NAME_START + i),
      role,
      stats,
      skillLevels: alloc.skillLevels,
      loadoutSlots: arch.loadoutSlots.map((s) => ({
        ...s,
        // A weapons-dial slot takes its categories from the dial, so moving the dial moves the gun.
        categories: s.weaponsDial ? d.weapons.shop : [{ category: s.category, sub: s.sub ?? null }],
        budgetEb: Math.round((Number(d.build.loadoutBudgetEb) || 0) * (Number(s.budgetShare) || 0)),
        // An armor slot carries the dial's SP band so the filler can aim, and the advisories the GM
        // is owed if it lands high. Informational — never a cap (see breakpointAdvisories).
        spBand: s.armorDial ? { min: d.armor.spMin, max: d.armor.spMax, key: d.armor.key } : null,
        advisories: s.armorDial ? breakpointAdvisories(d.armor.spMax).crossed.map((b) => b.key) : []
      })),
      cyberwareCountPlan: {
        count: chrome.count,
        rolls: chrome.rolls,
        faces: chrome.results,
        subs: arch.cyberware.subs,
        allowFbc: arch.cyberware.allowFbc
      },
      seed: npcSeed,
      // Provenance a preview, a chat card and a module flag all want. Keys, never localized text.
      plan: {
        index: i,
        rootSeed: seed,
        archetype: arch.key,
        archetypePlaceholder: arch.placeholder,
        tier: d.tier,
        dials: { skill: d.skill.key, weapons: d.weapons.rung, armor: d.armor.key, toughness: d.toughness.key },
        careerPool: d.build.careerPool,
        pointsSpent: alloc.spent,
        pointsUnspent: alloc.unspent,
        pickupPool: pickupPool(stats),
        advancedNpc: !!d.build.advancedNpc,
        armorWeaponRoll: gearRoll,
        roleModifierInBook: roleMod.inBook,
        benchmark: d.tierRow.benchmark,
        stunFailFirstWoundPct: d.tierRow.stunFailFirstWoundPct
      }
    });
  }
  return out;
}

// =================================================================================================
// =================================================================================================
// THE GOON FACTORY PIPELINE (GOON-FACTORY-SPEC.md §2 — the ORDER below is load-bearing)
// =================================================================================================
// =================================================================================================
//
// Everything above this line is the pre-rebuild engine, which SURVIVES: the window is what was
// rebuilt, and slots/outfits/FADE enter as data feeding the same blueprint. Everything below is the
// Goon Factory's own layer, and it obeys the same rule as the rest of this file — pure, injected
// rng, no Foundry, no i18n, no document.
//
// §2's numbered steps map to the functions below one for one:
//   1 resolve config  → resolveGoonConfig
//   2 stats           → rollStatPool  (+ rollFormulaField for Luck/Rep, OUTSIDE the pool)
//   3 gear            → the impure layer (materialize.js) — it needs the catalog
//   4 skills          → allocateGoonSkills  (the guarantee follows the PULLED weapon)
//   5 chrome          → chrome.js planChrome (called by the impure layer with a resolved pool)
//   6 loot            → grades.js lootProfileFor + the impure layer
//   7 name            → goonName / nextGoonNumber
//   8 materialize     → materialize.js

import {
  COUNT, GRADE_CONSTANT_BT, GRADE_DEFAULT_REF, LOOSE_LADDER, LOOT_DEFAULT, POOL_STAT_KEYS,
  ROLE_SPECIAL_ABILITY, ROLE_WEIGHTS, SKILL_POINTS, STAT_MAX, STAT_MIN, STAT_POOL,
  STAT_SHAPE_DEFAULT, ARMAMENT_POSTURE_DEFAULT,
  chromeCountFor, clampCount, gradeOf, looseWeightAt, skillPointBreakdown, statPoolBreakdown,
} from "./grades.js";
import { outfitById } from "./outfits.js";

// -------------------------------------------------------------------------------------------------
// §2.1 — RESOLVE CONFIG: outfit → grade derivation → manual overrides
// -------------------------------------------------------------------------------------------------

/**
 * The controls a grade pick DERIVES, and which of them an override may replace. Keeping the list in
 * one place is what makes "re-picking re-derives clean" a single line rather than a dozen resets.
 */
export const DERIVED_CONTROL_KEYS = [
  "grade", "role", "ref", "bt", "skillPoints", "statPool", "statShape", "chromeOn", "chromeCount",
  "garnish", "luckFormula", "repFormula", "armorWeight", "armorHardness", "armament", "loot",
];

/**
 * §2.1 + §1. Resolve the whole control set from (optional) outfit, then the grade's own defaults,
 * then whatever the GM has manually moved.
 *
 * ⭐ THE THREE BEHAVIOURS §1 DEMANDS, ALL IN THIS ONE FUNCTION:
 *  · an outfit PREFILLS everything below it (`basedOn` records which);
 *  · any manual edit after that flips the label to "Custom (based on X)" — that is `custom: true`
 *    with `basedOn` still set, which is exactly the information the label needs;
 *  · re-picking the outfit RE-DERIVES CLEAN — which is why an empty `overrides` object produces an
 *    un-custom config rather than a remembered one. The window drops its overrides on a re-pick and
 *    calls this again; nothing here is sticky.
 *
 * ⛔ ADVANCED IS DISABLED UNTIL A GRADE IS PICKED (§1, exact label "Advanced"). With no grade there
 * is nothing to derive FROM, so every control would be unlocking onto a blank — `advancedAvailable`
 * is false and the threat level initializes to dashes.
 */
export function resolveGoonConfig({ outfitId = null, role = null, grade = null, overrides = {} } = {}) {
  const outfit = outfitById(outfitId);
  const ov = overrides ?? {};
  const touched = Object.keys(ov).filter((k) => ov[k] !== undefined && ov[k] !== null && ov[k] !== "");

  const baseGrade = ov.grade ?? outfit?.grade ?? grade ?? null;
  const g = gradeOf(baseGrade);
  const baseRole = ov.role ?? outfit?.roleDefault ?? role ?? null;

  // With no grade, NOTHING derives. Returning half-derived values here is how a window ends up
  // showing a REF slider at 8 before the GM has said what kind of goon this is.
  if (!g) {
    return {
      grade: null, role: baseRole, outfitId: outfit?.id ?? null, basedOn: outfit?.id ?? null,
      custom: touched.length > 0, advancedAvailable: false,
      ref: null, bt: null, skillPoints: null, statPool: null, statShape: STAT_SHAPE_DEFAULT,
      chromeOn: false, chromeCount: 0, chromeDerivation: null, garnish: true,
      luckFormula: LUCK_FORMULA_DEFAULT, repFormula: REP_FORMULA_DEFAULT,
      armorWeight: "any", armorHardness: "any", armament: ARMAMENT_POSTURE_DEFAULT,
      loot: LOOT_DEFAULT, disposition: outfit?.disposition ?? "hostile",
      skillBias: outfit?.skillBias ?? {}, outfitTags: outfit?.tags ?? [],
      bonusPools: outfit?.bonusPools ?? [], gearSource: outfit?.gearSource ?? null,
      empOverride: outfit?.empOverride ?? null, chassis: outfit?.chassis ?? null,
    };
  }

  const ref = Number.isFinite(Number(ov.ref)) ? Math.trunc(Number(ov.ref)) : g.refDefault;
  const bt = Number.isFinite(Number(ov.bt)) ? Math.trunc(Number(ov.bt)) : g.btDefault;
  const skill = skillPointBreakdown(ov.skillPoints ?? SKILL_POINTS.default, g.key);
  const pool = statPoolBreakdown(ov.statPool ?? STAT_POOL.default, ref, bt);
  const chromeMod = Number.isFinite(Number(ov.chromeCountMod)) ? Number(ov.chromeCountMod) : (outfit?.chromeCountMod ?? 0);
  const chrome = chromeCountFor(g.key, baseRole, chromeMod);
  const posture = outfit?.armorPosture ?? {};

  return {
    grade: g.key,
    role: baseRole,
    outfitId: outfit?.id ?? null,
    basedOn: outfit?.id ?? null,
    // "Custom (based on X)" — true the moment ANY control was moved by hand, whether or not an
    // outfit is in play. A grade-only config that has been edited is equally custom.
    custom: touched.length > 0,
    advancedAvailable: true,
    ref, bt,
    skillPoints: skill.total, skillBreakdown: skill,
    statPool: pool.pool, statPoolBreakdown: pool,
    statShape: ov.statShape ?? STAT_SHAPE_DEFAULT,
    chromeOn: ov.chromeOn !== undefined ? !!ov.chromeOn : chrome.count > 0,
    chromeCount: Number.isFinite(Number(ov.chromeCount)) ? Math.max(0, Math.trunc(Number(ov.chromeCount))) : chrome.count,
    chromeDerivation: chrome,
    chromeCountMod: chromeMod,
    garnish: ov.garnish !== undefined ? !!ov.garnish : true,   // §1: garnish toggle ON
    luckFormula: ov.luckFormula || LUCK_FORMULA_DEFAULT,
    repFormula: ov.repFormula || REP_FORMULA_DEFAULT,
    armorWeight: ov.armorWeight ?? posture.weight ?? "any",
    armorHardness: ov.armorHardness ?? posture.hardness ?? "any",
    armament: ov.armament ?? posture.armament ?? ARMAMENT_POSTURE_DEFAULT,
    loot: ov.loot ?? outfit?.lootProfile ?? LOOT_DEFAULT,
    disposition: ov.disposition ?? outfit?.disposition ?? "hostile",
    skillBias: outfit?.skillBias ?? {},
    outfitTags: outfit?.tags ?? [],
    bonusPools: outfit?.bonusPools ?? [],
    gearSource: outfit?.gearSource ?? null,
    empOverride: outfit?.empOverride ?? null,
    chassis: outfit?.chassis ?? null,
    weaponsRung: g.weaponsRung,
    armorBand: g.armorBand,
  };
}

// -------------------------------------------------------------------------------------------------
// §1 — THE DICE-EXPRESSION FIELDS (Luck and Reputation)
// -------------------------------------------------------------------------------------------------

/** §1: Luck defaults to `2d6` re-rolled at 11+ — the book's own Fast Character stat roll. */
export const LUCK_FORMULA_DEFAULT = "2d6";
export const LUCK_REROLL_OVER = 10;
/** §1: Reputation defaults to `1d6-1` — 0-5, skewed anonymous, which is what a goon should be. */
export const REP_FORMULA_DEFAULT = "1d6-1";

/**
 * Parse a dice expression into terms. A deliberately SMALL grammar — `NdS` and integer constants
 * joined by + / - — because this layer is pure and Foundry's `Roll` is not available here.
 *
 * ⚠ THE WINDOW VALIDATES TWICE, ON PURPOSE, and the two checks are not redundant: the impure edge
 * additionally runs `Roll.validate` so a GM who types real Foundry syntax we do not parse (a pool
 * expression, a modifier) is told at the field rather than silently falling back at generate time.
 * This parser is the floor, not the ceiling.
 *
 * Returns null for anything it cannot read — never a partial parse, because a half-read formula is
 * the worst outcome available (it would roll something the GM did not ask for and look correct).
 */
export function parseDiceExpression(expr) {
  const s = String(expr ?? "").replace(/−|–|—/g, "-").replace(/\s+/g, "").toLowerCase();
  if (!s) return null;
  if (!/^[-+]?(\d*d\d+|\d+)([-+](\d*d\d+|\d+))*$/.test(s)) return null;
  const terms = [];
  const re = /([-+]?)(\d*)d(\d+)|([-+]?)(\d+)/g;
  let m;
  let consumed = 0;
  while ((m = re.exec(s)) !== null) {
    if (m.index !== consumed) return null;               // a gap means we misread something
    consumed = re.lastIndex;
    if (m[3] !== undefined) {
      const sign = m[1] === "-" ? -1 : 1;
      const n = m[2] === "" ? 1 : parseInt(m[2], 10);
      const faces = parseInt(m[3], 10);
      if (!Number.isFinite(n) || !Number.isFinite(faces) || faces < 1 || n < 1 || n > 100) return null;
      terms.push({ kind: "dice", sign, n, faces });
    } else {
      const sign = m[4] === "-" ? -1 : 1;
      terms.push({ kind: "flat", sign, value: parseInt(m[5], 10) });
    }
  }
  if (!terms.length || consumed !== s.length) return null;
  return terms;
}

/** Roll a parsed expression with the injected rng. */
function rollTerms(terms, rng) {
  let total = 0;
  for (const t of terms) {
    if (t.kind === "flat") { total += t.sign * t.value; continue; }
    for (let i = 0; i < t.n; i++) total += t.sign * rollDie(rng, t.faces);
  }
  return total;
}

/**
 * §1's Luck / Rep fields: "dice-expression input (Foundry Roll syntax; invalid → default + visible
 * note)", and §1's explanation line — "Rolled, not derived — nothing about threat level or role
 * affects it." Nothing in this function reads the grade, the role or the outfit, and that is the
 * feature.
 *
 * An invalid expression falls back to `fallback` AND returns `noteKey`, because §0 says nothing
 * gates silently: a GM who fat-fingers a formula must see that the default was used, not discover it
 * from a suspiciously ordinary Luck score.
 *
 * `rerollOver` implements the book's own 11+ re-roll for the 2d6 stat draw. It is bounded, because
 * an injected rng is not guaranteed to be real dice and a pure function that can hang is worse than
 * a stat one point off.
 */
export function rollFormulaField(expr, rng, { rerollOver = null, fallback = "1d6" } = {}) {
  let used = String(expr ?? "").trim();
  let terms = parseDiceExpression(used);
  const valid = !!terms;
  let noteKey = null;
  if (!terms) {
    used = fallback;
    terms = parseDiceExpression(fallback);
    noteKey = "GoonFactory.Note.InvalidFormula";
    if (!terms) return { value: 0, valid: false, used: fallback, noteKey };
  }
  let value = rollTerms(terms, rng);
  // ⚠ THE `null` TRAP, and it bit once: `Number(null)` is 0 and `Number.isFinite(0)` is TRUE, so a
  // bare `Number.isFinite(Number(rerollOver))` treats "no re-roll rule" as "re-roll anything above
  // zero" — which clamped every Reputation roll to 0 while a range assertion of 0–5 still passed.
  // The explicit null/undefined guard is the fix; the keeper now asserts VARIANCE, not just range.
  if (rerollOver !== null && rerollOver !== undefined && Number.isFinite(Number(rerollOver))) {
    let tries = 0;
    while (value > Number(rerollOver) && tries < 64) { value = rollTerms(terms, rng); tries++; }
    if (value > Number(rerollOver)) value = Number(rerollOver);
  }
  return { value, valid, used, noteKey };
}

// -------------------------------------------------------------------------------------------------
// §2.2 — STATS: the pool, the role weights, and the three shapes
// -------------------------------------------------------------------------------------------------

/**
 * ROLL THE FREE STATS WITHIN THE POOL REMAINDER (§2.2).
 *
 * ⭐ THE MECHANISM IS THE SPEC'S OWN, IN ITS OWN ORDER: "roll the seven portions (VALUES always
 * vary), then assign per the Stat shape control." Rolling and assigning are two steps, not one —
 * which is exactly why a shape change re-shuffles WHO gets what without changing the spread.
 *
 * Portions are built by dealing the remainder ONE POINT AT A TIME to a stat that still has room,
 * over a floor of `STAT_MIN` each. One-at-a-time rather than a proportional split for the same
 * reason `allocateSkills` does it: a proportional split has to round, and rounding is where an
 * allocator silently loses or invents the last point.
 *
 * ⚠ REF AND BT ARE NOT ROLLED. They are the sliders' pinned values and they are written straight
 * through — the pool reserves them and the remainder is what is left.
 *
 * ⚠ AN OVER-LARGE POOL CANNOT ALL BE SPENT and that is reported, not hidden: six stats cap at 10
 * apiece, so a 90-point pool with REF 10 / BT 10 leaves points with nowhere legal to go.
 * `unspent` carries them out so the preview can say so.
 */
export function rollStatPool({ pool, ref, bt, role = "solo", shape = STAT_SHAPE_DEFAULT, rng }) {
  const breakdown = statPoolBreakdown(pool, ref, bt);
  const keys = POOL_STAT_KEYS;
  const portions = keys.map(() => STAT_MIN);
  let remaining = breakdown.free - STAT_MIN * keys.length;

  let guard = Math.abs(remaining) * 4 + 64;
  while (remaining > 0 && guard-- > 0) {
    const open = portions.map((v, i) => (v < STAT_MAX ? i : -1)).filter((i) => i >= 0);
    if (!open.length) break;                     // every stat at the ceiling — the overflow case
    const i = open[Math.min(Math.floor((Number(rng()) || 0) * open.length), open.length - 1)];
    portions[i] += 1;
    remaining -= 1;
  }
  const unspent = Math.max(0, remaining);

  // -- ASSIGNMENT --------------------------------------------------------------------------------
  // The portions are sorted best-first; the SHAPE decides which stat each one lands on.
  const sorted = [...portions].sort((a, b) => b - a);
  const ranked = ROLE_WEIGHTS[role] ?? [];
  // The role's ranking, then everything it does not rank, in the pool's own stable order.
  const roleOrder = [...ranked.filter((k) => keys.includes(k)), ...keys.filter((k) => !ranked.includes(k))];

  let order;
  if (shape === "pureRandom") {
    // No ranking at all (§2.2: "Full-random mode ignores weights entirely"). Fisher-Yates on the
    // injected rng, so the shuffle is as deterministic as everything else here.
    order = [...keys];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.min(Math.floor((Number(rng()) || 0) * (i + 1)), i);
      [order[i], order[j]] = [order[j], order[i]];
    }
  } else if (shape === "loose") {
    // ⭐ THE ONE STRUCTURAL LADDER (§2.2): the next-largest portion is offered to the remaining rank
    // positions with odds 4/3/2/1(/1/1...). The role reads as a TENDENCY — the primary leads far
    // more often than chance, and upsets genuinely happen. Identical for every role by construction:
    // the ladder never consults the role, only the position.
    const remainingRanks = [...roleOrder];
    order = [];
    while (remainingRanks.length) {
      const weights = remainingRanks.map((_k, i) => looseWeightAt(i));
      const total = weights.reduce((s, w) => s + w, 0);
      let t = (Number(rng()) || 0) * total;
      let pick = remainingRanks.length - 1;
      for (let i = 0; i < remainingRanks.length; i++) { t -= weights[i]; if (t < 0) { pick = i; break; } }
      order.push(remainingRanks.splice(pick, 1)[0]);
    }
  } else {
    // Role-shaped, the default: strict rank assignment, so the shape is GUARANTEED.
    order = roleOrder;
  }

  const stats = { ref: Math.trunc(Number(ref) || GRADE_DEFAULT_REF), bt: Math.trunc(Number(bt) || GRADE_CONSTANT_BT) };
  order.forEach((k, i) => { stats[k] = sorted[i]; });

  return { stats, portions: sorted, order, unspent, breakdown, shape, role, ladder: LOOSE_LADDER };
}

// -------------------------------------------------------------------------------------------------
// §2.4 — SKILLS: the package, the guarantee, and the special ability
// -------------------------------------------------------------------------------------------------

/**
 * ⭐ THE BOOK'S CAREER SKILL PACKAGES (Core p.44) — §2.4's *"the role's Career Skill Package"*, which
 * the window rebuild could not supply and shipped an interim stat-weighted COMBAT SPINE in place of.
 * That spine's own comment said replacing it was "a one-table edit"; this is that edit.
 *
 * ⛔ TRANSCRIPTION SOURCE, AND THE ONLY ONE: `import-staging/CAREER-PACKAGES-P44.md` §4 PATCH-READY —
 * a two-channel (PyMuPDF + `pdftotext -layout`) TEXT-LAYER extraction of the printed page, cross-
 * checked against the base system's `template.json` schema keys and its shipped skill packs (98 rows:
 * 82 exact, 14 renamed, 0 missing). Nothing here was written from memory and nothing was re-derived
 * from the PDF by this lane. Re-verifying means re-reading that report, not re-reading the book.
 *
 * SHAPE. Every printed package is TEN entries: slot 1 the role's SPECIAL ABILITY, slot 2 always
 * Awareness/Notice, then eight more. `special` holds slot 1; `skills` holds the other NINE.
 *
 * ⭐⭐ THE SPECIAL ABILITY IS NOT IN `skills`, AND THAT IS A DELIBERATE, RULED DEVIATION FROM THE BOOK
 * (user, 2026-08-14). p.44 says *"Divide 40 points between these ten skills"* and the p.43 worked
 * example spends 6 of its 40 on Charismatic Leadership — so in the BOOK the special ability is bought
 * out of the pool. This generator instead auto-levels it at the GRADE's skill points, OUTSIDE the
 * pool, because a goon's grade is the thing its special ability should read off; the slider's points
 * spread over the other nine. The skill-points breakdown line states both halves out loud rather than
 * leaving a GM to discover the split.
 *
 * NAMES are `template.json` schema keys, never English display names. Six are the book abbreviating
 * its own p.45 MASTER SKILL LIST inside p.44's narrow columns, each resolved from that same page:
 * `Weapons Tech`→`Weaponsmith` (the one interpretive rename — ACCEPTED by the user 2026-08-14, and
 * the only "Weapons"-ish entry in the 89-key schema), `Drive`→`Driving`,
 * `Education`→`EducationGeneralKnowledge`, `Persuasion`→`PersuasionFastTalk`,
 * `Diagnose`→`DiagnoseIllness`, and the page's own print artifact `Credlblllty`→`Credibility`.
 *
 * TWO CHOICE CLAUSES the page prints, both resolved:
 *  - SOLO slot 4 is *"Brawling or Martial Arts"* → **Brawling**, the extraction's own §4
 *    recommendation: the pack ships no bare "Martial Arts" item, only 20 `Martial Arts: <style>`
 *    entries, so the martial-arts branch cannot be taken without also picking a style. One key change
 *    reopens it if the user ever wants the other branch.
 *  - TECHIE slots 8-10 are *"Any three other Tech Skills (Gyro, Aero, Weapons, Elect. Security)"* →
 *    the **NARROW** reading, ruled in 2026-08-14: draw 3 of exactly those 4, not 3 of the 17
 *    TECH-governed schema keys (which would let a goon Techie roll `PaintOrDraw`).
 *
 * ⛔ NETRUNNER's package is transcribed for completeness and the ROLE stays out of `GENERATOR_ROLES`
 * — it arrives with the netrunning pass. Carrying the data costs nothing; re-deriving it later would
 * cost another extraction.
 */
export const CAREER_PACKAGES = {
  solo:      { special: "CombatSense",           skills: ["AwarenessNotice", "Handgun", "Brawling", "Melee", "Weaponsmith", "Rifle", "Athletics", "Submachinegun", "Stealth"] },
  cop:       { special: "Authority",             skills: ["AwarenessNotice", "Handgun", "HumanPerception", "Athletics", "EducationGeneralKnowledge", "Brawling", "Melee", "Interrogation", "Streetwise"] },
  corp:      { special: "Resources",             skills: ["AwarenessNotice", "HumanPerception", "EducationGeneralKnowledge", "LibrarySearch", "Social", "PersuasionFastTalk", "StockMarket", "WardrobeStyle", "PersonalGrooming"] },
  fixer:     { special: "Streetdeal",            skills: ["AwarenessNotice", "Forgery", "Handgun", "Brawling", "Melee", "PickLock", "PickPocket", "Intimidate", "PersuasionFastTalk"] },
  nomad:     { special: "Family",                skills: ["AwarenessNotice", "Endurance", "Melee", "Rifle", "Driving", "BasicTech", "WildernessSurvival", "Brawling", "Athletics"] },
  techie:    { special: "JuryRig",               skills: ["AwarenessNotice", "BasicTech", "Cybertech", "Teaching", "EducationGeneralKnowledge", "Electronics"],
               choose:  { count: 3, from: ["GyroTech", "AeroTech", "Weaponsmith", "ElectronicSecurity"] } },
  medtechie: { special: "MedicalTech",           skills: ["AwarenessNotice", "BasicTech", "DiagnoseIllness", "EducationGeneralKnowledge", "CryotankOperation", "LibrarySearch", "Pharmaceuticals", "Zoology", "HumanPerception"] },
  media:     { special: "Credibility",           skills: ["AwarenessNotice", "Composition", "EducationGeneralKnowledge", "PersuasionFastTalk", "HumanPerception", "Social", "Streetwise", "PhotoFilm", "Interview"] },
  rocker:    { special: "CharismaticLeadership", skills: ["AwarenessNotice", "Perform", "WardrobeStyle", "Composition", "Brawling", "PlayInstrument", "Streetwise", "PersuasionFastTalk", "Seduction"] },
  netrunner: { special: "Interface",             skills: ["AwarenessNotice", "BasicTech", "EducationGeneralKnowledge", "SystemKnowledge", "Cybertech", "CyberdeckDesign", "Composition", "Electronics", "Programming"] },
};

/**
 * THE GOVERNING STAT OF EVERY KEY THE PACKAGES USE — read out of the base system's `template.json`
 * (`Actor.templates.skills.skills.<key>.stat`), not assumed. It is here rather than fetched because
 * this file is PURE: it must run under plain `node` with no Foundry and no world. A key whose stat
 * changed upstream would show up as a role weight that stopped biting, which the package legs in
 * tests/npcgen-goonfactory.test.mjs would not catch — so this table is worth re-reading against
 * `template.json` whenever the base system's skill schema moves.
 */
const SKILL_STATS = {
  AwarenessNotice: "int", Handgun: "ref", Brawling: "ref", Melee: "ref", Weaponsmith: "tech",
  Rifle: "ref", Athletics: "ref", Submachinegun: "ref", Stealth: "ref", HumanPerception: "emp",
  EducationGeneralKnowledge: "int", Interrogation: "cool", Streetwise: "cool", LibrarySearch: "int",
  Social: "emp", PersuasionFastTalk: "emp", StockMarket: "int", WardrobeStyle: "attr",
  PersonalGrooming: "attr", Forgery: "tech", PickLock: "tech", PickPocket: "tech", Intimidate: "cool",
  Endurance: "bt", Driving: "ref", BasicTech: "tech", WildernessSurvival: "int", Cybertech: "tech",
  Teaching: "int", Electronics: "tech", DiagnoseIllness: "int", CryotankOperation: "tech",
  Pharmaceuticals: "tech", Zoology: "int", Composition: "int", PhotoFilm: "tech", Interview: "emp",
  Perform: "emp", PlayInstrument: "tech", Seduction: "emp", SystemKnowledge: "int",
  CyberdeckDesign: "tech", Programming: "int", GyroTech: "tech", AeroTech: "tech",
  ElectronicSecurity: "tech",
};

/**
 * The flat combat bonus survives the package swap unchanged (§2.4's remainder weighting): the
 * generator's whole premise is a fighting NPC, so a package's weapon skills draw harder than its
 * Personal Grooming. Only keys that actually appear in a p.44 package are listed — the retired
 * spine's `HeavyWeapons`/`DodgeEscape` are in no printed package and are gone with it.
 */
const COMBAT_SKILL_KEYS = new Set(["Handgun", "Rifle", "Submachinegun", "Melee", "Brawling", "AwarenessNotice"]);

/**
 * RESOLVE A ROLE'S PACKAGE TO NINE CONCRETE KEYS, drawing any free-choice slots from `rng`.
 *
 * Only Techie has a choice clause today, so for every other role this is a copy. The draw is WITHOUT
 * replacement (the book says "any three OTHER Tech Skills" — three distinct ones), and with no `rng`
 * it takes the pool's own order, which is what makes the table inspectable from a test or a UI
 * without inventing a random stream.
 */
export function careerPackage(role, rng = null) {
  const pkg = CAREER_PACKAGES[String(role ?? "")] ?? CAREER_PACKAGES.solo;
  const skills = [...pkg.skills];
  const chosen = [];
  if (pkg.choose) {
    const pool = [...pkg.choose.from];
    for (let i = 0; i < pkg.choose.count && pool.length; i++) {
      const draw = typeof rng === "function" ? (Number(rng()) || 0) : 0;
      const idx = Math.min(Math.max(Math.floor(draw * pool.length), 0), pool.length - 1);
      chosen.push(pool.splice(idx, 1)[0]);
    }
    skills.push(...chosen);
  }
  return { special: pkg.special, skills, chosen };
}

/** The weapon-TYPE fallback when a weapon's own `attackSkill` cannot be used. */
const WEAPON_TYPE_SKILL = {
  pistol: "Handgun", smg: "Submachinegun", rifle: "Rifle", shotgun: "Rifle",
  heavy: "HeavyWeapons", melee: "Melee", exotic: "Melee",
};

/**
 * ⚠ THE CYRILLIC `attackSkill` DEFECT, HANDLED RATHER THAN TRIPPED OVER. CHROME-COMB-77.md DATA
 * FLAG 14: base `cyberweapons.db` carries Cyrillic attack skills on 12 of 12 entries. It is
 * base-pack data under the soft-defer rule, so it is READ correctly here rather than patched there.
 * Two strings, both verified in the pack.
 */
const ATTACK_SKILL_ALIASES = { "драка": "Brawling", "ближний бой": "Melee" };

/**
 * The schema keys a weapon's own `attackSkill` may legitimately name. This used to be "every key the
 * interim spine knew", which stopped being a sensible set the moment the packages became per-role —
 * a Corporate package has no Handgun, and the weapon a Corp goon draws must still resolve.
 *
 * The list is the live data's, not a guess: every `attackSkill` value in the base system's packs and
 * in this module's own pack sources was enumerated, and the Latin ones are exactly
 * Handgun · Rifle · Submachinegun · Heavy Weapons · Melee · Brawling · Fencing · Archery (plus the
 * Cyrillic strings the alias table below handles). `Fencing` and `Archery` are deliberately ABSENT:
 * the retired spine did not carry them either, so they keep resolving through the weapon TYPE and
 * this edit moves no weapon's guarantee. Adding them is a separate, deliberate change.
 */
const WEAPON_ATTACK_SKILL_KEYS = new Set([
  "Handgun", "Rifle", "Submachinegun", "HeavyWeapons", "Melee", "Brawling",
]);

/**
 * §2.4: "the grade's weapon-skill guarantee attaches to the governing skill of the ACTUALLY-PULLED
 * primary weapon." This resolves that skill — which is why the guarantee moves when the weapon does,
 * rather than being pinned to a role's assumed sidearm.
 *
 * Resolution order, most trustworthy first: the weapon's own `attackSkill` when it names a schema
 * key - the known non-Latin aliases - the weapon TYPE - Brawling. The last is not a shrug: a goon
 * with nothing resolvable is a goon fighting with their hands, and Brawling is the skill for that.
 */
export function weaponGoverningSkill(weapon) {
  const raw = String(weapon?.attackSkill ?? weapon?.system?.attackSkill ?? "").trim();
  if (raw) {
    const compact = raw.replace(/[^A-Za-z]/g, "");
    if (compact) {
      const direct = [...WEAPON_ATTACK_SKILL_KEYS].find((k) => k.toLowerCase() === compact.toLowerCase());
      if (direct) return direct;
    }
    const alias = ATTACK_SKILL_ALIASES[raw.toLowerCase()];
    if (alias) return alias;
  }
  const type = String(weapon?.weaponType ?? weapon?.system?.weaponType ?? "").trim().toLowerCase();
  return WEAPON_TYPE_SKILL[type] ?? "Brawling";
}

/**
 * ALLOCATE THE GOON'S SKILLS (§2.4).
 *
 * Three things happen, in this order, and the order is the book's:
 *  1. the GUARANTEE — the grade's weapon-skill points floor the pulled weapon's governing skill;
 *  2. the REMAINDER — spent over the role's p.44 CAREER PACKAGE (`CAREER_PACKAGES`), weighted by the
 *     role's stat vector (and the outfit's skill-bias vector, which per the outfit prep re-weights
 *     only the remainder and never adds a skill outside package + bias);
 *  3. the SPECIAL ABILITY — auto-levelled at the grade's skill points, with NO control (§1) and
 *     OUTSIDE the point pool. This is the ruled deviation written up at `CAREER_PACKAGES`: the book
 *     buys it out of the same 40, we hand it the grade instead.
 *
 * `spent` therefore equals the slider's total exactly; the special ability's level is reported
 * separately so a preview can show both without double counting.
 *
 * ⚠ THE PACKAGES ARE NARROW — nine skills, and most of them carry no weapon skill at all. The
 * guarantee is what puts a weapon skill on a Corporate or a Media goon, so the "push the guarantee's
 * skill in if the package lacks it" line below is now the COMMON path, not the edge case it was
 * under the old 26-key spine. Remove it and half the roles stop being able to shoot.
 */
export function allocateGoonSkills({ total, gradeKey, role = "solo", primaryWeapon = null, rng, skillBias = {} }) {
  const g = gradeOf(gradeKey);
  const gradePts = g ? g.skillPts : 0;
  const breakdown = skillPointBreakdown(total, gradeKey);
  const guaranteeSkill = weaponGoverningSkill(primaryWeapon);
  const ranked = ROLE_WEIGHTS[role] ?? [];
  const pkg = careerPackage(role, rng);

  // Role weight through the GOVERNING STAT: primary +3, secondary +2, tertiary +1. Combat skills
  // carry a flat +2 on top, because the generator's whole premise is a fighting NPC.
  const entries = pkg.skills.map((key) => {
    const rank = ranked.indexOf(SKILL_STATS[key]);
    return {
      key,
      weight: 1 + (COMBAT_SKILL_KEYS.has(key) ? 2 : 0) + (rank >= 0 ? 3 - rank : 0) + (Number(skillBias?.[key]) || 0),
    };
  });
  // The guarantee's skill must be IN the package, or the floor has nowhere to land.
  if (!entries.some((e) => e.key === guaranteeSkill)) entries.push({ key: guaranteeSkill, weight: 3 });

  const alloc = allocateSkills(breakdown.total, entries, rng, { floors: { [guaranteeSkill]: gradePts } });

  const specialKey = pkg.special ?? ROLE_SPECIAL_ABILITY[role] ?? null;
  const skillLevels = [...alloc.skillLevels];
  if (specialKey) skillLevels.push({ skillKey: specialKey, level: gradePts });

  return {
    skillLevels,
    spent: alloc.spent,
    unspent: alloc.unspent,
    breakdown,
    guarantee: { skillKey: guaranteeSkill, points: gradePts },
    careerSkills: pkg.skills,
    freeChoices: pkg.chosen,
    specialAbilityKey: specialKey,
    specialAbilityLevel: specialKey ? gradePts : 0,
  };
}

// -------------------------------------------------------------------------------------------------
// §2.7 — NAMES
// -------------------------------------------------------------------------------------------------

/**
 * §2.7: `{Outfit|Role} {Grade}-{n}`. Attribute-derived names are the SHIPPING DEFAULT (ruled
 * 2026-08-13 — the old placeholder-names blocker is moot); human-written flavour pools become an
 * optional per-outfit `namePool` later and this function's call site does not change.
 *
 * The value is a bare English string BY DESIGN: a created document's name is persisted DATA, not UI
 * text, and this project's own convention keeps those English.
 */
export function goonName(prefix, gradeKey, n) {
  return `${String(prefix ?? "").trim()} ${String(gradeKey ?? "")}-${Math.trunc(Number(n) || 1)}`;
}

/** Regex-escape a prefix so an outfit label with punctuation still matches literally. */
function escapeRe(s) { return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * §2.7: "numbering CONTINUES per prefix within the destination folder (scan existing)."
 *
 * The scan is per PREFIX and per GRADE, because the name carries both — so a second batch of
 * "Solo B" goons continues past the first while a batch of "Solo AA" starts its own run. A name that
 * shares the prefix but is not the pattern ("Solo Bravo", a hand-renamed "Solo B-fred") does NOT
 * bump the counter: the counter follows the scheme, not the neighbourhood.
 */
export function nextGoonNumber(existingNames, prefix, gradeKey) {
  const re = new RegExp(`^${escapeRe(String(prefix ?? "").trim())} ${escapeRe(String(gradeKey ?? ""))}-(\\d+)$`);
  let max = 0;
  for (const name of existingNames ?? []) {
    const m = re.exec(String(name ?? "").trim());
    if (m) max = Math.max(max, parseInt(m[1], 10) || 0);
  }
  return max + 1;
}

// -------------------------------------------------------------------------------------------------
// THE BLUEPRINT
// -------------------------------------------------------------------------------------------------

/**
 * THE WHOLE PLAN FOR N GOONS, AS PLAIN DATA — the pure half of §2 (steps 1, 2, 4, 7).
 *
 * Steps 3 (gear), 5 (chrome) and 6 (loot) need the catalog, so they belong to the impure layer and
 * are folded in by `materialize.js`; what this returns is everything that can be decided without a
 * pack. The split is what makes the preview and the create the same object.
 *
 * ⭐ THE PER-GOON SEED IS RETAINED (§1: "Internal per-goon seed retained (reproducibility;
 * visible-seed UI retired)"). It is folded from `(seed, outfit|role, grade, index)` rather than
 * added, for the reason the pre-rebuild engine already documents: an ADDED seed collides across
 * generations, so "reroll" would hand back an earlier goon unchanged.
 */
export function goonBlueprint({
  outfitId = null, role = "solo", grade = "E", count = 1, seed = 0, overrides = {},
  namePrefix = null, startNumber = 1,
} = {}) {
  const config = resolveGoonConfig({ outfitId, role, grade, overrides });
  const n = clampCount(count).value;
  const gradeKey = config.grade ?? grade;
  const prefix = namePrefix ?? config.outfitId ?? config.role ?? "Goon";

  const out = [];
  for (let i = 0; i < n; i++) {
    const goonSeed = seedFrom(seed, config.outfitId ?? config.role ?? "goon", gradeKey, i);
    const rng = seededRng(goonSeed);

    const statRoll = rollStatPool({
      pool: config.statPool, ref: config.ref, bt: config.bt,
      role: config.role, shape: config.statShape, rng,
    });
    // §2.2: Luck and Rep are rolled from the formula fields, OUTSIDE the pool.
    const luck = rollFormulaField(config.luckFormula, rng, { rerollOver: LUCK_REROLL_OVER, fallback: LUCK_FORMULA_DEFAULT });
    const rep = rollFormulaField(config.repFormula, rng, { fallback: REP_FORMULA_DEFAULT });
    const stats = { ...statRoll.stats, luck: luck.value };

    // The skills are allocated WITHOUT a weapon here and re-allocated by the impure layer once the
    // gear pull is known — §2.4's guarantee follows the ACTUALLY-PULLED weapon, and nothing in this
    // file can know what that is. The provisional allocation exists so a plan is complete on its own.
    const skills = allocateGoonSkills({
      total: config.skillPoints, gradeKey, role: config.role,
      primaryWeapon: null, rng, skillBias: config.skillBias,
    });

    const honesty = [
      // §1's preview list: this line is unconditional, because it explains a thing every goon has.
      { code: "luckRepRolled", messageKey: "GoonFactory.Honesty.LuckRepRolled" },
    ];
    if (luck.noteKey) honesty.push({ code: "invalidLuckFormula", messageKey: luck.noteKey, used: luck.used });
    if (rep.noteKey) honesty.push({ code: "invalidRepFormula", messageKey: rep.noteKey, used: rep.used });
    if (statRoll.unspent > 0) honesty.push({ code: "statPoolUnspent", points: statRoll.unspent, messageKey: "GoonFactory.Honesty.StatPoolUnspent" });
    if (config.statPoolBreakdown?.clamped) honesty.push({ code: "statPoolClamped", messageKey: "GoonFactory.Honesty.StatPoolClamped" });
    if (config.skillBreakdown?.clamped) honesty.push({ code: "skillPointsClamped", messageKey: "GoonFactory.Honesty.SkillPointsClamped" });

    out.push({
      name: goonName(prefix, gradeKey, startNumber + i),
      namePrefix: prefix,
      role: config.role,
      grade: gradeKey,
      stats,
      reputation: rep.value,
      luckRoll: luck,
      repRoll: rep,
      statRoll: { portions: statRoll.portions, order: statRoll.order, shape: statRoll.shape, unspent: statRoll.unspent },
      skillLevels: skills.skillLevels,
      skillPlan: skills,
      config,
      seed: goonSeed,
      honesty,
      plan: {
        index: i, rootSeed: seed, outfitId: config.outfitId, basedOn: config.basedOn,
        custom: config.custom, weaponsRung: config.weaponsRung, armorBand: config.armorBand,
        chromeCount: config.chromeCount, chromeDerivation: config.chromeDerivation,
        garnish: config.garnish, loot: config.loot, armament: config.armament,
        armorWeight: config.armorWeight, armorHardness: config.armorHardness,
      },
    });
  }
  return out;
}

/** The generator's own cap, re-exported so a window and the materializer read one number. */
export const GOON_COUNT_CAP = COUNT.cap;
