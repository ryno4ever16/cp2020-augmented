/**
 * KEEPER: the movement echo trail and the movement-tied scene pass (module/fx/afterimage.js).
 *
 * ⭐ REALIGNED 2026-08-28 to the SHIPPED models (ledger #23bz → #23ce). Every expected value below is
 * derived by hand from the frozen spec block's constants, never from running the code and copying what
 * it said. The three models this suite used to assert are DEAD and are pinned dead here:
 * per-copy lifetime (ghostLifetimeMs), the cap-12 plant list, and the burst-at-activation grade.
 *
 * Covers, by value:
 *  - THE COLOUR ENGINE, red-first against the chained-multiply trap: our emulator held against the
 *    LIVE PIXI filter for all thirteen wrap slots; the per-slot matrix diagonals; the measured output
 *    hue of every slot on three very different source pixels (the whole point of the duotone); and the
 *    two negatives that make the mechanism necessary — the reversed key order returns a grey
 *    silhouette, and a naive hue rotation returns a grey pixel unchanged
 *  - THE RAMP SPANS THE TRAIL: the slot walk across a 13-long and a 26-long trail, and the wrap
 *    fallback at ghostCap for a caller that has no total
 *  - THE SETTLE-THEN-UNZIP SCHEDULE: nothing fades before the settle, the fade-start ladder's values,
 *    the per-copy fade lerp, and the floor at each plant's own landing
 *  - THE PLANNER: the WHOLE path planted (no count cap), the two gates' arithmetic against Foundry's
 *    own default token speed, corners, determinism, and the plantSafetyCap rail on a pathological path
 *  - THE SOURCE DESCRIPTION: lock-rotation upright vs the document's real angle, by value
 *  - THE GRADE'S ARITHMETIC: ramp / hold / release by value at every boundary, and the release
 *    schedule gradeReleaseAtMsFor
 *  - THE LIVE PATH through the REAL mechanism: the bench figure's own Sandevistan switched on with an
 *    item update (never a parallel flag), the trail drawn, the pass started BY THE TRAIL, a chained
 *    trail that does not restart the ramp, the deactivation that releases early, and the expiry the
 *    consumable tick performs
 *  - THE PICTURE, not just the state: the LIVE filter's uniform matrix read off canvas.environment
 *    mid-hold, plus a rendered-pixel readback where the renderer affords one cheaply
 *  - THE RELEASE EASES FROM CURRENT PROGRESS: released mid-ramp it never exceeds what the ramp reached
 *  - THE CAP + EVICTION through the engine's own manager, at the shipped maxLive of 160
 *  - SOURCE NEGATIVES: gradeSustained and catchUpSceneGrade appear nowhere in the shipped file
 *  - SETTLE EXCLUSION · ZERO DOCUMENT WRITES · 0 console errors
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const MOD = "/modules/cp2020-augmented/module/fx/afterimage.js";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const eq = (n, got, want) => check(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const near = (n, got, want, tol) => check(n, Math.abs(Number(got) - Number(want)) <= tol, `got ${got} want ${want} ±${tol}`);
const note = (t) => console.log(`  note: ${t}`);

/* ── THE SHIPPED CONSTANTS, restated here so the expectations are independent of the module ──
 * (spec block, module/fx/afterimage.js — the frozen AFTERIMAGE object). A leg that read these
 * back out of the module would assert nothing. */
const SPEC = {
  ghostCap: 13, ghostCadenceMs: 200, ghostSpacingSquares: 1,
  settleDelayMs: 200, unzipStaggerMs: 20,
  ghostTeardownMinMs: 150, ghostTeardownMaxMs: 200,
  gradeRedScale: 0.58, gradeGreenScale: 1, gradeBlueScale: 0.77,
  // Ramp/release shortened from the video-measured 1600/800 by user ruling (2026-08-28): the
  // measured ramp read slow in play, and the let-go trailed the unzip by a touch.
  gradeRampMs: 1200, gradeHoldMs: 2400, gradeReleaseMs: 600,
  maxLive: 160, plantSafetyCap: 160,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
// Already on record as a keeper trap on this rail (the shot-rail and extraction specs carry the same
// note): the engine losing a race with itself while a sprite is torn down mid-initialisation.
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

/* ─────────────────── §1 the colour engine ─────────────────── */
console.log("\n§1 colour engine — the emulator against the live filter, and the two traps");
const colour = await page.evaluate(async (mod) => {
  const A = await import(mod);
  const round = (m) => Array.from(m).map(n => Number(Number(n).toFixed(5)));
  const out = { slots: [], live: [], emu: [], monotone: true, spanned: [] };

  for (let i = 0; i < A.AFTERIMAGE.ghostCap; i++) {
    const ops = A.ghostFilterOpsFor(i);
    // THE LIVE ENGINE, driven exactly as Sequencer's own wrapper drives it: super[key](value, true).
    const f = new globalThis.PIXI.ColorMatrixFilter();
    for (const [k, v] of Object.entries(ops)) f[k](v, true);
    out.live.push(round(f.uniforms.m));
    out.emu.push(round(A.ghostColorMatrixFor(i)));
    const hue = A.ghostHueFor(i);
    // Three source pixels a real token portrait could hand it: mid grey, a warm skin tone, a dark coat.
    const measured = [[0.5, 0.5, 0.5], [0.9, 0.55, 0.42], [0.12, 0.14, 0.2]]
      .map(px => A.ghostMeasuredOutput(i, px).hueDeg);
    out.slots.push({
      i, name: hue.name, targetHue: hue.hueDeg, hex: hue.hex,
      diag: [A.ghostColorMatrixFor(i)[0], A.ghostColorMatrixFor(i)[6], A.ghostColorMatrixFor(i)[12]]
        .map(n => Number(n.toFixed(4))),
      measured: measured.map(h => h === null ? null : Number(h.toFixed(2))),
      fadeMs: A.ghostTeardownMsFor(i),
    });
  }
  for (let i = 1; i < A.AFTERIMAGE_HUES.length; i++) {
    if (!(A.AFTERIMAGE_HUES[i].hueDeg > A.AFTERIMAGE_HUES[i - 1].hueDeg)) out.monotone = false;
  }

  // ⭐ THE TOTAL IS CARRIED ALL THE WAY THROUGH: the same emulator-vs-engine hold, but for slots taken
  // from a 26-long trail — so ghostFilterOpsFor's optional `total` is proved to reach the live filter.
  for (const i of [0, 7, 13, 25]) {
    const ops = A.ghostFilterOpsFor(i, 26);
    const f = new globalThis.PIXI.ColorMatrixFilter();
    for (const [k, v] of Object.entries(ops)) f[k](v, true);
    out.spanned.push({
      i, name: A.ghostHueFor(i, 26).name,
      agrees: JSON.stringify(round(f.uniforms.m)) === JSON.stringify(round(A.ghostColorMatrixFor(i, 26))),
      hue: Number(A.ghostMeasuredOutput(i, [0.5, 0.5, 0.5], 26).hueDeg?.toFixed(2) ?? NaN),
      target: A.ghostHueFor(i, 26).hueDeg,
    });
  }

  // ⛔ TRAP 1 — THE CHAINED-MULTIPLY ALIAS. PIXI's `_loadMatrix` calls `_multiply(newMatrix, m, matrix)`
  // with `newMatrix === matrix`, so the product is written over one of its own operands mid-computation.
  // Held against an HONEST (non-aliasing) multiply, computed here so the comparison is a measurement
  // and not a restatement of the module's own code.
  const honestMul = (a, b) => {
    const o = new Array(20);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 5; col++) {
        let v = 0;
        for (let k = 0; k < 4; k++) v += a[row * 5 + k] * b[k * 5 + col];
        if (col === 4) v += a[row * 5 + 4];
        o[row * 5 + col] = v;
      }
    }
    o[4] /= 255; o[9] /= 255; o[14] /= 255; o[19] /= 255;
    return o;
  };
  const IDENT = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
  const honestOf = (ops) => {
    let m = IDENT.slice();
    for (const [k, v] of Object.entries(ops)) {
      m = honestMul(m, k === "tint" ? A.tintMatrix(v) : A.greyscaleMatrix(v));
    }
    return m;
  };
  const shippedOps = A.ghostFilterOpsFor(0);
  const revOps = { greyscale: A.AFTERIMAGE.ghostGreyscale, tint: A.AFTERIMAGE_HUES[0].hex };
  const revLive = new globalThis.PIXI.ColorMatrixFilter();
  for (const [k, v] of Object.entries(revOps)) revLive[k](v, true);
  const revM = A.pixiColorMatrixOf(revOps);
  const rows = (m) => [m.slice(0, 3), m.slice(5, 8), m.slice(10, 13)].map(r => r.map(n => Number(n.toFixed(5))));
  out.alias = {
    emuMatchesLive: JSON.stringify(round(revM)) === JSON.stringify(round(revLive.uniforms.m)),
    reversedLiveRows: rows(Array.from(revLive.uniforms.m)),
    reversedHonestRows: rows(honestOf(revOps)),
    shippedAliasedEqualsHonest:
      JSON.stringify(round(A.ghostColorMatrixFor(0))) === JSON.stringify(round(honestOf(shippedOps))),
    // What the corrupted matrix actually paints: neither the asked-for hue nor a stable one.
    hueOnGrey: Number(A.hueOfRgb(A.colorMatrixApply(revM, [0.5, 0.5, 0.5]))?.toFixed(1) ?? NaN),
    hueOnWarm: Number(A.hueOfRgb(A.colorMatrixApply(revM, [0.9, 0.55, 0.42]))?.toFixed(1) ?? NaN),
    asked: A.AFTERIMAGE_HUES[0].hueDeg,
  };

  // ⛔ TRAP 2 — a hue rotation cannot colour a neutral pixel. Driven on the LIVE filter, because this
  // is a claim about the engine and not about our arithmetic.
  const hf = new globalThis.PIXI.ColorMatrixFilter();
  hf.hue(90, true); hf.saturate(1, true);
  const m = Array.from(hf.uniforms.m);
  const apply = (mm, [r, g, b]) => [
    mm[0] * r + mm[1] * g + mm[2] * b + mm[4],
    mm[5] * r + mm[6] * g + mm[7] * b + mm[9],
    mm[10] * r + mm[11] * g + mm[12] * b + mm[14]];
  const naive = apply(m, [0.5, 0.5, 0.5]);
  out.naiveHue = { rgb: naive.map(n => Number(n.toFixed(4))), hue: A.hueOfRgb(naive) };
  return out;
}, MOD);

{
  const drift = colour.live.map((m, i) => JSON.stringify(m) === JSON.stringify(colour.emu[i]) ? null : i)
    .filter(i => i !== null);
  check(`the emulator reproduces the LIVE engine's matrix for all ${SPEC.ghostCap} wrap slots`, drift.length === 0,
    drift.length ? `slots ${drift.join(",")} disagree` : `${colour.live.length}/${SPEC.ghostCap}`);
}
eq("and the wrap loop ran the shipped ghostCap, not a stale twelve", colour.slots.length, SPEC.ghostCap);
check("the six named colours walk monotonically upward in hue", colour.monotone);
for (const s of colour.slots) {
  const hues = s.measured;
  check(`slot ${String(s.i).padStart(2)} (${s.name}) — three unlike source pixels give ONE output hue`,
    hues.every(h => h !== null && Math.abs(h - s.targetHue) <= 1),
    `target ${s.targetHue}° got ${JSON.stringify(hues)}`);
}
eq("slot 0 diagonal is the lime duotone", colour.slots[0].diag, [0.1673, 0.3333, 0]);
eq("slot 12 diagonal is the magenta duotone", colour.slots[12].diag, [0.3333, 0, 0.2667]);
for (const s of colour.spanned) {
  check(`SPANNED slot ${s.i} of 26 (${s.name}) — the emulator still reproduces the live filter`,
    s.agrees && Math.abs(s.hue - s.target) <= 1, `target ${s.target}° got ${s.hue}°`);
}
check("TRAP 1: the emulator reproduces the engine's ALIAS on the wrong key order too",
  colour.alias.emuMatchesLive, JSON.stringify(colour.alias.reversedLiveRows));
check("TRAP 1: reversed, the live engine returns three DIFFERENT rows",
  JSON.stringify(colour.alias.reversedLiveRows[0]) !== JSON.stringify(colour.alias.reversedLiveRows[1])
  && JSON.stringify(colour.alias.reversedLiveRows[1]) !== JSON.stringify(colour.alias.reversedLiveRows[2]),
  JSON.stringify(colour.alias.reversedLiveRows));
check("TRAP 1: honest matrix algebra says those three rows should be IDENTICAL",
  JSON.stringify(colour.alias.reversedHonestRows[0]) === JSON.stringify(colour.alias.reversedHonestRows[1])
  && JSON.stringify(colour.alias.reversedHonestRows[1]) === JSON.stringify(colour.alias.reversedHonestRows[2]),
  JSON.stringify(colour.alias.reversedHonestRows));
check("THE SHIPPED ORDER IS ALIASING-IMMUNE: aliased and honest agree exactly",
  colour.alias.shippedAliasedEqualsHonest);
check("TRAP 1: and the corrupted matrix paints neither the asked-for hue…",
  Math.abs(colour.alias.hueOnGrey - colour.alias.asked) > 20,
  `asked ${colour.alias.asked}° got ${colour.alias.hueOnGrey}°`);
check("TRAP 1: …nor the same hue on two different source pixels",
  Math.abs(colour.alias.hueOnGrey - colour.alias.hueOnWarm) > 5,
  `grey ${colour.alias.hueOnGrey}° vs warm ${colour.alias.hueOnWarm}°`);
eq("TRAP 2: a live hue rotation leaves a neutral pixel EXACTLY where it was", colour.naiveHue.rgb, [0.5, 0.5, 0.5]);
eq("TRAP 2: and therefore has no hue to ramp", colour.naiveHue.hue, null);

/* ─────────────────── §2 the ramp SPANS the trail ─────────────────── */
console.log("\n§2 the ramp spans the trail — the slot walk by total, and the wrap fallback");
const ramp = await page.evaluate(async (mod) => {
  const A = await import(mod);
  const walk = (total) => Array.from({ length: total }, (_, i) => A.ghostHueFor(i, total).name);
  return {
    of13: walk(13),
    of26: walk(26),
    of7: walk(7),
    wrapNoTotal: Array.from({ length: 14 }, (_, i) => A.ghostHueFor(i).name),
    // the same index answers DIFFERENTLY once the caller knows the trail's length — the whole point
    idx13NoTotal: A.ghostHueFor(13).name,
    idx13Of26: A.ghostHueFor(13, 26).name,
    // a total of one or less is not a span; it falls back to the wrap
    of1: A.ghostHueFor(0, 1).name,
    clampHigh: A.ghostHueFor(99, 13).name,
    clampLow: A.ghostHueFor(-4, 13).name,
  };
}, MOD);
// ⭐ CONTINUOUS RAMP (user ruling 2026-08-28): the six stops are anchors interpolated at a constant
// rate in hue angle — the names below are each slot's NEAREST stop, and the banded two-per-colour
// walk is retired ("you can see it gradually shift from green to blue to purple").
eq("a 13-copy trail walks all six colours across its whole length", ramp.of13,
  ["lime", "lime", "lime", "teal", "teal", "cyan", "cyan", "blue", "blue", "violet", "violet", "violet", "magenta"]);
eq("a 26-copy trail stretches the SAME six colours over twice the length", ramp.of26,
  ["lime", "lime", "lime", "lime", "lime", "teal", "teal", "teal", "teal", "teal", "teal",
    "cyan", "cyan", "cyan", "blue", "blue", "blue", "blue", "blue",
    "violet", "violet", "violet", "violet", "magenta", "magenta", "magenta"]);
eq("and a 7-copy trail still starts lime and ends magenta", ramp.of7,
  ["lime", "lime", "teal", "cyan", "blue", "violet", "magenta"]);
eq("WRAP FALLBACK: with no total the slots wrap at ghostCap", ramp.wrapNoTotal,
  ["lime", "lime", "lime", "teal", "teal", "cyan", "cyan", "blue", "blue", "violet", "violet",
    "violet", "magenta", "lime"]);
eq("index 13 with no total wraps back to the ramp's head", ramp.idx13NoTotal, "lime");
eq("the SAME index over a 26-long trail is mid-ramp instead", ramp.idx13Of26, "cyan");
eq("a total of one is not a span — it falls back to the wrap", ramp.of1, "lime");
eq("an index past the trail's end clamps to its last colour", ramp.clampHigh, "magenta");
eq("and a negative index clamps to its first", ramp.clampLow, "lime");

/* ─────────────────── §3 the settle-then-unzip schedule ─────────────────── */
console.log("\n§3 the unzip schedule — nothing fades before the settle, and the ladder's values");
const unzip = await page.evaluate(async (mod) => {
  const A = await import(mod);
  const G = 100;
  const move = (pts) => ({ origin: { x: pts[0][0], y: pts[0][1], width: 1, height: 1 },
    passed: { waypoints: pts.slice(1).map(([x, y]) => ({ x, y, width: 1, height: 1 })) } });
  const pathOf = (pts) => A.pathPointsOf(move(pts), { gridPx: G, width: 1, height: 1 });

  // A 20-square drag walked in 4000 ms: both gates land on 100 px, so the plant list is exact.
  const long = pathOf([[0, 0], [2000, 0]]);
  const plants = A.ghostPlantsFor(long, { gridPx: G, durationMs: 4000 });
  const sched = A.unzipScheduleFor(plants, { durationMs: 4000 });
  // The FLOOR case: a derived duration estimate that is far too short, so plants land after their
  // own nominal fade-start and the fade must be floored at the landing.
  const floored = A.unzipScheduleFor(plants, { durationMs: 0 });

  return {
    plantCount: plants.length,
    plantAtMs: plants.map(p => p.atMs),
    fadeStart: sched.map(p => p.fadeStartMs),
    fadeMs: sched.map(p => p.fadeMs),
    dieAt: sched.map(p => p.dieAtMs),
    // the copy's whole DURATION is baked in at creation: dieAt − atMs
    durations: sched.map(p => p.dieAtMs - p.atMs),
    everyFadeAfterSettle: sched.every(p => p.fadeStartMs >= 4000 + 200),
    monotoneFadeStart: sched.every((p, i) => i === 0 || p.fadeStartMs > sched[i - 1].fadeStartMs),
    plantFieldsKept: sched.every((p, i) => p.x === plants[i].x && p.atMs === plants[i].atMs && p.index === i),
    flooredStart: floored.map(p => p.fadeStartMs),
    flooredNeverBeforeLanding: floored.every(p => p.fadeStartMs >= p.atMs),
    // the per-copy fade lerp, asked directly on both a spanned and an unspanned total
    lerp13: Array.from({ length: 13 }, (_, i) => A.ghostTeardownMsFor(i, 13)),
    lerpNoTotal: Array.from({ length: 13 }, (_, i) => A.ghostTeardownMsFor(i)),
    emptySchedule: A.unzipScheduleFor([], { durationMs: 4000 }).length,
  };
}, MOD);
eq("a 20-square drag plants 21 copies — well past the reference count of 13", unzip.plantCount, 21);
eq("their landings are the measured 200 ms cadence, end to end", unzip.plantAtMs,
  [0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600, 2800, 3000, 3200, 3400, 3600, 3800, 4000]);
check("NOTHING fades before the settle: every fade-start is at or past duration + settleDelay",
  unzip.everyFadeAfterSettle, `fadeStart[0] ${unzip.fadeStart[0]}, settle ${4000 + SPEC.settleDelayMs}`);
eq("the fade-start ladder is settle + 200 + index × 20, by value", unzip.fadeStart,
  [4200, 4220, 4240, 4260, 4280, 4300, 4320, 4340, 4360, 4380, 4400,
    4420, 4440, 4460, 4480, 4500, 4520, 4540, 4560, 4580, 4600]);
check("and it walks strictly forward — the unzip is a wave, not a blink", unzip.monotoneFadeStart);
eq("each copy's own fade is lerped 150 → 200 across the trail", unzip.fadeMs,
  [150, 153, 155, 158, 160, 163, 165, 168, 170, 173, 175, 178, 180, 183, 185, 188, 190, 193, 195, 198, 200]);
eq("the first copy dies at its fade-start plus its own fade", unzip.dieAt[0], 4350);
eq("and the last at the ladder's end plus the band's ceiling", unzip.dieAt[20], 4800);
eq("the copy's whole life is baked into one duration at creation", unzip.durations[0], 4350);
eq("…including the newest, whose life is only the settle beat plus its fade", unzip.durations[20], 800);
check("the schedule decorates the plants rather than replacing them", unzip.plantFieldsKept);
eq("FLOOR: a short duration estimate cannot start a fade before its copy has landed", unzip.flooredStart.slice(0, 6),
  [200, 220, 400, 600, 800, 1000]);
check("FLOOR: and no copy in that schedule fades before its own landing", unzip.flooredNeverBeforeLanding);
eq("the lerp spans the trail's own total", unzip.lerp13,
  [150, 154, 158, 163, 167, 171, 175, 179, 183, 188, 192, 196, 200]);
eq("and with no total it spans the reference count instead — same ladder", unzip.lerpNoTotal, unzip.lerp13);
eq("NEGATIVE: an empty plant list schedules nothing", unzip.emptySchedule, 0);

/* ─────────────────── §4 the planner ─────────────────── */
console.log("\n§4 the planner — the WHOLE path, the two gates, corners, and the safety rail");
const plan = await page.evaluate(async (mod) => {
  const A = await import(mod);
  const G = 100;
  const move = (pts) => ({ origin: { x: pts[0][0], y: pts[0][1], width: 1, height: 1 },
    passed: { waypoints: pts.slice(1).map(([x, y]) => ({ x, y, width: 1, height: 1 })) } });
  const pathOf = (pts) => A.pathPointsOf(move(pts), { gridPx: G, width: 1, height: 1 });

  // At Foundry's own default speed the CADENCE gate binds: 6 spaces/s, 200 ms = 1.2 squares.
  const straight8 = pathOf([[0, 0], [800, 0]]);
  const dur8 = A.movementDurationMs({}, straight8, G);
  const plants8 = A.ghostPlantsFor(straight8, { gridPx: G, durationMs: dur8 });

  // A SLOW mover: give the same path four times the duration, and the SPACING gate binds instead.
  const slowPlants = A.ghostPlantsFor(straight8, { gridPx: G, durationMs: dur8 * 4 });

  // A path that turns a corner. The plants must sit ON the two legs, never on the chord between ends.
  const lPath = pathOf([[0, 0], [400, 0], [400, 400]]);
  const lPlants = A.ghostPlantsFor(lPath, { gridPx: G, durationMs: A.movementDurationMs({}, lPath, G) });
  const chordOffset = lPlants.map(p => {
    const a = lPath[0], b = lPath[lPath.length - 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / Math.hypot(dx, dy);
  });
  const onLegs = lPlants.every(p =>
    (Math.abs(p.y - lPath[0].y) < 1e-6 && p.x >= lPath[0].x - 1e-6 && p.x <= lPath[1].x + 1e-6) ||
    (Math.abs(p.x - lPath[1].x) < 1e-6 && p.y >= lPath[1].y - 1e-6 && p.y <= lPath[2].y + 1e-6));

  // A 40-square drag at the engine's default speed — three times the reference count.
  const long = pathOf([[0, 0], [4000, 0]]);
  const longPlants = A.ghostPlantsFor(long, { gridPx: G, durationMs: A.movementDurationMs({}, long, G) });

  // ⛔ THE SAFETY RAIL: a pathological 1000-square drag. The list is bounded by plantSafetyCap and
  // by nothing else — the trail's LOOK is bounded by the unzip.
  const huge = pathOf([[0, 0], [100000, 0]]);
  const hugePlants = A.ghostPlantsFor(huge, { gridPx: G, durationMs: 200000 });
  const hugeExplicit = A.ghostPlantsFor(huge, { gridPx: G, durationMs: 200000, cap: 5 });

  // A path shorter than one gate.
  const tiny = pathOf([[0, 0], [40, 0]]);
  const tinyPlants = A.ghostPlantsFor(tiny, { gridPx: G, durationMs: A.movementDurationMs({}, tiny, G) });

  return {
    defaultSpeed: globalThis.CONFIG?.Token?.movement?.defaultSpeed ?? null,
    straightPoints: straight8.map(p => [p.x, p.y]),
    dur8,
    plants8: plants8.map(p => ({ x: Math.round(p.x), atMs: p.atMs, i: p.index })),
    slowCount: slowPlants.length,
    slowStepPx: slowPlants.length > 1 ? Math.round(slowPlants[1].arcPx - slowPlants[0].arcPx) : null,
    lCount: lPlants.length,
    lOnLegs: onLegs,
    lMaxChordOffset: Math.round(Math.max(...chordOffset)),
    longCount: longPlants.length,
    longLastAtMs: longPlants[longPlants.length - 1].atMs,
    longLastArcWithinPath: longPlants[longPlants.length - 1].arcPx <= 4000 + 1e-6,
    longIndexes: [longPlants[0].index, longPlants[longPlants.length - 1].index],
    hugeCount: hugePlants.length,
    hugeLastIndex: hugePlants[hugePlants.length - 1].index,
    hugeExplicitCount: hugeExplicit.length,
    shippedRail: A.AFTERIMAGE.plantSafetyCap,
    shippedMaxLive: A.AFTERIMAGE.maxLive,
    tinyCount: tinyPlants.length,
    deterministic: JSON.stringify(A.ghostPlantsFor(lPath, { gridPx: G, durationMs: 900 }))
      === JSON.stringify(A.ghostPlantsFor(lPath, { gridPx: G, durationMs: 900 })),
    dedup: pathOf([[0, 0], [0, 0], [300, 0]]).length,
    emptyPath: A.ghostPlantsFor([], { gridPx: G, durationMs: 900 }).length,
  };
}, MOD);

eq("Foundry's own default token speed, which the arithmetic is stated against", plan.defaultSpeed, 6);
eq("the path is token CENTRES, origin included", plan.straightPoints, [[50, 50], [850, 50]]);
eq("8 squares at 6 spaces/second is 1333 ms of movement", plan.dur8, 1333);
eq("at default speed the CADENCE gate binds: plants 1.2 squares apart", plan.plants8.map(p => p.x),
  [50, 170, 290, 410, 530, 650, 770]);
eq("and their offsets are the measured 200 ms cadence", plan.plants8.map(p => p.atMs),
  [0, 200, 400, 600, 800, 1000, 1200]);
eq("a mover 4× slower is bound by the SPACING gate instead — one square", plan.slowStepPx, 100);
eq("and plants more copies over the same ground", plan.slowCount, 9);
check("a path that turns a corner plants ON its legs, never on the chord", plan.lOnLegs);
check("and at least one copy is well off that chord", plan.lMaxChordOffset > 50, `${plan.lMaxChordOffset} px`);
eq("⭐ THE WHOLE PATH IS PLANTED: a 40-square drag plants 34 copies, not the reference 13",
  plan.longCount, 34);
eq("its last copy lands 33 cadences into the movement", plan.longLastAtMs, 6600);
check("and inside the path, never past its end", plan.longLastArcWithinPath);
eq("the plant indexes run 0 to 33 unbroken", plan.longIndexes, [0, 33]);
eq("⛔ SAFETY RAIL: a 1000-square drag is bounded at plantSafetyCap and nothing else",
  plan.hugeCount, SPEC.plantSafetyCap);
eq("the rail ships at 160", plan.shippedRail, SPEC.plantSafetyCap);
eq("its last plant is index 159", plan.hugeLastIndex, SPEC.plantSafetyCap - 1);
eq("and the rail is a parameter, not a constant folded into the loop", plan.hugeExplicitCount, 5);
eq("maxLive is the SAME number — eviction can only fire on a pathological pile-up", plan.shippedMaxLive, SPEC.maxLive);
eq("a path shorter than one gate still plants its first copy", plan.tinyCount, 1);
eq("a repeated waypoint is not a corner", plan.dedup, 2);
eq("NEGATIVE: an empty path plants nothing", plan.emptyPath, 0);
check("the planner is deterministic — same path, same trail", plan.deterministic);

/* ─────────────────── §5 the source description ─────────────────── */
console.log("\n§5 the source — the copy is drawn the way the figure is DRAWN, not the way it is posed");
const source = await page.evaluate(async (mod) => {
  const A = await import(mod);
  const doc = (over = {}) => ({
    texture: { src: "tokens/example.webp", scaleX: 1, scaleY: 1 },
    width: 1, height: 1, rotation: 0, ...over,
  });
  return {
    locked: A.ghostSourceOf(doc({ rotation: 135, lockRotation: true })),
    unlocked: A.ghostSourceOf(doc({ rotation: 135, lockRotation: false })),
    absent: A.ghostSourceOf(doc({ rotation: 90 })),
    lockedAtZero: A.ghostSourceOf(doc({ rotation: 0, lockRotation: true })).rotation,
    lockedTruthyString: A.ghostSourceOf(doc({ rotation: 135, lockRotation: "yes" })).rotation,
    big: A.ghostSourceOf(doc({ width: 2, height: 3 })),
    mirrored: A.ghostSourceOf(doc({ texture: { src: "a.webp", scaleX: -2, scaleY: 1.5 } })),
    noArt: A.ghostSourceOf(doc({ texture: { src: "" } })),
    noDoc: A.ghostSourceOf(null),
  };
}, MOD);
eq("⭐ LOCK ROTATION: a locked figure leaves UPRIGHT copies whatever its document says",
  source.locked.rotation, 0);
eq("NEGATIVE: an unlocked figure leaves copies at its real angle", source.unlocked.rotation, 135);
eq("and lockRotation absent is the same as unlocked", source.absent.rotation, 90);
eq("the lock is read strictly true — a truthy non-boolean does not lock", source.lockedTruthyString, 135);
eq("a locked figure at zero is still zero", source.lockedAtZero, 0);
eq("size comes from the figure's own footprint", [source.big.widthSquares, source.big.heightSquares], [2, 3]);
eq("a negative texture scale mirrors the copy and still sizes it by the scale's magnitude",
  [source.mirrored.mirrorX, source.mirrored.mirrorY, source.mirrored.widthSquares, source.mirrored.heightSquares],
  [true, false, 2, 1.5]);
eq("NEGATIVE: no art, no source description", source.noArt, null);
eq("NEGATIVE: no document, no source description", source.noDoc, null);

/* ─────────────────── §6 the grade's arithmetic ─────────────────── */
console.log("\n§6 the scene pass — ramp / hold / release by value, and the release schedule");
const grade = await page.evaluate(async (mod) => {
  const A = await import(mod);
  const at = (t, held = false) => {
    const s = A.gradeScalesAt(t, { held });
    return { r: Number(s.r.toFixed(4)), g: Number(s.g.toFixed(4)), b: Number(s.b.toFixed(4)), phase: s.phase };
  };
  return {
    ladder: A.gradeLadderMs(),
    releaseMs: A.AFTERIMAGE.gradeReleaseMs,
    t0: at(0), tHalfRamp: at(600), tRampEnd: at(1200), tMidHold: at(2400),
    tHoldEnd: at(3600), tMidRelease: at(3900), tDone: at(4200), tLate: at(99999),
    heldLate: at(99999, true), heldMidRamp: at(600, true),
    progressAtHalfRamp: Number(A.gradeScalesAt(600).progress.toFixed(4)),
    progressHeldLate: Number(A.gradeScalesAt(99999, { held: true }).progress.toFixed(4)),
    matrixAtFull: A.gradeMatrixOf(A.gradeScalesAt(1200)),
    // ⭐ the movement-tied release schedule, as a pure function of the plan
    relRef: A.gradeReleaseAtMsFor({ durationMs: 3900, plants: new Array(13) }),
    rel21: A.gradeReleaseAtMsFor({ durationMs: 4000, plants: new Array(21) }),
    relEmpty: A.gradeReleaseAtMsFor({}),
    relNull: A.gradeReleaseAtMsFor(null),
  };
}, MOD);
eq("the release ships at 600 ms — the video-measured 800 shortened by ruling to land with the unzip", grade.releaseMs, SPEC.gradeReleaseMs);
eq("the whole burst ladder is ramp + hold + release", grade.ladder,
  SPEC.gradeRampMs + SPEC.gradeHoldMs + SPEC.gradeReleaseMs);
eq("it starts at neutral", grade.t0, { r: 1, g: 1, b: 1, phase: "ramp" });
eq("half way up the 1.2 s ramp it is half way to the target", grade.tHalfRamp, { r: 0.79, g: 1, b: 0.885, phase: "ramp" });
eq("at the ramp's end it is the measured pass: R −42%, B −23%, G held", grade.tRampEnd, { r: 0.58, g: 1, b: 0.77, phase: "hold" });
eq("through the 2.4 s hold it does not move", grade.tMidHold, { r: 0.58, g: 1, b: 0.77, phase: "hold" });
eq("the hold ends at 3.6 s", grade.tHoldEnd, { r: 0.58, g: 1, b: 0.77, phase: "release" });
eq("half way through the 600 ms release it is half way home", grade.tMidRelease, { r: 0.79, g: 1, b: 0.885, phase: "release" });
eq("and it lands exactly on neutral at 4.2 s", grade.tDone, { r: 1, g: 1, b: 1, phase: "done" });
eq("NEGATIVE: long past the end it is still exactly neutral", grade.tLate, { r: 1, g: 1, b: 1, phase: "done" });
eq("HELD (the shipped movement-tied form): it never leaves the hold", grade.heldLate, { r: 0.58, g: 1, b: 0.77, phase: "hold" });
eq("but held does NOT skip the ramp — it is still ramping mid-ramp", grade.heldMidRamp, { r: 0.79, g: 1, b: 0.885, phase: "ramp" });
eq("progress is reported alongside the scales — half way up the ramp", grade.progressAtHalfRamp, 0.5);
eq("and a held pass reports full progress", grade.progressHeldLate, 1);
eq("the matrix is a plain per-channel diagonal, set outright", grade.matrixAtFull,
  [0.58, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0.77, 0, 0, 0, 0, 0, 1, 0]);
eq("⭐ RELEASE SCHEDULE: the reference move's 3900 ms / 13 copies predicts the observed let-go",
  grade.relRef, 3900 + SPEC.settleDelayMs + 13 * SPEC.unzipStaggerMs);
eq("and a 21-copy trail pushes it further out by exactly one stagger per copy",
  grade.rel21, 4000 + SPEC.settleDelayMs + 21 * SPEC.unzipStaggerMs);
eq("NEGATIVE: a plan with no movement releases after the settle beat alone", grade.relEmpty, SPEC.settleDelayMs);
eq("NEGATIVE: and no plan at all does not throw", grade.relNull, SPEC.settleDelayMs);

/* ─────────────────── §7 the live path: the real mechanism, the real hook ─────────────────── */
console.log("\n§7 the live path — the bench figure's own implant, switched on for real");
const live = await page.evaluate(async (mod) => {
  const A = await import(mod);
  const S = await import("/modules/cp2020-augmented/module/settings.js");
  const SCOPE = "cp2020-augmented";
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { steps: [] };

  const scene = game.scenes.find(s => s.name === "Review · Dark Range");
  if (!scene) return { error: "no bench scene" };
  await scene.view();
  await sleep(1200);
  const actor = game.actors.getName("Review · Shooter");
  if (!actor) return { error: "no bench figure" };
  const tokenDoc = scene.tokens.find(t => t.actor?.id === actor.id);
  if (!tokenDoc) return { error: "the bench figure has no token on the bench scene" };

  // HARNESS GUARD (standing rule): prove the canvas is the one we think it is before measuring.
  out.harness = {
    viewed: canvas.scene?.id === scene.id,
    tokenOnCanvas: !!canvas.tokens.get(tokenDoc.id),
    fxOn: S.combatFxEnabled(),
  };

  const implant = actor.itemTypes.cyberware.find(i => /sandevistan/i.test(i.name)) ?? null;
  out.implant = implant ? {
    name: implant.name, mode: implant.system?.EffectMode,
    init: implant.system?.CyberWorkType?.Checks?.Initiative,
  } : null;
  if (!implant) return { ...out, error: "the bench figure carries no activated initiative boost" };

  const home = { x: tokenDoc.x, y: tokenDoc.y };
  const G = canvas.dimensions.size;
  const mk = (pts) => ({
    id: foundry.utils.randomID(),
    origin: { x: pts[0][0], y: pts[0][1], width: tokenDoc.width, height: tokenDoc.height },
    passed: { waypoints: pts.slice(1).map(([x, y]) => ({ x, y, width: tokenDoc.width, height: tokenDoc.height })) },
  });
  const settleTo = async (want) => {
    for (let i = 0; i < 60; i++) {
      if (A.liveAfterimageFx().length >= want) return true;
      await sleep(100);
    }
    return false;
  };
  const sweepToZero = async () => {
    A.clearAfterimageFx();
    for (let i = 0; i < 40; i++) { if (A.liveAfterimageFx().length === 0) return true; await sleep(100); }
    return false;
  };

  await sweepToZero();
  A.releaseSceneGrade({ immediate: true });
  // ⚠ NO TIME SCALE IN THIS SECTION, deliberately. The trail and the pass are measured on the REAL
  // clock here, because everything under test is clock-shaped — the ramp's progress at a release, the
  // continuity of one pass across two trails — and a compressed ladder answers all of it vacuously.

  /* ── NEGATIVE: unarmed. The implant is present and switched OFF. ── */
  out.unarmedGate = A.afterimageArmedFor(actor);
  const pathA = [[home.x, home.y], [home.x + 14 * G, home.y], [home.x + 14 * G, home.y + 6 * G]];
  const unarmed = A.layTrail(tokenDoc, mk(pathA));
  await sleep(400);
  out.steps.push({ step: "unarmed", skipped: unarmed.skipped, queued: unarmed.queued.length,
    live: A.liveAfterimageFx().length, grade: A.sceneGradeState() });

  /* ── ARMED — through the REAL mechanism, the base system's own switch ── */
  const docsBefore = {
    actors: game.actors.size, items: actor.items.size,
    tokens: scene.tokens.size, effects: actor.effects.size,
    tokenX: tokenDoc.x, tokenY: tokenDoc.y,
  };
  await implant.update({ "system.EffectActive": true });
  out.armedGate = A.afterimageArmedFor(actor);
  // ⭐ THE SHIPPED TRIGGER MODEL: the activation flip alone starts NOTHING. The pass rides the
  // MOVEMENT (ledger #23ce) — the superseded burst-at-activation would light the scene right here.
  out.gradeAfterActivationAlone = A.sceneGradeState();
  await sleep(400);

  /* ── TRAIL ONE: the pass comes up WITH the trail ── */
  const first = A.layTrail(tokenDoc, mk(pathA));
  const gradeAtTrail = A.sceneGradeState();
  out.trail1 = {
    skipped: first.skipped, queued: first.queued.length, plants: first.plants.length,
    durationMs: first.durationMs,
    releaseAt: A.gradeReleaseAtMsFor(first),
    fadeStartsAfterSettle: first.plants.every(p => p.fadeStartMs >= first.durationMs + 200),
    firstFadeStart: first.plants[0]?.fadeStartMs ?? null,
    grade: gradeAtTrail ? { held: gradeAtTrail.held, phase: gradeAtTrail.phase } : null,
    elapsed: gradeAtTrail?.elapsedMs ?? null,
  };
  await settleTo(Math.min(6, first.queued.length));
  const namesA = A.liveAfterimageFx().map(e => e.data.name);
  out.firstLive = namesA.length;
  out.firstNamesUnderPrefix = namesA.every(n => n.startsWith(`${SCOPE}.afterimage.`));
  out.docsUnmoved = JSON.stringify({
    actors: game.actors.size, items: actor.items.size,
    tokens: scene.tokens.size, effects: actor.effects.size,
    tokenX: tokenDoc.x, tokenY: tokenDoc.y,
  }) === JSON.stringify({ ...docsBefore, effects: actor.effects.size });
  out.effectsDelta = actor.effects.size - docsBefore.effects;   // the timer ICON is consumable.js's, not ours
  out.tokenUnmoved = tokenDoc.x === docsBefore.tokenX && tokenDoc.y === docsBefore.tokenY;

  /* ── ⭐ THE SECOND-ACT RULE: a chained trail must NOT restart the ramp. The pass record has to
   * survive — only the release timer is replaced. Measured on the pass's OWN elapsed clock. ── */
  const beforeSecond = A.sceneGradeState();
  await sleep(700);
  const pathB = [[home.x, home.y], [home.x, home.y + 6 * G], [home.x + 3 * G, home.y + 6 * G]];
  const second = A.layTrail(tokenDoc, mk(pathB));
  const afterSecond = A.sceneGradeState();
  out.chained = {
    secondQueued: second.queued.length, secondSkipped: second.skipped,
    beforeElapsed: beforeSecond?.elapsedMs ?? null,
    afterElapsed: afterSecond?.elapsedMs ?? null,
    stillHeld: afterSecond?.held ?? null,
    // the two trails are two different walks, not two indexes of one
    pathsDiffer: JSON.stringify(first.plants.map(p => [Math.round(p.x), Math.round(p.y)]))
      !== JSON.stringify(second.plants.map(p => [Math.round(p.x), Math.round(p.y)])),
  };

  /* ── THE WIRING (coverage policy 1): the legs above drive layTrail directly, which proves the
   * mechanism and NOT the registration. This fires Foundry's OWN `moveToken` hook. ── */
  await sweepToZero();
  const pathW = [[home.x, home.y], [home.x + 4 * G, home.y], [home.x + 4 * G, home.y + 2 * G]];
  Hooks.callAll("moveToken", tokenDoc, mk(pathW), {}, game.user);
  const wiredOk = await settleTo(3);
  out.wiring = { drewFromTheRealHook: wiredOk, live: A.liveAfterimageFx().length };

  /* ── ⭐ TWO MOVERS, ONE PASS (the 2026-08-28 mechanisms). LATEST-WINS runs under the capture
   * seam, deliberately breaking this section's no-time-scale rule for one block: the leg is about
   * SCHEDULE ARITHMETIC (whose release stands), and the compressed ladder makes the between-the-two
   * window deterministic instead of a thin real-clock race. ── */
  await sweepToZero();
  A.releaseSceneGrade({ immediate: true });
  A._setAfterimageTimeScale(0.1);
  const longPath = [[home.x, home.y], [home.x + 40 * G, home.y]];
  const shortPath = [[home.x, home.y], [home.x + 5 * G, home.y]];
  const tA = A.layTrail(tokenDoc, mk(longPath));
  const tB = A.layTrail(tokenDoc, mk(shortPath));   // laid while held: schedules only
  const relAms = A.gradeReleaseAtMsFor(tA), relBms = A.gradeReleaseAtMsFor(tB);
  await sleep(Math.round(relBms * 0.1) + 150);      // past B's due, well inside A's
  const betweenState = A.sceneGradeState();
  await sleep(Math.max(0, Math.round(relAms * 0.1) - Math.round(relBms * 0.1) - 150) + 200);
  out.latestWins = {
    relA: relAms, relB: relBms,
    stillHeldBetween: betweenState?.held ?? null, phaseBetween: betweenState?.phase ?? null,
    afterA: A.sceneGradeState(),                    // A's own schedule let it go and it took itself down
  };
  A._setAfterimageTimeScale(null);
  await sweepToZero();
  A.releaseSceneGrade({ immediate: true });

  /* ── ⭐ REGRIP, on the REAL clock: a trail landing inside the 600 ms drain takes the pass back
   * over at its current strength — the drain window is wide enough to hit deliberately. ── */
  const tR1 = A.layTrail(tokenDoc, mk(shortPath));
  const relR1 = A.gradeReleaseAtMsFor(tR1);
  await sleep(relR1 + 250);                         // ~250 ms into the drain
  const draining = A.sceneGradeState();
  const tR2 = A.layTrail(tokenDoc, mk(shortPath));  // the regripping trail
  const regripped = A.sceneGradeState();
  const heldRefusal = A.regripSceneGrade();         // pass is held again now: refuses by name
  out.regrip = {
    drainHeld: draining?.held ?? null, drainPhase: draining?.phase ?? null,
    drainP: draining ? Number(draining.progress.toFixed(3)) : null,
    afterHeld: regripped?.held ?? null, afterPhase: regripped?.phase ?? null,
    afterP: regripped ? Number(regripped.progress.toFixed(3)) : null,
    trailQueued: tR2.queued.length,
    heldRefusal,
  };
  A.releaseSceneGrade({ immediate: true });
  out.idleRegrip = A.regripSceneGrade();
  await sweepToZero();

  /* ── EVICTION through the engine's own manager, at the shipped rail.
   * ⚠ NO FIXED SLEEP (standing rule): `endEffects` is async and its latency moves with rig load, and
   * a trail still being laid keeps landing NEW copies behind the sweep. So the leg names the exact
   * copies that were standing when it asked, and polls until none of THOSE is left. ── */
  await sweepToZero();
  A.layTrail(tokenDoc, mk(pathA));                            // a long walk, so the copies outlive the ask
  let namesBefore = [];
  for (let i = 0; i < 60; i++) {
    namesBefore = A.liveAfterimageFx().map(e => e.data.name);
    if (namesBefore.length >= 5) break;
    await sleep(100);
  }
  // Same synchronous block: no plant timer can land between the count and the ask.
  const liveAtEvict = A.liveAfterimageFx().length;
  const evicted = A.evictForRoom(A.AFTERIMAGE.maxLive);       // asks for the whole rail: everything goes
  let stillThere = namesBefore.slice();
  for (let i = 0; i < 50; i++) {
    const now = new Set(A.liveAfterimageFx().map(e => e.data.name));
    stillThere = namesBefore.filter(n => now.has(n));
    if (!stillThere.length) break;
    await sleep(100);
  }
  await sweepToZero();
  out.eviction = { named: namesBefore.length, liveAtEvict, evicted, stillThere: stillThere.length,
    // and asking for room an honest drag needs evicts nothing
    quiet: A.evictForRoom(1) };

  /* ── ⭐ THE PICTURE: the LIVE filter's uniform matrix, read off the scene group mid-hold ── */
  A.releaseSceneGrade({ immediate: true });
  A.startSceneGrade();                                        // shipped default = held
  await sleep(1900);                                          // past the 1.2 s ramp
  const target = canvas.environment ?? canvas.stage;
  const ours = (target.filters ?? [])[(target.filters ?? []).length - 1];
  const m = ours?.uniforms?.m ? Array.from(ours.uniforms.m).map(n => Number(Number(n).toFixed(4))) : null;
  out.uniform = {
    group: canvas.environment ? "environment" : "stage",
    isColorMatrix: !!(globalThis.PIXI?.ColorMatrixFilter && ours instanceof globalThis.PIXI.ColorMatrixFilter),
    m, r: m?.[0] ?? null, g: m?.[6] ?? null, b: m?.[12] ?? null,
    state: A.sceneGradeState() ? { held: A.sceneGradeState().held, phase: A.sceneGradeState().phase } : null,
  };

  /* ── the RENDERED-PIXEL readback, attempted and timed. Kept only if it is cheap. ── */
  try {
    const t0 = performance.now();
    const R = globalThis.PIXI.Rectangle;
    const sw = canvas.app.screen.width, sh = canvas.app.screen.height;
    const frame = new R(Math.round(sw / 2) - 16, Math.round(sh / 2) - 16, 32, 32);
    const mean = () => {
      const px = canvas.app.renderer.extract.pixels(canvas.app.stage, frame);
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
      return n ? { r: r / n, g: g / n, b: b / n, n } : null;
    };
    const on = mean();
    A.releaseSceneGrade({ immediate: true });
    await sleep(150);
    const off = mean();
    out.pixels = {
      ms: Math.round(performance.now() - t0),
      on: on ? { r: Math.round(on.r), g: Math.round(on.g), b: Math.round(on.b), n: on.n } : null,
      off: off ? { r: Math.round(off.r), g: Math.round(off.g), b: Math.round(off.b), n: off.n } : null,
      onRG: on && on.g > 0 ? Number((on.r / on.g).toFixed(4)) : null,
      offRG: off && off.g > 0 ? Number((off.r / off.g).toFixed(4)) : null,
    };
  } catch (err) {
    out.pixels = { error: String(err?.message ?? err).slice(0, 160) };
  }
  A.releaseSceneGrade({ immediate: true });

  /* ── ⭐ THE RELEASE EASES FROM CURRENT PROGRESS — no flash-to-full on a short move ── */
  A.startSceneGrade();
  const defaultHeld = A.sceneGradeState()?.held ?? null;
  await sleep(430);                                           // ~36% up the 1.2 s ramp
  const beforeRelease = A.sceneGradeState();
  A.releaseSceneGrade();
  const samples = [];
  for (let i = 0; i < 16; i++) {
    const st = A.sceneGradeState();
    if (!st) { samples.push(null); break; }
    samples.push({ p: Number(st.progress.toFixed(4)), phase: st.phase, r: Number(st.r.toFixed(4)) });
    await sleep(90);
  }
  out.midRamp = {
    defaultHeld,
    pBefore: beforeRelease ? Number(beforeRelease.progress.toFixed(4)) : null,
    rBefore: beforeRelease ? Number(beforeRelease.r.toFixed(4)) : null,
    phaseBefore: beforeRelease?.phase ?? null,
    samples,
  };
  A.releaseSceneGrade({ immediate: true });

  /* ── AT FULL PROGRESS the release reduces to the old arithmetic ── */
  A.startSceneGrade();
  await sleep(1900);
  const atFull = A.sceneGradeState();
  A.releaseSceneGrade();
  const justAfter = A.sceneGradeState();
  // POLL for a mid-drain reading instead of sleeping to a fixed point: in-page setTimeout lag under
  // this section's render load measures ~190 ms, a third of the 600 ms drain, so any fixed-point
  // probe races the very clock it measures. The claim is only that the ease PASSES THROUGH the
  // middle on its way home — assert the first reading seen inside the band.
  let partWay = null;
  for (let i = 0; i < 40; i++) {
    const st = A.sceneGradeState();
    if (!st) break;                                   // already home and detached
    if (st.phase === "release" && st.progress <= 0.9) { partWay = st; break; }
    await sleep(30);
  }
  await sleep(900);
  const gone = A.sceneGradeState();
  out.fullRelease = {
    fullPhase: atFull?.phase ?? null, fullP: atFull ? Number(atFull.progress.toFixed(3)) : null,
    afterPhase: justAfter?.phase ?? null, afterP: justAfter ? Number(justAfter.progress.toFixed(3)) : null,
    afterHeld: justAfter?.held ?? null,
    partP: partWay ? Number(partWay.progress.toFixed(3)) : null,
    goneState: gone,
    detached: !(canvas.environment ?? canvas.stage).filters?.some(
      f => globalThis.PIXI?.ColorMatrixFilter && f instanceof globalThis.PIXI.ColorMatrixFilter),
  };
  out.releaseIdle = A.releaseSceneGrade();                    // nothing running: refuses by name

  /* ── ⭐ DEACTIVATION MID-PASS RELEASES EARLY — through the REAL updateItem hook ── */
  A.startSceneGrade();
  await sleep(800);                                           // half way up the ramp
  const beforeFlip = A.sceneGradeState();
  await implant.update({ "system.EffectActive": false }, { cp2020TimerExpiry: true });
  await sleep(250);
  const afterFlip = A.sceneGradeState();
  out.deactivation = {
    beforeHeld: beforeFlip?.held ?? null, beforePhase: beforeFlip?.phase ?? null,
    afterHeld: afterFlip?.held ?? null, afterPhase: afterFlip?.phase ?? null,
    afterP: afterFlip ? Number(afterFlip.progress.toFixed(3)) : null,
  };
  await sleep(900);
  out.deactivation.settled = A.sceneGradeState();

  /* ── EXPIRY — the same flip is what the consumable tick performs ── */
  out.expiredGate = A.afterimageArmedFor(actor);
  const afterExpiry = A.layTrail(tokenDoc, mk(pathA));
  await sleep(500);
  out.steps.push({ step: "expired", skipped: afterExpiry.skipped, queued: afterExpiry.queued.length,
    live: A.liveAfterimageFx().length, grade: A.sceneGradeState() });

  /* ── the MASTER SWITCH negative ── */
  const was = game.settings.get(SCOPE, "combatFxEnabled");
  try {
    await game.settings.set(SCOPE, "combatFxEnabled", false);
    await implant.update({ "system.EffectActive": true });
    await sleep(300);
    const offTrail = A.layTrail(tokenDoc, mk(pathA));
    out.switchOff = { skipped: offTrail.skipped, grade: A.startSceneGrade().skipped,
      live: A.liveAfterimageFx().length };
  } finally {
    await game.settings.set(SCOPE, "combatFxEnabled", was);
    await implant.update({ "system.EffectActive": false }, { cp2020TimerExpiry: true }).catch(() => {});
    A._setAfterimageTimeScale(null);
    out.swept = await sweepToZero();
    // The consumable timer's own token icon is that engine's, not ours — drop it so the bench is left
    // exactly as provisioning leaves it.
    const strays = (actor.effects?.contents ?? [])
      .filter(e => e.getFlag?.(SCOPE, "consumableItemId") === implant.id).map(e => e.id);
    if (strays.length) await actor.deleteEmbeddedDocuments("ActiveEffect", strays).catch(() => {});
    await tokenDoc.update({ x: home.x, y: home.y }, { animate: false }).catch(() => {});
    A.releaseSceneGrade({ immediate: true });
  }
  out.restingArmed = A.afterimageArmedFor(actor);
  out.finalLive = A.liveAfterimageFx().length;
  out.finalGrade = A.sceneGradeState();
  return out;
}, MOD);

if (live.error) check(`live path reachable (${live.error})`, false);
else {
  check("harness: the bench scene is the viewed scene and its figure is on the canvas",
    live.harness.viewed && live.harness.tokenOnCanvas, JSON.stringify(live.harness));
  check("the bench figure carries the base pack's own activated initiative boost",
    live.implant?.mode === "Activatable" && live.implant?.init === 3, JSON.stringify(live.implant));
  eq("NEGATIVE: switched off, the gate reads unarmed", live.unarmedGate, false);
  eq("NEGATIVE: and the trail refuses by name, drawing nothing and grading nothing",
    { skipped: live.steps[0].skipped, queued: live.steps[0].queued, live: live.steps[0].live, grade: live.steps[0].grade },
    { skipped: "unarmed", queued: 0, live: 0, grade: null });
  eq("switching the implant on arms the gate — read off the base system's own field", live.armedGate, true);
  eq("⭐ THE ACTIVATION FLIP ALONE STARTS NO PASS — the pass rides the MOVEMENT",
    live.gradeAfterActivationAlone, null);
  check("the armed walk queues its whole planned trail",
    live.trail1.skipped === null && live.trail1.queued > 0, JSON.stringify({ ...live.trail1, grade: undefined }));
  check("that walk is long enough to be a real trail — past the reference count",
    live.trail1.plants > SPEC.ghostCap, `${live.trail1.plants} copies`);
  check("and none of its copies fades before the figure settles", live.trail1.fadeStartsAfterSettle,
    `first fade-start ${live.trail1.firstFadeStart}, settle ${live.trail1.durationMs + SPEC.settleDelayMs}`);
  eq("⭐ THE TRAIL STARTS THE PASS, held, on its ramp", live.trail1.grade, { held: true, phase: "ramp" });
  eq("and the release is scheduled for duration + settle beat + one stagger per copy",
    live.trail1.releaseAt,
    Math.round(live.trail1.durationMs + SPEC.settleDelayMs + live.trail1.plants * SPEC.unzipStaggerMs));
  eq("every copy the engine holds is stamped under the one prefix", live.firstNamesUnderPrefix, true);
  check("the copies actually reached the engine", live.firstLive > 0, `${live.firstLive} live`);
  check("ZERO DOCUMENT WRITES: actor, item, token and scene counts are unmoved", live.docsUnmoved);
  check("and no ActiveEffect came from the drawing (any delta is consumable.js's timer icon)",
    live.effectsDelta <= 1, `delta ${live.effectsDelta}`);
  check("and the figure itself was not moved by the drawing", live.tokenUnmoved);

  check("SECOND ACT: a chained trail draws its own copies", live.chained.secondSkipped === null
    && live.chained.secondQueued > 0, JSON.stringify(live.chained));
  check("⭐ SECOND ACT: it does NOT restart the ramp — the pass's own clock keeps running",
    live.chained.afterElapsed !== null && live.chained.beforeElapsed !== null
    && (live.chained.afterElapsed - live.chained.beforeElapsed) >= 600,
    `elapsed ${live.chained.beforeElapsed} → ${live.chained.afterElapsed} ms across a 700 ms gap`);
  eq("and the pass is still the same held pass afterwards", live.chained.stillHeld, true);
  check("the two walks are two different trails, not two indexes of one", live.chained.pathsDiffer);

  check("WIRING: Foundry's own moveToken hook reaches this element and draws",
    live.wiring.drewFromTheRealHook, `${live.wiring.live} live from the real hook`);

  check("⭐ LATEST-WINS: a shorter second trail cannot pull the release under the longer first",
    live.latestWins.stillHeldBetween === true && live.latestWins.phaseBetween === "hold"
    && live.latestWins.relB < live.latestWins.relA,
    JSON.stringify({ ...live.latestWins, afterA: undefined }));
  eq("…and the pass still lets go on the LONGER trail's own schedule, taking itself down",
    live.latestWins.afterA, null);
  eq("REGRIP: the pass was genuinely draining when the next trail landed",
    { held: live.regrip.drainHeld, phase: live.regrip.drainPhase }, { held: false, phase: "release" });
  check("⭐ REGRIP: a trail landing mid-drain takes the pass back over at its CURRENT strength",
    live.regrip.afterHeld === true && live.regrip.afterPhase === "ramp"
    && Math.abs(live.regrip.afterP - live.regrip.drainP) <= 0.05,
    `drained to ${live.regrip.drainP}, resumed at ${live.regrip.afterP}`);
  check("and the regripping trail drew its own copies too", live.regrip.trailQueued > 0,
    `${live.regrip.trailQueued} queued`);
  eq("NEGATIVE: regripping a HELD pass refuses by name", live.regrip.heldRefusal,
    { regripped: false, skipped: "held" });
  eq("NEGATIVE: regripping when nothing runs refuses by name", live.idleRegrip,
    { regripped: false, skipped: "idle" });

  check("EVICTION ends exactly what was standing when it was asked",
    live.eviction.named >= 5 && live.eviction.evicted === live.eviction.liveAtEvict
    && live.eviction.liveAtEvict > 0, JSON.stringify(live.eviction));
  eq("and every one of those named copies is gone from the engine's own census",
    live.eviction.stillThere, 0);
  eq("NEGATIVE: room for one more copy is well inside the 160 rail — nothing is evicted",
    live.eviction.quiet, 0);

  eq("⛔ THE PICTURE: the pass is hung on the scene's own group", live.uniform.group, "environment");
  check("and what is hung there is a real PIXI ColorMatrixFilter", live.uniform.isColorMatrix);
  eq("mid-hold the LIVE filter's uniform matrix carries the measured red scale", live.uniform.r, SPEC.gradeRedScale);
  eq("…the measured blue scale", live.uniform.b, SPEC.gradeBlueScale);
  eq("…and green held at 1", live.uniform.g, SPEC.gradeGreenScale);
  eq("the whole live uniform is the plain diagonal, nothing else touched", live.uniform.m,
    [0.58, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0.77, 0, 0, 0, 0, 0, 1, 0]);
  eq("and the pass reports itself held at that moment", live.uniform.state, { held: true, phase: "hold" });

  if (live.pixels?.error) {
    note(`rendered-pixel readback NOT feasible on this renderer (${live.pixels.error}) — the live-uniform read above is the assertion of record`);
  } else if (live.pixels?.on && live.pixels?.off && live.pixels.offRG !== null && live.pixels.off.g >= 6) {
    check("RENDERED PIXELS: the graded frame's R/G is pulled down toward the measured 0.58",
      live.pixels.onRG <= live.pixels.offRG * 0.75,
      `on ${live.pixels.onRG} vs off ${live.pixels.offRG} (${live.pixels.ms} ms for both extracts)`);
  } else {
    note(`rendered-pixel readback ran in ${live.pixels?.ms} ms but the sampled region carries no usable luminance (${JSON.stringify(live.pixels?.off)}) — inconclusive, the live-uniform read above is the assertion of record`);
  }

  eq("startSceneGrade defaults to the shipped HELD form", live.midRamp.defaultHeld, true);
  eq("released mid-ramp, the pass was genuinely mid-ramp", live.midRamp.phaseBefore, "ramp");
  check("…and had reached only part of the way", live.midRamp.pBefore > 0.1 && live.midRamp.pBefore < 0.6,
    `progress ${live.midRamp.pBefore}`);
  {
    const taken = live.midRamp.samples.filter(Boolean);
    check("⭐ NO FLASH TO FULL: after the release, progress NEVER exceeds what the ramp had reached",
      taken.every(s => s.p <= live.midRamp.pBefore + 0.02),
      `reached ${live.midRamp.pBefore}, max after ${Math.max(...taken.map(s => s.p))}`);
    check("it eases FROM that progress — the first reading continues where the ramp stopped",
      taken.length > 0 && Math.abs(taken[0].p - live.midRamp.pBefore) <= 0.05,
      `reached ${live.midRamp.pBefore}, first after ${taken[0]?.p}`);
    check("and the red scale never dips below the one the ramp had painted",
      taken.every(s => s.r >= live.midRamp.rBefore - 0.01),
      `painted ${live.midRamp.rBefore}, min after ${Math.min(...taken.map(s => s.r))}`);
    check("the pass walks itself home and takes itself down",
      live.midRamp.samples[live.midRamp.samples.length - 1] === null,
      JSON.stringify(live.midRamp.samples.slice(-3)));
  }
  eq("AT FULL PROGRESS the pass was holding before the release", live.fullRelease.fullPhase, "hold");
  eq("and the release reduces to the old arithmetic — release phase, full progress",
    { phase: live.fullRelease.afterPhase, p: live.fullRelease.afterP, held: live.fullRelease.afterHeld },
    { phase: "release", p: 1, held: false });
  check("part way through it is part way home — a mid-drain reading exists inside the band",
    live.fullRelease.partP !== null && live.fullRelease.partP > 0.02 && live.fullRelease.partP <= 0.9,
    `progress ${live.fullRelease.partP}`);
  eq("and it lands neutral and detaches itself", live.fullRelease.goneState, null);
  check("leaving no colour-matrix filter on the scene group", live.fullRelease.detached);
  eq("NEGATIVE: releasing when nothing is running refuses by name", live.releaseIdle,
    { released: false, skipped: "idle" });

  eq("DEACTIVATION: the pass was held and ramping before the flip",
    { held: live.deactivation.beforeHeld, phase: live.deactivation.beforePhase }, { held: true, phase: "ramp" });
  eq("⭐ DEACTIVATION: the base system's own EffectActive → false releases the pass EARLY",
    { held: live.deactivation.afterHeld, phase: live.deactivation.afterPhase },
    { held: false, phase: "release" });
  eq("and it finishes letting go on its own", live.deactivation.settled, null);

  eq("EXPIRY (the tick's own off-flip): the gate reads unarmed again", live.expiredGate, false);
  eq("EXPIRY: and the next walk draws nothing at all and grades nothing",
    { skipped: live.steps[1].skipped, queued: live.steps[1].queued, live: live.steps[1].live, grade: live.steps[1].grade },
    { skipped: "unarmed", queued: 0, live: 0, grade: null });
  eq("NEGATIVE: master switch off — trail and pass both refuse by name",
    live.switchOff, { skipped: "disabled", grade: "disabled", live: 0 });
  eq("the rig is left clean", live.finalLive, 0);
  eq("no pass is left running on the scene", live.finalGrade, null);
  eq("and the bench implant is left switched off", live.restingArmed, false);
}

/* ─────────────────── §8 the burst ladder and the group's own filters ─────────────────── */
console.log("\n§8 the burst ladder — the explicit alternative, through the capture seam");
const gradeLive = await page.evaluate(async (mod) => {
  const A = await import(mod);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const target = canvas.environment ?? canvas.stage;
  const before = Array.isArray(target.filters) ? target.filters.length : 0;
  const foreign = { padding: 0 };            // a filter-shaped stand-in already on the group
  target.filters = [...(target.filters ?? []), foreign];
  const withForeign = target.filters.length;

  const started = A.startSceneGrade();
  const attached = Array.isArray(target.filters) ? target.filters.length : 0;
  await sleep(400);
  const mid = A.sceneGradeState();
  await sleep(1700);
  const held = A.sceneGradeState();
  A.releaseSceneGrade({ immediate: true });
  await sleep(120);
  const afterRelease = Array.isArray(target.filters) ? target.filters.length : 0;
  const foreignSurvived = (target.filters ?? []).includes(foreign);

  // THE CAPTURE SEAM (standard §I/25), applied FIRST in the chain: the explicit BURST runs its whole
  // 4.2 s ladder against a compressed clock and takes itself down at the end without being told to.
  const seam = A._setAfterimageTimeScale(0.05);
  A.startSceneGrade({ sustained: false });
  const burstAttached = Array.isArray(target.filters) ? target.filters.length : 0;
  const burstHeld = A.sceneGradeState()?.held ?? null;
  await sleep(500);                                   // = 10 s on the compressed ladder
  const burstIdle = A.sceneGradeState();
  const burstDetached = Array.isArray(target.filters) ? target.filters.length : 0;
  A._setAfterimageTimeScale(null);
  A.releaseSceneGrade({ immediate: true });

  target.filters = (target.filters ?? []).filter(f => f !== foreign);
  const restored = Array.isArray(target.filters) ? target.filters.length : 0;
  return {
    group: canvas.environment ? "environment" : "stage",
    before, withForeign, started, attached, afterRelease, foreignSurvived, restored,
    midPhase: mid?.phase ?? null, heldPhase: held?.phase ?? null,
    heldR: held ? Number(held.r.toFixed(4)) : null,
    idleAfter: A.sceneGradeState(),
    seam, burstAttached, burstHeld, burstIdle, burstDetached,
  };
}, MOD);
eq("the pass starts", gradeLive.started, { started: true, skipped: null });
eq("it appends exactly one filter to the scene group", gradeLive.attached, gradeLive.withForeign + 1);
eq("mid-ramp it reports the ramp", gradeLive.midPhase, "ramp");
eq("HELD (the shipped form), it is still holding well past the burst ladder's own end", gradeLive.heldPhase, "hold");
eq("and holding at the measured red scale", gradeLive.heldR, SPEC.gradeRedScale);
eq("releasing removes ours and only ours", gradeLive.afterRelease, gradeLive.withForeign);
check("a filter that was already on the group is untouched", gradeLive.foreignSurvived);
eq("nothing reports itself running afterwards", gradeLive.idleAfter, null);
eq("the capture seam takes the compression", gradeLive.seam, 0.05);
eq("EXPLICIT BURST: sustained:false is the one way to get the fixed ladder", gradeLive.burstHeld, false);
eq("EXPLICIT BURST: it attaches", gradeLive.burstAttached, gradeLive.withForeign + 1);
eq("EXPLICIT BURST: and takes ITSELF down at the ladder's end, unasked", gradeLive.burstIdle, null);
eq("EXPLICIT BURST: leaving the group with only what was already on it", gradeLive.burstDetached, gradeLive.withForeign);
eq("the group is left as it was found", gradeLive.restored, gradeLive.before);

/* ─────────────────── §9 settle exclusion, and the source negatives ─────────────────── */
console.log("\n§9 settle exclusion, and the models this file no longer carries");
const settle = await page.evaluate(async (mod) => {
  const A = await import(mod);
  const fx = await import("/modules/cp2020-augmented/module/fx/effects.js");
  const cases = [["pistol", null], ["rifle", "api"], ["shotgun", "slug"], ["heavy", null]];
  const tails = cases.map(([c, a]) => fx.presentationTailMs(c, a));
  const railCensus = (globalThis.Sequencer?.EffectManager?.getEffects?.({ name: `${fx.GROUND_FIRE_NAME}.*` }) ?? []).length;
  // ⛔ THE SOURCE NEGATIVES — read off the file the client actually loaded, with a POSITIVE CONTROL so
  // an empty fetch cannot pass the negatives vacuously.
  const src = await (await fetch(mod)).text();
  return {
    tails,
    tailsAgain: cases.map(([c, a]) => fx.presentationTailMs(c, a)),
    afterimageExports: Object.keys(A).filter(k => /tail|settle|arrival/i.test(k)),
    railCensusSeesUs: railCensus,
    ourCensusSeesRail: A.liveAfterimageFx().length,
    srcBytes: src.length,
    control: /unzipScheduleFor/.test(src) && /gradeReleaseAtMsFor/.test(src),
    hasGradeSustained: /gradeSustained/.test(src),
    hasCatchUp: /catchUpSceneGrade/.test(src),
    // ⚠ SCOPED TO CODE SHAPE, not to the word: the spec block NAMES the deleted per-copy lifetime in
    // its supersession note, which is the record we want kept. What must be gone is the DECLARATION.
    declaresGhostLifetime: /ghostLifetimeMs\s*[:=]/.test(src),
    recordsTheSupersession: /ghostLifetimeMs, deleted/.test(src),
    exportsGradeSustained: "gradeSustained" in A || "catchUpSceneGrade" in A,
  };
}, MOD);
eq("the shot rail's tail arithmetic is unchanged by this element existing", settle.tails, settle.tailsAgain);
eq("this element exports nothing the tail arithmetic could read", settle.afterimageExports, []);
eq("the rail's own census does not see our copies", settle.railCensusSeesUs, 0);
eq("and ours does not see the rail's", settle.ourCensusSeesRail, 0);
check("VERIFY THE VERIFIER: the source read back is the shipped file", settle.control && settle.srcBytes > 20000,
  `${settle.srcBytes} bytes, shipped markers ${settle.control}`);
eq("⛔ the SUSTAINED grade model is gone from the source", settle.hasGradeSustained, false);
eq("⛔ the canvasReady catch-up is gone from the source", settle.hasCatchUp, false);
eq("⛔ and the per-copy lifetime the rolling window ran on is no longer DECLARED", settle.declaresGhostLifetime, false);
eq("…while the spec block still records that it was deleted, and why", settle.recordsTheSupersession, true);
eq("neither dead model is left on the public surface", settle.exportsGradeSustained, false);

/* ─────────────────── §10 client health ─────────────────── */
console.log("\n§10 client health");
if (engineRaces.length) console.log(`  (note: ${engineRaces.length} engine teardown race(s) swallowed — a known keeper trap, not ours)`);
eq("0 console errors", errors.slice(0, 4), []);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
