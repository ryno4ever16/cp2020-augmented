/**
 * KEEPER (two-session, cross-client): the vehicle item↔actor LINK as a state machine, the
 * per-handle rider linkage, and the two sheet-readability fixes that ship with them.
 *
 * ⛔ THE FIELD REPORT THIS EXISTS AGAINST (2026-08-25), verbatim in shape:
 *   "I deployed bittertestactor's truck as the GM. It deployed. Then I went to her character and
 *    deployed (button was not flipped to open). It sent the request. Request approved. Two trucks in
 *    sidebar for GM, one for Bitter. Now says open on both clients. Deleted both trucks. Button
 *    stays as 'open' and is dead until sheet reopened."
 * …plus: a player's own deploy left the row on Deploy for the whole approval round trip and took a
 * second request happily.
 * …plus a second report the same day: two tokens of ONE vehicle actor on one canvas, and boarding
 * one of them linked the riders to the OTHER — moving the empty copy dragged the loaded copy's crew
 * out of it.
 *
 * Every leg below is an OUTCOME by value, and every one of them is driven on the client that would
 * actually see it. Presence legs would have passed against the broken build.
 *
 * Sections
 *   A  pure values — the link is the ITEM's, ownership is one answer for both paths, pending ages
 *   B  the exact repro: GM deploys a PLAYER'S vehicle → ONE actor, she owns it, HER row flips
 *   C  she presses Deploy anyway → refused by name, no dialog, still one actor
 *   D  her own request → the row reads pending from the instant it is sent and refuses a second
 *   E  the vehicle is deleted → both clients' open rows revert to Deploy LIVE, nothing reopened
 *   F  an Open button pointing at nothing is never dead — it says so and repaints
 *   G  two handles of one vehicle: each carries ITS OWN riders, counts its own badge, claims its
 *      own seats; a legacy actor-only flag resolves to exactly one of them
 *   H  the ACC / DEC tooltips on both sheets state the step in this vehicle's own figures
 *   I  crew and passengers are read as one capacity row on both sheets
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const SHOT_DIR = process.env.SHOT_DIR ?? ".";
const SCOPE = "cp2020-augmented";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

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

/**
 * Read one client's rendered Deploy row for an item, WITHOUT re-rendering it — the whole complaint
 * is about what an ALREADY-OPEN sheet says, so nothing here may repaint it.
 * Declared as a real function (Playwright serializes it); it never runs in Node.
 */
/* eslint-disable no-undef */
const ROW_READER = (uuid) => {
  const app = [...foundry.applications.instances.values()]
    .find(x => (x.document ?? x.item)?.uuid === uuid && x.rendered);
  const root = app?.element ?? null;
  if (!root) return { open: false, deploy: false, disabled: null, label: "", rendered: false };
  const openBtn = root.querySelector(".cp-vehicle-open");
  const deployBtn = root.querySelector(".cp-vehicle-deploy");
  const field = (openBtn ?? deployBtn)?.closest(".field") ?? null;
  return {
    rendered: true,
    open: !!openBtn,
    deploy: !!deployBtn,
    disabled: deployBtn ? deployBtn.disabled : null,
    actorId: openBtn?.dataset?.actorId ?? "",
    label: field?.querySelector("label")?.textContent?.trim() ?? "",
  };
};
/* eslint-enable no-undef */

const browser = await chromium.launch();
const gmErrors = [], plErrors = [];

// ---------- GM session ----------
const gm = await join(browser, "^gamemaster$", [GM_PW]);
gm.page.on("console", m => { if (m.type() === "error") gmErrors.push(m.text()); });
gm.page.on("pageerror", e => gmErrors.push(e.message));

const setup = await gm.page.evaluate(async SCOPE => {
  const player = game.users.find(u => !u.isGM && /test user 1/i.test(u.name)) ?? game.users.find(u => !u.isGM);
  if (!player) return { error: "no player user" };
  const activeBefore = game.scenes.active?.id ?? null;

  for (const a of [...game.actors]) if (a.name.startsWith("__PWL__")) await a.delete();
  for (const i of [...game.items]) if (i.name.startsWith("__PWL__")) await i.delete();
  for (const s of [...game.scenes]) if (s.name === "__PWL__Scene") await s.delete();

  const driver = await Actor.create({
    name: "__PWL__Driver", type: "character",
    ownership: { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
  });
  const scene = await Scene.create({
    name: "__PWL__Scene", width: 4000, height: 4000, grid: { size: 100 },
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
  });
  const [anchorTok] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PWL__Driver", actorId: driver.id, actorLink: true, x: 500, y: 500, width: 1, height: 1,
    texture: { src: "icons/svg/mystery-man.svg" },
  }]);

  // Two carried pink slips with a STATED stat block, so the legs pin literals rather than
  // recomputing an oracle from the code under test.
  const shape = (name) => ({
    name, type: "vehicle",
    system: {
      vehicleType: "Truck", sp: 10, sdp: { value: 0, max: 40 },
      speed: { value: 0, max: 120, maneuver: 60, acceleration: 18, deceleration: 30, unit: "mph" },
      crew: 2, passengers: 4, body: 5,
    },
  });
  const [itemA, itemB, itemC] = await driver.createEmbeddedDocuments("Item",
    [shape("__PWL__TruckA"), shape("__PWL__TruckB"), shape("__PWL__TruckC")]);
  // A third slip with NO deceleration recorded — the brake-falls-back-to-ACC tooltip case.
  await itemC.update({ "system.speed.deceleration": 0 });

  return {
    playerId: player.id, playerName: player.name, driverId: driver.id, activeBefore,
    sceneId: scene.id, grid: scene.grid.size, anchorTokenId: anchorTok.id,
    itemA: itemA.uuid, itemB: itemB.uuid, itemC: itemC.uuid,
    stated: { acc: 18, dec: 30, crew: 2, passengers: 4, unit: "mph" },
    stamped: {
      acc: Number(itemA.system.speed?.acceleration), dec: Number(itemA.system.speed?.deceleration),
      crew: Number(itemA.system.crew), passengers: Number(itemA.system.passengers),
      accC: Number(itemC.system.speed?.acceleration), decC: Number(itemC.system.speed?.deceleration),
    },
  };
}, SCOPE);
if (setup.error) { console.log("SETUP FAILED:", setup.error); process.exit(1); }
check("fixture guard: the carried pink slip really states ACC 18 / DEC 30 and 2 crew / 4 passengers",
  setup.stamped.acc === 18 && setup.stamped.dec === 30
  && setup.stamped.crew === 2 && setup.stamped.passengers === 4, JSON.stringify(setup.stamped));
check("fixture guard: the third slip records NO deceleration",
  setup.stamped.accC === 18 && setup.stamped.decC === 0, JSON.stringify(setup.stamped));

// ---------- player session ----------
const pl = await join(browser, "test user 1", ["", GM_PW]);
pl.page.on("console", m => { if (m.type() === "error") plErrors.push(m.text()); });
pl.page.on("pageerror", e => plErrors.push(e.message));
for (const s of [gm, pl]) {
  await s.page.evaluate(() => {
    window.__pwNotes = [];
    for (const kind of ["info", "warn", "error"]) {
      const orig = ui.notifications[kind].bind(ui.notifications);
      ui.notifications[kind] = (msg, ...rest) => { window.__pwNotes.push({ kind, msg: String(msg) }); return orig(msg, ...rest); };
    }
  });
}
await pl.page.evaluate(async ({ sceneId, anchorTokenId }) => {
  await game.scenes.get(sceneId).view();
  for (let i = 0; i < 50 && canvas.scene?.id !== sceneId; i++) await new Promise(r => setTimeout(r, 200));
  for (let i = 0; i < 50 && !canvas.tokens.get(anchorTokenId); i++) await new Promise(r => setTimeout(r, 200));
  canvas.tokens.get(anchorTokenId)?.control({ releaseOthers: true });
}, setup);

/* ══ A — pure values ═══════════════════════════════════════════════════════════════════════ */
// Fail-SOFT wrapper: on a build missing any of this section's entry points every leg must go RED
// with the reason attached, not take the run down before it has reported anything.
const unit = await gm.page.evaluate(async ({ itemA, playerId, driverId }) => {
 try {
  const D = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-deploy-request.js`);
  const item = await fromUuid(itemA);
  const gmId = game.user.id;
  const ownGm = D.deployOwnershipFor(item, gmId);
  const ownPl = D.deployOwnershipFor(item, playerId);
  // A loose world item with no carrier: only the requester, and only when they are a player.
  const loose = await Item.create({ name: "__PWL__Loose", type: "vehicle" });
  const ownLooseGm = D.deployOwnershipFor(loose, gmId);
  const ownLoosePl = D.deployOwnershipFor(loose, playerId);
  await loose.delete();
  return {
    ownGm, ownPl, ownLooseGm, ownLoosePl, playerId, gmId,
    carrierIsDriver: item.parent?.id === driverId,
    pendingFresh: D.deployRequestPending(item),
    linkedNow: D.findDeployedVehicleActor(item)?.id ?? null,
  };
 } catch (e) { return { error: String(e?.message ?? e), ownGm: {}, ownPl: {}, ownLooseGm: {}, ownLoosePl: {}, playerId, gmId: game.user.id }; }
}, setup);
if (unit.error) console.log(`  info: section A entry points unavailable — ${unit.error}`);
check("A the item's carrier owner gets OWNER even when the GM is the one deploying",
  unit.ownGm[unit.playerId] === 3, JSON.stringify(unit.ownGm));
// ⚠ The three legs below would read TRUE against an EMPTY answer, so each one is explicitly
// conditioned on the section having produced an answer at all (vacuous-leg audit, 2026-08-16).
check("A the GM is never given an ownership entry (they own everything already)",
  !unit.error && unit.ownGm[unit.gmId] === undefined && unit.ownPl[unit.gmId] === undefined,
  unit.error ?? JSON.stringify({ gm: unit.ownGm, pl: unit.ownPl }));
check("A a player requester and a GM requester produce the SAME ownership for the same item",
  !unit.error && Object.keys(unit.ownGm).length > 0
  && JSON.stringify(unit.ownGm) === JSON.stringify(unit.ownPl),
  unit.error ?? JSON.stringify(unit.ownPl));
check("A NEGATIVE: a loose item with no carrier grants nothing to a GM deploy",
  !unit.error && Object.keys(unit.ownLooseGm).length === 0,
  unit.error ?? JSON.stringify(unit.ownLooseGm));
check("A NEGATIVE: a loose item deployed by a player grants exactly that player",
  Object.keys(unit.ownLoosePl).length === 1 && unit.ownLoosePl[unit.playerId] === 3,
  JSON.stringify(unit.ownLoosePl));
check("A NEGATIVE: nothing is pending and nothing is linked before anyone clicks",
  unit.pendingFresh === false && unit.linkedNow === null,
  `pending=${unit.pendingFresh} linked=${unit.linkedNow}`);

/* ══ B — the exact repro: the GM deploys a PLAYER'S vehicle ════════════════════════════════ */
// Both clients have the pink slip open BEFORE anything happens — the whole complaint is about what
// an already-open sheet says.
for (const s of [gm, pl]) {
  await s.page.evaluate(async (uuid) => {
    const item = await fromUuid(uuid);
    await item.sheet.render(true);
    await new Promise(r => setTimeout(r, 800));
  }, setup.itemA);
}
const beforeGm = await gm.page.evaluate(ROW_READER, setup.itemA);
const beforePl = await pl.page.evaluate(ROW_READER, setup.itemA);
check("B both clients open on the Deploy state",
  beforeGm.deploy && !beforeGm.open && beforePl.deploy && !beforePl.open,
  `gm=${JSON.stringify(beforeGm)} pl=${JSON.stringify(beforePl)}`);

await gm.page.evaluate(async (uuid) => {
  const item = await fromUuid(uuid);
  const m = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-deploy-request.js`);
  window.__pwDeploy = m.requestVehicleDeploy(item);
}, setup.itemA);
await gm.page.waitForSelector('.cp-vehicle-deploy-name input[name="cp-deploy-name"]', { timeout: 10000 });
await gm.page.fill('.cp-vehicle-deploy-name input[name="cp-deploy-name"]', "__PWL__GM Truck");
await gm.page.click('.cp-vehicle-deploy-name button[data-action="ok"]');

const landedPl = await pl.page.waitForFunction(({ playerId }) => {
  const a = game.actors.find(x => x.name === "__PWL__GM Truck");
  return a ? { id: a.id, own: a.ownership?.[playerId] ?? 0, isOwner: a.isOwner } : null;
}, setup, { timeout: 15000 }).then(h => h.jsonValue()).catch(() => null);
check("B the GM's deploy of her truck reaches her client as an actor she OWNS",
  landedPl?.own === 3 && landedPl?.isOwner === true, JSON.stringify(landedPl));

// …and HER open sheet flips, live, with nothing reopened. That is the reported defect.
const flippedPl = await pl.page.waitForFunction(uuid => {
  const app = [...foundry.applications.instances.values()]
    .find(x => (x.document ?? x.item)?.uuid === uuid && x.rendered);
  return app?.element?.querySelector(".cp-vehicle-open") ? true : null;
}, setup.itemA, { timeout: 10000 }).then(() => true).catch(() => false);
const afterPl = await pl.page.evaluate(ROW_READER, setup.itemA);
const afterGm = await gm.page.evaluate(ROW_READER, setup.itemA);
check("B her open sheet flips to Open LIVE — no reopen", flippedPl === true);
check("B her row names the vehicle and offers Open, not Deploy",
  afterPl.open && !afterPl.deploy && afterPl.label.includes("__PWL__GM Truck"), JSON.stringify(afterPl));
check("B the GM's row says the same thing", afterGm.open && !afterGm.deploy, JSON.stringify(afterGm));
check("B both rows point at the SAME actor", afterPl.actorId === afterGm.actorId && !!afterPl.actorId,
  `${afterPl.actorId} vs ${afterGm.actorId}`);
const countB = await gm.page.evaluate(() =>
  game.actors.filter(a => a.type === "cp2020-augmented.vehicle" && a.name.startsWith("__PWL__")).length);
check("B exactly ONE vehicle exists", countB === 1, String(countB));

/* ══ C — she presses Deploy anyway ═════════════════════════════════════════════════════════ */
const anyway = await pl.page.evaluate(async (uuid) => {
  window.__pwNotes.length = 0;
  const item = await fromUuid(uuid);
  const m = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-deploy-request.js`);
  // ⚠ RACED, never plainly awaited. A build that does NOT refuse the second deploy opens the name
  // dialog and this promise then waits on a human forever — which is the defect, so it has to red
  // rather than wedge the run.
  await Promise.race([m.requestVehicleDeploy(item), new Promise(r => setTimeout(r, 2000))]);
  return {
    dialog: !!document.querySelector(".cp-vehicle-deploy-name"),
    notes: window.__pwNotes.map(n => n.msg),
    count: game.actors.filter(a => a.type === "cp2020-augmented.vehicle" && a.name.startsWith("__PWL__")).length,
  };
}, setup.itemA);
check("C a second deploy of an already-deployed pink slip opens NO name dialog", !anyway.dialog);
check("C it says which vehicle already exists, by name",
  anyway.notes.some(m => m.includes("__PWL__GM Truck")), JSON.stringify(anyway.notes));
check("C still exactly one vehicle — the two-truck outcome is gone", anyway.count === 1, String(anyway.count));
// A build that DID open the dialog leaves it standing; clear it so the next section starts clean.
await pl.page.evaluate(async () => {
  for (const app of [...foundry.applications.instances.values()]) {
    if (app.element?.classList?.contains("cp-vehicle-deploy-name")) await app.close().catch(() => {});
  }
  await new Promise(r => setTimeout(r, 400));
});

/* ══ D — her OWN request: the pending state ════════════════════════════════════════════════ */
// ⭐ Driven through the REAL control this time, not the API: the row's state is what a player who
// pressed the button sees, and the wiring between the two is half of what this section certifies.
const pressed = await pl.page.evaluate(async (uuid) => {
  const item = await fromUuid(uuid);
  await item.sheet.render(true);
  await new Promise(r => setTimeout(r, 900));
  const btn = item.sheet.element?.querySelector(".cp-vehicle-deploy");
  if (!btn) return { pressed: false };
  btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return { pressed: true };
}, setup.itemB);
check("D the Deploy control is present and takes a real click", pressed.pressed === true);
await pl.page.waitForSelector('.cp-vehicle-deploy-name input[name="cp-deploy-name"]', { timeout: 10000 });
await pl.page.fill('.cp-vehicle-deploy-name input[name="cp-deploy-name"]', "__PWL__Her Truck");
await pl.page.click('.cp-vehicle-deploy-name button[data-action="ok"]');
// The GM's approve dialog is deliberately left standing while the row is read.
await gm.page.waitForSelector(".cp-vehicle-deploy-approve", { timeout: 10000 });
await pl.page.evaluate(() => new Promise(r => setTimeout(r, 700)));
const pendingRow = await pl.page.evaluate(ROW_READER, setup.itemB);
check("D the row reads PENDING while the request is on the GM's screen — not Deploy, not Open",
  pendingRow.deploy && pendingRow.disabled === true && !pendingRow.open, JSON.stringify(pendingRow));
const secondClick = await pl.page.evaluate(async (uuid) => {
  window.__pwNotes.length = 0;
  const item = await fromUuid(uuid);
  const m = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-deploy-request.js`);
  // Raced for the same reason section C is: an un-refused second request opens a dialog that never
  // settles on its own.
  await Promise.race([m.requestVehicleDeploy(item), new Promise(r => setTimeout(r, 2000))]);
  const out = { dialog: !!document.querySelector(".cp-vehicle-deploy-name"), notes: window.__pwNotes.map(n => n.msg) };
  for (const app of [...foundry.applications.instances.values()]) {
    if (app.element?.classList?.contains("cp-vehicle-deploy-name")) await app.close().catch(() => {});
  }
  return out;
}, setup.itemB);
check("D a second request while the first is pending raises no dialog and says why",
  !secondClick.dialog && secondClick.notes.length >= 1, JSON.stringify(secondClick.notes));

await gm.page.click('.cp-vehicle-deploy-approve button[data-action="approve"]');
const approvedRow = await pl.page.waitForFunction(uuid => {
  const app = [...foundry.applications.instances.values()]
    .find(x => (x.document ?? x.item)?.uuid === uuid && x.rendered);
  const b = app?.element?.querySelector(".cp-vehicle-open");
  return b ? { actorId: b.dataset.actorId } : null;
}, setup.itemB, { timeout: 15000 }).then(h => h.jsonValue()).catch(() => null);
check("D approval flips the pending row to Open on her client", !!approvedRow?.actorId, JSON.stringify(approvedRow));
const countD = await gm.page.evaluate(() =>
  game.actors.filter(a => a.type === "cp2020-augmented.vehicle" && a.name.startsWith("__PWL__")).length);
check("D two pink slips, two vehicles — and not one more", countD === 2, String(countD));

/* ══ E — deletion invalidates the link on every client, live ═══════════════════════════════ */
await gm.page.evaluate(async () => {
  for (const n of ["__PWL__GM Truck", "__PWL__Her Truck"]) {
    const a = game.actors.find(x => x.name === n);
    if (a) await a.delete();
  }
});
const revertedPl = await pl.page.waitForFunction(uuid => {
  const app = [...foundry.applications.instances.values()]
    .find(x => (x.document ?? x.item)?.uuid === uuid && x.rendered);
  const el = app?.element;
  return (el && !el.querySelector(".cp-vehicle-open") && el.querySelector(".cp-vehicle-deploy")) ? true : null;
}, setup.itemA, { timeout: 12000 }).then(() => true).catch(() => false);
const revGm = await gm.page.evaluate(ROW_READER, setup.itemA);
const revPl = await pl.page.evaluate(ROW_READER, setup.itemA);
check("E deleting the vehicle reverts her open row to Deploy LIVE, with nothing reopened", revertedPl === true);
check("E and the button is armed, not a disabled leftover",
  revPl.deploy && revPl.disabled === false && !revPl.open, JSON.stringify(revPl));
check("E the GM's open row reverted too", revGm.deploy && !revGm.open, JSON.stringify(revGm));
const redeploy = await gm.page.evaluate(async (uuid) => {
  const item = await fromUuid(uuid);
  const m = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-deploy-request.js`);
  return { linked: m.findDeployedVehicleActor(item)?.id ?? null };
}, setup.itemA);
check("E the link itself resolves to nothing again", redeploy.linked === null, String(redeploy.linked));

/* ══ F — an Open button pointing at nothing is never dead ══════════════════════════════════ */
const deadBtn = await gm.page.evaluate(async ({ itemC }) => {
  const item = await fromUuid(itemC);
  const m = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-deploy-request.js`);
  const actor = await m.createVehicleActorFromItem(item, { name: "__PWL__Doomed", requesterUserId: game.user.id });
  await item.sheet.render(true);
  await new Promise(r => setTimeout(r, 800));
  const root = item.sheet.element;
  const btn = root.querySelector(".cp-vehicle-open");
  if (!btn) return { error: "row never reached the Open state" };
  // A row whose id has gone stale: exactly the shape a deleted-and-not-yet-repainted sheet holds.
  btn.dataset.actorId = foundry.utils.randomID();
  await actor.delete();
  await new Promise(r => setTimeout(r, 600));
  // Re-plant the stale row after the delete's repaint, then press it.
  const root2 = item.sheet.element;
  let stale = root2.querySelector(".cp-vehicle-open");
  if (!stale) {
    const deployBtn = root2.querySelector(".cp-vehicle-deploy");
    if (!deployBtn) return { error: "no control at all after delete" };
    stale = document.createElement("button");
    stale.type = "button";
    stale.className = "cp-vehicle-open";
    stale.dataset.actorId = foundry.utils.randomID();
    deployBtn.replaceWith(stale);
  }
  window.__pwNotes.length = 0;
  stale.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 900));
  const after = item.sheet.element;
  const out = {
    warned: window.__pwNotes.filter(n => n.kind === "warn").map(n => n.msg),
    nowDeploy: !!after.querySelector(".cp-vehicle-deploy"),
    nowOpen: !!after.querySelector(".cp-vehicle-open"),
    sheetsOpened: [...foundry.applications.instances.values()].filter(x => x.actor?.name === "__PWL__Doomed").length,
  };
  await item.sheet.close();
  return out;
}, setup);
check("F pressing an Open that points at a deleted vehicle SAYS SO instead of doing nothing",
  deadBtn.warned?.length === 1, JSON.stringify(deadBtn.warned ?? deadBtn.error));
check("F and the row repaints itself back to an armed Deploy",
  deadBtn.nowDeploy === true && deadBtn.nowOpen === false, JSON.stringify(deadBtn));
check("F NEGATIVE: no phantom sheet was opened for the deleted vehicle", deadBtn.sheetsOpened === 0,
  String(deadBtn.sheetsOpened));

/* ══ G — two handles of ONE vehicle actor, each with its own riders ════════════════════════ */
const multi = await gm.page.evaluate(async ({ SCOPE, sceneId, itemA }) => {
  const out = {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
 try {
  const C = await import(`/modules/${SCOPE}/module/vehicle/vehicle-canvas.js`);
  const O = await import(`/modules/${SCOPE}/module/vehicle/vehicle-occupancy.js`);
  const D = await import(`/modules/${SCOPE}/module/vehicle/vehicle-deploy-request.js`);
  const scene = game.scenes.get(sceneId);
  await scene.view();
  for (let i = 0; i < 50 && canvas.scene?.id !== scene.id; i++) await sleep(200);
  const grid = scene.grid.size;
  const settle = async (id) => {
    let last = null;
    for (let i = 0; i < 30; i++) {
      const t = scene.tokens.get(id);
      const now = `${t?.x},${t?.y}`;
      if (now === last) return;
      last = now;
      await sleep(150);
    }
  };

  const item = await fromUuid(itemA);
  const vehicle = await D.createVehicleActorFromItem(item, { name: "__PWL__TwinTruck", requesterUserId: game.user.id });
  out.vehicleId = vehicle.id;
  // TWO handles of the one vehicle, well apart.
  const depA = await C.deployVehicleToScene(vehicle, { scene, x: 5 * grid, y: 5 * grid });
  const [handleB] = await scene.createEmbeddedDocuments("Token", [{
    name: vehicle.name, actorId: vehicle.id, actorLink: true,
    x: 25 * grid, y: 5 * grid,
    width: scene.tokens.get(depA.tokenId).width, height: scene.tokens.get(depA.tokenId).height,
    sort: -100, flags: { [SCOPE]: { vehicleHandle: true } },
    texture: { src: vehicle.img, fit: "contain" },
  }]);
  const tokA = scene.tokens.get(depA.tokenId), tokB = handleB;
  out.twoHandles = scene.tokens.filter(t => t.actorId === vehicle.id).length;

  // Two riders, one boarded into each handle.
  const riderActors = [];
  for (const n of ["__PWL__R1", "__PWL__R2", "__PWL__RLegacy"]) {
    riderActors.push(await Actor.create({ name: n, type: "character" }));
  }
  const riderDocs = [];
  for (const a of riderActors) {
    const [t] = await scene.createEmbeddedDocuments("Token", [{
      name: a.name, actorId: a.id, actorLink: true, x: 40 * grid, y: 20 * grid,
      width: 1, height: 1, texture: { src: "icons/svg/mystery-man.svg" },
    }]);
    riderDocs.push(t);
  }
  const [r1, r2, rLegacy] = riderDocs;
  await C.boardVehicle(r1, vehicle, tokA);
  await sleep(400);
  await C.boardVehicle(r2, vehicle, tokB);
  await sleep(400);

  const flagOf = (d) => scene.tokens.get(d.id)?.flags?.[SCOPE] ?? {};
  out.stamped = {
    r1Token: flagOf(r1).boardedVehicleToken, r2Token: flagOf(r2).boardedVehicleToken,
    aId: tokA.id, bId: tokB.id,
    r1Seat: flagOf(r1).seatIndex, r2Seat: flagOf(r2).seatIndex,
  };
  out.membership = {
    r1InA: C.riderIsAboardToken(scene.tokens.get(r1.id), tokA),
    r1InB: C.riderIsAboardToken(scene.tokens.get(r1.id), tokB),
    r2InA: C.riderIsAboardToken(scene.tokens.get(r2.id), tokA),
    r2InB: C.riderIsAboardToken(scene.tokens.get(r2.id), tokB),
  };
  out.badges = { a: O.badgeLabelFor(tokA), b: O.badgeLabelFor(tokB) };
  out.perTokenCounts = {
    a: O.occupancyOf(vehicle, scene, tokA).count,
    b: O.occupancyOf(vehicle, scene, tokB).count,
    actorWide: O.occupancyOf(vehicle, scene).count,
  };

  // ⭐ THE REPORTED GESTURE: drive handle B. R2 must move, R1 must not.
  const r1Before = { x: scene.tokens.get(r1.id).x, y: scene.tokens.get(r1.id).y };
  const r2Before = { x: scene.tokens.get(r2.id).x, y: scene.tokens.get(r2.id).y };
  await tokB.update({ x: tokB.x + 6 * grid, y: tokB.y + 2 * grid }, { teleport: true });
  await sleep(800);
  await settle(r2.id);
  const r1AfterB = { x: scene.tokens.get(r1.id).x, y: scene.tokens.get(r1.id).y };
  const r2AfterB = { x: scene.tokens.get(r2.id).x, y: scene.tokens.get(r2.id).y };
  out.driveB = {
    r1Stayed: r1AfterB.x === r1Before.x && r1AfterB.y === r1Before.y,
    r2Followed: r2AfterB.x === r2Before.x + 6 * grid && r2AfterB.y === r2Before.y + 2 * grid,
    r1Before, r1AfterB, r2Before, r2AfterB,
  };

  // …and the other way round.
  const r2Before2 = { x: scene.tokens.get(r2.id).x, y: scene.tokens.get(r2.id).y };
  const r1Before2 = { x: scene.tokens.get(r1.id).x, y: scene.tokens.get(r1.id).y };
  await tokA.update({ x: tokA.x + 3 * grid }, { teleport: true });
  await sleep(800);
  await settle(r1.id);
  out.driveA = {
    r2Stayed: scene.tokens.get(r2.id).x === r2Before2.x && scene.tokens.get(r2.id).y === r2Before2.y,
    r1Followed: scene.tokens.get(r1.id).x === r1Before2.x + 3 * grid
                && scene.tokens.get(r1.id).y === r1Before2.y,
  };

  // LEGACY SHIM: a rider carrying only the old actor-id flag. It must land on exactly ONE handle —
  // the first in the scene's own order — and never be claimed by both.
  await rLegacy.update({
    [`flags.${SCOPE}.boardedVehicle`]: vehicle.id,
    [`flags.${SCOPE}.seatIndex`]: 3,
  });
  await sleep(400);
  const legacyDoc = scene.tokens.get(rLegacy.id);
  const firstHandleId = C.vehicleTokenFor(scene, vehicle.id)?.id ?? null;
  out.legacy = {
    hasNoTokenFlag: legacyDoc.flags?.[SCOPE]?.boardedVehicleToken === undefined,
    resolvesTo: C.riderVehicleTokenIdOn(scene, legacyDoc),
    firstHandleId,
    inA: C.riderIsAboardToken(legacyDoc, tokA),
    inB: C.riderIsAboardToken(legacyDoc, tokB),
  };
  // With only ONE handle left it must resolve to that sole handle — the "degrade gracefully" case.
  await tokB.delete();
  await sleep(400);
  out.legacySingle = {
    resolvesTo: C.riderVehicleTokenIdOn(scene, scene.tokens.get(rLegacy.id)),
    onlyHandle: tokA.id,
  };

  // cleanup for this section
  for (const d of riderDocs) { const t = scene.tokens.get(d.id); if (t) await t.delete(); }
  for (const a of riderActors) await a.delete();
  await vehicle.delete();
  return out;
 } catch (e) {
  // Fail-SOFT for the same reason section A is: every leg reds with the reason rather than the run
  // dying. Fixtures this section made are swept by the final cleanup's __PWL__ pass either way.
  out.error = String(e?.message ?? e);
  return out;
 }
}, { SCOPE, sceneId: setup.sceneId, itemA: setup.itemA });
if (multi.error) console.log(`  info: section G could not complete — ${multi.error}`);

check("G the scene really carries TWO handles of one vehicle (fixture guard)",
  multi.twoHandles === 2, String(multi.twoHandles));
check("G each rider records the handle they boarded, and they are different handles",
  multi.stamped?.r1Token === multi.stamped?.aId && multi.stamped?.r2Token === multi.stamped?.bId,
  JSON.stringify(multi.stamped));
check("G each handle claims its own seats — both riders took seat 0",
  multi.stamped?.r1Seat === 0 && multi.stamped?.r2Seat === 0,
  `${multi.stamped?.r1Seat} / ${multi.stamped?.r2Seat}`);
check("G membership is exclusive: each rider belongs to exactly one handle",
  multi.membership?.r1InA === true && multi.membership?.r1InB === false
  && multi.membership?.r2InB === true && multi.membership?.r2InA === false,
  JSON.stringify(multi.membership));
check("G ⭐ driving the second handle moves ONLY its own rider — the reported swap is gone",
  multi.driveB?.r2Followed === true && multi.driveB?.r1Stayed === true, JSON.stringify(multi.driveB));
check("G and driving the first handle moves only ITS rider",
  multi.driveA?.r1Followed === true && multi.driveA?.r2Stayed === true, JSON.stringify(multi.driveA));
check("G each handle's badge counts its own load, not the pair",
  multi.perTokenCounts?.a === 1 && multi.perTokenCounts?.b === 1,
  JSON.stringify(multi.perTokenCounts));
check("G the badge LABELS say 1 of 6 on each, from 2 crew + 4 passengers",
  /\b1\b/.test(multi.badges?.a ?? "") && /\b6\b/.test(multi.badges?.a ?? "")
  && /\b1\b/.test(multi.badges?.b ?? "") && /\b6\b/.test(multi.badges?.b ?? ""),
  JSON.stringify(multi.badges));
check("G the actor-wide count still answers 2 — the machine's own total is unchanged",
  multi.perTokenCounts?.actorWide === 2, String(multi.perTokenCounts?.actorWide));
check("G LEGACY: a rider carrying only the old actor-id flag resolves to the FIRST handle",
  multi.legacy?.hasNoTokenFlag === true && multi.legacy?.resolvesTo === multi.legacy?.firstHandleId,
  JSON.stringify(multi.legacy));
check("G LEGACY: and to exactly one of the two — never a tug-of-war",
  multi.legacy?.inA === true && multi.legacy?.inB === false, JSON.stringify(multi.legacy));
// ⚠ Conditioned on an actual answer: two `undefined`s compare equal, and this leg read green
// against a build with no resolver at all until it was.
check("G LEGACY: with a single handle present it resolves to that sole handle",
  !!multi.legacySingle?.resolvesTo && multi.legacySingle.resolvesTo === multi.legacySingle.onlyHandle,
  JSON.stringify(multi.legacySingle ?? multi.error));

/* ══ H — ACC / DEC tooltips on both sheets ═════════════════════════════════════════════════ */
const tips = await gm.page.evaluate(async ({ itemA, itemC, SCOPE }) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const D = await import(`/modules/${SCOPE}/module/vehicle/vehicle-deploy-request.js`);
  const read = (root) => ({
    accBtn: root.querySelector(".field.accel")?.getAttribute("title") ?? "",
    decBtn: root.querySelector(".field.decel")?.getAttribute("title") ?? "",
    accLabel: [...root.querySelectorAll("label")].find(l => /acc/i.test(l.getAttribute("for") ?? ""))?.getAttribute("title") ?? "",
    decLabel: [...root.querySelectorAll("label")].find(l => /dec/i.test(l.getAttribute("for") ?? ""))?.getAttribute("title") ?? "",
  });
  const itA = await fromUuid(itemA);
  await itA.sheet.render(true); await sleep(800);
  const itemTips = read(itA.sheet.element);
  itemTips.shotId = itA.sheet.id;

  const itC = await fromUuid(itemC);
  await itC.sheet.render(true); await sleep(800);
  const fallbackTips = read(itC.sheet.element);
  await itC.sheet.close();

  const actor = await D.createVehicleActorFromItem(itA, { name: "__PWL__TipCar", requesterUserId: game.user.id });
  await actor.sheet.render(true); await sleep(900);
  const actorTips = read(actor.sheet.element);
  actorTips.shotId = actor.sheet.id;
  actorTips.acc = actor.system.acc;
  actorTips.dec = actor.system.dec;
  return { itemTips, fallbackTips, actorTips, actorId: actor.id };
}, { itemA: setup.itemA, itemC: setup.itemC, SCOPE });

check("H the item sheet's + tooltip names one combat turn AND the vehicle's own ACC of 18",
  /combat turn/i.test(tips.itemTips.accBtn) && tips.itemTips.accBtn.includes("18")
  && tips.itemTips.accBtn.includes("mph"), tips.itemTips.accBtn);
check("H the item sheet's − tooltip names braking AND the DEC of 30, which differs from ACC",
  /brak/i.test(tips.itemTips.decBtn) && tips.itemTips.decBtn.includes("30"), tips.itemTips.decBtn);
check("H the ACC and DEC input labels carry their own tooltips",
  tips.itemTips.accLabel.length > 20 && tips.itemTips.decLabel.length > 20,
  `${tips.itemTips.accLabel.length}/${tips.itemTips.decLabel.length}`);
check("H NEGATIVE: with no DEC recorded the brake tooltip says it falls back to ACC, and names 18",
  /ACC/.test(tips.fallbackTips.decBtn) && tips.fallbackTips.decBtn.includes("18")
  && !tips.fallbackTips.decBtn.includes("30"), tips.fallbackTips.decBtn);
check("H the deployed vehicle carries the same ACC/DEC pair (fixture guard)",
  tips.actorTips.acc === 18 && tips.actorTips.dec === 30, `${tips.actorTips.acc}/${tips.actorTips.dec}`);
check("H the ACTOR sheet's + and − tooltips state the same steps",
  tips.actorTips.accBtn.includes("18") && /combat turn/i.test(tips.actorTips.accBtn)
  && tips.actorTips.decBtn.includes("30"), `${tips.actorTips.accBtn} || ${tips.actorTips.decBtn}`);
check("H the actor sheet's ACC/DEC labels carry tooltips too",
  tips.actorTips.accLabel.length > 20 && tips.actorTips.decLabel.length > 20,
  `${tips.actorTips.accLabel.length}/${tips.actorTips.decLabel.length}`);

/* ══ I — crew and passengers read as ONE capacity row ══════════════════════════════════════ */
const cap = await gm.page.evaluate(async ({ itemA, actorId }) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pairIn = (root, crewName, passName) => {
    const crew = root.querySelector(`input[name="${crewName}"]`);
    const pass = root.querySelector(`input[name="${passName}"]`);
    if (!crew || !pass) return { found: false };
    const cr = crew.getBoundingClientRect(), pr = pass.getBoundingClientRect();
    return {
      found: true,
      sameField: crew.closest(".field") === pass.closest(".field"),
      sameRow: Math.abs(cr.top - pr.top) <= 2,
      crewValue: crew.value, passValue: pass.value,
      label: crew.closest(".field")?.querySelector("label")?.textContent?.trim() ?? "",
      gapPx: Math.round(pr.left - cr.right),
    };
  };
  const it = await fromUuid(itemA);
  const itemPair = pairIn(it.sheet.element, "system.crew", "system.passengers");
  const actor = game.actors.get(actorId);
  const actorPair = pairIn(actor.sheet.element, "system.crewSlots", "system.passengerSlots");
  // The write path still reaches each field separately.
  const box = actor.sheet.element.querySelector('input[name="system.passengerSlots"]');
  box.value = "7";
  box.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(900);
  const wrote = { crew: actor.system.crewSlots, passengers: actor.system.passengerSlots };
  return { itemPair, actorPair, wrote, itemShot: it.sheet.id, actorShot: actor.sheet.id };
}, { itemA: setup.itemA, actorId: tips.actorId });

check("I the item sheet states crew and passengers in ONE field row, side by side",
  cap.itemPair?.found && cap.itemPair.sameField && cap.itemPair.sameRow, JSON.stringify(cap.itemPair));
check("I with the stated 2 and 4 in them, under a label naming both",
  cap.itemPair?.crewValue === "2" && cap.itemPair?.passValue === "4"
  && /crew/i.test(cap.itemPair?.label ?? "") && /pass/i.test(cap.itemPair?.label ?? ""),
  JSON.stringify(cap.itemPair));
check("I the actor's civilian face pairs them the same way",
  cap.actorPair?.found && cap.actorPair.sameField && cap.actorPair.sameRow, JSON.stringify(cap.actorPair));
check("I they sit within a few pixels of each other, not in separate blocks",
  Number.isFinite(cap.itemPair?.gapPx) && cap.itemPair.gapPx >= 0 && cap.itemPair.gapPx <= 40,
  `${cap.itemPair?.gapPx}px`);
check("I editing passengers still writes ONLY passengers",
  cap.wrote?.passengers === 7 && cap.wrote?.crew === 2, JSON.stringify(cap.wrote));

// screenshots for the user's sign-off (aesthetics are their call)
await gm.page.locator(`#${cap.itemShot}`).screenshot({ path: `${SHOT_DIR}/veh-item-capacity-tips.png` }).catch(() => {});
await gm.page.locator(`#${cap.actorShot}`).screenshot({ path: `${SHOT_DIR}/veh-actor-capacity-tips.png` }).catch(() => {});

/* ══ J — the aboard banner names WHERE it acts ═════════════════════════════════════════════ */
const banner = await gm.page.evaluate(async ({ SCOPE, sceneId, itemA }) => {
 const sleep = ms => new Promise(r => setTimeout(r, ms));
 try {
  const out = {};
  const C = await import(`/modules/${SCOPE}/module/vehicle/vehicle-canvas.js`);
  const O = await import(`/modules/${SCOPE}/module/vehicle/vehicle-occupancy.js`);
  const D = await import(`/modules/${SCOPE}/module/vehicle/vehicle-deploy-request.js`);
  const sceneOne = game.scenes.get(sceneId);
  const sceneTwo = await Scene.create({ name: "__PWL__Scene2", width: 2000, height: 2000, grid: { size: 100 } });
  out.sceneOneName = sceneOne.name;

  const item = await fromUuid(itemA);
  const vehicle = await D.createVehicleActorFromItem(item, { name: "__PWL__BannerBus", requesterUserId: game.user.id });
  await sceneOne.view();
  for (let i = 0; i < 50 && canvas.scene?.id !== sceneOne.id; i++) await sleep(200);
  const dep = await C.deployVehicleToScene(vehicle, { scene: sceneOne, x: 800, y: 800 });
  const handle = sceneOne.tokens.get(dep.tokenId);

  // ONE actor, TWO tokens: aboard on scene 1, standing free on scene 2.
  const rider = await Actor.create({ name: "__PWL__Wanderer", type: "character" });
  const [tokOne] = await sceneOne.createEmbeddedDocuments("Token", [{
    name: rider.name, actorId: rider.id, actorLink: true, x: 1500, y: 1500,
    width: 1, height: 1, texture: { src: "icons/svg/mystery-man.svg" },
  }]);
  const [tokTwo] = await sceneTwo.createEmbeddedDocuments("Token", [{
    name: rider.name, actorId: rider.id, actorLink: true, x: 300, y: 300,
    width: 1, height: 1, texture: { src: "icons/svg/mystery-man.svg" },
  }]);
  await C.boardVehicle(tokOne, vehicle, handle);
  await sleep(500);

  const places = O.aboardPlacesFor(rider);
  out.places = {
    count: places.length,
    sceneId: places[0]?.scene?.id ?? null,
    tokenId: places[0]?.tokenDoc?.id ?? null,
    handleId: places[0]?.handle?.id ?? null,
  };
  out.expected = { sceneOneId: sceneOne.id, tokOneId: tokOne.id, handleId: handle.id, tokTwoId: tokTwo.id };
  out.freeTokenNotAboard = !sceneTwo.tokens.get(tokTwo.id).flags?.[SCOPE]?.boardedVehicle;

  const readBanner = async () => {
    await rider.sheet.render(true);
    await sleep(900);
    const root = rider.sheet.element;
    const b = root?.querySelector(".cp-aboard-banner");
    return {
      present: !!b,
      remote: !!b?.classList?.contains("cp-aboard-remote"),
      text: b?.querySelector(".cp-aboard-text")?.textContent?.trim() ?? "",
      tip: b?.querySelector(".cp-aboard-out")?.getAttribute("title") ?? "",
      sceneId: b?.dataset?.sceneId ?? "",
      tokenId: b?.dataset?.tokenId ?? "",
    };
  };

  // Looking at the scene the vehicle is on: the ordinary, unchanged wording.
  out.local = await readBanner();
  await rider.sheet.close();

  // Now look at the OTHER scene — the reported situation.
  await sceneTwo.view();
  for (let i = 0; i < 50 && canvas.scene?.id !== sceneTwo.id; i++) await sleep(200);
  out.remote = await readBanner();
  out.remoteShotId = rider.sheet.id;
  // Handed to the second half so the remote strip can be photographed from Node while it is on
  // screen — the state disappears the moment the control below is pressed.
  window.__pwJ = { riderId: rider.id, vehicleId: vehicle.id, sceneOneId: sceneOne.id,
                   sceneTwoId: sceneTwo.id, tokOneId: tokOne.id, tokTwoId: tokTwo.id };
  return out;
 } catch (e) { return { error: String(e?.message ?? e) }; }
}, { SCOPE, sceneId: setup.sceneId, itemA: setup.itemA });
if (banner.error) console.log(`  info: section J could not complete — ${banner.error}`);
if (banner.remoteShotId) {
  await gm.page.locator(`#${banner.remoteShotId}`)
    .screenshot({ path: `${SHOT_DIR}/veh-aboard-banner-remote.png` }).catch(() => {});
}

const bannerActed = await gm.page.evaluate(async (SCOPE) => {
 const sleep = ms => new Promise(r => setTimeout(r, ms));
 try {
  const j = window.__pwJ;
  if (!j) return { error: "section J did not reach the control" };
  const sceneOne = game.scenes.get(j.sceneOneId), sceneTwo = game.scenes.get(j.sceneTwoId);
  const rider = game.actors.get(j.riderId);
  const twoBefore = { x: sceneTwo.tokens.get(j.tokTwoId).x, y: sceneTwo.tokens.get(j.tokTwoId).y };
  rider.sheet.element?.querySelector(".cp-aboard-out")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  for (let i = 0; i < 30 && sceneOne.tokens.get(j.tokOneId).flags?.[SCOPE]?.boardedVehicle; i++) await sleep(200);
  await sleep(600);
  const out = {
    oneCleared: !sceneOne.tokens.get(j.tokOneId).flags?.[SCOPE]?.boardedVehicle,
    twoUntouched: sceneTwo.tokens.get(j.tokTwoId).x === twoBefore.x
                  && sceneTwo.tokens.get(j.tokTwoId).y === twoBefore.y
                  && !sceneTwo.tokens.get(j.tokTwoId).flags?.[SCOPE]?.boardedVehicle,
    bannerGone: !rider.sheet.element?.querySelector(".cp-aboard-banner"),
  };
  await rider.sheet.close();
  await sceneOne.view();
  for (let i = 0; i < 50 && canvas.scene?.id !== sceneOne.id; i++) await sleep(200);
  await sceneTwo.delete();
  await rider.delete();
  await game.actors.get(j.vehicleId)?.delete();
  return out;
 } catch (e) { return { error: String(e?.message ?? e) }; }
}, SCOPE);
banner.acted = bannerActed;
if (bannerActed.error) console.log(`  info: section J's control could not be driven — ${bannerActed.error}`);

check("J one actor, two tokens: exactly ONE of them is aboard, and the query names that one",
  banner.places?.count === 1 && banner.places?.tokenId === banner.expected?.tokOneId
  && banner.places?.sceneId === banner.expected?.sceneOneId
  && banner.freeTokenNotAboard === true, JSON.stringify(banner.places ?? banner.error));
// ⚠ Truthiness required on both sides — two `undefined`s compare equal (vacuous-leg audit).
check("J the aboard place also names the HANDLE the rider is in",
  !!banner.places?.handleId && banner.places.handleId === banner.expected?.handleId,
  `${banner.places?.handleId} vs ${banner.expected?.handleId}`);
check("J on the vehicle's own scene the strip reads exactly as it always did — no scene named",
  banner.local?.present === true && banner.local?.remote === false
  && banner.local.text.includes("__PWL__BannerBus") && !banner.local.text.includes(banner.sceneOneName),
  JSON.stringify(banner.local));
check("J viewed from ANOTHER scene the strip says which scene the vehicle is on",
  banner.remote?.present === true && banner.remote?.remote === true
  && banner.remote.text.includes("__PWL__BannerBus") && banner.remote.text.includes(banner.sceneOneName),
  JSON.stringify(banner.remote));
check("J and the control's tooltip says the token will be put down there",
  !!banner.sceneOneName && (banner.remote?.tip ?? "").includes(banner.sceneOneName),
  banner.remote?.tip);
check("J the control still points at the aboard token on its own scene",
  !!banner.remote?.sceneId && banner.remote.sceneId === banner.expected?.sceneOneId
  && !!banner.remote?.tokenId && banner.remote.tokenId === banner.expected?.tokOneId,
  JSON.stringify(banner.remote ?? banner.error));
check("J pressing it disembarks the aboard token and leaves the free token untouched",
  banner.acted?.oneCleared === true && banner.acted?.twoUntouched === true, JSON.stringify(banner.acted));
check("J and the strip goes away once nobody is aboard", banner.acted?.bannerGone === true,
  JSON.stringify(banner.acted));

/* ---------- cleanup ---------- */
const cleaned = await gm.page.evaluate(async ({ sceneId, activeBefore }) => {
  for (const app of [...foundry.applications.instances.values()]) {
    const d = app.document ?? app.item ?? app.actor;
    if (d?.name?.startsWith?.("__PWL__")) await app.close().catch(() => {});
  }
  // Every scene THIS suite makes, not just the main probe: section J stands a second one up, and a
  // section that died before its own delete must not leave it for the next run to trip over.
  for (const s of [...game.scenes]) if (s.name.startsWith("__PWL__")) await s.delete();
  for (const a of [...game.actors]) if (a.name.startsWith("__PWL__")) await a.delete();
  for (const i of [...game.items]) if (i.name.startsWith("__PWL__")) await i.delete();
  const folder = game.folders.find(f => f.type === "Actor" && f.name === "Vehicles");
  if (folder && folder.contents.length === 0) await folder.delete();
  return {
    actorsLeft: game.actors.filter(a => a.name.startsWith("__PWL__")).length,
    scenesLeft: game.scenes.filter(s => s.name.startsWith("__PWL__")).length,
    activeUnchanged: (game.scenes.active?.id ?? null) === activeBefore,
  };
}, { sceneId: setup.sceneId, activeBefore: setup.activeBefore });
check("fixtures removed", cleaned.actorsLeft === 0 && cleaned.scenesLeft === 0,
  `actors=${cleaned.actorsLeft} scenes=${cleaned.scenesLeft}`);
check("world active scene untouched", cleaned.activeUnchanged === true);

const noise = /compatibility|deprecat|screen resolution|Invalid Asset/i;
check("0 GM console errors", gmErrors.filter(e => !noise.test(e)).length === 0,
  gmErrors.filter(e => !noise.test(e)).slice(0, 3).join(" | "));
check("0 player console errors", plErrors.filter(e => !noise.test(e)).length === 0,
  plErrors.filter(e => !noise.test(e)).slice(0, 3).join(" | "));

console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
