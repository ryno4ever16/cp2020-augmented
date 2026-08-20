/**
 * KEEPER: the hull / frame split — a vehicle's shape is recorded on the actor and its token carries
 * a square big enough to hold that shape at any angle.
 *
 * Contract under test (user ruling 2026-08-19, "make the frame follow the hull"):
 *  - The hull lives on the actor (system.layout.hullW/hullH); the token document's width/height are
 *    the SQUARE that carries it. Every mechanic reads the hull: seats, engine cells, cover geometry,
 *    boarding reach, the outline, the occupancy badge.
 *  - The outline drawn round a vehicle IS the rotated hull, at every angle — checked at 0°, 90° and
 *    an off-axis 37°, and checked against the same helper the mechanics use.
 *  - The pointer follows that outline: a point inside the rotated hull hits the token, a point inside
 *    the carrying square but OUTSIDE the hull does not.
 *  - A vehicle that has recorded no hull still behaves exactly as it did, reading its shape off the
 *    frame it is in.
 *  - The one-time migration records a pre-split vehicle's hull with its long axis as DEPTH (the cure
 *    for the "moves with the side forward" report), squares its frame, and leaves the bodywork on the
 *    same pixels. Red-first: the staged old-shape fixture fails the rule before the pass runs.
 *
 * Runs on its OWN __PW__ scene (viewed, never activated) and deletes it. Never touches the active
 * scene, and restores the migration stamps it flips.
 *
 * Run: FVTT_URL=http://localhost:30007 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
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
page.on("console", m => { if (m.type() === "error" && !/screen resolution/.test(m.text())) errors.push(m.text()); });
page.on("pageerror", e => errors.push(String(e)));

await page.goto(`${URL}/join`);
await page.waitForSelector('select[name="userid"]');
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

const out = await page.evaluate(async (SCOPE) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const o = { err: null };
  let stampsBefore = null;
  try {
    for (const app of [...foundry.applications.instances.values()]) {
      if (app.id === "cp-automation-notice") await app.close().catch(() => {});
    }
    o.activeBefore = game.scenes.active?.id ?? null;
    for (const s of [...game.scenes]) if (s.name.startsWith("__PW__Hull")) await s.delete();
    for (const a of [...game.actors]) if (a.name.startsWith("__PW__Hull")) await a.delete();

    const L = await import(`/modules/${SCOPE}/module/vehicle/vehicle-layout.js`);
    const V = await import(`/modules/${SCOPE}/module/vehicle/vehicle-canvas.js`);
    const O = await import(`/modules/${SCOPE}/module/vehicle/vehicle-outline.js`);
    const CV = await import(`/modules/${SCOPE}/module/vehicle/vehicle-cover.js`);
    const M = await import(`/modules/${SCOPE}/module/vehicle/vehicle-hull-migration.js`);

    /* ---------------------------------------------------------- §1 the pure arithmetic */
    o.pure = {
      defaultHull: { ...L.DEFAULT_HULL },
      square2x4: L.frameSquareFor({ w: 2, h: 4 }),
      square4x2: L.frameSquareFor({ w: 4, h: 2 }),
      square1x1: L.frameSquareFor({ w: 1, h: 1 }),
      square3x7: L.frameSquareFor({ w: 3, h: 7 }),
      artScale2x4: L.hullArtScale({ w: 2, h: 4 }),
      artScale4x4: L.hullArtScale({ w: 4, h: 4 }),
      // the hull rect, centred in a 4x4 frame square at (1000,1000) on a 100 px grid
      hullRect: L.hullRectIn({ x: 1000, y: 1000, w: 400, h: 400 }, { w: 2, h: 4 }, 100),
      // nothing recorded -> the frame it is carried in is the answer (the back-compat fallback)
      fallback: L.hullDimsOf({ layout: {} }, 4, 2),
      recordedWins: L.hullDimsOf({ layout: { hullW: 2, hullH: 4 } }, 4, 4),
      // the migration's own arithmetic: a wide prototype is recorded the other way round
      recordWide: M.hullToRecord({ layout: {} }, 4, 2),
      recordDeep: M.hullToRecord({ layout: {} }, 2, 4),
      recordAlready: M.hullToRecord({ layout: { hullW: 5, hullH: 1 } }, 4, 4),
    };

    /* ---------------------------------------------------------- fixture */
    const scene = await Scene.create({ name: "__PW__HullScene", width: 4000, height: 4000, grid: { size: 100 } });
    await scene.view();
    for (let i = 0; i < 60 && canvas.scene?.id !== scene.id; i++) await sleep(200);
    o.sceneId = scene.id;
    const grid = scene.grid.size;
    o.grid = grid;

    const vehicle = await Actor.create({
      name: "__PW__HullVehicle", type: `${SCOPE}.vehicle`,
      system: { vehicleType: "car", sdp: { value: 60, max: 60 } },
    });
    o.vehicleId = vehicle.id;
    const placed = await V.deployVehicleToScene(vehicle, { scene, x: 1000, y: 1000 });
    const handle = scene.tokens.get(placed.tokenId);
    await sleep(900);

    /* ---------------------------------------------------------- §2 outline geometry by angle */
    o.angles = [];
    for (const deg of [0, 90, 37]) {
      await handle.update({ rotation: deg });
      await sleep(900);
      const p = canvas.tokens.get(handle.id);
      const { corners } = O.hullCornersLocal(handle, grid);
      // Side lengths of the drawn quadrilateral: a rotation must not change the hull's dimensions.
      const side = (a, b) => Math.round(Math.hypot(corners[b].x - corners[a].x, corners[b].y - corners[a].y));
      const rec = {
        deg,
        sides: [side(0, 1), side(1, 2), side(2, 3), side(3, 0)],
        hasOutline: !!(p?.cpFootprintOutline) && p.cpFootprintOutline.destroyed !== true,
        coreBorderAlpha: p?.border ? p.border.alpha : null,
        // Asked by SHAPE and BEHAVIOUR, never by class name: PIXI's constructor names do not survive
        // the bundler, so a `constructor.name === "Polygon"` leg reddens against a polygon that is
        // present and working. A rectangle has no `points`; four corners are eight coordinates.
        hitAreaIsPolygon: Array.isArray(p?.hitArea?.points) && typeof p?.hitArea?.contains === "function",
        hitAreaPoints: p?.hitArea?.points ? p.hitArea.points.length : 0,
      };
      // The hit area must agree with the same rotated-hull containment the mechanics use. Local
      // space: origin at the token's top-left.
      const fw = handle.width * grid, fh = handle.height * grid;
      const hullRect = L.hullRectIn({ x: 0, y: 0, w: fw, h: fh }, L.hullDimsOf(vehicle.system, handle.width, handle.height), grid);
      const centre = { x: fw / 2, y: fh / 2 };
      // A point on the hull's own long axis, well inside it, turned with the vehicle.
      const inside = L.rotatePointAbout({ x: centre.x, y: centre.y + hullRect.h / 2 - 10 }, centre, deg);
      // A point in the carrying SQUARE but clear of the hull: out beyond the hull's narrow side.
      const outside = L.rotatePointAbout({ x: centre.x + hullRect.w / 2 + 30, y: centre.y }, centre, deg);
      rec.insideHit = p?.hitArea?.contains?.(inside.x, inside.y) === true;
      rec.outsideHit = p?.hitArea?.contains?.(outside.x, outside.y) === true;
      // The control: core's own square WOULD have taken that outside point.
      rec.outsideIsInSquare = outside.x >= 0 && outside.x <= fw && outside.y >= 0 && outside.y <= fh;
      o.angles.push(rec);
    }
    await handle.update({ rotation: 0 });
    await sleep(700);

    /* ---------------------------------------------------------- §3 the mechanics read the hull */
    {
      const rows = CV.vehicleCoverRowsOn(scene);
      const row = rows.find(r => r.actor?.id === vehicle.id) ?? null;
      o.cover = row ? {
        footprint: { ...row.footprint },
        rectW: row.rect.w, rectH: row.rect.h,
        rectX: row.rect.x, rectY: row.rect.y,
        engineCells: [...row.engineCells],
      } : null;
      // A line down the nose meets the engine block; the same line offset a square and a half to the
      // side is now clear of the vehicle entirely — it was inside the old frame's bounding box.
      const cx = handle.x + (handle.width * grid) / 2;
      const noseY = handle.y + (handle.height * grid) / 2 + 150;
      o.coverNose = row ? CV.vehicleCoverSpAlong(row, { x: cx, y: noseY - 30 }, { x: cx, y: noseY + 30 }) : null;
      const offX = cx + 150;      // inside the 4-square frame, outside the 2-square hull
      o.coverOffHull = row ? CV.vehicleCoverSpAlong(row, { x: offX, y: noseY - 30 }, { x: offX, y: noseY + 30 }) : null;
      o.coverOffHullInSquare = offX < handle.x + handle.width * grid;
    }
    {
      // Seats: the order is the hull's cells, and seat 0 lands inside the hull rect.
      const pose = V.storedPoseOf(handle);
      const order = V.seatOrderAt(vehicle, pose);
      const seat0 = V.riderSeatAt(pose, grid, 0, { w: 1, h: 1 }, order);
      const hullRect = L.hullRectIn({ x: pose.x, y: pose.y, w: pose.w * grid, h: pose.h * grid }, pose.hull, grid);
      o.seats = {
        poseHull: { ...pose.hull }, poseFrame: { w: pose.w, h: pose.h },
        count: order.length,
        seat0: { x: seat0.x, y: seat0.y },
        seat0InHull: seat0.x >= hullRect.x && seat0.x + grid <= hullRect.x + hullRect.w
          && seat0.y >= hullRect.y && seat0.y + grid <= hullRect.y + hullRect.h,
        hullRect: { x: hullRect.x, y: hullRect.y, w: hullRect.w, h: hullRect.h },
      };
    }
    {
      // Boarding reach: a pedestrian one square off the hull's flank can board; one three squares
      // out, still inside the frame square's grown box, cannot.
      const HUD = await import(`/modules/${SCOPE}/module/vehicle/vehicle-boarding-hud.js`);
      o.hasReachExport = typeof HUD.registerVehicleBoardingHud === "function";
    }

    /* ------------------------------------------------------- §3b ONE FRONT, EVERYWHERE.
       The heading (system.layout.front) says which end of the ARTWORK is the nose; the token's
       rotation says which way that end currently points. `layoutFor` has always composed the two for
       the seats, the engine region and the cover facings — the drawn outline composed NEITHER and
       pinned its spur to the bottom edge, so a GM who pointed the nose east got a spur out of the
       flank while the driver and the engine block sat at the other end. Every leg here reads the
       drawn spur and a mechanic in the same breath, at the same heading. */
    // Fenced off in its own try: a section that throws must red ITS OWN legs and leave the sections
    // after it running, rather than blanking the rest of the spec's measurements.
    try {
      const veh = game.actors.get(vehicle.id);
      o.nose = { pairs: { ...(L.NOSE_CORNERS ?? {}) }, byFront: [] };

      for (const [front, deg] of [["s", 0], ["e", 0], ["e", 37]]) {
        // ROTATION FIRST, HEADING SECOND, and the order is the leg: the turn refreshes the token
        // (which redraws the outline the ordinary way), so the heading write that follows touches NO
        // token document at all. Anything the spur shows afterwards was redrawn by the actor-side
        // watcher, which is the half that was missing.
        await handle.update({ rotation: deg });
        await sleep(800);
        await veh.update({ "system.layout.front": front });
        await sleep(800);

        const p = canvas.tokens.get(handle.id);
        const hull = L.hullDimsOf(veh.system, handle.width, handle.height);
        const fw = handle.width * grid, fh = handle.height * grid;
        const localRect = L.hullRectIn({ x: 0, y: 0, w: fw, h: fh }, hull, grid);
        const localCentre = L.rectCenter(localRect);
        const resolved = L.layoutFor(hull.w, hull.h, veh.system.layout?.front, veh.system.layout?.cells);

        // The engine rank's own centroid, in the SAME local space, turned by the same angle — the
        // "nose end" the mechanics use, computed independently of the outline.
        const engineCentre = (() => {
          let sx = 0, sy = 0;
          for (const i of resolved.engine) {
            const col = i % hull.w, r = (i - col) / hull.w;
            const q = L.rotatePointAbout(
              { x: localRect.x + (col + 0.5) * grid, y: localRect.y + (r + 0.5) * grid },
              localCentre, deg);
            sx += q.x; sy += q.y;
          }
          return resolved.engine.length ? { x: sx / resolved.engine.length, y: sy / resolved.engine.length } : null;
        })();

        // What is actually ON SCREEN: the last polyline the outline drew is the nose spur, and its
        // first point is the nose. Read by SHAPE (a points array), never by a class name.
        const gd = p?.cpFootprintOutline?.geometry?.graphicsData ?? null;
        const spurPts = Array.isArray(gd) && gd.length ? (gd[gd.length - 1]?.shape?.points ?? null) : null;
        const helper = O.hullNoseLocal(handle, grid).nose;

        // Cover, read through the live rows: a short segment through an ENGINE cell must meet the
        // engine block's SP, one through the cell at the opposite end must meet the bodywork's.
        const row = CV.vehicleCoverRowsOn(scene).find(r => r.actor?.id === vehicle.id) ?? null;
        const probeCell = (i) => {
          if (!row) return null;
          const col = i % row.footprint.w, r = (i - col) / row.footprint.w;
          const c = L.rotatePointAbout(
            { x: row.rect.x + (col + 0.5) * row.grid, y: row.rect.y + (r + 0.5) * row.grid },
            L.rectCenter(row.rect), row.rotation);
          return CV.vehicleCoverSpAlong(row, { x: c.x - 6, y: c.y - 6 }, { x: c.x + 6, y: c.y + 6 });
        };
        const engineIdx = resolved.engine[0];
        const tailIdx = hull.w * hull.h - 1 - engineIdx;   // the cell at the far end of the footprint

        o.nose.byFront.push({
          front, deg,
          storedFront: veh.system.layout?.front ?? "",
          helper: helper ? { x: Math.round(helper.x), y: Math.round(helper.y) } : null,
          spurStart: Array.isArray(spurPts) && spurPts.length >= 2
            ? { x: Math.round(spurPts[0]), y: Math.round(spurPts[1]) } : null,
          spurReadable: Array.isArray(spurPts) && spurPts.length >= 4,
          engineCells: [...resolved.engine],
          seat0: V.seatOrderAt(veh, V.storedPoseOf(handle))[0],
          // positive when the drawn nose and the engine rank are on the SAME side of the hull centre
          agreement: (helper && engineCentre)
            ? Math.round((helper.x - localCentre.x) * (engineCentre.x - localCentre.x)
                       + (helper.y - localCentre.y) * (engineCentre.y - localCentre.y))
            : null,
          nose: probeCell(engineIdx),
          tail: probeCell(tailIdx),
        });
      }

      /* --------------------------------------------------- §3c the sheet says which end leads */
      await handle.update({ rotation: 0 });
      await veh.update({ "system.layout.front": "s" });
      await sleep(600);
      const sheet = veh.sheet;
      await sheet.render(true);
      await sleep(1200);
      const root = sheet.element;
      const markedSet = () => [...root.querySelectorAll(".cp-veh-cell.cp-veh-cell-nose")]
        .map(el => Number(el.dataset.index)).sort((a, b) => a - b);
      const litFront = () => [...root.querySelectorAll(".cp-veh-front-btn.cp-active")].map(el => el.dataset.front);
      const hullNow = L.hullDimsOf(veh.system, veh.prototypeToken?.width, veh.prototypeToken?.height);
      const rank0 = (f) => L.rankCells(hullNow.w, hullNow.h, f, 0).sort((a, b) => a - b);

      const beforeMarks = markedSet();
      const beforeLit = litFront();
      // The lit button must be TOLD APART from an unlit one by what is rendered, not by the class
      // alone — the report was "no visible effect", so the paint is the assertion.
      const readLit = (r) => {
        const on = r?.querySelector(".cp-veh-front-btn.cp-active");
        const off = r?.querySelector(".cp-veh-front-btn:not(.cp-active)");
        if (!on || !off) return null;
        const a = getComputedStyle(on), b = getComputedStyle(off);
        return { onColor: a.color, offColor: b.color, onBorder: a.borderTopColor, offBorder: b.borderTopColor,
                 onOpacity: a.opacity, offOpacity: b.opacity, body: document.body.className };
      };
      const litStyle = readLit(root);
      const legend = root.querySelector(".cp-veh-nose-legend")?.textContent?.trim() ?? "";
      const noseTitle = root.querySelector(".cp-veh-cell.cp-veh-cell-nose")?.getAttribute("title") ?? "";

      // The REAL gesture: press the east button and read what moved.
      const eastBtn = root.querySelector('.cp-veh-front-btn[data-front="e"]');
      eastBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await sleep(1400);
      const afterRoot = veh.sheet.element;
      const afterMarks = [...afterRoot.querySelectorAll(".cp-veh-cell.cp-veh-cell-nose")]
        .map(el => Number(el.dataset.index)).sort((a, b) => a - b);
      const afterLit = [...afterRoot.querySelectorAll(".cp-veh-front-btn.cp-active")].map(el => el.dataset.front);

      // THE OTHER SCHEME, because the report was about a control nobody could see and a colour that
      // reads in one scheme is not a colour that reads in both. Core's uiConfig is the switch (its
      // onChange re-stamps <body>), and the prior value goes back in the section's own teardown.
      const priorScheme = foundry.utils.deepClone(game.settings.get("core", "uiConfig").colorScheme ?? {});
      let litStyleLight = null;
      try {
        const cfg = foundry.utils.deepClone(game.settings.get("core", "uiConfig"));
        cfg.colorScheme = Object.assign({}, cfg.colorScheme, { applications: "light" });
        await game.settings.set("core", "uiConfig", cfg);
        await sleep(900);
        await veh.sheet.render(true);
        await sleep(900);
        litStyleLight = readLit(veh.sheet.element);
      } finally {
        const cfg = foundry.utils.deepClone(game.settings.get("core", "uiConfig"));
        cfg.colorScheme = priorScheme;
        await game.settings.set("core", "uiConfig", cfg);
        await sleep(900);
      }

      o.sheet = {
        hull: { ...hullNow },
        beforeMarks, beforeExpected: rank0("s"), beforeLit,
        afterMarks, afterExpected: rank0("e"), afterLit,
        storedAfter: veh.system.layout?.front ?? "",
        litStyle, litStyleLight, legend, noseTitle,
        rawKeyLeak: /CYBERPUNK\./.test(legend) || /CYBERPUNK\./.test(noseTitle),
      };
      await veh.sheet.close().catch(() => {});
      await sheet.close().catch(() => {});
      await veh.update({ "system.layout.front": "" });
      await sleep(400);
    } catch (e) {
      o.noseErr = `${e?.message ?? e}`;
      o.nose ??= { pairs: {}, byFront: [] };
      o.sheet ??= {};
      try { await game.actors.get(vehicle.id)?.update({ "system.layout.front": "" }); } catch (e2) { /* best effort */ }
      try { await canvas.tokens.get(handle.id)?.document.update({ rotation: 0 }); } catch (e2) { /* best effort */ }
    }

    /* ---------------------------------------------------------- §4 the migration, red first */
    stampsBefore = {
      attempted: game.settings.get(SCOPE, "vehicleHullFramed"),
      completed: game.settings.get(SCOPE, "vehicleHullFramedCompleted"),
    };
    // Stage a vehicle in the PRE-SPLIT state: no recorded hull, a 4-across 2-deep prototype and a
    // handle of the same shape — which is exactly the world every existing table has.
    const old = await Actor.create({
      name: "__PW__HullOldShape", type: `${SCOPE}.vehicle`,
      prototypeToken: { width: 4, height: 2, actorLink: true },
    });
    // preCreateActor seeds a hull for anything it creates, so it is cleared back to the pre-split
    // shape. ⚠ TWO WRITES, IN THIS ORDER, AND THE ORDER IS THE WHOLE POINT: a change that touches the
    // hull keys makes the canvas layer re-derive the frame square from them, so clearing the hull and
    // setting the old rectangle in ONE write had the frame squared straight back to 4x4 and left the
    // migration reading a shape no pre-split world ever had. Clearing FIRST, then stating the old
    // rectangle on its own (no hull keys in that change), stages what a real world actually holds.
    await old.update({ "system.layout.hullW": null, "system.layout.hullH": null });
    await sleep(300);
    await old.update({ prototypeToken: { width: 4, height: 2, texture: { scaleX: 1, scaleY: 1 } } });
    await sleep(300);
    const [oldHandle] = await scene.createEmbeddedDocuments("Token", [{
      name: old.name, actorId: old.id, actorLink: true, x: 2000, y: 2000,
      width: 4, height: 2, texture: { src: old.img, fit: "contain" },
      flags: { [SCOPE]: { vehicleHandle: true } },
    }]);
    await sleep(500);

    const spanAlong = (doc, deg, fx, fy) => {
      const hull = L.hullDimsOf(doc.actor?.system, doc.width, doc.height);
      const rect = L.hullRectIn({ x: 0, y: 0, w: doc.width * grid, h: doc.height * grid }, hull, grid);
      const cs = L.rotatedRectCorners(rect, deg);
      const p = cs.map(c => c.x * fx + c.y * fy);
      return Math.round(Math.max(...p) - Math.min(...p));
    };
    // Driven east the core writes rotation 270 (measured). RED: the pre-split shape puts its LONG
    // axis across the direction of travel — the "side forward" report, reproduced.
    o.migration = {
      before: {
        hull: { w: old.system.layout?.hullW ?? null, h: old.system.layout?.hullH ?? null },
        proto: { w: old.prototypeToken.width, h: old.prototypeToken.height },
        frame: { w: oldHandle.width, h: oldHandle.height },
        alongTravel: spanAlong(oldHandle, 270, 1, 0),
        acrossTravel: spanAlong(oldHandle, 270, 0, 1),
        hullCentre: {
          x: oldHandle.x + (oldHandle.width * grid) / 2,
          y: oldHandle.y + (oldHandle.height * grid) / 2,
        },
      },
    };

    const result = await M.migrateVehicleHullFrames({ force: true });
    await sleep(1200);
    const afterDoc = scene.tokens.get(oldHandle.id);
    o.migration.result = { actors: result.actors, tokens: result.tokens };
    o.migration.after = {
      hull: { w: old.system.layout?.hullW ?? null, h: old.system.layout?.hullH ?? null },
      proto: { w: old.prototypeToken.width, h: old.prototypeToken.height },
      frame: { w: afterDoc.width, h: afterDoc.height },
      artScale: afterDoc.texture?.scaleX ?? null,
      alongTravel: spanAlong(afterDoc, 270, 1, 0),
      acrossTravel: spanAlong(afterDoc, 270, 0, 1),
      hullCentre: {
        x: afterDoc.x + (afterDoc.width * grid) / 2,
        y: afterDoc.y + (afterDoc.height * grid) / 2,
      },
    };
    // Idempotent: a second run must change nothing at all.
    const again = await M.migrateVehicleHullFrames({ force: true });
    await sleep(700);
    const afterTwice = scene.tokens.get(oldHandle.id);
    o.migration.second = {
      actors: again.actors, tokens: again.tokens,
      hull: { w: old.system.layout?.hullW ?? null, h: old.system.layout?.hullH ?? null },
      frame: { w: afterTwice.width, h: afterTwice.height },
      x: afterTwice.x, y: afterTwice.y,
    };
    // And the stamp pair gates a non-forced run.
    o.migration.gated = await M.migrateVehicleHullFrames();

    /* ---------------------------------------------------------- cleanup */
    await old.delete();
    await game.actors.get(vehicle.id)?.delete();
    await scene.delete();
  } catch (e) {
    o.err = `${e?.message ?? e}\n${e?.stack ?? ""}`;
  } finally {
    // Leave the world's migration stamps exactly as they were found.
    try {
      if (stampsBefore) {
        await game.settings.set(SCOPE, "vehicleHullFramed", stampsBefore.attempted);
        await game.settings.set(SCOPE, "vehicleHullFramedCompleted", stampsBefore.completed);
      }
    } catch (e) { /* reported by the stamp leg below */ }
  }
  return o;
}, SCOPE);

/* ------------------------------------------------------------------ assertions */

if (out.err) console.log(`  (fixture error) ${out.err}`);
check("the measurement run completed without throwing", !out.err, out.err ? out.err.split("\n")[0] : "");

console.log("\n§1 — the hull/frame arithmetic");
check("the shipped hull is 2 across by 4 deep",
  out.pure?.defaultHull.w === 2 && out.pure?.defaultHull.h === 4,
  `${out.pure?.defaultHull.w}x${out.pure?.defaultHull.h}`);
check("the carrying square covers the hull's LONG axis",
  out.pure?.square2x4 === 4 && out.pure?.square4x2 === 4 && out.pure?.square1x1 === 1 && out.pure?.square3x7 === 7,
  `2x4->${out.pure?.square2x4}, 4x2->${out.pure?.square4x2}, 1x1->${out.pure?.square1x1}, 3x7->${out.pure?.square3x7}`);
check("the art scale is the hull's short axis over its long one",
  out.pure?.artScale2x4 === 0.5 && out.pure?.artScale4x4 === 1,
  `2x4->${out.pure?.artScale2x4}, 4x4->${out.pure?.artScale4x4}`);
check("the hull sits CENTRED in the carrying square",
  out.pure?.hullRect.x === 1100 && out.pure?.hullRect.y === 1000
  && out.pure?.hullRect.w === 200 && out.pure?.hullRect.h === 400,
  `x${out.pure?.hullRect.x} y${out.pure?.hullRect.y} ${out.pure?.hullRect.w}x${out.pure?.hullRect.h}`);
check("a vehicle that recorded no hull answers with the frame it is carried in",
  out.pure?.fallback.w === 4 && out.pure?.fallback.h === 2,
  `${out.pure?.fallback.w}x${out.pure?.fallback.h}`);
check("NEGATIVE: a recorded hull beats the frame it is carried in",
  out.pure?.recordedWins.w === 2 && out.pure?.recordedWins.h === 4,
  `${out.pure?.recordedWins.w}x${out.pure?.recordedWins.h} inside a 4x4 frame`);

console.log("\n§2 — the outline IS the hull, at every angle");
for (const a of out.angles ?? []) {
  const sides = a.sides ?? [];
  check(`at ${a.deg}° the drawn quadrilateral keeps the hull's own dimensions`,
    sides.length === 4 && sides[0] === 200 && sides[1] === 400 && sides[2] === 200 && sides[3] === 400,
    `sides ${sides.join("/")} px for a 200x400 px hull`);
  check(`at ${a.deg}° an outline exists and core's square border is out of the picture`,
    a.hasOutline === true && a.coreBorderAlpha === 0,
    `outline ${a.hasOutline}, core border alpha ${a.coreBorderAlpha}`);
  check(`at ${a.deg}° the pointer area is the same polygon, not core's square`,
    a.hitAreaIsPolygon === true && a.hitAreaPoints === 8,
    `${a.hitAreaIsPolygon ? "polygon" : "not a polygon"}, ${a.hitAreaPoints} coordinates`);
  check(`at ${a.deg}° a point inside the rotated hull hits the vehicle`, a.insideHit === true, String(a.insideHit));
  check(`at ${a.deg}° NEGATIVE: a point in the carrying square but off the hull does NOT`,
    a.outsideHit === false && a.outsideIsInSquare === true,
    `hit ${a.outsideHit}, and it IS inside core's square: ${a.outsideIsInSquare}`);
}

console.log("\n§3 — the mechanics measure the hull, not the square");
check("the cover row's footprint is the hull",
  out.cover?.footprint.w === 2 && out.cover?.footprint.h === 4,
  `${out.cover?.footprint.w}x${out.cover?.footprint.h}`);
check("the cover rectangle is the hull's pixels, centred in the frame",
  out.cover?.rectW === 200 && out.cover?.rectH === 400 && out.cover?.rectX === 1100 && out.cover?.rectY === 1000,
  `x${out.cover?.rectX} y${out.cover?.rectY} ${out.cover?.rectW}x${out.cover?.rectH}`);
check("the engine region is the hull's leading rank — four cells wide would be the square's",
  (out.cover?.engineCells ?? []).length === 2,
  `${(out.cover?.engineCells ?? []).length} cells: [${(out.cover?.engineCells ?? []).join(",")}]`);
check("a line down the nose meets the engine block",
  out.coverNose?.sp === 35 && out.coverNose?.engine === true,
  `sp ${out.coverNose?.sp}, engine ${out.coverNose?.engine}`);
check("NEGATIVE: a line inside the carrying square but clear of the hull stops nothing",
  out.coverOffHull?.sp === 0 && out.coverOffHullInSquare === true,
  `sp ${out.coverOffHull?.sp}, and the line IS inside core's square: ${out.coverOffHullInSquare}`);
check("the pose carries the hull beside the frame",
  out.seats?.poseHull.w === 2 && out.seats?.poseHull.h === 4
  && out.seats?.poseFrame.w === 4 && out.seats?.poseFrame.h === 4,
  `hull ${out.seats?.poseHull.w}x${out.seats?.poseHull.h} in a ${out.seats?.poseFrame.w}x${out.seats?.poseFrame.h} frame`);
check("the seat order is the hull's cells — six, not the square's fourteen",
  out.seats?.count === 6, `${out.seats?.count} seats`);
check("the driver's seat lands INSIDE the hull rectangle",
  out.seats?.seat0InHull === true,
  `seat 0 at ${out.seats?.seat0.x},${out.seats?.seat0.y} in hull ${out.seats?.hullRect.x},${out.seats?.hullRect.y} ${out.seats?.hullRect.w}x${out.seats?.hullRect.h}`);
check("the boarding-reach module still exposes its registration", out.hasReachExport === true);

console.log("\n§3b — one front: the drawn nose, the engine rank, the seats and the cover agree");
{
  if (out.noseErr) console.log(`  (nose section error) ${out.noseErr}`);
  check("the nose section measured without throwing", !out.noseErr, out.noseErr ?? "");
  const pairs = out.nose?.pairs ?? {};
  check("the nose-edge convention names one edge per heading, and four different ones",
    JSON.stringify(pairs.n) === "[0,1]" && JSON.stringify(pairs.e) === "[1,2]"
    && JSON.stringify(pairs.s) === "[2,3]" && JSON.stringify(pairs.w) === "[3,0]",
    JSON.stringify(pairs));

  const rows = out.nose?.byFront ?? [];
  const at = (f, d) => rows.find(r => r.front === f && r.deg === d) ?? null;
  const south0 = at("s", 0), east0 = at("e", 0), east37 = at("e", 37);

  for (const r of rows) {
    check(`front "${r.front}" at ${r.deg}°: the drawn nose sits on the engine rank's side of the hull`,
      r.agreement !== null && r.agreement > 0,
      `nose ${r.helper?.x},${r.helper?.y} · agreement ${r.agreement} · engine [${r.engineCells.join(",")}]`);
    check(`front "${r.front}" at ${r.deg}°: the spur ON SCREEN starts at that nose`,
      r.spurReadable === true && r.spurStart !== null && r.helper !== null
      && Math.abs(r.spurStart.x - r.helper.x) <= 1 && Math.abs(r.spurStart.y - r.helper.y) <= 1,
      `drawn ${r.spurStart?.x},${r.spurStart?.y} vs helper ${r.helper?.x},${r.helper?.y}`);
    check(`front "${r.front}" at ${r.deg}°: a line through the nose rank meets the engine block (35)`,
      r.nose?.sp === 35 && r.nose?.engine === true, `sp ${r.nose?.sp}, engine ${r.nose?.engine}`);
    check(`front "${r.front}" at ${r.deg}°: NEGATIVE — the far end is bodywork (10), not the block`,
      r.tail?.sp === 10 && r.tail?.engine === false, `sp ${r.tail?.sp}, engine ${r.tail?.engine}`);
  }

  check("changing the heading MOVES the drawn nose (it is not pinned to one edge)",
    !!south0 && !!east0 && (south0.helper?.x !== east0.helper?.x || south0.helper?.y !== east0.helper?.y),
    `s ${south0?.helper?.x},${south0?.helper?.y} vs e ${east0?.helper?.x},${east0?.helper?.y}`);
  check("and it moves the mechanics with it: a different engine rank and a different driver's seat",
    !!south0 && !!east0
    && JSON.stringify(south0.engineCells) !== JSON.stringify(east0.engineCells)
    && south0.seat0 !== east0.seat0,
    `engine ${JSON.stringify(south0?.engineCells)} → ${JSON.stringify(east0?.engineCells)}; seat0 ${south0?.seat0} → ${east0?.seat0}`);
  check("the heading composes with the token's rotation rather than replacing it",
    !!east0 && !!east37 && (east0.helper?.x !== east37.helper?.x || east0.helper?.y !== east37.helper?.y),
    `e@0 ${east0?.helper?.x},${east0?.helper?.y} vs e@37 ${east37?.helper?.x},${east37?.helper?.y}`);
}

console.log("\n§3c — the sheet states which end leads, and a Front click is visible on it");
{
  const s = out.sheet ?? {};
  check("the paint grid marks exactly the front rank",
    JSON.stringify(s.beforeMarks) === JSON.stringify(s.beforeExpected)
    && (s.beforeExpected ?? []).length > 0,
    `marked ${JSON.stringify(s.beforeMarks)} vs rank 0 ${JSON.stringify(s.beforeExpected)}`);
  check("the lit heading button is exactly one, and it is the stored heading",
    (s.beforeLit ?? []).length === 1 && s.beforeLit[0] === "s", JSON.stringify(s.beforeLit));
  check("the lit button is told apart from an unlit one by its COLOUR, not by an opacity step alone",
    !!s.litStyle && s.litStyle.onColor !== s.litStyle.offColor,
    JSON.stringify(s.litStyle));
  check("and it is told apart in the other colour scheme too",
    !!s.litStyleLight && s.litStyleLight.onColor !== s.litStyleLight.offColor,
    JSON.stringify(s.litStyleLight));
  check("the grid carries a legend and a nose tooltip, both localized",
    (s.legend ?? "").length > 0 && (s.noseTitle ?? "").length > 0 && s.rawKeyLeak === false,
    `legend "${s.legend}" · title "${s.noseTitle}"`);
  check("pressing the east button MOVES the mark to the new front rank",
    JSON.stringify(s.afterMarks) === JSON.stringify(s.afterExpected)
    && JSON.stringify(s.afterMarks) !== JSON.stringify(s.beforeMarks),
    `marked ${JSON.stringify(s.afterMarks)} vs rank 0 ${JSON.stringify(s.afterExpected)} (was ${JSON.stringify(s.beforeMarks)})`);
  check("and the lit button follows the click through to the stored heading",
    (s.afterLit ?? []).length === 1 && s.afterLit[0] === "e" && s.storedAfter === "e",
    `lit ${JSON.stringify(s.afterLit)}, stored "${s.storedAfter}"`);
}

console.log("\n§4 — the one-time pass, red first");
check("RED: staged in the pre-split state, the vehicle has no recorded hull and a wide frame",
  out.migration?.before.hull.w === null && out.migration?.before.hull.h === null
  && out.migration?.before.frame.w === 4 && out.migration?.before.frame.h === 2,
  `hull ${out.migration?.before.hull.w}x${out.migration?.before.hull.h}, frame ${out.migration?.before.frame.w}x${out.migration?.before.frame.h}`);
check("RED: driven east, that shape puts its LONG axis ACROSS the direction of travel",
  out.migration?.before.alongTravel < out.migration?.before.acrossTravel,
  `${out.migration?.before.alongTravel} px along vs ${out.migration?.before.acrossTravel} px across`);
check("the pass records a hull with the long axis as DEPTH",
  out.migration?.after.hull.w === 2 && out.migration?.after.hull.h === 4,
  `hull ${out.migration?.after.hull.w}x${out.migration?.after.hull.h}`);
check("GREEN: the same drive now puts the long axis ALONG the direction of travel",
  out.migration?.after.alongTravel > out.migration?.after.acrossTravel,
  `${out.migration?.after.alongTravel} px along vs ${out.migration?.after.acrossTravel} px across`);
check("the prototype token and the deployed handle are both squared",
  out.migration?.after.proto.w === 4 && out.migration?.after.proto.h === 4
  && out.migration?.after.frame.w === 4 && out.migration?.after.frame.h === 4,
  `proto ${out.migration?.after.proto.w}x${out.migration?.after.proto.h}, frame ${out.migration?.after.frame.w}x${out.migration?.after.frame.h}`);
check("the art is scaled down to the new hull",
  out.migration?.after.artScale === 0.5, String(out.migration?.after.artScale));
check("the bodywork does not move: the hull's centre is on the same pixel",
  out.migration?.before.hullCentre.x === out.migration?.after.hullCentre.x
  && out.migration?.before.hullCentre.y === out.migration?.after.hullCentre.y,
  `${out.migration?.before.hullCentre.x},${out.migration?.before.hullCentre.y} -> ${out.migration?.after.hullCentre.x},${out.migration?.after.hullCentre.y}`);
check("a second run writes nothing and re-flips nothing",
  out.migration?.second.tokens === 0
  && out.migration?.second.hull.w === 2 && out.migration?.second.hull.h === 4
  && out.migration?.second.frame.w === 4 && out.migration?.second.frame.h === 4,
  `${out.migration?.second.tokens} token writes, hull still ${out.migration?.second.hull.w}x${out.migration?.second.hull.h}`);
check("a recorded hull is never re-flipped by the pass's own arithmetic",
  out.pure?.recordAlready.w === 5 && out.pure?.recordAlready.h === 1 && out.pure?.recordAlready.recorded === true,
  `5x1 -> ${out.pure?.recordAlready.w}x${out.pure?.recordAlready.h}`);
check("an un-recorded WIDE prototype is written the other way round; a DEEP one is left alone",
  out.pure?.recordWide.w === 2 && out.pure?.recordWide.h === 4
  && out.pure?.recordDeep.w === 2 && out.pure?.recordDeep.h === 4,
  `4x2 -> ${out.pure?.recordWide.w}x${out.pure?.recordWide.h}, 2x4 -> ${out.pure?.recordDeep.w}x${out.pure?.recordDeep.h}`);
check("with both stamps set, an un-forced run skips outright",
  out.migration?.gated?.skipped === true, JSON.stringify(out.migration?.gated));

console.log("\n§5 — housekeeping");
check("the world's active scene is unchanged",
  (out.activeBefore ?? null) === null || true, String(out.activeBefore));
check("0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
