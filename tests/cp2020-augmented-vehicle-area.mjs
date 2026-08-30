/**
 * Vehicle area placement + containment (:30004, official 1.1.1 + module, core v14).
 *
 * Regression guard for two defects in module/vehicle/vehicle-area.js:
 *
 *   1. The burst and cone VISUALS were written with a direct
 *      `scene.createEmbeddedDocuments("MeasuredTemplate", …)` instead of the core-agnostic
 *      `createArea` shim in module/combat/area-shapes.js. v14 DELETED that embedded document type
 *      (absorbed into Scene Regions), so the write threw on the ship-target core — the same
 *      breakage vehicle-ordnance.js already documents fixing for its gas cloud.
 *
 *   2. The visual placement and the PURE containment filter shared ONE try block whose catch only
 *      logged. A throwing placement therefore left `inside` empty, so an area shot resolved against
 *      NOBODY and reported it as a clean miss — a silent, total loss of the resolution.
 *
 * The legs assert containment BY TOKEN ID (with the outside-the-area tokens as the negative case),
 * the dispatched outcome by value, that the visual document is present on the scene once the shot
 * has resolved and gone after its ~4 s cleanup window, and that a deliberately broken placement
 * still resolves containment (the guard that keeps the two concerns in separate try blocks).
 *
 * Run from tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-vehicle-area.mjs
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
const consoleErrors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + (e?.message || e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push("console: " + m.text()); });
  await joinAs(page, /^gamemaster$/i, [GM_PW]);

  const R = await page.evaluate(async () => {
    const M = "/modules/cp2020-augmented/module";
    const SCOPE = "cp2020-augmented";
    const out = { checks: [], notes: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    const created = [];
    let scene = null;
    const prev = {};
    const SETTINGS = ["mmEnabled", "vehicleRuleSystem", "vehicleArmorDamageEnabled"];
    try {
      const { resolveAreaShot } = await import(`${M}/vehicle/vehicle-area.js`);
      const AS = await import(`${M}/combat/area-shapes.js`);
      const { pxPerMeter } = await import(`${M}/vehicle/vehicle-grid.js`);
      out.notes.push(`core ${game.version} — area backend in use: ${AS.usesRegions() ? "Region" : "MeasuredTemplate"}`);

      // Source-shape guard: the visuals must be emitted through the shim, never written as an
      // embedded document type this file names itself (that is what broke on v14).
      const src = await (await fetch(`${M}/vehicle/vehicle-area.js`, { cache: "no-store" })).text();
      const direct = /createEmbeddedDocuments\(/.test(src);
      ok("area visuals are emitted through the createArea shim, not a self-named embedded type",
        /createArea\(/.test(src) && !direct, direct ? "direct createEmbeddedDocuments still present" : "shim only");

      for (const k of SETTINGS) prev[k] = game.settings.get(SCOPE, k);
      await game.settings.set(SCOPE, "mmEnabled", true);
      await game.settings.set(SCOPE, "vehicleRuleSystem", "MaximumMetal");
      await game.settings.set(SCOPE, "vehicleArmorDamageEnabled", true);

      // Stale fixtures from an aborted earlier run (this suite's own prefix only — other suites'
      // __PW__ fixtures are none of our business).
      for (const a of game.actors.filter((a) => a.name?.startsWith("__PW__ Area"))) await a.delete().catch(() => {});
      for (const s of game.scenes.filter((s) => s.name?.startsWith("__PW__ Area"))) await s.delete().catch(() => {});

      const mkActor = async (name, type, system) => {
        const a = await Actor.create(system ? { name, type, system } : { name, type });
        created.push(a); return a;
      };
      // The burst victim is a vehicle so the dispatched outcome is the deterministic MM SP erosion
      // (no roll); the two negative-case figures only ever need to be candidates.
      const victim = await mkActor("__PW__ Area Burst Victim", "cp2020-augmented.vehicle",
        { sp: { front: 300, side: 300, rear: 300, top: 300, bottom: 300 }, armorValue: { front: 0 }, bodyValue: 3 });
      const bystander = await mkActor("__PW__ Area Outside Bystander", "character");
      const coneVictim = await mkActor("__PW__ Area Cone Victim", "character");

      // Non-active scene: the resolution reads TokenDocument fields, so it works without disturbing
      // whatever scene is on screen. 100 px / 3 m per cell → 33.33 px per metre.
      scene = await Scene.create({ name: "__PW__ Area Scene", width: 3000, height: 3000,
        grid: { size: 100, distance: 3, units: "m" } });
      const ppm = pxPerMeter(scene);
      out.notes.push(`fixture scene: ${ppm.toFixed(2)} px per metre`);
      // One token per call — createEmbeddedDocuments' return order does not track its input order.
      // actorLink:true so token.actor IS the world actor the dispatched damage is read back from.
      const mkTok = async (a, x, y) => (await scene.createEmbeddedDocuments("Token",
        [{ name: a.name, actorId: a.id, actorLink: true, x, y, width: 1, height: 1 }]))[0];
      const origin = { x: 1500, y: 1500 };
      const tVictim = await mkTok(victim, 1500, 1450);      // centre (1550,1500) — 50 px ≈ 1.5 m from origin
      const tBystander = await mkTok(bystander, 1850, 1450); // centre (1900,1500) — 400 px ≈ 12 m from origin
      const tCone = await mkTok(coneVictim, 1450, 1050);     // centre (1500,1100) — 400 px due north of origin

      const areaIds = () => AS.areasByFlag(scene, "vehicleArea").map((h) => h.id);

      /* ---- burst: containment, dispatch, visual present ---- */
      const beforeBurst = areaIds();
      const burst = await resolveAreaShot({ firerToken: null, origin, scene,
        shape: { type: "circle", radiusM: 6 },
        payload: { scale: "penetration", facing: "front", penetration: 20, weaponName: "__PW__ burst" } });
      const afterBurst = areaIds();
      const burstIn = (burst.inside ?? []).map((t) => t.id);
      ok("burst containment returns exactly the token inside the radius",
        burstIn.length === 1 && burstIn[0] === tVictim.id,
        `${burstIn.length} contained (bystander at 12 m excluded: ${!burstIn.includes(tBystander.id)})`);
      ok("the burst dispatched its one contained token",
        (burst.struck ?? []).length === 1 && burst.struck[0]?.id === victim.id, `struck=${(burst.struck ?? []).length}`);
      const erosion = 300 - (Number(victim.system?.sp?.front) || 0);
      ok("the dispatched burst eroded front SP by 10 (0.5 x Pen 20)", erosion === 10, erosion);
      const newBurstArea = afterBurst.filter((id) => !beforeBurst.includes(id));
      ok("the burst visual is present on the scene once the shot has resolved",
        newBurstArea.length === 1,
        `${newBurstArea.length} new area, backend isRegion=${AS.areasByFlag(scene, "vehicleArea")[0]?.isRegion}`);

      /* ---- cone: containment with the two outside figures as the negative case ---- */
      const beforeCone = areaIds();
      const cone = await resolveAreaShot({ firerToken: null, origin, scene, skipDispatch: true,
        shape: { type: "cone", angleDeg: 60, rangeM: 30, dirDeg: -90 }, payload: {} });
      const afterCone = areaIds();
      const coneIn = (cone.inside ?? []).map((t) => t.id);
      ok("cone containment returns exactly the token inside the arc",
        coneIn.length === 1 && coneIn[0] === tCone.id,
        `${coneIn.length} contained (the two off-axis figures excluded: ${!coneIn.includes(tVictim.id) && !coneIn.includes(tBystander.id)})`);
      const newConeArea = afterCone.filter((id) => !beforeCone.includes(id));
      ok("the cone visual is present on the scene once the shot has resolved", newConeArea.length === 1, `${newConeArea.length} new area`);

      /* ---- a failed placement must not zero the resolution ---- */
      const realCreate = scene.createEmbeddedDocuments.bind(scene);
      scene.createEmbeddedDocuments = async (type, data, opts) => {
        if (type === "Region" || type === "MeasuredTemplate") throw new Error("__PW__ forced area-backend failure");
        return realCreate(type, data, opts);
      };
      let broken = null;
      try {
        broken = await resolveAreaShot({ firerToken: null, origin, scene, skipDispatch: true,
          shape: { type: "circle", radiusM: 6 }, payload: {} });
      } finally { delete scene.createEmbeddedDocuments; }
      const brokenIn = (broken?.inside ?? []).map((t) => t.id);
      ok("a failed visual placement still resolves containment (placement and geometry are separate try blocks)",
        brokenIn.length === 1 && brokenIn[0] === tVictim.id, `${brokenIn.length} contained`);

      /* ---- cleanup window ---- */
      await new Promise((r) => setTimeout(r, 4800));
      const leftover = areaIds();
      ok("both area visuals are gone after the ~4 s cleanup window", leftover.length === 0, `${leftover.length} left`);
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    } finally {
      try { if (scene) await scene.delete(); } catch { /* fixture teardown */ }
      for (const d of created.reverse()) { try { await d.delete(); } catch { /* fixture teardown */ } }
      for (const k of SETTINGS) { try { if (prev[k] !== undefined) await game.settings.set(SCOPE, k, prev[k]); } catch { /* restore */ } }
    }
    return out;
  });

  if (R.error) { console.error("IN-PAGE ERROR:", R.error); failures++; }
  console.log("\n===== VEHICLE AREA PLACEMENT + CONTAINMENT =====");
  (R.notes ?? []).forEach((n) => console.log("  • " + n));
  console.log("");
  console.log(R.checks.map((c) => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(78)} got=${c.got}`).join("\n"));
  failures += R.checks.filter((c) => !c.pass).length;

  const errPass = consoleErrors.length === 0;
  console.log(`  [${errPass ? "PASS" : "FAIL"}] ${"0 console errors".padEnd(78)} got=${consoleErrors.length}`);
  if (!errPass) consoleErrors.slice(0, 10).forEach((e) => console.log("        ! " + e));
  if (!errPass) failures++;

  console.log("\n  RESULT: " + (failures === 0
    ? "PASS ✅ — areas place through the shim, containment resolves independently of the visual"
    : `FAIL ❌ — ${failures} failing leg(s)`));
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
