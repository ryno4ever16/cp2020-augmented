/** P4 vision devices (SPECIAL-MECHANICS-PROPOSAL.md Phase C-2): the mechVision field, the pure
 *  longest-range-wins rule, the mode→core-vision-mode resolution, the GM apply path (token sight
 *  override + exact restore), the corrections-wired base cyberoptics, and the sheet UI. */
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
  const V = await import("/modules/cp2020-augmented/module/mech/vision.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const until = async (fn, tries = 30) => { for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await sleep(150); } return fn(); };

  // (0) PURE rules.
  const mk = (over) => ({ system: { equipped: true, mechVision: { enabled: true, on: true, mode: "infrared", range: 20, ...over } } });
  out.pure = {
    off: V.desiredVisionFor([mk({ on: false })]),
    unequipped: V.desiredVisionFor([{ system: { equipped: false, mechVision: { enabled: true, on: true, mode: "uv", range: 50 } } }]),
    single: V.desiredVisionFor([mk({})]),
    longestWins: V.desiredVisionFor([mk({}), mk({ mode: "lowlight", range: 40 })])
  };
  out.resolved = { ir: V.resolveVisionMode("infrared"), low: V.resolveVisionMode("lowlight"), bogus: V.resolveVisionMode("nope") };
  out.resolvedProvided = [out.resolved.ir, out.resolved.low, out.resolved.bogus].every(m => m in (CONFIG.Canvas.visionModes ?? {}));

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Vis"))) await a.delete().catch(() => {});

  // (1) Model defaults live.
  const actor = await Actor.create({ name: "__PW__VisTest", type: "character" });
  const [plain] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__Vis Plain", type: "misc" }]);
  out.modelDefaults = { has: !!plain.system.mechVision, enabled: plain.system.mechVision?.enabled, mode: plain.system.mechVision?.mode };

  // (2) End-to-end on a LINKED token. Uses a terrain-sight device (lowlight) so the mechanism
  // asserts an observable sight.range/mode override; IR/thermograph are heat-only (range 0) and
  // are covered for their own signature by the corrections + pure-rules checks and the vision-upgrades keeper.
  const [ir] = await actor.createEmbeddedDocuments("Item", [{
    name: "__PW__Vis Dev20", type: "misc",
    system: { equipped: true, mechVision: { enabled: true, on: false, mode: "lowlight", range: 20 } }
  }]);
  const [amp] = await actor.createEmbeddedDocuments("Item", [{
    name: "__PW__Vis Amp", type: "misc",
    system: { equipped: true, mechVision: { enabled: true, on: false, mode: "lowlight", range: 40 } }
  }]);
  const scene = game.scenes.viewed ?? game.scenes.active ?? game.scenes.contents[0];
  const [tok] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PW__VisTok", actorId: actor.id, actorLink: true, x: 1200, y: 1200,
    sight: { enabled: true, range: 5, visionMode: "basic" }
  }]);
  const sightOf = () => { const t = scene.tokens.get(tok.id); return { mode: t.sight.visionMode, range: t.sight.range, baseFlag: t.getFlag("cp2020-augmented", "mechBaseSight") !== undefined }; };
  out.baseline = sightOf();
  await ir.update({ "system.mechVision.on": true });
  await until(() => sightOf().range === 20);
  out.irOn = sightOf();
  await amp.update({ "system.mechVision.on": true });
  await until(() => sightOf().range === 40);
  out.bothOn = sightOf();                          // longest range (the amp) governs
  await ir.update({ "system.mechVision.on": false });
  await amp.update({ "system.mechVision.on": false });
  await until(() => sightOf().range === 5);
  out.restored = sightOf();

  // (3) Corrections path: base cyberoptic "Infrared" imports as an infrared device.
  const doc = await game.packs.get("cyberpunk2020.cyberoptic").getDocument("qiTXkPooklv9UHsI");
  const imp = await Item.create(game.items.fromCompendium(doc));
  out.imported = { name: imp.name, mv: imp.system.mechVision };

  // (4) Sheet UI.
  await ir.sheet.render(true);
  await sleep(700);
  const root = ir.sheet.element instanceof HTMLElement ? ir.sheet.element : ir.sheet.element?.[0];
  out.sheet = {
    enabledBox: !!root?.querySelector('input[name="system.mechVision.enabled"]'),
    // The select's option VALUES must equal the engine's mode list exactly (the select is derived
    // from MODE_TABLE, so a mode missing here would be silently rewritten on the next submit).
    modeValues: [...(root?.querySelectorAll('select[name="system.mechVision.mode"] option') ?? [])].map(o => o.value),
    engineModes: Object.keys((await import("/modules/cp2020-augmented/module/mech/vision.js")).MODE_TABLE),
    activeBox: !!root?.querySelector('input[name="system.mechVision.on"]'),
    rawLeak: /CYBERPUNK\.Mech/.test(root?.textContent ?? "")
  };
  await ir.sheet.close().catch(() => {});

  await imp.delete().catch(() => {});
  await scene.deleteEmbeddedDocuments("Token", [tok.id]).catch(() => {});
  await actor.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["pure: off device → null", r.pure.off === null],
  ["pure: unequipped ignored", r.pure.unequipped === null],
  ["pure: single infrared 20m", r.pure.single?.mode === "infrared" && r.pure.single?.range === 20],
  ["pure: longest range governs", r.pure.longestWins?.mode === "lowlight" && r.pure.longestWins?.range === 40],
  ["mode resolution lands on core-provided modes", r.resolvedProvided === true],
  // User ruling 2026-07-16: Low Lite must NOT resolve to core's "lightAmplification" — that preset is
  // tint [0.38,0.8,0.38] at brightness 1 (a blinding green wash). darkvision gives the same
  // see-in-the-dark result in calm greyscale. Value-assert so the mode can't silently revert.
  ["lowlight resolves to darkvision, not the green/bright lightAmplification", r.resolved?.low === "darkvision"],
  ["model: fresh misc item gains mechVision defaults", r.modelDefaults.has === true && r.modelDefaults.enabled === false && r.modelDefaults.mode === "lowlight"],
  ["baseline: token sight basic/5, no flag", r.baseline.mode === "basic" && r.baseline.range === 5 && r.baseline.baseFlag === false],
  ["device on: sight overridden to device profile + base stored", r.irOn.range === 20 && r.irOn.mode !== "basic" && r.irOn.baseFlag === true],
  ["both on: longest-range device governs (40m)", r.bothOn.range === 40],
  ["all off: base sight restored + flag cleared", r.restored.mode === "basic" && r.restored.range === 5 && r.restored.baseFlag === false],
  ["corrections: imported Infrared optic is an infrared device", r.imported.mv?.enabled === true && r.imported.mv?.mode === "infrared"],
  ["sheet: vision fields render, mode select == engine MODE_TABLE keys, no raw keys",
    r.sheet.enabledBox && r.sheet.activeBox && r.sheet.rawLeak === false
    && Array.isArray(r.sheet.modeValues) && r.sheet.modeValues.length === r.sheet.engineModes.length
    && r.sheet.engineModes.every((m, i) => r.sheet.modeValues[i] === m)],
  ["0 console errors", errors.length === 0]
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
