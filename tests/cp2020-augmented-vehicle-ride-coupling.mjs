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
    // The vehicle's own SHAPE is recorded on the actor now; the token's width/height are the SQUARE
    // that carries it at any angle. Both are captured, because the contract is that they differ in
    // exactly that way and neither is free to drift.
    o.hull = { w: vehicle.system.layout?.hullW ?? null, h: vehicle.system.layout?.hullH ?? null };
    o.frameSquare = L.frameSquareFor?.(o.hull) ?? null;

    const placed = await V.deployVehicleToScene(vehicle, { scene, x: 1000, y: 1000 });
    const handle = scene.tokens.get(placed.tokenId);
    o.handle = { w: handle.width, h: handle.height };
    o.handleHull = L.hullDimsOf(vehicle.system, handle.width, handle.height);
    o.handleArtScale = handle.texture?.scaleX ?? null;

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
      // The span that matters is the HULL's, not the token frame's — the frame is a square and a
      // square measures the same in every direction, so measuring it could never tell which face
      // leads. The hull rect is the one the mechanics use, taken from the same helper they use.
      const hullRect = L.hullRectIn(
        { x: 0, y: 0, w: src.width * grid, h: src.height * grid },
        L.hullDimsOf(vehicle.system, src.width, src.height), grid);
      const corners = L.rotatedRectCorners(hullRect, src.rotation);
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

      // NEGATIVE: the adopter's own land-then-return path, exercised where it is STILL REACHABLE by
      // hand.
      // ⏪ This leg used to drop the rider on the ENGINE rank. The ride lock was widened (user
      // ruling 2026-08-20) to refuse every in-hull drop that is not a seat, so that drop is now
      // cancelled before the adopter ever sees it — it is covered as a REFUSAL in §5c case (b2)
      // instead. What the leg was actually pinning is the adopter's "this drop names no seat this
      // rider can take, so put them back on their own" rule, and that is now reached by dropping
      // onto a seat SOMEBODY ELSE HOLDS: the square IS a seat, so the lock passes it through, and
      // the adopter's already-taken branch returns the rider. Same mechanism, live gesture.
      const heldByOther = V.riderSeatAt(movedPose, grid, 0,
        { w: moved.width, h: moved.height }, V.seatOrderAt(vehicle, movedPose));
      await moved.update({ x: heldByOther.x, y: heldByOther.y }, { animate: false, teleport: true });
      await sleep(1200);
      const back = scene.tokens.get(riders[1].tokenId);
      const own = V.riderSeatAt(V.storedPoseOf(handle), grid, 2, { w: back.width, h: back.height },
        V.seatOrderAt(vehicle, V.storedPoseOf(handle)));
      o.seatChange.offSeatIndex = Number(back.flags?.[SCOPE]?.seatIndex);
      o.seatChange.offSeatReturned = back._source.x === own.x && back._source.y === own.y;
    }

    /* ---- §5c the ride lock: an aboard rider cannot be moved off the vehicle by hand ---- */
    {
      // The toast is the visible half of a refusal, so it is measured rather than assumed. The stub
      // forwards to the real notifier and is put back in a finally, so a throw cannot leave the
      // world's notifications wrapped.
      const warnings = [];
      const realWarn = ui.notifications.warn.bind(ui.notifications);
      ui.notifications.warn = (msg, ...rest) => { warnings.push(String(msg)); return realWarn(msg, ...rest); };
      // Every position write this rider takes, marker or no marker: a refusal that lets the move
      // land and then writes it back is exactly the behaviour being replaced, and only a per-write
      // record can tell the two apart (both end with the rider back on its seat).
      const writes = [];
      const watchRider = (doc, change) => {
        if (doc.id !== riders[1].tokenId) return;
        if (change.x === undefined && change.y === undefined) return;
        writes.push({ x: change.x, y: change.y });
      };
      Hooks.on("updateToken", watchRider);
      try {
        await handle.update({ rotation: 0 }, { animate: false });
        await sleep(700);
        const pose = V.storedPoseOf(handle);
        const order = V.seatOrderAt(vehicle, pose);
        const mover = scene.tokens.get(riders[1].tokenId);
        const size = { w: mover.width, h: mover.height };
        const before = { x: mover._source.x, y: mover._source.y, seat: Number(mover.flags?.[SCOPE]?.seatIndex) };

        // (a) a destination clear of the bodywork
        warnings.length = 0; writes.length = 0;
        await mover.update({ x: pose.x - 3 * grid, y: pose.y - 3 * grid }, { animate: false });
        await sleep(1100);
        const afterOut = scene.tokens.get(riders[1].tokenId);
        const outPlaceable = canvas.tokens.get(riders[1].tokenId);
        o.lock = { outside: {
          srcUnchanged: afterOut._source.x === before.x && afterOut._source.y === before.y,
          writes: writes.length,
          warned: warnings.length,
          seat: Number(afterOut.flags?.[SCOPE]?.seatIndex),
          // Nothing is left drawn away from the document either — no ghost standing in the road.
          drawnVsDoc: outPlaceable
            ? Math.hypot(outPlaceable.position.x - afterOut._source.x, outPlaceable.position.y - afterOut._source.y)
            : -1,
        } };

        // (b) a destination on another seat is still the seat-change gesture
        warnings.length = 0; writes.length = 0;
        const wanted = V.riderSeatAt(pose, grid, 1, size, order);
        await mover.update({ x: wanted.x, y: wanted.y }, { animate: false });
        await sleep(1300);
        const afterIn = scene.tokens.get(riders[1].tokenId);
        o.lock.inHull = {
          seat: Number(afterIn.flags?.[SCOPE]?.seatIndex),
          landedX: afterIn._source.x, landedY: afterIn._source.y,
          wantX: wanted.x, wantY: wanted.y,
          warned: warnings.length, writes: writes.length,
        };

        // (b2) a destination ON the bodywork but NOT on a seat — the engine rank — is refused the
        // same way an off-hull drop is (user ruling 2026-08-20, "refuse too"). The write COUNT is
        // what separates the two behaviours: before the ruling this drop was written and then
        // written back by the seat adopter (2 position writes, the rider ending on its own seat
        // either way), so only a per-write record can tell a refusal from a land-and-return.
        warnings.length = 0; writes.length = 0;
        const nonSeatPose = V.storedPoseOf(handle);
        const engineIdx = L.layoutFor(nonSeatPose.hull.w, nonSeatPose.hull.h,
          vehicle.system?.layout?.front, vehicle.system?.layout?.cells).engine[0];
        const engineSpot = V.riderSeatAt(nonSeatPose, grid, 0, size, [engineIdx]);
        const beforeEngine = scene.tokens.get(riders[1].tokenId);
        const engineBase = { x: beforeEngine._source.x, y: beforeEngine._source.y,
          seat: Number(beforeEngine.flags?.[SCOPE]?.seatIndex) };
        await mover.update({ x: engineSpot.x, y: engineSpot.y }, { animate: false });
        await sleep(1100);
        const afterEngine = scene.tokens.get(riders[1].tokenId);
        o.lock.engineCell = {
          writes: writes.length,
          warned: warnings.length,
          srcUnchanged: afterEngine._source.x === engineBase.x && afterEngine._source.y === engineBase.y,
          seat: Number(afterEngine.flags?.[SCOPE]?.seatIndex),
          seatKept: Number(afterEngine.flags?.[SCOPE]?.seatIndex) === engineBase.seat,
          // The square really is a non-seat one — stated rather than assumed, so a layout change
          // that turned the engine rank into seats would fail this leg instead of silently
          // weakening it.
          engineIdx,
        };

        // (c) the vehicle's own batched commit is not caught by the lock
        warnings.length = 0; writes.length = 0;
        riderWrites = 0;
        await handle.update({ x: handle.x + 300, y: handle.y }, { method: "dragging" });
        await sleep(2400);
        o.lock.drive = {
          riderWrites, warned: warnings.length,
          committed: committedSeats(),
        };

        // (d) stepping out is a legitimate module path and lands the rider off the hull
        warnings.length = 0;
        const leaver = scene.tokens.get(riders[0].tokenId);
        const leftBefore = { x: leaver._source.x, y: leaver._source.y };
        await V.disembark(leaver);
        await sleep(1000);
        const left = scene.tokens.get(riders[0].tokenId);
        const drivePose = V.storedPoseOf(handle);
        const hullRect = L.hullRectIn(
          { x: drivePose.x, y: drivePose.y, w: drivePose.w * grid, h: drivePose.h * grid },
          drivePose.hull, grid);
        const leftCentre = {
          x: left._source.x + (left.width * grid) / 2,
          y: left._source.y + (left.height * grid) / 2,
        };
        o.lock.disembark = {
          flagCleared: !left.flags?.[SCOPE]?.boardedVehicle,
          moved: left._source.x !== leftBefore.x || left._source.y !== leftBefore.y,
          offHull: !L.pointInRotatedRect(leftCentre, hullRect, drivePose.rotation),
          warned: warnings.length,
        };
        // Put them back aboard so the run ends the way the earlier sections left it.
        await V.boardVehicle(scene.tokens.get(riders[0].tokenId), vehicle, handle);
        await sleep(800);
        o.lock.reboarded = V.ridersOf(scene, vehicle.id).length;

        // (e) a token that is not aboard anything is moved wherever it is put
        const [freeDoc] = await scene.createEmbeddedDocuments("Token", [{
          name: "__PW__RideFree", actorLink: false, x: 3000, y: 3000, width: 1, height: 1,
          texture: { src: "icons/svg/mystery-man.svg" },
        }]);
        await sleep(400);
        warnings.length = 0;
        await freeDoc.update({ x: 3400, y: 3400 }, { animate: false });
        await sleep(700);
        o.lock.freeToken = {
          landedX: freeDoc._source.x, landedY: freeDoc._source.y, warned: warnings.length,
        };
        await freeDoc.delete();

        // (f) the decision itself, as a table — the inputs are plain values so the rule can be read
        // and checked without a vehicle. There is deliberately NO gamemaster input: the lock holds
        // for everyone, and a GM steps someone out with the module's own control instead.
        try {
          const LOCK = await import(`/modules/${SCOPE}/module/vehicle/vehicle-ride-lock.js`);
          const base = {
            aboard: true, isPositionChange: true, moduleMove: false,
            leavesVehicle: false, hullKnown: true, destinationInHull: false,
          };
          o.lock.table = {
            outside: LOCK.shouldRefuseRiderMove({ ...base }),
            inside: LOCK.shouldRefuseRiderMove({ ...base, destinationInHull: true }),
            notAboard: LOCK.shouldRefuseRiderMove({ ...base, aboard: false }),
            notAMove: LOCK.shouldRefuseRiderMove({ ...base, isPositionChange: false }),
            moduleMove: LOCK.shouldRefuseRiderMove({ ...base, moduleMove: true }),
            leaving: LOCK.shouldRefuseRiderMove({ ...base, leavesVehicle: true }),
            hullUnknown: LOCK.shouldRefuseRiderMove({ ...base, hullKnown: false }),
            // The ruled in-hull split: on the car AND on a seat passes; on the car and NOT on a
            // seat refuses. Both stated explicitly rather than leaning on the argument's default.
            insideSeat: LOCK.shouldRefuseRiderMove({ ...base, destinationInHull: true, destinationIsSeat: true }),
            insideNotSeat: LOCK.shouldRefuseRiderMove({ ...base, destinationInHull: true, destinationIsSeat: false }),
            // A caller that could not measure the seats gets the pre-ruling answer, not a refusal.
            insideUnmeasured: LOCK.shouldRefuseRiderMove({ ...base, destinationInHull: true }),
          };
        } catch (e) {
          o.lock.table = null;
          o.lock.tableError = String(e?.message ?? e);
        }
      } finally {
        ui.notifications.warn = realWarn;
        Hooks.off("updateToken", watchRider);
      }
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

/* ------------------------------------------------ §5d the lock against a REAL pointer drag

Everything above drives document updates. The gesture the lock exists for is a hand-drag on the
canvas, which goes through the core's own drag pipeline before it ever becomes an update — so it is
driven here with the mouse, on its own small fixture, and the rider's stored position is read back.
Kept out of the measurement run above because a mouse gesture cannot be driven from inside a single
page.evaluate.
*/

const dragSetup = await page.evaluate(async (SCOPE) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const s = { err: null };
  try {
    for (const sc of [...game.scenes]) if (sc.name.startsWith("__PW__RideDrag")) await sc.delete();
    for (const a of [...game.actors]) if (a.name.startsWith("__PW__RideDrag")) await a.delete();
    const V = await import(`/modules/${SCOPE}/module/vehicle/vehicle-canvas.js`);
    const scene = await Scene.create({ name: "__PW__RideDragScene", width: 3000, height: 3000, grid: { size: 100 } });
    await scene.view();
    for (let i = 0; i < 60 && canvas.scene?.id !== scene.id; i++) await sleep(200);

    const vehicle = await Actor.create({ name: "__PW__RideDragVehicle", type: `${SCOPE}.vehicle` });
    const placed = await V.deployVehicleToScene(vehicle, { scene, x: 1200, y: 1200 });
    const handle = scene.tokens.get(placed.tokenId);
    const pc = await Actor.create({ name: "__PW__RideDragCrew", type: "character" });
    const [rt] = await scene.createEmbeddedDocuments("Token", [{
      name: pc.name, actorId: pc.id, actorLink: true, x: 2000, y: 2000, width: 1, height: 1,
      texture: { src: "icons/svg/mystery-man.svg" },
    }]);
    for (let i = 0; i < 60 && !canvas.tokens.get(rt.id); i++) await sleep(150);
    await V.boardVehicle(scene.tokens.get(rt.id), vehicle, handle);
    await sleep(1200);

    // Both ends of every drag have to be on screen, so the view is centred on the vehicle at 1:1.
    const hp = canvas.tokens.get(handle.id);
    await canvas.animatePan({ x: hp.center.x, y: hp.center.y, scale: 1, duration: 1 });
    await sleep(800);

    window.__rideWarnings = [];
    window.__rideRealWarn = ui.notifications.warn.bind(ui.notifications);
    ui.notifications.warn = (m, ...r) => { window.__rideWarnings.push(String(m)); return window.__rideRealWarn(m, ...r); };

    const rider = canvas.tokens.get(rt.id);
    const toScreen = p => { const t = canvas.stage.worldTransform.apply(p); return { x: t.x, y: t.y }; };
    const doc = scene.tokens.get(rt.id);
    s.sceneId = scene.id; s.vehicleId = vehicle.id; s.pcId = pc.id; s.riderId = rt.id;
    s.before = { x: doc._source.x, y: doc._source.y, seat: Number(doc.flags?.[SCOPE]?.seatIndex) };
    s.from = toScreen({ x: rider.center.x, y: rider.center.y });
    s.off = toScreen({ x: rider.center.x - 500, y: rider.center.y });         // five squares clear
    s.onSeat = toScreen({ x: rider.center.x, y: rider.center.y - 100 });      // the cell in front
  } catch (e) { s.err = `${e?.message ?? e}`; }
  return s;
}, SCOPE);

async function pointerDrag(a, b) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(a.x + (b.x - a.x) * i / 12, a.y + (b.y - a.y) * i / 12);
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(1700);
}

const readRider = () => page.evaluate(({ SCOPE, sceneId, id }) => {
  const doc = game.scenes.get(sceneId)?.tokens.get(id);
  const p = canvas.tokens.get(id);
  return {
    x: doc?._source.x ?? null, y: doc?._source.y ?? null,
    seat: Number(doc?.flags?.[SCOPE]?.seatIndex),
    drawnVsDoc: (p && doc) ? Math.hypot(p.position.x - doc._source.x, p.position.y - doc._source.y) : -1,
    warnings: [...(window.__rideWarnings ?? [])],
  };
}, { SCOPE, sceneId: dragSetup.sceneId, id: dragSetup.riderId });

let dragOff = null, dragOnSeat = null;
if (!dragSetup.err) {
  await pointerDrag(dragSetup.from, dragSetup.off);
  dragOff = await readRider();
  await page.evaluate(() => { window.__rideWarnings.length = 0; });
  await pointerDrag(dragSetup.from, dragSetup.onSeat);
  dragOnSeat = await readRider();
}
await page.evaluate(async (s) => {
  if (window.__rideRealWarn) ui.notifications.warn = window.__rideRealWarn;
  await game.actors.get(s.pcId)?.delete();
  await game.actors.get(s.vehicleId)?.delete();
  await game.scenes.get(s.sceneId)?.delete();
}, dragSetup).catch(() => {});

/* ------------------------------------------------ §5e-§5g the selection side of the coupling

THE REPORT THIS ANSWERS (user, 2026-08-19): "highlighting the entire vehicle also highlights the
occupants and shows the errors stating they can't be moved."

Two mechanisms are measured here, both with real pointer gestures because both live in the core's
own input pipeline before anything becomes a document update:

  1. WHAT A RUBBER-BAND GRABS. A band drawn over a vehicle used to control the vehicle AND every
     rider sitting on it, so the very next drag asked for a move the ride lock has to refuse.
  2. HOW LOUD A REFUSAL IS. One gesture is one operation, however many riders it swept up, so it
     gets at most one message — and none at all when the vehicle came along too, because the
     coupling is about to place the crew anyway.

Its own scene, its own actors, deleted at the end. */

const bandSetup = await page.evaluate(async (SCOPE) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const s = { err: null };
  try {
    for (const sc of [...game.scenes]) if (sc.name.startsWith("__PW__RideBand")) await sc.delete();
    for (const a of [...game.actors]) if (a.name.startsWith("__PW__RideBand")) await a.delete();
    const V = await import(`/modules/${SCOPE}/module/vehicle/vehicle-canvas.js`);
    const L = await import(`/modules/${SCOPE}/module/vehicle/vehicle-layout.js`);

    const scene = await Scene.create({
      name: "__PW__RideBandScene", width: 3000, height: 3000, grid: { size: 100 } });
    await scene.view();
    for (let i = 0; i < 60 && canvas.scene?.id !== scene.id; i++) await sleep(200);
    const grid = scene.grid.size;

    const vehicle = await Actor.create({ name: "__PW__RideBandVehicle", type: `${SCOPE}.vehicle` });
    const placed = await V.deployVehicleToScene(vehicle, { scene, x: 1200, y: 1200 });
    const handle = scene.tokens.get(placed.tokenId);

    const riderIds = [];
    for (const suffix of ["A", "B"]) {
      const pc = await Actor.create({ name: `__PW__RideBandCrew${suffix}`, type: "character" });
      const [rt] = await scene.createEmbeddedDocuments("Token", [{
        name: pc.name, actorId: pc.id, actorLink: true, x: 2200, y: 2200, width: 1, height: 1,
        texture: { src: "icons/svg/mystery-man.svg" },
      }]);
      for (let i = 0; i < 60 && !canvas.tokens.get(rt.id); i++) await sleep(150);
      await V.boardVehicle(scene.tokens.get(rt.id), vehicle, handle);
      await sleep(900);
      riderIds.push({ tokenId: rt.id, actorId: pc.id });
    }

    // A token that is aboard nothing, inside the same band: it proves the band actually reached
    // the tokens under it, so an empty rider list can never be read as "the gesture missed".
    const [freeDoc] = await scene.createEmbeddedDocuments("Token", [{
      name: "__PW__RideBandFree", actorLink: false, x: 1800, y: 1250, width: 1, height: 1,
      texture: { src: "icons/svg/mystery-man.svg" },
    }]);
    for (let i = 0; i < 60 && !canvas.tokens.get(freeDoc.id); i++) await sleep(150);

    canvas.tokens.activate();
    canvas.tokens.releaseAll();
    await sleep(300);
    s.activeTool = game.activeTool ?? null;

    // ⚠ THE NOTIFICATION STACK SITS OVER THE TOP OF THE CANVAS and swallows a press aimed at the
    // board — a standing "hardware acceleration" banner on this rig covered the whole area a band
    // would start in, and every refusal raised below would add another. The container is hidden
    // for the length of this block (and restored with the notifier) so a gesture aimed at the map
    // reaches the map; the messages themselves are still recorded and still really raised.
    const notifications = document.getElementById("notifications");
    s.notificationsHidden = !!notifications;
    if (notifications) notifications.style.display = "none";

    window.__bandNotifications = notifications;
    window.__bandWarnings = [];
    window.__bandRealWarn = ui.notifications.warn.bind(ui.notifications);
    ui.notifications.warn = (m, ...r) => {
      window.__bandWarnings.push(String(m)); return window.__bandRealWarn(m, ...r);
    };

    const riderA = canvas.tokens.get(riderIds[0].tokenId);
    const riderB = canvas.tokens.get(riderIds[1].tokenId);

    // A hull square with nobody on it — where a click lands on the CAR rather than on a person.
    const pose = V.storedPoseOf(handle);
    const rect = L.hullRectIn(
      { x: pose.x, y: pose.y, w: pose.w * grid, h: pose.h * grid }, pose.hull, grid);
    let spot = null;
    for (let cy = rect.h / grid - 1; cy >= 0 && !spot; cy--) {
      for (let cx = 0; cx < rect.w / grid && !spot; cx++) {
        const c = { x: rect.x + (cx + 0.5) * grid, y: rect.y + (cy + 0.5) * grid };
        const clear = [riderA, riderB].every(r => Math.hypot(r.center.x - c.x, r.center.y - c.y) > 70);
        if (clear) spot = c;
      }
    }
    s.hullSpotWorld = spot;

    // Can a rectangle hold a rider without holding its vehicle? Asked of the core's own selection
    // predicate rather than argued: an aboard rider sits INSIDE the vehicle's token square, so the
    // answer decides whether "a band over riders alone" is a reachable gesture at all.
    const vp = canvas.tokens.get(handle.id);
    const tiny = new PIXI.Rectangle(riderA.center.x - 2, riderA.center.y - 2, 4, 4);
    s.tightBandAlsoHoldsVehicle = vp._overlapsSelection(tiny);

    // Every point every gesture touches, in scene coordinates. The view is then set so that the
    // whole set lands on the strip of window the interface does not cover.
    const points = {
      bandFrom: { x: 800, y: 1120 },
      bandTo: { x: 1980, y: 1680 },
      riderAAt: { x: riderA.center.x, y: riderA.center.y },
      riderBAt: { x: riderB.center.x, y: riderB.center.y },
      riderAOff: { x: riderA.center.x - 500, y: riderA.center.y },
      hullSpotAt: spot,
      hullSpotShifted: spot ? { x: spot.x + 300, y: spot.y } : null,
    };
    const box = { x0: 800, y0: 1120, x1: 1980, y1: 1680 };
    const scale = 0.6;
    const wantCentre = { x: 600, y: 340 };     // clear of the sidebar, the banner and the hotbar
    await canvas.animatePan({
      x: (box.x0 + box.x1) / 2 + (window.innerWidth / 2 - wantCentre.x) / scale,
      y: (box.y0 + box.y1) / 2 + (window.innerHeight / 2 - wantCentre.y) / scale,
      scale, duration: 1,
    });
    await sleep(800);

    const toScreen = p => { const t = canvas.stage.worldTransform.apply(p); return { x: t.x, y: t.y }; };
    const blocked = [];
    for (const [name, p] of Object.entries(points)) {
      if (!p) { blocked.push(`${name}:missing`); continue; }
      const sp = toScreen(p);
      s[name] = sp;
      const el = document.elementFromPoint(Math.round(sp.x), Math.round(sp.y));
      if (el?.id !== "board") blocked.push(`${name}:${el?.tagName}#${el?.id}`);
    }
    s.blocked = blocked;

    s.sceneId = scene.id;
    s.vehicleId = vehicle.id;
    s.handleId = handle.id;
    s.riders = riderIds;
    s.freeId = freeDoc.id;
    s.vehicleBefore = { x: handle._source.x, y: handle._source.y };
  } catch (e) { s.err = `${e?.message ?? e}`; }
  return s;
}, SCOPE);

/** A rubber-band: press on empty ground, sweep, let go. */
async function bandDrag(a, b) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(a.x + (b.x - a.x) * i / 10, a.y + (b.y - a.y) * i / 10);
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(600);
}

async function clickAt(p, { shift = false } = {}) {
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
  await page.waitForTimeout(450);
}

const readBand = () => page.evaluate(async ({ SCOPE, s }) => {
  const V = await import(`/modules/${SCOPE}/module/vehicle/vehicle-canvas.js`);
  const scene = game.scenes.get(s.sceneId);
  const handle = scene?.tokens.get(s.handleId);
  const grid = scene?.grid.size ?? 100;
  const pose = handle ? V.storedPoseOf(handle) : null;
  const order = (handle && pose) ? V.seatOrderAt(handle.actor, pose) : null;
  return {
    controlled: (canvas.tokens.controlled ?? []).map(t => t.name).sort(),
    warnings: [...(window.__bandWarnings ?? [])],
    riders: s.riders.map(r => {
      const doc = scene?.tokens.get(r.tokenId);
      if (!doc) return null;
      const seatIndex = Number(doc.flags?.[SCOPE]?.seatIndex);
      const seat = (pose && order)
        ? V.riderSeatAt(pose, grid, seatIndex, { w: doc.width, h: doc.height }, order) : null;
      return {
        name: doc.name, x: doc._source.x, y: doc._source.y, seat: seatIndex,
        onSeat: !!seat && doc._source.x === seat.x && doc._source.y === seat.y,
      };
    }),
    vehicle: handle ? { x: handle._source.x, y: handle._source.y } : null,
  };
}, { SCOPE, s: bandSetup });

const clearBandWarnings = () => page.evaluate(() => { window.__bandWarnings.length = 0; });
const releaseAll = () => page.evaluate(async () => {
  canvas.tokens.releaseAll();
  await new Promise(r => setTimeout(r, 250));
});

let bandGrab = null, riderClick = null, twoRiderDrag = null, twoRiderPick = null;
let vehicleWithRider = null, vehiclePick = null, bandNoVehicle = null, bandTables = null;
if (!bandSetup.err) {
  // (a) the band from the report: everything on and around the car, in one sweep
  await releaseAll();
  await clearBandWarnings();
  await bandDrag(bandSetup.bandFrom, bandSetup.bandTo);
  bandGrab = await readBand();

  // (b) a rider is still selectable on its own — sheets, targeting, everything else
  await releaseAll();
  await clickAt(bandSetup.riderAAt);
  riderClick = await readBand();

  // (c) two riders picked deliberately, then dragged: one gesture, one message
  await releaseAll();
  await clickAt(bandSetup.riderAAt);
  await clickAt(bandSetup.riderBAt, { shift: true });
  twoRiderPick = await readBand();
  await clearBandWarnings();
  await pointerDrag(bandSetup.riderAAt, bandSetup.riderAOff);
  twoRiderDrag = await readBand();

  // (d) the vehicle picked together with a rider, then the car dragged
  if (bandSetup.hullSpotAt) {
    await releaseAll();
    await clickAt(bandSetup.hullSpotAt);
    await clickAt(bandSetup.riderAAt, { shift: true });
    vehiclePick = await readBand();
    await clearBandWarnings();
    await pointerDrag(bandSetup.hullSpotAt, bandSetup.hullSpotShifted);
    await page.waitForTimeout(1500);
    vehicleWithRider = await readBand();
  }

  // (e) the same band with NO vehicle in it keeps the riders — the handle is removed first, which
  // is the one arrangement where an aboard rider can be swept up without its vehicle.
  await releaseAll();
  await page.evaluate(async (s) => {
    await game.scenes.get(s.sceneId)?.tokens.get(s.handleId)?.delete();
    await new Promise(r => setTimeout(r, 600));
  }, bandSetup);
  await clearBandWarnings();
  await bandDrag(bandSetup.bandFrom, bandSetup.bandTo);
  bandNoVehicle = await readBand();

  // (f) both rules as plain-value tables
  bandTables = await page.evaluate(async (SCOPE) => {
    try {
      const LOCK = await import(`/modules/${SCOPE}/module/vehicle/vehicle-ride-lock.js`);
      return {
        drop: {
          both: LOCK.shouldDropFromGrab({ aboard: true, vehicleGrabbed: true }),
          riderOnly: LOCK.shouldDropFromGrab({ aboard: true, vehicleGrabbed: false }),
          notAboard: LOCK.shouldDropFromGrab({ aboard: false, vehicleGrabbed: true }),
        },
        announce: {
          first: LOCK.shouldAnnounceRefusal({ vehicleMovesToo: false, alreadyAnnounced: false }),
          second: LOCK.shouldAnnounceRefusal({ vehicleMovesToo: false, alreadyAnnounced: true }),
          carCameToo: LOCK.shouldAnnounceRefusal({ vehicleMovesToo: true, alreadyAnnounced: false }),
        },
      };
    } catch (e) { return { err: String(e?.message ?? e) }; }
  }, SCOPE);
}

await page.evaluate(async (s) => {
  if (window.__bandRealWarn) ui.notifications.warn = window.__bandRealWarn;
  if (window.__bandNotifications) window.__bandNotifications.style.display = "";
  for (const r of s.riders ?? []) await game.actors.get(r.actorId)?.delete();
  await game.actors.get(s.vehicleId)?.delete();
  await game.scenes.get(s.sceneId)?.delete();
}, bandSetup).catch(() => {});

/* ------------------------------------------------------------------ assertions */

if (out.err) console.log(`  (fixture error) ${out.err}`);
check("the measurement run completed without throwing", !out.err, out.err ? out.err.split("\n")[0] : "");

console.log("\n§1 — the rotation-zero convention, in one place");
check("rotation zero points south", out.convention?.zeroFront === "s", String(out.convention?.zeroFront));
check("the shipped footprint is DEEP, not wide (the long axis is the travel axis)",
  out.convention?.footprint.h > out.convention?.footprint.w,
  `${out.convention?.footprint.w} across x ${out.convention?.footprint.h} deep`);
check("a vehicle actor records its HULL deep rather than wide",
  out.hull?.h > out.hull?.w
  && out.hull?.w === out.convention?.footprint.w && out.hull?.h === out.convention?.footprint.h,
  `hull ${out.hull?.w}x${out.hull?.h}`);
check("the actor's token frame is the SQUARE that carries that hull, not the hull itself",
  out.prototype?.w === out.prototype?.h && out.prototype?.w === out.frameSquare
  && out.frameSquare === Math.max(out.hull?.w, out.hull?.h),
  `frame ${out.prototype?.w}x${out.prototype?.h} for a ${out.hull?.w}x${out.hull?.h} hull`);
check("the placed handle carries the same square, and still answers with the same hull",
  out.handle?.w === out.frameSquare && out.handle?.h === out.frameSquare
  && out.handleHull?.w === out.hull?.w && out.handleHull?.h === out.hull?.h,
  `frame ${out.handle?.w}x${out.handle?.h}, hull ${out.handleHull?.w}x${out.handleHull?.h}`);
check("the handle's art is scaled down to the hull so it cannot hang outside its own outline",
  Math.abs((out.handleArtScale ?? 0) - Math.min(out.hull?.w, out.hull?.h) / Math.max(out.hull?.w, out.hull?.h)) < 1e-9,
  `art scale ${out.handleArtScale} for a ${out.hull?.w}x${out.hull?.h} hull`);
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
check("the HULL's long axis lies ALONG the direction of travel",
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
check("NEGATIVE: a drop on a seat somebody else holds returns the rider to its own",
  out.seatChange?.offSeatIndex === 2 && out.seatChange?.offSeatReturned === true,
  `index ${out.seatChange?.offSeatIndex}, back on seat ${out.seatChange?.offSeatReturned}`);

console.log("\n§5c — the ride lock: aboard, the vehicle owns where you are");
check("a move to a destination off the hull is REFUSED, not written and undone",
  out.lock?.outside?.writes === 0,
  `${out.lock?.outside?.writes} position writes reached the rider's document`);
check("the rider's stored position is untouched by the refused move",
  out.lock?.outside?.srcUnchanged === true);
check("the refusal says so — one warning",
  out.lock?.outside?.warned === 1, `${out.lock?.outside?.warned} warnings`);
check("the refused rider keeps its seat index", out.lock?.outside?.seat === 2,
  String(out.lock?.outside?.seat));
check("nothing is left drawn away from the rider's document",
  (out.lock?.outside?.drawnVsDoc ?? -1) >= 0 && out.lock.outside.drawnVsDoc < 1,
  `${Math.round(out.lock?.outside?.drawnVsDoc ?? -1)} px`);
check("a move onto another seat still changes the seat",
  out.lock?.inHull?.seat === 1, `seat ${out.lock?.inHull?.seat}`);
check("and lands on that seat exactly",
  out.lock?.inHull?.landedX === out.lock?.inHull?.wantX
  && out.lock?.inHull?.landedY === out.lock?.inHull?.wantY,
  `${out.lock?.inHull?.landedX},${out.lock?.inHull?.landedY} vs ${out.lock?.inHull?.wantX},${out.lock?.inHull?.wantY}`);
check("NEGATIVE: a seat change raises no warning", out.lock?.inHull?.warned === 0,
  `${out.lock?.inHull?.warned} warnings`);
check("a drop on the bodywork that is NOT a seat is REFUSED, not written and undone",
  out.lock?.engineCell?.writes === 0,
  `${out.lock?.engineCell?.writes} position writes reached the rider's document`);
check("that refused rider's stored position is untouched",
  out.lock?.engineCell?.srcUnchanged === true);
check("that refusal says so — one warning, the same one-per-gesture latch",
  out.lock?.engineCell?.warned === 1, `${out.lock?.engineCell?.warned} warnings`);
check("the rider refused off a non-seat square keeps its seat index",
  out.lock?.engineCell?.seatKept === true, `seat ${out.lock?.engineCell?.seat}`);
check("the square used for that leg really is an engine cell of the painted layout",
  Number.isInteger(out.lock?.engineCell?.engineIdx), String(out.lock?.engineCell?.engineIdx));
check("EXEMPT: the vehicle's own drive still commits both riders in ONE batched write",
  out.lock?.drive?.riderWrites === 2, `${out.lock?.drive?.riderWrites} rider document updates`);
check("EXEMPT: the drive raises no warning", out.lock?.drive?.warned === 0,
  `${out.lock?.drive?.warned} warnings`);
check("EXEMPT: after that drive every rider's stored position IS its seat",
  (out.lock?.drive?.committed ?? []).length === 2
  && out.lock.drive.committed.every(c => c.srcX === c.seatX && c.srcY === c.seatY),
  (out.lock?.drive?.committed ?? []).map(c => `${c.tag}: ${c.srcX},${c.srcY} vs ${c.seatX},${c.seatY}`).join(" | "));
check("EXEMPT: stepping out clears the aboard flag and moves the token",
  out.lock?.disembark?.flagCleared === true && out.lock?.disembark?.moved === true,
  `flag cleared ${out.lock?.disembark?.flagCleared}, moved ${out.lock?.disembark?.moved}`);
check("EXEMPT: the token stepped out lands off the hull",
  out.lock?.disembark?.offHull === true);
check("EXEMPT: stepping out raises no warning", out.lock?.disembark?.warned === 0,
  `${out.lock?.disembark?.warned} warnings`);
check("boarding again is not refused either", out.lock?.reboarded === 2,
  `${out.lock?.reboarded} aboard`);
check("NEGATIVE: a token that is not aboard moves wherever it is put",
  out.lock?.freeToken?.landedX === 3400 && out.lock?.freeToken?.landedY === 3400
  && out.lock?.freeToken?.warned === 0,
  `${out.lock?.freeToken?.landedX},${out.lock?.freeToken?.landedY}, ${out.lock?.freeToken?.warned} warnings`);
check("the decision table is readable as plain values", !!out.lock?.table,
  out.lock?.tableError ?? "");
check("off the hull refuses; on the hull does not",
  out.lock?.table?.outside === true && out.lock?.table?.inside === false,
  `outside ${out.lock?.table?.outside}, inside ${out.lock?.table?.inside}`);
check("on the hull AND on a seat does not refuse",
  out.lock?.table?.insideSeat === false, String(out.lock?.table?.insideSeat));
check("on the hull but NOT on a seat refuses",
  out.lock?.table?.insideNotSeat === true, String(out.lock?.table?.insideNotSeat));
check("a caller that cannot measure the seats gets the pre-ruling answer, not a refusal",
  out.lock?.table?.insideUnmeasured === false, String(out.lock?.table?.insideUnmeasured));
check("a token that is not aboard is never refused", out.lock?.table?.notAboard === false);
check("a change that is not a move is never refused", out.lock?.table?.notAMove === false);
check("a move the module itself makes is never refused", out.lock?.table?.moduleMove === false);
check("a move that takes the rider out of the vehicle is never refused",
  out.lock?.table?.leaving === false);
check("a rider whose vehicle is not on the scene is never refused",
  out.lock?.table?.hullUnknown === false);

console.log("\n§5d — the same lock against a real pointer drag");
check("the pointer fixture was built", !dragSetup.err, dragSetup.err ?? "");
check("a pointer drag off the hull leaves the rider's stored position exactly where it was",
  dragOff?.x === dragSetup.before?.x && dragOff?.y === dragSetup.before?.y,
  `${dragOff?.x},${dragOff?.y} vs ${dragSetup.before?.x},${dragSetup.before?.y}`);
check("it keeps its seat index", dragOff?.seat === dragSetup.before?.seat,
  `${dragOff?.seat} vs ${dragSetup.before?.seat}`);
check("no ghost is left standing off the vehicle", (dragOff?.drawnVsDoc ?? -1) >= 0 && dragOff.drawnVsDoc < 1,
  `${Math.round(dragOff?.drawnVsDoc ?? -1)} px`);
check("the refusal names the rider and the vehicle in the reader's own language",
  (dragOff?.warnings ?? []).length === 1
  && !/CYBERPUNK\./.test(dragOff.warnings[0])
  && dragOff.warnings[0].includes("__PW__RideDragCrew")
  && dragOff.warnings[0].includes("__PW__RideDragVehicle"),
  (dragOff?.warnings ?? []).join(" | "));
check("a pointer drag onto the next seat still changes the seat",
  dragOnSeat?.seat === 2 && dragOnSeat?.y === dragSetup.before?.y - 100
  && dragOnSeat?.x === dragSetup.before?.x,
  `seat ${dragOnSeat?.seat} at ${dragOnSeat?.x},${dragOnSeat?.y}`);
check("NEGATIVE: that seat change raises no warning", (dragOnSeat?.warnings ?? []).length === 0,
  (dragOnSeat?.warnings ?? []).join(" | "));

console.log("\n§5e — a band grab takes the car, not the crew");
check("the band fixture was built", !bandSetup.err, bandSetup.err ?? "");
check("every point the gestures press on reaches the map, not the interface over it",
  (bandSetup?.blocked ?? ["not measured"]).length === 0,
  (bandSetup?.blocked ?? []).join(", "));
check("the band reached the tokens under it (a token aboard nothing is picked up)",
  (bandGrab?.controlled ?? []).includes("__PW__RideBandFree"),
  (bandGrab?.controlled ?? []).join(", "));
check("the vehicle itself is picked up by the band",
  (bandGrab?.controlled ?? []).includes("__PW__RideBandVehicle"),
  (bandGrab?.controlled ?? []).join(", "));
check("NEITHER rider is left in the selection",
  (bandGrab?.controlled ?? []).filter(n => n.startsWith("__PW__RideBandCrew")).length === 0,
  (bandGrab?.controlled ?? []).join(", "));
check("the band raises no refusal message of its own",
  (bandGrab?.warnings ?? []).length === 0, (bandGrab?.warnings ?? []).join(" | "));
check("a rectangle cannot hold an aboard rider without holding its vehicle",
  bandSetup?.tightBandAlsoHoldsVehicle === true,
  `core selection predicate: ${bandSetup?.tightBandAlsoHoldsVehicle}`);

console.log("\n§5f — a rider is still selectable by hand");
check("a single click on a rider controls that rider",
  (riderClick?.controlled ?? []).length === 1
  && riderClick.controlled[0] === "__PW__RideBandCrewA",
  (riderClick?.controlled ?? []).join(", "));
check("two riders can still be picked deliberately, one after the other",
  (twoRiderPick?.controlled ?? []).filter(n => n.startsWith("__PW__RideBandCrew")).length === 2,
  (twoRiderPick?.controlled ?? []).join(", "));
check("a band with no vehicle in it keeps the riders it swept up",
  (bandNoVehicle?.controlled ?? []).filter(n => n.startsWith("__PW__RideBandCrew")).length === 2,
  (bandNoVehicle?.controlled ?? []).join(", "));

console.log("\n§5g — one gesture, one message");
check("dragging two picked riders off the car produces EXACTLY ONE message",
  (twoRiderDrag?.warnings ?? []).length === 1,
  `${(twoRiderDrag?.warnings ?? []).length} — ${(twoRiderDrag?.warnings ?? []).join(" | ")}`);
check("both riders are still on their seats after that refusal",
  (twoRiderDrag?.riders ?? []).length === 2
  && twoRiderDrag.riders.every(r => r?.onSeat === true),
  JSON.stringify(twoRiderDrag?.riders));
check("the vehicle and a rider can be picked together",
  (vehiclePick?.controlled ?? []).includes("__PW__RideBandVehicle")
  && (vehiclePick?.controlled ?? []).includes("__PW__RideBandCrewA"),
  (vehiclePick?.controlled ?? []).join(", "));
check("dragging that pair moves the car",
  vehicleWithRider?.vehicle?.x !== bandSetup?.vehicleBefore?.x,
  `${bandSetup?.vehicleBefore?.x} -> ${vehicleWithRider?.vehicle?.x}`);
check("dragging that pair says NOTHING — the coupling seats the crew anyway",
  (vehicleWithRider?.warnings ?? []).length === 0,
  (vehicleWithRider?.warnings ?? []).join(" | "));
check("and every rider ends on its seat for the car's new pose",
  (vehicleWithRider?.riders ?? []).length === 2
  && vehicleWithRider.riders.every(r => r?.onSeat === true),
  JSON.stringify(vehicleWithRider?.riders));
check("the two rules read as plain-value tables", !bandTables?.err, bandTables?.err ?? "");
check("a rider is dropped from a grab only when its vehicle is in it",
  bandTables?.drop?.both === true && bandTables?.drop?.riderOnly === false
  && bandTables?.drop?.notAboard === false, JSON.stringify(bandTables?.drop));
check("a refusal speaks once per operation, and not at all when the car moves too",
  bandTables?.announce?.first === true && bandTables?.announce?.second === false
  && bandTables?.announce?.carCameToo === false, JSON.stringify(bandTables?.announce));

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
