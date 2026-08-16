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
  { value: 3, hintKey: "GoonFactory.BtBand.3" },
  { value: 5, hintKey: "GoonFactory.BtBand.5" },
  { value: 8, hintKey: "GoonFactory.BtBand.8" },
  { value: 10, hintKey: "GoonFactory.BtBand.10" },
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
  E:  { key: "E",  skillPts: 2,  weaponsRung: 5, armorBand: "E",  refDefault: 8,  btDefault: 7, chromeBase: 0, whiffAllowed: true,  labelKey: "GoonFactory.Grade.E",  hintKey: "GoonFactory.GradeHint.E" },
  D:  { key: "D",  skillPts: 4,  weaponsRung: 4, armorBand: "D",  refDefault: 8,  btDefault: 7, chromeBase: 1, whiffAllowed: true,  labelKey: "GoonFactory.Grade.D",  hintKey: "GoonFactory.GradeHint.D" },
  C:  { key: "C",  skillPts: 6,  weaponsRung: 3, armorBand: "C",  refDefault: 8,  btDefault: 7, chromeBase: 2, whiffAllowed: true,  labelKey: "GoonFactory.Grade.C",  hintKey: "GoonFactory.GradeHint.C" },
  B:  { key: "B",  skillPts: 8,  weaponsRung: 2, armorBand: "B",  refDefault: 8,  btDefault: 7, chromeBase: 3, whiffAllowed: false, labelKey: "GoonFactory.Grade.B",  hintKey: "GoonFactory.GradeHint.B" },
  A:  { key: "A",  skillPts: 10, weaponsRung: 1, armorBand: "A",  refDefault: 8,  btDefault: 7, chromeBase: 4, whiffAllowed: false, labelKey: "GoonFactory.Grade.A",  hintKey: "GoonFactory.GradeHint.A" },
  AA: { key: "AA", skillPts: 10, weaponsRung: 1, armorBand: "AA", refDefault: 10, btDefault: 7, chromeBase: 6, whiffAllowed: false, labelKey: "GoonFactory.Grade.AA", hintKey: "GoonFactory.GradeHint.AA" },
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
 * ⭐ "RANDOM" IS A ROLE CONTROL VALUE, NOT A ROLE (ruled 2026-08-15). It is the window's DEFAULT
 * state, and it means *"each goon in this batch rolls its own role"* — the draw happens per goon in
 * `blueprint.js` (`rollRoleFor`), never here and never once for a whole squad.
 *
 * ⛔ IT MUST NEVER REACH A DOCUMENT. `system.role.value` is a schema ENUM and "random" is not in it,
 * so `goonBlueprint` resolves the sentinel to a concrete book role before anything downstream sees
 * it, and `materializeGoon` writes the RESOLVED role rather than the control's value. A goon whose
 * sheet reads "random" is this rule having been broken.
 *
 * The string lives here rather than in blueprint.js because both the pure planner and the window's
 * option list need it and this file is the one neither of them can import in a cycle.
 */
export const ROLE_RANDOM = "random";

/** The Role select's options, Random first — it is the default, and a default reads first. */
export const ROLE_OPTIONS = [ROLE_RANDOM, ...GENERATOR_ROLES];

/**
 * ⭐ DISPOSITION IS A BASELINE CONTROL, NOT AN ADVANCED DIAL (ruled 2026-08-15). It sits in the
 * window's TOP band beside threat level / role / outfit, an outfit PREFILLS it, and the GM flips it
 * as freely as any other prefilled control.
 *
 * ⛔ TWO VALUES, NOT THREE. `goonPrototypeToken` can map `friendly` as well, and that mapping stays
 * for a direct caller, but the control offers only the two a goon squad is ever built as — the
 * generator's whole premise is an opposition NPC, and a "friendly" goon is a hand edit on one actor
 * rather than a batch setting.
 */
export const DISPOSITIONS = ["hostile", "neutral"];
export const DISPOSITION_DEFAULT = "hostile";

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
// TRACK GEOMETRY — where a number sits on a slider (§0: "totals are sliders with book-named ticks;
// guarantees are reservations drawn on the track")
// =================================================================================================

/**
 * A value's position on a track, as a percentage of the track's own span (0–100).
 *
 * ⭐ THIS IS THE ONE NUMBER THAT CROSSES INTO THE STYLESHEET, and it is why it lives in the pure
 * layer rather than in the window: the tick marks (R6) and the reserved band (R7) are both "where
 * does this value sit", so both are this function, and a test can assert the rendered position by
 * VALUE instead of by eye. The window writes the number into a CSS custom property; the stylesheet
 * owns every colour, the gradient and the mark's shape. No CSS is ever built in JS.
 *
 * Rounded to two decimals — finer than a pixel on any real track, and stable enough that a keeper
 * can compare the DOM's value against this function's rather than against a transcribed literal.
 */
export function trackPct(value, min, max) {
  const lo = Number(min) || 0;
  const span = Number(max) - lo;
  if (!Number.isFinite(span) || span <= 0) return 0;
  const raw = ((Number(value) || 0) - lo) / span * 100;
  return Math.round(Math.min(100, Math.max(0, raw)) * 100) / 100;
}

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
 *
 * ⭐ `scaleMin` IS THE TRACK'S ORIGIN, NOT A LEGAL POOL (R7, ruled 2026-08-14). The slider used to
 * start at the dynamic floor, which is exactly why the reservation was invisible: a track that
 * begins where the reservation ends has nothing left to draw it on. The scale is fixed 0→ceiling now
 * and the reservation is a BAND from the origin to the floor, so raising the reservation grows the
 * band and shrinks the free segment while the track itself stays put. The floor is still a hard
 * clamp — it moved from the input's `min` attribute to the window's input handler.
 */
export const STAT_POOL = {
  default: 60,
  scaleMin: 0,
  ceiling: 90,
  ticks: [
    { value: 50, hintKey: "GoonFactory.PoolTick.50" },
    { value: 60, hintKey: "GoonFactory.PoolTick.60" },
    { value: 70, hintKey: "GoonFactory.PoolTick.70" },
    { value: 75, hintKey: "GoonFactory.PoolTick.75" },
    { value: 80, hintKey: "GoonFactory.PoolTick.80" },
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

/**
 * §1: default 40 — the book's own career pool, which is also `BOOK_CAREER_POOL` in tables.js.
 * `scaleMin`/`scaleMax` are the TRACK's fixed ends, for the same reason `STAT_POOL.scaleMin` exists:
 * the reserved band is drawn from the origin to the floor, so the origin cannot BE the floor.
 */
export const SKILL_POINTS = { default: 40, scaleMin: 0, scaleMax: 80 };

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

/**
 * §1: free entry, **cap 12**, visible clamp. The cap is also the materializer's own.
 *
 * ⭐ THE DEFAULT IS 1 (ruled 2026-08-14, superseding §1's provisional "6?"): this is only the value a
 * user who has never typed one sees. From the first entry onward the window remembers what the GM
 * last asked for (a client-scoped store, see npcgen-app.js), so the default is the floor of the
 * behaviour rather than a number anybody has to correct on every open.
 */
export const COUNT = { default: 1, min: 1, cap: 12 };

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

/**
 * ⛔ `ROLE_RANDOM` DRAWS NO SOLO BONUS, AND THAT IS THE RULING, NOT AN OVERSIGHT (2026-08-15).
 * `role === "solo"` is simply false for the sentinel, so a Random batch derives the grade's base
 * count — and because NOTHING re-derives the count per goon (the plan carries `config.chromeCount`
 * straight through to `planChrome`), the number the window DISPLAYS is the number every goon in the
 * batch actually gets, including the ones that roll Solo. A per-goon bump here would make the
 * displayed count a lie for part of the squad, which is the one thing the readout may not be.
 */
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
  roleShaped: "GoonFactory.Shape.RoleShaped",
  loose: "GoonFactory.Shape.Loose",
  pureRandom: "GoonFactory.Shape.PureRandom",
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
// CARRIED CASH & CONSUMABLES — the dial formerly displayed as "Loot" (§1 "Loot dial")
// =================================================================================================

/**
 * ⛔⛔ THE DIAL NEVER FILTERS GEAR. This is a stated design invariant (ruled 2026-08-14, and written
 * into GOON-FACTORY-SPEC.md §0): weapons, armor and chrome are generated by the THREAT LEVEL and are
 * present at every dial setting including `off`. What the dial controls is what a goon is CARRYING
 * to spend or use — pocket cash on a credchip and spare magazines — which is why its displayed name
 * is now "carried cash & consumables".
 *
 * The reasoning, recorded because it reverses the older reading: everything on a goon is loot the
 * moment a GM lets the table sell it, so a dial that gated gear would be gating the goon's own
 * threat level. The honest affordance is DISCLOSURE, not a gate — see `salvageEstimate` below, which
 * is what the preview prints regardless of the dial.
 *
 * ⚑ THE STORED KEY IS UNCHANGED (`loot`, `LOOT_DIAL`, `lootProfileFor`, the config field and the
 * plan row): this was a display rename, so no world data and no actor flag has to migrate.
 *
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
  off: "GoonFactory.Loot.Off", scarce: "GoonFactory.Loot.Scarce",
  standard: "GoonFactory.Loot.Standard", generous: "GoonFactory.Loot.Generous",
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

/**
 * THE SALVAGE DISCLOSURE (ruled 2026-08-14, the same sitting as the rename above).
 *
 * ⭐ WHAT IT IS FOR. The dial cannot gate gear, so the preview says out loud what the squad is worth
 * on the street: the summed catalog value of the WEAPONS, ARMOR and CHROME the plan actually pulled.
 * It is printed at every dial setting, `off` included — a GM who turns carried cash off has not made
 * the squad unlootable and should not be able to believe they have.
 *
 * ⛔ WHAT IT DELIBERATELY LEAVES OUT: the credchip and the spare magazines. Those ARE the dial, and
 * counting them here would fold the dial's own output back into the line that exists to say the dial
 * is not the whole story.
 *
 * ⚑ THE ROUNDING, stated rather than hidden behind a "~": the sum is rounded to the nearest 10 below
 * 1,000 eb and to the nearest 100 at or above it, and a non-zero total never rounds down to zero
 * (a squad carrying 4 eb of kit reads as ~10, never as ~0). `exact` is returned beside `rounded`, so
 * nothing has to re-derive the unrounded figure to check the rounded one.
 *
 * PURE: it reads plain plan rows — `{weaponRow:{cost}, armor:{layers:[{cost}]},
 * chrome:{items:[{cost}], bonusItems:[{cost}]}}` — and touches no document.
 */
export function salvageEstimate(rows) {
  let exact = 0;
  for (const row of rows ?? []) {
    exact += Number(row?.weaponRow?.cost) || 0;
    for (const layer of row?.armor?.layers ?? []) exact += Number(layer?.cost) || 0;
    for (const item of row?.chrome?.items ?? []) exact += Number(item?.cost) || 0;
    for (const item of row?.chrome?.bonusItems ?? []) exact += Number(item?.cost) || 0;
  }
  exact = Math.round(exact);
  const step = exact >= 1000 ? 100 : 10;
  const rounded = exact === 0 ? 0 : Math.max(step, Math.round(exact / step) * step);
  return { exact, rounded, step };
}

// =================================================================================================
// ARMOR FILTERS (§1 "Armor filters")
// =================================================================================================

/** §1: Weight Any/Light/Heavy · Hardness Any/Soft/Hard · Armament posture Standard/AP/Chemical. */
export const ARMOR_WEIGHT_FILTERS = ["any", "light", "heavy"];
export const ARMOR_HARDNESS_FILTERS = ["any", "soft", "hard"];
export const ARMAMENT_POSTURES = ["standard", "ap", "chemical"];
export const ARMAMENT_POSTURE_DEFAULT = "standard";
