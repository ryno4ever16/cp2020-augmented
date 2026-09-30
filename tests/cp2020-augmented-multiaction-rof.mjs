/**
 * MULTI-ACTION COUNTER vs RATE OF FIRE (user-relayed Discord report 2026-09-30; RYNO's ruling = option A).
 *
 * CP2020 p.98 "Actions": one action is "Attack up to your weapon's maximum Rate of Fire (ROF), or make a
 * Melee attack"; p.106: a three-round burst "is made as one action"; p.98 "Two Weapon Attacks" are one act
 * at -3 on both weapons. The counter used to advance once per fire ROLL, and the base rolls a semi-auto
 * weapon one shot per roll, so an ROF-2 pistol's second shot pre-filled -3 (rig-proven before the fix).
 *
 * Now a fire roll CONTINUES the open attack action while the same weapon is fired semi-auto under its
 * ROF; burst / full auto / melee spend the whole action; a second weapon joins the action only with Dual
 * Wield ticked; any other tracked action (dodge, parry, aim, manual +) closes it; a shot past the ROF is a
 * new action with a note; every card of ONE trigger pull (a multi-target burst) is one action.
 *
 * Legs:
 *   P  pure step function (attackActionStep), one leg per branch
 *   E1 same weapon, semi-auto: shot 1 free, shot 2 continues (note "shot 2 of 2", no seed), shot 3 is a new
 *      action (-3 seeded, note names the ROF); the counter reads 1, 1, 2
 *   E2 shoot / melee / shoot = 0 / -3 / -6 (the report's third scenario)
 *   E3 a declared dodge closes the attack action: shoot, dodge, shoot = 0 / (dodge) / -6
 *   E4 second weapon: opens action 2 (-3) until Dual Wield is ticked, then joins (0, note) - live re-eval
 *   E5 full auto twice = two actions (unchanged); the payload carries a per-pull id and the method name
 *   E6 setting off: no seed, no note, the counter still tracks
 *   E7 round advance clears the count and the attack state
 * Wording rule: legs are named after the mechanism (continue, join, close), not the fiction.
 */
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

const r = await p.evaluate(async () => {
  const out = { pure: {}, e: {} };
  const SCOPE = "cp2020-augmented";
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const DH = await import("/modules/cp2020-augmented/module/combat/damage-hooks.js");

  // ── P: the pure step ──────────────────────────────────────────────────────
  const step = DH.attackActionStep;
  out.pure.exported = typeof step === "function";
  if (out.pure.exported) {
    const semi = (over = {}) => ({ itemId: "p", round: 1, fireMethod: "__semiAuto", rof: 2, shots: 1, dualWield: false, fireId: null, ...over });
    const st = (shots, extra = {}) => ({ round: 1, shots, roundShots: { ...shots }, lastFireId: null, ...extra });
    const pick = (s) => ({ kind: s.kind, newAction: s.newAction, shots: s.state.shots, roundShots: s.state.roundShots, firedInAction: s.firedInAction, firedInRound: s.firedInRound });
    out.pure.fresh      = pick(step(null, semi()));
    out.pure.cont       = pick(step(st({ p: 1 }), semi()));
    out.pure.rofSpent   = pick(step(st({ p: 2 }), semi()));
    out.pure.other      = pick(step(st({ p: 1 }), semi({ itemId: "q" })));
    out.pure.join       = pick(step(st({ p: 1 }), semi({ itemId: "q", dualWield: true })));
    out.pure.joinNoOpen = pick(step(null, semi({ itemId: "q", dualWield: true })));
    out.pure.autoTwice  = pick(step(st({ s: 25 }), semi({ itemId: "s", fireMethod: "__fullAuto", rof: 25, shots: 10 })));
    out.pure.stale      = pick(step(st({ p: 1 }), semi({ round: 2 })));
    out.pure.melee      = pick(step(st({ k: 1 }), semi({ itemId: "k", fireMethod: "__meleeBonk", rof: 1 })));
    out.pure.samePull   = pick(step(st({ s: 25 }, { lastFireId: "F1" }), semi({ itemId: "s", fireMethod: "__fullAuto", rof: 25, fireId: "F1" })));
    out.pure.noRof      = pick(step(st({ p: 1 }), semi({ rof: null })));
  }

  // ── E: the real dialog + cards inside a started combat ────────────────────
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__MAR"))) await a.delete().catch(() => {});
  const wasFumble = game.settings.get("cyberpunk2020", "fumbleTableEnabled");
  if (wasFumble) await game.settings.set("cyberpunk2020", "fumbleTableEnabled", false);
  const wasPenalty = game.settings.get(SCOPE, "multiActionPenaltyEnabled");
  if (!wasPenalty) await game.settings.set(SCOPE, "multiActionPenaltyEnabled", true);
  const priorCombatId = game.combat?.id ?? null;
  let combat = null;
  const actor = await Actor.create({ name: "__PW__MAR Shooter", type: "character" });
  try {
    await actor.update({ "system.stats.ref.base": 8 });
    const mk = (name, system) => ({ name, type: "weapon", system });
    const created = await actor.createEmbeddedDocuments("Item", [
      mk("__PW__MAR Pistol A", { weaponType: "Pistol", attackType: "SemiAuto", rof: 2, shots: 12, shotsLeft: 12, damage: "2d6+1", range: 50, accuracy: 0, reliability: "ST", ammoType: "9mm" }),
      mk("__PW__MAR Pistol B", { weaponType: "Pistol", attackType: "SemiAuto", rof: 2, shots: 12, shotsLeft: 12, damage: "2d6+1", range: 50, accuracy: 0, reliability: "ST", ammoType: "9mm" }),
      mk("__PW__MAR SMG",      { weaponType: "SMG",    attackType: "Auto",     rof: 25, shots: 30, shotsLeft: 30, damage: "2d6+1", range: 150, accuracy: 0, reliability: "ST", ammoType: "9mm" }),
      mk("__PW__MAR Knife",    { weaponType: "Melee",  attackType: "Melee",    rof: 1, damage: "1d6", range: 1, accuracy: 0, reliability: "ST" }),
    ]);
    const byName = (n) => actor.items.find(i => i.name === `__PW__MAR ${n}`);
    const A = byName("Pistol A"), B = byName("Pistol B"), SMG = byName("SMG"), K = byName("Knife");
    out.e.fixtures = { created: created.length, A: !!A, B: !!B, SMG: !!SMG, K: !!K, knifeRanged: K?.isRanged?.() ?? null };

    combat = await Combat.create({ scene: null, active: true });
    await combat.createEmbeddedDocuments("Combatant", [{ actorId: actor.id, initiative: 10 }]);
    await combat.startCombat();
    await sleep(700);
    const combatant = combat.combatants.find(c => c.actor?.id === actor.id);
    out.e.combat = { started: game.combat?.started, round: game.combat?.round, isMine: game.combat?.id === combat.id, combatant: !!combatant };

    const sheet = actor.sheet; await sheet.render(true); await sleep(900);
    const flags = () => {
      const raw = actor.getFlag(SCOPE, "attackAction");
      let st = null; try { st = typeof raw === "string" ? JSON.parse(raw) : raw ?? null; } catch { st = "unparseable"; }
      return { count: actor.getFlag(SCOPE, "actionCount") ?? null, round: actor.getFlag(SCOPE, "actionCountRound") ?? null, attack: st };
    };
    const submitOf = (d) => [...(d.element?.querySelectorAll('button[type="submit"], button.fire') ?? [])].find(bt => bt.offsetParent !== null) ?? null;
    const untilDialog = async (d) => { for (let i = 0; i < 40 && !(d.element?.querySelector("input[name='extraMod']") && submitOf(d)); i++) await sleep(150); return !!submitOf(d); };
    const readDialog = (d) => ({
      extraMod: d.element?.querySelector("input[name='extraMod']")?.value ?? null,
      note: d.element?.querySelector(".cp-multi-action-note")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      kind: d.element?.querySelector(".cp-multi-action-note")?.dataset?.kind ?? null,
    });
    const open = async (item) => { const d = sheet._cpOpenWeaponAttackDialog(item); const ok = await untilDialog(d); await sleep(250); return { d, ok }; };
    const setControl = async (d, { fireMode, dualWield } = {}) => {
      const root = d.element;
      if (fireMode !== undefined) { const el = root.querySelector('select[name="fields.fireMode"], select[name="fireMode"], .field[data-path="fireMode"] select'); if (el) { el.value = fireMode; el.dispatchEvent(new Event("change", { bubbles: true })); } }
      if (dualWield !== undefined) { const el = root.querySelector('input[name="fields.dualWield"], input[name="dualWield"], .field[data-path="dualWield"] input[type="checkbox"]'); if (el) { el.checked = dualWield; el.dispatchEvent(new Event("change", { bubbles: true })); } }
      await sleep(200);
    };
    const fire = async (d) => {
      const before = new Set(game.messages.contents.map(m => m.id));
      const flagsBefore = JSON.stringify(flags());
      submitOf(d)?.click();
      let msg = null;
      for (let i = 0; i < 60 && !msg; i++) { await sleep(150); msg = game.messages.contents.find(m => !before.has(m.id)) ?? null; }
      for (let i = 0; i < 30 && JSON.stringify(flags()) === flagsBefore; i++) await sleep(150);   // the chained flag write lands after the card
      await sleep(400);
      const txt = (msg?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return { card: !!msg, snippet: txt.slice(0, 120), after: flags() };
    };
    const closeDialog = async (d) => { try { await d.close(); } catch {} await sleep(150); };
    const nextRound = async () => {
      await combat.nextRound();
      for (let i = 0; i < 30 && flags().count !== null; i++) await sleep(150);
      await sleep(300);
      return { round: game.combat?.round, flags: flags() };
    };
    const dodgeViaTracker = async () => {
      await ui.combat?.render(true); await sleep(600);
      let btn = null;
      for (let i = 0; i < 20 && !btn; i++) { btn = document.querySelector(`.cp-dodge-btn[data-combatant-id="${combatant.id}"]`); if (!btn) await sleep(150); }
      if (!btn) return { clicked: false };
      btn.click();
      for (let i = 0; i < 30 && !actor.getFlag(SCOPE, "dodging"); i++) await sleep(150);
      await sleep(400);
      return { clicked: true, dodging: !!actor.getFlag(SCOPE, "dodging"), flags: flags() };
    };

    // E1: same weapon, semi-auto, three shots in round 1
    let o = await open(A); const s1 = { pre: readDialog(o.d), opened: o.ok }; s1.fired = await fire(o.d);
    o = await open(A);     const s2 = { pre: readDialog(o.d), opened: o.ok }; s2.fired = await fire(o.d);
    o = await open(A);     const s3 = { pre: readDialog(o.d), opened: o.ok }; s3.fired = await fire(o.d);
    out.e.e1 = { s1, s2, s3 };

    // E2: shoot / melee / shoot
    out.e.e2 = { start: await nextRound() };
    o = await open(A); out.e.e2.shot1 = { pre: readDialog(o.d) }; out.e.e2.shot1.fired = await fire(o.d);
    o = await open(K); out.e.e2.knife = { pre: readDialog(o.d), opened: o.ok }; out.e.e2.knife.fired = await fire(o.d);
    o = await open(A); out.e.e2.shot2 = { pre: readDialog(o.d) }; out.e.e2.shot2.fired = await fire(o.d);

    // E3: shoot / dodge / shoot
    out.e.e3 = { start: await nextRound() };
    o = await open(A); out.e.e3.shot1 = { pre: readDialog(o.d) }; out.e.e3.shot1.fired = await fire(o.d);
    out.e.e3.dodge = await dodgeViaTracker();
    o = await open(A); out.e.e3.shot2 = { pre: readDialog(o.d) }; out.e.e3.shot2.fired = await fire(o.d);
    await actor.unsetFlag(SCOPE, "dodging").catch(() => {});

    // E4: second weapon joins under Dual Wield (live re-evaluation in the open dialog)
    out.e.e4 = { start: await nextRound() };
    o = await open(A); out.e.e4.shotA = { pre: readDialog(o.d) }; out.e.e4.shotA.fired = await fire(o.d);
    o = await open(B); out.e.e4.bBefore = readDialog(o.d);
    await setControl(o.d, { dualWield: true });  out.e.e4.bTicked = readDialog(o.d);
    await setControl(o.d, { dualWield: false }); out.e.e4.bUnticked = readDialog(o.d);
    await setControl(o.d, { dualWield: true });  out.e.e4.bFired = await fire(o.d);

    // E5: full auto twice; the payload carries the per-pull id and the method
    out.e.e5 = { start: await nextRound(), payloads: [] };
    const cap = (pl) => out.e.e5.payloads.push({ fireId: pl?.fireId ?? null, fireMethod: pl?.fireMethod ?? null, dualWield: pl?.dualWield ?? null, weaponId: pl?.weaponId ?? null });
    Hooks.on("cyberpunk2020.weaponFired", cap);
    o = await open(SMG); await setControl(o.d, { fireMode: "FullAuto" }); out.e.e5.burst1 = { pre: readDialog(o.d) }; out.e.e5.burst1.fired = await fire(o.d);
    o = await open(SMG); await setControl(o.d, { fireMode: "FullAuto" }); out.e.e5.burst2 = { pre: readDialog(o.d) }; out.e.e5.burst2.fired = await fire(o.d);
    Hooks.off("cyberpunk2020.weaponFired", cap);

    // E6: the switch off - nothing seeded, no note, the counter still tracks
    out.e.e6 = { start: await nextRound() };
    await game.settings.set(SCOPE, "multiActionPenaltyEnabled", false);
    o = await open(A); out.e.e6.shot1 = { pre: readDialog(o.d) }; out.e.e6.shot1.fired = await fire(o.d);
    o = await open(A); out.e.e6.shot2 = { pre: readDialog(o.d) }; out.e.e6.shot2.fired = await fire(o.d);
    o = await open(A); out.e.e6.shot3 = { pre: readDialog(o.d) }; out.e.e6.shot3.fired = await fire(o.d);
    await game.settings.set(SCOPE, "multiActionPenaltyEnabled", true);

    // E7: the round boundary clears everything
    out.e.e7 = { start: await nextRound() };
    o = await open(A); out.e.e7.fresh = readDialog(o.d); await closeDialog(o.d);
    await sheet.close().catch(() => {});
  } catch (e) { out.e.error = String(e?.stack ?? e); }
  finally {
    if (combat) await combat.delete().catch(() => {});
    if (priorCombatId) await game.combats.get(priorCombatId)?.activate().catch(() => {});
    await actor.delete().catch(() => {});
    if (wasFumble) await game.settings.set("cyberpunk2020", "fumbleTableEnabled", true).catch(() => {});
    await game.settings.set(SCOPE, "multiActionPenaltyEnabled", wasPenalty).catch(() => {});
  }
  return out;
});

const legs = [];
const ok = (name, cond, got) => legs.push([name, !!cond, got]);
const J = (x) => JSON.stringify(x);
const P = r.pure;
ok("P0 attackActionStep is exported", P.exported, J(P));
if (P.exported) {
  ok("P1 first shot opens an action holding one shot", P.fresh.kind === "new" && P.fresh.newAction && P.fresh.shots.p === 1, J(P.fresh));
  ok("P2 same weapon under ROF continues (no new action, shot 2 of 2)", P.cont.kind === "continue" && !P.cont.newAction && P.cont.shots.p === 2 && P.cont.firedInAction === 2, J(P.cont));
  ok("P3 same weapon past ROF opens a new action and the round tally reads 3", P.rofSpent.kind === "rofSpent" && P.rofSpent.newAction && P.rofSpent.firedInRound === 3, J(P.rofSpent));
  ok("P4 another weapon without Dual Wield opens a new action", P.other.kind === "new" && P.other.newAction, J(P.other));
  ok("P5 another weapon with Dual Wield joins (both weapons in the action)", P.join.kind === "join" && !P.join.newAction && P.join.shots.p === 1 && P.join.shots.q === 1, J(P.join));
  ok("P6 Dual Wield with no open action opens one", P.joinNoOpen.kind === "new" && P.joinNoOpen.newAction, J(P.joinNoOpen));
  ok("P7 a second full-auto roll is a new action", P.autoTwice.kind === "new" && P.autoTwice.newAction, J(P.autoTwice));
  ok("P8 a stale round's state never continues", P.stale.kind === "new" && P.stale.newAction && P.stale.shots.p === 1, J(P.stale));
  ok("P9 a second melee swing is a new action (never continues)", P.melee.kind === "new" && P.melee.newAction, J(P.melee));
  ok("P10 a second card of the same trigger pull is the same action", P.samePull.kind === "sameTrigger" && !P.samePull.newAction, J(P.samePull));
  ok("P11 an unknown ROF never continues (falls back to one action per roll)", P.noRof.kind === "new" && P.noRof.newAction, J(P.noRof));
}
const E = r.e;
ok("E0 fixtures + started combat with the shooter as combatant", E.fixtures?.created === 4 && E.combat?.started && E.combat?.isMine && E.combat?.combatant && E.fixtures?.knifeRanged === false, J({ f: E.fixtures, c: E.combat, err: E.error }));
const e1 = E.e1 ?? {};
ok("E1a shot 1: nothing seeded, no note; counter 1 after", e1.s1?.pre?.extraMod === "" && e1.s1?.pre?.note === null && e1.s1?.fired?.after?.count === 1, J(e1.s1));
ok("E1b shot 2 continues: nothing seeded, note reads shot 2 of 2; counter still 1", e1.s2?.pre?.kind === "continue" && Number(e1.s2?.pre?.extraMod || 0) === 0 && /shot 2 of 2/i.test(e1.s2?.pre?.note ?? "") && e1.s2?.fired?.after?.count === 1 && e1.s2?.fired?.after?.attack?.shots && Object.values(e1.s2.fired.after.attack.shots)[0] === 2, J(e1.s2));
ok("E1c shot 3 past the ROF: -3 seeded, note names the ROF; counter 2 after", e1.s3?.pre?.kind === "rofSpent" && e1.s3?.pre?.extraMod === "-3" && /ROF/.test(e1.s3?.pre?.note ?? "") && e1.s3?.fired?.after?.count === 2, J(e1.s3));
const e2 = E.e2 ?? {};
ok("E2 shoot / melee / shoot seeds 0 / -3 / -6 and the counter ends at 3", e2.shot1?.pre?.extraMod === "" && e2.knife?.pre?.extraMod === "-3" && /action 2/.test(e2.knife?.pre?.note ?? "") && e2.shot2?.pre?.extraMod === "-6" && /action 3/.test(e2.shot2?.pre?.note ?? "") && e2.shot2?.fired?.after?.count === 3, J(e2));
const e3 = E.e3 ?? {};
ok("E3 a declared dodge closes the attack action: the next shot is action 3 at -6", e3.dodge?.clicked && e3.dodge?.dodging && e3.dodge?.flags?.count === 2 && e3.shot2?.pre?.extraMod === "-6" && e3.shot2?.pre?.kind === "new" && e3.shot2?.fired?.after?.count === 3, J(e3));
const e4 = E.e4 ?? {};
ok("E4a second weapon without Dual Wield reads as action 2 at -3", e4.bBefore?.extraMod === "-3" && e4.bBefore?.kind === "new", J(e4.bBefore));
ok("E4b ticking Dual Wield re-evaluates live: joins the action, seed removed, note says Dual Wield", e4.bTicked?.kind === "join" && Number(e4.bTicked?.extraMod || 0) === 0 && /Dual Wield/i.test(e4.bTicked?.note ?? ""), J(e4.bTicked));
ok("E4c unticking restores the -3; re-ticking and firing keeps the counter at 1 with both weapons in the action", e4.bUnticked?.extraMod === "-3" && e4.bFired?.after?.count === 1 && Object.keys(e4.bFired?.after?.attack?.shots ?? {}).length === 2, J({ un: e4.bUnticked, fired: e4.bFired }));
const e5 = E.e5 ?? {};
ok("E5a two full-auto rolls are two actions (second seeds -3)", e5.burst1?.pre?.extraMod === "" && e5.burst2?.pre?.extraMod === "-3" && e5.burst2?.fired?.after?.count === 2, J({ b1: e5.burst1?.pre, b2: e5.burst2?.pre, after: e5.burst2?.fired?.after }));
ok("E5b the fire payload carries a per-pull id, the method name and the Dual Wield state", e5.payloads?.length >= 2 && e5.payloads.every(x => typeof x.fireId === "string" && x.fireId.length > 0 && x.fireMethod === "__fullAuto" && x.dualWield === false) && e5.payloads[0].fireId !== e5.payloads[1].fireId, J(e5.payloads));
const e6 = E.e6 ?? {};
ok("E6 switch off: nothing seeded and no note on shots 2 and 3, the counter still reads 2", e6.shot2?.pre?.extraMod === "" && e6.shot2?.pre?.note === null && e6.shot3?.pre?.extraMod === "" && e6.shot3?.pre?.note === null && e6.shot3?.fired?.after?.count === 2, J(e6));
const e7 = E.e7 ?? {};
ok("E7 round advance clears the count and the attack state; a fresh dialog has no note", e7.start?.flags?.count === null && e7.start?.flags?.attack === null && e7.fresh?.note === null && e7.fresh?.extraMod === "", J(e7));
ok("0 console errors", errors.length === 0, J(errors.slice(0, 3)));

let fail = 0;
for (const [n, pass, got] of legs) { if (!pass) fail++; console.log(`${pass ? "PASS" : "FAIL"}  ${n}${pass ? "" : `   [got: ${got}]`}`); }
console.log(`\n${legs.length - fail}/${legs.length} checks passed`);
await b.close();
process.exit(fail ? 1 : 0);
