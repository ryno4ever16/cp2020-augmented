/**
 * G1 — manual damage dialog warhead controls (:30004, official 1.1.1 + module).
 *
 * The manual vehicle-damage dialog (MM branch) collected Pen/facing/good-shot/rounds/range but NO
 * warhead flags, so a hand-resolved shaped-charge / kinetic hit skipped the armor rules the automated
 * fire path applies. Added HEAT / Hi-Ex / AP / high-density AP / railgun checkboxes, threaded into
 * applyVehicleDamageMM.
 *
 * Behavioural: the flags actually engage the armor rules — HEAT halves Pen vs Composite Armor, plain
 * does not. Source-shape: the dialog collects + passes the flags; the 6 i18n keys are present.
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-g1-manual-warhead.mjs
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
    let veh = null, prevDmg;
    try {
      // source-shape: the dialog collects + passes the flags
      const src = await (await fetch(`${M}/vehicle/vehicle-damage.js`, { cache: "no-store" })).text();
      ok("G1 callback threads heat/hefPenetrator", /heat, hefPenetrator: heat \|\| hiEx/.test(src), true);
      ok("G1 callback threads ap/hda/railgun", /highDensityAP: chk\("#cp-vd-hda"\), railgun: chk\("#cp-vd-rg"\)/.test(src), true);
      const tpl = await (await fetch(`/modules/cp2020-augmented/templates/chat/vehicle/damage-dialog.hbs`, { cache: "no-store" })).text();
      const boxes = ["cp-vd-heat", "cp-vd-hiex", "cp-vd-ap", "cp-vd-hda", "cp-vd-rg"].filter(id => tpl.includes(`id="${id}"`));
      ok("G1 template has all 5 warhead checkboxes", boxes.length === 5, boxes.join(","));
      const enj = await (await fetch(`/modules/cp2020-augmented/lang/en.json`, { cache: "no-store" })).json();
      const need = ["WarheadRow", "WarheadHeat", "WarheadHiEx", "WarheadAP", "WarheadHDAP", "WarheadRailgun"];
      ok("G1 6 warhead i18n keys present", need.every(k => k in (enj.CYBERPUNK?.Vehicle ?? {})), need.filter(k => !(k in (enj.CYBERPUNK?.Vehicle ?? {}))).join(","));

      // behavioural: HEAT engages Composite ½-Pen; plain does not
      const VD = await import(`${M}/vehicle/vehicle-damage.js`);
      prevDmg = game.settings.get(SCOPE, "vehicleDamageEnabled");
      await game.settings.set(SCOPE, "vehicleDamageEnabled", true);
      veh = await Actor.create({ name: "GRIG Composite Tank", type: "cp2020-augmented.vehicle",
        system: { compositeArmor: true, sp: { front: 0 }, bodyValue: 0 } });
      const rHeat = await VD.applyVehicleDamageMM(veh, { basePen: 10, facing: "front", heat: true });
      ok("G1 HEAT halved vs Composite (Pen 10 -> 5)", rHeat?.pen === 5, rHeat?.pen);
      const rPlain = await VD.applyVehicleDamageMM(veh, { basePen: 10, facing: "front", heat: false });
      ok("G1 plain NOT halved vs Composite (Pen 10)", rPlain?.pen === 10, rPlain?.pen);
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    } finally {
      try { if (veh) await veh.delete(); } catch {}
      try { if (prevDmg !== undefined) await game.settings.set(SCOPE, "vehicleDamageEnabled", prevDmg); } catch {}
    }
    return out;
  });

  if (R.error) { console.error("IN-PAGE ERROR:", R.error); failures++; }
  console.log("G1 manual warhead controls\n" + R.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(44)} got=${c.got}`).join("\n"));
  failures += R.checks.filter(c => !c.pass).length;
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
