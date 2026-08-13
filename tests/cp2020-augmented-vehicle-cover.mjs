/**
 * KEEPER: a deployed vehicle as a cover object (ruled D1 = derived token cover, D2 = book SP
 * prefills by type, D3 = the debit lands on the vehicle's own structure).
 *
 * Contract under test:
 *  - a line crossing a vehicle's bodywork returns a cover row carrying the vehicle's name and the
 *    body SP for its type (Core p.99: car body 10, armoured/AV 40)
 *  - a line crossing the ENGINE cells returns 35 and says so in the label
 *  - an open frame (cycle) returns no row at all
 *  - a vehicle with no structure left returns no row (a wreck stops being cover)
 *  - the vehicle on the shot is never its own cover: not the one aimed at, not the one the shooter
 *    is riding in
 *  - applying a shot through a vehicle debits its structure by what it absorbed and posts one card
 *  - a typed SP overrides the type's prefill; a vehicle with no printed structure is cover that
 *    cannot be charged
 *
 * Runs on its OWN activated scene and hands the previous one back.
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("console", m => { if (m.type() === "error" && !/compatibility|deprecat|screen resolution|Failed to load resource/i.test(m.text())) errors.push(m.text()); });
page.on("pageerror", e => errors.push(e.message));

await page.goto(`${URL}/join`);
await page.waitForSelector('select[name="userid"]');
await page.evaluate(() => {
  const sel = document.querySelector('select[name="userid"]');
  sel.value = [...sel.options].find(o => /gamemaster/i.test(o.textContent)).value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.fill('input[name="password"]', PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 60000 });

/* ══════════════════════ phase 1: which rows the line returns, and with what SP ══════════════════════ */

const res = await page.evaluate(async (SCOPE) => {
  const out = { checks: [], ids: {}, diag: {} };
  const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });

  for (const app of [...foundry.applications.instances.values()]) {
    if (app.id === "cp-automation-notice") await app.close().catch(() => {});
  }
  out.ids.prevActiveId = game.scenes.active?.id ?? null;
  for (const s of [...game.scenes]) if (s.name?.startsWith("__PWV__")) await s.delete();
  for (const a of [...game.actors]) if (a.name?.startsWith("__PWV__")) await a.delete();

  const [scene] = await Scene.create([{
    name: "__PWV__VehicleCover", width: 4000, height: 3000, padding: 0,
    grid: { size: 100, type: CONST.GRID_TYPES.SQUARE },
  }]);
  await scene.activate();
  for (let i = 0; i < 150 && !(canvas?.ready && canvas.scene?.id === scene.id); i++) await new Promise(r => setTimeout(r, 200));
  out.ids.sceneId = scene.id;

  const cov = await import(`/modules/${SCOPE}/module/combat/cover.js`);
  const vcov = await import(`/modules/${SCOPE}/module/vehicle/vehicle-cover.js`);
  const G = scene.grid.size;
  out.diag.grid = G;

  ok("the spec's own scene starts with no cover on it", cov.coverChoicesFor(null).length === 0,
    String(cov.coverChoicesFor(null).length));

  /* The car: 4 wide x 2 deep at (10G,10G). Its footprint derives an EASTWARD heading, so the engine
     block is the right-hand column (x 13G..14G) and everything left of it is bodywork. */
  const car = await Actor.create({
    name: "__PWV__Sedan", type: `${SCOPE}.vehicle`,
    system: { vehicleType: "car", sdp: { value: 40, max: 40 } },
    prototypeToken: { actorLink: true, width: 4, height: 2 },
  });
  const [carTok] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PWV__Sedan", actorId: car.id, actorLink: true, x: 10 * G, y: 10 * G, width: 4, height: 2,
    flags: { [SCOPE]: { vehicleHandle: true } },
  }]);

  const shooter = await Actor.create({ name: "__PWV__Shooter", type: "character" });
  const victim = await Actor.create({ name: "__PWV__Victim", type: "npc" });
  // Vertical lines: one down the bodywork column (x 11.5G), one down the engine column (x 13.5G).
  const mkTok = async (name, actor, gx, gy) => (await scene.createEmbeddedDocuments("Token", [{
    name, actorId: actor.id, actorLink: true, x: gx * G, y: gy * G, width: 1, height: 1,
  }]))[0];
  const aBody = await mkTok("__PWV__ShooterBody", shooter, 11, 6);
  const tBody = await mkTok("__PWV__VictimBody", victim, 11, 14);
  const aEng = await mkTok("__PWV__ShooterEng", shooter, 13, 6);
  const tEng = await mkTok("__PWV__VictimEng", victim, 13, 14);

  const rowsBody = cov.coverBetween(aBody, tBody);
  ok("a line down the bodywork returns exactly one row", rowsBody.length === 1, rowsBody.map(r => r.label).join(","));
  ok("that row is the vehicle, named", rowsBody[0]?.label === "__PWV__Sedan", String(rowsBody[0]?.label));
  ok("bodywork stops the car-body 10 (Core p.99)", rowsBody[0]?.sp === 10, String(rowsBody[0]?.sp));
  ok("the row carries the vehicle's own structure as its pool", rowsBody[0]?.pool === 40 && rowsBody[0]?.poolMax === 40,
    `${rowsBody[0]?.pool}/${rowsBody[0]?.poolMax}`);
  ok("the row is charged against the vehicle actor", rowsBody[0]?.uuid === car.uuid, String(rowsBody[0]?.uuid));

  const rowsEng = cov.coverBetween(aEng, tEng);
  ok("a line down the engine column stops 35", rowsEng[0]?.sp === 35, String(rowsEng[0]?.sp));
  ok("the engine row says which part was crossed", /engine block/i.test(rowsEng[0]?.label ?? ""), String(rowsEng[0]?.label));
  ok("the engine row leaks no raw key", !/CYBERPUNK\./.test(rowsEng[0]?.label ?? ""), String(rowsEng[0]?.label));

  /* Turning the nose moves the engine: with the nose NORTH the engine is the top row, so the
     bodywork line now crosses it and the engine line does not. */
  await car.update({ "system.layout.front": "n" });
  const turnedBody = cov.coverBetween(aBody, tBody);
  const turnedEng = cov.coverBetween(aEng, tEng);
  ok("with the nose north both lines cross the engine rank", turnedBody[0]?.sp === 35 && turnedEng[0]?.sp === 35,
    `${turnedBody[0]?.sp} / ${turnedEng[0]?.sp}`);
  await car.update({ "system.layout.front": "" });

  /* Type prefills + typed override. */
  await car.update({ "system.vehicleType": "AV-4" });
  ok("an AV prefills the armoured 40", cov.coverBetween(aBody, tBody)[0]?.sp === 40, String(cov.coverBetween(aBody, tBody)[0]?.sp));
  await car.update({ "system.vehicleType": "car", "system.layout.bodySp": 22 });
  ok("a typed SP overrides the type prefill", cov.coverBetween(aBody, tBody)[0]?.sp === 22, String(cov.coverBetween(aBody, tBody)[0]?.sp));
  await car.update({ "system.layout.bodySp": null });
  ok("clearing the field returns to the type prefill", cov.coverBetween(aBody, tBody)[0]?.sp === 10, String(cov.coverBetween(aBody, tBody)[0]?.sp));

  /* An open frame contributes nothing (ruled: bikes are not cover). */
  const bike = await Actor.create({
    name: "__PWV__Bike", type: `${SCOPE}.vehicle`,
    system: { vehicleType: "cycle", sdp: { value: 20, max: 20 } },
    prototypeToken: { actorLink: true, width: 1, height: 2 },
  });
  const [bikeTok] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PWV__Bike", actorId: bike.id, actorLink: true, x: 11 * G, y: 12 * G, width: 1, height: 2,
    flags: { [SCOPE]: { vehicleHandle: true } },
  }]);
  const withBike = cov.coverBetween(aBody, tBody);
  ok("an open frame on the line contributes no row", !withBike.some(r => r.label?.includes("__PWV__Bike")),
    withBike.map(r => r.label).join(","));
  ok("the bike is not offered as cover at all", !vcov.vehicleCoverRowsOn(scene).some(r => r.label === "__PWV__Bike"),
    vcov.vehicleCoverRowsOn(scene).map(r => r.label).join(","));

  /* The shot's own vehicle is never its own cover. */
  await tBody.update({ [`flags.${SCOPE}.boardedVehicle`]: null });
  const asTarget = cov.coverBetween(aBody, carTok);
  ok("shooting AT the vehicle does not make it cover for itself",
    !asTarget.some(r => r.uuid === car.uuid), asTarget.map(r => r.label).join(","));
  await aBody.update({ [`flags.${SCOPE}.boardedVehicle`]: car.id });
  const fromInside = cov.coverBetween(aBody, tBody);
  ok("a shooter riding in the vehicle is not blocked by it",
    !fromInside.some(r => r.uuid === car.uuid), fromInside.map(r => r.label).join(","));
  await aBody.update({ [`flags.${SCOPE}.boardedVehicle`]: null });
  ok("negative case: with nobody aboard the vehicle is cover again",
    cov.coverBetween(aBody, tBody).some(r => r.uuid === car.uuid));

  /* A wreck stops contributing. */
  await car.update({ "system.sdp.value": 0 });
  const wrecked = cov.coverBetween(aBody, tBody);
  ok("a vehicle at 0 structure reads as destroyed", car.system.destroyed === true, String(car.system.destroyed));
  ok("a wreck contributes no cover row", !wrecked.some(r => r.uuid === car.uuid), wrecked.map(r => r.label).join(","));
  await car.update({ "system.sdp.value": 40 });
  ok("negative case: repaired structure restores the row", cov.coverBetween(aBody, tBody).some(r => r.uuid === car.uuid));

  /* No printed structure: cover that cannot be charged. */
  const husk = await Actor.create({
    name: "__PWV__Husk", type: `${SCOPE}.vehicle`,
    system: { vehicleType: "car", sdp: { value: 0, max: 0 } },
    prototypeToken: { actorLink: true, width: 1, height: 1 },
  });
  const huskRow = vcov.vehicleCoverRowsOn(scene);   // token added below only for the row shape check
  const [huskTok] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PWV__Husk", actorId: husk.id, actorLink: true, x: 30 * G, y: 20 * G, width: 1, height: 1,
    flags: { [SCOPE]: { vehicleHandle: true } },
  }]);
  const huskRows = vcov.vehicleCoverRowsOn(scene).filter(r => r.label === "__PWV__Husk");
  ok("a vehicle with no printed structure still provides cover", huskRows.length === 1 && huskRows[0].sp === 10,
    JSON.stringify(huskRows.map(r => ({ sp: r.sp, uuid: r.uuid }))));
  ok("…but carries no uuid, so nothing can be charged to it", huskRows[0]?.uuid === "", String(huskRows[0]?.uuid));
  ok("…and is not read as destroyed", huskRows[0]?.destroyed === false);
  await huskTok.delete();
  await husk.delete();
  void huskRow;

  out.ids = {
    ...out.ids,
    carId: car.id, carUuid: car.uuid, carTokId: carTok.id,
    bikeId: bike.id, bikeTokId: bikeTok.id,
    shooterId: shooter.id, victimId: victim.id,
    aBodyId: aBody.id, tBodyId: tBody.id,
  };
  return out;
}, SCOPE);

for (const c of res.checks) check(c.n, c.p, c.d);
console.log(`  (diag: ${JSON.stringify(res.diag)})`);

/* ══════════════════════ phase 2: applying a shot through the car wears it down ══════════════════════ */

await page.evaluate(async ({ victimId, tBodyId, aBodyId }) => {
  for (const app of [...foundry.applications.instances.values()]) {
    if (app.constructor?.name === "DamageDialog") await app.close().catch(() => {});
  }
  window.__pwMsgBefore = new Set(game.messages.map(m => m.id));
  const { DamageDialog } = await import("/modules/cp2020-augmented/module/combat/DamageDialog.js");
  window.__pwDlg = new DamageDialog(
    { areaDamages: { Torso: [{ damage: 12 }] }, targetTokenId: tBodyId, attackerTokenId: aBodyId, weaponName: "__PWV__Gun" },
    game.actors.get(victimId),
  );
  await window.__pwDlg.render(true);
}, res.ids);
await page.waitForSelector('form.damage-dialog input[name="coverSP"]', { timeout: 15000 });

const seeded = await page.evaluate(() => {
  const root = document.querySelector("form.damage-dialog");
  return {
    sp: root?.querySelector('input[name="coverSP"]')?.value ?? null,
    bdRows: [...root.querySelectorAll(".cp-damage-breakdown-row")].map(r => ({
      label: r.querySelector(".cp-bd-label")?.textContent?.trim() ?? "",
      value: r.querySelector(".cp-bd-value")?.textContent?.trim() ?? "",
    })),
  };
});
check("the apply window seeds Cover SP from the crossed vehicle", seeded.sp === "10", String(seeded.sp));
check("the math line names the vehicle and its SP",
  seeded.bdRows.some(r => r.label === "__PWV__Sedan" && r.value === "[10]"),
  seeded.bdRows.map(r => `${r.label}=${r.value}`).join(" | "));
check("the math line shows the structure the round cost it",
  seeded.bdRows.some(r => r.label === "__PWV__Sedan" && /\d+/.test(r.value) && r.value !== "[10]")
  || seeded.bdRows.filter(r => r.label === "__PWV__Sedan").length === 2,
  seeded.bdRows.filter(r => r.label === "__PWV__Sedan").map(r => r.value).join(" | "));

await page.click('form.damage-dialog button[data-action="applyDamage"]');
await page.waitForTimeout(2500);

const applied = await page.evaluate(({ carId }) => {
  const car = game.actors.get(carId);
  const newMsgs = game.messages.filter(m => !window.__pwMsgBefore.has(m.id));
  const chew = newMsgs.find(m => m.content.includes("cp-cover-chew"));
  return {
    sdp: car.system.sdp.value,
    destroyed: car.system.destroyed,
    chewCard: chew?.content ?? "",
    chewCards: newMsgs.filter(m => m.content.includes("cp-cover-chew")).length,
  };
}, res.ids);
check("the burst debits the vehicle's own structure (40 − 12 = 28)", applied.sdp === 28, String(applied.sdp));
check("the vehicle is not destroyed by a graze", applied.destroyed === false);
check("exactly one chew card is posted", applied.chewCards === 1, String(applied.chewCards));
check("the card names the vehicle and the damage it absorbed",
  applied.chewCard.includes("__PWV__Sedan") && applied.chewCard.includes("12"), applied.chewCard.slice(0, 160));
check("the card reports the structure that is left", applied.chewCard.includes("28"), applied.chewCard.slice(0, 200));
check("the card leaks no raw key", !applied.chewCard.includes("CYBERPUNK."));

/* A burst big enough to finish the car stops covering the rounds behind it. */
const finished = await page.evaluate(async ({ carId, victimId, tBodyId, aBodyId }) => {
  for (const app of [...foundry.applications.instances.values()]) {
    if (app.constructor?.name === "DamageDialog") await app.close().catch(() => {});
  }
  const car = game.actors.get(carId);
  await car.update({ "system.sdp.value": 8 });
  window.__pwMsgBefore2 = new Set(game.messages.map(m => m.id));
  const { DamageDialog } = await import("/modules/cp2020-augmented/module/combat/DamageDialog.js");
  const dlg = new DamageDialog(
    { areaDamages: { Torso: [{ damage: 6 }, { damage: 6 }, { damage: 6 }] }, targetTokenId: tBodyId, attackerTokenId: aBodyId, weaponName: "__PWV__Burst" },
    game.actors.get(victimId),
  );
  await dlg.render(true);
  await new Promise(r => setTimeout(r, 800));
  const rows = [...dlg.element.querySelectorAll(".cp-damage-breakdown-row")]
    .map(r => `${r.querySelector(".cp-bd-label")?.textContent?.trim()}=${r.querySelector(".cp-bd-value")?.textContent?.trim()}`);
  dlg.element.querySelector('button[data-action="applyDamage"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 2500));
  const newMsgs = game.messages.filter(m => !window.__pwMsgBefore2.has(m.id));
  return {
    sdp: game.actors.get(carId).system.sdp.value,
    destroyed: game.actors.get(carId).system.destroyed,
    card: newMsgs.find(m => m.content.includes("cp-cover-chew"))?.content ?? "",
    rows,
  };
}, res.ids);
check("a burst that empties the structure leaves it at 0", finished.sdp === 0, String(finished.sdp));
check("the emptied vehicle reads as destroyed", finished.destroyed === true);
check("the card reports the vehicle giving out", /destroyed|gave out/i.test(finished.card), finished.card.slice(0, 200));
check("the destroyed card leaks no raw key", !finished.card.includes("CYBERPUNK."));

const afterWreck = await page.evaluate(async ({ aBodyId, tBodyId, sceneId, carUuid }) => {
  const cov = await import("/modules/cp2020-augmented/module/combat/cover.js");
  const scene = game.scenes.get(sceneId);
  const rows = cov.coverBetween(scene.tokens.get(aBodyId), scene.tokens.get(tBodyId));
  return { hasCar: rows.some(r => r.uuid === carUuid), labels: rows.map(r => r.label) };
}, res.ids);
check("the wreck no longer stands between the two tokens", afterWreck.hasCar === false, afterWreck.labels.join(","));

/* ══════════════════════════════════ cleanup ══════════════════════════════════ */

await page.evaluate(async ({ sceneId, prevActiveId }) => {
  for (const app of [...foundry.applications.instances.values()]) {
    if (app.constructor?.name === "DamageDialog") await app.close().catch(() => {});
  }
  for (const m of game.messages.filter(x => x.content.includes("__PWV__") || x.content.includes("cp-cover-chew"))) {
    await m.delete().catch(() => {});
  }
  for (const a of [...game.actors]) if (a.name?.startsWith("__PWV__")) await a.delete().catch(() => {});
  const prev = prevActiveId ? game.scenes.get(prevActiveId) : null;
  if (prev) { await prev.activate().catch(() => {}); for (let i = 0; i < 150 && canvas?.scene?.id !== prev.id; i++) await new Promise(r => setTimeout(r, 200)); }
  await game.scenes.get(sceneId)?.delete().catch(() => {});
}, res.ids).catch(e => console.log(`  (cleanup warning: ${e.message})`));

const leftovers = await page.evaluate(({ prevActiveId }) => ({
  probeScenes: game.scenes.filter(s => s.name?.startsWith("__PWV__")).length,
  actors: game.actors.filter(a => a.name?.startsWith("__PWV__")).length,
  activeRestored: (game.scenes.active?.id ?? null) === prevActiveId ? 0 : 1,
}), res.ids);
check("fixtures swept and the previously active scene handed back", Object.values(leftovers).every(v => v === 0), JSON.stringify(leftovers));

const realErrors = errors.filter(e => !/Invalid Asset|Cannot set properties of null \(setting 'volume'\)/i.test(e));
check("0 console errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
