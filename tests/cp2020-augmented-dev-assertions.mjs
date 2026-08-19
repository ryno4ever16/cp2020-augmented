/**
 * DIAGNOSTICS UNIT (:30004) — the two per-user checks in module/dev/.
 *
 * ① FIELD ASSERTIONS. A `prepareData` post-step that walks a prepared document's `system` for
 *    numbers that came out unusable (NaN / infinite) and for empty numeric fields, and says so once
 *    per document per session. The legs below prove the OFF position is silent, the ON position
 *    names the exact path once, and a second preparation of the same document does not repeat it.
 *
 * ② WALK ERROR COLLECTOR. Two window listeners feeding a bounded ring, plus a GM-only export that
 *    writes the ring into a journal entry. The legs prove the OFF position collects nothing, the ON
 *    position collects a dispatched fault (choosing the MODULE frame out of the stack rather than
 *    the first frame), the export writes the entry text, and switching it off detaches — a fault
 *    after the toggle does not land.
 *
 * HOW THE UNUSABLE NUMBER IS PLANTED. It is stamped by the fixture itself, not persisted: an own
 * `prepareDerivedData` on the fixture writes `system.__pwFieldProbe.total = NaN` on every
 * preparation, which is exactly the shape this check exists to find (a derivation producing a
 * number that is not one). Nothing is written to the fixture's stored data, so no migration, model
 * or pack is involved and the probe disappears with the fixture.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node tests/cp2020-augmented-dev-assertions.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";

async function joinGM(p) {
  await p.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const s = p.locator('select[name="userid"]');
  await s.waitFor({ state: "visible", timeout: 30000 });
  const us = await s.locator("option").evaluateAll(o => o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
  const g = us.find(u => /gamemaster/i.test(u.l));
  await s.selectOption(g.v);
  await p.locator('input[name="password"]').fill(PW);
  await Promise.all([
    p.waitForNavigation({ url: /\/game/, timeout: 45000 }).catch(() => {}),
    p.locator('button[name="join"]').click(),
  ]);
  await p.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 60000 });
}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = { err: null };
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const SCOPE = "cp2020-augmented";
  const PROBE_PATH = "system.__pwFieldProbe.total";
  let actor = null;
  let journalId = null;
  const realWarn = console.warn;
  const realNotifyWarn = ui.notifications?.warn?.bind(ui.notifications);

  try {
    const FA = await import(`/modules/${SCOPE}/module/dev/field-assertions.js`);
    const EJ = await import(`/modules/${SCOPE}/module/dev/error-journal.js`);

    /* ── §1 REGISTRATION + DEFAULTS ────────────────────────────────────────────────────────── */
    const cfgOf = (key) => {
      const c = game.settings.settings.get(`${SCOPE}.${key}`);
      return c ? { registered: true, scope: c.scope, config: c.config === true, default: c.default } : { registered: false };
    };
    out.settings = {
      fieldAssertions: cfgOf("devFieldAssertions"),
      errorJournal: cfgOf("devErrorJournal"),
    };
    // Restore both to their shipped position before measuring anything, so a previous run cannot
    // decide this run's starting state.
    await game.settings.set(SCOPE, "devFieldAssertions", false);
    await game.settings.set(SCOPE, "devErrorJournal", false);
    await sleep(100);
    out.settings.fieldAssertionsOffAtRest = FA.fieldAssertionsOn() === false;
    out.settings.errorJournalOffAtRest = EJ.errorJournalActive() === false;

    /* ── §2 THE FIXTURE AND THE WARN CHANNELS ──────────────────────────────────────────────── */
    for (const a of game.actors.filter(a => a.name.startsWith("__PW__Diag"))) await a.delete().catch(() => {});
    actor = await Actor.create({ name: "__PW__DiagSubject", type: "character" });

    // Own preparation step that plants the unusable number on every pass. Calls the class step
    // first so the fixture is otherwise prepared exactly as any other character.
    const protoDerived = Object.getPrototypeOf(actor).prepareDerivedData;
    actor.prepareDerivedData = function () {
      protoDerived.call(this);
      this.system.__pwFieldProbe = { total: NaN };
    };

    // Both channels are captured, not silenced: the notification text is what a GM reads, the
    // console line is what carries the whole list.
    const notices = [];
    const consoleLines = [];
    ui.notifications.warn = (msg, ...rest) => { notices.push(String(msg)); return realNotifyWarn?.(msg, ...rest); };
    console.warn = (...args) => { consoleLines.push(args.map(a => String(a)).join(" ")); return realWarn.apply(console, args); };
    const mine = (list) => list.filter(t => t.includes("__pwFieldProbe") || t.includes("__PW__DiagSubject"));
    // The console leg counts THIS CHECK'S OWN line, by its signature. Counting every console line
    // that mentions the fixture would also count Foundry's notifier echo of the notification, which
    // is a different mechanism (and is switched off in the check itself for exactly that reason).
    const mineOwn = (list) => list.filter(t => t.includes(`${SCOPE} | field assertions:`));

    /* ── §3 OFF: the planted value draws nothing ───────────────────────────────────────────── */
    actor.prepareData();
    await sleep(50);
    out.offSilent = {
      notices: mine(notices).length,
      console: mineOwn(consoleLines).length,
      consoleAnyMention: mine(consoleLines).length,
      probeIsNaN: Number.isNaN(actor.system.__pwFieldProbe?.total),   // the plant really is there
    };

    /* ── §4 ON: one report naming the path, and only one ───────────────────────────────────── */
    await game.settings.set(SCOPE, "devFieldAssertions", true);
    await sleep(100);
    out.onArmed = FA.fieldAssertionsOn() === true;
    const noticesBefore = notices.length;

    actor.prepareData();
    await sleep(50);
    const firstNotices = mine(notices);
    const firstConsole = mineOwn(consoleLines);
    out.onFirstPrep = {
      notices: firstNotices.length,
      console: firstConsole.length,
      consoleAnyMention: mine(consoleLines).length,      // the notifier echo is off: this equals `console`
      namesPath: firstNotices.some(t => t.includes(PROBE_PATH)),
      namesDocument: firstNotices.some(t => t.includes("__PW__DiagSubject")),
      noRawKey: firstNotices.every(t => !t.includes("CYBERPUNK.")),
      consoleNamesPath: firstConsole.some(t => t.includes(PROBE_PATH)),
    };

    // The second and third preparations of the SAME document are silent (the per-session throttle).
    actor.prepareData();
    actor.prepareData();
    await sleep(50);
    out.onSecondPrep = { notices: mine(notices).length, console: mineOwn(consoleLines).length };
    // Everything the arming produced beyond this fixture, reported rather than asserted: an unusable
    // number found in the rig's own world data is a finding, not this suite's failure.
    out.otherFindingsWhileArmed = notices.length - noticesBefore - firstNotices.length;

    // The direct call answers with the same path (the macro route), and a deliberate reset re-arms.
    out.directCall = FA.assertDocumentFields(actor).filter(s => s.startsWith(PROBE_PATH)).length;
    FA.resetFieldAssertionThrottle();
    actor.prepareData();
    await sleep(50);
    out.afterThrottleReset = mine(notices).length;      // one more than onSecondPrep

    // A clean document draws nothing while armed (the negative case at the same setting position).
    const clean = await Actor.create({ name: "__PW__DiagClean", type: "character" });
    const noticesBeforeClean = mine(notices).length;
    clean.prepareData();
    await sleep(50);
    out.cleanDocumentSilent = mine(notices).length === noticesBeforeClean;
    await clean.delete().catch(() => {});

    await game.settings.set(SCOPE, "devFieldAssertions", false);
    await sleep(100);
    out.disarmed = FA.fieldAssertionsOn() === false;

    /* ── §4b THE SETTINGS PAGE: both switches sit under their own header, in order ──────────── */
    const sheet = game.settings.sheet;
    await sheet.render(true);
    for (let i = 0; i < 40 && !sheet.element; i++) await sleep(100);
    await sleep(400);
    const root = sheet.element?.jquery ? sheet.element[0] : sheet.element;
    const header = root?.querySelector('.cp-settings-header[data-cp-section="SectionDiagnostics"]');
    const groupOf = (key) => {
      const el = root?.querySelector(`[name="${SCOPE}.${key}"], [data-setting-id="${SCOPE}.${key}"]`);
      return el?.closest(".form-group") ?? el?.closest(".setting") ?? null;
    };
    const gField = groupOf("devFieldAssertions");
    const gJournal = groupOf("devErrorJournal");
    out.settingsPage = {
      headerText: header?.textContent ?? null,
      noRawKey: !!header && !header.textContent.includes("CYBERPUNK."),
      // Order proves the organizer actually MOVED them: header, then the two switches, adjacent.
      fieldFollowsHeader: !!header && header.nextElementSibling === gField,
      journalFollowsField: !!gField && gField.nextElementSibling === gJournal,
      bothShown: !!gField && !!gJournal,
      // Both are per-user checkboxes at their shipped position on a page nobody has touched.
      fieldUnticked: root?.querySelector(`[name="${SCOPE}.devFieldAssertions"]`)?.checked === false,
      journalUnticked: root?.querySelector(`[name="${SCOPE}.devErrorJournal"]`)?.checked === false,
    };
    await sheet.close().catch(() => {});
    await sleep(200);

    /* ── §5 THE COLLECTOR: OFF collects nothing ────────────────────────────────────────────── */
    EJ.clearErrorJournal();
    const fireFault = (message, stack) => {
      const e = new Error(message);
      if (stack) e.stack = stack;
      window.dispatchEvent(new ErrorEvent("error", {
        message, error: e, filename: `${location.origin}/modules/${SCOPE}/module/fx/effects.js`,
      }));
    };
    // A stack whose FIRST frame is foreign and whose SECOND names this module — so a landed entry
    // proves the module frame was chosen, not merely the top of the stack.
    const STACK = "Error: probe\n"
      + "    at somethingElse (http://localhost/scripts/foundry.js:1000:11)\n"
      + `    at ourStep (${location.origin}/modules/${SCOPE}/module/fx/effects.js:120:5)\n`
      + "    at deeper (http://localhost/scripts/foundry.js:2000:3)";

    fireFault("__PW__ fault while the collector is off", STACK);
    await sleep(50);
    out.journalOffCollects = EJ.readErrorJournal().length;      // 0
    out.journalOffDetached = EJ.errorJournalActive() === false;

    /* ── §6 ON: a dispatched fault lands, with the module frame ────────────────────────────── */
    await game.settings.set(SCOPE, "devErrorJournal", true);
    await sleep(100);
    out.journalOnAttached = EJ.errorJournalActive() === true;

    fireFault("__PW__ fault while the collector is on", STACK);
    await sleep(50);
    let ring = EJ.readErrorJournal();
    const landed = ring.find(e => e.message.includes("collector is on"));
    out.journalOnEntry = {
      count: ring.length,
      message: landed?.message ?? null,
      stackHead: landed?.stackHead ?? null,
      picksModuleFrame: !!landed?.stackHead?.includes(`/modules/${SCOPE}/module/fx/effects.js:120:5`),
      hasTime: typeof landed?.time === "string" && landed.time.includes("T"),
      hasUrl: !!landed?.url,
    };

    // The rejection channel feeds the same ring.
    window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", {
      promise: Promise.resolve(), reason: Object.assign(new Error("__PW__ rejection probe"), { stack: STACK }),
    }));
    await sleep(50);
    ring = EJ.readErrorJournal();
    out.rejectionLanded = ring.some(e => e.message.includes("__PW__ rejection probe"));
    out.ringCountAfterTwo = ring.length;

    /* ── §7 THE EXPORT ─────────────────────────────────────────────────────────────────────── */
    const journalsBefore = new Set(game.journal.map(j => j.id));
    const entry = await EJ.exportErrorJournal();
    await sleep(200);
    journalId = entry?.id ?? [...game.journal].find(j => !journalsBefore.has(j.id))?.id ?? null;
    const created = journalId ? game.journal.get(journalId) : null;
    const page = created?.pages?.contents?.[0];
    const content = page?.text?.content ?? "";
    out.export = {
      created: !!created,
      name: created?.name ?? null,
      titleCarriesDate: !!created?.name?.includes(new Date().toISOString().slice(0, 10)),
      noRawKey: !!created?.name && !created.name.includes("CYBERPUNK."),
      pageCount: created?.pages?.size ?? 0,
      carriesFaultText: content.includes("__PW__ fault while the collector is on"),
      carriesRejectionText: content.includes("__PW__ rejection probe"),
      carriesModuleFrame: content.includes(`/modules/${SCOPE}/module/fx/effects.js:120:5`),
    };

    /* ── §8 TOGGLE OFF DETACHES ────────────────────────────────────────────────────────────── */
    const countBeforeOff = EJ.readErrorJournal().length;
    await game.settings.set(SCOPE, "devErrorJournal", false);
    await sleep(100);
    out.detachedAfterOff = EJ.errorJournalActive() === false;
    fireFault("__PW__ fault after the collector was switched off", STACK);
    window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", {
      promise: Promise.resolve(), reason: new Error("__PW__ rejection after off"),
    }));
    await sleep(100);
    const afterOff = EJ.readErrorJournal();
    out.nothingLandsAfterOff = afterOff.length === countBeforeOff
      && !afterOff.some(e => e.message.includes("after the collector was switched off"))
      && !afterOff.some(e => e.message.includes("rejection after off"));
  } catch (e) {
    out.err = (e?.message || String(e)) + " @ " + String(e?.stack || "").split("\n")[1];
  } finally {
    /* ── CLEANUP: settings back to their shipped position, channels restored, fixtures gone ─── */
    try { console.warn = realWarn; } catch (e) { /* nothing to restore */ }
    try { if (realNotifyWarn) ui.notifications.warn = realNotifyWarn; } catch (e) { /* same */ }
    try { await game.settings.set(SCOPE, "devFieldAssertions", false); } catch (e) { /* same */ }
    try { await game.settings.set(SCOPE, "devErrorJournal", false); } catch (e) { /* same */ }
    try { const EJ2 = await import(`/modules/${SCOPE}/module/dev/error-journal.js`); EJ2.clearErrorJournal(); } catch (e) { /* same */ }
    try { if (journalId) await game.journal.get(journalId)?.delete(); } catch (e) { /* same */ }
    try { for (const a of game.actors.filter(a => a.name.startsWith("__PW__Diag"))) await a.delete(); } catch (e) { /* same */ }
    out.fixturesLeft = game.actors.filter(a => a.name.startsWith("__PW__Diag")).length;
    out.journalLeft = journalId ? (game.journal.get(journalId) ? 1 : 0) : 0;
  }
  return out;
});

console.log(JSON.stringify(r, null, 1));

const s = r.settings ?? {};
const checks = [
  ["field-assertion setting registers per-user, shown in the menu, default off",
    s.fieldAssertions?.registered === true && s.fieldAssertions?.scope === "client"
    && s.fieldAssertions?.config === true && s.fieldAssertions?.default === false],
  ["error-collector setting registers per-user, shown in the menu, default off",
    s.errorJournal?.registered === true && s.errorJournal?.scope === "client"
    && s.errorJournal?.config === true && s.errorJournal?.default === false],
  ["both start disarmed at the shipped position", s.fieldAssertionsOffAtRest === true && s.errorJournalOffAtRest === true],

  ["OFF: the planted unusable number is present and draws no report at all",
    r.offSilent?.probeIsNaN === true && r.offSilent?.notices === 0 && r.offSilent?.console === 0],
  ["ON: exactly one notice, naming the document and the exact path, no raw key",
    r.onArmed === true && r.onFirstPrep?.notices === 1 && r.onFirstPrep?.namesPath === true
    && r.onFirstPrep?.namesDocument === true && r.onFirstPrep?.noRawKey === true],
  ["ON: exactly one console line carries the path list, with no duplicate notifier echo",
    r.onFirstPrep?.console === 1 && r.onFirstPrep?.consoleNamesPath === true
    && r.onFirstPrep?.consoleAnyMention === 1],
  ["ON: two further preparations of the same document repeat nothing",
    r.onSecondPrep?.notices === 1 && r.onSecondPrep?.console === 1],
  ["ON: the direct call answers with the same path (the macro route)", r.directCall === 1],
  ["ON: clearing the throttle re-reports the same document once more", r.afterThrottleReset === 2],
  ["ON: a document with no unusable number stays silent", r.cleanDocumentSilent === true],
  ["the setting's off position disarms the check", r.disarmed === true],

  ["settings page: both switches are shown, unticked, under a plain-language Diagnostics header",
    r.settingsPage?.bothShown === true && r.settingsPage?.headerText === "Diagnostics"
    && r.settingsPage?.noRawKey === true
    && r.settingsPage?.fieldUnticked === true && r.settingsPage?.journalUnticked === true],
  ["settings page: the organizer places them in order directly beneath that header",
    r.settingsPage?.fieldFollowsHeader === true && r.settingsPage?.journalFollowsField === true],

  ["collector OFF: detached, and a dispatched fault collects nothing",
    r.journalOffDetached === true && r.journalOffCollects === 0],
  ["collector ON: attached, and the fault lands with its time and address",
    r.journalOnAttached === true && r.journalOnEntry?.count === 1
    && r.journalOnEntry?.hasTime === true && r.journalOnEntry?.hasUrl === true],
  ["collector ON: the kept frame is the MODULE frame, not the first frame of the stack",
    r.journalOnEntry?.picksModuleFrame === true],
  ["collector ON: the rejection channel feeds the same ring", r.rejectionLanded === true && r.ringCountAfterTwo === 2],

  ["export: one journal entry, one page, titled with the date and no raw key",
    r.export?.created === true && r.export?.pageCount === 1
    && r.export?.titleCarriesDate === true && r.export?.noRawKey === true],
  ["export: the page carries both collected faults and the kept frame",
    r.export?.carriesFaultText === true && r.export?.carriesRejectionText === true
    && r.export?.carriesModuleFrame === true],

  ["collector off again: detached, and nothing after the toggle lands",
    r.detachedAfterOff === true && r.nothingLandsAfterOff === true],

  ["fixtures cleaned", r.fixturesLeft === 0 && r.journalLeft === 0],
  ["no fixture/probe error", r.err === null],
  ["0 console errors", errors.length === 0],
];

let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (typeof r.otherFindingsWhileArmed === "number" && r.otherFindingsWhileArmed !== 0) {
  console.log(`  NOTE  ${r.otherFindingsWhileArmed} further document(s) reported an unusable number while the check was armed — read the log above.`);
}
if (errors.length) console.log("errors:", errors.slice(0, 8));
await b.close();
process.exit(fail ? 1 : 0);
