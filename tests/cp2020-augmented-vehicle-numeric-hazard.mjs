/**
 * Vehicle footprint: the numeric hazard, at every layer that touches it.
 *
 * DEFECT (reported from a live table, 2026-08-25, and re-measured on the reporter's own actor). A GM
 * typed `10000` into the second Footprint box of a vehicle sheet. Nothing refused it:
 *   · the sheet's paint grid draws one `<button>` per footprint cell, each with a localized tooltip;
 *   · the hull-change watcher squares a hull into a TOKEN FRAME (`frameSquareFor`), so the token
 *     document was rewritten to 10000 × 10000 grid squares;
 *   · a stray "E" keystroke in the same box then submitted as EMPTY — `input[type=number]` accepts
 *     "e" as an exponent character and reports `badInput` with an empty `.value` — which nulled the
 *     stored dimension. With no hull recorded, `hullDimsOf` fell back to the ruined token frame, so
 *     the sheet asked for 10000 × 10000 = one hundred million cells. The tab ran out of memory, and
 *     because that is recomputed on every open, the vehicle could not be opened again to fix it.
 *
 * CONTRACT, in the four places a footprint figure can be stopped:
 *   1. the DATA MODEL clamps `system.layout.hullW/hullH` into [1, HULL_MAX_SQUARES] (Foundry cleans
 *      an update's changes before validating them, so an API/macro write LANDS clamped, not thrown);
 *   2. the SHEET refuses an out-of-range entry with a notice and puts the box back in range;
 *   3. the same sheet refuses an UNREADABLE entry (the "E") and puts the stored figure back, so the
 *      dimension is never nulled and the footprint never falls through to the token frame;
 *   4. the READ PATH bounds what it RETURNS, so a vehicle whose stored bytes are already poisoned
 *      opens, draws and behaves — with nothing written to repair it. A stored hull above the ceiling
 *      is clamped; a TOKEN FRAME above the ceiling is rejected outright and the vehicle falls back to
 *      the default car, because a frame that size is damage rather than a measurement.
 *
 * ⚠ WHY THE DOM LEGS POISON WITH 60 AND NOT 10000. The pure legs pin the real field figure, which
 * costs nothing to evaluate. The legs that RENDER a sheet or place a token use 60 deliberately: if
 * this unit ever regresses, a 60-square poison draws 3,600 cells and the leg reports red, while a
 * 10000-square poison would take the test browser down with it and report nothing at all. Same
 * mechanism either way — both figures are above the ceiling.
 *
 * Run from the module's tests/:
 *   FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=... node cp2020-augmented-vehicle-numeric-hazard.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const VEHICLE = "cp2020-augmented.vehicle";
const HULL_W = 'input[name="system.layout.hullW"]';
const HULL_H = 'input[name="system.layout.hullH"]';
/** Above the ceiling, and small enough that a regression reds instead of killing the browser. */
const OVERSIZE = 60;

const checks = [];
const ok = (name, cond, got) => checks.push({ name, pass: !!cond, got });

async function joinAs(page, match, passwords) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 60_000 });
  const users = await sel.locator("option").evaluateAll((o) => o.map((x) => ({ v: x.value, l: (x.textContent || "").trim() })).filter((x) => x.v));
  const u = users.find((x) => match.test(x.l));
  if (!u) throw new Error("no matching user on the join form");
  for (const pw of passwords) {
    await sel.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([
      page.waitForNavigation({ url: /\/game/, timeout: 20_000 }).catch(() => {}),
      page.locator('button[name="join"]').click(),
    ]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 30_000 }); return; } catch {}
  }
  throw new Error("could not join");
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e?.message || e)));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
  await joinAs(page, /^gamemaster$/i, [GM_PW]);

  // Record every warning the module raises, so a refusal leg can assert one fired and that its text
  // resolved (a missing key would surface as the bare "CYBERPUNK." prefix).
  await page.evaluate(() => {
    window.__NOTES = [];
    const n = ui.notifications;
    if (!n.__cpHullTap) {
      const orig = n.warn.bind(n);
      n.warn = (msg, opts) => { window.__NOTES.push(String(msg)); return orig(msg, opts); };
      n.__cpHullTap = true;
    }
  });

  /* ------------------------------------------------------------------ §0 fixtures */

  const setup = await page.evaluate(async ([VEHICLE, OVERSIZE]) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // Sweep any debris a previous interrupted run left behind, so a fixture name is never taken.
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__HullGuard"))) await a.delete().catch(() => {});
    for (const i of game.items.filter(i => i.name?.startsWith("__PW__HullGuard"))) await i.delete().catch(() => {});
    for (const s of game.scenes.filter(s => s.name?.startsWith("__PW__HullGuard"))) await s.delete().catch(() => {});
    window.__V = {};
    const mk = async (key, name) => {
      const a = await Actor.create({ name, type: VEHICLE });
      window.__V[key] = a;
      return a;
    };
    // The everyday vehicle every gesture leg drives.
    const clean = await mk("clean", "__PW__HullGuard-Clean");
    await clean.update({
      "system.layout.hullW": 2, "system.layout.hullH": 4,
      "system.crewSlots": 2, "system.passengerSlots": 3,
    });
    // The one the model-clamp legs write absurd figures at. Its sheet is never opened.
    await mk("model", "__PW__HullGuard-Model");
    // THE FIELD SHAPE: one dimension recorded, the other NULLED by the "E", and a token frame that
    // was already blown up before the null landed. Poisoned in that order, because the hull write is
    // what the frame watcher reacts to — the frame has to be ruined AFTER it, exactly as it was.
    const poison = await mk("poison", "__PW__HullGuard-Poison");
    await poison.update({ "system.layout.hullW": 2, "system.layout.hullH": 4 });
    await sleep(400);
    await poison.update({ "system.layout.hullH": null });
    await sleep(400);
    await poison.update({ prototypeToken: { width: OVERSIZE, height: OVERSIZE } });
    await sleep(400);
    const scene = await Scene.create({ name: "__PW__HullGuard-Scene", width: 4000, height: 4000, grid: { size: 100 } });
    window.__SC = scene;
    // Items for the number-guard extension: one on the module's own item sheet, one on the
    // augmented sub-type sheet.
    const prog = await Item.create({ name: "__PW__HullGuard-Program", type: "program", system: { power: 5 } });
    const vw = await Item.create({ name: "__PW__HullGuard-VWeapon", type: "cp2020-augmented.vehicleWeapon", system: { penetration: 3 } });
    window.__I = { prog, vw };
    return {
      cleanHull: { w: clean.system.layout.hullW, h: clean.system.layout.hullH },
      poisonSource: {
        hullW: foundry.utils.getProperty(poison._source, "system.layout.hullW"),
        hullH: foundry.utils.getProperty(poison._source, "system.layout.hullH"),
        protoW: poison.prototypeToken.width, protoH: poison.prototypeToken.height,
      },
      progPower: prog.system.power, vwPen: vw.system.penetration,
    };
  }, [VEHICLE, OVERSIZE]);

  ok("§0 the everyday fixture records an ordinary hull", setup.cleanHull.w === 2 && setup.cleanHull.h === 4, setup.cleanHull);
  ok("§0 the poisoned fixture is the field shape: one dimension recorded, the other null",
    setup.poisonSource.hullW === 2 && setup.poisonSource.hullH === null, setup.poisonSource);
  ok("§0 the poisoned fixture carries the blown-up token frame",
    setup.poisonSource.protoW === OVERSIZE && setup.poisonSource.protoH === OVERSIZE, setup.poisonSource);
  ok("§0 the item fixtures carry the numbers their guard legs protect",
    setup.progPower === 5 && setup.vwPen === 3, setup);

  /* -------------------------------------------- §1 read path: what the helpers RETURN */

  const pure = await page.evaluate(async () => {
    const L = await import("/modules/cp2020-augmented/module/vehicle/vehicle-layout.js");
    return {
      cap: L.HULL_MAX_SQUARES,
      clampBig: L.clampHullDim(10000),
      clampSmall: L.clampHullDim(0),
      clampUnreadable: L.clampHullDim("nope", 3),
      // The field shape at the real figure: hull half-recorded, frame ruined.
      fieldShape: L.hullDimsOf({ layout: { hullW: 2, hullH: null } }, 10000, 10000),
      // A hull RECORDED above the ceiling is clamped, not discarded — it is still a statement.
      recordedTooBig: L.hullDimsOf({ layout: { hullW: 2, hullH: 10000 } }, 4, 4),
      // A credible frame is still trusted, exactly as before this unit.
      frameStillTrusted: L.hullDimsOf({ layout: {} }, 4, 6),
      // Below the floor is unusable rather than out of range: it falls through to the frame.
      belowFloor: L.hullDimsOf({ layout: { hullW: 0, hullH: -5 } }, 4, 4),
      frameFromRuin: L.frameSquareFor(L.hullDimsOf({ layout: { hullW: 2, hullH: null } }, 10000, 10000)),
      frameFromRecorded: L.frameSquareFor({ w: 2, h: 10000 }),
      // The cell enumeration itself: the count a grid would be asked to draw.
      cellsAtTenThousand: L.layoutFor(2, 10000, "s", "").cells.length,
      seatsAtTenThousand: L.layoutFor(2, 10000, "s", "").seats.length,
      artScaleFinite: Number.isFinite(L.hullArtScale({ w: 2, h: 10000 })),
    };
  }).catch((e) => ({ importError: String(e?.message || e).slice(0, 200) }));

  ok("§1 the ceiling is one exported number", pure.cap === 20, pure.cap ?? pure.importError);
  ok("§1 a dimension above the ceiling clamps to it", pure.clampBig === 20, pure.clampBig);
  ok("§1 a dimension below the floor clamps to 1", pure.clampSmall === 1, pure.clampSmall);
  ok("§1 an unreadable dimension answers the caller's fallback", pure.clampUnreadable === 3, pure.clampUnreadable);
  ok("§1 THE FIELD SHAPE returns the default car, not the ruined frame",
    pure.fieldShape?.w === 2 && pure.fieldShape?.h === 4, pure.fieldShape);
  ok("§1 a recorded dimension above the ceiling is clamped, not discarded",
    pure.recordedTooBig?.w === 2 && pure.recordedTooBig?.h === 20, pure.recordedTooBig);
  ok("§1 a credible token frame is still trusted as the fallback",
    pure.frameStillTrusted?.w === 4 && pure.frameStillTrusted?.h === 6, pure.frameStillTrusted);
  ok("§1 a dimension below the floor still falls through to the frame",
    pure.belowFloor?.w === 4 && pure.belowFloor?.h === 4, pure.belowFloor);
  ok("§1 the token frame a ruined vehicle would be given is bounded", pure.frameFromRuin === 4, pure.frameFromRuin);
  ok("§1 the token frame a recorded oversize hull would be given is the ceiling", pure.frameFromRecorded === 20, pure.frameFromRecorded);
  ok("§1 the cell enumeration is bounded (2 × 10000 asks for 40 cells, not 20,000)",
    pure.cellsAtTenThousand === 40, pure.cellsAtTenThousand);
  ok("§1 the seat order is bounded with it", pure.seatsAtTenThousand === 38, pure.seatsAtTenThousand);
  ok("§1 the art scale stays a finite number", pure.artScaleFinite === true, pure.artScaleFinite);

  /* ------------------------------------------------ §2 the model clamps a write, not throws */

  const model = await page.evaluate(async () => {
    const a = window.__V.model;
    const out = {};
    try {
      await a.update({ "system.layout.hullW": 10000, "system.layout.hullH": 10000 });
      out.threw = false;
    } catch (e) { out.threw = String(e?.message || e).slice(0, 120); }
    await new Promise(r => setTimeout(r, 500));
    out.storedW = foundry.utils.getProperty(a._source, "system.layout.hullW");
    out.storedH = foundry.utils.getProperty(a._source, "system.layout.hullH");
    out.preparedW = a.system.layout.hullW;
    out.protoW = a.prototypeToken.width;
    try { await a.update({ "system.layout.hullW": 0 }); } catch (e) { out.floorThrew = String(e?.message || e).slice(0, 120); }
    await new Promise(r => setTimeout(r, 400));
    out.storedFloor = foundry.utils.getProperty(a._source, "system.layout.hullW");
    try { await a.update({ "system.layout.hullW": 3 }); } catch (e) { out.legalThrew = String(e?.message || e).slice(0, 120); }
    await new Promise(r => setTimeout(r, 400));
    out.storedLegal = foundry.utils.getProperty(a._source, "system.layout.hullW");
    return out;
  });
  ok("§2 an out-of-range model write is not an error", model.threw === false, model.threw);
  ok("§2 it lands CLAMPED in stored data", model.storedW === 20 && model.storedH === 20, model);
  ok("§2 and reads back clamped", model.preparedW === 20, model.preparedW);
  ok("§2 the frame the hull write squared is bounded too", model.protoW === 20, model.protoW);
  ok("§2 a write below the floor clamps up to 1", model.storedFloor === 1, model.storedFloor);
  ok("§2 CONTROL: an in-range write is untouched", model.storedLegal === 3, model.storedLegal);

  /* ------------------------------- §3 the poisoned vehicle's sheet OPENS, bounded */

  const opened = await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const a = window.__V.poison;
    const t0 = performance.now();
    await a.sheet.render(true);
    await sleep(1600);
    const root = a.sheet.element;
    const rows = root.querySelectorAll(".cp-veh-cellrow").length;
    const cells = root.querySelectorAll(".cp-veh-cell").length;
    const wBox = root.querySelector('input[name="system.layout.hullW"]');
    const hBox = root.querySelector('input[name="system.layout.hullH"]');
    return {
      ms: Math.round(performance.now() - t0),
      rows, cells,
      wShown: wBox?.value, hShown: hBox?.value,
      wMax: wBox?.getAttribute("max"), hMax: hBox?.getAttribute("max"),
      // Nothing was written to get here.
      sourceH: foundry.utils.getProperty(a._source, "system.layout.hullH"),
      sourceProtoW: a.prototypeToken.width,
      appId: root.id,
    };
  });
  ok("§3 the poisoned vehicle's sheet renders a BOUNDED grid, by value (2 × 4 = 8 cells)",
    opened.rows === 4 && opened.cells === 8, { rows: opened.rows, cells: opened.cells });
  ok("§3 the Footprint boxes show the bounded figures the sheet is using",
    opened.wShown === "2" && opened.hShown === "4", opened);
  ok("§3 both Footprint boxes declare the ceiling", opened.wMax === "20" && opened.hMax === "20", opened);
  ok("§3 nothing was repaired to achieve it — the poison is still in stored data",
    opened.sourceH === null && opened.sourceProtoW === OVERSIZE, opened);

  /* -------------------------------- §4 the poisoned vehicle draws a bounded token */

  const drawn = await page.evaluate(async ([OVERSIZE]) => {
    const C = await import("/modules/cp2020-augmented/module/vehicle/vehicle-canvas.js");
    const L = await import("/modules/cp2020-augmented/module/vehicle/vehicle-layout.js");
    const a = window.__V.poison;
    const scene = window.__SC;
    const res = await C.deployVehicleToScene(a, { scene, x: 200, y: 200 });
    await new Promise(r => setTimeout(r, 600));
    const doc = scene.tokens.get(res.tokenId);
    // And what the read path answers for a token that was ALREADY placed at the ruined size.
    const [wild] = await scene.createEmbeddedDocuments("Token", [{
      name: "__PW__HullGuard-WildToken", actorId: a.id, actorLink: true,
      x: 2000, y: 2000, width: OVERSIZE, height: OVERSIZE,
    }]);
    await new Promise(r => setTimeout(r, 400));
    const wildHull = L.hullDimsOf(wild.actor?.system, Number(wild.width), Number(wild.height));
    return {
      width: doc?.width, height: doc?.height,
      scaleX: doc?.texture?.scaleX,
      wildDocWidth: wild.width,
      wildHull,
      wildRect: L.hullRectIn({ x: 0, y: 0, w: wild.width * 100, h: wild.height * 100 }, wildHull, 100),
    };
  }, [OVERSIZE]);
  ok("§4 deploying a poisoned vehicle produces a BOUNDED token frame, by value",
    drawn.width === 4 && drawn.height === 4, drawn);
  ok("§4 its art scale is the hull ratio, not a runaway number", drawn.scaleX === 0.5, drawn.scaleX);
  ok("§4 a token ALREADY placed at the ruined size still reads as the bounded hull",
    drawn.wildDocWidth === 60 && drawn.wildHull?.w === 2 && drawn.wildHull?.h === 4, drawn);
  ok("§4 the rectangle drawn inside that ruined frame is the bounded hull's",
    drawn.wildRect?.w === 200 && drawn.wildRect?.h === 400, drawn.wildRect);

  /* ------------------------------------------------ sheet-gesture helpers */

  const cleanSheet = await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    await window.__V.poison.sheet.close();
    await sleep(400);
    const a = window.__V.clean;
    await a.sheet.render(true);
    await sleep(1600);
    return { appId: a.sheet.element.id, cells: a.sheet.element.querySelectorAll(".cp-veh-cell").length };
  });
  ok("§0b the everyday vehicle's grid is its own 2 × 4", cleanSheet.cells === 8, cleanSheet.cells);

  /** Type a string into a box for real and commit it with a change event. */
  const typeInto = async (sel, text) => {
    await page.evaluate(() => { window.__NOTES.length = 0; });
    const box = page.locator(`#${cleanSheet.appId} ${sel}`).first();
    await box.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    if (text) await page.keyboard.type(text, { delay: 40 });
    const typed = await page.evaluate(([sel]) => {
      const el = window.__V.clean.sheet.element.querySelector(sel);
      return { value: el.value, badInput: el.validity.badInput };
    }, [sel]);
    await page.evaluate(([sel]) => {
      window.__V.clean.sheet.element.querySelector(sel).dispatchEvent(new Event("change", { bubbles: true }));
    }, [sel]);
    await page.waitForTimeout(1600);
    return typed;
  };

  const cleanState = () => page.evaluate(([w, h]) => {
    const a = window.__V.clean;
    const root = a.sheet.element;
    return {
      storedW: foundry.utils.getProperty(a._source, "system.layout.hullW"),
      storedH: foundry.utils.getProperty(a._source, "system.layout.hullH"),
      protoW: a.prototypeToken.width,
      // The rest of the form, which the guards must not touch: two ordinary numeric boxes that
      // declare no range at all.
      crew: foundry.utils.getProperty(a._source, "system.crewSlots"),
      pax: foundry.utils.getProperty(a._source, "system.passengerSlots"),
      domW: root.querySelector(w)?.value,
      domH: root.querySelector(h)?.value,
      badH: root.querySelector(h)?.validity?.badInput,
      cells: root.querySelectorAll(".cp-veh-cell").length,
      notes: [...window.__NOTES],
    };
  }, [HULL_W, HULL_H]);

  /* ---------------------------- §5 the sheet refuses an out-of-range Footprint entry */

  let typed = await typeInto(HULL_W, String(OVERSIZE));
  ok("§5 the oversize entry really was in the box and readable",
    typed.value === String(OVERSIZE) && typed.badInput === false, typed);
  let st = await cleanState();
  ok("§5 the stored footprint SURVIVES the oversize entry", st.storedW === 2 && st.storedH === 4, st);
  ok("§5 the box is put back in range", st.domW === "2", st.domW);
  ok("§5 the grid is still the vehicle's own", st.cells === 8, st.cells);
  ok("§5 the token frame was never squared to the oversize figure", st.protoW === 4, st.protoW);
  // ⛔ THE REGRESSION THIS UNIT CAUSED AND CAUGHT ON THE RIG. A missing `min`/`max` attribute reads
  // back as `null`, and `Number(null)` is 0 — so the first cut of the range guard read every
  // unbounded box on the form as declaring the range [0, 0] and clamped the whole sheet to zero. The
  // Crew and Passengers boxes still SHOWED 2 and 3 while the document stored 0 for both, which is
  // exactly the shape of failure a presence-only leg would have missed.
  ok("§5 boxes that declare NO range are left alone by the range guard",
    st.crew === 2 && st.pax === 3, { crew: st.crew, pax: st.pax });
  ok("§5 exactly one warning was raised", st.notes.length === 1, st.notes);
  ok("§5 the warning text resolved (no raw key leaked)", st.notes[0] && !st.notes[0].includes("CYBERPUNK."), st.notes[0]);
  ok("§5 the warning names the box", st.notes[0] && /hullW|Footprint/i.test(st.notes[0]), st.notes[0]);

  /* ------------- §6 the sheet refuses the UNREADABLE entry that nulled the dimension */

  typed = await typeInto(HULL_H, "e");
  ok("§6 a lone exponent character leaves the box unreadable (badInput, empty value)",
    typed.badInput === true && typed.value === "", typed);
  st = await cleanState();
  ok("§6 the stored dimension is NOT nulled", st.storedH === 4, st.storedH);
  ok("§6 the box is repainted from the document and is readable again",
    st.domH === "4" && st.badH === false, { dom: st.domH, bad: st.badH });
  ok("§6 the footprint therefore never falls through to the token frame", st.cells === 8, st.cells);
  ok("§6 one warning was raised for it", st.notes.length === 1, st.notes);

  /* --------------------------------------- §7 CONTROL: legal footprint edits still write */

  typed = await typeInto(HULL_H, "6");
  st = await cleanState();
  ok("§7 a legal footprint edit still writes", st.storedH === 6, st.storedH);
  ok("§7 the grid follows it", st.cells === 12, st.cells);
  ok("§7 the token frame follows it", st.protoW === 6, st.protoW);
  ok("§7 a clean submit raises no warning", st.notes.length === 0, st.notes);
  typed = await typeInto(HULL_H, "4");
  st = await cleanState();
  ok("§7 and back again", st.storedH === 4 && st.cells === 8, st);

  /* --------------------------- §8 the number guard on the two item sheets */

  // The vehicle sheet's gestures are finished; close it so it cannot sit over an item sheet's box.
  await page.evaluate(async () => { await window.__V.clean.sheet.close().catch(() => {}); });
  await page.waitForTimeout(500);

  // ⚠ ONE ITEM SHEET AT A TIME. Two open V2 sheets overlap in the window stack and the upper one
  // swallows the click meant for the lower — measured here as a 30s Playwright pointer-interception
  // timeout on a box that was visible, enabled and stable the whole time.
  for (const [key, sel, path, kept] of [
    ["prog", 'input[name="system.power"]', "system.power", 5],
    ["vw", 'input[name="system.penetration"]', "system.penetration", 3],
  ]) {
    const open = await page.evaluate(async ([key, sel]) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (const k of Object.keys(window.__I)) if (k !== key) await window.__I[k].sheet.close().catch(() => {});
      await sleep(400);
      const it = window.__I[key];
      await it.sheet.render(true);
      await sleep(1500);
      window.__NOTES.length = 0;
      const root = it.sheet.element;
      return { appId: root.id, rendered: !!root.querySelector(sel) };
    }, [key, sel]);
    ok(`§8 ${key}: the item sheet renders the numeric box the leg drives`, open.rendered === true, open);

    const box = page.locator(`#${open.appId} ${sel}`).first();
    await box.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.keyboard.type("1e", { delay: 40 });
    const seen = await page.evaluate(([key, sel]) => {
      const el = window.__I[key].sheet.element.querySelector(sel);
      return { value: el.value, badInput: el.validity.badInput };
    }, [key, sel]);
    await page.evaluate(([key, sel]) => {
      window.__I[key].sheet.element.querySelector(sel).dispatchEvent(new Event("change", { bubbles: true }));
    }, [key, sel]);
    await page.waitForTimeout(1500);
    const after = await page.evaluate(([key, sel, path]) => {
      const it = window.__I[key];
      return {
        stored: foundry.utils.getProperty(it._source, path),
        dom: it.sheet.element.querySelector(sel)?.value,
        notes: [...window.__NOTES],
      };
    }, [key, sel, path]);
    ok(`§8 ${key}: the box reaches the unreadable state`, seen.badInput === true && seen.value === "", seen);
    ok(`§8 ${key}: the stored number SURVIVES`, after.stored === kept, after.stored);
    ok(`§8 ${key}: the box is repainted from the document`, after.dom === String(kept), after.dom);
    ok(`§8 ${key}: one warning was raised`, after.notes.length === 1, after.notes);

    // CONTROL on the same box: a legitimate edit still writes, and warns about nothing.
    await page.evaluate(() => { window.__NOTES.length = 0; });
    await box.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.keyboard.type("9", { delay: 40 });
    await page.evaluate(([key, sel]) => {
      window.__I[key].sheet.element.querySelector(sel).dispatchEvent(new Event("change", { bubbles: true }));
    }, [key, sel]);
    await page.waitForTimeout(1500);
    const ctrl = await page.evaluate(([key, path]) => ({
      stored: foundry.utils.getProperty(window.__I[key]._source, path),
      notes: [...window.__NOTES],
    }), [key, path]);
    ok(`§8 ${key} CONTROL: a legitimate edit still writes`, ctrl.stored === 9, ctrl.stored);
    ok(`§8 ${key} CONTROL: it raises no warning`, ctrl.notes.length === 0, ctrl.notes);
  }

  /* ------------- §9 seat coupling: which figure is capacity and which is positions */

  const seats = await page.evaluate(async () => {
    const L = await import("/modules/cp2020-augmented/module/vehicle/vehicle-layout.js");
    const O = await import("/modules/cp2020-augmented/module/vehicle/vehicle-occupancy.js");
    const S = await import("/modules/cp2020-augmented/module/vehicle/vehicle-seating.js");
    const a = window.__V.clean;                       // crewSlots 2 + passengerSlots 3
    const capAt4 = O.vehicleCapacity(a);
    await a.update({ "system.layout.hullH": 6 });
    await new Promise(r => setTimeout(r, 500));
    const capAt6 = O.vehicleCapacity(a);
    const seats6 = L.layoutFor(2, 6, "s", "").seats.length;
    await a.update({ "system.layout.hullH": 4 });
    await new Promise(r => setTimeout(r, 500));
    const seats4 = L.layoutFor(2, 4, "s", "").seats.length;
    // What happens to rider number (seats+1): the wrap, not a refusal.
    const rect = { x: 0, y: 0, w: 200, h: 400 };
    const order = L.layoutFor(2, 4, "s", "").seats;
    const first = S.seatSlotPosition(rect, 100, 0, { w: 1, h: 1 }, order, 0);
    const overflow = S.seatSlotPosition(rect, 100, order.length, { w: 1, h: 1 }, order, 0);
    return { capAt4, capAt6, seats4, seats6, first, overflow, orderLen: order.length };
  });
  ok("§9 capacity comes from the crew/passenger STAT", seats.capAt4 === 5, seats.capAt4);
  ok("§9 changing the footprint does NOT change that capacity", seats.capAt6 === 5, seats.capAt6);
  ok("§9 the number of seat CELLS does follow the footprint (2 × 4 → 6, 2 × 6 → 10)",
    seats.seats4 === 6 && seats.seats6 === 10, seats);
  ok("§9 a rider past the last seat cell WRAPS rather than being refused, nudged clear of seat 0",
    seats.overflow.x === seats.first.x + 25 && seats.overflow.y === seats.first.y + 25,
    { first: seats.first, overflow: seats.overflow, seats: seats.orderLen });

  /* ------ §10 the ruled seating model, driven on real tokens (ruling 2026-08-25) */

  /**
   * THE RULE: embark CAPACITY — the figure the overfill warning is measured against — is the
   * vehicle's STATED capacity, `system.crewSlots + system.passengerSlots` (the two boxes the sheet
   * labels Crew and Passengers; a deploy fills them from the source item's `crew` and `passengers`).
   * Painted and derived seat cells are POSITIONS ONLY and must never move that threshold. Going over
   * it WARNS and BOARDS ANYWAY — GM fiat, deliberately — and the extra riders wrap onto the hull.
   *
   * ⚠ These legs guard a contract that was previously only an accident of the code. The audit that
   * accompanied this unit enumerated every consumer of a seat order (vehicle-canvas.js reseat/board/
   * nudge, vehicle-ride.js follow/settle, vehicle-ride-lock.js) and found all of them to be position
   * consumers, with the single threshold — vehicle-boarding-hud.js `_onEmbark` — already reading the
   * capacity stat. Nothing had ever asserted that, so nothing would have caught it changing.
   */
  const ride = await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const C = await import("/modules/cp2020-augmented/module/vehicle/vehicle-canvas.js");
    const O = await import("/modules/cp2020-augmented/module/vehicle/vehicle-occupancy.js");
    const a = window.__V.clean;
    const scene = window.__SC;
    await a.update({ "system.layout.hullW": 2, "system.layout.hullH": 4 });
    await sleep(500);
    await C.deployVehicleToScene(a, { scene, x: 1000, y: 1000 });
    await sleep(600);

    const rider = await Actor.create({ name: "__PW__HullGuard-Rider", type: "character" });
    const made = [];
    for (let i = 0; i < 6; i++) {
      const [t] = await scene.createEmbeddedDocuments("Token", [{
        name: `__PW__HullGuard-R${i}`, actorId: rider.id, actorLink: false,
        x: 3000 + i * 120, y: 3000, width: 1, height: 1,
      }]);
      made.push(t);
    }
    const board = async (n) => {
      for (let i = 0; i < n; i++) { await C.boardVehicle(made[i], a, C.vehicleTokenFor(scene, a.id)); await sleep(250); }
    };

    await board(4);
    await sleep(500);
    const atFour = O.occupancyOf(a, scene);
    const seatsAt4 = C.seatOrderFor(a, C.vehicleTokenFor(scene, a.id)).length;
    const posAt4 = made.slice(0, 4).map(t => ({ x: t.x, y: t.y }));

    // The user's original complaint, as a measurement: shrink the footprint until it has ONE seat
    // cell and read the threshold again.
    await a.update({ "system.layout.hullW": 1, "system.layout.hullH": 2 });
    await sleep(1200);
    const afterShrink = O.occupancyOf(a, scene);
    const seatsAfterShrink = C.seatOrderFor(a, C.vehicleTokenFor(scene, a.id)).length;
    const posAfterShrink = made.slice(0, 4).map(t => ({ x: t.x, y: t.y }));

    await a.update({ "system.layout.hullW": 2, "system.layout.hullH": 4 });
    await sleep(1200);

    // Past the stated capacity: two more aboard, for six against a stated five.
    await board(6);
    await sleep(600);
    const atSix = O.occupancyOf(a, scene);
    const sixthAboard = made[5].flags?.["cp2020-augmented"]?.boardedVehicle === a.id;
    const sixthSeat = Number(made[5].flags?.["cp2020-augmented"]?.seatIndex);

    // Raise the STAT and the same six riders in the same footprint are within capacity again.
    await a.update({ "system.passengerSlots": 10 });
    await sleep(500);
    const afterStatRaise = O.occupancyOf(a, scene);

    return {
      atFour: { count: atFour.count, capacity: atFour.capacity, over: atFour.over },
      seatsAt4, posAt4,
      afterShrink: { count: afterShrink.count, capacity: afterShrink.capacity, over: afterShrink.over },
      seatsAfterShrink, posAfterShrink,
      atSix: { count: atSix.count, capacity: atSix.capacity, over: atSix.over },
      sixthAboard, sixthSeat,
      afterStatRaise: { count: afterStatRaise.count, capacity: afterStatRaise.capacity, over: afterStatRaise.over },
    };
  });

  ok("§10 four aboard a stated-five vehicle is within capacity",
    ride.atFour.count === 4 && ride.atFour.capacity === 5 && ride.atFour.over === false, ride.atFour);
  ok("§10 that footprint offers six seat CELLS", ride.seatsAt4 === 6, ride.seatsAt4);
  ok("§10 ⭐ shrinking the footprint to ONE seat cell does not move the threshold",
    ride.seatsAfterShrink === 1 && ride.afterShrink.capacity === 5 && ride.afterShrink.over === false,
    { seats: ride.seatsAfterShrink, occ: ride.afterShrink });
  ok("§10 nobody was thrown off by the resize", ride.afterShrink.count === 4, ride.afterShrink.count);
  ok("§10 POSITIONS did re-derive from the new grid (every rider moved)",
    ride.posAt4.every((p, i) => p.x !== ride.posAfterShrink[i].x || p.y !== ride.posAfterShrink[i].y),
    { before: ride.posAt4, after: ride.posAfterShrink });
  ok("§10 riders past the single seat cell wrap onto it rather than stacking identically",
    new Set(ride.posAfterShrink.map(p => `${p.x},${p.y}`)).size === 4, ride.posAfterShrink);
  ok("§10 six aboard a stated-five vehicle IS over capacity", ride.atSix.count === 6 && ride.atSix.over === true, ride.atSix);
  ok("§10 and the sixth rider boarded anyway — warn, not refuse (GM fiat)",
    ride.sixthAboard === true && Number.isInteger(ride.sixthSeat), { aboard: ride.sixthAboard, seat: ride.sixthSeat });
  ok("§10 raising the STAT — not the footprint — is what clears the overfill",
    ride.afterStatRaise.capacity === 12 && ride.afterStatRaise.over === false, ride.afterStatRaise);

  /* ---------- §10b the same two refusals on the CHARACTER sheet (rider 2026-08-26) */

  /**
   * THE RIDER. The vehicle and item sheets refuse BOTH ways a numeric box can be wrong; the
   * character sheet refused only the unreadable one, so the two halves of the same guard were wired
   * to different sheets for no reason a user could see. Nothing was reported broken — this is a
   * consistency rider that came out of the stat-card report (a REF card reading base 10, an empty
   * modifier box and a total of 12), which turned out not to be a defect at all: stock 1.1.1 folds
   * equipped Characteristic cyberware straight into `stat.total` while the box binds `tempMod`.
   *
   * ⚠ WHY THE RANGE LEG DECLARES ITS OWN BOUNDS. The guard reads a box's permitted range off the
   * BOX — `min`/`max` in the template — which is the whole point: what a field allows is written
   * where the field is. No box on the character sheet declares bounds today, so the range half is a
   * no-op on it AS SHIPPED, and a leg that only typed a big number into a stat would pass whether
   * the guard were wired or not. Declaring the range on the live element is therefore not a
   * contrivance, it is the only way to ask the question this leg exists to ask: IS the range guard
   * running on this sheet? The negative leg beside it — an undeclared box, untouched — is the one
   * that would catch the `Number(null) === 0` trap that clamped a whole sheet to zero on the vehicle.
   */
  const REF_BASE = 'input[name="system.stats.ref.base"]';
  const REF_TEMP = 'input[name="system.stats.ref.tempMod"]';
  const pc = await page.evaluate(async ([REF_BASE, REF_TEMP]) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (const v of Object.values(window.__V)) await v.sheet.close().catch(() => {});
    for (const i of Object.values(window.__I)) await i.sheet.close().catch(() => {});
    await sleep(400);
    const a = await Actor.create({ name: "__PW__HullGuard-PC", type: "character" });
    await a.update({ "system.stats.ref.base": 8, "system.stats.ref.tempMod": 2 });
    window.__PC = a;
    await a.sheet.render(true);
    await sleep(1600);
    const root = a.sheet.element;
    window.__NOTES.length = 0;
    return { appId: root.id, hasBase: !!root.querySelector(REF_BASE), hasTemp: !!root.querySelector(REF_TEMP) };
  }, [REF_BASE, REF_TEMP]);
  ok("§10b the character sheet renders the numeric boxes these legs drive", pc.hasBase && pc.hasTemp, pc);

  /** Type into one of the PC sheet's boxes and let the submit path run. */
  const typePC = async (sel, text) => {
    const box = page.locator(`#${pc.appId} ${sel}`).first();
    await box.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    if (text) await page.keyboard.type(text, { delay: 40 });
    const typed = await page.evaluate(([sel]) => {
      const el = window.__PC.sheet.element.querySelector(sel);
      return { value: el.value, badInput: el.validity.badInput };
    }, [sel]);
    await page.evaluate(([sel]) => {
      window.__PC.sheet.element.querySelector(sel).dispatchEvent(new Event("change", { bubbles: true }));
    }, [sel]);
    await page.waitForTimeout(1600);
    return typed;
  };
  const pcState = () => page.evaluate(([REF_BASE, REF_TEMP]) => {
    const a = window.__PC, root = a.sheet.element;
    return {
      base: foundry.utils.getProperty(a._source, "system.stats.ref.base"),
      temp: foundry.utils.getProperty(a._source, "system.stats.ref.tempMod"),
      domBase: root.querySelector(REF_BASE)?.value,
      domTemp: root.querySelector(REF_TEMP)?.value,
      badBase: root.querySelector(REF_BASE)?.validity?.badInput,
      notes: [...window.__NOTES],
    };
  }, [REF_BASE, REF_TEMP]);

  // (i) the UNREADABLE half — already shipped on this sheet, never pinned by a keeper until now.
  let seenPC = await typePC(REF_BASE, "1e");
  ok("§10b a lone exponent character leaves the stat box unreadable (badInput, empty value)",
    seenPC.badInput === true && seenPC.value === "", seenPC);
  let pcSt = await pcState();
  ok("§10b the stored stat SURVIVES the unreadable entry", pcSt.base === 8, pcSt.base);
  ok("§10b the box is repainted from the document and is readable again",
    pcSt.domBase === "8" && pcSt.badBase === false, { dom: pcSt.domBase, bad: pcSt.badBase });
  ok("§10b the neighbouring modifier box is untouched by that refusal", pcSt.temp === 2, pcSt.temp);
  ok("§10b one warning was raised, and its text resolved (no raw key)",
    pcSt.notes.length === 1 && !pcSt.notes[0]?.includes("CYBERPUNK."), pcSt.notes);

  // (ii) the RANGE half — the rider. Declare a range on the live box, then enter outside it.
  await page.evaluate(([REF_BASE]) => {
    window.__NOTES.length = 0;
    const el = window.__PC.sheet.element.querySelector(REF_BASE);
    el.setAttribute("min", "1"); el.setAttribute("max", "10");
  }, [REF_BASE]);
  seenPC = await typePC(REF_BASE, "40");
  ok("§10b the out-of-range entry really was in the box and readable",
    seenPC.value === "40" && seenPC.badInput === false, seenPC);
  pcSt = await pcState();
  // ⚠ THE KEPT FIGURE IS THE STORED ONE, CLAMPED — not the ceiling, and not the entry. With 8 stored
  // and a range of [1, 10] the answer is 8, so THIS is the discriminator: without the guard the 40
  // would simply have been written. (Measured red exactly that way before the rider landed.)
  ok("§10b ⭐ an entry above the box's own ceiling is refused, and the stored figure put back (the rider)",
    pcSt.base === 8 && pcSt.domBase === "8", { stored: pcSt.base, dom: pcSt.domBase });
  ok("§10b the neighbouring box, which declares NO range, is left alone by the range guard",
    pcSt.temp === 2, pcSt.temp);
  ok("§10b one warning was raised for it, and its text resolved",
    pcSt.notes.length === 1 && !pcSt.notes[0]?.includes("CYBERPUNK."), pcSt.notes);

  // …and when the STORED figure is itself outside the range, it is CLAMPED rather than written back
  // untouched — the half that matters on a document already carrying a poisoned number, where
  // reverting to what is stored would put the poison straight back.
  await page.evaluate(([REF_BASE]) => {
    window.__NOTES.length = 0;
    const el = window.__PC.sheet.element.querySelector(REF_BASE);
    el.setAttribute("min", "1"); el.setAttribute("max", "5");
  }, [REF_BASE]);
  await typePC(REF_BASE, "40");
  pcSt = await pcState();
  ok("§10b ⭐ a stored figure that is ITSELF out of range is clamped to the ceiling, not written back",
    pcSt.base === 5 && pcSt.domBase === "5", { stored: pcSt.base, dom: pcSt.domBase });

  // (iii) CONTROL: with a declared range still on the box, an in-range edit writes untouched.
  await page.evaluate(([REF_BASE]) => {
    const el = window.__PC.sheet.element.querySelector(REF_BASE);
    el.setAttribute("min", "1"); el.setAttribute("max", "10");
  }, [REF_BASE]);
  await page.evaluate(() => { window.__NOTES.length = 0; });
  await typePC(REF_BASE, "7");
  pcSt = await pcState();
  ok("§10b CONTROL: an in-range edit still writes", pcSt.base === 7, pcSt.base);
  ok("§10b CONTROL: it raises no warning", pcSt.notes.length === 0, pcSt.notes);

  /* ------------------------------------------------------------------ §11 noise */

  const relevant = pageErrors.filter(t => !/favicon|Failed to load resource/i.test(t));
  ok("§11 0 console errors", relevant.length === 0, relevant.slice(0, 4));

  await page.evaluate(async () => {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__HullGuard"))) await a.delete().catch(() => {});
    for (const i of game.items.filter(i => i.name?.startsWith("__PW__HullGuard"))) await i.delete().catch(() => {});
    for (const s of game.scenes.filter(s => s.name?.startsWith("__PW__HullGuard"))) await s.delete().catch(() => {});
  }).catch(() => {});
} finally {
  await browser.close();
}

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed++;
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : `  -> got ${JSON.stringify(c.got)}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
