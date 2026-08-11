/** "Setup & What's New" notice re-surfacing fix (module/dialog/automation-notice.js). The notice is
 *  gated in damage-hooks.js `_hookAutomationMigrationNotice`: it suppresses only when the world setting
 *  `automationNoticeHide` is true AND `automationNoticeVersion` equals the current module version. A world
 *  that dismissed the notice before the version gate existed carries hide=true + a stale/empty version, so
 *  the gate re-surfaces it on every load. THE BUG: the checkbox rendered the RAW hide flag, so on the
 *  re-surfaced notice it appeared ALREADY TICKED — no change event could fire, the version was never
 *  re-stamped, and the notice returned forever. THE FIX: `_prepareContext` renders
 *  `hideChecked: this._effectivelyDismissed()` (hide && seenVersion === currentVersion) — a re-surfaced
 *  notice draws the box UNTICKED, so ticking it fires change → writes hide + stamps the current version.
 *
 *  On :30004 (v14, ship target) and :30003 (v13): the notice fires from the ready flow, so a fresh page
 *  LOAD is the honest trigger. This keeper (a) snapshots + restores the two world settings, (b) recreates
 *  the broken state (hide=true, version stale) and reloads → asserts the notice RENDERS, (c) THE FIX check:
 *  the `.cp-notice-hide` checkbox is UNCHECKED (fails on the pre-fix rig = the RED), (d) real Playwright
 *  CLICK on the checkbox → asserts hide=true AND version === current module version, (e) reload → notice
 *  suppressed, (f) sanity negative: hide=false → notice renders again. 0 console errors; settings restored
 *  in a finally. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l))||us[0];await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

const checks = [], fails = [];
const check = (n, ok, got) => { checks.push(`${ok?"  PASS":"  FAIL"}  ${n}${ok?"":"  got="+JSON.stringify(got)}`); if(!ok) fails.push(n); };

const waitReady = () => p.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 60000 });
const getS = () => p.evaluate((s) => ({
  hide: game.settings.get(s, "automationNoticeHide"),
  version: game.settings.get(s, "automationNoticeVersion"),
  cur: game.modules.get(s)?.version ?? "",
}), SCOPE);
const setS = (hide, version) => p.evaluate(async ({ s, hide, version }) => {
  await game.settings.set(s, "automationNoticeHide", hide);
  await game.settings.set(s, "automationNoticeVersion", version);
  return true;
}, { s: SCOPE, hide, version });
// Resolves true the moment the notice app appears, false if it never does within `ms` (polls fairly).
const noticePresent = async (ms) => {
  try { await p.waitForFunction(() => !!document.querySelector("#cp-automation-notice"), undefined, { timeout: ms }); return true; }
  catch { return false; }
};

let snap = null;
await joinGM(p);
try {
  // (a) Snapshot the world's current dismissal state — restored in the finally.
  snap = await getS();
  check("current module version resolvable (snapshot has a real version to stamp)", !!snap.cur, snap);

  // ── (b) Recreate the broken pre-gate state and RELOAD (the notice fires from the ready flow) ──
  await setS(true, "0.0.0-stale");
  await p.reload({ waitUntil: "domcontentloaded" });
  await waitReady();
  const renderedB = await noticePresent(8000);
  check("(b) notice RENDERS on load with hide=true + stale version (gate re-surfaces it)", renderedB, null);

  if (!renderedB) {
    // The gate lives in damage-hooks.js and is UNCHANGED by the fix — if it doesn't re-surface here the
    // diagnosis is falsified. Surface loudly and skip the fix-dependent checks rather than force green.
    check("(b) PREREQUISITE MET — notice re-surfaced in the broken state", false, "notice did NOT render; diagnosis falsified — STOP");
  } else {
    // ── (c) THE FIX ASSERTION: the re-surfaced notice draws the hide checkbox UNCHECKED ──
    // (Pre-fix code renders the raw hide flag → CHECKED → this fails = the expected RED.)
    await p.waitForSelector("#cp-automation-notice .cp-notice-hide", { timeout: 8000 });
    const checkedC = await p.evaluate(() => document.querySelector("#cp-automation-notice .cp-notice-hide")?.checked);
    check("(c) FIX: re-surfaced notice renders the hide checkbox UNCHECKED", checkedC === false, { checked: checkedC });

    // ── (d) Real gesture: CLICK the checkbox → change handler writes hide + stamps the version ──
    await p.locator("#cp-automation-notice .cp-notice-hide").click();
    // The change handler calls game.settings.set without awaiting — poll for the writes to land.
    try {
      await p.waitForFunction((s) => {
        const h = game.settings.get(s, "automationNoticeHide");
        const v = game.settings.get(s, "automationNoticeVersion");
        const c = game.modules.get(s)?.version ?? "";
        return h === true && v === c && c !== "";
      }, SCOPE, { timeout: 8000 });
    } catch { /* fall through to value assertions below */ }
    const afterD = await getS();
    check("(d) click sets automationNoticeHide = true", afterD.hide === true, afterD);
    check("(d) click stamps automationNoticeVersion = current module version", afterD.version === afterD.cur && afterD.cur !== "", afterD);

    // ── (e) RELOAD → gate now suppresses (dismissed AND on the current version) ──
    await p.reload({ waitUntil: "domcontentloaded" });
    await waitReady();
    const renderedE = await noticePresent(5000); // poll a few seconds; expect it to STAY absent
    check("(e) after dismissal + reload the notice does NOT render (gate suppresses)", renderedE === false, { rendered: renderedE });
  }

  // ── (f) Sanity negative: with hide=false the unticked-default path still surfaces the notice ──
  await setS(false, snap.version ?? "");
  await p.reload({ waitUntil: "domcontentloaded" });
  await waitReady();
  const renderedF = await noticePresent(8000);
  check("(f) SANITY: with hide=false the notice renders again on load", renderedF, null);
} catch (e) {
  check("no exception during the run", false, String(e?.message ?? e));
} finally {
  // Restore the world's original dismissal state (page is ready after the last reload).
  try { if (snap) await setS(snap.hide, snap.version); } catch { /* best effort */ }
}

for (const line of checks) console.log(line);
const errOk = errors.length === 0;
console.log(`${errOk?"  PASS":"  FAIL"}  0 console errors${errOk?"":"  got="+JSON.stringify(errors.slice(0,6))}`);
const failed = fails.length + (errOk ? 0 : 1);
console.log(`\n${checks.length + 1} checks, ${failed} failed`);
await b.close();
process.exit(failed ? 1 : 0);
