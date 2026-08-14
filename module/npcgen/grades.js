/**
 * GOON FACTORY — THE GRADE LADDER AND EVERY DIAL A GRADE PICK DERIVES.
 *
 * Pure data + arithmetic. No Foundry, no `game`, no i18n, no randomness — so the whole file runs
 * under plain `node` (tests/npcgen-goonfactory.test.mjs) and a maintainer can read one screen and
 * see what a GRADE *is*.
 *
 * SOURCE OF EVERY NUMBER HERE: `import-staging/GOON-FACTORY-SPEC.md` §1 (the window's control table)
 * and §3 (`Grades`). Section refs below are to that file, which wins over every other document.
 * Where the spec left a value open I say so at the field with a ⚑ and name the reading I took —
 * there is no silent choice anywhere in this file.
 *
 * ⛔ THE RTG LINE (as in tables.js): dice procedures, point economies and the threat-code AXES are
 * mechanics we may implement. No book NPC stat block, no book result table, no book career-skill
 * list is transcribed here.
 *
 * ⭐ THE INVARIANT THIS FILE EXISTS TO PROTECT (§0): *"Totals are sliders with book-named ticks;
 * guarantees are reservations drawn on the track; breakdowns show both."* Every `…Breakdown`
 * function below returns BOTH halves — the total and its reservation — plus a `clamped` flag, so
 * the window can always say out loud what it did rather than silently moving a number.
 */

// =================================================================================================
// THE SIX-RUNG LADDER
// =================================================================================================

/** Weakest first. AA is the rung above the book's printed A — the spec's own ladder. */
export const GRADE_KEYS = ["E", "D", "C", "B", "A", "AA"];

/** The REF every grade assumes (§1 REF slider: *"The book assumes REF 8"*). */
export const GRADE_DEFAULT_REF = 8;

/**
 * ⭐ BT IS A CONSTANT 7 AT EVERY GRADE and is *"only ever manually moved"* (§1, verbatim). It is NOT
 * derived, NOT scaled, and a future grade table that varies it is contradicting the spec. The
 * always-visible stakes line the window shows exists because of this: every grade assumes BT 7.
 */
export const GRADE_CONSTANT_BT = 7;

export const REF_RANGE = { min: 2, max: 10 };
export const BT_RANGE = { min: 2, max: 10 };

/** §1 BT slider: ticks at 3/5/8/10, each with a band hover the render edge localizes. */
export const BT_TICKS = [
  { value: 3, hintKey: "CYBERPUNK.GoonFactory.BtBand.3" },
  { value: 5, hintKey: "CYBERPUNK.GoonFactory.BtBand.5" },
  { value: 8, hintKey: "CYBERPUNK.GoonFactory.BtBand.8" },
  { value: 10, hintKey: "CYBERPUNK.GoonFactory.BtBand.10" },
];

/**
 * THE GRADES (§3 `Grades`, verbatim where the spec prints a number):
 *   skillPts   2/4/6/8/10/10 — the weapon-skill guarantee, and the level the special ability lands at
 *   chromeBase 0/0–1/2/3/4/6 (§1 "Chromed toggle + count")
 *   refOverride  AA → 10, *"the sole tier exception"*
 *   whiffAllowed C and below — the "Nothing" chrome result exists there and nowhere else
 *   armorBand  the same letter (ARMOR-CRITERIA-DRAFT's band pools are keyed E…AA)
 *
 * ⚑ TWO READINGS I TOOK, both recorded rather than taken silently:
 *  1. `chromeBase` for D. The spec prints "D 0–1" — a range, and the only ranged entry in the
 *     ladder. The engine needs one number to add to the Solo bonus and the outfit modifier, so D
 *     takes **1** — the top of its own printed range, which keeps the ladder monotone (0,1,2,3,4,6)
 *     and never hands a D goon *fewer* implants than an E. A future ruling that wants the coin-flip
 *     back changes this one field.
 *  2. `weaponsRung`. §3 names the field and gives no values. The rungs are the existing
 *     `WEAPONS_DIAL` (tables.js — the book's own p.40 axis, which runs INVERTED: rung 1 is best),
 *     mapped straight down the letter ladder E→5 … A→1. AA has no rung above 1 to climb to, so it
 *     shares rung 1 with A and reaches past it through chrome and posture instead — exactly the way
 *     ARMOR-CRITERIA-DRAFT resolves the identical problem on the armor side ("AA = LAYERED stacks",
 *     not a mythical item above the top of the printed ladder).
 */
export const GRADES = {
  E:  { key: "E",  skillPts: 2,  weaponsRung: 5, armorBand: "E",  refDefault: 8,  btDefault: 7, chromeBase: 0, whiffAllowed: true,  labelKey: "CYBERPUNK.GoonFactory.Grade.E",  hintKey: "CYBERPUNK.GoonFactory.GradeHint.E" },
  D:  { key: "D",  skillPts: 4,  weaponsRung: 4, armorBand: "D",  refDefault: 8,  btDefault: 7, chromeBase: 1, whiffAllowed: true,  labelKey: "CYBERPUNK.GoonFactory.Grade.D",  hintKey: "CYBERPUNK.GoonFactory.GradeHint.D" },
  C:  { key: "C",  skillPts: 6,  weaponsRung: 3, armorBand: "C",  refDefault: 8,  btDefault: 7, chromeBase: 2, whiffAllowed: true,  labelKey: "CYBERPUNK.GoonFactory.Grade.C",  hintKey: "CYBERPUNK.GoonFactory.GradeHint.C" },
  B:  { key: "B",  skillPts: 8,  weaponsRung: 2, armorBand: "B",  refDefault: 8,  btDefault: 7, chromeBase: 3, whiffAllowed: false, labelKey: "CYBERPUNK.GoonFactory.Grade.B",  hintKey: "CYBERPUNK.GoonFactory.GradeHint.B" },
  A:  { key: "A",  skillPts: 10, weaponsRung: 1, armorBand: "A",  refDefault: 8,  btDefault: 7, chromeBase: 4, whiffAllowed: false, labelKey: "CYBERPUNK.GoonFactory.Grade.A",  hintKey: "CYBERPUNK.GoonFactory.GradeHint.A" },
  AA: { key: "AA", skillPts: 10, weaponsRung: 1, armorBand: "AA", refDefault: 10, btDefault: 7, chromeBase: 6, whiffAllowed: false, labelKey: "CYBERPUNK.GoonFactory.Grade.AA", hintKey: "CYBERPUNK.GoonFactory.GradeHint.AA" },
};

/** A grade row by key, or null. `null` is the legitimate "no grade picked yet" state (§1). */
export function gradeOf(key) {
  return GRADES[String(key ?? "")] ?? null;
}

/** Ladder index, weakest 0. −1 for an unknown key, so a gate comparison fails closed. */
export function gradeIndex(key) {
  return GRADE_KEYS.indexOf(String(key ?? ""));
}

/** True when `gradeKey` is at or above `gateKey` on the ladder. Unknown grade ⇒ false (fail closed). */
export function gradeMeets(gradeKey, gateKey) {
  const g = gradeIndex(gradeKey);
  const gate = gradeIndex(gateKey);
  return g >= 0 && gate >= 0 && g >= gate;
}

// =================================================================================================
// ROLES
// =================================================================================================

/**
 * ⛔ NETRUNNER IS OMITTED, DELIBERATELY (§1, and a standing needle in memory: the role arrives with
 * the netrunning pass). This list is not "the schema enum minus one by accident" — the omission is
 * the ruling, and a keeper leg asserts it, so re-adding netrunner here fails the suite until the
 * netrunning unit lands and the needle is pulled.
 */
export const GENERATOR_ROLES = ["solo", "cop", "corp", "fixer", "nomad", "techie", "medtechie", "media", "rocker"];

/**
 * ⭐ ROLE STAT WEIGHT VECTORS (§2.2, recovered ruling 2026-08-13 + the user's derivation method
 * 2026-08-14). These are RANKS, weakest-last: `[primary, secondary, tertiary]`.
 *
 * They are BOOK-DERIVED, not chosen: the PRIMARY is the governing stat of the role's Special
 * Ability, and the secondary/tertiary come from counting the career package's skill→stat
 * correlations (ties by package order). REF and BODY are excluded because both are pinned by their
 * own sliders, and **MA never ranks** — §2.2 says so in as many words.
 *
 * Copied verbatim from §2.2's own line. Do not "improve" one: the vector is the ruling.
 */
export const ROLE_WEIGHTS = {
  solo:      ["int", "tech"],
  cop:       ["cool", "int", "emp"],
  corp:      ["int", "emp", "attr"],
  fixer:     ["cool", "tech", "int"],
  nomad:     ["int", "tech"],
  techie:    ["tech", "int"],
  medtechie: ["tech", "int", "emp"],
  media:     ["int", "emp", "cool"],
  rocker:    ["cool", "emp", "int"],
};

/**
 * The role's Special Ability skill, by the system's own stable schema key. Not book CONTENT — these
 * are the ten items the base system already ships in its `role-skills-` pack, and the pairing is the
 * schema's, not a transcription of a printed table. Netrunner's Interface is present because the
 * mapping is shared plumbing; the ROLE is still omitted from `GENERATOR_ROLES`.
 */
export const ROLE_SPECIAL_ABILITY = {
  solo: "CombatSense", cop: "Authority", corp: "Resources", fixer: "Streetdeal",
  nomad: "Family", techie: "JuryRig", medtechie: "MedicalTech", media: "Credibility",
  rocker: "CharismaticLeadership", netrunner: "Interface",
};

// =================================================================================================
// THE STAT POOL (§1 "Stat Pool slider" + §2.2)
// =================================================================================================

/**
 * The nine schema stats, in the schema's own order. Restated from blueprint.js's `STAT_KEYS` so this
 * file stays importable on its own; the two are asserted equal nowhere because they are the same
 * nine and a divergence would be caught by the first blueprint leg that reads a missing stat.
 */
export const ALL_STAT_KEYS = ["int", "ref", "tech", "cool", "attr", "luck", "ma", "bt", "emp"];

/**
 * ⚠ THE SPEC'S ONE ARITHMETIC TENSION, AND THE READING I TOOK — recorded here because it is the
 * only place in this build where two spec statements do not close.
 *
 * §1 says the stat-pool floor is *"reservations + 7×2"* and that *"the 7 free stats RANDOMIZE
 * within the remainder"*. Nine stats minus the two reserved (REF, BT) is indeed seven. But §2.2 then
 * says *"Luck/Rep rolled from the formula fields (OUTSIDE the pool)"*, and §1 gives Luck its own
 * dice-expression field — so LUCK's value cannot also be drawn from the pool remainder.
 *
 * The smallest faithful reading, which is what is implemented:
 *  · the FLOOR is the spec's literal `reservations + 7×2` (`FREE_STAT_SLOTS = 7`), so the guard rail
 *    is exactly the number the spec prints and errs conservative by one stat's minimum;
 *  · the DISTRIBUTED stats are the six that are neither reserved nor formula-rolled
 *    (`POOL_STAT_KEYS`), because Luck is written from its formula field.
 * The two-point gap is deliberate slack, never a silent re-derivation. Reported as a spec gap.
 */
export const FREE_STAT_SLOTS = 7;

/** The stats the pool remainder is actually distributed over: nine, less REF/BT (reserved) and LUCK (formula). */
export const POOL_STAT_KEYS = ["int", "tech", "cool", "attr", "ma", "emp"];

/** The lowest a rolled stat may sit — the 2D6 floor the book's own roll cannot go under. */
export const STAT_MIN = 2;
/** The book's character-creation stat ceiling. */
export const STAT_MAX = 10;

/**
 * §1: default 60 · ticks at 50/60/70/75/80 whose hovers name the book tiers · ceiling 90.
 * The tick HOVERS are keys, not text — the shipped table stays i18n-free and unit-testable.
 */
export const STAT_POOL = {
  default: 60,
  ceiling: 90,
  ticks: [
    { value: 50, hintKey: "CYBERPUNK.GoonFactory.PoolTick.50" },
    { value: 60, hintKey: "CYBERPUNK.GoonFactory.PoolTick.60" },
    { value: 70, hintKey: "CYBERPUNK.GoonFactory.PoolTick.70" },
    { value: 75, hintKey: "CYBERPUNK.GoonFactory.PoolTick.75" },
    { value: 80, hintKey: "CYBERPUNK.GoonFactory.PoolTick.80" },
  ],
};

/**
 * THE STAT-POOL RESERVATION ARITHMETIC (§1, and a named §4 keeper requirement).
 *
 * Reservations are **REF + BT only** — the two stats their own sliders pin. The dynamic floor is
 * `reservations + FREE_STAT_SLOTS × STAT_MIN`: below it the remaining stats could not all reach the
 * book's own minimum, so the pool clamps UP and says it did. The ceiling clamps DOWN the same way.
 * Nothing here moves a number without reporting it — that is the §0 invariant.
 */
export function statPoolBreakdown(pool, ref, bt) {
  const reserved = (Math.trunc(Number(ref) || 0)) + (Math.trunc(Number(bt) || 0));
  const floor = reserved + FREE_STAT_SLOTS * STAT_MIN;
  const raw = Number.isFinite(Number(pool)) ? Math.trunc(Number(pool)) : STAT_POOL.default;
  const value = Math.min(Math.max(raw, floor), STAT_POOL.ceiling);
  return { pool: value, reserved, floor, ceiling: STAT_POOL.ceiling, free: value - reserved, clamped: value !== raw };
}

// =================================================================================================
// THE SKILL-POINT POOL (§1 "Skill-points slider" + §2.4)
// =================================================================================================

/** §1: default 40 — the book's own career pool, which is also `BOOK_CAREER_POOL` in tables.js. */
export const SKILL_POINTS = { default: 40 };

/**
 * THE SKILL-POINT RESERVATION ARITHMETIC (§1, and a named §4 keeper requirement).
 *
 * The reserved zone is the GRADE's weapon-skill points; the remainder goes to the role package. The
 * spec's own worked breakdown line is the assertion this is written against: *"40 — 8 reserved for
 * weapon skill (grade B) · 32 to the role package"*. The dynamic floor IS the reservation, so a GM
 * who drags the total under the guarantee gets a visible clamp rather than a guarantee the generator
 * quietly failed to honor.
 */
export function skillPointBreakdown(total, gradeKey) {
  const grade = gradeOf(gradeKey);
  const reserved = grade ? grade.skillPts : 0;
  const raw = Number.isFinite(Number(total)) ? Math.trunc(Number(total)) : SKILL_POINTS.default;
  const value = Math.max(raw, reserved);
  return { total: value, reserved, toPackage: value - reserved, floor: reserved, clamped: value !== raw };
}

// =================================================================================================
// COUNT (§1 header band)
// =================================================================================================

/** §1: free entry, default 6, **cap 12**, visible clamp. The cap is also the materializer's own. */
export const COUNT = { default: 6, min: 1, cap: 12 };

/** Clamp a typed count, reporting whether it moved — the window shows the clamp, never hides it. */
export function clampCount(n) {
  const raw = Number(n);
  if (!Number.isFinite(raw)) return { value: COUNT.default, clamped: false };
  const t = Math.trunc(raw);
  const value = Math.min(Math.max(t, COUNT.min), COUNT.cap);
  return { value, clamped: value !== t };
}

// =================================================================================================
// CHROME COUNT (§1 "Chromed toggle + count")
// =================================================================================================

/**
 * §1's own tooltip is the specification of this function: the count derives as
 * *"3 grade B + 2 Solo + 1 outfit"*, and the tooltip shows that derivation — so the function returns
 * the three terms, not just their sum. A UI that had to re-derive the parts would drift from the
 * number it is explaining.
 *
 * ⚑ `SOLO_CHROME_BONUS = 2` is read straight off that worked example (grade B base 3 + Solo = 5,
 * and the example's Solo term is printed as 2). It is the spec's own arithmetic, not a choice.
 */
export const SOLO_CHROME_BONUS = 2;

export function chromeCountFor(gradeKey, role, outfitMod = 0) {
  const grade = gradeOf(gradeKey);
  const base = grade ? grade.chromeBase : 0;
  const soloBonus = role === "solo" ? SOLO_CHROME_BONUS : 0;
  const mod = Math.trunc(Number(outfitMod) || 0);
  return { base, soloBonus, outfitMod: mod, count: Math.max(0, base + soloBonus + mod) };
}

// =================================================================================================
// STAT SHAPE (§2.2 "Stat shape" control)
// =================================================================================================

/** The three ruled values. Order is the window's option order, weakest-constraint last. */
export const STAT_SHAPES = ["roleShaped", "loose", "pureRandom"];
export const STAT_SHAPE_DEFAULT = "roleShaped";
export const STAT_SHAPE_LABEL_KEYS = {
  roleShaped: "CYBERPUNK.GoonFactory.Shape.RoleShaped",
  loose: "CYBERPUNK.GoonFactory.Shape.Loose",
  pureRandom: "CYBERPUNK.GoonFactory.Shape.PureRandom",
};

/**
 * ⭐ ONE STRUCTURAL LADDER, IDENTICAL FOR EVERY ROLE (§2.2, verbatim: *"one STRUCTURAL ladder
 * 4/3/2/1, identical for every role, a shape parameter not a balance number"*). It is the draw
 * weighting the LOOSE shape uses when it picks which rank position takes the next portion, so the
 * role reads as a tendency and upsets happen.
 *
 * ⚑ The printed ladder covers four positions and six stats are distributed. The remaining positions
 * continue at the ladder's own last value (1) — the smallest reading that needs no new number.
 */
export const LOOSE_LADDER = [4, 3, 2, 1];

/** The draw weight for rank position `i` under the Loose shape. */
export function looseWeightAt(i) {
  return LOOSE_LADDER[Math.min(Math.max(Math.trunc(i), 0), LOOSE_LADDER.length - 1)];
}

// =================================================================================================
// LOOT (§1 "Loot dial")
// =================================================================================================

/**
 * §1: **OFF by default (GM consent)** / Scarce / Standard / Generous. When on: spare magazines as
 * REAL ammo items + cash as the CREDCHIP item.
 *
 * ⚑ THE AMOUNTS ARE MINE, and the spec says so: *"amounts per grade/outfit at curation"* — the
 * curation session has not happened. What ships is a legible shape rather than a curated table:
 * magazines step 1/2/3 with the dial, and cash is `perGradeEb` × the dial's multiplier, where
 * `perGradeEb` walks the grade ladder. Every number is in this one block so the curation session is
 * a single edit. OFF is a hard zero on both, not a small number.
 */
export const LOOT_DIAL = ["off", "scarce", "standard", "generous"];
export const LOOT_DEFAULT = "off";
export const LOOT_LABEL_KEYS = {
  off: "CYBERPUNK.GoonFactory.Loot.Off", scarce: "CYBERPUNK.GoonFactory.Loot.Scarce",
  standard: "CYBERPUNK.GoonFactory.Loot.Standard", generous: "CYBERPUNK.GoonFactory.Loot.Generous",
};

/** ⚑ mine, pending curation — the per-grade pocket money a goon is carrying, before the dial. */
const LOOT_BASE_EB_BY_GRADE = { E: 20, D: 50, C: 120, B: 250, A: 500, AA: 1000 };
/** ⚑ mine, pending curation — the dial's multiplier and its spare-magazine count. */
const LOOT_DIAL_PROFILE = {
  off:      { mult: 0,   spareMags: 0 },
  scarce:   { mult: 0.5, spareMags: 1 },
  standard: { mult: 1,   spareMags: 2 },
  generous: { mult: 2.5, spareMags: 3 },
};

export function lootProfileFor(dial, gradeKey) {
  const d = LOOT_DIAL_PROFILE[String(dial ?? "")] ?? LOOT_DIAL_PROFILE.off;
  const base = LOOT_BASE_EB_BY_GRADE[String(gradeKey ?? "")] ?? 0;
  return { dial: LOOT_DIAL.includes(dial) ? dial : "off", spareMags: d.spareMags, cashEb: Math.round(base * d.mult) };
}

// =================================================================================================
// ARMOR FILTERS (§1 "Armor filters")
// =================================================================================================

/** §1: Weight Any/Light/Heavy · Hardness Any/Soft/Hard · Armament posture Standard/AP/Chemical. */
export const ARMOR_WEIGHT_FILTERS = ["any", "light", "heavy"];
export const ARMOR_HARDNESS_FILTERS = ["any", "soft", "hard"];
export const ARMAMENT_POSTURES = ["standard", "ap", "chemical"];
export const ARMAMENT_POSTURE_DEFAULT = "standard";
