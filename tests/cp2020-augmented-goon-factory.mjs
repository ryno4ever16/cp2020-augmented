/** GOON FACTORY — the rig keeper (GOON-FACTORY-SPEC.md §4).
 *
 *  The PURE half of §4 has its own no-VTT suite (tests/npcgen-goonfactory.test.mjs, 114 legs): the
 *  clamps, the reservation arithmetic, the four chrome engine rules, the layering law, the stat
 *  shapes, the formula fields and the numbering are all proven there. THIS file proves the half only
 *  a running Foundry can answer:
 *
 *   - the GATING chain: the dial section renders from first open and is truly inert while locked (a
 *     hand-set DOM value on a disabled input never reaches the plan); a re-pick re-derives;
 *   - the FOUR SPEC-DELTA RULINGS of 2026-08-14, each driven as the real gesture:
 *       R1 the picks read top-down as threat level → role → outfit (asserted on DOM ORDER);
 *       R2 the Advanced checkbox is live at first open and unlocks the section with NO grade picked;
 *       R3 the dial section is present-and-disabled at first open, with DASHES in every underived
 *          readout, and takes the grade's own numbers the moment a threat level is picked;
 *       R4 the count starts at 1 for a user who has never typed one and REMEMBERS the last entry
 *          across a close/reopen;
 *   - the Goon Locker is found by its module FLAG, so RENAMING it does not spawn a second folder;
 *   - numbering CONTINUES across two real generations into the same destination;
 *   - the guarantee attaches to the weapon that was actually pulled, on the real actor's real skills;
 *   - manual/reduced EMP SURVIVES actor prep (the ObjectField whole-object hazard), and the other
 *     eight stats survive with it;
 *   - an EMP-0 generation fires ZERO dialogs;
 *   - token VISION lands from optics on the UNLINKED PROTOTYPE token;
 *   - chrome is INSTALLED (options parented into their housing), not left loose;
 *   - the preview writes NOTHING;
 *   - criteria lint reaches the preview rather than being swallowed.
 *
 *  Determinism: CONFIG.Dice.randomUniform is forced where a legs needs a fixed face. ⚠ v13+ maps a
 *  die face as ceil((1 - randomUniform()) * faces), so the uniform is INVERTED — face(f, n) below
 *  encodes that, and getting it backwards is how a "deterministic" leg silently rolls the wrong number.
 *
 *  All fixtures are prefixed __PW__ and deleted at the end; the locker folder is only removed if
 *  this run created it.
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
// ⚠ THE RIG IS SHARED. A user who is already joined renders as a DISABLED option, and selecting one
// fails with a 30s timeout that reads like a broken keeper rather than an occupied seat. So the pick
// prefers a free gamemaster-titled seat and falls back to any free seat — `game.user.isGM` is true
// for an Assistant Gamemaster (role >= ASSISTANT), which is every gate this suite meets.
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim(),d:x.disabled})).filter(x=>x.v));const free=us.filter(u=>!u.d);const g=free.find(u=>/gamemaster/i.test(u.l))||free[0]||us[0];await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  const out = { checks: [], fails: [], notes: {} };
  const check = (n, ok, got) => { out.checks.push(`${ok?"  PASS":"  FAIL"}  ${n}${ok?"":"  got="+JSON.stringify(got)}`); if(!ok) out.fails.push(n); };
  const SCOPE = "cp2020-augmented";

  const GR  = await import("/modules/cp2020-augmented/module/npcgen/grades.js");
  const AR  = await import("/modules/cp2020-augmented/module/npcgen/armor.js");
  const BP  = await import("/modules/cp2020-augmented/module/npcgen/blueprint.js");
  const OU  = await import("/modules/cp2020-augmented/module/npcgen/outfits.js");
  const GF  = await import("/modules/cp2020-augmented/module/npcgen/goon-factory.js");
  const MT  = await import("/modules/cp2020-augmented/module/npcgen/materialize.js");
  const APP = await import("/modules/cp2020-augmented/module/npcgen/npcgen-app.js");

  const madeActorIds = [];
  const madeFolderIds = [];
  let lockerCreatedByThisRun = false;
  let app = null;

  // ⭐ R4's FIXTURE: the remembered count is a CLIENT setting, so "a user who has never typed one"
  // is literally the absence of its localStorage key. It is removed here and restored in the finally
  // block — a keeper that left the GM's own remembered count rewritten would be debris.
  const COUNT_KEY = `${SCOPE}.goonCountLast`;
  const countKeyBefore = window.localStorage.getItem(COUNT_KEY);
  window.localStorage.removeItem(COUNT_KEY);

  try {
    // ── THE GOON LOCKER: found by FLAG, not by name ───────────────────────────────────────────────
    const lockerBefore = GF.findGoonLocker();
    const locker = await GF.ensureGoonLocker();
    if (!lockerBefore) { lockerCreatedByThisRun = true; madeFolderIds.push(locker.id); }
    check("the locker carries the module flag that identifies it",
      locker?.getFlag(SCOPE, "goonLocker") === true, locker?.getFlag(SCOPE, "goonLocker"));

    // ⭐ THE RENAME LEG — this is the whole reason the folder is flag-tracked rather than name-tracked.
    const originalName = locker.name;
    await locker.update({ name: "__PW__Renamed Locker" });
    const afterRename = await GF.ensureGoonLocker();
    check("renaming the locker does NOT spawn a second one (flag-tracked, not name-tracked)",
      afterRename?.id === locker.id, { wanted: locker.id, got: afterRename?.id });
    check("the folder count did not grow on the rename",
      game.folders.filter(f => f.type === "Actor" && f.getFlag(SCOPE, "goonLocker")).length === 1,
      game.folders.filter(f => f.type === "Actor" && f.getFlag(SCOPE, "goonLocker")).length);
    await locker.update({ name: originalName });

    // ── THE WINDOW: gating ────────────────────────────────────────────────────────────────────────
    app = APP.openNpcGenerator();
    // ⚠ A V2 window needs a real settle before .element exists — 600ms was not enough on the rig and
    // the legs below then passed VACUOUSLY off an undefined root. Wait for the element itself.
    for (let i = 0; i < 40 && !app?.element; i++) await sleep(150);
    await sleep(400);
    const root = app?.element;
    check("the generator window rendered", !!root, !!root);
    if (!root) throw new Error("generator window never rendered — the rest of the suite cannot run");

    // ── R1: THE PICKS READ TOP-DOWN — THREAT LEVEL, THEN ROLE, THEN OUTFIT ───────────────────────
    // Asserted on DOM ORDER rather than on the markup, because "what the GM reads first" is a fact
    // about the rendered document. compareDocumentPosition's FOLLOWING bit is the only honest way to
    // say "this row is above that one" without counting lines in a template.
    const rowOrder = [".cp-goon-grade-row", ".cp-goon-role-row", ".cp-goon-outfit-row"].map(s => root.querySelector(s));
    check("all three pick rows are on screen", rowOrder.every(Boolean),
      rowOrder.map((el, i) => [".cp-goon-grade-row", ".cp-goon-role-row", ".cp-goon-outfit-row"][i] + "=" + !!el));
    const follows = (a, b) => !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
    check("R1 — the threat level row sits ABOVE the role row", follows(rowOrder[0], rowOrder[1]), null);
    check("R1 — the role row sits ABOVE the outfit row", follows(rowOrder[1], rowOrder[2]), null);
    // The outfit's PREFILL mechanism is unchanged — only its position moved. Proven by value: the
    // catalogue entry's own grade and role arrive from the outfit, not from the two controls above it.
    // (The "based on" line and the grade-span note are the outfit control's satellites; both are
    // conditional on a pick, so their DOM position is asserted in the CATALOGUE block below, after
    // an outfit has actually been picked with a real gesture.)
    const firstOutfit = OU.OUTFITS[0];
    const prefilled = BP.resolveGoonConfig({ outfitId: firstOutfit.id, role: "media", grade: null });
    check("R1 — an outfit still PREFILLS the threat level and role above it",
      prefilled.grade === firstOutfit.grade && prefilled.role === firstOutfit.roleDefault,
      { got: { grade: prefilled.grade, role: prefilled.role }, want: { grade: firstOutfit.grade, role: firstOutfit.roleDefault } });

    // ── R2: THE ADVANCED CHECKBOX IS LIVE FROM FIRST OPEN ─────────────────────────────────────────
    const advBox = root.querySelector(".cp-goon-advanced");
    check("the Advanced checkbox exists", !!advBox, !!advBox);
    check("R2 — Advanced is ENABLED at first open, with no threat level picked",
      advBox?.disabled === false, advBox?.disabled);

    // ── R3: THE DIAL SECTION IS PRESENT AND LOCKED AT FIRST OPEN, NOT ABSENT ──────────────────────
    const dials0 = root.querySelector(".cp-goon-dials");
    check("R3 — the dial section is RENDERED before any threat level is picked", !!dials0, !!dials0);
    check("R3 — … and it is marked as the underived state", dials0?.classList.contains("cp-goon-unset"),
      dials0?.className);
    check("R3 — … and as the locked state, because Advanced is not ticked",
      dials0?.classList.contains("cp-goon-locked"), dials0?.className);
    const dialInputs0 = [...root.querySelectorAll(".cp-goon-dials input, .cp-goon-dials select")];
    check("R3 — every dial control is really DISABLED at first open (locked, never hidden)",
      dialInputs0.length >= 10 && dialInputs0.every(i => i.disabled === true),
      { n: dialInputs0.length, enabled: dialInputs0.filter(i => !i.disabled).map(i => i.className) });
    const readout = sel => root.querySelector(sel)?.closest(".cp-goon-row")?.querySelector(".cp-goon-out")?.textContent?.trim();
    check("R3 — the REF readout is a DASH while nothing is derived", readout(".cp-goon-ref") === "—", readout(".cp-goon-ref"));
    check("R3 — the BODY readout is a DASH while nothing is derived", readout(".cp-goon-bt") === "—", readout(".cp-goon-bt"));
    check("R3 — the skill-point readout is a DASH while nothing is derived",
      readout(".cp-goon-skillpoints") === "—", readout(".cp-goon-skillpoints"));
    check("R3 — the stat-pool readout is a DASH while nothing is derived",
      readout(".cp-goon-statpool") === "—", readout(".cp-goon-statpool"));
    const chromeField0 = root.querySelector(".cp-goon-chrome-count");
    check("R3 — the chrome-count field is EMPTY with a dash placeholder, not a misleading zero",
      chromeField0?.value === "" && chromeField0?.placeholder === "—",
      { v: chromeField0?.value, ph: chromeField0?.placeholder });
    const breakdowns0 = [...root.querySelectorAll(".cp-goon-breakdown")].map(p => p.textContent.trim());
    check("R3 — both breakdown lines read as dashes rather than as blank gaps",
      breakdowns0.length === 2 && breakdowns0.every(t => t === "—"), breakdowns0);

    // ── R4: THE COUNT STARTS AT 1 FOR A USER WHO HAS NEVER TYPED ONE ─────────────────────────────
    check("R4 — a fresh user's count field reads 1", root.querySelector(".cp-goon-count")?.value === "1",
      root.querySelector(".cp-goon-count")?.value);
    check("R4 — … and the window's own count agrees", app.count === 1, app.count);

    // ── R2's GESTURE: TICK ADVANCED WITH NO THREAT LEVEL PICKED ───────────────────────────────────
    // The click is the point. The complaint that produced this ruling was "I clicked it and nothing
    // happened", so the leg clicks the real checkbox and reads the section it is supposed to move.
    advBox.click();
    await sleep(700);
    const rootAdv = app.element;
    const dialsAdv = rootAdv.querySelector(".cp-goon-dials");
    check("R2 — clicking Advanced with NO threat level really flips the window's state",
      app.advanced === true, app.advanced);
    check("R2 — … the checkbox is ticked on screen", rootAdv.querySelector(".cp-goon-advanced")?.checked === true,
      rootAdv.querySelector(".cp-goon-advanced")?.checked);
    check("R2 — … the dial section UNLOCKS", dialsAdv?.classList.contains("cp-goon-locked") === false,
      dialsAdv?.className);
    const dialInputsAdv = [...rootAdv.querySelectorAll(".cp-goon-dials input, .cp-goon-dials select")];
    check("R2 — … and its controls are really enabled",
      dialInputsAdv.length >= 10 && dialInputsAdv.every(i => i.disabled === false),
      dialInputsAdv.filter(i => i.disabled).map(i => i.className));
    check("R3 — an UNLOCKED but underived section still reads as dashes, not as invented values",
      rootAdv.querySelector(".cp-goon-ref")?.closest(".cp-goon-row")?.querySelector(".cp-goon-out")?.textContent?.trim() === "—",
      rootAdv.querySelector(".cp-goon-ref")?.closest(".cp-goon-row")?.querySelector(".cp-goon-out")?.textContent);

    // Untick, so the derived-values legs below start from the locked state they describe.
    rootAdv.querySelector(".cp-goon-advanced").click();
    await sleep(700);
    check("R2 — a second click locks the section again (the toggle is symmetric)",
      app.advanced === false && app.element.querySelector(".cp-goon-dials")?.classList.contains("cp-goon-locked"),
      { advanced: app.advanced, cls: app.element.querySelector(".cp-goon-dials")?.className });

    // Drive the REAL control, not the instance field — the gesture is the thing under test.
    const gradeSel = root.querySelector(".cp-goon-grade");
    gradeSel.value = "B";
    gradeSel.dispatchEvent(new Event("change", { bubbles: true }));
    app._readForm();
    await app.render();
    await sleep(700);
    const root2 = app.element;
    check("Advanced unlocks once a threat level is picked",
      root2.querySelector(".cp-goon-advanced")?.disabled === false,
      root2.querySelector(".cp-goon-advanced")?.disabled);

    // ── DERIVED VALUES ARE VISIBLE AND LOCKED ─────────────────────────────────────────────────────
    const refInput = root2.querySelector(".cp-goon-ref");
    const btInput = root2.querySelector(".cp-goon-bt");
    check("the REF slider shows the grade's derived 8 and is locked", Number(refInput?.value) === 8 && refInput?.disabled === true,
      { v: refInput?.value, disabled: refInput?.disabled });
    check("the BODY slider shows the constant 7 and is locked", Number(btInput?.value) === 7 && btInput?.disabled === true,
      { v: btInput?.value, disabled: btInput?.disabled });
    const bd = root2.querySelector(".cp-goon-breakdown")?.textContent ?? "";
    check("the skill-point breakdown line states BOTH halves for grade B (40 / 8 reserved / 32)",
      /40/.test(bd) && /8/.test(bd) && /32/.test(bd), bd.trim());
    // ⭐ THE SPLIT IS DISCLOSED. The role's special ability is levelled at the grade OUTSIDE the
    // slider's points (the ruled deviation from the printed 40-point rule) — a GM who is only told
    // "32 to the role package" cannot see that. The line has to say it.
    check("… and it discloses that the special ability sits at the grade, outside the pool",
      /special ability/i.test(bd) && /outside/i.test(bd), bd.trim());

    // ⭐ LOCKED CONTROLS ARE TRULY INERT. Force a value onto a DISABLED input and prove it never
    // reaches the plan — a window that read its disabled inputs would silently honour this.
    refInput.value = "2";
    btInput.value = "10";
    app._readForm();
    check("a value forced onto a LOCKED control never becomes an override",
      Object.keys(app.overrides).length === 0, app.overrides);
    const cfgLocked = BP.resolveGoonConfig({ role: app.role, grade: app.grade, overrides: app.overrides });
    check("… and the plan still uses the derived REF 8, not the forced 2", cfgLocked.ref === 8, cfgLocked.ref);

    // ── ADVANCED ON: an edit becomes an override, and a re-pick re-derives ────────────────────────
    app.advanced = true;
    await app.render();
    await sleep(700);
    let root3 = app.element;
    const ref3 = root3.querySelector(".cp-goon-ref");
    check("unlocking really enables the control", ref3?.disabled === false, ref3?.disabled);
    ref3.value = "10";
    app._readForm();
    check("an edit made while unlocked DOES become an override", app.overrides.ref === 10, app.overrides);

    // Re-pick the same grade through the real control: §1's "re-derives uniformly on re-pick".
    const gradeSel3 = root3.querySelector(".cp-goon-grade");
    gradeSel3.value = "A";
    gradeSel3.dispatchEvent(new Event("change", { bubbles: true }));
    // ⛔ NOTHING IS DROPPED BY HAND HERE. Dropping the overrides in the test is what masked a real
    // bug: the window re-read the stale DOM and resurrected the override it had just cleared. The
    // leg drives the control and asserts on what the WINDOW does with it.
    app._readForm();
    await app.render();
    await sleep(700);
    const cfgA = BP.resolveGoonConfig({ role: app.role, grade: app.grade, overrides: app.overrides });
    check("re-picking the threat level re-derives cleanly (the REF override is gone)", cfgA.ref === 8, cfgA.ref);
    check("Advanced STAYS checked across a re-pick", app.advanced === true, app.advanced);
    check("grade AA is the sole REF exception and really reads 10",
      BP.resolveGoonConfig({ role: "cop", grade: "AA" }).ref === 10,
      BP.resolveGoonConfig({ role: "cop", grade: "AA" }).ref);

    // ── R4: THE COUNT SURVIVES A CLOSE AND A REOPEN ───────────────────────────────────────────────
    // Typed into the real field and committed with a real change event, exactly as a GM does it.
    const countField = app.element.querySelector(".cp-goon-count");
    countField.value = "5";
    countField.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(700);
    check("R4 — a typed count reaches the window", app.count === 5, app.count);
    check("R4 — … and is written to this user's own store",
      Number(game.settings.get(SCOPE, "goonCountLast")) === 5, game.settings.get(SCOPE, "goonCountLast"));
    check("R4 — … in CLIENT scope, so it is this user's memory and not the world's",
      game.settings.settings.get(`${SCOPE}.goonCountLast`)?.scope === "client",
      game.settings.settings.get(`${SCOPE}.goonCountLast`)?.scope);

    // Close it the way a GM closes it, then open it fresh: a new instance, a new render, no state
    // carried in memory — the only thing that can bring the 5 back is the store.
    await app.close();
    await sleep(500);
    app = APP.openNpcGenerator();
    for (let i = 0; i < 40 && !app?.element; i++) await sleep(150);
    await sleep(400);
    check("R4 — a REOPENED window remembers the last count", app.count === 5, app.count);
    check("R4 — … and shows it in the field", app.element.querySelector(".cp-goon-count")?.value === "5",
      app.element.querySelector(".cp-goon-count")?.value);
    // The NEGATIVE case: nothing else is remembered — a reopened window is otherwise fresh.
    check("R4 — the reopened window did NOT remember the threat level (only the count persists)",
      app.grade === null && app.advanced === false, { grade: app.grade, advanced: app.advanced });
    check("R4 — a count above the cap is clamped BEFORE it is remembered",
      GR.clampCount(30).value === GR.COUNT.cap, GR.clampCount(30).value);

    // =============================================================================================
    // ROLE = RANDOM (default) + DISPOSITION AS A BASELINE CONTROL — the two rulings of 2026-08-15
    //
    // The pure suite owns the DRAW (the pool, the index mapping, determinism, the threading through
    // package / special ability / stat order). What only a running Foundry can answer is on trial
    // here: is Random really the control's state at first open, does an outfit prefill beat it, does
    // an explicit flip BACK to Random survive the window's own form read, is the disposition control
    // outside the Advanced container in the real DOM, and does the value it carries reach a real
    // prototype token.
    // =============================================================================================
    {
      // Local to this block: the schema key → granted skill ITEM name index the materializer itself
      // uses, so the special-ability leg looks the skill up the way the code does rather than by a
      // transcribed display name. `nrm` absorbs the spacing difference either way.
      const nameByKeyLocal = await MT.skillNameIndex();
      const nrm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const roleSel = app.element.querySelector(".cp-goon-role");
      const roleOpts = [...(roleSel?.options ?? [])].map(o => o.value);
      check("the Role select leads with Random and then the nine book roles",
        roleOpts[0] === GR.ROLE_RANDOM && JSON.stringify(roleOpts.slice(1)) === JSON.stringify(GR.GENERATOR_ROLES),
        roleOpts);
      check("⛔ … and netrunner is not among them (the standing needle, on the real control)",
        !roleOpts.includes("netrunner"), roleOpts);
      check("Random is the SELECTED state of a freshly opened window",
        roleSel?.value === GR.ROLE_RANDOM && app.role === GR.ROLE_RANDOM,
        { dom: roleSel?.value, field: app.role });
      check("… and nothing was recorded as an override to achieve that (a default is not an edit)",
        app.overrides.role === undefined, app.overrides);

      // ── DISPOSITION SITS IN THE TOP BAND, NOT BEHIND ADVANCED ─────────────────────────────────
      // Asserted on DOM CONTAINMENT, because "not an Advanced dial" is a fact about where the
      // control lives, not about how it happens to look: it must be inside `.cp-goon-band` and it
      // must NOT be inside `.cp-goon-dials`, which is the element the Advanced lock disables.
      const dispRow = app.element.querySelector(".cp-goon-disposition-row");
      const dispSel = app.element.querySelector(".cp-goon-disposition");
      const band = app.element.querySelector(".cp-goon-band");
      const dialsBox = app.element.querySelector(".cp-goon-dials");
      check("the disposition control is on screen", !!dispRow && !!dispSel, { row: !!dispRow, sel: !!dispSel });
      check("⛔ it is INSIDE the top band", !!band && band.contains(dispRow), null);
      check("⛔ … and NOT inside the Advanced dial container", !!dialsBox && !dialsBox.contains(dispRow), null);
      check("… so the Advanced lock leaves it enabled, with no threat level picked",
        app.advanced === false && dispSel?.disabled === false,
        { advanced: app.advanced, disabled: dispSel?.disabled });
      check("… and it is not counted among the dial controls the lock disables",
        ![...app.element.querySelectorAll(".cp-goon-dials select")].includes(dispSel), null);
      check("it offers hostile and neutral, hostile selected by default",
        JSON.stringify([...(dispSel?.options ?? [])].map(o => o.value)) === JSON.stringify(GR.DISPOSITIONS)
        && dispSel?.value === GR.DISPOSITION_DEFAULT,
        { opts: [...(dispSel?.options ?? [])].map(o => o.value), value: dispSel?.value });

      // ── AN OUTFIT PREFILLS BOTH, OVER THE DEFAULTS ────────────────────────────────────────────
      const pick = async (sel, value) => {
        const el = app.element.querySelector(sel);
        el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(800);
        return app.element;
      };
      const outfitId = "chromerGang";                    // roleDefault "rocker" — not the old default
      const entry = OU.outfitById(outfitId);
      const rOutfit = await pick(".cp-goon-outfit", outfitId);
      check("picking an outfit PREFILLS the role over the Random default",
        rOutfit.querySelector(".cp-goon-role")?.value === entry.roleDefault,
        { dom: rOutfit.querySelector(".cp-goon-role")?.value, want: entry.roleDefault });
      check("… and prefills the disposition from the entry's own value",
        rOutfit.querySelector(".cp-goon-disposition")?.value === entry.disposition,
        { dom: rOutfit.querySelector(".cp-goon-disposition")?.value, want: entry.disposition });
      check("… without either becoming an override (a prefill is not a hand edit)",
        app.overrides.role === undefined && app.overrides.disposition === undefined, app.overrides);

      // ── THE FLIP BACK TO RANDOM STICKS ────────────────────────────────────────────────────────
      // This is the leg the feature exists for: the outfit outranks the window's DEFAULT, so an
      // explicit re-pick of Random has to travel as an OVERRIDE or the outfit swallows it silently.
      const rBack = await pick(".cp-goon-role", GR.ROLE_RANDOM);
      check("flipping the role BACK to Random records it as an override",
        app.overrides.role === GR.ROLE_RANDOM, app.overrides);
      check("… and it STICKS on screen rather than snapping back to the outfit's role",
        rBack.querySelector(".cp-goon-role")?.value === GR.ROLE_RANDOM,
        rBack.querySelector(".cp-goon-role")?.value);
      const cfgBack = BP.resolveGoonConfig({
        outfitId: app.outfitId || null, role: app.role, grade: app.grade, overrides: app.overrides,
      });
      check("… and the PLAN agrees: the resolved role is Random, the origin is kept",
        cfgBack.role === GR.ROLE_RANDOM && cfgBack.basedOn === outfitId, { role: cfgBack.role, basedOn: cfgBack.basedOn });
      check("… and the config reads as CUSTOM, exactly like any other hand-moved control",
        cfgBack.custom === true && /custom/i.test(rBack.querySelector(".cp-goon-basedon")?.textContent ?? ""),
        { custom: cfgBack.custom, line: rBack.querySelector(".cp-goon-basedon")?.textContent });

      // The NEGATIVE: setting the control back to the outfit's OWN role drops the override again.
      const rSame = await pick(".cp-goon-role", entry.roleDefault);
      check("re-selecting the outfit's own role clears the override (untouched ⇒ not an override)",
        app.overrides.role === undefined, app.overrides);
      check("… and the line stops claiming the config is custom",
        !/custom/i.test(rSame.querySelector(".cp-goon-basedon")?.textContent ?? ""),
        rSame.querySelector(".cp-goon-basedon")?.textContent);

      // ── THE DISPOSITION FLIP REACHES A REAL PROTOTYPE TOKEN ───────────────────────────────────
      await pick(".cp-goon-disposition", "neutral");
      check("flipping the disposition records an override",
        app.overrides.disposition === "neutral", app.overrides);
      const planNeutral = await GF.planGoonSquad({
        outfitId: outfitId, count: 1, seed: "__PW__disp-n",
        overrides: { disposition: "neutral" }, destinationFolder: locker,
      });
      const madeNeutral = await GF.materializeGoonSquad(planNeutral, { mode: "existing", folderId: locker.id });
      for (const m of madeNeutral) madeActorIds.push(m.id);
      const neutralActor = game.actors.get(madeNeutral[0]?.id);
      check("a NEUTRAL goon's prototype token carries the neutral disposition constant",
        neutralActor?.prototypeToken?.disposition === CONST.TOKEN_DISPOSITIONS.NEUTRAL,
        { got: neutralActor?.prototypeToken?.disposition, want: CONST.TOKEN_DISPOSITIONS.NEUTRAL });
      const planHostile = await GF.planGoonSquad({
        outfitId: outfitId, count: 1, seed: "__PW__disp-h",
        overrides: { disposition: "hostile" }, destinationFolder: locker,
      });
      const madeHostile = await GF.materializeGoonSquad(planHostile, { mode: "existing", folderId: locker.id });
      for (const m of madeHostile) madeActorIds.push(m.id);
      const hostileActor = game.actors.get(madeHostile[0]?.id);
      check("… and a HOSTILE one carries the hostile constant (both values, not just the default)",
        hostileActor?.prototypeToken?.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE
        && CONST.TOKEN_DISPOSITIONS.NEUTRAL !== CONST.TOKEN_DISPOSITIONS.HOSTILE,
        { got: hostileActor?.prototypeToken?.disposition, want: CONST.TOKEN_DISPOSITIONS.HOSTILE });

      // ── A RANDOM BATCH, END TO END, ON REAL ACTORS ────────────────────────────────────────────
      const randPlan = await GF.planGoonSquad({
        role: GR.ROLE_RANDOM, grade: "B", count: 4, seed: "sq1", destinationFolder: locker,
      });
      const rolled = randPlan.map(x => x.bp.role);
      check("a Random batch planned four goons with four different rolled roles (pinned seed)",
        JSON.stringify(rolled) === JSON.stringify(["techie", "corp", "rocker", "fixer"]), rolled);
      check("⛔ no plan row carries the sentinel as its role",
        randPlan.every(x => x.bp.role !== GR.ROLE_RANDOM && BP.RANDOM_ROLE_POOL.includes(x.bp.role)), rolled);
      const randMade = await GF.materializeGoonSquad(randPlan, { mode: "existing", folderId: locker.id });
      for (const m of randMade) madeActorIds.push(m.id);
      check("four actors were created from the Random batch", randMade.length === 4, randMade.length);
      for (let i = 0; i < randMade.length; i++) {
        const a = game.actors.get(randMade[i].id);
        const want = randPlan[i].bp.role;
        check(`${a?.name} — the ROLLED role is what landed on the sheet, not the control's value`,
          a?.system?.role?.value === want && a?.getFlag(SCOPE, "goonFactory")?.role === want
          && a?.getFlag(SCOPE, "goonFactory")?.roleRolled === true,
          { sheet: a?.system?.role?.value, flag: a?.getFlag(SCOPE, "goonFactory")?.role, want });
        // ⭐ THE THREADING, ON A REAL DOCUMENT: the special ability the rolled role owns is levelled
        // at the grade's points on the actor's OWN granted skill item. A silent `?? solo` fallback
        // anywhere in the pipeline would put CombatSense here instead.
        const specialKey = BP.CAREER_PACKAGES[want].special;
        // The index is keyed by the same normalized token `nrm` produces, and it carries the name
        // the granted item ACTUALLY has in this world's language — so the lookup is language-proof.
        const wantName = nameByKeyLocal?.get?.(nrm(specialKey))?.name ?? specialKey;
        const specialItem = a?.items.find(it => it.type === "skill" && nrm(it.name) === nrm(wantName));
        check(`${a?.name} — its ${want} special ability is levelled at grade B's points`,
          Number(specialItem?.system?.level) === GR.GRADES.B.skillPts,
          { key: specialKey, found: specialItem?.name, level: specialItem?.system?.level });
      }

      // ── THE PREVIEW NAMES EACH ROLLED ROLE ────────────────────────────────────────────────────
      // Driven through the WINDOW, because the line is the window's own localization of the plan.
      await pick(".cp-goon-outfit", "");
      await pick(".cp-goon-role", GR.ROLE_RANDOM);
      const gradeForPreview = app.element.querySelector(".cp-goon-grade");
      gradeForPreview.value = "B";
      gradeForPreview.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(700);
      app.seed = "sq1";
      app.count = 4;
      await app.render();
      await sleep(600);
      app.element.querySelector('.cp-goon-go[data-action="goonGenerate"]')?.click();
      await sleep(4000);
      const roleLines = [...app.element.querySelectorAll(".cp-goon-card-role")].map(p => p.textContent.trim());
      check("every preview card names the role its goon rolled",
        roleLines.length === (app.preview?.length ?? 0) && roleLines.length > 0,
        { lines: roleLines.length, cards: app.preview?.length });
      check("… by the role's own LOCALIZED label, not its schema key",
        (app.preview ?? []).every((row, i) => {
          const key = `CYBERPUNK.GoonFactory.Role.${row.bp.role}`;
          const label = game.i18n.localize(key);
          return label !== key && label !== row.bp.role && roleLines[i]?.includes(label);
        }),
        { lines: roleLines, roles: (app.preview ?? []).map(r => r.bp.role) });

      // The NEGATIVE: a batch with a PICKED role renders no rolled-role line at all — the control
      // above already says what every goon is, and repeating it on every card would be noise.
      await pick(".cp-goon-role", "cop");
      app.seed = "__PW__fixedrole";
      await app.render();
      await sleep(600);
      app.element.querySelector('.cp-goon-go[data-action="goonGenerate"]')?.click();
      await sleep(4000);
      check("a FIXED-role batch renders no rolled-role line (the negative)",
        app.element.querySelectorAll(".cp-goon-card-role").length === 0
        && (app.preview ?? []).every(row => row.bp.role === "cop" && row.bp.roleRolled === false),
        { lines: app.element.querySelectorAll(".cp-goon-card-role").length,
          roles: (app.preview ?? []).map(r => r.bp.role) });

      // Leave the window in the state the blocks below expect: no outfit, Random role, no overrides.
      await pick(".cp-goon-role", GR.ROLE_RANDOM);
      app.overrides = {};
      app.preview = null;
      app.seed = "__PW__gf-reset";
      await app.render();
      await sleep(500);
    }

    // ── THE PREVIEW WRITES NOTHING ────────────────────────────────────────────────────────────────
    const actorsBefore = game.actors.size;
    const msgsBefore = game.messages.size;
    const planRows = await GF.planGoonSquad({
      role: "solo", grade: "B", count: 3, seed: "__PW__gf-1",
      overrides: { loot: "standard" }, destinationFolder: locker,
    });
    check("planning three goons produced three plan rows", planRows.length === 3, planRows.length);
    check("the PREVIEW created no actors", game.actors.size === actorsBefore, { before: actorsBefore, after: game.actors.size });
    check("the PREVIEW posted no chat messages", game.messages.size === msgsBefore, { before: msgsBefore, after: game.messages.size });

    // Honesty lines are produced by the PLAN, and the always-on one is really always on.
    check("every planned goon carries the rolled-not-derived honesty line",
      planRows.every(x => x.honesty.some(h => h.code === "luckRepRolled")), null);
    check("every planned goon carries a humanity truth-line",
      planRows.every(x => x.honesty.some(h => h.code === "humanityTruth" || h.code === "cyberpsycho")), null);
    check("every planned goon carries an effective-roll line naming its armor EV",
      planRows.every(x => x.honesty.some(h => h.code === "effectiveSkillRoll")), null);
    out.notes.honestyCodes = [...new Set(planRows.flatMap(x => x.honesty.map(h => h.code)))];

    // Criteria lint reaches the preview rather than being swallowed.
    const lintRows = await GF.planGoonSquad({ role: "solo", grade: "E", count: 1, seed: "__PW__lint", destinationFolder: locker });
    check("a grade whose armor band pulls nothing SAYS so in the preview",
      lintRows[0].honesty.some(h => h.code === "bandNoPull"),
      lintRows[0].honesty.map(h => h.code));
    // Grade E's weapons rung is the book's "bare hands, improvised" — its shop pool is empty BY
    // DESIGN, and the preview must say that, never the world-data message (field report 2026-08-25).
    check("an empty-by-the-book weapons rung reads unarmedByTheBook, never noWeaponAvailable",
      !lintRows[0].weapon
      && lintRows[0].honesty.some(h => h.code === "unarmedByTheBook")
      && !lintRows[0].honesty.some(h => h.code === "noWeaponAvailable"),
      { weapon: lintRows[0].weapon?.name ?? null, codes: lintRows[0].honesty.map(h => h.code) });

    // ── MATERIALIZE ───────────────────────────────────────────────────────────────────────────────
    const made = await GF.materializeGoonSquad(planRows, { mode: "existing", folderId: locker.id });
    for (const m of made) madeActorIds.push(m.id);
    check("three goons were created", made.length === 3, made.length);
    check("they landed in the destination folder",
      made.every(m => game.actors.get(m.id)?.folder?.id === locker.id), null);

    const a0 = game.actors.get(made[0].id);

    // ── §2.7 NAMING + NUMBERING ───────────────────────────────────────────────────────────────────
    check("names follow {Role} {Grade}-{n}", /^solo B-\d+$/.test(a0.name), a0.name);
    const firstNumbers = made.map(m => Number(m.name.split("-").pop()));
    check("the first batch numbered 1..3", JSON.stringify(firstNumbers) === JSON.stringify([1,2,3]), firstNumbers);

    // ⭐ NUMBERING CONTINUES ACROSS A SECOND REAL GENERATION into the same folder.
    const planB = await GF.planGoonSquad({ role: "solo", grade: "B", count: 2, seed: "__PW__gf-2", destinationFolder: locker });
    const madeB = await GF.materializeGoonSquad(planB, { mode: "existing", folderId: locker.id });
    for (const m of madeB) madeActorIds.push(m.id);
    const secondNumbers = madeB.map(m => Number(m.name.split("-").pop()));
    check("a second generation CONTINUES the numbering (4,5), it does not restart",
      JSON.stringify(secondNumbers) === JSON.stringify([4,5]), secondNumbers);

    // ── THE PLANNED STANDING VALUE REACHES THE STORE THE READERS USE ──────────────────────────────
    // The factory used to write the planned number to `system.reputation`, a path the base DataModel
    // does not declare and therefore strips — so every generated figure read 0 at both consumers
    // (the standing-social contest term and the recognition threshold). The store those readers own
    // is the module flag `flags.cp2020-augmented.reputation` (module/actor/reputation.js), which the
    // combat-tab input also binds to. This leg drives the real plan → materialize path with a
    // constant formula so the planned number is deterministic, then reads the flag back and proves
    // the number reaches the posted card's term.
    {
      const REP = await import("/modules/cp2020-augmented/module/actor/reputation.js");
      const repPlan = await GF.planGoonSquad({
        role: "solo", grade: "B", count: 1, seed: "__PW__rep", destinationFolder: locker,
        overrides: { repFormula: "7" },
      });
      check("the plan carries the constant standing value", repPlan[0]?.bp?.reputation === 7, repPlan[0]?.bp?.reputation);
      const repMade = await GF.materializeGoonSquad(repPlan, { mode: "existing", folderId: locker.id });
      for (const m of repMade) madeActorIds.push(m.id);
      const repActor = game.actors.get(repMade[0].id);
      check("the created figure's flag reads the planned standing value back",
        Number(repActor?.getFlag(SCOPE, "reputation")) === 7, repActor?.getFlag(SCOPE, "reputation"));
      // NEGATIVE: the schema path is not where the value lives — a write there is discarded, which is
      // exactly why the flag is the store.
      check("the discarded schema path stays empty on the created figure",
        repActor?.system?.reputation === undefined, repActor?.system?.reputation);

      // The consumer's own output: the standing-social card's term must be the planned number, and the
      // rolled total must decompose into die + COOL + that term.
      const beforeIds = new Set(game.messages.contents.map(m => m.id));
      const targetsBefore = [...(game.user.targets ?? [])];
      game.user.targets?.clear?.();
      await REP.rollFacedown(repActor);
      await sleep(400);
      const card = game.messages.contents.find(m => !beforeIds.has(m.id));
      const cardText = String(card?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const cool = Number(repActor?.system?.stats?.cool?.total) || 0;
      const rolledTotal = Number(card?.rolls?.[0]?.total ?? NaN);
      check("the standing-social card carries the planned term", /Reputation 7\b/.test(cardText), cardText.slice(0, 220));
      check("the card's total decomposes into die + COOL + the standing term",
        Number.isFinite(rolledTotal) && (rolledTotal - cool - 7) >= 1, { rolledTotal, cool });
      await card?.delete().catch(() => {});
      for (const t of targetsBefore) t.setTarget(true, { releaseOthers: false, groupSelection: true });
    }

    // ── §2.4 THE GUARANTEE FOLLOWS THE PULLED WEAPON ──────────────────────────────────────────────
    const row0 = planRows[0];
    const wantSkill = BP.weaponGoverningSkill(row0.weapon);
    const norm = s => String(s??"").toLowerCase().replace(/[^a-z0-9]/g,"");
    const skillItems = a0.items.filter(i => i.type === "skill");
    const guaranteed = skillItems.find(i => norm(i.name) === norm(wantSkill)
      || norm(i.name) === norm(wantSkill.replace("Submachinegun","Submachinegun")));
    check("the guaranteed weapon skill exists on the created actor", !!guaranteed, { wantSkill, weapon: row0.weapon?.name });
    check("… and it is at or above the grade's own weapon-skill points (B = 8)",
      Number(guaranteed?.system?.level) >= GR.GRADES.B.skillPts,
      { skill: guaranteed?.name, level: guaranteed?.system?.level, need: GR.GRADES.B.skillPts });
    out.notes.guarantee = { weapon: row0.weapon?.name, skill: wantSkill, level: guaranteed?.system?.level };

    // The role's special ability auto-levelled — the Solo's Combat Sense, which the base system does
    // NOT grant by default (it ships in the separate role-skills pack), so this also proves the grant.
    const sa = skillItems.find(i => norm(i.name) === norm("CombatSense"));
    check("the role's special ability was granted and auto-levelled at the grade's points",
      Number(sa?.system?.level) === GR.GRADES.B.skillPts, { level: sa?.system?.level, need: GR.GRADES.B.skillPts });

    // ⭐ THE BOOK'S CAREER PACKAGE, ON THE REAL ACTOR (Core p.44 via CAREER-PACKAGES-P44.md). The
    // expectation is transcribed here rather than read back from the module, so a table that drifts
    // from the page fails on the SHIPPED actor and not merely in the pure suite.
    const SOLO_P44 = ["AwarenessNotice","Handgun","Brawling","Melee","Weaponsmith","Rifle","Athletics","Submachinegun","Stealth"];
    const allowedSkillTokens = new Set([...SOLO_P44, wantSkill, "CombatSense"].map(norm));
    const levelledStrays = skillItems
      .filter(i => Number(i.system?.level) > 0)
      .map(i => i.name)
      .filter(n => !allowedSkillTokens.has(norm(n)));
    check("every levelled skill on the created goon comes from the book's Solo career package",
      levelledStrays.length === 0, levelledStrays);
    out.notes.soloLevelled = skillItems.filter(i => Number(i.system?.level) > 0)
      .map(i => `${i.name} ${i.system.level}`);

    // The POSITIVE half: a package entry the retired interim spine never carried really takes points.
    // Weaponsmith is also the one interpretive rename on the page ("Weapons Tech"), so this is the
    // leg that proves the rename reached a real sheet.
    const weaponsmithSomewhere = made
      .map(m => game.actors.get(m.id))
      .some(a => a.items.some(i => i.type === "skill" && norm(i.name) === norm("Weaponsmith")
        && Number(i.system?.level) > 0));
    check("the Solo package's Weaponsmith really receives points on a generated sheet",
      weaponsmithSomewhere, out.notes.soloLevelled);

    // We never DOUBLE skills: the base grants ~103 and the generator updates, never re-creates.
    const dupes = skillItems.map(i => norm(i.name)).filter((v,i,arr) => arr.indexOf(v) !== i);
    check("no skill was duplicated by the generator", dupes.length === 0, dupes.slice(0,5));

    // ── §4 EMP SURVIVES ACTOR PREP (the ObjectField whole-object hazard) ──────────────────────────
    const chromedRow = planRows.find(x => x.humanityLoss > 0) ?? planRows[0];
    const chromedActor = game.actors.get(made[planRows.indexOf(chromedRow)]?.id) ?? a0;
    const planEmp = chromedRow.emp;
    check("the reduced EMP is on the actor AFTER prep",
      Number(chromedActor.system.stats.emp.base) === planEmp,
      { onActor: chromedActor.system.stats.emp.base, planned: planEmp });
    // ⭐ THE SIBLING LEG — this is what a dotted write breaks, and it breaks it silently.
    check("REF survived the EMP write (the dotted-write hazard)",
      Number(chromedActor.system.stats.ref.base) === chromedRow.bp.stats.ref,
      { ref: chromedActor.system.stats.ref.base, planned: chromedRow.bp.stats.ref });
    check("BODY survived the EMP write", Number(chromedActor.system.stats.bt.base) === chromedRow.bp.stats.bt,
      { bt: chromedActor.system.stats.bt.base, planned: chromedRow.bp.stats.bt });
    check("humanity on the sheet equals EMP×10 less the chrome's real cost",
      Number(chromedActor.system.humanity) === chromedRow.bp.stats.emp * 10 - chromedRow.humanityLoss,
      { humanity: chromedActor.system.humanity, expect: chromedRow.bp.stats.emp*10 - chromedRow.humanityLoss });

    // Re-read after a forced prep pass — "survives prep" means survives a re-derive, not just a write.
    chromedActor.prepareData();
    check("EMP still stands after an explicit prepareData()",
      Number(chromedActor.system.stats.emp.base) === planEmp, chromedActor.system.stats.emp.base);

    // ── §4 EMP-0 GENERATION FIRES ZERO DIALOGS ────────────────────────────────────────────────────
    const dialogsBefore = Object.keys(ui.windows ?? {}).length + (foundry.applications.instances?.size ?? 0);
    const psychoPlan = await GF.planGoonSquad({
      role: "solo", grade: "AA", count: 1, seed: "__PW__psycho",
      overrides: { chromeCount: 12 }, destinationFolder: locker,
    });
    const psychoMade = await GF.materializeGoonSquad(psychoPlan, { mode: "existing", folderId: locker.id });
    for (const m of psychoMade) madeActorIds.push(m.id);
    await sleep(500);
    const dialogsAfter = Object.keys(ui.windows ?? {}).length + (foundry.applications.instances?.size ?? 0);
    check("a heavily-chromed generation opened NO new dialogs", dialogsAfter <= dialogsBefore,
      { before: dialogsBefore, after: dialogsAfter });
    out.notes.psychoEmp = psychoMade[0]?.emp;

    // ⭐ THE EMP-0 LEG, MADE DETERMINISTIC. A heavy chrome pull does not reliably reach EMP 0 (this
    // run landed at 4), so relying on the roll would leave §4's "EMP-0 generation fires zero dialogs"
    // requirement unproven most runs. The plan row's own humanity result is pinned to zero instead —
    // which exercises exactly the path under test: the MATERIALIZER writing an EMP of 0.
    const zeroPlan = await GF.planGoonSquad({
      role: "solo", grade: "AA", count: 1, seed: "__PW__emp0",
      overrides: { chromeCount: 10 }, destinationFolder: locker,
    });
    zeroPlan[0].emp = 0;
    zeroPlan[0].humanity = 0;
    const dlgBefore0 = Object.keys(ui.windows ?? {}).length + (foundry.applications.instances?.size ?? 0);
    const notifBefore = document.querySelectorAll("#notifications .notification").length;
    const zeroMade = await GF.materializeGoonSquad(zeroPlan, { mode: "existing", folderId: locker.id });
    for (const m of zeroMade) madeActorIds.push(m.id);
    await sleep(700);
    const dlgAfter0 = Object.keys(ui.windows ?? {}).length + (foundry.applications.instances?.size ?? 0);
    const za = game.actors.get(zeroMade[0]?.id);
    check("an EMP-0 goon really lands at EMP 0 on the sheet",
      Number(za?.system?.stats?.emp?.base) === 0, za?.system?.stats?.emp?.base);
    check("EMP 0 SURVIVES actor prep (it is not refilled from the schema default)",
      (za.prepareData(), Number(za.system.stats.emp.base)) === 0, za?.system?.stats?.emp?.base);
    check("the other eight stats survived the EMP-0 write",
      Number(za.system.stats.ref.base) === zeroPlan[0].bp.stats.ref
      && Number(za.system.stats.bt.base) === zeroPlan[0].bp.stats.bt,
      { ref: za.system.stats.ref.base, bt: za.system.stats.bt.base });
    check("an EMP-0 generation fires ZERO dialogs",
      dlgAfter0 <= dlgBefore0, { before: dlgBefore0, after: dlgAfter0 });
    check("… and raises no blocking notification either",
      document.querySelectorAll("#notifications .notification").length <= notifBefore + 1,
      { before: notifBefore, after: document.querySelectorAll("#notifications .notification").length });
    if (psychoMade[0] && psychoMade[0].emp <= 0) {
      check("an EMP-0 goon reports the cyberpsycho truth-line rather than clamping silently",
        psychoPlan[0].honesty.some(h => h.code === "cyberpsycho"), psychoPlan[0].honesty.map(h=>h.code));
    }

    // ── §2.8 CHROME IS INSTALLED, NOT CARRIED ─────────────────────────────────────────────────────
    const chromeHost = [...made, ...psychoMade].map(m => game.actors.get(m.id))
      .find(a => a?.items.some(i => i.type === "cyberware"));
    if (chromeHost) {
      const cw = chromeHost.items.filter(i => i.type === "cyberware");
      check("generated chrome is EQUIPPED (installed), not left loose",
        cw.every(i => i.system?.equipped === true), cw.filter(i=>!i.system?.equipped).map(i=>i.name));
      const housings = cw.filter(i => Number(i.system?.CyberWorkType?.OptionsAvailable) > 0);
      const parented = cw.filter(i => !!i.system?.Module?.ParentId);
      out.notes.install = { chrome: cw.length, housings: housings.length, parented: parented.length };
      if (housings.length) {
        check("at least one option was really parented INTO a housing (the compound pull landed)",
          parented.length > 0, out.notes.install);
        check("every parented option points at a housing that is on the same actor",
          parented.every(o => cw.some(h => h.id === o.system.Module.ParentId)), null);
      }
      // Housings are deduped: a goon never buys two Cyberoptics.
      const byName = {};
      for (const i of cw) byName[i.name] = (byName[i.name] ?? 0) + 1;
      check("no housing was bought twice on one goon (housing dedup)",
        !Object.entries(byName).some(([n,c]) => c > 1 && /Cyberoptic|Cyberaudio|Standard Cyberarm|Neuralware Processor/.test(n)),
        Object.entries(byName).filter(([,c]) => c > 1));
    } else {
      out.notes.install = "no chrome landed in this run's pulls";
    }

    // ── §2.8 TOKEN VISION ON THE UNLINKED PROTOTYPE TOKEN ─────────────────────────────────────────
    // Build a goon that is GUARANTEED to hold a vision optic, so the leg tests the wiring rather than
    // the luck of a pull: plan one, then materialize it with a Low Lite forced in.
    const opticRow = (await GF.getGoonChromePool()).find(x => x.name === "Low Lite");
    const opticHostPlan = await GF.planGoonSquad({ role: "solo", grade: "AA", count: 1, seed: "__PW__optic", destinationFolder: locker });
    if (opticRow && opticHostPlan[0]) {
      const hasOptic = opticHostPlan[0].chrome.items.some(i => i.name === "Low Lite");
      if (!hasOptic) {
        opticHostPlan[0].chrome.items.push({ ...opticRow, role: "option", housing: null });
      }
      const opticMade = await GF.materializeGoonSquad(opticHostPlan, { mode: "existing", folderId: locker.id });
      for (const m of opticMade) madeActorIds.push(m.id);
      const oa = game.actors.get(opticMade[0]?.id);
      const optic = oa?.items.find(i => i.name === "Low Lite");
      check("the copied optic kept its compendium provenance (so the corrections layer fired)",
        !!(optic?._stats?.compendiumSource || optic?.flags?.core?.sourceId), optic?._stats?.compendiumSource);
      check("the corrections layer really wired the optic's vision block",
        optic?.system?.mechVision?.enabled === true, optic?.system?.mechVision);
      const proto = oa?.prototypeToken;
      check("the PROTOTYPE token has sight enabled from the optic",
        proto?.sight?.enabled === true, proto?.sight);
      check("… and its vision mode is one the running core actually provides",
        !!CONFIG.Canvas.visionModes?.[proto?.sight?.visionMode], proto?.sight?.visionMode);
      out.notes.vision = { mode: proto?.sight?.visionMode, range: proto?.sight?.range };
      check("the prototype token is hostile with no nameplate (the squad default)",
        proto?.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE
        && proto?.displayName === CONST.TOKEN_DISPLAY_MODES.NONE,
        { d: proto?.disposition, n: proto?.displayName });
      check("the goon is UNLINKED, so each token takes its own hits",
        proto?.actorLink !== true, proto?.actorLink);
    }

    // ── §1 LOOT: real ammo items + the credchip ───────────────────────────────────────────────────
    const looted = made.map(m => game.actors.get(m.id)).find(a => a?.items.some(i => i.flags?.[SCOPE]?.credchip));
    check("the loot dial produced a real credchip item carrying its value",
      !!looted && Number(looted.items.find(i => i.flags?.[SCOPE]?.credchip)?.system?.cost) > 0,
      looted?.items.find(i => i.flags?.[SCOPE]?.credchip)?.system?.cost);
    const ammoItems = (looted ?? a0).items.filter(i => i.type === "ammo");
    check("spare magazines are REAL ammo items, not a number on a card", ammoItems.length >= 1, ammoItems.length);
    const gun = (looted ?? a0).items.find(i => i.type === "weapon" && i.system?.ammoItemId);
    if (gun) {
      check("the gun is loaded with an ammo item that exists on the same actor",
        !!(looted ?? a0).items.get(gun.system.ammoItemId), gun.system.ammoItemId);
      check("… and it starts with a full magazine",
        Number(gun.system.shotsLeft) === Number(gun.system.shots),
        { left: gun.system.shotsLeft, max: gun.system.shots });
    }

    // ── ARMOR: equipped, and the preview's effective SP is the SHEET's number ─────────────────────
    const armored = made.map(m => game.actors.get(m.id)).find(a => a?.items.some(i => i.type === "armor"));
    if (armored) {
      check("worn armor is EQUIPPED, so the damage pipeline counts it without opening the sheet",
        armored.items.filter(i => i.type === "armor").every(i => i.system?.equipped === true), null);
      const idx = made.findIndex(m => m.id === armored.id);
      const plannedSP = planRows[idx]?.armor?.effectiveSP;
      const torso = Number(armored.system?.hitLocations?.Torso?.stoppingPower
        ?? armored.system?.hitLocations?.torso?.stoppingPower ?? NaN);
      out.notes.armor = { plannedSP, torsoOnSheet: torso };
      if (Number.isFinite(torso) && plannedSP > 0) {
        check("the preview's effective SP agrees with the SHEET's own layered SP",
          torso === plannedSP, { sheet: torso, preview: plannedSP });
      }
    }

    // =============================================================================================
    // ⭐ THE RATIFIED OUTFIT CATALOGUE — OUTFIT-CATALOGUE-PREP.md §A, promoted 2026-08-14
    // =============================================================================================
    //
    // The table below is the §A rows, transcribed. Everything in this block compares the SHIPPED
    // roster and the goons it actually produces against that table — a leg that read the roster and
    // then asserted things about what it read would pass for any roster at all.
    //
    // Three conditions of the promotion are proven here and nowhere else, because each of them is a
    // statement about a running world:
    //   B2 the grade-span note is a DISPLAY surface on the window, present only for the paired pair;
    //   B3 the jurisdiction / reinforcement / flavour lines land in the actor's GM-side notes and in
    //      NO player-visible surface — asserted as a positive AND as four negatives;
    //   C9 a skill bias re-weights package entries only; a key the package lacks stays inert.
    const TABLE = [
      { id: "cityPolicePatrol",     role: "cop",    grade: "C", hardness: "soft", weight: "any",   armament: "standard", loot: "scarce"   },
      { id: "cityPoliceTactical",   role: "cop",    grade: "B", hardness: "any",  weight: "any",   armament: "standard", loot: "scarce"   },
      { id: "cyberpsychoResponse",  role: "solo",   grade: "A", hardness: "hard", weight: "any",   armament: "ap",       loot: "standard" },
      { id: "premiumCorpSecurity",  role: "solo",   grade: "B", hardness: "soft", weight: "any",   armament: "standard", loot: "standard" },
      { id: "executiveProtection",  role: "solo",   grade: "A", hardness: "soft", weight: "any",   armament: "standard", loot: "standard" },
      { id: "facilitySecurity",     role: "cop",    grade: "C", hardness: "soft", weight: "any",   armament: "standard", loot: "scarce"   },
      { id: "dockPatrol",           role: "solo",   grade: "C", hardness: "soft", weight: "any",   armament: "standard", loot: "scarce"   },
      { id: "militarizedCorpForce", role: "solo",   grade: "A", hardness: "hard", weight: "any",   armament: "ap",       loot: "generous" },
      { id: "boosterGang",          role: "solo",   grade: "D", hardness: "soft", weight: "light", armament: "standard", loot: "scarce"   },
      { id: "poserGang",            role: "solo",   grade: "D", hardness: "soft", weight: "light", armament: "standard", loot: "scarce"   },
      { id: "chromerGang",          role: "rocker", grade: "E", hardness: "any",  weight: "any",   armament: "standard", loot: "scarce"   },
      { id: "corporateStaffers",    role: "corp",   grade: "E", hardness: "any",  weight: "any",   armament: "standard", loot: "scarce"   },
    ];

    check("the catalogue ships the twelve §A rows, in table order",
      JSON.stringify(OU.OUTFITS.map(o => o.id)) === JSON.stringify(TABLE.map(r => r.id)), OU.OUTFITS.map(o => o.id));

    // The DROPDOWN is the surface a GM meets, so it is read off the DOM rather than off the array.
    const outfitSel = app.element.querySelector(".cp-goon-outfit");
    const optionValues = [...(outfitSel?.options ?? [])].map(o => o.value);
    check("the outfit dropdown lists all twelve, under the '— none —' row",
      optionValues.length === 13 && optionValues[0] === ""
        && JSON.stringify(optionValues.slice(1)) === JSON.stringify(TABLE.map(r => r.id)), optionValues);
    check("no dropdown row is still labelled provisional — the seed suffix is gone",
      [...(outfitSel?.options ?? [])].every(o => !/\(seed\)/i.test(o.textContent ?? "")),
      [...(outfitSel?.options ?? [])].map(o => o.textContent));

    // ── B2: THE GRADE-SPAN NOTE, DRIVEN AS THE REAL PICK ─────────────────────────────────────────
    const pickOutfit = async (id) => {
      const sel = app.element.querySelector(".cp-goon-outfit");
      sel.value = id;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(800);
      return app.element;
    };
    const rPatrol = await pickOutfit("cityPolicePatrol");
    check("picking a catalogue entry PREFILLS the two controls above it, by value",
      rPatrol.querySelector(".cp-goon-grade")?.value === "C" && rPatrol.querySelector(".cp-goon-role")?.value === "cop",
      { grade: rPatrol.querySelector(".cp-goon-grade")?.value, role: rPatrol.querySelector(".cp-goon-role")?.value });
    const spanPatrol = rPatrol.querySelector(".cp-goon-spannote");
    check("B2 — the paired entry's grade-span note renders, and travels WITH the outfit control",
      !!spanPatrol && follows(rPatrol.querySelector(".cp-goon-outfit-row"), spanPatrol), !!spanPatrol);
    check("B2 — … and it names the other half of the pair by its own label",
      /tactical/i.test(spanPatrol?.textContent ?? ""), spanPatrol?.textContent);
    const rTactical = await pickOutfit("cityPoliceTactical");
    check("B2 — the pair's other half points back at the ordinary shift",
      /patrol/i.test(rTactical.querySelector(".cp-goon-spannote")?.textContent ?? ""),
      rTactical.querySelector(".cp-goon-spannote")?.textContent);
    const rUnpaired = await pickOutfit("dockPatrol");
    check("B2 — an UNPAIRED entry renders no span note at all (the negative)",
      rUnpaired.querySelector(".cp-goon-spannote") === null, rUnpaired.querySelector(".cp-goon-spannote")?.textContent);

    // ── EVERY ENTRY GENERATES A SQUAD, AND THE TABLE'S VALUES ARE WHAT LAND ──────────────────────
    const msgIdsBeforeCatalogue = new Set(game.messages.map(m => m.id));
    const perEntry = [];
    for (const row of TABLE) {
      const plan = await GF.planGoonSquad({
        outfitId: row.id, count: 1, seed: `__PW__cat-${row.id}`, destinationFolder: locker,
      });
      const madeOne = await GF.materializeGoonSquad(plan, { mode: "existing", folderId: locker.id });
      for (const m of madeOne) madeActorIds.push(m.id);
      perEntry.push({ row, plan: plan[0], made: madeOne[0] ?? null, actor: madeOne[0] ? game.actors.get(madeOne[0].id) : null });
    }
    check("every catalogue entry produced exactly one actor",
      perEntry.length === 12 && perEntry.every(e => !!e.actor), perEntry.filter(e => !e.actor).map(e => e.row.id));

    for (const e of perEntry) {
      const { row, plan, actor } = e;
      if (!actor) continue;
      const cfg = plan.bp.config;
      check(`${row.id} — role, threat level, disposition and provenance land as tabled`,
        actor.system.role?.value === row.role && plan.bp.grade === row.grade
        && actor.prototypeToken.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE
        && actor.getFlag(SCOPE, "goonFactory")?.outfitId === row.id,
        { role: actor.system.role?.value, grade: plan.bp.grade, disp: actor.prototypeToken.disposition,
          outfitId: actor.getFlag(SCOPE, "goonFactory")?.outfitId });
      check(`${row.id} — the armor posture and the loot profile reached the plan as tabled`,
        cfg.armorHardness === row.hardness && cfg.armorWeight === row.weight
        && cfg.armament === row.armament && cfg.loot === row.loot,
        { hardness: cfg.armorHardness, weight: cfg.armorWeight, armament: cfg.armament, loot: cfg.loot });
      // LEGALITY: the eight stats the pool does not debit sit inside the book's 2-10 roll range, the
      // skills were levelled on the items the base system granted, and the goon is armed or the plan
      // SAYS it could not arm them. (EMP and ATTR are deliberately excluded: chrome moves both, and
      // the humanity ruling is explicit that EMP may go negative.)
      const st = actor.system.stats ?? {};
      const inRange = ["int", "ref", "tech", "cool", "luck", "ma", "bt"]
        .every(k => Number(st[k]?.base) >= 2 && Number(st[k]?.base) <= 10);
      const levelled = actor.items.filter(i => i.type === "skill" && Number(i.system?.level) > 0).length;
      const armedOrHonest = !!plan.weapon || plan.honesty.some(h => h.code === "noWeaponAvailable" || h.code === "unarmedByTheBook");
      check(`${row.id} — the actor is a legal goon: stats in range, skills levelled, armed or honest`,
        inRange && levelled > 0 && armedOrHonest,
        { stats: Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v?.base])), levelled, weapon: plan.weapon?.name ?? null });
    }

    // ── B3: THE FLAVOUR IS GM-SIDE, AND THE NEGATIVES ARE THE POINT ──────────────────────────────
    const localizedLine = (key) => game.i18n.localize(`CYBERPUNK.${key}`);
    const linesOf = (id) => {
      const f = OU.outfitById(id)?.flavor ?? {};
      return [f.jurisdictionKey, f.reinforcementKey, f.noteKey].filter(Boolean).map(localizedLine);
    };
    const withFlavour = perEntry.filter(e => linesOf(e.row.id).length > 0);
    const withoutFlavour = perEntry.filter(e => linesOf(e.row.id).length === 0);
    check("B3 — eight entries state GM flavour and four state none",
      withFlavour.length === 8 && withoutFlavour.length === 4,
      { with: withFlavour.map(e => e.row.id), without: withoutFlavour.map(e => e.row.id) });

    for (const e of withFlavour) {
      const lines = linesOf(e.row.id);
      const notes = String(e.actor.system.notes ?? "");
      check(`${e.row.id} — B3: every flavour line landed in the actor's GM-side notes`,
        lines.length > 0 && lines.every(l => notes.includes(l)), { notes, lines });
      // NEGATIVE 1 — the token. No tooltip can carry what the token does not hold, and the nameplate
      // is off besides.
      const proto = JSON.stringify(e.actor.prototypeToken.toObject());
      check(`${e.row.id} — B3: nothing reached the prototype token, and the nameplate stays off`,
        !lines.some(l => proto.includes(l)) && e.actor.prototypeToken.displayName === CONST.TOKEN_DISPLAY_MODES.NONE,
        { leaked: lines.filter(l => proto.includes(l)), displayName: e.actor.prototypeToken.displayName });
      // NEGATIVE 2 — the sheet's audience, which is the whole load-bearing half of §B.3's *"players
      // never see an unowned NPC's sheet"*. Asserted against a REAL non-GM user rather than against
      // the ownership map alone: core stamps the CREATING user as OWNER on every document, and that
      // user is a GM, who could already read everything. What matters is that no player can.
      const sharedWithPlayers = Object.entries(e.actor.ownership)
        .filter(([k, v]) => k !== "default" && Number(v) > 0 && !game.users.get(k)?.isGM);
      const player = game.users.find(u => !u.isGM);
      const playerCanSee = player
        ? (e.actor.testUserPermission(player, "LIMITED") || e.actor.testUserPermission(player, "OBSERVER"))
        : null;
      check(`${e.row.id} — B3: no player may open the sheet the text sits on`,
        Number(e.actor.ownership.default) === CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE
        && sharedWithPlayers.length === 0 && playerCanSee === false,
        { ownership: e.actor.ownership, sharedWithPlayers, player: player?.name ?? null, playerCanSee });
    }
    check("B3 — an entry that states no flavour leaves the notes field untouched (the negative)",
      withoutFlavour.every(e => String(e.actor.system.notes ?? "").trim() === ""),
      withoutFlavour.map(e => ({ id: e.row.id, notes: e.actor.system.notes })));

    // NEGATIVE 3 — chat. Twelve generations posted nothing carrying a flavour line.
    const allFlavourLines = TABLE.flatMap(r => linesOf(r.id));
    const newMessages = game.messages.filter(m => !msgIdsBeforeCatalogue.has(m.id));
    check("B3 — generating the whole catalogue posted no chat card carrying a flavour line",
      newMessages.every(m => !allFlavourLines.some(l => String(m.content ?? "").includes(l))),
      newMessages.map(m => m.id));

    // NEGATIVE 4 — the preview surface. Driven as the real button press, and read off the DOM.
    await pickOutfit("cityPolicePatrol");
    app.element.querySelector('.cp-goon-go[data-action="goonGenerate"]')?.click();
    await sleep(2500);
    const previewText = app.element.textContent ?? "";
    check("B3 — the preview cards print no flavour line either",
      previewText.length > 0 && !allFlavourLines.some(l => previewText.includes(l)),
      allFlavourLines.filter(l => previewText.includes(l)));
    app.preview = null;
    await app.render();
    await sleep(500);

    // ── C9: THE BIAS RE-WEIGHTS THE PACKAGE, AND ONLY THE PACKAGE ────────────────────────────────
    const biasSums = (id, skillBias) => {
      const row = TABLE.find(r => r.id === id);
      const sums = Object.fromEntries(Object.keys(skillBias).map(k => [k, 0]));
      for (let i = 0; i < 24; i++) {
        const alloc = BP.allocateGoonSkills({
          total: 40, gradeKey: row.grade, role: row.role, primaryWeapon: null,
          rng: BP.seededRng(BP.seedFrom("__PW__bias", id, i)), skillBias,
        });
        for (const k of Object.keys(sums)) sums[k] += alloc.skillLevels.find(s => s.skillKey === k)?.level ?? 0;
      }
      return sums;
    };
    for (const row of TABLE) {
      const bias = OU.outfitById(row.id).skillBias;
      const pkg = new Set(BP.CAREER_PACKAGES[row.role].skills);
      const inPkg = Object.keys(bias).filter(k => pkg.has(k));
      const outPkg = Object.keys(bias).filter(k => !pkg.has(k));
      const sums = biasSums(row.id, bias);
      check(`${row.id} — the bias is observable on every key the role's package carries`,
        inPkg.length > 0 && inPkg.every(k => sums[k] > 0), { sums, inPkg });
      if (outPkg.length) {
        check(`${row.id} — a bias key the package LACKS stays inert (${outPkg.join(", ")}) — C9, ruled`,
          outPkg.every(k => sums[k] === 0), { sums, outPkg });
      }
    }
    // …and the re-weighting really MOVES the allocation rather than merely coexisting with it.
    const biasedHandgun = biasSums("cityPolicePatrol", { Handgun: 8 }).Handgun;
    const plainHandgun = biasSums("cityPolicePatrol", { Handgun: 0 }).Handgun;
    check("a bias weight really moves the remainder spend upward on that key",
      biasedHandgun > plainHandgun, { biased: biasedHandgun, plain: plainHandgun });
    out.notes.catalogue = { entries: OU.OUTFITS.length, withFlavour: withFlavour.map(e => e.row.id) };

    // =============================================================================================
    // ⭐ ROUND 2 — R6 the tick marks · R7 the reserved segment and its clamp · R8 the rolled-stats
    // group · R9 the armor-weight EV split · the carried-cash rename and the salvage disclosure
    // =============================================================================================
    //
    // Everything here is read off the RENDERED window and compared against the pure layer's own
    // arithmetic (`GR.trackPct`, `GR.salvageEstimate`, `AR.weightClassOf`) rather than against a
    // transcribed literal — a leg that hard-codes "10%" would keep passing after the scale changed
    // underneath it.

    // Reset the window to a clean grade-only state: the catalogue block above left an outfit picked.
    const setPick = async (sel, value) => {
      const el = app.element.querySelector(sel);
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(800);
      return app.element;
    };
    await setPick(".cp-goon-outfit", "");
    await setPick(".cp-goon-role", "solo");
    let r2 = await setPick(".cp-goon-grade", "B");

    // ── R6: THE TICKS ARE MARKS ON THE TRACK, NOT A <datalist> ───────────────────────────────────
    const ticksOf = (sliderSel) => [...(app.element.querySelector(sliderSel)
      ?.closest(".cp-goon-slider-wrap")?.querySelectorAll(".cp-goon-tick") ?? [])];
    const tickPcts = (sliderSel) => ticksOf(sliderSel).map(t => Number(t.style.getPropertyValue("--cp-tick")));

    check("R6 — the BODY slider carries one mark per BTM breakpoint (4)", ticksOf(".cp-goon-bt").length === 4,
      ticksOf(".cp-goon-bt").length);
    check("R6 — … each at the position the pure layer computes for its value",
      JSON.stringify(tickPcts(".cp-goon-bt"))
        === JSON.stringify(GR.BT_TICKS.map(t => GR.trackPct(t.value, GR.BT_RANGE.min, GR.BT_RANGE.max))),
      { dom: tickPcts(".cp-goon-bt"), want: GR.BT_TICKS.map(t => GR.trackPct(t.value, GR.BT_RANGE.min, GR.BT_RANGE.max)) });
    check("R6 — the BODY mark for value 8 sits at 75% of its track",
      Number(ticksOf(".cp-goon-bt").find(t => t.dataset.value === "8")?.style.getPropertyValue("--cp-tick")) === 75,
      ticksOf(".cp-goon-bt").map(t => [t.dataset.value, t.style.getPropertyValue("--cp-tick")]));
    check("R6 — the stat-pool slider carries one mark per named tier (5)", ticksOf(".cp-goon-statpool").length === 5,
      ticksOf(".cp-goon-statpool").length);
    check("R6 — … each at the position the pure layer computes on the FIXED 0–ceiling track",
      JSON.stringify(tickPcts(".cp-goon-statpool"))
        === JSON.stringify(GR.STAT_POOL.ticks.map(t => GR.trackPct(t.value, GR.STAT_POOL.scaleMin, GR.STAT_POOL.ceiling))),
      { dom: tickPcts(".cp-goon-statpool"), want: GR.STAT_POOL.ticks.map(t => GR.trackPct(t.value, GR.STAT_POOL.scaleMin, GR.STAT_POOL.ceiling)) });
    check("R6 — the stat-pool mark for tier 60 sits at 66.67% of its track",
      Number(ticksOf(".cp-goon-statpool").find(t => t.dataset.value === "60")?.style.getPropertyValue("--cp-tick")) === 66.67,
      ticksOf(".cp-goon-statpool").map(t => [t.dataset.value, t.style.getPropertyValue("--cp-tick")]));
    // The marks are really PAINTED — the stylesheet's position arithmetic resolves to real pixels
    // that increase with the tick's value. A mark carrying a custom property nothing draws is not a
    // tick, and that is exactly what the retired <datalist> was.
    const tickLefts = ticksOf(".cp-goon-statpool").map(t => parseFloat(getComputedStyle(t).left));
    check("R6 — … and the stylesheet really resolves those numbers into ascending pixel positions",
      tickLefts.length === 5 && tickLefts.every(v => Number.isFinite(v)) && tickLefts.every((v, i) => i === 0 || v > tickLefts[i - 1]),
      tickLefts);
    check("R6 — the marks are our own, not a native datalist (which the two cores render differently)",
      app.element.querySelectorAll("datalist").length === 0
        && !app.element.querySelector(".cp-goon-bt")?.hasAttribute("list"),
      { datalists: app.element.querySelectorAll("datalist").length, list: app.element.querySelector(".cp-goon-bt")?.getAttribute("list") });
    check("R6 — the REF slider stays TICKLESS, per its own ruling (the negative)",
      ticksOf(".cp-goon-ref").length === 0, ticksOf(".cp-goon-ref").length);

    // ── R7: THE RESERVED SEGMENT, AT TWO THREAT LEVELS ───────────────────────────────────────────
    const reservedOf = (sel) => Number(app.element.querySelector(sel)?.style.getPropertyValue("--cp-goon-reserved"));
    const scaleOf = (sel) => {
      const el = app.element.querySelector(sel);
      return { min: el?.getAttribute("min"), max: el?.getAttribute("max"), floor: el?.dataset.cpFloor };
    };
    const wantSkillPct = (g) => GR.trackPct(GR.skillPointBreakdown(40, g).floor, GR.SKILL_POINTS.scaleMin, GR.SKILL_POINTS.scaleMax);
    const wantPoolPct = (ref, bt) => GR.trackPct(GR.statPoolBreakdown(60, ref, bt).floor, GR.STAT_POOL.scaleMin, GR.STAT_POOL.ceiling);

    const skillB = reservedOf(".cp-goon-skillpoints");
    const poolB = reservedOf(".cp-goon-statpool");
    check("R7 — at threat level B the skill slider's band equals the computed reservation",
      skillB === wantSkillPct("B"), { dom: skillB, want: wantSkillPct("B") });
    check("R7 — at threat level B the stat-pool band equals the computed reservation",
      poolB === wantPoolPct(8, 7), { dom: poolB, want: wantPoolPct(8, 7) });
    const scaleB = scaleOf(".cp-goon-skillpoints");
    check("R7 — the skill track runs the whole fixed scale, so the band has somewhere to be drawn",
      scaleB.min === String(GR.SKILL_POINTS.scaleMin) && scaleB.max === String(GR.SKILL_POINTS.scaleMax), scaleB);

    r2 = await setPick(".cp-goon-grade", "AA");
    const skillAA = reservedOf(".cp-goon-skillpoints");
    const poolAA = reservedOf(".cp-goon-statpool");
    check("R7 — at threat level AA the skill band equals the computed reservation, and it GREW",
      skillAA === wantSkillPct("AA") && skillAA > skillB, { dom: skillAA, want: wantSkillPct("AA"), wasB: skillB });
    check("R7 — at threat level AA the stat-pool band grew with the REF exception",
      poolAA === wantPoolPct(10, 7) && poolAA > poolB, { dom: poolAA, want: wantPoolPct(10, 7), wasB: poolB });
    const scaleAA = scaleOf(".cp-goon-skillpoints");
    check("R7 — … and the TRACK ITSELF did not move: only the band did (the negative)",
      scaleAA.min === scaleB.min && scaleAA.max === scaleB.max, { B: scaleB, AA: scaleAA });
    check("R7 — the REF slider carries no band at all", !reservedOf(".cp-goon-ref"), reservedOf(".cp-goon-ref"));

    // The band and the sentence beside it are the same numbers. The band is a percentage of the
    // track, so its value in POINTS is what the breakdown line has to be stating.
    const bandPoints = Math.round(skillAA / 100 * GR.SKILL_POINTS.scaleMax);
    const bdLine = app.element.querySelector(".cp-goon-breakdown")?.textContent ?? "";
    check("R7 — the breakdown line states the band's own number, so the two cannot disagree",
      bandPoints === GR.skillPointBreakdown(40, "AA").reserved && bdLine.includes(String(bandPoints)),
      { bandPoints, line: bdLine.trim() });

    // ── R7's CLAMP: THE THUMB STOPS ON THE BAND'S EDGE ───────────────────────────────────────────
    // The clamp only means anything on an ENABLED control, so unlock first — and assert the unlock
    // rather than assuming the state the blocks above happened to leave behind.
    if (!app.advanced) { app.element.querySelector(".cp-goon-advanced").click(); await sleep(700); }
    check("the dial section is unlocked for the clamp legs", app.advanced === true, app.advanced);
    const skillSlider = app.element.querySelector(".cp-goon-skillpoints");
    const skillFloor = Number(skillSlider.dataset.cpFloor);
    check("R7 — the clamp floor rides on the control as data, at the grade's guarantee",
      skillFloor === GR.skillPointBreakdown(40, "AA").reserved, { floor: skillFloor });
    skillSlider.value = "0";
    skillSlider.dispatchEvent(new Event("input", { bubbles: true }));
    check("R7 — dragging below the reservation lands the thumb exactly ON the band's edge",
      Number(skillSlider.value) === skillFloor, { got: skillSlider.value, want: skillFloor });
    check("R7 — … and the readout beside it follows the clamped value, not the attempted one",
      skillSlider.closest(".cp-goon-row")?.querySelector(".cp-goon-out")?.textContent === String(skillFloor),
      skillSlider.closest(".cp-goon-row")?.querySelector(".cp-goon-out")?.textContent);
    skillSlider.value = "55";
    skillSlider.dispatchEvent(new Event("input", { bubbles: true }));
    check("R7 — a value ABOVE the reservation is left alone (the negative)", Number(skillSlider.value) === 55,
      skillSlider.value);
    const poolSlider = app.element.querySelector(".cp-goon-statpool");
    poolSlider.value = "0";
    poolSlider.dispatchEvent(new Event("input", { bubbles: true }));
    check("R7 — the stat-pool thumb clamps onto its own band's edge too",
      Number(poolSlider.value) === Number(poolSlider.dataset.cpFloor),
      { got: poolSlider.value, want: poolSlider.dataset.cpFloor });

    // ── R8: THE PER-GOON ROLLED-STATS GROUP ──────────────────────────────────────────────────────
    const rolled = app.element.querySelector(".cp-goon-rolled");
    const rolledHead = rolled?.querySelector(".cp-goon-subhead")?.textContent?.trim() ?? "";
    const luckLabel = app.element.querySelector('label[for="cp-goon-luck"]')?.textContent?.trim() ?? "";
    const repLabel = app.element.querySelector('label[for="cp-goon-rep"]')?.textContent?.trim() ?? "";
    check("R8 — the two formula fields sit inside one rolled-stats group", !!rolled
      && rolled.contains(app.element.querySelector(".cp-goon-luck"))
      && rolled.contains(app.element.querySelector(".cp-goon-rep")), !!rolled);
    check("R8 — the group's heading resolves to real text, not a raw key",
      rolledHead === game.i18n.localize("CYBERPUNK.GoonFactory.RolledSection") && !/^CYBERPUNK\./.test(rolledHead),
      rolledHead);
    check("R8 — one hint line says who rolls them and when",
      /rolls these at generation/i.test(rolled?.textContent ?? ""), rolled?.textContent?.slice(0, 160));
    check("R8 — both field labels resolve and say the roll is per goon",
      luckLabel === game.i18n.localize("CYBERPUNK.GoonFactory.LuckLabel")
        && repLabel === game.i18n.localize("CYBERPUNK.GoonFactory.RepLabel")
        && /rolled per goon/i.test(luckLabel) && /rolled per goon/i.test(repLabel),
      { luckLabel, repLabel });
    check("R8 — the fields still show their default formulas, untouched",
      app.element.querySelector(".cp-goon-luck")?.value === BP.LUCK_FORMULA_DEFAULT
        && app.element.querySelector(".cp-goon-rep")?.value === BP.REP_FORMULA_DEFAULT,
      { luck: app.element.querySelector(".cp-goon-luck")?.value, rep: app.element.querySelector(".cp-goon-rep")?.value });
    check("R8 — no raw i18n key leaked anywhere into the window",
      !/CYBERPUNK\.[A-Za-z]/.test(app.element.textContent ?? ""),
      (app.element.textContent ?? "").match(/CYBERPUNK\.[A-Za-z.]+/g));

    // ── R9: THE WEIGHT DROPDOWN NAMES ITS REAL BACKING STAT ──────────────────────────────────────
    // The bounds are DERIVED from weightClassOf, so a change to the split fails this leg instead of
    // silently leaving a label that states the old one.
    const evProbe = [0, 1, 2, 3, 4, 5, 6];
    const lightEvs = evProbe.filter(ev => AR.weightClassOf({ ev }) === "light");
    const heavyEvs = evProbe.filter(ev => AR.weightClassOf({ ev }) === "heavy");
    const lightTop = Math.max(...lightEvs);
    const heavyBottom = Math.min(...heavyEvs);
    const weightOpts = [...(app.element.querySelector(".cp-goon-armor-weight")?.options ?? [])]
      .map(o => ({ value: o.value, label: o.textContent.trim() }));
    check("R9 — the dropdown's VALUES are untouched: any | light | heavy",
      JSON.stringify(weightOpts.map(o => o.value)) === JSON.stringify(GR.ARMOR_WEIGHT_FILTERS), weightOpts);
    check("R9 — the light option names the EV range weightClassOf actually treats as light",
      weightOpts[1]?.label.includes(`0–${lightTop}`), { label: weightOpts[1]?.label, lightTop });
    check("R9 — the heavy option names the EV floor weightClassOf actually treats as heavy",
      weightOpts[2]?.label.includes(`${heavyBottom}+`), { label: weightOpts[2]?.label, heavyBottom });
    check("R9 — the split the labels state is really the one the filter applies",
      AR.weightClassOf({ ev: lightTop }) === "light" && AR.weightClassOf({ ev: heavyBottom }) === "heavy",
      { lightTop, heavyBottom });

    // ── THE CARRIED-CASH RENAME ──────────────────────────────────────────────────────────────────
    const lootLabel = app.element.querySelector('label[for="cp-goon-loot"]')?.textContent?.trim() ?? "";
    const lootOpts = [...(app.element.querySelector(".cp-goon-loot")?.options ?? [])].map(o => o.value);
    check("the dial reads as carried cash and consumables",
      lootLabel === game.i18n.localize("CYBERPUNK.GoonFactory.LootLabel") && /carried cash/i.test(lootLabel), lootLabel);
    check("… and its stored values are unchanged, so nothing has to migrate",
      JSON.stringify(lootOpts) === JSON.stringify(GR.LOOT_DIAL), lootOpts);
    check("… the hint says what it controls and what it does NOT",
      /credchip/i.test(app.element.querySelector(".cp-goon-loot")?.closest(".cp-goon-row")?.textContent ?? "")
        && /never changes/i.test(app.element.querySelector(".cp-goon-loot")?.closest(".cp-goon-row")?.textContent ?? ""),
      app.element.querySelector(".cp-goon-loot")?.closest(".cp-goon-row")?.textContent?.trim());

    // ── THE SALVAGE DISCLOSURE, ON A REAL SEEDED GENERATION ──────────────────────────────────────
    // Driven as the Generate press, and asserted against the pure estimate over the same plan rows.
    app.overrides = {};
    app.seed = "__PW__salvage";
    app.count = 3;
    await app.render();
    await sleep(600);
    app.element.querySelector('.cp-goon-go[data-action="goonGenerate"]')?.click();
    await sleep(3000);
    const salvageEl = app.element.querySelector(".cp-goon-salvage");
    const salvage = GR.salvageEstimate(app.preview ?? []);
    check("the preview carries a salvage line", !!salvageEl, app.element.querySelector(".cp-goon-preview")?.textContent?.slice(0, 120));
    check("… whose figure is the summed value of the squad's own weapons, armor and chrome",
      (salvageEl?.textContent ?? "").includes(salvage.rounded.toLocaleString("en-US")),
      { line: salvageEl?.textContent?.trim(), exact: salvage.exact, rounded: salvage.rounded });
    check("… and the sum is really the plan's item costs, not an invented number",
      salvage.exact === (app.preview ?? []).reduce((s, row) => s
        + (Number(row.weaponRow?.cost) || 0)
        + (row.armor?.layers ?? []).reduce((a, l) => a + (Number(l.cost) || 0), 0)
        + [...(row.chrome?.items ?? []), ...(row.chrome?.bonusItems ?? [])].reduce((a, c) => a + (Number(c.cost) || 0), 0), 0),
      salvage);
    check("… and it is present with the dial OFF, which is the whole point of disclosing it",
      app.preview?.every(row => row.loot.dial === "off") === true && !!salvageEl,
      app.preview?.map(row => row.loot.dial));
    // ── THE DIAL'S DISPLAY ROUND (2026-08-28): off = NO per-goon carrying line ───────────────────
    check("with the dial off, no preview card renders a carrying line",
      app.element.querySelectorAll(".cp-goon-card-loot").length === 0,
      app.element.querySelectorAll(".cp-goon-card-loot").length);

    // Turning the dial up moves the CARRIED cash and leaves the salvage figure alone. Driven on the
    // real control (the same seed, so the squad is otherwise identical): setting `overrides` by hand
    // would be undone by the form read that Generate performs first.
    const salvageOffText = salvageEl?.textContent?.trim();
    const cashOff = (app.preview ?? []).reduce((s, row) => s + row.loot.cashEb, 0);
    app.preview = null;
    await app.render();
    await sleep(400);
    app.element.querySelector(".cp-goon-loot").value = "generous";
    app.element.querySelector(".cp-goon-loot").dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(300);
    app.element.querySelector('.cp-goon-go[data-action="goonGenerate"]')?.click();
    await sleep(3000);
    const cashGenerous = (app.preview ?? []).reduce((s, row) => s + row.loot.cashEb, 0);
    check("turning the dial up really adds carried cash", cashGenerous > cashOff, { cashOff, cashGenerous });
    check("⛔ INVARIANT — and it did NOT change the gear: the salvage figure is the same",
      app.element.querySelector(".cp-goon-salvage")?.textContent?.trim() === salvageOffText,
      { off: salvageOffText, generous: app.element.querySelector(".cp-goon-salvage")?.textContent?.trim() });

    // ── THE DIAL'S DISPLAY ROUND (2026-08-28): amounts on the options + carrying lines per card.
    // Both assert against lootProfileFor / the plan row's own loot object — the display and the
    // build path share one source, so the legs prove the SAME number reaches both surfaces.
    const gradeNow = app.element.querySelector(".cp-goon-grade")?.value ?? "";
    const optByValue = Object.fromEntries(
      [...(app.element.querySelector(".cp-goon-loot")?.options ?? [])].map(o => [o.value, o.textContent.trim()]));
    check("each on-setting option states its resolved cash for the picked grade",
      !!gradeNow && ["scarce", "standard", "generous"].every(k =>
        optByValue[k]?.includes(GR.lootProfileFor(k, gradeNow).cashEb.toLocaleString("en-US"))),
      { grade: gradeNow, options: optByValue });
    check("… and its spare-magazine count, singular where it is one",
      ["scarce", "standard", "generous"].every(k => {
        const p = GR.lootProfileFor(k, gradeNow);
        return optByValue[k]?.includes(p.spareMags === 1 ? "1 spare mag" : `${p.spareMags} spare mags`);
      }), optByValue);
    check("the OFF option stays a bare word — no number to promise",
      optByValue.off === game.i18n.localize("CYBERPUNK.GoonFactory.Loot.Off"), optByValue.off);
    const lootLineEls = [...app.element.querySelectorAll(".cp-goon-card-loot")];
    check("with the dial on, EVERY preview card carries a carrying line",
      lootLineEls.length === (app.preview?.length ?? -1) && lootLineEls.length > 0,
      { lines: lootLineEls.length, rows: app.preview?.length });
    check("… whose figures are the row's own loot — cash and magazine count both",
      (app.preview ?? []).every((row, i) =>
        lootLineEls[i]?.textContent.includes(row.loot.cashEb.toLocaleString("en-US"))
        && lootLineEls[i]?.textContent.includes(row.loot.spareMags === 1 ? "1 spare magazine" : `${row.loot.spareMags} spare magazines`)),
      lootLineEls.map(el => el.textContent.trim()));
    app.overrides = {};
    app.preview = null;
    await app.render();
    await sleep(400);

    // ── THE CHEMICAL LANE (2026-08-28): pool composition, the steer, and the loaded launchers ────
    // ① Pool composition: base-system packs feed the generator; the frozen scraped family does not.
    const poolRows = await MT.npcGenCatalogRows();
    const packIds = new Set(poolRows.map(r => r.packId));
    check("the goon pool draws from the base system's own packs, not just the module's",
      [...packIds].some(id => id.startsWith("cyberpunk2020.")), [...packIds].slice(0, 6));
    const frozen = ["cyberpunk2020.pistols-add", "cyberpunk2020.rifles-add", "cyberpunk2020.smgs-add", "cyberpunk2020.armor-add"];
    check("the frozen scraped packs contribute ZERO rows to the goon pool",
      poolRows.filter(r => frozen.includes(r.packId)).length === 0,
      poolRows.filter(r => frozen.includes(r.packId)).map(r => r.name));
    check("index rows carry the delivery fields the chemical steer reads",
      poolRows.every(r => "attackType" in r && "ammoType" in r), Object.keys(poolRows[0] ?? {}));

    // ② The predicate, over the REAL rows: the chemical rack exists and holds the book's own gear.
    const chemRack = poolRows.filter(GF.chemicalCapableRow);
    const rackNames = chemRack.map(r => r.name);
    check("the chemical rack is non-empty on a stock install", chemRack.length > 0, rackNames);
    check("… and holds the Power Squirt and the core Grenade Launcher",
      rackNames.some(n => /power squirt/i.test(n)) && rackNames.some(n => n === "Grenade Launcher"), rackNames);
    check("… while an ordinary rifle row is NOT chemical-capable",
      !poolRows.filter(r => r.sub === "Rifles").some(GF.chemicalCapableRow), null);

    // ③ The steer: rung 3 (grade C) holds no chemical weapon → widened draw, still capable;
    //    a widened draw is never null while the rack is non-empty.
    const steerRng = BP.seededRng(BP.seedFrom("__PW__chem", "steer"));
    const steered = GF.pickChemicalPrimaryWeapon(poolRows, 3, steerRng);
    check("the chemical steer answers a rung with no chemical pool by widening, honestly flagged",
      !!steered.row && steered.widened === true && GF.chemicalCapableRow(steered.row),
      { name: steered.row?.name, widened: steered.widened });

    // ④ The round mapping is ONE derivation: posture flips gas↔frag; unknown chrome answers null.
    check("grenade tubes load gas under the chemical posture and fragmentation otherwise",
      GF.grenadeRoundNameFor("chemical") === "Gas Grenade Round"
      && GF.grenadeRoundNameFor("standard") === "Fragmentation Grenade Round", null);
    const clGL = GF.chromeLauncherLoadFor("Grenade Launcher", "chemical");
    const clMM = GF.chromeLauncherLoadFor("Micro-missile Launcher", "standard");
    const clPU = GF.chromeLauncherLoadFor("Popup Gun", "standard");
    check("the chrome loads carry the book's numbers: 1 gas round · 4 micromissiles · 9mm caseless",
      clGL?.kind === "grenadeRound" && clGL.roundName === "Gas Grenade Round" && clGL.quantity === 1
      && clMM?.kind === "micromissiles" && clMM.quantity === 4
      && clPU?.kind === "caselessPistol" && clPU.caliber === "9mm"
      && GF.chromeLauncherLoadFor("Wolvers", "chemical") === null,
      { clGL, clMM, clPU });

    // ⑤ The Gas Grenade Round is REAL pack data with the cloud's own fields and no dice.
    const heavyPack = game.packs.find(x => x.metadata.packageName === "cp2020-augmented" && x.metadata.name === "supplement-heavy");
    const gasIdx = (await heavyPack.getIndex()).find(e => e.name === "Gas Grenade Round");
    const gasDoc = gasIdx ? await heavyPack.getDocument(gasIdx._id) : null;
    check("the Gas Grenade Round ships in the module pack, effect not dice",
      !!gasDoc && JSON.stringify(gasDoc.system.effectTypes) === JSON.stringify(["Gas"])
      && !gasDoc.system.bonusDamageFormula && gasDoc.system.caliber === "Grenade"
      && gasDoc.system.blastRadius === 3 && gasDoc.system.dotTurns === 3,
      gasDoc && { eff: gasDoc.system.effectTypes, dmg: gasDoc.system.bonusDamageFormula, r: gasDoc.system.blastRadius });

    // ⑥ End-to-end: a chemical squad's every goon carries a chemical-capable weapon, the posture
    //    reads satisfied (no postureLoadMissing), and grade C plans carry the widened line. The
    //    seed is scanned for one that draws the Grenade Launcher so the magazine leg is REAL.
    let glPlan = null, glSeed = null;
    for (let i = 0; i < 60 && !glPlan; i++) {
      const seed = `__PW__chem-${i}`;
      const plan = await GF.planGoonSquad({ role: "solo", grade: "C", count: 2, seed, destinationFolder: locker, overrides: { armament: "chemical" } });
      if (!plan.every(r => !r.weaponRow || GF.chemicalCapableRow(r.weaponRow))) { glPlan = null; out.fails.push("non-chemical draw under chemical posture: " + plan.map(r => r.weaponRow?.name)); break; }
      if (plan.some(r => r.honesty.some(h => h.code === "postureLoadMissing"))) { out.fails.push("postureLoadMissing under a satisfied chemical pick"); break; }
      const hit = plan.find(r => r.weaponRow?.name === "Grenade Launcher");
      if (hit) { glPlan = plan; glSeed = seed; }
    }
    check("chemical squads draw ONLY chemical-capable primaries, and a launcher turns up in the scan",
      !!glPlan, glSeed);
    check("… and the grade-C plan says the pool was widened",
      glPlan?.some(r => r.honesty.some(h => h.code === "chemicalPoolWidened")) === true,
      glPlan?.map(r => r.honesty.map(h => h.code)));

    // ⑦ Materialize the launcher goon: the tube holds the REAL gas round, linked as its magazine.
    if (glPlan) {
      const glRow = glPlan.find(r => r.weaponRow?.name === "Grenade Launcher");
      const made = await GF.materializeGoon(glRow, { folder: locker, nameByKey: await MT.skillNameIndex() });
      if (made?.id) madeActorIds.push(made.id);
      const actor = game.actors.get(made?.id);
      const gasItem = actor?.items.find(i => i.type === "ammo" && i.name === "Gas Grenade Round");
      const gun = actor?.items.find(i => i.type === "weapon" && /grenade launcher/i.test(i.name));
      check("the launcher goon carries the real Gas Grenade Round at the tube's own count",
        !!gasItem && gasItem.system.quantity === 1 && gasItem.system.qtyLocked === false,
        gasItem && { q: gasItem.system.quantity, locked: gasItem.system.qtyLocked });
      check("… linked as the launcher's loaded magazine",
        !!gun && gun.system.ammoItemId === gasItem?.id,
        { gun: gun?.name, link: gun?.system?.ammoItemId, gas: gasItem?.id });
    }

    // ── THE FIELD-REPORT PAIR (2026-08-28 live testing) ──────────────────────────────────────────
    // ⑧ Reroll honors the dials as they stand: a chrome count typed AFTER the preview appeared
    //    reaches the rerolled goon, and the field keeps the typed value across the repaint.
    {
      const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
      app.overrides = {};
      app.preview = null;
      app.seed = "__PW__reroll";
      app.count = 1;
      await app.render();
      await sleep(500);
      const gradeSel = app.element.querySelector(".cp-goon-grade");
      if (gradeSel.value !== "C") { gradeSel.value = "C"; fire(gradeSel, "change"); await sleep(500); }
      const advBox = app.element.querySelector(".cp-goon-advanced");
      if (advBox && !advBox.checked) { advBox.click(); await sleep(500); }
      app.element.querySelector('.cp-goon-go[data-action="goonGenerate"]')?.click();
      await sleep(3000);
      const chromeField = () => app.element.querySelector(".cp-goon-chrome-count");
      const beforeCount = Number(chromeField()?.value || 0);
      const typedCount = beforeCount + 3;
      chromeField().value = String(typedCount);
      fire(chromeField(), "change");
      await sleep(200);
      app.element.querySelector('.cp-goon-icon[data-action="goonRerollOne"][data-index="0"]')?.click();
      await sleep(3000);
      check("a dial edited after the preview reaches the rerolled plan",
        app.preview?.[0]?.bp?.config?.chromeCount === typedCount,
        { typed: typedCount, planned: app.preview?.[0]?.bp?.config?.chromeCount });
      check("… and the field keeps the typed value across the reroll's repaint",
        Number(chromeField()?.value) === typedCount, chromeField()?.value);
      app.overrides = {};
      app.preview = null;
      await app.render();
      await sleep(300);
    }

    // ⑨ The whiff is narrated: at grade C a pull's draw carries the nothing-share, so a plan whose
    //    chrome landed short of its count MUST say so on the honesty list, with the plan's own number.
    {
      let whiffed = null;
      for (let i = 0; i < 40 && !whiffed; i++) {
        const plan = await GF.planGoonSquad({
          role: "solo", grade: "C", count: 1, seed: `__PW__whiff-${i}`,
          destinationFolder: locker, overrides: { chromeCount: 10 },
        });
        if ((plan?.[0]?.chrome?.nothingCount ?? 0) > 0) whiffed = plan[0];
      }
      check("a short chrome landing carries the whiff honesty line, with the plan's own count",
        !!whiffed && whiffed.honesty.some(h => h.code === "chromeWhiff"
          && h.n === whiffed.chrome.nothingCount && h.count === 10),
        whiffed && { nothing: whiffed.chrome.nothingCount, rows: whiffed.honesty.filter(h => h.code === "chromeWhiff") });
      const clean = await GF.planGoonSquad({
        role: "solo", grade: "A", count: 1, seed: "__PW__nowhiff",
        destinationFolder: locker, overrides: { chromeCount: 4 },
      });
      check("grade A cannot whiff, so no whiff line renders there",
        (clean?.[0]?.chrome?.nothingCount ?? -1) === 0
        && !clean?.[0]?.honesty.some(h => h.code === "chromeWhiff"),
        { nothing: clean?.[0]?.chrome?.nothingCount });
    }

    // ── DETERMINISM ON THE LIVE RIG ───────────────────────────────────────────────────────────────
    const detA = await GF.planGoonSquad({ role: "cop", grade: "C", count: 2, seed: "__PW__det", destinationFolder: locker });
    const detB = await GF.planGoonSquad({ role: "cop", grade: "C", count: 2, seed: "__PW__det", destinationFolder: locker });
    const strip = rows => JSON.stringify(rows.map(x => ({ n: x.bp.name, s: x.bp.stats, w: x.weapon?.name, c: x.chrome.items.map(i=>i.name), a: x.armor.layers.map(l=>l.name) })));
    check("the same seed produces a byte-identical squad plan against the real packs",
      strip(detA) === strip(detB), null);
    const detC = await GF.planGoonSquad({ role: "cop", grade: "C", count: 2, seed: "__PW__det-other", destinationFolder: locker });
    check("a different seed really produces a different squad", strip(detA) !== strip(detC), null);

    // ── THE GM GATE ───────────────────────────────────────────────────────────────────────────────
    check("the module's own generator setting still gates the entry point",
      typeof APP.openNpcGenerator === "function", null);

  } catch (e) {
    out.fails.push("THREW: " + e.message);
    out.checks.push("  FAIL  harness threw: " + e.message + "\n" + (e.stack||"").split("\n").slice(0,4).join("\n"));
  } finally {
    try { app?.close?.(); } catch (e) { /* ignore */ }
    // Restore this GM's own remembered count exactly as it was found.
    if (countKeyBefore === null) window.localStorage.removeItem(COUNT_KEY);
    else window.localStorage.setItem(COUNT_KEY, countKeyBefore);
    for (const id of madeActorIds) { try { await game.actors.get(id)?.delete(); } catch (e) { /* ignore */ } }
    if (lockerCreatedByThisRun) for (const id of madeFolderIds) { try { await game.folders.get(id)?.delete(); } catch (e) { /* ignore */ } }
    // A locker that already existed keeps its (restored) name and stays.
  }
  return out;
});

console.log("\nGOON FACTORY — rig keeper\n");
for (const line of r.checks) console.log(line);
console.log("\nnotes:", JSON.stringify(r.notes, null, 2));
if (errors.length) { console.log("\nconsole/page errors:"); for (const e of errors) console.log("  " + e); }
const errFail = errors.length > 0;
console.log(`\n${r.checks.filter(c=>c.startsWith("  PASS")).length} passed, ${r.fails.length} failed, ${errors.length} console errors`);
await b.close();
process.exit((r.fails.length || errFail) ? 1 : 0);
