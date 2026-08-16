/**
 * GOON FACTORY — THE OUTFIT CATALOGUE.
 *
 * Pure data. No Foundry, no i18n, no logic beyond two lookups.
 *
 * ⭐ WHAT AN OUTFIT IS (GOON-FACTORY-SPEC.md §1 + §3): the window's optional TOP control. Picking one
 * PREFILLS everything below it; any manual edit afterwards flips the label to "Custom (based on X)";
 * re-picking re-derives clean. It is a prefill, never a lock — `resolveGoonConfig` in blueprint.js is
 * where that is implemented and this file only supplies the values.
 *
 * ⭐⭐ THE CATALOGUE IS RATIFIED (user, 2026-08-14: *"promote the 12 if they have a book basis"*, and
 * the basis check passed all twelve). What used to be three entries marked `seed: true` is now the
 * WHOLE of OUTFIT-CATALOGUE-PREP.md §A — twelve rows, transcribed column for column. The three that
 * shipped as seeds are §A rows 1, 4 and 9; they were RECONCILED IN PLACE rather than re-created, so
 * `cityPolicePatrol`, `premiumCorpSecurity` and `boosterGang` keep their ids and every reference to
 * them survives. The `seed` flag and the window's "three seed outfits ship" note are gone with the
 * seed state they described.
 *
 * ⛔ NO CHASSIS ENTRIES. The schema's `chassis` field exists (a borg outfit implies the borg engine
 * and humanity lands where it lands) and the prep proposes two — Full-Borg Enforcer and ACPA Trooper.
 * Both are DEFERRED at the promotion (user, 2026-08-14: the chassis pair is not part of the 12), so
 * no entry declares one and a keeper leg asserts that.
 *
 * ⛔ p.41 RULING (2026-08-14), and it is why these read the way they do: outfits ship as GENERIC
 * archetypes with codes WE assign. Never a real organization's name paired with printed codes or
 * stats; never a copied gang skill listing. The structural patterns are kept and genericized —
 * grade spans with elite squads, reinforcement call-in flavour, jurisdiction limits, and outfit
 * skill-bias vectors with our own numbers.
 */

/**
 * ⭐ THE BONUS-ITEM CHANNEL SEAM (§3 `Outfit.bonusPools`, ruled 2026-08-14).
 *
 * A bonus pool is an EXTRA chance — conditioned on the outfit (via `whenOutfitTags`) or on a low
 * grade (via `whenGradeAtMost`) — that costs the goon NO chrome-count slot. A slot entry inside a
 * pool may carry `squadLimit: n`, a cap across the whole generation BATCH rather than per goon.
 *
 *   bonusPools: [{
 *     id, labelKey,
 *     chance,             // 0..1, default 1
 *     whenGradeAtMost?,   // "D" ⇒ only at D and below
 *     whenOutfitTags?,    // ["covert"] ⇒ only when the outfit carries that tag
 *     slots: [{ slotId, allow?, item?, squadLimit? }]
 *   }]
 *
 * ⛔ EVERY POOL SHIPS EMPTY, deliberately. The residents are ruled but NOT wired and their taste
 * calls are pending: assassin-like chrome (the Dartgun optic, the Certgun finger) on future covert
 * chromed outfits; the comb's T4/T5/T6/T7 as low-grade bonus items; an outfit-gated Combat Tail.
 * The machinery is in `chrome.js` and is keeper-proven against a synthetic pool; wiring a real one
 * is a data edit here and nothing else.
 */
export const BONUS_POOLS_EMPTY = [];

/**
 * ⚑ WHAT I DID NOT INVENT. Every column below is transcribed from OUTFIT-CATALOGUE-PREP.md §A —
 * outfit, role, grade, chrome modifier, armor posture, loot profile, skill bias and the flavour
 * column are all its rows, and the promotion ruling was explicit that the table IS the content.
 * The two fields the prep leaves open and I therefore did NOT guess are `gearSource` (§B.5's
 * manufacturer preference — see the deferral note below) and `tokenArt` (the silhouette fallback
 * stands). `namePool` stays null: attribute-derived names are the shipping default and flavour pools
 * are explicitly future.
 *
 * ⛔ `gearSource` IS OMITTED-AS-NULL ON EVERY ENTRY, AND THAT IS THE RULED DEFERRAL. §B.5 wants
 * entries 4/5/8 to prefer corporate-catalog manufacturers when the pull has a choice. Nothing in
 * the pipeline reads the field: `pickPrimaryWeapon` (goon-factory.js) filters on the grade's weapons
 * rung and nothing else, and the catalog index carries no manufacturer column at all — the standing
 * per-manufacturer filtering earmark is exactly the machinery this would need, and it is NOT built.
 * So the field stays null everywhere rather than shipping a preference that silently does nothing.
 *
 * ⛔ `skillBias` IS §B.1's RULED MECHANISM AND ONLY THAT: the role's Career Skill Package (Core p.44)
 * stays the spine and the vector RE-WEIGHTS package entries, never adding a skill the package lacks
 * (`allocateGoonSkills`, blueprint.js — the bias is a weight addend on entries built FROM the
 * package). A bias key that is not in the role's package is therefore INERT, and where that happens
 * the entry says so at the field rather than being quietly re-pointed at a key that would bite. C9
 * — "should a bias be able to ADD a skill?" — is the open user call; until it is ruled, inert is the
 * behaviour, not a defect.
 *
 * ⛔ `disposition` IS "hostile" ON ALL TWELVE, INCLUDING ENTRY 12 (user, 2026-08-14). §B.4 proposes
 * neutral for the Corporate Staffers and C3 — "allow the generator a non-hostile default at all?" —
 * is still open; the proposal is recorded at that entry and nothing else.
 *
 * ⛔ `lootProfile` NAMES A PROFILE, NOT AN AMOUNT. The amounts are the loot machinery's own
 * (`lootProfileFor`, grades.js: a per-grade base times the dial's multiplier, plus spare magazines).
 * C6 — the per-profile-per-grade curation — is open, and this promotion deliberately did NOT
 * re-curate: an entry says Scarce/Standard/Generous exactly as its §A row does and the existing
 * amounts stand.
 *
 * `flavor` is prep §B.3, ruled GM-ONLY: jurisdiction, reinforcement and the row's flavour note are
 * DESCRIPTION fields with no v1 mechanics, and they land in the generated actor's GM-side notes
 * (`goon-factory.js` `goonGmNotes`) and nowhere else — never a token tooltip, never a chat card,
 * never a player-visible surface. A key is present only where the §A row states that kind of thing;
 * the rows whose flavour column is build rationale rather than table fiction carry it as a comment
 * here instead, which is what the three shipped entries already did.
 */
export const OUTFITS = [
  // ===============================================================================================
  // SECURITY SIDE — §A rows 1-8
  // ===============================================================================================

  {
    // §A row 1. Reconciled in place from the seed set — id unchanged.
    id: "cityPolicePatrol",
    labelKey: "GoonFactory.Outfit.CityPolicePatrol",
    grade: "C",
    roleDefault: "cop",
    chromeCountMod: 0,
    gearSource: null,
    armorPosture: { hardness: "soft", weight: "any", armament: "standard" },
    lootProfile: "scarce",
    disposition: "hostile",
    empOverride: null,
    chassis: null,
    tokenArt: null,
    styleKit: null,          // ⛔ FROZEN until the fashion system lands (FASHION-DESIGN-SEED.md)
    namePool: null,
    composition: null,       // v2 — mixed-grade patrols
    bonusPools: BONUS_POOLS_EMPTY,
    tags: ["security", "lawEnforcement"],
    // Both keys sit in the Cop package, so both bite.
    skillBias: { AwarenessNotice: 2, Handgun: 2 },
    // §B.2: the elite-squad pattern is expressed as PAIRED ENTRIES until composition lands. Row 2 is
    // now in the catalogue, so this note names it rather than promising it.
    gradeSpanNoteKey: "GoonFactory.Outfit.CityPolicePatrolSpan",
    flavor: {
      jurisdictionKey: "GoonFactory.Outfit.CityPolicePatrolJurisdiction",
      reinforcementKey: "GoonFactory.Outfit.CityPolicePatrolReinforcement",
      noteKey: null,
    },
  },

  {
    // §A row 2 — "the 'elite squad' pattern, entry 1's big brother". The pairing IS its flavour
    // column, so it is carried by the grade-span note rather than by an actor-side flavour line.
    id: "cityPoliceTactical",
    labelKey: "GoonFactory.Outfit.CityPoliceTactical",
    grade: "B",
    roleDefault: "cop",
    chromeCountMod: 1,
    gearSource: null,
    // §A "Hard OK" — hard armor is PERMITTED, not required, so the hardness filter stays open. A
    // "hard" filter here would be a stronger statement than the row makes.
    armorPosture: { hardness: "any", weight: "any", armament: "standard" },
    lootProfile: "scarce",
    disposition: "hostile",
    empOverride: null,
    chassis: null,
    tokenArt: null,
    styleKit: null,
    namePool: null,
    composition: null,
    bonusPools: BONUS_POOLS_EMPTY,
    tags: ["security", "lawEnforcement", "tactical"],
    // ⚠ INERT KEY, RECORDED NOT WORKED AROUND (C9): `Rifle` is not in the Cop career package
    // (p.44 Cop is Awareness/Handgun/Human Perception/Athletics/Education/Brawling/Melee/
    // Interrogation/Streetwise), so the Rifle half of this bias re-weights nothing. A tactical
    // cop still ends up able to use the long arm they actually draw — that is the grade's weapon
    // guarantee, which attaches to the PULLED weapon's governing skill. `Athletics` does bite.
    skillBias: { Rifle: 2, Athletics: 2 },
    gradeSpanNoteKey: "GoonFactory.Outfit.CityPoliceTacticalSpan",
    flavor: { jurisdictionKey: null, reinforcementKey: null, noteKey: null },
  },

  {
    // §A row 3.
    id: "cyberpsychoResponse",
    labelKey: "GoonFactory.Outfit.CyberpsychoResponse",
    grade: "A",
    roleDefault: "solo",
    chromeCountMod: 2,
    gearSource: null,
    // §A "Hard, AP posture" — both halves are filters the machinery already has.
    armorPosture: { hardness: "hard", weight: "any", armament: "ap" },
    lootProfile: "standard",
    disposition: "hostile",
    empOverride: null,
    chassis: null,
    tokenArt: null,
    styleKit: null,
    namePool: null,
    composition: null,
    bonusPools: BONUS_POOLS_EMPTY,
    tags: ["security", "lawEnforcement", "chromed"],
    // Both keys sit in the Solo package.
    skillBias: { Rifle: 2, AwarenessNotice: 2 },
    gradeSpanNoteKey: null,
    flavor: {
      jurisdictionKey: null, reinforcementKey: null,
      noteKey: "GoonFactory.Outfit.CyberpsychoResponseNote",
    },
  },

  {
    // §A row 4. Reconciled in place from the seed set — id unchanged.
    id: "premiumCorpSecurity",
    labelKey: "GoonFactory.Outfit.PremiumCorpSecurity",
    grade: "B",
    roleDefault: "solo",
    chromeCountMod: 1,
    gearSource: null,
    // "Soft (presentable)" — the row's own column: this outfit is contract-literal and dressed for
    // a lobby, which is a posture, not a weakness.
    armorPosture: { hardness: "soft", weight: "any", armament: "standard" },
    lootProfile: "standard",
    disposition: "hostile",
    empOverride: null,
    chassis: null,
    tokenArt: null,
    styleKit: null,
    namePool: null,
    composition: null,
    bonusPools: BONUS_POOLS_EMPTY,
    tags: ["security", "corporate"],
    // ⚑ C9's own worked example names this entry's Handgun bias as the inert case *"on a corp
    // goon"* — but §A row 4 defaults the role to SOLO, and the Solo package carries Handgun. So on
    // the entry AS TABLED both keys bite; the inert reading applies only if a GM overrides the role
    // to Corporate, whose package has no weapon skill at all.
    skillBias: { Handgun: 2, AwarenessNotice: 2 },
    gradeSpanNoteKey: null,
    flavor: {
      jurisdictionKey: "GoonFactory.Outfit.PremiumCorpSecurityJurisdiction",
      reinforcementKey: "GoonFactory.Outfit.PremiumCorpSecurityReinforcement",
      noteKey: null,
    },
  },

  {
    // §A row 5. "Soft + subdermal": the soft half is this filter; the subdermal half is CHROME, and
    // it arrives through the chrome count (+1) landing on the dermal slot — `composeArmorStack`
    // folds dermal chrome in as real armor layers. Encoding "subdermal" as an armor filter would
    // point the armor pull at an item the armor bands do not contain.
    id: "executiveProtection",
    labelKey: "GoonFactory.Outfit.ExecutiveProtection",
    grade: "A",
    roleDefault: "solo",
    chromeCountMod: 1,
    gearSource: null,
    armorPosture: { hardness: "soft", weight: "any", armament: "standard" },
    lootProfile: "standard",
    disposition: "hostile",
    empOverride: null,
    chassis: null,
    tokenArt: null,
    styleKit: null,
    namePool: null,
    composition: null,
    bonusPools: BONUS_POOLS_EMPTY,
    tags: ["security", "corporate", "closeProtection"],
    // Both keys sit in the Solo package.
    skillBias: { Handgun: 2, Melee: 2 },
    gradeSpanNoteKey: null,
    flavor: {
      jurisdictionKey: null, reinforcementKey: null,
      noteKey: "GoonFactory.Outfit.ExecutiveProtectionNote",
    },
  },

  {
    // §A row 6.
    id: "facilitySecurity",
    labelKey: "GoonFactory.Outfit.FacilitySecurity",
    grade: "C",
    roleDefault: "cop",
    chromeCountMod: 0,
    gearSource: null,
    armorPosture: { hardness: "soft", weight: "any", armament: "standard" },
    lootProfile: "scarce",
    disposition: "hostile",
    empOverride: null,
    chassis: null,
    tokenArt: null,
    styleKit: null,
    namePool: null,
    composition: null,
    bonusPools: BONUS_POOLS_EMPTY,
    tags: ["security"],
    // Both keys sit in the Cop package.
    skillBias: { AwarenessNotice: 2, Brawling: 2 },
    gradeSpanNoteKey: null,
    flavor: {
      jurisdictionKey: "GoonFactory.Outfit.FacilitySecurityJurisdiction",
      reinforcementKey: "GoonFactory.Outfit.FacilitySecurityReinforcement",
      noteKey: null,
    },
  },

  {
    // §A row 7 — the one THREE-key bias in the table.
    id: "dockPatrol",
    labelKey: "GoonFactory.Outfit.DockPatrol",
    grade: "C",
    roleDefault: "solo",
    chromeCountMod: 0,
    gearSource: null,
    armorPosture: { hardness: "soft", weight: "any", armament: "standard" },
    lootProfile: "scarce",
    disposition: "hostile",
    empOverride: null,
    chassis: null,
    tokenArt: null,
    styleKit: null,
    namePool: null,
    composition: null,
    bonusPools: BONUS_POOLS_EMPTY,
    tags: ["security"],
    // ⚠ INERT KEY, RECORDED NOT WORKED AROUND (C9): `Intimidate` is not in the Solo career package
    // (it is the Fixer's), so that third key re-weights nothing today. Brawling and Melee both bite.
    skillBias: { Brawling: 2, Melee: 2, Intimidate: 2 },
    gradeSpanNoteKey: null,
    flavor: {
      jurisdictionKey: null, reinforcementKey: null,
      noteKey: "GoonFactory.Outfit.DockPatrolNote",
    },
  },

  {
    // §A row 8. The row's flavour column — "equipment advantage = posture + loot, not stat
    // inflation" — is build rationale, not table fiction: it is why this entry reaches past its
    // neighbours through the AP posture and the Generous loot profile rather than through a higher
    // grade. Nothing about it belongs on an actor's notes, so it stays here.
    id: "militarizedCorpForce",
    labelKey: "GoonFactory.Outfit.MilitarizedCorpForce",
    grade: "A",
    roleDefault: "solo",
    chromeCountMod: 1,
    gearSource: null,
    armorPosture: { hardness: "hard", weight: "any", armament: "ap" },
    lootProfile: "generous",
    disposition: "hostile",
    empOverride: null,
    chassis: null,
    tokenArt: null,
    styleKit: null,
    namePool: null,
    composition: null,
    bonusPools: BONUS_POOLS_EMPTY,
    tags: ["security", "corporate", "military"],
    // ⚠ INERT KEY, RECORDED NOT WORKED AROUND (C9): `HeavyWeapons` appears in NO p.44 career
    // package — the retired combat spine carried it and the printed packages do not — so that half
    // of the bias re-weights nothing. A goon who actually draws a heavy weapon still gets the skill:
    // the grade's guarantee attaches to the pulled weapon's governing skill, which resolves through
    // `weaponGoverningSkill` to HeavyWeapons and is pushed into the allocation. `Rifle` bites.
    skillBias: { Rifle: 2, HeavyWeapons: 2 },
    gradeSpanNoteKey: null,
    flavor: { jurisdictionKey: null, reinforcementKey: null, noteKey: null },
  },

  // ===============================================================================================
  // STREET SIDE — §A rows 9-12
  // ===============================================================================================

  {
    // §A row 9. Reconciled in place from the seed set — id unchanged.
    id: "boosterGang",
    labelKey: "GoonFactory.Outfit.BoosterGang",
    grade: "D",
    roleDefault: "solo",
    // "chrome-obsessed: the mod is the identity" — the row's own note, and the reason a D-grade
    // outfit carries the largest modifier in the catalogue (2 + grade base 1 + Solo 2 = 5 pulls).
    chromeCountMod: 2,
    gearSource: null,
    armorPosture: { hardness: "soft", weight: "light", armament: "standard" },
    lootProfile: "scarce",
    disposition: "hostile",
    empOverride: null,
    chassis: null,
    tokenArt: null,
    styleKit: null,
    namePool: null,
    composition: null,
    bonusPools: BONUS_POOLS_EMPTY,
    tags: ["street", "chromed", "garnishHeavy"],
    // Both keys sit in the Solo package.
    skillBias: { Brawling: 2, Melee: 2 },
    gradeSpanNoteKey: null,
    // ⚑ RECONCILIATION NOTE: §A row 9's flavour column is build rationale ("chrome-obsessed…"), so
    // strictly this entry would carry no actor-side flavour. These two lines SHIPPED with the seed
    // set and are kept rather than deleted — the promotion ruling reconciles a seed in place, and
    // removing GM text a table has already seen is a change the ruling did not ask for.
    flavor: {
      jurisdictionKey: "GoonFactory.Outfit.BoosterGangJurisdiction",
      reinforcementKey: "GoonFactory.Outfit.BoosterGangReinforcement",
      noteKey: null,
    },
  },

  {
    // §A row 10. Flavour column ("garnish/biosculpt heavy — the LOOK outranks the hardware") is
    // build rationale: it is why this entry sits one chrome modifier BELOW the booster gang at the
    // same grade. The garnish itself is the generator's own always-on cosmetic pull.
    id: "poserGang",
    labelKey: "GoonFactory.Outfit.PoserGang",
    grade: "D",
    roleDefault: "solo",
    chromeCountMod: 1,
    gearSource: null,
    armorPosture: { hardness: "soft", weight: "light", armament: "standard" },
    lootProfile: "scarce",
    disposition: "hostile",
    empOverride: null,
    chassis: null,
    tokenArt: null,
    styleKit: null,
    namePool: null,
    composition: null,
    bonusPools: BONUS_POOLS_EMPTY,
    tags: ["street", "garnishHeavy"],
    // ⚠ INERT KEY, RECORDED NOT WORKED AROUND (C9): `Streetwise` is not in the Solo career package
    // (it is the Cop's, the Media's and the Rocker's), so that half re-weights nothing. Brawling bites.
    skillBias: { Brawling: 2, Streetwise: 2 },
    gradeSpanNoteKey: null,
    flavor: { jurisdictionKey: null, reinforcementKey: null, noteKey: null },
  },

  {
    // §A row 11. Flavour column ("the E-band 'normal clothing' case, fashion layer's first
    // customer") is build rationale — and it is self-enforcing: grade E has NO armor pull at all
    // (`ARMOR_BANDS.E.pull === false`), so the row's "None" posture needs no filter to hold. The
    // filters stay open rather than stating a restriction the band already makes moot.
    id: "chromerGang",
    labelKey: "GoonFactory.Outfit.ChromerGang",
    grade: "E",
    roleDefault: "rocker",
    chromeCountMod: 0,
    gearSource: null,
    armorPosture: { hardness: "any", weight: "any", armament: "standard" },
    lootProfile: "scarce",
    disposition: "hostile",
    empOverride: null,
    chassis: null,
    tokenArt: null,
    styleKit: null,
    namePool: null,
    composition: null,
    bonusPools: BONUS_POOLS_EMPTY,
    tags: ["street"],
    // Both keys sit in the Rocker package.
    skillBias: { Brawling: 2, Perform: 2 },
    gradeSpanNoteKey: null,
    flavor: { jurisdictionKey: null, reinforcementKey: null, noteKey: null },
  },

  {
    // §A row 12 — "suits; hostile only if provoked → disposition neutral?".
    //
    // ⛔ SHIPS HOSTILE, AND THAT IS THE RULING (user, 2026-08-14): the spec default stands on all
    // twelve until C3 — *"allow the generator a non-hostile default at all?"* — is answered. §B.4's
    // PROPOSED value for this entry is `disposition: "neutral"`, and this comment is the whole of
    // its implementation until the call comes. The "hostile only if provoked" half of the row is
    // where the fiction lives, and it lands as a GM-side note.
    //
    // The "None (concealable at most)" posture is self-enforcing at grade E — no armor pull exists
    // there — so the filters stay open, as on row 11.
    id: "corporateStaffers",
    labelKey: "GoonFactory.Outfit.CorporateStaffers",
    grade: "E",
    roleDefault: "corp",
    chromeCountMod: 0,
    gearSource: null,
    armorPosture: { hardness: "any", weight: "any", armament: "standard" },
    lootProfile: "scarce",
    disposition: "hostile",
    empOverride: null,
    chassis: null,
    tokenArt: null,
    styleKit: null,
    namePool: null,
    composition: null,
    bonusPools: BONUS_POOLS_EMPTY,
    tags: ["corporate"],
    // Both keys sit in the Corp package (`PersuasionFastTalk` is the schema key p.44's "Persuasion"
    // resolves to — the rename is recorded at CAREER_PACKAGES in blueprint.js).
    skillBias: { PersuasionFastTalk: 2, AwarenessNotice: 2 },
    gradeSpanNoteKey: null,
    flavor: {
      jurisdictionKey: null, reinforcementKey: null,
      noteKey: "GoonFactory.Outfit.CorporateStaffersNote",
    },
  },
];

const BY_ID = Object.fromEntries(OUTFITS.map((o) => [o.id, o]));

/** One outfit by id, or null — `null` is the ordinary "no outfit picked" state. */
export function outfitById(id) { return BY_ID[String(id ?? "")] ?? null; }

/** The ids, in window order. */
export const OUTFIT_IDS = OUTFITS.map((o) => o.id);
