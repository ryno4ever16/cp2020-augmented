/**
 * GOON FACTORY — THE CHROME SLOT TABLE (GOON-FACTORY-SPEC.md §3 `Slot`).
 *
 * Pure data. No Foundry, no i18n, no logic beyond three tiny lookups at the bottom.
 *
 * ⭐ WHAT A SLOT IS, AND WHY IT IS NOT A LIST OF ITEMS. §3 is explicit that chrome is
 * **housings + options + prerequisites** — an optic option mounts IN a Cyberoptic, audio in a
 * Cyberaudio, limb options on a limb; a chip needs a Neuralware Processor plus EITHER Interface
 * Plugs OR a Chipware Socket (book p.82: two installations, either interface serves). So a slot
 * declares a COMPOUND PULL, and `chrome.js` resolves it. §3's own words: *"The engine MUST support
 * this from day one."*
 *
 * ⭐ CRITERIA FIRST, ALLOW-LIST SECOND, AND BOTH ARE REAL. §3: *"Curation session curates CRITERIA,
 * not items."* — so every slot carries machine-readable `criteria` the curation session will edit.
 * But v1's pools are the CHROME-CRITERIA-DRAFT's already-resolved base-pack items, so each slot also
 * carries an `allow` list of those exact names. `chrome.js` filters by criteria and, when `allow` is
 * non-empty, intersects with it. The curation session widens a pool by emptying an `allow`, not by
 * rewriting an engine.
 *
 * ⛔ EVERY NAME IN AN `allow` LIST IS A REAL ENTRY IN A LOADED PACK, verified by reading the pack
 * sources on 2026-08-14 (`systems/cyberpunk2020/packs/*.db`). Note the packs' own OCR spellings are
 * preserved verbatim where they are wrong — `Submachlnegun`, `Weaponsmlth` — because the name is the
 * match key and "correcting" it here would silently empty the pool. (Flagged, not patched: the
 * standing no-mass-patching ruling on pack data.)
 *
 * ⛔ EXCLUDED BY RULING, recorded so a later reader does not "fix" the omission:
 *  · `cyberware-old.db` (349 legacy items) — ⚖7, the unsorted legacy pile.
 *  · the module's 77 blank-type cyberware — CHROME-COMB-77.md's verdicts are pending the user's
 *    taste calls; the comb's §4 BUILD QUESTIONS shaped this engine (digit budgets, partial coverage,
 *    two-price items, nested compounds all have a declared seam below) but **no comb item is wired**.
 *  · Dartgun and Digital Camera eyes — ⚖1, ruled OUT of combat optics on the space economics.
 *  · Pain Editor — ⚖3, OUT until the data mechanizes it (`Type: Descriptive`, empty Checks).
 *  · wardrobe/`fashion.db` — ⚖9, that is CLOTHING and belongs to outfits + the fashion system.
 */

import { GRADE_KEYS, gradeMeets } from "./grades.js";

// =================================================================================================
// HOUSINGS, SPACES, AND THE DENY LIST
// =================================================================================================

/**
 * ENGINE RULE 1 (§3, audit pass 2026-08-13): **option SPACES, not option counts.** Housings carry
 * space budgets and options carry space costs, so the criteria draft's "1 option @C · 2 @B · 3 @A"
 * counts are only space-safe for 1-space options. These are the printed budgets, and the pack data
 * carries the same values in `CyberWorkType.OptionsAvailable` — this table is the fallback for a
 * pool row whose index fields did not travel.
 */
export const HOUSING_SPACES = {
  "Cyberoptic": 4,
  "Cyberaudio": 6,
  "Standard Cyberarm": 4,
  "Standard Cyberleg": 3,
};

/**
 * ⛔ NEVER PULLABLE. CHROME-COMB-77.md DATA FLAG 9: *Full Borg: Increased Stats* is priced 2000 eb,
 * charges 2 humanity, carries no stat delta, and its own note says it *"carries no bonus of its
 * own"* — an equippable, humanity-charging no-op. The comb's instruction is to deny-list it in any
 * criteria set, and this is that list.
 */
export const CHROME_DENY_NAMES = ["Full Borg: Increased Stats"];

/**
 * ENGINE RULE 2 (§3): **exclusivity classes**, declared as slot metadata rather than hard-coded in
 * the puller. `boosterware` is p.81 verbatim (*"you may only select ONE type of boosterware"*);
 * `headArmor` is the one-head-armor rule (helmet XOR cowl/faceplate) the chrome audit added and the
 * armor draft carried across both systems; `limbCovering` is p.90's data-level per-limb exclusivity.
 */
export const EXCLUSIVITY_CLASSES = ["boosterware", "headArmor", "limbCovering"];

/**
 * ENGINE RULE 3 (§3): **dependent deals** — a pull whose legality depends on something ELSE the goon
 * has. Declared here, enforced in `chrome.js`.
 *
 * `targetingScope`: p.86, *"+1 ONLY to smartgun attacks"* — the scope is dead weight without the
 * full stack (Processor + Plugs + Link + a converted weapon), so it is never drawn alone.
 * `smartWeaponConversion`: p.82, *"the cost of adapting a normal gun to smartgun configuration is
 * TWICE the normal cost of the gun"* — carried as a real multiplier so a generated smart loadout is
 * priced honestly.
 * `popupGun`: p.91, size is BODY-TYPE limited — the class reads the BT slider (see `popupClassForBt`).
 */
export const DEPENDENT_DEALS = {
  targetingScope: { item: "Targeting Scope", requires: "smartgunStack" },
  smartWeaponConversion: { costMultiplier: 2 },
  popupGun: { item: "Popup Gun", requires: "btBand", ammo: "caseless" },
};

/**
 * p.91's printed body-type bands for a popup gun's size class. CP2020's own BODY bands:
 * 2 Very Weak · 3–4 Weak · 5–7 Average · 8–9 Strong · 10 Very Strong. The p.91 rule groups them
 * V.Weak–Weak / Average–Strong / Very Strong, which is exactly the three rungs below.
 * ⚖12 (ruled): the BT-10 popup shotgun is IN when the slider earns it — that is this function
 * returning `heavyPistol` at BT 10, which is the rung the shotgun option sits on.
 */
export function popupClassForBt(bt) {
  const b = Math.trunc(Number(bt) || 0);
  if (b <= 4) return "lightPistol";
  if (b <= 9) return "mediumPistol";
  return "heavyPistol";
}

/**
 * ENGINE RULE 4 (§3): **side-effect items** — a pull that writes something other than an item.
 *
 * `attrDebit` is the skinweave ladder's printed ATTR cost (Chromebook 2 via the bioware pack:
 * SP14 = −1 ATTR, SP16 = −2 ATTR), plus the plating class the second audit round ruled eligible.
 * ⛔ Applying one is a STAT WRITE, which means the whole-object rule (`feedback-datamodel-partial-
 * updates`): the materializer sends the COMPLETE stats object, never a dotted `system.stats.attr`.
 *
 * `needsAmmoItem` names the launchers that arrive useless without a magazine: the ammo pipeline has
 * to supply them or the goon carries an empty tube, and the preview says so.
 */
export const SIDE_EFFECTS = {
  attrDebit: {
    "Upgraded Skinweave SP14": -1,
    "Upgraded Skinweave SP16": -2,
    "Skinweave SP14": -1,          // defensive alias: the same item under its un-prefixed name
    "Skinweave SP16": -2,
    "Faceplate": -1,
    "Cowl": -1,
  },
  needsAmmoItem: ["Micro-missile Launcher", "Grenade Launcher", "Popup Gun"],
  caselessOnly: ["Popup Gun"],
};

/**
 * ⚠ SEAMS THE COMB'S §4 BUILD QUESTIONS REQUIRE, DECLARED BUT NOT USED IN v1.
 *
 * These exist so the four deferred item classes can be added later WITHOUT reworking `chrome.js`:
 * the engine already reads these fields and simply finds nothing declaring them.
 *  · `digitBudget` — cyberfingers consume a DIGIT, not an arm option space (comb Q1).
 *  · `coverageChance` — the cyberfacial remounts print a 15/25/50% chance-to-be-hit, which our
 *    layering math models by zone, not sub-zone probability (comb Q2).
 *  · `costVariants` — one record, two prices (BigRipp meat-mount 1200 / cyberlimb 850), or a delta
 *    on a parent (`"+1D6/2"`), or a range (comb Q5).
 *  · `nestedOptions` — an option that itself takes options (Vidcam Cyberfinger); the base `Module`
 *    model is single-level (comb Q4).
 * A slot or a pool row may carry any of them; nothing in v1 does.
 */
export const DEFERRED_ITEM_SEAMS = ["digitBudget", "coverageChance", "costVariants", "nestedOptions"];

/** The per-hand digit budget a `digitBudget` item would draw on when that class is wired. */
export const DIGITS_PER_HAND = 5;

// =================================================================================================
// THE ELEVEN SLOTS
// =================================================================================================

/**
 * ⭐ PULL WEIGHTS are FADE-derived (CHROME-CRITERIA-DRAFT "Pull mechanics"): hand weapons heavy,
 * optics/audio/arm-gun medium, boost lower, and "Nothing" holds one share at grade C and below.
 * They are relative shares within the goon's UNLOCKED slots, so a gate change re-normalizes them
 * automatically and no weight has to be re-tuned when the ladder moves.
 */
export const NOTHING_WEIGHT = 1;

export const CHROME_SLOTS = [
  {
    id: "skillChips",
    labelKey: "CYBERPUNK.GoonFactory.Slot.SkillChips",
    gradeGate: "D",
    weight: 3,
    // Book p.82 verbatim: two installations, EITHER interface serves. `anyOf` is what makes the
    // equivalence rule expressible as data instead of a special case in the puller.
    prerequisites: [
      { name: "Neuralware Processor" },
      { anyOf: ["Interface Plugs", "Chipware Socket"] },
    ],
    housing: null,
    optionCount: 1,
    criteria: {
      categories: [{ category: "Cyberware", sub: "Chipware" }],
      // p.83: chips OVERRIDE, never combine — a chip duplicating a skill the goon already has
      // naturally is a wasted pull, so the puller checks this against the skill plan.
      excludeIfSkillKnown: true,
      // p.83's printed cap. A higher-level chip is non-book and is flagged, not silently taken.
      maxChipLevel: 3,
      // p.82: running chips ≤ INT.
      maxRunningChipsFromInt: true,
      tags: ["combatSkillChip"],
    },
    // Combat + combat-adjacent chips only. Non-combat chips (Botany, Pilot…) are excluded by ruling.
    allow: [
      "Handgun +1", "Handgun +2", "Handgun +3",
      "Rifle +1", "Rifle +2", "Rifle +3",
      "Submachlnegun +1", "Submachlnegun +2", "Submachlnegun +3",   // the pack's own OCR spelling
      "Heavy Weapons +1", "Heavy Weapons +2", "Heavy Weapons +3",
      "Melee +1", "Melee +2", "Melee +3",
      "Fencing +1", "Fencing +2", "Fencing +3",
      "Archery +1", "Archery +2", "Archery +3",
    ],
    deny: [],
  },

  {
    id: "combatOptics",
    labelKey: "CYBERPUNK.GoonFactory.Slot.CombatOptics",
    gradeGate: "C",
    weight: 4,
    prerequisites: [],
    housing: { name: "Cyberoptic", spaces: 4 },
    // The criteria draft's 1@C · 2@B · 3@A/AA — but spent as SPACES (engine rule 1), so a 3-space
    // option eats what three 1-space options would have.
    optionSpacesByGrade: { C: 1, B: 2, A: 3, AA: 3 },
    criteria: { categories: [{ category: "Cyberware", sub: "Cyberoptics" }], tags: ["combatOptic"] },
    allow: [
      "Targeting Scope", "Low Lite", "Infrared", "Anti-Dazzle",
      "Thermograph sensor", "Image Enhancement", "Teleoptics", "Ultra Violet",
    ],
    // ⚖1 ruled: the Dartgun costs 3 of the eye's 4 spaces for one 1m dart. Digital Camera is
    // utility. Both stay reachable via the sheet or a future outfit; neither is a combat pull.
    deny: ["Dartgun", "Digital Camera", "Color Shift", "Times Square Marquee"],
  },

  {
    id: "combatAudio",
    labelKey: "CYBERPUNK.GoonFactory.Slot.CombatAudio",
    gradeGate: "C",
    weight: 3,
    prerequisites: [],
    housing: { name: "Cyberaudio", spaces: 6 },
    optionSpacesByGrade: { C: 1, B: 2, A: 2, AA: 2 },
    criteria: { categories: [{ category: "Cyberware", sub: "Cyberaudio" }], tags: ["combatAudio"] },
    allow: [
      "Amplified Hearing", "Level Damper", "Radio Link", "Tight Beam Radio Link", "Scrambler",
      "Enhanced Hearing Range", "Bug Detector", "Radar Detector", "Voice Stress Analyzer",
      // ⚖2 RULED IN at low weight: the book's own subtable carries these, and a guard with a
      // recorder is realistic flavour. They are `lowWeight` so they never crowd the combat entries.
      "Wearman", "Phone Splice", "Sound Editing", "Digital Recording Link",
    ],
    lowWeight: ["Wearman", "Phone Splice", "Sound Editing", "Digital Recording Link"],
    deny: [],
  },

  {
    id: "reflexBoost",
    labelKey: "CYBERPUNK.GoonFactory.Slot.ReflexBoost",
    gradeGate: "B",
    weight: 2,
    prerequisites: [{ name: "Neuralware Processor" }],
    housing: null,
    optionCount: 1,
    // p.81, CONFIRMED: one boosterware per goon, and no stacking multiples of a single type.
    exclusivity: "boosterware",
    criteria: { categories: [{ category: "Cyberware", sub: "Neuralware" }, { category: "Cyberware", sub: "Implants" }], tags: ["boost"] },
    allow: ["Kerenzikov Boosterware I", "Kerenzikov Boosterware II", "Sandevistan Speedware", "Adrenal Booster"],
    // ⭐ THE GENERATOR PREFERS KERENZIKOV (audit pass): it is ALWAYS-ON, so a squad of them costs the
    // GM no activation bookkeeping. ⚖10 RESOLVED: Sandevistan is IN at A+ (the activation-effect unit
    // is queued), Adrenal Booster B+ under the same logic — so the preference is a WEIGHT, not a bar.
    preferred: ["Kerenzikov Boosterware I", "Kerenzikov Boosterware II"],
    gateByItem: { "Kerenzikov Boosterware I": "B", "Kerenzikov Boosterware II": "A", "Sandevistan Speedware": "A", "Adrenal Booster": "B" },
    deny: [],
  },

  {
    id: "smartgunLink",
    labelKey: "CYBERPUNK.GoonFactory.Slot.SmartgunLink",
    gradeGate: "B",
    weight: 2,
    prerequisites: [{ name: "Interface Plugs" }],
    housing: null,
    optionCount: 1,
    // ⚠ THE BUILD QUESTION THE CRITERIA DRAFT RAISED (slot 5), ANSWERED HONESTLY RATHER THAN GUESSED:
    // the base weapon schema has no smartgun-compatibility field. So the link is pulled only when the
    // goon's actually-pulled primary weapon is a FIREARM the conversion can apply to, and the
    // conversion is priced at p.82's 2× (DEPENDENT_DEALS.smartWeaponConversion). A real
    // compatibility field, if the data ever grows one, replaces this predicate and nothing else.
    requiresCompatibleWeapon: true,
    criteria: { categories: [{ category: "Cyberware", sub: "Neuralware" }], tags: ["smartgun"] },
    allow: ["Smartgun Link"],
    deny: [],
  },

  {
    id: "handWeapons",
    labelKey: "CYBERPUNK.GoonFactory.Slot.HandWeapons",
    gradeGate: "D",
    weight: 5,                       // FADE-derived: hand weapons are the heavy share
    prerequisites: [],
    housing: null,                   // MEAT-HAND implants (surgery M/N) — no cyberlimb needed
    optionCount: 1,
    criteria: { categories: [{ category: "Cyberware", sub: "Cyberweapons" }], tags: ["handWeapon"] },
    allow: ["Big Knucks", "Rippers", "Vampires - Canines", "Slice N' Dice", "Wolvers", "Scratchers", "Cybersnake"],
    // ⚖5 RESOLVED (tiered by damage): Scratchers/Vampires 1d6/3 = intimidation flavour @D ·
    // Big Knucks 1d6+2 / Rippers 1d6+3 @D · Slice N' Dice 2d6 @C · Wolvers 3d6 = the melee
    // heavy-hitter @B. ⚖4 RESOLVED: Cybersnake is a hand weapon @A, not a heavy built-in.
    gateByItem: {
      "Scratchers": "D", "Vampires - Canines": "D", "Big Knucks": "D", "Rippers": "D",
      "Slice N' Dice": "C", "Wolvers": "B", "Cybersnake": "A",
    },
    deny: [],
  },

  {
    id: "armGun",
    labelKey: "CYBERPUNK.GoonFactory.Slot.ArmGun",
    gradeGate: "C",
    weight: 3,
    prerequisites: [],
    // p.90: *"the basic cyberlimb comes without hands or feet"* — so the compound pull MUST include
    // the hand, or the generator makes handless arms. `housingExtras` is that rule as data.
    housing: { name: "Standard Cyberarm", spaces: 4, extras: ["Standard Hand"] },
    optionCount: 1,
    criteria: { categories: [{ category: "Cyberware", sub: "Cyberweapons" }], tags: ["armGun"] },
    allow: ["Popup Gun"],
    deny: [],
  },

  {
    id: "heavyBuiltIns",
    labelKey: "CYBERPUNK.GoonFactory.Slot.HeavyBuiltIns",
    gradeGate: "AA",
    weight: 2,
    prerequisites: [],
    housing: { name: "Standard Cyberarm", spaces: 4, extras: ["Standard Hand"] },
    optionCount: 1,
    criteria: { categories: [{ category: "Cyberware", sub: "Cyberweapons" }], tags: ["heavyBuiltIn"] },
    // ⚠ The Capacitor Laser is a SHOULDER mount, not an arm-space option (audit pass) — it is in the
    // pool because it is the same class of built-in, and it consumes no arm spaces.
    allow: ["Micro-missile Launcher", "Grenade Launcher", "Flame thrower", "2 shot Capacitor Laser"],
    noHousingFor: ["2 shot Capacitor Laser"],
    deny: [],
  },

  {
    id: "dermalArmor",
    labelKey: "CYBERPUNK.GoonFactory.Slot.DermalArmor",
    gradeGate: "B",
    weight: 3,
    prerequisites: [],
    housing: null,
    optionCount: 1,
    // The plating class (p.92–93, ruled ELIGIBLE by the second audit round — it is NOT borg-only)
    // rides this slot at AA and carries the one-head-armor class with it.
    headExclusivity: "headArmor",
    criteria: {
      categories: [{ category: "Cyberware", sub: "Bioware" }, { category: "Cyberware", sub: "Implants" }, { category: "Cyberware", sub: "Other" }],
      tags: ["dermal"],
    },
    // The skinweave ladder is PRE-GRADED in the pack itself, which is why the gates read cleanly.
    allow: [
      "Upgraded Skinweave SP6", "Upgraded Skinweave SP8", "Upgraded Skinweave SP10", "Skinweave SP12",
      "Upgraded Skinweave SP14", "Upgraded Skinweave SP16", "Subdermal Armor",
      "Torso Plate", "Faceplate", "Cowl",
    ],
    gateByItem: {
      "Upgraded Skinweave SP6": "B", "Upgraded Skinweave SP8": "B",
      "Upgraded Skinweave SP10": "A", "Skinweave SP12": "A", "Subdermal Armor": "A",
      "Upgraded Skinweave SP14": "AA", "Upgraded Skinweave SP16": "AA",
      "Torso Plate": "AA", "Faceplate": "AA", "Cowl": "AA",
    },
    headItems: ["Faceplate", "Cowl"],
    deny: [],
  },

  {
    id: "cyberlimbs",
    labelKey: "CYBERPUNK.GoonFactory.Slot.Cyberlimbs",
    gradeGate: "A",
    weight: 2,
    prerequisites: [],
    housing: { name: "Standard Cyberarm", spaces: 4, extras: ["Standard Hand"] },
    optionSpacesByGrade: { A: 1, AA: 2 },
    // p.90 data-level exclusivity: *"may not cover or chrome an armored limb"* — one covering per limb.
    exclusivity: "limbCovering",
    criteria: { categories: [{ category: "Cyberware", sub: "Cyberlimbs" }], tags: ["limbOption"] },
    allow: [
      "Armor Covering", "Thickened Myomar", "Reinforced Joints", "Hydraulic Rams",
      "BuzzHand", "Spike Hand", "Hammer Hand", "Ripper Hand",
    ],
    // ⚖11 RULED: Rams and Myomar are one-per-limb alternatives, so they share an exclusivity token.
    alternatives: [["Thickened Myomar", "Hydraulic Rams"]],
    // Coverings are exclusive per the pack's own text; the combat covering wins on an armored limb
    // and the cosmetic ones stay in garnish.
    coverings: ["Armor Covering"],
    deny: ["RealSkinn Covering", "Superchrome Covering", "Plastic Covering"],
  },

  {
    id: "garnish",
    labelKey: "CYBERPUNK.GoonFactory.Slot.Garnish",
    gradeGate: "E",
    weight: 0,                       // never drawn against the chrome count — see `nonCounting`
    // §1: *"one random cosmetic item (never counts against combat gear)"*.
    nonCounting: true,
    prerequisites: [],
    housing: null,
    optionCount: 1,
    criteria: { categories: [{ category: "Cyberware", sub: "Fashionware" }, { category: "Cyberware", sub: "Cyberoptics" }, { category: "Cyberware", sub: "Cyberlimbs" }], tags: ["cosmetic"] },
    // ⚖9 RESOLVED: garnish is CHROME cosmetics only. Wardrobe (`fashion.db`) left this pool entirely
    // and belongs to outfits + the future fashion system (integration point `outfit.styleKit`, frozen).
    allow: [
      "Techhair", "Skinwatch", "Chem Skins", "Shift-tacts", "Light Tattoo", "Synthskins",
      "Color Shift", "Times Square Marquee", "RealSkinn Covering", "Superchrome Covering",
    ],
    deny: [],
  },
];

// =================================================================================================
// LOOKUPS
// =================================================================================================

const BY_ID = Object.fromEntries(CHROME_SLOTS.map((s) => [s.id, s]));

/** One slot by id, or null. */
export function slotById(id) { return BY_ID[String(id ?? "")] ?? null; }

/** Every slot whose gate this grade meets, in table order. An unknown grade unlocks nothing. */
export function slotsUnlockedAt(gradeKey) {
  if (!GRADE_KEYS.includes(String(gradeKey ?? ""))) return [];
  return CHROME_SLOTS.filter((s) => gradeMeets(gradeKey, s.gradeGate));
}

/** The slots a chrome POINT may be spent on: unlocked, and not the non-counting garnish slot. */
export function countingSlotsAt(gradeKey) {
  return slotsUnlockedAt(gradeKey).filter((s) => !s.nonCounting);
}

/** How many option SPACES a slot may spend at this grade (default 1 — the smallest legal pull). */
export function optionSpacesFor(slot, gradeKey) {
  if (!slot) return 0;
  if (slot.optionSpacesByGrade) return Math.max(0, Number(slot.optionSpacesByGrade[gradeKey]) || 0);
  return Math.max(0, Math.trunc(Number(slot.optionCount) || 0));
}
