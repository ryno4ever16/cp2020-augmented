/**
 * GOON FACTORY — THE OUTFIT SCHEMA SEAM AND ITS THREE SEED ENTRIES.
 *
 * Pure data. No Foundry, no i18n, no logic beyond two lookups.
 *
 * ⭐ WHAT AN OUTFIT IS (GOON-FACTORY-SPEC.md §1 + §3): the window's optional TOP control. Picking one
 * PREFILLS everything below it; any manual edit afterwards flips the label to "Custom (based on X)";
 * re-picking re-derives clean. It is a prefill, never a lock — `resolveGoonConfig` in blueprint.js is
 * where that is implemented and this file only supplies the values.
 *
 * ⛔⛔ THREE SEEDS ONLY, AND THEY ARE MARKED AS SEEDS. The full catalogue is a pending user session
 * (OUTFIT-CATALOGUE-PREP.md §C is its decision list — twelve entries, chrome-mod arithmetic, loot
 * amounts per profile per grade, token art, and the chassis question all still open). What ships here
 * is entries **1, 4 and 9** of that prep's §A table — City Police — Patrol, Premium Corporate
 * Security, Booster Gang — carried at their proposed values so the seam is exercisable end to end.
 * Every one carries `seed: true`, and the window says so on screen.
 *
 * ⛔ NO CHASSIS ENTRIES. The schema's `chassis` field exists (a borg outfit implies the borg engine
 * and humanity lands where it lands) and the prep proposes two — but building them is out of this
 * unit's scope, so no seed declares one and a keeper leg asserts that.
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
 * grade, role, chrome modifier, armor posture, loot profile and skill bias are all its proposals.
 * The two fields the prep leaves to the session and I therefore did NOT guess are `gearSource`
 * (manufacturer preference — it depends on the standing per-manufacturer filtering earmark, so it
 * is null) and `tokenArt` (the silhouette fallback stands). `namePool` stays null: attribute-derived
 * names are the shipping default and flavour pools are explicitly future.
 *
 * `skillBias` is prep §B.1's ruled MECHANISM: the role's Career Skill Package stays the spine and
 * the vector re-weights only the REMAINDER, never adding a skill outside package + bias.
 * `flavor` is prep §B.3: jurisdiction and reinforcement are DESCRIPTION fields with no v1 mechanics
 * — they print on the actor's notes so the GM inherits the fiction hooks.
 */
export const OUTFIT_SEEDS = [
  {
    // OUTFIT-CATALOGUE-PREP §A entry 1.
    id: "cityPolicePatrol",
    labelKey: "GoonFactory.Outfit.CityPolicePatrol",
    seed: true,
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
    skillBias: { AwarenessNotice: 2, Handgun: 2 },
    // prep §B.2: the elite-squad pattern is expressed as PAIRED ENTRIES until composition lands;
    // until the tactical entry ships this note is the only place the ladder is visible.
    gradeSpanNoteKey: "GoonFactory.Outfit.CityPolicePatrolSpan",
    flavor: {
      jurisdictionKey: "GoonFactory.Outfit.CityPolicePatrolJurisdiction",
      reinforcementKey: "GoonFactory.Outfit.CityPolicePatrolReinforcement",
    },
  },

  {
    // OUTFIT-CATALOGUE-PREP §A entry 4.
    id: "premiumCorpSecurity",
    labelKey: "GoonFactory.Outfit.PremiumCorpSecurity",
    seed: true,
    grade: "B",
    roleDefault: "solo",
    chromeCountMod: 1,
    gearSource: null,
    // "Soft (presentable)" — the prep's own column: this outfit is contract-literal and dressed for
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
    skillBias: { Handgun: 2, AwarenessNotice: 2 },
    gradeSpanNoteKey: null,
    flavor: {
      jurisdictionKey: "GoonFactory.Outfit.PremiumCorpSecurityJurisdiction",
      reinforcementKey: "GoonFactory.Outfit.PremiumCorpSecurityReinforcement",
    },
  },

  {
    // OUTFIT-CATALOGUE-PREP §A entry 9.
    id: "boosterGang",
    labelKey: "GoonFactory.Outfit.BoosterGang",
    seed: true,
    grade: "D",
    roleDefault: "solo",
    // "chrome-obsessed: the mod is the identity" — the prep's own note, and the reason a D-grade
    // outfit carries the largest modifier in the seed set (2 + grade base 1 + Solo 2 = 5 pulls).
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
    skillBias: { Brawling: 2, Melee: 2 },
    gradeSpanNoteKey: null,
    flavor: {
      jurisdictionKey: "GoonFactory.Outfit.BoosterGangJurisdiction",
      reinforcementKey: "GoonFactory.Outfit.BoosterGangReinforcement",
    },
  },
];

const BY_ID = Object.fromEntries(OUTFIT_SEEDS.map((o) => [o.id, o]));

/** One outfit by id, or null — `null` is the ordinary "no outfit picked" state. */
export function outfitById(id) { return BY_ID[String(id ?? "")] ?? null; }

/** The ids, in window order. */
export const OUTFIT_IDS = OUTFIT_SEEDS.map((o) => o.id);
