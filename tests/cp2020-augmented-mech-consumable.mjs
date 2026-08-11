/** P7 timed consumables (SPECIAL-MECHANICS-PROPOSAL.md Phase E): the pure counter/timer helpers,
 *  the corrections chain, and the full lifecycle e2e — the use action spends the counter, an
 *  activation spends one unit and starts its timer, the round tick counts it down, and expiry
 *  clears the activation state with a wear-off card. Empty counters block further use. */
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
  const C = await import("/modules/cp2020-augmented/module/mech/consumable.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const SCOPE = "cp2020-augmented";

  // ── (0) PURE helpers ──────────────────────────────────────────────────────
  out.pure = {
    disabledNull: C.consumableOf({ system: { mechConsumable: { enabled: false, doses: 3 } } }) === null,
    floor: C.dosesLeft({ system: { mechConsumable: { enabled: true, doses: -2 } } }),
    tick: C.tickMarkers([{ itemId: "a", turnsLeft: 2 }, { itemId: "b", turnsLeft: 1 }]),
    durBlank: await C.rollDurationTurns(""),
    durNumeric: await C.rollDurationTurns("3"),
    durFormula: await C.rollDurationTurns("1d6+2"),
    durGarbage: await C.rollDurationTurns("not a formula (")
  };

  // ── (1) Corrections chain (the composition proof: base payload + module counter) ──
  const impSys = async (pack, id) => { const d = await game.packs.get(pack).getDocument(id); const it = await Item.create(game.items.fromCompendium(d)); const sys = foundry.utils.deepClone(it.system); await it.delete(); return sys; };
  const booster = await impSys("cyberpunk2020.implants", "EHOfG6zqqaFTHIV8");   // Adrenal Booster
  out.booster = { mc: booster.mechConsumable, statRef: booster.CyberWorkType?.Stat?.ref ?? null, mode: booster.EffectMode };
  const patch = await impSys("cyberpunk2020.medical", "I2c4U3FtntrJCIEl");      // Slap Patch
  out.patch = patch.mechConsumable;

  // ── (2) E2E lifecycle on a real actor ─────────────────────────────────────
  // Pre-clean a leftover ACTIVE combat from a crashed prior run (it would feed per-turn hooks here).
  for (const c of [...game.combats].filter(c => c.combatants.some(cb => cb.actor?.name?.startsWith("__PW__")))) await c.delete().catch(() => {});
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Consum"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__ConsumPunk", type: "character" });

  // Use action on a plain (non-activatable) item: counter spends down, card posts, empty blocks.
  const [vial] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__Vial", type: "misc",
    system: { equipped: true, mechConsumable: { enabled: true, doses: 2, durationTurns: "", note: "" } } }]);
  let before = new Set(game.messages.contents.map(m => m.id));
  await C.useConsumable(vial); await sleep(400);
  let msgs = game.messages.contents.filter(m => !before.has(m.id)).map(m => m.content).join("\n");
  out.use1 = { doses: vial.system.mechConsumable.doses, cardNamed: /__PW__Vial/.test(msgs), dosesShown: /Doses left: 1/.test(msgs) };
  await C.useConsumable(vial); await sleep(300);
  before = new Set(game.messages.contents.map(m => m.id));
  const third = await C.useConsumable(vial); await sleep(300);
  out.useEmpty = { returned: third, doses: vial.system.mechConsumable.doses,
    newCards: game.messages.contents.filter(m => !before.has(m.id)).length };

  // Activation of a consumable-tagged Activatable implant: one unit spent + a timer started.
  // Activation happens BEFORE combat begins — the start transition (round 0→1) must NOT tick a
  // running timer (the begin-combat guard, shared with the damage-hooks per-turn blocks).
  const [imp] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__Booster", type: "cyberware",
    system: { equipped: true, EffectMode: "Activatable", EffectActive: false,
      CyberWorkType: { Types: ["Characteristic"], Stat: {}, Skill: {}, Checks: {}, ChipSkills: {} },
      mechConsumable: { enabled: true, doses: 1, durationTurns: "2", note: "test effect" } } }]);
  before = new Set(game.messages.contents.map(m => m.id));
  await imp.update({ "system.EffectActive": true }); await sleep(1200);
  msgs = game.messages.contents.filter(m => !before.has(m.id)).map(m => m.content).join("\n");
  const marker0 = (actor.getFlag(SCOPE, "consumableState") ?? [])[0] ?? null;
  out.activate = { doses: imp.system.mechConsumable.doses, active: imp.system.EffectActive,
    marker: marker0 ? { turnsLeft: marker0.turnsLeft, itemId: marker0.itemId === imp.id } : null,
    cardTurns: /2 turn/.test(msgs) };

  // Combat is active:true — tear it down in finally so a mid-run throw never leaks an active combat
  // into later keepers' per-turn hooks.
  let scene = null, tok = null, combat = null;
  try {
  scene = game.scenes.viewed ?? game.scenes.active ?? game.scenes.contents[0];
  [tok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__ConsumPunk", actorId: actor.id, actorLink: true, x: 1000, y: 1000 }]);
  combat = await Combat.create({ scene: scene.id, active: true });
  await combat.createEmbeddedDocuments("Combatant", [{ tokenId: tok.id, actorId: actor.id }]);
  await combat.startCombat(); await sleep(1200);
  const markerAtStart = (actor.getFlag(SCOPE, "consumableState") ?? [])[0] ?? null;
  out.startGuard = { turnsLeft: markerAtStart?.turnsLeft ?? null, stillActive: imp.system.EffectActive };

  // Round tick: the current combatant's timer counts down; expiry clears the activation state.
  await combat.update({ round: 2, turn: 0 }); await sleep(1500);
  const markerAfter1 = (actor.getFlag(SCOPE, "consumableState") ?? [])[0] ?? null;
  out.tick1 = { turnsLeft: markerAfter1?.turnsLeft ?? null, stillActive: imp.system.EffectActive };
  before = new Set(game.messages.contents.map(m => m.id));
  await combat.update({ round: 3, turn: 0 }); await sleep(1800);
  msgs = game.messages.contents.filter(m => !before.has(m.id)).map(m => m.content).join("\n");
  out.expiry = { flagCleared: !actor.getFlag(SCOPE, "consumableState"),
    deactivated: imp.system.EffectActive === false,
    cardNamed: /__PW__Booster/.test(msgs) && /wears off/.test(msgs) };

  // Empty counter blocks re-activation (the pre-write gate).
  await imp.update({ "system.EffectActive": true }).catch(() => {}); await sleep(400);
  out.blocked = { stillOff: imp.system.EffectActive === false, doses: imp.system.mechConsumable.doses };

  // ── (3) Sheet block round-trip + button visibility ────────────────────────
  // Nonzero counter first: the shared number partial renders 0 as an empty input + placeholder.
  await vial.update({ "system.mechConsumable.doses": 5 });
  await vial.sheet.render(true); await sleep(700);
  const vroot = vial.sheet.element;
  out.sheetMisc = {
    enabled: !!vroot?.querySelector('input[name="system.mechConsumable.enabled"]')?.checked,
    doses: vroot?.querySelector('input[name="system.mechConsumable.doses"]')?.value ?? "",
    useBtn: !!vroot?.querySelector(".cp-consumable-use")
  };
  await vial.sheet.close().catch(() => {});
  await imp.sheet.render(true); await sleep(700);
  out.sheetActivatable = { useBtn: !!imp.sheet.element?.querySelector(".cp-consumable-use") };
  await imp.sheet.close().catch(() => {});

  } finally {
    if (combat) await combat.delete().catch(() => {});
    if (scene && tok) await scene.deleteEmbeddedDocuments("Token", [tok.id]).catch(() => {});
  }
  await actor.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["pure: disabled block → null", r.pure.disabledNull === true],
  ["pure: counter floors at 0", r.pure.floor === 0],
  ["pure: tick decrements and splits expired", r.pure.tick.surviving.length === 1 && r.pure.tick.surviving[0].turnsLeft === 1 && r.pure.tick.expired.length === 1],
  ["pure: blank duration → untimed (0)", r.pure.durBlank === 0],
  ["pure: numeric duration passes through", r.pure.durNumeric === 3],
  ["pure: formula duration rolls in range", r.pure.durFormula >= 3 && r.pure.durFormula <= 8],
  ["pure: unrollable duration degrades to 0", r.pure.durGarbage === 0],
  ["corrections: Booster counter 3 uses + 1d6+2 timer + note", r.booster.mc?.enabled === true && r.booster.mc?.doses === 3 && r.booster.mc?.durationTurns === "1d6+2" && r.booster.mc?.note === "+1 REF"],
  ["corrections: Booster base payload intact (Stat ref 1, Activatable)", r.booster.statRef === 1 && r.booster.mode === "Activatable"],
  ["corrections: Slap Patch = single-use counter", r.patch?.enabled === true && r.patch?.doses === 1],
  ["e2e: use action spends the counter + posts the card", r.use1.doses === 1 && r.use1.cardNamed === true && r.use1.dosesShown === true],
  ["e2e: empty counter → use returns false, no card, stays 0", r.useEmpty.returned === false && r.useEmpty.doses === 0 && r.useEmpty.newCards === 0],
  ["e2e: activation spends one unit and stays on", r.activate.doses === 0 && r.activate.active === true],
  ["e2e: activation starts the timer (2 turns, right item)", r.activate.marker?.turnsLeft === 2 && r.activate.marker?.itemId === true],
  ["e2e: use card states the rolled duration", r.activate.cardTurns === true],
  ["e2e: begin-combat does NOT tick a running timer (start guard)", r.startGuard.turnsLeft === 2 && r.startGuard.stillActive === true],
  ["e2e: round tick decrements the timer (2 → 1), still on", r.tick1.turnsLeft === 1 && r.tick1.stillActive === true],
  ["e2e: expiry clears the timer flag", r.expiry.flagCleared === true],
  ["e2e: expiry switches the activation off", r.expiry.deactivated === true],
  ["e2e: wear-off card names the item", r.expiry.cardNamed === true],
  ["e2e: empty counter blocks re-activation (pre-write gate)", r.blocked.stillOff === true && r.blocked.doses === 0],
  ["sheet: block round-trips values + Use button on plain items", r.sheetMisc.enabled === true && r.sheetMisc.doses === "5" && r.sheetMisc.useBtn === true],
  ["sheet: no Use button on activatable items (activation IS the use)", r.sheetActivatable.useBtn === false],
  ["0 console errors", errors.length === 0]
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
