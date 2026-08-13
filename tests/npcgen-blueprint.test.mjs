/**
 * NPC GENERATOR — PURE-LAYER UNIT TESTS. Plain node, no Foundry, no Playwright, no rig:
 *
 *     node tests/npcgen-blueprint.test.mjs        # exit 0 = green
 *
 * This is the first NON-Playwright spec in tests/ (every other file here drives a browser), so it
 * carries its own two-line harness rather than importing one. The bar is the project's standing
 * testing policy: assert CONCRETE VALUES with fixed seeds, not shapes — a test that only checks
 * "returns an array" would pass against a generator that hands every NPC the same stats.
 *
 * Where an assertion is load-bearing enough that a plausible regression would slip past a weaker one,
 * the reason is written at the leg.
 */

import assert from "node:assert/strict";
import {
  npcBlueprint, placeholderName, rollStats, weightStats, allocateSkills, cyberwareCounts,
  armorWeaponRoll, armorWeaponRoleModifier, humanityFromChrome, empAfterChrome,
  breakpointAdvisories, armorBandFor, mergeArchetypes, seededRng, seedFrom, pickupPool,
  STAT_KEYS, STAT_ROLL_MIN, STAT_ROLL_MAX
} from "../module/npcgen/blueprint.js";
import {
  ARCHETYPES, TIERS, ARMOR_BREAKPOINTS, ARMOR_WEAPON_ROLE_MODIFIERS, ROLE_ENUM,
  SKILL_MAX_LEVEL, SEVER_NET_DAMAGE_MIN, STUN_FAIL_BASE, HIT_PCT, BOOK_CAREER_POOL,
  PLACEHOLDER_NAME_PREFIX, SKILL_DIAL, WEAPONS_DIAL, ARMOR_DIAL, TOUGHNESS_DIAL, CYBERWARE_ROLLS
} from "../module/npcgen/tables.js";

let passed = 0;
const failures = [];
function leg(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push({ name, e }); console.log(`  FAIL ${name}\n       ${e.message}`); }
}

/** A stub rng that replays a fixed list of [0,1) draws, then repeats the last one forever. */
function scriptedRng(draws) {
  let i = 0;
  return () => draws[Math.min(i++, draws.length - 1)];
}
/** The draw that makes rollDie(rng, s) return `face`. */
const face = (f, sides) => (f - 1) / sides + 0.5 / sides;

console.log("npcgen blueprint — pure layer");

// ---------------------------------------------------------------------------------------------
// DETERMINISM (the ruled Q14)
// ---------------------------------------------------------------------------------------------

leg("same seed twice ⇒ deep-equal blueprints", () => {
  const a = npcBlueprint({ archetype: "goon", dials: "veteran", count: 4, seed: 1234 });
  const b = npcBlueprint({ archetype: "goon", dials: "veteran", count: 4, seed: 1234 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 4);
});

leg("a different seed ⇒ different stats (the seed is actually used)", () => {
  const a = npcBlueprint({ dials: "veteran", count: 3, seed: 1 })[0];
  const b = npcBlueprint({ dials: "veteran", count: 3, seed: 2 })[0];
  assert.notDeepEqual(a.stats, b.stats);
});

leg("a string seed works and is stable", () => {
  const a = npcBlueprint({ count: 2, seed: "night-city" });
  const b = npcBlueprint({ count: 2, seed: "night-city" });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a[0].stats, npcBlueprint({ count: 2, seed: "night city" })[0].stats);
});

leg("per-NPC seeds are FOLDED, not added — seed 1/index 1 ≠ seed 2/index 0", () => {
  // The design sketch wrote seededRng(seed + i); under that scheme these two would be the same NPC,
  // so "reroll with the next seed" would hand back a squad member unchanged. This pins the fold.
  const s1 = npcBlueprint({ count: 2, seed: 1 })[1];
  const s2 = npcBlueprint({ count: 2, seed: 2 })[0];
  assert.notEqual(s1.seed, s2.seed);
  assert.notDeepEqual(s1.stats, s2.stats);
});

leg("every NPC in one squad rolls independently", () => {
  const squad = npcBlueprint({ dials: "elite", count: 6, seed: 99 });
  const seeds = new Set(squad.map((n) => n.seed));
  assert.equal(seeds.size, 6);
});

leg("count 0 ⇒ empty array; count 1 is the default", () => {
  assert.deepEqual(npcBlueprint({ count: 0, seed: 5 }), []);
  assert.equal(npcBlueprint({ seed: 5 }).length, 1);
});

// ---------------------------------------------------------------------------------------------
// ⛔ PLACEHOLDER NAMES — the 2026-08-13 hard rule
// ---------------------------------------------------------------------------------------------

leg("placeholderName is a sequence, exactly 'Goon 1'..'Goon N'", () => {
  assert.equal(placeholderName(1), "Goon 1");
  assert.equal(placeholderName(2), "Goon 2");
  assert.equal(placeholderName(17), "Goon 17");
  assert.equal(PLACEHOLDER_NAME_PREFIX, "Goon");
});

leg("a generated squad's names are the sequence, in order, with no invention", () => {
  const squad = npcBlueprint({ count: 5, seed: 7 });
  assert.deepEqual(squad.map((n) => n.name), ["Goon 1", "Goon 2", "Goon 3", "Goon 4", "Goon 5"]);
  // And the same names regardless of seed — a name that varies with the seed would be a name the
  // machine chose, which is exactly what the ruling forbids.
  const other = npcBlueprint({ count: 5, seed: 999999 });
  assert.deepEqual(other.map((n) => n.name), squad.map((n) => n.name));
});

// ---------------------------------------------------------------------------------------------
// STATS — 2D6 ×9, reroll 11+
// ---------------------------------------------------------------------------------------------

leg("rollStats: nine schema-ordered stats, every value in 2..10 over 400 seeds", () => {
  for (let s = 0; s < 400; s++) {
    const st = rollStats(seededRng(s));
    assert.deepEqual(Object.keys(st), STAT_KEYS);
    for (const k of STAT_KEYS) {
      assert.ok(st[k] >= STAT_ROLL_MIN && st[k] <= STAT_ROLL_MAX, `${k}=${st[k]} out of 2..10 at seed ${s}`);
    }
  }
});

leg("rollStats: an 11 and a 12 are REROLLED, and the reroll's value is what stands", () => {
  // Scripted: 5+6=11 (reroll), 6+6=12 (reroll), 2+1=3 → the first stat must be 3.
  const rng = scriptedRng([
    face(5, 6), face(6, 6),   // 11 → reroll
    face(6, 6), face(6, 6),   // 12 → reroll
    face(2, 6), face(1, 6),   // 3  → stands
    face(1, 6)                // every later die reads 1 ⇒ remaining stats are 2
  ]);
  const st = rollStats(rng);
  assert.equal(st.int, 3);
  assert.equal(st.ref, 2);
});

leg("rollStats: a hostile rng that always rolls 12 terminates and clamps to 10", () => {
  const st = rollStats(() => 0.999999);           // every die = 6 ⇒ every 2d6 = 12, forever
  for (const k of STAT_KEYS) assert.equal(st[k], STAT_ROLL_MAX);
});

leg("weightStats: the rolled MULTISET is preserved exactly (no free points)", () => {
  for (let s = 0; s < 200; s++) {
    const rolled = rollStats(seededRng(s));
    const weighted = weightStats(rolled, ARCHETYPES.goon.statWeights);
    const before = STAT_KEYS.map((k) => rolled[k]).sort((a, b) => a - b);
    const after = STAT_KEYS.map((k) => weighted[k]).sort((a, b) => a - b);
    assert.deepEqual(after, before, `multiset changed at seed ${s}`);
  }
});

leg("weightStats: the highest-weighted stat gets the highest roll", () => {
  const rolled = { int: 3, ref: 4, tech: 5, cool: 6, attr: 7, luck: 8, ma: 9, bt: 10, emp: 2 };
  const w = weightStats(rolled, { ref: 9, bt: 8, cool: 6, ma: 5, int: 4, tech: 3, luck: 3, attr: 2, emp: 1 });
  assert.equal(w.ref, 10);   // highest weight ⇒ highest value
  assert.equal(w.bt, 9);
  assert.equal(w.emp, 2);    // lowest weight ⇒ lowest value
});

leg("weightStats: ties break by schema order, so it is deterministic with no rng", () => {
  const rolled = { int: 9, ref: 8, tech: 7, cool: 6, attr: 5, luck: 4, ma: 3, bt: 2, emp: 10 };
  const flat = Object.fromEntries(STAT_KEYS.map((k) => [k, 1]));
  const a = weightStats(rolled, flat);
  const b = weightStats(rolled, flat);
  assert.deepEqual(a, b);
  assert.equal(a.int, 10);   // first in schema order takes the top value under a flat weighting
});

leg("pickupPool is the book's REF + INT", () => {
  assert.equal(pickupPool({ ref: 7, int: 5, bt: 9 }), 12);
});

// ---------------------------------------------------------------------------------------------
// SKILLS — the book's point economy
// ---------------------------------------------------------------------------------------------

const goonCareer = Object.entries(ARCHETYPES.goon.skillWeights)
  .map(([key, weight]) => ({ key, weight, special: key === ARCHETYPES.goon.specialAbilitySkill }));

leg("allocateSkills spends the pool EXACTLY — 40 points, 300 seeds, no drift", () => {
  // The failure this catches is a silent under-spend: a "40-point veteran" quietly built on 31.
  for (let s = 0; s < 300; s++) {
    const { skillLevels, spent, unspent } = allocateSkills(BOOK_CAREER_POOL, goonCareer, seededRng(s));
    const sum = skillLevels.reduce((t, r) => t + r.level, 0);
    assert.equal(sum, BOOK_CAREER_POOL, `sum ${sum} ≠ 40 at seed ${s}`);
    assert.equal(spent, BOOK_CAREER_POOL);
    assert.equal(unspent, 0);
  }
});

leg("allocateSkills: the special ability always ends at 1 or better (the book's must-include)", () => {
  for (let s = 0; s < 200; s++) {
    const { skillLevels } = allocateSkills(12, goonCareer, seededRng(s));
    const special = skillLevels.find((r) => r.skillKey === "CombatSense");
    assert.ok(special && special.level >= 1, `special ability missing at seed ${s}`);
  }
});

leg("allocateSkills: no level exceeds the book's creation ceiling of 10", () => {
  for (let s = 0; s < 200; s++) {
    const { skillLevels } = allocateSkills(60, goonCareer, seededRng(s));
    for (const r of skillLevels) assert.ok(r.level <= SKILL_MAX_LEVEL, `${r.skillKey}=${r.level} at seed ${s}`);
  }
});

leg("allocateSkills: a declared floor is met before the weighted spend", () => {
  for (let s = 0; s < 100; s++) {
    const { skillLevels } = allocateSkills(30, goonCareer, seededRng(s), { floors: { Handgun: 8 } });
    const hg = skillLevels.find((r) => r.skillKey === "Handgun");
    assert.ok(hg && hg.level >= 8, `floor unmet at seed ${s}`);
  }
});

leg("allocateSkills: an over-capacity pool reports the shortfall instead of hiding it", () => {
  const list = [{ key: "Handgun", weight: 1 }, { key: "Brawling", weight: 1 }];   // capacity = 20
  const r = allocateSkills(50, list, seededRng(3));
  assert.equal(r.capacity, 20);
  assert.equal(r.spent, 20);
  assert.equal(r.unspent, 30);
  assert.deepEqual(r.skillLevels.map((x) => x.level), [10, 10]);
});

leg("allocateSkills: weight actually steers the spend", () => {
  // Aggregate evidence over 50 seeds: a 9-weighted skill must out-total a 1-weighted one by more
  // than 2×. ⚠ The pool must sit BELOW the list's capacity (2 entries × 10 = 20) or both entries
  // saturate and the weighting is invisible — which is exactly how this leg first failed.
  let heavy = 0, light = 0;
  for (let s = 0; s < 50; s++) {
    const { skillLevels } = allocateSkills(10, [
      { key: "Handgun", weight: 9 }, { key: "Stealth", weight: 1 }
    ], seededRng(s));
    heavy += skillLevels.find((r) => r.skillKey === "Handgun")?.level ?? 0;
    light += skillLevels.find((r) => r.skillKey === "Stealth")?.level ?? 0;
  }
  assert.ok(heavy > light * 2, `weighting had no effect: ${heavy} vs ${light}`);
});

// ---------------------------------------------------------------------------------------------
// CYBERWARE — counts only
// ---------------------------------------------------------------------------------------------

leg("cyberwareCounts: the book's base — solo 6×, everyone else 3×", () => {
  assert.equal(CYBERWARE_ROLLS.solo, 6);
  assert.equal(CYBERWARE_ROLLS.default, 3);
  assert.equal(cyberwareCounts("solo", {}, seededRng(1)).roleBase, 6);
  assert.equal(cyberwareCounts("cop", {}, seededRng(1)).roleBase, 3);
  assert.equal(cyberwareCounts("techie", {}, seededRng(1)).roleBase, 3);
});

leg("cyberwareCounts: DUPLICATES ARE REROLLED — every result is distinct, 300 seeds", () => {
  for (let s = 0; s < 300; s++) {
    const { results, rolls, count } = cyberwareCounts("solo", { cyberwareRollsDelta: 3 }, seededRng(s));
    assert.equal(rolls, 9);
    assert.equal(count, 9);
    assert.equal(new Set(results).size, results.length, `duplicate face at seed ${s}: ${results}`);
    for (const f of results) assert.ok(f >= 1 && f <= 10, `d10 face ${f} out of range`);
  }
});

leg("cyberwareCounts: the tier delta adds, and the count can never exceed the die's faces", () => {
  assert.equal(cyberwareCounts("cop", { cyberwareRollsDelta: 2 }, seededRng(4)).rolls, 5);
  assert.equal(cyberwareCounts("solo", { cyberwareRollsDelta: 9 }, seededRng(4)).rolls, 10);
});

leg("cyberwareCounts: the archetype override beats the role base (the Goon's 3, not the Solo's 6)", () => {
  const r = cyberwareCounts("solo", {}, seededRng(2), { rollsOverride: ARCHETYPES.goon.cyberwareRollsOverride });
  assert.equal(r.roleBase, 3);
  assert.equal(r.rolls, 3);
});

leg("cyberwareCounts: a hostile constant rng terminates rather than rerolling forever", () => {
  const r = cyberwareCounts("solo", {}, () => 0.5);    // always the same face
  assert.equal(r.results.length, 1);
  assert.equal(r.rolls, 6);
});

leg("humanityFromChrome sums the system's humanityLoss field, and EMP may go NEGATIVE", () => {
  const items = [
    { system: { humanityLoss: 4 } }, { system: { humanityLoss: 2 } },
    { system: { humanityLoss: 0 } }, { system: {} }
  ];
  assert.deepEqual(humanityFromChrome(items), { loss: 6, counted: 2, items: 4 });
  assert.deepEqual(empAfterChrome(7, 6), { humanity: 64, emp: 6 });
  // Ruled: "track it, even into negative — let it happen and let them figure it out."
  assert.deepEqual(empAfterChrome(3, 45), { humanity: -15, emp: -2 });
});

// ---------------------------------------------------------------------------------------------
// THE ARMOR & WEAPON ROLL
// ---------------------------------------------------------------------------------------------

leg("armorWeaponRoll: 1D10 + modifier, die in 1..10 over 300 seeds", () => {
  for (let s = 0; s < 300; s++) {
    const r = armorWeaponRoll(3, seededRng(s));
    assert.ok(r.die >= 1 && r.die <= 10, `die ${r.die} at seed ${s}`);
    assert.equal(r.mod, 3);
    assert.equal(r.total, r.die + 3);
  }
  assert.deepEqual(armorWeaponRoll(2, scriptedRng([face(7, 10)])), { die: 7, mod: 2, total: 9 });
});

leg("the book's per-role modifiers, by value: Solo +3 · Nomad/Cop +2 · the rest +0", () => {
  assert.equal(armorWeaponRoleModifier("solo").mod, 3);
  assert.equal(armorWeaponRoleModifier("nomad").mod, 2);
  assert.equal(armorWeaponRoleModifier("cop").mod, 2);
  for (const r of ["rocker", "corp", "netrunner", "fixer", "techie"]) {
    assert.equal(armorWeaponRoleModifier(r).mod, 0, `${r} should be +0`);
  }
  // The two the extracted book list does not name are defaulted AND flagged as ours.
  assert.equal(armorWeaponRoleModifier("media").inBook, false);
  assert.equal(armorWeaponRoleModifier("medtechie").inBook, false);
  assert.equal(armorWeaponRoleModifier("solo").inBook, true);
  // Every enum role has an entry — an unlisted role would silently roll +0 with no flag.
  for (const r of ROLE_ENUM) assert.ok(ARMOR_WEAPON_ROLE_MODIFIERS[r], `no modifier row for ${r}`);
});

// ---------------------------------------------------------------------------------------------
// ARMOR BREAKPOINT ADVISORIES — asserted at the exact boundary values
// ---------------------------------------------------------------------------------------------

leg("breakpointAdvisories: nothing below SP 18", () => {
  assert.equal(breakpointAdvisories(0).crossed.length, 0);
  assert.equal(breakpointAdvisories(17).crossed.length, 0);
  assert.equal(breakpointAdvisories(17).highest, null);
});

leg("breakpointAdvisories: SP 18 and 19 cross exactly one — heavy-pistol-proof", () => {
  for (const sp of [18, 19]) {
    const a = breakpointAdvisories(sp);
    assert.equal(a.crossed.length, 1, `SP ${sp}`);
    assert.equal(a.highest.key, "heavyPistolProof");
  }
});

leg("breakpointAdvisories: SP 20..24 cross two", () => {
  for (const sp of [20, 22, 24]) {
    const a = breakpointAdvisories(sp);
    assert.equal(a.crossed.length, 2, `SP ${sp}`);
    assert.equal(a.highest.key, "smallArmsHard");
  }
});

leg("breakpointAdvisories: SP 25 is the immunity cliff, and 24 is NOT", () => {
  assert.equal(breakpointAdvisories(24).highest.key, "smallArmsHard");
  assert.equal(breakpointAdvisories(25).highest.key, "immunityCliff");
  assert.equal(breakpointAdvisories(25).crossed.length, 3);
  assert.equal(breakpointAdvisories(29).crossed.length, 3);
});

leg("breakpointAdvisories: SP 30+ crosses all four, powered-armor tier", () => {
  assert.equal(breakpointAdvisories(30).crossed.length, 4);
  assert.equal(breakpointAdvisories(30).highest.key, "poweredArmorTier");
  assert.equal(breakpointAdvisories(80).crossed.length, 4);
  assert.deepEqual(breakpointAdvisories(30).crossed.map((b) => b.key),
    ["heavyPistolProof", "smallArmsHard", "immunityCliff", "poweredArmorTier"]);
});

leg("breakpointAdvisories: the thresholds themselves are 18 / 20 / 25 / 30, ascending", () => {
  assert.deepEqual(ARMOR_BREAKPOINTS.map((b) => b.minSp), [18, 20, 25, 30]);
  assert.equal(ARMOR_BREAKPOINTS[3].maxSp, null);            // open-ended: there is NO ceiling
  assert.deepEqual(breakpointAdvisories(null).crossed, []);  // a missing SP advises nothing
});

leg("armorBandFor reports the printed C/D overlap at SP 10 instead of silently resolving it", () => {
  const at10 = armorBandFor(10);
  assert.equal(at10.ambiguous, true);
  assert.deepEqual(at10.candidates, ["D", "C"]);
  assert.equal(armorBandFor(9).ambiguous, false);
  assert.equal(armorBandFor(9).band.key, "D");
  assert.equal(armorBandFor(11).band.key, "C");
});

// ---------------------------------------------------------------------------------------------
// TIER PRESETS — the Lorekeeper rows, with the two corrections
// ---------------------------------------------------------------------------------------------

leg("the four tiers are MOOK / VETERAN / ELITE / HEAVY, in order", () => {
  assert.deepEqual(TIERS.map((t) => t.key), ["mook", "veteran", "elite", "heavy"]);
});

leg("the benchmark rows carry the Lorekeeper's values verbatim", () => {
  assert.deepEqual(TIERS.map((t) => t.benchmark.atk), [8, 10, 12, 14]);
  assert.deepEqual(TIERS.map((t) => t.benchmark.damage), ["2d6+1", "2d6+3", "3d6", "4d6"]);
  assert.deepEqual(TIERS.map((t) => t.benchmark.sp), [4, 10, 12, 18]);
  assert.deepEqual(TIERS.map((t) => t.benchmark.bt), [5, 7, 9, 10]);
  assert.deepEqual(TIERS.map((t) => t.benchmark.armorKind), ["soft", "soft", "skinweave", "hard"]);
});

leg("CORRECTION A — sever/head is net damage > 8, i.e. 9+, not the card's 8+", () => {
  assert.equal(SEVER_NET_DAMAGE_MIN, 9);
  // The card's own example calls a 2d6+1 average of 8 an amputator. Under the module's rule it is not.
  assert.ok(8 < SEVER_NET_DAMAGE_MIN, "avg 8 must sit UNDER the sever line");
});

leg("CORRECTION B — stun-fail is (10 − BT + wound) × 10, so every tier is one rung sturdier", () => {
  assert.equal(STUN_FAIL_BASE, 10);
  for (const t of TIERS) {
    assert.equal(t.stunFailFirstWoundPct, (STUN_FAIL_BASE - t.benchmark.bt) * 10,
      `${t.key}: stun-fail does not match the corrected formula`);
  }
  // Pinned by value, because reverting to the card's (11 − BT) × 10 would give 60/40/20/10 and this
  // is the assertion that catches it.
  assert.deepEqual(TIERS.map((t) => t.stunFailFirstWoundPct), [50, 30, 10, 0]);
  // ⚠ The number is stored TWICE — once per tier row and once per Toughness dial rung — so it has to
  // be asserted twice. A mutation test caught exactly this: editing the dial's copy alone passed.
  assert.deepEqual(TOUGHNESS_DIAL.map((r) => r.stunFailFirstWoundPct), [50, 30, 10, 0]);
  for (const r of TOUGHNESS_DIAL) {
    assert.equal(r.stunFailFirstWoundPct, (STUN_FAIL_BASE - r.bt) * 10, `dial ${r.key}`);
  }
  // And the two copies must agree with each other, rung for rung.
  for (const t of TIERS) {
    const rung = TOUGHNESS_DIAL.find((r) => r.key === t.dials.toughness);
    assert.equal(rung.bt, t.benchmark.bt, `${t.key}: tier BT and its Toughness rung disagree`);
    assert.equal(rung.stunFailFirstWoundPct, t.stunFailFirstWoundPct, `${t.key}: stun-fail copies disagree`);
  }
});

leg("tier monotonicity: every additive build number rises with the tier", () => {
  const rising = [
    ["careerPool", (t) => t.build.careerPool],
    ["weaponSkillPoints", (t) => t.build.weaponSkillPoints],
    ["cyberwareRollsDelta", (t) => t.build.cyberwareRollsDelta],
    ["armorWeaponRollModifier", (t) => t.build.armorWeaponRollModifier],
    ["loadoutBudgetEb", (t) => t.build.loadoutBudgetEb],
    ["benchmark.atk", (t) => t.benchmark.atk],
    ["benchmark.sp", (t) => t.benchmark.sp],
    ["benchmark.bt", (t) => t.benchmark.bt]
  ];
  for (const [label, read] of rising) {
    for (let i = 1; i < TIERS.length; i++) {
      assert.ok(read(TIERS[i]) > read(TIERS[i - 1]), `${label} did not rise at ${TIERS[i].key}`);
    }
  }
  // Toughness rises ⇒ the stun-fail percentage FALLS. Same ladder, opposite sign.
  for (let i = 1; i < TIERS.length; i++) {
    assert.ok(TIERS[i].stunFailFirstWoundPct < TIERS[i - 1].stunFailFirstWoundPct, `stun-fail at ${TIERS[i].key}`);
  }
  // Weapons rung is INVERTED (1 = best) and the Lorekeeper ladder never reaches rung 1, so it is
  // asserted non-increasing rather than strictly falling. Documented in tables.js at the heavy row.
  for (let i = 1; i < TIERS.length; i++) {
    assert.ok(TIERS[i].dials.weapons <= TIERS[i - 1].dials.weapons, `weapons rung at ${TIERS[i].key}`);
  }
});

leg("the book's 40-point career package anchors the VETERAN rung, unmodified", () => {
  assert.equal(BOOK_CAREER_POOL, 40);
  assert.equal(TIERS.find((t) => t.key === "veteran").build.careerPool, 40);
});

leg("the dials: skill points 2/4/6/8/10 with the book's own REF-8 arithmetic closing", () => {
  assert.deepEqual(SKILL_DIAL.map((r) => r.weaponSkillPoints), [2, 4, 6, 8, 10]);
  for (const r of SKILL_DIAL) assert.equal(r.rollAtRef8, r.weaponSkillPoints + 8);
  assert.deepEqual(WEAPONS_DIAL.map((r) => r.rung), [5, 4, 3, 2, 1]);   // weakest first, inverted axis
  assert.deepEqual(ARMOR_DIAL.map((r) => r.key), ["E", "D", "C", "B", "A"]);
  assert.equal(ARMOR_DIAL.find((r) => r.key === "C").overlapsPrevious, true);   // the printed defect
  assert.deepEqual(TOUGHNESS_DIAL.map((r) => r.bt), [5, 7, 9, 10]);
  assert.equal(HIT_PCT.cap, 90);
});

// ---------------------------------------------------------------------------------------------
// THE ARCHETYPE — one, placeholder, stackable
// ---------------------------------------------------------------------------------------------

leg("⛔ exactly ONE archetype ships, and it is marked PLACEHOLDER", () => {
  assert.deepEqual(Object.keys(ARCHETYPES), ["goon"]);
  assert.equal(ARCHETYPES.goon.placeholder, true);
});

leg("the archetype writes a LEGAL system.role.value and carries a special ability", () => {
  assert.ok(ROLE_ENUM.includes(ARCHETYPES.goon.role), "off-enum role");
  assert.equal(ARCHETYPES.goon.specialAbilitySkill, "CombatSense");
  assert.ok(ARCHETYPES.goon.skillWeights.CombatSense > 0, "special ability missing from the career list");
});

leg("mergeArchetypes: weights ADD, slots CONCATENATE, subs UNION, scalars LAST-WINS", () => {
  // An ad-hoc test modifier — deliberately NOT a shipped archetype, per the no-invention ruling.
  const TEST_MODIFIER = {
    key: "test-modifier", role: "cop", primaryWeaponSkill: "Rifle",
    statWeights: { ref: 1, tech: 5 }, skillWeights: { Handgun: 1, Rifle: 7 },
    loadoutSlots: [{ slot: "longarm", category: "Weapons", sub: "Rifles", min: 1, max: 1 }],
    cyberware: { subs: ["Neuralware", "Chipware"], allowFbc: true }
  };
  const m = mergeArchetypes(ARCHETYPES.goon, TEST_MODIFIER);
  assert.equal(m.statWeights.ref, ARCHETYPES.goon.statWeights.ref + 1);
  assert.equal(m.statWeights.tech, ARCHETYPES.goon.statWeights.tech + 5);
  assert.equal(m.skillWeights.Handgun, ARCHETYPES.goon.skillWeights.Handgun + 1);
  assert.equal(m.skillWeights.Rifle, 7);
  assert.equal(m.loadoutSlots.length, ARCHETYPES.goon.loadoutSlots.length + 1);
  assert.equal(m.role, "cop");                       // last wins
  assert.equal(m.primaryWeaponSkill, "Rifle");       // last wins
  assert.equal(m.cyberware.allowFbc, true);          // any layer may open it
  assert.ok(m.cyberware.subs.includes("Chipware") && m.cyberware.subs.includes("Cyberoptics"));
  assert.equal(new Set(m.cyberware.subs).size, m.cyberware.subs.length, "union produced duplicates");
  assert.equal(m.placeholder, true, "a placeholder layer must taint the stack");
  assert.deepEqual(m.layers, ["goon", "test-modifier"]);
  // The inputs are not mutated.
  assert.equal(ARCHETYPES.goon.statWeights.ref, 9);
  assert.equal(ARCHETYPES.goon.loadoutSlots.length, 4);
});

// ---------------------------------------------------------------------------------------------
// THE WHOLE BLUEPRINT
// ---------------------------------------------------------------------------------------------

leg("a blueprint carries exactly the ruled fields, all plain data", () => {
  const [n] = npcBlueprint({ archetype: "goon", dials: "veteran", count: 1, seed: 42 });
  for (const k of ["name", "stats", "skillLevels", "loadoutSlots", "cyberwareCountPlan", "role", "seed"]) {
    assert.ok(k in n, `missing ${k}`);
  }
  assert.equal(typeof n.seed, "number");
  assert.ok(ROLE_ENUM.includes(n.role));
  assert.equal(JSON.parse(JSON.stringify(n)).name, n.name);   // serializable: no class, no document
});

leg("the Skill dial reaches the sheet: the primary weapon skill meets the tier's floor", () => {
  for (const [tier, points] of [["mook", 2], ["veteran", 4], ["elite", 6], ["heavy", 8]]) {
    for (let s = 0; s < 40; s++) {
      const [n] = npcBlueprint({ dials: tier, count: 1, seed: s });
      const hg = n.skillLevels.find((r) => r.skillKey === "Handgun");
      assert.ok(hg && hg.level >= points, `${tier} seed ${s}: Handgun ${hg?.level} < ${points}`);
    }
  }
});

leg("the tier's career pool is spent in full on every generated NPC", () => {
  for (const t of TIERS) {
    const squad = npcBlueprint({ dials: t.key, count: 8, seed: 77 });
    for (const n of squad) {
      const sum = n.skillLevels.reduce((a, r) => a + r.level, 0);
      assert.equal(sum, t.build.careerPool, `${t.key}: spent ${sum} of ${t.build.careerPool}`);
      assert.equal(n.plan.pointsUnspent, 0);
    }
  }
});

leg("the Weapons dial reaches the loadout: the primary slot's categories come from the rung", () => {
  const [mook] = npcBlueprint({ dials: "mook", count: 1, seed: 3 });      // rung 3 — large handguns/rifles
  const primaryMook = mook.loadoutSlots.find((s) => s.slot === "primary");
  assert.deepEqual(primaryMook.categories.map((c) => c.sub), ["Pistols", "Rifles"]);
  const [heavy] = npcBlueprint({ dials: "heavy", count: 1, seed: 3 });    // rung 2 — automatic weapons
  const primaryHeavy = heavy.loadoutSlots.find((s) => s.slot === "primary");
  assert.deepEqual(primaryHeavy.categories.map((c) => c.sub), ["SMGs", "Shotguns"]);
  // And a free dial override moves it without touching the tier.
  const [odd] = npcBlueprint({ dials: { tier: "mook", weapons: 1 }, count: 1, seed: 3 });
  assert.deepEqual(odd.loadoutSlots.find((s) => s.slot === "primary").categories.map((c) => c.sub),
    ["Rifles", "Heavy", "Exotic"]);
});

leg("the Armor dial reaches the loadout, and carries its advisories with it", () => {
  const [n] = npcBlueprint({ dials: "heavy", count: 1, seed: 11 });
  const armor = n.loadoutSlots.find((s) => s.slot === "armor");
  assert.deepEqual(armor.spBand, { min: 10, max: 20, key: "C" });
  assert.deepEqual(armor.advisories, ["heavyPistolProof", "smallArmsHard"]);   // SP 20 band top
  // Band B (SP 25) is where the immunity cliff shows up — and it is an ADVISORY, not a refusal.
  const [b] = npcBlueprint({ dials: { tier: "heavy", armor: "B" }, count: 1, seed: 11 });
  assert.deepEqual(b.loadoutSlots.find((s) => s.slot === "armor").advisories,
    ["heavyPistolProof", "smallArmsHard", "immunityCliff"]);
});

leg("the cyberware plan is a COUNT and a set of subs — never an item", () => {
  const [n] = npcBlueprint({ dials: "elite", count: 1, seed: 21 });
  assert.equal(n.cyberwareCountPlan.rolls, 3 + 2);                    // goon override 3 + elite delta 2
  assert.equal(n.cyberwareCountPlan.count, 5);
  assert.equal(new Set(n.cyberwareCountPlan.faces).size, 5);
  assert.equal(n.cyberwareCountPlan.allowFbc, false);
  assert.ok(n.cyberwareCountPlan.subs.includes("Cyberoptics"));
  assert.ok(!("itemId" in n.cyberwareCountPlan) && !("packId" in n.cyberwareCountPlan));
});

leg("the plan records the tier's calibration and the roll it made, for the preview", () => {
  const [n] = npcBlueprint({ dials: "veteran", count: 1, seed: 8 });
  assert.equal(n.plan.tier, "veteran");
  assert.deepEqual(n.plan.dials, { skill: "D", weapons: 2, armor: "D", toughness: "bt7" });
  assert.equal(n.plan.benchmark.atk, 10);
  assert.equal(n.plan.stunFailFirstWoundPct, 30);
  assert.equal(n.plan.archetypePlaceholder, true);
  // Solo (+3 by the book) plus the veteran tier's own +1.
  assert.equal(n.plan.armorWeaponRoll.mod, 4);
  assert.equal(n.plan.armorWeaponRoll.total, n.plan.armorWeaponRoll.die + 4);
  assert.equal(n.plan.pickupPool, n.stats.ref + n.stats.int);
  assert.equal(n.plan.advancedNpc, false);
  assert.equal(npcBlueprint({ dials: "elite", count: 1, seed: 8 })[0].plan.advancedNpc, true);
});

leg("an unknown archetype throws rather than generating something arbitrary", () => {
  assert.throws(() => npcBlueprint({ archetype: "nope", count: 1, seed: 1 }), /unknown archetype/);
});

leg("seedFrom is an FNV-1a spreader: stable, order-sensitive, unsigned 32-bit", () => {
  assert.equal(seedFrom("a", 1), seedFrom("a", 1));
  assert.notEqual(seedFrom("a", 1), seedFrom(1, "a"));
  const v = seedFrom("night-city", "goon", "mook", 0);
  assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff);
});

// ---------------------------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`\nFAIL ${f.name}\n${f.e.stack}`);
  process.exit(1);
}
