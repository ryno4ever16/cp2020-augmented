/** Vehicle schema FRONT END (VEHICLE-SPEC.md §7 phases 2 leftovers + 4): maneuver-speed vs
 *  maneuverability relabel, fuel-block demotion (last, gauge only with data, hidden on a locked
 *  sheet with no fuel data), and the shop's Vehicles class sub-filter (soft enum → chips).
 *  Mutates ONE supplement-vehicles doc's vehicleType for the live-filter round-trip, then reverts
 *  (compiled packs/ is local runtime data — gitignored). */
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
  const catMod  = await import("/modules/cp2020-augmented/module/shop/catalog.js");
  const catsMod = await import("/modules/cp2020-augmented/module/shop/categories.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const rootOf = (sheet) => sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];

  // (0) The pure normalizer, live in the module's own runtime.
  out.pure = {
    av: catsMod.vehicleSubOf("AV (Aerodyne)"),
    panzer: catsMod.vehicleSubOf("panzer"),
    blank: catsMod.vehicleSubOf(""),
    unknown: catsMod.vehicleSubOf("Mule"),
    item: catsMod.categoryOfItem("vehicle", { vehicleType: "Car" })
  };

  // (1) SHEET, editable world vehicle: relabel + fuel demotion.
  for (const i of game.items.filter(i => i.name.startsWith("__PW__VFE"))) await i.delete().catch(() => {});
  const item = await Item.create({ name: "__PW__VFE", type: "vehicle" });
  await item.sheet.render(true);
  await sleep(700);
  let root = rootOf(item.sheet);
  const fields = root?.querySelector(".cp-vehicle-item-fields");
  const manLbl = root?.querySelector('label[for="system.speed.maneuver"]');
  const mvLbl  = root?.querySelector('label[for="system.maneuverability.value"]');
  const lists  = [...(fields?.querySelectorAll(":scope > .field-list") ?? [])];
  const fuelList = root?.querySelector('input[name="system.fuel.max"]')?.closest(".field-list");
  out.sheetEditable = {
    maneuverLabel: manLbl?.textContent.trim() ?? "",
    maneuverTitleOk: !!manLbl?.title && !/CYBERPUNK\./.test(manLbl?.title ?? ""),
    mvTitleOk: !!mvLbl?.title && !/CYBERPUNK\./.test(mvLbl?.title ?? ""),
    fuelPresent: !!fuelList,
    fuelIsLast: !!fuelList && lists.indexOf(fuelList) === lists.length - 1,
    fuelGaugeAtZero: !!fuelList?.querySelector(".meter-gauge"),
    rawKeyLeak: /CYBERPUNK\./.test(fields?.textContent ?? "")
  };
  await item.update({ "system.fuel.max": 50, "system.fuel.value": 25 });
  await item.sheet.render(true);
  await sleep(500);
  root = rootOf(item.sheet);
  out.sheetEditable.fuelGaugeAfterMax =
    !!root?.querySelector('input[name="system.fuel.max"]')?.closest(".field-list")?.querySelector(".meter-gauge");
  await item.sheet.close().catch(() => {});

  // (2) SHEET, LOCKED pack vehicle with no fuel data: the fuel block is skipped entirely.
  const pack = game.packs.get("cp2020-augmented.supplement-vehicles");
  const prevPackLocked = pack.locked === true;   // capture original lock state → restore it (don't force-lock)
  await pack.configure({ locked: true });
  const idx = await pack.getIndex({ fields: ["system.fuel", "system.vehicleType"] });
  const noFuel = (e) => !(Number(e.system?.fuel?.max) || Number(e.system?.fuel?.value)
    || Number(e.system?.fuel?.efficiency) || String(e.system?.fuel?.type ?? "").trim());
  const bare = idx.contents.find(noFuel);
  const bareDoc = await pack.getDocument(bare._id);
  await bareDoc.sheet.render(true);
  await sleep(700);
  const broot = rootOf(bareDoc.sheet);
  out.sheetLocked = {
    name: bareDoc.name,
    editable: bareDoc.sheet.isEditable,
    fuelHidden: !broot?.querySelector('input[name="system.fuel.max"]'),
    sdpStillThere: !!broot?.querySelector('input[name="system.sdp.max"]')
  };
  await bareDoc.sheet.close().catch(() => {});

  // (3) SHOP index: class one pack vehicle, prove the soft enum reaches the catalog rows.
  const target = idx.contents.find(e => e._id !== bare._id) ?? bare;
  await pack.configure({ locked: false });
  const tdoc = await pack.getDocument(target._id);
  const prevType = tdoc.system.vehicleType ?? "";
  try {
    await tdoc.update({ "system.vehicleType": "AV (Aerodyne)" });
    catMod.clearCatalogIndexCache();
    const all = await catMod.getCatalogIndex();
    const row = all.find(x => x.id === target._id);
    // The pack now ships several AV-typed vehicles, so a blanket "first other vehicle sub === ''" is a
    // false RED. Anchor the filter check to the catalog's own AV count instead (see #3 below).
    out.index = { targetSub: row?.sub ?? null, targetCat: row?.category ?? null,
      avClassCount: all.filter(x => x.category === "Vehicles" && x.sub === "AVs").length };

    // (4) SHOP UI: sub chips render localized; clicking one filters to exactly the classed vehicle.
    const cat = new catMod.CatalogBrowser(null, { view: "catalog" });
    await cat.render(true);
    await sleep(900);
    let croot = rootOf(cat);
    const chips = [...(croot?.querySelectorAll('.cp-cat-chip[data-cat^="Vehicles/"]') ?? [])];
    out.ui = {
      chipCount: chips.length,
      avChipLabel: croot?.querySelector('.cp-cat-chip[data-cat="Vehicles/AVs"]')?.textContent.trim() ?? "",
      chipLabelLeak: /CYBERPUNK\./.test(chips.map(c => c.textContent).join(""))
    };
    croot?.querySelector('.cp-cat-chip[data-cat="Vehicles/AVs"]')?.click();
    await sleep(900);
    croot = rootOf(cat);
    const vis = [...(croot?.querySelectorAll(".cp-catalog-list .cp-catalog-row") ?? [])].filter(x => x.style.display !== "none");
    out.filtered = {
      count: vis.length,
      hasTarget: vis.some(x => x.dataset.itemId === target._id || x.textContent.includes(tdoc.name)),
      chipActive: !!croot?.querySelector('.cp-cat-chip[data-cat="Vehicles/AVs"].active')
    };
    await cat.close().catch(() => {});
  } finally {
    // (5) REVERT the pack mutation whatever happened above.
    await tdoc.update({ "system.vehicleType": prevType }).catch(() => {});
    await pack.configure({ locked: prevPackLocked }).catch(() => {});
    catMod.clearCatalogIndexCache();
  }
  await item.delete().catch(() => {});
  out.reverted = (await pack.getDocument(target._id)).system.vehicleType === prevType;
  return out;
});

console.log("\n===== vehicle front end (relabel + fuel demotion + shop class filter) =====");
console.log("  pure:", JSON.stringify(r.pure));
console.log("  sheet editable:", JSON.stringify(r.sheetEditable));
console.log("  sheet locked:", JSON.stringify(r.sheetLocked));
console.log("  index:", JSON.stringify(r.index));
console.log("  ui:", JSON.stringify(r.ui));
console.log("  filtered:", JSON.stringify(r.filtered), "reverted:", r.reverted);

const checks = [
  ["pure vehicleSubOf AV→AVs", r.pure.av === "AVs"],
  ["pure panzer→Hover", r.pure.panzer === "Hover"],
  ["pure blank→''", r.pure.blank === ""],
  ["pure unknown→Other", r.pure.unknown === "Other"],
  ["pure categoryOfItem vehicle/Car", r.pure.item?.category === "Vehicles" && r.pure.item?.sub === "Cars"],
  ["maneuver label = Maneuver", r.sheetEditable.maneuverLabel === "Maneuver"],
  ["maneuver tooltip resolves", r.sheetEditable.maneuverTitleOk === true],
  ["maneuverability tooltip resolves", r.sheetEditable.mvTitleOk === true],
  ["fuel present when editable", r.sheetEditable.fuelPresent === true],
  ["fuel block renders LAST", r.sheetEditable.fuelIsLast === true],
  ["no fuel gauge at zero capacity", r.sheetEditable.fuelGaugeAtZero === false],
  ["fuel gauge appears with capacity", r.sheetEditable.fuelGaugeAfterMax === true],
  ["no raw key leak on sheet", r.sheetEditable.rawKeyLeak === false],
  ["locked sheet is non-editable", r.sheetLocked.editable === false],
  ["locked no-fuel sheet hides fuel", r.sheetLocked.fuelHidden === true],
  ["locked sheet keeps SDP", r.sheetLocked.sdpStillThere === true],
  ["index: classed vehicle sub = AVs", r.index.targetSub === "AVs"],
  ["index: category Vehicles", r.index.targetCat === "Vehicles"],
  ["ui: 12 vehicle sub chips", r.ui.chipCount === 12],
  ["ui: AVs chip label localized", r.ui.avChipLabel === "AVs"],
  ["ui: no chip label leak", r.ui.chipLabelLeak === false],
  ["filter: shows exactly the AV-classed vehicles incl. the target", r.filtered.count === r.index.avClassCount && r.filtered.count > 0 && r.filtered.hasTarget === true],
  ["filter: chip toggles active", r.filtered.chipActive === true],
  ["pack mutation reverted", r.reverted === true],
  ["0 console errors", errors.length === 0]
];
let fail = 0;
for (const [name, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) fail++; }
if (errors.length) console.log("  errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
