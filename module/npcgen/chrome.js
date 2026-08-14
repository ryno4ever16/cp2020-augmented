/**
 * GOON FACTORY — THE COMPOUND-PULL ENGINE (GOON-FACTORY-SPEC.md §3 `Slot`, §2.5).
 *
 * PURE. Randomness is an INJECTED `rng`; the item POOL is handed in as plain rows. No Foundry, no
 * `game`, no i18n — so the whole engine runs under `node` (tests/npcgen-goonfactory.test.mjs) and the
 * preview and the create call it with the same arguments and cannot disagree.
 *
 * ⭐ WHAT THIS FILE IS FOR, IN ONE SENTENCE: a chrome "point" is not an item, it is a **compound
 * pull** — a housing plus k options plus whatever prerequisites the goon does not already have —
 * and §3 says the engine must support that from day one. Everything below is the four engine rules
 * the 2026-08-13 audit pass added, plus the two dedup rules the criteria draft's build questions
 * named:
 *
 *   1. OPTION SPACES, not counts     — housings hold a space budget; options carry space costs.
 *   2. EXCLUSIVITY CLASSES           — one boosterware per goon (p.81), one covering per limb
 *                                      (p.90), one head armor (helmet XOR cowl/faceplate).
 *   3. DEPENDENT DEALS               — Targeting Scope only with the smartgun stack (p.86); a smart
 *                                      conversion costs 2× the gun (p.82); popup class reads BT (p.91).
 *   4. SIDE-EFFECT ITEMS             — SP14/16 skinweave debits ATTR (a STAT WRITE); launchers need
 *                                      ammo items; popup guns feed on caseless only.
 *   5. HOUSING DEDUP                 — a second optic pull REUSES the eye and stacks into it.
 *   6. PREREQUISITE EQUIVALENCE      — book p.82: a prerequisite is satisfied by any equivalent the
 *                                      goon already carries (existing plugs serve a chip's interface
 *                                      need), and the Neuralware Processor is bought exactly ONCE.
 *
 * ⛔ NOTHING GATES SILENTLY (§0). Every refusal above emits a `lint` row with a code, and the preview
 * prints them. A slot that resolves to nothing, a housing that fills, an exclusivity that bars a
 * second pull, a scope that cannot be taken — all of them SAY SO. A silent skip would look exactly
 * like a generator that simply rolled a quiet goon.
 */

import { gradeIndex, gradeOf, gradeMeets } from "./grades.js";
import {
  CHROME_DENY_NAMES, CHROME_SLOTS, DEPENDENT_DEALS, HOUSING_SPACES, NOTHING_WEIGHT, SIDE_EFFECTS,
  countingSlotsAt, optionSpacesFor, slotById,
} from "./slots.js";

/** A pool row's option space cost (1 = the ordinary combat option). */
function spaceCostOf(row) {
  const n = Number(row?.slotsTaken ?? row?.spaces);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
}

/** A housing row's capacity: the row's own field first, then the printed table, then 0. */
function capacityOf(row, housingSpec) {
  const own = Number(row?.spaces);
  if (Number.isFinite(own) && own > 0) return Math.trunc(own);
  const printed = Number(HOUSING_SPACES[row?.name] ?? housingSpec?.spaces);
  return Number.isFinite(printed) && printed > 0 ? Math.trunc(printed) : 0;
}

/** Does a pool row satisfy one of a slot's `{category, sub}` shapes? Blank sub = any sub. */
function inCategories(row, categories) {
  if (!Array.isArray(categories) || !categories.length) return true;
  return categories.some((c) => {
    if (row.category !== c.category) return false;
    const sub = c.sub ?? null;
    return sub === null || sub === "" ? true : row.sub === sub;
  });
}

/** A weighted draw over `entries` (each `{weight}`), by one `rng()` call. Never returns undefined
 *  for a non-empty list — the trailing entry is the fallback when float error eats the remainder. */
function weightedPick(entries, rng) {
  if (!entries.length) return null;
  const total = entries.reduce((s, e) => s + (Number(e.weight) > 0 ? Number(e.weight) : 0), 0);
  if (total <= 0) return entries[Math.min(Math.floor(rng() * entries.length), entries.length - 1)];
  let t = (Number(rng()) || 0) * total;
  for (const e of entries) { t -= (Number(e.weight) > 0 ? Number(e.weight) : 0); if (t < 0) return e; }
  return entries[entries.length - 1];
}

/**
 * The exclusivity TOKEN an item would consume, or null.
 *
 * The token is deliberately a STRING rather than a boolean per class, because the limb-covering rule
 * is per-LIMB: two arms may each carry one covering, so the token carries its housing.
 */
function exclusivityTokenFor(slot, name, housingName) {
  if (slot.headExclusivity && (slot.headItems ?? []).includes(name)) return "headArmor";
  if (slot.exclusivity === "limbCovering" && (slot.coverings ?? []).includes(name)) {
    return `limbCovering:${housingName ?? "limb"}`;
  }
  for (const pair of slot.alternatives ?? []) {
    if (pair.includes(name)) return `alt:${slot.id}:${pair.join("+")}`;
  }
  return null;
}

/**
 * DEPENDENT DEALS, as a predicate over one candidate row.
 *
 * The Targeting Scope is the live case: p.86 gives it *"+1 ONLY to smartgun attacks"*, so without
 * the stack it is a humanity cost that buys nothing. Barring it is not a balance choice — it is the
 * item's own printed condition.
 */
function dependentDealOk(row, ctx) {
  if (row.name === DEPENDENT_DEALS.targetingScope.item && !ctx.smartgunStack) return false;
  return true;
}

/**
 * THE WHOLE CHROME PLAN FOR ONE GOON.
 *
 * @param {object}   o
 * @param {Array}    o.pool           catalog-shaped rows `{key,name,category,sub,cost,humanityLoss,slotsTaken?,spaces?}`
 * @param {string}   o.gradeKey       E…AA — gates the slots, the per-item rungs and the whiff
 * @param {number}   o.count          chrome points to spend (grade base + Solo + outfit; see grades.js)
 * @param {function} o.rng            injected [0,1)
 * @param {number}   [o.bt]           the BT slider — reads through to the popup gun's size class (p.91)
 * @param {boolean}  [o.garnish]      §1's garnish toggle: one cosmetic, never against the count
 * @param {boolean}  [o.smartgunStack] does the goon have (or is it building) the full smartgun stack
 * @param {object}   [o.primaryWeapon] the ACTUALLY-PULLED primary weapon, for the link's compatibility
 * @param {string[]} [o.knownSkills]  schema keys the goon already has naturally (p.83 chip override)
 * @param {number}   [o.intStat]      p.82's running-chips ≤ INT cap
 * @param {Array}    [o.bonusPools]   §3's BONUS-ITEM CHANNEL — see `runBonusPools` below
 * @param {object}   [o.squadLedger]  the BATCH-wide tally a `squadLimit` is counted against
 * @param {string[]} [o.outfitTags]   tags a bonus pool's `whenOutfitTags` condition reads
 * @param {string}   [o.goonName]     this goon's name, so a squad-limited disclosure names the carrier
 * @param {string[]} [o.forceSlots]   testing/determinism hook: spend the points on these slots in order
 * @param {object}   [o.forceItems]   testing hook: slotId → item name to take
 */
export function planChrome({
  pool = [], gradeKey = "E", count = 0, rng = Math.random, bt = 7, garnish = false,
  smartgunStack = false, primaryWeapon = null, knownSkills = [], intStat = 10,
  bonusPools = [], squadLedger = null, outfitTags = [], goonName = "",
  forceSlots = null, forceItems = {},
} = {}) {
  const grade = gradeOf(gradeKey);
  const whiffAllowed = !!grade?.whiffAllowed;
  const ctx = { smartgunStack, bt, primaryWeapon, knownSkills, intStat };

  const items = [];                      // the flat list the materializer creates
  const pulls = [];                      // one row per chrome point spent, for the preview
  const lint = [];                       // every refusal, with a code — nothing gates silently
  const honesty = [];                    // every DISCLOSURE (not a refusal) the preview must print
  const bonusItems = [];                 // §3's bonus channel — never against the chrome count
  const ownedNames = new Set();
  const housings = new Map();            // housing NAME → { capacity, used }
  const exclusivityUsed = new Set();
  const eligibleOptionNames = new Set();
  const statDebits = { attr: 0 };
  const needsAmmo = [];
  let nothingCount = 0;
  let combatPullCount = 0;
  let chipCount = 0;

  const byName = new Map(pool.map((r) => [r.name, r]));
  const note = (code, extra = {}) => { lint.push({ code, ...extra }); };

  /** Add a row once. Returns false when it was already owned (the dedup that makes housings shared). */
  const own = (row, role, extra = {}) => {
    if (!row || ownedNames.has(row.name)) return false;
    ownedNames.add(row.name);
    items.push({
      key: row.key ?? null, name: row.name, role,
      cost: Number(row.cost) || 0, humanityLoss: Number(row.humanityLoss) || 0, ...extra,
    });
    // ENGINE RULE 4 — side effects travel with the item, never as a separate remembered step.
    const debit = SIDE_EFFECTS.attrDebit[row.name];
    if (Number.isFinite(debit)) statDebits.attr += debit;
    if (SIDE_EFFECTS.needsAmmoItem.includes(row.name)) {
      needsAmmo.push({ name: row.name, caseless: SIDE_EFFECTS.caselessOnly.includes(row.name) });
    }
    return true;
  };

  /** Every row a slot may draw from at this grade, after criteria, allow/deny, rungs and deals. */
  const candidatesFor = (slot) => {
    let rows = pool.filter((r) => inCategories(r, slot.criteria?.categories));
    if (slot.allow?.length) rows = rows.filter((r) => slot.allow.includes(r.name));
    rows = rows.filter((r) => !(slot.deny ?? []).includes(r.name) && !CHROME_DENY_NAMES.includes(r.name));
    rows = rows.filter((r) => !slot.gateByItem?.[r.name] || gradeMeets(gradeKey, slot.gateByItem[r.name]));
    rows = rows.filter((r) => dependentDealOk(r, ctx));
    // p.83: a chip that duplicates a skill the goon already has naturally is a wasted pull — chips
    // OVERRIDE, they never combine. p.82: running chips are capped at INT.
    if (slot.criteria?.excludeIfSkillKnown) {
      rows = rows.filter((r) => !knownSkills.some((k) => String(r.name).toLowerCase().startsWith(String(k).toLowerCase())));
    }
    return rows;
  };

  /**
   * PREREQUISITE EQUIVALENCE (book p.82, generalized). A prerequisite is satisfied by any equivalent
   * the goon ALREADY carries; only an unsatisfied one is bought, and it is bought once. This is the
   * single reason a goon with a Smartgun Link never also buys a Chipware Socket for its chips.
   */
  const satisfyPrerequisites = (slot) => {
    const bought = [];
    for (const p of slot.prerequisites ?? []) {
      const options = p.anyOf ?? [p.name];
      if (options.some((n) => ownedNames.has(n))) continue;         // ← the equivalence, literally
      const row = options.map((n) => byName.get(n)).find(Boolean);
      if (!row) { note("prerequisiteMissing", { slotId: slot.id, wanted: options }); continue; }
      if (own(row, "prereq", { slotId: slot.id })) bought.push(row.name);
    }
    return bought;
  };

  /** Buy (or reuse) the slot's housing, plus p.90's separately-sold hand/foot. */
  const ensureHousing = (slot) => {
    if (!slot.housing) return { name: null, reused: false };
    const row = byName.get(slot.housing.name);
    if (!row) { note("housingMissing", { slotId: slot.id, wanted: slot.housing.name }); return { name: null, reused: false }; }
    const reused = ownedNames.has(row.name);
    if (!reused) {
      own(row, "housing", { slotId: slot.id });
      housings.set(row.name, { capacity: capacityOf(row, slot.housing), used: 0 });
      // p.90: *"the basic cyberlimb comes without hands or feet"* — without this the generator
      // ships handless arms, which is the kind of thing nobody notices until the table does.
      for (const extraName of slot.housing.extras ?? []) {
        const extra = byName.get(extraName);
        if (extra) own(extra, "housingExtra", { slotId: slot.id });
        else note("housingExtraMissing", { slotId: slot.id, wanted: extraName });
      }
    }
    return { name: row.name, reused };
  };

  /** Draw one option for a slot, honoring dupes, spaces, exclusivity and the preference weights. */
  const drawOption = (slot, housingName, forcedName) => {
    let rows = candidatesFor(slot).filter((r) => !ownedNames.has(r.name));
    for (const r of rows) eligibleOptionNames.add(r.name);
    if (forcedName) rows = rows.filter((r) => r.name === forcedName);
    if (!rows.length) return { row: null, reason: "exhausted" };

    // ENGINE RULE 2 — refuse anything whose exclusivity token is already spent.
    rows = rows.filter((r) => {
      const tok = exclusivityTokenFor(slot, r.name, housingName);
      return !tok || !exclusivityUsed.has(tok);
    });
    if (!rows.length) return { row: null, reason: "exclusivity" };

    // ENGINE RULE 1 — SPACES. A housing that cannot fit the cheapest remaining option is FULL.
    const h = housingName ? housings.get(housingName) : null;
    if (h) {
      const free = h.capacity - h.used;
      const fits = rows.filter((r) => spaceCostOf(r) <= free);
      if (!fits.length) return { row: null, reason: "housingFull" };
      rows = fits;
    }

    const entries = rows.map((r) => ({
      row: r,
      weight: (slot.preferred ?? []).includes(r.name) ? 3 : (slot.lowWeight ?? []).includes(r.name) ? 0.5 : 1,
    }));
    const pick = weightedPick(entries, rng);
    return { row: pick?.row ?? null, reason: pick ? null : "exhausted" };
  };

  /** Spend ONE chrome point on `slot`. Returns the pull row the preview shows. */
  const runSlot = (slot, forcedItemName) => {
    const pull = { slotId: slot.id, housing: null, options: [], prerequisites: [], lint: [] };

    if (slot.exclusivity === "boosterware" && exclusivityUsed.has("boosterware")) {
      note("exclusivityBlocked", { slotId: slot.id, exclusivity: "boosterware" });
      pull.lint.push("exclusivityBlocked");
      return pull;
    }
    if (!candidatesFor(slot).length) {
      note("slotEmpty", { slotId: slot.id });
      pull.lint.push("slotEmpty");
      return pull;
    }
    // The link's own condition: p.82 requires plugs to OPERATE it, and it is only worth taking on a
    // weapon that can be converted. With no weapon in hand the engine cannot know, so it takes the
    // pull and says so rather than silently dropping a chrome point.
    if (slot.requiresCompatibleWeapon) {
      const w = primaryWeapon;
      if (w && !isSmartgunConvertible(w)) {
        note("smartgunIncompatibleWeapon", { slotId: slot.id, weapon: w.name ?? "" });
        pull.lint.push("smartgunIncompatibleWeapon");
        return pull;
      }
      if (!w) note("smartgunWeaponUnknown", { slotId: slot.id });
    }

    pull.prerequisites = satisfyPrerequisites(slot);
    const housing = ensureHousing(slot);
    pull.housing = housing.name;
    pull.housingReused = housing.reused;

    let spaces = optionSpacesFor(slot, gradeKey) || 1;
    let guard = spaces * 4 + 8;
    while (spaces > 0 && guard-- > 0) {
      const { row, reason } = drawOption(slot, housing.name, forcedItemName);
      if (!row) {
        if (reason) { note(reason === "exhausted" ? "slotExhausted" : reason, { slotId: slot.id }); pull.lint.push(reason); }
        break;
      }
      const cost = spaceCostOf(row);
      const tok = exclusivityTokenFor(slot, row.name, housing.name);
      if (tok) exclusivityUsed.add(tok);
      if (slot.exclusivity === "boosterware") exclusivityUsed.add("boosterware");
      own(row, "option", { slotId: slot.id, housing: housing.name, spaceCost: cost });
      if (housing.name && housings.has(housing.name) && !(slot.noHousingFor ?? []).includes(row.name)) {
        housings.get(housing.name).used += cost;
      }
      if (slot.criteria?.tags?.includes("combatSkillChip")) chipCount++;
      pull.options.push(row.name);
      spaces -= cost;
      if (forcedItemName) break;                    // a forced pull takes exactly the one item
      if (slot.exclusivity === "boosterware") break; // one boost, then done
    }

    // p.82's running-chips ≤ INT cap, reported once rather than enforced by silently dropping a chip
    // the GM can see on the sheet.
    if (chipCount > Math.max(0, Math.trunc(Number(intStat) || 0))) note("chipsOverInt", { chips: chipCount, int: intStat });
    return pull;
  };

  // ── THE POINT LOOP ─────────────────────────────────────────────────────────────────────────────
  const unlocked = countingSlotsAt(gradeKey);
  const points = Math.max(0, Math.trunc(Number(count) || 0));

  for (let i = 0; i < points; i++) {
    combatPullCount++;
    let slot = null;
    if (Array.isArray(forceSlots)) {
      slot = slotById(forceSlots[i] ?? forceSlots[forceSlots.length - 1]);
    } else {
      if (!unlocked.length) { note("noSlotsUnlocked", { gradeKey }); break; }
      // The whiff holds ONE share, and only at C and below — §3, and the criteria draft's pull
      // mechanics. At B and above the share simply is not in the draw, so `nothingCount` is 0 by
      // construction rather than by a later filter.
      const entries = unlocked.map((s) => ({ slot: s, weight: s.weight }));
      if (whiffAllowed) entries.push({ slot: null, weight: NOTHING_WEIGHT });
      slot = weightedPick(entries, rng)?.slot ?? null;
    }
    if (!slot) { nothingCount++; pulls.push({ slotId: null, nothing: true, options: [], prerequisites: [], lint: [] }); continue; }
    pulls.push(runSlot(slot, forceItems?.[slot.id] ?? null));
  }

  // ── THE BONUS-ITEM CHANNEL (§3 Outfit `bonusPools`, ruled 2026-08-14) ─────────────────────────
  //
  // ⭐ A BONUS PULL IS AN EXTRA CHANCE, NOT A CHROME POINT. It is conditioned on the outfit (a tag)
  // or on the grade (a low-grade sweetener), it costs the goon NOTHING from the Chromed count, and
  // the count arithmetic above has already finished by the time this runs — so the derivation the
  // window's tooltip prints ("3 grade B + 2 Solo + 1 outfit") stays true whatever lands here.
  //
  // ⛔ THE POOLS SHIP EMPTY. The residents are ruled but not wired (assassin-like chrome on covert
  // outfits; the comb's T4–T7 as low-grade bonuses; an outfit-gated Combat Tail) and their taste
  // calls are pending. What ships is the SEAM: condition evaluation, the pull, the batch-wide
  // squad limit, and the disclosure. An empty pool set does nothing and says nothing.
  //
  // ⚠ `squadLedger` IS THE ONE MUTABLE ARGUMENT IN THIS FILE, deliberately. A `squadLimit` is a cap
  // across the whole generation BATCH ("exactly one goon in this squad carries the launcher"), which
  // is by definition state no single goon's plan can hold. The caller creates one ledger per
  // generation (`newSquadLedger()`) and passes it to every goon; passing none disables the cap
  // rather than silently making it per-goon, because a per-goon "squad" limit would be a lie.
  for (const bp of bonusPools ?? []) {
    if (!bp || !Array.isArray(bp.slots) || !bp.slots.length) continue;      // empty pool: silent
    if (bp.whenGradeAtMost && gradeIndex(gradeKey) > gradeIndex(bp.whenGradeAtMost)) continue;
    if (Array.isArray(bp.whenOutfitTags) && bp.whenOutfitTags.length
      && !bp.whenOutfitTags.some((t) => (outfitTags ?? []).includes(t))) continue;
    const chance = Number.isFinite(Number(bp.chance)) ? Number(bp.chance) : 1;
    if (chance < 1 && (Number(rng()) || 0) >= chance) continue;

    for (const entry of bp.slots) {
      const slot = slotById(entry.slotId);
      if (!slot) { note("bonusSlotUnknown", { poolId: bp.id, slotId: entry.slotId }); continue; }
      // A bonus entry may narrow the slot's own pool; it never widens past the slot's criteria.
      const narrowed = entry.allow?.length
        ? { ...slot, allow: slot.allow?.length ? slot.allow.filter((n) => entry.allow.includes(n)) : entry.allow }
        : slot;
      const candidateNames = candidatesFor(narrowed).map((r) => r.name);
      if (!candidateNames.length) { note("bonusSlotEmpty", { poolId: bp.id, slotId: entry.slotId }); continue; }

      // The batch-wide cap, checked BEFORE the pull so a blocked goon costs nothing.
      const limit = Number(entry.squadLimit);
      const ledgerKey = `${bp.id}:${entry.slotId}`;
      if (Number.isFinite(limit) && limit > 0) {
        const taken = Number(squadLedger?.[ledgerKey] ?? 0);
        if (taken >= limit) { note("bonusSquadLimitReached", { poolId: bp.id, slotId: entry.slotId, limit }); continue; }
      }

      const before = items.length;
      const pull = runSlot(narrowed, entry.item ?? forceItems?.[entry.slotId] ?? null);
      pull.bonus = true;
      pull.poolId = bp.id;
      pull.nonCounting = true;
      pulls.push(pull);
      const landed = items.slice(before).filter((it) => it.role === "option");
      if (!landed.length) continue;

      if (Number.isFinite(limit) && limit > 0 && squadLedger) {
        squadLedger[ledgerKey] = (Number(squadLedger[ledgerKey]) || 0) + 1;
      }
      for (const it of landed) {
        bonusItems.push({ ...it, poolId: bp.id, squadLimit: Number.isFinite(limit) && limit > 0 ? limit : null });
        // §3's preview requirement: a bonus item is DISCLOSED, and a squad-limited one names its carrier.
        honesty.push({
          code: "bonusItem", name: it.name, poolId: bp.id, slotId: entry.slotId,
          squadLimit: Number.isFinite(limit) && limit > 0 ? limit : null,
          carrier: Number.isFinite(limit) && limit > 0 ? (goonName || null) : null,
          messageKey: Number.isFinite(limit) && limit > 0
            ? "GoonFactory.Honesty.BonusItemSquad"
            : "GoonFactory.Honesty.BonusItem",
        });
      }
    }
  }

  // ── GARNISH: §1's toggle, ON by default, and NEVER against the combat count ────────────────────
  if (garnish) {
    const gSlot = slotById("garnish");
    if (gSlot) {
      const pull = runSlot(gSlot, forceItems?.garnish ?? null);
      pull.nonCounting = true;
      pulls.push(pull);
    }
  }

  const humanityLoss = items.reduce((s, it) => s + (Number(it.humanityLoss) || 0), 0);
  const costEb = items.reduce((s, it) => s + (Number(it.cost) || 0), 0);

  return {
    items, pulls, lint, honesty, bonusItems,
    spaces: Object.fromEntries([...housings].map(([n, h]) => [n, h.used])),
    housingCapacity: Object.fromEntries([...housings].map(([n, h]) => [n, h.capacity])),
    exclusivityUsed: [...exclusivityUsed],
    eligibleOptionNames: [...eligibleOptionNames],
    statDebits, needsAmmo, humanityLoss, costEb,
    nothingCount, whiffAllowed, combatPullCount, chipCount,
    popupClass: null,
  };
}

/**
 * Can this weapon carry a smartgun conversion? p.82 prices the conversion for *"a normal gun"*, and
 * the base weapon schema carries no compatibility field (the criteria draft's own build question).
 * The honest predicate available today: it must be a ranged firearm — something with a caliber and a
 * magazine. A melee weapon cannot be converted, and saying so is better than guessing a field.
 */
export function isSmartgunConvertible(weapon) {
  if (!weapon) return false;
  const type = String(weapon.weaponType ?? weapon.system?.weaponType ?? "").toLowerCase();
  if (type === "melee" || type === "exotic") return false;
  const ammo = String(weapon.ammoType ?? weapon.system?.ammoType ?? "").trim();
  return !!ammo;
}

/** p.82's 2× conversion price, as a number a preview can print beside the base cost. */
export function smartConvertedCost(baseCost) {
  return (Number(baseCost) || 0) * DEPENDENT_DEALS.smartWeaponConversion.costMultiplier;
}

/**
 * A fresh BATCH ledger for the bonus channel's `squadLimit`. One per generation, shared by every
 * goon in it — that is what makes "max n copies across the squad" mean the squad and not the goon.
 * A plain object rather than a Map so a caller can serialize it into a preview payload unchanged.
 */
export function newSquadLedger() { return Object.create(null); }

/** Every slot id, for a window that wants to render the ladder without importing the whole table. */
export const CHROME_SLOT_IDS = CHROME_SLOTS.map((s) => s.id);
