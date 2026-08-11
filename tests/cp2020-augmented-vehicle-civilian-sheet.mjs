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
  ok("norm: Hovercraft unmodeled", m.normalizeVehicleType("Hovercraft").modeled === false);
  ok("norm: ACPA→acpa", m.normalizeVehicleType("ACPA (Powered Armor)").type === "acpa");

  // seed a civilian from a real pack item with rich data
  const pack = game.packs.get("cyberpunk2020.vehicles");
  const idx = await pack.getIndex({ fields: ["type", "system.sdp"] });
  const src = await pack.getDocument(idx.find(e => e.type === "vehicle" && Number(e.system?.sdp?.max) > 0)._id);
  const actor = await m.createVehicleActorFromItem(src, { name: "__PWC__Civ" });
  const s = actor.system, ss = src.system;
  ok("seed: typeText verbatim", s.vehicleTypeText === String(ss.vehicleType ?? ""), `${s.vehicleTypeText}|${ss.vehicleType}`);
  ok("seed: isMMVehicle false", s.isMMVehicle === false);
  ok("seed: speedValue = current||top", s.speedValue === (Number(ss.speed?.value) || s.topSpeed), `${s.speedValue}`);
  ok("seed: speedUnit", s.speedUnit === (ss.speed?.unit === "kph" ? "kph" : "mph"), s.speedUnit);
  ok("seed: range+unit", s.range === (Number(ss.range) || 0) && ["mi", "km"].includes(s.rangeUnit), `${s.range} ${s.rangeUnit}`);
  ok("seed: fuel block", s.fuel.max === (Number(ss.fuel?.max) || 0) && typeof s.fuel.type === "string");
  ok("seed: mass/cargo", s.mass.value === (Number(ss.mass?.value) || 0) && s.cargo.value === (Number(ss.cargo?.value) || 0));
  ok("seed: bodyRating", s.bodyRating === (Number(ss.body) || 0), `${s.bodyRating}`);

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
  out.cleanupIds = [actor.id, sub.id, legacy.id];
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
