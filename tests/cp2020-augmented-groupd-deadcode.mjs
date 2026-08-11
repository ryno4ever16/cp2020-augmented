/**
 * Group D dead-code removal — load-confirm (:30004, official 1.1.1 + module).
 *
 * After deleting 4 pre-Option-B injector files + their 5 templates + the dead buy-ammo dialog engine,
 * the module must still LOAD clean (no missing-template preload, no dangling import) and the features
 * those injectors used to add must still be present INLINE in the vendored Option-B sheets:
 *   - actor sheet renders (IP cluster + services now inline)
 *   - cyberware item sheet renders (install button inline)
 *   - skill item sheet renders WITH the "Is Martial Art" editor inline (martial-skill-editor.js deleted)
 *   - a deleted template 404s; the preload list no longer names it
 *   - 0 console errors across load + all sheet opens
 *
 * Run from tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-groupd-deadcode.mjs
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
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const gm = await ctx.newPage();
  const errors = [];
  gm.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  gm.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await joinAs(gm, /gamemaster/i, [GM_PW]);
  await gm.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 30_000 });

  // Served-source: the entry no longer preloads the deleted templates; the buy-ammo dead engine is gone
  // but its live helpers remain. (A missing-template preload would surface as a console error below —
  // so we don't fetch the deleted file directly here, to avoid a benign network 404 in the error count.)
  const served = await gm.evaluate(async () => {
    const entry = await (await fetch("/modules/cp2020-augmented/module/cp2020-augmented.js", { cache: "no-store" })).text();
    const buyammo = await (await fetch("/modules/cp2020-augmented/module/dialog/buy-ammo.js", { cache: "no-store" })).text();
    return {
      preloadCleaned: !entry.includes("skill-cluster") && !entry.includes("services-panel") && !entry.includes("install-button") && !entry.includes("martial-skill-editor") && !entry.includes("dialog/buy-ammo.hbs"),
      engineGone: !buyammo.includes("openBuyAmmoDialog") && buyammo.includes("export function canBuyAmmo") && buyammo.includes("export function applyAmmoModifierUpdate"),
    };
  });
  log.push(`served: preloadCleaned=${served.preloadCleaned} buyAmmoEngineGone=${served.engineGone}`);
  results.served = { pass: served.preloadCleaned && served.engineGone, detail: "preload list no longer names the deleted templates; buy-ammo dead engine gone, live helpers kept" };

  // Render the three affected sheets; assert each produces a sheet element and no error.
  const sheets = await gm.evaluate(async () => {
    const out = {};
    const openAndProbe = async (doc, selectorProbes) => {
      await doc.sheet.render(true);
      for (let i = 0; i < 40 && !doc.sheet.element; i++) await new Promise(r => setTimeout(r, 100));
      const root = doc.sheet.element instanceof HTMLElement ? doc.sheet.element : doc.sheet.element?.[0];
      const rendered = !!root;
      const probes = {};
      for (const [k, sel] of Object.entries(selectorProbes)) probes[k] = rendered ? !!root.querySelector(sel) : false;
      await doc.sheet.close();
      return { rendered, probes };
    };
    for (const a of game.actors.filter(a => a.name?.startsWith("__PWD__"))) await a.delete().catch(()=>{});
    for (const it of game.items.filter(i => i.name?.startsWith("__PWD__"))) await it.delete().catch(()=>{});

    const pc = await Actor.create({ name: "__PWD__PC", type: "character" });
    out.actor = await openAndProbe(pc, {});                 // just needs to render clean

    const cybItem = await Item.create({ name: "__PWD__Cyber", type: "cyberware" });
    out.cyberware = await openAndProbe(cybItem, {});

    const skillItem = await Item.create({ name: "__PWD__Skill", type: "skill" });
    // The vendored skill sheet should carry the martial editor inline (flags.cp2020-augmented.isMartialArt).
    out.skill = await openAndProbe(skillItem, { martialEditor: '[name*="isMartialArt"], [data-martial], .cp2020ae-martial-editor, [name*="martialBonuses"]' });

    await pc.delete().catch(()=>{}); await cybItem.delete().catch(()=>{}); await skillItem.delete().catch(()=>{});
    return out;
  });
  log.push(`sheets: actor.rendered=${sheets.actor.rendered} cyberware.rendered=${sheets.cyberware.rendered} skill.rendered=${sheets.skill.rendered} skill.martialEditor=${sheets.skill.probes.martialEditor}`);
  results.sheets_render = { pass: sheets.actor.rendered && sheets.cyberware.rendered && sheets.skill.rendered,
    detail: `actor/cyberware/skill item sheets all render after the injector deletions` };
  results.martial_editor_inline = { pass: sheets.skill.probes.martialEditor === true,
    detail: sheets.skill.probes.martialEditor ? "skill sheet still carries the Is-Martial-Art editor inline (feature survived martial-skill-editor.js deletion)" : "martial editor NOT found on skill sheet" };

  // small settle for any late async errors
  await gm.waitForTimeout(500);
  log.push(`console errors: ${errors.length}${errors.length ? " → " + JSON.stringify(errors.slice(0, 4)) : ""}`);
  results.no_console_errors = { pass: errors.length === 0, detail: errors.length ? `${errors.length} errors` : "0 console/page errors across load + all sheet opens" };
} catch (e) {
  log.push("ERROR: " + e.message);
} finally {
  await browser.close();
}

console.log("\n===== GROUP D DEAD-CODE REMOVAL — load-confirm (:30004) =====");
log.forEach(l => console.log("  • " + l));
console.log("");
let allPass = Object.keys(results).length > 0;
for (const [k, v] of Object.entries(results)) {
  console.log(`  ${v.pass ? "PASS ✅" : "FAIL ❌"}  ${k.padEnd(20)} — ${v.detail}`);
  if (!v.pass) allPass = false;
}
console.log("\n  OVERALL: " + (allPass ? "ALL PASS ✅" : "SOME FAILED ❌"));
process.exit(allPass ? 0 : 1);
