/**
 * Approved decisions C3 / C5 / F6 (:30004, official 1.1.1 + module).
 *  F6  item-sheet _cpActivateBasicItemActions: the editable-check now runs BEFORE the bind-once flag is
 *      set, so a read-only first render no longer claims the bind and blocks a later editable render.
 *  C5  seam-shim installWeaponFiredShim: warns if the base emits no weaponFired AND none of its fire
 *      methods exist to patch (base rename → automation silently off). Guarded by foundAny (no false
 *      warn on a harmless re-run where the methods are already ours).
 *  C3  cp2020-augmented: logs when the augmented actor/item sheet is registered as world default
 *      (overriding the host), so the override isn't silent.
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-decisions-c3c5f6.mjs
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
let failures = 0;
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await joinAs(page, /^gamemaster$/i, [GM_PW]);

  const R = await page.evaluate(async () => {
    const M = "/modules/cp2020-augmented/module";
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    try {
      // module still loads/active after the edits
      ok("module active", game.modules.get("cp2020-augmented")?.active === true, game.modules.get("cp2020-augmented")?.active);

      // F6 — between the guard READ and the flag WRITE there is now an editable bail-out
      const itemSrc = await (await fetch(`${M}/item/item-sheet.js`, { cache: "no-store" })).text();
      const between = itemSrc.match(/cpBasicItemActionsBound === "1"\) return;([\s\S]*?)cpBasicItemActionsBound = "1"/)?.[1] ?? "";
      ok("F6 editable-check precedes the bind flag", /if \(!editable\) return;/.test(between), JSON.stringify(between.replace(/\s+/g, " ").trim().slice(0, 60)));

      // C5 — foundAny guard + the warn
      const shimSrc = await (await fetch(`${M}/seam-shim.js`, { cache: "no-store" })).text();
      ok("C5 foundAny guard present", /foundAny/.test(shimSrc), (shimSrc.match(/foundAny/g) || []).length);
      ok("C5 warn on no fire methods", /console\.warn\([^)]*seam shim: base emits no/.test(shimSrc), /console\.warn\([^)]*seam shim: base emits no/.test(shimSrc));

      // C3 — override log for both sheets
      const initSrc = await (await fetch(`${M}/cp2020-augmented.js`, { cache: "no-store" })).text();
      ok("C3 actor-sheet override log", /augmented actor sheet as world default/.test(initSrc), true);
      ok("C3 item-sheet override log", /augmented item sheet as world default/.test(initSrc), true);

      // the edited modules import cleanly in the browser
      const shim = await import(`${M}/seam-shim.js`);
      ok("seam-shim imports (ammoEffectFields fn)", typeof shim.ammoEffectFields === "function", typeof shim.ammoEffectFields);
      const isheet = await import(`${M}/item/item-sheet.js`);
      ok("item-sheet imports (a class exported)", Object.values(isheet).some(v => typeof v === "function"), Object.keys(isheet).length);
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    }
    return out;
  });

  if (R.error) { console.error("IN-PAGE ERROR:", R.error); failures++; }
  console.log("Decisions C3/C5/F6\n" + R.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(44)} got=${c.got}`).join("\n"));
  failures += R.checks.filter(c => !c.pass).length;
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
