/**
 * G12(a) — Railgun SP-erosion factor 0.20 (:30004, official 1.1.1 + module).
 *
 * MM errata "ARMOR DAMAGE VIA PENETRATION": SP removed = factor x Pen — Railgun 0.20, HEAT 0.75,
 * AP/DPU 0.60, HE/NORMAL 0.50. Railguns are `ap:true` with no distinct flag, so they used to erode at
 * the 0.60 AP factor (3x too fast). A `railgun` flag now selects 0.20, checked BEFORE the ap branch.
 * A plain unflagged kinetic round keeps 0.50 (the book groups NORMAL with HE).
 *
 * Behavioural: drive the exported applyVehicleDamageMM with armor-damage enabled and assert the SP
 * actually stripped from the struck facing — railgun 0.20xPen vs AP 0.60xPen vs plain 0.50xPen.
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-g12a-railgun-erosion.mjs
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
    const SCOPE = "cp2020-augmented";
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    let veh = null, prevArmor, prevDmg;
    try {
      // ── source-shape: the fix is in the served code ──
      const dmgSrc = await (await fetch(`${M}/vehicle/vehicle-damage.js`, { cache: "no-store" })).text();
      ok("G12a factor branch: railgun -> 0.2 first", /const factor = railgun \? 0\.2 :/.test(dmgSrc), true);
      const modelSrc = await (await fetch(`${M}/data/vehicle-item-data.js`, { cache: "no-store" })).text();
      ok("G12a DataModel declares railgun field", /railgun:\s*booleanField/.test(modelSrc), true);
      const catSrc = await (await fetch(`${M}/vehicle/vehicle-weapon-catalog.js`, { cache: "no-store" })).text();
      ok("G12a 5 railguns tagged railgun:true", (catSrc.match(/railgun:true/g) || []).length === 5, (catSrc.match(/railgun:true/g) || []).length);

      // ── behavioural: drive the resolver with armor-damage on ──
      const VD = await import(`${M}/vehicle/vehicle-damage.js`);
      prevArmor = game.settings.get(SCOPE, "vehicleArmorDamageEnabled");
      prevDmg = game.settings.get(SCOPE, "vehicleDamageEnabled");
      await game.settings.set(SCOPE, "vehicleArmorDamageEnabled", true);
      await game.settings.set(SCOPE, "vehicleDamageEnabled", true);

      veh = await Actor.create({ name: "GRIG Erosion Target", type: "cp2020-augmented.vehicle",
        system: { sp: { front: 100, side: 100, rear: 100, top: 100, bottom: 100 }, bodyValue: 5 } });
      ok("G12a target has sp.front=100 (setup)", Number(veh.system.sp?.front) === 100, JSON.stringify(veh.system.sp));

      const strip = async (flags) => {
        await veh.update({ "system.sp.front": 100 });
        await VD.applyVehicleDamageMM(veh, { basePen: 10, facing: "front", ...flags });
        return 100 - (Number(veh.system.sp?.front) || 0);
      };
      // basePen 10, normal range, no composite/reactive -> effective Pen 10.
      const rgStrip = await strip({ ap: true, railgun: true });   // railgun beats ap -> round(0.20*10)=2
      ok("G12a railgun strips 0.20xPen = 2 (was 6 as AP)", rgStrip === 2, rgStrip);
      const apStrip = await strip({ ap: true });                  // round(0.60*10)=6
      ok("G12a plain AP strips 0.60xPen = 6", apStrip === 6, apStrip);
      const heStrip = await strip({});                            // NORMAL/HE default round(0.50*10)=5
      ok("G12a unflagged kinetic strips 0.50xPen = 5 (NORMAL/HE)", heStrip === 5, heStrip);
      const heatStrip = await strip({ heat: true });              // round(0.75*10)=8 (regression guard)
      ok("G12a HEAT strips 0.75xPen = 8 (unchanged)", heatStrip === 8, heatStrip);
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    } finally {
      try { if (veh) await veh.delete(); } catch {}
      try { if (prevArmor !== undefined) await game.settings.set(SCOPE, "vehicleArmorDamageEnabled", prevArmor); } catch {}
      try { if (prevDmg !== undefined) await game.settings.set(SCOPE, "vehicleDamageEnabled", prevDmg); } catch {}
    }
    return out;
  });

  if (R.error) { console.error("IN-PAGE ERROR:", R.error); failures++; }
  console.log("G12a railgun SP-erosion 0.20\n" + R.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(48)} got=${c.got}`).join("\n"));
  failures += R.checks.filter(c => !c.pass).length;
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
