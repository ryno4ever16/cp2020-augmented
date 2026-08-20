/**
 * KEEPER: vehicle canvas placement, seating presentation and occupancy read-outs.
 *
 * Contract under test (user rulings 2026-08-11):
 *  - Deploy PLACES the vehicle: approval puts a handle token beside the requester's token, on
 *    their scene. No token to stand beside → the actor is still created, plus a notice saying
 *    where it went.
 *  - A rider sits INSIDE the footprint, one per square, in a deterministic seat order; drawn at
 *    60% of its own art scale; sorted above the hull so its square selects the person while the
 *    hull selects the vehicle. Stepping out restores size/sort exactly and lands BESIDE the
 *    vehicle, never under it.
 *  - Occupancy is readable in three places: a count badge on the handle, the vehicle sheet's
 *    riders list (with per-person controls), and an "aboard" strip on the rider's own sheet.
 *  - The occupant fade is per-client: placeable alpha only, no document write.
 *  - A chemical shell leaves a cloud on this core (the area shim, not a raw MeasuredTemplate).
 *
 * Runs on its OWN __PW__ scene (viewed, never activated) and deletes it. Never touches the
 * active scene.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", e => errors.push(String(e)));

await page.goto(`${URL}/join`);
await page.waitForSelector('select[name="userid"]');
await page.evaluate(() => {
  const sel = document.querySelector('select[name="userid"]');
  const opt = [...sel.options].find(o => /^gamemaster$/i.test(o.textContent.trim()));
  sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.fill('input[name="password"]', GM_PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 30000 });

// notification capture
await page.evaluate(() => {
  window.__pwNotes = [];
  for (const kind of ["info", "warn"]) {
    const orig = ui.notifications[kind].bind(ui.notifications);
    ui.notifications[kind] = (msg, ...rest) => { window.__pwNotes.push({ kind, msg: String(msg) }); return orig(msg, ...rest); };
  }
});

/* ------------------------------------------------------------------ setup */

const setup = await page.evaluate(async (SCOPE) => {
  // The startup "Setup & What's New" window re-opens after any module version change and sits over
  // the middle of the canvas — which is exactly where the click legs below aim. Probe-proven: with
  // it open, elementFromPoint at the seat square answers the dialog's table cell and the click never
  // reaches the board. Close it before touching the canvas.
  for (const app of [...foundry.applications.instances.values()]) {
    if (app.id === "cp-automation-notice") await app.close().catch(() => {});
  }
  const activeBefore = game.scenes.active?.id ?? null;
  // stale runs
  for (const s of [...game.scenes]) if (s.name.startsWith("__PW__")) await s.delete();
  for (const a of [...game.actors]) if (a.name.startsWith("__PW__")) await a.delete();

  const scene = await Scene.create({ name: "__PW__Seating", width: 3000, height: 3000, grid: { size: 100 } });
  await scene.view();
  for (let i = 0; i < 50 && canvas.scene?.id !== scene.id; i++) await new Promise(r => setTimeout(r, 200));

  const driver = await Actor.create({ name: "__PW__Driver", type: "character" });
  const rider = await Actor.create({ name: "__PW__Rider", type: "character" });
  // A vehicle ITEM on the driver, so the real Deploy path has something to convert.
  const packVehicles = game.packs.get("cyberpunk2020.vehicles");
  const idx = await packVehicles.getIndex({ fields: ["type", "system.sdp"] });
  const src = await packVehicles.getDocument(idx.find(e => e.type === "vehicle" && Number(e.system?.sdp?.max) > 0)._id);
  const [item] = await driver.createEmbeddedDocuments("Item", [src.toObject()]);

  // The anchor token the deploy must land beside, at a clean grid position.
  const [anchorTok] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PW__Driver", actorId: driver.id, actorLink: true, x: 500, y: 500, width: 1, height: 1,
    texture: { src: "icons/svg/mystery-man.svg" },
  }]);
  for (let i = 0; i < 50 && !canvas.tokens.get(anchorTok.id); i++) await new Promise(r => setTimeout(r, 200));

  return {
    activeBefore, sceneId: scene.id, grid: scene.grid.size,
    driverId: driver.id, riderId: rider.id, itemUuid: item.uuid,
    anchorTokenId: anchorTok.id, anchor: { x: anchorTok.x, y: anchorTok.y },
    hadCharacter: !!game.user.character,
  };
}, SCOPE);

/* ------------------------------------------------------------------ A. deploy lands on the canvas */

await page.evaluate(({ anchorTokenId }) => {
  canvas.tokens.releaseAll();
  canvas.tokens.get(anchorTokenId)?.control({ releaseOthers: true });
}, setup);

await page.evaluate(async ({ itemUuid }) => {
  const item = await fromUuid(itemUuid);
  const m = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-deploy-request.js`);
  window.__pwDeploy = m.requestVehicleDeploy(item);
}, setup);
await page.waitForSelector('.cp-vehicle-deploy-name input[name="cp-deploy-name"]', { timeout: 15000 });
await page.fill('.cp-vehicle-deploy-name input[name="cp-deploy-name"]', "__PW__Ride");
await page.click('.cp-vehicle-deploy-name button[data-action="ok"]');

const placed = await page.waitForFunction(({ sceneId }) => {
  const scene = game.scenes.get(sceneId);
  const actor = game.actors.getName("__PW__Ride");
  if (!actor) return null;
  const tok = scene.tokens.find(t => t.actorId === actor.id);
  if (!tok) return null;
  return {
    actorId: actor.id, tokenId: tok.id,
    x: tok.x, y: tok.y, w: tok.width, h: tok.height, sort: tok.sort,
    // The token's width/height are the carrying SQUARE; the vehicle's own shape is recorded on the
    // actor. Both are read, because the contract is that they differ in exactly that way.
    hullW: actor.system.layout?.hullW ?? null, hullH: actor.system.layout?.hullH ?? null,
    handleFlag: tok.flags?.["cp2020-augmented"]?.vehicleHandle === true,
    fit: tok.texture?.fit,
  };
}, setup, { timeout: 20000 }).then(h => h.jsonValue()).catch(() => null);

check("deploy places a handle token on the requester's scene", !!placed);
if (placed) {
  const g = setup.grid;
  // First free candidate = immediately to the RIGHT of the anchor, rows aligned.
  check("placed token sits one square right of the anchor token (exact)",
    placed.x === setup.anchor.x + g && placed.y === setup.anchor.y, `x=${placed.x} y=${placed.y}`);
  const gapSquares = (placed.x - (setup.anchor.x + g)) / g;
  check("placed token is adjacent (gap = 0 squares)", gapSquares === 0, String(gapSquares));
  check("placed token carries the vehicle-handle flag", placed.handleFlag === true);
  check("placed token sorts below crew (sort = -100)", placed.sort === -100, String(placed.sort));
  check("the placed vehicle records a hull deep rather than wide (2x4)",
    placed.hullW === 2 && placed.hullH === 4, `hull ${placed.hullW}x${placed.hullH}`);
  check("its token carries the SQUARE that holds that hull at any angle (4x4)",
    placed.w === 4 && placed.h === 4, `frame ${placed.w}x${placed.h}`);
}

/* ------------------------------------------------------------------ B. blocked side falls to the next candidate */

const blockedPlacement = await page.evaluate(async ({ sceneId, anchorTokenId, grid }) => {
  const scene = game.scenes.get(sceneId);
  const anchor = scene.tokens.get(anchorTokenId);
  const seat = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-seating.js`);
  const rect = { x: anchor.x, y: anchor.y, w: grid, h: grid };
  const size = { w: 4, h: 2 };
  // right side taken by the vehicle already parked there
  const blockers = [...scene.tokens].filter(t => t.id !== anchor.id)
    .map(t => ({ x: t.x, y: t.y, w: t.width * grid, h: t.height * grid }));
  const spot = seat.placeBeside(rect, grid, size, blockers, { width: scene.width, height: scene.height });
  const free = seat.placeBeside(rect, grid, size, [], { width: scene.width, height: scene.height });
  return { spot, free, expectLeftX: anchor.x - 4 * grid, expectY: anchor.y };
}, setup);
check("occupied right side falls through to the left candidate (exact)",
  blockedPlacement.spot.x === blockedPlacement.expectLeftX && blockedPlacement.spot.y === blockedPlacement.expectY,
  `x=${blockedPlacement.spot.x}`);
check("blocked search still reports a free landing", blockedPlacement.spot.free === true);
check("negative case: with nothing in the way the right side wins",
  blockedPlacement.free.x === setup.anchor.x + setup.grid, String(blockedPlacement.free.x));

/* ------------------------------------------------------------------ C. no anchor token → actor only + notice */

const fallback = await page.evaluate(async ({ itemUuid, sceneId }) => {
  window.__pwNotes.length = 0;
  canvas.tokens.releaseAll();
  const m = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-deploy-request.js`);
  const scene = game.scenes.get(sceneId);
  // A second item so the dedupe guard doesn't short-circuit the flow.
  const item = await fromUuid(itemUuid);
  const [item2] = await item.parent.createEmbeddedDocuments("Item", [item.toObject()]);
  // No selection, and the GM's assigned character (if any) has no token here → no anchor.
  const anchor = m.requesterAnchor();
  const before = scene.tokens.size;
  const actor = await m.createVehicleActorFromItem(item2, { name: "__PW__NoAnchor", requesterUserId: game.user.id });
  const res = await m.placeDeployedVehicle(actor, anchor);
  return {
    anchorIsNull: anchor === null,
    placed: res.placed,
    tokensAdded: scene.tokens.size - before,
    actorExists: !!game.actors.getName("__PW__NoAnchor"),
    item2Id: item2.id,
  };
}, setup);
check("no selected/assigned token on the scene → no anchor", fallback.anchorIsNull === true);
check("no-anchor deploy still creates the actor", fallback.actorExists === true);
check("no-anchor deploy adds no token", fallback.tokensAdded === 0 && fallback.placed === false, `added=${fallback.tokensAdded}`);
const fallbackNote = await page.evaluate(async ({ }) => {
  window.__pwNotes.length = 0;
  const m = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-deploy-request.js`);
  const actor = game.actors.getName("__PW__NoAnchor");
  const { placed } = await m.placeDeployedVehicle(actor, null);
  if (!placed) ui.notifications.warn(game.i18n.format("CYBERPUNK.Vehicle.DeployNoTokenFallback", { name: actor.name }));
  return window.__pwNotes.find(n => n.kind === "warn")?.msg ?? "";
}, {});
check("fallback notice names the actor and the Vehicles folder",
  fallbackNote.includes("__PW__NoAnchor") && /vehicles folder/i.test(fallbackNote), fallbackNote.slice(0, 120));
check("fallback notice leaks no raw key", !fallbackNote.includes("CYBERPUNK."));

/* ------------------------------------------------------------------ D. seating: slots, scale, sort */

const seating = await page.evaluate(async ({ sceneId, riderId, driverId, grid }) => {
  const scene = game.scenes.get(sceneId);
  const vehicle = game.actors.getName("__PW__Ride");
  const vTok = scene.tokens.find(t => t.actorId === vehicle.id);
  const canvasMod = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-canvas.js`);

  // A rider with a NON-default art scale proves the 60% is relative and the restore is exact.
  const [r1] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PW__Rider", actorId: riderId, actorLink: true, x: 2000, y: 2000, width: 1, height: 1,
    sort: 0, texture: { src: "icons/svg/mystery-man.svg", scaleX: 1.2, scaleY: 1.2 },
  }]);
  const [r2] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PW__Driver2", actorId: driverId, actorLink: false, x: 2200, y: 2000, width: 1, height: 1,
    sort: 0, texture: { src: "icons/svg/mystery-man.svg" },
  }]);
  for (let i = 0; i < 50 && !(canvas.tokens.get(r1.id) && canvas.tokens.get(r2.id)); i++) await new Promise(r => setTimeout(r, 200));

  const priorScale = r1._source.texture.scaleX;
  const priorSort = r1._source.sort;
  await canvasMod.boardVehicle(scene.tokens.get(r1.id), vehicle, vTok);
  await canvasMod.boardVehicle(scene.tokens.get(r2.id), vehicle, vTok);
  // This core streams a token's document position while it animates along a movement path, so a
  // read taken too early lands mid-glide. Wait for the coordinates to stop changing.
  // The vehicle's own rectangle inside its carrying square — the origin every seat expectation in
  // this suite is measured from now that the token's rect is a square and not the shape.
  window.__pwHull = (tokenDoc, grid) => {
    const sysHull = tokenDoc.actor?.system?.layout ?? {};
    const hw = Number(sysHull.hullW) >= 1 ? Math.round(Number(sysHull.hullW)) : Math.round(Number(tokenDoc.width));
    const hh = Number(sysHull.hullH) >= 1 ? Math.round(Number(sysHull.hullH)) : Math.round(Number(tokenDoc.height));
    return {
      w: hw, h: hh,
      x: tokenDoc.x + ((Number(tokenDoc.width) - hw) * grid) / 2,
      y: tokenDoc.y + ((Number(tokenDoc.height) - hh) * grid) / 2,
    };
  };
  window.__pwSettle = async (sceneId, tokenId) => {
    const sc = game.scenes.get(sceneId);
    let last = null;
    for (let i = 0; i < 30; i++) {
      const t = sc.tokens.get(tokenId);
      const now = `${t.x},${t.y}`;
      if (now === last) return;
      last = now;
      await new Promise(r => setTimeout(r, 150));
    }
  };
  await window.__pwSettle(scene.id, r1.id);
  await window.__pwSettle(scene.id, r2.id);

  const a = scene.tokens.get(r1.id), b = scene.tokens.get(r2.id);
  const hull = window.__pwHull(vTok, grid);
  // Containment is measured against the HULL, not the carrying square: a rider inside the square but
  // outside the bodywork is exactly the defect the split exists to prevent, so the square would be a
  // weaker test than the one it replaces.
  const inFootprint = (t) => t.x >= hull.x && t.y >= hull.y
    && t.x + t.width * grid <= hull.x + hull.w * grid
    && t.y + t.height * grid <= hull.y + hull.h * grid;

  return {
    vehicle: { id: vehicle.id, tokenId: vTok.id, x: vTok.x, y: vTok.y, w: vTok.width, h: vTok.height, sort: vTok.sort },
    hull,
    r1Id: r1.id, r2Id: r2.id, priorScale, priorSort,
    seat1: { x: a.x, y: a.y, idx: a.flags["cp2020-augmented"].seatIndex, sort: a.sort, scale: a._source.texture.scaleX },
    seat2: { x: b.x, y: b.y, idx: b.flags["cp2020-augmented"].seatIndex, sort: b.sort, scale: b._source.texture.scaleX },
    inFootprint: inFootprint(a) && inFootprint(b),
    distinct: !(a.x === b.x && a.y === b.y),
    restoreStored: a.flags["cp2020-augmented"].boardedRestore,
  };
}, setup);

// Seats are not the footprint's reading order. The handle takes the rotation-zero convention —
// nose SOUTH — so the engine occupies the bottom rank, the driver sits in the rank behind it, and
// facing south the driver's LEFT is the east (right-hand) file. Seat 1 is beside them, one file
// west. Expectations are derived here from the handle's own footprint rather than copied off the
// module, so a change to the layout code cannot quietly re-bless itself.
const g = setup.grid;
// vw/vh are the HULL's dimensions and the seat coordinates are measured from the HULL's own top-left
// corner. The token's rect is the square that carries it and has no cells of its own.
const vw = seating.hull.w, vh = seating.hull.h;
const driverSeat = { x: seating.hull.x + (vw - 1) * g, y: seating.hull.y + (vh - 2) * g };
const mateSeat = { x: seating.hull.x + (vw - 2) * g, y: seating.hull.y + (vh - 2) * g };
check("the hull is deep rather than wide (the long axis is the travel axis)", vh > vw, `hull ${vw}x${vh}`);
check("the token frame that carries it is square", seating.vehicle.w === seating.vehicle.h,
  `frame ${seating.vehicle.w}x${seating.vehicle.h}`);
check("first rider takes the driver's seat, behind the engine rank (exact)",
  seating.seat1.idx === 0 && seating.seat1.x === driverSeat.x && seating.seat1.y === driverSeat.y,
  `idx=${seating.seat1.idx} at ${seating.seat1.x},${seating.seat1.y}; want ${driverSeat.x},${driverSeat.y}`);
check("second rider takes seat 1 = the next file in that rank (exact)",
  seating.seat2.idx === 1 && seating.seat2.x === mateSeat.x && seating.seat2.y === mateSeat.y,
  `idx=${seating.seat2.idx} at ${seating.seat2.x},${seating.seat2.y}; want ${mateSeat.x},${mateSeat.y}`);
check("riders sit inside the vehicle footprint", seating.inFootprint === true);
check("riders occupy separate squares (never point-stacked)", seating.distinct === true);
check("art scale multiplies the rider's own scale by 0.6 (1.2 → 0.72)",
  Math.abs(seating.seat1.scale - 0.72) < 1e-9, String(seating.seat1.scale));
check("rider sorts above the hull", seating.seat1.sort > seating.vehicle.sort,
  `rider=${seating.seat1.sort} hull=${seating.vehicle.sort}`);
check("restore point stores the pre-boarding scale + sort",
  seating.restoreStored?.scaleX === seating.priorScale && seating.restoreStored?.sort === seating.priorSort,
  JSON.stringify(seating.restoreStored));

/* ------------------------------------------------------------------ E. click order: seat = person, hull = vehicle */

async function clickWorld(x, y) {
  const p = await page.evaluate(({ x, y }) => {
    const pt = canvas.stage.worldTransform.apply({ x, y });
    return { x: Math.round(pt.x), y: Math.round(pt.y) };
  }, { x, y });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(350);
  return page.evaluate(() => canvas.tokens.controlled.map(t => t.document.name));
}
await page.evaluate(({ vehicle, grid }) => {
  canvas.tokens.releaseAll();
  // Centre on the handle's own middle, whatever its footprint — a hard-coded offset centred a
  // 4x2 and left the deeper default's far rank near the edge of the viewport.
  canvas.animatePan({ x: vehicle.x + (vehicle.w * grid) / 2, y: vehicle.y + (vehicle.h * grid) / 2, scale: 1, duration: 1 });
}, { ...seating, grid: setup.grid });
await page.waitForTimeout(600);
const seatClick = await clickWorld(seating.seat1.x + g / 2, seating.seat1.y + g / 2);
check("clicking a seat square selects the person", seatClick.includes("__PW__Rider"), seatClick.join(","));
await page.evaluate(() => canvas.tokens.releaseAll());
// The engine rank is the bottom one and never holds a seat, so it is empty hull by construction.
const hullClick = await clickWorld(seating.hull.x + 0.5 * g, seating.hull.y + (vh - 0.5) * g);
check("clicking empty hull selects the vehicle", hullClick.includes("__PW__Ride"), hullClick.join(","));
await page.evaluate(() => canvas.tokens.releaseAll());
// NEGATIVE, and the whole point of the pointer change: the same click a square OUT from the hull's
// flank is still inside core's carrying square, and must now select nothing at all.
const offHullClick = await clickWorld(seating.hull.x - 0.5 * g, seating.hull.y + (vh - 0.5) * g);
check("NEGATIVE: clicking inside the carrying square but off the hull selects nothing",
  offHullClick.length === 0
  && seating.hull.x - 0.5 * g > seating.vehicle.x, offHullClick.join(",") || "(nothing)");
await page.evaluate(() => canvas.tokens.releaseAll());

/* ------------------------------------------------------------------ F. occupancy read-outs */

const occ = await page.evaluate(async ({ sceneId }) => {
  const scene = game.scenes.get(sceneId);
  const vehicle = game.actors.getName("__PW__Ride");
  const mod = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-occupancy.js`);
  await vehicle.update({ "system.crewSlots": 1, "system.passengerSlots": 3 });
  const within = mod.occupancyAcrossScenes(vehicle);
  const vTok = scene.tokens.find(t => t.actorId === vehicle.id);
  const badgeWithin = mod.badgeLabelFor(vTok);
  await vehicle.update({ "system.crewSlots": 1, "system.passengerSlots": 0 });
  const over = mod.occupancyAcrossScenes(vehicle);
  await vehicle.update({ "system.crewSlots": 1, "system.passengerSlots": 3 });
  // canvas badge object
  const placeable = canvas.tokens.get(vTok.id);
  await new Promise(r => setTimeout(r, 400));
  return {
    count: within.count, capacity: within.capacity, over: within.over, names: within.occupants.map(o => o.name),
    badgeWithin, overFlag: over.over, overCapacity: over.capacity,
    badgeText: placeable?.cpOccupancyBadge?.text ?? null,
  };
}, setup);
check("occupancy counts both riders against the seat total", occ.count === 2 && occ.capacity === 4, `${occ.count}/${occ.capacity}`);
check("occupancy names the riders", occ.names.includes("__PW__Rider") && occ.names.includes("__PW__Driver2"), occ.names.join(","));
check("within capacity is not flagged over", occ.over === false);
check("negative case: 2 riders in 1 seat flags over-capacity", occ.overFlag === true && occ.overCapacity === 1);
check("badge label reads count/capacity", occ.badgeWithin === "2/4", String(occ.badgeWithin));
check("badge is drawn on the handle placeable", occ.badgeText === "2/4", String(occ.badgeText));

/* ------------------------------------------------------------------ G. client-local fade */

const fade = await page.evaluate(async ({ sceneId }) => {
  const scene = game.scenes.get(sceneId);
  const vehicle = game.actors.getName("__PW__Ride");
  const mod = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-occupancy.js`);
  const riderTok = scene.tokens.find(t => t.name === "__PW__Rider");
  const p = canvas.tokens.get(riderTok.id);
  const on = mod.toggleOccupantFade(vehicle.id);
  await new Promise(r => setTimeout(r, 300));
  const dimmed = { state: on, alpha: p.alpha, docAlpha: riderTok.alpha };
  // survive a refresh (the mechanism that made a bare assignment useless)
  p.renderFlags.set({ refresh: true });
  await new Promise(r => setTimeout(r, 300));
  const afterRefresh = canvas.tokens.get(riderTok.id).alpha;
  const off = mod.toggleOccupantFade(vehicle.id);
  await new Promise(r => setTimeout(r, 300));
  return { dimmed, afterRefresh, offState: off, alphaAfterOff: canvas.tokens.get(riderTok.id).alpha,
           docAlphaAfterOff: scene.tokens.get(riderTok.id).alpha };
}, setup);
check("fade dims the occupant placeable", fade.dimmed.state === true && fade.dimmed.alpha === 0.25, String(fade.dimmed.alpha));
check("fade writes nothing to the token document", fade.dimmed.docAlpha === 1, String(fade.dimmed.docAlpha));
check("fade survives a placeable refresh", fade.afterRefresh === 0.25, String(fade.afterRefresh));
check("toggling back restores full opacity", fade.offState === false && fade.alphaAfterOff === 1, String(fade.alphaAfterOff));
check("document alpha untouched throughout", fade.docAlphaAfterOff === 1);

/* ------------------------------------------------------------------ H. vehicle sheet riders list */

const sheet = await page.evaluate(async () => {
  const vehicle = game.actors.getName("__PW__Ride");
  await vehicle.sheet.render(true);
  await new Promise(r => setTimeout(r, 900));
  const root = vehicle.sheet.element;
  const rows = [...root.querySelectorAll(".cp-occupant-row")];
  const out = {
    rowCount: rows.length,
    names: rows.map(r => r.querySelector(".cp-occupant-name")?.textContent?.trim()),
    countText: root.querySelector(".cp-occupancy-count")?.textContent?.trim() ?? "",
    buttons: root.querySelectorAll(".cp-occupant-out").length,
    rawKeyLeak: /CYBERPUNK\./.test(root.querySelector(".cp-vehicle-occupants")?.textContent ?? ""),
  };
  // step one rider out from the sheet
  const target = rows.find(r => r.querySelector(".cp-occupant-name")?.textContent?.trim() === "__PW__Driver2");
  target.querySelector(".cp-occupant-out").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 900));
  const scene = canvas.scene;
  const tokA = scene.tokens.find(t => t.name === "__PW__Driver2");
  await window.__pwSettle(scene.id, tokA.id);
  const tok = scene.tokens.get(tokA.id);
  out.afterStepOut = {
    boarded: tok.flags?.["cp2020-augmented"]?.boardedVehicle ?? null,
    rows: [...vehicle.sheet.element.querySelectorAll(".cp-occupant-row")].length,
  };
  await vehicle.sheet.close();
  return out;
});
check("sheet lists one row per rider", sheet.rowCount === 2, String(sheet.rowCount));
check("sheet rows name the riders", sheet.names.includes("__PW__Rider") && sheet.names.includes("__PW__Driver2"), sheet.names.join(","));
check("sheet shows the live count against capacity", sheet.countText.replace(/\s/g, "") === "2/4", sheet.countText);
check("each row carries a step-out control", sheet.buttons === 2, String(sheet.buttons));
check("riders block leaks no raw key", sheet.rawKeyLeak === false);
check("step-out from the sheet clears that rider's boarding", sheet.afterStepOut.boarded === null);
check("step-out removes the row", sheet.afterStepOut.rows === 1, String(sheet.afterStepOut.rows));

/* ------------------------------------------------------------------ I. aboard banner on the rider's own sheet */

const banner = await page.evaluate(async ({ riderId }) => {
  const rider = game.actors.get(riderId);
  await rider.sheet.render(true);
  await new Promise(r => setTimeout(r, 1200));
  const root = rider.sheet.element;
  const el = root.querySelector(".cp-aboard-banner");
  const out = {
    present: !!el,
    text: el?.querySelector(".cp-aboard-text")?.textContent?.trim() ?? "",
    hasButton: !!el?.querySelector(".cp-aboard-out"),
    rawKeyLeak: /CYBERPUNK\./.test(el?.textContent ?? ""),
  };
  el?.querySelector(".cp-aboard-out")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 1200));
  const scene = canvas.scene;
  const tok0 = scene.tokens.find(t => t.name === "__PW__Rider");
  await window.__pwSettle(scene.id, tok0.id);
  const tok = scene.tokens.get(tok0.id);
  out.after = {
    boarded: tok.flags?.["cp2020-augmented"]?.boardedVehicle ?? null,
    banner: !!rider.sheet.element.querySelector(".cp-aboard-banner"),
    scale: tok._source.texture.scaleX,
    sort: tok._source.sort,
    x: tok.x, y: tok.y,
  };
  await rider.sheet.close();
  return out;
}, setup);
check("rider's own sheet carries the aboard strip", banner.present === true);
check("strip names the vehicle", banner.text.includes("__PW__Ride"), banner.text);
check("strip offers a step-out control", banner.hasButton === true);
check("strip leaks no raw key", banner.rawKeyLeak === false);
check("step-out from the strip clears the boarding flag", banner.after.boarded === null);
check("negative case: strip is gone once off the vehicle", banner.after.banner === false);

/* ------------------------------------------------------------------ J. step-out restores and lands beside */

check("art scale restored to the pre-boarding value exactly",
  banner.after.scale === seating.priorScale, `${banner.after.scale} vs ${seating.priorScale}`);
check("sort restored to the pre-boarding value exactly",
  banner.after.sort === seating.priorSort, `${banner.after.sort} vs ${seating.priorSort}`);
const outside = await page.evaluate(({ sceneId, grid }) => {
  const scene = game.scenes.get(sceneId);
  const vehicle = game.actors.getName("__PW__Ride");
  const v = scene.tokens.find(t => t.actorId === vehicle.id);
  const r = scene.tokens.find(t => t.name === "__PW__Rider");
  const vh2 = window.__pwHull(v, grid);
  const vr = { x: vh2.x, y: vh2.y, w: vh2.w * grid, h: vh2.h * grid };
  const rr = { x: r.x, y: r.y, w: r.width * grid, h: r.height * grid };
  const overlap = rr.x < vr.x + vr.w && vr.x < rr.x + rr.w && rr.y < vr.y + vr.h && vr.y < rr.y + rr.h;
  const gapX = Math.max(vr.x - (rr.x + rr.w), rr.x - (vr.x + vr.w), 0);
  const gapY = Math.max(vr.y - (rr.y + rr.h), rr.y - (vr.y + vr.h), 0);
  return { overlap, gapX, gapY, rr, vr };
}, setup);
check("stepped-out rider stands OUTSIDE the footprint", outside.overlap === false, JSON.stringify(outside.rr));
check("stepped-out rider stands adjacent (≤1 square away)",
  outside.gapX <= setup.grid && outside.gapY <= setup.grid, `gap=${outside.gapX},${outside.gapY}`);

/* ------------------------------------------------------------------ K. seat re-use: the freed seat is taken again */

const reseat = await page.evaluate(async ({ sceneId }) => {
  const scene = game.scenes.get(sceneId);
  const vehicle = game.actors.getName("__PW__Ride");
  const vTok = scene.tokens.find(t => t.actorId === vehicle.id);
  const canvasMod = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-canvas.js`);
  // Only __PW__Driver2 (seat 1) may still be aboard; both stepped out above, so seat 0 is free.
  const r = scene.tokens.find(t => t.name === "__PW__Rider");
  await canvasMod.boardVehicle(r, vehicle, vTok);
  await window.__pwSettle(scene.id, r.id);
  const t = scene.tokens.get(r.id);
  const hull = window.__pwHull(vTok, scene.grid.size);
  return { idx: t.flags["cp2020-augmented"].seatIndex, x: t.x, y: t.y, vx: hull.x, vy: hull.y };
}, setup);
check("a freed seat is re-used by the next rider (lowest free index)",
  reseat.idx === 0 && reseat.x === reseat.vx + (vw - 1) * g && reseat.y === reseat.vy + (vh - 2) * g,
  `idx=${reseat.idx} at ${reseat.x},${reseat.y}; want ${reseat.vx + (vw - 1) * g},${reseat.vy + (vh - 2) * g}`);

/* ------------------------------------------------------------------ M. Layer-1 layout defaults */

const layoutPure = await page.evaluate(async () => {
  const out = [];
  const ok = (n, p, d) => out.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
  const L = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-layout.js`);
  const j = (v) => JSON.stringify(v);

  // A 2-wide, 4-deep car with its nose north: hood across the top, driver behind it on the left.
  ok("front rank of a north-facing footprint is the engine region", j(L.derivedEngineCells(2, 4, "n")) === "[0,1]", j(L.derivedEngineCells(2, 4, "n")));
  ok("driver's seat is the left cell of the rank behind the engine", L.derivedSeatOrder(2, 4, "n")[0] === 2, j(L.derivedSeatOrder(2, 4, "n")));
  ok("the passenger sits beside them, right of the driver", L.derivedSeatOrder(2, 4, "n")[1] === 3);
  ok("remaining seats run rank by rank to the tail", j(L.derivedSeatOrder(2, 4, "n")) === "[2,3,4,5,6,7]", j(L.derivedSeatOrder(2, 4, "n")));
  ok("no cell is both engine and seat", L.derivedSeatOrder(2, 4, "n").every(i => !L.derivedEngineCells(2, 4, "n").includes(i)));

  // The heading is what turns the layout, not the footprint.
  ok("turning the same footprint south mirrors the whole order", j(L.derivedSeatOrder(2, 4, "s")) === "[5,4,3,2,1,0]", j(L.derivedSeatOrder(2, 4, "s")));
  ok("south-facing engine sits on the bottom rank", j(L.derivedEngineCells(2, 4, "s")) === "[7,6]", j(L.derivedEngineCells(2, 4, "s")));
  ok("an east-facing engine is the right-hand column", j(L.derivedEngineCells(2, 4, "e")) === "[1,3,5,7]", j(L.derivedEngineCells(2, 4, "e")));
  ok("an east-facing driver sits top-left of the remaining cells", L.derivedSeatOrder(2, 4, "e")[0] === 0, j(L.derivedSeatOrder(2, 4, "e")));

  // Unset heading: the core's own rotation-zero convention, not a guess from the footprint's shape.
  ok("the rotation-zero convention is south", L.ROTATION_ZERO_FRONT === "s", L.ROTATION_ZERO_FRONT);
  ok("an unset heading takes the convention whatever the footprint's shape",
    L.defaultFrontFor(4, 2) === "s" && L.defaultFrontFor(2, 4) === "s",
    `${L.defaultFrontFor(4, 2)} / ${L.defaultFrontFor(2, 4)}`);
  ok("an unset heading resolves to it", L.resolveFront("") === "s" && L.resolveFront(null) === "s");
  ok("negative case: a nonsense heading falls back to the convention", L.resolveFront("up") === "s", L.resolveFront("up"));
  // The heading vector the facing math reads: south at 0, clockwise on screen, matching the core's
  // own auto-rotate formula (east is written as -90).
  const hv = (d) => { const v = L.headingVector(d); return `${Math.round(v.x)},${Math.round(v.y)}`; };
  ok("rotation 0 points south", hv(0) === "0,1", hv(0));
  ok("rotation -90 points east", hv(-90) === "1,0", hv(-90));
  ok("rotation 90 points west", hv(90) === "-1,0", hv(90));
  ok("rotation 180 points north", hv(180) === "0,-1", hv(180));

  // A footprint only one rank deep has no room for an engine region.
  ok("single-rank footprint declares no engine region", j(L.derivedEngineCells(4, 1, "n")) === "[]", j(L.derivedEngineCells(4, 1, "n")));
  ok("single-rank footprint keeps every cell as seating", j(L.derivedSeatOrder(4, 1, "n")) === "[0,1,2,3]", j(L.derivedSeatOrder(4, 1, "n")));

  // The painted grid (Layer 2): painted roles replace the derived ones wholesale.
  ok("nothing painted reads as the derived layout", L.layoutFor(2, 4, "n", "").painted === false);
  ok("an unpainted grid shows the derived roles", L.formatCells(L.layoutFor(2, 4, "n", "").cells) === "EESSSSSS",
    L.formatCells(L.layoutFor(2, 4, "n", "").cells));
  const bus = L.layoutFor(2, 4, "n", "..SSSSEE");
  ok("a painted grid reads as painted", bus.painted === true);
  ok("painted seats replace the derived order", j(bus.seats) === "[2,3,4,5]", j(bus.seats));
  ok("a painted rear engine replaces the derived front one", j(bus.engine) === "[6,7]", j(bus.engine));
  ok("the painted string round-trips", L.formatCells(bus.cells) === "..SSSSEE", L.formatCells(bus.cells));
  ok("a grid painted for a different footprint is ignored, not stretched", L.layoutFor(2, 4, "n", "..S").painted === false);
  ok("negative case: a grid with no seats falls back to derived seating",
    j(L.layoutFor(2, 4, "n", "EEEE....").seats) === "[2,3,4,5,6,7]", j(L.layoutFor(2, 4, "n", "EEEE....").seats));
  ok("clicking a cell cycles body → seat → engine → body",
    L.cycleCell(".") === "S" && L.cycleCell("S") === "E" && L.cycleCell("E") === ".");

  // ⭐ PAINTED SEATS FILL FRONT-RELATIVE, NOT IN READING ORDER (user ruling 2026-08-13). The two
  // orders are the same thing on a north-facing vehicle — which is why every painted leg above is
  // blind to the difference — and they disagree outright the moment the nose points sideways. This
  // is that case, stated in coordinates: a 4-wide 2-deep car facing EAST, seats painted in the two
  // top corners. Reading order would make the top-LEFT cell (index 0) the driver's, which on this
  // car is the REAR-left seat; the vehicle's own rank/file order makes it index 3, the FRONT-left
  // seat — the same cell the derived layout would call the driver's. One car, one driver's seat.
  const east = L.layoutFor(4, 2, "e", "S..S....");
  ok("an east-facing car fills its painted seats front-rank first",
    j(east.seats) === "[3,0]", j(east.seats));
  ok("so the painted driver takes the FRONT-left seat, not the top-left cell",
    east.seats[0] === L.cellIndexAt(4, 2, "e", 0, 0) && east.seats[0] !== 0,
    `driver cell ${east.seats[0]}, front-left is ${L.cellIndexAt(4, 2, "e", 0, 0)}, top-left is 0`);
  ok("painted and derived agree about which cell is the driver's on the same car",
    L.layoutFor(4, 2, "e", "..S.S...").seats[0] === L.layoutFor(4, 2, "e", "").seats[0],
    j({ painted: L.layoutFor(4, 2, "e", "..S.S...").seats, derived: L.layoutFor(4, 2, "e", "").seats }));
  ok("a north-facing car is unaffected — its ranks already run in reading order (negative)",
    j(L.layoutFor(2, 4, "n", "..SSSSEE").seats) === "[2,3,4,5]", j(L.layoutFor(2, 4, "n", "..SSSSEE").seats));

  // Type-aware cover prefills (Core p.99 values, ruled D2).
  ok("cycle types contribute no cover", L.coverProfileFor("cycle").providesCover === false && L.coverProfileFor("cycle").bodySp === 0, j(L.coverProfileFor("cycle")));
  ok("AV types prefill body SP 40", L.coverProfileFor("AV-4").bodySp === 40 && L.coverProfileFor("AV-6").bodySp === 40, j(L.coverProfileFor("AV-4")));
  ok("armoured ground types prefill body SP 40", L.coverProfileFor("tank").bodySp === 40 && L.coverProfileFor("APC").bodySp === 40);
  ok("ordinary vehicles prefill the car-body 10", L.coverProfileFor("car").bodySp === 10 && L.coverProfileFor("truck").bodySp === 10, j(L.coverProfileFor("truck")));
  ok("the engine-block prefill is 35 everywhere it applies", L.coverProfileFor("car").engineSp === 35 && L.coverProfileFor("tank").engineSp === 35);
  ok("a typed SP overrides the type prefill", L.coverSpFor({ vehicleType: "car", layout: { bodySp: 25 } }).bodySp === 25);
  ok("a typed 0 is kept as a real answer, not treated as unset", L.coverSpFor({ vehicleType: "car", layout: { bodySp: 0 } }).bodySp === 0);
  ok("an unset override falls back to the type prefill", L.coverSpFor({ vehicleType: "AV-4", layout: {} }).bodySp === 40);
  return out;
});
for (const c of layoutPure) check(c.n, c.p, c.d);

/* ------------------------------------------------------------------ N. Front picker + live re-seat */

const frontLive = await page.evaluate(async ({ sceneId }) => {
  const scene = game.scenes.get(sceneId);
  const vehicle = game.actors.getName("__PW__Ride");
  const vTok = scene.tokens.find(t => t.actorId === vehicle.id);
  const rider = scene.tokens.find(t => t.name === "__PW__Rider");
  const grid = scene.grid.size;

  // A 2-wide, 4-deep car facing north — the shape the seating rule is written about. The HULL is
  // what a footprint edit writes now; the token's frame square is derived from it by the canvas layer,
  // so the wait is on the frame reaching the square that hull needs (4x4).
  await vehicle.update({ "system.layout.hullW": 2, "system.layout.hullH": 4, "system.layout.front": "n" });
  for (let i = 0; i < 40 && !(scene.tokens.get(vTok.id).width === 4 && scene.tokens.get(vTok.id).height === 4); i++) {
    await new Promise(r => setTimeout(r, 200));
  }
  await window.__pwSettle(scene.id, rider.id);
  const v = scene.tokens.get(vTok.id);
  const hull = window.__pwHull(v, grid);
  const north = { x: scene.tokens.get(rider.id).x, y: scene.tokens.get(rider.id).y };

  // Same footprint, nose turned around: the driver's seat moves to the mirrored cell.
  await vehicle.update({ "system.layout.front": "s" });
  await new Promise(r => setTimeout(r, 600));
  await window.__pwSettle(scene.id, rider.id);
  const south = { x: scene.tokens.get(rider.id).x, y: scene.tokens.get(rider.id).y };

  // The picker itself, driven as a user drives it.
  await vehicle.sheet.render(true);
  await new Promise(r => setTimeout(r, 900));
  const root = vehicle.sheet.element;
  const btns = [...root.querySelectorAll(".cp-veh-front-btn")];
  const litBefore = btns.filter(b => b.classList.contains("cp-active")).map(b => b.dataset.front);
  const rawKeyLeak = /CYBERPUNK\./.test(root.querySelector(".cp-veh-layout")?.textContent ?? "")
    || btns.some(b => /CYBERPUNK\./.test(b.title));
  btns.find(b => b.dataset.front === "w")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 900));
  const storedAfterClick = vehicle.system.layout.front;
  const litAfter = [...vehicle.sheet.element.querySelectorAll(".cp-veh-front-btn.cp-active")].map(b => b.dataset.front);
  await vehicle.sheet.close();

  // The combat layout carries the same picker (it renders only under the Maximum Metal gate, so the
  // include is asserted at the source rather than by flipping a world setting mid-run).
  const mmSrc = await fetch("/modules/cp2020-augmented/templates/actor/vehicle-sheet.hbs").then(r => r.text());

  return {
    grid, vx: hull.x, vy: hull.y, north, south,
    buttonCount: btns.length, litBefore, litAfter, storedAfterClick, rawKeyLeak,
    mmHasPicker: mmSrc.includes("parts/vehicle-layout.hbs"),
    handle: { w: v.width, h: v.height },
    hull: { w: hull.w, h: hull.h },
  };
}, setup);

check("a footprint edit sets the vehicle's HULL to 2x4",
  frontLive.hull.w === 2 && frontLive.hull.h === 4, `hull ${frontLive.hull.w}x${frontLive.hull.h}`);
check("and the handle follows it to the square that carries that hull (4x4)",
  frontLive.handle.w === 4 && frontLive.handle.h === 4, `frame ${frontLive.handle.w}x${frontLive.handle.h}`);
check("north-facing driver sits in the left cell of rank 2 (exact)",
  frontLive.north.x === frontLive.vx && frontLive.north.y === frontLive.vy + frontLive.grid,
  `x=${frontLive.north.x} y=${frontLive.north.y} vs v=${frontLive.vx},${frontLive.vy}`);
check("turning the nose south re-seats the rider to the mirrored cell (exact)",
  frontLive.south.x === frontLive.vx + frontLive.grid && frontLive.south.y === frontLive.vy + 2 * frontLive.grid,
  `x=${frontLive.south.x} y=${frontLive.south.y}`);
check("the picker offers all four headings", frontLive.buttonCount === 4, String(frontLive.buttonCount));
check("exactly the stored heading is lit", frontLive.litBefore.length === 1 && frontLive.litBefore[0] === "s",
  frontLive.litBefore.join(","));
check("clicking a heading stores it", frontLive.storedAfterClick === "w", String(frontLive.storedAfterClick));
check("the lit heading follows the click", frontLive.litAfter.length === 1 && frontLive.litAfter[0] === "w",
  frontLive.litAfter.join(","));
check("the picker leaks no raw key", frontLive.rawKeyLeak === false);
check("the Maximum Metal layout carries the same picker", frontLive.mmHasPicker === true);

/* ------------------------------------------------------------------ O. the paint grid, driven */

const paint = await page.evaluate(async ({ sceneId }) => {
  const scene = game.scenes.get(sceneId);
  const vehicle = game.actors.getName("__PW__Ride");
  const grid = scene.grid.size;
  await vehicle.update({ "system.layout.front": "n", "system.layout.cells": "" });
  await new Promise(r => setTimeout(r, 500));

  await vehicle.sheet.render(true);
  await new Promise(r => setTimeout(r, 900));
  const cellsOf = () => [...vehicle.sheet.element.querySelectorAll(".cp-veh-cell")];
  const rowsOf = () => [...vehicle.sheet.element.querySelectorAll(".cp-veh-cellrow")];
  const roleOf = (btn) => [...btn.classList].find(c => c.startsWith("cp-veh-cell-"))?.replace("cp-veh-cell-", "") ?? "";

  const opened = {
    count: cellsOf().length,
    rows: rowsOf().length,
    perRow: rowsOf()[0]?.querySelectorAll(".cp-veh-cell").length ?? 0,
    roles: cellsOf().map(roleOf),
    rawKeyLeak: cellsOf().some(b => /CYBERPUNK\./.test(b.title)),
  };

  // Two real clicks on the top-left cell: engine → body → seat (it opens as engine, since the nose
  // is north and that is the derived hood).
  const clickCell = async (idx) => {
    cellsOf().find(b => Number(b.dataset.index) === idx)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise(r => setTimeout(r, 700));
  };
  await clickCell(0);
  const afterOne = { stored: vehicle.system.layout.cells, role: roleOf(cellsOf()[0]) };
  await clickCell(0);
  const afterTwo = { stored: vehicle.system.layout.cells, role: roleOf(cellsOf()[0]) };
  await vehicle.sheet.close();

  // A bus: rear engine, four seats down the middle.
  await vehicle.update({ "system.layout.cells": "..SSSSEE" });
  await new Promise(r => setTimeout(r, 700));
  const rider = scene.tokens.find(t => t.name === "__PW__Rider");
  const driver2 = scene.tokens.find(t => t.name === "__PW__Driver2");
  const canvasMod = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-canvas.js`);
  const vTok = scene.tokens.find(t => t.actorId === vehicle.id);
  // Both riders out first, so the painted seats are filled from the top.
  await canvasMod.disembark(rider);
  await canvasMod.disembark(driver2).catch(() => {});
  await new Promise(r => setTimeout(r, 700));
  await canvasMod.boardVehicle(scene.tokens.get(rider.id), vehicle, vTok);
  await canvasMod.boardVehicle(scene.tokens.get(driver2.id), vehicle, vTok);
  await window.__pwSettle(scene.id, rider.id);
  await window.__pwSettle(scene.id, driver2.id);
  // Snapshot NOW, by value: these are live documents and the Reset below re-seats both riders.
  const snap = (t) => ({ x: t.x, y: t.y, idx: t.flags["cp2020-augmented"].seatIndex });
  const seatA = snap(scene.tokens.get(rider.id));
  const seatB = snap(scene.tokens.get(driver2.id));

  // Reset, driven from the sheet.
  await vehicle.sheet.render(true);
  await new Promise(r => setTimeout(r, 900));
  vehicle.sheet.element.querySelector(".cp-veh-layout-reset")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 1000));
  const afterReset = {
    cells: vehicle.system.layout.cells,
    front: vehicle.system.layout.front,
    roles: [...vehicle.sheet.element.querySelectorAll(".cp-veh-cell")].map(roleOf),
  };
  await window.__pwSettle(scene.id, rider.id);
  afterReset.riderX = scene.tokens.get(rider.id).x;
  afterReset.riderY = scene.tokens.get(rider.id).y;
  await vehicle.sheet.close();

  const hull = window.__pwHull(scene.tokens.get(vTok.id), grid);
  return {
    grid, vx: hull.x, vy: hull.y, opened, afterOne, afterTwo, afterReset, seatA, seatB,
  };
}, setup);

check("the grid draws one cell per footprint square", paint.opened.count === 8, String(paint.opened.count));
check("the grid is laid out as the footprint's rows", paint.opened.rows === 4 && paint.opened.perRow === 2,
  `${paint.opened.rows}x${paint.opened.perRow}`);
check("an unpainted grid opens showing the derived roles",
  paint.opened.roles.join(",") === "engine,engine,seat,seat,seat,seat,seat,seat", paint.opened.roles.join(","));
check("the grid leaks no raw key", paint.opened.rawKeyLeak === false);
check("one click cycles the cell and materializes the whole grid",
  paint.afterOne.stored === ".ESSSSSS" && paint.afterOne.role === "body", `${paint.afterOne.stored} / ${paint.afterOne.role}`);
check("a second click carries it on round the cycle",
  paint.afterTwo.stored === "SESSSSSS" && paint.afterTwo.role === "seat", `${paint.afterTwo.stored} / ${paint.afterTwo.role}`);
check("boarding fills the first painted seat (exact)",
  paint.seatA.idx === 0 && paint.seatA.x === paint.vx && paint.seatA.y === paint.vy + paint.grid,
  `idx=${paint.seatA.idx} x=${paint.seatA.x} y=${paint.seatA.y}`);
check("the next rider takes the second painted seat (exact)",
  paint.seatB.idx === 1 && paint.seatB.x === paint.vx + paint.grid && paint.seatB.y === paint.vy + paint.grid,
  `idx=${paint.seatB.idx} x=${paint.seatB.x} y=${paint.seatB.y}`);
check("Reset clears the painted grid and the picked heading",
  paint.afterReset.cells === "" && paint.afterReset.front === "",
  `cells="${paint.afterReset.cells}" front="${paint.afterReset.front}"`);
// Reset drops back to the derived heading for a 2-wide 4-deep footprint, which is SOUTH: the
// engine is the bottom row and the driver's seat the right-hand cell of the row above it.
check("after Reset the grid shows the derived roles again",
  paint.afterReset.roles.join(",") === "seat,seat,seat,seat,seat,seat,engine,engine",
  paint.afterReset.roles.join(","));
check("after Reset the rider sits in the derived driver's seat (exact)",
  paint.afterReset.riderX === paint.vx + paint.grid && paint.afterReset.riderY === paint.vy + 2 * paint.grid,
  `x=${paint.afterReset.riderX} y=${paint.afterReset.riderY}`);

/* ------------------------------ O2. painted seats fill front-relative, driven on a real car ----- */
// The pure legs above state the ruling; this one puts a rider in the seat. A 4-wide 2-deep car facing
// EAST with seats painted in its two top corners is the case where reading order and the vehicle's own
// order disagree: reading order seats the driver in the REAR-left cell, front-relative order in the
// FRONT-left one. The car is put back the way this section found it afterwards.
const eastSeat = await page.evaluate(async ({ sceneId }) => {
  const scene = game.scenes.get(sceneId);
  const vehicle = game.actors.getName("__PW__Ride");
  const grid = scene.grid.size;
  const canvasMod = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-canvas.js`);
  const rider = scene.tokens.find(t => t.name === "__PW__Rider");
  const driver2 = scene.tokens.find(t => t.name === "__PW__Driver2");

  for (const t of [rider, driver2]) await canvasMod.disembark(scene.tokens.get(t.id)).catch(() => {});
  await new Promise(r => setTimeout(r, 700));

  // A 4-across, 2-deep HULL. The frame square the canvas layer derives for it is 4x4, so the hull
  // sits inset half a square down inside it — which is exactly why the expectations below are
  // measured from the hull's own corner and not the token's.
  await vehicle.update({
    "system.layout.hullW": 4, "system.layout.hullH": 2,
    "system.layout.front": "e", "system.layout.cells": "S..S....",
  });
  await new Promise(r => setTimeout(r, 1400));
  const vTok = scene.tokens.find(t => t.actorId === vehicle.id);
  await new Promise(r => setTimeout(r, 600));

  await canvasMod.boardVehicle(scene.tokens.get(rider.id), vehicle, vTok);
  await window.__pwSettle(scene.id, rider.id);
  const seated = scene.tokens.get(rider.id);
  const hull = window.__pwHull(scene.tokens.get(vTok.id), grid);
  const out = {
    grid, vx: hull.x, vy: hull.y,
    x: seated.x, y: seated.y, idx: seated.flags["cp2020-augmented"].seatIndex,
  };

  // Put the car back: out of the seat, original footprint, no painted grid, no picked heading.
  await canvasMod.disembark(scene.tokens.get(rider.id)).catch(() => {});
  await new Promise(r => setTimeout(r, 600));
  await vehicle.update({
    "system.layout.hullW": 2, "system.layout.hullH": 4,
    "system.layout.front": "", "system.layout.cells": "",
  });
  await new Promise(r => setTimeout(r, 1400));
  await canvasMod.boardVehicle(scene.tokens.get(rider.id), vehicle, vTok);
  await window.__pwSettle(scene.id, rider.id);
  out.restoredHullW = vehicle.system.layout.hullW;
  out.restoredFrameW = scene.tokens.find(t => t.actorId === vehicle.id).width;
  return out;
}, setup);

check("the painted driver's seat is the car's FRONT-left cell, in coordinates",
  eastSeat.idx === 0 && eastSeat.x === eastSeat.vx + 3 * eastSeat.grid && eastSeat.y === eastSeat.vy,
  `idx=${eastSeat.idx} x=${eastSeat.x} y=${eastSeat.y} (front-left is ${eastSeat.vx + 3 * eastSeat.grid},${eastSeat.vy}; top-left would be ${eastSeat.vx},${eastSeat.vy})`);
check("and it is NOT the top-left cell reading order would have picked (negative)",
  eastSeat.x !== eastSeat.vx, `x=${eastSeat.x} vs vehicle x=${eastSeat.vx}`);
check("the car is put back on its original footprint for the sections that follow",
  eastSeat.restoredHullW === 2 && eastSeat.restoredFrameW === 4,
  `hull ${eastSeat.restoredHullW} across in a ${eastSeat.restoredFrameW}-square frame`);

/* ------------------------------------------------------------------ P. free rotation (Layer 4) */

const spin = await page.evaluate(async ({ sceneId }) => {
  const out = { checks: [] };
  const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
  const L = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-layout.js`);
  const S = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-seating.js`);

  // A 4-wide, 2-deep car at a known place, so every expectation below is a concrete coordinate.
  const rect = { x: 1000, y: 1000, w: 400, h: 200 };
  // An EXPLICITLY east-facing car, so this block measures free rotation of a known layout rather
  // than whatever heading an unpicked vehicle happens to derive.
  const order = L.layoutFor(4, 2, "e", "").seats;         // east: [2,6,1,5,0,4]
  const seat = (i, deg) => S.seatSlotPosition(rect, 100, i, { w: 1, h: 1 }, order, deg);
  const j = (v) => JSON.stringify(v);

  ok("unturned, the driver sits in the derived cell (1200,1000)", j(seat(0, 0)) === '{"x":1200,"y":1000}', j(seat(0, 0)));
  ok("turned a quarter, the driver's seat swings to (1200,1100)", j(seat(0, 90)) === '{"x":1200,"y":1100}', j(seat(0, 90)));
  ok("the passenger swings with them, to (1100,1100)", j(seat(1, 90)) === '{"x":1100,"y":1100}', j(seat(1, 90)));
  ok("at 45° the seat lands off the grid, as it should (1221,1050)", j(seat(0, 45)) === '{"x":1221,"y":1050}', j(seat(0, 45)));
  ok("an odd angle is carried as given, not snapped (37° → 1220,1040)", j(seat(0, 37)) === '{"x":1220,"y":1040}', j(seat(0, 37)));

  // Containment: a point the TRUE footprint contains at 45°, which the axis-aligned box does not.
  const p = { x: 1341, y: 1241 };
  const inPlainBox = p.x >= 1000 && p.x <= 1400 && p.y >= 1000 && p.y <= 1200;
  ok("the turned footprint contains the point at its swung-out nose", L.pointInRotatedRect(p, rect, 45) === true);
  ok("the axis-aligned box would have missed that point", inPlainBox === false);
  ok("negative case: a point outside the turned footprint is still outside",
    L.pointInRotatedRect({ x: 1600, y: 1600 }, rect, 45) === false);
  ok("at 0° the turned test and the plain rectangle agree",
    L.pointInRotatedRect({ x: 1100, y: 1100 }, rect, 0) === true
    && L.pointInRotatedRect({ x: 1341, y: 1241 }, rect, 0) === false);
  return out;
}, setup);
for (const c of spin.checks) check(c.n, c.p, c.d);

const spinLive = await page.evaluate(async ({ sceneId }) => {
  const scene = game.scenes.get(sceneId);
  const vehicle = game.actors.getName("__PW__Ride");
  const vTok = scene.tokens.find(t => t.actorId === vehicle.id);
  const rider = scene.tokens.find(t => t.name === "__PW__Rider");
  const before = { x: scene.tokens.get(rider.id).x, y: scene.tokens.get(rider.id).y };

  await vTok.update({ rotation: 90 });
  // The re-seat waits out a quiet interval after the last rotation update, so give the settle room.
  await new Promise(r => setTimeout(r, 1400));
  await window.__pwSettle(scene.id, rider.id);
  const after = { x: scene.tokens.get(rider.id).x, y: scene.tokens.get(rider.id).y };

  const placeable = canvas.tokens.get(vTok.id);
  placeable?.renderFlags?.set?.({ refresh: true });
  await new Promise(r => setTimeout(r, 400));
  const drawn = canvas.tokens.get(vTok.id);

  const shape = {
    outline: !!drawn?.cpFootprintOutline && drawn.cpFootprintOutline.destroyed !== true,
    isGraphics: drawn?.cpFootprintOutline instanceof PIXI.Graphics,
    childOfToken: drawn?.cpFootprintOutline?.parent === drawn,
    clickThrough: drawn?.cpFootprintOutline?.eventMode === "none",
    borderAlpha: drawn?.border?.alpha ?? null,
    hitAreaPoints: Array.isArray(drawn?.hitArea?.points) ? drawn.hitArea.points.length : 0,
    tokenImg: drawn?.document?.texture?.src ?? "",
    docRotation: scene.tokens.get(vTok.id).rotation,
    docWidth: scene.tokens.get(vTok.id).width,
    docHeight: scene.tokens.get(vTok.id).height,
    hullW: vehicle.system.layout?.hullW ?? null,
    hullH: vehicle.system.layout?.hullH ?? null,
  };
  await vTok.update({ rotation: 0 });
  await new Promise(r => setTimeout(r, 1400));
  await window.__pwSettle(scene.id, rider.id);
  const restored = { x: scene.tokens.get(rider.id).x, y: scene.tokens.get(rider.id).y };
  const hull = window.__pwHull(scene.tokens.get(vTok.id), scene.grid.size);
  return { vx: hull.x, vy: hull.y, before, after, restored, shape };
}, setup);

// 2-wide, 4-deep, derived south: seat 0 is cell 5 (centre one square right and 2.5 squares down of
// the footprint's top-left). Turned a quarter clockwise about the footprint's centre, that centre
// lands one square right and 2.5 down of… the LEFT edge — i.e. the seat's top-left is (vx, vy+200).
check("the rider re-seats to the turned cell after the heading settles (exact)",
  spinLive.after.x === spinLive.vx && spinLive.after.y === spinLive.vy + 200,
  `after=${spinLive.after.x},${spinLive.after.y} v=${spinLive.vx},${spinLive.vy}`);
check("that is a different square from the unturned one",
  !(spinLive.after.x === spinLive.before.x && spinLive.after.y === spinLive.before.y),
  `before=${spinLive.before.x},${spinLive.before.y}`);
check("turning back restores the unturned seat exactly",
  spinLive.restored.x === spinLive.before.x && spinLive.restored.y === spinLive.before.y,
  `restored=${spinLive.restored.x},${spinLive.restored.y}`);
check("the handle carries our own footprint outline", spinLive.shape.outline === true);
check("the outline is drawn as the token's own child graphic",
  spinLive.shape.isGraphics === true && spinLive.shape.childOfToken === true,
  `graphics=${spinLive.shape.isGraphics} child=${spinLive.shape.childOfToken}`);
check("the outline never eats a click meant for the token", spinLive.shape.clickThrough === true,
  String(spinLive.shape.clickThrough));
check("core's own rectangular frame is out of the picture on a vehicle handle",
  spinLive.shape.borderAlpha === 0, String(spinLive.shape.borderAlpha));
check("the pointer area is the drawn hull polygon, not core's square",
  spinLive.shape.hitAreaPoints === 8, `${spinLive.shape.hitAreaPoints} polygon coordinates`);
check("the token keeps its image, a square frame, and the hull recorded beside it",
  !!spinLive.shape.tokenImg && spinLive.shape.docWidth === 4 && spinLive.shape.docHeight === 4
  && spinLive.shape.hullW === 2 && spinLive.shape.hullH === 4,
  `frame ${spinLive.shape.docWidth}x${spinLive.shape.docHeight}, hull ${spinLive.shape.hullW}x${spinLive.shape.hullH}, img=${spinLive.shape.tokenImg}`);
check("the heading is stored on the token itself, unsnapped", spinLive.shape.docRotation === 90,
  String(spinLive.shape.docRotation));

/* ------------------------------------------------------------------ L. chemical shell leaves a cloud on this core */

const cloud = await page.evaluate(async ({ sceneId }) => {
  const scene = game.scenes.get(sceneId);
  const shim = await import(`/modules/cp2020-augmented/module/combat/area-shapes.js`);
  const ord = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-ordnance.js`);
  const priorSetting = game.settings.get("cp2020-augmented", "gasGrenadeCloudEnabled");
  if (!priorSetting) await game.settings.set("cp2020-augmented", "gasGrenadeCloudEnabled", true);
  const useRegions = shim.usesRegions();
  const before = { regions: scene.regions.size, templates: scene.templates?.size ?? 0 };
  await ord.resolveWarheadBurst({
    origin: { x: 1500, y: 1500 }, warhead: "chemical", pen: 0, burstM: 10,
    payload: { weaponName: "__PW__Shell" }, scene,
  });
  await new Promise(r => setTimeout(r, 800));
  const after = { regions: scene.regions.size, templates: scene.templates?.size ?? 0 };
  const areas = shim.areasByFlag(scene, "isGasCloud");
  let behavior = null, region = null;
  if (useRegions) {
    region = [...scene.regions].find(r => [...(r.behaviors ?? [])].some(b => b.type === "cp2020-augmented.gasCloud"));
    const b = region ? [...region.behaviors].find(x => x.type === "cp2020-augmented.gasCloud") : null;
    behavior = b ? { type: b.type, turnsLeft: b.system.turnsLeft, weaponName: b.system.weaponName } : null;
  }
  if (!priorSetting) await game.settings.set("cp2020-augmented", "gasGrenadeCloudEnabled", priorSetting);
  return {
    useRegions, before, after, legacyFlagged: areas.length,
    behavior, regionId: region?.id ?? null,
    docCount: useRegions ? after.regions - before.regions : after.templates - before.templates,
  };
}, setup);
check("chemical shell creates exactly one area document on this core", cloud.docCount === 1,
  `regions ${cloud.before.regions}→${cloud.after.regions}, templates ${cloud.before.templates}→${cloud.after.templates}`);
if (cloud.useRegions) {
  check("cloud carries the gas behavior (v14 path)", cloud.behavior?.type === "cp2020-augmented.gasCloud", JSON.stringify(cloud.behavior));
  check("cloud behavior seeds the shell's own duration + name",
    cloud.behavior?.turnsLeft === 3 && cloud.behavior?.weaponName === "__PW__Shell", JSON.stringify(cloud.behavior));
} else {
  check("cloud carries the legacy gas flags (v13 path)", cloud.legacyFlagged === 1, String(cloud.legacyFlagged));
}

/* ------------------------------------------------------------------ cleanup */

const cleaned = await page.evaluate(async ({ sceneId, activeBefore }) => {
  const scene = game.scenes.get(sceneId);
  await scene?.delete();
  for (const a of [...game.actors]) if (a.name.startsWith("__PW__")) await a.delete();
  const folder = game.folders.find(f => f.type === "Actor" && f.name === "Vehicles");
  if (folder && folder.contents.length === 0) await folder.delete();
  return {
    scenesLeft: game.scenes.filter(s => s.name.startsWith("__PW__")).length,
    actorsLeft: game.actors.filter(a => a.name.startsWith("__PW__")).length,
    activeUnchanged: (game.scenes.active?.id ?? null) === activeBefore,
  };
}, setup);
check("probe scene and fixtures removed", cleaned.scenesLeft === 0 && cleaned.actorsLeft === 0,
  `scenes=${cleaned.scenesLeft} actors=${cleaned.actorsLeft}`);
check("active scene unchanged", cleaned.activeUnchanged === true);

// The rig is shared: other work running in the same world logs its own errors into this
// page. `Invalid Asset` comes from the effects asset registry, which nothing in this spec
// touches, so it is excluded by name rather than being read as a fault here. The null-volume
// line is the effect engine's own teardown race (an effect's sound handle torn down mid-stop),
// whitelisted by the status-fx and fx-rail specs as engine-side — same exclusion here.
const realErrors = errors.filter(e => !/compatibility|deprecat|screen resolution|Failed to load resource|Invalid Asset|Cannot set properties of null \(setting 'volume'\)/i.test(e));
check("0 console errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
