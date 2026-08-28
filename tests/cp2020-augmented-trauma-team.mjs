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

/* ── §1b the tool is actually WIRED: the real control-collection hook, fired for real ──
 * The legs above prove the gate logic on a hand-built control group. This one proves the
 * registration behind it — that `registerTraumaTeamTool` put the module on Foundry's own
 * `getSceneControlButtons` hook, so the tool reaches a real referee's toolbar. Without it a dropped
 * registration would leave every leg above green and the button gone. */
const wiring = await page.evaluate(async () => {
  const out = {};
  // The live toolbar, as the running client actually built it.
  out.liveTools = Object.keys(ui.controls?.controls?.tokens?.tools ?? {});
  out.liveHasTool = out.liveTools.includes("cp-tt-land");

  // Fire the REAL hook over a control collection shaped like the one core passes.
  const shape = () => ({ tokens: { name: "tokens", tools: { select: { name: "select", order: 0 } } } });
  const asGm = shape();
  Hooks.callAll("getSceneControlButtons", asGm);
  const landed = asGm.tokens.tools["cp-tt-land"] ?? null;
  // Read the shape INSIDE the page: a function does not survive the return trip.
  out.gmTool = landed ? { name: landed.name, title: landed.title, button: landed.button,
                          hasAction: typeof landed.onChange === "function" } : null;
  out.gmToolTitleLocalized = typeof landed?.title === "string" && !landed.title.includes("CYBERPUNK.");
  out.gmSelectSurvived = !!asGm.tokens.tools.select;

  const realIsGM = Object.getOwnPropertyDescriptor(game.user, "isGM");
  Object.defineProperty(game.user, "isGM", { value: false, configurable: true });
  const asPlayer = shape();
  try { Hooks.callAll("getSceneControlButtons", asPlayer); }
  finally {
    if (realIsGM) Object.defineProperty(game.user, "isGM", realIsGM);
    else Object.defineProperty(game.user, "isGM", { value: true, configurable: true });
  }
  out.playerToolKeys = Object.keys(asPlayer.tokens.tools);
  out.playerGotOurTool = Object.prototype.hasOwnProperty.call(asPlayer.tokens.tools, "cp-tt-land");
  out.gmFlagRestored = game.user.isGM === true;
  return out;
});
check("the module is registered on the real control-collection hook: firing it lands the tool",
  !!wiring.gmTool && wiring.gmTool.name === "cp-tt-land", JSON.stringify(wiring.gmTool?.name ?? null));
check("the landed tool is a momentary button with a localized title and an action of its own",
  wiring.gmTool?.button === true && wiring.gmToolTitleLocalized === true && wiring.gmTool?.hasAction === true,
  `button=${wiring.gmTool?.button} title="${wiring.gmTool?.title}" action=${wiring.gmTool?.hasAction}`);
check("the real hook leaves the group's existing entries alone", wiring.gmSelectSurvived === true);
check("NEGATIVE: firing the same real hook without the referee flag lands no arrival tool",
  wiring.playerGotOurTool === false, `group holds: ${wiring.playerToolKeys.join(", ")}`);
check("the referee flag was handed back", wiring.gmFlagRestored === true);
console.log(`  (live toolbar carries the tool: ${wiring.liveHasTool} — tools: ${wiring.liveTools.join(", ")})`);

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
// ⏪ LANDSCAPE since the 2026-08-27 user ruling ("it needs to be rotated 90 degrees") — the whole
// formation swapped axes and these four legs were left asserting the retired portrait figures. Corrected
// 2026-08-28 by the movement-echo unit, which observed them red (zero-red policy).
eq("the marked area is the spec's own rectangle, in squares", [pure.spec.width, pure.spec.length], [6, 4]);
eq("four pulse rings and five figures, per the reference", [pure.spec.pulses, pure.spec.figures], [4, 5]);
eq("the rectangle is centred on the placement, sized in grid units", pure.rect, { x: 1000, y: 1000, w: 600, h: 400 });
eq("its four corners, in order", pure.corners, [
  { x: 700, y: 800 }, { x: 1300, y: 800 }, { x: 1300, y: 1200 }, { x: 700, y: 1200 },
]);
check("the same placement computes the same rectangle twice", pure.rectTwice);
eq("a doubled grid doubles the drawn footprint", [pure.bigGridW, pure.bigGridH], [1200, 800]);
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

/* ─────────────────── §3b what else is connected, and why it matters here ───────────────────
 * ⛔ THIS SUITE COUNTS SPRITES, so it can only be read on a world with ONE connected client.
 *
 * The placement fans itself out: `landTraumaTeam` emits its own relay and EVERY client redraws the
 * placement locally (module/fx/trauma-team.js:819, :917-926 — "the airframe holds station because
 * each client is drawing it"). But the file builds its Sequencer sections WITHOUT `.locally()`
 * (`section()` at :429-433, `playSection()` at :436-440 — zero `.locally()` calls in the file), so
 * the engine ALSO broadcasts each section to every other client. With N clients connected, each one
 * therefore ends up holding N copies of every part: its own, plus one per peer.
 *
 * That is a MODULE defect, not a fixture problem — the rail's own standard requires the local
 * delivery (module/fx/effects.js:13, :52-58, implemented at :4021 `if (!shared) effect.locally();`,
 * and followed by status-fx.js:373-388). It is reported as a finding; nothing in tests/ can repair
 * it, and no pre-clean can hide it, because a peer's copy carries THIS run's placement id and is
 * byte-identical in name to the local one.
 *
 * So: sweep any genuinely stale sprite first (hygiene), then state the precondition out loud, so a
 * doubled census reports its own cause instead of arriving as unexplained arithmetic. */
console.log("\n§3b preconditions for a sprite census");
const conn = await page.evaluate(async () => {
  // Hygiene sweep — the module's own filter shape; the engine honours a TRAILING wildcard only.
  try { await globalThis.Sequencer.EffectManager.endEffects({ name: "cp2020-augmented.traumateam.*" }); } catch (e) { /* none up */ }
  await new Promise(r => setTimeout(r, 400));
  return {
    stillUp: (globalThis.Sequencer?.EffectManager?.getEffects({ name: "cp2020-augmented.traumateam.*" }) ?? []).length,
    activeUsers: game.users.filter(u => u.active).map(u => u.name),
  };
});
check("the canvas carries no leftover placement sprites from an earlier run",
  conn.stillUp === 0, `${conn.stillUp} still up`);
check("exactly one client is connected — a second one doubles every count below, because the placement's sections are not delivered locally (module finding: trauma-team.js:429-433 has no .locally())",
  conn.activeUsers.length === 1, `${conn.activeUsers.length} connected: ${conn.activeUsers.join(", ")}`);

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

  // (a2) ⭐ THE CREATE-WINDOW RACE (leg added 2026-08-28 after this section reported THREE airframes).
  // The reconciler decides what is missing by asking the engine what is ALIVE, and a part that has been
  // queued is invisible to that question for the length of the engine's own create (269-460 ms on this
  // rig). Two reconciling passes inside that window therefore each drew the same part. A rebuild
  // produces exactly that pairing — an ended-effect re-issue landing beside a `sequencerReady` sweep —
  // so this drives the pairing DELIBERATELY rather than waiting to be unlucky again.
  const airframeName2 = M.traumaFxNameFor(M.traumaTeamState().id, "airframe");
  await globalThis.Sequencer.EffectManager.endEffects({ name: airframeName2 });
  await sleep(60);
  const raceA = M.redrawTraumaTeam();
  const raceB = M.redrawTraumaTeam();          // squarely inside the first one's create window
  const raceC = M.redrawTraumaTeam();
  const inFlightDuring = M.inFlightTraumaFx().length;
  await sleep(1500);
  const raceAirframes = M.liveTraumaFx().filter(e => String(e?.data?.name).endsWith(".airframe")).length;

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
    raceAdded: [raceA.added, raceB.added, raceC.added], inFlightDuring, raceAirframes,
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
check("⭐ a queued part is visible to the reconciler before the engine has created it",
  redraw.inFlightDuring >= 1, `in flight: ${redraw.inFlightDuring}`);
// At most one of the three passes may draw — and it can legitimately be NONE of them, when the
// ended-effect hook's own re-issue got there first. What may never happen is two of them drawing.
check("⭐ THREE reconciling passes inside one create window draw the part at most ONCE between them",
  redraw.raceAdded.filter(a => a.length).length <= 1, JSON.stringify(redraw.raceAdded));
eq("⭐ and exactly one stands afterwards", redraw.raceAirframes, 1);
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
  //
  // ⛔⛔ POLLED TO THE ENGINE'S OWN ANSWER, NOT SLEPT AT FOR A FIXED 400 ms (repaired 2026-08-26 after
  // it was routed here as a product defect and A/B-proved not to be one). What this section asserts is
  // "with every database key absent, the one SHAPE-drawn part still carries the placement" — a
  // statement about WHAT is drawn, with no timing claim in it at all. The fixed sleep turned it into a
  // bet against the engine's creation latency, and here is why that bet is unwinnable:
  //
  //   · the suite compresses the MODULE's schedule with `_setTraumaTimeScale(0.05)`, but the ENGINE's
  //     own create pipeline is not scaled by anything — `_scaled()` reaches the module's ladder and
  //     nothing else;
  //   · that pipeline was measured at 171–181 ms idle on 2026-08-17 (SEQ_PRESTART_COMP_MS), and
  //     re-measured on this rig on 2026-08-26 at a median of **269–275 ms with excursions to 460 ms**
  //     — a headless software rasteriser, and it has drifted.
  //
  // So the airframe was being created at ~470–540 ms against a 400 ms budget: a coin flip. Measured
  // both ways with the FX lane's own uncommitted work neutralised in the serve copy — green on one run,
  // red on the identical two legs on the next — which is what proves the flakiness is the leg's and
  // not any lane's. Polling costs nothing when the element is already there and removes the whole class.
  try {
    FX._setDbProbe(() => false);
    out.missingResult = await M.landTraumaTeam(centre);
    out.missingLive = [];
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      out.missingLive = M.liveTraumaFx().map(e => String(e?.data?.name ?? ""));
      if (out.missingLive.length) break;
    }
  } finally {
    FX._setDbProbe(null);
    // ⛔ AND THE SWEEP IS POLLED TOO, for the same reason and to close the SAME defect's second half.
    // `the rig is left clean` was red only ever as a CONSEQUENCE of the leg above: an airframe created
    // after the fixed sleep had expired was also created after `endTraumaTeam` had already swept, so it
    // survived the departure and the count came back 1. With the arrival waited for, the sweep has
    // something to take; waiting for the sweep to finish is the other half of not guessing.
    await M.endTraumaTeam();
    for (let i = 0; i < 40; i++) {
      if (M.liveTraumaFx().length === 0) break;
      await sleep(100);
    }
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

/* ─────────────────── §8 the unload beats, read as document positions ───────────────────
 *
 * The optional half of the call (2026-08-28 order): a referee may name a world actor and a count, and
 * the unload beats then WRITE that many tokens where the marks are drawn. This section is the pure
 * arithmetic — the seats, the clamp, and the corner-vs-centre conversion — with no canvas in it. */
console.log("\n§8 crew plan (pure)");
const crewPure = await page.evaluate(async (mod) => {
  const M = await import(mod);
  const G = 100;
  const centre = { x: 1000, y: 1000 };
  const marks = M.figureSchedule(centre, G);
  return {
    marks,
    plan3: M.crewSpawnPlan(centre, G, 3),
    plan3Again: M.crewSpawnPlan(centre, G, 3),
    planBig: M.crewSpawnPlan(centre, G, 2, { width: 2, height: 2 }),
    clampLow: M.clampCrewCount(0),
    clampNeg: M.clampCrewCount(-4),
    clampHigh: M.clampCrewCount(99),
    clampJunk: M.clampCrewCount("abc"),
    clampExact: M.clampCrewCount(5),
    seats: M.crewSpawnPlan(centre, G, 99).length,
    scaled: M.crewSpawnPlan(centre, 200, 1)[0],
    markScaled: M.figureSchedule(centre, 200)[0],
  };
}, MOD);
eq("a crew of three takes the first three unload beats, by time",
  crewPure.plan3.map(p => p.atMs), crewPure.marks.slice(0, 3).map(m => m.atMs));
eq("and stands on those marks — a 1×1 figure's corner is half a square up and left of its mark",
  crewPure.plan3.map(p => [p.x, p.y]),
  crewPure.marks.slice(0, 3).map(m => [m.x - 50, m.y - 50]));
eq("a 2×2 figure straddles its mark rather than hanging off it",
  crewPure.planBig.map(p => [p.x, p.y]),
  crewPure.marks.slice(0, 2).map(m => [m.x - 100, m.y - 100]));
eq("the plan is deterministic", crewPure.plan3, crewPure.plan3Again);
eq("the conversion scales with the scene's own square",
  [crewPure.scaled.x, crewPure.scaled.y], [crewPure.markScaled.x - 100, crewPure.markScaled.y - 100]);
eq("the count clamps up to one seat", crewPure.clampLow, 1);
eq("a negative count clamps to one seat", crewPure.clampNeg, 1);
eq("and down to the marks that exist — the marks are the seats", crewPure.clampHigh, 5);
eq("a non-number clamps to one seat", crewPure.clampJunk, 1);
eq("an exact count is left alone", crewPure.clampExact, 5);
eq("so the plan can never be longer than the beats", crewPure.seats, crewPure.marks.length);

/* ─────────────────── §9 the crew, live — the one document write on this rail ─────────────────── */
console.log("\n§9 crew, live");
const crewLive = await page.evaluate(async (mod) => {
  const M = await import(mod);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const scene = canvas.scene;
  const out = {};
  let actor = null;
  const madeTokenIds = [];
  try {
    // ⭐ The prototype is deliberately LINKED: the leg below demands the crew spawns unlinked ANYWAY
    // (user-ruled 2026-08-28 — five figures sharing one linked actor are one HP pool in five hats).
    actor = await Actor.create({ name: "__PW__TT Crew", type: "character", prototypeToken: { actorLink: true } });
    M._setTraumaTimeScale(0.05);
    const centre = { x: canvas.dimensions.width / 2, y: canvas.dimensions.height / 2 };
    const gridPx = Number(canvas.dimensions.size) || 100;

    /* (a) the announcement carries NO crew — which is what makes the write the caller's alone. */
    const realEmit = game.socket.emit;
    const wire = [];
    game.socket.emit = function (...args) { wire.push(args[1]); return realEmit.apply(this, args); };
    let placed;
    try {
      placed = await M.landTraumaTeam(centre, { crew: { actorId: actor.id, count: 3 } });
    } finally { game.socket.emit = realEmit; }
    out.wireKeys = wire.map(m => Object.keys(m ?? {}).sort());
    out.wireHasCrew = wire.some(m => "crew" in (m ?? {}));
    out.placedQueued = placed.queued;
    out.placedCrew = placed.crew ?? null;

    /* (b) the write itself — polled to the engine's own answer, never slept at. */
    const before = new Set(scene.tokens.map(t => t.id));
    const wanted = M.crewSpawnPlan(centre, gridPx, 3, {
      width: actor.prototypeToken?.width ?? 1, height: actor.prototypeToken?.height ?? 1,
    });
    let fresh = [];
    for (let i = 0; i < 60; i++) {
      await sleep(150);
      fresh = scene.tokens.filter(t => !before.has(t.id) && t.actorId === actor.id);
      if (fresh.length >= 3) break;
    }
    fresh.forEach(t => madeTokenIds.push(t.id));
    out.spawned = fresh.length;
    out.spawnedAt = fresh.map(t => [t.x, t.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    out.wantedAt = wanted.map(p => [p.x, p.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    out.allFromChosenActor = fresh.every(t => t.actorId === actor.id);
    out.linkStates = fresh.map(t => t.actorLink);
    out.protoWasLinked = actor.prototypeToken?.actorLink === true;
    await M.endTraumaTeam();
    for (let i = 0; i < 40; i++) { if (M.liveTraumaFx().length === 0) break; await sleep(100); }
    out.survivedDeparture = scene.tokens.filter(t => madeTokenIds.includes(t.id)).length;

    /* (c) the default: no crew named, no document written — the pure cinematic it has always been. */
    const censusBefore = scene.tokens.size;
    await M.landTraumaTeam(centre);
    for (let i = 0; i < 20; i++) await sleep(100);
    out.censusAfterNoCrew = scene.tokens.size;
    out.censusBeforeNoCrew = censusBefore;
    await M.endTraumaTeam();
    for (let i = 0; i < 40; i++) { if (M.liveTraumaFx().length === 0) break; await sleep(100); }

    /* (d) the clamp reaches the live path too: nine asked, five seats written. */
    const before2 = new Set(scene.tokens.map(t => t.id));
    const over = await M.landTraumaTeam(centre, { crew: { actorId: actor.id, count: 9 } });
    out.overCrewCount = over.crew?.count ?? null;
    let fresh2 = [];
    for (let i = 0; i < 60; i++) {
      await sleep(150);
      fresh2 = scene.tokens.filter(t => !before2.has(t.id) && t.actorId === actor.id);
      if (fresh2.length >= 5) break;
    }
    fresh2.forEach(t => madeTokenIds.push(t.id));
    out.overSpawned = fresh2.length;
    await M.endTraumaTeam();
    for (let i = 0; i < 40; i++) { if (M.liveTraumaFx().length === 0) break; await sleep(100); }
  } catch (err) {
    out.threw = String(err?.message ?? err);
  } finally {
    // ⛔ TOKENS FIRST, THEN THE ACTOR: deleting the actor out from under its own scene tokens leaves
    // the canvas drawing placeables whose actor is gone, which is the dangling-reference class this
    // suite set already carries a repair note for.
    try { await scene.deleteEmbeddedDocuments("Token", madeTokenIds.filter(id => scene.tokens.get(id))); } catch (_e) { /* already gone */ }
    try { await actor?.delete(); } catch (_e) { /* already gone */ }
    M._setTraumaTimeScale(null);
    out.leftBehind = scene.tokens.filter(t => t.name === "__PW__TT Crew").length;
    out.actorsLeft = game.actors.filter(a => a.name === "__PW__TT Crew").length;
  }
  return out;
}, MOD);
check("the crew section ran without throwing", !crewLive.threw, String(crewLive.threw ?? ""));
eq("the placement reports the crew it will write, by value", crewLive.placedCrew?.count ?? null, 3);
eq("the announcement to other clients carries only the cinematic's own fields",
  crewLive.wireKeys, [["id", "sceneId", "type", "x", "y"]]);
check("NEGATIVE: no crew rides the wire, so no other client can write one", crewLive.wireHasCrew === false);
eq("three seats asked for, three token documents created", crewLive.spawned, 3);
eq("each stands on its own unload beat, by coordinate", crewLive.spawnedAt, crewLive.wantedAt);
check("and every one of them is the actor the referee chose", crewLive.allFromChosenActor === true);
check("⭐ crew figures spawn UNLINKED even from a LINKED prototype — mooks, each with its own pool",
  crewLive.protoWasLinked === true && Array.isArray(crewLive.linkStates)
  && crewLive.linkStates.length === 3 && crewLive.linkStates.every(v => v === false),
  `proto linked ${crewLive.protoWasLinked}, spawned ${JSON.stringify(crewLive.linkStates)}`);
eq("the airframe leaving does not take them with it", crewLive.survivedDeparture, 3);
eq("NEGATIVE: a call with no crew named writes no document at all",
  crewLive.censusAfterNoCrew, crewLive.censusBeforeNoCrew);
eq("nine asked for clamps to the five marks — reported", crewLive.overCrewCount, 5);
eq("nine asked for clamps to the five marks — written", crewLive.overSpawned, 5);
eq("the fixture tokens are gone", crewLive.leftBehind, 0);
eq("and so is the fixture actor", crewLive.actorsLeft, 0);

/* ─────────────────── §9b the crew question, driven as a real gesture ───────────────────
 *
 * ⛔ THE WIRING LEG (regression-coverage policy §1). Everything above proves the mechanism the tool
 * hands to the rail; NONE of it proves the tool reads what the template renders. The handler looks up
 * `select[name="cp-tt-actor"]` and `input[name="cp-tt-count"]` on the rendered dialog — rename either
 * in the .hbs and every leg above stays green while a referee's answer is silently dropped. So this
 * section renders the real dialog, sets both controls through real DOM events, presses the real button
 * and asserts what came back by value; then presses the other button and asserts the refusal. */
console.log("\n§9b the crew question — real dialog, real clicks");
const crewDialog = await page.evaluate(async (tool) => {
  const T = await import(tool);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  let actor = null;
  const openDialog = async () => {
    for (let i = 0; i < 40; i++) {
      const el = document.querySelector(".application.cp-tt-crew");
      if (el) return el;
      await sleep(100);
    }
    return null;
  };
  // ⛔ AND EACH ACT WAITS FOR THE PREVIOUS DIALOG TO BE GONE FIRST. Learned the expensive way: an
  // application's element outlives its own close for the length of the close animation, so a second
  // act that grabs `.cp-tt-crew` straight away gets the CORPSE of the first — and every button on it
  // is detached, so the press lands on nothing and the second promise never settles. This is the
  // suite set's own "second-act rule" with a DOM twist: the transition is the thing under test, and
  // the harness has to see the transition finish before it drives the next one.
  const waitGone = async () => {
    for (let i = 0; i < 60; i++) {
      if (!document.querySelector(".application.cp-tt-crew")) return true;
      await sleep(100);
    }
    return false;
  };
  // ⛔ EVERY WAIT ON THE DIALOG'S OWN PROMISE IS BOUNDED. A driven dialog that does not settle is not
  // a slow test, it is a HUNG one: the evaluate never returns, the harness never reports, and the run
  // has to be killed from outside (which is exactly what the first draft of this section did). A
  // bounded wait turns that whole class into an ordinary red with a name on it.
  const settled = (p, tag) => Promise.race([
    Promise.resolve(p).then(v => ({ ok: true, v })),
    sleep(8000).then(() => ({ ok: false, v: `TIMED OUT waiting for ${tag}` })),
  ]);
  const press = (el, action) => {
    const btn = el?.querySelector(`button[data-action="${action}"]`) ?? null;
    if (!btn) return false;
    btn.click();
    return true;
  };
  try {
    actor = await Actor.create({ name: "__PW__TT Dialog", type: "character" });

    /* (a) answered: the chosen actor and a hand-typed count come back as the call's crew */
    const answered = T.promptTraumaTeamCrew();
    const el = await openDialog();
    out.rendered = !!el;
    const sel = el?.querySelector('select[name="cp-tt-actor"]') ?? null;
    const cnt = el?.querySelector('input[name="cp-tt-count"]') ?? null;
    out.selectorsMatch = !!sel && !!cnt;
    out.defaultActor = sel?.value ?? null;
    out.offersChosenActor = !!sel?.querySelector(`option[value="${actor.id}"]`);
    out.countMax = cnt?.max ?? null;
    out.countDefault = cnt?.value ?? null;
    out.noRawKeys = !/CYBERPUNK\./.test(el?.textContent ?? "CYBERPUNK.");
    // Diagnostic, printed only when a press leg reds: what the footer actually offers.
    out.footer = [...(el?.querySelectorAll("button") ?? [])]
      .map(b => `${b.tagName.toLowerCase()}[type=${b.type};action=${b.dataset.action ?? ""}]`);
    if (sel) { sel.value = actor.id; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    if (cnt) { cnt.value = "2"; cnt.dispatchEvent(new Event("change", { bubbles: true })); }
    out.pressedCall = press(el, "call");
    const a = await settled(answered, "the answered call");
    out.answeredSettled = a.ok;
    out.answered = a.ok ? a.v : a.v;
    out.answeredMatchesActor = a.ok && a.v?.crew?.actorId === actor.id;

    /* (b) confirmed untouched: the default is none, which is the cinematic that shipped */
    out.firstDialogClosed = await waitGone();
    const untouched = T.promptTraumaTeamCrew();
    const el2 = await openDialog();
    press(el2, "call");
    const u = await settled(untouched, "the untouched call");
    out.untouchedSettled = u.ok;
    out.untouched = u.v;

    /* (c) refused: the second button backs the whole call out */
    out.secondDialogClosed = await waitGone();
    const refused = T.promptTraumaTeamCrew();
    const el3 = await openDialog();
    out.hasCancel = !!el3?.querySelector('button[data-action="cancel"]');
    press(el3, "cancel");
    const rf = await settled(refused, "the refusal");
    out.refusedSettled = rf.ok;
    out.refused = rf.v;
    out.thirdDialogClosed = await waitGone();
    out.leftOpen = document.querySelectorAll(".application.cp-tt-crew").length;
  } catch (err) {
    out.threw = String(err?.message ?? err);
  } finally {
    // Close anything still standing BEFORE the fixture goes: a dialog left open is what made the
    // fixture survive its own delete on the first attempt.
    for (const app of [...foundry.applications.instances.values()]) {
      if (app?.element?.classList?.contains("cp-tt-crew")) { try { await app.close(); } catch (_e) { /* gone */ } }
    }
    for (const stray of game.actors.filter(a => a.name === "__PW__TT Dialog")) {
      try { await stray.delete(); } catch (e) { out.cleanupError = String(e?.message ?? e); }
    }
    out.actorsLeft = game.actors.filter(a => a.name === "__PW__TT Dialog").length;
  }
  return out;
}, TOOL);
check("the crew dialog section ran without throwing", !crewDialog.threw, String(crewDialog.threw ?? ""));
check("the dialog renders", crewDialog.rendered === true);
check("the handler's own selectors match the rendered nodes", crewDialog.selectorsMatch === true);
eq("it opens on none — the default is the cinematic that shipped", crewDialog.defaultActor, "");
check("the world's own actors are offered", crewDialog.offersChosenActor === true);
eq("the count field is bounded by the marks", crewDialog.countMax, "5");
eq("and pre-filled with the full complement", crewDialog.countDefault, "5");
check("every visible string is localized", crewDialog.noRawKeys === true);
check("the confirm button is present and pressable", crewDialog.pressedCall === true,
  `footer: ${(crewDialog.footer ?? []).join(", ")}`);
check("pressing it settles the call", crewDialog.answeredSettled === true, String(crewDialog.answered));
eq("a chosen actor and a typed count come back as the call's crew",
  crewDialog.answered?.crew?.count ?? null, 2);
check("and it is the actor that was picked", crewDialog.answeredMatchesActor === true);
check("the untouched confirm settles too", crewDialog.untouchedSettled === true, String(crewDialog.untouched));
eq("NEGATIVE: confirming untouched asks for no crew at all", crewDialog.untouched, { crew: null });
check("the refusal button is offered", crewDialog.hasCancel === true);
check("the refusal settles too", crewDialog.refusedSettled === true, String(crewDialog.refused));
eq("NEGATIVE: refusing backs the whole call out", crewDialog.refused, null);
check("each act's dialog closes before the next is driven",
  crewDialog.firstDialogClosed === true && crewDialog.secondDialogClosed === true
  && crewDialog.thirdDialogClosed === true,
  `${crewDialog.firstDialogClosed}/${crewDialog.secondDialogClosed}/${crewDialog.thirdDialogClosed}`);
eq("no dialog is left standing", crewDialog.leftOpen, 0);
eq("the dialog fixture actor is gone", crewDialog.actorsLeft, 0);

/* ─────────────────── §10 console ─────────────────── */
console.log("\n§10 client health");
if (engineRaces.length) console.log(`  (note: ${engineRaces.length} engine teardown race(s) swallowed — a known keeper trap, not ours)`);
eq("0 console errors", errors.slice(0, 4), []);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
