/**
 * KEEPER: a vehicle weapon's own SP is stored on the document and shown on its item sheet
 * (:30004, official 1.1.1 + module).
 *
 * Before 2026-10-04 the vehicle-weapon model (module/data/vehicle-item-data.js) declared no `sp`, so
 * the figure in the pack source was dropped on read (`doc.system.sp` was undefined) and the sheet had
 * nowhere to show it.
 *
 *   §1  pack document 14.5mm Heavy MG: system.sp = 25 (Maximum Metal p.71); its sheet's SP input reads 25
 *   §2  world copy: typing 31 into the SP input (real change event) persists to system.sp; a re-opened
 *       sheet reads 31; restoring 25 persists too
 *   §3  NEGATIVE: a fresh vehicle weapon with no SP reads the schema default 0
 *   §4  0 console errors
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";
const PACK = "cp2020-augmented.vehicle-weapons", ID = "B1cLAziYZ2g2goxe";

let pass = 0, fail = 0;
const failed = [];
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d !== "" ? ` — ${d}` : ""}`);
  if (ok) pass++; else { fail++; failed.push(n); }
};

const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", e => errors.push(String(e?.message || e)));
page.on("console", m => { if (m.type() === "error" && !/compatibility|deprecat|screen resolution/i.test(m.text())) errors.push(m.text()); });

try {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 30_000 });
  const gmVal = await sel.locator("option").evaluateAll(o => o.find(x => /^gamemaster$/i.test((x.textContent || "").trim()))?.value);
  await sel.selectOption(gmVal);
  await page.locator('input[name="password"]').fill(GM_PW);
  await Promise.all([page.waitForNavigation({ url: /\/game/, timeout: 20_000 }).catch(() => {}), page.locator('button[name="join"]').click()]);
  await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 30_000 });

  const R = await page.evaluate(async ({ PACK, ID }) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (const i of game.items.filter(i => i.name?.startsWith("__PW__VWSP"))) await i.delete().catch(() => {});
    const out = {};
    /** Render a sheet, wait for the SP input, return its value; leave the sheet open if `keep`. */
    const spInput = async (doc) => {
      await doc.sheet.render(true);
      const t0 = Date.now();
      let inp = null;
      while (Date.now() - t0 < 8000) { inp = doc.sheet.element?.querySelector('input[name="system.sp"]'); if (inp) break; await sleep(120); }
      return inp;
    };
    const created = [];
    try {
      // §1 pack document
      const doc = await game.packs.get(PACK).getDocument(ID);
      out.packName = doc?.name ?? null;
      out.packSp = doc?.system?.sp;
      out.packSdp = doc?.system?.sdp;
      const pInp = await spInput(doc);
      out.packInput = pInp ? pInp.value : null;
      out.packLabel = pInp?.closest(".field")?.querySelector("label")?.textContent?.trim() ?? null;
      out.packSameListAsSpaces = !!pInp?.closest(".field-list")?.querySelector('input[name="system.space"]');
      await doc.sheet.close();

      // §2 world copy, edit through the sheet
      const src = doc.toObject();
      delete src._id;
      src.name = "__PW__VWSP 14.5mm copy";
      const [copy] = await Item.createDocuments([src]);
      created.push(copy.id);
      out.copySp = copy.system.sp;
      const cInp = await spInput(copy);
      out.copyInput = cInp ? cInp.value : null;
      if (cInp) {
        cInp.value = "31";
        cInp.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const t1 = Date.now();
      while (game.items.get(copy.id)?.system?.sp !== 31 && Date.now() - t1 < 6000) await sleep(120);
      out.afterEditSp = game.items.get(copy.id)?.system?.sp;
      out.afterEditSource = game.items.get(copy.id)?._source?.system?.sp;
      await copy.sheet.close();
      await sleep(400);
      const rInp = await spInput(game.items.get(copy.id));
      out.reopenInput = rInp ? rInp.value : null;
      if (rInp) {
        rInp.value = "25";
        rInp.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const t2 = Date.now();
      while (game.items.get(copy.id)?.system?.sp !== 25 && Date.now() - t2 < 6000) await sleep(120);
      out.restoredSp = game.items.get(copy.id)?.system?.sp;
      await game.items.get(copy.id)?.sheet?.close();

      // §3 negative: a fresh weapon with no SP
      const [fresh] = await Item.createDocuments([{ name: "__PW__VWSP fresh", type: doc.type }]);
      created.push(fresh.id);
      out.freshSp = fresh.system.sp;
    } catch (e) {
      out.error = String(e?.stack || e);
    } finally {
      for (const id of created) await game.items.get(id)?.delete().catch(() => {});
    }
    return out;
  }, { PACK, ID });

  if (R.error) console.log("  (info) in-page error: " + R.error);
  console.log("\n§1 pack document");
  check("fixture: pack document is the 14.5mm Heavy MG", R.packName === "14.5mm Heavy MG", String(R.packName));
  check("pack document system.sp = 25", R.packSp === 25, String(R.packSp));
  check("NEGATIVE: pack document system.sdp stays 35 (neighbour field unaffected)", R.packSdp === 35, String(R.packSdp));
  check("pack sheet SP input value = 25", R.packInput === "25", String(R.packInput));
  check("pack sheet SP label reads 'SP'", R.packLabel === "SP", String(R.packLabel));
  check("SP input sits in the same field-list as the Spaces input", R.packSameListAsSpaces === true, String(R.packSameListAsSpaces));
  console.log("\n§2 world copy edit through the sheet");
  check("world copy system.sp = 25 on create", R.copySp === 25, String(R.copySp));
  check("world copy sheet SP input value = 25", R.copyInput === "25", String(R.copyInput));
  check("after typing 31: system.sp = 31", R.afterEditSp === 31, String(R.afterEditSp));
  check("after typing 31: stored source system.sp = 31", R.afterEditSource === 31, String(R.afterEditSource));
  check("re-opened sheet SP input value = 31", R.reopenInput === "31", String(R.reopenInput));
  check("restore to 25 persists", R.restoredSp === 25, String(R.restoredSp));
  console.log("\n§3 schema default");
  check("NEGATIVE: fresh vehicle weapon system.sp = 0", R.freshSp === 0, String(R.freshSp));
  console.log("\n§4 console");
  check("0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  fail++; failed.push("harness threw");
} finally {
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (failed.length) console.log("FAILED: " + failed.join(" || "));
process.exit(fail ? 1 : 0);
