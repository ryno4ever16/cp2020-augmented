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
  // §9 (f2) asks the server for a picture that does not exist, ON PURPOSE, to pin the fallback; the
  // browser logs the 404 as a resource error of its own. That one line is the leg's, not the module's.
  if (/404/.test(m.text()) && /does-not-exist\.png/.test(m.location?.()?.url ?? "")) return;
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
    // ⭐ 2026-09-19 flight look: no altitude scale, an overshooting descent, an off-centre station
    entryScale: M.TRAUMA_TEAM.entryScale,
    descentEase: M.TRAUMA_TEAM.descentEase,
    hoverIsDescentEnd: M.TRAUMA_TEAM.hoverAtMs === M.TRAUMA_TEAM.descentAtMs + M.TRAUMA_TEAM.descentMs,
    station: M.stationPoint(centre, G),
    stationBig: M.stationPoint(centre, 200),
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
eq("four rings, spaced against the ring's own 2750 ms clip (from the 09-19 hover at 4500)", pure.pulses, [4700, 5900, 7100, 8300]);
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
eq("⭐ FLIGHT LOOK (2026-09-19): the airframe is full size throughout — no shrink and grow", pure.entryScale, 1);
eq("the descent overshoots its station and settles back up", pure.descentEase, "easeOutBack");
check("the hover instant is the descent's own end", pure.hoverIsDescentEnd === true);
eq("station is up and to the right of the placement, in squares", pure.station, { x: 1040, y: 960 });
eq("and scales with the grid", pure.stationBig, { x: 1080, y: 920 });
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
  const t0 = performance.now();
  const result = await M.landTraumaTeam(centre);
  // ⏪ RE-PINNED 2026-09-19: this used to sleep a fixed 150 ms and read what was up. The engine's create
  // pipeline is scaled by nothing this suite controls (measured today: the plate lands 212–487 ms after
  // the call, the airframe 625–711 ms) — a fixed sleep against effect creation is the coin flip the
  // keeper rules forbid. The ORDER is the contract, so the order is what is watched: the first instant
  // each part is seen, polled and bounded.
  const firstSeen = {};
  for (let i = 0; i < 120; i++) {
    for (const n of M.liveTraumaFx().map(e => String(e?.data?.name ?? ""))) {
      const part = n.split(".").slice(3).join(".");
      if (!(part in firstSeen)) firstSeen[part] = Math.round(performance.now() - t0);
    }
    if ("airframe" in firstSeen && "zone" in firstSeen) break;
    await sleep(25);
  }
  const early = Object.keys(firstSeen).filter(p => firstSeen[p] <= (firstSeen.airframe ?? Infinity));
  await sleep(900);                                    // past the compressed ladder's own end
  const settled = M.liveTraumaFx().map(e => String(e?.data?.name ?? ""));
  const part = (n) => settled.filter(x => x.includes(`.${n}`)).length;
  const docsAfter = {
    regions: scene.regions.size, tiles: scene.tiles.size, tokens: scene.tokens.size,
    drawings: scene.drawings.size, seqFlags: Object.keys(scene.flags?.sequencer ?? {}).length,
  };
  return {
    result, docsBefore, docsAfter,
    firstSeen,
    earlyHasZone: "zone" in firstSeen && "airframe" in firstSeen && firstSeen.zone <= firstSeen.airframe,
    earlyCorners: early.filter(n => n.startsWith("corner")).length,
    settledZone: part("zone"), settledCorners: part("corner"), settledAirframe: part("airframe"),
    settledNames: settled,
    active: M.traumaTeamActive(),
    allUnderPrefix: settled.every(n => n.startsWith(M.TRAUMA_TEAM_NAME + ".")),
  };
}, MOD);
eq("the placement reports the parts it queued, by name — and with NO crew there are NO figure marks (2026-09-19)", live.result.queued, [
  "zone", "corner", "corner", "corner", "corner", "airframe", "downdraft", "dust", "dust",
  "pulse", "pulse", "pulse", "pulse",
]);
check("it reports nothing skipped", live.result.skipped === null, JSON.stringify(live.result.skipped));
check("the ground plate is up before the airframe arrives", live.earlyHasZone, JSON.stringify(live.firstSeen));
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
  const seats9 = M.seatSchedule(centre, G, 9);
  const bounds = { x: 0, y: 0, width: 1200, height: 1200 };
  return {
    marks, seats9,
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
    // ⭐ 2026-09-19: mixed rows — per-seat actor + footprint, in row order
    mixed: M.crewSeatPlan(centre, G, [
      { actorId: "A", size: { width: 1, height: 1 } },
      { actorId: "A", size: { width: 1, height: 1 } },
      { actorId: "B", size: { width: 2, height: 2 } },
    ], null),
    rowsFromPair: M.crewRows({ actorId: "A", count: 2 }),
    rowsFromList: M.crewRows([{ actorId: "A", count: 2 }, { actorId: "", count: 4 }, { actorId: "B", count: 0 }]),
    rowsFromNothing: M.crewRows(null),
    // ⭐ 2026-09-19: never off the map — a line marked at the bottom edge is held inside the bounds
    edge: M.crewSeatPlan({ x: 1000, y: 1150 }, G, Array.from({ length: 9 }, () => ({ actorId: "A", size: { width: 1, height: 1 } })), bounds),
    edgeFree: M.crewSeatPlan({ x: 1000, y: 1150 }, G, Array.from({ length: 9 }, () => ({ actorId: "A", size: { width: 1, height: 1 } })), null),
    clampCorner: M.clampSeatToBounds({ x: -40, y: 1180 }, { w: 100, h: 100 }, bounds),
    clampInside: M.clampSeatToBounds({ x: 300, y: 300 }, { w: 100, h: 100 }, bounds),
    clampNoBounds: M.clampSeatToBounds({ x: -40, y: 1180 }, { w: 100, h: 100 }, null),
    // ⭐ 2026-09-19: the hull — an image fitted to the long side, or the shape
    fitWide: M.fitImageSquares({ width: 400, height: 200 }),
    fitTall: M.fitImageSquares({ width: 264, height: 400 }),
    fitNone: M.fitImageSquares(null),
    hullFile: M.hullSpec({ img: "modules/x/av.png", imgSize: { width: 4.6, height: 2.3 } }),
    hullNoSize: M.hullSpec({ img: "modules/x/av.png", imgSize: null }).kind,
    hullNone: M.hullSpec({ img: "" }).kind,
    longSide: M.TRAUMA_TEAM.airframeWidthSquares,
    rowSquares: M.TRAUMA_TEAM.figureRowSquares,
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
eq("⭐ NO CEILING (2026-09-19): ninety-nine asked for is ninety-nine", crewPure.clampHigh, 99);
eq("a non-number clamps to one seat", crewPure.clampJunk, 1);
eq("an exact count is left alone", crewPure.clampExact, 5);
eq("so the plan is as long as the count", crewPure.seats, 99);
eq("the first five seats ARE the drawn marks — same instants, same places",
  crewPure.seats9.slice(0, 5), crewPure.marks);
check("⭐ WRAP (2026-09-19): seat six stands directly behind seat one, one rank further from the aircraft",
  crewPure.seats9[5].x === crewPure.seats9[0].x && crewPure.seats9[5].y === crewPure.seats9[0].y + 100 * crewPure.rowSquares,
  JSON.stringify([crewPure.seats9[0], crewPure.seats9[5]]));
check("and seats six to nine reuse the first four columns, in order, later each",
  crewPure.seats9.slice(5).every((s, i) => s.x === crewPure.seats9[i].x && s.atMs > crewPure.seats9[4 + i].atMs),
  JSON.stringify(crewPure.seats9.map(s => [s.x, s.y, s.atMs])));
check("the first rank is STRAIGHT — one y for all five", new Set(crewPure.marks.map(m => m.y)).size === 1,
  JSON.stringify(crewPure.marks.map(m => m.y)));
eq("mixed rows: each seat carries its own actor, in row order",
  crewPure.mixed.map(s => s.actorId), ["A", "A", "B"]);
eq("mixed rows: each seat is offset by ITS OWN footprint",
  crewPure.mixed.map(s => [s.x, s.y]),
  [[crewPure.marks[0].x - 50, crewPure.marks[0].y - 50], [crewPure.marks[1].x - 50, crewPure.marks[1].y - 50],
   [crewPure.marks[2].x - 100, crewPure.marks[2].y - 100]]);
eq("the old single-pair answer is one row", crewPure.rowsFromPair, [{ actorId: "A", count: 2 }]);
eq("a list keeps only rows that name an actor, counts clamped",
  crewPure.rowsFromList, [{ actorId: "A", count: 2 }, { actorId: "B", count: 1 }]);
eq("NEGATIVE: no answer is no rows", crewPure.rowsFromNothing, []);
check("⭐ NEVER OFF THE MAP: with bounds, every corner of a nine-seat line at the bottom edge stays inside",
  crewPure.edge.every(s => s.x >= 0 && s.y >= 0 && s.x + 100 <= 1200 && s.y + 100 <= 1200),
  JSON.stringify(crewPure.edge.map(s => [s.x, s.y])));
check("and without bounds the same line does run past the edge — so the clamp is what holds it",
  crewPure.edgeFree.some(s => s.y + 100 > 1200), JSON.stringify(crewPure.edgeFree.map(s => [s.x, s.y])));
eq("a corner past two edges is pulled to both", crewPure.clampCorner, { x: 0, y: 1100 });
eq("a corner inside is left alone", crewPure.clampInside, { x: 300, y: 300 });
eq("no bounds, no clamp", crewPure.clampNoBounds, { x: -40, y: 1180 });
eq("a wide picture is fitted by its width, height following", crewPure.fitWide, { width: crewPure.longSide, height: crewPure.longSide / 2 });
check("a tall picture is fitted by its HEIGHT — proportions kept, nothing stretched into the box",
  crewPure.fitTall && Math.abs(crewPure.fitTall.height - crewPure.longSide) < 1e-9
  && Math.abs(crewPure.fitTall.width - crewPure.longSide * 264 / 400) < 1e-9, JSON.stringify(crewPure.fitTall));
eq("NEGATIVE: a picture with no size fits to nothing", crewPure.fitNone, null);
eq("a record with an image and its fit draws the FILE at that size",
  crewPure.hullFile, { kind: "file", file: "modules/x/av.png", width: 4.6, height: 2.3 });
eq("NEGATIVE: an image with no measured fit draws the shape", crewPure.hullNoSize, "shape");
eq("NEGATIVE: no image draws the shape", crewPure.hullNone, "shape");

/* ─────────────────── §9 the crew, live — the one document write on this rail ─────────────────── */
console.log("\n§9 crew, live");
const crewLive = await page.evaluate(async (mod) => {
  const M = await import(mod);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const scene = canvas.scene;
  const out = {};
  let actor = null, actor2 = null;
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
    out.marksFor3 = placed.queued.filter(q => q === "figure").length;

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

    /* (d) ⭐ NO CEILING (2026-09-19): nine asked, nine written — and every one inside the scene. */
    const before2 = new Set(scene.tokens.map(t => t.id));
    const over = await M.landTraumaTeam(centre, { crew: { actorId: actor.id, count: 9 } });
    out.overCrewCount = over.crew?.count ?? null;
    out.marksFor9 = over.queued.filter(q => q === "figure").length;
    let fresh2 = [];
    for (let i = 0; i < 80; i++) {
      await sleep(150);
      fresh2 = scene.tokens.filter(t => !before2.has(t.id) && t.actorId === actor.id);
      if (fresh2.length >= 9) break;
    }
    fresh2.forEach(t => madeTokenIds.push(t.id));
    out.overSpawned = fresh2.length;
    const sr = canvas.dimensions.sceneRect;
    out.overInside = fresh2.every(t => t.x >= sr.x && t.y >= sr.y
      && t.x + t.width * gridPx <= sr.x + sr.width && t.y + t.height * gridPx <= sr.y + sr.height);
    await M.endTraumaTeam();
    for (let i = 0; i < 40; i++) { if (M.liveTraumaFx().length === 0) break; await sleep(100); }

    /* (d2) the edge case the clamp exists for: a landing area marked at the map's bottom edge. */
    const before3 = new Set(scene.tokens.map(t => t.id));
    const edgeCentre = { x: sr.x + sr.width / 2, y: sr.y + sr.height - gridPx };
    await M.landTraumaTeam(edgeCentre, { crew: { actorId: actor.id, count: 7 } });
    let fresh3 = [];
    for (let i = 0; i < 80; i++) {
      await sleep(150);
      fresh3 = scene.tokens.filter(t => !before3.has(t.id) && t.actorId === actor.id);
      if (fresh3.length >= 7) break;
    }
    fresh3.forEach(t => madeTokenIds.push(t.id));
    out.edgeSpawned = fresh3.length;
    out.edgeInside = fresh3.every(t => t.x >= sr.x && t.y >= sr.y
      && t.x + t.width * gridPx <= sr.x + sr.width && t.y + t.height * gridPx <= sr.y + sr.height);
    out.edgeWouldOverrun = M.crewSeatPlan(edgeCentre, gridPx,
      Array.from({ length: 7 }, () => ({ actorId: actor.id, size: { width: 1, height: 1 } })), null)
      .some(s => s.y + gridPx > sr.y + sr.height);
    await M.endTraumaTeam();
    for (let i = 0; i < 40; i++) { if (M.liveTraumaFx().length === 0) break; await sleep(100); }

    /* (e) ⭐ THE MIXED SQUAD (2026-09-19): two actors in one call, in row order, each its own copy. */
    actor2 = await Actor.create({ name: "__PW__TT Crew B", type: "character", prototypeToken: { width: 2, height: 2 } });
    const before4 = new Set(scene.tokens.map(t => t.id));
    const mixed = await M.landTraumaTeam(centre, { crew: [{ actorId: actor.id, count: 2 }, { actorId: actor2.id, count: 3 }] });
    out.mixedReported = mixed.crew ?? null;
    let fresh4 = [];
    for (let i = 0; i < 80; i++) {
      await sleep(150);
      fresh4 = scene.tokens.filter(t => !before4.has(t.id) && (t.actorId === actor.id || t.actorId === actor2.id));
      if (fresh4.length >= 5) break;
    }
    fresh4.forEach(t => madeTokenIds.push(t.id));
    const wantedMixed = M.crewSeatPlan(centre, gridPx, [
      { actorId: actor.id, size: { width: 1, height: 1 } }, { actorId: actor.id, size: { width: 1, height: 1 } },
      { actorId: actor2.id, size: { width: 2, height: 2 } }, { actorId: actor2.id, size: { width: 2, height: 2 } },
      { actorId: actor2.id, size: { width: 2, height: 2 } },
    ], canvas.dimensions.sceneRect);
    const byPos = (a, b) => a.x - b.x || a.y - b.y;
    out.mixedSpawned = fresh4.length;
    out.mixedA = fresh4.filter(t => t.actorId === actor.id).length;
    out.mixedB = fresh4.filter(t => t.actorId === actor2.id).length;
    out.mixedAt = fresh4.map(t => ({ actorId: t.actorId, x: t.x, y: t.y })).sort(byPos);
    out.mixedWanted = wantedMixed.map(s => ({ actorId: s.actorId, x: s.x, y: s.y })).sort(byPos);
    out.mixedSizes = fresh4.filter(t => t.actorId === actor2.id).map(t => [t.width, t.height]);
    out.mixedUnlinked = fresh4.every(t => t.actorLink === false);
    await M.endTraumaTeam();
    for (let i = 0; i < 40; i++) { if (M.liveTraumaFx().length === 0) break; await sleep(100); }

    /* (f) ⭐ THE PICTURE RIDES THE WIRE (2026-09-19): a call with an image announces it, measured. */
    const wire2 = [];
    game.socket.emit = function (...args) { wire2.push(args[1]); return realEmit.apply(this, args); };
    let pictured;
    try {
      pictured = await M.landTraumaTeam(centre, { img: "modules/cp2020-augmented/img/chip.png" });
    } finally { game.socket.emit = realEmit; }
    out.wire2Keys = wire2.map(m => Object.keys(m ?? {}).sort());
    out.wire2Fit = wire2[0]?.imgSize ?? null;
    out.wire2Img = wire2[0]?.img ?? null;
    out.picturedHull = M.hullSpec(M.traumaTeamState()).kind;
    await sleep(200);
    out.picturedQueuedAirframe = pictured.queued.includes("airframe");
    await M.endTraumaTeam();
    for (let i = 0; i < 40; i++) { if (M.liveTraumaFx().length === 0) break; await sleep(100); }
    /* (f2) NEGATIVE: an image that cannot be read draws the shape and announces no picture. */
    const wire3 = [];
    game.socket.emit = function (...args) { wire3.push(args[1]); return realEmit.apply(this, args); };
    try { await M.landTraumaTeam(centre, { img: "modules/cp2020-augmented/img/does-not-exist.png" }); }
    finally { game.socket.emit = realEmit; }
    out.wire3Keys = wire3.map(m => Object.keys(m ?? {}).sort());
    out.unreadableHull = M.hullSpec(M.traumaTeamState()).kind;
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
    try { await actor2?.delete(); } catch (_e) { /* already gone */ }
    M._setTraumaTimeScale(null);
    out.leftBehind = scene.tokens.filter(t => /^__PW__TT Crew/.test(t.name)).length;
    out.actorsLeft = game.actors.filter(a => /^__PW__TT Crew/.test(a.name)).length;
  }
  return out;
}, MOD);
check("the crew section ran without throwing", !crewLive.threw, String(crewLive.threw ?? ""));
eq("the placement reports the crew it will write, by value", crewLive.placedCrew?.count ?? null, 3);
eq("the announcement to other clients carries only the cinematic's own fields",
  crewLive.wireKeys, [["id", "sceneId", "type", "x", "y"]]);
check("NEGATIVE: no crew rides the wire, so no other client can write one", crewLive.wireHasCrew === false);
eq("⭐ the marks follow the crew: three seats, three figure marks", crewLive.marksFor3, 3);
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
eq("⭐ NO CEILING: nine asked for is nine — reported", crewLive.overCrewCount, 9);
eq("nine asked for is nine — written", crewLive.overSpawned, 9);
eq("and nine seats draw the five marks of the first rank, no more", crewLive.marksFor9, 5);
check("and every one of the nine stands inside the scene", crewLive.overInside === true);
eq("a line marked at the map's bottom edge still writes every seat", crewLive.edgeSpawned, 7);
check("⭐ NEVER OFF THE MAP: every edge-marked seat stands inside the scene", crewLive.edgeInside === true);
check("and the unclamped line WOULD have run past the edge — the clamp is what held it", crewLive.edgeWouldOverrun === true);
eq("⭐ MIXED SQUAD: two rows report as two rows, five seats", crewLive.mixedReported?.count ?? null, 5);
eq("five token documents written for the two-actor call", crewLive.mixedSpawned, 5);
eq("two of the first actor", crewLive.mixedA, 2);
eq("three of the second", crewLive.mixedB, 3);
eq("each on its own seat, in row order, offset by its own footprint", crewLive.mixedAt, crewLive.mixedWanted);
eq("the second actor's figures keep their 2×2 footprint", crewLive.mixedSizes, [[2, 2], [2, 2], [2, 2]]);
check("every figure of the mixed squad is unlinked", crewLive.mixedUnlinked === true);
eq("⭐ THE PICTURE RIDES THE WIRE: a call with an image announces the path and its measured fit",
  crewLive.wire2Keys, [["id", "img", "imgSize", "sceneId", "type", "x", "y"]]);
eq("the announced path is the one given", crewLive.wire2Img, "modules/cp2020-augmented/img/chip.png");
check("the fit is measured off the file — long side = the airframe's width, the other side follows",
  crewLive.wire2Fit && Math.abs(Math.max(crewLive.wire2Fit.width, crewLive.wire2Fit.height) - 4.6) < 1e-9
  && Math.min(crewLive.wire2Fit.width, crewLive.wire2Fit.height) > 0, JSON.stringify(crewLive.wire2Fit));
eq("and the live record draws the FILE as its hull", crewLive.picturedHull, "file");
check("the airframe part was still queued", crewLive.picturedQueuedAirframe === true);
eq("NEGATIVE: an unreadable image announces no picture — the payload is the classic one",
  crewLive.wire3Keys, [["id", "sceneId", "type", "x", "y"]]);
eq("NEGATIVE: and the hull is the shape", crewLive.unreadableHull, "shape");
eq("the fixture tokens are gone", crewLive.leftBehind, 0);
eq("and so are the fixture actors", crewLive.actorsLeft, 0);

/* ─────────────────── §9b the call window, driven as real gestures ───────────────────
 *
 * ⛔ THE WIRING LEG (regression-coverage policy §1). Everything above proves the mechanism the tool
 * hands to the rail; NONE of it proves the tool reads what the template renders. This section renders
 * the real window and drives it the way a referee does: drops an actor from the sidebar (a real
 * DragEvent carrying the platform's own drag payload), types a count, names a picture, presses the
 * real buttons — and asserts what came back by value. Reworked 2026-09-19 with the window. */
console.log("\n§9b the call window — real dialog, real gestures");
const crewDialog = await page.evaluate(async (tool) => {
  const T = await import(tool);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  let actor = null, actor2 = null;
  const openDialog = async () => {
    for (let i = 0; i < 40; i++) {
      const el = document.querySelector(".application.cp-tt-crew");
      if (el?.querySelector(".cp-tt-crew-body[data-cp-wired='1']")) return el;
      await sleep(100);
    }
    return null;
  };
  // ⛔ AND EACH ACT WAITS FOR THE PREVIOUS DIALOG TO BE GONE FIRST (the close animation outlives the
  // close; a second act that grabs `.cp-tt-crew` straight away gets the corpse of the first).
  const waitGone = async () => {
    for (let i = 0; i < 60; i++) {
      if (!document.querySelector(".application.cp-tt-crew")) return true;
      await sleep(100);
    }
    return false;
  };
  // ⛔ EVERY WAIT ON THE DIALOG'S OWN PROMISE IS BOUNDED — a hung dialog is a red with a name, not a
  // run that has to be killed from outside.
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
  // The sidebar drag, as the platform builds it: a DragEvent whose dataTransfer carries the document's
  // own drag data as text/plain JSON — exactly what Actor#toDragData puts there.
  const dropActor = (target, a) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", JSON.stringify(a.toDragData()));
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  };
  const setInput = (input, value) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); };
  const IMG = "modules/cp2020-augmented/img/chip.png";
  try {
    actor = await Actor.create({ name: "__PW__TT Dialog", type: "character" });
    actor2 = await Actor.create({ name: "__PW__TT Dialog B", type: "character" });

    /* (a) the window: fresh state, the placeholder, the toggle's tooltip on the text alone */
    const answered = T.promptTraumaTeamCrew();
    const el = await openDialog();
    out.rendered = !!el;
    const body = el?.querySelector(".cp-tt-crew-body");
    const img = body?.querySelector('img.cp-tt-av-img[data-edit="img"]') ?? null;
    const imgIn = body?.querySelector('input[name="cp-tt-img"]') ?? null;
    const toggle = body?.querySelector('input[name="cp-tt-crew-on"]') ?? null;
    const tip = body?.querySelector("label.cp-tt-crew-toggle span.cp-tt-tip") ?? null;
    const squad = body?.querySelector(".cp-tt-squad") ?? null;
    out.selectorsMatch = !!img && !!imgIn && !!toggle && !!tip && !!squad && !!body?.querySelector(".cp-tt-row-add") && !!body?.querySelector(".cp-tt-row-proto-holder.cp-hidden .cp-tt-row-proto");
    out.noClearButton = !body?.querySelector(".cp-tt-av-clear");
    out.placeholderShown = /av-lozenge\.svg$/.test(img?.getAttribute("src") ?? "");
    out.imgStartsEmpty = imgIn?.value ?? null;
    out.toggleStartsOff = toggle?.checked === false;
    out.squadStartsHidden = squad?.classList.contains("cp-hidden") === true;
    out.tipOnTextOnly = !!tip?.getAttribute("data-tooltip") && !toggle?.hasAttribute("data-tooltip")
      && !body?.querySelector("label.cp-tt-crew-toggle")?.hasAttribute("data-tooltip");
    out.rowsStartEmpty = body?.querySelectorAll(".cp-tt-rows .cp-tt-row").length ?? -1;
    out.noRawKeys = !/CYBERPUNK\./.test(el?.textContent ?? "CYBERPUNK.");
    out.footer = [...(el?.querySelectorAll("button") ?? [])]
      .map(b => `${b.tagName.toLowerCase()}[type=${b.type};action=${b.dataset.action ?? ""}]`);

    /* the drop: an actor from the sidebar becomes a row and switches the crew on; a second drop of the
       same actor is one more of it; a different actor is a second row */
    dropActor(body, actor);
    await sleep(50);
    out.toggleAfterDrop = toggle?.checked === true;
    out.squadShownAfterDrop = squad?.classList.contains("cp-hidden") === false;
    out.rowsAfterDrop = [...body.querySelectorAll(".cp-tt-rows .cp-tt-row")].map(r => [r.querySelector(".cp-tt-row-actor").value, r.querySelector(".cp-tt-row-count").value]);
    dropActor(body, actor);
    await sleep(50);
    out.rowsAfterSecondDrop = [...body.querySelectorAll(".cp-tt-rows .cp-tt-row")].map(r => [r.querySelector(".cp-tt-row-actor").value, r.querySelector(".cp-tt-row-count").value]);
    dropActor(body, actor2);
    await sleep(50);
    out.rowsAfterOtherDrop = [...body.querySelectorAll(".cp-tt-rows .cp-tt-row")].map(r => [r.querySelector(".cp-tt-row-actor").value, r.querySelector(".cp-tt-row-count").value]);
    out.seatsText = body.querySelector(".cp-tt-seats")?.textContent ?? "";
    /* a hand-typed count, well past the marks */
    setInput(body.querySelectorAll(".cp-tt-rows .cp-tt-row")[1].querySelector(".cp-tt-row-count"), "7");
    out.seatsTextAfterType = body.querySelector(".cp-tt-seats")?.textContent ?? "";
    /* the picture: the portrait opens the platform's file browser; the path lands in the hidden field */
    const appsBefore = new Set([...foundry.applications.instances.keys()]);
    img.click();
    // The V2 browser lists its directory BEFORE it registers and paints — a fixed wait here red seven
    // legs in a row on a slow listing (2026-09-19). Polled, bounded.
    let picker = null;
    for (let i = 0; i < 80 && !picker; i++) {
      picker = [...foundry.applications.instances.values()].find(a => !appsBefore.has(a.id) && /FilePicker/.test(a.constructor?.name ?? "")) ?? null;
      if (!picker) await sleep(100);
    }
    out.pickerOpened = !!picker;
    out.pickerType = picker?.options?.type ?? picker?.type ?? null;
    // ⭐ the picker sits ABOVE the window once rendered (user report: it opened behind). The V2 picker
    // fetches its listing before its first paint, so its element is polled for, not assumed.
    for (let i = 0; i < 40 && !picker?.element?.isConnected; i++) await sleep(100);
    await sleep(150);
    out.pickerZ = [Number(picker?.element?.style?.zIndex), Number(el?.style?.zIndex)];
    out.pickerAbove = out.pickerZ[0] > out.pickerZ[1];
    // and normal click order between the two: touching the window raises it, touching the picker raises it back
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); await sleep(50);
    const zAfterWindowTouch = [Number(picker?.element?.style?.zIndex), Number(el?.style?.zIndex)];
    picker?.element?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); await sleep(50);
    const zAfterPickerTouch = [Number(picker?.element?.style?.zIndex), Number(el?.style?.zIndex)];
    out.clickOrder = zAfterWindowTouch[1] > zAfterWindowTouch[0] && zAfterPickerTouch[0] > zAfterPickerTouch[1];
    out.clickOrderZ = [zAfterWindowTouch, zAfterPickerTouch];
    // ⭐ the picker is closed WITH the window, not left standing (user report)
    setInput(imgIn, IMG);
    img.src = IMG;
    out.pressedCall = press(el, "call");
    const a = await settled(answered, "the answered call");
    out.answeredSettled = a.ok;
    out.answered = a.v;
    await sleep(300);
    out.pickerClosedWithWindow = !picker?.rendered;
    // ⭐ a pick made AFTER the window has gone still applies to the next call (user report): drive the
    // picker's own callback the way its file list would, against a window that no longer exists.
    const lateFp = new (foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker)({
      type: "image", callback: picker?.options?.callback ?? picker?.callback ?? (() => {}),
    });
    out.lateCallbackExists = typeof (picker?.options?.callback ?? picker?.callback) === "function";
    try { (picker?.options?.callback ?? picker?.callback)?.("modules/cp2020-augmented/img/missile.webp"); } catch (e) { out.lateCallbackThrew = String(e?.message ?? e); }
    try { await lateFp.close?.(); } catch (_e) { /* never rendered */ }

    /* (b) the second call remembers the first; the toggle off is the cinematic alone, the picture kept */
    out.firstDialogClosed = await waitGone();
    const second = T.promptTraumaTeamCrew();
    const el2 = await openDialog();
    const body2 = el2?.querySelector(".cp-tt-crew-body");
    out.remembersRows = [...(body2?.querySelectorAll(".cp-tt-rows .cp-tt-row") ?? [])].map(r => [r.querySelector(".cp-tt-row-actor").value, r.querySelector(".cp-tt-row-count").value]);
    out.remembersImg = body2?.querySelector('input[name="cp-tt-img"]')?.value ?? null;
    out.remembersImgShown = body2?.querySelector("img.cp-tt-av-img")?.getAttribute("src") ?? null;
    // the second window shows the LATE pick, then the driven state below re-pins the chip for the rest
    setInput(body2?.querySelector('input[name="cp-tt-img"]'), IMG);
    out.remembersToggle = body2?.querySelector('input[name="cp-tt-crew-on"]')?.checked ?? null;
    const t2 = body2?.querySelector('input[name="cp-tt-crew-on"]');
    t2.checked = false; t2.dispatchEvent(new Event("change", { bubbles: true }));
    out.squadHiddenAfterUntick = body2?.querySelector(".cp-tt-squad")?.classList.contains("cp-hidden") === true;
    press(el2, "call");
    const u = await settled(second, "the toggled-off call");
    out.untouchedSettled = u.ok;
    out.untouched = u.v;

    /* (c) a removed row is gone; the refusal backs out */
    out.secondDialogClosed = await waitGone();
    const refused = T.promptTraumaTeamCrew();
    const el3 = await openDialog();
    const body3 = el3?.querySelector(".cp-tt-crew-body");
    body3?.querySelector(".cp-tt-rows .cp-tt-row .cp-tt-row-remove")?.click();
    out.rowsAfterRemove = body3?.querySelectorAll(".cp-tt-rows .cp-tt-row").length ?? -1;
    body3?.querySelector(".cp-tt-row-add")?.click();
    out.rowsAfterAdd = body3?.querySelectorAll(".cp-tt-rows .cp-tt-row").length ?? -1;
    out.hasCancel = !!el3?.querySelector('button[data-action="cancel"]');
    press(el3, "cancel");
    const rf = await settled(refused, "the refusal");
    out.refusedSettled = rf.ok;
    out.refused = rf.v;
    out.thirdDialogClosed = await waitGone();
    out.leftOpen = document.querySelectorAll(".application.cp-tt-crew").length;
    out.pickersLeft = [...foundry.applications.instances.values()].filter(a => /FilePicker/.test(a.constructor?.name ?? "")).length;
  } catch (err) {
    out.threw = String(err?.message ?? err) + " " + String(err?.stack ?? "").split("\n").slice(0, 2).join(" | ");
  } finally {
    for (const app of [...foundry.applications.instances.values()]) {
      if (app?.element?.classList?.contains("cp-tt-crew") || /FilePicker/.test(app?.constructor?.name ?? "")) { try { await app.close(); } catch (_e) { /* gone */ } }
    }
    for (const stray of game.actors.filter(a => /^__PW__TT Dialog/.test(a.name))) {
      try { await stray.delete(); } catch (e) { out.cleanupError = String(e?.message ?? e); }
    }
    out.actorsLeft = game.actors.filter(a => /^__PW__TT Dialog/.test(a.name)).length;
  }
  return out;
}, TOOL);
check("the call window section ran without throwing", !crewDialog.threw, String(crewDialog.threw ?? ""));
check("the window renders and is wired", crewDialog.rendered === true);
check("the handler's own selectors match the rendered nodes", crewDialog.selectorsMatch === true);
check("no 'use built-in shape' button (removed on the user's word 2026-09-19)", crewDialog.noClearButton === true);
check("the portrait shows the built-in shape until a picture is chosen", crewDialog.placeholderShown === true);
eq("and the image field starts empty", crewDialog.imgStartsEmpty, "");
check("the crew toggle starts OFF — the default is the cinematic alone", crewDialog.toggleStartsOff === true);
check("and the squad list starts hidden", crewDialog.squadStartsHidden === true);
check("⭐ the toggle's tooltip is on the TEXT SPAN only — not the checkbox, not the label", crewDialog.tipOnTextOnly === true);
eq("no rows before anyone is added", crewDialog.rowsStartEmpty, 0);
check("every visible string is localized", crewDialog.noRawKeys === true);
check("⭐ DROP: an actor dragged from the sidebar switches the crew on", crewDialog.toggleAfterDrop === true);
check("and shows the squad list", crewDialog.squadShownAfterDrop === true);
check("and becomes one row at count one", Array.isArray(crewDialog.rowsAfterDrop) && crewDialog.rowsAfterDrop.length === 1 && crewDialog.rowsAfterDrop[0][1] === "1", JSON.stringify(crewDialog.rowsAfterDrop));
check("dropping the same actor again is one more of it, not a second row", Array.isArray(crewDialog.rowsAfterSecondDrop) && crewDialog.rowsAfterSecondDrop.length === 1 && crewDialog.rowsAfterSecondDrop[0][1] === "2", JSON.stringify(crewDialog.rowsAfterSecondDrop));
check("dropping a different actor is a second row", Array.isArray(crewDialog.rowsAfterOtherDrop) && crewDialog.rowsAfterOtherDrop.length === 2 && crewDialog.rowsAfterOtherDrop[1][1] === "1", JSON.stringify(crewDialog.rowsAfterOtherDrop));
check("the seat readout counts the squad (3)", /\b3\b/.test(crewDialog.seatsText), crewDialog.seatsText);
check("a hand-typed count past the marks is counted, not refused (2 + 7 = 9)", /\b9\b/.test(crewDialog.seatsTextAfterType), crewDialog.seatsTextAfterType);
check("⭐ the portrait opens the platform's own file browser", crewDialog.pickerOpened === true);
eq("browsing images", crewDialog.pickerType, "image");
check("⭐ the file browser sits ABOVE the call window once rendered", crewDialog.pickerAbove === true, `z picker/window ${JSON.stringify(crewDialog.pickerZ)}`);
check("and the two keep normal click order — touch the window, it leads; touch the picker, it leads again", crewDialog.clickOrder === true, JSON.stringify(crewDialog.clickOrderZ));
check("the confirm button is present and pressable", crewDialog.pressedCall === true, `footer: ${(crewDialog.footer ?? []).join(", ")}`);
check("pressing it settles the call", crewDialog.answeredSettled === true, String(crewDialog.answered));
eq("the answer is the squad, in row order, with the counts typed", crewDialog.answered?.crew?.map(r => r.count) ?? null, [2, 7]);
eq("and the picture that was named", crewDialog.answered?.img ?? null, "modules/cp2020-augmented/img/chip.png");
check("⭐ the file browser is closed with the window", crewDialog.pickerClosedWithWindow === true);
check("a pick made after the window has gone does not throw", crewDialog.lateCallbackExists === true && !crewDialog.lateCallbackThrew, String(crewDialog.lateCallbackThrew ?? ""));
check("the second window remembers the first call's rows", JSON.stringify(crewDialog.remembersRows) === JSON.stringify(crewDialog.rowsAfterOtherDrop?.map((r, i) => [r[0], i === 1 ? "7" : r[1]])), JSON.stringify(crewDialog.remembersRows));
eq("⭐ and the LATE pick is what the next window opens with", crewDialog.remembersImg, "modules/cp2020-augmented/img/missile.webp");
eq("shown in the portrait", crewDialog.remembersImgShown, "modules/cp2020-augmented/img/missile.webp");
check("and that the crew was on", crewDialog.remembersToggle === true);
check("unticking the toggle hides the squad list", crewDialog.squadHiddenAfterUntick === true);
check("the toggled-off confirm settles", crewDialog.untouchedSettled === true, String(crewDialog.untouched));
eq("NEGATIVE: with the toggle off, no crew is asked for — the picture still is", crewDialog.untouched, { crew: null, img: "modules/cp2020-augmented/img/chip.png" });
eq("a removed row is gone", crewDialog.rowsAfterRemove, 1);
eq("the add control appends an empty row", crewDialog.rowsAfterAdd, 2);
check("the refusal button is offered", crewDialog.hasCancel === true);
check("the refusal settles too", crewDialog.refusedSettled === true, String(crewDialog.refused));
eq("NEGATIVE: refusing backs the whole call out", crewDialog.refused, null);
check("each act's dialog closes before the next is driven",
  crewDialog.firstDialogClosed === true && crewDialog.secondDialogClosed === true && crewDialog.thirdDialogClosed === true,
  `${crewDialog.firstDialogClosed}/${crewDialog.secondDialogClosed}/${crewDialog.thirdDialogClosed}`);
eq("no dialog is left standing", crewDialog.leftOpen, 0);
eq("no file browser is left standing", crewDialog.pickersLeft, 0);
eq("the dialog fixture actors are gone", crewDialog.actorsLeft, 0);

/* ─────────────────── §10 console ─────────────────── */
console.log("\n§10 client health");
if (engineRaces.length) console.log(`  (note: ${engineRaces.length} engine teardown race(s) swallowed — a known keeper trap, not ours)`);
eq("0 console errors", errors.slice(0, 4), []);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
