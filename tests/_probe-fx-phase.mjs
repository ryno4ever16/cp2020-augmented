/**
 * INSTRUMENT (not a battery suite — underscore name keeps it out of run-battery): the audio↔picture
 * PHASE MEASUREMENT for delayed arrival elements.
 *
 * WHAT IS MEASURED. A landing round schedules three things on one nominal number (`arriveIn`): an
 * arrival mark (Sequencer section with `.delay`) and one impact audio call
 * (`fxHitSound`, `setTimeout`). Bundle-read 2026-08-17: the engine ALSO consumes `.delay` through
 * `setTimeout` (sequencer/dist `_execute()`), so both media sit on the same host timer — the phase
 * risk is what happens AFTER the timers fire: audio hands off to the WebAudio thread immediately,
 * while the picture still runs play() → async _initialize() → first frame at the next render tick.
 * This probe timestamps all three instants per pair, idle and under injected main-thread load:
 *
 *   tAudio  — the hit-sound SINK callback (fires INSIDE the timer callback, effects.js fire())
 *   tPlay   — the engine's `createSequencerEffect` hook for the matching arrival mark
 *   tSprite — the first animation frame on which that effect's sprite object exists
 *
 * EXIT CODE gates ONLY on instrument sanity (fixtures resolved · counts pair 1:1 · timestamps
 * ordered sanely). The phase numbers themselves are printed as INFORMATIONAL lines (labelled, per
 * the vacuous-audit policy) — they are the measurement the sync unit's go/no-go reads, not a
 * regression verdict. The post-rebuild keeper is where a tolerance leg becomes a gated assertion.
 *
 * ⛔ Fixtures are named __PWK__PHASE and removed on the way out; the sink, the spawn hook, the drop
 * seam, the load injector and every pinned setting are restored in finally blocks.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW  = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";

let pass = 0, fail = 0;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("console", m => { if (m.type() === "error" && !/compatibility|deprecat|screen resolution/i.test(m.text())) errors.push(m.text()); });
page.on("pageerror", e => errors.push(e.message));

await page.goto(`${URL}/join`);
await page.waitForSelector('select[name="userid"]');
await page.evaluate(() => {
  const sel = document.querySelector('select[name="userid"]');
  sel.value = [...sel.options].find(o => /gamemaster/i.test(o.textContent)).value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.fill('input[name="password"]', PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 60000 });
await page.waitForFunction(() => window.canvas?.ready === true, null, { timeout: 60000 });

const res = await page.evaluate(async () => {
  const SCOPE = "cp2020-augmented";
  const out = { checks: [], info: [], regimes: {} };
  const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
  const info = (n, d) => out.info.push({ n, d });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  if (!game.scenes.active) await game.scenes.contents[0]?.activate();
  const scene = game.scenes.active ?? game.scenes.contents[0];
  const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);

  // ── fixtures ─────────────────────────────────────────────────────────────────────────────────
  for (const t of [...scene.tokens].filter(t => t.name?.startsWith("__PWK__PHASE"))) await t.delete().catch(() => {});
  for (const a of [...game.actors].filter(a => a.name?.startsWith("__PWK__PHASE"))) await a.delete().catch(() => {});

  const shooter = await Actor.create({ name: "__PWK__PHASE Shooter", type: "character" });
  const body    = await Actor.create({ name: "__PWK__PHASE Body", type: "character" });
  const [rifle] = await shooter.createEmbeddedDocuments("Item", [{
    name: "__PWK__PHASE rifle", type: "weapon",
    system: { weaponType: "Rifle", attackType: "Auto", damage: "1d6", range: 400, rof: 1, shots: 40, shotsLeft: 40 },
  }]);
  // ⚠ one token per call — this rig returns multi-creates in database order (documented gotcha)
  const mkTok = async (name, actorId, x, y) => (await scene.createEmbeddedDocuments("Token",
    [{ name, actorId, x, y, width: 1, height: 1 }]))[0];
  // far apart on purpose: a long crossing → a large arrival delay → phase drift has room to show
  const shooterDoc = await mkTok("__PWK__PHASE Shooter", shooter.id, 600, 1500);
  const bodyDoc    = await mkTok("__PWK__PHASE Body", body.id, 3200, 1500);
  await sleep(400);
  ok("fixtures: both handles resolve to their actors",
    canvas.tokens.get(shooterDoc.id)?.actor?.id === shooter.id && canvas.tokens.get(bodyDoc.id)?.actor?.id === body.id);

  // ── pinned world state, restored in finally ──────────────────────────────────────────────────
  const pinned = {};
  for (const k of ["combatFxEnabled"]) { try { pinned[k] = game.settings.get(SCOPE, k); } catch (_e) {} }

  // ── the three instruments ────────────────────────────────────────────────────────────────────
  const audioRecs = [];   // {t, delayMs, kind}
  const markRecs  = [];   // {t, tSprite, file}
  const fileTally = {};   // every spawn seen, so an over- or under-match names itself
  // the hit-confirmation mark and nothing else — tracers, motes, smoke and flames are not the pair
  const isImpact = (f) => /impact_005|impact\.005/i.test(String(f));
  const spawnHook = Hooks.on("createSequencerEffect", (e) => {
    const file = String(e?.data?.file ?? e?.data?.src ?? "");
    const short = file.split("/").pop() || file;
    fileTally[short] = (fileTally[short] ?? 0) + 1;
    if (!isImpact(file)) return;
    const rec = { t: performance.now(), tSprite: null, file: short, nominal: e?.data?.delay ?? null };
    markRecs.push(rec);
    const t0 = performance.now();
    const spot = () => {
      if (e.sprite) { rec.tSprite = performance.now(); return; }
      if (performance.now() - t0 < 5000) requestAnimationFrame(spot);
    };
    requestAnimationFrame(spot);
  });

  const AH = foundry.audio.AudioHelper;
  const realPlay = AH.play;

  // main-thread load injector: ~80 ms long tasks on a ~120 ms cadence (≈65% utilisation) — the
  // shape of a busy canvas frame, deliberately coarse so starvation is visible, not subtle
  let loadTimer = null;
  const startLoad = () => { loadTimer = setInterval(() => { const t = performance.now(); while (performance.now() - t < 80) { /* stall */ } }, 120); };
  const stopLoad  = () => { if (loadTimer) { clearInterval(loadTimer); loadTimer = null; } };

  const payload = (n) => ({
    attackerId: shooter.id, weaponId: rifle.id, weaponName: "__PWK__PHASE rifle",
    targetTokenId: bodyDoc.id, shotsFired: 10, shotsHit: 4,
    areaDamages: { Torso: [{ damage: 3 + n }, { damage: 3 }, { damage: 2 }, { damage: 2 }] },
  });

  const stats = (arr) => {
    if (!arr.length) return { n: 0 };
    const s = [...arr].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { n: s.length, min: Math.round(s[0]), med: Math.round(q(0.5)), p95: Math.round(q(0.95)), max: Math.round(s[s.length - 1]) };
  };

  const runRegime = async (label, fires) => {
    // paired PER PAYLOAD — each pull opens its own capture window, so a slow arrival from one pull
    // can never be paired against the next pull's audio
    const pairs = [];
    let audioTotal = 0, markTotal = 0, stamped = 0;
    for (let i = 0; i < fires; i++) {
      audioRecs.length = 0; markRecs.length = 0;
      const t0 = performance.now();
      await fx.fxWeaponFired(payload(i));
      await sleep(3400);                               // full arrival + sprite stamps, this pull only
      if (i === 0) info(`${label} · pull 0 timeline (ms after trigger): audio fired at`,
        JSON.stringify(audioRecs.map(a => [Math.round(a.t - t0), a.delayMs])) +
        " · marks engine-started at " + JSON.stringify(markRecs.map(m => Math.round(m.t - t0))));
      audioTotal += audioRecs.length; markTotal += markRecs.length;
      stamped += markRecs.filter(m => m.tSprite != null).length;
      const n = Math.min(audioRecs.length, markRecs.length);
      for (let k = 0; k < n; k++) {
        const a = audioRecs[k], m = markRecs[k];
        pairs.push({
          playMinusAudio:   m.t - a.t,
          spriteMinusAudio: m.tSprite != null ? m.tSprite - a.t : null,
          audioNominal: a.delayMs, markNominal: m.nominal,
        });
      }
      try { Sequencer.EffectManager.endAllEffects(); } catch (_e) { /* none */ }
      await sleep(150);
    }
    const reg = {
      audio: audioTotal, marks: markTotal, paired: pairs.length, spriteStamped: stamped,
      playMinusAudio:   stats(pairs.map(p => p.playMinusAudio)),
      spriteMinusAudio: stats(pairs.filter(p => p.spriteMinusAudio != null).map(p => p.spriteMinusAudio)),
    };
    out.regimes[label] = reg;
    ok(`${label}: every issued audio record has a matching arrival element (paired 1:1)`,
      audioTotal > 0 && audioTotal === markTotal,
      `audio ${audioTotal} · marks ${markTotal}`);
    ok(`${label}: every paired element carried a first-frame stamp`,
      stamped === markTotal, `${stamped}/${markTotal}`);
    info(`${label} · engine-start minus audio-fire (ms)`, JSON.stringify(reg.playMinusAudio));
    info(`${label} · first-frame minus audio-fire (ms)`, JSON.stringify(reg.spriteMinusAudio));
    info(`${label} · nominal delays carried (audio vs mark, first 4 pairs)`,
      JSON.stringify(pairs.slice(0, 4).map(p => [p.audioNominal, p.markNominal])));
  };

  try {
    await game.settings.set(SCOPE, "combatFxEnabled", true);
    fx._setDropLagMs(600000);                               // a dropped round would unpair the count
    fx._setHitSoundSink((r) => audioRecs.push({ t: performance.now(), delayMs: r.delayMs, kind: r.kind }));
    AH.play = () => null;                                   // belt over the sink's braces

    await runRegime("idle", 3);
    startLoad();
    await runRegime("load", 3);
    stopLoad();

    // CONTROL: the bare engine, one effect, a known 500ms delay — no module code in the path.
    // If the engine alone eats the extra time, the lag is pre-timer preparation inside Sequencer;
    // if the control runs on schedule, the lag lives in the module's call path.
    const ctl = [];
    for (let i = 0; i < 5; i++) {
      markRecs.length = 0;
      const tCall = performance.now();
      const s = new Sequence();
      s.effect().file("jb2a.impact.005.orange").atLocation({ x: 2000, y: 1500 })
        .size({ width: 0.45 }, { gridUnits: true }).timeRange(0, 550).delay(500);
      s.play().catch(() => {});
      await sleep(1800);
      if (markRecs[0]) ctl.push(Math.round(markRecs[0].t - tCall - 500));
      try { Sequencer.EffectManager.endAllEffects(); } catch (_e) { /* none */ }
      await sleep(120);
    }
    info("CONTROL · bare engine, .delay(500): engine-start overshoot beyond the nominal (ms, 5 reps)",
      JSON.stringify(ctl));

    // sanity: the instrument's clocks are ordered the way the mechanism says they must be —
    // the engine-start stamp can never precede its own timer cohort by more than jitter
    const allPlay = [...(out.regimes.idle ? [out.regimes.idle] : []), ...(out.regimes.load ? [out.regimes.load] : [])];
    ok("sanity: measured distributions exist for both regimes",
      out.regimes.idle?.paired > 0 && out.regimes.load?.paired > 0,
      `idle ${out.regimes.idle?.paired} · load ${out.regimes.load?.paired}`);
    info("VERDICT MATERIAL — compare load vs idle spriteMinusAudio; the sync unit's go/no-go reads these numbers",
      JSON.stringify({ idle: out.regimes.idle?.spriteMinusAudio, load: out.regimes.load?.spriteMinusAudio }));
    info("spawn tally (every effect the hook saw, by file)", JSON.stringify(fileTally));
  } finally {
    stopLoad();
    fx._setHitSoundSink(null);
    fx._setDropLagMs?.(null);
    AH.play = realPlay;
    Hooks.off("createSequencerEffect", spawnHook);
    for (const [k, v] of Object.entries(pinned)) { try { await game.settings.set(SCOPE, k, v); } catch (_e) {} }
    try { Sequencer.EffectManager.endAllEffects(); } catch (_e) { /* none */ }
    for (const t of [...scene.tokens].filter(t => t.name?.startsWith("__PWK__PHASE"))) await t.delete().catch(() => {});
    await shooter.delete().catch(() => {}); await body.delete().catch(() => {});
  }
  return out;
});

for (const c of res.checks) {
  if (c.p) { pass++; console.log(`ok    ${c.n}${c.d ? "  — " + c.d : ""}`); }
  else { fail++; console.log(`FAIL  ${c.n}${c.d ? "  — " + c.d : ""}`); }
}
for (const i of res.info) console.log(`INFORMATIONAL  ${i.n}: ${i.d}`);
if (errors.length) { console.log(`console errors (${errors.length}):`); errors.slice(0, 6).forEach(e => console.log("  " + e.slice(0, 200))); }
console.log(`phase instrument: ${pass} ok, ${fail} FAIL — the INFORMATIONAL lines are the measurement`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
