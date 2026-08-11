/**
 * G11 wiring — minRange (missile arming) + rofAlt (variable fire-rate) rules (:30004, official 1.1.1 + module).
 *
 * These two vehicle-weapon fields were seeded from the book AND editable on the weapon sheet, but no
 * rule consumed them (G11 finding). Wired:
 *   - minRange: a missile fired at a target INSIDE its minimum range (MM p.9) does not arm — it flies
 *     and strikes but the warhead never goes live, so no damage at impact (a "did not arm" card).
 *   - rofAlt: a variable-ROF weapon ("30 OR 5") gets a Fire-rate high/low picker in the fire dialog
 *     that seeds the (still hand-editable) ROF field.
 *
 * Source-shape: the JS reads/threads the fields + the templates carry the controls + i18n keys exist.
 * Behavioural: the arming flag flips correctly (inside/outside min range), the dud missile posts the
 * did-not-arm card and is removed on impact, and the fire dialog shows/omits the ROF-mode picker and
 * seeds the ROF field on change.
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-g11rules-minrange-rofalt.mjs
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
    const waitFor = async (fn, ms = 2500) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await new Promise(r => setTimeout(r, 40)); } return false; };
    const created = [];
    let scene = null, dlgA = null, dlgB = null, prevMM, prevVD, prevRS;
    try {
      // ---- source-shape: JS threads the fields ----
      const wsrc = await (await fetch(`${M}/vehicle/vehicle-weapons.js`, { cache: "no-store" })).text();
      ok("weapons.js reads rofAlt", /const rofAlt = Number\(w\.rofAlt\)/.test(wsrc), true);
      ok("weapons.js builds hasRofAlt + rofModeOptions", /hasRofAlt: rofAlt > 0/.test(wsrc) && /rofModeOptions:/.test(wsrc), true);
      ok("weapons.js render seeds ROF from rofmode", /#cp-vf-rofmode/.test(wsrc) && /rofInEl\.value = rofModeEl\.value/.test(wsrc), true);
      ok("weapons.js reads minRange", /const minRange = Number\(w\.minRange\)/.test(wsrc), true);
      ok("weapons.js threads minRange into payload + launchMissile", /homingMethod, minRange,/.test(wsrc) && /minRange: p\.minRange/.test(wsrc), true);
      const fsrc = await (await fetch(`${M}/vehicle/vehicle-missile-flight.js`, { cache: "no-store" })).text();
      ok("flight.js computes armed from minRange/distM", /const armed = !\(armRange > 0 && distM < armRange\)/.test(fsrc), true);
      ok("flight.js stores armed in flight state", /detected: false, armed,/.test(fsrc), true);
      ok("flight.js impact dud-branch guards on f.armed", /if \(f\.armed === false\)/.test(fsrc), true);
      const fdt = await (await fetch(`/modules/cp2020-augmented/templates/chat/vehicle/fire-dialog.hbs`, { cache: "no-store" })).text();
      ok("fire-dialog.hbs has hasRofAlt-guarded #cp-vf-rofmode", /hasRofAlt/.test(fdt) && /id="cp-vf-rofmode"/.test(fdt), true);
      const mlt = await (await fetch(`/modules/cp2020-augmented/templates/chat/vehicle/missile-launched.hbs`, { cache: "no-store" })).text();
      ok("missile-launched.hbs has unless-armed won't-arm note", /unless armed/.test(mlt) && /MissileWontArm/.test(mlt), true);
      // the v14 render-mechanism fix: neither dialog uses the dead `render:` config; both patch _onRender
      ok("fire dialog patches _onRender (no dead render: config)", /dialog\._onRender = function/.test(wsrc) && !/render: \(event, dlg\)/.test(wsrc), true);
      const csrc = await (await fetch(`${M}/vehicle/vehicle-control.js`, { cache: "no-store" })).text();
      ok("control dialog patches _onRender (no dead render: config)", /dialog\._onRender = function/.test(csrc) && !/render: \(event, dlg\)/.test(csrc), true);
      const enj = await (await fetch(`/modules/cp2020-augmented/lang/en.json`, { cache: "no-store" })).json();
      const need = ["RofMode", "RofModeTip", "RofHigh", "RofLow", "MissileWontArm", "MissileDudTitle", "MissileDudBody"];
      ok("all 7 new i18n keys present", need.every(k => k in (enj.CYBERPUNK?.Vehicle ?? {})), need.filter(k => !(k in (enj.CYBERPUNK?.Vehicle ?? {}))).join(",") || "all");

      prevMM = game.settings.get(SCOPE, "mmEnabled");
      prevVD = game.settings.get(SCOPE, "vehicleDamageEnabled");
      prevRS = game.settings.get(SCOPE, "vehicleRuleSystem");
      await game.settings.set(SCOPE, "mmEnabled", true);
      await game.settings.set(SCOPE, "vehicleDamageEnabled", true);
      await game.settings.set(SCOPE, "vehicleRuleSystem", "MaximumMetal");

      // ================= Rule 2 — rofAlt fire-rate picker =================
      const VW = await import(`${M}/vehicle/vehicle-weapons.js`);
      const actorA = await Actor.create({ name: "RIG RofAlt Tank", type: "cp2020-augmented.vehicle" }); created.push(actorA);
      const [wA] = await actorA.createEmbeddedDocuments("Item", [{ name: "Autocannon", type: "cp2020-augmented.vehicleWeapon", system: { weaponClass: "directFire", penetration: 5, rof: 30, rofAlt: 5, shellVariants: [{ name: "HEAT", pen: 12, burst: 0, heat: true }] } }]);
      dlgA = await VW.openVehicleFireDialog(actorA, { itemId: wA.id });
      await waitFor(() => dlgA?.element?.querySelector("#cp-vf-rof"));
      const rmA = dlgA?.element?.querySelector("#cp-vf-rofmode");
      ok("rofAlt weapon: fire dialog shows #cp-vf-rofmode", !!rmA, !!rmA);
      const optVals = rmA ? [...rmA.querySelectorAll("option")].map(o => o.value) : [];
      ok("rofmode has high(30)+low(5) options", optVals.length === 2 && optVals.includes("30") && optVals.includes("5"), optVals.join(","));
      // selecting the low rate seeds the (editable) ROF field
      if (rmA) { rmA.value = "5"; rmA.dispatchEvent(new Event("change", { bubbles: true })); }
      const rofField = dlgA?.element?.querySelector("#cp-vf-rof");
      ok("choosing Low seeds ROF field to 5", rofField?.value === "5", rofField?.value);
      // mechanism fix ALSO repairs shell->Pen seeding (the real correctness bug): base Pen 5 -> HEAT Pen 12
      const shSel = dlgA?.element?.querySelector("#cp-vf-shell");
      const penField = dlgA?.element?.querySelector("#cp-vf-pen");
      if (shSel) { shSel.value = "1"; shSel.dispatchEvent(new Event("change", { bubbles: true })); }
      ok("shell change now seeds Pen field (render-mechanism fix)", penField?.value === "12", penField?.value);

      const actorB = await Actor.create({ name: "RIG NoAlt Tank", type: "cp2020-augmented.vehicle" }); created.push(actorB);
      const [wB] = await actorB.createEmbeddedDocuments("Item", [{ name: "Laser", type: "cp2020-augmented.vehicleWeapon", system: { weaponClass: "directFire", penetration: 4, rof: 1, rofAlt: 0 } }]);
      dlgB = await VW.openVehicleFireDialog(actorB, { itemId: wB.id });
      await waitFor(() => dlgB?.element?.querySelector("#cp-vf-rof"));
      ok("rofAlt=0 weapon: NO #cp-vf-rofmode (scoped to its dialog)", !dlgB?.element?.querySelector("#cp-vf-rofmode"), !!dlgB?.element?.querySelector("#cp-vf-rofmode"));
      try { await dlgA?.close(); } catch {} dlgA = null;
      try { await dlgB?.close(); } catch {} dlgB = null;

      // ================= Rule 1 — minRange arming =================
      const FL = await import(`${M}/vehicle/vehicle-missile-flight.js`);
      const dummy = await Actor.create({ name: "RIG Missile Dummy", type: "npc" }); created.push(dummy);
      scene = await Scene.create({ name: "RIG Missile Scene", width: 3000, height: 3000, grid: { size: 100, distance: 3, units: "m" } });
      // shooter + target ~1000px apart (finite metres); minRange controls arming.
      const [shDoc] = await scene.createEmbeddedDocuments("Token", [{ name: "Shooter", actorId: dummy.id, x: 100, y: 100, width: 1, height: 1 }]);
      const [tgDoc] = await scene.createEmbeddedDocuments("Token", [{ name: "Target", actorId: dummy.id, x: 1100, y: 100, width: 1, height: 1 }]);

      const msgCountBefore = game.messages.size;
      // DUD: fired inside a huge minimum range → won't arm.
      const dud = await FL.launchMissile({ scene, shooterToken: shDoc, targetToken: tgDoc, missile: { weaponName: "RIG-Dud", penetration: 6, minRange: 1e9 } });
      ok("dud launch returned a missile token", !!dud, !!dud);
      ok("dud missile flight.armed === false", dud?.flags?.[SCOPE]?.missile?.armed === false, dud?.flags?.[SCOPE]?.missile?.armed);
      const recent = game.messages.contents.slice(msgCountBefore).map(m => m.content || "").join(" || ");
      ok("dud launch card shows the won't-arm note", /will not arm/i.test(recent), /will not arm/i.test(recent));

      // ARMED: target outside a small minimum range (distM >> 1) → arms.
      const arm = await FL.launchMissile({ scene, shooterToken: shDoc, targetToken: tgDoc, missile: { weaponName: "RIG-Arm", penetration: 6, minRange: 1 } });
      ok("armed missile (minRange 1, far target) flight.armed === true", arm?.flags?.[SCOPE]?.missile?.armed === true, arm?.flags?.[SCOPE]?.missile?.armed);
      // NO min range at all (minRange 0) → arms.
      const arm0 = await FL.launchMissile({ scene, shooterToken: shDoc, targetToken: tgDoc, missile: { weaponName: "RIG-Arm0", penetration: 6, minRange: 0 } });
      ok("no-min-range missile (minRange 0) flight.armed === true", arm0?.flags?.[SCOPE]?.missile?.armed === true, arm0?.flags?.[SCOPE]?.missile?.armed);

      // Drive the DUD to impact → posts the did-not-arm card + removes the token (no damage branch taken).
      if (dud) await FL.advanceOneMissile(scene, dud.id);
      const dudGone = dud ? !scene.tokens.get(dud.id) : false;
      ok("dud missile removed after impact step", dudGone, dudGone);
      const afterImpact = game.messages.contents.slice(msgCountBefore).map(m => m.content || "").join(" || ");
      ok("dud impact posted the DID NOT ARM card", /did not arm/i.test(afterImpact), /did not arm/i.test(afterImpact));
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    } finally {
      try { await dlgA?.close(); } catch {}
      try { await dlgB?.close(); } catch {}
      try { if (scene) { const rest = scene.tokens.filter(t => t.flags?.[SCOPE]?.missile).map(t => t.id); if (rest.length) await scene.deleteEmbeddedDocuments("Token", rest); } } catch {}
      try { if (scene) await scene.delete(); } catch {}
      try { const proxy = game.actors?.find(a => a.getFlag?.(SCOPE, "missileProxy")); if (proxy) await proxy.delete(); } catch {}
      for (const d of created.reverse()) { try { await d.delete(); } catch {} }
      try { if (prevMM !== undefined) await game.settings.set(SCOPE, "mmEnabled", prevMM); } catch {}
      try { if (prevVD !== undefined) await game.settings.set(SCOPE, "vehicleDamageEnabled", prevVD); } catch {}
      try { if (prevRS !== undefined) await game.settings.set(SCOPE, "vehicleRuleSystem", prevRS); } catch {}
    }
    return out;
  });

  if (R.error) { console.error("IN-PAGE ERROR:", R.error); failures++; }
  console.log("G11 wiring — minRange arming + rofAlt fire-rate\n" + R.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(52)} got=${c.got}`).join("\n"));
  failures += R.checks.filter(c => !c.pass).length;
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
