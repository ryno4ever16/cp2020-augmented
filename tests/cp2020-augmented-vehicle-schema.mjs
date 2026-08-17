/** Vehicle schema upgrade (VEHICLE-SPEC.md §7 phases 1-2): new fields persist, old docs float on
 *  defaults (additive migration), and the sheet renders the new controls with resolved i18n. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await p.evaluate(v=>{const el=document.querySelector('select[name="userid"]');el.value=v;el.dispatchEvent(new Event("change",{bubbles:true}));},g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

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

// ⏪ 2026-08-17 (traceability repair): this suite used to end on ONE unnamed boolean conjunction, so a
// red could not say WHICH half failed. Same conditions, now reported individually.
const legs = [
  ["persist: the vehicle type round-trips", r.persist.vehicleType === "AV (Aerodyne)", r.persist.vehicleType],
  ["persist: crew and body round-trip", r.persist.crew === 2 && r.persist.body === 5, `${r.persist.crew}/${r.persist.body}`],
  ["persist: the free-text cargo and mass figures round-trip", r.persist.cargo === "500kg" && r.persist.mass === "4tons", `${r.persist.cargo}/${r.persist.mass}`],
  ["persist: deceleration round-trips", r.persist.decel === 50, r.persist.decel],
  ["persist: the fuel unit round-trips", r.persist.fuelUnit === "liters", r.persist.fuelUnit],
  ["old docs: an old-shape doc floats on the type default", r.oldFloor.vehicleType === "", JSON.stringify(r.oldFloor.vehicleType)],
  ["old docs: crew and deceleration float on zero", r.oldFloor.crew === 0 && r.oldFloor.decel === 0, `${r.oldFloor.crew}/${r.oldFloor.decel}`],
  ["old docs: the three unit fields float on their defaults",
    r.oldFloor.fuelUnit === "gal" && r.oldFloor.cargoUnit === "kg" && r.oldFloor.massUnit === "tons",
    `${r.oldFloor.fuelUnit}/${r.oldFloor.cargoUnit}/${r.oldFloor.massUnit}`],
  ["old docs: an existing stored maximum is kept, not reset", r.oldFloor.keptMax === 120, r.oldFloor.keptMax],
  // ⏪ 2026-08-16 (vacuous-leg audit): the `!r.packDoc ||` head handed the leg a free pass exactly when
  // the module's own supplement pack failed to resolve — which is the thing worth catching.
  ["pack: the module's own supplement doc resolves", !!r.packDoc, String(!!r.packDoc)],
  ["pack: the backfilled doc keeps its data under the current schema",
    !!r.packDoc && Number(r.packDoc.decel) > 0 && r.packDoc.vehicleType !== "",
    `decel=${r.packDoc?.decel} type=${JSON.stringify(r.packDoc?.vehicleType)}`],
  ["sheet: the type input and its suggestion list render", r.sheet.typeInput && r.sheet.datalistOpts >= 10, `input=${r.sheet.typeInput} opts=${r.sheet.datalistOpts}`],
  ["sheet: the crew, body and deceleration fields render", r.sheet.crew && r.sheet.body && r.sheet.decel, `${r.sheet.crew}/${r.sheet.body}/${r.sheet.decel}`],
  ["sheet: the three unit selectors render", r.sheet.fuelUnitSel && r.sheet.massSel && r.sheet.cargoSel, `${r.sheet.fuelUnitSel}/${r.sheet.massSel}/${r.sheet.cargoSel}`],
  ["sheet: the fuel-efficiency suffix renders", !!r.sheet.fuelEffSuffix, String(r.sheet.fuelEffSuffix)],
  ["sheet: no raw localization key leaked", !r.sheet.rawKeyLeak, String(r.sheet.rawKeyLeak)],
  ["0 console errors", errors.length === 0, errors.slice(0, 3).join(" | ")],
];
console.log("");
for (const [n, p2, d] of legs) console.log(`  [${p2 ? "PASS" : "FAIL"}] ${n}${d !== undefined && d !== "" ? `  = ${d}` : ""}`);
const ok = legs.every(([, p2]) => p2);

console.log("\n  RESULT: " + (ok ? "PASS ✅ — schema persists, old docs float, sheet renders clean" : `FAIL ❌ — ${legs.filter(([, p2]) => !p2).map(([n]) => n).join(" · ")}`));
await b.close();
process.exit(ok ? 0 : 1);
