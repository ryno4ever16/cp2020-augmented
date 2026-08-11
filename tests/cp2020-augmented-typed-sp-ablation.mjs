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
  wrapNeverThrew: !warns.some(w => /typed armor display failed/.test(w)),
  noConsoleErrors: errors.length === 0,
};
console.log(JSON.stringify({ r, checks, errors, warns: warns.slice(0, 4) }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? "TYPED-SP-ABLATION KEEPER PASS" : "TYPED-SP-ABLATION KEEPER FAIL");
await b.close();
process.exit(pass ? 0 : 1);
