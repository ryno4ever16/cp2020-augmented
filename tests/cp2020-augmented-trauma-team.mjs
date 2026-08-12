/**
 * KEEPER: the medical-extraction arrival sequence (module/fx/trauma-team.js + -tool.js).
 *
 * Covers, by value:
 *  - the entry surface: the scene-control tool is added for a referee and REFUSED otherwise, and the
 *    handler refuses a second time at the action layer
 *  - the pure geometry: the marked rectangle's own corners, the offscreen entry point, the pulse
 *    schedule, the five stepped exit points — all as numbers, and all scaling with the grid
 *  - the LIVE path: a placement draws the exact database keys under the exact stamped names, phase by
 *    phase, with the ladder compressed through the capture seam
 *  - the persistent half: the ground plate and the airframe are still there after the ladder finishes
 *  - the redraw: a canvas-ready sweep with a live placement rebuilds exactly one of each, not two
 *  - the teardown: end() leaves nothing under the prefix
 *  - the master switch off: nothing is queued at all, and the sweep takes down what was there
 *  - zero document writes: the scene's own effect flags and its embedded-document counts are unmoved
 *  - the missing-key degrade, through the rail's existing database seam
 *  - determinism: the pure ladder computed twice is the same ladder
 *  - 0 console errors
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const eq = (n, got, want) => check(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const near = (n, got, want, tol) => check(n, Math.abs(Number(got) - Number(want)) <= tol, `got ${got} want ${want} ±${tol}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
// The engine losing a race with itself while an effect is torn down mid-initialisation — already on
// record as a keeper trap (isolation-proven not ours; the shot-rail and overlay specs carry the same note).
const ENGINE_TEARDOWN_RACE = /Cannot set properties of null \(setting 'volume'\)/;
const engineRaces = [];
page.on("console", m => {
  if (m.type() !== "error" || /compatibility|deprecat|screen resolution/i.test(m.text())) return;
  errors.push(m.text());
});
page.on("pageerror", e => {
  const stack = String(e.stack ?? "").replace(/\s+/g, " ").slice(0, 300);
  if (ENGINE_TEARDOWN_RACE.test(e.message) && /_createSprite/.test(stack) && /sequencer/i.test(stack)) {
    engineRaces.push(stack.slice(0, 120)); return;
  }
  errors.push(e.message + " ||AT|| " + stack);
});

async function joinGM(p) {
  await p.goto(`${URL}/join`);
  await p.waitForSelector('select[name="userid"]');
  await p.evaluate(() => {
    const sel = document.querySelector('select[name="userid"]');
    sel.value = [...sel.options].find(o => /gamemaster/i.test(o.textContent)).value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await p.fill('input[name="password"]', PW);
  await p.click('button[name="join"]');
  await p.waitForFunction(() => window.game?.ready === true, null, { timeout: 60000 });
  await p.waitForTimeout(4000);
}

await joinGM(page);

const MOD = "/modules/cp2020-augmented/module/fx/trauma-team.js";
const TOOL = "/modules/cp2020-augmented/module/fx/trauma-team-tool.js";

/* ─────────────────── §1 the entry surface ─────────────────── */
console.log("\n§1 entry surface (scene-control tool)");
const surface = await page.evaluate(async (tool) => {
  const T = await import(tool);
  const controls = { tokens: { tools: { existing: { name: "existing", order: 0 } } } };
  const addedAsGm = T.addTraumaTeamTool(controls);
  const entry = controls.tokens.tools["cp-tt-land"] ?? null;

  // The refusal legs, driven by standing the referee flag down for exactly the call under test.
  const realIsGM = Object.getOwnPropertyDescriptor(game.user, "isGM");
  Object.defineProperty(game.user, "isGM", { value: false, configurable: true });
  const blank = { tokens: { tools: {} } };
  const addedAsPlayer = T.addTraumaTeamTool(blank);
  const playerToolKeys = Object.keys(blank.tokens.tools);
  const handlerRefused = await T.onTraumaTeamTool();
  if (realIsGM) Object.defineProperty(game.user, "isGM", realIsGM);
  else Object.defineProperty(game.user, "isGM", { value: true, configurable: true });

  return {
    addedAsGm, addedAsPlayer, playerToolKeys, handlerRefused,
    toolName: entry?.name ?? null,
    toolIsButton: entry?.button === true,
    groupUntouched: Object.keys(controls.tokens.tools).includes("existing"),
    noBespokeGroup: !Object.keys(controls).some(k => k !== "tokens"),
  };
}, TOOL);
check("the tool is added for a referee", surface.addedAsGm === true);
eq("it is named for its mechanism", surface.toolName, "cp-tt-land");
check("it is a momentary button, not a mode", surface.toolIsButton);
check("it joins the EXISTING group rather than inventing one", surface.groupUntouched && surface.noBespokeGroup);
check("NEGATIVE: refused without the referee flag", surface.addedAsPlayer === false);
eq("NEGATIVE: and nothing was written into the group", surface.playerToolKeys, []);
eq("NEGATIVE: the handler refuses at the action layer too", surface.handlerRefused, { skipped: "permission" });

/* ─────────────────── §2 the pure ladder and geometry ─────────────────── */
console.log("\n§2 pure geometry + schedule");
const pure = await page.evaluate(async (mod) => {
  const M = await import(mod);
  const G = 100;
  const centre = { x: 1000, y: 1000 };
  const rect = M.landingRect(centre, G);
  const rect2 = M.landingRect(centre, G);
  const bigGrid = M.landingRect(centre, 200);
  return {
    spec: {
      width: M.TRAUMA_TEAM.zoneWidthSquares,
      length: M.TRAUMA_TEAM.zoneLengthSquares,
      pulses: M.TRAUMA_TEAM.pulseCount,
      figures: M.TRAUMA_TEAM.figureCount,
    },
    rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    corners: rect.corners,
    rectTwice: JSON.stringify(rect) === JSON.stringify(rect2),
    bigGridW: bigGrid.w, bigGridH: bigGrid.h,
    entry: M.entryPointFor(centre, G),
    pulses: M.pulseSchedule(),
    figures: M.figureSchedule(centre, G).map(f => ({ atMs: f.atMs, x: Math.round(f.x), y: Math.round(f.y) })),
    figuresTwice: JSON.stringify(M.figureSchedule(centre, G)) === JSON.stringify(M.figureSchedule(centre, G)),
    nameFor: M.traumaFxNameFor("LID", "zone"),
    prefix: M.TRAUMA_TEAM_NAME,
    keys: M.TRAUMA_TEAM_KEYS,
    totalMs: M.landingLadderMs(),
  };
}, MOD);
eq("the marked area is the spec's own rectangle, in squares", [pure.spec.width, pure.spec.length], [4, 6]);
eq("four pulse rings and five figures, per the reference", [pure.spec.pulses, pure.spec.figures], [4, 5]);
eq("the rectangle is centred on the placement, sized in grid units", pure.rect, { x: 1000, y: 1000, w: 400, h: 600 });
eq("its four corners, in order", pure.corners, [
  { x: 800, y: 700 }, { x: 1200, y: 700 }, { x: 1200, y: 1300 }, { x: 800, y: 1300 },
]);
check("the same placement computes the same rectangle twice", pure.rectTwice);
eq("a doubled grid doubles the drawn footprint", [pure.bigGridW, pure.bigGridH], [800, 1200]);
check("the entry point sits off the near edge, on the entry heading", pure.entry.y < pure.rect.y - pure.rect.h / 2, JSON.stringify(pure.entry));
eq("the entry point keeps the placement's own axis", pure.entry.x, 1000);
eq("four rings, spaced against the ring's own 2750 ms clip", pure.pulses, [3700, 4900, 6100, 7300]);
check("five figures leave one after another, never together",
  pure.figures.length === 5 && pure.figures.every((f, i) => i === 0 || f.atMs > pure.figures[i - 1].atMs),
  JSON.stringify(pure.figures.map(f => f.atMs)));
check("and each steps to its own place", new Set(pure.figures.map(f => `${f.x},${f.y}`)).size === 5,
  JSON.stringify(pure.figures.map(f => `${f.x},${f.y}`)));
check("the same placement steps the same five twice", pure.figuresTwice);
check("the stamped name encodes the placement then the part",
  pure.nameFor === "cp2020-augmented.traumateam.LID.zone", pure.nameFor);
eq("one prefix for the whole census", pure.prefix, "cp2020-augmented.traumateam");
eq("the shipped database keys", pure.keys, {
  zone: "jb2a.zoning.outward.square.loop.bluegreen.01",
  corner: "jb2a.markers_scifi.001.loop.001.orangeyellow",
  downdraft: "jb2a.smoke.plumes_loop.01.grey",
  dust: "jb2a.smoke.puff.ring.01.white",
  pulse: "jb2a.zoning.outward.circle.once.bluegreen.01",
  figure: "jb2a.token_stage.round.blue.01",
});
check("the ladder ends after BOTH the last figure and the last ring",
  pure.totalMs >= pure.figures[4].atMs && pure.totalMs >= pure.pulses[3], String(pure.totalMs));

/* ─────────────────── §3 every key resolves on this install ─────────────────── */
console.log("\n§3 asset availability");
const avail = await page.evaluate(async (mod) => {
  const M = await import(mod);
  const FX = await import("/modules/cp2020-augmented/module/fx/effects.js");
  const out = {};
  for (const [part, key] of Object.entries(M.TRAUMA_TEAM_KEYS)) out[part] = FX.fxDbEntryExists(key);
  return out;
}, MOD);
for (const [part, ok] of Object.entries(avail)) check(`the ${part} key resolves on the installed tier`, ok === true);

/* ─────────────────── §4 the live placement ─────────────────── */
console.log("\n§4 live placement — what the engine was actually given");
const live = await page.evaluate(async (mod) => {
  const M = await import(mod);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const scene = canvas.scene;
  const docsBefore = {
    regions: scene.regions.size, tiles: scene.tiles.size, tokens: scene.tokens.size,
    drawings: scene.drawings.size, seqFlags: Object.keys(scene.flags?.sequencer ?? {}).length,
  };
  // The capture seam: run the whole ladder at a twentieth of its own clock so a keeper can watch it.
  M._setTraumaTimeScale(0.05);
  const centre = { x: canvas.dimensions.width / 2, y: canvas.dimensions.height / 2 };
  const result = await M.landTraumaTeam(centre);
  await sleep(150);
  const early = M.liveTraumaFx().map(e => String(e?.data?.name ?? ""));
  await sleep(900);                                    // past the compressed ladder's own end
  const settled = M.liveTraumaFx().map(e => String(e?.data?.name ?? ""));
  const part = (n) => settled.filter(x => x.includes(`.${n}`)).length;
  const docsAfter = {
    regions: scene.regions.size, tiles: scene.tiles.size, tokens: scene.tokens.size,
    drawings: scene.drawings.size, seqFlags: Object.keys(scene.flags?.sequencer ?? {}).length,
  };
  return {
    result, docsBefore, docsAfter,
    earlyHasZone: early.some(n => n.endsWith(".zone")),
    earlyCorners: early.filter(n => n.includes(".corner")).length,
    settledZone: part("zone"), settledCorners: part("corner"), settledAirframe: part("airframe"),
    settledNames: settled,
    active: M.traumaTeamActive(),
    allUnderPrefix: settled.every(n => n.startsWith(M.TRAUMA_TEAM_NAME + ".")),
  };
}, MOD);
eq("the placement reports the parts it queued, by name", live.result.queued, [
  "zone", "corner", "corner", "corner", "corner", "airframe", "downdraft", "dust", "dust",
  "pulse", "pulse", "pulse", "pulse", "figure", "figure", "figure", "figure", "figure",
]);
check("it reports nothing skipped", live.result.skipped === null, JSON.stringify(live.result.skipped));
check("the ground plate is up before the airframe arrives", live.earlyHasZone);
eq("all four caution marks are up with it", live.earlyCorners, 4);
eq("the plate is still there when the sequence has run", live.settledZone, 1);
eq("so are its four caution marks", live.settledCorners, 4);
eq("and the airframe is still on station — it never lands", live.settledAirframe, 1);
check("the placement reports itself live", live.active === true);
check("every drawn part is stamped under the one prefix", live.allUnderPrefix, JSON.stringify(live.settledNames));
eq("NO document was written: region count", live.docsAfter.regions, live.docsBefore.regions);
eq("NO document was written: tile count", live.docsAfter.tiles, live.docsBefore.tiles);
eq("NO document was written: token count", live.docsAfter.tokens, live.docsBefore.tokens);
eq("NO document was written: drawing count", live.docsAfter.drawings, live.docsBefore.drawings);
eq("NO document was written: the engine's own scene flags stay empty", live.docsAfter.seqFlags, 0);

/* ─────────────────── §5 the redraw (the engine-ready lesson) ─────────────────── */
console.log("\n§5 redraw of the persistent half");
const redraw = await page.evaluate(async (mod) => {
  const M = await import(mod);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const r1 = M.redrawTraumaTeam();                    // a reconciler: an already-correct scene draws nothing
  await sleep(400);
  const afterIdle = M.liveTraumaFx().map(e => String(e?.data?.name ?? ""));

  // (a) THE RE-ISSUE. A part that ends for a reason nobody asked for comes back on the engine's own
  // report. Ended by EXACT name — the engine's name filter honours a trailing wildcard only, so a
  // mid-string one silently matches nothing and this leg would pass by testing nothing.
  const airframeName = M.traumaFxNameFor(M.traumaTeamState().id, "airframe");
  await globalThis.Sequencer.EffectManager.endEffects({ name: airframeName });
  await sleep(700);
  const reissued = M.liveTraumaFx().filter(e => String(e?.data?.name).endsWith(".airframe")).length;

  // (b) THE REBUILD, driven through the REAL hooks rather than through the exported function: a canvas
  // teardown takes every sprite away, and the catch-up on the engine's own ready signal is what puts
  // the standing half back (the +0 / +12 / +677 ms ordering lesson).
  Hooks.callAll("canvasTearDown");
  await sleep(700);
  const afterTearDown = M.liveTraumaFx().length;
  const recordSurvived = M.traumaTeamActive();
  Hooks.callAll("sequencerReady");
  await sleep(900);
  const rebuilt = M.liveTraumaFx().map(e => String(e?.data?.name ?? "").split(".").slice(2).join("."));
  const r2 = M.redrawTraumaTeam();                    // and it is idempotent straight after
  await sleep(300);
  return {
    r1, r2, reissued, afterTearDown, recordSurvived,
    rebuilt: rebuilt.map(n => n.split(".").slice(1).join(".")).sort(),
    rebuiltCount: rebuilt.length,
    idleZones: afterIdle.filter(n => n.endsWith(".zone")).length,
    idleCorners: afterIdle.filter(n => n.includes(".corner")).length,
  };
}, MOD);
eq("a sweep over an already-correct scene redraws nothing", redraw.r1.added, []);
eq("and does not double the plate", redraw.idleZones, 1);
eq("nor its caution marks", redraw.idleCorners, 4);
eq("a part ended by nobody is re-issued, leaving exactly one on station", redraw.reissued, 1);
eq("a canvas teardown takes every sprite away", redraw.afterTearDown, 0);
check("but the placement record survives it", redraw.recordSurvived === true);
eq("the engine-ready catch-up rebuilds the standing half, and only it",
  redraw.rebuilt, ["airframe", "corner.0", "corner.1", "corner.2", "corner.3", "zone"]);
eq("exactly one of each — nothing doubled", redraw.rebuiltCount, 6);
eq("and a sweep straight after it adds nothing", redraw.r2.added, []);

/* ─────────────────── §6 teardown ─────────────────── */
console.log("\n§6 the departure clears everything");
const ended = await page.evaluate(async (mod) => {
  const M = await import(mod);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const r = await M.endTraumaTeam();
  await sleep(900);
  return { r, left: M.liveTraumaFx().map(e => String(e?.data?.name ?? "")), active: M.traumaTeamActive() };
}, MOD);
check("the departure reports what it took down", (ended.r.ended ?? 0) > 0, JSON.stringify(ended.r));
eq("nothing is left under the prefix", ended.left, []);
check("and nothing reports itself live", ended.active === false);

/* ─────────────────── §7 the master switch, and the missing key ─────────────────── */
console.log("\n§7 negatives — switch off, key absent");
const negatives = await page.evaluate(async (mod) => {
  const M = await import(mod);
  const FX = await import("/modules/cp2020-augmented/module/fx/effects.js");
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const SCOPE = "cp2020-augmented";
  const centre = { x: canvas.dimensions.width / 2, y: canvas.dimensions.height / 2 };
  const was = game.settings.get(SCOPE, "combatFxEnabled");
  const out = {};
  try {
    await game.settings.set(SCOPE, "combatFxEnabled", false);
    out.offResult = await M.landTraumaTeam(centre);
    await sleep(300);
    out.offLive = M.liveTraumaFx().length;
    out.offActive = M.traumaTeamActive();
  } finally {
    await game.settings.set(SCOPE, "combatFxEnabled", was);
  }
  // The key-absent degrade, through the rail's own database seam.
  try {
    FX._setDbProbe(() => false);
    out.missingResult = await M.landTraumaTeam(centre);
    await sleep(400);
    out.missingLive = M.liveTraumaFx().map(e => String(e?.data?.name ?? ""));
  } finally {
    FX._setDbProbe(null);
    await M.endTraumaTeam();
    await sleep(600);
    M._setTraumaTimeScale(null);
  }
  out.finalLive = M.liveTraumaFx().length;
  return out;
}, MOD);
eq("switch off: nothing is queued", negatives.offResult, { queued: [], skipped: "disabled" });
eq("switch off: nothing is drawn", negatives.offLive, 0);
check("switch off: nothing reports itself live", negatives.offActive === false);
check("key absent: the asset parts skip silently",
  !negatives.missingLive.some(n => /\.(zone|corner|downdraft|dust|pulse|figure)/.test(n)),
  JSON.stringify(negatives.missingLive));
eq("key absent: the engine-drawn airframe still carries the placement", negatives.missingLive.length, 1);
eq("the rig is left clean", negatives.finalLive, 0);

/* ─────────────────── §8 console ─────────────────── */
console.log("\n§8 client health");
if (engineRaces.length) console.log(`  (note: ${engineRaces.length} engine teardown race(s) swallowed — a known keeper trap, not ours)`);
eq("0 console errors", errors.slice(0, 4), []);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
