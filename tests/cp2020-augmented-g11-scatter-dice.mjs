/**
 * G11 Rule 3 — scatter-pack munition dice (MM p.72-73) (:30004, official 1.1.1 + module).
 *
 * The book's ROF column for scatter-packs is a per-hit-target XD6 dice pool: WA decides only WHETHER a
 * target is caught; the XD6 roll decides how many individual munitions struck it (each applying the
 * weapon's Penetration). Those die values were dropped at import (all seeded rof:1). Re-captured as a
 * new `scatterDice` field (BRP 2, BFC-2 3, BFC-3 4, BFC-4 1, BFC-WA 2, BIM 1, BSP 1), exposed on the
 * weapon sheet, and wired: resolveAreaShot rolls XD6 PER hit target and applies the munitions as
 * multiple rounds (the MM p.5 multiple-rounds Penetration aggregation).
 *
 * Behavioural (deterministic via the errata SP-erosion, which uses the effective Pen with no roll): a
 * scatter cone shot strips MORE armour than an identical single-shot cone, because the munition count
 * raises the effective Penetration. Source-shape: the field/catalog/sheet/threading/resolver are present.
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-g11-scatter-dice.mjs
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
    const created = [];
    let scene = null, prevMM, prevVD, prevRS, prevAD;
    try {
      // ---- source-shape ----
      const dsrc = await (await fetch(`${M}/data/vehicle-item-data.js`, { cache: "no-store" })).text();
      ok("data model declares scatterDice field", /scatterDice:\s*numberField\(0\)/.test(dsrc), true);
      const wsrc = await (await fetch(`${M}/vehicle/vehicle-weapons.js`, { cache: "no-store" })).text();
      ok("weapons.js reads scatterDice + threads to cone payload", /const scatterDice = Number\(w\.scatterDice\)/.test(wsrc) && /scatterDice: p\.scatterDice \|\| 0/.test(wsrc), true);
      const asrc = await (await fetch(`${M}/vehicle/vehicle-area.js`, { cache: "no-store" })).text();
      ok("area.js rolls XD6 per target -> extraRounds", /\$\{scatterDice\}d6/.test(asrc) && /extraRounds: Math\.max\(0, munitions - 1\)/.test(asrc), true);
      const sht = await (await fetch(`/modules/cp2020-augmented/templates/item/parts/vehicleWeapon/settings.hbs`, { cache: "no-store" })).text();
      ok("weapon sheet exposes system.scatterDice", /name="system\.scatterDice"/.test(sht), true);
      const enj = await (await fetch(`/modules/cp2020-augmented/lang/en.json`, { cache: "no-store" })).json();
      ok("ScatterDice i18n keys present", ["ScatterDice","ScatterDiceTip"].every(k => k in (enj.CYBERPUNK?.Vehicle ?? {})), true);
      // catalog values (the re-captured book ROF dice)
      const CAT = await import(`${M}/vehicle/vehicle-weapon-catalog.js`);
      const byName = Object.fromEntries((CAT.SEED_VEHICLE_WEAPONS ?? []).map(w => [w.name, Number(w.system?.scatterDice) || 0]));
      const expect = { "BRP Ripple Flechette Pack": 2, "BFC-2 Flechette Cloud": 3, "BFC-3 Flechette Cloud": 4, "BFC-4 Flechette Cloud": 1, "BFC-WA Flechette Cloud": 2, "BIM Minelet Volley": 1, "BSP Variety Show": 1 };
      const mism = Object.entries(expect).filter(([n, v]) => byName[n] !== v).map(([n, v]) => `${n}:${byName[n]}!=${v}`);
      ok("catalog seeds all 7 scatterDice per the book", mism.length === 0, mism.join(",") || "2,3,4,1,2,1,1");

      // ---- behavioural: scatter cone strips MORE armour than a single cone (deterministic erosion) ----
      const { resolveAreaShot } = await import(`${M}/vehicle/vehicle-area.js`);
      prevMM = game.settings.get(SCOPE, "mmEnabled");
      prevVD = game.settings.get(SCOPE, "vehicleDamageEnabled");
      prevRS = game.settings.get(SCOPE, "vehicleRuleSystem");
      prevAD = game.settings.get(SCOPE, "vehicleArmorDamageEnabled");
      await game.settings.set(SCOPE, "mmEnabled", true);
      await game.settings.set(SCOPE, "vehicleDamageEnabled", true);
      await game.settings.set(SCOPE, "vehicleRuleSystem", "MaximumMetal");
      await game.settings.set(SCOPE, "vehicleArmorDamageEnabled", true);

      const mkTank = async (name) => { const a = await Actor.create({ name, type: "cp2020-augmented.vehicle",
        system: { sp: { front: 300, side: 300, rear: 300, top: 300, bottom: 300 }, armorValue: { front: 0 }, bodyValue: 3 } }); created.push(a); return a; };
      const tankScatter = await mkTank("RIG Scatter Target");
      const tankSingle  = await mkTank("RIG Single Target");
      scene = await Scene.create({ name: "RIG Scatter Scene", width: 3000, height: 3000, grid: { size: 100, distance: 3, units: "m" } });
      // actorLink:true → token.actor IS the world actor, so applied damage lands on the actor we read
      // (an unlinked token gets a synthetic delta-actor copy instead).
      await scene.createEmbeddedDocuments("Token", [{ name: "A", actorId: tankScatter.id, actorLink: true, x: 950, y: 650, width: 1, height: 1 }]); // north
      await scene.createEmbeddedDocuments("Token", [{ name: "B", actorId: tankSingle.id,  actorLink: true, x: 950, y: 1250, width: 1, height: 1 }]); // south

      // No firerToken → facing forced to payload.facing ("front"); each narrow cone catches only its target.
      const origin = { x: 1000, y: 1000 };
      const rScatter = await resolveAreaShot({ firerToken: null, origin, scene, shape: { type: "cone", angleDeg: 60, rangeM: 100, dirDeg: -90 },
        payload: { scale: "penetration", facing: "front", penetration: 20, scatterDice: 4, weaponName: "RIG-Scatter" } });
      const rSingle = await resolveAreaShot({ firerToken: null, origin, scene, shape: { type: "cone", angleDeg: 60, rangeM: 100, dirDeg: 90 },
        payload: { scale: "penetration", facing: "front", penetration: 20, scatterDice: 0, extraRounds: 0, weaponName: "RIG-Single" } });
      ok("each cone struck exactly its one target", rScatter.tokens === 1 && rSingle.tokens === 1, `scatter=${rScatter.tokens} single=${rSingle.tokens}`);

      const erosionScatter = 300 - (Number(tankScatter.system?.sp?.front) || 0);
      const erosionSingle  = 300 - (Number(tankSingle.system?.sp?.front)  || 0);
      ok("single-shot cone strips 10 SP (0.5 x Pen 20, HE factor baseline)", erosionSingle === 10, erosionSingle);
      ok("scatter cone strips MORE than the single shot (munitions raise Pen)", erosionScatter > erosionSingle, `scatter=${erosionScatter} single=${erosionSingle}`);
      ok("scatter erosion >= 18 (min 4D6 = 4 munitions -> +3 rounds -> Pen 35)", erosionScatter >= 18, erosionScatter);
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    } finally {
      try { if (scene) await scene.delete(); } catch {}
      for (const d of created.reverse()) { try { await d.delete(); } catch {} }
      try { if (prevMM !== undefined) await game.settings.set(SCOPE, "mmEnabled", prevMM); } catch {}
      try { if (prevVD !== undefined) await game.settings.set(SCOPE, "vehicleDamageEnabled", prevVD); } catch {}
      try { if (prevRS !== undefined) await game.settings.set(SCOPE, "vehicleRuleSystem", prevRS); } catch {}
      try { if (prevAD !== undefined) await game.settings.set(SCOPE, "vehicleArmorDamageEnabled", prevAD); } catch {}
    }
    return out;
  });

  if (R.error) { console.error("IN-PAGE ERROR:", R.error); failures++; }
  console.log("G11 Rule 3 — scatter-pack munition dice\n" + R.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(56)} got=${c.got}`).join("\n"));
  failures += R.checks.filter(c => !c.pass).length;
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
