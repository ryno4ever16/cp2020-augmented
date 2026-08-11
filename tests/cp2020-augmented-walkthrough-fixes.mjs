/** WALKTHROUGH-FIXES keeper (1.1.0 pre-release, user visual-walkthrough bug list). One durable spec on
 *  the ship-target rig :30004 (vanilla Tilt 1.1.1 + module). Each leg is mechanism-named (never game
 *  fiction). Legs run in isolated page.evaluate calls so one throw can't sink the others; world settings
 *  and any user-flag mocks are captured + restored per-leg.
 *
 *   a  action-counter combat scoping: OUT of combat, N weapon-fire pipeline emits leave the action-count
 *      flag ABSENT + no dialog fold; IN a started combat the actor is a combatant in, counts accrue and the
 *      standard/ACPA penalties match the unchanged math; a stale prior-combat count is cleared at combatStart.
 *   b  radiation lifecycle: a dose to a stat-loss band reduces the stat readout; panel Cure ({temp,perm})
 *      removes ALL markers + the readout returns to base; Cure on a clean actor = local warn, NO card, no
 *      flag write; Reset wipes exposure+markers+seq+history (actorHasRadiation→false); two compounding
 *      exposures then Cure leave NO residual stat loss.
 *   c  radiation GM gates (mocked non-GM user context): cure/clear/dose write nothing; the death-card
 *      resolver warns RadGmOnly and posts no card.
 *   d  martial skill filter: a fresh actor's untrained martial row is rendered WITH cp-hidden on empty
 *      search; typing its name removes cp-hidden; level≥1 / ip>0 / chipped keep it visible on empty search;
 *      a non-martial skill is never empty-search hidden.
 *   e  card lock: resolving a stun-save prompt stamps cardResolved → re-rendered buttons disabled +
 *      .cp-card-resolved; a second click is inert (no second roll); GM ↺ re-arm clears the flag + re-enables;
 *      an un-stamped result card stays unstamped; a Take-Aim tracker toggle still cycles.
 *   f  sheet-fix smoke: ACPA sheet 600×780 resizable, .sheet-body present + scrolls, pilot select reachable;
 *      weapon-sheet selects ≤26px + no clipped labels; the weapon window title reads "Weapon:" not
 *      "TYPES.Item.weapon".
 *
 *  Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-walkthrough-fixes.mjs */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LEG a — action-counter combat scoping (out-of-combat no-op, in-combat accrual+penalty, combatStart clear)
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legA = await p.evaluate(async () => {
  const out = { ok: {}, nums: {}, notes: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const SCOPE = "cp2020-augmented";
  const DH = await import("/modules/cp2020-augmented/module/combat/damage-hooks.js");
  const { ModifiersDialog } = await import("/modules/cp2020-augmented/module/dialog/modifiers.js");
  const emitFire = (actor) => Hooks.callAll("cyberpunk2020.weaponFired", { attackerId: actor.id, areaDamages: {} });
  const cnt = (a) => a.getFlag(SCOPE, "actionCount");
  let restore = {};
  try {
    for (const k of ["multiActionPenaltyEnabled", "multiActionAutoTrack"]) {
      try { restore[k] = game.settings.get(SCOPE, k); } catch { restore[k] = undefined; }
      await game.settings.set(SCOPE, k, true);
    }
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__WFa"))) await a.delete().catch(() => {});
    for (const c of [...game.combats]) if (c.combatants.some(cb => cb.name?.startsWith?.("__PW__WFa"))) await c.delete().catch(() => {});

    const actor = await Actor.create({ name: "__PW__WFa Fighter", type: "character" });
    const [weapon] = await actor.createEmbeddedDocuments("Item", [{
      name: "__PW__WFa Pistol", type: "weapon",
      system: { equipped: true, weaponType: "Pistol", damage: "2d6+1", rof: 2, range: 50 } }]);
    const readExtraMod = async () => {
      let val = null;
      try {
        const dlg = new ModifiersDialog(actor, { weapon: actor.items.get(weapon.id), modifierGroups: [], targetTokens: [], onConfirm() {} });
        await dlg.render(true); await sleep(500);
        const root = dlg.element;
        const inp = root?.querySelector?.("input[name='extraMod']");
        val = inp ? String(inp.value ?? "") : null;
        await dlg.close().catch(() => {});
      } catch (e) { out.notes.dialogErr = String(e?.message ?? e); }
      return val;
    };

    // ── OUT of combat: N emits leave the flag ABSENT; the dialog folds no penalty ──
    for (let i = 0; i < 3; i++) { emitFire(actor); await sleep(120); }
    await sleep(300);
    out.notes.outCountFlag = cnt(actor) ?? null;
    out.ok.outOfCombatNoCount = (cnt(actor) ?? null) === null;               // flag never written
    const emOut = await readExtraMod();
    out.notes.extraModOut = emOut;
    out.ok.outOfCombatNoDialogMod = emOut === "" || emOut === "0" || emOut === null;  // no fold-in

    // ── IN a started combat the actor is a combatant in: counts accrue ──
    let sc = game.scenes.find(s => s.name === "__PW__WFaScene");
    if (!sc) sc = await Scene.create({ name: "__PW__WFaScene", width: 1000, height: 1000, grid: { size: 100 } });
    const [tok] = await sc.createEmbeddedDocuments("Token", [{ name: "__PW__WFa Tok", x: 200, y: 200, actorId: actor.id, actorLink: true, width: 1, height: 1 }]);
    // Scene-AGNOSTIC combat (scene: null): a combat linked to a non-viewed fixture scene stops
    // resolving as game.combat once the world has an active scene — the increment path reads
    // game.combat, so the counter silently never accrues (bit the battery re-run; a6 idiom).
    const combat = await Combat.create({});
    await combat.createEmbeddedDocuments("Combatant", [{ actorId: actor.id, name: "__PW__WFa Fighter" }]);
    await combat.activate(); await combat.startCombat(); await sleep(300);
    out.ok.combatStartedClean = (cnt(actor) ?? null) === null;   // startCombat cleared any leftover

    emitFire(actor);
    for (let i = 0; i < 40 && (cnt(actor) ?? 0) !== 1; i++) await sleep(120);
    out.nums.afterOne = cnt(actor) ?? null;
    out.ok.accruesInCombat = (cnt(actor) ?? 0) === 1;
    const emIn = await readExtraMod();   // declaring the 2nd action → −3
    out.notes.extraModIn = emIn;
    out.ok.inCombatDialogMod = emIn === "-3";

    emitFire(actor);
    for (let i = 0; i < 40 && (cnt(actor) ?? 0) !== 2; i++) await sleep(120);
    out.nums.afterTwo = cnt(actor) ?? null;
    out.ok.accrualCounts = (cnt(actor) ?? 0) === 2;

    // standard math (CP2020 p.105 −3 per extra action) vs the unchanged pure fn
    out.nums.std2 = DH._multiActionPenaltyFor(actor, 2);
    out.nums.std3 = DH._multiActionPenaltyFor(actor, 3);
    out.ok.stdMath = DH._multiActionPenaltyFor(actor, 1) === 0 && DH._multiActionPenaltyFor(actor, 2) === -3 && DH._multiActionPenaltyFor(actor, 3) === -6;

    // ACPA softened math (MM p.54 −(count+1))
    const acpa = await Actor.create({ name: "__PW__WFa Suit", type: "cp2020-augmented.vehicle", system: { isACPA: true, str: 30 } });
    out.ok.acpaIsAcpa = DH._isAcpa(acpa) === true;
    out.nums.acpa2 = DH._multiActionPenaltyFor(acpa, 2);
    out.nums.acpa3 = DH._multiActionPenaltyFor(acpa, 3);
    out.ok.acpaMath = DH._multiActionPenaltyFor(acpa, 1) === 0 && DH._multiActionPenaltyFor(acpa, 2) === -3 && DH._multiActionPenaltyFor(acpa, 3) === -4;

    // ── stale count from a PRIOR combat is cleared at combatStart ──
    await combat.delete().catch(() => {});
    await actor.setFlag(SCOPE, "actionCount", 7);
    await actor.setFlag(SCOPE, "actionCountRound", 1);
    out.ok.staleSeeded = (cnt(actor) ?? 0) === 7;
    const combat2 = await Combat.create({});
    await combat2.createEmbeddedDocuments("Combatant", [{ actorId: actor.id, name: "__PW__WFa Fighter" }]);
    await combat2.activate(); await combat2.startCombat();
    for (let i = 0; i < 40 && (cnt(actor) ?? null) !== null; i++) await sleep(120);
    out.nums.afterCombatStart = cnt(actor) ?? null;
    out.ok.combatStartClears = (cnt(actor) ?? null) === null;

    await combat2.delete().catch(() => {});
    for (const a of [actor, acpa]) await a.delete().catch(() => {});
    await sc.delete().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  finally { for (const [k, v] of Object.entries(restore)) if (v !== undefined) { try { await game.settings.set(SCOPE, k, v); } catch {} } }
  return out;
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LEG b — radiation lifecycle (dose→cure, clean-cure warn/no-card, reset, compound→cure)
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legB = await p.evaluate(async () => {
  const out = { ok: {}, nums: {}, notes: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const RAD = await import("/modules/cp2020-augmented/module/radiation/radiation.js");
  const SCOPE = "cp2020-augmented";
  const origRU = CONFIG.Dice.randomUniform;
  CONFIG.Dice.randomUniform = () => 0.999;   // v14 inverted: u≈1 → minimum faces → 1d100 gate passes (≤ statRedPct), tiny durations
  const warns = [];
  const origWarn = ui.notifications?.warn?.bind(ui.notifications);
  if (ui.notifications) ui.notifications.warn = (m, ...a) => { warns.push(String(m)); return origWarn ? origWarn(m, ...a) : undefined; };
  const bt = (a) => Number(a.system?.stats?.bt?.total);
  const ref = (a) => Number(a.system?.stats?.ref?.total);
  try {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__WFb"))) await a.delete().catch(() => {});

    // ── (1) dose to a stat-loss band, then Cure removes ALL markers + readout returns to base ──
    const A = await Actor.create({ name: "__PW__WFb Dosed", type: "character" });
    const btBase = bt(A), refBase = ref(A);
    out.nums.btBase = btBase; out.nums.refBase = refBase;
    await RAD.applyRadiationDose(A, 150, { perTurn: false });   // band 101–200: BODY(bt) −1 timed, REF −1 perm
    for (let i = 0; i < 50 && RAD.radMarkersFor(A).length < 2; i++) await sleep(120);
    out.nums.markersAfterDose = RAD.radMarkersFor(A).length;
    out.nums.btDosed = bt(A); out.nums.refDosed = ref(A);
    out.ok.doseReducesStat = bt(A) === btBase - 1 && ref(A) === refBase - 1;

    await RAD.cureRadiation(A, { temp: true, perm: true });
    for (let i = 0; i < 50 && RAD.radMarkersFor(A).length > 0; i++) await sleep(120);
    out.nums.markersAfterCure = RAD.radMarkersFor(A).length;
    out.nums.btCured = bt(A); out.nums.refCured = ref(A);
    out.ok.cureRemovesAllMarkers = RAD.radMarkersFor(A).length === 0;
    out.ok.cureReturnsToBase = bt(A) === btBase && ref(A) === refBase;

    // ── (2) Cure on a CLEAN actor: local warn, NO chat card, no flag write ──
    const B = await Actor.create({ name: "__PW__WFb Clean", type: "character" });
    warns.length = 0;
    const msgsBefore = new Set(game.messages.map(m => m.id));
    await RAD.cureRadiation(B, { temp: true, perm: true });
    await sleep(400);
    const newCards = game.messages.contents.filter(m => !msgsBefore.has(m.id) && m.speaker?.actor === B.id);
    out.ok.cleanCureWarns = warns.length >= 1;
    out.ok.cleanCureNoCard = newCards.length === 0;
    out.ok.cleanCureNoFlag = (B.getFlag(SCOPE, "radState") ?? null) === null;

    // ── (3) Reset wipes exposure+markers+seq+history; actorHasRadiation → false ──
    // A still carries exposure 150 + history 150 after the cure (Cure keeps them by design).
    out.ok.hadRadBeforeReset = RAD.actorHasRadiation(A) === true;
    await RAD.resetRadiation(A);
    for (let i = 0; i < 50 && RAD.actorHasRadiation(A); i++) await sleep(120);
    out.nums.expAfterReset = RAD.actorExposure(A);
    out.nums.histAfterReset = RAD.actorHistory(A);
    out.nums.seqAfterReset = RAD.actorExposureSeq(A);
    out.ok.resetWipesExposure = RAD.actorExposure(A) === 0;
    out.ok.resetWipesHistory = RAD.actorHistory(A) === 0;
    out.ok.resetWipesSeq = RAD.actorExposureSeq(A) === 0;
    out.ok.resetWipesMarkers = RAD.radMarkersFor(A).length === 0;
    out.ok.resetClearsHasRad = RAD.actorHasRadiation(A) === false;

    // ── (4) two compounding exposures then Cure → NO residual stat loss ──
    const C = await Actor.create({ name: "__PW__WFb Compound", type: "character" });
    const cBtBase = bt(C), cRefBase = ref(C);
    await RAD.applyRadiationDose(C, 150, { perTurn: false });
    for (let i = 0; i < 50 && RAD.radMarkersFor(C).length < 2; i++) await sleep(120);
    await RAD.clearExposure(C); await sleep(300);   // bumps incident seq, keeps markers + history
    await RAD.applyRadiationDose(C, 150, { perTurn: false });   // NEW incident → markers ADD
    for (let i = 0; i < 50 && RAD.radMarkersFor(C).length < 4; i++) await sleep(120);
    out.nums.compoundMarkers = RAD.radMarkersFor(C).length;
    out.nums.compoundBt = bt(C); out.nums.compoundRef = ref(C);
    out.ok.exposuresCompound = bt(C) === cBtBase - 2 && ref(C) === cRefBase - 2;
    await RAD.cureRadiation(C, { temp: true, perm: true });
    for (let i = 0; i < 50 && RAD.radMarkersFor(C).length > 0; i++) await sleep(120);
    out.nums.compoundBtCured = bt(C); out.nums.compoundRefCured = ref(C);
    out.ok.compoundCureNoResidual = bt(C) === cBtBase && ref(C) === cRefBase && RAD.radMarkersFor(C).length === 0;

    for (const a of [A, B, C]) await a.delete().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  finally {
    CONFIG.Dice.randomUniform = origRU;
    if (ui.notifications && origWarn) ui.notifications.warn = origWarn;
  }
  return out;
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LEG c — radiation GM gates (MOCKED non-GM user context via game.user.isGM getter override — NOT a
//          second client; the death-card resolver's warn/no-card path is asserted the same way)
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legC = await p.evaluate(async () => {
  const out = { ok: {}, nums: {}, notes: { method: "game.user.isGM mocked false via instance getter — no second browser client" } };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const RAD = await import("/modules/cp2020-augmented/module/radiation/radiation.js");
  const SCOPE = "cp2020-augmented";
  const warns = [];
  const origWarn = ui.notifications?.warn?.bind(ui.notifications);
  if (ui.notifications) ui.notifications.warn = (m, ...a) => { warns.push(String(m)); return origWarn ? origWarn(m, ...a) : undefined; };
  const setNonGM = () => Object.defineProperty(game.user, "isGM", { configurable: true, get: () => false });
  const restoreGM = () => { try { delete game.user.isGM; } catch {} };
  try {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__WFc"))) await a.delete().catch(() => {});
    // Seed a marker + exposure + history AS GM (before the mock) so the gated calls have something to (not) change.
    const A = await Actor.create({ name: "__PW__WFc Victim", type: "character" });
    await A.setFlag(SCOPE, "radState", [{ source: "seed", band: 101, seq: 1, statBoosts: [{ stat: "ref", mod: -1 }], turnsLeft: 0 }]);
    await A.setFlag(SCOPE, "radExposure", 150);
    await A.setFlag(SCOPE, "radHistory", 150);
    await A.setFlag(SCOPE, "radExposureSeq", 1);
    await sleep(150);
    const beforeMarkers = RAD.radMarkersFor(A).length;
    const beforeExp = RAD.actorExposure(A);

    setNonGM();
    out.ok.mockNonGM = game.user.isGM === false;

    await RAD.cureRadiation(A, { temp: true, perm: true }); await sleep(150);
    out.ok.nonGmCureNoWrite = RAD.radMarkersFor(A).length === beforeMarkers;   // marker untouched
    await RAD.clearExposure(A); await sleep(150);
    out.ok.nonGmClearNoWrite = RAD.actorExposure(A) === beforeExp;             // exposure untouched
    const doseRet = await RAD.applyRadiationDose(A, 500, { perTurn: false }); await sleep(150);
    out.ok.nonGmDoseNoWrite = RAD.actorExposure(A) === beforeExp && doseRet === null;

    // the posted death-card resolver: non-GM → warn RadGmOnly + no card posted
    warns.length = 0;
    const msgsBefore = new Set(game.messages.map(m => m.id));
    await RAD.executeRadiationDeathCheck({ actorId: A.id, check: { band: 101, deathPct: 50, deathBtm: true, deathOver: "2 mo", source: "seed" } });
    await sleep(300);
    const radGmOnly = game.i18n.localize("RadGmOnly");
    out.notes.radGmOnly = radGmOnly;
    const newCards = game.messages.contents.filter(m => !msgsBefore.has(m.id) && m.speaker?.actor === A.id);
    out.ok.deathCardNonGmWarns = warns.some(w => w === radGmOnly || /rad/i.test(w));
    out.ok.deathCardNonGmNoPost = newCards.length === 0;

    restoreGM();
    out.ok.gmRestored = game.user.isGM === true;
    await A.delete().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  finally { restoreGM(); if (ui.notifications && origWarn) ui.notifications.warn = origWarn; }
  return out;
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LEG d — martial skill filter: untrained-martial hidden on empty search; typing reveals; trained/ip/
//          chipped visible; non-martial never empty-search hidden.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legD = await p.evaluate(async () => {
  const out = { ok: {}, nums: {}, notes: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const SCOPE = "cp2020-augmented";
  try {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__WFd"))) await a.delete().catch(() => {});
    const actor = await Actor.create({ name: "__PW__WFd Skills", type: "character" });
    const mk = (name, sys) => ({ name, type: "skill", img: "systems/cyberpunk2020/img/skill-icon.svg",
      system: { flavor: "", notes: "", level: 0, chipLevel: 0, ip: 0, diffMod: 0, isChipped: false, isRoleSkill: false, stat: "ref", ...sys } });
    // Named with the "Martial Arts:" prefix — the same name convention the BASE template ships and that
    // isMartialArtSkillItem() matches (MARTIAL_ART_PREFIX_RE), i.e. the exact class bug #4 is about. The
    // plain skill carries no prefix. (system.isMartialArt is not on the base skill schema, so the name
    // convention is the reliable martial-art marker on a freshly created skill item.)
    await actor.createEmbeddedDocuments("Item", [
      mk("Martial Arts: WFd Aikido", { level: 0, ip: 0, isChipped: false }),   // untrained
      mk("Martial Arts: WFd Judo", { level: 1 }),                               // trained
      mk("Martial Arts: WFd Boxing", { level: 0, ip: 0, isChipped: true }),     // chipped
      mk("Martial Arts: WFd Karate", { level: 0, ip: 5 }),                      // has IP
      mk("__PW__WFd Handgun Plain", { level: 0 }),                              // non-martial
    ]);
    // Resolve by NAME — createEmbeddedDocuments return order ≠ input order (documented gotcha; the
    // battery run scrambled a positional destructure into cross-fixture identity swaps).
    const byName = (n) => actor.items.find(i => i.name === n && i.type === "skill");
    const untrained = byName("Martial Arts: WFd Aikido");
    const trained   = byName("Martial Arts: WFd Judo");
    const chipped   = byName("Martial Arts: WFd Boxing");
    const ipd       = byName("Martial Arts: WFd Karate");
    const plain     = byName("__PW__WFd Handgun Plain");
    await sleep(200);

    const sheet = actor.sheet;
    await sheet.render(true); await sleep(900);
    let root = sheet.element;
    const rowOf = (r, id) => r?.querySelector(`.field.skill[data-item-id="${id}"]`);
    const hidden = (r, id) => rowOf(r, id)?.classList.contains("cp-hidden") ?? null;

    out.nums.totalRows = root?.querySelectorAll(".field.skill[data-item-id]").length ?? 0;
    out.notes.rowsPresent = out.nums.totalRows > 0;

    // empty search
    out.ok.untrainedHiddenEmpty = hidden(root, untrained.id) === true;
    out.ok.trainedVisibleEmpty = hidden(root, trained.id) === false;
    out.ok.chippedVisibleEmpty = hidden(root, chipped.id) === false;
    out.ok.ipVisibleEmpty = hidden(root, ipd.id) === false;
    out.ok.plainVisibleEmpty = hidden(root, plain.id) === false;

    // predicate directly
    out.ok.predUntrainedTrue = sheet._cpIsUntrainedMartial(actor.items.get(untrained.id)) === true;
    out.ok.predTrainedFalse = sheet._cpIsUntrainedMartial(actor.items.get(trained.id)) === false;
    out.ok.predChippedFalse = sheet._cpIsUntrainedMartial(actor.items.get(chipped.id)) === false;
    out.ok.predIpFalse = sheet._cpIsUntrainedMartial(actor.items.get(ipd.id)) === false;
    out.ok.predPlainFalse = sheet._cpIsUntrainedMartial(actor.items.get(plain.id)) === false;

    // typing the name reveals the untrained row; clearing hides it again
    sheet._cpApplySkillFilterToDOM(root, "wfd aikido"); await sleep(120);
    out.ok.searchReveals = hidden(root, untrained.id) === false;
    sheet._cpApplySkillFilterToDOM(root, ""); await sleep(120);
    out.ok.clearReHides = hidden(root, untrained.id) === true;

    // train the untrained one → re-render → visible on empty search
    await actor.items.get(untrained.id).update({ "system.level": 1 });
    await sheet.render(true); await sleep(700);
    root = sheet.element;
    out.ok.trainedNowVisible = hidden(root, untrained.id) === false;

    await sheet.close().catch(() => {});
    await actor.delete().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  return out;
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LEG e — card lock: stun-save prompt stamp/disable/second-click-inert/GM-rearm; unstamped result card;
//          Take-Aim tracker toggle still cycles.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legE = await p.evaluate(async () => {
  const out = { ok: {}, nums: {}, notes: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const SCOPE = "cp2020-augmented";
  const SR = await import("/modules/cp2020-augmented/module/combat/save-rolls.js");
  const CL = await import("/modules/cp2020-augmented/module/card-lock.js");
  const origRU = CONFIG.Dice.randomUniform;
  CONFIG.Dice.randomUniform = () => 0.999;   // force a low stun roll (passes) so the resolver stays quiet
  try {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__WFe"))) await a.delete().catch(() => {});
    for (const c of [...game.combats]) if (c.combatants.some(cb => cb.name?.startsWith?.("__PW__WFe"))) await c.delete().catch(() => {});
    ui.sidebar?.expand?.(); ui.sidebar?.activateTab?.("chat");

    // Capture the world's active scene so cleanup can RESTORE it — activating a fixture scene and
    // then deleting it leaves game.scenes.active null for every later spec in a battery (bit the
    // battery re-run: the null-tokens class downstream of this keeper).
    const prevActiveSceneId = game.scenes.active?.id ?? null;
    out.notes.prevActiveScene = prevActiveSceneId;
    let sc = game.scenes.find(s => s.name === "__PW__WFeScene");
    if (!sc) sc = await Scene.create({ name: "__PW__WFeScene", width: 1000, height: 1000, grid: { size: 100 } });
    await sc.activate();
    for (let i = 0; i < 40 && !(canvas?.ready && canvas.scene?.id === sc.id); i++) await sleep(150);

    const actor = await Actor.create({ name: "__PW__WFe Subject", type: "character" });
    const [tok] = await sc.createEmbeddedDocuments("Token", [{ name: "__PW__WFe Tok", x: 300, y: 300, actorId: actor.id, actorLink: true, width: 1, height: 1 }]);
    await sleep(300);

    // ── post a stun-save prompt card ──
    const msgsBefore = new Set(game.messages.map(m => m.id));
    await SR.postStunSavePrompt(actor, canvas.tokens.get(tok.id) ?? null);
    let msg = null;
    for (let i = 0; i < 40 && !msg; i++) { await sleep(150); msg = game.messages.contents.find(m => !msgsBefore.has(m.id) && /cp-stun-save-roll/.test(m.content || "")); }
    out.notes.promptPosted = !!msg;
    if (!msg) throw new Error("stun-save prompt card not found");

    ui.chat?.render(true); await sleep(300);
    const btnSel = `[data-message-id="${msg.id}"] .cp-stun-save-roll`;
    let btn = null;
    for (let i = 0; i < 40 && !btn; i++) { await sleep(150); btn = document.querySelector(btnSel); }
    out.notes.buttonFound = !!btn;

    out.ok.unstampedInitially = CL.isCardResolved(msg) === false;

    // ── resolve: click the roll button → executeStunSave + markCardResolved stamp ──
    const rollMsgsBefore = new Set(game.messages.map(m => m.id));
    if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 50 && !CL.isCardResolved(msg); i++) await sleep(150);
    out.ok.resolveStamps = CL.isCardResolved(msg) === true;
    const rollCardsAfter1 = game.messages.contents.filter(m => !rollMsgsBefore.has(m.id) && m.id !== msg.id);
    out.nums.rollCardsAfterFirst = rollCardsAfter1.length;
    out.ok.firstClickRolled = rollCardsAfter1.length >= 1;

    // ── re-render: buttons disabled + .cp-card-resolved present ──
    await msg.update({}); ui.chat?.render(true); await sleep(500);
    let card = document.querySelector(`[data-message-id="${msg.id}"] .cyberpunk-card, [data-message-id="${msg.id}"] .cyberpunk`);
    for (let i = 0; i < 30 && !card; i++) { await sleep(150); card = document.querySelector(`[data-message-id="${msg.id}"] .cyberpunk-card, [data-message-id="${msg.id}"] .cyberpunk`); }
    out.ok.cardHasResolvedClass = card?.classList.contains("cp-card-resolved") === true;
    const stunBtn2 = document.querySelector(btnSel);
    out.ok.buttonDisabledAfterResolve = stunBtn2?.disabled === true;

    // ── second click is inert (no NEW roll message) ──
    const beforeSecond = new Set(game.messages.map(m => m.id));
    if (stunBtn2) stunBtn2.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(500);
    const afterSecond = game.messages.contents.filter(m => !beforeSecond.has(m.id));
    out.nums.secondClickNewMsgs = afterSecond.length;
    out.ok.secondClickInert = afterSecond.length === 0;

    // ── GM ↺ re-arm clears the flag + re-enables the button ──
    let rearm = document.querySelector(`[data-message-id="${msg.id}"] .cp-card-rearm`);
    for (let i = 0; i < 20 && !rearm; i++) { await sleep(150); rearm = document.querySelector(`[data-message-id="${msg.id}"] .cp-card-rearm`); }
    out.notes.rearmFound = !!rearm;
    if (rearm) {
      rearm.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 40 && CL.isCardResolved(msg); i++) await sleep(150);
      out.ok.rearmClearsFlag = CL.isCardResolved(msg) === false;
      await msg.update({}); ui.chat?.render(true); await sleep(400);
      const btn3 = document.querySelector(btnSel);
      out.ok.rearmReEnables = btn3 ? btn3.disabled === false : null;
    } else { out.notes.rearmParked = "re-arm control not found in DOM"; }

    // ── an un-stamped result card stays unstamped (stamping is per-message opt-in) ──
    const result = await ChatMessage.create({ content: `<div class="cyberpunk-card"><button class="cp-generic">Result</button></div>`, speaker: ChatMessage.getSpeaker({ actor }) });
    await sleep(200);
    out.ok.resultCardUnstamped = CL.isCardResolved(result) === false;
    await result.delete().catch(() => {});

    // ── Take-Aim tracker toggle still cycles (card-lock did not over-broadly disable tracker controls) ──
    const combat = await Combat.create({ scene: sc.id });
    await combat.createEmbeddedDocuments("Combatant", [{ tokenId: tok.id, sceneId: sc.id, actorId: actor.id, name: "__PW__WFe Subject" }]);
    await combat.activate(); await combat.startCombat(); await sleep(300);
    ui.combat?.render(true);
    let aimBtn = null;
    for (let i = 0; i < 40 && !aimBtn; i++) { await sleep(150); aimBtn = document.querySelector(".cp-take-aim-btn"); }
    out.notes.aimBtnFound = !!aimBtn;
    if (aimBtn) {
      aimBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 40 && (actor.getFlag(SCOPE, "aimRounds") ?? 0) !== 1; i++) await sleep(150);
      out.nums.aimAfterOne = actor.getFlag(SCOPE, "aimRounds") ?? 0;
      out.ok.aimCyclesUp = (actor.getFlag(SCOPE, "aimRounds") ?? 0) === 1;
      // drive to 3 then one more → cycles back to 0 (unset)
      for (let step = 0; step < 3; step++) {
        const b = document.querySelector(".cp-take-aim-btn");
        if (b) b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await sleep(300);
      }
      for (let i = 0; i < 20 && (actor.getFlag(SCOPE, "aimRounds") ?? null) !== null; i++) await sleep(150);
      out.nums.aimAfterWrap = actor.getFlag(SCOPE, "aimRounds") ?? null;
      out.ok.aimCyclesBack = (actor.getFlag(SCOPE, "aimRounds") ?? null) === null;
    } else { out.notes.aimParked = "take-aim control not found on the headless tracker"; }

    await combat.delete().catch(() => {});
    await actor.delete().catch(() => {});
    // Restore the world's active scene BEFORE deleting the fixture scene (leave the rig as found).
    const prev = prevActiveSceneId ? game.scenes.get(prevActiveSceneId) : null;
    if (prev) await prev.activate().catch(() => {});
    await sc.delete().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  finally { CONFIG.Dice.randomUniform = origRU; }
  return out;
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LEG f — sheet-fix smoke: ACPA sheet size/scroll/pilot; weapon-sheet selects + title.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legF = await p.evaluate(async () => {
  const out = { ok: {}, nums: {}, notes: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__WFf"))) await a.delete().catch(() => {});
    for (const it of game.items.filter(i => i.name?.startsWith("__PW__WFf"))) await it.delete().catch(() => {});

    // ── ACPA sheet ──
    const suit = await Actor.create({ name: "__PW__WFf Suit", type: "cp2020-augmented.vehicle",
      system: { isACPA: true, str: 40, sp: { front: 20, side: 18, rear: 16, top: 14, bottom: 14 }, acpaCombatModel: "detailed" } });
    const SheetCls = suit.sheet.constructor;
    const def = SheetCls.DEFAULT_OPTIONS?.position ?? {};
    out.nums.defaultSize = { w: def.width, h: def.height };
    out.ok.defaultSize600x780 = def.width === 600 && def.height === 780;
    out.ok.resizable = SheetCls.DEFAULT_OPTIONS?.window?.resizable === true;
    out.ok.partScrollable = (SheetCls.PARTS?.main?.scrollable ?? []).includes(".sheet-body");

    await suit.sheet.render(true); await sleep(900);
    const sr = suit.sheet.element;
    out.nums.renderedSize = { w: suit.sheet.position?.width, h: suit.sheet.position?.height };
    out.ok.rendered600x780 = suit.sheet.position?.width === 600 && suit.sheet.position?.height === 780;
    const body = sr?.querySelector(".sheet-body");
    out.ok.sheetBodyPresent = !!body;
    // Run-4: ">= 0" was a tautology. The honest form: when the body actually overflows, a written
    // scrollTop must STICK at its value; a non-overflowing body legitimately reports 0 and passes.
    if (body) { body.scrollTop = 20; await sleep(120); out.nums.scrollTop = body.scrollTop; out.ok.scrollSticks = (body.scrollHeight <= body.clientHeight) || body.scrollTop === 20; }
    const pilot = sr?.querySelector('select[name="system.pilotId"]');
    out.ok.pilotSelectPresent = !!pilot;
    out.ok.pilotSelectReachable = pilot ? pilot.offsetParent !== null : false;
    await suit.sheet.close().catch(() => {});
    await suit.delete().catch(() => {});

    // ── weapon item sheet ──
    const w = await Item.create({ name: "__PW__WFf Rifle", type: "weapon", system: { weaponType: "Rifle", damage: "5d6" } });
    await w.sheet.render(true); await sleep(900);
    const wr = w.sheet.element;
    const selects = [...(wr?.querySelectorAll("select") ?? [])];
    out.nums.selectCount = selects.length;
    out.nums.selectHeights = selects.map(s => Math.round(parseFloat(getComputedStyle(s).height)));
    out.ok.selectsCompact = selects.length > 0 && out.nums.selectHeights.every(h => h <= 26);
    const labels = [...(wr?.querySelectorAll("label") ?? [])];
    out.nums.clippedLabels = labels.filter(l => l.scrollWidth > l.clientWidth + 1).length;
    out.ok.noClippedLabels = out.nums.clippedLabels === 0;
    out.notes.title = w.sheet.title;
    out.notes.typesLoc = game.i18n.localize("TYPES.Item.weapon");
    out.ok.titleHasWeapon = /Weapon:/.test(String(w.sheet.title || "")) && !/TYPES\.Item/.test(String(w.sheet.title || ""));
    out.ok.typesKeyResolves = game.i18n.localize("TYPES.Item.weapon") === "Weapon";
    await w.sheet.close().catch(() => {});
    await w.delete().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  return out;
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Shared fixture: the provisioned ACPA suit + its linked pilot, in the world's MaximumMetal mode.
// Legs g/h/i open the maneuver dialog via the REAL header [data-action="controlRoll"] button and
// measure geometry / preselect / badge. The suit is a persistent fixture (never created/deleted by
// this keeper); only h3 mutates system.pilotId and restores it in a finally.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const DAI_NAME = "🦿 ACPA Suit — DaiOni";

// ── LEG g — maneuver-dialog geometry (condition-column alignment, resizable window, scroll behaviour)
const legG = await p.evaluate(async (DAI_NAME) => {
  const out = { ok: {}, nums: {}, notes: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const SCOPE = "cp2020-augmented";
  const findDlg = () => [...(foundry.applications?.instances?.values?.() ?? [])]
    .find(a => a?.element?.querySelector?.(".vehicle-control-dialog"));
  let dlgApp = null, actor = null;
  const restore = {};
  try {
    // Pin the ruleset to MaximumMetal so the {{#if isMM}} condition column + resizable dialog render,
    // regardless of the world's current toggle. Capture + restore.
    for (const k of ["mmEnabled", "vehicleRuleSystem", "vehicleControlEnabled"]) {
      try { restore[k] = game.settings.get(SCOPE, k); } catch { restore[k] = undefined; }
    }
    await game.settings.set(SCOPE, "mmEnabled", true);
    await game.settings.set(SCOPE, "vehicleRuleSystem", "MaximumMetal");
    await game.settings.set(SCOPE, "vehicleControlEnabled", true);

    actor = game.actors.find(a => a.name === DAI_NAME);
    out.notes.actorFound = !!actor;
    if (!actor) throw new Error("DaiOni fixture not found");

    await actor.sheet.render(true); await sleep(800);
    const sheetRoot = actor.sheet.element;
    const hdrBtn = sheetRoot?.querySelector('[data-action="controlRoll"]');
    out.notes.headerBtnFound = !!hdrBtn;
    if (!hdrBtn) throw new Error("controlRoll header button not found on the sheet");
    hdrBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 50 && !dlgApp; i++) { await sleep(150); dlgApp = findDlg(); }
    if (!dlgApp) throw new Error("control dialog did not open");
    await sleep(300);
    const dlgRoot = dlgApp.element;
    const content = dlgRoot.querySelector(".vehicle-control-dialog");
    const fieldset = content.querySelector("fieldset");
    const cbIds = ["#cp-ctl-cantsee", "#cp-ctl-multitask", "#cp-ctl-slippery", "#cp-ctl-icy", "#cp-ctl-cyberlink"];
    const cbs = cbIds.map(id => content.querySelector(id));
    out.nums.checkboxCount = cbs.filter(Boolean).length;
    const labels = cbs.map(c => c?.closest("label")).filter(Boolean);

    // g1 — the 5 checkboxes share one left edge (±1px)
    const lefts = cbs.map(c => c.getBoundingClientRect().left);
    out.nums.checkboxLefts = lefts.map(x => Math.round(x * 100) / 100);
    out.nums.leftSpread = Math.round((Math.max(...lefts) - Math.min(...lefts)) * 100) / 100;
    out.ok.checkboxLeftsEqual = (Math.max(...lefts) - Math.min(...lefts)) <= 1;

    // g2 — each condition label row spans the fieldset content box (±4px)
    const fcs = getComputedStyle(fieldset);
    const innerW = fieldset.clientWidth - parseFloat(fcs.paddingLeft) - parseFloat(fcs.paddingRight);
    out.nums.fieldsetInnerW = Math.round(innerW * 100) / 100;
    const labelW = labels.map(l => l.getBoundingClientRect().width);
    out.nums.labelWidths = labelW.map(w => Math.round(w * 100) / 100);
    out.nums.maxLabelDelta = Math.round(Math.max(...labelW.map(w => Math.abs(w - innerW))) * 100) / 100;
    out.ok.labelRowsSpanFieldset = labelW.every(w => Math.abs(w - innerW) <= 4);

    // g3 — consecutive condition-row vertical gaps ≤ 12px
    const rects = labels.map(l => l.getBoundingClientRect()).sort((a, b) => a.top - b.top);
    const gaps = [];
    for (let i = 1; i < rects.length; i++) gaps.push(rects[i].top - rects[i - 1].bottom);
    out.nums.rowGaps = gaps.map(g => Math.round(g * 100) / 100);
    out.nums.maxRowGap = gaps.length ? Math.round(Math.max(...gaps) * 100) / 100 : 0;
    out.ok.rowGapsTight = gaps.every(g => g <= 12);

    // g4 — the window is resizable + a resize handle exists in the DOM
    out.ok.windowResizable = dlgApp.options?.window?.resizable === true;
    const handle = dlgRoot.querySelector(".window-resize-handle");
    out.ok.resizeHandleExists = !!handle;

    // g5 — shrink to 300: the content div is the scroller (overflow-y:auto, VALUES scrollHeight>clientHeight)
    await dlgApp.setPosition({ height: 300 }); await sleep(350);
    const cs300 = getComputedStyle(content);
    out.notes.overflowY300 = cs300.overflowY;
    out.nums.scroll300 = { scrollH: content.scrollHeight, clientH: content.clientHeight };
    out.ok.overflowAutoAt300 = cs300.overflowY === "auto";
    out.ok.scrollsAt300 = content.scrollHeight > content.clientHeight;

    // g6 — at 300 the footer bbox is fully inside the window frame (pinned, not clipped off-frame)
    const footer = dlgRoot.querySelector("footer.form-footer, .form-footer, .window-content footer");
    out.notes.footerFound = !!footer;
    const fr = dlgRoot.getBoundingClientRect();
    const ftr = footer?.getBoundingClientRect();
    out.nums.frameBottom = Math.round(fr.bottom); out.nums.footerBottom = ftr ? Math.round(ftr.bottom) : null;
    out.ok.footerInsideFrame = !!ftr && ftr.top >= fr.top - 1 && ftr.bottom <= fr.bottom + 1
      && ftr.left >= fr.left - 1 && ftr.right <= fr.right + 1;

    // g7 — NEGATIVE: at a tall height (620) the scroller shows no phantom scrollbar (scrollH≈clientH)
    await dlgApp.setPosition({ height: 620 }); await sleep(350);
    out.nums.scroll620 = { scrollH: content.scrollHeight, clientH: content.clientHeight };
    out.nums.scroll620Delta = content.scrollHeight - content.clientHeight;
    out.ok.noPhantomScrollAt620 = (content.scrollHeight - content.clientHeight) <= 2;

    await dlgApp.close().catch(() => {});
    await actor.sheet.close().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  finally {
    try { if (dlgApp) await dlgApp.close().catch(() => {}); } catch {}
    try { if (actor?.sheet?.rendered) await actor.sheet.close().catch(() => {}); } catch {}
    for (const [k, v] of Object.entries(restore)) if (v !== undefined) { try { await game.settings.set(SCOPE, k, v); } catch {} }
  }
  return out;
}, DAI_NAME);

// ── LEG h — driver preselect honors the vehicle's linked pilot (openControlRollDialog pulls pilotId
//            to the front of the candidate list); NEGATIVE with pilotId cleared; duplicate guard.
const legH = await p.evaluate(async (DAI_NAME) => {
  const out = { ok: {}, nums: {}, notes: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const SCOPE = "cp2020-augmented";
  const findDlg = () => [...(foundry.applications?.instances?.values?.() ?? [])]
    .find(a => a?.element?.querySelector?.(".vehicle-control-dialog"));
  let actor = null, origPilotId = null, pilotRestored = false;
  const settingRestore = {};
  const openDialog = async () => {
    const sheetRoot = actor.sheet.element;
    const hdrBtn = sheetRoot?.querySelector('[data-action="controlRoll"]');
    if (!hdrBtn) throw new Error("controlRoll header button not found");
    hdrBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    let app = null;
    for (let i = 0; i < 50 && !app; i++) { await sleep(150); app = findDlg(); }
    if (!app) throw new Error("control dialog did not open");
    await sleep(250);
    return app;
  };
  try {
    for (const k of ["mmEnabled", "vehicleRuleSystem", "vehicleControlEnabled"]) {
      try { settingRestore[k] = game.settings.get(SCOPE, k); } catch { settingRestore[k] = undefined; }
    }
    await game.settings.set(SCOPE, "mmEnabled", true);
    await game.settings.set(SCOPE, "vehicleRuleSystem", "MaximumMetal");
    await game.settings.set(SCOPE, "vehicleControlEnabled", true);

    actor = game.actors.find(a => a.name === DAI_NAME);
    if (!actor) throw new Error("DaiOni fixture not found");
    origPilotId = actor.system?.pilotId ?? "";
    out.notes.origPilotId = origPilotId;
    const pilot = origPilotId ? game.actors.get(origPilotId) : null;
    out.notes.pilotName = pilot?.name ?? null;
    const pilotRefTotal = pilot ? Number(pilot.system?.stats?.ref?.total) || 0 : null;
    out.nums.pilotRefTotal = pilotRefTotal;
    out.ok.fixtureHasPilot = !!origPilotId && !!pilot;

    await actor.sheet.render(true); await sleep(800);

    // ── h1: pilotId set → first driver option IS the linked pilot AND is the selected option ──
    let app = await openDialog();
    let driverSel = app.element.querySelector("#cp-ctl-driver");
    out.notes.firstOptionValue = driverSel?.options?.[0]?.value ?? null;
    out.notes.selectedValue = driverSel?.value ?? null;
    out.ok.firstOptionIsPilot = driverSel?.options?.[0]?.value === origPilotId;
    out.ok.pilotIsSelected = driverSel?.value === origPilotId && driverSel?.selectedIndex === 0;

    // ── h2: the REF prefill equals the linked actor's ref.total (VALUE) ──
    const refIn = app.element.querySelector("#cp-ctl-ref");
    out.nums.refPrefill = refIn ? Number(refIn.value) : null;
    out.ok.refPrefillMatchesPilot = refIn && Number(refIn.value) === pilotRefTotal;

    // ── h4: duplicate guard — the pilot appears exactly ONCE in the option list ──
    const pilotOptCount = [...(driverSel?.options ?? [])].filter(o => o.value === origPilotId).length;
    out.nums.pilotOptionCount = pilotOptCount;
    out.ok.pilotAppearsOnce = pilotOptCount === 1;
    await app.close().catch(() => {}); await sleep(200);

    // ── h3 NEGATIVE: clear pilotId → first option is the natural first candidate, NOT forced to the
    //     former pilot. Compute the natural candidate order the same way _candidateDrivers does. ──
    await actor.update({ "system.pilotId": "" }); await sleep(200);
    await actor.sheet.render(true); await sleep(500);
    const boarded = (canvas?.tokens?.placeables ?? [])
      .filter(t => t.document?.flags?.[SCOPE]?.boardedVehicle === actor.id && t.actor).map(t => t.actor);
    const owned = game.actors.filter(a => (a.type === "character" || a.type === "npc") && a.isOwner && !a.getFlag(SCOPE, "missileProxy"));
    const seen = new Set(); const natural = [];
    for (const a of [...boarded, ...owned]) { if (seen.has(a.id)) continue; seen.add(a.id); natural.push(a); }
    const naturalFirstId = natural[0]?.id ?? null;
    out.notes.naturalFirstId = naturalFirstId;

    const app2 = await openDialog();
    const driverSel2 = app2.element.querySelector("#cp-ctl-driver");
    out.notes.clearedFirstOption = driverSel2?.options?.[0]?.value ?? null;
    // "Not forced to the former pilot" = the ordering equals the natural discovery order (no unshift
    // of the old pilot). If the natural first HAPPENS to be the old pilot, that is still correct
    // un-forced order — so the honest mechanism check is options[0] === naturalFirstId.
    out.ok.negOrderNotForced = driverSel2?.options?.[0]?.value === naturalFirstId;
    out.notes.negFirstDiffersFromPilot = driverSel2?.options?.[0]?.value !== origPilotId;
    await app2.close().catch(() => {}); await sleep(150);

    // restore pilotId + assert it took
    await actor.update({ "system.pilotId": origPilotId }); await sleep(200);
    pilotRestored = true;
    out.ok.pilotIdRestored = (actor.system?.pilotId ?? "") === origPilotId;

    await actor.sheet.close().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  finally {
    // Guarantee pilotId restoration even on a mid-leg throw.
    try {
      if (actor && !pilotRestored && origPilotId != null && (actor.system?.pilotId ?? "") !== origPilotId) {
        await actor.update({ "system.pilotId": origPilotId }).catch(() => {});
      }
    } catch {}
    try { for (const app of [...(foundry.applications?.instances?.values?.() ?? [])]) if (app?.element?.querySelector?.(".vehicle-control-dialog")) await app.close().catch(() => {}); } catch {}
    try { if (actor?.sheet?.rendered) await actor.sheet.close().catch(() => {}); } catch {}
    for (const [k, v] of Object.entries(settingRestore)) if (v !== undefined) { try { await game.settings.set(SCOPE, k, v); } catch {} }
  }
  return out;
}, DAI_NAME);

// ── LEG i — ruleset badge + countermeasures hint on the DaiOni sheet render.
const legI = await p.evaluate(async (DAI_NAME) => {
  const out = { ok: {}, nums: {}, notes: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const SCOPE = "cp2020-augmented";
  let actor = null;
  const settingRestore = {};
  try {
    for (const k of ["mmEnabled", "vehicleRuleSystem"]) {
      try { settingRestore[k] = game.settings.get(SCOPE, k); } catch { settingRestore[k] = undefined; }
    }
    await game.settings.set(SCOPE, "mmEnabled", true);
    await game.settings.set(SCOPE, "vehicleRuleSystem", "MaximumMetal");

    actor = game.actors.find(a => a.name === DAI_NAME);
    if (!actor) throw new Error("DaiOni fixture not found");
    await actor.sheet.render(true); await sleep(800);
    const root = actor.sheet.element;

    // i1 — the header ruleset field carries the badge span and NO input look-alike
    const badge = root.querySelector("span.cp-ruleset-badge");
    out.notes.badgeFound = !!badge;
    const field = badge?.closest(".field");
    out.ok.badgeIsSpan = !!badge && badge.tagName.toLowerCase() === "span";
    out.ok.fieldHasNoInput = !!field && field.querySelector("input") === null;

    // i2 — badge text is the LOCALIZED name ("Maximum Metal"), not the raw "MaximumMetal" key value
    const badgeText = (badge?.textContent ?? "").trim();
    const localizedMM = game.i18n.localize("CYBERPUNK.Vehicle.RulesetNameMM");
    out.notes.badgeText = badgeText;
    out.notes.localizedMM = localizedMM;
    out.ok.badgeTextLocalized = badgeText === localizedMM && badgeText === "Maximum Metal";
    out.ok.badgeNotRawKey = badgeText !== "MaximumMetal";

    // i3 — the badge is not clipped (scrollWidth <= clientWidth). .field is display:flex so the span
    //       is a flex item with real box metrics.
    out.nums.badgeScrollW = badge?.scrollWidth ?? null;
    out.nums.badgeClientW = badge?.clientWidth ?? null;
    out.nums.badgeRectW = badge ? Math.round(badge.getBoundingClientRect().width * 100) / 100 : null;
    out.ok.badgeNotClipped = !!badge && badge.scrollWidth <= badge.clientWidth + 1;

    // i4 — the countermeasures hint paragraph carries the new "declared loadout" sentence
    const cmHint = root.querySelector(".cp-cm-hint");
    out.notes.cmHintFound = !!cmHint;
    const cmText = (cmHint?.textContent ?? "");
    out.notes.cmHintText = cmText.slice(0, 200);
    out.ok.cmHintDeclaredLoadout = /declared loadout/.test(cmText);

    await actor.sheet.close().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  finally {
    try { if (actor?.sheet?.rendered) await actor.sheet.close().catch(() => {}); } catch {}
    for (const [k, v] of Object.entries(settingRestore)) if (v !== undefined) { try { await game.settings.set(SCOPE, k, v); } catch {} }
  }
  return out;
}, DAI_NAME);

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Node-side assertions
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legs = { a: legA, b: legB, c: legC, d: legD, e: legE, f: legF, g: legG, h: legH, i: legI };
const checks = [];
const add = (leg, name, cond) => checks.push({ leg, name, ok: !!cond });
for (const [k, v] of Object.entries(legs)) if (v.THROWN) checks.push({ leg: k, name: `leg ${k} did not throw`, ok: false, got: v.THROWN });

// a
add("a", "a: out-of-combat emits leave the count flag ABSENT", legA.ok?.outOfCombatNoCount);
add("a", "a: out-of-combat dialog folds no penalty", legA.ok?.outOfCombatNoDialogMod);
add("a", "a: combatStart begins from a clean count", legA.ok?.combatStartedClean);
add("a", "a: count accrues in a started combat (→1)", legA.ok?.accruesInCombat);
add("a", "a: in-combat dialog folds the −3 (2nd action)", legA.ok?.inCombatDialogMod);
add("a", "a: count keeps accruing (→2)", legA.ok?.accrualCounts);
add("a", "a: standard penalty math unchanged (0/−3/−6)", legA.ok?.stdMath);
add("a", "a: ACPA is recognized", legA.ok?.acpaIsAcpa);
add("a", "a: ACPA softened math unchanged (0/−3/−4)", legA.ok?.acpaMath);
add("a", "a: stale prior-combat count seeded", legA.ok?.staleSeeded);
add("a", "a: combatStart clears the stale count", legA.ok?.combatStartClears);

// b
add("b", "b: dose to a stat-loss band reduces the readout", legB.ok?.doseReducesStat);
add("b", "b: Cure removes ALL markers", legB.ok?.cureRemovesAllMarkers);
add("b", "b: Cure returns the readout to base", legB.ok?.cureReturnsToBase);
add("b", "b: Cure on a clean actor warns", legB.ok?.cleanCureWarns);
add("b", "b: Cure on a clean actor posts NO card", legB.ok?.cleanCureNoCard);
add("b", "b: Cure on a clean actor writes no flag", legB.ok?.cleanCureNoFlag);
add("b", "b: actor had radiation before Reset", legB.ok?.hadRadBeforeReset);
add("b", "b: Reset wipes exposure", legB.ok?.resetWipesExposure);
add("b", "b: Reset wipes lifetime history", legB.ok?.resetWipesHistory);
add("b", "b: Reset wipes the incident seq", legB.ok?.resetWipesSeq);
add("b", "b: Reset wipes markers", legB.ok?.resetWipesMarkers);
add("b", "b: actorHasRadiation false after Reset", legB.ok?.resetClearsHasRad);
add("b", "b: two exposures compound the stat loss (−2)", legB.ok?.exposuresCompound);
add("b", "b: Cure after compounding leaves no residual", legB.ok?.compoundCureNoResidual);

// c
add("c", "c: non-GM user context mocked", legC.ok?.mockNonGM);
add("c", "c: non-GM Cure writes nothing", legC.ok?.nonGmCureNoWrite);
add("c", "c: non-GM Clear writes nothing", legC.ok?.nonGmClearNoWrite);
add("c", "c: non-GM Dose writes nothing (returns null)", legC.ok?.nonGmDoseNoWrite);
add("c", "c: non-GM death-card resolver warns", legC.ok?.deathCardNonGmWarns);
add("c", "c: non-GM death-card resolver posts no card", legC.ok?.deathCardNonGmNoPost);
add("c", "c: GM context restored", legC.ok?.gmRestored);

// d
add("d", "d: skill rows rendered", legD.notes?.rowsPresent);
add("d", "d: untrained martial hidden on empty search", legD.ok?.untrainedHiddenEmpty);
add("d", "d: trained martial visible on empty search", legD.ok?.trainedVisibleEmpty);
add("d", "d: chipped martial visible on empty search", legD.ok?.chippedVisibleEmpty);
add("d", "d: IP-carrying martial visible on empty search", legD.ok?.ipVisibleEmpty);
add("d", "d: non-martial skill never empty-search hidden", legD.ok?.plainVisibleEmpty);
add("d", "d: predicate true for untrained martial", legD.ok?.predUntrainedTrue);
add("d", "d: predicate false for trained/chipped/ip/plain", legD.ok?.predTrainedFalse && legD.ok?.predChippedFalse && legD.ok?.predIpFalse && legD.ok?.predPlainFalse);
add("d", "d: typing the name reveals the untrained row", legD.ok?.searchReveals);
add("d", "d: clearing the search re-hides it", legD.ok?.clearReHides);
add("d", "d: training it makes it visible on empty search", legD.ok?.trainedNowVisible);

// e
add("e", "e: stun-save card unstamped initially", legE.ok?.unstampedInitially);
add("e", "e: resolving the card stamps cardResolved", legE.ok?.resolveStamps);
add("e", "e: first click produced a roll message", legE.ok?.firstClickRolled);
add("e", "e: re-rendered card carries .cp-card-resolved", legE.ok?.cardHasResolvedClass);
add("e", "e: re-rendered roll button is disabled", legE.ok?.buttonDisabledAfterResolve);
add("e", "e: second click is inert (no new roll)", legE.ok?.secondClickInert);
add("e", "e: GM re-arm clears the flag", legE.ok?.rearmClearsFlag);
add("e", "e: GM re-arm re-enables the button", legE.ok?.rearmReEnables);
add("e", "e: an un-stamped result card stays unstamped", legE.ok?.resultCardUnstamped);
if (legE.notes?.aimBtnFound) {
  add("e", "e: Take-Aim toggle cycles up (→1)", legE.ok?.aimCyclesUp);
  add("e", "e: Take-Aim toggle wraps back (→0)", legE.ok?.aimCyclesBack);
}

// f
add("f", "f: ACPA default size 600×780", legF.ok?.defaultSize600x780);
add("f", "f: ACPA sheet resizable", legF.ok?.resizable);
add("f", "f: .sheet-body registered as the scroller", legF.ok?.partScrollable);
add("f", "f: ACPA rendered at 600×780", legF.ok?.rendered600x780);
add("f", "f: .sheet-body present in the DOM", legF.ok?.sheetBodyPresent);
add("f", "f: .sheet-body scrollTop sticks", legF.ok?.scrollSticks);
add("f", "f: pilot select present", legF.ok?.pilotSelectPresent);
add("f", "f: pilot select reachable (not display:none)", legF.ok?.pilotSelectReachable);
add("f", "f: weapon-sheet selects ≤26px", legF.ok?.selectsCompact);
add("f", "f: weapon-sheet no clipped labels", legF.ok?.noClippedLabels);
add("f", "f: weapon window title reads 'Weapon:' not TYPES.Item", legF.ok?.titleHasWeapon);
add("f", "f: TYPES.Item.weapon key resolves to 'Weapon'", legF.ok?.typesKeyResolves);

// g — maneuver-dialog geometry
add("g", "g: dialog opened via the header controlRoll button", legG.notes?.headerBtnFound && !legG.THROWN);
add("g", "g: all 5 condition checkboxes present", legG.nums?.checkboxCount === 5);
add("g", "g1: the 5 checkboxes share one left edge (±1px)", legG.ok?.checkboxLeftsEqual);
add("g", "g2: each condition row spans the fieldset content box (±4px)", legG.ok?.labelRowsSpanFieldset);
add("g", "g3: consecutive condition-row gaps ≤ 12px", legG.ok?.rowGapsTight);
add("g", "g4: the dialog window is resizable", legG.ok?.windowResizable);
add("g", "g4: a .window-resize-handle exists", legG.ok?.resizeHandleExists);
add("g", "g5: at height 300 the content computes overflow-y auto", legG.ok?.overflowAutoAt300);
add("g", "g5: at height 300 scrollHeight > clientHeight (scrolls)", legG.ok?.scrollsAt300);
add("g", "g6: at height 300 the footer bbox sits inside the window frame", legG.ok?.footerInsideFrame);
add("g", "g7: NEGATIVE — at height 620 no phantom scrollbar (scrollH≈clientH)", legG.ok?.noPhantomScrollAt620);

// h — driver preselect honors the linked pilot
add("h", "h: fixture has a linked pilot", legH.ok?.fixtureHasPilot);
add("h", "h1: first driver option IS the linked pilot", legH.ok?.firstOptionIsPilot);
add("h", "h1: the linked pilot is the selected option (index 0)", legH.ok?.pilotIsSelected);
add("h", "h2: REF prefill equals the linked actor's ref.total", legH.ok?.refPrefillMatchesPilot);
add("h", "h4: duplicate guard — pilot appears exactly ONCE", legH.ok?.pilotAppearsOnce);
add("h", "h3: NEGATIVE — cleared pilotId → first option = natural candidate (not forced)", legH.ok?.negOrderNotForced);
add("h", "h3: pilotId restored after the negative case", legH.ok?.pilotIdRestored);

// i — ruleset badge + countermeasures hint
add("i", "i1: ruleset field renders span.cp-ruleset-badge (a span, not input)", legI.ok?.badgeIsSpan);
add("i", "i1: the ruleset field carries NO input element", legI.ok?.fieldHasNoInput);
add("i", "i2: badge text is the localized 'Maximum Metal'", legI.ok?.badgeTextLocalized);
add("i", "i2: badge is NOT the raw 'MaximumMetal' key value", legI.ok?.badgeNotRawKey);
add("i", "i3: badge scrollWidth ≤ clientWidth (not clipped)", legI.ok?.badgeNotClipped);
add("i", "i4: countermeasures hint includes 'declared loadout'", legI.ok?.cmHintDeclaredLoadout);

// Filter documented CORE/canvas artifacts (not module regressions), per test-harness.md:
//  • v14 combat-tracker "'turn' in undefined" (CombatTracker._onRender core guard defect).
//  • "reading 'addChild'" — a token drawn while the headless canvas is mid-init (scene-activate timing).
const realErrors = errors.filter(e =>
  !/'turn' in undefined|Cannot use 'in' operator to search for 'turn'/.test(e) &&
  !/reading 'addChild'/.test(e));
add("z", "z: no console errors", realErrors.length === 0);

const parked = [];
if (legC.notes) parked.push("c: GM gates asserted via a MOCKED game.user.isGM getter (not a second browser client) — a real non-GM session is disproportionate here");
if (!legE.notes?.aimBtnFound) parked.push("e: Take-Aim cycle PARKED (control not on the headless tracker)");
if (!legE.notes?.rearmFound) parked.push("e: GM re-arm PARKED (control not found in DOM)");

let pass = 0, fail = 0;
for (const c of checks) { console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : (c.got ? "  " + String(c.got).slice(0, 220) : "")}`); c.ok ? pass++ : fail++; }
console.log("\n  numbers:", JSON.stringify({ a: legA.nums, b: legB.nums, c: legC.nums, d: legD.nums, e: legE.nums, f: legF.nums, g: legG.nums, h: legH.nums, i: legI.nums }, null, 0));
console.log("  notes:", JSON.stringify(Object.fromEntries(Object.entries(legs).map(([k, v]) => [k, v.notes]).filter(([, n]) => n && Object.keys(n).length))));
if (errors.length) console.log("  console errors (all):", errors.slice(0, 10));
if (parked.length) { console.log("\n  PARKED / observations:"); for (const pk of parked) console.log("   • " + pk); }
console.log(`\n  RESULT: ${fail === 0 ? "ALL GREEN" : "FAIL"}  ${pass}/${checks.length}`);
await b.close();
process.exit(fail === 0 ? 0 : 1);
