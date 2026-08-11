/** Honest conditional-armor DISPLAY (D5 typed-SP panel). The damage-side typed-SP MATH is covered by
 *  cp2020-augmented-typed-sp.mjs; THIS keeper covers the actor SHEET/panel that the prepareData wrap
 *  (module/mech/typed-armor-display.js) produces:
 *    • system.hitLocations[loc].stoppingPower is OVERWRITTEN with the honest CONVENTIONAL total, so a
 *      fire-only Salamander stops inflating the panel vs a bullet (the user's motivating complaint).
 *    • system.conditionalSP is published per typed damage-type for the sub-panel.
 *  Both come from the SAME exported _deriveLiveSP the damage pipeline uses → panel == damage math (the
 *  whole point). Also proves the derived map STICKS to the rendered sheet (section renders, main panel
 *  deflates) — the one thing the build subagent flagged to verify on a rig. Runs on :30004 (1.1.1 + module). */
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

  // Real Salamander Jacket coverage: fire 20 on Torso/lArm/rArm, 0 elsewhere; fully-typed (sp 0).
  const SALAMANDER = { Head: 0, Torso: 20, lArm: 20, rArm: 20, lLeg: 0, rLeg: 0 };
  const covMap = (m) => Object.fromEntries(LOCS.map(k => [k, { stoppingPower: String(m[k] ?? 0), ablation: 0 }]));
  const covUniform = (sp) => Object.fromEntries(LOCS.map(k => [k, { stoppingPower: String(sp), ablation: 0 }]));
  const salamanderItem = () => ({ name: "__PW__Salamander Jacket", type: "armor",
    system: { equipped: true, armorType: "Soft", coverage: covMap(SALAMANDER), mechTypedSP: { type: "fire", sp: 0 } } });
  const kevlarItem = (sp) => ({ name: "__PW__Kevlar", type: "armor",
    system: { equipped: true, armorType: "Soft", coverage: covUniform(sp) } });

  const panel = (a, loc) => Number(a.system?.hitLocations?.[loc]?.stoppingPower);
  const live = (a, loc, type = "") => Number(A._deriveLiveSP(a, loc, type)) || 0;
  // The whole contract: after our wrap, the panel at EVERY armor loc equals the damage system's own
  // conventional SP; and every published conditional entry equals the damage system's typed SP.
  const panelMatchesLive = (a) => LOCS.every(loc => panel(a, loc) === live(a, loc, ""));
  const condMatchesLive = (a) => {
    const c = a.system?.conditionalSP; if (!c) return true;
    return Object.entries(c).every(([type, locs]) => Object.entries(locs).every(([loc, sp]) => sp === live(a, loc, type)));
  };
  const mk = async (name, items) => {
    const a = await Actor.create({ name, type: "character" });
    if (items?.length) await a.createEmbeddedDocuments("Item", items);
    a.prepareData();
    return a;
  };

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__CondArmor"))) await a.delete().catch(() => {});

  // ── (A) Salamander ALONE — panel deflates to 0 (typed-only), conditional shows fire on covered locs ──
  const salA = await mk("__PW__CondArmor Salamander", [salamanderItem()]);
  out.salamander = {
    panelMatchesLive: panelMatchesLive(salA),
    condMatchesLive: condMatchesLive(salA),
    torsoPanel: panel(salA, "Torso"),                              // 0 — stops nothing vs a normal hit
    condFireTorso: salA.system?.conditionalSP?.fire?.Torso,        // 20
    condFireLArm: salA.system?.conditionalSP?.fire?.lArm,          // 20
    condFireRArm: salA.system?.conditionalSP?.fire?.rArm,          // 20
    condFireHead: salA.system?.conditionalSP?.fire?.Head,          // undefined (coverage 0 → not surfaced)
    condFireLLeg: salA.system?.conditionalSP?.fire?.lLeg,          // undefined
    condTypes: Object.keys(salA.system?.conditionalSP ?? {}).sort().join(","), // "fire" only
  };

  // ── (B) Salamander OVER kevlar 18 — panel = 18 (coat skipped on normal), conditional fire = 25 (>18) ──
  const salB = await mk("__PW__CondArmor SalKevlar", [salamanderItem(), kevlarItem(18)]);
  out.salKevlar = {
    panelMatchesLive: panelMatchesLive(salB),
    condMatchesLive: condMatchesLive(salB),
    torsoPanel: panel(salB, "Torso"),                              // 18
    condFireTorso: salB.system?.conditionalSP?.fire?.Torso,        // 25 (proportional combine 20+18)
    condExceedsConv: (salB.system?.conditionalSP?.fire?.Torso ?? 0) > panel(salB, "Torso"), // 25 > 18
  };

  // ── (C) NON-typed actor (kevlar only) — no conditionalSP, panel == base (early-return path) ──
  const plain = await mk("__PW__CondArmor Plain", [kevlarItem(14)]);
  out.plain = {
    noConditional: plain.system?.conditionalSP === undefined,
    torsoPanel: panel(plain, "Torso"),                             // 14
    panelMatchesLive: panelMatchesLive(plain),
  };

  // ── (D) Remove the only typed layer → conditionalSP CLEARS (no stale section) ──
  await salA.deleteEmbeddedDocuments("Item", salA.items.map(i => i.id));
  salA.prepareData();
  out.cleared = { noConditional: salA.system?.conditionalSP === undefined, torsoPanel: panel(salA, "Torso") };

  // ── (E) SHEET RENDER — conditionalSP STICKS to the template: section renders + main panel shows 0 ──
  await salA.createEmbeddedDocuments("Item", [salamanderItem()]);
  salA.prepareData();
  out.reArmed = { condFireTorso: salA.system?.conditionalSP?.fire?.Torso }; // 20 again
  await salA.sheet.render(true);
  // Poll for the proven-present armor panel (the anchor); activate the combat tab if the sheet lazy-renders.
  let root = null, anchor = null;
  for (let i = 0; i < 30; i++) {
    root = salA.sheet.element instanceof HTMLElement ? salA.sheet.element : salA.sheet.element?.[0];
    anchor = root?.querySelector(".armor-display");
    if (anchor) break;
    root?.querySelector('[data-tab="combat"]')?.click();
    await sleep(100);
  }
  const condSection = root?.querySelector(".cp-conditional-armor");
  const torsoInput = root?.querySelector('input[name="system.hitLocations.Torso.stoppingPower"]');
  const condText = (condSection?.textContent || "").replace(/\s+/g, " ").trim();
  out.render = {
    anchorPresent: !!anchor,
    sectionPresent: !!condSection,
    sectionText: condText,
    mentionsFire: /Fire/i.test(condText),
    mentions20: /\b20\b/.test(condText),
    torsoInputValue: torsoInput?.value,                            // "0" — the honest deflation
  };
  await salA.sheet.close().catch(() => {});

  for (const a of [salA, salB, plain]) await a.delete().catch(() => {});
  return out;
});

const checks = {
  // (A) Salamander alone: panel honest, conditional faithful
  A_panelMatchesLive: r.salamander?.panelMatchesLive === true,
  A_condMatchesLive: r.salamander?.condMatchesLive === true,
  A_torsoDeflatesTo0: r.salamander?.torsoPanel === 0,
  A_condFireTorso20: r.salamander?.condFireTorso === 20,
  A_condFireArms20: r.salamander?.condFireLArm === 20 && r.salamander?.condFireRArm === 20,
  A_condFireSkipsZeroCov: r.salamander?.condFireHead === undefined && r.salamander?.condFireLLeg === undefined,
  A_onlyFireType: r.salamander?.condTypes === "fire",
  // (B) over kevlar: conventional = kevlar only, conditional = combined & clearly extra
  B_panelMatchesLive: r.salKevlar?.panelMatchesLive === true,
  B_condMatchesLive: r.salKevlar?.condMatchesLive === true,
  B_torso18: r.salKevlar?.torsoPanel === 18,
  B_condFire25: r.salKevlar?.condFireTorso === 25,
  B_condExceedsConv: r.salKevlar?.condExceedsConv === true,
  // (C) non-typed actor untouched
  C_noConditional: r.plain?.noConditional === true,
  C_torso14: r.plain?.torsoPanel === 14,
  C_panelMatchesLive: r.plain?.panelMatchesLive === true,
  // (D) removing the typed layer clears the derived map
  D_clearedNoConditional: r.cleared?.noConditional === true,
  D_clearedTorso0: r.cleared?.torsoPanel === 0,
  // (E) sticks through to a rendered sheet
  E_reArmed: r.reArmed?.condFireTorso === 20,
  E_anchorPresent: r.render?.anchorPresent === true,
  E_sectionPresent: r.render?.sectionPresent === true,
  E_mentionsFire: r.render?.mentionsFire === true,
  E_mentions20: r.render?.mentions20 === true,
  E_torsoDeflatedInDom: r.render?.torsoInputValue === "0",
  // hygiene: the wrap never threw (would surface a sealed-model / bad-assign problem), no console errors
  wrapNeverThrew: !warns.some(w => /typed armor display failed/.test(w)),
  noConsoleErrors: errors.length === 0,
};
console.log(JSON.stringify({ r, checks, errors, warns: warns.slice(0, 6) }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? "CONDITIONAL-ARMOR-DISPLAY KEEPER PASS" : "CONDITIONAL-ARMOR-DISPLAY KEEPER FAIL");
await b.close();
process.exit(pass ? 0 : 1);
