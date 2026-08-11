/**
 * Martial-tail dead-code cleanup (:30004, official 1.1.1 + module).
 *
 * Deleted the never-registered martial-sheet.js injector + its two templates (martial-panel.hbs,
 * dialog/martial-style.hbs) + their preload entries. The live martial features are unaffected: the
 * on-sheet `.martial-panel` is rendered by the V2 actor sheet (combat.hbs), and A6's status effects
 * come from martial.js applyMartialHitEffects (kept). This confirms the module still loads clean and
 * those live pieces survive.
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-martial-tail.mjs
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";

async function joinAs(page, match, passwords) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 30_000 });
  const users = await sel.locator("option").evaluateAll((o) => o.map((x) => ({ v: x.value, l: (x.textContent || "").trim() })).filter((x) => x.v));
  const u = users.find((x) => match.test(x.l));
  for (const pw of passwords) {
    await sel.selectOption(u.v); await page.locator('input[name="password"]').fill(pw);
    await Promise.all([ page.waitForNavigation({ url: /\/game/, timeout: 15_000 }).catch(() => {}), page.locator('button[name="join"]').click() ]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 15_000 }); return; } catch {}
  }
  throw new Error("could not join");
}

const browser = await chromium.launch({ headless: true });
let failures = 0;
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  // capture console errors + page errors that mention the module / martial / missing templates
  const rx = /cp2020-augmented|martial|template|\.hbs/i;
  page.on("console", (m) => { if (m.type() === "error" && rx.test(m.text())) errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => { const t = String(e?.message || e); if (rx.test(t)) errors.push("pageerror: " + t); });

  await joinAs(page, /^gamemaster$/i, [GM_PW]);

  const R = await page.evaluate(async () => {
    const M = "/modules/cp2020-augmented/module";
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await new Promise(r => setTimeout(r, 50)); } return false; };
    let actor = null;
    try {
      // live martial.js exports survive (A6 effects + defense + trained-martials)
      const MA = await import(`${M}/martial/martial.js`);
      ok("martial.js applyMartialHitEffects live", typeof MA.applyMartialHitEffects === "function", typeof MA.applyMartialHitEffects);
      ok("martial.js rollMeleeDefense live", typeof MA.rollMeleeDefense === "function", typeof MA.rollMeleeDefense);
      ok("martial.js trainedMartials live", typeof MA.trainedMartials === "function", typeof MA.trainedMartials);
      // the deleted injector's module is gone (import should reject)
      let injectorGone = false;
      try { await import(`${M}/martial/martial-sheet.js`); } catch { injectorGone = true; }
      ok("dead martial-sheet.js injector is gone", injectorGone, injectorGone);
      // the on-sheet martial panel (V2 combat tab) still renders
      for (const x of game.actors.filter(x => x.name === "RIG Martial Panel")) await x.delete().catch(() => {});   // pre-sweep prior run
      actor = await Actor.create({ name: "RIG Martial Panel", type: "character" });
      await actor.sheet.render(true);
      await waitFor(() => actor.sheet?.element?.querySelector('[data-tab="combat"], .tab[data-tab="combat"], .martial-panel'));
      // switch to combat tab if tabbed
      const root = actor.sheet.element;
      root.querySelector('[data-tab="combat"].item, nav [data-tab="combat"]')?.click?.();
      await waitFor(() => root.querySelector(".martial-panel"));
      ok("live V2 martial panel (.martial-panel) still present", !!root.querySelector(".martial-panel"), !!root.querySelector(".martial-panel"));
    } catch (e) { out.error = e?.stack || e?.message || String(e); }
    finally { try { await actor?.sheet?.close(); } catch {} try { if (actor) await actor.delete(); } catch {} }
    return out;
  });

  if (R.error) { console.error("IN-PAGE ERROR:", R.error); failures++; }
  console.log("Martial-tail cleanup\n" + R.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(46)} got=${c.got}`).join("\n"));
  failures += R.checks.filter(c => !c.pass).length;
  const moduleErrors = errors.filter(e => !/parchment|hardware acceleration/i.test(e));
  console.log(`  [${moduleErrors.length === 0 ? "PASS" : "FAIL"}] no module/martial/template console errors on load  got=${moduleErrors.length}`);
  if (moduleErrors.length) console.log("    " + moduleErrors.slice(0, 5).join("\n    "));
  failures += moduleErrors.length ? 1 : 0;
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
