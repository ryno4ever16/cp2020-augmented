/**
 * GOON FACTORY — PURE-LAYER UNIT SUITE. Plain node, no Foundry, no Playwright, no rig:
 *
 *     node tests/npcgen-goonfactory.test.mjs        # exit 0 = green
 *
 * Sibling of tests/npcgen-blueprint.test.mjs (the pre-rebuild engine's own suite, which stays green:
 * the ENGINE survives, the window is rebuilt). This file covers the Goon Factory additions —
 * GOON-FACTORY-SPEC.md §2 (the pipeline), §3 (the data schemas incl. the Slot compound-pull model and
 * its four engine rules), and every §4 keeper requirement that can be answered without a running VTT.
 * The rest of §4 (gating, locked-control inertness, EMP survives actor prep, EMP-0 fires no dialogs,
 * prototype-token vision, numbering across real generations) is the rig keeper's half:
 * tests/cp2020-augmented-goon-factory.mjs.
 *
 * The bar is the standing testing policy: fixed seeds, CONCRETE VALUES, and a negative case beside
 * every positive one. Every leg here was written and run RED before the module it imports existed.
 *
 * Each section imports through `load()` so a missing/broken module reports as N failing legs with a
 * readable reason instead of one import throw that hides the whole suite.
 */

import assert from "node:assert/strict";

let passed = 0;
const failures = [];
function leg(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push({ name, e }); console.log(`  FAIL ${name}\n       ${e.message}`); }
}
async function load(path) {
  try { return await import(path); }
  catch (e) { return { __loadError: e }; }
}
/** Guard a section on its module having loaded, so one missing file is N honest reds, not a crash. */
function section(title, mod, body) {
  console.log(`\n${title}`);
  if (mod.__loadError) { leg(`${title} — module loads`, () => { throw mod.__loadError; }); return; }
  body();
}

/** A stub rng replaying fixed [0,1) draws, then repeating the last forever. */
function scriptedRng(draws) { let i = 0; return () => draws[Math.min(i++, draws.length - 1)]; }

const GR  = await load("../module/npcgen/grades.js");
const SL  = await load("../module/npcgen/slots.js");
const CH  = await load("../module/npcgen/chrome.js");
const AR  = await load("../module/npcgen/armor.js");
const OU  = await load("../module/npcgen/outfits.js");
const BP  = await load("../module/npcgen/blueprint.js");
const TB  = await load("../module/npcgen/tables.js");
/** The SCHEMA's own role enum — the random draw's pool is derived from it, so legs read it here. */
const TB_ROLE_ENUM = TB.ROLE_ENUM ?? [];

console.log("goon factory — pure layer");

// =================================================================================================
// §3 GRADES — the six-rung ladder and everything a grade pick derives
// =================================================================================================

section("§3 grades", GR, () => {
  leg("six grades, in ladder order E→AA", () => {
    assert.deepEqual(GR.GRADE_KEYS, ["E", "D", "C", "B", "A", "AA"]);
  });

  leg("skill points per grade are the spec's 2/4/6/8/10/10", () => {
    assert.deepEqual(GR.GRADE_KEYS.map((k) => GR.GRADES[k].skillPts), [2, 4, 6, 8, 10, 10]);
  });

  leg("chrome base per grade is the spec's 0/1/2/3/4/6", () => {
    assert.deepEqual(GR.GRADE_KEYS.map((k) => GR.GRADES[k].chromeBase), [0, 1, 2, 3, 4, 6]);
  });

  leg("REF default is 8 at every grade EXCEPT AA, which is 10 (the sole tier exception)", () => {
    assert.deepEqual(GR.GRADE_KEYS.map((k) => GR.GRADES[k].refDefault), [8, 8, 8, 8, 8, 10]);
  });

  leg("BT default is a CONSTANT 7 at every grade — never grade-derived", () => {
    assert.deepEqual(GR.GRADE_KEYS.map((k) => GR.GRADES[k].btDefault), [7, 7, 7, 7, 7, 7]);
  });

  leg("whiff (\"Nothing\" chrome result) is allowed at C and below only", () => {
    assert.deepEqual(GR.GRADE_KEYS.map((k) => GR.GRADES[k].whiffAllowed), [true, true, true, false, false, false]);
  });

  leg("armor band letter tracks the grade letter", () => {
    assert.deepEqual(GR.GRADE_KEYS.map((k) => GR.GRADES[k].armorBand), ["E", "D", "C", "B", "A", "AA"]);
  });

  leg("weapons rung descends as the grade climbs (the book axis runs inverted)", () => {
    const rungs = GR.GRADE_KEYS.map((k) => GR.GRADES[k].weaponsRung);
    for (let i = 1; i < rungs.length; i++) assert.ok(rungs[i] <= rungs[i - 1], `rung rose at ${i}: ${rungs}`);
    assert.equal(rungs[0], 5);
    assert.equal(rungs[4], 1);
  });

  // ── count clamp (§1: free entry, cap 12, VISIBLE clamp) ──
  leg("count clamps to 12 and reports that it clamped", () => {
    assert.deepEqual(GR.clampCount(30), { value: 12, clamped: true });
    assert.deepEqual(GR.clampCount(6), { value: 6, clamped: false });
    assert.deepEqual(GR.clampCount(0), { value: 1, clamped: true });
    assert.deepEqual(GR.clampCount("nonsense"), { value: GR.COUNT.default, clamped: false });
  });

  // ⭐ R4 (ruled 2026-08-14): the count a user who has never typed one sees is ONE, not six. The
  // remembered value is the window's half of the ruling (npcgen-app.js `goonCountLast`); this is the
  // floor it falls back to, and it is asserted by VALUE because "the default" is exactly what moved.
  leg("the count default is 1, and an unreadable entry falls back to it rather than to six", () => {
    assert.equal(GR.COUNT.default, 1);
    assert.equal(GR.COUNT.min, 1);
    assert.equal(GR.COUNT.cap, 12);
    // an emptied field parses to NaN in the window (parseInt("")), which is the fall-back path
    assert.deepEqual(GR.clampCount(NaN), { value: 1, clamped: false });
    assert.deepEqual(GR.clampCount(1), { value: 1, clamped: false });
    // the NEGATIVE case: a real entry is never overwritten by the default
    assert.deepEqual(GR.clampCount(7), { value: 7, clamped: false });
  });

  // ── skill-points reservation arithmetic (§1 + §4) ──
  leg("skill-point breakdown reserves the grade's weapon points and floors on them", () => {
    const b = GR.skillPointBreakdown(40, "B");
    assert.equal(b.total, 40);
    assert.equal(b.reserved, 8);            // grade B = 8 weapon-skill points
    assert.equal(b.toPackage, 32);          // the spec's own worked example: "40 — 8 reserved … · 32"
    assert.equal(b.floor, 8);               // dynamic floor = the reservation
    assert.equal(b.clamped, false);
  });

  leg("a skill-point total BELOW the reservation clamps up to it, visibly", () => {
    const b = GR.skillPointBreakdown(3, "A");
    assert.equal(b.reserved, 10);
    assert.equal(b.total, 10);
    assert.equal(b.toPackage, 0);
    assert.equal(b.clamped, true);
  });

  // ── stat-pool reservation arithmetic (§1 + §4) ──
  leg("stat-pool breakdown reserves REF+BT only and floors at reservations + 7×2", () => {
    const b = GR.statPoolBreakdown(60, 8, 7);
    assert.equal(b.reserved, 15);
    assert.equal(b.floor, 15 + 14);         // 7 free stats × the 2 minimum
    assert.equal(b.pool, 60);
    assert.equal(b.free, 45);
    assert.equal(b.clamped, false);
  });

  leg("a stat pool below the dynamic floor clamps UP to the floor", () => {
    const b = GR.statPoolBreakdown(20, 10, 10);
    assert.equal(b.reserved, 20);
    assert.equal(b.floor, 34);
    assert.equal(b.pool, 34);
    assert.equal(b.clamped, true);
  });

  leg("the stat pool ceiling is 90 and clamps down", () => {
    assert.equal(GR.STAT_POOL.ceiling, 90);
    assert.equal(GR.statPoolBreakdown(200, 8, 7).pool, 90);
    assert.equal(GR.statPoolBreakdown(200, 8, 7).clamped, true);
  });

  leg("stat pool ticks name the book tiers 50/60/70/75/80 and default is 60", () => {
    assert.deepEqual(GR.STAT_POOL.ticks.map((t) => t.value), [50, 60, 70, 75, 80]);
    assert.equal(GR.STAT_POOL.default, 60);
  });

  // ── chrome count formula (§1) ──
  leg("chrome count = grade base + Solo bonus + outfit modifier, with the derivation carried", () => {
    const c = GR.chromeCountFor("B", "solo", 1);
    assert.equal(c.base, 3);
    assert.equal(c.soloBonus, 2);
    assert.equal(c.outfitMod, 1);
    assert.equal(c.count, 6);               // the spec's own tooltip example: "3 grade B + 2 Solo + 1 outfit"
  });

  leg("a non-Solo role draws no Solo bonus", () => {
    const c = GR.chromeCountFor("B", "cop", 0);
    assert.equal(c.soloBonus, 0);
    assert.equal(c.count, 3);
  });

  leg("chrome count never goes negative on a negative outfit modifier", () => {
    assert.equal(GR.chromeCountFor("E", "cop", -3).count, 0);
  });

  // ── roles (§1: NETRUNNER OMITTED — standing needle) ──
  leg("the generator's role list omits netrunner and keeps the other nine", () => {
    assert.ok(!GR.GENERATOR_ROLES.includes("netrunner"), "netrunner leaked into the role list");
    assert.equal(GR.GENERATOR_ROLES.length, 9);
    for (const r of ["solo", "cop", "corp", "fixer", "nomad", "techie", "medtechie", "media", "rocker"]) {
      assert.ok(GR.GENERATOR_ROLES.includes(r), `missing role ${r}`);
    }
  });

  // ── role stat weight vectors (§2.2, book-derived, ruled) ──
  leg("role weight vectors are the ruled book-derived ranks", () => {
    assert.deepEqual(GR.ROLE_WEIGHTS.solo, ["int", "tech"]);
    assert.deepEqual(GR.ROLE_WEIGHTS.cop, ["cool", "int", "emp"]);
    assert.deepEqual(GR.ROLE_WEIGHTS.corp, ["int", "emp", "attr"]);
    assert.deepEqual(GR.ROLE_WEIGHTS.fixer, ["cool", "tech", "int"]);
    assert.deepEqual(GR.ROLE_WEIGHTS.nomad, ["int", "tech"]);
    assert.deepEqual(GR.ROLE_WEIGHTS.techie, ["tech", "int"]);
    assert.deepEqual(GR.ROLE_WEIGHTS.medtechie, ["tech", "int", "emp"]);
    assert.deepEqual(GR.ROLE_WEIGHTS.media, ["int", "emp", "cool"]);
    assert.deepEqual(GR.ROLE_WEIGHTS.rocker, ["cool", "emp", "int"]);
  });

  leg("no role vector ranks MA, REF or BT (pinned / never ranks)", () => {
    for (const [role, v] of Object.entries(GR.ROLE_WEIGHTS)) {
      for (const bad of ["ma", "ref", "bt", "luck"]) {
        assert.ok(!v.includes(bad), `${role} ranks ${bad}`);
      }
    }
  });

  leg("the Loose shape's structural ladder is 4/3/2/1 and is role-independent", () => {
    assert.deepEqual(GR.LOOSE_LADDER, [4, 3, 2, 1]);
  });

  leg("the three stat shapes exist, Role-shaped is the default", () => {
    assert.deepEqual(GR.STAT_SHAPES, ["roleShaped", "loose", "pureRandom"]);
    assert.equal(GR.STAT_SHAPE_DEFAULT, "roleShaped");
  });

  leg("the loot dial is off/scarce/standard/generous and defaults OFF (GM consent)", () => {
    assert.deepEqual(GR.LOOT_DIAL, ["off", "scarce", "standard", "generous"]);
    assert.equal(GR.LOOT_DEFAULT, "off");
    assert.equal(GR.lootProfileFor("off", "AA").spareMags, 0);
    assert.equal(GR.lootProfileFor("off", "AA").cashEb, 0);
  });

  leg("loot amounts rise with the dial and with the grade", () => {
    const scarce = GR.lootProfileFor("scarce", "C").cashEb;
    const gen = GR.lootProfileFor("generous", "C").cashEb;
    assert.ok(gen > scarce, `generous ${gen} !> scarce ${scarce}`);
    assert.ok(GR.lootProfileFor("standard", "A").cashEb > GR.lootProfileFor("standard", "D").cashEb);
  });
});

// =================================================================================================
// §3 SLOT SCHEMA — the eleven criteria-driven chrome slots
// =================================================================================================

section("§3 chrome slots", SL, () => {
  leg("eleven slots ship, with the criteria draft's own ids", () => {
    assert.equal(SL.CHROME_SLOTS.length, 11);
    const ids = SL.CHROME_SLOTS.map((s) => s.id);
    for (const id of ["skillChips", "combatOptics", "combatAudio", "reflexBoost", "smartgunLink",
      "handWeapons", "armGun", "heavyBuiltIns", "dermalArmor", "cyberlimbs", "garnish"]) {
      assert.ok(ids.includes(id), `missing slot ${id}`);
    }
  });

  leg("every slot carries the full §3 Slot shape (criteria + allow/deny), no shortcuts", () => {
    for (const s of SL.CHROME_SLOTS) {
      assert.ok(s.labelKey, `${s.id} has no labelKey`);
      assert.ok(s.criteria && typeof s.criteria === "object", `${s.id} has no criteria`);
      assert.ok(Array.isArray(s.criteria.categories), `${s.id} criteria has no categories`);
      assert.ok(Array.isArray(s.allow), `${s.id} has no allow list`);
      assert.ok(Array.isArray(s.deny), `${s.id} has no deny list`);
    }
  });

  leg("grade gates are the ruled ladder (chips D+, optics/audio C+, boost/link/dermal B+, limbs A+, heavies AA)", () => {
    const gate = (id) => SL.CHROME_SLOTS.find((s) => s.id === id).gradeGate;
    assert.equal(gate("skillChips"), "D");
    assert.equal(gate("combatOptics"), "C");
    assert.equal(gate("combatAudio"), "C");
    assert.equal(gate("reflexBoost"), "B");
    assert.equal(gate("smartgunLink"), "B");
    assert.equal(gate("handWeapons"), "D");
    assert.equal(gate("armGun"), "C");
    assert.equal(gate("heavyBuiltIns"), "AA");
    assert.equal(gate("dermalArmor"), "B");
    assert.equal(gate("cyberlimbs"), "A");
    assert.equal(gate("garnish"), "E");
  });

  leg("slotsUnlockedAt walks the ladder — E unlocks garnish only, AA unlocks all eleven", () => {
    assert.deepEqual(SL.slotsUnlockedAt("E").map((s) => s.id), ["garnish"]);
    assert.equal(SL.slotsUnlockedAt("D").length, 3);           // + skillChips + handWeapons
    assert.equal(SL.slotsUnlockedAt("C").length, 6);           // + optics + audio + armGun
    assert.equal(SL.slotsUnlockedAt("B").length, 9);           // + boost + link + dermal
    assert.equal(SL.slotsUnlockedAt("A").length, 10);          // + cyberlimbs
    assert.equal(SL.slotsUnlockedAt("AA").length, 11);         // + heavy built-ins
  });

  leg("housings declare their real option-space budgets (eye 4 · audio 6 · arm 4 · leg 3)", () => {
    assert.equal(SL.HOUSING_SPACES["Cyberoptic"], 4);
    assert.equal(SL.HOUSING_SPACES["Cyberaudio"], 6);
    assert.equal(SL.HOUSING_SPACES["Standard Cyberarm"], 4);
    assert.equal(SL.HOUSING_SPACES["Standard Cyberleg"], 3);
  });

  leg("the deny-list carries the hollow Full Borg entry (comb DATA FLAG 9)", () => {
    assert.ok(SL.CHROME_DENY_NAMES.some((n) => /Full Borg: Increased Stats/i.test(n)));
  });

  leg("the boosterware slot declares its exclusivity class (p.81 — one boost per goon)", () => {
    const boost = SL.CHROME_SLOTS.find((s) => s.id === "reflexBoost");
    assert.equal(boost.exclusivity, "boosterware");
  });

  leg("dermal armor declares the one-head-armor class and cyberlimbs the per-limb covering class", () => {
    assert.equal(SL.CHROME_SLOTS.find((s) => s.id === "dermalArmor").headExclusivity, "headArmor");
    assert.equal(SL.CHROME_SLOTS.find((s) => s.id === "cyberlimbs").exclusivity, "limbCovering");
  });

  leg("prerequisite EQUIVALENCE is declared, not hard-coded: chips take Processor + (Plugs OR Socket)", () => {
    const chips = SL.CHROME_SLOTS.find((s) => s.id === "skillChips");
    const names = chips.prerequisites.map((p) => (p.anyOf ? p.anyOf.join("|") : p.name));
    assert.ok(names.includes("Neuralware Processor"), `no processor prereq: ${names}`);
    assert.ok(names.some((n) => /Interface Plugs\|Chipware Socket/.test(n)), `no either-interface prereq: ${names}`);
  });

  leg("the smartgun link declares Interface Plugs and the weapon-side dependency", () => {
    const link = SL.CHROME_SLOTS.find((s) => s.id === "smartgunLink");
    assert.ok(link.prerequisites.some((p) => p.name === "Interface Plugs"));
    assert.equal(link.requiresCompatibleWeapon, true);
  });

  leg("the Targeting Scope is a DEPENDENT DEAL — declared, never a free optic option", () => {
    assert.equal(SL.DEPENDENT_DEALS.targetingScope.requires, "smartgunStack");
  });

  leg("the popup gun's class is BT-band limited, and the bands are the printed ones", () => {
    assert.equal(SL.popupClassForBt(3), "lightPistol");     // V.Weak–Weak
    assert.equal(SL.popupClassForBt(7), "mediumPistol");    // Average–Strong (the BT-7 default)
    assert.equal(SL.popupClassForBt(10), "heavyPistol");    // Very Strong
  });

  leg("side-effect items are declared with their real debits (SP14 −1 ATTR · SP16 −2 ATTR)", () => {
    assert.equal(SL.SIDE_EFFECTS.attrDebit["Skinweave SP14"], -1);
    assert.equal(SL.SIDE_EFFECTS.attrDebit["Skinweave SP16"], -2);
  });
});

// =================================================================================================
// §3 THE COMPOUND-PULL ENGINE — housings + options + prerequisites, and the four engine rules
// =================================================================================================

section("§3 compound-pull engine", CH, () => {
  /** A tiny stand-in pool: what the catalog layer hands the engine, in its own shape. */
  const pool = [
    { key: "p.1", name: "Neuralware Processor", category: "Cyberware", sub: "Neuralware", cost: 1000, humanityLoss: 3 },
    { key: "p.2", name: "Interface Plugs", category: "Cyberware", sub: "Neuralware", cost: 200, humanityLoss: 3 },
    { key: "p.3", name: "Chipware Socket", category: "Cyberware", sub: "Neuralware", cost: 500, humanityLoss: 3 },
    { key: "p.4", name: "Smartgun Link", category: "Cyberware", sub: "Neuralware", cost: 1000, humanityLoss: 2 },
    { key: "o.1", name: "Cyberoptic", category: "Cyberware", sub: "Cyberoptics", cost: 500, humanityLoss: 7, spaces: 4 },
    { key: "o.2", name: "Low Lite", category: "Cyberware", sub: "Cyberoptics", cost: 200, humanityLoss: 2, slotsTaken: 1 },
    { key: "o.3", name: "Infrared", category: "Cyberware", sub: "Cyberoptics", cost: 500, humanityLoss: 2, slotsTaken: 1 },
    { key: "o.4", name: "Targeting Scope", category: "Cyberware", sub: "Cyberoptics", cost: 900, humanityLoss: 2, slotsTaken: 1 },
    { key: "o.5", name: "Dartgun", category: "Cyberware", sub: "Cyberoptics", cost: 500, humanityLoss: 2, slotsTaken: 3 },
    { key: "o.6", name: "Anti-Dazzle", category: "Cyberware", sub: "Cyberoptics", cost: 200, humanityLoss: 2, slotsTaken: 1 },
    { key: "o.7", name: "Image Enhancement", category: "Cyberware", sub: "Cyberoptics", cost: 500, humanityLoss: 2, slotsTaken: 1 },
    { key: "o.8", name: "Teleoptics", category: "Cyberware", sub: "Cyberoptics", cost: 500, humanityLoss: 2, slotsTaken: 1 },
    { key: "o.9", name: "Ultra Violet", category: "Cyberware", sub: "Cyberoptics", cost: 200, humanityLoss: 2, slotsTaken: 1 },
    { key: "o.10", name: "Thermograph sensor", category: "Cyberware", sub: "Cyberoptics", cost: 500, humanityLoss: 2, slotsTaken: 1 },
    { key: "a.1", name: "Cyberaudio", category: "Cyberware", sub: "Cyberaudio", cost: 500, humanityLoss: 7, spaces: 6 },
    { key: "a.2", name: "Amplified Hearing", category: "Cyberware", sub: "Cyberaudio", cost: 100, humanityLoss: 2, slotsTaken: 1 },
    { key: "b.1", name: "Kerenzikov Boosterware I", category: "Cyberware", sub: "Neuralware", cost: 5000, humanityLoss: 4 },
    { key: "b.2", name: "Sandevistan Speedware", category: "Cyberware", sub: "Neuralware", cost: 1600, humanityLoss: 4 },
    { key: "h.1", name: "Rippers", category: "Cyberware", sub: "Cyberweapons", cost: 400, humanityLoss: 11 },
    { key: "h.2", name: "Wolvers", category: "Cyberware", sub: "Cyberweapons", cost: 1000, humanityLoss: 12 },
    { key: "s.1", name: "Upgraded Skinweave SP6", category: "Cyberware", sub: "Bioware", cost: 1000, humanityLoss: 4 },
    { key: "s.2", name: "Upgraded Skinweave SP14", category: "Cyberware", sub: "Bioware", cost: 2500, humanityLoss: 5 },
    { key: "g.1", name: "Techhair", category: "Cyberware", sub: "Fashionware", cost: 100, humanityLoss: 1 },
    { key: "x.1", name: "Full Borg: Increased Stats", category: "Cyberware", sub: "Other", cost: 2000, humanityLoss: 2 },
  ];
  const base = { pool, bt: 7, count: 2, garnish: false };

  leg("a slot pull is a COMPOUND: the optic pull buys the housing AND its option, once each", () => {
    const r = CH.planChrome({ ...base, gradeKey: "C", count: 1, rng: scriptedRng([0]), forceSlots: ["combatOptics"] });
    const names = r.items.map((i) => i.name);
    assert.ok(names.includes("Cyberoptic"), `no housing: ${names}`);
    assert.equal(names.filter((n) => n === "Cyberoptic").length, 1, `housing bought twice: ${names}`);
    assert.ok(r.items.some((i) => i.role === "option"), `no option in ${JSON.stringify(r.items)}`);
  });

  leg("HOUSING DEDUP: two optic pulls reuse the ONE eye and stack a second option into it", () => {
    const r = CH.planChrome({ ...base, gradeKey: "AA", count: 2, rng: scriptedRng([0, 0.5]), forceSlots: ["combatOptics", "combatOptics"] });
    const housings = r.items.filter((i) => i.name === "Cyberoptic");
    assert.equal(housings.length, 1, `bought ${housings.length} eyes`);
    assert.ok(r.items.filter((i) => i.role === "option").length >= 2, "second pull did not stack an option");
  });

  leg("ENGINE RULE 1 — SPACES, not counts: a 4-space eye refuses a 5th space of options", () => {
    const r = CH.planChrome({ ...base, gradeKey: "AA", count: 8, rng: scriptedRng([0.05, 0.25, 0.45, 0.65, 0.85, 0.95]), forceSlots: Array(8).fill("combatOptics") });
    const used = r.spaces["Cyberoptic"];
    assert.ok(used <= 4, `eye over capacity: ${used} spaces`);
    assert.ok(r.lint.some((l) => l.code === "housingFull"), `no honesty line for the full housing: ${JSON.stringify(r.lint)}`);
  });

  leg("ENGINE RULE 2 — EXCLUSIVITY: a goon may hold exactly one boosterware (p.81)", () => {
    const r = CH.planChrome({ ...base, gradeKey: "AA", count: 4, rng: scriptedRng([0, 0.9, 0.4, 0.6]), forceSlots: Array(4).fill("reflexBoost") });
    const boosts = r.items.filter((i) => /Kerenzikov|Sandevistan/.test(i.name));
    assert.equal(boosts.length, 1, `stacked ${boosts.length} boosts: ${boosts.map((b) => b.name)}`);
  });

  leg("ENGINE RULE 3 — DEPENDENT DEAL: the Targeting Scope never lands without the smartgun stack", () => {
    const r = CH.planChrome({ ...base, gradeKey: "AA", count: 6, rng: scriptedRng([0.75]), forceSlots: Array(6).fill("combatOptics"), smartgunStack: false });
    assert.ok(!r.items.some((i) => i.name === "Targeting Scope"), "the scope came without the stack");
  });

  leg("… and DOES land once the stack is present (the positive half of the same rule)", () => {
    const r = CH.planChrome({ ...base, gradeKey: "AA", count: 6, rng: scriptedRng([0.75]), forceSlots: Array(6).fill("combatOptics"), smartgunStack: true });
    assert.ok(r.eligibleOptionNames.includes("Targeting Scope"), "the scope stayed barred with the stack present");
  });

  leg("ENGINE RULE 4 — SIDE EFFECT: an SP14 skinweave pull carries its −1 ATTR debit out", () => {
    const r = CH.planChrome({ ...base, gradeKey: "AA", count: 1, rng: scriptedRng([0.99]), forceSlots: ["dermalArmor"], forceItems: { dermalArmor: "Upgraded Skinweave SP14" } });
    assert.equal(r.statDebits.attr, -1, `no ATTR debit: ${JSON.stringify(r.statDebits)}`);
  });

  leg("PREREQUISITE EQUIVALENCE: the processor is bought exactly ONCE across all neural chrome", () => {
    const r = CH.planChrome({ ...base, gradeKey: "AA", count: 3, rng: scriptedRng([0, 0.3, 0.6]), forceSlots: ["skillChips", "reflexBoost", "smartgunLink"] });
    const procs = r.items.filter((i) => i.name === "Neuralware Processor");
    assert.equal(procs.length, 1, `bought the processor ${procs.length} times`);
  });

  leg("… and existing Interface Plugs satisfy a chip's interface half (no second socket bought)", () => {
    const r = CH.planChrome({ ...base, gradeKey: "AA", count: 2, rng: scriptedRng([0, 0.3]), forceSlots: ["smartgunLink", "skillChips"] });
    const plugs = r.items.filter((i) => i.name === "Interface Plugs").length;
    const sockets = r.items.filter((i) => i.name === "Chipware Socket").length;
    assert.equal(plugs, 1, `plugs bought ${plugs} times`);
    assert.equal(sockets, 0, `bought a redundant socket alongside plugs`);
  });

  leg("the deny-list is honored: the hollow Full Borg entry is never pullable", () => {
    const r = CH.planChrome({ ...base, gradeKey: "AA", count: 10, rng: scriptedRng([0.5]) });
    assert.ok(!r.items.some((i) => /Increased Stats/.test(i.name)), "the hollow item was pulled");
  });

  leg("\"Nothing\" exists at C and below and NEVER at B or above", () => {
    const atC = CH.planChrome({ ...base, gradeKey: "C", count: 6, rng: scriptedRng([0.999]) });
    const atB = CH.planChrome({ ...base, gradeKey: "B", count: 6, rng: scriptedRng([0.999]) });
    assert.ok(atC.whiffAllowed === true, "C disallowed the whiff");
    assert.equal(atB.whiffAllowed, false, "B allowed a whiff");
    assert.equal(atB.nothingCount, 0, "B produced a Nothing result");
  });

  leg("grade gating is real: a C-grade goon can never draw a cyberlimb (A+) or a heavy built-in (AA)", () => {
    const r = CH.planChrome({ ...base, gradeKey: "C", count: 12, rng: scriptedRng([0.1, 0.3, 0.5, 0.7, 0.9]) });
    assert.ok(!r.pulls.some((p) => p.slotId === "cyberlimbs"), "a C goon drew a cyberlimb");
    assert.ok(!r.pulls.some((p) => p.slotId === "heavyBuiltIns"), "a C goon drew a heavy built-in");
  });

  leg("humanity math ALWAYS runs — the plan sums the real humanity loss of everything it pulled", () => {
    const r = CH.planChrome({ ...base, gradeKey: "B", count: 2, rng: scriptedRng([0.2, 0.55]) });
    const expected = r.items.reduce((s, i) => s + (Number(i.humanityLoss) || 0), 0);
    assert.equal(r.humanityLoss, expected);
    assert.ok(r.humanityLoss > 0, "a chromed goon reported zero humanity cost");
  });

  leg("a slot whose criteria resolve to NOTHING lints instead of failing silently (§3 preview lint)", () => {
    const r = CH.planChrome({ ...base, pool: [], gradeKey: "AA", count: 3, rng: scriptedRng([0.2]) });
    assert.ok(r.lint.some((l) => l.code === "slotEmpty"), `no empty-slot lint: ${JSON.stringify(r.lint)}`);
    assert.equal(r.items.length, 0);
  });

  leg("determinism: the same seed stream produces a byte-identical chrome plan", () => {
    const mk = () => CH.planChrome({ ...base, gradeKey: "A", count: 4, rng: scriptedRng([0.11, 0.42, 0.73, 0.28, 0.66]) });
    assert.equal(JSON.stringify(mk()), JSON.stringify(mk()));
  });

  // ── THE BONUS-ITEM CHANNEL (§3 Outfit `bonusPools`, ruled 2026-08-14) ───────────────────────────
  // The SEAM ships with EMPTY pools; these legs drive it with a synthetic pool so the machinery is
  // proven, not merely present.
  const bonusPool = (squadLimit) => ([{
    id: "__test_bonus", labelKey: "x", chance: 1,
    slots: [{ slotId: "handWeapons", allow: ["Wolvers"], ...(squadLimit ? { squadLimit } : {}) }],
  }]);

  leg("a BONUS pull consumes NO chrome-count slot — the count arithmetic is untouched", () => {
    const plain = CH.planChrome({ ...base, gradeKey: "B", count: 2, rng: scriptedRng([0.2, 0.5]) });
    const bonus = CH.planChrome({ ...base, gradeKey: "B", count: 2, rng: scriptedRng([0.2, 0.5]), bonusPools: bonusPool() });
    assert.equal(bonus.combatPullCount, plain.combatPullCount, "a bonus pull ate a chrome point");
    assert.equal(bonus.combatPullCount, 2);
    assert.equal(bonus.bonusItems.length, 1, `bonus channel produced ${bonus.bonusItems.length} items`);
    assert.equal(bonus.bonusItems[0].name, "Wolvers");
  });

  leg("an EMPTY bonus pool produces zero pulls and zero lint noise", () => {
    const none = CH.planChrome({ ...base, gradeKey: "B", count: 2, rng: scriptedRng([0.2, 0.5]), bonusPools: [] });
    const emptySlots = CH.planChrome({
      ...base, gradeKey: "B", count: 2, rng: scriptedRng([0.2, 0.5]),
      bonusPools: [{ id: "__empty", labelKey: "x", chance: 1, slots: [] }],
    });
    assert.equal(none.bonusItems.length, 0);
    assert.equal(emptySlots.bonusItems.length, 0);
    assert.equal(emptySlots.lint.filter((l) => String(l.code).startsWith("bonus")).length, 0,
      `empty pool emitted lint: ${JSON.stringify(emptySlots.lint.filter((l) => String(l.code).startsWith("bonus")))}`);
  });

  leg("a bonus pull is DISCLOSED — an honesty row names the item and its pool", () => {
    const r = CH.planChrome({ ...base, gradeKey: "B", count: 1, rng: scriptedRng([0.2]), bonusPools: bonusPool() });
    const row = r.honesty.find((h) => h.code === "bonusItem");
    assert.ok(row, `no bonus disclosure: ${JSON.stringify(r.honesty)}`);
    assert.equal(row.name, "Wolvers");
    assert.equal(row.poolId, "__test_bonus");
  });

  leg("SQUAD LIMIT is enforced across the BATCH: four goons, limit 1 ⇒ exactly one carrier", () => {
    const ledger = CH.newSquadLedger();
    const carriers = [];
    for (let i = 0; i < 4; i++) {
      const r = CH.planChrome({
        ...base, gradeKey: "B", count: 1, rng: scriptedRng([0.2]),
        bonusPools: bonusPool(1), squadLedger: ledger, goonName: `Solo B-${i + 1}`,
      });
      if (r.bonusItems.length) carriers.push({ goon: `Solo B-${i + 1}`, item: r.bonusItems[0].name });
    }
    assert.equal(carriers.length, 1, `${carriers.length} goons carry a squad-limited bonus item`);
    assert.equal(carriers[0].item, "Wolvers");
  });

  leg("… and the squad-limited disclosure names WHICH goon is the carrier", () => {
    const ledger = CH.newSquadLedger();
    const r = CH.planChrome({
      ...base, gradeKey: "B", count: 1, rng: scriptedRng([0.2]),
      bonusPools: bonusPool(1), squadLedger: ledger, goonName: "Solo B-1",
    });
    const row = r.honesty.find((h) => h.code === "bonusItem");
    assert.equal(row.squadLimit, 1);
    assert.equal(row.carrier, "Solo B-1");
  });

  leg("a bonus pool conditioned on a LOW grade does not fire at a high one", () => {
    const pools = [{ id: "__low", labelKey: "x", chance: 1, whenGradeAtMost: "D", slots: [{ slotId: "handWeapons", allow: ["Rippers"] }] }];
    const atD = CH.planChrome({ ...base, gradeKey: "D", count: 1, rng: scriptedRng([0.2]), bonusPools: pools });
    const atA = CH.planChrome({ ...base, gradeKey: "A", count: 1, rng: scriptedRng([0.2]), bonusPools: pools });
    assert.equal(atD.bonusItems.length, 1, "the low-grade pool did not fire at D");
    assert.equal(atA.bonusItems.length, 0, "the low-grade pool fired at A");
  });

  leg("a bonus pool conditioned on an OUTFIT TAG only fires for that outfit", () => {
    const pools = [{ id: "__covert", labelKey: "x", chance: 1, whenOutfitTags: ["covert"], slots: [{ slotId: "handWeapons", allow: ["Rippers"] }] }];
    const tagged = CH.planChrome({ ...base, gradeKey: "B", count: 1, rng: scriptedRng([0.2]), bonusPools: pools, outfitTags: ["covert"] });
    const untagged = CH.planChrome({ ...base, gradeKey: "B", count: 1, rng: scriptedRng([0.2]), bonusPools: pools, outfitTags: [] });
    assert.equal(tagged.bonusItems.length, 1);
    assert.equal(untagged.bonusItems.length, 0);
  });

  leg("garnish is non-counting: turning it on adds an item WITHOUT consuming a chrome point", () => {
    const off = CH.planChrome({ ...base, gradeKey: "C", count: 2, rng: scriptedRng([0.2, 0.5]), garnish: false });
    const on = CH.planChrome({ ...base, gradeKey: "C", count: 2, rng: scriptedRng([0.2, 0.5]), garnish: true });
    assert.equal(off.combatPullCount, on.combatPullCount, "garnish ate a combat pull");
    assert.ok(on.items.length > off.items.length, "garnish added nothing");
  });
});

// =================================================================================================
// §3 / ARMOR-CRITERIA — the band pools and the book-law layering composer
// =================================================================================================

section("armor bands + layering composer", AR, () => {
  leg("the book's layering law is carried as data: 3 layers, ONE hard, skinweave free", () => {
    assert.equal(AR.LAYER_LAW.maxLayers, 3);
    assert.equal(AR.LAYER_LAW.maxHardLayers, 1);
    assert.equal(AR.LAYER_LAW.skinweaveFree, true);
    assert.equal(AR.LAYER_LAW.subdermalCounts, true);
    assert.deepEqual(AR.LAYER_LAW.extraEvPerLayer, [0, 1, 2]);   // 2nd layer −1 EV, 3rd −2 more
  });

  leg("the proportional table is the printed one (+5/+4/+3/+2/+1/+0 over the diff bands)", () => {
    assert.equal(AR.proportionalBonus(0), 5);
    assert.equal(AR.proportionalBonus(4), 5);
    assert.equal(AR.proportionalBonus(5), 4);
    assert.equal(AR.proportionalBonus(8), 4);
    assert.equal(AR.proportionalBonus(9), 3);
    assert.equal(AR.proportionalBonus(14), 3);
    assert.equal(AR.proportionalBonus(15), 2);
    assert.equal(AR.proportionalBonus(20), 2);
    assert.equal(AR.proportionalBonus(21), 1);
    assert.equal(AR.proportionalBonus(26), 1);
    assert.equal(AR.proportionalBonus(27), 0);
  });

  // ⭐ Cross-checked against the BASE SYSTEM's own `combineSP` (systems/cyberpunk2020
  // module/actor/actor.js:228-244): `max(a,b) + mod`, with the same six diff bands and the same
  // zero-guards. Our fold must agree with the runtime that will actually resolve the hit, or the
  // preview's "effective SP" would be a number the damage pipeline never produces.
  leg("a proportional fold takes the higher SP plus the band bonus, not a sum", () => {
    assert.equal(AR.proportionalSP(20, 18), 25);      // diff 2 → +5 on the higher
    assert.equal(AR.proportionalSP(25, 6), 27);       // diff 19 → +2
    assert.equal(AR.proportionalSP(25, 10), 27);      // diff 15 → +2
    assert.equal(AR.proportionalSP(30, 0), 30);       // nothing to fold
    assert.equal(AR.proportionalSP(0, 0), 0);
  });

  leg("the composer NEVER exceeds three layers, whatever it is offered", () => {
    const cands = [
      { name: "Kevlar Vest", sp: 10, ev: 0, hardness: "soft" },
      { name: "Light Armor Jacket", sp: 14, ev: 0, hardness: "soft" },
      { name: "Metal Gear", sp: 25, ev: 2, hardness: "hard" },
      { name: "Flak Vest", sp: 20, ev: 1, hardness: "hard" },
    ];
    const chrome = [{ name: "Skinweave SP12", sp: 12, ev: 0, kind: "skinweave" }, { name: "Subdermal Armor", sp: 18, ev: 0, kind: "subdermal" }];
    const r = AR.composeArmorStack({ gradeKey: "AA", candidates: cands, chromeLayers: chrome });
    assert.ok(r.layers.length <= 3, `${r.layers.length} layers`);
  });

  leg("… and never more than ONE hard layer", () => {
    const cands = [
      { name: "Metal Gear", sp: 25, ev: 2, hardness: "hard" },
      { name: "Flak Vest", sp: 20, ev: 1, hardness: "hard" },
      { name: "Steel Helmet", sp: 14, ev: 0, hardness: "hard" },
    ];
    const r = AR.composeArmorStack({ gradeKey: "AA", candidates: cands, chromeLayers: [] });
    assert.equal(r.layers.filter((l) => l.hardness === "hard").length, 1);
  });

  leg("skinweave is the FREE layer: it joins the stack and costs neither a layer slot nor EV", () => {
    const cands = [{ name: "Metal Gear", sp: 25, ev: 2, hardness: "hard" }, { name: "Kevlar Vest", sp: 10, ev: 0, hardness: "soft" }];
    const chrome = [{ name: "Skinweave SP12", sp: 12, ev: 0, kind: "skinweave" }];
    const r = AR.composeArmorStack({ gradeKey: "AA", candidates: cands, chromeLayers: chrome });
    assert.ok(r.stack.some((l) => l.kind === "skinweave"), "skinweave was dropped from the stack");
    assert.equal(r.countedLayers, r.stack.filter((l) => l.kind !== "skinweave").length);
    assert.ok(r.countedLayers <= 3);
  });

  leg("subdermal armor DOES count against the three (the book says so)", () => {
    const chrome = [{ name: "Subdermal Armor", sp: 18, ev: 0, kind: "subdermal" }];
    const cands = [{ name: "Metal Gear", sp: 25, ev: 2, hardness: "hard" }, { name: "Kevlar Vest", sp: 10, ev: 0, hardness: "soft" }, { name: "Armored T-Shirt", sp: 10, ev: 0, hardness: "soft" }];
    const r = AR.composeArmorStack({ gradeKey: "AA", candidates: cands, chromeLayers: chrome });
    assert.ok(r.stack.some((l) => l.kind === "subdermal"));
    assert.ok(r.countedLayers <= 3, `${r.countedLayers} counted layers`);
  });

  leg("layer EV is the book's own −1 for the 2nd worn layer and −2 more for the 3rd", () => {
    const cands = [
      { name: "Metal Gear", sp: 25, ev: 2, hardness: "hard" },
      { name: "Kevlar Vest", sp: 10, ev: 0, hardness: "soft" },
      { name: "Armored T-Shirt", sp: 10, ev: 0, hardness: "soft" },
    ];
    const r = AR.composeArmorStack({ gradeKey: "AA", candidates: cands, chromeLayers: [] });
    // three counted layers ⇒ base EV 2 + layer penalties 1 + 2
    assert.equal(r.effectiveEV, 5);
  });

  leg("the effective SP is the inside-out proportional fold, not a sum", () => {
    const cands = [{ name: "Metal Gear", sp: 25, ev: 2, hardness: "hard" }, { name: "Kevlar Vest", sp: 10, ev: 0, hardness: "soft" }];
    const r = AR.composeArmorStack({ gradeKey: "B", candidates: cands, chromeLayers: [] });
    assert.equal(r.effectiveSP, AR.proportionalSP(25, 10));
    assert.ok(r.effectiveSP < 35, "the fold summed instead of folding");
  });

  leg("E band pulls NO armor at all (ruled: the band IS normal clothing)", () => {
    assert.equal(AR.ARMOR_BANDS.E.pull, false);
    const r = AR.composeArmorStack({ gradeKey: "E", candidates: [{ name: "Kevlar Vest", sp: 10, ev: 0, hardness: "soft" }], chromeLayers: [] });
    assert.equal(r.layers.length, 0);
    assert.ok(r.honesty.some((h) => h.code === "bandNoPull"));
  });

  leg("the AA band has no single item and SAYS so (the band's own honesty line)", () => {
    assert.equal(AR.ARMOR_BANDS.AA.itemsExist, false);
    const r = AR.composeArmorStack({ gradeKey: "AA", candidates: [{ name: "Metal Gear", sp: 25, ev: 2, hardness: "hard" }], chromeLayers: [] });
    assert.ok(r.honesty.some((h) => h.code === "bandLayeredOnly"), `no AA honesty line: ${JSON.stringify(r.honesty)}`);
  });

  leg("the LIGHT-only weight filter cannot reach band B/A and clamps VISIBLY", () => {
    const r = AR.armorWeightClamp("A", "light");
    assert.equal(r.clamped, true);
    assert.equal(r.code, "lightCannotReachBand");
    assert.equal(AR.armorWeightClamp("D", "light").clamped, false);
    assert.equal(AR.armorWeightClamp("A", "any").clamped, false);
  });

  leg("the base-12 hardness correction follows the BOOK's printed table (flak + both helmets HARD)", () => {
    assert.equal(AR.bookHardness("Flak Vest"), "hard");
    assert.equal(AR.bookHardness("Flak Pants"), "hard");
    assert.equal(AR.bookHardness("Steel Helmet"), "hard");
    assert.equal(AR.bookHardness("Nylon Helmet"), "hard");
    assert.equal(AR.bookHardness("Metal Gear"), "hard");
    assert.equal(AR.bookHardness("Kevlar Vest"), "soft");
    assert.equal(AR.bookHardness("Heavy Leather"), "soft");
    assert.equal(AR.bookHardness("Light Armor Jacket"), "soft");
  });

  leg("the hardness filter is honored: \"soft\" never composes a hard layer", () => {
    const cands = [{ name: "Metal Gear", sp: 25, ev: 2, hardness: "hard" }, { name: "Kevlar Vest", sp: 10, ev: 0, hardness: "soft" }];
    const r = AR.composeArmorStack({ gradeKey: "B", candidates: cands, chromeLayers: [], filters: { hardness: "soft" } });
    assert.ok(!r.layers.some((l) => l.hardness === "hard"));
  });

  leg("one-head-armor: a helmet and a cowl never both land", () => {
    const cands = [
      { name: "Police Patrol Helmet", sp: 25, ev: 0, hardness: "hard", location: "head" },
      { name: "Cowl", sp: 25, ev: 0, hardness: "hard", location: "head" },
    ];
    const r = AR.composeArmorStack({ gradeKey: "AA", candidates: cands, chromeLayers: [] });
    assert.ok(r.layers.filter((l) => l.location === "head").length <= 1);
  });
});

// =================================================================================================
// §3 OUTFITS — the RATIFIED catalogue (OUTFIT-CATALOGUE-PREP.md §A, promoted 2026-08-14)
// =================================================================================================

/**
 * ⛔ THE §A TABLE, TRANSCRIBED AS A CLOSED EXPECTATION SET. This is the ratified content, so the
 * suite compares the shipped data against the TABLE rather than against itself — a leg that read the
 * roster and then asserted things about what it read would pass for any roster at all.
 *
 * The three rows that shipped earlier as seeds are 1, 4 and 9; their ids are pinned here so a
 * "reconcile in place" that quietly re-created them under new ids fails.
 */
const CATALOGUE_A = [
  { n: 1,  id: "cityPolicePatrol",     role: "cop",    grade: "C",  mod: 0, hardness: "soft", weight: "any",   armament: "standard", loot: "scarce",   bias: ["AwarenessNotice", "Handgun"],           wasSeed: true },
  { n: 2,  id: "cityPoliceTactical",   role: "cop",    grade: "B",  mod: 1, hardness: "any",  weight: "any",   armament: "standard", loot: "scarce",   bias: ["Rifle", "Athletics"],                   wasSeed: false },
  { n: 3,  id: "cyberpsychoResponse",  role: "solo",   grade: "A",  mod: 2, hardness: "hard", weight: "any",   armament: "ap",       loot: "standard", bias: ["Rifle", "AwarenessNotice"],             wasSeed: false },
  { n: 4,  id: "premiumCorpSecurity",  role: "solo",   grade: "B",  mod: 1, hardness: "soft", weight: "any",   armament: "standard", loot: "standard", bias: ["Handgun", "AwarenessNotice"],           wasSeed: true },
  { n: 5,  id: "executiveProtection",  role: "solo",   grade: "A",  mod: 1, hardness: "soft", weight: "any",   armament: "standard", loot: "standard", bias: ["Handgun", "Melee"],                     wasSeed: false },
  { n: 6,  id: "facilitySecurity",     role: "cop",    grade: "C",  mod: 0, hardness: "soft", weight: "any",   armament: "standard", loot: "scarce",   bias: ["AwarenessNotice", "Brawling"],          wasSeed: false },
  { n: 7,  id: "dockPatrol",           role: "solo",   grade: "C",  mod: 0, hardness: "soft", weight: "any",   armament: "standard", loot: "scarce",   bias: ["Brawling", "Melee", "Intimidate"],      wasSeed: false },
  { n: 8,  id: "militarizedCorpForce", role: "solo",   grade: "A",  mod: 1, hardness: "hard", weight: "any",   armament: "ap",       loot: "generous", bias: ["Rifle", "HeavyWeapons"],                wasSeed: false },
  { n: 9,  id: "boosterGang",          role: "solo",   grade: "D",  mod: 2, hardness: "soft", weight: "light", armament: "standard", loot: "scarce",   bias: ["Brawling", "Melee"],                    wasSeed: true },
  { n: 10, id: "poserGang",            role: "solo",   grade: "D",  mod: 1, hardness: "soft", weight: "light", armament: "standard", loot: "scarce",   bias: ["Brawling", "Streetwise"],               wasSeed: false },
  { n: 11, id: "chromerGang",          role: "rocker", grade: "E",  mod: 0, hardness: "any",  weight: "any",   armament: "standard", loot: "scarce",   bias: ["Brawling", "Perform"],                  wasSeed: false },
  { n: 12, id: "corporateStaffers",    role: "corp",   grade: "E",  mod: 0, hardness: "any",  weight: "any",   armament: "standard", loot: "scarce",   bias: ["PersuasionFastTalk", "AwarenessNotice"], wasSeed: false },
];

section("§3 outfits (ratified catalogue)", OU, () => {
  leg("the catalogue is the twelve §A rows, in table order, and the seed flag is GONE", () => {
    assert.equal(OU.OUTFITS.length, 12);
    assert.deepEqual(OU.OUTFITS.map((o) => o.id), CATALOGUE_A.map((r) => r.id));
    assert.ok(OU.OUTFITS.every((o) => o.seed === undefined),
      `an entry still carries a seed flag: ${OU.OUTFITS.filter((o) => o.seed !== undefined).map((o) => o.id)}`);
  });

  leg("the three earlier seeds were RECONCILED IN PLACE — same ids, not re-created", () => {
    const ids = new Set(OU.OUTFIT_IDS);
    for (const r of CATALOGUE_A.filter((x) => x.wasSeed)) {
      assert.ok(ids.has(r.id), `seed id ${r.id} did not survive the promotion`);
      assert.ok(OU.outfitById(r.id), `outfitById lost ${r.id}`);
    }
    // …and nothing was duplicated alongside them.
    assert.equal(new Set(OU.OUTFIT_IDS).size, 12);
  });

  leg("every entry's role, grade and chrome modifier are the §A row's own", () => {
    for (const r of CATALOGUE_A) {
      const o = OU.outfitById(r.id);
      assert.equal(o.roleDefault, r.role, `row ${r.n} role`);
      assert.equal(o.grade, r.grade, `row ${r.n} grade`);
      assert.equal(o.chromeCountMod, r.mod, `row ${r.n} chrome mod`);
    }
  });

  leg("every entry's armor posture and loot profile are the §A row's own", () => {
    for (const r of CATALOGUE_A) {
      const o = OU.outfitById(r.id);
      assert.equal(o.armorPosture.hardness, r.hardness, `row ${r.n} hardness`);
      assert.equal(o.armorPosture.weight, r.weight, `row ${r.n} weight`);
      assert.equal(o.armorPosture.armament, r.armament, `row ${r.n} armament`);
      assert.equal(o.lootProfile, r.loot, `row ${r.n} loot profile`);
    }
  });

  leg("every entry's skill-bias vector is the §A row's key set, at one uniform weight", () => {
    for (const r of CATALOGUE_A) {
      const o = OU.outfitById(r.id);
      assert.deepEqual(Object.keys(o.skillBias).sort(), [...r.bias].sort(), `row ${r.n} bias keys`);
      assert.ok(Object.values(o.skillBias).every((v) => v === 2),
        `row ${r.n} bias weights are not uniform: ${JSON.stringify(o.skillBias)}`);
    }
  });

  leg("ALL TWELVE ship hostile, entry 12 included (C3 is still open)", () => {
    for (const o of OU.OUTFITS) assert.equal(o.disposition, "hostile", `${o.id} is not hostile`);
    assert.equal(OU.outfitById("corporateStaffers").disposition, "hostile");
  });

  leg("gearSource is null on every entry — §B.5 is DEFERRED, not half-built", () => {
    for (const o of OU.OUTFITS) assert.equal(o.gearSource, null, `${o.id} declares a gearSource`);
  });

  leg("no entry carries a chassis — the borg/ACPA pair is deferred, not promoted", () => {
    assert.ok(OU.OUTFITS.every((o) => !o.chassis));
    assert.equal(OU.outfitById("fullBorgEnforcer"), null);
    assert.equal(OU.outfitById("acpaTrooper"), null);
  });

  leg("every entry carries the full §3 Outfit shape, incl. the FROZEN styleKit seam", () => {
    for (const o of OU.OUTFITS) {
      for (const k of ["id", "labelKey", "grade", "roleDefault", "chromeCountMod", "lootProfile", "disposition"]) {
        assert.ok(k in o, `${o.id} is missing ${k}`);
      }
      assert.equal(o.styleKit, null, `${o.id} styleKit is not frozen`);
      assert.equal(o.namePool, null, `${o.id} ships a name pool`);
      assert.equal(o.composition, null, `${o.id} ships a v2 composition`);
    }
  });

  leg("the BONUS-ITEM CHANNEL seam exists on every entry and ships EMPTY (wiring pending)", () => {
    for (const o of OU.OUTFITS) {
      assert.ok(Array.isArray(o.bonusPools), `${o.id} has no bonusPools array`);
      assert.equal(o.bonusPools.length, 0, `${o.id} shipped a wired bonus pool: ${JSON.stringify(o.bonusPools)}`);
    }
  });

  leg("no entry names a real-world organization (the p.41 ruling)", () => {
    const banned = /arasaka|militech|petrochem|kang tao|trauma team|ihag|orbital air|biotechnica|network news/i;
    for (const o of OU.OUTFITS) {
      assert.ok(!banned.test(o.id), `${o.id} names a real org`);
      assert.ok(!banned.test(o.labelKey), `${o.labelKey} names a real org`);
    }
  });

  // ── §B.2 — the grade span, as a PAIRED cross-reference and nothing more ──
  leg("B2 — exactly the paired police entries carry a grade-span note, and each names the other", () => {
    const withSpan = OU.OUTFITS.filter((o) => o.gradeSpanNoteKey).map((o) => o.id);
    assert.deepEqual(withSpan, ["cityPolicePatrol", "cityPoliceTactical"]);
    assert.equal(OU.outfitById("cityPolicePatrol").gradeSpanNoteKey, "GoonFactory.Outfit.CityPolicePatrolSpan");
    assert.equal(OU.outfitById("cityPoliceTactical").gradeSpanNoteKey, "GoonFactory.Outfit.CityPoliceTacticalSpan");
    // The pair really is a grade SPAN: same role, one rung apart on the ladder.
    assert.equal(OU.outfitById("cityPolicePatrol").roleDefault, OU.outfitById("cityPoliceTactical").roleDefault);
    assert.equal(GR.gradeIndex("B") - GR.gradeIndex("C"), 1);
  });

  leg("B2 — the span note is DISPLAY ONLY: it is a key, and no other entry has one", () => {
    for (const o of OU.OUTFITS) {
      if (!o.gradeSpanNoteKey) { assert.equal(o.gradeSpanNoteKey, null, `${o.id} carries a non-null falsy span`); continue; }
      assert.ok(o.gradeSpanNoteKey.startsWith("GoonFactory.Outfit."), `${o.id} span is not an i18n key`);
    }
  });

  // ── §B.3 — the flavour trio, carried as KEYS for the GM side ──
  leg("B3 — every entry declares the flavour trio, and every populated slot is an i18n KEY", () => {
    for (const o of OU.OUTFITS) {
      assert.ok(o.flavor && typeof o.flavor === "object", `${o.id} has no flavor block`);
      for (const k of ["jurisdictionKey", "reinforcementKey", "noteKey"]) {
        assert.ok(k in o.flavor, `${o.id} flavor is missing ${k}`);
        const v = o.flavor[k];
        if (v === null) continue;
        assert.ok(String(v).startsWith("GoonFactory.Outfit."),
          `${o.id}.${k} is literal text, not a key: ${v}`);
      }
    }
  });

  leg("B3 — the flavour block carries NO mechanical field (it is description only)", () => {
    const mechanical = ["grade", "chromeCountMod", "disposition", "lootProfile", "skillBias", "armorPosture"];
    for (const o of OU.OUTFITS) {
      for (const k of mechanical) assert.ok(!(k in o.flavor), `${o.id} flavor carries the mechanical key ${k}`);
    }
  });

  leg("B3 — the four entries whose §A row states jurisdiction/reinforcement are the ones that carry it", () => {
    const withJurisdiction = OU.OUTFITS.filter((o) => o.flavor.jurisdictionKey).map((o) => o.id);
    assert.deepEqual(withJurisdiction,
      ["cityPolicePatrol", "premiumCorpSecurity", "facilitySecurity", "boosterGang"]);
    const withNote = OU.OUTFITS.filter((o) => o.flavor.noteKey).map((o) => o.id);
    assert.deepEqual(withNote,
      ["cyberpsychoResponse", "executiveProtection", "dockPatrol", "corporateStaffers"]);
  });

  // ── the config seam: what resolveGoonConfig hands the impure layer ──
  leg("the resolved config carries the flavour keys and the span key through, unlocalized", () => {
    const c = BP.resolveGoonConfig({ outfitId: "cityPolicePatrol" });
    assert.equal(c.flavor.jurisdictionKey, "GoonFactory.Outfit.CityPolicePatrolJurisdiction");
    assert.equal(c.flavor.reinforcementKey, "GoonFactory.Outfit.CityPolicePatrolReinforcement");
    assert.equal(c.gradeSpanNoteKey, "GoonFactory.Outfit.CityPolicePatrolSpan");
    // …and the no-outfit case is a clean null rather than an empty object nobody can test against.
    const bare = BP.resolveGoonConfig({ role: "solo", grade: "C" });
    assert.equal(bare.flavor, null);
    assert.equal(bare.gradeSpanNoteKey, null);
  });
});

// =================================================================================================
// §B.1 — SKILL BIAS: a re-weighting overlay, and what it CANNOT do
// =================================================================================================

section("§B.1 skill bias (re-weighting only)", BP, () => {
  /** Total level a key ends at, summed over N independent seeds — the observable a weight moves. */
  function levelSum(key, { role, gradeKey, total, skillBias }) {
    let sum = 0;
    for (let i = 0; i < 40; i++) {
      const rng = BP.seededRng(BP.seedFrom("bias", role, gradeKey, i));
      const alloc = BP.allocateGoonSkills({ total, gradeKey, role, primaryWeapon: null, rng, skillBias });
      sum += alloc.skillLevels.find((s) => s.skillKey === key)?.level ?? 0;
    }
    return sum;
  }

  leg("a bias on a key the role's package HAS really re-weights it upward", () => {
    const opts = { role: "solo", gradeKey: "C", total: 40 };
    const without = levelSum("Melee", { ...opts, skillBias: {} });
    const withBias = levelSum("Melee", { ...opts, skillBias: { Melee: 8 } });
    assert.ok(withBias > without, `bias did not move the allocation: ${without} → ${withBias}`);
  });

  leg("a bias NEVER adds a skill the package lacks — the C9 case, asserted as a zero", () => {
    // Intimidate is the Fixer's, not the Solo's (dock patrol's third bias key is exactly this).
    assert.ok(!BP.CAREER_PACKAGES.solo.skills.includes("Intimidate"));
    const got = levelSum("Intimidate", { role: "solo", gradeKey: "C", total: 40, skillBias: { Intimidate: 8 } });
    assert.equal(got, 0, "a bias key outside the package was allocated points");
  });

  leg("the two other inert keys the catalogue carries are inert for the same reason", () => {
    assert.ok(!BP.CAREER_PACKAGES.cop.skills.includes("Rifle"));            // row 2
    const rifleOnCop = levelSum("Rifle", { role: "cop", gradeKey: "B", total: 40, skillBias: { Rifle: 8 } });
    assert.equal(rifleOnCop, 0);
    const anyPackageHasHeavy = Object.values(BP.CAREER_PACKAGES).some((p) => p.skills.includes("HeavyWeapons"));
    assert.equal(anyPackageHasHeavy, false, "HeavyWeapons is in a package after all — row 8's note is stale");
    const heavyOnSolo = levelSum("HeavyWeapons", { role: "solo", gradeKey: "A", total: 40, skillBias: { HeavyWeapons: 8 } });
    assert.equal(heavyOnSolo, 0);
  });

  leg("an inert bias key still leaves the goon able to use the weapon actually drawn", () => {
    // The grade's guarantee follows the PULLED weapon, so a rifle in a Cop's hands still gets Rifle
    // — through the guarantee, not through the bias. That is the C9 answer as it stands today.
    const rng = BP.seededRng(1234);
    const alloc = BP.allocateGoonSkills({
      total: 40, gradeKey: "B", role: "cop", rng, skillBias: { Rifle: 2, Athletics: 2 },
      primaryWeapon: { attackSkill: "Rifle", weaponType: "rifle" },
    });
    assert.equal(alloc.guarantee.skillKey, "Rifle");
    assert.ok((alloc.skillLevels.find((s) => s.skillKey === "Rifle")?.level ?? 0) >= 8);
  });
});

// =================================================================================================
// §2 THE PIPELINE — config resolution, stats, skills, naming, formula fields
// =================================================================================================

section("§2 pipeline", BP, () => {
  // ── §2.1 resolve config: outfit → grade derivation → manual overrides ──
  leg("picking an outfit prefills grade + role + chrome modifier", () => {
    const c = BP.resolveGoonConfig({ outfitId: "premiumCorpSecurity" });
    assert.equal(c.grade, "B");
    assert.equal(c.role, "solo");
    assert.equal(c.chromeCountMod, 1);
    assert.equal(c.custom, false);
    assert.equal(c.basedOn, "premiumCorpSecurity");
  });

  leg("a manual edit after an outfit flips the config to CUSTOM but keeps the origin", () => {
    const c = BP.resolveGoonConfig({ outfitId: "premiumCorpSecurity", overrides: { grade: "A" } });
    assert.equal(c.grade, "A");
    assert.equal(c.custom, true);
    assert.equal(c.basedOn, "premiumCorpSecurity");
  });

  leg("re-picking the outfit re-derives clean — the override is gone, not remembered", () => {
    const c = BP.resolveGoonConfig({ outfitId: "premiumCorpSecurity", overrides: {} });
    assert.equal(c.grade, "B");
    assert.equal(c.custom, false);
  });

  leg("a grade pick with no outfit derives every control from the grade", () => {
    const c = BP.resolveGoonConfig({ role: "cop", grade: "AA" });
    assert.equal(c.ref, 10);          // the sole tier exception
    assert.equal(c.bt, 7);            // constant at every grade
    assert.equal(c.skillPoints, 40);
    assert.equal(c.statPool, 60);
    assert.equal(c.chromeCount, 6);   // AA base, cop → no Solo bonus
    assert.equal(c.custom, false);
  });

  // ⭐ R2/R3 (ruled 2026-08-14): the flag says whether there is anything to DERIVE FROM — it is what
  // decides dash-or-number in the window. It no longer gates the Advanced checkbox, and the rename
  // off `advancedAvailable` is the assertion that says so.
  leg("no grade picked ⇒ nothing derives, and the config says so by value", () => {
    const c = BP.resolveGoonConfig({ role: "cop" });
    assert.equal(c.grade, null);
    assert.equal(c.gradeDerived, false);
    assert.equal(c.ref, null);
    assert.equal(c.bt, null);
    assert.equal(c.skillPoints, null);
    assert.equal(c.statPool, null);
    assert.equal(c.advancedAvailable, undefined);   // the gating field is GONE, not merely unused
    assert.equal(BP.resolveGoonConfig({ role: "cop", grade: "C" }).gradeDerived, true);
  });

  // ── §2.2 stats ──
  leg("the stat pool is spent EXACTLY: REF + BT + the free stats sum to the pool", () => {
    const r = BP.rollStatPool({ pool: 60, ref: 8, bt: 7, role: "solo", shape: "roleShaped", rng: scriptedRng([0.1, 0.4, 0.7, 0.2, 0.9, 0.55, 0.33]) });
    const sum = Object.entries(r.stats).filter(([k]) => k !== "luck").reduce((s, [, v]) => s + v, 0);
    assert.equal(sum, 60, `spent ${sum} of 60: ${JSON.stringify(r.stats)}`);
    assert.equal(r.stats.ref, 8);
    assert.equal(r.stats.bt, 7);
  });

  leg("no free stat lands below 2 or above 10", () => {
    const r = BP.rollStatPool({ pool: 90, ref: 10, bt: 10, role: "solo", shape: "roleShaped", rng: scriptedRng([0.99]) });
    for (const [k, v] of Object.entries(r.stats)) {
      if (k === "luck") continue;
      assert.ok(v >= 2, `${k} = ${v} < 2`);
      assert.ok(v <= 10, `${k} = ${v} > 10`);
    }
  });

  leg("ROLE-SHAPED: the largest portion lands on the role's PRIMARY stat, every time", () => {
    for (const seed of [[0.1, 0.9, 0.3, 0.7, 0.5, 0.2], [0.8, 0.2, 0.6, 0.4, 0.15, 0.95]]) {
      const r = BP.rollStatPool({ pool: 70, ref: 8, bt: 7, role: "techie", shape: "roleShaped", rng: scriptedRng(seed) });
      const free = Object.entries(r.stats).filter(([k]) => !["ref", "bt", "luck"].includes(k));
      const top = Math.max(...free.map(([, v]) => v));
      assert.equal(r.stats.tech, top, `techie primary TECH ${r.stats.tech} was not the top ${top}`);
    }
  });

  leg("PURE RANDOM ignores the weights — the primary is not guaranteed the top portion", () => {
    let primaryTopCount = 0;
    for (let i = 0; i < 24; i++) {
      const rng = BP.seededRng(BP.seedFrom("pure", i));
      const r = BP.rollStatPool({ pool: 70, ref: 8, bt: 7, role: "techie", shape: "pureRandom", rng });
      const free = Object.entries(r.stats).filter(([k]) => !["ref", "bt", "luck"].includes(k));
      if (r.stats.tech === Math.max(...free.map(([, v]) => v))) primaryTopCount++;
    }
    assert.ok(primaryTopCount < 24, "pure random still pinned the primary every single time");
  });

  leg("LOOSE lets the role show as a tendency: upsets happen, but the primary still leads on average", () => {
    let upsets = 0;
    for (let i = 0; i < 40; i++) {
      const rng = BP.seededRng(BP.seedFrom("loose", i));
      const r = BP.rollStatPool({ pool: 70, ref: 8, bt: 7, role: "techie", shape: "loose", rng });
      const free = Object.entries(r.stats).filter(([k]) => !["ref", "bt", "luck"].includes(k));
      if (r.stats.tech !== Math.max(...free.map(([, v]) => v))) upsets++;
    }
    assert.ok(upsets > 0, "loose never upset the ranking (it is behaving like role-shaped)");
    assert.ok(upsets < 40, "loose never honored the ranking (it is behaving like pure random)");
  });

  leg("stat VALUES always vary between goons even at the same pool (portions are rolled)", () => {
    const a = BP.rollStatPool({ pool: 60, ref: 8, bt: 7, role: "solo", shape: "roleShaped", rng: BP.seededRng(1) });
    const b = BP.rollStatPool({ pool: 60, ref: 8, bt: 7, role: "solo", shape: "roleShaped", rng: BP.seededRng(2) });
    assert.notEqual(JSON.stringify(a.stats), JSON.stringify(b.stats));
  });

  // ── Luck / Rep formula fields (§1 + §4) ──
  leg("the Luck default is 2d6 with the book's 11+ re-roll, and lands in 2–10", () => {
    assert.equal(BP.LUCK_FORMULA_DEFAULT, "2d6");
    for (let i = 0; i < 30; i++) {
      const r = BP.rollFormulaField(BP.LUCK_FORMULA_DEFAULT, BP.seededRng(i), { rerollOver: 10, fallback: BP.LUCK_FORMULA_DEFAULT });
      assert.ok(r.value >= 2 && r.value <= 10, `luck ${r.value} out of 2–10`);
      assert.equal(r.valid, true);
    }
  });

  // ⚠ RANGE ALONE IS NOT ENOUGH HERE and this leg was rewritten because of it: a bug that clamped
  // every Reputation roll to 0 passed a "0–5" range check thirty times in a row. The leg now asserts
  // that the field actually VARIES, which is the property that breaks when the roll stops rolling.
  leg("the Rep default is 1d6−1, lands in 0–5, and genuinely varies", () => {
    assert.equal(BP.REP_FORMULA_DEFAULT, "1d6-1");
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const r = BP.rollFormulaField(BP.REP_FORMULA_DEFAULT, BP.seededRng(i), { fallback: BP.REP_FORMULA_DEFAULT });
      assert.ok(r.value >= 0 && r.value <= 5, `rep ${r.value} out of 0–5`);
      seen.add(r.value);
    }
    assert.ok(seen.size >= 4, `Reputation produced only ${seen.size} distinct value(s): ${[...seen]}`);
  });

  leg("the Luck field varies too, and is not pinned by its re-roll rule", () => {
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      seen.add(BP.rollFormulaField(BP.LUCK_FORMULA_DEFAULT, BP.seededRng(i), { rerollOver: 10, fallback: BP.LUCK_FORMULA_DEFAULT }).value);
    }
    assert.ok(seen.size >= 5, `Luck produced only ${seen.size} distinct value(s): ${[...seen]}`);
  });

  leg("an INVALID formula falls back to the default and says so (never silently zero)", () => {
    const r = BP.rollFormulaField("not a formula", BP.seededRng(7), { fallback: BP.REP_FORMULA_DEFAULT });
    assert.equal(r.valid, false);
    assert.equal(r.used, BP.REP_FORMULA_DEFAULT);
    assert.ok(r.value >= 0 && r.value <= 5, `fallback produced ${r.value}`);
    assert.ok(r.noteKey, "no visible note for the invalid formula");
  });

  leg("a VALID non-default formula is honored, not overridden", () => {
    const r = BP.rollFormulaField("3d6+2", BP.seededRng(3), { fallback: BP.REP_FORMULA_DEFAULT });
    assert.equal(r.valid, true);
    assert.equal(r.used, "3d6+2");
    assert.ok(r.value >= 5 && r.value <= 20, `3d6+2 produced ${r.value}`);
  });

  // ── §2.4 the weapon-skill guarantee ──
  leg("the guarantee attaches to the governing skill of the ACTUALLY-PULLED weapon", () => {
    assert.equal(BP.weaponGoverningSkill({ name: "AK-47", attackSkill: "Rifle", weaponType: "Rifle" }), "Rifle");
    assert.equal(BP.weaponGoverningSkill({ name: "Colt", attackSkill: "Handgun", weaponType: "Pistol" }), "Handgun");
    assert.equal(BP.weaponGoverningSkill({ name: "Uzi", attackSkill: "", weaponType: "SMG" }), "Submachinegun");
  });

  leg("a non-Latin/garbled attackSkill falls back to the weapon TYPE, never to nothing", () => {
    assert.equal(BP.weaponGoverningSkill({ name: "Rippers", attackSkill: "Драка", weaponType: "Melee" }), "Brawling");
    assert.equal(BP.weaponGoverningSkill({ name: "?", attackSkill: "", weaponType: "" }), "Brawling");
  });

  leg("the guarantee really lands on the pulled weapon's skill, at the grade's points", () => {
    const plan = BP.allocateGoonSkills({
      total: 40, gradeKey: "B", role: "cop",
      primaryWeapon: { name: "AK-47", attackSkill: "Rifle", weaponType: "Rifle" },
      rng: scriptedRng([0.2, 0.5, 0.8, 0.1]),
    });
    const rifle = plan.skillLevels.find((s) => s.skillKey === "Rifle");
    assert.ok(rifle, `no Rifle level: ${JSON.stringify(plan.skillLevels)}`);
    assert.ok(rifle.level >= 8, `grade B guarantee not met: Rifle ${rifle.level}`);
    assert.equal(plan.guarantee.skillKey, "Rifle");
    assert.equal(plan.guarantee.points, 8);
  });

  leg("… and moves with the weapon: a pistol goon's guarantee is on Handgun, not Rifle", () => {
    const plan = BP.allocateGoonSkills({
      total: 40, gradeKey: "B", role: "cop",
      primaryWeapon: { name: "Colt", attackSkill: "Handgun", weaponType: "Pistol" },
      rng: scriptedRng([0.2, 0.5, 0.8, 0.1]),
    });
    assert.equal(plan.guarantee.skillKey, "Handgun");
    assert.ok(plan.skillLevels.find((s) => s.skillKey === "Handgun").level >= 8);
  });

  leg("the role's special ability auto-levels at the grade's skill points — no control, no zero", () => {
    const plan = BP.allocateGoonSkills({
      total: 40, gradeKey: "A", role: "cop",
      primaryWeapon: { name: "Colt", attackSkill: "Handgun", weaponType: "Pistol" },
      rng: scriptedRng([0.3]),
    });
    const sa = plan.skillLevels.find((s) => s.skillKey === "Authority");
    assert.ok(sa, "the Cop's special ability is absent");
    assert.equal(sa.level, 10);      // grade A skill points
  });

  leg("the point spend is exact — nothing silently vanishes", () => {
    const plan = BP.allocateGoonSkills({
      total: 40, gradeKey: "C", role: "solo",
      primaryWeapon: { name: "Colt", attackSkill: "Handgun", weaponType: "Pistol" },
      rng: scriptedRng([0.15, 0.45, 0.75, 0.35]),
    });
    const spent = plan.skillLevels.reduce((s, x) => s + x.level, 0);
    assert.equal(spent - plan.specialAbilityLevel, plan.spent, `spend mismatch: ${spent} vs ${plan.spent}`);
    assert.equal(plan.spent, 40);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // §2.4 THE BOOK'S CAREER SKILL PACKAGES (Core p.44)
  //
  // The expectation is transcribed HERE, independently of the module, from the two-channel
  // text-layer extraction `import-staging/CAREER-PACKAGES-P44.md` §4 PATCH-READY — so these legs
  // fail if the shipped table drifts from the page, not merely if it changes shape. They were run
  // RED against the interim stat-weighted combat spine that shipped with the window rebuild.
  //
  // The BOOK prints ten entries per role: slot 1 the special ability, slot 2 Awareness/Notice, then
  // eight more. What the module stores is the OTHER NINE — the special ability is levelled at the
  // grade, outside the point pool (the ruled deviation), and the arithmetic leg below pins that.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  const P44 = {
    solo:      ["AwarenessNotice", "Handgun", "Brawling", "Melee", "Weaponsmith", "Rifle", "Athletics", "Submachinegun", "Stealth"],
    cop:       ["AwarenessNotice", "Handgun", "HumanPerception", "Athletics", "EducationGeneralKnowledge", "Brawling", "Melee", "Interrogation", "Streetwise"],
    corp:      ["AwarenessNotice", "HumanPerception", "EducationGeneralKnowledge", "LibrarySearch", "Social", "PersuasionFastTalk", "StockMarket", "WardrobeStyle", "PersonalGrooming"],
    fixer:     ["AwarenessNotice", "Forgery", "Handgun", "Brawling", "Melee", "PickLock", "PickPocket", "Intimidate", "PersuasionFastTalk"],
    nomad:     ["AwarenessNotice", "Endurance", "Melee", "Rifle", "Driving", "BasicTech", "WildernessSurvival", "Brawling", "Athletics"],
    medtechie: ["AwarenessNotice", "BasicTech", "DiagnoseIllness", "EducationGeneralKnowledge", "CryotankOperation", "LibrarySearch", "Pharmaceuticals", "Zoology", "HumanPerception"],
    media:     ["AwarenessNotice", "Composition", "EducationGeneralKnowledge", "PersuasionFastTalk", "HumanPerception", "Social", "Streetwise", "PhotoFilm", "Interview"],
    rocker:    ["AwarenessNotice", "Perform", "WardrobeStyle", "Composition", "Brawling", "PlayInstrument", "Streetwise", "PersuasionFastTalk", "Seduction"],
  };
  /** Techie is the one package the page does not fully name: six fixed + "any three other Tech Skills". */
  const TECHIE_FIXED = ["AwarenessNotice", "BasicTech", "Cybertech", "Teaching", "EducationGeneralKnowledge", "Electronics"];
  /** The NARROW reading, ruled in 2026-08-14: exactly the four the page prints in its parenthetical. */
  const TECHIE_CHOICES = ["GyroTech", "AeroTech", "Weaponsmith", "ElectronicSecurity"];
  /** Keys the retired interim spine carried that appear in NO p.44 package — the drift detector. */
  const RETIRED_SPINE_ONLY = ["HeavyWeapons", "DodgeEscape", "ResistTortureDrugs", "FirstAid", "Leadership"];
  const PISTOL = { name: "Colt AMT", attackSkill: "Handgun", weaponType: "Pistol" };

  leg("each role's career package is the book's nine, in the book's own order", () => {
    for (const [role, want] of Object.entries(P44)) {
      assert.deepEqual(BP.CAREER_PACKAGES[role]?.skills, want, `${role} package drifted`);
    }
    assert.deepEqual(BP.CAREER_PACKAGES.techie?.skills, TECHIE_FIXED);
    assert.deepEqual(BP.CAREER_PACKAGES.techie?.choose?.from, TECHIE_CHOICES);
    assert.equal(BP.CAREER_PACKAGES.techie?.choose?.count, 3);
  });

  leg("slot 2 of every package is Awareness/Notice — the p.44 universal", () => {
    for (const [role, pkg] of Object.entries(BP.CAREER_PACKAGES)) {
      assert.equal(pkg.skills[0], "AwarenessNotice", `${role} does not open on Awareness/Notice`);
      assert.equal(pkg.skills.length + (pkg.choose?.count ?? 0), 9, `${role} is not nine skills`);
    }
  });

  leg("the package's slot-1 special ability is the role's own — the two tables cannot drift apart", () => {
    for (const [role, key] of Object.entries(GR.ROLE_SPECIAL_ABILITY)) {
      assert.equal(BP.CAREER_PACKAGES[role]?.special, key, `${role} special ability drifted`);
    }
  });

  leg("netrunner's package is transcribed but the ROLE stays out of the generator", () => {
    assert.ok(BP.CAREER_PACKAGES.netrunner, "the netrunner package was not transcribed");
    assert.equal(BP.CAREER_PACKAGES.netrunner.special, "Interface");
    assert.ok(!GR.GENERATOR_ROLES.includes("netrunner"), "netrunner was enabled as a role");
  });

  leg("Solo's either/or slot resolves to Brawling, and Martial Arts is not in the package", () => {
    assert.ok(BP.CAREER_PACKAGES.solo.skills.includes("Brawling"));
    assert.ok(!BP.CAREER_PACKAGES.solo.skills.includes("MartialArts"));
  });

  leg("a Solo goon spends ONLY on the Solo package, its pulled weapon's skill and its special ability", () => {
    const allowed = new Set([...P44.solo, "Handgun", "CombatSense"]);
    for (let s = 0; s < 40; s++) {
      const plan = BP.allocateGoonSkills({
        total: 40, gradeKey: "B", role: "solo", primaryWeapon: PISTOL, rng: BP.seededRng(s),
      });
      for (const { skillKey } of plan.skillLevels) {
        assert.ok(allowed.has(skillKey), `seed ${s}: ${skillKey} is outside the Solo career package`);
      }
    }
  });

  leg("… and the package's own skills really receive points — Weaponsmith, the ruled rename, lands", () => {
    let seedsWithPoints = 0;
    let totalPoints = 0;
    for (let s = 0; s < 40; s++) {
      const plan = BP.allocateGoonSkills({
        total: 40, gradeKey: "B", role: "solo", primaryWeapon: PISTOL, rng: BP.seededRng(s),
      });
      const w = plan.skillLevels.find((x) => x.skillKey === "Weaponsmith");
      if (w && w.level > 0) { seedsWithPoints++; totalPoints += w.level; }
    }
    assert.ok(seedsWithPoints >= 30, `Weaponsmith took points in only ${seedsWithPoints}/40 seeds`);
    assert.ok(totalPoints >= 40, `Weaponsmith took only ${totalPoints} points across 40 goons`);
  });

  leg("the retired interim spine is gone: no role spends on a spine-only skill", () => {
    for (const role of GR.GENERATOR_ROLES) {
      for (let s = 0; s < 20; s++) {
        const plan = BP.allocateGoonSkills({
          total: 40, gradeKey: "A", role, primaryWeapon: PISTOL, rng: BP.seededRng(s),
        });
        for (const { skillKey } of plan.skillLevels) {
          assert.ok(!RETIRED_SPINE_ONLY.includes(skillKey),
            `${role} seed ${s}: ${skillKey} is a retired-spine skill, not a p.44 career skill`);
        }
      }
    }
  });

  leg("every role's spend stays inside its OWN package (a Corp goon never rolls Submachinegun)", () => {
    for (const [role, want] of Object.entries(P44)) {
      const allowed = new Set([...want, "Handgun", GR.ROLE_SPECIAL_ABILITY[role]]);
      for (let s = 0; s < 20; s++) {
        const plan = BP.allocateGoonSkills({
          total: 40, gradeKey: "C", role, primaryWeapon: PISTOL, rng: BP.seededRng(s),
        });
        for (const { skillKey } of plan.skillLevels) {
          assert.ok(allowed.has(skillKey), `${role} seed ${s}: ${skillKey} is outside its own package`);
        }
      }
    }
  });

  leg("Techie's three free slots land ONLY within the four Tech skills the page names", () => {
    for (let s = 0; s < 60; s++) {
      const pkg = BP.careerPackage("techie", BP.seededRng(s));
      assert.equal(pkg.skills.length, 9, `seed ${s}: techie package is ${pkg.skills.length} skills`);
      assert.deepEqual(pkg.skills.slice(0, 6), TECHIE_FIXED, `seed ${s}: the fixed six moved`);
      assert.equal(pkg.chosen.length, 3, `seed ${s}: ${pkg.chosen.length} free slots, not 3`);
      assert.equal(new Set(pkg.chosen).size, 3, `seed ${s}: a free slot repeated: ${pkg.chosen}`);
      for (const k of pkg.chosen) {
        assert.ok(TECHIE_CHOICES.includes(k), `seed ${s}: ${k} is outside the four named Tech skills`);
      }
    }
  });

  leg("… the free choice genuinely varies across seeds rather than being pinned", () => {
    const combos = new Set();
    for (let s = 0; s < 60; s++) combos.add([...BP.careerPackage("techie", BP.seededRng(s)).chosen].sort().join("+"));
    assert.ok(combos.size >= 2, `the Techie free choice produced only ${combos.size} combination(s): ${[...combos]}`);
    assert.ok(combos.size <= 4, `more combinations than 3-of-4 allows: ${[...combos]}`);
  });

  leg("… and the BROAD tech reading is NOT what ships (no goon Techie paints or does demolitions)", () => {
    const broadOnly = ["PaintOrDraw", "Demolitions", "Disguise", "AVTech", "PhotoFilm"];
    let seedsWithANarrowChoice = 0;
    for (let s = 0; s < 40; s++) {
      const plan = BP.allocateGoonSkills({
        total: 40, gradeKey: "B", role: "techie", primaryWeapon: PISTOL, rng: BP.seededRng(s),
      });
      const keys = plan.skillLevels.map((x) => x.skillKey);
      for (const k of keys) assert.ok(!broadOnly.includes(k), `seed ${s}: ${k} came from the broad TECH set`);
      if (keys.some((k) => TECHIE_CHOICES.includes(k))) seedsWithANarrowChoice++;
    }
    // The positive half: the free slots are not merely absent from the broad set, they are PRESENT
    // from the narrow one — a Techie who never rolls any of the four would pass the negative alone.
    assert.ok(seedsWithANarrowChoice >= 30,
      `only ${seedsWithANarrowChoice}/40 Techies took points in any of the four named Tech skills`);
  });

  leg("the special ability sits OUTSIDE the pool: the nine take the slider total, the SA takes the grade", () => {
    const plan = BP.allocateGoonSkills({
      total: 40, gradeKey: "B", role: "media", primaryWeapon: PISTOL, rng: BP.seededRng(11),
    });
    const saKey = GR.ROLE_SPECIAL_ABILITY.media;                     // Credibility
    const sa = plan.skillLevels.find((x) => x.skillKey === saKey);
    assert.ok(sa, "the Media special ability is absent");
    assert.equal(sa.level, GR.GRADES.B.skillPts);                    // the grade's own points, 8
    assert.equal(plan.specialAbilityLevel, GR.GRADES.B.skillPts);
    // The arithmetic: package + reserved guarantee = the slider total, and the SA is on top of it.
    const packageSpend = plan.skillLevels.filter((x) => x.skillKey !== saKey).reduce((a, x) => a + x.level, 0);
    assert.equal(packageSpend, 40, `the nine spent ${packageSpend}, not the slider's 40`);
    assert.equal(plan.spent, 40);
    assert.equal(plan.skillLevels.reduce((a, x) => a + x.level, 0), 48,
      "the SA is being paid for out of the 40 — it must be extra");
    // The SA appears exactly once: it is never also a package entry taking a second helping.
    assert.equal(plan.skillLevels.filter((x) => x.skillKey === saKey).length, 1);
  });

  leg("… and the guarantee still lands even when the role's package carries no weapon skill", () => {
    const plan = BP.allocateGoonSkills({
      total: 40, gradeKey: "A", role: "corp", primaryWeapon: PISTOL, rng: BP.seededRng(5),
    });
    assert.ok(!P44.corp.includes("Handgun"), "the Corp package should have no weapon skill");
    assert.equal(plan.guarantee.skillKey, "Handgun");
    assert.equal(plan.guarantee.points, GR.GRADES.A.skillPts);
    assert.ok(plan.skillLevels.find((x) => x.skillKey === "Handgun").level >= 10);
    assert.equal(plan.spent, 40);
  });

  // ── §2.7 naming ──
  leg("the name pattern is {Outfit|Role} {Grade}-{n}", () => {
    assert.equal(BP.goonName("City Police — Patrol", "C", 3), "City Police — Patrol C-3");
    assert.equal(BP.goonName("Solo", "AA", 1), "Solo AA-1");
  });

  leg("numbering CONTINUES per prefix within the destination, and per grade", () => {
    const existing = ["Solo B-1", "Solo B-2", "Solo B-7", "Cop C-1", "Solo AA-3"];
    assert.equal(BP.nextGoonNumber(existing, "Solo", "B"), 8);
    assert.equal(BP.nextGoonNumber(existing, "Solo", "AA"), 4);
    assert.equal(BP.nextGoonNumber(existing, "Cop", "C"), 2);
    assert.equal(BP.nextGoonNumber(existing, "Nomad", "E"), 1);
    assert.equal(BP.nextGoonNumber([], "Solo", "B"), 1);
  });

  leg("a same-prefix name that is NOT the pattern does not bump the counter", () => {
    assert.equal(BP.nextGoonNumber(["Solo B-fred", "Solo Bravo", "Solo B-2"], "Solo", "B"), 3);
  });

  // ── the whole blueprint ──
  leg("goonBlueprint is deterministic: the same seed twice is deep-equal", () => {
    const mk = () => BP.goonBlueprint({ role: "solo", grade: "B", count: 3, seed: "gf-seed-1" });
    assert.deepEqual(mk(), mk());
  });

  leg("… and a different seed really changes the squad", () => {
    const a = BP.goonBlueprint({ role: "solo", grade: "B", count: 3, seed: "gf-seed-1" });
    const b = BP.goonBlueprint({ role: "solo", grade: "B", count: 3, seed: "gf-seed-2" });
    assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  });

  leg("every goon carries its own retained seed (reproducibility, no visible-seed UI)", () => {
    const bps = BP.goonBlueprint({ role: "solo", grade: "B", count: 4, seed: "gf-seed-1" });
    const seeds = new Set(bps.map((b) => b.seed));
    assert.equal(seeds.size, 4, "two goons share a seed stream");
  });

  leg("the count cap is enforced at the blueprint, not just the form", () => {
    assert.equal(BP.goonBlueprint({ role: "solo", grade: "B", count: 99, seed: "x" }).length, 12);
  });

  leg("an AA goon's REF really is 10 and its BT really is 7 (the derived defaults survive the roll)", () => {
    for (const bp of BP.goonBlueprint({ role: "cop", grade: "AA", count: 3, seed: "aa" })) {
      assert.equal(bp.stats.ref, 10);
      assert.equal(bp.stats.bt, 7);
    }
  });

  leg("the honesty lines the preview needs are produced by the PLAN, not by the window", () => {
    const bp = BP.goonBlueprint({ role: "solo", grade: "B", count: 1, seed: "honesty" })[0];
    const codes = bp.honesty.map((h) => h.code);
    assert.ok(codes.includes("luckRepRolled"), `no rolled-not-derived line: ${codes}`);
  });
});

// =================================================================================================
// ROLE = RANDOM — the control's DEFAULT, drawn PER GOON (ruled 2026-08-15)
//
// Two things are under test and they are separable: the POOL AND THE INDEX MAPPING (a mechanism —
// asserted against scripted draws, never against a distribution), and the THREADING (does the role
// each goon rolled actually reach its package, its special ability and its stat order, or does a
// silent `?? solo` fallback eat the draw). Every leg here is one or the other.
// =================================================================================================

section("role = random (per-goon draw)", BP, () => {
  const R = GR.ROLE_RANDOM;

  // ── THE SENTINEL AND THE OPTION LIST ────────────────────────────────────────────────────────
  leg("the sentinel is the string `random`, and it leads the Role select's options", () => {
    assert.equal(GR.ROLE_RANDOM, "random");
    assert.equal(GR.ROLE_OPTIONS[0], R);
    assert.deepEqual(GR.ROLE_OPTIONS.slice(1), GR.GENERATOR_ROLES);
    assert.ok(!GR.GENERATOR_ROLES.includes(R), "the sentinel leaked into the real role list");
  });

  // ── THE POOL ────────────────────────────────────────────────────────────────────────────────
  leg("the draw pool is ROLE_ENUM's order, intersected with the roles the control offers", () => {
    assert.deepEqual(BP.RANDOM_ROLE_POOL, TB_ROLE_ENUM.filter((r) => GR.GENERATOR_ROLES.includes(r)));
    assert.deepEqual(BP.RANDOM_ROLE_POOL,
      ["solo", "rocker", "media", "nomad", "fixer", "cop", "corp", "techie", "medtechie"]);
  });

  leg("⛔ the pool omits netrunner — the standing needle holds for a RANDOM draw too", () => {
    assert.ok(!BP.RANDOM_ROLE_POOL.includes("netrunner"), "a random draw could land on netrunner");
    assert.equal(BP.RANDOM_ROLE_POOL.length, 9);
    assert.ok(TB_ROLE_ENUM.includes("netrunner"), "the schema enum lost netrunner — check the filter");
  });

  leg("every drawable role has a stat vector and a career package, so no draw degrades silently", () => {
    for (const role of BP.RANDOM_ROLE_POOL) {
      assert.ok(Array.isArray(GR.ROLE_WEIGHTS[role]) && GR.ROLE_WEIGHTS[role].length > 0, `no vector for ${role}`);
      assert.ok(BP.CAREER_PACKAGES[role], `no career package for ${role}`);
    }
  });

  // ── THE INDEX MAPPING (the MECHANISM, not a distribution) ───────────────────────────────────
  leg("the draw is floor(r × 9) over the pool — asserted index by index, not statistically", () => {
    const pool = BP.RANDOM_ROLE_POOL;
    for (let i = 0; i < pool.length; i++) {
      const mid = (i + 0.5) / pool.length;
      assert.equal(BP.rollRoleFor(() => mid), pool[i], `draw ${mid} did not land on index ${i}`);
    }
    assert.equal(BP.rollRoleFor(() => 0), pool[0]);
    assert.equal(BP.rollRoleFor(() => 0.9999999), pool[pool.length - 1]);
  });

  leg("an rng that returns exactly 1 clamps onto the last entry rather than off the end", () => {
    assert.equal(BP.rollRoleFor(() => 1), BP.RANDOM_ROLE_POOL[BP.RANDOM_ROLE_POOL.length - 1]);
    assert.ok(BP.rollRoleFor(() => 1) !== undefined);
  });

  leg("resolveRole rolls ONLY the sentinel; every other value passes through untouched", () => {
    assert.equal(BP.resolveRole(R, () => 0), "solo");
    assert.equal(BP.resolveRole("cop", () => 0), "cop");        // the rng is not even consulted
    assert.equal(BP.resolveRole(null, () => 0), null);           // a direct caller's null still falls through
  });

  // ── THE CONTROL'S PREFILL / OVERRIDE MACHINERY ──────────────────────────────────────────────
  leg("Random is the resolved DEFAULT when nothing names a role", () => {
    assert.equal(BP.resolveGoonConfig({}).role, R);
    assert.equal(BP.resolveGoonConfig({ grade: "B" }).role, R);
    assert.equal(BP.resolveGoonConfig({ grade: "B" }).custom, false, "a bare default is not a custom config");
  });

  leg("an outfit's roleDefault PREFILLS over the Random default", () => {
    const c = BP.resolveGoonConfig({ outfitId: "chromerGang", role: R });
    assert.equal(c.role, "rocker");
    assert.equal(c.role, OU.outfitById("chromerGang").roleDefault);
    assert.equal(c.custom, false, "a prefill is not a hand edit");
  });

  leg("… and an explicit flip BACK to Random beats the outfit and sticks", () => {
    const c = BP.resolveGoonConfig({ outfitId: "chromerGang", role: R, overrides: { role: R } });
    assert.equal(c.role, R);
    assert.equal(c.custom, true, "the flip did not read as a hand edit");
    assert.equal(c.basedOn, "chromerGang", "the origin was lost");
  });

  leg("… and the flip behaves like every other control: re-picking the outfit drops it", () => {
    const c = BP.resolveGoonConfig({ outfitId: "chromerGang", role: R, overrides: {} });
    assert.equal(c.role, "rocker");
    assert.equal(c.custom, false);
  });

  leg("a concrete role override beats the outfit exactly as Random does (the symmetry)", () => {
    const c = BP.resolveGoonConfig({ outfitId: "chromerGang", role: R, overrides: { role: "cop" } });
    assert.equal(c.role, "cop");
    assert.equal(c.custom, true);
  });

  // ── THE DISPLAYED CHROME COUNT STAYS TRUE ───────────────────────────────────────────────────
  leg("Random draws NO Solo chrome bonus, so the displayed count is true for every goon", () => {
    const rnd = BP.resolveGoonConfig({ role: R, grade: "B" });
    const solo = BP.resolveGoonConfig({ role: "solo", grade: "B" });
    const cop = BP.resolveGoonConfig({ role: "cop", grade: "B" });
    assert.equal(rnd.chromeCount, 3);                 // grade B base, no bump
    assert.equal(cop.chromeCount, 3);                 // a non-Solo role reads the same
    assert.equal(solo.chromeCount, 5);                // the bump exists, and Random does not take it
    assert.equal(rnd.chromeDerivation.soloBonus, 0);
  });

  leg("… and no goon in a Random batch re-derives a different count, whatever it rolled", () => {
    const bps = BP.goonBlueprint({ role: R, grade: "B", count: 6, seed: "chrome-truth" });
    assert.ok(bps.some((b) => b.role === "solo"), "seed produced no Solo — the leg proves nothing");
    for (const b of bps) assert.equal(b.plan.chromeCount, 3, `${b.role} got ${b.plan.chromeCount}`);
  });

  // ── THE PER-GOON ROLL ───────────────────────────────────────────────────────────────────────
  leg("each goon rolls its OWN role: a pinned seed yields four different ones", () => {
    const roles = BP.goonBlueprint({ role: R, grade: "B", count: 4, seed: "sq1" }).map((b) => b.role);
    assert.deepEqual(roles, ["techie", "corp", "rocker", "fixer"]);
  });

  leg("… and the draw is independent per goon, not a shuffle: a batch may repeat a role", () => {
    const roles = BP.goonBlueprint({ role: R, grade: "B", count: 4, seed: "__PW__mix" }).map((b) => b.role);
    assert.deepEqual(roles, ["corp", "techie", "techie", "solo"]);
  });

  leg("the same seed re-rolls the same roles, twice over (determinism)", () => {
    const a = BP.goonBlueprint({ role: R, grade: "B", count: 6, seed: "det-role" }).map((b) => b.role);
    const b = BP.goonBlueprint({ role: R, grade: "B", count: 6, seed: "det-role" }).map((b) => b.role);
    assert.deepEqual(a, b);
    const c = BP.goonBlueprint({ role: R, grade: "B", count: 6, seed: "det-role-other" }).map((b) => b.role);
    assert.notDeepEqual(a, c, "a different seed produced the same roles");
  });

  leg("a CONCRETE role is not rolled at all, and says so", () => {
    for (const bp of BP.goonBlueprint({ role: "cop", grade: "B", count: 3, seed: "sq1" })) {
      assert.equal(bp.role, "cop");
      assert.equal(bp.roleRolled, false);
    }
    for (const bp of BP.goonBlueprint({ role: R, grade: "B", count: 3, seed: "sq1" })) {
      assert.equal(bp.roleRolled, true);
    }
  });

  leg("⛔ the sentinel never survives into a goon's own role field", () => {
    for (const bp of BP.goonBlueprint({ role: R, grade: "C", count: 8, seed: "no-sentinel" })) {
      assert.notEqual(bp.role, R, "a goon is carrying the control value as its role");
      assert.ok(TB_ROLE_ENUM.includes(bp.role), `${bp.role} is not a schema role`);
    }
  });

  leg("the role is drawn on its OWN sub-stream, folded off the goon's seed", () => {
    // The exact idiom, re-derived rather than trusted: seedFrom(goonSeed, "role"). Getting this
    // wrong is invisible at the table and fatal to reproducibility, so it is pinned by value.
    for (const b of BP.goonBlueprint({ role: R, grade: "B", count: 4, seed: "stream" })) {
      assert.equal(b.role, BP.resolveRole(R, BP.seededRng(BP.seedFrom(b.seed, "role"))), b.name);
    }
  });

  leg("… so the roll takes NO draw from the main stream: the stats are still its first consumer", () => {
    // If the role had been drawn off `rng` the stat portions would be shifted by one draw. Rebuilding
    // them from a FRESH stream at the goon's own seed is what proves it did not.
    for (const b of BP.goonBlueprint({ role: R, grade: "B", count: 4, seed: "stream" })) {
      const again = BP.rollStatPool({
        pool: b.config.statPool, ref: b.config.ref, bt: b.config.bt,
        role: b.role, shape: b.config.statShape, rng: BP.seededRng(b.seed),
      });
      assert.deepEqual(again.portions, b.statRoll.portions, b.name);
      assert.deepEqual(again.order, b.statRoll.order, b.name);
    }
  });

  // ── THE ROLLED ROLE REALLY DRIVES EVERY CONSUMER ────────────────────────────────────────────
  leg("the rolled role's CAREER PACKAGE is the one that was spent — asserted per goon by value", () => {
    const bps = BP.goonBlueprint({ role: R, grade: "B", count: 6, seed: "sq1" });
    assert.ok(new Set(bps.map((b) => b.role)).size > 1, "a single-role batch proves nothing here");
    for (const b of bps) {
      const pkg = BP.CAREER_PACKAGES[b.role];
      assert.equal(b.skillPlan.specialAbilityKey, pkg.special,
        `${b.name} rolled ${b.role} but carries ${b.skillPlan.specialAbilityKey}`);
      // Every allocated key is either in the rolled role's package, one of its free-choice draws, or
      // the weapon guarantee's own skill — never a key from some other role's list.
      const allowed = new Set([...b.skillPlan.careerSkills, b.skillPlan.guarantee.skillKey, pkg.special]);
      for (const s of b.skillLevels) assert.ok(allowed.has(s.skillKey), `${b.role} was levelled in ${s.skillKey}`);
    }
  });

  leg("… and the SPECIAL ABILITY sits at the grade's points, on the rolled role's own skill", () => {
    for (const b of BP.goonBlueprint({ role: R, grade: "A", count: 6, seed: "sq1" })) {
      const key = BP.CAREER_PACKAGES[b.role].special;
      const row = b.skillLevels.find((s) => s.skillKey === key);
      assert.ok(row, `${b.role} has no ${key} row`);
      assert.equal(row.level, GR.GRADES.A.skillPts);
    }
  });

  leg("… and the STAT ORDER is the rolled role's vector, not the control's and not solo's", () => {
    const bps = BP.goonBlueprint({ role: R, grade: "B", count: 6, seed: "sq1" });
    for (const b of bps) {
      const want = GR.ROLE_WEIGHTS[b.role][0];
      assert.equal(b.statRoll.order[0], want,
        `${b.name} rolled ${b.role} (primary ${want}) but its order leads with ${b.statRoll.order[0]}`);
    }
    // The negative: at least one goon's leading stat is NOT solo's, so the leg could actually fail.
    assert.ok(bps.some((b) => b.statRoll.order[0] !== GR.ROLE_WEIGHTS.solo[0]),
      "every goon happened to lead with solo's primary — pick a seed with more spread");
  });

  // ── NAMING ──────────────────────────────────────────────────────────────────────────────────
  leg("a Random batch is named `Goon {Grade}-{n}` — the sentinel is never a name prefix", () => {
    const bps = BP.goonBlueprint({ role: R, grade: "B", count: 3, seed: "names" });
    assert.deepEqual(bps.map((b) => b.name), ["Goon B-1", "Goon B-2", "Goon B-3"]);
    assert.ok(bps.every((b) => b.namePrefix === "Goon"), bps.map((b) => b.namePrefix));
    // The negatives: a picked role and an outfit both still name their own batches.
    assert.equal(BP.goonBlueprint({ role: "cop", grade: "B", count: 1, seed: "names" })[0].name, "cop B-1");
    assert.equal(BP.goonBlueprint({ outfitId: "chromerGang", count: 1, seed: "names" })[0].namePrefix, "chromerGang");
  });
});

// =================================================================================================
// DISPOSITION — a BASELINE control, prefilled by an outfit and flipped freely (ruled 2026-08-15)
// =================================================================================================

section("disposition (baseline control)", BP, () => {
  leg("the control offers hostile and neutral, hostile by default", () => {
    assert.deepEqual(GR.DISPOSITIONS, ["hostile", "neutral"]);
    assert.equal(GR.DISPOSITION_DEFAULT, "hostile");
    assert.equal(BP.resolveGoonConfig({}).disposition, "hostile");
    assert.equal(BP.resolveGoonConfig({ role: "solo", grade: "B" }).disposition, "hostile");
  });

  leg("an outfit PREFILLS it, by the entry's own value", () => {
    for (const o of OU.OUTFITS) {
      assert.equal(BP.resolveGoonConfig({ outfitId: o.id }).disposition, o.disposition, o.id);
    }
  });

  leg("a hand flip beats the outfit and reads as custom", () => {
    const c = BP.resolveGoonConfig({ outfitId: "chromerGang", overrides: { disposition: "neutral" } });
    assert.equal(c.disposition, "neutral");
    assert.equal(c.custom, true);
    assert.equal(c.basedOn, "chromerGang");
  });

  leg("⛔ it resolves in the UNDERIVED state too — a baseline control never waits on a grade", () => {
    const c = BP.resolveGoonConfig({ overrides: { disposition: "neutral" } });
    assert.equal(c.gradeDerived, false, "this leg is meant to run in the no-grade branch");
    assert.equal(c.disposition, "neutral");
    assert.equal(BP.resolveGoonConfig({}).disposition, "hostile");   // the negative, same branch
  });

  leg("it is on the list of controls a grade pick derives, so a re-pick clears it", () => {
    assert.ok(BP.DERIVED_CONTROL_KEYS.includes("disposition"), BP.DERIVED_CONTROL_KEYS);
    assert.ok(BP.DERIVED_CONTROL_KEYS.includes("role"));
  });
});

// =================================================================================================
// ROUND 2 (ruled 2026-08-14) — R6 tick positions · R7 the reserved segment and its clamp ·
// R9 the armor-weight split · the carried-cash rescope and its salvage disclosure
// =================================================================================================

section("round 2 — track geometry, the EV split and the salvage disclosure", GR, () => {
  // ── R6/R7: ONE FUNCTION ANSWERS BOTH, so both are asserted against IT rather than against a
  // transcribed pixel. A tick's position and a band's edge are the same question.
  leg("a value's track position is a percentage of the track's own span", () => {
    assert.equal(GR.trackPct(2, 2, 10), 0);
    assert.equal(GR.trackPct(6, 2, 10), 50);
    assert.equal(GR.trackPct(10, 2, 10), 100);
  });

  leg("a value outside the track clamps to the track rather than running off it", () => {
    assert.equal(GR.trackPct(-40, 0, 80), 0);
    assert.equal(GR.trackPct(400, 0, 80), 100);
  });

  leg("a track with no span reports 0 rather than dividing by zero", () => {
    assert.equal(GR.trackPct(5, 10, 10), 0);
    assert.equal(GR.trackPct(5, 0, NaN), 0);
  });

  // ── R6: THE BODY TICKS ARE THE BTM BREAKPOINTS, AT THESE EXACT POSITIONS ──────────────────────
  leg("the BODY slider carries four ticks, at the BTM breakpoints 3/5/8/10", () => {
    assert.deepEqual(GR.BT_TICKS.map((t) => t.value), [3, 5, 8, 10]);
  });

  leg("each BODY tick lands at its own position on the 2–10 track", () => {
    const pcts = GR.BT_TICKS.map((t) => GR.trackPct(t.value, GR.BT_RANGE.min, GR.BT_RANGE.max));
    assert.deepEqual(pcts, [12.5, 37.5, 75, 100]);
  });

  leg("every BODY tick names its band, so the mark has something to say on hover", () => {
    for (const t of GR.BT_TICKS) assert.ok(/^GoonFactory\.BtBand\.\d+$/.test(t.hintKey), t.hintKey);
  });

  // ── R6: THE STAT-POOL TICKS ARE THE NAMED TIERS ──────────────────────────────────────────────
  leg("the stat-pool slider carries five ticks, at the named tiers 50/60/70/75/80", () => {
    assert.deepEqual(GR.STAT_POOL.ticks.map((t) => t.value), [50, 60, 70, 75, 80]);
  });

  leg("each stat-pool tick lands at its own position on the fixed 0–90 track", () => {
    const pcts = GR.STAT_POOL.ticks.map((t) => GR.trackPct(t.value, GR.STAT_POOL.scaleMin, GR.STAT_POOL.ceiling));
    assert.deepEqual(pcts, [55.56, 66.67, 77.78, 83.33, 88.89]);
  });

  // ── R7: THE TRACK STAYS PUT AND THE BAND GROWS ───────────────────────────────────────────────
  leg("both tracks run from a FIXED origin — the reservation could not be drawn otherwise", () => {
    assert.equal(GR.SKILL_POINTS.scaleMin, 0);
    assert.equal(GR.SKILL_POINTS.scaleMax, 80);
    assert.equal(GR.STAT_POOL.scaleMin, 0);
    assert.equal(GR.STAT_POOL.ceiling, 90);
  });

  leg("the skill band is the grade's own weapon-skill guarantee, and it GROWS with the threat level", () => {
    const pctFor = (g) => GR.trackPct(GR.skillPointBreakdown(40, g).floor, GR.SKILL_POINTS.scaleMin, GR.SKILL_POINTS.scaleMax);
    assert.equal(pctFor("E"), 2.5);      // 2 of 80
    assert.equal(pctFor("B"), 10);       // 8 of 80
    assert.equal(pctFor("AA"), 12.5);    // 10 of 80
    assert.ok(pctFor("E") < pctFor("B") && pctFor("B") < pctFor("AA"));
  });

  leg("… while the track itself does NOT move with the threat level (the negative case)", () => {
    for (const g of GR.GRADE_KEYS) {
      const b = GR.skillPointBreakdown(40, g);
      assert.equal(b.total, 40, `grade ${g} moved the total`);
      assert.equal(GR.SKILL_POINTS.scaleMax, 80);
    }
  });

  leg("the skill band's edge IS the clamp floor — one number, so the thumb stops on the edge", () => {
    const b = GR.skillPointBreakdown(40, "B");
    assert.equal(b.floor, b.reserved);
    assert.equal(b.floor, 8);
    assert.equal(GR.skillPointBreakdown(4, "B").total, 8, "a total under the guarantee did not clamp up");
  });

  leg("the stat-pool band is the dynamic floor, and it tracks REF and BODY", () => {
    const pctFor = (ref, bt) => GR.trackPct(GR.statPoolBreakdown(60, ref, bt).floor, GR.STAT_POOL.scaleMin, GR.STAT_POOL.ceiling);
    assert.equal(GR.statPoolBreakdown(60, 8, 7).floor, 29);     // 8 + 7 + 7×2
    assert.equal(pctFor(8, 7), 32.22);
    assert.equal(GR.statPoolBreakdown(60, 10, 7).floor, 31);    // grade AA's REF exception
    assert.equal(pctFor(10, 7), 34.44);
    assert.ok(pctFor(10, 7) > pctFor(8, 7));
  });

  leg("the stat-pool band's edge is where the pool clamps up to", () => {
    const b = GR.statPoolBreakdown(10, 8, 7);
    assert.equal(b.pool, b.floor);
    assert.equal(b.clamped, true);
    assert.equal(GR.statPoolBreakdown(60, 8, 7).clamped, false);
  });

  leg("the breakdown line's own numbers are the band's numbers (floor = reserved + the minimums)", () => {
    const b = GR.statPoolBreakdown(60, 8, 7);
    assert.equal(b.reserved, 15);
    assert.equal(b.floor - b.reserved, GR.FREE_STAT_SLOTS * GR.STAT_MIN);
  });

  // ── R9: THE ARMOR-WEIGHT SPLIT, DERIVED FROM THE FUNCTION THAT MAKES IT ───────────────────────
  leg("the weight classes split at EV 1 / EV 2 — derived from weightClassOf, not from a literal", () => {
    const cls = (ev) => AR.weightClassOf({ ev });
    const evs = [0, 1, 2, 3, 4, 5, 6];
    const light = evs.filter((ev) => cls(ev) === "light");
    const heavy = evs.filter((ev) => cls(ev) === "heavy");
    assert.deepEqual(light, [0, 1], `light EVs: ${light}`);
    assert.equal(Math.min(...heavy), 2);
    assert.equal(cls({}), "light", "an item with no EV at all is not heavy");
  });

  // ── THE CARRIED-CASH RESCOPE ─────────────────────────────────────────────────────────────────
  leg("⛔ INVARIANT — the dial never filters gear: nothing but `loot` changes with it", () => {
    const strip = (cfg) => { const c = { ...cfg }; delete c.loot; return JSON.stringify(c); };
    const off = BP.resolveGoonConfig({ role: "solo", grade: "B", overrides: { loot: "off" } });
    const rich = BP.resolveGoonConfig({ role: "solo", grade: "B", overrides: { loot: "generous" } });
    assert.equal(off.loot, "off");
    assert.equal(rich.loot, "generous");
    assert.equal(strip(off), strip(rich));
  });

  leg("… and the dial's own output is cash and magazines, nothing else", () => {
    assert.deepEqual(GR.lootProfileFor("off", "B"), { dial: "off", spareMags: 0, cashEb: 0 });
    const g = GR.lootProfileFor("generous", "B");
    assert.ok(g.cashEb > 0 && g.spareMags === 3, JSON.stringify(g));
  });

  const salvageRow = () => ({
    weaponRow: { cost: 450 },
    armor: { layers: [{ cost: 100 }, { cost: 250 }] },
    chrome: { items: [{ cost: 200 }, { cost: 400 }], bonusItems: [{ cost: 50 }] },
    loot: { cashEb: 5000, spareMags: 3 },
  });

  leg("the salvage estimate sums the weapon, the armor layers and the chrome", () => {
    const s = GR.salvageEstimate([salvageRow()]);
    assert.equal(s.exact, 1450);            // 450 + 350 + 650
    assert.equal(s.rounded, 1500);          // nearest 100 at or above 1,000 eb
  });

  leg("… over the whole squad, not one goon", () => {
    assert.equal(GR.salvageEstimate([salvageRow(), salvageRow()]).exact, 2900);
  });

  leg("… and it EXCLUDES the carried cash and the spare magazines (they are the dial itself)", () => {
    const poor = { ...salvageRow(), loot: { cashEb: 0, spareMags: 0 } };
    assert.equal(GR.salvageEstimate([poor]).exact, GR.salvageEstimate([salvageRow()]).exact);
  });

  leg("the rounding is nearest 10 below 1,000 eb and nearest 100 at or above", () => {
    const at = (eb) => GR.salvageEstimate([{ weaponRow: { cost: eb } }]).rounded;
    assert.equal(at(44), 40);
    assert.equal(at(45), 50);
    assert.equal(at(999), 1000);
    assert.equal(at(1449), 1400);
    assert.equal(at(1450), 1500);
  });

  leg("a squad worth something never rounds down to nothing; an empty one really reads 0", () => {
    assert.equal(GR.salvageEstimate([{ weaponRow: { cost: 4 } }]).rounded, 10);
    assert.equal(GR.salvageEstimate([]).rounded, 0);
    assert.equal(GR.salvageEstimate([{}]).rounded, 0);
  });
});

// =================================================================================================

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  ${f.name}\n    ${f.e.stack?.split("\n").slice(0, 3).join("\n    ")}`);
  process.exit(1);
}
process.exit(0);
