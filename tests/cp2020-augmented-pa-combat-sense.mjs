/** PA Combat Sense family (MM p.52–53, Seb's feedback 2026-07-11). Three units:
 *  (2A) outside-suit ½ PA-Combat-Sense INITIATIVE on the pilot character (init-roll override, init-only);
 *  (3)  in-suit full PACS AWARENESS bonus on the pilot while piloting an ACPA;
 *  (2B) PA Pilot skill raises the in-suit MANEUVER (Martial-Arts) cap but grants NO initiative.
 *  Runs on :30004 (1.1.1 + module). PA skills created inline with keepId (the compendium _ids). */
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
  const out = {};
  const PA = await import("/modules/cp2020-augmented/module/mech/pa-combat-sense.js");
  const UTILS = await import("/modules/cp2020-augmented/module/utils.js");
  const SCOPE = "cp2020-augmented";
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const awName = game.i18n.localize("CYBERPUNK.SkillAwarenessNotice");
  const paCS = (lvl) => ({ _id: "PACombatSense001", name: "PA Combat Sense", type: "skill", system: { level: lvl, stat: "ref" } });
  const paPilot = (lvl) => ({ _id: "PAPilotSkill0001", name: "PA Pilot", type: "skill", system: { level: lvl, stat: "ref" } });
  const awareness = () => ({ name: awName, type: "skill", system: { level: 4, stat: "int" } });
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__PA"))) await a.delete().catch(() => {});

  try {
    // ── utils: isPAPilotSkill vs isPACombatSenseSkill ─────────────────────────
    out.ident = {
      pilotIsPilot: UTILS.isPAPilotSkill({ type: "skill", _id: "PAPilotSkill0001" }),        // true
      pilotNotCS: UTILS.isPACombatSenseSkill({ type: "skill", _id: "PAPilotSkill0001" }),     // false
      csIsCS: UTILS.isPACombatSenseSkill({ type: "skill", _id: "PACombatSense001" }),         // true
      csNotPilot: UTILS.isPAPilotSkill({ type: "skill", _id: "PACombatSense001" }),           // false
    };

    // ── (2A) paInitBonus = floor(PACS/2), pilot actors only ───────────────────
    const trooper = await Actor.create({ name: "__PW__PATrooper", type: "character" });
    await trooper.createEmbeddedDocuments("Item", [paCS(6)], { keepId: true });
    out.initBonus6 = PA.paInitBonus(trooper);                              // 3
    await trooper.items.get("PACombatSense001").update({ "system.level": 5 });
    out.initBonus5 = PA.paInitBonus(trooper);                              // 2 (floor)
    out.initBonusVehicle = PA.paInitBonus({ type: `${SCOPE}.vehicle`, itemTypes: { skill: [] } });  // 0

    // (2A gesture) the character's OWN initiative roll carries the +bonus (init-only override)
    await trooper.items.get("PACombatSense001").update({ "system.level": 6 });   // back to bonus 3
    let initFormulaHasBonus = false;
    try {
      const combat = await Combat.create({});
      await combat.createEmbeddedDocuments("Combatant", [{ actorId: trooper.id }]);
      const combatant = combat.combatants.find(c => c.actorId === trooper.id);
      const roll = combatant?.getInitiativeRoll?.();
      initFormulaHasBonus = !!roll && /(\+\s*3\b)/.test(roll.formula);
      await combat.delete().catch(() => {});
    } catch (e) { out.initGestureErr = String(e?.message || e); }
    out.initGestureBonus = initFormulaHasBonus;                            // true

    // ── (3) paAwarenessBonus: full PACS on Awareness while piloting an ACPA ────
    await trooper.createEmbeddedDocuments("Item", [awareness()]);
    const awSkill = trooper.items.find(i => i.name === awName);
    out.awNotPiloting = PA.paAwarenessBonus(trooper, awSkill);            // 0 (not piloting yet)
    out.pilotingBefore = PA.isPilotingAcpa(trooper);                     // false

    const suit = await Actor.create({ name: "__PW__PASuit", type: `${SCOPE}.vehicle`, system: { isACPA: true, pilotId: trooper.id } });
    await sleep(50);
    out.pilotingAfter = PA.isPilotingAcpa(trooper);                      // true
    out.awPiloting = PA.paAwarenessBonus(trooper, awSkill);              // 6 (full PACS, in suit)
    // a non-Awareness skill gets nothing even while piloting
    const refSkill = trooper.items.get("PACombatSense001");
    out.awOtherSkill = PA.paAwarenessBonus(trooper, refSkill);          // 0
    // (L17 fix) while piloting, the pilot's OWN init bonus is suppressed (the suit rolls full PACS)
    out.initWhilePiloting = PA.paInitBonus(trooper);                    // 0
    // (L16 fix) in-suit Awareness nets out the Solo Combat Sense the base rollSkill adds → ends at + PACS
    await trooper.update({ "system.CombatSenseMod": 4 });               // pretend a Solo Combat Sense 4
    out.awNetOut = PA.paAwarenessBonus(trooper, awSkill);              // 6 − 4 = 2 (base adds 4 → net +6)
    await trooper.update({ "system.CombatSenseMod": 0 });

    // ── (2B) PA Pilot raises the maneuver cap (pilotPAManeuver) but NOT init ───
    // suit currently links the trooper (PACS 6, no PA Pilot): maneuver == PACS, init uses PACS.
    suit.prepareData();
    out.suitPacsOnly = { pacs: suit.system.pilotPACS, maneuver: suit.system.pilotPAManeuver }; // {6,6}

    // give the trooper PA Pilot 8 as well → maneuver becomes max(6,8)=8, init (pilotPACS) stays 6
    await trooper.createEmbeddedDocuments("Item", [paPilot(8)], { keepId: true });
    suit.prepareData();
    await sleep(30);
    out.suitBoth = { pacs: suit.system.pilotPACS, maneuver: suit.system.pilotPAManeuver };     // {6,8}

    // a NON-Trooper pilot: only PA Pilot 8, no PA Combat Sense → maneuver 8, init 0
    const civ = await Actor.create({ name: "__PW__PACiv", type: "character" });
    await civ.createEmbeddedDocuments("Item", [paPilot(8)], { keepId: true });
    const suit2 = await Actor.create({ name: "__PW__PASuit2", type: `${SCOPE}.vehicle`, system: { isACPA: true, pilotId: civ.id } });
    await sleep(50);
    suit2.prepareData();
    out.suitPilotOnly = { pacs: suit2.system.pilotPACS, maneuver: suit2.system.pilotPAManeuver }; // {0,8}
    out.civInit = PA.paInitBonus(civ);                                    // 0 — PA Pilot grants no init

    for (const a of [trooper, suit, civ, suit2]) await a.delete().catch(() => {});
  } catch (e) {
    out.THROWN = String(e?.stack || e);
  }
  return out;
});

const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
const ok = (name, cond, got) => checks.push({ name, ok: !!cond, got });
if (r.THROWN) checks.push({ name: "no throw", ok: false, got: r.THROWN });

eq("identity helpers by _id", [r.ident?.pilotIsPilot, r.ident?.pilotNotCS, r.ident?.csIsCS, r.ident?.csNotPilot], [true, false, true, false]);
// (2A)
eq("paInitBonus floor(PACS/2): 6→3, 5→2", [r.initBonus6, r.initBonus5], [3, 2]);
ok("suit actor gets no pilot init bonus", r.initBonusVehicle === 0, r.initBonusVehicle);
ok("init roll formula carries +3 (override)", r.initGestureBonus, { g: r.initGestureBonus, err: r.initGestureErr });
// (3)
ok("no awareness bonus when not piloting", r.awNotPiloting === 0, r.awNotPiloting);
ok("isPilotingAcpa false before link", r.pilotingBefore === false, r.pilotingBefore);
ok("isPilotingAcpa true after link", r.pilotingAfter === true, r.pilotingAfter);
ok("full PACS (6) on Awareness while piloting", r.awPiloting === 6, r.awPiloting);
ok("no bonus on a non-Awareness skill", r.awOtherSkill === 0, r.awOtherSkill);
ok("in-suit: pilot's own init bonus suppressed (L17)", r.initWhilePiloting === 0, r.initWhilePiloting);
ok("in-suit Awareness nets out Solo Combat Sense (L16)", r.awNetOut === 2, r.awNetOut);
// (2B)
eq("PACS-only pilot: maneuver==init==6", [r.suitPacsOnly?.pacs, r.suitPacsOnly?.maneuver], [6, 6]);
eq("PACS6+Pilot8: init 6, maneuver max=8", [r.suitBoth?.pacs, r.suitBoth?.maneuver], [6, 8]);
eq("PA-Pilot-only pilot: init 0, maneuver 8", [r.suitPilotOnly?.pacs, r.suitPilotOnly?.maneuver], [0, 8]);
ok("PA Pilot grants NO character init", r.civInit === 0, r.civInit);

ok("0 console errors", errors.length === 0, errors.slice(0, 6));

const pass = checks.filter(c => c.ok).length, fail = checks.length - pass;
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "  got=" + JSON.stringify(c.got) + (c.want !== undefined ? " want=" + JSON.stringify(c.want) : "")}`);
console.log(`\nRESULT: ${fail === 0 ? "ALL GREEN" : "FAIL"}  ${pass}/${checks.length}`);
if (errors.length) console.log("ERRORS:\n" + errors.slice(0, 8).join("\n"));
await b.close();
process.exit(fail === 0 ? 0 : 1);
