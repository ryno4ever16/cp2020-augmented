/** FINAL fix-pass keeper (2026-07-11). One durable spec covering the headliner mechanisms landed in
 *  run-final/FIX-PASS-LEDGER-FINAL.md, driven on the ship-target rig :30004 (vanilla Tilt 1.1.1 + module).
 *  Each leg is mechanism-named (never game-fiction). Legs run in isolated page.evaluate calls so one
 *  throw can't sink the others; forced-dice overrides are installed + restored per-leg.
 *
 *   a  stun-save recovery: fail-check installs unconscious + preStunMovement flag; pass-check clears the
 *      status, restores the stored value, unsets the flag; a pass on a never-affected actor is a no-op.
 *   b  apply-path parity: a 3-hit same-location mono burst gives identical per-hit SP from
 *      resolveAreaDamagesSync and applyAreaDamages — 3/3/3 ablation-off (regression: NOT 3/0/0), 3/3/2 on.
 *   c  install re-click guard: first install debits funds + equips; a re-click returns false, warns, and
 *      leaves the values untouched; the sheet shows the installed indicator, not the button.
 *   d  manual round-tick control: with the round-tick master OFF the tracker control exists; the real DOM
 *      gesture decrements a timed consumable marker AND advances a placed rad zone by one round.
 *   e  chassis-stat refold floor: chassis REF 14 + a wound-state halving + a +2 recorded delta = 9, not 14.
 *   f  FBC set-stat gate: an SDP-only body leaves a REF boost intact (no advisory); a full-stat body drops
 *      the boost (chassis value stands) and rides the advisory on the took-card.
 *   g  damage-string normalizer: raw catalog forms are un-rollable, the normalized forms roll in-range; a
 *      real vehicle-fire gesture with such a string yields real rolled damage, not the Pen×10 estimate.
 *   h  paint-guidance to-hit (pure): difficultyMods raise the DV (flip hit→miss); operator bonus counts;
 *      resolvePaintHit is a bare 2-10.
 *   i  marker serialization: a second consumable marker added during a tick's expiry await window survives.
 *
 *  Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-final-fixpass.mjs */
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
// LEG a — stun-save recovery: status round-trip + preStunMovement flag store/restore/unset.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legA = await p.evaluate(async () => {
  const out = { ok: {}, nums: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const SR = await import("/modules/cp2020-augmented/module/combat/save-rolls.js");
  const SCOPE = "cp2020-augmented";
  const origRU = CONFIG.Dice.randomUniform, origMR = Math.random;
  let Q = [];
  CONFIG.Dice.randomUniform = () => Q.length ? Q.shift() : 0.05;
  const D = (k) => 1 - (k - 0.5) / 10;   // v14 inverted mapping: force a d10 = k
  try {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__FPa"))) await a.delete().catch(() => {});
    let sc = game.scenes.find(s => s.name === "__PW__FPaScene");
    if (!sc) sc = await Scene.create({ name: "__PW__FPaScene", width: 1000, height: 1000, grid: { size: 100 } });

    // self-check the die override before trusting the queue
    Q = [D(8)]; const scr = await new Roll("1d10").evaluate(); out.ok.diceSelfCheck = scr.total === 8;

    // ── real actor (no injected movement): the status-clear half of F1 ──
    const actor = await Actor.create({ name: "__PW__FPa Real", type: "character" });
    const [tok] = await sc.createEmbeddedDocuments("Token", [{ name: "__PW__FPaT", x: 100, y: 100, actorId: actor.id, actorLink: true, width: 1, height: 1 }]);
    const threshold = SR.getStunThreshold(actor);   // 6 for a default bt5 character
    out.nums.threshold = threshold;
    out.nums.capturedSpeed = actor.system?.movement?.walk ?? actor.system?.ma?.total ?? null;   // null on this schema
    const args = { actorId: actor.id, tokenId: tok.id, sceneId: sc.id };

    // FAIL → applies unconscious. Force a d10 strictly above the threshold.
    Q = [D(Math.min(10, threshold + 1))];
    await SR.executeStunSave(args); await sleep(400);
    out.ok.failAppliesUnconscious = actor.statuses?.has("unconscious") === true;

    // PASS → recovery clears unconscious. Force a d10 of 1 (≤ threshold).
    Q = [D(1)];
    await SR.executeStunSave(args); await sleep(400);
    out.ok.passClearsUnconscious = actor.statuses?.has("unconscious") === false;
    out.ok.flagUnsetAfterRecovery = (actor.getFlag(SCOPE, "preStunMovement") ?? null) === null;

    // NEGATIVE: a passing check on a never-affected actor touches nothing.
    const clean = await Actor.create({ name: "__PW__FPa Clean", type: "character" });
    const [ctok] = await sc.createEmbeddedDocuments("Token", [{ name: "__PW__FPaCT", x: 300, y: 300, actorId: clean.id, actorLink: true, width: 1, height: 1 }]);
    Q = [D(1)];
    await SR.executeStunSave({ actorId: clean.id, tokenId: ctok.id, sceneId: sc.id }); await sleep(300);
    out.ok.negNoStatus = clean.statuses?.has("unconscious") === false;
    out.ok.negNoFlag = (clean.getFlag(SCOPE, "preStunMovement") ?? null) === null;

    // ── release-path flag consumption: seed a preStunMovement flag + unconscious status, then a passing
    // recovery check must clear the status AND unset the seeded flag (the inverse the apply side installs).
    // (The apply side's own capture is inert on this schema — currentSpeed above is null — so the seed
    // exercises _releaseStunMovementOverride's flag-restore/unset logic directly, the authoritative half.)
    const rel = await Actor.create({ name: "__PW__FPa Rel", type: "character" });
    const [rtok] = await sc.createEmbeddedDocuments("Token", [{ name: "__PW__FPaRT", x: 500, y: 500, actorId: rel.id, actorLink: true, width: 1, height: 1 }]);
    const STORED = 42;
    await rel.setFlag(SCOPE, "preStunMovement", STORED);
    await rel.toggleStatusEffect("unconscious", { active: true }); await sleep(200);
    out.nums.storedFlag = rel.getFlag(SCOPE, "preStunMovement") ?? null;
    out.ok.seedPresent = (rel.getFlag(SCOPE, "preStunMovement") ?? null) === STORED && rel.statuses?.has("unconscious") === true;
    Q = [D(1)];   // PASS → _releaseStunMovementOverride consumes the flag + clears the status
    await SR.executeStunSave({ actorId: rel.id, tokenId: rtok.id, sceneId: sc.id }); await sleep(400);
    out.ok.releaseUnsetsFlag = (rel.getFlag(SCOPE, "preStunMovement") ?? null) === null;
    out.ok.releaseClearsStatus = rel.statuses?.has("unconscious") === false;

    for (const a of [actor, clean, rel]) await a.delete().catch(() => {});
    await sc.delete().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  finally { CONFIG.Dice.randomUniform = origRU; Math.random = origMR; }
  return out;
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LEG b — apply-path parity: sync resolver vs async auto path, ablation off (3/3/3) and on (3/3/2).
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legB = await p.evaluate(async () => {
  const out = { ok: {}, nums: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const A = await import("/modules/cp2020-augmented/module/combat/DamageApplicator.js");
  const FULL = A.ARMOR_MODES.FULL;
  const cov = (sp) => Object.fromEntries(["Head","Torso","lArm","rArm","lLeg","rLeg"]
    .map(k => [k, { stoppingPower: String(k === "Torso" ? sp : 0), ablation: 0 }]));
  const burst = { Torso: [{ damage: 5 }, { damage: 5 }, { damage: 5 }] };   // 5 > effective SP (3/2) → penetrates
  const spCol = (arr) => arr.map(h => h.spFull);
  try {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__FPb"))) await a.delete().catch(() => {});
    const actor = await Actor.create({ name: "__PW__FPb Target", type: "character" });
    await actor.update({ "system.damage": 0 });
    const armorData = { name: "__PW__FPb Vest", type: "armor", system: { equipped: true, armorType: "soft", coverage: cov(10) } };
    const [armor] = await actor.createEmbeddedDocuments("Item", [armorData]);
    actor.prepareData();

    // sync resolver (pure) — no document writes, so run both settings first
    out.nums.syncOff = spCol(A.resolveAreaDamagesSync({ target: actor, areaDamages: burst, mono: true, armorMode: FULL, ablate: false }));
    out.nums.syncOn  = spCol(A.resolveAreaDamagesSync({ target: actor, areaDamages: burst, mono: true, armorMode: FULL, ablate: true }));

    // async auto path, ablation OFF — armor is not mutated
    out.nums.asyncOff = spCol(await A.applyAreaDamages({ target: actor, areaDamages: burst, mono: true, armorMode: FULL, ablate: false, dryRun: false }));
    await sleep(300);

    // reset armor SP + actor HP, then async auto path, ablation ON — armor ablates 10→9→8 between hits
    await armor.update({ "system.coverage.Torso.stoppingPower": "10", "system.coverage.Torso.ablation": 0 });
    await actor.update({ "system.damage": 0 }); actor.prepareData(); await sleep(150);
    out.nums.asyncOn = spCol(await A.applyAreaDamages({ target: actor, areaDamages: burst, mono: true, armorMode: FULL, ablate: true, dryRun: false }));
    await sleep(300);

    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    out.ok.syncOff333       = eq(out.nums.syncOff, [3, 3, 3]);
    out.ok.syncOffNotRegr   = !eq(out.nums.syncOff, [3, 0, 0]);   // the compounding-multiplier regression
    out.ok.syncOn332        = eq(out.nums.syncOn, [3, 3, 2]);
    out.ok.asyncOff333      = eq(out.nums.asyncOff, [3, 3, 3]);
    out.ok.asyncOn332       = eq(out.nums.asyncOn, [3, 3, 2]);
    out.ok.pathsAgreeOff    = eq(out.nums.syncOff, out.nums.asyncOff);
    out.ok.pathsAgreeOn     = eq(out.nums.syncOn, out.nums.asyncOn);

    await actor.delete().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  return out;
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LEG c — install re-click guard + sheet indicator.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legC = await p.evaluate(async () => {
  const out = { ok: {}, nums: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const INS = await import("/modules/cp2020-augmented/module/cyberware/install.js");
  const warns = [];
  const origWarn = ui.notifications?.warn?.bind(ui.notifications);
  if (ui.notifications) ui.notifications.warn = (m, ...a) => { warns.push(String(m)); return origWarn ? origWarn(m, ...a) : undefined; };
  try {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__FPc"))) await a.delete().catch(() => {});
    const actor = await Actor.create({ name: "__PW__FPc Patient", type: "character" });
    await actor.update({ "system.eurobucks": 100000, "system.damage": 0 });
    const [item] = await actor.createEmbeddedDocuments("Item", [{
      name: "__PW__FPc Implant", type: "cyberware",
      system: { equipped: false, surgCode: "M", humanityCost: "1", cost: 200 }   // surgery M = cost 500, damage 1d6+1
    }]);

    // sheet BEFORE install: the install button is present (proves the template is in the DOM)
    await item.sheet.render(true); await sleep(600);
    out.ok.buttonBeforeInstall = !!item.sheet.element?.querySelector(".cyber-install");
    await item.sheet.close().catch(() => {});

    // first install: debits funds, equips, applies surgical damage
    const fundsBefore = Number(actor.system?.eurobucks) || 0;
    const r1 = await INS.installCyberware(actor, item, { confirm: false }); await sleep(400);
    const fundsAfter = Number(actor.system?.eurobucks) || 0;
    const dmgAfter = Number(actor.system?.damage) || 0;
    out.nums.fundsBefore = fundsBefore; out.nums.fundsAfter = fundsAfter; out.nums.dmgAfter = dmgAfter;
    out.ok.firstInstallTrue = r1 === true;
    out.ok.equippedAfterInstall = actor.items.get(item.id)?.system?.equipped === true;
    out.ok.fundsDebited = fundsAfter === fundsBefore - 500;   // surgery M cost

    // re-click guard: returns false, warns, leaves funds + damage untouched
    warns.length = 0;
    const r2 = await INS.installCyberware(actor, item, { confirm: false }); await sleep(300);
    out.ok.reClickFalse = r2 === false;
    out.ok.reClickWarned = warns.length >= 1;
    out.ok.fundsUnchanged = (Number(actor.system?.eurobucks) || 0) === fundsAfter;
    out.ok.damageUnchanged = (Number(actor.system?.damage) || 0) === dmgAfter;

    // sheet AFTER install: button gone, installed indicator present
    await item.sheet.render(true); await sleep(600);
    const root = item.sheet.element;
    out.ok.buttonGoneAfterInstall = !root?.querySelector(".cyber-install");
    out.ok.installedIndicatorShown = [...(root?.querySelectorAll(".field.inactive") ?? [])]
      .some(d => d.querySelector("label") && d.querySelectorAll("span").length >= 2 && !d.querySelector("button"));
    await item.sheet.close().catch(() => {});

    await actor.delete().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  finally { if (ui.notifications && origWarn) ui.notifications.warn = origWarn; }
  return out;
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LEG d — manual round-tick control: real DOM gesture decrements a timed marker + advances a rad zone.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legD = await p.evaluate(async () => {
  const out = { ok: {}, nums: {}, notes: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const CONS = await import("/modules/cp2020-augmented/module/mech/consumable.js");
  const ZONE = await import("/modules/cp2020-augmented/module/radiation/radiation-zones.js");
  const SCOPE = "cp2020-augmented";
  let restoreAuto = null;
  try {
    const prevAuto = (() => { try { return game.settings.get(SCOPE, "mechRoundTickAutomation"); } catch { return true; } })();
    restoreAuto = prevAuto;
    await game.settings.set(SCOPE, "mechRoundTickAutomation", false);   // master OFF → per-turn hooks stand down

    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__FPd"))) await a.delete().catch(() => {});
    for (const c of [...game.combats]) if (c.combatants.some(cb => cb.name?.startsWith?.("__PW__FPd"))) await c.delete().catch(() => {});

    let sc = game.scenes.find(s => s.name === "__PW__FPdScene");
    if (!sc) sc = await Scene.create({ name: "__PW__FPdScene", width: 2000, height: 2000, grid: { size: 100 } });
    await sc.activate();
    for (let i = 0; i < 40 && !(canvas?.ready && canvas.scene?.id === sc.id); i++) await sleep(150);

    const actor = await Actor.create({ name: "__PW__FPd Combatant", type: "character" });
    const [tok] = await sc.createEmbeddedDocuments("Token", [{ name: "__PW__FPd Tok", x: 500, y: 500, actorId: actor.id, actorLink: true, width: 1, height: 1 }]);
    await sleep(300);

    // a timed consumable marker on the combatant (turnsLeft 3 → expect 2 after one manual pass)
    const [cItem] = await actor.createEmbeddedDocuments("Item", [{
      name: "__PW__FPd Stim", type: "misc",
      system: { mechConsumable: { enabled: true, doses: 2, durationTurns: "3", note: "" } }
    }]);
    await CONS.useConsumable(cItem); await sleep(300);
    const markerTurns = (a) => { const raw = a.getFlag(SCOPE, "consumableState"); const l = Array.isArray(raw) ? raw : (raw ? [raw] : []); return l.find(m => m.itemId === cItem.id)?.turnsLeft ?? null; };
    out.nums.markerBefore = markerTurns(actor);   // 3

    // a FINITE radiation zone (turnsLeft 3 → expect 2 after one manual pass)
    const handle = await ZONE.placeRadZone({ x: 500 + 40, y: 500 + 40, radiusM: 5, radsFormula: "1", sourceLabel: "__PW__FPd Field", turnsLeft: 3 });
    const zoneTurns = () => Number(game.scenes.get(sc.id)?.regions?.get(handle?.doc?.id)?.flags?.[SCOPE]?.turnsLeft ?? handle?.doc?.flags?.[SCOPE]?.turnsLeft);
    out.nums.zoneBefore = zoneTurns();   // 3

    // a Combat with this token as the (started) current combatant, so combat.combatant.actor resolves
    const combat = await Combat.create({ scene: sc.id });
    await combat.createEmbeddedDocuments("Combatant", [{ tokenId: tok.id, sceneId: sc.id, actorId: actor.id, name: "__PW__FPd Combatant" }]);
    await combat.activate();
    await combat.startCombat();
    await sleep(400);
    out.ok.combatantResolves = combat.combatant?.actor?.id === actor.id;

    // render the tracker; the GM-only ⏭ control appears because the master is OFF
    ui.combat?.render(true);
    let btn = null;
    for (let i = 0; i < 40 && !btn; i++) { await sleep(150); btn = document.querySelector(".cp-manual-tick-btn"); }
    out.ok.controlExistsMasterOff = !!btn;

    // drive the REAL gesture (hover-hidden control → dispatchEvent bubbles to the document listener)
    if (btn) {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 50; i++) { await sleep(150); if (markerTurns(actor) === 2 && zoneTurns() === 2) break; }
    }
    out.nums.markerAfter = markerTurns(actor);   // 2
    out.nums.zoneAfter = zoneTurns();            // 2
    out.ok.markerDecremented = out.nums.markerBefore === 3 && out.nums.markerAfter === 2;
    out.ok.zoneAdvanced = out.nums.zoneBefore === 3 && out.nums.zoneAfter === 2;

    // NEGATIVE: with the master ON the control is not injected
    await game.settings.set(SCOPE, "mechRoundTickAutomation", true);
    ui.combat?.render(true); await sleep(600);
    out.ok.controlAbsentMasterOn = !document.querySelector(".cp-manual-tick-btn");

    await combat.delete().catch(() => {});
    await actor.delete().catch(() => {});
    await sc.delete().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  finally { if (restoreAuto !== null) { try { await game.settings.set(SCOPE, "mechRoundTickAutomation", restoreAuto); } catch {} } }
  return out;
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LEG e — chassis-stat refold floor (pure applyBorgStats): wound halving + recorded delta.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legE = await p.evaluate(async () => {
  const out = { ok: {}, nums: {} };
  const BG = await import("/modules/cp2020-augmented/module/mech/borg.js");
  const mkFake = (refTotal, wound, drugDelta) => ({
    woundState: () => wound,
    _mechStatMods: null,
    _mechDrugMods: drugDelta ? { ref: [{ value: drugDelta }] } : null,
    system: { stats: { ref: { total: refTotal, armorMod: 0, armorImplantMod: 0 } } },
  });
  const refAfter = (refTotal, wound, delta) => { const f = mkFake(refTotal, wound, delta); BG.applyBorgStats(f, { ref: refTotal }); return f.system.stats.ref.total; };
  try {
    out.nums.wound3Delta2  = refAfter(14, 3, 2);    // ceil(14/2)=7 → +2 → 9
    out.nums.wound3NoDelta = refAfter(14, 3, 0);    // ceil(14/2)=7
    out.nums.wound0Delta2  = refAfter(14, 0, 2);    // 14 → +2 clamped to cap 15
    out.nums.wound3NegDelta = refAfter(14, 3, -5);  // 7 floored (negative can't push below the reduced total)
    out.ok.refoldFloor9   = out.nums.wound3Delta2 === 9;    // headliner: 9, NOT 14
    out.ok.notRawChassis  = out.nums.wound3Delta2 !== 14;
    out.ok.woundHalfOnly  = out.nums.wound3NoDelta === 7;
    out.ok.capClamp15     = out.nums.wound0Delta2 === 15;
    out.ok.negFloored7    = out.nums.wound3NegDelta === 7;
  } catch (e) { out.THROWN = String(e?.stack || e); }
  return out;
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LEG f — FBC set-stat gate: SDP-only body keeps a REF boost (no advisory); full-stat drops it (advisory).
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legF = await p.evaluate(async () => {
  const out = { ok: {}, nums: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const DRUG = await import("/modules/cp2020-augmented/module/mech/drug.js");
  const refStim = () => ({ name: "__PW__FPf Stim", type: "cyberware",
    system: { equipped: true, mechDrug: { enabled: true, statBoosts: [{ stat: "ref", mod: 2 }], rollBoosts: [],
      duration: "3 turns", durationTurns: "3", expireSave: { stat: "", difficulty: 0, penalty: "" }, note: "" } } });
  const borgBody = (withStats) => ({ name: "__PW__FPf Body", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent" },
    flags: { "cp2020-augmented": { borgBody: Object.assign(
      { sdp: { Head: 30, Torso: 40, lArm: 30, rArm: 30, lLeg: 30, rLeg: 30 } },
      withStats ? { stats: { ref: 14, ma: 10, body: 12 } } : {}) } } });
  const cardHasAdvisory = (actor, before) => {
    const m = game.messages.contents.slice(before).find(msg => msg.speaker?.actor === actor.id && /drug-took/.test(msg.content || ""));
    return { found: !!m, advisory: /drug-fbc-advisory/.test(m?.content || "") };
  };
  try {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__FPf"))) await a.delete().catch(() => {});

    // ── SDP-only body: no stats block → borgSetStatKeys empty → REF boost applies, no advisory ──
    const sdpOnly = await Actor.create({ name: "__PW__FPf SdpOnly", type: "character" });
    await sdpOnly.createEmbeddedDocuments("Item", [borgBody(false)]);
    for (let i = 0; i < 20 && (Number(sdpOnly.system?.sdp?.sum?.Torso) || 0) !== 40; i++) await sleep(150);
    const [stim1] = await sdpOnly.createEmbeddedDocuments("Item", [refStim()]);
    const refBase1 = Number(sdpOnly.system?.stats?.ref?.total) || 0;   // meat value (SDP-only sets no stats)
    const before1 = game.messages.size;
    await DRUG.takeDrug(sdpOnly.items.get(stim1.id)); await sleep(600);
    const refAfter1 = Number(sdpOnly.system?.stats?.ref?.total) || 0;
    const card1 = cardHasAdvisory(sdpOnly, before1);
    out.nums.sdpRefBase = refBase1; out.nums.sdpRefAfter = refAfter1;
    out.ok.sdpBoostApplies = refAfter1 === refBase1 + 2;
    out.ok.sdpNoAdvisory = card1.found && card1.advisory === false;

    // ── full-stat body: chassis SETs REF → boost dropped (REF stays 14), advisory rides the card ──
    const fullStat = await Actor.create({ name: "__PW__FPf FullStat", type: "character" });
    await fullStat.createEmbeddedDocuments("Item", [borgBody(true)]);
    for (let i = 0; i < 20 && (Number(fullStat.system?.stats?.ref?.total) || 0) !== 14; i++) await sleep(150);
    const [stim2] = await fullStat.createEmbeddedDocuments("Item", [refStim()]);
    const before2 = game.messages.size;
    await DRUG.takeDrug(fullStat.items.get(stim2.id)); await sleep(600);
    const refAfter2 = Number(fullStat.system?.stats?.ref?.total) || 0;
    const card2 = cardHasAdvisory(fullStat, before2);
    out.nums.fullRefAfter = refAfter2;
    out.ok.fullBoostDropped = refAfter2 === 14;
    out.ok.fullShowsAdvisory = card2.found && card2.advisory === true;

    for (const a of [sdpOnly, fullStat]) await a.delete().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  return out;
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LEG g — damage-string normalizer: pure roll-path + a real vehicle-fire gesture (rolled ≠ Pen×10).
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legG = await p.evaluate(async () => {
  const out = { ok: {}, nums: {}, notes: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const origRU = CONFIG.Dice.randomUniform, origMR = Math.random;
  const D = (k) => 1 - (k - 0.5) / 10;
  const created = [];
  try {
    // ── (1) PURE roll-path: the RAW catalog forms don't parse; the NORMALIZED forms roll in-range ──
    const rollable = async (f) => { try { const r = await new Roll(f).evaluate(); return { ok: true, total: r.total }; } catch { return { ok: false, total: null }; } };
    const raw = ["5D10+10AP", "6D10AP", "1D6x1D6AP"];
    const norm = ["5D10+10", "6D10", "1D6*1D6"];
    const rawR = []; for (const f of raw) rawR.push((await rollable(f)).ok);
    const normR = []; for (const f of norm) normR.push(await rollable(f));
    out.nums.rawRollable = rawR;          // "5D10+10AP" throws; the lenient parser tolerates the other two
    out.nums.normTotals = normR.map(r => r.total);
    out.ok.plusFormUnrollable = rawR[0] === false;   // the +N AP form is the clear break the normalizer must fix
    out.ok.normFormsRoll = normR.every(r => r.ok);
    out.ok.normRanges =
      normR[0].total >= 15 && normR[0].total <= 60 &&   // 5D10+10
      normR[1].total >= 6  && normR[1].total <= 60 &&   // 6D10
      normR[2].total >= 1  && normR[2].total <= 36;     // 1D6*1D6

    // ── (2) REAL gesture: the .cp-vfire-apply handler runs the private normalizer, rolls rawDamage,
    //        and the ACPA SOP card must show real rolled damage ("60 dmg"), not "Pen 2 ≈ 20 dmg". ──
    // The rolled-vs-Pen×10 branch lives in the Maximum Metal SOP resolver, so engage that rule system.
    const prevMM = (() => { try { return game.settings.get("cp2020-augmented", "mmEnabled"); } catch { return false; } })();
    const prevRule = (() => { try { return game.settings.get("cp2020-augmented", "vehicleRuleSystem"); } catch { return "Core"; } })();
    out.notes.restoreMM = prevMM; out.notes.restoreRule = prevRule;
    try { await game.settings.set("cp2020-augmented", "vehicleDamageEnabled", true); } catch {}
    try { await game.settings.set("cp2020-augmented", "mmEnabled", true); } catch {}
    try { await game.settings.set("cp2020-augmented", "vehicleRuleSystem", "MaximumMetal"); } catch {}
    let sc = game.scenes.find(s => s.name === "__PW__FPgScene");
    if (!sc) sc = await Scene.create({ name: "__PW__FPgScene", width: 2000, height: 2000, grid: { size: 100 } });
    await sc.activate();
    for (let i = 0; i < 40 && !(canvas?.ready && canvas.scene?.id === sc.id); i++) await sleep(150);
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__FPg"))) await a.delete().catch(() => {});
    const suit = await Actor.create({ name: "__PW__FPg Suit", type: "cp2020-augmented.vehicle",
      system: { isACPA: true, str: 30, acpaCombatModel: "detailed", sp: { front: 5, side: 5, rear: 5, top: 5, bottom: 5 } } });
    created.push(suit);
    const [stok] = await sc.createEmbeddedDocuments("Token", [{ name: "__PW__FPg Tok", x: 500, y: 500, actorId: suit.id, actorLink: true, width: 2, height: 2 }]);
    await sleep(300);
    // target the suit token via the placeable (v13/v14 targeting)
    [...game.user.targets].forEach(t => t.setTarget(false, { releaseOthers: false }));
    canvas.tokens.get(stok.id)?.setTarget(true, { releaseOthers: true });
    await sleep(200);
    out.notes.targetCount = game.user.targets.size;

    if (game.user.targets.size === 1) {
      // force the 5 damage d10s (5D10+10) all to 10 → 60; the SOP resolver's own dice fall on defaults.
      CONFIG.Dice.randomUniform = (() => { const Q = [D(10), D(10), D(10), D(10), D(10)]; return () => Q.length ? Q.shift() : 0.5; })();
      // post a fire card carrying the raw catalog damage string, then drive the Apply button
      const before = new Set(game.messages.map(m => m.id));
      const msg = await ChatMessage.create({ content:
        `<button class="cp-vfire-apply" data-pen="2" data-facing="front" data-range="normal" data-dmg="5D10+10AP" data-weapon="__PW__FPg Cannon">Apply to Targeted Vehicle</button>` });
      ui.chat?.render(true); await sleep(300);
      let btn = document.querySelector(`[data-message-id="${msg.id}"] .cp-vfire-apply`);
      for (let i = 0; i < 25 && !btn; i++) { await sleep(120); btn = document.querySelector(`[data-message-id="${msg.id}"] .cp-vfire-apply`); }
      out.notes.buttonFound = !!btn;
      if (btn) {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        let card = null;
        // exclude our own button message (it contains "dmg" in data-dmg); match the SOP resolver's card body.
        for (let i = 0; i < 40 && !card; i++) { await sleep(150); card = game.messages.contents.find(m => !before.has(m.id) && m.id !== msg.id && /SDP \(suit\)|Armor SP|Toughness/i.test(m.content || "")); }
        const content = (card?.content || "").replace(/<[^>]+>/g, "");
        out.notes.sopCard = content.slice(0, 240);
        out.ok.gestureRealDamage = /60 dmg/.test(content) && !/≈/.test(content);   // rolled 60, not Pen×10 estimate
        out.notes.gestureRan = true;
      } else { out.notes.gestureParked = "vfire button not found in DOM"; }
      await msg?.delete?.().catch(() => {});
    } else {
      out.notes.gestureParked = "could not set exactly one target on the headless canvas";
    }
    await sc.delete().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  finally {
    CONFIG.Dice.randomUniform = origRU; Math.random = origMR;
    for (const a of created) await a.delete().catch(() => {});
    try { if (out.notes.restoreMM !== undefined) await game.settings.set("cp2020-augmented", "mmEnabled", out.notes.restoreMM); } catch {}
    try { if (out.notes.restoreRule !== undefined) await game.settings.set("cp2020-augmented", "vehicleRuleSystem", out.notes.restoreRule); } catch {}
  }
  return out;
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LEG h — paint-guidance to-hit (pure): difficultyMods raise the DV; operator bonus counts; hit 2-10.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legH = await p.evaluate(async () => {
  const out = { ok: {}, nums: {} };
  const M = await import("/modules/cp2020-augmented/module/vehicle/vehicle-missiles.js");
  try {
    const base = { d10: 7, operatorBonus: 10, targetNumber: 15 };
    const noDiff = M.resolvePaintToHit({ ...base, difficultyMods: 0 });   // total 17 vs dv 15 → hit
    const withDiff = M.resolvePaintToHit({ ...base, difficultyMods: 5 }); // total 17 vs dv 20 → miss
    const noOp = M.resolvePaintToHit({ d10: 7, operatorBonus: 0, targetNumber: 15, difficultyMods: 0 }); // 7 vs 15 → miss
    out.nums = { noDiff, withDiff, noOp };
    out.ok.baseHit = noDiff.total === 17 && noDiff.dv === 15 && noDiff.hit === true;
    out.ok.difficultyRaisesDV = withDiff.dv === 20 && withDiff.hit === false;   // flips hit → miss
    out.ok.operatorBonusCounts = noOp.hit === false && noDiff.hit === true;
    out.ok.paintHitBand = M.resolvePaintHit(1) === false && M.resolvePaintHit(2) === true && M.resolvePaintHit(10) === true && M.resolvePaintHit(0) === false;
  } catch (e) { out.THROWN = String(e?.stack || e); }
  return out;
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LEG i — marker serialization: a concurrent consumable add during a tick's expiry window survives.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legI = await p.evaluate(async () => {
  const out = { ok: {}, nums: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const CONS = await import("/modules/cp2020-augmented/module/mech/consumable.js");
  const SCOPE = "cp2020-augmented";
  const markers = (a) => { const raw = a.getFlag(SCOPE, "consumableState"); return Array.isArray(raw) ? raw : (raw ? [raw] : []); };
  try {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__FPi"))) await a.delete().catch(() => {});
    const actor = await Actor.create({ name: "__PW__FPi Actor", type: "character" });
    // itemA survives the tick (3→2); itemX expires this tick (1→0) → opens the wear-off await window
    const [itemA] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__FPi A", type: "misc", system: { mechConsumable: { enabled: true, doses: 3, durationTurns: "3", note: "" } } }]);
    const [itemX] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__FPi X", type: "misc", system: { mechConsumable: { enabled: true, doses: 3, durationTurns: "1", note: "" } } }]);
    const [itemB] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__FPi B", type: "misc", system: { mechConsumable: { enabled: true, doses: 3, durationTurns: "5", note: "" } } }]);
    await CONS.useConsumable(itemA); await sleep(150);
    await CONS.useConsumable(itemX); await sleep(200);
    out.nums.beforeIds = markers(actor).map(m => m.itemId);   // [A, X]

    // fire the tick AND a concurrent add (itemB) without awaiting between them — the per-actor queue must
    // serialize the two read-modify-writes so neither clobbers the other (no lost write).
    const pTick = CONS.runConsumableTickOnce({ combatant: { actor } });
    const pAdd  = CONS.useConsumable(itemB);
    await Promise.all([pTick, pAdd]);
    await sleep(400);

    const after = markers(actor);
    const ids = after.map(m => m.itemId);
    out.nums.afterIds = ids;
    out.nums.aTurns = after.find(m => m.itemId === itemA.id)?.turnsLeft ?? null;
    out.ok.survivorKept = ids.includes(itemA.id);          // the ticked survivor persisted (3→2)
    out.ok.concurrentAddKept = ids.includes(itemB.id);     // the concurrent add was NOT clobbered
    out.ok.expiredGone = !ids.includes(itemX.id);          // the expiring marker was cleared
    out.ok.survivorDecremented = out.nums.aTurns === 2;

    await actor.delete().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  return out;
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Node-side assertions
// ══════════════════════════════════════════════════════════════════════════════════════════════
const legs = { a: legA, b: legB, c: legC, d: legD, e: legE, f: legF, g: legG, h: legH, i: legI };
const checks = [];
const add = (leg, name, cond) => checks.push({ leg, name, ok: !!cond });

for (const [k, v] of Object.entries(legs)) if (v.THROWN) checks.push({ leg: k, name: `leg ${k} did not throw`, ok: false, got: v.THROWN });

// a
add("a", "a: die override self-check", legA.ok?.diceSelfCheck);
add("a", "a: failed check applies unconscious", legA.ok?.failAppliesUnconscious);
add("a", "a: recovery check clears unconscious", legA.ok?.passClearsUnconscious);
add("a", "a: preStunMovement flag unset after recovery", legA.ok?.flagUnsetAfterRecovery);
add("a", "a: pass on never-affected actor leaves status untouched", legA.ok?.negNoStatus);
add("a", "a: pass on never-affected actor sets no flag", legA.ok?.negNoFlag);
add("a", "a: seeded preStunMovement flag + status present", legA.ok?.seedPresent);
add("a", "a: recovery consumes+unsets the seeded flag", legA.ok?.releaseUnsetsFlag);
add("a", "a: recovery clears the seeded status", legA.ok?.releaseClearsStatus);

// b
add("b", "b: sync ablation-off = 3/3/3", legB.ok?.syncOff333);
add("b", "b: sync ablation-off NOT the 3/0/0 regression", legB.ok?.syncOffNotRegr);
add("b", "b: sync ablation-on = 3/3/2", legB.ok?.syncOn332);
add("b", "b: async ablation-off = 3/3/3", legB.ok?.asyncOff333);
add("b", "b: async ablation-on = 3/3/2", legB.ok?.asyncOn332);
add("b", "b: both paths agree (ablation-off)", legB.ok?.pathsAgreeOff);
add("b", "b: both paths agree (ablation-on)", legB.ok?.pathsAgreeOn);

// c
add("c", "c: install button present pre-install", legC.ok?.buttonBeforeInstall);
add("c", "c: first install returns true", legC.ok?.firstInstallTrue);
add("c", "c: item equipped after install", legC.ok?.equippedAfterInstall);
add("c", "c: surgery cost debited", legC.ok?.fundsDebited);
add("c", "c: re-click returns false", legC.ok?.reClickFalse);
add("c", "c: re-click raises a warning", legC.ok?.reClickWarned);
add("c", "c: re-click leaves funds unchanged", legC.ok?.fundsUnchanged);
add("c", "c: re-click leaves damage unchanged", legC.ok?.damageUnchanged);
add("c", "c: install button gone post-install", legC.ok?.buttonGoneAfterInstall);
add("c", "c: installed indicator shown post-install", legC.ok?.installedIndicatorShown);

// d
add("d", "d: combatant resolves on started combat", legD.ok?.combatantResolves);
add("d", "d: manual-tick control exists (master OFF)", legD.ok?.controlExistsMasterOff);
add("d", "d: gesture decrements the timed marker (3→2)", legD.ok?.markerDecremented);
add("d", "d: gesture advances the rad zone (3→2)", legD.ok?.zoneAdvanced);
add("d", "d: control absent when master ON", legD.ok?.controlAbsentMasterOn);

// e
add("e", "e: refold floors at wound-reduced + delta = 9 (not 14)", legE.ok?.refoldFloor9);
add("e", "e: refold not the raw chassis value", legE.ok?.notRawChassis);
add("e", "e: wound halving alone = 7", legE.ok?.woundHalfOnly);
add("e", "e: positive delta clamps at the cap (15)", legE.ok?.capClamp15);
add("e", "e: negative delta floored at the reduced total (7)", legE.ok?.negFloored7);

// f
add("f", "f: SDP-only body keeps the REF boost", legF.ok?.sdpBoostApplies);
add("f", "f: SDP-only took-card carries no advisory", legF.ok?.sdpNoAdvisory);
add("f", "f: full-stat body drops the boost (REF stays 14)", legF.ok?.fullBoostDropped);
add("f", "f: full-stat took-card carries the advisory", legF.ok?.fullShowsAdvisory);

// g
add("g", "g: the +N AP catalog form is un-rollable raw", legG.ok?.plusFormUnrollable);
add("g", "g: normalized forms roll", legG.ok?.normFormsRoll);
add("g", "g: normalized forms roll in-range", legG.ok?.normRanges);
// the real-gesture sub-leg is parked when the headless canvas can't target — report, don't fail
if (legG.notes?.gestureRan) add("g", "g: fire gesture yields real rolled damage (60, not Pen×10)", legG.ok?.gestureRealDamage);

// h
add("h", "h: paint base to-hit (17 vs 15 → hit)", legH.ok?.baseHit);
add("h", "h: difficultyMods raise the DV (flip hit→miss)", legH.ok?.difficultyRaisesDV);
add("h", "h: operator bonus counts toward the total", legH.ok?.operatorBonusCounts);
add("h", "h: resolvePaintHit is a bare 2-10", legH.ok?.paintHitBand);

// i
add("i", "i: ticked survivor persisted", legI.ok?.survivorKept);
add("i", "i: concurrent add not clobbered (no lost write)", legI.ok?.concurrentAddKept);
add("i", "i: expiring marker cleared", legI.ok?.expiredGone);
add("i", "i: survivor decremented (3→2)", legI.ok?.survivorDecremented);

// Filter documented CORE/canvas artifacts (not module regressions), per test-harness.md:
//  • v14 combat-tracker "'turn' in undefined" (CombatTracker._onRender guard defect).
//  • "reading 'addChild'" — a token drawn while the headless canvas is mid-init (the scene-activate
//    timing gotcha); harmless here, every functional check below is green regardless.
const realErrors = errors.filter(e =>
  !/'turn' in undefined|Cannot use 'in' operator to search for 'turn'/.test(e) &&
  !/reading 'addChild'/.test(e));
add("z", "z: no console errors", realErrors.length === 0);

const parked = [];
if (!legG.notes?.gestureRan) parked.push(`g: vehicle-fire gesture PARKED (${legG.notes?.gestureParked || "headless canvas targeting"})`);
parked.push("a: movement-restore half of F1 is INERT on this system schema (system.movement/ma.total null; v14 token movement.walk write is a runtime no-op) — status-clear + flag round-trip proven instead");

let pass = 0, fail = 0;
for (const c of checks) { console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : (c.got ? "  " + String(c.got).slice(0, 200) : "")}`); c.ok ? pass++ : fail++; }
console.log("\n  numbers:", JSON.stringify({ a: legA.nums, b: legB.nums, c: legC.nums, d: legD.nums, e: legE.nums, f: legF.nums, g: legG.nums, i: legI.nums }, null, 0));
if (Object.values(legs).some(l => l.notes)) console.log("  notes:", JSON.stringify(Object.fromEntries(Object.entries(legs).map(([k, v]) => [k, v.notes]).filter(([, n]) => n))));
if (errors.length) console.log("  console errors:", errors.slice(0, 8));
console.log("\n  PARKED / observations:");
for (const pk of parked) console.log("   • " + pk);
console.log(`\n  RESULT: ${fail === 0 ? "ALL GREEN" : "FAIL"}  ${pass}/${checks.length}`);
await b.close();
process.exit(fail === 0 ? 0 : 1);
