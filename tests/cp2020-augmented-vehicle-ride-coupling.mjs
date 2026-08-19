/**
 * KEEPER: how a vehicle carries its crew, and which way round a vehicle sits on the map.
 *
 * Contract under test (walk rulings 2026-08-18):
 *  - A rider is DRAWN at its seat on every frame the vehicle is drawn, so a moving or turning
 *    vehicle never appears to shake its crew loose. Measured per animation frame, not sampled at
 *    the ends: the defect this replaces was invisible at both ends and 6.6 squares wide in between.
 *  - The rider documents still change exactly once per move, instantly, and land byte-exactly on
 *    the same seat the last drawn frame used.
 *  - A vehicle's LONG axis runs along its direction of travel and a SHORT face leads, at whatever
 *    heading the core's drag auto-rotate gives it.
 *  - The footprint, the seat order, the engine region, the cover geometry and the struck-armour
 *    facing all read the same rotation-zero convention (south — the core's own).
 *  - A rider somebody has hold of is left alone.
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
// The main seat may be held by a concurrently running suite; a taken user's option is DISABLED, so
// fall back to a second gamemaster created for the purpose (the shop-drawer suite's §9 pattern).
const seat = await page.evaluate(() => {
  const sel = document.querySelector('select[name="userid"]');
  const opt = [...sel.options].find(o => /^gamemaster$/i.test(o.textContent.trim()));
  if (opt && !opt.disabled) {
    sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true }));
    return "primary";
  }
  const alt = [...sel.options].find(o => /^__PW__GM2$/i.test(o.textContent.trim()) && !o.disabled);
  if (!alt) return null;
  sel.value = alt.value; sel.dispatchEvent(new Event("change", { bubbles: true }));
  return "secondary";
});
if (!seat) {
  console.log("  FAIL: a gamemaster seat is available to join");
  await browser.close();
  process.exit(1);
}
if (seat === "primary") await page.fill('input[name="password"]', GM_PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 40000 });
console.log(`  (joined on the ${seat} gamemaster seat)`);

/* ------------------------------------------------------------------ fixture + measurement run */

const out = await page.evaluate(async (SCOPE) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const o = { err: null };
  try {
    // The startup notice sits over the middle of the canvas; close it before anything is measured.
    for (const app of [...foundry.applications.instances.values()]) {
      if (app.id === "cp-automation-notice") await app.close().catch(() => {});
    }
    o.activeBefore = game.scenes.active?.id ?? null;
    for (const s of [...game.scenes]) if (s.name.startsWith("__PW__Ride")) await s.delete();
    for (const a of [...game.actors]) if (a.name.startsWith("__PW__Ride")) await a.delete();

    const L = await import(`/modules/${SCOPE}/module/vehicle/vehicle-layout.js`);
    const V = await import(`/modules/${SCOPE}/module/vehicle/vehicle-canvas.js`);
    const COVER = await import(`/modules/${SCOPE}/module/vehicle/vehicle-cover.js`);
    const TGT = await import(`/modules/${SCOPE}/module/vehicle/vehicle-targeting.js`);

    /* ---- §1 the convention itself, before anything is placed ---- */
    // Read defensively: a convention that has gone missing must redden its own leg rather than
    // take the whole measurement run down with it.
    o.convention = {
      zeroFront: L.ROTATION_ZERO_FRONT ?? null,
      footprint: V.DEFAULT_FOOTPRINT ? { ...V.DEFAULT_FOOTPRINT } : { w: null, h: null },
      derivedFrontWide: L.defaultFrontFor?.(4, 2) ?? null,
      derivedFrontDeep: L.defaultFrontFor?.(2, 4) ?? null,
      headings: typeof L.headingVector === "function"
        ? [0, -90, 90, 180].map(d => {
          const v = L.headingVector(d);
          return `${Math.round(v.x)},${Math.round(v.y)}`;
        })
        : [],
    };

    const scene = await Scene.create({ name: "__PW__RideScene", width: 4000, height: 4000, grid: { size: 100 } });
    await scene.view();
    for (let i = 0; i < 60 && canvas.scene?.id !== scene.id; i++) await sleep(200);
    o.sceneId = scene.id;
    const grid = scene.grid.size;
    o.grid = grid;

    const vehicle = await Actor.create({ name: "__PW__RideVehicle", type: `${SCOPE}.vehicle` });
    o.vehicleId = vehicle.id;
    o.prototype = { w: vehicle.prototypeToken.width, h: vehicle.prototypeToken.height };

    const placed = await V.deployVehicleToScene(vehicle, { scene, x: 1000, y: 1000 });
    const handle = scene.tokens.get(placed.tokenId);
    o.handle = { w: handle.width, h: handle.height };

    const riders = [];
    for (const tag of ["A", "B"]) {
      const a = await Actor.create({ name: `__PW__RideCrew${tag}`, type: "character" });
      const [t] = await scene.createEmbeddedDocuments("Token", [{
        name: a.name, actorId: a.id, actorLink: true, x: 2400, y: 2400, width: 1, height: 1,
        texture: { src: "icons/svg/mystery-man.svg" },
      }]);
      riders.push({ tag, actorId: a.id, tokenId: t.id });
    }
    for (let i = 0; i < 60 && !riders.every(r => canvas.tokens.get(r.tokenId)); i++) await sleep(150);
    for (const r of riders) await V.boardVehicle(scene.tokens.get(r.tokenId), vehicle, handle);
    await sleep(1000);
    o.riderIds = riders.map(r => r.tokenId);
    o.aboard = V.ridersOf(scene, vehicle.id).length;

    /* ---- the sampler: one reading per rendered frame ---- */
    const seatFor = (pose, tokenId) => {
      const doc = scene.tokens.get(tokenId);
      const idx = Number(doc.flags?.[SCOPE]?.seatIndex);
      return V.riderSeatAt(pose, grid, idx, { w: doc.width, h: doc.height }, V.seatOrderAt(vehicle, pose));
    };
    const samples = [];
    let sampling = false;
    const sampler = () => {
      if (!sampling) return;
      const vp = canvas.tokens.get(handle.id);
      if (!vp) return;
      const pose = V.drawnPoseOf(vp.document);
      const row = { vx: pose.x, vy: pose.y, rot: pose.rotation, r: [] };
      for (const r of riders) {
        const rp = canvas.tokens.get(r.tokenId);
        if (!rp) continue;
        const seat = seatFor(pose, r.tokenId);
        row.r.push({
          tag: r.tag,
          drift: Math.hypot(rp.position.x - seat.x, rp.position.y - seat.y),
          meshDrift: Math.hypot((rp.mesh?.position?.x ?? 0) - (seat.x + rp.w / 2),
                                (rp.mesh?.position?.y ?? 0) - (seat.y + rp.h / 2)),
          drawnVsDoc: Math.hypot(rp.position.x - rp.document.x, rp.position.y - rp.document.y),
        });
      }
      samples.push(row);
    };
    canvas.app.ticker.add(sampler);
    const worst = (rows, key = "drift", tag = null) => rows.reduce((m, s) =>
      s.r.filter(r => !tag || r.tag === tag).reduce((n, r) => Math.max(n, r[key]), m), 0);

    // How many batched rider writes a move costs — the coupling must not turn into a write per frame.
    let riderWrites = 0;
    const countWrites = (doc, change, options) => {
      if (options?.cp2020VehicleSync && riders.some(r => r.tokenId === doc.id)) riderWrites++;
    };
    Hooks.on("updateToken", countWrites);

    const committedSeats = () => riders.map(r => {
      const doc = scene.tokens.get(r.tokenId);
      const idx = Number(doc.flags?.[SCOPE]?.seatIndex);
      const pose = V.storedPoseOf(handle);
      const seat = V.riderSeatAt(pose, grid, idx, { w: doc.width, h: doc.height }, V.seatOrderAt(vehicle, pose));
      const src = doc._source;
      return { tag: r.tag, srcX: src.x, srcY: src.y, seatX: seat.x, seatY: seat.y };
    });

    /* ---- §2 a hand-drag-shaped drive: the gesture from the report ---- */
    riderWrites = 0;
    sampling = true;
    await handle.update({ x: handle.x + 900, y: handle.y }, { method: "dragging" });
    await sleep(3200);
    sampling = false;
    o.drive = {
      frames: samples.length,
      worstDrift: worst(samples),
      worstMeshDrift: worst(samples, "meshDrift"),
      // At least one mid-flight frame must have the rider drawn away from its own document, or the
      // coupling was never exercised and a zero drift would prove nothing.
      framesDrawnOffDocument: samples.filter(s => s.r.some(r => r.drawnVsDoc > 1)).length,
      riderWrites,
      committed: committedSeats(),
    };
    samples.length = 0;

    /* ---- §3 which face leads, at the heading the core's auto-rotate produced ---- */
    {
      const src = handle._source;
      const corners = L.rotatedRectCorners({ x: 0, y: 0, w: src.width * grid, h: src.height * grid }, src.rotation);
      const span = (fx, fy) => {
        const p = corners.map(c => c.x * fx + c.y * fy);
        return Math.round(Math.max(...p) - Math.min(...p));
      };
      // The same measurement for the footprint the module used to ship, as a control: it must FAIL
      // the rule, otherwise the leg would pass for any shape at all.
      const shipped = L.rotatedRectCorners({ x: 0, y: 0, w: 4 * grid, h: 2 * grid }, src.rotation);
      const spanOf = (cs, fx, fy) => {
        const p = cs.map(c => c.x * fx + c.y * fy);
        return Math.round(Math.max(...p) - Math.min(...p));
      };
      o.axis = {
        rotation: src.rotation, w: src.width, h: src.height,
        alongTravel: span(1, 0), acrossTravel: span(0, 1),
        controlAlong: spanOf(shipped, 1, 0), controlAcross: spanOf(shipped, 0, 1),
      };
    }

    /* ---- §4 a turn ---- */
    riderWrites = 0;
    sampling = true;
    await handle.update({ rotation: 90 });
    await sleep(2600);
    sampling = false;
    o.turn = {
      frames: samples.length,
      worstDrift: worst(samples),
      turningFrames: new Set(samples.map(s => Math.round(s.rot))).size,
      riderWrites,
      committed: committedSeats(),
    };
    samples.length = 0;

    /* ---- §5 a rider somebody has hold of is left alone ---- */
    await handle.update({ rotation: 0 }, { animate: false });
    await sleep(900);
    const heldId = riders[0].tokenId, freeId = riders[1].tokenId;
    const held = canvas.tokens.get(heldId);
    const mim = held.mouseInteractionManager;
    o.grab = { hasManager: !!mim, statesFound: !!mim?.states, priorState: mim?.state ?? null };
    if (mim) mim.state = mim.states.DRAG;
    riderWrites = 0;
    sampling = true;
    await handle.update({ x: handle.x - 700, y: handle.y }, { method: "dragging" });
    await sleep(2600);
    sampling = false;
    o.grabbed = {
      // The held token stays where its own document puts it: the coupling never wrote its transform.
      heldDrawnVsDoc: Math.max(...samples.map(s => s.r.find(r => r.tag === "A")?.drawnVsDoc ?? 0)),
      // Its neighbour, meanwhile, was demonstrably being drawn away from its document mid-flight.
      freeDrawnOffDocument: samples.filter(s => (s.r.find(r => r.tag === "B")?.drawnVsDoc ?? 0) > 1).length,
      freeWorstDrift: worst(samples, "drift", "B"),
    };
    if (mim) mim.state = mim.states.NONE;
    samples.length = 0;
    // Once released, the next move carries them both again.
    sampling = true;
    await handle.update({ x: handle.x + 300, y: handle.y }, { method: "dragging" });
    await sleep(2400);
    sampling = false;
    o.released = { worstDrift: worst(samples), frames: samples.length };
    samples.length = 0;

    /* ---- §5b a rider dragged onto another square keeps that square ---- */
    {
      await handle.update({ rotation: 0 }, { animate: false });
      await sleep(700);
      const pose = V.storedPoseOf(handle);
      const order = V.seatOrderAt(vehicle, pose);
      const mover = scene.tokens.get(riders[1].tokenId);
      const before = Number(mover.flags?.[SCOPE]?.seatIndex);
      // Seat 2 is free (only two riders aboard, holding 0 and 1) — drop onto it by hand.
      const wanted = V.riderSeatAt(pose, grid, 2, { w: mover.width, h: mover.height }, order);
      await mover.update({ x: wanted.x, y: wanted.y }, { animate: false, teleport: true });
      await sleep(1200);
      const after = scene.tokens.get(riders[1].tokenId);
      o.seatChange = {
        before, after: Number(after.flags?.[SCOPE]?.seatIndex),
        landedX: after._source.x, landedY: after._source.y, wantX: wanted.x, wantY: wanted.y,
      };
      // And it STICKS through the next move, which is the whole reason it is stored as an index.
      await handle.update({ x: handle.x + 300, y: handle.y }, { method: "dragging" });
      await sleep(2400);
      const moved = scene.tokens.get(riders[1].tokenId);
      const movedPose = V.storedPoseOf(handle);
      const seatNow = V.riderSeatAt(movedPose, grid, 2, { w: moved.width, h: moved.height },
        V.seatOrderAt(vehicle, movedPose));
      o.seatChange.heldIndex = Number(moved.flags?.[SCOPE]?.seatIndex);
      o.seatChange.heldSeat = moved._source.x === seatNow.x && moved._source.y === seatNow.y;

      // NEGATIVE: a drop that is not on a seat at all puts the rider back on its own.
      await moved.update({ x: movedPose.x - 3 * grid, y: movedPose.y - 3 * grid }, { animate: false, teleport: true });
      await sleep(1200);
      const back = scene.tokens.get(riders[1].tokenId);
      const own = V.riderSeatAt(V.storedPoseOf(handle), grid, 2, { w: back.width, h: back.height },
        V.seatOrderAt(vehicle, V.storedPoseOf(handle)));
      o.seatChange.offSeatIndex = Number(back.flags?.[SCOPE]?.seatIndex);
      o.seatChange.offSeatReturned = back._source.x === own.x && back._source.y === own.y;
    }

    /* ---- §6 a token that is not aboard is not touched by the vehicle at all ---- */
    const [bystanderDoc] = await scene.createEmbeddedDocuments("Token", [{
      name: "__PW__RideBystander", actorLink: false, x: 2800, y: 2800, width: 1, height: 1,
      texture: { src: "icons/svg/mystery-man.svg" },
    }]);
    await sleep(500);
    const beforeBy = { x: bystanderDoc._source.x, y: bystanderDoc._source.y };
    await handle.update({ x: handle.x + 200, y: handle.y + 200 }, { method: "dragging" });
    await sleep(2200);
    o.bystander = {
      moved: bystanderDoc._source.x !== beforeBy.x || bystanderDoc._source.y !== beforeBy.y,
      drawn: (() => {
        const p = canvas.tokens.get(bystanderDoc.id);
        return p ? Math.hypot(p.position.x - bystanderDoc._source.x, p.position.y - bystanderDoc._source.y) : -1;
      })(),
    };

    canvas.app.ticker.remove(sampler);
    Hooks.off("updateToken", countWrites);

    /* ---- §7 the geometry consumers agree with the convention ---- */
    {
      const src = handle._source;
      await handle.update({ rotation: 0 }, { animate: false });
      await sleep(600);
      const w = src.width, h = src.height;
      const resolved = L.layoutFor(w, h, vehicle.system?.layout?.front, vehicle.system?.layout?.cells);
      const cells = (await import(`/modules/${SCOPE}/module/vehicle/vehicle-seating.js`))
        .footprintCells({ x: handle._source.x, y: handle._source.y, w: w * grid, h: h * grid }, grid);
      // The engine region must sit on the LEADING rank — the south edge at rotation 0.
      const yOf = i => cells[i].y;
      const maxY = Math.max(...cells.map((_, i) => yOf(i)));
      o.engine = {
        cells: resolved.engine,
        allOnLeadingRank: resolved.engine.length > 0 && resolved.engine.every(i => yOf(i) === maxY),
        front: resolved.front,
      };
      // A shot crossing the nose meets the engine block; one crossing the tail meets the body.
      const rows = COVER.vehicleCoverRowsOn(scene);
      const row = rows.find(r => r.actor?.id === vehicle.id) ?? null;
      o.coverRowFound = !!row;
      if (row) {
        const cx = row.rect.x + row.rect.w / 2;
        const noseY = row.rect.y + row.rect.h - grid / 2;
        const tailY = row.rect.y + grid / 2;
        const acrossNose = COVER.vehicleCoverSpAlong(row, { x: cx - 600, y: noseY }, { x: cx + 600, y: noseY });
        const acrossTail = COVER.vehicleCoverSpAlong(row, { x: cx - 600, y: tailY }, { x: cx + 600, y: tailY });
        const missed = COVER.vehicleCoverSpAlong(row, { x: cx - 600, y: row.rect.y - 400 }, { x: cx + 600, y: row.rect.y - 400 });
        o.cover = {
          noseSp: acrossNose.sp, noseEngine: acrossNose.engine,
          tailSp: acrossTail.sp, tailEngine: acrossTail.engine,
          missSp: missed.sp, bodySp: row.bodySp, engineSp: row.engineSp,
        };
      }
      // The struck facing, read from real tokens on the same nose/tail geometry.
      const [markerDoc] = await scene.createEmbeddedDocuments("Token", [{
        name: "__PW__RideShooter", actorLink: false, x: handle._source.x, y: handle._source.y + (h + 3) * grid,
        width: 1, height: 1, texture: { src: "icons/svg/mystery-man.svg" },
      }]);
      await sleep(500);
      const shooter = canvas.tokens.get(markerDoc.id);
      const vp = canvas.tokens.get(handle.id);
      o.facing = { fromNose: TGT.detectFacingFromTokens(shooter, vp) };
      await markerDoc.update({ y: handle._source.y - 4 * grid }, { animate: false, teleport: true });
      await sleep(500);
      o.facing.fromTail = TGT.detectFacingFromTokens(canvas.tokens.get(markerDoc.id), vp);
      await markerDoc.update({ x: handle._source.x + (w + 3) * grid, y: handle._source.y }, { animate: false, teleport: true });
      await sleep(500);
      o.facing.fromBeam = TGT.detectFacingFromTokens(canvas.tokens.get(markerDoc.id), vp);
      await markerDoc.delete();
    }

    o.activeAfter = game.scenes.active?.id ?? null;

    /* ---- cleanup ---- */
    for (const r of riders) await game.actors.get(r.actorId)?.delete();
    await game.actors.get(vehicle.id)?.delete();
    await scene.delete();
  } catch (e) {
    o.err = `${e?.message ?? e}\n${e?.stack ?? ""}`;
  }
  return o;
}, SCOPE);

/* ------------------------------------------------------------------ assertions */

if (out.err) console.log(`  (fixture error) ${out.err}`);
check("the measurement run completed without throwing", !out.err, out.err ? out.err.split("\n")[0] : "");

console.log("\n§1 — the rotation-zero convention, in one place");
check("rotation zero points south", out.convention?.zeroFront === "s", String(out.convention?.zeroFront));
check("the shipped footprint is DEEP, not wide (the long axis is the travel axis)",
  out.convention?.footprint.h > out.convention?.footprint.w,
  `${out.convention?.footprint.w} across x ${out.convention?.footprint.h} deep`);
check("a vehicle actor is created deep rather than wide",
  out.prototype?.h > out.prototype?.w
  && out.prototype?.w === out.convention?.footprint.w && out.prototype?.h === out.convention?.footprint.h,
  `${out.prototype?.w}x${out.prototype?.h}`);
check("the placed handle carries the same footprint",
  out.handle?.w === out.convention?.footprint.w && out.handle?.h === out.convention?.footprint.h,
  `${out.handle?.w}x${out.handle?.h}`);
check("an unpicked heading takes the convention whatever the footprint's shape",
  out.convention?.derivedFrontWide === "s" && out.convention?.derivedFrontDeep === "s",
  `wide -> ${out.convention?.derivedFrontWide}, deep -> ${out.convention?.derivedFrontDeep}`);
check("the heading vector matches the core's own auto-rotate formula",
  JSON.stringify(out.convention?.headings) === JSON.stringify(["0,1", "1,0", "-1,0", "0,-1"]),
  `0/-90/90/180 -> ${(out.convention?.headings ?? []).join(" | ")}`);

console.log("\n§2 — the crew stay aboard through a hand-drag-shaped drive");
check("both riders are aboard by the occupancy flag", out.aboard === 2, String(out.aboard));
check("the drive was sampled frame by frame", (out.drive?.frames ?? 0) >= 20, `${out.drive?.frames} frames`);
check("the coupling was actually exercised: riders were drawn away from their own documents mid-flight",
  (out.drive?.framesDrawnOffDocument ?? 0) > 0, `${out.drive?.framesDrawnOffDocument} frames`);
check("worst per-frame drift from the seat stays under one grid square",
  (out.drive?.worstDrift ?? Infinity) < out.grid,
  `${Math.round(out.drive?.worstDrift ?? -1)} px of a ${out.grid} px square`);
check("the art mesh tracks the seat too, not just the token frame",
  (out.drive?.worstMeshDrift ?? Infinity) < out.grid,
  `${Math.round(out.drive?.worstMeshDrift ?? -1)} px`);
check("the drive costs ONE batched rider write, not one per frame",
  out.drive?.riderWrites === 2, `${out.drive?.riderWrites} rider document updates for 2 riders`);
check("after the drive every rider's stored position IS its seat, exactly",
  (out.drive?.committed ?? []).length === 2
  && out.drive.committed.every(c => c.srcX === c.seatX && c.srcY === c.seatY),
  (out.drive?.committed ?? []).map(c => `${c.tag}: ${c.srcX},${c.srcY} vs seat ${c.seatX},${c.seatY}`).join(" | "));

console.log("\n§3 — a short face leads");
check("the core auto-rotated the dragged vehicle to its heading",
  out.axis?.rotation !== 0 && Number.isFinite(out.axis?.rotation), `rotation ${out.axis?.rotation}`);
check("the footprint's long axis lies ALONG the direction of travel",
  out.axis?.alongTravel > out.axis?.acrossTravel,
  `${out.axis?.alongTravel} px along vs ${out.axis?.acrossTravel} px across`);
check("CONTROL: the footprint this replaced fails the same measurement",
  out.axis?.controlAlong < out.axis?.controlAcross,
  `4x2 at the same heading: ${out.axis?.controlAlong} along vs ${out.axis?.controlAcross} across`);

console.log("\n§4 — the crew stay aboard through a turn");
check("the turn was sampled across more than one heading",
  (out.turn?.turningFrames ?? 0) > 1, `${out.turn?.turningFrames} distinct headings sampled`);
check("worst per-frame drift through the turn stays under one grid square",
  (out.turn?.worstDrift ?? Infinity) < out.grid,
  `${Math.round(out.turn?.worstDrift ?? -1)} px of a ${out.grid} px square`);
check("the turn settles into ONE batched rider write",
  out.turn?.riderWrites === 2, `${out.turn?.riderWrites} rider document updates for 2 riders`);
check("after the turn every rider's stored position IS its seat, exactly",
  (out.turn?.committed ?? []).length === 2
  && out.turn.committed.every(c => c.srcX === c.seatX && c.srcY === c.seatY),
  (out.turn?.committed ?? []).map(c => `${c.tag}: ${c.srcX},${c.srcY} vs seat ${c.seatX},${c.seatY}`).join(" | "));

console.log("\n§5 — a rider somebody has hold of");
check("the interaction state the guard reads is present on a real token",
  out.grab?.hasManager === true && out.grab?.statesFound === true,
  `manager ${out.grab?.hasManager}, states ${out.grab?.statesFound}, resting state ${out.grab?.priorState}`);
check("a held rider is never drawn anywhere but where its own document puts it",
  (out.grabbed?.heldDrawnVsDoc ?? Infinity) < 1, `${Math.round(out.grabbed?.heldDrawnVsDoc ?? -1)} px`);
check("NEGATIVE: its neighbour, unheld, was being drawn off its document at the same moment",
  (out.grabbed?.freeDrawnOffDocument ?? 0) > 0, `${out.grabbed?.freeDrawnOffDocument} frames`);
check("the unheld neighbour still tracked its seat throughout",
  (out.grabbed?.freeWorstDrift ?? Infinity) < out.grid, `${Math.round(out.grabbed?.freeWorstDrift ?? -1)} px`);
check("released, the next drive carries them both again",
  (out.released?.worstDrift ?? Infinity) < out.grid, `${Math.round(out.released?.worstDrift ?? -1)} px`);

console.log("\n§5b — a rider dragged onto another square keeps it");
check("the drag is recorded as the seat INDEX the rider landed on",
  out.seatChange?.before === 1 && out.seatChange?.after === 2,
  `seat ${out.seatChange?.before} -> ${out.seatChange?.after}`);
check("the rider snaps onto that seat exactly",
  out.seatChange?.landedX === out.seatChange?.wantX && out.seatChange?.landedY === out.seatChange?.wantY,
  `${out.seatChange?.landedX},${out.seatChange?.landedY} vs ${out.seatChange?.wantX},${out.seatChange?.wantY}`);
check("the new seat survives the next drive (it is an index, not a position)",
  out.seatChange?.heldIndex === 2 && out.seatChange?.heldSeat === true,
  `index ${out.seatChange?.heldIndex}, on seat ${out.seatChange?.heldSeat}`);
check("NEGATIVE: a drop that is not on a seat returns the rider to its own",
  out.seatChange?.offSeatIndex === 2 && out.seatChange?.offSeatReturned === true,
  `index ${out.seatChange?.offSeatIndex}, back on seat ${out.seatChange?.offSeatReturned}`);

console.log("\n§6 — nothing that is not aboard is touched");
check("a bystander token's stored position is unchanged by the vehicle moving", out.bystander?.moved === false);
check("a bystander token is drawn where its document says", (out.bystander?.drawn ?? -1) < 1,
  `${Math.round(out.bystander?.drawn ?? -1)} px`);

console.log("\n§7 — the geometry consumers all read the same convention");
check("the derived heading of the placed vehicle is the convention's", out.engine?.front === "s", String(out.engine?.front));
check("the engine region sits on the LEADING rank of the footprint",
  out.engine?.allOnLeadingRank === true, `engine cells ${JSON.stringify(out.engine?.cells)}`);
check("the vehicle offers a cover row", out.coverRowFound === true);
check("a line crossing the nose meets the engine block",
  out.cover?.noseEngine === true && out.cover?.noseSp === out.cover?.engineSp,
  `sp ${out.cover?.noseSp} (engine ${out.cover?.engineSp}), engine=${out.cover?.noseEngine}`);
check("a line crossing the tail meets the body instead",
  out.cover?.tailEngine === false && out.cover?.tailSp === out.cover?.bodySp,
  `sp ${out.cover?.tailSp} (body ${out.cover?.bodySp}), engine=${out.cover?.tailEngine}`);
check("NEGATIVE: a line that misses the footprint stops nothing", out.cover?.missSp === 0, String(out.cover?.missSp));
check("a shot from off the nose strikes the FRONT facing", out.facing?.fromNose === "front", String(out.facing?.fromNose));
check("a shot from off the tail strikes the REAR facing", out.facing?.fromTail === "rear", String(out.facing?.fromTail));
check("a shot from the beam strikes the SIDE facing", out.facing?.fromBeam === "side", String(out.facing?.fromBeam));

console.log("\n§8 — housekeeping");
check("the world's active scene is unchanged", out.activeBefore === out.activeAfter,
  `${out.activeBefore} -> ${out.activeAfter}`);
const realErrors = errors.filter(e => !/screen resolution/i.test(e) && !/Invalid Asset/i.test(e));
check("0 console errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
