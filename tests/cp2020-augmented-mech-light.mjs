/** P3 light emitters (SPECIAL-MECHANICS-PROPOSAL.md Phase C-1): the mechLight DataModel extension,
 *  the pure merge rules, the GM apply path (token lights up / merges / restores the GM-authored
 *  base light), the corrections-layer wiring of base-pack items, and the sheet UI. */
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
  const L = await import("/modules/cp2020-augmented/module/mech/light.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const until = async (fn, tries = 30) => { for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await sleep(150); } return fn(); };

  // (0) PURE merge rules on plain shapes.
  const mk = (over) => ({ system: { equipped: true, mechLight: { enabled: true, on: true, shape: "cone", bright: 10, dim: 20, angle: 45, color: "", ...over } } });
  out.pure = {
    none: L.desiredLightFor([mk({ on: false })]),
    unequipped: L.desiredLightFor([{ system: { equipped: false, mechLight: { enabled: true, on: true, bright: 9, dim: 9 } } }]),
    single: L.desiredLightFor([mk({})]),
    merged: L.desiredLightFor([mk({}), mk({ shape: "circle", bright: 1, dim: 4, color: "#66ff66" })])
  };

  // (0b) SchemaField partial-update semantics: toggling `on` alone must NOT reset the other keys
  // (the bare-ObjectField hazard this field deliberately avoids — see mech-item-data.js).
  const probeActor = await Actor.create({ name: "__PW__LightProbe", type: "character" });
  const [probe] = await probeActor.createEmbeddedDocuments("Item", [{
    name: "__PW__ProbeLight", type: "misc",
    system: { equipped: false, mechLight: { enabled: true, on: false, shape: "circle", bright: 7, dim: 14, angle: 45, color: "#123456" } }
  }]);
  await probe.update({ "system.mechLight.on": true });
  out.partialUpdate = foundry.utils.deepClone(probe.system.mechLight);
  await probeActor.delete().catch(() => {});

  // Cleanup from prior runs.
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Light"))) await a.delete().catch(() => {});

  // (1) The DataModel extension is live: a fresh misc item carries mechLight defaults.
  const actor = await Actor.create({ name: "__PW__LightTest", type: "character" });
  const [flash] = await actor.createEmbeddedDocuments("Item", [{
    name: "__PW__Light Flashlight", type: "misc",
    system: { equipped: true, mechLight: { enabled: true, on: false, shape: "cone", bright: 10, dim: 20, angle: 45, color: "" } }
  }]);
  const [glow] = await actor.createEmbeddedDocuments("Item", [{
    name: "__PW__Light Glowstick", type: "misc",
    system: { equipped: true, mechLight: { enabled: true, on: false, shape: "circle", bright: 1, dim: 4, angle: 45, color: "#66ff66" } }
  }]);
  const [plain] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__Light Plain", type: "misc" }]);
  out.modelDefaults = { plainHasMechLight: !!plain.system.mechLight, enabled: plain.system.mechLight?.enabled };

  // (2) Token on the viewed scene with a GM-authored base light.
  const scene = game.scenes.viewed ?? game.scenes.active ?? game.scenes.contents[0];
  const [tok] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PW__LightTok", actorId: actor.id, actorLink: true, x: 1000, y: 1000,
    light: { bright: 1, dim: 3, angle: 360 }
  }]);
  const lightOf = () => { const t = scene.tokens.get(tok.id); return { bright: t.light.bright, dim: t.light.dim, angle: t.light.angle, color: t.light.color ? String(t.light.color) : null, baseFlag: t.getFlag("cp2020-augmented", "mechBaseLight") !== undefined }; };
  out.baseline = lightOf();

  // (3) Flashlight ON → cone override + base stored.
  await flash.update({ "system.mechLight.on": true });
  await until(() => lightOf().bright === 10);
  out.flashOn = lightOf();

  // (4) Glowstick ON too → merged: max ranges, circle opens to 360, chem-glow tint.
  await glow.update({ "system.mechLight.on": true });
  await until(() => lightOf().angle === 360 && lightOf().color);
  out.merged = lightOf();

  // (5) Unequip the glowstick while lit → back to the cone; then all OFF → base restored.
  await glow.update({ "system.equipped": false });
  await until(() => lightOf().angle !== 360);
  out.glowUnequipped = lightOf();
  await flash.update({ "system.mechLight.on": false });
  await until(() => lightOf().dim === 3);
  out.restored = lightOf();

  // (6) Corrections path: an imported base-pack Lamp carries the emitter profile.
  const lampDoc = await game.packs.get("cyberpunk2020.furnishing").getDocument("nlf3SoNWrlRZLwEM");
  const lamp = await Item.create(game.items.fromCompendium(lampDoc));
  out.lamp = { name: lamp.name, ml: lamp.system.mechLight };

  // (7) Sheet UI: emitter fields render on the item sheet, no raw keys.
  await flash.sheet.render(true);
  await sleep(700);
  const root = flash.sheet.element instanceof HTMLElement ? flash.sheet.element : flash.sheet.element?.[0];
  out.sheet = {
    enabledBox: !!root?.querySelector('input[name="system.mechLight.enabled"]'),
    shapeSel: !!root?.querySelector('select[name="system.mechLight.shape"]'),
    litBox: !!root?.querySelector('input[name="system.mechLight.on"]'),
    rawLeak: /CYBERPUNK\.Mech/.test(root?.textContent ?? "")
  };
  await flash.sheet.close().catch(() => {});

  await lamp.delete().catch(() => {});
  await scene.deleteEmbeddedDocuments("Token", [tok.id]).catch(() => {});
  await actor.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["pure: off emitter → null", r.pure.none === null],
  ["pure: unequipped ignored", r.pure.unequipped === null],
  ["pure: single cone 10/20@45", r.pure.single?.bright === 10 && r.pure.single?.dim === 20 && r.pure.single?.angle === 45],
  ["pure: merge = max ranges, 360°, tint", r.pure.merged?.bright === 10 && r.pure.merged?.dim === 20 && r.pure.merged?.angle === 360 && r.pure.merged?.color === "#66ff66"],
  ["partial update keeps sibling keys (SchemaField)", r.partialUpdate?.on === true && r.partialUpdate?.enabled === true && r.partialUpdate?.bright === 7 && r.partialUpdate?.color === "#123456"],
  ["model: plain misc item gains mechLight defaults", r.modelDefaults.plainHasMechLight === true && r.modelDefaults.enabled === false],
  ["baseline: GM light 1/3, no flag", r.baseline.bright === 1 && r.baseline.dim === 3 && r.baseline.baseFlag === false],
  ["flash on: token cone 10/20@45 + base flag stored", r.flashOn.bright === 10 && r.flashOn.dim === 20 && r.flashOn.angle === 45 && r.flashOn.baseFlag === true],
  ["merged: 360° + chem tint", r.merged.angle === 360 && r.merged.color === "#66ff66"],
  ["unequip glowstick: back to the cone", r.glowUnequipped.angle === 45 && !r.glowUnequipped.color],
  ["all off: GM base light restored + flag cleared", r.restored.bright === 1 && r.restored.dim === 3 && r.restored.baseFlag === false],
  ["corrections: imported Lamp is a 5/10 circle emitter", r.lamp.ml?.enabled === true && r.lamp.ml?.shape === "circle" && r.lamp.ml?.bright === 5 && r.lamp.ml?.dim === 10],
  ["sheet: emitter fields render, no raw keys", r.sheet.enabledBox && r.sheet.shapeSel && r.sheet.litBox && r.sheet.rawLeak === false],
  ["0 console errors", errors.length === 0]
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
