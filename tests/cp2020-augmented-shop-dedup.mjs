/** Shop shelf de-duplication keeper.
 *
 *  The base system's add-on packs repeat weapons other packs carry: `pistols-add` and `rifles-add` hold
 *  a second copy of some thirty supplement weapons the module ships from the books and of four core
 *  ones, and `smgs-add` is three core SMGs under a longer spelling of the maker's name. The catalog
 *  listed every copy. It now leaves the two scraped packs off its shelves while the GM's hide setting is
 *  on, and leaves out any record the corrections registry marks `duplicateOf`.
 *
 *   A  SHELVES — with the hide on, no row comes from a hidden pack or carries `duplicateOf`; each of the
 *      three core SMGs is offered once; no two weapon rows share a name; the base melee pack's two
 *      unarmed-technique records (attack type "Martial") are not goods and get no row, searched or not
 *   B  THE INDEX KEEPS THEM — the full index still holds the hidden records, each `duplicateOf` names a
 *      record that exists, and a shop that already stocks a hidden item still resolves it
 *   C  THE SETTING DECIDES — hide off: the scraped packs' rows are offered again; hide back on: gone
 *
 *  Run:  node tests/cp2020-augmented-shop-dedup.mjs            (rig :30004)
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";

async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

let fail = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) fail++; };

const errors = [];
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1700, height: 950 } });
p.on("pageerror", e => errors.push(String(e)));
p.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await joinGM(p);

const priorHide = await p.evaluate(() => game.settings.get("cp2020-augmented", "hideScrapedPacks"));

/** The rows a GM's catalog would offer with no filter chosen, read through the catalog window's own
 *  row builder, plus the facts the legs need about the full index. */
const snapshot = () => p.evaluate(async () => {
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  const cat = await import("/modules/cp2020-augmented/module/shop/catalog.js");
  const S = await import("/modules/cp2020-augmented/module/settings.js");
  const all = await cat.getCatalogIndex();
  let app = [...foundry.applications.instances.values()].find(a => typeof a._filterRows === "function");
  if (!app) { cat.openShopWindow(null, { view: "catalog" }); await sleep(2500); app = [...foundry.applications.instances.values()].find(a => typeof a._filterRows === "function"); }
  const keep = { cats: app._cats, books: app._books };
  app._cats = new Set(); app._books = new Set();
  let rows, vendor;
  try {
    rows = app._filterRows(all, { isGM: true, cfg: S.shopSourceConfig(), search: "" });
    const hiddenStock = all.find(i => i.packId === "cyberpunk2020.pistols-add");
    vendor = hiddenStock ? app._vendorRows({ items: { [hiddenStock.key]: { qty: 1 } } }, new Map(all.map(i => [i.key, i])))[0] : null;
    vendor = vendor ? { available: vendor.available, name: vendor.name, expected: hiddenStock.name } : null;
  } finally { app._cats = keep.cats; app._books = keep.books; }
  const SCRAPED = ["cyberpunk2020.pistols-add", "cyberpunk2020.rifles-add"];
  const norm = s => String(s).toLowerCase().replace(/heckler\s*&\s*koch/g, "h&k").replace(/[“”"'’().,/+:-]/g, " ").replace(/\s+/g, " ").trim();
  const groups = {};
  for (const r of rows.filter(r => r.category === "Weapons")) (groups[norm(r.name)] ??= []).push(`${r.name} [${r.packId}]`);
  const sameName = Object.values(groups).filter(g => g.length > 1);
  const dupRecords = all.filter(i => i.duplicateOf);
  const keys = new Set(all.map(i => i.key));
  // A weapon record whose attack type is "Martial" is an unarmed technique the base melee pack files as
  // a weapon so a sheet can roll it. It is not a good.
  const isTechnique = i => i.type === "weapon" && String(i.attackType ?? "").trim().toLowerCase() === "martial";
  const savedSearch = { cats: app._cats, books: app._books };
  app._cats = new Set(); app._books = new Set();
  let searched;
  try { searched = ["strike", "kick"].map(q => app._filterRows(all, { isGM: true, cfg: S.shopSourceConfig(), search: q }).filter(isTechnique).length); }
  finally { app._cats = savedSearch.cats; app._books = savedSearch.books; }
  // The core price list's "Options" block (Cyberpunk 2020 p.64): three records in the module's gear pack.
  const options = ["Bfbrda78VGXHwxVd", "G1RH3FLBWfAUgWu6", "WsBXLH3KrbZuGHV1"].map(id => {
    const r = rows.find(r => r.packId === "cp2020-augmented.supplement-gear" && r.id === id);
    return r ? `${r.name}|${r.cost}|${r.canon}|${r.category}|${r.unpriced ? "unpriced" : "priced"}` : `missing ${id}`;
  });
  return {
    options,
    techniqueRows: rows.filter(isTechnique).map(r => r.name),
    techniqueIndex: all.filter(isTechnique).map(i => i.name).sort(),
    techniqueSearched: searched,
    rows: rows.length,
    fromScraped: rows.filter(r => SCRAPED.includes(r.packId)).length,
    withDuplicateOf: rows.filter(r => r.duplicateOf).length,
    hk: ["5PIcgtNXDW6FgPEo", "x0X4jTAKqegwNUPk", "Y5Y4fkvE0YWeS5M8"].map(id => rows.filter(r => r.id === id).length),
    hkCopies: rows.filter(r => r.packId === "cyberpunk2020.smgs-add").length,
    sameName: sameName.length, sameNameSample: sameName.slice(0, 4).map(g => g.join(" = ")),
    indexScraped: all.filter(i => SCRAPED.includes(i.packId)).length,
    dupRecords: dupRecords.length, dupTargetsExist: dupRecords.every(i => keys.has(i.duplicateOf)),
    vendor,
  };
});
const setHide = (v) => p.evaluate(async (v) => { await game.settings.set("cp2020-augmented", "hideScrapedPacks", v); await new Promise(res => setTimeout(res, 2000)); }, v);

try {
  if (priorHide !== true) await setHide(true);
  const on = await snapshot();
  check("A1 hide on: no shelf row comes from a scraped pack", on.rows > 500 && on.fromScraped === 0, `${on.rows} rows, ${on.fromScraped} from the scraped packs`);
  check("A2 no shelf row is a record marked as a second copy", on.withDuplicateOf === 0 && on.hkCopies === 0, `${on.withDuplicateOf} marked rows, ${on.hkCopies} from smgs-add`);
  check("A3 each of the three core SMGs is offered exactly once", on.hk.join(",") === "1,1,1", on.hk.join(","));
  check("A4 no two weapon rows share a name", on.sameName === 0, on.sameNameSample.join(" | "));
  check("A5 fixture guard: the index holds the base pack's two unarmed-technique records", on.techniqueIndex.join(",") === "Kick,Strike", on.techniqueIndex.join(","));
  check("A6 no shelf row is an unarmed-technique record", on.techniqueRows.length === 0, on.techniqueRows.join(", "));
  check("A7 a name search does not bring one back", on.techniqueSearched.join(",") === "0,0", on.techniqueSearched.join(","));
  check("A8 the core price list's three weapon options are on the shelf, core book, at the printed price",
    on.options.join(" ; ") === "Silencer|100|core|Gear|priced ; Holster (all types)|20|core|Gear|priced ; Shoulder Sling|5|core|Gear|priced", on.options.join(" ; "));
  check("B1 the full index still holds the scraped packs' records", on.indexScraped > 100, `${on.indexScraped} records`);
  check("B2 every `duplicateOf` names a record that exists", on.dupRecords === 3 && on.dupTargetsExist === true, `${on.dupRecords} marked, targets exist: ${on.dupTargetsExist}`);
  check("B3 a shop stocking an item from a hidden pack still resolves it", on.vendor?.available === true && on.vendor.name === on.vendor.expected, JSON.stringify(on.vendor));

  await setHide(false);
  const off = await snapshot();
  check("C1 hide off: the scraped packs' rows are offered again", off.fromScraped > 0 && off.rows === on.rows + off.fromScraped, `${off.fromScraped} rows back, ${off.rows} in all (was ${on.rows})`);
  check("C2 the marked second copies stay off the shelves either way", off.withDuplicateOf === 0, `${off.withDuplicateOf}`);
  await setHide(true);
  const again = await snapshot();
  check("C3 hide back on: gone again, same shelf as before", again.fromScraped === 0 && again.rows === on.rows, `${again.rows} rows, ${again.fromScraped} from the scraped packs`);
} finally {
  await p.evaluate(async (v) => {
    for (const app of [...foundry.applications.instances.values()]) if (typeof app._filterRows === "function") { try { await app.close({ animate: false }); } catch { /* gone */ } }
    if (game.settings.get("cp2020-augmented", "hideScrapedPacks") !== v) await game.settings.set("cp2020-augmented", "hideScrapedPacks", v);
    await new Promise(res => setTimeout(res, 1500));
  }, priorHide).catch(() => {});
}
const after = await p.evaluate(() => game.settings.get("cp2020-augmented", "hideScrapedPacks"));
check("Z  the hide setting is restored", after === priorHide, `${after}`);
check("Z  0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await b.close();
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
