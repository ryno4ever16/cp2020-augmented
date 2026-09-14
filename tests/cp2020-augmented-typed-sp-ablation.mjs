/** Typed-SP ABLATION (user ruling 2026-07-11: typed armor ablates like any SP — the book's
 *  staged-penetration degradation system does not exempt typed SP; RAW, overrides the earlier M15
 *  "material property, not consumable plating" reading). Asserts BOTH ablation paths
 *  (ablateLocationOnce = per-hit -1; ablateLocationByAmount = acid-DOT variable) now erode a
 *  matching-type typed layer, while a NON-matching hit still leaves it untouched (a fire coat struck
 *  by a bullet stopped nothing → does not erode), and plain armor is unregressed. Also proves the
 *  conditional-armor DISPLAY reflects the ablated typed SP live. Runs on :30004 (1.1.1 + module). */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [], warns = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); else if (m.type() === "warning") warns.push(m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = {};
  const A = await import("/modules/cp2020-augmented/module/combat/DamageApplicator.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const LOCS = ["Head", "Torso", "lArm", "rArm", "lLeg", "rLeg"];
  const SALAMANDER = { Head: 0, Torso: 20, lArm: 20, rArm: 20, lLeg: 0, rLeg: 0 };
  const covMap = (m) => Object.fromEntries(LOCS.map(k => [k, { stoppingPower: String(m[k] ?? 0), ablation: 0 }]));
  const covUniform = (sp) => Object.fromEntries(LOCS.map(k => [k, { stoppingPower: String(sp), ablation: 0 }]));
  const torsoSP = (a) => Number(a.items.get(a._probeItemId)?.system?.coverage?.Torso?.stoppingPower);
  const mk = async (name, item) => {
    const a = await Actor.create({ name, type: "character" });
    const [it] = await a.createEmbeddedDocuments("Item", [item]);
    a._probeItemId = it.id; a.prepareData();
    return a;
  };
  const salamanderItem = () => ({ name: "__PW__Salamander", type: "armor",
    system: { equipped: true, armorType: "Soft", coverage: covMap(SALAMANDER), mechTypedSP: { type: "fire", sp: 0 } } });

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__AblSP"))) await a.delete().catch(() => {});

  // ── (1) ablateLocationOnce, MATCHING type: the fire coat now erodes 20 → 19 ──
  const sal = await mk("__PW__AblSP Salamander", salamanderItem());
  out.startSP = torsoSP(sal);                                   // 20
  await A.ablateLocationOnce(sal, "Torso", "fire"); await sleep(150);
  out.afterFire = torsoSP(sal);                                 // 19 — matching typed SP ablates
  out.liveFire = Number(A._deriveLiveSP(sal, "Torso", "fire")) || 0;  // 19 (damage math sees the ablated value)
  sal.prepareData();
  out.displayFire = sal.system?.conditionalSP?.fire?.Torso;     // 19 — the panel reflects the ablated SP live

  // ── (2) ablateLocationOnce, NON-matching (bullet): the fire coat stopped nothing → does NOT erode ──
  await A.ablateLocationOnce(sal, "Torso", ""); await sleep(150);
  out.afterBullet = torsoSP(sal);                               // 19 — unchanged

  // ── (3) plain armor still ablates normally (no regression) ──
  const plain = await mk("__PW__AblSP Plain", { name: "__PW__Kevlar", type: "armor",
    system: { equipped: true, armorType: "Soft", coverage: covUniform(18) } });
  await A.ablateLocationOnce(plain, "Torso", ""); await sleep(150);
  out.plainAfter = torsoSP(plain);                              // 17

  // ── (4) ablateLocationByAmount, MATCHING type: erodes by the full amount 20 → 15 ──
  const sal2 = await mk("__PW__AblSP Salamander2", salamanderItem());
  await A.ablateLocationByAmount(sal2, "Torso", 5, "fire"); await sleep(150);
  out.byAmountFire = torsoSP(sal2);                             // 15

  // ── (5) ablateLocationByAmount, NON-matching: no erosion ──
  await A.ablateLocationByAmount(sal2, "Torso", 5, ""); await sleep(150);
  out.byAmountBullet = torsoSP(sal2);                           // 15 — unchanged

  for (const a of [sal, plain, sal2]) await a.delete().catch(() => {});

  // ── (6) THE OVER-TIME TICK PASSES ITS TYPE ARGUMENT ───────────────────────────────────────────
  // The pure legs above prove the predicate; this one proves the CALL SITE. The corrosive per-turn
  // tick (module/combat/damage-hooks.js) used to call ablateLocationByAmount with three arguments,
  // so the damage-type defaulted to "" and the layer walk skipped every fully-typed garment — the
  // marker counted down while the armor never eroded. Driven through a real combat round advance.
  const acidGarment = () => ({ name: "__PW__AcidCoat", type: "armor",
    system: { equipped: true, armorType: "Soft", coverage: covUniform(20), mechTypedSP: { type: "acid", sp: 0 } } });
  const fireGarment = () => ({ name: "__PW__FireCoat", type: "armor",
    system: { equipped: true, armorType: "Soft", coverage: covUniform(20), mechTypedSP: { type: "fire", sp: 0 } } });
  const plainGarment = () => ({ name: "__PW__PlainCoat", type: "armor",
    system: { equipped: true, armorType: "Soft", coverage: covUniform(20) } });

  const tickBefore = game.settings.get("cp2020-augmented", "mechRoundTickAutomation");
  const msgIdsBefore = new Set(game.messages.contents.map(m => m.id));
  const scene = game.scenes.viewed ?? game.scenes.active ?? game.scenes.contents[0];
  const madeActors = [];
  /** Seed a corrosive marker on one figure and advance one real combat round with it as the current
   *  combatant. Returns { before, after, turnsLeft } — SP at Torso either side of the tick. */
  const tickOnce = async (label, itemData) => {
    const a = await mk(label, itemData);
    madeActors.push(a);
    await a.setFlag("cp2020-augmented", "dotState", [{ location: "Torso", turnsLeft: 3, formula: "3" }]);
    const before = torsoSP(a);
    let tok = null, combat = null;
    try {
      [tok] = await scene.createEmbeddedDocuments("Token", [{ name: label, actorId: a.id, actorLink: true, x: 1500, y: 1500, hidden: true }]);
      combat = await Combat.create({ scene: scene.id, active: true });
      await combat.createEmbeddedDocuments("Combatant", [{ tokenId: tok.id, actorId: a.id }]);
      await combat.startCombat();          // round 0→1: the begin-combat guard skips ticking here
      await sleep(300);
      const turns = () => (a.getFlag("cp2020-augmented", "dotState") ?? [])[0]?.turnsLeft ?? null;
      await combat.nextRound();            // round 1→2: the marker's own countdown proves the tick ran
      for (let i = 0; i < 30 && turns() === 3; i++) await sleep(200);
      return { before, after: torsoSP(a), turnsLeft: turns() };
    } finally {
      await combat?.delete().catch(() => {});
      await tok?.delete().catch(() => {});
    }
  };

  try {
    await game.settings.set("cp2020-augmented", "mechRoundTickAutomation", true);
    out.tickTyped = await tickOnce("__PW__AblSP TickTyped", acidGarment());
    out.tickPlain = await tickOnce("__PW__AblSP TickPlain", plainGarment());
    out.tickOtherType = await tickOnce("__PW__AblSP TickOther", fireGarment());
  } finally {
    await game.settings.set("cp2020-augmented", "mechRoundTickAutomation", tickBefore);
    for (const a of madeActors) await a.delete().catch(() => {});
    for (const m of game.messages.contents) if (!msgIdsBefore.has(m.id)) await m.delete().catch(() => {});
  }
  return out;
});

const checks = {
  start20: r.startSP === 20,
  onceFireAblates: r.afterFire === 19,
  damageMathSeesAblated: r.liveFire === 19,
  displayReflectsAblation: r.displayFire === 19,
  bulletDoesNotErodeFireCoat: r.afterBullet === 19,
  plainArmorStillAblates: r.plainAfter === 17,
  byAmountFireAblates: r.byAmountFire === 15,
  byAmountBulletNoErode: r.byAmountBullet === 15,
  // (6) the tick's own type argument — the marker counts down in every leg, so a red here is the
  // layer being skipped rather than the tick failing to run.
  tickMarkerCountedDown: [r.tickTyped, r.tickPlain, r.tickOtherType].every(t => t?.turnsLeft === 2),
  tickErodesMatchingTypedLayer: r.tickTyped?.before === 20 && r.tickTyped?.after === 17,
  tickErodesPlainLayer: r.tickPlain?.before === 20 && r.tickPlain?.after === 17,
  tickLeavesOtherTypedLayerAlone: r.tickOtherType?.before === 20 && r.tickOtherType?.after === 20,
  wrapNeverThrew: !warns.some(w => /typed armor display failed/.test(w)),
  noConsoleErrors: errors.length === 0,
};
console.log(JSON.stringify({ r, checks, errors, warns: warns.slice(0, 4) }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? "TYPED-SP-ABLATION KEEPER PASS" : "TYPED-SP-ABLATION KEEPER FAIL");
await b.close();
process.exit(pass ? 0 : 1);
