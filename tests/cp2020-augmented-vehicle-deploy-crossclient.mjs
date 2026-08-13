/**
 * KEEPER (two-session, cross-client): vehicle deploy request + boarding gesture.
 *
 * Contract under test (user rulings 2026-07-31):
 *  - player clicks Deploy on a vehicle ITEM → name dialog (prefilled "[player]'s [vehicle]",
 *    editable) → socket request → active GM gets approve/decline dialog → on approve the GM
 *    client creates the vehicle ACTOR (seeded from item stats, requester = OWNER, flags link).
 *  - duplicate click → "already deployed as <current name>" (rename-proof: link is flags-only).
 *  - decline → no actor.
 *  - embark/disembark: token-HUD button on a crew token near a vehicle token toggles the
 *    boardedVehicle flag; crew follows vehicle movement while boarded.
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

const browser = await chromium.launch();
const gmErrors = [];

// ---------- GM session ----------
const gm = await join(browser, "^gamemaster$", [GM_PW]);
gm.page.on("console", m => { if (m.type() === "error") gmErrors.push(m.text()); });

// setup: active scene, player-owned driver with two vehicle items; clean stale runs
const setup = await gm.page.evaluate(async SCOPE => {
  const activeBefore = game.scenes.active?.id ?? null;
  const player = game.users.find(u => !u.isGM && /test user 1/i.test(u.name)) ?? game.users.find(u => !u.isGM);
  if (!player) return { error: "no player user" };

  // stale cleanup
  for (const a of [...game.actors]) {
    if (a.name.startsWith("__PW__") || a.flags?.[SCOPE]?.sourceItemUuid?.includes("__PW__")
        || ["Keeper Custom Ride", "Renamed Ride", "Declined Ride", "__PW__GarageCar"].includes(a.name)) await a.delete();
  }

  const driver = await Actor.create({
    name: "__PW__Driver", type: "character",
    ownership: { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
  });

  // The whole flow runs on a scene of our own — the deploy now PLACES a token beside the
  // requester, and it must never land on the world's active scene. Observer by default so the
  // player client can view it.
  for (const s of [...game.scenes]) if (s.name === "__PW__DeployScene") await s.delete();
  const scene = await Scene.create({
    name: "__PW__DeployScene", width: 3000, height: 3000, grid: { size: 100 },
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
  });
  const [anchorTok] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PW__Driver", actorId: driver.id, actorLink: true, x: 500, y: 500, width: 1, height: 1,
    texture: { src: "icons/svg/mystery-man.svg" },
  }]);

  const pack = game.packs.get("cyberpunk2020.vehicles");
  const idx = await pack.getIndex({ fields: ["type", "system.sdp"] });
  const src = await pack.getDocument(idx.find(e => e.type === "vehicle" && Number(e.system?.sdp?.max) > 0)._id);
  const [itemA, itemB] = await driver.createEmbeddedDocuments("Item", [src.toObject(), src.toObject()]);
  return {
    playerId: player.id, playerName: player.name, driverId: driver.id,
    activeBefore, sceneId: scene.id, grid: scene.grid.size,
    anchorTokenId: anchorTok.id, anchor: { x: anchorTok.x, y: anchorTok.y },
    itemAUuid: itemA.uuid, itemBUuid: itemB.uuid, srcName: src.name,
    expected: {
      topSpeed: Number(src.system.speed?.max) || Number(src.system.speed?.value) || 0,
      sdpMax: Number(src.system.sdp?.max) || 0,
      sp: Number(src.system.sp) || 0,
    },
  };
}, SCOPE);
if (setup.error) { console.log("SETUP FAILED:", setup.error); process.exit(1); }

// ---------- player session ----------
const pl = await join(browser, "test user 1", ["", GM_PW]);

// capture player notifications
await pl.page.evaluate(() => {
  window.__pwNotes = [];
  for (const kind of ["info", "warn"]) {
    const orig = ui.notifications[kind].bind(ui.notifications);
    ui.notifications[kind] = (msg, ...rest) => { window.__pwNotes.push({ kind, msg: String(msg) }); return orig(msg, ...rest); };
  }
});

// The player looks at the probe scene and selects their own token — the deploy must land beside
// exactly that token, on exactly that scene (the anchor is read on the requester's client).
const playerView = await pl.page.evaluate(async ({ sceneId, anchorTokenId }) => {
  await game.scenes.get(sceneId).view();
  for (let i = 0; i < 50 && canvas.scene?.id !== sceneId; i++) await new Promise(r => setTimeout(r, 200));
  for (let i = 0; i < 50 && !canvas.tokens.get(anchorTokenId); i++) await new Promise(r => setTimeout(r, 200));
  canvas.tokens.get(anchorTokenId)?.control({ releaseOthers: true });
  return { viewing: canvas.scene?.id === sceneId, controlled: canvas.tokens.controlled.length };
}, setup);
check("player client is viewing the probe scene with its token selected",
  playerView.viewing === true && playerView.controlled === 1, JSON.stringify(playerView));

// A. happy path: request with a CUSTOM name
await pl.page.evaluate(async ({ itemAUuid }) => {
  const item = await fromUuid(itemAUuid);
  const m = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-deploy-request.js`);
  window.__pwDeployPromise = m.requestVehicleDeploy(item);   // resolves after dialog
}, setup);

await pl.page.waitForSelector('.cp-vehicle-deploy-name input[name="cp-deploy-name"]', { timeout: 10000 });
const prefill = await pl.page.inputValue('.cp-vehicle-deploy-name input[name="cp-deploy-name"]');
check("name dialog prefilled '[owning actor]'s [vehicle]'", prefill === `__PW__Driver's ${setup.srcName}`, prefill);
await pl.page.screenshot({ path: `${SHOT_DIR}/deploy-name-dialog.png` });
await pl.page.fill('.cp-vehicle-deploy-name input[name="cp-deploy-name"]', "Keeper Custom Ride");
await pl.page.click('.cp-vehicle-deploy-name button[data-action="ok"]');

// GM: approve dialog appears
await gm.page.waitForSelector(".cp-vehicle-deploy-approve", { timeout: 10000 });
const approveText = await gm.page.textContent(".cp-vehicle-deploy-approve");
check("GM approve dialog names requester + vehicle",
  approveText.includes(pl.userName) && approveText.includes(setup.srcName) && approveText.includes("Keeper Custom Ride"));
await gm.page.screenshot({ path: `${SHOT_DIR}/deploy-approve-dialog.png` });
await gm.page.click('.cp-vehicle-deploy-approve button[data-action="approve"]');

// player: actor lands with the custom name, correct seed, ownership, flags
const created = await pl.page.waitForFunction(({ playerId, itemAUuid }) => {
  const a = game.actors.find(x => x.name === "Keeper Custom Ride");
  if (!a) return null;
  return {
    type: a.type,
    src: a.flags?.["cp2020-augmented"]?.sourceItemUuid,
    createdBy: a.flags?.["cp2020-augmented"]?.createdBy,
    own: a.ownership?.[playerId],
    topSpeed: a.system.topSpeed, sdpMax: a.system.sdp?.max, sdpVal: a.system.sdp?.value,
    spFront: a.system.sp?.front, spRear: a.system.sp?.rear,
    folderName: a.folder?.name ?? null,
  };
}, setup, { timeout: 10000 }).then(h => h.jsonValue());
check("actor type = module vehicle", created.type === "cp2020-augmented.vehicle");
check("flags link = item uuid", created.src === setup.itemAUuid);
check("flags createdBy = player", created.createdBy === setup.playerId);
check("requester is OWNER", created.own === 3);
check("topSpeed seeded from item", created.topSpeed === setup.expected.topSpeed, `${created.topSpeed}`);
check("sdp max+value seeded full", created.sdpMax === setup.expected.sdpMax && created.sdpVal === setup.expected.sdpMax, `${created.sdpVal}/${created.sdpMax}`);
check("sp seeds all facings", created.spFront === setup.expected.sp && created.spRear === setup.expected.sp);
check("filed in Vehicles folder", created.folderName === "Vehicles", String(created.folderName));

// …and the vehicle is ON THE CANVAS beside the requester's token (the ruling: deploy means it
// hits the canvas), placed by the GM client onto the scene the PLAYER was looking at.
const landed = await pl.page.waitForFunction(({ sceneId }) => {
  const scene = game.scenes.get(sceneId);
  const actor = game.actors.find(a => a.name === "Keeper Custom Ride");
  const tok = actor ? scene.tokens.find(t => t.actorId === actor.id) : null;
  return tok ? { x: tok.x, y: tok.y, w: tok.width, h: tok.height, sort: tok.sort } : null;
}, setup, { timeout: 15000 }).then(h => h.jsonValue()).catch(() => null);
check("approved deploy places the vehicle on the player's scene", !!landed);
check("placed beside the requester's own token (exact)",
  landed && landed.x === setup.anchor.x + setup.grid && landed.y === setup.anchor.y,
  landed ? `x=${landed.x} y=${landed.y}` : "no token");
check("placed handle sorts below crew", landed?.sort === -100, String(landed?.sort));
const approvedNote = await pl.page.waitForFunction(
  () => window.__pwNotes.some(n => n.kind === "info" && n.msg.includes("Keeper Custom Ride") && /approved/i.test(n.msg)),
  null, { timeout: 10000 },
).then(() => true).catch(() => false);
check("player notified of approval", approvedNote);

// Phase 4 discoverability: the actor sheet AUTO-OPENS on the requesting player's screen…
const autoOpened = await pl.page.waitForFunction(() => {
  const a = game.actors.find(x => x.name === "Keeper Custom Ride");
  return !!a && [...foundry.applications.instances.values()].some(app => (app.actor ?? app.document) === a && app.rendered);
}, null, { timeout: 10000 }).then(() => true).catch(() => false);
check("actor sheet auto-opened on player", autoOpened);
// …the auto-opened sheet is the CIVILIAN layout with the provenance line back to the item…
const civState = await pl.page.evaluate(() => {
  const a = game.actors.find(x => x.name === "Keeper Custom Ride");
  const root = a?.sheet?.element;
  return {
    civilian: !!root?.querySelector('input[name="system.speedValue"]'),
    provenance: root?.querySelector(".cp-veh-source")?.textContent?.trim() ?? "",
  };
});
check("auto-opened sheet is civilian layout", civState.civilian);
check("provenance line names item + owner", civState.provenance.includes(setup.srcName) && civState.provenance.includes("__PW__Driver"), civState.provenance);
// …and the ITEM's Deploy row flips to "Deployed as …" + Open.
const rowState = await pl.page.evaluate(async ({ itemAUuid }) => {
  const item = await fromUuid(itemAUuid);
  await item.sheet.render(true);
  await new Promise(r => setTimeout(r, 700));
  const root = item.sheet.element;
  const out = {
    open: !!root.querySelector(".cp-vehicle-open"),
    deploy: !!root.querySelector(".cp-vehicle-deploy"),
    label: root.querySelector(".cp-vehicle-open")?.closest(".field")?.querySelector("label")?.textContent?.trim() ?? "",
  };
  await item.sheet.close();
  return out;
}, setup);
check("item row shows Deployed-as + Open (no Deploy button)", rowState.open && !rowState.deploy && rowState.label.includes("Keeper Custom Ride"), rowState.label);
await pl.page.evaluate(() => { const a = game.actors.find(x => x.name === "Keeper Custom Ride"); return a?.sheet?.close(); });

// B. rename-proof duplicate: GM renames, player re-clicks → message carries NEW name, no dialog, no 2nd actor
await gm.page.evaluate(async () => { await game.actors.find(a => a.name === "Keeper Custom Ride").update({ name: "Renamed Ride" }); });
await pl.page.waitForFunction(() => game.actors.find(a => a.name === "Renamed Ride"), null, { timeout: 10000 });
await pl.page.evaluate(async ({ itemAUuid }) => {
  window.__pwNotes.length = 0;
  const item = await fromUuid(itemAUuid);
  const m = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-deploy-request.js`);
  await m.requestVehicleDeploy(item);
}, setup);
const dupState = await pl.page.evaluate(() => ({
  nameDialog: !!document.querySelector(".cp-vehicle-deploy-name"),
  note: window.__pwNotes.find(n => n.msg.includes("Renamed Ride"))?.msg ?? null,
  count: game.actors.filter(a => a.type === "cp2020-augmented.vehicle" && ["Keeper Custom Ride", "Renamed Ride"].includes(a.name)).length,
}));
check("duplicate: no name dialog", !dupState.nameDialog);
check("duplicate: message shows CURRENT (renamed) actor name", !!dupState.note, String(dupState.note));
check("duplicate: still exactly one actor", dupState.count === 1);

// C. decline path (second item)
await pl.page.evaluate(async ({ itemBUuid }) => {
  window.__pwNotes.length = 0;
  const item = await fromUuid(itemBUuid);
  const m = await import(`/modules/cp2020-augmented/module/vehicle/vehicle-deploy-request.js`);
  window.__pwDeploy2 = m.requestVehicleDeploy(item);
}, setup);
await pl.page.waitForSelector('.cp-vehicle-deploy-name input[name="cp-deploy-name"]', { timeout: 10000 });
await pl.page.fill('.cp-vehicle-deploy-name input[name="cp-deploy-name"]', "Declined Ride");
await pl.page.click('.cp-vehicle-deploy-name button[data-action="ok"]');
await gm.page.waitForSelector(".cp-vehicle-deploy-approve", { timeout: 10000 });
await gm.page.click('.cp-vehicle-deploy-approve button[data-action="decline"]');
await pl.page.waitForFunction(() => window.__pwNotes.some(n => n.kind === "warn" && /declined/i.test(n.msg)), null, { timeout: 10000 });
const declined = await pl.page.evaluate(() => ({
  actor: !!game.actors.find(a => a.name === "Declined Ride"),
}));
check("decline: player warned", true);
check("decline: no actor created", !declined.actor);

// D. embark/disembark gesture + seating presentation + crew-follow (GM client).
// Runs on its OWN scene (viewed, never activated) so the world's active scene is untouched.
const boardRes = await gm.page.evaluate(async ({ SCOPE, sceneId, activeBefore }) => {
  const out = {};
  const scene = game.scenes.get(sceneId);
  await scene.view();
  for (let i = 0; i < 50 && canvas.scene?.id !== scene.id; i++) await new Promise(r => setTimeout(r, 200));
  const grid = scene.grid.size;
  // This core streams a token's document position while it animates; wait for it to settle.
  const settle = async (id) => {
    let last = null;
    for (let i = 0; i < 30; i++) {
      const t = scene.tokens.get(id);
      const now = `${t.x},${t.y}`;
      if (now === last) return;
      last = now;
      await new Promise(r => setTimeout(r, 150));
    }
  };

  const vehicleActor = game.actors.find(a => a.name === "Renamed Ride");
  const api = game.cpAugmented.vehicles;
  // deploy is idempotent per (actor, scene) — the approved deploy already parked this vehicle
  // here, so this returns THAT handle. Put the crew token beside wherever it actually is.
  const dep = await api.deploy(vehicleActor, { scene, x: 10 * grid, y: 10 * grid, gw: 2, gh: 1 });
  const vTok = scene.tokens.get(dep.tokenId);
  out.reusedExistingHandle = dep.existing === true;
  const driver = game.actors.getName("__PW__Driver");
  const [cTok] = await scene.createEmbeddedDocuments("Token", [{
    name: driver.name, actorId: driver.id, actorLink: true,
    x: vTok.x + vTok.width * grid, y: vTok.y, width: 1, height: 1,
    texture: { src: "icons/svg/mystery-man.svg" },
  }]);
  // wait for placeable
  for (let i = 0; i < 25 && !canvas.tokens.get(cTok.id); i++) await new Promise(r => setTimeout(r, 200));
  const placeable = canvas.tokens.get(cTok.id);
  if (!placeable) return { error: "crew placeable never drew" };
  const priorScale = cTok._source.texture.scaleX;
  // open HUD on the crew token
  const hud = canvas.tokens.hud ?? canvas.hud?.token;
  hud.bind(placeable);
  await new Promise(r => setTimeout(r, 500));
  const btnIn = document.querySelector(".cp-vehicle-board.cp-board-in");
  out.embarkBtn = !!btnIn;
  if (!btnIn) return out;
  btnIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  for (let i = 0; i < 25 && scene.tokens.get(cTok.id).flags?.[SCOPE]?.boardedVehicle !== vehicleActor.id; i++) await new Promise(r => setTimeout(r, 200));
  await settle(cTok.id);
  out.boardedFlag = scene.tokens.get(cTok.id).flags?.[SCOPE]?.boardedVehicle === vehicleActor.id;

  // seated: the DRIVER'S seat, drawn at 60%, sorted above the hull. On this 4-wide handle the
  // footprint derives an eastward heading, so the engine is the right-hand column and the driver
  // sits in the cell behind it on the top row — two squares right of the hull's own origin.
  const seated = scene.tokens.get(cTok.id);
  out.seat = { x: seated.x, y: seated.y, vx: vTok.x, vy: vTok.y, vw: vTok.width, vh: vTok.height,
               scale: seated._source.texture.scaleX, sort: seated.sort, hullSort: vTok.sort };

  // crew-follow: move the vehicle, crew translates by the same delta (seat offset preserved)
  const c0 = { x: scene.tokens.get(cTok.id).x, y: scene.tokens.get(cTok.id).y };
  await vTok.update({ x: vTok.x + 3 * grid, y: vTok.y + grid }, { teleport: true });
  for (let i = 0; i < 25 && scene.tokens.get(cTok.id).x === c0.x; i++) await new Promise(r => setTimeout(r, 200));
  await settle(cTok.id);
  const c1 = { x: scene.tokens.get(cTok.id).x, y: scene.tokens.get(cTok.id).y };
  out.crewFollowed = c1.x === c0.x + 3 * grid && c1.y === c0.y + grid;
  out.stillSeated = c1.x === vTok.x + 2 * grid && c1.y === vTok.y;

  // HUD now offers Disembark; click it; flag clears; the rider lands BESIDE the hull
  hud.clear(); hud.bind(placeable);
  await new Promise(r => setTimeout(r, 500));
  const btnOut = document.querySelector(".cp-vehicle-board.cp-board-out");
  out.disembarkBtn = !!btnOut;
  if (btnOut) {
    btnOut.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 25 && scene.tokens.get(cTok.id).flags?.[SCOPE]?.boardedVehicle; i++) await new Promise(r => setTimeout(r, 200));
    await settle(cTok.id);
    out.flagCleared = !scene.tokens.get(cTok.id).flags?.[SCOPE]?.boardedVehicle;
    const t = scene.tokens.get(cTok.id);
    const vr = { x: vTok.x, y: vTok.y, w: vTok.width * grid, h: vTok.height * grid };
    const tr = { x: t.x, y: t.y, w: t.width * grid, h: t.height * grid };
    out.outsideFootprint = !(tr.x < vr.x + vr.w && vr.x < tr.x + tr.w && tr.y < vr.y + vr.h && vr.y < tr.y + tr.h);
    out.gap = Math.max(Math.max(vr.x - (tr.x + tr.w), tr.x - (vr.x + vr.w), 0),
                       Math.max(vr.y - (tr.y + tr.h), tr.y - (vr.y + vr.h), 0));
    out.scaleRestored = t._source.texture.scaleX === priorScale;
    const c2 = { x: t.x, y: t.y };
    // vehicle moves again — crew must NOT follow
    await vTok.update({ x: vTok.x + 2 * grid }, { teleport: true });
    await new Promise(r => setTimeout(r, 1500));
    const c3 = { x: scene.tokens.get(cTok.id).x, y: scene.tokens.get(cTok.id).y };
    out.stayedBehind = c3.x === c2.x && c3.y === c2.y;
  }
  out.activeUnchanged = (game.scenes.active?.id ?? null) === activeBefore;
  return out;
}, { SCOPE, sceneId: setup.sceneId, activeBefore: setup.activeBefore });
check("embark button renders on crew token near vehicle", boardRes.embarkBtn === true, boardRes.error ?? "");
check("embark sets boardedVehicle flag", boardRes.boardedFlag === true);
check("embark seats the rider in the driver's seat, behind the engine rank (exact)",
  Number.isFinite(boardRes.seat?.x) && boardRes.seat.vw === 4
  && boardRes.seat.x === boardRes.seat.vx + 2 * setup.grid && boardRes.seat.y === boardRes.seat.vy,
  JSON.stringify(boardRes.seat));
check("seated rider is drawn at 60% of its own art scale", boardRes.seat?.scale === 0.6, String(boardRes.seat?.scale));
check("seated rider sorts above the hull",
  Number.isFinite(boardRes.seat?.sort) && boardRes.seat.sort > boardRes.seat.hullSort,
  `${boardRes.seat?.sort} vs ${boardRes.seat?.hullSort}`);
check("crew follows vehicle movement", boardRes.crewFollowed === true);
check("crew keeps its seat offset after the move", boardRes.stillSeated === true);
check("disembark button renders while boarded", boardRes.disembarkBtn === true);
check("disembark clears flag", boardRes.flagCleared === true);
check("disembarked crew lands outside the footprint", boardRes.outsideFootprint === true);
check("disembarked crew lands adjacent (≤1 square)", boardRes.gap <= 100, String(boardRes.gap));
check("disembark restores the pre-boarding art scale", boardRes.scaleRestored === true);
check("negative case: disembarked crew no longer follows", boardRes.stayedBehind === true);
check("active scene unchanged by the boarding pass", boardRes.activeUnchanged === true);

// E. tag-wrap: summary fully visible at default open width
const tag = await gm.page.evaluate(async ({ itemAUuid }) => {
  const item = await fromUuid(itemAUuid);
  const sh = item.sheet;
  await sh.render(true);
  await new Promise(r => setTimeout(r, 700));
  const root = sh.element;
  const sum = root.querySelector(".summary");
  const title = root.querySelector("h1.title");
  const img = root.querySelector("header .item-img");
  const sr = sum.getBoundingClientRect(), tr = title.getBoundingClientRect(), ir = img.getBoundingClientRect();
  const out = {
    visibleAll: sum.scrollWidth <= Math.round(sr.width) + 2,
    text: sum.textContent.trim(),
    wrappedBelowTitle: sr.top >= tr.bottom - 4,
    clearOfImage: Math.min(sr.right, ir.right) - Math.max(sr.left, ir.left) <= 2,
    appId: sh.id,
  };
  return out;
}, setup);
check("tag fully visible at default width (no truncation)", tag.visibleAll, tag.text);
check("tag clear of the portrait", tag.clearOfImage);
console.log(`  info: tag wrapped below title = ${tag.wrappedBelowTitle}`);
await gm.page.locator(`#${tag.appId}`).screenshot({ path: `${SHOT_DIR}/veh-item-tag-wrap.png` });

// cleanup
const cleaned = await gm.page.evaluate(async ({ sceneId, activeBefore }) => {
  await game.scenes.get(sceneId)?.delete();
  for (const n of ["Renamed Ride", "Keeper Custom Ride", "Declined Ride"]) await game.actors.find(a => a.name === n)?.delete();
  for (const a of [...game.actors]) if (a.name.startsWith("__PW__")) await a.delete();
  const folder = game.folders.find(f => f.type === "Actor" && f.name === "Vehicles");
  if (folder && folder.contents.length === 0) await folder.delete();
  return {
    scenesLeft: game.scenes.filter(s => s.name.startsWith("__PW__")).length,
    actorsLeft: game.actors.filter(a => a.name.startsWith("__PW__")).length,
    activeUnchanged: (game.scenes.active?.id ?? null) === activeBefore,
  };
}, { sceneId: setup.sceneId, activeBefore: setup.activeBefore });
check("probe scene and fixtures removed",
  cleaned.scenesLeft === 0 && cleaned.actorsLeft === 0, `scenes=${cleaned.scenesLeft} actors=${cleaned.actorsLeft}`);
check("world active scene untouched by the run", cleaned.activeUnchanged === true);

// The rig is shared: other work running in the same world logs its own errors into this
// page. `Invalid Asset` comes from the effects asset registry, which nothing in this spec
// touches, so it is excluded by name rather than being read as a fault here.
const realErrors = gmErrors.filter(e => !/compatibility|deprecat|screen resolution|Invalid Asset/i.test(e));
check("0 GM console errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
