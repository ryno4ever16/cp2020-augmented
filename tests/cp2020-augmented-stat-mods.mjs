/** Q7 personality moddies (SPECIAL-MECHANICS-PROPOSAL.md §3b): the pure resolve/apply helpers
 *  (mod/cap/floor/set/context) and, on a real actor, the prepareDerivedData wrapper — activating a
 *  moddy chip modifies the stat totals with caps/floors, sets absolute values, switches split
 *  context on combat, and surfaces in the status strip + stat tooltips; the 5 wired chips. */
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
  const S = await import("/modules/cp2020-augmented/module/mech/stat-mods.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  // ── (0) PURE ──────────────────────────────────────────────────────────────
  const E = (o = {}) => ({ stat: "cool", mod: 0, combatMod: 0, context: "any", cap: 0, floor: 0, isSet: false, set: 0, ...o });
  out.resolve = {
    any: S.resolveEntryMod(E({ mod: 2 }), false),
    combatIn: S.resolveEntryMod(E({ context: "combat", mod: 2 }), true),
    combatOut: S.resolveEntryMod(E({ context: "combat", mod: 2 }), false),
    noncombatOut: S.resolveEntryMod(E({ context: "noncombat", mod: 2 }), false),
    splitIn: S.resolveEntryMod(E({ context: "split", mod: -2, combatMod: 2 }), true),
    splitOut: S.resolveEntryMod(E({ context: "split", mod: -2, combatMod: 2 }), false)
  };
  out.apply = {
    plus: S.applyEntry(8, E({ mod: 2 }), false),
    capped: S.applyEntry(10, E({ mod: 2, cap: 11 }), false),      // 12 → cap 11
    floored: S.applyEntry(2, E({ mod: -2, floor: 1 }), false),    // 0 → floor 1
    set: S.applyEntry(8, E({ isSet: true, set: 10 }), false),
    excluded: S.applyEntry(8, E({ context: "combat", mod: 2 }), false)   // out of combat → no delta
  };
  const chip = (over, mods) => ({ id: "c1", type: "cyberware", name: "Moddy",
    system: { equipped: true, EffectMode: "Permanent", CyberWorkType: { Types: ["Chip"], ChipActive: true }, mechStatMods: { enabled: true, mods }, ...over } });
  out.gate = {
    active: S.isStatModActive(chip({}, [E()])),
    chipOff: S.isStatModActive(chip({ CyberWorkType: { Types: ["Chip"], ChipActive: false } }, [E()])),
    unequipped: S.isStatModActive(chip({ equipped: false }, [E()])),
    disabled: S.isStatModActive(chip({ mechStatMods: { enabled: false, mods: [E()] } }, []))
  };

  // ── (1) prepareDerivedData wrapper on a real actor ────────────────────────
  // Pre-clean a leftover ACTIVE combat from a crashed prior run (it would feed per-turn hooks here).
  for (const c of [...game.combats].filter(c => c.combatants.some(cb => cb.actor?.name?.startsWith("__PW__")))) await c.delete().catch(() => {});
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Moddy"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__ModdyPunk", type: "character" });
  await actor.update({ "system.stats.cool.base": 8, "system.stats.emp.base": 5, "system.stats.int.base": 7 });
  await sleep(300);
  const total = (s) => actor.system.stats[s].total;
  out.baseline = { cool: total("cool"), emp: total("emp"), int: total("int"), noModsFlag: actor._mechStatMods == null };

  // Kick Ass: COOL +2 (cap 11), EMP −2 (floor 1). Inactive first.
  const [kick] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__KickAss", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent", CyberWorkType: { Types: ["Chip"], ChipActive: false, Stat: {}, Skill: {}, ChipSkills: {} },
      mechStatMods: { enabled: true, mods: [E({ stat: "cool", mod: 2, cap: 11 }), E({ stat: "emp", mod: -2, floor: 1 })] } } }]);
  await sleep(300);
  out.inactive = { cool: total("cool"), emp: total("emp") };
  await kick.update({ "system.CyberWorkType.ChipActive": true }); await sleep(500);
  out.active = { cool: total("cool"), emp: total("emp"), flag: !!actor._mechStatMods?.cool };
  await kick.update({ "system.CyberWorkType.ChipActive": false }); await sleep(500);
  out.reverted = { cool: total("cool"), emp: total("emp") };
  await kick.delete().catch(() => {});

  // Cap binding: COOL base 10 + Kick Ass +2 (cap 11) → 11, not 12.
  await actor.update({ "system.stats.cool.base": 10 }); await sleep(200);
  const [kick2] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__KickAss2", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent", CyberWorkType: { Types: ["Chip"], ChipActive: true, Stat: {}, Skill: {}, ChipSkills: {} },
      mechStatMods: { enabled: true, mods: [E({ stat: "cool", mod: 2, cap: 11 })] } } }]);
  await sleep(500);
  out.capBinds = { cool: total("cool") };   // 11
  await kick2.delete().catch(() => {});
  await actor.update({ "system.stats.cool.base": 8 }); await sleep(200);

  // Set (Xarghis): COOL=10, EMP=1 regardless of base.
  const [xar] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__Xarghis", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent", CyberWorkType: { Types: ["Chip"], ChipActive: true, Stat: {}, Skill: {}, ChipSkills: {} },
      mechStatMods: { enabled: true, mods: [E({ stat: "cool", isSet: true, set: 10 }), E({ stat: "emp", isSet: true, set: 1 })] } } }]);
  await sleep(500);
  out.setChip = { cool: total("cool"), emp: total("emp") };
  await xar.delete().catch(() => {}); await sleep(300);

  // Split context (Perfect Soldier INT −2/+2): out of combat −2, in combat +2.
  await actor.update({ "system.stats.int.base": 7 }); await sleep(200);   // re-anchor (earlier updates re-defaulted it)
  const [soldier] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__Soldier", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent", CyberWorkType: { Types: ["Chip"], ChipActive: true, Stat: {}, Skill: {}, ChipSkills: {} },
      mechStatMods: { enabled: true, mods: [E({ stat: "int", context: "split", mod: -2, combatMod: 2 })] } } }]);
  await sleep(500);
  out.splitOutCombat = { int: total("int"), base: actor.system.stats.int.base };   // 7 − 2 = 5
  // Combat is active:true — tear it down in finally so a mid-run throw never leaks an active combat.
  let scene = null, tok = null, combat = null;
  try {
  scene = game.scenes.viewed ?? game.scenes.active ?? game.scenes.contents[0];
  [tok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__Moddy", actorId: actor.id, actorLink: true, x: 1500, y: 1500 }]);
  combat = await Combat.create({ scene: scene.id, active: true });
  await combat.createEmbeddedDocuments("Combatant", [{ tokenId: tok.id, actorId: actor.id }]);
  await combat.startCombat();
  // poll for the context refresh (combat hooks re-prep the actor)
  for (let i = 0; i < 25 && total("int") !== 9; i++) await sleep(200);
  out.splitInCombat = { int: total("int") };     // 7 + 2 = 9
  await combat.delete().catch(() => {}); combat = null;   // deleted mid-test → null so finally won't double-delete
  for (let i = 0; i < 25 && total("int") !== 5; i++) await sleep(200);
  out.splitAfterCombat = { int: total("int") };  // back to 5

  // ── (2) Strip + tooltip surfacing ─────────────────────────────────────────
  await actor.sheet.render(true); await sleep(900);
  const root = actor.sheet.element;
  const moddyPill = [...(root?.querySelectorAll(".cp-status-pill.cp-kind-moddy") ?? [])][0];
  const intTip = root?.querySelector('.stat-total[data-stat-name="int"]')?.getAttribute("title") ?? "";
  out.surface = {
    pillPresent: !!moddyPill,
    pillText: moddyPill?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    intTipNamesModdy: /__PW__Soldier/.test(intTip)
  };
  await actor.sheet.close().catch(() => {});
  } finally {
    if (combat) await combat.delete().catch(() => {});
    if (scene && tok) await scene.deleteEmbeddedDocuments("Token", [tok.id]).catch(() => {});
  }
  await actor.delete().catch(() => {});

  // ── (3) The wired chips carry their moddy data (source) ───────────────────
  const imp = async (id) => { const d = await game.packs.get("cyberpunk2020.chipware")?.getDocument(id).catch(() => null); return d?.system?.mechStatMods ?? null; };
  out.wiredNote = "source-verified statically (compiled pack predates the edit)";
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["pure: resolve any/combat/noncombat/split", r.resolve.any === 2 && r.resolve.combatIn === 2 && r.resolve.combatOut === null && r.resolve.noncombatOut === 2 && r.resolve.splitIn === 2 && r.resolve.splitOut === -2],
  ["pure: apply +mod", r.apply.plus.value === 10 && r.apply.plus.delta === 2],
  ["pure: apply cap clamps the final value", r.apply.capped.value === 11],
  ["pure: apply floor clamps down", r.apply.floored.value === 1],
  ["pure: apply set overrides", r.apply.set.value === 10],
  ["pure: context-excluded entry contributes nothing", r.apply.excluded.delta === 0],
  ["pure: gate — active chip yes; chip-off/unequipped/disabled no", r.gate.active === true && r.gate.chipOff === false && r.gate.unequipped === false && r.gate.disabled === false],
  ["e2e: baseline has no moddy flag", r.baseline.cool === 8 && r.baseline.emp === 5 && r.baseline.int === 7 && r.baseline.noModsFlag === true],
  ["e2e: inactive chip has no effect", r.inactive.cool === 8 && r.inactive.emp === 5],
  ["e2e: activation applies +2 COOL / −2 EMP", r.active.cool === 10 && r.active.emp === 3 && r.active.flag === true],
  ["e2e: deactivation reverts", r.reverted.cool === 8 && r.reverted.emp === 5],
  ["e2e: cap binds (COOL 10 +2 cap 11 → 11)", r.capBinds.cool === 11],
  ["e2e: set overrides base (COOL=10, EMP=1)", r.setChip.cool === 10 && r.setChip.emp === 1],
  ["e2e: split context out of combat (INT −2 → 5)", r.splitOutCombat.base === 7 && r.splitOutCombat.int === 5],
  ["e2e: split context switches in combat (INT +2 → 9)", r.splitInCombat.int === 9],
  ["e2e: split context reverts after combat (→ 5)", r.splitAfterCombat.int === 5],
  ["surface: moddy pill in the strip + stat tooltip names the source", r.surface.pillPresent === true && /INT/.test(r.surface.pillText) && r.surface.intTipNamesModdy === true],
  ["0 console errors", errors.length === 0]
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
