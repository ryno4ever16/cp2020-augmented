/**
 * AUTOFIRE ROUNDS — the shooter's chosen burst length must reach the fire path.
 *
 * WHAT THIS PINS. CP2020 full auto fires UP TO the weapon's ROF and the shooter says how many; the
 * attack dialog carries a field for exactly that. The number the shooter types has to be ONE truth —
 * the rounds the card reports, the rounds the magazine loses, the rounds the presentation draws, and
 * the rounds the to-hit maths counts for its +1/-1 per ten. This spec drives the REAL dialog on the
 * review bench and asserts all four read the same number.
 *
 * ⭐ WHY IT WENT WRONG, AND WHAT THE FIX WAS (2026-08-13). The base system already owns this feature:
 * `CyberpunkItem._resolveFullAutoRounds(attackMods, system)` in `module/item/item.js` is the single
 * deciding site — it clamps a requested count into `1 .. min(ROF, shotsLeft)`, falls back to the full
 * maximum when nothing was asked for, and is called BOTH for the burst itself and for the ranged
 * to-hit term. It reads one field name: `fullAutoRoundsFired`. Our own modifier table
 * (`module/lookups.js`) had grown a PARALLEL row called `autoRounds`, so the shooter's number went
 * into the form, came out of the form, and was read by nothing. Every burst therefore fired the
 * weapon's whole ROF — a rifle drew the 30-round maximum on every trigger pull. The fix is a rename
 * onto the base's field, not a new mechanism: there was nothing to build, only something to connect.
 *
 * ⚠ THE CLAMP IS THE BASE'S, AND ITS LOW END IS NOT WHAT YOU WOULD GUESS. A requested 0 (or anything
 * non-finite) is read as "no preference" and yields the FULL maximum, not 1 — see the resolver. The
 * input itself carries `min`/`max`, so a browser marks 0 and 99 invalid before submit; the resolver is
 * the second line of defence behind that. Both halves are asserted below.
 *
 * ⚠ AMMO TRACKING IS FORCED ON for the magazine leg and restored afterwards: the bench shooter carries
 * Free Fire (`ammoTracking:false`), under which no magazine moves and the leg would pass vacuously.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-autofire-rounds.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";
const SCENE = "Review · Cover System";
const GUN = "06";            // Militech Ronin Light Assault — Rifle, Auto, ROF 30, 35 shots
const TARGET = "Review · Target";

const out = [];
let fails = 0;
const ok = (label, cond, got) => {
  out.push(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        got: ${got}`}`);
  if (!cond) fails++;
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const pageErrors = [];
// The null-volume line is the effect engine's own teardown race — a sound handle torn down while its
// howl is still settling. It is excluded here for the same reason the review-bench smoke spec excludes
// it: it is not raised by anything this spec drives.
page.on("pageerror", (e) => {
  const m = String(e.message);
  if (/Cannot set properties of null \(setting 'volume'\)/.test(m)) return;
  pageErrors.push(m);
});
page.on("dialog", (d) => d.accept().catch(() => {}));

try {
  await page.goto(`${BASE}/join`, { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 60000 });
  const users = await sel.locator("option").evaluateAll((o) =>
    o.map((x) => ({ v: x.value, l: (x.textContent || "").trim() })).filter((x) => x.v));
  await sel.selectOption(users.find((u) => /gamemaster/i.test(u.l)).v);
  await page.locator('input[name="password"]').fill(GM_PW);
  await Promise.all([
    page.waitForNavigation({ url: /\/game/, timeout: 60000 }).catch(() => {}),
    page.locator('button[name="join"]').click(),
  ]);
  await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 90000 });
  await page.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(2500);

  /* ── setup: pin the scene, force ammo tracking on, tap the fire payload ──────────────────── */
  const setup = await page.evaluate(async ({ SCOPE, SCENE, GUN }) => {
    const scene = game.scenes.getName(SCENE);
    if (scene.id !== canvas.scene?.id) { await scene.view(); await new Promise((r) => setTimeout(r, 2500)); }
    globalThis.__BENCH_SCENE_ID = scene.id;
    const actor = game.actors.getName("Review · Shooter");
    const gun = actor.itemTypes.weapon.find((w) => w.name.startsWith(`${GUN} · `));
    // Top the magazine BEFORE the reading below: `maxRounds` is min(ROF, shotsLeft), so a run that
    // started on a half-empty gun would measure its own leftovers as the weapon's ceiling.
    await actor.updateEmbeddedDocuments("Item", [{ _id: gun.id, "system.shotsLeft": Number(gun.system.shots) }]);
    const ff = await import(`/modules/${SCOPE}/module/mech/free-fire.js`);
    const wasTracking = ff.ammoTrackingOn(actor);
    if (!wasTracking) await ff.setAmmoTracking(actor, true);
    globalThis.__afTap = [];
    Hooks.on("cyberpunk2020.weaponFired", (p) => globalThis.__afTap.push({
      weaponName: p.weaponName, shotsFired: p.shotsFired, shotsHit: p.shotsHit,
    }));
    const tokens = {};
    for (const t of scene.tokens) tokens[t.name] = t.id;
    const sys = gun._getWeaponSystem ? gun._getWeaponSystem() : gun.system;
    return {
      actorId: actor.id, gunId: gun.id, gunName: gun.name, tokens, wasTracking,
      rof: Number(sys.rof), shots: Number(sys.shots), shotsLeft: Number(sys.shotsLeft),
      baselineCards: game.messages.size,
      maxRounds: Math.min(Number(sys.rof), Number(sys.shotsLeft)),
    };
  }, { SCOPE, SCENE, GUN });

  ok(`P0 probe: the bench rifle is a ROF-${setup.rof} automatic with a full magazine`,
    setup.rof === 30 && setup.shotsLeft === setup.shots, `rof ${setup.rof}, ${setup.shotsLeft}/${setup.shots}`);

  /* ── the firing gesture, split so the round field can be written between arm and submit ──── */
  async function arm(mode = "FullAuto") {
    await page.evaluate(async ({ actorId, gunId, tokenId }) => {
      for (let i = 0; i < 2; i++) {
        for (const a of [...foundry.applications.instances.values()]) {
          if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
        }
        await new Promise((r) => setTimeout(r, 900));
      }
      globalThis.__afTap.length = 0;
      canvas.tokens.get(tokenId).setTarget(true, { releaseOthers: true });
      const actor = game.actors.get(actorId);
      await actor.sheet.render(true);
      await new Promise((r) => setTimeout(r, 1500));
      const el = actor.sheet.element.querySelector(`.fire-weapon[data-item-id="${gunId}"]`)
              ?? actor.sheet.element.querySelector(`[data-item-id="${gunId}"] .fire-weapon`);
      if (!el) throw new Error(`no fire control for ${gunId}`);
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }, { actorId: setup.actorId, gunId: setup.gunId, tokenId: setup.tokens[TARGET] });
    await page.waitForFunction(() => [...foundry.applications.instances.values()]
      .some((a) => /ModifiersDialog/.test(a?.constructor?.name ?? "") && a.rendered === true), null, { timeout: 25000 });
    // ⚠ DECLARE THE FIRE MODE RATHER THAN INHERIT IT. The dialog opens on whatever mode the weapon was
    // last fired in, so a run that leant on the default measured a different mode from one section to
    // the next (a section here spent one round instead of thirty before this was pinned).
    //
    // ⚠ AND WRITE IT AFTER THE SETTLE, THEN CHECK IT STUCK. The dialog replaces its own field nodes on
    // the render pass that follows the first paint, so a write issued too early lands on a node that
    // has already been thrown away and reads back correct from that same dead node — which is exactly
    // the shape of the defect this spec exists for. Every write here is verified from a fresh query.
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.waitForTimeout(900);
      const seen = await page.evaluate((want) => {
        const dlg = [...foundry.applications.instances.values()].find((a) => /ModifiersDialog/.test(a?.constructor?.name ?? ""));
        const q = () => dlg.element.querySelector('select[name="fireMode"], select[name="fields.fireMode"]');
        const fm = q();
        if (fm && fm.value !== want) { fm.value = want; fm.dispatchEvent(new Event("change", { bubbles: true })); }
        return q()?.value ?? null;
      }, mode);
      if (seen === mode && attempt >= 1) break;   // seen twice running, not once
    }
    await page.waitForTimeout(600);
  }

  /** Write the round count, then read it back from a FRESH query so a stale node cannot testify. */
  const setRounds = (n) => page.evaluate((v) => {
    const dlg = [...foundry.applications.instances.values()].find((a) => /ModifiersDialog/.test(a?.constructor?.name ?? ""));
    const q = () => dlg.element.querySelector('input[name="fullAutoRoundsFired"], input[name="fields.fullAutoRoundsFired"]');
    const input = q();
    if (!input) return { present: false };
    if (v !== null) {
      input.value = String(v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const after = q();
    // ⚠ BOUNDS ARE `data-min`/`data-max`, NOT NATIVE min/max — the shared number field renders them
    // that way, which is why the dialog has to run the check itself (see the ported validator).
    return { present: true, value: after?.value ?? null,
      min: after?.dataset?.min ?? null, max: after?.dataset?.max ?? null,
      valid: after?.checkValidity?.() ?? null, name: after?.getAttribute("name") ?? null };
  }, n);

  const submitAndSettle = (maxMs = 12000) => page.evaluate(async ({ maxMs }) => {
    const dlg = [...foundry.applications.instances.values()].find((a) => /ModifiersDialog/.test(a?.constructor?.name ?? ""));
    const mode = dlg.element.querySelector('select[name="fireMode"], select[name="fields.fireMode"]')?.value ?? null;
    const btn = dlg.element.querySelector("button.fire, button[type=\"submit\"]");
    if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    else dlg.element.requestSubmit();
    const t0 = performance.now();
    while (performance.now() - t0 < maxMs) {
      await new Promise((r) => setTimeout(r, 100));
      if (globalThis.__afTap.length) break;
    }
    await new Promise((r) => setTimeout(r, 2500));   // let the fan-out and the magazine write land
    return { payloads: globalThis.__afTap.slice(), mode };
  }, { maxMs });

  const shotsLeftNow = () => page.evaluate(({ actorId, gunId }) => {
    const gun = game.actors.get(actorId).items.get(gunId);
    const sys = gun._getWeaponSystem ? gun._getWeaponSystem() : gun.system;
    return Number(sys.shotsLeft);
  }, { actorId: setup.actorId, gunId: setup.gunId });

  const refill = () => page.evaluate(({ actorId, gunId }) => {
    const actor = game.actors.get(actorId);
    const gun = actor.items.get(gunId);
    return actor.updateEmbeddedDocuments("Item", [{ _id: gunId, "system.shotsLeft": Number(gun.system.shots) }]);
  }, { actorId: setup.actorId, gunId: setup.gunId });

  const endEffects = () => page.evaluate(async () => {
    try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none */ }
    await new Promise((r) => setTimeout(r, 800));
  });

  /* ══ 1. THE CHOSEN NUMBER — ten rounds out of a thirty-round ROF ═══════════════════════════ */
  await refill();
  await arm();
  const dom10 = await setRounds(10);
  ok("A1 the dialog carries the base system's own round field (name it reads: fullAutoRoundsFired)",
    dom10.present === true, dom10.present ? dom10.name : "NO SUCH INPUT — the row is still the detached parallel field");
  ok("A2 the field is bounded by the weapon, not by nothing", dom10.min === "1" && dom10.max === String(setup.maxRounds),
    `min ${dom10.min} / max ${dom10.max} (expected 1 / ${setup.maxRounds})`);
  const before10 = await shotsLeftNow();
  const fired10 = await submitAndSettle();
  const card10 = fired10.payloads[0]?.shotsFired ?? null;
  ok("A0 the shot under test really was a full-auto burst", fired10.mode === "FullAuto", `fire mode ${fired10.mode}`);
  ok("A3 the card reports the rounds the shooter chose, not the weapon's ROF", card10 === 10,
    `card says ${card10} of a ROF-${setup.rof} weapon`);
  const after10 = await shotsLeftNow();
  ok("A4 the magazine loses exactly the rounds that were fired", before10 - after10 === 10,
    `${before10} → ${after10} = ${before10 - after10} spent`);

  /* the presentation draws from that same number — one truth, asserted through the rail itself */
  const drawn10 = await page.evaluate(async ({ SCOPE, payload }) => {
    const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);
    const actor = game.actors.getName("Review · Shooter");
    const gun = actor.itemTypes.weapon.find((w) => w.name === payload.weaponName);
    const res = await fx.fxWeaponFired({
      attackerId: actor.id, weaponId: gun.id, weaponName: payload.weaponName,
      shotsFired: payload.shotsFired, shotsHit: 0, areaDamages: {},
    });
    return { shots: res?.shots ?? null, cap: fx.MAX_FX_SHOTS };
  }, { SCOPE, payload: fired10.payloads[0] });
  ok("A5 the presentation draws that same count of rounds", drawn10.shots === 10,
    `rail drew ${drawn10.shots} (cap ${drawn10.cap})`);
  await endEffects();

  /* ══ 2. UNTOUCHED — the default is still the full burst ════════════════════════════════════ */
  await refill();
  await arm();
  const domDefault = await setRounds(null);
  ok("B1 leaving the field alone offers the full burst", domDefault.value === String(setup.maxRounds),
    `field defaulted to ${domDefault.value}, expected ${setup.maxRounds}`);
  const beforeFull = await shotsLeftNow();
  const firedFull = await submitAndSettle();
  ok("B0 the shot under test really was a full-auto burst", firedFull.mode === "FullAuto", `fire mode ${firedFull.mode}`);
  ok("B2 an untouched field still fires the whole ROF (the shipped behaviour is unchanged)",
    (firedFull.payloads[0]?.shotsFired ?? null) === setup.maxRounds,
    `card says ${firedFull.payloads[0]?.shotsFired}`);
  const afterFull = await shotsLeftNow();
  ok("B3 and the magazine agrees with it", beforeFull - afterFull === setup.maxRounds,
    `${beforeFull} → ${afterFull} = ${beforeFull - afterFull} spent`);
  await endEffects();

  /* ══ 3. THE CLAMP, at both ends — the field refuses, the fire path backstops ══════════════ */
  // ⭐ TWO LINES OF DEFENCE, AND THEY DO DIFFERENT JOBS. The dialog now runs the base system's own
  // bounds check, so an out-of-range number never reaches a submit at all — the shooter is told
  // instead of being silently cut short. Behind that, `_resolveFullAutoRounds` still clamps anything
  // that arrives by another road (a macro, a relayed payload, a future caller). Both are asserted:
  // the refusal through the real form, the clamp through the resolver the fire path actually calls.
  await refill();
  await arm();
  const domHigh = await setRounds(99);
  ok("C1 a number above the weapon's maximum is marked invalid by the field itself",
    domHigh.valid === false, `checkValidity() = ${domHigh.valid} for 99 with data-max ${domHigh.max}`);
  const beforeHigh = await shotsLeftNow();
  const firedHigh = await submitAndSettle(4000);
  ok("C2 an invalid burst length is refused: no shot is resolved",
    firedHigh.payloads.length === 0, `${firedHigh.payloads.length} card(s): ${JSON.stringify(firedHigh.payloads)}`);
  ok("C3 and the magazine is untouched by the refusal", (await shotsLeftNow()) === beforeHigh,
    `${beforeHigh} → ${await shotsLeftNow()}`);
  await endEffects();

  await refill();
  await arm();
  const domLow = await setRounds(0);
  ok("C4 zero is marked invalid by the field itself", domLow.valid === false,
    `checkValidity() = ${domLow.valid} for 0 with data-min ${domLow.min}`);
  const beforeLow = await shotsLeftNow();
  const firedLow = await submitAndSettle(4000);
  ok("C5 a zero burst length is refused too", firedLow.payloads.length === 0,
    `${firedLow.payloads.length} card(s)`);
  ok("C6 and the magazine is untouched by that refusal too", (await shotsLeftNow()) === beforeLow,
    `${beforeLow} → ${await shotsLeftNow()}`);
  await endEffects();

  /* the backstop, read from the site the fire path itself calls */
  const clampBackstop = await page.evaluate(({ actorId, gunId }) => {
    const gun = game.actors.get(actorId).items.get(gunId);
    const sys = gun._getWeaponSystem ? gun._getWeaponSystem() : gun.system;
    const R = (n) => gun.constructor._resolveFullAutoRounds({ fullAutoRoundsFired: n }, sys);
    return { max: Math.min(Number(sys.rof), Number(sys.shotsLeft)),
      high: R(99), zero: R(0), neg: R(-5), nan: R("abc"), absent: R(undefined), ten: R(10) };
  }, { actorId: setup.actorId, gunId: setup.gunId });
  ok("C7 backstop: a request above the maximum clamps down to it",
    clampBackstop.high === clampBackstop.max, `99 → ${clampBackstop.high} (max ${clampBackstop.max})`);
  ok("C8 backstop: zero, negative, unparseable and absent all read as no preference — the full burst",
    clampBackstop.zero === clampBackstop.max && clampBackstop.neg === clampBackstop.max
    && clampBackstop.nan === clampBackstop.max && clampBackstop.absent === clampBackstop.max,
    `0→${clampBackstop.zero} -5→${clampBackstop.neg} "abc"→${clampBackstop.nan} absent→${clampBackstop.absent}`);
  ok("C9 backstop: an in-range request is passed through untouched",
    clampBackstop.ten === 10, `10 → ${clampBackstop.ten}`);

  /* ══ 4. THE TO-HIT MATHS READS THE SAME NUMBER ═════════════════════════════════════════════ */
  // +1/-1 per ten rounds at close range: ten rounds is +1, thirty is +3. Read through the base's own
  // modifier builder so this is the shipped arithmetic and not a copy of it.
  await refill();   // the term is per TEN rounds of min(ROF, shotsLeft) — an empty gun floors it to 0
  const mods = await page.evaluate(({ actorId, gunId }) => {
    const gun = game.actors.get(actorId).items.get(gunId);
    const call = (n) => gun.__shootModTerms({
      aimRounds: 0, ambush: false, blinded: false, dualWield: false, fastDraw: false, hipfire: false,
      ricochet: false, running: false, targetArea: "", turningToFace: false,
      range: "RangeClose", fireMode: "FullAuto", extraMod: 0, fullAutoRoundsFired: n,
    });
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    return { ten: sum(call(10)), thirty: sum(call(30)) };
  }, { actorId: setup.actorId, gunId: setup.gunId });
  ok("D1 ten rounds at close range is worth +1 to hit", mods.ten === 1, `terms sum to ${mods.ten}`);
  ok("D2 thirty rounds at close range is worth +3 to hit", mods.thirty === 3, `terms sum to ${mods.thirty}`);
  ok("D3 the to-hit maths moves with the chosen count (one number, two readers)",
    mods.thirty > mods.ten, `${mods.ten} vs ${mods.thirty}`);

  /* ══ 5. THE SUPPRESSIVE DECLARATION IS CHECKED BEFORE IT IS BELIEVED ══════════════════════ */
  // A suppressive burst is DECLARED: so many rounds, down a corridor so many metres wide, at so many
  // people. The base derives its evasion DC from those three numbers, and every one of them is silently
  // rewritten downstream if it arrives wrong — rounds clamped into the magazine, width floored to two
  // metres, count read as one. So a bad declaration never misfires; it LIES, and the card quotes numbers
  // the shooter never asked for. The base dialog refuses instead. These legs drive the real window.
  // ⚠ A SUPPRESSIVE BURST RAISES ITS OWN EVENT, NOT the one the sections above tap: it renders the
  // suppressive card, not the multi-hit card, so `__afTap` stays empty whether the shot happened or not.
  // Reading the refusal off that tap would have passed on a run where the burst fired anyway — which is
  // exactly what the pre-fix measurement showed (thirty rounds gone, tap empty). The suppressive event
  // is tapped here and the magazine is read as the second, independent witness.
  const readSup = () => page.evaluate(() => {
    const dlg = [...foundry.applications.instances.values()].find((a) => /ModifiersDialog/.test(a?.constructor?.name ?? ""));
    if (!dlg?.element) return { open: false };
    const q = (n) => dlg.element.querySelector(`input[name="${n}"], input[name="fields.${n}"]`);
    const one = (n) => {
      const el = q(n);
      return el ? { value: el.value, min: el.dataset.min ?? null, max: el.dataset.max ?? null, valid: el.checkValidity() } : null;
    };
    return { open: true, rounds: one("roundsFired"), width: one("zoneWidth"), targets: one("targetsCount") };
  });

  /** Write the three declaration fields, then read them back from fresh queries. */
  const setSup = ({ rounds, width, targets }) => page.evaluate((vals) => {
    const dlg = [...foundry.applications.instances.values()].find((a) => /ModifiersDialog/.test(a?.constructor?.name ?? ""));
    if (!dlg?.element) return { open: false };
    const q = (n) => dlg.element.querySelector(`input[name="${n}"], input[name="fields.${n}"]`);
    for (const [name, v] of Object.entries({ roundsFired: vals.rounds, zoneWidth: vals.width, targetsCount: vals.targets })) {
      if (v === undefined) continue;
      const el = q(name);
      if (!el) continue;
      el.value = String(v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const one = (n) => { const el = q(n); return el ? { value: el.value, valid: el.checkValidity() } : null; };
    return { open: true, rounds: one("roundsFired"), width: one("zoneWidth"), targets: one("targetsCount"),
      gate: dlg._cpValidateOnSubmit ? dlg._cpValidateOnSubmit() : null,
      formValid: dlg.element.checkValidity?.() ?? null };
  }, { rounds, width, targets });

  /** Submit and wait on the SUPPRESSIVE event (and nothing else), returning what it carried. */
  const submitSup = (maxMs) => page.evaluate(async ({ maxMs }) => {
    globalThis.__supTap.length = 0;
    const dlg = [...foundry.applications.instances.values()].find((a) => /ModifiersDialog/.test(a?.constructor?.name ?? ""));
    if (!dlg?.element) return { open: false, payloads: [] };
    const btn = dlg.element.querySelector('button.fire, button[type="submit"]');
    if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    else dlg.element.requestSubmit();
    const t0 = performance.now();
    while (performance.now() - t0 < maxMs) {
      await new Promise((r) => setTimeout(r, 100));
      if (globalThis.__supTap.length) break;
    }
    await new Promise((r) => setTimeout(r, 1800));   // let the magazine write land
    return { open: true, payloads: globalThis.__supTap.slice() };
  }, { maxMs });

  // ⚠ The zone automation is switched OFF for this section and restored after. With it on, the shooter's
  // client enters the canvas placement preview and waits for a gesture a headless run cannot make; the
  // base suppressive flow is what these legs measure, and that is untouched by the setting.
  const zonesWere = await page.evaluate(async () => {
    const was = game.settings.get("cp2020-augmented", "suppressiveFireSaves");
    if (was) await game.settings.set("cp2020-augmented", "suppressiveFireSaves", false);
    globalThis.__supTap = [];
    globalThis.__supHook = Hooks.on("cyberpunk2020.suppressiveFire", (p) => globalThis.__supTap.push(p));
    return was;
  });

  await refill();
  await arm("Suppressive");
  const supBounds = await readSup();
  ok("E1 the declaration rows carry their bounds (the validator reads them from the row, not from nowhere)",
    supBounds.rounds?.max === String(setup.maxRounds) && supBounds.rounds?.min === "1"
    && supBounds.width?.min === "2" && supBounds.targets?.min === "1",
    `rounds ${supBounds.rounds?.min}..${supBounds.rounds?.max}, width min ${supBounds.width?.min}, targets min ${supBounds.targets?.min}`);

  // ⚠ ONE COMPLAINT AT A TIME, IN ORDER — the base system's validator stops at the first row it can
  // fault, which is why each row is faulted on its own here rather than all three at once. (Setting all
  // three wrong and expecting three complaints measures a validator nobody wrote: the first fault
  // returns, and the two rows behind it are never examined, so they read as valid.)
  const supRounds = await setSup({ rounds: 99, width: 3, targets: 2 });
  ok("E2 more rounds than the magazine holds is refused", supRounds.rounds?.valid === false,
    `checkValidity() = ${supRounds.rounds?.valid} for 99 against max ${setup.maxRounds}`);
  ok("E3 the submit gate says no while the round count is out of range", supRounds.gate === false,
    `gate returned ${supRounds.gate}`);

  const supWidth = await setSup({ rounds: 10, width: 0, targets: 2 });
  ok("E4 a corridor of no width is refused", supWidth.width?.valid === false,
    `checkValidity() = ${supWidth.width?.valid} for width 0 against min 2`);

  const supTargets = await setSup({ rounds: 10, width: 3, targets: 0 });
  ok("E5 a burst aimed at nobody is refused", supTargets.targets?.valid === false,
    `checkValidity() = ${supTargets.targets?.valid} for 0 targets`);

  const supBad = await setSup({ rounds: 99, width: 0, targets: 0 });
  ok("E5b the whole bad declaration is refused at the gate", supBad.gate === false, `gate returned ${supBad.gate}`);
  const beforeSup = await shotsLeftNow();
  const firedSup = await submitSup(4000);
  ok("E6 the refusal holds at the form: nothing is resolved", firedSup.payloads.length === 0,
    `${firedSup.payloads.length} suppressive event(s)`);
  const afterSup = await shotsLeftNow();
  ok("E7 and the magazine is untouched by it", afterSup === beforeSup, `${beforeSup} → ${afterSup}`);

  /* the positive counterpart: a legal declaration passes the same gate and reaches the fire path */
  const supGood = await setSup({ rounds: 10, width: 3, targets: 2 });
  ok("E8 a legal declaration is accepted by the same gate", supGood.gate === true && supGood.formValid === true,
    `gate ${supGood.gate}, form validity ${supGood.formValid}`);
  const beforeGood = await shotsLeftNow();
  const firedGood = await submitSup(10000);
  const supPayload = firedGood.payloads[0] ?? null;
  ok("E9 the declared round count is the one the fire path lays down", supPayload?.roundsFired === 10,
    `event says ${supPayload?.roundsFired}`);
  ok("E10 the declared corridor width travels with it", supPayload?.zoneWidth === 3, `event says ${supPayload?.zoneWidth}`);
  const afterGood = await shotsLeftNow();
  ok("E11 and the magazine loses exactly the declared rounds", beforeGood - afterGood === 10,
    `${beforeGood} → ${afterGood}`);
  await page.evaluate(async (was) => {
    try { Hooks.off("cyberpunk2020.suppressiveFire", globalThis.__supHook); } catch (e) { /* not hooked */ }
    if (was) await game.settings.set("cp2020-augmented", "suppressiveFireSaves", was);
  }, zonesWere);
  await endEffects();

  /* ══ 6. THE MAGAZINE CAN CHANGE WHILE THE WINDOW IS OPEN — the ceiling has to move with it ═══ */
  // Reload and Unload sit in this same window, beside the button that fires. Both rewrite the magazine
  // the round fields are bounded by, and the bounds were computed when the rows were built. Left alone,
  // a reload leaves the ceiling stale LOW (the field refuses a burst the gun can now fire) and an unload
  // leaves it stale HIGH (the field accepts a burst out of an empty gun and the fire path cuts it
  // silently — the road back into the defect the round-count fix closed).
  // Open on a nearly-empty gun so the ceiling starts LOW and the reload has something to raise.
  const setShots = (n) => page.evaluate(({ actorId, gunId, n }) =>
    game.actors.get(actorId).updateEmbeddedDocuments("Item", [{ _id: gunId, "system.shotsLeft": n }]),
    { actorId: setup.actorId, gunId: setup.gunId, n });

  await setShots(5);
  await arm();
  const lowCeiling = await setRounds(setup.maxRounds);
  ok("F1 the ceiling is the loaded rounds, not the weapon's rate", lowCeiling.max === "5", `data-max ${lowCeiling.max}`);
  ok("F2 a burst longer than the loaded rounds is refused", lowCeiling.valid === false,
    `checkValidity() = ${lowCeiling.valid} for ${setup.maxRounds} against data-max 5`);

  const afterReload = await page.evaluate(async () => {
    const dlg = [...foundry.applications.instances.values()].find((a) => /ModifiersDialog/.test(a?.constructor?.name ?? ""));
    dlg.element.querySelector("button.reload")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 3000));
    const q = (n) => dlg.element.querySelector(`input[name="${n}"], input[name="fields.${n}"]`);
    const one = (n) => { const el = q(n); return el ? { value: el.value, max: el.dataset.max ?? null, valid: el.checkValidity() } : null; };
    return { auto: one("fullAutoRoundsFired"), sup: one("roundsFired"),
      gate: dlg._cpValidateOnSubmit ? dlg._cpValidateOnSubmit() : null };
  });
  const reloadedLeft = await shotsLeftNow();
  ok("F3 reloading in the window raises the ceiling to the reloaded magazine",
    afterReload.auto?.max === String(Math.min(setup.rof, reloadedLeft)),
    `data-max ${afterReload.auto?.max} against ${reloadedLeft} loaded (ROF ${setup.rof})`);
  ok("F4 and the field that was refused a moment ago now passes, untouched by the shooter",
    afterReload.auto?.valid === true && afterReload.gate === true,
    `valid ${afterReload.auto?.valid}, gate ${afterReload.gate}`);
  ok("F5 the suppressive round field is raised by the same reload",
    afterReload.sup?.max === String(Math.min(setup.rof, reloadedLeft)), `data-max ${afterReload.sup?.max}`);

  // The other direction. An emptied magazine cannot complain its way out of trouble — with no rounds
  // loaded the check stands down entirely (the weapon roll's own NoAmmo guard owns that case), so what
  // has to be true is that the window stops OFFERING a burst: ceiling and value both fall to nothing.
  const afterUnload = await page.evaluate(async () => {
    const dlg = [...foundry.applications.instances.values()].find((a) => /ModifiersDialog/.test(a?.constructor?.name ?? ""));
    dlg.element.querySelector("button.unload")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 2500));
    const q = (n) => dlg.element.querySelector(`input[name="${n}"], input[name="fields.${n}"]`);
    const one = (n) => { const el = q(n); return el ? { value: el.value, max: el.dataset.max ?? null } : null; };
    return { auto: one("fullAutoRoundsFired"), sup: one("roundsFired") };
  });
  ok("F6 emptying the magazine drops the burst ceiling to nothing",
    afterUnload.auto?.max === "0" && afterUnload.auto?.value === "0",
    `data-max ${afterUnload.auto?.max}, value ${afterUnload.auto?.value}`);
  ok("F7 the suppressive round field's ceiling drops with it",
    afterUnload.sup?.max === "0" && afterUnload.sup?.value === "0",
    `data-max ${afterUnload.sup?.max}, value ${afterUnload.sup?.value}`);
  ok("F8 the emptied magazine is really empty", (await shotsLeftNow()) === 0, await shotsLeftNow());
  await page.evaluate(async () => {
    for (const a of [...foundry.applications.instances.values()]) {
      if (/Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
    }
  });

  /* ══ RESTORE ═══════════════════════════════════════════════════════════════════════════════ */
  const restored = await page.evaluate(async ({ SCOPE, actorId, gunId, baselineCards, wasTracking }) => {
    for (const a of [...foundry.applications.instances.values()]) {
      if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
    }
    try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none */ }
    const actor = game.actors.get(actorId);
    const gun = actor.items.get(gunId);
    await actor.updateEmbeddedDocuments("Item", [{ _id: gunId, "system.shotsLeft": Number(gun.system.shots) }]);
    const ammo = actor.itemTypes.ammo.filter((a) => a.getFlag(SCOPE, "reviewBench"))
      .map((a) => ({ _id: a.id, "system.quantity": 60 }));
    if (ammo.length) await actor.updateEmbeddedDocuments("Item", ammo);
    for (const m of [...game.messages].slice(baselineCards)) { try { await m.delete(); } catch (e) { /* gone */ } }
    const scene = game.scenes.get(globalThis.__BENCH_SCENE_ID);
    const t = scene.tokens.find((x) => x.name === "Review · Target");
    for (const a of new Set([t?.actor, game.actors.get(t?.actorId)].filter(Boolean))) {
      if (a.system?.damage !== undefined) await a.update({ "system.damage": 0 });
    }
    // Top the magazine BEFORE the reading below: `maxRounds` is min(ROF, shotsLeft), so a run that
    // started on a half-empty gun would measure its own leftovers as the weapon's ceiling.
    await actor.updateEmbeddedDocuments("Item", [{ _id: gun.id, "system.shotsLeft": Number(gun.system.shots) }]);
    const ff = await import(`/modules/${SCOPE}/module/mech/free-fire.js`);
    if (!wasTracking) await ff.setAmmoTracking(actor, false);
    [...game.user.targets].forEach((x) => x.setTarget(false, { releaseOthers: false }));
    try { await actor.sheet.close(); } catch (e) { /* closed */ }
    await new Promise((r) => setTimeout(r, 900));
    const sys = gun._getWeaponSystem ? gun._getWeaponSystem() : gun.system;
    return { shotsLeft: Number(sys.shotsLeft), shots: Number(sys.shots), cards: game.messages.size,
      tracking: ff.ammoTrackingOn(actor),
      liveFx: (globalThis.Sequencer?.EffectManager?.effects ?? [])
        .filter((e) => !String(e?.data?.name ?? "").startsWith(`${SCOPE}.statusfx.`)).length };
  }, { SCOPE, actorId: setup.actorId, gunId: setup.gunId, baselineCards: setup.baselineCards, wasTracking: setup.wasTracking });

  ok("restore: the magazine is full again", restored.shotsLeft === restored.shots,
    `${restored.shotsLeft}/${restored.shots}`);
  ok("restore: ammo tracking is back where this run found it", restored.tracking === setup.wasTracking,
    `${restored.tracking} vs ${setup.wasTracking}`);
  ok("restore: the chat log is back to where this run found it", restored.cards === setup.baselineCards,
    `${restored.cards} vs ${setup.baselineCards}`);
  ok("restore: no shot transient is left on the canvas", restored.liveFx === 0, restored.liveFx);
  ok("0 page errors", pageErrors.length === 0, pageErrors.slice(0, 4).join(" | "));
} finally {
  console.log(out.join("\n"));
  console.log(`\n${out.length - fails}/${out.length} checks passed`);
  await browser.close();
}
process.exit(fails ? 1 : 0);
