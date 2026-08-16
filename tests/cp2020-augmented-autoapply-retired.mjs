/**
 * KEEPER: the world-wide auto-apply route is RETIRED.
 *
 * MECHANISM UNDER TEST. A single world setting used to decide, for the whole table, whether a resolved
 * shot opened a confirmation window at all. Switched on — which three of the four presets did silently
 * — damage was written the instant a shot resolved, with nothing to look at and nothing to refuse. The
 * ruling removed the feature rather than re-defaulting it: whether a given instance of damage is
 * applied is answered at that instance, in that instance's window.
 *
 *   §1 the key is not registered, and reading it fails
 *   §2 no preset references it, and every tier still applies and undoes cleanly
 *   §3 the settings page shows no control for it (with the section it sat in as a positive control)
 *   §4 its i18n keys are gone, leaving no orphan (with a live neighbour as a positive control)
 *   §5 a multi-hit resolution ALWAYS opens the window — asserted in BOTH former world states, i.e.
 *      with no stored value and with the retired key's old `true` still sitting in world storage
 *   §6 the batch ledger closes on that window path: one progression card, one mortal prompt, two cards
 *   §7 the retirement migration drops the orphaned world doc on the next load (asserted across a real
 *      page reload, which is the only thing that runs the boot migration)
 *
 * ⛔ Every fixture is named __PWK__NOAUTO and is removed on the way out; every world setting this spec
 * pins is restored in a finally block (world-state debris has reddened unrelated suites before).
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

const joinGM = async () => {
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
};
await joinGM();

const res = await page.evaluate(async () => {
  const SCOPE = "cp2020-augmented";
  const KEY = "damageAutoApply";
  const QUALIFIED = `${SCOPE}.${KEY}`;
  const out = { checks: [] };
  const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  if (!game.scenes.active) await game.scenes.contents[0]?.activate();
  const scene = game.scenes.active ?? game.scenes.contents[0];

  const presets = await import(`/modules/${SCOPE}/module/presets.js`);

  const CARD = { progression: "severity-progression", mortalPrompt: "death-save-prompt" };
  const since = () => new Set(game.messages.map(m => m.id));
  const startedAt = since();
  const count = (mark, from) => [...game.messages].filter(m => !from.has(m.id) && (m.content ?? "").includes(mark)).length;
  const wipeSince = async (from) => {
    for (const m of [...game.messages].filter(m => !from.has(m.id))) await m.delete().catch(() => {});
  };
  const worldDoc = () => game.settings?.storage?.get?.("world")?.find?.(s => s.key === QUALIFIED) ?? null;

  const KEYS = ["limbLossEnabled", "limbModel", "damageArmorMode", "damageAblation", "headHitDoubling",
                "rerollGoneLimbLocation", "combatFxEnabled", "combatAutomationEnabled"];
  const was = {};
  for (const k of KEYS) { try { was[k] = game.settings.get(SCOPE, k); } catch { was[k] = null; } }
  const set = async (k, v) => { try { await game.settings.set(SCOPE, k, v); } catch (e) { /* unregistered */ } };

  let shooter = null, target = null, shooterTok = null, targetTok = null;

  try {
    /* ── §1  the key is not registered ────────────────────────────────────────────────────────── */
    ok("§1 the retired key has no registration in the settings map (negative)",
       game.settings.settings.has(QUALIFIED) === false, `has=${game.settings.settings.has(QUALIFIED)}`);
    const readFailed = (() => { try { game.settings.get(SCOPE, KEY); return false; } catch (e) { return true; } })();
    ok("§1 and reading it throws rather than answering a value", readFailed === true, `threw=${readFailed}`);
    ok("§1 positive control: a neighbouring damage setting IS still registered",
       game.settings.settings.has(`${SCOPE}.damageAblation`) === true, "damageAblation");

    /* ── §2  no preset references it ──────────────────────────────────────────────────────────── */
    const keys = presets.presetKeys();
    ok("§2 the preset key universe does not contain the retired key (negative)",
       keys.includes(KEY) === false, `${keys.length} keys`);
    const tiersWithKey = presets.PRESETS.filter(p => Object.prototype.hasOwnProperty.call(p.settings, KEY)).map(p => p.id);
    ok("§2 no tier's resolved value map carries it (negative)",
       tiersWithKey.length === 0, `tiers=${JSON.stringify(tiersWithKey)}`);
    const feat = presets.presetChanges("standard", presets.currentSettings()).featuresOn.map(f => f.id);
    ok("§2 the Standard tier's confirm names no auto-apply feature (negative)",
       feat.includes("autoApply") === false, `featuresOn=${JSON.stringify(feat)}`);
    // A tier applies and undoes cleanly with the key gone — the write loop must not touch a key nothing
    // registers (game.settings.set throws for one), and the undo must put every value back.
    const beforePreset = presets.currentSettings();
    const applied = await presets.applyPreset("standard");
    await sleep(400);
    const snapHasKey = applied ? Object.prototype.hasOwnProperty.call(applied.snapshot, KEY) : true;
    await presets.undoPreset(applied?.snapshot);
    await sleep(400);
    const afterPreset = presets.currentSettings();
    const drifted = keys.filter(k => beforePreset[k] !== afterPreset[k]);
    ok("§2 a tier applies and its snapshot names no retired key (negative)",
       !!applied && snapHasKey === false, `applied=${!!applied} snapshotHasKey=${snapHasKey}`);
    ok("§2 and the one-step undo restored every preset-controlled value, by value",
       drifted.length === 0, `drifted=${JSON.stringify(drifted)}`);

    /* ── §3  the settings page offers no control for it ───────────────────────────────────────── */
    const sheet = game.settings.sheet;
    await sheet.render(true);
    await sleep(1200);
    const sheetRoot = sheet.element;
    const retiredCtl = sheetRoot?.querySelector(`[name="${QUALIFIED}"]`) ?? null;
    const liveCtl = sheetRoot?.querySelector(`[name="${SCOPE}.damageAblation"]`) ?? null;
    ok("§3 the settings page renders no control for the retired key (negative)",
       retiredCtl === null, `found=${!!retiredCtl}`);
    ok("§3 positive control: the section it sat in still renders its other controls",
       liveCtl !== null, `damageAblation control=${!!liveCtl}`);
    await sheet.close().catch(() => {});
    await sleep(300);

    /* ── §4  its i18n keys are gone, with no orphan left behind ───────────────────────────────── */
    ok("§4 the retired setting's name/hint keys no longer resolve (negative)",
       game.i18n.has("SETTINGS.DamageAutoApply") === false && game.i18n.has("SETTINGS.DamageAutoApplyHint") === false,
       `name=${game.i18n.has("SETTINGS.DamageAutoApply")} hint=${game.i18n.has("SETTINGS.DamageAutoApplyHint")}`);
    ok("§4 the preset feature label for it is gone too (negative)",
       game.i18n.has("CYBERPUNK.PresetFeatureAutoApply") === false,
       String(game.i18n.has("CYBERPUNK.PresetFeatureAutoApply")));
    ok("§4 positive control: a neighbouring setting's name key still resolves",
       game.i18n.has("SETTINGS.DamageAblation") === true, "SETTINGS.DamageAblation");

    /* ── fixtures for the behaviour legs ──────────────────────────────────────────────────────── */
    await set("limbLossEnabled", true);
    await set("limbModel", "core");
    await set("damageArmorMode", "none");
    await set("damageAblation", false);
    await set("headHitDoubling", true);
    await set("rerollGoneLimbLocation", false);
    await set("combatAutomationEnabled", true);
    await set("combatFxEnabled", false);

    for (const t of [...(scene.tokens ?? [])].filter(t => t.name?.startsWith("__PWK__NOAUTO"))) {
      await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});
    }
    for (const a of [...game.actors].filter(a => a.name?.startsWith("__PWK__NOAUTO"))) await a.delete().catch(() => {});
    await sleep(250);

    shooter = await Actor.create({ name: "__PWK__NOAUTO Shooter", type: "character" });
    target  = await Actor.create({ name: "__PWK__NOAUTO Target",  type: "character" });
    // actorLink: true — an unlinked token's engine reads a different document than the spec does.
    // ⚠ RESOLVED BY NAME, never by return position (createEmbeddedDocuments does not promise order).
    const made = await scene.createEmbeddedDocuments("Token", [
      { name: "__PWK__NOAUTO Shooter", actorId: shooter.id, actorLink: true, x: 300, y: 1600, width: 1, height: 1, rotation: 0 },
      { name: "__PWK__NOAUTO Target",  actorId: target.id,  actorLink: true, x: 700, y: 1600, width: 1, height: 1 },
    ]);
    const byName = (n) => made.find(t => t.name === n) ?? [...scene.tokens].find(t => t.name === n);
    shooterTok = byName("__PWK__NOAUTO Shooter");
    targetTok  = byName("__PWK__NOAUTO Target");
    await sleep(300);
    const btm = Number(target.system.stats?.bt?.modifier) || 0;
    ok("fixture: linked target token resolves to the fixture actor",
       targetTok?.actor === target, `btm=${btm}`);

    const damageWindows = () =>
      [...foundry.applications.instances.values()].filter(a => /DamageDialog/.test(a?.constructor?.name ?? ""));
    // Fire, then report what the resolution DID — did a window open, and had anything been written by
    // the time it did. The second half is the measurement the retired feature would fail.
    const fire = async (areaDamages, { apply = true } = {}) => {
      for (const w of damageWindows()) { try { await w.close(); } catch (e) { /* already closed */ } }
      const payload = {
        attackerId: shooter.id, weaponName: "__PWK__NOAUTO Rounds",
        areaDamages, shotsFired: 1, shotsHit: 1,
        targetTokenId: targetTok.id, fxTargetTokenId: targetTok.id, firedByUserId: game.user.id,
        caliber: "5.56", modifier: "standard", spreadMode: "single",
      };
      const before = Number(target.system.damage) || 0;
      Hooks.callAll("cyberpunk2020.weaponFired", payload);
      for (let i = 0; i < 80 && damageWindows().length === 0; i++) await sleep(100);
      const win = damageWindows()[0] ?? null;
      const atWindow = Number(target.system.damage) || 0;
      const ctl = win?.element?.querySelector('[data-action="applyDamage"]') ?? null;
      if (apply && ctl) {
        ctl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        for (let i = 0; i < 80 && damageWindows().length > 0; i++) await sleep(100);
        await sleep(1200);
      } else {
        for (const w of damageWindows()) { try { await w.close(); } catch (e) { /* already closed */ } }
        await sleep(400);
      }
      return { opened: !!ctl, before, atWindow, after: Number(target.system.damage) || 0 };
    };
    const rounds = (n, dmg) => Array.from({ length: n }, () => ({ damage: dmg }));

    /* ── §5a  no stored value: the window opens and nothing is written before it ──────────────── */
    ok("§5a precondition: world storage holds no value for the retired key",
       worldDoc() === null, `doc=${!!worldDoc()}`);
    await target.update({ "system.damage": 0 });
    let from = since();
    const r5a = await fire({ Torso: rounds(3, 6 + btm) });
    ok("§5a a multi-hit resolution opens the confirmation window",
       r5a.opened === true, JSON.stringify(r5a));
    ok("§5a and NOTHING was written before it opened (negative — this is the retired behaviour)",
       r5a.atWindow === 0, JSON.stringify(r5a));
    ok("§5a the window's own apply is what writes the damage, by value",
       r5a.after === 18, JSON.stringify(r5a));
    await wipeSince(from);

    /* ── §5b  the old `true` still in world storage changes nothing ───────────────────────────── */
    // A world that HAD the feature on keeps the orphaned doc until the boot migration drops it (§7).
    // Nothing reads it, so the window opens exactly as above — that is the ruled outcome.
    let stored = false;
    try { await Setting.create({ key: QUALIFIED, value: JSON.stringify(true) }); stored = !!worldDoc(); }
    catch (e) { stored = false; }
    ok("§5b the retired key's old TRUE was placed back into world storage (precondition)",
       stored === true, `doc=${!!worldDoc()}`);
    await target.update({ "system.damage": 0 });
    from = since();
    const r5b = await fire({ Torso: rounds(3, 6 + btm) });
    ok("§5b the window still opens with the old value present — nothing reads it",
       r5b.opened === true, JSON.stringify(r5b));
    ok("§5b and still nothing is written before the window (negative)",
       r5b.atWindow === 0, JSON.stringify(r5b));
    ok("§5b the same apply writes the same value",
       r5b.after === 18, JSON.stringify(r5b));
    await wipeSince(from);

    /* ── §6  the batch ledger closes on the window path ───────────────────────────────────────── */
    await target.update({ "system.damage": 0 });
    await target.unsetFlag(SCOPE, "fleshLimbStatus").catch(() => {});
    from = since();
    const r6 = await fire({ rArm: rounds(5, 20 + btm) });
    const totals = { progression: count(CARD.progression, from), mortal: count(CARD.mortalPrompt, from),
                     all: [...game.messages].filter(m => !from.has(m.id)).length };
    ok("§6 the window applied five events in one batch, by value",
       r6.opened === true && r6.after === 100, JSON.stringify(r6));
    ok("§6 one consolidated progression card for the batch", totals.progression === 1, JSON.stringify(totals));
    ok("§6 one mortal prompt for the batch", totals.mortal === 1, JSON.stringify(totals));
    ok("§6 two cards in total — the cadence unit's counts, unchanged by this unit",
       totals.all === 2, JSON.stringify(totals));
    await wipeSince(from);
    await target.update({ "system.damage": 0 });
    await target.unsetFlag(SCOPE, "fleshLimbStatus").catch(() => {});

  } catch (err) {
    ok("spec ran to completion", false, String(err?.message ?? err));
  } finally {
    for (const a of [...foundry.applications.instances.values()].filter(a => /DamageDialog/.test(a?.constructor?.name ?? ""))) {
      try { await a.close(); } catch (e) { /* already closed */ }
    }
    for (const t of [...(scene.tokens ?? [])].filter(t => t.name?.startsWith("__PWK__NOAUTO"))) {
      await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});
    }
    for (const a of [...game.actors].filter(a => a.name?.startsWith("__PWK__NOAUTO"))) await a.delete().catch(() => {});
    await wipeSince(startedAt);
    for (const k of KEYS) if (was[k] !== null) await set(k, was[k]);
    // The orphaned doc from §5b is deliberately LEFT for the reload leg to observe.
    out.orphanBeforeReload = !!worldDoc();
    out.cleanup = {
      fixtures: [...game.actors].filter(a => a.name?.startsWith("__PWK__NOAUTO")).length,
      strayCards: [...game.messages].filter(m => !startedAt.has(m.id)).length,
    };
  }
  return out;
});

/* ── §7  the boot migration drops the orphaned world doc — asserted across a real reload ─────── */
await joinGM();
await page.waitForTimeout(4000);
const after = await page.evaluate(async () => {
  const QUALIFIED = "cp2020-augmented.damageAutoApply";
  const doc = () => game.settings?.storage?.get?.("world")?.find?.(s => s.key === QUALIFIED) ?? null;
  const present = !!doc();
  if (present) { try { await doc().delete(); } catch (e) { /* leave it */ } }   // never leave debris
  return { present, cleared: !doc() };
});

for (const c of res.checks) {
  console.log(`  ${c.p ? "PASS" : "FAIL"}: ${c.n}${c.d ? ` — ${c.d}` : ""}`);
  c.p ? pass++ : fail++;
}
const migrated = res.orphanBeforeReload === true && after.present === false;
console.log(`  ${migrated ? "PASS" : "FAIL"}: §7 the boot migration dropped the orphaned world doc on the next load — ${JSON.stringify({ before: res.orphanBeforeReload, after: after.present })}`);
migrated ? pass++ : fail++;
const clean = (res.cleanup?.fixtures ?? 0) === 0 && (res.cleanup?.strayCards ?? 0) === 0 && after.cleared === true;
console.log(`  ${clean ? "PASS" : "FAIL"}: cleanup — fixtures, cards and the orphaned doc removed (${JSON.stringify({ ...res.cleanup, docCleared: after.cleared })})`);
clean ? pass++ : fail++;
console.log(`\nconsole errors: ${errors.length}`);
errors.slice(0, 6).forEach(e => console.log("  ERR:", String(e).slice(0, 200)));
console.log(`RESULT: ${fail === 0 && errors.length === 0 ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
