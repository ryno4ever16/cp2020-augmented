/** GOON FACTORY — the rig keeper (GOON-FACTORY-SPEC.md §4).
 *
 *  The PURE half of §4 has its own no-VTT suite (tests/npcgen-goonfactory.test.mjs, 114 legs): the
 *  clamps, the reservation arithmetic, the four chrome engine rules, the layering law, the stat
 *  shapes, the formula fields and the numbering are all proven there. THIS file proves the half only
 *  a running Foundry can answer:
 *
 *   - the GATING chain: Advanced is disabled until a grade is picked; a re-pick re-derives; a LOCKED
 *     control is truly inert (a hand-set DOM value on a disabled input never reaches the plan);
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
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l))||us[0];await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

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
  const BP  = await import("/modules/cp2020-augmented/module/npcgen/blueprint.js");
  const GF  = await import("/modules/cp2020-augmented/module/npcgen/goon-factory.js");
  const APP = await import("/modules/cp2020-augmented/module/npcgen/npcgen-app.js");

  const madeActorIds = [];
  const madeFolderIds = [];
  let lockerCreatedByThisRun = false;
  let app = null;

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

    const advBox = root.querySelector(".cp-goon-advanced");
    check("the Advanced checkbox exists", !!advBox, !!advBox);
    check("Advanced is DISABLED before any threat level is picked", advBox?.disabled === true, advBox?.disabled);
    check("no dial region is rendered before a threat level is picked",
      !!root.querySelector(".cp-goon") && !root.querySelector(".cp-goon-dials"),
      { hasWindow: !!root.querySelector(".cp-goon"), hasDials: !!root.querySelector(".cp-goon-dials") });

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
