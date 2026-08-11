/**
 * Group G vehicle/ACPA fixes (:30004, official 1.1.1 + module). Verifies:
 *  G3  acpaHitSystem: an SDP-0 system passes damage through (destroyed + full overflow), not an infinite sponge.
 *  G10 mmFailureTable: aircraft altitude-loss metric scales with skidDie (≈15/≈30 m were hardcoded one-die values).
 *  G4  countermeasureModifier + catalog: IR/thermal homing is defeated by flares; catalog no longer tags "infrared".
 *  G7  applyAreaDamages: a cp2020-augmented.vehicle target routes to the vehicle resolver (returns []), not personnel.
 *  G6  ACPA effectiveRef re-derives when the linked pilot's REF changes (updateActor hook).
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-groupg-vehicle-fixes.mjs
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
  await page.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});

  const R = await page.evaluate(async () => {
    const M = "/modules/cp2020-augmented/module";
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    let veh = null, pilot = null, suit = null;
    try {
      // Pre-clean a prior run's leftover GRIG fixtures (non-__PW__ names → not caught by a shared sweep).
      for (const x of game.actors.filter(x => x.name?.startsWith("GRIG "))) await x.delete().catch(() => {});
      const sysMod = await import(`${M}/vehicle/vehicle-acpa-systems.js`);
      const ctrl   = await import(`${M}/vehicle/vehicle-control.js`);
      const mis    = await import(`${M}/vehicle/vehicle-missiles.js`);

      // G3 — SDP-0 pass-through vs normal absorb
      const h0  = sysMod.acpaHitSystem([{ area: "torso", sdp: 0,  sp: 0, sdpDamage: 0, destroyed: false, key: null }], "torso", 10);
      ok("G3 sdp0 destroyed (pass-through)", h0.destroyed === true, h0.destroyed);
      ok("G3 sdp0 overflow=full (10)",       h0.overflow === 10,    h0.overflow);
      const h20 = sysMod.acpaHitSystem([{ area: "torso", sdp: 20, sp: 0, sdpDamage: 0, destroyed: false, key: null }], "torso", 10);
      ok("G3 sdp20 NOT destroyed (10<20)",   h20.destroyed === false, h20.destroyed);
      ok("G3 sdp20 overflow=0 (absorbed)",   h20.overflow === 0,      h20.overflow);

      // G10 — aircraft altitude metric scales with skidDie
      const t5 = ctrl.mmFailureTable(5, { aircraft: true, skidDie: 3 }).text;
      ok("G10 stall feet 150 (3×50)", t5.includes("150 ft"), t5.match(/\d+ ft/)?.[0]);
      ok("G10 stall metric ≈45 m",    t5.includes("≈45 m"),  t5.match(/≈\d+ m/)?.[0]);
      const t7 = ctrl.mmFailureTable(7, { aircraft: true, skidDie: 3 }).text;
      ok("G10 spin feet 300 (3×100)", t7.includes("300 ft"), t7.match(/\d+ ft/)?.[0]);
      ok("G10 spin metric ≈90 m",     t7.includes("≈90 m"),  t7.match(/≈\d+ m/)?.[0]);
      // one-die still reads ≈15/≈30 (backward compatible)
      const t5one = ctrl.mmFailureTable(5, { aircraft: true, skidDie: 1 }).text;
      ok("G10 one-die still ≈15 m",   t5one.includes("≈15 m"), t5one.match(/≈\d+ m/)?.[0]);

      // G4 — thermal defeated by flares (AAM was "infrared" = dead key → 0)
      ok("G4 flares vs thermal = 10", mis.countermeasureModifier(["flares"], "thermal") === 10, mis.countermeasureModifier(["flares"], "thermal"));
      ok("G4 'infrared' is a dead key (0)", mis.countermeasureModifier(["flares"], "infrared") === 0, mis.countermeasureModifier(["flares"], "infrared"));
      const catSrc = await (await fetch(`${M}/vehicle/vehicle-weapon-catalog.js`, { cache: "no-store" })).text();
      ok("G4 catalog no longer tags infrared", !catSrc.includes('homingMethod:"infrared"'), (catSrc.match(/homingMethod:"infrared"/g) || []).length);
      const redKnight = catSrc.split("\n").find(l => l.includes("Red Knight SAM"));
      ok("G4 Red Knight homing=thermal (matches its IR note)", /homingMethod:"thermal"/.test(redKnight || ""), (redKnight || "").match(/homingMethod:"\w+"/)?.[0]);

      // G7 — area damage on a vehicle actor routes to the vehicle resolver (returns [])
      const DA = await import(`${M}/combat/DamageApplicator.js`);
      veh = await Actor.create({ name: "GRIG Area Suit", type: "cp2020-augmented.vehicle", system: { isACPA: true, str: 20 } });
      const res = await DA.applyAreaDamages({ target: veh, areaDamages: { Torso: [{ damage: 15 }] }, ap: false });
      ok("G7 vehicle target routed (empty return)", Array.isArray(res) && res.length === 0, JSON.stringify(res)?.slice(0, 40));

      // G6 — suit effectiveRef re-derives on pilot REF change (updateActor hook)
      pilot = await Actor.create({ name: "GRIG Pilot", type: "character" });
      await pilot.update({ "system.stats.ref.base": 2 });   // ref.total derives from .base (not .value)
      suit = await Actor.create({ name: "GRIG Linked Suit", type: "cp2020-augmented.vehicle", system: { isACPA: true, str: 20, pilotId: pilot.id } });
      const eref0 = suit.system.effectiveRef;
      const pilotRef0 = pilot.system?.stats?.ref?.total;
      await pilot.update({ "system.stats.ref.base": 7 });
      await new Promise(r => setTimeout(r, 400));
      const eref1 = suit.system.effectiveRef;
      const pilotRef1 = pilot.system?.stats?.ref?.total;
      // Exact: default Advanced control (refMod 0, maxRef 10) on STR 20 → effectiveRef = clamp(pilotRef, 0..10).
      ok("G6 pilot ref.total 2→7 (base-derived)", pilotRef0 === 2 && pilotRef1 === 7, `${pilotRef0}->${pilotRef1}`);
      ok("G6 suit effectiveRef 2→7 (clamp(pilotRef+0, 0..10))", eref0 === 2 && eref1 === 7, `${eref0}->${eref1}`);
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    } finally {
      for (const d of [suit, pilot, veh]) { try { if (d) await d.delete(); } catch {} }
    }
    return out;
  });

  if (R.error) { console.error("IN-PAGE ERROR:", R.error); failures++; }
  console.log("Group G vehicle/ACPA fixes\n" + R.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(48)} got=${c.got}`).join("\n"));
  failures += R.checks.filter(c => !c.pass).length;
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
