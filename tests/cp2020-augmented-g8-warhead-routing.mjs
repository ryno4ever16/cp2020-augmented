/**
 * G8 — direct-fire warhead routing (:30004, official 1.1.1 + module).
 *
 * The direct-fire shell mapping used to drop the `warhead` string (WP/cluster/chemical), so an
 * authored special warhead on a direct-fire weapon resolved as a plain-HE blast (latent — no seeded
 * weapon carries one yet). The burst path now routes through resolveWarheadBurst, whose warheadProfile
 * is IDENTITY for plain HE / HEAT — so every seeded direct-fire burst weapon is unchanged, and a
 * WP/cluster/chemical round now resolves its DOT / spread / gas.
 *
 * Verifies:
 *  G8-source  the served module source carries the fix (dead ternary gone; warhead carried + routed).
 *  G8-profile warheadProfile — the resolver the burst path now calls — maps every warhead correctly,
 *             INCLUDING the plain-HE identity case that guarantees no regression for seeded weapons.
 *  G8-load    both edited files import without error.
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-g8-warhead-routing.mjs
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
      // ── G8-source: the served source carries the fix (fetch bypasses the ES-module cache) ──
      const weaponsSrc  = await (await fetch(`${M}/vehicle/vehicle-weapons.js`,  { cache: "no-store" })).text();
      const ordnanceSrc = await (await fetch(`${M}/vehicle/vehicle-ordnance.js`, { cache: "no-store" })).text();

      ok("G8 ordnance dead ternary removed", !ordnanceSrc.includes('w.hiEx ? "" : ""'),
        (ordnanceSrc.match(/w\.hiEx \? "" : ""/g) || []).length);
      ok("G8 ordnance base derives warhead", /warhead: w\.warhead \|\| \(w\.heat \? "heat"/.test(ordnanceSrc), true);
      ok("G8 direct-fire baseShell carries warhead", /warhead: w\.warhead \|\| \(heat \? "heat"/.test(weaponsSrc), true);
      ok("G8 direct-fire variant carries warhead", /warhead: v\.warhead \|\| \(v\.heat \? "heat"/.test(weaponsSrc), true);
      ok("G8 fire payload threads warhead", /warhead: shellSel\.warhead/.test(weaponsSrc), true);
      ok("G8 burst routes through resolveWarheadBurst", weaponsSrc.includes("resolveWarheadBurst"),
        (weaponsSrc.match(/resolveWarheadBurst/g) || []).length);

      // ── G8-profile: the resolver the burst path now calls maps every warhead (incl. identity) ──
      const ind = await import(`${M}/vehicle/vehicle-indirect.js`);
      const wp = ind.warheadProfile("wp", { pen: 0, burstM: 15 });
      ok("G8 wp → DOT (3d6), no Pen", !!wp.dot && wp.pen === 0, JSON.stringify(wp));
      const cl = ind.warheadProfile("cluster", { pen: 6, burstM: 6 });
      ok("G8 cluster → Pen capped 4, burst ×3 (18)", cl.pen === 4 && cl.burstM === 18, JSON.stringify(cl));
      const ch = ind.warheadProfile("chemical", { pen: 0, burstM: 6 });
      ok("G8 chemical → gas cloud, burst ×3 (18)", !!ch.gas && ch.burstM === 18, JSON.stringify(ch));
      const ht = ind.warheadProfile("heat", { pen: 8, burstM: 2 });
      ok("G8 heat → Pen 8, burst 2, heat flag", ht.pen === 8 && ht.burstM === 2 && ht.heat === true, JSON.stringify(ht));
      // The no-regression guarantee: plain HE is IDENTITY — same Pen/burst, no special effect.
      const he = ind.warheadProfile("", { pen: 5, burstM: 6 });
      ok("G8 plain HE identity (Pen 5, burst 6, no effect)",
        he.pen === 5 && he.burstM === 6 && !he.dot && !he.gas && !he.heat && !he.cluster, JSON.stringify(he));

      // ── G8-load: the edited files import without error (ordnance imports indirect + area) ──
      const ord = await import(`${M}/vehicle/vehicle-ordnance.js`);
      ok("G8 ordnance module loaded (resolveWarheadBurst exported)", typeof ord.resolveWarheadBurst === "function", typeof ord.resolveWarheadBurst);
      const wpn = await import(`${M}/vehicle/vehicle-weapons.js`);
      ok("G8 weapons module loaded (openVehicleFireDialog exported)", typeof wpn.openVehicleFireDialog === "function", typeof wpn.openVehicleFireDialog);
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    }
    return out;
  });

  if (R.error) { console.error("IN-PAGE ERROR:", R.error); failures++; }
  console.log("G8 direct-fire warhead routing\n" + R.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(48)} got=${c.got}`).join("\n"));
  failures += R.checks.filter(c => !c.pass).length;
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
