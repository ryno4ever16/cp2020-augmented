/**
 * F7 — tear-off tab-click no longer swallowed after an off-nav drop (:30004, official 1.1.1 + module).
 *
 * The tear-off gesture set _cpSuppressTabClick=true on any armed release, but the flag is only cleared
 * by the trailing click on the nav. A click fires on the common ancestor of pointerdown+pointerup, so
 * an OFF-nav drop produces no nav-click → the flag lingered and ate the NEXT real tab click. Fixed: only
 * arm the suppress when the release lands on the nav.
 *
 * Behavioural: drive the real gesture. Off-nav armed drop → _cpSuppressTabClick stays false (next click
 * lives). On-nav armed release → still true (the trailing nav-click is correctly suppressed).
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-f7-tearoff-click.mjs
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
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await joinAs(page, /^gamemaster$/i, [GM_PW]);

  const R = await page.evaluate(async () => {
    const M = "/modules/cp2020-augmented/module";
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await new Promise(r => setTimeout(r, 30)); } return false; };
    const closePopouts = async () => { for (const a of foundry.applications.instances.values()) { if (a?.constructor?.name === "CyberpunkActorTabSheet") { try { await a.close(); } catch {} } } };
    let actor = null;
    try {
      const src = await (await fetch(`${M}/actor/actor-sheet.js`, { cache: "no-store" })).text();
      ok("actor-sheet only suppresses on an on-nav release", /const releasedOnNav = /.test(src) && /end\(armed && releasedOnNav\)/.test(src), true);

      for (const x of game.actors.filter(x => x.name === "RIG F7 Tearoff")) await x.delete().catch(() => {});   // pre-sweep prior run
      actor = await Actor.create({ name: "RIG F7 Tearoff", type: "character" });
      await actor.sheet.render(true);
      const sheet = actor.sheet;
      await waitFor(() => sheet.element?.querySelector("nav.sheet-tabs .item[data-tab]"));

      // Drive the real press-and-hold tear-off gesture, releasing either off-nav or on-nav.
      const drive = async (tabIndex, releaseOnNav) => {
        const root = sheet.element;
        const nav = root.querySelector("nav.sheet-tabs");
        const tabs = [...nav.querySelectorAll(".item[data-tab]:not(.cp-tab-detached)")];
        const tab = tabs[tabIndex] ?? tabs[0];
        const r = tab.getBoundingClientRect();
        sheet._cpSuppressTabClick = false;
        tab.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.left + 5, clientY: r.top + 5, button: 0, bubbles: true }));
        await new Promise(res => setTimeout(res, 430));            // let the 375ms arm timer fire (no move before arm)
        document.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + 60, clientY: r.top + 60, bubbles: true }));
        const armed = !!document.querySelector(".cp-tab-ghost");   // ghost appears only once armed
        const upTarget = releaseOnNav ? tab : document.body;
        const upXY = releaseOnNav ? { clientX: r.left + 5, clientY: r.top + 5 } : { clientX: 6, clientY: 6 };
        upTarget.dispatchEvent(new PointerEvent("pointerup", { ...upXY, button: 0, bubbles: true }));
        await new Promise(res => setTimeout(res, 60));
        const suppress = sheet._cpSuppressTabClick;
        await closePopouts();
        return { armed, suppress };
      };

      const off = await drive(0, false);
      ok("gesture armed for the off-nav case (ghost appeared)", off.armed, off.armed);
      ok("off-nav drop leaves _cpSuppressTabClick FALSE (next tab click lives) [F7]", off.suppress === false, off.suppress);

      const on = await drive(1, true);
      ok("gesture armed for the on-nav case", on.armed, on.armed);
      ok("on-nav armed release still suppresses the trailing nav-click", on.suppress === true, on.suppress);
    } catch (e) { out.error = e?.stack || e?.message || String(e); }
    finally { try { await closePopouts(); } catch {} try { await actor?.sheet?.close(); } catch {} try { if (actor) await actor.delete(); } catch {} }
    return out;
  });

  if (R.error) { console.error("IN-PAGE ERROR:", R.error); failures++; }
  console.log("F7 tear-off tab-click\n" + R.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(58)} got=${c.got}`).join("\n"));
  failures += R.checks.filter(c => !c.pass).length;
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
