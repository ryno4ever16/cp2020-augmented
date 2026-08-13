/**
 * KEEPER (two-session, cross-client): rider cover — the vehicle you are sitting in as cover for
 * YOU (ruled D4 / layout L3).
 *
 * Contract: a PLAYER opens the real Apply Damage window for a shot at someone riding in a vehicle.
 *  - an ENCLOSED vehicle always shields its rider: the window seeds Cover SP from the crossed
 *    square and shows no note (there was nothing to decide)
 *  - an OPEN one (75% / 50%) is decided per attack: the window states which way it landed, in
 *    words, and the GM can type over it — covered folds the SP in, exposed folds nothing
 *  - a vehicle whose riders are in the open contributes nothing and says nothing
 *  - Apply routes both writes GM-side: the rider takes the damage, the vehicle's own structure
 *    takes what it absorbed, and one chew card is posted
 *
 * The coverage roll is made deterministic by pinning the core's dice source for the duration of
 * each leg — the roll's OUTCOME is what is under test, not the die.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function join(browser, userRe, passwords) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`${URL}/join`);
  await page.waitForSelector('select[name="userid"]');
  const userName = await page.evaluate(re => {
    const sel = document.querySelector('select[name="userid"]');
    const opt = [...sel.options].find(o => new RegExp(re, "i").test(o.textContent));
    if (!opt) return null;
    sel.value = opt.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return opt.textContent.trim();
  }, userRe);
  if (!userName) throw new Error(`no user matching ${userRe}`);
  for (const pw of passwords) {
    await page.fill('input[name="password"]', pw);
    await page.click('button[name="join"]');
    try {
      await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 20000 });
      return { ctx, page, userName };
    } catch { await page.goto(`${URL}/join`); await page.waitForSelector('select[name="userid"]'); }
  }
  throw new Error(`could not join as ${userRe}`);
}

const browser = await chromium.launch();
const gm = await join(browser, "^gamemaster$", [GM_PW]);
const gmErrors = [];
gm.page.on("console", m => { if (m.type() === "error" && !/compatibility|deprecat|screen resolution|Failed to load resource/i.test(m.text())) gmErrors.push(m.text()); });

/* ── GM setup: a car with someone aboard, and a shooter west of it ── */
const setup = await gm.page.evaluate(async (SCOPE) => {
  for (const app of [...foundry.applications.instances.values()]) {
    if (app.id === "cp-automation-notice") await app.close().catch(() => {});
  }
  const prevActiveId = game.scenes.active?.id ?? null;
  for (const s of [...game.scenes]) if (s.name?.startsWith("__PWR__")) await s.delete();
  for (const a of [...game.actors]) if (a.name?.startsWith("__PWR__")) await a.delete();

  const [scene] = await Scene.create([{
    name: "__PWR__RiderCover", width: 4000, height: 3000, padding: 0,
    grid: { size: 100, type: CONST.GRID_TYPES.SQUARE },
  }]);
  await scene.activate();
  for (let i = 0; i < 150 && !(canvas?.ready && canvas.scene?.id === scene.id); i++) await new Promise(r => setTimeout(r, 200));
  const G = scene.grid.size;

  const car = await Actor.create({
    name: "__PWR__Ride", type: `${SCOPE}.vehicle`,
    system: { vehicleType: "car", sdp: { value: 40, max: 40 } },
    prototypeToken: { actorLink: true, width: 4, height: 2 },
  });
  const [carTok] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PWR__Ride", actorId: car.id, actorLink: true, x: 10 * G, y: 10 * G, width: 4, height: 2,
    flags: { [SCOPE]: { vehicleHandle: true } },
  }]);

  const shooter = await Actor.create({ name: "__PWR__Shooter", type: "character" });
  const rider = await Actor.create({ name: "__PWR__Rider", type: "npc" });
  const [aTok] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PWR__ShooterTok", actorId: shooter.id, actorLink: true, x: 5 * G, y: 10 * G, width: 1, height: 1,
  }]);
  const [rTok] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PWR__RiderTok", actorId: rider.id, actorLink: true, x: 30 * G, y: 20 * G, width: 1, height: 1,
  }]);
  const canvasMod = await import(`/modules/${SCOPE}/module/vehicle/vehicle-canvas.js`);
  await canvasMod.boardVehicle(scene.tokens.get(rTok.id), car, carTok);
  // The board move animates the document's position — let it settle before anything reads the line.
  let last = null;
  for (let i = 0; i < 30; i++) {
    const t = scene.tokens.get(rTok.id);
    const now = `${t.x},${t.y}`;
    if (now === last) break;
    last = now;
    await new Promise(r => setTimeout(r, 150));
  }
  const seated = scene.tokens.get(rTok.id);

  return {
    sceneId: scene.id, prevActiveId, grid: G,
    carId: car.id, carUuid: car.uuid, carTokId: carTok.id,
    shooterId: shooter.id, riderId: rider.id, aTokId: aTok.id, rTokId: rTok.id,
    boardedFlag: seated.flags?.[SCOPE]?.boardedVehicle ?? null,
    seatX: seated.x, seatY: seated.y,
    hp0: Number(rider.system.damage) || 0,
    btm: Number(rider.system.stats?.bt?.modifier) || 0,
  };
}, SCOPE);
check("the rider is aboard the car", setup.boardedFlag === setup.carId, String(setup.boardedFlag));
check("the rider sits inside the footprint, clear of the engine column",
  setup.seatX >= 10 * setup.grid && setup.seatX < 13 * setup.grid, `x=${setup.seatX}`);

/* ── the sheet's own control ── */
const sheet = await gm.page.evaluate(async ({ carId }) => {
  const car = game.actors.get(carId);
  await car.sheet.render(true);
  await new Promise(r => setTimeout(r, 900));
  const sel = car.sheet.element.querySelector('select[name="system.layout.riderCover"]');
  const out = {
    present: !!sel,
    values: [...(sel?.options ?? [])].map(o => o.value),
    labels: [...(sel?.options ?? [])].map(o => o.textContent.trim()),
    selected: sel?.value ?? null,
  };
  await car.sheet.close();
  return out;
}, setup);
check("the sheet carries a rider-cover control", sheet.present === true);
check("it offers the by-type default plus the four modes",
  sheet.values.join(",") === ",enclosed,75,50,none", sheet.values.join(","));
check("the by-type option names what the type resolves to", /enclosed/i.test(sheet.labels[0] ?? ""), sheet.labels[0]);
check("a fresh vehicle sits on the by-type default", sheet.selected === "", String(sheet.selected));
check("the control leaks no raw key", !sheet.labels.some(l => l.includes("CYBERPUNK.")), sheet.labels.join(" | "));

/* ── Player session ── */
const pl = await join(browser, "test user 1", ["", GM_PW]);
await pl.page.waitForFunction(id => canvas?.ready && canvas.scene?.id === id, setup.sceneId, { timeout: 30000 });

/** Open the real window on the player's client and read what it decided. */
const openAndRead = async () => {
  await pl.page.evaluate(async ({ riderId, rTokId, aTokId }) => {
    for (const app of [...foundry.applications.instances.values()]) {
      if (app.constructor?.name === "DamageDialog") await app.close().catch(() => {});
    }
    const { DamageDialog } = await import("/modules/cp2020-augmented/module/combat/DamageDialog.js");
    window.__pwDlg = new DamageDialog(
      { areaDamages: { Torso: [{ damage: 12 }] }, targetTokenId: rTokId, attackerTokenId: aTokId, weaponName: "__PWR__Gun" },
      game.actors.get(riderId),
    );
    await window.__pwDlg.render(true);
  }, setup);
  await pl.page.waitForSelector('form.damage-dialog input[name="coverSP"]', { timeout: 15000 });
  return pl.page.evaluate(() => {
    const root = document.querySelector("form.damage-dialog");
    return {
      sp: root.querySelector('input[name="coverSP"]')?.value ?? null,
      // The cover ROW'S OWN LABEL. The per-attack verdict lives in here now (ruled 2026-08-13) rather
      // than in a sentence parked beside the field, so this row reads like every other cover row.
      label: root.querySelector(".cp-cover-note-text")?.textContent?.trim() ?? "",
      afterSp: [...root.querySelectorAll("input.after-sp-override")].map(i => i.value),
    };
  });
};

/** Pin the core's dice source on the player's client (both the Roll path and its fallback). */
const pinDice = (u) => pl.page.evaluate((u) => {
  window.__pwDice = window.__pwDice ?? { uniform: CONFIG.Dice.randomUniform, random: Math.random };
  CONFIG.Dice.randomUniform = () => u;
  Math.random = () => u;
}, u);
const unpinDice = () => pl.page.evaluate(() => {
  if (!window.__pwDice) return;
  CONFIG.Dice.randomUniform = window.__pwDice.uniform;
  Math.random = window.__pwDice.random;
});

const setMode = (mode) => gm.page.evaluate(async ({ carId, mode }) => {
  await game.actors.get(carId).update({ "system.layout.riderCover": mode });
  await new Promise(r => setTimeout(r, 400));
}, { carId: setup.carId, mode });

/* enclosed (the by-type default for a car) */
const enclosed = await openAndRead();
check("an enclosed vehicle shields its rider: SP seeded from the crossed square", enclosed.sp === "10", String(enclosed.sp));
check("nothing was rolled, so the row is named plainly and claims no verdict",
  enclosed.label === "__PWR__Ride", enclosed.label);

/* 75% — covered this attack. The label is asserted WHOLE: this is the shipped wording. */
await setMode("75");
await pinDice(0.001);
const covered = await openAndRead();
check("an open vehicle that covers its rider still folds its SP in", covered.sp === "10", String(covered.sp));
check("the row's own label states the covered verdict, in full",
  covered.label === "__PWR__Ride — covered this attack (75%)", covered.label);
check("the label leaks no raw key", !covered.label.includes("CYBERPUNK."), covered.label);

/* 75% — exposed this attack. No percentage: a roll that went the other way is not a coverage it has. */
await pinDice(0.99);
const exposedRow = await openAndRead();
check("an open vehicle that fails its roll folds no SP", exposedRow.sp === "0", String(exposedRow.sp));
check("the row's own label states the exposed verdict, in full and without odds",
  exposedRow.label === "__PWR__Ride — exposed this attack", exposedRow.label);
check("an exposed rider takes the full roll", exposedRow.afterSp[0] === "12", exposedRow.afterSp.join(","));

/* 50% — the other printed preset, still decided per attack */
await setMode("50");
await pinDice(0.001);
const fifty = await openAndRead();
check("the 50% preset covers on a low roll and names its own odds",
  fifty.sp === "10" && fifty.label === "__PWR__Ride — covered this attack (50%)", `${fifty.sp} / ${fifty.label}`);
await pinDice(0.6);
const fiftyOut = await openAndRead();
check("negative case: 60 beats a 50% chance and the rider is exposed",
  fiftyOut.sp === "0" && fiftyOut.label === "__PWR__Ride — exposed this attack", `${fiftyOut.sp} / ${fiftyOut.label}`);

/* none — an open frame hides nobody, so there is no row to name */
await unpinDice();
await setMode("none");
const none = await openAndRead();
check("a vehicle whose riders are in the open contributes no cover", none.sp === "0", String(none.sp));
check("…and names no row, because no row was picked", none.label === "", none.label);

/* ── the round trip: the covered case, applied, WITH a verdict in play ────────────────────────
   ⛔ The apply is driven at 75% and a forced covered roll rather than on the enclosed default,
   because the thing under test is that the verdict does NOT travel: the row's decorated label is
   for this window, and what a round costs the vehicle is a fact about the vehicle. Applied on
   `enclosed` there would be no verdict to leak and the chew leg below would pass vacuously. */
await setMode("75");
await pinDice(0.001);
const msgIdsBefore = await gm.page.evaluate(() => game.messages.map(m => m.id));
const applyRead = await openAndRead();
check("the window about to be applied is the covered one", applyRead.sp === "10"
  && applyRead.label === "__PWR__Ride — covered this attack (75%)", `${applyRead.sp} / ${applyRead.label}`);
await pl.page.click('.damage-dialog button[data-action="applyDamage"]');
await unpinDice();

const after = await gm.page.evaluate(async ({ riderId, carId, hp0 }) => {
  const read = () => ({
    hp: Number(game.actors.get(riderId)?.system?.damage) || 0,
    sdp: Number(game.actors.get(carId)?.system?.sdp?.value),
  });
  let prev = null, stable = 0;
  for (let i = 0; i < 80; i++) {
    const now = read();
    const moved = now.hp !== hp0 && now.sdp !== 40;
    stable = (prev && now.hp === prev.hp && now.sdp === prev.sdp) ? stable + 1 : 0;
    if (moved && stable >= 3) return now;
    prev = now;
    await new Promise(r => setTimeout(r, 250));
  }
  return { timeout: true, ...read() };
}, setup);
check("both relay writes landed (no timeout)", !after.timeout, JSON.stringify(after));
check("the vehicle's own structure paid for what it stopped (40 − 12 = 28)", after.sdp === 28, String(after.sdp));
const expectedHp = Math.max(1, (12 - 10) - setup.btm);
check("the rider takes only what got through", after.hp - setup.hp0 === expectedHp,
  `delta ${after.hp - setup.hp0}, expected ${expectedHp} (btm ${setup.btm})`);

const card = await gm.page.evaluate(async (before) => {
  const seen = new Set(before);
  for (let i = 0; i < 24; i++) {
    const cards = game.messages.filter(m => !seen.has(m.id) && m.content.includes("cp-cover-chew"));
    if (cards.length) return { count: cards.length, content: cards[cards.length - 1].content };
    await new Promise(r => setTimeout(r, 250));
  }
  return { count: 0, content: "" };
}, msgIdsBefore);
check("exactly one chew card reaches the table", card.count === 1, String(card.count));
check("the card names the vehicle the rider was sitting in", /__PWR__Ride/.test(card.content), card.content.replace(/<[^>]+>/g, " ").slice(0, 160));
// ⛔ THE VERDICT DOES NOT TRAVEL. The window that produced this wear was labelled "…— covered this
// attack (75%)"; what a round cost the vehicle is a fact about the vehicle, so the receipt carries
// the clean name. Anything else reads as "Riot 8 — covered this attack (75%) absorbed 12 damage".
check("the wear receipt carries the vehicle's clean name, with no per-attack verdict on it",
  !/covered this attack|exposed this attack/i.test(card.content),
  card.content.replace(/<[^>]+>/g, " ").slice(0, 200));
check("the card reports the structure left (28 / 40)", /28 \/ 40/.test(card.content), card.content.replace(/<[^>]+>/g, " ").slice(0, 200));

/* ── cleanup + rig hygiene ── */
await gm.page.evaluate(async ({ sceneId, prevActiveId }) => {
  for (const app of [...foundry.applications.instances.values()]) {
    if (app.constructor?.name === "DamageDialog") await app.close().catch(() => {});
  }
  for (const a of [...game.actors]) if (a.name?.startsWith("__PWR__")) await a.delete().catch(() => {});
  for (const m of [...game.messages].filter(x => x.content.includes("__PWR__") || x.content.includes("cp-cover-chew"))) await m.delete().catch(() => {});
  const prev = prevActiveId ? game.scenes.get(prevActiveId) : null;
  if (prev) { await prev.activate().catch(() => {}); for (let i = 0; i < 150 && canvas?.scene?.id !== prev.id; i++) await new Promise(r => setTimeout(r, 200)); }
  await game.scenes.get(sceneId)?.delete().catch(() => {});
}, setup).catch(e => console.log(`  (cleanup warning: ${e.message})`));

const leftovers = await gm.page.evaluate(({ prevActiveId }) => ({
  probeScenes: game.scenes.filter(s => s.name?.startsWith("__PWR__")).length,
  actors: game.actors.filter(a => a.name?.startsWith("__PWR__")).length,
  activeRestored: (game.scenes.active?.id ?? null) === prevActiveId ? 0 : 1,
}), setup);
check("fixtures swept and the previously active scene handed back", Object.values(leftovers).every(v => v === 0), JSON.stringify(leftovers));

check("0 GM console errors", gmErrors.length === 0, gmErrors.slice(0, 3).join(" | "));
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
