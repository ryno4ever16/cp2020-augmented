/**
 * Group I convention/i18n fixes (:30004, official 1.1.1 + module):
 *  I6 formulaHasDice guards a non-string formula (used to throw on .match).
 *  I2 byName sorts locale-aware (localeCompare), not by UTF-16 code points.
 *  I5 the FNFF2-only martial filter keys on the martial-art KEY (skill name), stable across re-creation,
 *     not the embedded _id (which changes on copy/re-create — the inverse id-match trap).
 *  (I3 dup-registration removed, I4 ammo refund guard, I1 DialogV2 icon class — node-checked / grep-audited.)
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
  await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});

  const R = await page.evaluate(async () => {
    const M = "/modules/cp2020-augmented/module";
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    try {
      const dice = await import(`${M}/dice.js`);
      const ss   = await import(`${M}/actor/skill-sort.js`);
      const lk   = await import(`${M}/lookups.js`);

      // I6 — guarded against non-strings, still detects dice
      ok("I6 formulaHasDice(null)=false (no throw)", dice.formulaHasDice(null) === false, dice.formulaHasDice(null));
      ok("I6 formulaHasDice(2)=false (number)", dice.formulaHasDice(2) === false, dice.formulaHasDice(2));
      ok("I6 formulaHasDice('2d6') truthy", !!dice.formulaHasDice("2d6"), !!dice.formulaHasDice("2d6"));
      ok("I6 formulaHasDice('3') falsy", !dice.formulaHasDice("3"), !!dice.formulaHasDice("3"));

      // I2 — locale-aware: 'apple' sorts before 'Banana' (code-point would put it after)
      const cmp = ss.byName({ name: "apple" }, { name: "Banana" });
      ok("I2 byName locale (apple<Banana)", cmp < 0, cmp);
      ok("I2 byName symmetric (Banana>apple)", ss.byName({ name: "Banana" }, { name: "apple" }) > 0, ss.byName({ name: "Banana" }, { name: "apple" }));
      ok("I2 byName equal=0", ss.byName({ name: "Zed" }, { name: "Zed" }) === 0, ss.byName({ name: "Zed" }, { name: "Zed" }));

      // I5 — FNFF2 filter keys on the martial-art KEY (= skill name), not _id
      ok("I5 KEYS has 'Martial Arts: Te'", lk.FNFF2_ONLY_MARTIAL_ART_KEYS.has("Martial Arts: Te"), true);
      ok("I5 KEYS excludes a non-FNFF2 name", !lk.FNFF2_ONLY_MARTIAL_ART_KEYS.has("Handgun"), false);
    } catch (e) { out.error = e?.stack || e?.message || String(e); }
    return out;
  });

  if (R.error) { console.error("IN-PAGE ERROR:", R.error); failures++; }
  console.log("Group I convention fixes\n" + R.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(38)} got=${c.got}`).join("\n"));
  failures += R.checks.filter(c => !c.pass).length;
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
