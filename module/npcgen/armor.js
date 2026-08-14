/**
 * GOON FACTORY — THE ARMOR BAND POOLS AND THE BOOK-LAW LAYERING COMPOSER.
 *
 * PURE. No Foundry, no `game`, no i18n, no randomness beyond an optional injected `rng`.
 * Source of every rule and every pool below: `import-staging/ARMOR-CRITERIA-DRAFT.md`, whose
 * "RESOLUTION ROUND" carries the user's ratifications and the book's own verbatim layering law.
 *
 * ⭐ THE ONE IDEA THAT SHAPES THIS WHOLE FILE. The armor audit's finding was that **the AA band is
 * empty**: zero worn items above SP 30 exist anywhere, because the book's top armor grades assume a
 * CHASSIS, not a wardrobe. So the top of *worn* armor is not an item, it is a STACK — and this file's
 * real job is not "pick an armor", it is *"compose a book-legal stack and show what it is worth."*
 *
 * ⛔ COMPOSE LEGAL BY CONSTRUCTION. The general book-legality ENFORCEMENT (fold honoring layer law,
 * layer EV in derived EV, equip warnings for hand-built characters) is a SEPARATE, later unit — this
 * file does not touch the damage fold or the equip path. What it guarantees is narrower and is the
 * spec's own scope line: what the GENERATOR produces is legal when it is produced.
 *
 * THE BOOK'S LAYERING LAW, found verbatim (armor chapter errata rules) and carried as data below:
 *   · maximum THREE layers · no more than ONE hard layer
 *   · 2nd layer −1 EV, 3rd layer −2 EV extra
 *   · Subdermal Armor and Bodyplating COUNT as layers
 *   · Skinweave IS a layer but takes NO penalty
 *   · Proportional Armor: +5/+4/+3/+2/+1/+0 over diff bands 0-4 / 5-8 / 9-14 / 15-20 / 21-26 / 27+,
 *     folded pairwise inside-out.
 */

import { GRADE_KEYS, gradeIndex } from "./grades.js";

// =================================================================================================
// THE LAW
// =================================================================================================

export const LAYER_LAW = {
  maxLayers: 3,
  maxHardLayers: 1,
  /** Cumulative EV surcharge by counted-layer index: the 1st is free, the 2nd −1, the 3rd −2 more. */
  extraEvPerLayer: [0, 1, 2],
  /** Skinweave is a layer that takes NO penalty — so it never spends one of the three. */
  skinweaveFree: true,
  /** Subdermal armor and bodyplating DO count against the three. The book says so. */
  subdermalCounts: true,
  /** helmet XOR cowl/faceplate — from the chrome audit, applied across both systems. */
  oneHeadArmor: true,
};

/**
 * PROPORTIONAL ARMOR, as the printed table. Ascending by band ceiling so the first match wins and a
 * diff above the last band scores 0 — which is the table's own "27+" row, not a fallback.
 */
export const PROPORTIONAL_TABLE = [
  { maxDiff: 4, bonus: 5 },
  { maxDiff: 8, bonus: 4 },
  { maxDiff: 14, bonus: 3 },
  { maxDiff: 20, bonus: 2 },
  { maxDiff: 26, bonus: 1 },
  { maxDiff: Infinity, bonus: 0 },
];

/** The table's bonus for a difference between two layers' SP. */
export function proportionalBonus(diff) {
  const d = Math.abs(Math.trunc(Number(diff) || 0));
  return (PROPORTIONAL_TABLE.find((r) => d <= r.maxDiff) ?? { bonus: 0 }).bonus;
}

/**
 * Fold two layers. The result is the HIGHER SP plus the band bonus — never a sum, which is the whole
 * point of proportional armor and the reason a goon in three coats is not invulnerable.
 * A zero layer contributes nothing at all (it is not a layer, so there is nothing to be proportional
 * to) — without this guard SP 3 over nothing would score 8.
 */
export function proportionalSP(a, b) {
  const x = Math.max(0, Math.trunc(Number(a) || 0));
  const y = Math.max(0, Math.trunc(Number(b) || 0));
  if (x === 0) return y;
  if (y === 0) return x;
  return Math.max(x, y) + proportionalBonus(Math.abs(x - y));
}

/** Fold an ordered inside-out list of SP values into one effective SP. */
export function foldStack(spValues) {
  return (spValues ?? []).reduce((acc, sp) => proportionalSP(acc, sp), 0);
}

// =================================================================================================
// HARDNESS — the BOOK's printed table, which overrules our name/EV heuristic
// =================================================================================================

/**
 * ⭐ THE BOOK PRINTS ITS OWN HARD/SOFT TABLE, and it contradicts the module's shipped heuristic on
 * four items. `combat/armor-layers.js` `getArmorHardness` types Flak Vest, Flak Pants, Nylon Helmet
 * and Steel Helmet as SOFT (its name regex misses them and its EV heuristic guesses low); the book
 * lists all four as HARD. The armor draft's ratified answer is a read-time correction, and this is
 * the generator's copy of the book's list — it never rewrites stored data.
 *
 * Matching is by lowercased substring so the pack's own naming variants ("Flack Vest", "Ballistic
 * Nylon Helmet") land on the right row; HARD is tested first so a "hard" token wins a tie.
 */
const BOOK_HARD_PATTERNS = [
  /metal ?gear/, /police (riot|patrol)/, /riot armou?r/, /door ?gunner/, /steel helmet/,
  /fla[ck]k? ?(vest|pants)/, /(ballistic )?nylon helmet/, /torso plate/, /faceplate/, /\bcowl\b/,
  /body plating|bodyplating/,
];
const BOOK_SOFT_PATTERNS = [
  /kevlar/, /m-?78/, /heavy leather/, /skin ?tight/, /padding/, /t-?shirt/, /jacket/,
  /leather/, /stocking/, /trenchcoat/, /cotton/,
];

/** The book's hardness for an armor NAME. Unknown ⇒ null, so a caller can fall back to item data. */
export function bookHardness(name) {
  const n = String(name ?? "").toLowerCase();
  if (!n) return null;
  if (BOOK_HARD_PATTERNS.some((re) => re.test(n))) return "hard";
  if (BOOK_SOFT_PATTERNS.some((re) => re.test(n))) return "soft";
  return null;
}

/** Hardness for a candidate: its own declared value first, then the book table, then soft. */
export function hardnessOf(candidate) {
  const own = String(candidate?.hardness ?? candidate?.armorType ?? "").toLowerCase();
  if (own === "hard" || own === "soft") return own;
  return bookHardness(candidate?.name) ?? "soft";
}

// =================================================================================================
// THE BAND POOLS
// =================================================================================================

/**
 * The band pools, as the armor draft resolved them. `pool` is a NAME list of real pack items — the
 * generator intersects it with whatever the world actually has, so a trimmed pack set thins the pool
 * instead of breaking it. `spMin`/`spMax` are the band's own range.
 *
 * ⚖5 RATIFIED: E band pulls NO armor — the band IS "normal clothing", which is the fashion/outfit
 * layer's job, not the armor pool's.
 * ⚖2 RATIFIED: A is a thin two-item pool backed by layering; AA has NO single items and says so.
 */
export const ARMOR_BANDS = {
  E: {
    key: "E", pull: false, itemsExist: false, spMin: 0, spMax: 3, pool: [],
    honestyKey: "CYBERPUNK.GoonFactory.Armor.BandE",
  },
  D: {
    key: "D", pull: true, itemsExist: true, spMin: 4, spMax: 10,
    pool: ["Heavy Leather", "Kevlar T-Shirt", "Kevlar Vest", "Armored Cotton T-Shirt",
      "Motorcycle Jacket", "Motorcycle Helmet", "Militech M-78 T-shirt", "Armored Stockings",
      "Uniware Torso Armor", "Uniware Legpads"],
  },
  C: {
    key: "C", pull: true, itemsExist: true, spMin: 11, spMax: 20,
    pool: ["Light Armor Jacket", "Medium Armor Jacket", "Heavy Armor Jacket", "Flack Vest",
      "Flack Pants", "Steel Helmet", "Nylon Helmet", "MedicGear Combat Armor", "BACL Reactive",
      "Uniware Trenchcoat", "Smart Helmet"],
  },
  B: {
    key: "B", pull: true, itemsExist: true, spMin: 21, spMax: 25,
    pool: ["Metal Gear", "Doorgunner's Vest", "Police Patrol Helmet"],
  },
  A: {
    key: "A", pull: true, itemsExist: true, spMin: 26, spMax: 30,
    pool: ["Pit Viper suit", "Assault Armor"],
    honestyKey: "CYBERPUNK.GoonFactory.Armor.BandA",
  },
  AA: {
    // ⭐ No single item above SP 30 exists anywhere, BY BOOK DESIGN — the band is reached by
    // LAYERING (worn + skinweave + subdermal + plating) or by a chassis via outfits. The band's
    // honesty line says exactly that rather than pretending to shop for a mythical SP-35 coat.
    key: "AA", pull: true, itemsExist: false, spMin: 31, spMax: null,
    pool: ["Metal Gear", "Doorgunner's Vest", "Pit Viper suit", "Assault Armor", "Police Patrol Helmet"],
    honestyKey: "CYBERPUNK.GoonFactory.Armor.BandAA",
  },
};

/**
 * ⛔ EXCLUDED FROM EVERY POOL, and the reasons, so the omissions read as decisions:
 *  · `armor-add.db` — the frozen B1/B2 unreviewed pile, per the standing ruling.
 *  · the 44 SP-0 CLOTHING items in the module's supplement-armor (Uniware, Wearman, Tanaka lines)
 *    — they are the FASHION corpus, not armor.
 *  · the Salamander line — FIRE-TYPED armor (SP 20 vs fire only, stamped `mechTypedSP {type:"fire"}`);
 *    correct data, deliberately engineered, and simply not general protection.
 */
export const ARMOR_POOL_EXCLUSIONS = ["armor-add", "sp0Clothing", "Salamander"];

// =================================================================================================
// FILTERS (§1 "Armor filters")
// =================================================================================================

/**
 * §1: *"light-only CANNOT reach B/A bands — clamp visibly."* The clamp is reported, never applied
 * behind the GM's back: the window prints "Light armor caps near SP 20 — grade A's band unreachable;
 * showing best available", which is the spec's own wording.
 *
 * ⚑ The threshold is band C's ceiling (SP 20) because that is where the printed light items stop —
 * the spec names SP 20 in the clamp message itself, so the number is the spec's, not mine.
 */
export const LIGHT_ARMOR_SP_CEILING = 20;

export function armorWeightClamp(gradeKey, weightFilter) {
  if (String(weightFilter ?? "any") !== "light") return { clamped: false, code: null };
  const band = ARMOR_BANDS[gradeKey];
  if (!band) return { clamped: false, code: null };
  const unreachable = band.spMin > LIGHT_ARMOR_SP_CEILING;
  return unreachable
    ? { clamped: true, code: "lightCannotReachBand", ceiling: LIGHT_ARMOR_SP_CEILING, band: gradeKey }
    : { clamped: false, code: null };
}

/**
 * ⚑ WEIGHT CLASS FROM EV, and why. The packs carry no weight class; EV is the encumbrance the item
 * actually imposes, which is what "light" means at the table. EV ≤ 1 is light, EV ≥ 2 is heavy. A
 * real weight field, if one ever lands, replaces this one function.
 */
export function weightClassOf(candidate) {
  return (Number(candidate?.ev) || 0) <= 1 ? "light" : "heavy";
}

// =================================================================================================
// THE COMPOSER
// =================================================================================================

/** Every combination of `items` up to `maxSize`, as index lists. Bounded by the caller. */
function combinations(items, maxSize) {
  const out = [[]];
  const walk = (start, acc) => {
    if (acc.length >= maxSize) return;
    for (let i = start; i < items.length; i++) {
      const next = [...acc, items[i]];
      out.push(next);
      walk(i + 1, next);
    }
  };
  walk(0, []);
  return out;
}

/** Is a worn-layer set legal under the book's law (≤1 hard, ≤1 head, within the layer budget)? */
function stackLegal(worn, countedFromChrome) {
  if (worn.length + countedFromChrome > LAYER_LAW.maxLayers) return false;
  if (worn.filter((w) => hardnessOf(w) === "hard").length > LAYER_LAW.maxHardLayers) return false;
  if (LAYER_LAW.oneHeadArmor && worn.filter((w) => w.location === "head").length > 1) return false;
  return true;
}

/**
 * THE A/AA LAYERING COMPOSER — *"the composer maximizes effective SP under the book's own
 * constraints"* (armor draft, resolution round, the user's "cleverly layered" ask).
 *
 * It is a bounded exhaustive search rather than a greedy pick, and that is deliberate: proportional
 * armor is NOT monotone in SP — a 20 under a 25 (diff 5, +4) beats a 6 under a 25 (diff 19, +2) even
 * though it is the same "add one more layer" move, so a greedy "take the biggest" would routinely
 * compose a worse stack than the one sitting in front of it. The candidate list is capped at the
 * best 12 by SP so the search stays trivial (≤ 299 subsets) however large a pool the world ships.
 *
 * @param {string} gradeKey
 * @param {Array}  candidates   worn armor `{name, sp, ev, hardness?, location?}`
 * @param {Array}  chromeLayers dermal chrome `{name, sp, kind:"skinweave"|"subdermal"|"plating"}`
 * @param {object} [filters]    `{hardness:"any|soft|hard", weight:"any|light|heavy"}`
 */
export function composeArmorStack({ gradeKey = "E", candidates = [], chromeLayers = [], filters = {} } = {}) {
  const band = ARMOR_BANDS[gradeKey] ?? ARMOR_BANDS.E;
  const honesty = [];

  // Chrome layers are decided elsewhere (the chrome pull) — they are an INPUT here. Skinweave is
  // free; subdermal and plating spend a layer.
  const skinweave = chromeLayers.filter((c) => c.kind === "skinweave");
  const countedChrome = chromeLayers.filter((c) => c.kind !== "skinweave");
  const countedFromChrome = LAYER_LAW.subdermalCounts ? countedChrome.length : 0;

  if (!band.pull) {
    honesty.push({ code: "bandNoPull", band: band.key, messageKey: band.honestyKey ?? "CYBERPUNK.GoonFactory.Armor.BandE" });
    return finish([], skinweave, countedChrome, honesty, band);
  }
  if (band.itemsExist === false) {
    honesty.push({ code: "bandLayeredOnly", band: band.key, messageKey: band.honestyKey ?? "CYBERPUNK.GoonFactory.Armor.BandAA" });
  }

  // Filters. Each rejection that empties the field is reported, so "why is my heavy goon in a
  // t-shirt" always has an answer on screen.
  const wantHard = String(filters.hardness ?? "any");
  const wantWeight = String(filters.weight ?? "any");
  let pool = candidates.filter((c) => (Number(c.sp) || 0) > 0);
  if (wantHard !== "any") {
    const kept = pool.filter((c) => hardnessOf(c) === wantHard);
    if (!kept.length && pool.length) honesty.push({ code: "hardnessFilterEmpty", want: wantHard });
    pool = kept;
  }
  if (wantWeight !== "any") {
    const kept = pool.filter((c) => weightClassOf(c) === wantWeight);
    if (!kept.length && pool.length) honesty.push({ code: "weightFilterEmpty", want: wantWeight });
    else pool = kept;
  }
  const clamp = armorWeightClamp(gradeKey, wantWeight);
  if (clamp.clamped) honesty.push({ code: clamp.code, band: clamp.band, ceiling: clamp.ceiling });

  if (!pool.length) {
    honesty.push({ code: "noArmorAvailable", band: band.key });
    return finish([], skinweave, countedChrome, honesty, band);
  }

  const budget = Math.max(0, LAYER_LAW.maxLayers - countedFromChrome);
  if (budget === 0) honesty.push({ code: "layerBudgetSpentOnChrome", chromeLayers: countedFromChrome });

  const shortlist = [...pool].sort((a, b) => (Number(b.sp) || 0) - (Number(a.sp) || 0)).slice(0, 12);
  let best = { worn: [], sp: 0, ev: Infinity };
  for (const combo of combinations(shortlist, budget)) {
    if (!stackLegal(combo, countedFromChrome)) continue;
    const trial = finish(combo, skinweave, countedChrome, [], band);
    if (trial.effectiveSP > best.sp || (trial.effectiveSP === best.sp && trial.effectiveEV < best.ev)) {
      best = { worn: combo, sp: trial.effectiveSP, ev: trial.effectiveEV };
    }
  }
  return finish(best.worn, skinweave, countedChrome, honesty, band);
}

/**
 * Assemble the final stack, INSIDE-OUT, and score it.
 *
 * Order matters and is the book's: chrome sits against the skin (skinweave innermost, then
 * subdermal/plating), then worn layers ascending by SP — which is also `combat/armor-layers.js`'s
 * own auto-order, so the generator's stack and the sheet's display agree by construction.
 */
function finish(worn, skinweave, countedChrome, honesty, band) {
  const ordered = [
    ...skinweave.map((c) => ({ ...c, kind: "skinweave", ev: 0 })),
    ...countedChrome.map((c) => ({ ...c, ev: 0 })),
    ...[...worn].sort((a, b) => (Number(a.sp) || 0) - (Number(b.sp) || 0))
      .map((w) => ({ ...w, kind: "worn", hardness: hardnessOf(w) })),
  ];

  const effectiveSP = foldStack(ordered.map((l) => Number(l.sp) || 0));

  // EV = the layers' own encumbrance, plus the book's layer surcharge over the COUNTED layers
  // (skinweave takes no penalty — that is what "free" means).
  const counted = ordered.filter((l) => l.kind !== "skinweave");
  const baseEv = counted.reduce((s, l) => s + (Number(l.ev) || 0), 0);
  const layerEv = counted.reduce((s, _l, i) => s + (LAYER_LAW.extraEvPerLayer[i] ?? LAYER_LAW.extraEvPerLayer.at(-1)), 0);

  return {
    band: band.key,
    layers: worn.map((w) => ({ ...w, hardness: hardnessOf(w) })),
    stack: ordered,
    countedLayers: counted.length,
    effectiveSP,
    effectiveEV: baseEv + layerEv,
    baseEV: baseEv,
    layerEV: layerEv,
    honesty,
  };
}

/** The band a grade shops in — the letter is the same, but resolve through the table, not by hand. */
export function bandFor(gradeKey) {
  return ARMOR_BANDS[gradeKey] ?? null;
}

/** Ordered band keys, for a UI that wants to show the ladder. */
export const ARMOR_BAND_KEYS = GRADE_KEYS.filter((k) => !!ARMOR_BANDS[k]);

/** True when `gradeKey` sits at or above the A band, where the composer's layering really matters. */
export function isLayeringBand(gradeKey) {
  return gradeIndex(gradeKey) >= gradeIndex("A");
}
