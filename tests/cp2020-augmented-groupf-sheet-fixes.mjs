/**
 * Group F sheet/dialog correctness — F1/F2/F5/F9 (:30004, official 1.1.1 + module).
 *   F5: re-opening the IP tracker used to throw (bringToTop() — V2 only has bringToFront). Open it twice → no throw.
 *   F2: the Fire dialog had a fixed id → singleton; opening a 2nd weapon's dialog destroyed the 1st. Two now coexist.
 *   F9: augmented item sheet _prepareContext now chains super → the sheet renders with the base context.
 *   F1: the chip-sync used jQuery .find() on a native V2 element (threw) → native querySelector (served-source).
 *   + 0 console errors across it all.
 *
 * Run from tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-groupf-sheet-fixes.mjs
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
  gm.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await joinAs(gm, /^gamemaster$/i, [GM_PW]);
  await gm.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 30_000 });

  const src = await gm.evaluate(async () => {
    const g = async (p) => (await fetch(p, { cache: "no-store" })).text();
    const md = await g("/modules/cp2020-augmented/module/dialog/modifiers.js");
    const tr = await g("/modules/cp2020-augmented/module/ip/tracker.js");
    const ai = await g("/modules/cp2020-augmented/module/item/augmented-item-sheet.js");
    const as = await g("/modules/cp2020-augmented/module/actor/actor-sheet.js");
    return {
      f2: !/id:\s*["']weapon-modifier["']/.test(md),
      f5: tr.includes("bringToFront ?? _ipTracker.bringToTop"),
      f9: ai.includes("await super._prepareContext(options)"),
      f1: as.includes('querySelector(\'input[name="system.isChipped"]\')') && !as.includes('html.find('),
    };
  });
  log.push(`served: F2(no fixed id)=${src.f2} F5(bringToFront)=${src.f5} F9(super chain)=${src.f9} F1(native querySelector)=${src.f1}`);
  results.served = { pass: src.f2 && src.f5 && src.f9 && src.f1, detail: "all four fixes present in the served code" };

  // F5: re-open the IP tracker twice — must not throw.
  const f5 = await gm.evaluate(async () => {
    const mod = await import("/modules/cp2020-augmented/module/ip/tracker.js");
    try {
      mod.openIpTracker();
      await new Promise(r => setTimeout(r, 300));
      mod.openIpTracker();                     // re-open (the path that used to call bringToTop and throw)
      await new Promise(r => setTimeout(r, 200));
      const inst = [...foundry.applications.instances.values()].filter(a => a.constructor?.name === "IpTracker");
      for (const a of inst) await a.close().catch(()=>{});
      return { ok: true, count: inst.length };
    } catch (e) { return { ok: false, err: e.message }; }
  });
  log.push(`F5 re-open IP tracker: ok=${f5.ok} trackerInstances=${f5.count ?? "-"}${f5.err ? " ERR:" + f5.err : ""}`);
  results.F5_tracker_reopen = { pass: f5.ok === true, detail: f5.ok ? "opened + re-opened with no throw (bringToFront)" : "threw: " + f5.err };

  // F2: two Fire dialogs for two weapons must coexist (no singleton clobber).
  const f2 = await gm.evaluate(async () => {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PWF__"))) await a.delete().catch(()=>{});
    const actor = await Actor.create({ name: "__PWF__PC", type: "character" });
    const [w1] = await actor.createEmbeddedDocuments("Item", [{ name: "__PWF__W1", type: "weapon", system: { weaponType: "pistol" } }]);
    const [w2] = await actor.createEmbeddedDocuments("Item", [{ name: "__PWF__W2", type: "weapon", system: { weaponType: "rifle" } }]);
    const { ModifiersDialog } = await import("/modules/cp2020-augmented/module/dialog/modifiers.js");
    const mk = (w) => new ModifiersDialog(actor, { weapon: w, targetTokens: [], modifierGroups: [], onConfirm: () => {} });
    const d1 = mk(w1); await d1.render(true);
    const d2 = mk(w2); await d2.render(true);
    await new Promise(r => setTimeout(r, 300));
    const dialogs = [...foundry.applications.instances.values()].filter(a => a.constructor?.name === "ModifiersDialog");
    const ids = dialogs.map(d => d.id);
    const bothRendered = !!d1.rendered && !!d2.rendered;
    for (const d of dialogs) await d.close().catch(()=>{});
    await actor.delete().catch(()=>{});
    return { count: dialogs.length, bothRendered, uniqueIds: new Set(ids).size };
  });
  log.push(`F2 two Fire dialogs: instances=${f2.count} bothRendered=${f2.bothRendered} uniqueIds=${f2.uniqueIds}`);
  results.F2_dialog_coexist = { pass: f2.count >= 2 && f2.bothRendered && f2.uniqueIds >= 2, detail: f2.count >= 2 ? "two Fire dialogs coexist with distinct ids (no singleton clobber)" : `only ${f2.count} instance(s) — 2nd clobbered the 1st` };

  // F9: augmented item sheet (vehicleWeapon) renders with the super-chained context.
  const f9 = await gm.evaluate(async () => {
    for (const it of game.items.filter(i => i.name?.startsWith("__PWF__"))) await it.delete().catch(()=>{});
    const it = await Item.create({ name: "__PWF__VW", type: "cp2020-augmented.vehicleWeapon" });
    let rendered = false, hasBase = false;
    try {
      await it.sheet.render(true);
      for (let i = 0; i < 30 && !it.sheet.element; i++) await new Promise(r => setTimeout(r, 100));
      rendered = !!it.sheet.element;
      const ctx = await it.sheet._prepareContext({});
      hasBase = ctx && ("document" in ctx) && ("editable" in ctx) && ("partType" in ctx);
      await it.sheet.close();
    } catch (e) { return { err: e.message }; }
    await it.delete().catch(()=>{});
    return { rendered, hasBase };
  });
  log.push(`F9 augmented item sheet: rendered=${f9.rendered} superChainedContext=${f9.hasBase}${f9.err ? " ERR:" + f9.err : ""}`);
  results.F9_sheet_super = { pass: f9.rendered === true && f9.hasBase === true, detail: f9.err ? "threw: " + f9.err : "renders; context carries base fields + augmentation" };

  await gm.waitForTimeout(400);
  log.push(`console errors: ${errors.length}${errors.length ? " → " + JSON.stringify(errors.slice(0, 4)) : ""}`);
  results.no_console_errors = { pass: errors.length === 0, detail: errors.length ? `${errors.length} errors` : "0 console/page errors" };
} catch (e) {
  log.push("ERROR: " + e.message);
} finally {
  await browser.close();
}

console.log("\n===== GROUP F SHEET/DIALOG FIXES (F1/F2/F5/F9, :30004) =====");
log.forEach(l => console.log("  • " + l));
console.log("");
let allPass = Object.keys(results).length > 0;
for (const [k, v] of Object.entries(results)) {
  console.log(`  ${v.pass ? "PASS ✅" : "FAIL ❌"}  ${k.padEnd(20)} — ${v.detail}`);
  if (!v.pass) allPass = false;
}
console.log("\n  OVERALL: " + (allPass ? "ALL PASS ✅" : "SOME FAILED ❌"));
process.exit(allPass ? 0 : 1);
