/** Vehicle schema upgrade (VEHICLE-SPEC.md §7 phases 1-2): new fields persist, old docs float on
 *  defaults (additive migration), and the sheet renders the new controls with resolved i18n. */
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
  for (const i of game.items.filter(i => i.name.startsWith("__PW__VSch"))) await i.delete().catch(() => {});

  // (1) NEW-FIELD PERSISTENCE — form-equivalent writes round-trip through the DataModel.
  const item = await Item.create({ name: "__PW__VSch", type: "vehicle" });
  await item.update({
    "system.vehicleType": "AV (Aerodyne)", "system.crew": 2, "system.body": 5,
    "system.cargo.value": 500, "system.cargo.unit": "kg",
    "system.mass.value": 4, "system.mass.unit": "tons",
    "system.speed.acceleration": 25, "system.speed.deceleration": 50,
    "system.fuel.unit": "liters", "system.fuel.max": 200, "system.fuel.efficiency": 0.5
  });
  const s = game.items.get(item.id).system;
  out.persist = {
    vehicleType: s.vehicleType, crew: s.crew, body: s.body,
    cargo: `${s.cargo?.value}${s.cargo?.unit}`, mass: `${s.mass?.value}${s.mass?.unit}`,
    decel: s.speed?.deceleration, fuelUnit: s.fuel?.unit
  };

  // (2) OLD-SHAPE FLOOR — a doc created with only legacy fields gains schema defaults, no errors.
  const old = await Item.create({ name: "__PW__VSch_old", type: "vehicle",
    system: { sdp: { value: 30, max: 30 }, sp: 10, speed: { value: 0, max: 120, maneuver: 60, acceleration: 15 } } });
  const so = game.items.get(old.id).system;
  out.oldFloor = {
    vehicleType: so.vehicleType, crew: so.crew, body: so.body,
    cargoUnit: so.cargo?.unit, massUnit: so.mass?.unit,
    decel: so.speed?.deceleration, fuelUnit: so.fuel?.unit, keptMax: so.speed?.max
  };

  // (3) COMPENDIUM OLD DOC — a compiled v1.0.7-era pack vehicle floats on the new defaults.
  const pack = game.packs.get("cp2020-augmented.supplement-vehicles");
  let packDoc = null;
  if (pack) {
    const idx = await pack.getIndex();
    const first = idx.contents.find(e => e.name.includes("40-Ton")) ?? idx.contents[0];
    const doc = await pack.getDocument(first._id);
    packDoc = { name: doc.name, decel: doc.system.speed?.deceleration, fuelUnit: doc.system.fuel?.unit,
                cargoUnit: doc.system.cargo?.unit, vehicleType: doc.system.vehicleType };
  }
  out.packDoc = packDoc;

  // (4) SHEET RENDER — new controls present, datalist populated, no raw i18n keys.
  await item.sheet.render(true);
  await new Promise(res => setTimeout(res, 800));
  const root = item.sheet.element instanceof HTMLElement ? item.sheet.element : item.sheet.element?.[0];
  const q = sel => root?.querySelector(sel);
  out.sheet = {
    typeInput: !!q('input[name="system.vehicleType"]'),
    datalistOpts: root?.querySelector(`datalist[id="cp-vehicle-types-${item.id}"]`)?.querySelectorAll("option").length ?? 0,
    crew: !!q('input[name="system.crew"]'), body: !!q('input[name="system.body"]'),
    decel: !!q('input[name="system.speed.deceleration"]'),
    fuelUnitSel: !!q('select[name="system.fuel.unit"]'),
    massSel: !!q('select[name="system.mass.unit"]'), cargoSel: !!q('select[name="system.cargo.unit"]'),
    fuelEffSuffix: q('input[name="system.fuel.efficiency"]')?.closest(".field")?.textContent.includes("km/L") ?? false,
    rawKeyLeak: /CYBERPUNK\./.test(root?.querySelector(".cp-vehicle-item-fields")?.textContent ?? "")
  };
  await item.sheet.close().catch(() => {});
  await item.delete().catch(() => {});
  await old.delete().catch(() => {});
  return out;
});

console.log("\n===== vehicle schema upgrade (phases 1-2) =====");
console.log("  persist:", JSON.stringify(r.persist));
console.log("  old-shape floor:", JSON.stringify(r.oldFloor));
console.log("  compendium old doc:", JSON.stringify(r.packDoc));
console.log("  sheet:", JSON.stringify(r.sheet));
console.log("  page errors:", errors.length ? errors.slice(0, 4) : "none");

const ok =
  r.persist.vehicleType === "AV (Aerodyne)" && r.persist.crew === 2 && r.persist.body === 5 &&
  r.persist.cargo === "500kg" && r.persist.mass === "4tons" && r.persist.decel === 50 &&
  r.persist.fuelUnit === "liters" &&
  r.oldFloor.vehicleType === "" && r.oldFloor.crew === 0 && r.oldFloor.decel === 0 &&
  r.oldFloor.fuelUnit === "gal" && r.oldFloor.cargoUnit === "kg" && r.oldFloor.massUnit === "tons" &&
  r.oldFloor.keptMax === 120 &&
  // The pack docs are BACKFILLED now (the D4 vehicle-backfill re-seed): the compiled doc must
  // retain its data under the current schema — the old floats-on-defaults expectation is history
  // (the in-world old-shape leg above still proves the additive-migration property).
  (!r.packDoc || (Number(r.packDoc.decel) > 0 && r.packDoc.vehicleType !== "")) &&
  r.sheet.typeInput && r.sheet.datalistOpts >= 10 && r.sheet.crew && r.sheet.body && r.sheet.decel &&
  r.sheet.fuelUnitSel && r.sheet.massSel && r.sheet.cargoSel && r.sheet.fuelEffSuffix &&
  !r.sheet.rawKeyLeak && errors.length === 0;

console.log("\n  RESULT: " + (ok ? "PASS ✅ — schema persists, old docs float, sheet renders clean" : "FAIL ❌"));
await b.close();
process.exit(ok ? 0 : 1);
