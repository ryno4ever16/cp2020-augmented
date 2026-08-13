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
