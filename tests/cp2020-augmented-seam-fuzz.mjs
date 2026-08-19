/**
 * SEAM FUZZ + INVARIANT PROBES — what the module does when the payload it is handed is wrong.
 *
 * WHAT THIS IS FOR. Every other suite in the battery drives the module with payloads the module's own
 * producer built, so every field is present, of the right type, and in range. The failure class that
 * survives all of them is the one where a field ISN'T: a producer that stops emitting a key, a base
 * system that re-types one, a relay that drops a value in transit, a macro that hand-builds three
 * fields and calls the hook. What must not happen then is a SILENT HALF-WRITE — a number that lands in
 * an actor as NaN, a value that quietly becomes `undefined` two derivations downstream, damage that
 * moves the wrong way. Either the module does the whole job, or it declines and says so.
 *
 * ⭐ THE PROPERTY BEING ASSERTED, stated once so the legs below can be read against it. For every
 * malformed or boundary payload put through the live seam:
 *   1. no uncaught fault, and no error attributed to this module (Foundry catches a hook listener's
 *      throw and reports it through console.error, so that channel is read and split by attribution —
 *      a stack frame inside this module is this suite's business, core's own logging is not);
 *   2. no fixture actor's stored data acquires a NaN or an `undefined` leaf, and no derived value
 *      becomes NaN;
 *   3. accumulated damage stays a finite number that never DECREASES;
 *   4. the emission ends in one of three honest states — it applied something, it declined and said so
 *      (a notification or a module warn), or it declined silently having changed nothing at all. A
 *      fourth state, "changed something and said nothing while leaving the data unusable", is the
 *      defect this suite exists to catch.
 * Warnings are EXPECTED here and are counted, not failed: this suite feeds the module deliberate
 * rubbish, and a module that complains about rubbish is doing its job.
 *
 * ⚠ ERROR ATTRIBUTION IS RUN-WIDE, NOT PER-CASE, AND HERE IS WHY. The apply path defers its window
 * behind the presentation cap (fx/effects.js PRESENTATION_CAP_MS, 8 s), so work started by case N can
 * fault while case N+20 is on the clock. Per-case fault counts are therefore REPORTED as the earliest
 * observation rather than asserted, and the hard leg is the run-wide count after a final drain. The
 * data legs (2) and (3) are per-case and are asserted per-case: they read state, not timing.
 *
 * ⛔ ONE FAULT SIGNATURE IS THE ENGINE'S, NOT THIS MODULE'S — see ENGINE_RESIDUAL below. It is split
 * into its own bucket, counted informationally, and never scored as a module fault; the suite ALSO
 * arranges its own stage so it does not provoke it in the first place (§1's scene settle).
 *
 * §1 fixtures + the clean control · §2 the mutated emissions · §3 invariant probes on the pure rules ·
 * §4 the drain, the classification census and the restore.
 *
 * CONTAINMENT. Every document lives on this suite's own `__PW__` scene, so any region, template or
 * effect a mutation produces is deleted with the scene. No world setting is written.
 *
 * REPRODUCIBILITY. The mutation sample and every random probe input come from one seeded generator.
 * The seed is printed at the top of the run and can be pinned with FUZZ_SEED=<n> to replay a failure
 * exactly. FUZZ_ALL=1 drives the whole mutation space instead of the sampled budget.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=<pw> node tests/cp2020-augmented-seam-fuzz.mjs
 *      FUZZ_SEED=12345 node tests/cp2020-augmented-seam-fuzz.mjs        (replay a specific sample)
 *      FUZZ_ALL=1      node tests/cp2020-augmented-seam-fuzz.mjs        (every mutation, no sampling)
 */
import { chromium } from "@playwright/test";
import { GOLDEN, GOLDEN_MISSING, GOLDEN_PATH, installGoldenHydrator } from "./golden-payload.mjs";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";
const SEED = Number(process.env.FUZZ_SEED) || 20260818;
const FUZZ_ALL = process.env.FUZZ_ALL === "1";
const BUDGET = Number(process.env.FUZZ_BUDGET) || 96;
const SETTLE_MS = 300;
const HOUSEKEEP_EVERY = 8;

/* ── THE ONE FAULT THIS SUITE DOES NOT OWN ───────────────────────────────────────────────────────
 * `TypeError: Cannot set properties of null (setting 'volume')`, thrown from Sequencer's own
 * `CanvasEffect._createSprite` out of `_initialize` into an unheld promise. It is a THIRD-PARTY
 * RESIDUAL, established by measurement, not by argument:
 *
 *   · `import-staging/AUDIO-PAGEERROR-DIAGNOSIS.md` — the captured stack is TWO FRAMES, both inside
 *     `modules/sequencer/dist/sequencer.js`, with no module frame and no core frame. The word
 *     "volume" is a PIXI sprite property, not audio: a probe wrapping `AudioHelper.play` across the
 *     whole suite recorded 0 calls. The earlier attribution to `effects.js:2810` was a coincidence of
 *     text on that line, not a stack frame — an async stack tag pointing at whatever module line
 *     happened to be on the way in.
 *   · `module/fx/status-fx.js:663-685` — the mechanism and the residual, stated by the code that
 *     already defends against it: on EVERY scene load Sequencer's debounced setup runs
 *     `initializePersistentEffects → tearDownPersistentEffects`, destroying every live effect
 *     (measured arming as early as canvasReady+241 ms). An overlay still inside its ~860 ms asset
 *     load when that wipe lands is destroyed mid-`activate` and rethrows exactly this. The module's
 *     sweep was moved off `canvasReady` onto the engine's own `sequencerEffectManagerReady` signal
 *     for that reason, with `canvasReady + CANVAS_SWEEP_FALLBACK_MS` (3000) left as a late fallback
 *     for a host where the signal never comes. The comment states the remaining window honestly:
 *     "no registration order on our side can close that".
 *
 * ⭐ SO THIS SUITE DOES BOTH THINGS, AND THE SECOND IS THE IMPORTANT ONE. Classifying the signature
 * (below) stops it being scored as a module fault. But this suite's §1 CREATES A SCENE AND VIEWS IT,
 * which is precisely the documented trigger window — so the excuse alone would be an excuse. §1
 * therefore views its stage FIRST and waits out the documented settle (the engine's own
 * `sequencerEffectManagerReady`, or the fallback window if that signal never comes) BEFORE any fault
 * capture is armed, so the trigger is AVOIDED rather than merely forgiven. A residual that survives
 * both is reported as an engine residual with its count, and is not this module's verdict. */
const ENGINE_RESIDUAL_SRC = "Cannot set properties of null \\(setting 'volume'\\)";
const ENGINE_RESIDUAL = new RegExp(ENGINE_RESIDUAL_SRC);
/** How long to wait for the engine's post-scene-load wipe to finish before arming fault capture.
 *  The signal is `sequencerEffectManagerReady`; the ceiling covers status-fx.js's own
 *  CANVAS_SWEEP_FALLBACK_MS (3000) plus the measured ~860 ms overlay asset load, plus margin. */
const SEQ_SETTLE_CEILING_MS = 6000;
const SEQ_SETTLE_AFTER_SIGNAL_MS = 1500;

/** Deterministic 32-bit PRNG — the same one is re-created page-side from the same seed. */
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const checks = [];
const ok = (n, p, d = "") => {
  checks.push({ n, p: !!p, d: String(d) });
  console.log(`${p ? "  ok  " : "  FAIL"}  ${n}${d ? `   [${d}]` : ""}`);
};

async function joinGM(p) {
  await p.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const s = p.locator('select[name="userid"]');
  await s.waitFor({ state: "visible", timeout: 30000 });
  const us = await s.locator("option").evaluateAll(o => o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
  const u = us.find(x => /gamemaster/i.test(x.l));
  if (!u) throw new Error("no Gamemaster user on this rig");
  await s.selectOption(u.v);
  await p.locator('input[name="password"]').fill(PW);
  await Promise.all([
    p.waitForNavigation({ url: /\/game/, timeout: 45000 }).catch(() => {}),
    p.locator('button[name="join"]').click(),
  ]);
  await p.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 60000 });
}

/** Page-side fault recorder, installed before the client boots. Splits module-attributed logging out
 *  of core's, splits the engine residual out of BOTH, and keeps module warns as a COUNT — they are the
 *  expected voice of a clean refusal. `engineResiduals` is counted and reported, never scored. */
const RECORDER = (residualSrc) => {
  const residual = new RegExp(residualSrc);
  const rec = (globalThis.__cpFault = { uncaught: [], moduleErrors: [], otherErrors: [], warns: [], engineResiduals: [] });
  const text = (args) => args.map(a => (a && a.stack) ? String(a.stack) : String(a)).join(" ");
  const mine = (s) => /cp2020-augmented|CP2020 \|/.test(s);
  // ⛔ CLASSIFY BEFORE COUNTING. A fault matching the engine signature goes to its own bucket and is
  // never allowed into `uncaught`, whose count is what the verdict legs read.
  const takeUncaught = (s) => (residual.test(s) ? rec.engineResiduals : rec.uncaught).push(s);
  window.addEventListener("error", (e) => takeUncaught(String(e?.message ?? e)));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e?.reason;
    takeUncaught("unhandledrejection: " + String(r?.stack ?? r?.message ?? r));
  });
  const ce = console.error.bind(console);
  const cw = console.warn.bind(console);
  console.error = (...a) => {
    const s = text(a);
    (residual.test(s) ? rec.engineResiduals : mine(s) ? rec.moduleErrors : rec.otherErrors).push(s.slice(0, 400));
    ce(...a);
  };
  console.warn = (...a) => { const s = text(a); if (mine(s)) rec.warns.push(s.slice(0, 200)); cw(...a); };
  // The residual bucket is deliberately NOT reset per case: it is a run-wide informational census.
  globalThis.__cpFaultReset = () => { rec.uncaught.length = 0; rec.moduleErrors.length = 0; rec.warns.length = 0; };
};

/* ── the mutation space, built in node from the stored field types ───────────────────────────────
 * The golden fixture records the TYPE of every field the producer emits, so the wrong-type mutation
 * for each field is derived rather than guessed: a string field is handed a number, a number a string,
 * an array an object, and so on. The set of fields comes from the fixture too, so a producer that adds
 * a field starts being fuzzed on the next capture without this list being edited.
 */
function wrongValueFor(type) {
  switch (type) {
    case "string": return 1234567;
    case "number": return "not-a-number";
    case "boolean": return "yes";
    case "array": return { notAnArray: true };
    case "object": return "flattened";
    case "null": return { unexpectedlyPresent: true };
    default: return { unexpectedShape: true };
  }
}

function buildMutations(entry) {
  const types = entry?.types ?? {};
  const keys = Object.keys(types).sort();
  const perKey = [];
  for (const key of keys) {
    perKey.push({ id: `drop:${key}`, kind: "drop", key, note: "field absent" });
    perKey.push({ id: `null:${key}`, kind: "set", key, value: null, note: "field null" });
    perKey.push({ id: `type:${key}`, kind: "set", key, value: wrongValueFor(types[key]), note: `wrong type (was ${types[key]})` });
  }

  /* Named boundary cases — always driven, never sampled away. Each names a shape a real producer,
   * relay or macro has a way of emitting. */
  const named = [
    { id: "shape:empty-object", kind: "replace", value: {}, note: "a caller that emitted nothing but the hook name" },
    { id: "shape:attacker-only", kind: "replace", value: { attackerId: "@@ATTACKER@@" }, note: "one field and nothing else" },
    { id: "area:empty-map", kind: "merge", value: { areaDamages: {} }, note: "a resolved shot that landed nowhere" },
    { id: "area:empty-list", kind: "merge", value: { areaDamages: { Torso: [] } }, note: "a location with no entries" },
    { id: "area:zero", kind: "merge", value: { areaDamages: { Torso: [{ damage: 0 }] } }, note: "zero damage" },
    { id: "area:negative", kind: "merge", value: { areaDamages: { Torso: [{ damage: -50 }] } }, note: "negative damage" },
    { id: "area:huge", kind: "merge", value: { areaDamages: { Torso: [{ damage: 1e12 }] } }, note: "absurd damage" },
    { id: "area:string", kind: "merge", value: { areaDamages: { Torso: [{ damage: "twelve" }] } }, note: "damage as prose" },
    { id: "area:null-entry", kind: "merge", value: { areaDamages: { Torso: [{ damage: null }] } }, note: "damage null" },
    { id: "area:no-damage-key", kind: "merge", value: { areaDamages: { Torso: [{ damageHtml: "<b>x</b>" }] } }, note: "entry with no damage field" },
    { id: "area:unknown-location", kind: "merge", value: { areaDamages: { Elbow: [{ damage: 4 }] } }, note: "a location the tables do not carry" },
    { id: "area:many-locations", kind: "merge", value: { areaDamages: Object.fromEntries(["Head", "Torso", "rArm", "lArm", "rLeg", "lLeg"].map(k => [k, [{ damage: 3 }]])) }, note: "every location at once" },
    { id: "id:unknown-attacker", kind: "merge", value: { attackerId: "zzzzNoSuchActor" }, note: "an attacker nothing can resolve" },
    { id: "id:unknown-target-token", kind: "merge", value: { targetTokenId: "zzzzNoSuchToken", fxTargetTokenId: "zzzzNoSuchToken" }, note: "a target figure nothing can resolve" },
    { id: "id:unknown-weapon", kind: "merge", value: { weaponId: "zzzzNoSuchItem" }, note: "a weapon nothing can resolve" },
    { id: "id:unknown-user", kind: "merge", value: { firedByUserId: "zzzzNoSuchUser" }, note: "a firing seat nothing can resolve" },
    { id: "count:zero-shots", kind: "merge", value: { shotsFired: 0, shotsHit: 0 }, note: "a trigger pull with no rounds" },
    { id: "count:negative-shots", kind: "merge", value: { shotsFired: -5, shotsHit: -5 }, note: "negative rounds" },
    { id: "count:absurd-shots", kind: "merge", value: { shotsFired: 1000000, shotsHit: 1000000 }, note: "a million rounds" },
    { id: "count:more-hits-than-shots", kind: "merge", value: { shotsFired: 1, shotsHit: 999 }, note: "more hits than rounds" },
    { id: "count:fractional-shots", kind: "merge", value: { shotsFired: 2.5, shotsHit: 1.5 }, note: "fractional rounds" },
    { id: "num:infinite-total", kind: "merge", value: { attackTotal: Infinity, toHitDC: -Infinity }, note: "unbounded roll numbers" },
    { id: "num:negative-multipliers", kind: "merge", value: { penDamageMult: -3, armorMultSoft: -1, armorMultHard: 0 }, note: "negative and zero multipliers" },
    { id: "num:huge-multipliers", kind: "merge", value: { penDamageMult: 1e9, armorMultSoft: 1e9, armorMultHard: 1e9 }, note: "unbounded multipliers" },
    { id: "dot:absurd-turns", kind: "merge", value: { dotEnabled: true, dotTurns: 1e9, dotType: "fire", dotDamageFormula: "1d6" }, note: "a burn that never ends" },
    { id: "dot:bad-formula", kind: "merge", value: { dotEnabled: true, dotTurns: 2, dotType: "fire", dotDamageFormula: "not a formula" }, note: "an unparseable burn formula" },
    { id: "stun:absurd-mod", kind: "merge", value: { stunSaveOnHit: true, stunSaveMod: 1e6 }, note: "an unbounded save shift" },
    { id: "blast:radius-no-type", kind: "merge", value: { blastRadius: 500, blastFullDamageWithin: 400 }, note: "a blast radius with no blast declared" },
    { id: "blast:inverted-bands", kind: "merge", value: { effectTypes: ["Explosive"], blastRadius: 4, blastFullDamageWithin: 900, blastMultipliers: [] }, note: "inner band wider than the whole blast" },
    { id: "blast:bad-multipliers", kind: "merge", value: { effectTypes: ["Explosive"], blastRadius: 6, blastMultipliers: ["half", null, -1] }, note: "unusable falloff ladder" },
    { id: "spread:pattern-no-widths", kind: "merge", value: { spreadMode: "buck", caliber: "12ga", spreadWidthShort: 0, spreadWidthMedium: -2, spreadWidthLong: "wide" }, note: "a pattern with no usable widths" },
    { id: "spread:unknown-mode", kind: "merge", value: { spreadMode: "kaleidoscope" }, note: "a pattern mode nothing implements" },
    { id: "cal:unknown-caliber", kind: "merge", value: { caliber: "42mm Imaginary", modifier: "unobtanium" }, note: "a cartridge and a load nothing carries" },
    { id: "type:effectTypes-strings", kind: "merge", value: { effectTypes: "Explosive" }, note: "the effect list as a bare string" },
  ];

  return { perKey, named, keys };
}

/* ── page-side helpers, kept as source strings so both the emission and the scan share them ────── */
const PAGE_HELPERS = () => {
  /** Every non-finite number, and (when asked) every explicitly-undefined leaf, under an object. */
  globalThis.__cpScan = (root, { flagUndefined = false, label = "system" } = {}) => {
    const bad = [];
    const seen = new WeakSet();
    const walk = (v, path, depth) => {
      if (bad.length >= 12 || depth > 8) return;
      if (typeof v === "number") { if (!Number.isFinite(v)) bad.push(`${path}=${v}`); return; }
      if (v === undefined) { if (flagUndefined) bad.push(`${path}=undefined`); return; }
      if (v === null || typeof v !== "object") return;
      if (seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) walk(v[i], `${path}[${i}]`, depth + 1); return; }
      for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`, depth + 1);
    };
    walk(root, label, 0);
    return bad;
  };
  /** One reading of a fixture actor: stored data, derived data, and the accumulated damage number. */
  globalThis.__cpRead = (actorId) => {
    const a = game.actors.get(actorId);
    if (!a) return { missing: true };
    let stored = [];
    try { stored = globalThis.__cpScan(a.toObject().system, { flagUndefined: true, label: "stored" }); }
    catch (e) { stored = [`stored-scan-threw: ${String(e).slice(0, 80)}`]; }
    let derived = [];
    try { derived = globalThis.__cpScan(a.system, { flagUndefined: false, label: "derived" }); }
    catch (e) { derived = [`derived-scan-threw: ${String(e).slice(0, 80)}`]; }
    const dmg = a.system?.damage;
    return { stored, derived, damage: typeof dmg === "number" ? dmg : Number(dmg), damageRaw: String(dmg) };
  };
  /**
   * ⭐ THE COMMITMENT STAMP, READ ONE TURN LATE — AND THAT DELAY IS THE POINT.
   *
   * `damage-hooks.js:545` sets `payload.handled = "cp2020-augmented"` when this layer commits to
   * applying the shot, and its own comment there calls the write synchronous. It is NOT: the listener
   * awaits `_maybeBreakMonoWeapon(payload, attackerActor)` at line 539 — an async function, so the
   * listener suspends there and resumes in a MICROTASK — and only then reaches the stamp. `Hooks.callAll`
   * is synchronous and returns to its caller before any microtask drains, so a stamp read in the same
   * turn as the emission reads the payload BEFORE the module has had a chance to write it, and reports
   * "declined" for a shot the module went on to take up. Measured on :30004 with a complete golden
   * payload, every gate satisfied and the apply window opening normally:
   *
   *     read with zero yields  → handled = (absent)
   *     after one microtask    → handled = "cp2020-augmented"
   *
   * So the read yields first. The poll (rather than a single yield) is deliberate: it does not depend
   * on HOW MANY microtasks the module's pre-stamp awaits happen to cost, so a future edit that adds
   * another await ahead of line 545 cannot silently turn every emission back into a false "declined".
   * The budget is small — a refusal is decided in the same handful of turns as a commitment, and the
   * per-case settle that follows is the slow clock, not this.
   */
  globalThis.__cpAwaitStamp = async (payload, { turns = 8 } = {}) => {
    for (let i = 0; i < turns; i++) {
      if (payload.handled === "cp2020-augmented") return true;
      await new Promise(r => setTimeout(r, 0));
    }
    return payload.handled === "cp2020-augmented";
  };
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const nodeErrors = [];
const nodeEngineResiduals = [];
// The same split on the node side: Playwright's own `pageerror` sees the identical throw, so without
// this the classification would hold page-side and leak through the node-side channel instead.
page.on("pageerror", (e) => {
  const s = String(e.message);
  (ENGINE_RESIDUAL.test(s) ? nodeEngineResiduals : nodeErrors).push(s);
});
await page.addInitScript(RECORDER, ENGINE_RESIDUAL_SRC);
await joinGM(page);
await page.waitForTimeout(2500);
await page.evaluate(PAGE_HELPERS);

console.log(`\n===== seam fuzz · seed ${SEED}${FUZZ_ALL ? " · FULL SPACE" : ` · budget ${BUDGET}`} =====`);

let fixtures = null;

try {
  /* ══ §1. FIXTURES + THE CLEAN CONTROL ══════════════════════════════════════════════════════════ */
  console.log("\n===== §1: fixtures and the clean control =====");
  ok("§1 the golden fired-shot fixture is on disk to mutate from",
    !GOLDEN_MISSING && !!GOLDEN?.modes?.singleShot,
    GOLDEN_MISSING ? `missing at ${GOLDEN_PATH} — run cp2020-augmented-golden-payload-capture.mjs`
                   : `producer=${GOLDEN.producer} captured=${GOLDEN.capturedAt}`);
  if (GOLDEN_MISSING) throw new Error("no golden fixture to mutate");
  await installGoldenHydrator(page);

  const entry = GOLDEN.modes.singleShot;
  const { perKey, named, keys } = buildMutations(entry);
  ok("§1 the mutation space was derived from the stored field set, not a hand-written list",
    keys.length >= 30 && perKey.length === keys.length * 3,
    `${keys.length} field(s) × 3 mutations = ${perKey.length}, plus ${named.length} named boundary case(s)`);

  fixtures = await page.evaluate(async ({ ceiling, afterSignal }) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (const s of game.scenes.filter(s => s.name === "__PW__Fuzz Stage")) await s.delete().catch(() => {});
    for (const a of game.actors.filter(a => /^__PW__FUZZ/.test(a.name))) await a.delete().catch(() => {});

    const shooter = await Actor.create({ name: "__PW__FUZZ Shooter", type: "character" });
    const target = await Actor.create({ name: "__PW__FUZZ Target", type: "character" });
    const bystander = await Actor.create({ name: "__PW__FUZZ Bystander", type: "character" });
    const [gun] = await shooter.createEmbeddedDocuments("Item", [{
      name: "__PW__FUZZ Sidearm", type: "weapon",
      system: { ammoType: "10mm", shots: 8, shotsLeft: 8, damage: "2d6+1", range: 50 },
    }]);
    // Which canvas this client was looking at before the suite took it over; `view()` is client-local,
    // so this is put back at teardown rather than left showing a scene that no longer exists.
    const priorSceneId = canvas?.scene?.id ?? null;
    /* ⭐ THE LATCH IS ARMED BEFORE THE SCENE EXISTS, not after it is drawn. `sequencerEffectManagerReady`
     * is the engine's own "the scene-load wipe is finished" signal, fired at the tail of
     * initializePersistentEffects (status-fx.js:663-693). Registering it after `view()` would be a race
     * against the very thing being waited for. */
    let seqReadyAt = null;
    const onSeqReady = () => { if (seqReadyAt === null) seqReadyAt = Date.now(); };
    Hooks.on("sequencerEffectManagerReady", onSeqReady);
    const scene = await Scene.create({
      name: "__PW__Fuzz Stage", width: 2000, height: 2000, padding: 0,
      grid: { size: 100, distance: 2, units: "m" },
    });
    const made = await scene.createEmbeddedDocuments("Token", [
      { name: "__PW__FUZZ Shooter", actorId: shooter.id, actorLink: true, x: 300, y: 300, width: 1, height: 1 },
      { name: "__PW__FUZZ Target", actorId: target.id, actorLink: true, x: 900, y: 300, width: 1, height: 1 },
      { name: "__PW__FUZZ Bystander", actorId: bystander.id, actorLink: true, x: 1000, y: 400, width: 1, height: 1 },
    ]);
    const byName = Object.fromEntries(made.map(t => [t.name, t.id]));
    await scene.view();
    for (let i = 0; i < 80 && !(canvas?.ready && canvas.scene?.id === scene.id); i++) {
      await sleep(200);
    }
    /* ⛔ AND NOW WAIT THE WIPE OUT, BEFORE ANY FAULT CAPTURE IS ARMED. Viewing a scene arms Sequencer's
     * debounced setup, which tears down every live effect; an overlay still inside its asset load when
     * that lands is destroyed mid-activate and rethrows the engine residual (AUDIO-PAGEERROR-DIAGNOSIS,
     * status-fx.js:663-685). The control below is the first thing that resets and reads the fault
     * buckets, so the whole trigger window is spent HERE, outside anything the run scores. */
    const t0 = Date.now();
    while (seqReadyAt === null && Date.now() - t0 < ceiling) await sleep(100);
    const signalled = seqReadyAt !== null;
    Hooks.off("sequencerEffectManagerReady", onSeqReady);
    // After the signal the wipe is done, but an effect it just destroyed can still be unwinding; the
    // margin covers that. With no signal at all (no Sequencer, or a version without the hook) the
    // ceiling has already outlasted status-fx.js's own 3 s canvasReady fallback.
    if (signalled) await sleep(afterSignal);
    return {
      sceneId: scene.id, priorSceneId, sceneDrawn: canvas?.ready === true && canvas.scene?.id === scene.id,
      seqSignalled: signalled, seqWaitedMs: Date.now() - t0,
      shooterId: shooter.id, targetId: target.id, bystanderId: bystander.id, weaponId: gun.id,
      shooterTokenId: byName["__PW__FUZZ Shooter"] ?? null,
      targetTokenId: byName["__PW__FUZZ Target"] ?? null,
      bystanderTokenId: byName["__PW__FUZZ Bystander"] ?? null,
      baselineCards: game.messages.size,
    };
  }, { ceiling: SEQ_SETTLE_CEILING_MS, afterSignal: SEQ_SETTLE_AFTER_SIGNAL_MS });

  ok("§1 the suite's own stage is drawn with all three fixture figures on it",
    fixtures.sceneDrawn === true && !!fixtures.shooterTokenId && !!fixtures.targetTokenId && !!fixtures.bystanderTokenId,
    `scene=${fixtures.sceneId}`);
  // Not a verdict on the module — a statement of whether the run avoided the engine's trigger window or
  // merely outlasted it. A run that never saw the signal is still valid; it waited the ceiling instead.
  ok("§1 the stage was drawn and the engine's scene-load wipe was waited out before any fault capture",
    fixtures.seqWaitedMs >= 0,
    fixtures.seqSignalled
      ? `sequencerEffectManagerReady after ${fixtures.seqWaitedMs} ms, then a ${SEQ_SETTLE_AFTER_SIGNAL_MS} ms margin`
      : `no sequencerEffectManagerReady within ${SEQ_SETTLE_CEILING_MS} ms — waited the ceiling instead`);

  const watched = [fixtures.shooterId, fixtures.targetId, fixtures.bystanderId];
  const baselineRead = await page.evaluate((ids) => ids.map(id => globalThis.__cpRead(id)), watched);
  ok("§1 the fixtures start with no unusable number anywhere in their data",
    baselineRead.every(r => !r.missing && r.stored.length === 0 && r.derived.length === 0
      && Number.isFinite(r.damage)),
    baselineRead.map((r, i) => `${["shooter", "target", "bystander"][i]}: stored=${r.stored.length} derived=${r.derived.length} dmg=${r.damageRaw}`).join(" · "));

  /* THE CONTROL, and the vacuity guard for the whole suite. An unmutated payload is put through the
   * same seam the mutations use; if the module does not visibly react to THAT, every clean verdict
   * below is a verdict on code that never ran. The wait is the presentation cap plus a margin,
   * because the apply window is deferred behind it. */
  const control = await page.evaluate(async (fx) => {
    globalThis.__cpFaultReset();
    const cardsBefore = game.messages.size;
    const payload = globalThis.__goldenPayload("singleShot", {
      attackerId: fx.shooterId, attackerTokenId: fx.shooterTokenId, weaponId: fx.weaponId,
      targetTokenId: fx.targetTokenId, targetActorId: fx.targetId, firedByUserId: game.user.id,
    }, { targetTokenId: fx.targetTokenId, fxTargetTokenId: fx.targetTokenId });
    globalThis.__cpBasePayloadKeys = Object.keys(payload).length;
    Hooks.callAll("cyberpunk2020.weaponFired", payload);
    const claimed = await globalThis.__cpAwaitStamp(payload);
    let dialogs = 0;
    for (let i = 0; i < 60; i++) {
      dialogs = [...foundry.applications.instances.values()].filter(a => /DamageDialog/.test(a?.constructor?.name ?? "")).length;
      if (dialogs > 0) break;
      await new Promise(r => setTimeout(r, 300));
    }
    const cards = game.messages.size - cardsBefore;
    for (const a of [...foundry.applications.instances.values()]) {
      if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
    }
    try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none */ }
    await new Promise(r => setTimeout(r, 600));
    const f = globalThis.__cpFault;
    return { claimed, dialogs, cards, payloadKeys: globalThis.__cpBasePayloadKeys, uncaught: f.uncaught.slice(0, 2), moduleErrors: f.moduleErrors.slice(0, 2) };
  }, fixtures);

  ok("§1 the clean control payload reaches the module and it takes the job",
    control.claimed === true, `handled stamp=${control.claimed}`);
  ok("§1 and it carries that job all the way to a visible apply window",
    control.dialogs > 0 || control.cards > 0,
    `apply window(s)=${control.dialogs} card(s)=${control.cards} — if both are zero every verdict below is vacuous`);
  ok("§1 the clean control raises no fault",
    control.uncaught.length === 0 && control.moduleErrors.length === 0,
    [...control.uncaught, ...control.moduleErrors].join(" | ") || "none");
  ok("§1 the payload the mutations start from carries the producer's full field set",
    control.payloadKeys >= 30, `${control.payloadKeys} field(s)`);

  /* ══ §2. THE MUTATED EMISSIONS ═════════════════════════════════════════════════════════════════ */
  const rand = mulberry32(SEED);
  let sampled = perKey;
  if (!FUZZ_ALL) {
    const want = Math.max(0, BUDGET - named.length);
    const pool = perKey.slice();
    for (let i = pool.length - 1; i > 0; i--) {                 // seeded Fisher-Yates
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    sampled = pool.slice(0, want).sort((a, b) => a.id.localeCompare(b.id));
  }
  const cases = [...named, ...sampled];
  console.log(`\n===== §2: ${cases.length} mutated emission(s) (${named.length} named + ${sampled.length} sampled of ${perKey.length}) =====`);

  const results = [];
  let prevDamage = baselineRead.map(r => r.damage);

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const nodeBefore = nodeErrors.length;
    const r = await page.evaluate(async ({ fx, c, settle, ids }) => {
      globalThis.__cpFaultReset();
      const notified = [];
      const notif = ui.notifications;
      const ow = notif.warn.bind(notif);
      const oe = notif.error.bind(notif);
      notif.warn = (m, o) => { notified.push(String(m)); return ow(m, o); };
      notif.error = (m, o) => { notified.push(String(m)); return oe(m, o); };
      const cardsBefore = game.messages.size;
      const out = { id: c.id };
      try {
        let payload;
        if (c.kind === "replace") {
          payload = JSON.parse(JSON.stringify(c.value));
          if (payload.attackerId === "@@ATTACKER@@") payload.attackerId = fx.shooterId;
        } else {
          payload = globalThis.__goldenPayload("singleShot", {
            attackerId: fx.shooterId, attackerTokenId: fx.shooterTokenId, weaponId: fx.weaponId,
            targetTokenId: fx.targetTokenId, targetActorId: fx.targetId, firedByUserId: game.user.id,
          }, { targetTokenId: fx.targetTokenId, fxTargetTokenId: fx.targetTokenId });
          if (c.kind === "drop") delete payload[c.key];
          else if (c.kind === "set") payload[c.key] = c.value;
          else if (c.kind === "merge") Object.assign(payload, c.value);
        }
        Hooks.callAll("cyberpunk2020.weaponFired", payload);
        // ⭐ THE MODULE'S OWN COMMITMENT MARK, and the reason this suite can tell "it did the job" from
        // "it declined" within a fraction of a second: damage-hooks.js:545 stamps `handled` onto the
        // payload the moment this layer commits to applying the shot. The apply WINDOW is deferred
        // several seconds behind the presentation cap, so waiting for THAT would cost eight seconds per
        // emission and still only observe one of the paths; reading the stamp reads the decision itself.
        // The stamp lands a microtask after the emission, not in the same turn — see __cpAwaitStamp.
        out.claimed = await globalThis.__cpAwaitStamp(payload);
        out.emitted = true;
      } catch (err) {
        // A throw that escapes Hooks.callAll into THIS frame is the loudest possible failure and is
        // recorded as such rather than being allowed to abort the run.
        out.emitted = false;
        out.threw = String(err?.stack ?? err).slice(0, 300);
      }
      await new Promise(r2 => setTimeout(r2, settle));
      notif.warn = ow;
      notif.error = oe;
      const f = globalThis.__cpFault;
      return {
        ...out,
        reads: ids.map(id => globalThis.__cpRead(id)),
        cards: game.messages.size - cardsBefore,
        notified: notified.length,
        warns: f.warns.length,
        uncaught: f.uncaught.slice(0, 2),
        moduleErrors: f.moduleErrors.slice(0, 2),
      };
    }, { fx: fixtures, c, settle: SETTLE_MS, ids: watched });

    const damages = r.reads.map(x => x.damage);
    const nanFindings = r.reads.flatMap((x, k) => [...x.stored, ...x.derived].map(s => `${["shooter", "target", "bystander"][k]} ${s}`));
    const damageSane = damages.every((d, k) => Number.isFinite(d) && d >= prevDamage[k]);
    const applied = r.claimed || r.cards > 0 || damages.some((d, k) => d !== prevDamage[k]);
    const spoke = r.notified > 0 || r.warns > 0;
    const outcome = !damageSane || nanFindings.length ? "HALF-WRITE"
      : applied ? "taken-up" : spoke ? "declined-aloud" : "declined-quietly";
    const faulted = r.uncaught.length > 0 || r.moduleErrors.length > 0 || !!r.threw
      || nodeErrors.length > nodeBefore;

    results.push({ ...c, r, outcome, damageSane, nanFindings, faulted, applied, spoke });
    prevDamage = damages;

    if (outcome === "HALF-WRITE" || faulted) {
      console.log(`  FAIL  case ${String(i).padStart(3, "0")} ${c.id}  (${c.note})`
        + `  outcome=${outcome}`
        + (nanFindings.length ? `  UNUSABLE: ${nanFindings.slice(0, 3).join(", ")}` : "")
        + (r.threw ? `  THREW ${r.threw.split("\n")[0]}` : "")
        + (r.uncaught.length ? `  UNCAUGHT ${r.uncaught[0].slice(0, 140)}` : "")
        + (r.moduleErrors.length ? `  MODULE-ERR ${r.moduleErrors[0].slice(0, 140)}` : ""));
    }

    if ((i + 1) % HOUSEKEEP_EVERY === 0 || i === cases.length - 1) {
      await page.evaluate(async (baseline) => {
        for (const a of [...foundry.applications.instances.values()]) {
          if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
        }
        try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none */ }
        for (const m of [...game.messages].slice(baseline)) { try { await m.delete(); } catch (e) { /* gone */ } }
        await new Promise(r => setTimeout(r, 400));
      }, fixtures.baselineCards).catch(() => {});
      // Cards were just swept, so the "applied" reading has to restart from the swept state.
      prevDamage = (await page.evaluate((ids) => ids.map(id => globalThis.__cpRead(id).damage), watched));
    }
  }

  const halfWrites = results.filter(x => x.outcome === "HALF-WRITE");
  const faults = results.filter(x => x.faulted);
  const census = results.reduce((m, x) => { m[x.outcome] = (m[x.outcome] ?? 0) + 1; return m; }, {});

  console.log("");
  ok("§2 every mutated emission was delivered to the seam without escaping into the caller",
    results.every(x => x.r.emitted && !x.r.threw),
    results.filter(x => x.r.threw).map(x => `${x.id}: ${x.r.threw.split("\n")[0]}`).slice(0, 3).join(" | ") || `${results.length} delivered`);
  ok("§2 no mutated emission left an unusable number in any fixture's data",
    results.every(x => x.nanFindings.length === 0),
    halfWrites.length || results.some(x => x.nanFindings.length)
      ? results.filter(x => x.nanFindings.length).map(x => `${x.id} → ${x.nanFindings.slice(0, 2).join(", ")}`).slice(0, 3).join(" | ")
      : `${results.length} emission(s), every fixture still readable`);
  ok("§2 accumulated damage stayed a finite, never-decreasing number through every emission",
    results.every(x => x.damageSane),
    results.filter(x => !x.damageSane).map(x => x.id).slice(0, 4).join(", ") || "monotone throughout");
  ok("§2 every emission ended taken up, refused aloud, or declined without changing anything",
    halfWrites.length === 0,
    Object.entries(census).map(([k, v]) => `${k}=${v}`).join(" · ")
      + (halfWrites.length ? ` — HALF-WRITES: ${halfWrites.map(x => x.id).slice(0, 4).join(", ")}` : ""));
  // ⛔ THE CENSUS IS HALF THE LEG. A run in which every emission was declined early would satisfy all
  // three legs above while proving only that the guards return at the door — the module has to be
  // shown still TAKING UP the payloads that remain usable, and still declining the ones that do not.
  // Both populations must be non-empty or the fuzz is measuring nothing but a closed gate.
  ok("§2 the emissions split across real outcomes rather than all being refused at the door",
    (census["taken-up"] ?? 0) > 0 && ((census["declined-aloud"] ?? 0) + (census["declined-quietly"] ?? 0)) > 0,
    Object.entries(census).map(([k, v]) => `${k}=${v}`).join(" · "));
  ok("§2 the module complained where it should — refusals were voiced, not swallowed wholesale",
    results.some(x => x.spoke),
    `${results.filter(x => x.spoke).length} emission(s) raised a notice or a module warning`);
  ok("§2 no mutated emission produced a fault attributed to this module",
    faults.length === 0,
    faults.map(x => `${x.id}: ${(x.r.uncaught[0] ?? x.r.moduleErrors[0] ?? x.r.threw ?? "node-side").slice(0, 120)}`).slice(0, 3).join(" | ") || "none");

  /* ══ §3. INVARIANT PROBES ON THE PURE RULES ════════════════════════════════════════════════════ */
  console.log("\n===== §3: invariant probes on the pure rules =====");
  const probe = await page.evaluate(async ({ scope, seed }) => {
    const out = [];
    const add = (name, pass, got = "") => out.push({ name, pass: !!pass, got: String(got) });
    const rng = (a => () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    })(seed);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const junkChars = "abcXYZ 0123.,-/\\\"'()[]{}—• *#";
    const junkString = () => {
      let s = "";
      const n = 1 + Math.floor(rng() * 14);
      for (let i = 0; i < n; i++) s += junkChars[Math.floor(rng() * junkChars.length)];
      return s;
    };
    const wildNumber = () => pick([0, -1, 1, 0.5, -0.5, 1e9, -1e9, NaN, Infinity, -Infinity,
      Math.floor(rng() * 200) - 100, rng() * 1000]);
    const wildAny = () => pick([undefined, null, "", junkString(), wildNumber(), true, false, {}, [], { a: 1 }]);

    const H = await import(`/modules/${scope}/module/combat/damage-hooks.js`);
    const L = await import(`/modules/${scope}/module/lookups.js`);
    const U = await import(`/modules/${scope}/module/utils.js`);
    const SU = await import("/systems/cyberpunk2020/module/utils.js");

    /* ── the wall clock ─────────────────────────────────────────────────────────────────────────
     * The rule is a threshold on elapsed time, so the property that matters is MONOTONICITY: a
     * pattern that has outlived its welcome cannot become fresh again by the clock advancing. */
    {
      let breaks = 0, sampleBreak = "";
      for (let i = 0; i < 300; i++) {
        const createdAt = Math.floor(rng() * 4e12);
        const ttlMs = 1 + Math.floor(rng() * 200000);
        const t0 = createdAt + Math.floor(rng() * 400000) - 100000;
        const t1 = t0 + Math.floor(rng() * 200000);
        const a = H.spreadZoneClockExpired({ createdAt }, { now: t0, ttlMs });
        const b = H.spreadZoneClockExpired({ createdAt }, { now: t1, ttlMs });
        if (a && !b) { breaks++; if (!sampleBreak) sampleBreak = `createdAt=${createdAt} ttl=${ttlMs} ${t0}→${t1}`; }
      }
      add("clock: once a pattern has outlived its welcome, a later reading never un-expires it",
        breaks === 0, breaks ? `${breaks}/300 reversals, e.g. ${sampleBreak}` : "300 ordered pairs, no reversal");
    }
    {
      const t = 1000000;
      const ttlMs = 60000;
      add("clock: the threshold is inclusive — elapsed exactly equal to the window is expired",
        H.spreadZoneClockExpired({ createdAt: t }, { now: t + ttlMs, ttlMs }) === true, "elapsed === ttl");
      add("clock: one millisecond short of the window is not expired (the negative beside it)",
        H.spreadZoneClockExpired({ createdAt: t }, { now: t + ttlMs - 1, ttlMs }) === false, "elapsed === ttl-1");
      add("clock: a window of zero expires everything that is not in a running encounter",
        H.spreadZoneClockExpired({ createdAt: t }, { now: t, ttlMs: 0 }) === true, "ttl 0");
    }
    {
      let leaks = 0;
      for (let i = 0; i < 200; i++) {
        if (H.spreadZoneClockExpired({ createdAt: Math.floor(rng() * 4e12) },
          { encounterRunning: true, now: Math.floor(rng() * 4e12), ttlMs: 1 }) !== false) leaks++;
      }
      add("clock: a pattern inside a running encounter is never the wall clock's to collect",
        leaks === 0, leaks ? `${leaks}/200 collected anyway` : "200 probes, none collected");
    }
    add("clock: a pattern with no timestamp reads as ancient, so a littered world can tidy itself",
      H.spreadZoneClockExpired({}, { now: Date.now(), ttlMs: 60000 }) === true, "no createdAt");
    {
      let bad = 0, sample = "";
      for (let i = 0; i < 200; i++) {
        const flags = pick([wildAny(), { createdAt: wildAny() }, { createdAt: junkString() }]);
        try {
          const v = H.spreadZoneClockExpired(flags, { now: wildNumber(), ttlMs: wildNumber() });
          if (typeof v !== "boolean") { bad++; if (!sample) sample = `${JSON.stringify(flags)} → ${String(v)}`; }
        } catch (e) { bad++; if (!sample) sample = `${JSON.stringify(flags)} threw ${String(e).slice(0, 60)}`; }
      }
      add("clock: unusable input still yields a plain yes or no, never a throw",
        bad === 0, bad ? `${bad}/200 — ${sample}` : "200 unusable inputs, all answered");
    }
    add("clock: the default window is the exported constant rather than an inlined number",
      H.spreadZoneClockExpired({ createdAt: Date.now() - H.SPREAD_ZONE_TTL_MS }, {}) === true
      && H.spreadZoneClockExpired({ createdAt: Date.now() }, {}) === false,
      `SPREAD_ZONE_TTL_MS=${H.SPREAD_ZONE_TTL_MS}`);

    /* ── the round rule ─────────────────────────────────────────────────────────────────────── */
    add("round: a pattern that records no encounter is not the round rule's business",
      H.spreadZoneRoundExpired({ createdRound: 1 }, { id: "abc", round: 99 }) === false, "no combatId");
    add("round: another encounter's round advance never expires this one's pattern",
      H.spreadZoneRoundExpired({ combatId: "abc", createdRound: 1 }, { id: "xyz", round: 99 }) === false, "foreign encounter");
    add("round: its own encounter moving past the round it was thrown on expires it",
      H.spreadZoneRoundExpired({ combatId: "abc", createdRound: 3 }, { id: "abc", round: 4 }) === true, "round 4 > 3");
    add("round: still on the round it was thrown on, it stays (the negative beside it)",
      H.spreadZoneRoundExpired({ combatId: "abc", createdRound: 3 }, { id: "abc", round: 3 }) === false, "round 3 === 3");
    {
      let bad = 0;
      for (let i = 0; i < 200; i++) {
        try {
          const v = H.spreadZoneRoundExpired(pick([wildAny(), { combatId: wildAny(), createdRound: wildAny() }]),
            pick([wildAny(), { id: wildAny(), round: wildAny() }]));
          if (typeof v !== "boolean") bad++;
        } catch (e) { bad++; }
      }
      add("round: unusable input still yields a plain yes or no, never a throw", bad === 0, `${bad}/200 bad`);
    }

    /* ── the cartridge name resolver ────────────────────────────────────────────────────────────
     * Read the RATIFIED SPELLINGS out of the served source rather than restating them here, so the
     * probe covers whatever the module actually ships and cannot drift away from it. */
    let spellings = [];
    try {
      const src = await (await fetch(`/modules/${scope}/module/lookups.js`, { cache: "no-store" })).text();
      const start = src.indexOf("const CALIBER_ALIASES");
      const end = src.indexOf("export function normalizeCaliber");
      spellings = [...src.slice(start, end).matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)].map(m => m[1]);
    } catch (e) { spellings = []; }
    const registry = Object.keys(L.CALIBERS);
    const garbage = Array.from({ length: 40 }, () => junkString());
    const corpus = [...spellings, ...registry, ...garbage, "", "   ", "\t"];

    add("cartridge: the ratified spellings were read off the served source",
      spellings.length >= 40, `${spellings.length} spelling(s) parsed · ${registry.length} registry id(s)`);
    {
      const drifted = corpus.filter(s => L.normalizeCaliber(L.normalizeCaliber(s)) !== L.normalizeCaliber(s));
      add("cartridge: resolving an already-resolved name changes nothing (it settles in one pass)",
        drifted.length === 0, drifted.length ? `${drifted.length}, e.g. ${JSON.stringify(drifted.slice(0, 3))}` : `${corpus.length} name(s) settled`);
    }
    {
      const notString = corpus.concat([null, undefined, 5, {}, []]).filter(s => typeof L.normalizeCaliber(s) !== "string");
      add("cartridge: the answer is always a name, never nothing", notString.length === 0, `${notString.length} non-string answer(s)`);
    }
    add("cartridge: blank in, blank out",
      L.normalizeCaliber("") === "" && L.normalizeCaliber("   ") === "" && L.normalizeCaliber(null) === "" && L.normalizeCaliber(undefined) === "",
      "blank / spaces / null / absent");
    {
      const unresolved = spellings.filter(s => !registry.includes(L.normalizeCaliber(s)));
      add("cartridge: every ratified spelling resolves to a cartridge the registry actually carries",
        unresolved.length === 0,
        unresolved.length ? `${unresolved.length}: ${unresolved.slice(0, 4).map(s => `${s}→${L.normalizeCaliber(s)}`).join(", ")}`
                          : `${spellings.length} spelling(s) land in the registry`);
    }
    add("cartridge: a load with no cartridge stated fits any chamber (the wildcard)",
      registry.every(c => L.caliberMatches(c, "") === true), `${registry.length} chamber(s)`);
    // ⭐ THE PROPERTY, NOT THE IMPLEMENTATION. Restating "matches iff both names resolve alike" would
    // just be the function's own body written twice — green by construction, and blind to the defect
    // this rule exists to prevent. The two claims worth making are the ones a player would notice: a
    // round spelled ANY ratified way still chambers in the weapon that takes it, and two genuinely
    // different cartridges never chamber in each other.
    {
      const wrong = spellings.filter(s => {
        const canonical = L.normalizeCaliber(s);
        return registry.includes(canonical) && L.caliberMatches(canonical, s) !== true;
      });
      add("cartridge: a round spelled any ratified way still chambers in the weapon that takes it",
        wrong.length === 0, wrong.length ? `${wrong.length}: ${wrong.slice(0, 4).join(", ")}` : `${spellings.length} spelling(s) chamber`);
    }
    {
      const crossFits = [];
      for (const w of registry) {
        for (const a of registry) {
          if (w === a) continue;
          if (L.caliberMatches(w, a) === true) crossFits.push(`${a} → ${w}`);
        }
      }
      add("cartridge: two different cartridges never chamber in each other (the negative beside it)",
        crossFits.length === 0,
        crossFits.length ? `${crossFits.length}: ${crossFits.slice(0, 4).join(", ")}` : `${registry.length}×${registry.length - 1} cross pairs refused`);
    }
    {
      let bad = 0;
      for (let i = 0; i < 200; i++) { try { if (typeof L.caliberFamily(wildAny()) !== "string") bad++; } catch (e) { bad++; } }
      add("cartridge: the family lookup answers with a name for anything at all", bad === 0, `${bad}/200 bad`);
    }
    add("cartridge: every registry cartridge has a non-empty family",
      registry.every(c => (L.caliberFamily(c) ?? "").length > 0), `${registry.length} cartridge(s)`);

    /* ── the pattern derivation ─────────────────────────────────────────────────────────────── */
    {
      const modes = new Set([L.SPREAD_MODE_SINGLE, L.SPREAD_MODE_BUCK, L.SPREAD_MODE_SLUG]);
      let off = 0, sample = "";
      for (let i = 0; i < 200; i++) {
        const arg = { spreadMode: pick([...modes, wildAny()]), caliber: pick(corpus), modifier: pick([...Object.keys(L.AMMO_MODIFIERS), wildAny()]) };
        let v;
        try { v = L.spreadModeForAmmo(arg); } catch (e) { off++; continue; }
        if (typeof v !== "string" || !v.length) { off++; if (!sample) sample = JSON.stringify(arg); }
      }
      add("pattern: the round's mode always resolves to a named mode, never to nothing",
        off === 0, off ? `${off}/200 — ${sample}` : "200 rounds named");
    }
    add("pattern: a slug never throws a pattern, however it is declared",
      L.spreadModeForAmmo({ spreadMode: "slug", caliber: "12ga" }) === L.SPREAD_MODE_SINGLE
      && L.spreadModeForAmmo({ modifier: "slug", caliber: "12ga" }) === L.SPREAD_MODE_SINGLE, "both declaration routes");
    add("pattern: a shotgun cartridge with nothing declared does throw one (the positive beside it)",
      L.spreadModeForAmmo({ caliber: "12ga" }) === L.SPREAD_MODE_BUCK, "12ga → buck");
    {
      let bad = 0;
      for (let i = 0; i < 200; i++) {
        try { const v = L.spreadFlowModeOf(pick([wildAny(), { spreadMode: wildAny(), caliber: pick(corpus), modifier: wildAny() }]));
          if (typeof v !== "string" || !v.length) bad++; } catch (e) { bad++; }
      }
      add("pattern: which flow owns a fired payload always answers, whatever the payload looks like",
        bad === 0, `${bad}/200 bad`);
    }
    {
      let bad = 0, sample = "";
      for (let i = 0; i < 300; i++) {
        const args = [wildNumber(), { short: wildAny(), medium: wildAny(), long: wildAny() }, pick([null, wildNumber()])];
        let v;
        try { v = L.spreadBandSpec(...args); } catch (e) { bad++; continue; }
        if (!["Short", "Medium", "Long"].includes(v?.band) || !Number.isFinite(v?.widthM) || v.widthM <= 0) {
          bad++; if (!sample) sample = `${JSON.stringify(args)} → ${JSON.stringify(v)}`;
        }
      }
      add("pattern: the corridor is always one of the three bands and always has a usable width",
        bad === 0, bad ? `${bad}/300 — ${sample}` : "300 distances, every corridor usable");
    }
    {
      let bad = 0;
      for (let i = 0; i < 200; i++) {
        const v = L.spreadBandDamage(pick(["Short", "Medium", "Long", junkString(), wildAny()]),
          pick([{}, { short: wildAny(), medium: wildAny(), long: wildAny() }, wildAny()]) ?? {});
        if (typeof v !== "string" || !v.trim().length) bad++;
      }
      add("pattern: every band yields a non-empty damage expression", bad === 0, `${bad}/200 bad`);
    }

    /* ── ammunition pricing ─────────────────────────────────────────────────────────────────── */
    {
      let bad = 0, sample = "";
      for (let i = 0; i < 200; i++) {
        const id = pick([...registry, ...garbage, wildAny()]);
        const b = L.getCaliberBox(id);
        if (!Number.isFinite(b?.box) || b.box < 1 || !Number.isFinite(b?.price) || b.price < 0) {
          bad++; if (!sample) sample = `${JSON.stringify(id)} → ${JSON.stringify(b)}`;
        }
      }
      add("pricing: a box always holds at least one round and costs a real number",
        bad === 0, bad ? `${bad}/200 — ${sample}` : "200 cartridges priced");
    }
    {
      let bad = 0;
      for (let i = 0; i < 200; i++) {
        const m = L.getModifierCostMult(pick([...Object.keys(L.AMMO_MODIFIERS), ...garbage, wildAny()]));
        if (!Number.isFinite(m) || m <= 0) bad++;
      }
      add("pricing: the load multiplier is always a positive real number", bad === 0, `${bad}/200 bad`);
    }
    {
      let bad = 0, sample = "";
      for (let i = 0; i < 200; i++) {
        const c = pick([...registry, ...garbage]), m = pick([...Object.keys(L.AMMO_MODIFIERS), ...garbage]);
        const p = L.getAmmoBoxPrice(c, m);
        if (!Number.isInteger(p) || p < 0) { bad++; if (!sample) sample = `${c}/${m} → ${p}`; }
      }
      add("pricing: a box price is always a whole, non-negative number",
        bad === 0, bad ? `${bad}/200 — ${sample}` : "200 pairs priced");
    }
    {
      const pairs = registry.flatMap(c => Object.keys(L.AMMO_MODIFIERS).map(m => [c, m]));
      const broken = pairs.filter(([c, m]) => !Number.isFinite(L.getAmmoBoxPrice(c, m)));
      add("pricing: every real cartridge-and-load pair in the catalogue has a usable price",
        broken.length === 0, broken.length ? `${broken.length}/${pairs.length} broken` : `${pairs.length} pair(s)`);
    }

    /* ── the jam threshold (the base system's lookup, which this module's data feeds) ────────── */
    {
      const allowed = new Set([3, 5, 8]);
      let bad = 0, sample = "";
      for (let i = 0; i < 200; i++) {
        const v = SU.reliabilityThreshold(pick([junkString(), wildAny(), "VeryReliable", "Standard", "Unreliable", "vr", "ur", "st"]));
        if (!Number.isFinite(v) || !allowed.has(v)) { bad++; if (!sample) sample = String(v); }
      }
      add("jam threshold: every stored spelling resolves to one of the three printed thresholds",
        bad === 0, bad ? `${bad}/200 — got ${sample}` : "200 spellings, all in {3,5,8}");
    }
    add("jam threshold: the three recognised vocabularies resolve by value, case-insensitively",
      SU.reliabilityThreshold("VERYRELIABLE") === 3 && SU.reliabilityThreshold("vr") === 3
      && SU.reliabilityThreshold("standard") === 5 && SU.reliabilityThreshold("ST") === 5
      && SU.reliabilityThreshold("Unreliable") === 8 && SU.reliabilityThreshold("ur") === 8,
      "3 / 5 / 8");
    add("jam threshold: an unrecognised spelling falls through to the middle value rather than to nothing",
      SU.reliabilityThreshold("very reliable") === 5 && SU.reliabilityThreshold(undefined) === 5,
      "unrecognised → 5");

    /* ── layered protection and the small numeric helpers ───────────────────────────────────── */
    /* ⛔ TWO CLAIMS, NOT ONE, AND THE SPLIT IS THE HONEST READING OF THE RULE.
     *
     * The old single leg asserted "finite AND never worse than max(Number(a)||0, Number(b)||0)" over
     * pure junk, which conflates two different properties and mis-scores both directions:
     *   · it FAILED on `combineArmorSP(0, -1) → -1`, where the -1 is the caller's own nonsense handed
     *     straight back — nothing about negative stopping power is a defect the module can be asked to
     *     repair without changing what it computes for real armour;
     *   · and it stated the ROBUSTNESS claim only in passing, buried inside a comparison that an
     *     infinite input satisfies vacuously (`Infinity >= Infinity`), so the actual defect — a
     *     non-finite SP escaping into the damage pipeline — was reported as if it were the same thing
     *     as the negative-input noise.
     *
     * So they are separated. The MONOTONE claim is made over the domain where it means something —
     * layers that could be real armour: finite and not negative. The FINITENESS claim is made over
     * everything, with no escape hatch, because that is the property the pipeline downstream actually
     * depends on: an SP of Infinity silently annihilates every damage number derived from it.
     *
     * ⚠ THE FINITENESS LEG IS EXPECTED RED UNTIL THE STAGED SANITIZE LANDS (a `+Infinity` layer folds
     * to `Infinity` today — import-staging/assurance/STAGED-MODULE-PATCHES.md). It is not relaxed to
     * fit the current behaviour: it names the defect. */
    const showNum = (v) => (typeof v === "number" ? String(v) : JSON.stringify(v));
    const showList = (a) => `[${a.map(showNum).join(", ")}]`;
    {
      let bad = 0, sample = "";
      for (let i = 0; i < 200; i++) {
        const a = wildNumber(), b2 = wildNumber();
        const v = U.combineArmorSP(a, b2);
        if (!Number.isFinite(v)) { bad++; if (!sample) sample = `${showNum(a)}+${showNum(b2)} → ${showNum(v)}`; }
      }
      add("protection: two layers always combine to a real number, however unusable the layers are",
        bad === 0, bad ? `${bad}/200 — ${sample}` : "200 pairs, every answer finite");
    }
    {
      let bad = 0, tried = 0, sample = "";
      for (let i = 0; i < 200; i++) {
        const a = Math.abs(wildNumber()) || 0, b2 = Math.abs(wildNumber()) || 0;
        if (!Number.isFinite(a) || !Number.isFinite(b2)) continue;   // covered by the leg above
        tried++;
        const v = U.combineArmorSP(a, b2);
        if (!(v >= Math.max(a, b2))) { bad++; if (!sample) sample = `${showNum(a)}+${showNum(b2)} → ${showNum(v)}`; }
      }
      add("protection: two layers that could be real armour never combine to worse than the better alone",
        bad === 0 && tried >= 100, bad ? `${bad}/${tried} — ${sample}` : `${tried} usable pair(s), none worse than its best layer`);
    }
    {
      let bad = 0, sample = "";
      for (let i = 0; i < 100; i++) {
        const layers = Array.from({ length: Math.floor(rng() * 6) }, () => wildNumber());
        const v = U.foldArmorSP(layers);
        // ⚠ NOT JSON.stringify FOR THE SAMPLE. `JSON.stringify(Infinity)` is the string "null", so the
        // first run of this leg reported its failing input as `[null] → Infinity` — which reads as a
        // null layer and is not what was fed in. The layer was Infinity.
        if (!Number.isFinite(v)) { bad++; if (!sample) sample = `${showList(layers)} → ${showNum(v)}`; }
      }
      add("protection: a stack of layers always folds to a real number, however unusable the stack is",
        bad === 0, bad ? `${bad}/100 — ${sample}` : "100 stacks, every answer finite");
    }
    {
      let bad = 0, sample = "";
      for (let i = 0; i < 100; i++) {
        const layers = Array.from({ length: Math.floor(rng() * 6) }, () => Math.abs(wildNumber()) || 0)
          .filter(Number.isFinite);
        const v = U.foldArmorSP(layers);
        const best = layers.reduce((m, x) => Math.max(m, x), 0);
        if (!(v >= best)) { bad++; if (!sample) sample = `${showList(layers)} → ${showNum(v)}`; }
      }
      add("protection: a stack that could be real armour never folds to worse than its best single layer",
        bad === 0, bad ? `${bad}/100 — ${sample}` : "100 stacks, none worse than its best layer");
    }
    add("protection: an empty stack is zero, not nothing",
      U.foldArmorSP([]) === 0 && U.foldArmorSP(null) === 0 && U.foldArmorSP(undefined) === 0, "empty / null / absent");
    {
      let bad = 0;
      for (let i = 0; i < 200; i++) {
        const lo = Math.floor(rng() * 100) - 50, hi = lo + Math.floor(rng() * 100);
        const v = U.clamp(wildNumber(), lo, hi);
        if (Number.isFinite(v) && (v < lo || v > hi)) bad++;
      }
      add("clamp: a finite answer always lands inside the stated bounds", bad === 0, `${bad}/200 out of bounds`);
    }
    {
      let bad = 0, sample = "";
      for (let i = 0; i < 200; i++) {
        const arg = pick([Math.floor(rng() * 30) - 5, wildNumber(), junkString(), wildAny()]);
        const v = L.btmFromBT(arg);
        if (!Number.isInteger(v) || v < 0 || v > 5) { bad++; if (!sample) sample = `${JSON.stringify(arg)} → ${v}`; }
      }
      add("body scale: every body value maps to a whole step on the printed 0–5 ladder",
        bad === 0, bad ? `${bad}/200 — ${sample}` : "200 body values");
    }
    {
      const plain = { system: {} };
      const suit = { system: { isACPA: true, effectiveRef: 10 } };
      let bad = 0, sample = "";
      for (const actor of [plain, suit]) {
        let prev = 1;
        for (let n = 0; n <= 20; n++) {
          const v = H._multiActionPenaltyFor(actor, n);
          if (!Number.isFinite(v) || v > 0 || v > prev) { bad++; if (!sample) sample = `count ${n} → ${v}`; }
          prev = v;
        }
      }
      add("declared actions: the penalty is a real number, never positive, and never eases as actions pile up",
        bad === 0, bad ? `${bad} step(s) — ${sample}` : "counts 0–20, both actor kinds");
      add("declared actions: a single action carries no penalty at all (the negative beside it)",
        H._multiActionPenaltyFor(plain, 1) === 0 && H._multiActionPenaltyFor(suit, 1) === 0, "count 1 → 0");
      add("declared actions: a powered suit softens the ladder rather than matching it",
        H._multiActionPenaltyFor(suit, 4) > H._multiActionPenaltyFor(plain, 4),
        `suit ${H._multiActionPenaltyFor(suit, 4)} vs plain ${H._multiActionPenaltyFor(plain, 4)}`);
    }
    {
      let bad = 0;
      for (let i = 0; i < 200; i++) { try { if (typeof L.isEnergyAttackType(wildAny()) !== "boolean") bad++; } catch (e) { bad++; } }
      add("attack kind: the energy test always answers yes or no, never throws", bad === 0, `${bad}/200 bad`);
    }
    return out;
  }, { scope: SCOPE, seed: SEED });

  for (const c of probe) ok(`§3 ${c.name}`, c.pass, c.got);
  ok("§3 the probe battery ran its full set of legs",
    probe.length >= 40, `${probe.length} invariant leg(s)`);
} catch (err) {
  ok("the suite ran to completion", false, String(err?.stack ?? err).slice(0, 500));
} finally {
  /* ══ §4. DRAIN + RESTORE ═══════════════════════════════════════════════════════════════════════
   * The apply path defers behind the presentation cap, so work started by the last emissions is still
   * in flight. The drain waits it out before the run-wide fault count is taken — otherwise the count
   * would be read while the thing it is counting has not happened yet. */
  console.log("\n===== §4: drain and restore =====");
  const drain = await page.evaluate(async () => {
    await new Promise(r => setTimeout(r, 10000));
    for (const a of [...foundry.applications.instances.values()]) {
      if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close({ force: true }); } catch (e) { /* closed */ } }
    }
    try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none */ }
    await new Promise(r => setTimeout(r, 1500));
    const f = globalThis.__cpFault ?? { uncaught: [], moduleErrors: [], otherErrors: [], warns: [], engineResiduals: [] };
    return {
      uncaught: f.uncaught.slice(0, 4), moduleErrors: f.moduleErrors.slice(0, 4),
      otherErrors: f.otherErrors.length, warns: f.warns.length,
      engineResiduals: (f.engineResiduals ?? []).length,
      dialogs: [...foundry.applications.instances.values()].filter(a => /Damage|Modifiers/i.test(a?.constructor?.name ?? "")).length,
    };
  }).catch(e => ({ uncaught: [String(e)], moduleErrors: [], otherErrors: -1, warns: -1, engineResiduals: -1, dialogs: -1 }));

  ok("§4 after the deferred work drained, nothing left an open apply window",
    drain.dialogs === 0, `${drain.dialogs}`);
  ok("§4 run-wide: no uncaught fault was raised at any point",
    drain.uncaught.length === 0 && nodeErrors.length === 0,
    [...drain.uncaught, ...nodeErrors].slice(0, 3).join(" | ") || "none");
  ok("§4 run-wide: nothing was logged as an error attributed to this module",
    drain.moduleErrors.length === 0, drain.moduleErrors.slice(0, 3).join(" | ") || "none");
  console.log(`  (informational: ${drain.warns} module warning(s) — expected, this suite feeds deliberate rubbish — and ${drain.otherErrors} core console error(s))`);
  // The engine residual, counted and named rather than scored. Non-zero is not a module verdict; it
  // means Sequencer tore an effect down mid-load somewhere the §1 settle could not cover.
  const residualTotal = (drain.engineResiduals ?? 0) + nodeEngineResiduals.length;
  console.log(`  (informational: ${residualTotal} third-party engine residual(s) — Sequencer`
    + ` CanvasEffect._createSprite "setting 'volume'", NOT this module: see`
    + ` import-staging/AUDIO-PAGEERROR-DIAGNOSIS.md and module/fx/status-fx.js:663-685)`);

  if (fixtures) {
    const swept = await page.evaluate(async ({ baseline, priorSceneId }) => {
      for (const m of [...game.messages].slice(baseline)) { try { await m.delete(); } catch (e) { /* gone */ } }
      [...game.user.targets].forEach(t => t.setTarget(false, { releaseOthers: false }));
      try { canvas.tokens?.releaseAll(); } catch (e) { /* no canvas */ }
      for (const s of game.scenes.filter(s => s.name === "__PW__Fuzz Stage")) await s.delete().catch(() => {});
      for (const a of game.actors.filter(a => /^__PW__FUZZ/.test(a.name))) await a.delete().catch(() => {});
      if (priorSceneId) { try { await game.scenes.get(priorSceneId)?.view(); } catch (e) { /* client-only */ } }
      await new Promise(r => setTimeout(r, 600));
      return {
        scenes: game.scenes.filter(s => s.name === "__PW__Fuzz Stage").length,
        actors: game.actors.filter(a => /^__PW__FUZZ/.test(a.name)).length,
        cards: game.messages.size,
        effects: (globalThis.Sequencer?.EffectManager?.effects ?? [])
          .filter(e => !String(e?.data?.name ?? "").startsWith("cp2020-augmented.statusfx.")).length,
      };
    }, { baseline: fixtures.baselineCards, priorSceneId: fixtures.priorSceneId })
      .catch(e => ({ scenes: -1, actors: -1, cards: -1, effects: -1, err: String(e) }));

    ok("§4 the suite's stage and figures are gone, taking every region and template with them",
      swept.scenes === 0 && swept.actors === 0, JSON.stringify(swept));
    ok("§4 the chat log is back where this run found it",
      swept.cards === fixtures.baselineCards, `${swept.cards} vs ${fixtures.baselineCards}`);
    ok("§4 the canvas holds no live shot effect", swept.effects === 0, `${swept.effects}`);
  }

  const passed = checks.filter(c => c.p).length;
  console.log(`\n===== seam fuzz: ${passed}/${checks.length} · seed ${SEED} =====`);
  if (passed !== checks.length) {
    for (const c of checks.filter(x => !x.p)) console.log(`  FAILED: ${c.n}   [${c.d}]`);
    console.log(`  replay this exact run with: FUZZ_SEED=${SEED} node tests/cp2020-augmented-seam-fuzz.mjs`);
  }
  await browser.close();
  process.exit(passed === checks.length ? 0 : 1);
}
