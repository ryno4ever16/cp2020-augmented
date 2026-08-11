/** P6 protection tags (SPECIAL-MECHANICS-PROPOSAL.md Phase D): the pure aggregation truth table,
 *  the corrections-wired items, and a REAL gas-cloud per-turn e2e — a masked actor and a bare
 *  actor stand in a handcrafted gas region, the combat turn ticks, only the bare one saves. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = {};
  const P = await import("/modules/cp2020-augmented/module/mech/protection.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  // (0) PURE truth table.
  const mk = (equipped, hazards) => ({ system: { equipped, mechProtection: { enabled: true, gas: { immune: false, mod: 0 }, flash: { immune: false, mod: 0 }, sonic: { immune: false, mod: 0 }, ...hazards } } });
  out.pure = {
    none: P.hazardProtectionFor([mk(true, {})], "gas"),
    unequipped: P.hazardProtectionFor([mk(false, { gas: { immune: true, mod: 0 } })], "gas"),
    immune: P.hazardProtectionFor([mk(true, { gas: { immune: true, mod: 0 } })], "gas"),
    bestModNoStack: P.hazardProtectionFor([mk(true, { gas: { immune: false, mod: 1 } }), mk(true, { gas: { immune: false, mod: 2 } })], "gas"),
    decideImmune: P.gasSaveDecisionFor([mk(true, { gas: { immune: true, mod: 0 } })], -3),
    decideOffset: P.gasSaveDecisionFor([mk(true, { gas: { immune: false, mod: 2 } })], -3),
    decideCapped: P.gasSaveDecisionFor([mk(true, { gas: { immune: false, mod: 5 } })], -3),
    decideBare: P.gasSaveDecisionFor([], -3),
    // Q8 percent gate (kept-book-number: threshold = percent/10, protected on a d10 at or under it).
    gate70Held: P.percentGateOutcome(70, 7),      // 7 ≤ 7 → held
    gate70Fail: P.percentGateOutcome(70, 8),      // 8 > 7 → fail
    gate0: P.percentGateOutcome(0, 1),            // no percent → never gated
    // Q8 aggregation: best percent, best (lowest) damage multiplier, no stacking.
    bestPercent: P.hazardProtectionFor([mk(true, { gas: { percent: 50 } }), mk(true, { gas: { percent: 70 } })], "gas"),
    damageMult: P.hazardProtectionFor([mk(true, { sonic: { damageMult: 0.75 } })], "sonic"),
    // gas decision surfaces the percent so the caller knows to roll the exposure gate.
    decidePercent: P.gasSaveDecisionFor([mk(true, { gas: { percent: 70 } })], -2),
    // Full-conversion borg: intrinsically immune to any gas (Chromebook 2 p.64), no gear needed, and
    // its immunity is marked (borgSealed) so the cloud card names it as immunity, not "sealed gear".
    decideBorg: P.gasSaveDecisionFor([], -3, { isFullBorg: true }),
    decideBorgOverGear: P.gasSaveDecisionFor([mk(true, { gas: { immune: false, mod: 2 } })], -3, { isFullBorg: true }),
    decideNonBorgBare: P.gasSaveDecisionFor([], -3, { isFullBorg: false })
  };

  // (1) Corrections-wired base items.
  const imp = async (pack, id) => { const d = await game.packs.get(pack).getDocument(id); const it = await Item.create(game.items.fromCompendium(d)); const mp = foundry.utils.deepClone(it.system.mechProtection); await it.delete(); return mp; };
  out.mask = await imp("cyberpunk2020.tools", "iQcJpq8LofSYbPJO");           // Breathing Mask
  out.air = await imp("cyberpunk2020.implants", "zOzfWnALVczrmjkZ");         // Independent Air Supply
  out.dazzle = await imp("cyberpunk2020.cyberoptic", "H7PSx0gcnKET6usp");    // Anti-Dazzle
  out.nasal = await imp("cyberpunk2020.implants", "1DFttayJLRcOeS94");       // Nasal Filters (Q8 %)
  out.damper = await imp("cyberpunk2020.cyberaudio", "fkF5mng29EpC7nvE");    // Level Damper (Q8 ×)

  // (2) REAL per-turn e2e.
  // Pre-clean a leftover ACTIVE combat from a crashed prior run; tear down all fixtures in finally so a
  // mid-run throw never leaks the active combat (per-turn hooks) or the gas region.
  for (const c of [...game.combats].filter(c => c.combatants.some(cb => cb.actor?.name?.startsWith("__PW__")))) await c.delete().catch(() => {});
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Gas"))) await a.delete().catch(() => {});
  let scene = null, masked = null, bare = null, filterHeld = null, filterFail = null;
  let tokM = null, tokB = null, tokH = null, tokF = null, region = null, combat = null;
  try {
  scene = game.scenes.viewed ?? game.scenes.active ?? game.scenes.contents[0];
  masked = await Actor.create({ name: "__PW__GasMasked", type: "character" });
  await masked.createEmbeddedDocuments("Item", [{ name: "__PW__Mask", type: "misc",
    system: { equipped: true, mechProtection: { enabled: true, gas: { immune: true, mod: 0 }, flash: { immune: false, mod: 0 }, sonic: { immune: false, mod: 0 } } } }]);
  bare = await Actor.create({ name: "__PW__GasBare", type: "character" });
  // Q8: two percent-gated actors with DETERMINISTIC thresholds — 100% → d10 always ≤ 10 → held;
  // 5% → threshold 0.5 → d10 always > 0.5 → fails. Exercises both card clauses + taser outcomes.
  filterHeld = await Actor.create({ name: "__PW__GasFilterHeld", type: "character" });
  await filterHeld.createEmbeddedDocuments("Item", [{ name: "__PW__Filter100", type: "misc",
    system: { equipped: true, mechProtection: { enabled: true, gas: { immune: false, mod: 0, percent: 100, damageMult: 0 }, flash: { immune: false, mod: 0 }, sonic: { immune: false, mod: 0 } } } }]);
  filterFail = await Actor.create({ name: "__PW__GasFilterFail", type: "character" });
  await filterFail.createEmbeddedDocuments("Item", [{ name: "__PW__Filter5", type: "misc",
    system: { equipped: true, mechProtection: { enabled: true, gas: { immune: false, mod: 0, percent: 5, damageMult: 0 }, flash: { immune: false, mod: 0 }, sonic: { immune: false, mod: 0 } } } }]);
  // ⚠ createEmbeddedDocuments return order is NOT input order — create tokens singly.
  [tokM] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__GasMasked", actorId: masked.id, actorLink: true, x: 2000, y: 2000 }]);
  [tokB] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__GasBare", actorId: bare.id, actorLink: true, x: 2100, y: 2000 }]);
  [tokH] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__GasFilterHeld", actorId: filterHeld.id, actorLink: true, x: 2200, y: 2000 }]);
  [tokF] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__GasFilterFail", actorId: filterFail.id, actorLink: true, x: 2300, y: 2000 }]);
  const gs = scene.grid?.size ?? 100;
  [region] = await scene.createEmbeddedDocuments("Region", [{
    name: "__PW__GasCloud",
    shapes: [{ type: "rectangle", x: 1800, y: 1800, width: 6 * gs, height: 6 * gs }],
    flags: { "cp2020-augmented": { isGasCloud: true, turnsLeft: 3, stunSaveMod: -2, weaponName: "__PW__ Test Gas" } }
  }]);
  combat = await Combat.create({ scene: scene.id, active: true });
  await combat.createEmbeddedDocuments("Combatant", [
    { tokenId: tokM.id, actorId: masked.id }, { tokenId: tokB.id, actorId: bare.id },
    { tokenId: tokH.id, actorId: filterHeld.id }, { tokenId: tokF.id, actorId: filterFail.id }
  ]);
  await combat.startCombat();
  const msgIdsBefore = new Set(game.messages.contents.map(m => m.id));
  await combat.update({ round: 2, turn: 0 });
  // Condition-wait for the async per-turn hook to settle (the region tick 3→2 is the terminal signal),
  // then a short settle for the per-actor save cards/flags — instead of a fixed 3s.
  for (let i = 0; i < 40 && (scene.regions.get(region.id)?.getFlag("cp2020-augmented", "turnsLeft")) !== 2; i++) await sleep(200);
  await sleep(500);
  const newMsgs = game.messages.contents.filter(m => !msgIdsBefore.has(m.id)).map(m => m.content).join("\n");
  out.e2e = {
    cardMentionsGas: /__PW__ Test Gas/.test(newMsgs),
    bareListed: /__PW__GasBare/.test(newMsgs),
    protectedClause: /sealed breathing gear/.test(newMsgs) && /__PW__GasMasked/.test(newMsgs),
    bareTaser: foundry.utils.deepClone(bare.getFlag("cp2020-augmented", "taserState") ?? null),
    maskedTaser: foundry.utils.deepClone(masked.getFlag("cp2020-augmented", "taserState") ?? null),
    // Q8: the 100% filter shows a "held" clause + gets NO taser; the 5% filter shows "failed" + a taser.
    filterHeldClause: /Filters held for/.test(newMsgs) && /__PW__GasFilterHeld/.test(newMsgs),
    filterFailClause: /Filters failed for/.test(newMsgs) && /__PW__GasFilterFail/.test(newMsgs),
    filterHeldTaser: foundry.utils.deepClone(filterHeld.getFlag("cp2020-augmented", "taserState") ?? null),
    filterFailTaser: foundry.utils.deepClone(filterFail.getFlag("cp2020-augmented", "taserState") ?? null),
    turnsLeftAfter: scene.regions.get(region.id)?.getFlag("cp2020-augmented", "turnsLeft")
  };

  } finally {
    if (combat) await combat.delete().catch(() => {});
    if (scene && region) await scene.deleteEmbeddedDocuments("Region", [region.id]).catch(() => {});
    if (scene) { const _tids = [tokM, tokB, tokH, tokF].filter(Boolean).map(t => t.id); if (_tids.length) await scene.deleteEmbeddedDocuments("Token", _tids).catch(() => {}); }
    for (const d of [masked, bare, filterHeld, filterFail]) { try { if (d) await d.delete(); } catch {} }
  }
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["pure: untagged → no protection", r.pure.none.immune === false && r.pure.none.mod === 0],
  ["pure: unequipped ignored", r.pure.unequipped.immune === false],
  ["pure: immune aggregates", r.pure.immune.immune === true],
  ["pure: best mod, no stacking (1+2 → 2)", r.pure.bestModNoStack.mod === 2],
  ["decision: immune skips the save", r.pure.decideImmune.skip === true],
  ["decision: gear-sealed is NOT flagged as a borg", !r.pure.decideImmune.borgSealed],
  ["decision: a full borg skips the save (immune) + borgSealed marker", r.pure.decideBorg.skip === true && r.pure.decideBorg.borgSealed === true],
  ["decision: borg immunity holds over mere-offset gear (still skip)", r.pure.decideBorgOverGear.skip === true && r.pure.decideBorgOverGear.borgSealed === true],
  ["decision: a non-borg with no gear must save (not skip, not borg)", r.pure.decideNonBorgBare.skip === false && !r.pure.decideNonBorgBare.borgSealed],
  ["decision: +2 offsets −3 to −1", r.pure.decideOffset.skip === false && r.pure.decideOffset.effMod === -1],
  ["decision: offset caps at 0 (never a bonus)", r.pure.decideCapped.effMod === 0],
  ["decision: bare actor keeps the full penalty", r.pure.decideBare.effMod === -3],
  ["percent gate: 70% roll 7 → held; roll 8 → fails", r.pure.gate70Held.gated === true && r.pure.gate70Fail.gated === false],
  ["percent gate: 0% is never gated", r.pure.gate0.gated === false],
  ["aggregate: best percent wins (50/70 → 70)", r.pure.bestPercent.percent === 70],
  ["aggregate: sonic damage multiplier carried", r.pure.damageMult.damageMult === 0.75],
  ["decision: gas decision surfaces the percent", r.pure.decidePercent.percent === 70],
  ["corrections: Breathing Mask = gas immune", r.mask?.enabled === true && r.mask?.gas?.immune === true],
  ["corrections: Independent Air Supply = gas immune", r.air?.enabled === true && r.air?.gas?.immune === true],
  ["corrections: Anti-Dazzle = flash immune (gas untouched)", r.dazzle?.flash?.immune === true && r.dazzle?.gas?.immune === false],
  ["corrections: Nasal Filters = gas 70% (no immune/mod)", r.nasal?.enabled === true && r.nasal?.gas?.percent === 70 && r.nasal?.gas?.immune === false],
  ["corrections: Level Damper = sonic ×0.75", r.damper?.enabled === true && r.damper?.sonic?.damageMult === 0.75],
  ["e2e: turn card posted for the cloud", r.e2e.cardMentionsGas === true],
  ["e2e: bare actor listed for the save", r.e2e.bareListed === true],
  ["e2e: masked actor in the protected clause", r.e2e.protectedClause === true],
  ["e2e: bare actor got the −2 penalty state", r.e2e.bareTaser?.mod === -2],
  ["e2e: masked actor got NO penalty state", r.e2e.maskedTaser === null],
  ["e2e: 100% filter shows a held clause", r.e2e.filterHeldClause === true],
  ["e2e: 100% filter got NO penalty state (protected this turn)", r.e2e.filterHeldTaser === null],
  ["e2e: 5% filter shows a failed clause", r.e2e.filterFailClause === true],
  ["e2e: 5% filter got the −2 penalty state (save required)", r.e2e.filterFailTaser?.mod === -2],
  ["e2e: cloud ticked down (3 → 2)", r.e2e.turnsLeftAfter === 2],
  ["0 console errors", errors.length === 0]
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
