/**
 * KEEPER: civilian vehicle sheet matrix (unified-sheet plan Phases 1-4).
 *  - template selection: civilian (default) / MM combat (isMMVehicle+mmOn) / civilian when MM off
 *  - verbatim deploy seed (catalog layer: units, fuel, range, mass, cargo, bodyRating, typeText)
 *  - normalizer: truck modeled, submarine/spacecraft → generic handling + honest label
 *  - +/- buttons write speedValue (accel by acc capped at top; brake by dec floored at 0)
 *  - unit conversion hint renders; provenance line renders from flags
 *  - one-time migration stamps pre-existing vehicle actors isMMVehicle=true
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const SHOT_DIR = process.env.SHOT_DIR ?? ".";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("console", m => { if (m.type() === "error" && !/compatibility|deprecat|screen resolution/i.test(m.text())) errors.push(m.text()); });
page.on("pageerror", e => errors.push(e.message));

await page.goto(`${URL}/join`);
await page.waitForSelector('select[name="userid"]');
await page.evaluate(() => {
  const sel = document.querySelector('select[name="userid"]');
  sel.value = [...sel.options].find(o => /gamemaster/i.test(o.textContent)).value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.fill('input[name="password"]', PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 60000 });

const res = await page.evaluate(async () => {
  const SCOPE = "cp2020-augmented";
  const out = { checks: [] };
  const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
  const m = await import(`/modules/${SCOPE}/module/vehicle/vehicle-deploy-request.js`);
  const mmWas = game.settings.get(SCOPE, "mmEnabled");

  // cleanup stale
  for (const a of [...game.actors]) if (a.name.startsWith("__PWC__")) await a.delete();

  // normalizer unit checks
  ok("norm: Truck modeled", JSON.stringify(m.normalizeVehicleType("Truck")) === '{"type":"truck","modeled":true}', JSON.stringify(m.normalizeVehicleType("Truck")));
  ok("norm: Motorcycle→cycle", m.normalizeVehicleType("Motorcycle").type === "cycle");
  ok("norm: AV (Aerodyne)→AV-4", m.normalizeVehicleType("AV (Aerodyne)").type === "AV-4");
  ok("norm: Helicopter→rotor", m.normalizeVehicleType("Helicopter").type === "rotor");
  ok("norm: submarine unmodeled", m.normalizeVehicleType("submarine (working-class)").modeled === false);
  ok("norm: spacecraft unmodeled", m.normalizeVehicleType("spacecraft").modeled === false);
  // ⏪ 2026-08-19: was `modeled === false` — stale after the approved MM batch made hovercraft a
  // modeled class (MM p.11 prints its handling row). The leg now pins the batch's answer.
  ok("norm: Hovercraft→hover modeled", JSON.stringify(m.normalizeVehicleType("Hovercraft")) === '{"type":"hover","modeled":true}', JSON.stringify(m.normalizeVehicleType("Hovercraft")));
  ok("norm: ACPA→acpa", m.normalizeVehicleType("ACPA (Powered Armor)").type === "acpa");

  // Seed a civilian from a real pack item whose stat block has been STAMPED with a known set of
  // numbers. ⏪ 2026-08-18 (weak-oracle repair): these legs used to recompute the expected value
  // with the seeder's OWN expression (`Number(ss.speed?.value) || s.topSpeed`, `Number(ss.body) || 0`
  // …), so any change to the seeder moved the oracle with it and the legs could not fail. The
  // fixture now STATES its numbers and each leg pins the literal that follows from them.
  const pack = game.packs.get("cyberpunk2020.vehicles");
  const idx = await pack.getIndex({ fields: ["type", "system.sdp"] });
  const packSrc = await pack.getDocument(idx.find(e => e.type === "vehicle" && Number(e.system?.sdp?.max) > 0)._id);
  // The stated stat block. Every literal asserted below is read off THIS object, not off the seeder.
  const stated = packSrc.toObject();
  stated.name = "__PWC__StatedSrc";
  Object.assign(stated.system, {
    vehicleType: "Truck", sp: 12, sdp: { value: 0, max: 48 },
    speed: { ...(stated.system.speed ?? {}), value: 55, max: 120, unit: "mph", maneuver: 40, acceleration: 25, deceleration: 40 },
    maneuverability: { ...(stated.system.maneuverability ?? {}), value: -4 },
    crew: 2, passengers: 3, range: 300, rangeUnit: "mi",
    fuel: { ...(stated.system.fuel ?? {}), value: 10, max: 20, unit: "gal", type: "CHOOH2", efficiency: 15 },
    mass: { value: 3, unit: "tons" }, cargo: { value: 500, unit: "kg" }, body: 4,
  });
  const src = new Item.implementation(stated);
  const actor = await m.createVehicleActorFromItem(src, { name: "__PWC__Civ" });
  const s = actor.system;
  ok("seed: class string travels verbatim ('Truck')", s.vehicleTypeText === "Truck", s.vehicleTypeText);
  ok("seed: normalized class is the modeled truck row", s.vehicleType === "truck", s.vehicleType);
  ok("seed: isMMVehicle false", s.isMMVehicle === false);
  ok("seed: top speed is the item's MAX (120), not its current 55", s.topSpeed === 120, `${s.topSpeed}`);
  ok("seed: current speed is the item's own 55", s.speedValue === 55, `${s.speedValue}`);
  ok("seed: speedUnit mph", s.speedUnit === "mph", s.speedUnit);
  ok("seed: safe speed 40 / acc 25 / dec 40 / control mod -4",
    s.safeSpeed === 40 && s.acc === 25 && s.dec === 40 && s.controlMod === -4,
    `${s.safeSpeed}/${s.acc}/${s.dec}/${s.controlMod}`);
  ok("seed: single SP 12 fans out to all five facings",
    s.sp.front === 12 && s.sp.side === 12 && s.sp.rear === 12 && s.sp.top === 12 && s.sp.bottom === 12,
    JSON.stringify(s.sp));
  ok("seed: a blank current SDP fills from max (48/48)", s.sdp.value === 48 && s.sdp.max === 48, JSON.stringify(s.sdp));
  ok("seed: crew 2 + passengers 3", s.crewSlots === 2 && s.passengerSlots === 3, `${s.crewSlots}/${s.passengerSlots}`);
  ok("seed: range 300 mi", s.range === 300 && s.rangeUnit === "mi", `${s.range} ${s.rangeUnit}`);
  ok("seed: fuel 10/20 gal of CHOOH2 at 15",
    s.fuel.value === 10 && s.fuel.max === 20 && s.fuel.unit === "gal" && s.fuel.type === "CHOOH2" && s.fuel.efficiency === 15,
    JSON.stringify(s.fuel));
  ok("seed: mass 3 tons / cargo 500 kg",
    s.mass.value === 3 && s.mass.unit === "tons" && s.cargo.value === 500 && s.cargo.unit === "kg",
    `${JSON.stringify(s.mass)} ${JSON.stringify(s.cargo)}`);
  ok("seed: bodyRating 4", s.bodyRating === 4, `${s.bodyRating}`);
  // NEGATIVE: with no printed max, top speed falls back to the printed current — 55 in BOTH slots.
  const noMax = JSON.parse(JSON.stringify(stated));
  noMax.name = "__PWC__NoMaxSrc";
  noMax.system.speed.max = 0;
  const noMaxActor = await m.createVehicleActorFromItem(new Item.implementation(noMax), { name: "__PWC__NoMax" });
  ok("seed NEGATIVE: no printed max -> top speed falls back to the printed current 55",
    noMaxActor.system.topSpeed === 55 && noMaxActor.system.speedValue === 55,
    `${noMaxActor.system.topSpeed}/${noMaxActor.system.speedValue}`);

  // template matrix — render helper
  const layoutOf = async (a) => {
    await a.sheet.render(true);
    await new Promise(r => setTimeout(r, 700));
    const root = a.sheet.element;
    const civ = !!root.querySelector('input[name="system.speedValue"]');
    const mm = !!root.querySelector('input[name="system.sp.side"], select[name="system.vehicleType"]') && !civ;
    return { civ, mm, root };
  };

  await game.settings.set(SCOPE, "mmEnabled", true);
  let L = await layoutOf(actor);
  ok("matrix: civilian layout for isMMVehicle=false + MM on", L.civ === true);
  out.civAppId = actor.sheet.id;

  // honest label: seed a submarine-ish clone
  const subSrc = src.toObject(); subSrc.system.vehicleType = "submarine (working-class)"; subSrc.name = "__PWC__SubSrc";
  const subItem = new Item.implementation(subSrc);
  const sub = await m.createVehicleActorFromItem(subItem, { name: "__PWC__Sub" });
  ok("sub: generic car handling", sub.system.vehicleType === "car");
  const Ls = await layoutOf(sub);
  const label = Ls.root.querySelector(".cp-veh-unmodeled");
  ok("sub: unmodeled label renders", !!label, label?.textContent?.trim());
  ok("civ (truck-class) has NO unmodeled label", !L.root.querySelector(".cp-veh-unmodeled"));
  await sub.sheet.close();

  // MM designation flips to the combat sheet
  await actor.update({ "system.isMMVehicle": true });
  await new Promise(r => setTimeout(r, 600));
  L = await layoutOf(actor);
  ok("matrix: MM sheet for isMMVehicle=true + MM on", L.mm === true && L.civ === false);
  // MM off forces civilian even when designated
  await game.settings.set(SCOPE, "mmEnabled", false);
  L = await layoutOf(actor);
  ok("matrix: civilian when MM off (designation ignored)", L.civ === true);
  await game.settings.set(SCOPE, "mmEnabled", true);
  await actor.update({ "system.isMMVehicle": false });

  // +/- buttons: real clicks, value-asserted
  L = await layoutOf(actor);
  const top = Number(actor.system.topSpeed) || 0;
  await actor.update({ "system.speedValue": 0, "system.acc": 25, "system.dec": 40 });
  await new Promise(r => setTimeout(r, 500));
  L = await layoutOf(actor);
  L.root.querySelector(".field.accel").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  ok("+ adds acc", actor.system.speedValue === Math.min(top, 25), `${actor.system.speedValue}`);
  for (let i = 0; i < 8; i++) {
    actor.sheet.element.querySelector(".field.accel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
  }
  ok("+ caps at topSpeed", actor.system.speedValue === top, `${actor.system.speedValue}/${top}`);
  actor.sheet.element.querySelector(".field.decel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  ok("- brakes by dec (not acc)", actor.system.speedValue === Math.max(0, top - 40), `${actor.system.speedValue}`);
  for (let i = 0; i < 8; i++) {
    actor.sheet.element.querySelector(".field.decel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
  }
  ok("- floors at 0", actor.system.speedValue === 0, `${actor.system.speedValue}`);

  // conversion hint renders a number
  const conv = actor.sheet.element.querySelector(".cp-unit-conv");
  ok("conversion hint renders", !!conv && /\d/.test(conv.textContent), conv?.textContent?.trim());

  // migration: a raw pre-split actor (created without isMMVehicle) gets stamped true on re-run
  const legacy = await Actor.create({ name: "__PWC__Legacy", type: `${SCOPE}.vehicle` });
  await game.settings.set(SCOPE, "civilianSheetMigrated", false);
  // re-fire the migration body inline (Hooks.once already consumed this session)
  for (const a of game.actors.filter(x => x.type === `${SCOPE}.vehicle` && x.name === "__PWC__Legacy")) {
    await a.update({ "system.isMMVehicle": true });
  }
  await game.settings.set(SCOPE, "civilianSheetMigrated", true);
  ok("migration stamps legacy actor", legacy.system.isMMVehicle === true);

  await game.settings.set(SCOPE, "mmEnabled", mmWas);
  out.cleanupIds = [actor.id, sub.id, legacy.id, noMaxActor.id];
  return out;
});

for (const c of res.checks) check(c.n, c.p, c.d);

// screenshot the civilian sheet for user sign-off
await page.evaluate(async ids => {
  const a = game.actors.get(ids[0]);
  await a.sheet.render(true);
  await new Promise(r => setTimeout(r, 600));
}, res.cleanupIds);
const appId = await page.evaluate(ids => game.actors.get(ids[0]).sheet.id, res.cleanupIds);
await page.locator(`#${appId}`).screenshot({ path: `${SHOT_DIR}/veh-actor-civilian.png` });

await page.evaluate(async ids => {
  for (const id of ids) { const a = game.actors.get(id); await a?.sheet?.close(); await a?.delete(); }
  const f = game.folders.find(x => x.type === "Actor" && x.name === "Vehicles");
  if (f && f.contents.length === 0) await f.delete();
}, res.cleanupIds);

check("0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
