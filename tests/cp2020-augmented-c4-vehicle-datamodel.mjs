/**
 * Group C verification (:30004, official 1.1.1 + module):
 *   C4 — the module's `vehicle` item DataModel now EXTENDS the system's registered model (built at init
 *        via makeVehicleItemData) instead of a static mirror → future base fields + migrate chain.
 *   C1/C2 — sheet-label i18n is self-contained in the module (spot-check that the previously host-only
 *        keys + the two formerly-missing keys now resolve from the MODULE's en.json).
 *
 * Run from tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-c4-vehicle-datamodel.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";

async function joinAs(page, match, passwords) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 30_000 });
  const users = await sel.locator("option").evaluateAll((o) =>
    o.map((x) => ({ v: x.value, l: (x.textContent || "").trim() })).filter((x) => x.v));
  const u = users.find((x) => match.test(x.l));
  if (!u) throw new Error("no user matching " + match);
  for (const pw of passwords) {
    await sel.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([
      page.waitForNavigation({ url: /\/game/, timeout: 15_000 }).catch(() => {}),
      page.locator('button[name="join"]').click(),
    ]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 15_000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await sel.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join as " + u.l);
}

const browser = await chromium.launch({ headless: true });
const results = {};
const log = [];
try {
  const gm = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const errors = [];
  gm.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await joinAs(gm, /gamemaster/i, [GM_PW]);
  await gm.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});

  // Served-source check: the symlinked module must be serving the edited factory.
  const src = await gm.evaluate(async () => {
    const r = await fetch("/modules/cp2020-augmented/module/data/vehicle-item-data.js", { cache: "no-store" });
    const t = await r.text();
    return { hasFactory: t.includes("export function makeVehicleItemData"), noStaticClass: !t.includes("export class CyberpunkVehicleItemData") };
  });
  log.push(`served vehicle-item-data.js: factory=${src.hasFactory} staticClassGone=${src.noStaticClass}`);
  if (!src.hasFactory || !src.noStaticClass) throw new Error("rig not serving edited vehicle-item-data.js");

  // ===== C4a: the registered vehicle model chains to the system's own model =====
  const chain = await gm.evaluate(() => {
    const V = CONFIG.Item?.dataModels?.vehicle;
    const names = [];
    let c = V;
    while (c && c !== foundry.abstract.TypeDataModel && c.name) { names.push(c.name); c = Object.getPrototypeOf(c); }
    return { vName: V?.name, chain: names, extendsSystem: names.includes("CyberpunkVehicleData") };
  });
  log.push(`vehicle model: ${chain.vName}; proto chain: ${JSON.stringify(chain.chain)}`);
  results.C4a_chain = { pass: chain.vName === "CyberpunkVehicleItemData" && chain.extendsSystem,
    detail: chain.extendsSystem ? "module model EXTENDS the system's CyberpunkVehicleData (chains base fields + migrate)" : "does NOT extend the system model" };

  // ===== C4b: schema keeps the system's fields AND the 3 module additions =====
  const schema = await gm.evaluate(() => {
    const V = CONFIG.Item.dataModels.vehicle;
    const f = V.schema?.fields ?? {};
    const want = ["sdp", "sp", "passengers", "speed", "maneuverability", "fuel", "range", "rangeUnit"];
    return { present: want.filter(k => k in f), missing: want.filter(k => !(k in f)) };
  });
  log.push(`schema fields present: ${JSON.stringify(schema.present)} missing: ${JSON.stringify(schema.missing)}`);
  results.C4b_schema = { pass: schema.missing.length === 0, detail: schema.missing.length ? `MISSING fields: ${schema.missing.join(",")}` : "all system fields + range/rangeUnit/speed.unit present" };

  // ===== C4c: a vehicle item round-trips (additions persist, chained defaults apply) =====
  const rt = await gm.evaluate(async () => {
    for (const a of game.items.filter(i => i.name === "__PW__Veh")) await a.delete().catch(()=>{});
    const it = await Item.create({ name: "__PW__Veh", type: "vehicle",
      system: { range: 100, rangeUnit: "km", speed: { value: 50, unit: "kph" } } });
    const s = it.system;
    const out = { range: s.range, rangeUnit: s.rangeUnit, speedUnit: s.speed?.unit, speedValue: s.speed?.value,
                  sp: s.sp, passengers: s.passengers, hasSdp: !!s.sdp };
    await it.delete().catch(()=>{});
    return out;
  });
  log.push(`round-trip vehicle item: ${JSON.stringify(rt)}`);
  results.C4c_roundtrip = { pass: rt.range === 100 && rt.rangeUnit === "km" && rt.speedUnit === "kph" && rt.speedValue === 50 && rt.sp === 10 && rt.passengers === 4 && rt.hasSdp,
    detail: `range=${rt.range}${rt.rangeUnit} speed=${rt.speedValue}${rt.speedUnit} chained-defaults sp=${rt.sp}/pass=${rt.passengers}/sdp=${rt.hasSdp}` };

  // ===== C1/C2: formerly host-only + formerly-missing keys resolve from the module now =====
  const i18n = await gm.evaluate(() => ({
    Program: game.i18n.localize("CYBERPUNK.Program"),   // C2 (was raw)
    Skill:   game.i18n.localize("CYBERPUNK.Skill"),     // C2 (was raw)
    BTM:     game.i18n.localize("CYBERPUNK.BTM"),       // C1 leak sample
    Ablate:  game.i18n.localize("CYBERPUNK.Ablate"),    // C1 leak sample
  }));
  log.push(`i18n resolve: Program="${i18n.Program}" Skill="${i18n.Skill}" BTM="${i18n.BTM}" Ablate="${i18n.Ablate}"`);
  results.C1C2_i18n = { pass: i18n.Program === "Program" && i18n.Skill === "Skill" && i18n.BTM === "Body Type Modifier" && i18n.Ablate === "Ablate",
    detail: "Program/Skill (were raw) + BTM/Ablate (were host-only) all resolve — no raw keys" };

  log.push(`console errors during run: ${errors.length}${errors.length ? " → " + JSON.stringify(errors.slice(0, 3)) : ""}`);
  results.no_console_errors = { pass: errors.length === 0, detail: errors.length ? `${errors.length} console errors` : "0 console errors" };
} catch (e) {
  log.push("ERROR: " + e.message);
} finally {
  await browser.close();
}

console.log("\n===== GROUP C: C4 (vehicle DataModel chain) + C1/C2 (i18n self-containment) =====");
log.forEach(l => console.log("  • " + l));
console.log("");
let allPass = Object.keys(results).length > 0;
for (const [k, v] of Object.entries(results)) {
  console.log(`  ${v.pass ? "PASS ✅" : "FAIL ❌"}  ${k.padEnd(16)} — ${v.detail}`);
  if (!v.pass) allPass = false;
}
console.log("\n  OVERALL: " + (allPass ? "ALL PASS ✅" : "SOME FAILED ❌"));
process.exit(allPass ? 0 : 1);
