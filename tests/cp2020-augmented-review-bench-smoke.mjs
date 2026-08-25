/**
 * SMOKE TEST for the morning review bench (cp2020-augmented-provision-review-bench.mjs).
 *
 * NOT a keeper — it does not pin values. It answers one question: can a reviewer pick each gun off
 * the numbered list and fire it with ZERO loading steps, and does the thing that gun exists to show
 * actually reach the canvas? Every shot goes through the REAL UI PATH — the sheet's fire button, the
 * modifiers dialog, its submit — and every claim is read back off the ENGINE (the payload the seam
 * raised, the files Sequencer was handed, the region documents the pattern flow wrote), never off a
 * screenshot.
 *
 * It RESTORES what it disturbs: magazines refilled, target damage zeroed, its own chat cards deleted,
 * its own regions gone, the canvas cleared of effects, targets released. It touches no combat, no
 * other scene and no setting.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=<pw> node cp2020-augmented-review-bench-smoke.mjs
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";   // the battery-wide inline rig default; an empty fallback silently hangs the join
const SCOPE = "cp2020-augmented";

const checks = [];
const ok = (n, p, d = "") => { checks.push({ n, p: !!p, d: String(d) }); console.log(`${p ? "  ok  " : "  FAIL"}  ${n}${d ? `   [${d}]` : ""}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
// The null-volume line is the effect engine's own teardown race (a sound handle torn down
// mid-stop) — whitelisted as engine-side by the status-fx / fx-rail / vehicle-seating specs;
// same exclusion here so a burst's audio teardown cannot fail an unrelated leg.
page.on("pageerror", e => {
  const m = String(e.message);
  if (/Cannot set properties of null \(setting 'volume'\)/i.test(m)) return;
  errors.push(m);
});

await page.goto(`${URL}/join`);
await page.waitForSelector('select[name="userid"]');
await page.evaluate(() => {
  const s = document.querySelector('select[name="userid"]');
  s.value = [...s.options].find(o => /gamemaster/i.test(o.textContent)).value;
  s.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.fill('input[name="password"]', PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 90000 });

// ⭐ THE BENCH SCENE, PINNED AND *VIEWED* — not activated (2026-08-11).
//
// Every reader below took `game.scenes.active`, which is a WORLD-wide property any other client can
// change. With a second lane's review scene activated, this spec looked up the bench's own figures on a
// canvas that does not carry them: the first target resolved to `undefined` and the run died inside
// `setTarget`, with the bench itself perfectly intact. Viewing is the right verb — `Scene#view` moves
// only THIS client's canvas, so the shots are drawn and sampled where the fixtures are without taking
// the canvas away from anybody else.
const BENCH_SCENE_NAME = "Review · Dark Range";
await page.evaluate(async (name) => {
  const scene = game.scenes.getName(name) ?? game.scenes.active ?? game.scenes.contents[0];
  if (scene && canvas.scene?.id !== scene.id) await scene.view();
  globalThis.__BENCH_SCENE_ID = scene?.id ?? null;
}, BENCH_SCENE_NAME);
await page.waitForFunction(() => window.canvas?.ready === true, null, { timeout: 90000 });
await page.waitForTimeout(3000);

/* ── instrumentation: one tap on each engine that can answer a question ───────────────────────── */
const setup = await page.evaluate(async (SCOPE) => {
  const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);
  const g = globalThis.__smoke = { files: [], payloads: [], raw: [], cards: [], regions: [], patterns: [] };
  Hooks.on("createSequencerEffect", (e) => {
    const f = String(e?.data?.file ?? e?.data?.src ?? "");
    if (f) g.files.push(f);
  });
  Hooks.on("cyberpunk2020.weaponFired", (p) => { g.raw.push(p); g.payloads.push({
    weaponName: p.weaponName, modifier: p.modifier ?? null, caliber: p.caliber ?? null,
    spreadMode: p.spreadMode ?? null, shotsFired: p.shotsFired, shotsHit: p.shotsHit,
    // The base system's own verdict, carried so a section that depends on a shot having LANDED can
    // state that precondition instead of assuming it (see E).
    attackTotal: p.attackTotal ?? null, toHitDC: p.toHitDC ?? null,
    // ⭐ THE RAIL'S OWN NON-DRAW REASONS, carried so a section that sees an empty draw list says WHY
    // instead of leaving a reader to guess: a table-ruled fumble draws nothing at all (by ruling), and
    // an aim the seam could not capture is the other way a shot reaches the rail with nothing to point at.
    fumbleRuled: p.fumbleRuled ?? null, hasAim: !!p.spreadAim,
    fxTarget: p.fxTargetTokenId ?? null, attackerTokenId: p.attackerTokenId ?? null,
    scattered: !!p.spreadScatter,
    // The band inputs, carried so E can re-derive its expectation through the printed rule: the
    // weapon's own range the seam stamps, and the AIMED reach the module actually bands on (the
    // corridor's drawn length can run past the aim point and is the wrong distance to band).
    spreadRangeM: p.spreadRangeM ?? null,
    spreadReachM: p.spreadAim?.reachM ?? p.spreadAim?.lengthM ?? null,
    landed: Object.values(p.areaDamages ?? {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0),
  }); });
  Hooks.on("createChatMessage", (m) => g.cards.push(m.id));
  // ⭐ THE PATTERN'S FACTS ARE TAKEN AT CREATION (2026-08-11). The resolution DELETES the region on its
  // way out, so by the time a leg that has pressed Apply looks, the document is gone — reading it later
  // measured nothing but the run's own wait. Recorded here, where it is certainly alive.
  Hooks.on("createRegion", (r) => {
    g.regions.push(r.id);
    if (r.getFlag(SCOPE, "isSpreadZone")) g.patterns.push({
      id: r.id, band: r.getFlag(SCOPE, "band"), shells: r.getFlag(SCOPE, "shells"),
      dmg: r.getFlag(SCOPE, "dmgFormula"), declaredAim: r.getFlag(SCOPE, "declaredAim"),
      dirDeg: r.getFlag(SCOPE, "dirDeg"), lengthM: r.getFlag(SCOPE, "lengthM"), widthM: r.getFlag(SCOPE, "widthM"),
      ammoKey: r.getFlag(SCOPE, "ammoKey"),
      // ⭐ 2026-08-19: whether the presentation rail already lit this corridor's ground on the shot's
      // arrival clock. The confirm reads the same flag to decide whether it still owes the fires.
      railFires: r.getFlag(SCOPE, "railFires"),
    });
  });

  const shooter = game.actors.getName("Review · Shooter");
  const scene = game.scenes.get(globalThis.__BENCH_SCENE_ID) ?? game.scenes.active;
  return {
    actorId: shooter.id,
    guns: Object.fromEntries(shooter.itemTypes.weapon
      .filter(w => w.getFlag(SCOPE, "reviewBench"))
      .map(w => [String(w.getFlag(SCOPE, "reviewBench").n).padStart(2, "0"), { id: w.id, name: w.name }])),
    tokens: Object.fromEntries(scene.tokens.map(t => [t.name, t.id])),
    // The keys the shipped file names, read out of it — nothing here is a hardcoded asset path.
    // `createSequencerEffect` reports the DATABASE KEY the section was handed (sometimes with a
    // range/variant suffix appended: "…yellow.1"), so the match below is key-prefix, not path.
    keys: {
      groundFire: fx.GROUND_FIRE.key, blood: fx.BLOOD_SPLATTER.key, baton: fx.BATON_ROUND.key,
      dust: fx.IMPACT_DUST.key, fireImpact: fx.IMPACT_FIRE.key,
      hitConfirm: fx.HIT_CONFIRM.key,
      // ⏪ The withdrawn ground mark (user ruling 2026-08-10). Named as a literal because the module no
      // longer exports a constant for it — leg D asserts it is never drawn.
      withdrawnGroundMark: "jb2a.scorched_earth.black",
    },
    baseline: {
      cards: game.messages.size,
      regions: scene.regions.map(r => r.id),
      effects: (globalThis.Sequencer?.EffectManager?.effects ?? []).length,
    },
  };
}, SCOPE);

console.log(`\nbench guns found: ${Object.keys(setup.guns).length} · baseline: ${setup.baseline.regions.length} region(s), ${setup.baseline.effects} live effect(s), ${setup.baseline.cards} card(s)`);

/* ── the firing gesture, exactly as a reviewer performs it ───────────────────────────────────── */
async function fire(num, targetName, { forceHit = false } = {}) {
  const gun = setup.guns[num];
  await page.evaluate(async ({ actorId, gunId, tokenId }) => {
    const g = globalThis.__smoke;
    // ⚠ DRAIN FIRST. The apply window is DEFERRED until the shot's presentation settles and may take
    // up to PRESENTATION_CAP_MS (8 s) to appear, so a window opened by the PREVIOUS shot arrives long
    // after that shot's own read — and would otherwise be counted against this one. Close, wait past
    // the cap's remainder, close again.
    for (let i = 0; i < 2; i++) {
      for (const a of [...foundry.applications.instances.values()]) {
        if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
      }
      await new Promise(r => setTimeout(r, 1200));
    }
    g.files.length = 0; g.payloads.length = 0; g.raw.length = 0; g.regions.length = 0; g.patterns.length = 0;
    canvas.tokens.get(tokenId).setTarget(true, { releaseOthers: true });
    const actor = game.actors.get(actorId);
    await actor.sheet.render(true);
    await new Promise(r => setTimeout(r, 1500));
    const el = actor.sheet.element.querySelector(`.fire-weapon[data-item-id="${gunId}"]`)
            ?? actor.sheet.element.querySelector(`[data-item-id="${gunId}"] .fire-weapon`);
    if (!el) throw new Error(`no fire button for ${gunId}`);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }, { actorId: setup.actorId, gunId: gun.id, tokenId: setup.tokens[targetName] });

  // ⭐ A SPREAD WEAPON IS AIMED BEFORE IT IS DECLARED (user ruling 2026-08-11). Its fire control arms a
  // corridor preview instead of opening the window, so the reviewer's gesture has a step in the middle:
  // move to aim, click to place. Performed here exactly as a reviewer performs it, and skipped for every
  // weapon that arms none — which is what the wait is for, since only one of the two ever appears.
  await page.evaluate(async ({ tokenId }) => {
    const place = await import(`/modules/cp2020-augmented/module/combat/spread-placement.js`);
    const armed = async () => {
      for (let i = 0; i < 40; i++) {
        if (place.spreadPreviewActive()) return true;
        if ([...foundry.applications.instances.values()].some(a => /ModifiersDialog/.test(a?.constructor?.name ?? "") && a.rendered === true)) return false;
        await new Promise(r => setTimeout(r, 100));
      }
      return false;
    };
    if (!(await armed())) return false;
    const t = canvas.tokens.get(tokenId);
    const p = canvas.stage.worldTransform.apply(new PIXI.Point(t.center.x, t.center.y));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: p.x, clientY: p.y, bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    // The confirm must be dispatched ON THE BOARD: the aim listeners gate on the event's target being
    // the game canvas (spread-placement.js `_isCanvasEvent`, added so a click on an open sheet cannot
    // place the corridor). A window-targeted event is exactly what that gate exists to ignore.
    canvas.app.view.dispatchEvent(new PointerEvent("pointerdown", { clientX: p.x, clientY: p.y, button: 0, bubbles: true }));
    return true;
  }, { tokenId: setup.tokens[targetName] });

  await page.waitForFunction(() => [...foundry.applications.instances.values()]
    .some(a => /ModifiersDialog/.test(a?.constructor?.name ?? "") && a.rendered === true), null, { timeout: 25000 });
  // Cap an automatic's burst so the smoke run does not dump a 30-round fan-out on the canvas.
  // `forceHit` pins the attack verdict for the sections whose subject depends on it — see the note at
  // its one caller. Both halves are restored the moment the roll is over.
  await page.evaluate(async ({ actorId, forceHit }) => {
    const shooter = game.actors.get(actorId);
    let refWas;
    if (forceHit) {
      refWas = shooter.system.stats?.ref?.base;
      await shooter.update({ "system.stats.ref.base": 10 });
      // 9, NEVER 10: the base die is `1d10x10`, so a forced maximum explodes forever. 9 + REF 10
      // clears the Close DC with room to spare.
      globalThis.__smokeRU = CONFIG.Dice.randomUniform;
      CONFIG.Dice.randomUniform = (() => { const Q = [1 - (9 - 0.5) / 10]; return () => (Q.length ? Q.shift() : 0.5); })();
    }
    const dlg = [...foundry.applications.instances.values()].find(a => /ModifiersDialog/.test(a?.constructor?.name ?? ""));
    const rounds = dlg.element.querySelector('input[name*="fullAutoRoundsFired"], input.full-auto-rounds');
    if (rounds) { rounds.value = "3"; rounds.dispatchEvent(new Event("change", { bubbles: true })); }
    const btn = dlg.element.querySelector('button[type="submit"], footer button');
    if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    else dlg.element.requestSubmit();
    if (forceHit) {
      await new Promise(r => setTimeout(r, 1500));
      CONFIG.Dice.randomUniform = globalThis.__smokeRU;
      await shooter.update({ "system.stats.ref.base": refWas });
    }
  }, { actorId: setup.actorId, forceHit });
  await page.waitForFunction(() => globalThis.__smoke.payloads.length > 0, null, { timeout: 25000 }).catch(() => {});
  // Past PRESENTATION_CAP_MS (8 s): the fan-out, the fires, the blood AND any deferred apply window.
  await page.waitForTimeout(9000);
  return page.evaluate(() => ({
    handled: globalThis.__smoke.raw.map(p => p.handled ?? null),
    files: [...new Set(globalThis.__smoke.files)],
    payloads: globalThis.__smoke.payloads,
    newRegions: globalThis.__smoke.regions,
    patterns: globalThis.__smoke.patterns,
    dialogs: [...foundry.applications.instances.values()].filter(a => /Damage/i.test(a?.constructor?.name ?? "")).map(a => a.constructor.name),
  }));
}
const landed = (r) => (r.payloads[0]?.landed ?? 0) > 0;
/**
 * Fire ONE shot that LANDS, for the sections whose subject is what a landing round draws.
 *
 * ⭐ IT FORCES THE VERDICT NOW, AND TAKES ONE SHOT INSTEAD OF UP TO SIX (2026-08-13). It used to
 * simply re-fire until something landed, because a natural 1 is a ruled fumble that draws nothing —
 * true, but the cure cost a magazine: two sections sharing the bench pistol could spend twelve rounds
 * between them, and a gun that runs dry raises NO PAYLOAD AT ALL, which surfaced as
 * "undefined location(s)" against a section that had nothing wrong with it. Forcing the roll pins the
 * one variable these sections do not mean to measure and takes one round to do it.
 *
 * The retry is kept as a fall-through for anything the forcing does not model, not as the mechanism.
 */
async function fireUntilHit(num, targetName, tries = 3) {
  let r = await fire(num, targetName, { forceHit: true });
  for (let i = 1; i < tries && !landed(r); i++) r = await fire(num, targetName, { forceHit: true });
  return r;
}
const drew = (files, key) => files.some(f => f === key || f.startsWith(`${key}.`));

/* ══ A. 01 pistol Standard at the FLESH target — the baseline, and the blood gate ═════════════ */
console.log(`\n── A · 01 pistol Standard → Review · Target (flesh) ──`);
let r = await fireUntilHit("01", "Review · Target");
ok("A: the gun fired with no loading step and the seam raised its payload",
  r.payloads.length === 1, JSON.stringify(r.payloads[0] ?? null));
ok("A: the payload carries the loaded cartridge (the ammo link is live)",
  r.payloads[0]?.caliber === "10mm", `caliber=${r.payloads[0]?.caliber}`);
ok("A: the round landed (the bench can hit — skills, not weapon accuracy)",
  (r.payloads[0]?.landed ?? 0) > 0, `${r.payloads[0]?.landed} location(s)`);
ok("A: BLOOD is drawn on a flesh hit with gore on",
  drew(r.files, setup.keys.blood), r.files.join(", ").slice(0, 200));

/* ══ B. 01 pistol at the VEHICLE — the same shot must draw NO blood ═══════════════════════════ */
console.log(`\n── B · 01 pistol Standard → Review · Target (Vehicle) — the negative ──`);
r = await fireUntilHit("01", "Review · Target (Vehicle)");
ok("B: the shot landed on the vehicle", (r.payloads[0]?.landed ?? 0) > 0, `${r.payloads[0]?.landed} location(s)`);
ok("B: and NO blood is drawn — a vehicle takes damage into structure (negative)",
  !drew(r.files, setup.keys.blood), r.files.join(", ").slice(0, 200));

/* ══ C. 05 SMG Rubber — the baton round ═══════════════════════════════════════════════════════ */
console.log(`\n── C · 05 H&K MPK-9 Rubber → Review · Target (flesh) ──`);
r = await fireUntilHit("05", "Review · Target");
ok("C: the baton round's own asset is drawn — the round is a different picture, not a dimmer one",
  drew(r.files, setup.keys.baton), r.files.join(", ").slice(0, 200));
ok("C: and the hit mark is the DUST PUFF, not the ordinary impact",
  drew(r.files, setup.keys.dust), r.files.join(", ").slice(0, 200));

/* ══ D. 07 rifle API — burning ground on the single-target flow ═══════════════════════════════ */
console.log(`\n── D · 07 Militech Ronin API → Review · Target (flesh) ──`);
r = await fireUntilHit("07", "Review · Target");
ok("D: the incendiary load sets BURNING GROUND where the rounds fell",
  drew(r.files, setup.keys.groundFire), r.files.join(", ").slice(0, 220));
// ⏪ INVERTED 2026-08-10 (user ruling "kill it"): this leg used to require one dark ground mark under
// the flames. The element is removed entirely — the flames are unchanged — so the leg now pins its
// absence on the same census.
ok("D: and NO ground mark is left under them — the decal is withdrawn (negative)",
  !drew(r.files, setup.keys.withdrawnGroundMark), r.files.join(", ").slice(0, 220));
// ⏪ REPOINTED 2026-08-10 — this leg used to require the FIRE impact mark on the target, which is the
// promotion the 2026-08-09 ruling withdrew (*"get rid of the blast circle that lands on the target. I
// think multiple are being placed"*): the row names no `impactKey` any more, so the load falls through
// to the class's own hit mark. The leg had been asserting the behaviour the ruling deleted. It now
// asserts the ruled one, with the withdrawn asset as its negative — the same shape the fx-rail spec's
// api section uses.
ok("D: the hit mark is the CLASS's own, and the withdrawn burning ring stays withdrawn (negative)",
  drew(r.files, setup.keys.hitConfirm) && !drew(r.files, setup.keys.fireImpact), r.files.join(", ").slice(0, 220));
const liveFires = await page.evaluate(() => (globalThis.Sequencer?.EffectManager?.effects ?? []).length);
ok("D: the fires are really alive on the canvas afterwards", liveFires > 0, `${liveFires} live effect(s)`);

/* ══ E. 10 shell Buckshot — AIM FIRST, THEN APPLY ════════════════════════════════════════════ */
// The card in this section has moved twice and both moves are the ruling, not a build choice. The
// 2026-08-11 ruling took the AIMING half of the old confirm click to the front of the gesture (the
// `fire()` helper above performs it); the 2026-08-13 ruling kept the APPLY half as a press, arriving on
// a resolution card once the shot has finished being presented. So what a reviewer checks here is the
// whole ORDER: aimed, planted on the aimed line, drawn, then a card that lists who is in the corridor —
// with nothing applied and the pattern still on the canvas — and only then, on the press, the damage.
console.log(`
── E · 10 Arasaka RAS-12 Buckshot → Review · Target (flesh) ──`);
// ⭐ THE SHOT IS FORCED TO LAND, and it has to be as of 2026-08-13. A declared corridor that MISSES
// now scatters to the grenade table, and a scattered corridor usually catches nobody — at which point
// the confirm correctly posts NO result card (`_confirmSpreadZone` only posts when the corridor caught
// someone; an empty one says so with a notification). So the last leg of this section, "the press
// lands the shot", was reading the dice: it went red roughly one run in several, reported as 38/39.
// Nothing was masked — the behaviour it measures needs a shot that HIT, and that is now pinned the
// same way the spread spec pins it (REF 10 + an attack die queued at 9; never a forced 10, the base
// die explodes). The MISS half has its own home, with both rails asserted: spread-zone §14.
// Still NOT retried: one aim, one pattern.
r = await fire("10", "Review · Target", { forceHit: true });
ok("E: the forced shot LANDED, so this section is reading the mechanism and not the dice",
  Number(r.payloads[0]?.attackTotal) >= Number(r.payloads[0]?.toHitDC) && r.payloads[0]?.scattered === false,
  `${r.payloads[0]?.attackTotal} vs DC ${r.payloads[0]?.toHitDC}, scattered=${r.payloads[0]?.scattered}`);
ok("E: the cartridge resolves to the BUCK pattern, not a single-target shot",
  r.payloads[0]?.caliber === "00", `caliber=${r.payloads[0]?.caliber} spreadMode=${r.payloads[0]?.spreadMode}`);
const pat = { zones: r.patterns };
ok("E: a shot PATTERN was placed on the canvas", pat.zones.length === 1, JSON.stringify(pat.zones));
ok("E: planted on the corridor the SHOOTER declared, not on a guessed axis",
  pat.zones[0]?.declaredAim === true, `declaredAim=${pat.zones[0]?.declaredAim}`);
// ⏪ RE-PINNED 2026-08-17: the band edges follow the WEAPON's own range now (Core p.109 pattern
// against the p.99 bands, commit 0021ed6) — the retired fixed 6m/25m edges banded this bench reach
// "Medium". The expectation is re-derived from the two numbers the module itself carries (the
// payload's stamped range, the zone's own length) through the printed rule, so the leg follows the
// book rather than a retired constant.
const zRange = Number(r.payloads[0]?.spreadRangeM);
const zReach = Number(r.payloads[0]?.spreadReachM);
const zBand = zReach <= Math.max(1, zRange / 4) ? "Short" : zReach <= zRange / 2 ? "Medium" : "Long";
ok("E: banded from the real aimed distance against the weapon's own range, one pattern for the whole burst",
  zRange > 0 && zReach > 0 && pat.zones[0]?.band === zBand && Number(pat.zones[0]?.shells) >= 1,
  `band=${pat.zones[0]?.band} expected=${zBand} (reach ${zReach}m of range ${zRange}m) shells=${pat.zones[0]?.shells} dmg=${pat.zones[0]?.dmg}`);
ok("E: the single-target flow did NOT claim this payload — the pattern owns it (negative)",
  r.handled.every(h => h === null), JSON.stringify(r.handled));
ok("E: and no apply window opened for it", r.dialogs.length === 0, r.dialogs.join(", "));
// ⛔ COUNT ONLY THIS RUN'S CARDS. These three counters used to read the WHOLE chat log, so a card of
// the same class left in the log by any other suite (2client-relays' A4c spread confirm is one, and
// it sorts before this suite) made "NO guessed-corridor card" fail on somebody else's message. The
// suite already records `setup.baseline.cards` for exactly this reason and the restore block already
// slices by it — these legs simply had not been given the same treatment.
const awaitingApply = await page.evaluate(({ SCOPE, baselineCards }) => {
  const mine = [...game.messages].slice(baselineCards);
  return {
    zones: (game.scenes.get(globalThis.__BENCH_SCENE_ID) ?? game.scenes.active).regions.filter(x => x.getFlag(SCOPE, "isSpreadZone")).length,
    // The GUESSED-corridor card, told apart from the resolution card by the row list only the latter
    // has (both carry the same apply control on purpose).
    guessCards: mine.filter(m => (m.content ?? "").includes("cp-confirm-spread-zone") && !(m.content ?? "").includes("cp-spread-resolve-list")).length,
    resolveCards: mine.filter(m => (m.content ?? "").includes("cp-spread-resolve-list")).length,
    resultCards: mine.filter(m => (m.content ?? "").includes("cp-spread-result-list")).length,
  };
}, { SCOPE, baselineCards: setup.baseline.cards });
ok("E: NO 'look at this guessed corridor' card — the shooter already aimed it (negative)",
  awaitingApply.guessCards === 0, `${awaitingApply.guessCards} card(s)`);
ok("E: the shot ends in ONE resolution card the reviewer is asked to apply",
  awaitingApply.resolveCards === 1, `${awaitingApply.resolveCards} card(s)`);
ok("E: nothing has been applied yet, and the pattern is still on the canvas underneath it (negative)",
  awaitingApply.resultCards === 0 && awaitingApply.zones === 1,
  `${awaitingApply.resultCards} result card(s), ${awaitingApply.zones} zone(s)`);

const afterApply = await page.evaluate(async ({ SCOPE, baselineCards }) => {
  // ⚠ THE NEWEST ONE. A resolution card is SPENT rather than deleted, so an earlier section's card is
  // still in the log and a first-match lookup presses a button whose pattern is already gone — which
  // reads exactly like the press having done nothing.
  const card = [...game.messages].filter(m => (m.content ?? "").includes("cp-spread-resolve-list")).at(-1);
  const btn = card ? document.querySelector(`[data-message-id="${card.id}"] .cp-confirm-spread-zone`) : null;
  btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 5000));
  return {
    pressed: !!btn,
    zones: (game.scenes.get(globalThis.__BENCH_SCENE_ID) ?? game.scenes.active).regions.filter(x => x.getFlag(SCOPE, "isSpreadZone")).length,
    resultCards: [...game.messages].slice(baselineCards).filter(m => (m.content ?? "").includes("cp-spread-result-list")).length,
  };
}, { SCOPE, baselineCards: setup.baseline.cards });
ok("E: the apply control is on the rendered card and the press lands the shot",
  afterApply.pressed && afterApply.resultCards === 1, `pressed=${afterApply.pressed}, ${afterApply.resultCards} result card(s)`);
ok("E: and nothing is left hovering on the canvas afterwards", afterApply.zones === 0, `${afterApply.zones} left`);

/* ══ F. 11 shell SLUG — the single-target contrast: no pattern, an apply route ════════════════ */
console.log(`\n── F · 11 Arasaka RAS-12 Slug → Review · Target (flesh) ──`);
r = await fireUntilHit("11", "Review · Target");
const slug = await page.evaluate((SCOPE) => ({
  zones: (game.scenes.get(globalThis.__BENCH_SCENE_ID) ?? game.scenes.active).regions.filter(x => x.getFlag(SCOPE, "isSpreadZone")).length,
  flagged: [...game.messages].slice(-4).filter(m => !!m.getFlag(SCOPE, "damagePayload")).length,
  dialogs: [...foundry.applications.instances.values()].filter(a => /Damage/i.test(a?.constructor?.name ?? "")).map(a => a.constructor.name),
}), SCOPE);
ok("F: the slug is the same cartridge but declares its own spread mode",
  r.payloads[0]?.caliber === "00" && r.payloads[0]?.spreadMode === "slug",
  `caliber=${r.payloads[0]?.caliber} spreadMode=${r.payloads[0]?.spreadMode}`);
ok("F: NO pattern is thrown (negative) — the one shell load that is a single projectile",
  slug.zones === 0, `${slug.zones} pattern(s)`);
ok("F: the single-target flow CLAIMS it — the other half of the either/or",
  r.handled.some(h => h === "cp2020-augmented"), JSON.stringify(r.handled));
ok("F: and an apply route reaches the reviewer for this shot",
  slug.dialogs.length > 0 || slug.flagged > 0 || setup.autoApply === true,
  `${slug.dialogs.join(",") || "no window"} / ${slug.flagged} flagged card(s) / autoApply=${setup.autoApply}`);

/* ══ G. 12 shell API — the pattern's OWN fires, laid down on the shot's ARRIVAL CLOCK ═════════ */
// ⏪ RE-PINNED 2026-08-19. This section used to assert the opposite: that a burning shell's fires were
// scattered by the RESOLUTION and could not be on the canvas while the card was still waiting. The user
// ruled the fires onto the shot's own arrival clock (FX-RAIL §6) — the same move the corridor's impact
// audio made on 2026-08-14 — so for a corridor the shooter DECLARED they are laid by the fan-out, and
// the region carries `railFires` to tell the confirm it no longer owes them. What the bench pins now is
// that pairing: the fires are down before the press, the region says who laid them, and the press does
// NOT lay a second set on top.
console.log(`
── G · 12 Arasaka RAS-12 API → Review · Target (flesh) ──`);
await page.evaluate(async () => {
  for (const a of [...foundry.applications.instances.values()]) {
    if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
  }
  try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none */ }
});
r = await fire("12", "Review · Target");   // same reason as E
ok("G: the pattern records the load it was thrown with", r.patterns[0]?.ammoKey === "api", `ammoKey=${r.patterns[0]?.ammoKey}`);
ok("G: the fires are already down before the card is pressed — they ride the shot's arrival clock",
  drew(r.files, setup.keys.groundFire),
  `${r.files.join(", ").slice(0, 180) || "(the rail drew NOTHING)"} · payload ${JSON.stringify(r.payloads[0] ?? null)}`);
ok("G: and the region records that the rail laid them, so the confirm knows it no longer owes any",
  r.patterns[0]?.railFires === true, `railFires=${r.patterns[0]?.railFires}`);
// The press, then a fresh read of what the rail drew AFTER it — the capture hook keeps collecting, and
// `fire()` only clears it at the start of the next shot.
const afterG = await page.evaluate(async (SCOPE) => {
  // The NEWEST resolution card — this section's — for the reason section E states.
  const card = [...game.messages].filter(m => (m.content ?? "").includes("cp-spread-resolve-list")).at(-1);
  const btn = card ? document.querySelector(`[data-message-id="${card.id}"] .cp-confirm-spread-zone`) : null;
  btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 6000));
  return {
    pressed: !!btn,
    files: [...new Set(globalThis.__smoke.files)],
    // The census the scene cap is a query of — the number BURNING after the press, which is what says
    // whether the confirm laid a second set on top of the rail's.
    live: (globalThis.Sequencer?.EffectManager?.getEffects?.({ name: `${SCOPE}.groundfire.*` }) ?? []).length,
    zones: (game.scenes.get(globalThis.__BENCH_SCENE_ID) ?? game.scenes.active).regions.filter(x => x.getFlag(SCOPE, "isSpreadZone")).length,
  };
}, SCOPE);
ok("G: an incendiary shell's fires are on the canvas through the apply — parity, and the element stays reachable",
  afterG.pressed && drew(afterG.files, setup.keys.groundFire), afterG.files.join(", ").slice(0, 220));
// ⛔ AND THE PRESS LAYS NO SECOND SET. The per-pattern bound is 5, so anything above it is the confirm
// planting on top of the rail — the exact double this ruling's `railFires` flag exists to make impossible.
ok("G: and the press adds none of its own — the corridor is lit once, not twice (negative)",
  afterG.live > 0 && afterG.live <= 5, `${afterG.live} flame(s) burning after the press, per-pattern bound 5`);
ok("G: that pattern is deleted too once it has been applied", afterG.zones === 0, `${afterG.zones} zone(s)`);

/* ══ RESTORE ══════════════════════════════════════════════════════════════════════════════════ */
console.log(`\n── restore ──`);
const restored = await page.evaluate(async ({ SCOPE, baselineCards, baselineRegions }) => {
  for (const a of [...foundry.applications.instances.values()]) {
    if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
  }
  try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none */ }
  const scene = game.scenes.get(globalThis.__BENCH_SCENE_ID) ?? game.scenes.active;
  // any pattern this run left behind
  const strayZones = scene.regions.filter(r => !baselineRegions.includes(r.id));
  if (strayZones.length) await scene.deleteEmbeddedDocuments("Region", strayZones.map(r => r.id));
  // this run's cards only — the baseline count is the cut line
  const mine = [...game.messages].slice(baselineCards);
  for (const m of mine) { try { await m.delete(); } catch (e) { /* gone */ } }
  // magazines back to full
  const actor = game.actors.getName("Review · Shooter");
  const refill = actor.itemTypes.weapon.filter(w => w.getFlag(SCOPE, "reviewBench"))
    .map(w => ({ _id: w.id, "system.shotsLeft": Number(w.system.shots) }));
  await actor.updateEmbeddedDocuments("Item", refill);
  // ammo boxes back to stock
  const ammo = actor.itemTypes.ammo.filter(a => a.getFlag(SCOPE, "reviewBench"))
    .map(a => ({ _id: a.id, "system.quantity": 60 }));
  await actor.updateEmbeddedDocuments("Item", ammo);
  // damage zeroed + effects the shots left on the targets
  const zeroed = [];
  for (const name of ["Review · Target", "Review · Target (Cyberlimb)", "Review · Target (Vehicle)"]) {
    const t = scene.tokens.find(x => x.name === name);
    if (!t) continue;
    for (const a of new Set([t.actor, game.actors.get(t.actorId)].filter(Boolean))) {
      const sys = a.system ?? {};
      const upd = {};
      if (sys.damage !== undefined) upd["system.damage"] = 0;
      if (sys.sdp?.sum) {
        upd["system.sdp.current"] = foundry.utils.deepClone(sys.sdp.sum);
        upd["system.sdp.touched"] = Object.fromEntries(Object.keys(sys.sdp.sum).map(k => [k, false]));
      }
      if (sys.sdp?.max !== undefined) upd["system.sdp.value"] = sys.sdp.max;
      if (Object.keys(upd).length) await a.update(upd);
      if (a.effects.size) await a.deleteEmbeddedDocuments("ActiveEffect", a.effects.map(e => e.id));
      zeroed.push(`${a.name}=${a.system.damage ?? a.system.sdp?.value}`);
    }
  }
  [...game.user.targets].forEach(t => t.setTarget(false, { releaseOthers: false }));
  try { await actor.sheet.close(); } catch (e) { /* closed */ }
  await new Promise(r => setTimeout(r, 800));
  return {
    zeroed,
    magazines: actor.itemTypes.weapon.filter(w => w.getFlag(SCOPE, "reviewBench"))
      .every(w => Number(w.system.shotsLeft) === Number(w.system.shots)),
    ammoFull: actor.itemTypes.ammo.filter(a => a.getFlag(SCOPE, "reviewBench"))
      .every(a => Number(a.system.quantity) === 60),
    regions: scene.regions.map(r => r.name),
    // ⚠ THE SHOT RAIL'S TRANSIENTS ONLY. Persistent condition overlays (module/fx/status-fx.js) are
    // drawn for as long as the condition is on the figure and are meant to still be there afterwards,
    // so a figure that is legitimately burning would otherwise fail this leg for doing its job. What
    // this check is actually for is a muzzle, tracer or impact that never ended.
    liveEffects: (globalThis.Sequencer?.EffectManager?.effects ?? [])
      .filter(e => !String(e?.data?.name ?? "").startsWith("cp2020-augmented.statusfx.")).length,
    cards: game.messages.size,
    dialogs: [...foundry.applications.instances.values()].filter(a => /Damage|Modifiers/i.test(a?.constructor?.name ?? "")).length,
  };
}, { SCOPE, baselineCards: setup.baseline.cards, baselineRegions: setup.baseline.regions });

ok("restore: every magazine is full again", restored.magazines);
ok("restore: every ammo box is back at stock", restored.ammoFull);
ok("restore: damage is zero on all three targets", restored.zeroed.every(z => /=0$|=60$|=30$/.test(z)), restored.zeroed.join(" · "));
ok("restore: the canvas holds no live effect", restored.liveEffects === 0, `${restored.liveEffects}`);
ok("restore: only the three cover regions remain", restored.regions.length === setup.baseline.regions.length, restored.regions.join(", "));
ok("restore: the chat log is back to where this run found it",
  restored.cards === setup.baseline.cards, `${restored.cards} vs ${setup.baseline.cards}`);
ok("restore: no dialog left open", restored.dialogs === 0, `${restored.dialogs}`);
/* ═════════════ BENCH PARITY — the set is CLOSED, not sampled ═════════════
 * The sections above walk a chosen handful. This one closes the enumeration the whole bench exists
 * to satisfy: every element the module SHIPS on the presentation rail must be reachable from this
 * bench, so a new element added without a bench route reddens here instead of quietly never being
 * looked at. The shipped list is read out of the module itself (the class table, the load-overlay
 * table, the condition-row table, the arrival tool) — never restated here — so adding a row to any
 * of those tables is what makes this leg speak. */
const parity = await page.evaluate(async ({ SCOPE, shooterName }) => {
  const FX = await import("/modules/cp2020-augmented/module/fx/effects.js");
  const SFX = await import("/modules/cp2020-augmented/module/fx/status-fx.js");
  const TT = await import("/modules/cp2020-augmented/module/fx/trauma-team-tool.js");
  const actor = game.actors.getName(shooterName);
  const out = { shooterFound: !!actor };
  if (!actor) return out;

  const bench = actor.items.filter(i => i.getFlag(SCOPE, "reviewBench"));
  const benchWeapons = bench.filter(i => i.type === "weapon");
  out.benchWeapons = benchWeapons.length;

  // 1 — every weapon-class row has a gun on the rack that resolves to it.
  const classes = Object.keys(FX.FX_CLASSES);
  const routedClasses = new Set(benchWeapons.map(w => FX.weaponFxClass(w)));
  out.classes = classes.map(c => ({ c, routed: routedClasses.has(c) }));

  // 2 — every load-overlay row has a numbered bench row carrying that load.
  const loads = Object.keys(FX.AMMO_FX);
  const benchLoads = new Set(bench.map(i => i.getFlag(SCOPE, "reviewBench")?.load).filter(Boolean));
  out.loads = loads.map(k => ({ k, routed: benchLoads.has(k) }));
  out.benchLoads = [...benchLoads].sort();

  // 3 — every condition row can be raised on a bench figure: either a load on the rack writes the
  //     module flag it watches, or every core id it watches is a registered condition a referee can
  //     set from the figure's own controls.
  const registered = new Set((CONFIG.statusEffects ?? []).map(e => e.id));
  const flagWriters = { fireDotState: benchLoads.has("api"), dotState: benchLoads.has("acid") };
  out.rows = SFX.STATUS_FX_ROWS.map(r => ({
    id: r.id,
    viaLoad: (r.flags ?? []).some(f => flagWriters[f] === true),
    viaControls: (r.statuses ?? []).length > 0 && r.statuses.every(s => registered.has(s)),
  }));

  // 4 — the arrival tool reaches the toolbar of the scene the bench sits on.
  const probe = { tokens: { name: "tokens", tools: {} } };
  out.traumaRouted = TT.addTraumaTeamTool(probe) === true && !!probe.tokens.tools["cp-tt-land"];
  out.traumaOnLiveBar = Object.keys(ui.controls?.controls?.tokens?.tools ?? {}).includes("cp-tt-land");

  // 5 — every load whose row sets the ground alight is on the rack, read off the module's own table
  //     rather than restated here: a load whose row sets fires but has no bench gun reddens. (⏪ the
  //     two legs that stood beside this one were retired 2026-08-20 with the expiry switch and its
  //     clear control — the element itself still ships and rows 07 and 12 still exercise it.)
  out.burningLoads = Object.entries(FX.AMMO_FX).filter(([, e]) => e?.groundFire === true)
    .map(([k]) => ({ k, routed: benchLoads.has(k) }));
  return out;
}, { SCOPE, shooterName: "Review · Shooter" });

ok("parity: the numbered rack is on the bench figure", parity.shooterFound && parity.benchWeapons >= 5, `${parity.benchWeapons} numbered guns`);
ok("parity: every shipped weapon-class row has a gun on the rack that resolves to it",
  (parity.classes ?? []).every(c => c.routed),
  (parity.classes ?? []).map(c => `${c.c}${c.routed ? "" : " ✗"}`).join(" "));
ok("parity: every shipped load-overlay row has a numbered row carrying that load",
  (parity.loads ?? []).every(l => l.routed),
  (parity.loads ?? []).map(l => `${l.k}${l.routed ? "" : " ✗"}`).join(" ") + ` | rack loads: ${(parity.benchLoads ?? []).join(",")}`);
ok("parity: every shipped condition row is raisable on a bench figure (by a load or by the figure's own controls)",
  (parity.rows ?? []).every(r => r.viaLoad || r.viaControls),
  (parity.rows ?? []).map(r => `${r.id}:${r.viaLoad ? "load" : r.viaControls ? "controls" : "✗"}`).join(" "));
ok("parity: the arrival tool is reachable from the bench's own toolbar",
  parity.traumaRouted === true && parity.traumaOnLiveBar === true,
  `hook: ${parity.traumaRouted} · live bar: ${parity.traumaOnLiveBar}`);
ok("parity: every load whose row sets fires has a bench gun to fire it from",
  (parity.burningLoads ?? []).length > 0 && (parity.burningLoads ?? []).every(l => l.routed),
  (parity.burningLoads ?? []).map(l => `${l.k}${l.routed ? "" : " ✗"}`).join(" "));

ok("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

const passed = checks.filter(c => c.p).length;
console.log(`\n=== review-bench smoke: ${passed}/${checks.length} ===`);
if (passed !== checks.length) for (const c of checks.filter(x => !x.p)) console.log(`  FAILED: ${c.n}   [${c.d}]`);
await browser.close();
process.exit(passed === checks.length ? 0 : 1);
