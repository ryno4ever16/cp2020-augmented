/**
 * NPC GENERATOR — THE TABLES. Pure data, no logic, no Foundry, no i18n.
 *
 * Everything a generated NPC is calibrated against lives here as plain values so a human can read one
 * file and see what a tier IS, and so the pure layer in blueprint.js can be unit-tested with `node`
 * alone. Nothing in this file computes; nothing in this file localizes. Display strings are keys that
 * the render edge localizes (`tryLocalize`, the value-is-key pattern), per §5 "i18n" of the design —
 * the shipped tables stay unit-testable because they hold no localized text.
 *
 * SOURCES, named at every table rather than in one lump, because the tables have DIFFERENT provenance
 * and the differences matter when one of them is later revised:
 *   · `import-staging/NPC-GENERATOR-DESIGN.md` — the ruled design. Section refs below are to it.
 *   · `import-staging/BOOK-POWER-LADDER-EXTRACT.md` — the book text-layer extraction (its own
 *     confidence tags [OCR] / [OCR+CHECKED] / [NATIVE] are carried through to the tables that use it).
 *   · The user's Lorekeeper agent's `Combat Balance Rules of Thumb.md` benchmark, via design §RULINGS,
 *     WITH the two module-math corrections the 2026-08-12 verify gate found (see TIERS).
 *
 * ⛔ THE RTG LINE (design §4). Rules and procedures are implementable; the BOOK'S NPC stat blocks are
 * not content we ship. So: the dice procedures, the point economies, the per-role armor/weapon
 * modifier, and the threat-code AXES are here as mechanics. No book NPC stat block, no book cyberware
 * result table, no book lifepath table, and no book career-skill list is transcribed — the one
 * archetype below is homebrew scaffolding, and the gear it names is named by CATEGORY, resolved from
 * our own packs at materialize time.
 */

// ---------------------------------------------------------------------------------------------
// THE FOUR DIALS
// ---------------------------------------------------------------------------------------------

/**
 * Design §RULINGS "⭐ Synthesis for Q1": the generator's dial set is Skill / Weapons / Armor /
 * Toughness. Three of the four are the Night City Threat CODE's own axes (design §B.1 — "the CODE
 * supplies the dials and the LEVEL supplies the preset vocabulary"); the fourth, Toughness, is the
 * one the Threat Code lacks and the Lorekeeper's BT finding supplies.
 *
 * Every dial is an ORDERED array, weakest first, so "the next rung up" is an index step and a test
 * can assert monotonicity without knowing the vocabulary.
 */

/**
 * SKILL — Night City p.40, "Opponent's Skill" (BOOK-POWER-LADDER-EXTRACT §1.1.3, [OCR+CHECKED]: the
 * axis self-verifies, 2/4/6/8/10 + REF 8 = 10/12/14/16/18 and every row's arithmetic closes).
 *
 * ⭐ WE ADOPT THE SKILL-POINTS HALF ONLY. The book's table assumes a flat REF 8 and prints the
 * resulting roll; we roll real stats (design §B.1: "adopt the skill-POINTS half and let the roll
 * emerge"). `rollAtRef8` is therefore carried as the book's own arithmetic — a calibration reference,
 * NOT something the generator writes anywhere.
 */
export const SKILL_DIAL = [
  { key: "E", weaponSkillPoints: 2,  rollAtRef8: 10, labelKey: "NpcGen.Dial.Skill.E" },
  { key: "D", weaponSkillPoints: 4,  rollAtRef8: 12, labelKey: "NpcGen.Dial.Skill.D" },
  { key: "C", weaponSkillPoints: 6,  rollAtRef8: 14, labelKey: "NpcGen.Dial.Skill.C" },
  { key: "B", weaponSkillPoints: 8,  rollAtRef8: 16, labelKey: "NpcGen.Dial.Skill.B" },
  { key: "A", weaponSkillPoints: 10, rollAtRef8: 18, labelKey: "NpcGen.Dial.Skill.A" }
];

/** The REF the book's skill axis assumes. Recorded so the assumption is visible where it is used. */
export const SKILL_DIAL_ASSUMED_REF = 8;

/**
 * WEAPONS AVAILABILITY — Night City p.40 axis 2 ([OCR]). ⚠ This axis runs INVERTED relative to the
 * letter axes: rung 1 is the best. The array is still ordered weakest-first, so `rung` descends as the
 * index rises; a test asserts that rather than assuming it.
 *
 * `shop` is OUR mapping from the book's prose rung onto the module's shop taxonomy
 * (`module/shop/categories.js` CATEGORIES) — it is how a loadout slot gets filled without naming a
 * single book item. The prose is quoted so a maintainer can check the mapping against its source.
 */
export const WEAPONS_DIAL = [
  { rung: 5, prose: "Bare hands, improvised weapons.",                          shop: [] },
  { rung: 4, prose: "Melee weapons, small pistols.",                            shop: [{ category: "Weapons", sub: "Melee" }, { category: "Weapons", sub: "Pistols" }] },
  { rung: 3, prose: "Large handguns, bolt-action rifles, etc.",                  shop: [{ category: "Weapons", sub: "Pistols" }, { category: "Weapons", sub: "Rifles" }] },
  { rung: 2, prose: "Automatic weapons.",                                        shop: [{ category: "Weapons", sub: "SMGs" }, { category: "Weapons", sub: "Shotguns" }] },
  { rung: 1, prose: "Assault weapons, exotic weaponry (monoblades, lasers, etc.)", shop: [{ category: "Weapons", sub: "Rifles" }, { category: "Weapons", sub: "Heavy" }, { category: "Weapons", sub: "Exotic" }] }
];

/**
 * ARMOR AVAILABLE — Night City p.40 axis 3 ([OCR], SINGLE CHANNEL).
 *
 * ⚠⚠ TWO STANDING FLAGS, both from the extract, both deliberately UNRESOLVED here:
 *  1. **Bands C and D overlap at SP 10 as printed** ("SP 4-10" and "SP 10-20"). The extract flags this
 *     as a coherence defect and explicitly does NOT correct it; neither do we. `overlapsPrevious`
 *     marks the band that carries the defect so a UI can say so out loud instead of a silent fix.
 *  2. BOOK-POWER-LADDER-EXTRACT §4.1 rates this whole block "HIGHEST PRIORITY — eye-confirm before
 *     hard-coding": the numerals want the user's eyes. SP 25 itself is [OCR+CHECKED] three further
 *     ways (Core p.67 table, Core p.67 prose, Maximum Metal p.63); the BAND BOUNDARIES are not.
 *     ⛔ These band numbers are therefore ADVISORY INPUT, never a cap, and never a validator.
 */
export const ARMOR_DIAL = [
  { key: "E", spMin: 0,  spMax: 3,  prose: "Normal clothing (SP 0-3)",              overlapsPrevious: false, labelKey: "NpcGen.Dial.Armor.E" },
  { key: "D", spMin: 4,  spMax: 10, prose: "Leather to keviar vest (SP 4-10)",      overlapsPrevious: false, labelKey: "NpcGen.Dial.Armor.D" },
  { key: "C", spMin: 10, spMax: 20, prose: "Light armor jack to heavy armor (SP 10-20)", overlapsPrevious: true, labelKey: "NpcGen.Dial.Armor.C" },
  { key: "B", spMin: 25, spMax: 25, prose: "Door gunner to Metal Gear (SP 25)",     overlapsPrevious: false, labelKey: "NpcGen.Dial.Armor.B" },
  { key: "A", spMin: 30, spMax: 30, prose: "Power-assisted Armor (SP 30)",          overlapsPrevious: false, labelKey: "NpcGen.Dial.Armor.A" }
];

/**
 * TOUGHNESS — ⭐ THE DIAL THE THREAT CODE LACKS. Design §RULINGS: *"BT is the drop dial, not SP …
 * raising SP makes cliffs, raising BT makes endurance — the LUYPS anti-escalation principle"*, and
 * *"BT/Toughness is the fourth dial the Night City Threat Code lacks"*.
 *
 * The rungs are the Lorekeeper benchmark's four BT values, so the dial and the tier presets agree by
 * construction rather than by coincidence. `stunFailFirstWoundPct` is the CORRECTED module formula
 * (see TIERS, correction B) evaluated at the first wound, where woundPenalty = 0:
 *   fail% = (10 − BT + woundPenalty) × 10  ⇒  BT 5 → 50, BT 7 → 30, BT 9 → 10, BT 10 → 0.
 * It is stored as a value, not computed, because this file holds no logic.
 */
export const TOUGHNESS_DIAL = [
  { key: "bt5",  bt: 5,  stunFailFirstWoundPct: 50, labelKey: "NpcGen.Dial.Toughness.Bt5" },
  { key: "bt7",  bt: 7,  stunFailFirstWoundPct: 30, labelKey: "NpcGen.Dial.Toughness.Bt7" },
  { key: "bt9",  bt: 9,  stunFailFirstWoundPct: 10, labelKey: "NpcGen.Dial.Toughness.Bt9" },
  { key: "bt10", bt: 10, stunFailFirstWoundPct: 0,  labelKey: "NpcGen.Dial.Toughness.Bt10" }
];

// ---------------------------------------------------------------------------------------------
// THE FOUR TIER PRESETS
// ---------------------------------------------------------------------------------------------

/**
 * ⭐ THE CALIBRATION, AND WHOSE IT IS. `benchmark` is the user's Lorekeeper agent's 4-tier row set —
 * a 60k-trial Monte Carlo of the full damage pipeline against their live party (design §RULINGS,
 * "LOREKEEPER INPUT FOUND AND READ"). It is NOT a book NPC stat block and NOT invented by me: it is a
 * balance measurement, which is exactly the material the RTG line (design §4) leaves usable.
 *
 * ⚠ TWO CORRECTIONS APPLIED, from the 2026-08-12 math-verify gate (design §RULINGS, "MATH-VERIFY GATE
 * SATISFIED"). The presets bake against the MODULE's math, because the module is the runtime:
 *   A. **Sever / head-kill is net damage > 8** (i.e. 9+), per `DamageApplicator.js:171,216`
 *      (Core p.103-cited) — NOT the "8+" the Lorekeeper card says. `SEVER_NET_DAMAGE_MIN = 9`.
 *      Consequence carried into the rows: a 2d6+1 average of 8 sits exactly UNDER the line, so the
 *      MOOK's weapon is not the amputator the card's example calls it.
 *   B. **Stun-save fail% = (10 − BT + woundPenalty) × 10**, per the RAW "equal to or lower than"
 *      save (`save-rolls.js:15,359`, `roll ≤ threshold` saves) — NOT (11 − BT) × 10. Every tier is
 *      one rung sturdier than the card suggests. Carried as `stunFailFirstWoundPct`.
 *
 * The `build` half is the generator's own parameters. Where the design left a number open I chose one
 * and said so at the field — every ⚑ below is a decision of mine, not a ruling.
 */

/** Correction A, as a constant, so the number lives in exactly one place. */
export const SEVER_NET_DAMAGE_MIN = 9;

/** Correction B's base term: fail% = (STUN_FAIL_BASE − BT + woundPenalty) × 10. */
export const STUN_FAIL_BASE = 10;

/**
 * Design §RULINGS decision 1: hit% = (REF + skill + WA − 4) × 10 at Close range, capped at 90 (the
 * cap is the natural-1 fumble, not a ceiling on competence). Carried as data for the preview UI to
 * show the GM what a tier is worth; nothing in the pure layer rolls attacks.
 */
export const HIT_PCT = { subtrahend: 4, perPoint: 10, cap: 90 };

/**
 * The book's own point economy (Core p.29 + p.43-45, design §4 "RULES"): 40 points across the role's
 * career skills, one of which must be the Special Ability; pickup pool = REF + INT; an "advanced NPC"
 * gets +2D10 spread over 5 pickup skills. The 40 is the anchor the tier ladder scales around.
 */
export const BOOK_CAREER_POOL = 40;
export const ADVANCED_NPC_BONUS = { dice: 2, sides: 10, overSkills: 5 };

/** Book character-creation ceiling for a skill level. A floor or a spend never exceeds it. */
export const SKILL_MAX_LEVEL = 10;

export const TIERS = [
  {
    key: "mook",
    labelKey: "NpcGen.Tier.Mook",
    // The Lorekeeper row, verbatim in value.
    benchmark: { atk: 8,  damage: "2d6+1", sp: 4,  armorKind: "soft",      bt: 5 },
    stunFailFirstWoundPct: 50,          // (10 − 5 + 0) × 10 — correction B
    dials: { skill: "E", weapons: 3, armor: "D", toughness: "bt5" },
    build: {
      careerPool: 30,                   // ⚑ mine: the book's 40 anchors VETERAN; ±10 per rung (design Q11B says only "Mook < 40")
      weaponSkillPoints: 2,             // = SKILL_DIAL "E"
      cyberwareRollsDelta: 0,           // ⚑ mine: design gives no per-tier chrome delta
      armorWeaponRollModifier: 0,       // ⚑ mine: the tier's own delta, ON TOP of the book's per-role modifier
      advancedNpc: false,
      loadoutBudgetEb: 500              // ⚑ mine: a starting shape for the slot filler; needs the pool-algorithm session (design Q3, OWED)
    }
  },
  {
    key: "veteran",
    labelKey: "NpcGen.Tier.Veteran",
    benchmark: { atk: 10, damage: "2d6+3", sp: 10, armorKind: "soft",      bt: 7 },
    stunFailFirstWoundPct: 30,          // (10 − 7 + 0) × 10
    // ⚠ SP 10 is exactly the printed C/D band overlap (ARMOR_DIAL). Assigned to D — the top of D —
    // and flagged rather than silently disambiguated. The user's eyes settle it (extract §4.1).
    dials: { skill: "D", weapons: 2, armor: "D", toughness: "bt7" },
    build: {
      careerPool: 40,                   // the BOOK's number, unmodified — this rung is the anchor
      weaponSkillPoints: 4,
      cyberwareRollsDelta: 1,
      armorWeaponRollModifier: 1,
      advancedNpc: false,
      loadoutBudgetEb: 1500
    }
  },
  {
    key: "elite",
    labelKey: "NpcGen.Tier.Elite",
    benchmark: { atk: 12, damage: "3d6",   sp: 12, armorKind: "skinweave", bt: 9 },
    stunFailFirstWoundPct: 10,          // (10 − 9 + 0) × 10
    dials: { skill: "C", weapons: 2, armor: "C", toughness: "bt9" },
    build: {
      careerPool: 50,
      weaponSkillPoints: 6,
      cyberwareRollsDelta: 2,
      armorWeaponRollModifier: 2,
      advancedNpc: true,                // ⚑ mine: the book's "advanced NPC" step lands at the top two rungs
      loadoutBudgetEb: 5000
    }
  },
  {
    key: "heavy",
    labelKey: "NpcGen.Tier.Heavy",
    benchmark: { atk: 14, damage: "4d6",   sp: 18, armorKind: "hard",      bt: 10 },
    stunFailFirstWoundPct: 0,           // (10 − 10 + 0) × 10 — a BT 10 NPC never fails a first-wound stun save
    // ⚠ TWO honest mismatches between the two calibrations, recorded rather than papered over:
    //  · armor rung C is shared with ELITE — the Lorekeeper ladder tops out at SP 18 and never
    //    reaches the book's band B (SP 25). The ladder simply does not span that far.
    //  · weapons rung 2 is shared with ELITE/VETERAN — a 4d6 benchmark is a heavy SMG, the TOP of the
    //    book's rung 2. Rung 1 (assault weapons) is above anything the benchmark measured.
    // The dials stay free (design §B.2: mismatched combos are book-legal by demonstration), so a GM
    // who wants an assault-armed heavy moves the dial; the PRESET does not claim a rung its source
    // never measured.
    dials: { skill: "B", weapons: 2, armor: "C", toughness: "bt10" },
    build: {
      careerPool: 60,
      weaponSkillPoints: 8,
      cyberwareRollsDelta: 3,
      armorWeaponRollModifier: 3,
      advancedNpc: true,
      loadoutBudgetEb: 15000
    }
  }
];

// ---------------------------------------------------------------------------------------------
// ARMOR BREAKPOINT ADVISORIES
// ---------------------------------------------------------------------------------------------

/**
 * ⛔ INFORMATIONAL, NEVER A CAP. Design §RULINGS "NO ceiling": *"Anything from a street goon to an
 * army of Adam Smashers"* — but *"the tool must inform GMs of power breakpoints"*. So this table is
 * read out to the GM as the armor dial climbs and constrains nothing.
 *
 * The thresholds and their meanings are design §A ("Generator consequence"), which derives them from
 * the all-or-nothing damage rule (Core p.101, [OCR+CHECKED]) against the weapon classes in
 * BOOK-POWER-LADDER-EXTRACT §2.7 ([NATIVE], the Data Screen weapons list):
 *   · SP 18 — heavy-pistol-proof (3D6 maxes at 18; a max roll passes zero)
 *   · SP 20 — SMG/shotgun-proof
 *   · SP 25 — small-arms-proof. The whole pistol and SMG class can NEVER hurt this target with
 *     standard ammo — arithmetically never, not rarely. 5D6 exceeds 25 on 126/7776 rolls ≈ 1.6%.
 *     The party needs AP, heavy weapons, or mono/edged, or the fight is unwinnable. This is the
 *     Lorekeeper's "immunity cliff" and the design's ARMOR GATE, at the same number.
 *   · SP 30 — powered-armor tier, not human-wearable (Maximum Metal p.63: SP 25 = 36 kg, SP 30 =
 *     150 kg; the SoF2 Viper at SP 30 needs a linear frame).
 *
 * `maxSp: null` = open-ended. Ordered ascending; a value crosses every entry at or below it.
 */
export const ARMOR_BREAKPOINTS = [
  { key: "heavyPistolProof", minSp: 18, maxSp: 19,   messageKey: "NpcGen.Advisory.HeavyPistolProof" },
  { key: "smallArmsHard",    minSp: 20, maxSp: 24,   messageKey: "NpcGen.Advisory.SmallArmsHard" },
  { key: "immunityCliff",    minSp: 25, maxSp: 29,   messageKey: "NpcGen.Advisory.ImmunityCliff" },
  { key: "poweredArmorTier", minSp: 30, maxSp: null, messageKey: "NpcGen.Advisory.PoweredArmorTier" }
];

// ---------------------------------------------------------------------------------------------
// THE BOOK'S ARMOR + WEAPON ROLL, PER-ROLE MODIFIER
// ---------------------------------------------------------------------------------------------

/**
 * Core p.29, Fast Character System (design §4 "RULES", listed there explicitly as MECHANICS —
 * *"a modifier table of eight numbers attached to a die roll"*): 1D10 + role modifier, read against
 * the armor & weapon table. Rocker/Corp/Netrunner/Fixer/Techie +0 · Nomad/Cop +2 · Solo +3.
 *
 * ⚠ The book's list as extracted names EIGHT roles; the system's `system.role.value` enum has TEN
 * (`template.json:676-690` — the two unlisted are `media` and `medtechie`). Rather than invent a
 * modifier for a role the book's list does not cover, both default to +0 and are marked `inBook:
 * false` so the UI can say the number is ours, not the book's. ⚑ Mine; a book re-read could settle it.
 *
 * The RESULT TABLE the roll reads against is book CONTENT and is deliberately absent (design §4:
 * *"the armor & weapon result table's specific gear picks"* → our packs, filtered by category and a
 * tier budget). This table is the modifier only.
 */
export const ARMOR_WEAPON_ROLE_MODIFIERS = {
  rocker:    { mod: 0, inBook: true },
  corp:      { mod: 0, inBook: true },
  netrunner: { mod: 0, inBook: true },
  fixer:     { mod: 0, inBook: true },
  techie:    { mod: 0, inBook: true },
  nomad:     { mod: 2, inBook: true },
  cop:       { mod: 2, inBook: true },
  solo:      { mod: 3, inBook: true },
  media:     { mod: 0, inBook: false },
  medtechie: { mod: 0, inBook: false }
};

/**
 * The legal `system.role.value` values, restated here ONLY so the pure layer can validate without a
 * live Foundry. ⚠ The SOURCE OF TRUTH is the system schema (`template.json:676-690` /
 * `module/data/actor-data.js:24-27`); the impure layer should read it from there and this list exists
 * for the unit tests. Design §Step 7 is explicit that the generator reads the enum from the schema.
 */
export const ROLE_ENUM = ["solo", "rocker", "netrunner", "media", "nomad", "fixer", "cop", "corp", "techie", "medtechie"];

/**
 * The book's cyberware count procedure (Core p.29, design §4 "RULES"): 1D10 rolls — Solos roll 6×,
 * everyone else 3× — rerolling duplicates. The COUNT is the rule; the RESULT TABLES are book content
 * and are not here (picks come from our packs via the shop catalog index, at materialize time).
 */
export const CYBERWARE_ROLLS = { solo: 6, default: 3, dieSides: 10 };

// ---------------------------------------------------------------------------------------------
// ARCHETYPES
// ---------------------------------------------------------------------------------------------

/**
 * ⛔⛔ EXACTLY ONE ARCHETYPE, AND IT IS SCAFFOLDING. User ruling 2026-08-13: no archetype vocabulary
 * is to be invented. "Goon" exists so the machinery below it is exercisable and testable — the REAL
 * starter set is user-supplied later (design §RULINGS Q2: *"Starter set: user will provide … Do not
 * invent one meanwhile"*). Do not add a second archetype here without that list in hand.
 *
 * ⭐ THE SHAPE IS A STACKABLE MODIFIER, not a flat profile. Design §RULINGS Q2: *"A mix of both axes
 * — think of them like MODIFIERS you can add"*. So every field composes:
 *   · `statWeights` / `skillWeights` — numeric maps, ADD when stacked
 *   · `loadoutSlots` — CONCATENATE
 *   · `cyberware.subs` — UNION
 *   · `role`, `primaryWeaponSkill`, `specialAbilitySkill`, `cyberwareRollsOverride` — LAST WINS
 * `blueprint.mergeArchetypes()` is the one place that composition is implemented.
 *
 * Skills are named by the system's own STABLE SCHEMA KEYS (`template.json` skills template — e.g.
 * `Handgun`, `AwarenessNotice`, `CombatSense`), never by an English display name: design §Step 4's
 * i18n hazard is that a hand-typed skill name only matches in an English world. Resolving a key to
 * the actual granted skill item is the impure layer's job (and design R2 flags it as a live rig
 * unknown — the base `_preCreate` does not `keepId`, so compendium ids will not match).
 *
 * Gear is named by CATEGORY, never by item id: design §Q3C, the hybrid — the slot is the recipe, the
 * item is a procedural pick from the shop catalog index within budget. That is also what keeps this
 * file clear of the book's gear tables.
 */
export const ARCHETYPES = {
  goon: {
    key: "goon",
    labelKey: "NpcGen.Archetype.Goon",

    /**
     * ⛔ PLACEHOLDER ARCHETYPE — scaffolding only, per the 2026-08-13 ruling. Its weights and slots
     * are a working example of the SHAPE, not a curated character type, and they are expected to be
     * replaced wholesale by the user's starter set.
     */
    placeholder: true,

    /**
     * Which legal enum entry this writes to `system.role.value` (design §Q2C: the archetype is the
     * generator's unit, the ROLE is what it writes; the archetype name rides the actor name and a
     * module flag, never the enum field). Design's own worked example maps Ganger → solo.
     */
    role: "solo",

    /** The book's "one career skill must be the Special Ability" — the Solo's is Combat Sense. */
    specialAbilitySkill: "CombatSense",

    /** Which skill the tier's Skill dial floors. The Skill dial is a WEAPON-skill axis in the book. */
    primaryWeaponSkill: "Handgun",

    /**
     * ⚠ The book keys the cyberware count off the ROLE (Solo 6×, others 3×), and this archetype writes
     * `solo` — which would hand a street goon a Solo's six implants. Overridden to the ordinary 3
     * because the enum value here is a SCHEMA choice, not a claim that this NPC is a Solo. Recorded
     * loudly because it is the first place the archetype-vs-role split (design §Q2C) actually bites.
     */
    cyberwareRollsOverride: 3,

    /**
     * STAT WEIGHTS (design §RULINGS Q11: *"Archetypes carry skill AND stat WEIGHTS to roll values
     * that align with the character type"*). Higher weight = this archetype wants its better rolls
     * here. ⚑ These weights do NOT add points: `blueprint.weightStats` re-assigns the SAME rolled
     * multiset, so book stat legality is preserved exactly. Nine stats, matching `template.json:7-46`.
     */
    statWeights: { ref: 9, bt: 8, cool: 6, ma: 5, int: 4, tech: 3, luck: 3, attr: 2, emp: 1 },

    /**
     * SKILL WEIGHTS over the archetype's career list. The list is OURS — design §4 rules the book's
     * printed per-role ten as "genuinely gray" and recommends authoring our own kits informed by the
     * logic (a fighter needs combat skills) without transcribing the printed lists.
     */
    skillWeights: {
      Handgun: 9,
      Brawling: 6,
      AwarenessNotice: 6,
      Streetwise: 5,
      DodgeEscape: 4,
      Melee: 3,
      Athletics: 3,
      Intimidate: 3,
      Stealth: 2,
      CombatSense: 2
    },

    /**
     * LOADOUT SLOTS — a category recipe (design §Q3C). `min`/`max` bound how many the filler creates;
     * `weaponsDial: true` means the slot's category comes from the WEAPONS dial rung rather than being
     * fixed here, so moving that dial actually changes what the NPC carries.
     */
    loadoutSlots: [
      { slot: "primary", weaponsDial: true, min: 1, max: 1, budgetShare: 0.5 },
      { slot: "sidearm", category: "Weapons", sub: "Pistols", min: 0, max: 1, budgetShare: 0.2 },
      { slot: "armor",   category: "Armor",   sub: null,      min: 1, max: 1, budgetShare: 0.3, armorDial: true },
      { slot: "melee",   category: "Weapons", sub: "Melee",   min: 0, max: 1, budgetShare: 0.1 }
    ],

    /**
     * CYBERWARE PROFILE — which shop sub-categories this archetype's chrome may be drawn from
     * (`module/shop/categories.js` CATEGORIES → Cyberware subs). The COUNT comes from the book
     * procedure; the PICKS come from our packs. FBC is off: design §Q12a rules the borg tier a
     * separate architectural question, not a cyberware-count roll.
     */
    cyberware: {
      subs: ["Cyberoptics", "Cyberaudio", "Fashionware", "Implants", "Cyberweapons", "Neuralware"],
      allowFbc: false
    }
  }
};

// ---------------------------------------------------------------------------------------------
// NAMES
// ---------------------------------------------------------------------------------------------

/**
 * ⛔⛔⛔ SHIP BLOCKER — PLACEHOLDER NAMES MUST BE REPLACED BY HUMAN-CREATED LISTS BEFORE ANY RELEASE.
 * (User ruling 2026-08-13; memory `feedback-npcgen-placeholder-names-blocker`.)
 *
 * ⛔ HARD RULE, design §RULINGS Q4, verbatim: *"You are strictly not to generate any names for this
 * list. We will source a list of human created names either from the internet, or myself."*
 *
 * So there is no name GENERATOR here and there must not be one. What ships today is a SEQUENCE:
 * "Goon 1", "Goon 2", … — an index, not a name. It exists so N generated actors have N distinct
 * document names and the machinery is testable. A release that still produces these is a release
 * that shipped a placeholder as a feature.
 *
 * Note the value is a bare English string BY DESIGN, not an i18n key: design §5 i18n —
 * *"generated actor names are not localized"* (they are persisted document data, per
 * `reference-tilt-way-patterns.md` "Created-document NAMES stay English").
 */
export const PLACEHOLDER_NAME_PREFIX = "Goon";

/** The scheme: `${prefix} ${n}`, n starting at 1. Implemented by `blueprint.placeholderName`. */
export const PLACEHOLDER_NAME_START = 1;

// ---------------------------------------------------------------------------------------------
// LOOKUP HELPERS' DATA (still pure data — index maps, not logic)
// ---------------------------------------------------------------------------------------------

/** key → row, for each dial and the tier list. Built once from the arrays above; no computation. */
export const SKILL_DIAL_BY_KEY = Object.fromEntries(SKILL_DIAL.map((r) => [r.key, r]));
export const ARMOR_DIAL_BY_KEY = Object.fromEntries(ARMOR_DIAL.map((r) => [r.key, r]));
export const TOUGHNESS_DIAL_BY_KEY = Object.fromEntries(TOUGHNESS_DIAL.map((r) => [r.key, r]));
export const WEAPONS_DIAL_BY_RUNG = Object.fromEntries(WEAPONS_DIAL.map((r) => [r.rung, r]));
export const TIERS_BY_KEY = Object.fromEntries(TIERS.map((r) => [r.key, r]));
